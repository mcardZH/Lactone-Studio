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
const WIN32_GNU_V1_LIBRARIES = Object.freeze([
  'bin/libgfortran-5.dll',
  'bin/libgomp-1.dll',
  'bin/libquadmath-0.dll',
  'bin/libwinpthread-1.dll'
]);
const DARWIN_V1_LIBRARIES = Object.freeze([
  'lib/libblas.3.dylib',
  'lib/libgcc_s.1.1.dylib',
  'lib/libgfortran.5.dylib',
  'lib/liblapack.3.dylib',
  'lib/libomp.dylib',
  'lib/libopenblas.0.dylib',
  'lib/libquadmath.0.dylib'
]);
const LINUX_V1_LIBRARIES = Object.freeze([
  'lib/libgfortran.so.5',
  'lib/libgomp.so.1',
  'lib/libquadmath.so.0'
]);
function entryForPlatform(platform = 'win32-x64') {
  if (platform === 'win32-x64') return 'bin/xtb.exe';
  if (platform === 'darwin-arm64' || platform === 'darwin-x64' || platform === 'linux-x64') return 'bin/xtb';
  assert.fail('XTB_RUNTIME_INVALID: descriptor identity');
}
function requiredMembersForPlatform(platform = 'win32-x64') {
  return Object.freeze([entryForPlatform(platform), ...REQUIRED_PARAMETERS]);
}
function contentRootsForPlatform(platform = 'win32-x64') {
  if (platform === 'win32-x64') return Object.freeze(['bin', 'share/xtb']);
  if (platform === 'darwin-arm64' || platform === 'darwin-x64' || platform === 'linux-x64') return Object.freeze(['bin', 'lib', 'share/xtb']);
  assert.fail('XTB_RUNTIME_INVALID: descriptor identity');
}
const RUNTIME_SET = 'sciyue-xtb-bundled-runtime/v3';
const EXTERNAL_GXTB_RUNTIME_SET = 'sciyue-xtb-bundled-runtime/v4';
const isRuntimeSet = record => [RUNTIME_SET, EXTERNAL_GXTB_RUNTIME_SET].includes(record?.schema);
const SET_ROOTS = Object.freeze(['bin', 'share/xtb', 'licenses', 'variants', 'provenance']);
const GFN = Object.freeze(['gfn0', 'gfn1', 'gfn2', 'gfnff']);
const SET_VARIANTS = Object.freeze({
  official: { root: '', entry: 'bin/xtb.exe', kind: 'official-release' },
  'gfn0-stack64': { root: '', entry: 'bin/xtb680-stack64.exe', kind: 'pe-stack-derivative' },
  gxtb: { root: 'variants/gxtb', entry: 'bin/xtb.exe', kind: 'official-gxtb-release' },
  fire: { root: 'variants/fire', entry: 'bin/xtb.exe', kind: 'fire-step-limit-rebuild' },
});
const forVariant = (value, callback) => Object.fromEntries(Object.keys(value).map(id => [id, callback(value[id], id)]));
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
function isSafeRelativeMemberPath(relative) {
  return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !relative.includes('\0')
    && !path.isAbsolute(relative)
    && relative.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'));
}
function isValidExternalMember(row, restrictLibDepth) {
  if (!row || typeof row !== 'object' || !isSafeRelativeMemberPath(row.path)) return false;
  if (restrictLibDepth) {
    const parts = row.path.split('/');
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== 'lib')) return false;
  }
  return Number.isSafeInteger(row.bytes) && row.bytes >= 0 && SHA.test(row.sha256);
}
function assertEngineIdentity(identity) {
  assert(identity?.schema === 'sciyue-xtb-engine-identity/v1' && identity.engine === 'xtb' && SHA.test(identity.sha256)
    && SHA.test(identity.runtimeMemberDigest) && SHA.test(identity.parameterDigest) && typeof identity.buildId === 'string' && identity.buildId.length > 0, 'XTB_RUNTIME_IDENTITY_REQUIRED: engine/build/parameter identity required');
  const { schema, engine, kind, sha256, ...payload } = identity;
  assert.equal(digest(payload), sha256, 'XTB_RUNTIME_IDENTITY_REQUIRED: engine identity digest differs');
  if (kind === 'external-user-program') {
    assert(payload.runtimeVariant === 'gxtb' && payload.provider === 'user-external-cli'
      && SHA.test(payload.executableSha256) && Array.isArray(payload.capabilities) && payload.capabilities.includes('gxtb-cli')
      && [payload.version,payload.hostVersion,payload.gxtbRelease].every(value => value === null || typeof value === 'string')
      && Array.isArray(payload.members) && payload.members.length > 0
      && payload.members.every(row => isValidExternalMember(row, true))
      && Array.isArray(payload.parameters)
      && payload.parameters.every(row => isValidExternalMember(row, false)), 'XTB_RUNTIME_IDENTITY_REQUIRED: external g-xTB evidence required');
    return identity;
  }
  if (payload.runtimeVariant !== undefined) {
    assert(Object.hasOwn(SET_VARIANTS, payload.runtimeVariant)
      && SET_VARIANTS[payload.runtimeVariant].kind === kind
      && SHA.test(payload.runtimeManifestSha256), 'XTB_RUNTIME_IDENTITY_REQUIRED: invalid variant identity');
    if (payload.runtimeVariant === 'gxtb') {
      assert(payload.gxtbRelease === '2.0.1' && payload.version === '6.7.1'
        && payload.hostVersion === '6.7.1' && payload.sourceCommit === '30c6303'
        && payload.hostCommit === '30c6303', 'XTB_RUNTIME_IDENTITY_REQUIRED: g-xTB release and host identity required');
    }
  }
  return identity;
}
function engineIdentity(record, rows, manifestSha256) {
  const payload = identityPayload(record, rows, manifestSha256);
  return { schema: 'sciyue-xtb-engine-identity/v1', engine: 'xtb', kind: record.schema.endsWith('/v1') ? 'legacy-binary-observation' : 'bundled-independent-rebuild', ...payload, sha256: digest(payload) };
}
function validateDescriptor(record) {
  if (isRuntimeSet(record)) return validateRuntimeSet(record);
  assert(
    Boolean(record) &&
      ['sciyue-xtb-bundled-runtime/v1', 'sciyue-xtb-bundled-runtime/v2'].includes(record.schema) &&
      /^\d+\.\d+\.\d+(?:pre)?$/.test(record.version) &&
      ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'].includes(record.platform) &&
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

function validateRuntimeSet(record) {
  assert(isRuntimeSet(record) && record.platform === 'win32-x64' && record.version === '6.8.0' && record.entry === 'bin/xtb.exe'
    && record.dataDirectory === 'share/xtb' && record.inventory?.path === 'inventory.json'
    && record.scope === 'local-experimental' && record.localUseReady === true
    && canonical(record.methods) === canonical(record.schema === EXTERNAL_GXTB_RUNTIME_SET ? GFN : [...GFN, 'gxtb'])
    && canonical(Object.keys(record.variants ?? {}).sort()) === canonical(Object.keys(SET_VARIANTS).filter(id => record.schema !== EXTERNAL_GXTB_RUNTIME_SET || id !== 'gxtb').sort())
    && (record.schema !== EXTERNAL_GXTB_RUNTIME_SET || record.externalProviders?.gxtb === 'user-supplied-cli'),
  'XTB_RUNTIME_INVALID: incomplete runtime set');
  forVariant(record.variants, (variant, id) => {
    const expected = SET_VARIANTS[id];
    assert(variant && variant.root === expected.root && variant.entry === expected.entry && variant.kind === expected.kind
      && typeof variant.buildId === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(variant.buildId)
      && SHA.test(variant.executableSha256) && SHA.test(variant.sourceReceiptSha256),
    'XTB_RUNTIME_INVALID: fixed variant entry and build identity required: ' + id);
    if (id === 'gxtb') {
      assert(variant.version === '6.7.1' && variant.hostVersion === '6.7.1' && variant.gxtbRelease === '2.0.1'
        && variant.sourceCommit === '30c6303' && variant.hostCommit === '30c6303' && SHA.test(variant.archiveSha256),
      'XTB_RUNTIME_INVALID: separate g-xTB release and host identities required');
    } else {
      assert(variant.version === record.version && /^[a-f0-9]{40}$/.test(variant.sourceCommit),
        'XTB_RUNTIME_INVALID: pinned xTB source required: ' + id);
      if (id === 'fire') {
        assert(variant.compiler?.name === 'gfortran' && variant.compiler?.version === '13.2.0'
          && SHA.test(variant.toolchainArchiveSha256) && variant.stackReserveBytes === 67108864
          && variant.fireStepLimit === 'remaining-microcycles-v1',
        'XTB_RUNTIME_INVALID: missing FIRE build or algorithm identity');
      } else {
        assert(SHA.test(variant.archiveSha256), 'XTB_RUNTIME_INVALID: official archive identity required');
        if (id === 'gfn0-stack64') assert(variant.stackReserveBytes === 67108864
          && variant.archiveSha256 === record.variants.official.archiveSha256
          && variant.parentExecutableSha256 === record.variants.official.executableSha256
          && variant.executableSha256 !== variant.parentExecutableSha256, 'XTB_RUNTIME_INVALID: GFN0 PE-only derivative identity required');
      }
    }
  });
  return record;
}

function runtimeSetVariant({ method, operation, periodic }) {
  assert(method === undefined || GFN.includes(method) || method === 'gxtb', 'XTB_RUNTIME_INVALID: unsupported method');
  assert(periodic === undefined || typeof periodic === 'boolean', 'XTB_RUNTIME_INVALID: periodic context must be boolean');
  if (method === 'gxtb') {
    assert(!periodic, 'XTB_RUNTIME_INVALID: g-xTB has no periodic route');
    return 'gxtb';
  }
  if (periodic && ['optimize', 'optimization'].includes(operation)) return 'fire';
  return method === 'gfn0' ? 'gfn0-stack64' : 'official';
}

function variantMembers(record, files, id) {
  const variant = record.variants[id], prefix = variant.root ? variant.root + '/' : '';
  return files.filter(row => row.path.startsWith(prefix + 'share/xtb/')
    || (row.path.startsWith(prefix + 'bin/') && (
      row.path.endsWith('.dll') || row.path === prefix + variant.entry
    ))).map(row => ({ path: row.path.slice(prefix.length), bytes: row.bytes, sha256: row.sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function verifiedVariant(record, files, id, manifestSha256) {
  const variant = record.variants[id], members = variantMembers(record, files, id);
  for (const relative of [variant.entry, ...REQUIRED.slice(1)]) {
    assert(members.some(row => row.path === relative), 'XTB_RUNTIME_INCOMPLETE: required parameter/executable absent: ' + id);
  }
  assert.equal(members.find(row => row.path === variant.entry).sha256, variant.executableSha256,
    'XTB_RUNTIME_CHANGED: executable does not match variant identity: ' + id);
  assert.equal(files.find(row => row.path === 'provenance/' + id + '.json')?.sha256, variant.sourceReceiptSha256,
    'XTB_RUNTIME_CHANGED: source receipt does not match variant identity: ' + id);
  const { root: ignoredRoot, entry: ignoredEntry, kind, ...provenance } = variant;
  const payload = {
    runtimeVariant: id, runtimeManifestSha256: manifestSha256,
    compiler: null, toolchainArchiveSha256: null, scientificPinsSha256: null, ...provenance,
    runtimeMemberDigest: digest(members),
    parameterDigest: digest(members.filter(row => row.path.startsWith('share/xtb/'))),
  };
  const identity = assertEngineIdentity({ schema: 'sciyue-xtb-engine-identity/v1', engine: 'xtb', kind, ...payload, sha256: digest(payload) });
  return { ...variant, engineIdentity: identity };
}

function verifyRuntimeVariant(root, expectedManifest, id) {
  assert(Object.hasOwn(SET_VARIANTS, id), 'XTB_RUNTIME_INVALID: unknown runtime variant');
  const record = validateRuntimeSet(readJson(root, expectedManifest));
  const inventory = readJson(root, record.inventory, 8 * 1024 * 1024), files = inventory.files;
  assert(inventory.schema === 'sciyue-xtb-runtime-inventory/v1' && Array.isArray(files)
    && new Set(files.map(row => row.path?.toLowerCase())).size === files.length,
  'XTB_RUNTIME_INVALID: missing or duplicate inventory');
  const selected = verifiedVariant(record, files, id, expectedManifest.sha256);
  const members = variantMembers(record, files, id);
  const variantRoot = selected.root ? ordinary(root, selected.root, true).target : root;
  for (const row of members) reference(variantRoot, row);
  const source = files.find(row => row.path === 'provenance/' + id + '.json');
  reference(root, source);
  // Only the chosen executable, its loader DLL directory, and its parameters
  // can affect this run. Other native variants have independent availability.
  ordinary(variantRoot, 'bin', true);
  const actual = [
    ...fs.readdirSync(path.join(variantRoot, 'bin')).filter(name => name.toLowerCase().endsWith('.dll')).map(name => 'bin/' + name),
    selected.entry,
    ...walk(variantRoot, 'share/xtb'),
  ].sort();
  assert.deepEqual(actual, members.map(row => row.path).sort(),
    'XTB_RUNTIME_CHANGED: selected variant membership differs: ' + id);
  return { record, variants: { [id]: selected } };
}

function verifyRuntimeSet(root, expectedManifest) {
  const record = validateRuntimeSet(readJson(root, expectedManifest));
  const inventory = readJson(root, record.inventory, 8 * 1024 * 1024);
  assert(inventory.schema === 'sciyue-xtb-runtime-inventory/v1', 'XTB_RUNTIME_INVALID: runtime inventory schema');
  const files = verifyMemberInventory(root, inventory.files, SET_ROOTS);
  // The only root metadata outside the complete payload inventory is the
  // anchored descriptor and its referenced inventory.
  assert.deepEqual(fs.readdirSync(root).sort(), ['bin', 'inventory.json', 'licenses', 'provenance', 'runtime.json', 'share', 'variants'],
    'XTB_RUNTIME_CHANGED: runtime root membership differs');
  assert.deepEqual(fs.readdirSync(path.join(root, 'share')), ['xtb'], 'XTB_RUNTIME_CHANGED: runtime share membership differs');
  const variants = forVariant(record.variants, (_, id) => verifiedVariant(record, files, id, expectedManifest.sha256));
  assert.equal(variants.official.engineIdentity.parameterDigest, variants['gfn0-stack64'].engineIdentity.parameterDigest,
    'XTB_RUNTIME_CHANGED: PE derivative must preserve official parameters');
  assert.equal(variants.official.engineIdentity.parameterDigest, variants.fire.engineIdentity.parameterDigest,
    'XTB_RUNTIME_CHANGED: FIRE derivative must preserve official parameters');
  return { record, variants };
}

module.exports = {
  REQUIRED,
  REQUIRED_PARAMETERS,
  WIN32_V1_LIBRARIES,
  WIN32_GNU_V1_LIBRARIES,
  DARWIN_V1_LIBRARIES,
  LINUX_V1_LIBRARIES,
  entryForPlatform,
  requiredMembersForPlatform,
  contentRootsForPlatform,
  RUNTIME_SET,
  EXTERNAL_GXTB_RUNTIME_SET,
  isRuntimeSet,
  SET_ROOTS,
  SET_VARIANTS,
  canonical,
  digest,
  ordinary,
  fileIdentity,
  reference,
  readJson,
  walk,
  verifyMemberInventory,
  validateDescriptor,
  validateRuntimeSet,
  engineIdentity,
  assertEngineIdentity,
  runtimeSetVariant,
  verifyRuntimeSet,
  verifyRuntimeVariant,
};
