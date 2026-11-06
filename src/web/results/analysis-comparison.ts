import type { AnalysisAtomValue, AnalysisBondValue, WavefunctionAnalysisRequest, WavefunctionAnalysisResult } from '../../results/wavefunction-analysis';
import { formatAnalysisValue } from './analysis-display';
import type { ScientificTableColumn, ScientificTableProjection } from './scientific-table';
import type {TrajectoryResult} from '../../results/contracts';
import type {Structure} from '../../core/types';
import type {AnalysisDisplaySettings} from './analysis-display';

export type ComparisonResult = Extract<WavefunctionAnalysisResult, { kind: 'charges' | 'bond-orders' }>;
export interface ProfessionalSourceContext {
  result:TrajectoryResult;structure:Structure;frameIndex:number;wavefunctionAvailable:boolean;
  nativeAtomIds?:readonly string[];
  nativeSessionId?:string;nativeSourceRevision?:string;
  /** Owned GFN2 Molden does not contain independent alpha/beta populations. */
  generatedXtb?:boolean;
}
export interface ProfessionalValueOrigin {sourceId:string;generation:string;jobIndex:number;frameIndex:number;sourceFrameIndex:number;producedBy:'printed'|'calculated';sourceName:string;sourceLine?:number;sessionId?:string;sourceRevision?:string;lastAttemptState?:ComparisonState}
export interface ProfessionalChargeColumn {key:string;label:string;origin:ProfessionalValueOrigin;hasCharge:boolean;hasSpin:boolean;chargeUnit?:string;spinUnit?:string;atoms:readonly {atomId:string;sourceIndex:number;element:string;value?:number;spinPopulation?:number}[]}
export interface ProfessionalChargeDisplay {identity:string;frameIndex:number;sourceId:string;activeMethod:string|null;columns:readonly ProfessionalChargeColumn[];display:AnalysisDisplaySettings;atoms:readonly {atomId:string;value:number;label:string}[]}
export const professionalSourceIdentity=(source:ProfessionalSourceContext)=>JSON.stringify([source.result.source.id,source.result.id,source.result.jobIndex,source.frameIndex,source.result.frames[source.frameIndex]?.sourceFrameIndex??source.frameIndex]);
const methodKey=(scheme:string)=>{const key=scheme.toLowerCase().replaceAll('ö','o').replace(/[^a-z0-9-]/g,'');for(const method of ['mulliken','lowdin','adch','hirshfeld','hirshfeld-i','cm5','resp','scpa'])if(key===method||key===method+'charge'||key===method+'charges'||key===method+'population'||key===method+'populationanalysis'||key===method+'spinpopulation'||key===method+'spindensity')return method;return key;};
/** Native xTB populations remain in scientific.atomicProperties for provenance.
 * Only an actual Multiwfn method result belongs in the professional charge view. */
export const nativeXtbChargeMethod = (scheme:string) => /^(?:gfn\d[\s-]*)?xtb(?:\b|$)/i.test(scheme.trim());
export function printedChargeColumns(source:ProfessionalSourceContext):ProfessionalChargeColumn[]{
 const {result,structure,frameIndex}=source,columns=new Map<string,ProfessionalChargeColumn>();
 for(const property of result.scientific?.atomicProperties??[]){
  if(property.frameIndex!==frameIndex||!['charge','spin'].includes(property.kind)||nativeXtbChargeMethod(property.scheme)||source.generatedXtb&&property.kind==='spin')continue;
  const key=methodKey(property.scheme),sourceId=property.sourceId??result.source.id;
  const rows=property.values.map(row=>{const atom=structure.atoms[row.atomIndex];return atom?.id&&(!row.element||row.element===atom.element)&&Number.isFinite(row.value)?{atomId:atom.id,sourceIndex:row.atomIndex+1,element:atom.element,...(property.kind==='spin'?{spinPopulation:row.value}:{value:row.value})}:null;});
  if(rows.some(row=>!row)||new Set(rows.map(row=>row!.atomId)).size!==rows.length)continue;
  const previous=columns.get(key),sameSource=previous?.origin.sourceId===sourceId;
  const atoms=new Map((sameSource?previous.atoms:[]).map(row=>[row.atomId,{...row}]));
  // Replace the complete quantity, not individual missing cells from an older table.
  for(const atom of atoms.values())if(property.kind==='spin')delete atom.spinPopulation;else delete atom.value;
  for(const row of rows){const existing=atoms.get(row!.atomId);atoms.set(row!.atomId,{...existing,...row!});}
  for(const [index,atom]of structure.atoms.entries())if(atom.id&&!atoms.has(atom.id))atoms.set(atom.id,{atomId:atom.id,sourceIndex:index+1,element:atom.element});
  columns.set(key,{key,label:property.scheme,origin:{sourceId,generation:result.id,jobIndex:result.jobIndex,frameIndex,sourceFrameIndex:result.frames[frameIndex]?.sourceFrameIndex??frameIndex,producedBy:'printed',sourceName:property.sourceName??result.source.name,sourceLine:property.sourceLine},hasCharge:property.kind==='charge'||!!sameSource&&!!previous?.hasCharge,hasSpin:property.kind==='spin'||!!sameSource&&!!previous?.hasSpin,chargeUnit:property.kind==='charge'?property.unit:sameSource?previous?.chargeUnit:undefined,spinUnit:property.kind==='spin'?property.unit:sameSource?previous?.spinUnit:undefined,atoms:[...atoms.values()].sort((a,b)=>a.sourceIndex-b.sourceIndex)});
 }
 return [...columns.values()];
}
export function professionalChargeColumns(source:ProfessionalSourceContext,calculated:readonly ComparisonResult[],selected:readonly string[],printed=false,states?:ReadonlyMap<string,ComparisonState>):ProfessionalChargeColumn[]{
 const originals=new Map(printedChargeColumns(source).map(column=>[column.key,column]));
 return selected.filter(key=>!nativeXtbChargeMethod(key)).flatMap((key):ProfessionalChargeColumn[]=>{
  const native=source.wavefunctionAvailable?calculated.find(result=>result.kind==='charges'&&result.method===key&&result.sessionId===source.nativeSessionId&&result.sourceRevision===source.nativeSourceRevision):undefined;
  if(native?.kind==='charges'&&!printed){
   const atoms=native.atoms.map(row=>{const index=row.sourceIndex-1,atom=source.structure.atoms[index];if(!atom?.id||atom.element!==row.element||source.nativeAtomIds?.[index]!==row.atomId)return null;const mapped={...row,atomId:atom.id};if(source.generatedXtb)delete mapped.spinPopulation;return mapped;});
   if(atoms.every(Boolean)&&new Set(atoms.map(row=>row!.atomId)).size===atoms.length){const byId=new Map(atoms.map(atom=>[atom!.atomId,atom!]));const projected=source.structure.atoms.map((atom,index)=>byId.get(atom.id!)??{atomId:atom.id!,sourceIndex:index+1,element:atom.element}),hasSpin=!source.generatedXtb&&native.spinAvailable;return[{key,label:originals.get(key)?.label??key,origin:{sourceId:source.result.source.id,generation:source.result.id,jobIndex:source.result.jobIndex,frameIndex:source.frameIndex,sourceFrameIndex:source.result.frames[source.frameIndex]?.sourceFrameIndex??source.frameIndex,producedBy:'calculated' as const,sourceName:source.result.source.name,sessionId:native.sessionId,sourceRevision:native.sourceRevision,lastAttemptState:states?.get(key)},hasCharge:true,hasSpin,chargeUnit:native.unit,spinUnit:hasSpin?native.unit:undefined,atoms:projected}];}
  }
  const original=originals.get(key);return original?[{...original,origin:{...original.origin,lastAttemptState:states?.get(key)}}]:[];
 });
}
export function professionalChargeProjection(columns:readonly ProfessionalChargeColumn[],selected:readonly {key:string;label:string}[],display:AnalysisDisplaySettings):ScientificTableProjection{
 selected=selected.filter(method=>!nativeXtbChargeMethod(method.key)&&!nativeXtbChargeMethod(method.label));
 const rows=new Map<string,{atomId:string;sourceIndex:number;element:string}>();for(const column of columns)for(const atom of column.atoms)rows.set(atom.atomId,atom);
 return{columns:[{key:'target',label:'原子'},...selected.map(method=>{const column=columns.find(column=>column.key===method.key),spin=display.spin||!!column&&!column.hasCharge&&column.hasSpin,unit=(spin?column?.spinUnit:column?.chargeUnit)??'',quantityLabel=unit==='dimensionless'?`${spin?'Spin':'Q'}`:`${spin?'Spin':'Q'} / ${unit||'单位未输出'}`;return{key:method.key,label:`${method.label} · ${quantityLabel}`,heading:method.label,quantity:spin?'spin-population' as const:'net-charge' as const,...(unit==='e'||unit==='dimensionless'?{unit:unit as 'e'|'dimensionless'}:{}),quantityLabel};})],rows:[...rows.values()].sort((a,b)=>a.sourceIndex-b.sourceIndex).map(row=>({key:row.atomId,cells:[`${row.sourceIndex}${row.element}`,...selected.map(method=>{const column=columns.find(column=>column.key===method.key),atom=column?.atoms.find(atom=>atom.atomId===row.atomId),spin=display.spin||!!column&&!column.hasCharge&&column.hasSpin;return formatAnalysisValue(spin?atom?.spinPopulation:atom?.value,display.decimals);})]}))};
}
export function professionalChargeDisplay(source:ProfessionalSourceContext,columns:readonly ProfessionalChargeColumn[],activeMethod:string|null,display:AnalysisDisplaySettings):ProfessionalChargeDisplay{
 const active=activeMethod===null?columns[0]:columns.find(column=>column.key===activeMethod),keys=new Set(columns.flatMap(column=>column.atoms.map(atom=>atom.atomId)));
 const atoms=[...keys].flatMap(atomId=>{const row=active?.atoms.find(atom=>atom.atomId===atomId),spin=display.spin||!!active&&!active.hasCharge&&active.hasSpin,value=spin?row?.spinPopulation:row?.value;if(value===undefined||!Number.isFinite(value))return[];return[{atomId,value,label:columns.map(column=>{const atom=column.atoms.find(atom=>atom.atomId===atomId),spin=display.spin||!column.hasCharge&&column.hasSpin,unit=spin?column.spinUnit:column.chargeUnit;return `${column.label}: ${spin?'Spin':'Q'}=${formatAnalysisValue(spin?atom?.spinPopulation:atom?.value,display.decimals)}${unit?' '+unit:''}`;}).join('\n')}];});
 return{identity:professionalSourceIdentity(source),sourceId:source.result.source.id,frameIndex:source.frameIndex,activeMethod:activeMethod??active?.key??null,columns,display,atoms};
}
export type ComparisonState = 'queued' | 'running' | 'ready' | 'error' | 'cancelled';
export interface ComparisonSnapshot {
  selected: string[];
  results: ReadonlyMap<string, ComparisonResult>;
  states: ReadonlyMap<string, ComparisonState>;
  errors: ReadonlyMap<string, string>;
  running: string | null;
}
export interface ComparisonSource {
  identity: string;
  sessionId: string;
  sourceRevision: string;
  kind: ComparisonResult['kind'];
  analyze(sessionId: string, request: WavefunctionAnalysisRequest): Promise<WavefunctionAnalysisResult>;
  cancel?(sessionId: string): Promise<void>;
}

/** One native job at a time. Selection and successful cache have independent lifetimes. */
export function createAnalysisComparisonQueue(onChange: (snapshot: ComparisonSnapshot) => void) {
  let source: ComparisonSource | undefined, generation = 0, enabled = true, disposed = false;
  let selected: string[] = [], results = new Map<string, ComparisonResult>(), states = new Map<string, ComparisonState>(), errors = new Map<string, string>();
  let running: { method: string; generation: number; cancelled: boolean; source: ComparisonSource } | undefined;
  const snapshot = (): ComparisonSnapshot => ({ selected: [...selected], results: new Map(results), states: new Map(states), errors: new Map(errors), running: running?.generation === generation && !running.cancelled ? running.method : null });
  const emit = () => { if (!disposed) onChange(snapshot()); };
  const stopRunning = () => {
    if (!running || running.cancelled) return;
    const job=running;job.cancelled = true;
    // The outstanding request retains the lock until its own promise settles.
    void job.source.cancel?.(job.source.sessionId).catch(cause => {
      if(!disposed&&job.generation===generation){states.set(job.method,'error');errors.set(job.method,cause instanceof Error?cause.message:String(cause));emit();}
    });
  };
  const pump = async () => {
    if (running || !source || !enabled || disposed) return;
    const method = selected.find(value => states.get(value) === 'queued');
    if (!method) return;
    const job = { method, generation, cancelled: false, source };
    running = job; states.set(method, 'running'); emit();
    try {
      const request = { kind: job.source.kind, method } as WavefunctionAnalysisRequest;
      const value = await job.source.analyze(job.source.sessionId, request);
      if (disposed || job.cancelled || job.generation !== generation) return;
      if (value.sessionId !== job.source.sessionId || value.sourceRevision !== job.source.sourceRevision || value.kind !== job.source.kind || value.method !== method) throw Error('分析回执与当前来源或方法不匹配。');
      results.set(method, value as ComparisonResult); states.set(method, 'ready'); errors.delete(method);
    } catch (cause) {
      if (!disposed && !job.cancelled && job.generation === generation) {
        states.set(method, 'error'); errors.set(method, cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (running === job) running = undefined;
      emit(); void pump();
    }
  };
  return {
    snapshot,
    /** Restores completed data only; selected methods never authorize work. */
    restore(saved: ComparisonSnapshot) {
      stopRunning(); generation++; selected = [...saved.selected]; results = new Map(saved.results);
      states = new Map([...saved.states].map(([key, value]) => [key, value === 'queued' || value === 'running' ? 'cancelled' : value]));
      errors = new Map(saved.errors); emit();
    },
    setSource(next: ComparisonSource | undefined) {
      disposed = false;
      if (source?.identity === next?.identity) { source = next; return; }
      stopRunning(); generation++; source = next; selected = []; results = new Map(); states = new Map(); errors = new Map(); emit(); void pump();
    },
    select(method: string, checked: boolean, order: readonly string[],options:{calculate?:boolean}={}) {
      if (checked) {
        if (!selected.includes(method)) selected.push(method);
        selected.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        if (options.calculate!==false&&!results.has(method) && states.get(method) !== 'running') { states.set(method, 'queued'); errors.delete(method); }
      } else {
        selected = selected.filter(value => value !== method);
        if (states.get(method) === 'queued') states.delete(method);
      }
      emit(); void pump();
    },
    retry(force=false,methods:readonly string[]=selected) { for (const method of selected) if (methods.includes(method)&&(force||!results.has(method)) && states.get(method) !== 'running') { states.set(method, 'queued'); errors.delete(method); } emit(); void pump(); },
    cancel() {
      if (running?.generation === generation && !running.cancelled) { states.set(running.method, 'cancelled'); stopRunning(); emit(); }
    },
    setEnabled(value: boolean) {
      enabled = value;
      if (!value && running?.generation === generation && !running.cancelled) { states.set(running.method, 'queued'); stopRunning(); emit(); }
      void pump();
    },
    dispose() { disposed = true; stopRunning(); generation++; source = undefined; },
  };
}

export interface ComparisonAtomRow extends Omit<AnalysisAtomValue, 'value'> { values: ReadonlyMap<string, AnalysisAtomValue> }
export interface ComparisonBondRow extends Omit<AnalysisBondValue, 'value'> { key: string; values: ReadonlyMap<string, AnalysisBondValue> }
export const comparisonBondKey = (row: Pick<AnalysisBondValue, 'atomId1' | 'atomId2'>) => JSON.stringify([row.atomId1, row.atomId2].sort());
export function comparisonAtomRows(results: readonly ComparisonResult[]): ComparisonAtomRow[] {
  const rows = new Map<string, ComparisonAtomRow>();
  for (const result of results) if (result.kind === 'charges') for (const atom of result.atoms) {
    let row = rows.get(atom.atomId);
    if (!row) { row = { atomId: atom.atomId, sourceIndex: atom.sourceIndex, element: atom.element, values: new Map() }; rows.set(atom.atomId, row); }
    (row.values as Map<string, AnalysisAtomValue>).set(result.method, atom);
  }
  return [...rows.values()].sort((a, b) => a.sourceIndex - b.sourceIndex || a.atomId.localeCompare(b.atomId));
}
/** Display threshold applies to the union only, never to individual retained cells. */
export function comparisonBondRows(results: readonly ComparisonResult[], visibleOnly = true): ComparisonBondRow[] {
  const rows = new Map<string, ComparisonBondRow>();
  for (const result of results) if (result.kind === 'bond-orders') for (const bond of result.bonds) {
    const key = comparisonBondKey(bond); let row = rows.get(key);
    if (!row) { row = { atomId1: bond.atomId1, atomId2: bond.atomId2, sourceIndex1: bond.sourceIndex1, sourceIndex2: bond.sourceIndex2, key, values: new Map() }; rows.set(key, row); }
    (row.values as Map<string, AnalysisBondValue>).set(result.method, bond);
  }
  return [...rows.values()].filter(row => !visibleOnly || [...row.values.values()].some(cell => Number.isFinite(cell.value) && cell.value > .05)).sort((a, b) => a.sourceIndex1 - b.sourceIndex1 || a.sourceIndex2 - b.sourceIndex2);
}
const textCell = (value: unknown) => String(value ?? '').replace(/[\t\r\n]/g, ' ');
export interface ComparisonTableOptions {
  kind: ComparisonResult['kind'];
  methods: readonly { key: string; label: string }[];
  spin?: boolean;
  decimals?: number;
  getBondLength?(atomIds: [string, string]): number | undefined;
}
/** The visible scientific columns/filtered rows, already formatted for all consumers. */
export function comparisonTableProjection(results: readonly ComparisonResult[], options: ComparisonTableOptions): ScientificTableProjection {
  const format = (value: number | undefined) => formatAnalysisValue(value, options.decimals);
  const methods: ScientificTableColumn[] = options.methods.map(method => {
    const result = results.find(result => result.method === method.key);
    if (result?.kind === 'charges') {
      const quantity = options.spin && result.spinAvailable ? 'spin-population' : result.quantity === 'electron-population' ? 'electron-population' : 'net-charge';
      const quantityLabel = quantity === 'spin-population' ? 'Spin / e' : quantity === 'electron-population' ? '盆内电子数 / e' : 'Q / e';
      return { ...method, heading: method.label, quantity, unit: 'e', quantityLabel, label: quantity === 'net-charge' ? method.label : `${method.label} · ${quantityLabel}` };
    }
    return { ...method, ...(result?.kind === 'bond-orders' ? { quantity: 'bond-order' as const, unit: 'dimensionless' as const } : {}) };
  });
  const columns: ScientificTableColumn[] = [{ key: 'target', label: options.kind === 'charges' ? '原子' : '原子对' },
    ...(options.kind === 'bond-orders' ? [{ key: 'length', label: '键长 / Å', quantity: 'bond-length' as const, unit: 'Å' as const }] : []), ...methods];
  if (options.kind === 'charges') return { columns, rows: comparisonAtomRows(results).map(row => ({ key: row.atomId,
    cells: [`${row.sourceIndex}${row.element}`, ...options.methods.map(method => {
      const result = results.find(result => result.method === method.key), value = row.values.get(method.key);
      return format(options.spin && result?.kind === 'charges' && result.spinAvailable ? value?.spinPopulation : value?.value);
    })] })) };
  return { columns, rows: comparisonBondRows(results).map(row => ({ key: row.key,
    cells: [`${row.sourceIndex1}–${row.sourceIndex2}`, format(options.getBondLength?.([row.atomId1, row.atomId2])), ...options.methods.map(method => format(row.values.get(method.key)?.value))] })) };
}
/** Raw full-precision archival helper. Daily TXT exports use the display projection. */
export function analysisComparisonText(results: readonly ComparisonResult[], sourceName: string, selectedMethods: readonly string[] = results.map(result => result.method)): string {
  const lines = [`# source=${textCell(sourceName)}`, `# selected_methods=${selectedMethods.join(',')}`];
  for (const result of results) {
    lines.push(`# method=${result.method}; session=${textCell(result.sessionId)}; revision=${textCell(result.sourceRevision)}; geometry_identity=${textCell(result.geometryIdentity)}; unit=${result.unit}; backend=${textCell(result.backend.name)} ${textCell(result.backend.version)}`);
    if (result.kind === 'charges') lines.push(`# ${result.method}.quantity=${result.quantity ?? 'net-charge'}; sum=${result.sum}; charge_convention=${textCell(result.chargeConvention)}`);
    for (const [key, value] of Object.entries(result.parameters ?? {})) lines.push(`# ${result.method}.parameter.${key}=${textCell(Array.isArray(value) ? value.join(',') : value)}`);
    for (const warning of result.warnings) lines.push(`# ${result.method}.warning=${textCell(warning)}`);
  }
  if (results[0]?.kind === 'charges') {
    lines.push(['source_index', 'atom_id', 'element', ...selectedMethods.flatMap(method => [`${method}.charge_e`, `${method}.spin_population_e`, `${method}.electron_population_e`, `${method}.reference_charge_e`])].join('\t'));
    for (const row of comparisonAtomRows(results)) lines.push([row.sourceIndex, row.atomId, row.element, ...selectedMethods.flatMap(method => { const value = row.values.get(method); return [value?.value, value?.spinPopulation, value?.electronPopulation, value?.referenceCharge]; })].map(textCell).join('\t'));
  } else {
    lines.push(['source_index_1', 'source_index_2', 'atom_id_1', 'atom_id_2', ...selectedMethods.map(method => `${method}.bond_order_dimensionless`)].join('\t'));
    for (const row of comparisonBondRows(results, false)) lines.push([row.sourceIndex1, row.sourceIndex2, row.atomId1, row.atomId2, ...selectedMethods.map(method => row.values.get(method)?.value)].map(textCell).join('\t'));
  }
  return lines.join('\n') + '\n';
}
