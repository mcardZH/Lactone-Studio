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

export function assembleMacAppBundle(options = {}) {
  const {
    repoRoot = DEFAULT_REPO_ROOT,
    arch = process.arch,
    outputDir = path.join(repoRoot, 'release', `darwin-${arch}`),
    electronAppPath = path.join(repoRoot, 'node_modules/electron/dist/Electron.app'),
    pythonToolchainRoot = path.join(
      repoRoot,
      `.local/toolchains/darwin-${arch}/conda-py312-${arch}/python`,
    ),
    pythonDepsRoot = path.join(
      repoRoot,
      `.local/dependencies/darwin-${arch}/conda-chem-${arch}/python`,
    ),
    xtbSourceRoot = path.join(
      repoRoot,
      `.local/dependencies/darwin-${arch}/conda-chem-${arch}/xtb`,
    ),
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
    ['frontend dist directory', distDir],
    ['desktop directory', desktopDir],
    ['chemistry source directory', chemistrySrcDir],
    ['Python toolchain directory', pythonToolchainRoot],
    ['Python dependencies directory', pythonDepsRoot],
    ['xTB runtime directory', xtbSourceRoot],
  ]) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Missing required packaging input (${label}): ${targetPath}`);
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
  const args = new Set(process.argv.slice(2));
  const skipBuild = args.has('--skip-build');
  const skipDmg = args.has('--skip-dmg');
  const skipSign = args.has('--skip-sign');

  if (!skipBuild) {
    console.log('[package-macos] 🔨 Building frontend production bundle (npm run build)...');
    execFileSync('npm', ['run', 'build'], { cwd: DEFAULT_REPO_ROOT, stdio: 'inherit' });
  }

  console.log('[package-macos] 📦 Assembling Ester Studio.app bundle...');
  const result = assembleMacAppBundle({
    repoRoot: DEFAULT_REPO_ROOT,
    sign: !skipSign && process.platform === 'darwin',
    createDmg: !skipDmg && process.platform === 'darwin',
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
