import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const contract = require('../../desktop/xtb-runtime-contract.cjs');
const { xtbRuntime } = require('../../desktop/xtb-runtime.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const EXPECTED_PARAMETERS = Object.freeze([
  'share/xtb/param_gfn0-xtb.txt',
  'share/xtb/param_gfn1-xtb.txt',
  'share/xtb/param_gfn2-xtb.txt',
  'share/xtb/.param_gfnff.xtb'
]);

const EXPECTED_WIN32_LIBS = Object.freeze([
  'bin/libiomp5md.dll',
  'bin/vcruntime140.dll'
]);

const EXPECTED_DARWIN_LIBS = Object.freeze([
  'lib/libblas.3.dylib',
  'lib/libgcc_s.1.1.dylib',
  'lib/libgfortran.5.dylib',
  'lib/liblapack.3.dylib',
  'lib/libomp.dylib',
  'lib/libopenblas.0.dylib',
  'lib/libquadmath.0.dylib'
]);

function sha256Text(content) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

async function writeOrdinaryFile(root, relativePath, content = 'stub-content\n', mode = 0o644) {
  const fullPath = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, { mode });
  await fs.chmod(fullPath, mode);
  return {
    path: relativePath,
    ...sha256Text(content)
  };
}

async function populateXtbRoot(xtbRoot, platformId, options = {}) {
  await fs.mkdir(xtbRoot, { recursive: true });
  const entryRel = platformId === 'win32-x64' ? 'bin/xtb.exe' : 'bin/xtb';
  const execMode = options.execMode ?? (platformId === 'win32-x64' ? 0o644 : 0o755);
  const files = [];

  if (!options.omitEntry) {
    files.push(await writeOrdinaryFile(xtbRoot, entryRel, '#!/bin/sh\necho xtb\n', execMode));
  }

  for (const paramRel of EXPECTED_PARAMETERS) {
    if (options.omitParameter === paramRel) continue;
    files.push(await writeOrdinaryFile(xtbRoot, paramRel, `param:${paramRel}\n`, 0o644));
  }

  const libraries =
    options.libraries ?? (platformId === 'win32-x64' ? EXPECTED_WIN32_LIBS : EXPECTED_DARWIN_LIBS);
  for (const libRel of libraries) {
    if (options.omitLibrary === libRel) continue;
    files.push(await writeOrdinaryFile(xtbRoot, libRel, `lib:${libRel}\n`, 0o644));
  }

  const schema = options.schema ?? 'sciyue-xtb-bundled-runtime/v1';
  const descriptor = {
    schema,
    version: options.version ?? '6.4.1',
    platform: options.descriptorPlatform ?? platformId,
    scope: 'local-experimental',
    localUseReady: true,
    entry: options.descriptorEntry ?? entryRel,
    dataDirectory: 'share/xtb',
    methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff']
  };

  if (schema === 'sciyue-xtb-bundled-runtime/v2') {
    const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const inventoryJson = JSON.stringify(
      {
        schema: 'sciyue-xtb-runtime-inventory/v1',
        files: sortedFiles
      },
      null,
      2
    );
    const inventoryEntry = await writeOrdinaryFile(xtbRoot, 'inventory.json', inventoryJson, 0o644);
    descriptor.source = {
      commit: '5071a8869720fb0ecd788af977159869b64a277c',
      scientificPinsManifest: {
        sha256: 'c74161d40083f5acb15ca57a7cbb9c337e21f85c866055c866055c875c04aad63255f6b'.slice(0, 64)
      }
    };
    descriptor.build = {
      id: `${platformId}-gnu132-r2-a01`,
      compiler: { name: 'gfortran', version: '13.2.0' },
      toolchainArchiveSha256: '87962f039c303764376b6a031edb7d4afab08abc89805c7055fa9dce5e764c9a',
      sourceReceiptSha256: 'd3afbb68638253d2a5ab8fbc9f86191d48120560269fd7ece37d887f686c3ef3'
    };
    descriptor.modified = {
      local: true,
      kind: 'independent-rebuild',
      upstreamBinaryIdentity: false
    };
    descriptor.inventory = inventoryEntry;
  }

  const runtimeJson = JSON.stringify(descriptor, null, 2);
  const manifestRef = await writeOrdinaryFile(xtbRoot, 'runtime.json', runtimeJson, 0o644);
  return { entryRel, files, manifestRef };
}

async function createPackagedXtbSandbox(platformId = 'darwin-arm64', options = {}) {
  const baseTmp = await fs.realpath(os.tmpdir());
  const sandbox = await fs.mkdtemp(path.join(baseTmp, `es-xtb-test-${platformId}-`));
  const resourcesPath = path.join(sandbox, 'resources');
  const xtbRoot = path.join(resourcesPath, 'xtb');
  const { manifestRef } = await populateXtbRoot(xtbRoot, platformId, options);

  const schema = options.schema ?? 'sciyue-xtb-bundled-runtime/v1';
  if (schema === 'sciyue-xtb-bundled-runtime/v2' || options.withProvenance) {
    const provenanceDir = path.join(sandbox, 'provenance');
    const summaryJson = JSON.stringify(
      {
        schema: 'sciyue-portable-dependency-summary/v1',
        xtb: {
          runtimeManifest: manifestRef
        }
      },
      null,
      2
    );
    await writeOrdinaryFile(provenanceDir, 'dependencies.json', summaryJson, 0o644);
  }

  return { sandbox, resourcesPath, xtbRoot, manifestRef };
}

async function createDevelopmentXtbAppSandbox(platforms = ['win32-x64', 'darwin-arm64', 'darwin-x64'], overrides = {}) {
  const baseTmp = await fs.realpath(os.tmpdir());
  const appPath = await fs.mkdtemp(path.join(baseTmp, 'es-xtb-dev-app-'));

  for (const platformId of platforms) {
    const depParent =
      platformId === 'win32-x64'
        ? '.local/dependencies/win-x64'
        : `.local/dependencies/${platformId}`;
    const depRootRel = `${depParent}/bundle-${platformId}`;
    const xtbRoot = path.join(appPath, ...depRootRel.split('/'), 'xtb');
    const platformOverrides = overrides[platformId] ?? {};
    const { entryRel, files, manifestRef } = await populateXtbRoot(xtbRoot, platformId, platformOverrides);

    const lockFiles = [...files, manifestRef]
      .map(row => ({
        path: `xtb/${row.path}`,
        bytes: row.bytes,
        sha256: row.sha256
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const xtbLockRel = `desktop/packaging/xtb-runtime.${platformId}.lock.json`;
    await writeOrdinaryFile(
      appPath,
      xtbLockRel,
      JSON.stringify(
        {
          schema: 'sciyue-xtb-lock-v1',
          platform: platformId,
          lockId: `lock-${platformId}`,
          root: depRootRel,
          contentDirectories: ['xtb'],
          localUseReady: true,
          entry: `xtb/${entryRel}`,
          dataDirectory: 'xtb/share/xtb',
          files: lockFiles
        },
        null,
        2
      ),
      0o644
    );

    const profileRel = `desktop/packaging/native-profile.${platformId}.json`;
    await writeOrdinaryFile(
      appPath,
      profileRel,
      JSON.stringify(
        {
          schema: 'sciyue-native-profile-v1',
          platform: platformId,
          runtimeLock: `desktop/packaging/native-runtime.${platformId}.lock.json`,
          toolchainLock: `desktop/packaging/native-toolchain.${platformId}.lock.json`,
          xtbLock: xtbLockRel
        },
        null,
        2
      ),
      0o644
    );
  }

  return appPath;
}

async function replaceBinWithLinkOrJunction(xtbRoot, sandbox, forceJunctionFallback = false) {
  const binDir = path.join(xtbRoot, 'bin');
  const binXtb = path.join(binDir, 'xtb');
  const realCopy = path.join(sandbox, 'real-xtb');
  await fs.copyFile(binXtb, realCopy);
  await fs.unlink(binXtb);
  try {
    if (forceJunctionFallback) {
      const err = new Error('Simulated Windows symlink privilege failure');
      err.code = 'EPERM';
      throw err;
    }
    await fs.symlink(realCopy, binXtb);
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'ENOSYS')) {
      const realBinDir = path.join(sandbox, 'real-bin-dir');
      await fs.mkdir(realBinDir, { recursive: true });
      await fs.copyFile(realCopy, path.join(realBinDir, 'xtb'));
      await fs.rm(binDir, { recursive: true, force: true });
      await fs.symlink(realBinDir, binDir, process.platform === 'win32' ? 'junction' : 'dir');
      return;
    }
    throw error;
  }
}

test('xtb-runtime-contract platform helpers and validateDescriptor support win32-x64, darwin-arm64, and darwin-x64', () => {
  assert.deepEqual(contract.REQUIRED_PARAMETERS, EXPECTED_PARAMETERS);
  assert.deepEqual(contract.WIN32_V1_LIBRARIES, EXPECTED_WIN32_LIBS);
  assert.deepEqual(contract.DARWIN_V1_LIBRARIES, EXPECTED_DARWIN_LIBS);

  assert.equal(contract.entryForPlatform('win32-x64'), 'bin/xtb.exe');
  assert.equal(contract.entryForPlatform('darwin-arm64'), 'bin/xtb');
  assert.equal(contract.entryForPlatform('darwin-x64'), 'bin/xtb');
  assert.throws(() => contract.entryForPlatform('linux-x64'), /XTB_RUNTIME_INVALID: descriptor identity/);

  assert.deepEqual(contract.contentRootsForPlatform('win32-x64'), ['bin', 'share/xtb']);
  assert.deepEqual(contract.contentRootsForPlatform('darwin-arm64'), ['bin', 'lib', 'share/xtb']);
  assert.deepEqual(contract.contentRootsForPlatform('darwin-x64'), ['bin', 'lib', 'share/xtb']);
  assert.throws(() => contract.contentRootsForPlatform('linux-x64'), /XTB_RUNTIME_INVALID: descriptor identity/);

  assert.deepEqual(contract.requiredMembersForPlatform('win32-x64'), contract.REQUIRED);
  assert.deepEqual(contract.requiredMembersForPlatform('darwin-arm64'), [
    'bin/xtb',
    ...EXPECTED_PARAMETERS
  ]);

  for (const [platform, entry] of [
    ['win32-x64', 'bin/xtb.exe'],
    ['darwin-arm64', 'bin/xtb'],
    ['darwin-x64', 'bin/xtb']
  ]) {
    const record = contract.validateDescriptor({
      schema: 'sciyue-xtb-bundled-runtime/v1',
      version: '6.4.1',
      platform,
      scope: 'local-experimental',
      localUseReady: true,
      entry,
      dataDirectory: 'share/xtb',
      methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff']
    });
    assert.equal(record.platform, platform);
    assert.equal(record.entry, entry);
  }

  assert.throws(
    () =>
      contract.validateDescriptor({
        schema: 'sciyue-xtb-bundled-runtime/v1',
        version: '6.4.1',
        platform: 'darwin-arm64',
        scope: 'local-experimental',
        localUseReady: true,
        entry: 'bin/xtb.exe',
        dataDirectory: 'share/xtb',
        methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff']
      }),
    /XTB_RUNTIME_INVALID: descriptor identity/
  );

  assert.throws(
    () =>
      contract.validateDescriptor({
        schema: 'sciyue-xtb-bundled-runtime/v1',
        version: '6.4.1',
        platform: 'win32-x64',
        scope: 'local-experimental',
        localUseReady: true,
        entry: 'bin/xtb',
        dataDirectory: 'share/xtb',
        methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff']
      }),
    /XTB_RUNTIME_INVALID: descriptor identity/
  );
});

test('xtbRuntime resolves packaged v1 and v2 runtimes for win32-x64, darwin-arm64, and darwin-x64', async () => {
  for (const platformId of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
    const v1 = await createPackagedXtbSandbox(platformId, { schema: 'sciyue-xtb-bundled-runtime/v1' });
    try {
      const resolved = await xtbRuntime({
        packaged: true,
        resourcesPath: v1.resourcesPath,
        platformId
      });
      assert.equal(resolved.root, v1.xtbRoot);
      assert.equal(
        resolved.executable,
        path.join(v1.xtbRoot, ...contract.entryForPlatform(platformId).split('/'))
      );
      assert.equal(resolved.dataDirectory, path.join(v1.xtbRoot, 'share/xtb'));
      assert.equal(resolved.version, '6.4.1');
      assert.equal(resolved.engineIdentity.kind, 'legacy-binary-observation');
      contract.assertEngineIdentity(resolved.engineIdentity);
    } finally {
      await fs.rm(v1.sandbox, { recursive: true, force: true });
    }

    const v2 = await createPackagedXtbSandbox(platformId, { schema: 'sciyue-xtb-bundled-runtime/v2' });
    try {
      const resolved = await xtbRuntime({
        packaged: true,
        resourcesPath: v2.resourcesPath,
        platformId
      });
      assert.equal(resolved.root, v2.xtbRoot);
      assert.equal(
        resolved.executable,
        path.join(v2.xtbRoot, ...contract.entryForPlatform(platformId).split('/'))
      );
      assert.equal(resolved.engineIdentity.kind, 'bundled-independent-rebuild');
      contract.assertEngineIdentity(resolved.engineIdentity);
    } finally {
      await fs.rm(v2.sandbox, { recursive: true, force: true });
    }
  }
});

test('xtbRuntime development mode forwards platform, arch, and platformId to developmentXtb and rejects descriptor platform mismatch', async () => {
  const appPath = await createDevelopmentXtbAppSandbox(['win32-x64', 'darwin-arm64', 'darwin-x64']);
  try {
    const winResolved = await xtbRuntime({
      packaged: false,
      appPath,
      platform: 'win32',
      arch: 'x64'
    });
    assert.equal(winResolved.executable, path.join(winResolved.root, 'bin', 'xtb.exe'));

    const armResolved = await xtbRuntime({
      packaged: false,
      appPath,
      platform: 'darwin',
      arch: 'arm64'
    });
    assert.equal(armResolved.executable, path.join(armResolved.root, 'bin', 'xtb'));
    assert.ok(armResolved.root.includes('bundle-darwin-arm64'));

    const x64Resolved = await xtbRuntime({
      packaged: false,
      appPath,
      platformId: 'darwin-x64'
    });
    assert.equal(x64Resolved.executable, path.join(x64Resolved.root, 'bin', 'xtb'));
    assert.ok(x64Resolved.root.includes('bundle-darwin-x64'));
  } finally {
    await fs.rm(appPath, { recursive: true, force: true });
  }

  // Verify development-mode rejection when runtime.json platform mismatches expectedPlatform
  const mismatchedApp = await createDevelopmentXtbAppSandbox(['darwin-arm64'], {
    'darwin-arm64': {
      descriptorPlatform: 'darwin-x64'
    }
  });
  try {
    await assert.rejects(
      () =>
        xtbRuntime({
          packaged: false,
          appPath: mismatchedApp,
          platform: 'darwin',
          arch: 'arm64'
        }),
      /XTB_RUNTIME_INVALID: descriptor platform mismatch/
    );
  } finally {
    await fs.rm(mismatchedApp, { recursive: true, force: true });
  }
});

test('xtbRuntime rejects platform mismatch, every missing Windows DLL or macOS dylib, every missing parameter, symlinks/junctions, and non-executable binary', async () => {
  // 1. Descriptor platform mismatch
  const mismatch = await createPackagedXtbSandbox('darwin-arm64');
  try {
    await assert.rejects(
      () =>
        xtbRuntime({
          packaged: true,
          resourcesPath: mismatch.resourcesPath,
          platformId: 'darwin-x64'
        }),
      /XTB_RUNTIME_INVALID: descriptor platform mismatch/
    );
  } finally {
    await fs.rm(mismatch.sandbox, { recursive: true, force: true });
  }

  // 2a. Missing each required Windows DLL on win32-x64
  for (const dllRel of EXPECTED_WIN32_LIBS) {
    const missingDll = await createPackagedXtbSandbox('win32-x64', {
      omitLibrary: dllRel
    });
    try {
      await assert.rejects(
        () =>
          xtbRuntime({
            packaged: true,
            resourcesPath: missingDll.resourcesPath,
            platformId: 'win32-x64'
          }),
        /ENOENT|XTB_RUNTIME_INVALID/
      );
    } finally {
      await fs.rm(missingDll.sandbox, { recursive: true, force: true });
    }
  }

  // 2b. Missing each required macOS dylib on darwin-arm64
  for (const dylibRel of EXPECTED_DARWIN_LIBS) {
    const missingDylib = await createPackagedXtbSandbox('darwin-arm64', {
      omitLibrary: dylibRel
    });
    try {
      await assert.rejects(
        () =>
          xtbRuntime({
            packaged: true,
            resourcesPath: missingDylib.resourcesPath,
            platformId: 'darwin-arm64'
          }),
        /ENOENT|XTB_RUNTIME_INVALID/
      );
    } finally {
      await fs.rm(missingDylib.sandbox, { recursive: true, force: true });
    }
  }

  // 3. Missing each required parameter file
  for (const paramRel of EXPECTED_PARAMETERS) {
    const missingParam = await createPackagedXtbSandbox('darwin-arm64', {
      omitParameter: paramRel
    });
    try {
      await assert.rejects(
        () =>
          xtbRuntime({
            packaged: true,
            resourcesPath: missingParam.resourcesPath,
            platformId: 'darwin-arm64'
          }),
        /ENOENT|XTB_RUNTIME_INCOMPLETE/
      );
    } finally {
      await fs.rm(missingParam.sandbox, { recursive: true, force: true });
    }
  }

  // 4. Non-executable bin/xtb on macOS
  if (process.platform !== 'win32') {
    const nonExec = await createPackagedXtbSandbox('darwin-arm64', { execMode: 0o644 });
    try {
      await assert.rejects(
        () =>
          xtbRuntime({
            packaged: true,
            resourcesPath: nonExec.resourcesPath,
            platformId: 'darwin-arm64'
          }),
        /XTB_RUNTIME_INVALID: xTB executable mode required/
      );
    } finally {
      await fs.rm(nonExec.sandbox, { recursive: true, force: true });
    }
  }

  // 5a. Symlinked bin/xtb (with automatic junction fallback on unprivileged Windows) rejected
  const linked = await createPackagedXtbSandbox('darwin-arm64');
  try {
    await replaceBinWithLinkOrJunction(linked.xtbRoot, linked.sandbox, false);
    await assert.rejects(
      () =>
        xtbRuntime({
          packaged: true,
          resourcesPath: linked.resourcesPath,
          platformId: 'darwin-arm64'
        }),
      /XTB_RUNTIME_INVALID: linked/
    );
  } finally {
    await fs.rm(linked.sandbox, { recursive: true, force: true });
  }

  // 5b. Simulated Windows EPERM fallback to directory junction/link rejected
  const junctionLinked = await createPackagedXtbSandbox('darwin-arm64');
  try {
    await replaceBinWithLinkOrJunction(junctionLinked.xtbRoot, junctionLinked.sandbox, true);
    await assert.rejects(
      () =>
        xtbRuntime({
          packaged: true,
          resourcesPath: junctionLinked.resourcesPath,
          platformId: 'darwin-arm64'
        }),
      /XTB_RUNTIME_INVALID: linked/
    );
  } finally {
    await fs.rm(junctionLinked.sandbox, { recursive: true, force: true });
  }
});

if (process.platform === 'darwin' && process.arch === 'arm64') {
  test('xtbRuntime resolves staged development darwin-arm64 runtime in workspace', async () => {
    const stagedXtbManifest = path.join(
      ROOT,
      '.local/dependencies/darwin-arm64/conda-chem-arm64/xtb/runtime.json'
    );
    assert.equal(
      fssync.existsSync(stagedXtbManifest),
      true,
      `Expected staged darwin-arm64 xTB runtime manifest at ${stagedXtbManifest}`
    );
    const resolved = await xtbRuntime({
      packaged: false,
      appPath: ROOT
    });
    assert.equal(
      resolved.root,
      path.join(ROOT, '.local/dependencies/darwin-arm64/conda-chem-arm64/xtb')
    );
    assert.equal(resolved.executable, path.join(resolved.root, 'bin/xtb'));
    assert.equal(resolved.directory, path.join(resolved.root, 'bin'));
    assert.equal(resolved.dataDirectory, path.join(resolved.root, 'share/xtb'));
    assert.match(resolved.version, /^\d+\.\d+\.\d+/);
    contract.assertEngineIdentity(resolved.engineIdentity);
  });
}
