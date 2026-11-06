import type { FileIdentity } from '../contracts';
import type { SourceObservationEvidence, SourceReadOptions } from './contracts';

export function changedObservation(message: string, phase: string, before: FileIdentity, after: FileIdentity): Error {
  return Object.assign(new Error(message), { code: 'SOURCE_OBSERVATION_CHANGED', details: {
    stage: 'scientific-source-observation', operation: phase === 'read-range' ? 'readRange' : 'hash', phase, path: before.path, requestedIdentity: before, before, after
  } });
}
/** This defers one unaccepted live observation; it never proves append-only
 * bytes. A subsequent stable prefix SHA must still distinguish a rewrite. */
export function liveGrowthObservation(error: unknown, sourcePath: string, options: SourceReadOptions): SourceObservationEvidence | null {
  if (options.observationMode !== 'live-primary-output' || options.final || options.signal?.aborted || !error || typeof error !== 'object') return null;
  const value = error as { code?: string; details?: Record<string, unknown> };
  const details = value.details;
  if (!details || details.path !== sourcePath) return null;
  const transport = (value.code === 'FILE_CHANGED_DURING_HASH' || value.code === 'FILE_CHANGED_DURING_READ')
    && details.stage === 'transport-filesystem' && details.phase === 'postflight' && (details.operation === 'hash' || details.operation === 'readRange');
  const reader = value.code === 'SOURCE_OBSERVATION_CHANGED' && details.stage === 'scientific-source-observation'
    && ['initial-hash', 'prefix-hash', 'read-range', 'post-hash'].includes(String(details.phase));
  if (!transport && !reader) return null;
  const before = details.before as FileIdentity | undefined, after = details.after as FileIdentity | undefined;
  if (!before || !after || before.verification !== 'verified' || after.verification !== 'verified'
    || before.path !== sourcePath || after.path !== sourcePath || before.environmentId !== after.environmentId
    || typeof before.fileId !== 'string' || !before.fileId.length || before.fileId !== after.fileId
    || !Number.isSafeInteger(before.byteSize) || !Number.isSafeInteger(after.byteSize) || before.byteSize < 0 || after.byteSize <= before.byteSize) return null;
  const requested = details.requestedIdentity as FileIdentity | undefined;
  if (!requested || requested.environmentId !== before.environmentId || requested.path !== before.path || requested.fileId !== before.fileId) return null;
  return { phase: String(details.phase), before: { ...before }, after: { ...after } };
}
