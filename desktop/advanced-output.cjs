'use strict';
const nativeFS = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { plain } = require('./security.cjs');
const { failure, hash, identity, directoryIdentity, checkDirectory, readChecked } = require('./portable-storage.cjs');

const ADVANCED_OUTPUT_LIMITS = Object.freeze({ tokenLifetimeMs: 120000 });
const requireValue = (condition, code, message) => { if (!condition) throw failure(code, message); };
function basename(name, maximum = 240) {
  requireValue(typeof name === 'string' && name.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)
    && !name.endsWith('.') && !name.includes('..') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
  'ADVANCED_OUTPUT_NAME', '输出名称须为安全ASCII单文件名，不能含路径、数据流或Windows保留名称。');
}
function snapshotRequest(request) {
  const direct = plain(request) && request.mode === 'existing-directory';
  requireValue(plain(request) && (direct ? Object.keys(request).every(key => ['mode','files','reservedNames'].includes(key)) : Object.keys(request).length === 2 && Object.keys(request).every(key => ['directoryName', 'files'].includes(key))),
    'ADVANCED_OUTPUT_REQUEST', '文本包请求须包含明确的新目录名称和完整文件清单。');
  if(!direct)basename(request.directoryName, 100);
  requireValue(Array.isArray(request.files) && request.files.length > 0,
    'ADVANCED_OUTPUT_REQUEST', '文本包必须包含完整文件清单。');
  let totalBytes = 0; const names = new Set();
  const files = request.files.map(file => {
    requireValue(plain(file) && Object.keys(file).length === 2 && Object.keys(file).every(key => ['name', 'text'].includes(key)),
      'ADVANCED_OUTPUT_REQUEST', '文本包成员只接受名称和完整文本。');
    basename(file.name);
    requireValue(!names.has(file.name.toLowerCase()), 'ADVANCED_OUTPUT_NAME', '文本包文件名称重复，大小写不同也不能覆盖。');
    names.add(file.name.toLowerCase());
    requireValue(typeof file.text === 'string', 'ADVANCED_OUTPUT_TEXT', '文本包只接受完整文本。');
    totalBytes += Buffer.byteLength(file.text, 'utf8');
    requireValue(Number.isSafeInteger(totalBytes), 'ADVANCED_OUTPUT_SIZE', '文本包字节数无法安全表示。');
    requireValue(!file.text.includes('\0'), 'ADVANCED_OUTPUT_TEXT', '文本包不能包含二进制内容或NUL。');
    const bytes = Buffer.from(file.text, 'utf8');
    requireValue(bytes.toString('utf8') === file.text, 'ADVANCED_OUTPUT_TEXT', '文本包含不完整Unicode字符，不能静默改写UTF-8内容。');
    return Object.freeze({ name: file.name, text: file.text, bytes: bytes.length, sha256: hash(bytes) });
  });
  // The validated immutable strings are already the snapshot. Serializing the
  // entire request again duplicates all texts and adds no identity protection.
  const reservedNames = [];
  if(direct && request.reservedNames !== undefined){
    requireValue(Array.isArray(request.reservedNames),'ADVANCED_OUTPUT_REQUEST','运行文件名清单无效。');
    const reserved = new Set();
    for(const name of request.reservedNames){basename(name);requireValue(!names.has(name.toLowerCase())&&!reserved.has(name.toLowerCase()),'ADVANCED_OUTPUT_NAME','运行文件名与本批输入或其他运行文件重名。');reserved.add(name.toLowerCase());reservedNames.push(name);}
  }
  const manifest = Object.freeze({ schema: 'sciyue-advanced-output', version: 1,
    files: Object.freeze(files.map(({ name, bytes, sha256 }) => Object.freeze({ name, bytes, sha256 }))), totalBytes });
  return { ...(direct?{mode:'existing-directory',reservedNames:Object.freeze(reservedNames)}:{directoryName:request.directoryName}), files: Object.freeze(files), manifest };
}

/** Owner-bound, sealed text packages. Selection never creates a directory, and
 * write consumes only the host snapshot; renderer text cannot change it later. */
function createAdvancedOutputStore({ chooseDestination, assertDestination, ownerAlive, fs = nativeFS, now = Date.now }) {
  requireValue(typeof chooseDestination === 'function' && typeof assertDestination === 'function' && typeof ownerAlive === 'function',
    'ADVANCED_OUTPUT_CONFIGURATION', 'Advanced output host policy is required.');
  const tokens = new Map(), reservations = new Set(), closedOwners = new Set(); let disposed = false;
  function active(owner) {
    requireValue(!disposed && !closedOwners.has(owner) && Number.isSafeInteger(owner) && owner >= 0,
      'ADVANCED_OUTPUT_OWNER', '文本包所属窗口已关闭。');
    requireValue(ownerAlive(owner) !== false, 'ADVANCED_OUTPUT_OWNER', '文本包所属窗口已关闭。');
  }
  function release(record) { reservations.delete(record); }
  function prune() {
    for (const [token, record] of tokens) if (record.expiresAt < now()) { tokens.delete(token); release(record); }
  }
  function reserve(owner, snapshot) {
    prune();
    const record = { owner, ...snapshot }; reservations.add(record); return record;
  }
  function policy(owner, directory, files = []) {
    active(owner); assertDestination(directory);
    for (const file of files) assertDestination(path.join(directory, file.name));
  }
  async function missing(directory) {
    try { await fs.lstat(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw failure('ADVANCED_OUTPUT_EXISTS', '目标目录已存在，必须另选一个全新的目录，未覆盖任何文件。');
  }
  async function noCollisions(record) {
    const existing = new Set((await fs.readdir(record.directory)).map(name=>name.toLowerCase()));
    const conflicts = [...record.files.map(file=>file.name),...(record.reservedNames??[])].filter(name=>existing.has(name.toLowerCase()));
    requireValue(!conflicts.length,'ADVANCED_OUTPUT_EXISTS',`目标目录已存在同名文件：${conflicts.join('、')}。未覆盖或自动改名，请调整任务名或目录。`);
  }
  async function choose(owner, request) {
    active(owner);
    const record = reserve(owner, snapshotRequest(request)); let retained = false;
    try {
      const selected = await chooseDestination(owner, { ...(record.mode?{mode:record.mode}:{directoryName: record.directoryName}),
        files: record.manifest.files, totalBytes: record.manifest.totalBytes }); active(owner);
      if (selected === null || selected === undefined) return { status: 'cancelled' };
      requireValue(typeof selected === 'string' && path.isAbsolute(selected) && !selected.includes('\0'),
        'ADVANCED_OUTPUT_DESTINATION', '请选择明确的全新目录位置。');
      const directory = path.resolve(selected); if(!record.mode)basename(path.basename(directory), 100); policy(owner, directory, record.files);
      const parent = await directoryIdentity(path.dirname(directory), fs);
      let selectedIdentity;
      if(record.mode){selectedIdentity=await directoryIdentity(directory,fs);await noCollisions({...record,directory});}
      else await missing(directory);
      await checkDirectory(path.dirname(directory), parent, fs); active(owner); policy(owner, directory, record.files);
      const token = randomUUID(), expiresAt = now() + ADVANCED_OUTPUT_LIMITS.tokenLifetimeMs;
      Object.assign(record, { directory, parent, expiresAt, ...(selectedIdentity?{directoryIdentity:selectedIdentity}:{}) }); tokens.set(token, record); retained = true;
      return { status: 'selected', token, directory, manifest: record.manifest, expiresAt };
    } finally { if (!retained) release(record); }
  }
  async function write(owner, token) {
    active(owner);
    requireValue(typeof token === 'string' && /^[a-f0-9-]{36}$/i.test(token), 'ADVANCED_OUTPUT_TOKEN', '文本包保存确认无效。');
    const record = tokens.get(token);
    requireValue(record && record.owner === owner, 'ADVANCED_OUTPUT_TOKEN', '文本包确认已消费、过期或属于另一窗口。');
    // Consume synchronously before the first await: concurrent/repeated writes
    // cannot dispatch the same snapshot twice, including after a failed write.
    tokens.delete(token);
    const diagnostic = { directory: record.directory, directoryCreated: false, written: [], tokenConsumed: true };
    const verifyDirectory = async () => {
      policy(owner, record.directory);
      await checkDirectory(path.dirname(record.directory), record.parent, fs);
      if (record.directoryIdentity) await checkDirectory(record.directory, record.directoryIdentity, fs);
      active(owner);
    };
    const verifyFile = async (file, ownedIdentity) => {
      await verifyDirectory();
      const location = path.join(record.directory, file.name); assertDestination(location);
      const saved = await readChecked(location, Number.MAX_SAFE_INTEGER, fs);
      const stat = await fs.lstat(location);
      requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && (!ownedIdentity || `${stat.dev}:${stat.ino}` === ownedIdentity)
        && identity(stat) === saved.identity
        && saved.bytes.length === file.bytes && saved.sha256 === file.sha256 && saved.bytes.equals(Buffer.from(file.text, 'utf8')),
      'PORTABLE_PATH_CHANGED', '文本包成员身份或写入字节已变化，未报告保存成功。');
      await verifyDirectory(); return `${stat.dev}:${stat.ino}`;
    };
    try {
      requireValue(record.expiresAt >= now(), 'ADVANCED_OUTPUT_TOKEN', '文本包保存确认已过期，请重新确认完整清单。');
      policy(owner, record.directory, record.files);
      await verifyDirectory(); if(record.mode)await noCollisions(record);else await missing(record.directory); await verifyDirectory();
      // No recursive mkdir and no rename: existing targets always win.
      if(!record.mode){await fs.mkdir(record.directory); diagnostic.directoryCreated = true;
        record.directoryIdentity = await directoryIdentity(record.directory, fs);} await verifyDirectory();
      const identities = new Map();
      for (const file of record.files) {
        await verifyDirectory();
        const location = path.join(record.directory, file.name); assertDestination(location);
        const handle = await fs.open(location, 'wx');
        diagnostic.partialFile = { name: file.name }; let ownedIdentity;
        try {
          const opened = await handle.stat(); ownedIdentity = `${opened.dev}:${opened.ino}`;
          requireValue(opened.isFile() && opened.nlink === 1, 'PORTABLE_PATH_CHANGED', '新文本包文件不是独立普通文件。');
          await verifyDirectory(); await handle.writeFile(Buffer.from(file.text, 'utf8')); await handle.sync();
          diagnostic.partialFile.bytes = (await handle.stat()).size;
        } catch (error) {
          try { diagnostic.partialFile.bytes = (await handle.stat()).size; } catch { /* Preserve the original write failure. */ }
          throw error;
        } finally { await handle.close(); }
        identities.set(file.name, await verifyFile(file, ownedIdentity));
        diagnostic.written.push({ name: file.name, bytes: file.bytes, sha256: file.sha256 }); delete diagnostic.partialFile;
      }
      // Recheck earlier files too: a later write must not conceal replacement,
      // byte edits, hardlinks, or unlisted additions to the new directory.
      await verifyDirectory();
      const members = record.mode?null:await fs.readdir(record.directory);
      requireValue(!members || members.length === record.files.length && members.every(name => record.files.some(file => file.name === name)),
        'PORTABLE_PATH_CHANGED', '新文本包目录出现清单外成员，未报告保存成功。');
      for (const file of record.files) await verifyFile(file, identities.get(file.name));
      await verifyDirectory(); return { status: 'saved', directory: record.directory, manifest: record.manifest };
    } catch (cause) {
      const error = cause instanceof Error ? cause : failure('ADVANCED_OUTPUT_FAILED', String(cause));
      error.advancedOutput = diagnostic; throw error;
    } finally { release(record); }
  }
  function abandon(owner, token) {
    active(owner);
    requireValue(typeof token === 'string' && /^[a-f0-9-]{36}$/i.test(token), 'ADVANCED_OUTPUT_TOKEN', '文本包保存确认无效。');
    const record = tokens.get(token);
    if (!record) return { released: false };
    requireValue(record.owner === owner, 'ADVANCED_OUTPUT_TOKEN', '文本包确认属于另一窗口。');
    // Only unconsumed selections are in tokens. A write removes its token before
    // awaiting I/O, so abandoning never releases or changes an in-flight write.
    tokens.delete(token); release(record);
    return { released: record.expiresAt >= now() };
  }
  function closeOwner(owner) {
    closedOwners.add(owner);
    for (const [token, record] of tokens) if (record.owner === owner) { tokens.delete(token); release(record); }
  }
  function dispose() {
    disposed = true; for (const record of tokens.values()) release(record); tokens.clear();
  }
  return { choose, write, abandon, closeOwner, dispose };
}
module.exports = { createAdvancedOutputStore, ADVANCED_OUTPUT_LIMITS };
