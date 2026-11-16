import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, rename, unlink, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, basename, sep, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileChecked } from './io.mjs';
import { prepareLibxtbRuntime, verifyLibxtbRuntime } from './pes-libxtb-runtime.mjs';

const defaultRoot = resolve(import.meta.dirname, '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const identity = (path, bytes) => ({ path, bytes: bytes.length, sha256: digest(bytes) });

/** Expand only the locked retirement declaration against a known runtime manifest.
 * Assemblers can omit these exact members while copying the accepted base.
 */
export function planRetiredPesMembers({ manifest, lock }) {
  const declaration = lock.retiredRuntime;
  if (!declaration) return [];
  const safe = value => typeof value === 'string' && value.length > 0
    && !value.includes('\\') && !value.startsWith('/') && !value.includes(':')
    && value.split('/').filter(Boolean).every(part => part !== '.' && part !== '..');
  const members = declaration.members ?? [], prefixes = declaration.memberPrefixes ?? [];
  assert(members.every(value => safe(value) && !value.endsWith('/')), 'Invalid retired PES member');
  assert(prefixes.every(value => safe(value) && value.endsWith('/')), 'Invalid retired PES prefix');
  const selected = manifest.members.filter(row => members.includes(row.path) || prefixes.some(prefix => row.path.startsWith(prefix)));
  assert(new Set(selected.map(row => row.path)).size === selected.length, 'Duplicate retired PES member');
  for (const row of selected) assert(safe(row.path) && Number.isSafeInteger(row.bytes) && row.bytes >= 0
    && /^[a-f0-9]{64}$/.test(row.sha256), 'Invalid retired PES identity');
  return selected;
}
async function replaceChanged(file, bytes) {
  try { if ((await readFile(file)).equals(bytes)) return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = file + '.pes-refresh-' + randomUUID() + '.tmp';
  await writeFile(pending, bytes, { flag: 'wx' });
  try { await rename(pending, file); }
  catch (error) { await unlink(pending); throw error; }
  return true;
}

/** Refresh only the product-owned PES sources in an existing staged runtime.
 * Native Python and retained third-party identities are preserved; explicitly
 * retired members are removed only from this owned staging copy.
 * Call before the assembly computes its final portable member manifest.
 * After forced termination discard the incomplete stage or refresh it again,
 * then verify every staged member before producing the final package manifest.
 */
export async function refreshPesProductRuntime({ sourceRoot = defaultRoot, stagingRoot, stagingReceipt, residentRoot } = {}) {
  sourceRoot = resolve(sourceRoot);
  assert(typeof stagingRoot === 'string' && stagingRoot, 'An explicit staged portable package is required');
  stagingRoot = resolve(stagingRoot);
  assert(stagingRoot !== sourceRoot && !sourceRoot.startsWith(stagingRoot+sep), 'Staging cannot contain the source checkout');
  const stagedRelative = relative(sourceRoot, stagingRoot);
  const internalStage = stagedRelative && !isAbsolute(stagedRelative) && stagedRelative !== '..' && !stagedRelative.startsWith('..' + sep);
  assert(internalStage || typeof stagingReceipt === 'string',
    'The staging package must be a child of this checkout or carry an explicit staging owner receipt');
  if (!internalStage) {
    const owner = JSON.parse(await readFileChecked(resolve(stagingReceipt)));
    assert.equal(owner.schema, 'ester-pes-staging-owner/v1');
    assert.equal(resolve(owner.sourceRoot), sourceRoot);assert.equal(resolve(owner.stagingRoot), stagingRoot);
    const sourcePackage = await readFileChecked(join(sourceRoot, 'package.json'));
    const stagedPackage = JSON.parse(await readFileChecked(join(stagingRoot, 'runtime/resources/app/package.json')));
    const product = JSON.parse(sourcePackage);
    assert.equal(owner.sourcePackageSha256, digest(sourcePackage));
    assert.equal(owner.packageVersion, product.version);assert.equal(stagedPackage.version, product.version);
    assert.equal(stagedPackage.name, product.name);
  }
  async function ordinary(target, directory = false) {
    target = resolve(target);
    const contained = root => { const name=relative(root,target);return name&&!isAbsolute(name)&&name!=='..'&&!name.startsWith('..'+sep); };
    assert(contained(sourceRoot)||contained(stagingRoot), 'Target escaped source and declared staging roots');
    let current = parse(target).root;
    for (const part of relative(current,target).split(sep)) {
      current = join(current, part);
      assert(!(await lstat(current)).isSymbolicLink(), 'Staging/source paths must be ordinary');
    }
    const stat = await lstat(target);
    assert(directory ? stat.isDirectory() : stat.isFile(), 'Staging/source member type differs');
  }
  const runtimeRoot = join(stagingRoot, 'runtime/resources/pes');
  const dependencySummary = join(stagingRoot, 'runtime/provenance/dependencies.json');
  await ordinary(runtimeRoot, true);
  await ordinary(join(stagingRoot, 'runtime/resources/app/package.json'));
  await ordinary(dependencySummary);
  const dependencies = JSON.parse(await readFile(dependencySummary));
  assert(dependencies.pes, 'The staging dependency summary must contain PES');
  const lockPath = 'desktop/packaging/pes-runtime.lock.json';
  const lockBytes = await readFile(join(sourceRoot, lockPath));
  const lock = JSON.parse(lockBytes);
  const stagedLockPath = join(stagingRoot, 'runtime/resources/app', lockPath);
  await ordinary(stagedLockPath);
  assert((await readFile(stagedLockPath)).equals(lockBytes), 'Staged application PES lock differs from this checkout');
  const manifestPath = join(runtimeRoot, 'runtime.json');
  await ordinary(manifestPath);
  await ordinary(join(runtimeRoot, lock.entrypoints.python));
  await ordinary(join(runtimeRoot, lock.entrypoints.bootstrap));
  await ordinary(join(sourceRoot, 'desktop/packaging/pes-runtime-bootstrap.py'));
  const beforeBytes = await readFile(manifestPath), manifest = JSON.parse(beforeBytes);
  assert.equal(manifest.schema, lock.schema);
  const currentLockSha256 = digest(lockBytes), upgrading = manifest.lockSha256 !== currentLockSha256;
  if (upgrading) {
    assert(lock.baseRuntime, 'The copied third-party PES closure belongs to another lock');
    assert.equal(manifest.lockSha256, lock.baseRuntime.lockSha256, 'The copied third-party PES closure belongs to another lock');
    assert.equal(beforeBytes.length, lock.baseRuntime.runtimeManifest.bytes, 'Accepted PES base manifest size differs');
    assert.equal(digest(beforeBytes), lock.baseRuntime.runtimeManifest.sha256, 'Accepted PES base manifest identity differs');
  }
  assert.equal(dependencies.pes.lock.sha256, manifest.lockSha256, 'Dependency summary PES lock differs');
  assert.equal(dependencies.pes.runtimeManifest.sha256, digest(beforeBytes), 'Staged PES manifest anchor differs');
  assert.equal(dependencies.pes.runtimeManifest.bytes, beforeBytes.length, 'Staged PES manifest size differs');
  const pythonBytes = await readFile(join(runtimeRoot, lock.entrypoints.python));
  assert.equal(digest(pythonBytes), lock.pythonSha256, 'The accepted PES Python executable changed');
  const planned = [];
  const destinations = new Set();
  for (const source of lock.productModules) {
    assert(source.startsWith('desktop/chemistry/') && source.endsWith('.py')
      && !relative(sourceRoot, resolve(sourceRoot, source)).startsWith('..'), 'Invalid PES product source');
    const path = 'chemistry/' + basename(source);
    assert(!destinations.has(path), 'Duplicate PES product module destination');
    destinations.add(path);
    await ordinary(join(sourceRoot, source));
    try { await ordinary(join(runtimeRoot, path)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    planned.push({ source, path, bytes: await readFile(join(sourceRoot, source)) });
  }
  const bootstrapSource = 'desktop/packaging/pes-runtime-bootstrap.py';
  const bootstrap = await readFile(join(sourceRoot, bootstrapSource));
  assert.equal(digest(bootstrap), lock.bootstrapSha256, 'Bootstrap source differs from the PES lock');
  planned.push({ source: bootstrapSource, path: lock.entrypoints.bootstrap, bytes: bootstrap });
  const old = new Map(manifest.members.map(row => [row.path, row]));
  const updated = new Map(old);
  const refreshed = [];
  const retired = planRetiredPesMembers({ manifest, lock });
  const retiredPaths = new Set(retired.map(row => row.path));
  const retireExisting = [], alreadyAbsent = [];
  // Verify the complete declared directory contents before deleting any file.
  // Unexpected members and links stop the batch instead of widening its scope.
  async function inspectRetiredDirectory(relativePath) {
    const directory = join(runtimeRoot, relativePath);
    try { await ordinary(directory, true); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const member = relativePath + entry.name;
      if (entry.isDirectory()) await inspectRetiredDirectory(member + '/');
      else assert(entry.isFile() && retiredPaths.has(member), 'Unexpected retired PES directory member: ' + member);
    }
  }
  for (const prefix of lock.retiredRuntime?.memberPrefixes ?? []) await inspectRetiredDirectory(prefix);
  for (const row of retired) {
    const target = join(runtimeRoot, row.path);
    try { await ordinary(target); }
    catch (error) { if (error.code === 'ENOENT') { alreadyAbsent.push(row); continue; } throw error; }
    const bytes = await readFile(target);
    assert.equal(bytes.length, row.bytes, 'Retired PES member size changed: ' + row.path);
    assert.equal(digest(bytes), row.sha256, 'Retired PES member identity changed: ' + row.path);
    retireExisting.push(row);
  }
  let componentLock, componentTarget;
  if (lock.residentLibrary) {
    const descriptor=lock.residentLibrary;
    assert.equal(descriptor.subdirectory,'libxtb');assert.equal(descriptor.manifestPath,'runtime.json');
    const componentLockPath=resolve(sourceRoot,descriptor.lockPath);await ordinary(componentLockPath);
    componentLock=JSON.parse(await readFile(componentLockPath));
    assert.equal(componentLock.runtimeManifest.sha256,descriptor.manifestSha256);
    componentTarget=join(runtimeRoot,descriptor.subdirectory);
    await verifyLibxtbRuntime(residentRoot?resolve(residentRoot):componentTarget,componentLock);
  }
  // No broad recursive deletion: this is the exact prevalidated file list.
  for (const row of retireExisting) await unlink(join(runtimeRoot, row.path));
  for (const row of retired) updated.delete(row.path);
  for (const row of planned) {
    await mkdir(dirname(join(runtimeRoot, row.path)), { recursive: true });
    const changed = await replaceChanged(join(runtimeRoot, row.path), row.bytes);
    refreshed.push({ source: row.source, ...identity(row.path, row.bytes), changed });
    updated.set(row.path, identity(row.path, row.bytes));
  }
  let residentLibrary;
  if (lock.residentLibrary) {
    const descriptor = lock.residentLibrary;
    if (residentRoot) await prepareLibxtbRuntime({inputRoot:resolve(residentRoot),outputRoot:componentTarget,lock:componentLock});
    const component = await verifyLibxtbRuntime(componentTarget,componentLock);
    assert.equal(component.manifest.schema, descriptor.schema);
    for (const row of component.files) updated.set(descriptor.subdirectory+'/'+row.path,
      {...row,path:descriptor.subdirectory+'/'+row.path});
    residentLibrary = {subdirectory:descriptor.subdirectory,runtimeManifest:component.reference,identity:component.manifest.identity};
    manifest.residentLibrary = residentLibrary;
    dependencies.pes.residentLibrary = residentLibrary;
  }
  manifest.lockSha256 = digest(lockBytes);
  manifest.entrypointSha256 = { ...manifest.entrypointSha256, python: digest(pythonBytes),
    bootstrap: digest(bootstrap), worker: digest(await readFile(join(runtimeRoot, lock.entrypoints.worker))) };
  manifest.members = [...updated.values()];
  const manifestBytes = encoded(manifest);
  const manifestChanged = await replaceChanged(manifestPath, manifestBytes);
  dependencies.pes.lock = { ...dependencies.pes.lock, bytes: lockBytes.length, sha256: digest(lockBytes) };
  dependencies.pes.runtimeManifest = identity('runtime.json', manifestBytes);
  dependencies.pes.members = manifest.members.length + 1;
  dependencies.pes.bytes = manifest.members.reduce((sum, row) => sum + row.bytes, manifestBytes.length);
  let dependencySummaryChanged;
  try { dependencySummaryChanged = await replaceChanged(dependencySummary, encoded(dependencies)); }
  catch (error) {
    // Keep the old matching metadata pair so a retry can complete the overlay.
    // Already-refreshed modules remain subject to the assembly's full member check.
    try { await replaceChanged(manifestPath, beforeBytes); }
    catch (restoreError) { throw new AggregateError([error, restoreError], 'PES staging refresh failed and metadata recovery failed'); }
    throw error;
  }
  return { schema: 'ester-pes-product-refresh/v1', sourceRoot, stagingRoot, runtimeRoot,
    previousManifest: identity('runtime.json', beforeBytes), manifest: identity('runtime.json', manifestBytes),
    lock: identity(lockPath, lockBytes), refreshed, retired: { removed: retireExisting, alreadyAbsent },
    manifestChanged, dependencySummaryChanged, members: dependencies.pes.members,
    bytes: dependencies.pes.bytes, ...(residentLibrary?{residentLibrary}:{}),
    ...(upgrading?{upgradedFromLockSha256:lock.baseRuntime.lockSha256}:{}),scientificProcessesStarted: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/portable/refresh-pes-product-runtime.mjs --staging <copied-portable-package> [--staging-receipt <owner.json>] [--resident-runtime <locked-libxtb-root>]\n'
      + 'Refreshes checkout-owned PES modules and identities. External staging requires a source/package-bound owner receipt.\n'
      + 'Run after copying the prior accepted runtime and before producing final release and portable manifests.');
  } else {
    assert(args.length%2===0,'Pass complete option pairs');const options={};
    for(let i=0;i<args.length;i+=2){assert(['--staging','--staging-receipt','--resident-runtime'].includes(args[i]),'Unknown PES refresh option');assert(!options[args[i]],'Duplicate PES refresh option');options[args[i]]=args[i+1];}
    assert(options['--staging'],'Use --help or --staging <copied-portable-package>');
    const result = await refreshPesProductRuntime({ stagingRoot:options['--staging'],stagingReceipt:options['--staging-receipt'],residentRoot:options['--resident-runtime'] });
    console.log(JSON.stringify(result, null, 2));
  }
}
