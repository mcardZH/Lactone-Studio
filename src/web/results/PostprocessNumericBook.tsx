import { useMemo, useState, type ReactNode } from 'react';
import type { TrajectoryResult } from '../../results/contracts';
import type { AtomicProperty,OrbitalChannel, ScientificField } from '../../results/scientific-contracts';
import { convertEnergy } from '../../results/energy';
import { frontierOrbitals } from '../../results/scientific-analysis';
import { exportBlob } from './export-image';
import { scientificDisplayValue as number, frameBindingLabel } from './scientific-presentation';
import { postprocessSoftwareLabel } from './postprocess-import-policy';
import { postprocessFields, postprocessFieldGroups, postprocessEnergyFields, postprocessThermochemistryGroups, postprocessDipoleFields, postprocessSourceLabel, postprocessSolventLabel, postprocessFinalSpinFields, postprocessStatusLabel, postprocessUnitLabel, postprocessFieldLabel,isPostprocessEnergyField,preferredPostprocessAtomic, type PostprocessEnergyUnit } from './PostprocessPresentation';
import './ScientificResultPanels.css';
import './Postprocess.css';
import {formatResultValue,fullPrecisionValue} from '../../results/numeric-format';
import { scientificTableText } from './scientific-table';
import type {ScientificTableProjection,ScientificTableLayoutState} from './scientific-table';
import {ScientificDataTable} from './ScientificDataTable';
import {AnalysisTaskSection} from './AnalysisTaskLayout';
import {nmrCouplingTableProjection,nmrCouplingAuditText} from '../../results/nmr-coupling-projection';
import NmrCouplingTable from './NmrCouplingTable';

export interface PostprocessNumericBookProps {
  result: TrajectoryResult; currentIndex: number;
  metadata?: PostprocessMetadata;
  /** Differences must be established by the source association layer, never inferred by UI. */
  sourceDifferences?: readonly { label: string; message: string }[];
}
export type PostprocessMetadata = Partial<Record<'method' | 'basis' | 'dispersion' | 'solvent', ScientificField>>;
export function PostprocessSourceReference({ source, fallback }: { source: { sourceName?: string; sourceId?: string; sourceLine: number }; fallback: TrajectoryResult['source'] }) {
  const name = source.sourceName ?? fallback.name;
  return <span className="postprocess-source-name" title={`${name} · ${source.sourceId ?? fallback.id}`}>{postprocessSourceLabel(name)}</span>;
}
export function PostprocessOrbitalSource({ orbital, channel, fallback }: { orbital: OrbitalChannel['orbitals'][number]; channel: OrbitalChannel; fallback: TrajectoryResult['source'] }) {
  return <><PostprocessSourceReference source={{ sourceName: orbital.sourceName ?? channel.sourceName, sourceId: orbital.sourceId ?? channel.sourceId, sourceLine: orbital.sourceLine ?? channel.sourceLine }} fallback={fallback}/><span>来源编号 {orbital.sourceIndex ?? '未记录'}</span><span>{String(orbital.energy)} {channel.unit}</span></>;
}
const sourceValue=(field:ScientificField)=>field.rawValue??fullPrecisionValue(field.value);
function metadataDisplayValue(field?:ScientificField){
  const value=field?.value;if(typeof value!=='string')return value;
  const labels:Record<string,Record<string,string>>={
    'reference-state':{restricted:'受限参考态',unrestricted:'非受限参考态','restricted-open-shell':'受限开壳层',unknown:'未确认'},
    'scf-status':{converged:'已收敛','not-converged':'未收敛',unconverged:'未收敛',failed:'失败',running:'运行中',incomplete:'未完成',unknown:'未确认'},
  };
  return labels[field!.key]?.[value.toLowerCase()]??value;
}
const fieldValue=(field:ScientificField,decimals:number,full:boolean)=>typeof field.value==='string'&&['reference-state','scf-status'].includes(field.key)?String(metadataDisplayValue(field)):full||isPostprocessEnergyField(field)?sourceValue(field):typeof field.value==='number'&&Number.isInteger(field.value)&&/number|count|iteration|multiplicity|^charge$/i.test(field.key)?String(field.value):formatResultValue(field.value,decimals);
export function sourceFieldsProjection(fields:readonly ScientificField[],source:TrajectoryResult['source'],decimals=2,fullPrecision=false,fullPrecisionFields:readonly ScientificField[]=[]):ScientificTableProjection {
  const present=fields.filter(field=>field.value!==null&&field.value!==undefined&&field.value!=='');
  const unitKeys=[...new Set(present.map(field=>field.unit??'__unknown__'))],mixed=unitKeys.length>1;
  const commonUnit=unitKeys.length===1&&unitKeys[0]!=='__unknown__'?unitKeys[0]:undefined;
  const unitText=(unit:string|undefined)=>unit==='dimensionless'||unit==='1'?'':unit??'单位未确认';
  const headerUnit=commonUnit?unitText(commonUnit):!mixed&&present.some(field=>typeof field.value==='number')?'单位未确认':undefined;
  return{columns:[{key:'property',label:'性质'},{key:'value',label:headerUnit?`值 / ${headerUnit}`:'值',heading:'值',unit:commonUnit,headerUnit,precision:fullPrecision||fields.every(field=>isPostprocessEnergyField(field)||fullPrecisionFields.includes(field))?'source':'adjustable'},...(mixed?[{key:'unit',label:'单位'}]:[]),{key:'source',label:'来源'}],rows:fields.map((field,index)=>({key:`${field.sourceId??source.id}:${field.frameIndex??'global'}:${field.key}:${field.sourceLine}:${index}`,cells:[postprocessFieldLabel(field),fieldValue(field,decimals,fullPrecision||fullPrecisionFields.includes(field)),...(mixed?[unitText(field.unit)]:[]),postprocessSourceLabel(field.sourceName??source.name)]}))};
}
export function SourceFields({ fields, fallbackSource,decimals,onDecimalsChange,fullPrecision=false,tableLabel='本表',hideTitle,scope,layoutState,onLayoutChange,onExport,expansion,useFieldLabels=false,emptyMessage='来源未输出此项。' }: { fields: readonly ScientificField[]; fallbackSource: TrajectoryResult['source'];decimals?:number;onDecimalsChange?(value:number):void;fullPrecision?:boolean;tableLabel?:string;hideTitle?:boolean;scope?:string;layoutState?:ScientificTableLayoutState;onLayoutChange?(value:ScientificTableLayoutState):void;onExport?():void;expansion?:{expanded:boolean;onToggle():void};useFieldLabels?:boolean;emptyMessage?:string }) {
  const [localDecimals,setLocalDecimals]=useState(2),precision=decimals??localDecimals;
  if (!fields.length) return <p className="postprocess-empty">{emptyMessage}</p>;
  const adjustable=!fullPrecision&&fields.some(field=>typeof field.value==='number'&&!isPostprocessEnergyField(field));
  const original=sourceFieldsProjection(fields,fallbackSource,precision,fullPrecision);
  const projection=useFieldLabels?{...original,rows:original.rows.map((row,index)=>({...row,cells:[fields[index].label,...row.cells.slice(1)]}))}:original;
  const sources=new Map(projection.rows.map((row,index)=>[row.key,fields[index]]));
  return <ScientificDataTable title={tableLabel} hideTitle={hideTitle} onExport={onExport} expansion={expansion} projection={projection} selectionScope={scope??`${fallbackSource.id}:${tableLabel}`} rowBindings={row=>{const field=sources.get(row.key)!;return{title:`${field.sourceName??fallbackSource.name} · ${field.sourceId??fallbackSource.id}`};}} layout="metrics" layoutState={layoutState} onLayoutChange={onLayoutChange} format={{decimals:precision,onDecimalsChange:value=>{setLocalDecimals(value);onDecimalsChange?.(value);},ariaLabel:tableLabel,locked:!adjustable}}/>;
}

const cleanCell = (value: unknown) => String(value ?? '').replace(/[\t\r\n]/g, ' ');
export function numericFieldsAuditText(fields: readonly ScientificField[], source: TrajectoryResult['source'],decimals?:number,fullPrecisionFields:readonly ScientificField[]=[]): string {
  return ['property\tvalue\tunit\tsource_name\tsource_id\tsource_line\tframe_index', ...fields.map(field => [field.label, decimals===undefined||fullPrecisionFields.includes(field)?sourceValue(field):formatResultValue(field.value,decimals), field.unit, field.sourceName ?? source.name, field.sourceId ?? source.id, Number.isSafeInteger(field.sourceLine)&&field.sourceLine>0?field.sourceLine:undefined, field.frameIndex].map(cleanCell).join('\t'))].join('\n') + '\n';
}
export function numericFieldsText(fields:readonly ScientificField[],source:TrajectoryResult['source'],decimals=2,fullPrecisionFields:readonly ScientificField[]=[]):string {
  return scientificTableText(sourceFieldsProjection(fields,source,decimals,false,fullPrecisionFields));
}
export function numericBookAuditText(result: TrajectoryResult,decimals?:number,orbitalUnit?:PostprocessEnergyUnit): string {
  const data = result.scientific,format=(value:number|string|null|undefined)=>decimals===undefined?fullPrecisionValue(value):formatResultValue(value,decimals);
  const fields=[...postprocessFields(result), ...(data?.thermochemistry ?? []), ...(data?.stability ?? []), ...(data?.bsse ?? [])];
  const rows = [`# Printed scientific values; ${decimals===undefined?'original precision':`display decimals=${decimals}`}; units retained`, numericFieldsAuditText(fields, result.source,decimals,[...postprocessFieldGroups(postprocessFields(result)).energy,...(data?.thermochemistry??[])]), '# orbitals', 'spin\torbital\tenergy\tunit\toccupation\tsource_name\tsource_id\tsource_line\tsource_index\tframe_index'];
  for (const channel of data?.orbitals ?? []) for (const row of channel.orbitals) rows.push([channel.spin, row.index, format(orbitalUnit?convertEnergy({value:row.energy,unit:channel.unit},orbitalUnit):row.energy), orbitalUnit??channel.unit, Number.isInteger(row.occupation)?String(row.occupation):format(row.occupation), row.sourceName ?? channel.sourceName ?? result.source.name, row.sourceId ?? channel.sourceId ?? result.source.id, row.sourceLine ?? channel.sourceLine, row.sourceIndex, channel.frameIndex].map(cleanCell).join('\t'));
  rows.push('# atomic_properties', 'kind\tscheme\tatom_index\telement\tvalue\tunit\tsource_name\tsource_id\tsource_line\tframe_index');
  for (const property of data?.atomicProperties ?? []) for (const row of property.values) rows.push([property.kind, property.scheme, row.atomIndex + 1, row.element, format(row.value), property.unit, property.sourceName ?? result.source.name, property.sourceId ?? result.source.id, property.sourceLine, property.frameIndex].map(cleanCell).join('\t'));
  if(data&&nmrCouplingTableProjection(data,result.source).rows.length)rows.push('# nmr_couplings',nmrCouplingAuditText(data,result.source));
  rows.push('# scf_cycles', 'cycle\titeration\tenergy\tdelta_energy\tunit\tsource_name\tsource_line\tframe_index');
  data?.scfCycles.forEach((cycle, index) => cycle.points.forEach(row => rows.push([index + 1, row.iteration, row.energy, row.deltaEnergy, 'hartree', result.source.name, cycle.sourceLine, cycle.frameIndex].map(cleanCell).join('\t'))));
  return rows.join('\n') + '\n';
}
export function orbitalTableProjection(channel:OrbitalChannel,unit:PostprocessEnergyUnit,decimals=2):ScientificTableProjection {
  return{columns:[{key:'orbital',label:'轨道'},{key:'energy',label:`能量 / ${postprocessUnitLabel(unit)}`},{key:'occupation',label:'占据数'}],rows:channel.orbitals.map(row=>({key:String(row.index),cells:[String(row.index),formatResultValue(convertEnergy({value:row.energy,unit:channel.unit},unit),decimals),Number.isInteger(row.occupation)?String(row.occupation):formatResultValue(row.occupation,decimals)]}))};
}
export function atomicTableProjection(property:AtomicProperty,decimals=2):ScientificTableProjection {
  const name=property.kind==='spin'?'自旋布居':property.kind==='shielding'?'屏蔽常数 σ':'净电荷 q';
  return{columns:[{key:'atom',label:'原子'},{key:'element',label:'元素'},{key:'value',label:`${name} / ${property.unit}`}],rows:property.values.map(row=>({key:String(row.atomIndex),cells:[String(row.atomIndex+1),row.element??'未输出',formatResultValue(row.value,decimals)]}))};
}
/** Ordinary text uses the same user-facing columns; audit identity is separate. */
export function numericBookText(result:TrajectoryResult,decimals=2,orbitalUnit:PostprocessEnergyUnit='eV'):string {
  const groups=postprocessFieldGroups(postprocessFields(result)),fields=[...postprocessEnergyFields(result,0),...groups.dipole,...groups.quadrupole,...groups.traceless,...groups.spin];
  const sections=[scientificTableText(sourceFieldsProjection(fields,result.source,decimals))];
  for(const channel of result.scientific?.orbitals??[])sections.push(`# ${channel.spin} · ${frameBindingLabel(channel.frameIndex)}\n`+scientificTableText(orbitalTableProjection(channel,orbitalUnit,decimals)));
  for(const property of result.scientific?.atomicProperties??[])sections.push(`# ${property.scheme} · ${frameBindingLabel(property.frameIndex)}\n`+scientificTableText(atomicTableProjection(property,decimals)));
  if(result.scientific){const coupling=nmrCouplingTableProjection(result.scientific,result.source);if(coupling.rows.length)sections.push('# 核自旋耦合\n'+scientificTableText(coupling));}
  return sections.join('\n');
}
export function postprocessEnergyPanelText(result:TrajectoryResult,currentIndex:number,decimals=2):string{
  const energy=postprocessEnergyFields(result,currentIndex),dipole=postprocessDipoleFields(result,currentIndex);
  const sections=[scientificTableText(sourceFieldsProjection([...energy,...dipole],result.source,decimals,false,energy))];
  if(result.scientific){const coupling=nmrCouplingTableProjection(result.scientific,result.source,currentIndex);if(coupling.rows.length)sections.push('# 核自旋耦合\n'+scientificTableText(coupling));}
  return sections.join('\n');
}
export function PostprocessEnergyPanel({ result, currentIndex, dipoleControl }: { result: TrajectoryResult; currentIndex: number; dipoleControl?: ReactNode;decimals?:number;onDecimalsChange?(value:number):void }) {
  const [decimals,setDecimals]=useState(2);
  const [expanded,setExpanded]=useState(false);
  const fields = postprocessEnergyFields(result, currentIndex), dipole=postprocessDipoleFields(result,currentIndex);
  const thermochemistry=result.frames[currentIndex]?.energyQuantity!=='potential'&&(result.scientific?.thermochemistry??[]).some(field=>field.frameIndex===currentIndex||field.frameIndex==null);
  const groups=postprocessThermochemistryGroups(fields);
  const coupling=useMemo(()=>result.scientific?nmrCouplingTableProjection(result.scientific,result.source,currentIndex):undefined,[result.scientific,result.source,currentIndex]);
  const visible=thermochemistry?[...groups.summary,...(expanded?groups.extra:[])]:fields;
  return <section aria-label="能量详情" className="postprocess-energy-panel"><AnalysisTaskSection title={thermochemistry?'热力学量':'能量'}><SourceFields hideTitle fields={visible} fallbackSource={result.source} fullPrecision useFieldLabels={thermochemistry} tableLabel={thermochemistry?'热力学量':'能量'} scope={`${result.id}:energy`}/>{thermochemistry&&groups.extra.length>0&&<button type="button" className="shared-input-action" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起热力学明细':'更多热力学量'}</button>}</AnalysisTaskSection><AnalysisTaskSection title="偶极矩 μ"><SourceFields hideTitle fields={dipole} fallbackSource={result.source} decimals={decimals} onDecimalsChange={setDecimals} tableLabel="偶极矩 μ" emptyMessage="当前帧无已确认对应的偶极矩。" scope={`${result.id}:dipole`}/>{dipoleControl}</AnalysisTaskSection>{!!coupling?.rows.length&&<AnalysisTaskSection title="核自旋耦合"><NmrCouplingTable result={result} currentIndex={currentIndex} projection={coupling} hideTitle/></AnalysisTaskSection>}</section>;
}

export function PostprocessBasicInfo({ result, currentIndex, metadata }: { result: TrajectoryResult | null; currentIndex: number; metadata?: PostprocessMetadata }) {
  const fields = result ? postprocessFields(result) : [];
  const field = (...keys: string[]) => [...fields].reverse().find(field => keys.includes(field.key) && field.frameIndex === currentIndex) ?? [...fields].reverse().find(field => keys.includes(field.key) && field.frameIndex == null);
  const energy = result?.frames[currentIndex]?.energy;
  const potential=result?.frames[currentIndex]?.energyQuantity==='potential';
  const displayedEnergy=result?postprocessEnergyFields(result,currentIndex).find(value=>value.key===(potential?'display-potential-energy':'display-electronic-energy')):undefined;
  const dipoleTotal = result ? postprocessDipoleFields(result,currentIndex).find(value=>value.key==='display-dipole-total') : undefined;
  const scfStatus = field('scf-status'), scfCount = field('scf-iterations', 'scf-cycle-count');
  const version=result?.scientific?.version;
  const software=postprocessSoftwareLabel(result?.engine==='gaussian'||result?.engine==='orca'?result.engine:result?.source.software);
  const readLimited=!!result?.scientific?.readLimits?.observations?.omitted;
  const info = [ ['软件', result ? version&&/^(?:Gaussian|ORCA)\b/i.test(version)?version:`${software}${version?` ${version}`:''}` : '未载入'],
    ['任务', result?.scientific?.tasks.map(task => task.toUpperCase()).join(' + ') || '未确认'],
    ['方法', metadata?.method?.value ?? field('method')?.value], ['基组', metadata?.basis?.value ?? field('basis', 'basis-set')?.value], ['色散', metadata?.dispersion?.value ?? field('dispersion')?.value], [potential?'势能':'电子能量', potential ? displayedEnergy ? `${sourceValue(displayedEnergy)} ${displayedEnergy.unit==='hartree'?'Eh':displayedEnergy.unit??'单位未确认'}` : '未输出' : energy ? `${displayedEnergy?.rawValue??fullPrecisionValue(energy.value)} ${energy.unit === 'hartree' ? 'Eh' : energy.unit}` : field('Total Energy', 'SCF Energy', 'target-energy', 'final-energy')?sourceValue(field('Total Energy', 'SCF Energy', 'target-energy', 'final-energy')!):'未输出'], ['参考态', metadataDisplayValue(field('reference-state'))], ['溶剂模型', field('solvent-model', 'solvent-model-smd')?.value], ['溶剂', postprocessSolventLabel(metadata?.solvent?.value ?? field('solvent', 'solvation')?.value, field('solvent-model', 'solvent-model-smd')?.value, field('solvent-epsilon')?.value)], ['ε', field('solvent-epsilon')?.value],
    ['电荷 / 多重度', result ? `${number(result.initialStructure.charge)} / ${number(result.initialStructure.multiplicity)}` : '未输出'],
    ...(field('solvent-epsilon-infinity') ? [['ε∞', field('solvent-epsilon-infinity')!.value]] : []),
    ['偶极矩总量', dipoleTotal ? `${formatResultValue(dipoleTotal.value)} ${dipoleTotal.unit ?? '单位未确认'}` : '未输出'],
    ['SCF 状态 / 次数', `${number(metadataDisplayValue(scfStatus))} / ${number(scfCount?.value)}`],
    ...(field('integration-grid') ? [['积分格点', field('integration-grid')!.value]] : []),
    ...(field('scf-settings') ? [['SCF 设置', field('scf-settings')!.value]] : []) ];
  return <section className="postprocess-basic" aria-label="后处理基础信息"><div className="postprocess-section-heading"><strong>基础信息</strong><span>{readLimited?`${result?.status==='failed'?'异常结束 · ':''}数据读取受限`:postprocessStatusLabel(result?.status)}</span></div><dl className="postprocess-values" style={{ fontSize: 'var(--workflow-body-size, 14px)', fontWeight: 500 }}>{info.map(([label, value]) => <div key={label as string} className={['方法', '基组', '色散', '电子能量','势能'].includes(String(label)) ? 'postprocess-value-accent' : undefined}><dt>{label}</dt><dd>{number(value)}</dd></div>)}</dl>{result && <details className="postprocess-metadata-details"><summary>详细计算设置</summary><SourceFields fallbackSource={result.source} fields={fields.filter(item => ['optimization-settings', 'ecp', 'relativistic', 'auxiliary-basis', 'ri', 'output-verbosity'].includes(item.key) && (item.frameIndex == null || item.frameIndex === currentIndex))}/>{result.scientific?.route && <pre>{result.scientific.route}</pre>}</details>}</section>;
}
export default function PostprocessNumericBook({ result, currentIndex, sourceDifferences = [] }: PostprocessNumericBookProps) {
  const [precisions,setPrecisions]=useState<Record<string,number>>({});
  const [units,setUnits]=useState<Record<string,PostprocessEnergyUnit>>({});
  const [layouts,setLayouts]=useState<Record<string,ScientificTableLayoutState>>({});
  const [page, setPage] = useState<'energy' | 'orbitals' | 'atoms' | 'properties' | 'source'>('orbitals');
  const [atomicIndex, setAtomicIndex] = useState<number | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const data = result.scientific, fields = postprocessFields(result), groups = postprocessFieldGroups(fields);
  const properties = data?.atomicProperties ?? [];
  const defaultAtomic = properties.indexOf(preferredPostprocessAtomic(properties, currentIndex)!);
  const atomic = properties[atomicIndex ?? defaultAtomic];
  const channels = data?.orbitals ?? [];
  const coupling=useMemo(()=>page==='properties'&&data?nmrCouplingTableProjection(data,result.source,currentIndex):undefined,[data,result.source,currentIndex,page]);
  type BookTable={id:string;label:string;projection:ScientificTableProjection;fields?:readonly ScientificField[];fullPrecision?:boolean;channel?:OrbitalChannel;coupling?:boolean};
  const tableId=(id:string)=>`${result.source.id}:${id}`,precision=(id:string)=>precisions[tableId(id)]??2,unit=(id:string)=>units[tableId(id)]??'eV';
  const tables:BookTable[]=page==='energy'?[{id:'energy',label:'来源能量与修正',fields:postprocessEnergyFields(result,currentIndex),projection:sourceFieldsProjection(postprocessEnergyFields(result,currentIndex),result.source,2,true),fullPrecision:true}]
    :page==='orbitals'?channels.map((channel,index)=>{const id=`orbital:${channel.sourceId??result.source.id}:${channel.spin}:${channel.frameIndex??'global'}:${index}`;return{id,label:`${channel.spin==='restricted'?'受限':channel.spin==='alpha'?'α':'β'} · ${frameBindingLabel(channel.frameIndex)}`,channel,projection:orbitalTableProjection(channel,unit(id),precision(id))};})
    :page==='atoms'?atomic?[{id:`atomic:${atomicIndex??defaultAtomic}`,label:atomic.scheme,projection:atomicTableProjection(atomic,precision(`atomic:${atomicIndex??defaultAtomic}`))}]:[]
    :page==='properties'?([['dipole','偶极矩 μ',groups.dipole],['quadrupole','普通四极矩 Q',groups.quadrupole],['traceless','无迹四极矩',groups.traceless],['spin','S²（当前结构最终记录）',postprocessFinalSpinFields(groups.spin,currentIndex)],['unbound-spin','结构归属未确认的 S²',groups.spin.filter(field=>field.frameIndex==null)]] as const).filter(([_id,_label,values])=>values.length).map(([id,label,values])=>({id,label,fields:values,projection:sourceFieldsProjection(values,result.source,precision(id))})):[];
  if(coupling?.rows.length)tables.push({id:'nmr-couplings',label:'核自旋耦合',projection:coupling,coupling:true});
  const exportData = () => {
    try { const output = page==='source'?numericBookAuditText(result):tables.map(table=>`# ${table.label}\n${scientificTableText(table.projection)}`).join('\n');
      exportBlob(new Blob([output], { type: 'text/plain;charset=utf-8' }), `Ester-Studio-result-job-${result.jobIndex + 1}.txt`); setExportMessage('已发起 TXT 下载。');
    } catch (error) { setExportMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <details className="postprocess-book"><summary>详细数值{sourceDifferences.length > 0 && <span className="postprocess-warning"> · {sourceDifferences.length} 项来源差异</span>}</summary>
    <nav className="postprocess-book-tabs" aria-label="结果数值册分页">{([['energy', '能量'], ['orbitals', '轨道'], ['atoms', '原子'], ['properties', '性质'], ['source', '来源']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={page === id} onClick={() => setPage(id)}>{label}</button>)}</nav>
    <div className="postprocess-actions"><button type="button" onClick={exportData} disabled={page!=='source'&&!tables.some(table=>table.projection.rows.length)}>{page==='source'?'导出原始审计 TXT':'导出当前页 TXT'}</button></div>
    <div className="postprocess-book-page">
      {page==='atoms'&&<label>来源原子性质 <select aria-label="数值册原子性质" value={atomicIndex??defaultAtomic} onChange={event=>setAtomicIndex(Number(event.target.value))}><option value={-1}>请选择来源方案</option>{properties.map((property,index)=><option key={index} value={index}>{property.kind==='spin'?'自旋布居':property.kind==='shielding'?'屏蔽常数':'净电荷'} · {property.scheme} · {frameBindingLabel(property.frameIndex)}</option>)}</select></label>}
      {page!=='source'&&!tables.length&&<p className="postprocess-empty">来源未输出此项，或尚未选择来源方案。</p>}
      {tables.map(table=><section key={table.id}><h4>{table.label}</h4>{table.channel&&<dl className="postprocess-values">{(()=>{const frontier=frontierOrbitals(table.channel,unit(table.id));return [['HOMO',frontier.homo?.energy],['LUMO',frontier.lumo?.energy],['GAP',frontier.gap]].map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{formatResultValue(value as number|undefined,precision(table.id))} {postprocessUnitLabel(unit(table.id))}</dd></div>);})()}</dl>}
        {table.coupling?<NmrCouplingTable result={result} currentIndex={currentIndex} projection={table.projection} hideTitle selectionScope={tableId(table.id)} layoutState={layouts[tableId(table.id)]} onLayoutChange={value=>setLayouts(old=>({...old,[tableId(table.id)]:value}))}/>:table.fields?<SourceFields fields={table.fields} fallbackSource={result.source} fullPrecision={table.fullPrecision} decimals={precision(table.id)} onDecimalsChange={value=>setPrecisions(old=>({...old,[tableId(table.id)]:value}))} tableLabel={table.label} scope={tableId(table.id)} layoutState={layouts[tableId(table.id)]} onLayoutChange={value=>setLayouts(old=>({...old,[tableId(table.id)]:value}))}/>
          :<ScientificDataTable variant={table.channel?'legacy':'numeric'} title={table.label} projection={table.projection} selectionScope={tableId(table.id)} layoutState={layouts[tableId(table.id)]} onLayoutChange={value=>setLayouts(old=>({...old,[tableId(table.id)]:value}))} format={{decimals:precision(table.id),onDecimalsChange:value=>setPrecisions(old=>({...old,[tableId(table.id)]:value})),ariaLabel:table.label,...(table.channel?{unit:unit(table.id),units:[{value:'eV',label:'eV'},{value:'hartree',label:'Eh'}],onUnitChange:(value:string)=>setUnits(old=>({...old,[tableId(table.id)]:value as PostprocessEnergyUnit}))}:{})}}/>}
      </section>)}
      {page === 'source' && <><p className="postprocess-source-name">{result.source.name}</p><p>来源 ID：{result.source.id} · 作业 {result.jobIndex + 1} · {result.source.size} bytes</p>{sourceDifferences.map((difference, index) => <p className="postprocess-warning" key={index}><strong>{difference.label}</strong> · {difference.message}</p>)}<p className="postprocess-note">来源数值保留完整精度；界面概览只做显示取舍，导出保留原始单位、来源行与结构归属。</p><details onToggle={event => setSourceOpen(event.currentTarget.open)}><summary>全部科学数据 / 完整精度</summary>{sourceOpen && <pre>{JSON.stringify(data ?? null, null, 2)}</pre>}</details>{result.messages.map((message, index) => <p className="postprocess-note" key={index}>{message}</p>)}</>}
    </div>{exportMessage && <p role="status">{exportMessage}</p>}
  </details>;
}
