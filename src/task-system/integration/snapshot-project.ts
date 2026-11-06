import type { ScientificSourceFile } from '../../results/input-file';
import { assertResultNotAborted } from '../../results/contracts';
import type { SnapshotDescriptionView, SnapshotLeaseView, TaskSystemBridge } from '../application-contracts';

type SnapshotFile = SnapshotDescriptionView['files'][number];
export interface SnapshotCompanionDescriptor { token: string; name: string; size: number; revision: string }
/** The desktop composition resolves only host-owned snapshot capabilities. */
export interface SnapshotCompanionPorts {
  describe(lease: SnapshotLeaseView, sourceRef: string, signal?: AbortSignal): Promise<SnapshotCompanionDescriptor>;
  close(token: string): Promise<void>;
}
export function snapshotBridgeCompanions(bridge: TaskSystemBridge): SnapshotCompanionPorts {
  return {
    describe: (lease, sourceRef, signal) => bridge.request('snapshot.companion-source', { ...lease, sourceRef }, { signal }),
    close: token => bridge.request('snapshot.close-companion', { token }),
  };
}

export interface SnapshotScientificSourceFile extends ScientificSourceFile {
  readonly snapshotIdentity: Readonly<{
    snapshotId: string; taskId: string; runId: string | null; libraryId: string; sourceSetId?: string; sourceVersion?: string;
    artifactId: string; sourceRef: string; sha256: string;
  }>;
}
export interface SnapshotProjectSources {
  readonly description: SnapshotDescriptionView;
  readonly files: readonly SnapshotScientificSourceFile[];
  /** Release this import's roots. Result wrappers retain their own source consumers. */
  close(): Promise<void>;
}
const RANGE_BYTES = 1024 ** 2; // Matches snapshot.read-range's host capability.
const MAX_SLICE_BYTES = 64 * 1024 ** 2; // Existing ResultInputFile range contract.
const hashPattern = /^[a-f0-9]{64}$/;

/** Scope the reuse map to the current project, never to the active view or task title. */
export function snapshotProjectKey(projectId: string, snapshotId: string): string {
  if (!projectId || !snapshotId) throw new Error('固定快照缺少项目或来源身份。');
  return JSON.stringify([projectId, snapshotId]);
}

function validateDescription(description: SnapshotDescriptionView, requested: { snapshotId: string; leaseId?: string }): void {
  if (description.snapshotId !== requested.snapshotId || !description.leaseId || requested.leaseId && description.leaseId !== requested.leaseId
    || !description.taskId || (description.runId !== null && !description.runId) || !description.libraryId || description.preparationState?.sourcesReady !== true
    || description.contentIdentity?.algorithm !== 'sha256' || !hashPattern.test(description.contentIdentity.hash ?? '')
    || !Array.isArray(description.files) || !description.files.length) throw new Error('固定快照身份或来源准备状态无效。');
  if (description.runId === null && (!description.sourceSetId || !description.sourceVersion)) throw new Error('无运行来源缺少稳定来源集合及版本。');
  const seen = new Set<string>();
  for (const file of description.files) {
    if (!file.artifactId || !file.sourceRef || seen.has(file.sourceRef) || !file.name || /[\\/\0]/.test(file.name)
      || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0 || !hashPattern.test(file.sha256)
      || !file.range || !Number.isSafeInteger(file.range.offset) || file.range.offset < 0 || file.range.length !== file.byteSize)
      throw new Error('固定快照文件身份、SHA或字节边界无效。');
    seen.add(file.sourceRef);
  }
}

function sourceFile(bridge: TaskSystemBridge, description: SnapshotDescriptionView, metadata: SnapshotFile,
  lease: SnapshotLeaseView, companions?: SnapshotCompanionPorts): SnapshotScientificSourceFile {
  let references = 1, rootReleased = false, released = false;
  let closing: Promise<void> | undefined, companion: Promise<SnapshotCompanionDescriptor> | undefined;
  let companionDescriptor: SnapshotCompanionDescriptor | undefined, companionClosed = false;
  const operations = new Set<Promise<unknown>>();
  const live = () => { if (references === 0 || released) throw new Error('固定快照来源已释放。'); };
  function operation<T>(read: () => Promise<T>): Promise<T> {
    live();
    const pending = Promise.resolve().then(read); operations.add(pending);
    return pending.finally(() => { operations.delete(pending); });
  }
  async function closeLease(): Promise<void> {
    if (references > 0 || released) return;
    if (closing) return closing;
    closing = (async () => {
      await Promise.allSettled([...operations]);
      if (companionDescriptor && !companionClosed) { await companions!.close(companionDescriptor.token); companionClosed = true; }
      await bridge.request('snapshot.release', lease); released = true;
    })().finally(() => { closing = undefined; });
    return closing;
  }
  function retain(): () => Promise<void> {
    live(); references++; let returned = false;
    return async () => { if (!returned) { returned = true; references--; } await closeLease(); };
  }
  async function range(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    assertResultNotAborted(signal);
    if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > metadata.byteSize || end - start > MAX_SLICE_BYTES)
      throw new Error('固定快照读取范围无效或过大。');
    return operation(async () => {
      const bytes = new Uint8Array(end - start);
      for (let offset = start; offset < end; offset += RANGE_BYTES) {
        assertResultNotAborted(signal);
        const length = Math.min(RANGE_BYTES, end - offset);
        const response = await bridge.request('snapshot.read-range', { ...lease, sourceRef: metadata.sourceRef, offset, length }, { signal });
        assertResultNotAborted(signal);
        if (response.offset !== offset || response.length !== length || response.sha256 !== metadata.sha256
          || !(response.bytes instanceof Uint8Array) || response.bytes.byteLength !== length) throw new Error('固定快照读取回执与SHA身份或字节边界不符。');
        bytes.set(response.bytes, offset - start);
      }
      return bytes;
    });
  }
  async function descriptor(signal?: AbortSignal): Promise<SnapshotCompanionDescriptor | undefined> {
    assertResultNotAborted(signal); live();
    if (!companions) return undefined;
    // Creation is shared, but cancellation remains local to the requesting consumer.
    if (!companion) companion = operation(async () => {
      const value = await companions.describe(lease, metadata.sourceRef);
      if (typeof value.token === 'string' && value.token) companionDescriptor = value;
      if (!companionDescriptor || value.name !== metadata.name || value.size !== metadata.byteSize || value.revision !== metadata.sha256)
        throw new Error('受管快照来源与原始SHA身份不符。');
      return value;
    });
    const value = await companion; assertResultNotAborted(signal); live(); return value;
  }
  const file: SnapshotScientificSourceFile = {
    name: metadata.name, size: metadata.byteSize,
    snapshotIdentity: Object.freeze({ snapshotId: description.snapshotId, taskId: description.taskId, runId: description.runId,
      libraryId: description.libraryId, sourceSetId: description.sourceSetId, sourceVersion: description.sourceVersion, artifactId: metadata.artifactId, sourceRef: metadata.sourceRef, sha256: metadata.sha256 }),
    retain,
    async close() { if (!rootReleased) { rootReleased = true; references--; } await closeLease(); },
    slice(start = 0, end = metadata.byteSize) {
      // Match Blob slice indexing, while retaining the existing bounded-range contract.
      const clamp = (value: number) => value < 0 ? Math.max(metadata.byteSize + Math.trunc(value), 0) : Math.min(Math.trunc(value), metadata.byteSize);
      const first = clamp(start), last = Math.max(first, clamp(end));
      return { async arrayBuffer() { return (await range(first, last)).buffer; } };
    },
    stream() {
      const release = retain(); let offset = 0, completed = false;
      const finish = async () => { if (!completed) { completed = true; await release(); } };
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          try {
            if (completed) return;
            if (offset === metadata.byteSize) { await finish(); controller.close(); return; }
            const end = Math.min(offset + RANGE_BYTES, metadata.byteSize), bytes = await range(offset, end);
            if (completed) return; offset = end; controller.enqueue(bytes);
          } catch (error) { controller.error(error); await finish(); }
        },
        cancel: finish,
      }, { highWaterMark: 0 });
    },
    async text() {
      const reader = file.stream().getReader(), decoder = new TextDecoder(), pieces: string[] = [];
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; pieces.push(decoder.decode(value, { stream: true })); } pieces.push(decoder.decode()); return pieces.join(''); }
      finally { await reader.cancel(); reader.releaseLock(); }
    },
    readCompanionSourceToken: async () => (await descriptor())?.token,
    readCompanionSourceDescriptor: descriptor,
  };
  return file;
}

/** Borrow a described root, retain one real host lease per source, then feed
 * these files to usePostprocessWorkspace.read. It already owns parsing,
 * complete playback preparation and chunked .es persistence of raw bytes.
 * consumeInitialLease is only for an explicitly transferred snapshot.open root. */
export async function openSnapshotProjectSources(bridge: TaskSystemBridge, requested: { snapshotId: string; leaseId?: string },
  options: { signal?: AbortSignal; consumeInitialLease?: boolean; companions?: SnapshotCompanionPorts } = {}): Promise<SnapshotProjectSources> {
  assertResultNotAborted(options.signal);
  const description = await bridge.request('snapshot.describe', requested, { signal: options.signal });
  const root: SnapshotLeaseView = { snapshotId: description.snapshotId, leaseId: description.leaseId };
  const files: SnapshotScientificSourceFile[] = []; let rootReleased = false;
  const releaseRoot = async () => { if (options.consumeInitialLease && !rootReleased) { await bridge.request('snapshot.release', root); rootReleased = true; } };
  try {
    validateDescription(description, requested); assertResultNotAborted(options.signal);
    for (const metadata of description.files) {
      assertResultNotAborted(options.signal);
      const lease = await bridge.request('snapshot.retain', root, { signal: options.signal });
      if (lease.snapshotId !== root.snapshotId || !lease.leaseId || lease.leaseId === root.leaseId) {
        if (lease.leaseId && lease.leaseId !== root.leaseId) await bridge.request('snapshot.release', lease);
        throw new Error('固定快照来源保留回执无效。');
      }
      files.push(sourceFile(bridge, description, metadata, lease, options.companions));
    }
    assertResultNotAborted(options.signal); await releaseRoot();
    return { description: structuredClone(description), files: Object.freeze(files), async close() {
      const outcomes = await Promise.allSettled(files.map(file => file.close?.()));
      const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), '固定快照来源租约仍待实际关闭。');
    } };
  } catch (error) {
    const outcomes = await Promise.allSettled([...files.map(file => file.close?.()), releaseRoot()]);
    const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError([error, ...failures.map(result => result.reason)], '固定快照读取失败，部分来源租约仍待关闭。');
    throw error;
  }
}
