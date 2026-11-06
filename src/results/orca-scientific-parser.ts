import { atomicNumber, elementSymbol } from '../core/elements';
import { orcaNativeJobNumber, orcaSourceKeywords, orcaSourceLine } from '../core/orca/input-source';
import { parseOrcaInput, readOrcaInputCenters } from '../core/orca-readers';
import { OrcaAuTableReader, pairOrcaCenterTables, type OrcaAngCenter, type OrcaAuTable } from '../core/orca/output-centers';
import type { ResultConvergence } from './contracts';
import { mdNativeReferences, mdNativeTableLayout, parseMdNativeTableRow, type MdNativeTableLayout } from './md-aux-reader';
import { ScientificSnapshotState } from './scientific-snapshot';
import { createNmrCouplingBlock, emptyScientificData, emptyScientificDiagnostics, scientificRoundingInterval, scientificNumber as num, SCIENTIFIC_NUMBER as N, type AtomicProperty, type ExcitedState, type IndexedScientificFrame, type OrbitalChannel, type ScientificData, type ScientificField, type ScientificGeometry, type ScientificJob, type ScientificLine, type ScientificParser, type ScientificTask, type ScfCycle, type FrequencyElectronicTarget, type ScientificCenter, type NmrCouplingBlock, type NmrCouplingNucleus, type NmrCouplingValue, type RawCartesianModeComponent } from './scientific-contracts';


/** Validate exact counters while preserving all retained source records. */
export class OrcaStorageBudget {
  private indices = 0;
  private centers = 0;
  reserveIndices(amount = 1) {
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(this.indices + amount)) throw new Error('ORCA几何/诊断/路径索引计数无效。');
    this.indices += amount;
  }
  reserveCenters(amount = 1) {
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(this.centers + amount)) throw new Error('ORCA原子/特殊中心身份计数无效。');
    this.centers += amount;
  }
}
const dash = /^\s*[-=*]{3,}\s*$/;
// LEAN-SCF Debug prints numeric matrices between the iteration rows. Its
// native row has a decimal energy, exponent Delta-E and the complete header
// column count; a leading numeric prefix alone does not establish that role.
const leanScfRow = (remainingColumns: number) => new RegExp(`^([1-9]\\d*)\\s+([+-]?(?:\\d+\\.\\d*|\\.\\d+)(?:[EeDd][+-]?\\d+)?)\\s+([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)[EeDd][+-]?\\d+)(?:\\s+${N}){${remainingColumns}}$`);
const diisScfRow = leanScfRow(5), soscfScfRow = leanScfRow(4);
const thermalNames:Record<string,string>={
  'temperature':'温度 T','pressure':'压力 p','electronic energy':'电子能 E(el)',
  'zero point energy':'零点振动能 ZPE','thermal vibrational correction':'振动热修正',
  'thermal rotational correction':'转动热修正','thermal translational correction':'平动热修正',
  'total thermal energy':'内能 U','total thermal correction':'总热修正',
  'non-thermal (zpe) correction':'零点能修正 ZPE','total correction':'总能量修正',
  'thermal enthalpy correction':'焓热修正','total enthalpy':'焓 H',
  'electronic entropy':'电子熵项 TS(el)','vibrational entropy':'振动熵项 TS(vib)',
  'rotational entropy':'转动熵项 TS(rot)','translational entropy':'平动熵项 TS(trans)',
  'final entropy term':'总熵项 TS','total entropy correction':'熵修正 −TS',
  'final gibbs free energy':'吉布斯自由能 G','final gibbs free enthalpy':'吉布斯自由能 G',
  'g-e(el)':'吉布斯自由能修正 G−E(el)',
};
const thermalScalar=new RegExp(`^([A-Za-z][A-Za-z ()/+_-]*?)\\s*(?:\\.{2,}|:|=)?\\s+(${N})\\s+(Eh|hartree|K|atm|kcal/mol|cal/mol/K|J/mol/K)(?:\\s+${N}\\s+kcal/mol)?\\s*$`,'i');
function indexNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('ORCA序号不是有限安全整数，已停止读取。');
  return parsed;
}
type Section = 'none' | 'scf' | 'orbitals' | 'atomic' | 'frequencies' | 'modes' | 'ir' | 'raman' | 'shielding' | 'excited' | 'absorption' | 'simplified';
interface NebSaddleScalar { value: number; rawValue: string; line: ScientificLine }
interface NebSaddleEvidence { image?: NebSaddleScalar; energy?: NebSaddleScalar; force?: NebSaddleScalar }
interface GeometryBlock { start: number; end: number; line: number; elements: string[]; centers?: ScientificCenter[]; angRows?: OrcaAngCenter[]; bad: boolean; rounding?: number; saddle?: { header: ScientificLine; evidence: NebSaddleEvidence } }
interface Pending { geometry: ScientificGeometry; step: number | null; node: number | null; energy: number | null; convergence: ResultConvergence[]; label?: string; coordinate?: IndexedScientificFrame['coordinate']; direction?: IndexedScientificFrame['pathDirection']; stageId?: string; pathPoint?: boolean; pathIteration?: number; pathImage?: number }

/** Streaming ORCA output parser. Only the current coordinate block is retained;
 * frames share the immutable atom inventory and carry source byte ranges. */
/** Task requests from an ORCA route/input echo. This is evidence of requested
 * work only; it never certifies execution, convergence, or a result field. */
export function orcaScientificTasks(r:string,inferSinglePoint=true):ScientificTask[] {
  const tasks:ScientificTask[]=[],task=(value:ScientificTask)=>{if(!tasks.includes(value))tasks.push(value);};
  if (/\b(?:opt|tightopt|verytightopt|looseopt|tdopt)\b/i.test(r)) task('opt');
  if (/\boptts\b/i.test(r)) { task('opt'); task('ts'); }
  if (/\b(?:freq|anfreq|numfreq)\b/i.test(r)) task('freq');
  if (/\birc\b/i.test(r)) task('irc');
  if (/^\s*scan(?:\s|$)/im.test(r)) task('scan');
  if (/\b(?:NEB(?:-(?:CI|TS|IDPP|MMF(?:TS)?))?|CI-NEB)\b|%neb\b/i.test(r)) task('neb');
  if (/\bNEB-(?:TS|MMF(?:TS)?)\b/i.test(r)) task('ts');
  if (/\b(?:tddft|tda|tdopt)\b|%tddft/i.test(r)) task('td');
  if (/\b(?:nmr|shift|shielding)\b/i.test(r)) task('nmr');
  if (/\b(?:stab|stabperform|stability)\b/i.test(r)) task('stability');
  if (/\b(?:counterpoise|cp\(|bb-cp)\b/i.test(r)) task('bsse');
  if (/^\s*!.*\bMD\b|^\s*%md\b/im.test(r)) task('md');
  if (/\bESD\s*\(|^\s*%esd\b/im.test(r)) task('esd');
  const explicitSinglePoint=r.split(/\r?\n/).some(line=>/^\s*!/.test(line)
    && line.split('#',1)[0].replace(/^\s*!/,'').trim().split(/\s+/).some(token=>/^sp$/i.test(token)));
  if (!tasks.length&&explicitSinglePoint) task('sp');
  if (!tasks.length&&inferSinglePoint && /^\s*!/m.test(r)
    && /\b(?:U?R?HF|ROHF|UKS|RKS|B3LYP|PBE0|PBE|BP86|BLYP|M06(?:-2X)?|wB97X(?:-D[34]?)?|r2SCAN(?:-3c)?|XTB[12]?|GFN[12]-xTB|MP2|CCSD(?:\(T\))?)\b/i.test(r)) task('sp');
  return tasks;
}

export class OrcaScientificParser implements ScientificParser {
  private jobs: ScientificJob[] = [];
  private jobIndex = 0;
  private segmentIndex = 0;
  private data = emptyScientificData();
  private frames: IndexedScientificFrame[] = [];
  private pending: Pending | null = null;
  private block: GeometryBlock | null = null;
  private auReader = new OrcaAuTableReader();
  private auCandidate: { rows: OrcaAngCenter[]; geometry?: ScientificGeometry; centerCredit: number } | null = null;
  private mdNative = false;
  private mdHeader: string | null = null;
  private mdLayout: MdNativeTableLayout | null = null;
  private mdInTable = false;
  private mdTableStopped = false;
  private mdAvailability: NonNullable<ScientificData['diagnostics']>['fields'][number] | null = null;
  private inventory: string[] | null = null;
  private expected: number | null = null;
  private expectedWitness: { value: number; rawValue: string; sourceLine: number } | null = null;
  private charge: number | null = null;
  private multiplicity: number | null = null;
  private version: string | null = null;
  private terminated = false;
  private failed = false;
  private invalid = false;
  private optimized = false;
  private nebConverged = false;
  private numericalFrequency = false;
  private frequencyResults = false;
  private ircPhase = false;
  private ircIterationTable = false;
  private frequencySnapshot: FrequencyElectronicTarget | null = null;
  private frequencyMethod: FrequencyElectronicTarget['method'] = 'unknown';
  private frequencyRoot: {value:number;sourceLine:number;kind:'input-echo'|'printed';geometrySourceLine?:number} | null = null;
  private frequencyMultiplicity: number | null = null;
  private frequencyEvidence: FrequencyElectronicTarget['evidence'][number][] = [];
  private optimizationGeometrySourceLine: number | null = null;
  private targetEnergy: {value:number;sourceLine:number;geometrySourceLine:number} | null = null;
  private tdGradientGeometrySourceLine: number | null = null;
  private step: number | null = null;
  private node: number | null = null;
  private label: string | undefined;
  private coordinate: IndexedScientificFrame['coordinate'];
  private direction: IndexedScientificFrame['pathDirection'];
  private stageId: string | undefined;
  private nebIteration: number | undefined;
  private nebImage: number | undefined;
  private nebSaddleEvidence: NebSaddleEvidence | null = null;
  private section: Section = 'none';
  private scf: ScfCycle | null = null;
  private scfNativeRow: RegExp | null = null;
  private orbital: OrbitalChannel | null = null;
  private orbitalSpin: OrbitalChannel['spin'] = 'restricted';
  private atomic: AtomicProperty | null = null;
  private excited: ExcitedState | null = null;
  private excitedMultiplicity: string | null = null;
  private excitedMultiplicityEstimated = false;
  private absorptionColumns: { wavelength: number; oscillator: number; energy: number } | null = null;
  private absorptionEnergyUnit: 'cm^-1' | null = null;
  private excitationBatch: ExcitedState[] = [];
  private simplifiedMethod: 'sTDDFT' | 'sTDA' | null = null;
  private simplifiedRows: ExcitedState[] = [];
  private simplifiedStates = new WeakSet<ExcitedState>();
  private excitationWaveNumbers = new Map<ExcitedState, number>();
  private modeColumns: number[] = [];
  private modeVectors = new Map<number, Map<number, number>>();
  private modeRounding = new Map<number, number>();
  private modeRawVectors = new Map<number, RawCartesianModeComponent[]>();
  private modeAvailableIndices = new Set<number>();
  private modeRawAvailability: NonNullable<ScientificData['diagnostics']>['fields'][number] | null = null;
  private modeRawIncomplete = false;
  private modeTableSeen = false;
  private modesPending = false;
  private modeConventionLines: string[] = [];
  private thermo = false;
  private scfTotalContext = false;
  private nativeDftComponents: { sourceLine: number; raw: string } | null = null;
  private nativeFunctionalSettings = false;
  private nativeFunctionalKind: string | null = null;
  private nativeTdXcSettings = false;
  private stabilityContext = false;
  private bsseContext: 'bb-cp' | 'gcp' | null = null;
  private dipoleContext: { sourceLine: number; vectors: ScientificField[]; vectorUnit?: string; sawMagnitude: boolean } | null = null;
  private spectrumValueColumn: number | null = null;
  private irUnitHeaderPending = false;
  private irMomentColumn: number | null = null;
  private compoundStart: number | null = null;
  private compoundEnvelopeLine: ScientificLine | null = null;
  private nebTableColumns: string[] = [];
  constructor(private readonly storage = new OrcaStorageBudget(), snapshots = false) { if (snapshots) this.snapshotState = new ScientificSnapshotState(); }
  private metadataValues = 0;
  private messages = new Set<string>();
  private finished = false;
  private detached = false;
  private spectrumUnit: string | undefined;
  private ramanDynamic = false;
  private ramanExcitationWavelengthNm: number | undefined;
  private frequencyGroupAccepted = false;
  private referencedPathRole: 'neb-path' | null = null;
  private pathSummaryKind: 'irc' | 'neb' | null = null;
  private pathSummaryColumns = false;
  private observed = false;
  private jobMarkerObserved = false;
  private inputEchoJobs: ScientificLine[][] = [[]];
  private inputFileHeader = false;
  private inputEchoCharacters = 0;
  private inputEchoTruncated = false;
  private inputGeometryLines: ScientificLine[] | null = null;
  private replayingInput = false;
  private appliedInputJobs = new Set<number>();
  private lastSourceLine = 0;
  private parameterScan = false;
  private parameterPoint = false;
  private scanParameters = new Set<string>();
  private inputScanParameters = new Set<string>();
  private internalInput = false;
  private parameterUnits = new Map<string, 'degree' | null>();
  private cpcmParameters = false;
  private nmrActive = false;
  private nmrObserved = false;
  private nmrIncomplete = false;
  private nmrReduced = false;
  private nmrAvailability: NonNullable<ScientificData['diagnostics']>['fields'][number] | null = null;
  private nmrPair: NmrCouplingBlock | null = null;
  private nmrRaw: NmrCouplingBlock | null = null;
  private nmrPart: { block: NmrCouplingBlock | null; label: string; unit?: string; rawUnit?: string; sourceLine: number; rows: number; partial: boolean } | null = null;
  private nmrSummary: { label: string; unit?: string; rawUnit?: string; sourceLine: number; columns: NmrCouplingNucleus[] } | null = null;
  private snapshotState: ScientificSnapshotState | null = null;
  private snapshotSectionLine: number | null = null;
  private snapshotAuLine: number | null = null;
  private snapshotGeometryLine: number | null = null;
  private snapshotPathSummaryLine: number | null = null;
  private snapshotStabilityLine: number | null = null;

  private frequencyTarget():FrequencyElectronicTarget {
    const geometry=this.pending?.geometry??this.frames.at(-1)?.geometry,reference=this.data.reference??'unknown',energy=this.targetEnergy;
    const td=this.data.tasks.includes('td');
    const method=this.frequencyMethod!=='unknown'?this.frequencyMethod:td?'unknown':reference==='unrestricted'&&!/\bUHF\b/i.test(this.data.route)?'udft':/\b(?:HF|RHF|UHF|ROHF|RKS|UKS|B3LYP|PBE0|PBE|BP86|BLYP|M06(?:-2X)?|wB97X(?:-D[34]?)?|r2SCAN(?:-3c)?)\b/i.test(this.data.route)?'scf':'unknown';
    const following=/\bfollowiroot\s+true\b/i.test(this.data.route),root=td&&(!following||this.frequencyRoot?.kind==='printed')?this.frequencyRoot?.value??null:null;
    return {method,state:td?'excited':method==='scf'?'ground':'unknown',root,multiplicity:td?this.frequencyMultiplicity:this.multiplicity,reference,
      evaluationGeometrySourceLine:geometry?.line??null,optimizationGeometrySourceLine:this.optimizationGeometrySourceLine,
      energy:energy&&energy.geometrySourceLine===geometry?.line?{value:energy.value,unit:'hartree',sourceLine:energy.sourceLine}:null,evidence:[...this.frequencyEvidence]};
  }

  private budget(count = 1): boolean {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(this.metadataValues + count)) throw new Error('ORCA元数据计数无效。');
    this.metadataValues += count; return true;
  }
  private notice(message: string) { if (!this.data.notices.includes(message)) this.data.notices.push(message); }
  private diagnostics() { return this.data.diagnostics ??= emptyScientificDiagnostics(); }
  private hasCurrentJobEvidence(): boolean {
    return !!(this.pending || this.frames.length || this.block || this.failed || this.terminated || this.invalid || this.observed || this.data.route || this.data.centers?.length || this.data.summary.length || this.data.properties.length || this.data.diagnostics?.errors.length);
  }
  private taskStatus(event: NonNullable<ScientificData['diagnostics']>['tasks'][number]) { if (this.budget()) this.diagnostics().tasks.push(event); }
  private scfStatus(event: NonNullable<ScientificData['diagnostics']>['scf'][number]) { if (this.budget()) this.diagnostics().scf.push(event); }
  private fieldStatus(event: NonNullable<ScientificData['diagnostics']>['fields'][number]) { if (this.budget()) this.diagnostics().fields.push(event); }
  private error(line: ScientificLine, category: string) {
    this.failed = true;
    const frameIndex = this.numericalFrequency && !this.frequencyResults ? null : this.frameIndex();
    if (category === 'runtime' || category === 'input-check') this.diagnostics().termination = { status: 'error', sourceLine: line.number, raw: line.text };
    if (category === 'scf') this.scfStatus({ status: 'not-converged', frameIndex, sourceLine: line.number, raw: line.text });
    if (category === 'optimization' || category === 'path') this.taskStatus({ task: category === 'path' ? 'path' : this.stageId === 'ts-optimization' ? 'ts-optimization' : 'optimization', status: 'not-converged', stageId: this.stageId, frameIndex, sourceLine: line.number, raw: line.text });
    this.diagnostics().errors.push({ category, severity: 'error', sourceLine: line.number, raw: line.text, start: line.start, end: line.end });
    this.messages.add(`源行${line.number}：${line.text.trim()}`);
  }
  private task(task: ScientificTask) {
    if (task !== 'unknown') this.data.tasks = this.data.tasks.filter(value => value !== 'unknown' && (task === 'sp' || value !== 'sp'));
    if (!this.data.tasks.includes(task)) this.data.tasks.push(task);
  }
  private frameIndex(): number | null { return this.detached ? null : this.pending ? this.frames.length : this.frames.length ? this.frames.length - 1 : null; }
  private field(target: ScientificField[], key: string, label: string, value: number | string, line: ScientificLine, unit?: string, rawValue?:string, origin: ScientificField['origin'] = 'observation') {
    if ((typeof value === 'number' && !Number.isFinite(value)) || !this.budget()) return;
    target.push({ key, label, value, sourceLine: line.number, frameIndex: this.frameIndex(), origin, ...(unit ? { unit } : {}),...(rawValue===undefined?{}:{rawValue}) });
  }
  private adoptedOnce(key: string, label: string, value: number | string, line: ScientificLine, rawValue: string): void {
    if (this.data.properties.some(field => field.key === key && field.origin === 'program-adopted' && field.value === value)) return;
    const before = this.data.properties.length;
    this.field(this.data.properties, key, label, value, line, undefined, rawValue, 'program-adopted');
    if (this.data.properties.length > before) this.data.properties.at(-1)!.frameIndex = null;
  }
  private configure() {
    const r = this.data.route;
    for(const task of orcaScientificTasks(r,!this.data.tasks.some(task=>task!=='unknown')))this.task(task);
  }
  private flush() {
    if (!this.pending) return;
    const p = this.pending; this.pending = null;
    if (this.auCandidate?.geometry === p.geometry) this.auCandidate = null;
    this.storage.reserveIndices();
    this.frames.push({ index: this.frames.length, sourceStep: p.step, time: null,
      energy: p.energy === null ? null : { value: p.energy, unit: 'hartree' }, convergence: p.convergence,
      sourceLine: p.geometry.line, geometry: p.geometry, coordinateRoundingAngstrom: p.geometry.coordinateRoundingAngstrom, ...(p.label ? { label: p.label } : {}),
      ...(p.coordinate ? { coordinate: p.coordinate } : {}), ...(p.direction ? { pathDirection: p.direction } : {}),
      ...(p.node !== null ? { pathNode: p.node } : {}), ...(p.stageId ? { stageId: p.stageId } : {}),
      ...(p.pathPoint ? { pathPoint: true } : {}), ...(p.pathIteration !== undefined ? { pathIteration: p.pathIteration } : {}), ...(p.pathImage !== undefined ? { pathImage: p.pathImage } : {}) });
  }
  private finishModes() {
    const vibration = this.data.vibrations;
    if (!vibration) return;
    if (!this.modesPending) {
      if (vibration.atomBinding === 'unavailable' && !this.modeTableSeen && !this.modeRawAvailability && this.budget()) {
        this.modeRawAvailability = { field: 'normal-mode-raw-components', status: 'not-printed', frameIndex: null, message: '本频率段尚未观察到NORMAL MODES分量表。' };
        this.diagnostics().fields.push(this.modeRawAvailability);
      }
      return;
    }
    if (vibration.atomBinding === 'unavailable') {
      const count = vibration.sourceAtomCount?.value;
      for (const mode of vibration.modes) {
        const raw = this.modeRawVectors.get(mode.index);
        if (raw?.length) mode.rawCartesianComponents = raw;
      }
      const complete = !this.modeRawIncomplete && count !== undefined && vibration.modes.length > 0 && vibration.modes.every(mode => {
        const raw = mode.rawCartesianComponents ?? [], indices = new Set(raw.map(component => component.sourceCoordinateIndex));
        return raw.length === count * 3 && indices.size === count * 3 && Array.from({ length: count * 3 }, (_, index) => indices.has(index)).every(Boolean);
      });
      if (this.modeRawAvailability) { this.modeRawAvailability.status = complete ? 'complete' : 'partial'; this.modeRawAvailability.message = complete ? '完整原始source-order分量已保留；未绑定原子，不能用于动画。' : '仅保留可确认的原始分量前缀；缺失、坏值或预算未补零，不能用于动画。'; }
      vibration.convention = 'ORCA printed frequencies; NORMAL MODES components retained in original source coordinate order, without geometry/atom binding; not for animation; no scaling or unit conversion applied. ' + this.modeConventionLines.join(' ');
      this.modeRawVectors.clear(); this.modeAvailableIndices.clear(); this.modeVectors.clear(); this.modeRounding.clear(); this.modeColumns = []; this.modesPending = false;
      return;
    }
    const count = this.inventory?.length;
    if (vibration && count) for (const mode of vibration.modes) {
      const vector = this.modeVectors.get(mode.index);
      if (!vector) continue;
      if (vector.size !== count * 3 || !Array.from({ length: count * 3 }, (_, i) => vector.has(i)).every(Boolean)) {
        this.notice('部分normal mode位移不完整，未补零或推断缺失分量。');
        this.fieldStatus({ field: `normal-mode-${mode.index}-displacements`, status: 'partial', frameIndex: vibration.frameIndex, sourceLine: mode.sourceLine, message: '未取得同序全部3N位移；不补零、不用于动画。' }); continue;
      }
      mode.displacements = Array.from({ length: count }, (_, i) => [vector.get(i * 3)!, vector.get(i * 3 + 1)!, vector.get(i * 3 + 2)!]);
      mode.displacementRounding = this.modeRounding.get(mode.index);
    }
    this.modeVectors.clear(); this.modeRounding.clear(); this.modeColumns = []; this.modesPending = false;
  }
  private archive() {
    if (this.inputGeometryLines) this.fieldStatus({ field: 'input-geometry', status: 'partial', sourceLine: this.inputGeometryLines[0].number, message: '输入回显XYZ坐标块未闭合；原文保留，未生成起始结构。' });
    this.snapshotState?.cache.invalidate(this.data);
    const au = this.auReader.finish(); if (au) this.applyNuclearTable(au);
    // A live saddle must close its native table; EOF alone cannot promote a
    // row-count-complete prefix or a clipped final row into a committed frame.
    if (this.block?.saddle) { this.block.bad = true; this.acceptGeometry(); }
    if (this.block && !this.block.bad && this.expected !== null && this.block.elements.length === this.expected) this.acceptGeometry();
    if (this.block?.centers?.some(center => center.kind !== 'real')) { this.block.bad = true; this.acceptGeometry(); }
    if (this.block) { this.invalid = true; this.messages.add('坐标块被作业边界或文件末尾截断；未保留不完整结构。'); this.block = null; }
    this.flush(); this.finishModes(); this.finishNmrCouplings();
    if (this.mdNative && !this.diagnostics().tasks.some(event => event.task === 'md' && event.status === 'completed')) this.taskStatus({ task: 'md', status: 'incomplete', stageId: 'md', frameIndex: null, sourceLine: this.lastSourceLine, raw: 'Native MD completion not observed' });
    if (this.frames.length || this.observed || this.invalid || this.data.route || this.failed || this.data.properties.length || this.data.summary.length || this.data.centers?.length) {
      if (!this.data.tasks.some(task => task !== 'unknown') && /^\s*!/m.test(this.data.route) && this.data.summary.some(field => field.key === 'final-energy')) this.task('sp');
      if (!this.data.tasks.length) this.task('unknown');
      if (this.frames.some(f => f.energy === null)) this.notice('部分帧没有已确认的目标能量；SCF参考能量未用于补值。');
      if (!this.terminated) this.messages.add('未检测到此作业正常终止；静态文件不能据此判断程序是否仍在运行。');
      if (!this.frames.length) this.messages.add(`job ${this.jobIndex + 1} / 段 ${this.segmentIndex + 1} 没有完整有效几何；未借用前段结构。`);
      if (this.invalid) this.diagnostics().integrity = { status: 'damaged-tail', sourceLine: this.lastSourceLine, message: '存在不完整或无效坐标块；保留同段完整前缀。' };
      const needsOptimization = this.data.tasks.includes('opt') && (!this.data.tasks.some(task => ['irc', 'scan', 'neb'].includes(task)) || this.stageId === 'ts-optimization');
      const frequencySets = this.data.vibrationSets ?? (this.data.vibrations ? [this.data.vibrations] : []), atomCount = this.inventory?.length ?? this.expected;
      const frequencyComplete = frequencySets.length > 0 && atomCount !== null && frequencySets.every(set => set.modes.length === atomCount * 3 && new Set(set.modes.map(mode => mode.index)).size === atomCount * 3);
      if (this.data.tasks.includes('freq')) {
        this.taskStatus({ task: 'freq', status: frequencyComplete ? 'completed' : 'unknown', sourceLine: this.lastSourceLine, frameIndex: this.frameIndex() });
        if (!frequencyComplete) this.fieldStatus({ field: 'frequencies', status: 'partial', sourceLine: this.lastSourceLine, message: '未取得完整3N模式列表；可能为选择打印、部分Hessian或文件前缀，未据此判定计算失败。' });
      }
      const status = this.failed ? 'failed' : this.terminated && !this.invalid && (!needsOptimization || this.optimized) && (!this.data.tasks.includes('neb') || this.nebConverged) ? 'completed' : 'incomplete';
      if (!this.frames.length) this.storage.reserveIndices();
      this.jobs.push({ jobIndex: this.jobIndex, segmentIndex: this.segmentIndex++, engine: 'orca', charge: this.charge,
        multiplicity: this.multiplicity, status, frames: this.frames, data: this.data, messages: [...this.messages] });
    }
    this.frames = []; this.pending = null; this.inventory = null; this.block = null;
    this.inputGeometryLines = null;
    this.snapshotSectionLine = null; this.snapshotAuLine = null;
    this.snapshotStabilityLine = null;
    this.auCandidate = null; this.auReader.reset();
    this.mdNative = false; this.mdHeader = null; this.mdLayout = null; this.mdInTable = false; this.mdTableStopped = false; this.mdAvailability = null;
    this.data = emptyScientificData(); this.data.version = this.version;
    this.terminated = false; this.failed = false; this.invalid = false; this.optimized = false; this.nebConverged = false;
    this.numericalFrequency = false; this.ircPhase = false; this.ircIterationTable = false; this.step = null; this.node = null; this.label = undefined; this.coordinate = undefined; this.direction = undefined;
    this.frequencyResults=false;this.frequencySnapshot=null;this.frequencyMethod='unknown';this.frequencyRoot=null;this.frequencyMultiplicity=null;this.frequencyEvidence=[];this.optimizationGeometrySourceLine=null;this.targetEnergy=null;this.tdGradientGeometrySourceLine=null;
    this.stageId = undefined; this.nebIteration = undefined; this.nebImage = undefined; this.nebSaddleEvidence = null;
    this.section = 'none'; this.scf = null; this.scfNativeRow = null; this.orbital = null; this.atomic = null; this.excited = null;
    this.excitationBatch = []; this.excitationWaveNumbers.clear(); this.absorptionColumns = null; this.absorptionEnergyUnit = null; this.excitedMultiplicity = null;
    this.simplifiedMethod = null; this.simplifiedRows = [];
    this.excitedMultiplicityEstimated = false;
    this.thermo = false; this.scfTotalContext = false; this.nativeDftComponents = null; this.nativeFunctionalSettings = false; this.nativeFunctionalKind = null; this.nativeTdXcSettings = false; this.stabilityContext = false; this.bsseContext = null; this.messages.clear();
    this.dipoleContext = null;
    this.spectrumValueColumn = null; this.irMomentColumn = null;
    this.irUnitHeaderPending=false;
    this.detached = false; this.spectrumUnit = undefined;
    this.ramanDynamic = false; this.ramanExcitationWavelengthNm = undefined;
    this.frequencyGroupAccepted = false;
    this.referencedPathRole = null; this.pathSummaryKind = null; this.pathSummaryColumns = false; this.snapshotPathSummaryLine = null;
    this.modeRawVectors.clear(); this.modeAvailableIndices.clear(); this.modeRawAvailability = null; this.modeRawIncomplete = false; this.modeTableSeen = false; this.modesPending = false; this.modeConventionLines = [];
    this.nebTableColumns = [];
    this.observed = false;
    this.parameterScan = false; this.parameterPoint = false; this.scanParameters.clear(); this.inputScanParameters.clear(); this.internalInput = false; this.parameterUnits.clear(); this.cpcmParameters = false;
    this.nmrActive = false; this.nmrObserved = false; this.nmrIncomplete = false; this.nmrReduced = false; this.nmrAvailability = null; this.nmrPair = null; this.nmrRaw = null; this.nmrPart = null; this.nmrSummary = null;
  }
  private split(message: string) {
    const route = this.data.route, tasks = [...this.data.tasks];
    this.messages.add(message); this.archive(); this.data.route = route; this.data.tasks = tasks;
  }
  private newJob(index = this.jobIndex + 1) {
    this.archive(); this.jobIndex = index; this.segmentIndex = 0;
    this.charge = null; this.multiplicity = null; this.expected = null; this.expectedWitness = null;
    this.jobMarkerObserved = false;
  }
  private replayJobInput(records: ScientificLine[]) {
    const sourceLine = this.lastSourceLine;
    this.replayingInput = true;
    try { for (const record of records) this.consume(record); }
    finally { this.replayingInput = false; this.lastSourceLine = sourceLine; }
  }
  /** Input geometry is evidence of the request, never a computed path frame. */
  private inputGeometryEcho(echo: string, line: ScientificLine) {
    if (/^\*\s*xyz(?:file)?\b/i.test(echo) || /^\*\s*int\b/i.test(echo)) {
      if (this.inputGeometryLines) this.fieldStatus({ field: 'input-geometry', status: 'partial', sourceLine: this.inputGeometryLines[0].number, message: '输入回显坐标块未闭合；未借用其他块。' });
      this.inputGeometryLines = /^\*\s*xyz\s+[+-]?\d+\s+\d+\s*$/i.test(echo) ? [{ ...line }] : null;
      if (!this.inputGeometryLines) this.fieldStatus({ field: 'input-geometry', status: 'unsupported', sourceLine: line.number, message: '输入引用外部XYZ或使用未支持坐标；未读取引用文件或生成普通结构。' });
      return;
    }
    const records = this.inputGeometryLines;
    if (!records) return;
    records.push({ ...line });
    if (!/^\*\s*$/.test(echo)) return;
    this.inputGeometryLines = null;
    const clean = records.map(record => orcaSourceLine(record.text.replace(/^\s*\|\s*\d+>\s?/, '')).trim());
    const rawInput = records.map(record => record.text.replace(/^\s*\|\s*\d+>\s?/, '')).join('\n'), requested = this.data.route + '\n' + clean.join('\n');
    try {
      const tokens = clean.slice(1, -1).filter(Boolean).map(row => row.split(/\s+/));
      if (!tokens.length || tokens.some(fields => fields.length !== 4 || !fields.slice(1).every(value => new RegExp(`^${N}$`).test(value) && num(value) !== null))) throw new Error('输入回显坐标行不完整或数字无效。');
      if (readOrcaInputCenters(requested).some(job => job.centers.some(center => center.kind !== 'real'))) throw new Error('输入回显含ghost/dummy中心；未生成普通原子结构。');
      const structures = parseOrcaInput(requested, `ORCA input echo job ${this.jobIndex + 1}`);
      if (structures.length !== 1) throw new Error('输入回显几何存在多个候选，未选择任意一个。');
      if (this.data.inputGeometry) { this.fieldStatus({ field: 'input-geometry', status: 'conflict', sourceLine: line.number, message: '同job存在多个输入几何，保留首份明确起始结构及原文，未覆盖。' }); return; }
      const structure = structures[0], unit = orcaSourceKeywords(requested).some(keyword => /^bohrs$/i.test(keyword)) ? 'bohr' as const : 'angstrom' as const;
      const coordinateTokens = tokens.map(fields => fields.slice(1) as [string, string, string]);
      this.data.inputGeometry = { structure, origin: 'input-echo', sourceLine: records[0].number, endSourceLine: line.number,
        sourceStart: records[0].start, sourceEnd: line.end, rawInput, coordinateTokens, unit,
        coordinateRoundingAngstrom: coordinateTokens.reduce((maximum, row) => row.reduce((value, token) => Math.max(value, scientificRoundingInterval(token) ?? 0), maximum), 0) * (unit === 'bohr' ? .529177210903 : 1) };
      this.fieldStatus({ field: 'input-geometry', status: 'complete', sourceLine: records[0].number, message: '完整输入回显起始结构；不是已计算路径帧或最终端点。' });
    } catch (error) {
      this.fieldStatus({ field: 'input-geometry', status: 'unsupported', sourceLine: records[0].number, message: error instanceof Error ? error.message : String(error) });
    }
  }
  private acceptGeometry() {
    const b = this.block; this.block = null;
    if (!b) return;
    if (b.saddle) { this.acceptNebSaddle(b); return; }
    const invalid = b.bad || !b.elements.length || (this.expected !== null && b.elements.length !== this.expected);
    if (this.numericalFrequency) return;
    if (b.centers?.some(center => center.kind !== 'real')) {
      if (this.frames.length || this.pending || this.data.centers?.length) this.split('特殊核/基组中心与其他几何分段；未把ghost转为真实核。');
      this.storage.reserveCenters(b.centers.length);
      this.observed = true; this.detached = true; this.data.centers = b.centers;
      this.invalid = invalid;
      this.fieldStatus({ field: 'geometry', status: invalid ? 'partial' : 'unsupported', sourceLine: b.line, message: '已保留real/ghost/dummy中心证据；普通Atom模型未使用特殊中心。' });
      this.auCandidate = { rows: b.angRows ?? [], centerCredit: b.centers.length };
      this.notice('特殊中心作为来源证据保留，未生成普通分子帧或推断电子数。');
      return;
    }
    if (invalid) { this.invalid = true; this.messages.add('检测到空、无效或原子数不匹配坐标块；未跨坐标块借帧。'); return; }
    if (this.data.centers?.some(center => center.kind !== 'real')) this.split('普通核几何与此前特殊中心证据分段，未跨中心种类继承性质。');
    this.frequencySnapshot=null;this.tdGradientGeometrySourceLine=null;
    if (this.inventory && (b.elements.length !== this.inventory.length || b.elements.some((e, i) => this.inventory![i] !== e))) {
      const step = this.step, node = this.node, label = this.label, coordinate = this.coordinate, direction = this.direction;
      this.split('原子库存或顺序改变，已分成独立结果段。');
      this.step = step; this.node = node; this.label = label; this.coordinate = coordinate; this.direction = direction;
    }
    const newInventory = !this.inventory;
    if (!this.inventory) { this.storage.reserveCenters(b.elements.length); this.inventory = b.elements; }
    this.detached = false;
    const geometry: ScientificGeometry = { start: b.start, end: b.end, line: b.line, format: 'orca-cartesian', elements: this.inventory, coordinateRoundingAngstrom: b.rounding };
    if(this.optimized&&this.label==='最终驻点评估')this.optimizationGeometrySourceLine=geometry.line;
    this.flush(); this.pending = { geometry, step: this.step, node: this.node, energy: null, convergence: [], label: this.label, coordinate: this.coordinate, direction: this.direction, stageId: this.stageId, pathIteration: this.nebIteration, pathImage: this.nebImage };
    this.auCandidate = { rows: b.angRows ?? [], geometry, centerCredit: newInventory ? b.elements.length : 0 };
  }
  private acceptNebSaddle(block: GeometryBlock) {
    const saddle = block.saddle!;
    const special = block.centers?.some(center => center.kind !== 'real');
    const invalid = block.bad || !block.elements.length || this.expected === null || block.elements.length !== this.expected;
    this.detached = true;
    if (invalid || special) {
      if (invalid) this.invalid = true;
      this.fieldStatus({ field: 'neb-saddle-geometry', status: invalid ? 'partial' : 'unsupported', frameIndex: null, sourceLine: saddle.header.number,
        message: 'NEB CI坐标表未完整闭合、原子数无效或含特殊中心；未发布候选几何，也未借用后续TS结构。' });
      return;
    }
    this.flush(); this.storage.reserveIndices(); this.storage.reserveCenters(block.elements.length);
    const index = this.frames.length, evidence = saddle.evidence;
    const geometry: ScientificGeometry = { start: block.start, end: block.end, line: block.line, format: 'orca-cartesian', elements: block.elements, coordinateRoundingAngstrom: block.rounding };
    this.frames.push({ index, sourceStep: null, time: null, energy: evidence.energy ? { value: evidence.energy.value, unit: 'hartree' } : null,
      convergence: [], sourceLine: block.line, geometry, coordinateRoundingAngstrom: block.rounding,
      stageId: 'neb-saddle', label: 'NEB CI候选（原文SADDLE POINT）', ...(evidence.image ? { sourcePathImage: evidence.image.value } : {}) });
    // This is a sealed source geometry, never the generic pending receiver of
    // later SCF/TD/property output or a complete image×iteration path.
    const field = (key: string, label: string, scalar: NebSaddleScalar, unit?: string) => {
      if (this.budget()) this.data.properties.push({ key, label, value: scalar.value, rawValue: scalar.rawValue, sourceLine: scalar.line.number, frameIndex: index, origin: 'observation', ...(unit ? { unit } : {}) });
    };
    if (this.budget()) this.data.properties.push({ key: 'neb-saddle-role', label: 'NEB原生候选几何及单位', value: saddle.header.text.trim(), rawValue: saddle.header.text.trim(), sourceLine: saddle.header.number, frameIndex: index, origin: 'observation' });
    if (evidence.image) field('neb-saddle-image', 'NEB原生CI编号（未改序号基准）', evidence.image);
    if (evidence.energy) field('neb-saddle-energy', 'NEB CI原生能量', evidence.energy, 'hartree');
    if (evidence.force) field('neb-saddle-max-force', 'NEB CI原生最大绝对力', evidence.force, 'hartree/bohr');
    this.fieldStatus({ field: 'neb-saddle-geometry', status: 'complete', frameIndex: index, sourceLine: saddle.header.number,
      message: '单个NEB CI候选几何；不代表完整路径、后续TS几何或频率验证通过。' });
  }
  private readNebSaddle(line: ScientificLine): boolean {
    if (this.stageId !== 'neb-path' || !this.data.tasks.includes('neb') || this.numericalFrequency) return false;
    const text = line.text.trim();
    const image = text.match(/^Climbing image\s*\.{2,}\s*(\d+)\s*$/i);
    if (image) { this.nebSaddleEvidence = { image: { value: indexNumber(image[1]), rawValue: image[1], line } }; return true; }
    const scalar = this.nebSaddleEvidence && text.match(new RegExp(`^(Energy|Max\\. abs\\. force)\\s*\\.{2,}\\s*(${N})\\s+(Eh|Eh/Bohr)\\s*$`, 'i'));
    if (scalar && num(scalar[2]) !== null) {
      const kind = /^Energy$/i.test(scalar[1]) ? 'energy' : 'force';
      if ((kind === 'energy' && /^Eh$/i.test(scalar[3])) || (kind === 'force' && /^Eh\/Bohr$/i.test(scalar[3]))) this.nebSaddleEvidence![kind] = { value: num(scalar[2])!, rawValue: scalar[2], line };
      return true;
    }
    if (!/^SADDLE POINT\s*\((?:ANGSTROEM|ANGSTROM)\)$/i.test(text)) return false;
    this.flush(); this.detached = true; this.section = 'none'; this.snapshotSectionLine = null; this.snapshotGeometryLine = line.number;
    this.block = { start: line.end, end: line.end, line: line.number, elements: [], bad: false, saddle: { header: line, evidence: this.nebSaddleEvidence ?? {} } };
    this.nebSaddleEvidence = null;
    return true;
  }
  private applyNuclearTable(table: OrcaAuTable) {
    const candidate = this.auCandidate;
    this.auCandidate = null;
    const paired = pairOrcaCenterTables(candidate?.rows ?? [], table);
    if (!candidate && !paired.special) return;
    if (paired.matched && !paired.special && !table.ecpFootnote) return;
    const preserveOrdinary = paired.independentReal || paired.matched && !paired.special;
    const existingSpecial = !candidate?.geometry && this.data.centers?.some(center => center.kind !== 'real');
    if (!existingSpecial && !preserveOrdinary) {
      if (candidate?.geometry && this.pending?.geometry === candidate.geometry) this.pending = null;
      if (this.frames.length) this.split('原生A.U.核角色证据与较早普通几何分段，未把ghost当成真核。');
      const credit = candidate?.centerCredit ?? 0;
      this.storage.reserveCenters(Math.max(0, paired.centers.length - credit));
      this.inventory = null; this.detached = true; this.data.centers = paired.centers;
    }
    this.observed = true;
    this.fieldStatus({ field: 'orca-center-pairing', status: paired.matched ? 'complete' : table.complete ? 'conflict' : 'partial', frameIndex: null, sourceLine: table.sourceLine, message: paired.message });
    if (!preserveOrdinary) this.fieldStatus({ field: 'geometry', status: paired.matched ? 'unsupported' : table.complete ? 'conflict' : 'partial', frameIndex: null, sourceLine: table.sourceLine, message: '原核/基组中心独立保留；未生成普通真核模型。' });
    else if (paired.independentReal) this.notice('完整同数同序全实核Å/A.U.表坐标冲突：保留独立Å几何，A.U.观测不与其建立坐标/核性质映射。');
    this.notice(paired.message);
    for (const row of table.rows) {
      const line: ScientificLine = { text: '', number: row.sourceLine, start: 0, end: 0 };
      const firstField = this.data.properties.length;
      if (paired.independentReal) this.field(this.data.properties, `orca-center-${row.sourceIndex}-au-label`, 'Independent native A.U. center label (not an Angstrom atom mapping)', row.label, line, undefined, row.label);
      this.field(this.data.properties, `orca-center-${row.sourceIndex}-au-za`, row.ecpMarked ? 'Native A.U. ZA effective core charge (ECP-marked; not nuclear Z)' : 'Native A.U. ZA column (nuclear/model charge evidence)', row.za, line, undefined, row.zaToken);
      this.field(this.data.properties, `orca-center-${row.sourceIndex}-au-mass`, 'Native A.U. MASS column (unit not printed)', row.mass, line, undefined, row.massToken);
      this.field(this.data.properties, `orca-center-${row.sourceIndex}-au-frag`, 'Native A.U. FRAG column (not a writer fragment identity)', row.frag, line, undefined, row.fragToken);
      for (const [axis, index] of [['x', 0], ['y', 1], ['z', 2]] as const) this.field(this.data.properties, `orca-center-${row.sourceIndex}-au-${axis}`, 'Native A.U. coordinate ' + axis.toUpperCase(), row.coordinates[index], line, 'bohr', row.coordinateTokens[index]);
      if (paired.independentReal) for (let index = firstField; index < this.data.properties.length; index++) this.data.properties[index].frameIndex = null;
    }
    if (table.ecpFootnote) this.field(this.data.properties, 'orca-ecp-core-charge-footnote', 'Native ECP effective core charge footnote', table.ecpFootnote.raw, { text: table.ecpFootnote.raw, number: table.ecpFootnote.sourceLine, start: 0, end: 0 }, undefined, table.ecpFootnote.raw);
    const line: ScientificLine = { text: '', number: table.sourceLine, start: 0, end: 0 };
    const firstCountField = this.data.properties.length;
    this.field(this.data.properties, 'orca-observed-basis-center-count', 'Observed native center-row count (not a BSSE grouping)', table.rows.length, line, undefined, undefined, 'derived');
    this.field(this.data.properties, 'orca-observed-real-nucleus-count', 'Count of native positive-Z centers', table.rows.filter(row => row.za > 0).length, line, undefined, undefined, 'derived');
    if (paired.independentReal) for (let index = firstCountField; index < this.data.properties.length; index++) this.data.properties[index].frameIndex = null;
  }
  private geometryLine(line: ScientificLine): boolean {
    const b = this.block;
    if (!b) return false;
    if (!line.text.trim() || dash.test(line.text)) { if (b.elements.length) this.acceptGeometry(); return true; }
    const fields = line.text.trim().split(/\s+/);
    if (fields.length !== 4 || fields.slice(1).some(v => num(v) === null)) {
      if (/^[A-Za-z]{1,3}\s+/.test(line.text.trim()) && fields.length === 4) b.bad = true;
      // A heading after an empty block proves that the block is empty.
      if (!b.elements.length) b.bad = true;
      this.acceptGeometry(); return false;
    }
    let element: string;
    // ORCA 5 prints internal-coordinate DA centers as '-' in its Å table.
    // Keep the placeholder identity; this table does not establish a nucleus.
    const ghost = /^([A-Za-z]{1,2}):$/.exec(fields[0]), dummy = /^(?:DA|-)$/i.test(fields[0]);
    try { element = dummy ? 'DA' : elementSymbol(ghost?.[1] ?? fields[0]); } catch { b.bad = true; this.acceptGeometry(); return false; }
    (b.centers ??= []).push({ sourceIndex: b.elements.length + 1, sourceLine: line.number, kind: ghost ? 'ghost' : dummy ? 'dummy' : 'real', element: dummy ? null : element, nuclearCharge: ghost ? 0 : dummy ? null : atomicNumber(element), coordinates: fields.slice(1).map(token => num(token)!) as [number, number, number], coordinateUnit: 'angstrom' });
    (b.angRows ??= []).push({ sourceIndex: b.elements.length + 1, sourceLine: line.number, label: fields[0], kind: ghost ? 'ghost' : dummy ? 'dummy' : 'real', element: dummy ? null : element, nuclearCharge: ghost ? 0 : dummy ? null : atomicNumber(element), coordinates: fields.slice(1).map(token => num(token)!) as [number, number, number], coordinateTokens: fields.slice(1) as [string, string, string], coordinateUnit: 'angstrom' });
    if (!b.elements.length) { b.start = line.start; b.line = line.number; }
    b.end = line.end; b.elements.push(element);
    b.rounding = Math.max(b.rounding ?? 0, ...fields.slice(1).map(token => scientificRoundingInterval(token) ?? 0));
    return true;
  }

  consume(line: ScientificLine): void {
    if (this.finished) throw new Error('ORCA读取器已结束。');
    this.snapshotState?.observe(line);
    const text = line.text, trimmed = text.trim();
    this.lastSourceLine = line.number;
    if (/^INPUT FILE$/.test(trimmed)) this.inputFileHeader = true;
    else if (this.inputFileHeader) {
      const name = trimmed.match(/^NAME\s*=\s*(\S+)\s*$/);
      if (name) { this.field(this.data.properties, 'native-job-name', 'Native input job identity', name[1].replace(/\.inp$/i, ''), line, undefined, name[1], 'program-adopted'); this.inputFileHeader = false; }
      else if (trimmed && !/^[-=]+$/.test(trimmed)) this.inputFileHeader = false;
    }
    // Echoes are input evidence, never native termination/error/energy markers.
    if (/^\s*#/.test(text)) return;
    if (!this.replayingInput && !this.jobMarkerObserved && this.appliedInputJobs.size === 0 && /^\s*\|\s*\d+>/.test(text)) {
      {
        this.inputEchoCharacters += text.length + 1;
        const clean = orcaSourceLine(text.replace(/^\s*\|\s*\d+>\s?/, '')).trim();
        if (/^\$new_job$/i.test(clean)) this.inputEchoJobs.push([]);
        else this.inputEchoJobs.at(-1)!.push({ ...line });
      }
    }
    if(/^TOTAL SCF ENERGY$/i.test(trimmed)){this.scfTotalContext=true;this.nativeDftComponents=null;}
    else if(/^(?:FINAL SINGLE POINT ENERGY|THERMOCHEMISTRY|ORBITAL ENERGIES|DIPOLE MOMENT|GEOMETRY OPTIMIZATION CYCLE|CARTESIAN COORDINATES|JOB NUMBER)\b/i.test(trimmed)){this.scfTotalContext=false;this.nativeDftComponents=null;}
    const compound = text.match(/^\s*COMPOUND JOB\s+(MainJOB|\d+)\s*$/i);
    if (compound) {
      if (/MainJOB/i.test(compound[1])) { this.compoundStart = this.jobs.length; this.compoundEnvelopeLine = line; }
      else {
        const envelope = this.compoundEnvelopeLine && !this.pending && !this.frames.length && !this.failed && !this.data.summary.length && this.data.properties.every(field => field.origin === 'input-request' || field.origin === 'program-adopted') ? this.data.printedRoute ?? this.data.route : null;
        const envelopeLine = this.compoundEnvelopeLine;
        const envelopeFields = envelope !== null ? this.data.properties : [];
        if (envelope !== null) { this.data = emptyScientificData(); this.data.version = this.version; this.observed = false; }
        this.newJob(Math.max(0, indexNumber(compound[1]) - 1));
        this.data.properties.push(...envelopeFields);
        if (envelope && envelopeLine) this.field(this.data.properties, 'compound-input-echo', 'Compound MainJOB input echo (container, not a separate calculation)', envelope, envelopeLine);
        this.compoundEnvelopeLine = null;
      }
      return;
    }
    const printedNumber = orcaNativeJobNumber(text);
    if (printedNumber !== null) {
      const request = !this.appliedInputJobs.has(printedNumber) && !(this.failed && !this.jobMarkerObserved) ? this.inputEchoJobs[printedNumber - 1] : undefined;
      const inputOnlyPreamble = !this.jobMarkerObserved && request?.length && !this.pending && !this.frames.length && !this.block && !this.failed && !this.terminated && !this.invalid && !this.data.centers?.length && !this.data.summary.length && !this.data.scfCycles.length && !this.data.orbitals.length && this.data.properties.every(field => field.origin === 'input-request' || field.origin === 'program-adopted');
      if (inputOnlyPreamble) {
        const adopted = this.data.properties.filter(field => field.origin === 'program-adopted');
        this.data = emptyScientificData(); this.observed = false;
        this.archive(); // reset input-derived state without manufacturing a preamble job
        this.data.properties.push(...adopted);
        this.charge = null; this.multiplicity = null; this.expected = null; this.expectedWitness = null;
      }
      // A first JOB NUMBER 1 can label the version-only preamble of that same
      // job. It cannot erase an earlier zero-frame failure or an observed run.
      const initialAnnotation = !this.jobMarkerObserved && !this.pending && !this.frames.length && !this.block && !this.failed && !this.terminated && !this.invalid && !this.data.route && !this.data.centers?.length && !this.data.summary.length && this.data.properties.every(field => field.origin === 'program-adopted');
      if (!inputOnlyPreamble && this.hasCurrentJobEvidence() && !initialAnnotation) this.newJob();
      if (request?.length) this.replayJobInput(request);
      this.appliedInputJobs.add(printedNumber);
      this.field(this.data.properties, 'printed-job-number', 'Program printed job number (independent of source run index)', printedNumber, line, undefined, String(printedNumber), 'program-adopted');
      this.jobMarkerObserved = true;
      return;
    }
    if (/^\s*\*?\s*O\s+R\s+C\s+A\s*\*?\s*$/.test(text)) {
      if (this.hasCurrentJobEvidence()) this.newJob();
      this.compoundStart = null; this.compoundEnvelopeLine = null;
      this.inputEchoJobs = [[]]; this.inputEchoCharacters = 0; this.inputEchoTruncated = false; this.appliedInputJobs.clear();
      this.observed = true;
    }
    if (this.geometryLine(line)) return;
    if (this.readNebSaddle(line)) return;
    // A numerical Hessian is also an internal preparation stage of IRC. Its
    // displaced evaluations remain suppressed, but a proven native task/phase
    // boundary must be handled before the NumFreq suppression return.
    const ircHeading = /^\s*Intrinsic Reaction Coordinate Calculation\s*$/i.test(text);
    const ircBranch = text.match(/^\s*\*+\s*(FORWARD|REVERSE|BACKWARD)\s+IRC\s*\*+\s*$/i);
    const ircResume = ircHeading || ircBranch !== null || /^\s*IRC PATH SUMMARY\s*$/i.test(text)
      || /^\s*IRC\s+(?:PATH\s+)?(?:STEP|POINT)\s*[:=]?\s*\d+\s*$/i.test(text);
    if (ircResume) {
      this.numericalFrequency = false; this.frequencyResults = false;
      this.section = 'none'; this.snapshotSectionLine = null; this.thermo = false;
    }
    if (ircHeading) {
      // The native module boundary proves these same-job SP evaluations precede
      // the path. Only one unambiguous standalone evaluation is called initial;
      // OPT/SCAN/NEB/TD histories are not retrospectively relabelled as IRC input.
      if (!this.ircPhase && !this.data.tasks.some(task => ['opt', 'scan', 'neb', 'td'].includes(task))) {
        const candidates = this.data.summary.filter(field => field.key === 'final-energy' && !field.stageId && field.sourceLine < line.number);
        if (candidates.length) {
          const initial = candidates.length === 1;
          this.data.summary = this.data.summary.map(field => candidates.includes(field) ? { ...field,
            stageId: initial ? 'irc-initial-single-point' : 'irc-preparation-single-point',
            label: initial ? 'IRC初始单点能 E(FINAL SINGLE POINT)' : 'IRC前置单点能 E(FINAL SINGLE POINT)' } : field);
        }
      }
      this.ircPhase = true; this.task('irc'); this.stageId = 'irc'; this.detached = true;
    }
    if (ircBranch) {
      this.ircIterationTable = false;
      this.ircPhase = true; this.task('irc'); this.direction = /^FORWARD$/i.test(ircBranch[1]) ? 'forward' : 'reverse';
      this.stageId = 'irc-' + this.direction; this.detached = true;
      this.taskStatus({ task: 'path', status: 'incomplete', stageId: this.stageId, frameIndex: null, sourceLine: line.number, raw: text });
    }
    // Internal NumFreq evaluations are not observations of the stationary
    // molecule. In particular their TD tables must not become unscoped data
    // which a single-frame result projection could later accept as its own.
    if(this.numericalFrequency&&!this.frequencyResults){
      if(/^\s*VIBRATIONAL FREQUENCIES\s*$/i.test(text))this.frequencyResults=true;
      else {
        if(/^\s*\**\s*ORCA TERMINATED NORMALLY\s*\**\s*$/i.test(text)) { this.terminated = true; this.diagnostics().termination = { status: 'normal', sourceLine: line.number, raw: text }; }
        if(/^\s*\**\s*(?:ORCA finished by error termination|ORCA TERMINATED ABNORMALLY|SCF NOT CONVERGED)\b/i.test(text)) this.error(line, /SCF NOT CONVERGED/i.test(text) ? 'scf' : 'runtime');
        return;
      }
    }
    const version = text.match(/^\s*Program Version\s+([^\s]+)/i);
    if (version) { this.version = version[1]; this.data.version = this.version; this.field(this.data.properties, 'program-version-banner', 'Program version banner', text.trim(), line, undefined, text, 'program-adopted'); }
    const printedEcho = text.replace(/^\s*\|\s*\d+>\s?/, '').trim();
    const echo = orcaSourceLine(printedEcho).trim();
    const isEcho = /^\s*\|\s*\d+>/.test(text);
    if (isEcho) this.inputGeometryEcho(echo, line);
    if (version) this.observed = true;
    if (isEcho) {
      this.observed = true;
      this.data.printedRoute = (this.data.printedRoute ? this.data.printedRoute + '\n' : '') + printedEcho;
      const maxcore = echo.match(/^%maxcore\s+(\d+)\s*$/i), cores = echo.match(/^(?:%pal\s+)?nprocs\s+(\d+)\s*(?:end\s*)?$/i);
      if (maxcore) this.field(this.data.properties, 'input-maxcore-mb-per-process', 'Input MaxCore per process', Number(maxcore[1]), line, 'MB', maxcore[1], 'input-request');
      if (cores) this.field(this.data.properties, 'input-processes', 'Input requested processes', Number(cores[1]), line, undefined, cores[1], 'input-request');
      const parameterRange = echo.match(new RegExp(`^([A-Za-z]\\w*)\\s*=\\s*${N}\\s*,\\s*${N}\\s*,\\s*\\d+\\s*$`));
      if (parameterRange) this.inputScanParameters.add(parameterRange[1].toLowerCase());
      if (/^\*\s*int\s+[+-]?\d+\s+\d+\s*$/i.test(echo)) this.internalInput = true;
      else if (/^\*\s*$/.test(echo)) this.internalInput = false;
      if (this.internalInput) {
        const values = echo.split(/\s+/);
        if (values.length === 7 && /^[A-Za-z]{1,2}$/.test(values[0]) && values.slice(1, 4).every(value => /^\d+$/.test(value))) {
          for (const slot of [4, 5, 6]) {
            const variable = values[slot].match(/^\{([A-Za-z]\w*)\}$/), key = variable?.[1].toLowerCase();
            if (!key || !this.inputScanParameters.has(key)) continue;
            const unit = slot === 4 ? null : 'degree';
            this.parameterUnits.set(key, this.parameterUnits.has(key) && this.parameterUnits.get(key) !== unit ? null : unit);
            this.field(this.data.properties, `input-parameter-${key}-role`, 'Input internal-coordinate parameter role', slot === 4 ? 'bond' : slot === 5 ? 'angle' : 'dihedral', line, undefined, values[slot], 'input-request');
          }
        }
      }
    }
    const rootEcho=echo.match(/^iroot\s+(\d+)\s*(?:#.*)?$/i),root=rootEcho??trimmed.match(/^(?:Root for which the gradient has to be computed|State of interest|IROOT)\s*(?:\.{2,}|[:=])\s*(\d+)\s*$/i);
    if(root&&Number(root[1])>0){const kind=rootEcho&&(isEcho||!this.pending&&!this.frames.length)?'input-echo':'printed';this.frequencyRoot={value:Number(root[1]),sourceLine:line.number,kind};this.frequencyEvidence=this.frequencyEvidence.filter(row=>row.field!=='root');this.frequencyEvidence.push({sourceLine:line.number,kind,field:'root',value:root[1]});}
    const tdaEcho=echo.match(/^tda\s+(true|false)\s*(?:#.*)?$/i),tda=tdaEcho??trimmed.match(/^Tamm-Dancoff approximation\s*(?:\.{2,}|[:=])\s*(on|off|true|false|activated|deactivated)\s*$/i);
    if(tda){this.frequencyMethod=/^(?:true|on|activated)$/i.test(tda[1])?'tda':'td';this.frequencyEvidence=this.frequencyEvidence.filter(row=>row.field!=='method');this.frequencyEvidence.push({sourceLine:line.number,kind:tdaEcho?'input-echo':'printed',field:'method',value:trimmed});}
    if(/^TD-DFT(?:\/(?:RPA|TDA))?\s+GRADIENT$/i.test(trimmed)){const geometry=this.pending?.geometry??this.frames.at(-1)?.geometry;this.tdGradientGeometrySourceLine=geometry?.line??null;this.frequencyMethod=/TDA/i.test(trimmed)?'tda':'td';this.frequencyEvidence=this.frequencyEvidence.filter(row=>row.field!=='method');this.frequencyEvidence.push({sourceLine:line.number,kind:'printed',field:'method',value:trimmed});}
    const targetGeometry = !this.detached ? this.pending?.geometry ?? this.frames.at(-1)?.geometry : undefined;
    if (this.data.tasks.includes('td') && targetGeometry && /^EXCITED STATE GRADIENT DONE$/i.test(trimmed)) this.tdGradientGeometrySourceLine = targetGeometry.line;
    const responseRoot = trimmed.match(/^(SINGLET|TRIPLET)\s+IROOT\s+([1-9]\d*)\s*$/i);
    if (responseRoot && this.data.tasks.includes('td') && targetGeometry && this.tdGradientGeometrySourceLine === targetGeometry.line) {
      this.frequencyRoot = { value: indexNumber(responseRoot[2]), sourceLine: line.number, kind: 'printed', geometrySourceLine: targetGeometry.line };
      this.frequencyMultiplicity = /^TRIPLET$/i.test(responseRoot[1]) ? 3 : 1;
      this.frequencyEvidence = this.frequencyEvidence.filter(row => row.field !== 'root' && row.field !== 'multiplicity');
      this.frequencyEvidence.push({ sourceLine: line.number, kind: 'printed', field: 'root', value: responseRoot[2] }, { sourceLine: line.number, kind: 'printed', field: 'multiplicity', value: String(this.frequencyMultiplicity) });
    }
    const triplet=trimmed.match(/^Triplet state\s*(?:\.{2,}|[:=])\s*(YES|NO)\s*$/i);
    if(triplet){this.frequencyMultiplicity=/YES/i.test(triplet[1])?3:this.frequencyMultiplicity!==null&&this.frequencyMultiplicity!==3?this.frequencyMultiplicity:this.data.reference==='restricted'&&this.multiplicity===1?1:null;if(this.frequencyMultiplicity!==null){this.frequencyEvidence=this.frequencyEvidence.filter(row=>row.field!=='multiplicity');this.frequencyEvidence.push({sourceLine:line.number,kind:'printed',field:'multiplicity',value:String(this.frequencyMultiplicity)});}}
    if (isEcho && /\bfreq_[ri]\b/i.test(echo) || /^\s*(?:DYNAMIC|FREQUENCY[- ]DEPENDENT)\s+(?:DIPOLE\s+)?POLARIZABILITY\b/i.test(text)) {
      this.ramanDynamic = true;
      for (const mode of this.data.vibrations?.modes ?? []) if (mode.ramanActivity !== undefined) mode.ramanActivityConvention = 'dynamic';
    }
    const ramanWavelength = text.match(new RegExp(`^\\s*(?:Raman\\s+)?(?:Excitation|Incident(?: light)?) wavelength\\s*[:=]\\s*(${N})\\s*nm\\s*$`, 'i'));
    if (ramanWavelength && num(ramanWavelength[1]) !== null && num(ramanWavelength[1])! > 0) {
      this.ramanDynamic = true; this.ramanExcitationWavelengthNm = num(ramanWavelength[1])!;
    }
    const coordinateEcho = /^\*\s*xyz(?:file)?\b/i.test(echo) || /^\*\s*$/.test(echo)
      || /^[A-Za-z]{1,2}\s+\S+\s+\S+\s+\S+\s*$/.test(echo) && echo.split(/\s+/).slice(1).every(v => num(v) !== null);
    if (!coordinateEcho && !/\*{3,}END OF INPUT/i.test(echo) && (isEcho && echo.length > 0 || echo.startsWith('!') || /^%(?:tddft|geom|eprnmr|scf)\b/i.test(echo) || /^(?:iroot|followiroot|scalfreq|stabperform|scan)\b/i.test(echo))) {
      this.data.route += (this.data.route ? '\n' : '') + echo; this.configure();
      const scale = echo.match(new RegExp(`^scalfreq\\s+(${N})`, 'i'));
      if (scale && num(scale[1]) !== null) this.field(this.data.properties, 'frequency-scale-input', 'ScalFreq input (preserved, not reapplied)', num(scale[1])!, line);
      if (/followiroot/i.test(echo)) this.notice('Root following保留逐次打印的态编号；未将编号当作跨几何永久state ID。');
      const scanDefinition = echo.match(/^([BAD])\s+(\d+)\s+(\d+)(?:\s+(\d+))?(?:\s+(\d+))?\s*=\s*[^#]+/i);
      if (scanDefinition && /^\s*scan(?:\s|$)/im.test(this.data.route)) {
        const kind = scanDefinition[1].toUpperCase(), atoms = scanDefinition.slice(2).filter(value => value !== undefined).map(indexNumber), required = kind === 'B' ? 2 : kind === 'A' ? 3 : 4;
        if (atoms.length === required && new Set(atoms).size === required && this.budget()) (this.data.scanCoordinates ??= []).push({ kind: kind === 'B' ? 'bond' : kind === 'A' ? 'angle' : 'dihedral', atomIndices: atoms, unit: kind === 'B' ? 'angstrom' : 'degree', sourceLine: line.number });
      }
    }
    const charge = text.match(/Total Charge(?:\s+Charge)?\s*[.:=]*\s*([+-]?\d+)\s*$/i);
    const mult = this.dipoleContext ? null : text.match(/Multiplicity(?:\s+Mult)?\s*[.:=]*\s*(\d+)\s*$/i);
    const echoState=isEcho?echo.match(/^\*\s*xyz(?:file)?\s+([+-]?\d+)\s+(\d+)(?:\s|$)/i):null;
    if (charge || mult || echoState) {
      const q = charge ? num(charge[1]) : echoState?num(echoState[1]):this.charge, m = mult ? indexNumber(mult[1]) : echoState?indexNumber(echoState[2]):this.multiplicity;
      if ((charge||echoState) && (q === null || !Number.isSafeInteger(q)) || (mult||echoState) && m === 0) throw new Error('ORCA电荷或多重度无效。');
      const requestedCharge = this.data.properties.find(field => field.key === 'input-charge'), requestedMultiplicity = this.data.properties.find(field => field.key === 'input-multiplicity');
      if ((this.charge !== null && q !== this.charge || this.multiplicity !== null && m !== this.multiplicity) && (this.pending || this.frames.length)) this.split('电荷或自旋多重度改变，已分成独立结果段。');
      this.charge = q; this.multiplicity = m;
      if (charge && requestedCharge && q !== requestedCharge.value) this.fieldStatus({ field: 'charge', status: 'conflict', sourceLine: line.number, message: `输入源行${requestedCharge.sourceLine}请求${requestedCharge.value}；程序打印${q}，分别保留。` });
      if (mult && requestedMultiplicity && m !== requestedMultiplicity.value) this.fieldStatus({ field: 'multiplicity', status: 'conflict', sourceLine: line.number, message: `输入源行${requestedMultiplicity.sourceLine}请求${requestedMultiplicity.value}；程序打印${m}，分别保留。` });
      if (charge || echoState) this.field(this.data.properties, echoState ? 'input-charge' : 'printed-charge', echoState ? 'Input requested charge' : 'Program printed charge', q!, line, 'electron', charge?.[1] ?? echoState![1], echoState ? 'input-request' : 'program-adopted');
      if (mult || echoState) this.field(this.data.properties, echoState ? 'input-multiplicity' : 'printed-multiplicity', echoState ? 'Input requested multiplicity' : 'Program printed multiplicity', m!, line, undefined, mult?.[1] ?? echoState![2], echoState ? 'input-request' : 'program-adopted');
    }
    if (isEcho) return;
    if (this.ircPhase && (this.direction === 'forward' || this.direction === 'reverse')) {
      if (/^Iteration\s+E\(Eh\)\s+dE\(kcal\/mol\)\s+max\(\|G\|\)\s+RMS\(G\)\s*$/i.test(trimmed)) this.ircIterationTable = true;
      else if (this.ircIterationTable) {
        const row = trimmed.split(/\s+/);
        if (row.length === 5 && /^\d+$/.test(row[0]) && row.slice(1).every(token => num(token) !== null) && this.budget(5)) {
          const labels = ['E(Eh)', 'dE(kcal/mol)', 'max(|G|)', 'RMS(G)'];
          const fields: ScientificField[] = row.slice(1).map((token, index) => ({ key: labels[index], label: labels[index], value: num(token)!, rawValue: token,
            origin: 'observation', sourceLine: line.number, frameIndex: null, ...(index < 2 ? { unit: index === 0 ? 'hartree' : 'kcal/mol' } : {}) }));
          this.storage.reserveIndices();
          (this.data.pathIterations ??= []).push({ iteration: indexNumber(row[0]), stageId: 'irc-' + this.direction, pathDirection: this.direction, sourceLine: line.number, raw: text, fields });
        } else if (trimmed && !/^Convergence thresholds\s+/.test(trimmed)) this.ircIterationTable = false;
      }
    }
    if (this.scfTotalContext && trimmed === 'DFT components:') this.nativeDftComponents = { sourceLine: line.number, raw: trimmed };
    if (this.scfTotalContext && this.nativeDftComponents && trimmed === 'UHF SPIN CONTAMINATION') {
      this.data.reference = 'unrestricted';
      this.field(this.data.properties, 'reference-state', 'Native unrestricted reference in a DFT SCF evaluation', trimmed, line, undefined, trimmed, 'program-adopted');
      if (this.frequencyMethod === 'unknown' || this.frequencyMethod === 'scf' || this.frequencyMethod === 'udft') {
        this.frequencyMethod = 'udft';
        this.frequencyEvidence = this.frequencyEvidence.filter(row => row.field !== 'method' && row.field !== 'reference');
        if (this.budget(2)) this.frequencyEvidence.push({ sourceLine: this.nativeDftComponents.sourceLine, kind: 'printed', field: 'method', value: this.nativeDftComponents.raw }, { sourceLine: line.number, kind: 'printed', field: 'reference', value: trimmed });
      }
    }
    const nativeMaxcore = trimmed.match(/^NOTE: MaxCore=(\d+) MB was set to (?:SCF|MP2|MDCI|CIPSI|MRCI|RASCI|CIS)(?:(?:,| and )(?:SCF|MP2|MDCI|CIPSI|MRCI|RASCI|CIS))*\s*$/);
    if (nativeMaxcore) this.field(this.data.properties, 'adopted-maxcore-mb-per-process', 'Native MaxCore setting per MPI process (not measured RSS)', Number(nativeMaxcore[1]), line, 'MB', nativeMaxcore[1], 'program-adopted');
    const nativeMpi = trimmed.match(/^\*\s+Program running with (\d+) parallel MPI-processes\s+\*$/);
    if (nativeMpi) this.field(this.data.properties, 'adopted-mpi-processes', 'Native adopted MPI process count (not measured CPU utilization)', Number(nativeMpi[1]), line, undefined, nativeMpi[1], 'program-adopted');
    if (this.readNativeMd(line)) return;
    if (!this.numericalFrequency || this.frequencyResults) {
      const au = this.auReader.consume(text, line.number);
      if (au.started) this.snapshotAuLine = line.number;
      if (au.table && !au.started) this.snapshotAuLine = null;
      if (au.table) this.applyNuclearTable(au.table);
      if (au.consumed) return;
    }
    if (this.readNmrCouplings(line)) return;
    if (/^\s*\**\s*ORCA ESD FINISHED WITHOUT ERROR\s*\**\s*$/i.test(text)) { this.task('esd'); this.taskStatus({ task: 'esd', status: 'completed', sourceLine: line.number, raw: text }); this.field(this.data.properties, 'esd-module-status', 'Native ESD module status', text.trim(), line); }
    const printedBasis = trimmed.match(/^Your calculation utilizes the (basis|auxiliary basis):\s*(.+)\s*$/i);
    if (printedBasis) this.field(this.data.properties, printedBasis[1].toLowerCase() === 'basis' ? 'printed-orbital-basis' : 'printed-auxiliary-basis', 'Program printed ' + printedBasis[1], printedBasis[2], line, undefined, printedBasis[2], 'program-adopted');
    const referenceType = text.match(/(?:\bHFTyp|^\s*Hartree-Fock type(?:\s+HFTyp)?|^\s*Reference (?:wavefunction|state))\s*(?:\.{2,}|:|=)\s*(RHF|RKS|UHF|UKS|ROHF)\b/i);
    if (referenceType) {
      this.data.reference = /^U/i.test(referenceType[1]) ? 'unrestricted' : /^RO/i.test(referenceType[1]) ? 'restricted-open' : 'restricted';
      this.field(this.data.properties, 'reference-state', '参考态（打印）', referenceType[1].toUpperCase(), line, undefined, referenceType[1], 'program-adopted');
      this.frequencyEvidence=this.frequencyEvidence.filter(row=>row.field!=='reference');this.frequencyEvidence.push({sourceLine:line.number,kind:'printed',field:'reference',value:referenceType[1]});
    }
    const count = text.match(/(?:Number of atoms|# of atoms)\s*[.:=]*\s*(\d+)\s*$/i);
    if (count) { this.expected = Number(count[1]); if (!Number.isSafeInteger(this.expected) || this.expected < 1) throw new Error('ORCA原子数须为正安全整数。'); this.expectedWitness = { value: this.expected, rawValue: count[1], sourceLine: line.number }; }
    const basisCount = trimmed.match(/^Number of basis functions\s*\.{2,}\s*(\d+)\s*$/i);
    if (basisCount) this.field(this.data.properties, 'basis-functions-program-adopted', 'Native adopted basis function count', indexNumber(basisCount[1]), line, 'functions', basisCount[1], 'program-adopted');
    if (/^\s*[*=\s]*NEB OPTIMIZATION[*=\s]*$/i.test(text)) { this.flush(); this.stageId = 'neb-path'; this.nebSaddleEvidence = null; this.task('neb'); }
    if (this.data.tasks.includes('neb') && /^\s*[*=\s]*(?:TS|TRANSITION STATE)\s+OPTIMIZATION[*=\s]*$/i.test(text)) {
      this.flush(); this.stageId = 'ts-optimization'; this.nebSaddleEvidence = null; this.optimized = false; this.node = null; this.step = null; this.nebIteration = undefined; this.nebImage = undefined; this.label = undefined; this.task('opt'); this.task('ts');
    }
    const images = text.match(/Number of images\s*\(incl\. end points\)\s*\.*\s*(\d+)/i);
    if (images) { const value = indexNumber(images[1]); if (value >= 2 && Number.isSafeInteger(value)) this.data.pathImageCount = value; }
    const referenced = text.match(/(Current trajectory will be written to|Trajectory history will be written to|Storing full IRC trajectory in|Storing (?:forward|backward) trajectory in|and to allxyz file)\s*\.*\s+(\S+\.(?:xyz|allxyz))\s*$/i);
    if (referenced && this.budget()) {
      const label = referenced[1], role = /history/i.test(label) ? 'neb-iterations' : /full IRC/i.test(label) ? 'irc-full' : /(?:forward|backward)/i.test(label) ? 'irc-branch'
        : this.stageId === 'ts-optimization' ? 'ts-optimization-trajectory' : this.stageId === 'neb-path' ? 'neb-path' : 'optimization-trajectory';
      if (!/and to allxyz/i.test(label) || this.referencedPathRole === 'neb-path') {
        (this.data.relatedFiles ??= []).push({ name: referenced[2], role, sourceLine: line.number });
        this.referencedPathRole = role === 'neb-path' ? 'neb-path' : null;
      }
    }
    if (/^\s*(?:IRC )?PATH SUMMARY\s*$/i.test(text)) { this.pathSummaryKind = /IRC/i.test(text) ? 'irc' : this.data.tasks.includes('neb') ? 'neb' : null; this.pathSummaryColumns = false; this.snapshotPathSummaryLine = this.pathSummaryKind ? line.number : null; }
    if (this.pathSummaryKind && /^\s*(?:Step\s+E\(Eh\)|Image\s+Dist\.\(Ang\.\)\s+E\(Eh\))/i.test(text)) this.pathSummaryColumns = true;
    else if (this.pathSummaryKind && this.pathSummaryColumns) {
      const tokens = trimmed.split(/\s+/), node = /^\d+$/.test(tokens[0]) ? Number(tokens[0]) : null;
      const energyToken = tokens[this.pathSummaryKind === 'irc' ? 1 : 2], energy = energyToken ? num(energyToken) : null;
      const completeIrcRow = this.pathSummaryKind !== 'irc' || tokens.length >= 5 && tokens.slice(0, 5).every(token => num(token) !== null)
        && (tokens.length === 5 || tokens.length === 7 && tokens[5] === '<=' && tokens[6] === 'TS');
      if (node !== null && energy !== null && completeIrcRow && this.budget()) {
        const [mantissa, exponent = '0'] = energyToken.replace(/[dD]/, 'e').toLowerCase().split('e');
        const decimals = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
        const coordinate = this.pathSummaryKind === 'neb' && num(tokens[1]) !== null ? { value: num(tokens[1])!, unit: 'angstrom', label: 'Path distance (printed)' } : undefined;
        (this.data.pathSummary ??= []).push({ kind: this.pathSummaryKind, sourceNode: node, energy, rawEnergy: energyToken, rawUnit: 'Eh', stageId: this.pathSummaryKind === 'irc' ? 'irc' : 'neb-path', energyRounding: .5 * 10 ** (Number(exponent) - decimals), unit: 'hartree', sourceLine: line.number, ...(/<=\s*TS\b/i.test(text) ? { isTs: true } : {}), ...(coordinate ? { coordinate } : {}) });
      } else if (trimmed && !dash.test(text)) { this.pathSummaryKind = null; this.pathSummaryColumns = false; this.snapshotPathSummaryLine = null; }
    }
    if (/^\s*\**\s*(?:ORCA finished by error termination|ORCA TERMINATED ABNORMALLY|SCF NOT CONVERGED|(?:THE )?(?:NEB )?OPTIMIZATION (?:HAS |DID )?(?:NOT CONVERGED|NOT CONVERGE|FAILED)|maximum number of (?:optimization )?(?:cycles|iterations) reached|Number of steps exceeded)\b/i.test(text)) {
      this.error(line, /SCF NOT CONVERGED/i.test(text) ? 'scf' : /MAXIMUM NUMBER OF ITERATIONS REACHED\s*-\s*STOPPING IRC RUN/i.test(text) || this.stageId === 'neb-path' && !/^\s*ORCA finished/i.test(text) ? 'path' : /optimization|steps|cycles|iterations/i.test(text) ? 'optimization' : 'runtime');
    }
    if (/^\[file\s+[^\]]*main_input_check\.cpp,\s*line\s+\d+\]:\s*.*(?:not available|not supported|cannot|error|must)/i.test(trimmed)) this.error(line, 'input-check');
    if (/MAXIMUM NUMBER OF ITERATIONS REACHED\s*-\s*STOPPING IRC RUN/i.test(text)) { this.failed = true; this.notice('IRC达到最大迭代数；已输出路径保留，未称为收敛路径。'); }
    if (this.ircPhase && (this.direction === 'forward' || this.direction === 'reverse') && /^\s*\**\s*THE IRC HAS CONVERGED\s*\**\s*$/i.test(text)) this.taskStatus({ task: 'path', status: 'completed', sourceLine: line.number, stageId: 'irc-' + this.direction, frameIndex: null, raw: text });
    if (/^\s*\**\s*THE NEB OPTIMIZATION HAS CONVERGED\b|^\s*The elastic band(?: and climbing image)? (?:have|has) converged successfully\b/i.test(text)) { this.nebConverged = true; this.field(this.data.summary, 'neb-converged', 'NEB convergence (printed)', text.trim(), line); this.taskStatus({ task: 'path', status: 'completed', sourceLine: line.number, stageId: 'neb-path', raw: text }); }
    if (/^\s*\**\s*ORCA TERMINATED NORMALLY\s*\**\s*$/i.test(text)) {
      this.terminated = true;
      this.diagnostics().termination = { status: 'normal', sourceLine: line.number, raw: text };
      if (this.compoundStart !== null) for (const previous of this.jobs.slice(this.compoundStart)) {
        if (previous.status === 'incomplete' && !previous.messages.some(m => /坐标|无效/.test(m)) && (!previous.data.tasks.includes('opt') || previous.data.summary.some(f => f.key === 'optimization-converged'))) previous.status = 'completed';
        previous.messages = previous.messages.filter(m => !m.startsWith('未检测到此作业正常终止'));
        previous.messages.push('所属ORCA compound总流程正常终止；各job的优化收敛证据独立。');
      }
    }
    if (/^\s*\**\s*THE OPTIMIZATION HAS CONVERGED\b/i.test(text)) { this.optimized = true;this.optimizationGeometrySourceLine=(this.pending?.geometry??this.frames.at(-1)?.geometry)?.line??null; if (this.pending && this.data.tasks.includes('scan')) this.pending.pathPoint = true; this.field(this.data.summary, 'optimization-converged', 'Optimization converged', 'yes', line); this.taskStatus({ task: this.stageId === 'ts-optimization' ? 'ts-optimization' : 'optimization', status: 'completed', sourceLine: line.number, frameIndex: this.frameIndex(), stageId: this.stageId, raw: text }); }
    if (/^\s*\**\s*SCF CONVERGED(?:\s+AFTER\s+\d+\s+CYCLES?)?\b/i.test(text)) this.scfStatus({ status: 'converged', sourceLine: line.number, frameIndex: this.frameIndex(), raw: text });
    const numericalStart=/^\s*(?:ORCA\s+)?NUMERICAL (?:FREQUENCIES|FREQUENCY CALCULATION|HESSIAN)(?:\s*\([^)]*\))?\s*$/i.test(text)||/^\s*(?:Numerical (?:differentiation|calculation of force constants)|Numerically calculating)\b/i.test(text);
    if (numericalStart&&(this.pending||this.frames.length)) {
      if (!this.ircPhase) { this.task('freq'); this.frequencySnapshot = this.frequencyTarget(); }
      this.flush(); this.numericalFrequency = true; this.frequencyResults = false;
      this.notice(this.ircPhase ? 'IRC初始数值Hessian位移仅用于路径准备；其电子态、性质及能量未覆盖驻点评估。' : '数值频率位移未作为优化轨迹；其电子态、性质及能量未覆盖驻点评估。');
    }
    const cycle = text.match(/GEOMETRY OPTIMIZATION CYCLE\s+(\d+)/i);
    if (cycle) { this.flush(); this.task('opt'); this.step = indexNumber(cycle[1]); this.numericalFrequency = false; if (!this.data.tasks.includes('scan') && !this.data.tasks.includes('irc')) this.label = undefined; this.section = 'none'; }
    if (/FINAL ENERGY EVALUATION AT THE STATIONARY POINT/i.test(text)) { this.flush(); this.label = '最终驻点评估'; this.step = null; this.numericalFrequency = false; }
    if (/RELAXED SURFACE SCAN|SURFACE SCAN/i.test(text)) this.task('scan');
    if (/^\s*\**\s*Parameter Scan Calculation\s*\**\s*$/i.test(text)) { this.parameterScan = true; this.task('scan'); }
    if (this.parameterScan) {
      const range = trimmed.match(new RegExp(`^([A-Za-z]\\w*):\\s*range=\\s*(${N})\\s*\\.\\.\\s*(${N})\\s+steps=\\s*(\\d+)\\s*$`, 'i'));
      if (range) {
        const key = range[1].toLowerCase(), unit = this.parameterUnits.get(key) ?? undefined;
        this.scanParameters.add(key);
        this.field(this.data.properties, `parameter-scan-${key}-start`, `Native Parameter Scan ${range[1]} range start`, num(range[2])!, line, unit, range[2], 'program-adopted');
        this.field(this.data.properties, `parameter-scan-${key}-end`, `Native Parameter Scan ${range[1]} range end`, num(range[3])!, line, unit, range[3], 'program-adopted');
        this.field(this.data.properties, `parameter-scan-${key}-steps`, `Native Parameter Scan ${range[1]} point count`, indexNumber(range[4]), line, undefined, range[4], 'program-adopted');
      }
      const point = trimmed.match(/^TRAJECTORY STEP\s+(\d+)\s*$/i);
      if (point) { this.flush(); this.node = indexNumber(point[1]); this.step = null; this.label = `Scan node ${point[1]}`; this.coordinate = undefined; this.detached = true; this.parameterPoint = true; this.section = 'none'; }
      const value = this.parameterPoint ? trimmed.match(new RegExp(`^([A-Za-z]\\w*)\\s*:\\s*(${N})\\s*$`)) : null;
      if (value && this.scanParameters.has(value[1].toLowerCase())) {
        const unit = this.parameterUnits.get(value[1].toLowerCase()) ?? undefined;
        this.field(this.data.properties, `parameter-scan-${this.node}-${value[1].toLowerCase()}`, `Native Parameter Scan ${value[1]} point value`, num(value[2])!, line, unit, value[2]);
        if (this.scanParameters.size === 1) this.coordinate = { value: num(value[2])!, sourceValue: num(value[2])!, unit: unit ?? 'printed (unit not specified)', label: value[1] };
      }
    }
    const nebIteration = text.match(/\bNEB\s+(?:OPTIMIZATION\s+)?(?:ITERATION|CYCLE)\s*[:=]?\s*(\d+)/i);
    if (nebIteration) { this.flush(); this.task('neb'); this.stageId = 'neb-path'; this.nebIteration = indexNumber(nebIteration[1]); this.nebImage = undefined; this.step = null; this.node = null; }
    const nebImage = text.match(/^\s*(?:NEB\s+)?IMAGE\s*[:=]?\s*(\d+)\s*(?:$|[:(])/i);
    if (nebImage && this.stageId === 'neb-path') { this.flush(); this.nebImage = indexNumber(nebImage[1]); this.label = `NEB image ${this.nebImage}`; }
    if (this.data.tasks.includes('neb') && /(?:Starting|Beginning|Switching to)\s+(?:the\s+)?(?:TS|transition.state)\s+optimization|^\s*TRANSITION STATE OPTIMIZATION\s*$/i.test(text)) {
      this.flush(); this.stageId = 'ts-optimization'; this.nebSaddleEvidence = null; this.optimized = false; this.nebIteration = undefined; this.nebImage = undefined; this.node = null; this.step = null; this.label = undefined; this.task('opt'); this.task('ts');
    }
    if (this.stageId === 'neb-path') {
      const tableHeader = trimmed.match(/^Optim\.\s+Iteration\s+(HEI|CI)\s+(E\((?:HEI|CI)\)-E\(0\))\s+max\(\|Fp\|\)\s+RMS\(Fp\)\s+dS(?:\s+max\(\|FCI\|\)\s+RMS\(FCI\))?\s*$/i);
      if (tableHeader) this.nebTableColumns = ['optimizer', 'iteration', tableHeader[1], tableHeader[2], 'max(|Fp|)', 'RMS(Fp)', 'dS', ...(/FCI/i.test(trimmed) ? ['max(|FCI|)', 'RMS(FCI)'] : [])];
      const row = trimmed.split(/\s+/);
      if (this.nebTableColumns.length && row.length === this.nebTableColumns.length && /^[A-Za-z][\w-]*$/.test(row[0]) && /^\d+$/.test(row[1]) && /^\d+$/.test(row[2]) && row.slice(3).every(token => num(token) !== null) && this.budget(row.length)) {
        const fields: ScientificField[] = row.map((token, column) => ({ key: this.nebTableColumns[column], label: this.nebTableColumns[column], value: column === 0 ? token : num(token)!, rawValue: token, sourceLine: line.number, frameIndex: null }));
        this.storage.reserveIndices();
        (this.data.pathIterations ??= []).push({ iteration: indexNumber(row[1]), sourceLine: line.number, raw: text, fields });
      }
    }
    const scan = text.match(/(?:RELAXED\s+)?(?:SURFACE\s+)?SCAN\s+(?:STEP|POINT)\s*[:=]?\s*(\d+)/i);
    if (scan) { this.flush(); this.task('scan'); this.node = indexNumber(scan[1]); this.label = `Scan node ${scan[1]}`; this.step = null; this.section = 'none'; }
    const irc = text.match(/IRC\s+(?:PATH\s+)?(?:STEP|POINT)\s*[:=]?\s*(\d+)/i);
    if (irc) { this.flush(); this.task('irc'); this.node = indexNumber(irc[1]); this.label = `IRC point ${irc[1]}`; this.step = indexNumber(irc[1]); this.numericalFrequency = false; }
    if (/^\s*IRC\s+(?:FORWARD|REVERSE|BACKWARD)\s*$/i.test(text)) { this.task('irc'); this.direction = /FORWARD/i.test(text) ? 'forward' : 'reverse'; }
    const path = text.match(new RegExp(`(?:Reaction coordinate|IRC coordinate|Path coordinate)\\s*[.:=]*\\s*(${N})(?:\\s+(.+))?`, 'i'));
    if (path && num(path[1]) !== null) { this.coordinate = { value: num(path[1])!, unit: path[2]?.trim() || 'printed (unit not specified)', label: 'ORCA printed path coordinate' }; if (this.pending) this.pending.coordinate = this.coordinate; }
    if (/CARTESIAN COORDINATES\s*\((?:ANGSTROEM|ANGSTROM)\)/i.test(text)) {
      this.flush(); this.detached = true; this.section = 'none'; this.snapshotGeometryLine = line.number; this.block = { start: line.end, end: line.end, line: line.number, elements: [], bad: false }; return;
    }
    const final = text.match(new RegExp(`^\\s*FINAL SINGLE POINT ENERGY\\s+(${N})\\s*$`, 'i'));
    if (final && num(final[1]) !== null && !this.numericalFrequency) {
      const value = num(final[1])!;
      // An ORCA final energy is the printed method total; a bare SCF total is not.
      const excitedOptimization = (this.data.tasks.includes('opt')||this.data.tasks.includes('freq')) && this.data.tasks.includes('td');
      const geometry=this.pending?.geometry??this.frames.at(-1)?.geometry;
      const gradientTarget=excitedOptimization&&geometry&&this.tdGradientGeometrySourceLine===geometry.line&&this.frequencyRoot?.kind==='printed'&&(this.frequencyRoot.geometrySourceLine===undefined||this.frequencyRoot.geometrySourceLine===geometry.line);
      if (this.pending && (!excitedOptimization||gradientTarget)) this.pending.energy = value;
      if (this.pending && this.parameterScan) this.pending.pathPoint = true;
      if((!excitedOptimization||gradientTarget)&&geometry)this.targetEnergy={value,sourceLine:line.number,geometrySourceLine:geometry.line};
      if(gradientTarget)this.field(this.data.summary,'excited-total-energy','目标激发态总能量 E*',value,line,'hartree',final[1]);
      else if (excitedOptimization) this.notice('TD任务的FINAL SINGLE POINT ENERGY缺少同几何目标梯度证据；未将参考能量用于目标曲线。');
      this.field(this.data.summary, 'final-energy', '最终单点能 E(FINAL SINGLE POINT)', value, line, 'hartree',final[1]);
      const printedEnergy = this.data.summary.at(-1);
      if (printedEnergy?.key === 'final-energy' && printedEnergy.sourceLine === line.number) {
        printedEnergy.rawLabel = text.slice(0, text.lastIndexOf(final[1])).trim();
        if (this.ircPhase) {
          printedEnergy.stageId = this.stageId ?? 'irc';
          printedEnergy.label = this.direction === 'forward' ? 'IRC正向单点能 E(FINAL SINGLE POINT)'
            : this.direction === 'reverse' ? 'IRC反向单点能 E(FINAL SINGLE POINT)' : 'IRC阶段单点能 E(FINAL SINGLE POINT)';
        }
      }
    }
    const tdEnergy = text.match(new RegExp(`(?:E\\(TD-(?:DFT|HF|KS)\\)|Total excited state energy)\\s*[:=]\\s*(${N})`, 'i'));
    if (tdEnergy && num(tdEnergy[1]) !== null && !this.numericalFrequency) {
      this.task('td'); if (this.pending) this.pending.energy = num(tdEnergy[1])!;
      const geometry=this.pending?.geometry??this.frames.at(-1)?.geometry;if(geometry)this.targetEnergy={value:num(tdEnergy[1])!,sourceLine:line.number,geometrySourceLine:geometry.line};
      this.field(this.data.summary, 'excited-total-energy', '目标激发态总能量 E*', num(tdEnergy[1])!, line, 'hartree',tdEnergy[1]);
    }
    const convergence = text.match(new RegExp(`^\\s*(Energy change|RMS gradient|MAX gradient|RMS step|MAX step)\\s+(${N})\\s+(${N})\\s+(YES|NO)\\b`, 'i'));
    if (convergence && this.pending && num(convergence[2]) !== null && num(convergence[3]) !== null) this.pending.convergence.push({ label: convergence[1], value: num(convergence[2])!, threshold: num(convergence[3]), converged: convergence[4].toUpperCase() === 'YES', unit: /energy/i.test(convergence[1]) ? 'hartree' : /gradient/i.test(convergence[1]) ? 'hartree/bohr' : 'bohr' });
    if (this.readSectionHeader(line)) { this.snapshotSectionLine = this.section === 'none' ? null : line.number; return; }
    this.readSectionLine(line);
    this.readFields(line);
  }

  private readSectionHeader(line: ScientificLine): boolean {
    const t = line.text.trim();
    const simplified = t.match(/^ORCA\s+(sTD-DFT|sTDA)\s+CALCULATION$/i);
    if (simplified) {
      this.simplifiedMethod = /^sTDA$/i.test(simplified[1]) ? 'sTDA' : 'sTDDFT'; this.simplifiedRows = []; this.section = 'none'; this.task('td');
      this.field(this.data.properties, 'simplified-spectrum-method', 'Native simplified response method', this.simplifiedMethod, line, undefined, t);
      return true;
    }
    if (this.simplifiedMethod && /^state\s+eV\s+nm\s+fL\s+fV\s+Rl\s+RV\s*$/i.test(t)) {
      this.section = 'simplified'; this.simplifiedRows = []; this.excitationBatch = []; return true;
    }
    if (this.simplifiedMethod && /^ORCA PROPERTY CALCULATIONS$/i.test(t)) { this.simplifiedMethod = null; this.simplifiedRows = []; this.section = 'none'; return true; }
    if (/^CPCM SOLVATION MODEL$/i.test(t)) { this.cpcmParameters = true; this.field(this.data.properties, 'cpcm-model', 'Native solvation model', 'CPCM', line, undefined, t, 'program-adopted'); return true; }
    if (/^DIPOLE MOMENT$/i.test(t)) {
      this.section = 'none';
      this.dipoleContext = { sourceLine: line.number, vectors: [], sawMagnitude: false };
      this.field(this.data.properties, 'dipole-block', 'Printed dipole-density property block', t, line);
      return true;
    }
    if (/^SCF ITERATIONS$/i.test(t)) {
      this.section = 'scf'; this.scf = null; this.scfNativeRow = null;
      if (this.budget()) { this.scf = { frameIndex: this.frameIndex(), sourceLine: line.number, points: [] }; this.data.scfCycles.push(this.scf); }
      return true;
    }
    if (/^Iteration\s+Energy\s*\(Eh\)\s+Delta-E\s+RMSDP\s+MaxDP\s+(?:DIISErr\s+Damp|MaxGrad)\s+Time\(sec\)\s*$/i.test(t)) {
      this.scfNativeRow = /DIISErr\s+Damp/i.test(t) ? diisScfRow : soscfScfRow;
      // Switching DIIS to SOSCF is another header of this same native attempt.
      if (this.section === 'scf' && this.scf) { this.scf.unit = 'hartree'; this.scf.deltaEnergyUnit = 'hartree'; return false; }
      this.section = 'scf';
      if (this.budget()) { this.scf = { frameIndex: this.frameIndex(), sourceLine: line.number, unit: 'hartree', deltaEnergyUnit: 'hartree', points: [] }; this.data.scfCycles.push(this.scf); }
      return true;
    }
    if (/^ORBITAL ENERGIES$/i.test(t)) { this.section = 'orbitals'; this.orbital = null; this.orbitalSpin = 'restricted'; return true; }
    if (/^VIBRATIONAL FREQUENCIES$/i.test(t)) {
      // Mode numbers restart in every frequency calculation, even within one job.
      // Finalize the prior group's vectors before installing a new current group.
      this.finishModes();
      this.spectrumValueColumn = null; this.irMomentColumn = null; this.spectrumUnit = undefined;
      this.irUnitHeaderPending=false;
      this.frequencyGroupAccepted = this.budget();
      if (this.numericalFrequency && this.frames.length) this.detached = false;
      this.task('freq'); this.section = 'frequencies';
      if (!this.frequencyGroupAccepted) { this.section = 'none'; return true; }
      const frameIndex = this.frameIndex(), bound = frameIndex !== null && this.inventory !== null;
      this.modeRawAvailability = null; this.modeRawIncomplete = false; this.modeRawVectors.clear(); this.modeAvailableIndices.clear(); this.modeTableSeen = false; this.modesPending = false; this.modeConventionLines = [];
      this.data.vibrations = { frameIndex: bound ? frameIndex : null, atomBinding: bound ? 'geometry-bound' : 'unavailable', modes: [], convention: bound ? 'ORCA printed frequencies and Cartesian normal-mode vectors; no additional scaling applied' : 'ORCA printed frequencies; raw NORMAL MODES components, if printed, remain unbound source-order observations, not for animation; no scaling applied.', electronicTarget: this.frequencySnapshot ?? this.frequencyTarget(), ...(this.expectedWitness && this.budget() ? { sourceAtomCount: { ...this.expectedWitness } } : {}) };
      if (!bound) {
        this.fieldStatus({ field: 'normal-mode-atom-binding', status: 'partial', frameIndex: null, sourceLine: line.number, message: '没有可确认的本段ordinary geometry/atom order；原分量不作为位移动画。' });
        if (!this.frames.length && !this.pending && !this.data.centers?.length) this.fieldStatus({ field: 'geometry', status: 'not-printed', frameIndex: null, sourceLine: line.number, message: '本job未打印可绑定的普通Cartesian几何；不从输入或HESS补造。' });
      }
      (this.data.vibrationSets ??= []).push(this.data.vibrations);
      return true;
    }
    if (/^NORMAL MODES$/i.test(t)) {
      this.section = this.frequencyGroupAccepted ? 'modes' : 'none'; this.modeColumns = [];
      if (this.frequencyGroupAccepted) {
        this.modeTableSeen = true; this.modesPending = true;
        if (this.data.vibrations?.atomBinding === 'unavailable') {
          this.modeAvailableIndices = new Set(this.data.vibrations.modes.map(mode => mode.index));
          if (!this.modeRawAvailability && this.budget()) { this.modeRawAvailability = { field: 'normal-mode-raw-components', status: 'partial', frameIndex: null, sourceLine: line.number }; this.diagnostics().fields.push(this.modeRawAvailability); }
          else if (this.modeRawAvailability) { this.modeRawAvailability.status = 'partial'; this.modeRawAvailability.sourceLine = line.number; }
        }
      }
      return true;
    }
    if (/^IR SPECTRUM$/i.test(t)) { this.finishModes(); this.section = this.frequencyGroupAccepted ? 'ir' : 'none'; this.spectrumValueColumn = null; this.irMomentColumn = null;this.spectrumUnit=undefined;this.irUnitHeaderPending=false; return true; }
    if (/^RAMAN SPECTRUM$/i.test(t)) { this.finishModes(); this.section = this.frequencyGroupAccepted ? 'raman' : 'none'; this.spectrumValueColumn = null; this.spectrumUnit = undefined; return true; }
    if (/^THERMOCHEMISTRY AT\s+[\d.]+\s*K\s*$/i.test(t)) { this.finishModes(); this.section = 'none'; this.thermo = true; this.task('freq'); return true; }
    if (/^(?:MULLIKEN|LOEWDIN|HIRSHFELD).*(?:ATOMIC CHARGES|ATOMIC POPULATIONS)/i.test(t)) {
      this.section = 'atomic'; this.atomic = null;
      if (this.budget()) { this.atomic = { kind: 'charge', scheme: t.split(/\s/)[0], frameIndex: this.frameIndex(), sourceLine: line.number, values: [], unit: 'e' }; this.data.atomicProperties.push(this.atomic); }
      if (/SPIN/i.test(t)) this.notice('原子电荷与自旋列按打印表头分别保存。');
      return true;
    }
    if (/CHEMICAL SHIELDING SUMMARY|NMR SHIELDING SUMMARY/i.test(t)) {
      this.task('nmr'); this.section = 'shielding'; this.atomic = null;
      if (this.budget()) { this.atomic = { kind: 'shielding', scheme: 'ORCA isotropic shielding', frameIndex: this.frameIndex(), sourceLine: line.number, values: [], unit: 'ppm' }; this.data.atomicProperties.push(this.atomic); }
      this.notice('保存NMR shielding；未提供参考屏蔽值，不转换为chemical shift。'); return true;
    }
    if (/TD-DFT.*EXCITED STATES|CIS.*EXCITED STATES|TDA.*EXCITED STATES/i.test(t)) {
      this.simplifiedMethod = null; this.simplifiedRows = [];
      const multiplicity = /SINGLETS/i.test(t) ? 'singlet' : /TRIPLETS/i.test(t) ? 'triplet' : null;
      if (this.section !== 'excited' || this.excitationBatch[0]?.frameIndex !== this.frameIndex() || multiplicity === this.excitedMultiplicity) { this.excitationBatch = []; this.excitationWaveNumbers.clear(); }
      this.task('td'); this.section = 'excited'; this.excited = null;
      this.excitedMultiplicityEstimated = false;
      this.frequencyMethod=/TDA|CIS/i.test(t)?'tda':'td';this.frequencyEvidence=this.frequencyEvidence.filter(row=>row.field!=='method');this.frequencyEvidence.push({sourceLine:line.number,kind:'printed',field:'method',value:t});
      this.excitedMultiplicity = multiplicity; return true;
    }
    if (/(?:ABSORPTION|CD) SPECTRUM VIA/i.test(t)) {
      // Velocity-gauge oscillator strengths and CD rotatory strengths are
      // different observables. Only the electric-dipole absorption table owns f.
      this.absorptionColumns = null;
      this.absorptionEnergyUnit = null;
      this.section = /^ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS$/i.test(t) ? 'absorption' : 'none';
      if (this.section === 'absorption') this.task('td');
      return true;
    }
    if (/^(?:(?:SCF|WAVEFUNCTION) )?STABILITY ANALYSIS(?:\s*\([^)]*\))?$/i.test(t)) { this.task('stability'); this.stabilityContext = true; this.snapshotStabilityLine = line.number; this.section = 'none'; this.field(this.data.stability, 'tested-scope', 'Printed stability test scope', t, line); return true; }
    if (/geometrical counterpoise|gCP(?:\+bas)? correction/i.test(t)) this.bsseContext = 'gcp';
    else if (/Boys.Bernardi|COUNTERPOISE CORRECTION|BSSE CORRECTION/i.test(t)) { this.task('bsse'); this.bsseContext = 'bb-cp'; }
    return false;
  }
  private readSectionLine(line: ScientificLine) {
    const t = line.text.trim(), fields = t.split(/\s+/);
    if (this.section === 'simplified' && (!t || dash.test(t)) && this.simplifiedRows.length) { this.section = 'none'; this.snapshotSectionLine = null; return; }
    if (!t || dash.test(t)) return;
    if (this.section === 'simplified') {
      const row = t.match(new RegExp(`^(\\d+)\\s+(${N})\\s+(${N})\\s+(${N})\\s+(${N})\\s+(${N})\\s+(${N})(?:\\s+.*)?$`));
      if (!row || !this.simplifiedMethod) { this.section = 'none'; this.snapshotSectionLine = null; return; }
      const values = row.slice(2, 8).map(token => num(token));
      if (values.some(value => value === null) || values[0]! <= 0 || values[1]! <= 0 || values[2]! < 0 || !this.budget()) return;
      const state: ExcitedState = { index: indexNumber(row[1]), label: `${this.simplifiedMethod} STATE ${row[1]} (printed index)`, multiplicity: null, frameIndex: this.frameIndex(), energyEv: values[0]!, wavelengthNm: values[1]!, oscillatorStrength: values[2]!, transitions: [], sourceLine: line.number };
      this.data.excitedStates.push(state); this.excitationBatch.push(state); this.simplifiedRows.push(state); this.simplifiedStates.add(state);
      // Preserve trailing native amplitudes without assigning an unprinted
      // weight/spin convention or inventing one-based response roots.
      this.field(this.data.properties, `simplified-spectrum-row:${line.number}`, 'Native simplified spectrum row and amplitudes', line.text, line, undefined, line.text);
      for (const [index, label] of [[5, 'fV'], [6, 'Rl'], [7, 'RV']] as const) this.field(this.data.properties, `simplified-spectrum-${label}:${line.number}`, `Native simplified ${label} (printed)`, num(row[index])!, line, undefined, row[index]);
    } else if (this.section === 'scf') {
      const row = t.match(this.scfNativeRow ?? new RegExp(`^(\\d+)\\s+(${N})\\s+(${N})\\s+`));
      if (row && this.scf && num(row[2]) !== null && num(row[3]) !== null && this.budget(2)) this.scf.points.push({ iteration: indexNumber(row[1]), energy: num(row[2])!, deltaEnergy: num(row[3]), rawEnergy: row[2], rawDeltaEnergy: row[3], sourceLine: line.number });
      if (/SCF CONVERGED|TOTAL SCF ENERGY|SCF NOT CONVERGED/i.test(t)) this.section = 'none';
    } else if (this.section === 'orbitals') {
      if (/SPIN UP ORBITALS/i.test(t)) { this.orbitalSpin = 'alpha'; this.orbital = null; return; }
      if (/SPIN DOWN ORBITALS/i.test(t)) { this.orbitalSpin = 'beta'; this.orbital = null; return; }
      if (fields.length === 4 && /^\d+$/.test(fields[0]) && fields.slice(1).every(v => num(v) !== null)) {
        if (!this.budget(2)) return;
        if (!this.orbital) { this.orbital = { spin: this.orbitalSpin, frameIndex: this.frameIndex(), sourceLine: line.number, unit: 'hartree', orbitals: [] }; this.data.orbitals.push(this.orbital); }
        this.orbital.orbitals.push({ index: indexNumber(fields[0]), occupation: num(fields[1])!, energy: num(fields[2])! });
      } else if (this.orbital?.orbitals.length && !/^NO\s+OCC/i.test(t)) this.section = 'none';
    } else if (this.section === 'atomic' || this.section === 'shielding') {
      const row = t.match(new RegExp(`^(\\d+)\\s+([A-Za-z]{1,2})\\s*:?\\s+(${N})(?:\\s+(${N}))?`));
      if (row && this.atomic && num(row[3]) !== null && Number(row[1]) < (this.inventory?.length ?? Number.MAX_SAFE_INTEGER) && this.budget()) {
        this.atomic.values.push({ atomIndex: Number(row[1]), element: row[2], value: num(row[3])! });
        if (this.section === 'atomic' && row[4] && num(row[4]) !== null && this.budget()) {
          let spin = this.data.atomicProperties.find(p => p.kind === 'spin' && p.sourceLine === this.atomic!.sourceLine);
          if (!spin) { spin = { ...this.atomic, kind: 'spin', unit: 'electron', values: [] }; this.data.atomicProperties.push(spin); }
          spin.values.push({ atomIndex: Number(row[1]), element: row[2], value: num(row[4])! });
        }
      } else if (this.atomic?.values.length && !/Nucleus|Isotropic|Anisotropy|Sum of atomic charges|Total/i.test(t)) this.section = 'none';
    } else if (this.section === 'frequencies') {
      const row = t.match(new RegExp(`^(\\d+):\\s+(${N})\\s+cm(?:\\*\\*|\\^)?-1`, 'i'));
      if (row && num(row[2]) !== null && this.budget()) this.data.vibrations!.modes.push({ index: indexNumber(row[1]), sourceIndex: indexNumber(row[1]), frequency: num(row[2])!, frequencyRounding: scientificRoundingInterval(row[2]), sourceLine: line.number, displacementConvention: this.data.vibrations!.atomBinding === 'geometry-bound' ? 'cartesian' : 'unknown', ...(this.data.vibrations!.atomBinding === 'geometry-bound' && this.inventory ? { atomElements: this.inventory } : {}) });
      const scale = t.match(new RegExp(`(?:Scaling factor|Frequency scaling factor)\\s*[:=.] *(${N})`, 'i'));
      if (scale && num(scale[1]) !== null) this.data.vibrations!.printedScaleFactor = num(scale[1])!;
    } else if (this.section === 'modes') {
      if (this.data.vibrations?.atomBinding === 'unavailable') {
        if (/^(?:These modes are|M\(i,i\)=|Thus, these vectors are)/.test(t) && this.modeConventionLines.length < 3) { this.modeConventionLines.push(t); this.field(this.data.properties, 'normal-mode-source-convention', 'Native NORMAL MODES convention (unbound)', t, line); }
        if (fields.every(value => /^\d+$/.test(value)) && fields.length <= 12) { this.modeColumns = fields.map(indexNumber); return; }
        if (/^\d+$/.test(fields[0]) && this.modeColumns.length) {
          const component = Number(fields[0]), count = this.data.vibrations.sourceAtomCount?.value;
          if (!Number.isSafeInteger(component) || component >= (count ?? Number.MAX_SAFE_INTEGER) * 3) { this.modeRawIncomplete = true; return; }
          if (fields.length !== this.modeColumns.length + 1) this.modeRawIncomplete = true;
          for (let index = 0; index < Math.min(this.modeColumns.length, fields.length - 1); index++) {
            const mode = this.modeColumns[index], token = fields[index + 1], value = num(token);
            if (value === null || !this.modeAvailableIndices.has(mode)) { this.modeRawIncomplete = true; continue; }
            if (!this.budget()) { this.modeRawIncomplete = true; continue; }
            let raw = this.modeRawVectors.get(mode); if (!raw) { raw = []; this.modeRawVectors.set(mode, raw); }
            raw.push({ sourceCoordinateIndex: component, indexBase: 0, value, rawValue: token, sourceLine: line.number });
          }
        }
        return;
      }
      if (fields.every(v => /^\d+$/.test(v)) && fields.length <= 12) { this.modeColumns = fields.map(indexNumber); return; }
      if (/^\d+$/.test(fields[0]) && fields.length === this.modeColumns.length + 1 && fields.slice(1).every(v => num(v) !== null)) {
        const component = Number(fields[0]);
        if (component >= (this.inventory?.length ?? Number.MAX_SAFE_INTEGER) * 3 || !this.budget(fields.length - 1)) return;
        this.modeColumns.forEach((mode, i) => { let vector = this.modeVectors.get(mode); if (!vector) { vector = new Map(); this.modeVectors.set(mode, vector); } vector.set(component, num(fields[i + 1])!);
          this.modeRounding.set(mode, Math.max(this.modeRounding.get(mode) ?? 0, scientificRoundingInterval(fields[i + 1]) ?? 0)); });
      }
    } else if (this.section === 'ir' || this.section === 'raman') {
      if (/^Mode\s+/i.test(t)) {
        // Units in parentheses are header annotations, not extra numeric columns.
        const columns = t.replace(/\([^)]*\)/g, '').trim().split(/\s+/);
        const valueColumn = columns.findIndex(c => this.section === 'ir' ? /^Int(?:ensity)?$/i.test(c) : /^(?:Activity|Activity\b|Raman)$/i.test(c));
        this.spectrumValueColumn = valueColumn >= 0 ? valueColumn : null;
        this.spectrumUnit = this.section === 'ir' && /\bInt(?:ensity)?\s*\(\s*km\s*\/\s*mol\s*\)/i.test(t) ? 'km/mol' : undefined;
        this.irUnitHeaderPending=this.section==='ir'&&this.spectrumValueColumn!==null&&/^freq$/i.test(columns[1]??'')&&this.spectrumUnit===undefined;
        // ORCA 6.1 §5.18.4 explicitly defines Activity as Å⁴/AMU;
        // its canonical four-column table omits the unit from the header.
        if (this.section === 'raman' && /^mode freq activity depolarization$/i.test(columns.join(' '))) this.spectrumUnit = 'Å⁴/amu';
        const momentColumn = columns.findIndex(c => /^T\*\*2$/i.test(c));
        this.irMomentColumn = momentColumn >= 0 ? momentColumn : null;
        if (this.section === 'ir' && this.spectrumValueColumn === null && this.irMomentColumn !== null) this.notice('IR表打印T**2跃迁偶极平方，未将其冒称km/mol强度。');
        return;
      }
      if(this.section==='ir'&&this.irUnitHeaderPending&&/^cm(?:\*\*|\^)?-1$/i.test(fields[0]??'')){
        // The split units row omits Mode's unit: token n belongs to
        // header column n+1. A km/mol token under eps or T**2 is not Int's unit.
        if(this.spectrumValueColumn!==null&&/^km\/mol$/i.test(fields[this.spectrumValueColumn-1]??''))this.spectrumUnit='km/mol';
        this.irUnitHeaderPending=false;return;
      }
      const modeIndex = /^\d+:$/.test(fields[0]) ? Number(fields[0].slice(0, -1)) : null;
      if(modeIndex!==null)this.irUnitHeaderPending=false;
      const mode = modeIndex === null ? undefined : this.data.vibrations?.modes.find(m => m.index === modeIndex);
      const value = this.spectrumValueColumn === null ? null : num(fields[this.spectrumValueColumn] ?? '');
      if (mode && value !== null && this.budget()) {
        if (this.section === 'ir') { mode.irIntensity = value; if (this.spectrumUnit) mode.irIntensityUnit = this.spectrumUnit;else delete mode.irIntensityUnit; }
        else { mode.ramanActivity = value; mode.ramanActivitySourceLine = line.number;
          const canonical = this.spectrumUnit === 'Å⁴/amu' && fields.length === 4 && fields.slice(1).every(token => num(token) !== null);
          mode.ramanActivityConvention = this.ramanDynamic ? 'dynamic' : canonical ? 'static' : 'unknown';
          if (this.ramanExcitationWavelengthNm !== undefined) mode.ramanExcitationWavelengthNm = this.ramanExcitationWavelengthNm;
          if (canonical) { mode.ramanActivityUnit = this.spectrumUnit; mode.ramanDepolarization = num(fields[3])!; } }
      }
      const moment = this.irMomentColumn === null ? null : num(fields[this.irMomentColumn] ?? '');
      if (mode && moment !== null) this.field(this.data.properties, `ir-transition-moment-squared-${modeIndex}`, `IR mode ${modeIndex} printed T**2`, moment, line, 'printed T**2');
    } else if (this.section === 'excited') {
      if (/^UHF\/UKS reference:\s*multiplicity estimated based on rounded <S\*\*2> value/i.test(t)) {
        this.excitedMultiplicityEstimated = true;this.notice(`源行${line.number}：${t}`);return;
      }
      const state = t.match(new RegExp(`^STATE\\s+(\\d+):.*?(${N})\\s+eV(?:.*?(${N})\\s+cm)?`, 'i'));
      if (state && num(state[2]) !== null && this.budget()) {
        const printedMult=t.match(/\bMult\s+([1-9]\d*)\s*$/i),multiplicity=printedMult&&(this.excitedMultiplicityEstimated||!this.excitedMultiplicity)?printedMult[1]:this.excitedMultiplicity;
        this.excited = { index: indexNumber(state[1]), label: `STATE ${state[1]} (printed index)`, multiplicity, ...(printedMult&&this.excitedMultiplicityEstimated?{multiplicityProvenance:'native-estimated' as const}:{}), frameIndex: this.frameIndex(), energyEv: num(state[2])!, transitions: [], sourceLine: line.number };
        const spin = t.match(new RegExp(`<S\\*\\*2>\\s*=\\s*(${N})`)); if (spin && num(spin[1]) !== null) this.excited.spinSquared = num(spin[1])!;
        this.data.excitedStates.push(this.excited);
        this.excitationBatch.push(this.excited);
        if (state[3] && num(state[3]) !== null && this.budget()) this.excitationWaveNumbers.set(this.excited, num(state[3])!);
        if(this.frequencyRoot?.value===this.excited.index){const multiplicity=t.match(/\bMult\s+(\d+)\b/i);this.frequencyMultiplicity=multiplicity?Number(multiplicity[1]):this.excitedMultiplicity==='singlet'?1:this.excitedMultiplicity==='triplet'?3:null;if(this.frequencyMultiplicity!==null){this.frequencyEvidence=this.frequencyEvidence.filter(row=>row.field!=='multiplicity');this.frequencyEvidence.push({sourceLine:line.number,kind:'printed',field:'multiplicity',value:String(this.frequencyMultiplicity)});}}
      }
      const transition = t.match(new RegExp(`^(\\d+[ab]?)\\s*(->|<-)\\s*(\\d+[ab]?)\\s*:\\s*(${N})(?:.*?c\\s*=\\s*(${N}))?`, 'i'));
      if (transition && this.excited && num(transition[4]) !== null && this.budget()) {
        const amplitude = transition[5] ? num(transition[5]) : null;
        const fromSpin = transition[1].match(/[ab]$/i)?.[0].toLowerCase(), toSpin = transition[3].match(/[ab]$/i)?.[0].toLowerCase();
        this.excited.transitions.push({ from: transition[1], to: transition[3], direction: transition[2] as '->' | '<-', weight: num(transition[4])!, ...(amplitude === null ? {} : { amplitude }), sourceLine: line.number,
          ...(fromSpin && toSpin ? { spin: fromSpin !== toSpin ? 'mixed' : fromSpin === 'a' ? 'alpha' : 'beta' } : {}) });
      }
    } else if (this.section === 'absorption') {
      if (/^(?:State|Transition)\s/i.test(t)) {
        const columns = fields.slice(1);
        const wavelength = columns.findIndex(value => /^Wavelength$/i.test(value));
        const oscillator = columns.findIndex(value => /^(?:fosc(?:\(D2\)|\(T2\))?|f)$/i.test(value));
        const energy = columns.findIndex(value => /^Energy$/i.test(value));
        this.absorptionColumns = oscillator < 0 ? null : { wavelength, oscillator, energy };
        return;
      }
      if (!this.absorptionColumns) return;
      if (/^\(?cm(?:\*\*|\^)?-1\)?$/i.test(fields[this.absorptionColumns.energy] ?? '')) { this.absorptionEnergyUnit = 'cm^-1'; return; }
      const modern = t.match(/^(\d+)-([1-9]\d*)[A-Za-z\d'"]*\s*->\s*(\d+)-([1-9]\d*)[A-Za-z\d'"]*\s+(.+)$/);
      const legacy = modern ? null : t.match(/^(\d+)\s+(.+)$/);
      if (!modern && !legacy || modern && Number(modern[1]) !== 0) return;
      const index = Number(modern?.[3] ?? legacy![1]), multiplicity = modern ? Number(modern[4]) : null;
      const values = (modern?.[5] ?? legacy![2]).trim().split(/\s+/);
      const batch = this.excitationBatch.filter(state => state.frameIndex === this.frameIndex());
      let state: ExcitedState | undefined;
      if (modern) state = [...batch].reverse().find(s => s.index === index && (s.multiplicity === 'singlet' ? 1 : s.multiplicity === 'triplet' ? 3 : Number(s.multiplicity)) === multiplicity);
      else {
        // ORCA 5 legacy State ordinals span the printed singlet/triplet batch;
        // they are not the repeated per-spin STATE root numbers. Match the
        // explicit cm-1 observation without introducing a fitted tolerance.
        const energy = num(values[this.absorptionColumns.energy] ?? '');
        if (this.absorptionEnergyUnit === 'cm^-1' && energy !== null) {
          const candidates = batch.filter(candidate => this.excitationWaveNumbers.get(candidate) === energy), ordinal = batch[index - 1];
          state = candidates.length === 1 ? candidates[0] : ordinal && candidates.includes(ordinal) ? ordinal : undefined;
        } else {
          const candidates = batch.filter(candidate => candidate.index === index);
          if (candidates.length === 1) state = candidates[0];
        }
      }
      if (!state) return;
      if (this.simplifiedStates.has(state)) return; // native primary eV/nm/fL remain authoritative
      const wavelength = num(values[this.absorptionColumns.wavelength] ?? ''), oscillator = num(values[this.absorptionColumns.oscillator] ?? '');
      if (wavelength !== null && wavelength > 0 && this.budget()) state.wavelengthNm = wavelength;
      if (oscillator !== null && oscillator >= 0 && this.budget()) state.oscillatorStrength = oscillator;
      if (wavelength !== null && wavelength > 0) this.field(this.data.properties, `excited-${state.sourceLine}-wavelength`, '电偶极吸收表波长', wavelength, line, 'nm');
      if (oscillator !== null && oscillator >= 0) this.field(this.data.properties, `excited-${state.sourceLine}-oscillator`, '电偶极吸收表振子强度', oscillator, line);
      if (modern) this.field(this.data.properties, `excited-${state.sourceLine}-transition`, '电偶极吸收表态标记', t.slice(0, t.length - modern[5].length).trim(), line);
    }
  }
  private nmrPartial(sourceLine: number, message: string) {
    if (!this.nmrIncomplete) this.notice(`源行${sourceLine}：${message}；NMR耦合仅保留已打印前缀，不补零或对称项。`);
    this.nmrIncomplete = true;
    if (this.nmrAvailability) { this.nmrAvailability.status = 'partial'; this.nmrAvailability.message = message; }
  }
  private startNmrCouplings(line: ScientificLine) {
    this.nmrActive = true; this.task('nmr'); this.section = 'none';
    if (this.nmrObserved) return;
    this.nmrObserved = true;
    if (this.budget()) {
      this.nmrAvailability = { field: 'nmr-coupling', status: 'partial', frameIndex: this.frameIndex(), sourceLine: line.number, message: '仅读取明确打印的核对耦合，未推断缺失元素或物理量。' };
      this.diagnostics().fields.push(this.nmrAvailability);
    }
  }
  private nmrNucleus(rawLabel: string, elementRaw: string, indexRaw: string, line: ScientificLine): NmrCouplingNucleus {
    const sourceIndex = indexNumber(indexRaw);
    let element: string | undefined;
    try { element = elementSymbol(elementRaw); } catch { /* raw source identity remains available */ }
    return { rawLabel, sourceIndex, indexBase: 0, atomIndex: element && this.inventory?.[sourceIndex] === element ? sourceIndex : null, ...(element ? { element } : {}), sourceLine: line.number };
  }
  private nmrRecord(pair: NmrCouplingBlock['pair'], quantity: NmrCouplingBlock['quantity'], rawQuantityLabel: string, form: NmrCouplingBlock['form'], line: ScientificLine): NmrCouplingBlock | null {
    // Pair identities are metadata too; every subsequent scalar reserves its
    // own place in the original scientific-value budget before being retained.
    if (!this.budget(2 + pair.filter(nucleus => nucleus.isotope?.massNumber !== undefined).length)) { this.nmrPartial(line.number, '科学元数据达到原有上限'); return null; }
    const block = createNmrCouplingBlock({ pair, quantity, rawQuantityLabel, form, jobIndex: this.jobIndex, frameIndex: this.frameIndex(), ...(this.stageId ? { stageId: this.stageId } : {}), sourceLine: line.number, endLine: line.number, start: line.start, end: line.end });
    (this.data.nmrCouplings ??= []).push(block);
    return block;
  }
  private nmrValue(block: NmrCouplingBlock | null, value: NmrCouplingValue, line: ScientificLine) {
    if (!block) return;
    if (typeof value.value !== 'number' || !Number.isFinite(value.value)) { this.nmrPartial(line.number, '耦合表含不可表示为有限数的分量'); return; }
    if (!this.budget()) { this.nmrPartial(line.number, '科学元数据达到原有上限'); return; }
    block.values.push({ ...value, start: line.start, end: line.end });
    block.endLine = line.number; block.end = line.end;
  }
  private finishNmrPart() {
    if (this.nmrPart && (this.nmrPart.rows !== 3 || this.nmrPart.partial)) this.nmrPartial(this.nmrPart.sourceLine, '打印的3×3耦合张量存在未取得的行或分量');
    this.nmrPart = null;
  }
  private finishNmrPair() {
    this.finishNmrPart();
    if (this.nmrPair && !this.nmrPair.values.length) this.nmrPartial(this.nmrPair.sourceLine, '核对标题后未取得完整科学印值');
    if (this.nmrRaw && !this.nmrRaw.values.length) this.nmrPartial(this.nmrRaw.sourceLine, '局部未知量标题后未取得原始印值');
    this.nmrPair = null; this.nmrRaw = null;
  }
  private finishNmrCouplings() {
    this.finishNmrPair();
    if (!this.nmrObserved) return;
    if (!this.terminated) this.nmrPartial(this.lastSourceLine, '文件前缀未观察到本job正常结束，后续耦合字段可用性未认证');
    if (this.nmrAvailability && !this.nmrIncomplete) { this.nmrAvailability.status = 'complete'; this.nmrAvailability.message = '已保留本文件识别的原生印值；未打印量、单位及同位素仍不推断。'; }
    if (!this.nmrReduced) this.fieldStatus({ field: 'nmr-reduced-K', status: 'not-printed', sourceLine: this.lastSourceLine, message: '本job没有可确认的reduced-K打印表；未从J换算。' });
  }
  private readNmrCouplings(line: ScientificLine): boolean {
    const t = line.text.trim();
    if (/^NMR SPIN-SPIN COUPLING CONSTANTS\s*$/i.test(t)) { this.finishNmrPair(); this.nmrSummary = null; this.startNmrCouplings(line); return true; }
    if (this.nmrActive && /^(?:CARTESIAN COORDINATES\s*\(|GEOMETRY OPTIMIZATION CYCLE\b|NUMERICAL (?:FREQUENCIES|HESSIAN)\b|CHEMICAL SHIELDING SUMMARY\b|DIPOLE MOMENT\s*$|THERMOCHEMISTRY\b|\**\s*ORCA TERMINATED\b)/i.test(t)) {
      this.finishNmrPair(); this.nmrActive = false; this.nmrSummary = null;
      return false;
    }
    if (/^(?:SUMMARY OF )?REDUCED(?: SPIN-SPIN)? COUPLING CONSTANTS\b/i.test(t)) {
      this.nmrReduced = true;
      this.fieldStatus({ field: 'nmr-reduced-K', status: 'unsupported', sourceLine: line.number, message: `保留原始标题，未对未经真实样本确认的K格式猜量或单位：${t}` });
      this.finishNmrPair(); this.nmrActive = false;
      return true;
    }
    const summary = t.match(/^SUMMARY OF ISOTROPIC COUPLING CONSTANTS\s*(?:\(([^)]+)\))?\s*$/i);
    if (summary) {
      this.startNmrCouplings(line); this.finishNmrPair();
      this.nmrSummary = { label: t, ...(summary[1] ? { rawUnit: summary[1], ...(summary[1].toLowerCase() === 'hz' ? { unit: 'Hz' } : {}) } : {}), sourceLine: line.number, columns: [] };
      return true;
    }
    if (!this.nmrActive) return false;
    if (this.nmrSummary) {
      if (!t || dash.test(t)) return true;
      const fields = t.split(/\s+/);
      if (fields.length % 2 === 0 && fields.every((field, index) => index % 2 === 0 ? /^\d+$/.test(field) : /^[A-Za-z]{1,2}$/.test(field))) {
        this.nmrSummary.columns = [];
        for (let index = 0; index < fields.length; index += 2) this.nmrSummary.columns.push(this.nmrNucleus(fields[index] + ' ' + fields[index + 1], fields[index + 1], fields[index], line));
        return true;
      }
      if (fields.length >= 3 && /^\d+$/.test(fields[0]) && /^[A-Za-z]{1,2}$/.test(fields[1]) && this.nmrSummary.columns.length) {
        const nucleus = this.nmrNucleus(fields[0] + ' ' + fields[1], fields[1], fields[0], line), columns = this.nmrSummary.columns;
        let retained = 0;
        for (let index = 0; index < Math.min(columns.length, fields.length - 2); index++) {
          const token = fields[index + 2], value = num(token);
          if (value === null) break;
          const block = this.nmrRecord([nucleus, columns[index]], this.nmrSummary.unit === 'Hz' ? 'J' : 'unknown', this.nmrSummary.label, 'scalar', line);
          this.nmrValue(block, { label: 'Printed isotropic coupling summary cell', part: this.nmrSummary.label, value, rawValue: token, sourceLine: line.number, ...(this.nmrSummary.unit ? { unit: this.nmrSummary.unit } : {}), ...(this.nmrSummary.rawUnit ? { rawUnit: this.nmrSummary.rawUnit, unitSourceLine: this.nmrSummary.sourceLine } : {}) }, line);
          retained++;
        }
        if (retained !== columns.length || fields.length - 2 !== columns.length) this.nmrPartial(line.number, '耦合summary行存在未取得或不相容的实际列');
        return true;
      }
      this.nmrSummary = null; this.nmrActive = false;
      return false;
    }
    const pair = t.match(/^NUCLEUS A\s*=\s*(([A-Za-z]{1,2})\s+(\d+))\s+NUCLEUS B\s*=\s*(([A-Za-z]{1,2})\s+(\d+))\s*$/i);
    if (pair) {
      this.finishNmrPair();
      this.nmrPair = this.nmrRecord([this.nmrNucleus(pair[1], pair[2], pair[3], line), this.nmrNucleus(pair[4], pair[5], pair[6], line)], 'unknown', t, 'components', line);
      this.nmrRaw = null;
      return true;
    }
    if (!this.nmrPair) return false;
    const isotope = t.match(new RegExp(`^\\(\\s*((\\d+)([A-Za-z]{1,2}))\\s+gnA\\s*=\\s*${N}\\s+((\\d+)([A-Za-z]{1,2}))\\s+gnB\\s*=\\s*${N}\\s*\\)`, 'i'));
    if (isotope) {
      if (!this.budget(2)) { this.nmrPartial(line.number, '科学元数据达到原有上限，同位素字段未猜补'); return true; }
      this.nmrPair.pair[0].isotope = { rawLabel: isotope[1], massNumber: indexNumber(isotope[2]), sourceLine: line.number };
      this.nmrPair.pair[1].isotope = { rawLabel: isotope[4], massNumber: indexNumber(isotope[5]), sourceLine: line.number };
      this.nmrPair.endLine = line.number; this.nmrPair.end = line.end;
      return true;
    }
    const tensor = t.match(/^(Diamagnetic contribution|Paramagnetic contribution|Fermi-contact contribution|Spin-dipolar contribution|Spin-dipolar\/Fermi contact cross term contribution|Total spin-spin coupling tensor)\s*(?:\(([^)]+)\))?\s*:\s*$/i);
    if (tensor) {
      this.finishNmrPart(); this.nmrRaw = null;
      const unit = tensor[2]?.toLowerCase() === 'hz' ? 'Hz' : undefined;
      if (unit) this.nmrPair.quantity = 'J';
      if (/^Total/i.test(tensor[1])) this.nmrPair.rawQuantityLabel = t;
      this.nmrPart = { block: this.nmrPair, label: tensor[1], ...(unit ? { unit } : {}), ...(tensor[2] ? { rawUnit: tensor[2] } : {}), sourceLine: line.number, rows: 0, partial: false };
      return true;
    }
    if (/^Diagonalized sT\*s matrix\s*:/i.test(t)) {
      this.finishNmrPart();
      this.nmrRaw = this.nmrRecord(this.nmrPair.pair, 'unknown', t, 'components', line);
      return true;
    }
    if (this.nmrRaw) {
      const row = t.match(new RegExp(`^([A-Za-z][\\w/-]*)\\s+(${N})\\s+(${N})\\s+(${N})\\s+iso=\\s*(${N})\\s*$`, 'i'));
      if (row) {
        for (const [column, index] of [['1', 2], ['2', 3], ['3', 4], ['iso', 5]] as const) this.nmrValue(this.nmrRaw, { label: `${row[1]} (${this.nmrRaw.rawQuantityLabel})`, part: row[1], value: num(row[index])!, rawValue: row[index], sourceLine: line.number, component: { row: row[1], column, basis: 'source-table-position' } }, line);
        return true;
      }
    }
    if (this.nmrPart && t && !dash.test(t)) {
      const fields = t.split(/\s+/);
      if (fields.length <= 3 && num(fields[0]) !== null && this.nmrPart.rows < 3) {
        const part = this.nmrPart;
        let valid = 0;
        for (let index = 0; index < fields.length; index++) {
          const value = num(fields[index]); if (value === null) break;
          this.nmrValue(part.block, { label: part.label, part: part.label, value, rawValue: fields[index], sourceLine: line.number, ...(part.unit ? { unit: part.unit } : {}), ...(part.rawUnit ? { rawUnit: part.rawUnit, unitSourceLine: part.sourceLine } : {}), component: { row: String(part.rows + 1), column: String(index + 1), basis: 'source-table-position' } }, line); valid++;
        }
        part.rows++; if (valid !== 3) part.partial = true;
        return true;
      }
    }
    return false;
  }
  private readDipoleFields(line: ScientificLine): boolean {
    const context = this.dipoleContext;
    if (!context) return false;
    const t = line.text.trim();
    if (!t) { if (context.sawMagnitude) this.dipoleContext = null; return true; }
    if (dash.test(t) || /^X\s+Y\s+Z$/i.test(t)) return true;
    const metadata = t.match(/^(Method|Type of density|Level|Basis)\s*:\s*(.+)$/i);
    if (metadata) {
      const key = metadata[1].toLowerCase() === 'method' ? 'dipole-method' : metadata[1].toLowerCase() === 'basis' ? 'dipole-density-basis' : metadata[1].toLowerCase() === 'level' ? 'dipole-density-level' : 'dipole-density-type';
      this.field(this.data.properties, key, 'Dipole block ' + metadata[1] + ' (printed)', metadata[2], line, undefined, metadata[2], 'program-adopted');
      return true;
    }
    const scalar = t.match(new RegExp(`^(Energy|Multiplicity|Irrep|State)\\s*:\\s*(${N})(?:\\s+(Eh|hartree))?\\s*$`, 'i'));
    if (scalar) {
      this.field(this.data.properties, 'dipole-density-' + scalar[1].toLowerCase(), 'Dipole-density block ' + scalar[1] + ' (printed)', num(scalar[2])!, line, scalar[3] ? 'hartree' : undefined, scalar[2]);
      return true;
    }
    const vector = t.match(new RegExp(`^(Total Dipole Moment|Electronic contribution|Nuclear contribution)\\s*:\\s*(${N})\\s+(${N})\\s+(${N})\\s*$`, 'i'));
    if (vector) {
      const kind = /^Total/i.test(vector[1]) ? 'total' : /^Electronic/i.test(vector[1]) ? 'electronic' : 'nuclear';
      for (const [axis, index] of [['x', 2], ['y', 3], ['z', 4]] as const) {
        const before = this.data.properties.length;
        this.field(this.data.properties, `dipole-${kind}-${axis}`, vector[1] + ' ' + axis.toUpperCase() + ' (printed)', num(vector[index])!, line, context.vectorUnit, vector[index]);
        if (this.data.properties.length > before) context.vectors.push(this.data.properties.at(-1)!);
      }
      return true;
    }
    const magnitude = t.match(new RegExp(`^Magnitude\\s*\\((a\\.u\\.|Debye)\\)\\s*:\\s*(${N})\\s*$`, 'i'));
    if (magnitude) {
      const unit = /^Debye$/i.test(magnitude[1]) ? 'Debye' : 'a.u.';
      this.field(this.data.properties, unit === 'Debye' ? 'dipole-magnitude-debye' : 'dipole-magnitude-au', `Dipole magnitude (${unit}, printed)`, num(magnitude[2])!, line, unit, magnitude[2]);
      if (unit === 'a.u.') {
        // The same native block explicitly prints its vector norm in a.u.;
        // no route-derived correlated-density claim or unit conversion is used.
        context.vectorUnit = unit;
        for (const component of context.vectors) component.unit = unit;
        this.field(this.data.properties, 'dipole-vector-unit-evidence', 'Dipole vector unit from the same printed block', unit, line, undefined, magnitude[1], 'program-adopted');
      }
      context.sawMagnitude = true;
      return true;
    }
    this.dipoleContext = null;
    return false;
  }
  private readNativeMd(line: ScientificLine): boolean {
    const raw = line.text, text = raw.trim();
    if (text === 'MD module early startup:' || /^#+\s*Scriptable Nuclear Dynamics \(SANdy\) \+ ORCA\s*#+$/.test(text)) {
      this.mdNative = true; this.observed = true; this.task('md');
    }
    if (!this.mdNative) return false;
    for (const reference of mdNativeReferences(raw)) if (this.budget()) (this.data.relatedFiles ??= []).push({ ...reference, sourceLine: line.number });
    const timestep = text.match(new RegExp(`^Setting integration time step to (${N}) (fs|ps)\\.$`));
    if (timestep && num(timestep[1]) !== null) this.field(this.data.properties, 'md-adopted-timestep', 'Native adopted MD integration time step', num(timestep[1])!, line, timestep[2], timestep[1], 'program-adopted');
    if (/^Step\s*\|\s*Sim\. Time\s*\|/.test(text)) { this.mdHeader = raw; this.mdLayout = null; this.mdInTable = false; return true; }
    if (this.mdHeader !== null) {
      this.mdLayout = mdNativeTableLayout(this.mdHeader, raw, line.number); this.mdHeader = null; this.mdInTable = this.mdLayout !== null;
      return true;
    }
    if (this.mdInTable && /^\d+\s/.test(text)) {
      const row = this.mdLayout ? parseMdNativeTableRow(raw, line.number, this.mdLayout) : null;
      if (!this.mdAvailability) {
        this.mdAvailability = { field: 'md-steps', status: 'complete', frameIndex: null, sourceLine: line.number, message: '仅保留本OUT实际打印的时间/温度/能量/电子迭代；未绑定几何帧或反补时间。' };
        this.fieldStatus(this.mdAvailability);
      }
      // Step identity and all six actual scalar quantities share the existing
      // scientific budget; rows also share the existing retained-index bound.
      if (!row || this.mdTableStopped || !this.budget(7)) {
        this.mdTableStopped = true; this.mdAvailability.status = 'partial';
        this.mdAvailability.message = 'MD步表损坏或达到原科学预算；仅保此前完整行，不补零或越过坏行。';
        this.notice(this.mdAvailability.message); return true;
      }
      this.storage.reserveIndices(); row.jobIndex = this.jobIndex; row.frameIndex = null;
      (this.data.mdSteps ??= []).push(row); this.observed = true; return true;
    }
    if (this.mdInTable && !/^[\s|\-]*$/.test(raw)) this.mdInTable = false;
    const finished = text.match(/^Finished MD run of (\d+) steps\.$/);
    if (finished) {
      this.taskStatus({ task: 'md', status: 'completed', sourceLine: line.number, frameIndex: null, stageId: 'md', raw });
      this.field(this.data.properties, 'md-completed-integration-steps', 'Native completed MD integration steps', indexNumber(finished[1]), line, undefined, finished[1]);
    }
    if (text === 'Finished MD loop.' || /^#+\s*Finished Executing Input Script \(SAN-VM\)\s*#+$/.test(text)) this.field(this.data.properties, text === 'Finished MD loop.' ? 'md-loop-status' : 'md-script-status', 'Native MD module completion marker', text, line);
    return false;
  }

  private readFields(line: ScientificLine) {
    const t = line.text.trim();
    if (/^(?:with the Becke-Johnson damping scheme \(D3BJ\)|USING Becke-Johnson damping)$/i.test(t)) this.adoptedOnce('native-dispersion-damping', 'Native dispersion damping scheme', 'Becke-Johnson', line, line.text);
    if (/^DFTD4\s+V\d+\.\d+\.\d+(?:[-+.\w]*)?\s*$/i.test(t)) this.adoptedOnce('native-dispersion-component', 'Native dispersion component', 'D4', line, line.text);
    const composite = t.match(/^Your calculation employs the composite approach (PBEh-3c|B97-3c)(?: by Grimme and coworkers)?\.$/i);
    if (composite) this.adoptedOnce('native-composite-approach', 'Native composite approach', composite[1], line, line.text);
    if (/^Your calculation utilizes the SMD solvation module\.?$/i.test(t)) this.adoptedOnce('native-solvation-module', 'Native solvation module', 'SMD', line, line.text);
    const scaling = t.match(/^Scaling \(regular\/separated\)\s*\.{2,}\s*(\S+)\s+(\S+)\s*$/i);
    if (scaling && num(scaling[1]) !== null && num(scaling[2]) !== null) {
      this.adoptedOnce('native-scaling-regular', 'Native scaling (regular)', num(scaling[1])!, line, scaling[1]);
      this.adoptedOnce('native-scaling-separated', 'Native scaling (separated)', num(scaling[2])!, line, scaling[2]);
    }
    if (/^(?:TOTAL SCF ENERGY|ORBITAL ENERGIES|CARTESIAN COORDINATES|GEOMETRY OPTIMIZATION CYCLE|THERMOCHEMISTRY)\b/i.test(t)) { this.stabilityContext = false; this.snapshotStabilityLine = null; }
    const stabilityEigenvalue = this.stabilityContext ? t.match(/^E\(\s*(\d+)\)\s*=\s*(\S+)\s+(Eh|hartree)\s*$/i) : null;
    if (stabilityEigenvalue && num(stabilityEigenvalue[2]) !== null) this.field(this.data.stability, 'stability-eigenvalue:' + stabilityEigenvalue[1], 'Printed stability matrix eigenvalue ' + stabilityEigenvalue[1], num(stabilityEigenvalue[2])!, line, 'hartree', stabilityEigenvalue[2]);
    if (t === 'SCF SETTINGS') { this.nativeFunctionalSettings = true; this.nativeFunctionalKind = null; this.nativeTdXcSettings = false; }
    if (/^(?:Gradients option|SCF ITERATIONS|TOTAL SCF ENERGY|ORBITAL ENERGIES|GEOMETRY OPTIMIZATION CYCLE|CARTESIAN COORDINATES)\b/.test(t)) { this.nativeFunctionalSettings = false; this.nativeFunctionalKind = null; this.nativeTdXcSettings = false; }
    if (t === 'TD-DFT XC SETUP') { this.nativeTdXcSettings = true; this.nativeFunctionalSettings = false; this.nativeFunctionalKind = null; }
    const xtbHamiltonian = t.match(/^:\s+Hamiltonian\s+(GFN[12]-xTB)\s+:$/);
    if (xtbHamiltonian) this.field(this.data.properties, 'native-xtb-hamiltonian', 'Native xTB Hamiltonian', xtbHamiltonian[1], line, undefined, xtbHamiltonian[1], 'program-adopted');
    const functional = this.nativeFunctionalSettings ? t.match(/^Functional (kind|name|family)\s*\.{2,}\s*(.+?)\s*$/) : null;
    if (functional) {
      if (functional[1] === 'kind') this.nativeFunctionalKind = functional[2];
      const role = this.nativeFunctionalKind?.toLowerCase().replace(/[^a-z0-9]+/g, '-') ?? 'unspecified';
      this.field(this.data.properties, `native-functional-${role}-${functional[1]}`, `Native ${this.nativeFunctionalKind ?? ''} functional ${functional[1]}`.replace(/\s+/g, ' ').trim(), functional[2], line, undefined, functional[2], 'program-adopted');
    }
    const tdFunctional = this.nativeTdXcSettings ? t.match(/^(Exchange|Correlation) functional \(TD-DFT\)\s*\.{2,}\s*(\S+)\s*$/) : null;
    if (tdFunctional) this.field(this.data.properties, `native-td-${tdFunctional[1].toLowerCase()}-functional`, `Native ${tdFunctional[1]} functional (TD-DFT)`, tdFunctional[2], line, undefined, tdFunctional[2], 'program-adopted');
    const qmEnergy = t.match(new RegExp(`^FINAL SINGLE POINT ENERGY \\((L-QM2|S-QM2|QM/QM2)\\)\\s+(${N})(?:\\s+(Eh|hartree))?\\s*$`, 'i'));
    if (qmEnergy) {
      const count = this.data.properties.length;
      this.field(this.data.properties, 'orca-final-single-point-energy-' + qmEnergy[1].toLowerCase().replace(/\W+/g, '-'), `FINAL SINGLE POINT ENERGY (${qmEnergy[1]})`, num(qmEnergy[2])!, line, qmEnergy[3] ? 'hartree' : undefined, qmEnergy[2]);
      // The explicit subsystem/combined label is not the ordinary QM geometry
      // target. No atom mapping or silent frame-energy replacement is implied.
      if (this.data.properties.length > count) this.data.properties.at(-1)!.frameIndex = null;
    }
    const compactEnergy = t.match(new RegExp(`^(SCF\\s+Energy|NL\\s+Energy|SC\\+NL Energy)\\s*:\\s*(${N})(?:\\s+(Eh|hartree|[Kk]cal/mol))?\\s*$`));
    if (compactEnergy) {
      const label = compactEnergy[1].replace(/\s+/g, ' ');
      const [key, name] = ({ 'SCF Energy': ['scf-energy-reference', 'SCF参考能 E(SCF)'], 'NL Energy': ['nl-energy-correction', '非局域色散修正 E(NL)'], 'SC+NL Energy': ['sc-plus-nl-energy', '含非局域修正的电子能 E(SCF+NL)'] } as Record<string, [string, string]>)[label];
      // These compact post-SCF observations are not the final energy target.
      // Their own line must print a unit; a nearby Eh block proves no unit here.
      this.field(this.data.properties, key, name, num(compactEnergy[2])!, line, compactEnergy[3] === 'Eh' ? 'hartree' : compactEnergy[3], compactEnergy[2]);
    }
    const nlEnergy = t.match(new RegExp(`^(NL Energy, E\\(C,NL\\))\\s*:\\s*(${N})\\s+(Eh|hartree)\\s*$`, 'i'));
    if (nlEnergy) this.field(this.data.properties, 'orca-nonlocal-correlation-energy', nlEnergy[1], num(nlEnergy[2])!, line, 'hartree', nlEnergy[2]);
    const smdGcds = t.match(new RegExp(`^(SMD CDS \\(Gcds\\))\\s*:\\s*(${N})\\s+Eh(?:\\s+${N}\\s+eV)?\\s*$`));
    if (smdGcds) {
      this.field(this.data.properties, 'orca-smd-cds-gcds', smdGcds[1], num(smdGcds[2])!, line, 'hartree', smdGcds[2]);
      this.notice(`源行${line.number}的SMD CDS (Gcds)与SMD CDS free energy correction为同一修正的独立原生单位打印，不能重复相加。`);
    }
    const pairScaling = t.match(new RegExp(`^(Scaling for (?:aa/bb|ab) pairs)\\s*\\.{2,}\\s*(${N})\\s*$`, 'i'));
    if (pairScaling) this.field(this.data.properties, 'orca-' + pairScaling[1].toLowerCase().replace(/\W+/g, '-'), pairScaling[1], num(pairScaling[2])!, line, undefined, pairScaling[2], 'program-adopted');
    if (this.cpcmParameters) {
      const parameter = t.match(new RegExp(`^(Epsilon|Refrac)\\s*\\.{2,}\\s*(${N})\\s*$`, 'i'));
      if (parameter) this.field(this.data.properties, 'cpcm-' + parameter[1].toLowerCase(), 'Native CPCM adopted ' + parameter[1], num(parameter[2])!, line, undefined, parameter[2], 'program-adopted');
      if (/^Radii\s*:/i.test(t)) this.cpcmParameters = false;
    }
    if (this.readDipoleFields(line)) return;
    const methodEnergy = t.match(new RegExp(`^(RI-MP2 CORRELATION ENERGY|MP2 TOTAL ENERGY|(?:DLPNO[- ])?CCSD(?:\\(T1?\\))? (?:TOTAL|CORRELATION) ENERGY|E\\((?:0|CORR|CCSD|CCSD\\(T1?\\)|MP2|TOT)\\)(?:\\((?:strong-pairs|weak-pairs|corrected)\\))?|Triples Correction\\s+\\(T\\)|The\\s+(?:Conventional|Truncated)\\s+\\(T0\\)\\s+is|The\\s+corrected\\s+\\(T\\)\\s+is|Dispersion correction|GCP(?:\\+bas)? correction|Geometrical counterpoise correction|Total correction to HF/MINIX)\\s*(?::|=|\\.{2,})?\\s+(${N})(?:\\s+(Eh|hartree))?\\s*$`, 'i'));
    if (methodEnergy) {
      const label = methodEnergy[1].replace(/\s+/g, ' '), key = 'orca-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
      this.field(this.data.properties, key, label, num(methodEnergy[2])!, line, methodEnergy[3] ? 'hartree' : undefined, methodEnergy[2]);
    }
    if(this.thermo&&/^(?:SUGGESTED CITATIONS(?: FOR THIS RUN)?|REFERENCES|TIMINGS|TOTAL RUN TIME|ORCA TERMINATED|\*{2,}ORCA TERMINATED|GEOMETRY OPTIMIZATION CYCLE|CARTESIAN COORDINATES|JOB NUMBER)\b/i.test(t))this.thermo=false;
    // This is an explicit thermochemistry table grammar, not a search for a
    // number in any later prose mentioning energy/entropy (e.g. reference 94).
    const thermal=this.thermo?t.match(thermalScalar):null;
    if(this.thermo&&thermal){const name=thermal[1].trim().replace(/\s+/g,' ').toLowerCase(),label=thermalNames[name];
      if(label){const canonical=name==='non-thermal (zpe) correction'?'zero point energy':name==='final gibbs free enthalpy'?'final gibbs free energy':name;
        const key=canonical.replace(/\W+/g,'-'),value=num(thermal[2])!,unit=/^(?:eh|hartree)$/i.test(thermal[3])?'hartree':thermal[3];
        if(!this.data.thermochemistry.some(field=>field.key===key&&field.frameIndex===this.frameIndex()&&field.value===value&&field.unit===unit&&field.rawValue===thermal[2]))this.field(this.data.thermochemistry,key,label,value,line,unit,thermal[2]);
      }
    }
    const scalar = t.match(new RegExp(`^([A-Za-z][A-Za-z ()/.*+_-]*?)\\s*(?:\\.{2,}|:|=)?\\s+(${N})\\s*(Eh|hartree|eV|K|atm|AMU|cm\\*\\*-1|kcal/mol|ppm|a\\.u\\.)?(?:\\s|$)`, 'i'));
    if (scalar && num(scalar[2]) !== null) {
      const label = scalar[1].trim(), unit = scalar[3] === 'Eh' ? 'hartree' : scalar[3];
      if (!this.thermo && /^(?:Total Energy|Dipole moment|Magnitude.*Debye\)?|Expectation value of.*S)$/i.test(label)) {
        const scfTotal=this.scfTotalContext&&/^Total Energy$/i.test(label);
        this.field(this.data.properties, scfTotal?'orca-scf-total-energy':label.toLowerCase().replace(/\W+/g, '-'), scfTotal?'SCF总能量 E(SCF)':label, num(scalar[2])!, line, /Magnitude.*Debye/i.test(label) ? 'Debye' : unit,scalar[2]);
      }
      if (/gCP|geometrical counterpoise/i.test(label)) this.field(this.data.bsse, 'gcp-correction', `gCP: ${label}`, num(scalar[2])!, line, unit,scalar[2]);
      else if (/BSSE|counterpoise|interaction energy|fragment.*energy/i.test(label) && this.bsseContext === 'bb-cp') this.field(this.data.bsse, `bb-cp-${label.toLowerCase().replace(/\W+/g, '-')}`, `BB-CP: ${label}`, num(scalar[2])!, line, unit,scalar[2]);
    }
    if (this.thermo && /RRHO|QRRHO|scaling/i.test(t)) this.notice(`源行${line.number}：${t}`);
    if (this.stabilityContext && /(?:wavefunction|SCF solution).*(?:stable|unstable)|lowest.*eigenvalue|triplet.*instability|singlet.*instability|internal.*stability|external.*stability/i.test(t)) {
      this.field(this.data.stability, 'printed-result', 'Printed stability result / tested scope', t, line);
      this.notice('稳定性结论仅限打印的测试空间；未扩展为所有自旋或外部扰动均稳定。');
      if (/^The stability analysis shows that the wavefunction is (?:stable|unstable)\.?$/i.test(t)) {
        this.snapshotStabilityLine = null;
        this.taskStatus({ task: 'stability', stageId: 'stability-analysis', status: 'completed', sourceLine: line.number, frameIndex: this.frameIndex(), raw: line.text });
      }
    }
    if (/root.*follow|follow.*root/i.test(t)) this.notice('Root following的打印态编号不是跨几何永久state ID。');
  }
  /** Observes the current index without flushing any live scientific table. */
  peek(): import('./scientific-contracts').ScientificParserSnapshot {
    if (!this.snapshotState) throw new Error('ORCA持续快照须在读取前显式启用。');
    const opened = [this.block ? this.snapshotGeometryLine ?? this.block.line : undefined, this.snapshotAuLine, this.snapshotPathSummaryLine, this.snapshotStabilityLine,
      ...(this.section !== 'none' ? [this.snapshotSectionLine] : []),
      this.nmrPart?.sourceLine, this.nmrPair?.sourceLine, this.nmrRaw?.sourceLine, this.nmrSummary?.sourceLine,
      ...(this.dipoleContext && !this.dipoleContext.sawMagnitude ? [this.dipoleContext.sourceLine] : [])
    ].filter((line): line is number => typeof line === 'number' && line > 0);
    const beforeLine = opened.length ? Math.min(...opened) : undefined;
    const p = this.pending;
    const pendingFrame: IndexedScientificFrame | null = p ? {
      index: this.frames.length, sourceStep: p.step, time: null, energy: p.energy === null ? null : { value: p.energy, unit: 'hartree' }, convergence: p.convergence,
      sourceLine: p.geometry.line, geometry: p.geometry, coordinateRoundingAngstrom: p.geometry.coordinateRoundingAngstrom,
      ...(p.label ? { label: p.label } : {}), ...(p.coordinate ? { coordinate: p.coordinate } : {}), ...(p.direction ? { pathDirection: p.direction } : {}),
      ...(p.node !== null ? { pathNode: p.node } : {}), ...(p.stageId ? { stageId: p.stageId } : {}), ...(p.pathPoint ? { pathPoint: true } : {}),
      ...(p.pathIteration === undefined ? {} : { pathIteration: p.pathIteration }), ...(p.pathImage === undefined ? {} : { pathImage: p.pathImage })
    } : null;
    const needsOpt = this.data.tasks.includes('opt') && (!this.data.tasks.some(task => ['irc', 'scan', 'neb'].includes(task)) || this.stageId === 'ts-optimization');
    const active: import('./scientific-contracts').ScientificJob | null = !this.finished && this.hasCurrentJobEvidence() ? {
      engine: 'orca', jobIndex: this.jobIndex, segmentIndex: this.segmentIndex, charge: this.charge, multiplicity: this.multiplicity,
      status: this.failed ? 'failed' : this.terminated && !this.invalid && (!needsOpt || this.optimized) && (!this.data.tasks.includes('neb') || this.nebConverged) ? 'completed' : 'incomplete',
      frames: pendingFrame ? [...this.frames, pendingFrame] : this.frames, data: this.data, messages: [...this.messages]
    } : null;
    const spectrumOpen = ['frequencies', 'modes', 'ir', 'raman'].includes(this.section);
    return this.snapshotState.snapshot(this.jobs, active, this.lastSourceLine, {
      ...(beforeLine === undefined ? {} : { beforeLine }),
      mutableSubtrees: [pendingFrame, this.data.vibrations, this.mdAvailability, this.modeRawAvailability, this.nmrAvailability].filter((item): item is NonNullable<typeof item> => !!item),
      withheld: [this.section === 'scf' ? this.scf : null, this.section === 'excited' ? this.excited : null, ...(this.section === 'simplified' ? this.simplifiedRows : []),
        ...(spectrumOpen && this.data.vibrations ? [this.data.vibrations] : []),
        ...(['atomic', 'shielding'].includes(this.section) && this.atomic ? this.data.atomicProperties.filter(item => item.sourceLine === this.atomic!.sourceLine) : []),
        ...(this.section === 'orbitals' ? this.data.orbitals.filter(item => item.sourceLine >= (this.snapshotSectionLine ?? 0)) : [])
      ].filter((item): item is NonNullable<typeof item> => !!item)
    });
  }
  finish(): ScientificJob[] { if (!this.finished) { this.archive(); this.finished = true; } return this.jobs; }
}
