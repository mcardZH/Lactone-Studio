'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { assert, string } = require('./security.cjs');
const { directoryIdentity, checkDirectory } = require('./portable-storage.cjs');
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const MAX_RANGE_BYTES = 64 * 1024 ** 2;
const MAX_SOURCE_BYTES = Number.MAX_SAFE_INTEGER;
const MAX_COMPANION_BYTES = Number.MAX_SAFE_INTEGER;
const COMPANION_MEMORY_FACTOR = 12;
const COPY_CHUNK_BYTES = 1024 ** 2;

/** Host-issued read capabilities. Paths never come from a renderer request. */
function createLaunchSources() {
  const sources = new Map();
  const generations = new Map();
  const opening = new Map();
  let disposed = false;
  async function close(owner, token) {
    const source = sources.get(token);
    if (!source) return { closed: false };
    assert(source.owner === owner, 'LAUNCH_SOURCE_OWNER: 来源不属于本窗口。');
    sources.delete(token); source.closed = true;
    await Promise.allSettled([...source.reads]);
    await source.handle.close();
    return { closed: true };
  }
  async function verify(source) {
    const [opened, selected] = await Promise.all([source.handle.stat(), fs.lstat(source.path)]);
    assert(!source.closed && selected.isFile() && !selected.isSymbolicLink() && identity(opened) === source.identity && identity(selected) === source.identity,
      'FILE_CHANGED: 选中文件已改变，请重新载入。');
  }
  async function open(owner, paths, options = {}) {
    assert(!disposed, '应用正在关闭。');
    const generation = generations.get(owner) || 0;
    assert(Array.isArray(paths) && paths.length > 0, '请选择来源文件。');
    assert(options.names === undefined || Array.isArray(options.names) && options.names.length === paths.length && options.names.every(name => string(name, 256) && !/[\\/\0]/.test(name) && name !== '.' && name !== '..'), 'Invalid host source names');
    assert(options.companions === undefined || Array.isArray(options.companions) && options.companions.length === paths.length && options.companions.every((rows,index) => Array.isArray(rows) && rows.length<=2 && new Set(rows.map(row=>row.kind)).size===rows.length && rows.every(row=>['json','cis'].includes(row.kind) && path.isAbsolute(row.path) && path.dirname(row.path)===path.dirname(paths[index]) && string(row.name,256) && !/[\\/\0]/.test(row.name) && /^[a-f0-9]{64}$/.test(row.sha256))), 'Invalid fixed source companions');
    opening.set(owner, (opening.get(owner) || 0) + paths.length);
    const opened = [];
    try {
      for (const [index, location] of paths.entries()) {
        assert(string(location, 32768), '启动文件路径无效。');
        const handle = await fs.open(location, 'r'); let retained = false;
        try {
          const [stat, selected] = await Promise.all([handle.stat(), fs.lstat(location)]);
          assert(stat.isFile() && selected.isFile() && !selected.isSymbolicLink() && identity(stat) === identity(selected), '启动来源必须为未变化的普通文件。');
          const name = options.names?.[index] ?? path.basename(location);
          assert(!disposed && (generations.get(owner) || 0) === generation, '启动来源所属窗口已关闭。');
          // Scientific format limits are enforced by the shared readers after
          // content recognition. A renamed OUT must not become a 20 MiB input.
          assert(Number.isSafeInteger(stat.size) && stat.size >= 0, '来源文件大小无法安全表示：' + name);
          const token = randomUUID();
          sources.set(token, { owner, path: location, name, companions:options.companions?.[index].map(row=>({...row})), handle, identity: identity(stat), size: stat.size, reads: new Set(), closed: false });
          retained = true; opened.push({ token, name, size: stat.size });
        } finally { if (!retained) await handle.close(); }
      }
      return opened;
    } catch (error) { await Promise.all(opened.map(source => close(owner, source.token))); throw error; }
    finally { const remaining = (opening.get(owner) || 0) - paths.length; if (remaining) opening.set(owner, remaining); else opening.delete(owner); }
  }
  async function read(owner, token, start, end) {
    assert(string(token, 100), '启动来源token无效。');
    const source = sources.get(token);
    assert(source && source.owner === owner && !source.closed, 'LAUNCH_SOURCE_UNAVAILABLE: 来源已关闭或不属于本窗口。');
    assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end <= source.size && end - start <= MAX_RANGE_BYTES,
      '启动来源读取范围无效或过大。');
    assert(source.reads.size < 8, 'LAUNCH_SOURCE_BUSY: 并发读取过多。');
    const operation = (async () => {
      await verify(source);
      const buffer = Buffer.alloc(end - start);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await source.handle.read(buffer, offset, buffer.length - offset, start + offset);
        assert(bytesRead > 0, 'FILE_CHANGED: 文件在读取时截断。'); offset += bytesRead;
      }
      await verify(source);
      return new Uint8Array(buffer);
    })();
    source.reads.add(operation);
    try { return await operation; }
    finally { source.reads.delete(operation); }
  }
  function owned(owner, token) {
    assert(string(token, 100), '输出来源token无效。');
    const source = sources.get(token);
    assert(source && source.owner === owner && !source.closed && !disposed, 'LAUNCH_SOURCE_UNAVAILABLE: 输出来源已关闭或不属于本窗口。');
    return source;
  }
  async function describe(owner, token) {
    const source = owned(owner, token);
    const operation = (async () => {
      await verify(source);
      if (!source.revision) {
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES); let offset = 0;
        while (offset < source.size) {
          const length = Math.min(buffer.length, source.size - offset), { bytesRead } = await source.handle.read(buffer, 0, length, offset);
          assert(bytesRead === length, 'FILE_CHANGED: 来源在核对时截断。'); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        await verify(source); source.revision = hash.digest('hex');
      }
      return { name: source.name, size: source.size, revision: source.revision };
    })();
    source.reads.add(operation);
    try { return await operation; } finally { source.reads.delete(operation); }
  }
  /** A host-only immutable copy. The destination is chosen by the consuming
   * host, never supplied by a renderer. Closing the source waits for this IO. */
  async function snapshotSource(owner, token, options) {
    const source = owned(owner, token);
    assert(options && typeof options.directory === 'string' && path.isAbsolute(options.directory), 'Invalid managed source directory');
    const checkCancelled = () => options.signal?.throwIfAborted();
    const operation = (async () => {
      checkCancelled();
      await verify(source);
      checkCancelled();
      const parent = await directoryIdentity(options.directory);
      checkCancelled();
      const name = source.name;
      assert((options.name === undefined || options.name === name) && (options.bytes === undefined || options.bytes === source.size), 'SOURCE_IDENTITY: 来源名称或大小不匹配。');
      const destination = path.join(options.directory, `source-${randomUUID()}${path.extname(name)}`);
      const output = await fs.open(destination, 'wx'); let created, complete = false;
      try {
        created = await output.stat();
        checkCancelled();
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES); let offset = 0;
        while (offset < source.size) {
          checkCancelled();
          const length = Math.min(buffer.length, source.size - offset);
          const { bytesRead } = await source.handle.read(buffer, 0, length, offset);
          checkCancelled();
          assert(bytesRead === length, 'FILE_CHANGED: 来源在复制时截断。');
          let written = 0;
          while (written < length) { checkCancelled(); const receipt = await output.write(buffer, written, length - written, offset + written); checkCancelled(); assert(receipt.bytesWritten > 0, 'SOURCE_WRITE_FAILED: 来源写入没有进展。'); written += receipt.bytesWritten; }
          hash.update(buffer.subarray(0, length)); offset += length;
        }
        const revision = hash.digest('hex');
        assert(options.revision === undefined || options.revision === revision, 'SOURCE_IDENTITY: 来源内容修订不匹配。');
        checkCancelled(); await output.sync(); checkCancelled(); await verify(source); checkCancelled(); await checkDirectory(options.directory, parent); checkCancelled();
        const current = await fs.lstat(destination), saved = await output.stat();
        assert(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && identity(current) === identity(saved) && current.dev === created.dev && current.ino === created.ino && saved.size === source.size, 'SOURCE_IDENTITY: 受管副本已变化。');
        checkCancelled(); source.revision = revision; complete = true;
        return { path: destination, name, revision, bytes: source.size };
      } finally {
        await output.close();
        if (!complete && created) {
          await checkDirectory(options.directory, parent);
          const stat = await fs.lstat(destination);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === created.dev && stat.ino === created.ino) await fs.unlink(destination);
        }
      }
    })();
    source.reads.add(operation);
    try { return await operation; } finally { source.reads.delete(operation); }
  }
  async function verifyCompanionSource(owner, token, expected) {
    const source = owned(owner, token);
    assert(expected && /^[a-f0-9]{64}$/.test(expected.revision) && source.name === expected.name && source.revision === expected.revision && source.size === expected.bytes, 'COMPANION_SOURCE_IDENTITY: 原始OUT内容或名称不匹配。');
    await verify(source);
    if (source.companionParent) await checkDirectory(path.dirname(source.path), source.companionParent);
  }
  /** Only the exact siblings of an already selected, still-live OUT capability
   * are accessible. No renderer path, directory scan or whole-JSON IPC exists. */
  async function snapshotCompanions(owner, token, options) {
    const source = owned(owner, token);
    assert(options && string(options.name, 256) && /^[a-f0-9]{64}$/.test(options.revision) && source.name === options.name && Number.isSafeInteger(options.bytes) && options.bytes === source.size && path.isAbsolute(options.directory) && Number.isSafeInteger(options.memoryBudgetBytes) && options.memoryBudgetBytes > 0, 'Invalid companion snapshot request');
    assert(source.reads.size < 8, 'LAUNCH_SOURCE_BUSY: 输出来源正在读取。');
    const operation = (async () => {
      await verify(source);
      const sourceParent = await directoryIdentity(path.dirname(source.path)), destinationParent = await directoryIdentity(options.directory);
      const sourceStat = await source.handle.stat(); assert(sourceStat.nlink === 1, 'COMPANION_SOURCE_LINK: 不读取链接输出来源的伴随文件。');
      if (!source.revision) {
        const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, source.size)); let offset = 0;
        while (offset < source.size) {
          const length = Math.min(buffer.length, source.size - offset), { bytesRead } = await source.handle.read(buffer, 0, length, offset);
          assert(bytesRead === length, 'FILE_CHANGED: 原始OUT在核对时截断。'); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        await verify(source); source.revision = hash.digest('hex');
      }
      assert(source.revision === options.revision, 'COMPANION_SOURCE_IDENTITY: 原始OUT的SHA与当前分析不符。');
      source.companionParent = sourceParent;
      const allowance = Math.floor(options.memoryBudgetBytes / COMPANION_MEMORY_FACTOR);
      const parsed = path.parse(source.path), candidates = [], created = []; let total = 0;
      try {
        for (const kind of ['json', 'cis']) {
          const fixed=source.companions?.find(row=>row.kind===kind);if(source.companions&&!fixed)continue;
          const location = fixed?.path??path.join(parsed.dir, parsed.name + '.' + kind); let selected;
          try { selected = await fs.lstat(location); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          assert(selected.isFile() && !selected.isSymbolicLink() && selected.nlink === 1, 'COMPANION_SOURCE_LINK: 伴随文件必须是非链接普通文件。');
          total += selected.size;
          assert(Number.isSafeInteger(total) && total <= allowance, 'COMPANION_MEMORY_BUDGET: JSON/CIS原始总量超过当前可用内存解析预算。');
          candidates.push({ kind, location, selected,name:fixed?.name??path.basename(location),sha256:fixed?.sha256 });
        }
        const result = {};
        for (const candidate of candidates) {
          await checkDirectory(parsed.dir, sourceParent); await checkDirectory(options.directory, destinationParent); await verify(source);
          const input = await fs.open(candidate.location, 'r'); let output;
          try {
            assert(identity(await input.stat()) === identity(candidate.selected), 'FILE_CHANGED: 伴随文件在打开前改变。');
            const location = path.join(options.directory, 'source-orca.' + candidate.kind);
            output = await fs.open(location, 'wx'); const ownedStat = await output.stat(); created.push({ location, stat: ownedStat });
            const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, candidate.selected.size)); let offset = 0;
            while (offset < candidate.selected.size) {
              const length = Math.min(buffer.length, candidate.selected.size - offset), { bytesRead } = await input.read(buffer, 0, length, offset);
              assert(bytesRead === length, 'FILE_CHANGED: 伴随文件在复制时截断。');
              let written = 0; while (written < bytesRead) { const count = (await output.write(buffer, written, bytesRead - written, offset + written)).bytesWritten; assert(count > 0, 'Companion snapshot write stalled'); written += count; }
              hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; await verify(source);
            }
            await output.sync();
            const [opened, selected, saved] = await Promise.all([input.stat(), fs.lstat(candidate.location), fs.lstat(location)]);
            assert(selected.isFile() && !selected.isSymbolicLink() && selected.nlink === 1 && identity(opened) === identity(candidate.selected) && identity(selected) === identity(candidate.selected), 'FILE_CHANGED: 伴随文件在复制中改变。');
            assert(saved.isFile() && !saved.isSymbolicLink() && saved.nlink === 1 && saved.dev === ownedStat.dev && saved.ino === ownedStat.ino && saved.size === candidate.selected.size, 'Companion snapshot identity changed');
            await checkDirectory(parsed.dir, sourceParent); await checkDirectory(options.directory, destinationParent); await verify(source);
            const revision=hash.digest('hex');assert(!candidate.sha256||revision===candidate.sha256,'COMPANION_SOURCE_IDENTITY: 固定配套文件的SHA与快照不符。');
            result[candidate.kind === 'json' ? 'orcaJson' : 'orcaCis'] = { name: candidate.name, path: location, revision, bytes: offset };
          } finally { await input.close(); await output?.close(); }
        }
        for (const candidate of candidates) {
          const current = await fs.lstat(candidate.location);
          assert(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && identity(current) === identity(candidate.selected), 'FILE_CHANGED: 伴随来源集合在复制中改变。');
        }
        await verifyCompanionSource(owner, token, options); return result;
      } catch (error) {
        for (const item of created) {
          await checkDirectory(options.directory, destinationParent); const stat = await fs.lstat(item.location);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.dev === item.stat.dev && stat.ino === item.stat.ino) await fs.unlink(item.location);
        }
        throw error;
      }
    })();
    source.reads.add(operation);
    try { return await operation; } finally { source.reads.delete(operation); }
  }
  async function disposeOwner(owner) { generations.set(owner, (generations.get(owner) || 0) + 1); await Promise.all([...sources].filter(([, source]) => source.owner === owner).map(([token]) => close(owner, token))); }
  async function dispose() { disposed = true; for (const source of sources.values()) generations.set(source.owner, (generations.get(source.owner) || 0) + 1); await Promise.all([...sources].map(([token, source]) => close(source.owner, token))); }
  return { open, read, close, describe, snapshotSource, snapshotCompanions, verifyCompanionSource, disposeOwner, dispose, activeCount: () => sources.size };
}
module.exports = { createLaunchSources, MAX_RANGE_BYTES, MAX_SOURCE_BYTES, MAX_COMPANION_BYTES, COMPANION_MEMORY_FACTOR };
