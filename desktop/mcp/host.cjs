'use strict';
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isRecord, isId, isToolName, isToolDescriptor, isSecret, newSecret, failure, errorRecord, proof, verifyProof, readMessages, sendMessage } = require('./wire.cjs');
const { hash, protect, pipeName, writePrivateJSON } = require('./identity.cjs');

const clientFingerprint = (label, key) => hash(JSON.stringify([label, key]));

function checkedCatalog(value) {
  if (!isRecord(value) || !Array.isArray(value.tools)) throw failure('invalid_catalog', '无效的 ES 操作目录。');
  const names = new Set();
  for (const tool of value.tools) {
    if (!isToolDescriptor(tool) || names.has(tool.name)) {
      throw failure('invalid_catalog', 'ES 操作目录含无效或重复的项目。');
    }
    names.add(tool.name);
  }
  return { tools: value.tools, names };
}

function createMcpHost({ profileRoot, discoveryDir, executable, entry, send, confirm, show, log = () => {}, protection = { protect }, listenPath = pipeName }) {
  const instanceId = randomUUID();
  const instanceSecret = newSecret();
  const descriptor = discoveryDir && path.join(discoveryDir, 'instances', `${instanceId}.json`);
  const rememberedFile = path.join(profileRoot, 'mcp-clients-v1.json');
  const windows = new Map();
  const sockets = new Set();
  const sessions = new Map();
  const requests = new Map();
  const remembered = new Map();
  const consentQueues = new Map();
  const consentCancellations = new Map();
  const catalogListeners = new Set();
  let server, startTask, closeTask, protectedSecret;
  let stopped = false, available = false, startupError;
  let discoveryWrite = Promise.resolve();
  let rememberWrite = Promise.resolve();

  const targetOf = row => ({ instanceId, windowId: row.windowId });
  const windowRow = owner => {
    const row = windows.get(owner);
    if (!row) throw failure('window_unavailable', '目标 ES 窗口已关闭。');
    return row;
  };
  const sessionsFor = owner => [...sessions.values()].filter(session => session.owner === owner);
  const publicSession = session => ({ id: session.id, clientName: session.clientName, remembered: remembered.has(session.clientIdentity) });
  function state(owner) {
    const row = windowRow(owner);
    return {
      ...targetOf(row), available,
      ...(startupError ? { error: errorRecord(startupError) } : {}),
      connections: sessionsFor(owner).map(publicSession),
      rememberedClients: [...remembered].map(([id, clientName]) => ({ id, clientName })),
    };
  }
  function sendTo(owner, channel, value) {
    try { return send(owner, channel, value); }
    catch { return false; }
  }
  function updateState(owner) {
    if (windows.has(owner)) sendTo(owner, 'mcp-state', state(owner));
  }
  function updateAll() { for (const owner of windows.keys()) updateState(owner); }
  function notifyCatalogChanged() {
    for (const listener of catalogListeners) {
      try { listener(); } catch (error) { report(error); }
    }
  }

  function report(error) { log(errorRecord(error).code); }
  function updateDiscovery() {
    const publication = discoveryWrite.then(async () => {
      if (!available || stopped) return;
      const registeredWindows = [...windows.values()].filter(row => row.catalog?.tools.length);
      // Some clients cache their first tools/list result. Only public descriptors
      // are advertised here. A session still needs consent to call any ES tool.
      const tools = [...new Map(registeredWindows.flatMap(row => row.catalog.tools).map(tool => [
        tool.name, { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
      ])).values()];
      await writePrivateJSON(descriptor, { version: 1, instanceId, pid: process.pid, executable, protectedSecret, windows: registeredWindows.map(targetOf), tools });
    });
    discoveryWrite = publication.catch(error => report(failure('discovery_write_failed', String(error))));
    return publication;
  }
  async function loadRemembered() {
    let disk;
    try { disk = JSON.parse(await fs.readFile(rememberedFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') report(failure('remembered_clients_read_failed', String(error))); return; }
    if (disk?.version !== 1 || !Array.isArray(disk.clients)) return;
    for (const { id, clientName } of disk.clients.filter(isRecord)) {
      if (isSecret(id) && typeof clientName === 'string') remembered.set(id, clientName);
    }
  }
  function changeRemembered(mutator) {
    const next = rememberWrite.then(async () => {
      const updated = new Map(remembered);
      mutator(updated);
      const clients = [...updated].map(([id, clientName]) => ({ id, clientName }));
      await writePrivateJSON(rememberedFile, { version: 1, clients });
      remembered.clear();
      for (const [id, name] of updated) remembered.set(id, name);
      updateAll();
    });
    rememberWrite = next.catch(() => {});
    return next;
  }

  function assertRequest(owner, requestId) {
    const request = requests.get(requestId);
    if (!request || request.owner !== owner || request.signal.aborted) throw failure('request_unavailable', 'ES 请求已结束、取消或不属于当前窗口。');
    return Object.defineProperty({ ...request.payload }, 'signal', { value: request.signal });
  }
  function afterReply(owner, requestId, callback) {
    assertRequest(owner, requestId);
    const request = requests.get(requestId);
    if (request.afterReply) throw failure('operation_pending', '此 ES 请求已有待处理的原生操作。');
    request.afterReply = callback;
  }
  function cancellation(owner, requestId) {
    sendTo(owner, 'mcp-cancel', { requestId });
    return failure('cancelled', 'ES 操作等待已取消。');
  }
  function dispatch(owner, session, name, args, signal) {
    const row = windowRow(owner);
    if (!row.catalog?.names.has(name)) throw failure('unknown_tool', `当前窗口未开放操作 ${name}。`);
    if (!isRecord(args)) throw failure('invalid_arguments', 'ES 操作参数必须是对象。');
    if (signal?.aborted) throw failure('cancelled', 'ES 操作等待已取消。');
    const requestId = randomUUID();
    const target = targetOf(row);
    const payload = { requestId, name, arguments: args, target, session: { id: session.id, clientName: session.clientName, ...target } };
    const invocation = new AbortController();
    return new Promise((resolve, reject) => {
      const abort = () => {
        invocation.abort(signal?.reason);
        finish(reject, cancellation(owner, requestId));
      };
      const finish = (complete, value) => {
        requests.delete(requestId);
        signal?.removeEventListener('abort', abort);
        complete(value);
      };
      requests.set(requestId, { owner, payload, signal: invocation.signal, abort,
        resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      signal?.addEventListener('abort', abort, { once: true });
      if (sendTo(owner, 'mcp-request', payload) === false) finish(reject, failure('window_unavailable', '目标 ES 窗口无法接收操作。'));
    });
  }
  function reply(owner, response) {
    if (!isRecord(response) || !isId(response.requestId)) throw failure('invalid_reply', '无效的 ES 窗口回执。');
    const request = requests.get(response.requestId);
    if (request?.owner !== owner) return { accepted: false };
    if (response.ok === true) {
      request.resolve(response.value === undefined ? null : response.value);
      if (request.afterReply) setImmediate(() => {
        try { request.afterReply(); } catch (error) { report(error); }
      });
    }
    else if (response.ok === false && typeof response.error?.code === 'string' && typeof response.error.message === 'string') {
      request.reject(failure(response.error.code, response.error.message, response.error.data));
    } else request.reject(failure('invalid_reply', '无效的 ES 窗口回执。'));
    return { accepted: true };
  }
  function approvedTargets(session) {
    return [...new Set([...sessions.values()].filter(row => row.clientIdentity === session.clientIdentity && row.adapterId === session.adapterId).map(row => row.owner))]
      .map(owner => windows.get(owner)).filter(Boolean).map(targetOf);
  }
  function windowTargets(target, windows, args) {
    const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
    const cursor = args.cursor ?? 0, limit = args.limit ?? 100;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw failure('invalid_page', '分页参数无效。');
    }
    const entries = windows.map(row => ({
      ...row, ref: row.windowId, kind: 'window', label: 'Lactone Studio 窗口', current: row.windowId === target.windowId,
    })).filter(row => !query || [row.instanceId, row.windowId, row.label].some(value => value.toLowerCase().includes(query)));
    return {
      ...target, windows: entries.map(({ instanceId, windowId }) => ({ instanceId, windowId })),
      items: entries.slice(cursor, cursor + limit), total: entries.length, nextCursor: cursor + limit < entries.length ? cursor + limit : null,
    };
  }

  async function grant(owner, clientIdentity, clientName, signal) {
    const before = consentQueues.get(owner) || Promise.resolve();
    const next = before.then(async () => {
      if (signal.aborted || !windows.has(owner)) throw failure('window_unavailable', '目标 ES 窗口已关闭。');
      if (remembered.has(clientIdentity)) return;
      const decision = await confirm(owner, clientName, signal);
      if (signal.aborted || !windows.has(owner)) throw failure('connection_cancelled', 'ES 连接已取消。');
      if (decision !== 'once' && decision !== 'remember') throw failure('connection_denied', '窗口用户拒绝了 ES 连接。');
      if (decision === 'remember') {
        try { await changeRemembered(rows => rows.set(clientIdentity, clientName)); }
        catch { throw failure('remembered_clients_write_failed', '无法保存已批准的 ES 客户端。请修复存储或选择仅本次。'); }
      }
    });
    const tail = next.catch(() => {});
    consentQueues.set(owner, tail);
    try { await next; }
    finally { if (consentQueues.get(owner) === tail) consentQueues.delete(owner); }
  }

  function accept(socket) {
    sockets.add(socket);
    socket.on('error', () => {});
    const serverNonce = newSecret();
    const abort = new AbortController();
    const calls = new Map();
    let authenticated = false, connecting = false, session;
    let retired = false;
    function releaseSession() {
      if (retired) return;
      retired = true;
      abort.abort();
      for (const controller of calls.values()) controller.abort();
      if (!session) return;
      sessions.delete(session.id);
      updateState(session.owner);
    }
    socket.once('close', () => {
      sockets.delete(socket);
      releaseSession();
    });
    socket.setTimeout(10000, () => socket.destroy());
    sendMessage(socket, { type: 'hello', instanceId, nonce: serverNonce });
    const lines = readMessages(socket, message => {
      if (!authenticated) {
        if (message?.type !== 'auth' || !isSecret(message.nonce) || !verifyProof(message.proof, proof(instanceSecret, 'client', instanceId, serverNonce, message.nonce))) {
          socket.destroy(); return;
        }
        authenticated = true;
        socket.setTimeout(0);
        sendMessage(socket, { type: 'auth', proof: proof(instanceSecret, 'server', instanceId, serverNonce, message.nonce) });
        return;
      }
      if (!session) {
        if (connecting || message?.type !== 'connect' || !isId(message.windowId) || !isId(message.adapterId) || !isSecret(message.clientKey) ||
            typeof message.clientLabel !== 'string' || !message.clientLabel || message.clientLabel.length > 160) { socket.destroy(); return; }
        connecting = true;
        void (async () => {
          const found = [...windows].find(([, row]) => row.windowId === message.windowId && row.catalog?.tools.length);
          if (!found) throw failure('window_unavailable', '目标 ES 窗口尚未就绪或已关闭。');
          const [owner, row] = found;
          const clientIdentity = clientFingerprint(message.clientLabel, message.clientKey);
          const clientName = message.clientLabel.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim() || 'MCP 客户端';
          consentCancellations.set(abort, owner);
          try { await grant(owner, clientIdentity, clientName, abort.signal); }
          finally { consentCancellations.delete(abort); }
          if (socket.destroyed || abort.signal.aborted || windows.get(owner) !== row) return;
          const id = randomUUID();
          session = { id, owner, clientIdentity, clientName, adapterId: message.adapterId, socket, close() { releaseSession(); socket.destroy(); } };
          sessions.set(id, session);
          sendMessage(socket, { type: 'connected', result: { ...targetOf(row), sessionId: id, remembered: remembered.has(clientIdentity), tools: row.catalog.tools } });
          updateState(owner);
        })().catch(error => {
          if (!socket.destroyed) socket.end(`${JSON.stringify({ type: 'connection-error', error: errorRecord(error) })}\n`);
        });
        return;
      }
      if (message?.type === 'cancel') { calls.get(message.id)?.abort(); return; }
      if (message?.type !== 'call' || !isId(message.id) || calls.has(message.id) || !isToolName(message.name) || !isRecord(message.arguments)) {
        socket.destroy(); return;
      }
      const controller = new AbortController();
      calls.set(message.id, controller);
      Promise.resolve().then(() => {
        const row = windowRow(session.owner);
        if (message.name === 'es_targets' && message.arguments.kind === 'window' && row.catalog.names.has(message.name)) {
          return windowTargets(targetOf(row), approvedTargets(session), message.arguments);
        }
        return dispatch(session.owner, session, message.name, message.arguments, controller.signal);
      }).then(
        result => sendMessage(socket, { type: 'result', id: message.id, result }),
        error => sendMessage(socket, { type: 'result', id: message.id, error: errorRecord(error) }),
      ).catch(() => socket.destroy()).finally(() => calls.delete(message.id));
    }, () => socket.destroy());
    lines.on('error', () => socket.destroy());
  }

  function start() {
    if (startTask) return startTask;
    startTask = (async () => {
      if (!descriptor) throw failure('discovery_unavailable', '找不到当前用户的 ES 连接目录。');
      await loadRemembered();
      protectedSecret = (await protection.protect(Buffer.from(instanceSecret, 'ascii'))).toString('base64');
      if (stopped) return;
      const endpoint = listenPath(instanceId);
      const isUnixSocket = typeof endpoint === 'string' && process.platform !== 'win32' && !endpoint.startsWith('\\\\.\\pipe\\');
      if (isUnixSocket) await fs.unlink(endpoint).catch(() => {});
      server = net.createServer(accept);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => { server.off('error', reject); resolve(); });
      });
      if (isUnixSocket) await fs.chmod(endpoint, 0o600).catch(() => {});
      server.on('error', error => { report(error); });
      if (stopped) return;
      available = true;
      await updateDiscovery();
    })().catch(error => {
      available = false;
      startupError = error;
      if (server?.listening) server.close();
      report(error);
    }).finally(updateAll);
    return startTask;
  }

  function attach(owner) {
    if (!windows.has(owner)) windows.set(owner, { windowId: randomUUID(), catalog: null });
  }
  function resetOwner(owner) {
    const row = windowRow(owner);
    disposeOwner(owner);
    windows.set(owner, { windowId: row.windowId, catalog: null });
  }
  async function publish(owner, value) {
    const row = windowRow(owner);
    const catalog = checkedCatalog(value);
    const fingerprint = JSON.stringify(catalog.tools);
    if (row.fingerprint === fingerprint) return state(owner);
    row.catalog = catalog;
    row.fingerprint = fingerprint;
    for (const session of sessionsFor(owner)) sendMessage(session.socket, { type: 'tools-changed', tools: catalog.tools });
    notifyCatalogChanged();
    await updateDiscovery().catch(() => {});
    return state(owner);
  }
  function disposeOwner(owner) {
    if (!windows.delete(owner)) return;
    for (const [controller, targetOwner] of consentCancellations) if (targetOwner === owner) controller.abort();
    for (const session of sessionsFor(owner)) session.close();
    for (const request of requests.values()) if (request.owner === owner) request.abort();
    notifyCatalogChanged();
    void updateDiscovery().catch(() => {});
  }
  function disconnect(owner, sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.owner !== owner) return { disconnected: false };
    session.close();
    return { disconnected: true };
  }
  async function forget(owner, id) {
    windowRow(owner);
    if (!remembered.has(id)) return { forgotten: false };
    await changeRemembered(rows => rows.delete(id));
    for (const session of sessions.values()) if (session.clientIdentity === id) session.close();
    return { forgotten: true };
  }
  function connectionConfig(owner) {
    const { windowId } = windowRow(owner);
    if (!discoveryDir) throw failure('discovery_unavailable', '找不到当前用户的 ES 连接目录。');
    return {
      command: executable, args: [entry],
      env: { ELECTRON_RUN_AS_NODE: '1', ES_MCP_DISCOVERY_DIR: discoveryDir, ES_MCP_INSTANCE_ID: instanceId, ES_MCP_WINDOW_ID: windowId },
    };
  }
  async function invokeDirect(owner, { id, clientName, allWindows = false }, name, args, { signal } = {}) {
    if (signal?.aborted) throw failure('cancelled', 'ES 操作等待已取消。');
    const row = windowRow(owner);
    if (name === 'es_targets' && args?.kind === 'window' && row.catalog?.names.has(name)) {
      const target = targetOf(row);
      const visibleWindows = allWindows
        ? [...windows.values()].filter(candidate => candidate.catalog?.tools.length).map(targetOf)
        : [target];
      return windowTargets(target, visibleWindows.length ? visibleWindows : [target], args);
    }
    return dispatch(owner, { id, clientName }, name, args, signal);
  }
  function callLocal(owner, name, args, options = {}) {
    return invokeDirect(owner, { id: `es-assistant-${owner}`, clientName: 'Lactone Studio 助手', allWindows: false }, name, args, options);
  }
  function callExternal(owner, { id, clientName } = {}, name, args, options = {}) {
    return invokeDirect(owner, {
      id: typeof id === 'string' && id ? id : `lactone-mcp-${owner}`,
      clientName: typeof clientName === 'string' && clientName ? clientName : 'Lactone Studio MCP Bridge',
      allWindows: true,
    }, name, args, options);
  }
  function onCatalogChanged(listener) {
    if (typeof listener !== 'function') throw new TypeError('Catalog listener must be a function');
    catalogListeners.add(listener);
    return () => catalogListeners.delete(listener);
  }
  function close() {
    if (closeTask) return closeTask;
    stopped = true;
    available = false;
    catalogListeners.clear();
    for (const owner of [...windows.keys()]) disposeOwner(owner);
    for (const socket of sockets) socket.destroy();
    closeTask = (async () => {
      await startTask;
      await Promise.all([discoveryWrite, rememberWrite]);
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      if (process.platform !== 'win32') {
        try {
          const endpoint = listenPath(instanceId);
          if (typeof endpoint === 'string' && !endpoint.startsWith('\\\\.\\pipe\\')) {
            await fs.unlink(endpoint).catch(() => {});
          }
        } catch { /* ignore */ }
      }
      if (descriptor) await fs.unlink(descriptor).catch(error => { if (error.code !== 'ENOENT') report(error); });
    })();
    return closeTask;
  }

  return { start, close, attach, resetOwner, disposeOwner, publish, reply, assertRequest, afterReply, state, disconnect, forget, connectionConfig, callLocal, callExternal, onCatalogChanged,
    show: (owner, request) => { windowRow(owner); return show(owner, request); },
    listTools: owner => windowRow(owner).catalog?.tools || [],
  };
}

module.exports = { createMcpHost };
