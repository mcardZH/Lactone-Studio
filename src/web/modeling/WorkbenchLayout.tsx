import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createDefaultWorkbenchPreferences, getDefaultWorkbenchLayout, fixedWorkbenchToolLayout, normalizeWorkbenchPreferences, type WorkbenchLayout, type WorkbenchPreferences, type WorkbenchPreferenceSnapshot } from '../../modeling/workbench-layout';
import { readWorkbenchPreferenceSnapshot } from '../../modeling/platform/preferences';
import './workbench-tools.css';
export interface WorkbenchLayoutState {
  layout: WorkbenchLayout; preferences: WorkbenchPreferences; editMode: boolean; saving: boolean; error: string; writable: boolean; preferenceVersion: string;
  setEditMode(value: boolean): void;
  updateLayout(value: Partial<WorkbenchLayout> | ((current: WorkbenchLayout) => WorkbenchLayout)): void;
  saveLayout(name: string): Promise<void>; setDefault(layoutId?: string): Promise<void>;
  restoreDefault(): void; restoreBuiltin(): void; cancelEdit(): void; applyLayout(layoutId: string): void;
  editorOpen: boolean; openEditor(): void; closeEditor(): void;
}
/** Retained only for old embedders. Tool-layout editing is no longer available. */
export function subscribeNativeWorkbenchLayout(_enabled: boolean, _bridge: { onWorkbenchLayoutOpen?: (listener: () => void) => () => void } | null, _open: () => void): () => void { return () => {}; }
const Context=createContext<WorkbenchLayoutState|null>(null);
function useLayoutState(enabled=true):WorkbenchLayoutState {
  const initial=createDefaultWorkbenchPreferences();
  const [snapshot,setSnapshot]=useState<WorkbenchPreferenceSnapshot>({preferences:initial,version:'loading',writable:false});
  const [layout,setLayout]=useState(()=>fixedWorkbenchToolLayout(getDefaultWorkbenchLayout(initial)));
  const touched=useRef(false),[error,setError]=useState('');
  useEffect(()=>{if(!enabled)return;let alive=true;void readWorkbenchPreferenceSnapshot().then(value=>{
    if(!alive)return;
    const accepted={...value,preferences:normalizeWorkbenchPreferences(value.preferences)};
    setSnapshot(accepted);setError(accepted.error??'');
    if(!touched.current)setLayout(fixedWorkbenchToolLayout(getDefaultWorkbenchLayout(accepted.preferences)));
  }).catch(cause=>{if(alive)setError(`读取界面配置失败：${String(cause)}`);});return()=>{alive=false;};},[enabled]);
  const updateLayout:WorkbenchLayoutState['updateLayout']=value=>{touched.current=true;setLayout(current=>fixedWorkbenchToolLayout(typeof value==='function'?value(current):{...current,...value}));};
  const unavailable=async()=>{throw new Error('工具按钮布局由软件统一，不再支持编辑或保存自定义布局。');};
  return {layout,preferences:snapshot.preferences,editMode:false,saving:false,error,writable:snapshot.writable,preferenceVersion:snapshot.version,
    updateLayout,setEditMode:()=>{},saveLayout:unavailable,setDefault:unavailable,
    restoreDefault:()=>updateLayout(getDefaultWorkbenchLayout(snapshot.preferences)),
    restoreBuiltin:()=>updateLayout(getDefaultWorkbenchLayout(createDefaultWorkbenchPreferences())),
    cancelEdit:()=>{},applyLayout:id=>{const saved=snapshot.preferences.layouts.find(item=>item.id===id);if(saved)updateLayout(saved);},
    editorOpen:false,openEditor:()=>{},closeEditor:()=>{}};
}
export function WorkbenchLayoutProvider({children}:{children:ReactNode}){const state=useLayoutState();return <Context.Provider value={state}>{children}</Context.Provider>;}
export function useWorkbenchLayout():WorkbenchLayoutState{const context=useContext(Context),fallback=useLayoutState(!context);return context??fallback;}
/** Kept as an inert compatibility export for old mounted routes. */
export function WorkbenchLayoutEditor(_props:{shellHost?:boolean}={}){return null;}
