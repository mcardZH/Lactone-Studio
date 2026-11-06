import type { SurfaceCapabilityRequest } from './surface-controls-contracts';
import { surfaceFieldDefinition } from './surface-ui-cache';

/** Small metadata identity only: never serialize field values or domain masks. */
export function surfaceCapabilityKey(request: SurfaceCapabilityRequest): string {
  const c=request.context,g=request.quantitativeGrid,input=request.input;
  return JSON.stringify([[c.sourceId,c.sourceRevision,c.jobIndex,c.sourceFrameIndex,c.generation,c.documentId,c.documentRevision],
    request.function,request.isovalue,[g.mode,g.mode==='spacing'?g.spacingBohr:null],
    input.kind==='wavefunction'?['wavefunction']:['cubes',input.pair?surfaceFieldDefinition(input.pair.shape):null,input.pair?.mapping?surfaceFieldDefinition(input.pair.mapping):null]]);
}
