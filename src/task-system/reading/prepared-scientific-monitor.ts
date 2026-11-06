import type { ScientificGeometry, ScientificJob, ScientificParserSnapshot } from '../../results/scientific-contracts';
import { decodeScientificGeometry } from '../../results/scientific-reader';
import type { MonitorGeometry } from '../application-contracts';
import type { ScientificReadSnapshot } from './contracts';
import { SCIENTIFIC_READER_IMPLEMENTATION_VERSION } from './implementation-version';

export interface ScientificMonitorDelta {
  collectionId: string;
  revision: string;
  baseRevision: string | null;
  frameCount: number;
  framesDelta: { index: number; frame: MonitorGeometry }[];
  reset: boolean;
  prepared: true;
}
export interface PreparedScientificMonitor {
  readonly collectionId: string;
  readonly revision: string;
  readonly snapshotId: string;
  readonly sourceRevision: number;
  readonly sourceGeneration: number;
  readonly observedSha256: string;
  readonly prepared: true;
  readonly frameCount: number;
  readonly frames: readonly MonitorGeometry[];
  readonly jobs: readonly ScientificJob[];
  readonly released: boolean;
  readonly counts: Readonly<{ geometryReads: number; reusedGeometries: number; frames: number }>;
  readonly sourceBoundary: ScientificReadSnapshot<ScientificParserSnapshot>['sourceBoundary'];
  readonly sourceIdentity: ScientificReadSnapshot<ScientificParserSnapshot>['identity'];
  /** Retain/release are independent consumer handles, not external run control. */
  retain(): PreparedScientificMonitor;
  release(): void;
  readSourceRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  delta(knownRevision?: string | null): ScientificMonitorDelta;
}

// Weak source keys never own an OUT, reader, transport, lease or callback. Values
// are only immutable coordinates. A released monitor cannot pin old source IO.
const geometryBlocks = new WeakMap<ScientificGeometry, Map<string, MonitorGeometry>>();

/** Fully prepare an immutable scientific publication, decoding only geometry
 * blocks not already proved for this same source/run/lineage and scientific job.
 * Metadata/provenance remain attached to the current snapshot, never a cache hit. */
export async function prepareScientificMonitor(snapshot: ScientificReadSnapshot<ScientificParserSnapshot>, previous?: PreparedScientificMonitor | null, options: { signal?: AbortSignal; onProgress?(completed: number, total: number): void } = {}): Promise<PreparedScientificMonitor> {
  const signal = options.signal; signal?.throwIfAborted();
  const source = snapshot.identity, file = snapshot.fileIdentity;
  const snapshotId = snapshot.snapshotId, sourceRevision = snapshot.sourceRevision, sourceGeneration = snapshot.sourceGeneration, sourceBoundary = snapshot.sourceBoundary;
  const collectionId = JSON.stringify([source.sourceId, source.taskId, source.runId, source.artifactId, file.environmentId, file.path, file.fileId, snapshot.sourceGeneration]);
  const revision = JSON.stringify([snapshotId, collectionId, SCIENTIFIC_READER_IMPLEMENTATION_VERSION]);
  const lease = snapshot.bytes.retain(), end = snapshot.sourceBoundary.publishedByteRange.end;
  const frames: MonitorGeometry[] = [];
  const counts = { geometryReads: 0, reusedGeometries: 0, frames: 0 };
  try {
    for (const job of snapshot.value.jobs) {
      // Match the common scientific result contract: a special-center job is
      // retained as diagnostics, never converted to a zero-atom display model.
      if (job.data.centers?.some(center => center.kind !== 'real') || job.frames.some(frame => frame.geometry.centers?.some(center => center.kind !== 'real'))) continue;
      const context = JSON.stringify([collectionId, job.engine, job.jobIndex, job.segmentIndex, job.charge, job.multiplicity, job.data.route]);
      for (const frame of job.frames) {
        signal?.throwIfAborted();
        const geometry = frame.geometry;
        if (!Number.isSafeInteger(geometry.start) || !Number.isSafeInteger(geometry.end) || geometry.start < 0 || geometry.end < geometry.start || geometry.end > end) throw new Error('结构帧超出完整科学发布边界。');
        const frameId = JSON.stringify([context, frame.index, geometry.start, geometry.end, geometry.line]);
        const key = frameId;
        let prepared = geometryBlocks.get(geometry)?.get(key);
        if (prepared) counts.reusedGeometries++;
        else {
          const raw = await lease.readRange(geometry.start, geometry.end, signal); signal?.throwIfAborted();
          if (raw.length !== geometry.end - geometry.start) throw new Error('固定结构来源字节不完整。');
          const atoms = decodeScientificGeometry(raw, geometry).map(atom => Object.freeze({ id: atom.id!, element: atom.element, x: atom.x, y: atom.y, z: atom.z }));
          counts.geometryReads++;
          prepared = Object.freeze({ sourceKey: collectionId, frameId, atoms: Object.freeze(atoms) as unknown as MonitorGeometry['atoms'] });
          let byContext = geometryBlocks.get(geometry);
          if (!byContext) { byContext = new Map(); geometryBlocks.set(geometry, byContext); }
          byContext.set(key, prepared);
        }
        frames.push(prepared);
        options.onProgress?.(frames.length, snapshot.value.jobs.reduce((sum, item) => sum + item.frames.length, 0));
      }
    }
    signal?.throwIfAborted(); counts.frames = frames.length;
    const base = previous && !previous.released && previous.collectionId === collectionId && previous.frameCount <= frames.length ? previous : null;
    const baseRevision = base?.revision ?? null;
    const changes = frames.flatMap((frame, index) => base?.frames[index] === frame ? [] : [{ index, frame }]);
    // Capture only the delta, not previous's handle/reader or full old index.
    const state = { refs: 0, frames: Object.freeze(frames) as readonly MonitorGeometry[], jobs: snapshot.value.jobs, changes, released: false };
    const frozenCounts = Object.freeze({ ...counts });
    const handle = (): PreparedScientificMonitor => {
      state.refs++; let released = false;
      const check = () => { if (released || state.released) throw new Error('监控准备结果已释放。'); };
      return Object.freeze({
        collectionId, revision, snapshotId, sourceRevision, sourceGeneration, observedSha256: snapshot.observedSha256, prepared: true as const,
        get frameCount() { return state.frames.length; }, get frames() { return state.frames; }, get jobs() { return state.jobs; }, get released() { return released; }, counts: frozenCounts,
        sourceBoundary, sourceIdentity: source,
        retain() { check(); return handle(); },
        release() { if (released) return; released = true; if (--state.refs === 0) { state.released = true; state.frames = []; state.jobs = []; state.changes = []; lease.release(); } },
        async readSourceRange(start: number, byteEnd: number, readSignal?: AbortSignal) { check(); if (byteEnd > end) throw new Error('请求超出完整科学快照边界。'); return lease.readRange(start, byteEnd, readSignal); },
        delta(knownRevision?: string | null): ScientificMonitorDelta {
          check();
          const same = knownRevision === revision;
          const incremental = baseRevision !== null && knownRevision === baseRevision;
          return { collectionId, revision, baseRevision: knownRevision ?? null, frameCount: state.frames.length, framesDelta: same ? [] : incremental ? state.changes.map(change => ({ ...change })) : state.frames.map((frame, index) => ({ index, frame })), reset: !same && !incremental, prepared: true };
        }
      });
    };
    return handle();
  } catch (error) { lease.release(); throw error; }
}
