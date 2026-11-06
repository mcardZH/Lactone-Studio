import type { ModelDocument, ModelStore } from '../contracts';
import type { WorkspaceCommand, WorkspaceDesktopBridge, WorkspaceDocumentEvent, WorkspaceDocumentSnapshot, WorkspaceMembership } from '../workspace-contracts';
import { modelCoordinateKey, validateGaussianBoundCoordinates, validateSharedConstraints } from '../constraints';
import { validateBondOrderEvidence } from '../bond-orders';
import { validateCoordinates } from '../../core/modeling/model-document-validation';
import { validateStructureLibraryProvenance } from '../../core/structure-library-provenance';
import { copyWorkspaceSnapshotJSON, copyWorkspaceCommandJSON } from '../../../desktop/workspace-snapshot-codec.mjs';

const schema = 'sciyue-workspace-document';
const commandTypes = new Set(['model.execute', 'model.select', 'model.undo', 'model.redo', 'model.context', 'model.electronic-state', 'chemistry.start', 'chemistry.cancel', 'dynamics.start', 'dynamics.command', 'input.draft-update', 'workspace.close-view', 'workspace.viewport-event']);
const maxBytes = 16 * 1024 * 1024;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && /^[a-zA-Z0-9_.:-]+$/.test(value);
const serial = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Save carries no picked geometry or scientific mutation. The fixed document
 * membership identifies its owner; the normal save guard captures that owner's
 * current snapshot. Every other viewport command remains revision-bound. */
export function isCurrentDocumentSaveIntent(command:unknown):boolean {
  return plain(command)&&Object.keys(command).length===2&&command.type==='workspace.viewport-event'
    &&plain(command.event)&&Object.keys(command.event).length===1&&command.event.type==='save';
}
export class WorkspaceClosePendingError extends Error {
  constructor() { super('正在确认关闭模型，请先完成关闭确认。'); this.name = 'WorkspaceClosePendingError'; }
}
export function isWorkspaceClosePendingError(error: unknown): boolean {
  return error instanceof WorkspaceClosePendingError || /\bWORKSPACE_CLOSING:/.test(errorMessage(error));
}

/** Omit only optional object undefined values; never turn nonfinite data/functions
 * into JSON null or execute getters/toJSON. No runtime or OS API is used. */
export function normalizeWorkspaceJSON<T>(value: T, maximum = maxBytes): T {
  let nodes = 0;
  const visit = (item: unknown, depth: number, inArray = false): void => {
    requireValue(depth <= 64 && ++nodes <= 250000, '共享文档 JSON 复杂度超过上限。');
    if (item === undefined && !inArray) return;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') { requireValue(Number.isFinite(item), '共享文档数值必须有限。'); return; }
    requireValue(Array.isArray(item) || plain(item), '共享文档只能传输普通 JSON。');
    if (Array.isArray(item)) requireValue(Object.keys(item).length === item.length && Object.keys(item).every(key => /^(0|[1-9]\d*)$/.test(key)), '共享文档不能传输稀疏或附加属性数组。');
    for (const key of Object.keys(item)) {
      requireValue(!['__proto__', 'constructor', 'prototype'].includes(key), '共享文档包含不安全 JSON 字段。');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      requireValue(descriptor && 'value' in descriptor, '共享文档不能传输访问器。');
      visit(descriptor.value, depth + 1, Array.isArray(item));
    }
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  requireValue(typeof text === 'string' && new TextEncoder().encode(text).byteLength <= maximum, '共享文档传输字节超过上限。');
  return JSON.parse(text) as T;
}
/** These fixed-shape data routes never apply to arbitrary JSON. Authored
 * snapshots have no aggregate byte/node ceiling; record validity still applies. */
export const normalizeWorkspaceViewportJSON = <T>(value: T): T => copyWorkspaceSnapshotJSON(value, 'viewport');
export const normalizeWorkspaceDocumentJSON = <T>(value: T): T => copyWorkspaceSnapshotJSON(value, 'document');
export const normalizeViewportDisplayMetadataJSON = <T>(value: T): T => copyWorkspaceSnapshotJSON(value, 'display-metadata');
const snapshotJSON = <T>(value: T): T => copyWorkspaceSnapshotJSON(value, 'snapshot');
const envelopeJSON = <T>(value: T): T => copyWorkspaceSnapshotJSON(value, 'envelope');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function checkedSnapshot(raw: WorkspaceDocumentSnapshot, documentId: string, epoch?: string): WorkspaceDocumentSnapshot {
  const value = snapshotJSON(raw);
  requireValue(plain(value) && value.schema === schema && value.version === 1 && identity(value.documentEpoch) && serial(value.publicationSerial), '共享文档快照协议不匹配。');
  requireValue(!epoch || value.documentEpoch === epoch, '共享文档生命周期已变化。');
  requireValue(plain(value.document) && value.document.id === documentId && serial(value.document.revision) && plain(value.document.draft) && plain(value.document.draft.structure), '共享文档身份或修订不匹配。');
  requireValue(Array.isArray(value.document.draft.past) && value.document.draft.past.length === 0 && Array.isArray(value.document.draft.future) && value.document.draft.future.length === 0, '共享文档不能复制权威 Undo 历史。');
  requireValue(Array.isArray(value.document.draft.structure.atoms) && plain(value.document.draft.assignments) && plain(value.document.selection) && typeof value.document.canUndo === 'boolean' && typeof value.document.canRedo === 'boolean', '共享文档模型快照不完整。');
  const document = value.document, objects = document.coordinateObjects === undefined ? [] : document.coordinateObjects, shared = document.sharedConstraints === undefined ? { frozenAtomIds: [], coordinates: [] } : document.sharedConstraints;
  if(document.draft.structure.libraryProvenance!==undefined)validateStructureLibraryProvenance(document.draft.structure.libraryProvenance);
  if(document.bondOrderObservation!==undefined){
    const observation=document.bondOrderObservation;validateBondOrderEvidence(observation,document.draft.structure);
    requireValue(plain(observation)&&typeof observation.runId==='string'&&observation.runId.length>0&&observation.runId.length<=100&&observation.engine===(observation.sourceField==='tblite:bond-orders'?'tblite':'xtb')&&typeof observation.version==='string'&&observation.version.length>0&&observation.method==='gfn2'&&['optimize','singlepoint'].includes(observation.calculation)&&(observation.sourceField!=='tblite:bond-orders'||observation.calculation==='singlepoint')&&Number.isSafeInteger(observation.charge)&&Number.isSafeInteger(observation.uhf)&&observation.uhf>=0,'共享文档MBO来源无效。');
  }
  requireValue(Array.isArray(objects) && objects.every(object => plain(object) && Object.keys(object).every(key => ['id', 'type', 'atomIds', 'images'].includes(key))), '共享文档BAD对象格式无效。');
  requireValue(plain(shared) && Object.keys(shared).every(key => ['frozenAtomIds', 'coordinates', 'canonical','enabled'].includes(key)) && (shared.canonical===undefined||shared.canonical===true) && (shared.enabled===undefined||typeof shared.enabled==='boolean') && Array.isArray(shared.coordinates), '共享文档共有约束格式无效。');
  const sharedIds = new Set<string>();
  for (const row of shared.coordinates) {
    requireValue(plain(row) && Object.keys(row).every(key => ['id', 'objectId', 'type', 'atomIds', 'images', 'action', 'steps', 'increment', 'value', 'source'].includes(key)) && typeof row.id === 'string' && !!row.id && !sharedIds.has(row.id), '共享文档共有坐标标识缺失或重复。');
    sharedIds.add(row.id);
  }
  validateSharedConstraints(shared, objects, document.draft.structure);
  if (document.gaussianBoundCoordinates !== undefined) {
    requireValue(Array.isArray(document.gaussianBoundCoordinates) && document.gaussianBoundCoordinates.every(row => plain(row) && Object.keys(row).every(key => ['rowId', 'objectId', 'type', 'atomIds', 'action', 'rowEnabled', 'stepsText', 'incrementText'].includes(key))), '共享文档Gaussian已绑定行格式无效。');
    validateGaussianBoundCoordinates(document.gaussianBoundCoordinates, objects, document.draft.structure);
  }
  for (const rows of [document.internalCoordinates, ...Object.values(value.contexts ?? {}).map(context => context.coordinates)]) {
    if (rows === undefined) continue;
    requireValue(Array.isArray(rows), '共享文档任务坐标格式无效。');
    const ids = new Set<string>();
    for (const row of rows) {
      requireValue(plain(row) && Object.keys(row).every(key => ['id', 'objectId', 'type', 'atomIds', 'images', 'action', 'steps', 'increment', 'value', 'source', 'start', 'end', 'values'].includes(key)), '共享文档任务坐标格式无效。');
      validateCoordinates([row],document.draft.structure);
      if (row.id !== undefined) { requireValue(typeof row.id === 'string' && !!row.id && !ids.has(row.id), '共享文档任务坐标标识缺失或重复。'); ids.add(row.id); }
      if (row.objectId !== undefined) {
        const object = objects.find(object => object.id === row.objectId);
        requireValue(object && Array.isArray(row.atomIds) && modelCoordinateKey(object) === modelCoordinateKey(row), '共享文档任务坐标关联BAD对象缺失或不一致。');
      }
    }
  }
  return freeze(value);
}
function checkedMembership(raw: WorkspaceMembership, isOwner: boolean, previous?: WorkspaceMembership): WorkspaceMembership {
  const value = envelopeJSON(raw);
  requireValue(plain(value) && value.schema === schema && value.version === 1 && identity(value.documentId) && identity(value.ownerWindowId) && identity(value.memberWindowId) && identity(value.membershipNonce) && serial(value.revision), '共享文档成员回执不完整。');
  requireValue(value.isOwner === isOwner && value.isOwner === (value.ownerWindowId === value.memberWindowId), '共享文档 owner 角色不匹配。');
  if (previous) requireValue(value.documentId === previous.documentId && value.ownerWindowId === previous.ownerWindowId && value.memberWindowId === previous.memberWindowId && value.membershipNonce === previous.membershipNonce, '共享文档成员凭证已变化。');
  const snapshot = checkedSnapshot(value.snapshot, value.documentId, previous?.snapshot.documentEpoch);
  requireValue(snapshot.document.revision === value.revision, '共享文档回执修订不匹配。');
  return freeze({ ...value, snapshot });
}
const auth = (membership: WorkspaceMembership) => ({ documentId: membership.documentId, membershipNonce: membership.membershipNonce });
function checkedCommand(command: WorkspaceCommand): WorkspaceCommand {
  let value: WorkspaceCommand;
  try { value = copyWorkspaceCommandJSON(command); }
  catch (error) { if (/Unsupported workspace transport command/.test(errorMessage(error))) throw new Error('不支持的共享文档命令类型或字段。'); throw error; }
  requireValue(plain(value) && commandTypes.has(value.type), '不支持的共享文档命令类型。');
  return value;
}
function listeners() {
  const callbacks = new Set<() => void>();
  return { subscribe(callback: () => void) { callbacks.add(callback); return () => { callbacks.delete(callback); }; }, emit() { for (const callback of callbacks) callback(); }, clear() { callbacks.clear(); } };
}
export interface WorkspaceBridgeState {
  status: 'registering' | 'ready' | 'pending' | 'unavailable' | 'disposed'; pending: boolean; error: string | null;
  membership: WorkspaceMembership | null;
  closing?: boolean;
}
export interface WorkspaceOwnerOptions {
  bridge: WorkspaceDesktopBridge; documentId: string;
  nextSnapshot(): WorkspaceDocumentSnapshot;
  /** This is the only application/domain executor. It must also check actual
   * store revision, runtime locks, transaction and engine-specific context. */
  onCommand(command: WorkspaceCommand, expectedRevision: number, requesterWindowId: string): void | Promise<void>;
  subscribe?(listener: () => void): () => void;
  coalesceMs?: number;
}
export function createWorkspaceOwnerAdapter(options: WorkspaceOwnerOptions) {
  const { bridge, documentId } = options;
  requireValue(identity(documentId), '共享文档 ID 无效。');
  const delay = options.coalesceMs ?? 16;
  requireValue(Number.isInteger(delay) && delay >= 0 && delay <= 100, '共享文档发布合并预算无效。');
  const notifications = listeners();
  let state: WorkspaceBridgeState = { status: 'registering', pending: true, error: null, membership: null };
  let disposed = false, unavailable = false, dirty = false, publicationQueued = false, work = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiters: { resolve(value: WorkspaceMembership): void; reject(error: unknown): void }[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  let publicationFailure: unknown = null;
  function update(error: string | null = state.error) {
    if (disposed) state = { ...state, status: 'disposed', pending: false, error };
    else if (unavailable) state = { ...state, status: 'unavailable', pending: false, error };
    else { const pending = !state.membership || work > 0 || dirty || publicationQueued || timer !== undefined; state = { ...state, status: state.membership ? pending ? 'pending' : 'ready' : 'registering', pending, error }; }
    notifications.emit();
  }
  let initial: WorkspaceDocumentSnapshot;
  const ready = Promise.resolve().then(() => {
    requireValue(!disposed, '共享文档 adapter 已关闭。');
    // Capacity/validation failures follow the existing unavailable/error path;
    // A real clone/resource or validation failure must not crash React.
    initial = checkedSnapshot(options.nextSnapshot(), documentId);
    return bridge.registerWorkspaceDocument(envelopeJSON({ documentId, revision: initial.document.revision, snapshot: initial }));
  }).then(raw => {
    const membership = checkedMembership(raw, true);
    requireValue(membership.documentId === documentId && membership.snapshot.documentEpoch === initial.documentEpoch, '共享文档注册回执身份不匹配。');
    requireValue(JSON.stringify(membership.snapshot) === JSON.stringify(initial), '共享文档注册回执未确认原始快照。');
    state = { ...state, membership }; update(null); return membership;
  }).catch(error => { unavailable = true; update(errorMessage(error)); throw error; });
  function queue<T>(operation: () => Promise<T>): Promise<T> {
    work++; update();
    const task = tail.catch(() => {}).then(operation);
    tail = task.catch(() => {});
    void task.then(() => { work--; update(); }, error => { work--; update(errorMessage(error)); });
    return task;
  }
  async function commit(snapshot: WorkspaceDocumentSnapshot): Promise<WorkspaceMembership> {
    await ready;
    const current = state.membership!;
    const checked = checkedSnapshot(snapshot, documentId, current.snapshot.documentEpoch);
    requireValue(checked.publicationSerial > current.snapshot.publicationSerial && checked.document.revision >= current.revision, '共享文档发布序列或修订倒退。');
    const result = checkedMembership(await bridge.publishWorkspaceDocument(envelopeJSON({ ...auth(current), expectedRevision: current.revision, revision: checked.document.revision, snapshot: checked })), true, current);
    requireValue(JSON.stringify(result.snapshot) === JSON.stringify(checked), '共享文档 host 回执未确认实际发布快照。');
    state = { ...state, membership: result }; publicationFailure = null; update(null); return result;
  }
  function rejectWaiters(error: unknown) { for (const waiter of waiters.splice(0)) waiter.reject(error); }
  function schedule(immediate = false) {
    if (disposed || unavailable || publicationQueued || timer !== undefined) return;
    const run = () => {
      timer = undefined; publicationQueued = true;
      const task = queue(async () => {
        const group = waiters.splice(0); dirty = false;
        try {
          requireValue(!disposed && !unavailable, '共享文档 adapter 已关闭或不可用。');
          await ready;
          const result = await commit(options.nextSnapshot());
          for (const waiter of group) waiter.resolve(result);
          return result;
        } catch (error) { publicationFailure = error; for (const waiter of group) waiter.reject(error); throw error; }
      });
      void task.then(() => { publicationQueued = false; if (dirty) schedule(); update(); }, () => { publicationQueued = false; if (dirty) schedule(); update(); });
    };
    if (immediate) run(); else timer = setTimeout(run, delay);
    update();
  }
  function publish(): Promise<WorkspaceMembership> {
    if (disposed || unavailable) return Promise.reject(new Error('共享文档 adapter 已关闭或不可用。'));
    if (waiters.length >= 256) return Promise.reject(new Error('共享文档等待发布请求超过上限。'));
    dirty = true;
    const promise = new Promise<WorkspaceMembership>((resolve, reject) => waiters.push({ resolve, reject }));
    schedule(); update(null); return promise;
  }
  async function handleCommand(event: Extract<WorkspaceDocumentEvent, { kind: 'command' }>) {
    await ready; const membership = state.membership!;
    const request = { ...auth(membership), requestId: event.requestId };
    try {
      requireValue(!disposed && !unavailable, '共享文档 owner adapter 已关闭。');
      requireValue(event.schema === schema && event.version === 1 && identity(event.requestId) && identity(event.requesterWindowId) && serial(event.expectedRevision), '共享文档命令事件不完整。');
      const command = checkedCommand(event.command);
      const before = checkedSnapshot(options.nextSnapshot(), documentId, membership.snapshot.documentEpoch);
      requireValue(before.document.revision === event.expectedRevision || isCurrentDocumentSaveIntent(command)&&event.expectedRevision<=before.document.revision, '模型修订已变化，请刷新后重新操作。');
      await options.onCommand(command, event.expectedRevision, event.requesterWindowId);
      // Already-started authoritative work must be acknowledged even if a view
      // disposes its subscription while the callback is awaiting completion.
      const committed = await commit(options.nextSnapshot());
      await bridge.replyWorkspaceDocumentCommand(envelopeJSON({ ...request, requestId: event.requestId, status: 'committed' as const, revision: committed.revision, snapshot: committed.snapshot }));
    } catch (error) {
      update(errorMessage(error));
      await bridge.replyWorkspaceDocumentCommand(normalizeWorkspaceJSON({ ...request, status: 'rejected' as const, error: errorMessage(error).slice(0, 2048) || '共享文档命令失败。' }));
    }
  }
  const unsubscribeEvent = bridge.onWorkspaceDocumentEvent(event => {
    if (!('documentId' in event)||event.documentId !== documentId || disposed) return;
    if (event.kind === 'command') void queue(() => handleCommand(event)).catch(error => update(errorMessage(error)));
    else if (event.kind === 'unavailable') { unavailable = true; rejectWaiters(new Error('共享文档 owner 不可用。')); update('共享文档 owner 不可用。'); }
  });
  const unsubscribeStore = options.subscribe?.(() => {
    if (!disposed && !unavailable) { dirty = true; schedule(); update(null); }
  });
  return {
    ready, publish,
    async flush() {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (dirty && !publicationQueued) schedule(true);
      await ready;
      do {
        const current = tail; await current;
        // Completing an in-flight publish may have armed a coalesce timer for
        // the latest dirty snapshot. Flush owns that timer: drain it now rather
        // than repeatedly awaiting an already-resolved queue (starving timers).
        if (dirty && !publicationQueued) {
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          schedule(true);
        }
        if (current === tail && !dirty && !publicationQueued) break;
      } while (!disposed && !unavailable);
      requireValue(!disposed && !unavailable && state.membership, '共享文档 adapter 已关闭或不可用。');
      if (publicationFailure) throw publicationFailure;
      return state.membership;
    },
    getState: () => state, subscribeState: notifications.subscribe,
    dispose() {
      if (disposed) return; disposed = true;
      if (timer !== undefined) clearTimeout(timer); timer = undefined; dirty = false;
      unsubscribeStore?.(); unsubscribeEvent(); rejectWaiters(new Error('共享文档 adapter 已关闭。')); update(); notifications.clear();
      // Never leave/close a document or cancel its native controller here.
    },
  };
}

export function createWorkspaceReplica({ bridge, membership: initial }: { bridge: WorkspaceDesktopBridge; membership: WorkspaceMembership }) {
  let membership = checkedMembership(initial, false), disposed = false, unavailable = false;
  let closeRequestId: string | null = null, closeRequesterWindowId: string | null = null;
  let state: WorkspaceBridgeState = { status: 'ready', pending: false, error: null, membership, closing: false };
  let active: { reject(error: unknown): void } | null = null;
  const modelNotifications = listeners(), stateNotifications = listeners();
  function update(error: string | null = state.error) {
    state = { status: disposed ? 'disposed' : unavailable ? 'unavailable' : active ? 'pending' : 'ready', pending: Boolean(active) && !disposed && !unavailable, error, membership, closing: closeRequestId !== null };
    stateNotifications.emit();
  }
  function accept(raw: WorkspaceMembership) {
    const next = checkedMembership(raw, false, membership);
    if (next.snapshot.publicationSerial < membership.snapshot.publicationSerial) return;
    if (next.snapshot.publicationSerial === membership.snapshot.publicationSerial) { requireValue(JSON.stringify(next.snapshot) === JSON.stringify(membership.snapshot), '共享文档同序列快照不一致。'); return; }
    requireValue(next.revision >= membership.revision, '共享文档修订倒退。');
    membership = next; modelNotifications.emit(); update();
  }
  const unsubscribeEvent = bridge.onWorkspaceDocumentEvent(event => {
    if (disposed || !('documentId' in event)||event.documentId !== membership.documentId) return;
    if (event.kind === 'unavailable') {
      const reason = event.schema === schema && event.version === 1 && event.reason === 'owner-closed' ? '共享文档 owner 已关闭。' : '共享文档失效事件协议不匹配。';
      unavailable = true; active?.reject(new Error(reason)); update(reason);
    } else if (event.kind === 'close-state') {
      if (event.schema !== schema || event.version !== 1 || !identity(event.requestId) || !identity(event.requesterWindowId)) return;
      if (event.phase === 'pending') { closeRequestId = event.requestId; closeRequesterWindowId = event.requesterWindowId; update(); }
      else if (['cancelled', 'failed'].includes(event.phase) && closeRequestId === event.requestId && closeRequesterWindowId === event.requesterWindowId) { closeRequestId = null; closeRequesterWindowId = null; update(); }
    } else if (event.kind === 'snapshot') {
      try { accept(event); } catch (error) { unavailable = true; active?.reject(error); update(errorMessage(error)); }
    }
  });
  async function dispatch(command: WorkspaceCommand): Promise<ModelDocument> {
    requireValue(!disposed && !unavailable, '共享文档视图已关闭或 owner 不可用。');
    if (closeRequestId) throw new WorkspaceClosePendingError();
    requireValue(!active, '共享文档命令尚未确认，请等待实际回执。');
    const checked = checkedCommand(command), request = copyWorkspaceCommandJSON({ ...auth(membership), expectedRevision: membership.revision, command: checked }, 'request');
    const startedSerial = membership.snapshot.publicationSerial;
    let interrupted!: (error: unknown) => void;
    const interruption = new Promise<never>((_resolve, reject) => { interrupted = reject; });
    const operation = { reject: interrupted }; active = operation; update(null);
    try {
      const receipt = await Promise.race([Promise.resolve().then(() => {
        requireValue(!disposed && !unavailable, '共享文档视图已关闭或 owner 不可用。');
        if (closeRequestId) throw new WorkspaceClosePendingError();
        return bridge.commandWorkspaceDocument(request);
      }), interruption]);
      requireValue(!disposed && !unavailable && receipt.status === 'committed', '共享文档命令没有实际确认。');
      requireValue(receipt.snapshot?.publicationSerial > startedSerial, '共享文档命令回执未确认新的权威发布。');
      accept(receipt); return membership.snapshot.document;
    } catch (error) {
      if (isWorkspaceClosePendingError(error)) { update(); throw new WorkspaceClosePendingError(); }
      update(errorMessage(error)); throw error;
    }
    finally { if (active === operation) active = null; update(); }
  }
  const asyncOnly = (): never => { throw new Error('共享视图必须通过异步命令端口提交'); };
  const ownerOnly = (): never => { throw new Error('共享视图不拥有本地模型历史或 native controller。'); };
  const store: ModelStore = {
    getSnapshot: () => membership.snapshot.document, subscribe: modelNotifications.subscribe,
    getContext: scope => membership.snapshot.contexts?.[scope] ? structuredClone(membership.snapshot.contexts[scope]) : undefined,
    execute: asyncOnly, select: asyncOnly, clearCaptureSelection:ownerOnly, undo: asyncOnly, redo: asyncOnly,
    synchronizeContext: asyncOnly, setElectronicState: asyncOnly,
    stamp: ownerOnly, stampNativeMD: ownerOnly, acceptCoordinates: ownerOnly, acceptXtbCoordinates:ownerOnly, acceptXtbStoppedCoordinates:ownerOnly, publishBondOrders:ownerOnly, clearBondOrders:ownerOnly, beginTransaction: ownerOnly, endTransaction: ownerOnly, cancelTransaction: ownerOnly,
    acceptRuntimeFrame: ownerOnly, beginRuntimeSession: ownerOnly, finishRuntimeSession: ownerOnly, copy: ownerOnly, paste: ownerOnly, markApplied: ownerOnly,markSaved:ownerOnly,
  };
  return {
    store: Object.freeze(store), dispatch, getState: () => state, subscribeState: stateNotifications.subscribe,
    getWorkspaceSnapshot: () => membership.snapshot,
    async leave() {
      requireValue(!disposed, '共享文档视图已关闭。'); await bridge.leaveWorkspaceDocument(auth(membership));
      unavailable = true; active?.reject(new Error('共享文档视图已退出。')); update('共享文档视图已退出。');
    },
    dispose() {
      if (disposed) return; disposed = true; unsubscribeEvent(); active?.reject(new Error('共享文档视图已关闭。')); update();
      stateNotifications.clear(); modelNotifications.clear();
      // Unsubscription is not document destruction or an implicit leave.
    },
  };
}
