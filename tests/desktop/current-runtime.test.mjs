import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PLATFORM_LAYOUTS,
  SUPPORTED_PLATFORMS,
  defaultPlatformId,
  resolvePlatformLayout,
  resolveProfile,
  hasUnsafePathDelimiter,
  resolveTrustedWindowsSystemRoot,
  developmentNative,
  developmentXtb,
  currentRuntimeEnvironment,
  packagedBackendInfo
} = require('../../desktop/current-runtime.cjs');

function makeRealTempDir(prefix) {
  const base = fs.realpathSync(os.tmpdir());
  return fs.mkdtempSync(path.join(base, prefix));
}

function createPortableLink(targetPath, linkPath, options = {}) {
  try {
    fs.symlinkSync(targetPath, linkPath);
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'ENOSYS')) {
      const junctionTarget = `${linkPath}-junction-target`;
      fs.mkdirSync(junctionTarget, { recursive: true });
      fs.symlinkSync(junctionTarget, linkPath, 'junction');
      if (options.dangling) {
        fs.rmSync(junctionTarget, { recursive: true, force: true });
      }
      return;
    }
    throw err;
  }
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

function buildMockNativeProject(root, platformId, options = {}) {
  const layout = resolvePlatformLayout(platformId);
  writeOwnedFile(
    root,
    'scripts/native/dev-runtime.py',
    options.devRuntimeSource || '# mock dev-runtime bootstrap\n'
  );
  writeOwnedFile(
    root,
    'desktop/chemistry/engine.py',
    options.engineSource || '# mock engine\n'
  );

  const depLeaf = options.depLeaf || 'dep-lock-1';
  const tcLeaf = options.tcLeaf || 'tc-lock-1';
  const depRoot = `${layout.dependenciesParent}/${depLeaf}`;
  const tcRoot = `${layout.toolchainsParent}/${tcLeaf}`;

  const depFiles = [];
  const depMarker = writeOwnedFile(root, `${depRoot}/python/site.txt`, 'site-packages');
  if (platformId === 'win32-x64') {
    depFiles.push({
      path: 'python/site.txt',
      bytes: depMarker.bytes,
      owner: 'python',
      sha256: depMarker.sha256
    });
  } else {
    depFiles.push({ path: 'python/site.txt', bytes: depMarker.bytes, sha256: depMarker.sha256 });
  }

  if (options.extraFileCount) {
    const pkgDir = path.join(root, depRoot, 'python/pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    const emptySha256 = createHash('sha256').update('').digest('hex');
    const firstContent = options.firstExtraFileContent ?? '';
    const firstBytes = Buffer.byteLength(firstContent, 'utf8');
    const firstSha256 = createHash('sha256').update(firstContent, 'utf8').digest('hex');
    for (let i = 0; i < options.extraFileCount; i += 1) {
      const rel = `python/pkg/mod_${i}.py`;
      if (i === 0 && firstBytes > 0) {
        fs.writeFileSync(path.join(root, depRoot, rel), firstContent, 'utf8');
        depFiles.push({ path: rel, bytes: firstBytes, sha256: firstSha256 });
      } else {
        fs.writeFileSync(path.join(root, depRoot, rel), '');
        depFiles.push({ path: rel, bytes: 0, sha256: emptySha256 });
      }
    }
  }

  if (options.sitePackageModule) {
    const modRef = writeOwnedFile(
      root,
      `${depRoot}/python/lib/python3.12/site-packages/${options.sitePackageModule.name}`,
      options.sitePackageModule.content
    );
    depFiles.push({
      path: `python/lib/python3.12/site-packages/${options.sitePackageModule.name}`,
      bytes: modRef.bytes,
      sha256: modRef.sha256
    });
  }

  const pythonRel = layout.pythonEntries[0];
  const pyEntry = writeOwnedFile(root, `${tcRoot}/${pythonRel}`, 'binary-python');
  const tcFiles = [{ path: pythonRel, bytes: pyEntry.bytes, sha256: pyEntry.sha256 }];

  for (const member of layout.pythonRequiredMembers) {
    const memberInfo = writeOwnedFile(root, `${tcRoot}/${member}`, `member:${member}`);
    tcFiles.push({ path: member, bytes: memberInfo.bytes, sha256: memberInfo.sha256 });
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
        : `xtb-member:${name}`;
    const ref = writeOwnedFile(root, `${depRoot}/${name}`, content);
    xtbFiles.push({ path: name, bytes: ref.bytes, sha256: ref.sha256 });
  }

  const depInvRef = writeOwnedFile(
    root,
    `${depRoot}/inventory.json`,
    JSON.stringify({
      schema: 'sciyue-native-runtime-lock-v1',
      lockId: 'rt-1',
      root: depRoot,
      files: depFiles
    })
  );

  const runtimeLockRel = options.usePlatformSpecificLocks
    ? `desktop/packaging/native-runtime.${platformId}.lock.json`
    : 'desktop/packaging/native-runtime.lock.json';
  const toolchainLockRel = options.usePlatformSpecificLocks
    ? `desktop/packaging/native-toolchain.${platformId}.lock.json`
    : 'desktop/packaging/native-toolchain.lock.json';
  const xtbLockRel = options.usePlatformSpecificLocks
    ? `desktop/packaging/xtb-runtime.${platformId}.lock.json`
    : 'desktop/packaging/xtb-runtime.lock.json';

  const runtimeLockRef = writeOwnedFile(
    root,
    runtimeLockRel,
    JSON.stringify({
      schema: 'sciyue-native-runtime-lock-v1',
      platform: platformId,
      lockId: 'rt-1',
      root: depRoot,
      contentDirectories: options.runtimeContentDirectories ?? ['python'],
      inventory: depInvRef
    })
  );

  const toolchainLockRef = writeOwnedFile(
    root,
    toolchainLockRel,
    JSON.stringify({
      schema: 'sciyue-native-toolchain-lock-v1',
      platform: platformId,
      lockId: 'tc-1',
      root: tcRoot,
      contentDirectories: options.toolchainContentDirectories ?? ['python'],
      python: pythonRel,
      files: tcFiles
    })
  );

  const xtbLockRef = writeOwnedFile(
    root,
    xtbLockRel,
    JSON.stringify({
      schema: 'sciyue-xtb-lock-v1',
      platform: platformId,
      lockId: 'xtb-1',
      root: depRoot,
      contentDirectories: options.xtbContentDirectories ?? ['xtb'],
      localUseReady: options.xtbReady !== undefined ? options.xtbReady : true,
      entry: layout.xtbEntry,
      dataDirectory: 'xtb/share/xtb',
      files: xtbFiles
    })
  );

  const probeParent =
    platformId === 'win32-x64' ? '.local/preparation/win-x64' : `.local/preparation/${platformId}`;
  const defaultProbePayload =
    platformId === 'win32-x64'
      ? {
          schema: 'sciyue-native-import-probe-v1',
          passed: true,
          scienceExecuted: false,
          runtimeLock: runtimeLockRef,
          toolchainLock: toolchainLockRef,
          xtbLock: xtbLockRef,
          packagePaths: {
            rdkit: 'C:/locked/rdkit/__init__.py',
            ase: 'C:/locked/ase/__init__.py',
            spglib: 'C:/locked/spglib/__init__.py',
            scipy: 'C:/locked/scipy/__init__.py',
            'tblite.library': 'C:/locked/tblite/library.py'
          }
        }
      : {
          schema: 'sciyue-import-probe-v1',
          passed: true,
          scienceExecuted: false,
          platform: platformId,
          runtimeLock: runtimeLockRef,
          toolchainLock: toolchainLockRef,
          xtbLock: xtbLockRef,
          modules: ['ase', 'rdkit', 'scipy', 'spglib', 'tblite']
        };
  const importProbeRef = writeOwnedFile(
    root,
    `${probeParent}/import-probe.json`,
    JSON.stringify(options.probePayload || defaultProbePayload)
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

  const profileRel = options.usePlatformSpecificProfile
    ? `desktop/packaging/native-profile.${platformId}.json`
    : 'desktop/packaging/native-profile.json';

  writeOwnedFile(
    root,
    profileRel,
    JSON.stringify({
      schema: 'sciyue-native-profile-v1',
      platform: platformId,
      runtimeLock: runtimeLockRel,
      toolchainLock: toolchainLockRel,
      xtbLock: xtbLockRel,
      preparation: prepRef
    })
  );

  return {
    pythonExecutablePath: path.join(root, tcRoot, pythonRel),
    runtimeLockRef,
    toolchainLockRef,
    xtbLockRef,
    importProbeRef,
    prepRef
  };
}

test('SUPPORTED_PLATFORMS, defaultPlatformId, hasUnsafePathDelimiter, and resolveTrustedWindowsSystemRoot validate platform contracts', () => {
  assert.deepEqual(SUPPORTED_PLATFORMS, ['win32-x64', 'darwin-arm64', 'darwin-x64']);
  assert.equal(defaultPlatformId('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(defaultPlatformId('darwin', 'x64'), 'darwin-x64');
  assert.equal(defaultPlatformId('win32', 'x64'), 'win32-x64');
  assert.throws(() => defaultPlatformId('linux', 'x64'), /Current runtime lock schema\/platform/);
  assert.throws(() => resolvePlatformLayout('linux-x64'), /Current runtime lock schema\/platform/);
  assert.equal(PLATFORM_LAYOUTS['darwin-arm64'].packagedEngineEntry, 'engine');
  assert.equal(PLATFORM_LAYOUTS['win32-x64'].packagedEngineEntry, 'engine.exe');

  assert.equal(hasUnsafePathDelimiter('/Users/dev/Ester-Studio', 'darwin-arm64', 'darwin'), false);
  assert.equal(hasUnsafePathDelimiter('/Users/dev/evil:colon/Ester', 'darwin-arm64', 'darwin'), true);
  assert.equal(hasUnsafePathDelimiter('/Users/dev/evil;semi/Ester', 'darwin-arm64', 'darwin'), true);
  assert.equal(hasUnsafePathDelimiter('C:\\Users\\dev\\Ester-Studio', 'win32-x64', 'darwin'), false);
  assert.equal(hasUnsafePathDelimiter('C:\\Users\\dev\\Ester-Studio', 'darwin-arm64', 'win32'), false);
  assert.equal(hasUnsafePathDelimiter('C:\\Users\\dev\\evil:colon\\Ester', 'win32-x64', 'win32'), true);
  assert.equal(hasUnsafePathDelimiter('C:\\Users\\dev\\evil;semi\\Ester', 'win32-x64', 'win32'), true);

  assert.equal(resolveTrustedWindowsSystemRoot({}, 'darwin'), 'C:\\Windows');
  assert.equal(resolveTrustedWindowsSystemRoot({ SystemRoot: 'D:\\Windows\\' }, 'darwin'), 'D:\\Windows');
  assert.throws(
    () => resolveTrustedWindowsSystemRoot({ SystemRoot: 'C:\\Windows;C:\\evil' }, 'darwin'),
    /Trusted Windows SystemRoot required/
  );
  assert.throws(
    () => resolveTrustedWindowsSystemRoot({ WINDIR: 'relative\\Windows' }, 'darwin'),
    /Trusted Windows SystemRoot required/
  );
  assert.throws(
    () => resolveTrustedWindowsSystemRoot({ SystemRoot: 'C:\\NotSystemRoot' }, 'darwin'),
    /Trusted Windows SystemRoot required/
  );
  assert.throws(
    () => resolveTrustedWindowsSystemRoot({ SystemRoot: 'C:\\Users\\attacker\\Windows' }, 'darwin'),
    /Trusted Windows SystemRoot required/
  );
  assert.throws(
    () => resolveTrustedWindowsSystemRoot({ SystemRoot: 'C:\\Windows\\..\\attacker\\Windows' }, 'darwin'),
    /Trusted Windows SystemRoot required/
  );
});

test('developmentNative, developmentXtb, and currentRuntimeEnvironment support darwin-arm64, darwin-x64, and win32-x64 and reject incomplete or mismatched probes', () => {
  for (const platformId of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const tmpDir = makeRealTempDir(`es-rt-${platformId}-`);
    try {
      const { pythonExecutablePath, runtimeLockRef, toolchainLockRef, xtbLockRef } =
        buildMockNativeProject(tmpDir, platformId, {
          usePlatformSpecificProfile: platformId !== 'win32-x64',
          usePlatformSpecificLocks: platformId !== 'win32-x64'
        });

      const nativeRes = developmentNative(tmpDir, { platformId });
      assert.equal(nativeRes.platform, platformId);
      assert.equal(nativeRes.executable, pythonExecutablePath);
      assert.equal(nativeRes.provenance.locked, true);

      const xtbRes = developmentXtb(tmpDir, { platformId });
      assert.equal(path.basename(xtbRes.root), 'xtb');

      // Mutating a tracked runtime file with equal-length content MUST invalidate warm snapshot and throw identity error
      const layout = resolvePlatformLayout(platformId);
      const siteFile = path.join(tmpDir, layout.dependenciesParent, 'dep-lock-1/python/site.txt');
      const originalSite = fs.readFileSync(siteFile);
      fs.writeFileSync(siteFile, 'evil-packages');
      assert.throws(
        () => developmentNative(tmpDir, { platformId }),
        /Current runtime identity differs/
      );
      fs.writeFileSync(siteFile, originalSite);

      const envVars = currentRuntimeEnvironment({
        packaged: false,
        appPath: tmpDir,
        executable: pythonExecutablePath,
        platformId,
        environment: {
          CONDA_PREFIX: '/opt/anaconda3',
          PYTHONPATH: '/bad/path',
          PYTHONPLATLIBDIR: '/bad/platlib',
          _PYTHON_HOST_PLATFORM: 'darwin-arm64',
          DYLD_LIBRARY_PATH: '/bad/dyld',
          DYLD_INSERT_LIBRARIES: '/bad/inject.dylib',
          LD_LIBRARY_PATH: '/bad/ld',
          RDBASE: '/bad/external/rdbase'
        }
      });
      const expectedDelim = platformId === 'win32-x64' ? ';' : ':';
      assert.ok(typeof envVars.PATH === 'string' && envVars.PATH.includes(expectedDelim));
      assert.equal(envVars.CONDA_PREFIX, undefined);
      assert.equal(envVars.PYTHONPATH, undefined);
      assert.equal(envVars.PYTHONPLATLIBDIR, undefined);
      assert.equal(envVars._PYTHON_HOST_PLATFORM, undefined);
      assert.equal(envVars.DYLD_LIBRARY_PATH, undefined);
      assert.equal(envVars.DYLD_INSERT_LIBRARIES, undefined);
      assert.equal(envVars.LD_LIBRARY_PATH, undefined);
      assert.equal(envVars.RDBASE, undefined);
      assert.equal(envVars.PYTHONNOUSERSITE, '1');
      assert.equal(envVars.PYTHONDONTWRITEBYTECODE, '1');
      if (platformId.startsWith('darwin-')) {
        assert.ok(
          typeof envVars.DYLD_FALLBACK_LIBRARY_PATH === 'string' &&
            envVars.DYLD_FALLBACK_LIBRARY_PATH.includes(path.join('python', 'lib'))
        );
      }

      if (platformId === 'win32-x64') {
        assert.throws(
          () =>
            currentRuntimeEnvironment({
              packaged: false,
              appPath: tmpDir,
              executable: pythonExecutablePath,
              platformId: 'win32-x64',
              environment: { SystemRoot: 'C:\\Windows;C:\\Injected' }
            }),
          /Trusted Windows SystemRoot required/
        );
      }

      if (platformId === 'darwin-arm64') {
        const spoofedDir = makeRealTempDir('es-spoofed-probe-');
        try {
          buildMockNativeProject(spoofedDir, 'darwin-arm64', {
            usePlatformSpecificProfile: true,
            probePayload: {
              schema: 'sciyue-import-probe-v1',
              passed: true,
              scienceExecuted: false,
              platform: 'win32-x64',
              runtimeLock: runtimeLockRef,
              toolchainLock: toolchainLockRef,
              xtbLock: xtbLockRef,
              modules: ['ase', 'rdkit', 'scipy', 'spglib', 'tblite']
            }
          });
          assert.throws(
            () => developmentNative(spoofedDir, { platformId: 'darwin-arm64' }),
            /Prepared current import probe required/
          );
        } finally {
          fs.rmSync(spoofedDir, { recursive: true, force: true });
        }

        const staleProbeDir = makeRealTempDir('es-stale-probe-');
        try {
          buildMockNativeProject(staleProbeDir, 'darwin-arm64', {
            usePlatformSpecificProfile: true,
            probePayload: {
              schema: 'sciyue-import-probe-v1',
              passed: true,
              scienceExecuted: false,
              platform: 'darwin-arm64',
              runtimeLock: { ...runtimeLockRef, sha256: '0'.repeat(64) },
              toolchainLock: toolchainLockRef,
              xtbLock: xtbLockRef,
              modules: ['ase', 'rdkit', 'scipy', 'spglib', 'tblite']
            }
          });
          assert.throws(
            () => developmentNative(staleProbeDir, { platformId: 'darwin-arm64' }),
            /Prepared current import probe runtimeLock mismatch/
          );
        } finally {
          fs.rmSync(staleProbeDir, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Incomplete import-probe.json (missing required modules) or unready xTB lock MUST be rejected
  const badProbeDir = makeRealTempDir('es-bad-probe-');
  try {
    const { pythonExecutablePath } = buildMockNativeProject(badProbeDir, 'darwin-arm64', {
      usePlatformSpecificProfile: true,
      xtbReady: false
    });
    assert.ok(pythonExecutablePath);
    const probeRel = '.local/preparation/darwin-arm64/import-probe.json';
    const existingProbe = JSON.parse(fs.readFileSync(path.join(badProbeDir, probeRel), 'utf8'));
    existingProbe.modules = ['rdkit'];
    const newProbeRef = writeOwnedFile(
      badProbeDir,
      probeRel,
      JSON.stringify(existingProbe, null, 2)
    );
    const prepRel = '.local/preparation/darwin-arm64/native-preparation.json';
    const existingPrep = JSON.parse(fs.readFileSync(path.join(badProbeDir, prepRel), 'utf8'));
    existingPrep.importProbe = newProbeRef;
    const newPrepRef = writeOwnedFile(badProbeDir, prepRel, JSON.stringify(existingPrep, null, 2));
    const profRel = 'desktop/packaging/native-profile.darwin-arm64.json';
    const existingProf = JSON.parse(fs.readFileSync(path.join(badProbeDir, profRel), 'utf8'));
    existingProf.preparation = newPrepRef;
    writeOwnedFile(badProbeDir, profRel, JSON.stringify(existingProf, null, 2));

    assert.throws(
      () => developmentNative(badProbeDir, { platformId: 'darwin-arm64' }),
      /Prepared current import probe missing required module/
    );

    // Fix probe modules so verifyPreparedLocks passes, then verify developmentXtb rejects unready xTB lock
    existingProbe.modules = ['ase', 'rdkit', 'scipy', 'spglib', 'tblite'];
    const readyProbeRef = writeOwnedFile(
      badProbeDir,
      probeRel,
      JSON.stringify(existingProbe, null, 2)
    );
    existingPrep.importProbe = readyProbeRef;
    const readyPrepRef = writeOwnedFile(
      badProbeDir,
      prepRel,
      JSON.stringify(existingPrep, null, 2)
    );
    existingProf.preparation = readyPrepRef;
    writeOwnedFile(badProbeDir, profRel, JSON.stringify(existingProf, null, 2));

    assert.throws(
      () => developmentXtb(badProbeDir, { platformId: 'darwin-arm64' }),
      /Current xTB lock must be explicitly ready/
    );
  } finally {
    fs.rmSync(badProbeDir, { recursive: true, force: true });
  }
});

test('packagedBackendInfo enforces platform-specific entry binary (engine vs engine.exe)', () => {
  for (const [platform, expectedEntry, wrongEntry] of [
    ['darwin', 'engine', 'engine.exe'],
    ['win32', 'engine.exe', 'engine']
  ]) {
    const tmpDir = makeRealTempDir(`es-pkg-${platform}-`);
    try {
      const resourcesPath = path.join(tmpDir, 'resources');
      const provenanceRoot = path.join(tmpDir, 'provenance');
      const expectedRef = writeOwnedFile(
        resourcesPath,
        `chemistry/${expectedEntry}`,
        `compiled-${expectedEntry}`
      );
      const wrongRef = writeOwnedFile(
        resourcesPath,
        `chemistry/${wrongEntry}`,
        `compiled-${wrongEntry}`
      );

      writeOwnedFile(
        provenanceRoot,
        'dependencies.json',
        JSON.stringify({
          schema: 'sciyue-portable-dependency-summary/v1',
          native: {
            backend: 'OpenBLAS',
            entry: {
              path: expectedEntry,
              bytes: expectedRef.bytes,
              sha256: expectedRef.sha256
            },
            origin: {
              candidateReceiptSha256: 'a'.repeat(64),
              buildContractSha256: 'b'.repeat(64)
            }
          }
        })
      );

      const info = packagedBackendInfo({
        packaged: true,
        resourcesPath,
        provenanceRoot,
        platform
      });
      assert.equal(info.verified, true);
      assert.equal(info.name, 'openblas');

      writeOwnedFile(
        provenanceRoot,
        'dependencies.json',
        JSON.stringify({
          schema: 'sciyue-portable-dependency-summary/v1',
          native: {
            backend: 'OpenBLAS',
            entry: {
              path: wrongEntry,
              bytes: wrongRef.bytes,
              sha256: wrongRef.sha256
            },
            origin: {
              candidateReceiptSha256: 'a'.repeat(64),
              buildContractSha256: 'b'.repeat(64)
            }
          }
        })
      );
      const wrongInfo = packagedBackendInfo({
        packaged: true,
        resourcesPath,
        provenanceRoot,
        platform
      });
      assert.equal(wrongInfo.verified, false);
      assert.equal(wrongInfo.name, 'unknown');
      assert.equal(wrongInfo.source, 'missing-or-invalid-package-provenance');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
});

test('verifyNativeInventory warm cache handles >16384 files without cache thrashing on single-file touch', () => {
  const fixturePlatformId = 'darwin-arm64';
  const tmpDir = makeRealTempDir('es-warm-cache-16k-');
  try {
    const { pythonExecutablePath } = buildMockNativeProject(tmpDir, fixturePlatformId, {
      usePlatformSpecificProfile: true,
      extraFileCount: 16505,
      firstExtraFileContent: 'VALUE = "AAAA"\n'
    });

    const first = developmentNative(tmpDir, { platformId: fixturePlatformId });
    assert.equal(first.platform, fixturePlatformId);

    let warmOpenCount = 0;
    const origOpenSync = fs.openSync;
    let envVars;
    fs.openSync = function (...args) {
      warmOpenCount += 1;
      return origOpenSync.apply(this, args);
    };
    try {
      envVars = currentRuntimeEnvironment({
        packaged: false,
        appPath: tmpDir,
        executable: pythonExecutablePath,
        platformId: fixturePlatformId,
        environment: process.env
      });
    } finally {
      fs.openSync = origOpenSync;
    }
    assert.equal(envVars.PYTHONDONTWRITEBYTECODE, '1');
    assert.equal(
      warmOpenCount,
      0,
      `Expected warm currentRuntimeEnvironment to open 0 files, got ${warmOpenCount}`
    );

    const layout = resolvePlatformLayout(fixturePlatformId);
    const depRootDir = path.resolve(tmpDir, layout.dependenciesParent, 'dep-lock-1');
    const tcRootDir = path.resolve(tmpDir, layout.toolchainsParent, 'tc-lock-1');
    const mod0 = path.join(depRootDir, 'python/pkg/mod_0.py');
    const futureTime = new Date(Date.now() + 10000);
    fs.utimesSync(mod0, futureTime, futureTime);

    const openedMemberFiles = [];
    fs.openSync = function (...args) {
      const openedPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
      if (
        (openedPath.startsWith(`${depRootDir}${path.sep}`) &&
          openedPath !== path.join(depRootDir, 'inventory.json')) ||
        openedPath.startsWith(`${tcRootDir}${path.sep}`)
      ) {
        openedMemberFiles.push(openedPath);
      }
      return origOpenSync.apply(this, args);
    };
    try {
      currentRuntimeEnvironment({
        packaged: false,
        appPath: tmpDir,
        executable: pythonExecutablePath,
        platformId: fixturePlatformId,
        environment: process.env
      });
    } finally {
      fs.openSync = origOpenSync;
    }
    assert.deepEqual(openedMemberFiles, [path.resolve(mod0)]);

    // Equal-length content tamper (both 'VALUE = "AAAA"\n' and 'VALUE = "BBBB"\n' are 15 bytes)
    fs.writeFileSync(mod0, 'VALUE = "BBBB"\n');
    assert.throws(
      () =>
        currentRuntimeEnvironment({
          packaged: false,
          appPath: tmpDir,
          executable: pythonExecutablePath,
          platformId: fixturePlatformId,
          environment: process.env
        }),
      /Current runtime identity differs/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('security contracts: dev-runtime.py admission, dangling profile symlink, empty/narrow contentDirectories, xTB lock binding, and path delimiters', () => {
  const tmpDir = makeRealTempDir('es-security-contracts-');
  const extDir = makeRealTempDir('es-external-swap-');
  try {
    // 1. Platform-specific profile priority & dangling symlink rejection
    buildMockNativeProject(tmpDir, 'win32-x64', {
      usePlatformSpecificProfile: true,
      usePlatformSpecificLocks: true
    });
    writeOwnedFile(
      tmpDir,
      'desktop/packaging/native-profile.json',
      JSON.stringify({
        schema: 'sciyue-native-profile-v1',
        platform: 'win32-x64',
        runtimeLock: 'desktop/packaging/nonexistent.lock.json',
        toolchainLock: 'desktop/packaging/native-toolchain.lock.json',
        xtbLock: 'desktop/packaging/xtb-runtime.lock.json'
      })
    );
    const chosenProfile = resolveProfile(tmpDir, 'win32-x64');
    assert.equal(chosenProfile.profileRel, 'desktop/packaging/native-profile.win32-x64.json');
    const resolvedWin = developmentNative(tmpDir, { platformId: 'win32-x64' });
    assert.equal(
      resolvedWin.provenance.runtimeLock.path,
      'desktop/packaging/native-runtime.win32-x64.lock.json'
    );

    // Replace native-profile.win32-x64.json with a dangling symlink/junction: MUST fail with Linked current runtime input, NOT fall back to native-profile.json
    const winProfPath = path.join(tmpDir, 'desktop/packaging/native-profile.win32-x64.json');
    fs.unlinkSync(winProfPath);
    createPortableLink(path.join(extDir, 'nonexistent-target.json'), winProfPath, {
      dangling: true
    });
    assert.throws(
      () => developmentNative(tmpDir, { platformId: 'win32-x64' }),
      /Linked current runtime input/
    );

    // 2. scripts/native/dev-runtime.py admission: missing, symlink, parent symlink, and hardlink (nlink > 1) MUST be rejected
    const devPyDir = path.join(tmpDir, 'dev-py-checks');
    buildMockNativeProject(devPyDir, 'darwin-arm64', { usePlatformSpecificProfile: true });
    const devPyPath = path.join(devPyDir, 'scripts/native/dev-runtime.py');
    const devPyBackup = fs.readFileSync(devPyPath);

    // 2a. Missing file
    fs.unlinkSync(devPyPath);
    assert.throws(
      () => developmentNative(devPyDir, { platformId: 'darwin-arm64' }),
      /ENOENT/
    );

    // 2b. Symlinked file
    const extScript = path.join(extDir, 'ext-dev-runtime.py');
    fs.writeFileSync(extScript, devPyBackup);
    createPortableLink(extScript, devPyPath);
    assert.throws(
      () => developmentNative(devPyDir, { platformId: 'darwin-arm64' }),
      /Linked current runtime input/
    );
    fs.rmSync(devPyPath, { recursive: true, force: true });
    fs.writeFileSync(devPyPath, devPyBackup);

    // 2c. Hardlinked file (nlink > 1)
    const hardlinkPath = path.join(devPyDir, 'scripts/native/dev-runtime-hardlink.py');
    fs.linkSync(devPyPath, hardlinkPath);
    assert.throws(
      () => developmentNative(devPyDir, { platformId: 'darwin-arm64' }),
      /Current runtime requires an ordinary owned input/
    );
    fs.unlinkSync(hardlinkPath);

    // 2d. Symlinked parent directory (scripts/native)
    const nativeDir = path.join(devPyDir, 'scripts/native');
    const movedNativeDir = path.join(extDir, 'moved-native');
    fs.renameSync(nativeDir, movedNativeDir);
    fs.symlinkSync(movedNativeDir, nativeDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => developmentNative(devPyDir, { platformId: 'darwin-arm64' }),
      /Linked current runtime input/
    );

    // 3. Explicit non-empty contentDirectories requirement (reject empty array [] or non-array)
    const emptyContentDir = path.join(tmpDir, 'empty-content-dirs');
    buildMockNativeProject(emptyContentDir, 'darwin-arm64', {
      usePlatformSpecificProfile: true,
      runtimeContentDirectories: []
    });
    assert.throws(
      () => developmentNative(emptyContentDir, { platformId: 'darwin-arm64' }),
      /Explicit current runtime contentDirectories required/
    );

    // 4. Narrow contentDirectories that covers python/bin but only covers a subdirectory of python/lib,
    // with an untracked dylib injected into python/lib MUST fail specifically on python/lib coverage
    const narrowLibDir = path.join(tmpDir, 'narrow-lib-darwin');
    buildMockNativeProject(narrowLibDir, 'darwin-arm64', {
      usePlatformSpecificProfile: true,
      runtimeContentDirectories: ['python/bin', 'python/lib/python3.12/site-packages'],
      sitePackageModule: { name: 'ok_mod.py', content: 'OK = 1\n' }
    });
    writeOwnedFile(
      narrowLibDir,
      '.local/dependencies/darwin-arm64/dep-lock-1/python/bin/marker',
      'bin'
    );
    writeOwnedFile(
      narrowLibDir,
      '.local/dependencies/darwin-arm64/dep-lock-1/python/lib/untracked.dylib',
      'evil-dylib'
    );
    assert.throws(
      () => developmentNative(narrowLibDir, { platformId: 'darwin-arm64' }),
      /Current runtime search directory outside declared content: python\/lib/
    );

    // 5. developmentXtb lock binding & delimiter checks:
    // 5a. When profile.preparation is present, modifying xtb-runtime.lock.json without updating preparation.json / import-probe.json MUST be rejected by developmentXtb;
    // when profile.preparation is omitted (as in main's native-profile.json), standalone developmentXtb succeeds while developmentNative requires preparation.
    const xtbStaleDir = path.join(tmpDir, 'xtb-stale');
    buildMockNativeProject(xtbStaleDir, 'darwin-arm64', { usePlatformSpecificProfile: true });
    const xtbLockPath = path.join(xtbStaleDir, 'desktop/packaging/xtb-runtime.lock.json');
    const xtbLockDoc = JSON.parse(fs.readFileSync(xtbLockPath, 'utf8'));
    xtbLockDoc.lockId = 'tampered-xtb-id';
    writeOwnedFile(
      xtbStaleDir,
      'desktop/packaging/xtb-runtime.lock.json',
      JSON.stringify(xtbLockDoc, null, 2)
    );
    assert.throws(
      () => developmentXtb(xtbStaleDir, { platformId: 'darwin-arm64' }),
      /ERR_ASSERTION/
    );

    const staleProfPath = path.join(
      xtbStaleDir,
      'desktop/packaging/native-profile.darwin-arm64.json'
    );
    const staleProfDoc = JSON.parse(fs.readFileSync(staleProfPath, 'utf8'));
    delete staleProfDoc.preparation;
    fs.writeFileSync(staleProfPath, JSON.stringify(staleProfDoc, null, 2));
    const standaloneXtb = developmentXtb(xtbStaleDir, { platformId: 'darwin-arm64' });
    assert.equal(standaloneXtb.lock.path, 'desktop/packaging/xtb-runtime.lock.json');
    assert.throws(
      () => developmentNative(xtbStaleDir, { platformId: 'darwin-arm64' }),
      /Exact current runtime reference required/
    );

    // 5b. Invalid xtbLock path in profile MUST be rejected by developmentXtb even when preparation is omitted (no fallback to default lock)
    const xtbBadProfDir = path.join(tmpDir, 'xtb-bad-prof');
    buildMockNativeProject(xtbBadProfDir, 'darwin-arm64', { usePlatformSpecificProfile: true });
    const badProfFile = path.join(
      xtbBadProfDir,
      'desktop/packaging/native-profile.darwin-arm64.json'
    );
    const badProfDoc = JSON.parse(fs.readFileSync(badProfFile, 'utf8'));
    delete badProfDoc.preparation;
    badProfDoc.xtbLock = 'desktop/packaging/illegal-xtb.lock.json';
    fs.writeFileSync(badProfFile, JSON.stringify(badProfDoc, null, 2));
    assert.throws(
      () => developmentXtb(xtbBadProfDir, { platformId: 'darwin-arm64' }),
      /Fixed current native profile required/
    );

    // 5c. Lock root containing ';' in developmentXtb MUST be rejected with Current runtime path contains unsafe delimiter
    const xtbSemiRootDir = path.join(tmpDir, 'xtb-semi-root');
    buildMockNativeProject(xtbSemiRootDir, 'win32-x64', {
      usePlatformSpecificProfile: true,
      depLeaf: 'dep;evil'
    });
    assert.throws(
      () => developmentXtb(xtbSemiRootDir, { platformId: 'win32-x64' }),
      /Current runtime path contains unsafe delimiter/
    );

    // 6. Warm-cache parent directory symlink/junction swap MUST be rejected on warm cache check
    const swapDir = path.join(tmpDir, 'swap-darwin');
    buildMockNativeProject(swapDir, 'darwin-arm64', { usePlatformSpecificProfile: true });
    const coldOk = developmentNative(swapDir, { platformId: 'darwin-arm64' });
    assert.equal(coldOk.platform, 'darwin-arm64');

    const origPyDir = path.join(
      swapDir,
      '.local/dependencies/darwin-arm64/dep-lock-1/python'
    );
    const movedPyDir = path.join(extDir, 'moved-python');
    fs.renameSync(origPyDir, movedPyDir);
    fs.symlinkSync(movedPyDir, origPyDir, process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(
      () => developmentNative(swapDir, { platformId: 'darwin-arm64' }),
      /Linked current runtime input/
    );

    // 7. Project path containing path delimiter (';' on all platforms, ':' on POSIX) MUST be rejected
    const semiDir = path.join(tmpDir, 'evil;semi-project');
    const { pythonExecutablePath: semiPy } = buildMockNativeProject(semiDir, 'darwin-arm64', {
      usePlatformSpecificProfile: true
    });
    assert.throws(
      () => developmentNative(semiDir, { platformId: 'darwin-arm64' }),
      /Current runtime path contains unsafe delimiter/
    );
    assert.throws(
      () =>
        currentRuntimeEnvironment({
          packaged: false,
          appPath: semiDir,
          executable: semiPy,
          platformId: 'darwin-arm64',
          environment: {}
        }),
      /Current runtime path contains unsafe delimiter/
    );

    if (process.platform !== 'win32') {
      const colonDir = path.join(tmpDir, 'evil:colon-project');
      const { pythonExecutablePath: colonPy } = buildMockNativeProject(colonDir, 'darwin-arm64', {
        usePlatformSpecificProfile: true
      });
      assert.throws(
        () => developmentNative(colonDir, { platformId: 'darwin-arm64' }),
        /Current runtime path contains unsafe delimiter/
      );
      assert.throws(
        () =>
          currentRuntimeEnvironment({
            packaged: false,
            appPath: colonDir,
            executable: colonPy,
            platformId: 'darwin-arm64',
            environment: {}
          }),
        /Current runtime path contains unsafe delimiter/
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(extDir, { recursive: true, force: true });
  }
});
