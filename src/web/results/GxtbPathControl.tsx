import {useEffect,useRef,useState} from 'react';
import type {GxtbBackendInfo} from '../../modeling/xtb/contracts';
import {DismissibleNotice} from '../DismissibleNotice';
import {openGlobalSettings} from '../global-settings-events';
import './analysis-environment.css';

const changed='sciyue-gxtb-configuration-changed';
const dismissedDetections=new Map<string,string>();
export function useGxtbBackend(){
 const [info,setInfo]=useState<GxtbBackendInfo>({configured:false,status:'unconfigured'});
 useEffect(()=>{if(typeof window==='undefined')return;let alive=true,epoch=0;
  const publish=(value:GxtbBackendInfo)=>{epoch++;if(alive)setInfo(value);};
  const refresh=()=>{const serial=++epoch;void window.sciyueDesktop?.gxtbBackendInfo?.().then(value=>{if(alive&&serial===epoch)setInfo(value);}).catch(()=>{});};
  const onChanged=(event:Event)=>{const value=(event as CustomEvent<GxtbBackendInfo>).detail;if(value)publish(value);else refresh();};
  refresh();window.addEventListener(changed,onChanged);
  const off=window.sciyueDesktop?.onGxtbConfigurationChanged?.(publish);
  return()=>{alive=false;epoch++;window.removeEventListener(changed,onChanged);off?.();};},[]);
 return info;
}
export const gxtbMethodLabel=(info:GxtbBackendInfo)=>info.configured?'g-xTB':'g-xTB（需配置）';
/** Unchecked selected paths keep the existing lazy CLI probe at submission.
 * A known unusable configuration blocks only a new g-xTB submission. */
export function gxtbRunBlocked(info:GxtbBackendInfo,method:string){return method==='gxtb'&&(!info.configured||!['ready','unchecked'].includes(info.status));}
export function gxtbSamplingRunBlocked(info:GxtbBackendInfo,cards:readonly {id:string;kind:string;sampling:{method:string}}[],pendingCardIds?:readonly string[]){return cards.some(card=>card.kind!=='conformer-search'&&(pendingCardIds===undefined||pendingCardIds.includes(card.id))&&gxtbRunBlocked(info,card.sampling.method));}
export function GxtbAvailability({method}:{method:string}){
 const info=useGxtbBackend();
 if(method!=='gxtb'||info.status==='ready')return null;
 return <div className="analysis-environment-row"><span>{!info.configured?'g-xTB（需配置）':info.status==='unchecked'?'g-xTB 程序待检测':'g-xTB 程序当前不可用'}</span><button type="button" className="analysis-environment-button" onClick={openGlobalSettings}>前往全局设置</button></div>;
}
function gxtbInstallHint():string{
 const platformText=typeof navigator==='undefined'?'':`${navigator.platform??''} ${navigator.userAgent??''}`.toLowerCase();
 if(platformText.includes('mac'))return'下载对应架构官方包并完整解压，选择 bin/xtb，并保留同包 lib/*.dylib 与 share/xtb 参数目录。';
 if(platformText.includes('linux'))return'下载并完整解压官方包，选择 bin/xtb，并保留同包 lib/*.so 与 share/xtb 参数目录。';
 return'下载后完整解压，选择 bin/xtb.exe，并保留同包 DLL。';
}

export default function GxtbPathControl(){
 const desktop=typeof window==='undefined'?undefined:window.sciyueDesktop,info=useGxtbBackend();
 const [draft,setDraft]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const alive=useRef(false),actionEpoch=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{setDraft(info.path??'');},[info.path]);
 async function act(action?:()=>Promise<GxtbBackendInfo>){if(!action||busy)return;setBusy(true);setError('');const serial=++actionEpoch.current;try{await action();if(alive.current&&serial===actionEpoch.current)window.dispatchEvent(new Event(changed));}catch(cause){if(alive.current&&serial===actionEpoch.current)setError(String(cause instanceof Error?cause.message:cause));}finally{if(alive.current&&serial===actionEpoch.current)setBusy(false);}}
 const failure=error||info.details;
 const failureIdentity=error?`local-action-${actionEpoch.current}`:info.detectionId??failure;
 const failureDismissed=!!info.path&&!error&&dismissedDetections.get(info.path)===failureIdentity;
 const state=info.status==='ready'?`已检测 · 宿主 xTB ${info.hostVersion??'版本未知'} · g-xTB ${info.gxtbRelease??'版本未知'}`:({unconfigured:'未配置',unchecked:'路径已保存，请检测',unsupported:'所选程序未提供 g-xTB 能力','program-unavailable':'已配置的程序不可用','configuration-invalid':'配置无法读取','detection-failed':'程序检测失败'} as Record<string,string>)[info.status];
 return <section className="analysis-environment-control" aria-label="g-xTB 环境">
  <div className="analysis-environment-row analysis-environment-setting"><strong>g-xTB 程序（用户自备）</strong><input className="analysis-environment-path" aria-label="g-xTB 程序路径" value={draft} onChange={event=>setDraft(event.target.value)} disabled={busy}/><button type="button" className="analysis-environment-button" onClick={()=>void act(desktop?.chooseGxtbBackend)} disabled={busy||!desktop?.chooseGxtbBackend}>浏览…</button><button type="button" className="analysis-environment-button" onClick={()=>void act(()=>desktop!.setGxtbBackendPath!(draft))} disabled={busy||!desktop?.setGxtbBackendPath||draft===(info.path??'')||!draft.trim()}>应用路径</button></div>
  <div className="analysis-environment-row"><output aria-label="g-xTB 程序状态">{state}</output><button type="button" className="analysis-environment-button" onClick={()=>void act(desktop?.detectGxtbBackend)} disabled={busy||!info.path||!desktop?.detectGxtbBackend}>检测</button><button type="button" className="analysis-environment-button" onClick={()=>{void desktop?.openGxtbDownload?.().catch(cause=>setError(String(cause)));}} disabled={!desktop?.openGxtbDownload}>官方下载</button></div>
  <p className="muted-note">{gxtbInstallHint()}</p>
  {failure&&!failureDismissed&&<DismissibleNotice role="alert" identity={failureIdentity} onDismiss={()=>{if(info.path&&!error)dismissedDetections.set(info.path,String(failureIdentity));}}><span>g-xTB 程序配置或检测未完成。</span><details className="analysis-environment-details"><summary>详情</summary><textarea readOnly aria-label="g-xTB 错误详情" value={failure}/></details></DismissibleNotice>}
 </section>;
}
