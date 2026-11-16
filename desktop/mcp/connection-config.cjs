'use strict';

/**
 * Pure helpers that describe how an external AI client (Antigravity, Claude
 * Desktop/Code, Cursor, Codex, ...) launches the Lactone Studio MCP stdio
 * bridge, plus a tiny persisted "MCP enabled" preference store.
 *
 * The launch spec always reuses the running application's own runtime:
 * - packaged builds start the bundled Electron binary in Node mode
 *   (`ELECTRON_RUN_AS_NODE=1`) so users never need a separate Node.js install;
 * - development checkouts use `node <repo>/desktop/mcp/stdio-server.cjs`.
 * `ESTER_MCP_SESSION_FILE` is always injected so portable / custom profile
 * directories resolve the exact session file written by the live host.
 */

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_MCP_SERVER_NAME = 'lactone-studio';
const MCP_PREFERENCES_FILE = 'mcp-preferences.json';
const MCP_PREFERENCES_SCHEMA = 'lactone-mcp-preferences/v1';

function pathApiFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {{ packaged: boolean, execPath: string, appPath: string, sessionFilePath: string, platform?: NodeJS.Platform, nodeCommand?: string }} options
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
function buildMcpLaunchSpec({
  packaged,
  execPath,
  appPath,
  sessionFilePath,
  platform = process.platform,
  nodeCommand = 'node'
} = {}) {
  requireNonEmptyString(appPath, 'appPath');
  requireNonEmptyString(sessionFilePath, 'sessionFilePath');
  const api = pathApiFor(platform);
  const scriptPath = api.join(appPath, 'desktop', 'mcp', 'stdio-server.cjs');
  if (packaged) {
    requireNonEmptyString(execPath, 'execPath');
    return {
      command: execPath,
      args: [scriptPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ESTER_MCP_SESSION_FILE: sessionFilePath
      }
    };
  }
  return {
    command: requireNonEmptyString(nodeCommand, 'nodeCommand'),
    args: [scriptPath],
    env: {
      ESTER_MCP_SESSION_FILE: sessionFilePath
    }
  };
}

function quotePosixShellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsShellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_\-./:=@%+,\\]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function assertServerName(serverName) {
  if (typeof serverName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(serverName)) {
    throw new TypeError('serverName must match /^[A-Za-z0-9_-]{1,64}$/');
  }
  return serverName;
}

/** TOML basic strings accept the JSON escape set used by JSON.stringify. */
function tomlString(value) {
  return JSON.stringify(String(value));
}

/**
 * @param {{ command: string, args: string[], env: Record<string, string> }} spec
 * @param {{ serverName?: string, platform?: NodeJS.Platform }} [options]
 */
function buildMcpClientConfigs(spec, { serverName = DEFAULT_MCP_SERVER_NAME, platform = process.platform } = {}) {
  assertServerName(serverName);
  if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args) || !spec.env || typeof spec.env !== 'object') {
    throw new TypeError('Invalid MCP launch spec');
  }
  const envEntries = Object.entries(spec.env);

  const mcpServersJson = JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          command: spec.command,
          args: [...spec.args],
          env: { ...spec.env }
        }
      }
    },
    null,
    2
  );

  const quote = platform === 'win32' ? quoteWindowsShellArg : quotePosixShellArg;
  const claudeCodeCommand = [
    'claude',
    'mcp',
    'add',
    serverName,
    '--scope',
    'user',
    ...envEntries.flatMap(([key, value]) => ['-e', quote(`${key}=${value}`)]),
    '--',
    quote(spec.command),
    ...spec.args.map(quote)
  ].join(' ');

  const codexToml = [
    `[mcp_servers.${serverName}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(', ')}]`,
    '',
    `[mcp_servers.${serverName}.env]`,
    ...envEntries.map(([key, value]) => `${key} = ${tomlString(value)}`)
  ].join('\n') + '\n';

  return Object.freeze({ serverName, mcpServersJson, claudeCodeCommand, codexToml });
}

function normalizePort(port) {
  if (port === null || port === undefined) return null;
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  return null;
}

function normalizeToken(token) {
  if (token === null || token === undefined) return null;
  if (typeof token === 'string' && token.trim().length >= 16) return token.trim();
  return null;
}

/**
 * Build standard MCP Streamable HTTP / SSE client configuration snippets.
 * @param {{ host?: string, port: number, token: string, serverName?: string, platform?: NodeJS.Platform }} options
 */
function buildMcpHttpClientConfigs({
  host = '127.0.0.1',
  port,
  token,
  serverName = DEFAULT_MCP_SERVER_NAME,
  platform = process.platform
} = {}) {
  assertServerName(serverName);
  const cleanHost = requireNonEmptyString(host, 'host').trim();
  const validPort = normalizePort(port);
  if (validPort === null) {
    throw new TypeError('port must be an integer between 1 and 65535');
  }
  const validToken = normalizeToken(token);
  if (validToken === null) {
    throw new TypeError('token must be a non-empty string of at least 16 characters');
  }

  const httpUrl = `http://${cleanHost}:${validPort}/mcp`;
  const sseUrl = `http://${cleanHost}:${validPort}/sse`;
  const encodedToken = encodeURIComponent(validToken);
  const httpUrlWithToken = `${httpUrl}?token=${encodedToken}`;
  const sseUrlWithToken = `${sseUrl}?token=${encodedToken}`;

  const mcpServersJson = JSON.stringify(
    {
      mcpServers: {
        [serverName]: {
          url: httpUrl,
          headers: {
            Authorization: `Bearer ${validToken}`
          }
        }
      }
    },
    null,
    2
  );

  const quote = platform === 'win32' ? quoteWindowsShellArg : quotePosixShellArg;
  const claudeCodeCommand = [
    'claude',
    'mcp',
    'add',
    '--transport',
    'http',
    serverName,
    '--scope',
    'user',
    '--header',
    quote(`Authorization: Bearer ${validToken}`),
    quote(httpUrl)
  ].join(' ');

  const codexToml = [
    `[mcp_servers.${serverName}]`,
    `url = ${tomlString(httpUrlWithToken)}`
  ].join('\n') + '\n';

  return Object.freeze({
    serverName,
    httpUrl,
    sseUrl,
    httpUrlWithToken,
    sseUrlWithToken,
    mcpServersJson,
    claudeCodeCommand,
    codexToml
  });
}

/**
 * Persisted MCP preferences (`enabled`, `port`, `token`). Missing / unreadable /
 * malformed files fall back to defaults without throwing so the host never fails to boot.
 * @param {string} directory profile directory (Electron userData)
 */
function createMcpPreferencesStore(directory) {
  requireNonEmptyString(directory, 'directory');
  const filePath = path.join(path.resolve(directory), MCP_PREFERENCES_FILE);

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.schema === MCP_PREFERENCES_SCHEMA && typeof parsed.enabled === 'boolean') {
        return {
          enabled: parsed.enabled,
          port: normalizePort(parsed.port),
          token: normalizeToken(parsed.token)
        };
      }
    } catch {
      // Fall through to defaults.
    }
    return { enabled: true, port: null, token: null };
  }

  async function write(patch = {}) {
    if (!patch || typeof patch !== 'object') {
      throw new TypeError('preferences patch must be an object');
    }
    const current = read();
    let enabled = current.enabled;
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
      enabled = patch.enabled;
    }
    let port = current.port;
    if (patch.port !== undefined) {
      if (patch.port === null) {
        port = null;
      } else {
        const normalized = normalizePort(patch.port);
        if (normalized === null) throw new TypeError('port must be an integer between 1 and 65535 or null');
        port = normalized;
      }
    }
    let token = current.token;
    if (patch.token !== undefined) {
      if (patch.token === null) {
        token = null;
      } else {
        const normalized = normalizeToken(patch.token);
        if (normalized === null) throw new TypeError('token must be a string of at least 16 characters or null');
        token = normalized;
      }
    }
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.writeFile(
      tempFile,
      JSON.stringify({ schema: MCP_PREFERENCES_SCHEMA, enabled, port, token }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
    await fsPromises.rename(tempFile, filePath);
    return { enabled, port, token };
  }

  return Object.freeze({ read, write, filePath });
}

module.exports = {
  DEFAULT_MCP_SERVER_NAME,
  MCP_PREFERENCES_FILE,
  MCP_PREFERENCES_SCHEMA,
  buildMcpLaunchSpec,
  buildMcpClientConfigs,
  buildMcpHttpClientConfigs,
  createMcpPreferencesStore,
  quotePosixShellArg,
  quoteWindowsShellArg
};
