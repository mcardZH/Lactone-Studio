import {useState,useSyncExternalStore} from 'react';
import type {DocumentRuntimeOwner} from '../../modeling/application/document-runtime-owner';
import {DismissibleNotice} from '../DismissibleNotice';

const active=(phase:string)=>['starting','running','pausing','paused','stopping'].includes(phase);
async function waitForTerminal(owner:DocumentRuntimeOwner,sessionId:string){
 if(owner.dynamics.getSnapshot().sessionId!==sessionId)throw Error('运行会话已变化，未等待其他任务。');
 if(!active(owner.dynamics.getSnapshot().status))return;
 await new Promise<void>((resolve,reject)=>{
  let unsubscribe=()=>{};
  const check=()=>{const state=owner.dynamics.getSnapshot();if(state.sessionId!==sessionId){unsubscribe();reject(Error('运行会话已变化，原停止结果尚未确认。'));}else if(!active(state.status)){unsubscribe();resolve();}};
  unsubscribe=owner.dynamics.subscribe(check);check();
 });
}
/** A failed view retains an explicit route to its real document-owned task. */
export default function RuntimeRecoveryActions({owner,label,waitForClosed}:{owner:DocumentRuntimeOwner;label?:string;waitForClosed(sessionId:string):Promise<void>}){
 const xtb=useSyncExternalStore(owner.xtb.subscribe,owner.xtb.getSnapshot,owner.xtb.getSnapshot);
 const dynamics=useSyncExternalStore(owner.dynamics.subscribe,owner.dynamics.getSnapshot,owner.dynamics.getSnapshot);
 const [stopping,setStopping]=useState(false),[error,setError]=useState('');
 const running=xtb.running||active(dynamics.status);
 async function stop(){
  if(stopping)return;setStopping(true);setError('');
  try{
   if(owner.xtb.getSnapshot().running)await owner.xtb.stop();
   const current=owner.dynamics.getSnapshot();
   if(active(current.status)){
    if(current.status!=='stopping')await owner.dynamics.stop();
    if(current.sessionId){await waitForTerminal(owner,current.sessionId);await waitForClosed(current.sessionId);}
   }
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setStopping(false);}
 }
 if(!running&&!stopping&&!error)return null;
 return <div className="workspace-runtime-recovery" data-testid="runtime-recovery-actions">
  {label&&<p>{label}</p>}
  <p role="status">{stopping?'正在等待本页计算停止…':xtb.running?xtb.status:'本页计算仍由原任务管理。'}</p>
  <button type="button" disabled={stopping||!running} onClick={()=>void stop()}>{label?`停止 ${label} 的计算`:'停止本页计算'}</button>
  {error&&<DismissibleNotice>{error}</DismissibleNotice>}
 </div>;
}
