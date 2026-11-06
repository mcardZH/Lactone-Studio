import { atomicNumber, elementSymbol } from '../elements';

export const ORCA_BOHR_ANGSTROM = 0.529177210903;
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const finite = (token: string) => decimal.test(token) && Number.isFinite(Number(token.replace(/[dD]/, 'e'))) ? Number(token.replace(/[dD]/, 'e')) : null;
export interface OrcaNativeCenter {
  sourceIndex: number; sourceLine: number; kind: 'real' | 'ghost' | 'dummy'; element: string | null; nuclearCharge: number | null;
  coordinates: [number, number, number]; coordinateUnit: 'angstrom' | 'bohr';
}
export interface OrcaAngCenter extends OrcaNativeCenter { label: string; coordinateTokens: [string, string, string] }
export interface OrcaAuRow {
  sourceIndex: number; sourceLine: number; label: string; element: string | null;
  za: number; mass: number; frag: number; zaToken: string; massToken: string; fragToken: string;
  ecpMarked?: boolean;
  coordinates: [number, number, number]; coordinateTokens: [string, string, string];
}
export interface OrcaAuTable { sourceLine: number; rows: OrcaAuRow[]; complete: boolean; message?: string; ecpFootnote?: { sourceLine: number; raw: string } }
export function readOrcaAngCenter(text: string, sourceLine: number, sourceIndex: number): OrcaAngCenter | null {
  const fields = text.trim().split(/\s+/);
  if (fields.length === 5 && /^\d+$/.test(fields[0])) fields.shift();
  if (fields.length !== 4 || fields.slice(1).some(token => finite(token) === null)) return null;
  const ghost = /^([A-Za-z]{1,2}):$/.exec(fields[0]), dummy = /^(?:DA|-)$/i.test(fields[0]);
  let element: string | null;
  try { element = dummy ? null : elementSymbol(ghost?.[1] ?? fields[0]); } catch { return null; }
  return { sourceIndex, sourceLine, label: fields[0], kind: dummy ? 'dummy' : ghost ? 'ghost' : 'real', element, nuclearCharge: dummy ? null : ghost ? 0 : atomicNumber(element!), coordinates: fields.slice(1).map(token => finite(token)!) as [number, number, number], coordinateTokens: fields.slice(1) as [string, string, string], coordinateUnit: 'angstrom' };
}
export class OrcaAuTableReader {
  private active = false;
  private sourceLine = 0;
  private columns = false;
  private rows: OrcaAuRow[] = [];
  private ecpFootnote: OrcaAuTable['ecpFootnote'];
  reset() { this.active = false; this.rows = []; this.columns = false; this.ecpFootnote = undefined; }
  finish(complete = false): OrcaAuTable | null {
    if (!this.active) return null;
    const marked = this.rows.filter(row => row.ecpMarked);
    const ecpConfirmed = !marked.length || !!this.ecpFootnote && marked.every(row => row.element !== null && row.za > 0 && row.za < atomicNumber(row.element) && row.mass > 0 && !/:$/.test(row.label));
    const result = { sourceLine: this.sourceLine, rows: this.rows, complete: complete && this.columns && ecpConfirmed, ...(this.ecpFootnote ? { ecpFootnote: this.ecpFootnote } : {}), ...(!this.columns ? { message: 'A.U.表没有确认的NO/LB/ZA/FRAG/MASS/X/Y/Z列头。' } : !ecpConfirmed ? { message: 'A.U.星号芯电荷没有完整原生ECP脚注或合法缩减电荷/质量证据；未认证中心映射。' } : {}) };
    this.reset(); return result;
  }
  consume(text: string, sourceLine: number): { started?: boolean; consumed: boolean; table?: OrcaAuTable } {
    const t = text.trim();
    if (/^CARTESIAN COORDINATES\s*\(A\.U\.\)\s*$/i.test(t)) {
      const previous = this.finish(false); this.active = true; this.sourceLine = sourceLine;
      return { started: true, consumed: true, ...(previous ? { table: previous } : {}) };
    }
    if (!this.active) return { consumed: false };
    if (/^NO\s+LB\s+ZA\s+FRAG\s+MASS\s+X\s+Y\s+Z\s*$/i.test(t)) { this.columns = true; return { consumed: true }; }
    if (/^-+$/.test(t) || !t && !this.rows.length) return { consumed: true };
    if (!t) return { consumed: true, table: this.finish(true)! };
    if (t === '* core charge reduced due to ECP' && this.columns && this.rows.some(row => row.ecpMarked)) { this.ecpFootnote = { sourceLine, raw: t }; return { consumed: true }; }
    const fields = t.split(/\s+/);
    const ecpMarked = fields.length === 8 && fields[2].endsWith('*') && finite(fields[2].slice(0, -1)) !== null;
    const za = fields.length === 8 ? finite(ecpMarked ? fields[2].slice(0, -1) : fields[2]) : null;
    if (this.columns && fields.length === 8 && /^\d+$/.test(fields[0]) && /^\d+$/.test(fields[3]) && za !== null && [4, 5, 6, 7].every(index => finite(fields[index]) !== null)) {
      const ordinal = Number(fields[0]);
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || !Number.isSafeInteger(ordinal + 1)) throw new Error('ORCA A.U.中心索引须为可精确表示的非负整数。');
      let element: string | null;
      try { element = /^(?:-|DA)$/i.test(fields[1]) ? null : elementSymbol(fields[1].replace(/:$/, '')); } catch { return { consumed: true, table: this.finish(false)! }; }
      this.rows.push({ sourceIndex: ordinal + 1, sourceLine, label: fields[1], element, za, ...(ecpMarked ? { ecpMarked: true } : {}), mass: finite(fields[4])!, frag: Number(fields[3]), zaToken: fields[2], massToken: fields[4], fragToken: fields[3], coordinates: fields.slice(5).map(token => finite(token)!) as [number, number, number], coordinateTokens: fields.slice(5) as [string, string, string] });
      return { consumed: true };
    }
    const malformedRow = /^\d+\s+/.test(t);
    return { consumed: malformedRow, table: this.finish(!malformedRow)! };
  }
}
function halfPrintedDigit(token: string): number {
  const [mantissa, exponent = '0'] = token.replace(/[dD]/, 'e').toLowerCase().split('e');
  return .5 * 10 ** (Number(exponent) - (mantissa.split('.')[1]?.length ?? 0));
}
export function orcaAuCenters(table: OrcaAuTable): OrcaNativeCenter[] {
  return table.rows.map(row => ({ sourceIndex: row.sourceIndex, sourceLine: row.sourceLine, kind: row.element === null ? 'dummy' : row.za === 0 ? 'ghost' : 'real', element: row.element, nuclearCharge: row.element === null || row.ecpMarked ? null : row.za, coordinates: row.coordinates, coordinateUnit: 'bohr' }));
}
export function pairOrcaCenterTables(angstrom: OrcaAngCenter[], table: OrcaAuTable): { matched: boolean; centers: OrcaNativeCenter[]; special: boolean; independentReal?: boolean; message: string } {
  const fallback = orcaAuCenters(table), special = fallback.some(center => center.kind !== 'real');
  if (!table.complete || !angstrom.length || angstrom.length !== table.rows.length) return { matched: false, centers: fallback, special, message: 'Å/A.U.中心表未完整同数配对；只保独立A.U.证据，不补普通原子。' };
  for (let index = 0; index < angstrom.length; index++) {
    const ang = angstrom[index], au = table.rows[index];
    if (au.sourceIndex !== index + 1 || ang.sourceIndex !== index + 1 || ang.element !== au.element || au.za < 0 || au.mass < 0 || au.za === 0 && au.mass !== 0 || ang.kind === 'ghost' && au.za !== 0 || ang.kind === 'dummy' && au.za !== 0) return { matched: false, centers: fallback, special, message: 'Å/A.U.中心序号、元素或核/质量角色冲突，未跨表强配。' };
  }
  // Prove every row's identity/role before considering coordinate conflicts.
  // This is not a coordinate match: two complete all-real source inventories
  // may remain independent without revoking the valid Angstrom geometry.
  const independentReal = angstrom.every(ang => ang.kind === 'real' && ang.element !== null) && table.rows.every(au => au.za > 0 && au.mass > 0 && !/:$/.test(au.label));
  for (let index = 0; index < angstrom.length; index++) {
    const ang = angstrom[index], au = table.rows[index];
    for (let axis = 0; axis < 3; axis++) {
      const converted = au.coordinates[axis] * ORCA_BOHR_ANGSTROM;
      const tolerance = halfPrintedDigit(ang.coordinateTokens[axis]) + halfPrintedDigit(au.coordinateTokens[axis]) * ORCA_BOHR_ANGSTROM + 4 * Number.EPSILON * (Math.abs(ang.coordinates[axis]) + Math.abs(converted));
      if (Math.abs(ang.coordinates[axis] - converted) > tolerance) return { matched: false, centers: fallback, special, independentReal, message: 'Å/A.U.坐标不在各自原打印精度/单位换算区间内，未强配核角色。' };
    }
  }
  const centers = angstrom.map((ang, index): OrcaNativeCenter => ({ sourceIndex: ang.sourceIndex, sourceLine: ang.sourceLine, kind: ang.kind === 'dummy' ? 'dummy' : table.rows[index].za === 0 ? 'ghost' : 'real', element: ang.element, nuclearCharge: ang.kind === 'dummy' || table.rows[index].ecpMarked ? null : table.rows[index].za, coordinates: ang.coordinates, coordinateUnit: 'angstrom' }));
  return { matched: true, centers, special: centers.some(center => center.kind !== 'real'), message: 'Å/A.U.同job中心表按数目、原序、元素及打印精度配对；核角色来自原ZA/MASS。' };
}
