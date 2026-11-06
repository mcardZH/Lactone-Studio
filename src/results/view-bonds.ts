import type {Structure} from '../core/types';
import type {TrajectoryResult} from './contracts';
import {createViewBondSnapshot,viewBondGeometryKey as geometryKey,viewBondSourceMessage as sourceMessage,type ViewBondSnapshot,type ViewBondResolution} from './view-bonds-core';
export {createViewBondSnapshot} from './view-bonds-core';
export type {ViewBondSnapshot,ViewBondResolution} from './view-bonds-core';
/** The UI's explicit display inference runs off the renderer thread and owns its cancellation. */
export async function prepareViewBondSnapshot(structure:Structure,index:number,signal?:AbortSignal):Promise<ViewBondSnapshot>{
  if(signal?.aborted)throw new DOMException('显示连接准备已取消。','AbortError');
  if(structure.bonds!==undefined)return createViewBondSnapshot(structure,index);
  if(typeof window==='undefined')return createViewBondSnapshot(structure,index);
  const worker=new Worker(new URL('./view-bonds-worker.ts',import.meta.url),{type:'module'});
  try{return await new Promise<ViewBondSnapshot>((resolve,reject)=>{
    const finish=(error?:unknown,value?:ViewBondSnapshot)=>{signal?.removeEventListener('abort',abort);worker.onmessage=null;worker.onerror=null;if(error)reject(error);else resolve(value!);};
    const abort=()=>finish(new DOMException('显示连接准备已取消。','AbortError'));worker.onmessage=event=>event.data.error?finish(new Error(event.data.error)):finish(undefined,event.data.snapshot);worker.onerror=event=>finish(new Error(event.message||'显示连接worker失败。'));signal?.addEventListener('abort',abort,{once:true});worker.postMessage({structure,index});
  });}finally{worker.terminate();}
}

/** Project the exact current geometry; a prior frame never fixes its topology. */
export function applyViewBondSnapshot(snapshot: ViewBondSnapshot, structure: Structure): ViewBondResolution {
  if (structure.bonds !== undefined) return { structure, source: 'file', message: sourceMessage(structure) };
  const none = (message: string): ViewBondResolution => ({ structure, source: 'unavailable', message });
  if (structure.atoms.length !== snapshot.atomIds.length || structure.atoms.some((atom, i) => atom.id !== snapshot.atomIds[i] || atom.element !== snapshot.elements[i]))
    return none('原子对应与显示键缓存不符，请在当前帧重新识别。');
  const current = snapshot.geometryKey !== undefined && snapshot.geometryKey === geometryKey(structure)
    ? snapshot : createViewBondSnapshot(structure, snapshot.sourceFrame);
  if (current.source === 'unavailable') return none(current.message);
  return { structure: { ...structure, bonds: structuredClone(current.bonds),...(current.issues?{bondPerceptionIssues:structuredClone(current.issues)}:{}), bondSource: current.source === 'file' ? 'file' : 'inferred' }, source: current.source, message: current.message };
}

/** Each result instance owns a bounded cache of exact frame/geometry snapshots. */
export class ResultViewBonds {
  private frames = new Map<number, ViewBondSnapshot>();
  constructor(_result: Pick<TrajectoryResult, 'kind' | 'initialStructure'>) {}
  has(structure:Structure,index:number){return this.frames.get(index)?.geometryKey===geometryKey(structure);}
  accept(snapshot:ViewBondSnapshot,structure:Structure,index:number){if(snapshot.sourceFrame!==index||snapshot.geometryKey!==geometryKey(structure))throw Error('显示连接准备返回了其他帧。');this.frames.set(index,snapshot);}
  snapshot(structure: Structure, index: number): ViewBondSnapshot {
    let value = this.frames.get(index);
    if (!value || value.geometryKey === undefined || value.geometryKey !== geometryKey(structure) || structure.bonds !== undefined)
      value = createViewBondSnapshot(structure, index);
    this.frames.delete(index);
    // Large/unavailable and explicit source graphs do not accumulate copies.
    if (value.geometryKey !== undefined) this.frames.set(index, value);
    while (this.frames.size > 8) this.frames.delete(this.frames.keys().next().value!);
    return value;
  }
  resolve(structure: Structure, index: number): ViewBondResolution {
    const snapshot = this.snapshot(structure, index);
    return snapshot.source === 'unavailable' ? { structure, source: 'unavailable', message: snapshot.message } : applyViewBondSnapshot(snapshot, structure);
  }
  rebuild(structure: Structure, index: number) {
    const next = createViewBondSnapshot(structure, index);
    this.frames.delete(index);
    if (next.geometryKey !== undefined) this.frames.set(index, next);
    while (this.frames.size > 8) this.frames.delete(this.frames.keys().next().value!);
    return next;
  }
}
