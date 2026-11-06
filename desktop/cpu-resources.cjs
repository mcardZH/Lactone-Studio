'use strict';
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');

// NumberOfCores is reported per physical processor/socket. Never infer it by
// dividing logical processors (SMT and hybrid CPUs need not have a 2:1 ratio).
const CPU_QUERY = "$ErrorActionPreference='Stop';$taskCpuRows=@(Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object NumberOfCores,NumberOfLogicalProcessors);ConvertTo-Json -InputObject $taskCpuRows -Compress";
function logicalCount() { try { const count = os.cpus().length; return Number.isSafeInteger(count) && count > 0 ? count : null; } catch { return null; } }
function parsePhysicalCores(text, logicalCpuCount) {
  const rows = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !Number.isSafeInteger(row?.NumberOfCores) || row.NumberOfCores < 1 || !Number.isSafeInteger(row.NumberOfLogicalProcessors) || row.NumberOfLogicalProcessors < row.NumberOfCores)) throw Error('invalid-response');
  const physical = rows.reduce((sum, row) => sum + row.NumberOfCores, 0), logical = rows.reduce((sum, row) => sum + row.NumberOfLogicalProcessors, 0);
  if (!Number.isSafeInteger(physical) || !Number.isSafeInteger(logical) || logicalCpuCount !== null && (physical > logicalCpuCount || logical !== logicalCpuCount)) throw Error('invalid-response');
  return physical;
}
function createCpuResources({ platform = process.platform, logicalCpuCount = logicalCount(), spawn = spawnProcess, timeoutMs = 1500, closeGraceMs = 500, systemRoot = process.env.SystemRoot ?? 'C:/Windows' } = {}) {
  if (logicalCpuCount !== null && (!Number.isSafeInteger(logicalCpuCount) || logicalCpuCount < 1)) throw Error('Invalid logical CPU count');
  let value = { physicalCoreCount: null, logicalCpuCount, cpuIdentificationStatus: platform === 'win32' ? 'unavailable' : 'unsupported', cpuIdentificationError: platform === 'win32' ? 'not-queried' : 'unsupported-platform' }, pending, child;
  const peek = () => ({ ...value });
  const close = () => child ? new Promise(resolve => { child.once('close', resolve); if (child.exitCode === null && child.signalCode === null) child.kill(); }) : Promise.resolve();
  function read() {
    if (pending) return pending;
    if (platform !== 'win32') return pending = Promise.resolve(peek());
    pending = new Promise(resolve => {
      let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, timer, grace, done = false, failure = null;
      const finish = closed => { if (done) return; done = true; clearTimeout(timer); clearTimeout(grace);
        value = { ...value, physicalCoreCount: null, cpuIdentificationStatus: 'unavailable', cpuIdentificationError: closed ? failure : 'query-unsettled' };
        if (closed && !failure) try { value.physicalCoreCount = parsePhysicalCores(stdout, logicalCpuCount); value.cpuIdentificationStatus = 'identified'; value.cpuIdentificationError = null; } catch { value.cpuIdentificationError = 'invalid-response'; }
        if (closed) child = null; resolve(peek()); };
      const stop = reason => { failure ??= reason; if (!grace) { try { if (child && child.exitCode === null && child.signalCode === null) child.kill(); } catch { failure = 'query-kill-failed'; } grace = setTimeout(() => finish(false), closeGraceMs); } };
      const capture = (stream, bytes) => {
        if (done || failure) return;
        const count = Buffer.byteLength(bytes), used = stream === 'stdout' ? stdoutBytes : stderrBytes;
        if (count > 16384 - used) { stop('query-output-limit'); return; }
        if (stream === 'stdout') { stdoutBytes += count; stdout += bytes.toString('utf8'); }
        else { stderrBytes += count; stderr += bytes.toString('utf8'); if (count) stop('query-stderr'); }
      };
      try {
        child = spawn(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', CPU_QUERY], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', bytes => capture('stdout', bytes));
        child.stderr.on('data', bytes => capture('stderr', bytes));
        child.once('error', () => { failure ??= 'query-failed'; });
        child.once('close', (code, signal) => { child = null; if (code !== 0 || signal !== null) failure ??= 'query-failed'; finish(true); });
        timer = setTimeout(() => stop('query-timeout'), timeoutMs);
      } catch { failure = 'query-failed'; finish(true); }
    });
    return pending;
  }
  return { read, peek, close };
}
const current = createCpuResources();
module.exports = { CPU_QUERY, parsePhysicalCores, createCpuResources, readCpuResources: current.read, cpuResourceSnapshot: current.peek, closeCpuResources: current.close };
