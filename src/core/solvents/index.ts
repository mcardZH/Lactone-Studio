import library from '../../data/solvents-library.json';
import type { GaussianSettings } from '../types';
import type { OrcaSettings, OrcaVersion } from '../orca/types';
import type { SolventEntry, SolventIssue, SolventModel, SolventParameters, SolventSelection } from './types';

export type { SolventEntry, SolventIssue, SolventModel, SolventParameters, SolventSelection } from './types';
export { CUSTOM_EPS_INF, CUSTOM_REFRACTIVE_INDEX, createEpsilonOnlySolvent, defaultSolventModel, isEpsilonOnlySolvent, pcmSolventModel, solventModelForTaskChange, solventSelectionForModelChange } from './policy';
export type SolventEngine = 'gaussian' | 'orca';
export type SolventSort = 'common' | 'name' | 'dielectric-asc' | 'dielectric-desc';
type Profile = OrcaVersion;
const entries = library.entries as (SolventEntry & { profiles?: string[] })[];
export const solventSources = library.sources;
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s,\-_.]/g, '');
const profile = (major?: number | string): string => major === undefined || major === 6 ? '6.1' : String(major);

/** Only documented model/profile combinations; returned copies protect source facts. */
export function getSolventEntries(engine: SolventEngine, model: SolventModel, major?: number | string, retainedId?: string): SolventEntry[] {
  if ((engine === 'gaussian' && model === 'cpcm') || (engine === 'orca' && model === 'iefpcm')) return [];
  if (engine === 'orca' && major === 'common') {
    const reviewed = ['5', '6.0', '6.1'].flatMap(version => getSolventEntries(engine, model, version));
    const seen = new Set<string>();
    return reviewed.filter(entry => {
      const keyword = model === 'smd' ? entry.orca?.smd : entry.orca?.cpcm;
      const key = normalized(keyword ?? entry.englishName);
      if (entry.id === retainedId) { seen.add(key); return true; }
      if (seen.has(key)) return false;
      // Retained exact IDs take precedence without changing their source facts.
      if (retainedId && reviewed.some(other => other.id === retainedId && normalized((model === 'smd' ? other.orca?.smd : other.orca?.cpcm) ?? other.englishName) === key)) return false;
      seen.add(key); return true;
    });
  }
  return entries.filter(entry => engine === 'gaussian'
    ? Boolean(model === 'smd' ? entry.gaussian?.smd : entry.gaussian?.pcm)
    : Boolean(entry.profiles?.includes(profile(major)) && (model === 'smd' ? entry.orca?.smd : entry.orca?.cpcm)))
    .map(entry => ({ ...entry, aliases: [...entry.aliases], sources: [...entry.sources],
      dielectricReference: entry.dielectricReference && { ...entry.dielectricReference },
      gaussian: entry.gaussian && { ...entry.gaussian },
      orca: entry.orca && { ...entry.orca, majorVersions: [...entry.orca.majorVersions] } }));
}

export function searchSolvents(values: readonly SolventEntry[], query: string): SolventEntry[] {
  const terms = query.trim().split(/\s+/).map(normalized).filter(Boolean);
  return values.filter(entry => {
    const haystack = [entry.englishName, entry.chineseName, entry.id, ...entry.aliases].map(normalized).join('|');
    return terms.every(term => haystack.includes(term));
  });
}

/** Fixed browsing shortlist, not measured usage/popularity or a scientific recommendation. */
export const COMMON_SOLVENT_NAMES = [
  'water', 'methanol', 'ethanol', 'acetone', 'acetonitrile', 'dimethylsulfoxide',
  'n,n-dimethylformamide', 'tetrahydrofuran', 'dichloromethane', 'chloroform',
  'toluene', 'benzene', 'n-hexane', 'hexane', 'ethyl acetate',
] as const;
const commonNames = new Set(COMMON_SOLVENT_NAMES.map(normalized));
export function isCommonSolvent(entry: Pick<SolventEntry, 'englishName'>): boolean {
  return commonNames.has(normalized(entry.englishName));
}

export function sortSolvents(values: readonly SolventEntry[], sort: SolventSort = 'name'): SolventEntry[] {
  return [...values].sort((a, b) => {
    const av = a.dielectric ?? a.dielectricReference?.value ?? null;
    const bv = b.dielectric ?? b.dielectricReference?.value ?? null;
    if (av === null && bv !== null) return 1;
    if (av !== null && bv === null) return -1;
    if (sort === 'common') {
      const priority = Number(isCommonSolvent(b)) - Number(isCommonSolvent(a));
      if (priority) return priority;
    }
    if ((sort === 'dielectric-asc' || sort === 'dielectric-desc') && av !== null && bv !== null && av !== bv)
      return (av - bv) * (sort === 'dielectric-asc' ? 1 : -1);
    return a.englishName.localeCompare(b.englishName, 'en', { numeric: true });
  });
}

/** Exact aliases only for legacy input; an explicit foreign-version ID is never remapped. */
export function findSolventEntry(engine: SolventEngine, model: SolventModel, name: string, major?: number | string): SolventEntry | undefined {
  if (engine === 'orca' && major === 'common') {
    const exact = ['5', '6.0', '6.1'].flatMap(version => getSolventEntries(engine, model, version)).find(entry => entry.id === name);
    if (exact) return exact;
  }
  const values = getSolventEntries(engine, model, major);
  return values.find(entry => entry.id === name) ?? values.find(entry =>
    [entry.englishName, entry.chineseName, ...entry.aliases].some(alias => normalized(alias) === normalized(name)));
}

/**
 * Extract one already reviewed Gaussian built-in keyword, preserving source case.
 * Commas belong to many real solvent names and therefore cannot delimit a name
 * until the longest complete library keyword has matched. Search aliases (e.g.
 * CDCl3/Chinese names) are deliberately not accepted as native Gaussian syntax.
 * DMSO and THF retain the pre-existing, reviewed Gaussian compatibility aliases.
 * Generic/Read sources remain unresolved; additional solvent-tail recovery is a
 * separate workflow and must not be implied by recognizing a built-in prefix.
 */
export function extractGaussianBuiltinSolvent(text: string, model: 'iefpcm' | 'smd' = 'iefpcm'): string | undefined {
  if (/(?:^|[\s,(])(?:read|external)(?=[\s,)=]|$)/i.test(text)) return undefined;
  const matches = [...text.matchAll(/(?:^|[\s,(])solvent\s*=\s*/gi)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const rest = text.slice(match.index! + match[0].length);
  const keywords = getSolventEntries('gaussian', model).map(entry => model === 'smd' ? entry.gaussian!.smd! : entry.gaussian!.pcm!);
  // These two aliases were present in the original Gaussian software selector;
  // do not copy the broad user-facing alias/search list into native parsing.
  keywords.push('DMSO', 'THF');
  keywords.sort((a, b) => b.length - a.length);
  for (const keyword of keywords) {
    if (rest.slice(0, keyword.length).toLowerCase() !== keyword.toLowerCase()) continue;
    const next = rest[keyword.length];
    if (next === undefined || /[\s,)]/.test(next)) return rest.slice(0, keyword.length);
  }
  return undefined;
}

export interface SolventValidationOptions { requireRefractiveIndex?: boolean }
export function validateSolventSelection(
  selection: SolventSelection | undefined,
  engine: SolventEngine,
  model: SolventModel,
  major?: number | string,
  options: SolventValidationOptions = {},
): SolventIssue[] {
  const issues: SolventIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  if (engine === 'orca' && !['5', '6.0', '6.1', 'common'].includes(profile(major))) add('version', '该 ORCA 版本的溶剂接口尚未核对。');
  if ((engine === 'gaussian' && !['iefpcm', 'smd'].includes(model)) || (engine === 'orca' && !['cpcm', 'smd'].includes(model)))
    add('solventModel', '该软件不支持此处选择的溶剂模型。');
  if (!selection) return issues; // deliberate gas phase
  if (selection.mode === 'builtin') {
    if (!selection.id || !getSolventEntries(engine, model, major, selection.id).some(entry => entry.id === selection.id))
      add('solvation.id', '请选择当前软件、模型和版本已核对的内置溶剂；旧选择已保留。');
    return issues;
  }
  if (selection.mode !== 'custom') { add('solvation.mode', '未知溶剂选择类型。'); return issues; }
  const p = selection.custom;
  if (!p) { add('solvation.custom', '请填写自定义溶剂参数。'); return issues; }
  if (p.opticalApproximation === 'epsinf-1.9') {
    if (model === 'smd') add('solventModel', '仅 ε 自定义溶剂使用 IEFPCM/CPCM；SMD 须有完整的七项描述符。');
    if (p.refractiveIndex !== Math.sqrt(1.9)) add('solvation.custom.refractiveIndex', '仅 ε 自定义的近似光学介电常数为 1.9，折射率须为 √1.9。');
  }
  if (!p.name?.trim() || /[\u0000-\u001f\u007f]/.test(p.name)) add('solvation.custom.name', '自定义溶剂须有不含控制字符的名称。');
  const number = (key: keyof SolventParameters, required: boolean, min: number, max = Infinity) => {
    const value = p[key];
    if (value === undefined && !required) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
      add(`solvation.custom.${key}`, `${key} 必须为${min === 0 ? '非负' : `不小于 ${min} 的`}有限实数${max === 1 ? '，且不超过 1' : ''}。`);
  };
  number('dielectric', true, 1);
  number('refractiveIndex', model === 'smd' || Boolean(options.requireRefractiveIndex), 1);
  if (model === 'smd') {
    number('hydrogenBondAcidity', true, 0); number('hydrogenBondBasicity', true, 0);
    number('surfaceTension', true, 0); number('aromaticity', true, 0, 1); number('halogenicity', true, 0, 1);
    if (typeof p.aromaticity === 'number' && typeof p.halogenicity === 'number' && p.aromaticity + p.halogenicity > 1 + 1e-12)
      add('solvation.custom.halogenicity', '芳香碳与 F/Cl/Br 均以非氢原子为分母，二者比例之和不能超过 1。');
  }
  if (typeof p.refractiveIndex === 'number' && Number.isFinite(p.refractiveIndex) &&
      Number.isFinite(p.dielectric) && p.dielectric + 1e-10 < p.refractiveIndex ** 2)
    add('solvation.custom.dielectric', '静态介电常数不能小于折射率平方（光学介电常数）；请核对数值与测量条件。');
  return issues;
}

type GaussianInput = Pick<GaussianSettings, 'solvent' | 'solventModel' | 'solvation'> & SolventValidationOptions;
type OrcaInput = Pick<OrcaSettings, 'solvent' | 'solventModel' | 'solvation'> & Partial<Pick<OrcaSettings, 'version'>> & SolventValidationOptions;
const gasPhase = (name: string) => !name.trim() || /^(gas|none|gas-phase|vacuum|气相)$/i.test(name.trim());
/** An explicit, possibly incomplete form must never be mistaken for gas phase. */
export const hasSolvation = (settings: { solvent: string; solvation?: SolventSelection }) => Boolean(settings.solvation) || !gasPhase(settings.solvent);
function resolve(settings: GaussianInput | OrcaInput, engine: SolventEngine, version?: Profile): { selection?: SolventSelection; issues: SolventIssue[] } {
  if (settings.solvation) return { selection: settings.solvation, issues: [] };
  if (gasPhase(settings.solvent)) return { issues: [] };
  const found = findSolventEntry(engine, settings.solventModel, settings.solvent, version);
  return found ? { selection: { mode: 'builtin', id: found.id }, issues: [] }
    : { issues: [{ field: 'solvent', message: '来源溶剂名称未在当前软件/模型/版本中核对，不能静默转换。' }] };
}
/** Decimal real literal, including zero, with sufficient precision for n² conversion. */
const real = (n: number) => { const s = String(Number(n.toPrecision(15))); return /[.eE]/.test(s) ? s : `${s}.0`; };

export function buildGaussianSolvation(settings: GaussianInput): { route: string; tail: string; issues: SolventIssue[] } {
  const { selection, issues } = resolve(settings, 'gaussian');
  issues.push(...validateSolventSelection(selection, 'gaussian', settings.solventModel, undefined, settings));
  if (issues.length || !selection) return { route: '', tail: '', issues };
  if (selection.mode === 'builtin') {
    const entry = getSolventEntries('gaussian', settings.solventModel).find(e => e.id === selection.id)!;
    const keyword = settings.solventModel === 'smd' ? entry.gaussian!.smd! : entry.gaussian!.pcm!;
    return { route: `scrf=(${settings.solventModel},solvent=${keyword.toLowerCase()})`, tail: '', issues };
  }
  const p = selection.custom!;
  const lines = [`Eps=${real(p.dielectric)}`];
  if (p.refractiveIndex !== undefined) lines.push(`EpsInf=${real(p.refractiveIndex ** 2)}`);
  if (settings.solventModel === 'smd') lines.push(
    `HbondAcidity=${real(p.hydrogenBondAcidity!)}`, `HbondBasicity=${real(p.hydrogenBondBasicity!)}`,
    `SurfaceTensionAtInterface=${real(p.surfaceTension!)}`, `CarbonAromaticity=${real(p.aromaticity!)}`,
    `ElectronegativeHalogenicity=${real(p.halogenicity!)}`);
  return { route: `scrf=(${settings.solventModel},solvent=generic,read)`, tail: `${lines.join('\n')}\n\n`, issues };
}

export function buildOrcaSolvation(settings: OrcaInput): { keywords: string[]; blocks: string[]; issues: SolventIssue[] } {
  const version = settings.version ?? '6.1';
  const { selection, issues } = resolve(settings, 'orca', version);
  issues.push(...validateSolventSelection(selection, 'orca', settings.solventModel, version, settings));
  if (issues.length || !selection) return { keywords: [], blocks: [], issues };
  if (selection.mode === 'builtin') {
    const entry = getSolventEntries('orca', settings.solventModel, version).find(e => e.id === selection.id)!;
    if (settings.solventModel === 'smd') return { keywords: [], blocks: [`%cpcm\n  smd true\n  SMDsolvent "${entry.orca!.smd}"\nend`], issues };
    const keyword = entry.orca!.cpcm!;
    return /\s/.test(keyword)
      ? { keywords: ['CPCM'], blocks: [`%cpcm\n  solvent "${keyword}"\nend`], issues }
      : { keywords: [`CPCM(${keyword})`], blocks: [], issues };
  }
  const p = selection.custom!;
  const lines = [`  epsilon ${real(p.dielectric)}`];
  if (p.refractiveIndex !== undefined) lines.push(`  refrac ${real(p.refractiveIndex)}`);
  if (settings.solventModel === 'smd') lines.push('  smd true',
    `  soln ${real(p.refractiveIndex!)}`, `  sola ${real(p.hydrogenBondAcidity!)}`,
    `  solb ${real(p.hydrogenBondBasicity!)}`, `  solg ${real(p.surfaceTension!)}`,
    `  solc ${real(p.aromaticity!)}`, `  solh ${real(p.halogenicity!)}`);
  return { keywords: ['CPCM'], blocks: [`%cpcm\n${lines.join('\n')}\nend`], issues };
}
