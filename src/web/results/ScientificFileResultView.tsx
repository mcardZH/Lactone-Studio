import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {ModelDocument} from '../../modeling/contracts';
import type {PostprocessScientificFileDocument} from '../../results/postprocess-document';
import {postprocessFileJob} from '../../results/postprocess-sources';
import ModelViewport from '../modeling/ModelViewport';
import {useCurrentCipUsage} from '../modeling/use-cip-usage';
import PostprocessResultView,{type PostprocessResultViewProps} from './PostprocessResultView';
import PostprocessFileInformation from './PostprocessFileInformation';
import type {FilePathPlotSnapshot} from './file-path-plot';
import {fileDisplayDocument} from './usePostprocessWorkspace';
import {createChemistryPort} from '../../modeling/chemistry';
import {EmpiricalFrameBonds,empiricalFrameBondDisplayStructure,empiricalFrameBondDisplayWarnings} from '../../results/empirical-frame-bonds';
import type {TrajectoryOperationContext} from '../../results/trajectory-operations';

/** Input coordinates are a display snapshot, with no trajectory or Store. */
export function inputEchoViewDocument(document:PostprocessScientificFileDocument):ModelDocument|null{
 const job=postprocessFileJob(document.output.source),input=job?.scientific?.inputGeometry;if(!job||!input)return null;
 const structure={...input.structure,atoms:input.structure.atoms.map((atom,index)=>({...atom,id:atom.id??`${job.id}:input-atom:${index}`}))},ids=structure.atoms.map(atom=>atom.id);
 if(!ids.length||ids.some(id=>!id)||new Set(ids).size!==ids.length||structure.atoms.some(atom=>![atom.x,atom.y,atom.z].every(Number.isFinite)))return null;
 const assignments={layers:[],basis:[],fragments:[],frozenAtomIds:[]};
 return{id:`${document.id}:input:${job.id}`,revision:0,draft:{structure,assignments,revision:0,selectedIds:[],touchedIds:[],assignmentIssues:[],createdFrom:{},past:[],future:[],dirty:false,baseAtomIds:ids as string[],baseStructure:structure,baseAssignments:assignments},selection:{atomIds:[],bonds:[],auxiliaryIds:[],portIds:[]},auxiliaryRelations:[],deletedBonds:[],attachmentPorts:[],canUndo:false,canRedo:false};
}
const noEdit=()=>{};
function inputDisplayDocument(input:ModelDocument,structure:ModelDocument['draft']['structure']):ModelDocument{
 return{...input,draft:{...input.draft,structure,baseStructure:structure}};
}
/** A single input-display consumer; file bytes/jobs remain owned by the file.
 * Its graph uses the same empirical service as result preparation, without
 * constructing a trajectory or committing any geometry/graph to a Store. */
export function useInputEchoBondDocument(input:ModelDocument|null,active:boolean,context:TrajectoryOperationContext,sourceRevision?:string){
 const epoch=useRef(0),[prepared,setPrepared]=useState<{input:ModelDocument;document:ModelDocument;warnings:string[]}|null>(null);
 const empty=useMemo(()=>input?inputDisplayDocument(input,{...input.draft.structure,bonds:[]}):null,[input]);
 const sourceId=context.sourceId,resultId=context.resultId,jobIndex=context.jobIndex;
 useEffect(()=>{
  const generation=++epoch.current;setPrepared(null);
  if(!input||!active)return;
  const controller=new AbortController(),provider=new EmpiricalFrameBonds({port:{capabilities:()=>createChemistryPort().capabilities(),start:request=>createChemistryPort().start(request)},sourceId:input.id,sourceRevision,retainCache:false,operationContext:{sourceId,resultId,jobIndex}});
  const guard=()=>{if(controller.signal.aborted||epoch.current!==generation)throw new DOMException('输入显示来源已切换。','AbortError');};
  void provider.resolve(input.draft.structure,0,{signal:controller.signal,guard}).then(value=>{
   if(controller.signal.aborted||epoch.current!==generation||value.status==='cancelled'||value.status==='stale')return;
   setPrepared({input,document:inputDisplayDocument(input,empiricalFrameBondDisplayStructure(value)),warnings:empiricalFrameBondDisplayWarnings(value)});
  }).catch(error=>{if(!controller.signal.aborted&&epoch.current===generation)setPrepared({input,document:empty!,warnings:[error instanceof Error?error.message:String(error)]});});
  return()=>{controller.abort();provider.dispose();};
 },[input,active,sourceId,resultId,jobIndex,sourceRevision]);
 const current=active&&prepared?.input===input?prepared:null;
 return{document:current?.document??empty,preparing:Boolean(input&&active&&!current),warnings:current?.warnings??[]};
}
export interface ScientificFileResultViewProps extends Omit<PostprocessResultViewProps,'document'>{document:PostprocessScientificFileDocument;onFileJob?(jobId:string):void;onOpenFilePathPlot?(snapshot:FilePathPlotSnapshot):void}
/** Actual associated frames reuse the complete public result/playback view.
 * An input echo uses the same read-only viewport with an explicit origin. */
export default function ScientificFileResultView(p:ScientificFileResultViewProps){
 const display=useMemo(()=>fileDisplayDocument(p.document),[p.document]);
 const job=postprocessFileJob(p.document.output.source),inputGeometry=job?.scientific?.inputGeometry;
 const input=useMemo(()=>inputEchoViewDocument(p.document),[p.document.id,job?.id,inputGeometry]);
 const inputView=useInputEchoBondDocument(display?null:input,p.active,{sourceId:p.document.output.source.identity.id,resultId:job?.id,jobIndex:job?.jobIndex??undefined},p.document.output.source.identity.sha256);
 const onCipLabelsUsed=useCurrentCipUsage(inputView.document??undefined,p.active&&!display,p.onCipLabelsUsed);
 if(display)return <PostprocessResultView {...p} document={display} stageAdmission="defer-unattributed"/>;
 const numbers=<PostprocessFileInformation document={p.document} mode="numbers" onJob={p.onFileJob} onOpenFilePathPlot={p.onOpenFilePathPlot}/>;
 return <section className="postprocess-result-view" data-testid="scientific-file-result-view" data-file-source-id={p.document.output.source.identity.id}>
  {p.toolHost?createPortal(numbers,p.toolHost):null}
  <div className="postprocess-model-canvas">
   {inputView.document?<ModelViewport onCipLabelsUsed={onCipLabelsUsed} document={inputView.document} display={p.display} interaction={{element:null,box:false,alt:false,gesture:'none'}} active={p.active} readOnly structureLocked observationFixedFrame observationTool="rotate" onHover={noEdit} onGestureStart={noEdit} onGestureEnd={noEdit} onSelection={noEdit} onCommand={noEdit} onError={p.onError} legendVisible={p.legendVisible} legendExpanded={p.legendExpanded} onLegendExpandedChange={p.onLegendExpandedChange} onLegendSurfaceChange={p.onLegendSurfaceChange}/>:<p className="postprocess-note">当前来源没有可显示的完整结构；已打印数值与原始来源保留。</p>}
  </div>
  {input&&<div className="postprocess-view-caption">输入 / 起始结构 · {input.draft.structure.atoms.length} 原子{inputView.preparing?' · 正在准备显示连接…':''}{inputView.warnings.length>0&&<details className="postprocess-metadata-details"><summary>显示连接提示</summary>{inputView.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}</div>}
 </section>;
}
