'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { assert, within } = require('./security.cjs');
const { developmentXtb } = require('./current-runtime.cjs');
const contract = require('./xtb-runtime-contract.cjs');

/** Bundled multi-platform GFN variants and an explicitly configured external g-xTB CLI. No PATH search or acquisition. */
async function xtbRuntime({
  packaged,
  resourcesPath,
  appPath,
  provenanceRoot,
  platform = process.platform,
  arch = process.arch,
  platformId,
  method,
  operation,
  periodic,
  externalGxtb,
  signal,
}) {
  if (method === 'gxtb') {
    assert(!periodic, 'XTB_RUNTIME_INVALID: g-xTB has no periodic route');
    assert(externalGxtb && typeof externalGxtb.resolve === 'function', 'GXTB_NOT_CONFIGURED: 请先在全局设置中配置 g-xTB 程序（用户自备）');
    return externalGxtb.resolve({ signal });
  }
  const variantId = contract.runtimeSetVariant({ method, operation, periodic });
  const expectedPlatform = platformId || `${platform}-${arch}`;
  const selected = packaged ? null : developmentXtb(appPath, { platform, arch, platformId: expectedPlatform, variantId });
  const root = packaged ? path.join(resourcesPath, 'xtb') : selected.root;
  const observed = contract.fileIdentity(root, 'runtime.json');
  let expectedManifest = selected?.manifestIdentity;
  let packagedVariants;
  if (packaged) {
    const provenance = provenanceRoot ? path.resolve(provenanceRoot) : path.resolve(resourcesPath, '../provenance');
    let summaryIdentity;
    try { summaryIdentity = contract.fileIdentity(provenance, 'dependencies.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (summaryIdentity) {
      const summary = contract.readJson(provenance, summaryIdentity), anchor = summary.xtb?.runtimeManifest;
      assert(summary.schema === 'sciyue-portable-dependency-summary/v1' && anchor?.path === 'runtime.json', 'XTB_RUNTIME_INVALID: package xTB manifest anchor required');
      expectedManifest = anchor;
      packagedVariants = summary.xtb.variants;
    }
  }
  const record = selected?.runtimeSet?.record ?? contract.validateDescriptor(contract.readJson(root, expectedManifest ?? observed));
  assert(record.platform === expectedPlatform, 'XTB_RUNTIME_INVALID: descriptor platform mismatch');
  if (contract.isRuntimeSet(record)) {
    assert(expectedManifest, 'XTB_RUNTIME_INVALID: package xTB manifest anchor required');
    const { variants } = selected?.runtimeSet ?? contract.verifyRuntimeVariant(root, expectedManifest, variantId);
    if (packaged) {
      assert(contract.canonical(variants[variantId].engineIdentity) === contract.canonical(packagedVariants?.[variantId]),
        'XTB_RUNTIME_INVALID: package xTB variant anchors required');
    }
    const { root: subroot, entry, engineIdentity, version, gxtbRelease, hostVersion, hostCommit } = variants[variantId];
    const variantRoot = path.join(root, subroot);
    const executable = path.join(variantRoot, ...entry.split('/'));
    return {
      root: variantRoot,
      directory: path.dirname(executable),
      executable,
      dataDirectory: path.join(variantRoot, 'share/xtb'),
      version,
      engineIdentity,
      ...(gxtbRelease ? { gxtbRelease, hostVersion, hostCommit } : {}),
    };
  }
  const directory = path.join(root, 'bin'), dataDirectory = path.join(root, 'share/xtb');
  const executable = path.join(root, ...record.entry.split('/'));
  const contentRoots = contract.contentRootsForPlatform(record.platform);
  let hasLibDir = false;
  try {
    fsSync.lstatSync(path.join(root, 'lib'));
    hasLibDir = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const isStaticDarwinRuntime =
    (record.platform === 'darwin-arm64' || record.platform === 'darwin-x64') &&
    record.version === '6.8.0' &&
    !hasLibDir;
  const activeContentRoots = isStaticDarwinRuntime ? ['bin', 'share/xtb'] : contentRoots;
  let members;
  if (record.schema === 'sciyue-xtb-bundled-runtime/v2') {
    // No environment override or self-declared local replacement bypasses the
    // fixed product descriptor anchor. Existing v1 remains its legacy scope.
    assert(expectedManifest, 'XTB_RUNTIME_INVALID: package xTB manifest anchor required');
    const inventory = contract.readJson(root, record.inventory, 8 * 1024 * 1024);
    assert(inventory.schema === 'sciyue-xtb-runtime-inventory/v1', 'XTB_RUNTIME_INVALID: runtime inventory schema');
    members = contract.verifyMemberInventory(root, inventory.files, activeContentRoots);
  } else {
    // Keep the previous v1 route at its existing scope, without calling its
    // observed bytes an official v2 rebuild or accepting a replacement alias.
    let requiredLibraries;
    if (record.platform === 'win32-x64') {
      const hasGnuRuntime = fsSync.existsSync(path.join(root, ...contract.WIN32_GNU_V1_LIBRARIES[0].split('/')));
      requiredLibraries = hasGnuRuntime ? contract.WIN32_GNU_V1_LIBRARIES : contract.WIN32_V1_LIBRARIES;
    } else if (record.platform === 'linux-x64') {
      requiredLibraries = contract.LINUX_V1_LIBRARIES;
    } else {
      requiredLibraries = isStaticDarwinRuntime ? [] : contract.DARWIN_V1_LIBRARIES;
    }
    for (const relative of requiredLibraries) contract.ordinary(root, relative);
    members = activeContentRoots.flatMap(dir => contract.walk(root, dir)).map(relative => contract.fileIdentity(root, relative)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  const requiredMembers = contract.requiredMembersForPlatform(record.platform);
  for (const relative of requiredMembers) {
    const target = path.resolve(root, relative), stat = await fs.lstat(target);
    assert(within(root, target) && stat.isFile() && !stat.isSymbolicLink(), 'XTB_RUNTIME_INCOMPLETE: 缺少随包xTB运行文件');
    if (relative === record.entry && record.platform !== 'win32-x64' && process.platform !== 'win32') {
      assert((stat.mode & 0o111) !== 0, 'XTB_RUNTIME_INVALID: xTB executable mode required');
    }
    assert(members.some(row => row.path === relative), 'XTB_RUNTIME_INCOMPLETE: required parameter/executable absent from inventory');
  }
  return { root, directory, executable, dataDirectory, version: record.version, engineIdentity: contract.engineIdentity(record, members, observed.sha256) };
}
module.exports = { xtbRuntime };
