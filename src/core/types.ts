import type { CoordinateDraft } from './coordinate-drafts';
import type { MixedBasisSettings } from './mixed-basis';
import type { GaussianSourceMeta, InheritedRouteSettings, SourceIssue } from './gaussian-source';
import type { SolventSelection } from './solvents/types';
import type { GaussianOniomSettings } from './oniom/types';
import type { OrcaInputSourceMeta } from './orca/types';

/** Scientific layer-draft provenance is independent of regenerated row IDs. */
export interface InputLayerDraftRole { type: 'input-layer'; engine: 'gaussian' | 'orca'; state: 'active' | 'cleared' }

export interface Atom {
  id?: string;
  sourceIndex?: number;
  formalCharge?: number;
  element: string;
  x: number;
  y: number;
  z: number;
  /** Explicit user-deleted/open valence must not be silently refilled. */
  hydrogenMode?: 'auto' | 'explicit';
  /** Reliable pyrrolic [nH] intent; invalidate when its element/charge/aromatic neighbours change. */
  aromaticHydrogen?: boolean;
  /** Ordered-neighbour tetrahedral parity, 0 when geometrically undefined. */
  stereoParity?: -1 | 0 | 1;
  /** User construction seed, not a force-field atom type or an oxidation state. */
  geometryPresetId?: string;
}

export type Vector3 = [number, number, number];
export interface PeriodicCell {
  vectors: [Vector3, Vector3, Vector3];
  pbc: [boolean, boolean, boolean];
  origin?: Vector3;
  source?: string;
  /** Unconfirmed axes are a labelled preview only, never a runtime setting. */
  pbcProvenance?: { kind: 'source-explicit' | 'format-defined' | 'user-confirmed' | 'unconfirmed'; evidence: string };
}
export interface Bond { a: number; b: number; order: number; aromatic?: boolean; stereo?: number; kind?: 'covalent' | 'coordination'; /** False means order=1 is a drawing/geometry placeholder, not a confirmed single bond. */ orderKnown?: false; /** Explicit non-aromatic 0.5/1.5 connection; legacy aromatic imports stay readable. */ fractional?: boolean; /** Origin of an automatically assigned connection. */ perception?: 'gfn2-mbo' | 'periodic-gfn2' | 'metal-distance' | 'periodic-distance' | 'empirical-organic' | 'empirical-distance'; /** Raw source-calculation value, revoked when geometry/atomic/electronic state changes. */ mbo?: number; /** Cell translation applied to b relative to a. */ image?: Vector3 }
export interface BondPerceptionIssue { atomIds: [string, string]; image?: Vector3; kind: 'partial' | 'weak-contact' | 'unresolved'; reason: string }
export interface AtomGroup { name: string; atomIds: string[] }

/** Origin of a library model, not a calculation or a claim about edited geometry. */
export interface StructureLibraryProvenance {
  entryId: string; category: string; name: string; formula: string; phase: string;
  source: { name: string; recordId: string; url: string; license: string; licenseUrl: string;
    structureKind: 'experimental' | 'computed' | 'curated' | 'derived';
    citation?: string; doi?: string; version?: string; conditions?: string; retrievedAt?: string };
  normalization: { method: string; details?: string[] };
}

/** Retained execution evidence for modeling MD, separate from original input
 * provenance and from process/session handles. Missing versions stay unknown. */
export interface MDPreparationProvenance {
  schema: 1;
  driver: 'native-xtb-md' | 'ase-rdkit';
  method: string;
  software: { name: string; version?: string }[];
  documentId: string; sourceRevision: number;
  frameSeq: number; step: number; timeFs: number;
  native?: {
    dtFs: number; thermostat: 'Berendsen'; hydrogenMassAmu: 4 | null; shakeHydrogenBonds: boolean;
    protection: 'none' | 'pairwise-distance'; protectedAtomIds: string[]; forceConstantKJMolNm2: number;
    segment: number; velocityInitialization: 'fresh' | 'restart';
    rawPotential?: { value: number; unit: 'hartree'; definition: 'native-total-including-protection' | 'native-physical-potential'; includesProtection: boolean; sourceArtifact: 'xtb.trj'; sourceStep: number; sourceTimeFs: number; segment: number };
  };
}

export interface Structure {
  id: string;
  name: string;
  format: string;
  atoms: Atom[];
  charge: number | null;
  multiplicity: number | null;
  notes: string[];
  /** Persistent reference provenance. Library properties never become current computed results. */
  libraryProvenance?: StructureLibraryProvenance;
  sourceRoute?: string;
  gaussianSource?: GaussianSourceMeta;
  gaussianSources?: GaussianSourceMeta[];
  /** Source evidence only; importing it never adopts the source task. */
  orcaSource?: OrcaInputSourceMeta;
  /** Original source-order centers bound once on raw import. Deleted IDs remain
   * as provenance anchors; model edits/save/restore must never rebuild this map. */
  sourceAtomIds?: string[];
  bonds?: Bond[];
  bondSource?: 'file' | 'inferred' | 'drawn';
  /** Display-only uncertain contacts; never ordinary force-field edges. */
  bondPerceptionIssues?: BondPerceptionIssue[];
  dimension?: 2 | 3;
  molfile?: string;
  groups?: AtomGroup[];
  mapping?: { original: number; current: number }[];
  preparation?: { forcefield?: string; before?: number; after?: number; unit?: string; status: string; md?: MDPreparationProvenance };
  cell?: PeriodicCell;
  /** Incomplete 1D/2D translation source, not an invented full 3D cell. */
  periodicSource?: { translationVectors: Vector3[]; completeness: 'partial'; evidence: string };
  /** Immutable raw-source geometry/PBC before promotion to an XYZ work model;
   * this is provenance, never the current calculation or editable geometry. */
  periodicWorkingSource?: { structureId:string; name:string; format:string; cell:PeriodicCell; atoms:Atom[]; coordinateUnit:'angstrom' };
  /** Diagram coordinates only; never substitute them for Cartesian atom positions. */
  layout2D?: Record<string, { x: number; y: number }>;
  revision?: number;
  /** Editable display/model layers; not a claim that an ONIOM input has been generated. */
  modelLayers?: { id: string; label: string; kind: 'qm' | 'mm' | 'middle'; atomIds: string[]; frozen?: boolean; draftRole?: InputLayerDraftRole }[];
}

export interface AdvancedSettings {
  scfAlgorithm: 'default' | 'qc' | 'xqc';
  noVarAcc: boolean; noIncFock: boolean; fermi: boolean; noDIIS: boolean;
  vshift: number | null; scfMaxCycle: number | null; maxConventional: number | null;
  optConvergence: 'default' | 'loose' | 'tight' | 'verytight'; maxStep: number | null; optMaxCycles: number | null;
}

export type TaskId = 'sp' | 'opt' | 'freq' | 'optfreq' | 'ts' | 'qst2' | 'qst3' | 'irc' | 'scan' | 'constrained' | 'td' | 'tdopt' | 't1opt' | 'nmr' | 'stable' | 'bsse';
export type MethodId = 'b3lyp' | 'm062x' | 'pbe0' | 'cam-b3lyp' | 'wb97xd' | 'tpss' | 'tpssh' | 'pm6' | 'pm7' | 'gfn2-xtb' | 'custom';
export type Dispersion = 'gd3bj' | 'gd3' | 'none';

/** A selected immutable document/frame snapshot, never a live pointer or a
 * camera/selection-derived structure. The registry owns refresh and staleness. */
export interface InputStructureSource {
  documentEpoch?:string;sourceEpoch?:number;
  documentId:string; revision:number; label:string; structure:Structure;
  charge:number; multiplicity:number; confirmed:boolean; geometryUnits:'angstrom';
}
export interface GaussianQstSettings {
  reactantSource:InputStructureSource|null; product:InputStructureSource|null; tsGuess:InputStructureSource|null;
  mapping:{reactantId:string;productId:string;tsGuessId?:string}[];
  mappingConfirmed:boolean; targetContext:string;
  /** Explicit request only; ordinary TS+Freq defaults are not reused. */
  frequency:boolean;
}

export interface GaussianSettings {
  task: TaskId;
  method: MethodId;
  customMethod: string;
  basis: string;
  dispersion: Dispersion;
  grid: 'efficient' | 'default';
  /** Independent overrides; absent migrates legacy grid, an empty object uses program defaults. */
  integral?: { grid?: 'fine' | 'ultrafine' | 'superfinegrid'; acc2e?: number };
  scf: 'default' | 'conver6';
  nosymm: boolean;
  solvent: string;
  solventModel: 'iefpcm' | 'smd';
  solventModelManuallySelected?: boolean;
  /** Optional versioned selection; legacy builtin solvent remains readable. */
  solvation?: SolventSelection;
  /** Explicit user request only; absent/false does not append a 5D keyword. */
  use5D?: boolean;
  oniom?: GaussianOniomSettings;
  advanced?: AdvancedSettings;
  /** Input-task UI memory only. Writers consume the effective fields above. */
  parameterDrafts?: {
    scf?: { enabled:boolean; advanced:AdvancedSettings; scf:'default'|'conver6' };
    integration?: { enabled:boolean; grid:'efficient'|'default'; integral?:GaussianSettings['integral']; gridDraft?:'fine'|'ultrafine'|'superfinegrid'; acc2eDraft?:number; nosymm:boolean };
    vshift?: number | null;
    scfMaxCycle?: number | null;
    vshiftEnabled?: boolean;
    scfMaxCycleEnabled?: boolean;
  };
  unrestricted?:boolean;
  taskOptions?: TaskOptions;
  xtb?:XtbSettings;
  mixedBasis?: MixedBasisSettings;
  inheritedRoute?: InheritedRouteSettings;
  inheritanceIssues?: SourceIssue[];
  qst?:GaussianQstSettings;
}

export interface XtbSettings {scriptPath:string;executable:string;level:string;entryBasis:boolean;scriptConfirmed:boolean}

export interface InternalCoordinate { type:'B'|'A'|'D'; atoms:number[]; steps:number; increment:number|null; action?:'freeze'|'scan'; objectId?:string }
export interface FragmentDefinition { id?:string;label?:string;atoms:number[];charge:number;multiplicity:number;multiplicityMode?:'auto'|'manual' }
export interface TaskOptions {
  constraintsEnabled?:boolean;
  /** Legacy private-definition gate, read only for migration. Canonical model freezes have no master switch. */
  freezeEnabled?:boolean;
  /** Legacy inheritance preference; a canonical document always supplies its single freeze set. */
  inheritModelFreeze?: { atoms?: boolean; coordinates?: boolean };
  coordinates:InternalCoordinate[];
  coordinateDrafts?:CoordinateDraft[];
  frozenAtoms:number[];
  /** Historical inactive definitions; never automatically included in active GJF/FF constraints. */
  inactiveFrozenAtoms?:number[];
  frequency?: { raman?: boolean; temperatureK?: number | null; pressureAtm?: number | null };
  irc:{maxPoints:number|null;stepSize:number|null;lqa:boolean;confirmed:boolean};
  /** Missing on retained forms preserves their explicit state count. */
  excited:{nstates:number|null;nstatesMode?:'auto'|'manual';root:number;approximation:'td'|'tda'|'zindo';spin:'default'|'singlets'|'triplets'|'50-50';targetSpin:'singlets'|'triplets';useUks:boolean;frequency:boolean;/** Standalone same-state frequencies; no geometry optimization. */frequencyOnly?:boolean;printCoefficients:boolean;/** @deprecated Retained only for older saved forms. */environmentConfirmed?:boolean;/** @deprecated Never emitted. */nto?:boolean};
  nmr:{mode:'giao'|'spinspin'|'mixed'};
  stable:{optimize:boolean;confirmed:boolean};
  fragments:FragmentDefinition[];
  fragmentStatesConfirmed:boolean;
}

export interface FileSettings {
  saveCheckpoint: boolean;
  checkpointName: string;
  writeMemory: boolean;
  writeCores: boolean;
  readCheckpoint: boolean;
  oldCheckpoint: string;
  geometry: 'explicit' | 'check' | 'allcheck';
  guessRead: boolean;
  hessian: 'none' | 'readfc' | 'rcfc' | 'calcfc' | 'calcall' | 'recalcfc';
  recalcInterval?: number | null;
  basisFromCheckpoint?: boolean;
  compatibilityConfirmed: boolean;
  sourceElements: string;
}

export interface JobRequest {
  /** Current document-source catalog; only multistructure writers consume it. */
  inputSources?:InputStructureSource[];
  structure: Structure | null;
  settings: GaussianSettings;
  charge: number;
  multiplicity: number;
  electronicStateConfirmed: boolean;
  cores: number;
  memoryGB: number;
  /** False requires explicit resource confirmation; absent preserves saved/legacy requests. */
  resourcesConfirmed?: boolean;
  name: string;
  title: string;
  /** @deprecated Retained for saved forms; standalone FREQ has no subjective confirmation gate. */
  frequencyConditionsConfirmed?: boolean;
  files?: FileSettings;
}
