import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react';

export type ProjectUiValue = null | boolean | number | string | ProjectUiValue[] | { [key: string]: ProjectUiValue };
export interface ProjectUiSnapshot { schema: 1; values: Record<string, ProjectUiValue> }
function jsonValue(value: unknown, seen = new Set<object>()): ProjectUiValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('项目界面状态必须是无循环的 JSON 数据。');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('项目界面状态不能包含原生会话、GPU或其他运行对象。');
  seen.add(value);
  try { return Array.isArray(value) ? value.map(item => jsonValue(item, seen)) : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, jsonValue(item, seen)])); }
  finally { seen.delete(value); }
}
/** Compare normalized JSON values; object insertion order is not state, while
 * array order, null and missing properties retain their JSON meaning. */
function sameJsonValue(left:ProjectUiValue,right:ProjectUiValue):boolean {
  if(left===right)return true;
  if(left===null||right===null||typeof left!=='object'||typeof right!=='object')return false;
  if(Array.isArray(left)||Array.isArray(right)){
    if(!Array.isArray(left)||!Array.isArray(right)||left.length!==right.length)return false;
    for(let index=0;index<left.length;index++)if(!sameJsonValue(left[index],right[index]))return false;
    return true;
  }
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&sameJsonValue(left[key],right[key]));
}
/** One project owns this store. Capture reads committed controls immediately;
 * hydration changes data only and never replays clicks or scientific actions. */
export class ProjectUiStore {
  private values = new Map<string, ProjectUiValue>();
  private listeners = new Set<() => void>();
  private captures = new Map<string, {read: () => unknown}>();
  private version = 0;
  private generation = 0;
  restored = false;
  constructor(snapshot?: ProjectUiSnapshot) { if (snapshot) this.hydrate(snapshot); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  getGeneration = () => this.generation;
  has(key: string) { return this.values.has(key); }
  get<T>(key: string, initial: T): T { return this.values.has(key) ? this.values.get(key) as T : initial; }
  initialize(key: string, value: unknown, generation = this.generation) { if (generation === this.generation && value !== undefined && !this.values.has(key)) this.values.set(key, jsonValue(value)); }
  set(key: string, value: unknown, generation = this.generation) {
    if(generation!==this.generation)return;
    if(value===undefined&&!this.values.has(key))return;
    if (value === undefined) this.values.delete(key);
    else {
      const normalized=jsonValue(value);
      if(this.values.has(key)&&sameJsonValue(this.values.get(key)!,normalized))return;
      this.values.set(key,normalized);
    }
    this.version++; for (const listener of this.listeners) listener();
  }
  registerCapture(key: string, capture: () => unknown, generation = this.generation) {
    if(generation!==this.generation)return()=>{};
    if(this.captures.has(key))throw new Error(`界面状态owner重复：${key}`);
    const lease={read:capture};this.captures.set(key,lease);
    return () => {if(generation!==this.generation||this.captures.get(key)!==lease)return;const value=capture();if(value!==undefined)this.values.set(key,jsonValue(value));this.captures.delete(key);};
  }
  capture(): ProjectUiSnapshot { const values=new Map(this.values);for(const [key,owner] of this.captures){const value=owner.read();if(value!==undefined)values.set(key,jsonValue(value));}return { schema: 1, values: jsonValue(Object.fromEntries(values)) as Record<string, ProjectUiValue> }; }
  hydrate(snapshot: ProjectUiSnapshot) {
    if (!snapshot || snapshot.schema !== 1 || !snapshot.values || Array.isArray(snapshot.values)) throw new Error('项目界面状态版本或数据无效。');
    const values = jsonValue(snapshot.values) as Record<string, ProjectUiValue>;
    // Old mounted controls and pending cleanup callbacks belong to the prior
    // project generation. They must not publish into the restored snapshot.
    this.generation++;this.captures.clear();
    this.values = new Map(Object.entries(values)); this.restored = true; this.version++;
    for (const listener of this.listeners) listener();
  }
  removeScope(scope: readonly (string | number)[]) {
    const prefix = JSON.stringify(scope).slice(0, -1) + ',';
    for (const key of this.values.keys()) if (key.startsWith(prefix)) this.values.delete(key);
    for (const key of this.captures.keys()) if (key.startsWith(prefix)) this.captures.delete(key);
    this.version++; for (const listener of this.listeners) listener();
  }
}
interface UiScope { store: ProjectUiStore; scope: readonly (string | number)[]; generation: number }
const Context = createContext<UiScope | null>(null);
/** Keep one-shot snapshot consumers unmounted until the entire restored
 * workspace is ready. The workspace/controller that owns this gate stays live. */
export function ProjectUiRestoreBoundary({restoring,children}:{restoring:boolean;children:()=>ReactNode}) {
  return restoring ? <div role="status">正在恢复项目…</div> : children();
}
export function ProjectUiScope({ store, scope, children }: { store?: ProjectUiStore; scope: readonly (string | number)[]; children: ReactNode }) {
  const parent = useContext(Context), signature = JSON.stringify(scope);
  const ownGeneration=useSyncExternalStore(store?.subscribe??noopSubscribe,store?.getGeneration??zero,store?.getGeneration??zero);
  const generation=store?ownGeneration:parent?.generation;
  const value = useMemo(() => { const owner = store ?? parent?.store; return owner ? { store: owner, scope: [...(store ? [] : parent?.scope ?? []), ...scope], generation:generation??owner.getGeneration() } : null; }, [store, parent, signature,generation]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useProjectUiRestored(): boolean { return useContext(Context)?.store.restored ?? false; }
export function useProjectUiScope() { return useContext(Context); }
/** For hot controllers: sample at save/unmount, without per-frame notifications. */
export function useProjectUiSnapshot<T>(key:string,capture:()=>T):T|undefined {
  const context=useContext(Context);
  const storageKey=JSON.stringify([...(context?.scope??[]),key]);
  const latest=useMemo(()=>({current:capture}),[context,storageKey]);latest.current=capture;
  useLayoutEffect(()=>context?.store.registerCapture(storageKey,()=>latest.current(),context.generation),[context,storageKey]);
  return context?.store.get<T|undefined>(storageKey,undefined);
}
/** Native details expose a display state, not an action. The boundary records
 * that state directly, including sections that mount later, without click replay. */
export function ProjectNativeDetailsBoundary({children}:{children:ReactNode}) {
  const root=useRef<HTMLDivElement>(null),context=useProjectUiScope();
  const [states,setStates]=useProjectState<Record<string,boolean>>('native-details',{});
  const indexed=()=>{
    const host=root.current,counts=new Map<string,number>();
    return host?[...host.querySelectorAll<HTMLDetailsElement>('details')].filter(node=>node.closest('[data-project-native-details-owner]')===host).map(node=>{
      const sections:string[]=[];let parent=node.parentElement;
      while(parent&&parent!==host){if(parent.tagName==='SECTION')sections.unshift(parent.getAttribute('data-testid')??parent.getAttribute('aria-label')??parent.querySelector(':scope > header h3, :scope > header h4, :scope > h3, :scope > h4')?.textContent?.trim()??'section');parent=parent.parentElement;}
      const label=node.querySelector(':scope > summary')?.textContent?.trim()??'',base=JSON.stringify([...sections,label]);
      const index=counts.get(base)??0;counts.set(base,index+1);return{node,key:JSON.stringify([base,index])};
    }):[];
  };
  useProjectUiSnapshot('native-details',()=>({...states,...Object.fromEntries(indexed().map(({node,key})=>[key,node.open]))}));
  const signature=JSON.stringify(context?.scope??[]);
  useLayoutEffect(()=>{
    const host=root.current;if(!host||!context)return;
    const apply=()=>{for(const {node,key} of indexed())if(Object.hasOwn(states,key)&&node.open!==states[key])node.open=states[key];};
    const toggle=(event:Event)=>{const item=indexed().find(({node})=>node===event.target);if(item)setStates(previous=>previous[item.key]===item.node.open?previous:{...previous,[item.key]:item.node.open});};
    apply();host.addEventListener('toggle',toggle,true);
    const Observer=host.ownerDocument.defaultView?.MutationObserver,observer=Observer?new Observer(apply):null;observer?.observe(host,{childList:true,subtree:true});
    return()=>{host.removeEventListener('toggle',toggle,true);observer?.disconnect();};
  },[context,signature,states]);
  return <div ref={root} data-project-native-details-owner="" style={{display:'contents'}}>{children}</div>;
}
/** Runtime sessions and activation epochs are deliberately absent. */
export function projectUiSourceIdentity(value: unknown): string {
  const p = (value ?? {}) as Record<string, any>, source = p.context ?? p.sourceContext ?? p.analysis?.context ?? p.metadata ?? {};
  const result = p.result ?? p.sourceResult;
  return JSON.stringify([source.sourceId ?? result?.source?.id ?? p.identity ?? null, source.sourceRevision ?? result?.source?.revision ?? null,
    source.documentId ?? null, source.documentRevision ?? null, source.jobIndex ?? result?.jobIndex ?? null,
    source.sourceFrameIndex ?? p.currentIndex ?? p.sourceFrameIndex ?? null, source.generation ?? result?.id ?? null, p.kind ?? null, p.orbitalKey ?? null,p.ownerId??null]);
}
const noopSubscribe = () => () => {};
const zero = () => 0;
export function useProjectState<T>(key: string, initial: T | (() => T), identity?: string | number): [T, Dispatch<SetStateAction<T>>];
export function useProjectState<T = undefined>(key: string, initial?: undefined, identity?: string | number): [T | undefined, Dispatch<SetStateAction<T | undefined>>];
export function useProjectState<T>(key: string, initial?: T | (() => T), identity?: string | number): [T | undefined, Dispatch<SetStateAction<T | undefined>>] {
  const context = useContext(Context), [fallback, setFallback] = useState(initial);
  const storageKey = JSON.stringify([...(context?.scope ?? []), key, ...(identity === undefined ? [] : [identity])]);
  const defaultValue=useMemo(()=>context?(typeof initial==='function'?(initial as ()=>T)():initial):fallback,[context,storageKey]);
  const generation=context?.generation??context?.store.getGeneration();
  context?.store.initialize(storageKey, defaultValue,generation);
  useSyncExternalStore(context?.store.subscribe ?? noopSubscribe, context?.store.getVersion ?? zero, zero);
  const setter = useCallback<Dispatch<SetStateAction<T | undefined>>>((action) => {
    if (!context) { setFallback(action); return; }
    if(generation!==context.store.getGeneration())return;
    const previous = context.store.get(storageKey, defaultValue);
    const next=typeof action === 'function' ? (action as (value: T | undefined) => T | undefined)(previous) : action;
    if(Object.is(previous,next))return;
    context.store.set(storageKey, next,generation);
  }, [context, storageKey, defaultValue,generation]);
  return [context ? context.store.get(storageKey, defaultValue) : fallback, setter];
}
