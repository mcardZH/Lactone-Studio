import { atomicNumber, elementSymbol } from '../core/elements';
import {gaussianMethodEnergyKind,gaussianRouteTokens,normalizeGaussianRouteEcho} from '../core/gaussian-source';
import { GaussianOutputArchive,GaussianOutputTitle } from './gaussian-output-archive';
import { ScientificSnapshotState } from './scientific-snapshot';
import {
  emptyScientificData, emptyScientificDiagnostics, createNmrCouplingBlock,SCIENTIFIC_NUMBER, scientificNumber,
  type AtomicProperty, type ExcitedState, type IndexedScientificFrame, type OrbitalChannel,
  type ScientificData, type ScientificField, type ScientificGeometry, type ScientificJob,
   type ScientificLine, type ScientificParser, type ScientificParserSnapshot, type ScientificTask, type VibrationMode, type FrequencyElectronicTarget, type ScientificCenter,type NmrCouplingNucleus,type ScientificDiagnostics,
} from './scientific-contracts';

const N = SCIENTIFIC_NUMBER;
const separator = /^\s*-{3,}\s*$/;

/** Source-wide counters validate exact identities without an arbitrary total
 * record budget. Ordinary frames and special centers retain their ownership. */
export class GaussianStorageBudget {
  private indices=0;
  private centers=0;
  private scientificObservations=0;
  private metadataEntries=0;
  private metadataCharacters=0;
  private reserve(current:number,amount:number):number {
    if(!Number.isSafeInteger(amount)||amount<1)throw new Error('Gaussian存储预算预留量必须为正安全整数。');
    const next=current+amount;if(!Number.isSafeInteger(next))throw new Error('Gaussian存储计数无法精确表示。');
    return next;
  }
  reserveIndices(amount=1):void {
    this.indices=this.reserve(this.indices,amount);
  }
  reserveCenters(amount:number):void {
    this.centers=this.reserve(this.centers,amount);
  }
  reserveObservations(amount:number):boolean {
    if(!Number.isSafeInteger(amount)||amount<0)throw new Error('Gaussian科学观测预算预留量无效。');
    if(!Number.isSafeInteger(this.scientificObservations+amount))throw new Error('Gaussian科学观测计数无法精确表示。');
    this.scientificObservations+=amount;return true;
  }
  releaseObservations(amount:number):void {
    if(!Number.isSafeInteger(amount)||amount<0||amount>this.scientificObservations)throw new Error('Gaussian科学观测预算回收量无效。');
    this.scientificObservations-=amount;
  }
  reserveMetadata(characters:number,entries=1):boolean {
    if(!Number.isSafeInteger(characters)||characters<0||!Number.isSafeInteger(entries)||entries<1)throw new Error('Gaussian诊断metadata预算预留量无效。');
    if(!Number.isSafeInteger(this.metadataEntries+entries)||!Number.isSafeInteger(this.metadataCharacters+characters))throw new Error('Gaussian元数据计数无法精确表示。');
    this.metadataEntries+=entries;this.metadataCharacters+=characters;return true;
  }
}
const numbers = (text: string): number[] | null => {
  const tokens = text.trim().split(/\s+/).filter(Boolean), values = tokens.map(scientificNumber);
  return values.some(value => value === null) ? null : values as number[];
};
/** Fixed-width eigenvalues may touch at a sign. Consume the entire list with
 * the shared finite-number grammar; never search past malformed residual text. */
const orbitalNumbers=(text:string):number[]|null=>{
  const values:number[]=[],pattern=new RegExp(`(\\s*)(${N})`,'y');let end=0;
  while(end<text.length){
    pattern.lastIndex=end;const match=pattern.exec(text);
    if(!match)return values.length&&/^\s*$/.test(text.slice(end))?values:null;
    if(values.length&&!match[1]&&!/^[+-]/.test(match[2]))return null;
    const value=scientificNumber(match[2]);if(value===null)return null;
    values.push(value);end=pattern.lastIndex;
  }
  return values.length?values:null;
};
type Target = 'scf' | 'semiempirical' | 'mp2' | 'ccsd' | 'ccsd(t)' | 'qcisd' | 'td' | 'unknown';
function energyTarget(route: string): Target {
  if (/\b(?:oniom|external|eom|casscf|caspt2|cisd|mp[345]|b2plyp|dsd-)\b/i.test(route)) return 'unknown';
  if (/\b(?:td|tda)(?:\s|\(|=|\/|$)/i.test(route)) return 'td';
  for(const token of gaussianRouteTokens(route)){
    const method=token.includes('/')?token.slice(0,token.indexOf('/')):token;
    const kind=gaussianMethodEnergyKind(method);if(kind)return kind;
  }
  return 'unknown';
}
export function gaussianScientificTasks(route: string, inferSinglePoint = true): ScientificTask[] {
  const tasks: ScientificTask[] = [];
  // Reuse the input reader's balanced/quoted lexer: option values are not
  // top-level tasks, and a method such as SCAN/basis is not the Scan keyword.
  const tokens=gaussianRouteTokens(route),keyword=(token:string)=>token.match(/^([a-z][\w-]*)(?=$|[=(])/i)?.[1].toLowerCase()??'';
  const keys=new Set(tokens.map(keyword)),opt=tokens.filter(token=>keyword(token)==='opt');
  const optOptions=new Set(opt.flatMap(token=>gaussianRouteTokens(token.slice(3).replace(/^=/,'').replace(/^\((.*)\)$/s,'$1').replace(/,/g,' '))).map(option=>option.toLowerCase()));
  if (opt.length) tasks.push('opt');
  if (['ts','qst2','qst3'].some(option=>optOptions.has(option))) tasks.push('ts');
  for (const [task, names] of [
    ['freq', ['freq']], ['irc', ['irc']], ['scan', ['scan']], ['td', ['td','tda','cis']],
    ['nmr', ['nmr']], ['stability', ['stable']], ['bsse', ['counterpoise']],
  ] as const) if (names.some(name=>keys.has(name))||task==='scan'&&optOptions.has('scan')) tasks.push(task);
  if (!tasks.length && inferSinglePoint) tasks.push(route.trim() && energyTarget(route) !== 'unknown' ? 'sp' : 'unknown');
  return tasks;
}

interface GeometryBlock {
  stage: number; header: string; orientation: string; start: number; end: number; line: number;
  elements: string[]; invalid: boolean;
  positions: number[];
  centers: ScientificCenter[];
  unsupportedCenters?:boolean;
}
interface AtomTable { kind: 'charge' | 'spin'; scheme: string; sourceLine: number; frameIndex: number | null; values: AtomicProperty['values']; spins: AtomicProperty['values']; rows: boolean; skipped: number; cp?:boolean }
interface ModeBlock { modes: VibrationMode[]; frameIndex: number | null; rows: [number, number, number][][]; readingRows: boolean; invalid: boolean; age: number }
interface NmrCouplingTable {
  heading:string; quantity:'J'|'K'; rawUnit:string; line:ScientificLine; frameIndex:number|null;
  columns:{label:string;index:number;sourceLine:number}[]; seenColumns:Set<number>; lastRow:number;
  expectedAtoms:number|null; printed:number;retained:number;lastLine:number;invalid:boolean;blocked:boolean;mappingPartial:boolean;
}
interface GaussianRunVersion {value:string;signature:string;sourceLine:number}
interface CounterpoiseComponent {ordinal:number;role:'full-system'|'fragment-full-basis'|'fragment-own-basis'|'unknown';fragment:number|null;label:string;sourceLine:number}
/** Consume complete native scientific tokens, including sign-adjacent fields;
 * never harvest a finite prefix from a damaged coupling token. */
function nmrCouplingTokens(text:string):string[]|null {
  const result:string[]=[],pattern=/(\s*)([+-]?(?:\d+\.\d*|\.\d+)[dDeE][+-]\d{2,3})/y;let end=0;
  while(end<text.length){pattern.lastIndex=end;const match=pattern.exec(text);if(!match)return /^\s*$/.test(text.slice(end))?result:null;
    if(result.length&&!match[1]&&!/^[+-]/.test(match[2])||scientificNumber(match[2])===null)return null;
    result.push(match[2]);end=pattern.lastIndex;}
  return result.length?result:null;
}

/** Gaussian text grammar only. Coordinates live in the input file, never in the index. */
export class GaussianScientificParser implements ScientificParser {
  constructor(private readonly storage=new GaussianStorageBudget(), snapshots = false){ if (snapshots) this.snapshotState = new ScientificSnapshotState(); }
  private jobs: ScientificJob[] = [];
  private jobIndex = 0;
  private segmentIndex = 0;
  private data: ScientificData = emptyScientificData();
  private frames: IndexedScientificFrame[] = [];
  private current: IndexedScientificFrame | null = null;
  private charge: number | null = null;
  private multiplicity: number | null = null;
  private expectedAtoms: number | null = null;
  private inventory: string[] | null = null;
  // Retain only the most recent block of each orientation to prove an exact
  // same-calculation final reprint. Historical coordinates remain on disk.
  private lastOrientations = new Map<string, { index: number; positions: number[]; epoch: number }>();
  /** A final reprint is provisional until subsequent source lines establish
   * whether another scientific evaluation follows that geometry. */
  private pendingFinalReprint: { previousIndex: number; candidateIndex: number; line: number; orientation: string } | null = null;
  private calculationEpoch = 0;
  private block: GeometryBlock | null = null;
  private orientation = '';
  private routeCapture = false;
  private outputArchive = new GaussianOutputArchive();
  private outputTitle = new GaussianOutputTitle<ScientificLine>();
  private terminated = false;
  private failed = false;
  private pendingNativeTermination: { sourceLine:number; text:string } | null = null;
  private damaged = false;
  private unsupportedGeometry=false;
  private optimized = false;
  private frameObserved = false;
  private target: Target = 'unknown';
  private scfChannel: 'restricted' | 'unrestricted' | 'restricted-open' | 'unknown' = 'unknown';
  private targetSource: { sourceLine: number; frameIndex: number;rawValue?:string } | null = null;
  private routeSourceLine = 0;
  private selectedFrequencyState: { state: ExcitedState; sourceLine: number } | null = null;
  private optimizationGeometrySourceLine: number | null = null;
  private messages = new Set<string>();
  private step: number | null = null;
  private node: number | null = null;
  private direction: 'forward' | 'reverse' | 'ts' | undefined;
  private coordinate: IndexedScientificFrame['coordinate'];
  private inputCartesian: { start: number; end: number; line: number; elements: string[] } | null = null;
  private expectingInputCartesian = false;
  private capturingInputCartesian = false;
  private tsReferenceEnergy: { value: number; line: number;rawValue:string } | null = null;
  private ircCoordinateUnit: string | undefined;
  private ordinaryIrc = false;
  private ircPathLimited = false;
  private ircBranch: { nativePath: number | null; frames: number[]; direction?: 'forward' | 'reverse'; limit?: ScientificDiagnostics['tasks'][number] } | null = null;
  private ircSummary: 'header' | 'rows' | null = null;
  private snapshotIrcSummaryLine: number | null = null;
  private ircSummaryReference: NonNullable<ScientificData['pathSummary']>[number]['referenceEnergy'];
  private orbitalSet: { alpha?: OrbitalChannel; beta?: OrbitalChannel } | null = null;
  private orbitalSetLimited = false;
  private atomTable: AtomTable | null = null;
  private shielding: AtomicProperty | null = null;
  private shieldingHeader:{label:string;sourceLine:number;unit:'ppm'}|null=null;
  private shieldingTensor:{atomIndex:number;element:string;frameIndex:number;sourceLine:number;components:Set<string>}|null=null;
  private frozenUnitsLine:number|null=null;
  private solventTableLine:number|null=null;
  private pcmInput=false;
  private cpComponent:CounterpoiseComponent|null=null;
  private cpOrdinal=0;
  private cpFinished=false;
  private cpCandidateFrame:number|null=null;
  private cpFullFrame:number|null=null;
  private cpInputEcho=false;
  private cpInputOrdinal=0;
  private cpInputAtoms=new Map<number,{element:string;fragment:number|null;sourceLine:number}>();
  private cpStates=new Map<number,{charge:number;multiplicity:number;rawCharge:string;rawMultiplicity:string;sourceLine:number}>();
  private cpOrbitalTokens=new Map<OrbitalChannel,string[]>();
  private coupling:NmrCouplingTable|null=null;
  private couplingPartial=false;
  private isotopeSection=false;
  private isotopeColumns:number[]=[];
  private isotopes=new Map<number,{rawLabel:string;massNumber:number;sourceLine:number}>();
  private invalidIsotopes=new Set<number>();
  private modeBlock: ModeBlock | null = null;
  private printedModeIndices: number[] | null = null;
  private excited: ExcitedState | null = null;
  private excitedSuppressed = false;
  private cycle: ScientificData['scfCycles'][number] | null = null;
  private cycleIteration: number | null = null;
  /** A printed SCF energy does not erase failure of the same attempt. */
  private scfAttemptFailed = false;
  private segmentObserved = 0;
  private segmentRetained = 0;
  private segmentOmitted = 0;
  private segmentMetadataObserved=0;
  private segmentMetadataRetained=0;
  private segmentMetadataOmitted=0;
  private firstOmittedMetadataLine=0;
  private lastOmittedMetadataLine=0;
  private firstOmittedLine = 0;
  private lastOmittedLine = 0;
  private lastLine = 0;
  private vectorValues = 0;
  private frequencyScale: number | undefined;
  private newFrequencyAnalysis = true;
  private thermalTable = false;
  private dipoleNext = false;
  private finished = false;
  private seenIdentity=false;
  private runVersion:GaussianRunVersion|null=null;
  private runVersionConflict:{first:GaussianRunVersion;second:GaussianRunVersion}|null=null;
  private snapshotState: ScientificSnapshotState | null = null;
  private snapshotGeometryLine: number | null = null;

  private diagnostics(){return this.data.diagnostics??=emptyScientificDiagnostics();}
  private completeTask(task:ScientificDiagnostics['tasks'][number]['task'],stageId:string,line:ScientificLine):void {
    if(this.diagnostics().tasks.some(row=>row.task===task&&row.stageId===stageId&&row.status==='completed'))return;
    const raw=line.text.trim();if(this.metadata(raw.length,line.number))this.diagnostics().tasks.push({task,stageId,status:'completed',sourceLine:line.number,frameIndex:this.current?.index??null,raw});
  }
  private applyRunVersion():void {
    if(this.runVersionConflict){
      this.data.version=null;const {first,second}=this.runVersionConflict;
      const message=`同一运行版本回显冲突：源行${first.sourceLine} ${first.value}；源行${second.sourceLine} ${second.value}。未选择或跨内部作业继承其中一项。`;
      if(this.metadata(message.length,second.sourceLine))this.diagnostics().fields.push({field:'version',status:'conflict',sourceLine:second.sourceLine,message});return;
    }
    const source=this.runVersion;if(!source)return;
    this.data.version=source.value;
    const previous=this.data.summary.find(field=>field.key==='program-version');
    if(previous?.sourceLine===source.sourceLine&&previous.value===source.value)return;
    if(this.metadata(source.value.length,source.sourceLine)){
      const field:ScientificField={key:'program-version',label:'同次Gaussian运行的原生版本',value:source.value,origin:'program-adopted',sourceLine:source.sourceLine,frameIndex:null};
      if(previous)Object.assign(previous,field);else this.data.summary.push(field);
    }
  }
  private readRunVersion(line:ScientificLine):void {
    const match=line.text.match(/^\s*Gaussian\s+(\d{2,4})\b/i);if(!match)return;
    const raw=line.text.trim(),revision=line.text.match(/\bRevision\s+([A-Za-z]\.[\w.]+)/i)?.[1]??line.text.match(/\bG\d+Rev([A-Za-z]\.[\w.]+)/i)?.[1];
    if(!revision){if(!this.data.version&&!this.runVersionConflict)this.data.version=raw;return;}
    const candidate:GaussianRunVersion={value:raw,signature:`${match[1]}:${revision.toLowerCase()}`,sourceLine:line.number};
    if(this.runVersion&&this.runVersion.signature!==candidate.signature){this.runVersionConflict={first:this.runVersion,second:candidate};this.applyRunVersion();return;}
    if(!this.runVersionConflict&&(!this.runVersion||/^\s*Gaussian\s+\d{2,4}\s*:/i.test(line.text)))this.runVersion=candidate;
    this.applyRunVersion();
  }
  private error(category:string,line:ScientificLine,severity:'warning'|'error'='error'):void{
    const errors=this.diagnostics().errors;
    errors.push({category,severity,sourceLine:line.number,raw:line.text.trim(),start:line.start,end:line.end});
  }
  private scfDiagnostic(status:'converged'|'not-converged',line:ScientificLine):void{
    const raw=line.text.trim();
    if(this.metadata(raw.length,line.number))this.diagnostics().scf.push({status,frameIndex:this.current?.index??null,sourceLine:line.number,raw});
    // The basic-info field and diagnostic event consume the same native state.
    // A later SCF failure remains a later observation of this attempt, while
    // the printed energy and cycle count keep their original source records.
    const field=this.field(this.data.summary,'scf-status','SCF convergence (printed)',status,line.number);
    if(field){field.origin='observation';field.rawLabel=raw;}
  }
  private bindIrcBranch(direction:'forward'|'reverse',line:ScientificLine):void {
    this.direction=direction;
    const branch=this.ircBranch;if(!branch)return;
    branch.direction=direction;
    for(const index of branch.frames){
      const frame=this.frames[index];if(!frame)continue;
      this.snapshotState?.cache.invalidateSpine(frame);
      frame.pathDirection=direction;
      if(frame.coordinate){const sourceValue=frame.coordinate.sourceValue??frame.coordinate.value;
        frame.coordinate={...frame.coordinate,sourceValue,value:direction==='reverse'?-Math.abs(sourceValue):sourceValue};}
    }
    if(branch.limit){this.snapshotState?.cache.invalidateSpine(branch.limit);branch.limit.stageId='irc-'+direction;}
    const field=this.field(this.data.summary,'irc-branch-direction','IRC原生分支方向',line.text.trim(),line.number);
    if(field)field.frameIndex=null;
  }
  private metadata(characters:number,sourceLine:number):boolean {
    this.segmentMetadataObserved++;
    if(this.storage.reserveMetadata(characters)){this.segmentMetadataRetained++;return true;}
    this.segmentMetadataOmitted++;
    this.firstOmittedMetadataLine=this.firstOmittedMetadataLine?Math.min(this.firstOmittedMetadataLine,sourceLine):sourceLine;
    this.lastOmittedMetadataLine=Math.max(this.lastOmittedMetadataLine,sourceLine);return false;
  }

  private frequencyTarget(): FrequencyElectronicTarget {
    const route=this.data.route,selected=this.selectedFrequencyState?.state.frameIndex===this.current?.index?this.selectedFrequencyState:null;
    const method:FrequencyElectronicTarget['method']=/\btda\b|\btd\s*(?:=\s*)?\([^)]*\btda\b/i.test(route)?'tda':this.target==='td'?'td':this.target==='scf'?this.scfChannel==='unrestricted'&&!/\buhf\b/i.test(route)?'udft':'scf':'unknown';
    const td=method==='td'||method==='tda',requested=route.match(/\broot\s*=\s*(\d+)/i),root=td?(selected?.state.index??(requested&&Number(requested[1])>0?Number(requested[1]):null)):null;
    const names:Record<string,number>={singlet:1,doublet:2,triplet:3,quartet:4,quintet:5,sextet:6};
    const printedMultiplicity=selected?.state.multiplicity?.toLowerCase(),routeMultiplicity=route.match(/\b(singlets|triplets)\b/i)?.[1].toLowerCase();
    const multiplicity=td?(printedMultiplicity?names[printedMultiplicity]??null:routeMultiplicity==='singlets'?1:routeMultiplicity==='triplets'?3:null):this.multiplicity;
    const evidence:FrequencyElectronicTarget['evidence'][number][]=[];
    if(this.routeSourceLine)evidence.push({sourceLine:this.routeSourceLine,kind:'input-echo',field:'method',value:route});
    if(selected)evidence.push({sourceLine:selected.sourceLine,kind:'printed',field:'root',value:String(selected.state.index)});
    else if(requested&&root!==null)evidence.push({sourceLine:this.routeSourceLine,kind:'input-echo',field:'root',value:String(root)});
    if(selected?.state.multiplicity)evidence.push({sourceLine:selected.state.sourceLine,kind:'printed',field:'multiplicity',value:selected.state.multiplicity});
    const source=this.targetSource,energy=this.current?.energy;
    return {method,state:td?'excited':method==='scf'?'ground':'unknown',root,multiplicity,reference:this.scfChannel,evaluationGeometrySourceLine:this.current?.geometry.line??null,optimizationGeometrySourceLine:this.optimizationGeometrySourceLine,
      energy:energy?.unit==='hartree'&&source&&source.frameIndex===this.current?.index?{value:energy.value,unit:'hartree',sourceLine:source.sourceLine}:null,evidence};
  }

  private omitted(amount: number, sourceLine: number): void {
    if (amount <= 0) return;
    this.segmentOmitted += amount;
    this.firstOmittedLine = this.firstOmittedLine ? Math.min(this.firstOmittedLine, sourceLine) : sourceLine;
    this.lastOmittedLine = Math.max(this.lastOmittedLine, sourceLine);
  }
  /** A source-wide storage budget, not a reason to stop indexing valid geometries. */
  private count(amount = 1, sourceLine = this.lastLine, allowed = true): boolean {
    this.segmentObserved += amount;
    if (!allowed || !this.storage.reserveObservations(amount)) { this.omitted(amount, sourceLine); return false; }
    this.segmentRetained += amount;
    return true;
  }
  private notice(message: string): void { if (!this.data.notices.includes(message)) this.data.notices.push(message); }
  private field(list: ScientificField[], key: string, label: string, value: number | string, sourceLine: number, unit?: string,rawValue?:string): ScientificField | null {
    if (!this.count(1, sourceLine)) return null;
    if(this.cpNonfull()&&list!==this.data.bsse){list=this.data.bsse;key=this.cpPrefix()+key;label=this.cpLabel()+' · '+label;}
    const field: ScientificField = { key, label, value, sourceLine, frameIndex: this.current?.index ?? null, ...(unit ? { unit } : {}),...(rawValue===undefined?{}:{rawValue}) };
    list.push(field); return field;
  }
  private cpRequested():boolean{return this.data.tasks.includes('bsse');}
  private cpNonfull():boolean{return this.cpRequested()&&!this.cpFinished&&this.cpComponent?.role!=='full-system';}
  private cpPrefix():string{return `cp-component-${this.cpComponent?.ordinal??'unknown'}-`;}
  private cpLabel():string{return `CP component ${this.cpComponent?.ordinal??'unknown'} (${this.cpComponent?.label??'role not proven'})`;}
  private cpMeta(key:string,label:string,value:string|number,sourceLine:number,origin:ScientificField['origin']='program-adopted',rawValue?:string):void {
    if(!this.metadata(String(value).length+(rawValue?.length??0),sourceLine))return;
    this.data.bsse.push({key:this.cpPrefix()+key,label:this.cpLabel()+' · '+label,value,sourceLine,origin,
      frameIndex:this.cpComponent?.role==='full-system'?this.current?.index??null:null,...(rawValue===undefined?{}:{rawValue})});
  }
  private readPrintedSettings(line:ScientificLine):void {
    const text=line.text;
    // Settings are bounded metadata, separate from the physical observation
    // budget. In particular a startup Link0 echo is not a new electronic state.
    const setting=(key:string,label:string,value:string|number,origin:ScientificField['origin'],rawValue?:string,unit?:string)=>{
      if(!this.metadata(String(value).length+label.length+(rawValue?.length??0),line.number))return;
      const component=this.cpComponent&&this.cpNonfull();
      (component?this.data.bsse:this.data.summary).push({key:component?this.cpPrefix()+key:key,label:component?this.cpLabel()+' · '+label:label,value,sourceLine:line.number,frameIndex:null,origin,...(rawValue===undefined?{}:{rawValue}),...(unit?{unit}:{})});
    };
    const memory=text.match(new RegExp(`^\\s*%mem\\s*=\\s*(${N})\\s*(GB|MB|GW|MW)\\s*$`,'i'));
    if(memory&&scientificNumber(memory[1])!==null&&scientificNumber(memory[1])!>0)setting('input-memory','输入请求内存（原打印单位）',scientificNumber(memory[1])!,'input-request',memory[1],memory[2].toUpperCase());
    const processors=text.match(/^\s*%nprocshared\s*=\s*(\d+)\s*$/i);
    if(processors&&Number.isSafeInteger(Number(processors[1]))&&Number(processors[1])>0)setting('input-shared-processors','输入请求共享内存处理器数',Number(processors[1]),'input-request',processors[1]);
    const adopted=text.match(/^\s*Will use up to\s+(\d+)\s+processors via shared memory\.\s*$/i);
    if(adopted&&Number.isSafeInteger(Number(adopted[1]))&&Number(adopted[1])>0)setting('adopted-shared-processors','程序声明的共享内存处理器上限（非实际使用量）',Number(adopted[1]),'program-adopted',adopted[1]);
    if(/^\s*Using the following non-standard input for PCM:\s*$/i.test(text))this.pcmInput=true;
    if(/^\s*--- end of non-standard input\.\s*$/i.test(text))this.pcmInput=false;
    if(this.pcmInput){
      const requested=text.match(new RegExp(`^\\s*eps(inf)?\\s*=\\s*(${N})\\s*$`,'i'));
      if(requested&&scientificNumber(requested[2])!==null)setting(requested[1]?'solvent-epsilon-infinity':'solvent-epsilon',requested[1]?'光学介电常数 (input echo)':'溶剂介电常数 (input echo)',scientificNumber(requested[2])!,'input-request',requested[2],'dimensionless');
    }
    // Retain the missing same-line optical value. For a native multi-line
    // Solvent table, retain the adopted source before public deduplication can
    // confuse identical preceding SCRF Read input values with adopted values.
    const optical=text.match(new RegExp(`^\\s*Solvent\\s*:.*?\\bEps\\(inf\\)\\s*=\\s*(${N})\\s*$`,'i'));
    if(optical&&scientificNumber(optical[1])!==null)setting('solvent-epsilon-infinity','光学介电常数 (printed)',scientificNumber(optical[1])!,'program-adopted',optical[1],'dimensionless');
    if(/^\s*Solvent\s*:/i.test(text)){this.solventTableLine=line.number;this.pcmInput=false;}
    if(!this.pcmInput&&this.solventTableLine!==null&&line.number-this.solventTableLine<=12){
      const epsilon=text.match(new RegExp(`^\\s*Eps(\\(infinity\\)|Inf)?\\s*=\\s*(${N})\\s*$`,'i'));
      if(epsilon&&scientificNumber(epsilon[2])!==null)setting(epsilon[1]?'solvent-epsilon-infinity':'solvent-epsilon',epsilon[1]?'光学介电常数 (printed)':'溶剂介电常数 (printed)',scientificNumber(epsilon[2])!,'program-adopted',epsilon[2],'dimensionless');
    }
    const cds=text.match(new RegExp(`^\\s*SMD-CDS\\s*\\(non-electrostatic\\)\\s+energy\\s+\\(kcal/mol\\)\\s*=\\s*(${N})\\s*$`,'i'));
    if(cds&&scientificNumber(cds[1])!==null){const field=this.field(this.data.properties,'smd-cds-energy-correction','SMD-CDS非静电能量修正（原文；不重复加到总能）',scientificNumber(cds[1])!,line.number,'kcal/mol',cds[1]);if(field)field.origin='observation';}
    if(/^\s*!\s*\(Angstroms and Degrees\)\s*!\s*$/i.test(text))this.frozenUnitsLine=line.number;
    else if(this.frozenUnitsLine!==null&&!/^\s*(?:!.*!|[-\s]+)\s*$/.test(text))this.frozenUnitsLine=null;
    const frozen=text.match(new RegExp(`^\\s*!\\s*([RAD]\\d+)\\s+([RAD]\\(\\d+(?:,\\d+){1,3}\\))\\s+(${N})\\s+(Frozen(?:,.*?)?)\\s*!\\s*$`,'i'));
    if(frozen&&scientificNumber(frozen[3])!==null){
      const kind=frozen[2][0].toUpperCase(),count=frozen[2].match(/\d+/g)?.length;
      if(count!==(kind==='R'?2:kind==='A'?3:4))return;
      if(!this.metadata(frozen[1].length+frozen[2].length+frozen[4].length,line.number))return;
      const unit=this.frozenUnitsLine===null?undefined:kind==='R'?'angstrom':'degree';
      const field=this.field(this.data.properties,`frozen-coordinate-${frozen[1]}`,`${frozen[1]} ${frozen[2]} ${frozen[4].trim()}（只读观察；未恢复可运行约束）`,scientificNumber(frozen[3])!,line.number,unit,frozen[3]);
      if(field)field.origin='observation';
      if(this.frozenUnitsLine!==null&&field&&!this.data.summary.some(entry=>entry.key==='frozen-coordinate-unit-source'&&entry.sourceLine===this.frozenUnitsLine)){
        const sourceLine=this.frozenUnitsLine;if(this.metadata(23,sourceLine))this.data.summary.push({key:'frozen-coordinate-unit-source',label:'Frozen内坐标单位原文表头',value:'(Angstroms and Degrees)',sourceLine,frameIndex:null,origin:'program-adopted'});
      }
    }
  }
  private finishCpComponent(endLine:number):void {
    if(this.cpComponent)this.cpMeta('source-end-line','组件原文结束行（区间标识）',endLine,this.cpComponent.sourceLine,'derived');
  }
  private readCounterpoise(line:ScientificLine):boolean {
    const text=line.text;
    const full=/^\s*Counterpoise:\s+doing full-system calculation\.\s*$/i.test(text);
    const fragment=text.match(/^\s*Counterpoise:\s+doing calculation for fragment\s+(\d+)\s+using the basis set of the (full-system|fragment)\b/i);
    if(full||fragment||/^\s*Counterpoise:\s*doing\b/i.test(text)){
      this.flushTables();this.finishCpComponent(line.number-1);this.task('bsse');this.cpFinished=false;
      const index=fragment?Number(fragment[1]):null,valid=index!==null&&Number.isSafeInteger(index)&&index>=1;
      const role=full?'full-system':fragment&&valid?fragment[2].toLowerCase()==='full-system'?'fragment-full-basis':'fragment-own-basis':'unknown';
      this.cpComponent={ordinal:++this.cpOrdinal,role,fragment:valid?index:null,label:full?'full-system':valid?`fragment ${index}, ${role}`:'unrecognized native component',sourceLine:line.number};
      if(full){if(!this.current&&this.cpCandidateFrame!==null)this.current=this.frames[this.cpCandidateFrame]??null;this.cpFullFrame=this.current?.index??null;this.cpCandidateFrame=null;}
      else this.current=null;
      this.scfChannel='unknown';this.cycle=null;this.cycleIteration=null;this.scfAttemptFailed=false;
      this.cpMeta('role','原生Counterpoise角色',text.trim(),line.number,'observation');
      this.cpMeta('role-kind','解析器按强原文确认的组件角色',role,line.number,'program-adopted');
      const state=this.cpStates.get(full?0:this.cpComponent.fragment??-1);
      if(state){this.cpMeta('charge-input-echo','输入回显电荷',state.charge,state.sourceLine,'input-request',state.rawCharge);this.cpMeta('multiplicity-input-echo','输入回显多重度',state.multiplicity,state.sourceLine,'input-request',state.rawMultiplicity);}
      else this.cpMeta('electronic-state-source','组件q/M来源','not printed / not confirmed',line.number);
      const indices=[...this.cpInputAtoms].filter(([,atom])=>full||atom.fragment===this.cpComponent?.fragment).map(([id])=>id);
      if(indices.length){this.cpMeta('real-source-indices-from-fragment-echo','由原Fragment回显关联的核号（非新打印组件几何）',indices.join(','),line.number,'derived');this.cpMeta('real-nuclei-from-fragment-echo','由原Fragment回显关联的真核计数（非NAtoms）',indices.length,line.number,'derived');}
      const basisIndices=role==='fragment-own-basis'?indices:[...this.cpInputAtoms.keys()];
      if(basisIndices.length)this.cpMeta('basis-source-indices-from-role','由原角色/输入回显关联的基组中心核号',basisIndices.join(','),line.number,'derived');
      this.cpMeta('native-ghost-mask','原生逐中心ghost标志','not printed; no adopted per-center ghost mask constructed',line.number);
      return true;
    }
    if(!this.cpRequested())return false;
    const state=text.match(/Charge\s*=\s*([+-]?\d+)\s+Multiplicity\s*=\s*(\d+)(?:\s+in\s+(supermolecule|fragment\s+(\d+)))?/i);
    if(state){
      const charge=Number(state[1]),multiplicity=Number(state[2]),index=state[3]?.toLowerCase().startsWith('fragment')?Number(state[4]):!state[3]&&this.cpNonfull()&&this.cpComponent?.fragment!==null?this.cpComponent?.fragment??0:0;
      if(Number.isSafeInteger(charge)&&Number.isSafeInteger(multiplicity)&&multiplicity>=1&&Number.isSafeInteger(index)&&index>=0){
        if(this.metadata(state[0].length,line.number))this.cpStates.set(index,{charge,multiplicity,rawCharge:state[1],rawMultiplicity:state[2],sourceLine:line.number});
        if(index===0&&!this.cpComponent){this.cpInputEcho=true;this.cpInputOrdinal=0;}
      }
      if(index>0){if(this.cpComponent?.fragment===index){this.cpMeta('charge-native','组件内原生电荷',charge,line.number,'program-adopted',state[1]);this.cpMeta('multiplicity-native','组件内原生多重度',multiplicity,line.number,'program-adopted',state[2]);}return true;}
      if(this.cpNonfull()&&this.cpComponent){this.cpMeta('charge-native','组件内原生电荷',charge,line.number,'program-adopted',state[1]);this.cpMeta('multiplicity-native','组件内原生多重度',multiplicity,line.number,'program-adopted',state[2]);return true;}
    }
    if(this.cpInputEcho){
      const atom=text.match(/^\s*([A-Za-z]{1,2}|\d+)(?:\(Fragment=(\d+)\))?\s+(?:(?:-1|0)\s+)?([+\-\d.eEdD]+)\s+([+\-\d.eEdD]+)\s+([+\-\d.eEdD]+)\s*$/);
      if(atom&&numbers(atom.slice(3).join(' '))){
        this.cpInputOrdinal++;
        let element:string|null=null;try{element=elementSymbol(atom[1]);}catch{/* An unsupported center is not made a real nucleus. */}
        const part=atom[2]===undefined?null:Number(atom[2]);
        if(element&&(part===null||Number.isSafeInteger(part)&&part>=1)&&this.metadata(atom[1].length+(atom[2]?.length??0),line.number))this.cpInputAtoms.set(this.cpInputOrdinal,{element,fragment:part,sourceLine:line.number});
        return true;
      }
      if(!state)this.cpInputEcho=false;
    }
    if(!this.cpComponent)return false;
    const basis=text.match(/^\s*(\d+) basis functions\b/i);
    if(basis){const field=this.field(this.data.bsse,this.cpPrefix()+'basis-functions',this.cpLabel()+' · native basis functions',Number(basis[1]),line.number,'functions',basis[1]);if(field)field.origin='program-adopted';return true;}
    const electrons=text.match(/^\s*(\d+) alpha electrons\s+(\d+) beta electrons\b/i);
    if(electrons){for(const [i,spin] of ['alpha','beta'].entries()){const field=this.field(this.data.bsse,this.cpPrefix()+spin+'-electrons',this.cpLabel()+' · native '+spin+' electrons',Number(electrons[i+1]),line.number,'electron',electrons[i+1]);if(field)field.origin='program-adopted';}return true;}
    const atomCounts=text.match(/\bNAtoms=\s*(\d+).*?\bNActive=\s*(\d+).*?\bNUniq=\s*(\d+)/);
    if(atomCounts){for(const [i,label] of ['NAtoms','NActive','NUniq'].entries()){const field=this.field(this.data.bsse,this.cpPrefix()+'native-'+label.toLowerCase(),this.cpLabel()+' · '+label+' (native center count, not asserted real nuclei)',Number(atomCounts[i+1]),line.number,'center',atomCounts[i+1]);if(field)field.origin='program-adopted';}if(this.cpNonfull())return true;}
    return false;
  }
  private configure(): void {
    // Gaussian wraps route text at physical columns, including inside keywords.
    // Only known lexical tokens are rejoined; scientific source spelling is retained.
    this.data.route = normalizeGaussianRouteEcho(this.data.printedRoute??this.data.route).replace(new RegExp(`\\b${'EmpiricalDispersion'.split('').join('\\s*')}\\b`, 'gi'), 'EmpiricalDispersion');
    this.data.tasks = gaussianScientificTasks(this.data.route); this.target = energyTarget(this.data.route);
  }
  private task(task: ScientificTask): void {
    if (!this.data.tasks.includes(task)) this.data.tasks.push(task);
    if (task !== 'unknown') this.data.tasks = this.data.tasks.filter(value => value !== 'unknown' && (task === 'sp' || value !== 'sp'));
  }
  private calculationBoundary(): void {
    this.pendingFinalReprint = null;
    this.flushTables(); this.calculationEpoch++;
    this.current = null; this.orientation = ''; this.frameObserved = false;
    this.optimized = false; this.coordinate = undefined; this.step = null;
  }

  private flushOrbitals(): void {
    if (!this.orbitalSet) return;
    const { alpha, beta } = this.orbitalSet;
    if (this.orbitalSetLimited) {
      // A partial orbital list cannot establish frontier orbitals or occupations.
      const retained = (alpha?.orbitals.length ?? 0) + (beta?.orbitals.length ?? 0);
      this.storage.releaseObservations(retained); this.segmentRetained -= retained;
      this.omitted(retained, alpha?.sourceLine ?? beta?.sourceLine ?? this.lastLine);
      this.notice('轨道表达到科学观测上限，已隔离该不完整表；未由截断轨道推断HOMO/LUMO或补齐占据。');
      if(alpha)this.cpOrbitalTokens.delete(alpha);if(beta)this.cpOrbitalTokens.delete(beta);
      this.orbitalSet = null; this.orbitalSetLimited = false; return;
    }
    if (alpha && !beta && this.scfChannel === 'restricted') {
      // Gaussian prints Alpha for a restricted channel too. The population tells
      // us when there is one common orbital channel; open-shell RO remains alpha.
      alpha.spin = 'restricted'; for (const orbital of alpha.orbitals) orbital.occupation *= 2;
    }
    for (const channel of [alpha, beta]) if (channel) {
      if(this.cpNonfull()){
        const raw=this.cpOrbitalTokens.get(channel)??[];
        channel.orbitals.forEach((orbital,index)=>{
          // Each native energy was already charged by the orbital reader.
          this.data.bsse.push({key:this.cpPrefix()+`orbital-${channel.spin}-${orbital.index}`,label:this.cpLabel()+` · printed orbital ${channel.spin} ${orbital.index} (occupation ${orbital.occupation})`,value:orbital.energy,rawValue:raw[index],unit:'hartree',sourceLine:orbital.sourceLine??channel.sourceLine,frameIndex:null,origin:'observation'});
          this.cpMeta(`orbital-${channel.spin}-${orbital.index}-occupation`,'由该组件原occ/virt和打印参考态识别的占据',orbital.occupation,orbital.sourceLine??channel.sourceLine,'derived');
        });
        this.cpOrbitalTokens.delete(channel);continue;
      }
      this.data.orbitals.push(channel);
      const occupied = channel.orbitals.filter(item => item.occupation > 0), virtual = channel.orbitals.filter(item => item.occupation === 0);
      const homo = occupied.at(-1), lumo = virtual[0];
      if (homo) this.field(this.data.summary, `homo-${channel.spin}`, `HOMO (${channel.spin})`, homo.energy, channel.sourceLine, 'hartree');
      if (lumo) this.field(this.data.summary, `lumo-${channel.spin}`, `LUMO (${channel.spin})`, lumo.energy, channel.sourceLine, 'hartree');
      if (homo && lumo) this.field(this.data.summary, `gap-${channel.spin}`, `HOMO–LUMO gap (${channel.spin})`, lumo.energy - homo.energy, channel.sourceLine, 'hartree');
    }
    this.orbitalSet = null;
  }
  private flushAtoms(): void {
    const table = this.atomTable; this.atomTable = null;
    if (table) {
      if(table.cp)return;
      const frame = table.frameIndex === null ? null : this.frames[table.frameIndex];
      if (frame && table.values.length === frame.geometry.elements.length) {
        const spinCount = table.spins.length === table.values.length ? table.spins.length : 0;
        if (this.count(table.values.length + spinCount, table.sourceLine)) {
          this.data.atomicProperties.push({ kind: table.kind, scheme: table.scheme, frameIndex: table.frameIndex, sourceLine: table.sourceLine, values: table.values, unit: 'e' });
          if (spinCount) this.data.atomicProperties.push({ kind: 'spin', scheme: table.scheme, frameIndex: table.frameIndex, sourceLine: table.sourceLine, values: table.spins, unit: 'e' });
        }
      } else this.notice(`${table.scheme}原子属性表不完整或没有可绑定的结构，未猜测原子对应。`);
    }
    if (this.shielding) {
      const frame = this.shielding.frameIndex === null ? null : this.frames[this.shielding.frameIndex];
      if (frame && this.shielding.values.length === frame.geometry.elements.length) { if (this.count(this.shielding.values.length, this.shielding.sourceLine)) this.data.atomicProperties.push(this.shielding); }
      else this.notice('NMR屏蔽常数表不完整或原子对应不明；未转换成化学位移。');
      this.shielding = null;
    }
  }
  private flushModes(): void {
    const block = this.modeBlock; this.modeBlock = null;
    if (!block) return;
    const frame = block.frameIndex === null ? null : this.frames[block.frameIndex];
    if (frame && !block.invalid && block.rows.length === frame.geometry.elements.length) {
      block.modes.forEach((mode, column) => { mode.displacements = block.rows.map(row => row[column]); });
    } else {
      if (block.readingRows) this.damaged = true;
      this.notice('部分频率缺少完整且原子顺序一致的位移向量；保留打印频率，禁用该模式动画。');
    }
  }
  private flushTables(): void { this.finishShieldingTensor();this.finishCoupling();this.flushOrbitals(); this.flushAtoms(); this.flushModes(); this.excited = null; this.excitedSuppressed = false; this.cycle = null; this.cycleIteration = null; }
  private archive(newJob: boolean): void {
    this.snapshotState?.cache.invalidate(this.data);
    // Job/stage closure can finalize convergence and reprint attribution. Rebuild
    // only this job's frame snapshot, retaining other closed jobs and ordinary
    // append geometry sharing. Do not weaken final facts for a cache hit.
    this.snapshotState?.cache.invalidate(this.frames);
    this.flushTables();
    this.finishCpComponent(this.lastLine);this.cpComponent=null;this.cpFinished=true;
    this.mergeFinalReprint();
    if (this.block) { this.block = null; this.damaged = true; this.messages.add('几何块截断；仅保留完整有效帧。'); }
    const hasEvidence=Boolean(this.seenIdentity||this.frames.length||this.data.route||this.data.version||this.damaged||this.failed||this.terminated||this.data.properties.length||this.data.bsse.length);
    if(hasEvidence){
      const diagnostics=this.diagnostics();
      if(this.damaged)diagnostics.integrity={status:'damaged-tail',sourceLine:this.lastLine,message:'存在无效或未闭合的数据块；已保留此前完整观测。'};
      diagnostics.fields.push({field:'geometry',status:this.frames.length?(this.damaged||this.unsupportedGeometry?'partial':'complete'):this.unsupportedGeometry?'unsupported':this.terminated&&!this.damaged?'not-printed':'stage-not-reached',sourceLine:this.lastLine,message:this.frames.length?undefined:'没有完整受支持的普通原子几何，未借用其他作业或片段结构。'});
      for(const task of this.data.tasks){
        if(diagnostics.tasks.some(item=>item.task===task))continue;
        const completed=task==='opt'||task==='ts'?this.optimized:task==='sp'&&this.terminated&&this.frames.some(frame=>frame.energy!==null);
        diagnostics.tasks.push({task,status:completed?'completed':task==='opt'||task==='ts'||!this.terminated?'incomplete':'unknown',sourceLine:this.lastLine,frameIndex:this.current?.index??null});
      }
      const stable=gaussianRouteTokens(this.data.route).find(token=>/^stable(?=$|[=(])/i.test(token));
      if(stable&&/\bopt\b/i.test(stable)&&!diagnostics.tasks.some(row=>row.stageId==='wavefunction-optimization'))diagnostics.tasks.push({task:'stability',stageId:'wavefunction-optimization',status:'unknown',sourceLine:this.routeSourceLine,frameIndex:null,raw:stable});
      for(const frame of this.frames)if(!frame.energy){
        const message=`源行${frame.sourceLine}的结构帧${frame.index+1}未关联已确认目标能量；未补零、未借前帧能量，原生完成事件独立保留。`;
        if(this.metadata(message.length,frame.sourceLine))diagnostics.fields.push({field:'target-energy',status:this.target==='unknown'?'unsupported':'not-printed',frameIndex:frame.index,sourceLine:frame.sourceLine,message});
      }
    }
    if (this.frames.length) {
      if (!this.data.tasks.length) this.task('unknown');
      if (!this.terminated) this.messages.add('此段未检测到Gaussian正常终止，可能仍在运行或被截断。');
      if (this.target === 'unknown') this.notice('目标方法能量尚未可靠识别；未用SCF参考能量代替。');
      if (this.frames.some(frame => !frame.energy)) this.notice('部分结构没有已确认的目标能量，未补零或跨帧补值。');
      const requiresOptimization = this.data.tasks.includes('opt') && !this.data.tasks.includes('irc') && !this.data.tasks.includes('scan');
      let final: IndexedScientificFrame | undefined;
      for (let index = this.frames.length - 1; index >= 0; index--) if (this.frames[index].energy !== null) { final = this.frames[index]; break; }
      if (final?.energy) {
        const targetSource = this.targetSource;
        const field = this.field(this.data.summary, 'target-energy', '最后已评估的目标能量', final.energy.value, targetSource && targetSource.frameIndex === final.index ? targetSource.sourceLine : final.sourceLine, final.energy.unit,targetSource?.frameIndex===final.index?targetSource.rawValue:undefined);
        if (field) field.frameIndex = final.index;
      }
      this.jobs.push({ engine: 'gaussian', jobIndex: this.jobIndex, segmentIndex: this.segmentIndex++, charge: this.charge, multiplicity: this.multiplicity,
        status: this.failed ? 'failed' : this.terminated && !this.ircPathLimited && !this.damaged && !this.unsupportedGeometry && !this.segmentOmitted && !this.segmentMetadataOmitted && !this.couplingPartial && (!requiresOptimization || this.optimized) ? 'completed' : 'incomplete',
        frames: this.frames, data: this.data, messages: [...this.messages] });
    } else if (hasEvidence) {
      const previous = this.jobs.at(-1);
      if (previous) { this.snapshotState?.cache.invalidateSpine(previous); this.snapshotState?.cache.invalidateSpine(previous.data); }
      if (this.data.bsse.length && previous?.jobIndex === this.jobIndex) {
        previous.data.bsse.push(...this.data.bsse.map(field => ({ ...field, frameIndex: null })));
        previous.data.notices.push('同一Gaussian job后续片段的BSSE汇总以原sourceLine保留；这是多片段作业观测，不是前帧能量或逐帧属性。');
      }
      previous?.messages.push(`job ${this.jobIndex + 1} / 段 ${this.segmentIndex + 1} 没有完整受支持的几何；其结果未借用前段结构。${this.failed ? ' 此片段错误终止。' : ''}`);
      if(!this.data.tasks.length)this.task('unknown');
      this.storage.reserveIndices();
      this.jobs.push({engine:'gaussian',jobIndex:this.jobIndex,segmentIndex:this.segmentIndex++,charge:this.charge,multiplicity:this.multiplicity,
        status:this.failed?'failed':'incomplete',frames:[],data:this.data,messages:[...this.messages,'本作业/片段没有完整受支持的普通原子几何；保留文件级信息和诊断。']});
    }
    const route = this.data.route, printedRoute = this.data.printedRoute, version = this.data.version;
    this.data = emptyScientificData();
    if (!newJob) { this.data.route = route; this.data.printedRoute = printedRoute; this.data.version = version; this.configure(); }
    this.frames = []; this.current = null; this.inventory = null; this.messages.clear();
    this.lastOrientations.clear();
    this.calculationEpoch = 0;
    this.terminated = false; this.failed = false; this.pendingNativeTermination=null; this.damaged = false;this.unsupportedGeometry=false; this.optimized = false; this.frameObserved = false;
    this.step = null; this.node = null; this.direction = undefined; this.coordinate = undefined;
    this.inputCartesian = null; this.expectingInputCartesian = false; this.capturingInputCartesian = false; this.tsReferenceEnergy = null; this.ircCoordinateUnit = undefined;
    this.ordinaryIrc=false;this.ircPathLimited=false;this.ircBranch=null;this.ircSummary=null;this.snapshotIrcSummaryLine=null;this.ircSummaryReference=undefined;
    this.printedModeIndices = null; this.orientation = '';
    this.scfChannel = 'unknown'; this.targetSource = null; this.scfAttemptFailed = false;
    this.selectedFrequencyState=null;this.optimizationGeometrySourceLine=null;if(newJob)this.routeSourceLine=0;
    this.segmentObserved = 0; this.segmentRetained = 0; this.segmentOmitted = 0; this.firstOmittedLine = 0; this.lastOmittedLine = 0;
    this.segmentMetadataObserved=0;this.segmentMetadataRetained=0;this.segmentMetadataOmitted=0;this.firstOmittedMetadataLine=0;this.lastOmittedMetadataLine=0;
    this.frequencyScale = undefined;
    this.newFrequencyAnalysis = true;
    this.thermalTable = false; this.dipoleNext = false;
    this.coupling=null;this.couplingPartial=false;this.isotopeSection=false;this.isotopeColumns=[];this.isotopes.clear();this.invalidIsotopes.clear();
    this.cpComponent=null;this.cpOrdinal=0;this.cpFinished=false;this.cpCandidateFrame=null;this.cpFullFrame=null;this.cpInputEcho=false;this.cpInputOrdinal=0;this.cpInputAtoms.clear();this.cpStates.clear();this.cpOrbitalTokens.clear();this.shieldingHeader=null;this.shieldingTensor=null;this.frozenUnitsLine=null;this.solventTableLine=null;this.pcmInput=false;
    if (newJob) { this.jobIndex++; this.segmentIndex = 0; this.charge = null; this.multiplicity = null; this.expectedAtoms = null; this.target = 'unknown'; this.routeCapture = false; }
  }

  private acceptGeometry(): void {
    this.mergeFinalReprint();
    const block = this.block; this.block = null;
    if (!block) return;
    if(this.cpComponent&&this.cpComponent.role!=='full-system'){
      this.cpMeta('geometry-source','组件几何仅保原文区间，不创建普通complex帧',`source lines ${block.line}–${this.lastLine}; ${block.centers.length} printed centers`,block.line);
      const message=this.cpLabel()+' 的几何/ghost中心不与complex合并；需按组件原文另核。';
      if(this.metadata(message.length,block.line))this.diagnostics().fields.push({field:'counterpoise-component-geometry',status:block.invalid?'partial':'unsupported',sourceLine:block.line,frameIndex:null,message});
      this.current=null;return;
    }
    if (block.invalid || block.unsupportedCenters || !block.elements.length || (this.expectedAtoms !== null && block.elements.length !== this.expectedAtoms)) {
      if(block.centers.some(center=>center.kind!=='real')){
        this.storage.reserveCenters(block.centers.length);
        this.data.centers=block.centers;
        this.diagnostics().fields.push({field:'centers',status:'unsupported',sourceLine:block.line,message:'保留原生Atomic Number、Atomic Type及中心身份；特殊或未知中心不构造普通原子。'});
      }
      if(block.unsupportedCenters)this.unsupportedGeometry=true;
      if(block.invalid||!block.centers.length||(this.expectedAtoms!==null&&block.centers.length!==this.expectedAtoms))this.damaged=true;
      this.current = null; this.messages.add('无效、截断或含ghost/dummy的几何块未索引；未删除原子或借用前帧。'); return;
    }
    if (this.inventory && this.inventory.join(',') !== block.elements.join(',')) {
      this.messages.add('原子库存或顺序改变，已隔离为新结果段。'); this.archive(false);
    }
    if (!this.inventory) {
      this.storage.reserveCenters(block.elements.length);
      this.inventory = block.elements;
    }
    const geometry: ScientificGeometry = { start: block.start, end: block.end, line: block.line, format: 'gaussian-orientation', elements: this.inventory };
    const previousOrientation = this.lastOrientations.get(block.orientation);
    const duplicateFinal = this.optimized && previousOrientation
      && previousOrientation.epoch === this.calculationEpoch
      && previousOrientation.positions.length === block.positions.length
      && previousOrientation.positions.every((value, index) => value === block.positions[index]);
    if (this.current && !this.frameObserved && this.orientation === 'Input' && block.orientation === 'Standard') {
      this.current.geometry = geometry; this.current.sourceLine = block.line;
    } else {
      this.flushTables();
      this.storage.reserveIndices();
      const innerStep = this.step === null ? '' : ` / 优化步 ${this.step}`;
      const label = this.node === null ? (this.optimized ? '收敛后打印的末结构快照（独立能量未打印）' : undefined) : `${this.data.tasks.includes('irc') ? 'IRC' : '扫描'}节点 ${this.node}${innerStep}`;
      this.current = { index: this.frames.length, sourceStep: this.step, time: null, energy: null, convergence: [], sourceLine: block.line, geometry,
        ...(this.node !== null && this.node >= 0 ? { pathNode: this.node } : {}),
        ...(label ? { label } : {}), ...(this.coordinate ? { coordinate: { ...this.coordinate } } : {}), ...(this.direction ? { pathDirection: this.direction } : {}) };
      this.frames.push(this.current);
      this.step = null;
      this.newFrequencyAnalysis = true; this.frequencyScale = undefined;
    }
    if (duplicateFinal && previousOrientation && this.current && previousOrientation.index !== this.current.index) this.pendingFinalReprint = {previousIndex:previousOrientation.index,candidateIndex:this.current.index,line:block.line,orientation:block.orientation};
    if (this.current) this.lastOrientations.set(block.orientation, { index: this.current.index, positions: block.positions, epoch: this.calculationEpoch });
    this.frameObserved = false; this.orientation = block.orientation;
    if(this.cpRequested())this.cpCandidateFrame=this.current?.index??null;
  }

  /** Only a candidate with no following SCF/step is the old physical frame.
   * Remap its printed data rather than dropping source observations. */
  private mergeFinalReprint(): void {
    const pending = this.pendingFinalReprint;
    this.pendingFinalReprint = null;
    if (!pending) return;
    const previous = this.frames[pending.previousIndex], candidate = this.frames[pending.candidateIndex];
    if (!previous || !candidate || pending.candidateIndex !== this.frames.length - 1) return;
    this.snapshotState?.cache.invalidate(this.data);
    this.frames.pop();
    for (const rows of [this.data.summary,this.data.properties,this.data.thermochemistry,this.data.stability,this.data.bsse,this.data.orbitals,this.data.atomicProperties,this.data.scfCycles,this.data.excitedStates,this.data.nmrCouplings??[],this.data.vibrationSets ?? [],...(this.data.vibrations ? [[this.data.vibrations]] : [])]) {
      for (const row of rows) if (row.frameIndex === pending.candidateIndex) row.frameIndex = pending.previousIndex;
    }
    if(this.data.diagnostics)for(const rows of [this.data.diagnostics.scf,this.data.diagnostics.tasks,this.data.diagnostics.fields]){
      for(const row of rows)if(row.frameIndex===pending.candidateIndex)row.frameIndex=pending.previousIndex;
    }
    for (const item of this.lastOrientations.values()) if (item.index === pending.candidateIndex) item.index = pending.previousIndex;
    this.current = previous; this.frameObserved = true;
    this.notice(`收敛后源行${pending.line}重复打印的${pending.orientation}坐标与同一计算步逐数值完全相同，归入源行${previous.sourceLine}的同一结构帧；保留原评估能量与来源。`);
  }
  private geometryLine(line: ScientificLine): boolean {
    const block = this.block;
    if (!block) return false;
    if (separator.test(line.text)) {
      if (block.stage < 2) block.stage++;
      else this.acceptGeometry();
      return true;
    }
    if (block.stage < 2) {
      block.header += ` ${line.text}`;
      return true;
    }
    if (!/Center/.test(block.header) || !/Atomic/.test(block.header) || !/Angstroms/i.test(block.header)) block.invalid = true;
    const row = line.text.trim().split(/\s+/);
    if (row.length !== 6 || !/^\d+$/.test(row[0]) || Number(row[0]) !== block.centers.length + 1 || !/^[+-]?\d+$/.test(row[1]) || !/^[+-]?\d+$/.test(row[2]) || !numbers(row.slice(3).join(' '))) {
      block.invalid = true; this.acceptGeometry(); return false;
    }
    const z=Number(row[1]),atomicType=Number(row[2]),coordinates=numbers(row.slice(3).join(' '))! as [number,number,number];
    if(z<=0||atomicType!==0){
      let element:string|null=null;
      if(z>0)try{element=elementSymbol(row[1]);}catch{/* Unknown identifiers remain raw centers, never ordinary nuclei. */}
      const ghost=atomicType===1000&&z>0&&element!==null;
      block.unsupportedCenters=true;block.centers.push({sourceIndex:Number(row[0]),sourceAtomicNumber:z,sourceAtomicType:atomicType,raw:line.text,sourceLine:line.number,kind:ghost?'ghost':'unknown',element,nuclearCharge:ghost?0:null,coordinates,coordinateUnit:'angstrom'});
      return true;
    }
    let element: string;
    try { element = elementSymbol(row[1]); } catch { block.invalid = true; this.acceptGeometry(); return false; }
    block.centers.push({sourceIndex:Number(row[0]),sourceAtomicNumber:z,sourceAtomicType:atomicType,raw:line.text,sourceLine:line.number,kind:'real',element,nuclearCharge:z,coordinates,coordinateUnit:'angstrom'});
    if (!block.elements.length) { block.start = line.start; block.line = line.number; }
    block.end = line.end; block.elements.push(element); block.positions.push(...numbers(row.slice(3).join(' '))!);
    return true;
  }

  private finishShieldingTensor():void {
    const tensor=this.shieldingTensor;this.shieldingTensor=null;if(!tensor)return;
    const complete=tensor.components.size===9,notPrinted=tensor.components.size===0&&!this.shieldingHeader;
    const message=`核${tensor.atomIndex+1} ${tensor.element}原屏蔽张量读取${tensor.components.size}/9分量；未强制对称、求迹替代原Isotropic或改作化学位移。`;
    if(this.metadata(message.length,tensor.sourceLine))this.diagnostics().fields.push({field:'shielding-tensor',status:complete?'complete':notPrinted?'not-printed':'partial',frameIndex:tensor.frameIndex,sourceLine:tensor.sourceLine,message});
    if(!complete&&!notPrinted)this.notice(message);
  }
  private readShieldingTensor(line:ScientificLine):boolean {
    const header=line.text.match(/^\s*(.*Magnetic shielding tensor)\s*\((ppm)\)\s*:\s*$/i);
    if(header){
      this.finishShieldingTensor();this.shieldingHeader={label:line.text.trim(),unit:'ppm',sourceLine:line.number};
      if(this.metadata(line.text.length,line.number))this.data.properties.push({key:'nmr-shielding-header',label:'原生屏蔽响应/单位说明（非chemical shift）',value:line.text.trim(),sourceLine:line.number,frameIndex:this.current?.index??null,origin:'program-adopted'});
      return true;
    }
    if(/^\s*No NMR shielding tensors\b/.test(line.text)){
      if(this.metadata(line.text.length,line.number))this.diagnostics().fields.push({field:'shielding',status:'not-printed',sourceLine:line.number,frameIndex:this.current?.index??null,message:line.text.trim()});return true;
    }
    const tensor=this.shieldingTensor;if(!tensor)return false;
    if(!/^\s*[XYZ]{2}\s*=/.test(line.text)){this.finishShieldingTensor();return false;}
    const matches=[...line.text.matchAll(new RegExp(`([XYZ]{2})\\s*=\\s*(${N})`,'g'))];
    const residue=line.text.replace(new RegExp(`[XYZ]{2}\\s*=\\s*${N}`,'g'),'').trim();
    if(matches.length!==3||residue||matches.some(match=>tensor.components.has(match[1]))||new Set(matches.map(match=>match[1])).size!==matches.length){this.finishShieldingTensor();return true;}
    for(const match of matches){
      const field=this.field(this.data.properties,`nmr-shielding-${tensor.atomIndex+1}-tensor-${match[1]}`,`${this.shieldingHeader?.label??'NMR shielding (unit unconfirmed)'} · source nucleus ${tensor.atomIndex+1} ${tensor.element} ${match[1]}`,scientificNumber(match[2])!,line.number,this.shieldingHeader?.unit,match[2]);
      if(field)field.origin='observation';tensor.components.add(match[1]);
    }
    if(tensor.components.size===9)this.finishShieldingTensor();return true;
  }

  private readNmrIsotopes(line:ScientificLine):boolean {
    if(/^\s*Isotopes and Nuclear Properties\s*:/i.test(line.text)){this.isotopeSection=true;this.isotopeColumns=[];return true;}
    if(!this.isotopeSection)return false;
    if(/^\s*(?:Leave Link\s+101\b|(?:Standard|Input|Z-Matrix) orientation:)/.test(line.text)){this.isotopeSection=false;return false;}
    const columns=line.text.match(/^\s*Atom\s+([\d\s]+)\s*$/);
    if(columns){const ids=columns[1].trim().split(/\s+/).map(Number);
      this.isotopeColumns=ids.every(id=>Number.isSafeInteger(id)&&id>=1)&&new Set(ids).size===ids.length?ids:[];return true;}
    const weights=line.text.match(/^\s*IAtWgt=\s*(.*?)\s*$/);if(!weights)return false;
    const tokens=weights[1].split(/\s+/);
    if(!this.isotopeColumns.length||tokens.length!==this.isotopeColumns.length||tokens.some(token=>!/^\d+$/.test(token)||!Number.isSafeInteger(Number(token))||Number(token)<1)){
      this.notice(`源行${line.number}的IAtWgt身份表无效或缺列头；未猜同位素。`);return true;
    }
    tokens.forEach((token,index)=>{
      const id=this.isotopeColumns[index],previous=this.isotopes.get(id);
      if(previous&&previous.massNumber!==Number(token)){
        this.isotopes.delete(id);this.invalidIsotopes.add(id);
        const message=`核${id}的IAtWgt冲突：源行${previous.sourceLine}为${previous.rawLabel}，源行${line.number}为${token}；同位素保持未知。`;
        this.notice(message);if(this.metadata(message.length,line.number))this.diagnostics().fields.push({field:'nmr-coupling-isotope',status:'conflict',sourceLine:line.number,message});return;
      }
      if(!previous&&!this.invalidIsotopes.has(id)&&this.metadata(token.length,line.number))this.isotopes.set(id,{rawLabel:token,massNumber:Number(token),sourceLine:line.number});
    });return true;
  }
  private finishCoupling():void {
    const table=this.coupling;this.coupling=null;if(!table)return;
    const n=table.expectedAtoms;
    const complete=!table.invalid&&!table.mappingPartial&&table.retained===table.printed&&n!==null
      &&table.seenColumns.size===n&&[...table.seenColumns].every(index=>index>=1&&index<=n)&&table.printed===n*(n+1)/2;
    if(!complete)this.couplingPartial=true;
    const message=`${table.heading} 原表读取${table.printed}个明确标量、保留${table.retained}个；${complete?'原下三角及分页核号完整。':'仅保可信前缀/原核号，缺列、坏值、分页冲突、限额或几何映射不足未补全。'}未补上三角、零值、张量或K到J换算。`;
    if(this.metadata(message.length,table.line.number))this.diagnostics().fields.push({field:'nmr-coupling',status:complete?'complete':'partial',sourceLine:table.line.number,frameIndex:table.frameIndex,message});
    if(!complete)this.notice(message);
  }
  private couplingNucleus(label:string,index:number,sourceLine:number,frameIndex:number|null):NmrCouplingNucleus {
    const frame=frameIndex===null?undefined:this.frames[frameIndex],isotope=this.isotopes.get(index);
    return {rawLabel:label,sourceIndex:index,indexBase:1,atomIndex:frame?index-1:null,
      ...(frame?{element:frame.geometry.elements[index-1]}:{}),sourceLine,...(isotope?{isotope:{...isotope}}:{})};
  }
  private readNmrCoupling(line:ScientificLine):boolean {
    const heading=line.text.match(/^\s*((?:Fermi Contact \(FC\)|Spin-dipolar \(SD\)|Paramagnetic spin-orbit \(PSO\)|Diamagnetic spin-orbit \(DSO\)) contribution to|Total nuclear spin-spin coupling) ([JK]) \(([^)]+)\):\s*$/);
    if(heading){
      this.flushTables();this.task('nmr');
      const compatible=this.current&&(this.expectedAtoms===null||this.current.geometry.elements.length===this.expectedAtoms);
      this.coupling={heading:line.text.trim(),quantity:heading[2] as 'J'|'K',rawUnit:heading[3],line,frameIndex:compatible?this.current!.index:null,
        columns:[],seenColumns:new Set(),lastRow:0,expectedAtoms:this.expectedAtoms??(compatible?this.current!.geometry.elements.length:null),printed:0,retained:0,lastLine:line.number,invalid:false,blocked:false,mappingPartial:!compatible};return true;
    }
    const table=this.coupling;if(!table)return false;
    if(!line.text.trim())return true;
    if(table.blocked){if(/^\s*\d/.test(line.text))return true;this.finishCoupling();return false;}
    const header=line.text.match(/^\s{10,}(\d+(?:\s+\d+)*)\s*$/);
    if(header){
      const labels=header[1].trim().split(/\s+/),ids=labels.map(Number);
      if(!ids.length||ids.some((id,index)=>!Number.isSafeInteger(id)||id<1||index>0&&id<=ids[index-1]||table.seenColumns.has(id))){table.invalid=true;table.blocked=true;return true;}
      table.columns=ids.map((index,i)=>({index,label:labels[i],sourceLine:line.number}));ids.forEach(id=>table.seenColumns.add(id));table.lastRow=0;table.lastLine=line.number;return true;
    }
    const row=line.text.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if(!row){this.finishCoupling();return false;}
    const index=Number(row[1]),columns=table.columns.filter(column=>column.index<=index),tokens=nmrCouplingTokens(row[2]);
    if(!table.columns.length||!Number.isSafeInteger(index)||index<1||index<=table.lastRow||!tokens||tokens.length!==columns.length||!columns.length){table.invalid=true;table.blocked=true;return true;}
    table.lastRow=index;table.lastLine=line.number;
    for(let cell=0;cell<tokens.length;cell++){
      table.printed++;
      if(!this.count(1,line.number))continue;
      const column=columns[cell],candidate=table.frameIndex===null?undefined:this.frames[table.frameIndex];
      const frameIndex=candidate&&index<=candidate.geometry.elements.length&&column.index<=candidate.geometry.elements.length?table.frameIndex:null;
      if(frameIndex===null)table.mappingPartial=true;
      const block=createNmrCouplingBlock({pair:[this.couplingNucleus(row[1],index,line.number,frameIndex),this.couplingNucleus(column.label,column.index,column.sourceLine,frameIndex)],
        quantity:table.quantity==='J'?'J':'unknown',rawQuantityLabel:table.quantity,form:'scalar',jobIndex:this.jobIndex,frameIndex,sourceLine:table.line.number,endLine:line.number,start:table.line.start,end:line.end,
        values:[{label:table.heading,part:table.heading,value:scientificNumber(tokens[cell])!,rawValue:tokens[cell],sourceLine:line.number,rawUnit:table.rawUnit,
          ...(table.quantity==='J'&&table.rawUnit==='Hz'?{unit:'Hz'}:{}),unitSourceLine:table.line.number,start:line.start,end:line.end}]});
      (this.data.nmrCouplings??=[]).push(block);table.retained++;
    }return true;
  }

  private readAtomTable(line: ScientificLine): boolean {
    const table = this.atomTable;
    if (!table) return false;
    const fields = line.text.trim().split(/\s+/), natural = table.scheme === 'NPA';
    const index = natural ? Number(fields[1]) : Number(fields[0]), symbol = natural ? fields[0] : fields[1];
    const value = scientificNumber(fields[2] ?? '');
    if(table.cp){
      if(Number.isSafeInteger(index)&&index>=1&&value!==null&&symbol){
        const previous=table.values.at(-1)?.atomIndex??-1;
        if(index-1<=previous){this.notice(this.cpLabel()+' 原子表核号重复或逆序；保此前明确前缀。');this.flushAtoms();return true;}
        table.rows=true;table.values.push({atomIndex:index-1,element:symbol,value});
        const scheme=table.scheme.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
        this.field(this.data.bsse,this.cpPrefix()+`${scheme}-source-center-${index}-charge`,this.cpLabel()+` · ${table.scheme} printed source center ${index} ${symbol} (not complex atom mapping)`,value,line.number,'e',fields[2]);
        const spin=fields[3]===undefined?null:scientificNumber(fields[3]);if(spin!==null)this.field(this.data.bsse,this.cpPrefix()+`${scheme}-source-center-${index}-spin`,this.cpLabel()+` · spin printed source center ${index} ${symbol}`,spin,line.number,'e',fields[3]);
        return true;
      }
      if(table.rows||++table.skipped>8){this.flushAtoms();return false;}return true;
    }
    if (Number.isSafeInteger(index) && index >= 1 && value !== null && symbol) {
      const frame = table.frameIndex === null ? null : this.frames[table.frameIndex];
      let element: string | null = null; try { element = elementSymbol(symbol); } catch { /* invalidate below */ }
      if (!frame || index !== table.values.length + 1 || element !== frame.geometry.elements[index - 1]) { this.flushAtoms(); this.notice(`${table.scheme}原子编号/元素与当前结构不一致。`); return false; }
      table.rows = true; table.values.push({ atomIndex: index - 1, element, value });
      if (fields[3] !== undefined && (table.scheme === 'Mulliken charge and spin' || table.scheme === 'Hirshfeld')) {
        const spin = scientificNumber(fields[3]); if (spin !== null) table.spins.push({ atomIndex: index - 1, element, value: spin });
      }
      return true;
    }
    if (table.rows || ++table.skipped > 8) { this.flushAtoms(); return false; }
    return true;
  }
  private readModes(line: ScientificLine): boolean {
    const block = this.modeBlock;
    if (!block) return false;
    if (this.expectedAtoms !== null && ++block.age > this.expectedAtoms + 20) { block.invalid = true; this.flushModes(); return false; }
    if (/^\s*Atom\s+AN\b/.test(line.text)) { block.readingRows = true; return true; }
    if (block.readingRows) {
      const row = numbers(line.text), frame = block.frameIndex === null ? null : this.frames[block.frameIndex];
      if (!row || row.length !== 2 + 3 * block.modes.length || !frame || row[0] !== block.rows.length + 1 || row[1] !== atomicNumber(frame.geometry.elements[block.rows.length] ?? 'H')) {
        block.invalid = true; this.flushModes(); return false;
      }
      this.vectorValues += 3 * block.modes.length;
      block.rows.push(block.modes.map((_, index) => row.slice(2 + 3 * index, 5 + 3 * index) as [number, number, number]));
      if (block.rows.length === frame.geometry.elements.length) this.flushModes();
      return true;
    }
    const parameters = line.text.match(/^\s*(Red\. masses|IR Inten|Raman Activ|Frc consts|Depolar \(P\)|Depolar \(U\))\s+--\s+(.+)$/i);
    if (parameters) {
      const values = numbers(parameters[2]);
      if (values?.length === block.modes.length) block.modes.forEach((mode, index) => {
        if (/Red/i.test(parameters[1])) mode.reducedMass = values[index];
        else if (/IR/i.test(parameters[1])) { mode.irIntensity = values[index]; mode.irIntensityUnit = 'km/mol'; }
        else if (/Raman/i.test(parameters[1])) { mode.ramanActivity = values[index]; mode.ramanActivityUnit = 'Å⁴/amu'; mode.ramanActivitySourceLine = line.number;
          mode.ramanActivityConvention = /\bcphf\s*(?:=|\()[^#]*\brdfreq\b|\broa\b/i.test(this.data.route) ? 'dynamic' : this.data.route ? 'static' : 'unknown'; }
        else this.field(this.data.properties, `vibration-${mode.index}-${parameters[1]}`, `Mode ${mode.index} ${parameters[1]} (printed)`, values[index], line.number, /Frc/i.test(parameters[1]) ? 'mDyne/angstrom' : undefined);
      });
      else this.notice('频率打印参数列数量不一致，未补值。');
      return true;
    }
    if (/Frequencies\s+--|Normal termination|Error termination|orientation:|Thermochemistry/i.test(line.text)) { this.flushModes(); return false; }
    return false;
  }

  consume(line: ScientificLine): void {
    if (this.finished) throw new Error('Gaussian读取器已经finish。');
    this.snapshotState?.observe(line);
    const filtered=this.outputTitle.consume(line);
    if(filtered.title?.length){
      const value=filtered.title.map(row=>row.text).join('\n'),sourceLine=filtered.title[0].number;
      if(this.metadata(value.length,sourceLine))this.data.summary.push({key:'input-title',label:'输入标题（原文回显）',value,sourceLine,frameIndex:null});
    }
    for(const row of filtered.lines)this.consumeOutput(row);
  }

  private consumeOutput(line:ScientificLine):void {
    if (this.finished) throw new Error('Gaussian读取器已经finish。');
    // The tail frame can be edited by a later orientation/SCF/convergence line
    // before another frame becomes current. Invalidate only its envelope; its
    // already closed geometry/atom blocks remain reusable.
    if (this.current) this.snapshotState?.cache.invalidateSpine(this.current);
    const text = line.text;
    this.lastLine = line.number;
    if (this.outputArchive.consume(text)) return;
    const nativeEntry=/^\s*Entering Gaussian System\b/.test(text);
    if(/^\s*Link1:.*Proceeding to internal job step/.test(text)){this.archive(true);this.applyRunVersion();this.seenIdentity=true;return;}
    if(/^\s*--Link1--\s*$/.test(text)){this.archive(true);this.runVersion=null;this.runVersionConflict=null;this.seenIdentity=true;return;}
    if(nativeEntry||/^\s*Initial command\s*:/i.test(text)){
      if(this.frames.length||this.data.route||this.data.version||this.failed||this.terminated)this.archive(true);
      this.runVersion=null;this.runVersionConflict=null;this.seenIdentity=true;return;
    }
    if(/^\s*Gaussian\s+\d{2,4}\s*:/i.test(text)&&(this.frames.length||this.data.route||this.failed||this.terminated)){
      this.archive(true);this.runVersion=null;this.runVersionConflict=null;this.seenIdentity=true;
    }
    const pendingNativeTermination=this.pendingNativeTermination;this.pendingNativeTermination=null;
    if(pendingNativeTermination&&this.current){
      const register='r(?:ax|bx|cx|dx|sp|bp|si|di|8|9|1[0-5])\\s+[0-9a-f]{8,16}';
      const registerDump=new RegExp(`^\\s+${register}(?:,\\s*${register})*\\s*$`,'i').test(text);
      const nativeBacktrace=/^\s+\/\S+\/(?:l\d+\.exe|libc\.so(?:\.\d+)*)(?:\([^)]*\))?\s+\[0x[0-9a-f]+\]\s*$/i.test(text);
      if(registerDump||nativeBacktrace){this.failed=true;this.diagnostics().termination={status:'error',sourceLine:pendingNativeTermination.sourceLine,raw:pendingNativeTermination.text};
        this.diagnostics().errors.push({category:'native-abort',severity:'error',sourceLine:pendingNativeTermination.sourceLine,raw:pendingNativeTermination.text});
        this.messages.add(`源行${pendingNativeTermination.sourceLine}：${pendingNativeTermination.text}`);}
    }
    // A truncated orientation header must not swallow a subsequent native
    // termination marker. Discard only that open block, then read the marker.
    if(this.block&&/^\s*(?:Error termination\b|Normal termination of Gaussian\b|(?:Standard|Input|Z-Matrix) orientation:)/.test(text)){
      this.block.invalid=true;this.acceptGeometry();
    }
    if (this.geometryLine(line)) return;
    if (/^\s*#[pnt]?(?:\s|$)/i.test(text) && !/^\s*#\s+OF\b/i.test(text)) {
      if (this.data.route || this.frames.length) {this.archive(true);this.runVersion=null;this.runVersionConflict=null;}
      this.data.route = text.trim(); this.data.printedRoute = text.trim(); this.routeSourceLine=line.number; this.routeCapture = true; this.configure(); return;
    }
    if (this.routeCapture) {
      if (!text.trim() || separator.test(text)||/^\s*(?:Error termination\b|Normal termination of Gaussian\b|QPErr\s+---)/.test(text)) { this.routeCapture = false; this.configure(); }
      else {
        const printedRoute=`${this.data.printedRoute}\n${text.trim()}`;
        this.data.printedRoute=printedRoute;
this.configure(); return;
      }
    }
    if(this.readCounterpoise(line))return;
    this.readPrintedSettings(line);
    const basis=text.match(/^\s*(\d+) basis functions\b/i);
    if(basis&&this.metadata(basis[1].length,line.number))this.data.properties.push({key:'basis-functions-program-adopted',label:'原生实际基组函数数（非请求基组名）',value:Number(basis[1]),rawValue:basis[1],sourceLine:line.number,unit:'functions',frameIndex:this.current?.index??null,origin:'program-adopted'});
    if(/^\s*(?:Standard basis:|Basis read from chk:|UnConB:\s+Uncontracting AO basis|Converting basis for Fermi contact)/.test(text)&&this.metadata(text.length,line.number))this.data.properties.push({key:'basis-program-source',label:'原生基组/响应转换来源',value:text.trim(),sourceLine:line.number,frameIndex:this.current?.index??null,origin:'program-adopted'});
    if (this.capturingInputCartesian) {
      const fields = text.trim().split(/\s+/);
      if (fields.length === 4 && fields.slice(1).every(value => scientificNumber(value) !== null)) {
        try {
          const element = elementSymbol(fields[0]), candidate = this.inputCartesian!;
          if (!candidate.elements.length) { candidate.start = line.start; candidate.line = line.number; }
          candidate.end = line.end; candidate.elements.push(element);
          return;
        } catch { this.inputCartesian = null; }
      } else if (text.trim() && /^[A-Za-z]{1,3}\s/.test(text.trim())) this.inputCartesian = null;
      this.capturingInputCartesian = false;
    }
    if (/^\s*Symbolic Z-matrix\s*:/i.test(text)) this.expectingInputCartesian = true;
    const scanDefinition = text.match(/^\s*([BAD])\s+(\d+)\s+(\d+)(?:\s+(\d+))?(?:\s+(\d+))?\s+S\s+\d+\s+[+-]?[\d.]+(?:[dDeE][+-]?\d+)?\s*$/i);
    if (scanDefinition) {
      const kind = scanDefinition[1].toUpperCase(), atoms = scanDefinition.slice(2).filter(value => value !== undefined).map(value => Number(value) - 1), required = kind === 'B' ? 2 : kind === 'A' ? 3 : 4;
      if (atoms.length === required && atoms.every(value => value >= 0 && Number.isSafeInteger(value)) && new Set(atoms).size === required) {
        this.task('scan'); if (this.count()) (this.data.scanCoordinates ??= []).push({ kind: kind === 'B' ? 'bond' : kind === 'A' ? 'angle' : 'dihedral', atomIndices: atoms, unit: kind === 'B' ? 'angstrom' : 'degree', sourceLine: line.number });
      }
    }
    this.readRunVersion(line);
    const state = text.match(/Charge\s*=\s*([+-]?\d+)\s+Multiplicity\s*=\s*(\d+)/);
    if (state) {
      const charge = Number(state[1]), multiplicity = Number(state[2]);
      const observed=Boolean(this.frames.length||this.data.centers?.length||this.data.properties.length||this.data.scfCycles.length||this.data.bsse.length||this.data.excitedStates.length||this.data.nmrCouplings?.length);
      if (!Number.isSafeInteger(charge) || !Number.isSafeInteger(multiplicity) || multiplicity < 1) {
        if(observed)this.archive(false);
        this.charge=null;this.multiplicity=null;this.expectedAtoms=null;this.current=null;this.damaged=true;
        this.error('invalid-electronic-state',line,'warning');
        this.diagnostics().fields.push({field:'electronic-state',status:'partial',sourceLine:line.number,message:'电荷或多重度无效；当前段身份未知，未沿用前段状态。'});
        return;
      }
      if (observed && (this.charge !== charge || this.multiplicity !== multiplicity)) { this.messages.add('电荷或多重度改变，已隔离为新结果段。'); this.archive(false); }
      this.charge = charge; this.multiplicity = multiplicity;
      if (this.expectingInputCartesian) {
        this.expectingInputCartesian = false;
        // Cartesian input echo uses Angstrom unless Units overrides it. This
        // narrow adapter does not reinterpret symbolic coordinates or Bohr input.
        if (!/\bUnits\s*=\s*(?:\([^)]*\b)?(?:Bohr|AU)\b/i.test(this.data.route)) {
          this.inputCartesian = { start: line.end, end: line.end, line: line.number, elements: [] }; this.capturingInputCartesian = true;
        }
      }
      return;
    }
    const count = text.match(/NAtoms=\s*(\d+)/); if (count) { this.expectedAtoms = Number(count[1]); if (!Number.isSafeInteger(this.expectedAtoms) || this.expectedAtoms < 1) throw new Error('Gaussian NAtoms须为正安全整数。'); }
    if(this.readNmrIsotopes(line))return;
    const checkpointEnergy = text.match(new RegExp(`Energy From Chk\\s*=\\s*(${N})`, 'i'));
    if (checkpointEnergy && scientificNumber(checkpointEnergy[1]) !== null) this.tsReferenceEnergy = { value: scientificNumber(checkpointEnergy[1])!, line: line.number,rawValue:checkpointEnergy[1] };
    if (/Current Structure is TS\s*->/i.test(text) && this.data.tasks.includes('irc')) {
      const candidate = this.inputCartesian;
      if (!this.current && !this.frames.length && candidate?.elements.length && (this.expectedAtoms === null || this.expectedAtoms === candidate.elements.length)) {
        this.storage.reserveIndices();
        this.inventory = candidate.elements;this.storage.reserveCenters(candidate.elements.length);
        this.current = { index: 0, sourceStep: 0, time: null, energy: this.tsReferenceEnergy ? { value: this.tsReferenceEnergy.value, unit: 'hartree' } : null, convergence: [],
          sourceLine: candidate.line, geometry: { ...candidate, format: 'gaussian-cartesian' }, pathNode: 0, pathDirection: 'ts', pathPoint: true, label: 'TS（来源明确的起始结构）',
          coordinate: { value: 0, unit: this.ircCoordinateUnit ?? 'step', label: this.ircCoordinateUnit ? 'IRC reaction coordinate' : '相对TS分支步数' } };
        this.frames.push(this.current);
        if (this.tsReferenceEnergy) this.field(this.data.properties, 'irc-ts-reference-energy', 'IRC TS参考能量（从checkpoint读取，未冒重新评估）', this.tsReferenceEnergy.value, this.tsReferenceEnergy.line, 'hartree',this.tsReferenceEnergy.rawValue);
      } else if (this.current && (this.current.pathNode === undefined || this.current.pathNode === 0)
        && !this.frames.some(frame => frame.pathPoint && (frame.pathNode ?? 0) > 0)) {
        // Gaussian External prints its initial orientation/evaluation before
        // declaring Point 0. The explicit TS declaration binds that complete
        // current geometry; it is not necessary to synthesize another frame.
        this.current.pathNode = 0; this.current.pathDirection = 'ts'; this.current.pathPoint = true;
        this.current.coordinate = { value: 0, unit: this.ircCoordinateUnit ?? 'step', label: this.ircCoordinateUnit ? 'IRC reaction coordinate' : '相对TS分支步数' };
      }
    }
    if (/Integration on MW PES.*sqrt\(amu\)\s*\*\s*bohr/i.test(text)) {
      this.ircCoordinateUnit = 'sqrt(amu)·bohr';
      const ts = this.frames.find(frame => frame.pathDirection === 'ts');
      if (ts) ts.coordinate = { value: 0, unit: this.ircCoordinateUnit, label: 'IRC reaction coordinate' };
    }
    const orientation = text.match(/^\s*(Input|Standard|Z-Matrix) orientation\s*:/i);
    if (orientation) {
      // Ordinary IRC labels are postfix observations of the previous table;
      // none of their node/coordinate values is a header for this new frame.
      if(this.ordinaryIrc){this.node=null;this.coordinate=undefined;}
      this.flushTables(); this.snapshotGeometryLine = line.number; this.block = { stage: 0, header: '', orientation: orientation[1], start: line.end, end: line.end, line: line.number, elements: [], positions: [], centers:[], invalid: false }; return;
    }
    if (this.readShieldingTensor(line)||this.readNmrCoupling(line) || this.readAtomTable(line) || this.readModes(line)) return;
    const pathContext = this.data.tasks.includes('irc') || this.data.tasks.includes('scan');
    // A relaxed-scan step footer describes the geometry just evaluated. It is
    // not a pending point header and must not clear that frame's observations.
    const scanStep = this.data.tasks.includes('scan') ? text.match(/^\s*Step number\s+\d+\s+out of\s+(?:a maximum of\s+)?\d+\s+on scan point\s+(\d+)\s+out of\s+(\d+)\s*$/i) : null;
    if (scanStep && Number(scanStep[1]) >= 1 && Number(scanStep[1]) <= Number(scanStep[2])) {
      this.node = Number(scanStep[1]);
      if (this.current) { this.current.pathNode = this.node; this.current.label = `扫描节点 ${this.node}`; }
    }
    const step = text.match(/Step number\s+(\d+)/i);
    if (step) {
      this.pendingFinalReprint = null;
      const value = Number(step[1]);
      // Gaussian's normal Step number summary follows its geometry/evaluation.
      // A second, changed step header is a pending calculation boundary.
      if (this.current && this.current.sourceStep === null) {
        this.current.sourceStep = value; this.calculationEpoch++;
        for (const orientation of this.lastOrientations.values()) if (orientation.index === this.current.index) orientation.epoch = this.calculationEpoch;
        if (this.node !== null) this.current.label = `${this.data.tasks.includes('irc') ? 'IRC' : '扫描'}节点 ${this.node} / 优化步 ${value}`;
      } else if (this.current?.sourceStep !== value) { this.calculationBoundary(); this.step = value; }
    }
    // Point number also occurs in SCF/DIIS diagnostics. Only complete native
    // path headers in an established path task may advance a scientific node.
    const pointFooter=this.data.tasks.includes('irc')?text.match(/^\s*Point Number\s*:\s*(\d+)\s+Path Number\s*:\s*(\d+)\s*$/i):null;
    if(pointFooter&&this.current){
      this.ordinaryIrc=true;
      const value=Number(pointFooter[1]),nativePath=Number(pointFooter[2]);
      const sourceDirection=this.direction==='forward'||this.direction==='reverse'?this.direction:undefined;
      if(!this.ircBranch)this.ircBranch={nativePath,frames:[],...(sourceDirection?{direction:sourceDirection}:{})};
      else if(this.ircBranch.nativePath!==null&&this.ircBranch.nativePath!==nativePath){this.ircBranch={nativePath,frames:[]};this.direction=undefined;}
      this.ircBranch.nativePath=nativePath;
      this.node=value;this.current.pathNode=value;this.current.pathPoint=true;this.current.label=`IRC节点 ${value}`;
      this.field(this.data.properties,'irc-native-point','IRC原生Point Number',value,line.number,undefined,pointFooter[1]);
      this.field(this.data.properties,'irc-native-path','IRC原生Path Number',nativePath,line.number,undefined,pointFooter[2]);
      if(value===0){this.current.pathDirection='ts';this.current.coordinate={value:0,unit:this.ircCoordinateUnit??'step',label:'IRC reaction coordinate'};}
      else{
        if(!this.ircBranch.frames.includes(this.current.index))this.ircBranch.frames.push(this.current.index);
        const confirmed=this.ircBranch.direction??this.direction;
        if(confirmed)this.current.pathDirection=confirmed;
      }
    }
    const node = pathContext&&!pointFooter ? text.match(/^\s*(?:Point Number|Scan point)\s*[:=]?\s*(\d+)(?:\s+Path Number\s*[:=]?\s*\d+|\s+in\s+(?:FORWARD|REVERSE)\s+path direction\.?)?\s*$/i) : null;
    if (node) {
      const value = Number(node[1]);
      const currentPointSummary = /Point Number\s*:.*Path Number/i.test(text) && this.current?.pathNode === value;
      if (currentPointSummary && this.current) this.current.pathPoint = true;
      else this.calculationBoundary();
      this.node = value;
    }
    const summaryNode = pathContext ? text.match(/^\s*Summary for point\s+(\d+)(?:\s+in\s+(?:FORWARD|REVERSE)\s+path direction\.?)?\s*$/i) : null;
    if (summaryNode && this.current) {
      this.node = Number(summaryNode[1]);
      if (this.node >= 0) this.current.pathNode = this.node;
      this.current.pathPoint = true;
      this.current.label = `${this.data.tasks.includes('irc') ? 'IRC' : '扫描'}节点 ${this.node}${this.current.sourceStep === null ? '' : ` / 优化步 ${this.current.sourceStep}`}`;
    }
    if (/Summary of (?:the )?Optimized Potential Surface Scan|ModRedundant.*\bScan\b/i.test(text) && !this.data.tasks.includes('scan')) this.data.tasks.push('scan');
    const ircBegin=this.data.tasks.includes('irc')?text.match(/^\s*Beginning calculation of (?:the )?(FORWARD|REVERSE) path\.\s*$/i):null;
    const ircComplete=this.data.tasks.includes('irc')?text.match(/^\s*Calculation of (FORWARD|REVERSE) path complete\.\s*$/i):null;
    if(ircBegin&&this.ordinaryIrc){
      this.calculationBoundary();this.node=null;
      const next=ircBegin[1].toLowerCase() as 'forward'|'reverse';
      this.ircBranch={nativePath:null,frames:[],direction:next};this.bindIrcBranch(next,line);
    }
    if(ircComplete&&this.ordinaryIrc)this.bindIrcBranch(ircComplete[1].toLowerCase() as 'forward'|'reverse',line);
    const direction = /FORWARD direction|forward path/i.test(text) ? 'forward' : /REVERSE direction|reverse path/i.test(text) ? 'reverse' : undefined;
    if (direction && direction !== this.direction) {
      if (summaryNode && this.current) { this.direction = direction; this.current.pathDirection = direction; }
      else if(!ircComplete) { this.calculationBoundary(); this.direction = direction; }
    }
    const pathNumber = text.match(/Path Number\s*[:=]?\s*(\d+)/i);
    if (pathNumber && !pointFooter && !this.direction) this.notice(`IRC打印Path Number ${pathNumber[1]}，但未出现明确forward/reverse方向标签。`);
    const coordinate = text.match(new RegExp(`(?:NET REACTION COORDINATE UP TO THIS POINT|Reaction coordinate)\\s*[:=]?\\s*(${N})(?:\\s+([^\\s]+))?`, 'i'));
    if (coordinate) { const value = scientificNumber(coordinate[1]); if (value !== null) { this.coordinate = { value: this.direction === 'reverse' ? -Math.abs(value) : value, sourceValue: value, unit: coordinate[2] ?? this.ircCoordinateUnit ?? 'printed (unit unspecified)', label: 'IRC reaction coordinate (source branch direction)' }; if (this.current) this.current.coordinate = { ...this.coordinate }; } }
    if (/^\s*(?:--\s*)?(?:Optimization completed|Stationary point found)\b/i.test(text)) {
      this.optimized=true;this.optimizationGeometrySourceLine=this.current?.geometry.line??null;
      if(this.current&&this.data.tasks.includes('scan'))this.current.pathPoint=true;
      this.field(this.data.summary,'optimization-completed','优化收敛标记',text.trim(),line.number);
      if(this.data.tasks.includes('irc')||this.data.tasks.includes('scan'))this.completeTask('optimization',`${this.data.tasks.includes('irc')?'irc':'scan'}-node-${this.node??'unknown'}`,line);
      else{if(this.data.tasks.includes('opt'))this.completeTask('opt','geometry-optimization',line);if(this.data.tasks.includes('ts'))this.completeTask('ts','ts-optimization',line);}
    }
    if(this.data.tasks.includes('irc')){
      if(/^\s*Maximum number of steps reached\.\s*$/i.test(text)){
        this.ircPathLimited=true;
        const event:ScientificDiagnostics['tasks'][number]={task:'path',stageId:this.ircBranch?.direction?'irc-'+this.ircBranch.direction:this.direction?'irc-'+this.direction:'irc-path-'+(this.ircBranch?.nativePath??'unknown'),status:'not-converged',sourceLine:line.number,frameIndex:this.current?.index??null,raw:text.trim()};
        this.diagnostics().tasks.push(event);if(this.ircBranch)this.ircBranch.limit=event;
      }
      const overall=/^\s*(?:Reaction path calculation complete|Calculation of (?:the )?reaction path complete)\.\s*$/i.test(text);
      if(ircComplete||overall){
        if(this.ordinaryIrc){const field=this.field(this.data.summary,'irc-printing-complete','IRC原生流程闭合原文',text.trim(),line.number);if(field)field.frameIndex=null;}
        if(ircComplete&&!this.diagnostics().tasks.some(event=>event.task==='path'&&event.stageId==='irc-'+ircComplete[1].toLowerCase()&&event.status==='not-converged'))this.completeTask('path','irc-'+ircComplete[1].toLowerCase(),line);
        if(overall){
          if(!this.ircPathLimited)this.completeTask('irc','reaction-path',line);
          else this.diagnostics().tasks.push({task:'irc',stageId:'reaction-path',status:'not-converged',sourceLine:line.number,frameIndex:null,raw:text.trim()});
        }
      }
      const reference=text.match(new RegExp(`^\\s*Energies reported relative to the TS energy of\\s+(${N})\\s*$`,'i'));
      if(reference){const value=scientificNumber(reference[1]);if(value!==null){
        this.ircSummaryReference={value,rawValue:reference[1],sourceLine:line.number,unit:'hartree'};
        const field=this.field(this.data.summary,'irc-summary-ts-energy-reference','IRC汇总原生TS能量基准',value,line.number,'hartree',reference[1]);if(field)field.frameIndex=null;
      }}
      if(/^\s*Summary of reaction path following\s*$/i.test(text)){this.ircSummary='header';this.snapshotIrcSummaryLine=line.number;}
      else if(this.ircSummary==='header'&&/^\s*Energy\s+RxCoord\s*$/i.test(text))this.ircSummary='rows';
      else if(this.ircSummary==='rows'){
        const row=text.match(new RegExp(`^\\s*(\\d+)\\s+(${N})\\s+(${N})\\s*$`));
        if(row&&this.ircSummaryReference){const energy=scientificNumber(row[2]),coordinate=scientificNumber(row[3]);
          if(energy!==null&&coordinate!==null&&this.count()&&this.metadata(row[2].length+row[3].length,line.number)){
            const [mantissa,exponent='0']=row[2].replace(/[dD]/,'e').toLowerCase().split('e'),decimals=mantissa.includes('.')?mantissa.length-mantissa.indexOf('.')-1:0;
            (this.data.pathSummary??=[]).push({kind:'irc',sourceNode:Number(row[1]),sourceLine:line.number,energy,rawEnergy:row[2],energyRounding:.5*10**(Number(exponent)-decimals),energyReference:'relative-to-ts',referenceEnergy:this.ircSummaryReference,unit:'hartree',...(energy===0&&coordinate===0?{isTs:true}:{}),coordinate:{value:coordinate,unit:this.ircCoordinateUnit??'printed (unit unspecified)',label:'IRC reaction coordinate (printed summary)'}});
          }
        }else if(text.trim()){this.ircSummary=null;this.snapshotIrcSummaryLine=null;}
      }
    }
    // Native aborts differ from Gaussian's ordinary Error termination footer.
    // A bare phrase can be an input title/echo; require an accepted geometry
    // and the immediately following native dump before declaring failure.
    if(this.current&&/^\s*Error:\s+(?:software termination|hangup)\s*$/i.test(text))this.pendingNativeTermination={sourceLine:line.number,text:text.trim()};
    if(/^\s*QPErr\s+---/i.test(text))this.error('input-syntax',line);
    if (/^\s*(?:Error termination\b|Convergence failure\b|Optimization stopped\b|Number of steps exceeded\b)/i.test(text)) {
      this.failed = true; this.messages.add(text.trim());
      const nativeTermination=/^\s*Error termination\b/i.test(text);
      this.error(nativeTermination?'native-termination':/^\s*Convergence failure\b/i.test(text)?'scf-convergence':'optimization-convergence',line);
      if(nativeTermination)this.diagnostics().termination={status:'error',sourceLine:line.number,raw:text.trim()};
      if(/^\s*Convergence failure\b/i.test(text)){this.scfAttemptFailed=true;this.scfDiagnostic('not-converged',line);}
      if(/^\s*(?:Optimization stopped\b|Number of steps exceeded\b)/i.test(text)){
        const task=this.data.tasks.includes('ts')?'ts':this.data.tasks.includes('opt')?'opt':this.data.tasks.includes('irc')?'irc':'unknown';
        this.diagnostics().tasks.push({task,status:'not-converged',sourceLine:line.number,frameIndex:this.current?.index??null,raw:text.trim()});
      }
    }
    if (/^\s*Normal termination of Gaussian\b/.test(text)) { this.flushTables(); this.terminated = true;
      // Contradictory native termination remains explicit error evidence.
      if(this.diagnostics().termination.status!=='error')this.diagnostics().termination={status:'normal',sourceLine:line.number,raw:text.trim()};return; }
    const dispersion=text.match(new RegExp(`^\\s*R6Disp:\\s*(Grimme-D[23](?:\\(BJ\\))?)\\s+Dispersion energy\\s*=\\s*(${N})\\s+Hartrees?\\.?\\s*$`,'i'));
    if(dispersion){const value=scientificNumber(dispersion[2]);if(value!==null)this.field(this.data.properties,'gaussian-dispersion-correction',`Gaussian ${dispersion[1]} dispersion correction (printed)`,value,line.number,'hartree',dispersion[2]);}
    const convergence = text.match(new RegExp(`^\\s*(Maximum Force|RMS Force|Maximum Displacement|RMS Displacement)\\s+(${N})\\s+(${N})\\s+(YES|NO)`, 'i'));
    if (convergence && this.current) {
      const value = scientificNumber(convergence[2]), threshold = scientificNumber(convergence[3]);
      if (value !== null && threshold !== null && this.count()) this.current.convergence.push({ label: convergence[1], value, threshold, converged: convergence[4].toUpperCase() === 'YES', unit: /Force/i.test(convergence[1]) ? 'hartree/bohr' : 'bohr' });
    }
    const iteration = text.match(/^\s*Cycle\s+(\d+)\s+Pass\s+/);
    if (iteration) {
      if (this.pendingFinalReprint) { this.pendingFinalReprint = null; this.calculationEpoch++; }
      this.cycleIteration = Number(iteration[1]);
      if(this.cycleIteration===1){this.scfAttemptFailed=false;this.cycle=null;}
    }
    // XQC starts a new native attempt after the failed conventional SCF. Its
    // energy and later job termination remain independent observations.
    if(/^\s*Quadratic Convergence SCF Method\.\s*$/.test(text)){
      this.scfAttemptFailed=false;this.cycle=null;this.cycleIteration=null;
    }
    if(/^\s*>{2,}\s+Convergence criterion not met\.\s*$/.test(text)){
      this.scfAttemptFailed=true;this.scfDiagnostic('not-converged',line);
    }
    const scfPoint = text.match(new RegExp(`^\\s*E=\\s*(${N})\\s+Delta-E=\\s*(${N})`));
    if (scfPoint && this.cycleIteration !== null) {
      if(this.cpNonfull()){
        this.field(this.data.bsse,this.cpPrefix()+`scf-cycle-${this.cycleIteration}-energy-${line.number}`,this.cpLabel()+` · SCF iteration ${this.cycleIteration} energy`,scientificNumber(scfPoint[1])!,line.number,'hartree',scfPoint[1]);
        this.field(this.data.bsse,this.cpPrefix()+`scf-cycle-${this.cycleIteration}-delta-${line.number}`,this.cpLabel()+` · SCF iteration ${this.cycleIteration} delta E`,scientificNumber(scfPoint[2])!,line.number,'hartree',scfPoint[2]);
        this.cycleIteration=null;return;
      }
      if (this.count()) {
        if (!this.cycle) { this.cycle = { frameIndex: this.current?.index ?? null, sourceLine: line.number, unit:'hartree', deltaEnergyUnit:'hartree', points: [] }; this.data.scfCycles.push(this.cycle); }
        this.cycle.points.push({ iteration: this.cycleIteration, energy: scientificNumber(scfPoint[1]), deltaEnergy: scientificNumber(scfPoint[2]), rawEnergy:scfPoint[1], rawDeltaEnergy:scfPoint[2], sourceLine:line.number });
      }
      this.cycleIteration = null;
    }
    const scf = text.match(new RegExp(`SCF Done:\\s+E\\(([^)]+)\\)\\s*=\\s*(${N})`));
    if (scf) {
      if(this.cpNonfull()&&this.current){this.cpCandidateFrame=this.current.index;this.current=null;}
      if(!this.scfAttemptFailed)this.scfDiagnostic('converged',line);
      const printedCycles=text.match(/\bafter\s+(\d+)\s+cycles\b/i);
      if(printedCycles&&Number.isSafeInteger(Number(printedCycles[1])))this.field(this.data.summary,'scf-iterations','SCF cycles (printed)',Number(printedCycles[1]),line.number,undefined,printedCycles[1]);
      this.pendingFinalReprint = null;
      if (this.optimized) this.calculationEpoch++;
      this.scfChannel = /^RO/i.test(scf[1]) ? 'restricted-open' : /^R/i.test(scf[1]) ? 'restricted' : /^U/i.test(scf[1]) ? 'unrestricted' : 'unknown';
      if (this.scfChannel !== 'unknown'&&!this.cpNonfull()) {
        if (!this.data.reference) this.data.reference = this.scfChannel;
        else if (this.data.reference !== this.scfChannel) { this.data.reference = 'unknown'; this.notice('本段打印了不同SCF参考态；全局参考态未知，保留逐帧reference-state来源。'); }
      }
      const value = scientificNumber(scf[2]);
      if (value !== null) {
        const field=this.field(this.data.properties,'scf-energy',`SCF E(${scf[1]})`,value,line.number,'hartree',scf[2]);
        if(field&&this.cpComponent?.role==='full-system'&&this.metadata(scf[2].length,line.number))this.data.bsse.push({...field,key:this.cpPrefix()+'scf-energy',label:this.cpLabel()+' · native SCF total (same observation as complex)',frameIndex:this.current?.index??null});
        if(this.current&&(this.target==='scf'||this.target==='semiempirical')){this.current.energy={value,unit:'hartree'};this.targetSource={sourceLine:line.number,frameIndex:this.current.index,rawValue:scf[2]};}
      }
      if(this.cpComponent)this.cpMeta('scf-status','原生SCF完成标记',this.scfAttemptFailed?'not-converged':'converged',line.number,'observation');
      if (this.scfChannel !== 'unknown') this.field(this.data.properties, 'reference-state', 'SCF reference (printed)', this.scfChannel, line.number);
      this.frameObserved = true; this.cycle = null; this.cycleIteration = null;
    }
    const externalRoute=/\bexternal\b/i.test(this.data.route);
    if(externalRoute){
      // These are observations of the interface's printed output, not a new
      // method identity inferred from a script filename or a target-energy sum.
      const command=text.match(/^\s*(Running external command\s+.+|Running:\s+.+)$/);
      if(command)this.field(this.data.properties,/^Running:/.test(command[1])?'external-printed-command':'external-driver-command','External printed command',command[1],line.number);
      const recovered=text.match(new RegExp(`^\\s*Recovered energy=\\s*(${N})\\s+dipole=`,'i'));
      if(recovered){const value=scientificNumber(recovered[1]);if(value!==null)this.field(this.data.properties,'external-recovered-energy','External interface returned energy (printed)',value,line.number,'hartree',recovered[1]);}
    }
    const externalEnergy = (externalRoute||this.target==='semiempirical') && this.current
      ? text.match(new RegExp(`^\\s*Energy=\\s*(${N})\\s+NIter=\\s*\\d+\\.?\\s*$`, 'i')) : null;
    if (externalEnergy) {
      const value = scientificNumber(externalEnergy[1]);
      if (value !== null) {
        this.field(this.data.properties, 'target-energy', this.target==='semiempirical'?'Semiempirical electronic energy':'External electronic energy', value, line.number, 'hartree', externalEnergy[1]);
        this.current!.energy = { value, unit: 'hartree' };
        this.targetSource = { sourceLine: line.number, frameIndex: this.current!.index, rawValue: externalEnergy[1] };
        this.frameObserved = true;
      }
    }
    const correlated = text.match(new RegExp(`(?:EUMP2|E\\(RMP2\\)|E\\(UMP2\\)|CCSD\\(T\\)|E\\(CCSD\\)|E\\(QCISD\\)|E\\(Corr\\)|Total Energy, E\\([^)]*\\))\\s*=\\s*(${N})`, 'i'));
    if (correlated) {
      if (this.pendingFinalReprint) { this.pendingFinalReprint = null; this.calculationEpoch++; }
      const value = scientificNumber(correlated[1]), key = correlated[0].split('=')[0].trim();
      if (value !== null) {
        this.field(this.data.properties, `energy-${key}`, key, value, line.number, 'hartree',correlated[1]);
        const eligible = this.target === 'mp2' && /MP2/i.test(key) || this.target === 'ccsd(t)' && /CCSD\(T\)/i.test(key) || this.target === 'ccsd' && /E\(CCSD\)|E\(Corr\)/i.test(key) || this.target === 'qcisd' && /E\(QCISD\)|E\(Corr\)/i.test(key) || this.target === 'td' && /Total Energy, E/i.test(key);
        if (eligible && this.current) { this.current.energy = { value, unit: 'hartree' }; this.targetSource = { sourceLine: line.number, frameIndex: this.current.index,rawValue:correlated[1] }; }
      }
      this.frameObserved = true;
    }
    const orbital = text.match(/^\s*(Alpha|Beta)\s+(occ\.|virt\.)\s+eigenvalues\s*--\s*(.+)$/i);
    if (orbital) {
      const values = orbitalNumbers(orbital[3]);
      if (!values) { this.notice('轨道能量行含无效数值，未补值。'); return; }
      this.orbitalSet ??= {};
      const spin = orbital[1].toLowerCase() as 'alpha' | 'beta';
      const previous = this.orbitalSet[spin];
      if (previous && orbital[2].toLowerCase() === 'occ.' && previous.orbitals.some(item => !item.occupation)) { this.flushOrbitals(); this.orbitalSet = {}; }
      if (!this.count(values.length, line.number, !this.orbitalSetLimited)) { this.orbitalSetLimited = true; return; }
      const channel = this.orbitalSet[spin] ??= { spin, frameIndex: this.current?.index ?? null, sourceLine: line.number, orbitals: [], unit: 'hartree' };
      if(this.cpNonfull())this.cpOrbitalTokens.set(channel,[...(this.cpOrbitalTokens.get(channel)??[]),...(orbital[3].match(new RegExp(N,'g'))??[])]);
      values.forEach(value => channel.orbitals.push({ index: channel.orbitals.length + 1, energy: value, occupation: orbital[2].toLowerCase() === 'occ.' ? 1 : 0,sourceLine:line.number })); return;
    }
    if (this.orbitalSet && !orbital) this.flushOrbitals();
    if (this.dipoleNext) {
      this.dipoleNext = false;
      const dipole = text.match(new RegExp(`X=\\s*(${N})\\s+Y=\\s*(${N})\\s+Z=\\s*(${N})\\s+Tot=\\s*(${N})`));
      if (dipole) ['x', 'y', 'z', 'total'].forEach((axis, index) => { const value = scientificNumber(dipole[index + 1]); if (value !== null) this.field(this.data.properties, `dipole-${axis}`, `Dipole ${axis} (printed)`, value, line.number, 'Debye'); });
    }
    if (/^\s*Dipole moment.*Debye/i.test(text)) this.dipoleNext = true;
    // Gaussian's compact dipole record is in atomic units, including records
    // with adjacent signed D-exponent values (e.g. "...D-01-...D-01").
    const compactDipole = this.current ? text.match(new RegExp(`^\\s*Dipole\\s*=\\s*(${N})\\s*(${N})\\s*(${N})\\s*$`, 'i')) : null;
    if (compactDipole) ['x', 'y', 'z'].forEach((axis, index) => {
      const value = scientificNumber(compactDipole[index + 1]);
      if (value !== null) this.field(this.data.properties, `dipole-${axis}-au`, `Dipole ${axis} (atomic units)`, value, line.number, 'e·bohr', compactDipole[index + 1]);
    });
    const polarizability = text.match(new RegExp(`Isotropic polarizability for W=\\s*(${N})\\s+(${N})\\s+Bohr\\*\\*3`, 'i'));
    if (polarizability) { const value = scientificNumber(polarizability[2]), w = scientificNumber(polarizability[1]); if (value !== null) this.field(this.data.properties, 'polarizability-isotropic', `Isotropic polarizability (printed W=${w})`, value, line.number, 'bohr^3'); }
    const atomHeader = text.match(/^\s*(Mulliken charges(?: and spin densities)?|Mulliken atomic charges|ESP charges|Hirshfeld charges(?:, spin densities.*)?|Summary of Natural Population Analysis)\s*:?\s*$/i);
    if (atomHeader) {
      this.flushAtoms(); const header = atomHeader[1];
      const scheme = /Natural/i.test(header) ? 'NPA' : /Hirshfeld/i.test(header) ? 'Hirshfeld' : /ESP/i.test(header) ? 'ESP' : /spin/i.test(header) ? 'Mulliken charge and spin' : 'Mulliken';
      this.atomTable = { kind: 'charge', scheme, sourceLine: line.number, frameIndex: this.current?.index ?? null, values: [], spins: [], rows: false, skipped: 0,...(this.cpNonfull()?{cp:true}:{}) }; return;
    }
    const shielding = text.match(new RegExp(`^\\s*(\\d+)\\s+([A-Za-z]{1,2})\\s+Isotropic\\s*=\\s*(${N})`, 'i'));
    if (shielding) {
      this.finishShieldingTensor();
      this.task('nmr');
      const index = Number(shielding[1]) - 1, value = scientificNumber(shielding[3]);
      let element: string | null = null; try { element = elementSymbol(shielding[2]); } catch { /* below */ }
      if (value !== null && this.current && index >= 0 && element === this.current.geometry.elements[index]) {
        this.shielding ??= { kind: 'shielding', scheme: 'Gaussian isotropic shielding', frameIndex: this.current.index, sourceLine: line.number, values: [], unit: 'ppm' };
        if (index === this.shielding.values.length) this.shielding.values.push({ atomIndex: index, element, value }); else this.notice('NMR原子屏蔽表编号重复或不连续，未合并。');
        const anisotropy=text.match(new RegExp(`Anisotropy\\s*=\\s*(${N})`,'i'));
        if(anisotropy){const field=this.field(this.data.properties,`nmr-shielding-${index+1}-anisotropy`,`${this.shieldingHeader?.label??'NMR shielding (unit unconfirmed)'} · source nucleus ${index+1} ${element} anisotropy`,scientificNumber(anisotropy[1])!,line.number,this.shieldingHeader?.unit,anisotropy[1]);if(field)field.origin='observation';}
        this.shieldingTensor={atomIndex:index,element,frameIndex:this.current.index,sourceLine:line.number,components:new Set()};
      } else this.notice('NMR屏蔽原子与当前结构不一致，未绑定。');
      return;
    }
    if (/^\s*Harmonic frequencies\b/i.test(text)) {
      this.flushModes(); this.newFrequencyAnalysis = true; this.printedModeIndices = null; this.frequencyScale = undefined;
    }
    const modeIndices = numbers(text); if (modeIndices && modeIndices.length <= 3 && modeIndices.every(value => Number.isSafeInteger(value) && value > 0)) this.printedModeIndices = modeIndices;
    const frequencies = text.match(/^\s*Frequencies\s+--\s*(.+)$/);
    if (frequencies) {
      this.task('freq');
      this.flushModes(); const values = numbers(frequencies[1]);
      if (!values || !values.length || values.length > 3) { this.notice('不支持或无效的Gaussian频率列，未补值。'); return; }
      const frameIndex = this.current?.index ?? null;
      const previous = this.data.vibrations;
      const restartingIndices = this.printedModeIndices?.length === values.length && previous?.modes.length
        && this.printedModeIndices[0] <= previous.modes[previous.modes.length - 1].index;
      if (restartingIndices && !this.newFrequencyAnalysis) this.frequencyScale = undefined;
      const newGroup = !previous || previous.frameIndex !== frameIndex || this.newFrequencyAnalysis || restartingIndices;
      if (!this.count(values.length + (newGroup ? 1 : 0), line.number)) { this.printedModeIndices = null; return; }
      if (newGroup) {
        // Geometry and source mode numbering establish independent analyses;
        // successive three-column prints continue within the same group.
        this.data.vibrations = { frameIndex, modes: [], convention: 'Gaussian printed Cartesian displacements; raw printed frequencies (cm^-1), no rescaling', electronicTarget:this.frequencyTarget(), ...(this.frequencyScale === undefined ? {} : { printedScaleFactor: this.frequencyScale }) };
        this.data.vibrationSets ??= []; this.data.vibrationSets.push(this.data.vibrations);
      }
      this.newFrequencyAnalysis = false;
      const group = this.data.vibrations!;
      const start = group.modes.length;
      const indices = this.printedModeIndices?.length === values.length ? this.printedModeIndices : values.map((_, index) => start + index + 1);
      const modes: VibrationMode[] = values.map((frequency, index) => ({ index: indices[index], sourceIndex: indices[index], frequency, sourceLine: line.number, displacementConvention: 'cartesian', ...(this.current ? { atomElements: this.current.geometry.elements } : {}) }));
      group.modes.push(...modes); this.printedModeIndices = null;
      this.modeBlock = { modes, frameIndex, rows: [], readingRows: false, invalid: false, age: 0 }; return;
    }
    const scale = text.match(new RegExp(`(?:frequency|frequencies) scale factor\\s*[:=]\\s*(${N})`, 'i'));
    if (scale) { const value = scientificNumber(scale[1]); if (value !== null) { this.frequencyScale = value; if (this.data.vibrations && !this.newFrequencyAnalysis) this.data.vibrations.printedScaleFactor = value; } }
    const thermo = text.match(new RegExp(`^\\s*(Zero-point correction|Thermal correction to Energy|Thermal correction to Enthalpy|Thermal correction to Gibbs Free Energy|Sum of electronic and zero-point Energies|Sum of electronic and thermal Energies|Sum of electronic and thermal Enthalpies|Sum of electronic and thermal Free Energies)\\s*=\\s*(${N})`, 'i'));
    if (thermo) { const value = scientificNumber(thermo[2]); if (value !== null) this.field(this.data.thermochemistry, thermo[1].toLowerCase().replace(/\s+/g, '-'), thermo[1], value, line.number, 'hartree',thermo[2]); }
    const tempPressure = text.match(new RegExp(`Temperature\\s+(${N})\\s+Kelvin\\.\\s+Pressure\\s+(${N})\\s+Atm`, 'i'));
    if (tempPressure) { const temp = scientificNumber(tempPressure[1]), pressure = scientificNumber(tempPressure[2]); if (temp !== null) this.field(this.data.thermochemistry, 'temperature', 'Temperature (printed)', temp, line.number, 'K',tempPressure[1]); if (pressure !== null) this.field(this.data.thermochemistry, 'pressure', 'Pressure (printed)', pressure, line.number, 'atm',tempPressure[2]); }
    if (/E \(Thermal\)\s+CV\s+S/.test(text)) this.thermalTable = true;
    if (this.thermalTable) {
      const row = text.match(new RegExp(`^\\s*(Total|Electronic|Translational|Rotational|Vibrational)\\s+(${N})\\s+(${N})\\s+(${N})\\s*$`));
      if (row) ['energy', 'cv', 'entropy'].forEach((quantity, index) => { const value = scientificNumber(row[index + 2]); if (value !== null) this.field(this.data.thermochemistry, `${row[1].toLowerCase()}-${quantity}`, `${row[1]} ${quantity} (printed)`, value, line.number, index === 0 ? 'kcal/mol' : 'cal/mol/K',row[index+2]); });
      else if (/Q\s+Log10\(Q\)/.test(text)) this.thermalTable = false;
    }
    const excited = text.match(new RegExp(`Excited State\\s+(\\d+):\\s+(.+?)\\s+(${N})\\s+eV(?:\\s+(${N})\\s+nm)?(?:\\s+f=\\s*(${N}))?(?:\\s+<S\\*\\*2>=\\s*(${N}))?`, 'i'));
    if (excited) {
      this.task('td');
      const energyEv = scientificNumber(excited[3]);
      this.excited = null; this.excitedSuppressed = false;
      if (energyEv !== null) {
        if (!this.count()) { this.excitedSuppressed = true; return; }
        this.excited = { index: Number(excited[1]), label: excited[2].trim(), multiplicity: excited[2].match(/Singlet|Triplet|Doublet|Quartet/i)?.[0] ?? null, frameIndex: this.current?.index ?? null, energyEv, sourceLine: line.number, transitions: [],
          ...(excited[4] ? { wavelengthNm: scientificNumber(excited[4])! } : {}), ...(excited[5] ? { oscillatorStrength: scientificNumber(excited[5])! } : {}), ...(excited[6] ? { spinSquared: scientificNumber(excited[6])! } : {}) };
        this.data.excitedStates.push(this.excited);
      }
      return;
    }
    if(/This state for optimization and\/or second-order correction/i.test(text)&&this.excited)this.selectedFrequencyState={state:this.excited,sourceLine:line.number};
    const transition = text.match(new RegExp(`^\\s*(\\d+[ABab]?)\\s*(->|<-)\\s*(\\d+[ABab]?)\\s+(${N})\\s*$`));
    if (transition && (this.excited || this.excitedSuppressed)) { const amplitude = scientificNumber(transition[4]); if (amplitude !== null && this.count(1, line.number, !!this.excited)) { const from = transition[2] === '->' ? transition[1] : transition[3], to = transition[2] === '->' ? transition[3] : transition[1]; const a = /A$/i.test(from), b = /B$/i.test(from); this.excited!.transitions.push({ from, to, direction:transition[2] as '->'|'<-',amplitude, sourceLine: line.number, ...(a || b ? { spin: a ? 'alpha' : 'beta' } : {}) }); } }
    else if (text.trim()) { this.excited = null; this.excitedSuppressed = false; }
    if (/wavefunction is (?:stable|unstable)|internal instability|external instability/i.test(text)) {
      this.task('stability');this.field(this.data.stability,'stability','打印的波函数稳定性',text.trim(),line.number);
      if(/^\s*The wavefunction (?:is (?:stable|unstable)(?: under the perturbations considered)?|has an? (?:internal|external) instability)\.\s*$/i.test(text))this.completeTask('stability','stability-analysis',line);
    }
    const bsse=text.match(new RegExp(`^\\s*(Counterpoise(?:\\s*:)?\\s+corrected energy|Counterpoise:\\s*BSSE energy|(?:Counterpoise:\\s*)?sum of fragments|BSSE energy|Complexation energy(?:\\s*\\([^)]*\\))?)\\s*(?:=|:)\\s*(${N})(.*)$`,'i'));
    if(bsse){
      this.flushTables();this.finishCpComponent(line.number-1);this.cpComponent=null;this.cpFinished=true;this.task('bsse');
      const value=scientificNumber(bsse[2]);if(value!==null){
        let label=bsse[1].trim().replace(/\s+/g,' '),key=label.toLowerCase().replace(/\s+/g,'-').replace(/^counterpoise:-/,'');
        const qualifier=(bsse[3].match(/\((raw|corrected)\)/i)?.[1]??label.match(/\((raw|corrected)\)/i)?.[1])?.toLowerCase();
        if(/^complexation energy/i.test(label)&&qualifier){if(!/\((raw|corrected)\)/i.test(label))label+=` (${qualifier})`;key='complexation-energy-'+qualifier;}
        const field=this.field(this.data.bsse,key,label,value,line.number,/kcal/i.test(bsse[3])?'kcal/mol':'hartree',bsse[2]);if(field)field.frameIndex=null;
        this.notice('CP组件能量、校正总能、BSSE及raw/corrected相互作用分别保留；打印汇总不覆盖complex原SCF目标能量。');
      }
    }
    const spin = text.match(new RegExp(`S\\*\\*2 before annihilation\\s+(${N}),?\\s+after\\s+(${N})`, 'i'));
    if (spin) { const before = scientificNumber(spin[1]), after = scientificNumber(spin[2]); if (before !== null) this.field(this.data.properties, 's2-before', 'S² before annihilation', before, line.number); if (after !== null) this.field(this.data.properties, 's2-after', 'S² after annihilation', after, line.number); }
  }

  /** No EOF flush, title replay, archive, completion inference or parser mutation. */
  peek(): ScientificParserSnapshot {
    if (!this.snapshotState) throw new Error('Gaussian持续快照须在读取前显式启用。');
    const opened = [this.block ? this.snapshotGeometryLine ?? this.block.line : undefined, this.atomTable?.sourceLine, this.shielding?.sourceLine,
      this.shieldingTensor?.sourceLine, this.coupling?.line.number, this.cycle?.sourceLine,
      this.excited?.sourceLine, this.orbitalSet?.alpha?.sourceLine, this.orbitalSet?.beta?.sourceLine,
      this.modeBlock?.modes[0]?.sourceLine, this.pendingFinalReprint?.line,this.snapshotIrcSummaryLine??undefined,
      ...(this.routeCapture ? [this.routeSourceLine] : [])].filter((line): line is number => typeof line === 'number' && line > 0);
    const beforeLine = opened.length ? Math.min(...opened) : undefined;
    // A final reprint can withhold a prefix that ends before the already
    // observed footer. Publish completion only with its normal-termination
    // evidence in this same projection; do not mutate the underlying job.
    const termination=this.data.diagnostics?.termination;
    const publishedTermination=termination?.status==='normal'&&termination.sourceLine!==undefined&&(beforeLine===undefined||termination.sourceLine<beforeLine);
    const hasEvidence = Boolean(this.seenIdentity || this.frames.length || this.data.route || this.data.version || this.failed || this.terminated || this.data.properties.length || this.data.bsse.length);
    const needsOpt = this.data.tasks.includes('opt') && !this.data.tasks.some(task => task === 'irc' || task === 'scan');
    const active: ScientificJob | null = !this.finished && hasEvidence ? {
      engine: 'gaussian', jobIndex: this.jobIndex, segmentIndex: this.segmentIndex, charge: this.charge, multiplicity: this.multiplicity,
      status: this.failed ? 'failed' : this.terminated && publishedTermination && !this.ircPathLimited && !this.damaged && !this.unsupportedGeometry && (!needsOpt || this.optimized) ? 'completed' : 'incomplete',
      frames: this.frames, data: this.routeCapture ? { ...this.data, route: '', printedRoute: '', tasks: [] } : this.data, messages: [...this.messages]
    } : null;
    return this.snapshotState.snapshot(this.jobs, active, this.lastLine, {
      ...(beforeLine === undefined ? {} : { beforeLine }),
      mutableSubtrees: [this.current, this.data.vibrations, this.data.readLimits].filter((item): item is NonNullable<typeof item> => !!item),
      withheld: [this.cycle, this.excited, ...(this.modeBlock && this.data.vibrations ? [this.data.vibrations] : []),...(this.ircSummary&&this.data.pathSummary?[this.data.pathSummary]:[])].filter((item): item is NonNullable<typeof item> => !!item)
    });
  }
  finish(): ScientificJob[] {
    if (!this.finished) { for(const line of this.outputTitle.finish())this.consumeOutput(line);this.archive(false); this.finished = true; }
    return this.jobs;
  }
}
