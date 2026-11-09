import {OptPlaybackSession,type OptPlaybackSessionOptions} from './opt-playback';
import type {TrajectoryResult} from './contracts';
import {playbackCollectionKey,type PlaybackCollection} from './playback-collection';

interface Entry {result:TrajectoryResult;revision:string;session:OptPlaybackSession;consumers:Map<object,{active:boolean;ready:boolean}>}
/** A document/collection owns one timer. View leases only contribute visibility
 * and readiness; hiding one consumer cannot stop another visible consumer. */
export class PlaybackOwnerRegistry {
 private entries=new Map<string,Entry>();
 acquire(collection:PlaybackCollection,result:TrajectoryResult,options:OptPlaybackSessionOptions={}) {
  const key=playbackCollectionKey(collection),revision=collection.identity.revision;let entry=this.entries.get(key);
  if(entry&&entry.revision!==revision){
   // A publication is replaced atomically. Existing leases retain their old
   // reader until release and cannot publish into the new owner.
   this.entries.delete(key);entry=undefined;
  }
  if(!entry){entry={result,revision,session:new OptPlaybackSession(result,{...options,...(options.prepared?{prepared:options.prepared.fork()}:{})}),consumers:new Map()};this.entries.set(key,entry);}
  const own=entry,token={},refresh=()=>{const values=[...own.consumers.values()];own.session.setEnvironment(values.some(value=>value.active),values.some(value=>value.active&&value.ready));};
  own.consumers.set(token,{active:false,ready:false});let released=false;
  return{session:own.session,
   // Only an explicit effect setup may reacquire a StrictMode-cleaned lease.
   // Late visibility/readiness callbacks must never resurrect a deleted view.
   reacquire:()=>{if(!released)return;const current=this.entries.get(key);if(current&&current!==own)return;released=false;this.entries.set(key,own);own.session.reacquire();own.consumers.set(token,{active:false,ready:false});},
   setEnvironment:(active:boolean,ready:boolean)=>{if(released)return;own.consumers.set(token,{active,ready});refresh();},release:()=>{if(released)return;released=true;own.consumers.delete(token);if(!own.consumers.size){own.session.dispose();if(this.entries.get(key)===own)this.entries.delete(key);}else refresh();}};
 }
 get size(){return this.entries.size;}
}
export const playbackOwners=new PlaybackOwnerRegistry();
const scopes=new WeakMap<object,string>();
export function playbackScopeIdentity(scope:object,fallback:string){let id=scopes.get(scope);if(!id){id=`${fallback}:${crypto.randomUUID()}`;scopes.set(scope,id);}return id;}
