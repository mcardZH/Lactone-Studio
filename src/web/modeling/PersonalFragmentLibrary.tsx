import {DismissibleNotice} from '../DismissibleNotice';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import DialogShell,{dialogSurfaceStyle} from '../DialogShell';
import {Trash2,X} from 'lucide-react';
import PersonalFragmentCardPreview from './PersonalFragmentCardPreview';
import {capturedPersonalFragment,deletePersonalFragment,importPersonalFragments,personalFragmentCategories,personalFragmentClipboard,personalFragmentNameConflict,savePersonalFragment,validatePersonalFragmentLibrary,type PersonalFragmentStoreAPI,type PersonalFragmentSnapshot,type PersonalFragmentTemplate,type PersonalFragmentCapture,type PersonalFragmentImportResult,type PersonalFragmentExportResult} from '../../modeling/personal-fragments';
import type {ClipboardPayload} from '../../modeling/contracts';
import './personal-fragments.css';

export interface PersonalFragmentLibraryProps {
  api:PersonalFragmentStoreAPI;capture?():Promise<PersonalFragmentCapture>;
  onChoose(payload:ClipboardPayload,activeIndex:number):void|Promise<void>;
  /** Legacy integrations may still pass these; a card now uses onChoose once,
   * which owns both the persistent preview and the armed mouse fragment. */
  onPreview?(payload:ClipboardPayload,activeIndex:number):void|Promise<void>;
  previewActiveIndex?:number;
  /** Keep mounted while closed so the preview's save button can request a dialog. */
  open?:boolean;onClose?():void;saveRequest?:number;
  popup?:boolean;saveRequestOwner?:string;
  /** Same persistent host, even when a new model supplies guarded callbacks. */
  catalogIdentity?:unknown;
  active?:boolean;viewState?:PersonalFragmentLibraryViewState;onViewStateChange?(next:PersonalFragmentLibraryViewState):void;
  importLibrary?():Promise<PersonalFragmentImportResult>;exportLibrary?(library:PersonalFragmentSnapshot['library']):Promise<PersonalFragmentExportResult>;
  disabled?:boolean;
}
export interface PersonalFragmentLibraryViewState {filter:string;selectedId:string|null}
export function shouldRefreshPersonalFragmentCatalog(apiChanged:boolean,becameVisible:boolean,pendingDraft:boolean,busy:boolean){return apiChanged||becameVisible&&!pendingDraft&&!busy;}
export function personalFragmentImportState(current:PersonalFragmentSnapshot['library'],result:PersonalFragmentImportResult){
  if(!result||typeof result.cancelled!=='boolean')throw new Error('个人片段导入回执无效。');
  if(result.cancelled)return{library:current,changed:false,status:'已取消导入，个人片段库未改变。'};
  return{library:importPersonalFragments(current,result.library),changed:true,status:'个人片段已导入。'};
}
export function personalFragmentExportStatus(result:PersonalFragmentExportResult){
  if(!result||typeof result.cancelled!=='boolean')throw new Error('个人片段导出回执无效。');
  return result.cancelled?'已取消导出，未保存文件。':'个人片段库已导出。';
}
/** One deliberate card choice arms the owner's existing preview/mouse tool.
 * Only a successful owner acknowledgement closes the library. */
export async function choosePersonalFragmentCard(item:PersonalFragmentTemplate,onChoose:PersonalFragmentLibraryProps['onChoose'],onClose?:PersonalFragmentLibraryProps['onClose'],guard:()=>void=()=>{}){
  const payload=personalFragmentClipboard(item);guard();await onChoose(payload,item.activeIndex);guard();onClose?.();
}
/** Capture receives actual preview geometry and its selected active atom.
 * Restricted persistence services never reach a model store or OS clipboard. */
export default function PersonalFragmentLibrary(props:PersonalFragmentLibraryProps){
  const [snapshot,setSnapshot]=useState<PersonalFragmentSnapshot|null>(null),[localViewState,setLocalViewState]=useState<PersonalFragmentLibraryViewState>({filter:'',selectedId:null});
  const viewState=props.viewState??localViewState,viewMirror=useRef(viewState);viewMirror.current=viewState;
  const {filter,selectedId:selected}=viewState;
  const [name,setName]=useState(''),[category,setCategory]=useState('个人'),[newCategory,setNewCategory]=useState('');
  const [status,setStatusText]=useState(''),[statusFailed,setStatusFailed]=useState(false),[busy,setBusy]=useState(false),[pendingDelete,setPendingDelete]=useState<PersonalFragmentTemplate|null>(null),[pendingCapture,setPendingCapture]=useState<PersonalFragmentCapture|null>(null),[conflict,setConflict]=useState<PersonalFragmentTemplate|null>(null);
  function setStatus(message:string,failed=false){setStatusText(message);setStatusFailed(failed);}
  const alive=useRef(true),generation=useRef(0),latest=useRef(props),catalogRead=useRef<symbol|null>(null),nameInput=useRef<HTMLInputElement>(null),lastSaveRequest=useRef(props.saveRequest??0);latest.current=props;
  const panel=useRef<HTMLElement>(null),saveOwner=useRef(props.saveRequestOwner);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  const disabled=props.disabled||props.active===false||busy,canWrite=snapshot?.writable===true&&!disabled,open=props.open!==false;
  function changeView(patch:Partial<PersonalFragmentLibraryViewState>){if(latest.current.active===false)return;const next={...viewMirror.current,...patch};viewMirror.current=next;if(latest.current.viewState!==undefined)latest.current.onViewStateChange?.(next);else setLocalViewState(next);}
  const categories=snapshot?personalFragmentCategories(snapshot.library):[];
  const chosenCategory=category===''?newCategory.trim():category;
  function adopt(value:PersonalFragmentSnapshot){const checked={...value,library:validatePersonalFragmentLibrary(value.library)};setSnapshot(checked);setStatus(value.error??'',Boolean(value.error));return checked;}
  async function action(work:(guard:()=>void)=>Promise<void>){const epoch=++generation.current,api=latest.current.api;catalogRead.current=null;setBusy(true);setStatus('');const guard=()=>{if(!alive.current||epoch!==generation.current||api!==latest.current.api||latest.current.disabled||latest.current.active===false)throw new Error('个人片段操作上下文已变化，请重试。');};try{guard();await work(guard);guard();}catch(error){if(alive.current&&epoch===generation.current)setStatus(error instanceof Error?error.message:String(error),true);}finally{if(alive.current&&epoch===generation.current)setBusy(false);}}
  const reload=()=>action(async guard=>{const value=await props.api.read();guard();adopt(value);});
  const readContext=useRef<{catalog:unknown;api:unknown;visible:boolean}>({catalog:null,api:null,visible:false});
  const visible=open&&props.active!==false;
  useEffect(()=>{
    const identity=props.catalogIdentity??props.api,api=props.api,previous=readContext.current,catalogChanged=previous.catalog!==identity,apiChanged=previous.api!==api,becameVisible=visible&&!previous.visible;
    readContext.current={catalog:identity,api,visible};
    if(catalogChanged){generation.current++;setSnapshot(null);setPendingCapture(null);setPendingDelete(null);if(props.viewState===undefined)setLocalViewState(current=>({...current,selectedId:null}));}
    // A model/store can replace its guarded API while the persistent catalog
    // stays the same. Restart that background read under the new exact owner;
    // never adopt an old API receipt or report its normal retirement as an error.
    const pendingDraft=!!pendingCapture||!!pendingDelete;
    if(!shouldRefreshPersonalFragmentCatalog(catalogChanged,becameVisible,pendingDraft,busy)&&!(apiChanged&&!pendingDraft&&(!busy||catalogRead.current!==null)))return;
    const epoch=++generation.current,read=Symbol('personal-fragment-catalog-read');catalogRead.current=read;
    const current=()=>alive.current&&epoch===generation.current&&api===latest.current.api&&identity===(latest.current.catalogIdentity??latest.current.api);
    setBusy(true);setStatus('');
    void (async()=>{try{const value=await api.read();if(current())adopt(value);}catch(error){if(current())setStatus(error instanceof Error?error.message:String(error),true);}finally{if(current()){if(catalogRead.current===read)catalogRead.current=null;setBusy(false);}}})();
  },[props.api,props.catalogIdentity,visible]);
  useLayoutEffect(()=>{
    const element=panel.current;if(!props.popup||!open||props.active===false||!element)return;
    if(pendingCapture||pendingDelete){if(element.matches(':popover-open'))element.hidePopover();return;}
    const trigger=element.ownerDocument.querySelector<HTMLElement>('[data-testid="model-personal-fragments"]'),rect=trigger?.getBoundingClientRect();
    if(rect){element.style.left=`${Math.max(8,Math.min(rect.left,window.innerWidth-350))}px`;element.style.top=`${Math.max(8,Math.min(rect.bottom+5,window.innerHeight-240))}px`;}
    if(element.showPopover&&!element.matches(':popover-open'))element.showPopover();
  },[props.popup,open,props.active,Boolean(pendingCapture),Boolean(pendingDelete)]);
  const commit=async(library:PersonalFragmentSnapshot['library'],guard:()=>void)=>{if(!snapshot?.writable)throw new Error('个人片段库当前不可写，请先读取并处理提示。');guard();const value=await props.api.update({baseVersion:snapshot.version,library:validatePersonalFragmentLibrary(library)});guard();const checked={...value,library:validatePersonalFragmentLibrary(value.library)};if(!checked.writable)throw new Error(checked.error??'个人片段库未保存，请重新读取。');adopt(checked);return checked;};
  const beginSave=()=>action(async guard=>{
    let current=snapshot;
    if(!current){const value=await props.api.read();guard();current=adopt(value);}
    if(!props.capture||!current.writable)throw new Error('请先读取可写片段库，并在结构预览中选择真实3D片段。');
    const captured=await props.capture();guard();
    capturedPersonalFragment(captured,{name:'预览片段',category:'个人'});
    setPendingCapture(structuredClone(captured));setName('');setCategory(filter||personalFragmentCategories(current.library)[0]||'个人');setNewCategory('');setConflict(null);setPendingDelete(null);
  });
  useEffect(()=>{const request=props.saveRequest??0;if(saveOwner.current!==props.saveRequestOwner){saveOwner.current=props.saveRequestOwner;lastSaveRequest.current=request;return;}if(request===lastSaveRequest.current)return;lastSaveRequest.current=request;if(request>0)void beginSave();},[props.saveRequest,props.saveRequestOwner]);
  function choose(item:PersonalFragmentTemplate){void action(async guard=>{await choosePersonalFragmentCard(item,props.onChoose,()=>{changeView({selectedId:item.id});props.onClose?.();},guard);});}
  const save=(replaceId?:string)=>action(async guard=>{
    if(!pendingCapture||!snapshot)throw new Error('请重新选择需要保存的预览片段。');
    const item=capturedPersonalFragment(pendingCapture,{name,category:chosenCategory}),duplicate=personalFragmentNameConflict(snapshot.library,item);
    if(duplicate&&!replaceId){setConflict(duplicate);return;}
    const next=savePersonalFragment(snapshot.library,item,replaceId),saved=await commit(next,guard),id=replaceId??item.id;
    if(!saved.library.fragments.some(row=>row.id===id))throw new Error('保存回执中未找到片段，请重新读取。');
    setPendingCapture(null);setConflict(null);changeView({selectedId:id,filter:item.category});setStatus(`已保存“${item.category} / ${item.name}”及${item.activeIndex+1}号接入原子。`);
  });
  const statusFeedback=status&&(statusFailed?<DismissibleNotice identity={generation.current}>{status}</DismissibleNotice>:<p role="status">{status}</p>);
  return <>{open&&<section ref={panel} className={`personal-fragment-library${props.popup?' personal-fragment-popup':''}`} data-testid="personal-fragment-library" aria-label="个人片段库" style={props.popup?dialogSurfaceStyle():undefined} popover={props.popup?'auto':undefined} role={props.popup?'dialog':undefined} aria-modal={props.popup?false:undefined} data-no-reorder={props.popup?'true':undefined} onToggle={event=>{if(props.popup&&(event.nativeEvent as ToggleEvent).newState==='closed'&&event.currentTarget.isConnected)props.onClose?.();}} onKeyDown={event=>{if(!props.popup)return;event.stopPropagation();if(event.key==='Escape'&&!pendingCapture&&!pendingDelete){event.preventDefault();props.onClose?.();}}} onKeyUp={event=>{if(props.popup)event.stopPropagation();}}>
    <header><strong>个人片段库</strong><span><button type="button" disabled={disabled} onClick={()=>void reload()}>重新读取</button>{props.onClose&&<button type="button" className="personal-fragment-icon" aria-label="关闭个人片段库" onClick={props.onClose}><X size={15}/></button>}</span></header>
    <p className="personal-fragment-help">保存真实3D结构与接入原子；不保存任务、约束、冻结或来源路径。接入后请核对总电荷与多重度。</p>
    {props.saveRequest===undefined&&<button type="button" disabled={!canWrite||!props.capture} onClick={()=>void beginSave()}>保存当前预览</button>}
    <label>分类<select aria-label="个人片段分类筛选" value={filter} disabled={disabled} onChange={event=>changeView({filter:event.target.value})}><option value="">全部</option>{categories.map(item=><option key={item}>{item}</option>)}</select></label>
    <div className="personal-fragment-groups">{(filter?[filter]:categories).map(group=><section key={group} className="personal-fragment-group"><h4>{group}</h4><ul>{snapshot?.library.fragments.filter(item=>item.category===group).map(item=><li key={item.id} className="personal-fragment-card"><button type="button" className="personal-fragment-card-pick" disabled={disabled} aria-pressed={selected===item.id} data-personal-fragment-id={item.id} onClick={()=>choose(item)}><PersonalFragmentCardPreview fragment={item}/><strong>{item.name}</strong><span>{item.atoms.length} 原子 · 接入 {item.activeIndex+1}</span></button><button type="button" className="personal-fragment-trash" aria-label={`删除个人片段 ${item.category} / ${item.name}`} title="删除个人片段" disabled={!canWrite} onClick={()=>setPendingDelete(item)}><Trash2 size={14}/></button></li>)}</ul>{!snapshot?.library.fragments.some(item=>item.category===group)&&<p className="personal-fragment-empty">暂无片段</p>}</section>)}</div>
    {snapshot&&!snapshot.library.fragments.length&&!categories.length&&<p className="personal-fragment-empty">在结构预览中保存片段，即可建立个人库。</p>}
    <footer><button type="button" disabled={!canWrite||!props.importLibrary} onClick={()=>void action(async guard=>{const incoming=await props.importLibrary!();guard();const next=personalFragmentImportState(snapshot!.library,incoming);if(next.changed)await commit(next.library,guard);setStatus(next.status);})}>导入个人片段库</button><button type="button" disabled={disabled||snapshot?.writable!==true||!props.exportLibrary} onClick={()=>void action(async guard=>{const result=await props.exportLibrary!(validatePersonalFragmentLibrary(snapshot!.library));guard();setStatus(personalFragmentExportStatus(result));})}>导出个人片段库</button></footer>
    {statusFeedback}{!status&&snapshot?.error&&<DismissibleNotice identity={snapshot.version}>{snapshot.error}</DismissibleNotice>}
  </section>}
    {pendingCapture&&<DialogShell aria-label="保存为个人片段" className="personal-fragment-save-dialog" backdropClassName="personal-fragment-modal-backdrop" initialFocus={()=>nameInput.current} onCancel={()=>{if(!busy){setPendingCapture(null);setConflict(null);}}}><header><strong>保存为个人片段</strong><button type="button" className="personal-fragment-icon" disabled={busy} aria-label="取消保存个人片段" onClick={()=>{setPendingCapture(null);setConflict(null);}}><X size={16}/></button></header><p>{pendingCapture.payload.fragment.structure.atoms.length} 原子 · 接入原子 {pendingCapture.activeIndex+1}</p><label>分类<select aria-label="个人片段分类" disabled={disabled} value={category} onChange={event=>{setCategory(event.target.value);setConflict(null);}}>{[...new Set(['个人',...categories])].map(item=><option key={item}>{item}</option>)}<option value="">新建分类…</option></select></label>{category===''&&<label>新分类名称<input aria-label="新个人片段分类" maxLength={40} disabled={disabled} value={newCategory} placeholder="如 金属团簇" onChange={event=>{setNewCategory(event.target.value);setConflict(null);}}/></label>}<label>片段名称<input ref={nameInput} autoFocus aria-label="个人片段名称" value={name} maxLength={80} disabled={disabled} placeholder="如 Fe5" onChange={event=>{setName(event.target.value);setConflict(null);}}/></label>
      {conflict&&<div role="alert" className="personal-fragment-conflict"><p>“{conflict.category} / {conflict.name}”已存在。可改名另存，或明确替换该片段。</p><div className="personal-fragment-actions"><button type="button" disabled={disabled} onClick={()=>{setConflict(null);nameInput.current?.focus();nameInput.current?.select();}}>改名另存</button><button type="button" disabled={!canWrite} onClick={()=>void save(conflict.id)}>替换“{conflict.name}”</button></div></div>}
      {statusFeedback}<footer><button type="button" disabled={!canWrite||!name.trim()||!chosenCategory.trim()||!!conflict} onClick={()=>void save()}>保存片段</button><button type="button" disabled={busy} onClick={()=>{setPendingCapture(null);setConflict(null);}}>取消</button></footer>
    </DialogShell>}
    {pendingDelete&&<DialogShell role="alertdialog" aria-label="删除个人片段" className="personal-fragment-save-dialog" backdropClassName="personal-fragment-modal-backdrop" onCancel={()=>{if(!busy)setPendingDelete(null);}}><strong>删除个人片段</strong><p>确认删除“{pendingDelete.category} / {pendingDelete.name}”？</p><p>保留此分类，不影响模型中已放置的结构与内置片段。</p>{statusFeedback}<footer><button type="button" disabled={!canWrite} onClick={()=>void action(async guard=>{await commit(deletePersonalFragment(snapshot!.library,pendingDelete.id),guard);if(selected===pendingDelete.id)changeView({selectedId:null});setPendingDelete(null);setStatus(`已删除“${pendingDelete.category} / ${pendingDelete.name}”。`);})}>确认删除</button><button type="button" disabled={busy} onClick={()=>setPendingDelete(null)}>取消</button></footer></DialogShell>}
    {!open&&!pendingCapture&&!pendingDelete&&status&&(statusFailed?<DismissibleNotice className="personal-fragment-hidden-status" identity={generation.current}>{status}</DismissibleNotice>:<p className="personal-fragment-hidden-status" role="status">{status}</p>)}
  </>;
}
