import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { analysisProjectCubeArtifacts, isRestoredAnalysisData, markRestoredAnalysisData, notifyAnalysisProjectStateChanged, readAnalysisProjectSnapshot, registerAnalysisProjectSnapshot } from '../../projects/analysis-state';
import { atomicNumber } from '../../core/elements';
import type { DesktopBridge } from '../../modeling/contracts';
import type { OrbitalBackendEvent, OrbitalBackendInfo, OrbitalField, OrbitalGenerationProgress, OrbitalGridSpec, OrbitalPlan, WavefunctionMetadata } from '../../results/orbital-contracts';
import { BOHR_TO_ANGSTROM } from '../../core/orca/assets';
import { MULTIWFN_CONFIGURATION_CHANGED } from './MultiwfnPathControl';
import {traceTrajectoryOperation} from '../../results/trajectory-operations';
import {createMultiwfnProgressTracker,type MultiwfnProgressSnapshot,type MultiwfnProgressIdentity,type MultiwfnProgressBridge} from '../../results/multiwfn-progress';

export type OrbitalBridge = Pick<DesktopBridge, 'orbitalBackendInfo' | 'chooseOrbitalBackend' | 'planOrbitalSession' | 'readOrbitalField' | 'exportOrbitalCube' | 'onOrbitalEvent' | 'orbitalResourceInfo'> & Partial<MultiwfnProgressBridge> & {commandOrbitals?(sessionId:string,request:import('../../results/orbital-contracts').OrbitalCommand,progressIdentity?:MultiwfnProgressIdentity):ReturnType<NonNullable<DesktopBridge['commandOrbitals']>>};
export interface OrbitalSampling { spacingAngstrom: number; paddingAngstrom: number; threads: number; memoryBudgetBytes: number }
export const DEFAULT_ORBITAL_SAMPLING: OrbitalSampling = { spacingAngstrom: .15, paddingAngstrom: 4, threads: 4, memoryBudgetBytes: 4 * 1024 ** 3 };
export const ORBITAL_QUALITY_SPACING = { fast: .25, standard: .15, fine: .1 } as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export function initialOccupiedOrbital(metadata: WavefunctionMetadata): string | null {
  for (const spin of ['alpha', 'restricted', 'beta'] as const) {
    const occupied = metadata.orbitals.filter(row => row.spin === spin && row.occupation !== null && Number.isFinite(row.occupation) && row.occupation > 0);
    if (occupied.length) {
      const energies = occupied.filter(row => row.energy !== null && Number.isFinite(row.energy));
      return energies.length === occupied.length ? energies.reduce((highest, row) => row.energy! > highest.energy! ? row : highest).key : occupied.reduce((highest, row) => row.ordinal > highest.ordinal ? row : highest).key;
    }
  }
  return metadata.orbitals[0]?.key ?? null;
}

/** Display sampling only. The last point covers the requested Å padding;
 * neither spacing nor this finite extent claims wavefunction-tail convergence. */
export function orbitalGridFor(metadata: WavefunctionMetadata, options: OrbitalSampling): OrbitalGridSpec {
  const { spacingAngstrom: spacing, paddingAngstrom: padding, threads, memoryBudgetBytes: budget } = options;
  assert(Number.isFinite(spacing) && spacing > 0 && Number.isFinite(padding) && padding > 0, '采样间距和边界留白须为正有限数。');
  assert(Number.isSafeInteger(threads) && threads >= 1 && threads <= 2147483647, '线程须为有效的正整数。');
  assert(Number.isSafeInteger(budget) && budget > 0, '内存预算须为有效的正整数。');
  const atoms = metadata.structure.atoms;
  assert(atoms.length && atoms.every(atom => [atom.x, atom.y, atom.z].every(Number.isFinite)), '波函数缺少可用的有限原子坐标。');
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for(const atom of atoms)for(const [index,value] of [atom.x,atom.y,atom.z].entries()){minimum[index]=Math.min(minimum[index],value);maximum[index]=Math.max(maximum[index],value);}
  const dimensions = maximum.map((max, i) => Math.max(2, Math.ceil((max - minimum[i] + 2 * padding) / spacing) + 1)) as [number, number, number];
  assert(dimensions.every(Number.isSafeInteger) && Number.isSafeInteger(dimensions.reduce((a, b) => a * b, 1)*8), '网格点数超过整数表示范围；未更改间距或边界留白。');
  const step = spacing / BOHR_TO_ANGSTROM;
  return { coordinateUnit: 'bohr', ordering: 'z-fastest', origin: minimum.map(n => (n - padding) / BOHR_TO_ANGSTROM) as [number, number, number], axes: [[step, 0, 0], [0, step, 0], [0, 0, step]], dimensions };
}

export interface OrbitalSessionState {
  attempted: boolean; planning: boolean; backend: OrbitalBackendInfo | null; plan: OrbitalPlan | null;
  grid: OrbitalGridSpec | null; sampling: OrbitalSampling; progress: OrbitalGenerationProgress | null; error: string;
  taskProgress?:MultiwfnProgressSnapshot|null;
}
export function createOrbitalSessionController(bridge: OrbitalBridge, metadata: WavefunctionMetadata, sessionId: string) {
  let state: OrbitalSessionState = { attempted: false, planning: false, backend: null, plan: null, grid: null, sampling: { ...DEFAULT_ORBITAL_SAMPLING }, progress: null, error: '' };
  let restoredOnly = false;
  let sequence = -1, epoch = 0, starting = false, stopRequested = false, generating = false, priorityPreference: string | null = null, initializedSignature = '', nativeOff: (() => void) | undefined;
  let selectionSerial = 0, selectionKey: string | null = null, selectionSignature = '', selectionOwner: object | undefined;
  let selectionQueue: Promise<void> = Promise.resolve();
  let task:ReturnType<typeof createMultiwfnProgressTracker>|null=null,taskKey:string|null=null,progressOff:(()=>void)|undefined;
  const listeners = new Set<() => void>(), keys = new Set(metadata.orbitals.map(row => row.key));
  const update = (patch: Partial<OrbitalSessionState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const busy = () => state.planning || ['running', 'queued'].includes(state.progress?.status ?? '');
  function beginProgress(key:string|null){if(!bridge.onMultiwfnProgress)return null;taskKey=key;task=createMultiwfnProgressTracker({ownerId:sessionId,analysisId:sessionId,sessionId,runId:crypto.randomUUID(),sourceId:metadata.sourceId,sourceRevision:metadata.sourceRevision,operation:key?'orbital:'+key:'orbitals'},snapshot=>update({taskProgress:snapshot}));return task;}
  function accept(event: OrbitalBackendEvent, reply = false) {
    if (!state.plan || event.sessionId !== sessionId || event.sourceRevision !== metadata.sourceRevision || event.gridKey !== state.plan.gridKey || !Number.isSafeInteger(event.seq) || event.seq < sequence || !reply && event.seq === sequence) return;
    if (!['idle', 'queued', 'running', 'stopped', 'completed', 'failed'].includes(event.status) || !Array.isArray(event.completedKeys) || event.completedKeys.some(key => !keys.has(key)) || event.total !== keys.size) return;
    if (state.plan.mode === 'selected' && (!selectionKey && ['queued', 'running'].includes(event.status) || event.requestedKeys?.some(key => key !== selectionKey))) return;
    if (reply && event.seq === sequence && ['completed', 'failed'].includes(state.progress?.status ?? '') && ['queued', 'running'].includes(event.status)) return;
    if (reply && stopRequested && event.status === 'queued') return;
    const newFields = event.completedKeys.some(key => !state.progress?.completedKeys.includes(key));
    sequence = event.seq;
    update({ progress: event, ...(event.event === 'error' ? { error: event.message || '轨道生成失败。' } : {}) });
    if (newFields) notifyAnalysisProjectStateChanged();
  }
  async function command(operation: 'generate' | 'continue' | 'prioritize' | 'stop' | 'status', priorityKey?: string) {
    assert(bridge.commandOrbitals, '此环境没有 native 轨道命令入口。');
    if (priorityKey) assert(keys.has(priorityKey), '轨道不属于当前波函数。');
    const currentEpoch = epoch;
    const progress=operation==='generate'||operation==='continue'?beginProgress(priorityKey??null):null;if(operation==='stop')task?.stopping();
    const request={operation,...(priorityKey?{priorityKeys:[priorityKey]}:{})};
    const invoke=()=>progress?bridge.commandOrbitals!(sessionId,request,progress.identity):bridge.commandOrbitals!(sessionId,request);
    const result = await (operation==='generate'||operation==='continue'?traceTrajectoryOperation('orbital',{sourceId:metadata.sourceId,sourceRevision:metadata.sourceRevision},invoke):invoke());
    if (currentEpoch === epoch && result && typeof result === 'object') accept(result as OrbitalBackendEvent, true);
  }
  return {
    getSnapshot: () => state,
    isBusy:()=>starting||generating||busy(),
    async captureProjectFields(): Promise<OrbitalProjectCache[]> {
      const snapshot = structuredClone(state);
      if (!snapshot.grid || !snapshot.plan || !snapshot.progress?.completedKeys.length) return [];
      const fields: OrbitalField[] = [];
      for (const key of snapshot.progress.completedKeys) {
        const restored = restoredOrbitalField(metadata, snapshot.grid, key);
        const lease = restored ? null : acquireOrbitalField(bridge, sessionId, metadata.sourceRevision, snapshot.plan.gridKey, key, snapshot.grid);
        try { fields.push(structuredClone(restored ?? await lease!.promise)); } finally { lease?.release(); }
      }
      return [{ sampling: snapshot.sampling, grid: snapshot.grid, fields: fields.map(({ sessionId: _native, ...field }) => field) }];
    },
    restoreProjectFields(cache: OrbitalProjectCache) {
      if (state.attempted || !cache.fields.length) return;
      for (const field of cache.fields) assert(field.sourceRevision === metadata.sourceRevision && keys.has(field.orbitalKey), '项目轨道格点来源或轨道身份不符。');
      const field = cache.fields[0], size = cache.fields.reduce((bytes, entry) => bytes + entry.values.byteLength, 0);
      restoredOnly = true;
      update({ attempted: true, planning: false, backend: null, grid: cache.grid, sampling: cache.sampling,
        plan: { gridKey: field.gridKey, pointCount: field.values.length, orbitalCount: keys.size, cacheBytes: size, workingBytes: 0, totalBytes: size, withinBudget: true, mode: 'selected' },
        progress: { sessionId, sourceRevision: metadata.sourceRevision, gridKey: field.gridKey, completedKeys: cache.fields.map(entry => entry.orbitalKey), total: keys.size, currentKey: null, status: 'completed', cacheBytes: size, mode: 'selected' }, error: '' });
    },
    dispose() { epoch++; selectionSerial++; nativeOff?.(); nativeOff=undefined;progressOff?.();progressOff=undefined; listeners.clear(); },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if(!progressOff&&bridge.onMultiwfnProgress)progressOff=bridge.onMultiwfnProgress(snapshot=>task?.receive(snapshot));
      if (!nativeOff && bridge.onOrbitalEvent) {
        nativeOff = bridge.onOrbitalEvent(event => accept(event));
        if (state.plan?.withinBudget && !restoredOnly) void command('status').catch(error => update({ error: errorText(error) }));
      }
      return () => { listeners.delete(listener); if (!listeners.size) { nativeOff?.(); nativeOff = undefined;progressOff?.();progressOff=undefined; } };
    },
    async backendInfo(choose = false) {
      const operation = choose ? bridge.chooseOrbitalBackend : bridge.orbitalBackendInfo;
      assert(operation, '此环境没有 native 轨道后端配置入口。');
      const backend = await operation(); assert(typeof backend.configured === 'boolean', '轨道后端配置回执无效。'); update({ backend }); return backend;
    },
    select(sampling: OrbitalSampling, key: string, owner?: object) {
      assert(keys.has(key), '轨道不属于当前波函数。');
      const serial = ++selectionSerial; selectionKey = key; selectionOwner = owner;
      const run = async () => {
        if (serial !== selectionSerial) return;
        const current = () => serial === selectionSerial;
        try {
          const grid = orbitalGridFor(metadata, sampling), signature = JSON.stringify([grid, sampling.threads, sampling.memoryBudgetBytes]);
          if (restoredOnly) {
            const restored = orbitalProjectCaches.get(orbitalProjectKey(metadata))?.caches.find(cache => JSON.stringify(cache.grid) === JSON.stringify(grid) && cache.fields.some(field => field.orbitalKey === key));
            if (restored) { update({ attempted: false }); this.restoreProjectFields(restored); return; }
            restoredOnly = false; update({ plan: null, progress: null, grid: null });
          }
          assert(bridge.planOrbitalSession && bridge.commandOrbitals && bridge.readOrbitalField && bridge.onOrbitalEvent, '当前浏览器没有 native 轨道格点功能。');
          if (selectionSignature === signature && state.plan?.mode === 'selected' && state.plan.withinBudget && state.progress?.completedKeys.includes(key)) {
            update({ planning: false, error: '' }); return;
          }
          const backend = state.backend ?? await this.backendInfo();
          if (!current()) return;
          assert(backend.configured, backend.message || '请先选择已安装的本机 Multiwfn。');
          update({ attempted: true, planning: true, error: '' });
          if (selectionSignature !== signature || state.plan?.mode !== 'selected' || !state.plan.withinBudget) {
            if (state.plan) { await command('stop'); if (!current()) return; }
            selectionSignature = '';
            const plan = await bridge.planOrbitalSession(sessionId, { mode: 'selected', grid, threads: sampling.threads, memoryBudgetBytes: sampling.memoryBudgetBytes });
            if (!current()) return;
            assert(plan.mode === 'selected' && plan.gridKey && plan.pointCount === grid.dimensions.reduce((a, b) => a * b, 1) && plan.orbitalCount === keys.size && [plan.cacheBytes, plan.workingBytes, plan.totalBytes].every(n => Number.isSafeInteger(n) && n >= 0) && plan.totalBytes >= plan.cacheBytes && plan.totalBytes >= plan.workingBytes, '单轨道内存计划回执无效。');
            const accepted = { ...plan, withinBudget: plan.withinBudget === true && plan.totalBytes <= sampling.memoryBudgetBytes };
            sequence = -1; update({ plan: accepted, grid, progress: null, sampling: { ...sampling } });
            if (!accepted.withinBudget) { update({ error: '总内存估计超过预算，请调整网格或预算；未启动生成。' }); return; }
            selectionSignature = signature;
          }
          if (!current()) return;
          stopRequested = false;
          update({ progress: { sessionId, sourceRevision: metadata.sourceRevision, gridKey: state.plan!.gridKey, mode: 'selected', requestedKeys: [key], status: 'queued', completedKeys: state.progress?.completedKeys ?? [], total: keys.size, currentKey: key, cacheBytes: state.progress?.cacheBytes ?? 0 } });
          // Do not hold the planning queue behind an IPC acknowledgement. A later
          // selection must be able to cancel this native request immediately.
          const progress=beginProgress(key),request={operation:'generate-one' as const,orbitalKey:key};
          void traceTrajectoryOperation('orbital',{sourceId:metadata.sourceId,sourceRevision:metadata.sourceRevision},()=>progress?bridge.commandOrbitals!(sessionId,request,progress.identity):bridge.commandOrbitals!(sessionId,request)).then(result => {
            if (current() && result && typeof result === 'object') accept(result as OrbitalBackendEvent, true);
          }, error => { if (current()) update({ error: errorText(error), progress: state.progress ? { ...state.progress, status: 'failed' } : null }); });
        } catch (error) { if (current()) { if (state.plan && busy()) await command('stop').catch(() => {}); if (current()) { update({ error: errorText(error) }); throw error; } } }
        finally { if (current()) update({ planning: false }); }
      };
      const pending = selectionQueue.then(run);
      selectionQueue = pending.catch(() => {});
      return pending;
    },
    async cancelSelection(owner?: object) {
      if (owner && selectionOwner !== owner) return;
      const serial = ++selectionSerial; selectionKey = null; epoch++;
      selectionOwner = undefined;
      update({ planning: false });
      if (!state.plan || !busy()) return;
      stopRequested = true;
      await command('stop');
      if (serial === selectionSerial && state.progress) update({ progress: { ...state.progress, status: 'stopped' } });
    },
    async start(sampling: OrbitalSampling, priorityKey: string | null, explicit = false) {
      if (busy() || starting) return;
      if (!explicit && state.attempted) return;
      const grid = orbitalGridFor(metadata, sampling), signature = JSON.stringify([grid, sampling.threads, sampling.memoryBudgetBytes]);
      if (initializedSignature === signature && state.plan?.withinBudget && !(explicit && state.progress?.status === 'failed')) return;
      assert(bridge.planOrbitalSession && bridge.commandOrbitals && bridge.readOrbitalField && bridge.onOrbitalEvent, '当前浏览器没有 native 轨道格点功能。');
      starting = true;
      try {
      const backend = state.backend ?? await this.backendInfo();
      assert(backend.configured, backend.message || '请先选择已安装的本机 Multiwfn。');
      if (priorityKey) assert(keys.has(priorityKey), '轨道不属于当前波函数。');
      const currentEpoch = ++epoch; stopRequested = false; priorityPreference = priorityKey; update({ attempted: true, planning: true, error: '', sampling: { ...sampling } });
      try {
        const plan = await bridge.planOrbitalSession(sessionId, { grid, threads: sampling.threads, memoryBudgetBytes: sampling.memoryBudgetBytes });
        if (currentEpoch !== epoch) return;
        assert(plan.gridKey && Number.isSafeInteger(plan.pointCount) && plan.pointCount === grid.dimensions.reduce((a, b) => a * b, 1) && plan.orbitalCount === keys.size && [plan.cacheBytes, plan.workingBytes, plan.totalBytes].every(n => Number.isSafeInteger(n) && n >= 0), '轨道内存计划回执无效。');
        assert(plan.totalBytes >= plan.cacheBytes && plan.totalBytes >= plan.workingBytes, '轨道总内存估计无效。');
        const acceptedPlan = { ...plan, withinBudget: plan.withinBudget === true && plan.totalBytes <= sampling.memoryBudgetBytes };
        sequence = -1; update({ plan: acceptedPlan, grid, progress: null });
        if (!acceptedPlan.withinBudget) { update({ error: '总内存估计超过预算，请调整网格或预算，或取消；未启动生成。' }); return; }
        initializedSignature = signature;
        update({ progress: { sessionId, sourceRevision: metadata.sourceRevision, gridKey: plan.gridKey, status: stopRequested ? 'stopped' : 'queued', completedKeys: [], total: keys.size, currentKey: null, cacheBytes: 0 } });
        if (!stopRequested) { generating = true; await command('generate', priorityPreference ?? undefined); }
      } catch (error) { update({ error: errorText(error),progress:state.progress?{...state.progress,status:'failed',completedKeys:[],cacheBytes:0}:null }); throw error; }
      finally { generating = false; if (currentEpoch === epoch) update({ planning: false }); }
      } finally { starting = false; }
    },
    async stop() {
      stopRequested = true;
      if (state.planning && !generating) return;
      if (!state.plan?.withinBudget || !busy()) return;
      await command('stop');
      if (state.progress?.status !== 'completed') update({ progress: state.progress ? { ...state.progress, status: 'stopped' } : null });
    },
    async continue(priorityKey: string | null) {
      assert(!state.planning && state.plan?.withinBudget && state.progress?.status === 'stopped', '只有已停止的轨道会话可以显式继续。');
      stopRequested = false; priorityPreference = priorityKey;
      update({ error: '', progress: { ...state.progress, status: 'queued' } }); await command('continue', priorityKey ?? undefined);
    },
    async prioritize(key: string) { assert(keys.has(key), '轨道不属于当前波函数。'); priorityPreference = key; if (!state.planning && state.plan?.withinBudget && busy()) await command('prioritize', key); },
    acceptField(field:OrbitalField){if(task&&field.sessionId===sessionId&&field.sourceRevision===metadata.sourceRevision&&field.gridKey===state.plan?.gridKey&&(!taskKey||field.orbitalKey===taskKey))task.committed();},
  };
}
export type OrbitalSessionController = ReturnType<typeof createOrbitalSessionController>;
export interface OrbitalProjectCache { sampling: OrbitalSampling; grid: OrbitalGridSpec; fields: Omit<OrbitalField, 'sessionId'>[] }
const orbitalProjectKey = (metadata: WavefunctionMetadata) => `orbital-fields:${JSON.stringify([metadata.sourceId, metadata.sourceRevision])}`;
const orbitalProjectCaches = new Map<string, { caches: OrbitalProjectCache[]; controllers: Map<OrbitalSessionController, OrbitalSampling>; unregister: () => void }>();
function restoredOrbitalField(metadata: WavefunctionMetadata, grid: OrbitalGridSpec, key: string): OrbitalField | null {
  const cached = orbitalProjectCaches.get(orbitalProjectKey(metadata))?.caches.find(cache => JSON.stringify(cache.grid) === JSON.stringify(grid))?.fields.find(field => field.orbitalKey === key);
  return cached ? { ...cached, sessionId: '' } : null;
}
export function projectOrbitalCubeArtifacts(field: OrbitalField, metadata: WavefunctionMetadata) {
  if (field.sourceRevision !== metadata.sourceRevision || !metadata.orbitals.some(orbital => orbital.key === field.orbitalKey)) throw new Error('轨道格点与原始波函数身份不符。');
  return analysisProjectCubeArtifacts({ ...field, atoms: metadata.structure.atoms.map((atom, index) => ({ sourceIndex: index + 1, atomicNumber: atomicNumber(atom.element), nuclearCharge: atomicNumber(atom.element), position: [atom.x / BOHR_TO_ANGSTROM, atom.y / BOHR_TO_ANGSTROM, atom.z / BOHR_TO_ANGSTROM] })), validDomain: { kind: 'full-grid', evidence: '完整已生成轨道网格；不代表有限盒外的波函数尾部。' } }, metadata.name + ' ' + field.orbitalKey);
}
function registerOrbitalProjectController(metadata: WavefunctionMetadata, controller: OrbitalSessionController, sampling: OrbitalSampling) {
  const key = orbitalProjectKey(metadata);
  let owner = orbitalProjectCaches.get(key);
  if (!owner) {
    owner = { caches: readAnalysisProjectSnapshot<OrbitalProjectCache[]>(key) ?? [], controllers: new Map(), unregister: () => {} };
    const node = owner;
    node.unregister = registerAnalysisProjectSnapshot(key, {
      citationMetadata:()=>({sourceId:metadata.sourceId,sourceRevision:metadata.sourceRevision,completed:[...node.controllers.keys()].map(current=>current.getSnapshot().progress?.completedKeys??[])}),
      async capture() {
        const caches = [...node.caches];
        for (const current of node.controllers.keys()) for (const cache of await current.captureProjectFields()) {
          const previous = caches.find(entry => JSON.stringify(entry.grid) === JSON.stringify(cache.grid));
          if (!previous) caches.push(cache);
          else { const fields = new Map(previous.fields.map(field => [field.orbitalKey, field])); for (const field of cache.fields) fields.set(field.orbitalKey, field); previous.fields = [...fields.values()]; }
        }
        node.caches = caches; return caches;
      },
      restore(value) { node.caches = value as OrbitalProjectCache[]; for (const [current, targetSampling] of node.controllers) { const cache = node.caches.find(cache => JSON.stringify(cache.grid) === JSON.stringify(orbitalGridFor(metadata, targetSampling))); if (cache) current.restoreProjectFields(cache); } },
    });
    orbitalProjectCaches.set(key, node);
  }
  owner.controllers.set(controller, sampling);
  const saved = owner.caches.find(cache => JSON.stringify(cache.grid) === JSON.stringify(orbitalGridFor(metadata, sampling)));
  if (saved) controller.restoreProjectFields(saved);
  return () => { owner!.controllers.delete(controller); if (!owner!.controllers.size) { owner!.unregister(); orbitalProjectCaches.delete(key); } };
}
const sessions = new WeakMap<OrbitalBridge, Map<string, OrbitalSessionController>>();
export function orbitalSessionController(bridge: OrbitalBridge, metadata: WavefunctionMetadata, sessionId: string): OrbitalSessionController {
  let group = sessions.get(bridge); if (!group) { group = new Map(); sessions.set(bridge, group); }
  const identity = JSON.stringify([sessionId, metadata.sourceId, metadata.sourceRevision]);
  let controller = group.get(identity); if (!controller) { controller = createOrbitalSessionController(bridge, metadata, sessionId); group.set(identity, controller); }
  return controller;
}

type FieldEntry = { refs: number; promise: Promise<OrbitalField>; field?: OrbitalField; used: number };
const reads = new WeakMap<OrbitalBridge, Map<string, FieldEntry>>();
const pendingOrbitalReads=new WeakMap<OrbitalBridge,Map<string,Set<Promise<OrbitalField>>>>();
/** Source/session owners use this synchronous query before discarding a page.
 * It includes cached-controller work and outstanding reads after view release. */
export function assertOrbitalSourcesIdle(bridge:OrbitalBridge,sourceIds:readonly string[]=[],sessionIds:readonly string[]=[]):void{
  const sources=new Set(sourceIds),selected=new Set(sessionIds);
  for(const [key,controller]of sessions.get(bridge)??[]){const [sessionId,sourceId]=JSON.parse(key) as string[];if(!selected.has(sessionId)&&!sources.has(sourceId))continue;selected.add(sessionId);if(controller.isBusy())throw Error('轨道来源仍在计算或准备，请先停止并等待实际结束。');}
  for(const id of selected)if(pendingOrbitalReads.get(bridge)?.get(id)?.size)throw Error('轨道来源仍在读取格点，请等待读取结束后丢弃。');
}
/** Included in the host's per-view renderer reserve. Never precompute an
 * unselected orbital; retain only immutable, already accepted read results. */
export const ORBITAL_READ_CACHE_BYTES = 32 * 1024 ** 2;
let readClock = 0;
function trimOrbitalReads(group: Map<string, FieldEntry>) {
  const idle = [...group].filter(([,entry]) => entry.refs === 0 && entry.field).sort((a,b)=>b[1].used-a[1].used);
  const perSession = new Map<string,number>(); let bytes = 0;
  for (const [key,entry] of idle) {
    const session = JSON.parse(key)[0] as string, count = perSession.get(session) ?? 0, size = entry.field!.values.byteLength;
    if (count >= 2 || bytes + size > ORBITAL_READ_CACHE_BYTES) group.delete(key);
    else { bytes += size; perSession.set(session,count+1); }
  }
}
/** Called only by the source/session owner after close, never by a view. */
export function releaseOrbitalSession(bridge:OrbitalBridge,sessionId:string):void {
  const group=sessions.get(bridge);if(group)for(const [key,controller] of group)if(JSON.parse(key)[0]===sessionId){controller.dispose();group.delete(key);}
  const fields=reads.get(bridge);if(fields)for(const key of fields.keys())if(JSON.parse(key)[0]===sessionId)fields.delete(key);
}
/** Active reads are shared; a bounded two-orbital hot set avoids repeated
 * native encoding and IPC when revisiting a recently displayed orbital. */
export function acquireOrbitalField(bridge: OrbitalBridge, sessionId: string, sourceRevision: string, gridKey: string, orbitalKey: string, grid: OrbitalGridSpec) {
  assert(bridge.readOrbitalField, '此环境没有 native 轨道格点读取入口。');
  let group = reads.get(bridge); if (!group) { group = new Map(); reads.set(bridge, group); }
  const key = JSON.stringify([sessionId, sourceRevision, gridKey, orbitalKey]);
  let entry = group.get(key);
  if (!entry) {
    const promise = Promise.resolve().then(() => bridge.readOrbitalField!(sessionId, orbitalKey)).then(field => {
      assert(field.sessionId === sessionId && field.sourceRevision === sourceRevision && field.gridKey === gridKey && field.orbitalKey === orbitalKey, '轨道格点身份或网格已变化。');
      assert(field.values instanceof Float64Array && field.values.length === grid.dimensions.reduce((a, b) => a * b, 1) && field.values.every(Number.isFinite) && field.valueUnit === 'bohr^-3/2' && JSON.stringify(field.grid) === JSON.stringify(grid), '轨道格点数值、单位或网格不匹配。');
      return field;
    });
    entry = { refs: 0, promise, used: ++readClock }; group.set(key, entry);
    let pending=pendingOrbitalReads.get(bridge);if(!pending){pending=new Map();pendingOrbitalReads.set(bridge,pending);}const active=pending.get(sessionId)??new Set<Promise<OrbitalField>>();active.add(promise);pending.set(sessionId,active);
    const settled=()=>{active.delete(promise);if(!active.size)pending!.delete(sessionId);};void promise.then(settled,settled);
    const pendingEntry = entry;
    void promise.then(field => { if (group!.get(key) === pendingEntry) { pendingEntry.field=field; trimOrbitalReads(group!); } },()=>{if(group!.get(key)===pendingEntry)group!.delete(key);});
  }
  const own = entry; own.refs++; own.used=++readClock; let released = false;
  return { promise: own.promise, release() { if (released) return; released = true; if (--own.refs === 0 && group!.get(key) === own) { if (!own.field) group!.delete(key); else trimOrbitalReads(group!); } } };
}

export function createOrbitalFieldReader(publish: (field: OrbitalField | null) => void, report: (error: string) => void) {
  let serial = 0, lease: ReturnType<typeof acquireOrbitalField> | null = null;
  function clear() { serial++; lease?.release(); lease = null; publish(null); }
  return {
    clear,
    read(bridge: OrbitalBridge, sessionId: string, sourceRevision: string, gridKey: string, orbitalKey: string, grid: OrbitalGridSpec) {
      clear(); const current = serial;
      lease = acquireOrbitalField(bridge, sessionId, sourceRevision, gridKey, orbitalKey, grid);
      return lease.promise.then(field => { if (current === serial) publish(field); }, error => { if (current === serial) report(errorText(error)); });
    },
  };
}

const noSubscribe = () => () => {};
const emptyState: OrbitalSessionState = { attempted: false, planning: false, backend: null, plan: null, grid: null, sampling: DEFAULT_ORBITAL_SAMPLING, progress: null, error: '' };
/** A fresh computeIntent belongs to one explicit user action. Visibility and
 * restored selection only read existing native cache; inactive intents expire. */
export function useOrbitalField(options: { bridge: OrbitalBridge | null; metadata: WavefunctionMetadata | null; sessionId: string | null; selectedKey: string | null; active: boolean; cancelOnInactive?: boolean; computeIntent?: object | null; sampling?: OrbitalSampling; onError(message: string): void }) {
  const { bridge, metadata, sessionId, selectedKey, active, cancelOnInactive = true, computeIntent = null, onError, sampling = DEFAULT_ORBITAL_SAMPLING } = options;
  const errorCallback = useRef(onError); errorCallback.current = onError;
  const controller = useMemo(() => bridge && metadata && sessionId ? orbitalSessionController(bridge, metadata, sessionId) : null, [bridge, metadata?.sourceId, metadata?.sourceRevision, sessionId]);
  useEffect(() => controller && metadata ? registerOrbitalProjectController(metadata, controller, sampling) : undefined, [controller, metadata?.sourceId, metadata?.sourceRevision]);
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscribe, controller?.getSnapshot ?? (() => emptyState), () => emptyState);
  const samplingSignature = JSON.stringify(sampling);
  const ownsSelection = useRef<OrbitalSessionController | null>(null);
  const selectionOwner = useRef({});
  const consumedIntents = useRef(new WeakSet<object>());
  useEffect(() => {
    const explicit = computeIntent !== null && !consumedIntents.current.has(computeIntent);
    if (computeIntent) consumedIntents.current.add(computeIntent);
    if (!controller) return;
    if (explicit && active && selectedKey) {
      ownsSelection.current = controller;
      void controller.select(sampling, selectedKey, selectionOwner.current).catch(error => errorCallback.current(errorText(error)));
    } else if ((!selectedKey || !active && cancelOnInactive) && ownsSelection.current === controller) {
      ownsSelection.current = null;
      void controller.cancelSelection(selectionOwner.current).catch(error => errorCallback.current(errorText(error)));
    }
  }, [controller, active, cancelOnInactive, selectedKey, samplingSignature, computeIntent]);
  useEffect(() => () => { if (controller && ownsSelection.current === controller) { ownsSelection.current = null; void controller.cancelSelection(selectionOwner.current).catch(() => {}); } }, [controller]);
  useEffect(() => {
    if (!controller || typeof window === 'undefined') return;
    const changed = () => { void controller.backendInfo().catch(error => errorCallback.current(errorText(error))); };
    window.addEventListener(MULTIWFN_CONFIGURATION_CHANGED, changed);
    return () => window.removeEventListener(MULTIWFN_CONFIGURATION_CHANGED, changed);
  }, [controller]);
  const [field, setField] = useState<OrbitalField | null>(null);
  const reader = useMemo(() => createOrbitalFieldReader(setField, error => errorCallback.current(error)), []);
  const complete = Boolean(selectedKey && state.sampling.spacingAngstrom === sampling.spacingAngstrom && state.sampling.paddingAngstrom === sampling.paddingAngstrom && state.progress?.completedKeys.includes(selectedKey));
  useEffect(() => {
    reader.clear();
    if (!active || !bridge || !metadata || !sessionId || !selectedKey || !complete || !state.plan?.withinBudget || !state.grid) return;
    const restored = restoredOrbitalField(metadata, state.grid, selectedKey);
    if (restored) { const field={...restored,sessionId};setField(isRestoredAnalysisData(restored.values)?markRestoredAnalysisData(field):field); return () => reader.clear(); }
    void reader.read(bridge, sessionId, metadata.sourceRevision, state.plan.gridKey, selectedKey, state.grid);
    return () => reader.clear();
  }, [active, bridge, metadata?.sourceRevision, sessionId, selectedKey, complete, state.plan?.gridKey, state.grid]);
  const current = active && complete && field?.sessionId === sessionId && field?.sourceRevision === metadata?.sourceRevision && field?.gridKey === state.plan?.gridKey && field?.orbitalKey === selectedKey ? field : null;
  useEffect(()=>{if(current)controller?.acceptField(current);},[controller,current]);
  return { controller, state, field: current };
}
