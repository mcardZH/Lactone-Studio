'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { developmentNative } = require('./current-runtime.cjs');
function chemistryRuntime({ packaged, resourcesPath, appPath, environment = process.env }) {
  if (packaged) {
    const executable = path.join(resourcesPath, 'chemistry', process.platform === 'win32' ? 'engine.exe' : 'engine');
    if (!fs.existsSync(executable)) throw new Error('BUNDLED_RUNTIME_MISSING: 此安装包未包含原生化学引擎，不能运行。请使用完整 portable 包。');
    return { executable, args: [], cwd: path.dirname(executable), bundled: true };
  }
  const engine = path.join(appPath, 'desktop', 'chemistry', 'engine.py');
  if (!fs.existsSync(engine)) throw new Error('DEV_ENGINE_MISSING: desktop/chemistry/engine.py 不存在。');
  if (environment.SCIYUE_PYTHON) {
    const executable = environment.SCIYUE_PYTHON;
    if (!path.isAbsolute(executable) || !fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw new Error('DEV_RUNTIME_MISSING: 显式选择的 SCIYUE_PYTHON 不存在。');
    return { executable, args: ['-B', engine], cwd: path.dirname(engine), bundled: false, provenance: { source: 'explicit-user-override', locked: false } };
  }
  try {
    const selected = developmentNative(appPath), bootstrap = path.join(appPath, 'scripts/native/dev-runtime.py');
    if (!fs.statSync(bootstrap).isFile()) throw new Error('Fixed development bootstrap missing');
    return { ...selected, args: ['-I', '-B', bootstrap], cwd: path.dirname(engine), bundled: false };
  } catch (error) { throw new Error('DEV_RUNTIME_MISSING: 当前项目锁定的 Python/科学依赖未准备或身份已变化；不回退系统环境。' + error.message); }
}
module.exports = { chemistryRuntime };
