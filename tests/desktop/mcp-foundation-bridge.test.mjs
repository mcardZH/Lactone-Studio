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
  registerStructureAndGeometryTools,
  registerInputConfigTools,
  registerTaskExecutionTools,
  registerAnalysisAndExportTools,
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
      'ester_configure_calculation',
      'ester_edit_structure',
      'ester_export_artifact',
      'ester_get_structure_info',
      'ester_measure_geometry',
      'ester_open_file',
      'ester_open_result_analysis',
      'ester_ping',
      'ester_recommend_method',
      'ester_run_local_xtb',
      'ester_run_wavefunction_analysis',
      'ester_set_constraints',
      'ester_status',
      'ester_submit_task',
      'ester_task_manage',
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

  it('validates and dispatches Phase 4 tools (ester_get_structure_info, ester_measure_geometry, ester_edit_structure, ester_set_constraints) end-to-end', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');

    let hostRef = null;
    const mockWindow = {
      id: 606,
      isDestroyed: () => false,
      webContents: {
        id: 707,
        isDestroyed: () => false,
        send(channel, message) {
          if (channel !== 'sciyue:mcp-frontend-request') return;
          setImmediate(() => {
            if (message.action === 'frontend.getStructureInfo') {
              hostRef.handleFrontendReply(707, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-h2o2',
                  label: 'H2O2',
                  revision: 3,
                  formula: 'H2O2',
                  atomCount: 4,
                  bondCount: 3,
                  includeRotatableTorsions: message.payload.includeRotatableTorsions,
                  selectedOnly: message.payload.selectedOnly
                }
              });
            } else if (message.action === 'frontend.measureGeometry') {
              hostRef.handleFrontendReply(707, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-h2o2',
                  measurements: (message.payload.measurements ?? []).map(m => ({
                    ...m,
                    value: m.type === 'B' ? 1.47 : m.type === 'A' ? 100.5 : 112.0,
                    unit: m.type === 'B' ? 'angstrom' : 'degree'
                  })),
                  neighborShell: message.payload.neighborShell
                    ? {
                        centerAtom: message.payload.neighborShell.centerAtom,
                        coordinationCount: 2
                      }
                    : undefined
                }
              });
            } else if (message.action === 'frontend.editStructure') {
              hostRef.handleFrontendReply(707, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-h2o2',
                  operation: message.payload.operation,
                  previousRevision: 3,
                  revision: 4,
                  canUndo: true,
                  canRedo: false
                }
              });
            } else if (message.action === 'frontend.setConstraints') {
              hostRef.handleFrontendReply(707, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-h2o2',
                  revision: 5,
                  constraints: {
                    enabled: message.payload.enabled !== false,
                    frozenAtomIndices: message.payload.frozenAtoms ?? [],
                    coordinates: message.payload.coordinates ?? []
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
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 606 })
    });
    hostRef = host;
    activeHosts.push(host);
    await host.start();

    const client = createMcpLiveClient({ sessionFilePath });
    const registry = createMcpToolRegistry();
    registerStructureAndGeometryTools(registry, {
      dispatchToHost: (action, payload) => client.dispatch(action, payload)
    });

    // 1. Test ester_get_structure_info
    const infoRes = await registry.callTool('ester_get_structure_info', {
      documentId: 'doc-h2o2',
      includeRotatableTorsions: true
    });
    assert.equal(infoRes.isError, undefined);
    assert.equal(infoRes.structuredContent.ok, true);
    assert.equal(infoRes.structuredContent.formula, 'H2O2');
    assert.equal(infoRes.structuredContent.includeRotatableTorsions, true);

    const badInfoRes = await registry.callTool('ester_get_structure_info', {
      includeAtoms: 'yes'
    });
    assert.equal(badInfoRes.isError, true);
    assert.equal(badInfoRes.structuredContent.error.code, 'INVALID_STRUCTURE_INFO_OPTION');

    // 2. Test ester_measure_geometry
    const measureRes = await registry.callTool('ester_measure_geometry', {
      measurements: [
        { type: 'B', atoms: [1, 2] },
        { type: 'A', atoms: [3, 1, 2] },
        { type: 'D', atoms: [3, 1, 2, 4] }
      ],
      neighborShell: { centerAtom: 1, cutoffAngstrom: 2.5 },
      selectMeasuredAtoms: true
    });
    assert.equal(measureRes.isError, undefined);
    assert.equal(measureRes.structuredContent.ok, true);
    assert.equal(measureRes.structuredContent.measurements.length, 3);
    assert.equal(measureRes.structuredContent.neighborShell.coordinationCount, 2);

    const emptyMeasureRes = await registry.callTool('ester_measure_geometry', {});
    assert.equal(emptyMeasureRes.isError, true);
    assert.equal(emptyMeasureRes.structuredContent.error.code, 'MISSING_MEASUREMENT_QUERY');

    const dupAtomMeasureRes = await registry.callTool('ester_measure_geometry', {
      measurements: [{ type: 'B', atoms: [1, 1] }]
    });
    assert.equal(dupAtomMeasureRes.isError, true);
    assert.equal(dupAtomMeasureRes.structuredContent.error.code, 'INVALID_MEASUREMENT_SPEC');

    // 3. Test ester_edit_structure
    const editGeomRes = await registry.callTool('ester_edit_structure', {
      operation: 'set-geometry',
      coordinate: 'B',
      atoms: [1, 2],
      value: 1.5
    });
    assert.equal(editGeomRes.isError, undefined);
    assert.equal(editGeomRes.structuredContent.ok, true);
    assert.equal(editGeomRes.structuredContent.operation, 'set-geometry');

    const badEditOpRes = await registry.callTool('ester_edit_structure', {
      operation: 'teleport-atoms'
    });
    assert.equal(badEditOpRes.isError, true);
    assert.equal(badEditOpRes.structuredContent.error.code, 'INVALID_EDIT_OPERATION');

    const badAngleRes = await registry.callTool('ester_edit_structure', {
      operation: 'set-geometry',
      coordinate: 'A',
      atoms: [1, 2, 3],
      value: 195
    });
    assert.equal(badAngleRes.isError, true);
    assert.equal(badAngleRes.structuredContent.error.code, 'INVALID_GEOMETRY_EDIT');

    const zeroAxisRotateRes = await registry.callTool('ester_edit_structure', {
      operation: 'rotate',
      axis: [0, 0, 0],
      degrees: 45
    });
    assert.equal(zeroAxisRotateRes.isError, true);
    assert.equal(zeroAxisRotateRes.structuredContent.error.code, 'INVALID_ROTATION_OPTIONS');

    const dupDeleteAtomsRes = await registry.callTool('ester_edit_structure', {
      operation: 'delete-atoms',
      atoms: [2, 2]
    });
    assert.equal(dupDeleteAtomsRes.isError, true);
    assert.equal(dupDeleteAtomsRes.structuredContent.error.code, 'INVALID_ATOM_INDICES');

    const selfDeleteBondRes = await registry.callTool('ester_edit_structure', {
      operation: 'delete-bond',
      atoms: [1, 1]
    });
    assert.equal(selfDeleteBondRes.isError, true);
    assert.equal(selfDeleteBondRes.structuredContent.error.code, 'INVALID_ATOM_INDICES');

    const periodicSelfBondRes = await registry.callTool('ester_edit_structure', {
      operation: 'set-bond-order',
      atoms: [1, 1],
      order: 1,
      image: [1, 0, 0]
    });
    assert.equal(periodicSelfBondRes.isError, undefined);
    assert.equal(periodicSelfBondRes.structuredContent.ok, true);

    // 4. Test ester_set_constraints
    const constraintRes = await registry.callTool('ester_set_constraints', {
      frozenAtoms: [1, 2],
      coordinates: [
        { type: 'D', atoms: [3, 1, 2, 4], action: 'scan', steps: 10, increment: 15 }
      ]
    });
    assert.equal(constraintRes.isError, undefined);
    assert.equal(constraintRes.structuredContent.ok, true);
    assert.deepEqual(constraintRes.structuredContent.constraints.frozenAtomIndices, [1, 2]);

    const dupFrozenRes = await registry.callTool('ester_set_constraints', {
      frozenAtoms: [1, 1]
    });
    assert.equal(dupFrozenRes.isError, true);
    assert.equal(dupFrozenRes.structuredContent.error.code, 'INVALID_ATOM_INDICES');

    const badScanRes = await registry.callTool('ester_set_constraints', {
      coordinates: [
        { type: 'B', atoms: [1, 2], action: 'scan', steps: 10, increment: 0 }
      ]
    });
    assert.equal(badScanRes.isError, true);
    assert.equal(badScanRes.structuredContent.error.code, 'INVALID_COORDINATE_CONSTRAINT');
  });

  it('validates and dispatches Phase 5 tools (ester_recommend_method & ester_configure_calculation) end-to-end', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');

    let hostRef = null;
    const mockWindow = {
      id: 808,
      isDestroyed: () => false,
      webContents: {
        id: 909,
        isDestroyed: () => false,
        send(channel, message) {
          if (channel !== 'sciyue:mcp-frontend-request') return;
          setImmediate(() => {
            if (message.action === 'frontend.recommendMethod') {
              hostRef.handleFrontendReply(909, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-ch3i',
                  formula: 'CH3I',
                  heavyEcpElements: ['I'],
                  engine: message.payload.engine,
                  task: message.payload.task,
                  solvent: message.payload.solvent ?? null,
                  gaussian: {
                    supported: true,
                    recommended: { method: 'b3lyp', basis: 'def2TZVP', requiresGenEcp: true }
                  }
                }
              });
            } else if (message.action === 'frontend.configureCalculation') {
              hostRef.handleFrontendReply(909, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-ch3i',
                  engine: message.payload.engine,
                  switchedToInputView: message.payload.switchToInputView,
                  task: message.payload.settings?.task ?? 'optfreq',
                  method: message.payload.settings?.method ?? 'b3lyp',
                  basis: message.payload.settings?.basis ?? 'def2SVP',
                  valid: true,
                  validationErrors: [],
                  fileName: message.payload.engine === 'orca' ? 'ch3i.inp' : 'ch3i.gjf',
                  script: message.payload.engine === 'orca' ? '! B3LYP D3BJ def2-SVP Opt Freq\n' : '#p opt freq b3lyp/genecp em=gd3bj\n'
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
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 808 })
    });
    hostRef = host;
    activeHosts.push(host);
    await host.start();

    const client = createMcpLiveClient({ sessionFilePath });
    const registry = createMcpToolRegistry();
    registerInputConfigTools(registry, {
      dispatchToHost: (action, payload) => client.dispatch(action, payload)
    });

    // 1. ester_recommend_method happy path & validation errors
    const recRes = await registry.callTool('ester_recommend_method', {
      documentId: 'doc-ch3i',
      engine: 'both',
      task: 'nmr',
      solvent: 'chloroform'
    });
    assert.equal(recRes.isError, undefined);
    assert.equal(recRes.structuredContent.ok, true);
    assert.equal(recRes.structuredContent.formula, 'CH3I');
    assert.equal(recRes.structuredContent.gaussian.recommended.requiresGenEcp, true);

    const badEngineRec = await registry.callTool('ester_recommend_method', {
      engine: 'vasp'
    });
    assert.equal(badEngineRec.isError, true);
    assert.equal(badEngineRec.structuredContent.error.code, 'INVALID_ENGINE');

    const badTaskRec = await registry.callTool('ester_recommend_method', {
      task: 'phonon-band'
    });
    assert.equal(badTaskRec.isError, true);
    assert.equal(badTaskRec.structuredContent.error.code, 'INVALID_CALCULATION_TASK');

    // 2. ester_configure_calculation happy path & validation errors
    const cfgRes = await registry.callTool('ester_configure_calculation', {
      documentId: 'doc-ch3i',
      engine: 'gaussian',
      settings: {
        task: 'optfreq',
        method: 'b3lyp',
        basis: 'def2SVP',
        solventModel: 'smd',
        solvent: 'water',
        cores: 16,
        memoryGB: 32
      }
    });
    assert.equal(cfgRes.isError, undefined);
    assert.equal(cfgRes.structuredContent.ok, true);
    assert.equal(cfgRes.structuredContent.valid, true);
    assert.equal(cfgRes.structuredContent.fileName, 'ch3i.gjf');

    const badKeyCfg = await registry.callTool('ester_configure_calculation', {
      engine: 'orca',
      settings: {
        unknownOption: 123
      }
    });
    assert.equal(badKeyCfg.isError, true);
    assert.equal(badKeyCfg.structuredContent.error.code, 'INVALID_CALCULATION_SETTINGS');

    const badMultCfg = await registry.callTool('ester_configure_calculation', {
      engine: 'gaussian',
      settings: {
        multiplicity: 0
      }
    });
    assert.equal(badMultCfg.isError, true);
    assert.equal(badMultCfg.structuredContent.error.code, 'INVALID_ELECTRONIC_STATE');
  });

  it('validates and dispatches Phase 6 task execution tools (ester_run_local_xtb, ester_submit_task, ester_task_manage) end-to-end', async () => {
    // 1. Verify resolveActionTimeoutMs timeout policy & stdio-server 15-tool catalog
    assert.equal(resolveActionTimeoutMs('run-local-xtb', {}, undefined, { isClient: false }), 305000);
    assert.equal(resolveActionTimeoutMs('run-local-xtb', {}, undefined, { isClient: true }), 310000);
    assert.equal(resolveActionTimeoutMs('run-local-xtb', { timeoutSeconds: 45 }, undefined, { isClient: false }), 50000);
    assert.equal(resolveActionTimeoutMs('run-local-xtb', { timeoutSeconds: 45 }, undefined, { isClient: true }), 55000);
    assert.equal(resolveActionTimeoutMs('submit-task', {}, undefined, { isClient: false }), 60000);
    assert.equal(resolveActionTimeoutMs('task-manage', {}, undefined, { isClient: true }), 65000);
    // Short explicit test timeout is preserved when shorter than default
    assert.equal(resolveActionTimeoutMs('run-local-xtb', {}, 120, { isClient: false }), 120);

    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session-p6.json');

    const stdioInput = new PassThrough();
    const stdioOutput = new PassThrough();
    const stdioServer = createMcpStdioServer({
      input: stdioInput,
      output: stdioOutput,
      sessionFilePath
    });
    const listedTools = stdioServer.registry.listTools();
    assert.equal(listedTools.length, 18);
    assert.ok(listedTools.some(t => t.name === 'ester_run_local_xtb'));
    assert.ok(listedTools.some(t => t.name === 'ester_submit_task'));
    assert.ok(listedTools.some(t => t.name === 'ester_task_manage'));

    // 2. End-to-end live-bridge dispatch + schema validation
    let hostRef = null;
    const seenMessages = [];
    const mockWindow = {
      id: 606,
      isDestroyed: () => false,
      webContents: {
        id: 707,
        isDestroyed: () => false,
        send(channel, message) {
          if (channel !== 'sciyue:mcp-frontend-request') return;
          seenMessages.push(message);
          setImmediate(() => {
            if (message.action === 'frontend.runLocalXtb') {
              hostRef.handleFrontendReply(707, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-butane',
                  calculation: message.payload.calculation,
                  method: message.payload.method,
                  status: 'completed',
                  converged: true,
                  energyHartree: -13.1924,
                  energyKcalMol: -8278.36
                }
              });
            } else if (message.action === 'frontend.submitTask') {
              hostRef.handleFrontendReply(707, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-butane',
                  submitted: message.payload.mode === 'auto-submit',
                  mode: message.payload.mode,
                  status: message.payload.mode === 'auto-submit' ? 'queued' : 'dialog-opened',
                  taskId: message.payload.mode === 'auto-submit' ? 'task-uuid-001' : null,
                  engine: message.payload.engine ?? 'orca'
                }
              });
            } else if (message.action === 'frontend.taskManage') {
              hostRef.handleFrontendReply(707, {
                requestId: message.requestId,
                ok: true,
                result: {
                  action: message.payload.action,
                  ...(message.payload.taskId ? { taskId: message.payload.taskId } : {}),
                  ...(message.payload.action === 'list-environments'
                    ? { count: 1, environments: [{ id: 'env-local', label: 'Local ORCA', kind: 'local' }] }
                    : {})
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
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 606 })
    });
    hostRef = host;
    activeHosts.push(host);
    await host.start();

    const client = createMcpLiveClient({ sessionFilePath });
    const registry = createMcpToolRegistry();
    registerTaskExecutionTools(registry, {
      dispatchToHost: (action, payload) => client.dispatch(action, payload)
    });

    // 3. ester_run_local_xtb happy paths & error validations
    const xtbOptRes = await registry.callTool('ester_run_local_xtb', {
      documentId: 'doc-butane',
      calculation: 'optimize',
      method: 'gfn2',
      solvent: 'water',
      solvationModel: 'alpb',
      maxSteps: 250,
      timeoutSeconds: 60
    });
    assert.equal(xtbOptRes.isError, undefined);
    assert.equal(xtbOptRes.structuredContent.ok, true);
    assert.equal(xtbOptRes.structuredContent.calculation, 'optimize');
    assert.equal(xtbOptRes.structuredContent.converged, true);

    const badSpMethod = await registry.callTool('ester_run_local_xtb', {
      calculation: 'singlepoint',
      method: 'gfn0'
    });
    assert.equal(badSpMethod.isError, true);
    assert.equal(badSpMethod.structuredContent.error.code, 'INVALID_XTB_METHOD');

    const badXtbCalc = await registry.callTool('ester_run_local_xtb', {
      calculation: 'molecular-dynamics'
    });
    assert.equal(badXtbCalc.isError, true);
    assert.equal(badXtbCalc.structuredContent.error.code, 'INVALID_XTB_CALCULATION');

    const badXtbSolvModel = await registry.callTool('ester_run_local_xtb', {
      calculation: 'optimize',
      solvationModel: 'smd'
    });
    assert.equal(badXtbSolvModel.isError, true);
    assert.equal(badXtbSolvModel.structuredContent.error.code, 'INVALID_XTB_SOLVATION');

    const badXtbSteps = await registry.callTool('ester_run_local_xtb', {
      calculation: 'optimize',
      maxSteps: 9000
    });
    assert.equal(badXtbSteps.isError, true);
    assert.equal(badXtbSteps.structuredContent.error.code, 'INVALID_XTB_MAX_STEPS');

    const badXtbTimeout = await registry.callTool('ester_run_local_xtb', {
      calculation: 'optimize',
      timeoutSeconds: 2
    });
    assert.equal(badXtbTimeout.isError, true);
    assert.equal(badXtbTimeout.structuredContent.error.code, 'INVALID_XTB_TIMEOUT');

    const badXtbUnknownKey = await registry.callTool('ester_run_local_xtb', {
      calculation: 'optimize',
      shellCommand: 'rm -rf /'
    });
    assert.equal(badXtbUnknownKey.isError, true);
    assert.equal(badXtbUnknownKey.structuredContent.error.code, 'UNKNOWN_XTB_ARGUMENT');

    // 4. ester_submit_task happy paths & error validations
    const submitDialogRes = await registry.callTool('ester_submit_task', {
      documentId: 'doc-butane',
      engine: 'orca',
      cores: 8,
      memoryGB: 16
    });
    assert.equal(submitDialogRes.isError, undefined);
    assert.equal(submitDialogRes.structuredContent.mode, 'open-dialog');
    assert.equal(submitDialogRes.structuredContent.submitted, false);

    const submitAutoRes = await registry.callTool('ester_submit_task', {
      documentId: 'doc-butane',
      mode: 'auto-submit',
      environmentId: 'env-local',
      taskName: 'butane_opt'
    });
    assert.equal(submitAutoRes.isError, undefined);
    assert.equal(submitAutoRes.structuredContent.submitted, true);
    assert.equal(submitAutoRes.structuredContent.taskId, 'task-uuid-001');

    const badSubmitUnknownKey = await registry.callTool('ester_submit_task', {
      mode: 'open-dialog',
      rawExec: '/bin/sh'
    });
    assert.equal(badSubmitUnknownKey.isError, true);
    assert.equal(badSubmitUnknownKey.structuredContent.error.code, 'UNKNOWN_SUBMIT_ARGUMENT');

    const badSubmitMode = await registry.callTool('ester_submit_task', {
      mode: 'force-shell'
    });
    assert.equal(badSubmitMode.isError, true);
    assert.equal(badSubmitMode.structuredContent.error.code, 'INVALID_SUBMIT_MODE');

    const badSubmitName = await registry.callTool('ester_submit_task', {
      taskName: 'job\n%pal nprocs 64 end'
    });
    assert.equal(badSubmitName.isError, true);
    assert.equal(badSubmitName.structuredContent.error.code, 'INVALID_TASK_ARGUMENT');

    const badSubmitCores = await registry.callTool('ester_submit_task', {
      cores: 0
    });
    assert.equal(badSubmitCores.isError, true);
    assert.equal(badSubmitCores.structuredContent.error.code, 'INVALID_SUBMIT_CORES');

    const badSubmitMem = await registry.callTool('ester_submit_task', {
      memoryGB: -8
    });
    assert.equal(badSubmitMem.isError, true);
    assert.equal(badSubmitMem.structuredContent.error.code, 'INVALID_SUBMIT_MEMORY');

    // 5. ester_task_manage happy paths & error validations
    const listEnvRes = await registry.callTool('ester_task_manage', {
      action: 'list-environments'
    });
    assert.equal(listEnvRes.isError, undefined);
    assert.equal(listEnvRes.structuredContent.count, 1);

    const detailRes = await registry.callTool('ester_task_manage', {
      action: 'task-detail',
      taskId: 'task-uuid-001'
    });
    assert.equal(detailRes.isError, undefined);
    assert.equal(detailRes.structuredContent.taskId, 'task-uuid-001');

    const badManageUnknownKey = await registry.callTool('ester_task_manage', {
      action: 'list-tasks',
      arbitraryFlag: true
    });
    assert.equal(badManageUnknownKey.isError, true);
    assert.equal(badManageUnknownKey.structuredContent.error.code, 'UNKNOWN_TASK_MANAGE_ARGUMENT');

    for (const actionNeedingId of ['task-detail', 'read-log', 'stop-task']) {
      const missingIdRes = await registry.callTool('ester_task_manage', {
        action: actionNeedingId
      });
      assert.equal(missingIdRes.isError, true);
      assert.equal(missingIdRes.structuredContent.error.code, 'MISSING_TASK_ID');
    }

    const badTailRes = await registry.callTool('ester_task_manage', {
      action: 'read-log',
      taskId: 'task-uuid-001',
      tailLines: 999
    });
    assert.equal(badTailRes.isError, true);
    assert.equal(badTailRes.structuredContent.error.code, 'INVALID_TAIL_LINES');

    const badCategoryRes = await registry.callTool('ester_task_manage', {
      action: 'list-tasks',
      category: 'pending'
    });
    assert.equal(badCategoryRes.isError, true);
    assert.equal(badCategoryRes.structuredContent.error.code, 'INVALID_TASK_CATEGORY');

    assert.equal(seenMessages.length, 5);
  });

  it('validates and dispatches Phase 7 analysis and export tools (ester_open_result_analysis, ester_run_wavefunction_analysis, ester_export_artifact) end-to-end', async () => {
    // 1. Timeout resolution policy for Phase 7 actions
    assert.equal(resolveActionTimeoutMs('run-wavefunction-analysis', {}, undefined, { isClient: false }), 305000);
    assert.equal(resolveActionTimeoutMs('run-wavefunction-analysis', {}, undefined, { isClient: true }), 310000);
    assert.equal(resolveActionTimeoutMs('run-wavefunction-analysis', { timeoutSeconds: 30 }, undefined, { isClient: false }), 35000);
    assert.equal(resolveActionTimeoutMs('run-wavefunction-analysis', { timeoutSeconds: 30 }, undefined, { isClient: true }), 40000);
    assert.equal(resolveActionTimeoutMs('open-result-analysis', {}, undefined, { isClient: false }), 60000);
    assert.equal(resolveActionTimeoutMs('export-artifact', {}, undefined, { isClient: true }), 65000);

    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session-p7.json');
    const logPath = path.join(dir, 'water_freq.log');
    fs.writeFileSync(logPath, 'Entering Gaussian System\nNormal termination of Gaussian 16\n', 'utf8');
    const emptyLogPath = path.join(dir, 'empty.log');
    fs.writeFileSync(emptyLogPath, '', 'utf8');
    const symlinkLogPath = path.join(dir, 'symlink_water.log');
    fs.symlinkSync(logPath, symlinkLogPath);

    let hostRef = null;
    let tokenSeq = 0;
    const openedLaunchTokens = [];
    const closedLaunchTokens = [];
    const seenMessages = [];

    const mockWindow = {
      id: 808,
      isDestroyed: () => false,
      webContents: {
        id: 909,
        isDestroyed: () => false,
        send(channel, message) {
          if (channel !== 'sciyue:mcp-frontend-request') return;
          seenMessages.push(message);
          setImmediate(() => {
            if (message.action === 'frontend.openResultAnalysis') {
              if (message.payload.label === 'FORCE_OPEN_FAILURE') {
                hostRef.handleFrontendReply(909, {
                  requestId: message.requestId,
                  ok: false,
                  error: { code: 'MCP_FILE_IMPORT_FAILED', message: 'Simulated parse error' }
                });
                return;
              }
              if (message.payload.label === 'FORCE_ADOPTED_POST_ERROR') {
                hostRef.handleFrontendReply(909, {
                  requestId: message.requestId,
                  ok: false,
                  error: { code: 'INVALID_FRAME_INDEX', message: 'Post-adopt error', sourceAdopted: true }
                });
                return;
              }
              hostRef.handleFrontendReply(909, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-analysis-1',
                  label: message.payload.label ?? 'water_freq.log',
                  engine: 'gaussian',
                  status: 'completed',
                  activePanel: message.payload.panel ?? 'energy',
                  currentFrameIndex: message.payload.frameIndex ?? 0,
                  sourceToken: message.payload.source?.sourceDescriptor?.token ?? null,
                  taskIdOpened: message.payload.source?.taskId ?? null,
                  vibrations: { available: true, modeCount: 3, imaginaryCount: 0 }
                }
              });
            } else if (message.action === 'frontend.runWavefunctionAnalysis') {
              hostRef.handleFrontendReply(909, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-analysis-1',
                  kind: message.payload.kind,
                  method: message.payload.method,
                  orbitalKey: message.payload.orbitalKey ?? null,
                  renderedInViewport: message.payload.renderInViewport,
                  chargeSum: 0
                }
              });
            } else if (message.action === 'frontend.exportArtifact') {
              const kind = message.payload.kind;
              const content =
                kind === 'structure'
                  ? '3\nwater charge=0 multiplicity=1\nO 0 0 0.1173\nH 0 0.7572 -0.4692\nH 0 -0.7572 -0.4692\n'
                  : kind === 'input-script'
                    ? '#p B3LYP/def2SVP opt\n\nwater\n\n0 1\nO 0 0 0\n\n'
                    : '# source=water.fchk; method=resp\nsource_index\tatom_id\telement\tvalue\n1\ta1\tO\t-0.824\n';
              hostRef.handleFrontendReply(909, {
                requestId: message.requestId,
                ok: true,
                result: {
                  documentId: message.payload.documentId ?? 'doc-analysis-1',
                  kind,
                  format: message.payload.format ?? (kind === 'structure' ? 'xyz' : kind === 'input-script' ? 'gjf' : 'tsv'),
                  content
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
      openLaunchSource: async (_ownerId, filePath) => {
        const token = `p7-tok-${++tokenSeq}`;
        openedLaunchTokens.push({ token, filePath });
        return {
          token,
          name: path.basename(filePath),
          size: fs.statSync(filePath).size
        };
      },
      closeLaunchSource: async (_ownerId, token) => {
        closedLaunchTokens.push(token);
      },
      getHostStatus: () => ({ windowCount: 1, primaryWorkbenchWindowId: 808 })
    });
    hostRef = host;
    activeHosts.push(host);
    await host.start();

    const stdioServer = createMcpStdioServer({ sessionFilePath });
    assert.equal(stdioServer.registry.listTools().length, 18);

    // 2. ester_open_result_analysis happy paths & launch-source cleanup
    const openByFileRes = await stdioServer.registry.callTool('ester_open_result_analysis', {
      source: { filePath: logPath },
      panel: 'vibrations'
    });
    assert.equal(openByFileRes.isError, undefined);
    assert.equal(openByFileRes.structuredContent.ok, true);
    assert.equal(openByFileRes.structuredContent.sourceToken, 'p7-tok-1');
    assert.equal(openByFileRes.structuredContent.activePanel, 'vibrations');
    assert.equal(closedLaunchTokens.length, 0);

    const failOpenByFileRes = await stdioServer.registry.callTool('ester_open_result_analysis', {
      source: { filePath: logPath },
      label: 'FORCE_OPEN_FAILURE'
    });
    assert.equal(failOpenByFileRes.isError, true);
    assert.equal(failOpenByFileRes.structuredContent.error.code, 'MCP_FILE_IMPORT_FAILED');
    assert.deepEqual(closedLaunchTokens, ['p7-tok-2']);

    const failAfterAdoptRes = await stdioServer.registry.callTool('ester_open_result_analysis', {
      source: { filePath: logPath },
      label: 'FORCE_ADOPTED_POST_ERROR'
    });
    assert.equal(failAfterAdoptRes.isError, true);
    assert.equal(failAfterAdoptRes.structuredContent.error.code, 'INVALID_FRAME_INDEX');
    // Token p7-tok-3 was adopted by a live document, so closeLaunchSource must NOT revoke it
    assert.deepEqual(closedLaunchTokens, ['p7-tok-2']);

    const openByTaskRes = await stdioServer.registry.callTool('ester_open_result_analysis', {
      source: { taskId: 'task-snap-01' },
      panel: 'charges',
      frameIndex: 2
    });
    assert.equal(openByTaskRes.isError, undefined);
    assert.equal(openByTaskRes.structuredContent.taskIdOpened, 'task-snap-01');
    assert.equal(openByTaskRes.structuredContent.currentFrameIndex, 2);

    // Validation & symlink/empty errors on ester_open_result_analysis
    const bothSourcesErr = await stdioServer.registry.callTool('ester_open_result_analysis', {
      source: { taskId: 't1', filePath: logPath }
    });
    assert.equal(bothSourcesErr.isError, true);
    assert.equal(bothSourcesErr.structuredContent.error.code, 'INVALID_RESULT_SOURCE');

    const emptySourceErr = await stdioServer.registry.callTool('ester_open_result_analysis', {
      source: {}
    });
    assert.equal(emptySourceErr.isError, true);
    assert.equal(emptySourceErr.structuredContent.error.code, 'INVALID_RESULT_SOURCE');

    const badPanelErr = await stdioServer.registry.callTool('ester_open_result_analysis', {
      panel: 'thermodynamics'
    });
    assert.equal(badPanelErr.isError, true);
    assert.equal(badPanelErr.structuredContent.error.code, 'INVALID_ANALYSIS_PANEL');

    const symlinkImportErr = await stdioServer.registry.callTool('ester_open_result_analysis', {
      source: { filePath: symlinkLogPath }
    });
    assert.equal(symlinkImportErr.isError, true);
    assert.equal(symlinkImportErr.structuredContent.error.code, 'MCP_SYMLINK_NOT_ALLOWED');

    const emptyImportErr = await stdioServer.registry.callTool('ester_open_result_analysis', {
      source: { filePath: emptyLogPath }
    });
    assert.equal(emptyImportErr.isError, true);
    assert.equal(emptyImportErr.structuredContent.error.code, 'MCP_EMPTY_FILE');

    // 3. ester_run_wavefunction_analysis happy paths & validation errors
    const wfDefaultChargeRes = await stdioServer.registry.callTool('ester_run_wavefunction_analysis', {
      documentId: 'doc-analysis-1',
      kind: 'charges'
    });
    assert.equal(wfDefaultChargeRes.isError, undefined);
    assert.equal(wfDefaultChargeRes.structuredContent.method, 'cm5');
    assert.equal(wfDefaultChargeRes.structuredContent.renderedInViewport, true);

    const wfCompRes = await stdioServer.registry.callTool('ester_run_wavefunction_analysis', {
      documentId: 'doc-analysis-1',
      kind: 'composition',
      method: 'scpa',
      orbitalKey: 'HOMO',
      timeoutSeconds: 60
    });
    assert.equal(wfCompRes.isError, undefined);
    assert.equal(wfCompRes.structuredContent.orbitalKey, 'HOMO');

    const wfMissingOrbErr = await stdioServer.registry.callTool('ester_run_wavefunction_analysis', {
      kind: 'composition',
      method: 'mulliken'
    });
    assert.equal(wfMissingOrbErr.isError, true);
    assert.equal(wfMissingOrbErr.structuredContent.error.code, 'MISSING_ORBITAL_KEY');

    const wfBadMethodErr = await stdioServer.registry.callTool('ester_run_wavefunction_analysis', {
      kind: 'charges',
      method: 'nbo-external'
    });
    assert.equal(wfBadMethodErr.isError, true);
    assert.equal(wfBadMethodErr.structuredContent.error.code, 'INVALID_WAVEFUNCTION_METHOD');

    const wfBadIsoErr = await stdioServer.registry.callTool('ester_run_wavefunction_analysis', {
      kind: 'orbitals',
      isovalue: -0.05
    });
    assert.equal(wfBadIsoErr.isError, true);
    assert.equal(wfBadIsoErr.structuredContent.error.code, 'INVALID_ISOVALUE');

    // 4. ester_export_artifact happy paths & strict filesystem/symlink/overwrite guards
    const exportXyzPath = path.join(dir, 'exported_opt.xyz');
    const exportXyzRes = await stdioServer.registry.callTool('ester_export_artifact', {
      documentId: 'doc-analysis-1',
      kind: 'structure',
      format: 'xyz',
      outputPath: exportXyzPath
    });
    assert.equal(exportXyzRes.isError, undefined);
    assert.equal(exportXyzRes.structuredContent.savedPath, exportXyzPath);
    assert.equal(exportXyzRes.structuredContent.lineCount, 5);
    assert.ok(fs.readFileSync(exportXyzPath, 'utf8').includes('water charge=0'));

    // overwrite: false must reject existing file with MCP_FILE_ALREADY_EXISTS
    const noOverwriteErr = await stdioServer.registry.callTool('ester_export_artifact', {
      kind: 'structure',
      outputPath: exportXyzPath,
      overwrite: false
    });
    assert.equal(noOverwriteErr.isError, true);
    assert.equal(noOverwriteErr.structuredContent.error.code, 'MCP_FILE_ALREADY_EXISTS');

    // Export TSV analysis table
    const exportTsvPath = path.join(dir, 'resp_charges.tsv');
    const exportTsvRes = await stdioServer.registry.callTool('ester_export_artifact', {
      kind: 'analysis-table',
      outputPath: exportTsvPath,
      overwrite: false
    });
    assert.equal(exportTsvRes.isError, undefined);
    assert.ok(fs.readFileSync(exportTsvPath, 'utf8').includes('method=resp'));

    // Incompatible kind + format
    const badExportFormatErr = await stdioServer.registry.callTool('ester_export_artifact', {
      kind: 'structure',
      format: 'tsv',
      outputPath: path.join(dir, 'bad.tsv')
    });
    assert.equal(badExportFormatErr.isError, true);
    assert.equal(badExportFormatErr.structuredContent.error.code, 'INVALID_EXPORT_FORMAT');

    // Symlink target & symlink parent directory guards
    const symlinkTarget = path.join(dir, 'symlink_out.xyz');
    fs.symlinkSync(exportXyzPath, symlinkTarget);
    const symlinkTargetErr = await stdioServer.registry.callTool('ester_export_artifact', {
      kind: 'structure',
      outputPath: symlinkTarget
    });
    assert.equal(symlinkTargetErr.isError, true);
    assert.equal(symlinkTargetErr.structuredContent.error.code, 'MCP_SYMLINK_NOT_ALLOWED');

    const realSubDir = path.join(dir, 'real_sub');
    fs.mkdirSync(realSubDir);
    const symlinkParentDir = path.join(dir, 'sym_parent');
    fs.symlinkSync(realSubDir, symlinkParentDir);
    const symlinkParentErr = await stdioServer.registry.callTool('ester_export_artifact', {
      kind: 'structure',
      outputPath: path.join(symlinkParentDir, 'out.xyz')
    });
    assert.equal(symlinkParentErr.isError, true);
    assert.equal(symlinkParentErr.structuredContent.error.code, 'MCP_SYMLINK_NOT_ALLOWED');

    const dirAsFileErr = await stdioServer.registry.callTool('ester_export_artifact', {
      kind: 'structure',
      outputPath: realSubDir
    });
    assert.equal(dirAsFileErr.isError, true);
    assert.equal(dirAsFileErr.structuredContent.error.code, 'MCP_NOT_REGULAR_FILE');

    const missingDirErr = await stdioServer.registry.callTool('ester_export_artifact', {
      kind: 'structure',
      outputPath: path.join(dir, 'nonexistent_folder', 'out.xyz')
    });
    assert.equal(missingDirErr.isError, true);
    assert.equal(missingDirErr.structuredContent.error.code, 'MCP_SAVE_DIR_NOT_FOUND');

    assert.ok(seenMessages.length >= 6);
  });
});
