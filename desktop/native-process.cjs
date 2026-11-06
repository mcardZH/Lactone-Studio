'use strict';
const { EventEmitter } = require('node:events');

/** Tracks only handles created by this host. An error/kill request is NOT close. */
function createNativeProcessTracker({ spawn, environment = () => ({}) }) {
  const children = new Set(), retainedAnalysis = new Set(), changes = new EventEmitter();
  let accepting = true;
  function ownedSpawn(executable, args, options, retained = false) {
    if (!accepting) throw new Error('APPLICATION_CLOSING: native process admission is closed');
    const child = spawn(executable, args, { ...options, env: { ...(options?.env ?? process.env), ...environment(executable, args, options) } });
    children.add(child);
    if (retained) retainedAnalysis.add(child);
    child.once('close', () => { children.delete(child); retainedAnalysis.delete(child); changes.emit('closed'); });
    return child;
  }
  function waitClosed(timeoutMs = 6000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Bounded native close timeout required');
    if (!children.size) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer;
      const finish = closed => { clearTimeout(timer); changes.removeListener('closed', check); resolve(closed); };
      const check = () => { if (!children.size) finish(true); };
      changes.on('closed', check); timer = setTimeout(() => finish(false), timeoutMs); check();
    });
  }
  function whenClosed() {
    if (!children.size) return Promise.resolve();
    return new Promise(resolve => { const check = () => { if (!children.size) { changes.removeListener('closed', check); resolve(); } }; changes.on('closed', check); check(); });
  }
  return {
    spawn: (executable, args, options) => ownedSpawn(executable, args, options),
    // Trusted host composition marks only the persistent scientific reader
    // workers. Their active work is separately serialized by the shared lease.
    spawnRetainedAnalysis: (executable, args, options) => ownedSpawn(executable, args, options, true),
    count: () => children.size,
    unleasedCount: () => children.size - retainedAnalysis.size,
    closeAdmission() { accepting = false; },
    waitClosed, whenClosed,
  };
}
module.exports = { createNativeProcessTracker };
