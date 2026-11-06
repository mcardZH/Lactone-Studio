import { useEffect, useRef } from 'react';

type FrameWindow = Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>;

/** Keep only the latest display update. A gesture's final value can be flushed
 * before release/export, including when its window is no longer producing RAF. */
export function latestPlotFrameUpdate<T>(apply: (value: T) => void) {
  let pending: { value: T; win: FrameWindow } | null = null, frame = 0;
  const cancel = () => { if (pending) pending.win.cancelAnimationFrame(frame); pending = null; frame = 0; };
  const flush = () => { const next = pending; cancel(); if (next) apply(next.value); };
  return { cancel, flush,
    schedule(value: T, win: FrameWindow | null | undefined) {
      if (!win?.requestAnimationFrame) { cancel(); apply(value); return; }
      if (pending?.win !== win) cancel();
      const scheduled = pending !== null;
      pending = { value, win };
      if (!scheduled) frame = win.requestAnimationFrame(flush);
    },
  };
}

export function usePlotFrameUpdate<T>(apply: (value: T) => void) {
  const callback = useRef(apply); callback.current = apply;
  const queue = useRef<ReturnType<typeof latestPlotFrameUpdate<T>> | null>(null);
  if (!queue.current) queue.current = latestPlotFrameUpdate(value => callback.current(value));
  useEffect(() => () => queue.current?.cancel(), []);
  return queue.current;
}
