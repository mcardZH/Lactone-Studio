import {decimalEnergyValue} from '../../results/numeric-format';
import type {PostprocessScientificFileDocument} from '../../results/postprocess-document';
import type {ScientificData} from '../../results/scientific-contracts';
import type {ScientificPlotSeries} from '../../results/scientific-plot';
import {postprocessFileJob} from '../../results/postprocess-sources';
import {convertEnergy,type EnergyUnit} from '../../results/energy';

export interface FilePathPlotScope {
  fileOwnerId: string;
  sourceId: string;
  sourceSha256?: string;
  jobId: string;
}

type PathReference = 'absolute' | 'relative-to-ts';
type PathNode = NonNullable<ScientificData['pathSummary']>[number];

export interface FilePathPlotSnapshot {
  kind: 'file-path';
  id: string;
  title: string;
  fileOwnerId: string;
  source: {id:string;name:string;size:number;sha256?:string};
  jobId: string;
  jobIndex: number | null;
  reference: PathReference;
  nodes: readonly Pick<PathNode,'sourceNode'|'energy'|'rawEnergy'|'unit'|'rawUnit'|'sourceLine'|'stageId'|'isTs'>[];
}

export function filePathPlotScope(document:PostprocessScientificFileDocument,jobId?:string):FilePathPlotScope|null {
  const source=document.output.source;
  const job=jobId===undefined?postprocessFileJob(source):source.jobs.find(job=>job.id===jobId);
  if(!job)return null;
  return{fileOwnerId:document.id,sourceId:source.identity.id,sourceSha256:source.identity.sha256,jobId:job.id};
}

export function matchesFilePathPlotScope(snapshot:FilePathPlotSnapshot,scope?:FilePathPlotScope|null):boolean {
  return !!scope&&snapshot.fileOwnerId===scope.fileOwnerId&&snapshot.source.id===scope.sourceId
    &&snapshot.source.sha256===scope.sourceSha256&&snapshot.jobId===scope.jobId;
}

/** Plot windows are rebuildable display state. Keep any retained job, including
 * an unselected one, but do not persist a closed/replaced file's orphan plot. */
export function retainedFilePathPlots<T>(snapshots:readonly T[]|null|undefined,documents:Readonly<Record<string,PostprocessScientificFileDocument>>):T[] {
  if(!Array.isArray(snapshots))return [];
  return snapshots.filter(snapshot=>{
    if(!snapshot||typeof snapshot!=='object')return false;
    const plot=snapshot as unknown as FilePathPlotSnapshot;
    if(plot.kind!=='file-path')return true;
    if(typeof plot.id!=='string'||typeof plot.title!=='string'||typeof plot.fileOwnerId!=='string'||typeof plot.jobId!=='string'
      ||!plot.source||typeof plot.source.id!=='string'||typeof plot.source.name!=='string'||!Number.isSafeInteger(plot.source.size)||plot.source.size<0
      ||!(plot.jobIndex===null||Number.isSafeInteger(plot.jobIndex)&&plot.jobIndex>=0)
      ||!['absolute','relative-to-ts'].includes(plot.reference)||!Array.isArray(plot.nodes)||!plot.nodes.length
      ||plot.nodes.some(node=>!node||!Number.isFinite(node.sourceNode)||!Number.isFinite(node.energy)||node.unit!=='hartree'||!Number.isSafeInteger(node.sourceLine)||node.sourceLine<1))return false;
    const document=documents[plot.fileOwnerId];
    return !!document&&matchesFilePathPlotScope(plot,filePathPlotScope(document,plot.jobId));
  });
}

export function createFilePathPlotSnapshot(document:PostprocessScientificFileDocument,reference:PathReference):FilePathPlotSnapshot|null {
  const source=document.output.source,job=postprocessFileJob(source);
  const rows=job?.scientific?.pathSummary?.filter(row=>(row.energyReference??'absolute')===reference);
  if(!job||!rows?.length)return null;
  const {id,name,size,sha256}=source.identity;
  return {
    kind:'file-path',id:JSON.stringify([document.id,id,sha256,job.id,reference]),
    title:reference==='relative-to-ts'?'相对 TS 路径能量':'路径能量',
    fileOwnerId:document.id,source:{id,name,size,...(sha256?{sha256}:{})},jobId:job.id,jobIndex:job.jobIndex,reference,
    nodes:rows.map(({sourceNode,energy,rawEnergy,unit,rawUnit,sourceLine,stageId,isTs})=>({sourceNode,energy,rawEnergy,unit,rawUnit,sourceLine,stageId,isTs})),
  };
}

export function filePathPlotProjection(snapshot:FilePathPlotSnapshot,display?:{unit:EnergyUnit;zeroIndex?:number}) {
  const energyToken=(row:FilePathPlotSnapshot['nodes'][number])=>row.rawEnergy??decimalEnergyValue(row.energy);
  const zeroNode=display?.zeroIndex === undefined ? undefined : snapshot.nodes[display.zeroIndex];
  const relativeToTs=!zeroNode&&snapshot.reference==='relative-to-ts';
  const title=relativeToTs?'Path Energy Relative to TS':'Path Energy Profile';
  const unit=display?.unit;
  const unitLabel=unit&&unit!=='hartree'?unit:'Eh';
  const series:ScientificPlotSeries[]=[{id:snapshot.reference,kind:'line',label:'Energy',showPoints:true,points:snapshot.nodes.map(row=>{
    const y=unit ? convertEnergy({value:row.energy-(zeroNode?.energy??0),unit:row.unit},unit) : row.energy;
    return {x:row.sourceNode,y,readoutId:row.sourceNode,markerLabel:row.isTs?'TS':undefined,
      tooltip:`Source Node ${row.sourceNode}${row.isTs?' · TS':''} · Line ${row.sourceLine}\nX ${row.sourceNode}\nY ${unit&&y!==null?decimalEnergyValue(y):energyToken(row)} ${unit?unitLabel:row.rawUnit??'Eh'}`};
  })}];
  const text=[
    `# ${snapshot.title}`,
    `# ${JSON.stringify({source:snapshot.source,jobId:snapshot.jobId,jobIndex:snapshot.jobIndex,reference:snapshot.reference})}`,
    'source_node\tenergy\tunit\tmarker\tsource_line\tstage',
    ...snapshot.nodes.map(row=>[row.sourceNode,energyToken(row),row.rawUnit??row.unit,row.isTs?'TS':'',row.sourceLine,row.stageId??''].join('\t')),
  ].join('\n')+'\n';
  return {title,series,text,zeroNode,unitLabel,xLabel:'Source Node',
    yLabel:`${relativeToTs?'Energy Relative to TS':zeroNode?'Relative Energy':'Energy'} / ${unitLabel}`};
}
