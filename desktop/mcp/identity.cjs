'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { isId, isSecret, isToolDescriptor, newSecret, failure } = require('./wire.cjs');
const MCP_CONNECT_LAUNCH = '--mcp-connect-launch';

function sameExecutable(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string' || !path.isAbsolute(first) || !path.isAbsolute(second)) return false;
  const normalized = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  return normalized(first) === normalized(second);
}

function discoveryDirectory(env = process.env, { platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.ES_MCP_DISCOVERY_DIR) return env.ES_MCP_DISCOVERY_DIR;
  if (platform === 'win32') return env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Lactone Studio', 'MCP', 'v1');
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', 'Lactone Studio', 'MCP', 'v1');
  const dataHome = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share');
  return path.join(dataHome, 'Lactone Studio', 'MCP', 'v1');
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function pipeName(id, { platform = process.platform, tmpdir = os.tmpdir(), socketDir } = {}) {
  if (!isId(id)) throw failure('invalid_instance', '无效的 ES 实例标识。');
  if (platform === 'win32') return `\\\\.\\pipe\\ester-studio-mcp-${id}`;
  // POSIX AF_UNIX sun_path limit is 104 bytes on macOS and 108 bytes on Linux.
  const leaf = `ls-mcp-${hash(id).slice(0, 16)}.sock`;
  const preferredBase = socketDir || tmpdir;
  const candidate = path.join(preferredBase, leaf);
  if (Buffer.byteLength(candidate, 'utf8') <= 96) return candidate;
  return path.join('/tmp', leaf);
}

// On Windows, OS-level DPAPI binds secrets to the current user. On POSIX
// (macOS/Linux), secrets rely on strict 0o700/0o600 user-owned file permissions.
function protectData(action, bytes, { platform = process.platform } = {}) {
  if (!['Protect', 'Unprotect'].includes(action)) {
    throw failure('secure_storage_unavailable', '不支持的凭据操作。');
  }
  if (platform !== 'win32') {
    return Promise.resolve(Buffer.from(bytes));
  }
  const root = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ` +
    `$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ` +
    `$result=[Security.Cryptography.ProtectedData]::${action}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => {
      const stdout = Buffer.concat(chunks).toString('ascii').trim();
      if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(stdout)) {
        reject(failure('secure_storage_unavailable', '无法使用当前 Windows 用户凭据。'));
      } else resolve(Buffer.from(stdout, 'base64'));
    });
    child.stdin.end(Buffer.from(bytes).toString('base64'));
  });
}

const protect = bytes => protectData('Protect', bytes);
const unprotect = bytes => protectData('Unprotect', bytes);

async function writePrivateJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try { await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

function livePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function livePipe(instanceId) {
  return new Promise(resolve => {
    const socket = net.createConnection(pipeName(instanceId));
    let available = false;
    const timeout = setTimeout(() => socket.destroy(), 350);
    socket.once('connect', () => { available = true; socket.destroy(); });
    socket.once('error', () => {});
    socket.once('close', () => { clearTimeout(timeout); resolve(available); });
  });
}

async function discover(dir) {
  if (!dir) throw failure('discovery_unavailable', '找不到当前用户的 ES 连接目录。');
  let names;
  try { names = await fs.readdir(path.join(dir, 'instances')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const instances = await Promise.all(names.filter(name => isId(name.slice(0, -5)) && name.endsWith('.json')).map(async name => {
    try {
      const value = JSON.parse(await fs.readFile(path.join(dir, 'instances', name), 'utf8'));
      if (value.version !== 1 || value.instanceId !== name.slice(0, -5) || !livePid(value.pid) || typeof value.protectedSecret !== 'string') return null;
      // PID reuse may leave a descriptor that appears live after abrupt exit.
      // Discovery checks the exact instance endpoint; binding still authenticates it.
      if (process.platform === 'win32' && !await livePipe(value.instanceId)) return null;
      const windows = Array.isArray(value.windows) ? value.windows.filter(row => isId(row?.windowId)) : [];
      const tools = Array.isArray(value.tools) ? value.tools.filter(isToolDescriptor) : [];
      return { instanceId: value.instanceId, pid: value.pid, protectedSecret: value.protectedSecret, windows, tools,
        ...(typeof value.executable === 'string' && path.isAbsolute(value.executable) ? { executable: value.executable } : {}) };
    } catch { return null; }
  }));
  return instances.filter(Boolean);
}

async function clientIdentity(dir, label, protection = { protect, unprotect }) {
  const file = path.join(dir, 'clients', `${hash(label)}.bin`);
  const read = async () => (await protection.unprotect(await fs.readFile(file))).toString('ascii');
  let key;
  try { key = await read(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const generated = newSecret();
    const protectedKey = await protection.protect(Buffer.from(generated, 'ascii'));
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, protectedKey, { mode: 0o600, flag: 'wx' });
    try {
      await fs.link(temp, file);
      key = generated;
    } catch (publishError) {
      if (publishError.code !== 'EEXIST') throw publishError;
      key = await read();
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  if (!isSecret(key)) throw failure('invalid_client_identity', 'ES 客户端凭据无效。');
  return key;
}

module.exports = { discoveryDirectory, pipeName, hash, protect, unprotect, writePrivateJSON, discover, clientIdentity, sameExecutable, MCP_CONNECT_LAUNCH };
