import type { Vector3 } from '../core/types';
import { assertResultNotAborted, type ResultInputFile } from './contracts';
import { scientificNumber, scientificRoundingInterval } from './scientific-contracts';
import type { CubeAtom, SurfaceFieldPrecision, SurfaceGrid, SurfaceLengthUnit, SurfaceScalarField, SurfaceValidDomain } from './surface-contracts';

/** Bounds on exact indexing. Allocation failures are reported separately. */
export const CUBE_READ_LIMITS = Object.freeze({ points: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER, atoms: Number.MAX_SAFE_INTEGER, line: Number.MAX_SAFE_INTEGER });
export class CubeReadError extends Error {
  constructor(readonly code: 'invalid' | 'truncated' | 'multiple-datasets' | 'ambiguous-unit' | 'limit', message: string) { super(message); this.name = 'CubeReadError'; }
}
export interface CubeReadOptions {
  /** Explicit source/user metadata is required for a nonstandard negative-axis
   * header: implementations disagree about its unit convention. No rescaling. */
  coordinateUnit?: SurfaceLengthUnit; coordinateUnitEvidence?: string;
  maxPoints?: number;
  /** Use one shared authoritative field where the renderer can borrow it. */
  sharedValues?: boolean;
}
export interface MolecularCubeHeader {
  comments: [string, string]; grid: SurfaceGrid; atoms: CubeAtom[];
  precision: SurfaceFieldPrecision; datasetId?: number; coordinateUnitEvidence: string;
}
export interface ParsedMolecularCube extends MolecularCubeHeader { values: Float64Array }
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

/** Only the header is line-oriented. Scalar fields can have arbitrary record widths. */
class CubeParser {
  private lineNumber = 0;
  private comments: [string, string] = ['', ''];
  private count = 0; private negativeAtoms = false;
  private origin: Vector3 = [0, 0, 0]; private originRounding: Vector3 = [0, 0, 0];
  private axes: Vector3[] = []; private axisRounding: Vector3[] = []; private signedDimensions: number[] = [];
  private atoms: CubeAtom[] = []; private atomRounding: Vector3[] = []; private nuclearRounding: number[] = [];
  private values: Float64Array | null = null; private points = 0; private filled = 0; private datasetId: number | undefined;
  private datasetPending = false; private datasetHeader = false; private unit: SurfaceLengthUnit = 'bohr';
  private pendingLine = ''; private pendingToken = ''; private skipLf = false;
  constructor(private options: CubeReadOptions) {
    if (options.maxPoints !== undefined && (!Number.isSafeInteger(options.maxPoints) || options.maxPoints < 1)) fail('limit', 'Cube点数预算须为可精确表示的正整数。');
    if (options.coordinateUnit && (!['bohr', 'angstrom'].includes(options.coordinateUnit) || !options.coordinateUnitEvidence?.trim())) fail('ambiguous-unit', '显式Cube空间单位需要来源依据。');
  }
  get headerComplete() { return this.count > 0 && this.atoms.length === this.count && !this.datasetPending; }
  private get atData() { return this.count > 0 && this.atoms.length === this.count; }
  private headerLine(raw: string): void {
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
        this.points = points;
      }
      return;
    }
    if (tokens.length !== 5) fail('invalid', 'Cube逐原子行须含原子序数、有效核电荷及三个坐标。');
    const z = integer(tokens[0]); if (z < 1 || z > 118) fail('invalid', '本期Cube不支持ghost/dummy或未知元素。');
    this.atoms.push({ sourceIndex: this.atoms.length + 1, atomicNumber: z, nuclearCharge: number(tokens[1]), position: vector(tokens.slice(2)) });
    this.atomRounding.push(rounding(tokens.slice(2))); this.nuclearRounding.push(scientificRoundingInterval(tokens[1]) ?? 0);
    this.datasetPending = this.atoms.length === this.count && this.negativeAtoms;
  }
  private scalar(token: string): void {
    if (this.datasetPending) {
      if (!this.datasetHeader) {
        if (integer(token) !== 1) fail('multiple-datasets', 'Cube声明多个数据集；本期不自动选择第一组。');
        this.datasetHeader = true;
      } else {
        this.datasetId = integer(token);
        this.datasetPending = false;
      }
      return;
    }
    if (this.filled >= this.points) fail('invalid', 'Cube数值多于网格声明，可能含未支持的数据集或尾部字段。');
    if (!this.values) {
      try { this.values = this.options.sharedValues && typeof SharedArrayBuffer === 'function'
        ? new Float64Array(new SharedArrayBuffer(this.points*Float64Array.BYTES_PER_ELEMENT)) : new Float64Array(this.points); }
      catch (error) { if (!(error instanceof RangeError)) throw error; fail('limit', '无法分配完整精度的 Cube 数组，原始来源仍保留。'); }
    }
    this.values![this.filled++] = number(token);
  }
  push(part: string, headerOnly: boolean, final = false): void {
    if (!this.atData) {
      if (this.skipLf && part.length) { if (part.startsWith('\n')) part = part.slice(1); this.skipLf = false; }
      const lineEnd = /\r\n|[\r\n]/g;
      while (!this.atData) {
        const start = lineEnd.lastIndex, end = lineEnd.exec(part);
        if (!end) {
          this.pendingLine += part.slice(start);
          if (final && this.pendingLine) this.headerLine(this.pendingLine);
          return;
        }
        this.headerLine(this.pendingLine + part.slice(start, end.index));
        this.pendingLine = '';
        if (end[0] === '\r' && lineEnd.lastIndex === part.length) this.skipLf = true;
      }
      part = part.slice(lineEnd.lastIndex);
    }
    if (headerOnly && this.headerComplete) return;
    const text = this.pendingToken + part, tokens = /\S+/g;
    this.pendingToken = '';
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(text)) !== null) {
      if (!final && tokens.lastIndex === text.length) { this.pendingToken = match[0]; break; }
      this.scalar(match[0]);
      if (headerOnly && this.headerComplete) return;
    }
  }
  header(): MolecularCubeHeader {
    if (!this.headerComplete) return fail('truncated', 'Cube头部或原子记录截断。');
    return { comments: this.comments, grid: { coordinateUnit: this.unit, origin: this.origin, axes: this.axes as SurfaceGrid['axes'], dimensions: this.signedDimensions.map(Math.abs) as SurfaceGrid['dimensions'], ordering: 'z-fastest' },
      atoms: this.atoms, precision: { origin: this.originRounding, axes: this.axisRounding as SurfaceGrid['axes'], atomCoordinates: this.atomRounding, nuclearCharges: this.nuclearRounding },
      ...(this.datasetId === undefined ? {} : { datasetId: this.datasetId }), coordinateUnitEvidence: this.options.coordinateUnitEvidence ?? 'Gaussian-style Cube on-disk atomic-coordinate convention (Bohr)' };
  }
  finish(): ParsedMolecularCube {
    const header = this.header();
    if (!this.values || this.filled !== this.points) return fail('truncated', 'Cube标量数据截断；未补零。');
    return { ...header, values: this.values };
  }
}
export function parseMolecularCube(text: string, options: CubeReadOptions = {}): ParsedMolecularCube {
  const parser = new CubeParser(options);
  parser.push(text, false, true);
  return parser.finish();
}
export interface DisplayCubeRead { text: string; bytes: number; keepOriginal: boolean }
export interface DisplayCubeData { parsed: ParsedMolecularCube; originalBytes?: Uint8Array }
/** Keep the exact UTF-8 payload for project archival when the file is new. */
export function parseDisplayCube({text, bytes, keepOriginal}: DisplayCubeRead): DisplayCubeData {
  const originalBytes = new TextEncoder().encode(text);
  if (originalBytes.byteLength !== bytes) fail('invalid', 'Cube快照字节数与可信来源不符。');
  return { parsed: parseMolecularCube(text), ...(keepOriginal ? {originalBytes} : {}) };
}
type CubeStreamSource = Pick<ResultInputFile, 'size' | 'stream'>;
export type CubeStreamOptions = CubeReadOptions & { signal?: AbortSignal; yieldToHost?: boolean };
async function readCubeParser(file: CubeStreamSource, options: CubeStreamOptions, headerOnly: boolean): Promise<CubeParser> {
  assertResultNotAborted(options.signal);
  if (!Number.isSafeInteger(file.size) || file.size < 1) fail('limit', 'Cube文件须非空且字节数可精确表示。');
  const parser = new CubeParser(options), reader = file.stream().getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, complete = false, lastYield = performance.now();
  const abort = () => { void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      assertResultNotAborted(options.signal);
      const next = await reader.read(); assertResultNotAborted(options.signal);
      if (next.done) { complete = true; parser.push(decoder.decode(), headerOnly, true); break; }
      bytes += next.value.byteLength; if (bytes > file.size) fail('invalid', 'Cube来源超过声明字节数。');
      for (let offset = 0; offset < next.value.length; offset += 65536) {
        parser.push(decoder.decode(next.value.subarray(offset, offset + 65536), { stream: true }), headerOnly);
        if (headerOnly && parser.headerComplete) return parser;
        if (options.yieldToHost && performance.now() - lastYield >= 10) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          assertResultNotAborted(options.signal);
          lastYield = performance.now();
        }
      }
    }
    if (bytes !== file.size) fail('invalid', 'Cube来源大小与导入时声明不一致。');
    return parser;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function readMolecularCube(file: CubeStreamSource, options: CubeStreamOptions = {}): Promise<ParsedMolecularCube> {
  return (await readCubeParser(file, options, false)).finish();
}
/** Verify just the molecular header. The scalar data may be unavailable or
 * incomplete; callers must never claim a usable field from this result. */
export async function readMolecularCubeHeader(file: CubeStreamSource, options: CubeStreamOptions = {}): Promise<MolecularCubeHeader> {
  return (await readCubeParser(file, options, true)).header();
}
/** Binding metadata is explicit; comments and filename do not define a field's
 * physical quantity, producer, electronic state or valid calculation domain. */
export interface KnownCubeDomain { sourceRevision: string; validDomain: SurfaceValidDomain; coordinateUnit?: SurfaceLengthUnit }
export function molecularCubeField(parsed: ParsedMolecularCube, metadata: Omit<SurfaceScalarField, 'grid' | 'atoms' | 'values' | 'precision'>, knownDomain?: KnownCubeDomain): SurfaceScalarField {
  if (knownDomain && knownDomain.sourceRevision !== metadata.source.revision) throw new Error('已知Cube有效域记录与本次内容身份不一致。');
  // An owner that recognizes an exported/reimported content revision must pass
  // its retained restriction; new slot metadata cannot elevate it to full-grid.
  return { ...metadata, ...(knownDomain ? { validDomain: knownDomain.validDomain } : {}), source: { ...metadata.source, comments: parsed.comments, ...(parsed.datasetId === undefined ? {} : { datasetId: parsed.datasetId }) }, grid: parsed.grid, atoms: parsed.atoms, values: parsed.values, precision: parsed.precision };
}
