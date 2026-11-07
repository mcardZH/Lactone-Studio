'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { developmentNative } = require('./current-runtime.cjs');

const ALLOWED_PTH_STDLIB_BY_PLATFORM = Object.freeze({
  'win32-x64': new Set(['.', 'Lib', 'DLLs', 'python312.zip']),
  'darwin-arm64': new Set([
    'lib/python312.zip',
    'lib/python3.12',
    'lib/python3.12/lib-dynload'
  ]),
  'darwin-x64': new Set([
    'lib/python312.zip',
    'lib/python3.12',
    'lib/python3.12/lib-dynload'
  ])
});

function validateToolchainStartupPaths(selected) {
  const exeAbs = path.resolve(selected.executable);
  const exeDir = path.dirname(exeAbs);
  const pythonRoot =
    path.basename(exeDir).toLowerCase() === 'bin' ? path.dirname(exeDir) : exeDir;
  const allowedRelSet = ALLOWED_PTH_STDLIB_BY_PLATFORM[selected.platform];
  if (!allowedRelSet) {
    throw new Error(`Unsupported runtime platform for ._pth validation: ${selected.platform}`);
  }

  const tcRoot = path.dirname(pythonRoot);
  const venvCheckDirs = Array.from(new Set([tcRoot, pythonRoot, exeDir]));
  for (const dir of venvCheckDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase() === 'pyvenv.cfg') {
        throw new Error(`Disallowed pyvenv.cfg in locked toolchain: ${path.join(dir, entry)}`);
      }
    }
  }

  const candidateDirs = exeDir === pythonRoot ? [pythonRoot] : [pythonRoot, exeDir];
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.toLowerCase().endsWith('._pth')) continue;
      const pthPath = path.join(dir, entry);
      const st = fs.lstatSync(pthPath);
      if (!st.isFile() || st.isSymbolicLink()) {
        throw new Error(`Invalid toolchain ._pth file: ${pthPath}`);
      }
      const raw = fs.readFileSync(pthPath, 'utf8');
      if (raw.includes('\0')) {
        throw new Error(`Invalid null byte in toolchain ._pth file: ${pthPath}`);
      }
      const lines = raw
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));
      if (lines.length === 0) {
        throw new Error(`Empty toolchain ._pth file: ${pthPath}`);
      }
      for (const line of lines) {
        if (
          /^import(?:\s|$)/i.test(line) ||
          line.startsWith('/') ||
          line.startsWith('\\') ||
          /^[A-Za-z]:/.test(line) ||
          line.includes(';') ||
          line.includes(':')
        ) {
          throw new Error(`Disallowed directive or path in toolchain ._pth: ${line}`);
        }
        const resolved = path.resolve(dir, line.replace(/\\/g, '/'));
        if (resolved !== pythonRoot && !resolved.startsWith(pythonRoot + path.sep)) {
          throw new Error(`Toolchain ._pth path escaped python root: ${line}`);
        }
        const rel = path.relative(pythonRoot, resolved).split(path.sep).join('/') || '.';
        if (!allowedRelSet.has(rel)) {
          throw new Error(`Toolchain ._pth path outside allowed stdlib set: ${rel}`);
        }
      }
    }
  }
}

function chemistryRuntime({
  packaged,
  resourcesPath,
  appPath,
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
  platformId
}) {
  if (packaged) {
    const executable = path.join(
      resourcesPath,
      'chemistry',
      platform === 'win32' ? 'engine.exe' : 'engine'
    );
    if (!fs.existsSync(executable)) {
      throw new Error(
        'BUNDLED_RUNTIME_MISSING: 此安装包未包含原生化学引擎，不能运行。请使用完整 portable 包。'
      );
    }
    return { executable, args: [], cwd: path.dirname(executable), bundled: true };
  }
  const engine = path.join(appPath, 'desktop', 'chemistry', 'engine.py');
  if (!fs.existsSync(engine)) {
    throw new Error('DEV_ENGINE_MISSING: desktop/chemistry/engine.py 不存在。');
  }
  if (environment.SCIYUE_PYTHON) {
    const executable = environment.SCIYUE_PYTHON;
    if (
      !path.isAbsolute(executable) ||
      !fs.existsSync(executable) ||
      !fs.statSync(executable).isFile()
    ) {
      throw new Error('DEV_RUNTIME_MISSING: 显式选择的 SCIYUE_PYTHON 不存在。');
    }
    return {
      executable,
      args: ['-B', engine],
      cwd: path.dirname(engine),
      bundled: false,
      provenance: { source: 'explicit-user-override', locked: false }
    };
  }
  try {
    const selected = developmentNative(appPath, { platform, arch, platformId });
    validateToolchainStartupPaths(selected);
    const bootstrap = path.join(appPath, 'scripts/native/dev-runtime.py');
    if (!fs.statSync(bootstrap).isFile()) {
      throw new Error('Fixed development bootstrap missing');
    }
    return {
      ...selected,
      args: ['-I', '-S', '-B', bootstrap],
      cwd: path.dirname(engine),
      bundled: false
    };
  } catch (error) {
    throw new Error(
      'DEV_RUNTIME_MISSING: 当前项目锁定的 Python/科学依赖未准备或身份已变化；不回退系统环境。' +
        error.message
    );
  }
}

module.exports = { chemistryRuntime, validateToolchainStartupPaths };
