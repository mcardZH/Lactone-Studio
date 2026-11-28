import {useCallback,useSyncExternalStore} from 'react';

export const INTERFACE_SURFACES=['flagship','flat','glass'] as const;
export type InterfaceSurface=(typeof INTERFACE_SURFACES)[number];
export const INTERFACE_SURFACE_KEY='sciyue.interface-surface';
export const DEFAULT_INTERFACE_SURFACE:InterfaceSurface='flagship';
const CHANGE_EVENT='sciyue:interface-surface';
let current:InterfaceSurface|undefined;
let unsavedSessionChoice=false;

const validSurface=(value:unknown):InterfaceSurface=>
  typeof value==='string'&&(INTERFACE_SURFACES as readonly string[]).includes(value)?value as InterfaceSurface:DEFAULT_INTERFACE_SURFACE;

function currentDocument():Document|undefined{return typeof document==='undefined'?undefined:document;}

function readStoredSurface():InterfaceSurface {
  try{return validSurface(window.localStorage.getItem(INTERFACE_SURFACE_KEY));}
  catch{return current??DEFAULT_INTERFACE_SURFACE;}
}

export function readInterfaceSurface():InterfaceSurface {
  return current??=typeof window==='undefined'?DEFAULT_INTERFACE_SURFACE:readStoredSurface();
}

function syncDocument(target=currentDocument()){
  if(target)target.documentElement.dataset.interfaceSurface=readInterfaceSurface();
}

export function setInterfaceSurface(value:InterfaceSurface):void {
  current=validSurface(value);
  try{
    window.localStorage.setItem(INTERFACE_SURFACE_KEY,current);
    unsavedSessionChoice=false;
  }catch{unsavedSessionChoice=true;}
  syncDocument();
  if(typeof window!=='undefined')window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeInterfaceSurface(listener:()=>void,target=currentDocument()):()=>void {
  if(typeof window==='undefined')return()=>{};
  const changed=()=>{syncDocument(target);listener();};
  const stored=(event:StorageEvent)=>{
    if(event.key!==INTERFACE_SURFACE_KEY&&event.key!==null)return;
    if(event.storageArea&&event.storageArea!==window.localStorage)return;
    unsavedSessionChoice=false;current=readStoredSurface();changed();
  };
  window.addEventListener(CHANGE_EVENT,changed);
  window.addEventListener('storage',stored);
  if(!unsavedSessionChoice)current=readStoredSurface();syncDocument(target);
  return()=>{window.removeEventListener(CHANGE_EVENT,changed);window.removeEventListener('storage',stored);};
}

/** about:blank portals use their opener's preference owner. Native model/main
 * windows load the same app origin and receive its ordinary storage events. */
export function bindInterfaceSurfaceDocument(target:Document):()=>void {
  const unsubscribe=subscribeInterfaceSurface(()=>{},target),realm=target.defaultView;
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;unsubscribe();realm?.removeEventListener('beforeunload',dispose);realm?.removeEventListener('pagehide',dispose);};
  realm?.addEventListener('beforeunload',dispose);realm?.addEventListener('pagehide',dispose);
  return dispose;
}

export function useInterfaceSurface(target?:Document):[InterfaceSurface,(value:InterfaceSurface)=>void] {
  const subscribe=useCallback((listener:()=>void)=>subscribeInterfaceSurface(listener,target),[target]);
  return [useSyncExternalStore(subscribe,readInterfaceSurface,()=>DEFAULT_INTERFACE_SURFACE),setInterfaceSurface];
}
