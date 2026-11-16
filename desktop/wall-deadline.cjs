'use strict';

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function armWallDeadline(seconds, onDeadline, { monotonicNow = () => performance.now(), later = setTimeout, clearLater = clearTimeout } = {}) {
  if (seconds === undefined) return () => {};
  const started = monotonicNow();
  let timer, cancelled = false;
  function schedule() {
    if (cancelled) return;
    const elapsed = monotonicNow() - started;
    const remaining = seconds <= Number.MAX_VALUE / 1000
      ? seconds * 1000 - elapsed
      : (seconds - elapsed / 1000) * 1000;
    if (remaining <= 0) {
      onDeadline();
      return;
    }
    timer = later(schedule, Math.min(MAX_TIMER_DELAY_MS, Math.ceil(remaining)));
    timer.unref?.();
  }
  schedule();
  return () => {
    cancelled = true;
    clearLater(timer);
  };
}

module.exports = { armWallDeadline };
