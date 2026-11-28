import {useCallback,useSyncExternalStore} from 'react';
import {applicationVersion} from '../application-version';

export const INTERFACE_THEMES=['mixed','mint','clear','slate','ivory','graphite'] as const;
export type InterfaceTheme=(typeof INTERFACE_THEMES)[number];
export const INTERFACE_THEME_KEY='sciyue.interface-theme';
export const INTERFACE_THEME_VERSION_KEY=`${INTERFACE_THEME_KEY}.version`;
export const DEFAULT_INTERFACE_THEME:InterfaceTheme='mixed';
const CHANGE_EVENT='sciyue:interface-theme';
let current:InterfaceTheme|undefined;
let unsavedSessionChoice=false;
const validTheme=(value:unknown):InterfaceTheme=>typeof value==='string'&&(INTERFACE_THEMES as readonly string[]).includes(value)?value as InterfaceTheme:DEFAULT_INTERFACE_THEME;
function currentDocument():Document|undefined{return typeof document==='undefined'?undefined:document;}
function readStoredTheme():InterfaceTheme {
  try{
    const storage=window.localStorage;
    return storage.getItem(INTERFACE_THEME_VERSION_KEY)===applicationVersion.displayVersion
      ?validTheme(storage.getItem(INTERFACE_THEME_KEY)):DEFAULT_INTERFACE_THEME;
  }
  catch{return current??DEFAULT_INTERFACE_THEME;}
}
export function readInterfaceTheme():InterfaceTheme {
  return current??=typeof window==='undefined'?DEFAULT_INTERFACE_THEME:readStoredTheme();
}
function syncDocument(target=currentDocument()){
  if(target)target.documentElement.dataset.interfaceTheme=readInterfaceTheme();
}
export function setInterfaceTheme(value:InterfaceTheme):void {
  current=validTheme(value);
  try{
    window.localStorage.setItem(INTERFACE_THEME_KEY,current);
    window.localStorage.setItem(INTERFACE_THEME_VERSION_KEY,applicationVersion.displayVersion);
    unsavedSessionChoice=false;
  }catch{unsavedSessionChoice=true;}
  syncDocument();
  if(typeof window!=='undefined')window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function subscribeInterfaceTheme(listener:()=>void,target=currentDocument()):()=>void {
  if(typeof window==='undefined')return()=>{};
  const changed=()=>{syncDocument(target);listener();};
  const stored=(event:StorageEvent)=>{
    if(event.key!==INTERFACE_THEME_KEY&&event.key!==INTERFACE_THEME_VERSION_KEY&&event.key!==null)return;
    if(event.storageArea&&event.storageArea!==window.localStorage)return;
    unsavedSessionChoice=false;current=readStoredTheme();changed();
  };
  window.addEventListener(CHANGE_EVENT,changed);
  window.addEventListener('storage',stored);
  if(!unsavedSessionChoice)current=readStoredTheme();syncDocument(target);
  return()=>{window.removeEventListener(CHANGE_EVENT,changed);window.removeEventListener('storage',stored);};
}
/** about:blank portals use their opener's preference owner. Native model/main
 * windows load the same app origin and receive its ordinary storage events. */
export function bindInterfaceThemeDocument(target:Document):()=>void {
  const unsubscribe=subscribeInterfaceTheme(()=>{},target),realm=target.defaultView;
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;unsubscribe();realm?.removeEventListener('beforeunload',dispose);realm?.removeEventListener('pagehide',dispose);};
  realm?.addEventListener('beforeunload',dispose);realm?.addEventListener('pagehide',dispose);
  return dispose;
}
export function useInterfaceTheme(target?:Document):[InterfaceTheme,(value:InterfaceTheme)=>void] {
  const subscribe=useCallback((listener:()=>void)=>subscribeInterfaceTheme(listener,target),[target]);
  return [useSyncExternalStore(subscribe,readInterfaceTheme,()=>DEFAULT_INTERFACE_THEME),setInterfaceTheme];
}
