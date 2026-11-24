import type { PesFrame } from './contracts';

export function validPesFrame(frame: PesFrame, atoms: number): boolean {
  return !!frame && typeof frame.id === 'string' && !!frame.id && typeof frame.seriesId === 'string' && !!frame.seriesId &&
    Number.isSafeInteger(frame.step) && Array.isArray(frame.positions) && frame.positions.length === atoms &&
    frame.positions.every(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)) &&
    (frame.energyHartree == null || Number.isFinite(frame.energyHartree));
}

/** OPT emits accepted steps in order. Prefer terminal evidence for the same step. */
export function lastOrdinaryOptimizationFrame(frames: readonly PesFrame[], atoms: number, preview?: PesFrame): PesFrame | undefined {
  for (let index = frames.length - 1; index >= 0; index--) {
    const frame = frames[index];
    if (validPesFrame(frame, atoms)) return preview && preview.step > frame.step ? preview : frame;
  }
  return preview;
}
