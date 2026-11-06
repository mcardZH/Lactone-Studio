import {useCallback,useState,type SetStateAction} from 'react';
import {useProjectState} from '../../projects/ui-state';

/** Page navigation belongs to a document, independently of shared task data. */
export function useWorkspacePageValue<T>(documentId:string|undefined,initial:T,key='navigation'):[T,(value:SetStateAction<T>)=>void]{
 const [values,setValues]=useProjectState<Record<string,T>>(`workspace-page.${key}`,{});
 const setValue=useCallback((value:SetStateAction<T>)=>{
  if(!documentId)return;
  setValues(previous=>{const current=Object.prototype.hasOwnProperty.call(previous,documentId)?previous[documentId]:initial;
   const next=typeof value==='function'?(value as (current:T)=>T)(current):value;
   return Object.is(current,next)?previous:{...previous,[documentId]:next};});
 },[documentId,initial,setValues]);
 return [documentId&&Object.prototype.hasOwnProperty.call(values,documentId)?values[documentId]:initial,setValue];
}
