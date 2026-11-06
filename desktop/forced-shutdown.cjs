'use strict';

/** Only handles created by this host are eligible. A kill request is not a close receipt. */
function createForcedShutdown({ terminate, exit, report = () => {}, beforeExit = async () => {}, timeoutMs = 6000 }) {
  const children = new Set(); let pending = null, accepting = true;
  function track(child) {
    if (!accepting) throw new Error('APPLICATION_CLOSING: forced shutdown has closed process admission');
    children.add(child); child.once('close', () => children.delete(child)); return child;
  }
  async function shutdown() {
    if (pending) return pending;
    accepting = false;
    pending = (async () => {
      const owned = [...children]; report('force-stopping', { owned: owned.map(child => child.pid).filter(Number.isSafeInteger) });
      const closed = Promise.all(owned.map(child => new Promise(resolve => {
        if (!children.has(child)) { resolve(); return; }
        child.once('close', resolve);
      })));
      // Termination tools themselves must be bounded by the platform adapter.
      for (const child of owned) Promise.resolve().then(() => terminate(child)).catch(error => report('force-stop-error', { pid: child.pid, error: String(error?.message ?? error) }));
      let timer;
      try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
      finally { clearTimeout(timer); }
      const remaining = [...children].map(child => child.pid).filter(Number.isSafeInteger);
      report(remaining.length ? 'force-close-unconfirmed' : 'force-children-closed', { remaining });
      // No storage dispose, source reclamation, or successful-run marker is permitted here.
      let flushTimer;
      try { await Promise.race([Promise.resolve().then(beforeExit), new Promise(resolve => { flushTimer = setTimeout(resolve, 500); })]); }
      catch (error) { report('force-log-unconfirmed', { error: String(error?.message ?? error) }); }
      finally { clearTimeout(flushTimer); }
      exit(0);
      return { remaining, forced: true };
    })();
    return pending;
  }
  return { track, shutdown, count: () => children.size };
}
module.exports = { createForcedShutdown };
