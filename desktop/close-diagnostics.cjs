'use strict';
const path = require('node:path');
const { currentFile, atomicWrite, checkDirectory, directoryIdentity } = require('./portable-storage.cjs');

/** Small local fault record; never part of a clean-shutdown receipt. */
function createCloseDiagnostics({ directory, identity, maxBytes = 128 * 1024 }) {
  const file = path.join(directory, 'close-diagnostics.jsonl'); let queue = Promise.resolve();
  function record(phase, details = {}) {
    const row = { time: new Date().toISOString(), hostPID: process.pid, phase: String(phase).slice(0, 100) };
    for (const key of ['owner', 'requestId', 'reason', 'error', 'stack', 'owned', 'remaining', 'exitCode']) {
      const value = details[key];
      if (typeof value === 'string') row[key] = value.slice(0, key === 'stack' ? 4096 : 2048);
      else if (typeof value === 'number' && Number.isFinite(value)) row[key] = value;
      else if (Array.isArray(value)) row[key] = value.filter(Number.isSafeInteger).slice(0, 64);
    }
    console.warn('SY_CLOSE', JSON.stringify(row));
    const work = queue.then(async () => {
      if (!identity) identity = await directoryIdentity(directory);
      await checkDirectory(directory, identity);
      const previous = await currentFile(file);
      if (previous && previous.bytes.length > maxBytes) return; // Preserve unfamiliar/oversized history.
      let lines = previous ? previous.bytes.toString('utf8').trim().split('\n').filter(Boolean) : [];
      lines.push(JSON.stringify(row)); lines = lines.slice(-100);
      let bytes = Buffer.from(lines.join('\n') + '\n');
      while (bytes.length > maxBytes && lines.length > 1) { lines.shift(); bytes = Buffer.from(lines.join('\n') + '\n'); }
      await atomicWrite(file, bytes, previous, identity);
    });
    queue = work.catch(() => {}); return queue;
  }
  return { record, flush: () => queue };
}
module.exports = { createCloseDiagnostics };
