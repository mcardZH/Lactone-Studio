'use strict';
const { randomUUID } = require('node:crypto');
const security = require('./security.cjs');
const { copyWorkspaceSnapshotJSON, copyWorkspaceCommandJSON } = require('./workspace-snapshot-codec.mjs');

const SCHEMA = 'sciyue-workspace-document';
const VERSION = 1;
const MAX_DOCUMENTS = 64;
const MAX_MEMBERS = 32;
const COMMAND_TYPES = new Set([
  'model.execute', 'model.select', 'model.undo', 'model.redo', 'model.context', 'model.electronic-state',
  'chemistry.start', 'chemistry.cancel', 'dynamics.start', 'dynamics.command', 'input.draft-update', 'workspace.close-view', 'workspace.viewport-event',
]);
const { assert, plain, string } = security;
const identity = value => string(value, 200) && /^[a-zA-Z0-9_.:-]+$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;

// This is a transport broker, not a second ModelStore or a native-session owner.
// Only the authoritative renderer executes application/domain commands.
function jsonCopy(value, maximum = security.MAX_BYTES) {
  let nodes = 0;
  const visit = (item, depth) => {
    assert(depth <= 64 && ++nodes <= 250000, 'Workspace JSON complexity limit');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') { assert(Number.isFinite(item), 'Workspace JSON requires finite numbers'); return; }
    assert(Array.isArray(item) || plain(item), 'Workspace payload must be plain JSON');
    for (const key of Object.keys(item)) {
      assert(!['__proto__', 'constructor', 'prototype'].includes(key), 'Unsafe workspace JSON key');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      assert(descriptor && 'value' in descriptor, 'Workspace JSON cannot contain accessors');
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  assert(Buffer.byteLength(text) <= maximum, 'Workspace payload exceeds byte limit');
  return JSON.parse(text);
}
function snapshotCopy(value, kind = 'envelope') {
  try { return copyWorkspaceSnapshotJSON(value, kind); }
  catch (error) {
    const messages = new Map([
      ['共享文档 JSON 复杂度超过上限。', 'Workspace JSON complexity limit'],
      ['共享文档数值必须有限。', 'Workspace JSON requires finite numbers'],
      ['共享文档只能传输普通 JSON。', 'Workspace payload must be plain JSON'],
      ['共享文档包含不安全 JSON 字段。', 'Unsafe workspace JSON key'],
      ['共享文档不能传输访问器。', 'Workspace JSON cannot contain accessors'],
    ]);
    if (messages.has(error?.message)) throw new Error(messages.get(error.message));
    throw error;
  }
}
function keys(value, required, optional = []) {
  assert(plain(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Invalid workspace message fields');
}
function validateSnapshot(snapshot, documentId, currentRevision) {
  keys(snapshot, ['schema', 'version', 'document', 'documentEpoch', 'publicationSerial'], ['contexts', 'ui', 'runtime', 'metadata', 'viewport']);
  assert(snapshot.schema === SCHEMA && snapshot.version === VERSION && identity(snapshot.documentEpoch) && revision(snapshot.publicationSerial) && plain(snapshot.document), 'Unsupported workspace snapshot schema');
  const document = snapshot.document;
  if(snapshot.metadata!==undefined){const metadata=snapshot.metadata;keys(metadata,['label','electronicStateConfirmed','sourceEpoch','inputDirty']);assert(typeof metadata.label==='string'&&metadata.label.length<=512&&typeof metadata.electronicStateConfirmed==='boolean'&&revision(metadata.sourceEpoch),'Invalid workspace document metadata');keys(metadata.inputDirty,['gaussian','orca']);assert(typeof metadata.inputDirty.gaussian==='boolean'&&typeof metadata.inputDirty.orca==='boolean','Invalid workspace input dirty state');}
  assert(document.id === documentId && document.revision === currentRevision && plain(document.draft), 'Workspace snapshot identity mismatch');
  // A document replica transports the complete already-authored model. These
  // observed counts validate its records without adding a collection-size cap;
  // native chemistry and ordinary fragment IPC keep their own admission rules.
  const structure = document.draft.structure;
  const structureBudget = { maxAtoms: Math.max(1, structure?.atoms?.length || 0, document.draft.baseStructure?.atoms?.length || 0, document.cellCheckpoint?.structure?.atoms?.length || 0),
    maxBonds: Math.max(1, structure?.bonds?.length || 0, document.draft.baseStructure?.bonds?.length || 0, document.cellCheckpoint?.structure?.bonds?.length || 0),
    maxIssues: Math.max(1, structure?.bondPerceptionIssues?.length || 0, document.draft.baseStructure?.bondPerceptionIssues?.length || 0, document.cellCheckpoint?.structure?.bondPerceptionIssues?.length || 0) };
  const atomIds = security.validateStructure(structure, structureBudget);
  // A distinct saved baseline remains real scientific data, never silently
  // replaced by the current structure to reduce a transport payload.
  if (document.draft.baseStructure !== undefined) security.validateStructure(document.draft.baseStructure, structureBudget);
  if (document.cellCheckpoint?.structure !== undefined) security.validateStructure(document.cellCheckpoint.structure, structureBudget);
  if(document.bondOrderObservation!==undefined)security.validateBondOrderEvidence(document.bondOrderObservation,atomIds,true);
  assert(plain(document.draft.assignments), 'Invalid workspace assignments');
  security.validateClipboard({ schema: 'sciyue-model-fragment', version: 1, sourceDocumentId: documentId, fragment: {
    structure: document.draft.structure, assignments: document.draft.assignments,
    auxiliaryRelations: document.auxiliaryRelations, deletedBonds: document.deletedBonds,
    internalCoordinates: document.internalCoordinates, sharedConstraints: document.sharedConstraints, coordinateObjects: document.coordinateObjects, gaussianBoundCoordinates: document.gaussianBoundCoordinates, attachmentPorts: document.attachmentPorts,
  } }, structureBudget);
  assert(plain(document.selection) && Array.isArray(document.selection.atomIds) && document.selection.atomIds.every(id => atomIds.has(id)) && typeof document.canUndo === 'boolean' && typeof document.canRedo === 'boolean', 'Invalid workspace document state');
  assert(Array.isArray(document.draft.past) && document.draft.past.length === 0 && Array.isArray(document.draft.future) && document.draft.future.length === 0, 'Workspace authoritative history must stay with owner');
  if (snapshot.contexts !== undefined) {
    keys(snapshot.contexts, [], ['gaussian', 'orca']);
    for (const context of Object.values(snapshot.contexts)) {
      keys(context, ['assignments', 'coordinates']);
      security.validateClipboard({ schema: 'sciyue-model-fragment', version: 1, sourceDocumentId: documentId, fragment: { structure: document.draft.structure, assignments: context.assignments, internalCoordinates: context.coordinates, coordinateObjects: document.coordinateObjects, auxiliaryRelations: [], deletedBonds: [] } }, structureBudget);
    }
  }
}

function createWorkspaceDocuments({ send, nonce = randomUUID, setTimer = setTimeout, clearTimer = clearTimeout, commandTimeoutMs = 30000, closeTimeoutMs = 300000, onOwnerIdle = () => {} } = {}) {
  assert(typeof send === 'function' && Number.isInteger(commandTimeoutMs) && commandTimeoutMs > 0 && commandTimeoutMs <= 60000 && Number.isInteger(closeTimeoutMs) && closeTimeoutMs > 0 && closeTimeoutMs <= 600000, 'Invalid workspace broker configuration');
  const documents = new Map(), attachedWindows = new Set();
  // Saved IDs identify scientific objects inside a project, not a host-global
  // open instance. Copies intentionally retain those IDs. The authoritative
  // renderer is the runtime namespace; replicas still use their own nonce.
  const documentKey = (owner, documentId) => `${owner}:${documentId}`;
  const membershipDocument = (owner, documentId) => [...documents.values()].find(document => document.id === documentId && document.members.has(owner));
  let disposed = false;
  const active = () => assert(!disposed, 'Workspace broker is closed');
  const windowActive = owner => { active(); assert(attachedWindows.has(owner), 'Workspace window is closed or unregistered'); };
  function member(owner, request) {
    windowActive(owner);
    assert(identity(request.documentId) && string(request.membershipNonce, 200), 'Invalid workspace membership');
    const document = membershipDocument(owner, request.documentId), credential = document?.members.get(owner);
    assert(document && credential === request.membershipNonce, 'Workspace document membership denied');
    return document;
  }
  function envelope(document, owner) {
    return snapshotCopy({ schema: SCHEMA, version: VERSION, documentId: document.id, ownerWindowId: String(document.owner), memberWindowId: String(owner), isOwner: document.owner === owner, membershipNonce: document.members.get(owner), revision: document.revision, snapshot: document.snapshot });
  }
  function broadcast(document) {
    for (const owner of document.members.keys()) {
      try { send(owner, { kind: 'snapshot', ...envelope(document, owner) }); }
      catch {
        // A dead replica cannot roll back a canonical owner publication or
        // make an already-committed edit look like a failed edit to its owner.
        if (owner !== document.owner) {
          document.members.delete(owner);
          if (document.pending?.requester === owner) abandonRequester(document);
          clearDetached(document, owner);
        }
      }
    }
  }
  function checkedSnapshot(request) {
    assert(identity(request.documentId) && revision(request.revision), 'Invalid workspace document identity');
    const snapshot = snapshotCopy(request.snapshot, 'snapshot');
    validateSnapshot(snapshot, request.documentId, request.revision);
    return snapshot;
  }
  function finish(document, result, error) {
    const pending = document.pending;
    if (!pending) return;
    document.pending = null; clearTimer(pending.timer);
    if (error) pending.reject(error); else pending.resolve(snapshotCopy(result));
  }
  function abandonRequester(document) {
    const pending = document.pending;
    if (pending && !pending.abandoned) { pending.abandoned = true; pending.reject(new Error('Workspace requesting view closed; owner command continues')); }
  }
  function installSnapshot(document, request, allowCurrent = false) {
    const snapshot = checkedSnapshot(request);
    assert(snapshot.documentEpoch === document.snapshot.documentEpoch, 'Workspace document epoch mismatch');
    const newer = snapshot.publicationSerial > document.snapshot.publicationSerial;
    const same = allowCurrent && snapshot.publicationSerial === document.snapshot.publicationSerial && JSON.stringify(snapshot) === JSON.stringify(document.snapshot);
    assert(newer || same, 'Workspace publication serial is stale or inconsistent');
    if (newer) { document.snapshot = snapshot; document.revision = request.revision; broadcast(document); }
    return snapshot;
  }
  function ownerOnly(owner, request) {
    const document = member(owner, request);
    assert(document.owner === owner, 'Only the authoritative workspace owner may publish or reply');
    return document;
  }
  function idle(owner) { if (!hasOwnedDocuments(owner)) onOwnerIdle(owner); }
  function hasOwnedDocuments(owner) { return [...documents.values()].some(document => document.owner === owner); }
  function assertInternalDocumentRemains(document) {
    assert([...documents.values()].some(other => other.owner === document.owner && other.id !== document.id && other.detached == null && !other.closePending), 'WORKSPACE_LAST_INTERNAL: 主窗口至少需要保留一个内部建模页，请先新建或停靠另一个模型。');
  }
  function assertCommandAvailable(document) {
    assert(!document.closePending, 'WORKSPACE_CLOSING: 模型正在关闭，请先完成关闭确认。');
    assert(!document.pending, 'WORKSPACE_PENDING: 模型操作尚未确认，请稍后重试。');
    assert(!document.uncertain, 'WORKSPACE_UNCERTAIN: 模型状态尚未确认，请等待主工作台刷新后重试。');
  }
  function placement(document) {
    const event = { kind: 'placement', schema: SCHEMA, version: VERSION, documentId: document.id, ownerWindowId: String(document.owner), detachedWindowId: document.detached == null ? null : String(document.detached) };
    for (const target of document.members.keys()) { try { send(target, event); } catch { /* Placement does not transfer canonical ownership. */ } }
  }
  function finishClose(document, result, error) {
    const pending = document.closePending; if (!pending) return;
    document.closePending = null; clearTimer(pending.timer);
    if (error || result?.status === 'cancelled') closeState(document, pending, error ? 'failed' : 'cancelled');
    if (error) pending.reject(error); else pending.resolve(result);
  }
  function closeState(document, pending, phase) {
    const event = { kind: 'close-state', schema: SCHEMA, version: VERSION, documentId: document.id, requestId: pending.requestId, requesterWindowId: String(pending.requester), phase };
    for (const target of document.members.keys()) { try { send(target, event); } catch { /* A missing view cannot stop owner close cleanup. */ } }
  }
  function clearDetached(document, target) {
    if (document.detached !== target) return;
    document.detached = null; placement(document);
  }
  function activate(document) {
    send(document.owner, { kind: 'activate-document', schema: SCHEMA, version: VERSION, documentId: document.id, ownerWindowId: String(document.owner) });
    return { status: 'activated' };
  }
  return Object.freeze({
    attachWindow(owner) { active(); assert(Number.isSafeInteger(owner) && owner > 0 && !attachedWindows.has(owner), 'Invalid workspace window identity'); attachedWindows.add(owner); },
    register(owner, raw) {
      windowActive(owner); const request = snapshotCopy(raw);
      keys(request, ['documentId', 'revision', 'snapshot']);
      assert(documents.size < MAX_DOCUMENTS && !membershipDocument(owner, request.documentId), 'Workspace document already registered or document limit reached');
      const snapshot = checkedSnapshot(request);
      const document = { id: request.documentId, owner, revision: request.revision, snapshot, members: new Map([[owner, nonce()]]), pending: null, uncertain: false };
      documents.set(documentKey(owner, document.id), document); return envelope(document, owner);
    },
    read(owner) { windowActive(owner); return [...documents.values()].filter(document => document.members.has(owner)).map(document => envelope(document, owner)); },
    join(requester, target, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']);
      const document = member(requester, request); windowActive(target);
      assert(!membershipDocument(target, document.id) && document.members.size < MAX_MEMBERS, 'Workspace membership already exists or limit reached');
      document.members.set(target, nonce()); return envelope(document, target);
    },
    markDetached(owner, target, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']); const document = ownerOnly(owner, request);
      assert(!document.closePending, 'WORKSPACE_CLOSING: 模型正在关闭，请先完成关闭确认。');
      assert(document.detached == null && target !== owner && document.members.has(target), 'Workspace document already detached');
      assertInternalDocumentRemains(document);
      document.detached = target; placement(document); activate(document);
      return { windowId: String(target) };
    },
    authorizeDetach(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']); const document = ownerOnly(owner, request);
      assert(!document.closePending, 'WORKSPACE_CLOSING: 模型正在关闭，请先完成关闭确认。');
      assert(document.detached == null && document.members.size < MAX_MEMBERS, 'Workspace document already detached or member limit reached');
      assertInternalDocumentRemains(document);
      return request;
    },
    dock(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']); const document = member(owner, request);
      assert(!document.closePending, 'WORKSPACE_CLOSING: 模型正在关闭，请先完成关闭确认。');
      assert(document.detached != null && (owner === document.owner || owner === document.detached), 'Workspace document has no authorized detached view');
      const target = document.detached; document.members.delete(target);
      if (document.pending?.requester === target) abandonRequester(document);
      clearDetached(document, target); activate(document);
      return { status: 'docked', windowId: String(target) };
    },
    activate(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']); return activate(member(owner, request));
    },
    activateDetachedWindow(owner) {
      windowActive(owner); const document = [...documents.values()].find(document => document.detached === owner);
      return document ? activate(document) : null;
    },
    requestClose(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']); const document = member(owner, request);
      assert(owner === document.owner || owner === document.detached, 'Workspace document close is not authorized for this view');
      if (document.closePending) return document.closePending.promise;
      assertCommandAvailable(document);
      const requestId = nonce(); let resolve, reject;
      const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
      const pending = { requestId, requester: owner, promise, resolve, reject, timer: null }; document.closePending = pending;
      pending.timer = setTimer(() => finishClose(document, null, new Error('WORKSPACE_CLOSE_TIMEOUT: 关闭确认超时，模型已保留。')), closeTimeoutMs);
      closeState(document, pending, 'pending');
      try { send(document.owner, { kind: 'close-request', schema: SCHEMA, version: VERSION, documentId: document.id, requestId, requesterWindowId: String(owner) }); }
      catch (error) { finishClose(document, null, error); }
      return promise;
    },
    authorizeCloseConfirmation(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce', 'requestId']); const document = ownerOnly(owner, request), pending = document.closePending;
      assert(pending && pending.requestId === request.requestId, 'WORKSPACE_CLOSE_STALE: 关闭请求已结束或已变化，模型未关闭。');
      return { requesterWindowId: String(pending.requester), label: (document.snapshot.metadata?.label || document.snapshot.document.draft.structure.name || '未命名模型').slice(0, 512) };
    },
    authorizeScientificEditConfirmation(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce', 'expectedRevision'], ['copyOnly','purpose']);
      assert(request.copyOnly === undefined || typeof request.copyOnly === 'boolean', 'Invalid scientific edit copy-only mode');
      assert(request.purpose === undefined || request.copyOnly === true && request.purpose === 'file-import', 'Invalid scientific edit purpose');
      const document = ownerOnly(owner, request);
      assert(revision(request.expectedRevision) && request.expectedRevision === document.revision && !document.closePending, 'WORKSPACE_EDIT_STALE: 模型已变化或正在关闭。');
      return { requesterWindowId: String(document.detached ?? document.owner), label: (document.snapshot.metadata?.label || document.snapshot.document.draft.structure.name || '未命名模型').slice(0, 512) };
    },
    replyClose(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce', 'requestId', 'status'], ['error']); const document = ownerOnly(owner, request);
      const pending = document.closePending;
      assert(pending && pending.requestId === request.requestId && ['closed', 'cancelled'].includes(request.status), 'Workspace close response is stale or unknown');
      assert(request.error === undefined || string(request.error, 2048), 'Invalid workspace close error');
      if (request.status === 'cancelled') { finishClose(document, { status: 'cancelled' }); return { status: 'cancelled' }; }
      assert(!document.pending, 'WORKSPACE_PENDING: 模型操作尚未确认，请稍后重试。');
      assert(!document.uncertain, 'WORKSPACE_UNCERTAIN: 模型状态尚未确认，请等待主工作台刷新后重试。');
      const windowId = document.detached == null ? null : String(document.detached);
      documents.delete(documentKey(document.owner, document.id));
      for (const target of document.members.keys()) if (target !== document.owner) {
        try { send(target, { kind: 'unavailable', schema: SCHEMA, version: VERSION, documentId: document.id, reason: 'document-closed' }); } catch { /* A dead view cannot block an accepted close. */ }
      }
      finishClose(document, { status: 'closed', windowId }); idle(document.owner);
      return { status: 'closed' };
    },
    publish(owner, raw) {
      const request = snapshotCopy(raw); keys(request, ['documentId', 'membershipNonce', 'expectedRevision', 'revision', 'snapshot']);
      const document = ownerOnly(owner, request);
      assert(revision(request.expectedRevision) && request.expectedRevision === document.revision && request.revision >= document.revision, 'Workspace revision conflict');
      installSnapshot(document, request); document.uncertain = false;
      return envelope(document, owner);
    },
    command(owner, raw) {
      const request = copyWorkspaceCommandJSON(raw, 'request'); keys(request, ['documentId', 'membershipNonce', 'expectedRevision', 'command']);
      const document = member(owner, request);
      const command = request.command;
      // Saving is an intent for this fixed member/document lifetime. The owner
      // captures its current snapshot; no observed coordinates cross this path.
      const saveIntent = plain(command) && Object.keys(command).length === 2 && command.type === 'workspace.viewport-event'
        && plain(command.event) && Object.keys(command.event).length === 1 && command.event.type === 'save';
      assert(revision(request.expectedRevision) && request.expectedRevision <= document.revision, 'Workspace revision conflict');
      assert(plain(request.command) && COMMAND_TYPES.has(request.command.type), 'Unsupported workspace transport command type');
      if(command.type==='workspace.viewport-event'&&command.event?.type==='cip-used')security.validateCipUsageEvent(command.event);
      assertCommandAvailable(document);
      assert(saveIntent || request.expectedRevision === document.revision, 'Workspace revision conflict');
      const requestId = nonce();
      return new Promise((resolve, reject) => {
        const pending = { requestId, requester: owner, expectedRevision: request.expectedRevision, resolve, reject, timer: null };
        document.pending = pending;
        pending.timer = setTimer(() => { document.uncertain = true; finish(document, null, new Error('WORKSPACE_UNCERTAIN: 模型操作确认超时，状态暂未确认；请等待主工作台刷新后重试。')); }, commandTimeoutMs);
        try { send(document.owner, copyWorkspaceCommandJSON({ kind: 'command', schema: SCHEMA, version: VERSION, documentId: document.id, requestId, requesterWindowId: String(owner), expectedRevision: request.expectedRevision, command: request.command }, 'event')); }
        catch (error) { finish(document, null, error); }
      });
    },
    reply(owner, raw) {
      const request = snapshotCopy(raw); keys(request, ['documentId', 'membershipNonce', 'requestId', 'status'], ['revision', 'snapshot', 'error']);
      const document = ownerOnly(owner, request), pending = document.pending;
      assert(pending && pending.requestId === request.requestId && ['committed', 'rejected'].includes(request.status), 'Workspace command response is stale or unknown');
      if (request.status === 'rejected') {
        assert(string(request.error, 2048) && request.snapshot === undefined && request.revision === undefined, 'Invalid workspace rejection');
        finish(document, null, new Error(request.error)); return { status: 'rejected' };
      }
      assert(request.error === undefined && revision(request.revision) && request.revision >= document.revision && request.revision >= pending.expectedRevision, 'Invalid workspace committed revision');
      installSnapshot(document, request, true);
      finish(document, pending.abandoned ? { status: 'committed' } : { status: 'committed', ...envelope(document, pending.requester) });
      return { status: 'committed' };
    },
    leave(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']); const document = member(owner, request);
      // Owner membership is also the renderer's authority credential; it survives
      // hiding/closing the owner's view until explicit document release.
      if (document.owner !== owner) {
        document.members.delete(owner);
        if (document.pending?.requester === owner) abandonRequester(document);
        clearDetached(document, owner);
      }
      return { status: 'left', ownerRetained: document.owner === owner };
    },
    closeDocument(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']); const document = ownerOnly(owner, request);
      assert(!document.closePending, 'WORKSPACE_CLOSING: 模型正在关闭，请先完成关闭确认。');
      assert(document.members.size === 1 && !document.pending && !document.uncertain, 'Workspace document still has subscribed views, pending commands or unconfirmed state');
      documents.delete(documentKey(document.owner, document.id)); idle(owner); return { status: 'closed' };
    },
    hasOwnedDocuments,
    assertRuntimeOwner(owner, documentId) {
      windowActive(owner);
      const document = membershipDocument(owner, documentId);
      assert(!document || document.owner === owner, 'Shared document native runtime belongs to its authoritative owner');
    },
    authorizeOpen(owner, raw) {
      const request = jsonCopy(raw); keys(request, ['documentId', 'membershipNonce']);
      const document = member(owner, request);
      assert(document.members.size < MAX_MEMBERS, 'Workspace member limit reached');
      return request;
    },
    detachWindow(owner) {
      attachedWindows.delete(owner);
      for (const document of [...documents.values()]) {
        if (document.owner === owner) {
          finish(document, null, new Error('Workspace authoritative owner closed; document unavailable'));
          finishClose(document, null, new Error('Workspace authoritative owner closed; document unavailable'));
          for (const target of document.members.keys()) if (target !== owner) {
            try { send(target, { kind: 'unavailable', schema: SCHEMA, version: VERSION, documentId: document.id, reason: 'owner-closed' }); } catch { /* A dead replica cannot prevent owner cleanup. */ }
          }
          documents.delete(documentKey(document.owner, document.id));
        } else if (document.members.delete(owner)) {
          if (document.pending?.requester === owner) abandonRequester(document);
          if (document.closePending?.requester === owner) finishClose(document, null, new Error('Workspace closing view disappeared; document retained'));
          clearDetached(document, owner);
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const document of documents.values()) { finish(document, null, new Error('Workspace application is exiting')); finishClose(document, null, new Error('Workspace application is exiting')); }
      documents.clear(); attachedWindows.clear();
    },
  });
}
module.exports = { createWorkspaceDocuments, validateSnapshot, jsonCopy, SCHEMA, VERSION };
