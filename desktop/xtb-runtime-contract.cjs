'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const SHA = /^[a-f0-9]{64}$/;
const REQUIRED_PARAMETERS = Object.freeze([
  'share/xtb/param_gfn0-xtb.txt',
  'share/xtb/param_gfn1-xtb.txt',
  'share/xtb/param_gfn2-xtb.txt',
  'share/xtb/.param_gfnff.xtb'
]);
const REQUIRED = Object.freeze(['bin/xtb.exe', ...REQUIRED_PARAMETERS]);
const WIN32_V1_LIBRARIES = Object.freeze(['bin/libiomp5md.dll', 'bin/vcruntime140.dll']);
const DARWIN_V1_LIBRARIES = Object.freeze([
  'lib/libblas.3.dylib',
  'lib/libgcc_s.1.1.dylib',
  'lib/libgfortran.5.dylib',
  'lib/liblapack.3.dylib',
  'lib/libomp.dylib',
  'lib/libopenblas.0.dylib',
  'lib/libquadmath.0.dylib'
]);
function entryForPlatform(platform = 'win32-x64') {
  if (platform === 'win32-x64') return 'bin/xtb.exe';
  if (platform === 'darwin-arm64' || platform === 'darwin-x64') return 'bin/xtb';
  assert.fail('XTB_RUNTIME_INVALID: descriptor identity');
}
function requiredMembersForPlatform(platform = 'win32-x64') {
  return Object.freeze([entryForPlatform(platform), ...REQUIRED_PARAMETERS]);
}
function contentRootsForPlatform(platform = 'win32-x64') {
  if (platform === 'win32-x64') return Object.freeze(['bin', 'share/xtb']);
  if (platform === 'darwin-arm64' || platform === 'darwin-x64') return Object.freeze(['bin', 'lib', 'share/xtb']);
  assert.fail('XTB_RUNTIME_INVALID: descriptor identity');
}
const hashes = new Map();
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
function ordinary(root, relative, directory = false) {
  assert(typeof relative === 'string' && relative && !relative.includes('\\') && !relative.includes('\0') && !path.isAbsolute(relative)
    && relative.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':')), 'XTB_RUNTIME_INVALID: unsafe member path');
  root = path.resolve(root); let target = root;
  assert(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), 'XTB_RUNTIME_INVALID: linked root');
  for (const part of relative.split('/')) { target = path.join(target, part); assert(!fs.lstatSync(target).isSymbolicLink(), 'XTB_RUNTIME_INVALID: linked member'); }
  const stat = fs.lstatSync(target);
  assert(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, 'XTB_RUNTIME_INVALID: ordinary independent member required');
  return { target, stat };
}
function fileIdentity(root, relative) {
  const { target, stat } = ordinary(root, relative), stamp = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  let sha256 = hashes.get(target)?.stamp === stamp ? hashes.get(target).sha256 : undefined;
  if (!sha256) {
    const handle = fs.openSync(target, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    try {
      const signature = value => JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]);
      assert.equal(signature(fs.fstatSync(handle)), stamp, 'XTB_RUNTIME_CHANGED: member changed before reading');
      let read; while ((read = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
      assert.equal(signature(fs.fstatSync(handle)), stamp, 'XTB_RUNTIME_CHANGED: member changed during reading');
      sha256 = hash.digest('hex');
    } finally { fs.closeSync(handle); }
    if (hashes.size > 256) hashes.clear(); hashes.set(target, { stamp, sha256 });
  }
  return { path: relative, bytes: stat.size, sha256 };
}
function reference(root, expected) {
  assert(expected && Object.keys(expected).sort().join(',') === 'bytes,path,sha256' && Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && SHA.test(expected.sha256), 'XTB_RUNTIME_INVALID: exact member identity required');
  assert.deepEqual(fileIdentity(root, expected.path), expected, 'XTB_RUNTIME_CHANGED: member identity differs: ' + expected.path);
  return path.join(root, expected.path);
}
function readJson(root, expected, maximum = 1024 * 1024) {
  const target = reference(root, expected); assert(expected.bytes > 0 && expected.bytes <= maximum, 'XTB_RUNTIME_INVALID: metadata size');
  const bytes = fs.readFileSync(target);
  assert(bytes.length === expected.bytes && createHash('sha256').update(bytes).digest('hex') === expected.sha256, 'XTB_RUNTIME_CHANGED: metadata changed');
  return JSON.parse(bytes.toString('utf8'));
}
function walk(root, relative) {
  ordinary(root, relative, true); const found = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const member = relative + '/' + name, stat = fs.lstatSync(path.join(root, member));
    assert(!stat.isSymbolicLink(), 'XTB_RUNTIME_INVALID: linked inventory member');
    if (stat.isDirectory()) found.push(...walk(root, member)); else { ordinary(root, member); found.push(member); }
  }
  return found;
}
function verifyMemberInventory(root, files, contentRoots = ['bin', 'share/xtb']) {
  assert(Array.isArray(files) && files.length > 0 && files.length <= 4096 && new Set(files.map(row => row.path?.toLowerCase())).size === files.length, 'XTB_RUNTIME_INVALID: missing or duplicate inventory');
  for (const row of files) {
    assert(contentRoots.some(directory => row.path?.startsWith(directory + '/')), 'XTB_RUNTIME_INVALID: inventory outside declared content'); reference(root, row);
  }
  const actual = contentRoots.flatMap(directory => walk(root, directory)).sort(), declared = files.map(row => row.path).sort();
  assert.deepEqual(actual, declared, 'XTB_RUNTIME_CHANGED: complete file membership differs');
  return [...files].map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function identityPayload(record, rows, manifestSha256) {
  const legacy = record.schema === 'sciyue-xtb-bundled-runtime/v1';
  return {
    version: record.version,
    sourceCommit: record.source?.commit ?? null, buildId: legacy ? 'legacy-manifest-' + manifestSha256 : record.build.id,
    compiler: legacy ? null : record.build.compiler,
    toolchainArchiveSha256: legacy ? null : record.build.toolchainArchiveSha256,
    sourceReceiptSha256: legacy ? null : record.build.sourceReceiptSha256,
    scientificPinsSha256: legacy ? null : record.source.scientificPinsManifest.sha256,
    runtimeMemberDigest: digest(rows), parameterDigest: digest(rows.filter(row => row.path.startsWith('share/xtb/'))),
  };
}
function assertEngineIdentity(identity) {
  assert(identity?.schema === 'sciyue-xtb-engine-identity/v1' && identity.engine === 'xtb' && SHA.test(identity.sha256)
    && SHA.test(identity.runtimeMemberDigest) && SHA.test(identity.parameterDigest) && typeof identity.buildId === 'string' && identity.buildId.length > 0, 'XTB_RUNTIME_IDENTITY_REQUIRED: engine/build/parameter identity required');
  const { schema, engine, kind, sha256, ...payload } = identity;
  assert.equal(digest(payload), sha256, 'XTB_RUNTIME_IDENTITY_REQUIRED: engine identity digest differs');
  return identity;
}
function engineIdentity(record, rows, manifestSha256) {
  const payload = identityPayload(record, rows, manifestSha256);
  return { schema: 'sciyue-xtb-engine-identity/v1', engine: 'xtb', kind: record.schema.endsWith('/v1') ? 'legacy-binary-observation' : 'bundled-independent-rebuild', ...payload, sha256: digest(payload) };
}
function validateDescriptor(record) {
  assert(
    Boolean(record) &&
      ['sciyue-xtb-bundled-runtime/v1', 'sciyue-xtb-bundled-runtime/v2'].includes(record.schema) &&
      /^\d+\.\d+\.\d+(?:pre)?$/.test(record.version) &&
      ['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(record.platform) &&
      record.entry === entryForPlatform(record.platform) &&
      record.dataDirectory === 'share/xtb',
    'XTB_RUNTIME_INVALID: descriptor identity'
  );
  assert(record.scope === 'local-experimental' && record.localUseReady === true && canonical(record.methods) === canonical(['gfn0', 'gfn1', 'gfn2', 'gfnff']), 'XTB_RUNTIME_INCOMPLETE: current methods/readiness required');
  if (record.schema.endsWith('/v2')) {
    assert(/^[a-f0-9]{40}$/.test(record.source?.commit) && SHA.test(record.source?.scientificPinsManifest?.sha256), 'XTB_RUNTIME_INVALID: pinned scientific source required');
    assert(typeof record.build?.id === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(record.build.id) && typeof record.build.compiler?.name === 'string'
      && typeof record.build.compiler?.version === 'string' && SHA.test(record.build.toolchainArchiveSha256) && SHA.test(record.build.sourceReceiptSha256), 'XTB_RUNTIME_INVALID: exact build identity required');
    assert(record.modified?.local === true && record.modified.kind === 'independent-rebuild' && record.modified.upstreamBinaryIdentity === false, 'XTB_RUNTIME_INVALID: independent rebuild must not claim upstream binary identity');
    assert(record.inventory?.path === 'inventory.json', 'XTB_RUNTIME_INVALID: fixed inventory entry required');
  }
  return record;
}
module.exports = {
  REQUIRED,
  REQUIRED_PARAMETERS,
  WIN32_V1_LIBRARIES,
  DARWIN_V1_LIBRARIES,
  entryForPlatform,
  requiredMembersForPlatform,
  contentRootsForPlatform,
  canonical,
  digest,
  ordinary,
  fileIdentity,
  reference,
  readJson,
  walk,
  verifyMemberInventory,
  validateDescriptor,
  engineIdentity,
  assertEngineIdentity
};
