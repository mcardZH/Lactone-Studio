import {useRef,useState,type Dispatch,type SetStateAction} from 'react';

/** These fields participate in presentation ownership checks in ModelViewport. */
const identityFields=new Set(['values','layer','record','region']);
export function sameProjectedValue(a:unknown,b:unknown):boolean{
 if(Object.is(a,b))return true;
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>sameProjectedValue(value,b[index]));
 const first=a as Record<string,unknown>,second=b as Record<string,unknown>,keys=Object.keys(first);
 return Object.getPrototypeOf(a)===Object.getPrototypeOf(b)&&keys.length===Object.keys(second).length&&keys.every(key=>Object.hasOwn(second,key)&&(identityFields.has(key)?Object.is(first[key],second[key]):sameProjectedValue(first[key],second[key])));
}
export interface ProjectionCounters{attempts:number;commits:number;plans:number}
export function createProjectionPublisher<T>(initial:T,commit:(next:T)=>void,counters?:ProjectionCounters){
 let current=initial;
 return {read:()=>current,publish:(value:SetStateAction<T>)=>{
  if(counters)counters.attempts++;
  const next=typeof value==='function'?(value as (previous:T)=>T)(current):value;
  if(sameProjectedValue(current,next))return false;
  current=next;if(counters)counters.commits++;commit(next);return true;
 }};
}
/** Every writer (including fragment previews) goes through the same live value. */
export function useProjectedState<T>(initial:T,counters?:ProjectionCounters):[T,Dispatch<SetStateAction<T>>]{
 const [value,setValue]=useState(initial),publisher=useRef<ReturnType<typeof createProjectionPublisher<T>>|null>(null);
 if(!publisher.current)publisher.current=createProjectionPublisher(initial,setValue,counters);
 return [value,publisher.current.publish];
}
/** Cache only immutable definition inputs, never the camera or projected pixels. */
export function createProjectionPlanCache(counters?:ProjectionCounters){
 let previous:readonly unknown[]|undefined,value:unknown;
 return {read<T>(keys:readonly unknown[],create:()=>T):T{
  if(!previous||previous.length!==keys.length||keys.some((key,index)=>!Object.is(key,previous![index]))){previous=[...keys];value=create();if(counters)counters.plans++;}
  return value as T;
 }};
}
