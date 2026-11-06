import { assertResultNotAborted, type ResultInputFile, type ResultReadOptions } from './contracts';
import { looksLikeFchk } from '../core/fchk-records';

export const SOURCE_RECOGNITION_BYTES = 1024 * 1024;
export type SourceSoftware = 'gaussian' | 'orca' | 'cp2k' | 'xtb' | 'unknown';
export type SourceFormat = 'output' | 'xyz' | 'fchk' | 'molden' | 'hess' | 'cif' | 'unknown';
export interface SourceRecognition {
  format: SourceFormat;
  software: SourceSoftware;
  status: 'recognized' | 'unknown' | 'conflict';
  evidence: { kind: string; line: number }[];
  message?: string;
}

/** Run identity requires a native header, never a filename or a passing brand mention. */
export function outputSoftwareOnLine(raw: string): Exclude<SourceSoftware, 'unknown'> | null {
  const line = raw.replace(/^\uFEFF/, '');
  if (/^\s*Entering Gaussian System\b|^\s*Gaussian\s+(?:03|09|16)(?:\s*:|\s*$)/i.test(line)) return 'gaussian';
  if (/^\s*(?:\*\s*)?O\s+R\s+C\s+A\s*\*?\s*$|^\s*ORCA\b[^\n]*\bProgram Version\s+\d+\.\d+/i.test(line)) return 'orca';
  if (/^\s*CP2K\||^\s*CP2K\s+(?:version|VERSION|[0-9]+\.[0-9]+)\b/.test(line)) return 'cp2k';
  return null;
}

/** Admission of damaged text requires a native identity and complete scientific
 * evidence before the first NUL. Binary/UTF-16 and header-only content
 * still fail; the scientific reader must independently validate every atom. */
function completeOutputPrefix(text: string, software: SourceSoftware): boolean {
  const lines=text.split('\n');
  // Early native failures can precede every geometry. A publisher citation or
  // a header followed by binary bytes is insufficient; retain only an explicit
  // engine termination record in the complete text prefix.
  const completeLines = text.endsWith('\n') ? lines : lines.slice(0, -1);
  if (completeLines.some(line => software === 'gaussian'
    ? /^\s*Error termination (?:via Lnk1e|request processed by link)\b/i.test(line)
    : /^\s*ORCA finished by error termination\b/i.test(line))) return true;
  // MiniPrint IRC may omit every output geometry. A closed plain-atom input
  // echo plus a separate executed scientific record can still identify text;
  // input words alone never qualify as observations or termination evidence.
  if (software === 'orca') {
    let atoms = 0, open = false, complete = false;
    const numeric = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[EeDd][+-]?\\d+)?';
    const row = new RegExp(`^[A-Z][a-z]?\\s+${numeric}\\s+${numeric}\\s+${numeric}\\s*$`);
    for (const line of completeLines) {
      const echo = line.match(/^\s*\|\s*\d+>\s?(.*)$/)?.[1].trim();
      if (echo === undefined) continue;
      if (/^\*\s*xyz\s+[+-]?\d+\s+[1-9]\d*\s*$/i.test(echo)) { open = true; atoms = 0; }
      else if (open && echo === '*') { complete ||= atoms > 0; open = false; }
      else if (open && echo && !/^#/.test(echo)) { if (row.test(echo)) atoms++; else open = false; }
    }
    if (complete && completeLines.some(line => /^\s*(?:FINAL SINGLE POINT ENERGY\s+[+-]?(?:\d|\.)|Intrinsic Reaction Coordinate Calculation\s*$|SCF NOT CONVERGED\b)/i.test(line))) return true;
  }
  for(let index=0;index<lines.length;index++){
    if(!(software==='gaussian'?/\b(?:Standard|Input|Z-Matrix) orientation:/.test(lines[index]):/CARTESIAN COORDINATES\s*\((?:ANGSTROEM|ANGSTROM)\)/i.test(lines[index])))continue;
    const row=software==='gaussian'?/^\s*\d+\s+\d+\s+\d+\s+[+\-\d.eEdD]+\s+[+\-\d.eEdD]+\s+[+\-\d.eEdD]+\s*$/:/^\s*[A-Z][a-z]?\s+[+\-\d.eEdD]+\s+[+\-\d.eEdD]+\s+[+\-\d.eEdD]+\s*$/;
    let first=index+1;while(first<Math.min(index+9,lines.length)&&!row.test(lines[first]))first++;
    let end=first;while(end<lines.length&&row.test(lines[end]))end++;
    if(end>first&&end<lines.length&&(software==='gaussian'?/^\s*-+\s*$/.test(lines[end]):!lines[end].trim()))return true;
  }
  return false;
}

/** Format and producer are independent: Molden/FCHK syntax does not prove its producer. */
export function recognizeSourceText(raw: string): SourceRecognition {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // FCHK format does not prove a producer. Its declared H records may contain
  // any bytes, NUL included: only the fixed-record reader can validate those
  // boundaries, never generic UTF-8 or output-brand scanning of opaque data.
  if(looksLikeFchk(text))return{format:'fchk',software:'unknown',status:'recognized',evidence:[{kind:'fchk-format',line:text.slice(0,text.search(/^Number of atoms\s+I\s+\d+/m)).split('\n').length}]};
  const nul = text.indexOf('\0');
  if (nul >= 0) {
    // The damaged line and everything after it have no identity authority.
    const before = text.slice(0, nul), lastNewline = before.lastIndexOf('\n');
    const prefix = lastNewline < 0 ? '' : before.slice(0, lastNewline + 1);
    const recognized = recognizeSourceText(prefix);
    if (!/[\u0001-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(prefix) && recognized.status === 'recognized' && recognized.format === 'output'
      && ['gaussian', 'orca'].includes(recognized.software) && completeOutputPrefix(prefix, recognized.software)) {
      return { ...recognized, evidence: [...recognized.evidence, { kind: 'damaged-output-prefix', line: before.split('\n').length }],
        message: '来源后部含NUL损坏；仅读取其前可靠完整文本，未使用损坏行或后续内容。' };
    }
    return { format: 'unknown', software: 'unknown', status: 'unknown', evidence: [], message: '检测到二进制或UTF-16内容，未作为科学文本解析。' };
  }
  const lines = text.split('\n'), evidence: SourceRecognition['evidence'] = [];
  const software = new Set<Exclude<SourceSoftware, 'unknown'>>();
  for (let index = 0; index < lines.length; index++) {
    const identity = outputSoftwareOnLine(lines[index]);
    if (identity) { software.add(identity); if (evidence.length < 32) evidence.push({ kind: `${identity}-header`, line: index + 1 }); }
  }
  let format: SourceFormat = 'unknown', formatLine = 1;
  const markerLine = (pattern: RegExp) => lines.findIndex(line => pattern.test(line)) + 1;
  const moldenLine = markerLine(/^\s*\[Molden Format\]\s*$/i), hessLine = markerLine(/^\s*\$orca_hessian_file\s*$/i);
  const cifLine = markerLine(/^\s*data_\S*/i);
  // A producer/version inside CIF audit metadata does not change its role to
  // a quantum-chemistry output. Require the actual coordinate-loop grammar.
  const cifCoordinates = /(?:^|\n)\s*loop_\s*\n/i.test(text) && ['x','y','z'].every(axis => new RegExp('^\\s*_atom_site_(?:fract|cartn)_' + axis + '\\s*$', 'im').test(text));
  if (cifLine && cifCoordinates) { format = 'cif'; formatLine = cifLine; }
  else if (moldenLine) {
    format = 'molden'; formatLine = moldenLine;
    const generator = markerLine(/^\s*Molden file created by orca_2mkl for BaseName=\S.*$/i);
    if (generator) { software.add('orca'); evidence.push({kind:'orca-molden-generator',line:generator}); }
  }
  else if (hessLine) { format = 'hess'; formatLine = hessLine; }
  else if (/^Atomic numbers\s+I\s+N=\s*\d+/m.test(text) && /^Number of atoms\s+I\s+\d+/m.test(text)) { format = 'fchk'; formatLine = markerLine(/^Number of atoms\s+I\s+\d+/); }
  else {
    const first = lines.findIndex(line => line.trim().length > 0);
    if (first >= 0 && /^\s*\d+\s*$/.test(lines[first]) && Number(lines[first]) > 0
      && /^\s*(?:[A-Z][a-z]?|\d+)\s+[+-]?(?:\d|\.)/i.test(lines[first + 2] ?? '')) { format = 'xyz'; formatLine = first + 1; }
    else if (software.size) { format = 'output'; formatLine = evidence[0].line; }
  }
  if (format !== 'unknown') evidence.push({ kind: `${format}-format`, line: formatLine });
  if (software.size > 1) return { format, software: 'unknown', status: 'conflict', evidence, message: '同一来源含不同软件的运行身份；未自动选择解析器，请分别提供原始来源。' };
  const producer: SourceSoftware = software.values().next().value ?? (format === 'hess' ? 'orca' : 'unknown');
  return { format, software: producer, status: format === 'unknown' ? 'unknown' : 'recognized', evidence,
    ...(format === 'unknown' ? { message: '未从已读取内容确认支持的科学文件格式或运行身份。' } : {}) };
}

export async function recognizeResultSource(file: ResultInputFile, options: ResultReadOptions = {}): Promise<SourceRecognition> {
  assertResultNotAborted(options.signal);
  const decoder = new TextDecoder(); let text = '', result: SourceRecognition = { format: 'unknown', software: 'unknown', status: 'unknown', evidence: [] };
  for (let start = 0; start < file.size; start += SOURCE_RECOGNITION_BYTES) {
    assertResultNotAborted(options.signal);
    const end = Math.min(file.size, start + SOURCE_RECOGNITION_BYTES);
    const bytes = await file.readRange(start, end, options.signal);
    assertResultNotAborted(options.signal);
    if (bytes.length !== end - start) throw new Error('识别来源时文件长度发生变化。');
    text += decoder.decode(bytes, { stream: end < file.size });
    result = recognizeSourceText(text);
    if (result.status !== 'unknown' || text.includes('\0')) return result;
    options.onProgress?.(end, file.size);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return result;
}
