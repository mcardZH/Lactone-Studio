import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrbitalBackendStore } = require('../../desktop/orbital-runtime.cjs');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ester-orbital-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('createOrbitalBackendStore resolves lowercase multiwfn, bin/multiwfn directories, and Homebrew symlinks on POSIX', async () => {
  await withTempDir(async (root) => {
    const storeRoot = path.join(root, 'userData');
    await fs.mkdir(storeRoot, { recursive: true });

    const cellarBinDir = path.join(root, 'Cellar', 'multiwfn', '2026.7.15', 'bin');
    await fs.mkdir(cellarBinDir, { recursive: true });
    const realBinary = path.join(cellarBinDir, 'multiwfn');
    await fs.writeFile(realBinary, '#!/bin/sh\necho Multiwfn\n', { mode: 0o755 });
    const canonicalBinary = await fs.realpath(realBinary);

    const optDir = path.join(root, 'opt');
    await fs.mkdir(optDir, { recursive: true });
    const optPrefixLink = path.join(optDir, 'multiwfn');
    await fs.symlink(path.join(root, 'Cellar', 'multiwfn', '2026.7.15'), optPrefixLink);

    const brewBinDir = path.join(root, 'bin');
    await fs.mkdir(brewBinDir, { recursive: true });
    const brewBinLink = path.join(brewBinDir, 'multiwfn');
    await fs.symlink(realBinary, brewBinLink);

    const store = createOrbitalBackendStore(storeRoot, {
      platform: 'darwin',
      env: {},
      defaultCandidates: [],
    });

    const unconfigured = await store.info();
    assert.equal(unconfigured.configured, false);

    // 1. Selecting symlinked binary (/opt/homebrew/bin/multiwfn)
    const fromSymlinkBinary = await store.select(brewBinLink);
    assert.equal(fromSymlinkBinary.configured, true);
    assert.equal(fromSymlinkBinary.path, canonicalBinary);

    // 2. Selecting symlinked prefix directory (/opt/homebrew/opt/multiwfn -> .../Cellar/... containing bin/multiwfn)
    const fromOptPrefix = await store.select(optPrefixLink);
    assert.equal(fromOptPrefix.configured, true);
    assert.equal(fromOptPrefix.path, canonicalBinary);

    // 3. Selecting bin directory directly
    const fromBinDir = await store.select(cellarBinDir);
    assert.equal(fromBinDir.configured, true);
    assert.equal(fromBinDir.path, canonicalBinary);

    const persisted = await store.info();
    assert.deepEqual(persisted, { configured: true, path: canonicalBinary });
  });
});

test('createOrbitalBackendStore auto-discovers external CLI Multiwfn when unconfigured and respects user override', async () => {
  await withTempDir(async (root) => {
    const storeRoot = path.join(root, 'userData');
    await fs.mkdir(storeRoot, { recursive: true });

    const autoDir = path.join(root, 'auto', 'bin');
    const customDir = path.join(root, 'custom', 'bin');
    await fs.mkdir(autoDir, { recursive: true });
    await fs.mkdir(customDir, { recursive: true });

    const autoBin = path.join(autoDir, 'multiwfn');
    const customBin = path.join(customDir, 'Multiwfn');
    await fs.writeFile(autoBin, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(customBin, '#!/bin/sh\n', { mode: 0o755 });

    const store = createOrbitalBackendStore(storeRoot, {
      platform: 'darwin',
      env: {},
      defaultCandidates: [path.join(root, 'missing', 'multiwfn'), autoBin],
    });

    const discovered = await store.info();
    assert.equal(discovered.configured, true);
    assert.equal(discovered.path, await fs.realpath(autoBin));

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
      await assert.rejects(() => posixStore.select(nonExecBin), /Multiwfn executable must be executable/);
    }

    const winDir = path.join(root, 'win');
    await fs.mkdir(winDir, { recursive: true });
    const winExe = path.join(winDir, 'Multiwfn.exe');
    await fs.writeFile(winExe, 'MZ-fake', { mode: 0o755 });
    const winLink = path.join(root, 'Multiwfn.exe');
    await fs.symlink(winExe, winLink);

    const winStore = createOrbitalBackendStore(storeRoot, {
      platform: 'win32',
      env: {},
      defaultCandidates: [],
    });
    await assert.rejects(() => winStore.select(winLink), /Multiwfn executable must be a regular file/);
    const winSelected = await winStore.select(winDir);
    assert.equal(winSelected.configured, true);
    assert.equal(winSelected.path, await fs.realpath(winExe));
  });
});

test('multiwfn_resources.py falls back to ../etc/multiwfn/settings.ini and works with installed macOS Multiwfn CLI', async () => {
  const pythonCandidate = path.resolve(
    process.cwd(),
    '.local/toolchains/darwin-arm64/conda-py312-arm64/python/bin/python3',
  );
  const pythonExec = fsSync.existsSync(pythonCandidate) ? pythonCandidate : 'python3';
  const sitePackages = path.resolve(
    process.cwd(),
    '.local/dependencies/darwin-arm64/conda-chem-arm64/python/lib/python3.12/site-packages',
  );
  const chemistryDir = path.resolve(process.cwd(), 'desktop/chemistry');

  await withTempDir(async (root) => {
    const binDir = path.join(root, 'prefix', 'bin');
    const etcDir = path.join(root, 'prefix', 'etc', 'multiwfn');
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(etcDir, { recursive: true });

    const fakeExe = path.join(binDir, 'multiwfn');
    const etcSettings = path.join(etcDir, 'settings.ini');
    await fs.writeFile(fakeExe, '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(etcSettings, '  nthreads= 6 // custom threads\n', 'utf8');

    const output = execFileSync(
      pythonExec,
      [
        '-c',
        `import json, sys; from multiwfn_resources import resolve_resources; info, _ = resolve_resources(sys.argv[1]); print(json.dumps({"threads": info["threads"], "threadSource": info["threadSource"], "settingsPresent": info["settingsPresent"], "settingsPath": info["settingsPath"]}))`,
        fakeExe,
      ],
      {
        env: {
          ...process.env,
          PYTHONPATH: [sitePackages, chemistryDir].join(path.delimiter),
        },
        encoding: 'utf8',
      },
    );
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.settingsPresent, true);
    assert.equal(parsed.threads, 6);
    assert.equal(parsed.threadSource, 'settings');
    assert.equal(parsed.settingsPath, await fs.realpath(etcSettings));
  });
});
