'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { profileForVersion } = require('../version-profile.cjs');
const { splitImageResult } = require('./image-result.cjs');
const {
  isPlainObject,
  formatToolResult,
  formatToolErrorResult,
  createMcpToolRegistry,
  registerAllMcpTools,
  createMcpProtocolProcessor,
  jsonRpcError
} = require('./protocol.cjs');

const SESSION_SCHEMA = 'ester-mcp-session/v1';
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 600000;

function resolveActionTimeoutMs(action, payload, configuredTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, { isClient = false } = {}) {
  const clientSlackMs = isClient ? 5000 : 0;
  const hostComputeSlackMs = 5000;
  if (action === 'tools.call') {
    const args = isPlainObject(payload?.arguments) ? payload.arguments : null;
    if (args && Number.isInteger(args.timeoutSeconds) && args.timeoutSeconds >= 5 && args.timeoutSeconds <= 1800) {
      return args.timeoutSeconds * 1000 + hostComputeSlackMs + clientSlackMs;
    }
    if (args && Number.isInteger(args.waitMs) && args.waitMs >= 1000 && args.waitMs <= 1800000) {
      return Math.max(configuredTimeoutMs, args.waitMs + hostComputeSlackMs) + clientSlackMs;
    }
    if (configuredTimeoutMs === DEFAULT_REQUEST_TIMEOUT_MS) {
      return DEFAULT_TOOL_CALL_TIMEOUT_MS + hostComputeSlackMs + clientSlackMs;
    }
    return configuredTimeoutMs;
  }
  return configuredTimeoutMs;
}

function resolveHostAppDataRoot(platform = process.platform, env = process.env, homedir = os.homedir()) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support');
  }
  if (platform === 'win32') {
    return env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
  }
  return env.XDG_CONFIG_HOME || path.join(homedir, '.config');
}

function resolveDefaultMcpSessionFile({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  packageMeta
} = {}) {
  if (typeof env.ESTER_MCP_SESSION_FILE === 'string' && env.ESTER_MCP_SESSION_FILE.trim()) {
    return path.resolve(env.ESTER_MCP_SESSION_FILE.trim());
  }
  const meta = packageMeta || require('../../package.json');
  const version = String(meta.version || '2.1.3');
  const revision = typeof meta.sciyueBuildRevision === 'string' && meta.sciyueBuildRevision
    ? `-${meta.sciyueBuildRevision}`
    : '';
  const profileDir = profileForVersion(resolveHostAppDataRoot(platform, env, homedir), `${version}${revision}`);
  return path.join(profileDir, 'mcp-session.json');
}

function safeTokenEquals(expectedToken, providedToken) {
  if (typeof expectedToken !== 'string' || typeof providedToken !== 'string') return false;
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  const providedBuf = Buffer.from(providedToken, 'utf8');
  if (expectedBuf.length !== providedBuf.length || expectedBuf.length === 0) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function readRawBody(req, maxBytes = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on('data', chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('MCP bridge request payload too large'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function readJsonRequest(req, maxBytes = MAX_HTTP_BODY_BYTES) {
  const raw = await readRawBody(req, maxBytes);
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (!isPlainObject(parsed)) {
      throw Object.assign(new Error('Expected JSON object body'), { statusCode: 400, code: 'INVALID_BODY' });
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'INVALID_BODY') throw error;
    throw Object.assign(new Error(`Invalid JSON body: ${error.message}`), { statusCode: 400, code: 'INVALID_JSON' });
  }
}

function sendJsonResponse(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function extractRequestToken(req, parsedUrl) {
  const authHeader = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
  if (match && match[1]) {
    return { token: match[1], fromQuery: false };
  }
  const headerToken = typeof req.headers?.['x-mcp-token'] === 'string' ? req.headers['x-mcp-token'].trim() : '';
  if (headerToken) {
    return { token: headerToken, fromQuery: false };
  }
  const queryToken = parsedUrl?.searchParams?.get('token') || '';
  if (queryToken) {
    return { token: queryToken, fromQuery: true };
  }
  return { token: '', fromQuery: false };
}

function createMcpLiveHost({
  getTargetWindow,
  getHostStatus,
  dynamicTools,
  sessionFilePath,
  host = '127.0.0.1',
  port = 0,
  preferredPort = 0,
  initialToken,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  serverName = 'lactone-studio-mcp',
  serverVersion = '2.1.3',
  registerExtraTools
} = {}) {
  if (typeof getTargetWindow !== 'function') {
    throw new Error('createMcpLiveHost requires getTargetWindow function');
  }
  if (typeof getHostStatus !== 'function') {
    throw new Error('createMcpLiveHost requires getHostStatus function');
  }

  const resolvedSessionFile = sessionFilePath
    ? path.resolve(sessionFilePath)
    : resolveDefaultMcpSessionFile();
  let token = typeof initialToken === 'string' && initialToken.trim().length >= 16
    ? initialToken.trim()
    : crypto.randomBytes(32).toString('hex');
  let configuredPreferredPort = Number.isInteger(preferredPort) && preferredPort >= 1 && preferredPort <= 65535
    ? preferredPort
    : 0;
  const pendingFrontendRequests = new Map();
  const customActionHandlers = new Map();
  const sseSessions = new Map();
  const streamableSseResponses = new Set();
  let httpServer = null;
  let boundPort = null;
  let startedAt = null;
  let disposed = false;

  function registerActionHandler(action, handler) {
    if (typeof action !== 'string' || !action.trim()) {
      throw new Error('Invalid MCP bridge action name');
    }
    if (typeof handler !== 'function') {
      throw new Error(`MCP bridge action "${action}" requires a handler function`);
    }
    customActionHandlers.set(action, handler);
  }

  function requestFrontend(action, payload = {}, options = {}) {
    if (disposed) {
      return Promise.reject(Object.assign(new Error('MCP live host is disposed'), { code: 'MCP_HOST_DISPOSED' }));
    }
    const targetWindow = getTargetWindow(options.windowId);
    if (!targetWindow || targetWindow.isDestroyed?.() || targetWindow.webContents?.isDestroyed?.()) {
      return Promise.reject(Object.assign(new Error('No active Lactone Studio workbench window is available'), { code: 'MCP_NO_WORKBENCH_WINDOW' }));
    }

    const ownerId = targetWindow.webContents.id;
    const requestId = crypto.randomUUID();
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFrontendRequests.delete(requestId);
        reject(Object.assign(new Error(`Timed out waiting for frontend response to "${action}" (${timeoutMs}ms)`), {
          code: 'MCP_FRONTEND_TIMEOUT'
        }));
      }, timeoutMs);
      timer.unref?.();

      pendingFrontendRequests.set(requestId, {
        requestId,
        ownerId,
        action,
        timer,
        resolve,
        reject
      });

      try {
        targetWindow.webContents.send('sciyue:mcp-frontend-request', {
          requestId,
          action,
          payload: isPlainObject(payload) ? payload : {}
        });
      } catch (error) {
        clearTimeout(timer);
        pendingFrontendRequests.delete(requestId);
        reject(Object.assign(new Error(`Failed to send request to frontend window: ${error.message}`), {
          code: 'MCP_FRONTEND_SEND_FAILED'
        }));
      }
    });
  }

  function handleFrontendReply(ownerId, response) {
    if (!isPlainObject(response) || typeof response.requestId !== 'string' || !response.requestId) {
      throw new Error('Invalid MCP frontend reply payload');
    }
    const pending = pendingFrontendRequests.get(response.requestId);
    if (!pending) {
      return { accepted: false, reason: 'unknown-or-expired-request' };
    }
    if (pending.ownerId !== ownerId) {
      throw new Error('MCP frontend reply sender does not match target window');
    }
    clearTimeout(pending.timer);
    pendingFrontendRequests.delete(response.requestId);

    if (response.ok === false) {
      const errMessage = isPlainObject(response.error) && typeof response.error.message === 'string'
        ? response.error.message
        : 'Frontend rejected MCP request';
      const errCode = isPlainObject(response.error) && typeof response.error.code === 'string'
        ? response.error.code
        : 'MCP_FRONTEND_ERROR';
      const sourceAdopted = isPlainObject(response.error) && response.error.sourceAdopted === true;
      pending.reject(Object.assign(new Error(errMessage), { code: errCode, sourceAdopted }));
    } else {
      pending.resolve(response.result ?? {});
    }
    return { accepted: true };
  }

  function disposeOwner(ownerId) {
    for (const [requestId, pending] of pendingFrontendRequests.entries()) {
      if (pending.ownerId === ownerId) {
        clearTimeout(pending.timer);
        pendingFrontendRequests.delete(requestId);
        pending.reject(Object.assign(new Error('Frontend window closed before completing MCP request'), {
          code: 'MCP_FRONTEND_WINDOW_CLOSED'
        }));
      }
    }
  }

  function listDynamicTools() {
    if (typeof dynamicTools?.listTools !== 'function') return [];
    const list = dynamicTools.listTools();
    return Array.isArray(list) ? list : [];
  }

  async function callDynamicTool(name, args = {}, context = {}) {
    if (typeof dynamicTools?.callTool !== 'function') {
      throw Object.assign(new Error(`Unknown MCP tool: ${name}`), { code: -32602 });
    }
    const raw = await dynamicTools.callTool(name, args, { signal: context.signal });
    if (isPlainObject(raw) && Array.isArray(raw.content)) {
      return raw;
    }
    const { result, image } = splitImageResult(raw);
    return formatToolResult(result, { imageBlocks: image ? [image] : [] });
  }

  async function dispatchAction(action, payload = {}, context = {}) {
    if (typeof action !== 'string' || !action) {
      throw Object.assign(new Error('Missing MCP dispatch action'), { statusCode: 400, code: 'MISSING_ACTION' });
    }

    if (action === 'ping') {
      const hostStatus = await getHostStatus();
      let frontend = { workbenchOnline: false };
      try {
        frontend = await requestFrontend('frontend.ping', payload);
      } catch (error) {
        frontend = {
          workbenchOnline: false,
          reason: error instanceof Error ? error.message : String(error),
          code: error?.code ?? 'MCP_FRONTEND_UNAVAILABLE'
        };
      }
      return {
        desktopConnected: true,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        version: serverVersion,
        startedAt,
        ...hostStatus,
        frontend
      };
    }

    if (action === 'tools.list') {
      return { tools: listDynamicTools() };
    }

    if (action === 'tools.call') {
      const toolName = typeof payload.name === 'string' ? payload.name : '';
      if (!toolName) {
        throw Object.assign(new Error('tools.call requires tool name'), { statusCode: 400, code: -32602 });
      }
      const args = payload.arguments ?? {};
      if (!isPlainObject(args)) {
        throw Object.assign(new Error(`Invalid arguments for MCP tool "${toolName}": expected object`), { statusCode: 400, code: -32602 });
      }
      try {
        const mcpToolResult = await callDynamicTool(toolName, args, context);
        return { mcpToolResult };
      } catch (error) {
        if (error?.code === -32602 || error?.code === 'unknown_tool') {
          throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
            statusCode: 400,
            code: -32602
          });
        }
        return { mcpToolResult: formatToolErrorResult(toolName, error) };
      }
    }

    if (customActionHandlers.has(action)) {
      const handler = customActionHandlers.get(action);
      return await handler(payload, { requestFrontend, getHostStatus });
    }

    if (action.startsWith('frontend.')) {
      return await requestFrontend(action, payload);
    }

    throw Object.assign(new Error(`Unsupported MCP bridge action: ${action}`), {
      statusCode: 404,
      code: 'UNSUPPORTED_MCP_ACTION'
    });
  }

  const mcpRegistry = createMcpToolRegistry();
  registerAllMcpTools(mcpRegistry, {
    dispatchToHost: dispatchAction,
    serverVersion,
    registerExtraTools
  });
  const mcpProcessor = createMcpProtocolProcessor({
    registry: mcpRegistry,
    serverName,
    serverVersion,
    listDynamicTools,
    callDynamicTool,
    listChanged: Boolean(dynamicTools)
  });

  function notifyToolsChanged() {
    if (disposed || !httpServer) return;
    const payload = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
    for (const res of sseSessions.values()) {
      if (!res.writableEnded) {
        try { res.write(payload); } catch { /* ignore */ }
      }
    }
    for (const res of streamableSseResponses.values()) {
      if (!res.writableEnded) {
        try { res.write(payload); } catch { /* ignore */ }
      }
    }
  }

  const unsubscribeDynamicTools = typeof dynamicTools?.subscribe === 'function'
    ? dynamicTools.subscribe(() => notifyToolsChanged())
    : () => {};

  function closeAllSseStreams() {
    for (const res of sseSessions.values()) {
      try { res.end(); } catch { /* ignore */ }
    }
    sseSessions.clear();
    for (const res of streamableSseResponses.values()) {
      try { res.end(); } catch { /* ignore */ }
    }
    streamableSseResponses.clear();
  }

  async function evaluateMcpJsonRpcPayload(parsed, context = {}) {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return jsonRpcError(null, -32600, 'Invalid JSON-RPC 2.0 batch request');
      }
      const responses = (await Promise.all(parsed.map(item => mcpProcessor.handleMessage(item, context)))).filter(Boolean);
      return responses.length > 0 ? responses : null;
    }
    return await mcpProcessor.handleMessage(parsed, context);
  }

  async function writeSessionFile(sessionInfo) {
    await fsPromises.mkdir(path.dirname(resolvedSessionFile), { recursive: true });
    const tempFile = `${resolvedSessionFile}.${process.pid}.${Date.now()}.tmp`;
    const content = JSON.stringify(sessionInfo, null, 2);
    await fsPromises.writeFile(tempFile, content, { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(tempFile, resolvedSessionFile);
  }

  function removeSessionFileSyncIfOwned() {
    try {
      if (!fs.existsSync(resolvedSessionFile)) return;
      const raw = fs.readFileSync(resolvedSessionFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.token === token && parsed.pid === process.pid) {
        fs.unlinkSync(resolvedSessionFile);
      }
    } catch {
      // Ignore cleanup errors during shutdown
    }
  }

  function listenOnPort(server, candidatePort) {
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidatePort, host);
    });
  }

  async function start() {
    if (disposed) {
      throw new Error('Cannot start a disposed MCP live host');
    }
    if (httpServer) {
      return getSessionInfo();
    }

    startedAt = new Date().toISOString();
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Session-Id, Last-Event-ID, X-MCP-Token',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id'
    };

    const server = http.createServer(async (req, res) => {
      const requestAbort = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) requestAbort.abort();
      };
      res.on('close', onClose);
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(req.url || '/', `http://${host}`);
        } catch {
          sendJsonResponse(res, 400, {
            ok: false,
            error: { code: 'MCP_INVALID_URL', message: 'Invalid request URL' }
          }, corsHeaders);
          return;
        }

        const extracted = extractRequestToken(req, parsedUrl);
        if (!extracted.token || !safeTokenEquals(token, extracted.token)) {
          sendJsonResponse(res, 401, {
            ok: false,
            error: {
              code: 'MCP_UNAUTHORIZED',
              message: 'Invalid or missing MCP session token (pass Authorization: Bearer <token> header or ?token=<token> query parameter)'
            }
          }, corsHeaders);
          return;
        }

        const pathname = parsedUrl.pathname;

        // 1. Internal stdio-bridge dispatch endpoint
        if (pathname === '/mcp/dispatch') {
          if (req.method !== 'POST') {
            sendJsonResponse(res, 404, {
              ok: false,
              error: {
                code: 'MCP_NOT_FOUND',
                message: 'Expected POST /mcp/dispatch'
              }
            }, corsHeaders);
            return;
          }
          const body = await readJsonRequest(req);
          const result = await dispatchAction(body.action, isPlainObject(body.payload) ? body.payload : {}, { signal: requestAbort.signal });
          sendJsonResponse(res, 200, {
            ok: true,
            result
          }, corsHeaders);
          return;
        }

        // 2. Standard MCP Streamable HTTP endpoint (/mcp or /)
        if (pathname === '/mcp' || pathname === '/') {
          const mcpSessionId = typeof req.headers['mcp-session-id'] === 'string' && req.headers['mcp-session-id'].trim()
            ? req.headers['mcp-session-id'].trim()
            : crypto.randomUUID();
          const sessionHeaders = {
            ...corsHeaders,
            'Mcp-Session-Id': mcpSessionId
          };

          if (req.method === 'POST') {
            const raw = await readRawBody(req);
            let parsed;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch (error) {
              sendJsonResponse(res, 200, jsonRpcError(null, -32700, `Parse error: ${error.message}`), sessionHeaders);
              return;
            }
            const rpcOut = await evaluateMcpJsonRpcPayload(parsed, { signal: requestAbort.signal });
            if (rpcOut === null) {
              res.writeHead(202, sessionHeaders);
              res.end();
              return;
            }
            sendJsonResponse(res, 200, rpcOut, sessionHeaders);
            return;
          }

          if (req.method === 'GET') {
            const accept = String(req.headers.accept || '');
            if (accept.includes('text/event-stream')) {
              res.off('close', onClose);
              res.writeHead(200, {
                ...sessionHeaders,
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive'
              });
              res.write(': connected\n\n');
              streamableSseResponses.add(res);
              req.on('close', () => {
                streamableSseResponses.delete(res);
              });
              return;
            }
            sendJsonResponse(res, 200, {
              ok: true,
              protocol: 'mcp-streamable-http',
              serverName,
              version: serverVersion,
              endpoints: {
                streamableHttp: '/mcp',
                sse: '/sse',
                messages: '/messages',
                internalDispatch: '/mcp/dispatch'
              }
            }, sessionHeaders);
            return;
          }

          if (req.method === 'DELETE') {
            res.writeHead(204, sessionHeaders);
            res.end();
            return;
          }
        }

        // 3. Legacy MCP HTTP+SSE endpoints (/sse and /messages)
        if (pathname === '/sse' && req.method === 'GET') {
          res.off('close', onClose);
          const sseSessionId = crypto.randomUUID();
          res.writeHead(200, {
            ...corsHeaders,
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
          });
          const endpointUri = extracted.fromQuery
            ? `/messages?sessionId=${encodeURIComponent(sseSessionId)}&token=${encodeURIComponent(token)}`
            : `/messages?sessionId=${encodeURIComponent(sseSessionId)}`;
          res.write(`event: endpoint\ndata: ${endpointUri}\n\n`);
          sseSessions.set(sseSessionId, res);
          req.on('close', () => {
            sseSessions.delete(sseSessionId);
          });
          return;
        }

        if (pathname === '/messages' && req.method === 'POST') {
          const raw = await readRawBody(req);
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch (error) {
            sendJsonResponse(res, 400, jsonRpcError(null, -32700, `Parse error: ${error.message}`), corsHeaders);
            return;
          }
          const sseSessionId = parsedUrl.searchParams.get('sessionId') || '';
          const sseRes = sseSessions.get(sseSessionId);
          const rpcOut = await evaluateMcpJsonRpcPayload(parsed, { signal: requestAbort.signal });
          if (sseRes && !sseRes.writableEnded) {
            if (rpcOut !== null) {
              const items = Array.isArray(rpcOut) ? rpcOut : [rpcOut];
              for (const item of items) {
                sseRes.write(`event: message\ndata: ${JSON.stringify(item)}\n\n`);
              }
            }
            res.writeHead(202, corsHeaders);
            res.end('Accepted');
            return;
          }
          if (rpcOut === null) {
            res.writeHead(202, corsHeaders);
            res.end();
            return;
          }
          sendJsonResponse(res, 200, rpcOut, corsHeaders);
          return;
        }

        sendJsonResponse(res, 404, {
          ok: false,
          error: {
            code: 'MCP_NOT_FOUND',
            message: 'Supported MCP endpoints: POST /mcp (Streamable HTTP), GET /sse + POST /messages (Legacy SSE), POST /mcp/dispatch (Internal Bridge)'
          }
        }, corsHeaders);
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        sendJsonResponse(res, statusCode, {
          ok: false,
          error: {
            code: error?.code ?? 'MCP_BRIDGE_ERROR',
            message: error instanceof Error ? error.message : String(error)
          }
        }, corsHeaders);
      } finally {
        res.off('close', onClose);
      }
    });

    if (port === 0 && configuredPreferredPort > 0) {
      try {
        await listenOnPort(server, configuredPreferredPort);
      } catch (error) {
        if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') {
          await listenOnPort(server, 0);
        } else {
          throw error;
        }
      }
    } else {
      await listenOnPort(server, port);
    }

    httpServer = server;
    const address = server.address();
    boundPort = typeof address === 'object' && address ? address.port : port;
    if (boundPort > 0) {
      configuredPreferredPort = boundPort;
    }

    const sessionInfo = getSessionInfo();
    await writeSessionFile(sessionInfo);
    return sessionInfo;
  }

  function getSessionInfo() {
    if (!httpServer || !boundPort) return null;
    return {
      schema: SESSION_SCHEMA,
      host,
      port: boundPort,
      token,
      pid: process.pid,
      version: serverVersion,
      startedAt,
      sessionFilePath: resolvedSessionFile
    };
  }

  async function shutdownServer(reason) {
    for (const [requestId, pending] of pendingFrontendRequests.entries()) {
      clearTimeout(pending.timer);
      pendingFrontendRequests.delete(requestId);
      pending.reject(Object.assign(new Error(reason), { code: 'MCP_HOST_SHUTDOWN' }));
    }

    closeAllSseStreams();
    removeSessionFileSyncIfOwned();

    if (httpServer) {
      const serverToClose = httpServer;
      httpServer = null;
      boundPort = null;
      startedAt = null;
      serverToClose.closeAllConnections?.();
      await new Promise(resolve => {
        serverToClose.close(() => resolve());
      });
    }
  }

  async function stop({ rotateToken: shouldRotate = true } = {}) {
    if (disposed) return;
    await shutdownServer('MCP live host stopped');
    if (shouldRotate) {
      token = crypto.randomBytes(32).toString('hex');
    }
  }

  async function rotateToken(nextToken) {
    if (disposed) {
      throw new Error('Cannot rotate token on a disposed MCP live host');
    }
    const previousToken = token;
    const replacement = typeof nextToken === 'string' && nextToken.trim().length >= 16
      ? nextToken.trim()
      : crypto.randomBytes(32).toString('hex');
    closeAllSseStreams();
    if (httpServer && boundPort) {
      token = replacement;
      await writeSessionFile(getSessionInfo());
    } else {
      if (previousToken) {
        removeSessionFileSyncIfOwned();
      }
      token = replacement;
    }
    return token;
  }

  function isRunning() {
    return Boolean(httpServer && boundPort);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribeDynamicTools();
    await shutdownServer('MCP live host shutting down');
  }

  return Object.freeze({
    start,
    stop,
    rotateToken,
    getToken: () => token,
    getPort: () => boundPort || configuredPreferredPort || null,
    isRunning,
    dispose,
    disposeOwner,
    requestFrontend,
    handleFrontendReply,
    registerActionHandler,
    dispatchAction,
    notifyToolsChanged,
    getSessionInfo,
    sessionFilePath: resolvedSessionFile
  });
}

function sendHttpRequest({ host, port, token, pathName = '/mcp/dispatch', body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host,
        port,
        path: pathName,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`
        },
        timeout: timeoutMs
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = raw ? JSON.parse(raw) : {};
            resolve({
              statusCode: res.statusCode ?? 500,
              body: parsed
            });
          } catch (error) {
            reject(Object.assign(new Error(`Invalid JSON response from MCP live host: ${error.message}`), {
              code: 'MCP_INVALID_HOST_RESPONSE'
            }));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`MCP live host request timed out after ${timeoutMs}ms`), {
        code: 'MCP_HOST_TIMEOUT'
      }));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function createMcpLiveClient({
  sessionFilePath,
  resolveSessionFile,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
} = {}) {
  function currentSessionFilePath() {
    if (typeof resolveSessionFile === 'function') {
      return resolveSessionFile();
    }
    if (typeof sessionFilePath === 'string' && sessionFilePath.trim()) {
      return path.resolve(sessionFilePath.trim());
    }
    return resolveDefaultMcpSessionFile();
  }

  async function readSession() {
    const filePath = currentSessionFilePath();
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      !isPlainObject(parsed) ||
      parsed.schema !== SESSION_SCHEMA ||
      typeof parsed.host !== 'string' ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      typeof parsed.token !== 'string' ||
      !parsed.token
    ) {
      throw Object.assign(new Error(`Invalid MCP session file at ${filePath}`), {
        code: 'MCP_INVALID_SESSION_FILE'
      });
    }
    return {
      ...parsed,
      sessionFilePath: filePath
    };
  }

  function buildOfflineResult(action, error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (action === 'ping') {
      return {
        desktopConnected: false,
        sessionFilePath: currentSessionFilePath(),
        reason,
        frontend: {
          workbenchOnline: false
        }
      };
    }
    return {
      desktopConnected: false,
      sessionFilePath: currentSessionFilePath(),
      reason,
      workbench: {
        workbenchOnline: false
      }
    };
  }

  async function dispatch(action, payload = {}) {
    let session;
    try {
      session = await readSession();
    } catch (error) {
      if (action === 'ping') {
        return buildOfflineResult(action, error);
      }
      throw Object.assign(
        new Error(`Lactone Studio desktop is not running or MCP session file is unavailable (${error.message})`),
        { code: 'MCP_DESKTOP_OFFLINE' }
      );
    }

    let response;
    try {
      response = await sendHttpRequest({
        host: session.host,
        port: session.port,
        token: session.token,
        body: { action, payload },
        timeoutMs: resolveActionTimeoutMs(action, payload, timeoutMs, { isClient: true })
      });
    } catch (error) {
      if (
        action === 'ping' &&
        (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET' || error?.code === 'ENOENT')
      ) {
        return buildOfflineResult(action, error);
      }
      throw Object.assign(
        new Error(`Failed to reach Lactone Studio desktop MCP bridge: ${error.message}`),
        { code: error?.code ?? 'MCP_DESKTOP_OFFLINE' }
      );
    }

    if (response.statusCode !== 200 || !response.body || response.body.ok !== true) {
      const errCode = response.body?.error?.code ?? 'MCP_BRIDGE_ERROR';
      const errMessage = response.body?.error?.message ?? `MCP bridge HTTP ${response.statusCode}`;
      throw Object.assign(new Error(errMessage), { code: errCode, statusCode: response.statusCode });
    }

    return response.body.result;
  }

  return Object.freeze({
    dispatch,
    readSession,
    getSessionFilePath: currentSessionFilePath
  });
}

module.exports = {
  SESSION_SCHEMA,
  resolveHostAppDataRoot,
  resolveDefaultMcpSessionFile,
  resolveActionTimeoutMs,
  safeTokenEquals,
  createMcpLiveHost,
  createMcpLiveClient
};
