'use strict';

const { randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, open, readFile, rmdir, unlink, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const inlineBytes = 96 * 1024;
const pageBytes = 24 * 1024;
const readName = 'assistant_read_artifact';
const imageKinds = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const descriptor = Object.freeze({ name: readName,
  description: 'Read an exact receipt or view an image retained in this assistant conversation. Use the returned artifactRef and nextOffset. Offsets are UTF-8 bytes from a prior page.',
  parameters: { type: 'object', properties: { artifactRef: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1 } }, required: ['artifactRef'], additionalProperties: false },
});

function createArtifacts(userDataPath) {
  let pendingDirectory;
  let closed = false;
  const records = new Map();
  const pending = new Set();
  function keep(kind, value) {
    if (closed) return Promise.reject(Error('此助手对话已关闭。'));
    const work = (async () => {
      pendingDirectory ??= mkdir(userDataPath, { recursive: true }).then(() => mkdtemp(join(userDataPath, 'assistant-artifacts-')));
      const path = await pendingDirectory;
      const artifactRef = randomUUID();
      const filename = join(path, artifactRef);
      const bytes = typeof value === 'string' ? Buffer.byteLength(value) : value.length;
      const record = { artifactRef, filename, kind, bytes };
      records.set(artifactRef, record);
      await writeFile(filename, value, { flag: 'wx', mode: 0o600 });
      return { artifactRef, type: kind, byteLength: bytes };
    })();
    pending.add(work);
    return work.finally(() => pending.delete(work));
  }
  async function get(args) {
    const record = records.get(args.artifactRef);
    if (!record || closed) throw Object.assign(Error('当前对话中没有此回执或图像引用。'), { code: 'assistant_artifact_missing' });
    const offset = args.offset ?? 0, length = args.length ?? pageBytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.bytes || !Number.isSafeInteger(length) || length < 1)
      throw Object.assign(Error('请使用上一页的 nextOffset 或从 0 开始读取。'), { code: 'invalid_arguments' });
    if (imageKinds.has(record.kind)) return { artifactRef: record.artifactRef, imagePreview: { mimeType: record.kind, byteLength: record.bytes,
      data: (await readFile(record.filename)).toString('base64') } };
    const handle = await open(record.filename, 'r');
    try {
      const requested = Math.min(length, record.bytes - offset);
      const data = Buffer.alloc(Math.min(requested + 3, record.bytes - offset));
      const { bytesRead } = await handle.read(data, 0, data.length, offset);
      if (bytesRead && (data[0] & 0xc0) === 0x80) throw Object.assign(Error('起点在 UTF-8 字符内部，请使用上一页的 nextOffset。'), { code: 'invalid_arguments' });
      let end = Math.min(requested, bytesRead);
      while (end < bytesRead && (data[end] & 0xc0) === 0x80) end++;
      return { artifactRef: record.artifactRef, type: record.kind, byteLength: record.bytes, offset,
        nextOffset: offset + end < record.bytes ? offset + end : null, text: data.subarray(0, end).toString('utf8') };
    } finally { await handle.close(); }
  }
  async function dispose() {
    closed = true;
    await Promise.allSettled([...pending]);
    await Promise.allSettled([...records.values()].map(record => unlink(record.filename)));
    records.clear();
    if (pendingDirectory) await pendingDirectory.then(path => rmdir(path)).catch(() => {});
  }
  return { keep, get, dispose };
}

function compactValue(value, depth = 0) {
  if (typeof value === 'string') return value.length > 1600 ? `${value.slice(0, 1600)}…` : value;
  if (Array.isArray(value)) return { count: value.length, first: depth < 3 ? value.slice(0, 3).map(item => compactValue(item, depth + 1)) : [] };
  if (!value || typeof value !== 'object') return value;
  if (depth >= 3) return { fields: Object.keys(value) };
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compactValue(entry, depth + 1)]));
}

async function prepareReceipt(artifacts, raw, image, name) {
  let receipt = raw;
  if (image && name !== readName) {
    const reference = await artifacts.keep('image/png', Buffer.from(image.data, 'base64'));
    receipt = { ...raw, result: { ...raw.result, imagePreview: { ...raw.result.imagePreview, artifactRef: reference.artifactRef } } };
  }
  const text = JSON.stringify(receipt);
  if (name === readName || Buffer.byteLength(text) <= inlineBytes) return { receipt, text, image };
  const artifact = await artifacts.keep('application/json', text);
  const compact = compactValue(receipt);
  if (raw.error?.data) compact.error.data = {
    ...compact.error.data,
    ...(raw.error.data.completion ? { completion: raw.error.data.completion } : {}),
    ...(raw.error.data.recovery ? { recovery: raw.error.data.recovery } : {}),
  };
  for (const key of ['next', 'recovery']) {
    const action = raw.result?.[key];
    if (typeof action?.tool === 'string' && Buffer.byteLength(JSON.stringify(action)) < inlineBytes) compact.result[key] = action;
  }
  receipt = { ...compact, artifact, fullReceipt: `Use ${readName} and the exact artifactRef when more fields are needed.` };
  return { receipt, text: JSON.stringify(receipt), image };
}

module.exports = { createArtifacts, prepareReceipt, readName, descriptor, imageKinds };
