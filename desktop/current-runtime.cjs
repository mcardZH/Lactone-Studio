'use strict';
// Fixed current-project inputs. No PATH search, history lookup or acquisition.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { verifyMemberInventory } = require('./xtb-runtime-contract.cjs');

const hashes = new Map(), documents = new Map(), inventorySnapshots = new Map();
const SHA = /^[a-f0-9]{64}$/;

const PLATFORM_LAYOUTS = Object.freeze({
  'win32-x64': Object.freeze({
    platform: 'win32-x64',
    dependenciesParent: '.local/dependencies/win-x64',
    toolchainsParent: '.local/toolchains/win-x64',
    pythonEntries: Object.freeze(['python/python.exe']),
    pythonBasenames: Object.freeze(['python.exe']),
    pythonRequiredMembers: Object.freeze(['python/python312.dll', 'python/python312._pth']),
    xtbEntry: 'xtb/bin/xtb.exe',
    packagedEngineEntry: 'engine.exe'
  }),
  'darwin-arm64': Object.freeze({
    platform: 'darwin-arm64',
    dependenciesParent: '.local/dependencies/darwin-arm64',
    toolchainsParent: '.local/toolchains/darwin-arm64',
    pythonEntries: Object.freeze(['python/bin/python3', 'python/bin/python']),
    pythonBasenames: Object.freeze(['python3', 'python']),
    pythonRequiredMembers: Object.freeze(['python/lib/python3.12/os.py']),
    xtbEntry: 'xtb/bin/xtb',
    packagedEngineEntry: 'engine'
  }),
  'darwin-x64': Object.freeze({
    platform: 'darwin-x64',
    dependenciesParent: '.local/dependencies/darwin-x64',
    toolchainsParent: '.local/toolchains/darwin-x64',
    pythonEntries: Object.freeze(['python/bin/python3', 'python/bin/python']),
    pythonBasenames: Object.freeze(['python3', 'python']),
    pythonRequiredMembers: Object.freeze(['python/lib/python3.12/os.py']),
    xtbEntry: 'xtb/bin/xtb',
    packagedEngineEntry: 'engine'
  })
});

const SUPPORTED_PLATFORMS = Object.freeze(Object.keys(PLATFORM_LAYOUTS));

function resolvePlatformLayout(platformId) {
  assert(
    typeof platformId === 'string' && Object.hasOwn(PLATFORM_LAYOUTS, platformId),
    'Current runtime lock schema/platform'
  );
  return PLATFORM_LAYOUTS[platformId];
}

function defaultPlatformId(platform = process.platform, arch = process.arch) {
  const candidate = `${platform}-${arch}`;
  assert(
    Object.hasOwn(PLATFORM_LAYOUTS, candidate),
    'Current runtime lock schema/platform'
  );
  return candidate;
}

function hasUnsafePathDelimiter(filePath, platformId, hostPlatform = process.platform) {
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    filePath.includes('\0') ||
    filePath.includes(';')
  ) {
    return true;
  }
  if (platformId === 'win32-x64' || hostPlatform === 'win32') {
    const withoutDrive = filePath.replace(/^[A-Za-z]:(?=[\\/]|$)/, '');
    return withoutDrive.includes(':');
  }
  return filePath.includes(':');
}

function detectWindowsKernelSystemRoot(hostPlatform = process.platform, sharedObjects) {
  if (sharedObjects === undefined && hostPlatform !== 'win32') {
    return 'C:\\Windows';
  }
  let loaded;
  if (typeof sharedObjects === 'function') {
    try {
      loaded = sharedObjects();
    } catch {
      assert.fail('Trusted Windows SystemRoot required');
    }
  } else if (sharedObjects !== undefined) {
    loaded = sharedObjects;
  } else {
    try {
      const report =
        process.report && typeof process.report.getReport === 'function'
          ? process.report.getReport()
          : null;
      loaded = report && Array.isArray(report.sharedObjects) ? report.sharedObjects : null;
    } catch {
      assert.fail('Trusted Windows SystemRoot required');
    }
  }
  assert(Array.isArray(loaded), 'Trusted Windows SystemRoot required');
  for (const entry of loaded) {
    if (typeof entry !== 'string') continue;
    const match = entry.match(
      /^([A-Za-z]:[\\/][^\\/:*?"<>|]+)[\\/]System32[\\/](?:ntdll|kernel32)\.dll$/i
    );
    if (match) {
      const candidate = match[1].replace(/[\\/]+$/, '');
      const parts = candidate.split(/[\\/]+/);
      if (
        parts.length === 2 &&
        /^[A-Za-z]:$/.test(parts[0]) &&
        parts[1].length > 0 &&
        !/^[.]+$/.test(parts[1]) &&
        !/[<>:"/\\|?*\0;]/.test(parts[1])
      ) {
        return `${parts[0].toUpperCase()}\\${parts[1]}`;
      }
    }
  }
  assert.fail('Trusted Windows SystemRoot required');
}

function normalizeWindowsSystemRootCandidate(raw) {
  assert(
    typeof raw === 'string' && !hasUnsafePathDelimiter(raw, 'win32-x64', 'win32'),
    'Trusted Windows SystemRoot required'
  );
  const cleaned = raw.trim().replace(/[\\/]+$/, '');
  const segments = cleaned.split(/[\\/]+/);
  assert(
    segments.length === 2 &&
      /^[A-Za-z]:$/.test(segments[0]) &&
      segments[1].length > 0 &&
      !/^[.]+$/.test(segments[1]) &&
      !/[<>:"/\\|?*\0;]/.test(segments[1]),
    'Trusted Windows SystemRoot required'
  );
  const normalized = path.win32.normalize(`${segments[0].toUpperCase()}\\${segments[1]}`);
  assert(
    /^[A-Za-z]:\\[^\\/:*?"<>|\0;]+$/i.test(normalized) &&
      normalized.toLowerCase() === cleaned.replace(/\//g, '\\').toLowerCase(),
    'Trusted Windows SystemRoot required'
  );
  return normalized;
}

function resolveTrustedWindowsSystemRoot(
  environment = {},
  hostPlatform = process.platform,
  sharedObjects
) {
  const osSystemRoot = normalizeWindowsSystemRootCandidate(
    detectWindowsKernelSystemRoot(hostPlatform, sharedObjects)
  );
  for (const key of Object.keys(environment)) {
    if (/^(?:SYSTEMROOT|WINDIR)$/i.test(key) && environment[key] !== undefined) {
      const candidate = normalizeWindowsSystemRootCandidate(environment[key]);
      assert(
        candidate.toLowerCase() === osSystemRoot.toLowerCase(),
        'Trusted Windows SystemRoot required'
      );
    }
  }
  if (hostPlatform === 'win32') {
    let rootStat, sys32Stat, kernelStat;
    try {
      rootStat = fs.lstatSync(osSystemRoot);
      sys32Stat = fs.lstatSync(`${osSystemRoot}\\System32`);
      kernelStat = fs.lstatSync(`${osSystemRoot}\\System32\\kernel32.dll`);
    } catch {
      assert.fail('Trusted Windows SystemRoot required');
    }
    assert(
      rootStat.isDirectory() &&
        !rootStat.isSymbolicLink() &&
        sys32Stat.isDirectory() &&
        !sys32Stat.isSymbolicLink() &&
        kernelStat.isFile() &&
        !kernelStat.isSymbolicLink(),
      'Trusted Windows SystemRoot required'
    );
  }
  return osSystemRoot;
}

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

function stamp(s) {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs ?? s.mtimeMs}:${s.ctimeNs ?? s.ctimeMs}`;
}

function digestFromStat(target, stat) {
  const key = stamp(stat);
  const old = hashes.get(target);
  if (old?.stamp === key) return old.sha256;
  const fd = fs.openSync(target, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    assert.equal(stamp(fs.fstatSync(fd, { bigint: true })), key, 'Runtime changed before read');
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length));
    }
    assert.equal(stamp(fs.fstatSync(fd, { bigint: true })), key, 'Runtime changed during read');
    const sha256 = hash.digest('hex');
    if (hashes.size >= 65536) {
      const oldestKey = hashes.keys().next().value;
      if (oldestKey !== undefined) hashes.delete(oldestKey);
    }
    hashes.set(target, { stamp: key, sha256 });
    return sha256;
  } finally {
    fs.closeSync(fd);
  }
}

function identity(root, relative) {
  const { target } = admitted(root, relative);
  const stat = fs.lstatSync(target, { bigint: true });
  const sha256 = digestFromStat(target, stat);
  return { path: relative, bytes: Number(stat.size), sha256 };
}

function json(root, relative, maximum = 8 * 1024 * 1024) {
  const { target } = admitted(root, relative);
  const stat = fs.lstatSync(target, { bigint: true });
  const key = stamp(stat);
  assert(stat.size > 0n && Number(stat.size) <= maximum, 'Current runtime metadata size');
  const old = documents.get(target);
  if (old?.stamp === key) return old.value;
  const bytes = fs.readFileSync(target);
  assert.equal(stamp(fs.lstatSync(target, { bigint: true })), key, 'Runtime metadata changed during read');
  const value = JSON.parse(bytes.toString('utf8'));
  if (documents.size >= 32) documents.clear();
  documents.set(target, { stamp: key, value });
  return value;
}

function reference(root, row) {
  assert(row && Object.keys(row).sort().join(',') === 'bytes,path,sha256' && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && SHA.test(row.sha256), 'Exact current runtime reference required');
  const { target } = admitted(root, row.path);
  const stat = fs.lstatSync(target, { bigint: true });
  assert.equal(Number(stat.size), row.bytes, 'Current runtime identity differs: ' + row.path);
  const sha256 = digestFromStat(target, stat);
  assert.equal(sha256, row.sha256, 'Current runtime identity differs: ' + row.path);
  return target;
}

function requireContentDirs(value) {
  assert(
    Array.isArray(value?.contentDirectories) &&
      value.contentDirectories.length > 0 &&
      value.contentDirectories.every(dir => typeof dir === 'string' && dir.trim().length > 0),
    'Explicit current runtime contentDirectories required'
  );
  return value.contentDirectories;
}

function isDirectoryCoveredByContent(relDir, contentDirs) {
  const clean = relDir.replace(/\/+$/, '');
  return contentDirs.some(
    dir => typeof dir === 'string' && (clean === dir || clean.startsWith(dir + '/'))
  );
}

function lock(root, relative, schema, parent, expectedPlatform) {
  const value = json(root, relative, 1024 * 1024);
  const layout = resolvePlatformLayout(value.platform);
  assert(
    value.schema === schema && (!expectedPlatform || value.platform === expectedPlatform),
    'Current runtime lock schema/platform'
  );
  const expectedParent = parent || layout.dependenciesParent;
  assert(typeof value.root === 'string' && value.root.startsWith(expectedParent + '/') && value.root.split('/').length === expectedParent.split('/').length + 1, 'Content-specific current runtime root required');
  assert(
    !hasUnsafePathDelimiter(path.join(root, value.root), value.platform),
    'Current runtime path contains unsafe delimiter'
  );
  admitted(root, value.root, true);
  requireContentDirs(value);
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
  return { value, files, layout, reference: identity(root, relative) };
}

function lockedFile(root, selected, relative) {
  const row = selected.files.find(row => row.path === relative);
  assert(row, 'Required current runtime member absent: ' + relative);
  reference(root, { path: selected.value.root + '/' + relative, bytes: row.bytes, sha256: row.sha256 });
  return path.join(root, selected.value.root, relative);
}

function walkContent(root, relative, foundMap = new Map(), dirList = []) {
  const dirPath = path.join(root, relative);
  const dirStat = fs.lstatSync(dirPath, { bigint: true });
  assert(!dirStat.isSymbolicLink(), 'Linked current runtime input');
  assert(dirStat.isDirectory(), 'Current runtime requires an ordinary owned input');
  const entries = fs.readdirSync(dirPath).sort();
  dirList.push({
    path: dirPath,
    dev: dirStat.dev,
    ino: dirStat.ino,
    mtimeNs: dirStat.mtimeNs ?? dirStat.mtimeMs,
    ctimeNs: dirStat.ctimeNs ?? dirStat.ctimeMs,
    entryCount: entries.length
  });
  for (const name of entries) {
    const member = relative + '/' + name;
    const fullPath = path.join(root, member);
    const stat = fs.lstatSync(fullPath, { bigint: true });
    assert(!stat.isSymbolicLink(), 'Linked current runtime input');
    if (stat.isDirectory()) {
      walkContent(root, member, foundMap, dirList);
    } else {
      assert(stat.isFile() && stat.nlink === 1n, 'Current runtime requires an ordinary owned input');
      foundMap.set(member, { target: fullPath, stat });
    }
  }
  return { foundMap, dirList };
}

function checkInventorySnapshot(snapshot) {
  for (let i = 0; i < snapshot.dirs.length; i += 1) {
    const d = snapshot.dirs[i];
    let st;
    try {
      st = fs.lstatSync(d.path, { bigint: true });
    } catch {
      return false;
    }
    if (
      st.isSymbolicLink() ||
      !st.isDirectory() ||
      st.dev !== d.dev ||
      st.ino !== d.ino ||
      (st.mtimeNs ?? st.mtimeMs) !== d.mtimeNs ||
      (st.ctimeNs ?? st.ctimeMs) !== d.ctimeNs
    ) {
      return false;
    }
    try {
      if (fs.readdirSync(d.path).length !== d.entryCount) return false;
    } catch {
      return false;
    }
  }
  for (let i = 0; i < snapshot.files.length; i += 1) {
    const f = snapshot.files[i];
    let st;
    try {
      st = fs.lstatSync(f.target, { bigint: true });
    } catch {
      return false;
    }
    if (
      st.isSymbolicLink() ||
      !st.isFile() ||
      st.nlink !== 1n ||
      st.dev !== f.dev ||
      st.ino !== f.ino ||
      st.size !== f.size ||
      (st.mtimeNs ?? st.mtimeMs) !== f.mtimeNs ||
      (st.ctimeNs ?? st.ctimeMs) !== f.ctimeNs
    ) {
      return false;
    }
  }
  return true;
}

function verifyNativeInventory(appPath, selected) {
  const contentDirs = requireContentDirs(selected.value);
  admitted(appPath, selected.value.root, true);
  const memberRoot = path.join(appPath, selected.value.root);
  for (const dir of contentDirs) {
    admitted(memberRoot, dir, true);
  }
  const snapshotKey = `${path.resolve(memberRoot)}::${selected.reference?.sha256 || ''}::${contentDirs.join(',')}`;
  const existingSnapshot = inventorySnapshots.get(snapshotKey);
  if (existingSnapshot && checkInventorySnapshot(existingSnapshot)) {
    return;
  }

  const actualMap = new Map();
  const dirList = [];
  for (const dir of contentDirs) {
    walkContent(memberRoot, dir, actualMap, dirList);
  }
  const fileSnapshots = [];
  const nextFileMap = new Map();
  const prevFileMap = existingSnapshot?.fileMap;
  for (const row of selected.files) {
    assert(
      typeof row?.path === 'string' && contentDirs.some(dir => row.path.startsWith(dir + '/')),
      'Current runtime member outside declared content: ' + row?.path
    );
    const relPath = selected.value.root + '/' + row.path;
    const rowKeys = row ? Object.keys(row).sort().join(',') : '';
    assert(
      row &&
        (rowKeys === 'bytes,path,sha256' ||
          (rowKeys === 'bytes,owner,path,sha256' && typeof row.owner === 'string' && row.owner.length > 0)) &&
        Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0 &&
        SHA.test(row.sha256),
      'Exact current runtime reference required'
    );
    const found = actualMap.get(row.path);
    if (!found) {
      reference(appPath, { path: relPath, bytes: row.bytes, sha256: row.sha256 });
    } else {
      assert.equal(Number(found.stat.size), row.bytes, 'Current runtime identity differs: ' + relPath);
      const mtimeNs = found.stat.mtimeNs ?? found.stat.mtimeMs;
      const ctimeNs = found.stat.ctimeNs ?? found.stat.ctimeMs;
      const prev = prevFileMap?.get(row.path);
      const actualSha256 =
        prev &&
        prev.target === found.target &&
        prev.dev === found.stat.dev &&
        prev.ino === found.stat.ino &&
        prev.size === found.stat.size &&
        prev.mtimeNs === mtimeNs &&
        prev.ctimeNs === ctimeNs
          ? prev.sha256
          : digestFromStat(found.target, found.stat);
      assert.equal(actualSha256, row.sha256, 'Current runtime identity differs: ' + relPath);
      const snapEntry = {
        target: found.target,
        dev: found.stat.dev,
        ino: found.stat.ino,
        size: found.stat.size,
        mtimeNs,
        ctimeNs,
        sha256: actualSha256
      };
      fileSnapshots.push(snapEntry);
      nextFileMap.set(row.path, snapEntry);
    }
  }
  const actual = [...actualMap.keys()].sort();
  const declared = selected.files.map(row => row.path).sort();
  assert.deepEqual(actual, declared, 'Current runtime complete file membership differs');
  if (inventorySnapshots.size >= 32) {
    const oldestSnapKey = inventorySnapshots.keys().next().value;
    if (oldestSnapKey !== undefined) inventorySnapshots.delete(oldestSnapKey);
  }
  inventorySnapshots.set(snapshotKey, { dirs: dirList, files: fileSnapshots, fileMap: nextFileMap });
}

function hasCandidateEntry(fullPath) {
  try {
    fs.lstatSync(fullPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function resolveProfile(appPath, expectedPlatform) {
  admitted(appPath, 'desktop/packaging', true);
  const defaultRel = 'desktop/packaging/native-profile.json';
  const platformRel = `desktop/packaging/native-profile.${expectedPlatform}.json`;
  if (hasCandidateEntry(path.join(appPath, platformRel))) {
    return { profile: json(appPath, platformRel, 65536), profileRel: platformRel };
  }
  return { profile: json(appPath, defaultRel, 65536), profileRel: defaultRel };
}

function validLockPathFor(kind, expectedPlatform, actualPath) {
  return (
    actualPath === `desktop/packaging/${kind}.lock.json` ||
    actualPath === `desktop/packaging/${kind}.${expectedPlatform}.lock.json`
  );
}

function verifyPreparedLocks(appPath, expectedPlatform, layout) {
  assert(
    !hasUnsafePathDelimiter(path.resolve(appPath), expectedPlatform),
    'Current runtime path contains unsafe delimiter'
  );
  const { profile } = resolveProfile(appPath, expectedPlatform);
  assert(
    profile &&
      profile.schema === 'sciyue-native-profile-v1' &&
      profile.platform === expectedPlatform &&
      validLockPathFor('native-runtime', expectedPlatform, profile.runtimeLock) &&
      validLockPathFor('native-toolchain', expectedPlatform, profile.toolchainLock) &&
      validLockPathFor('xtb-runtime', expectedPlatform, profile.xtbLock),
    'Fixed current native profile required'
  );
  const runtime = lock(
    appPath,
    profile.runtimeLock,
    'sciyue-native-runtime-lock-v1',
    layout.dependenciesParent,
    expectedPlatform
  );
  const toolchain = lock(
    appPath,
    profile.toolchainLock,
    'sciyue-native-toolchain-lock-v1',
    layout.toolchainsParent,
    expectedPlatform
  );
  const xtb = lock(
    appPath,
    profile.xtbLock,
    'sciyue-xtb-lock-v1',
    layout.dependenciesParent,
    expectedPlatform
  );
  reference(appPath, profile.preparation);
  const prepared = json(appPath, profile.preparation.path);
  assert(
    prepared.schema === 'sciyue-native-preparation-v1' &&
      prepared.passed === true &&
      prepared.scienceExecuted === false,
    'Prepared current runtime required'
  );
  assert.deepEqual(prepared.runtimeLock, runtime.reference);
  assert.deepEqual(prepared.toolchainLock, toolchain.reference);
  assert.deepEqual(prepared.xtbLock, xtb.reference);
  reference(appPath, prepared.importProbe);
  const probeDoc = json(appPath, prepared.importProbe.path, 1024 * 1024);
  assert(
    probeDoc &&
      (probeDoc.schema === 'sciyue-import-probe-v1' ||
        probeDoc.schema === 'sciyue-native-import-probe-v1') &&
      probeDoc.passed === true &&
      probeDoc.scienceExecuted === false &&
      (expectedPlatform === 'win32-x64'
        ? probeDoc.platform === undefined || probeDoc.platform === 'win32-x64'
        : probeDoc.platform === expectedPlatform),
    'Prepared current import probe required'
  );
  assert.deepEqual(
    probeDoc.runtimeLock,
    runtime.reference,
    'Prepared current import probe runtimeLock mismatch'
  );
  assert.deepEqual(
    probeDoc.toolchainLock,
    toolchain.reference,
    'Prepared current import probe toolchainLock mismatch'
  );
  assert.deepEqual(
    probeDoc.xtbLock,
    xtb.reference,
    'Prepared current import probe xtbLock mismatch'
  );
  const probedSet = new Set([
    ...(Array.isArray(probeDoc.modules) ? probeDoc.modules : []),
    ...(probeDoc.packagePaths && typeof probeDoc.packagePaths === 'object'
      ? Object.keys(probeDoc.packagePaths)
      : [])
  ]);
  for (const reqMod of ['rdkit', 'ase', 'spglib', 'scipy']) {
    assert(
      probedSet.has(reqMod),
      'Prepared current import probe missing required module: ' + reqMod
    );
  }
  assert(
    probedSet.has('tblite') || probedSet.has('tblite.library'),
    'Prepared current import probe missing required module: tblite'
  );
  return { profile, runtime, toolchain, xtb, prepared, probeDoc };
}

function developmentNative(appPath, options = {}) {
  const expectedPlatform = options.platformId || defaultPlatformId(options.platform, options.arch);
  const layout = resolvePlatformLayout(expectedPlatform);
  admitted(appPath, 'scripts/native/dev-runtime.py');
  admitted(appPath, 'desktop/chemistry/engine.py');
  const { profile, runtime, toolchain } = verifyPreparedLocks(appPath, expectedPlatform, layout);
  assert(layout.pythonEntries.includes(toolchain.value.python), 'Fixed standalone Python entry required');
  const runtimeContentDirs = requireContentDirs(runtime.value);
  const toolchainContentDirs = requireContentDirs(toolchain.value);
  const requiredRuntimeDirs =
    layout.platform === 'win32-x64'
      ? ['python/Library/bin', 'python/Lib/site-packages']
      : ['python/bin', 'python/lib'];
  for (const reqDir of requiredRuntimeDirs) {
    assert(
      isDirectoryCoveredByContent(reqDir, runtimeContentDirs),
      'Current runtime search directory outside declared content: ' + reqDir
    );
  }
  const requiredToolchainDirs =
    layout.platform === 'win32-x64'
      ? [path.posix.dirname(toolchain.value.python), 'python/DLLs']
      : [path.posix.dirname(toolchain.value.python), 'python/lib'];
  for (const reqDir of requiredToolchainDirs) {
    assert(
      isDirectoryCoveredByContent(reqDir, toolchainContentDirs),
      'Current toolchain search directory outside declared content: ' + reqDir
    );
  }
  verifyNativeInventory(appPath, runtime);
  verifyNativeInventory(appPath, toolchain);
  const executable = lockedFile(appPath, toolchain, toolchain.value.python);
  for (const name of layout.pythonRequiredMembers) lockedFile(appPath, toolchain, name);
  return {
    executable,
    platform: layout.platform,
    runtimeRoot: path.join(appPath, runtime.value.root),
    provenance: {
      source: 'prepared-current-locks',
      locked: true,
      platform: layout.platform,
      runtimeLock: runtime.reference,
      toolchainLock: toolchain.reference,
      preparation: profile.preparation
    }
  };
}

function developmentXtb(appPath, options = {}) {
  const expectedPlatform = options.platformId || defaultPlatformId(options.platform, options.arch);
  const layout = resolvePlatformLayout(expectedPlatform);
  assert(
    !hasUnsafePathDelimiter(path.resolve(appPath), expectedPlatform),
    'Current runtime path contains unsafe delimiter'
  );
  const { profile } = resolveProfile(appPath, expectedPlatform);
  assert(
    profile &&
      profile.schema === 'sciyue-native-profile-v1' &&
      profile.platform === expectedPlatform &&
      validLockPathFor('native-runtime', expectedPlatform, profile.runtimeLock) &&
      validLockPathFor('native-toolchain', expectedPlatform, profile.toolchainLock) &&
      validLockPathFor('xtb-runtime', expectedPlatform, profile.xtbLock),
    'Fixed current native profile required'
  );
  const selected =
    profile.preparation !== undefined
      ? verifyPreparedLocks(appPath, expectedPlatform, layout).xtb
      : lock(
          appPath,
          profile.xtbLock,
          'sciyue-xtb-lock-v1',
          layout.dependenciesParent,
          expectedPlatform
        );
  assert.equal(selected.value.localUseReady, true, 'Current xTB lock must be explicitly ready');
  assert(selected.value.entry === layout.xtbEntry && selected.value.dataDirectory === 'xtb/share/xtb', 'Fixed current xTB entry required');
  const xtbContentDirs = requireContentDirs(selected.value);
  assert(
    isDirectoryCoveredByContent(path.posix.dirname(selected.value.entry), xtbContentDirs) &&
      isDirectoryCoveredByContent(selected.value.dataDirectory, xtbContentDirs),
    'Current xTB directory outside declared content'
  );
  const xtbRootAbs = path.join(appPath, selected.value.root, 'xtb');
  const xtbEntryAbs = path.join(appPath, selected.value.root, selected.value.entry);
  const xtbDataAbs = path.join(appPath, selected.value.root, selected.value.dataDirectory);
  assert(
    !hasUnsafePathDelimiter(xtbRootAbs, expectedPlatform) &&
      !hasUnsafePathDelimiter(xtbEntryAbs, expectedPlatform) &&
      !hasUnsafePathDelimiter(xtbDataAbs, expectedPlatform),
    'Current runtime path contains unsafe delimiter'
  );
  for (const name of [layout.xtbEntry, 'xtb/runtime.json', 'xtb/share/xtb/param_gfn0-xtb.txt', 'xtb/share/xtb/param_gfn1-xtb.txt', 'xtb/share/xtb/param_gfn2-xtb.txt', 'xtb/share/xtb/.param_gfnff.xtb']) {
    assert(selected.files.some(row => row.path === name), 'Required current runtime member absent: ' + name);
  }
  verifyMemberInventory(path.join(appPath, selected.value.root), selected.files, xtbContentDirs);
  const descriptor = selected.files.find(row => row.path === 'xtb/runtime.json');
  return { root: xtbRootAbs, lock: selected.reference, manifestIdentity: { ...descriptor, path: 'runtime.json' } };
}

function currentRuntimeEnvironment({
  packaged,
  appPath,
  executable,
  environment = process.env,
  platform = process.platform,
  arch = process.arch,
  platformId,
  sharedObjects
}) {
  if (packaged || environment.SCIYUE_PYTHON) return {};
  if (typeof executable !== 'string') return {};
  let expectedPlatform;
  try {
    expectedPlatform = platformId || defaultPlatformId(platform, arch);
  } catch {
    return {};
  }
  const matchedLayout = resolvePlatformLayout(expectedPlatform);
  if (
    !inside(path.join(appPath, matchedLayout.toolchainsParent), executable) ||
    !matchedLayout.pythonBasenames.includes(path.basename(executable).toLowerCase())
  ) {
    return {};
  }
  assert(
    !hasUnsafePathDelimiter(path.resolve(appPath), expectedPlatform) &&
      !hasUnsafePathDelimiter(path.resolve(executable), expectedPlatform),
    'Current runtime path contains unsafe delimiter'
  );
  const { profile } = resolveProfile(appPath, expectedPlatform);
  assert(
    profile &&
      profile.schema === 'sciyue-native-profile-v1' &&
      profile.platform === expectedPlatform &&
      validLockPathFor('native-runtime', expectedPlatform, profile.runtimeLock) &&
      validLockPathFor('native-toolchain', expectedPlatform, profile.toolchainLock) &&
      validLockPathFor('xtb-runtime', expectedPlatform, profile.xtbLock),
    'Fixed current native profile required'
  );
  const declared = json(appPath, profile.toolchainLock, 1024 * 1024);
  assert(
    declared.schema === 'sciyue-native-toolchain-lock-v1' &&
      declared.platform === expectedPlatform &&
      matchedLayout.pythonEntries.includes(declared.python) &&
      declared.root.startsWith(matchedLayout.toolchainsParent + '/'),
    'Fixed current Python declaration required'
  );
  const expected = path.resolve(appPath, declared.root, declared.python);
  const normalize = value => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(executable) !== normalize(expected)) return {};
  developmentNative(appPath, { platform, arch, platformId: expectedPlatform });
  const runtime = json(appPath, profile.runtimeLock, 1024 * 1024);
  const envDelimiter = matchedLayout.platform === 'win32-x64' ? ';' : ':';
  let runtimePathEntries;
  let windowsSystemRoot = null;
  if (matchedLayout.platform === 'win32-x64') {
    windowsSystemRoot = resolveTrustedWindowsSystemRoot(environment, platform, sharedObjects);
    const winBinAbs = path.join(appPath, runtime.root, 'python/Library/bin');
    if (hasCandidateEntry(winBinAbs)) {
      admitted(path.join(appPath, runtime.root), 'python/Library/bin', true);
    }
    assert(
      !hasUnsafePathDelimiter(winBinAbs, expectedPlatform) &&
        !hasUnsafePathDelimiter(path.dirname(expected), expectedPlatform),
      'Current runtime path contains unsafe delimiter'
    );
    runtimePathEntries = [
      winBinAbs,
      path.dirname(expected),
      `${windowsSystemRoot}\\System32`,
      windowsSystemRoot
    ];
  } else {
    const posixBinAbs = path.join(appPath, runtime.root, 'python/bin');
    if (hasCandidateEntry(posixBinAbs)) {
      admitted(path.join(appPath, runtime.root), 'python/bin', true);
    }
    assert(
      !hasUnsafePathDelimiter(posixBinAbs, expectedPlatform) &&
        !hasUnsafePathDelimiter(path.dirname(expected), expectedPlatform),
      'Current runtime path contains unsafe delimiter'
    );
    runtimePathEntries = [
      posixBinAbs,
      path.dirname(expected),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    ];
  }
  const result = {};
  for (const name of Object.keys(environment)) {
    if (
      /^(?:CONDA_|_CONDA_|VIRTUAL_ENV$|PYTHON|_PYTHON_|_CE_CONDA$|_CE_M$|DYLD_|LD_|RDBASE$)/i.test(
        name
      )
    ) {
      result[name] = undefined;
    } else if (windowsSystemRoot !== null && /^(?:SYSTEMROOT|WINDIR)$/i.test(name)) {
      result[name] = windowsSystemRoot;
    }
  }
  if (windowsSystemRoot !== null) {
    result.SystemRoot = windowsSystemRoot;
    result.WINDIR = windowsSystemRoot;
  }
  result.PATH = runtimePathEntries.join(envDelimiter);
  result.SCIYUE_APP_PATH = path.resolve(appPath);
  result.PYTHONNOUSERSITE = '1';
  result.PYTHONDONTWRITEBYTECODE = '1';
  if (matchedLayout.platform.startsWith('darwin-')) {
    const depLibAbs = path.join(appPath, runtime.root, 'python/lib');
    const tcLibAbs = path.join(appPath, declared.root, 'python/lib');
    if (hasCandidateEntry(depLibAbs)) {
      admitted(path.join(appPath, runtime.root), 'python/lib', true);
    }
    if (hasCandidateEntry(tcLibAbs)) {
      admitted(path.join(appPath, declared.root), 'python/lib', true);
    }
    assert(
      !hasUnsafePathDelimiter(depLibAbs, expectedPlatform) &&
        !hasUnsafePathDelimiter(tcLibAbs, expectedPlatform),
      'Current runtime path contains unsafe delimiter'
    );
    result.DYLD_FALLBACK_LIBRARY_PATH = [depLibAbs, tcLibAbs, '/usr/lib'].join(envDelimiter);
  }
  return result;
}

function packagedBackendInfo({ packaged, resourcesPath, provenanceRoot, platform = process.platform }) {
  if (!packaged) return { name: 'unknown', verified: false, source: 'development-or-test' };
  try {
    assert(typeof provenanceRoot === 'string', 'Package provenance root required');
    assert(path.resolve(provenanceRoot) === path.resolve(resourcesPath, '../provenance'), 'Package provenance must belong to these resources');
    admitted(path.dirname(resourcesPath), 'provenance', true);
    const summary = json(provenanceRoot, 'dependencies.json', 1024 * 1024), native = summary.native;
    assert(summary.schema === 'sciyue-portable-dependency-summary/v1' && native.backend === 'OpenBLAS', 'Explicit current backend required');
    const expectedEntry = platform === 'win32' ? 'engine.exe' : 'engine';
    assert(
      native.entry.path === expectedEntry &&
        SHA.test(native.origin.candidateReceiptSha256) &&
        SHA.test(native.origin.buildContractSha256),
      'Current native origin required'
    );
    reference(resourcesPath, { ...native.entry, path: 'chemistry/' + native.entry.path });
    return { name: 'openblas', verified: true, source: 'package-provenance-not-live-DLL-observation' };
  } catch { return { name: 'unknown', verified: false, source: 'missing-or-invalid-package-provenance' }; }
}

module.exports = {
  PLATFORM_LAYOUTS,
  SUPPORTED_PLATFORMS,
  defaultPlatformId,
  resolvePlatformLayout,
  resolveProfile,
  hasUnsafePathDelimiter,
  resolveTrustedWindowsSystemRoot,
  developmentNative,
  developmentXtb,
  currentRuntimeEnvironment,
  packagedBackendInfo
};
