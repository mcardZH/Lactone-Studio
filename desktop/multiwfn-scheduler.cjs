'use strict';
const { assert, string } = require('./security.cjs');
/** Shared host lease, not a scientific scheduler. Active work is never preempted. */
function createMultiwfnScheduler({ maxPending } = {}) {
  const queue = [], providers = new Map(), idleWaiters = new Set(); let active = null, disposed = false;
  const cancelled = () => new Error('MULTIWFN_CANCELLED: 等待中的本机分析已取消');
  function idle() { if (!active && !queue.length) { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); } }
  function next() {
    if (active || disposed) { idle(); return; }
    const entry = queue.shift(); if (!entry) { idle(); return; }
    entry.signal?.removeEventListener('abort', entry.abort); active = entry;
    let released = false;
    function reservedBytes(context = {}) {
      assert(active === entry && !released && !entry.signal?.aborted, 'Multiwfn lease is not active');
      let total = 0;
      for (const provider of providers.values()) {
        const bytes = provider(context);
        assert(Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid shared native memory reservation');
        total += bytes;
        assert(Number.isSafeInteger(total), 'Native memory reservation overflow');
      }
      return total;
    }
    entry.resolve({
      reservedBytes,
      budget(ceiling, context) {
        assert(Number.isSafeInteger(ceiling) && ceiling > 0, 'Invalid shared native memory ceiling');
        const reserved = reservedBytes(context);
        assert(reserved < ceiling, 'MULTIWFN_MEMORY_BUDGET: 实际保留的分析资源达到本次内存预算');
        return { memoryBudgetBytes: ceiling, reservedBytes: reserved, availableBytes: ceiling - reserved };
      },
      release() { if (released) return; assert(active === entry, 'Multiwfn lease identity changed'); released = true; active = null; next(); },
    });
  }
  function acquire({ owner, key, signal } = {}) {
    assert(Number.isSafeInteger(owner) && owner >= 0 && string(key, 1024), 'Invalid Multiwfn lease owner');
    assert(!disposed && (maxPending===undefined||queue.length<maxPending), 'MULTIWFN_BUSY: 本机分析等待队列不可用或已满');
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const entry = { owner, key, signal, resolve, reject };
      entry.abort = () => { const index = queue.indexOf(entry); if (index < 0) return; queue.splice(index, 1); signal?.removeEventListener('abort', entry.abort); reject(cancelled()); idle(); };
      signal?.addEventListener('abort', entry.abort, { once: true }); queue.push(entry); next();
    });
  }
  function cancelOwner(owner) { for (const entry of [...queue]) if (entry.owner === owner) entry.abort(); }
  return {
    acquire, cancelOwner,
    addReservationProvider(name, provider) { assert(string(name, 128) && typeof provider === 'function' && !providers.has(name), 'Duplicate/invalid native reservation provider'); providers.set(name, provider); },
    dispose() { disposed = true; for (const entry of [...queue]) entry.abort(); idle(); },
    whenIdle: () => !active && !queue.length ? Promise.resolve() : new Promise(resolve => idleWaiters.add(resolve)),
    status: () => ({ active: active ? { owner: active.owner, key: active.key } : null, queued: queue.map(({ owner, key }) => ({ owner, key })) }),
  };
}
module.exports = { createMultiwfnScheduler };
