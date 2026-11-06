import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createProjectAssetIO,invokeProject,projectFormatFloor,projectSaveFormatVersion,type ProjectSessionDescription,type ProjectFormatVersion,type SyProjectInvoke} from './desktop-bridge';
import type {ProjectAssetWriter,ProjectAssetReader} from './result-snapshot';
import DialogShell from '../web/DialogShell';

export interface ProjectWorkspacePorts {
  capture(writer:ProjectAssetWriter,reader:ProjectAssetReader,options:{reuse:boolean}):Promise<unknown>;
  restore(state:unknown,reader:ProjectAssetReader):Promise<void>;
  revision:string; onError(message:string):void;
  restoring?:boolean;
  onSaved?(project:ProjectSessionDescription,detail:{automatic:boolean;asNew:boolean}):void;
}
export function createProjectReaderRouter(invoke:SyProjectInvoke,sessionId:string){
 let selected=sessionId,epoch=0;
 let retainedBatchBytes=0;const batchByteLimit=64*1024**2;
 const active=new Set<Promise<unknown>>(),verifiedBatchBytes=new Map<string,Uint8Array>();
 const clearBatchCache=()=>{epoch++;verifiedBatchBytes.clear();retainedBatchBytes=0;};
 const retain=(id:string,bytes:Uint8Array)=>{if(bytes.length>batchByteLimit)return;const old=verifiedBatchBytes.get(id);if(old){retainedBatchBytes-=old.length;verifiedBatchBytes.delete(id);}verifiedBatchBytes.set(id,bytes.slice());retainedBatchBytes+=bytes.length;while(retainedBatchBytes>batchByteLimit){const[first,value]=verifiedBatchBytes.entries().next().value!;verifiedBatchBytes.delete(first);retainedBatchBytes-=value.length;}};
 const track=<T,>(pending:Promise<T>)=>{active.add(pending);void pending.then(()=>active.delete(pending),()=>active.delete(pending));return pending;};
 return{reader:{
  read:(assetId:string)=>{const cached=verifiedBatchBytes.get(assetId);if(cached){verifiedBatchBytes.delete(assetId);verifiedBatchBytes.set(assetId,cached);return Promise.resolve(cached.slice());}return track(createProjectAssetIO(selected,'reader',invoke).reader.read(assetId));},
  readMany:(assetIds:readonly string[])=>{const ownEpoch=epoch,ownSession=selected,retained=new Map(assetIds.flatMap(id=>{const bytes=verifiedBatchBytes.get(id);return bytes?[[id,bytes] as const]:[];}));return track((async()=>{
   const missing=[...new Set(assetIds.filter(id=>!retained.has(id)))],fresh=missing.length?await createProjectAssetIO(ownSession,'reader',invoke).reader.readMany!(missing):[];
   const accepted=new Map(missing.map((id,index)=>[id,fresh[index]]));
   // These exact immutable content hashes have just passed batch byte/hash
   // verification. Share only within this reader lease, never across rebind.
   if(epoch===ownEpoch)for(const[id,bytes]of accepted)retain(id,bytes);
   return assetIds.map(id=>(accepted.get(id)??retained.get(id)!).slice());
  })());},
 },clearBatchCache,rebind(next:string){selected=next;clearBatchCache();return Promise.allSettled([...active]).then(()=>undefined);}};
}
export const projectCloseSaveIsCurrent=(savedRevision:string|null,currentRevision:string)=>savedRevision!==null&&savedRevision===currentRevision;
export const projectCopyName=(indexPath?:string)=>indexPath?indexPath.split(/[\\/]/).at(-1)!.replace(/\.(?:es|sy)$/i,'')+'-copy':'project';
/** A window owns one project. No timer writes an unnamed workspace. */
export function useProjectWorkspace(p:ProjectWorkspacePorts){
 const current=useRef(p);current.current=p;
 const invoke=window.sciyueDesktop?.syProject as SyProjectInvoke|undefined;
 const [project,setProject]=useState<ProjectSessionDescription|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
 const live=useRef(project);live.current=project;
 const saving=useRef(false),savedRevision=useRef<string|null>(p.revision),automaticRevision=useRef<string|null>(null),alive=useRef(true),baselinePending=useRef(false),claimed=useRef(false);
 const formatFloor=useRef<ProjectFormatVersion>(1),writeBlocked=useRef(false);
 const [,setBaselineEpoch]=useState(0),routers=useRef(new Map<string,ReturnType<typeof createProjectReaderRouter>>()),closePending=useRef<Promise<boolean>|null>(null);
 const [closeChoice,setCloseChoice]=useState<{force:boolean;notice?:string;clean:boolean;resolve(value:'save'|'discard'|'cancel'):void}|null>(null);
 const [nameChoice,setNameChoice]=useState<{name:string;location?:{locationToken:string;label:string};choosing:boolean;resolve(value:{name:string;locationToken:string}|null):void}|null>(null);
 const dirty=savedRevision.current!==p.revision;
 useLayoutEffect(()=>{if(baselinePending.current&&!p.restoring){baselinePending.current=false;savedRevision.current=p.revision;automaticRevision.current=p.revision;setBaselineEpoch(value=>value+1);}},[project,p.revision,p.restoring]);
 const readerFor=useCallback((value:ProjectSessionDescription)=>{let router=routers.current.get(value.sessionId);if(!router){router=createProjectReaderRouter(invoke!,value.sessionId);routers.current.set(value.sessionId,router);}return router.reader;},[invoke]);
 const save=useCallback(async(asNew=false,automatic=false)=>{
  if(!invoke||saving.current||current.current.restoring||baselinePending.current)return false;
  if(writeBlocked.current||live.current?.writeProtection){if(!automatic){current.current.onError('项目恢复点由较新版本保存，当前项目只读；未覆盖保存或回收资产。');setStatus('项目只读');}return false;}
  if(automatic&&(!live.current?.manifest||automaticRevision.current===current.current.revision))return true;
  saving.current=true;setBusy(true);setStatus(automatic?'自动保存项目…':'保存项目…');
  const previous=live.current;let selected=previous,transactionId:string|undefined;
  try{
   const sourceFormatFloor=projectFormatFloor(formatFloor.current,previous?.manifest?.formatVersion,previous?.recovery.auto?.formatVersion,previous?.recovery.previous?.formatVersion);
   if(asNew||!selected){
    const name=projectCopyName(previous?.indexPath);
    const target=await new Promise<{name:string;locationToken:string}|null>(resolve=>setNameChoice({name,choosing:false,resolve}));setNameChoice(null);
    if(!target){setStatus('');return false;}const value=await invokeProject(invoke,{action:'create',...target});if('cancelled'in value){setStatus('');return false;}selected=value;
   }
   const revision=current.current.revision;
   const started=await invokeProject(invoke,{action:'begin',sessionId:selected.sessionId,kind:automatic?'auto':'manual',state:null});transactionId=started.transactionId;
   const io=createProjectAssetIO(selected.sessionId,transactionId,invoke,[],Object.keys(selected.manifest?.assets??{}));
   const state=await current.current.capture(io.writer,previous?readerFor(previous):io.reader,{reuse:previous?.sessionId===selected.sessionId});
   const references=new Set(io.assetIds());
   // Existing immutable assets may be reused by an unchanged lazy DTO.
   let preserveUnlisted=false;
   const visit=(value:unknown):void=>{if(typeof value==='string'&&(selected!.manifest?.assets[value]||references.has(value)))references.add(value);else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object'){if((value as {preserveUnlistedAssets?:boolean}).preserveUnlistedAssets)preserveUnlisted=true;Object.values(value).forEach(visit);}};visit(state);
   if(preserveUnlisted&&previous?.sessionId===selected.sessionId)for(const id of previous.manifest?.assetIds??[])references.add(id);
   const requiredFormatVersion=projectSaveFormatVersion(state,sourceFormatFloor);formatFloor.current=requiredFormatVersion;
   const result=await invokeProject(invoke,{action:'commit',sessionId:selected.sessionId,transactionId,state,assetIds:[...references],requiredFormatVersion});transactionId=undefined;
   if(!alive.current)return false;
   if(!automatic){savedRevision.current=revision;live.current=result;setProject(result);if(previous&&previous.sessionId!==result.sessionId){await Promise.all([...routers.current.values()].map(router=>router.rebind(result.sessionId)));try{await invokeProject(invoke,{action:'close',sessionId:previous.sessionId});}catch(error){current.current.onError('新项目已保存，但旧项目尚未释放：'+(error instanceof Error?error.message:String(error)));}}}
   automaticRevision.current=revision;try{current.current.onSaved?.(result,{automatic,asNew});}catch(error){current.current.onError(error instanceof Error?error.message:String(error));}
   setStatus(automatic?'项目恢复副本已更新':'项目已保存');
   try{await invokeProject(invoke,{action:'gc',sessionId:result.sessionId});}catch(error){current.current.onError('项目已保存，冗余数据回收未完成：'+(error instanceof Error?error.message:String(error)));}return true;
  }catch(error){if((error as {code?:string})?.code==='SY_SCHEMA_UNSUPPORTED')writeBlocked.current=true;current.current.onError(error instanceof Error?error.message:String(error));setStatus('保存未完成');return false;}
  finally{if(transactionId&&selected)await invokeProject(invoke,{action:'abort',sessionId:selected.sessionId,transactionId}).catch(()=>{});if(selected&&selected!==previous&&live.current?.sessionId!==selected.sessionId)await invokeProject(invoke,{action:'close',sessionId:selected.sessionId}).catch(()=>{});saving.current=false;if(alive.current)setBusy(false);}
 },[invoke,readerFor]);
 const claim=useCallback(async()=>{
  if(!invoke||claimed.current)return;claimed.current=true;const value=await invokeProject(invoke,{action:'claim'});if(!('sessionId'in value))return;
  setBusy(true);try{const restoredFormatFloor=projectFormatFloor(value.manifest?.formatVersion,value.recovery.auto?.formatVersion,value.recovery.previous?.formatVersion);await current.current.restore(value.state,readerFor(value));formatFloor.current=restoredFormatFloor;writeBlocked.current=!!value.writeProtection;live.current=value;baselinePending.current=!value.recovered;savedRevision.current=value.recovered?null:savedRevision.current;setProject(value);setStatus(value.writeProtection?'项目只读：恢复点需要较新版本':value.recovered?'已恢复项目副本，请保存':'项目已打开');}
  catch(error){await invokeProject(invoke,{action:'close',sessionId:value.sessionId}).catch(()=>{});throw error;}finally{setBusy(false);}
 },[invoke,readerFor]);
 useEffect(()=>{alive.current=true;void claim().catch(error=>current.current.onError(error instanceof Error?error.message:String(error)));return()=>{alive.current=false;for(const router of routers.current.values())router.clearBatchCache();};},[claim]);
 useEffect(()=>{if(!project?.manifest||!invoke)return;const timer=window.setInterval(()=>{void save(false,true);},5*60*1000);return()=>window.clearInterval(timer);},[project?.sessionId,Boolean(project?.manifest),invoke,save]);
 useEffect(()=>{if(!project)return;const title=document.title;document.title=`${project.indexPath.split(/[\\/]/).at(-1)} — Ester Studio`;return()=>{document.title=title;};},[project?.indexPath]);
 useEffect(()=>{const listener=(event:Event)=>{const action=(event as CustomEvent<string>).detail;if(action==='open'){void invokeProject(invoke!,{action:'open-new'}).catch(error=>current.current.onError(String(error)));}else if(action==='associate'){void invokeProject(invoke!,{action:'associate'}).then(()=>setStatus('已注册 .es 项目打开入口（兼容 .sy）；可在Windows选择默认程序')).catch(error=>current.current.onError(String(error)));}else void save(action==='save-as');};
  if(invoke)window.addEventListener('sciyue-project-action',listener);
  const stopNative=invoke?window.sciyueDesktop?.onProjectAction?.(action=>listener(new CustomEvent('sciyue-project-action',{detail:action}))):undefined;
  const key=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!event.altKey){event.preventDefault();event.stopImmediatePropagation();void save(event.shiftKey);}};
  if(invoke)window.addEventListener('keydown',key,true);return()=>{stopNative?.();window.removeEventListener('sciyue-project-action',listener);window.removeEventListener('keydown',key,true);};},[invoke,save]);
 const prepareClose=useCallback((force=false,notice?:string)=>{
  if(closePending.current)return closePending.current;
  const pending=(async()=>{
  if(saving.current)throw new Error('项目正在保存，请完成后关闭。');
  const clean=projectCloseSaveIsCurrent(savedRevision.current,current.current.revision);
  if(!force&&clean&&!notice)return true;
  const choice=await new Promise<'save'|'discard'|'cancel'>(resolve=>setCloseChoice({force,notice,clean,resolve}));setCloseChoice(null);
  if(choice==='cancel')return false;if(choice==='save'){if(!await save())return false;if(!projectCloseSaveIsCurrent(savedRevision.current,current.current.revision)){current.current.onError('保存期间项目又有修改，已保留窗口；请检查后重新关闭。');return false;}return true;}return true;})();
  closePending.current=pending;void pending.finally(()=>{if(closePending.current===pending)closePending.current=null;}).catch(()=>{});return pending;
 },[save]);
 const chooseLocation=async()=>{if(!invoke||!nameChoice||nameChoice.choosing)return;setNameChoice(value=>value?{...value,choosing:true}:value);try{const value=await invokeProject(invoke,{action:'choose-location'});if(!('cancelled'in value))setNameChoice(previous=>previous?{...previous,location:value}:previous);}catch(error){current.current.onError(error instanceof Error?error.message:String(error));}finally{setNameChoice(value=>value?{...value,choosing:false}:value);}};
 const validName=Boolean(nameChoice&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(nameChoice.name)&&!/\.$/.test(nameChoice.name)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(nameChoice.name));
 return{project,busy,status,dirty,save,prepareClose,reader:project?readerFor(project):null,
  dialog:nameChoice?<DialogShell aria-label="保存项目" className="modal workspace-import-choice" backdropClassName="modal-backdrop" onCancel={()=>nameChoice.resolve(null)}><h2>保存项目</h2><p>完整项目文件：{nameChoice.name||'project'}.es</p><label className="field">项目名称<input autoFocus value={nameChoice.name} onChange={event=>setNameChoice(previous=>previous?{...previous,name:event.target.value}:previous)}/></label><div className="field"><span>保存位置</span><div style={{display:'flex',gap:8}}><input aria-label="保存位置" readOnly value={nameChoice.location?.label??''} placeholder="请选择父目录" style={{flex:1,minWidth:0}}/><button disabled={nameChoice.choosing} onClick={()=>void chooseLocation()}>选择…</button></div></div><div className="modal-buttons"><button onClick={()=>nameChoice.resolve(null)}>取消</button><button className="button button-primary" disabled={!validName||!nameChoice.location||nameChoice.choosing} onClick={()=>nameChoice.resolve({name:nameChoice.name,locationToken:nameChoice.location!.locationToken})}>保存项目</button></div></DialogShell>:closeChoice?<DialogShell aria-label="项目关闭确认" className="modal workspace-import-choice" backdropClassName="modal-backdrop" onCancel={()=>closeChoice.resolve('cancel')}><h2>{closeChoice.force?'关闭项目':closeChoice.clean?'关闭窗口':'项目有未保存的修改'}</h2>{closeChoice.force?<p>关闭将结束本项目任务。</p>:null}{closeChoice.notice?<p>{closeChoice.notice}</p>:null}<div className="modal-buttons"><button onClick={()=>closeChoice.resolve('cancel')}>取消</button><button onClick={()=>closeChoice.resolve('discard')}>不保存并关闭</button><button className="button button-primary" onClick={()=>closeChoice.resolve('save')}>保存并关闭</button></div></DialogShell>:null};
}
