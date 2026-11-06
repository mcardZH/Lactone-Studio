import type { Structure } from '../core/types';
import type { ModelDocument } from '../modeling/contracts';
import type { TrajectoryRange, TrajectoryResult } from './contracts';

export type PlaybackMode = 'once' | 'loop' | 'bounce';
export type PlaybackDirection = 1 | -1;
export function playbackRange(range: TrajectoryRange, frameCount: number) {
  const { start, end, stride } = range;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || ![start, end, stride].every(Number.isSafeInteger)
    || start < 0 || end < 0 || start >= frameCount || end >= frameCount || stride < 1) throw new Error('帧范围或步距无效。');
  const sign = end >= start ? 1 : -1;
  const length = Math.floor(Math.abs(end - start) / stride) + 1;
  return { sign, length, first: start, last: start + (length - 1) * sign * stride };
}
/** O(1) stepping: no frame-count-sized arrays and no repeated boundary frames. */
export function advancePlayback(index: number, range: TrajectoryRange, frameCount: number, direction: PlaybackDirection, mode: PlaybackMode) {
  const { sign, length } = playbackRange(range, frameCount);
  const position = (index - range.start) / (sign * range.stride);
  let next = direction === 1 ? Math.floor(position) + 1 : Math.ceil(position) - 1;
  if (length === 1) return { index: range.start, direction, stopped: true };
  if (next < 0 || next >= length) {
    if (mode === 'once') return { index, direction, stopped: true };
    if (mode === 'loop') next = direction === 1 ? 0 : length - 1;
    else { direction = direction === 1 ? -1 : 1; next = next < 0 ? 1 : length - 2; }
  }
  return { index: range.start + next * sign * range.stride, direction, stopped: false };
}

/** Reader owns cancellation only. Source disposal belongs to the result owner. */
export class LatestFrameReader {
  private serial = 0;
  private controller: AbortController | null = null;
  cancel() { this.serial++; this.controller?.abort(); this.controller = null; }
  async read(result: TrajectoryResult, index: number, signal?: AbortSignal): Promise<Structure | null> {
    this.cancel();
    if (!Number.isSafeInteger(index) || index < 0 || index >= result.frames.length) throw new Error('帧号超出范围。');
    const serial = this.serial, controller = new AbortController(); this.controller = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      if (controller.signal.aborted) return null;
      const frame = await result.getFrame(index, controller.signal);
      return serial === this.serial && !controller.signal.aborted ? frame : null;
    } catch (error) {
      if (serial !== this.serial || controller.signal.aborted) return null;
      throw error;
    } finally { signal?.removeEventListener('abort', abort); if (serial === this.serial) this.controller = null; }
  }
}

/** Adapt a source snapshot for viewing without a store, chemistry, Undo or input draft. */
export function trajectoryViewDocument(result: TrajectoryResult, structure: Structure, index: number): ModelDocument {
  const ids = structure.atoms.map(atom => atom.id);
  if (!ids.length || ids.some(id => !id) || new Set(ids).size !== ids.length
    || structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) throw new Error('轨迹帧需要唯一原子身份及有限坐标。');
  if (result.kind !== 'collection' && (structure.atoms.length !== result.initialStructure.atoms.length
    || structure.atoms.some((atom, i) => atom.id !== result.initialStructure.atoms[i].id || atom.element !== result.initialStructure.atoms[i].element))) throw new Error('轨迹帧的原子身份或元素对应发生变化。');
  const assignments = { layers: [], basis: [], fragments: [], frozenAtomIds: [] };
  return { id: `result:${result.id}`, revision: index, draft: { structure, assignments,
    revision: index, selectedIds: [], touchedIds: [], assignmentIssues: [], createdFrom: {}, past: [], future: [], dirty: false,
    baseAtomIds: ids as string[], baseStructure: structure, baseAssignments: assignments },
    selection: { atomIds: [], bonds: [], auxiliaryIds: [], portIds: [] }, auxiliaryRelations: [], deletedBonds: [], attachmentPorts: [], canUndo: false, canRedo: false };
}
