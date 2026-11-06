import { ELEMENTS, electronicStateError } from '../elements';
import { getOrcaMethodProfile, ORCA_BASES, ORCA_CORRELATION_BASES, ORCA_VERSIONS } from './catalog';
import { referencedOrcaAssets } from './assets';
import { orcaScfGridCapabilities } from './header';
import type { OrcaIssue, OrcaJobRequest, OrcaVersion } from './types';

export const safeOrcaFilename = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && !name.endsWith('.') && !name.includes('..') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
export function validateOrca(req: OrcaJobRequest, assetTargetVersion: OrcaVersion = req.settings.version): OrcaIssue[] {
  const issues: OrcaIssue[] = [];
  const error = (field: string, message: string) => issues.push({ field, message, severity: 'error' });
  const warning = (field: string, message: string) => issues.push({ field, message, severity: 'warning' });
  const s = req.settings;
  const method = getOrcaMethodProfile(s.method, s.version);
  if (!ORCA_VERSIONS.includes(s.version)) error('version', '请选择已核对的 ORCA 5、6.0 或 6.1 版本。');
  if (!method) error('method', '此方法关键词尚未在所选 ORCA 版本核对支持。');
  else if (!method.tasks.includes(s.task)) error('task', '所选方法的该任务能力尚未核实，请保留原任务并另选适用方法。');
  if (!safeOrcaFilename(req.name) || req.name.length > 100) error('name', '文件名仅可用安全 ASCII 字母、数字、点、连字符和下划线。');
  if (!Number.isSafeInteger(req.cores) || req.cores < 1) error('cores', 'CPU 核数必须为可精确表示的正整数。');
  if (!Number.isFinite(req.memoryGB) || req.memoryGB <= 0) error('memoryGB', '请填写有限正数的总内存 GB。');
  else if (Number.isSafeInteger(req.cores) && req.cores > 0) {
    const maxcore = Math.floor(req.memoryGB * (768 / req.cores));
    if (maxcore < 1) error('memoryGB', '分配后每进程内存不足 1 MB。');
    else if (!Number.isSafeInteger(maxcore)) error('memoryGB', '每进程 %maxcore 的整数 MB 无法精确表示，请修改输入内存或核数。');
  }
  if (!req.electronicStateConfirmed) error('electronicStateConfirmed', '请确认电荷与多重度；电子奇偶检查不代替物理态确认。');
  if (req.resourcesConfirmed === false) error('resourcesConfirmed', '请确认本次输入的核数与内存。');
  const capabilities = orcaScfGridCapabilities(s);
  if (capabilities.scf) {
    if (s.scf?.convergence !== undefined && !['default','loose','normal','strong','tight','verytight'].includes(s.scf.convergence)) error('scf.convergence', '未知SCF收敛设置。');
    if (s.scf?.strategy !== undefined && !['default','SlowConv','VerySlowConv'].includes(s.scf.strategy)) error('scf.strategy', '未知SCF收敛策略。');
    if (s.scf?.algorithm !== undefined && !['auto','KDIIS','SOSCF','TRAH'].includes(s.scf.algorithm)) error('scf.algorithm', '未知SCF算法。');
    if (s.scf?.maxIterations !== undefined && (!Number.isSafeInteger(s.scf.maxIterations) || s.scf.maxIterations < 1)) error('scf.maxIterations', 'SCF MaxIter须为正整数。');
  }
  if (capabilities.grid && s.grid !== undefined && !['auto','DefGrid1','DefGrid2','DefGrid3'].includes(s.grid)) error('grid', '未知积分网格设置。');
  const structure = req.structure;
  if (!structure?.atoms.length) error('structure', '请提供完整三维结构。');
  else {
    if (structure.dimension === 2) error('structure', '二维绘图须先生成并确认三维坐标。');
    if (structure.cell?.pbc.some(Boolean)) error('structure', '当前 ORCA 输入模块只生成有限分子，周期边界需另定模型。');
    if (structure.atoms.some(atom => !ELEMENTS.includes(atom.element) || ![atom.x, atom.y, atom.z].every(Number.isFinite))) error('structure', '结构包含未知元素或非有限坐标，不能丢弃原子修复。');
    else {
      const state = electronicStateError(structure.atoms, req.charge, req.multiplicity);
      if (state) error('multiplicity', state);
    }
    const ids = structure.atoms.map((atom, index) => atom.id ?? `atom-${index + 1}`);
    if (new Set(ids).size !== ids.length) error('structure', '原子稳定身份重复，不能安全引用选区。');
    const known = new Set(ids);
    const quantumAtoms = s.multiscale.mode === 'none' ? structure.atoms : structure.atoms.filter((_, index) => s.multiscale.qmAtomIds.includes(ids[index]));
    const references = [...s.frozenAtomIds, ...s.constraints.flatMap(row => row.atomIds), ...s.md.activeAtomIds, ...s.md.constraints.flatMap(row => row.atomIds), ...s.fragments.flatMap(fragment => fragment.atomIds), ...s.multiscale.qmAtomIds, ...s.multiscale.boundaries.flatMap(row => [row.qmAtomId, row.lowAtomId])];
    if (references.some(id => !known.has(id))) error('atomIds', '选区引用已失效的原子身份，请重新选择。');
    if (method?.basisPolicy === 'uniform-def2') {
      const correlated = method.family === 'double-hybrid' || method.family === 'coupled-cluster';
      const diffuse = s.basis.endsWith('D');
      if (quantumAtoms.some(atom => ELEMENTS.indexOf(atom.element) >= 86)) error('basis', '当前 def2 轨道/辅助基组覆盖限 H–Rn，请另定已验证方案。');
      if (diffuse && (s.version !== '6.1' || correlated) && quantumAtoms.some(atom => ELEMENTS.indexOf(atom.element) >= 57 && ELEMENTS.indexOf(atom.element) <= 70)) error('basis', '所选版本弥散 def2 轨道或相关 AuxC 未覆盖 Ce–Lu，不能用其它拟合集冒充。');
    }
    if (s.excited.soc && structure.atoms.some(atom => ELEMENTS.indexOf(atom.element) >= 36)) error('excited.soc', '当前 SOC 模块未支持含 def2-ECP 中心的组合，须先核对全电子相对论方案。');
    if (method?.family === 'xtb' && structure.atoms.some(atom => ELEMENTS.indexOf(atom.element) >= 86)) error('method', 'GFN2-xTB 元素覆盖限 H–Rn。');
    if (method?.family === 'composite') {
      const limit = s.version !== '6.1' || method.id === 'wb97x-3c' ? 86 : method.id === 'r2scan-3c' ? 103 : 94;
      if (quantumAtoms.some(atom => ELEMENTS.indexOf(atom.element) >= limit)) error('method', `所选版本与3c方法的已核对元素范围止于 ${ELEMENTS[limit - 1]}。`);
    }
  }
  if (method?.basisPolicy === 'uniform-def2' && !ORCA_BASES.includes(s.basis as typeof ORCA_BASES[number])) error('basis', '请选择一套统一的已核对 def2 轨道基组；辅助拟合集不算混合基组。');
  if ((method?.family === 'double-hybrid' || method?.family === 'coupled-cluster') && !ORCA_CORRELATION_BASES[s.basis]) error('basis', '所选轨道基组没有已核对的同名匹配 AuxC，请选择配套相关拟合集已核实的基组。');
  if (method?.basisPolicy !== 'uniform-def2' && s.basis.trim()) error('basis', '3c 方法使用内置基组，XTB2 不使用轨道基组；请移除外加基组。');
  if (s.excited.soc && (!method?.soc || req.multiplicity !== 1 || s.unrestricted || s.excited.useUks || !['td', 'esd'].includes(s.task))) error('excited.soc', 'SOC 仅开放已核对的闭壳层 DFT 响应任务，不能拼接到此方法/电子态。');
  if (s.task === 'nmr' && s.nmr === 'coupling' && ['wb97m-v', 'wb97x-v'].includes(s.method)) error('nmr', 'VV10 的磁屏蔽响应支持不等于FC/SD等全部核耦合响应已支持，当前组合未核实。');
  if (method?.family === 'coupled-cluster' || method?.family === 'double-hybrid') warning('method', '此路线依赖单参考适用性；PNO 与基组等级不构成准确性保证。');
  if (method?.family === 'double-hybrid' && (s.unrestricted || req.multiplicity !== 1 || (s.task === 'bsse' && s.fragments.some(fragment => fragment.multiplicity !== 1)))) error('method', '本模块尚未核对所选双杂化的开壳层实现与自旋参考，只开放已核对的闭壳层单点组合。');
  if (!['normal', 'tight', 'loose'].includes(s.pno)) error('pno', '未知 PNO 等级。');
  const assetIds = new Set<string>();
  const assetNames = new Set<string>();
  for (const asset of req.assets) {
    if (!asset.id || assetIds.has(asset.id)) error('assets', '依赖文件身份缺失或重复。');
    assetIds.add(asset.id);
    if (!safeOrcaFilename(asset.name) || assetNames.has(asset.name.toLowerCase()) || asset.name.toLowerCase().startsWith(`${req.name}.`.toLowerCase())) error('assets', '依赖文件名不安全、重复或与本作业输出同名，可能被覆盖。');
    assetNames.add(asset.name.toLowerCase());
    if (asset.text !== undefined && typeof asset.text !== 'string') error('assets', '文本依赖须为实际字符串，不能将未知数据转成文本。');
    else if (typeof asset.text === 'string' && asset.text.includes('\0')) error('assets', '文本依赖含 NUL，不能作为完整文本交付。');
  }
  if (s.initialOrbitalsId) {
    if (method?.family === 'xtb') error('initialOrbitalsId', 'XTB2 不使用本模块的 ORCA MORead/GBW 初猜接口。');
    const orbitals = req.assets.find(asset => asset.id === s.initialOrbitalsId && asset.kind === 'gbw');
    if (!orbitals) error('initialOrbitalsId', '初猜必须引用已提供的 GBW 依赖。');
    else {
      if (!/\.gbw$/i.test(orbitals.name)) error('initialOrbitalsId', '初猜引用须为同目录的安全.gbw文件名。');
      if (orbitals.text !== undefined) error('initialOrbitalsId', 'GBW 是二进制依赖，不能把文本或Base64字符串作为其原始文件交付。');
      if (s.task === 'bsse') error('initialOrbitalsId', 'BSSE各独立ghost体系需要各自兼容初猜，不能把全体系GBW复用到所有片段。');
      warning('initialOrbitalsId', '输入将引用同目录GBW文件；尚未验证文件存在、内容或物理相容性。');
    }
  }
  for (const asset of referencedOrcaAssets(req).filter(asset => s.task === 'esd' && asset.kind === 'hessian')) {
    const version = asset.hessianEvidence?.version;
    // A parsed Hessian is physical matrix data, not a version-bound GBW binary.
    // Keep source identity, but do not invent a same-version format restriction.
    if (version !== undefined && !ORCA_VERSIONS.includes(version))
      error('assets.hessian.version', '声明的 Hessian 来源版本尚未核对；不能推测未知来源格式相容。已核来源仍按实际矩阵、单位、质量、原子顺序和物理态核对。');
  }
  return issues;
}
