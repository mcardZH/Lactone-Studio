import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chemistryRuntime } = require('../../desktop/runtime.cjs');
const { resolvePlatformLayout } = require('../../desktop/current-runtime.cjs');

function makeRealTempDir(prefix) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function writeOwnedFile(root, relPath, content) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  fs.writeFileSync(fullPath, bytes);
  return {
    path: relPath,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function buildMockLockedProject(root, platformId) {
  const layout = resolvePlatformLayout(platformId);
  writeOwnedFile(root, 'scripts/native/dev-runtime.py', '# bootstrap\n');
  writeOwnedFile(root, 'desktop/chemistry/engine.py', '# engine\n');

  const depRoot = `${layout.dependenciesParent}/dep-1`;
  const tcRoot = `${layout.toolchainsParent}/tc-1`;

  const siteRef = writeOwnedFile(root, `${depRoot}/python/site.txt`, 'site-packages');
  const depInvRef = writeOwnedFile(
    root,
    `${depRoot}/inventory.json`,
    JSON.stringify({
      schema: 'sciyue-native-runtime-lock-v1',
      lockId: 'rt-1',
      root: depRoot,
      files: [{ path: 'python/site.txt', bytes: siteRef.bytes, sha256: siteRef.sha256 }]
    })
  );

  const pythonRel = layout.pythonEntries[0];
  const pyEntry = writeOwnedFile(root, `${tcRoot}/${pythonRel}`, 'binary-python');
  const tcFiles = [{ path: pythonRel, bytes: pyEntry.bytes, sha256: pyEntry.sha256 }];
  for (const member of layout.pythonRequiredMembers) {
    const m = writeOwnedFile(root, `${tcRoot}/${member}`, `member:${member}`);
    tcFiles.push({ path: member, bytes: m.bytes, sha256: m.sha256 });
  }

  const xtbMemberNames = [
    layout.xtbEntry,
    'xtb/runtime.json',
    'xtb/share/xtb/param_gfn0-xtb.txt',
    'xtb/share/xtb/param_gfn1-xtb.txt',
    'xtb/share/xtb/param_gfn2-xtb.txt',
    'xtb/share/xtb/.param_gfnff.xtb'
  ];
  const xtbFiles = [];
  for (const name of xtbMemberNames) {
    const content =
      name === 'xtb/runtime.json'
        ? JSON.stringify({
            schema: 'sciyue-xtb-bundled-runtime/v1',
            version: '6.4.1',
            platform: platformId,
            localUseReady: true,
            entry: layout.xtbEntry.replace(/^xtb\//, ''),
            dataDirectory: 'share/xtb'
          })
        : `xtb:${name}`;
    const ref = writeOwnedFile(root, `${depRoot}/${name}`, content);
    xtbFiles.push({ path: name, bytes: ref.bytes, sha256: ref.sha256 });
  }

  const runtimeLockRef = writeOwnedFile(
    root,
    `desktop/packaging/native-runtime.${platformId}.lock.json`,
    JSON.stringify({
      schema: 'sciyue-native-runtime-lock-v1',
      platform: platformId,
      lockId: 'rt-1',
      root: depRoot,
      contentDirectories: ['python'],
      inventory: depInvRef
    })
  );

  const toolchainLockRef = writeOwnedFile(
    root,
    `desktop/packaging/native-toolchain.${platformId}.lock.json`,
    JSON.stringify({
      schema: 'sciyue-native-toolchain-lock-v1',
      platform: platformId,
      lockId: 'tc-1',
      root: tcRoot,
      contentDirectories: ['python'],
      python: pythonRel,
      files: tcFiles
    })
  );

  const xtbLockRef = writeOwnedFile(
    root,
    `desktop/packaging/xtb-runtime.${platformId}.lock.json`,
    JSON.stringify({
      schema: 'sciyue-xtb-lock-v1',
      platform: platformId,
      lockId: 'xtb-1',
      root: depRoot,
      contentDirectories: ['xtb'],
      localUseReady: true,
      entry: layout.xtbEntry,
      dataDirectory: 'xtb/share/xtb',
      files: xtbFiles
    })
  );

  const probeParent =
    platformId === 'win32-x64' ? '.local/preparation/win-x64' : `.local/preparation/${platformId}`;
  const importProbeRef = writeOwnedFile(
    root,
    `${probeParent}/import-probe.json`,
    JSON.stringify({
      schema: 'sciyue-import-probe-v1',
      passed: true,
      scienceExecuted: false,
      platform: platformId,
      runtimeLock: runtimeLockRef,
      toolchainLock: toolchainLockRef,
      xtbLock: xtbLockRef,
      modules: ['ase', 'rdkit', 'scipy', 'spglib', 'tblite']
    })
  );

  const prepRef = writeOwnedFile(
    root,
    `${probeParent}/native-preparation.json`,
    JSON.stringify({
      schema: 'sciyue-native-preparation-v1',
      passed: true,
      scienceExecuted: false,
      runtimeLock: runtimeLockRef,
      toolchainLock: toolchainLockRef,
      xtbLock: xtbLockRef,
      importProbe: importProbeRef
    })
  );

  writeOwnedFile(
    root,
    `desktop/packaging/native-profile.${platformId}.json`,
    JSON.stringify({
      schema: 'sciyue-native-profile-v1',
      platform: platformId,
      runtimeLock: runtimeLockRef.path,
      toolchainLock: toolchainLockRef.path,
      xtbLock: xtbLockRef.path,
      preparation: prepRef
    })
  );

  return {
    pythonExecutablePath: path.join(root, tcRoot, pythonRel),
    bootstrapPath: path.join(root, 'scripts/native/dev-runtime.py'),
    engineDir: path.join(root, 'desktop/chemistry')
  };
}

test('chemistryRuntime resolves packaged engine, SCIYUE_PYTHON override, and locked dev-runtime.py across platforms', () => {
  const tmpDir = makeRealTempDir('es-runtime-cjs-');
  try {
    // 1. Packaged mode: darwin vs win32
    const resDir = path.join(tmpDir, 'resources');
    assert.throws(
      () =>
        chemistryRuntime({
          packaged: true,
          resourcesPath: resDir,
          appPath: tmpDir,
          platform: 'darwin'
        }),
      /BUNDLED_RUNTIME_MISSING/
    );

    writeOwnedFile(resDir, 'chemistry/engine', 'macho-engine');
    writeOwnedFile(resDir, 'chemistry/engine.exe', 'pe-engine');

    const pkgDarwin = chemistryRuntime({
      packaged: true,
      resourcesPath: resDir,
      appPath: tmpDir,
      platform: 'darwin'
    });
    assert.equal(pkgDarwin.executable, path.join(resDir, 'chemistry', 'engine'));
    assert.deepEqual(pkgDarwin.args, []);
    assert.equal(pkgDarwin.bundled, true);

    const pkgWin = chemistryRuntime({
      packaged: true,
      resourcesPath: resDir,
      appPath: tmpDir,
      platform: 'win32'
    });
    assert.equal(pkgWin.executable, path.join(resDir, 'chemistry', 'engine.exe'));
    assert.deepEqual(pkgWin.args, []);
    assert.equal(pkgWin.bundled, true);

    // 2. Missing desktop/chemistry/engine.py in dev mode
    const emptyApp = path.join(tmpDir, 'empty-app');
    fs.mkdirSync(emptyApp, { recursive: true });
    assert.throws(
      () => chemistryRuntime({ packaged: false, appPath: emptyApp, environment: {} }),
      /DEV_ENGINE_MISSING/
    );

    // 3. SCIYUE_PYTHON override validation and execution args
    const overrideApp = path.join(tmpDir, 'override-app');
    writeOwnedFile(overrideApp, 'desktop/chemistry/engine.py', '# engine\n');
    const customPy = path.join(tmpDir, 'custom-python3');
    fs.writeFileSync(customPy, 'custom-py');

    assert.throws(
      () =>
        chemistryRuntime({
          packaged: false,
          appPath: overrideApp,
          environment: { SCIYUE_PYTHON: 'relative/python3' }
        }),
      /DEV_RUNTIME_MISSING: 显式选择的 SCIYUE_PYTHON 不存在/
    );

    const overrideRuntime = chemistryRuntime({
      packaged: false,
      appPath: overrideApp,
      environment: { SCIYUE_PYTHON: customPy }
    });
    assert.equal(overrideRuntime.executable, customPy);
    assert.deepEqual(overrideRuntime.args, ['-B', path.join(overrideApp, 'desktop/chemistry/engine.py')]);
    assert.equal(overrideRuntime.bundled, false);
    assert.equal(overrideRuntime.provenance.source, 'explicit-user-override');
    assert.equal(overrideRuntime.provenance.locked, false);

    // 4. Locked development mode across darwin-arm64, darwin-x64, win32-x64
    for (const platformId of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      const projDir = path.join(tmpDir, `proj-${platformId}`);
      const { pythonExecutablePath, bootstrapPath, engineDir } = buildMockLockedProject(
        projDir,
        platformId
      );
      const rt = chemistryRuntime({
        packaged: false,
        appPath: projDir,
        environment: {},
        platformId
      });
      assert.equal(rt.executable, pythonExecutablePath);
      assert.deepEqual(rt.args, ['-I', '-S', '-B', bootstrapPath]);
      assert.equal(rt.cwd, engineDir);
      assert.equal(rt.bundled, false);
      assert.equal(rt.provenance.locked, true);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
