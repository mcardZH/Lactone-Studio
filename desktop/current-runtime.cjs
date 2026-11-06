'use strict';
// Fixed current-project inputs. No PATH search, history lookup or acquisition.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { verifyMemberInventory } = require('./xtb-runtime-contract.cjs');
const hashes = new Map(), documents = new Map();
const SHA = /^[a-f0-9]{64}$/;
function inside(root, target) {
  const part = path.relative(root, target);
  return part !== '..' && !part.startsWith('..' + path.sep) && !path.isAbsolute(part);
}
function admitted(root, relative, directory = false) {
  assert(typeof relative === 'string' && relative && !relative.includes('\\') && !relative.includes('\0') && !path.isAbsolute(relative) && relative.split('/').every(p => p && p !== '.' && p !== '..'), 'Invalid current runtime path');
  root = path.resolve(root);
  const target = path.resolve(root, relative);
  assert(inside(root, target) && target !== root, 'Current runtime escaped project');
  let cursor = root;
  assert(!fs.lstatSync(cursor).isSymbolicLink(), 'Linked project root');
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    assert(!fs.lstatSync(cursor).isSymbolicLink(), 'Linked current runtime input');
  }
  const stat = fs.lstatSync(target);
  assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, 'Current runtime requires an ordinary owned input');
  return { target, stat };
}
function stamp(s) { return JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]); }
function identity(root, relative) {
  const { target, stat } = admitted(root, relative), key = stamp(stat), old = hashes.get(target);
  let sha256 = old?.stamp === key ? old.sha256 : null;
  if (!sha256) {
    const fd = fs.openSync(target, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    try {
      assert.equal(stamp(fs.fstatSync(fd)), key, 'Runtime changed before read');
      let length;
      while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
      assert.equal(stamp(fs.fstatSync(fd)), key, 'Runtime changed during read');
      sha256 = hash.digest('hex');
    } finally { fs.closeSync(fd); }
    if (hashes.size >= 64) hashes.clear();
    hashes.set(target, { stamp: key, sha256 });
  }
  return { path: relative, bytes: stat.size, sha256 };
}
function json(root, relative, maximum = 8 * 1024 * 1024) {
  const { target, stat } = admitted(root, relative), key = stamp(stat);
  assert(stat.size > 0 && stat.size <= maximum, 'Current runtime metadata size');
  const old = documents.get(target);
  if (old?.stamp === key) return old.value;
  const bytes = fs.readFileSync(target);
  assert.equal(stamp(fs.lstatSync(target)), key, 'Runtime metadata changed during read');
  const value = JSON.parse(bytes.toString('utf8'));
  if (documents.size >= 32) documents.clear();
  documents.set(target, { stamp: key, value });
  return value;
}
function reference(root, row) {
  assert(row && Object.keys(row).sort().join(',') === 'bytes,path,sha256' && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && SHA.test(row.sha256), 'Exact current runtime reference required');
  assert.equal(admitted(root, row.path).stat.size, row.bytes, 'Current runtime identity differs: ' + row.path);
  assert.deepEqual(identity(root, row.path), row, 'Current runtime identity differs: ' + row.path);
  return admitted(root, row.path).target;
}
function lock(root, relative, schema, parent) {
  const value = json(root, relative, 1024 * 1024);
  assert(value.schema === schema && value.platform === 'win32-x64', 'Current runtime lock schema/platform');
  assert(typeof value.root === 'string' && value.root.startsWith(parent + '/') && value.root.split('/').length === parent.split('/').length + 1, 'Content-specific current runtime root required');
  admitted(root, value.root, true);
  let files = value.files;
  if (value.inventory) {
    reference(root, value.inventory);
    assert(value.inventory.path.startsWith(value.root + '/'), 'Inventory escaped dependency root');
    const inventory = json(root, value.inventory.path);
    assert(inventory.schema === schema && inventory.root === value.root && inventory.lockId === value.lockId && !inventory.inventory, 'Inventory belongs to another current lock');
    if (value.files !== undefined) assert.deepEqual(value.files, inventory.files, 'Inline and external current inventories must agree');
    files = inventory.files;
  }
  assert(Array.isArray(files) && files.length > 0 && new Set(files.map(row => row.path)).size === files.length, 'Current runtime inventory missing/duplicated');
  return { value, files, reference: identity(root, relative) };
}
function lockedFile(root, selected, relative) {
  const row = selected.files.find(row => row.path === relative);
  assert(row, 'Required current runtime member absent: ' + relative);
  reference(root, { path: selected.value.root + '/' + relative, bytes: row.bytes, sha256: row.sha256 });
  return path.join(root, selected.value.root, relative);
}
function developmentNative(appPath) {
  admitted(appPath, 'scripts/native/dev-runtime.py');
  admitted(appPath, 'desktop/chemistry/engine.py');
  const profile = json(appPath, 'desktop/packaging/native-profile.json', 65536);
  assert(profile.schema === 'sciyue-native-profile-v1' && profile.platform === 'win32-x64' && profile.runtimeLock === 'desktop/packaging/native-runtime.lock.json' && profile.toolchainLock === 'desktop/packaging/native-toolchain.lock.json' && profile.xtbLock === 'desktop/packaging/xtb-runtime.lock.json', 'Fixed current native profile required');
  const runtime = lock(appPath, profile.runtimeLock, 'sciyue-native-runtime-lock-v1', '.local/dependencies/win-x64');
  const toolchain = lock(appPath, profile.toolchainLock, 'sciyue-native-toolchain-lock-v1', '.local/toolchains/win-x64');
  reference(appPath, profile.preparation);
  const prepared = json(appPath, profile.preparation.path);
  assert(prepared.schema === 'sciyue-native-preparation-v1' && prepared.passed === true && prepared.scienceExecuted === false, 'Prepared current runtime required');
  assert.deepEqual(prepared.runtimeLock, runtime.reference);
  assert.deepEqual(prepared.toolchainLock, toolchain.reference);
  assert.deepEqual(prepared.xtbLock, identity(appPath, profile.xtbLock));
  reference(appPath, prepared.importProbe);
  assert(toolchain.value.python === 'python/python.exe', 'Fixed standalone Python entry required');
  const executable = lockedFile(appPath, toolchain, toolchain.value.python);
  for (const name of ['python/python312.dll', 'python/python312._pth']) lockedFile(appPath, toolchain, name);
  return { executable, provenance: { source: 'prepared-current-locks', locked: true, runtimeLock: runtime.reference, toolchainLock: toolchain.reference, preparation: profile.preparation } };
}
function developmentXtb(appPath) {
  const selected = lock(appPath, 'desktop/packaging/xtb-runtime.lock.json', 'sciyue-xtb-lock-v1', '.local/dependencies/win-x64');
  assert.equal(selected.value.localUseReady, true, 'Current xTB lock must be explicitly ready');
  assert(selected.value.entry === 'xtb/bin/xtb.exe' && selected.value.dataDirectory === 'xtb/share/xtb', 'Fixed current xTB entry required');
  for (const name of ['xtb/bin/xtb.exe', 'xtb/runtime.json', 'xtb/share/xtb/param_gfn0-xtb.txt', 'xtb/share/xtb/param_gfn1-xtb.txt', 'xtb/share/xtb/param_gfn2-xtb.txt', 'xtb/share/xtb/.param_gfnff.xtb']) assert(selected.files.some(row => row.path === name), 'Required current runtime member absent: ' + name);
  // Verify the complete selected closure, including its actual GNU DLLs and
  // descriptor, rather than presuming a compiler-specific member count/list.
  verifyMemberInventory(path.join(appPath, selected.value.root), selected.files, ['xtb']);
  const descriptor = selected.files.find(row => row.path === 'xtb/runtime.json');
  return { root: path.join(appPath, selected.value.root, 'xtb'), lock: selected.reference, manifestIdentity: { ...descriptor, path: 'runtime.json' } };
}
function currentRuntimeEnvironment({ packaged, appPath, executable, environment = process.env }) {
  if (packaged || environment.SCIYUE_PYTHON) return {};
  if (typeof executable !== 'string' || !inside(path.join(appPath, '.local/toolchains/win-x64'), executable) || path.basename(executable).toLowerCase() !== 'python.exe') return {};
  const declared = json(appPath, 'desktop/packaging/native-toolchain.lock.json', 1024 * 1024);
  assert(declared.schema === 'sciyue-native-toolchain-lock-v1' && declared.python === 'python/python.exe' && declared.root.startsWith('.local/toolchains/win-x64/'), 'Fixed current Python declaration required');
  const expected = path.resolve(appPath, declared.root, declared.python);
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (typeof executable !== 'string' || normalize(executable) !== normalize(expected)) return {};
  developmentNative(appPath);
  const runtime = json(appPath, 'desktop/packaging/native-runtime.lock.json', 1024 * 1024), system = environment.SystemRoot || environment.WINDIR || 'C:\\Windows';
  const result = { PATH: [path.join(appPath, runtime.root, 'python/Library/bin'), path.dirname(expected), path.join(system, 'System32'), system].join(path.delimiter) };
  for (const name of Object.keys(environment)) if (/^(?:CONDA_|_CONDA_|VIRTUAL_ENV$|PYTHON(?:PATH|HOME|USERBASE|STARTUP|INSPECT|EXECUTABLE)$|_CE_CONDA$|_CE_M$)/i.test(name)) result[name] = undefined;
  return result;
}
function packagedBackendInfo({ packaged, resourcesPath, provenanceRoot }) {
  if (!packaged) return { name: 'unknown', verified: false, source: 'development-or-test' };
  try {
    assert(typeof provenanceRoot === 'string', 'Package provenance root required');
    assert(path.resolve(provenanceRoot) === path.resolve(resourcesPath, '../provenance'), 'Package provenance must belong to these resources');
    admitted(path.dirname(resourcesPath), 'provenance', true);
    const summary = json(provenanceRoot, 'dependencies.json', 1024 * 1024), native = summary.native;
    assert(summary.schema === 'sciyue-portable-dependency-summary/v1' && native.backend === 'OpenBLAS', 'Explicit current backend required');
    assert(native.entry.path === 'engine.exe' && SHA.test(native.origin.candidateReceiptSha256) && SHA.test(native.origin.buildContractSha256), 'Current native origin required');
    reference(resourcesPath, { ...native.entry, path: 'chemistry/' + native.entry.path });
    return { name: 'openblas', verified: true, source: 'package-provenance-not-live-DLL-observation' };
  } catch { return { name: 'unknown', verified: false, source: 'missing-or-invalid-package-provenance' }; }
}
module.exports = { developmentNative, developmentXtb, currentRuntimeEnvironment, packagedBackendInfo };
