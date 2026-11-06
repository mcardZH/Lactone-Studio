/** Scientific model state shared by the Store and its application adapters. No UI, host, or runtime-service dependencies. */
import type { BuilderAssignments, BuilderDraft } from '../builder-draft';
import type { InheritedRouteSettings, SourceIssue } from '../gaussian-source';
import type { MixedBasisSettings } from '../mixed-basis';
import type { Structure, Vector3 } from '../types';

export type AtomId = string;

export type AtomRef = { kind: 'atom'; atomId: AtomId; image?: Vector3 };

export type BondRef = { kind: 'bond'; atomIds: [AtomId, AtomId]; image?: Vector3 };

export type ObjectRef = AtomRef | BondRef | { kind: 'auxiliary'; relationId: string } | { kind: 'port'; portId: string } | { kind: 'coordinate'; coordinateId: string };

/** A pending construction connection. Never an atom, physical bond or MM particle. */
export interface AttachmentPort {
  id: string; hostAtomId: AtomId; direction: Vector3; order: 1 | 1.5 | 2 | 3;
  displayLength: number; presetId?: string; slotId?: string;
}

export interface MeasurementRecord { id: string; mode: 'distance' | 'angle' | 'dihedral'; atomIds: AtomId[]; images?: Vector3[]; color: string }

export interface MeasurementState {
  mode: 'auto' | 'distance' | 'angle' | 'dihedral' | null; atomIds: AtomId[];
  images?: Vector3[];
  records?: MeasurementRecord[]; activeRecordId?: string | null;
}

export interface MeasurementSession {
  mode: MeasurementState['mode']; pendingAtomIds: AtomId[]; autoAtomIds: AtomId[];
  pendingImages?: Vector3[]; autoImages?: Vector3[];
  records: MeasurementRecord[]; activeRecordId: string | null; nextRecordSerial: number;
}

export interface AuxiliaryRelation { id: string; a: AtomId; b: AtomId; order: 0.5; kind: 'auxiliary' }

export interface DeletedBond { atomIds: [AtomId, AtomId]; image?: Vector3 }

export interface ModelCoordinate {
  id?: string; type: 'B' | 'A' | 'D'; atomIds: AtomId[];
  /** Definition/display identity only; a backend must explicitly admit image-aware execution. */
  images?: Vector3[];
  /** Optional link to a persistent B/A/D object; task action and parameters remain separate. */
  objectId?: string;
  action: 'freeze' | 'scan'; steps: number; increment: number | null;
  source?: 'orca'; value?: number; start?: number; end?: number; values?: number[];
}

export interface ModelCoordinateObject { id:string; type:'B'|'A'|'D'; atomIds:AtomId[]; images?:Vector3[] }

export interface SharedModelConstraints {
  frozenAtomIds:AtomId[]; coordinates:ModelCoordinate[];
  /** One document-owned master switch. False suspends execution, retaining all definitions. */
  enabled?: boolean;
  /** Confirmed freezes have one document owner; engine arrays are projections only. */
  canonical?: true;
}

/** Complete, explicitly object-bound Gaussian definitions, including inactive rows.
 * Metadata for deletion/Undo only; never an effective physical constraint list. */
export interface GaussianBoundCoordinateDefinition {
  rowId:string; objectId:string; type:'B'|'A'|'D'; atomIds:AtomId[];
  action:'freeze'|'scan'; rowEnabled:boolean; stepsText:string; incrementText:string;
}

export interface ModelSelection { atomIds: AtomId[]; bonds: BondRef[]; auxiliaryIds: string[]; portIds?: string[]; coordinateIds?: string[] }

export interface ModelDocument {
  /** Explicit structure checkpoint; independent of edits and runtime results. */
  cellCheckpoint?: CellCheckpoint;
  /** Reversible validity token only. Source files, analysis caches and native
   * sessions remain owned outside the Store and are never cloned into Undo. */
  analysisBindingId?: string;
  /** Session-owned base electronic confirmation; omitted by scientific file writers. */
  electronicStateConfirmed?: boolean;
  /** Current session calculation data. Structural edits revoke it; history cannot revive it. */
  bondOrderObservation?: BondOrderObservation;
  gaussianBasisState?: GaussianBasisState;
  id: string; revision: number; draft: BuilderDraft; selection: ModelSelection;
  auxiliaryRelations: AuxiliaryRelation[]; deletedBonds: DeletedBond[];
  internalCoordinates?: ModelCoordinate[];
  /** Document-wide confirmed freezes. Legacy active definitions migrate once. */
  sharedConstraints?: SharedModelConstraints;
  coordinateObjects?: ModelCoordinateObject[];
  gaussianBoundCoordinates?:GaussianBoundCoordinateDefinition[];
  attachmentPorts?: AttachmentPort[];
  canUndo: boolean; canRedo: boolean;
}

export interface ModelProjectContext { assignments: BuilderAssignments; coordinates: ModelCoordinate[] }
export type ModelProjectReplayState =
  | { kind:'structure'; document:ModelDocument; contexts:Record<string,ModelProjectContext> }
  | { kind:'selection'; selection:ModelSelection };
export interface ModelProjectLinkedToken {
  id:string;groupId:string;kind:'structure'|'selection';
  members:{documentId:string;before:ModelProjectReplayState;after:ModelProjectReplayState}[];
}
export type ModelProjectHistoryEntry = ModelProjectReplayState | {kind:'linked';token:ModelProjectLinkedToken};
export interface ModelProjectLinkGroup {id:string;documentIds:string[];referenceDocumentId:string;confirmedOrder:string[]|null}
/** Pure, bounded project data. Native sessions, callbacks and linked-store
 * tokens deliberately have no representation in this contract. */
export interface ModelStoreProjectState {
  schema:'sciyue-model-store'; version:1;
  document:ModelDocument;
  contexts:Record<string,ModelProjectContext>; contextScope:'gaussian'|'orca';
  analysisSourceInitialized:boolean;
  baseline:{structure:Structure;assignments:BuilderAssignments;content:string};
  past:ModelProjectHistoryEntry[]; future:ModelProjectHistoryEntry[];
  history:{maxEntries:number;maxBytes:number;omittedPast:number;omittedFuture:number};
}

/** Explicit permission for one native GFN MD snapshot, never a generic
 * exemption from editor freezes or a serializable running-process handle. */
export interface NativeMDPolicy {
  kind: 'native-gfn-md';
  method: 'gfnff' | 'gfn0' | 'gfn1' | 'gfn2';
  dtFs: 2;
  protectedAtomIds: AtomId[];
  forceConstantKJMolNm2: number;
}

export interface DocumentStamp {
  documentId: string; revision: number; graphFingerprint: string;
  coordinatesFingerprint: string; constraintsFingerprint: string;
  nativeMDPolicy?: NativeMDPolicy;
}

/** Explicit source lineage for a geometry candidate. image identifies the
 * source-cell copy, not a guessed nearest image or an output bond image. */
export interface StructureTransformAtomMapping {
  atomId: AtomId; sourceAtomId: AtomId; image: Vector3;
  /** Equivalent source identities merged into this atom by an identified
   * symmetry operation. Conflicting or partial constraints are rejected. */
  sourceAtomIds?: AtomId[];
  /** Explicit native copy identity when source-cell images do not label the
   * representation uniquely. Never interpreted as a physical translation. */
  copyKey?: string;
}

/** Preview is immutable input to the sole Store commit path. Native algorithms
 * use the same contract; they never write a document, freezes or Undo directly. */
export interface StructureTransformCandidate {
  documentId: string; expectedRevision: number; operation: string;
  structure: Structure; atomMapping: StructureTransformAtomMapping[];
  /** Columns map a source lattice image into output lattice coordinates.
   * Required for nontrivial cell basis conversions of image-aware metadata. */
  latticeImageBasis?: [Vector3, Vector3, Vector3];
  /** Per-output-atom Cartesian linear transform for construction directions.
   * A translated/copied atom uses identity; no local-frame guessing. */
  directionTransforms?: Record<AtomId, [Vector3, Vector3, Vector3]>;
}

export interface FragmentSnapshot {
  /** Native model only. Scientific interchange formats do not carry this. */
  cellCheckpoint?: CellCheckpoint;
  structure: Structure; assignments: BuilderAssignments;
  auxiliaryRelations: AuxiliaryRelation[]; deletedBonds: DeletedBond[];
  internalCoordinates?: ModelCoordinate[];
  sharedConstraints?:SharedModelConstraints;
  coordinateObjects?:ModelCoordinateObject[];
  gaussianBoundCoordinates?:GaussianBoundCoordinateDefinition[];
  attachmentPorts?: AttachmentPort[];
}

export type CellCheckpoint = Omit<FragmentSnapshot, 'cellCheckpoint'>;

export interface ClipboardPayload {
  schema: 'sciyue-model-fragment'; version: 1; sourceDocumentId: string; fragment: FragmentSnapshot;
}

export interface PastePolicy { cell?: 'require-compatible' | 'keep-target' | 'use-source' | 'omit'; offset?: Vector3 }

export interface PasteConflict { kind: 'cell' | 'assignments'; message: string }

export interface ScientificEditRequest {
  documentId: string; revision: number; bindingId: string;
  operation: 'edit' | 'undo' | 'redo';
}

export type ScientificEditGuard = (request: Readonly<ScientificEditRequest>) => boolean;

/** Session Undo metadata only. Stable atom memberships remain owned by assignments. */
export interface GaussianBasisState {
  basis: string;
  mixedBasis?: MixedBasisSettings;
  inheritedBasis: Pick<InheritedRouteSettings, 'basisKeyword' | 'basisTail'>;
  basisIssues?: SourceIssue[];
}

export interface BondOrderEntry { atomIds: [string, string]; value: number }

export type XtbBondOrders =
  | { definition: 'mayer-ao'; sourceField: 'wbo'; threshold: 0.1; entries: BondOrderEntry[] }
  | { definition: 'mayer-wiberg'; sourceField: 'tblite:bond-orders'; threshold: 0; entries: BondOrderEntry[] };

export type BondOrderObservation = XtbBondOrders & {
  runId: string; engine: 'xtb' | 'tblite'; version: string; method: 'gfn2';
  calculation: 'optimize' | 'singlepoint'; charge: number; uhf: number;
}

