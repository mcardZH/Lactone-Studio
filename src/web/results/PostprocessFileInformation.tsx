import type {ResultDiagnostic,TrajectoryResult} from '../../results/contracts';
import {useMemo,useState,type ReactNode} from 'react';
import type {ScientificData,ScientificDiagnostics} from '../../results/scientific-contracts';
import {postprocessFileJob} from '../../results/postprocess-sources';
import type {PostprocessScientificFileDocument} from '../../results/postprocess-document';
import {SourceFields} from './PostprocessNumericBook';
import {ScientificDataTable} from './ScientificDataTable';
import {ScientificPlot} from './ScientificPlot';
import type {ScientificTableProjection} from './scientific-table';
import {fullPrecisionValue} from '../../results/numeric-format';
import {excitedStateTable,vibrationModeTable} from './spectroscopy-presentation';
import {projectVibrationModes} from '../../results/spectroscopy';
import {createFilePathPlotSnapshot,filePathPlotProjection,type FilePathPlotSnapshot} from './file-path-plot';

export function FilePathEnergyPlot({snapshot,toolbar}:{snapshot:FilePathPlotSnapshot;toolbar?:ReactNode}) {
 const projection=useMemo(()=>filePathPlotProjection(snapshot),[snapshot]);
 return <ScientificPlot title={snapshot.title} xLabel="源节点" yLabel={projection.yLabel}
  series={projection.series} toolbar={toolbar} appearanceKey={snapshot.id}
  exportFileName="Ester-Studio-path-energy" exportText={{fileName:'Ester-Studio-path-energy.txt',text:projection.text}}
  metadata={{source:snapshot.source,jobId:snapshot.jobId,jobIndex:snapshot.jobIndex,reference:snapshot.reference}}/>;
}

const termination={normal:'正常结束',error:'错误终止','not-observed':'未观察到终止标记'};
const integrity={'complete-snapshot':'完整读取快照','damaged-tail':'尾部损坏','changed-during-read':'读取期间变化',unknown:'完整性未知'};
const taskStatus={completed:'已收敛','not-converged':'未收敛',incomplete:'未完成',unknown:'未确认'};
const stageLabel=(value:string)=>({'irc-forward':'正向 IRC','irc-reverse':'反向 IRC','ts-optimization':'TS 优化','neb-path':'NEB 路径',optimization:'结构优化',path:'路径',freq:'频率',irc:'IRC',scf:'SCF'}[value]??value.toUpperCase());
/** Program exit, byte integrity and individual stages are independent facts. */
export function postprocessScientificStatusRows(data:ScientificData,currentIndex?:number):{label:string;value:string;sourceLine?:number;raw?:string}[]{
 const d=data.diagnostics;if(!d)return[];
 const rows=[{label:'文件',value:d.integrity.message??integrity[d.integrity.status],sourceLine:d.integrity.sourceLine},{label:'程序',value:termination[d.termination.status],sourceLine:d.termination.sourceLine,raw:d.termination.raw}];
 const tasks=new Map<string,ScientificDiagnostics['tasks'][number]>();
 for(const event of d.tasks){if(currentIndex!==undefined&&event.frameIndex!=null&&event.frameIndex!==currentIndex)continue;tasks.set(event.stageId??event.task,event);}
 for(const [stage,event]of tasks){
  const iterations=data.pathIterations?.filter(row=>row.stageId===event.stageId).length;
  const limitReached=event.status==='not-converged'&&/maximum\s+(?:number\s+of\s+)?(?:IRC\s+)?iterations|MaxIter|iteration\s+limit/i.test(event.raw??'');
  rows.push({label:stageLabel(stage),value:limitReached?`达到${iterations?`${iterations}次`:''}迭代上限，未收敛`:event.status==='completed'&&!/irc|path|opt|neb/.test(stage)?'已完成':taskStatus[event.status],sourceLine:event.sourceLine,raw:event.raw});
 }
 const scf=d.scf.filter(event=>currentIndex===undefined||event.frameIndex==null||event.frameIndex===currentIndex);
 if(scf.length){const statuses=new Set(scf.map(event=>event.status));rows.push({label:'SCF',value:statuses.size>1?'含不同收敛状态':scf[0].status==='converged'?'已收敛':scf[0].status==='not-converged'?'未收敛':'未确认',sourceLine:scf[scf.length-1].sourceLine});}
 return rows;
}
export function PostprocessScientificStatus({data,currentIndex}:{data:ScientificData;currentIndex?:number}){
 const rows=postprocessScientificStatusRows(data,currentIndex);
 return rows.length?<dl className="postprocess-values" aria-label="来源与科学状态">{rows.map(row=><div key={row.label} title={row.sourceLine?`原文第 ${row.sourceLine} 行${row.raw?` · ${row.raw}`:''}`:undefined}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>:null;
}
export function postprocessPathTable(data:ScientificData,reference:'absolute'|'relative-to-ts'):ScientificTableProjection{
 const nodes=(data.pathSummary??[]).filter(row=>(row.energyReference??'absolute')===reference);
 return{columns:[{key:'node',label:'源节点'},{key:'energy',label:reference==='relative-to-ts'?'相对 TS 能量 / Eh':'能量 / Eh',precision:'source'},{key:'role',label:'标记'}],rows:nodes.map((row,index)=>({key:`${row.stageId??row.kind}:${row.sourceNode}:${row.sourceLine}:${index}`,cells:[String(row.sourceNode),row.rawEnergy??fullPrecisionValue(row.energy),row.isTs?'TS':'']}))};
}
type FileJob=TrajectoryResult|ResultDiagnostic;
const keepSourcePrecision=()=>{};
function jobCharge(job:FileJob){return job.kind==='diagnostic'?job.charge:job.initialStructure.charge;}
function jobMultiplicity(job:FileJob){return job.kind==='diagnostic'?job.multiplicity:job.initialStructure.multiplicity;}

/** This surface consumes file/job facts directly. It never creates an empty
 * TrajectoryResult, and numeric nodes have no frame-seek action. */
export function postprocessStructureSourceLabel(document:PostprocessScientificFileDocument):string{
 const job=postprocessFileJob(document.output.source),displayed=document.displayResult;
 if(displayed&&job&&displayed.scientific?.ircEvidence?.outputId===job.id)return '已配对路径';
 if(displayed&&job&&displayed.id===job.id&&displayed.source.id===job.source.id&&displayed.frames.length)return '计算输出结构';
 return job?.scientific?.inputGeometry?'输入 / 起始结构':'未输出可用结构';
}
export default function PostprocessFileInformation({document,mode='all',onJob,onOpenFilePathPlot}:{document:PostprocessScientificFileDocument;mode?:'summary'|'numbers'|'all';onJob?(id:string):void;onOpenFilePathPlot?(snapshot:FilePathPlotSnapshot):void}){
 const [decimals,setDecimals]=useState(2);
 const pathPlots=useMemo(()=>mode==='summary'?[]:(['absolute','relative-to-ts'] as const).flatMap(reference=>{
  const snapshot=createFilePathPlotSnapshot(document,reference);
  return snapshot?[snapshot]:[];
 }),[document,mode]);
 const source=document.output.source,job=postprocessFileJob(source),data=job?.scientific;
 if(!job||!data)return mode==='numbers'?<p className="postprocess-note">选择来源与阶段后查看其已打印数值。</p>:<section className="postprocess-basic" aria-label="文件来源信息"><FileJobChooser document={document} onJob={onJob}/><p className="postprocess-note">此文件包含多个独立作业，请选择来源与阶段。各作业原始信息均已保留。</p></section>;
 const fields=[...data.summary,...data.properties],find=(...keys:string[])=>fields.find(field=>keys.includes(field.key));
 const software=job.engine==='gaussian'?'Gaussian':job.engine==='orca'?'ORCA':'生产软件未确认';
 const info=[['软件',data.version&&/^(?:Gaussian|ORCA)\b/i.test(data.version)?data.version:`${software}${data.version?` ${data.version}`:''}`],['作业',job.jobIndex==null?'未关联作业':`job ${job.jobIndex+1}`],['任务',data.tasks.map(task=>task.toUpperCase()).join(' + ')||'未确认'],['方法',find('method')?.value],['基组',find('basis','basis-set')?.value],['电荷 / 多重度',`${jobCharge(job)??'未知'} / ${jobMultiplicity(job)??'未知'}`],['结构来源',postprocessStructureSourceLabel(document)],...(data.pathSummary?.length?[['路径能量',`${data.pathSummary.length}点`]]:[])];
 return <>
  {mode!=='numbers'&&<section className="postprocess-basic" aria-label="后处理基础信息"><div className="postprocess-section-heading"><strong>基础信息</strong></div><FileJobChooser document={document} onJob={onJob}/><dl className="postprocess-values">{info.map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{value??'未输出'}</dd></div>)}</dl><PostprocessScientificStatus data={data}/>{data.inputGeometry&&!document.displayResult&&<p className="postprocess-note">输入 / 起始结构 · {data.inputGeometry.structure.atoms.length} 原子 · 原文第 {data.inputGeometry.sourceLine}–{data.inputGeometry.endSourceLine} 行</p>}</section>}
  {mode!=='summary'&&<section className="postprocess-numeric-book" aria-label="文件科学数值">
   {fields.length>0&&<SourceFields fields={fields} fallbackSource={job.source} tableLabel="已打印科学数值" fullPrecision scope={`${document.id}:${job.id}:fields`}/>}
   {pathPlots.map(snapshot=>{
    const projection=postprocessPathTable(data,snapshot.reference);
    return <section key={snapshot.id} aria-label={snapshot.title}>
     <ScientificDataTable title={snapshot.title} projection={projection} selectionScope={snapshot.id}
      format={{decimals:2,onDecimalsChange:keepSourcePrecision,locked:true}}
      rowBindings={row=>{const node=snapshot.nodes[projection.rows.indexOf(row)];return{title:`${job.source.name} · 第 ${node.sourceLine} 行${node.stageId?` · ${node.stageId}`:''}`};}}/>
     <FilePathEnergyPlot snapshot={snapshot} toolbar={onOpenFilePathPlot&&<button type="button" className="shared-input-action" onClick={()=>onOpenFilePathPlot(snapshot)}>在内部图窗打开 ↗</button>}/>
    </section>;
   })}
   {!!data.thermochemistry.length&&<SourceFields fields={data.thermochemistry} fallbackSource={job.source} tableLabel="已打印热化学量" fullPrecision/>}
   {data.excitedStates.length>0&&<ScientificDataTable title="已打印激发态" projection={excitedStateTable(data.excitedStates,data.reference==='unrestricted',decimals)} selectionScope={`${document.id}:${job.id}:excited-states`} format={{decimals,onDecimalsChange:setDecimals}} rowBindings={row=>{const state=data.excitedStates[Number(row.key)];return{title:`${job.source.name} · 第 ${state.sourceLine} 行 · ${state.frameIndex==null?'未绑定几何':`源帧 ${state.frameIndex+1}`}`};}}/>}
   {(data.vibrationSets??(data.vibrations?[data.vibrations]:[])).map((set,setIndex)=>{const modes=projectVibrationModes(set.modes,{includeRigid:true});if(!modes.length)return null;return <ScientificDataTable key={`${set.sourceId??job.source.id}:${setIndex}`} title={`已打印频率 · 组 ${setIndex+1}`} projection={vibrationModeTable(modes,false,decimals)} selectionScope={`${document.id}:${job.id}:vibrations:${setIndex}`} format={{decimals,onDecimalsChange:setDecimals}} rowBindings={row=>{const mode=modes.find(mode=>String(mode.displayIndex)===row.key)!;return{title:`${set.sourceName??job.source.name} · 原生模式 ${mode.sourceIndex} · 第 ${mode.sourceLine} 行 · ${set.frameIndex==null?'未绑定几何':`源帧 ${set.frameIndex+1}`}`};}}/>;})}
   <details className="postprocess-metadata-details"><summary>输入 / 来源详情</summary>{data.printedRoute||data.route?<pre>{data.printedRoute||data.route}</pre>:null}{job.messages.map((message,index)=><p key={index}>{message}</p>)}{data.diagnostics?.errors.map((error,index)=><p key={index}>原文第 {error.sourceLine} 行 · {error.raw}</p>)}</details>
  </section>}
 </>;
}
export function FileJobChooser({document,onJob}:{document:PostprocessScientificFileDocument;onJob?(id:string):void}){
 const source=document.output.source,job=postprocessFileJob(source);
 return source.jobs.length>1?<label className="trajectory-stage-choice">阶段<select aria-label="结果来源与阶段" value={job?.id??''} disabled={!onJob} onChange={event=>onJob?.(event.target.value)}>{!job&&<option value="">选择来源与阶段</option>}{source.jobs.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>:null;
}
