import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_MCP_SERVER_NAME,
  buildMcpLaunchSpec,
  buildMcpClientConfigs,
  buildMcpHttpClientConfigs,
  createMcpPreferencesStore,
  quotePosixShellArg,
  quoteWindowsShellArg
} = require('../../desktop/mcp/connection-config.cjs');
const { createMcpLiveHost, createMcpLiveClient } = require('../../desktop/mcp/live-bridge.cjs');

describe('MCP connection config & toggle (settings page backend)', () => {
  const tempDirs = [];
  const hosts = [];
  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ester-mcp-conn-'));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    while (hosts.length) await hosts.pop().dispose();
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it('builds a packaged macOS launch spec that reuses the bundled Electron runtime', () => {
    const spec = buildMcpLaunchSpec({
      packaged: true,
      execPath: '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio',
      appPath: '/Applications/Lactone Studio.app/Contents/Resources/app',
      sessionFilePath: '/Users/u/Library/Application Support/Lactone/mcp-session.json',
      platform: 'darwin'
    });
    assert.equal(spec.command, '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio');
    assert.deepEqual(spec.args, ['/Applications/Lactone Studio.app/Contents/Resources/app/desktop/mcp/stdio-server.cjs']);
    assert.deepEqual(spec.env, {
      ELECTRON_RUN_AS_NODE: '1',
      ESTER_MCP_SESSION_FILE: '/Users/u/Library/Application Support/Lactone/mcp-session.json'
    });
  });

  it('builds a Windows portable spec with backslash paths and a development spec using node', () => {
    const win = buildMcpLaunchSpec({
      packaged: true,
      execPath: 'D:\\Tools\\Lactone\\sciyue.exe',
      appPath: 'D:\\Tools\\Lactone\\resources\\app',
      sessionFilePath: 'D:\\Tools\\Lactone\\state\\mcp-session.json',
      platform: 'win32'
    });
    assert.equal(win.args[0], 'D:\\Tools\\Lactone\\resources\\app\\desktop\\mcp\\stdio-server.cjs');
    assert.equal(win.env.ESTER_MCP_SESSION_FILE, 'D:\\Tools\\Lactone\\state\\mcp-session.json');

    const dev = buildMcpLaunchSpec({
      packaged: false,
      execPath: '/repo/node_modules/electron/dist/Electron',
      appPath: '/repo',
      sessionFilePath: '/tmp/s.json',
      platform: 'linux'
    });
    assert.equal(dev.command, 'node');
    assert.deepEqual(dev.args, ['/repo/desktop/mcp/stdio-server.cjs']);
    assert.deepEqual(dev.env, { ESTER_MCP_SESSION_FILE: '/tmp/s.json' });

    assert.throws(() => buildMcpLaunchSpec({ packaged: true, appPath: '/a', sessionFilePath: '/s', platform: 'darwin' }), /execPath/);
    assert.throws(() => buildMcpLaunchSpec({ packaged: false, appPath: '', sessionFilePath: '/s' }), /appPath/);
    assert.throws(() => buildMcpLaunchSpec({ packaged: false, appPath: '/a', sessionFilePath: '' }), /sessionFilePath/);
  });

  it('renders parseable mcpServers JSON, a quoted Claude Code command, and valid Codex TOML', () => {
    const spec = buildMcpLaunchSpec({
      packaged: true,
      execPath: '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio',
      appPath: "/Applications/Lactone Studio.app/Contents/Resources/app",
      sessionFilePath: "/Users/o'neil/Library/mcp-session.json",
      platform: 'darwin'
    });
    const configs = buildMcpClientConfigs(spec, { platform: 'darwin' });
    assert.equal(configs.serverName, DEFAULT_MCP_SERVER_NAME);

    const json = JSON.parse(configs.mcpServersJson);
    assert.deepEqual(json.mcpServers[DEFAULT_MCP_SERVER_NAME], { command: spec.command, args: spec.args, env: spec.env });

    assert.match(configs.claudeCodeCommand, /^claude mcp add lactone-studio --scope user /);
    assert.ok(configs.claudeCodeCommand.includes("-e ELECTRON_RUN_AS_NODE=1"));
    assert.ok(configs.claudeCodeCommand.includes(`-e 'ESTER_MCP_SESSION_FILE=/Users/o'\\''neil/Library/mcp-session.json'`));
    assert.ok(configs.claudeCodeCommand.includes(" -- '/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio' "));

    assert.ok(configs.codexToml.startsWith('[mcp_servers.lactone-studio]\n'));
    assert.ok(configs.codexToml.includes(`command = "/Applications/Lactone Studio.app/Contents/MacOS/Lactone Studio"`));
    assert.ok(configs.codexToml.includes('[mcp_servers.lactone-studio.env]\nELECTRON_RUN_AS_NODE = "1"'));

    const winConfigs = buildMcpClientConfigs(
      { command: 'C:\\Program Files\\Lactone\\sciyue.exe', args: ['C:\\Program Files\\Lactone\\resources\\app\\desktop\\mcp\\stdio-server.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      { platform: 'win32' }
    );
    assert.ok(winConfigs.codexToml.includes('command = "C:\\\\Program Files\\\\Lactone\\\\sciyue.exe"'));
    assert.ok(winConfigs.claudeCodeCommand.includes('-- "C:\\Program Files\\Lactone\\sciyue.exe"'));
    assert.equal(JSON.parse(winConfigs.mcpServersJson).mcpServers['lactone-studio'].command, 'C:\\Program Files\\Lactone\\sciyue.exe');

    assert.throws(() => buildMcpClientConfigs(spec, { serverName: 'bad name' }), /serverName/);
    assert.throws(() => buildMcpClientConfigs(null), /Invalid MCP launch spec/);
    assert.equal(quotePosixShellArg('plain/path'), 'plain/path');
    assert.equal(quoteWindowsShellArg('C:\\a b\\"x'), '"C:\\a b\\\\"x"');
  });

  it('persists MCP enabled, port, and token preferences and tolerates missing or malformed files', async () => {
    const dir = makeTempDir();
    const store = createMcpPreferencesStore(dir);
    assert.deepEqual(store.read(), { enabled: true, port: null, token: null });
    await store.write({ enabled: false, port: 51611, token: '0123456789abcdef0123456789abcdef' });
    assert.deepEqual(createMcpPreferencesStore(dir).read(), {
      enabled: false,
      port: 51611,
      token: '0123456789abcdef0123456789abcdef'
    });
    // Partial patch preserves existing port & token
    await store.write({ enabled: true });
    assert.deepEqual(store.read(), {
      enabled: true,
      port: 51611,
      token: '0123456789abcdef0123456789abcdef'
    });
    fs.writeFileSync(store.filePath, '{not json');
    assert.deepEqual(store.read(), { enabled: true, port: null, token: null });
    fs.writeFileSync(store.filePath, JSON.stringify({ schema: 'other', enabled: false }));
    assert.deepEqual(store.read(), { enabled: true, port: null, token: null });
    await assert.rejects(store.write({ enabled: 'no' }), /boolean/);
    await assert.rejects(store.write({ port: 70000 }), /port/);
    await assert.rejects(store.write({ token: 'short' }), /token/);
    assert.throws(() => createMcpPreferencesStore(''), /directory/);
  });

  it('builds standard MCP Streamable HTTP & SSE client configs with Bearer token and ?token= query URL', () => {
    const token = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const httpConfigs = buildMcpHttpClientConfigs({
      host: '127.0.0.1',
      port: 51611,
      token,
      platform: 'darwin'
    });
    assert.equal(httpConfigs.serverName, DEFAULT_MCP_SERVER_NAME);
    assert.equal(httpConfigs.httpUrl, 'http://127.0.0.1:51611/mcp');
    assert.equal(httpConfigs.sseUrl, 'http://127.0.0.1:51611/sse');
    assert.equal(httpConfigs.httpUrlWithToken, `http://127.0.0.1:51611/mcp?token=${token}`);
    assert.equal(httpConfigs.sseUrlWithToken, `http://127.0.0.1:51611/sse?token=${token}`);

    const parsedJson = JSON.parse(httpConfigs.mcpServersJson);
    assert.deepEqual(parsedJson.mcpServers[DEFAULT_MCP_SERVER_NAME], {
      url: 'http://127.0.0.1:51611/mcp',
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    assert.ok(httpConfigs.claudeCodeCommand.includes('claude mcp add --transport http lactone-studio --scope user --header'));
    assert.ok(httpConfigs.claudeCodeCommand.includes(`Authorization: Bearer ${token}`));
    assert.ok(httpConfigs.codexToml.includes(`url = "http://127.0.0.1:51611/mcp?token=${token}"`));

    assert.throws(() => buildMcpHttpClientConfigs({ port: 0, token }), /port/);
    assert.throws(() => buildMcpHttpClientConfigs({ port: 51611, token: 'short' }), /token/);
  });

  it('stops the live host (removing the session file), supports preserving or rotating token, and falls back when preferredPort is busy', async () => {
    const dir = makeTempDir();
    const sessionFilePath = path.join(dir, 'mcp-session.json');
    const fixedToken = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const host = createMcpLiveHost({
      sessionFilePath,
      initialToken: fixedToken,
      getTargetWindow: () => null,
      getHostStatus: () => ({ windowCount: 0 })
    });
    hosts.push(host);

    const first = await host.start();
    assert.equal(host.isRunning(), true);
    assert.equal(first.token, fixedToken);
    assert.ok(fs.existsSync(sessionFilePath));
    const client = createMcpLiveClient({ sessionFilePath, timeoutMs: 3000 });
    const ping = await client.dispatch('ping', {});
    assert.equal(ping.desktopConnected, true);

    // Stopping with rotateToken: false preserves the token and reuses the port
    await host.stop({ rotateToken: false });
    assert.equal(host.isRunning(), false);
    assert.equal(host.getToken(), fixedToken);
    const restartedSameToken = await host.start();
    assert.equal(restartedSameToken.token, fixedToken);

    // Explicit rotateToken updates the active token and session file
    const rotated = await host.rotateToken();
    assert.notEqual(rotated, fixedToken);
    assert.equal(host.getToken(), rotated);
    assert.equal(JSON.parse(fs.readFileSync(sessionFilePath, 'utf8')).token, rotated);

    // Default stop() rotates the token
    await host.stop();
    assert.equal(host.isRunning(), false);
    assert.equal(host.getSessionInfo(), null);
    assert.equal(fs.existsSync(sessionFilePath), false);
    const offline = await client.dispatch('ping', {});
    assert.equal(offline.desktopConnected, false);

    const second = await host.start();
    assert.equal(host.isRunning(), true);
    assert.notEqual(second.token, rotated);
    assert.equal(JSON.parse(fs.readFileSync(sessionFilePath, 'utf8')).token, second.token);
    const again = await client.dispatch('ping', {});
    assert.equal(again.desktopConnected, true);
    await host.stop();

    // Occupy a port to verify preferredPort fallback to an ephemeral port
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = blocker.address().port;
    try {
      const fallbackHost = createMcpLiveHost({
        sessionFilePath: path.join(dir, 'mcp-session-fallback.json'),
        preferredPort: busyPort,
        getTargetWindow: () => null,
        getHostStatus: () => ({ windowCount: 0 })
      });
      hosts.push(fallbackHost);
      const fallbackSession = await fallbackHost.start();
      assert.ok(fallbackSession.port > 0);
      assert.notEqual(fallbackSession.port, busyPort);
    } finally {
      await new Promise(resolve => blocker.close(resolve));
    }
  });
});
