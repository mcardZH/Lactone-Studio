import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  REQUIRED_PYTHON_PACKAGES,
  XTB_REQUIRED_PARAMS,
  detectElfArchitecture,
  parseElfDynamicNeeded,
  detectPeArchitecture,
  parsePeImportedDlls,
  stageCondaRuntime,
  removeTreeForce,
} from '../../scripts/native/stage-conda-runtime.mjs';
import {
  assembleWindowsPortableBundle,
  buildWindowsChemistryBootstrapScript,
  buildWindowsInstallGuideText,
} from '../../scripts/release/package-windows.mjs';
import {
  assembleLinuxPortableBundle,
  buildLinuxChemistryEngineLauncherScript,
  buildLinuxElectronWrapperScript,
  buildLinuxInstallGuideText,
  prepareLinuxAppDir,
} from '../../scripts/release/package-linux.mjs';

const require = createRequire(import.meta.url);
const { chemistryRuntime, validateToolchainStartupPaths } = require('../../desktop/runtime.cjs');
const { xtbRuntime } = require('../../desktop/xtb-runtime.cjs');
const { resolvePortableLayout } = require('../../desktop/portable-layout.cjs');
const { createFirstRunLicense } = require('../../desktop/first-run-license.cjs');
const { createOcrRuntime } = require('../../desktop/ocr-runtime.cjs');
const { createOrbitalBackendStore, LINUX_DEFAULT_CANDIDATES } = require('../../desktop/orbital-runtime.cjs');
const { createSyProjectAssociation } = require('../../desktop/sy-project-association.cjs');

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ester-xplat-pkg-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => removeTreeForce(dir));
}

function writeFile(root, relPath, content, mode) {
  const fullPath = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(fullPath, content);
  } else {
    fs.writeFileSync(fullPath, content, 'utf8');
  }
  if (mode !== undefined && process.platform !== 'win32') {
    fs.chmodSync(fullPath, mode);
  }
  return fullPath;
}

/** Build a minimal synthetic ELF64 little-endian binary with PT_LOAD + PT_DYNAMIC DT_NEEDED entries. */
function makeSyntheticElf64({ machine = 0x3e, needed = [], embeddedText = '' } = {}) {
  const strParts = [''];
  const offsets = [];
  let curLen = 1;
  for (const name of needed) {
    offsets.push(curLen);
    strParts.push(name);
    curLen += Buffer.byteLength(name, 'utf8') + 1;
  }
  const strtab = Buffer.from(strParts.join('\0') + '\0', 'utf8');

  // Dynamic entries: DT_NEEDED (1) * N + DT_STRTAB (5) + DT_STRSZ (10) + DT_NULL (0)
  const dynCount = needed.length + 3;
  const dynBuf = Buffer.alloc(dynCount * 16);
  const baseVaddr = 0x400000;
  const ehdrSize = 64;
  const phdrSize = 56 * 2;
  const strtabOffset = ehdrSize + phdrSize;
  const dynOffset = strtabOffset + strtab.length;

  let pos = 0;
  for (const nameOff of offsets) {
    dynBuf.writeBigInt64LE(1n, pos);
    dynBuf.writeBigUInt64LE(BigInt(nameOff), pos + 8);
    pos += 16;
  }
  dynBuf.writeBigInt64LE(5n, pos);
  dynBuf.writeBigUInt64LE(BigInt(baseVaddr + strtabOffset), pos + 8);
  pos += 16;
  dynBuf.writeBigInt64LE(10n, pos);
  dynBuf.writeBigUInt64LE(BigInt(strtab.length), pos + 8);
  pos += 16;
  dynBuf.writeBigInt64LE(0n, pos);
  dynBuf.writeBigUInt64LE(0n, pos + 8);

  const extraBuf = embeddedText ? Buffer.from(`\0${embeddedText}\0`, 'latin1') : Buffer.alloc(0);
  const totalSize = dynOffset + dynBuf.length + extraBuf.length;

  const ehdr = Buffer.alloc(ehdrSize);
  ehdr[0] = 0x7f;
  ehdr[1] = 0x45;
  ehdr[2] = 0x4c;
  ehdr[3] = 0x46;
  ehdr[4] = 2; // ELFCLASS64
  ehdr[5] = 1; // ELFDATA2LSB
  ehdr[6] = 1; // EV_CURRENT
  ehdr.writeUInt16LE(2, 16); // ET_EXEC
  ehdr.writeUInt16LE(machine, 18);
  ehdr.writeUInt32LE(1, 20);
  ehdr.writeBigUInt64LE(BigInt(ehdrSize), 32); // e_phoff
  ehdr.writeUInt16LE(ehdrSize, 52);
  ehdr.writeUInt16LE(56, 54); // e_phentsize
  ehdr.writeUInt16LE(2, 56); // e_phnum

  const phdrs = Buffer.alloc(phdrSize);
  // Program Header 0: PT_LOAD (1) covering whole file
  phdrs.writeUInt32LE(1, 0);
  phdrs.writeUInt32LE(5, 4);
  phdrs.writeBigUInt64LE(0n, 8); // p_offset
  phdrs.writeBigUInt64LE(BigInt(baseVaddr), 16); // p_vaddr
  phdrs.writeBigUInt64LE(BigInt(baseVaddr), 24);
  phdrs.writeBigUInt64LE(BigInt(totalSize), 32); // p_filesz
  phdrs.writeBigUInt64LE(BigInt(totalSize), 40); // p_memsz
  phdrs.writeBigUInt64LE(0x1000n, 48);

  // Program Header 1: PT_DYNAMIC (2)
  phdrs.writeUInt32LE(2, 56);
  phdrs.writeUInt32LE(6, 56 + 4);
  phdrs.writeBigUInt64LE(BigInt(dynOffset), 56 + 8);
  phdrs.writeBigUInt64LE(BigInt(baseVaddr + dynOffset), 56 + 16);
  phdrs.writeBigUInt64LE(BigInt(baseVaddr + dynOffset), 56 + 24);
  phdrs.writeBigUInt64LE(BigInt(dynBuf.length), 56 + 32);
  phdrs.writeBigUInt64LE(BigInt(dynBuf.length), 56 + 40);
  phdrs.writeBigUInt64LE(8n, 56 + 48);

  return Buffer.concat([ehdr, phdrs, strtab, dynBuf, extraBuf]);
}

/** Build a minimal synthetic PE32+ (64-bit) binary with an .idata Import Directory Table. */
function makeSyntheticPe64({ machine = 0x8664, imports = [], embeddedText = '' } = {}) {
  const dosHeader = Buffer.alloc(0x80);
  dosHeader[0] = 0x4d; // 'M'
  dosHeader[1] = 0x5a; // 'Z'
  dosHeader.writeUInt32LE(0x80, 60); // e_lfanew

  const peSigAndCoff = Buffer.alloc(24);
  peSigAndCoff.write('PE\0\0', 0, 'ascii');
  peSigAndCoff.writeUInt16LE(machine, 4);
  peSigAndCoff.writeUInt16LE(1, 6); // NumberOfSections = 1
  peSigAndCoff.writeUInt16LE(240, 20); // SizeOfOptionalHeader (PE32+)
  peSigAndCoff.writeUInt16LE(0x0022, 22);

  const optHeader = Buffer.alloc(240);
  optHeader.writeUInt16LE(0x20b, 0); // PE32+

  const sectionRva = 0x1000;
  const sectionFileOffset = 0x200;
  const descTableBytes = (imports.length + 1) * 20;
  const nameBuffers = [];
  const nameRvas = [];
  let curRel = descTableBytes;
  for (const dll of imports) {
    nameRvas.push(sectionRva + curRel);
    const b = Buffer.from(`${dll}\0`, 'ascii');
    nameBuffers.push(b);
    curRel += b.length;
  }
  const extraBuf = embeddedText ? Buffer.from(`\0${embeddedText}\0`, 'latin1') : Buffer.alloc(0);
  const idataPayloadLen = curRel + extraBuf.length;
  const rawSectionSize = Math.max(512, Math.ceil(idataPayloadLen / 512) * 512);

  if (imports.length > 0) {
    // DataDirectory[1] = Import Table at optHeader + 112 + 8 = 120
    optHeader.writeUInt32LE(sectionRva, 120);
    optHeader.writeUInt32LE(descTableBytes, 124);
  }

  const secHeader = Buffer.alloc(40);
  secHeader.write('.idata\0\0', 0, 'ascii');
  secHeader.writeUInt32LE(idataPayloadLen, 8); // VirtualSize
  secHeader.writeUInt32LE(sectionRva, 12); // VirtualAddress
  secHeader.writeUInt32LE(rawSectionSize, 16); // SizeOfRawData
  secHeader.writeUInt32LE(sectionFileOffset, 20); // PointerToRawData

  const headersLen = dosHeader.length + peSigAndCoff.length + optHeader.length + secHeader.length;
  const headerPad = Buffer.alloc(sectionFileOffset - headersLen);

  const sectionData = Buffer.alloc(rawSectionSize);
  for (let i = 0; i < imports.length; i += 1) {
    sectionData.writeUInt32LE(nameRvas[i], i * 20 + 12); // Name RVA
  }
  let writePos = descTableBytes;
  for (const nb of nameBuffers) {
    nb.copy(sectionData, writePos);
    writePos += nb.length;
  }
  extraBuf.copy(sectionData, writePos);

  return Buffer.concat([dosHeader, peSigAndCoff, optHeader, secHeader, headerPad, sectionData]);
}

function createMockRepoSkeleton(repoRoot) {
  writeFile(
    repoRoot,
    'package.json',
    JSON.stringify(
      {
        name: 'sciyue-input-studio',
        productName: 'Lactone Studio',
        version: '2.0.3',
        main: 'desktop/main.cjs',
      },
      null,
      2,
    ),
  );
  writeFile(repoRoot, 'LICENSE.txt', 'Ester Studio Public Source License 1.0\n');
  writeFile(repoRoot, 'licenses/THIRD_PARTY.txt', 'Third-party notices\n');
  writeFile(repoRoot, 'dist/index.html', '<!doctype html><html><body>Lactone Studio</body></html>\n');
  writeFile(repoRoot, 'public/brand-icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFile(repoRoot, 'desktop/main.cjs', "'use strict';\n");
  writeFile(repoRoot, 'desktop/chemistry/engine.py', 'print("ok")\n');
  writeFile(
    repoRoot,
    'src/data/conformer-solvation.json',
    fs.readFileSync(path.join(REPO_ROOT, 'src/data/conformer-solvation.json')),
  );
  writeFile(
    repoRoot,
    'scripts/portable/win32-engine-launcher.c',
    fs.readFileSync(path.join(REPO_ROOT, 'scripts/portable/win32-engine-launcher.c')),
  );
  writeFile(
    repoRoot,
    'node_modules/ssh2/package.json',
    JSON.stringify({ name: 'ssh2', version: '1.17.0', dependencies: { asn1: '0.2.6' } }),
  );
  writeFile(repoRoot, 'node_modules/ssh2/index.js', 'module.exports = {};\n');
  writeFile(repoRoot, 'node_modules/asn1/package.json', JSON.stringify({ name: 'asn1', version: '0.2.6' }));
  writeFile(repoRoot, 'node_modules/asn1/index.js', 'module.exports = {};\n');
}

test('ELF64 and PE32+ binary parsers detect architectures and extract dynamic imports accurately', async () => {
  await withTempDir(async (tmp) => {
    const elfX64 = writeFile(
      tmp,
      'sample-x64.elf',
      makeSyntheticElf64({
        machine: 0x3e,
        needed: ['libgfortran.so.5', 'libopenblas.so.0', 'libc.so.6'],
      }),
    );
    const elfArm64 = writeFile(tmp, 'sample-arm64.elf', makeSyntheticElf64({ machine: 0xb7 }));
    assert.equal(detectElfArchitecture(elfX64), 'x64');
    assert.equal(detectElfArchitecture(elfArm64), 'arm64');
    assert.deepEqual(parseElfDynamicNeeded(elfX64), ['libgfortran.so.5', 'libopenblas.so.0', 'libc.so.6']);

    const peX64 = writeFile(
      tmp,
      'sample-x64.exe',
      makeSyntheticPe64({
        machine: 0x8664,
        imports: ['libgfortran-5.dll', 'libopenblas.dll', 'KERNEL32.dll'],
      }),
    );
    const peArm64 = writeFile(tmp, 'sample-arm64.exe', makeSyntheticPe64({ machine: 0xaa64 }));
    assert.equal(detectPeArchitecture(peX64), 'x64');
    assert.equal(detectPeArchitecture(peArm64), 'arm64');
    assert.deepEqual(parsePeImportedDlls(peX64), [
      'libgfortran-5.dll',
      'libopenblas.dll',
      'KERNEL32.dll',
    ]);
  });
});

test('stageCondaRuntime stages linux-x64 and assembleLinuxPortableBundle produces valid .tar.gz + .AppImage compatible with desktop runtimes', async () => {
  await withTempDir(async (tmp) => {
    const repoRoot = path.join(tmp, 'repo');
    createMockRepoSkeleton(repoRoot);

    const condaEnv = path.join(tmp, 'conda-linux');
    writeFile(
      condaEnv,
      'bin/python3.12',
      makeSyntheticElf64({ machine: 0x3e, needed: ['libpython3.12.so.1.0', 'libc.so.6'] }),
      0o755,
    );
    if (process.platform !== 'win32') {
      fs.symlinkSync('python3.12', path.join(condaEnv, 'bin/python3'));
    } else {
      writeFile(condaEnv, 'bin/python3', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    }
    writeFile(condaEnv, 'lib/libpython3.12.so.1.0', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(condaEnv, 'lib/python3.12/os.py', '# stdlib os\n');
    writeFile(
      condaEnv,
      'lib/python3.12/lib-dynload/_ctypes.so',
      makeSyntheticElf64({ machine: 0x3e, needed: ['libffi.so.8'] }),
      0o755,
    );
    writeFile(condaEnv, 'lib/libffi.so.8', makeSyntheticElf64({ machine: 0x3e }), 0o755);

    for (const pkg of REQUIRED_PYTHON_PACKAGES) {
      writeFile(condaEnv, `lib/python3.12/site-packages/${pkg}/__init__.py`, '# pkg\n');
    }
    writeFile(
      condaEnv,
      'lib/python3.12/site-packages/tblite/_libtblite.so',
      makeSyntheticElf64({ machine: 0x3e, needed: ['libtblite.so.0'] }),
      0o755,
    );
    writeFile(
      condaEnv,
      'lib/libtblite.so.0',
      makeSyntheticElf64({ machine: 0x3e, needed: ['libopenblas.so.0'] }),
      0o755,
    );
    writeFile(condaEnv, 'lib/libopenblas.so.0', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(condaEnv, 'lib/libc.so.6', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(condaEnv, 'lib/python3.12/site-packages/rdkit/RDPaths.py', 'RDBaseDir="/hardcoded"\n');
    writeFile(condaEnv, 'share/RDKit/Data/FunctionalGroups.txt', 'fg\n');

    writeFile(
      condaEnv,
      'bin/xtb',
      makeSyntheticElf64({
        machine: 0x3e,
        needed: ['libgfortran.so.5', 'libgomp.so.1', 'libquadmath.so.0', 'libc.so.6'],
        embeddedText: 'xtb version 6.7.1',
      }),
      0o755,
    );
    writeFile(
      condaEnv,
      'lib/libgfortran.so.5',
      makeSyntheticElf64({ machine: 0x3e, needed: ['libquadmath.so.0'] }),
      0o755,
    );
    writeFile(condaEnv, 'lib/libgomp.so.1', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(condaEnv, 'lib/libquadmath.so.0', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    for (const p of XTB_REQUIRED_PARAMS) {
      writeFile(condaEnv, `share/xtb/${p}`, `param:${p}\n`);
    }

    const staged = stageCondaRuntime({
      appPath: repoRoot,
      condaPrefix: condaEnv,
      platformId: 'linux-x64',
    });
    assert.equal(staged.xtbVersion, '6.7.1');
    assert.equal(fs.lstatSync(path.join(staged.pythonToolchainRoot, 'bin/python3')).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(staged.xtbRoot, 'lib/libc.so.6')), false);
    assert.equal(fs.existsSync(path.join(staged.pythonDepsRoot, 'lib/libopenblas.so.0')), true);
    assert.ok(
      fs
        .readFileSync(path.join(staged.pythonDepsRoot, 'lib/python3.12/site-packages/rdkit/RDPaths.py'), 'utf8')
        .includes("os.path.join(RDCodeDir, 'share', 'RDKit')"),
    );

    const electronDist = path.join(repoRoot, 'node_modules/electron/dist');
    writeFile(electronDist, 'electron', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(electronDist, 'chrome-sandbox', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(electronDist, 'resources/default_app.asar', 'asar');

    const mockAppImageTool = writeFile(
      tmp,
      'mock-appimagetool',
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "appimagetool 13"; exit 0; fi',
        'if [ "$ARCH" != "x86_64" ] || [ "$APPIMAGE_EXTRACT_AND_RUN" != "1" ]; then exit 2; fi',
        'APPDIR="$2"',
        'OUT="$3"',
        'test -x "$APPDIR/AppRun" || exit 3',
        'test -f "$APPDIR/lactone-studio.desktop" || exit 4',
        'test -f "$APPDIR/.DirIcon" || exit 5',
        'test -x "$APPDIR/opt/lactone-studio/lactone-studio-bin" || exit 6',
        'printf "APPIMAGE-MOCK" > "$OUT"',
        'chmod +x "$OUT"',
        '',
      ].join('\n'),
      0o755,
    );

    const packaged = assembleLinuxPortableBundle({
      repoRoot,
      createTarGz: process.platform !== 'win32',
      createAppImage: process.platform !== 'win32',
      appImageToolPath: mockAppImageTool,
    });

    assert.equal(fs.existsSync(packaged.executablePath), true);
    assert.equal(fs.existsSync(packaged.electronBinaryPath), true);
    assert.equal(fs.existsSync(path.join(packaged.resourcesPath, 'default_app.asar')), false);
    if (process.platform !== 'win32') {
      assert.equal(fs.existsSync(packaged.tarGzPath), true);
      assert.equal(fs.existsSync(packaged.appImagePath), true);
    }

    const chemRt = chemistryRuntime({
      packaged: true,
      platform: 'linux',
      arch: 'x64',
      resourcesPath: packaged.resourcesPath,
      appPath: packaged.appResourcesPath,
    });
    assert.equal(chemRt.executable, path.join(packaged.resourcesPath, 'chemistry/engine'));
    assert.equal(chemRt.bundled, true);

    const xtbRt = await xtbRuntime({
      packaged: true,
      platform: 'linux',
      arch: 'x64',
      resourcesPath: packaged.resourcesPath,
      appPath: packaged.appResourcesPath,
    });
    assert.equal(xtbRt.version, '6.7.1');
    assert.equal(xtbRt.executable, path.join(packaged.resourcesPath, 'xtb/bin/xtb'));

    const launcherText = buildLinuxChemistryEngineLauncherScript();
    assert.ok(launcherText.includes('LD_LIBRARY_PATH'));
    assert.ok(buildLinuxElectronWrapperScript().includes('--no-sandbox'));
    assert.ok(buildLinuxInstallGuideText({ version: '2.0.3' }).includes('.AppImage'));
  });
});

test('stageCondaRuntime stages win32-x64 and assembleWindowsPortableBundle produces valid portable directory + .zip compatible with desktop runtimes', async () => {
  await withTempDir(async (tmp) => {
    const repoRoot = path.join(tmp, 'repo-win');
    createMockRepoSkeleton(repoRoot);

    const condaWin = path.join(tmp, 'conda-win64');
    writeFile(
      condaWin,
      'python.exe',
      makeSyntheticPe64({ machine: 0x8664, imports: ['python312.dll', 'KERNEL32.dll'] }),
    );
    writeFile(
      condaWin,
      'python312.dll',
      makeSyntheticPe64({ machine: 0x8664, imports: ['vcruntime140.dll', 'KERNEL32.dll'] }),
    );
    writeFile(condaWin, 'vcruntime140.dll', makeSyntheticPe64({ machine: 0x8664 }));
    writeFile(condaWin, 'Lib/os.py', '# win stdlib os\n');
    writeFile(
      condaWin,
      'DLLs/_ctypes.pyd',
      makeSyntheticPe64({ machine: 0x8664, imports: ['ffi-8.dll'] }),
    );
    writeFile(condaWin, 'Library/bin/ffi-8.dll', makeSyntheticPe64({ machine: 0x8664 }));
    writeFile(condaWin, 'Library/bin/KERNEL32.dll', makeSyntheticPe64({ machine: 0x8664 }));

    for (const pkg of REQUIRED_PYTHON_PACKAGES) {
      writeFile(condaWin, `Lib/site-packages/${pkg}/__init__.py`, '# pkg\n');
    }
    writeFile(
      condaWin,
      'Lib/site-packages/tblite/_libtblite.pyd',
      makeSyntheticPe64({ machine: 0x8664, imports: ['libtblite-0.dll'] }),
    );
    writeFile(
      condaWin,
      'Library/bin/libtblite-0.dll',
      makeSyntheticPe64({ machine: 0x8664, imports: ['libopenblas.dll'] }),
    );
    writeFile(condaWin, 'Library/bin/libopenblas.dll', makeSyntheticPe64({ machine: 0x8664 }));
    writeFile(condaWin, 'Library/share/RDKit/Data/FunctionalGroups.txt', 'fg\n');
    writeFile(condaWin, 'Lib/site-packages/rdkit/RDPaths.py', 'RDBaseDir="C:\\\\bld"\n');

    writeFile(
      condaWin,
      'Library/bin/xtb.exe',
      makeSyntheticPe64({
        machine: 0x8664,
        imports: [
          'libgfortran-5.dll',
          'libgomp-1.dll',
          'libwinpthread-1.dll',
          'api-ms-win-crt-runtime-l1-1-0.dll',
        ],
        embeddedText: 'xtb version 6.7.1',
      }),
    );
    writeFile(
      condaWin,
      'Library/bin/libgfortran-5.dll',
      makeSyntheticPe64({ machine: 0x8664, imports: ['libquadmath-0.dll'] }),
    );
    writeFile(condaWin, 'Library/bin/libgomp-1.dll', makeSyntheticPe64({ machine: 0x8664 }));
    writeFile(condaWin, 'Library/bin/libquadmath-0.dll', makeSyntheticPe64({ machine: 0x8664 }));
    writeFile(condaWin, 'Library/bin/libwinpthread-1.dll', makeSyntheticPe64({ machine: 0x8664 }));
    for (const p of XTB_REQUIRED_PARAMS) {
      writeFile(condaWin, `Library/share/xtb/${p}`, `param:${p}\n`);
    }

    const staged = stageCondaRuntime({
      appPath: repoRoot,
      condaPrefix: condaWin,
      platformId: 'win32-x64',
    });
    assert.equal(staged.xtbVersion, '6.7.1');
    assert.equal(fs.existsSync(path.join(staged.xtbRoot, 'bin/libquadmath-0.dll')), true);
    assert.equal(fs.existsSync(path.join(staged.xtbRoot, 'bin/KERNEL32.dll')), false);
    assert.doesNotThrow(() =>
      validateToolchainStartupPaths({
        executable: path.join(staged.pythonToolchainRoot, 'python.exe'),
        platform: 'win32-x64',
      }),
    );

    const electronDist = path.join(repoRoot, 'node_modules/electron/dist');
    writeFile(electronDist, 'electron.exe', makeSyntheticPe64({ machine: 0x8664 }));
    writeFile(electronDist, 'resources/default_app.asar', 'asar');
    const mockEngineLauncher = writeFile(tmp, 'mock-engine.exe', makeSyntheticPe64({ machine: 0x8664 }));

    const packaged = assembleWindowsPortableBundle({
      repoRoot,
      engineLauncherExePath: mockEngineLauncher,
      createZip: true,
    });

    assert.equal(fs.existsSync(packaged.executablePath), true);
    assert.equal(path.basename(packaged.executablePath), 'Lactone Studio.exe');
    assert.equal(fs.existsSync(packaged.zipPath), true);
    assert.ok(fs.statSync(packaged.zipPath).size > 0);
    assert.equal(fs.existsSync(path.join(packaged.portableDirPath, 'LICENSE.txt')), true);

    const layout = resolvePortableLayout({ executable: packaged.executablePath, version: '2.0.3' });
    assert.equal(layout.layoutVersion, 1);
    assert.equal(layout.distributionRoot, packaged.portableDirPath);

    const profileDir = path.join(tmp, 'win-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    const licenseStore = createFirstRunLicense({
      profileRoot: profileDir,
      licensePath: path.join(layout.distributionRoot, 'LICENSE.txt'),
    });
    const snap = await licenseStore.read(1);
    assert.equal(snap.acknowledged, false);
    assert.ok(snap.text.includes('Ester Studio'));

    const chemRt = chemistryRuntime({
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      resourcesPath: packaged.resourcesPath,
      appPath: packaged.appResourcesPath,
    });
    assert.equal(chemRt.executable, path.join(packaged.resourcesPath, 'chemistry/engine.exe'));

    const xtbRt = await xtbRuntime({
      packaged: true,
      platform: 'win32',
      arch: 'x64',
      resourcesPath: packaged.resourcesPath,
      appPath: packaged.appResourcesPath,
    });
    assert.equal(xtbRt.version, '6.7.1');
    assert.equal(xtbRt.executable, path.join(packaged.resourcesPath, 'xtb/bin/xtb.exe'));

    assert.ok(buildWindowsChemistryBootstrapScript().includes('add_dll_directory'));
    assert.ok(buildWindowsInstallGuideText({ version: '2.0.3' }).includes('Lactone Studio.exe'));

    // Architecture mismatch guard: arm64 PE inside win32-x64 must be rejected
    writeFile(staged.xtbRoot, 'bin/bad-arm64.dll', makeSyntheticPe64({ machine: 0xaa64 }));
    assert.throws(
      () =>
        assembleWindowsPortableBundle({
          repoRoot,
          engineLauncherExePath: mockEngineLauncher,
          createZip: false,
        }),
      /PE binary architecture mismatch/,
    );
    fs.rmSync(path.join(staged.xtbRoot, 'bin/bad-arm64.dll'), { force: true });

    // Missing GNU xTB DLL guard on win32-x64 even if libiomp5md.dll is present alongside libgfortran-5.dll
    writeFile(staged.xtbRoot, 'bin/libiomp5md.dll', makeSyntheticPe64({ machine: 0x8664 }));
    fs.rmSync(path.join(staged.xtbRoot, 'bin/libgomp-1.dll'), { force: true });
    assert.throws(
      () =>
        assembleWindowsPortableBundle({
          repoRoot,
          engineLauncherExePath: mockEngineLauncher,
          createZip: false,
        }),
      /ENOENT|XTB_RUNTIME_INVALID/,
    );

    // STAGE_PACKAGE_MISSING guard when a required Python scientific package is absent
    removeTreeForce(path.join(condaWin, 'Lib/site-packages/spglib'));
    assert.throws(
      () =>
        stageCondaRuntime({
          appPath: repoRoot,
          condaPrefix: condaWin,
          platformId: 'win32-x64',
        }),
      /STAGE_PACKAGE_MISSING/,
    );
  });
});

test('Linux packaging negative guards (ELF arch mismatch, symlink injection, missing xTB lib) and Windows Lactone Studio.exe association contract', async () => {
  await withTempDir(async (tmp) => {
    const repoRoot = path.join(tmp, 'repo-neg');
    createMockRepoSkeleton(repoRoot);

    const condaEnv = path.join(tmp, 'conda-linux-neg');
    writeFile(condaEnv, 'bin/python3.12', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(condaEnv, 'lib/libpython3.12.so.1.0', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(condaEnv, 'lib/python3.12/os.py', '# os\n');
    writeFile(condaEnv, 'lib/python3.12/lib-dynload/_ctypes.so', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    for (const pkg of REQUIRED_PYTHON_PACKAGES) {
      writeFile(condaEnv, `lib/python3.12/site-packages/${pkg}/__init__.py`, '# pkg\n');
    }
    writeFile(
      condaEnv,
      'bin/xtb',
      makeSyntheticElf64({ machine: 0x3e, embeddedText: 'xtb version 6.7.1' }),
      0o755,
    );
    writeFile(condaEnv, 'lib/libgfortran.so.5', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(condaEnv, 'lib/libgomp.so.1', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    writeFile(condaEnv, 'lib/libquadmath.so.0', makeSyntheticElf64({ machine: 0x3e }), 0o755);
    for (const p of XTB_REQUIRED_PARAMS) writeFile(condaEnv, `share/xtb/${p}`, `p:${p}\n`);

    const staged = stageCondaRuntime({ appPath: repoRoot, condaPrefix: condaEnv, platformId: 'linux-x64' });
    const electronDist = path.join(repoRoot, 'node_modules/electron/dist');
    writeFile(electronDist, 'electron', makeSyntheticElf64({ machine: 0x3e }), 0o755);

    // 1. Linux ELF arm64 binary inside x64 bundle must fail
    const badArmSo = writeFile(staged.xtbRoot, 'lib/libbad_arm.so.1', makeSyntheticElf64({ machine: 0xb7 }), 0o755);
    assert.throws(() => assembleLinuxPortableBundle({ repoRoot }), /ELF binary architecture mismatch/);
    fs.rmSync(badArmSo, { force: true });

    // 2. Symlink injected into staged tree must fail
    if (process.platform !== 'win32') {
      const linkPath = path.join(staged.pythonDepsRoot, 'lib/injected-link.so');
      fs.symlinkSync('/bin/sh', linkPath);
      assert.throws(() => assembleLinuxPortableBundle({ repoRoot }), /Unexpected symlink/);
      fs.rmSync(linkPath, { force: true });
    }

    // 3. Missing required Linux xTB shared library must fail
    fs.rmSync(path.join(staged.xtbRoot, 'lib/libgomp.so.1'), { force: true });
    assert.throws(() => assembleLinuxPortableBundle({ repoRoot }), /ENOENT|XTB_RUNTIME_INVALID/);

    // 4. Windows sy-project-association accepts Lactone Studio.exe without throwing SY_ASSOCIATION_INVALID_EXECUTABLE
    const winAssoc = createSyProjectAssociation({
      executablePath: 'D:\\Lactone-Studio-2.0.3-win32-x64\\Lactone Studio.exe',
      platform: 'win32',
      registry: {
        async read() {
          return { values: {}, journal: null };
        },
      },
    });
    const status = await winAssoc.status();
    assert.equal(status.supported, true);
    assert.equal(status.state, 'unregistered');
    assert.equal(status.executablePath, 'D:\\Lactone-Studio-2.0.3-win32-x64\\Lactone Studio.exe');
  });
});

test('Linux OCR runtime, Multiwfn orbital candidates, and Unified GitHub Actions release.yml contract pass verification', async () => {
  await withTempDir(async (tmp) => {
    // 1. Linux MolVec OCR component resolution
    const molvecDir = path.join(tmp, 'runtime/ocr-components/molvec');
    writeFile(molvecDir, 'runtime/openjdk-21/bin/java', '#!/bin/sh\necho java\n', 0o755);
    writeFile(molvecDir, 'molvec-0.9.8-jar-with-dependencies.jar', 'mock-jar-bytes');
    writeFile(
      molvecDir,
      'component.json',
      JSON.stringify({
        schema: 1,
        engine: 'molvec',
        version: '0.9.8',
        platform: 'linux',
        architecture: 'x64',
        executable: 'runtime/openjdk-21/bin/java',
        jar: 'molvec-0.9.8-jar-with-dependencies.jar',
      }),
    );
    const ocr = createOcrRuntime({ distributionRoot: tmp, platform: 'linux', architecture: 'x64' });
    const caps = await ocr.capabilities();
    assert.equal(caps.engines.find((e) => e.engine === 'molvec')?.status, 'ready');

    // 2. Linux Multiwfn default candidates
    assert.ok(LINUX_DEFAULT_CANDIDATES.includes('/usr/local/bin/Multiwfn'));
    const multiwfnBin = writeFile(tmp, 'bin/Multiwfn', '#!/bin/sh\n', 0o755);
    const orbitalStore = createOrbitalBackendStore(tmp, {
      platform: 'linux',
      env: {},
      defaultCandidates: [multiwfnBin],
    });
    const orbitalInfo = await orbitalStore.info();
    assert.equal(orbitalInfo.configured, true);
    assert.equal(orbitalInfo.path, fs.realpathSync(multiwfnBin));

    // 3. Unified GitHub Actions workflow contract
    const oldWorkflowPath = path.join(REPO_ROOT, '.github/workflows/release-macos.yml');
    const unifiedWorkflowPath = path.join(REPO_ROOT, '.github/workflows/release.yml');
    assert.equal(fs.existsSync(oldWorkflowPath), false, 'Legacy release-macos.yml should be superseded by release.yml');
    assert.equal(fs.existsSync(unifiedWorkflowPath), true, 'Unified release.yml must exist');

    const workflowYaml = fs.readFileSync(unifiedWorkflowPath, 'utf8');
    for (const requiredToken of [
      'build-macos:',
      'build-windows:',
      'build-linux:',
      'publish-release:',
      'macos-arm64',
      'macos-x64',
      'windows-x64',
      'linux-x64',
      'scripts/native/stage-darwin-runtime.mjs',
      'scripts/native/stage-conda-runtime.mjs',
      'scripts/release/package-macos.mjs',
      'scripts/release/package-windows.mjs',
      'scripts/release/package-linux.mjs',
      'INSTALL-macos-',
      'INSTALL-windows-x64.txt',
      'INSTALL-linux-x64.txt',
      'SHA256SUMS.txt',
      '"libblas=*=*openblas"',
      'RAW_TAG:',
    ]) {
      assert.ok(workflowYaml.includes(requiredToken), `Expected '${requiredToken}' in .github/workflows/release.yml`);
    }
    assert.equal(
      workflowYaml.includes('TAG_NAME="${{'),
      false,
      'release.yml must not interpolate untrusted GitHub expressions directly into bash double-quoted strings',
    );

    // 4. AppDir builder verification
    const appDir = prepareLinuxAppDir({
      portableDirPath: molvecDir,
      appDirPath: path.join(tmp, 'Sample.AppDir'),
      productName: 'Lactone Studio',
      brandIconPath: path.join(REPO_ROOT, 'public/brand-icon.png'),
    });
    assert.equal(fs.existsSync(path.join(appDir, 'AppRun')), true);
    assert.equal(fs.existsSync(path.join(appDir, 'lactone-studio.desktop')), true);
    assert.equal(fs.existsSync(path.join(appDir, '.DirIcon')), true);
  });
});
