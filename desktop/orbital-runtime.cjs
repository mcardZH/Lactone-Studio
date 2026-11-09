'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assert, plain, string } = require('./security.cjs');

const DARWIN_DEFAULT_CANDIDATES = Object.freeze([
  '/opt/homebrew/opt/multiwfn/bin/multiwfn',
  '/opt/homebrew/bin/multiwfn',
  '/usr/local/opt/multiwfn/bin/multiwfn',
  '/usr/local/bin/multiwfn',
]);

const POSIX_DIRECTORY_CANDIDATES = Object.freeze([
  'Multiwfn',
  'multiwfn',
  path.posix.join('bin', 'Multiwfn'),
  path.posix.join('bin', 'multiwfn'),
]);

/** A user-selected or host-installed local executable is the only external capability. */
function createOrbitalBackendStore(root, options = {}) {
  const { platform = process.platform, env = process.env, defaultCandidates } = options;
  const location = path.join(root, 'orbital-backend.json');

  async function checked(executable) {
    assert(string(executable, 4096) && path.isAbsolute(executable), 'Select a local Multiwfn executable');
    if (platform === 'win32') {
      const selected = await fs.lstat(executable).catch(() => null);
      if (selected?.isDirectory() && !selected.isSymbolicLink()) {
        executable = path.join(executable, 'Multiwfn.exe');
      }
      assert(/^Multiwfn(?:\.exe)?$/i.test(path.basename(executable)), 'Select a local Multiwfn executable');
      const stat = await fs.lstat(executable);
      assert(stat.isFile() && !stat.isSymbolicLink(), 'Multiwfn executable must be a regular file');
      return fs.realpath(executable);
    }

    let resolved = await fs.realpath(executable).catch(() => null);
    assert(resolved, 'Select a local Multiwfn executable');
    let stat = await fs.lstat(resolved).catch(() => null);
    if (stat?.isDirectory() && !stat.isSymbolicLink()) {
      for (const relative of POSIX_DIRECTORY_CANDIDATES) {
        const candidate = await fs.realpath(path.join(resolved, relative)).catch(() => null);
        if (!candidate) continue;
        const candidateStat = await fs.lstat(candidate).catch(() => null);
        if (candidateStat?.isFile() && !candidateStat.isSymbolicLink()) {
          resolved = candidate;
          stat = candidateStat;
          break;
        }
      }
    }
    assert(
      stat?.isFile() && !stat.isSymbolicLink() && /^Multiwfn(?:\.exe)?$/i.test(path.basename(resolved)),
      'Select a local Multiwfn executable',
    );
    assert((stat.mode & 0o111) !== 0, 'Multiwfn executable must be executable');
    return resolved;
  }

  async function info() {
    try {
      const stat = await fs.lstat(location);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384, 'Invalid orbital backend configuration');
      const value = JSON.parse(await fs.readFile(location, 'utf8'));
      assert(plain(value) && value.schema === 1, 'Invalid orbital backend configuration');
      return { configured: true, path: await checked(value.path) };
    } catch {}

    const candidates = [
      env?.SCIYUE_MULTIWFN,
      env?.Multiwfnpath,
      ...(Array.isArray(defaultCandidates)
        ? defaultCandidates
        : platform === 'darwin'
          ? DARWIN_DEFAULT_CANDIDATES
          : []),
    ];
    for (const candidate of candidates) {
      if (!string(candidate, 4096)) continue;
      try {
        return { configured: true, path: await checked(candidate) };
      } catch {}
    }
    return { configured: false, message: '请选择本机 Multiwfn 程序或所在文件夹，用于轨道与数值分析。' };
  }

  async function select(executable) {
    const selected = await checked(executable);
    const temporary = location + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ schema: 1, path: selected }) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
    try {
      await fs.rename(temporary, location);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
    return { configured: true, path: selected };
  }

  return { info, select };
}

module.exports = { createOrbitalBackendStore, DARWIN_DEFAULT_CANDIDATES };
