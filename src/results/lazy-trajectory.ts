import type { Structure } from '../core/types';
import { assertResultNotAborted, type TrajectoryResult } from './contracts';
import { trajectoryViewDocument } from './playback';

/** A project restore supplies only the small frame index and the current/reference
 * structure. The storage owner reads a single immutable scientific frame on demand. */
export type LazyTrajectoryInput = Omit<TrajectoryResult, 'getFrame' | 'dispose'> & {
  readFrame(index: number, signal?: AbortSignal): Promise<Structure>;
  release?(): void | Promise<void>;
};
const lazySources = new WeakSet<TrajectoryResult>();
export const isLazyTrajectoryResult = (result: TrajectoryResult) => lazySources.has(result);
export function createLazyTrajectoryResult(input: LazyTrajectoryInput): TrajectoryResult {
  const { readFrame, release, ...metadata } = input;
  if (!metadata.id || metadata.frames.some((frame, index) => frame.index !== index)) throw new Error('轨迹索引或身份无效。');
  let closed = false;
  const result: TrajectoryResult = { ...metadata,
    async getFrame(index, signal) {
      assertResultNotAborted(signal);
      if (closed) throw new Error('轨迹来源已关闭。');
      if (!Number.isSafeInteger(index) || index < 0 || index >= result.frames.length) throw new Error('轨迹帧号超出范围。');
      const structure = await readFrame(index, signal);
      assertResultNotAborted(signal);
      if (closed) throw new DOMException('轨迹来源已关闭。', 'AbortError');
      trajectoryViewDocument(result, structure, index);
      return structuredClone(structure);
    },
    dispose() { if (closed) return; closed = true; return release?.(); },
  };
  trajectoryViewDocument(result, metadata.initialStructure, 0);
  lazySources.add(result);
  return result;
}
