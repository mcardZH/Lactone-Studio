'use strict';

const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { assert } = require('./security.cjs');
const { checkDirectory, directoryIdentity } = require('./portable-storage.cjs');
const { SCHEMA, validateFrame, validateIdentity, validatePathRecord } = require('./pes-security.cjs');

const catalogName = 'pes-recovery.json';
const terminalName = 'terminal.json';
const framesName = 'frames.jsonl';
const recoverySchema = 'ester-pes-recovery/v1';
const terminalSchema = 'ester-pes-terminal/v2';
const terminalId = /^terminal-[A-Za-z0-9]+$/;
const pathDirectory = /^run-[A-Za-z0-9]+$/;
const checksum = /^[a-f0-9]{64}$/;
const number = value => Number.isSafeInteger(value) && value >= 0;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const numericNames = { hessianMatrix: 'hessian-matrix.f64', modeDisplacements: 'vibration-displacements.f64' };
const pathAssetName = /^[a-f0-9]{64}\.json$/;

async function readPesTerminalFramePage(record, { offset, limit }, io) {
  const count = record.rows?.length ?? record.frames.length;
  assert(number(offset) && offset <= count && number(limit) && limit > 0, 'Invalid PES terminal frame page');
  if (offset === count) return { frames: [], offset, total: count, done: true };
  const frames = [];
  let size = 0;
  if (record.rows) await checkDirectory(record.directory, record.identity, io);
  const handle = record.rows ? await io.open(path.join(record.directory, framesName), 'r') : null;
  try {
    if (handle) {
      const stat = await handle.stat();
      assert(stat.isFile() && stat.nlink === 1 && (record.recovery ? stat.size <= record.bytes : stat.size === record.bytes),
        'PES 终态帧文件已变化。');
    }
    for (let index = offset; index < Math.min(count, offset + Math.min(limit, 64)); index++) {
      const row = record.rows?.[index], bytes = row?.length ?? record.frames[index].positions.length * 56 + 256;
      if (frames.length && size + bytes > 8 * 1024 ** 2) break;
      try {
        if (!row) frames.push(record.frames[index]);
        else {
          const data = Buffer.allocUnsafe(row.length);
          let read = 0;
          while (read < data.length) {
            const { bytesRead } = await handle.read(data, read, data.length - read, row.offset + read);
            assert(bytesRead > 0, 'PES 终态帧文件提前结束。');
            read += bytesRead;
          }
          assert(digest(data) === row.sha256, 'PES 终态帧校验失败。');
          const frame = JSON.parse(data.toString('utf8'));
          assert(frame.id === row.id, 'PES 终态帧身份不符。');
          if (record.recovery) validateFrame(frame, record.request);
          frames.push(frame);
        }
      } catch (error) {
        if (!record.recovery || frames.length === 0) throw error;
        break;
      }
      size += bytes;
    }
  } finally { await handle?.close(); }
  return { frames, offset, total: count, done: offset + frames.length === count };
}

function createPesRecoveryStore({ root, io = require('node:fs/promises') }) {
  assert(path.isAbsolute(root), 'PES recovery needs an absolute root');
  let rootIdentity;

  async function verifyRoot() {
    rootIdentity ??= await directoryIdentity(root, io);
    await checkDirectory(root, rootIdentity, io);
  }

  async function fileStat(file) {
    const stat = await io.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'PES 恢复资产不是独立的常规文件。');
    return stat;
  }

  async function readVerified(file, sha256) {
    const before = await fileStat(file);
    const data = await io.readFile(file);
    const after = await fileStat(file);
    assert(before.ino === after.ino && before.dev === after.dev && before.size === data.length &&
      data.length === after.size && (!sha256 || digest(data) === sha256), 'PES 恢复资产校验失败。');
    return data;
  }

  async function publishJson(directory, identity, name, value) {
    const data = Buffer.from(JSON.stringify(value) + '\n');
    const temporary = path.join(directory, `.recover-${randomUUID()}.tmp`);
    const output = await io.open(temporary, 'wx');
    try {
      await output.writeFile(data);
      await output.sync();
    } finally { await output.close(); }
    await checkDirectory(directory, identity, io);
    await io.rename(temporary, path.join(directory, name));
    return digest(data);
  }

  async function copyNumeric(directory, numericFiles) {
    if (!numericFiles?.size) return;
    const names = {};
    for (const [kind, file] of numericFiles) {
      assert(Object.hasOwn(numericNames, kind) && file.name === numericNames[kind], 'Unknown PES recovery numeric file');
      const source = await fileStat(file.target);
      assert(source.dev === file.device && source.ino === file.inode && source.size === file.bytes,
        'PES 恢复数值的来源已变化。');
      const target = path.join(directory, file.name);
      await io.copyFile(file.target, target, constants.COPYFILE_EXCL);
      const input = await io.open(target, 'r+');
      try {
        const stat = await input.stat();
        assert(stat.isFile() && stat.nlink === 1 && stat.size === file.bytes, 'PES 恢复数值长度不符。');
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(file.bytes, 1024 * 1024));
        let offset = 0;
        while (offset < file.bytes) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, file.bytes - offset), offset);
          assert(bytesRead > 0, 'PES 恢复数值提前结束。');
          hash.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        assert(hash.digest('hex') === file.sha256, 'PES 恢复数值校验失败。');
        await input.sync();
      } finally { await input.close(); }
      names[kind] = { name: file.name, shape: file.shape, bytes: file.bytes, sha256: file.sha256 };
    }
    return names;
  }

  async function persist(record, request, outcome, pathAssets) {
    await verifyRoot();
    const { directory, identity, rows, numericalFiles } = record, id = path.basename(directory);
    assert(path.dirname(directory) === root && terminalId.test(id), 'Invalid PES recovery directory');
    await checkDirectory(directory, identity, io);
    const { frames: _frames, pathRecords: pathMetadata, ...metadata } = outcome.result;
    const numerics = await copyNumeric(directory, numericalFiles);
    let pathRecords;
    if (pathAssets?.files.size) {
      const name = path.basename(pathAssets.directory);
      assert(path.dirname(pathAssets.directory) === root && pathDirectory.test(name), 'Invalid PES path recovery directory');
      await checkDirectory(pathAssets.directory, pathAssets.identity, io);
      const bytes = await readVerified(path.join(pathAssets.directory, 'recovery.json'));
      pathRecords = { name, sha256: digest(bytes) };
    }
    const result = pathRecords ? metadata : { ...metadata, ...(pathMetadata ? { pathRecords: pathMetadata } : {}) };
    const runIdentity = request.runIdentity;
    const status = outcome.status;
    const terminalSha256 = await publishJson(directory, identity, terminalName, {
      schema: terminalSchema, request, status, result, error: outcome.error, rows, numerics, pathRecords,
    });
    await publishJson(directory, identity, catalogName, {
      schema: recoverySchema, id, runIdentity, operation: request.operation, method: request.method, status,
      frameCount: rows.length, pathRecordCount: pathAssets?.files.size ?? 0, finishedAt: Date.now(), terminalSha256,
    });
    return id;
  }

  async function readCatalog(id) {
    assert(typeof id === 'string' && terminalId.test(id), 'PES 恢复记录编号无效。');
    await verifyRoot();
    const directory = path.join(root, id), identity = await directoryIdentity(directory, io);
    const catalog = JSON.parse(await readVerified(path.join(directory, catalogName)));
    assert(catalog.schema === recoverySchema && catalog.id === id && catalog.status === 'completed' &&
      typeof catalog.operation === 'string' && typeof catalog.method === 'string' &&
      number(catalog.frameCount) && number(catalog.pathRecordCount) && number(catalog.finishedAt) &&
      checksum.test(catalog.terminalSha256), 'PES 恢复记录索引无效。');
    validateIdentity(catalog.runIdentity);
    await checkDirectory(directory, identity, io);
    const { schema: _schema, terminalSha256, ...summary } = catalog;
    return { summary, terminalSha256, directory, identity };
  }

  async function list() {
    let entries;
    try { await verifyRoot(); entries = await io.readdir(root); }
    catch (error) {
      if (error.code === 'ENOENT') return { recoveries: [], issues: [] };
      throw error;
    }
    const recoveries = [], issues = [];
    for (const id of entries) {
      if (!terminalId.test(id)) continue;
      try {
        const { summary } = await readCatalog(id);
        recoveries.push(summary);
      } catch (error) {
        if (error.code !== 'ENOENT') issues.push({ id, message: error.message });
      }
    }
    return { recoveries: recoveries.sort((left, right) => right.finishedAt - left.finishedAt), issues };
  }

  async function open(id) {
    const catalog = await readCatalog(id), { directory, identity, summary } = catalog;
    const data = JSON.parse(await readVerified(path.join(directory, terminalName), catalog.terminalSha256));
    const { request, status, result, rows, numerics, pathRecords } = data;
    assert(data.schema === terminalSchema && request?.schema === SCHEMA && request.id === summary.runIdentity.runId &&
      isDeepStrictEqual(request.runIdentity, summary.runIdentity) && request.operation === summary.operation &&
      request.method === summary.method && status === summary.status && Array.isArray(request.structure?.atoms) &&
      request.structure.atoms.length && Array.isArray(request.constraints?.frozenAtomIds) &&
      result && typeof result.status === 'string' && result.provenance && Array.isArray(rows) &&
      rows.length === summary.frameCount, 'PES 恢复结果与索引的来源不符。');

    let bytes = 0;
    const frameIds = new Set();
    for (const row of rows) {
      assert(typeof row.id === 'string' && row.id.startsWith(`${request.id}:`) && !frameIds.has(row.id) &&
        row.offset === bytes && number(row.length) && row.length > 0 && checksum.test(row.sha256),
        'PES 恢复帧索引无效。');
      frameIds.add(row.id);
      bytes += row.length;
      assert(number(bytes), 'PES 恢复帧文件范围无效。');
    }
    const issues = [];
    const numericalFiles = new Map();
    for (const [kind, file] of Object.entries(numerics ?? {})) {
      try {
        assert(Object.hasOwn(numericNames, kind) && numericNames[kind] === file.name && Array.isArray(file.shape) &&
          file.shape.every(number) && number(file.bytes) && file.bytes === file.shape.reduce((size, dimension) => size * dimension, 8) &&
          checksum.test(file.sha256), '索引无效。');
        const target = path.join(directory, file.name);
        assert((await fileStat(target)).size === file.bytes, '数值文件长度不符。');
        numericalFiles.set(kind, { ...file, target });
      } catch (cause) {
        issues.push({ kind, message: cause.message });
      }
    }
    let paths;
    if (pathRecords || summary.pathRecordCount > 0) {
      try {
        assert(pathRecords && pathDirectory.test(pathRecords.name) && checksum.test(pathRecords.sha256), 'PES 恢复路径索引无效。');
        const folder = path.join(root, pathRecords.name), folderIdentity = await directoryIdentity(folder, io);
        const receipt = JSON.parse(await readVerified(path.join(folder, 'recovery.json'), pathRecords.sha256));
        assert(receipt.schema === SCHEMA && isDeepStrictEqual(receipt.request, request) &&
          Array.isArray(receipt.records) && receipt.records.length === summary.pathRecordCount,
          'PES 恢复路径与计算来源不符。');
        const files = new Map();
        for (const entry of receipt.records) {
          validatePathRecord(entry.record, request);
          assert(!files.has(entry.record.id) && pathAssetName.test(entry.name) && number(entry.bytes) &&
            checksum.test(entry.sha256), 'PES 恢复路径几何索引无效。');
          files.set(entry.record.id, entry);
        }
        const latest = receipt.result?.pathRecords ?? receipt.records.map(entry => entry.record);
        assert(Array.isArray(latest) && latest.length === files.size && new Set(latest.map(entry => entry.id)).size === files.size &&
          latest.every(entry => {
            const original = files.get(entry.id)?.record;
            return original && (isDeepStrictEqual(entry, original) ||
              entry.kind === 'final' && isDeepStrictEqual(entry, { ...original, kind: 'final' }));
          }), 'PES 恢复终态的路径索引与资产不符。');
        await checkDirectory(folder, folderIdentity, io);
        paths = { directory: folder, identity: folderIdentity, files };
        result.pathRecords = latest;
      } catch (cause) {
        issues.push({ kind: 'pathRecords', message: cause.message });
      }
    }

    await checkDirectory(directory, identity, io);
    return { ...catalog, request, status, result: { ...result, frames: [] }, error: data.error,
      rows, bytes, numericalFiles, paths, issues, recovery: true };
  }

  return { persist, list, open };
}

module.exports = { createPesRecoveryStore, readPesTerminalFramePage };
