import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  CANONICAL_LOCKED_PREFIX,
  XTB_REQUIRED_DYLIBS,
  XTB_REQUIRED_PARAMS,
  buildInventoryFiles,
  replaceMachOPrefixSlots,
  stageDarwinRuntime,
  resolveDefaultCondaPrefix,
  verifyMachOArchitecture,
  verifyTreeReadOnly,
  makeDirectoryTreeWritable
} from '../../scripts/native/stage-darwin-runtime.mjs';

const require = createRequire(import.meta.url);
const {
  developmentNative,
  developmentXtb,
  currentRuntimeEnvironment
} = require('../../desktop/current-runtime.cjs');

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const REAL_DEV_BOOTSTRAP = fs.readFileSync(
  path.join(REPO_ROOT, 'scripts/native/dev-runtime.py'),
  'utf8'
);

const MINIMAL_STDLIB_REL_PATHS = [
  'lib/python3.12/__future__.py',
  'lib/python3.12/threading.py',
  'lib/python3.12/os.py',
  'lib/python3.12/stat.py',
  'lib/python3.12/_collections_abc.py',
  'lib/python3.12/posixpath.py',
  'lib/python3.12/genericpath.py',
  'lib/python3.12/abc.py',
  'lib/python3.12/codecs.py',
  'lib/python3.12/io.py',
  'lib/python3.12/_sitebuiltins.py',
  'lib/python3.12/site.py',
  'lib/python3.12/sysconfig.py',
  'lib/python3.12/_osx_support.py',
  'lib/python3.12/_sysconfigdata__darwin_darwin.py',
  'lib/python3.12/types.py',
  'lib/python3.12/enum.py',
  'lib/python3.12/functools.py',
  'lib/python3.12/operator.py',
  'lib/python3.12/keyword.py',
  'lib/python3.12/reprlib.py',
  'lib/python3.12/warnings.py',
  'lib/python3.12/linecache.py',
  'lib/python3.12/tokenize.py',
  'lib/python3.12/token.py',
  'lib/python3.12/re/__init__.py',
  'lib/python3.12/re/_compiler.py',
  'lib/python3.12/re/_constants.py',
  'lib/python3.12/re/_parser.py',
  'lib/python3.12/re/_casefix.py',
  'lib/python3.12/sre_compile.py',
  'lib/python3.12/sre_parse.py',
  'lib/python3.12/sre_constants.py',
  'lib/python3.12/copyreg.py',
  'lib/python3.12/pathlib.py',
  'lib/python3.12/fnmatch.py',
  'lib/python3.12/ntpath.py',
  'lib/python3.12/errno.py',
  'lib/python3.12/urllib/__init__.py',
  'lib/python3.12/urllib/parse.py',
  'lib/python3.12/ipaddress.py',
  'lib/python3.12/json/__init__.py',
  'lib/python3.12/json/decoder.py',
  'lib/python3.12/json/encoder.py',
  'lib/python3.12/json/scanner.py',
  'lib/python3.12/runpy.py',
  'lib/python3.12/pkgutil.py',
  'lib/python3.12/weakref.py',
  'lib/python3.12/_weakrefset.py',
  'lib/python3.12/collections/__init__.py',
  'lib/python3.12/collections/abc.py',
  'lib/python3.12/contextlib.py',
  'lib/python3.12/importlib/__init__.py',
  'lib/python3.12/importlib/_bootstrap.py',
  'lib/python3.12/importlib/_bootstrap_external.py',
  'lib/python3.12/importlib/machinery.py',
  'lib/python3.12/importlib/util.py',
  'lib/python3.12/importlib/_abc.py',
  'lib/python3.12/importlib/abc.py',
  'lib/python3.12/importlib/resources/__init__.py',
  'lib/python3.12/importlib/resources/_common.py',
  'lib/python3.12/importlib/resources/_adapters.py',
  'lib/python3.12/importlib/resources/abc.py',
  'lib/python3.12/typing.py',
  'lib/python3.12/inspect.py',
  'lib/python3.12/dis.py',
  'lib/python3.12/opcode.py',
  'lib/python3.12/ast.py',
  'lib/python3.12/encodings/__init__.py',
  'lib/python3.12/encodings/aliases.py',
  'lib/python3.12/encodings/utf_8.py',
  'lib/python3.12/encodings/ascii.py',
  'lib/python3.12/encodings/latin_1.py',
  'lib/python3.12/lib-dynload/_json.cpython-312-darwin.so',
  'lib/python3.12/lib-dynload/_struct.cpython-312-darwin.so',
  'lib/python3.12/lib-dynload/math.cpython-312-darwin.so'
];

function ensureRepoSourcesAvailable() {
  const tcPythonDir = path.join(
    REPO_ROOT,
    '.local/toolchains/darwin-arm64/conda-py312-arm64/python'
  );
  const depDir = path.join(REPO_ROOT, '.local/dependencies/darwin-arm64/conda-chem-arm64');
  if (
    process.platform === 'darwin' &&
    (!fs.existsSync(path.join(tcPythonDir, 'bin/python3')) ||
      !fs.existsSync(path.join(depDir, 'xtb/bin/xtb')))
  ) {
    const condaPrefix = resolveDefaultCondaPrefix();
    assert.ok(condaPrefix, 'Expected either staged .local or dedicated ester-studio Conda environment');
    stageDarwinRuntime({ appPath: REPO_ROOT, platformId: 'darwin-arm64', condaPrefix });
  }
  return { tcPythonDir, depDir };
}

function embedPrefixIntoMachO(filePath, newPrefix) {
  execFileSync('codesign', ['--remove-signature', filePath], { stdio: 'ignore' });
  const buf = fs.readFileSync(filePath);
  for (const needleStr of [CANONICAL_LOCKED_PREFIX, '/opt/anaconda3/envs/ester-studio']) {
    const needle = Buffer.from(needleStr, 'utf8');
    let pos = 0;
    while ((pos = buf.indexOf(needle, pos)) !== -1) {
      let strStart = pos;
      while (strStart > 0 && buf[strStart - 1] !== 0) strStart -= 1;
      let strEnd = pos;
      while (strEnd < buf.length && buf[strEnd] !== 0) strEnd += 1;
      let nulEnd = strEnd;
      while (nulEnd < buf.length && buf[nulEnd] === 0) nulEnd += 1;
      const origStr = buf.subarray(strStart, strEnd).toString('utf8');
      const nextStr = origStr.split(needleStr).join(newPrefix);
      const nextBuf = Buffer.from(nextStr, 'utf8');
      if (nextBuf.length < nulEnd - strStart) {
        buf.fill(0, strStart, nulEnd);
        nextBuf.copy(buf, strStart);
      }
      pos = nulEnd;
    }
  }
  fs.writeFileSync(filePath, buf);
  execFileSync('codesign', ['-s', '-', '-f', '-i', path.basename(filePath), filePath], {
    stdio: 'ignore'
  });
}

function buildMockCondaPrefix(condaDir, tcPythonDir, depDir, options = {}) {
  const copyFlag = fs.constants.COPYFILE_FICLONE || 0;
  const binFiles = ['bin/python3'];
  const libDylibs = ['lib/libpython3.12.dylib', 'lib/libintl.8.dylib', 'lib/libiconv.2.dylib'];
  for (const rel of [...binFiles, ...libDylibs, ...MINIMAL_STDLIB_REL_PATHS]) {
    const src = path.join(tcPythonDir, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(condaDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(fs.realpathSync(src), dst, copyFlag);
    fs.chmodSync(dst, rel.startsWith('bin/') ? 0o755 : 0o644);
  }

  // Embed condaDir into python3 Mach-O and _sysconfigdata__darwin_darwin.py to test prefix relocation
  embedPrefixIntoMachO(path.join(condaDir, 'bin/python3'), condaDir);
  const sysconfigFile = path.join(condaDir, 'lib/python3.12/_sysconfigdata__darwin_darwin.py');
  fs.writeFileSync(
    sysconfigFile,
    `build_time_vars = {'prefix': '${condaDir}', 'INCLUDEPY': '${condaDir}/include/python3.12'}\n`,
    'utf8'
  );
  // Seed a .orig file in stdlib to verify it is excluded
  fs.writeFileSync(`${sysconfigFile}.orig`, 'orig-backup\n', 'utf8');

  const siteDir = path.join(condaDir, 'lib/python3.12/site-packages');
  fs.mkdirSync(path.join(siteDir, 'rdkit/__pycache__'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'rdkit/__pycache__/stale.pyc'), 'pyc');

  // Create symlinked rdkit/__init__.py, RDConfig.py, and prefix-dependent RDPaths.py
  const realInit = path.join(condaDir, 'real_rdkit_init.py');
  fs.writeFileSync(realInit, `VERSION = ${JSON.stringify(options.rdkitVersion || 'mock-rdkit')}\n`, 'utf8');
  fs.symlinkSync(realInit, path.join(siteDir, 'rdkit/__init__.py'));
  fs.writeFileSync(
    path.join(siteDir, 'rdkit/RDPaths.py'),
    [
      'import os',
      `RDDataDir = '${condaDir}/share/RDKit/Data'`,
      `_share = '${condaDir}/share/RDKit'`
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(siteDir, 'rdkit/RDConfig.py'),
    [
      'import os',
      'if "RDBASE" in os.environ:',
      '    RDBaseDir = os.environ["RDBASE"]',
      '    RDDataDir = os.path.join(RDBaseDir, "Data")',
      'else:',
      '    import rdkit.RDPaths',
      '    from rdkit.RDPaths import *',
      '    os.environ["RDBASE"] = rdkit.RDPaths._share'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(path.join(siteDir, 'rdkit/CTestTestfile.cmake'), `subdirs("${condaDir}")\n`, 'utf8');

  // Create share/RDKit/Data/Salts.txt in condaDir
  const rdkitDataDir = path.join(condaDir, 'share/RDKit/Data');
  fs.mkdirSync(rdkitDataDir, { recursive: true });
  fs.writeFileSync(path.join(rdkitDataDir, 'Salts.txt'), '// Mock RDKit Salts\nCl\tChloride\n', 'utf8');
  fs.writeFileSync(path.join(condaDir, 'share/RDKit/README.md'), '# RDKit\n', 'utf8');
  fs.writeFileSync(path.join(condaDir, 'share/RDKit/license.txt'), 'BSD-3-Clause\n', 'utf8');

  // Create required scientific packages and submodules: rdkit.Chem.AllChem, ase.build, spglib, tblite.interface, scipy.{linalg,optimize,spatial}
  fs.mkdirSync(path.join(siteDir, 'rdkit/Chem'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'rdkit/Chem/__init__.py'), '__all__ = ["AllChem"]\n', 'utf8');
  fs.writeFileSync(path.join(siteDir, 'rdkit/Chem/AllChem.py'), 'ETKDG = True\n', 'utf8');

  const otherModules = options.omitScipy ? ['ase', 'spglib', 'tblite'] : ['ase', 'spglib', 'tblite', 'scipy'];
  for (const modName of otherModules) {
    fs.mkdirSync(path.join(siteDir, modName), { recursive: true });
    fs.writeFileSync(
      path.join(siteDir, modName, '__init__.py'),
      `__version__ = "1.0.0"\nBUILD_PREFIX = "${condaDir}"\n`,
      'utf8'
    );
  }
  if (otherModules.includes('ase')) {
    fs.writeFileSync(path.join(siteDir, 'ase/build.py'), 'make_supercell = True\n', 'utf8');
  }
  if (otherModules.includes('tblite')) {
    fs.writeFileSync(path.join(siteDir, 'tblite/interface.py'), 'Calculator = True\n', 'utf8');
  }
  if (otherModules.includes('scipy')) {
    if (!options.omitScipyLinalg) {
      fs.writeFileSync(path.join(siteDir, 'scipy/linalg.py'), 'norm = True\n', 'utf8');
    }
    fs.writeFileSync(path.join(siteDir, 'scipy/optimize.py'), 'minimize = True\n', 'utf8');
    fs.writeFileSync(path.join(siteDir, 'scipy/spatial.py'), 'cKDTree = True\n', 'utf8');
  }
  if (options.badDylibArch) {
    const x64So = path.join(siteDir, 'scipy/_x86_64_ext.cpython-312-darwin.so');
    fs.mkdirSync(path.dirname(x64So), { recursive: true });
    const x64Buf = Buffer.alloc(64);
    x64Buf.writeUInt32LE(0xfeedfacf, 0);
    x64Buf.writeUInt32LE(0x01000007, 4);
    fs.writeFileSync(x64So, x64Buf);
  }
  fs.writeFileSync(path.join(siteDir, 'distutils-precedence.pth'), 'import sys\n', 'utf8');

  // Copy genuine xtb binary and required dylibs + params
  const xtbBin = path.join(condaDir, 'bin/xtb');
  if (options.fakeXtbAsPython) {
    fs.copyFileSync(fs.realpathSync(path.join(tcPythonDir, 'bin/python3')), xtbBin, copyFlag);
  } else {
    fs.copyFileSync(fs.realpathSync(path.join(depDir, 'xtb/bin/xtb')), xtbBin, copyFlag);
  }
  fs.chmodSync(xtbBin, 0o755);

  for (const dylibName of XTB_REQUIRED_DYLIBS) {
    const srcDylib = path.join(depDir, 'xtb/lib', dylibName);
    const dstDylib = path.join(condaDir, 'lib', dylibName);
    fs.copyFileSync(fs.realpathSync(srcDylib), dstDylib, copyFlag);
    fs.chmodSync(dstDylib, 0o755);
  }

  const xtbShare = path.join(condaDir, 'share/xtb');
  fs.mkdirSync(xtbShare, { recursive: true });
  for (const paramName of XTB_REQUIRED_PARAMS) {
    const srcParam = path.join(depDir, 'xtb/share/xtb', paramName);
    const dstParam = path.join(xtbShare, paramName);
    fs.copyFileSync(fs.realpathSync(srcParam), dstParam, copyFlag);
    fs.chmodSync(dstParam, 0o644);
  }
}

test('resolveDefaultCondaPrefix prioritizes SCIYUE_CONDA_ENV and ignores base CONDA_PREFIX', () => {
  const tmpEnvDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-conda-env-'));
  try {
    assert.equal(
      resolveDefaultCondaPrefix({
        SCIYUE_CONDA_ENV: tmpEnvDir,
        CONDA_PREFIX: '/opt/anaconda3'
      }),
      tmpEnvDir
    );
    const fallback = resolveDefaultCondaPrefix({
      SCIYUE_CONDA_ENV: '/nonexistent/path/12345',
      CONDA_PREFIX: '/opt/anaconda3'
    });
    if (fs.existsSync('/opt/anaconda3/envs/ester-studio')) {
      assert.equal(fallback, '/opt/anaconda3/envs/ester-studio');
    } else {
      assert.equal(fallback, null);
    }
  } finally {
    fs.rmSync(tmpEnvDir, { recursive: true, force: true });
  }
});

test('verifyMachOArchitecture validates thin and fat Mach-O headers and rejects architecture mismatch', () => {
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-macho-'));
  try {
    const arm64Bin = path.join(tmpDir, 'arm64-bin');
    const buf = Buffer.alloc(64);
    buf.writeUInt32LE(0xfeedfacf, 0);
    buf.writeUInt32LE(0x0100000c, 4);
    fs.writeFileSync(arm64Bin, buf);

    verifyMachOArchitecture(arm64Bin, 'darwin-arm64');
    assert.throws(
      () => verifyMachOArchitecture(arm64Bin, 'darwin-x64'),
      /STAGE_ARCH_MISMATCH/
    );
    assert.throws(
      () => verifyMachOArchitecture(arm64Bin, 'linux-x64'),
      /STAGE_PLATFORM_UNSUPPORTED/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildInventoryFiles uses locale-independent codepoint sorting and replaceMachOPrefixSlots rejects short slots', () => {
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-inv-slot-'));
  try {
    const pyDir = path.join(tmpDir, 'python');
    fs.mkdirSync(pyDir, { recursive: true });
    // Under localeCompare('en'), 'a.py' < 'B.py' < '_a.py', whereas ASCII codepoint order is 'B.py' (0x42) < '_a.py' (0x5f) < 'a.py' (0x61)
    for (const name of ['a.py', 'B.py', '_a.py']) {
      fs.writeFileSync(path.join(pyDir, name), name, 'utf8');
    }
    const inv = buildInventoryFiles(tmpDir, ['python']);
    assert.deepEqual(
      inv.map((f) => f.path),
      ['python/B.py', 'python/_a.py', 'python/a.py']
    );

    // Slot with ample trailing NULs succeeds
    const ampleSlot = Buffer.alloc(64, 0);
    ampleSlot.write('/short/prefix/lib/libfoo.dylib', 0, 'utf8');
    ampleSlot.write('NEXT', 60, 'utf8');
    const replaced = replaceMachOPrefixSlots(
      ampleSlot,
      ['/short/prefix'],
      CANONICAL_LOCKED_PREFIX,
      'libfoo.dylib'
    );
    assert.equal(replaced, true);
    assert.ok(ampleSlot.toString('utf8').startsWith(`${CANONICAL_LOCKED_PREFIX}/lib/libfoo.dylib\0`));

    // Slot too short to fit CANONICAL_LOCKED_PREFIX throws STAGE_RELOCATION_FAILED
    const tightSlot = Buffer.from('/a/b\0NEXT', 'utf8');
    assert.throws(
      () =>
        replaceMachOPrefixSlots(tightSlot, ['/a/b'], CANONICAL_LOCKED_PREFIX, 'tight.dylib'),
      /STAGE_RELOCATION_FAILED/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stageDarwinRuntime enforces prefix-independent reproducibility, non-destructive transactional rollback, xTB verification, and RDKit data relocation', () => {
  if (process.platform !== 'darwin') {
    assert.throws(
      () => stageDarwinRuntime({ platformId: 'linux-x64' }),
      /STAGE_PLATFORM_UNSUPPORTED/
    );
    return;
  }
  const { tcPythonDir, depDir } = ensureRepoSourcesAvailable();

  const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-stage-darwin-'));
  const condaShortDir = path.join(tmpRoot, 'conda-short');
  const condaLongDir = path.join(
    tmpRoot,
    'nested/deep/cloned-conda-environment-with-a-much-longer-directory-prefix'
  );
  const badCondaDir = path.join(tmpRoot, 'conda-bad');
  const checkoutDir = path.join(tmpRoot, 'checkout');
  try {
    buildMockCondaPrefix(condaShortDir, tcPythonDir, depDir);
    buildMockCondaPrefix(condaLongDir, tcPythonDir, depDir);

    const engineDir = path.join(checkoutDir, 'desktop', 'chemistry');
    const scriptsNativeDir = path.join(checkoutDir, 'scripts', 'native');
    fs.mkdirSync(engineDir, { recursive: true });
    fs.mkdirSync(scriptsNativeDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, 'engine.py'), '# mock engine\n', 'utf8');
    fs.writeFileSync(path.join(scriptsNativeDir, 'dev-runtime.py'), REAL_DEV_BOOTSTRAP, 'utf8');

    // Seed a stale file in target .local to verify successful commit cleans old members
    const staleFile = path.join(
      checkoutDir,
      '.local/dependencies/darwin-arm64/conda-chem-arm64/python/stale_unlisted.py'
    );
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, 'STALE = True\n', 'utf8');

    // 1. Valid staging from condaShortDir succeeds, cleans stale files, relocates RDKit data, and locks read-only
    const staged = stageDarwinRuntime({
      appPath: checkoutDir,
      platformId: 'darwin-arm64',
      condaPrefix: condaShortDir,
      updateLocks: true,
      lockReadOnly: true
    });

    assert.ok(fs.existsSync(staged.profilePath));
    assert.equal(fs.existsSync(staleFile), false);
    const stagedRdkitInit = path.join(
      staged.dependencyRoot,
      'python/lib/python3.12/site-packages/rdkit/__init__.py'
    );
    assert.equal(fs.lstatSync(stagedRdkitInit).isSymbolicLink(), false);
    assert.equal((fs.lstatSync(stagedRdkitInit).mode & 0o222), 0);

    // Verify RDKit share/RDKit/Data/Salts.txt was staged inside site-packages/rdkit/share/RDKit/Data
    const stagedSalts = path.join(
      staged.dependencyRoot,
      'python/lib/python3.12/site-packages/rdkit/share/RDKit/Data/Salts.txt'
    );
    assert.equal(fs.existsSync(stagedSalts), true);

    // Verify CTestTestfile.cmake and .orig files were excluded
    assert.equal(
      fs.existsSync(
        path.join(
          staged.dependencyRoot,
          'python/lib/python3.12/site-packages/rdkit/CTestTestfile.cmake'
        )
      ),
      false
    );
    assert.equal(
      fs.existsSync(
        path.join(
          staged.toolchainRoot,
          'python/lib/python3.12/_sysconfigdata__darwin_darwin.py.orig'
        )
      ),
      false
    );

    // 2. Prefix-independent reproducibility: staging from condaLongDir (different prefix path length!)
    // with updateLocks: false and verifyCommittedLocks: true MUST succeed without STAGE_LOCK_DRIFT!
    const restagedFromLongPrefix = stageDarwinRuntime({
      appPath: checkoutDir,
      platformId: 'darwin-arm64',
      condaPrefix: condaLongDir,
      updateLocks: false,
      verifyCommittedLocks: true,
      lockReadOnly: true
    });
    assert.equal(restagedFromLongPrefix.toolchainFileCount, staged.toolchainFileCount);
    assert.equal(restagedFromLongPrefix.dependencyFileCount, staged.dependencyFileCount);
    assert.equal(restagedFromLongPrefix.xtbFileCount, staged.xtbFileCount);

    // 3. Non-destructive rollback on failures: existing .local in checkoutDir must remain valid and read-only!
    // 3a. Architecture mismatch (darwin-x64)
    assert.throws(
      () =>
        stageDarwinRuntime({
          appPath: checkoutDir,
          platformId: 'darwin-x64',
          condaPrefix: condaShortDir,
          updateLocks: true
        }),
      /STAGE_ARCH_MISMATCH/
    );

    // 3b. Fake xTB binary (copied python3)
    buildMockCondaPrefix(badCondaDir, tcPythonDir, depDir, { fakeXtbAsPython: true });
    assert.throws(
      () =>
        stageDarwinRuntime({
          appPath: checkoutDir,
          platformId: 'darwin-arm64',
          condaPrefix: badCondaDir,
          updateLocks: true
        }),
      /STAGE_XTB_INVALID/
    );

    // 3c. Missing required scientific module (scipy omitted) or missing submodule (scipy.linalg omitted)
    fs.rmSync(badCondaDir, { recursive: true, force: true });
    buildMockCondaPrefix(badCondaDir, tcPythonDir, depDir, { omitScipy: true });
    assert.throws(
      () =>
        stageDarwinRuntime({
          appPath: checkoutDir,
          platformId: 'darwin-arm64',
          condaPrefix: badCondaDir,
          updateLocks: true
        }),
      /STAGE_IMPORT_PROBE_FAILED/
    );

    fs.rmSync(badCondaDir, { recursive: true, force: true });
    buildMockCondaPrefix(badCondaDir, tcPythonDir, depDir, { omitScipyLinalg: true });
    assert.throws(
      () =>
        stageDarwinRuntime({
          appPath: checkoutDir,
          platformId: 'darwin-arm64',
          condaPrefix: badCondaDir,
          updateLocks: true
        }),
      /STAGE_IMPORT_PROBE_FAILED/
    );

    // 3c-2. Wrong Mach-O architecture inside site-packages (.so extension is x86_64 on darwin-arm64)
    fs.rmSync(badCondaDir, { recursive: true, force: true });
    buildMockCondaPrefix(badCondaDir, tcPythonDir, depDir, { badDylibArch: true });
    assert.throws(
      () =>
        stageDarwinRuntime({
          appPath: checkoutDir,
          platformId: 'darwin-arm64',
          condaPrefix: badCondaDir,
          updateLocks: true
        }),
      /STAGE_ARCH_MISMATCH/
    );

    // 3d. Lock drift when a file in Conda prefix is modified and updateLocks: false
    fs.rmSync(badCondaDir, { recursive: true, force: true });
    buildMockCondaPrefix(badCondaDir, tcPythonDir, depDir, { rdkitVersion: 'mutated-version' });
    assert.throws(
      () =>
        stageDarwinRuntime({
          appPath: checkoutDir,
          platformId: 'darwin-arm64',
          condaPrefix: badCondaDir,
          updateLocks: false,
          verifyCommittedLocks: true
        }),
      /STAGE_LOCK_DRIFT/
    );

    // 3e. Missing one of the 4 lock/profile files when updateLocks: false & verifyCommittedLocks: true
    const savedProfileText = fs.readFileSync(staged.profilePath, 'utf8');
    fs.unlinkSync(staged.profilePath);
    try {
      assert.throws(
        () =>
          stageDarwinRuntime({
            appPath: checkoutDir,
            platformId: 'darwin-arm64',
            condaPrefix: condaShortDir,
            updateLocks: false,
            verifyCommittedLocks: true
          }),
        /STAGE_LOCK_DRIFT/
      );
    } finally {
      fs.writeFileSync(staged.profilePath, savedProfileText, 'utf8');
    }

    // 3f. Post-swap verification failure (corrupted dev-runtime.py) rolls back swapped .local and lock files!
    const devRuntimeFile = path.join(scriptsNativeDir, 'dev-runtime.py');
    fs.writeFileSync(devRuntimeFile, 'import sys\nsys.exit("SIMULATED_DEV_RUNTIME_FAILURE")\n', 'utf8');
    try {
      assert.throws(
        () =>
          stageDarwinRuntime({
            appPath: checkoutDir,
            platformId: 'darwin-arm64',
            condaPrefix: badCondaDir,
            updateLocks: true,
            lockReadOnly: true
          }),
        /STAGE_DEV_RUNTIME_FAILED/
      );
    } finally {
      fs.writeFileSync(devRuntimeFile, REAL_DEV_BOOTSTRAP, 'utf8');
    }

    // Confirm that after all failed staging attempts above (including post-swap rollback 3f),
    // checkoutDir's existing runtime and locks are untouched, still read-only, and still pass developmentNative and developmentXtb!
    assert.equal(fs.readFileSync(staged.profilePath, 'utf8'), savedProfileText);
    verifyTreeReadOnly(path.join(staged.toolchainRoot, 'python'));
    verifyTreeReadOnly(path.join(staged.dependencyRoot, 'python'));
    verifyTreeReadOnly(path.join(staged.dependencyRoot, 'xtb'));

    const selectedNative = developmentNative(checkoutDir, { platformId: 'darwin-arm64' });
    assert.equal(selectedNative.platform, 'darwin-arm64');
    assert.equal(selectedNative.provenance.locked, true);

    const selectedXtb = developmentXtb(checkoutDir, { platformId: 'darwin-arm64' });
    assert.ok(selectedXtb.root.endsWith('/xtb'));

    const envVars = currentRuntimeEnvironment({
      packaged: false,
      appPath: checkoutDir,
      executable: selectedNative.executable,
      platformId: 'darwin-arm64',
      environment: process.env
    });
    assert.equal(envVars.PYTHONDONTWRITEBYTECODE, '1');
    assert.ok(envVars.DYLD_FALLBACK_LIBRARY_PATH.includes('/python/lib'));
  } finally {
    makeDirectoryTreeWritable(tmpRoot);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
