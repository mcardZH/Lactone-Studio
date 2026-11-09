'use strict';
const path = require('node:path');
const error = message => Object.assign(new Error(message), { code: 'PORTABLE_SELECTION' });
/** Host-only policy gate. The caller still verifies real parent/target identities
 * and performs its guarded write; this does not grant renderer filesystem access.
 */
function assertUnmanagedDestination(file, { root, managedRoots = [], applicationRoots = [], layout, platform = process.platform } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || typeof root !== 'string' || !path.isAbsolute(root) || !Array.isArray(managedRoots) || !Array.isArray(applicationRoots)) throw error('请选择明确的独立文件保存位置。');
  const absolute = path.resolve(file), basename = path.basename(absolute);
  const components = absolute.slice(path.parse(absolute).root.length).split(/[\\/]/);
  if (components.some(component => /[\x00-\x1f]/.test(component) || (platform === 'win32' && (/[:]|[. ]$/.test(component) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component))))) throw error('导出路径不能使用设备名、数据流或含糊的Windows路径。');
  if (/^(?:workbench-layout-v\d+|model-display-preferences-v\d+|personal-fragments-v\d+|import-receipt|\.portable-run|portable-native-binding|portable-profile|portable-events)\.json$/i.test(basename)) throw error('不能覆盖运行偏好、个人库或内部身份回执。');
  const protectedRoots = ['resources', 'provenance', 'data', 'cache', 'temp', 'logs'].map(name => path.join(root, name));
  const layoutRoots = layout?.layoutVersion === 2 ? [layout.runtimeRoot] : [];
  for (const directory of [...protectedRoots, ...managedRoots, ...applicationRoots, ...layoutRoots]) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw error('Invalid protected export root');
    const rel = path.relative(path.resolve(directory), absolute); if (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) throw error('不能将导出写入程序资源、来源回执或受管理的数据目录。');
  }
  return absolute;
}
function assertExportDestination(file, options) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.json') throw error('请选择明确的JSON导出位置。');
  return assertUnmanagedDestination(file, options);
}
module.exports = { assertExportDestination, assertUnmanagedDestination };
