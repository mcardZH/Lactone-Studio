import type { Structure } from '../types';
import type { OrcaAsset, OrcaJobRequest, OrcaOutputFile } from './types';

export const BOHR_TO_ANGSTROM = 0.529177210903;
/** Exactly the dependencies consumed by the active writer, not retained drafts. */
export function referencedOrcaAssets(req: OrcaJobRequest): OrcaAsset[] {
  const s = req.settings, e = s.esd;
  const hessianIds = s.task === 'esd' ? e.channel === 'isc'
    ? [e.initialHessianId, e.finalHessianId]
    : [e.groundHessianId, e.channel === 'phosp' ? e.tripletHessianId : e.excitedHessianId]
    : ['irc', 'ts'].includes(s.task) ? [s.ircHessianId] : [];
  return req.assets.filter(asset => asset.kind === 'gbw' && asset.id === s.initialOrbitalsId
    || asset.kind === 'hessian' && hessianIds.includes(asset.id));
}
export const safeOrcaFilename = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && !name.includes('..') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const number = (value: string): number => Number(value.replace(/[dD]/g, 'E'));

export interface HessianContents {
  atoms: { element: string; mass: number; x: number; y: number; z: number }[];
  frequencies: number[];
  multiplicity?: number;
  charge?: number;
  issues: string[];
}

/** ORCA $atoms coordinates are Bohr; matrices are consumed, never invented. */
export function inspectOrcaHessian(text: string): HessianContents {
  const issues: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('$')) {
      const key = line.toLowerCase();
      if (sections.has(key)) issues.push(`重复Hessian段 ${key}`);
      current = [];
      sections.set(key, current);
    } else current?.push(line);
  }
  if (!sections.has('$orca_hessian_file')) issues.push('缺少ORCA Hessian格式标识');
  const atomLines = sections.get('$atoms') ?? [];
  const count = Number(atomLines[0]);
  const atoms: HessianContents['atoms'] = [];
  if (!Number.isSafeInteger(count) || count < 1 || atomLines.length !== count + 1) issues.push('Hessian原子段缺失、截断或原子数不符');
  else for (const line of atomLines.slice(1)) {
    const fields = line.split(/\s+/);
    const values = fields.slice(1).map(number);
    if (fields.length !== 5 || !/^[A-Z][a-z]?$/.test(fields[0]) || values.some(v => !Number.isFinite(v)) || values[0] <= 0) {
      issues.push('Hessian原子/实际质量/Bohr坐标不合法');
      continue;
    }
    atoms.push({ element: fields[0], mass: values[0], x: values[1] * BOHR_TO_ANGSTROM, y: values[2] * BOHR_TO_ANGSTROM, z: values[3] * BOHR_TO_ANGSTROM });
  }
  const dim = count * 3;
  function matrix(key: string, mode: boolean): Float64Array | null {
    const lines = sections.get(key) ?? [];
    const dimensions = (lines[0] ?? '').split(/\s+/).map(Number);
    if (dimensions.length !== (mode ? 2 : 1) || dimensions.some(v => v !== dim)) { issues.push(`${key}维数不符或缺失`); return null; }
    if (!Number.isSafeInteger(dim * dim)) throw new Error(`${key}矩阵维数无法精确表示，不能核对完整Hessian。`);
    let valuesByIndex: Float64Array, seen: Uint8Array;
    try { valuesByIndex = new Float64Array(dim * dim); seen = new Uint8Array(dim * dim); }
    catch { throw new Error(`${key}完整矩阵的内存分配失败；文件尚未完成核对，不能据此判断文件损坏。`); }
    let seenCount = 0;
    let columns: number[] = [];
    let nextRow = dim;
    for (const line of lines.slice(1)) {
      const tokens = line.split(/\s+/);
      if (nextRow === dim) {
        if (!tokens.every(t => /^\d+$/.test(t))) { issues.push(`${key}列标题缺失`); continue; }
        columns = tokens.map(Number);
        if (!columns.length || columns.length > 5 || columns.some(c => c < 0 || c >= dim) || new Set(columns).size !== columns.length) { issues.push(`${key}列索引不合法`); return null; }
        nextRow = 0;
        continue;
      }
      const row = Number(tokens[0]);
      const values = tokens.slice(1).map(number);
      if (!Number.isInteger(row) || row !== nextRow || values.length !== columns.length || !columns.length || values.some(v => !Number.isFinite(v))) { issues.push(`${key}矩阵行不合法`); continue; }
      columns.forEach((column, index) => {
        const offset = row * dim + column;
        if (seen[offset]) issues.push(`${key}重复矩阵元素`);
        else seenCount++;
        seen[offset] = 1;
        valuesByIndex[offset] = values[index];
      });
      nextRow++;
    }
    if (seenCount !== dim * dim) { issues.push(`${key}矩阵截断`); return null; }
    return valuesByIndex;
  }
  // Reject invalid counts before allocating matrices.
  if (Number.isSafeInteger(count) && count > 0 && atoms.length === count) {
    const hessian = matrix('$hessian', false);
    if (hessian && hessian.some((value, offset) => {
      const transpose = hessian[(offset % dim) * dim + Math.floor(offset / dim)];
      return Math.abs(value - transpose) > 1e-7 * Math.max(1, Math.abs(value), Math.abs(transpose));
    })) issues.push('Hessian矩阵不对称');
    if (hessian && count > 1 && !hessian.some(value => Math.abs(value) > 1e-15)) issues.push('Hessian矩阵全部为零');
    const modes = matrix('$normal_modes', true);
    if (modes && !modes.some(value => Math.abs(value) > 1e-15)) issues.push('normal_modes全部为零');
  }
  const frequencyLines = sections.get('$vibrational_frequencies') ?? [];
  const frequencies: number[] = [];
  if (Number(frequencyLines[0]) !== dim || frequencyLines.length !== dim + 1) issues.push('振动频率段缺失、截断或维数不符');
  else frequencyLines.slice(1).forEach((line, index) => {
    const tokens = line.split(/\s+/);
    if (tokens.length !== 2 || Number(tokens[0]) !== index || !Number.isFinite(number(tokens[1]))) issues.push('振动频率索引或数值不合法');
    frequencies.push(number(tokens[1]));
  });
  function scalar(key: string): number | undefined {
    const lines = sections.get(key);
    if (!lines) return undefined;
    const value = Number(lines[0]);
    if (lines.length !== 1 || !Number.isInteger(value) || (key === '$multiplicity' && value < 1)) issues.push(`${key}不合法`);
    return value;
  }
  return { atoms, frequencies, multiplicity: scalar('$multiplicity'), charge: scalar('$charge'), issues: [...new Set(issues)] };
}

export function hessianMatchesGeometry(data: HessianContents, structure: Structure, tolerance = 1e-5): boolean {
  return data.atoms.length === structure.atoms.length && data.atoms.every((atom, i) => {
    const other = structure.atoms[i];
    return atom.element === other.element && ['x', 'y', 'z'].every(key => Math.abs(atom[key as 'x'] - other[key as 'x']) <= tolerance);
  });
}

export function dependencyFile(asset: OrcaAsset): OrcaOutputFile | null {
  if (!safeOrcaFilename(asset.name) || typeof asset.text !== 'string' || !asset.text.trim()) return null;
  return { name: asset.name, text: asset.text, role: 'dependency', sourceAssetId: asset.id };
}
