import { assertResultNotAborted, type ResultDiagnostic, type ResultFileRole, type ResultInputFile, type ResultReadOptions } from './contracts';
import { emptyScientificData, emptyScientificDiagnostics, scientificNumber, type MdQuantityObservation, type MdStepObservation, type ScientificData } from './scientific-contracts';
import { readAuxiliarySourceLines } from './auxiliary-source-lines';

export const MD_COLUMNS = ['Step', 'Sim. Time', 'Iter', 't_Ener', 't_Grad', 'Temp', 'E_Kin', 'E_Pot', 'E_Tot', 'Cons.Qty', 'E.Drift'] as const;
const normalUnits: Record<string, string> = { fs: 'fs', ps: 'ps', K: 'K', Hartree: 'hartree', Eh: 'hartree' };
const normalUnit = (raw: string) => normalUnits[raw];
const quantities = [['time', 1], ['scfIterations', 2], ['temperature', 5], ['kineticEnergy', 6], ['potentialEnergy', 7], ['totalEnergy', 8]] as const;
export interface MdNativeTableLayout { edges: number[]; unitRaw: string; unitLine: number; units: string[] }
/** Native fixed-width rows contain a blank initial gradient field. Split at
 * printed header columns, never whitespace that would shift the energy columns. */
export function mdNativeTableLayout(header: string, unitRaw: string, unitLine: number): MdNativeTableLayout | null {
  const names = header.split('|').map(value => value.trim());
  if (names.length !== MD_COLUMNS.length || !names.every((value, index) => value === MD_COLUMNS[index])) return null;
  const edges = [-1, ...[...header.matchAll(/\|/g)].map(match => match.index!)];
  const cells = edges.map((start, index) => unitRaw.slice(start + 1, edges[index + 1] ?? unitRaw.length).trim());
  if (!cells[1]?.startsWith('[') || !cells[7]?.startsWith('[')) return null;
  return { edges, unitRaw, unitLine, units: cells.map(value => value.replace(/^\[|\]$/g, '')) };
}
function stepFromCells(cells: string[], sourceLine: number, layout?: MdNativeTableLayout): MdStepObservation | null {
  const rawStep = cells[0]?.trim(), sourceStep = Number(rawStep);
  if (!/^\d+$/.test(rawStep ?? '') || !Number.isSafeInteger(sourceStep)) return null;
  const row: MdStepObservation = { sourceStep, rawStep, sourceLine, jobIndex: null, frameIndex: null, stageId: 'md' };
  for (const [key, column] of quantities) {
    const rawValue = cells[column]?.trim(), value = scientificNumber(rawValue ?? '');
    if (value === null || key === 'scfIterations' && (!Number.isSafeInteger(value) || value < 0)) return null;
    const rawUnit = layout?.units[column], unit = rawUnit ? normalUnit(rawUnit) : undefined;
    row[key] = { value, rawValue, sourceLine, ...(rawUnit ? { rawUnit } : {}), ...(unit ? { unit, unitEvidence: { raw: layout!.unitRaw, sourceLine: layout!.unitLine } } : {}) };
  }
  return row;
}
export function parseMdNativeTableRow(text: string, sourceLine: number, layout: MdNativeTableLayout): MdStepObservation | null {
  return stepFromCells(layout.edges.map((start, index) => text.slice(start + 1, layout.edges[index + 1] ?? text.length)), sourceLine, layout);
}
export function mdNativeReferences(text: string): { name: string; role: ResultFileRole }[] {
  const patterns: [ResultFileRole, RegExp][] = [
    ['md-trajectory', /^Dump: Will write Position data of region "[^"]+" in XYZ format with stride \d+ to "([^"]+)"(?: \(append\))?\.\s*$/],
    ['md-log', /^Will write log file to "([^"]+)"\.\s*$/],
    ['md-statistics', /^Will write energy statistics to "([^"]+)" after each step\.\s*$/],
    ['md-restart', /^Will write restart file to "([^"]+)" after each step\.\s*$/],
  ];
  return patterns.flatMap(([role, pattern]) => { const match = text.trim().match(pattern); return match ? [{ name: match[1], role }] : []; });
}
const csvHeader = (text: string) => { const first = text.replace(/^\uFEFF/, '').split(/\r?\n/).find(line => line.trim()) ?? ''; const names = first.replace(/^\s*#/, '').split(';').map(value => value.trim()); return names.length === MD_COLUMNS.length && names.every((name, index) => name === MD_COLUMNS[index]); };
function kindOf(text: string): 'log' | 'statistics' | null {
  const plain = text.replace(/^\uFEFF/, '');
  if (/^\s*Will write log file to "[^"\r\n]+"\./.test(plain) && /Scriptable Nuclear Dynamics \(SANdy\) \+ ORCA/.test(plain) && /Compiled as ORCA module\. Called from ORCA\./.test(plain)) return 'log';
  return csvHeader(plain) ? 'statistics' : null;
}
function qualify(data: ScientificData, source: { id: string; name: string }) {
  for (const row of data.mdSteps ?? []) {
    row.sourceId = source.id; row.sourceName = source.name;
    for (const [key] of quantities) { const value = row[key]; if (value) { value.sourceId = source.id; value.sourceName = source.name; if (value.unitEvidence) { value.unitEvidence.sourceId = source.id; value.unitEvidence.sourceName = source.name; } } }
  }
}
export function parseMdAuxiliary(text: string | readonly string[], kind: 'log' | 'statistics'): { data: ScientificData; partial: boolean; messages: string[]; nativeBaseName?: string } {
  const data = emptyScientificData(); data.tasks = ['md']; data.mdSteps = []; data.diagnostics = emptyScientificDiagnostics();
  const messages: string[] = []; let partial = false, nativeBaseName: string | undefined, pendingHeader: string | null = null, layout: MdNativeTableLayout | null = null, inTable = false;
  const lines = typeof text === 'string' ? text.replace(/^\uFEFF/, '').split(/\r?\n/) : text;
  const stop = (message: string) => { partial = true; messages.push(message); };
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index], line = index + 1, trimmed = raw.trim();
    if (raw.includes('\0')) { stop(`源行${line}含NUL损坏；保留此前完整MD行，后文未用于完成判断。`); data.diagnostics.integrity = { status: 'damaged-tail', sourceLine: line, message: messages.at(-1) }; break; }
    if (kind === 'statistics') {
      if (!trimmed || trimmed.startsWith('#')) continue;
      const row = stepFromCells(raw.split(';').map(value => value.trim()), line);
      if (!row) { stop(`源行${line}的MD统计行不完整；未补零或越过坏行继续。`); break; }
      data.mdSteps.push(row); continue;
    }
    const base = trimmed.match(/^\* ORCA base name: "([^"]+)"$/); if (base) nativeBaseName = base[1];
    const version = trimmed.match(/^\* Source code version: (.+)$/); if (version) data.summary.push({ key: 'md-module-version', label: 'Native MD module source/build version', value: version[1], rawValue: version[1], sourceLine: line, origin: 'program-adopted' });
    for (const reference of mdNativeReferences(trimmed)) (data.relatedFiles ??= []).push({ ...reference, sourceLine: line });
    if (/^Step\s*\|\s*Sim\. Time\s*\|/.test(trimmed)) { pendingHeader = raw; layout = null; inTable = false; continue; }
    if (pendingHeader) { layout = mdNativeTableLayout(pendingHeader, raw, line); pendingHeader = null; if (layout) inTable = true; continue; }
    if (inTable && /^\s*\d+\s/.test(raw)) {
      const row = layout ? parseMdNativeTableRow(raw, line, layout) : null;
      if (!row) { stop(`源行${line}的MD表行损坏；仅保此前完整行。`); break; }
      data.mdSteps.push(row); continue;
    }
    if (inTable && !/^[\s|\-]+$/.test(raw)) inTable = false;
    const finished = trimmed.match(/^Finished MD run of (\d+) steps\.$/);
    if (finished) { data.diagnostics.tasks.push({ task: 'md', status: 'completed', sourceLine: line, stageId: 'md', raw }); data.summary.push({ key: 'md-completed-integration-steps', label: 'Native completed integration steps', value: Number(finished[1]), rawValue: finished[1], sourceLine: line, origin: 'observation' }); }
  }
  if (!data.mdSteps.length) stop('未取得完整MD步观测；原始来源仍保留。');
  if (partial) { data.notices.push(...messages); data.diagnostics.fields.push({ field: 'md-steps', status: 'partial', message: messages.join('；') }); }
  return { data, partial, messages, nativeBaseName };
}

export interface MdAuxiliarySource { kind: 'log' | 'statistics'; diagnostic: ResultDiagnostic; retainedBytes: number; sha256?: string; nativeBaseName?: string }
/** Keep original bytes as a normal diagnostic asset; grammar never invents a job. */
export async function readMdAuxiliary(file: ResultInputFile, options: ResultReadOptions = {}, _retentionLimit?: number, declaredRole?: 'log' | 'statistics'): Promise<MdAuxiliarySource | null> {
  let closed = false, sourceClosed = false, bytes: Uint8Array | undefined;
  const closeSource = async () => { if (sourceClosed) return; sourceClosed = true; await file.close?.(); };
  let prefix: Uint8Array;
  try { assertResultNotAborted(options.signal); const size = Math.min(file.size, 65536); prefix = await file.readRange(0, size, options.signal); assertResultNotAborted(options.signal); if (prefix.length !== size) throw new Error('MD辅助前缀长度发生变化。'); }
  catch (error) { await closeSource(); throw error; }
  const recognized = kindOf(new TextDecoder().decode(prefix)), kind = recognized ?? declaredRole; if (!kind) return null;
  let parsed: ReturnType<typeof parseMdAuxiliary>, sha256: string | undefined;
  try {
    const read = await readAuxiliarySourceLines(file, options, prefix);
    sha256 = read.sha256;
    parsed = recognized ? parseMdAuxiliary(read.lines, kind) : { data: emptyScientificData(), partial: true, messages: ['原生OUT声明此辅助角色，但当前内容/头部不相容；仅保原件，程序/作业/单位未认证。'] };
    if (read.interruption) { parsed.partial = true; parsed.messages.push(read.interruption); }
  } catch (error) { await closeSource(); throw error; }
  parsed.data.source = { id: file.id, name: file.name, ...(sha256 ? { sha256 } : {}) }; qualify(parsed.data, { id: file.id, name: file.name });
  parsed.data.notices.push(...parsed.messages);
  const diagnostic: ResultDiagnostic = { kind: 'diagnostic', id: `${file.id}:md-auxiliary`, label: `${file.name} · MD辅助来源`, engine: recognized === 'log' ? 'orca' : 'unknown', sourceRole: 'auxiliary', source: { id: file.id, name: file.name, size: file.size, ...(sha256 ? { sha256 } : {}), software: recognized === 'log' ? 'orca' : 'unknown' }, jobIndex: null, segmentIndex: 0, charge: null, multiplicity: null, status: parsed.partial ? 'incomplete' : 'unknown', messages: [...parsed.messages, 'MD辅助表独立保存；未凭文件名或表格生成原子模型或关联作业。'], scientific: parsed.data,
    async readSourceRange(start, end, signal) { assertResultNotAborted(signal); if (closed) throw new Error('MD辅助来源已关闭。'); if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > file.size || end - start > 64 * 1024 ** 2) throw new Error('MD辅助读取范围无效。'); const value = bytes ? bytes.slice(start, end) : await file.readRange(start, end, signal); assertResultNotAborted(signal); if (closed || value.length !== end - start) throw new Error('MD辅助来源关闭或长度变化。'); return value; },
    async dispose() { if (closed) return; closed = true; bytes = undefined; await closeSource(); },
  };
  return { kind, diagnostic, retainedBytes: bytes?.length ?? 0, sha256, nativeBaseName: parsed.nativeBaseName };
}
