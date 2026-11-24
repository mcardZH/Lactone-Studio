import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createMcpToolRegistry,
  registerFoundationTools,
  createMcpProtocolProcessor,
  formatToolResult
} = require('../../desktop/mcp/protocol.cjs');
const {
  resolveDefaultMcpSessionFile,
  resolveActionTimeoutMs,
  createMcpLiveHost,
  createMcpLiveClient
} = require('../../desktop/mcp/live-bridge.cjs');
const {
  createMcpStdioServer
} = require('../../desktop/mcp/stdio-server.cjs');

const VALID_SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('MCP Foundation Protocol & Unified Live Bridge', () => {
  const tempDirs = [];
  const activeHosts = [];

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lactone-mcp-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (activeHosts.length > 0) {
      const host = activeHosts.pop();
      await host.dispose();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles MCP JSON-RPC 2.0 initialize, notifications, ping, merged dynamic tools/list, and tools/call', async () => {
    const registry = createMcpToolRegistry();
    registerFoundationTools(registry, {
      serverVersion: '2.1.3',
      dispatchToHost: async (action, payload) => ({
        desktopConnected: true,
        action,
        payload
      })
    });

    const dynamicCalls = [];
    const processor = createMcpProtocolProcessor({
      registry,
      serverName: 'ester-studio-mcp',
      serverVersion: '2.1.3',
      listDynamicTools: () => [
        {
          name: 'es_context',
          description: 'Read live workbench context',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        },
        {
          name: 'ester_ping',
          description: 'Duplicate name should be deduplicated against static ester_ping',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        }
      ],
      callDynamicTool: async (name, args) => {
        dynamicCalls.push({ name, args });
        if (name === 'es_context') return { ok: true, module: 'modeling' };
        if (name === 'boom_tool') throw Object.assign(new Error('Validation problem'), { code: 'INVALID_INPUT' });
        throw Object.assign(new Error(`Unknown MCP tool: ${name}`), { code: 'unknown_tool' });
      },
      listChanged: true
    });

    const initReply = await processor.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    });
    assert.equal(initReply.id, 1);
    assert.equal(initReply.result.protocolVersion, '2024-11-05');
    assert.equal(initReply.result.serverInfo.name, 'ester-studio-mcp');
    assert.equal(initReply.result.capabilities.tools.listChanged, true);

    const notificationReply = await processor.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    });
    assert.equal(notificationReply, null);

    const listReply = await processor.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
    const toolNames = listReply.result.tools.map(t => t.name).sort();
    assert.deepEqual(toolNames, ['es_context', 'ester_ping']);

    const callReply = await processor.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ester_ping',
        arguments: { message: 'hello-lactone' }
      }
    });
    assert.equal(callReply.result.isError, undefined);
    assert.equal(callReply.result.structuredContent.ok, true);
    assert.equal(callReply.result.structuredContent.echo, 'hello-lactone');
    assert.equal(callReply.result.structuredContent.host.desktopConnected, true);

    const dynReply = await processor.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'es_context', arguments: {} }
    });
    assert.equal(dynReply.result.structuredContent.module, 'modeling');
    assert.equal(dynamicCalls.length, 1);

    const errReply = await processor.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'boom_tool', arguments: {} }
    });
    assert.equal(errReply.result.isError, true);
    assert.equal(errReply.result.structuredContent.error.code, 'INVALID_INPUT');

    const unknownReply = await processor.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'does_not_exist', arguments: {} }
    });
    assert.equal(unknownReply.error.code, -32602);

    const formattedWithImage = formatToolResult(
      { ok: true },
      { imageBlocks: [{ data: 'YWJj', mimeType: 'image/png' }] }
    );
    assert.equal(formattedWithImage.content.length, 2);
    assert.equal(formattedWithImage.content[1].type, 'image');
    assert.equal(formattedWithImage.content[1].mimeType, 'image/png');
  });

  it('resolves cross-platform default MCP session file paths and tool call timeouts accurately', () => {
    const appFiles = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/release/application-files.json'), 'utf8')
    );
    assert.ok(appFiles.includes('desktop/mcp/connection-config.cjs'));
    assert.ok(appFiles.includes('desktop/mcp/protocol.cjs'));
    assert.ok(appFiles.includes('desktop/mcp/live-bridge.cjs'));
    assert.ok(appFiles.includes('desktop/mcp/stdio-server.cjs'));

    const darwinPath = resolveDefaultMcpSessionFile({
      env: {},
      platform: 'darwin',
      homedir: '/Users/alice',
      packageMeta: { version: '2.1.3', sciyueBuildRevision: '' }
    });
    assert.equal(
      darwinPath,
      path.join('/Users/alice', 'Library', 'Application Support', 'SciYue', 'profiles', 'v2.1.3', 'mcp-session.json')
    );

    const overridePath = resolveDefaultMcpSessionFile({
      env: { ESTER_MCP_SESSION_FILE: '/tmp/custom-mcp-session.json' },
      platform: 'darwin',
      homedir: '/Users/alice'
    });
    assert.equal(overridePath, path.resolve('/tmp/custom-mcp-session.json'));

    assert.equal(resolveActionTimeoutMs('tools.call', {}, undefined, { isClient: false }), 605000);
    assert.equal(resolveActionTimeoutMs('tools.call', { arguments: { timeoutSeconds: 45 } }, undefined, { isClient: true }), 55000);
    assert.equal(resolveActionTimeoutMs('ping', {}, undefined, { isClient: false }), 15000);
  });

  it('enforces Bearer token auth and executes bidirectional Main<->Renderer ping round-trips', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');

    let hostRef = null;
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 101,
        isDestroyed: () => false,
        send(channel, message) {
          assert.equal(channel, 'sciyue:mcp-frontend-request');
          setImmediate(() => {
            if (message.action === 'frontend.ping') {
              hostRef.handleFrontendReply(101, {
                requestId: message.requestId,
                ok: true,
                result: {
                  workbenchOnline: true,
                  toolCount: 122,
                  echo: message.payload?.message ?? null
                }
              });
            }
          });
        }
      }
    };

    const host = createMcpLiveHost({
      sessionFilePath,
      serverVersion: '2.1.3',
      getTargetWindow: () => mockWindow,
      getHostStatus: () => ({
        windowCount: 1,
        primaryWorkbenchWindowId: 101,
        detachedWindowCount: 0
      })
    });
    hostRef = host;
    activeHosts.push(host);

    const sessionInfo = await host.start();
    assert.equal(fs.existsSync(sessionFilePath), true);
    assert.ok(sessionInfo.port > 0);

    const unauthorizedRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: sessionInfo.host,
          port: sessionInfo.port,
          path: '/mcp/dispatch',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer invalid-token'
          }
        },
        res => {
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(raw) }));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ action: 'ping' }));
    });
    assert.equal(unauthorizedRes.statusCode, 401);
    assert.equal(unauthorizedRes.body.error.code, 'MCP_UNAUTHORIZED');

    const client = createMcpLiveClient({ sessionFilePath });
    const pingResult = await client.dispatch('ping', { message: 'co-pilot-ready' });
    assert.equal(pingResult.desktopConnected, true);
    assert.equal(pingResult.primaryWorkbenchWindowId, 101);
    assert.equal(pingResult.frontend.workbenchOnline, true);
    assert.equal(pingResult.frontend.toolCount, 122);
    assert.equal(pingResult.frontend.echo, 'co-pilot-ready');

    await host.dispose();
    assert.equal(fs.existsSync(sessionFilePath), false);
  });

  it('bridges dynamic workspace tools over Streamable HTTP, Legacy SSE (including list_changed), and imagePreview PNG blocks', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');
    let hostRef = null;
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 303,
        isDestroyed: () => false,
        send(_channel, message) {
          setImmediate(() => {
            if (message.action === 'frontend.ping') {
              hostRef.handleFrontendReply(303, {
                requestId: message.requestId,
                ok: true,
                result: { workbenchOnline: true, echo: message.payload?.message ?? null }
              });
            }
          });
        }
      }
    };

    const catalogSubscribers = new Set();
    let workspaceTools = [
      {
        name: 'model_read',
        description: 'Read model state',
        inputSchema: { type: 'object', properties: { modelRef: { type: 'string' } }, additionalProperties: false }
      },
      {
        name: 'view_export',
        description: 'Export viewport image',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'ester_recommend_method',
        description: 'Recommend QM methods',
        inputSchema: { type: 'object', properties: { engine: { type: 'string' } }, additionalProperties: false }
      }
    ];

    const host = createMcpLiveHost({
      sessionFilePath,
      serverVersion: '2.1.3',
      getTargetWindow: () => mockWindow,
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 303 }),
      dynamicTools: {
        listTools: () => workspaceTools,
        callTool: async (name, args) => {
          if (name === 'model_read') return { modelRef: args.modelRef || 'doc-1', atomCount: 3 };
          if (name === 'view_export') {
            return {
              width: 1,
              height: 1,
              imagePreview: { mimeType: 'image/png', data: VALID_SAMPLE_PNG_BASE64 }
            };
          }
          if (name === 'ester_recommend_method') {
            return { ok: true, engine: args.engine || 'gaussian' };
          }
          throw Object.assign(new Error(`Unknown tool ${name}`), { code: 'unknown_tool' });
        },
        subscribe: listener => {
          catalogSubscribers.add(listener);
          return () => catalogSubscribers.delete(listener);
        }
      }
    });
    hostRef = host;
    activeHosts.push(host);
    const sessionInfo = await host.start();

    function httpJsonRequest(urlPath, { method = 'POST', headers = {}, body } = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: sessionInfo.host,
            port: sessionInfo.port,
            path: urlPath,
            method,
            headers: {
              'Content-Type': 'application/json',
              ...headers
            }
          },
          res => {
            let raw = '';
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
              let parsedBody = null;
              if (raw) {
                try { parsedBody = JSON.parse(raw); } catch { parsedBody = raw; }
              }
              resolve({ statusCode: res.statusCode, headers: res.headers, body: parsedBody });
            });
          }
        );
        req.on('error', reject);
        if (body !== undefined) {
          req.end(typeof body === 'string' ? body : JSON.stringify(body));
        } else {
          req.end();
        }
      });
    }

    const unauth = await httpJsonRequest('/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }
    });
    assert.equal(unauth.statusCode, 401);

    const initRes = await httpJsonRequest('/mcp', {
      headers: { Authorization: `Bearer ${sessionInfo.token}` },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'http-client', version: '1.0' } }
      }
    });
    assert.equal(initRes.statusCode, 200);
    assert.equal(initRes.body.result.protocolVersion, '2025-03-26');
    assert.equal(initRes.body.result.capabilities.tools.listChanged, true);
    assert.ok(initRes.headers['mcp-session-id']);

    const notifyRes = await httpJsonRequest('/mcp', {
      headers: {
        Authorization: `Bearer ${sessionInfo.token}`,
        'Mcp-Session-Id': initRes.headers['mcp-session-id']
      },
      body: { jsonrpc: '2.0', method: 'notifications/initialized' }
    });
    assert.equal(notifyRes.statusCode, 202);

    // tools/list returns static ester_ping + all dynamic workspace tools
    const toolsListRes = await httpJsonRequest(`/?token=${encodeURIComponent(sessionInfo.token)}`, {
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    });
    assert.equal(toolsListRes.statusCode, 200);
    assert.deepEqual(
      toolsListRes.body.result.tools.map(t => t.name).sort(),
      ['ester_ping', 'ester_recommend_method', 'model_read', 'view_export']
    );

    const pingCallRes = await httpJsonRequest(`/mcp?token=${encodeURIComponent(sessionInfo.token)}`, {
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ester_ping', arguments: { message: 'http-hello' } }
      }
    });
    assert.equal(pingCallRes.statusCode, 200);
    assert.equal(pingCallRes.body.result.structuredContent.echo, 'http-hello');

    // imagePreview from upstream tool becomes standard MCP image content block + stripped metadata text
    const imageCallRes = await httpJsonRequest('/mcp', {
      headers: { Authorization: `Bearer ${sessionInfo.token}` },
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'view_export', arguments: {} }
      }
    });
    assert.equal(imageCallRes.statusCode, 200);
    assert.equal(imageCallRes.body.result.content.length, 2);
    assert.equal(imageCallRes.body.result.content[0].type, 'text');
    assert.equal(imageCallRes.body.result.content[1].type, 'image');
    assert.equal(imageCallRes.body.result.content[1].mimeType, 'image/png');
    assert.equal(imageCallRes.body.result.content[1].data, VALID_SAMPLE_PNG_BASE64);
    assert.equal(imageCallRes.body.result.structuredContent.imagePreview.data, undefined);

    // Batch JSON-RPC over POST /mcp
    const batchRes = await httpJsonRequest('/mcp', {
      headers: { 'X-MCP-Token': sessionInfo.token },
      body: [
        { jsonrpc: '2.0', id: 10, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' }
      ]
    });
    assert.equal(batchRes.statusCode, 200);
    assert.equal(batchRes.body.length, 1);

    // Legacy SSE + tools/list_changed notification broadcast
    let endpointReceivedResolve;
    const endpointReceivedPromise = new Promise(resolve => { endpointReceivedResolve = resolve; });
    const sseMessages = [];
    let listChangedResolve;
    const listChangedPromise = new Promise(resolve => { listChangedResolve = resolve; });
    let pingReplyResolve;
    const pingReplyPromise = new Promise(resolve => { pingReplyResolve = resolve; });

    const sseReq = http.request(
      {
        hostname: sessionInfo.host,
        port: sessionInfo.port,
        path: `/sse?token=${encodeURIComponent(sessionInfo.token)}`,
        method: 'GET'
      },
      res => {
        assert.equal(res.statusCode, 200);
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const lines = frame.split('\n');
            const eventLine = lines.find(l => l.startsWith('event: '));
            const dataLine = lines.find(l => l.startsWith('data: '));
            if (eventLine && dataLine) {
              const eventType = eventLine.slice(7).trim();
              const data = dataLine.slice(6).trim();
              if (eventType === 'endpoint') endpointReceivedResolve(data);
              if (eventType === 'message') {
                const msg = JSON.parse(data);
                sseMessages.push(msg);
                if (msg.id === 77) pingReplyResolve(msg);
                if (msg.method === 'notifications/tools/list_changed') listChangedResolve(msg);
              }
            }
          }
        });
      }
    );
    sseReq.end();

    const endpointPath = await endpointReceivedPromise;
    assert.match(endpointPath, /^\/messages\?sessionId=/);

    const postMsgRes = await httpJsonRequest(endpointPath, {
      headers: { Authorization: `Bearer ${sessionInfo.token}` },
      body: { jsonrpc: '2.0', id: 77, method: 'ping' }
    });
    assert.equal(postMsgRes.statusCode, 202);
    const sseRpcReply = await pingReplyPromise;
    assert.equal(sseRpcReply.id, 77);

    // Trigger catalog update -> SSE clients receive notifications/tools/list_changed
    workspaceTools = [
      ...workspaceTools,
      { name: 'es_context', description: 'Read context', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
    ];
    for (const listener of catalogSubscribers) listener();
    const listChangedNote = await listChangedPromise;
    assert.equal(listChangedNote.method, 'notifications/tools/list_changed');
    assert.ok(sseMessages.length >= 2);
    sseReq.destroy();

    await host.dispose();
  });

  it('handles frontend request timeout, window closure, and offline desktop gracefully', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');

    const client = createMcpLiveClient({ sessionFilePath });
    const offlinePing = await client.dispatch('ping', {});
    assert.equal(offlinePing.desktopConnected, false);
    assert.equal(offlinePing.frontend.workbenchOnline, false);

    await assert.rejects(
      () => client.dispatch('frontend.customAction', {}),
      err => err.code === 'MCP_DESKTOP_OFFLINE'
    );

    let capturedRequest = null;
    const silentWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 202,
        isDestroyed: () => false,
        send(_channel, message) {
          capturedRequest = message;
        }
      }
    };

    const host = createMcpLiveHost({
      sessionFilePath,
      requestTimeoutMs: 120,
      getTargetWindow: () => silentWindow,
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 202 })
    });
    activeHosts.push(host);
    await host.start();

    const pendingPromise = host.requestFrontend('frontend.custom', { a: 1 }, { timeoutMs: 2000 });
    assert.ok(capturedRequest?.requestId);
    assert.throws(
      () => host.handleFrontendReply(999, { requestId: capturedRequest.requestId, ok: true }),
      /does not match target window/
    );

    host.disposeOwner(202);
    await assert.rejects(() => pendingPromise, err => err.code === 'MCP_FRONTEND_WINDOW_CLOSED');
    await host.dispose();
  });

  it('runs stdio-server.cjs over line-delimited JSON-RPC streams and child process with unified workspace tools', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');

    // Verify graceful offline list returns static ester_ping
    const offlineInput = new PassThrough();
    const offlineOutput = new PassThrough();
    const offlineServer = createMcpStdioServer({ input: offlineInput, output: offlineOutput, sessionFilePath });
    offlineServer.start();
    const offlineLines = [];
    offlineOutput.on('data', chunk => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) offlineLines.push(JSON.parse(line));
      }
    });
    await offlineServer.processLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    assert.deepEqual(offlineLines[0].result.tools.map(t => t.name), ['ester_ping']);
    offlineServer.close();

    let hostRef = null;
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 303,
        isDestroyed: () => false,
        send(_channel, message) {
          setImmediate(() => {
            hostRef.handleFrontendReply(303, {
              requestId: message.requestId,
              ok: true,
              result: { workbenchOnline: true, toolCount: 2 }
            });
          });
        }
      }
    };

    const host = createMcpLiveHost({
      sessionFilePath,
      getTargetWindow: () => mockWindow,
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 303 }),
      dynamicTools: {
        listTools: () => [
          {
            name: 'plot_export',
            description: 'Export plot PNG',
            inputSchema: { type: 'object', properties: { format: { type: 'string' } }, additionalProperties: false }
          }
        ],
        callTool: async (name, args) => {
          if (name === 'plot_export') {
            return {
              format: args.format || 'png',
              imagePreview: { mimeType: 'image/png', data: VALID_SAMPLE_PNG_BASE64 }
            };
          }
          throw Object.assign(new Error(`Unknown tool ${name}`), { code: 'unknown_tool' });
        }
      }
    });
    hostRef = host;
    activeHosts.push(host);
    await host.start();

    const input = new PassThrough();
    const output = new PassThrough();
    const stdioServer = createMcpStdioServer({ input, output, sessionFilePath });
    stdioServer.start();

    const outputLines = [];
    output.on('data', chunk => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) outputLines.push(JSON.parse(line));
      }
    });

    await stdioServer.processLine(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }));
    assert.deepEqual(outputLines[0].result.tools.map(t => t.name).sort(), ['ester_ping', 'plot_export']);

    await stdioServer.processLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'plot_export', arguments: { format: 'png' } }
    }));
    assert.equal(outputLines[1].id, 11);
    assert.equal(outputLines[1].result.content.length, 2);
    assert.equal(outputLines[1].result.content[1].type, 'image');
    assert.equal(outputLines[1].result.content[1].data, VALID_SAMPLE_PNG_BASE64);
    stdioServer.close();

    // Real child process test
    const serverScript = path.resolve(import.meta.dirname, '../../desktop/mcp/stdio-server.cjs');
    const child = spawn(process.execPath, [serverScript], {
      env: { ...process.env, ESTER_MCP_SESSION_FILE: sessionFilePath },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const childResponse = await new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) resolve(JSON.parse(buffer.slice(0, newlineIdx)));
      });
      child.on('error', reject);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: { name: 'ester_ping', arguments: { message: 'subagent-check' } }
        }) + '\n'
      );
    });

    child.kill('SIGTERM');
    assert.equal(childResponse.id, 99);
    assert.equal(childResponse.result.structuredContent.ok, true);
    assert.equal(childResponse.result.structuredContent.echo, 'subagent-check');
    assert.equal(childResponse.result.structuredContent.host.desktopConnected, true);
  });
});
