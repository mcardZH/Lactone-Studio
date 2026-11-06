import type { TrajectoryResult } from '../../results/contracts';
import type { ScientificSourceFile } from '../../results/input-file';
import type { SnapshotProjectSources } from '../../task-system/integration/snapshot-project';
import type { TaskMonitorWorkspaceCache } from './monitor-workspace-cache';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/** A source lease, not permission to mutate or dispose the monitor results.
 * The postprocessing adapter makes independent metadata projections and owns
 * release after their last consumer. A view change does not own this lease. */
export interface SnapshotMonitorReuse {
  results: readonly TrajectoryResult[];
  release(): void;
}

/** Reuse only the exact original file already held by this fixed snapshot.
 * Neither matching filenames nor equal molecular geometries prove lineage. */
export function retainSnapshotMonitorResults(
  cache: TaskMonitorWorkspaceCache,
  bundle: SnapshotProjectSources,
  file: ScientificSourceFile,
): SnapshotMonitorReuse | null {
  const fixed = bundle.files.find(candidate => candidate === file);
  if (!fixed) return null;
  const description = bundle.description;
  const metadata = description.files.find(candidate => candidate.sourceRef === fixed.snapshotIdentity.sourceRef);
  const entry = cache.latest(description.taskId);
  if (!metadata || !entry || entry.retired || !metadata.roles.includes('primary-output')) return null;
  const source = entry.view.sourceIdentity, boundary = entry.view.sourceBoundary;
  const provenance = metadata.provenance;
  if (!source || !boundary || !provenance || !entry.results.length || !entry.view.prepared || entry.view.resultsComplete !== true
    || source.taskId !== description.taskId || source.runId !== description.runId
    || entry.taskId !== description.taskId || entry.view.task.runId !== description.runId
    || source.artifactId !== metadata.artifactId
    || entry.frames.collectionId !== entry.view.collectionId || entry.frames.revision !== entry.view.revision
    || !Number.isSafeInteger(entry.view.sourceRevision) || provenance.sourceRevision !== entry.view.sourceRevision
    || !Number.isSafeInteger(entry.view.sourceGeneration) || boundary.sourceGeneration !== entry.view.sourceGeneration
    || canonical(provenance.sourceBoundary) !== canonical(boundary)
    || boundary.fileIdentity.path !== source.path
    || boundary.publishedByteRange.start !== 0 || boundary.publishedByteRange.end !== metadata.byteSize
    || metadata.range.offset !== 0 || metadata.range.length !== metadata.byteSize
    || fixed.snapshotIdentity.snapshotId !== description.snapshotId
    || fixed.snapshotIdentity.taskId !== description.taskId || fixed.snapshotIdentity.runId !== description.runId
    || fixed.snapshotIdentity.libraryId !== description.libraryId
    || fixed.snapshotIdentity.artifactId !== metadata.artifactId || fixed.snapshotIdentity.sha256 !== metadata.sha256
    || fixed.name !== metadata.name || fixed.size !== metadata.byteSize
    || entry.results.some(result => result.source.id !== entry.view.collectionId || result.source.size !== metadata.byteSize
      || !['gaussian', 'orca'].includes(result.engine))) return null;
  const releaseOwner = cache.retain(entry);
  let released = false;
  return { results: entry.results, release() { if (!released) { released = true; releaseOwner(); } } };
}
