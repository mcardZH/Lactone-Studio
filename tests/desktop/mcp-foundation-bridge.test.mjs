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
  createMcpLiveHost,
  createMcpLiveClient
} = require('../../desktop/mcp/live-bridge.cjs');
const {
  createMcpStdioServer
} = require('../../desktop/mcp/stdio-server.cjs');

describe('MCP Foundation Protocol & Live Bridge (Phase 1)', () => {
  const tempDirs = [];
  const activeHosts = [];

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ester-mcp-test-'));
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

  it('handles MCP JSON-RPC 2.0 initialize, notifications, ping, tools/list, and tools/call', async () => {
    const registry = createMcpToolRegistry();
    registerFoundationTools(registry, {
      serverVersion: '2.0.3',
      dispatchToHost: async (action, payload) => ({
        desktopConnected: true,
        action,
        payload
      })
    });

    const processor = createMcpProtocolProcessor({
      registry,
      serverName: 'ester-studio-mcp',
      serverVersion: '2.0.3'
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
    assert.deepEqual(toolNames, ['ester_ping', 'ester_status']);

    const callReply = await processor.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'ester_ping',
        arguments: { message: 'hello-ester' }
      }
    });
    assert.equal(callReply.result.isError, undefined);
    assert.equal(callReply.result.structuredContent.ok, true);
    assert.equal(callReply.result.structuredContent.echo, 'hello-ester');
    assert.equal(callReply.result.structuredContent.host.desktopConnected, true);

    const formattedWithImage = formatToolResult(
      { ok: true },
      { imageBlocks: [{ data: 'YWJj', mimeType: 'image/png' }] }
    );
    assert.equal(formattedWithImage.content.length, 2);
    assert.equal(formattedWithImage.content[1].type, 'image');
    assert.equal(formattedWithImage.content[1].mimeType, 'image/png');
  });

  it('resolves cross-platform default MCP session file paths accurately', () => {
    const appFiles = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/release/application-files.json'), 'utf8')
    );
    assert.ok(appFiles.includes('desktop/mcp/protocol.cjs'));
    assert.ok(appFiles.includes('desktop/mcp/live-bridge.cjs'));
    assert.ok(appFiles.includes('desktop/mcp/stdio-server.cjs'));

    const darwinPath = resolveDefaultMcpSessionFile({
      env: {},
      platform: 'darwin',
      homedir: '/Users/alice',
      packageMeta: { version: '2.0.3', sciyueBuildRevision: '' }
    });
    assert.equal(
      darwinPath,
      path.join('/Users/alice', 'Library', 'Application Support', 'SciYue', 'profiles', 'v2.0.3', 'mcp-session.json')
    );

    const overridePath = resolveDefaultMcpSessionFile({
      env: { ESTER_MCP_SESSION_FILE: '/tmp/custom-mcp-session.json' },
      platform: 'darwin',
      homedir: '/Users/alice'
    });
    assert.equal(overridePath, path.resolve('/tmp/custom-mcp-session.json'));
  });

  it('enforces Bearer token auth and executes bidirectional Main<->Renderer RPC round-trips', async () => {
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
                  echo: message.payload?.message ?? null
                }
              });
            } else if (message.action === 'frontend.status') {
              hostRef.handleFrontendReply(101, {
                requestId: message.requestId,
                ok: true,
                result: {
                  workbenchOnline: true,
                  module: 'modeling',
                  taskCenterOpen: false,
                  activeViewId: 'view-1',
                  activeDocumentId: 'doc-1',
                  documentCount: 1,
                  documents: [
                    {
                      id: 'doc-1',
                      label: 'aspirin',
                      active: true,
                      revision: 3,
                      atomCount: 21,
                      bondCount: 21,
                      charge: 0,
                      multiplicity: 1
                    }
                  ]
                }
              });
            }
          });
        }
      }
    };

    const host = createMcpLiveHost({
      sessionFilePath,
      serverVersion: '2.0.3',
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

    // Verify unauthorized request is rejected with 401
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

    // Verify authorized client round-trip for ping and status
    const client = createMcpLiveClient({ sessionFilePath });
    const pingResult = await client.dispatch('ping', { message: 'co-pilot-ready' });
    assert.equal(pingResult.desktopConnected, true);
    assert.equal(pingResult.primaryWorkbenchWindowId, 101);
    assert.equal(pingResult.frontend.workbenchOnline, true);
    assert.equal(pingResult.frontend.echo, 'co-pilot-ready');

    const statusResult = await client.dispatch('status', { includeDocuments: true });
    assert.equal(statusResult.desktopConnected, true);
    assert.equal(statusResult.workbench.workbenchOnline, true);
    assert.equal(statusResult.workbench.module, 'modeling');
    assert.equal(statusResult.workbench.documents.length, 1);
    assert.equal(statusResult.workbench.documents[0].label, 'aspirin');

    // Disposing host removes session file
    await host.dispose();
    assert.equal(fs.existsSync(sessionFilePath), false);
  });

  it('handles frontend request timeout, window closure, and offline desktop gracefully', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');

    // 1. Offline client before host starts
    const client = createMcpLiveClient({ sessionFilePath });
    const offlineStatus = await client.dispatch('status', {});
    assert.equal(offlineStatus.desktopConnected, false);
    assert.equal(offlineStatus.workbench.workbenchOnline, false);

    await assert.rejects(
      () => client.dispatch('frontend.customAction', {}),
      err => err.code === 'MCP_DESKTOP_OFFLINE'
    );

    // 2. Window closure during pending frontend request
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

    // Test sender mismatch rejection
    const pendingPromise = host.requestFrontend('frontend.custom', { a: 1 }, { timeoutMs: 2000 });
    assert.ok(capturedRequest?.requestId);
    assert.throws(
      () => host.handleFrontendReply(999, { requestId: capturedRequest.requestId, ok: true, result: {} }),
      /sender does not match target window/
    );

    // Test disposeOwner rejects in-flight request immediately
    host.disposeOwner(202);
    await assert.rejects(
      pendingPromise,
      err => err.code === 'MCP_FRONTEND_WINDOW_CLOSED'
    );

    // Test timeout when renderer does not respond
    await assert.rejects(
      host.requestFrontend('frontend.slow', {}, { timeoutMs: 60 }),
      err => err.code === 'MCP_FRONTEND_TIMEOUT'
    );
  });

  it('runs stdio-server.cjs over line-delimited JSON-RPC streams and child process', async () => {
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
            hostRef.handleFrontendReply(303, {
              requestId: message.requestId,
              ok: true,
              result: {
                workbenchOnline: true,
                module: 'input',
                taskCenterOpen: true,
                activeViewId: 'v-main',
                activeDocumentId: 'doc-h2o',
                documentCount: 1,
                documents: [{ id: 'doc-h2o', label: 'H2O', active: true, revision: 1, atomCount: 3, bondCount: 2, charge: 0, multiplicity: 1 }]
              }
            });
          });
        }
      }
    };

    const host = createMcpLiveHost({
      sessionFilePath,
      getTargetWindow: () => mockWindow,
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 303 })
    });
    hostRef = host;
    activeHosts.push(host);
    await host.start();

    // Test in-process stdio stream server
    const input = new PassThrough();
    const output = new PassThrough();
    const stdioServer = createMcpStdioServer({
      input,
      output,
      sessionFilePath
    });
    stdioServer.start();

    const outputLines = [];
    output.on('data', chunk => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) outputLines.push(JSON.parse(line));
      }
    });

    await stdioServer.processLine(JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'ester_status', arguments: { includeDocuments: true } }
    }));

    assert.equal(outputLines.length, 1);
    assert.equal(outputLines[0].id, 10);
    assert.equal(outputLines[0].result.structuredContent.desktopConnected, true);
    assert.equal(outputLines[0].result.structuredContent.workbench.module, 'input');
    assert.equal(outputLines[0].result.structuredContent.workbench.documents[0].label, 'H2O');
    stdioServer.close();

    // Test real child process execution of desktop/mcp/stdio-server.cjs
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
        if (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          resolve(JSON.parse(line));
        }
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
