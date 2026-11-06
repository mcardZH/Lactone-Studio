import type { Atom, Structure } from '../core/types';
import type { ResultEnergyObservation, ResultFileRole, ResultFrameSummary, ResultStatus } from './contracts';

/** Both engines feed these capabilities; presentation must not branch on engine. */
export type ScientificTask = 'unknown' | 'sp' | 'opt' | 'ts' | 'freq' | 'irc' | 'scan' | 'neb' | 'td' | 'nmr' | 'stability' | 'bsse' | 'esd' | 'md';
/** Native evidence is retained verbatim; its category is not a chemical diagnosis. */
export interface ScientificDiagnosticEvidence {
  category: string; severity: 'info' | 'warning' | 'error';
  sourceLine: number; raw: string; start?: number; end?: number;
}
/** These dimensions are independent; a normal exit does not prove convergence. */
export interface ScientificDiagnostics {
  integrity: { status: 'complete-snapshot' | 'damaged-tail' | 'changed-during-read' | 'unknown'; sourceLine?: number; message?: string };
  termination: { status: 'normal' | 'error' | 'not-observed'; sourceLine?: number; raw?: string };
  scf: { status: 'converged' | 'not-converged' | 'unknown'; frameIndex: number | null; sourceLine: number; raw?: string }[];
  tasks: { task: ScientificTask | 'optimization' | 'path' | 'ts-optimization'; status: 'completed' | 'not-converged' | 'incomplete' | 'unknown'; sourceLine: number; stageId?: string; frameIndex?: number | null; raw?: string }[];
  fields: { field: string; status: 'complete' | 'partial' | 'not-printed' | 'stage-not-reached' | 'no-compatible-companion' | 'unsupported' | 'conflict'; frameIndex?: number | null; sourceLine?: number; message?: string }[];
  errors: ScientificDiagnosticEvidence[];
}
export function emptyScientificDiagnostics(): ScientificDiagnostics {
  return { integrity: { status: 'unknown' }, termination: { status: 'not-observed' }, scf: [], tasks: [], fields: [], errors: [] };
}
export interface ScientificCenter {
  /** Native one-based center identity, independent of the display Atom array. */
  sourceIndex: number; sourceLine: number; kind: 'real' | 'ghost' | 'dummy' | 'unknown';
  element: string | null; nuclearCharge: number | null;
  /** Signed native atomic identifier, when its center meaning is unresolved. */
  sourceAtomicNumber?: number;
  /** Printed center-type identifier, independent of atomic number. */
  sourceAtomicType?: number;
  /** Original printed center row. */
  raw?: string;
  coordinates?: [number, number, number]; coordinateUnit?: 'angstrom' | 'bohr';
}
/** A printed path-iteration row; unknown column units stay in named fields/raw. */
export interface ScientificPathIteration {
  stageId?: string; pathDirection?: 'forward' | 'reverse';
  iteration: number; sourceLine: number; raw: string;
  fields: ScientificField[];
  images?: { image: number; energy?: { value: number; unit: string }; force?: { value: number; unit: string }; sourceLine: number }[];
}
export interface NebAuxiliaryData {
  kind: 'interpolation' | 'log'; source: { id: string; name: string; size: number; sha256?: string };
  status: 'complete' | 'partial'; messages: string[];
  iterations: { iteration: number; sourceLine: number; images: { image: number; distanceBohr: number; distanceRaw: string; relativeEnergy?: ResultEnergyObservation; energy?: ResultEnergyObservation; forces?: ScientificField[] }[] }[];
}
export interface NebEvidence {
  version: string; association: string[]; auxiliaries: NebAuxiliaryData[];
  conflicts: { iteration: number; image: number; kind: 'relative-energy'; values: ResultEnergyObservation[] }[];
  geometryMapped: number; geometryTotal: number; energyMapped: number;
}
export interface MdQuantityObservation {
  value: number; rawValue: string; sourceLine: number;
  unit?: string; rawUnit?: string; sourceId?: string; sourceName?: string;
  /** Only an actual source declaration, including an explicitly associated file's header. */
  unitEvidence?: { sourceLine: number; raw: string; sourceId?: string; sourceName?: string };
}
export interface MdStepObservation {
  sourceStep: number; rawStep: string; sourceLine: number;
  jobIndex: number | null; frameIndex: number | null; sourceFrameIndex?: number | null; stageId?: string;
  sourceId?: string; sourceName?: string;
  time?: MdQuantityObservation; potentialEnergy?: MdQuantityObservation; kineticEnergy?: MdQuantityObservation;
  totalEnergy?: MdQuantityObservation; temperature?: MdQuantityObservation; scfIterations?: MdQuantityObservation;
}
export interface MdSourceDifference {
  sourceStep: number; quantity: 'time' | 'potential-energy' | 'kinetic-energy' | 'total-energy' | 'temperature';
  frameIndex?: number | null;
  kind: 'converted-value-conflict' | 'incompatible-time'; values: MdQuantityObservation[];
}
export interface ScientificField {
  /** Native stage and raw printed label; independent of a compatibility key. */
  stageId?: string; rawLabel?: string;
  key: string; label: string; value: number | string; unit?: string;
  origin?: 'input-request' | 'program-adopted' | 'observation' | 'derived';
  /** Exact printed numeric token, before Number conversion. Display/copy may
   * preserve its significant digits; calculations continue to use value. */
  rawValue?: string;
  sourceLine: number; frameIndex?: number | null;
  /** Present when a result combines explicitly paired source files. */
  sourceId?: string; sourceName?: string;
}
export interface ScfCycle {
  frameIndex: number | null; sourceLine: number;
  sourceId?: string; sourceName?: string; unit?: 'hartree'; deltaEnergyUnit?: 'hartree';
  points: { iteration: number; energy: number | null; deltaEnergy?: number | null; sourceLine?: number;
    /** Exact printed tokens; absent when an older source projection did not retain them. */
    rawEnergy?: string; rawDeltaEnergy?: string }[];
}
export interface AtomicProperty {
  kind: 'charge' | 'spin' | 'shielding'; scheme: string; frameIndex: number | null; sourceLine: number;
  values: { atomIndex: number; element?: string; value: number }[];
  unit: string;
  sourceId?: string; sourceName?: string;
}
/** A source nucleus identity, never an isotope or index-base inferred from geometry. */
export interface NmrCouplingNucleus {
  rawLabel: string; sourceIndex: number | null; indexBase: 0 | 1 | 'unknown';
  /** Zero-based ordinary-atom mapping only when independently confirmed. */
  atomIndex: number | null; element?: string; sourceLine: number;
  isotope?: { rawLabel: string; massNumber?: number; sourceLine: number };
}
export interface NmrCouplingValue {
  label: string; value: number; rawValue: string; sourceLine: number;
  unit?: string; rawUnit?: string; unitSourceLine?: number;
  /** Native labels only; no tensor completion, component sums or K→J conversion. */
  part?: string; component?: { row: string; column: string; basis?: 'printed-axes' | 'source-table-position' | 'unknown' };
  sourceId?: string; sourceName?: string; start?: number; end?: number;
}
export interface NmrCouplingBlock {
  pair: [NmrCouplingNucleus, NmrCouplingNucleus];
  quantity: 'J' | 'reduced-K' | 'unknown'; rawQuantityLabel: string;
  form: 'scalar' | 'tensor' | 'components' | 'unknown';
  values: NmrCouplingValue[];
  jobIndex: number; frameIndex: number | null; sourceFrameIndex?: number | null; stageId?: string;
  sourceLine: number; endLine?: number; start?: number; end?: number;
  sourceId?: string; sourceName?: string;
  /** Printed method/response identity, when the source actually supplies it. */
  methodLabel?: string;
}
/** Shape-only constructor. Parsers reserve every retained scalar in their
 * existing scientific budget before appending; no semantic defaults are inferred. */
export function createNmrCouplingBlock(input: Omit<NmrCouplingBlock, 'values'> & { values?: NmrCouplingValue[] }): NmrCouplingBlock {
  return { ...input, pair: input.pair.map(nucleus => ({ ...nucleus, ...(nucleus.isotope ? { isotope: { ...nucleus.isotope } } : {}) })) as NmrCouplingBlock['pair'], values: input.values?.map(value => ({ ...value, ...(value.component ? { component: { ...value.component } } : {}) })) ?? [] };
}
export interface OrbitalChannel {
  spin: 'restricted' | 'alpha' | 'beta'; frameIndex: number | null; sourceLine: number;
  orbitals: { index: number; energy: number; occupation: number; sourceIndex?: number; sourceLine?: number; sourceId?: string; sourceName?: string }[];
  unit: 'hartree' | 'eV';
  sourceId?: string; sourceName?: string;
}
/** Unmodified source-coordinate observations, without an ordinary-atom/scene mapping. */
export interface RawCartesianModeComponent {
  sourceCoordinateIndex: number; indexBase: 0 | 1 | 'unknown';
  value: number; rawValue: string; sourceLine: number;
  unit?: string; sourceId?: string; sourceName?: string;
}
export interface VibrationMode {
  /** Absolute half-last-digit intervals established from the original tokens. */
  frequencyRounding?: number; displacementRounding?: number;
  index: number; frequency: number; sourceLine: number;
  /** Native mode index; index remains source-compatible, display numbering is separate. */
  sourceIndex?: number;
  kind?: 'vibration' | 'translation' | 'rotation' | 'unknown';
  atomElements?: string[];
  irIntensity?: number; ramanActivity?: number; reducedMass?: number;
  irIntensityUnit?: string; ramanActivityUnit?: string;
  /** Raw polarizability context; not an assertion of resonance-Raman support. */
  ramanActivityConvention?: 'static' | 'dynamic' | 'unknown';
  ramanExcitationWavelengthNm?: number; ramanActivitySourceLine?: number;
  ramanDepolarization?: number;
  /** Cartesian displacement as printed, atom order of the associated geometry. */
  displacements?: [number, number, number][];
  /** Kept separately when only native coordinate ordinals are known. Never an
   * animation vector, atom identity or implicitly scaled length. */
  rawCartesianComponents?: RawCartesianModeComponent[];
  displacementConvention?: 'cartesian' | 'mass-weighted' | 'unknown';
}
export interface Vibrations {
  sourceId?: string; sourceName?: string;
  frameIndex: number | null; modes: VibrationMode[];
  printedScaleFactor?: number; convention: string;
  atomBinding?: 'geometry-bound' | 'unavailable' | 'unknown';
  /** A native printed dimension, not proof of atoms/elements/geometry. */
  sourceAtomCount?: { value: number; rawValue: string; sourceLine: number };
  /** Electronic surface of this frequency evaluation, independent of the reference SCF and optimization status. */
  electronicTarget?: FrequencyElectronicTarget;
}
export interface FrequencyElectronicTarget {
  method: 'td' | 'tda' | 'scf' | 'udft' | 'unknown';
  state: 'ground' | 'excited' | 'unknown';
  /** One-based printed/requested TD root; unknown stays null, never an array index. */
  root: number | null; multiplicity: number | null;
  reference: 'restricted' | 'unrestricted' | 'restricted-open' | 'unknown';
  /** Original coordinate source lines survive stage projections without index remapping. */
  evaluationGeometrySourceLine: number | null; optimizationGeometrySourceLine: number | null;
  energy: { value: number; unit: 'hartree'; sourceLine: number } | null;
  evidence: readonly { sourceLine: number; kind: 'input-echo' | 'printed'; field: 'method' | 'root' | 'multiplicity' | 'reference'; value: string }[];
}
export interface ExcitedState {
  index: number; label: string; multiplicity: string | null; frameIndex: number | null;
  /** Native program explicitly identifies its printed Mult as an estimate, not a strict spin label. */
  multiplicityProvenance?: 'native-estimated';
  energyEv: number; wavelengthNm?: number; oscillatorStrength?: number; spinSquared?: number;
  transitions: { from: string; to: string; direction?:'->'|'<-'; amplitude?: number; weight?: number; spin?: 'alpha' | 'beta' | 'mixed'; sourceLine?: number }[];
  sourceLine: number;
}
export interface ScientificData {
  /** Complete same-job input geometry; never a computed/path frame. */
  inputGeometry?: { structure: Structure; origin: 'input-echo' | 'input-request'; sourceLine: number; endSourceLine: number; coordinateRoundingAngstrom?: number; unit: 'angstrom' | 'bohr'; rawInput?: string; sourceStart?: number; sourceEnd?: number; coordinateTokens?: [string, string, string][] };
  /** Pairing proof for a selected native IRC asset, independent of OUT geometries. */
  ircEvidence?: { outputId: string; jobIndex: number; role: 'irc-full' | 'irc-forward' | 'irc-reverse'; complete: boolean; summaryNodes: number[]; tsFrameIndex?: number; evidence: string[] };
  tasks: ScientificTask[]; version: string | null; route: string;
  diagnostics?: ScientificDiagnostics;
  centers?: ScientificCenter[];
  pathIterations?: ScientificPathIteration[];
  nebEvidence?: NebEvidence;
  mdSteps?: MdStepObservation[];
  mdSourceDifferences?: MdSourceDifference[];
  reference?: 'restricted' | 'unrestricted' | 'restricted-open' | 'unknown';
  readLimits?: { observations?: { limit: number; observed: number; retained: number; omitted: number; firstOmittedLine: number; lastOmittedLine: number } };
  source?: { id: string; name: string; sha256?: string };
  /** Original wrapped input echo, when route has been normalized for parsing. */
  printedRoute?: string;
  /** Explicit output references, not filename-pattern guesses made by the importer. */
  relatedFiles?: { name: string; role: ResultFileRole; sourceLine: number }[];
  pathImageCount?: number;
  /** Zero-based source atom ordinals, converted once at the engine boundary. */
  scanCoordinates?: { kind: 'bond' | 'angle' | 'dihedral'; atomIndices: number[]; unit: 'angstrom' | 'degree'; sourceLine: number }[];
  pathSummary?: {
    kind: 'irc' | 'neb'; sourceNode: number; energy: number; energyRounding: number;
    unit: 'hartree'; sourceLine: number; isTs?: boolean;
    /** Absent in legacy absolute ORCA summaries. Relative values are never promoted to absolute energies. */
    energyReference?: 'absolute' | 'relative-to-ts';
    rawEnergy?: string; rawUnit?: string; stageId?: string;
    /** Independently printed reference and precision token; not an inferred high-precision SCF energy. */
    referenceEnergy?: { value: number; rawValue: string; unit: 'hartree'; sourceLine: number };
    coordinate?: { value: number; unit: string; label: string };
  }[];
  summary: ScientificField[]; properties: ScientificField[]; scfCycles: ScfCycle[];
  orbitals: OrbitalChannel[]; atomicProperties: AtomicProperty[];
  nmrCouplings?: NmrCouplingBlock[];
  /** Compatibility/current group; all independent frequency blocks, when present, are retained below. */
  vibrations?: Vibrations;
  vibrationSets?: Vibrations[];
  thermochemistry: ScientificField[];
  excitedStates: ExcitedState[]; stability: ScientificField[]; bsse: ScientificField[];
  /** Missing fields are not zeros; only claim a reason when the source establishes it. */
  notices: string[];
}
export function emptyScientificData(): ScientificData {
  return { tasks: [], version: null, route: '', summary: [], properties: [], scfCycles: [], orbitals: [],
    atomicProperties: [], thermochemistry: [], excitedStates: [], stability: [], bsse: [], notices: [] };
}
export interface ScientificLine { text: string; start: number; end: number; number: number }
export interface ScientificGeometry {
  coordinateRoundingAngstrom?: number;
  start: number; end: number; line: number;
  format: 'gaussian-orientation' | 'gaussian-cartesian' | 'orca-cartesian';
  elements: string[];
  centers?: ScientificCenter[];
}
export interface IndexedScientificFrame extends ResultFrameSummary {
  geometry: ScientificGeometry;
  /** Native path coordinate only; derived coordinates require their own explicit label. */
  coordinate?: { value: number; unit: string; label: string; sourceValue?: number };
  pathDirection?: 'forward' | 'reverse' | 'ts';
}
export interface ScientificJob {
  jobIndex: number; segmentIndex: number; engine: 'gaussian' | 'orca';
  charge: number | null; multiplicity: number | null;
  status: ResultStatus; frames: IndexedScientificFrame[]; data: ScientificData; messages: string[];
}
export interface ScientificParser {
  consume(line: ScientificLine): void;
  finish(): ScientificJob[];
}
/** Read-only nonterminal projection. EOF is not a native termination event. */
export interface ScientificParserSnapshot {
  readonly jobs: readonly ScientificJob[];
  readonly publishedByteEnd: number;
  readonly version: number;
}
export const SCIENTIFIC_NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[dDeE][+-]?\\d+)?';
export function scientificNumber(value: string): number | null {
  if (!new RegExp(`^${SCIENTIFIC_NUMBER}$`).test(value)) return null;
  const result = Number(value.replace(/[dD]/, 'e'));
  return Number.isFinite(result) ? result : null;
}
/** A source-print interval, never a fitted scientific agreement threshold. */
export function scientificRoundingInterval(token: string): number | undefined {
  if (scientificNumber(token) === null) return undefined;
  const [mantissa, exponent = '0'] = token.toLowerCase().replace('d', 'e').split('e');
  const decimals = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  const interval = .5 * 10 ** (Number(exponent) - decimals);
  return Number.isFinite(interval) && interval > 0 ? interval : undefined;
}
/** Shared read-time validation, also used by parser coordinate blocks. */
export function scientificAtom(element: string, coordinates: string[], index: number): Atom | null {
  const values = coordinates.map(scientificNumber);
  if (coordinates.length !== 3 || values.some(value => value === null)) return null;
  return { element, x: values[0]!, y: values[1]!, z: values[2]!, id: `a${index + 1}`, sourceIndex: index + 1 };
}
