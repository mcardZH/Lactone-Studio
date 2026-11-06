import { ELEMENTS } from '../elements';
import { sha256Utf8 } from '../file-identity';
import { findSolventEntry, hasSolvation, validateSolventSelection } from '../solvents';
import type { SolventSelection } from '../solvents';
import type { Atom } from '../types';
import { getOrcaMethods, getOrcaMethodProfile, ORCA_VERSIONS } from './catalog';
import type { OrcaAsset, OrcaHessianPathEvidence, OrcaIssue, OrcaJobRequest } from './types';

type Evidence = NonNullable<OrcaAsset['hessianEvidence']>;
type MatrixIdentity = { atoms: Atom[]; charge?: number; multiplicity?: number };
const normalized = (value: string) => value.trim().toLowerCase().replace(/[\s_()-]/g, '');
const sourceKnown = (value: string) => !!value.trim() && !/unknown|undefined|待|未知|未确认|未提供|占位|<|>|\b(?:tbd|todo|n\/a)\b/i.test(value)
  && !/[\r\n\0]/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value);
function solventShape(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)) return false;
  if (value.mode === 'builtin') return typeof value.id === 'string';
  if (value.mode !== 'custom' || !record(value.custom) || typeof value.custom.name !== 'string') return false;
  const p = value.custom;
  if (typeof p.dielectric !== 'number' || !Number.isFinite(p.dielectric)) return false;
  return ['refractiveIndex', 'hydrogenBondAcidity', 'hydrogenBondBasicity', 'surfaceTension', 'aromaticity', 'halogenicity']
    .every(key => p[key] === undefined || typeof p[key] === 'number' && Number.isFinite(p[key]));
}
export function hessianPathShapeErrors(asset: OrcaAsset): string[] {
  const errors: string[] = [], e: unknown = asset.hessianEvidence;
  if (typeof asset.text !== 'string') errors.push('Hessian实际文本须为字符串，不能把未知数据转成文本。');
  if (asset.sha256 !== undefined && typeof asset.sha256 !== 'string') errors.push('Hessian SHA256声明须为字符串。');
  if (!record(e)) return [...errors, 'Hessian来源声明缺失或不是对象。'];
  for (const key of ['source', 'state', 'method']) if (typeof e[key] !== 'string') errors.push(`Hessian来源${key}须为字符串。`);
  for (const key of ['basis', 'solvent']) if (e[key] !== undefined && typeof e[key] !== 'string') errors.push(`Hessian来源${key}须为字符串。`);
  if (!integer(e.charge) || !integer(e.multiplicity) || (e.multiplicity as number) < 1) errors.push('Hessian来源电荷/多重度须为有效整数。');
  if (e.referenceMultiplicity !== undefined && (!integer(e.referenceMultiplicity) || (e.referenceMultiplicity as number) < 1)) errors.push('Hessian来源参考多重度须为正整数。');
  if (e.version !== undefined && !ORCA_VERSIONS.includes(e.version as never)) errors.push('Hessian来源版本声明无效。');
  if (e.stateSource !== undefined && !['udft', 'td'].includes(e.stateSource as string)) errors.push('Hessian态来源声明无效。');
  if (e.geometryUnits !== 'bohr') errors.push('Hessian来源单位须明确为Bohr。');
  for (const key of ['atomOrderConfirmed', 'minimumConfirmed']) if (typeof e[key] !== 'boolean') errors.push(`Hessian来源${key}须为布尔值，不能用字符串代替确认。`);
  const p = e.path;
  if (!record(p)) return [...errors, 'Hessian路径证据缺失或不是对象。'];
  if (p.schema !== 1 || !['ts-initial', 'irc'].includes(p.purpose as string) || !['same-level', 'initial-approximation'].includes(p.levelRelation as string)) errors.push('Hessian路径schema/用途/级别关系缺失或无效。');
  if (typeof p.dispersion !== 'string' || typeof p.solventModel !== 'string' || typeof p.targetContext !== 'string' || typeof p.approximationNote !== 'string') errors.push('Hessian路径条件、绑定与近似说明须为字符串。');
  for (const key of ['compatibilityConfirmed', 'transitionStateConfirmed']) if (typeof p[key] !== 'boolean') errors.push(`Hessian路径${key}须为布尔值，不能用字符串代替确认。`);
  if (!Array.isArray(p.atomIds) || !p.atomIds.every(id => typeof id === 'string' && !!id.trim())) errors.push('Hessian路径原子身份须为非空字符串数组。');
  if (!solventShape(p.solvation)) errors.push('Hessian路径溶剂选择/自定义参数形状无效。');
  return errors;
}
const methods = getOrcaMethods('6.1');
function sourceMethod(value: string) {
  const aliases: Record<string, string> = { pbe1pbe: 'pbe0', tpsstpss: 'tpss', gfn2xtb: 'xtb2' };
  const name = normalized(value).replace(/^[ru](?=b3lyp$|pbe1pbe$|pbe0$|m062x$|camb3lyp$|tpsstpss$|tpss$|tpssh$)/, ''), alias = aliases[name] ?? name;
  return methods.find(method => [method.id, method.label, method.keywords.join(' ')].some(token => normalized(token) === alias));
}
export function orcaPathDispersion(method: OrcaJobRequest['settings']['method']): OrcaHessianPathEvidence['dispersion'] {
  const profile = getOrcaMethodProfile(method, '6.1');
  if (!profile) return '';
  if (profile.family === 'composite' || ['wb97x-d3', 'wb97x-v', 'wb97m-v', 'revdsd-pbep86-d4-2021'].includes(method)) return 'builtin';
  if (profile.keywords.includes('D3BJ')) return 'd3bj';
  if (profile.keywords.includes('D4')) return 'd4';
  return 'none';
}

/** Source metadata is only prefilled on an explicit action; no confirmation is added. */
export function defaultHessianPath(req: OrcaJobRequest): OrcaHessianPathEvidence {
  return { schema: 1, purpose: req.settings.task === 'irc' ? 'irc' : 'ts-initial', levelRelation: 'same-level',
    dispersion: '', solventModel: '', atomIds: [], compatibilityConfirmed: false, targetContext: '',
    transitionStateConfirmed: false, approximationNote: '' };
}
function selectedSolvent(model: 'cpcm' | 'smd', solvent: string, selection?: SolventSelection): SolventSelection | undefined {
  if (selection) return structuredClone(selection);
  const entry = findSolventEntry('orca', model, solvent, 'common');
  return entry ? { mode: 'builtin', id: entry.id } : undefined;
}
function environment(model: OrcaHessianPathEvidence['solventModel'], selection?: SolventSelection) {
  if (!solventShape(selection)) return null;
  if (model === 'gas') return selection ? null : ['gas'];
  if (!['cpcm', 'smd'].includes(model) || !selection
    || validateSolventSelection(selection, 'orca', model as 'cpcm' | 'smd', 'common').length) return null;
  if (selection.mode === 'builtin') {
    const entry = findSolventEntry('orca', model as 'cpcm' | 'smd', selection.id ?? '', 'common');
    return entry ? [model, 'builtin', normalized((model === 'smd' ? entry.orca?.smd : entry.orca?.cpcm) ?? '')] : null;
  }
  const p = selection.custom!;
  // Only physical parameters consumed by the selected model define its environment.
  return [model, 'custom', p.dielectric, p.refractiveIndex ?? null,
    ...(model === 'smd' ? [p.hydrogenBondAcidity, p.hydrogenBondBasicity, p.surfaceTension, p.aromaticity, p.halogenicity] : [])];
}
function targetEnvironment(req: OrcaJobRequest) {
  const s = req.settings;
  return hasSolvation(s) ? environment(s.solventModel, selectedSolvent(s.solventModel, s.solvent, s.solvation)) : ['gas'];
}
function targetFacts(req: OrcaJobRequest) {
  const s = req.settings, method = getOrcaMethodProfile(s.method, '6.1');
  return [s.task, s.method, method?.basisPolicy === 'uniform-def2' ? normalized(s.basis) : method?.basisPolicy,
    orcaPathDispersion(s.method), targetEnvironment(req), req.charge, req.multiplicity, s.unrestricted,
    s.multiscale.mode, s.multiscale.qmAtomIds, s.multiscale.qmCharge, s.multiscale.qmMultiplicity,
    s.multiscale.lowMethod, s.multiscale.embedding, s.multiscale.boundaries, s.multiscale.activeAtomIds,
    s.constraints, s.frozenAtomIds,
    req.structure?.atoms.map((atom, index) => [atom.id ?? `atom-${index + 1}`, atom.element, atom.x, atom.y, atom.z])];
}
export function ircStartContext(req: OrcaJobRequest): string { return JSON.stringify([1, ...targetFacts(req)]); }

// Small LRU keyed by real identity and exact text. Cloning assets or moving frames
// cannot cause a full-file hash/parse; changing the actual body always does.
const bodyCache = new Map<string, { text: string; hash: string; matrix: MatrixIdentity | null }>();
function bodyIdentity(asset: OrcaAsset) {
  if (typeof asset.text !== 'string') return { text: null, hash: null, matrix: null };
  const text = asset.text, cached = bodyCache.get(asset.id);
  if (cached?.text === text) { bodyCache.delete(asset.id); bodyCache.set(asset.id, cached); return cached; }
  const body = { text, hash: sha256Utf8(text), matrix: parsePathHessian(text) };
  bodyCache.delete(asset.id); bodyCache.set(asset.id, body);
  if (bodyCache.size > 16) bodyCache.delete(bodyCache.keys().next().value!);
  return body;
}
export function hessianPathContext(req: OrcaJobRequest, asset: OrcaAsset): string {
  const invalid = hessianPathShapeErrors(asset);
  if (invalid.length) return 'invalid-hessian-path:' + JSON.stringify(invalid);
  const e = asset.hessianEvidence, p = e?.path;
  if (!e || !p || !sourceKnown(e.source) || !sourceKnown(e.state) || !sourceKnown(e.method ?? '')
    || !['none', 'd3', 'd3bj', 'd4', 'builtin'].includes(p.dispersion) || !environment(p.solventModel, p.solvation))
    return 'invalid-hessian-path:来源条件尚未完整声明';
  return JSON.stringify([1, asset.id, asset.name, asset.sha256 ?? null, bodyIdentity(asset).hash,
    e && [e.source, e.version, e.state, e.stateSource, e.referenceMultiplicity, e.charge, e.multiplicity,
      e.geometryUnits, e.method, e.basis, e.solvent],
    p && [p.schema, p.purpose, p.levelRelation, p.dispersion, p.solventModel, p.solvation, p.atomIds, p.approximationNote],
    ...targetFacts(req)]);
}
export function currentHessianSourceFields(req: OrcaJobRequest, asset: OrcaAsset): Evidence {
  const previous = asset.hessianEvidence, s = req.settings;
  const solvation = hasSolvation(s) ? selectedSolvent(s.solventModel, s.solvent, s.solvation) : undefined;
  return { ...previous, source: previous?.source ?? '', state: previous?.state ?? '',
    charge: req.charge, multiplicity: req.multiplicity, geometryUnits: 'bohr', minimumConfirmed: false,
    atomOrderConfirmed: false, method: s.method, basis: getOrcaMethodProfile(s.method, '6.1')?.basisPolicy === 'uniform-def2' ? s.basis : '',
    solvent: s.solvent, path: { ...defaultHessianPath(req), dispersion: orcaPathDispersion(s.method),
      solventModel: hasSolvation(s) ? s.solventModel : 'gas', solvation,
      atomIds: req.structure?.atoms.map((atom, index) => atom.id ?? `atom-${index + 1}`) ?? [] } };
}
export function invalidateHessianPathEvidence(e: Evidence | undefined): Evidence | undefined {
  if (!record(e) || !record(e.path)) return e;
  return e && { ...e, path: e.path && { ...e.path, compatibilityConfirmed: false, transitionStateConfirmed: false, targetContext: '' } };
}

export function validateHessianPath(req: OrcaJobRequest, asset: OrcaAsset): OrcaIssue[] {
  const issues: OrcaIssue[] = [], e = asset.hessianEvidence, p = e?.path;
  const error = (message: string) => issues.push({ field: 'ircHessianId', message, severity: 'error' });
  const malformed = hessianPathShapeErrors(asset);
  if (malformed.length) return malformed.map(message => ({ field: 'ircHessianId', message, severity: 'error' }));
  const body = bodyIdentity(asset);
  const atoms = req.structure?.atoms ?? [], data = body.matrix;
  if (!data || data.atoms.length !== atoms.length || !data.atoms.every((atom, i) => atom.element === atoms[i].element
    && Math.max(Math.abs(atom.x - atoms[i].x), Math.abs(atom.y - atoms[i].y), Math.abs(atom.z - atoms[i].z)) < 1e-4))
    error('Hessian完整矩阵、逐序元素或配套几何与当前结构不一致。');
  if (asset.sha256 !== undefined && (!/^[a-f0-9]{64}$/i.test(asset.sha256) || asset.sha256.toLowerCase() !== body.hash))
    error('Hessian实际文本与所给SHA256文件身份不一致，请重新提供真实文件。');
  if (!e || !sourceKnown(e.source) || !sourceKnown(e.state) || e.geometryUnits !== 'bohr' || e.atomOrderConfirmed !== true
    || e.charge !== req.charge || e.multiplicity !== req.multiplicity) error('须明确Hessian真实来源、物理态、电荷/多重度、Bohr单位及逐原子顺序。');
  if (e && (/^S\d+$/i.test(e.state) && e.multiplicity !== 1 || /^T\d+$/i.test(e.state) && e.multiplicity !== 3))
    error('来源物理态S/T标签与声明多重度矛盾，不能借路径确认覆盖电子态。');
  if (e?.stateSource === 'td' || e?.referenceMultiplicity !== undefined && e.referenceMultiplicity !== e.multiplicity)
    error('普通TS/IRC尚未核对TD目标/电子参考态不同的Hessian，请另定明确路径方案。');
  if (p?.levelRelation === 'same-level' && (e?.stateSource === 'udft' || /^u(?:b3lyp|pbe1pbe|pbe0|m062x|cam-b3lyp|tpsstpss|tpss|tpssh)$/i.test(e?.method ?? ''))
    && !req.settings.unrestricted && req.multiplicity === 1) error('来源非限制性参考与当前限制性单重态路径不一致，不能只改方法别名确认同级。');
  if (p?.levelRelation === 'same-level' && /^r(?:b3lyp|pbe1pbe|pbe0|m062x|cam-b3lyp|tpsstpss|tpss|tpssh)$/i.test(e?.method ?? '')
    && (req.settings.unrestricted || req.multiplicity > 1)) error('来源限制性参考与当前非限制性路径不一致，不能只改方法别名确认同级。');
  if (data && (data.charge !== undefined && data.charge !== req.charge || data.multiplicity !== undefined && data.multiplicity !== req.multiplicity))
    error('Hessian正文charge/multiplicity与当前路径电子态矛盾，来源标签不能覆盖正文。');
  const purpose = req.settings.task === 'irc' ? 'irc' : 'ts-initial';
  if (!p || p.schema !== 1 || p.purpose !== purpose || p.compatibilityConfirmed !== true || p.targetContext.startsWith('invalid-hessian-path') || p.targetContext !== hessianPathContext(req, asset))
    error('须确认当前用途的Hessian来源兼容；文件、来源或目标条件变化后请重新核对。');
  if (!p) return issues;
  const ids = atoms.map((atom, index) => atom.id ?? `atom-${index + 1}`);
  if (p.atomIds.length !== ids.length || p.atomIds.some((id, i) => id !== ids[i])) error('Hessian来源稳定原子身份必须与当前结构逐序一致。');
  if (!['same-level', 'initial-approximation'].includes(p.levelRelation)) error('请明确Hessian为同级来源或TS初始近似。');
  if (p.levelRelation === 'initial-approximation' && (purpose !== 'ts-initial' || !sourceKnown(p.approximationNote)))
    error('仅TS初始Hessian可采用明确说明的初始近似；IRC须保持同一势能面。');
  if (purpose === 'irc' && p.transitionStateConfirmed !== true) error('IRC须确认当前几何为已验TS，并核对同一势能面的来源条件；ESD极小点确认不能替代。');
  const method = sourceMethod(e?.method ?? ''), target = getOrcaMethodProfile(req.settings.method, '6.1');
  if (method && e?.version !== undefined && !getOrcaMethodProfile(method.id, e.version)) error('所声明ORCA来源版本不支持该来源方法，不能把不可能的来源当作同级或初始近似。');
  if (!sourceKnown(e?.method ?? '') || !/^[A-Za-z][A-Za-z0-9+_.()/\s-]*$/.test(e?.method ?? '')) error('请填写明确的来源方法，未知或占位名称不能作为初始近似。');
  const noBasis = method?.basisPolicy === 'none' || /^(?:pm[367]|am1|mndo|gfn[012]xtb|xtb[012])$/i.test(normalized(e?.method ?? ''));
  const builtin = method?.basisPolicy === 'builtin';
  if (noBasis || builtin) {
    if ((e?.basis ?? '').trim() && !['none', 'builtin', '内置', '无'].includes((e?.basis ?? '').trim().toLowerCase())) error('来源3c采用固有基组，XTB/半经验不使用外加轨道基组。');
    if (p.dispersion !== (builtin ? 'builtin' : 'none')) error('来源3c固有校正或XTB/半经验无DFT色散必须明确，不叠加额外校正。');
  } else if (!sourceKnown(e?.basis ?? '')) error('请填写来源有效轨道基组；未知基组不能作为初始近似。');
  if (!['none', 'd3', 'd3bj', 'd4', 'builtin'].includes(p.dispersion)) error('请明确来源色散处理。');
  const sourceEnv = environment(p.solventModel, p.solvation), targetEnv = targetEnvironment(req);
  if (!sourceEnv || !targetEnv || JSON.stringify(sourceEnv) !== JSON.stringify(targetEnv)) error('Hessian来源气相/溶剂模型及完整参数须与当前路径环境一致。');
  const legacySolvent = e?.solvent?.trim();
  if (legacySolvent) {
    const gas = /^(gas|none|gas-phase|vacuum|气相)$/i.test(legacySolvent);
    const declared = p.solventModel === 'gas' ? gas ? ['gas'] : null
      : p.solvation?.mode === 'custom' ? ['custom', p.solvation.custom?.name].some(name => name?.toLowerCase() === legacySolvent.toLowerCase()) ? sourceEnv : null
      : environment(p.solventModel, selectedSolvent(p.solventModel as 'cpcm' | 'smd', legacySolvent));
    if (!declared || JSON.stringify(declared) !== JSON.stringify(sourceEnv)) error('来源溶剂名称与所声明的路径环境参数矛盾，请核对真实来源。');
  }
  if (p.levelRelation === 'same-level') {
    if (!method || method.id !== target?.id || target?.basisPolicy === 'uniform-def2' && normalized(e?.basis ?? '') !== normalized(req.settings.basis)
      || p.dispersion !== orcaPathDispersion(req.settings.method)) error('同级Hessian来源方法、有效基组与色散须匹配当前路径；低级别只能明确选为TS初始近似。');
  }
  return issues;
}

/** Raw TS/IRC Hessians need only real atoms and a full symmetric matrix, not ESD modes. */
function parsePathHessian(text: string): MatrixIdentity | null {
  const sections = new Map<string, string[]>(); let rows: string[] | undefined;
  for (const raw of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (line.startsWith('$')) { const key = line.toLowerCase(); if (sections.has(key)) return null; rows = []; sections.set(key, rows); }
    else rows?.push(line);
  }
  const atomRows = sections.get('$atoms'), matrixRows = sections.get('$hessian');
  if (!atomRows || !matrixRows) return null;
  const count = Number(atomRows[0]), dim = Number(matrixRows[0]);
  if (!Number.isSafeInteger(count) || count < 1 || atomRows.length !== count + 1 || dim !== count * 3 || dim * dim > text.length) return null;
  const numeric = (s: string) => Number(s.replace(/[dD]/g, 'e')), atoms: Atom[] = [];
  for (const row of atomRows.slice(1)) {
    const values = row.split(/\s+/);
    if (values.length !== 5 || !ELEMENTS.includes(values[0]) || !values.slice(1).every(value => Number.isFinite(numeric(value))) || numeric(values[1]) <= 0) return null;
    const [x, y, z] = values.slice(2).map(value => numeric(value) * 0.529177210903); atoms.push({ element: values[0], x, y, z });
  }
  const matrix = new Float64Array(dim * dim), seen = new Uint8Array(dim * dim); let columns: number[] = [], nextRow = dim, entries = 0;
  for (const row of matrixRows.slice(1)) {
    const values = row.split(/\s+/);
    if (nextRow === dim) {
      if (!values.every(value => /^\d+$/.test(value))) return null;
      columns = values.map(Number);
      if (!columns.length || columns.some(col => col >= dim) || new Set(columns).size !== columns.length) return null;
      nextRow = 0;
    } else {
      if (Number(values[0]) !== nextRow || values.length !== columns.length + 1) return null;
      for (const [i, col] of columns.entries()) { const value = numeric(values[i + 1]), index = nextRow * dim + col; if (!Number.isFinite(value) || seen[index]) return null; seen[index] = 1; matrix[index] = value; entries++; }
      nextRow++;
    }
  }
  if (nextRow !== dim || entries !== dim * dim) return null;
  for (let row = 0; row < dim; row++) for (let col = 0; col < row; col++) if (Math.abs(matrix[row * dim + col] - matrix[col * dim + row]) > 1e-7) return null;
  const scalar = (key: string) => { const lines = sections.get(key); if (!lines) return undefined; if (lines.length !== 1 || !Number.isInteger(Number(lines[0])) || key === '$multiplicity' && Number(lines[0]) < 1) return NaN; return Number(lines[0]); };
  const charge = scalar('$charge'), multiplicity = scalar('$multiplicity');
  return { atoms, charge, multiplicity };
}
