import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const HELPER_SUFFIXES = Object.freeze(['', ' (GPU)', ' (Plugin)', ' (Renderer)']);

function collectTransitiveDependencies(nodeModulesDir, rootPackageNames) {
  const seen = new Set();
  function visit(pkgName) {
    if (seen.has(pkgName)) return;
    const pkgJsonPath = path.join(nodeModulesDir, pkgName, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return;
    seen.add(pkgName);
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const deps = {
      ...(pkgJson.dependencies || {}),
      ...(pkgJson.optionalDependencies || {}),
    };
    for (const depName of Object.keys(deps)) {
      visit(depName);
    }
  }
  for (const name of rootPackageNames) {
    visit(name);
  }
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
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (pattern.test(plistContent)) {
    return plistContent.replace(pattern, `$1${value}$3`);
  }
  return plistContent;
}

function rebrandElectronBundle(appBundlePath, productName, bundleId, version) {
  const contentsDir = path.join(appBundlePath, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const oldMainBin = path.join(macosDir, 'Electron');
  const newMainBin = path.join(macosDir, productName);
  if (fs.existsSync(oldMainBin) && oldMainBin !== newMainBin) {
    fs.renameSync(oldMainBin, newMainBin);
  }

  const infoPlistPath = path.join(contentsDir, 'Info.plist');
  if (fs.existsSync(infoPlistPath)) {
    let plist = fs.readFileSync(infoPlistPath, 'utf8');
    plist = updatePlistStringKey(plist, 'CFBundleExecutable', productName);
    plist = updatePlistStringKey(plist, 'CFBundleName', productName);
    plist = updatePlistStringKey(plist, 'CFBundleDisplayName', productName);
    plist = updatePlistStringKey(plist, 'CFBundleIdentifier', bundleId);
    plist = updatePlistStringKey(plist, 'CFBundleShortVersionString', version);
    plist = updatePlistStringKey(plist, 'CFBundleVersion', version);
    fs.writeFileSync(infoPlistPath, plist, 'utf8');
  }

  const frameworksDir = path.join(contentsDir, 'Frameworks');
  if (fs.existsSync(frameworksDir)) {
    for (const suffix of HELPER_SUFFIXES) {
      const oldHelperName = `Electron Helper${suffix}`;
      const newHelperName = `${productName} Helper${suffix}`;
      const oldHelperApp = path.join(frameworksDir, `${oldHelperName}.app`);
      if (!fs.existsSync(oldHelperApp)) continue;

      const helperMacosDir = path.join(oldHelperApp, 'Contents', 'MacOS');
      const oldHelperBin = path.join(helperMacosDir, oldHelperName);
      const newHelperBin = path.join(helperMacosDir, newHelperName);
      if (fs.existsSync(oldHelperBin) && oldHelperBin !== newHelperBin) {
        fs.renameSync(oldHelperBin, newHelperBin);
      }

      const helperPlistPath = path.join(oldHelperApp, 'Contents', 'Info.plist');
      if (fs.existsSync(helperPlistPath)) {
        let helperPlist = fs.readFileSync(helperPlistPath, 'utf8');
        helperPlist = updatePlistStringKey(helperPlist, 'CFBundleExecutable', newHelperName);
        helperPlist = updatePlistStringKey(helperPlist, 'CFBundleName', newHelperName);
        helperPlist = updatePlistStringKey(helperPlist, 'CFBundleDisplayName', newHelperName);
        helperPlist = updatePlistStringKey(helperPlist, 'CFBundleIdentifier', `${bundleId}.helper`);
        fs.writeFileSync(helperPlistPath, helperPlist, 'utf8');
      }

      const newHelperApp = path.join(frameworksDir, `${newHelperName}.app`);
      if (oldHelperApp !== newHelperApp) {
        fs.renameSync(oldHelperApp, newHelperApp);
      }
    }
  }
}

export function buildChemistryBootstrapScript() {
  return [
    'import os',
    'import runpy',
    'import site',
    'import sys',
    '',
    'root = os.path.dirname(os.path.abspath(__file__))',
    "site_packages = os.path.join(root, 'deps', 'lib', 'python3.12', 'site-packages')",
    "rdkit_share = os.path.join(site_packages, 'rdkit', 'share', 'RDKit')",
    'if not os.path.isdir(rdkit_share):',
    "    rdkit_share = os.path.join(root, 'deps', 'share', 'RDKit')",
    "os.environ['RDBASE'] = rdkit_share",
    "os.environ['RDKIT_DATA_DIR'] = os.path.join(rdkit_share, 'Data')",
    "os.environ['PYTHONNOUSERSITE'] = '1'",
    "os.environ['PYTHONDONTWRITEBYTECODE'] = '1'",
    '',
    'sys.path = [p for p in sys.path if p]',
    'sys.path.insert(0, site_packages)',
    'sys.path.insert(0, root)',
    'site.ENABLE_USER_SITE = False',
    'site.main()',
    '',
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
    if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
      return [cputypeToArch(buf.readInt32LE(4))];
    }
    if (magic === 0xfeedfacf || magic === 0xfeedface) {
      return [cputypeToArch(buf.readInt32BE(4))];
    }
    if (magic === 0xcafebabe) {
      const nfat = buf.readUInt32BE(4);
      if (nfat > 0 && nfat <= 16 && bytesRead >= 8 + nfat * 20) {
        const archs = [];
        for (let i = 0; i < nfat; i += 1) {
          archs.push(cputypeToArch(buf.readInt32BE(8 + i * 20)));
        }
        return archs;
      }
    }
    if (magic === 0xbebafeca) {
      const nfat = buf.readUInt32LE(4);
      if (nfat > 0 && nfat <= 16 && bytesRead >= 8 + nfat * 20) {
        const archs = [];
        for (let i = 0; i < nfat; i += 1) {
          archs.push(cputypeToArch(buf.readInt32LE(8 + i * 20)));
        }
        return archs;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function validateExecutableFile(filePath, expectedArch, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required packaging input (${label}): ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Invalid packaging input (${label} is not a file): ${filePath}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    throw new Error(`Invalid packaging input (${label} is not executable): ${filePath}`);
  }
  const archs = detectMachOArchitectures(filePath);
  if (archs !== null && !archs.includes(expectedArch)) {
    throw new Error(
      `Binary architecture mismatch for ${label} (${filePath}): expected darwin-${expectedArch}, found [${archs.join(', ')}]`,
    );
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

export function resolveDefaultMacRuntimeSources(repoRoot = DEFAULT_REPO_ROOT, arch = process.arch) {
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported macOS architecture: ${arch}`);
  }
  const platformId = `darwin-${arch}`;
  const explicitProfilePath = path.join(repoRoot, `desktop/packaging/native-profile.${platformId}.json`);
  const fallbackProfilePath = path.join(repoRoot, 'desktop/packaging/native-profile.json');

  let profile = null;
  if (fs.existsSync(explicitProfilePath)) {
    profile = readJsonStrictIfExists(explicitProfilePath, `native profile (${platformId})`);
    if (!profile || profile.platform !== platformId) {
      throw new Error(
        `Invalid native profile platform in ${explicitProfilePath}: expected ${platformId}, got ${profile?.platform}`,
      );
    }
  } else if (fs.existsSync(fallbackProfilePath)) {
    const candidate = readJsonStrictIfExists(fallbackProfilePath, 'native profile');
    if (candidate?.platform === platformId) {
      profile = candidate;
    }
  }

  const tcLockRel =
    profile?.toolchainLock || `desktop/packaging/native-toolchain.${platformId}.lock.json`;
  const rtLockRel =
    profile?.runtimeLock || `desktop/packaging/native-runtime.${platformId}.lock.json`;
  const xtbLockRel =
    profile?.xtbLock || `desktop/packaging/xtb-runtime.${platformId}.lock.json`;

  const tcLockPath = path.join(repoRoot, tcLockRel);
  const rtLockPath = path.join(repoRoot, rtLockRel);
  const xtbLockPath = path.join(repoRoot, xtbLockRel);

  if (profile) {
    for (const [label, lockPath] of [
      ['toolchain lock', tcLockPath],
      ['runtime lock', rtLockPath],
      ['xTB lock', xtbLockPath],
    ]) {
      if (!fs.existsSync(lockPath)) {
        throw new Error(`Missing ${label} declared by native profile: ${lockPath}`);
      }
    }
  }

  const tcLock = readJsonStrictIfExists(tcLockPath, 'toolchain lock');
  const rtLock = readJsonStrictIfExists(rtLockPath, 'runtime lock');
  const xtbLock = readJsonStrictIfExists(xtbLockPath, 'xTB lock');

  for (const [label, lockObj, lockPath] of [
    ['toolchain lock', tcLock, tcLockPath],
    ['runtime lock', rtLock, rtLockPath],
    ['xTB lock', xtbLock, xtbLockPath],
  ]) {
    if (lockObj) {
      if (lockObj.platform !== platformId || typeof lockObj.root !== 'string' || !lockObj.root) {
        throw new Error(`Invalid ${label} metadata for ${platformId}: ${lockPath}`);
      }
    }
  }

  const pickFallback = (candidates) => {
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return candidates[0];
  };

  const pythonToolchainRoot = tcLock
    ? path.join(repoRoot, tcLock.root, 'python')
    : pickFallback([
        path.join(repoRoot, `.local/toolchains/${platformId}/conda-py312-${arch}/python`),
        path.join(repoRoot, `.local/toolchains/${platformId}/conda-py312-arm64/python`),
      ]);

  const pythonDepsRoot = rtLock
    ? path.join(repoRoot, rtLock.root, 'python')
    : pickFallback([
        path.join(repoRoot, `.local/dependencies/${platformId}/conda-chem-${arch}/python`),
        path.join(repoRoot, `.local/dependencies/${platformId}/conda-chem-arm64/python`),
      ]);

  const xtbSubdir =
    Array.isArray(xtbLock?.contentDirectories) && xtbLock.contentDirectories[0]
      ? xtbLock.contentDirectories[0]
      : 'xtb';
  const xtbSourceRoot = xtbLock
    ? path.join(repoRoot, xtbLock.root, xtbSubdir)
    : pickFallback([
        path.join(repoRoot, `.local/dependencies/${platformId}/conda-chem-${arch}/xtb`),
        path.join(repoRoot, `.local/dependencies/${platformId}/conda-chem-arm64/xtb`),
      ]);

  return {
    pythonToolchainRoot,
    pythonDepsRoot,
    xtbSourceRoot,
  };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const result = {
    skipBuild: false,
    skipDmg: false,
    skipSign: false,
    options: {},
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-build') {
      result.skipBuild = true;
      continue;
    }
    if (arg === '--skip-dmg') {
      result.skipDmg = true;
      continue;
    }
    if (arg === '--skip-sign') {
      result.skipSign = true;
      continue;
    }
    const [key, inlineVal] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const nextVal = inlineVal !== null ? inlineVal : argv[i + 1];
    const consumeValue = () => {
      if (inlineVal === null) i += 1;
      return nextVal;
    };
    if (key === '--repo-root' && nextVal) result.options.repoRoot = path.resolve(consumeValue());
    else if (key === '--arch' && nextVal) result.options.arch = consumeValue();
    else if (key === '--output-dir' && nextVal) result.options.outputDir = path.resolve(consumeValue());
    else if (key === '--electron-app' && nextVal) result.options.electronAppPath = path.resolve(consumeValue());
    else if (key === '--python-toolchain-root' && nextVal) result.options.pythonToolchainRoot = path.resolve(consumeValue());
    else if (key === '--python-deps-root' && nextVal) result.options.pythonDepsRoot = path.resolve(consumeValue());
    else if (key === '--xtb-source-root' && nextVal) result.options.xtbSourceRoot = path.resolve(consumeValue());
  }
  return result;
}

export function assembleMacAppBundle(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const arch = options.arch ?? process.arch;
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`Unsupported macOS architecture: ${arch}`);
  }
  const needsDefaultSources =
    !options.pythonToolchainRoot || !options.pythonDepsRoot || !options.xtbSourceRoot;
  const defaults = needsDefaultSources
    ? resolveDefaultMacRuntimeSources(repoRoot, arch)
    : {};
  const {
    outputDir = path.join(repoRoot, 'release', `darwin-${arch}`),
    electronAppPath = path.join(repoRoot, 'node_modules/electron/dist/Electron.app'),
    pythonToolchainRoot = defaults.pythonToolchainRoot,
    pythonDepsRoot = defaults.pythonDepsRoot,
    xtbSourceRoot = defaults.xtbSourceRoot,
    productName = 'Ester Studio',
    version = '2.0.2',
    bundleId = 'com.sciyue.esterstudio',
    sign = false,
    createDmg = false,
    execFile = execFileSync,
  } = options;

  const distDir = path.join(repoRoot, 'dist');
  const desktopDir = path.join(repoRoot, 'desktop');
  const chemistrySrcDir = path.join(desktopDir, 'chemistry');

  for (const [label, targetPath] of [
    ['Electron.app template', electronAppPath],
    ['Electron Info.plist', path.join(electronAppPath, 'Contents', 'Info.plist')],
    ['frontend dist directory', distDir],
    ['frontend dist index.html', path.join(distDir, 'index.html')],
    ['desktop directory', desktopDir],
    ['desktop main.cjs', path.join(desktopDir, 'main.cjs')],
    ['chemistry source directory', chemistrySrcDir],
    ['chemistry engine.py', path.join(chemistrySrcDir, 'engine.py')],
    ['Python toolchain directory', pythonToolchainRoot],
    ['Python dependencies directory', pythonDepsRoot],
    [
      'Python RDKit dependency package',
      path.join(pythonDepsRoot, 'lib', 'python3.12', 'site-packages', 'rdkit'),
    ],
    ['xTB runtime directory', xtbSourceRoot],
    ['xTB runtime.json manifest', path.join(xtbSourceRoot, 'runtime.json')],
  ]) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Missing required packaging input (${label}): ${targetPath}`);
    }
  }

  validateExecutableFile(
    path.join(electronAppPath, 'Contents', 'MacOS', 'Electron'),
    arch,
    'Electron executable',
  );
  validateExecutableFile(
    path.join(pythonToolchainRoot, 'bin', 'python3'),
    arch,
    'Python executable (bin/python3)',
  );

  const xtbManifestPath = path.join(xtbSourceRoot, 'runtime.json');
  const xtbManifest = readJsonStrictIfExists(xtbManifestPath, 'xTB runtime.json');
  const expectedPlatformId = `darwin-${arch}`;
  if (
    !xtbManifest ||
    (xtbManifest.schema !== 'sciyue-xtb-bundled-runtime/v1' &&
      xtbManifest.schema !== 'sciyue-xtb-bundled-runtime/v2') ||
    xtbManifest.platform !== expectedPlatformId ||
    xtbManifest.entry !== 'bin/xtb'
  ) {
    throw new Error(
      `Invalid xTB runtime.json manifest (${xtbManifestPath}): expected platform ${expectedPlatformId} and entry bin/xtb`,
    );
  }
  validateExecutableFile(path.join(xtbSourceRoot, 'bin', 'xtb'), arch, 'xTB executable (bin/xtb)');
  for (const relLib of DARWIN_XTB_LIBRARIES) {
    const libPath = path.join(xtbSourceRoot, relLib);
    if (!fs.existsSync(libPath)) {
      throw new Error(`Missing required packaging input (xTB library ${relLib}): ${libPath}`);
    }
  }
  for (const relParam of DARWIN_XTB_PARAMETERS) {
    const paramPath = path.join(xtbSourceRoot, relParam);
    if (!fs.existsSync(paramPath)) {
      throw new Error(`Missing required packaging input (xTB parameter ${relParam}): ${paramPath}`);
    }
  }

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

  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    fs.copyFileSync(pkgJsonPath, path.join(appResourcesPath, 'package.json'));
  }
  const licensePath = path.join(repoRoot, 'LICENSE.txt');
  if (fs.existsSync(licensePath)) {
    fs.copyFileSync(licensePath, path.join(appResourcesPath, 'LICENSE.txt'));
  }

  copyTreePreservingSymlinks(distDir, path.join(appResourcesPath, 'dist'));
  copyTreePreservingSymlinks(desktopDir, path.join(appResourcesPath, 'desktop'));

  const licensesDir = path.join(repoRoot, 'licenses');
  if (fs.existsSync(licensesDir)) {
    copyTreePreservingSymlinks(licensesDir, path.join(appResourcesPath, 'licenses'));
  }

  const ocrRuntimeDir = path.join(repoRoot, 'runtime', 'ocr');
  if (fs.existsSync(ocrRuntimeDir)) {
    copyTreePreservingSymlinks(ocrRuntimeDir, path.join(appResourcesPath, 'runtime', 'ocr'));
  }

  const nodeModulesDir = path.join(repoRoot, 'node_modules');
  if (fs.existsSync(nodeModulesDir)) {
    const runtimePackages = collectTransitiveDependencies(nodeModulesDir, ['ssh2']);
    for (const pkgName of runtimePackages) {
      copyTreePreservingSymlinks(
        path.join(nodeModulesDir, pkgName),
        path.join(appResourcesPath, 'node_modules', pkgName),
      );
    }
  }

  const chemistryDestDir = path.join(resourcesPath, 'chemistry');
  removeTreeForce(chemistryDestDir);
  copyTreePreservingSymlinks(chemistrySrcDir, chemistryDestDir);
  copyTreePreservingSymlinks(pythonToolchainRoot, path.join(chemistryDestDir, 'python'));
  copyTreePreservingSymlinks(pythonDepsRoot, path.join(chemistryDestDir, 'deps'));

  const chemistryBootstrapPath = path.join(chemistryDestDir, 'bootstrap.py');
  fs.writeFileSync(chemistryBootstrapPath, buildChemistryBootstrapScript(), {
    encoding: 'utf8',
    mode: 0o644,
  });

  const chemistryEnginePath = path.join(chemistryDestDir, 'engine');
  fs.writeFileSync(chemistryEnginePath, buildChemistryEngineLauncherScript(), {
    encoding: 'utf8',
    mode: 0o755,
  });
  fs.chmodSync(chemistryEnginePath, 0o755);

  const xtbDestDir = path.join(resourcesPath, 'xtb');
  removeTreeForce(xtbDestDir);
  copyTreePreservingSymlinks(xtbSourceRoot, xtbDestDir);

  if (sign) {
    execFile('codesign', ['--force', '--deep', '--sign', '-', appBundlePath], {
      stdio: 'inherit',
    });
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
      if (process.platform !== 'win32') {
        fs.symlinkSync('/Applications', path.join(dmgStageDir, 'Applications'));
      }
      execFile(
        'hdiutil',
        [
          'create',
          '-volname',
          productName,
          '-srcfolder',
          dmgStageDir,
          '-ov',
          '-format',
          'UDZO',
          dmgPath,
        ],
        { stdio: 'inherit' },
      );
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

  console.log('[package-macos] 📦 Assembling Ester Studio.app bundle...');
  const result = assembleMacAppBundle({
    ...parsed.options,
    repoRoot,
    sign: !parsed.skipSign && process.platform === 'darwin',
    createDmg: !parsed.skipDmg && process.platform === 'darwin',
  });
  console.log(`[package-macos] ✅ App bundle ready: ${result.appBundlePath}`);
  if (result.dmgPath) {
    console.log(`[package-macos] 💿 DMG installer ready: ${result.dmgPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error('[package-macos] ❌ Failed:', error.message);
    process.exit(1);
  });
}
