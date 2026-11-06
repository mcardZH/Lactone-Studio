import type {DisplaySettings,RuntimeModelDisplaySnapshot,RuntimeModelDisplayUpdate,RuntimeDisplayBridge} from '../contracts';
import {validateModelDisplay} from './display-preferences';

export type {RuntimeModelDisplaySnapshot,RuntimeModelDisplayUpdate,RuntimeDisplayBridge} from '../contracts';
export interface RuntimeDisplayState {display:DisplaySettings;ready:boolean}
type RuntimeDisplayRequest={baseRevision:number;display:DisplaySettings};
function checked(value:RuntimeModelDisplaySnapshot):RuntimeModelDisplaySnapshot{
 if(!value||!Number.isSafeInteger(value.revision)||value.revision<0||value.display===null&&value.revision!==0)throw new Error('无效会话显示回执。');
 return{revision:value.revision,display:value.display===null?null:validateModelDisplay(value.display)};
}

/** A subscription is presentation-only; applying a publication never republishes it. */
export function createRuntimeDisplayController(bridge:RuntimeDisplayBridge|null,initialDisplay:DisplaySettings,onError:(error:unknown)=>void=()=>{}){
 let state:RuntimeDisplayState={display:validateModelDisplay(initialDisplay),ready:false},known:RuntimeModelDisplaySnapshot={revision:-1,display:null};
 let live=true,epoch=0,edits=0,off:(()=>void)|undefined,initialized=false,inflight=false;
 let pending:RuntimeDisplayRequest|undefined;
 const queued=():RuntimeDisplayRequest|undefined=>pending;
 const listeners=new Set<()=>void>();
 const emit=(next:RuntimeDisplayState)=>{state=next;for(const listener of listeners)listener();};
 const accept=(raw:RuntimeModelDisplaySnapshot)=>{const snapshot=checked(raw);if(snapshot.revision<=known.revision)return;known=snapshot;if(snapshot.display)emit({display:structuredClone(snapshot.display),ready:state.ready});};
 async function pump(){
  if(!live||!initialized||inflight||!pending||!bridge||known.revision<0)return;
  const request=pending;pending=undefined;inflight=true;const own=epoch;
  try{
   const reply=await bridge.updateRuntimeModelDisplay(request);if(!live||epoch!==own)return;
   if(typeof reply.accepted!=='boolean')throw new Error('无效会话显示更新回执。');
   accept(reply);
   // Only our accepted update may advance gestures queued against its base.
   // A later external publication is never rebased underneath an old gesture.
   const next=queued();
   if(next&&reply.accepted&&known.revision===reply.revision&&next.baseRevision===request.baseRevision)next.baseRevision=reply.revision;
   if(next&&!reply.accepted&&next.baseRevision<reply.revision)pending=undefined;
  }catch(error){if(live&&epoch===own){pending=undefined;onError(error);}}
  finally{if(epoch===own){inflight=false;void pump();}}
 }
 return{
  getSnapshot:()=>state,
  subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  async initialize(loadDefault:()=>Promise<DisplaySettings>){
   live=true;const own=++epoch,unedited=edits;off?.();inflight=false;initialized=false;known={revision:-1,display:null};
   try{
    if(bridge){off=bridge.onRuntimeModelDisplay(snapshot=>{if(live&&epoch===own){try{accept(snapshot);}catch(error){onError(error);}}});accept(await bridge.readRuntimeModelDisplay());}
    if(!live||epoch!==own)return;
    // An edit made before the first authoritative read has no valid baseline.
    // Never replace an existing session using the temporary startup appearance.
    if(known.display&&pending&&pending.baseRevision<0)pending=undefined;
    if(!known.display&&!pending){const fallback=validateModelDisplay(await loadDefault());if(!live||epoch!==own)return;if(!known.display&&!pending&&edits===unedited){if(bridge)pending={baseRevision:known.revision,display:fallback};else emit({display:fallback,ready:false});}}
    if(!live||epoch!==own)return;
    if(pending&&pending.baseRevision<0)pending.baseRevision=known.revision;
    initialized=true;emit({...state,ready:true});await pump();
   }catch(error){if(live&&epoch===own){initialized=true;emit({...state,ready:true});onError(error);}}
  },
  changeDisplay(display:DisplaySettings){
   const next=validateModelDisplay(display);if(!live)return;edits++;
   if(!bridge){pending=undefined;emit({display:next,ready:state.ready});return;}
   pending={baseRevision:known.revision,display:next};void pump();
  },
  dispose(){live=false;epoch++;off?.();off=undefined;pending=undefined;initialized=false;inflight=false;},
 };
}
