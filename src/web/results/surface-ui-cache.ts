import type { SurfaceGeneratedFields, SurfaceScalarField } from '../../results/surface-contracts';

/** Deliberately contains neither field values, domain masks nor File handles. */
export interface SurfaceFieldDescriptor {
  fieldId: string; sourceId: string; sourceRevision: string; valueUnit: string | null; definition: unknown[];
}
export interface SurfaceGenerationDescriptor {
  generationId: string; shapeId: string; mappingId: string | null;
  quality: SurfaceGeneratedFields['quality']; dimensions: SurfaceScalarField['grid']['dimensions'];
}
export const surfaceFieldDefinition = (field: SurfaceScalarField): unknown[] => [field.id, field.source.revision, field.function, field.valueUnit, field.definitionEvidence.kind, field.definitionEvidence.description, field.validDomain.kind, field.validDomain.kind === 'node-mask' ? field.validDomain.restrictedTo : null];
export const surfaceFieldDescriptor = (field: SurfaceScalarField): SurfaceFieldDescriptor => ({ fieldId: field.id, sourceId: field.source.id, sourceRevision: field.source.revision, valueUnit: field.valueUnit, definition: surfaceFieldDefinition(field) });
export const surfaceGenerationDescriptor = (generated: SurfaceGeneratedFields, generationId = generated.stamp.requestId): SurfaceGenerationDescriptor => ({ generationId, shapeId: generated.pair.shape.id, mappingId: generated.pair.mapping?.id ?? null, quality: generated.quality, dimensions: generated.pair.shape.grid.dimensions });
