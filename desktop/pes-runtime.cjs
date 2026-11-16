'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requiresResidentLibrary } = require('./pes-security.cjs');
const defaultLockPath = path.join(__dirname, 'packaging', 'pes-runtime.lock.json');
const defaultLock = require(defaultLockPath);
const SUPPORTED_POSIX_PES_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64']);

function loadPesLock(platformId) {
  if (platformId === 'win32-x64') {
    return { lockPath: defaultLockPath, lock: JSON.parse(fs.readFileSync(defaultLockPath, 'utf8')) };
  }
  if (!SUPPORTED_POSIX_PES_PLATFORMS.has(platformId)) {
    throw new Error(`The bundled PES runtime is not supported on ${platformId}`);
  }
  const lockPath = path.join(__dirname, 'packaging', `pes-runtime.${platformId}.lock.json`);
  if (!fs.existsSync(lockPath)) {
    throw new Error(`PES_RUNTIME_NOT_STAGED: 当前平台（${platformId}）尚未安装内置 PES 势能面探索原生运行时（xtb 6.8.0 + libxtb），将在下一阶段提供。`);
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.platform && lock.platform !== platformId) {
    throw new Error(`PES runtime lock platform mismatch: expected ${platformId}`);
  }
  return { lockPath, lock };
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ownedMember(root, relative) {
  const displacement = typeof relative === 'string' ? path.relative(root, path.resolve(root, relative)) : '..';
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || path.isAbsolute(displacement) || displacement.split(path.sep).includes('..')) {
    throw new Error('PES runtime member escaped its declared location');
  }
  const member = path.join(root, relative);
  const identity = fs.lstatSync(member);
  const actual = fs.realpathSync.native(member);
  if (!identity.isFile() || path.relative(member, actual) !== '') {
    throw new Error('PES runtime member escaped its declared location');
  }
  return member;
}

function resolveResidentLibrary(root, declaration = defaultLock.residentLibrary, expectedPlatform = 'win32-x64') {
  const displacement = typeof declaration?.subdirectory === 'string'
    ? path.relative(root, path.resolve(root, declaration.subdirectory)) : '..';
  if (!declaration || typeof declaration.subdirectory !== 'string' || !declaration.subdirectory
    || path.isAbsolute(declaration.subdirectory)
    || path.isAbsolute(displacement) || displacement.split(path.sep).includes('..')) {
    throw new Error('The resident PES library is not declared in this runtime lock');
  }
  const libraryRoot = path.resolve(root, declaration.subdirectory);
  const manifestPath = ownedMember(libraryRoot, declaration.manifestPath);
  if (!/^[a-f0-9]{64}$/.test(declaration.manifestSha256 ?? '') || digest(manifestPath) !== declaration.manifestSha256) {
    throw new Error('PES resident library manifest identity changed');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== declaration.schema || manifest.platform !== expectedPlatform
    || !Array.isArray(manifest.files)) throw new Error('PES resident library manifest is invalid');
  // The packager verifies the full dependency closure. At launch, bind the
  // locked manifest, actual library and the two method parameter files only.
  for (const relative of [manifest.libraryRelativePath, manifest.parameters?.gfn1, manifest.parameters?.gfn2]) {
    const entry = manifest.files.find(row => row.path === relative);
    const member = ownedMember(libraryRoot, relative);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || fs.statSync(member).size !== entry.bytes
      || digest(member) !== entry.sha256) throw new Error('PES resident library or parameter identity changed');
  }
  return { libxtbRoot: libraryRoot, libxtbManifestSha256: declaration.manifestSha256 };
}

function resolvePesRuntime({ packaged, resourcesPath, appPath, request, platform = process.platform, arch = process.arch }) {
  const platformId = `${platform}-${arch}`;
  const { lockPath, lock } = loadPesLock(platformId);
  const parent = packaged ? resourcesPath : appPath;
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) {
    throw new Error('PES runtime requires an absolute application location');
  }
  const root = path.join(parent, packaged ? lock.subdirectory : lock.developmentRoot);
  try {
    const manifest = JSON.parse(fs.readFileSync(ownedMember(root, 'runtime.json'), 'utf8'));
    if (manifest.schema !== lock.schema || manifest.lockSha256 !== digest(lockPath)) {
      throw new Error('The runtime manifest belongs to another dependency lock');
    }
    const executable = ownedMember(root, lock.entrypoints.python);
    const bootstrap = ownedMember(root, lock.entrypoints.bootstrap);
    const worker = ownedMember(root, lock.entrypoints.worker);
    const entrypointIdentities = [
      ['python', executable, lock.pythonSha256],
      ['bootstrap', bootstrap, lock.bootstrapSha256],
      ['worker', worker, manifest.entrypointSha256?.worker],
    ];
    for (const [name, file, expected] of entrypointIdentities) {
      if (typeof expected !== 'string' || digest(file) !== expected) {
        throw new Error(`PES runtime ${name} identity changed`);
      }
    }
    const resolved = { executable, args: ['-I', '-B', bootstrap, '--pes-worker'], cwd: root };
    if (requiresResidentLibrary(request)) {
      try { Object.assign(resolved, resolveResidentLibrary(root, lock.residentLibrary, platformId)); }
      catch (error) { resolved.libxtbError = error.message; }
    }
    return resolved;
  } catch (error) {
    throw new Error(`The bundled PES runtime is unavailable: ${error.message}`, { cause: error });
  }
}

module.exports = { resolvePesRuntime, resolveResidentLibrary };
