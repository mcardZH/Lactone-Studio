import { assertResultNotAborted, type ResultInputFile, type ResultReadOptions } from './contracts';
import { CompleteByteLines, resultTextEncoding, type DamagedText, type ResultTextEncoding } from './byte-text-lines';
import { gaussianErrorTermination, GaussianOutputSections } from './gaussian-output-archive';
import { orcaOutputComment, orcaOutputEcho, outputSoftwareOnLine, type OutputSoftware } from './output-sections';
export { outputSoftwareOnLine } from './output-sections';

export const SOURCE_RECOGNITION_BYTES = 1024 * 1024;
export type SourceSoftware = 'gaussian' | 'orca' | 'cp2k' | 'xtb' | 'unknown';
export type SourceFormat = 'output' | 'xyz' | 'pdb' | 'fchk' | 'molden' | 'hess' | 'cif' | 'unknown';
export interface SourceRecognition {
  format: SourceFormat;
  software: SourceSoftware;
  status: 'recognized' | 'unknown' | 'conflict';
  evidence: { kind: string; line: number }[];
  encoding?: ResultTextEncoding;
  message?: string;
}
type Line = { text: string; number: number };
const numeric = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[EeDd][+-]?\\d+)?';
const coordinateToken = new RegExp('^' + numeric + '$');
function matchesXyzRow(row: string, comment: string | undefined): boolean {
  const schema = comment?.match(/\bProperties\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/i);
  if (!schema) return /^\s*(?:[A-Z][a-z]?|\d+)\s+[+-]?(?:\d|\.)/i.test(row);
  const columns = (schema[1] ?? schema[2] ?? schema[3]).split(':'), fields = row.trim().split(/\s+/);
  let species = -1, position = -1, width = 0;
  if (columns.length % 3) return false;
  for (let i = 0; i < columns.length; i += 3) {
    const count = Number(columns[i + 2]);
    if (!Number.isSafeInteger(count) || count < 1) return false;
    if (columns[i] === 'species' && columns[i + 1] === 'S' && count === 1) species = width;
    if (columns[i] === 'pos' && columns[i + 1] === 'R' && count === 3) position = width;
    width += count;
  }
  return fields.length === width && species !== -1 && position !== -1 && /^(?:[A-Z][a-z]?|\d+)$/i.test(fields[species])
    && fields.slice(position, position + 3).every(value => coordinateToken.test(value));
}
const echoAtom = new RegExp(`^[A-Z][a-z]?\\s+${numeric}\\s+${numeric}\\s+${numeric}\\s*$`);
const gaussianGeometry = /\b(?:Standard|Input|Z-Matrix) orientation:/;
const orcaGeometry = /CARTESIAN COORDINATES\s*\((?:ANGSTROEM|ANGSTROM)\)/i;
const gaussianAtom = /^\s*\d+\s+\d+\s+\d+\s+[+\-\d.eEdD]+\s+[+\-\d.eEdD]+\s+[+\-\d.eEdD]+\s*$/;
const orcaAtom = /^\s*[A-Z][a-z]?\s+[+\-\d.eEdD]+\s+[+\-\d.eEdD]+\s+[+\-\d.eEdD]+\s*$/;

/** Only completed engine evidence can authorize a text prefix ending in damage. */
class OutputPrefix {
  private gaussianTable?: { header: number; rows: number };
  private orcaTable?: { header: number; rows: number };
  private gaussian = false;
  private orca = false;
  private echoAtoms: number | undefined;
  private completeEcho = false;
  private orcaExecuted = false;

  echo(text: string) {
    const echo = orcaOutputEcho(text)?.split('#', 1)[0].trim();
    if (echo === undefined) return;
    if (/^\*\s*xyz\s+[+-]?\d+\s+[1-9]\d*\s*$/i.test(echo)) this.echoAtoms = 0;
    else if (this.echoAtoms !== undefined && echo === '*') {
      this.completeEcho ||= this.echoAtoms > 0;
      this.echoAtoms = undefined;
    } else if (this.echoAtoms !== undefined && echo) {
      this.echoAtoms = echoAtom.test(echo) ? this.echoAtoms + 1 : undefined;
    }
  }
  body({ text, number }: Line) {
    if (this.gaussianTable) {
      if (gaussianAtom.test(text)) this.gaussianTable.rows++;
      else if (this.gaussianTable.rows || number - this.gaussianTable.header >= 8) {
        this.gaussian ||= this.gaussianTable.rows > 0 && /^\s*-+\s*$/.test(text);
        this.gaussianTable = undefined;
      }
    }
    if (this.orcaTable) {
      if (orcaAtom.test(text)) this.orcaTable.rows++;
      else if (this.orcaTable.rows || number - this.orcaTable.header >= 8) {
        this.orca ||= this.orcaTable.rows > 0 && !text.trim();
        this.orcaTable = undefined;
      }
    }
    if (gaussianGeometry.test(text)) this.gaussianTable = { header: number, rows: 0 };
    if (orcaGeometry.test(text)) this.orcaTable = { header: number, rows: 0 };
    this.gaussian ||= gaussianErrorTermination.test(text) && /^\s*Error termination (?:via Lnk1e|request processed by link)\b/i.test(text);
    this.orca ||= /^\s*ORCA finished by error termination\b/i.test(text);
    this.orcaExecuted ||= /^\s*(?:FINAL SINGLE POINT ENERGY\s+[+-]?(?:\d|\.)|Intrinsic Reaction Coordinate Calculation\s*$|SCF NOT CONVERGED\b)/i.test(text);
  }
  complete(software: SourceSoftware) {
    return software === 'gaussian' ? this.gaussian : software === 'orca' && (this.orca || this.completeEcho && this.orcaExecuted);
  }
}

/** Consume each physical line once. Only the grammar's outstanding evidence is
 * retained, so recognizing a late header does not replay/copy earlier text. */
class SourceTextRecognition {
  private readonly gaussian = new GaussianOutputSections<Line>();
  private owner: OutputSoftware | null = null;
  private readonly software = new Set<OutputSoftware>();
  private readonly evidence: SourceRecognition['evidence'] = [];
  private readonly prefix = new OutputPrefix();
  private unsafePrefix = false;
  private atomCount = 0;
  private atomicNumbers = false;
  private molden = 0;
  private hess = 0;
  private cif = 0;
  private loop = false;
  private cifAxes = new Set<string>();
  private first?: Line;
  private xyzComment?: string;
  private xyz = 0;
  private pdb = 0;
  private moldenGenerator = 0;

  private visit = (line: Line) => {
    const { text, number } = line, software = outputSoftwareOnLine(text);
    if (software) {
      this.software.add(software);
      if (this.evidence.length < 32) this.evidence.push({ kind: `${software}-header`, line: number });
    }
    if (!this.molden && /^\s*\[Molden Format\]\s*$/i.test(text)) this.molden = number;
    if (!this.hess && /^\s*\$orca_hessian_file\s*$/i.test(text)) this.hess = number;
    if (!this.cif && /^\s*data_\S*/i.test(text)) this.cif = number;
    if (!this.moldenGenerator && /^\s*Molden file created by orca_2mkl for BaseName=\S.*$/i.test(text)) this.moldenGenerator = number;
    this.prefix.body(line);
  };
  private section = (section: { kind: string; line: Line }) => {
    if (section.kind === 'body') this.visit(section.line);
  };

  consume(line: Line): void {
    const { text, number } = line;
    if (this.atomCount && this.atomicNumbers) return;
    if (/^Number of atoms\s+I\s+\d+\s*$/.test(text)) this.atomCount = number;
    if (/^Atomic numbers\s+I\s+N=\s*\d+\s*$/.test(text)) this.atomicNumbers = true;
    if (this.atomCount && this.atomicNumbers) return;
    this.unsafePrefix ||= /[\u0001-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text);
    this.first ??= text.trim() ? line : undefined;
    if (this.first && number <= this.first.number + 2 && /^\s*\d+\s*$/.test(this.first.text) && Number(this.first.text) > 0) {
      if (number === this.first.number + 1) this.xyzComment = text;
      if (number === this.first.number + 2 && matchesXyzRow(text, this.xyzComment)) this.xyz = this.first.number;
    }
    if (!this.pdb && text.length >= 54 && /^(?:ATOM  |HETATM)/.test(text) && /^\s*\d+\s*$/.test(text.slice(6, 11))
      && [30, 38, 46].every(start => coordinateToken.test(text.slice(start, start + 8).trim()))) this.pdb = number;
    this.loop ||= /^\s*loop_\s*$/i.test(text);
    const cifAxis = /^\s*_atom_site_(?:fract|cartn)_([xyz])\s*$/i.exec(text);
    if (cifAxis) this.cifAxes.add(cifAxis[1].toLowerCase());
    this.prefix.echo(text);
    this.owner ??= outputSoftwareOnLine(text);
    if (this.owner === 'gaussian') this.gaussian.consume(line, this.section);
    else if (orcaOutputEcho(text) === undefined && !orcaOutputComment(text)) this.visit(line);
  }
  finish(): void { if (this.owner === 'gaussian') this.gaussian.finish(this.section); }
  result(damage?: { reason: DamagedText; line: number }): SourceRecognition {
    // Format identity is only the envelope here. The fixed-byte FCHK reader,
    // never the generic decoder, validates arbitrary bytes in declared H records.
    if (this.atomCount && this.atomicNumbers) return { format: 'fchk', software: 'unknown', status: 'recognized',
      evidence: [{ kind: 'fchk-format', line: this.atomCount }] };
    const evidence = [...this.evidence], software = new Set(this.software);
    let format: SourceFormat = 'unknown', formatLine = 1;
    if (this.cif && this.loop && this.cifAxes.size === 3) { format = 'cif'; formatLine = this.cif; }
    else if (this.molden) {
      format = 'molden'; formatLine = this.molden;
      if (this.moldenGenerator) { software.add('orca'); evidence.push({kind:'orca-molden-generator',line:this.moldenGenerator}); }
    } else if (this.hess) { format = 'hess'; formatLine = this.hess; }
    else if (this.xyz) { format = 'xyz'; formatLine = this.xyz; }
    else if (software.size) { format = 'output'; formatLine = evidence[0].line; }
    else if (this.pdb) { format = 'pdb'; formatLine = this.pdb; }
    if (format !== 'unknown') evidence.push({ kind: `${format}-format`, line: formatLine });
    const producer: SourceSoftware = software.values().next().value ?? (format === 'hess' ? 'orca' : 'unknown');
    if (damage) {
      if (!this.unsafePrefix && (format === 'xyz' || format === 'pdb')) {
        return { format, software: producer, status: 'recognized', evidence,
          message: `来源后部含${damage.reason}损坏；由结构读取器核对可用前缀。` };
      }
      if (this.unsafePrefix || software.size !== 1 || format !== 'output' || !this.prefix.complete(producer)) {
        return { format: 'unknown', software: 'unknown', status: 'unknown', evidence: [],
          message: `来源含${damage.reason}，此前没有可确认的完整科学文本。` };
      }
      evidence.push({ kind: 'damaged-output-prefix', line: damage.line });
      return { format, software: producer, status: 'recognized', evidence,
        message: `来源后部含${damage.reason}损坏；仅读取其前可靠完整文本。` };
    }
    if (software.size > 1) return { format, software: 'unknown', status: 'conflict', evidence, message: '同一来源含不同软件的运行身份；未自动选择解析器，请分别提供原始来源。' };
    return { format, software: producer, status: format === 'unknown' ? 'unknown' : 'recognized', evidence,
      ...(format === 'unknown' ? { message: '未从已读取内容确认支持的科学文件格式或运行身份。' } : {}) };
  }
}

export function recognizeSourceText(raw: string, final = true): SourceRecognition {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r\n?|\n/), state = new SourceTextRecognition();
  if (!final) lines.pop();
  for (const [index, text] of lines.entries()) {
    if (text.includes('\0')) {
      state.finish();
      return state.result({ reason: 'NUL', line: index + 1 });
    }
    state.consume({ text, number: index + 1 });
  }
  if (final) state.finish();
  return state.result();
}

export async function inspectResultSource(file: ResultInputFile, options: ResultReadOptions = {},
  onLine?: (text: string) => void,
): Promise<{ identity: SourceRecognition; byteEnd: number; text: boolean }> {
  assertResultNotAborted(options.signal);
  const scanner = new CompleteByteLines(), state = new SourceTextRecognition();
  const consume = (line: Line) => { state.consume(line); onLine?.(line.text); };
  let encoding: ResultTextEncoding = 'utf-8', byteEnd = 0;
  for (let start = 0; start < file.size; start += SOURCE_RECOGNITION_BYTES) {
    assertResultNotAborted(options.signal);
    const end = Math.min(file.size, start + SOURCE_RECOGNITION_BYTES), bytes = await file.readRange(start, end, options.signal);
    assertResultNotAborted(options.signal);
    if (bytes.length !== end - start) throw new Error('识别来源时文件长度发生变化。');
    byteEnd = end;
    if (start === 0) encoding = resultTextEncoding(bytes);
    scanner.append(bytes, consume);
    if (end === file.size) scanner.final(consume);
    if (end === file.size || scanner.damageReason) state.finish();
    const identity = state.result(scanner.damageReason ? { reason: scanner.damageReason, line: scanner.damagedLine! } : undefined);
    if (identity.status !== 'unknown' || scanner.damageReason || end === file.size) {
      if (encoding === 'utf-16le') identity.encoding = encoding;
      return { identity, byteEnd, text: !scanner.damageReason || identity.status === 'recognized' };
    }
    options.onProgress?.(end, file.size);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return { identity: state.result(), byteEnd, text: true };
}
export async function recognizeResultSource(file: ResultInputFile, options: ResultReadOptions = {}): Promise<SourceRecognition> {
  return (await inspectResultSource(file, options)).identity;
}
