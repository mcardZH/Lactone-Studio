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

async function createPackagedXtbSandbox(platformId = 'darwin-arm64', options = {}) {
  const baseTmp = await fs.realpath(os.tmpdir());
  const sandbox = await fs.mkdtemp(path.join(baseTmp, `es-xtb-test-${platformId}-`));
  const resourcesPath = path.join(sandbox, 'resources');
  const xtbRoot = path.join(resourcesPath, 'xtb');
  await fs.mkdir(xtbRoot, { recursive: true });

  const entryRel = contract.entryForPlatform(platformId);
  const execMode = options.execMode ?? (platformId === 'win32-x64' ? 0o644 : 0o755);
  const files = [];

  if (!options.omitEntry) {
    files.push(await writeOrdinaryFile(xtbRoot, entryRel, '#!/bin/sh\necho xtb\n', execMode));
  }

  for (const paramRel of contract.REQUIRED_PARAMETERS) {
    if (options.omitParameter === paramRel) continue;
    files.push(await writeOrdinaryFile(xtbRoot, paramRel, `param:${paramRel}\n`, 0o644));
  }

  const libraries =
    options.libraries ??
    (platformId === 'win32-x64' ? contract.WIN32_V1_LIBRARIES : contract.DARWIN_V1_LIBRARIES);
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
        sha256: 'c74161d40083f5acb15ca57a7cbb9c337e21f85c866055c875c04aad63255f6b'
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

test('xtb-runtime-contract platform helpers and validateDescriptor support win32-x64, darwin-arm64, and darwin-x64', () => {
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
    ...contract.REQUIRED_PARAMETERS
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

test('xtbRuntime rejects platform mismatch, missing dylib/dll, missing parameter, symlink, and non-executable binary on macOS', async () => {
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

  // 2. Missing required dylib on darwin-arm64
  const missingDylib = await createPackagedXtbSandbox('darwin-arm64', {
    omitLibrary: 'lib/libgfortran.5.dylib'
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

  // 3. Missing required parameter file
  const missingParam = await createPackagedXtbSandbox('darwin-arm64', {
    omitParameter: 'share/xtb/param_gfn2-xtb.txt'
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

  // 5. Symlinked bin/xtb rejected
  const linked = await createPackagedXtbSandbox('darwin-arm64');
  try {
    const binXtb = path.join(linked.xtbRoot, 'bin/xtb');
    const realCopy = path.join(linked.sandbox, 'real-xtb');
    await fs.copyFile(binXtb, realCopy);
    await fs.unlink(binXtb);
    await fs.symlink(realCopy, binXtb);
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
});

test('xtbRuntime resolves staged development darwin-arm64 runtime when present in workspace', async () => {
  const stagedXtbManifest = path.join(
    ROOT,
    '.local/dependencies/darwin-arm64/conda-chem-arm64/xtb/runtime.json'
  );
  if (process.platform === 'darwin' && process.arch === 'arm64' && fssync.existsSync(stagedXtbManifest)) {
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
  }
});
