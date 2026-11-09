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
  registerWindowAndFileTools,
  registerViewportAndVisionTools,
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

  it('validates and dispatches Phase 2 tools (ester_window_manage & ester_open_file) end-to-end', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');

    const xyzPath = path.join(dir, 'water.xyz');
    fs.writeFileSync(
      xyzPath,
      '3\nwater molecule\nO 0.000000 0.000000 0.117300\nH 0.000000 0.757200 -0.469200\nH 0.000000 -0.757200 -0.469200\n',
      'utf8'
    );
    const emptyFilePath = path.join(dir, 'empty.xyz');
    fs.writeFileSync(emptyFilePath, '', 'utf8');
    const symlinkPath = path.join(dir, 'water-link.xyz');
    fs.symlinkSync(xyzPath, symlinkPath);

    let hostRef = null;
    let focusedCount = 0;
    const openedTokens = [];
    const closedTokens = [];

    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 404,
        isDestroyed: () => false,
        send(_channel, message) {
          setImmediate(() => {
            if (message.action === 'frontend.status') {
              hostRef.handleFrontendReply(404, {
                requestId: message.requestId,
                ok: true,
                result: {
                  workbenchOnline: true,
                  module: 'modeling',
                  taskCenterOpen: false,
                  activeViewId: 'view-1',
                  activeDocumentId: 'doc-1',
                  documentCount: 1,
                  documents: []
                }
              });
            } else if (message.action === 'frontend.windowManage') {
              hostRef.handleFrontendReply(404, {
                requestId: message.requestId,
                ok: true,
                result: {
                  action: message.payload.action,
                  module: message.payload.module ?? 'modeling',
                  workbench: {
                    workbenchOnline: true,
                    module: message.payload.module ?? 'modeling',
                    taskCenterOpen: message.payload.action === 'open-task-center',
                    activeViewId: 'view-1',
                    activeDocumentId: 'doc-1',
                    documentCount: 1
                  }
                }
              });
            } else if (message.action === 'frontend.openFile') {
              if (message.payload.label === 'FORCE_FRONTEND_ERROR') {
                hostRef.handleFrontendReply(404, {
                  requestId: message.requestId,
                  ok: false,
                  error: {
                    code: 'MCP_FILE_IMPORT_FAILED',
                    message: 'Simulated frontend import failure'
                  }
                });
                return;
              }
              hostRef.handleFrontendReply(404, {
                requestId: message.requestId,
                ok: true,
                result: {
                  openedDocumentId: 'doc-water',
                  openedDocumentIds: ['doc-water'],
                  targetChoice: message.payload.target === 'analysis' ? 'analysis' : 'structure',
                  sourceTokenReceived: message.payload.sourceDescriptor?.token ?? null,
                  hasInlineText: typeof message.payload.text === 'string' && message.payload.text.includes('water molecule'),
                  document: {
                    id: 'doc-water',
                    label: message.payload.label ?? 'water.xyz',
                    active: true,
                    formula: 'H2O',
                    atomCount: 3,
                    bondCount: 2
                  }
                }
              });
            }
          });
        }
      }
    };

    const host = createMcpLiveHost({
      sessionFilePath,
      getTargetWindow: () => mockWindow,
      focusTargetWindow: () => {
        focusedCount += 1;
      },
      openLaunchSource: async (_ownerId, filePath) => {
        const token = `tok-${openedTokens.length + 1}`;
        openedTokens.push({ token, filePath });
        return {
          token,
          name: path.basename(filePath),
          size: fs.statSync(filePath).size
        };
      },
      closeLaunchSource: async (_ownerId, token) => {
        closedTokens.push(token);
      },
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 404 })
    });
    hostRef = host;
    activeHosts.push(host);
    await host.start();

    const stdioServer = createMcpStdioServer({ sessionFilePath });
    const tools = stdioServer.registry.listTools().map(t => t.name).sort();
    assert.deepEqual(tools, [
      'ester_open_file',
      'ester_ping',
      'ester_status',
      'ester_viewport_camera',
      'ester_viewport_screenshot',
      'ester_window_manage'
    ]);

    // 1. Test ester_window_manage focus-window
    const focusRes = await stdioServer.registry.callTool('ester_window_manage', {
      action: 'focus-window'
    });
    assert.equal(focusRes.isError, undefined);
    assert.equal(focusRes.structuredContent.ok, true);
    assert.equal(focusRes.structuredContent.focused, true);
    assert.equal(focusedCount, 1);

    // 2. Test ester_window_manage switch-module
    const switchRes = await stdioServer.registry.callTool('ester_window_manage', {
      action: 'switch-module',
      module: 'input'
    });
    assert.equal(switchRes.isError, undefined);
    assert.equal(switchRes.structuredContent.module, 'input');

    // 3. Test ester_window_manage validation errors
    const missingModuleRes = await stdioServer.registry.callTool('ester_window_manage', {
      action: 'switch-module'
    });
    assert.equal(missingModuleRes.isError, true);
    assert.equal(missingModuleRes.structuredContent.error.code, 'MISSING_MODULE');

    const missingDocIdRes = await stdioServer.registry.callTool('ester_window_manage', {
      action: 'activate-document'
    });
    assert.equal(missingDocIdRes.isError, true);
    assert.equal(missingDocIdRes.structuredContent.error.code, 'MISSING_DOCUMENT_ID');

    const badLayoutRes = await stdioServer.registry.callTool('ester_window_manage', {
      action: 'set-layout'
    });
    assert.equal(badLayoutRes.isError, true);
    assert.equal(badLayoutRes.structuredContent.error.code, 'INVALID_LAYOUT_OPTIONS');

    // 4. Test ester_open_file success with launch source descriptor + inline text
    const openRes = await stdioServer.registry.callTool('ester_open_file', {
      path: xyzPath,
      target: 'auto',
      label: 'Water-Test'
    });
    assert.equal(openRes.isError, undefined);
    assert.equal(openRes.structuredContent.ok, true);
    assert.equal(openRes.structuredContent.fileName, 'water.xyz');
    assert.equal(openRes.structuredContent.openedDocumentId, 'doc-water');
    assert.equal(openRes.structuredContent.sourceTokenReceived, 'tok-1');
    assert.equal(openRes.structuredContent.hasInlineText, true);
    assert.equal(openRes.structuredContent.document.formula, 'H2O');

    // 5. Test ester_open_file cleanup of launch source token when frontend rejects
    const failOpenRes = await stdioServer.registry.callTool('ester_open_file', {
      path: xyzPath,
      label: 'FORCE_FRONTEND_ERROR'
    });
    assert.equal(failOpenRes.isError, true);
    assert.equal(failOpenRes.structuredContent.error.code, 'MCP_FILE_IMPORT_FAILED');
    assert.deepEqual(closedTokens, ['tok-2']);

    // 6. Test ester_open_file security & filesystem guards (missing, symlink, directory, empty)
    const missingFileRes = await stdioServer.registry.callTool('ester_open_file', {
      path: path.join(dir, 'nonexistent.xyz')
    });
    assert.equal(missingFileRes.isError, true);
    assert.equal(missingFileRes.structuredContent.error.code, 'MCP_FILE_NOT_FOUND');

    const symlinkRes = await stdioServer.registry.callTool('ester_open_file', {
      path: symlinkPath
    });
    assert.equal(symlinkRes.isError, true);
    assert.equal(symlinkRes.structuredContent.error.code, 'MCP_SYMLINK_NOT_ALLOWED');

    const dirRes = await stdioServer.registry.callTool('ester_open_file', {
      path: dir
    });
    assert.equal(dirRes.isError, true);
    assert.equal(dirRes.structuredContent.error.code, 'MCP_NOT_REGULAR_FILE');

    const emptyRes = await stdioServer.registry.callTool('ester_open_file', {
      path: emptyFilePath
    });
    assert.equal(emptyRes.isError, true);
    assert.equal(emptyRes.structuredContent.error.code, 'MCP_EMPTY_FILE');
  });

  it('validates and dispatches Phase 3 tools (ester_viewport_camera & ester_viewport_screenshot) with multimodal PNG blocks and savePath guards', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');

    // Minimal valid 1x1 PNG buffer
    const valid1x1PngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    let hostRef = null;
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 505,
        isDestroyed: () => false,
        send(_channel, message) {
          setImmediate(() => {
            if (message.action === 'frontend.viewportCamera') {
              hostRef.handleFrontendReply(505, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-active',
                  label: 'Aspirin-3D',
                  cameraView: [0, 0, 0, message.payload.zoom ? 125 * message.payload.zoom : 125, 0, 0, 0, 1],
                  pivot: [0, 0, 0],
                  appliedPreset: message.payload.preset ?? null,
                  appliedRotateStep: message.payload.rotateStep ?? null,
                  display: {
                    style: message.payload.display?.style ?? 'ball-stick',
                    showAtomIndices: message.payload.display?.showAtomIndices ?? false,
                    showElementLabels: message.payload.display?.showElementLabels ?? false,
                    showBondLengths: message.payload.display?.showBondLengths ?? true,
                    showFrozenMarks: message.payload.display?.showFrozenMarks ?? true,
                    showCell: message.payload.display?.showCell ?? true,
                    showAxes: message.payload.display?.showAxes ?? true
                  }
                }
              });
            } else if (message.action === 'frontend.viewportScreenshot') {
              if (message.payload.documentId === 'doc-corrupt-png') {
                hostRef.handleFrontendReply(505, {
                  requestId: message.requestId,
                  ok: true,
                  result: {
                    documentId: 'doc-corrupt-png',
                    width: message.payload.width,
                    height: message.payload.height,
                    base64Png: Buffer.from('not-a-png').toString('base64')
                  }
                });
                return;
              }
              hostRef.handleFrontendReply(505, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-active',
                  label: 'Aspirin-3D',
                  formula: 'C9H8O4',
                  atomCount: 21,
                  width: message.payload.width,
                  height: message.payload.height,
                  transparent: message.payload.transparent,
                  includeAnnotations: message.payload.includeAnnotations,
                  renderer: 'webgl',
                  cameraView: [0, 0, 0, 125, 0, 0, 0, 1],
                  base64Png: valid1x1PngBase64
                }
              });
            }
          });
        }
      }
    };

    const host = createMcpLiveHost({
      sessionFilePath,
      getTargetWindow: () => mockWindow,
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 505 })
    });
    hostRef = host;
    activeHosts.push(host);
    await host.start();

    const registry = createMcpToolRegistry();
    const client = createMcpLiveClient({ sessionFilePath });
    registerViewportAndVisionTools(registry, {
      dispatchToHost: (action, payload) => client.dispatch(action, payload)
    });

    // 1. Test ester_viewport_camera validation errors
    const emptyCamRes = await registry.callTool('ester_viewport_camera', {});
    assert.equal(emptyCamRes.isError, true);
    assert.equal(emptyCamRes.structuredContent.error.code, 'EMPTY_CAMERA_OPERATION');

    const badPresetRes = await registry.callTool('ester_viewport_camera', {
      preset: 'invalid-axis'
    });
    assert.equal(badPresetRes.isError, true);
    assert.equal(badPresetRes.structuredContent.error.code, 'INVALID_CAMERA_PRESET');

    const badStepRes = await registry.callTool('ester_viewport_camera', {
      rotateStep: 'diagonal'
    });
    assert.equal(badStepRes.isError, true);
    assert.equal(badStepRes.structuredContent.error.code, 'INVALID_ROTATE_STEP');

    const badDeltaRes = await registry.callTool('ester_viewport_camera', {
      rotateDelta: { dx: 10 }
    });
    assert.equal(badDeltaRes.isError, true);
    assert.equal(badDeltaRes.structuredContent.error.code, 'INVALID_ROTATE_DELTA');

    const badZoomRes = await registry.callTool('ester_viewport_camera', {
      zoom: -1
    });
    assert.equal(badZoomRes.isError, true);
    assert.equal(badZoomRes.structuredContent.error.code, 'INVALID_CAMERA_ZOOM');

    const badDisplayRes = await registry.callTool('ester_viewport_camera', {
      display: { unknownToggle: true }
    });
    assert.equal(badDisplayRes.isError, true);
    assert.equal(badDisplayRes.structuredContent.error.code, 'INVALID_DISPLAY_OPTIONS');

    // 2. Test ester_viewport_camera success
    const camRes = await registry.callTool('ester_viewport_camera', {
      preset: 'principal-inertia',
      rotateStep: 'right',
      zoom: 1.2,
      display: {
        style: 'stick',
        showAtomIndices: true,
        showElementLabels: true
      }
    });
    assert.equal(camRes.isError, undefined);
    assert.equal(camRes.structuredContent.ok, true);
    assert.equal(camRes.structuredContent.appliedPreset, 'principal-inertia');
    assert.equal(camRes.structuredContent.appliedRotateStep, 'right');
    assert.equal(camRes.structuredContent.cameraView[3], 150);
    assert.equal(camRes.structuredContent.display.style, 'stick');
    assert.equal(camRes.structuredContent.display.showAtomIndices, true);

    // 3. Test ester_viewport_screenshot validation errors
    const badWidthRes = await registry.callTool('ester_viewport_screenshot', {
      width: 50
    });
    assert.equal(badWidthRes.isError, true);
    assert.equal(badWidthRes.structuredContent.error.code, 'INVALID_SCREENSHOT_DIMENSIONS');

    // 4. Test ester_viewport_screenshot multimodal image response + savePath file write
    const saveFilePath = path.join(dir, 'aspirin-view.png');
    const shotRes = await registry.callTool('ester_viewport_screenshot', {
      width: 800,
      height: 600,
      transparent: true,
      includeAnnotations: true,
      savePath: saveFilePath
    });
    assert.equal(shotRes.isError, undefined);
    assert.equal(shotRes.structuredContent.ok, true);
    assert.equal(shotRes.structuredContent.width, 800);
    assert.equal(shotRes.structuredContent.height, 600);
    assert.equal(shotRes.structuredContent.savedPath, saveFilePath);
    assert.equal(shotRes.structuredContent.base64Png, undefined);
    assert.equal(shotRes.content.length, 2);
    assert.equal(shotRes.content[0].type, 'text');
    assert.equal(shotRes.content[1].type, 'image');
    assert.equal(shotRes.content[1].mimeType, 'image/png');
    assert.equal(shotRes.content[1].data, valid1x1PngBase64);

    // Verify saved PNG file on disk
    assert.equal(fs.existsSync(saveFilePath), true);
    const savedBytes = fs.readFileSync(saveFilePath);
    assert.deepEqual(savedBytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // 5. Test ester_viewport_screenshot security guards (symlink target, symlink parent dir, missing parent dir, directory target, corrupt PNG)
    const symlinkTarget = path.join(dir, 'symlink-out.png');
    fs.symlinkSync(saveFilePath, symlinkTarget);
    const symlinkShotRes = await registry.callTool('ester_viewport_screenshot', {
      savePath: symlinkTarget
    });
    assert.equal(symlinkShotRes.isError, true);
    assert.equal(symlinkShotRes.structuredContent.error.code, 'MCP_SYMLINK_NOT_ALLOWED');

    const symlinkDir = path.join(dir, 'symlink-dir');
    fs.symlinkSync(dir, symlinkDir);
    const symlinkDirShotRes = await registry.callTool('ester_viewport_screenshot', {
      savePath: path.join(symlinkDir, 'out.png')
    });
    assert.equal(symlinkDirShotRes.isError, true);
    assert.equal(symlinkDirShotRes.structuredContent.error.code, 'MCP_SYMLINK_NOT_ALLOWED');

    const missingParentShotRes = await registry.callTool('ester_viewport_screenshot', {
      savePath: path.join(dir, 'no-such-folder', 'out.png')
    });
    assert.equal(missingParentShotRes.isError, true);
    assert.equal(missingParentShotRes.structuredContent.error.code, 'MCP_SAVE_DIR_NOT_FOUND');

    const dirTargetShotRes = await registry.callTool('ester_viewport_screenshot', {
      savePath: dir
    });
    assert.equal(dirTargetShotRes.isError, true);
    assert.equal(dirTargetShotRes.structuredContent.error.code, 'MCP_NOT_REGULAR_FILE');

    const corruptPngRes = await registry.callTool('ester_viewport_screenshot', {
      documentId: 'doc-corrupt-png'
    });
    assert.equal(corruptPngRes.isError, true);
    assert.equal(corruptPngRes.structuredContent.error.code, 'MCP_INVALID_SCREENSHOT_DATA');
  });
});
