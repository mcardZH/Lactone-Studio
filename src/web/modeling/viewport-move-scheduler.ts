/** Pointer samples are plain values: React currentTarget is captured before
 * its synthetic event dispatch ends. A frame uses only the newest sample. */
export function createLatestMoveScheduler<T>(request: (callback: () => void) => number, cancelFrame: (id: number) => void, apply: (sample: T) => void) {
  let pending: T | undefined, frame: number | null = null;
  const cancel = () => { if (frame !== null) cancelFrame(frame); frame = null; pending = undefined; };
  const flush = (last?: T) => {
    if (last !== undefined) pending = last;
    if (frame !== null) cancelFrame(frame); frame = null;
    const sample = pending; pending = undefined;
    if (sample !== undefined) apply(sample);
  };
  return { schedule(sample: T) { pending = sample; if (frame === null) frame = request(() => { frame = null; flush(); }); }, flush, cancel };
}
