import {useCallback,useEffect,useRef,useState} from 'react';
import type {DocumentOperationResult,DocumentElectronicState} from '../../modeling/application/document-operations';
import {createCapturedStructureOperations} from '../../modeling/application/document-operations';
import type {ModelFormat} from '../../modeling/contracts';
import {getFormatDescriptors,exportModel} from '../../modeling/platform/files';
import {createChemistryPort} from '../../modeling/chemistry';
import {confirmSynchronousOperation} from '../confirmation';
import {DialogSurface} from '../DialogShell';
import SaveStateDialog from '../modeling/SaveStateDialog';
import type {StructureExportSource} from './structure-export-source';

type Operations=ReturnType<typeof createCapturedStructureOperations>;
type Pending={operations:Operations;result:Extract<DocumentOperationResult,{status:'format-required'|'state-required'}>;withCell:boolean};
/** Shared structure-only delivery UI. It never borrows a background model owner. */
export function useStructureExport(source:StructureExportSource|undefined,onError:(message:string)=>void){
 const latest=useRef({source,onError});latest.current={source,onError};
 const alive=useRef(true),working=useRef(false),pendingRef=useRef<Pending|null>(null);
 const [busy,setBusy]=useState(false),[pending,setPending]=useState<Pending|null>(null),[format,setFormat]=useState<ModelFormat>('xyz');
 const setChoice=(value:Pending|null)=>{pendingRef.current=value;setPending(value);};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;pendingRef.current=null;};},[]);
 const present=useCallback((operations:Operations,result:DocumentOperationResult,withCell:boolean)=>{
  if(!alive.current)return;
  if(result.status==='format-required'||result.status==='state-required'){result.assertCurrent();setChoice({operations,result,withCell});}
  else if(result.status!=='cancelled')setChoice(null);
 },[]);
 const save=useCallback(async()=>{
  if(working.current||pendingRef.current)return;
  const own=latest.current.source;
  if(!own?.available)throw Error('当前来源还没有可导出的完整结构。');
  const captured=own.capture(),snapshot=captured.document,withCell=Boolean(snapshot.draft.structure.cell);
  // The source guard owns only true file/window/dataset identity. A later
  // revision or animation frame must not replace or invalidate this copy.
  captured.assertCurrent();
  const operations=createCapturedStructureOperations(snapshot,{
   assertCurrent:()=>{if(!alive.current)throw Error('结构导出所属视图已关闭。');captured.assertCurrent();},
   documentName:captured.name,documentNameOrigin:captured.name?'manual':undefined,
   getFilePort:()=>window.sciyueDesktop??null,
   formats:context=>getFormatDescriptors({...context,purpose:'structure'}).filter(value=>value.id!=='sciyue'),
   exportModel:(document,selected,context)=>exportModel(document,selected,context,createChemistryPort()),
   confirmLosses:losses=>confirmSynchronousOperation(losses.join('\n')+'\n继续保存？'),
   download:({filename,text,assertCurrent})=>{const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));try{const link=document.createElement('a');link.href=url;link.download=filename;assertCurrent();link.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}},
  });
  working.current=true;setBusy(true);
  try{present(operations,await operations.save({withCell}),withCell);}
  catch(error){if(alive.current)latest.current.onError(error instanceof Error?error.message:String(error));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 },[present]);
 const write=async(selected:ModelFormat,state?:DocumentElectronicState)=>{
  const own=pendingRef.current;if(!own||working.current)return;
  working.current=true;setBusy(true);
  try{own.result.assertCurrent();present(own.operations,await own.operations.writeExport({format:selected,withCell:own.withCell,
    token:own.result.status==='state-required'?own.result.token:undefined,state,inheritedGuard:own.result.assertCurrent,
    capturedDocument:own.result.snapshot}),own.withCell);}
  catch(error){setChoice(null);if(alive.current)latest.current.onError(error instanceof Error?error.message:String(error));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 };
 const dialog=pending?.result.status==='state-required'?<SaveStateDialog structure={pending.result.snapshot.draft.structure} request={pending.result.request} onCancel={()=>setChoice(null)} onConfirm={state=>void write(pending.result.status==='state-required'?pending.result.format:format,state)}/>
  :pending?<DialogSurface aria-label="导出结构文件" className="model-inline-dialog" onCancel={()=>setChoice(null)}><label>格式<select aria-label="保存格式" value={format} disabled={busy} onChange={event=>setFormat(event.target.value as ModelFormat)}>{getFormatDescriptors({purpose:'structure'}).filter(value=>value.id!=='sciyue').map(value=><option key={value.id} value={value.id}>{value.label}</option>)}</select></label><button disabled={busy} onClick={()=>void write(format)}>保存</button><button disabled={busy} onClick={()=>setChoice(null)}>取消</button></DialogSurface>:null;
 return {save,busy:busy||Boolean(pending),dialog};
}
