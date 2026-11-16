import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
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
import type {StructureExportPort,StructureExportSource} from './structure-export-source';
import {useStructureExport} from './useStructureExport';
import {captureDisplayedStructureDocument} from '../modeling/scientific-frame-source';
import ModelWorkspaceToolbar from '../modeling/ModelWorkspaceToolbar';
import type {ModelViewportProps} from '../modeling/ModelViewport';

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
export interface ScientificFileResultViewProps extends Omit<PostprocessResultViewProps,'document'>{document:PostprocessScientificFileDocument;onFileJob?(jobId:string):void;onOpenFilePathPlot?(snapshot:FilePathPlotSnapshot):void;onStructureExportPort?(document:PostprocessScientificFileDocument,port:StructureExportPort|null):void}
/** Actual associated frames reuse the complete public result/playback view.
 * An input echo uses the same read-only viewport with an explicit origin. */
export default function ScientificFileResultView(p:ScientificFileResultViewProps){
 const display=useMemo(()=>fileDisplayDocument(p.document),[p.document]);
 const job=postprocessFileJob(p.document.output.source),inputGeometry=job?.scientific?.inputGeometry;
 const input=useMemo(()=>inputEchoViewDocument(p.document),[p.document.id,job?.id,inputGeometry]);
 const inputView=useInputEchoBondDocument(display?null:input,p.active,{sourceId:p.document.output.source.identity.id,resultId:job?.id,jobIndex:job?.jobIndex??undefined},p.document.output.source.identity.sha256);
 const onCipLabelsUsed=useCurrentCipUsage(inputView.document??undefined,p.active&&!display,p.onCipLabelsUsed);
 const [preparedSource,setPreparedSource]=useState<{owner:PostprocessScientificFileDocument;source:StructureExportSource}|null>(null);
 const [imageSource,setImageSource]=useState<{owner:PostprocessScientificFileDocument;exportImage:()=>void}|null>(null);
 const receiveSource=useCallback((source:StructureExportSource|null)=>setPreparedSource(current=>source?{owner:p.document,source}:current?.owner===p.document?null:current),[p.document]);
 const receiveImage=useCallback((exportImage:(()=>void)|null)=>setImageSource(current=>exportImage?{owner:p.document,exportImage}:current?.owner===p.document?null:current),[p.document]);
 const live=useRef({owner:p.document,input,active:p.active});useLayoutEffect(()=>{live.current={owner:p.document,input,active:p.active};});
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const captureInput=useCallback(()=>{
  const current=live.current;if(!alive.current||!current.active||current.owner!==p.document||!current.input)throw Error('当前文件尚没有可靠的完整结构。');
  return{document:captureDisplayedStructureDocument(current.input),name:p.document.output.source.identity.name,assertCurrent:()=>{if(!alive.current||!live.current.active||live.current.owner!==p.document)throw Error('结构导出所属文件或作业已切换。');}};
 },[p.document]);
 const inputSource=useMemo<StructureExportSource>(()=>({available:p.active&&!!input,capture:captureInput}),[p.active,input,captureInput]);
 const source=display?preparedSource?.owner===p.document?preparedSource.source:undefined:inputSource;
 const structureExport=useStructureExport(source,p.onError);
 const currentImage=imageSource?.owner===p.document?imageSource.exportImage:undefined;
 const port=useMemo<StructureExportPort>(()=>({available:Boolean(source?.available&&!structureExport.busy),busy:structureExport.busy,save:structureExport.save,exportImage:currentImage}),[source?.available,structureExport.busy,structureExport.save,currentImage]);
 useLayoutEffect(()=>{p.onStructureExportPort?.(p.document,port);return()=>p.onStructureExportPort?.(p.document,null);},[p.onStructureExportPort,p.document,port]);
 useEffect(()=>{if(p.active)void window.sciyueDesktop?.updateWorkbenchFileState?.({canImport:Boolean(p.onImportFiles),canExportStructure:port.available,canExportImage:Boolean(port.exportImage)}).catch(()=>{});},[p.active,p.onImportFiles,port.available,port.exportImage]);
 const [cameraRequest,setCameraRequest]=useState<ModelViewportProps['cameraRequest']>(),[resetView,setResetView]=useState(0),[localAxes,setAxes]=useState(false);
 const axes=p.sharedShowAxes??localAxes,toggleAxes=()=>p.onSharedShowAxesChange?p.onSharedShowAxesChange(!axes):setAxes(!axes);
 const importInput=useRef<HTMLInputElement>(null);
 const exportStructure=()=>{void structureExport.save().catch(error=>p.onError(error instanceof Error?error.message:String(error)));};
 const toolbar=<ModelWorkspaceToolbar readOnly readOnlySaveAllowed={port.available} onSave={exportStructure} disabled={{save:!port.available}} onNew={p.onNewDocument} onImport={p.onImportFiles?()=>importInput.current?.click():undefined} display={p.display} onDisplayChange={p.onDisplay} onActivate={p.onActivate}
  atoms={inputView.document?.draft.structure.atoms} targetLabel={p.document.output.source.identity.name} hasCell={Boolean(inputView.document?.draft.structure.cell)} showAxes={axes} onShowAxesChange={value=>p.onSharedShowAxesChange?p.onSharedShowAxesChange(value):setAxes(value)}
  view={{showAxes:axes,hasAtoms:Boolean(input),hasCell:Boolean(input?.draft.structure.cell),showCell:p.display.cell,onCamera:request=>setCameraRequest(previous=>({...request,serial:(previous?.serial??0)+1})),onReset:()=>setResetView(value=>value+1),onToggleAxes:toggleAxes,onToggleCell:()=>p.onDisplay({...p.display,cell:!p.display.cell})}}/>;
 useLayoutEffect(()=>{if(p.selected&&!display)p.onToolbarSurfaceChange?.(toolbar);});
 if(display)return <><PostprocessResultView {...p} document={display} stageAdmission="defer-unattributed" onStructureExportSource={receiveSource} onImageExportReady={receiveImage} onExportStructure={exportStructure} structureExportBusy={structureExport.busy}/>{structureExport.dialog}</>;
 const numbers=<PostprocessFileInformation document={p.document} mode="numbers" onJob={p.onFileJob} onOpenFilePathPlot={p.onOpenFilePathPlot}/>;
 return <section className="postprocess-result-view" data-testid="scientific-file-result-view" data-file-source-id={p.document.output.source.identity.id}>
  {p.toolbarHost&&p.selected?createPortal(toolbar,p.toolbarHost):!p.onToolbarSurfaceChange?toolbar:null}
  <input hidden type="file" multiple ref={importInput} aria-label="后处理视口导入文件" onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';if(files.length)void p.onImportFiles?.(files).catch(error=>p.onError(error instanceof Error?error.message:String(error)));}}/>
  {p.toolHost?createPortal(numbers,p.toolHost):null}
  <div className="postprocess-model-canvas">
   {inputView.document?<ModelViewport onCipLabelsUsed={onCipLabelsUsed} document={inputView.document} display={p.display} cameraRequest={cameraRequest} resetViewRequest={resetView} showAxes={axes} interaction={{element:null,box:false,alt:false,gesture:'none'}} active={p.active} readOnly structureLocked observationFixedFrame observationTool="rotate" onHover={noEdit} onGestureStart={noEdit} onGestureEnd={noEdit} onSelection={noEdit} onCommand={noEdit} onError={p.onError} legendVisible={p.legendVisible} legendExpanded={p.legendExpanded} onLegendExpandedChange={p.onLegendExpandedChange} onLegendSurfaceChange={p.onLegendSurfaceChange}/>:<p className="postprocess-note">当前来源没有可显示的完整结构；已打印数值与原始来源保留。</p>}
  </div>
  {input&&<div className="postprocess-view-caption">输入 / 起始结构 · {input.draft.structure.atoms.length} 原子{inputView.preparing?' · 正在准备显示连接…':''}{inputView.warnings.length>0&&<details className="postprocess-metadata-details"><summary>显示连接提示</summary>{inputView.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}</div>}
  {structureExport.dialog}
 </section>;
}
