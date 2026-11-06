'use strict';
const { Blob } = require('node:buffer');
const { assert, boundedJSON, validateClipboard, MAX_BYTES } = require('./security.cjs');

// A private MIME payload, not plain text: ordinary text paste is never a model.
const MODEL_CLIPBOARD_MIME = 'application/x-sciyue-model-fragment+json';

/** Electron 44 transport only. Importing this module never accesses the OS.
 * The caller supplies the current clipboard/ClipboardItem exports; tests may
 * supply an instance-private transport implementing that same async API.
 */
function createModelClipboard({ clipboard, ClipboardItem }) {
  assert(clipboard && ['has', 'read', 'write'].every(key => typeof clipboard[key] === 'function') && typeof ClipboardItem === 'function', 'Current asynchronous clipboard API is unavailable');
  return {
    async write(payload) {
      validateClipboard(payload);
      // Serialize before the first await, detaching the transport from its caller.
      const text = boundedJSON(payload);
      const item = new ClipboardItem({ [MODEL_CLIPBOARD_MIME]: new Blob([text], { type: MODEL_CLIPBOARD_MIME }) });
      await clipboard.write([item]);
    },
    async read() {
      if (!await clipboard.has(MODEL_CLIPBOARD_MIME)) return null;
      // API failures are observable IPC failures; malformed model data is null.
      const items = await clipboard.read();
      if (!Array.isArray(items) || items.length > 32) return null;
      for (const item of items) {
        if (!item || !Array.isArray(item.types) || !item.types.includes(MODEL_CLIPBOARD_MIME)) continue;
        if (typeof item.getType !== 'function') return null;
        const blob = await item.getType(MODEL_CLIPBOARD_MIME);
        if (!(blob instanceof Blob) || blob.size > MAX_BYTES) return null;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.byteLength > MAX_BYTES) return null;
        try {
          return validateClipboard(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        } catch { return null; }
      }
      return null;
    },
  };
}

module.exports = { createModelClipboard, MODEL_CLIPBOARD_MIME };
