import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrbitalBackendStore } = require('../../desktop/orbital-runtime.cjs');
const { chemistryRuntime } = require('../../desktop/runtime.cjs');
const { currentRuntimeEnvironment } = require('../../desktop/current-runtime.cjs');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ester-orbital-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function resolveChemistryRuntimeForTest() {
  const appPath = process.cwd();
  const runtime = chemistryRuntime({
    packaged: false,
    resourcesPath: appPath,
    appPath,
    environment: process.env,
  });
  const env = {
    ...process.env,
    ...currentRuntimeEnvironment({
      packaged: false,
      appPath,
      executable: runtime.executable,
      environment: process.env,
    }),
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete env[k];
  }
  return { ...runtime, env };
}

function runOrbitalWorkerCommands(runtime, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, [...runtime.args, '--orbitals'], {
      cwd: runtime.cwd,
      env: runtime.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages = [];
    let buffer = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) messages.push(JSON.parse(line));
      }
      if (requests.onMessage) {
        requests.onMessage(messages, child);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && code !== null && !requests.allowNonZeroExit) {
        reject(new Error(`orbitals worker exited with ${code}: ${stderr}`));
      } else {
        resolve(messages);
      }
    });
    for (const req of requests.initial || []) {
      child.stdin.write(JSON.stringify(req) + '\n');
    }
    if (requests.closeStdinImmediately) {
      child.stdin.end();
    }
  });
}

test('createOrbitalBackendStore resolves lowercase multiwfn, skips non-executable earlier directory candidates, and resolves POSIX symlinks', async () => {
  await withTempDir(async (root) => {
    const storeRoot = path.join(root, 'userData');
    await fs.mkdir(storeRoot, { recursive: true });

    const pkgRoot = path.join(root, 'Cellar', 'multiwfn', '2026.7.15');
    const cellarBinDir = path.join(pkgRoot, 'bin');
    await fs.mkdir(cellarBinDir, { recursive: true });

    // Place a non-executable Multiwfn file in pkgRoot to verify directory candidate loop continues to bin/multiwfn
    const nonExecRootCandidate = path.join(pkgRoot, 'Multiwfn');
    await fs.writeFile(nonExecRootCandidate, 'not executable document', { mode: 0o644 });

    const realBinary = path.join(cellarBinDir, 'multiwfn');
    await fs.writeFile(realBinary, '#!/bin/sh\necho Multiwfn\n', { mode: 0o755 });
    const canonicalBinary = await fs.realpath(realBinary);

    const store = createOrbitalBackendStore(storeRoot, {
      platform: 'darwin',
      env: {},
      defaultCandidates: [],
    });

    const unconfigured = await store.info();
    assert.equal(unconfigured.configured, false);

    if (process.platform !== 'win32') {
      // Directory contains non-executable Multiwfn AND executable bin/multiwfn -> must resolve bin/multiwfn
      const fromDirWithNonExecFirst = await store.select(pkgRoot);
      assert.equal(fromDirWithNonExecFirst.configured, true);
      assert.equal(fromDirWithNonExecFirst.path, canonicalBinary);

      const optDir = path.join(root, 'opt');
      await fs.mkdir(optDir, { recursive: true });
      const optPrefixLink = path.join(optDir, 'multiwfn');
      await fs.symlink(pkgRoot, optPrefixLink);

      const brewBinDir = path.join(root, 'bin');
      await fs.mkdir(brewBinDir, { recursive: true });
      const brewBinLink = path.join(brewBinDir, 'multiwfn');
      await fs.symlink(realBinary, brewBinLink);

      const fromSymlinkBinary = await store.select(brewBinLink);
      assert.equal(fromSymlinkBinary.configured, true);
      assert.equal(fromSymlinkBinary.path, canonicalBinary);

      const fromOptPrefix = await store.select(optPrefixLink);
      assert.equal(fromOptPrefix.configured, true);
      assert.equal(fromOptPrefix.path, canonicalBinary);
    }

    const fromBinDir = await store.select(cellarBinDir);
    assert.equal(fromBinDir.configured, true);
    assert.equal(fromBinDir.path, canonicalBinary);

    const persisted = await store.info();
    assert.deepEqual(persisted, { configured: true, path: canonicalBinary });
  });
});

test('createOrbitalBackendStore supports SCIYUE_MULTIWFN / Multiwfnpath env discovery, falls back on invalid orbital-backend.json, and respects user select()', async () => {
  await withTempDir(async (root) => {
    const storeRoot = path.join(root, 'userData');
    await fs.mkdir(storeRoot, { recursive: true });

    const envDir = path.join(root, 'env-mw', 'bin');
    const autoDir = path.join(root, 'auto', 'bin');
    const customDir = path.join(root, 'custom', 'bin');
    await fs.mkdir(envDir, { recursive: true });
    await fs.mkdir(autoDir, { recursive: true });
    await fs.mkdir(customDir, { recursive: true });

    const envBin = path.join(envDir, 'multiwfn');
    const autoBin = path.join(autoDir, 'multiwfn');
    const customBin = path.join(customDir, 'Multiwfn');
    await fs.writeFile(envBin, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(autoBin, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(customBin, '#!/bin/sh\n', { mode: 0o755 });

    // 1. Env discovery via SCIYUE_MULTIWFN and Multiwfnpath directory
    const envStore = createOrbitalBackendStore(storeRoot, {
      platform: 'darwin',
      env: { Multiwfnpath: envDir },
      defaultCandidates: [autoBin],
    });
    const fromEnv = await envStore.info();
    assert.equal(fromEnv.configured, true);
    assert.equal(fromEnv.path, await fs.realpath(envBin));

    // 2. Corrupted or stale orbital-backend.json falls back cleanly to defaultCandidates
    await fs.writeFile(
      path.join(storeRoot, 'orbital-backend.json'),
      JSON.stringify({ schema: 1, path: path.join(root, 'deleted', 'Multiwfn') }),
      'utf8',
    );
    const store = createOrbitalBackendStore(storeRoot, {
      platform: 'darwin',
      env: {},
      defaultCandidates: [path.join(root, 'missing', 'multiwfn'), autoBin],
    });

    const discovered = await store.info();
    assert.equal(discovered.configured, true);
    assert.equal(discovered.path, await fs.realpath(autoBin));

    // 3. Explicit user selection overrides auto-discovered candidate
    const selected = await store.select(customDir);
    assert.equal(selected.configured, true);
    assert.equal(selected.path, await fs.realpath(customBin));

    const afterSelect = await store.info();
    assert.equal(afterSelect.configured, true);
    assert.equal(afterSelect.path, await fs.realpath(customBin));
  });
});

test('createOrbitalBackendStore rejects non-Multiwfn binaries, non-executable POSIX files, and win32 symlinks', async () => {
  await withTempDir(async (root) => {
    const storeRoot = path.join(root, 'userData');
    await fs.mkdir(storeRoot, { recursive: true });

    const wrongName = path.join(root, 'other-tool');
    await fs.writeFile(wrongName, '#!/bin/sh\n', { mode: 0o755 });

    const nonExecDir = path.join(root, 'noexec');
    await fs.mkdir(nonExecDir, { recursive: true });
    const nonExecBin = path.join(nonExecDir, 'multiwfn');
    await fs.writeFile(nonExecBin, 'not-executable', { mode: 0o644 });

    const posixStore = createOrbitalBackendStore(storeRoot, {
      platform: 'darwin',
      env: {},
      defaultCandidates: [],
    });

    await assert.rejects(() => posixStore.select(wrongName), /Select a local Multiwfn executable/);
    if (process.platform !== 'win32') {
      await assert.rejects(
        () => posixStore.select(nonExecBin),
        /Multiwfn executable must be executable/,
      );
    }

    const winDir = path.join(root, 'win');
    await fs.mkdir(winDir, { recursive: true });
    const winExe = path.join(winDir, 'Multiwfn.exe');
    await fs.writeFile(winExe, 'MZ-fake', { mode: 0o755 });
    const fakeWinLink = path.join(root, 'Multiwfn.exe');

    const mockWinFs = {
      ...fs,
      async lstat(target) {
        if (path.resolve(target) === path.resolve(fakeWinLink)) {
          return {
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => true,
            size: 10,
          };
        }
        return fs.lstat(target);
      },
    };

    const winStore = createOrbitalBackendStore(storeRoot, {
      platform: 'win32',
      env: {},
      defaultCandidates: [],
      fs: mockWinFs,
    });
    await assert.rejects(
      () => winStore.select(fakeWinLink),
      /Multiwfn executable must be a regular file/,
    );
    const winSelected = await winStore.select(winDir);
    assert.equal(winSelected.configured, true);
    assert.equal(winSelected.path, await fs.realpath(winExe));
  });
});

test('engine.py --orbitals resolves ../etc/multiwfn/settings.ini fallback and executes orbital generation with installed macOS Multiwfn CLI', async () => {
  const runtime = resolveChemistryRuntimeForTest();

  await withTempDir(async (root) => {
    const binDir = path.join(root, 'prefix', 'bin');
    const etcDir = path.join(root, 'prefix', 'etc', 'multiwfn');
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(etcDir, { recursive: true });

    const fakeExe = path.join(binDir, 'multiwfn');
    const etcSettings = path.join(etcDir, 'settings.ini');
    await fs.writeFile(fakeExe, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(etcSettings, '  nthreads= 6 // custom threads\n', 'utf8');

    const stdout = execFileSync(runtime.executable, [...runtime.args, '--orbitals'], {
      cwd: runtime.cwd,
      env: runtime.env,
      input: JSON.stringify({ id: 'res-1', operation: 'resources', executable: fakeExe }) + '\n',
      encoding: 'utf8',
      timeout: 30000,
    });
    const reply = JSON.parse(stdout.trim().split('\n')[0]);
    assert.equal(reply.ok, true);
    assert.equal(reply.resources.settingsPresent, true);
    assert.equal(reply.resources.threads, 6);
    assert.equal(reply.resources.threadSource, 'settings');
    assert.equal(reply.resources.settingsPath, await fs.realpath(etcSettings));

    const hostMultiwfn = '/opt/homebrew/opt/multiwfn/bin/multiwfn';
    if (process.platform === 'darwin' && fsSync.existsSync(hostMultiwfn)) {
      const store = createOrbitalBackendStore(path.join(root, 'liveUserData'), {
        platform: 'darwin',
        env: {},
      });
      const backendInfo = await store.info();
      assert.equal(backendInfo.configured, true);

      const fchkPath = path.join(root, 'h2.fchk');
      await fs.writeFile(
        fchkPath,
        `H2 test
SP RHF STO-3G
Number of atoms                            I               2
Charge                                     I               0
Multiplicity                               I               1
Number of electrons                        I               2
Number of alpha electrons                  I               1
Number of beta electrons                   I               1
Number of basis functions                  I               2
Number of independent functions            I               2
Atomic numbers                             I   N=           2
           1           1
Nuclear charges                            R   N=           2
  1.00000000E+00  1.00000000E+00
Current cartesian coordinates              R   N=           6
  0.00000000E+00  0.00000000E+00  0.00000000E+00  0.00000000E+00  0.00000000E+00
  1.40000000E+00
Shell types                                I   N=           2
           0           0
Number of primitives per shell             I   N=           2
           1           1
Shell to atom map                          I   N=           2
           1           2
Primitive exponents                        R   N=           2
  3.42525091E+00  3.42525091E+00
Contraction coefficients                   R   N=           2
  1.00000000E+00  1.00000000E+00
Alpha Orbital Energies                     R   N=           2
 -5.78202969E-01  6.70267765E-01
Alpha MO coefficients                      R   N=           4
  5.48934041E-01  5.48934041E-01  1.21146407E+00 -1.21146407E+00
`,
        'utf8',
      );

      const grid = {
        originBohr: [-2.0, -2.0, -2.0],
        axesBohr: [
          [1.0, 0.0, 0.0],
          [0.0, 1.0, 0.0],
          [0.0, 0.0, 1.0],
        ],
        dimensions: [4, 4, 4],
      };

      let closed = false;
      const messages = await runOrbitalWorkerCommands(runtime, {
        initial: [
          {
            id: 'open-1',
            operation: 'open',
            sessionId: 'sess-1',
            executable: backendInfo.path,
            sourcePath: fchkPath,
            workspacePath: root,
            grid,
            threads: 2,
            mode: 'selected',
          },
          {
            id: 'gen-1',
            operation: 'generate-one',
            sessionId: 'sess-1',
            orbitalId: 'restricted:1',
            generation: 1,
          },
        ],
        onMessage(msgs, child) {
          if (
            !closed &&
            msgs.some((m) => m.event === 'state' && m.state === 'complete' && m.completed === 1)
          ) {
            closed = true;
            child.stdin.write(
              JSON.stringify({ id: 'close-1', operation: 'close', sessionId: 'sess-1' }) + '\n',
            );
            child.stdin.end();
          }
        },
      });

      const progressMsg = messages.find((m) => m.event === 'progress' && m.orbital?.id === 'restricted:1');
      assert.ok(progressMsg, 'Expected orbital progress event from Multiwfn CLI');
      assert.equal(progressMsg.backend.name, 'Multiwfn');
      assert.equal(progressMsg.backend.threads, 2);
    }
  });
});
