'use strict';
const path = require('node:path');
const { assert, plain } = require('./security.cjs');
const { directoryIdentity, checkDirectory, readChecked, currentFile, atomicWrite } = require('./portable-storage.cjs');
const LIMIT = 256 * 1024;
/** Reads the actual delivered license; stores only an explicit reading receipt. */
function createFirstRunLicense({ profileRoot, licensePath }) {
  assert(path.isAbsolute(profileRoot) && path.isAbsolute(licensePath), 'LICENSE_PATH: Absolute paths required');
  const root = path.resolve(profileRoot), file = path.join(root, 'first-run-license-v1.json');
  const pinned = directoryIdentity(root); pinned.catch(() => {});
  const baselines = new Map(), epochs = new Map(); let queue = Promise.resolve(), closed = false;
  const epoch = owner => epochs.get(owner) || 0;
  const active = (owner, generation) => assert(Number.isSafeInteger(owner) && owner >= 0 && !closed && epoch(owner) === generation, 'LICENSE_CLOSED: 阅读窗口已关闭。');
  const serialize = operation => { const next = queue.then(operation); queue = next.catch(() => {}); return next; };
  async function load() {
    const parent = await pinned; await checkDirectory(root, parent);
    const license = await readChecked(licensePath, LIMIT), text = new TextDecoder('utf-8', { fatal: true }).decode(license.bytes);
    assert(text.trim(), 'LICENSE_EMPTY: 许可文件为空。');
    const record = await currentFile(file, undefined, 4096); let receipt = null;
    if (record) {
      receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.bytes));
      assert(plain(receipt) && Object.keys(receipt).length === 3 && receipt.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(receipt.licenseSha256) && typeof receipt.readAt === 'string' && Number.isFinite(Date.parse(receipt.readAt)), 'LICENSE_RECEIPT: 阅读记录不可读，原文件已保留。');
    }
    return { parent, record, text, sha256: license.sha256, acknowledged: receipt?.licenseSha256 === license.sha256 };
  }
  const snapshot = state => ({ text: state.text, sha256: state.sha256, acknowledged: state.acknowledged, prompt: true });
  return {
    read(owner) { const generation = epoch(owner); return serialize(async () => { active(owner, generation); const state = await load(); active(owner, generation); baselines.set(owner, state.sha256); return snapshot(state); }); },
    acknowledge(owner, request) { const generation = epoch(owner); return serialize(async () => {
      active(owner, generation);
      assert(plain(request) && Object.keys(request).length === 1 && typeof request.licenseSha256 === 'string' && baselines.get(owner) === request.licenseSha256, 'LICENSE_READ_FIRST: 请先读取本次许可全文。');
      const state = await load(); active(owner, generation);
      assert(state.sha256 === request.licenseSha256, 'LICENSE_CHANGED: 许可文件已变化，请重新阅读。');
      if (!state.acknowledged) {
        const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, licenseSha256: state.sha256, readAt: new Date().toISOString() }, null, 2) + '\n');
        await atomicWrite(file, bytes, state.record, state.parent, undefined, 4096);
      }
      active(owner, generation); const saved = await load(); active(owner, generation);
      assert(saved.acknowledged && saved.sha256 === state.sha256, 'LICENSE_READBACK: 阅读记录保存后核对失败。');
      return snapshot(saved);
    }); },
    disposeOwner(owner) { epochs.set(owner, epoch(owner) + 1); baselines.delete(owner); },
    settle: () => queue,
    dispose() { closed = true; baselines.clear(); },
  };
}
module.exports = { createFirstRunLicense };
