'use strict';
const fsDefault = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assert, plain, string } = require('./security.cjs');
const { configurationError, programPathError, writeConfiguration } = require('./backend-configuration.cjs');

const DARWIN_DEFAULT_CANDIDATES = Object.freeze([
  '/opt/homebrew/opt/multiwfn/bin/multiwfn',
  '/opt/homebrew/bin/multiwfn',
  '/usr/local/opt/multiwfn/bin/multiwfn',
  '/usr/local/bin/multiwfn',
]);

const LINUX_DEFAULT_CANDIDATES = Object.freeze([
  '/usr/local/bin/Multiwfn',
  '/usr/local/bin/multiwfn',
  '/opt/Multiwfn/Multiwfn',
  '/opt/multiwfn/multiwfn',
  '/usr/bin/Multiwfn',
  '/usr/bin/multiwfn',
]);

const POSIX_DIRECTORY_CANDIDATES = Object.freeze([
  'Multiwfn',
  'multiwfn',
  path.posix.join('bin', 'Multiwfn'),
  path.posix.join('bin', 'multiwfn'),
]);

function isValidPosixExecutable(candidatePath, stat) {
  return Boolean(
    stat?.isFile() &&
      !stat.isSymbolicLink() &&
      /^Multiwfn(?:\.exe)?$/i.test(path.basename(candidatePath)) &&
      (Number(stat.mode) & 0o111) !== 0,
  );
}

function diagnostic(error, type, target) {
  return [`阶段：${type}`, target && `路径长度：${target.length}`, error.code && `系统码：${error.code}`, error.message].filter(Boolean).join('\n');
}

function resolvePlatformPath(value, platform) {
  return platform === 'win32' ? path.win32.resolve(value) : path.resolve(value);
}

async function directoryIdentity(directory, io = fsDefault, platform = process.platform) {
  const pathImpl = platform === 'win32' ? path.win32 : path;
  assert(
    string(directory, 4096) && (pathImpl.isAbsolute(directory) || path.isAbsolute(directory)) && !/^[/\\]{2}/.test(directory),
    'Select an absolute local directory',
  );
  const stat = await io.lstat(directory, { bigint: true });
  const real = await io.realpath(directory);
  const normalize = value => platform === 'win32' ? resolvePlatformPath(value, platform).toLowerCase() : resolvePlatformPath(value, platform);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && normalize(real) === normalize(directory), 'Select a regular directory without linked ancestors');
  return { path: real, device: String(stat.dev ?? 0), file: String(stat.ino ?? 0) };
}

function sameDirectory(a, b) {
  return a.path === b.path && a.device === b.device && a.file === b.file;
}

function requireBackend(info, domain) {
  if (info.configured && string(info.path, 4096) && !info.workDirectoryError) return info;
  const suffix = info.workDirectoryError ? 'WORK_DIRECTORY_UNAVAILABLE' :
    info.status === 'configuration-invalid' ? 'BACKEND_CONFIGURATION_INVALID' :
    info.status === 'program-unavailable' ? 'BACKEND_PROGRAM_UNAVAILABLE' : 'BACKEND_MISSING';
  throw new Error(`${domain}_${suffix}: ${info.workDirectoryError ?? info.details ?? info.message ?? '请选择本机 Multiwfn'}`);
}

function backendKey(info) {
  return JSON.stringify([info.path, info.programIdentity, info.workDirectoryIdentity]);
}

function requireSameBackend(info, opened, domain) {
  requireBackend(info, domain);
  assert(backendKey(info) === backendKey(opened), `${domain}_BACKEND_CHANGED: Multiwfn 程序或临时目录已变化，请重新打开此分析来源；已有结果保留。`);
}

async function createRunDirectory(backend, jobRoot, prefix, io = fsDefault, platform = process.platform) {
  const expected = backend?.workDirectoryIdentity;
  try {
    if (!expected) {
      await io.mkdir(jobRoot, { recursive: true });
      return { root: jobRoot, directory: await io.mkdtemp(path.join(jobRoot, prefix)) };
    }
    assert(sameDirectory(await directoryIdentity(expected.path, io, platform), expected), 'Selected work directory identity changed');
    if (typeof io.statfs === 'function') {
      const space = await io.statfs(expected.path, { bigint: true });
      assert(BigInt(space.bavail ?? 0) > 0n && BigInt(space.bsize ?? 0) > 0n, 'The selected work directory has no available capacity');
    }
    const directory = await io.mkdtemp(path.join(expected.path, backend.workPrefix + prefix));
    const identity = await directoryIdentity(directory, io, platform);
    assert(sameDirectory(await directoryIdentity(expected.path, io, platform), expected), 'Selected work directory identity changed');
    return { root: expected.path, directory, identity };
  } catch (error) {
    const code = error.code === 'ENAMETOOLONG' ? 'MULTIWFN_WORK_PATH_LONG' : 'MULTIWFN_WORK_DIRECTORY_UNAVAILABLE';
    throw new Error(code + ': ' + diagnostic(error, '临时运行目录', expected?.path ?? jobRoot), { cause: error });
  }
}

async function verifyRunDirectory(run, io = fsDefault, platform = process.platform) {
  if (!run?.identity) return;
  try {
    assert(sameDirectory(await directoryIdentity(run.directory, io, platform), run.identity), 'Owned run directory identity changed');
  } catch (error) {
    throw new Error('MULTIWFN_WORK_DIRECTORY_UNAVAILABLE: ' + diagnostic(error, '核对临时运行目录', run.directory), { cause: error });
  }
}

function buildProgramIdentity(stat) {
  const mtimeNs = stat.mtimeNs ?? BigInt(Math.trunc((stat.mtimeMs ?? 0) * 1e6));
  return [stat.dev ?? 0, stat.ino ?? 0, stat.size ?? 0, mtimeNs].map(String);
}

/** A user-selected or host-installed local executable is the only external capability. */
function createOrbitalBackendStore(root, options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    defaultCandidates,
    fs = fsDefault,
  } = options;
  const pathImpl = platform === 'win32' ? path.win32 : path;
  const location = path.join(root, 'orbital-backend.json');
  const workPrefix = 'es-' + createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 8) + '-';

  async function checked(executable) {
    assert(
      string(executable, 4096) && (pathImpl.isAbsolute(executable) || path.isAbsolute(executable)) && !/^[/\\]{2}/.test(executable),
      'Select a local Multiwfn executable',
    );
    try {
      if (platform === 'win32') {
        const selected = await fs.lstat(executable, { bigint: true }).catch(error => {
          if (!/^Multiwfn(?:\.exe)?$/i.test(pathImpl.basename(executable))) {
            throw new Error('Select a local Multiwfn executable or directory', { cause: error });
          }
          throw error;
        });
        if (selected.isDirectory() && !selected.isSymbolicLink()) {
          executable = pathImpl.join(executable, 'Multiwfn.exe');
        }
        assert(
          /^Multiwfn(?:\.exe)?$/i.test(pathImpl.basename(executable)),
          'Select a local Multiwfn executable',
        );
        const stat = await fs.lstat(executable, { bigint: true });
        assert(stat.isFile() && !stat.isSymbolicLink(), 'Multiwfn executable must be a regular file');
        return {
          path: await fs.realpath(executable),
          programIdentity: buildProgramIdentity(stat),
        };
      }

      let resolved = await fs.realpath(executable);
      let stat = await fs.lstat(resolved, { bigint: true });
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        for (const relative of POSIX_DIRECTORY_CANDIDATES) {
          const candidate = await fs.realpath(path.join(resolved, relative)).catch(() => null);
          if (!candidate) continue;
          const candidateStat = await fs.lstat(candidate, { bigint: true }).catch(() => null);
          if (isValidPosixExecutable(candidate, candidateStat)) {
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
      assert((Number(stat.mode) & 0o111) !== 0, 'Multiwfn executable must be executable');
      return {
        path: resolved,
        programIdentity: buildProgramIdentity(stat),
      };
    } catch (error) { throw await programPathError('MULTIWFN', 'Multiwfn', executable, error); }
  }

  async function read() {
    let stat;
    try { stat = await fs.lstat(location); }
    catch (error) { if (error.code === 'ENOENT') return { schema: 1 }; throw error; }
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384, 'Invalid orbital backend configuration');
    const value = JSON.parse(await fs.readFile(location, 'utf8'));
    assert(plain(value) && value.schema === 1 &&
      (value.path === undefined || string(value.path, 4096)) &&
      (value.workDirectory === undefined || plain(value.workDirectory) && string(value.workDirectory.path, 4096) &&
        typeof value.workDirectory.device === 'string' && typeof value.workDirectory.file === 'string'), 'Invalid orbital backend configuration');
    return value;
  }

  async function info() {
    let value;
    let configError = null;
    try {
      value = await read();
    } catch (error) {
      configError = error;
      value = {};
    }

    const result = { configured: false, status: 'unconfigured', workPrefix };
    if (value.path) {
      try {
        Object.assign(result, await checked(value.path), { configured: true, status: 'ready' });
      } catch (error) {
        Object.assign(result, {
          path: value.path,
          status: 'program-unavailable',
          details: diagnostic(error, '定位程序', value.path),
        });
      }
    }

    if (!result.configured && platform !== 'win32') {
      const candidates = [
        env?.SCIYUE_MULTIWFN,
        env?.Multiwfnpath,
        ...(Array.isArray(defaultCandidates)
          ? defaultCandidates
          : platform === 'darwin'
            ? DARWIN_DEFAULT_CANDIDATES
            : platform === 'linux'
              ? LINUX_DEFAULT_CANDIDATES
              : []),
      ];
      for (const candidate of candidates) {
        if (!string(candidate, 4096)) continue;
        try {
          Object.assign(result, await checked(candidate), { configured: true, status: 'ready' });
          delete result.details;
          delete result.message;
          break;
        } catch {}
      }
    }

    if (!result.configured && configError) {
      return { configured: false, status: 'configuration-invalid', details: diagnostic(configError, '读取配置', location) };
    }

    if (value.workDirectory) {
      result.workDirectory = value.workDirectory.path;
      try {
        const identity = await directoryIdentity(result.workDirectory, fs, platform);
        assert(sameDirectory(identity, value.workDirectory), 'Selected work directory identity changed');
        result.workDirectoryIdentity = identity;
      } catch (error) {
        result.workDirectoryError = diagnostic(error, '定位临时运行目录', result.workDirectory);
        if (result.configured) {
          result.status = 'work-directory-unavailable';
          result.details = result.workDirectoryError;
        }
      }
    }

    if (!result.configured) {
      result.message = '请选择本机 Multiwfn 程序或所在文件夹，用于轨道与数值分析。';
    }
    return result;
  }

  let writing = Promise.resolve();
  function update(fields) {
    const task = writing.then(async () => {
      const value = await read().catch(error => {
        throw configurationError('MULTIWFN_CONFIGURATION_READ_FAILED', '无法读取已有 Multiwfn 配置，已保留原文件。', location, error);
      });
      try {
        await fs.mkdir(root, { recursive: true });
        await writeConfiguration(location, { ...value, ...fields });
      } catch (error) {
        throw configurationError('MULTIWFN_CONFIGURATION_WRITE_FAILED', '无法保存 Multiwfn 配置，已保留原文件。', location, error);
      }
      return info();
    });
    writing = task.catch(() => {});
    return task;
  }

  async function select(executable) {
    const selected = await checked(executable);
    return update({ path: selected.path });
  }

  async function selectWorkDirectory(directory) {
    if (directory === null) return update({ workDirectory: undefined });
    let identity;
    try {
      identity = await directoryIdentity(directory, fs, platform);
      const probe = await createRunDirectory({ workDirectoryIdentity: identity, workPrefix }, root, 'probe-', fs, platform);
      await verifyRunDirectory(probe, fs, platform);
      await fs.rmdir(probe.directory);
    } catch (error) {
      throw configurationError('MULTIWFN_WORK_DIRECTORY_UNAVAILABLE', '无法使用所选 Multiwfn 临时运行目录。', directory, error);
    }
    return update({ workDirectory: identity });
  }

  return { info, select, selectWorkDirectory };
}

module.exports = {
  createOrbitalBackendStore,
  requireBackend,
  backendKey,
  requireSameBackend,
  createRunDirectory,
  verifyRunDirectory,
  DARWIN_DEFAULT_CANDIDATES,
  LINUX_DEFAULT_CANDIDATES,
};
