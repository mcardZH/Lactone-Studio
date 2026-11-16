import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createMcpToolRegistry,
  registerTaskExecutionTools,
  normalizeEnvironmentManageArguments,
  VALID_ENVIRONMENT_MANAGE_ACTIONS
} = require('../../desktop/mcp/protocol.cjs');
const { resolveActionTimeoutMs, createMcpLiveHost } = require('../../desktop/mcp/live-bridge.cjs');
const { createMcpStdioServer } = require('../../desktop/mcp/stdio-server.cjs');

function toolPayload(result) {
  return JSON.parse(result.content[0].text);
}

describe('MCP ester_environment_manage tool (Task Center execution environments)', () => {
  const tempDirs = [];
  const hosts = [];
  afterEach(async () => {
    while (hosts.length) await hosts.pop().dispose();
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it('is registered in the stdio server catalog with a strict schema', () => {
    const server = createMcpStdioServer({ input: new PassThrough(), output: new PassThrough(), sessionFilePath: path.join(os.tmpdir(), 'unused-mcp.json') });
    const tool = server.registry.listTools().find(t => t.name === 'ester_environment_manage');
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.properties.action.enum, [...VALID_ENVIRONMENT_MANAGE_ACTIONS]);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.environment.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ['action']);
  });

  it('normalizes valid arguments for every action', () => {
    assert.deepEqual(normalizeEnvironmentManageArguments({ action: 'list' }), { action: 'list' });
    assert.deepEqual(normalizeEnvironmentManageArguments({ action: 'get', environmentId: ' env-1 ' }), { action: 'get', environmentId: 'env-1' });
    assert.deepEqual(
      normalizeEnvironmentManageArguments({
        action: 'create',
        environment: { mode: 'slurm', engineId: 'orca', host: 'hpc', port: 2222, user: 'me', executable: '/opt/orca/orca', workingRoot: '/home/me/jobs', initialization: 'module load orca\nexport X=1', timeLimit: '24:00:00' },
        secret: { password: 'pw' },
        openTaskCenter: true
      }),
      {
        action: 'create',
        environment: { mode: 'slurm', engineId: 'orca', host: 'hpc', port: 2222, user: 'me', executable: '/opt/orca/orca', workingRoot: '/home/me/jobs', initialization: 'module load orca\nexport X=1', timeLimit: '24:00:00' },
        secret: { password: 'pw', remember: false },
        openTaskCenter: true
      }
    );
    assert.deepEqual(normalizeEnvironmentManageArguments({ action: 'update', environmentId: 'e', secret: { privateKeyPassphrase: 'k', remember: true } }).secret, { privateKeyPassphrase: 'k', remember: true });
    assert.deepEqual(normalizeEnvironmentManageArguments({ action: 'check', environmentId: 'e' }), { action: 'check', environmentId: 'e' });
    assert.deepEqual(
      normalizeEnvironmentManageArguments({ action: 'trust-host-key', challengeId: 'c1', fingerprint: 'SHA256:abc', confirm: true }),
      { action: 'trust-host-key', challengeId: 'c1', fingerprint: 'SHA256:abc', confirm: true }
    );
    assert.deepEqual(
      normalizeEnvironmentManageArguments({ action: 'browse', environmentId: 'e', browsePurpose: 'executable', browsePath: '/opt' }),
      { action: 'browse', environmentId: 'e', browsePurpose: 'executable', browsePath: '/opt' }
    );
    assert.deepEqual(normalizeEnvironmentManageArguments({ action: 'delete', environmentId: 'e', confirm: true, expectedRevision: 3 }), { action: 'delete', environmentId: 'e', expectedRevision: 3, confirm: true });
  });

  it('rejects malformed, incomplete, and unconfirmed requests', () => {
    const bad = [
      [{}, /action must be one of/],
      [{ action: 'nope' }, /action must be one of/],
      [{ action: 'list', extra: 1 }, /Unknown argument "extra"/],
      [{ action: 'get' }, /environmentId is required/],
      [{ action: 'update', environmentId: 'e' }, /update requires environment fields/],
      [{ action: 'create' }, /environment is required/],
      [{ action: 'create', environment: { connectionKind: 'ftp' } }, /connectionKind must be one of/],
      [{ action: 'create', environment: { mode: 'ssh', connectionKind: 'ssh' } }, /mode cannot be combined/],
      [{ action: 'create', environment: { port: 70000 } }, /port must be an integer/],
      [{ action: 'create', environment: { host: 'a\nb' } }, /single-line/],
      [{ action: 'create', environment: { scratchRoot: '/x' } }, /Unknown environment field "scratchRoot"/],
      [{ action: 'create', environment: {}, secret: { password: 'a', privateKeyPassphrase: 'b' } }, /either password or privateKeyPassphrase/],
      [{ action: 'create', environment: { authentication: 'agent' }, secret: { password: 'a' } }, /authentication is "agent"/],
      [{ action: 'create', environment: { authentication: 'password' }, secret: { privateKeyPassphrase: 'a' } }, /authentication is "password"/],
      [{ action: 'create', environment: { authentication: 'private-key' }, secret: { password: 'a' } }, /authentication is "private-key"/],
      [{ action: 'create', environment: {}, secret: { remember: true } }, /requires password or privateKeyPassphrase/],
      [{ action: 'create', environment: {}, secret: { token: 'x' } }, /Unknown secret field/],
      [{ action: 'check' }, /requires environmentId/],
      [{ action: 'browse', environmentId: 'e' }, /browsePurpose must be one of/],
      [{ action: 'list', browsePath: '/x' }, /only accepted when action is "browse"/],
      [{ action: 'delete', environmentId: 'e' }, /confirm: true/],
      [{ action: 'trust-host-key', challengeId: 'c', fingerprint: 'f' }, /confirm: true/],
      [{ action: 'trust-host-key', confirm: true }, /challengeId/],
      [{ action: 'get', environmentId: 'e', environment: {} }, /not accepted/],
      [{ action: 'list', windowId: 0 }, /windowId/],
      [{ action: 'list', openTaskCenter: 'yes' }, /openTaskCenter must be a boolean/]
    ];
    for (const [args, pattern] of bad) {
      assert.throws(() => normalizeEnvironmentManageArguments(args), pattern, JSON.stringify(args));
    }
  });

  it('dispatches validated payloads and reports tool errors without echoing secrets', async () => {
    const calls = [];
    const registry = createMcpToolRegistry();
    registerTaskExecutionTools(registry, {
      dispatchToHost: async (action, payload) => {
        calls.push({ action, payload });
        return { action: payload.action, saved: true };
      }
    });
    const ok = await registry.callTool('ester_environment_manage', { action: 'update', environmentId: 'e', environment: { user: 'u' }, secret: { password: 'TOP-SECRET' } });
    assert.equal(ok.isError, undefined);
    assert.deepEqual(toolPayload(ok), { ok: true, action: 'update', saved: true });
    assert.equal(calls[0].action, 'environment-manage');
    assert.equal(calls[0].payload.secret.password, 'TOP-SECRET');

    const failed = await registry.callTool('ester_environment_manage', { action: 'delete', environmentId: 'e' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /ENVIRONMENT_CONFIRMATION_REQUIRED/);
    assert.equal(calls.length, 1);
  });

  it('routes environment-manage through the live host to the frontend with task-class timeouts', async () => {
    assert.equal(resolveActionTimeoutMs('environment-manage', {}, undefined, { isClient: false }), 60000);
    assert.equal(resolveActionTimeoutMs('environment-manage', {}, undefined, { isClient: true }), 65000);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ester-mcp-env-'));
    tempDirs.push(dir);
    const seen = [];
    let hostRef = null;
    const mockWindow = {
      id: 1,
      isDestroyed: () => false,
      webContents: {
        id: 11,
        isDestroyed: () => false,
        send(channel, message) {
          seen.push({ channel, message });
          setImmediate(() => hostRef.handleFrontendReply(11, { requestId: message.requestId, ok: true, result: { action: message.payload.action, environmentCount: 0 } }));
        }
      }
    };
    const host = createMcpLiveHost({
      sessionFilePath: path.join(dir, 'mcp-session.json'),
      getTargetWindow: () => mockWindow,
      getHostStatus: () => ({ windowCount: 1 })
    });
    hostRef = host;
    hosts.push(host);
    const result = await host.dispatchAction('environment-manage', { windowId: 1, action: 'list' });
    assert.deepEqual(result, { action: 'list', environmentCount: 0 });
    assert.equal(seen[0].channel, 'sciyue:mcp-frontend-request');
    assert.equal(seen[0].message.action, 'frontend.environmentManage');
    assert.deepEqual(seen[0].message.payload, { action: 'list' });
  });
});
