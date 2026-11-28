'use strict';
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { isRecord, isSecret, isId, isToolName, newSecret, failure, errorRecord, proof, verifyProof, readMessages, sendMessage } = require('./wire.cjs');
const { discoveryDirectory, discover, unprotect, clientIdentity, pipeName, sameExecutable, MCP_CONNECT_LAUNCH } = require('./identity.cjs');
const { resolvePortableLayout } = require('../portable-layout.cjs');
const { splitImageResult } = require('./image-result.cjs');
const { version } = require('../../package.json');

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const connectTool = {
  name: 'es_connect',
  description: 'Connect to or select a Lactone Studio window. With no target, use the embedded terminal window or the only window of this installation. If this installation is closed, launch its application automatically. If multiple windows are available, specify instanceId and windowId from the response. The user approves the first actual connection in that window.',
  inputSchema: { type: 'object', properties: { instanceId: { type: 'string' }, windowId: { type: 'string' } }, additionalProperties: false },
};
const callToolByName = {
  name: 'es_call',
  description: 'Use an operation in the already connected Ester Studio window when your client has not refreshed its tool list. To discover operations, pass name="es_capabilities" and arguments={"query":"topic"}. For an exact input schema, pass name="es_capabilities" and arguments={"action":"es_import"} (or the operation you need). Then pass the operation name and its arguments here.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } },
    required: ['name'],
    additionalProperties: false,
  },
};
const adapterTools = [connectTool, callToolByName];
function withAdapterTools(workspaceTools) {
  return { tools: [...adapterTools, ...workspaceTools.filter(tool => !adapterTools.some(adapter => adapter.name === tool.name))] };
}
const aborted = () => failure('cancelled', 'ES 操作等待已取消。');

async function openBinding({ target, instance, dir, label, adapterId, signal, onTools, onClose, unseal = unprotect, getClientIdentity = clientIdentity, connectPath = pipeName }) {
  const [secret, clientKey] = await Promise.all([
    unseal(Buffer.from(instance.protectedSecret, 'base64')).then(value => value.toString('ascii')),
    getClientIdentity(dir, label),
  ]);
  if (!isSecret(secret) || !isSecret(clientKey)) throw failure('authentication_failed', '无效的 ES 凭据。');
  if (signal?.aborted) throw aborted();
  const socket = net.createConnection(connectPath(instance.instanceId));
  const clientNonce = newSecret();
  const calls = new Map();
  const binding = { target, tools: [], receipt: null, call, close: () => socket.destroy() };
  let serverNonce, phase = 'hello';
  function call(name, args, callSignal) {
    if (socket.destroyed || phase !== 'ready') throw failure('connection_closed', 'ES 窗口连接已断开。');
    if (callSignal?.aborted) throw aborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => { sendMessage(socket, { type: 'cancel', id }); finish(reject, aborted()); };
      const finish = (complete, result) => {
        calls.delete(id);
        callSignal?.removeEventListener('abort', abort);
        complete(result);
      };
      calls.set(id, { name, resolve: result => finish(resolve, result), reject: error => finish(reject, error) });
      callSignal?.addEventListener('abort', abort, { once: true });
      try { sendMessage(socket, { type: 'call', id, name, arguments: args }); }
      catch (error) { finish(reject, error); }
    });
  }
  return new Promise((resolve, reject) => {
    const stop = () => quit(aborted());
    function quit(error) { reject(error); socket.destroy(); }
    signal?.addEventListener('abort', stop, { once: true });
    socket.on('error', () => quit(failure('connection_failed', '无法连接到所选 ES 实例。请核对该窗口仍运行。')));
    socket.setTimeout(10000, () => quit(failure('handshake_timeout', 'ES 本机连接握手超时。')));
    socket.once('close', () => {
      signal?.removeEventListener('abort', stop);
      const error = failure('connection_closed', 'ES 窗口连接已断开。');
      for (const [requestId, call] of calls) call.reject(failure('connection_closed',
        'ES 窗口连接断开，已派发调用的结果未知。请重新连到原窗口并核对原对象或任务。',
        { completion: 'unknown', requestId, tool: call.name, ...target }));
      if (phase === 'ready') onClose(binding);
      else reject(error);
    });
    const lines = readMessages(socket, message => {
      if (phase === 'hello' && message?.type === 'hello' && message.instanceId === instance.instanceId && isSecret(message.nonce)) {
        serverNonce = message.nonce;
        phase = 'auth';
        sendMessage(socket, { type: 'auth', nonce: clientNonce, proof: proof(secret, 'client', instance.instanceId, serverNonce, clientNonce) });
      } else if (phase === 'auth' && message?.type === 'auth' && verifyProof(message.proof, proof(secret, 'server', instance.instanceId, serverNonce, clientNonce))) {
        phase = 'consent';
        socket.setTimeout(0);
        sendMessage(socket, { type: 'connect', windowId: target.windowId, clientKey, clientLabel: label, adapterId });
      } else if (phase === 'consent' && message?.type === 'connection-error') {
        quit(failure(message.error?.code || 'connection_failed', message.error?.message || '无法连接到 ES 窗口。', message.error?.data));
      } else if (phase === 'consent' && message?.type === 'connected' && message.result?.instanceId === target.instanceId &&
                 message.result.windowId === target.windowId && Array.isArray(message.result.tools)) {
        const { tools, ...receipt } = message.result;
        binding.tools = tools;
        binding.receipt = receipt;
        phase = 'ready';
        signal?.removeEventListener('abort', stop);
        resolve(binding);
      } else if (phase === 'ready' && message?.type === 'tools-changed' && Array.isArray(message.tools)) {
        binding.tools = message.tools;
        onTools(binding);
      } else if (phase === 'ready' && message?.type === 'result' && isId(message.id)) {
        const call = calls.get(message.id);
        if (message.error) call?.reject(failure(message.error.code, message.error.message, message.error.data));
        else call?.resolve(message.result);
      } else quit(failure('authentication_failed', '无法验证所选 ES 实例。'));
    }, () => quit(failure('invalid_message', 'ES 实例返回了无效的连接消息。')));
    lines.on('error', () => socket.destroy());
  });
}

function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
const validRpcId = value => typeof value === 'string' || Number.isSafeInteger(value);
const bindingKey = target => `${target.instanceId}:${target.windowId}`;
const windowsOf = instances => instances.flatMap(row => row.windows.map(window => ({ instanceId: row.instanceId, windowId: window.windowId })));

function portableConnection(executable = process.execPath, directory = __dirname, fileSystem = fs, platform = process.platform) {
  if (platform === 'win32') {
    if (path.basename(executable).toLowerCase() !== 'ester-studio-host.exe') return undefined;
    const expected = path.join(path.dirname(executable), 'resources', 'app', 'desktop', 'mcp');
    if (!sameExecutable(directory, expected)) return undefined;
    const layout = resolvePortableLayout({ executable, version, fs: fileSystem });
    return { executable, launcher: path.join(layout.distributionRoot, 'Ester-Studio.exe') };
  }
  if (platform === 'darwin') {
    const expected = path.resolve(path.dirname(executable), '..', 'Resources', 'app', 'desktop', 'mcp');
    if (path.normalize(directory) !== path.normalize(expected)) return undefined;
    return { executable, launcher: executable };
  }
  const expected = path.join(path.dirname(executable), 'resources', 'app', 'desktop', 'mcp');
  if (path.normalize(directory) !== path.normalize(expected)) return undefined;
  return { executable, launcher: executable };
}

function launchPortable(launcher) {
  const stat = fs.lstatSync(launcher);
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure('launch_unavailable', '找不到这套便携包的启动程序。');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, [MCP_CONNECT_LAUNCH], { cwd: path.dirname(launcher), env, detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

const localInstances = (instances, installation) => installation
  ? instances.filter(instance => sameExecutable(instance.executable, installation.executable)) : instances;

function runStdio({ stdin, stdout, dir, options = {}, discoverInstances = discover, bind = openBinding, launch = launchPortable, startupWaitMs = 30000 }) {
  const adapterId = randomUUID();
  const connections = new Map();
  const connecting = new Map();
  const pending = new Map();
  let negotiated, clientLabel, primary, launchPending, initialized = false, ended = false;
  const discoverLocal = async () => localInstances(await discoverInstances(dir), options.installation);
  async function waitForLocalWindow(instances, signal) {
    if (!instances.length) {
      if (!launchPending) launchPending = Promise.resolve().then(() => launch(options.installation.launcher)).catch(error => {
        launchPending = undefined;
        throw failure('launch_failed', '无法启动这套 Lactone Studio 应用。', { message: error.message });
      });
      await launchPending;
    }
    const until = Date.now() + startupWaitMs;
    while (Date.now() < until) {
      signal.throwIfAborted();
      const current = await discoverLocal();
      if (windowsOf(current).length) { launchPending = undefined; return current; }
      await delay(150, undefined, { signal });
    }
    launchPending = undefined;
    throw failure('window_starting', '这套 Lactone Studio 的工作台还未就绪，可在工作台打开后重试连接。');
  }
  function emit(message) { if (!ended) sendMessage(stdout, message); }
  function changed() {
    if (initialized) emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }
  function onClose(binding) {
    const key = bindingKey(binding.target);
    if (connections.get(key) !== binding) return;
    connections.delete(key);
    if (primary === binding) { primary = null; changed(); }
  }
  async function connect(args, signal) {
    if ((args.instanceId !== undefined && !isId(args.instanceId)) || (args.windowId !== undefined && !isId(args.windowId))) {
      throw failure('invalid_target', 'ES 实例和窗口标识必须来自运行实例清单。');
    }
    const instanceId = args.instanceId ?? options.instanceId;
    const windowId = args.windowId ?? (!args.instanceId || args.instanceId === options.instanceId ? options.windowId : undefined);
    signal.throwIfAborted();
    let instances = await discoverLocal();
    if (!instanceId && !windowId && options.installation && !windowsOf(instances).length) {
      instances = await waitForLocalWindow(instances, signal);
    }
    const available = windowsOf(instances);
    const matching = available.filter(row => (!instanceId || row.instanceId === instanceId) && (!windowId || row.windowId === windowId));
    if (!matching.length) throw failure('window_unavailable', '未找到所选 ES 窗口。请先打开 Lactone Studio 并等待工作台就绪。', { windows: available });
    if (matching.length > 1) throw failure('selection_required', '有多个 ES 窗口。请指定 instanceId 和 windowId。', { windows: matching });
    const target = matching[0];
    const key = bindingKey(target);
    let connection = connections.get(key);
    if (!connection) {
      if (connecting.has(key)) throw failure('connection_pending', '此 ES 窗口正在等待连接授权。');
      const opening = bind({ target, instance: instances.find(row => row.instanceId === target.instanceId), dir, label: clientLabel, adapterId, signal,
        onTools: binding => { if (binding === primary) changed(); }, onClose });
      connecting.set(key, opening);
      try { connection = await opening; }
      finally { connecting.delete(key); }
      if (ended || signal.aborted) { connection.close(); throw aborted(); }
      connections.set(key, connection);
    }
    if (primary !== connection) { primary = connection; changed(); }
    return connection.receipt;
  }
  function toolResult(value, isError = false) {
    const { result, image } = splitImageResult(isRecord(value) ? value : { value: value ?? null });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }, ...(image ? [{ type: 'image', ...image }] : [])],
      ...(negotiated >= '2025-06-18' ? { structuredContent: result } : {}),
      ...(isError ? { isError: true } : {}),
    };
  }
  async function callTool(params, signal) {
    const args = params.arguments ?? {};
    try {
      if (params.name === connectTool.name) return toolResult(await connect(args, signal));
      let name = params.name, toolArgs = args;
      if (name === callToolByName.name) {
        if (!isToolName(args.name) || (args.arguments !== undefined && !isRecord(args.arguments)) ||
            Object.keys(args).some(key => key !== 'name' && key !== 'arguments')) {
          throw failure('invalid_arguments', 'es_call 需要原生操作名 name，以及可选的具名参数 arguments。');
        }
        name = args.name;
        toolArgs = args.arguments ?? {};
      }
      const target = params._meta?.['ester-studio/window'];
      if (target !== undefined && (!isRecord(target) || !isId(target.windowId) || (target.instanceId !== undefined && !isId(target.instanceId)))) {
        throw failure('invalid_target', '窗口路由需要有效的实例和窗口标识。');
      }
      if (!primary && !target) throw failure('connection_required', '请先调用 es_connect 连接到 ES 窗口。');
      const selected = target ? connections.get(bindingKey({ instanceId: target.instanceId ?? primary?.target.instanceId, windowId: target.windowId })) : primary;
      if (!selected) throw failure('target_not_granted', '目标 ES 窗口尚未通过 es_connect 授权。');
      if (adapterTools.some(tool => tool.name === name) || !selected.tools.some(tool => tool.name === name)) {
        throw failure('unknown_tool', `目标 ES 窗口未开放操作 ${name}。`);
      }
      return toolResult(await selected.call(name, toolArgs, signal));
    } catch (error) { return toolResult({ error: errorRecord(error) }, true); }
  }
  async function listTools() {
    if (primary) return withAdapterTools(primary.tools);
    const candidates = (await discoverLocal().catch(() => [])).filter(instance =>
      instance.windows.some(row => !options.windowId || row.windowId === options.windowId) &&
      (!options.instanceId || instance.instanceId === options.instanceId));
    const published = new Map(candidates.flatMap(row => row.tools ?? []).map(tool => [tool.name, tool]));
    return withAdapterTools([...published.values()]);
  }
  async function receive(message) {
    const id = validRpcId(message?.id) ? message.id : null;
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && id === null)) {
      return rpcError(id, -32600, 'Invalid Request');
    }
    const params = message.params ?? {};
    if (id === null) {
      if (message.method === 'notifications/initialized' && negotiated) initialized = true;
      if (message.method === 'notifications/cancelled' && validRpcId(params.requestId)) pending.get(params.requestId)?.abort();
      return null;
    }
    if (!isRecord(params)) return rpcError(id, -32602, 'Invalid params');
    const result = value => ({ jsonrpc: '2.0', id, result: value });
    if (message.method === 'initialize') {
      if (negotiated || typeof params.protocolVersion !== 'string' || typeof params.clientInfo?.name !== 'string') return rpcError(id, -32602, 'Invalid initialize params');
      negotiated = versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0];
      clientLabel = String(options.client ?? params.clientInfo.name).slice(0, 160).trim() || 'MCP client';
      return result({ protocolVersion: negotiated, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'lactone-studio', version },
        instructions: 'Call es_connect to bind or select a running Lactone Studio window, then refresh the tool list. If the list stays unchanged, use es_call to discover operations through es_capabilities and invoke native tools by name. To address another already bound window without selecting it, use tools/call params._meta["ester-studio/window"] with instanceId and windowId.' });
    }
    if (message.method === 'ping') return result({});
    if (!initialized) return rpcError(id, -32002, 'MCP initialization incomplete');
    if (message.method === 'tools/list') return result(await listTools());
    if (message.method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    if (!isToolName(params.name) || (params.arguments !== undefined && !isRecord(params.arguments)) || pending.has(id)) return rpcError(id, -32602, 'Invalid tools/call params or repeated request id');
    const controller = new AbortController();
    pending.set(id, controller);
    try {
      const value = await callTool(params, controller.signal);
      return controller.signal.aborted ? null : result(value);
    } finally { pending.delete(id); }
  }
  function close() {
    if (ended) return;
    ended = true;
    for (const controller of pending.values()) controller.abort();
    for (const connection of connections.values()) connection.close();
    lines.close();
  }
  const lines = readMessages(stdin, message => {
    if (Array.isArray(message) && negotiated === '2025-03-26' && message.length) {
      void Promise.all(message.map(receive)).then(items => {
        const responses = items.filter(Boolean);
        if (responses.length) emit(responses);
      }).catch(() => emit(rpcError(null, -32603, 'Internal error')));
    } else void receive(message).then(response => { if (response) emit(response); }).catch(() => emit(rpcError(validRpcId(message?.id) ? message.id : null, -32603, 'Internal error')));
  }, () => emit(rpcError(null, -32700, 'Parse error')));
  lines.on('error', close);
  lines.once('close', close);
  stdout.on('error', close);
  return { close };
}

function readOptions(args, env) {
  const options = { instanceId: env.ES_MCP_INSTANCE_ID, windowId: env.ES_MCP_WINDOW_ID };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--list') options.list = true;
    else if (arg === '--client' && args[i + 1] && !args[i + 1].startsWith('--')) options.client = args[++i];
    else throw failure('invalid_option', `不支持的 ES MCP 参数 ${arg}。`);
  }
  return options;
}
async function main() {
  const options = readOptions(process.argv.slice(2), process.env);
  options.installation = portableConnection();
  const dir = discoveryDirectory();
  if (options.list) {
    process.stdout.write(`${JSON.stringify({ windows: windowsOf(localInstances(await discover(dir), options.installation)) }, null, 2)}\n`);
    return;
  }
  runStdio({ stdin: process.stdin, stdout: process.stdout, dir, options });
}
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = { runStdio, openBinding, portableConnection };
