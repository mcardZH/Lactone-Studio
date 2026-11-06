import { parseStructures } from '../core/parsers';
import { readResultSourceRange } from './source-range';
import type { Structure } from '../core/types';
import { withAtomIds } from '../core/structures';
import { assertResultNotAborted, type ResultFrameSummary, type ResultInputFile, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { abortableResultRead } from './xyz-reader';

interface RecordText { text: string; line: number; incomplete?: boolean }
function records(text: string, extension: string): RecordText[] {
  const lines = text.split('\n');
  if (extension === 'sdf' || extension === 'mol') {
    const out: RecordText[] = []; let start = 0;
    for (let i = 0; i < lines.length; i++) if (/^\$\$\$\$\s*$/.test(lines[i])) {
      out.push({ text: lines.slice(start, i).join('\n') + '\n', line: start + 1 }); start = i + 1;
    }
    if (lines.slice(start).some(l => l.trim())) out.push({ text: lines.slice(start).join('\n'), line: start + 1 });
    return out;
  }
  if (extension === 'cif') {
    const starts: number[] = []; let multiline = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(';')) { multiline = !multiline; continue; }
      if (!multiline && /^\s*data_\S*/i.test(lines[i])) starts.push(i);
    }
    if (!starts.length) return [{ text, line: 1 }];
    return starts.map((start, i) => ({ text: lines.slice(start, starts[i + 1] ?? lines.length).join('\n'), line: start + 1 }));
  }
  const firstModel = lines.findIndex(line => /^MODEL\s/.test(line));
  if (firstModel < 0) return [{ text, line: 1 }];
  const prefix = lines.slice(0, firstModel).join('\n');
  const out: RecordText[] = []; let start = -1;
  for (let i = firstModel; i < lines.length; i++) {
    if (/^MODEL\s/.test(lines[i])) {
      if (start >= 0) out.push({ text: lines.slice(start, i).join('\n'), line: start + 1, incomplete: true });
      start = i;
    } else if (/^ENDMDL\b/.test(lines[i]) && start >= 0) {
      out.push({ text: `${prefix}\n${lines.slice(start, i + 1).join('\n')}`, line: start + 1 }); start = -1;
    }
  }
  if (start >= 0) out.push({ text: lines.slice(start).join('\n'), line: start + 1, incomplete: true });
  return out;
}

/** Bounded single-file collection; its record order never implies physical time. */
export async function readStructureCollection(file: ResultInputFile, options: ResultReadOptions = {}): Promise<TrajectoryResult[]> {
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= Promise.resolve().then(() => file.close?.()).then(() => undefined);
  try {
    assertResultNotAborted(options.signal);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('结构集合文件字节数无效。');
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    if (!['sdf', 'mol', 'pdb', 'cif'].includes(extension)) throw new Error('结构集合仅支持SDF/MOL、PDB MODEL和CIF数据块。');
    const bytes = await abortableResultRead(readResultSourceRange(file, 0, file.size, options.signal), options.signal);
    assertResultNotAborted(options.signal);
    if (bytes.length !== file.size) throw new Error('结构集合来源长度发生变化。');
    options.onProgress?.(bytes.length, file.size);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    let structures: Structure[] = [];
    const frames: ResultFrameSummary[] = [];
    const messages = ['文件内结构集合；记录顺序不代表物理时间，时间与能量未作推断。'];
    let status: TrajectoryResult['status'] = 'completed';
    const entries = records(text, extension);
    const append = (structure: Structure, sourceLine: number) => {
      const index = structures.length;
      // The parser may omit model IDs. Normalize exactly once per independent
      // record, never on getFrame: revisiting a record must keep its identity.
      // Existing provenance is not a request to repair invalid/duplicate IDs.
      if (structure.atoms.some(atom => atom.id !== undefined && (typeof atom.id !== 'string' || !atom.id.trim())
        || atom.sourceIndex !== undefined && !Number.isSafeInteger(atom.sourceIndex))) throw new Error('结构集合原子身份或来源序号无效。');
      const identified = withAtomIds({ ...structure, id: `${file.id}:collection:record:${index}` });
      if (new Set(identified.atoms.map(atom => atom.id)).size !== identified.atoms.length) throw new Error('结构集合原子身份重复。');
      structures.push(identified);
      frames.push({ index, sourceStep: null, time: null, energy: null, convergence: [], sourceLine, label: structure.format });
    };
    // For valid files use the parser's original whole-file result, preserving its
    // generated MODEL labels, atom IDs, bonds, notes and provenance exactly.
    let whole: Structure[] | undefined;
    if (!entries.some(entry => entry.incomplete)) {
      try { whole = parseStructures(text, file.name); } catch { /* Recover only a visibly reported complete prefix below. */ }
    }
    if (whole) {
      const sourceLines = entries.flatMap(entry => {
        if (extension !== 'pdb') return [entry.line];
        const alternates = new Set(entry.text.split('\n').filter(line => /^(ATOM  |HETATM)/.test(line)).map(line => line[16]?.trim()).filter(Boolean));
        return Array.from({ length: Math.max(1, alternates.size) }, () => entry.line);
      });
      whole.forEach((structure, index) => append(structure, sourceLines.length === whole.length ? sourceLines[index] : 1));
    }
    for (const record of whole ? [] : entries) {
      assertResultNotAborted(options.signal);
      try {
        if (record.incomplete) throw new Error('PDB MODEL缺少ENDMDL，模型截断。');
        const parsed = parseStructures(record.text, file.name);
        for (const structure of parsed) append(structure, record.line);
      } catch (error) {
        if (!structures.length) throw error;
        status = record.incomplete || /截断|缺少M END|未闭合|不完整/.test(String(error)) ? 'incomplete' : 'failed';
        messages.push(`第${record.line}行开始的记录未读取；保留此前${structures.length}个完整结构：${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    if (!structures.length) throw new Error('结构集合中没有完整结构。');
    let disposed = false;
    return [{
      id: `${file.id}:collection`, label: file.name, kind: 'collection', engine: 'structure',
      source: { id: file.id, name: file.name, size: file.size }, jobIndex: 0, status, messages, frames,
      initialStructure: structuredClone(structures[0]),
      async getFrame(index, signal) {
        assertResultNotAborted(signal);
        if (disposed) throw new Error('结构集合已关闭。');
        if (!Number.isSafeInteger(index) || index < 0 || index >= structures.length) throw new Error('集合记录索引超出范围。');
        return structuredClone(structures[index]);
      },
      async dispose() { if (disposed) return; disposed = true; structures = []; await close(); },
    }];
  } catch (error) { await close(); throw error; }
}
