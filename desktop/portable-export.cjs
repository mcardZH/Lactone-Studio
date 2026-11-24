'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { directoryIdentity, checkDirectory } = require('./portable-storage.cjs');
const error = message => Object.assign(new Error(message), { code: 'PORTABLE_SELECTION' });
function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function harnessDirectory(bundleRoot, area) {
  if (typeof bundleRoot !== 'string' || !path.isAbsolute(bundleRoot)) {
    throw Object.assign(new Error('当前没有便携包目录。请明确指定绝对保存位置。'), { code: 'portable_destination_unavailable' });
  }
  const directory = path.join(bundleRoot, 'harness', area);
  try {
    let parent = bundleRoot;
    for (const name of ['harness', area]) {
      const identity = await directoryIdentity(parent), child = path.join(parent, name);
      try { await fs.mkdir(child); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      await directoryIdentity(child);
      await checkDirectory(parent, identity);
      parent = child;
    }
    return directory;
  } catch (cause) {
    throw Object.assign(new Error('当前便携目录不可用。请选择其他绝对保存位置。'), {
      code: 'portable_destination_unavailable', data: { path: directory, reason: cause.code, nextAction: 'choose-explicit-destination' },
    });
  }
}
const harnessExportDirectory = bundleRoot => harnessDirectory(bundleRoot, 'exports');
const harnessWorkDirectory = bundleRoot => harnessDirectory(bundleRoot, 'work');
/** Host-only policy gate. The caller still verifies real parent/target identities
 * and performs its guarded write; this does not grant renderer filesystem access.
 */
function assertUnmanagedDestination(file, { root, managedRoots = [], applicationRoots = [], layout, platform = process.platform } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || typeof root !== 'string' || !path.isAbsolute(root) || !Array.isArray(managedRoots) || !Array.isArray(applicationRoots)) throw error('请选择明确的独立文件保存位置。');
  const absolute = path.resolve(file), basename = path.basename(absolute);
  const components = absolute.slice(path.parse(absolute).root.length).split(/[\\/]/);
  if (components.some(component => /[\x00-\x1f]/.test(component) || (platform === 'win32' && (/[<>:"|?*]|[. ]$/.test(component) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component))))) throw error('导出路径不能使用设备名、数据流或含糊的Windows路径。');
  if (/^(?:workbench-layout-v\d+|model-display-preferences-v\d+|personal-fragments-v\d+|import-receipt|\.portable-run|portable-native-binding|portable-profile|portable-events)\.json$/i.test(basename)) throw error('不能覆盖运行偏好、个人库或内部身份回执。');
  const protectedRoots = ['resources', 'provenance', 'data', 'cache', 'temp', 'logs'].map(name => path.join(root, name));
  const layoutRoots = layout?.layoutVersion === 2 ? [layout.runtimeRoot] : [];
  const harness = path.join(root, 'harness');
  if (within(harness, absolute) && (basename.toLowerCase() === '.keep' || !['exports', 'work'].some(name => {
    const writable = path.join(harness, name);
    return path.relative(writable, absolute) && within(writable, absolute);
  }))) throw error('随包 harness 只允许将工作文件写入 exports 或 work 目录。');
  if (path.relative(root, path.dirname(absolute)) === '' && /^(?:(?:ester-studio|sy-studio|sciyue)\.exe|readme\.txt|license\.txt|citation\.txt)$/i.test(basename)) throw error('不能覆盖便携程序入口或随包说明。');
  for (const directory of [...protectedRoots, ...managedRoots, ...applicationRoots, ...layoutRoots]) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw error('Invalid protected export root');
    if (within(directory, absolute)) throw error('不能将导出写入程序资源、来源回执或受管理的数据目录。');
  }
  return absolute;
}
function assertExportDestination(file, options) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.json') throw error('请选择明确的JSON导出位置。');
  return assertUnmanagedDestination(file, options);
}
module.exports = { assertExportDestination, assertUnmanagedDestination, harnessExportDirectory, harnessWorkDirectory };
