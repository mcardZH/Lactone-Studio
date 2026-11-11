#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_PYTHON_PACKAGES,
  XTB_REQUIRED_PARAMS,
  detectElfArchitecture,
  removeTreeForce,
} from '../native/stage-conda-runtime.mjs';

const require = createRequire(import.meta.url);
const xtbContract = require('../../desktop/xtb-runtime-contract.cjs');

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
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

function makeTreeOwnerWritable(targetPath) {
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

function copyTreeMaterialized(src, dest) {
  const realSrc = fs.realpathSync(src);
  const stat = fs.statSync(realSrc);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(realSrc)) {
      copyTreeMaterialized(path.join(realSrc, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(realSrc, dest);
    if (process.platform !== 'win32') {
      fs.chmodSync(dest, stat.mode & 0o111 ? 0o755 : 0o644);
    }
  }
  makeTreeOwnerWritable(dest);
}

export function buildLinuxChemistryBootstrapScript() {
  return [
    'import os, runpy, sys',
    'for _k in list(os.environ.keys()):',
    '    if _k.upper().startswith("_PYTHON_"):',
    '        os.environ.pop(_k, None)',
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

export function buildLinuxChemistryEngineLauncherScript() {
  return [
    '#!/bin/sh',
    'set -e',
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"',
    'unset LD_PRELOAD PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE VIRTUAL_ENV CONDA_PREFIX CONDA_DEFAULT_ENV _PYTHON_SYSCONFIGDATA_NAME RDBASE',
    'export PYTHONNOUSERSITE=1',
    'export PYTHONDONTWRITEBYTECODE=1',
    'export LD_LIBRARY_PATH="$DIR/deps/lib:$DIR/python/lib"',
    'exec "$DIR/python/bin/python3" -I -S -B "$DIR/bootstrap.py" "$@"',
    '',
  ].join('\n');
}

export function buildLinuxElectronWrapperScript(binaryName = 'lactone-studio-bin') {
  return [
    '#!/bin/sh',
    'set -e',
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"',
    'EXTRA_FLAGS=""',
    'if [ ! -u "$DIR/chrome-sandbox" ] || [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then',
    '  EXTRA_FLAGS="--no-sandbox"',
    'fi',
    'if [ -n "$EXTRA_FLAGS" ]; then',
    `  exec "$DIR/${binaryName}" "$EXTRA_FLAGS" "$@"`,
    'fi',
    `exec "$DIR/${binaryName}" "$@"`,
    '',
  ].join('\n');
}

export function buildLinuxDesktopEntry({ productName = 'Lactone Studio' } = {}) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${productName}`,
    'Comment=Computational Chemistry & Molecular Modeling Workbench (Unofficial Modified Version)',
    'Exec=lactone-studio %F',
    'Icon=lactone-studio',
    'Terminal=false',
    'Categories=Science;Chemistry;Education;',
    'StartupWMClass=sciyue-input-studio',
    '',
  ].join('\n');
}

export function buildAppRunScript() {
  return [
    '#!/bin/sh',
    'set -e',
    'APPDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"',
    'exec "$APPDIR/opt/lactone-studio/lactone-studio" "$@"',
    '',
  ].join('\n');
}

export function buildLinuxInstallGuideText({
  productName = 'Lactone Studio',
  version = '2.0.3',
  arch = 'x64',
} = {}) {
  return [
    '================================================================================',
    `${productName} v${version} — Linux 安装与使用说明 (Installation Guide)`,
    `适用架构 (Target Architecture): Linux x86_64 (linux-${arch}, glibc >= 2.28)`,
    '================================================================================',
    '',
    '【一、非官方修改版重要声明（遵循 LICENSE.txt 第七条）】',
    `- 本软件（${productName}）是基于 Ester Studio (ES) v${version} 源码改造的「非官方修改版」`,
    '  (Unofficial Modified Version)。',
    '- 修改者与维护仓库：mcardZH (https://github.com/mcardZH/Lactone-Studio)',
    '- 上游官方项目与原作者：Ester Studio (ES)，原始作者 Zixuan Zhang (ddwz@sciyue.cn)，',
    '  官方仓库 https://github.com/Ahey1/Ester-Studio',
    '- 免责声明：本修改版由社区维护，未获得原始作者审核、科学验证、支持或商业认可。',
    '',
    '--------------------------------------------------------------------------------',
    '【二、Linux 启动方式（任选其一）】',
    '',
    `方式 A：使用单文件 .AppImage（推荐）：`,
    `   chmod +x Lactone-Studio-${version}-linux-${arch}.AppImage`,
    `   ./Lactone-Studio-${version}-linux-${arch}.AppImage`,
    '   （若系统未安装 libfuse2，可运行 `sudo apt install libfuse2t64` 或附加 `--appimage-extract-and-run` 参数启动。）',
    '',
    '方式 B：使用免安装 .tar.gz 便携包：',
    `   tar -xzf Lactone-Studio-${version}-linux-${arch}.tar.gz`,
    `   ./Lactone-Studio-${version}-linux-${arch}/lactone-studio`,
    '',
    '内置科学计算环境：',
    '   应用包内部已打包完整的 Python 3.12 科学计算栈（RDKit、ASE、Spglib、tblite、SciPy、NumPy）',
    '   以及 Linux 原生 GNU xTB 半经验计算程序，无需在本机额外配置 Conda 环境。',
    '',
    '--------------------------------------------------------------------------------',
    '【三、外部可选工具与远程超算配置】',
    '',
    '- Multiwfn（波函数与等值面分析，可选）：',
    '  在软件左上角「LS（全局设置）」->「工具与文件」中选择本机 Linux 版 Multiwfn 可执行文件。',
    '- 远程 Linux 超算连接：',
    '  在左侧「任务中心」->「运行环境」中配置远程 SSH 直连或 SSH + Slurm 调度队列运行 Gaussian / ORCA。',
    '',
    '--------------------------------------------------------------------------------',
    '【四、科研引用与许可协议提示（遵循 LICENSE.txt）】',
    '',
    '- 科研引用（第八条）：发表论文时须明确引用原作者 Zixuan Zhang 的 Ester Studio。',
    '- 禁止商业售卖（第四条）：严禁以任何名义销售本软件或修改版的源码、程序及安装包副本。',
    '================================================================================',
    '',
  ].join('\n');
}

function validateElfTreeArch(rootDir, expectedArch, label) {
  if (fs.lstatSync(rootDir).isSymbolicLink()) {
    throw new Error(`Invalid packaging input (${label} root must not be a symlink): ${rootDir}`);
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    const isBinDir = path.basename(cur) === 'bin';
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Unexpected symlink in ${label}: ${full}`);
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isBinDir || entry.name.endsWith('.so') || entry.name.includes('.so.')) {
        const arch = detectElfArchitecture(full);
        if (arch !== null && arch !== expectedArch) {
          throw new Error(
            `ELF binary architecture mismatch in ${label} (${full}): expected linux-${expectedArch}, found ${arch}`,
          );
        }
      }
    }
  }
}

function patchXtbLinuxFormatBugIfPresent(xtbBinPath) {
  if (!fs.existsSync(xtbBinPath) || detectElfArchitecture(xtbBinPath) === null) return false;
  const rawLatin1 = fs.readFileSync(xtbBinPath).toString('latin1');
  if (!rawLatin1.includes(XTB_BROKEN_OPT_FORMAT)) return false;
  const patched = Buffer.from(rawLatin1.replaceAll(XTB_BROKEN_OPT_FORMAT, XTB_FIXED_OPT_FORMAT), 'latin1');
  fs.chmodSync(xtbBinPath, 0o755);
  fs.writeFileSync(xtbBinPath, patched);
  return true;
}

function runLinuxLiveSmokeProbes(chemistryDestDir, xtbDestDir, expectedXtbVersion) {
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const pyBin = path.join(chemistryDestDir, 'python', 'bin', 'python3');
  if (detectElfArchitecture(pyBin) === null) return;

  const pySmoke = spawnSync(
    pyBin,
    [
      '-I',
      '-S',
      '-B',
      '-c',
      `import sys; sp = ${JSON.stringify(path.join(chemistryDestDir, 'deps', 'lib', 'python3.12', 'site-packages'))}; sys.path = [sp] + [p for p in sys.path if p]; import numpy, rdkit, scipy, ase, spglib, tblite`,
    ],
    {
      env: {
        PATH: '/usr/bin:/bin',
        LD_LIBRARY_PATH: `${path.join(chemistryDestDir, 'deps', 'lib')}:${path.join(chemistryDestDir, 'python', 'lib')}`,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      encoding: 'utf8',
      timeout: 45000,
    },
  );
  if (pySmoke.error || pySmoke.status !== 0) {
    throw new Error(
      `Linux Python scientific import smoke probe failed: ${(pySmoke.stderr || pySmoke.error?.message || '').trim()}`,
    );
  }

  const xtbBin = path.join(xtbDestDir, 'bin', 'xtb');
  if (detectElfArchitecture(xtbBin) === null) return;
  const probeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ester-linux-xtb-probe-'));
  try {
    fs.writeFileSync(
      path.join(probeDir, 'h2o.xyz'),
      '3\nwater\nO 0.000000 0.000000 0.000000\nH 0.960000 0.000000 0.000000\nH -0.240000 0.930000 0.000000\n',
      'utf8',
    );
    const res = spawnSync(xtbBin, ['h2o.xyz', '--opt', '--gfn', '2'], {
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
        OPENBLAS_NUM_THREADS: '1',
      },
      encoding: 'utf8',
      timeout: 45000,
    });
    if (res.error || res.status !== 0 || !fs.existsSync(path.join(probeDir, 'xtbopt.xyz'))) {
      throw new Error(
        `Packaged Linux xTB optimization smoke probe failed (exit ${res.status}): ${(res.stderr || res.error?.message || '').trim()}`,
      );
    }
    const verMatch = /\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)/i.exec(`${res.stdout || ''}\n${res.stderr || ''}`);
    if (expectedXtbVersion && verMatch && verMatch[1] !== expectedXtbVersion) {
      throw new Error(
        `Packaged Linux xTB version mismatch: expected ${expectedXtbVersion}, got ${verMatch[1]}`,
      );
    }
  } finally {
    removeTreeForce(probeDir);
  }
}

export function prepareLinuxAppDir({ portableDirPath, appDirPath, productName, brandIconPath }) {
  removeTreeForce(appDirPath);
  fs.mkdirSync(appDirPath, { recursive: true });
  copyTreeMaterialized(portableDirPath, path.join(appDirPath, 'opt', 'lactone-studio'));

  const appRunPath = path.join(appDirPath, 'AppRun');
  fs.writeFileSync(appRunPath, buildAppRunScript(), { encoding: 'utf8', mode: 0o755 });
  if (process.platform !== 'win32') fs.chmodSync(appRunPath, 0o755);

  const desktopEntryPath = path.join(appDirPath, 'lactone-studio.desktop');
  fs.writeFileSync(desktopEntryPath, buildLinuxDesktopEntry({ productName }), {
    encoding: 'utf8',
    mode: 0o644,
  });

  if (brandIconPath && fs.existsSync(brandIconPath)) {
    fs.copyFileSync(brandIconPath, path.join(appDirPath, 'lactone-studio.png'));
    fs.copyFileSync(brandIconPath, path.join(appDirPath, '.DirIcon'));
  }

  return appDirPath;
}

function resolveAppImageTool(explicitToolPath) {
  if (explicitToolPath) {
    if (!fs.existsSync(explicitToolPath)) {
      throw new Error(`Explicit --appimagetool binary does not exist: ${explicitToolPath}`);
    }
    return explicitToolPath;
  }
  for (const candidate of ['appimagetool', 'appimagetool-x86_64.AppImage']) {
    const check = spawnSync(candidate, ['--version'], {
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
      stdio: 'pipe',
    });
    if (!check.error && check.status === 0) return candidate;
  }
  return null;
}

export function resolveDefaultLinuxRuntimeSources(repoRoot = DEFAULT_REPO_ROOT) {
  return {
    pythonToolchainRoot: path.join(repoRoot, '.local/toolchains/linux-x64/conda-py312-x64/python'),
    pythonDepsRoot: path.join(repoRoot, '.local/dependencies/linux-x64/conda-chem-x64/python'),
    xtbSourceRoot: path.join(repoRoot, '.local/dependencies/linux-x64/conda-chem-x64/xtb'),
  };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const result = { skipBuild: false, skipTarGz: false, skipAppImage: false, options: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-build') {
      result.skipBuild = true;
      continue;
    }
    if (arg === '--skip-tar') {
      result.skipTarGz = true;
      continue;
    }
    if (arg === '--skip-appimage') {
      result.skipAppImage = true;
      continue;
    }
    const [key, inlineVal] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const nextVal = inlineVal !== null ? inlineVal : argv[i + 1];
    const consume = () => {
      if (inlineVal === null) i += 1;
      return nextVal;
    };
    if (key === '--repo-root' && nextVal) result.options.repoRoot = path.resolve(consume());
    else if (key === '--output-dir' && nextVal) result.options.outputDir = path.resolve(consume());
    else if (key === '--electron-dist' && nextVal) result.options.electronDistPath = path.resolve(consume());
    else if (key === '--python-toolchain-root' && nextVal) result.options.pythonToolchainRoot = path.resolve(consume());
    else if (key === '--python-deps-root' && nextVal) result.options.pythonDepsRoot = path.resolve(consume());
    else if (key === '--xtb-source-root' && nextVal) result.options.xtbSourceRoot = path.resolve(consume());
    else if (key === '--appimagetool' && nextVal) result.options.appImageToolPath = path.resolve(consume());
  }
  return result;
}

export function assembleLinuxPortableBundle(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const defaults = resolveDefaultLinuxRuntimeSources(repoRoot);
  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`Missing required packaging input (package.json): ${pkgJsonPath}`);
  }
  const repoPkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  const {
    outputDir = path.join(repoRoot, 'release', 'linux-x64'),
    electronDistPath = path.join(repoRoot, 'node_modules/electron/dist'),
    pythonToolchainRoot = defaults.pythonToolchainRoot,
    pythonDepsRoot = defaults.pythonDepsRoot,
    xtbSourceRoot = defaults.xtbSourceRoot,
    appImageToolPath = null,
    productName = repoPkg?.productName || 'Lactone Studio',
    version = repoPkg?.version || '2.0.3',
    createTarGz = false,
    createAppImage = false,
    execFile = execFileSync,
  } = options;

  const arch = 'x64';
  const distDir = path.join(repoRoot, 'dist');
  const desktopDir = path.join(repoRoot, 'desktop');
  const chemistrySrcDir = path.join(desktopDir, 'chemistry');
  const conformerSolvationJsonPath = path.join(repoRoot, 'src', 'data', 'conformer-solvation.json');
  const licensePath = path.join(repoRoot, 'LICENSE.txt');
  const brandIconPath = path.join(repoRoot, 'public', 'brand-icon.png');
  const nodeModulesDir = path.join(repoRoot, 'node_modules');

  for (const [label, targetPath] of [
    ['LICENSE.txt', licensePath],
    ['node_modules directory', nodeModulesDir],
    ['ssh2 runtime dependency', path.join(nodeModulesDir, 'ssh2', 'package.json')],
    ['Electron dist directory', electronDistPath],
    ['Electron executable (electron)', path.join(electronDistPath, 'electron')],
    ['frontend dist directory', distDir],
    ['frontend dist index.html', path.join(distDir, 'index.html')],
    ['desktop directory', desktopDir],
    ['desktop main.cjs', path.join(desktopDir, 'main.cjs')],
    ['chemistry source directory', chemistrySrcDir],
    ['chemistry engine.py', path.join(chemistrySrcDir, 'engine.py')],
    ['conformer solvation data', conformerSolvationJsonPath],
    ['Python toolchain directory', pythonToolchainRoot],
    ['Python executable (bin/python3)', path.join(pythonToolchainRoot, 'bin', 'python3')],
    ['Python stdlib (lib/python3.12/os.py)', path.join(pythonToolchainRoot, 'lib', 'python3.12', 'os.py')],
    ['Python dependencies directory', pythonDepsRoot],
    ['xTB runtime directory', xtbSourceRoot],
    ['xTB runtime.json manifest', path.join(xtbSourceRoot, 'runtime.json')],
  ]) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Missing required packaging input (${label}): ${targetPath}`);
    }
  }

  const runtimePackages = collectTransitiveDependencies(nodeModulesDir, ['ssh2']);
  const sitePackagesDir = path.join(pythonDepsRoot, 'lib', 'python3.12', 'site-packages');
  for (const pkgName of REQUIRED_PYTHON_PACKAGES) {
    const pkgPath = path.join(sitePackagesDir, pkgName);
    if (!fs.existsSync(pkgPath)) {
      throw new Error(`Missing required packaging input (Python scientific package ${pkgName}): ${pkgPath}`);
    }
  }

  const electronElfArch = detectElfArchitecture(path.join(electronDistPath, 'electron'));
  if (electronElfArch !== null && electronElfArch !== arch) {
    throw new Error(`Electron ELF architecture mismatch: expected linux-${arch}, found ${electronElfArch}`);
  }
  validateElfTreeArch(pythonToolchainRoot, arch, 'Python toolchain');
  validateElfTreeArch(pythonDepsRoot, arch, 'Python scientific dependencies');
  validateElfTreeArch(xtbSourceRoot, arch, 'xTB runtime');

  const xtbManifestPath = path.join(xtbSourceRoot, 'runtime.json');
  const xtbManifest = xtbContract.validateDescriptor(JSON.parse(fs.readFileSync(xtbManifestPath, 'utf8')));
  if (
    xtbManifest.schema !== 'sciyue-xtb-bundled-runtime/v1' ||
    xtbManifest.platform !== 'linux-x64' ||
    xtbManifest.entry !== 'bin/xtb'
  ) {
    throw new Error(
      `Invalid Linux xTB runtime.json (${xtbManifestPath}): expected schema sciyue-xtb-bundled-runtime/v1, platform linux-x64, entry bin/xtb`,
    );
  }
  xtbContract.ordinary(xtbSourceRoot, 'bin/xtb');
  for (const paramFile of XTB_REQUIRED_PARAMS) {
    xtbContract.ordinary(xtbSourceRoot, `share/xtb/${paramFile}`);
  }
  for (const relLib of xtbContract.LINUX_V1_LIBRARIES) {
    xtbContract.ordinary(xtbSourceRoot, relLib);
  }

  const safeProductSlug = productName.replace(/\s+/g, '-');
  const bundleFolderName = `${safeProductSlug}-${version}-linux-${arch}`;
  const portableDirPath = path.join(outputDir, bundleFolderName);
  fs.mkdirSync(outputDir, { recursive: true });
  removeTreeForce(portableDirPath);

  copyTreeMaterialized(electronDistPath, portableDirPath);
  const oldElectronBin = path.join(portableDirPath, 'electron');
  const renamedElectronBin = path.join(portableDirPath, 'lactone-studio-bin');
  fs.renameSync(oldElectronBin, renamedElectronBin);
  if (process.platform !== 'win32') fs.chmodSync(renamedElectronBin, 0o755);

  const wrapperContent = buildLinuxElectronWrapperScript('lactone-studio-bin');
  const mainLauncherPath = path.join(portableDirPath, 'lactone-studio');
  fs.writeFileSync(mainLauncherPath, wrapperContent, { encoding: 'utf8', mode: 0o755 });
  if (process.platform !== 'win32') fs.chmodSync(mainLauncherPath, 0o755);

  fs.rmSync(path.join(portableDirPath, 'resources', 'default_app.asar'), { force: true });

  fs.copyFileSync(licensePath, path.join(portableDirPath, 'LICENSE.txt'));
  const repoLicensesDir = path.join(repoRoot, 'licenses');
  if (fs.existsSync(repoLicensesDir)) {
    copyTreeMaterialized(repoLicensesDir, path.join(portableDirPath, 'licenses'));
  }
  if (fs.existsSync(brandIconPath)) {
    fs.copyFileSync(brandIconPath, path.join(portableDirPath, 'lactone-studio.png'));
  }
  fs.writeFileSync(
    path.join(portableDirPath, 'lactone-studio.desktop'),
    buildLinuxDesktopEntry({ productName }),
    'utf8',
  );

  const resourcesPath = path.join(portableDirPath, 'resources');
  const appResourcesPath = path.join(resourcesPath, 'app');
  removeTreeForce(appResourcesPath);
  fs.mkdirSync(appResourcesPath, { recursive: true });

  fs.copyFileSync(pkgJsonPath, path.join(appResourcesPath, 'package.json'));
  fs.copyFileSync(licensePath, path.join(appResourcesPath, 'LICENSE.txt'));
  copyTreeMaterialized(distDir, path.join(appResourcesPath, 'dist'));
  copyTreeMaterialized(desktopDir, path.join(appResourcesPath, 'desktop'));
  const appDataDir = path.join(appResourcesPath, 'src', 'data');
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.copyFileSync(conformerSolvationJsonPath, path.join(appDataDir, 'conformer-solvation.json'));
  if (fs.existsSync(repoLicensesDir)) {
    copyTreeMaterialized(repoLicensesDir, path.join(appResourcesPath, 'licenses'));
  }
  for (const pkgName of runtimePackages) {
    copyTreeMaterialized(
      path.join(nodeModulesDir, pkgName),
      path.join(appResourcesPath, 'node_modules', pkgName),
    );
  }

  const chemistryDestDir = path.join(resourcesPath, 'chemistry');
  removeTreeForce(chemistryDestDir);
  copyTreeMaterialized(chemistrySrcDir, chemistryDestDir);
  fs.copyFileSync(conformerSolvationJsonPath, path.join(chemistryDestDir, 'conformer-solvation.json'));
  copyTreeMaterialized(pythonToolchainRoot, path.join(chemistryDestDir, 'python'));
  copyTreeMaterialized(pythonDepsRoot, path.join(chemistryDestDir, 'deps'));
  fs.writeFileSync(
    path.join(chemistryDestDir, 'bootstrap.py'),
    buildLinuxChemistryBootstrapScript(),
    { encoding: 'utf8', mode: 0o644 },
  );
  const chemistryEnginePath = path.join(chemistryDestDir, 'engine');
  fs.writeFileSync(chemistryEnginePath, buildLinuxChemistryEngineLauncherScript(), {
    encoding: 'utf8',
    mode: 0o755,
  });
  if (process.platform !== 'win32') fs.chmodSync(chemistryEnginePath, 0o755);

  const xtbDestDir = path.join(resourcesPath, 'xtb');
  removeTreeForce(xtbDestDir);
  copyTreeMaterialized(xtbSourceRoot, xtbDestDir);
  patchXtbLinuxFormatBugIfPresent(path.join(xtbDestDir, 'bin', 'xtb'));
  if (process.platform !== 'win32') fs.chmodSync(path.join(xtbDestDir, 'bin', 'xtb'), 0o755);

  runLinuxLiveSmokeProbes(chemistryDestDir, xtbDestDir, xtbManifest.version);

  const installGuideFileName = '安装说明 (INSTALL).txt';
  const installGuideText = buildLinuxInstallGuideText({ productName, version, arch });
  const installGuidePath = path.join(outputDir, installGuideFileName);
  fs.writeFileSync(installGuidePath, installGuideText, 'utf8');
  fs.writeFileSync(path.join(portableDirPath, installGuideFileName), installGuideText, 'utf8');

  let tarGzPath = null;
  if (createTarGz) {
    tarGzPath = path.join(outputDir, `${bundleFolderName}.tar.gz`);
    fs.rmSync(tarGzPath, { force: true });
    execFile('tar', ['-czf', tarGzPath, '-C', outputDir, bundleFolderName], { stdio: 'inherit' });
  }

  let appImagePath = null;
  if (createAppImage) {
    const tool = resolveAppImageTool(appImageToolPath);
    if (!tool) {
      throw new Error(
        'appimagetool not found: pass --appimagetool <path> or install appimagetool-x86_64.AppImage on PATH',
      );
    }
    appImagePath = path.join(outputDir, `${bundleFolderName}.AppImage`);
    fs.rmSync(appImagePath, { force: true });
    const appDirPath = path.join(outputDir, '.appdir-staging');
    try {
      prepareLinuxAppDir({
        portableDirPath,
        appDirPath,
        productName,
        brandIconPath: fs.existsSync(brandIconPath) ? brandIconPath : null,
      });
      execFile(tool, ['--no-appstream', appDirPath, appImagePath], {
        env: { ...process.env, ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' },
        stdio: 'inherit',
      });
      if (process.platform !== 'win32' && fs.existsSync(appImagePath)) {
        fs.chmodSync(appImagePath, 0o755);
      }
    } finally {
      removeTreeForce(appDirPath);
    }
  }

  return {
    portableDirPath,
    executablePath: mainLauncherPath,
    electronBinaryPath: renamedElectronBin,
    resourcesPath,
    appResourcesPath,
    chemistryEnginePath,
    xtbPath: xtbDestDir,
    installGuidePath,
    tarGzPath,
    appImagePath,
  };
}

async function runCli() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const repoRoot = parsed.options.repoRoot ?? DEFAULT_REPO_ROOT;
  if (!parsed.skipBuild) {
    console.log('[package-linux] 🔨 Building frontend production bundle (npm run build)...');
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
  const result = assembleLinuxPortableBundle({
    ...parsed.options,
    repoRoot,
    createTarGz: !parsed.skipTarGz,
    createAppImage: !parsed.skipAppImage && process.platform === 'linux',
  });
  console.log(`[package-linux] ✅ Portable directory ready: ${result.portableDirPath}`);
  if (result.tarGzPath) console.log(`[package-linux] 📦 Tarball ready: ${result.tarGzPath}`);
  if (result.appImagePath) console.log(`[package-linux] 🚀 AppImage ready: ${result.appImagePath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((error) => {
    console.error('[package-linux] ❌ Failed:', error.message);
    process.exit(1);
  });
}
