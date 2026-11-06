'use strict';
const path = require('node:path');
const { checkDirectory, currentFile, atomicWrite, failure } = require('./portable-storage.cjs');
// Product-owned bounded event codes only. No model text, customer path or raw stack.
function createPortableLog({ profile, maxBytes = 256 * 1024, maxEntries = 256, clock = Date.now }) {
  if (!profile?.identities?.logs || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024 || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) throw new Error('Invalid portable log bounds');
  const file = path.join(profile.paths.logs, 'portable-events.jsonl'); let queue = Promise.resolve(), closed = false;
  const valid = record => record && Object.keys(record).length === 3 && ['time', 'level', 'code'].every(key => Object.hasOwn(record, key)) && Number.isFinite(Date.parse(record.time)) && ['info', 'warning', 'error'].includes(record.level) && typeof record.code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(record.code);
  return {
    append(record) {
      if (!record || Object.keys(record).length !== 2 || !Object.hasOwn(record, 'level') || !Object.hasOwn(record, 'code') || !valid({ ...record, time: new Date(clock()).toISOString() })) return Promise.reject(failure('PORTABLE_LOG_FIELDS', 'Only event level and bounded code may be logged'));
      const work = queue.then(async () => {
        if (closed) throw failure('PORTABLE_LOG_CLOSED', 'Portable log closed'); await checkDirectory(profile.paths.logs, profile.identities.logs); const previous = await currentFile(file); let rows = [];
        if (previous) { if (previous.bytes.length > maxBytes) throw failure('PORTABLE_LOG_SCHEMA', 'Oversized existing log preserved'); try { rows = new TextDecoder('utf-8', { fatal: true }).decode(previous.bytes).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { throw failure('PORTABLE_LOG_SCHEMA', 'Invalid log preserved'); } if (!rows.every(valid)) throw failure('PORTABLE_LOG_SCHEMA', 'Invalid log fields preserved'); }
        rows.push({ time: new Date(clock()).toISOString(), level: record.level, code: record.code }); rows = rows.slice(-maxEntries); let bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
        while (bytes.length > maxBytes && rows.length > 1) { rows.shift(); bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
        await atomicWrite(file, bytes, previous, profile.identities.logs); return { bytes: bytes.length, entries: rows.length };
      }); queue = work.catch(() => {}); return work;
    },
    flush: () => queue,
    close() { closed = true; return queue; },
  };
}
module.exports = { createPortableLog };
