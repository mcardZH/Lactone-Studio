'use strict';

/** One existing chemistry child, including cancellation-to-actual-close.
 * A kill request is never a settled job or permission to start its successor. */
function createChemistryJob(child, { maxBytes, timeoutMs, parse, setTimeout: later = setTimeout, clearTimeout: clear = clearTimeout }) {
  let stdout = '', stderr = '', terminalError = null, closed = false, resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  function abort(message) {
    if (closed || terminalError) return;
    terminalError = message instanceof Error ? message : new Error(message);
    try { child.kill(); } catch { /* Keep ownership until the child actually closes. */ }
  }
  const timer = timeoutMs === undefined ? undefined : later(() => abort(`CHEMISTRY_TIMEOUT: 原生化学任务超过${timeoutMs / 1000}秒`), timeoutMs);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (closed || terminalError) return;
    stdout += chunk;
    if (Buffer.byteLength(stdout) > maxBytes) { stdout = ''; abort('CHEMISTRY_OUTPUT_LIMIT: 引擎输出过大'); }
  });
  child.stderr.on('data', chunk => { if (!closed) stderr = (stderr + chunk).slice(-8192); });
  child.on('error', error => { terminalError ??= new Error(`CHEMISTRY_SPAWN_FAILED: ${error.message}`); });
  child.on('close', (code, signal) => {
    if (closed) return;
    closed = true; clear(timer);
    if (terminalError) { reject(terminalError); return; }
    try { resolve(parse(stdout, stderr, code, signal)); } catch (error) { reject(error); }
  });
  child.stdin.on('error', error => abort(`CHEMISTRY_INPUT_FAILED: ${error.message}`));
  return { promise, abort };
}
module.exports = { createChemistryJob };
