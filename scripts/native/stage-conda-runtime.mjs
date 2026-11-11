#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_APP_PATH = path.resolve(__dirname, '../..');

export const REQUIRED_PYTHON_PACKAGES = Object.freeze([
  'numpy',
  'rdkit',
  'scipy',
  'ase',
  'spglib',
  'tblite',
]);

export const XTB_REQUIRED_PARAMS = Object.freeze([
  '.param_gfnff.xtb',
  'param_gfn0-xtb.txt',
  'param_gfn1-xtb.txt',
  'param_gfn2-xtb.txt',
]);

const STDLIB_EXCLUDES = new Set([
  '__pycache__',
  'site-packages',
  'test',
  'tests',
  'tkinter',
  'idlelib',
  'ensurepip',
  'turtledemo',
  'pydoc_data',
  'lib2to3',
]);

const LINUX_SYSTEM_LIB_PATTERNS = [
  /^ld-linux/i,
  /^linux-vdso\.so/i,
  /^libc\.so\./i,
  /^libm\.so\./i,
  /^libdl\.so\./i,
  /^libpthread\.so\./i,
  /^librt\.so\./i,
  /^libresolv\.so\./i,
  /^libutil\.so\./i,
  /^libnsl\.so\./i,
  /^libcrypt\.so\./i,
];

const WIN32_SYSTEM_DLLS = new Set([
  'advapi32.dll',
  'bcrypt.dll',
  'bcryptprimitives.dll',
  'cfgmgr32.dll',
  'combase.dll',
  'comctl32.dll',
  'comdlg32.dll',
  'crypt32.dll',
  'dbghelp.dll',
  'dnsapi.dll',
  'gdi32.dll',
  'imm32.dll',
  'iphlpapi.dll',
  'kernel32.dll',
  'kernelbase.dll',
  'mpr.dll',
  'msvcp_win.dll',
  'msvcrt.dll',
  'netapi32.dll',
  'normaliz.dll',
  'ntdll.dll',
  'ole32.dll',
  'oleaut32.dll',
  'pdh.dll',
  'powrprof.dll',
  'psapi.dll',
  'rpcrt4.dll',
  'secur32.dll',
  'setupapi.dll',
  'shell32.dll',
  'shlwapi.dll',
  'ucrtbase.dll',
  'user32.dll',
  'userenv.dll',
  'version.dll',
  'winhttp.dll',
  'wininet.dll',
  'winmm.dll',
  'ws2_32.dll',
  'wtsapi32.dll',
]);

export const CANONICAL_RDPATHS_PY = [
  'import os',
  'RDCodeDir=os.path.dirname(os.path.abspath(__file__))',
  "_share = os.path.join(RDCodeDir, 'share', 'RDKit')",
  "RDDataDir=os.path.join(_share,'Data')",
  "RDDocsDir=os.path.join(_share,'Docs')",
  "RDProjDir=os.path.join(_share,'Projects')",
  "RDContribDir=os.path.join(_share,'Contrib')",
  '',
].join('\n');

export function isWindowsSystemDll(dllName) {
  const lower = String(dllName || '').toLowerCase();
  if (!lower) return true;
  if (WIN32_SYSTEM_DLLS.has(lower)) return true;
  if (lower.startsWith('api-ms-win-') || lower.startsWith('ext-ms-win-')) return true;
  return false;
}

export function isLinuxSystemSo(soName) {
  const name = String(soName || '');
  if (!name) return true;
  return LINUX_SYSTEM_LIB_PATTERNS.some((re) => re.test(name));
}

export function detectElfArchitecture(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(24);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead < 20) return null;
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      return null;
    }
    const isLittleEndian = header[5] === 1;
    const machine = isLittleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18);
    if (machine === 0x3e) return 'x64';
    if (machine === 0xb7) return 'arm64';
    if (machine === 0x03) return 'ia32';
    return `unknown(0x${machine.toString(16)})`;
  } finally {
    fs.closeSync(fd);
  }
}

export function parseElfDynamicNeeded(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    return [];
  }
  const elfClass = buf[4];
  const isLE = buf[5] === 1;
  if (elfClass !== 2 || !isLE) return [];

  const phoff = Number(buf.readBigUInt64LE(32));
  const phentsize = buf.readUInt16LE(54);
  const phnum = buf.readUInt16LE(56);

  const loadSegments = [];
  let dynOffset = 0;
  let dynSize = 0;

  for (let i = 0; i < phnum; i += 1) {
    const off = phoff + i * phentsize;
    if (off + 56 > buf.length) break;
    const pType = buf.readUInt32LE(off);
    const pOffset = Number(buf.readBigUInt64LE(off + 8));
    const pVaddr = Number(buf.readBigUInt64LE(off + 16));
    const pFilesz = Number(buf.readBigUInt64LE(off + 32));
    if (pType === 1) {
      loadSegments.push({ pOffset, pVaddr, pFilesz });
    } else if (pType === 2) {
      dynOffset = pOffset;
      dynSize = pFilesz;
    }
  }

  if (!dynOffset || !dynSize || dynOffset + dynSize > buf.length) return [];

  const vaddrToOffset = (vaddr) => {
    for (const seg of loadSegments) {
      if (vaddr >= seg.pVaddr && vaddr < seg.pVaddr + seg.pFilesz) {
        return seg.pOffset + (vaddr - seg.pVaddr);
      }
    }
    return -1;
  };

  const neededOffsets = [];
  let strtabVaddr = -1;
  let strsz = 0;

  for (let pos = dynOffset; pos + 16 <= dynOffset + dynSize; pos += 16) {
    const dTag = Number(buf.readBigInt64LE(pos));
    const dVal = Number(buf.readBigUInt64LE(pos + 8));
    if (dTag === 0) break;
    if (dTag === 1) neededOffsets.push(dVal);
    else if (dTag === 5) strtabVaddr = dVal;
    else if (dTag === 10) strsz = dVal;
  }

  if (strtabVaddr < 0) return [];
  const strtabOffset = vaddrToOffset(strtabVaddr);
  if (strtabOffset < 0 || strtabOffset >= buf.length) return [];

  const needed = [];
  for (const nameOff of neededOffsets) {
    const start = strtabOffset + nameOff;
    if (start < 0 || start >= buf.length || (strsz > 0 && nameOff >= strsz)) continue;
    let end = start;
    while (end < buf.length && buf[end] !== 0) end += 1;
    const name = buf.subarray(start, end).toString('utf8');
    if (name && !needed.includes(name)) needed.push(name);
  }
  return needed;
}

export function detectPeArchitecture(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, 64, 0) < 64) return null;
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) return null;
    const peOffset = dos.readUInt32LE(60);
    const peHeader = Buffer.alloc(24);
    if (fs.readSync(fd, peHeader, 0, 24, peOffset) < 24) return null;
    if (peHeader[0] !== 0x50 || peHeader[1] !== 0x45 || peHeader[2] !== 0 || peHeader[3] !== 0) {
      return null;
    }
    const machine = peHeader.readUInt16LE(4);
    if (machine === 0x8664) return 'x64';
    if (machine === 0xaa64) return 'arm64';
    if (machine === 0x014c) return 'ia32';
    return `unknown(0x${machine.toString(16)})`;
  } finally {
    fs.closeSync(fd);
  }
}

export function parsePeImportedDlls(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 64 || buf[0] !== 0x4d || buf[1] !== 0x5a) return [];
  const peOffset = buf.readUInt32LE(60);
  if (peOffset + 24 > buf.length) return [];
  if (buf[peOffset] !== 0x50 || buf[peOffset + 1] !== 0x45 || buf[peOffset + 2] !== 0 || buf[peOffset + 3] !== 0) {
    return [];
  }

  const numSections = buf.readUInt16LE(peOffset + 6);
  const optHeaderSize = buf.readUInt16LE(peOffset + 20);
  const optOffset = peOffset + 24;
  if (optOffset + optHeaderSize > buf.length || optHeaderSize < 112) return [];

  const magic = buf.readUInt16LE(optOffset);
  let importDirEntryOffset = -1;
  if (magic === 0x20b && optHeaderSize >= 120) {
    importDirEntryOffset = optOffset + 112 + 8; // PE32+: DataDirectory[1]
  } else if (magic === 0x10b && optHeaderSize >= 104) {
    importDirEntryOffset = optOffset + 96 + 8; // PE32: DataDirectory[1]
  }
  if (importDirEntryOffset < 0 || importDirEntryOffset + 8 > buf.length) return [];

  const importRva = buf.readUInt32LE(importDirEntryOffset);
  const importSize = buf.readUInt32LE(importDirEntryOffset + 4);
  if (!importRva || !importSize) return [];

  const sectionTableOffset = optOffset + optHeaderSize;
  const sections = [];
  for (let i = 0; i < numSections; i += 1) {
    const secOff = sectionTableOffset + i * 40;
    if (secOff + 40 > buf.length) break;
    const virtualSize = buf.readUInt32LE(secOff + 8);
    const virtualAddress = buf.readUInt32LE(secOff + 12);
    const sizeOfRawData = buf.readUInt32LE(secOff + 16);
    const pointerToRawData = buf.readUInt32LE(secOff + 20);
    const span = Math.max(virtualSize, sizeOfRawData);
    sections.push({ virtualAddress, span, sizeOfRawData, pointerToRawData });
  }

  const rvaToOffset = (rva) => {
    for (const s of sections) {
      if (rva >= s.virtualAddress && rva < s.virtualAddress + s.span) {
        const delta = rva - s.virtualAddress;
        if (delta >= s.sizeOfRawData) return -1;
        return s.pointerToRawData + delta;
      }
    }
    return -1;
  };

  let descOff = rvaToOffset(importRva);
  if (descOff < 0) return [];

  const imports = [];
  for (let idx = 0; idx < 4096 && descOff + 20 <= buf.length; idx += 1, descOff += 20) {
    const origFirstThunk = buf.readUInt32LE(descOff);
    const nameRva = buf.readUInt32LE(descOff + 12);
    const firstThunk = buf.readUInt32LE(descOff + 16);
    if (!origFirstThunk && !nameRva && !firstThunk) break;
    if (!nameRva) continue;
    const nameOff = rvaToOffset(nameRva);
    if (nameOff < 0 || nameOff >= buf.length) continue;
    let end = nameOff;
    while (end < buf.length && buf[end] !== 0) end += 1;
    const dllName = buf.subarray(nameOff, end).toString('ascii');
    if (dllName && !imports.includes(dllName)) imports.push(dllName);
  }
  return imports;
}

function makeWritableRecursive(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) return;
  try {
    fs.chmodSync(targetPath, stat.mode | 0o200);
  } catch {}
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(targetPath)) {
      makeWritableRecursive(path.join(targetPath, name));
    }
  }
}

export function removeTreeForce(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  makeWritableRecursive(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyMaterializedFile(srcPath, destPath, modeOverride) {
  const realSrc = fs.realpathSync(srcPath);
  const srcStat = fs.statSync(realSrc);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(realSrc, destPath);
  if (process.platform !== 'win32') {
    const mode = modeOverride ?? (srcStat.mode & 0o111 ? 0o755 : 0o644);
    fs.chmodSync(destPath, mode);
  }
}

function copyTreeMaterialized(srcDir, destDir, { filter } = {}) {
  const realSrcDir = fs.realpathSync(srcDir);
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(realSrcDir, { withFileTypes: true })) {
    const srcChild = path.join(realSrcDir, entry.name);
    const destChild = path.join(destDir, entry.name);
    if (filter && !filter(entry.name, srcChild, entry)) continue;
    let targetStat;
    try {
      targetStat = fs.statSync(srcChild);
    } catch {
      continue; // skip broken symlinks in source Conda env
    }
    if (targetStat.isDirectory()) {
      copyTreeMaterialized(srcChild, destChild, { filter });
    } else if (targetStat.isFile()) {
      copyMaterializedFile(srcChild, destChild);
    }
  }
}

function collectFilesMatching(rootDir, predicate) {
  const found = [];
  if (!fs.existsSync(rootDir)) return found;
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && predicate(entry.name, full)) found.push(full);
    }
  }
  return found;
}

function collectTransitiveLinuxLibs(seedBinaries, searchDirs, destLibDir) {
  fs.mkdirSync(destLibDir, { recursive: true });
  const queue = [...seedBinaries];
  const visitedNames = new Set();

  const findInSearchDirs = (soName) => {
    for (const dir of searchDirs) {
      const candidate = path.join(dir, soName);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  };

  while (queue.length > 0) {
    const currentFile = queue.shift();
    for (const neededName of parseElfDynamicNeeded(currentFile)) {
      if (isLinuxSystemSo(neededName) || visitedNames.has(neededName)) continue;
      visitedNames.add(neededName);
      const srcSo = findInSearchDirs(neededName);
      if (!srcSo) continue;
      const destSo = path.join(destLibDir, neededName);
      copyMaterializedFile(srcSo, destSo, 0o755);
      queue.push(destSo);
    }
  }
  return [...visitedNames];
}

function collectTransitiveWin32Dlls(seedBinaries, searchDirs, destBinDir) {
  fs.mkdirSync(destBinDir, { recursive: true });
  const queue = [...seedBinaries];
  const visitedLower = new Set();

  const indexMap = new Map();
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.toLowerCase().endsWith('.dll')) continue;
      const key = entry.toLowerCase();
      if (!indexMap.has(key)) indexMap.set(key, path.join(dir, entry));
    }
  }

  while (queue.length > 0) {
    const currentFile = queue.shift();
    for (const dllName of parsePeImportedDlls(currentFile)) {
      const lower = dllName.toLowerCase();
      if (isWindowsSystemDll(lower) || visitedLower.has(lower)) continue;
      visitedLower.add(lower);
      const srcDll = indexMap.get(lower);
      if (!srcDll) continue;
      const destDll = path.join(destBinDir, path.basename(srcDll));
      if (!fs.existsSync(destDll)) {
        copyMaterializedFile(srcDll, destDll);
      }
      queue.push(destDll);
    }
  }
  return [...visitedLower];
}

function detectXtbVersionFromBinaryOrRun(xtbBinPath, xtbShareDir, xtbLibDir, platformId, fallbackVersion) {
  const rawLatin1 = fs.readFileSync(xtbBinPath).toString('latin1');
  const embeddedMatch = /xtb version\s*(\d+\.\d+\.\d+(?:pre)?)|xtb version\x00+(\d+\.\d+\.\d+(?:pre)?)/i.exec(rawLatin1);
  if (embeddedMatch) {
    return embeddedMatch[1] || embeddedMatch[2];
  }

  const hostId = `${process.platform}-${process.arch}`;
  if (hostId === platformId) {
    const env = {
      PATH: `${path.dirname(xtbBinPath)}${path.delimiter}${process.env.PATH || ''}`,
      XTBPATH: xtbShareDir,
      OMP_NUM_THREADS: '1',
    };
    if (platformId.startsWith('linux-') && xtbLibDir) {
      env.LD_LIBRARY_PATH = xtbLibDir;
    }
    const res = spawnSync(xtbBinPath, ['--version'], { env, encoding: 'utf8', timeout: 15000 });
    const match = /\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)/i.exec(`${res.stdout || ''}\n${res.stderr || ''}`);
    if (match) return match[1];
  }

  if (fallbackVersion) return fallbackVersion;
  throw new Error(`STAGE_XTB_VERSION_UNKNOWN: Unable to determine xTB version from ${xtbBinPath}`);
}

function maybeApplyLinuxPatchelf(xtbDir, pythonToolchainDir) {
  if (process.platform !== 'linux') return;
  const check = spawnSync('patchelf', ['--version'], { stdio: 'pipe' });
  if (check.error || check.status !== 0) return;

  const xtbBin = path.join(xtbDir, 'bin', 'xtb');
  if (fs.existsSync(xtbBin)) {
    spawnSync('patchelf', ['--set-rpath', '$ORIGIN/../lib', xtbBin], { stdio: 'pipe' });
  }
  const xtbLibDir = path.join(xtbDir, 'lib');
  if (fs.existsSync(xtbLibDir)) {
    for (const name of fs.readdirSync(xtbLibDir)) {
      const full = path.join(xtbLibDir, name);
      if (fs.statSync(full).isFile() && detectElfArchitecture(full) !== null) {
        spawnSync('patchelf', ['--set-rpath', '$ORIGIN', full], { stdio: 'pipe' });
      }
    }
  }
  const pyBin = path.join(pythonToolchainDir, 'bin', 'python3');
  if (fs.existsSync(pyBin)) {
    spawnSync('patchelf', ['--set-rpath', '$ORIGIN/../lib', pyBin], { stdio: 'pipe' });
  }
}

export function buildXtbRuntimeDescriptor({ platformId, version }) {
  const entry = platformId === 'win32-x64' ? 'bin/xtb.exe' : 'bin/xtb';
  return {
    schema: 'sciyue-xtb-bundled-runtime/v1',
    version,
    platform: platformId,
    scope: 'local-experimental',
    localUseReady: true,
    publicRedistributionReviewed: false,
    distributionLicenseReady: false,
    entry,
    dataDirectory: 'share/xtb',
    methods: ['gfn0', 'gfn1', 'gfn2', 'gfnff'],
  };
}

export function stageCondaRuntime({
  appPath = DEFAULT_APP_PATH,
  condaPrefix,
  platformId = `${process.platform}-${process.arch}`,
  expectedXtbVersion = null,
} = {}) {
  if (platformId !== 'linux-x64' && platformId !== 'win32-x64') {
    throw new Error(`Unsupported target platform for stageCondaRuntime: ${platformId}`);
  }
  if (!condaPrefix || !fs.existsSync(condaPrefix)) {
    throw new Error(`STAGE_SOURCE_MISSING: Conda prefix does not exist: ${condaPrefix}`);
  }

  const resolvedAppPath = path.resolve(appPath);
  const resolvedConda = fs.realpathSync(condaPrefix);
  const isWin = platformId === 'win32-x64';
  const expectedArch = 'x64';

  const tcDestRoot = isWin
    ? path.join(resolvedAppPath, '.local/toolchains/win-x64/conda-py312-x64/python')
    : path.join(resolvedAppPath, '.local/toolchains/linux-x64/conda-py312-x64/python');
  const depBaseRoot = isWin
    ? path.join(resolvedAppPath, '.local/dependencies/win-x64/conda-chem-x64')
    : path.join(resolvedAppPath, '.local/dependencies/linux-x64/conda-chem-x64');
  const depPythonRoot = path.join(depBaseRoot, 'python');
  const depXtbRoot = path.join(depBaseRoot, 'xtb');

  removeTreeForce(path.dirname(tcDestRoot));
  removeTreeForce(depBaseRoot);

  if (isWin) {
    const srcPythonExe = path.join(resolvedConda, 'python.exe');
    const srcPython312Dll = path.join(resolvedConda, 'python312.dll');
    const srcStdlib = path.join(resolvedConda, 'Lib');
    const srcSitePackages = path.join(srcStdlib, 'site-packages');
    const srcDlls = path.join(resolvedConda, 'DLLs');
    const srcLibraryBin = path.join(resolvedConda, 'Library', 'bin');

    for (const [label, p] of [
      ['python.exe', srcPythonExe],
      ['python312.dll', srcPython312Dll],
      ['Lib stdlib', srcStdlib],
      ['Lib/site-packages', srcSitePackages],
      ['DLLs', srcDlls],
    ]) {
      if (!fs.existsSync(p)) throw new Error(`STAGE_INPUT_MISSING: Missing ${label} at ${p}`);
    }

    const pyArch = detectPeArchitecture(srcPythonExe);
    if (pyArch && pyArch !== expectedArch) {
      throw new Error(`STAGE_ARCH_MISMATCH: python.exe expected ${expectedArch}, found ${pyArch}`);
    }

    fs.mkdirSync(tcDestRoot, { recursive: true });
    copyMaterializedFile(srcPythonExe, path.join(tcDestRoot, 'python.exe'));
    copyMaterializedFile(srcPython312Dll, path.join(tcDestRoot, 'python312.dll'));
    for (const optRootDll of ['python3.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
      const candidate = path.join(resolvedConda, optRootDll);
      const fallback = path.join(srcLibraryBin, optRootDll);
      if (fs.existsSync(candidate)) copyMaterializedFile(candidate, path.join(tcDestRoot, optRootDll));
      else if (fs.existsSync(fallback)) copyMaterializedFile(fallback, path.join(tcDestRoot, optRootDll));
    }

    fs.writeFileSync(path.join(tcDestRoot, 'python312._pth'), '.\nLib\nDLLs\n', 'utf8');

    copyTreeMaterialized(srcDlls, path.join(tcDestRoot, 'DLLs'), {
      filter: (name) => name !== '__pycache__' && !name.endsWith('.pdb'),
    });
    copyTreeMaterialized(srcStdlib, path.join(tcDestRoot, 'Lib'), {
      filter: (name) => !STDLIB_EXCLUDES.has(name) && !name.startsWith('config-3.12-'),
    });

    // Place transitive DLLs of python.exe/python312.dll directly in python/ (e.g. zlib.dll)
    // and transitive DLLs of stdlib DLLs/*.pyd directly in python/DLLs/ (e.g. ffi-8.dll, liblzma.dll)
    collectTransitiveWin32Dlls(
      [path.join(tcDestRoot, 'python.exe'), path.join(tcDestRoot, 'python312.dll')],
      [srcLibraryBin, resolvedConda, srcDlls],
      tcDestRoot,
    );
    const stdlibPydSeeds = collectFilesMatching(path.join(tcDestRoot, 'DLLs'), (name) => /\.(?:pyd|dll)$/i.test(name));
    collectTransitiveWin32Dlls(
      stdlibPydSeeds,
      [srcLibraryBin, resolvedConda, srcDlls],
      path.join(tcDestRoot, 'DLLs'),
    );

    const destSitePackages = path.join(depPythonRoot, 'Lib', 'site-packages');
    copyTreeMaterialized(srcSitePackages, destSitePackages, {
      filter: (name) => name !== '__pycache__' && !name.endsWith('.pyc') && !name.endsWith('.pdb'),
    });

    for (const reqPkg of REQUIRED_PYTHON_PACKAGES) {
      if (!fs.existsSync(path.join(destSitePackages, reqPkg))) {
        throw new Error(`STAGE_PACKAGE_MISSING: Required Python package '${reqPkg}' missing in ${destSitePackages}`);
      }
    }

    const rdkitShareCandidates = [
      path.join(resolvedConda, 'Library', 'share', 'RDKit'),
      path.join(resolvedConda, 'share', 'RDKit'),
    ];
    const srcRdkitShare = rdkitShareCandidates.find((p) => fs.existsSync(p));
    const destRdkitShare = path.join(destSitePackages, 'rdkit', 'share', 'RDKit');
    if (srcRdkitShare && !fs.existsSync(destRdkitShare)) {
      copyTreeMaterialized(srcRdkitShare, destRdkitShare);
    }
    const rdPathsPy = path.join(destSitePackages, 'rdkit', 'RDPaths.py');
    if (fs.existsSync(rdPathsPy)) {
      fs.writeFileSync(rdPathsPy, CANONICAL_RDPATHS_PY, 'utf8');
    }

    const depSeeds = collectFilesMatching(destSitePackages, (name) => /\.(?:pyd|dll)$/i.test(name));
    const destDepLibBin = path.join(depPythonRoot, 'Library', 'bin');
    fs.mkdirSync(destDepLibBin, { recursive: true });
    collectTransitiveWin32Dlls(depSeeds, [srcLibraryBin, resolvedConda, srcDlls], destDepLibBin);
    // Also include direct BLAS/Fortran/RDKit/tblite companion DLLs loaded dynamically via ctypes/LoadLibrary
    if (fs.existsSync(srcLibraryBin)) {
      for (const dllName of fs.readdirSync(srcLibraryBin)) {
        if (
          /^(?:librdkit|rdkit|openblas|libopenblas|libblas|liblapack|libtblite|libdftd4|libs-dftd3|libmctc-lib|libmulticharge|libtoml-f|libgfortran|libgomp|libquadmath|libgcc_s|libwinpthread|symspg|spglib|msvcp140|vcruntime140|concrt140|vcomp140|libiomp5md)/i.test(
            dllName,
          ) &&
          dllName.toLowerCase().endsWith('.dll')
        ) {
          const destDll = path.join(destDepLibBin, dllName);
          if (!fs.existsSync(destDll)) {
            copyMaterializedFile(path.join(srcLibraryBin, dllName), destDll);
          }
        }
      }
    }

    const xtbExeCandidates = [
      path.join(resolvedConda, 'Library', 'bin', 'xtb.exe'),
      path.join(resolvedConda, 'bin', 'xtb.exe'),
      path.join(resolvedConda, 'Scripts', 'xtb.exe'),
    ];
    const srcXtbExe = xtbExeCandidates.find((p) => fs.existsSync(p));
    if (!srcXtbExe) {
      throw new Error(`STAGE_XTB_MISSING: Unable to locate xtb.exe under ${resolvedConda}`);
    }
    const xtbShareCandidates = [
      path.join(resolvedConda, 'Library', 'share', 'xtb'),
      path.join(resolvedConda, 'share', 'xtb'),
    ];
    const srcXtbShare = xtbShareCandidates.find((p) => fs.existsSync(p));
    if (!srcXtbShare) {
      throw new Error(`STAGE_XTB_SHARE_MISSING: Unable to locate share/xtb under ${resolvedConda}`);
    }

    const destXtbBinDir = path.join(depXtbRoot, 'bin');
    const destXtbExe = path.join(destXtbBinDir, 'xtb.exe');
    copyMaterializedFile(srcXtbExe, destXtbExe);
    collectTransitiveWin32Dlls([destXtbExe], [path.dirname(srcXtbExe), srcLibraryBin, resolvedConda], destXtbBinDir);
    for (const fallbackDll of [
      'libgfortran-5.dll',
      'libgomp-1.dll',
      'libquadmath-0.dll',
      'libwinpthread-1.dll',
      'libgcc_s_seh-1.dll',
      'libopenblas.dll',
      'openblas.dll',
      'libblas.dll',
      'liblapack.dll',
      'vcruntime140.dll',
    ]) {
      const srcFromLib = path.join(srcLibraryBin, fallbackDll);
      const srcFromRoot = path.join(resolvedConda, fallbackDll);
      const srcCandidate = fs.existsSync(srcFromLib)
        ? srcFromLib
        : fs.existsSync(srcFromRoot)
          ? srcFromRoot
          : null;
      const destCandidate = path.join(destXtbBinDir, fallbackDll);
      if (srcCandidate && !fs.existsSync(destCandidate)) {
        copyMaterializedFile(srcCandidate, destCandidate);
      }
    }

    const destXtbShare = path.join(depXtbRoot, 'share', 'xtb');
    fs.mkdirSync(destXtbShare, { recursive: true });
    for (const paramFile of XTB_REQUIRED_PARAMS) {
      const srcParam = path.join(srcXtbShare, paramFile);
      if (!fs.existsSync(srcParam)) {
        throw new Error(`STAGE_XTB_PARAM_MISSING: Missing ${paramFile} in ${srcXtbShare}`);
      }
      copyMaterializedFile(srcParam, path.join(destXtbShare, paramFile));
    }

    const verifiedXtbVersion = detectXtbVersionFromBinaryOrRun(
      destXtbExe,
      destXtbShare,
      null,
      platformId,
      expectedXtbVersion,
    );
    const descriptor = buildXtbRuntimeDescriptor({ platformId, version: verifiedXtbVersion });
    fs.writeFileSync(path.join(depXtbRoot, 'runtime.json'), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

    return {
      platformId,
      pythonToolchainRoot: tcDestRoot,
      pythonDepsRoot: depPythonRoot,
      xtbRoot: depXtbRoot,
      xtbVersion: verifiedXtbVersion,
    };
  }

  // linux-x64 branch
  const srcPythonBinCandidates = [
    path.join(resolvedConda, 'bin', 'python3.12'),
    path.join(resolvedConda, 'bin', 'python3'),
    path.join(resolvedConda, 'bin', 'python'),
  ];
  const srcPythonBin = srcPythonBinCandidates.find((p) => fs.existsSync(p));
  const srcStdlib = path.join(resolvedConda, 'lib', 'python3.12');
  const srcSitePackages = path.join(srcStdlib, 'site-packages');
  const srcLibDir = path.join(resolvedConda, 'lib');

  for (const [label, p] of [
    ['bin/python3', srcPythonBin],
    ['lib/python3.12', srcStdlib],
    ['lib/python3.12/site-packages', srcSitePackages],
    ['lib', srcLibDir],
  ]) {
    if (!p || !fs.existsSync(p)) throw new Error(`STAGE_INPUT_MISSING: Missing ${label} at ${p}`);
  }

  const elfArch = detectElfArchitecture(fs.realpathSync(srcPythonBin));
  if (elfArch && elfArch !== expectedArch) {
    throw new Error(`STAGE_ARCH_MISMATCH: python3 expected ${expectedArch}, found ${elfArch}`);
  }

  const destTcBin = path.join(tcDestRoot, 'bin');
  const destTcLib = path.join(tcDestRoot, 'lib');
  fs.mkdirSync(destTcBin, { recursive: true });
  fs.mkdirSync(destTcLib, { recursive: true });
  copyMaterializedFile(srcPythonBin, path.join(destTcBin, 'python3'), 0o755);
  copyMaterializedFile(srcPythonBin, path.join(destTcBin, 'python'), 0o755);

  copyTreeMaterialized(srcStdlib, path.join(destTcLib, 'python3.12'), {
    filter: (name) => !STDLIB_EXCLUDES.has(name) && !name.startsWith('config-3.12-'),
  });

  const tcSeeds = [
    path.join(destTcBin, 'python3'),
    ...collectFilesMatching(path.join(destTcLib, 'python3.12', 'lib-dynload'), (name) => name.includes('.so')),
  ];
  collectTransitiveLinuxLibs(tcSeeds, [srcLibDir], destTcLib);
  for (const entry of fs.readdirSync(srcLibDir)) {
    if (/^libpython3\.12\.so(?:\..+)?$/.test(entry)) {
      const destPyLib = path.join(destTcLib, entry);
      if (!fs.existsSync(destPyLib)) {
        copyMaterializedFile(path.join(srcLibDir, entry), destPyLib, 0o755);
      }
    }
  }

  fs.mkdirSync(path.join(depPythonRoot, 'bin'), { recursive: true });
  const destSitePackages = path.join(depPythonRoot, 'lib', 'python3.12', 'site-packages');
  copyTreeMaterialized(srcSitePackages, destSitePackages, {
    filter: (name) => name !== '__pycache__' && !name.endsWith('.pyc'),
  });

  for (const reqPkg of REQUIRED_PYTHON_PACKAGES) {
    if (!fs.existsSync(path.join(destSitePackages, reqPkg))) {
      throw new Error(`STAGE_PACKAGE_MISSING: Required Python package '${reqPkg}' missing in ${destSitePackages}`);
    }
  }

  const srcRdkitShare = path.join(resolvedConda, 'share', 'RDKit');
  const destRdkitShare = path.join(destSitePackages, 'rdkit', 'share', 'RDKit');
  if (fs.existsSync(srcRdkitShare) && !fs.existsSync(destRdkitShare)) {
    copyTreeMaterialized(srcRdkitShare, destRdkitShare);
  }
  const rdPathsPy = path.join(destSitePackages, 'rdkit', 'RDPaths.py');
  if (fs.existsSync(rdPathsPy)) {
    fs.writeFileSync(rdPathsPy, CANONICAL_RDPATHS_PY, 'utf8');
  }

  const destDepLib = path.join(depPythonRoot, 'lib');
  fs.mkdirSync(destDepLib, { recursive: true });
  const depSeeds = collectFilesMatching(destSitePackages, (name) => name.includes('.so'));
  collectTransitiveLinuxLibs(depSeeds, [srcLibDir], destDepLib);
  // Fallback for SONAME entries (e.g. .so.<major>) not already pulled via DT_NEEDED
  for (const entry of fs.readdirSync(srcLibDir)) {
    if (
      /^(?:libtblite|libdftd4|libs-dftd3|libmctc-lib|libmulticharge|libtoml-f|libopenblas|libblas|liblapack|libgfortran|libgomp|libquadmath|libgcc_s|libsymspg|libRDKit)[^/]*\.so\.\d+$/i.test(
        entry,
      )
    ) {
      const srcCandidate = path.join(srcLibDir, entry);
      const destCandidate = path.join(destDepLib, entry);
      try {
        if (fs.statSync(srcCandidate).isFile() && !fs.existsSync(destCandidate)) {
          copyMaterializedFile(srcCandidate, destCandidate, 0o755);
        }
      } catch {}
    }
  }

  const srcXtbBin = path.join(resolvedConda, 'bin', 'xtb');
  const srcXtbShare = path.join(resolvedConda, 'share', 'xtb');
  if (!fs.existsSync(srcXtbBin)) {
    throw new Error(`STAGE_XTB_MISSING: Missing bin/xtb at ${srcXtbBin}`);
  }
  if (!fs.existsSync(srcXtbShare)) {
    throw new Error(`STAGE_XTB_SHARE_MISSING: Missing share/xtb at ${srcXtbShare}`);
  }

  const destXtbBin = path.join(depXtbRoot, 'bin', 'xtb');
  const destXtbLib = path.join(depXtbRoot, 'lib');
  const destXtbShare = path.join(depXtbRoot, 'share', 'xtb');
  copyMaterializedFile(srcXtbBin, destXtbBin, 0o755);
  collectTransitiveLinuxLibs([destXtbBin], [srcLibDir], destXtbLib);
  for (const reqLinuxLib of ['libgfortran.so.5', 'libgomp.so.1', 'libquadmath.so.0', 'libgcc_s.so.1']) {
    const srcLibCandidate = path.join(srcLibDir, reqLinuxLib);
    const destLibCandidate = path.join(destXtbLib, reqLinuxLib);
    if (fs.existsSync(srcLibCandidate) && !fs.existsSync(destLibCandidate)) {
      copyMaterializedFile(srcLibCandidate, destLibCandidate, 0o755);
    }
  }

  fs.mkdirSync(destXtbShare, { recursive: true });
  for (const paramFile of XTB_REQUIRED_PARAMS) {
    const srcParam = path.join(srcXtbShare, paramFile);
    if (!fs.existsSync(srcParam)) {
      throw new Error(`STAGE_XTB_PARAM_MISSING: Missing ${paramFile} in ${srcXtbShare}`);
    }
    copyMaterializedFile(srcParam, path.join(destXtbShare, paramFile), 0o644);
  }

  maybeApplyLinuxPatchelf(depXtbRoot, tcDestRoot);

  const verifiedXtbVersion = detectXtbVersionFromBinaryOrRun(
    destXtbBin,
    destXtbShare,
    destXtbLib,
    platformId,
    expectedXtbVersion,
  );
  const descriptor = buildXtbRuntimeDescriptor({ platformId, version: verifiedXtbVersion });
  fs.writeFileSync(path.join(depXtbRoot, 'runtime.json'), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

  return {
    platformId,
    pythonToolchainRoot: tcDestRoot,
    pythonDepsRoot: depPythonRoot,
    xtbRoot: depXtbRoot,
    xtbVersion: verifiedXtbVersion,
  };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [key, inlineVal] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const nextVal = inlineVal !== null ? inlineVal : argv[i + 1];
    const consume = () => {
      if (inlineVal === null) i += 1;
      return nextVal;
    };
    if (key === '--app-path' && nextVal) opts.appPath = path.resolve(consume());
    else if (key === '--conda-prefix' && nextVal) opts.condaPrefix = path.resolve(consume());
    else if (key === '--platform' && nextVal) opts.platformId = consume();
    else if (key === '--expected-xtb-version' && nextVal) opts.expectedXtbVersion = consume();
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    const res = stageCondaRuntime(opts);
    console.log(
      `[stage-conda-runtime] ✅ Staged ${res.platformId} runtime (xTB ${res.xtbVersion}) into ${res.pythonToolchainRoot} and ${res.pythonDepsRoot}`,
    );
  } catch (error) {
    console.error('[stage-conda-runtime] ❌ Failed:', error.message);
    process.exit(1);
  }
}
