import {AnalysisCitationContext} from '../../projects/analysis-state';
import {citationDocumentIdFromScope} from '../../citations/workspace-facts';
import {useCallback,useEffect,useLayoutEffect,useRef,useState,type DragEvent,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {AnalysisCardDeck,type AnalysisPage} from './PostprocessDisplayPanel';
import MultiwfnPathControl from './MultiwfnPathControl';
import {analysisWorkspaceReducer,activeDockedAnalysis,initialAnalysisWorkspace,validateAnalysisWorkspace,reachableAnalysisWindowBounds,ANALYSIS_TITLES,type AnalysisInstance,type AnalysisWorkspaceAction,type AnalysisWorkspaceState} from './analysis-workspace';
import {ProjectUiScope,useProjectUiScope,useProjectState,useProjectUiSnapshot} from '../../projects/ui-state';
import {ModelDocumentDeck} from '../modeling/ModelDocumentDeck';
import type {AnalysisWindowLease,AnalysisWindowBounds} from '../../modeling/contracts';
import {bootstrapWindowVisuals} from '../window-visual-bootstrap';
import WorkspaceTab from '../modeling/WorkspaceTab';
import {resolveWorkspaceTabDropIntent,workspaceTabDragMoved,workspaceTabTargetContains} from '../modeling/workspace-tab-drag';
import './analysis-workspace.css';
const MIME='application/x-sciyue-analysis';
type Popup={window:Window;lease:AnalysisWindowLease|null;header:HTMLElement;released:boolean;restoring:boolean;disposeVisuals():void};
type AnalysisTabDrag={id?:string;kind?:AnalysisPage;source:string;handled:boolean;cancelled:boolean;x:number;y:number;release():void};
function Slot({container,parking}:{container:HTMLElement;parking:HTMLElement|null}){const ref=useRef<HTMLDivElement>(null);useLayoutEffect(()=>{ref.current?.appendChild(container);return()=>{if(container.parentNode===ref.current)parking?.appendChild(container);};},[container,parking]);return <div className="analysis-pane-slot" ref={ref}/>;}
function AnalysisWorkspaceInner(p:{sourceId:string;active:boolean;initialPage?:AnalysisPage;requestedPage?:{serial:number;page:AnalysisPage};allowedPages?:readonly AnalysisPage[];unavailableReason?(page:AnalysisPage):string|undefined;onActive(id:string|null):void;onActivate():void;onRequest?(kind:AnalysisPage):void;onError(message:string):void;render(instance:AnalysisInstance,active:boolean):ReactNode}){
 const [savedState,setState]=useProjectState<AnalysisWorkspaceState>('state',()=>initialAnalysisWorkspace(`analysis-${crypto.randomUUID()}`,p.initialPage&&(!p.allowedPages||p.allowedPages.includes(p.initialPage))?p.initialPage:p.allowedPages?.[0]));
 const citationUi=useProjectUiScope(),citationDocumentId=citationDocumentIdFromScope(citationUi?.scope??[]);
 const citationSource=(()=>{try{return JSON.parse(p.sourceId) as unknown[];}catch{return [];}})();
 const validated=validateAnalysisWorkspace(savedState),allowedInstances=p.allowedPages?validated.instances.filter(item=>p.allowedPages!.includes(item.kind)):validated.instances;
 const state=p.allowedPages?{...validated,instances:allowedInstances,activeId:allowedInstances.some(item=>item.id===validated.activeId)?validated.activeId:allowedInstances[0]?.id??null,groupActive:Object.fromEntries(Object.entries(validated.groupActive).filter(([,id])=>allowedInstances.some(item=>item.id===id)))}:validated;
 const [popupsVersion,setPopupsVersion]=useState(0),[size,setSize]=useState({width:0,height:0}),[arrangeRequest,setArrangeRequest]=useState(0);
 const root=useRef<HTMLElement>(null);
 const deck=useRef<HTMLDivElement>(null);
 const stateRef=useRef(state);stateRef.current=state;const alive=useRef(true),parking=useRef<HTMLDivElement>(null),containers=useRef(new Map<string,HTMLElement>()),popups=useRef(new Map<string,Popup>()),pending=useRef(new Set<string>()),drag=useRef<AnalysisTabDrag|null>(null);
 const dispatch=useCallback((action:AnalysisWorkspaceAction)=>{stateRef.current=analysisWorkspaceReducer(stateRef.current,action);setState(stateRef.current);},[setState]);
 const readBounds=(child:Window):AnalysisWindowBounds|undefined=>{try{if(child.closed)return;return{x:Math.round(child.screenX),y:Math.round(child.screenY),width:Math.round(child.outerWidth),height:Math.round(child.outerHeight)};}catch{return;}};
 useProjectUiSnapshot('state',()=>({...stateRef.current,windowBounds:{...stateRef.current.windowBounds,...Object.fromEntries([...popups.current].flatMap(([id,popup])=>{const bounds=readBounds(popup.window);return bounds?[[id,bounds]]:[];}))}}));
 const callbacks=useRef(p);callbacks.current=p;
 const element=(id:string)=>{let value=containers.current.get(id);if(!value){value=document.createElement('div');value.className='analysis-instance-container';value.dataset.analysisInstance=id;containers.current.set(id,value);}return value;};
 const activate=useCallback((id:string)=>{dispatch({type:'activate',id});callbacks.current.onActivate();},[]);
 const reclaim=useCallback((id:string)=>{const popup=popups.current.get(id);if(!popup)return;popup.released=true;popup.disposeVisuals();const container=containers.current.get(id);if(container)parking.current?.appendChild(container);popups.current.delete(id);if(popup.lease)void window.sciyueDesktop?.releaseAnalysisWindow?.({leaseId:popup.lease.leaseId}).catch(()=>{});else popup.window.close();if(alive.current)setPopupsVersion(value=>value+1);},[]);
 const close=useCallback((id:string)=>{reclaim(id);dispatch({type:'close',id});},[reclaim]);
 const dock=useCallback((id:string,group:string,before?:string)=>{reclaim(id);dispatch({type:'place',id,group,detached:false,before});activate(id);},[reclaim,activate]);
 const detach=useCallback(async(id:string,restoring=false)=>{if(pending.current.has(id))return;const existing=popups.current.get(id);if(existing){if(!restoring){existing.window.focus();activate(id);}return;}const item=stateRef.current.instances.find(row=>row.id===id);if(!item)return;pending.current.add(id);
  let child:Window|null=null,lease:AnalysisWindowLease|null=null,disposeVisuals:(()=>void)|undefined;
  try{const title=`${ANALYSIS_TITLES[item.kind]} · Ester Studio`,screen=window.screen as Screen&{availLeft?:number;availTop?:number},bounds=reachableAnalysisWindowBounds(stateRef.current.windowBounds?.[id],{x:screen.availLeft??0,y:screen.availTop??0,width:screen.availWidth,height:screen.availHeight});lease=await window.sciyueDesktop?.prepareAnalysisWindow?.({instanceId:id,title,bounds})??null;if(!alive.current||!stateRef.current.instances.some(row=>row.id===id)){if(lease)await window.sciyueDesktop?.releaseAnalysisWindow?.({leaseId:lease.leaseId});return;}
   child=window.open('about:blank',lease?.target??`sciyue-analysis-${id}`,lease?'':`popup,width=${bounds.width},height=${bounds.height},left=${bounds.x},top=${bounds.y}`);if(!child)throw Error('独立窗口未能打开，请允许应用窗口。');
   child.document.title=title;disposeVisuals=bootstrapWindowVisuals(root.current?.ownerDocument??document,child.document);
   child.document.body.className='analysis-detached-body';const shell=child.document.createElement('main');shell.className='analysis-detached-shell';const header=child.document.createElement('header');header.className='analysis-detached-header';shell.appendChild(header);shell.appendChild(element(id));child.document.body.appendChild(shell);
   const popup:Popup={window:child,lease,header,released:false,restoring,disposeVisuals};popups.current.set(id,popup);
   child.addEventListener('focus',()=>{if(!popup.released&&!popup.restoring)activate(id);});child.addEventListener('beforeunload',()=>{popup.disposeVisuals();if(!popup.released&&alive.current){parking.current?.appendChild(element(id));popups.current.delete(id);dispatch({type:'close',id});setPopupsVersion(value=>value+1);}});
   child.addEventListener('resize',()=>{if(!popup.released){const bounds=readBounds(child!);if(bounds)dispatch({type:'window-bounds',id,bounds});}});
   if(!restoring||!item.detached)dispatch({type:'place',id,group:item.group,detached:true});setPopupsVersion(value=>value+1);if(!restoring){activate(id);child.focus();}
  }catch(error){const failed=popups.current.get(id);if(failed){failed.released=true;popups.current.delete(id);const container=containers.current.get(id);if(container)parking.current?.appendChild(container);}disposeVisuals?.();if(child&&!child.closed)child.close();if(lease)void window.sciyueDesktop?.releaseAnalysisWindow?.({leaseId:lease.leaseId}).catch(()=>{});if(restoring&&alive.current&&stateRef.current.instances.some(item=>item.id===id))dispatch({type:'place',id,group:item.group,detached:false});callbacks.current.onError(`${restoring?'独立分析窗口恢复失败，已保留为停靠面板：':''}${error instanceof Error?error.message:String(error)}`);}finally{pending.current.delete(id);}
 },[activate]);
 const focus=useCallback((id:string)=>{const item=stateRef.current.instances.find(row=>row.id===id);if(item)callbacks.current.onRequest?.(item.kind);activate(id);popups.current.get(id)?.window.focus();},[activate]);
 const add=useCallback((kind:AnalysisPage,external=false)=>{
  if(p.allowedPages&&!p.allowedPages.includes(kind))return '';
  const current=stateRef.current,existing=current.instances.find(row=>row.kind===kind);
  if(existing){focus(existing.id);if(external)void detach(existing.id);return existing.id;}
  const instance:AnalysisInstance={id:`analysis-${crypto.randomUUID()}`,kind,group:'main',detached:false};
  // Reserve synchronously so two card/+ gestures before a React commit still
  // address the same instance, including an in-flight detached-window lease.
  dispatch({type:'add',instance});
  callbacks.current.onRequest?.(kind);
  if(external)void detach(instance.id);callbacks.current.onActivate();return instance.id;
 },[detach,focus]);
 const select=(kind:AnalysisPage)=>{add(kind);};
 const handledRequestedSerial=useRef(0);
 useEffect(()=>{
  if(!p.requestedPage||p.requestedPage.serial===handledRequestedSerial.current)return;
  handledRequestedSerial.current=p.requestedPage.serial;
  add(p.requestedPage.page);
 },[p.requestedPage?.serial,p.requestedPage?.page,add]);
 const startDrag=(event:DragEvent,id?:string,kind?:AnalysisPage)=>{drag.current?.release();const owner=event.currentTarget.ownerDocument.defaultView??window;const value:AnalysisTabDrag={id,kind,source:p.sourceId,handled:false,cancelled:false,x:event.screenX,y:event.screenY,release:()=>owner.removeEventListener('keydown',cancel,true)};const cancel=(event:KeyboardEvent)=>{if(event.key==='Escape')value.cancelled=true;};drag.current=value;owner.addEventListener('keydown',cancel,true);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData(MIME,JSON.stringify({source:p.sourceId,id,kind}));};
 const dragEnd=(event:DragEvent)=>{const value=drag.current;drag.current=null;value?.release();if(!value||value.handled||event.dataTransfer.dropEffect!=='none')return;const owner=event.currentTarget.ownerDocument.defaultView??window,x=event.screenX,y=event.screenY;if(!Number.isFinite(x)||!Number.isFinite(y)||x===0&&y===0)return;const intent=resolveWorkspaceTabDropIntent({moved:workspaceTabDragMoved(value.x,value.y,x,y),cancelled:value.cancelled,source:value.source,expectedSource:p.sourceId,detached:!!value.id&&!!stateRef.current.instances.find(item=>item.id===value.id)?.detached,insideTarget:workspaceTabTargetContains({x:owner.screenX,y:owner.screenY,width:owner.outerWidth,height:owner.outerHeight},x,y)});if(intent==='detach'){if(value.id)void detach(value.id);else if(value.kind)add(value.kind,true);}};
 const receive=(event:DragEvent,group:string,before?:string)=>{try{const value=JSON.parse(event.dataTransfer.getData(MIME));if(!value||typeof value.source!=='string')return;const item=stateRef.current.instances.find(row=>row.id===value.id),gesture=drag.current;const intent=resolveWorkspaceTabDropIntent({moved:gesture?workspaceTabDragMoved(gesture.x,gesture.y,event.screenX,event.screenY):true,cancelled:gesture?.cancelled,source:value.source,expectedSource:p.sourceId,detached:!!item?.detached,insideTarget:true,itemId:item?.id,before});if(value.source===p.sourceId){event.preventDefault();event.stopPropagation();if(gesture)gesture.handled=true;}if(intent==='none')return;if(item)dock(item.id,group,before);else if(typeof value.kind==='string'&&Object.hasOwn(ANALYSIS_TITLES,value.kind)){const id=add(value.kind as AnalysisPage);dock(id,group,before);}}catch{}};
 useLayoutEffect(()=>callbacks.current.onActive(state.activeId),[state.activeId]);
 useEffect(()=>{const off=window.sciyueDesktop?.onAnalysisWindowEvent?.(event=>{const popup=popups.current.get(event.instanceId);if(!popup||popup.lease?.leaseId!==event.leaseId)return;if(event.kind==='focus'&&!popup.restoring)activate(event.instanceId);if((event.kind==='geometry'||event.kind==='opened')&&event.bounds)dispatch({type:'window-bounds',id:event.instanceId,bounds:event.bounds});if(event.kind==='closed'&&!popup.released){popup.disposeVisuals();parking.current?.appendChild(element(event.instanceId));popups.current.delete(event.instanceId);dispatch({type:'close',id:event.instanceId});setPopupsVersion(value=>value+1);}});return()=>off?.();},[activate,dispatch]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;drag.current?.release();drag.current=null;for(const id of [...popups.current.keys()])reclaim(id);};},[reclaim]);
 const restoredPopups=useRef(false);
 useEffect(()=>{
  if(!p.active||restoredPopups.current)return;restoredPopups.current=true;
  const detached=stateRef.current.instances.filter(item=>item.detached).map(item=>item.id),activeId=stateRef.current.activeId;

  void(async()=>{try{for(const id of detached){if(!alive.current)break;await detach(id,true);}if(alive.current&&activeId&&stateRef.current.instances.some(item=>item.id===activeId))dispatch({type:'activate',id:activeId});}finally{for(const popup of popups.current.values())popup.restoring=false;}})();

 },[p.active,detach,dispatch]);
 useLayoutEffect(()=>{const element=deck.current;if(!element)return;const update=()=>{const bounds=element.getBoundingClientRect();setSize({width:bounds.width,height:bounds.height});};update();const observer=new ResizeObserver(update);observer.observe(element);return()=>observer.disconnect();},[]);
 const compact=size.width<640,docked=state.instances.filter(row=>!row.detached),active=activeDockedAnalysis(state);
 const tab=(item:AnalysisInstance,group:string)=><WorkspaceTab key={item.id} className="analysis-tab" label={ANALYSIS_TITLES[item.kind]} active={active?.id===item.id} onActivate={()=>focus(item.id)} containerProps={{draggable:true,onDragStart:event=>startDrag(event,item.id),onDragEnd:dragEnd,onDragOver:event=>{if(event.dataTransfer.types.includes(MIME))event.preventDefault();},onDrop:event=>receive(event,group,item.id)}} actions={<><button aria-label={`弹出${ANALYSIS_TITLES[item.kind]}窗口`} onClick={()=>void detach(item.id)}>↗</button><button aria-label={`关闭${ANALYSIS_TITLES[item.kind]}窗口`} onClick={()=>close(item.id)}>×</button></>}/>;
 return <section ref={root} className="analysis-workspace" data-testid="analysis-workspace" data-active-instance={state.activeId??''} data-docked-active-instance={active?.id??''} data-compact={compact} data-layout={state.mode} onDragEnd={dragEnd}>
  <AnalysisCardDeck allowedPages={p.allowedPages} activeId={active?.kind} unavailableReason={p.unavailableReason} onSelect={select} onAdd={kind=>add(kind)} onCardDrag={(kind,event)=>startDrag(event,undefined,kind)}/>{!p.allowedPages&&<MultiwfnPathControl/>}
  <div className="analysis-workspace-toolbar"><output className="analysis-workspace-status">当前显示：{active?ANALYSIS_TITLES[active.kind]:'分子结构'}</output><button type="button" className="analysis-tile-toggle" aria-label="平铺分析面板" aria-pressed={state.mode!=='tabs'} onClick={()=>dispatch({type:'layout',mode:state.mode==='tabs'?'tiled':'tabs'})}>平铺</button>{state.mode!=='tabs'&&<><select aria-label="分析排列方式" value={state.mode} onChange={event=>dispatch({type:'layout',mode:event.target.value as 'tiled'|'free'})}><option value="tiled">规整平铺</option><option value="free">自由排布</option></select><button type="button" className="analysis-tile-toggle" onClick={()=>setArrangeRequest(value=>value+1)}>重新排列</button></>}</div>
  {state.mode==='tabs'&&docked.length>0&&<nav className="analysis-tabs" role="tablist">{docked.map(item=>tab(item,'main'))}</nav>}
  <div ref={deck} className="analysis-groups" onDragOver={event=>{if(event.dataTransfer.types.includes(MIME))event.preventDefault();}} onDrop={event=>receive(event,'main')}>
   <ModelDocumentDeck layoutKey={`analysis:${p.sourceId}`} activeId={active?.id??''} mode={state.mode==='tabs'?'single':state.mode} onActivate={activate} arrangeRequest={arrangeRequest} onReorder={ids=>dispatch({type:'reorder',ids})} documents={docked.map(item=>({id:item.id,label:ANALYSIS_TITLES[item.kind],docked:true,content:<section className="analysis-group" data-analysis-group={item.id} onDragOver={event=>{if(event.dataTransfer.types.includes(MIME))event.preventDefault();}} onDrop={event=>receive(event,'main',item.id)}>{state.mode!=='tabs'&&<nav className="analysis-tabs" role="tablist">{tab(item,'main')}</nav>}<Slot container={element(item.id)} parking={parking.current}/></section>}))}/>
   {!docked.length&&<p className="analysis-workspace-empty">选择分析卡片打开面板，或将独立窗口标签拖回。</p>}
  </div>
  <div ref={parking} hidden data-testid="analysis-parking"/>
  {state.instances.map(item=>createPortal(<AnalysisCitationContext.Provider value={{documentId:citationDocumentId,sourceId:typeof citationSource[1]==="string"?citationSource[1]:undefined,sourceRevision:typeof citationSource[2]==="string"?citationSource[2]:typeof citationSource[1]==="string"?citationSource[1]:undefined,analysisId:item.id}}>{p.render(item,p.active&&state.activeId===item.id)}</AnalysisCitationContext.Provider>,element(item.id),item.id))}
  {[...popups.current].map(([id,popup])=>createPortal(<div draggable onDragStart={event=>startDrag(event,id)} onDragEnd={dragEnd} onPointerDown={()=>activate(id)}><strong>{ANALYSIS_TITLES[state.instances.find(item=>item.id===id)?.kind??'energy']}</strong><button onClick={()=>dock(id,'main')}>停靠</button><button onClick={()=>close(id)}>关闭</button></div>,popup.header,`${id}:${popupsVersion}`))}
  <output hidden data-testid="analysis-workspace-state">{JSON.stringify(state)}</output>
 </section>;
}

export default function AnalysisWorkspace(p:Parameters<typeof AnalysisWorkspaceInner>[0]){
 const project=useProjectUiScope();
 return project?<ProjectUiScope scope={['analysis-workspace',p.sourceId]}><AnalysisWorkspaceInner {...p}/></ProjectUiScope>:AnalysisWorkspaceInner(p);
}
