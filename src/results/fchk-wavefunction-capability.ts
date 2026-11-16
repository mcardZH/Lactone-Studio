import type { FchkTrackedField, FchkValidatedField } from '../core/fchk-reader';
import type { FchkFieldDiagnostic } from '../core/fchk-records';

/** The geometry, basis and MO records consumed by the existing native reader.
 * Large arrays are verified token by token; only their lengths are retained. */
export const fchkWavefunctionFields = {
  'Number of atoms': { shape: 'I' },
  'Atomic numbers': { shape: 'I[]' },
  'Current cartesian coordinates': { shape: 'R[]' },
  Charge: { shape: 'I' },
  Multiplicity: { shape: 'I' },
  'Number of electrons': { shape: 'I' },
  'Number of alpha electrons': { shape: 'I' },
  'Number of beta electrons': { shape: 'I' },
  'Number of basis functions': { shape: 'I' },
  'Number of independent functions': { shape: 'I' },
  'Number of independant functions': { shape: 'I' },
  'Number of contracted shells': { shape: 'I' },
  'Number of primitive shells': { shape: 'I' },
  'Shell types': { shape: 'I[]', retainValues: true },
  'Number of primitives per shell': { shape: 'I[]', retainValues: true },
  'Shell to atom map': { shape: 'I[]', retainValues: true },
  'Primitive exponents': { shape: 'R[]', retainValues: true },
  'Contraction coefficients': { shape: 'R[]' },
  'P(S=P) Contraction coefficients': { shape: 'R[]' },
  'Alpha Orbital Energies': { shape: 'R[]' },
  'Alpha MO coefficients': { shape: 'R[]' },
  'Alpha Orbital Occupation Numbers': { shape: 'R[]', retainValues: true },
  'Beta Orbital Energies': { shape: 'R[]' },
  'Beta MO coefficients': { shape: 'R[]' },
  'Beta Orbital Occupation Numbers': { shape: 'R[]', retainValues: true },
} satisfies Record<string, FchkTrackedField>;

const required = [
  'Number of atoms', 'Atomic numbers', 'Current cartesian coordinates',
  'Number of alpha electrons', 'Number of beta electrons', 'Number of basis functions',
  'Shell types', 'Number of primitives per shell', 'Shell to atom map',
  'Primitive exponents', 'Contraction coefficients', 'Alpha Orbital Energies', 'Alpha MO coefficients',
] as const;
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const functionsInShell = (type: number) => type === -1 ? 4 : type < 0 ? 2 * Math.abs(type) + 1 : (type + 1) * (type + 2) / 2;

/** Return the first blocking dependency, while retaining all source diagnostics. */
export function fchkWavefunctionBlocker(fields: ReadonlyMap<string, FchkValidatedField>, diagnostics: readonly FchkFieldDiagnostic[]): string | null {
  const damage = diagnostics.find(issue => issue.affectedCapabilities.includes('wavefunction'));
  if (damage) return damage.message;
  const missing = required.find(label => !fields.has(label));
  if (missing) return `FCHK 缺少必要字段 ${missing}。`;

  const scalar = (label: string) => fields.get(label)?.values[0];
  const count = (label: string) => fields.get(label)?.count;
  const values = (label: string) => fields.get(label)!.values;
  const agrees = (label: string, expected: number) => !fields.has(label) || scalar(label) === expected;
  const atoms = scalar('Number of atoms')!, basis = scalar('Number of basis functions')!;
  const na = scalar('Number of alpha electrons')!, nb = scalar('Number of beta electrons')!;
  const shells = values('Shell types'), primitives = values('Number of primitives per shell'), mapping = values('Shell to atom map');
  if (count('Atomic numbers') !== atoms || count('Current cartesian coordinates') !== 3 * atoms) return 'FCHK 的原子数与几何数组长度不一致。';
  if (na < 0 || nb < 0 || !agrees('Number of electrons', na + nb)) return 'FCHK 的总电子数与 α/β 电子数不一致。';
  if (basis < 1 || shells.some(type => Math.abs(type) > 6) || sum(shells.map(functionsInShell)) !== basis ||
      !agrees('Number of contracted shells', shells.length) || primitives.length !== shells.length || mapping.length !== shells.length) {
    return 'FCHK 的基函数数、壳层类型或壳层数组长度不一致。';
  }
  if (mapping.some(atom => atom < 1 || atom > atoms)) return 'FCHK 的 Shell to atom map 指向不存在的原子。';
  const primitiveCount = sum(primitives);
  if (primitives.some(value => value < 1) || !agrees('Number of primitive shells', primitiveCount) ||
      count('Primitive exponents') !== primitiveCount || count('Contraction coefficients') !== primitiveCount ||
      values('Primitive exponents').some(value => value <= 0) ||
      (shells.includes(-1) && count('P(S=P) Contraction coefficients') !== primitiveCount)) {
    return 'FCHK 的原始基函数数量、指数或收缩系数无效或不完整。';
  }
  const unrestricted = fields.has('Beta Orbital Energies') || fields.has('Beta MO coefficients');
  for (const spin of unrestricted ? ['Alpha', 'Beta'] : ['Alpha']) {
    const orbitals = count(`${spin} Orbital Energies`);
    if (!orbitals || orbitals > basis || Math.max(na, nb) > orbitals || count(`${spin} MO coefficients`) !== basis * orbitals ||
        !agrees('Number of independent functions', orbitals) || !agrees('Number of independant functions', orbitals)) {
      return `FCHK 的 ${spin} 轨道能量、独立函数数、电子数或 MO 系数长度不一致或缺失。`;
    }
    const occupation = fields.get(`${spin} Orbital Occupation Numbers`);
    if (occupation && (occupation.count !== orbitals || occupation.values.some(value => value < 0 || value > (unrestricted ? 1 : 2)))) {
      return `FCHK 的 ${spin} 轨道占据数组无效。`;
    }
  }
  return null;
}
