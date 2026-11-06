import type { InputStructureSource, Structure } from '../types';
import type { SolventSelection } from '../solvents/types';
import type { SourceIssue } from '../gaussian-source';

/** Only reviewed profiles are accepted; unknown future majors are never guessed. */
export type OrcaVersion = '5' | '6.0' | '6.1';
export type OrcaTask = 'sp' | 'opt' | 'freq' | 'optfreq' | 'scan' | 'ts' | 'irc' | 'td' | 'tdopt' | 'nmr' | 'stable' | 'bsse' | 'neb' | 'esd' | 'md';
export type OrcaMethodId = 'b3lyp' | 'pbe0' | 'm062x' | 'cam-b3lyp' | 'wb97x-d3' | 'wb97m-v' | 'wb97x-v' | 'tpss' | 'tpssh' | 'hf-3c' | 'pbeh-3c' | 'b97-3c' | 'r2scan-3c' | 'wb97x-3c' | 'xtb2' | 'pwpb95-d4' | 'revdsd-pbep86-d4-2021' | 'wb97x-2-d3bj' | 'dlpno-ccsd-t' | 'dlpno-ccsd-t1';
export interface OrcaSourceCoordinate {
  type: 'B' | 'A' | 'D';
  /** Source-order one-based indices, mapped to stable IDs by the model owner. */
  atoms: number[];
  action: 'freeze' | 'scan';
  value?: number;
  raw: string;
}
export interface OrcaInputSourceMeta {
  schema: 1;
  id: string;
  fileName: string;
  jobIndex: number;
  rawInput: string;
  keywords: string[];
  charge: number;
  multiplicity: number;
  level: {
    method?: OrcaMethodId;
    methodKeyword?: string;
    basis?: string;
    basisKeyword?: string;
    ecpKeywords: string[];
    dispersion: 'none' | 'd3' | 'd3bj' | 'd4' | 'builtin' | null;
    unrestricted?: boolean;
    solvent?: { model: 'cpcm' | 'smd'; name: string; raw: string };
  };
  frozenAtoms: number[];
  /** Scan ranges/steps remain only in rawInput/raw, never executable drafts. */
  coordinates: OrcaSourceCoordinate[];
  issues: SourceIssue[];
  unsupported: string[];
}
export interface OrcaCoordinate {
  objectId?:string;
  type: 'B' | 'A' | 'D';
  atomIds: string[];
  action: 'freeze' | 'scan';
  value?: number;
  start?: number;
  end?: number;
  steps?: number;
  values?: number[];
}
export interface OrcaExcitedSettings {
  /** Missing on retained forms preserves their explicit root count. */
  rootsMode?: 'auto' | 'manual';
  approximation: 'td' | 'tda' | 'stddft' | 'stda';
  roots: number;
  root: number;
  targetSpin: 'singlet' | 'triplet';
  useUks: boolean;
  /** Same-state frequency after optimization; absent retains optimization-only behavior. */
  frequency?: boolean;
  /** Compute frequencies at the supplied geometry without optimization. */
  frequencyOnly?: boolean;
  soc: boolean;
  triplets: boolean;
  printCoefficients: boolean;
  energyWindowEV?: number;
  selectionThresholdEh?: number;
  perturbationWindowEV?: number;
}
/** A purpose-bound review, distinct from ESD minimum evidence. */
export interface OrcaHessianPathEvidence {
  schema: 1;
  purpose: 'ts-initial' | 'irc';
  levelRelation: 'same-level' | 'initial-approximation';
  dispersion: '' | 'none' | 'd3' | 'd3bj' | 'd4' | 'builtin';
  solventModel: '' | 'gas' | 'cpcm' | 'smd';
  solvation?: SolventSelection;
  atomIds: string[];
  compatibilityConfirmed: boolean;
  /** Bound to the actual file body, source declaration and current scientific target. */
  targetContext: string;
  transitionStateConfirmed: boolean;
  approximationNote: string;
}
export interface OrcaAsset {
  id: string;
  name: string;
  kind: 'xyz' | 'hessian' | 'gbw' | 'mm-parameters' | 'point-charges' | 'restart';
  /** Text dependencies are preserved verbatim; binary GBW is an external reference. */
  text?: string;
  sha256?: string;
  structure?: Structure;
  orbitalEvidence?: {
    source: string;
    version: OrcaVersion;
    method: string;
    basis: string;
    charge: number;
    multiplicity: number;
    atomIds: string[];
    compatibilityConfirmed: boolean;
  };
  mmEvidence?: {
    atomIds: string[];
    atomCount: number;
    atomOrderConfirmed: boolean;
    bondedParametersConfirmed: boolean;
    source: string;
  };
  /** Physical facts not recoverable from a Hessian filename or matrix alone. */
  hessianEvidence?: {
    /** Optional actual ORCA source profile; converted foreign Hessians may omit it. */
    version?: OrcaVersion;
    state: string;
    charge: number;
    multiplicity: number;
    /** TD references can be closed-shell while the physical target is triplet. */
    referenceMultiplicity?: number;
    stateSource?: 'udft' | 'td';
    geometryUnits: 'bohr';
    source: string;
    minimumConfirmed: boolean;
    atomOrderConfirmed: boolean;
    method?: string;
    basis?: string;
    solvent?: string;
    path?: OrcaHessianPathEvidence;
  };
  restartEvidence?: { taskIdentity: string; atomIds: string[]; conditionsConfirmed: boolean };
}
/** Optional overrides: omitted values retain the selected ORCA mode's defaults. */
export interface OrcaNebConvergence {
  convType?: 'all' | 'cionly';
  maxForceCI?: number;
  rmsForceCI?: number;
  turnOnCI?: number;
  toleranceScale?: number;
  maxIterations?: number;
}
/** Final OptTS convergence, separate from the preceding NEB switching criteria. */
export interface OrcaNebTsConvergence {
  maxGradient?: number;
  rmsGradient?: number;
  energyChange?: number;
  maxDisplacement?: number;
  rmsDisplacement?: number;
  maxIterations?: number;
}
export interface OrcaNebSettings {
  /** Absent on retained tasks means the original CI-NEB route. */
  variant?: 'ci-neb' | 'neb-ts';
  /** Explicit reactant snapshot; absent retains the task owner's structure. */
  reactantSource?: InputStructureSource | null;
  product: Structure | null;
  /** Optional explicit document snapshot; imported files keep their existing route. */
  productSource?: InputStructureSource | null;
  /** Explicit product atom identity corresponding to each reactant atom ID. */
  mapping: { reactantId: string; productId: string }[];
  mappingConfirmed: boolean;
  /** User-facing total bead count, including both endpoints. */
  images: number;
  freeEnds: boolean;
  preOptimize: boolean;
  interpolation: 'sidpp' | 'idpp' | 'linear';
  /** Optional path anchor, not an already validated transition state. */
  tsGuess?: Structure | null;
  tsGuessSource?: InputStructureSource | null;
  tsGuessMapping?: { reactantId: string; productId: string }[];
  tsGuessMappingConfirmed?: boolean;
  /** False suspends the four compact NEB overrides without deleting their drafts.
   * Omitted on retained tasks: existing explicit compact overrides remain active. */
  customConvergenceEnabled?: boolean;
  convergence?: OrcaNebConvergence;
  tsConvergence?: OrcaNebTsConvergence;
}
export interface OrcaEsdSettings {
  channel: 'abs' | 'fluor' | 'phosp' | 'ic' | 'isc';
  temperatureK: number | null;
  initialState: string;
  finalState: string;
  groundHessianId?: string;
  excitedHessianId?: string;
  tripletHessianId?: string;
  initialHessianId?: string;
  finalHessianId?: string;
  energyGapCm1?: number;
  useDuschinsky: boolean;
  herzbergTeller: boolean;
  coupling: 'inline' | 'external';
  externalSocAu?: [number, number];
  root?: number;
  singletRoot?: number;
  tripletRoot?: number;
  tripletSublevel?: -1 | 0 | 1;
  externalCouplingConfirmed?: boolean;
}
export interface OrcaMdSettings {
  timestepFs: number | null;
  steps: number | null;
  initialTemperatureK: number | null;
  targetTemperatureK: number | null;
  thermostat: 'none' | 'csvr' | 'nhc';
  couplingTimeFs: number | null;
  trajectoryStride: number;
  restartAssetId?: string;
  activeAtomIds: string[];
  constraints: OrcaCoordinate[];
  taskIdentity: string;
  restartConfirmed: boolean;
  durationFs?: number;
}
export interface MultiscaleBoundary {
  qmAtomId: string;
  lowAtomId: string;
  linkElement: string;
  scaleFactors?: number[];
  confirmed: boolean;
}
export interface OrcaMultiscaleSettings {
  mode: 'none' | 'qm-mm' | 'qm-xtb';
  qmAtomIds: string[];
  freezeLowLayer: boolean;
  qmCharge: number;
  qmMultiplicity: number;
  lowMethod: string;
  embedding: 'mechanical' | 'electrostatic';
  boundaries: MultiscaleBoundary[];
  parametersAssetId?: string;
  configurationConfirmed: boolean;
  activeAtomIds?: string[];
  graphEvidence?: {
    atomIds: string[];
    bonds: { a: string; b: string; order: number }[];
    source: 'explicit' | 'user-reviewed';
    confirmed: boolean;
  };
}
export interface OrcaSettings {
  scf?: { convergence?: 'default' | 'loose' | 'normal' | 'strong' | 'tight' | 'verytight'; strategy?: 'default' | 'SlowConv' | 'VerySlowConv'; algorithm?: 'auto' | 'KDIIS' | 'SOSCF' | 'TRAH'; maxIterations?: number };
  grid?: 'auto' | 'DefGrid1' | 'DefGrid2' | 'DefGrid3';
  /** UI-only memory for disabled controls; writers consume effective scf/grid fields. */
  parameterDrafts?: {
    scf?: { enabled:boolean; values:NonNullable<OrcaSettings['scf']> };
    grid?: { enabled:boolean; value:OrcaSettings['grid'] };
  };
  optimization?: { convergence?: 'default'|'loose'|'normal'|'tight'|'verytight'; hessian?: 'default'|'calc'|'recalc'; recalcInterval?:number; maxIterations?:number; maxStep?:number };
  frequency?: { raman?:boolean; temperatureK?:number; pressureAtm?:number };
  version: OrcaVersion;
  task: OrcaTask;
  method: OrcaMethodId;
  basis: string;
  solventModel: 'cpcm' | 'smd';
  solventModelManuallySelected?: boolean;
  solvent: string;
  solvation?: SolventSelection;
  unrestricted: boolean;
  pno: 'normal' | 'tight' | 'loose';
  constraints: OrcaCoordinate[];
  frozenAtomIds: string[];
  /** Task-local freeze master; false suspends private/inherited freezes without deleting them. */
  freezeEnabled?: boolean;
  /** Task-local projection only; omitted fields retain legacy shared-freeze inheritance. */
  inheritModelFreeze?: { atoms?: boolean; coordinates?: boolean };
  excited: OrcaExcitedSettings;
  neb: OrcaNebSettings;
  esd: OrcaEsdSettings;
  md: OrcaMdSettings;
  multiscale: OrcaMultiscaleSettings;
  nmr: 'shielding' | 'coupling';
  stableOptimize: boolean;
  fragments: { id: string; atomIds: string[]; charge: number; multiplicity: number; multiplicityMode?: 'auto' | 'manual' }[];
  fragmentStatesConfirmed?: boolean;
  ircHessianId?: string;
  initialOrbitalsId?: string;
  ircMaxIterations?: number;
  /** Required when IRC calculates its own initial Hessian. */
  ircStartEvidence?: { confirmed: boolean; context: string };
}
export interface OrcaJobRequest {
  /** New forms explicitly confirm resources; retained API requests may omit it. */
  resourcesConfirmed?: boolean;
  structure: Structure | null;
  /** Current registry catalog, not the form's stored source snapshot. */
  inputSources?: InputStructureSource[];
  settings: OrcaSettings;
  charge: number;
  multiplicity: number;
  electronicStateConfirmed: boolean;
  name: string;
  /** User-defined system prefix, separate from the task output stem. */
  systemName?: string;
  title: string;
  cores: number;
  memoryGB: number;
  assets: OrcaAsset[];
}
export interface OrcaIssue { field: string; message: string; severity: 'error' | 'warning' }
export interface OrcaOutputFile { name: string; text: string; role: 'input' | 'structure' | 'dependency'; sourceAssetId?: string }
export interface OrcaBuildResult { files: OrcaOutputFile[]; issues: OrcaIssue[]; preview: string; version: OrcaVersion }
export interface OrcaMethodProfile {
  id: OrcaMethodId;
  label: string;
  family: 'pure' | 'hybrid' | 'double-hybrid' | 'coupled-cluster' | 'composite' | 'xtb';
  keywords: string[];
  basisPolicy: 'uniform-def2' | 'builtin' | 'none';
  tasks: OrcaTask[];
  frequency: 'analytic' | 'numeric' | 'none';
  soc: boolean;
  sources: string[];
}
export interface OrcaTaskVariant {
  suffix: string;
  keywords?: string[];
  blocksBeforeCoordinates?: string[];
  blocksAfterCoordinates?: string[];
  coordinateLines?: string[];
  charge?: number;
  multiplicity?: number;
}
export interface OrcaTaskRender {
  keywords: string[];
  blocksBeforeCoordinates: string[];
  blocksAfterCoordinates: string[];
  coordinateLines?: string[];
  variants?: OrcaTaskVariant[];
  files: OrcaOutputFile[];
  issues: OrcaIssue[];
}
export interface OrcaRenderContext {
  stem: string;
  method: OrcaMethodProfile;
  /** ORCA task-specific writers decide their own zero/one-base convention. */
  atomIndex: (id: string) => number;
  asset: (id: string | undefined, kind: OrcaAsset['kind']) => OrcaAsset | undefined;
}
