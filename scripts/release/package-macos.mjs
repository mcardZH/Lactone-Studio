import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const xtbContract = require('../../desktop/xtb-runtime-contract.cjs');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const HELPER_SUFFIXES = Object.freeze(['', ' (GPU)', ' (Plugin)', ' (Renderer)']);
const REQUIRED_PYTHON_PACKAGES = ['numpy', 'rdkit', 'scipy', 'ase', 'spglib', 'tblite'];
const DARWIN_XTB_LIBRARIES = [
  'lib/libblas.3.dylib',
  'lib/libgcc_s.1.1.dylib',
  'lib/libgfortran.5.dylib',
  'lib/liblapack.3.dylib',
  'lib/libomp.dylib',
  'lib/libopenblas.0.dylib',
  'lib/libquadmath.0.dylib',
];
const DARWIN_XTB_PARAMETERS = [
  'share/xtb/param_gfn0-xtb.txt',
  'share/xtb/param_gfn1-xtb.txt',
  'share/xtb/param_gfn2-xtb.txt',
  'share/xtb/.param_gfnff.xtb',
];
const XTB_BROKEN_OPT_FORMAT = '(1x,"("f7.2"%)")';
const XTB_FIXED_OPT_FORMAT = '(" (",f7.2,"%)")';

function collectTransitiveDependencies(nodeModulesDir, rootPackageNames) {
  const seen = new Set();
  function visit(pkgName, isOptional = false) {
    if (seen.has(pkgName)) return;
    const pkgJsonPath = path.join(nodeModulesDir, pkgName, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      if (isOptional) return;
      throw new Error(`Missing required packaging input (node_modules package ${pkgName}): ${pkgJsonPath}`);
    }
    seen.add(pkgName);
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    for (const depName of Object.keys(pkgJson.dependencies || {})) visit(depName, false);
    for (const depName of Object.keys(pkgJson.optionalDependencies || {})) visit(depName, true);
  }
  for (const name of rootPackageNames) visit(name, false);
  return [...seen];
}

export function makeTreeOwnerWritable(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) return;
  try {
    fs.chmodSync(targetPath, stat.mode | 0o200);
  } catch {}
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      makeTreeOwnerWritable(path.join(targetPath, entry));
    }
  }
}

export function removeTreeForce(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  makeTreeOwnerWritable(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyTreePreservingSymlinks(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  makeTreeOwnerWritable(dest);
}

function updatePlistStringKey(plistContent, key, value) {
  const escaped = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (pattern.test(plistContent)) return plistContent.replace(pattern, `$1${escaped}$3`);
  const dictClose = plistContent.lastIndexOf('</dict>');
  if (dictClose !== -1) {
    return `${plistContent.slice(0, dictClose)}  <key>${key}</key>\n  <string>${escaped}</string>\n${plistContent.slice(dictClose)}`;
  }
  return plistContent;
}

function validatePlistFile(plistPath, label = 'Info.plist') {
  if (!fs.existsSync(plistPath)) {
    throw new Error(`Missing required packaging input (${label}): ${plistPath}`);
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('/usr/bin/plutil', ['-lint', '-s', plistPath], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`Invalid or corrupt ${label} (${plistPath}): ${error.stderr?.toString('utf8')?.trim() || error.message}`);
    }
    return;
  }
  const rawBuf = fs.readFileSync(plistPath);
  if (rawBuf.subarray(0, 6).toString('ascii') === 'bplist') {
    throw new Error(`Binary plist (${label}) requires macOS /usr/bin/plutil: ${plistPath}`);
  }
  const plist = rawBuf.toString('utf8');
  if (!plist.includes('<plist') || !plist.includes('</dict>')) {
    throw new Error(`Invalid XML ${label} (${plistPath})`);
  }
}

function updatePlistFile(plistPath, entries, label = 'Info.plist') {
  validatePlistFile(plistPath, label);
  if (process.platform === 'darwin') {
    try {
      execFileSync('/usr/bin/plutil', ['-convert', 'xml1', plistPath], { stdio: 'pipe' });
      for (const [key, value] of Object.entries(entries)) {
        execFileSync('/usr/bin/plutil', ['-replace', key, '-string', String(value), plistPath], { stdio: 'pipe' });
      }
      execFileSync('/usr/bin/plutil', ['-lint', '-s', plistPath], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`Invalid or corrupt ${label} (${plistPath}): ${error.stderr?.toString('utf8')?.trim() || error.message}`);
    }
    return;
  }
  let plist = fs.readFileSync(plistPath, 'utf8');
  for (const [key, value] of Object.entries(entries)) plist = updatePlistStringKey(plist, key, value);
  fs.writeFileSync(plistPath, plist, 'utf8');
}

function rebrandElectronBundle(appBundlePath, productName, bundleId, version) {
  const contentsDir = path.join(appBundlePath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const oldMainBin = path.join(macosDir, 'Electron');
  const newMainBin = path.join(macosDir, productName);
  if (oldMainBin !== newMainBin) fs.renameSync(oldMainBin, newMainBin);

  updatePlistFile(
    path.join(contentsDir, 'Info.plist'),
    {
      CFBundleExecutable: productName,
      CFBundleName: productName,
      CFBundleDisplayName: productName,
      CFBundleIdentifier: bundleId,
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    },
    'Electron Info.plist',
  );

  const frameworksDir = path.join(contentsDir, 'Frameworks');
  for (const suffix of HELPER_SUFFIXES) {
    const oldHelperName = `Electron Helper${suffix}`;
    const newHelperName = `${productName} Helper${suffix}`;
    const oldHelperApp = path.join(frameworksDir, `${oldHelperName}.app`);
    const helperMacosDir = path.join(oldHelperApp, 'Contents', 'MacOS');
    const oldHelperBin = path.join(helperMacosDir, oldHelperName);
    const newHelperBin = path.join(helperMacosDir, newHelperName);
    if (oldHelperBin !== newHelperBin) fs.renameSync(oldHelperBin, newHelperBin);

    updatePlistFile(
      path.join(oldHelperApp, 'Contents', 'Info.plist'),
      {
        CFBundleExecutable: newHelperName,
        CFBundleName: newHelperName,
        CFBundleDisplayName: newHelperName,
        CFBundleIdentifier: `${bundleId}.helper`,
      },
      `${oldHelperName} Info.plist`,
    );

    const newHelperApp = path.join(frameworksDir, `${newHelperName}.app`);
    if (oldHelperApp !== newHelperApp) fs.renameSync(oldHelperApp, newHelperApp);
  }
}

export function buildChemistryBootstrapScript() {
  return [
    'import os, runpy, sys',
    'root = os.path.dirname(os.path.abspath(__file__))',
    "site_packages = os.path.join(root, 'deps', 'lib', 'python3.12', 'site-packages')",
    "rdkit_share = os.path.join(site_packages, 'rdkit', 'share', 'RDKit')",
    'if not os.path.isdir(rdkit_share):',
    "    rdkit_share = os.path.join(root, 'deps', 'share', 'RDKit')",
    "os.environ['RDBASE'] = rdkit_share",
    "os.environ['RDKIT_DATA_DIR'] = os.path.join(rdkit_share, 'Data')",
    "os.environ['PYTHONNOUSERSITE'] = '1'",
    "os.environ['PYTHONDONTWRITEBYTECODE'] = '1'",
    'sys.path = [p for p in sys.path if p]',
    'sys.path.insert(0, site_packages)',
    'sys.path.insert(0, root)',
    "entry = os.path.join(root, 'engine.py')",
    'sys.argv = [entry, *sys.argv[1:]]',
    "runpy.run_path(entry, run_name='__main__')",
    '',
  ].join('\n');
}

export function buildChemistryEngineLauncherScript() {
  return [
    '#!/bin/sh',
    'set -e',
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'export DYLD_FALLBACK_LIBRARY_PATH="$DIR/deps/lib:$DIR/python/lib:/usr/lib"',
    'exec "$DIR/python/bin/python3" -I -S -B "$DIR/bootstrap.py" "$@"',
    '',
  ].join('\n');
}

function cputypeToArch(cputype) {
  if (cputype === 0x0100000c) return 'arm64';
  if (cputype === 0x01000007) return 'x64';
  return `unknown(0x${(cputype >>> 0).toString(16)})`;
}

export function detectMachOArchitectures(filePath) {
  const resolved = fs.realpathSync(filePath);
  const fd = fs.openSync(resolved, 'r');
  try {
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead < 8) return null;
    const magic = buf.readUInt32BE(0);
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) return [cputypeToArch(buf.readInt32LE(4))];
    if (magic === 0xfeedfacf || magic === 0xfeedface) return [cputypeToArch(buf.readInt32BE(4))];
    if (magic === 0xcafebabe || magic === 0xbebafeca) {
      const be = magic === 0xcafebabe;
      const nfat = be ? buf.readUInt32BE(4) : buf.readUInt32LE(4);
      if (nfat > 0 && nfat <= 16 && bytesRead >= 8 + nfat * 20) {
        const archs = [];
        for (let i = 0; i < nfat; i += 1) {
          archs.push(cputypeToArch(be ? buf.readInt32BE(8 + i * 20) : buf.readInt32LE(8 + i * 20)));
        }
        return archs;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function validateExecutableFile(filePath, expectedArch, label, { allowSymlink = false } = {}) {
  let lstat;
  try {
    lstat = fs.lstatSync(filePath);
  } catch {
    throw new Error(`Missing required packaging input (${label}): ${filePath}`);
  }
  if (lstat.isSymbolicLink() && !allowSymlink) {
    throw new Error(`Invalid packaging input (${label} must not be a symlink): ${filePath}`);
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`Missing required packaging input (${label}): ${filePath}`);
  }
  if (!stat.isFile()) throw new Error(`Invalid packaging input (${label} is not a file): ${filePath}`);
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    throw new Error(`Invalid packaging input (${label} is not executable): ${filePath}`);
  }
  const archs = detectMachOArchitectures(filePath);
  if (archs !== null && !archs.includes(expectedArch)) {
    throw new Error(`Binary architecture mismatch for ${label} (${filePath}): expected darwin-${expectedArch}, found [${archs.join(', ')}]`);
  }
}

function verifyXtbRuntimeVersion(xtbRootDir, expectedVersion, arch) {
  const xtbBinPath = path.join(xtbRootDir, 'bin', 'xtb');
  const machOArchs = detectMachOArchitectures(xtbBinPath);
  if (machOArchs !== null) {
    const rawLatin1 = fs.readFileSync(xtbBinPath).toString('latin1');
    const embeddedMatch = /xtb version\x00+(\d+\.\d+\.\d+(?:pre)?)/i.exec(rawLatin1);
    if (!embeddedMatch || embeddedMatch[1] !== expectedVersion) {
      throw new Error(
        `xTB runtime version mismatch (${xtbBinPath}): runtime.json declares ${expectedVersion}, but binary contains ${embeddedMatch ? embeddedMatch[1] : 'unverified version'}`,
      );
    }
  }
  if (process.platform === 'darwin' && (arch === process.arch || machOArchs === null)) {
    const res = spawnSync(xtbBinPath, ['--version'], {
      env: {
        PATH: '/usr/bin:/bin',
        XTBPATH: path.join(xtbRootDir, 'share', 'xtb'),
        OMP_NUM_THREADS: '1',
        DYLD_FALLBACK_LIBRARY_PATH: `${path.join(xtbRootDir, 'lib')}:/usr/lib`,
      },
      encoding: 'utf8',
      timeout: 15000,
    });
    if (res.error || res.status !== 0) {
      throw new Error(`xTB version probe failed (${xtbBinPath}): ${res.error?.message || (res.stderr || '').trim() || res.status}`);
    }
    const verMatch = /\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)/i.exec(`${res.stdout || ''}\n${res.stderr || ''}`);
    if (!verMatch || verMatch[1] !== expectedVersion) {
      throw new Error(
        `xTB runtime version mismatch (${xtbBinPath}): runtime.json declares ${expectedVersion}, but binary reported ${verMatch ? verMatch[1] : 'unknown'}`,
      );
    }
  }
}

function patchXtbOptimizerFormatBug(xtbBinPath) {
  if (!fs.existsSync(xtbBinPath) || detectMachOArchitectures(xtbBinPath) === null) return false;
  const rawLatin1 = fs.readFileSync(xtbBinPath).toString('latin1');
  if (!rawLatin1.includes(XTB_BROKEN_OPT_FORMAT)) return false;
  const patchedBuf = Buffer.from(rawLatin1.replaceAll(XTB_BROKEN_OPT_FORMAT, XTB_FIXED_OPT_FORMAT), 'latin1');
  fs.chmodSync(xtbBinPath, 0o755);
  fs.writeFileSync(xtbBinPath, patchedBuf);
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--sign', '-', xtbBinPath], { stdio: 'pipe' });
  }
  return true;
}

function verifyPackagedXtbOptimization(xtbDestDir, expectedVersion, arch) {
  const xtbBinPath = path.join(xtbDestDir, 'bin', 'xtb');
  if (process.platform !== 'darwin' || arch !== process.arch || detectMachOArchitectures(xtbBinPath) === null) {
    return;
  }
  const probeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ester-xtb-opt-probe-'));
  try {
    fs.writeFileSync(
      path.join(probeDir, 'h2o.xyz'),
      '3\nwater\nO 0.000000 0.000000 0.000000\nH 0.960000 0.000000 0.000000\nH -0.240000 0.930000 0.000000\n',
      'utf8',
    );
    const res = spawnSync(xtbBinPath, ['h2o.xyz', '--opt', '--gfn', '2'], {
      cwd: probeDir,
      env: {
        PATH: `${path.join(xtbDestDir, 'bin')}:/usr/bin:/bin`,
        XTBPATH: path.join(xtbDestDir, 'share', 'xtb'),
        HOME: probeDir,
        TMP: probeDir,
        TEMP: probeDir,
        LANG: 'C',
        LC_ALL: 'C',
        OMP_NUM_THREADS: '1',
        OMP_MAX_ACTIVE_LEVELS: '1',
        OPENBLAS_NUM_THREADS: '1',
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    if (res.error || res.status !== 0 || !fs.existsSync(path.join(probeDir, 'xtbopt.xyz'))) {
      throw new Error(`Packaged xTB geometry optimization probe failed (exit ${res.status}): ${(res.stderr || res.error?.message || '').trim()}`);
    }
    const verMatch = /\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)/i.exec(res.stdout || '');
    if (!verMatch || verMatch[1] !== expectedVersion) {
      throw new Error(`Packaged xTB optimization version mismatch: expected ${expectedVersion}, got ${verMatch ? verMatch[1] : 'unknown'}`);
    }
  } finally {
    removeTreeForce(probeDir);
  }
}

function validateMachOTreeArch(rootDir, expectedArch, label) {
  if (fs.lstatSync(rootDir).isSymbolicLink()) {
    throw new Error(`Invalid packaging input (${label} root must not be a symlink): ${rootDir}`);
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const isBinDir = path.basename(current) === 'bin';
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in ${label}: ${fullPath}`);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isBinDir || entry.name.endsWith('.dylib') || entry.name.endsWith('.so') || entry.name.includes('.dylib.')) {
        const archs = detectMachOArchitectures(fullPath);
        if (archs !== null && !archs.includes(expectedArch)) {
          throw new Error(`Binary architecture mismatch in ${label} (${fullPath}): expected darwin-${expectedArch}, found [${archs.join(', ')}]`);
        }
      }
    }
  }
}

function readJsonStrictIfExists(filePath, label) {
  if (!fs.existsSync(filePath)) return null;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read ${label} (${filePath}): ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} (${filePath}): ${error.message}`);
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkRelativeFiles(baseDir, relDir) {
  const results = [];
  if (!fs.existsSync(path.join(baseDir, relDir))) return results;
  const stack = [relDir];
  while (stack.length > 0) {
    const currentRel = stack.pop();
    const currentAbs = path.join(baseDir, currentRel);
    for (const entry of fs.readdirSync(currentAbs, { withFileTypes: true })) {
      const childRel = `${currentRel}/${entry.name}`;
      const childAbs = path.join(currentAbs, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in locked runtime directory: ${childAbs}`);
      if (entry.isDirectory()) stack.push(childRel);
      else if (entry.isFile()) results.push(childRel);
    }
  }
  return results;
}

function verifyLockedMemberRows(repoRoot, rootRel, files, label, contentDirectories) {
  if (!Array.isArray(files)) return;
  const declaredSet = new Set();
  for (const row of files) {
    if (!row || typeof row.path !== 'string') continue;
    declaredSet.add(row.path);
    const memberPath = path.join(repoRoot, rootRel, row.path);
    if (!fs.existsSync(memberPath)) throw new Error(`Missing locked runtime member in ${label} (${row.path}): ${memberPath}`);
    const stat = fs.lstatSync(memberPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Invalid locked runtime member in ${label} (${row.path}): ${memberPath}`);
    if (typeof row.bytes === 'number' && stat.size !== row.bytes) {
      throw new Error(`Locked runtime member size mismatch in ${label} (${row.path}): expected ${row.bytes}, got ${stat.size}`);
    }
    if (typeof row.sha256 === 'string' && sha256File(memberPath) !== row.sha256) {
      throw new Error(`Locked runtime member sha256 mismatch in ${label} (${row.path}): ${memberPath}`);
    }
  }
  if (declaredSet.size > 0 && Array.isArray(contentDirectories) && contentDirectories.length > 0) {
    const baseDir = path.join(repoRoot, rootRel);
    for (const contentDir of contentDirectories) {
      for (const actualRel of walkRelativeFiles(baseDir, contentDir)) {
        if (!declaredSet.has(actualRel)) {
          throw new Error(`Undeclared file in locked runtime ${label} (${actualRel}): ${path.join(baseDir, actualRel)}`);
        }
      }
    }
  }
}

function verifyLockInventoryIfPresent(repoRoot, lockObj, label) {
  if (!lockObj) return;
  const contentDirs = Array.isArray(lockObj.contentDirectories) ? lockObj.contentDirectories : ['python'];
  if (lockObj.inventory && typeof lockObj.inventory.path === 'string') {
    const invPath = path.join(repoRoot, lockObj.inventory.path);
    if (!fs.existsSync(invPath)) throw new Error(`Missing inventory file for ${label}: ${invPath}`);
    const invStat = fs.statSync(invPath);
    if (typeof lockObj.inventory.bytes === 'number' && invStat.size !== lockObj.inventory.bytes) {
      throw new Error(`Inventory size mismatch for ${label}: ${invPath}`);
    }
    if (typeof lockObj.inventory.sha256 === 'string' && sha256File(invPath) !== lockObj.inventory.sha256) {
      throw new Error(`Inventory sha256 mismatch for ${label}: ${invPath}`);
    }
    const invDoc = readJsonStrictIfExists(invPath, `${label} inventory`);
    verifyLockedMemberRows(repoRoot, lockObj.root, invDoc?.files, label, contentDirs);
  }
  verifyLockedMemberRows(repoRoot, lockObj.root, lockObj.files, label, contentDirs);
}

export function resolveDefaultMacRuntimeSources(
  repoRoot = DEFAULT_REPO_ROOT,
  arch = process.arch,
  needed = { toolchain: true, deps: true, xtb: true },
) {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`Unsupported macOS architecture: ${arch}`);
  const platformId = `darwin-${arch}`;
  const explicitProfilePath = path.join(repoRoot, `desktop/packaging/native-profile.${platformId}.json`);
  const fallbackProfilePath = path.join(repoRoot, 'desktop/packaging/native-profile.json');

  let profile = null;
  if (fs.existsSync(explicitProfilePath)) {
    profile = readJsonStrictIfExists(explicitProfilePath, `native profile (${platformId})`);
    if (!profile || profile.platform !== platformId) {
      throw new Error(`Invalid native profile platform in ${explicitProfilePath}: expected ${platformId}, got ${profile?.platform}`);
    }
  } else if (fs.existsSync(fallbackProfilePath)) {
    const candidate = readJsonStrictIfExists(fallbackProfilePath, 'native profile');
    if (candidate?.platform === platformId) profile = candidate;
  }

  const tcLockPath = path.join(repoRoot, profile?.toolchainLock || `desktop/packaging/native-toolchain.${platformId}.lock.json`);
  const rtLockPath = path.join(repoRoot, profile?.runtimeLock || `desktop/packaging/native-runtime.${platformId}.lock.json`);
  const xtbLockPath = path.join(repoRoot, profile?.xtbLock || `desktop/packaging/xtb-runtime.${platformId}.lock.json`);

  if (profile) {
    for (const [isNeeded, label, lockPath] of [
      [needed.toolchain !== false, 'toolchain lock', tcLockPath],
      [needed.deps !== false, 'runtime lock', rtLockPath],
      [needed.xtb !== false, 'xTB lock', xtbLockPath],
    ]) {
      if (isNeeded && !fs.existsSync(lockPath)) throw new Error(`Missing ${label} declared by native profile: ${lockPath}`);
    }
  }

  const tcLock = needed.toolchain !== false ? readJsonStrictIfExists(tcLockPath, 'toolchain lock') : null;
  const rtLock = needed.deps !== false ? readJsonStrictIfExists(rtLockPath, 'runtime lock') : null;
  const xtbLock = needed.xtb !== false ? readJsonStrictIfExists(xtbLockPath, 'xTB lock') : null;

  for (const [label, lockObj, lockPath] of [
    ['toolchain lock', tcLock, tcLockPath],
    ['runtime lock', rtLock, rtLockPath],
    ['xTB lock', xtbLock, xtbLockPath],
  ]) {
    if (lockObj) {
      if (lockObj.platform !== platformId || typeof lockObj.root !== 'string' || !lockObj.root) {
        throw new Error(`Invalid ${label} metadata for ${platformId}: ${lockPath}`);
      }
      verifyLockInventoryIfPresent(repoRoot, lockObj, label);
    }
  }

  const pickFallback = (candidates) => candidates.find((c) => c && fs.existsSync(c)) || candidates[0];
  const pythonToolchainRoot =
    needed.toolchain === false
      ? null
      : tcLock
        ? path.join(repoRoot, tcLock.root, 'python')
        : pickFallback([
            path.join(repoRoot, `.local/toolchains/${platformId}/conda-py312-${arch}/python`),
            path.join(repoRoot, `.local/toolchains/${platformId}/conda-py312-arm64/python`),
          ]);
  const pythonDepsRoot =
    needed.deps === false
      ? null
      : rtLock
        ? path.join(repoRoot, rtLock.root, 'python')
        : pickFallback([
            path.join(repoRoot, `.local/dependencies/${platformId}/conda-chem-${arch}/python`),
            path.join(repoRoot, `.local/dependencies/${platformId}/conda-chem-arm64/python`),
          ]);
  const xtbSubdir = Array.isArray(xtbLock?.contentDirectories) && xtbLock.contentDirectories[0] ? xtbLock.contentDirectories[0] : 'xtb';
  const xtbSourceRoot =
    needed.xtb === false
      ? null
      : xtbLock
        ? path.join(repoRoot, xtbLock.root, xtbSubdir)
        : pickFallback([
            path.join(repoRoot, `.local/dependencies/${platformId}/conda-chem-${arch}/xtb`),
            path.join(repoRoot, `.local/dependencies/${platformId}/conda-chem-arm64/xtb`),
          ]);

  return { pythonToolchainRoot, pythonDepsRoot, xtbSourceRoot };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const result = { skipBuild: false, skipDmg: false, skipSign: false, options: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-build') { result.skipBuild = true; continue; }
    if (arg === '--skip-dmg') { result.skipDmg = true; continue; }
    if (arg === '--skip-sign') { result.skipSign = true; continue; }
    const [key, inlineVal] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const nextVal = inlineVal !== null ? inlineVal : argv[i + 1];
    const consume = () => { if (inlineVal === null) i += 1; return nextVal; };
    if (key === '--repo-root' && nextVal) result.options.repoRoot = path.resolve(consume());
    else if (key === '--arch' && nextVal) result.options.arch = consume();
    else if (key === '--output-dir' && nextVal) result.options.outputDir = path.resolve(consume());
    else if (key === '--electron-app' && nextVal) result.options.electronAppPath = path.resolve(consume());
    else if (key === '--python-toolchain-root' && nextVal) result.options.pythonToolchainRoot = path.resolve(consume());
    else if (key === '--python-deps-root' && nextVal) result.options.pythonDepsRoot = path.resolve(consume());
    else if (key === '--xtb-source-root' && nextVal) result.options.xtbSourceRoot = path.resolve(consume());
  }
  return result;
}

export function assembleMacAppBundle(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const arch = options.arch ?? process.arch;
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`Unsupported macOS architecture: ${arch}`);
  const needsDefaultSources = !options.pythonToolchainRoot || !options.pythonDepsRoot || !options.xtbSourceRoot;
  const defaults = needsDefaultSources
    ? resolveDefaultMacRuntimeSources(repoRoot, arch, {
        toolchain: !options.pythonToolchainRoot,
        deps: !options.pythonDepsRoot,
        xtb: !options.xtbSourceRoot,
      })
    : {};
  const pkgJsonPath = path.join(repoRoot, 'package.json');
  const repoPkg = readJsonStrictIfExists(pkgJsonPath, 'package.json');
  const {
    outputDir = path.join(repoRoot, 'release', `darwin-${arch}`),
    electronAppPath = path.join(repoRoot, 'node_modules/electron/dist/Electron.app'),
    pythonToolchainRoot = defaults.pythonToolchainRoot,
    pythonDepsRoot = defaults.pythonDepsRoot,
    xtbSourceRoot = defaults.xtbSourceRoot,
    productName = repoPkg?.productName || 'Ester Studio',
    version = repoPkg?.version || '2.0.3',
    bundleId = 'com.sciyue.esterstudio',
    sign = false,
    createDmg = false,
    execFile = execFileSync,
  } = options;

  const distDir = path.join(repoRoot, 'dist');
  const desktopDir = path.join(repoRoot, 'desktop');
  const chemistrySrcDir = path.join(desktopDir, 'chemistry');
  const conformerSolvationJsonPath = path.join(repoRoot, 'src', 'data', 'conformer-solvation.json');
  const requiresConformerSolvationData =
    fs.existsSync(path.join(desktopDir, 'conformer-solvation.cjs')) ||
    fs.existsSync(path.join(chemistrySrcDir, 'conformer_solvation.py'));
  const licensePath = path.join(repoRoot, 'LICENSE.txt');
  const nodeModulesDir = path.join(repoRoot, 'node_modules');

  for (const [label, targetPath] of [
    ['package.json', pkgJsonPath],
    ['LICENSE.txt', licensePath],
    ['node_modules directory', nodeModulesDir],
    ['ssh2 runtime dependency', path.join(nodeModulesDir, 'ssh2', 'package.json')],
    ['Electron.app template', electronAppPath],
    ['Electron Info.plist', path.join(electronAppPath, 'Contents', 'Info.plist')],
    ['Electron Framework.framework', path.join(electronAppPath, 'Contents', 'Frameworks', 'Electron Framework.framework')],
    ['frontend dist directory', distDir],
    ['frontend dist index.html', path.join(distDir, 'index.html')],
    ['desktop directory', desktopDir],
    ['desktop main.cjs', path.join(desktopDir, 'main.cjs')],
    ['chemistry source directory', chemistrySrcDir],
    ['chemistry engine.py', path.join(chemistrySrcDir, 'engine.py')],
    ...(requiresConformerSolvationData ? [['conformer solvation data (src/data/conformer-solvation.json)', conformerSolvationJsonPath]] : []),
    ['Python toolchain directory', pythonToolchainRoot],
    ['Python stdlib (lib/python3.12)', path.join(pythonToolchainRoot, 'lib', 'python3.12')],
    ['Python dependencies directory', pythonDepsRoot],
    ['xTB runtime directory', xtbSourceRoot],
    ['xTB runtime.json manifest', path.join(xtbSourceRoot, 'runtime.json')],
  ]) {
    if (!fs.existsSync(targetPath)) throw new Error(`Missing required packaging input (${label}): ${targetPath}`);
  }
  const runtimePackages = collectTransitiveDependencies(nodeModulesDir, ['ssh2']);

  for (const pkgName of REQUIRED_PYTHON_PACKAGES) {
    const pkgPath = path.join(pythonDepsRoot, 'lib', 'python3.12', 'site-packages', pkgName);
    if (!fs.existsSync(pkgPath)) throw new Error(`Missing required packaging input (Python scientific package ${pkgName}): ${pkgPath}`);
  }

  validatePlistFile(path.join(electronAppPath, 'Contents', 'Info.plist'), 'Electron Info.plist');
  validateExecutableFile(path.join(electronAppPath, 'Contents', 'MacOS', 'Electron'), arch, 'Electron executable');
  validateExecutableFile(
    path.join(electronAppPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
    arch,
    'Electron Framework binary',
    { allowSymlink: true },
  );
  for (const suffix of HELPER_SUFFIXES) {
    const helperName = `Electron Helper${suffix}`;
    const helperAppPath = path.join(electronAppPath, 'Contents', 'Frameworks', `${helperName}.app`);
    if (!fs.existsSync(helperAppPath)) throw new Error(`Missing required packaging input (${helperName}.app): ${helperAppPath}`);
    validatePlistFile(path.join(helperAppPath, 'Contents', 'Info.plist'), `${helperName} Info.plist`);
    validateExecutableFile(path.join(helperAppPath, 'Contents', 'MacOS', helperName), arch, `${helperName} executable`);
  }
  validateExecutableFile(path.join(pythonToolchainRoot, 'bin', 'python3'), arch, 'Python executable (bin/python3)');
  validateMachOTreeArch(pythonToolchainRoot, arch, 'Python toolchain');
  validateMachOTreeArch(pythonDepsRoot, arch, 'Python scientific dependencies');
  if (process.platform === 'darwin' && arch === process.arch && detectMachOArchitectures(path.join(pythonToolchainRoot, 'bin', 'python3')) !== null) {
    try {
      execFileSync(
        path.join(pythonToolchainRoot, 'bin', 'python3'),
        [
          '-I', '-S', '-B', '-c',
          `import sys; sp = ${JSON.stringify(path.join(pythonDepsRoot, 'lib', 'python3.12', 'site-packages'))}; sys.path = [sp] + [p for p in sys.path if p]; import numpy, rdkit, scipy, ase, spglib, tblite`,
        ],
        {
          env: {
            PATH: '/usr/bin:/bin',
            DYLD_FALLBACK_LIBRARY_PATH: `${path.join(pythonDepsRoot, 'lib')}:${path.join(pythonToolchainRoot, 'lib')}:/usr/lib`,
          },
          stdio: 'pipe',
          timeout: 30000,
        },
      );
    } catch (error) {
      throw new Error(`Python scientific runtime import probe failed: ${error.stderr?.toString('utf8') || error.message}`);
    }
  }

  const xtbManifestPath = path.join(xtbSourceRoot, 'runtime.json');
  const xtbManifest = xtbContract.validateDescriptor(readJsonStrictIfExists(xtbManifestPath, 'xTB runtime.json'));
  const expectedPlatformId = `darwin-${arch}`;
  if (xtbManifest.schema !== 'sciyue-xtb-bundled-runtime/v1' || xtbManifest.platform !== expectedPlatformId || xtbManifest.entry !== 'bin/xtb') {
    throw new Error(`Invalid xTB runtime.json manifest (${xtbManifestPath}): expected schema sciyue-xtb-bundled-runtime/v1, platform ${expectedPlatformId}, and entry bin/xtb`);
  }
  validateExecutableFile(path.join(xtbSourceRoot, 'bin', 'xtb'), arch, 'xTB executable (bin/xtb)');
  validateMachOTreeArch(xtbSourceRoot, arch, 'xTB runtime');
  for (const relLib of DARWIN_XTB_LIBRARIES) {
    const libPath = path.join(xtbSourceRoot, relLib);
    if (!fs.existsSync(libPath)) throw new Error(`Missing required packaging input (xTB library ${relLib}): ${libPath}`);
    xtbContract.ordinary(xtbSourceRoot, relLib);
  }
  for (const relParam of DARWIN_XTB_PARAMETERS) {
    const paramPath = path.join(xtbSourceRoot, relParam);
    if (!fs.existsSync(paramPath)) throw new Error(`Missing required packaging input (xTB parameter ${relParam}): ${paramPath}`);
    xtbContract.ordinary(xtbSourceRoot, relParam);
  }
  xtbContract.ordinary(xtbSourceRoot, 'bin/xtb');
  verifyXtbRuntimeVersion(xtbSourceRoot, xtbManifest.version, arch);

  fs.mkdirSync(outputDir, { recursive: true });
  const appBundlePath = path.join(outputDir, `${productName}.app`);
  removeTreeForce(appBundlePath);

  copyTreePreservingSymlinks(electronAppPath, appBundlePath);
  rebrandElectronBundle(appBundlePath, productName, bundleId, version);

  const resourcesPath = path.join(appBundlePath, 'Contents', 'Resources');
  fs.rmSync(path.join(resourcesPath, 'default_app.asar'), { force: true });

  const appResourcesPath = path.join(resourcesPath, 'app');
  removeTreeForce(appResourcesPath);
  fs.mkdirSync(appResourcesPath, { recursive: true });

  fs.copyFileSync(pkgJsonPath, path.join(appResourcesPath, 'package.json'));
  fs.copyFileSync(licensePath, path.join(appResourcesPath, 'LICENSE.txt'));
  copyTreePreservingSymlinks(distDir, path.join(appResourcesPath, 'dist'));
  copyTreePreservingSymlinks(desktopDir, path.join(appResourcesPath, 'desktop'));
  if (fs.existsSync(conformerSolvationJsonPath)) {
    const appDataDir = path.join(appResourcesPath, 'src', 'data');
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.copyFileSync(conformerSolvationJsonPath, path.join(appDataDir, 'conformer-solvation.json'));
  }

  const licensesDir = path.join(repoRoot, 'licenses');
  if (fs.existsSync(licensesDir)) copyTreePreservingSymlinks(licensesDir, path.join(appResourcesPath, 'licenses'));

  for (const relOcrDir of ['runtime/ocr-components', 'ocr-components']) {
    const srcOcrDir = path.join(repoRoot, relOcrDir);
    if (fs.existsSync(srcOcrDir)) copyTreePreservingSymlinks(srcOcrDir, path.join(appResourcesPath, relOcrDir));
  }
  const ocrRuntimeDir = path.join(repoRoot, 'runtime', 'ocr');
  if (fs.existsSync(ocrRuntimeDir)) {
    copyTreePreservingSymlinks(ocrRuntimeDir, path.join(appResourcesPath, 'runtime', 'ocr'));
    const destMolvecDir = path.join(appResourcesPath, 'runtime', 'ocr-components', 'molvec');
    if (!fs.existsSync(destMolvecDir)) {
      if (fs.existsSync(path.join(ocrRuntimeDir, 'component.json'))) {
        copyTreePreservingSymlinks(ocrRuntimeDir, destMolvecDir);
      } else if (fs.existsSync(path.join(ocrRuntimeDir, 'molvec', 'component.json'))) {
        copyTreePreservingSymlinks(path.join(ocrRuntimeDir, 'molvec'), destMolvecDir);
      }
    }
  }

  for (const pkgName of runtimePackages) {
    copyTreePreservingSymlinks(path.join(nodeModulesDir, pkgName), path.join(appResourcesPath, 'node_modules', pkgName));
  }

  const chemistryDestDir = path.join(resourcesPath, 'chemistry');
  removeTreeForce(chemistryDestDir);
  copyTreePreservingSymlinks(chemistrySrcDir, chemistryDestDir);
  if (fs.existsSync(conformerSolvationJsonPath)) {
    fs.copyFileSync(conformerSolvationJsonPath, path.join(chemistryDestDir, 'conformer-solvation.json'));
  }
  copyTreePreservingSymlinks(pythonToolchainRoot, path.join(chemistryDestDir, 'python'));
  copyTreePreservingSymlinks(pythonDepsRoot, path.join(chemistryDestDir, 'deps'));

  fs.writeFileSync(path.join(chemistryDestDir, 'bootstrap.py'), buildChemistryBootstrapScript(), { encoding: 'utf8', mode: 0o644 });
  const chemistryEnginePath = path.join(chemistryDestDir, 'engine');
  fs.writeFileSync(chemistryEnginePath, buildChemistryEngineLauncherScript(), { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(chemistryEnginePath, 0o755);

  const xtbDestDir = path.join(resourcesPath, 'xtb');
  removeTreeForce(xtbDestDir);
  copyTreePreservingSymlinks(xtbSourceRoot, xtbDestDir);
  patchXtbOptimizerFormatBug(path.join(xtbDestDir, 'bin', 'xtb'));
  verifyPackagedXtbOptimization(xtbDestDir, xtbManifest.version, arch);

  if (sign) {
    execFile('codesign', ['--force', '--deep', '--sign', '-', appBundlePath], { stdio: 'inherit' });
  }

  let dmgPath = null;
  if (createDmg) {
    const safeProductSlug = productName.replace(/\s+/g, '-');
    dmgPath = path.join(outputDir, `${safeProductSlug}-${version}-darwin-${arch}.dmg`);
    fs.rmSync(dmgPath, { force: true });
    const dmgStageDir = path.join(outputDir, '.dmg-staging');
    removeTreeForce(dmgStageDir);
    fs.mkdirSync(dmgStageDir, { recursive: true });
    try {
      copyTreePreservingSymlinks(appBundlePath, path.join(dmgStageDir, `${productName}.app`));
      if (process.platform !== 'win32') fs.symlinkSync('/Applications', path.join(dmgStageDir, 'Applications'));
      execFile('hdiutil', ['create', '-volname', productName, '-srcfolder', dmgStageDir, '-ov', '-format', 'UDZO', dmgPath], { stdio: 'inherit' });
    } finally {
      removeTreeForce(dmgStageDir);
    }
  }

  return {
    appBundlePath,
    executablePath: path.join(appBundlePath, 'Contents', 'MacOS', productName),
    resourcesPath,
    appResourcesPath,
    chemistryEnginePath,
    xtbPath: xtbDestDir,
    dmgPath,
  };
}

async function runCli() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const repoRoot = parsed.options.repoRoot ?? DEFAULT_REPO_ROOT;
  if (!parsed.skipBuild) {
    console.log('[package-macos] 🔨 Building frontend production bundle (npm run build)...');
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  const cliPkg = readJsonStrictIfExists(path.join(repoRoot, 'package.json'), 'package.json');
  console.log(`[package-macos] 📦 Assembling ${cliPkg?.productName || 'Lactone Studio'}.app bundle...`);
  const result = assembleMacAppBundle({
    ...parsed.options,
    repoRoot,
    sign: !parsed.skipSign && process.platform === 'darwin',
    createDmg: !parsed.skipDmg && process.platform === 'darwin',
  });
  console.log(`[package-macos] ✅ App bundle ready: ${result.appBundlePath}`);
  if (result.dmgPath) console.log(`[package-macos] 💿 DMG installer ready: ${result.dmgPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error('[package-macos] ❌ Failed:', error.message);
    process.exit(1);
  });
}
