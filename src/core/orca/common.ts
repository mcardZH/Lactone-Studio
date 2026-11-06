import type { Structure } from '../types';
import { ELEMENTS } from '../elements';
import { findSolventEntry } from '../solvents';
import { buildOrca } from './build';
import { createOrcaSettings } from './defaults';
import { getOrcaMethodProfile, getOrcaMethods, ORCA_VERSIONS } from './catalog';
import { referencedOrcaAssets } from './assets';
import { orcaNebEffectiveConvergence } from './neb';
import type { OrcaBuildResult, OrcaJobRequest, OrcaMethodId, OrcaSettings, OrcaTask, OrcaVersion } from './types';

export interface OrcaCommonCompatibility {
  /** Writer syntax, independent of the retained asset target/version identity. */
  syntaxVersion: OrcaVersion;
  minimumVersion: OrcaVersion;
  reasons: string[];
}
const rank = (version: OrcaVersion) => ORCA_VERSIONS.indexOf(version);
export const orcaMinimumLabel = (version: OrcaVersion) => version === '5' ? 'ORCA 5.0.3 起的共同写法' : `需要 ORCA ${version} 或已核对的后续版本`;

export function getOrcaCommonMethodProfile(method: OrcaMethodId) {
  return getOrcaMethodProfile(method, '6.1');
}
export function getOrcaCommonMethods(task?: OrcaTask) {
  return getOrcaMethods('6.1', task);
}
export function getOrcaMethodMinimumVersion(method: OrcaMethodId): OrcaVersion {
  return method === 'wb97x-3c' || method === 'revdsd-pbep86-d4-2021' ? '6.0' : '5';
}

/** New requests share the S-IDPP default; retained requests are never rewritten. */
export function createOrcaCommonSettings(task: OrcaTask = 'opt', structure?: Structure | null): OrcaSettings {
  return createOrcaSettings(task, structure);
}

/** This chooses documented syntax, never changes the user's scientific settings. */
export function getOrcaCommonCompatibility(req: OrcaJobRequest): OrcaCommonCompatibility {
  const s = req.settings;
  let syntaxVersion: OrcaVersion = '5';
  let minimumVersion: OrcaVersion = '5';
  const reasons: string[] = [];
  const requireSyntax = (version: OrcaVersion, reason: string) => {
    if (rank(version) > rank(syntaxVersion)) syntaxVersion = version;
    if (rank(version) > rank(minimumVersion)) minimumVersion = version;
    if (version !== '5') reasons.push(reason);
  };
  const methodVersion = getOrcaMethodMinimumVersion(s.method);
  requireSyntax(methodVersion, `${getOrcaCommonMethodProfile(s.method)?.label ?? s.method} 的已核对简单关键词需要 ORCA ${methodVersion}。`);
  if (s.task === 'neb' && s.neb.interpolation === 'sidpp') requireSyntax('6.0', '保留 S-IDPP；SIDPP true 的已核对接口需要 ORCA 6.0。');
  if (s.task === 'neb' && (s.neb.variant === 'neb-ts' || s.neb.tsGuess || Object.values(orcaNebEffectiveConvergence(s.neb) ?? {}).some(value => value !== undefined))) requireSyntax('6.0', 'NEB-TS、TS路径初猜及收敛参数按 ORCA 6.0/6.1 已核对接口写出。');

  // An explicit library ID carries its own profile provenance. Never relabel a
  // retained 6.x entry as a 5.x entry, even when the solvent name is identical.
  if (s.solvation?.mode !== 'custom' && (s.solvent.trim() || s.solvation?.mode === 'builtin')) {
    const name = s.solvation?.mode === 'builtin' ? s.solvation.id ?? '' : s.solvent;
    const profile = ORCA_VERSIONS.find(version => !!findSolventEntry('orca', s.solventModel, name, version));
    if (profile) requireSyntax(profile, `所选内置溶剂条目的已核对来源为 ORCA ${profile}，保留该条目及参数身份。`);
  }
  const atoms = req.structure?.atoms.filter(atom => s.multiscale.mode === 'none' || s.multiscale.qmAtomIds.includes(atom.id ?? '')) ?? [];
  const method = getOrcaCommonMethodProfile(s.method);
  // Analytic Raman derivatives are available with Freq from ORCA 6.1.
  // Preserve the existing frequency route; numeric-only methods retain NumFreq.
  // Source: ORCA 6.1 manual, spectroscopyproperties/vibrations.html, Raman Spectra.
  const analyticFrequencyTask = ['freq', 'optfreq', 'ts'].includes(s.task)
    || s.task === 'tdopt' && s.excited.frequency === true && s.excited.useUks;
  if (s.frequency?.raman && analyticFrequencyTask
    && s.multiscale.mode === 'none' && method?.frequency === 'analytic')
    requireSyntax('6.1', '解析频率的 Raman 极化率导数使用 ORCA 6.1 已核对的 Freq 与 %elprop Polar 1 接口。');
  if (method?.basisPolicy === 'uniform-def2' && s.basis.endsWith('D')
    && !['double-hybrid', 'coupled-cluster'].includes(method.family)
    && atoms.some(atom => ELEMENTS.indexOf(atom.element) >= 57 && ELEMENTS.indexOf(atom.element) <= 70))
    requireSyntax('6.1', 'Ce–Lu 弥散 def2 轨道基组覆盖仅按已核对 ORCA 6.1 开放；AuxC 的独立覆盖门仍保留。');
  if (method?.family === 'composite' && method.id !== 'wb97x-3c' && atoms.some(atom => ELEMENTS.indexOf(atom.element) >= 86))
    requireSyntax('6.1', '3c 的较重元素范围按 ORCA 6.1 扩展核对；具体方法的元素上限仍单独校验。');

  const selectedAssets = referencedOrcaAssets(req);
  if (selectedAssets.length && ORCA_VERSIONS.includes(s.version)) {
    if (rank(s.version) > rank(minimumVersion)) minimumVersion = s.version;
    reasons.push(`保留依赖的原目标版本身份 ORCA ${s.version}；共同语法不表示该资产可被更旧版本读取。`);
  }
  for (const asset of selectedAssets) {
    const version = asset.kind === 'gbw' ? asset.orbitalEvidence?.version : asset.hessianEvidence?.version;
    if (version && ORCA_VERSIONS.includes(version) && rank(version) > rank(minimumVersion)) minimumVersion = version;
  }
  return { syntaxVersion, minimumVersion, reasons: [...new Set(reasons)] };
}

/** Common syntax is a rendering policy; the retained asset target is not reset. */
export function buildOrcaCommon(req: OrcaJobRequest): OrcaBuildResult {
  const compatibility = getOrcaCommonCompatibility(req);
  // A corrupted/unknown retained profile must not be repaired by choosing 5.x.
  if (!ORCA_VERSIONS.includes(req.settings.version)) return buildOrca(req);
  const normalized = { ...req, settings: { ...req.settings, version: compatibility.syntaxVersion } };
  const result = buildOrca(normalized, req.settings.version);
  if (compatibility.minimumVersion !== '5') result.issues.push({ field: 'compatibility', severity: 'warning',
    message: `${orcaMinimumLabel(compatibility.minimumVersion)}。${compatibility.reasons.join(' ')}` });
  return result;
}
