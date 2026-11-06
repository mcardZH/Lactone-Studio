import {useEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import type {DisplaySettings} from '../../modeling/contracts';
import {desktopBridge} from '../../modeling/platform/desktop';
import {createRuntimeDisplayController,type RuntimeDisplayBridge} from '../../modeling/platform/runtime-display';

/** React owns only its subscription; the platform controller owns session ordering. */
export function useRuntimeModelDisplay(options:{bridge?:RuntimeDisplayBridge|null;initialDisplay:DisplaySettings;loadDefault:()=>Promise<DisplaySettings>;onError?:(error:unknown)=>void}){
 const latest=useRef(options);latest.current=options;
 const bridge=(options.bridge===undefined?desktopBridge():options.bridge) as Partial<RuntimeDisplayBridge>|null;
 const available=typeof bridge?.readRuntimeModelDisplay==='function'&&typeof bridge.updateRuntimeModelDisplay==='function'&&typeof bridge.onRuntimeModelDisplay==='function'?bridge as RuntimeDisplayBridge:null;
 const controller=useMemo(()=>createRuntimeDisplayController(available,options.initialDisplay,error=>latest.current.onError?.(error)),[available]);
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 useEffect(()=>{void controller.initialize(()=>latest.current.loadDefault());return()=>controller.dispose();},[controller]);
 return{...state,changeDisplay:controller.changeDisplay};
}
