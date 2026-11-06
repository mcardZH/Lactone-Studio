import type { Structure } from '../core/types';
import { superposeViewAtoms, type ViewRigidTransform, type ViewSuperpositionDiagnostics, VIEW_SUPERPOSITION_ATOM_LIMIT } from './view-superposition';
import {sha256Utf8} from '../core/file-identity';

export const MULTIFRAME_DISPLAY_LIMITS = Object.freeze({ frames: Number.MAX_SAFE_INTEGER, atomInstances: Number.MAX_SAFE_INTEGER, fitAtoms: VIEW_SUPERPOSITION_ATOM_LIMIT });
export interface MultiframeDisplayIdentity {
  sourceId: string; sourceRevision: string; collectionId: string; frameId: string;
  documentId?: string; taskId?: string; runId?: string; stageId?: string; sourceFrameIndex?: number;
}
export interface MultiframeDisplayFrame { key: string; identity: MultiframeDisplayIdentity; structure: Structure }
/** Geometry only; scientific force constants remain with the owner. */
export interface SamplingSphereDisplay { centerAngstrom: [number, number, number]; radiusAngstrom: number }
export function validateSamplingSphereDisplay(sphere: SamplingSphereDisplay): void {
  if (!Array.isArray(sphere.centerAngstrom) || sphere.centerAngstrom.length !== 3 || !sphere.centerAngstrom.every(Number.isFinite)
    || !Number.isFinite(sphere.radiusAngstrom) || sphere.radiusAngstrom <= 0) throw new Error('球形显示需要有限球心和正半径。');
}
export type MultiframeDisplayFit = { kind: 'raw' }
  | { kind: 'proper'; referenceFrameKey: string; atomIds?: readonly string[] }
  | { kind: 'core'; reference: MultiframeDisplayFrame; atomIds: readonly string[] };
export interface MultiframeDisplayPlan {
  generation?:number; transformRevision?:string;
  key: string; sourceKey: string; activeFrameKey: string; fitKind: MultiframeDisplayFit['kind']; referenceKey?: string;
  frameCount: number; atomInstances: number;
  frames: (MultiframeDisplayFrame & { transform: ViewRigidTransform; diagnostics?: ViewSuperpositionDiagnostics })[];
}
const identity = (): ViewRigidTransform => ({ rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation: [0, 0, 0], anchorIds: [] });
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const sourceKey = (frame: MultiframeDisplayFrame) => JSON.stringify([frame.identity.sourceId, frame.identity.sourceRevision, frame.identity.collectionId, frame.identity.taskId, frame.identity.runId, frame.identity.stageId]);
const signature = (s: Structure) => JSON.stringify(s.atoms.map(a => [a.id, a.element]).sort(([a], [b]) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
function checkFrame(frame: MultiframeDisplayFrame) {
  const { structure: s, identity: ref } = frame;
  if (!frame.key || !ref?.sourceId || !ref.sourceRevision || !ref.collectionId || !ref.frameId
    || ref.sourceFrameIndex !== undefined && (!Number.isSafeInteger(ref.sourceFrameIndex) || ref.sourceFrameIndex < 0)
    || !s?.atoms.length || s.atoms.some(a => !a.id || !a.element || ![a.x, a.y, a.z].every(Number.isFinite))
    || new Set(s.atoms.map(a => a.id)).size !== s.atoms.length) throw new Error('多帧显示需要完整来源、稳定原子ID与有限坐标。');
  for (const b of s.bonds ?? []) if (![b.a, b.b].every(i => Number.isSafeInteger(i) && i >= 0 && i < s.atoms.length) || !Number.isFinite(b.order)) throw new Error('多帧显示连接图无效。');
}
export function validateMultiframeDisplayPlan(plan: MultiframeDisplayPlan): void {
  if (!plan || typeof plan.key !== 'string' || !plan.key || !['raw', 'proper', 'core'].includes(plan.fitKind)) throw new Error('多帧显示计划身份或拟合类型无效。');
  if (!plan?.frames?.length) throw new Error('多帧叠合需要非空完整帧集合。');
  if (plan.frameCount !== plan.frames.length || plan.atomInstances !== plan.frames.reduce((n, f) => n + f.structure.atoms.length, 0)
    || new Set(plan.frames.map(f => f.key)).size !== plan.frames.length || !plan.frames.some(f => f.key === plan.activeFrameKey)) throw new Error('多帧显示数量或当前帧身份不一致。');
  const first = plan.frames[0];
  for (const frame of plan.frames) {
    checkFrame(frame);
    if (sourceKey(frame) !== plan.sourceKey || sourceKey(frame) !== sourceKey(first) || signature(frame.structure) !== signature(first.structure)) throw new Error('多帧显示不能混用来源集合或猜测原子对应。');
    if (!Array.isArray(frame.transform?.anchorIds)) throw new Error('多帧显示拟合原子身份无效。');
    const r = frame.transform?.rotation, t = frame.transform?.translation;
    if (!Array.isArray(r) || r.length !== 3 || r.some(row => row.length !== 3 || !row.every(Number.isFinite)) || !Array.isArray(t) || t.length !== 3 || !t.every(Number.isFinite)) throw new Error('多帧显示变换必须有限。');
    const dot = (a: number[], b: number[]) => a.reduce((n, v, i) => n + v * b[i], 0);
    const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    if (Math.abs(det - 1) > 1e-8 || r.some((row, i) => r.some((other, j) => Math.abs(dot(row, other) - Number(i === j)) > 1e-8))) throw new Error('多帧显示只接受proper刚体旋转，不反射或缩放。');
  }
}
/** Immutable display copies; no source/model/velocity/revision or camera mutation. */
export function createMultiframeDisplay(input: { frames: readonly MultiframeDisplayFrame[]; activeFrameKey: string; fit?: MultiframeDisplayFit; generation?:number;transformRevision?:string }): MultiframeDisplayPlan {
  const fit = input.fit ?? { kind: 'raw' }, frames = input.frames;
  if (!frames.length) throw new Error('多帧叠合需要非空完整帧集合。');
  frames.forEach(checkFrame);
  const reference = fit.kind === 'raw' ? undefined : fit.kind === 'core' ? fit.reference : frames.find(f => f.key === fit.referenceFrameKey);
  if (fit.kind !== 'raw' && !reference) throw new Error('显式拟合参考帧不存在。');
  if (reference) checkFrame(reference);
  const ids = fit.kind === 'raw' ? [] : fit.atomIds ? [...fit.atomIds] : (() => {
    const heavy = reference!.structure.atoms.filter(a => a.element !== 'H'); return heavy.map(a => a.id!);
  })();
  if (fit.kind !== 'raw' && (!ids.length || new Set(ids).size !== ids.length)) throw new Error('拟合需要不同且非空的稳定原子ID；核心选择不会自动改为重原子。');
  const selected = new Set(ids);
  const projected = frames.map(frame => {
    let transform = identity(), diagnostics: ViewSuperpositionDiagnostics | undefined;
    if (reference) {
      const result = superposeViewAtoms({ movingAtoms: frame.structure.atoms.filter(a => selected.has(a.id!)), referenceAtoms: reference.structure.atoms.filter(a => selected.has(a.id!)),
        pairs: ids.map(id => ({ movingAtomId: id, referenceAtomId: id })), mappingConfirmed: true });
      if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join(' '));
      transform = result.transform; diagnostics = result.diagnostics;
    }
    return { ...structuredClone(frame), transform, diagnostics };
  });
  // Frame facts stay on frames. Their deterministic digests make this opaque
  // renderer cache key bounded without dropping any provenance or geometry.
  const frameFingerprint=(frame:MultiframeDisplayFrame)=>sha256Utf8(JSON.stringify([frame.key,frame.identity,frame.structure]));
  const key='multiframe-plan-v1:'+sha256Utf8(JSON.stringify([frames.map(frameFingerprint),fit.kind,reference?frameFingerprint(reference):null,ids,input.generation??null,input.transformRevision??null]));
  const plan: MultiframeDisplayPlan = { generation:input.generation,transformRevision:input.transformRevision,key, sourceKey: sourceKey(frames[0]),
    activeFrameKey: input.activeFrameKey, fitKind: fit.kind, referenceKey: reference?.key, frameCount: frames.length, atomInstances: frames.reduce((n, f) => n + f.structure.atoms.length, 0), frames: projected };
  validateMultiframeDisplayPlan(plan); return freeze(plan);
}
/** Playback changes current frame only; reference and fits remain exactly fixed. */
export function activateMultiframeDisplay(plan: MultiframeDisplayPlan, frameKey: string): MultiframeDisplayPlan {
  if (!plan.frames.some(frame => frame.key === frameKey)) throw new Error('当前帧不在已选叠合范围内。');
  return frameKey === plan.activeFrameKey ? plan : freeze({ ...plan, activeFrameKey: frameKey });
}
export function multiframeDisplayDiagnostics(plan: MultiframeDisplayPlan): string[] {
  const items = plan.frames.filter(frame => frame.diagnostics?.rotationAmbiguous);
  return items.length ? [items.some(frame => frame.diagnostics!.movingRank === 0 || frame.diagnostics!.referenceRank === 0)
    ? '单原子或重合锚点只确定平移，方向不唯一。' : '共线锚点的绕轴方向不唯一，已采用确定的proper旋转。'] : [];
}

export interface MultiframePinOwner {
  ensure(index: number, signal?: AbortSignal, priority?: boolean): Promise<{ structure: Structure; sourceIndex: number }>;
  pin(index: number): void; unpin(index: number): void;
}
/** Owns extra pins only. It never uses a player's single-pin view or releases
 * source ownership; abort/dispose/superseded views unpin exactly once. */
export async function createPinnedMultiframeDisplay(input: { owner: MultiframePinOwner; indices: readonly number[];
  frame(index: number, structure: Structure): MultiframeDisplayFrame; activeFrameKey: string; fit?: MultiframeDisplayFit; signal?: AbortSignal;generation?:number;transformRevision?:string }): Promise<{ plan: MultiframeDisplayPlan; dispose(): void }> {
  if (!input.indices.length || new Set(input.indices).size !== input.indices.length) throw new Error('请选择非空且不同的源帧；未自动抽帧。');
  const pins = new Set<number>(); let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; input.signal?.removeEventListener('abort', dispose); let failure: unknown;
    for (const index of pins) { pins.delete(index); try { input.owner.unpin(index); } catch (error) { failure ??= error; } } if (failure) throw failure; };
  const check = () => { if (disposed || input.signal?.aborted) throw new DOMException('多帧显示准备已取消。', 'AbortError'); };
  input.signal?.addEventListener('abort', dispose, { once: true });
  try {
    const frames: MultiframeDisplayFrame[] = [];
    for (const index of input.indices) {
      check(); if (!Number.isSafeInteger(index) || index < 0) throw new Error('多帧显示源编号无效。');
      const prepared = await input.owner.ensure(index, input.signal, true); check();
      if (prepared.sourceIndex !== index) throw new Error('多帧准备返回了其他源帧。');
      input.owner.pin(index); pins.add(index);
      const frame = input.frame(index, prepared.structure);
      if (frame.identity.sourceFrameIndex !== undefined && frame.identity.sourceFrameIndex !== index) throw new Error('多帧来源编号与实际准备帧不一致。');
      frames.push({ ...frame, identity: { ...frame.identity, sourceFrameIndex: index } });
    }
    const plan = createMultiframeDisplay({ frames, activeFrameKey: input.activeFrameKey, fit: input.fit,generation:input.generation,transformRevision:input.transformRevision }); check(); return { plan, dispose };
  } catch (error) { dispose(); throw error; }
}

type PinnedDisplayInput=Parameters<typeof createPinnedMultiframeDisplay>[0];
interface SharedPinnedDisplay {references:number;controller:AbortController;promise:ReturnType<typeof createPinnedMultiframeDisplay>;ready?:Awaited<ReturnType<typeof createPinnedMultiframeDisplay>>}
const pinnedDisplays=new WeakMap<MultiframePinOwner,Map<string,SharedPinnedDisplay>>();
/** Multiple views of one collection/settings share one fit and pin owner.
 * Active-frame changes are projections of this plan and never enter its key. */
export async function acquirePinnedMultiframeDisplay(input:PinnedDisplayInput&{transformRevision:string}):Promise<Awaited<ReturnType<typeof createPinnedMultiframeDisplay>>>{
 let entries=pinnedDisplays.get(input.owner);if(!entries){entries=new Map();pinnedDisplays.set(input.owner,entries);}
 const key=JSON.stringify([input.indices,input.generation,input.transformRevision]);let entry=entries.get(key);
 if(!entry){const controller=new AbortController();entry={references:0,controller,promise:createPinnedMultiframeDisplay({...input,signal:controller.signal})};entries.set(key,entry);const own=entry;void own.promise.then(value=>{own.ready=value;if(!own.references)value.dispose();},()=>{if(entries!.get(key)===own)entries!.delete(key);});}
 const own=entry;own.references++;let released=false;
 const release=()=>{if(released)return;released=true;input.signal?.removeEventListener('abort',release);if(--own.references===0){own.controller.abort();own.ready?.dispose();if(entries!.get(key)===own)entries!.delete(key);}};
 input.signal?.addEventListener('abort',release,{once:true});if(input.signal?.aborted)release();
 try{const value=await own.promise;if(released)throw new DOMException('叠合视图已释放。','AbortError');return{plan:value.plan,dispose:release};}catch(error){release();throw error;}
}
