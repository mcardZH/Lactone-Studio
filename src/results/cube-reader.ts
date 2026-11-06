import type { Vector3 } from '../core/types';
import { assertResultNotAborted, type ResultInputFile } from './contracts';
import { scientificNumber, scientificRoundingInterval } from './scientific-contracts';
import type { CubeAtom, SurfaceFieldPrecision, SurfaceGrid, SurfaceLengthUnit, SurfaceScalarField, SurfaceValidDomain } from './surface-contracts';

/** Same point/export ceilings as the existing desktop field transport. The
 * owner must still check its actual live memory/render budget before accepting. */
export const CUBE_READ_LIMITS = Object.freeze({ points: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, atoms: Number.MAX_SAFE_INTEGER, line: Number.MAX_SAFE_INTEGER });
export class CubeReadError extends Error {
  constructor(readonly code: 'invalid' | 'truncated' | 'multiple-datasets' | 'ambiguous-unit' | 'limit', message: string) { super(message); this.name = 'CubeReadError'; }
}
export interface CubeReadOptions {
  /** Explicit source/user metadata is required for a nonstandard negative-axis
   * header: implementations disagree about its unit convention. No rescaling. */
  coordinateUnit?: SurfaceLengthUnit; coordinateUnitEvidence?: string;
  maxPoints?: number;
}
export interface ParsedMolecularCube {
  comments: [string, string]; grid: SurfaceGrid; atoms: CubeAtom[]; values: Float64Array;
  precision: SurfaceFieldPrecision; datasetId?: number; coordinateUnitEvidence: string;
}
const fail = (code: CubeReadError['code'], message: string): never => { throw new CubeReadError(code, message); };
function integer(token: string): number {
  if (!/^[+-]?\d+$/.test(token)) return fail('invalid', 'Cube整数头字段无效。');
  const value = Number(token); if (!Number.isSafeInteger(value)) return fail('invalid', 'Cube整数头字段超出安全范围。');
  return value;
}
function number(token: string): number {
  const value = scientificNumber(token);
  if (value === null || value === 0 && /[1-9]/.test(token.split(/[dDeE]/)[0])) return fail('invalid', 'Cube含非有限、下溢或无效数值。');
  return value;
}
function vector(tokens: string[]): Vector3 { return tokens.map(number) as Vector3; }
function rounding(tokens: string[]): Vector3 { return tokens.map(token => scientificRoundingInterval(token) ?? 0) as Vector3; }
const det = (axes: readonly Vector3[]) => axes[0][0] * (axes[1][1] * axes[2][2] - axes[1][2] * axes[2][1]) - axes[0][1] * (axes[1][0] * axes[2][2] - axes[1][2] * axes[2][0]) + axes[0][2] * (axes[1][0] * axes[2][1] - axes[1][1] * axes[2][0]);

/** Streaming line consumer shared by text and file APIs. Values are never
 * reordered, converted, padded or silently reduced to the first dataset. */
class CubeParser {
  private lineNumber = 0;
  private comments: [string, string] = ['', ''];
  private count = 0; private negativeAtoms = false;
  private origin: Vector3 = [0, 0, 0]; private originRounding: Vector3 = [0, 0, 0];
  private axes: Vector3[] = []; private axisRounding: Vector3[] = []; private signedDimensions: number[] = [];
  private atoms: CubeAtom[] = []; private atomRounding: Vector3[] = []; private nuclearRounding: number[] = [];
  private values: Float64Array | null = null; private filled = 0; private datasetId: number | undefined;
  private datasetPending = false; private datasetHeader = false; private unit: SurfaceLengthUnit = 'bohr';
  constructor(private options: CubeReadOptions) {
    if (options.maxPoints !== undefined && (!Number.isSafeInteger(options.maxPoints) || options.maxPoints < 1)) fail('limit', 'Cube点数预算须为可精确表示的正整数。');
    if (options.coordinateUnit && (!['bohr', 'angstrom'].includes(options.coordinateUnit) || !options.coordinateUnitEvidence?.trim())) fail('ambiguous-unit', '显式Cube空间单位需要来源依据。');
  }
  consume(raw: string): void {
    if (raw.length > CUBE_READ_LIMITS.line) fail('limit', 'Cube单行超过整数表示范围。');
    this.lineNumber++;
    if (this.lineNumber <= 2) { this.comments[this.lineNumber - 1] = raw.replace(/^\uFEFF/, ''); return; }
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    if (!this.count) {
      if (tokens.length !== 4 && tokens.length !== 5) fail('invalid', 'Cube原子数/原点头布局未支持。');
      const declared = integer(tokens[0]); this.count = Math.abs(declared); this.negativeAtoms = declared < 0;
      if (!this.count || this.count > CUBE_READ_LIMITS.atoms) fail('limit', '分子Cube须含真实原子且数量可精确表示。');
      if (tokens[4] !== undefined && integer(tokens[4]) !== 1) fail('multiple-datasets', 'Cube每点含多个数值；本期不选择第一组冒单标量。');
      this.origin = vector(tokens.slice(1, 4)); this.originRounding = rounding(tokens.slice(1, 4)); return;
    }
    if (this.axes.length < 3) {
      if (tokens.length !== 4) fail('invalid', 'Cube仿射步进向量头无效。');
      const dimension = integer(tokens[0]); if (!dimension) fail('invalid', 'Cube方向点数不能为0。');
      this.signedDimensions.push(dimension); this.axes.push(vector(tokens.slice(1))); this.axisRounding.push(rounding(tokens.slice(1)));
      if (this.axes.length === 3) {
        const signs = new Set(this.signedDimensions.map(Math.sign));
        if (signs.size !== 1) fail('ambiguous-unit', 'Cube各方向计数符号冲突；未猜空间单位。');
        if (this.signedDimensions[0] < 0 && !this.options.coordinateUnit) fail('ambiguous-unit', '负方向计数的Cube单位存在格式差异；请明确来源单位。');
        this.unit = this.options.coordinateUnit ?? 'bohr';
        const normalized = this.axes.map(axis => { const norm = Math.hypot(...axis); return axis.map(value => value / norm) as Vector3; });
        if (!normalized.flat().every(Number.isFinite) || det(normalized) === 0) fail('invalid', 'Cube网格仿射矩阵退化。');
        const points = this.signedDimensions.reduce((product, count) => product * Math.abs(count), 1);
        if (!Number.isSafeInteger(points) || points > (this.options.maxPoints ?? CUBE_READ_LIMITS.points)) fail('limit', 'Cube点数超出本次预算或现有传输上限。');
        this.values = new Float64Array(points);
      }
      return;
    }
    if (this.atoms.length < this.count) {
      if (tokens.length !== 5) fail('invalid', 'Cube逐原子行须含原子序数、有效核电荷及三个坐标。');
      const z = integer(tokens[0]); if (z < 1 || z > 118) fail('invalid', '本期Cube不支持ghost/dummy或未知元素。');
      this.atoms.push({ sourceIndex: this.atoms.length + 1, atomicNumber: z, nuclearCharge: number(tokens[1]), position: vector(tokens.slice(2)) });
      this.atomRounding.push(rounding(tokens.slice(2))); this.nuclearRounding.push(scientificRoundingInterval(tokens[1]) ?? 0);
      this.datasetPending = this.atoms.length === this.count && this.negativeAtoms;
      return;
    }
    let data = tokens;
    if (this.datasetPending) {
      if (!this.datasetHeader) {
        if (integer(data[0]) !== 1) fail('multiple-datasets', 'Cube声明多个数据集；本期不自动选择第一组。');
        this.datasetHeader = true; data = data.slice(1);
      }
      if (!data.length) return;
      this.datasetId = integer(data[0]); this.datasetPending = false; data = data.slice(1);
    }
    for (const token of data) {
      if (this.filled >= this.values!.length) fail('invalid', 'Cube数值多于网格声明，可能含未支持的数据集或尾部字段。');
      this.values![this.filled++] = number(token);
    }
  }
  finish(): ParsedMolecularCube {
    if (!this.values || this.atoms.length !== this.count || this.datasetPending || this.filled !== this.values.length) return fail('truncated', 'Cube头部、原子或标量数据截断；未补零。');
    return { comments: this.comments, grid: { coordinateUnit: this.unit, origin: this.origin, axes: this.axes as SurfaceGrid['axes'], dimensions: this.signedDimensions.map(Math.abs) as SurfaceGrid['dimensions'], ordering: 'z-fastest' },
      atoms: this.atoms, values: this.values, precision: { origin: this.originRounding, axes: this.axisRounding as SurfaceGrid['axes'], atomCoordinates: this.atomRounding, nuclearCharges: this.nuclearRounding },
      ...(this.datasetId === undefined ? {} : { datasetId: this.datasetId }), coordinateUnitEvidence: this.options.coordinateUnitEvidence ?? 'Gaussian-style Cube on-disk atomic-coordinate convention (Bohr)' };
  }
}
export function parseMolecularCube(text: string, options: CubeReadOptions = {}): ParsedMolecularCube {
  if (text.length > CUBE_READ_LIMITS.bytes) fail('limit', 'Cube文本超过128 MiB读取上限。');
  const parser = new CubeParser(options);
  for (const line of text.split(/\r\n|\r|\n/)) parser.consume(line);
  return parser.finish();
}
export async function readMolecularCube(file: ResultInputFile, options: CubeReadOptions & { signal?: AbortSignal } = {}): Promise<ParsedMolecularCube> {
  assertResultNotAborted(options.signal);
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > CUBE_READ_LIMITS.bytes) fail('limit', 'Cube文件须非空且不超过128 MiB。');
  const parser = new CubeParser(options), reader = file.stream().getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', bytes = 0, complete = false, skipLf = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      assertResultNotAborted(options.signal);
      const next = await reader.read(); assertResultNotAborted(options.signal);
      if (next.done) { complete = true; pending += decoder.decode(); break; }
      bytes += next.value.byteLength; if (bytes > CUBE_READ_LIMITS.bytes) fail('limit', 'Cube来源读取中超限。');
      for (let offset = 0; offset < next.value.length; offset += 65536) {
        let part = decoder.decode(next.value.subarray(offset, offset + 65536), { stream: true });
        if (skipLf && part.length) { if (part.startsWith('\n')) part = part.slice(1); skipLf = false; }
        pending += part; let end: number;
        while ((end = pending.search(/[\r\n]/)) >= 0) {
          const cr = pending[end] === '\r'; parser.consume(pending.slice(0, end)); pending = pending.slice(end + 1);
          if (cr) { if (pending.startsWith('\n')) pending = pending.slice(1); else if (!pending.length) skipLf = true; }
        }
        if (pending.length > CUBE_READ_LIMITS.line) fail('limit', 'Cube单行超过1 MiB读取上限。');
      }
    }
    if (pending) parser.consume(pending);
    if (bytes !== file.size) fail('invalid', 'Cube来源大小与导入时声明不一致。');
    return parser.finish();
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Binding metadata is explicit; comments and filename do not define a field's
 * physical quantity, producer, electronic state or valid calculation domain. */
export interface KnownCubeDomain { sourceRevision: string; validDomain: SurfaceValidDomain }
export function molecularCubeField(parsed: ParsedMolecularCube, metadata: Omit<SurfaceScalarField, 'grid' | 'atoms' | 'values' | 'precision'>, knownDomain?: KnownCubeDomain): SurfaceScalarField {
  if (knownDomain && knownDomain.sourceRevision !== metadata.source.revision) throw new Error('已知Cube有效域记录与本次内容身份不一致。');
  // An owner that recognizes an exported/reimported content revision must pass
  // its retained restriction; new slot metadata cannot elevate it to full-grid.
  return { ...metadata, ...(knownDomain ? { validDomain: knownDomain.validDomain } : {}), source: { ...metadata.source, comments: parsed.comments, ...(parsed.datasetId === undefined ? {} : { datasetId: parsed.datasetId }) }, grid: parsed.grid, atoms: parsed.atoms, values: parsed.values, precision: parsed.precision };
}
