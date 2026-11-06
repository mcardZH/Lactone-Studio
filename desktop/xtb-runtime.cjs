'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { assert, within } = require('./security.cjs');
const { developmentXtb } = require('./current-runtime.cjs');
const contract = require('./xtb-runtime-contract.cjs');

/** No PATH search, user executable selection, download or system installation. */
async function xtbRuntime({ packaged, resourcesPath, appPath }) {
  const selected = packaged ? null : developmentXtb(appPath);
  const root = packaged ? path.join(resourcesPath, 'xtb') : selected.root;
  const directory = path.join(root, 'bin'), dataDirectory = path.join(root, 'share/xtb');
  const executable = path.join(directory, 'xtb.exe');
  const manifestPath = path.join(root, 'runtime.json');
  const observed = contract.fileIdentity(root, 'runtime.json');
  let expectedManifest = selected?.manifestIdentity;
  if (packaged) {
    const provenance = path.resolve(resourcesPath, '../provenance'); let summaryIdentity;
    try { summaryIdentity = contract.fileIdentity(provenance, 'dependencies.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (summaryIdentity) {
      const summary = contract.readJson(provenance, summaryIdentity), anchor = summary.xtb?.runtimeManifest;
      assert(summary.schema === 'sciyue-portable-dependency-summary/v1' && anchor?.path === 'runtime.json', 'XTB_RUNTIME_INVALID: package xTB manifest anchor required');
      expectedManifest = anchor;
    }
  }
  let record = contract.validateDescriptor(contract.readJson(root, expectedManifest ?? observed));
  let members;
  if (record.schema === 'sciyue-xtb-bundled-runtime/v2') {
    // No environment override or self-declared local replacement bypasses the
    // fixed product descriptor anchor. Existing v1 remains its legacy scope.
    assert(expectedManifest, 'XTB_RUNTIME_INVALID: package xTB manifest anchor required');
    const inventory = contract.readJson(root, record.inventory, 8 * 1024 * 1024);
    assert(inventory.schema === 'sciyue-xtb-runtime-inventory/v1', 'XTB_RUNTIME_INVALID: runtime inventory schema');
    members = contract.verifyMemberInventory(root, inventory.files);
  } else {
    // Keep the previous v1 route at its existing scope, without calling its
    // observed bytes an official v2 rebuild or accepting a replacement alias.
    for (const relative of ['bin/libiomp5md.dll', 'bin/vcruntime140.dll']) contract.ordinary(root, relative);
    members = ['bin', 'share/xtb'].flatMap(directory => contract.walk(root, directory)).map(relative => contract.fileIdentity(root, relative)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  for (const relative of contract.REQUIRED) {
    const target = path.resolve(root, relative), stat = await fs.lstat(target);
    assert(within(root, target) && stat.isFile() && !stat.isSymbolicLink(), 'XTB_RUNTIME_INCOMPLETE: 缺少随包xTB运行文件');
    assert(members.some(row => row.path === relative), 'XTB_RUNTIME_INCOMPLETE: required parameter/executable absent from inventory');
  }
  return { root, directory, executable, dataDirectory, version: record.version, engineIdentity: contract.engineIdentity(record, members, observed.sha256) };
}
module.exports = { xtbRuntime };
