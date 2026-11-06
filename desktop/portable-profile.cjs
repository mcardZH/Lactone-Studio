'use strict';
const nativeFS = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { classifyStorageError } = require('./portable-storage.cjs');
const identity = stat => `${stat.dev}:${stat.ino}`;
const stepLabels = {
  'verify-directory': '核对目录身份', 'create-directory': '创建便携数据目录',
  'exclusive-create': '独占创建探针文件', write: '写入探针文件', sync: '同步探针文件到磁盘', close: '关闭探针文件',
  'exclusive-publish': '硬链接首次发布探针', 'atomic-replace': '原子替换探针文件',
  'verify-file': '核对探针文件身份', read: '读取探针结果', cleanup: '清理本次探针文件', 'run-marker': '写入本次运行记录',
};
function atStep(step, target, operation) {
  try { return operation(); }
  catch (error) { error.portableStep ??= step; error.portablePath ??= target; throw error; }
}
function startupFailure(error, root) {
  const classified = classifyStorageError(error), rawCode = error.code || 'UNKNOWN', step = error.portableStep || 'verify-directory', target = error.path || error.portablePath || root;
  let code = classified.code, reason = '便携目录检查失败。';
  if (['EISDIR', 'ENOTDIR', 'EEXIST'].includes(rawCode)) { code = 'PORTABLE_PATH_TYPE_CONFLICT'; reason = '路径类型或名称冲突，无法完成此步骤；不能据此判定磁盘类型或硬链接能力。'; }
  else if (['EACCES', 'EPERM', 'EROFS'].includes(rawCode)) reason = '当前目录没有此步骤所需的权限，或介质为只读。';
  else if (['ENOSPC', 'EDQUOT'].includes(rawCode)) reason = '磁盘空间或配额不足。';
  else if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(rawCode)) reason = '当前位置无法完成此安全存储步骤；尚不能确定具体磁盘类型。';
  else if (rawCode === 'PORTABLE_PATH_CHANGED') reason = '目录或文件身份发生变化，或路径经过链接；已停止便携目录准备。';
  else if (['ENOENT', 'ENODEV', 'EIO'].includes(rawCode)) reason = '存储路径不可用或发生读写故障。';
  return { ...classified, code, rawCode, step, path: target,
    message: `${reason}\n失败步骤：${stepLabels[step] || step}\n原始错误代码：${rawCode}\n路径：${target}${error.dest ? '\n目标路径：' + error.dest : ''}${error.portableCleanupFailure ? '\n本次探针清理也未完成，原始故障信息已保留。' : ''}\n请保留原目录，将完整便携目录（包括程序、运行时及已有数据）复制到有足够空间、可写且支持硬链接与原子替换的位置。核对复制内容完整后，从新位置启动并确认已有设置和数据；确认前不要删除原目录。`,
  };
}
function checkedDirectory(fs, target) {
  const absolute = path.resolve(target), parts = [];
  for (let current = absolute;; current = path.dirname(current)) { parts.unshift(current); if (path.dirname(current) === current) break; }
  for (const current of parts) atStep('verify-directory', current, () => { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('便携目录不能经过链接或被替换。'), { code: 'PORTABLE_PATH_CHANGED' }); });
  return atStep('verify-directory', absolute, () => `${fs.realpathSync(absolute)}:${identity(fs.lstatSync(absolute))}`);
}
function createDirectory(fs, root, target) {
  const relative = path.relative(root, target); if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Portable directory escaped root');
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); atStep('create-directory', cursor, () => { try { fs.mkdirSync(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; } }); checkedDirectory(fs, cursor); }
}
// Proves the existing stores' exclusive publication and atomic replacement semantics.
// Unsupported filesystems are not silently downgraded to overwriting rename.
function probeWritable(fs, directory) {
  const parent = checkedDirectory(fs, directory), id = randomUUID(), source = path.join(directory, `.portable-probe-${id}.tmp`), target = path.join(directory, `.portable-probe-${id}.link`), replacement = path.join(directory, `.portable-probe-${id}.replace`);
  const owned = new Map(); let descriptor, descriptorPath, primaryFailure;
  const verifyParent = () => { if (checkedDirectory(fs, directory) !== parent) throw Object.assign(new Error('Portable writable probe directory changed'), { code: 'PORTABLE_PATH_CHANGED', portableStep: 'verify-directory', portablePath: directory }); };
  const writeProbe = (file, contents) => {
    verifyParent(); descriptor = atStep('exclusive-create', file, () => fs.openSync(file, 'wx')); descriptorPath = file;
    owned.set(file, atStep('verify-file', file, () => identity(fs.fstatSync(descriptor))));
    atStep('write', file, () => fs.writeFileSync(descriptor, contents)); atStep('sync', file, () => fs.fsyncSync(descriptor));
    const closing = descriptor; descriptor = undefined; atStep('close', file, () => fs.closeSync(closing));
  };
  try {
    writeProbe(source, 'portable'); verifyParent();
    atStep('exclusive-publish', target, () => fs.linkSync(source, target));
    // The new link belongs to this probe only while it still names our source inode.
    owned.set(target, owned.get(source));
    atStep('verify-file', target, () => { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== owned.get(source)) throw Object.assign(new Error('Portable link probe identity changed'), { code: 'PORTABLE_PATH_CHANGED' }); });
    writeProbe(replacement, 'portable-replacement'); verifyParent();
    for (const file of [replacement, target]) atStep('verify-file', file, () => { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== owned.get(file)) throw Object.assign(new Error('Portable replacement file changed'), { code: 'PORTABLE_PATH_CHANGED' }); });
    atStep('atomic-replace', target, () => fs.renameSync(replacement, target));
    atStep('verify-file', target, () => { if (identity(fs.lstatSync(target)) !== owned.get(replacement)) throw Object.assign(new Error('Portable atomic replacement did not publish our file'), { code: 'PORTABLE_PATH_CHANGED' }); });
    owned.set(target, owned.get(replacement));
    atStep('read', target, () => { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== owned.get(target) || fs.readFileSync(target, 'utf8') !== 'portable-replacement') throw Object.assign(new Error('Portable writable probe identity changed'), { code: 'PORTABLE_PATH_CHANGED' }); });
    verifyParent();
    return { atomicReplace: true, exclusivePublish: true };
  } catch (error) { primaryFailure = error; throw error;
  } finally {
    let cleanupFailure;
    if (descriptor !== undefined) { try { atStep('close', descriptorPath, () => fs.closeSync(descriptor)); } catch (error) { cleanupFailure = error; } }
    // Only remove this probe's exact, still-owned files. Never remove another owner's replacement.
    for (const [file, token] of owned) { try { atStep('cleanup', file, () => { const stat = fs.lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink() && identity(stat) === token && checkedDirectory(fs, directory) === parent) fs.unlinkSync(file); }); } catch (error) { if (error.code !== 'ENOENT') cleanupFailure ??= error; } }
    if (cleanupFailure) {
      if (primaryFailure) primaryFailure.portableCleanupFailure = { code: cleanupFailure.code, path: cleanupFailure.path || cleanupFailure.portablePath };
      // eslint-disable-next-line no-unsafe-finally -- A cleanup failure vetoes success, but cannot hide the original failing step.
      else throw cleanupFailure;
    }
  }
}
function createPortableProfile({ app, fs = nativeFS, executable, version, revision = '', root: trustedRoot, layout, runId = randomUUID() }) {
  if (!app || typeof app.setPath !== 'function' || typeof executable !== 'string' || !path.isAbsolute(executable) || !/^\d+\.\d+\.\d+(?:-dev\.[1-9]\d*)?$/.test(version) || (revision && !/^r(?:[2-9]|[1-9]\d+)$/.test(revision)) || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error('Invalid host portable identity');
  const root = path.resolve(trustedRoot ?? path.dirname(executable)), tag = 'v' + version + (revision ? '-' + revision : '');
  try {
    if (layout) {
      if (![1, 2].includes(layout.layoutVersion) || root !== path.resolve(layout.stateRoot) || path.resolve(executable) !== path.join(layout.runtimeRoot, path.basename(executable))) throw new Error('Portable profile/layout identity differs');
      if (layout.layoutVersion === 2 && (layout.distributionRoot !== path.dirname(layout.runtimeRoot) || root !== path.join(layout.runtimeRoot, 'state') || layout.provenanceRoot !== path.join(layout.runtimeRoot, 'provenance'))) throw new Error('Invalid compact portable roots');
      checkedDirectory(fs, layout.distributionRoot); checkedDirectory(fs, layout.runtimeRoot);
      createDirectory(fs, layout.runtimeRoot, root);
    }
    const rootIdentity = checkedDirectory(fs, root), paths = { data: path.join(root, 'data'), profile: path.join(root, 'data', 'profiles', tag), cache: path.join(root, 'cache', tag), temp: path.join(root, 'temp', tag, runId), logs: path.join(root, 'logs', tag), crashDumps: path.join(root, 'logs', tag, 'crash-dumps') };
    for (const directory of Object.values(paths)) createDirectory(fs, root, directory);
    const filesystem = probeWritable(fs, paths.profile); for (const key of ['cache', 'temp', 'logs', 'crashDumps']) probeWritable(fs, paths[key]);
    const identities = Object.fromEntries(Object.entries(paths).map(([key, directory]) => [key, checkedDirectory(fs, directory)]));
    if (checkedDirectory(fs, root) !== rootIdentity) throw Object.assign(new Error('Portable root changed during preparation'), { code: 'PORTABLE_PATH_CHANGED' });
    // Called by host before app.ready; no renderer-supplied paths are accepted.
    for (const [name, key] of [['userData', 'profile'], ['sessionData', 'cache'], ['temp', 'temp'], ['logs', 'logs'], ['crashDumps', 'crashDumps']]) app.setPath(name, paths[key]);
    const run = { schema: 'sciyue-portable-run-v1', version, revision, runId, pid: process.pid, startedAt: new Date().toISOString(), state: 'active' };
    const runFile = path.join(paths.temp, '.portable-run.json'); atStep('run-marker', runFile, () => fs.writeFileSync(runFile, JSON.stringify(run) + '\n', { flag: 'wx' }));
    return { schema: 1, mode: 'portable', version, revision, root, ...(layout ? { layout } : {}), paths, runId, writable: true, filesystem, identities: { root: rootIdentity, ...identities }, workerEnv: { TEMP: paths.temp, TMP: paths.temp }, run };
  } catch (error) { error.portableStartupFailure = startupFailure(error, root); error.storage = error.portableStartupFailure; throw error; }
}
module.exports = { createPortableProfile, checkedDirectory, probeWritable };
