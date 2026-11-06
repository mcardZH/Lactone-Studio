import type { Structure } from '../core/types';
import type { ScientificData } from './scientific-contracts';

/** Read-only source. Ranges are UTF-8 byte offsets, never JS character offsets. */
export interface ResultInputFile {
  id: string;
  name: string;
  size: number;
  /** Both readRange and actual underlying stream reads are observed here.
   * Wrappers replacing those methods must clear this marker unless preserved. */
  readonly readTrace?: 'source-boundary';
  stream(): ReadableStream<Uint8Array>;
  readRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Optional host-issued identity of the owned OUT; never a filesystem path. */
  readCompanionSourceToken?(signal?: AbortSignal): Promise<string | undefined>;
  /** Content SHA from the owned source; this is never a filename revision. */
  readCompanionSourceDescriptor?(signal?: AbortSignal): Promise<{ token: string; name: string; size: number; revision: string } | undefined>;
  close?(): void | Promise<void>;
}
export interface ResultQuantity { value: number; unit: string }
export interface ResultSourceAnchor { id: string; name: string; line: number }
/** An observation and its own source/iteration, independently of displayed geometry. */
export interface ResultEnergyObservation {
  kind: 'xyz-comment' | 'neb-log' | 'neb-interpolation' | 'output-summary';
  value: number; rawValue: string; unit?: string; rawUnit?: string; relative?: boolean;
  quantity?: 'electronic' | 'potential' | 'kinetic' | 'total';
  source: ResultSourceAnchor; iteration?: number; image?: number;
  association?: 'energy-vector' | 'native-table' | 'unresolved';
  origin?: 'observation' | 'derived';
  raw?: string;
  placeholder?: boolean;
}
/** Scientific process dimensions are independent of the visible frame ordinal. */
export type ResultStageKind = 'optimization' | 'scan-points' | 'scan-optimization' | 'irc' | 'neb-path' | 'ts-optimization' | 'frequency' | 'trajectory';
export type ResultFileRole = 'main-output' | 'single-structure' | 'optimization-trajectory' | 'scan-point-set' | 'irc-full' | 'irc-branch' | 'neb-path' | 'neb-iterations' | 'ts-optimization-trajectory' | 'md-trajectory' | 'md-log' | 'md-statistics' | 'md-restart' | 'unknown';
export interface ResultStage {
  id: string; kind: ResultStageKind; label: string;
  /** Original zero-based frame indices; never combine distinct path iterations. */
  frameIndices: readonly number[];
  sourceIteration?: number;
  tsFrameIndex?: number;
  /** Only a source-proven climbing image in this exact band/iteration. */
  ciFrameIndex?: number;
}
export interface ResultConvergence {
  label: string;
  value: number;
  threshold: number | null;
  converged: boolean | null;
  unit: string | null;
}
export interface ResultFrameSummary {
  /** Original geometry asset/frame, including projections assembled from multiple native files. */
  geometrySource?: { id: string; name: string; sourceFrameIndex: number; sourceLine: number };
  /** Half the last printed coordinate digit, in Å, for this source geometry. */
  coordinateRoundingAngstrom?: number;
  index: number;
  sourceStep: number | null;
  time: ResultQuantity | null;
  energy: ResultQuantity | null;
  /** MD potential is not the total (potential+kinetic) energy or an SCF target. */
  energyQuantity?: 'electronic' | 'potential';
  /** Legacy observation not admitted as geometry-bound energy; independently
   * evidenced units/associations are retained in energyObservations. */
  unqualifiedEnergy?: number;
  energyObservations?: ResultEnergyObservation[];
  /** Only populated when energy belongs to this exact native geometry iteration/image. */
  energyAssociation?: { iteration: number; image: number; source: ResultSourceAnchor; relativeSourceConflict?: boolean };
  geometryAssociation?: { iteration: number; image: number; source: ResultSourceAnchor; evidenceSource: ResultSourceAnchor; evidence: 'native-arc-distances'; maximumResidualBohr: number; boundBohr: number };
  sourcePathImage?: number;
  /** Explicit native <= CI marker, bound to this geometry's band/iteration. */
  climbingImage?:{iteration:number;image:number;imageBase:0|1;source:ResultSourceAnchor};
  convergence: ResultConvergence[];
  sourceLine: number;
  label?: string;
  coordinate?: { value: number; unit: string; label: string; sourceValue?: number };
  pathDirection?: 'forward' | 'reverse' | 'ts';
  /** Native point/node number, distinct from an inner geometry-optimization step. */
  pathNode?: number;
  stageId?: string;
  pathIteration?: number;
  pathImage?: number;
  /** Explicitly saved/accepted outer path point, not an unfinished inner step. */
  pathPoint?: boolean;
  /** Native source frame ordinal retained after a stage projects its frames. */
  sourceFrameIndex?: number;
}
export type ResultStatus = 'completed' | 'incomplete' | 'failed' | 'unknown';
export interface TrajectoryResult {
  id: string;
  label: string;
  kind: 'trajectory' | 'optimization' | 'collection' | 'calculation';
  engine: 'xyz' | 'gaussian' | 'orca' | 'structure';
  source: { id: string; name: string; size: number; sha256?: string; software?: 'gaussian' | 'orca' | 'cp2k' | 'xtb' | 'unknown'; nativeJobName?: string };
  jobIndex: number;
  status: ResultStatus;
  messages: string[];
  scientific?: ScientificData;
  /** Other jobs in the same file that have no ordinary geometry. Plain data,
   * preserved by geometry-only consumers and project snapshots. */
  fileDiagnostics?: readonly ResultDiagnosticSnapshot[];
  role?: ResultFileRole;
  stages?: readonly ResultStage[];
  frames: readonly ResultFrameSummary[];
  /** Complete first frame for display initialization, not a mutable working model. */
  initialStructure: Structure;
  getFrame(index: number, signal?: AbortSignal): Promise<Structure>;
  dispose(): void | Promise<void>;
}
/** File/job evidence without a usable ordinary geometry. Never a zero-atom model. */
export interface ResultDiagnostic {
  kind: 'diagnostic'; id: string; label: string;
  engine: 'gaussian' | 'orca' | 'unknown';
  source: TrajectoryResult['source']; jobIndex: number | null; segmentIndex: number;
  jobAssociation?: { outputSourceId: string; jobIndex: number; evidence: string[] };
  sourceRole?: 'input' | 'output' | 'auxiliary';
  charge: number | null; multiplicity: number | null;
  status: ResultStatus; messages: string[]; scientific: ScientificData;
  /** Original bytes remain independently readable until this diagnostic releases its lease. */
  readSourceRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  dispose(): void | Promise<void>;
}
export type ResultDiagnosticSnapshot = Omit<ResultDiagnostic, 'dispose' | 'readSourceRange'>;
export interface ScientificFileResults {
  results: TrajectoryResult[]; diagnostics: ResultDiagnostic[];
}
/** Geometry-only consumers must not silently discard file-level evidence. */
export class ScientificDiagnosticError extends Error {
  readonly code = 'scientific-file-diagnostic';
  constructor(readonly diagnostics: readonly ResultDiagnostic[]) {
    super(diagnostics.map(item => `${item.label}：${item.messages.join('；') || '没有完整普通原子结构，已保留文件级诊断。'}`).join('\n'));
    this.name = 'ScientificDiagnosticError';
  }
}
export interface ResultReadOptions {
  signal?: AbortSignal;
  onProgress?(bytesRead: number, totalBytes: number): void;
  /** Geometry-only compatibility readers await this once before releasing
   * diagnostic source leases. Explicit file-result readers return ownership. */
  onDiagnostics?(items: readonly ResultDiagnostic[]): Promise<void> | void;
}
/** Only this explicit capability outcome permits the legacy geometry fallback. */
export class UnsupportedResultKindError extends Error {
  readonly code = 'unsupported-result-kind';
  constructor(message: string) { super(message); this.name = 'UnsupportedResultKindError'; }
}
export interface TrajectoryRange { start: number; end: number; stride: number }
/** start/end are zero-based inclusive. Direction follows start to end. */
export function trajectoryIndices(range: TrajectoryRange, frameCount: number): number[] {
  const { start, end, stride } = range;
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || ![start,end,stride].every(Number.isSafeInteger)
      || start < 0 || end < 0 || start >= frameCount || end >= frameCount || stride < 1) {
    throw new Error('帧范围或步距无效。');
  }
  const direction = end >= start ? 1 : -1;
  const indices: number[] = [];
  for (let index = start; direction > 0 ? index <= end : index >= end; index += direction * stride) indices.push(index);
  return indices;
}
export function assertResultNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('读取或导出已取消。', 'AbortError');
}
