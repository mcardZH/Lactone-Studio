'use strict';
const { performance } = require('node:perf_hooks');
const { StringDecoder } = require('node:string_decoder');
const { validateChemistry } = require('./security.cjs');
const request = () => ({
  operation: 'convert', format: 'xyz',
  stamp: { documentId: 'runtime-diagnostic', revision: 0, graphFingerprint: 'synthetic-H2', coordinatesFingerprint: 'synthetic-fixed', constraintsFingerprint: 'none' },
  structure: { id: 'runtime-diagnostic', name: 'runtime-diagnostic', format: 'diagnostic', dimension: 3, charge: 0, multiplicity: 1, notes: [],
    atoms: [{ id: 'h1', element: 'H', x: 0, y: 0, z: 0 }, { id: 'h2', element: 'H', x: .74, y: 0, z: 0 }], bonds: [{ a: 0, b: 1, order: 1 }] },
  movableAtomIds: [], constraints: [],
});
/** Explicit user action only. Uses a fixed synthetic conversion, never a user model. */
async function checkNativeRuntime({ runtime, spawn, signal, timeoutMs = 15000, closeMs = 5000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(closeMs) || closeMs < 1 || closeMs > 10000) throw new Error('Bounded runtime-check timeouts required');
  const input = request(); validateChemistry(input);
  const started = performance.now();
  const base = { passed: false, executableBundled: runtime.bundled === true, protocolValidated: false, directChildClosed: false, elapsedMs: 0, operation: 'convert', completeScientificValidation: false };
  return new Promise(resolve => {
    let child, timeout, closeTimer, settled = false, failure = null, stdout = '', stderr = '';
    const decoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8');
    const abort = () => stop('RUNTIME_CHECK_CANCELLED', '原生检查已取消；没有修改模型。');
    const complete = extra => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(closeTimer); signal?.removeEventListener('abort', abort); resolve({ ...base, ...extra, elapsedMs: performance.now() - started }); };
    function stop(code, message) {
      if (failure || settled) return; failure = { code, message };
      clearTimeout(timeout);
      closeTimer = setTimeout(() => complete({ error: failure }), closeMs);
      try { child?.kill(); } catch { /* Exact child remains tracked; do not invent close. */ }
    }
    try {
      if (signal?.aborted) { complete({ error: { code: 'RUNTIME_CHECK_CANCELLED', message: '原生检查已取消；没有修改模型。' } }); return; }
      child = spawn(runtime.executable, runtime.args, { cwd: runtime.cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' } });
      child.on('error', () => stop('RUNTIME_CHECK_SPAWN', '原生引擎无法启动，请保留完整程序目录。'));
      child.once('close', (code, signal) => {
        if (failure) { complete({ directChildClosed: true, error: failure }); return; }
        try {
          stdout += decoder.end(); stderr += errorDecoder.end();
          const result = JSON.parse(stdout.trim());
          if (code !== 0 || signal || stderr.trim() || result.error || result.operation !== input.operation || result.format !== 'xyz' ||
              JSON.stringify(result.stamp) !== JSON.stringify(input.stamp) || JSON.stringify(result.structure) !== JSON.stringify(input.structure) ||
              JSON.stringify(result.movableAtomIds) !== '[]' || JSON.stringify(result.warnings) !== JSON.stringify(["This chemical format does not preserve application stable IDs or all modeling assignments; reload uses the format's actual fields."]) || result.engine !== 'RDKit' || typeof result.engineVersion !== 'string' || !result.engineVersion ||
              typeof result.text !== 'string' || !result.text.startsWith('2\n')) throw new Error('Unexpected check response');
          complete({ passed: true, protocolValidated: true, directChildClosed: true, engine: result.engine, engineVersion: result.engineVersion });
        } catch { complete({ directChildClosed: true, error: { code: 'RUNTIME_CHECK_PROTOCOL', message: '原生引擎未返回完整合法的检查结果，请导出诊断信息。' } }); }
      });
      timeout = setTimeout(() => stop('RUNTIME_CHECK_TIMEOUT', '原生检查超时；没有修改模型。'), timeoutMs);
      child.stdout.on('data', bytes => { if (failure || settled) return; const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); if (Buffer.byteLength(stdout) + chunk.length > 256 * 1024) { stop('RUNTIME_CHECK_OUTPUT', '原生检查输出超出限制。'); return; } stdout += decoder.write(chunk); });
      child.stderr.on('data', bytes => { if (failure || settled) return; const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); if (Buffer.byteLength(stderr) + chunk.length > 8192) { stop('RUNTIME_CHECK_STDERR', '原生检查错误输出超出限制。'); return; } stderr += errorDecoder.write(chunk); });
      child.stdin.on('error', () => stop('RUNTIME_CHECK_INPUT', '无法向原生引擎发送检查请求。'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdin.end(JSON.stringify(input) + '\n');
    } catch { if (child) stop('RUNTIME_CHECK_INPUT', '无法向原生引擎发送检查请求。'); else complete({ error: { code: 'RUNTIME_CHECK_SPAWN', message: '原生引擎无法启动，请保留完整程序目录。' } }); }
  });
}
module.exports = { checkNativeRuntime, diagnosticRequest: request };
