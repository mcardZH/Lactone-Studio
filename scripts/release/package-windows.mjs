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
  detectPeArchitecture,
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
  }
  makeTreeOwnerWritable(dest);
}

export function buildWindowsChemistryBootstrapScript() {
  return [
    'import os, runpy, sys',
    'for _k in list(os.environ.keys()):',
    '    if _k.upper().startswith("_PYTHON_"):',
    '        os.environ.pop(_k, None)',
    'root = os.path.dirname(os.path.abspath(__file__))',
    "py_root = os.path.join(root, 'python')",
    "site_packages = os.path.join(root, 'deps', 'Lib', 'site-packages')",
    'if not os.path.isdir(site_packages):',
    "    site_packages = os.path.join(root, 'deps', 'lib', 'python3.12', 'site-packages')",
    'if hasattr(os, "add_dll_directory"):',
    '    _handles = []',
    '    for _d in (',
    "        os.path.join(root, 'deps', 'Library', 'bin'),",
    "        os.path.join(py_root, 'Library', 'bin'),",
    "        os.path.join(py_root, 'DLLs'),",
    '        py_root,',
    '    ):',
    '        if os.path.isdir(_d):',
    '            _handles.append(os.add_dll_directory(_d))',
    '    sys._sciyue_dll_handles = _handles',
    "rdkit_share = os.path.join(site_packages, 'rdkit', 'share', 'RDKit')",
    'if not os.path.isdir(rdkit_share):',
    "    rdkit_share = os.path.join(root, 'deps', 'Library', 'share', 'RDKit')",
    "os.environ['RDBASE'] = rdkit_share",
    "os.environ['RDKIT_DATA_DIR'] = os.path.join(rdkit_share, 'Data')",
    "os.environ['PYTHONNOUSERSITE'] = '1'",
    "os.environ['PYTHONDONTWRITEBYTECODE'] = '1'",
    'clean_paths = [',
    '    root,',
    '    site_packages,',
    "    os.path.join(py_root, 'python312.zip'),",
    "    os.path.join(py_root, 'DLLs'),",
    "    os.path.join(py_root, 'Lib'),",
    '    py_root,',
    ']',
    'sys.path[:] = [p for p in clean_paths if os.path.exists(p)]',
    "entry = os.path.join(root, 'engine.py')",
    'sys.argv = [entry, *sys.argv[1:]]',
    "runpy.run_path(entry, run_name='__main__')",
    '',
  ].join('\n');
}

export function buildWindowsInstallGuideText({
  productName = 'Lactone Studio',
  version = '2.0.3',
  arch = 'x64',
} = {}) {
  return [
    '================================================================================',
    `${productName} v${version} — Windows 免安装便携版使用说明 (Installation Guide)`,
    `适用架构 (Target Architecture): Windows 10 / 11 64-bit (win32-${arch})`,
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
    '【二、Windows 启动步骤（免安装开箱即用）】',
    '',
    '1. 完整解压：',
    '   请先将本 .zip 压缩包完整解压到具有读写权限的常规本地磁盘目录（如 D:\\Lactone-Studio），',
    '   切勿直接在压缩包预览窗口中双击运行，也请勿解压在受限只读目录（如 C:\\Program Files）。',
    '',
    '2. 启动主程序：',
    `   打开解压后的文件夹，双击运行「${productName}.exe」。`,
    '   首次启动若遇到 Windows SmartScreen 提示“Windows 已保护你的电脑”，点击「更多信息」->「仍要运行」即可。',
    '',
    '3. 内置科学计算环境（无需额外安装 Python 或 Conda）：',
    '   压缩包内已完整内置独立的 Python 3.12 科学计算栈（RDKit、ASE、Spglib、tblite、SciPy、NumPy）',
    '   以及 Windows 原生 GNU xTB 半经验计算引擎，开箱即可运行分子建模与半经验计算。',
    '',
    '--------------------------------------------------------------------------------',
    '【三、外部可选工具与远程超算配置】',
    '',
    '- Multiwfn（波函数与分子轨道分析，可选）：',
    '  在软件左上角「LS（全局设置）」->「工具与文件」中选择本机 Multiwfn.exe 即可开启轨道/ESP/IGM 分析。',
    '- 远程 Linux 超算与本地 WSL：',
    '  在左侧「任务中心」->「运行环境」中可配置 WSL 或远程 SSH / Slurm 集群运行 Gaussian / ORCA。',
    '',
    '--------------------------------------------------------------------------------',
    '【四、科研引用与许可协议提示（遵循 LICENSE.txt）】',
    '',
    '- 科研引用（第八条）：发表论文时须明确引用原作者 Zixuan Zhang 的 Ester Studio。',
    '- 禁止商业售卖（第四条）：严禁以任何名义销售本软件或修改版的源码、程序及安装包副本。',
    '================================================================================',
    '',
  ].join('\r\n');
}

function validatePeTreeArch(rootDir, expectedArch, label) {
  if (fs.lstatSync(rootDir).isSymbolicLink()) {
    throw new Error(`Invalid packaging input (${label} root must not be a symlink): ${rootDir}`);
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop();
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
      if (/\.(?:exe|dll|pyd)$/i.test(entry.name)) {
        const arch = detectPeArchitecture(full);
        if (arch !== null && arch !== expectedArch) {
          throw new Error(
            `PE binary architecture mismatch in ${label} (${full}): expected win32-${expectedArch}, found ${arch}`,
          );
        }
      }
    }
  }
}

export function compileWindowsEngineLauncher(cSourcePath, outputExePath) {
  fs.mkdirSync(path.dirname(outputExePath), { recursive: true });

  const gccCandidates = [
    'gcc',
    'x86_64-w64-mingw32-gcc',
    'clang',
    'C:\\msys64\\mingw64\\bin\\gcc.exe',
    'C:\\msys64\\ucrt64\\bin\\gcc.exe',
    'C:\\Program Files\\LLVM\\bin\\clang.exe',
  ];
  for (const gccBin of gccCandidates) {
    const probe = spawnSync(gccBin, ['--version'], { stdio: 'pipe' });
    if (!probe.error && probe.status === 0) {
      const compile = spawnSync(
        gccBin,
        ['-O2', cSourcePath, '-lshell32', '-o', outputExePath],
        { encoding: 'utf8', timeout: 60000 },
      );
      if (!compile.error && compile.status === 0 && fs.existsSync(outputExePath)) {
        return { compiler: gccBin };
      }
    }
  }

  const clProbe = spawnSync('cl.exe', [], { stdio: 'pipe' });
  if (!clProbe.error) {
    const tmpObjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ester-win-launcher-'));
    try {
      const compile = spawnSync(
        'cl.exe',
        [
          '/nologo',
          '/O2',
          `/Fo:${path.join(tmpObjDir, 'launcher.obj')}`,
          `/Fe:${outputExePath}`,
          cSourcePath,
          'shell32.lib',
        ],
        { cwd: tmpObjDir, encoding: 'utf8', timeout: 60000 },
      );
      if (!compile.error && compile.status === 0 && fs.existsSync(outputExePath)) {
        return { compiler: 'cl.exe' };
      }
    } finally {
      removeTreeForce(tmpObjDir);
    }
  }

  throw new Error(
    'Unable to compile Windows chemistry engine.exe C launcher (win32-engine-launcher.c): install MinGW-w64 gcc, LLVM clang, or MSVC cl.exe.',
  );
}

function patchXtbWindowsFormatBugIfPresent(xtbExePath) {
  if (!fs.existsSync(xtbExePath) || detectPeArchitecture(xtbExePath) === null) return false;
  const rawLatin1 = fs.readFileSync(xtbExePath).toString('latin1');
  if (!rawLatin1.includes(XTB_BROKEN_OPT_FORMAT)) return false;
  const patched = Buffer.from(rawLatin1.replaceAll(XTB_BROKEN_OPT_FORMAT, XTB_FIXED_OPT_FORMAT), 'latin1');
  fs.writeFileSync(xtbExePath, patched);
  return true;
}

function runWindowsLiveSmokeProbes(chemistryDestDir, xtbDestDir, expectedXtbVersion) {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const pythonExe = path.join(chemistryDestDir, 'python', 'python.exe');
  if (detectPeArchitecture(pythonExe) === null) return;

  const pySmoke = spawnSync(
    pythonExe,
    [
      '-I',
      '-S',
      '-B',
      '-c',
      [
        'import os, sys',
        `root = ${JSON.stringify(chemistryDestDir)}`,
        'for d in (os.path.join(root, "deps", "Library", "bin"), os.path.join(root, "python", "Library", "bin"), os.path.join(root, "python", "DLLs"), os.path.join(root, "python")):',
        '    if os.path.isdir(d): os.add_dll_directory(d)',
        'sys.path[:] = [root, os.path.join(root, "deps", "Lib", "site-packages"), os.path.join(root, "python", "DLLs"), os.path.join(root, "python", "Lib"), os.path.join(root, "python")]',
        'import numpy, rdkit, scipy, ase, spglib, tblite',
      ].join('; '),
    ],
    {
      cwd: chemistryDestDir,
      env: {
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        WINDIR: process.env.WINDIR || 'C:\\Windows',
        PATH: [
          path.join(chemistryDestDir, 'deps', 'Library', 'bin'),
          path.join(chemistryDestDir, 'python', 'Library', 'bin'),
          path.join(chemistryDestDir, 'python', 'DLLs'),
          path.join(chemistryDestDir, 'python'),
          `${process.env.SystemRoot || 'C:\\Windows'}\\System32`,
        ].join(';'),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
      encoding: 'utf8',
      timeout: 45000,
    },
  );
  if (pySmoke.error || pySmoke.status !== 0) {
    throw new Error(
      `Windows Python scientific import smoke probe failed: ${(pySmoke.stderr || pySmoke.error?.message || '').trim()}`,
    );
  }

  const engineLauncherExe = path.join(chemistryDestDir, 'engine.exe');
  if (fs.existsSync(engineLauncherExe) && detectPeArchitecture(engineLauncherExe) !== null) {
    const launcherSmoke = spawnSync(engineLauncherExe, ['--capabilities'], {
      cwd: chemistryDestDir,
      input: '{}\n',
      env: {
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        WINDIR: process.env.WINDIR || 'C:\\Windows',
        PATH: `${process.env.SystemRoot || 'C:\\Windows'}\\System32`,
      },
      encoding: 'utf8',
      timeout: 45000,
    });
    if (launcherSmoke.error || launcherSmoke.status !== 0) {
      throw new Error(
        `Windows chemistry engine.exe launcher smoke probe failed (exit ${launcherSmoke.status}): ${(launcherSmoke.stderr || launcherSmoke.error?.message || '').trim()}`,
      );
    }
  }

  const xtbExe = path.join(xtbDestDir, 'bin', 'xtb.exe');
  if (detectPeArchitecture(xtbExe) === null) return;
  const probeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ester-win-xtb-probe-'));
  try {
    fs.writeFileSync(
      path.join(probeDir, 'h2o.xyz'),
      '3\nwater\nO 0.000000 0.000000 0.000000\nH 0.960000 0.000000 0.000000\nH -0.240000 0.930000 0.000000\n',
      'utf8',
    );
    const res = spawnSync(xtbExe, ['h2o.xyz', '--opt', '--gfn', '2'], {
      cwd: probeDir,
      env: {
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        WINDIR: process.env.WINDIR || 'C:\\Windows',
        PATH: `${path.join(xtbDestDir, 'bin')};${process.env.SystemRoot || 'C:\\Windows'}\\System32`,
        XTBPATH: path.join(xtbDestDir, 'share', 'xtb'),
        HOME: probeDir,
        USERPROFILE: probeDir,
        TEMP: probeDir,
        TMP: probeDir,
        OMP_NUM_THREADS: '1',
        OPENBLAS_NUM_THREADS: '1',
      },
      encoding: 'utf8',
      timeout: 45000,
    });
    if (res.error || res.status !== 0 || !fs.existsSync(path.join(probeDir, 'xtbopt.xyz'))) {
      throw new Error(
        `Packaged Windows xTB optimization smoke probe failed (exit ${res.status}): ${(res.stderr || res.error?.message || '').trim()}`,
      );
    }
    const verMatch = /\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)/i.exec(`${res.stdout || ''}\n${res.stderr || ''}`);
    if (expectedXtbVersion && verMatch && verMatch[1] !== expectedXtbVersion) {
      throw new Error(
        `Packaged Windows xTB version mismatch: expected ${expectedXtbVersion}, got ${verMatch[1]}`,
      );
    }
  } finally {
    removeTreeForce(probeDir);
  }
}

export function createZipFromDirectory(sourceDir, zipFilePath, pythonExecutable = null) {
  fs.rmSync(zipFilePath, { force: true });
  fs.mkdirSync(path.dirname(zipFilePath), { recursive: true });
  const tmpZipPath = path.join(
    path.dirname(zipFilePath),
    `.tmp-${process.pid}-${path.basename(zipFilePath)}`,
  );
  const pyCandidates = [pythonExecutable, 'python3', 'python'].filter(Boolean);
  for (const pyBin of pyCandidates) {
    const pyDir = path.isAbsolute(pyBin) ? path.dirname(pyBin) : null;
    const isolatedEnv = {
      ...process.env,
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    };
    for (const key of Object.keys(isolatedEnv)) {
      if (/^(?:PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|_PYTHON_)/i.test(key)) {
        delete isolatedEnv[key];
      }
    }
    if (pyDir) {
      isolatedEnv.PATH = [
        pyDir,
        path.join(pyDir, 'DLLs'),
        path.join(pyDir, 'Library', 'bin'),
        isolatedEnv.PATH || '',
      ]
        .filter(Boolean)
        .join(path.delimiter);
    }
    const check = spawnSync(pyBin, ['-I', '-B', '--version'], { env: isolatedEnv, stdio: 'pipe' });
    if (!check.error && check.status === 0) {
      const zipScript = [
        'import os, sys, zipfile',
        'if hasattr(os, "add_dll_directory"):',
        '    for d in (sys.prefix, os.path.join(sys.prefix, "DLLs"), os.path.join(sys.prefix, "Library", "bin")):',
        '        if os.path.isdir(d): os.add_dll_directory(d)',
        'src_dir, out_zip = sys.argv[1], sys.argv[2]',
        'base_parent = os.path.dirname(os.path.abspath(src_dir))',
        'with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:',
        '    for root, dirs, files in os.walk(src_dir):',
        '        dirs.sort(); files.sort()',
        '        for f in files:',
        '            full = os.path.join(root, f)',
        '            rel = os.path.relpath(full, base_parent).replace("\\\\", "/")',
        '            zf.write(full, rel)',
      ].join('\n');
      try {
        fs.rmSync(tmpZipPath, { force: true });
        const run = spawnSync(pyBin, ['-I', '-B', '-c', zipScript, sourceDir, tmpZipPath], {
          env: isolatedEnv,
          encoding: 'utf8',
          timeout: 600000,
        });
        if (!run.error && run.status === 0 && fs.existsSync(tmpZipPath)) {
          fs.renameSync(tmpZipPath, zipFilePath);
          return zipFilePath;
        }
      } finally {
        fs.rmSync(tmpZipPath, { force: true });
      }
    }
  }
  try {
    fs.rmSync(tmpZipPath, { force: true });
    execFileSync('tar', ['-a', '-cf', tmpZipPath, '-C', path.dirname(sourceDir), path.basename(sourceDir)], {
      stdio: 'inherit',
    });
    fs.renameSync(tmpZipPath, zipFilePath);
  } finally {
    fs.rmSync(tmpZipPath, { force: true });
  }
  return zipFilePath;
}

export function resolveDefaultWindowsRuntimeSources(repoRoot = DEFAULT_REPO_ROOT) {
  return {
    pythonToolchainRoot: path.join(repoRoot, '.local/toolchains/win-x64/conda-py312-x64/python'),
    pythonDepsRoot: path.join(repoRoot, '.local/dependencies/win-x64/conda-chem-x64/python'),
    xtbSourceRoot: path.join(repoRoot, '.local/dependencies/win-x64/conda-chem-x64/xtb'),
  };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const result = { skipBuild: false, skipZip: false, options: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-build') {
      result.skipBuild = true;
      continue;
    }
    if (arg === '--skip-zip') {
      result.skipZip = true;
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
    else if (key === '--engine-launcher-exe' && nextVal) result.options.engineLauncherExePath = path.resolve(consume());
  }
  return result;
}

export function assembleWindowsPortableBundle(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const defaults = resolveDefaultWindowsRuntimeSources(repoRoot);
  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`Missing required packaging input (package.json): ${pkgJsonPath}`);
  }
  const repoPkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  const {
    outputDir = path.join(repoRoot, 'release', 'win32-x64'),
    electronDistPath = path.join(repoRoot, 'node_modules/electron/dist'),
    pythonToolchainRoot = defaults.pythonToolchainRoot,
    pythonDepsRoot = defaults.pythonDepsRoot,
    xtbSourceRoot = defaults.xtbSourceRoot,
    engineLauncherExePath = null,
    productName = repoPkg?.productName || 'Lactone Studio',
    version = repoPkg?.version || '2.0.3',
    createZip = false,
  } = options;

  const arch = 'x64';
  const distDir = path.join(repoRoot, 'dist');
  const desktopDir = path.join(repoRoot, 'desktop');
  const chemistrySrcDir = path.join(desktopDir, 'chemistry');
  const conformerSolvationJsonPath = path.join(repoRoot, 'src', 'data', 'conformer-solvation.json');
  const licensePath = path.join(repoRoot, 'LICENSE.txt');
  const nodeModulesDir = path.join(repoRoot, 'node_modules');
  const launcherCSourcePath = path.join(repoRoot, 'scripts', 'portable', 'win32-engine-launcher.c');

  for (const [label, targetPath] of [
    ['LICENSE.txt', licensePath],
    ['node_modules directory', nodeModulesDir],
    ['ssh2 runtime dependency', path.join(nodeModulesDir, 'ssh2', 'package.json')],
    ['Electron dist directory', electronDistPath],
    ['Electron executable (electron.exe)', path.join(electronDistPath, 'electron.exe')],
    ['frontend dist directory', distDir],
    ['frontend dist index.html', path.join(distDir, 'index.html')],
    ['desktop directory', desktopDir],
    ['desktop main.cjs', path.join(desktopDir, 'main.cjs')],
    ['chemistry source directory', chemistrySrcDir],
    ['chemistry engine.py', path.join(chemistrySrcDir, 'engine.py')],
    ['conformer solvation data', conformerSolvationJsonPath],
    ['Python toolchain directory', pythonToolchainRoot],
    ['Python executable (python.exe)', path.join(pythonToolchainRoot, 'python.exe')],
    ['Python DLL (python312.dll)', path.join(pythonToolchainRoot, 'python312.dll')],
    ['Python stdlib (Lib/os.py)', path.join(pythonToolchainRoot, 'Lib', 'os.py')],
    ['Python dependencies directory', pythonDepsRoot],
    ['xTB runtime directory', xtbSourceRoot],
    ['xTB runtime.json manifest', path.join(xtbSourceRoot, 'runtime.json')],
  ]) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Missing required packaging input (${label}): ${targetPath}`);
    }
  }

  const runtimePackages = collectTransitiveDependencies(nodeModulesDir, ['ssh2']);
  const sitePackagesDir = path.join(pythonDepsRoot, 'Lib', 'site-packages');
  for (const pkgName of REQUIRED_PYTHON_PACKAGES) {
    const pkgPath = path.join(sitePackagesDir, pkgName);
    if (!fs.existsSync(pkgPath)) {
      throw new Error(`Missing required packaging input (Python scientific package ${pkgName}): ${pkgPath}`);
    }
  }

  const electronArch = detectPeArchitecture(path.join(electronDistPath, 'electron.exe'));
  if (electronArch !== null && electronArch !== arch) {
    throw new Error(`Electron binary architecture mismatch: expected win32-${arch}, found ${electronArch}`);
  }
  validatePeTreeArch(pythonToolchainRoot, arch, 'Python toolchain');
  validatePeTreeArch(pythonDepsRoot, arch, 'Python scientific dependencies');
  validatePeTreeArch(xtbSourceRoot, arch, 'xTB runtime');

  const xtbManifestPath = path.join(xtbSourceRoot, 'runtime.json');
  const xtbManifest = xtbContract.validateDescriptor(JSON.parse(fs.readFileSync(xtbManifestPath, 'utf8')));
  if (
    xtbManifest.schema !== 'sciyue-xtb-bundled-runtime/v1' ||
    xtbManifest.platform !== 'win32-x64' ||
    xtbManifest.entry !== 'bin/xtb.exe'
  ) {
    throw new Error(
      `Invalid Windows xTB runtime.json (${xtbManifestPath}): expected schema sciyue-xtb-bundled-runtime/v1, platform win32-x64, entry bin/xtb.exe`,
    );
  }
  xtbContract.ordinary(xtbSourceRoot, 'bin/xtb.exe');
  for (const paramFile of XTB_REQUIRED_PARAMS) {
    xtbContract.ordinary(xtbSourceRoot, `share/xtb/${paramFile}`);
  }
  const hasGnuRuntime = fs.existsSync(path.join(xtbSourceRoot, ...xtbContract.WIN32_GNU_V1_LIBRARIES[0].split('/')));
  const requiredWinLibs = hasGnuRuntime
    ? xtbContract.WIN32_GNU_V1_LIBRARIES
    : xtbContract.WIN32_V1_LIBRARIES;
  for (const relLib of requiredWinLibs) {
    xtbContract.ordinary(xtbSourceRoot, relLib);
  }

  const safeProductSlug = productName.replace(/\s+/g, '-');
  const bundleFolderName = `${safeProductSlug}-${version}-win32-${arch}`;
  const portableDirPath = path.join(outputDir, bundleFolderName);
  fs.mkdirSync(outputDir, { recursive: true });
  removeTreeForce(portableDirPath);

  copyTreeMaterialized(electronDistPath, portableDirPath);
  const oldElectronExe = path.join(portableDirPath, 'electron.exe');
  const mainExecutablePath = path.join(portableDirPath, `${productName}.exe`);
  if (oldElectronExe !== mainExecutablePath) {
    fs.renameSync(oldElectronExe, mainExecutablePath);
  }
  fs.rmSync(path.join(portableDirPath, 'resources', 'default_app.asar'), { force: true });

  // Root-level LICENSE.txt & licenses/ required by portable layoutVersion=1 firstRunLicense
  fs.copyFileSync(licensePath, path.join(portableDirPath, 'LICENSE.txt'));
  const repoLicensesDir = path.join(repoRoot, 'licenses');
  if (fs.existsSync(repoLicensesDir)) {
    copyTreeMaterialized(repoLicensesDir, path.join(portableDirPath, 'licenses'));
  }

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
    buildWindowsChemistryBootstrapScript(),
    'utf8',
  );

  const chemistryEnginePath = path.join(chemistryDestDir, 'engine.exe');
  if (engineLauncherExePath) {
    fs.copyFileSync(engineLauncherExePath, chemistryEnginePath);
  } else if (process.platform === 'win32') {
    compileWindowsEngineLauncher(launcherCSourcePath, chemistryEnginePath);
  } else {
    throw new Error(
      'Cross-platform assembly of Windows bundle on non-Windows host requires --engine-launcher-exe',
    );
  }

  const xtbDestDir = path.join(resourcesPath, 'xtb');
  removeTreeForce(xtbDestDir);
  copyTreeMaterialized(xtbSourceRoot, xtbDestDir);
  patchXtbWindowsFormatBugIfPresent(path.join(xtbDestDir, 'bin', 'xtb.exe'));

  runWindowsLiveSmokeProbes(chemistryDestDir, xtbDestDir, xtbManifest.version);

  const installGuideFileName = '安装说明 (INSTALL).txt';
  const installGuideText = buildWindowsInstallGuideText({ productName, version, arch });
  const installGuidePath = path.join(outputDir, installGuideFileName);
  fs.writeFileSync(installGuidePath, installGuideText, 'utf8');
  fs.writeFileSync(path.join(portableDirPath, installGuideFileName), installGuideText, 'utf8');

  let zipPath = null;
  if (createZip) {
    zipPath = path.join(outputDir, `${bundleFolderName}.zip`);
    const bundledPython =
      process.platform === 'win32' ? path.join(chemistryDestDir, 'python', 'python.exe') : null;
    createZipFromDirectory(portableDirPath, zipPath, bundledPython);
  }

  return {
    portableDirPath,
    executablePath: mainExecutablePath,
    resourcesPath,
    appResourcesPath,
    chemistryEnginePath,
    xtbPath: xtbDestDir,
    installGuidePath,
    zipPath,
  };
}

async function runCli() {
  const parsed = parseCliArgs(process.argv.slice(2));
  const repoRoot = parsed.options.repoRoot ?? DEFAULT_REPO_ROOT;
  if (!parsed.skipBuild) {
    console.log('[package-windows] 🔨 Building frontend production bundle (npm run build)...');
    if (process.platform === 'win32') {
      execFileSync(
        process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', 'npm.cmd', 'run', 'build'],
        { cwd: repoRoot, stdio: 'inherit' },
      );
    } else {
      execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
    }
  }
  const result = assembleWindowsPortableBundle({
    ...parsed.options,
    repoRoot,
    createZip: !parsed.skipZip,
  });
  console.log(`[package-windows] ✅ Portable directory ready: ${result.portableDirPath}`);
  if (result.zipPath) {
    console.log(`[package-windows] 📦 Portable ZIP archive ready: ${result.zipPath}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runCli().catch((error) => {
    console.error('[package-windows] ❌ Failed:', error.message);
    process.exit(1);
  });
}
