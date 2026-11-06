import { elementSymbol } from '../core/elements';
import type { Atom, Structure } from '../core/types';
import { parseGaussianSource } from '../core/gaussian-source';
import { assertResultNotAborted, UnsupportedResultKindError, type ResultConvergence, type ResultFrameSummary, type ResultInputFile, type ResultReadOptions, type ResultStatus, type TrajectoryResult } from './contracts';
import { abortableResultRead } from './xyz-reader';
import { GaussianOutputArchive } from './gaussian-output-archive';

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[dDeE][+-]?\\d+)?';
const numeric = new RegExp(`^${NUMBER}$`);
const separator = /^\s*-{3,}\s*$/;

type Engine = 'gaussian' | 'orca';
type Target = 'scf' | 'mp2' | 'td' | 'final' | 'unknown';
interface Line { text: string; start: number; end: number; number: number }
interface Geometry { start: number; end: number; line: number; count: number; signature: string; orientation: string }
interface IndexedFrame extends ResultFrameSummary { geometry: Geometry }
interface Pending { geometry: Geometry; positions: number[]; step: number | null; energy: number | null; energySeen: boolean; convergence: ResultConvergence[]; label?: string }
interface Segment {
  jobIndex: number; segmentIndex: number; engine: Engine; route: string; charge: number | null; multiplicity: number | null;
  status: ResultStatus; frames: IndexedFrame[]; messages: string[];
  completeEligible: boolean;
}

function number(value: string): number | null {
  const parsed = Number(value.replace(/[dD]/, 'e'));
  return numeric.test(value) && Number.isFinite(parsed) ? parsed : null;
}
function row(line: string, engine: Engine, index: number): Atom | null {
  const fields = line.trim().split(/\s+/);
  let symbol: string, coordinates: string[];
  if (engine === 'gaussian') {
    if (fields.length !== 6 || Number(fields[0]) !== index + 1 || !/^\d+$/.test(fields[1]) || !/^[+-]?\d+$/.test(fields[2])) return null;
    symbol = fields[1]; coordinates = fields.slice(3);
  } else {
    if (fields.length !== 4) return null;
    symbol = fields[0]; coordinates = fields.slice(1);
  }
  const xyz = coordinates.map(number);
  if (xyz.some(value => value === null)) return null;
  let element: string;
  try { element = elementSymbol(symbol); } catch { return null; }
  return { element, x: xyz[0]!, y: xyz[1]!, z: xyz[2]!, sourceIndex: index + 1, id: `a${index + 1}` };
}

/** Streaming line splitter retaining byte offsets, including UTF-8 and CRLF across chunks. */
export async function* outputLines(file: ResultInputFile, options: ResultReadOptions, onNulTail?: (sourceLine: number) => void): AsyncGenerator<Line> {
  const reader = file.stream().getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  options.signal?.addEventListener('abort', abort, { once: true });
  let pending = new Uint8Array(0), offset = 0, lineNumber = 0, bytes = 0, nextYield = performance.now() + 16;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      assertResultNotAborted(options.signal);
      const { done, value } = await reader.read();
      assertResultNotAborted(options.signal);
      if (done) break;
      bytes += value.length;
      let chunk: Uint8Array;
      if (pending.length) { chunk = new Uint8Array(pending.length + value.length); chunk.set(pending); chunk.set(value, pending.length); }
      else chunk = value;
      let start = 0;
      for (let index = 0; index < chunk.length; index++) {
        if(onNulTail&&chunk[index]===0){onNulTail(lineNumber+1);return;}
        if(chunk[index]!==10)continue;
        const end = index > start && chunk[index - 1] === 13 ? index - 1 : index;
        yield { text: decoder.decode(chunk.subarray(start, end)).replace(/^\uFEFF/, ''), start: offset + start, end: offset + index + 1, number: ++lineNumber };
        start = index + 1;
        if (lineNumber % 1024 === 0 && performance.now() >= nextYield) { await new Promise<void>(resolve => setTimeout(resolve, 0)); assertResultNotAborted(options.signal); nextYield = performance.now() + 16; }
      }
      pending = chunk.slice(start); offset += start;
      options.onProgress?.(bytes, file.size);
    }
    if(onNulTail&&pending.includes(0)){onNulTail(lineNumber+1);return;}
    if (pending.length) yield { text: decoder.decode(pending).replace(/\r$/, ''), start: offset, end: offset + pending.length, number: ++lineNumber };
    if (bytes !== file.size) throw new Error('输出来源读取长度发生变化。');
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch { /* The source may already be closed. */ }
    reader.releaseLock();
  }
}

/** These routes have an unambiguous SCF target. Other methods keep null energies. */
const simpleMethod = /(?:^|[\s!#])(?:[ru]?hf|rohf|[ru]?(?:b3lyp|b3pw91|blyp|bp86|pbe0|pbe1pbe|pbepbe|pbe|m062x|m06-2x|m06|m06l|m06-l|m052x|m05-2x|tpss|tpssh|camb3lyp|cam-b3lyp|wb97xd|wb97x-d|wb97x|wb97m-v|b97d|b97-d|b97-3c|r2scan-3c|pbeh-3c|hf-3c|r2scan|scan|svwn|lsda))(?=\s|\/|$)/i;
function targetFor(route: string, engine: Engine): Target {
  if (/\b(?:oniom|external|casscf|caspt2|ccsd|cisd|cids|qcisd|mp3|mp4|doublehybrid|b2plyp|dsd-|dlpno|eom|sf-tda|rocis|nevpt2)\b/i.test(route)) return 'unknown';
  if (engine === 'gaussian') {
    if (/\b(?:td|cis)(?:\s|\(|=|\/|$)/i.test(route)) return /\btd(?:\s|\(|=|$)/i.test(route) ? 'td' : 'unknown';
    if (/(?:^|\s)[ru]?mp2(?=\s|\/|\(|$)/i.test(route)) return 'mp2';
    return simpleMethod.test(route) ? 'scf' : 'unknown';
  }
  if (/\b(?:tddft|tda|cis|iroot|esd|numgrad|numerical)\b/i.test(route)) return 'unknown';
  return simpleMethod.test(route) || /(?:^|\s)(?:ri-)?mp2(?=\s|$)/i.test(route) ? 'final' : 'unknown';
}

class OptimizationIndex {
  engine: Engine | null = null;
  segments: Segment[] = [];
  sawOpt = false;
  supportedAttempt = false;
  unsupportedAttempts = 0;
  private jobIndex = 0;
  private segmentIndex = 0;
  private route = '';
  private routeCapture = false;
  private outputArchive = new GaussianOutputArchive();
  private allowed = false;
  private target: Target = 'unknown';
  private expected: number | null = null;
  private charge: number | null = null;
  private multiplicity: number | null = null;
  private signature: string | null = null;
  private frames: IndexedFrame[] = [];
  private pending: Pending | null = null;
  private step: number | null = null;
  private cycleActive = false;
  private frequency = false;
  private optimized = false;
  private finalEvaluation = false;
  private finalEvaluationPending = false;
  private compoundArchiveStart: number | null = null;
  private terminated = false;
  private failed = false;
  private truncated = false;
  private messages = new Set<string>();
  private block: { stage: number; header: string; orientation: string; start: number; end: number; line: number; symbols: string[]; positions: number[]; bad: boolean } | null = null;
  private totalFrames = 0;

  private configure() {
    this.target = targetFor(this.route, this.engine!);
    this.allowed = this.engine === 'gaussian'
      ? /\bopt(?:\s|=|\(|$)/i.test(this.route) && !/\b(?:qst[23]|scan|irc|oniom|external)\b/i.test(this.route)
      : /(?:^|\s)(?:tightopt|verytightopt|looseopt|opt|optts)(?=\s|$)/i.test(this.route) && !/\b(?:neb|scan|irc|mecp|conical|cicalc|goat|md)\b/i.test(this.route);
    if (/\bopt(?:\s|=|\(|$)|\b(?:tightopt|optts|looseopt|verytightopt)\b/i.test(this.route)) this.sawOpt = true;
  }
  private flush() {
    if (!this.pending) return;
    const p = this.pending; this.pending = null;
    if (!this.allowed) return;
    this.totalFrames++;
    this.frames.push({ index: this.frames.length, sourceStep: p.step, time: null,
      energy: p.energy === null ? null : { value: p.energy, unit: 'hartree' }, convergence: p.convergence,
      sourceLine: p.geometry.line, geometry: p.geometry, ...(p.label ? { label: p.label } : {}) });
  }
  private archive() {
    if (this.allowed) this.supportedAttempt = true;
    const explicitlyUnsupported = !this.allowed && /\bopt(?:\s|=|\(|$)|\b(?:tightopt|optts|looseopt|verytightopt)\b/i.test(this.route);
    if (explicitlyUnsupported) this.unsupportedAttempts++;
    if (this.block) { this.truncated = true; this.block = null; }
    if (this.finalEvaluationPending) this.truncated = true;
    this.flush();
    if (this.frames.length && this.engine) {
      if (this.target === 'unknown') this.messages.add('当前方法的目标能量尚未可靠识别；能量保持空缺，不借用SCF参考能量。');
      if (this.frames.some(frame => frame.energy === null)) this.messages.add('部分步骤无已确认的目标能量，未补值。');
      if (this.truncated) this.messages.add('存在截断或无效坐标块；仅保留完整有效帧，未跨段借帧。');
      if (this.optimized) this.messages.add('检测到优化收敛标记；驻点性质仍需频率等独立证据。');
      else this.messages.add('未检测到此段优化收敛标记。');
      if (!this.terminated) this.messages.add('未检测到此作业正常终止；可能仍在运行或文件不完整。');
      if (this.failed) this.messages.add('检测到错误或优化失败标记。');
      this.segments.push({ jobIndex: this.jobIndex, segmentIndex: this.segmentIndex++, engine: this.engine, route: this.route,
        charge: this.charge, multiplicity: this.multiplicity, frames: this.frames,
        status: this.failed ? 'failed' : this.optimized && this.terminated && !this.truncated ? 'completed' : 'incomplete',
        completeEligible: this.optimized && !this.failed && !this.truncated, messages: [...this.messages] });
    } else if (this.sawOpt && (this.allowed || explicitlyUnsupported)) {
      const previous = this.segments.at(-1);
      previous?.messages.push(explicitlyUnsupported
        ? `后续作业（job ${this.jobIndex + 1}）的OPT路由不属于当前支持范围；前段结果不代表后续作业。`
        : `后续作业/电子态段（job ${this.jobIndex + 1}）没有完整OPT帧；未使用前段结构代替。`);
    }
    this.frames = []; this.pending = null; this.signature = null; this.step = null; this.cycleActive = false;
    this.frequency = false; this.optimized = false; this.terminated = false; this.failed = false; this.truncated = false; this.messages.clear();
    this.finalEvaluation = false; this.finalEvaluationPending = false;
  }
  private newJob(jobIndex = this.jobIndex + 1) {
    this.archive(); this.jobIndex = jobIndex; this.route = ''; this.routeCapture = false; this.allowed = false; this.target = 'unknown';
    this.expected = null; this.charge = null; this.multiplicity = null;
  }
  private acceptBlock() {
    const b = this.block; this.block = null;
    if (!b) return;
    if (b.bad || !b.symbols.length || (this.expected !== null && b.symbols.length !== this.expected)) { this.truncated = true; return; }
    const signature = b.symbols.join(',');
    if (this.signature && signature !== this.signature) {
      const step = this.step, cycleActive = this.cycleActive;
      this.messages.add('原子库存/顺序改变，已分成独立结果段。'); this.archive();
      this.step = step; this.cycleActive = cycleActive;
    }
    // Keep one immutable inventory string per segment instead of retaining a
    // newly joined copy in every frame's byte index.
    this.signature ??= signature;
    const geometry = { start: b.start, end: b.end, line: b.line, count: b.symbols.length, signature: this.signature, orientation: b.orientation };
    const pairedOrientation = this.pending?.geometry.orientation === 'Input' && b.orientation === 'Standard';
    const identicalGeometry = this.pending?.geometry.orientation === b.orientation && this.pending.positions.length === b.positions.length
      && this.pending.positions.every((value, index) => value === b.positions[index]);
    if (this.pending && !this.pending.energySeen && !this.pending.convergence.length && (pairedOrientation || identicalGeometry)) {
      // Only a known Input→Standard pair, or exactly equal coordinate tuples,
      // can coalesce before an energy evaluation. Different complete Standard
      // geometries remain observable even when energies/step markers are absent.
      if (pairedOrientation) { this.pending.geometry = geometry; this.pending.positions = b.positions; }
    } else {
      this.flush();
      this.pending = { geometry, positions: b.positions, step: this.step, energy: null, energySeen: false, convergence: [], ...(this.finalEvaluation ? { label: '最终驻点评估' } : {}) };
      this.step = null;
    }
  }
  private coordinateLine(line: Line): boolean {
    const b = this.block;
    if (!b) return false;
    if (this.engine === 'gaussian') {
      if (separator.test(line.text)) {
        if (b.stage < 3) { b.stage++; return true; }
        this.acceptBlock(); return true;
      }
      if (b.stage === 1) { if (line.text.trim()) { b.bad = true; this.acceptBlock(); return false; } return true; }
      if (b.stage === 2) { b.header += ' ' + line.text; return true; }
      if (!/Center/.test(b.header) || !/Atomic/.test(b.header) || !/Angstroms/i.test(b.header)) b.bad = true;
    } else {
      if (!line.text.trim() || separator.test(line.text)) { if (b.symbols.length) this.acceptBlock(); return true; }
    }
    const atom = row(line.text, this.engine!, b.symbols.length);
    if (!atom) { b.bad = true; this.acceptBlock(); return false; }
    if (!b.symbols.length) { b.start = line.start; b.line = line.number; }
    b.end = line.end; b.symbols.push(atom.element); b.positions.push(atom.x, atom.y, atom.z);
    return true;
  }

  consume(line: Line) {
    const text = line.text;
    if (!this.engine) {
      if (/Entering Gaussian System|Gaussian\s+(?:09|16)\b|Gaussian,\s*Inc\./i.test(text)) this.engine = 'gaussian';
      else if (/\bORCA\b|O\s+R\s+C\s+A/.test(text)) this.engine = 'orca';
      else { return; }
    }
    const g = this.engine === 'gaussian';
    if (g && this.outputArchive.consume(text)) return;
    const compound = !g ? text.match(/\bCOMPOUND JOB\s+(MainJOB|\d+)\s*$/i) : null;
    if (compound) {
      if (/MainJOB/i.test(compound[1])) this.compoundArchiveStart = this.segments.length;
      else this.newJob(Math.max(0, Number(compound[1]) - 1));
      return;
    }
    if ((g && /Link1:.*Proceeding to internal job step|--Link1--/.test(text)) || (!g && /\bJOB\s+NUMBER\s+\d+/i.test(text))) {
      if (this.route || this.frames.length || this.pending || this.block) this.newJob();
      return;
    }
    if ((g && /Entering Gaussian System/.test(text)) || (!g && /^\s*\*?\s*O\s+R\s+C\s+A\s*\*?\s*$/.test(text))) {
      if (this.frames.length || this.pending || this.route) this.newJob();
      if (!g) this.compoundArchiveStart = null;
    }
    if (this.coordinateLine(line)) return;
    if (g && this.route && this.terminated && /^\s*#[pnt]?(?:\s|$)/i.test(text)) this.newJob();
    if (g && !this.route && /^\s*#[pnt]?(?:\s|$)/i.test(text)) { this.route = text.trim(); this.routeCapture = true; this.configure(); return; }
    if (this.routeCapture) {
      if (!text.trim() || separator.test(text)) { this.routeCapture = false; this.configure(); }
      else { this.route += ' ' + text.trim(); this.configure(); return; }
    }
    if (!g) {
      const echo = text.replace(/^\s*\|\s*\d+>\s?/, '').trim();
      if (echo.startsWith('!')) { this.route += ' ' + echo; this.configure(); }
      if (/^%tddft\b|\biroot\s+\d+|^%casscf\b|^%md\b|^%neb\b|\bnumgrad\b/i.test(echo)) { this.route += ' ' + echo; this.configure(); }
    }
    const state = g ? text.match(/Charge\s*=\s*([+-]?\d+)\s+Multiplicity\s*=\s*(\d+)/) : null;
    const charge = !g ? text.match(/Total Charge\s*[.:]*\s*([+-]?\d+)/i) : null;
    const multiplicity = !g ? text.match(/Multiplicity\s*[.:]*\s*(\d+)/i) : null;
    if (state || charge || multiplicity) {
      const q = state ? Number(state[1]) : charge ? Number(charge[1]) : this.charge;
      const m = state ? Number(state[2]) : multiplicity ? Number(multiplicity[1]) : this.multiplicity;
      if ((q !== this.charge || m !== this.multiplicity) && (this.pending || this.frames.length)) {
        this.messages.add('电荷或自旋多重度改变，已分成独立结果段。'); this.archive(); this.expected = null;
      }
      this.charge = q; this.multiplicity = m;
    }
    const count = g ? text.match(/\bNAtoms\s*=\s*(\d+)/) : text.match(/(?:Number of atoms|# of atoms)\s*[.:]*\s*(\d+)/i);
    if (count) { this.expected = Number(count[1]); if (!Number.isSafeInteger(this.expected) || this.expected < 1) throw new Error('OPT原子数须为正安全整数。'); }
    if (/Error termination|ORCA finished by error termination|ORCA TERMINATED ABNORMALLY|SCF NOT CONVERGED|optimization (?:has )?(?:not converged|failed)|maximum number of (?:optimization )?cycles reached|Number of steps exceeded/i.test(text)) this.failed = true;
    if (/Normal termination of Gaussian|ORCA TERMINATED NORMALLY/.test(text)) {
      this.terminated = true;
      // ORCA compound emits one normal-termination marker for its entire sequence.
      // Apply it only to previously completed optimizer segments in this compound.
      if (!g && this.compoundArchiveStart !== null) for (const segment of this.segments.slice(this.compoundArchiveStart)) {
        if (segment.completeEligible) segment.status = 'completed';
        segment.messages = segment.messages.filter(message => !message.startsWith('未检测到此作业正常终止'));
        segment.messages.push('所属ORCA compound总流程正常终止；各段优化收敛状态仍独立。');
      }
    }
    if (/Optimization completed|THE OPTIMIZATION HAS CONVERGED/.test(text)) { this.flush(); this.optimized = true; }
    if (/Numerical (?:differentiation|frequencies|gradient|calculation of force constants)|Numerically calculating|NUMERICAL FREQUENCIES|NUMERICAL HESSIAN|VIBRATIONAL FREQUENCIES|Harmonic frequencies/i.test(text)) {
      this.flush(); this.frequency = true; this.messages.add('频率/数值位移段未作为优化步骤。');
    }
    if (!g && this.optimized && /FINAL ENERGY EVALUATION AT THE STATIONARY POINT/i.test(text)) {
      this.flush(); this.finalEvaluation = true; this.finalEvaluationPending = true; this.frequency = false; this.cycleActive = true; this.step = null;
      return;
    }
    if (this.optimized && !this.finalEvaluation) return;
    const cycle = !g ? text.match(/GEOMETRY OPTIMIZATION CYCLE\s+(\d+)/i) : null;
    if (cycle) {
      this.flush(); this.frequency = false; this.sawOpt = true;
      // A genuine optimizer banner establishes the route when an input echo is absent.
      if (!/\b(?:neb|scan|irc|mecp|conical|cicalc|goat|md)\b/i.test(this.route)) this.allowed = true;
      this.cycleActive = true; this.step = Number(cycle[1]); return;
    }
    const step = g ? text.match(/Step number\s+(\d+)\s+out of/i) : null;
    if (step) {
      this.frequency = false;
      const value = Number(step[1]);
      if (this.pending?.step !== null && this.pending?.step !== undefined && this.pending.step !== value) this.flush();
      if (this.pending) this.pending.step = value; else this.step = value;
    }
    if (!this.allowed || this.frequency) return;
    const orientation = g ? text.match(/^\s*(Standard|Input) orientation:\s*$/) : text.match(/CARTESIAN COORDINATES\s*\((?:ANGSTROEM|ANGSTROM)\)/i);
    if (orientation && (g || this.cycleActive)) {
      if (this.pending?.energySeen || this.pending?.convergence.length) this.flush();
      this.block = { stage: 1, header: '', orientation: g ? orientation[1] : 'Cartesian', start: 0, end: 0, line: line.number, symbols: [], positions: [], bad: false };
      return;
    }
    if (!this.pending) return;
    const energy = g ? text.match(new RegExp(`SCF Done:\\s+E\\([^)]*\\)\\s*=\\s*(${NUMBER})`)) : text.match(new RegExp(`FINAL SINGLE POINT ENERGY\\s+(${NUMBER})`));
    if (energy) {
      this.pending.energySeen = true;
      if (this.target === (g ? 'scf' : 'final') && !/not (?:fully )?converged/i.test(text)) this.pending.energy = number(energy[1]);
      if (this.finalEvaluation) {
        this.flush(); this.finalEvaluation = false; this.finalEvaluationPending = false;
        return;
      }
    }
    if (g && this.target === 'mp2') {
      const mp2 = text.match(new RegExp(`(?:EUMP2|E\\([RU]?MP2\\))\\s*=\\s*(${NUMBER})`, 'i'));
      if (mp2) { this.pending.energySeen = true; this.pending.energy = number(mp2[1]); }
    }
    if (g && this.target === 'td') {
      const td = text.match(new RegExp(`Total Energy,\\s*E\\(TD-(?:HF(?:/TD-KS)?|KS)\\)\\s*=\\s*(${NUMBER})`, 'i'));
      if (td) { this.pending.energySeen = true; this.pending.energy = number(td[1]); }
    }
    const convergence = text.match(new RegExp(`^\\s*(Maximum Force|RMS Force|Maximum Displacement|RMS Displacement|Energy change|RMS gradient|MAX gradient|RMS step|MAX step)\\s+(${NUMBER})\\s+(${NUMBER})\\s+(YES|NO)\\b`, 'i'));
    if (convergence && number(convergence[2]) !== null && number(convergence[3]) !== null) this.pending.convergence.push({ label: convergence[1], value: number(convergence[2])!, threshold: number(convergence[3]), converged: convergence[4].toUpperCase() === 'YES', unit: /energy/i.test(convergence[1]) ? 'hartree' : /force|gradient/i.test(convergence[1]) ? 'hartree/bohr' : 'bohr' });
  }
  finish() { this.archive(); return this.segments; }
}

/** OPT-only result reader. Retains a byte index and three geometries per result, never the complete output text. */
export async function readOptimizationResults(file: ResultInputFile, options: ResultReadOptions = {}): Promise<TrajectoryResult[]> {
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await file.close?.(); } };
  try {
    const parser = new OptimizationIndex();
    for await (const line of outputLines(file, options)) parser.consume(line);
    assertResultNotAborted(options.signal);
    const segments = parser.finish();
    if (!segments.length) {
      if (parser.unsupportedAttempts && !parser.supportedAttempt) throw new UnsupportedResultKindError('当前OPT路由不属于受支持的普通OPT/TS；QST、扫描、ONIOM或External只能按已有几何入口查看，不能冒称完整能量轨迹。');
      if (parser.sawOpt) throw new Error('检测到OPT但没有受支持的完整优化帧；仅支持普通OPT/TS的普通原子Å坐标，不跨job/电子态借帧。');
      await close(); return [];
    }
    let remaining = segments.length;
    const results: TrajectoryResult[] = [];
    for (const segment of segments) {
      let disposed = false;
      const lifetime = new AbortController();
      const cache = new Map<number, Structure>();
      const id = `${file.id}:opt:${segment.jobIndex}:${segment.segmentIndex}`;
      const sourceTemplate = segment.engine === 'gaussian' ? parseGaussianSource(segment.route, 'out', file.name, segment.jobIndex) : null;
      const getFrame = async (index: number, signal?: AbortSignal): Promise<Structure> => {
        assertResultNotAborted(signal);
        if (disposed || closed) throw new Error('结果文档已关闭。');
        if (!Number.isSafeInteger(index) || index < 0 || index >= segment.frames.length) throw new Error('OPT帧序号越界。');
        const cached = cache.get(index);
        if (cached) { cache.delete(index); cache.set(index, cached); return structuredClone(cached); }
        const geometry = segment.frames[index].geometry;
        const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
        const bytes = await abortableResultRead(readResultSourceRange(file, geometry.start, geometry.end, combined), combined);
        assertResultNotAborted(combined);
        if (disposed || closed) throw new Error('结果文档已关闭。');
        if (bytes.length !== geometry.end - geometry.start) throw new Error('来源OPT帧范围已截断或发生变化。');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const atoms: Atom[] = [];
        for (const line of text.trim().split(/\r?\n/)) {
          const atom = row(line, segment.engine, atoms.length);
          if (!atom) throw new Error('按需读取的坐标与已建立的OPT索引不一致。');
          atoms.push(atom);
        }
        if (atoms.length !== geometry.count || atoms.map(atom => atom.element).join(',') !== geometry.signature) throw new Error('源坐标库存已改变，不能继续使用旧索引。');
        const structure: Structure = { id: `${id}:frame:${index}`, name: `${file.name} · 帧 ${index + 1}`, format: segment.engine === 'gaussian' ? 'Gaussian OPT' : 'ORCA OPT', atoms,
          charge: segment.charge, multiplicity: segment.multiplicity, dimension: 3, sourceRoute: segment.route || undefined,
          notes: [`来源 ${file.name}，job ${segment.jobIndex + 1}，源行 ${geometry.line}；只读优化结果，未执行新计算。`] };
        if (sourceTemplate) {
          const source = structuredClone(sourceTemplate);
          source.id = `${id}:frame:${index}:source`; source.routeOverrides.sourceId = source.id;
          source.charge = segment.charge; source.multiplicity = segment.multiplicity;
          structure.gaussianSource = source;
          structure.notes.push('来源方法/基组与本job路由保留；所选帧不继承末帧收敛、频率、CHK或冻结/约束确认。');
        }
        cache.set(index, structure);
        while (cache.size > 3) cache.delete(cache.keys().next().value!);
        return structuredClone(structure);
      };
      const initialStructure = await getFrame(0, options.signal);
      const { engine, jobIndex, status, messages } = segment;
      results.push({ id, label: `${file.name} · ${engine === 'gaussian' ? 'Gaussian' : 'ORCA'} OPT · job ${jobIndex + 1}${segment.segmentIndex ? ` / 段 ${segment.segmentIndex + 1}` : ''}`,
        kind: 'optimization', engine, source: { id: file.id, name: file.name, size: file.size }, jobIndex, status, messages,
        frames: segment.frames.map(({ geometry: _geometry, ...summary }) => summary), initialStructure, getFrame,
        async dispose() { if (disposed) return; disposed = true; lifetime.abort(); cache.clear(); if (--remaining === 0) await close(); },
      });
    }
    return results;
  } catch (error) { await close(); throw error; }
}
import { readResultSourceRange } from './source-range';
