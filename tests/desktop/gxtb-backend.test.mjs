import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGxtbBackendStore, verifyGxtbRuntime, DOWNLOAD_URL } = require('../../desktop/gxtb-backend.cjs');
const contract = require('../../desktop/xtb-runtime-contract.cjs');

async function withTempDir(fn) {
  const baseTmp = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(baseTmp, 'ester-gxtb-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createMockGxtbDistribution(root, options = {}) {
  const distDir = path.join(root, 'gxtb-dist');
  const binDir = path.join(distDir, 'bin');
  const libDir = path.join(distDir, 'lib');
  const shareDir = path.join(distDir, 'share', 'xtb');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(libDir, { recursive: true });
  await fs.mkdir(shareDir, { recursive: true });

  const executable = path.join(binDir, 'xtb');
  const execMode = options.execMode ?? 0o755;
  await fs.writeFile(executable, '#!/bin/sh\necho gxtb\n', { mode: execMode });
  await fs.chmod(executable, execMode);

  const dylibPath = path.join(libDir, 'libgfortran.5.dylib');
  const soPath = path.join(libDir, 'libgomp.so.1');
  await fs.writeFile(dylibPath, 'fake-dylib-binary\n', 'utf8');
  await fs.writeFile(soPath, 'fake-so1-binary\n', 'utf8');

  const paramMain = path.join(shareDir, 'param_gxtb.txt');
  const paramHidden = path.join(shareDir, '.gxtb');
  await fs.writeFile(paramMain, 'gxtb-parameters-v1\n', 'utf8');
  await fs.writeFile(paramHidden, 'gxtb-hidden-table\n', 'utf8');

  return { distDir, binDir, libDir, shareDir, executable, dylibPath, soPath, paramMain };
}

function createFakeSpawn(calls, options = {}) {
  return (executable, args, spawnOptions) => {
    calls.push({ executable, args, env: spawnOptions?.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};

    queueMicrotask(() => {
      const flag = args[0];
      if (flag === '--version') {
        child.stdout.emit('data', Buffer.from(options.versionStdout ?? 'xtb version 6.7.1 (30c6303)\ng-xtb version 2.0.1\n'));
      } else if (flag === '--help') {
        child.stdout.emit('data', Buffer.from(options.helpStdout ?? 'Usage: xtb [options]\n  --gxtb    enable g-xTB method\n'));
      }
      child.emit('close', options.exitCode ?? 0, null);
    });
    return child;
  };
}

async function withPlatform(platformValue, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platformValue, configurable: true });
  try {
    return await fn();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  }
}

test('g-xTB backend validates POSIX executable permissions, injects library/XTBPATH env, hashes lib/ & share/xtb, and rejects tampering', { skip: process.platform === 'win32' }, async () => {
  assert.ok(DOWNLOAD_URL.includes('grimme-lab/g-xtb'));

  await withTempDir(async (root) => {
    const storeRoot = path.join(root, 'store');
    await fs.mkdir(storeRoot, { recursive: true });

    // 1. Non-executable bin/xtb (0o644) is rejected on POSIX
    const nonExecDist = await createMockGxtbDistribution(path.join(root, 'nonexec'), { execMode: 0o644 });
    const nonExecStore = createGxtbBackendStore(path.join(storeRoot, 'nonexec'), {
      spawn: createFakeSpawn([]),
    });
    await assert.rejects(() => nonExecStore.select(nonExecDist.executable), /chmod \+x/);

    // 2. Executable bin/xtb (0o755) succeeds and detects --gxtb capability
    const dist = await createMockGxtbDistribution(root, { execMode: 0o755 });
    const spawnCalls = [];
    const store = createGxtbBackendStore(storeRoot, {
      spawn: createFakeSpawn(spawnCalls),
    });

    const initial = await store.info();
    assert.equal(initial.configured, false);
    assert.equal(initial.status, 'unconfigured');

    const selected = await store.select(dist.executable);
    assert.equal(selected.configured, true);
    assert.equal(selected.path, dist.executable);
    assert.equal(selected.status, 'unchecked');

    // Verify DYLD_FALLBACK_LIBRARY_PATH on darwin and XTBPATH during detection
    const detected = await withPlatform('darwin', () => store.detect());
    assert.equal(detected.configured, true);
    assert.equal(detected.status, 'ready');
    assert.equal(detected.capable, true);
    assert.equal(detected.hostVersion, '6.7.1');
    assert.equal(detected.gxtbRelease, '2.0.1');
    assert.equal(spawnCalls.length, 2);
    for (const call of spawnCalls) {
      assert.equal(call.env.XTBPATH, dist.shareDir);
      assert.equal(call.env.DYLD_FALLBACK_LIBRARY_PATH, `${dist.libDir}:${dist.binDir}:/usr/lib`);
      assert.equal(call.env.LD_LIBRARY_PATH, undefined);
    }

    // Verify LD_LIBRARY_PATH on linux during resolution
    const linuxCalls = [];
    const linuxStoreRoot = path.join(storeRoot, 'linux');
    await fs.mkdir(linuxStoreRoot, { recursive: true });
    const linuxStore = await withPlatform('linux', () =>
      createGxtbBackendStore(linuxStoreRoot, {
        spawn: createFakeSpawn(linuxCalls),
      })
    );
    await withPlatform('linux', () => linuxStore.select(dist.executable));
    const runtime = await withPlatform('linux', () => linuxStore.resolve());
    assert.equal(linuxCalls.length, 2);
    for (const call of linuxCalls) {
      assert.equal(call.env.XTBPATH, dist.shareDir);
      assert.equal(call.env.LD_LIBRARY_PATH, `${dist.libDir}:${dist.binDir}`);
      assert.equal(call.env.DYLD_FALLBACK_LIBRARY_PATH, undefined);
    }

    // Verify members (lib/*.dylib and lib/*.so.1 prefixed with lib/) & share/xtb parameters
    contract.assertEngineIdentity(runtime.engineIdentity);
    assert.equal(runtime.engineIdentity.kind, 'external-user-program');
    assert.equal(runtime.engineIdentity.runtimeVariant, 'gxtb');
    const memberPaths = runtime.engineIdentity.members.map(row => row.path).sort();
    assert.deepEqual(memberPaths, ['lib/libgfortran.5.dylib', 'lib/libgomp.so.1', 'xtb']);
    const paramPaths = runtime.engineIdentity.parameters.map(row => row.path).sort();
    assert.deepEqual(paramPaths, ['.gxtb', 'param_gxtb.txt']);

    // Unmodified distribution passes verifyGxtbRuntime
    await verifyGxtbRuntime(runtime);

    // 3. Tampering with lib/*.dylib is rejected by verifyGxtbRuntime
    await fs.writeFile(dist.dylibPath, 'tampered-dylib-bytes\n', 'utf8');
    await assert.rejects(() => verifyGxtbRuntime(runtime), /GXTB_PROGRAM_CHANGED/);

    // Restore dylib and verify tampering with share/xtb parameters is also rejected
    await fs.writeFile(dist.dylibPath, 'fake-dylib-binary\n', 'utf8');
    await verifyGxtbRuntime(runtime);
    await fs.writeFile(dist.paramMain, 'tampered-gxtb-parameters\n', 'utf8');
    await assert.rejects(() => verifyGxtbRuntime(runtime), /GXTB_PROGRAM_CHANGED/);

    // 4. Replacing lib/ with a symlink is rejected by verifyGxtbRuntime, resolve, info, and detect
    await fs.writeFile(dist.paramMain, 'gxtb-parameters-v1\n', 'utf8');
    await verifyGxtbRuntime(runtime);
    const evilLibTarget = path.join(root, 'evil-lib');
    await fs.mkdir(evilLibTarget, { recursive: true });
    await fs.writeFile(path.join(evilLibTarget, 'libevil.dylib'), 'evil\n', 'utf8');
    await fs.rm(dist.libDir, { recursive: true, force: true });
    await fs.symlink(evilLibTarget, dist.libDir);
    await assert.rejects(() => verifyGxtbRuntime(runtime), /GXTB_PROGRAM_CHANGED/);
    await assert.rejects(() => linuxStore.resolve());
    const symDetected = await linuxStore.detect();
    assert.equal(symDetected.status, 'detection-failed');

    // Also reject symlinked lib/ introduced after resolve() on a dist originally without lib/, and verify no lib/ is injected when absent
    const noLibDist = await createMockGxtbDistribution(path.join(root, 'no-lib'), { execMode: 0o755 });
    await fs.rm(noLibDist.libDir, { recursive: true, force: true });
    const darwinNoLibCalls = [];
    const darwinNoLibStore = createGxtbBackendStore(path.join(storeRoot, 'no-lib-darwin'), {
      spawn: createFakeSpawn(darwinNoLibCalls),
    });
    await darwinNoLibStore.select(noLibDist.executable);
    const noLibRuntime = await withPlatform('darwin', () => darwinNoLibStore.resolve());
    assert.equal(darwinNoLibCalls[0].env.DYLD_FALLBACK_LIBRARY_PATH, `${noLibDist.binDir}:/usr/lib`);
    const linuxNoLibCalls = [];
    const linuxNoLibStore = createGxtbBackendStore(path.join(storeRoot, 'no-lib-linux'), {
      spawn: createFakeSpawn(linuxNoLibCalls),
    });
    await linuxNoLibStore.select(noLibDist.executable);
    await withPlatform('linux', () => linuxNoLibStore.resolve());
    assert.equal(linuxNoLibCalls[0].env.LD_LIBRARY_PATH, noLibDist.binDir);

    await fs.symlink(evilLibTarget, noLibDist.libDir);
    await assert.rejects(() => verifyGxtbRuntime(noLibRuntime), /GXTB_PROGRAM_CHANGED/);
    const uncheckSymStore = createGxtbBackendStore(path.join(storeRoot, 'sym-unchecked'), {
      spawn: createFakeSpawn([]),
    });
    await uncheckSymStore.select(noLibDist.executable);
    const uncheckInfo = await uncheckSymStore.info();
    assert.equal(uncheckInfo.status, 'program-unavailable');
  });
});

test('g-xTB backend marks binary without --gxtb help flag as unsupported and rejects resolve()', { skip: process.platform === 'win32' }, async () => {
  await withTempDir(async (root) => {
    const storeRoot = path.join(root, 'store');
    await fs.mkdir(storeRoot, { recursive: true });
    const dist = await createMockGxtbDistribution(root, { execMode: 0o755 });
    const store = createGxtbBackendStore(storeRoot, {
      spawn: createFakeSpawn([], {
        versionStdout: 'xtb version 6.8.0 (abc1234)\n',
        helpStdout: 'Usage: xtb [options]\n  --gfn 2\n',
      }),
    });

    await store.select(dist.executable);
    const detected = await store.detect();
    assert.equal(detected.status, 'unsupported');
    assert.equal(detected.capable, false);
    await assert.rejects(() => store.resolve(), /GXTB_CAPABILITY_MISSING/);
  });
});
