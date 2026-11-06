'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSyProjectAssociation } = require('./sy-project-association.cjs');
const { ASSET_BATCH_ITEMS, ASSET_BATCH_BYTES } = require('./sy-project-store.cjs');
const CHUNK_BYTES = ASSET_BATCH_BYTES;
const invalid = message => { throw Object.assign(new Error(message), { code: 'SY_INVALID_REQUEST' }); };
function createSyProjectIPC({ store, dialog, ownerWindow, createWindow, executablePath, association = createSyProjectAssociation({ executablePath }) } = {}) {
  if (!store || !dialog || typeof createWindow !== 'function') throw new Error('Project IPC requires store, dialog and window factory.');
  const owned = new Map(), pending = new Map(), disposed = new Set(), locations = new Map();
  function owner(window) {
    const resolved = typeof ownerWindow === 'function' ? ownerWindow(window) : window;
    if (!resolved || resolved.isDestroyed?.() || !Number.isSafeInteger(resolved.webContents?.id)) invalid('Project owner window is unavailable.');
    return resolved;
  }
  const ownerId = window => owner(window).webContents.id;
  function bind(window, description) {
    const id = ownerId(window);
    if (disposed.has(id)) throw Object.assign(new Error('Project window has closed.'), { code: 'SY_OWNER_CLOSED' });
    owned.set(description.sessionId, id); return description;
  }
  function authorize(window, sessionId) {
    if (typeof sessionId !== 'string' || owned.get(sessionId) !== ownerId(window)) throw Object.assign(new Error('Project session belongs to another window.'), { code: 'SY_OWNER_MISMATCH' });
  }
  function enqueue(window, indexPath) {
    const id = ownerId(window);
    if (typeof indexPath !== 'string' || !path.isAbsolute(indexPath) || !['.es', '.sy'].includes(path.extname(indexPath).toLowerCase())) invalid('A trusted absolute .es or legacy .sy path is required.');
    if (pending.has(id)) throw Object.assign(new Error('A project is already pending for this window.'), { code: 'SY_PENDING_PROJECT' });
    pending.set(id, path.resolve(indexPath));
  }
  async function recover(window, indexPath) {
    const inspected = await store.inspectRecovery(indexPath);
    const kinds = ['auto', 'previous'].filter(kind => inspected.points[kind]);
    if (!kinds.length) throw Object.assign(new Error('项目索引不可用，且没有有效恢复点。'), { code: 'SY_RECOVERY_MISSING' });
    const choice = await dialog.showMessageBox(window, { type: 'question', title: '恢复项目', message: '项目索引不可用，选择一个有效保存点恢复。', detail: '恢复后为未保存状态；原手动保存点不会被自动覆盖。', buttons: [...kinds.map(kind => kind === 'auto' ? '恢复自动快照' : '恢复上一手动保存'), '取消'], cancelId: kinds.length, defaultId: 0, noLink: true });
    if (choice.response >= kinds.length) return { cancelled: true };
    const description = await store.open(indexPath, { recovery: kinds[choice.response] });
    return { ...description, recovered: true };
  }
  async function claim(window) {
    const id = ownerId(window), indexPath = pending.get(id);
    if (!indexPath) return { pending: false };
    let description;
    try { description = await store.open(indexPath); } catch (error) {
      if (!(error instanceof SyntaxError) && !['SY_INDEX_MISSING', 'SY_INVALID_INDEX'].includes(error.code)) throw error;
      description = await recover(window, indexPath);
    }
    if (description.cancelled) { pending.delete(id); return description; }
    try {
      const automatic = description.recovery?.auto;
      if (!description.recovered && automatic && automatic.generation > description.manifest.generation) {
        const choice = await dialog.showMessageBox(window, { type: 'question', title: '恢复项目', message: '此项目有较新的自动恢复快照。', detail: '恢复快照会保留手动保存点，并将项目标记为未保存。', buttons: ['恢复自动快照', '打开手动保存点', '取消'], defaultId: 0, cancelId: 2, noLink: true });
        if (choice.response === 2) { await store.close(description.sessionId); pending.delete(id); return { cancelled: true }; }
        if (choice.response === 0) { await store.close(description.sessionId); description = { ...await store.open(indexPath, { recovery: 'auto' }), recovered: true }; }
      }
      bind(window, description); pending.delete(id); return description;
    } catch (error) { try { await store.close(description.sessionId); } catch { /* Keep primary failure. */ } throw error; }
  }
  async function invoke(window, request) {
    try {
      const current = owner(window), id = current.webContents.id;
      if (disposed.has(id)) throw Object.assign(new Error('Project window is closed.'), { code: 'SY_OWNER_CLOSED' });
      if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') invalid('Invalid project request.');
      // Paths are accepted only through enqueue (trusted main) or native dialogs.
      if ('indexPath' in request || 'sourcePath' in request || 'path' in request || 'executablePath' in request) invalid('Renderer-supplied project/source paths are forbidden.');
      let value;
      switch (request.action) {
        case 'choose-location': {
          const selected = await dialog.showOpenDialog(current, { title: '选择项目保存位置', properties: ['openDirectory', 'createDirectory'] });
          if (selected.canceled || !selected.filePaths?.length) { value = { cancelled: true }; break; }
          for (const [token, location] of locations) if (location.ownerId === id) locations.delete(token);
          const locationToken = randomUUID(); locations.set(locationToken, { ownerId: id, parent: selected.filePaths[0] });
          value = { locationToken, label: selected.filePaths[0] }; break;
        }
        case 'create': {
          const name = request.name || 'project';
          if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) || /\.$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) invalid('项目名称请使用ASCII字母、数字、连字符、下划线或点。');
          let parent;
          if (request.locationToken !== undefined) {
            const location = locations.get(request.locationToken);
            if (!location || location.ownerId !== id) invalid('项目保存位置授权已失效，请重新选择。');
            parent = location.parent; locations.delete(request.locationToken);
          } else {
            const selected = await dialog.showOpenDialog(current, { title: '选择项目保存位置', properties: ['openDirectory', 'createDirectory'] });
            if (selected.canceled || !selected.filePaths?.length) { value = { cancelled: true }; break; }
            parent = selected.filePaths[0];
          }
          const indexPath = path.join(parent, name, `${name}.es`);
          const description = await store.create(indexPath);
          try { value = bind(current, description); } catch (error) { await store.close(description.sessionId); throw error; }
          break;
        }
        case 'open-new': {
          const selected = await dialog.showOpenDialog(current, { title: '打开 Ester Studio 项目', properties: ['openFile'], filters: [{ name: 'Ester Studio 项目（.es；兼容 .sy）', extensions: ['es', 'sy'] }] });
          if (selected.canceled || !selected.filePaths?.length) { value = { cancelled: true }; break; }
          const indexPath = selected.filePaths[0];
          if (!['.es', '.sy'].includes(path.extname(indexPath).toLowerCase())) invalid('请选择 .es 项目入口（兼容旧 .sy 项目）。');
          const next = await createWindow(); enqueue(next, indexPath); value = { opened: true, windowId: next.id ?? next.webContents.id }; break;
        }
        case 'claim': value = await claim(current); break;
        case 'associate':
        case 'association-status':
        case 'association-register':
        case 'association-remove': {
          if (Object.keys(request).some(key => key !== 'action')) invalid('File association requests accept only an explicit action.');
          // Only the trusted main supplies the launcher. Recheck the exact
          // initiating webContents and its lifetime after every async boundary.
          const assertOwner = () => {
            if (disposed.has(id) || owner(window) !== current || current.webContents.id !== id) throw Object.assign(new Error('Project window has closed or changed.'), { code: 'SY_OWNER_CLOSED' });
          };
          const action = request.action === 'association-status' ? 'status' : request.action === 'association-remove' ? 'remove' : 'register';
          value = await association[action]({ assertOwner }); assertOwner(); break;
        }
        default: {
          authorize(current, request.sessionId);
          const sessionId = request.sessionId;
          switch (request.action) {
            case 'begin': value = await store.begin(sessionId, { kind: request.kind, state: request.state, assetIds: request.assetIds }); break;
            case 'chunk': {
              if ((request.bytes?.byteLength ?? request.bytes?.length ?? 0) > CHUNK_BYTES) invalid('Project IPC chunk exceeds 1 MiB.');
              value = await store.writeAssetChunk(sessionId, request.transactionId, { uploadId: request.uploadId, bytes: request.bytes, final: request.final, category: request.category, originalName: request.originalName, expectedSha256: request.expectedSha256, expectedBytes: request.expectedBytes }); break;
            }
            case 'assets': {
              if (!Array.isArray(request.assets) || request.assets.length < 1 || request.assets.length > ASSET_BATCH_ITEMS || request.assets.reduce((sum, asset) => sum + (asset?.bytes?.byteLength ?? asset?.bytes?.length ?? 0), 0) > CHUNK_BYTES) invalid('Complete project assets exceed the bounded group size.');
              value = await store.writeAssets(sessionId, request.transactionId, { assets: request.assets }); break;
            }
            case 'commit': value = await store.commit(sessionId, request.transactionId, { state: request.state, assetIds: request.assetIds, requiredFormatVersion: request.requiredFormatVersion }); break;
            case 'abort': await store.abort(sessionId, request.transactionId); value = { aborted: true }; break;
            case 'read': {
              const length = request.length ?? CHUNK_BYTES;
              if (!Number.isSafeInteger(length) || length < 1 || length > CHUNK_BYTES) invalid('Project read exceeds 1 MiB.');
              value = await store.readAsset(sessionId, request.assetId, { offset: request.offset, length }); break;
            }
            case 'read-assets': {
              if (Object.keys(request).some(key => !['action','sessionId','assetIds'].includes(key)) || !Array.isArray(request.assetIds) || request.assetIds.length < 1 || request.assetIds.length > ASSET_BATCH_ITEMS) invalid('Invalid complete project asset read.');
              value = await store.readAssets(sessionId, { assetIds: request.assetIds }); break;
            }
            case 'gc': value = await store.gc(sessionId); break;
            case 'close': await store.close(sessionId); owned.delete(sessionId); value = { closed: true }; break;
            default: invalid('Unknown project action.');
          }
        }
      }
      return { ok: true, value };
    } catch (error) { return { ok: false, error: { code: error.code || 'SY_PROJECT_OPERATION_FAILED', message: error.message || 'Project operation failed.' } }; }
  }
  async function disposeOwner(window) {
    const id = typeof window === 'number' ? window : window?.webContents?.id;
    if (!Number.isSafeInteger(id)) return;
    disposed.add(id); pending.delete(id); const failures = [];
    for (const [token, location] of locations) if (location.ownerId === id) locations.delete(token);
    for (const [sessionId, sessionOwner] of owned) if (sessionOwner === id) {
      try { await store.close(sessionId); owned.delete(sessionId); } catch (error) { failures.push({ sessionId, code: error.code || 'SY_CLOSE_FAILED' }); }
    }
    return { failures };
  }
  return { invoke, enqueue, disposeOwner };
}
module.exports = { createSyProjectIPC, CHUNK_BYTES };
