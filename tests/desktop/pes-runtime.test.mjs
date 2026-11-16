import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const require = createRequire(import.meta.url);
const { resolvePesRuntime, resolveResidentLibrary } = require('../../desktop/pes-runtime.cjs');
const { createPesHost } = require('../../desktop/pes-host.cjs');
const { chemistryRuntime } = require('../../desktop/runtime.cjs');
const { currentRuntimeEnvironment } = require('../../desktop/current-runtime.cjs');

const sha256Hex = content => crypto.createHash('sha256').update(content).digest('hex');

function writeTrackedFile(rootDir, relativePath, content) {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  fs.writeFileSync(fullPath, buf);
  return {
    path: relativePath.replace(/\\/g, '/'),
    bytes: buf.length,
    sha256: sha256Hex(buf)
  };
}

function makeRealTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function buildMockResidentLibrary({ platformId, libraryRelativePath, manifestOverrides = {} }) {
  const tmpDir = makeRealTempDir(`es-pes-libxtb-${platformId}-`);
  const libxtbDir = path.join(tmpDir, 'libxtb');
  const libEntry = writeTrackedFile(libxtbDir, libraryRelativePath, `mock-${platformId}-libxtb`);
  const gfn1Entry = writeTrackedFile(libxtbDir, 'data/param_gfn1-xtb.txt', 'gfn1-params\n');
  const gfn2Entry = writeTrackedFile(libxtbDir, 'data/param_gfn2-xtb.txt', 'gfn2-params\n');
  const files = [libEntry, gfn1Entry, gfn2Entry].sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    schema: 'ester-pes-libxtb-runtime/v1',
    platform: platformId,
    version: '6.8.0',
    apiVersion: 20000,
    libraryRelativePath,
    parameterDirectory: 'data',
    parameters: {
      gfn1: 'data/param_gfn1-xtb.txt',
      gfn2: 'data/param_gfn2-xtb.txt'
    },
    identity: {
      schema: 'ester-libxtb-provider-identity/v1',
      provider: 'libxtb',
      version: '6.8.0',
      apiVersion: 20000,
      buildKind: 'official-static-archive-relinked',
      librarySha256: libEntry.sha256,
      filesSha256: sha256Hex(JSON.stringify(files))
    },
    files,
    ...manifestOverrides
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(libxtbDir, 'runtime.json'), manifestBytes);
  const manifestSha256 = sha256Hex(manifestBytes);
  const declaration = {
    subdirectory: 'libxtb',
    manifestPath: 'runtime.json',
    schema: 'ester-pes-libxtb-runtime/v1',
    manifestSha256
  };
  return { tmpDir, libxtbDir, declaration, manifest, manifestSha256, files };
}

function makeMinimalPesRequest(overrides = {}) {
  return {
    schema: 'es-pes/v1',
    id: 'pes-req-1',
    runIdentity: { groupId: 'g1', taskId: 't1', runId: 'r1' },
    sourceDocumentId: 'doc-1',
    operation: 'hessian',
    algorithm: 'numeric',
    method: 'gfn2',
    structure: {
      id: 's1',
      name: 'H2',
      dimension: 3,
      charge: 0,
      multiplicity: 1,
      atoms: [
        { id: 'a1', element: 'H', x: 0, y: 0, z: 0 },
        { id: 'a2', element: 'H', x: 0, y: 0, z: 0.74 }
      ]
    },
    charge: 0,
    uhf: 0,
    constraints: { frozenAtomIds: [], coordinates: [], centroids: [] },
    coordinates: [],
    parameters: {},
    ...overrides
  };
}

function resolveWorkspacePython() {
  try {
    const runtime = chemistryRuntime({ packaged: false, appPath: ROOT, environment: {} });
    const posixSitePackages = path.join(runtime.runtimeRoot, 'python', 'lib', 'python3.12', 'site-packages');
    const winSitePackages = path.join(runtime.runtimeRoot, 'python', 'Lib', 'site-packages');
    const sitePackages = fs.existsSync(posixSitePackages)
      ? posixSitePackages
      : fs.existsSync(winSitePackages)
        ? winSitePackages
        : '';
    return {
      executable: runtime.executable,
      sitePackages,
      env: currentRuntimeEnvironment({
        packaged: false,
        appPath: ROOT,
        executable: runtime.executable,
        environment: {}
      })
    };
  } catch {
    return {
      executable: process.env.PYTHON || 'python3',
      sitePackages: '',
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1'
      }
    };
  }
}

test('resolvePesRuntime rejects unstaged darwin/linux platforms with PES_RUNTIME_NOT_STAGED and rejects unsupported platforms', () => {
  for (const [platform, arch] of [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64']
  ]) {
    const expectedId = `${platform}-${arch}`;
    assert.throws(
      () => resolvePesRuntime({ packaged: false, appPath: ROOT, platform, arch }),
      error =>
        error?.message.includes('PES_RUNTIME_NOT_STAGED') &&
        error?.message.includes(expectedId)
    );
  }

  const tmpPackaged = makeRealTempDir('es-pes-packaged-');
  try {
    assert.throws(
      () =>
        resolvePesRuntime({
          packaged: true,
          resourcesPath: tmpPackaged,
          appPath: ROOT,
          platform: 'darwin',
          arch: 'arm64'
        }),
      error =>
        error?.message.includes('PES_RUNTIME_NOT_STAGED') &&
        error?.message.includes('darwin-arm64')
    );
  } finally {
    fs.rmSync(tmpPackaged, { recursive: true, force: true });
  }

  assert.throws(
    () => resolvePesRuntime({ packaged: false, appPath: ROOT, platform: 'freebsd', arch: 'x64' }),
    /The bundled PES runtime is not supported on freebsd-x64/
  );
});

test('resolveResidentLibrary supports POSIX/Windows layouts and rejects platform mismatch, tamper, and symlinks', () => {
  const cases = [
    { platformId: 'darwin-arm64', libraryRelativePath: 'lib/libxtb.dylib' },
    { platformId: 'linux-x64', libraryRelativePath: 'lib/libxtb.so' },
    { platformId: 'win32-x64', libraryRelativePath: 'bin/libxtb.dll' }
  ];

  for (const { platformId, libraryRelativePath } of cases) {
    const fixture = buildMockResidentLibrary({ platformId, libraryRelativePath });
    try {
      const resolved = resolveResidentLibrary(fixture.tmpDir, fixture.declaration, platformId);
      assert.equal(resolved.libxtbRoot, fixture.libxtbDir);
      assert.equal(resolved.libxtbManifestSha256, fixture.manifestSha256);
    } finally {
      fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
    }
  }

  const darwinFixture = buildMockResidentLibrary({
    platformId: 'darwin-arm64',
    libraryRelativePath: 'lib/libxtb.dylib'
  });
  try {
    assert.throws(
      () => resolveResidentLibrary(darwinFixture.tmpDir, darwinFixture.declaration, 'win32-x64'),
      /PES resident library manifest is invalid/
    );

    assert.throws(
      () =>
        resolveResidentLibrary(
          darwinFixture.tmpDir,
          { ...darwinFixture.declaration, manifestSha256: '0'.repeat(64) },
          'darwin-arm64'
        ),
      /PES resident library manifest identity changed/
    );

    fs.writeFileSync(
      path.join(darwinFixture.libxtbDir, 'lib/libxtb.dylib'),
      'tampered-libxtb-binary-content'
    );
    assert.throws(
      () => resolveResidentLibrary(darwinFixture.tmpDir, darwinFixture.declaration, 'darwin-arm64'),
      /PES resident library or parameter identity changed/
    );
  } finally {
    fs.rmSync(darwinFixture.tmpDir, { recursive: true, force: true });
  }

  const symlinkFixture = buildMockResidentLibrary({
    platformId: 'darwin-arm64',
    libraryRelativePath: 'lib/libxtb.dylib'
  });
  try {
    const libPath = path.join(symlinkFixture.libxtbDir, 'lib/libxtb.dylib');
    const externalTarget = path.join(symlinkFixture.tmpDir, 'external.dylib');
    fs.renameSync(libPath, externalTarget);
    fs.symlinkSync(externalTarget, libPath);
    assert.throws(
      () => resolveResidentLibrary(symlinkFixture.tmpDir, symlinkFixture.declaration, 'darwin-arm64'),
      /PES runtime member escaped its declared location/
    );
  } finally {
    fs.rmSync(symlinkFixture.tmpDir, { recursive: true, force: true });
  }
});

test('createPesHost releases lease and resets activeCount on pre-spawn failure, and scrubs POSIX env + sets dynamic loader paths', { timeout: 15000 }, async () => {
  const baseDir = makeRealTempDir('es-pes-host-');
  const jobRoot = path.join(baseDir, 'jobs');
  const resultRoot = path.join(baseDir, 'records');
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.mkdirSync(resultRoot, { recursive: true });

  const runtimeRoot = path.join(baseDir, 'runtime');
  const pythonBinDir = path.join(runtimeRoot, 'python', 'bin');
  const libxtbRoot = path.join(runtimeRoot, 'libxtb');
  fs.mkdirSync(pythonBinDir, { recursive: true });
  fs.mkdirSync(path.join(libxtbRoot, 'lib'), { recursive: true });
  const fakePython = path.join(pythonBinDir, 'python3');
  fs.writeFileSync(fakePython, '#!/bin/sh\nexit 0\n');

  const events = [];
  let releaseCount = 0;
  let spawnCalls = [];

  try {
    // 1. Pre-spawn failure cleans up active session and releases admission lease
    const failingHost = createPesHost({
      spawn() {
        throw new Error('spawn must not execute when resolveRuntime fails');
      },
      async resolveRuntime() {
        throw new Error('PES_RUNTIME_NOT_STAGED: mock unstaged runtime');
      },
      async resolveXtbRuntime() {
        throw new Error('unused');
      },
      jobRoot,
      resultRoot,
      resolveResources: async () => ({ threads: 2, memoryBudgetBytes: 1024 * 1024 * 1024 }),
      admit: () =>
        Object.assign(
          () => {
            releaseCount += 1;
          },
          { resources: { threads: 2, memoryBudgetBytes: 1024 * 1024 * 1024 } }
        ),
      sendToWindow: (_owner, packet) => events.push(packet),
      fs: fsPromises
    });

    await failingHost.start(1, makeMinimalPesRequest());
    await failingHost.settle();
    assert.equal(releaseCount, 1);
    assert.equal(failingHost.activeCount(), 0);
    assert.ok(
      events.some(
        packet =>
          packet.event === 'terminal' &&
          packet.workerSettled === true &&
          packet.error?.message === '无法启动 PES 计算。' &&
          packet.error?.detail?.includes('PES_RUNTIME_NOT_STAGED')
      )
    );
    events.length = 0;

    // 2. Successful pre-spawn hands scrubbed POSIX env and loader path to spawn()
    releaseCount = 0;
    const savedEnv = {
      CONDA_PREFIX: process.env.CONDA_PREFIX,
      PYTHONPATH: process.env.PYTHONPATH,
      PYTHONHOME: process.env.PYTHONHOME,
      VIRTUAL_ENV: process.env.VIRTUAL_ENV,
      DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH,
      DYLD_INSERT_LIBRARIES: process.env.DYLD_INSERT_LIBRARIES,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
      RDBASE: process.env.RDBASE
    };
    process.env.CONDA_PREFIX = '/bad/conda';
    process.env.PYTHONPATH = '/bad/pythonpath';
    process.env.PYTHONHOME = '/bad/pythonhome';
    process.env.VIRTUAL_ENV = '/bad/venv';
    process.env.DYLD_LIBRARY_PATH = '/bad/dyld';
    process.env.DYLD_INSERT_LIBRARIES = '/bad/inject.dylib';
    process.env.LD_LIBRARY_PATH = '/bad/ld';
    process.env.RDBASE = '/bad/rdbase';

    try {
      const host = createPesHost({
        spawn(executable, args, options) {
          spawnCalls.push({ executable, args, options });
          const child = new EventEmitter();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.kill = () => {};
          setImmediate(() => {
            child.stdout.end();
            child.stderr.end();
            child.emit('close', 1, null);
          });
          return child;
        },
        async resolveRuntime() {
          return {
            executable: fakePython,
            args: [path.join(runtimeRoot, 'bootstrap.py'), '--pes-worker'],
            cwd: runtimeRoot,
            libxtbRoot,
            libxtbManifestSha256: 'a'.repeat(64)
          };
        },
        async resolveXtbRuntime() {
          return {
            executable: path.join(runtimeRoot, 'xtb', 'bin', 'xtb'),
            directory: path.join(runtimeRoot, 'xtb'),
            dataDirectory: path.join(runtimeRoot, 'xtb', 'share', 'xtb')
          };
        },
        jobRoot,
        resultRoot,
        resolveResources: async () => ({ threads: 2, memoryBudgetBytes: 1024 * 1024 * 1024 }),
        admit: () =>
          Object.assign(
            () => {
              releaseCount += 1;
            },
            { resources: { threads: 2, memoryBudgetBytes: 1024 * 1024 * 1024 } }
          ),
        sendToWindow: (_owner, packet) => events.push(packet),
        fs: fsPromises
      });

      const request = makeMinimalPesRequest({
        operation: 'scan',
        algorithm: 'sella-scan',
        method: 'gfn2',
        coordinates: [],
        parameters: { executionProfile: 'pes-v222' }
      });
      await host.start(2, request);
      await host.settle();

      assert.equal(spawnCalls.length, 1);
      const { executable, options } = spawnCalls[0];
      assert.equal(executable, fakePython);
      assert.ok(options.env && typeof options.env === 'object');
      if (process.platform === 'win32') {
        assert.ok(options.env.PATH.startsWith(path.join(pythonBinDir, 'Library', 'bin')));
      } else {
        assert.ok(options.env.PATH.startsWith(pythonBinDir));
        assert.equal(options.env.CONDA_PREFIX, undefined);
        assert.equal(options.env.PYTHONPATH, undefined);
        assert.equal(options.env.PYTHONHOME, undefined);
        assert.equal(options.env.VIRTUAL_ENV, undefined);
        assert.equal(options.env.DYLD_LIBRARY_PATH, undefined);
        assert.equal(options.env.DYLD_INSERT_LIBRARIES, undefined);
        assert.equal(options.env.RDBASE, undefined);
      }
      assert.equal(options.env.PYTHONUTF8, '1');
      assert.equal(options.env.PYTHONDONTWRITEBYTECODE, '1');
      if (process.platform === 'darwin') {
        assert.equal(options.env.LD_LIBRARY_PATH, undefined);
        assert.ok(options.env.DYLD_FALLBACK_LIBRARY_PATH.includes(path.join(runtimeRoot, 'python', 'lib')));
      } else if (process.platform === 'linux') {
        assert.ok(options.env.LD_LIBRARY_PATH.includes(path.join(runtimeRoot, 'python', 'lib')));
      }
      assert.equal(releaseCount, 1);
      assert.equal(host.activeCount(), 0);
      assert.ok(events.some(packet => packet.event === 'started'));
      assert.ok(events.some(packet => packet.event === 'terminal' && packet.workerSettled === true));
    } finally {
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('pes_libxtb LibXtbApi enforces PES_LIBXTB_RUNTIME integrity and POSIX .dylib/.so loaded-module identity', () => {
  const py = resolveWorkspacePython();
  const fixture = buildMockResidentLibrary({
    platformId: 'darwin-arm64',
    libraryRelativePath: 'lib/libxtb.dylib'
  });
  try {
    const chemistryDir = path.join(ROOT, 'desktop', 'chemistry');
    const pythonScript = `
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
if sys.argv[4]:
    sys.path.insert(0, sys.argv[4])
import pes_libxtb
from pes_core import PesError

empty_root = Path(sys.argv[2])
lib_root = Path(sys.argv[3])

# 1. Relative root & invalid schema fail with PES_LIBXTB_RUNTIME; missing runtime.json raises FileNotFoundError
try:
    pes_libxtb.LibXtbApi('relative/libxtb', 1)
    raise AssertionError('Expected relative root to fail')
except PesError as exc:
    assert exc.code == 'PES_LIBXTB_RUNTIME', exc

try:
    pes_libxtb.LibXtbApi(str(empty_root), 1)
    raise AssertionError('Expected missing runtime.json to fail')
except FileNotFoundError:
    pass

bad_schema_root = empty_root / 'bad_schema'
bad_schema_root.mkdir()
(bad_schema_root / 'runtime.json').write_text(json.dumps({'schema': 'wrong/v0'}), encoding='utf-8')
try:
    pes_libxtb.LibXtbApi(str(bad_schema_root), 1)
    raise AssertionError('Expected invalid schema runtime.json to fail')
except PesError as exc:
    assert exc.code == 'PES_LIBXTB_RUNTIME', exc

# 2. Tampered manifest digest fails with PES_LIBXTB_RUNTIME before CDLL
try:
    pes_libxtb.LibXtbApi(str(lib_root), 1, '0' * 64)
    raise AssertionError('Expected wrong manifest digest to fail')
except PesError as exc:
    assert exc.code == 'PES_LIBXTB_RUNTIME', exc

# 3. Tampered member file fails before CDLL even when manifest sha matches
tamper_root = empty_root / 'tampered'
(tamper_root / 'lib').mkdir(parents=True)
(tamper_root / 'data').mkdir(parents=True)
dylib = tamper_root / 'lib' / 'libxtb.dylib'
gfn1 = tamper_root / 'data' / 'param_gfn1-xtb.txt'
gfn2 = tamper_root / 'data' / 'param_gfn2-xtb.txt'
dylib.write_bytes(b'original-dylib')
gfn1.write_text('g1', encoding='utf-8')
gfn2.write_text('g2', encoding='utf-8')
manifest = {
    'schema': 'ester-pes-libxtb-runtime/v1',
    'platform': 'darwin-arm64',
    'version': '6.8.0',
    'apiVersion': 20000,
    'libraryRelativePath': 'lib/libxtb.dylib',
    'parameters': {
        'gfn1': 'data/param_gfn1-xtb.txt',
        'gfn2': 'data/param_gfn2-xtb.txt',
    },
    'files': [
        {'path': 'lib/libxtb.dylib', 'bytes': dylib.stat().st_size, 'sha256': hashlib.sha256(dylib.read_bytes()).hexdigest()},
        {'path': 'data/param_gfn1-xtb.txt', 'bytes': gfn1.stat().st_size, 'sha256': hashlib.sha256(gfn1.read_bytes()).hexdigest()},
        {'path': 'data/param_gfn2-xtb.txt', 'bytes': gfn2.stat().st_size, 'sha256': hashlib.sha256(gfn2.read_bytes()).hexdigest()},
    ],
}
manifest_bytes = json.dumps(manifest).encode('utf-8')
(tamper_root / 'runtime.json').write_bytes(manifest_bytes)
dylib.write_bytes(b'modified-dylib')
try:
    pes_libxtb.LibXtbApi(str(tamper_root), 1, hashlib.sha256(manifest_bytes).hexdigest())
    raise AssertionError('Expected tampered library member to fail')
except PesError as exc:
    assert exc.code == 'PES_LIBXTB_RUNTIME', exc
    assert 'libxtb runtime member identity changed' in str(exc), exc

# 4. Direct POSIX _loaded_modules verification for .dylib and .so.1 + mismatch rejection
posix_dir = empty_root / 'posix_mods'
(posix_dir / 'lib').mkdir(parents=True)
mod_dylib = posix_dir / 'lib' / 'libxtb.dylib'
mod_so = posix_dir / 'lib' / 'libopenblas.so.1'
mod_dylib.write_bytes(b'fake-dylib-bytes')
mod_so.write_bytes(b'fake-so-bytes')

real_os_name = pes_libxtb.os.name
try:
    pes_libxtb.os.name = 'posix'
    api = object.__new__(pes_libxtb.LibXtbApi)
    api.root = posix_dir
    api.library_relative = 'lib/libxtb.dylib'
    api.library_file = mod_dylib
    api.members = {
        'lib/libxtb.dylib': {'path': 'lib/libxtb.dylib', 'bytes': mod_dylib.stat().st_size, 'sha256': hashlib.sha256(mod_dylib.read_bytes()).hexdigest()},
        'lib/libopenblas.so.1': {'path': 'lib/libopenblas.so.1', 'bytes': mod_so.stat().st_size, 'sha256': hashlib.sha256(mod_so.read_bytes()).hexdigest()},
    }

    loaded = api._loaded_modules()
    assert loaded['libxtb.dylib'] == str(mod_dylib.resolve()), loaded
    assert loaded['libopenblas.so.1'] == str(mod_so.resolve()), loaded

    # Hash mismatch
    api.members['lib/libopenblas.so.1']['sha256'] = 'f' * 64
    try:
        api._loaded_modules()
        raise AssertionError('Expected loaded dependency hash mismatch')
    except PesError as exc:
        assert 'Loaded libxtb dependency identity mismatch' in str(exc), exc

    # Missing library_file.name (restore so entry first)
    api.members['lib/libopenblas.so.1']['sha256'] = hashlib.sha256(mod_so.read_bytes()).hexdigest()
    api.library_file = posix_dir / 'lib' / 'absent.dylib'
    try:
        api._loaded_modules()
        raise AssertionError('Expected missing library_file failure')
    except PesError as exc:
        assert 'Loaded libxtb module was not identified' in str(exc), exc
finally:
    pes_libxtb.os.name = real_os_name

# 5. POSIX loader-path guards on NativeGfnEvaluator._environment & conformer_native_md.apply_posix_library_env
import pes_core
import conformer_native_md

real_pes_os = pes_core.os.name
real_pes_plat = pes_core.sys.platform
real_md_os = conformer_native_md.os.name
real_md_plat = conformer_native_md.sys.platform
try:
    pes_core.os.name = conformer_native_md.os.name = 'posix'
    work_dir = empty_root / 'eval_work'
    work_dir.mkdir(parents=True)

    # 5a. Static runtime without lib/ omits <root>/lib
    static_root = empty_root / 'xtb_static'
    static_bin = static_root / 'bin'
    static_share = static_root / 'share' / 'xtb'
    static_bin.mkdir(parents=True)
    static_share.mkdir(parents=True)
    rt_static = {'root': str(static_root), 'directory': str(static_bin), 'dataDirectory': str(static_share)}

    ev = object.__new__(pes_core.NativeGfnEvaluator)
    ev.request = {'threads': 2}
    ev.runtime = rt_static

    for plat, key, expected in [
        ('darwin', 'DYLD_FALLBACK_LIBRARY_PATH', f'{static_bin}{pes_core.os.pathsep}/usr/lib'),
        ('linux', 'LD_LIBRARY_PATH', str(static_bin)),
    ]:
        pes_core.sys.platform = conformer_native_md.sys.platform = plat
        e1 = ev._environment(work_dir)
        assert e1[key] == expected, (plat, e1)
        e2 = {}
        conformer_native_md.apply_posix_library_env(e2, rt_static)
        assert e2[key] == expected, (plat, e2)

    # 5b. Real lib/ directory is prepended
    dyn_root = empty_root / 'xtb_dyn'
    dyn_bin = dyn_root / 'bin'
    dyn_lib = dyn_root / 'lib'
    dyn_share = dyn_root / 'share' / 'xtb'
    dyn_bin.mkdir(parents=True)
    dyn_lib.mkdir(parents=True)
    dyn_share.mkdir(parents=True)
    rt_dyn = {'root': str(dyn_root), 'directory': str(dyn_bin), 'dataDirectory': str(dyn_share)}
    ev.runtime = rt_dyn
    for plat, key, expected in [
        ('darwin', 'DYLD_FALLBACK_LIBRARY_PATH', f'{dyn_lib}{pes_core.os.pathsep}{dyn_bin}{pes_core.os.pathsep}/usr/lib'),
        ('linux', 'LD_LIBRARY_PATH', f'{dyn_lib}{pes_core.os.pathsep}{dyn_bin}'),
    ]:
        pes_core.sys.platform = conformer_native_md.sys.platform = plat
        e1 = ev._environment(work_dir)
        assert e1[key] == expected, (plat, e1)
        e2 = {}
        conformer_native_md.apply_posix_library_env(e2, rt_dyn)
        assert e2[key] == expected, (plat, e2)

    # 5c. Non-directory or symlinked lib/ fails closed with PesError / NativeMDError
    bad_file_root = empty_root / 'xtb_bad_file'
    (bad_file_root / 'bin').mkdir(parents=True)
    (bad_file_root / 'lib').write_text('not-a-dir', encoding='utf-8')
    ev.runtime = {'root': str(bad_file_root), 'directory': str(bad_file_root / 'bin'), 'dataDirectory': str(static_share)}
    for fn, exc_cls in [(lambda: ev._environment(work_dir), PesError), (lambda: conformer_native_md.apply_posix_library_env({}, ev.runtime), conformer_native_md.NativeMDError)]:
        try:
            fn()
            raise AssertionError('Expected regular-file lib/ rejection')
        except exc_cls:
            pass

    if hasattr(os, 'symlink'):
        sym_root = empty_root / 'xtb_sym_lib'
        (sym_root / 'bin').mkdir(parents=True)
        os.symlink(str(dyn_lib), str(sym_root / 'lib'))
        ev.runtime = {'root': str(sym_root), 'directory': str(sym_root / 'bin'), 'dataDirectory': str(static_share)}
        for fn, exc_cls in [(lambda: ev._environment(work_dir), PesError), (lambda: conformer_native_md.apply_posix_library_env({}, ev.runtime), conformer_native_md.NativeMDError)]:
            try:
                fn()
                raise AssertionError('Expected symlinked lib/ rejection')
            except exc_cls:
                pass
finally:
    pes_core.os.name = real_pes_os
    pes_core.sys.platform = real_pes_plat
    conformer_native_md.os.name = real_md_os
    conformer_native_md.sys.platform = real_md_plat

print('PES_LIBXTB_PY_OK')
`;

    const missingRoot = path.join(fixture.tmpDir, 'missing');
    fs.mkdirSync(missingRoot, { recursive: true });
    const result = spawnSync(
      py.executable,
      ['-B', '-c', pythonScript, chemistryDir, missingRoot, fixture.libxtbDir, py.sitePackages],
      {
        env: py.env,
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, `Python test failed:\nSTDOUT: ${result.stdout}\nSTDERR: ${result.stderr}`);
    assert.ok(result.stdout.includes('PES_LIBXTB_PY_OK'));
  } finally {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  }
});
