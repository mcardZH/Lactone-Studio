import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  discoveryDirectory,
  pipeName,
  protect,
  unprotect,
  discover,
  clientIdentity,
  sameExecutable
} = require('../../desktop/mcp/identity.cjs');
const { createMcpHost } = require('../../desktop/mcp/host.cjs');
const { portableConnection, runStdio, openBinding } = require('../../desktop/mcp/stdio.cjs');

describe('Cross-platform upstream mcpHost (identity, Unix sockets, stdio, callExternal)', () => {
  const tempDirs = [];
  const hosts = [];

  function makeTempDir(prefix = 'lactone-host-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (hosts.length > 0) {
      const h = hosts.pop();
      await h.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves discovery directories and short Unix socket endpoints across darwin, linux, and win32', async () => {
    assert.equal(
      discoveryDirectory({}, { platform: 'darwin', homedir: '/Users/bob' }),
      path.join('/Users/bob', 'Library', 'Application Support', 'Lactone Studio', 'MCP', 'v1')
    );
    assert.equal(
      discoveryDirectory({ XDG_DATA_HOME: '/custom/xdg' }, { platform: 'linux', homedir: '/home/bob' }),
      path.join('/custom/xdg', 'Lactone Studio', 'MCP', 'v1')
    );
    assert.equal(
      discoveryDirectory({}, { platform: 'linux', homedir: '/home/bob' }),
      path.join('/home/bob', '.local', 'share', 'Lactone Studio', 'MCP', 'v1')
    );
    assert.equal(
      discoveryDirectory({ LOCALAPPDATA: 'C:\\Users\\bob\\AppData\\Local' }, { platform: 'win32', homedir: 'C:\\Users\\bob' }),
      path.join('C:\\Users\\bob\\AppData\\Local', 'Lactone Studio', 'MCP', 'v1')
    );
    assert.equal(
      discoveryDirectory({ ES_MCP_DISCOVERY_DIR: '/override/dir' }, { platform: 'darwin', homedir: '/Users/bob' }),
      '/override/dir'
    );

    const sampleId = randomUUID();
    const winPipe = pipeName(sampleId, { platform: 'win32' });
    assert.equal(winPipe, `\\\\.\\pipe\\ester-studio-mcp-${sampleId}`);

    const longTmp = '/var/folders/xx/very_long_macos_sandbox_directory_name_exceeding_normal_limits/T';
    const sockPath = pipeName(sampleId, { platform: 'darwin', tmpdir: longTmp });
    assert.ok(Buffer.byteLength(sockPath, 'utf8') <= 96, `Unix socket path too long: ${sockPath}`);
    assert.ok(sockPath.endsWith('.sock'));

    if (process.platform !== 'win32') {
      const dir = makeTempDir();
      const rawSecret = Buffer.from('0123456789abcdef', 'ascii');
      const sealed = await protect(rawSecret);
      const unsealed = await unprotect(sealed);
      assert.deepEqual(unsealed, rawSecret);

      const firstKey = await clientIdentity(dir, 'codex');
      const secondKey = await clientIdentity(dir, 'codex');
      assert.equal(firstKey, secondKey);
      assert.match(firstKey, /^[a-f0-9]{64}$/);
    }
    assert.equal(sameExecutable('/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio', '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio'), true);
    assert.equal(sameExecutable('relative/path', '/abs/path'), false);
  });

  it('starts createMcpHost over Unix socket on POSIX, supports callExternal & onCatalogChanged, and cleans socket on close', async () => {
    if (process.platform === 'win32') return;

    const rootDir = makeTempDir();
    const profileRoot = path.join(rootDir, 'profile');
    const discoveryDir = path.join(rootDir, 'discovery');
    const sockBase = makeTempDir('ls-sock-');
    let lastPayload = null;
    let hostRef = null;
    let catalogEvents = 0;

    const host = createMcpHost({
      profileRoot,
      discoveryDir,
      executable: process.execPath,
      entry: path.resolve(import.meta.dirname, '../../desktop/mcp/stdio.cjs'),
      listenPath: id => pipeName(id, { platform: process.platform, socketDir: sockBase }),
      send(owner, channel, payload) {
        if (channel === 'mcp-request') {
          lastPayload = payload;
          setImmediate(() => {
            hostRef.reply(owner, {
              requestId: payload.requestId,
              ok: true,
              value: { echoed: payload.arguments, tool: payload.name, owner }
            });
          });
        }
        return true;
      },
      async confirm() { return 'once'; },
      show: owner => ({ instanceId: 'i', windowId: String(owner), view: 'workbench', visible: true, focused: true, minimized: false })
    });
    hostRef = host;
    hosts.push(host);

    const unsubscribe = host.onCatalogChanged(() => { catalogEvents += 1; });
    await host.start();
    host.attach(42);
    host.attach(84);

    await host.publish(42, {
      tools: [
        { name: 'es_targets', description: 'List targets', inputSchema: { type: 'object', properties: { kind: { type: 'string' } }, additionalProperties: false } },
        { name: 'model_read', description: 'Read model', inputSchema: { type: 'object', properties: { modelRef: { type: 'string' } }, additionalProperties: false } }
      ]
    });
    await host.publish(84, {
      tools: [
        { name: 'model_read', description: 'Read model', inputSchema: { type: 'object', properties: { modelRef: { type: 'string' } }, additionalProperties: false } }
      ]
    });
    assert.ok(catalogEvents >= 2);
    unsubscribe();

    const discovered = await discover(discoveryDir);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].windows.length, 2);

    // callExternal runs without interactive dialog and routes es_targets kind=window across windows
    const targetsRes = await host.callExternal(42, { clientName: 'Test External' }, 'es_targets', { kind: 'window' });
    assert.equal(targetsRes.total, 2);
    assert.equal(targetsRes.items[0].label, 'Lactone Studio 窗口');

    const callRes = await host.callExternal(42, { clientName: 'Test External' }, 'model_read', { modelRef: 'doc-1' });
    assert.equal(callRes.tool, 'model_read');
    assert.deepEqual(callRes.echoed, { modelRef: 'doc-1' });
    assert.equal(lastPayload.session.clientName, 'Test External');

    // Also test real stdio MCP adapter handshake over Unix socket
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stdio = runStdio({
      stdin,
      stdout,
      dir: discoveryDir,
      options: { client: 'stdio-unix-test' },
      bind: params => openBinding({
        ...params,
        connectPath: id => pipeName(id, { platform: process.platform, socketDir: sockBase })
      })
    });
    const responses = [];
    let waitForId;
    stdout.on('data', chunk => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        responses.push(msg);
        if (waitForId && msg.id === waitForId.id) {
          const resolve = waitForId.resolve;
          waitForId = null;
          resolve(msg);
        }
      }
    });
    const sendRpc = msg => new Promise(resolve => {
      waitForId = { id: msg.id, resolve };
      stdin.write(JSON.stringify(msg) + '\n');
    });

    const initReply = await sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 'unix-test', version: '1.0' } }
    });
    assert.equal(initReply.result.serverInfo.name, 'lactone-studio');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const connectReply = await sendRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'es_connect', arguments: { windowId: host.state(42).windowId } }
    });
    assert.equal(connectReply.result.isError, undefined);

    const modelReply = await sendRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'model_read', arguments: { modelRef: 'via-unix-sock' } }
    });
    assert.equal(JSON.parse(modelReply.result.content[0].text).echoed.modelRef, 'via-unix-sock');

    stdio.close();

    const sockFile = pipeName(host.state(42).instanceId, { platform: process.platform, socketDir: sockBase });
    assert.equal(fs.existsSync(sockFile), true);
    await host.close();
    assert.equal(fs.existsSync(sockFile), false);
  });

  it('detects packaged launcher paths across darwin .app and linux', () => {
    const darwinBundle = portableConnection(
      '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio',
      '/Applications/Lactone Studio.app/Contents/Resources/app/desktop/mcp',
      fs,
      'darwin'
    );
    assert.deepEqual(darwinBundle, {
      executable: '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio',
      launcher: '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio'
    });

    const linuxPkg = portableConnection(
      '/opt/lactone-studio/lactone-studio',
      '/opt/lactone-studio/resources/app/desktop/mcp',
      fs,
      'linux'
    );
    assert.deepEqual(linuxPkg, {
      executable: '/opt/lactone-studio/lactone-studio',
      launcher: '/opt/lactone-studio/lactone-studio'
    });

    assert.equal(portableConnection('/usr/local/bin/node', '/other/dir', fs, 'darwin'), undefined);
  });
});
