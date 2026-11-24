import type { Structure } from '../../core/types';
import { assertResultNotAborted, type ResultFrameSummary, type TrajectoryResult } from '../../results/contracts';
import type { ConformerBatchEntry } from './batch-contracts';
import type { ConformerSamplingFrameEvent, ConformerSamplingRequest } from './sampling-contracts';
import { validateSamplingFrame } from './route-data';

export type ConformerRecoveryKind = 'sampling' | 'optimization';
export interface ConformerRecoveryItem {
  id: string;
  kind: ConformerRecoveryKind;
  identity: { taskId: string; runId: string; stageId?: string; segmentId?: string; revision?: number };
  phase: string;
  recoverableCount: number;
  expectedCount: number;
  createdAt: string | number;
  updatedAt: string | number;
  bytesLength?: number;
  scope?: {projectId?:string;documentId?:string};
  source?: {documentId?:string};
  verification?: 'manifest-only' | 'verified';
  issues?: readonly {message:string}[];
}
export interface ConformerRecoveryLease extends ConformerRecoveryItem {
  token: string;
  initial?: { structure: Structure };
  request?: ConformerSamplingRequest | Record<string, unknown>;
  biasDeposits?: number;
}
export interface ConformerRecoverySummary {
  index: number;
  step?: number;
  timeFs?: number;
  physicalEnergyEV?: number | null;
  status?: ConformerBatchEntry['status'];
  energyHartree?: number;
  role?: ConformerSamplingFrameEvent['role'];
}
export interface ConformerRecoveryPage<T> {
  records: T[];
  offset: number;
  total: number;
  done: boolean;
}
export type ConformerRecoveryRecord = ConformerSamplingFrameEvent | ConformerBatchEntry;
export interface ConformerRecoveryBridge {
  listConformerRecovery(): Promise<{ recoveries: ConformerRecoveryItem[]; issues: unknown[] }>;
  openConformerRecovery(kind: ConformerRecoveryKind, id: string): Promise<ConformerRecoveryLease>;
  readConformerRecovery(kind: ConformerRecoveryKind, token: string, offset: number, limit: number, summaryOnly: true): Promise<ConformerRecoveryPage<ConformerRecoverySummary>>;
  readConformerRecovery(kind: ConformerRecoveryKind, token: string, offset: number, limit: number, summaryOnly?: false): Promise<ConformerRecoveryPage<ConformerRecoveryRecord>>;
  closeConformerRecovery(kind: ConformerRecoveryKind, token: string): Promise<void>;
  discardConformerRecovery(kind: ConformerRecoveryKind, id: string): Promise<{ discarded: boolean }>;
}

export function recoveryLabel(item: ConformerRecoveryItem): string {
  const stage = item.kind === 'sampling' ? '构象采样' : '构象优化';
  return `${stage} · ${item.identity.stageId ?? item.identity.segmentId ?? item.identity.runId}`;
}

function checkPage<T>(page: ConformerRecoveryPage<T>, offset: number, total: number, limit: number): void {
  const next = offset + page.records.length;
  if (page.offset !== offset || page.total !== total || !page.records.length || page.records.length > limit || next > total || page.done !== (next === total))
    throw new Error('恢复记录的分块或来源已变化，请重新打开。');
}

/** Open a verified collection without loading all structures into the renderer.
 * The document holds the lease and shares the ordinary trajectory player. */
export async function openRecoveredConformerTrajectory(
  bridge: ConformerRecoveryBridge, item: ConformerRecoveryItem, signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<TrajectoryResult> {
  assertResultNotAborted(signal);
  const lease = await bridge.openConformerRecovery(item.kind, item.id);
  let disposed = false, disposing: Promise<void> | undefined;
  let cached: ConformerRecoveryPage<ConformerRecoveryRecord> | undefined;
  let reading: Promise<ConformerRecoveryPage<ConformerRecoveryRecord>> | undefined;
  const dispose = () => disposing ??= bridge.closeConformerRecovery(lease.kind, lease.token).then(() => { disposed = true; cached = undefined; })
    .catch(error => { disposing = undefined; throw error; });
  try {
    if (lease.id !== item.id || lease.kind !== item.kind || lease.identity.taskId !== item.identity.taskId || lease.identity.runId !== item.identity.runId ||
      lease.identity.stageId !== item.identity.stageId || lease.identity.segmentId !== item.identity.segmentId || lease.identity.revision !== item.identity.revision ||
      !Number.isSafeInteger(lease.recoverableCount) || lease.recoverableCount < 1)
      throw new Error('恢复记录与选择的计算结果不一致。');
    const frames: ResultFrameSummary[] = [], slots: number[] = [];
    const total = lease.recoverableCount, sampling = lease.kind === 'sampling';
    const id = `recovered-${lease.kind}-${lease.id}`, label = recoveryLabel(lease);
    let prior = -1;
    onProgress?.(0, total);
    for (let offset = 0; offset < total;) {
      assertResultNotAborted(signal);
      const page = await bridge.readConformerRecovery(lease.kind, lease.token, offset, 64, true);
      assertResultNotAborted(signal);
      checkPage(page, offset, total, 64);
      for (const [pageIndex, row] of page.records.entries()) {
        if (!Number.isSafeInteger(row.index) || row.index <= prior) throw new Error('恢复记录的原始帧编号不正确。');
        prior = row.index;
        if (!sampling && row.status !== 'succeeded') continue;
        slots.push(offset + pageIndex);
        const energy = sampling ? row.physicalEnergyEV : row.energyHartree;
        frames.push({ index: frames.length, sourceFrameIndex: row.index, sourceStep: row.step ?? null,
          sourceLine: row.index + 1, convergence: [], sourceBondGraph: 'inherited', ...(row.role==='sampled-candidate'?{label:'采样候选'}:{}),
          time: row.timeFs === undefined ? null : { value: row.timeFs, unit: 'fs' },
          energy: typeof energy === 'number' ? { value: energy, unit: sampling ? 'eV' : 'Hartree' } : null,
          energyQuantity: sampling ? 'potential' : 'electronic' });
      }
      offset += page.records.length;
      onProgress?.(offset, total);
    }
    if (!frames.length) throw new Error('恢复记录没有通过计算校验的几何帧。');
    const includes = (page:ConformerRecoveryPage<ConformerRecoveryRecord>|undefined, slot:number) =>
      !!page && page.offset <= slot && slot < page.offset + page.records.length;
    const fetch = async (slot:number) => {
      while (!includes(cached,slot)) {
        if (disposed || disposing) throw new Error('计算恢复数据已关闭。');
        reading ??= bridge.readConformerRecovery(lease.kind,lease.token,slot,64).then(page=>{
          checkPage(page,slot,total,64);cached=page;return page;
        }).finally(()=>{reading=undefined;});
        await reading;
      }
      return cached!.records[slot-cached!.offset];
    };
    const getFrame = async (index: number, frameSignal?: AbortSignal): Promise<Structure> => {
      assertResultNotAborted(frameSignal);
      const slot = slots[index];
      if (disposed || disposing || !Number.isSafeInteger(index) || slot === undefined) throw new Error('计算恢复帧已关闭或编号无效。');
      const record = await fetch(slot);
      assertResultNotAborted(frameSignal);
      const sourceIndex = frames[index].sourceFrameIndex;
      if (sampling && 'frameIndex' in record && record.frameIndex === sourceIndex && lease.request)
        return validateSamplingFrame(lease.request as ConformerSamplingRequest, record);
      if (!sampling && 'status' in record && record.index === sourceIndex && record.status === 'succeeded' && record.result)
        return structuredClone(record.result.structure);
      throw new Error('恢复帧与已校验的来源或帧编号不符。');
    };
    const initialStructure = await getFrame(0, signal);
    const messages = [`从磁盘恢复原任务 ${lease.identity.taskId}，运行 ${lease.identity.runId}，原状态 ${lease.phase}。`];
    if (frames.length !== lease.expectedCount) messages.push(`保留 ${frames.length} / ${lease.expectedCount} 个几何帧。`);
    if (lease.issues?.length) messages.push(`部分记录无法核验。${lease.issues.map(issue=>issue.message).join('；')}`);
    const methodField=lease.request?.method;
    const method=typeof methodField==='string'?methodField:methodField&&typeof methodField==='object'&&'backend' in methodField&&typeof methodField.backend==='string'?methodField.backend:undefined;
    const result: TrajectoryResult = { id, label, kind: sampling ? 'trajectory' : 'collection', engine: 'structure',
      source: { id, name: label, size: lease.bytesLength ?? 0 }, jobIndex: 0, role: sampling ? 'md-trajectory' : 'optimization-trajectory',
      status: lease.phase === 'completed' && frames.length === lease.expectedCount ? 'completed' : 'incomplete',
      messages, frames, initialStructure, getFrame, dispose,
      recoveredComputation:{kind:lease.kind,id:lease.id,...lease.identity,phase:lease.phase,projectId:lease.scope?.projectId,
        sourceDocumentId:lease.scope?.documentId??lease.source?.documentId,method,originalRecords:lease.expectedCount,verifiedRecords:total,biasDeposits:lease.biasDeposits} };
    return result;
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error,cleanup], '恢复结果读取失败，释放读取会话也未确认。'); }
    throw error;
  }
}
