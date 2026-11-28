'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual:same } = require('node:util');
const { assert, plain } = require('./security.cjs');
const { validateFrame } = require('./conformer-sampling-security.cjs');
const {
  captureScope, checkedDirectory, contentHash, createRecoveryAccess, fileIdentity, ordinaryFile, readRecord, recoveryIds, writeRecord,
} = require('./conformer-recovery-store.cjs');

const idPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const frameName = index => 'frames-' + String(index).padStart(6, '0') + '.json';
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n');
const pageSize = 64;
const transferTarget = 8 * 1024 ** 2;
const packedGeometry = 'float64-le-base64-v1';
const bytesPerTriple = 3 * Float64Array.BYTES_PER_ELEMENT;

function atomMetadata(request) {
  const atoms = request?.structure?.atoms;
  return Array.isArray(atoms) ? atoms.map(({ x, y, z, ...metadata }) => {
    const fields = Object.entries(metadata);
    return { metadata, fields, simple: fields.length === 2 && Object.hasOwn(metadata, 'id') && Object.hasOwn(metadata, 'element') };
  }) : undefined;
}

function packFrame(frame, topology) {
  // For small frames the existing JSON is already inexpensive. This only
  // selects an encoding; any size and all valid atom fields are retained.
  if (!topology || topology.length < 64 || !Array.isArray(frame.coordinates) || frame.coordinates.length !== topology.length) return frame;
  const velocities = frame.velocitiesAngstromPerFs;
  if (velocities !== null && (!Array.isArray(velocities) || velocities.length !== topology.length)) return frame;
  const coordinatesBytes = topology.length * bytesPerTriple;
  const bytes = Buffer.allocUnsafe(coordinatesBytes * (velocities === null ? 1 : 2));
  for (const [i, atom] of frame.coordinates.entries()) {
    const { fields } = topology[i];
    if (!atom || Object.keys(atom).length !== fields.length + 3 || fields.some(([key, value]) => !Object.hasOwn(atom, key) || !same(atom[key], value))) return frame;
    const { x, y, z } = atom;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return frame;
    const offset = i * bytesPerTriple;
    bytes.writeDoubleLE(x, offset);
    bytes.writeDoubleLE(y, offset + 8);
    bytes.writeDoubleLE(z, offset + 16);
    if (velocities !== null) {
      const velocity = velocities[i];
      if (!Array.isArray(velocity) || velocity.length !== 3 || !Number.isFinite(velocity[0]) || !Number.isFinite(velocity[1]) || !Number.isFinite(velocity[2])) return frame;
      bytes.writeDoubleLE(velocity[0], coordinatesBytes + offset);
      bytes.writeDoubleLE(velocity[1], coordinatesBytes + offset + 8);
      bytes.writeDoubleLE(velocity[2], coordinatesBytes + offset + 16);
    }
  }
  const { coordinates, velocitiesAngstromPerFs, ...metadata } = frame;
  return [metadata, bytes.toString('base64')];
}

function unpackFrame(frame, topology, encoding) {
  if (!Array.isArray(frame)) return frame;
  assert(encoding === packedGeometry && topology && frame.length === 2 && plain(frame[0]) && typeof frame[1] === 'string', 'Invalid packed sampling geometry');
  const [metadata, encoded] = frame, coordinatesBytes = topology.length * bytesPerTriple;
  assert(encoded.length === Math.ceil(coordinatesBytes / 3) * 4 || encoded.length === Math.ceil(2 * coordinatesBytes / 3) * 4,
    'Packed sampling geometry length differs');
  const bytes = Buffer.from(encoded, 'base64');
  assert(bytes.length === coordinatesBytes || bytes.length === 2 * coordinatesBytes, 'Packed sampling geometry dimensions differ');
  const coordinates = new Array(topology.length), velocities = bytes.length === coordinatesBytes ? null : new Array(topology.length);
  for (const [i, { metadata, simple }] of topology.entries()) {
    const offset = i * bytesPerTriple;
    const x = bytes.readDoubleLE(offset), y = bytes.readDoubleLE(offset + 8), z = bytes.readDoubleLE(offset + 16);
    coordinates[i] = simple ? { id: metadata.id, element: metadata.element, x, y, z } : { ...metadata, x, y, z };
    if (velocities) velocities[i] = [bytes.readDoubleLE(coordinatesBytes + offset), bytes.readDoubleLE(coordinatesBytes + offset + 8), bytes.readDoubleLE(coordinatesBytes + offset + 16)];
  }
  return { ...metadata, coordinates, velocitiesAngstromPerFs: velocities };
}

/** This store owns one immutable copy of canonical frames, plus a small
 * publication index. Renderer delivery and an explicit discard are separate. */
function createConformerSamplingStore({ fs, root }) {
  const entries = new Map();
  assert(path.isAbsolute(root), 'Absolute private sampling result root required');

  function directoryFor(id) {
    assert(typeof id === 'string' && idPattern.test(id), 'Invalid sampling recovery identity');
    return path.join(root, id);
  }

  function recoveryIdentity(request) {
    return request?.runIdentity && { ...request.runIdentity, ...(request.segment ? { segmentId: request.segment.id } : {}) };
  }

  async function publish(entry, next) {
    entry.manifestIdentity = await writeRecord(fs, entry.directory, 'manifest.json', jsonBytes(next), entry.manifestIdentity);
    entry.manifest = next;
  }

  async function create(owner, metadata = {}) {
    const { request, expectedCount, scope: rawScope } = metadata;
    const scope = captureScope(rawScope);
    await fs.mkdir(root, { recursive: true });
    await checkedDirectory(fs, root);
    const id = randomUUID(), directory = directoryFor(id), createdAt = new Date().toISOString();
    await fs.mkdir(directory);
    await writeRecord(fs, directory, '.retain-recovery.json', jsonBytes({ schema: 1, owner, id, kind: 'sampling-results' }));
    const requestBytes = request ? jsonBytes(request) : undefined;
    let requestRef;
    if (requestBytes) {
      await writeRecord(fs, directory, 'request.json', requestBytes);
      requestRef = { bytes: requestBytes.length, sha256: contentHash(requestBytes) };
    }
    const entry = { id, owner, directory, request, topology: atomMetadata(request), count: 0, pending: [], pendingBias: [], pendingTransferBytes: 0, tail: Promise.resolve(), committed: false, reads: new Set() };
    await publish(entry, { schema: 2, id, owner, createdAt, updatedAt: createdAt, frameCount: 0, shards: [], state: 'recording',
      ...(requestRef ? { requestRef, source: request.stamp, identity: recoveryIdentity(request) } : {}),
      ...(Number.isSafeInteger(expectedCount) ? { expectedCount } : {}), ...(scope ? { scope } : {}) });
    entries.set(id, entry);
    return entry;
  }

  async function flush(entry) {
    if (!entry.pending.length && !entry.pendingBias.length) return;
    const name = frameName(entry.manifest.shards.length), offset = entry.manifest.frameCount;
    const frames = '[' + entry.pending.join(',') + ']', count = entry.pending.length, biasCount = entry.pendingBias.length;
    const bytes = Buffer.from((biasCount ? '{"frames":' + frames + ',"biasHistory":[' + entry.pendingBias.join(',') + ']}' : frames) + '\n');
    await writeRecord(fs, entry.directory, name, bytes);
    await publish(entry, { ...entry.manifest, frameCount: offset + count, updatedAt: new Date().toISOString(),
      ...(biasCount ? { biasCount: (entry.manifest.biasCount ?? 0) + biasCount } : {}),
      shards: [...entry.manifest.shards, { name, offset, count, bytes: bytes.length, sha256: contentHash(bytes),
        ...(entry.pendingPacked ? { geometryEncoding: packedGeometry, transferBytes: entry.pendingTransferBytes } : {}),
        ...(biasCount ? { biasCount } : {}) }] });
    entry.pending = [];
    entry.pendingBias = [];
    entry.pendingTransferBytes = 0;
    entry.pendingPacked = false;
  }

  function append(entry, frame) {
    assert(!entry.committed && entries.get(entry.id) === entry, 'Sampling result is already sealed');
    entry.tail = entry.tail.then(async () => {
      const stored = packFrame(frame, entry.topology), text = JSON.stringify(stored);
      const bytes = Buffer.byteLength(text);
      // Disk compression must not implicitly increase the JS/IPC working set.
      // Account for decoded floating-point values and per-atom object fields.
      const transferBytes = stored === frame ? bytes : bytes * 3;
      // A large singleton is admitted intact. Packet sizes control in-flight
      // copies only; every frame and its scientific fields remain available.
      if (entry.pendingTransferBytes && entry.pendingTransferBytes + transferBytes > transferTarget) await flush(entry);
      entry.pending.push(text);
      if (stored !== frame) entry.pendingPacked = true;
      entry.pendingTransferBytes += transferBytes + 1;
      entry.count++;
      if (entry.pending.length === pageSize || entry.pendingTransferBytes >= transferTarget) await flush(entry);
    });
    return entry.tail;
  }

  function appendBias(entry, history) {
    assert(!entry.committed && entries.get(entry.id) === entry && entry.request?.operation === 'metadynamics', 'Sampling bias is not owned by this producer');
    entry.tail = entry.tail.then(async () => {
      const text = JSON.stringify(history), bytes = Buffer.byteLength(text);
      if (entry.pendingTransferBytes && entry.pendingTransferBytes + bytes > transferTarget) await flush(entry);
      assert(history.index === (entry.manifest.biasCount ?? 0) + entry.pendingBias.length, 'Sampling recovery bias sequence changed');
      entry.pendingBias.push(text);
      entry.pendingTransferBytes += bytes + 1;
      if (entry.pendingTransferBytes >= transferTarget) await flush(entry);
    });
    return entry.tail;
  }

  async function commit(entry, metadata) {
    await entry.tail;
    await flush(entry);
    if (entry.request && metadata.request && entry.request !== metadata.request) assert(same(entry.request, metadata.request), 'Sampling result source changed during producer finalization');
    const terminal = entry.manifest.biasCount && metadata.terminal ? { ...metadata.terminal, biasHistory: undefined } : metadata.terminal;
    await publish(entry, { ...entry.manifest, ...(!entry.manifest.requestRef && metadata.request ? { request: metadata.request } : {}),
      terminal, state: 'sealed', updatedAt: new Date().toISOString() });
    entry.committed = true;
    return { id: entry.id, frameCount: entry.count };
  }

  function owned(owner, id) {
    const entry = entries.get(id);
    assert(entry, 'Unknown sampling result');
    assert(entry.owner === owner && entry.committed, 'Sampling result owner/commit mismatch');
    return entry;
  }

  async function readShard(directory, shard) {
    const record = await readRecord(fs, path.join(directory, shard.name));
    if (shard.sha256 !== undefined) assert(record.sha256 === shard.sha256 && record.bytes === shard.bytes, 'Sampling result shard digest changed');
    const frames = shard.biasCount ? record.value?.frames : record.value, bias = shard.biasCount ? record.value?.biasHistory : [];
    assert(Array.isArray(frames) && frames.length === shard.count && Array.isArray(bias) && bias.length === (shard.biasCount ?? 0), 'Sampling result shard counts changed');
    assert(shard.geometryEncoding === undefined || shard.geometryEncoding === packedGeometry, 'Unknown sampling geometry encoding');
    assert(shard.transferBytes === undefined || Number.isSafeInteger(shard.transferBytes) && shard.transferBytes >= shard.bytes, 'Invalid sampling transfer size');
    return { ...record, value: frames, bias };
  }

  async function framesFrom(directory, shards, topology, offset, limit) {
    if (!limit) return [];
    await checkedDirectory(fs, directory);
    const frames = [], end = offset + limit;
    let bytes = 0;
    for (const shard of shards) {
      if (shard.offset >= end) break;
      if (shard.offset + shard.count <= offset) continue;
      const expectedTransfer = shard.transferBytes ?? shard.bytes;
      if (frames.length && expectedTransfer !== undefined && bytes + expectedTransfer > transferTarget) break;
      const record = await readShard(directory, shard);
      const first = Math.max(0, offset - shard.offset), last = Math.min(shard.count, end - shard.offset);
      for (let i = first; i < last; i++) frames.push(unpackFrame(record.value[i], topology, shard.geometryEncoding));
      bytes += expectedTransfer ?? record.bytes;
    }
    return frames;
  }

  async function read(owner, id, offset, limit = pageSize) {
    const entry = owned(owner, id);
    assert(!entry.closing, 'Sampling result owner is closing');
    assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= entry.count && Number.isSafeInteger(limit) && limit >= 1 && limit <= pageSize, 'Invalid sampling result page');
    const pending = framesFrom(entry.directory, entry.manifest.shards, entry.topology, offset, Math.min(limit, entry.count - offset)).then(frames => {
      assert(offset === entry.count || frames.length > 0, 'Incomplete sampling result page');
      return { frames, offset, total: entry.count, done: offset + frames.length === entry.count };
    });
    entry.reads.add(pending);
    void pending.then(() => entry.reads.delete(pending), () => entry.reads.delete(pending));
    return pending;
  }

  function detach(entry) {
    return entry.closeTask ??= (async () => {
      entry.closing = true;
      await Promise.allSettled([entry.tail, ...entry.reads]);
      entry.pending = [];
      entry.pendingBias = [];
      if (entries.get(entry.id) === entry) entries.delete(entry.id);
      return { released: true, recoveryRetained: true };
    })();
  }

  async function release(owner, id) {
    const entry = owned(owner, id);
    assert(!entry.closing, 'Sampling result owner is closing');
    return detach(entry);
  }

  async function recoveryManifest(id) {
    await checkedDirectory(fs, root);
    const directory = directoryFor(id), directoryId = await checkedDirectory(fs, directory);
    const marker = await readRecord(fs, path.join(directory, '.retain-recovery.json'));
    const headline = await readRecord(fs, path.join(directory, 'manifest.json')), manifest = headline.value;
    assert(marker.value.schema === 1 && marker.value.id === id && marker.value.owner === manifest.owner && marker.value.kind === 'sampling-results', 'Sampling recovery marker differs from its manifest');
    assert([1, 2].includes(manifest.schema) && manifest.id === id && Number.isSafeInteger(manifest.frameCount) && manifest.frameCount >= 0
      && Array.isArray(manifest.shards) && (manifest.schema === 1 || ['recording', 'sealed'].includes(manifest.state)), 'Invalid sampling recovery manifest');
    return { directory, directoryId, marker, headline, manifest };
  }

  async function summarizeRecovery(id) {
    const { manifest } = await recoveryManifest(id);
    const source = manifest.source ?? manifest.request?.stamp, identity = manifest.identity ?? recoveryIdentity(manifest.request);
    if (!plain(source) || !plain(identity)) return { id, recoverableCount: 0, issues: [{ message: 'Sampling manifest does not identify its source' }] };
    const terminal = manifest.terminal, scope = captureScope(manifest.scope);
    const completeIndex = manifest.schema === 1 || manifest.state === 'sealed';
    const phase = completeIndex && terminal?.kind === 'completed' ? 'completed'
      : completeIndex && terminal?.kind === 'stopped' ? 'stopped' : 'partial';
    const bytes = manifest.shards.every(shard => Number.isSafeInteger(shard.bytes) && shard.bytes > 0)
      ? manifest.shards.reduce((total, shard) => total + shard.bytes, 0) : undefined;
    return { id, kind: 'sampling', identity, source, phase, recoverableCount: manifest.frameCount,
      expectedCount: manifest.expectedCount ?? manifest.frameCount, verification: 'manifest-only',
      ...(Number.isSafeInteger(bytes) ? { bytesLength: bytes } : {}), ...(scope ? { scope } : {}),
      ...(manifest.createdAt ? { createdAt: manifest.createdAt } : {}), ...(manifest.updatedAt ? { updatedAt: manifest.updatedAt } : {}) };
  }

  async function loadRecovery(id) {
    const { directory, directoryId, marker, headline, manifest } = await recoveryManifest(id);
    const requestRecord = manifest.requestRef ? await readRecord(fs, path.join(directory, 'request.json')) : undefined;
    if (requestRecord) assert(requestRecord.sha256 === manifest.requestRef.sha256 && requestRecord.bytes === manifest.requestRef.bytes, 'Sampling recovery request digest changed');
    const request = requestRecord?.value ?? manifest.request;
    assert(plain(request?.stamp) && typeof request.stamp.documentId === 'string' && Number.isSafeInteger(request.stamp.revision)
      && plain(request.runIdentity) && typeof request.runIdentity.taskId === 'string' && typeof request.runIdentity.runId === 'string'
      && typeof request.operation === 'string' && typeof request.method === 'string' && Array.isArray(request.structure?.atoms) && request.structure.atoms.length > 0, 'Sampling recovery source identity is missing');
    const topology = atomMetadata(request);
    const shards = [], issues = [], summaries = [];
    const legacyBias = manifest.biasCount === undefined ? manifest.terminal?.biasHistory : undefined;
    const retainedBias = Array.isArray(legacyBias) ? [...legacyBias] : [];
    assert(retainedBias.every((entry, index) => plain(entry) && entry.index === index), 'Invalid retained sampling bias sequence');
    let recoverableCount = 0, originalSession;
    let visibleBiasCount = 0;
    for (const [index, shard] of manifest.shards.entries()) {
      try {
        assert(shard.name === frameName(index) && shard.offset === recoverableCount && Number.isSafeInteger(shard.count) && shard.count >= 0
          && (shard.count > 0 || Number.isSafeInteger(shard.biasCount) && shard.biasCount > 0)
          && recoverableCount + shard.count <= manifest.frameCount
          && (manifest.schema === 1 || Number.isSafeInteger(shard.bytes) && shard.bytes > 0 && /^[a-f0-9]{64}$/.test(shard.sha256)), 'Invalid sampling recovery shard identity');
        const record = await readShard(directory, shard);
        assert(record.bias.every((entry, ordinal) => plain(entry) && entry.index === retainedBias.length + ordinal), 'Sampling recovery bias identity changed');
        const validatedSummaries = [];
        let lastBiasCount = visibleBiasCount;
        for (let ordinal = 0; ordinal < record.value.length; ordinal++) {
          const frame = unpackFrame(record.value[ordinal], topology, shard.geometryEncoding);
          originalSession ??= frame.sessionId;
          assert(frame.event === 'frame' && frame.schema === 1 && typeof frame.sessionId === 'string' && frame.sessionId === originalSession
            && frame.frameIndex === shard.offset + ordinal && same(frame.runIdentity, request.runIdentity)
            && same(frame.stamp, request.stamp) && frame.operation === request.operation && frame.method === request.method
            && frame.biasHistoryCount <= retainedBias.length + record.bias.length, 'Sampling recovery frame or its bias belongs to another source');
          validateFrame(frame, request);
          lastBiasCount = frame.biasHistoryCount;
          validatedSummaries.push({ index: frame.frameIndex, step: frame.step, timeFs: frame.timeFs,
            ...(Number.isFinite(frame.physicalEnergyEV) ? { physicalEnergyEV: frame.physicalEnergyEV } : {}),
            ...(Number.isFinite(frame.temperatureK) ? { temperatureK: frame.temperatureK } : {}), role: frame.role });
        }
        for (const entry of record.bias) retainedBias.push(entry);
        visibleBiasCount = lastBiasCount;
        summaries.push(...validatedSummaries);
        shards.push({ ...shard, bytes: record.bytes, sha256: record.sha256, identity: record.identity });
        recoverableCount += shard.count;
      } catch (error) {
        issues.push({ index, message: String(error.message).slice(0, 2048) });
        break; // An ordered sampling trajectory cannot jump over a damaged interval.
      }
    }
    if (!issues.length && (recoverableCount !== manifest.frameCount || manifest.biasCount !== undefined && manifest.biasCount !== retainedBias.length))
      issues.push({ message: 'Sampling recovery index has an incomplete frame or bias count' });
    const terminal = manifest.terminal;
    const sealed = (manifest.schema === 1 || manifest.state === 'sealed') && terminal;
    if (sealed && (terminal.frameCount !== manifest.frameCount || terminal.sessionId !== originalSession
      || !same(terminal.stamp,request.stamp) || !same(terminal.runIdentity,request.runIdentity)
      || terminal.operation !== request.operation || terminal.method !== request.method)) issues.push({ message: 'Sampling terminal evidence differs from its source or frame count' });
    const phase = !issues.length && sealed && terminal.kind === 'completed' ? 'completed'
      : !issues.length && sealed && terminal.kind === 'stopped' ? 'stopped' : 'partial';
    const identity = recoveryIdentity(request);
    assert((manifest.identity === undefined || same(manifest.identity,identity)) && (manifest.source === undefined || same(manifest.source,request.stamp)), 'Sampling recovery source does not match the published index');
    const scope = captureScope(manifest.scope);
    assert(await checkedDirectory(fs, directory) === directoryId, 'Sampling recovery directory changed');
    const descriptor = { id, kind: 'sampling', identity, source: request.stamp, phase, recoverableCount,
      bytesLength: shards.reduce((total, shard) => total + shard.bytes, 0), verification: 'verified',
      expectedCount: manifest.expectedCount ?? (Number.isSafeInteger(terminal?.frameCount) ? terminal.frameCount : manifest.frameCount),
      ...(manifest.createdAt ? { createdAt: manifest.createdAt } : {}), ...(manifest.updatedAt ? { updatedAt: manifest.updatedAt } : {}),
      ...(scope ? { scope } : {}), ...(issues.length ? { issues } : {}) };
    const biasHistory = retainedBias.slice(0, phase === 'partial' ? visibleBiasCount : retainedBias.length);
    return { directory, directoryId, descriptor, manifest, request, requestRecord, marker, headline, topology, shards, summaries, biasHistory };
  }

  async function discard(value) {
    const { directory, directoryId, manifest, shards, headline, marker, requestRecord } = value;
    assert(!value.descriptor.issues?.length && shards.length === manifest.shards.length
      && value.descriptor.recoverableCount === manifest.frameCount, 'Damaged sampling records were retained');
    assert(await checkedDirectory(fs, directory) === directoryId, 'Sampling recovery directory changed');
    const files = [...shards, ...(requestRecord ? [{ name: 'request.json', identity: requestRecord.identity }] : []),
      { name: 'manifest.json', identity: headline.identity }, { name: '.retain-recovery.json', identity: marker.identity }];
    const names = new Set(await fs.readdir(directory));
    assert(names.size === files.length && files.every(item => names.has(item.name)), 'Unrecognized sampling recovery members were retained');
    for (const item of files) {
      const stat = await fs.lstat(path.join(directory, item.name), { bigint: true });
      assert(ordinaryFile(stat) && fileIdentity(stat) === item.identity, 'Sampling recovery member changed');
    }
    for (const item of files) {
      const file = path.join(directory, item.name), stat = await fs.lstat(file, { bigint: true });
      assert(await checkedDirectory(fs, directory) === directoryId && ordinaryFile(stat) && fileIdentity(stat) === item.identity, 'Sampling recovery member changed');
      await fs.unlink(file);
    }
    await fs.rmdir(directory);
  }

  const recovery = createRecoveryAccess({
    listIds: () => recoveryIds(fs, root, idPattern),
    available: id => typeof id === 'string' && idPattern.test(id) && !entries.has(id),
    summarize: summarizeRecovery,
    load: loadRecovery,
    read: (value, offset, limit, summaryOnly) => summaryOnly ? value.summaries.slice(offset, offset + limit) : framesFrom(value.directory, value.shards, value.topology, offset, limit),
    describeOpen: ({ manifest, request, descriptor, biasHistory }) => ({ request,
      ...(descriptor.phase === 'partial' ? { biasHistory } : { terminal: { ...manifest.terminal, biasHistory } }),
      initial: { structure: request.structure, stamp: descriptor.source } }),
    discard,
  });

  async function closeOwner(owner) {
    await Promise.all([recovery.closeRecoveryOwner(owner), ...[...entries.values()]
      .filter(entry => (owner === undefined || owner === entry.owner) && entry.committed).map(detach)]);
  }

  return { create, append, appendBias, commit, read, release, abandon: detach, closeOwner, ...recovery };
}

module.exports = { createConformerSamplingStore };
