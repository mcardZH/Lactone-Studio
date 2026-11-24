import type { TrajectoryResult } from './contracts';
import type { WavefunctionMetadata, WavefunctionOrbital } from './orbital-contracts';
import {postprocessPairedWavefunctionBinding,type PostprocessDocument} from './postprocess-document';
import {postprocessMetadataConflict,type PostprocessSourcePair} from './postprocess-sources';

type OrbitalListIdentity = Pick<WavefunctionMetadata, 'sourceId' | 'sourceRevision' | 'orbitals'>;
export interface OrbitalSelectionSource {
  metadata: WavefunctionMetadata | null;
  list: OrbitalListIdentity | null;
  printed: boolean;
  key: string | null;
  sourceResult?: TrajectoryResult | null;
  sourceFrameIndex?: number;
  sourcePair?: PostprocessSourcePair;
  sourceDocument?: PostprocessDocument;
}
const positiveIndex = (value: number) => Number.isSafeInteger(value) && value > 0;
function unique<T>(values: readonly T[]): T | null { return values.length === 1 ? values[0] : null; }

/** Native ordinals are channel-local. In Molden only sourceIndex is global;
 * neither that global index nor an OUT's zero-based index is a UI ordinal. */
function nativeAt(metadata: WavefunctionMetadata, spin: WavefunctionOrbital['spin'], ordinal: number): WavefunctionOrbital | null {
  if (!positiveIndex(ordinal)) return null;
  const candidate = unique(metadata.orbitals.filter(row => row.spin === spin && row.ordinal === ordinal));
  if (!candidate || candidate.displayIndex !== ordinal || metadata.orbitals.filter(row => row.key === candidate.key).length !== 1) return null;
  if (!positiveIndex(candidate.sourceIndex)) return null;
  if (metadata.format === 'molden') {
    // Trust the inspected block identity, not an inferred alpha-count offset.
    // Native currently requires grouped spin blocks; UI lookup need not repeat
    // that parser policy or pretend it has verified arbitrary Molden ordering.
    if (metadata.orbitals.filter(row => row.sourceIndex === candidate.sourceIndex).length !== 1) return null;
  } else if (candidate.sourceIndex !== ordinal) return null;
  return candidate;
}

function matchesContinuation(input:OrbitalSelectionSource,result:TrajectoryResult,frame:number,originalFrame:number,pair:PostprocessSourcePair) {
  const document=input.sourceDocument;
  if(result.engine!=='gaussian'||pair.wavefunction.kind!=='fchk'||!pair.comparisonResultId||!document||document.pair!==pair
    ||document.result.id!==result.id||document.result.source.id!==result.source.id||document.result.jobIndex!==result.jobIndex
    ||document.result.frames!==result.frames)return false;
  const native=unique(pair.primary.results.filter(row=>row.id===pair.comparisonResultId&&row.jobIndex===result.jobIndex&&row.source.id===result.source.id));
  const binding=postprocessPairedWavefunctionBinding(document);
  return Boolean(native&&binding?.frameIndex===frame&&binding.sourceFrameIndex===originalFrame&&binding.pairFrameIndex===pair.frameIndex);
}

/** Source-aware selection only; never starts work or changes scientific data.
 * Missing/ambiguous provenance stays read-only instead of trying another index. */
export function resolveNativeOrbitalKey(input: OrbitalSelectionSource): string | null {
  const { metadata, list, key } = input;
  if (!metadata || !list || !key) return null;
  const row = unique(list.orbitals.filter(value => value.key === key));
  if (!row) return null;
  if (!input.printed) {
    if (list.sourceId !== metadata.sourceId || list.sourceRevision !== metadata.sourceRevision) return null;
    const native = unique(metadata.orbitals.filter(value => value.key === key));
    return native?.spin === row.spin && native.ordinal === row.ordinal && native.sourceIndex === row.sourceIndex ? native.key : null;
  }
  const result = input.sourceResult, frame = input.sourceFrameIndex ?? 0;
  if (!result || list.sourceId !== result.source.id || !Number.isSafeInteger(frame) || !result.frames.some(value => value.index === frame)) return null;
  const originalFrame = result.frames.find(value => value.index === frame)!.sourceFrameIndex ?? frame;
  const expectedRevision = JSON.stringify([result.id, result.jobIndex, frame, result.frames[frame]?.sourceFrameIndex ?? frame]);
  if (list.sourceRevision !== expectedRevision) return null;
  const standalone = result.source.id === metadata.sourceId;
  let continuation:PostprocessSourcePair|undefined;
  if (standalone) {
    if (frame !== 0 || (metadata.format === 'molden' ? result.engine !== 'structure' : result.engine !== 'gaussian')) return null;
  } else {
    const pair = input.sourcePair, saved = pair?.wavefunction.metadata;
    if (!pair || pair.conflicts.length||postprocessMetadataConflict(pair)||pair.primary.result.source.id!==result.source.id
      || pair.wavefunction.kind !== metadata.format || saved?.sourceId !== metadata.sourceId || saved.sourceRevision !== metadata.sourceRevision || saved.format !== metadata.format
      || (result.engine === 'orca' ? metadata.format !== 'molden' : result.engine !== 'gaussian' || metadata.format !== 'fchk')) return null;
    if(pair.primary.result.jobIndex!==result.jobIndex){
      if(!matchesContinuation(input,result,frame,originalFrame,pair))return null;
      continuation=pair;
    }else if(pair.frameIndex!==originalFrame)return null;
  }
  // The list uses the last printed channel for this frame, just like its owner.
  const channel = result.scientific?.orbitals.filter(value => value.spin === row.spin && value.frameIndex === frame).at(-1);
  if (!channel) return null;
  const original = unique(channel.orbitals.filter(value => key === `printed:${channel.spin}:${value.index}`));
  if (!original || !Number.isSafeInteger(original.index)) return null;
  const origin = original.sourceId ?? channel.sourceId ?? result.source.id;
  if (origin !== result.source.id && origin !== metadata.sourceId) return null;
  // composePostprocessDocument preserves sourceIndex before applying OUT display
  // offsets. Saved WF scientific rows use channel-local source indices; native
  // Molden metadata's global sourceIndex is validated separately by nativeAt.
  const zeroBasedOutput = !standalone && result.engine === 'orca';
  const ordinal = origin === metadata.sourceId ? original.sourceIndex ?? original.index + (zeroBasedOutput ? 1 : 0)
    : (original.sourceIndex ?? original.index) + (zeroBasedOutput ? 1 : 0);
  if (ordinal !== original.index + (zeroBasedOutput ? 1 : 0)) return null;
  const native=nativeAt(metadata,row.spin,ordinal);
  if(!native)return null;
  if(continuation){
    const definition=`orbital:${row.spin}:${ordinal}:energy`;
    const printed=continuation.primary.continuationObservations?.find(value=>value.definition===definition&&value.unit==='hartree');
    const saved=continuation.wavefunction.observations.find(value=>value.definition===definition&&value.unit==='hartree');
    if(origin!==result.source.id||channel.unit!=='hartree'||!printed||!saved||!positiveIndex(metadata.basisCount)||ordinal>metadata.basisCount
      ||original.energy!==printed.value||(original.sourceLine??channel.sourceLine)!==printed.sourceLine
      ||native.energy!==saved.value||native.occupation!==original.occupation)return null;
    const roundoff=4*Number.EPSILON*Math.max(1,Math.abs(printed.value),Math.abs(saved.value));
    if(Math.abs(printed.value-saved.value)>printed.rounding+saved.rounding+roundoff)return null;
  }
  return native.key;
}
