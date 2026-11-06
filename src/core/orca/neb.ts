import type { InputStructureSource, Structure } from '../types';
import { ELEMENTS } from '../elements';
import { inputStructureBodyMatches, inputStructureSourceIsCurrent } from '../input-structure-source';
import type { OrcaJobRequest, OrcaNebConvergence, OrcaNebSettings, OrcaNebTsConvergence, OrcaRenderContext, OrcaTaskRender } from './types';
import { safeOrcaFilename } from './validation';

/** Reviewed against ORCA 6.0 §7.29 and 6.1 §4.5; these are display defaults only. */
export function orcaNebConvergenceDefaults(variant: 'ci-neb' | 'neb-ts' = 'ci-neb') {
  return { convType: 'all' as const, maxForceCI: variant === 'neb-ts' ? 2e-3 : 5e-4,
    rmsForceCI: variant === 'neb-ts' ? 1e-3 : 2.5e-4, turnOnCI: .02, toleranceScale: 10, maxIterations: 500 };
}
const nebFields: [keyof OrcaNebConvergence, string][] = [['maxForceCI', 'Tol_MaxF_CI'], ['rmsForceCI', 'Tol_RMSF_CI'], ['turnOnCI', 'Tol_Turn_On_CI'], ['toleranceScale', 'Tol_Scale'], ['maxIterations', 'MaxIter']];
const tsFields: [keyof OrcaNebTsConvergence, string][] = [['maxGradient', 'TolMaxG'], ['rmsGradient', 'TolRMSG'], ['energyChange', 'TolE'], ['maxDisplacement', 'TolMaxD'], ['rmsDisplacement', 'TolRMSD'], ['maxIterations', 'MaxIter']];
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const hasValues = (value: object | undefined) => !!value && Object.values(value).some(item => item !== undefined);
const compactKeys = ['maxForceCI', 'rmsForceCI', 'turnOnCI', 'maxIterations'] as const;
export function orcaNebCustomConvergenceEnabled(settings: OrcaNebSettings): boolean {
  return settings.customConvergenceEnabled ?? compactKeys.some(key => settings.convergence?.[key] !== undefined);
}
/** ConvType/Tol_Scale retain their independent legacy semantics. */
export function orcaNebEffectiveConvergence(settings: OrcaNebSettings): OrcaNebConvergence | undefined {
  if (orcaNebCustomConvergenceEnabled(settings)) return settings.convergence;
  if (!settings.convergence) return undefined;
  return { convType: settings.convergence.convType, toleranceScale: settings.convergence.toleranceScale };
}

export function renderOrcaNeb(req: OrcaJobRequest, ctx: OrcaRenderContext): OrcaTaskRender {
  const result: OrcaTaskRender = { keywords: [], blocksBeforeCoordinates: [], blocksAfterCoordinates: [], files: [], issues: [] };
  const error = (field: string, message: string) => result.issues.push({ field, message, severity: 'error' });
  const s = req.settings.neb, reactant = req.structure;
  const variant = s.variant ?? 'ci-neb';
  if (!['ci-neb', 'neb-ts'].includes(variant)) error('neb.variant', '未知NEB模式，须选择CI-NEB或NEB-TS。');
  if (!reactant || !s.product) { error('neb.product', 'NEB需要反应物与Product两端真实结构。'); return result; }
  const reactantSource = s.reactantSource;
  if (reactantSource != null && (!inputStructureSourceIsCurrent(reactantSource, req.inputSources) || reactantSource.confirmed !== true
    || reactantSource.structure.charge !== reactantSource.charge || reactantSource.structure.multiplicity !== reactantSource.multiplicity
    || !inputStructureBodyMatches(reactantSource, reactant, req.charge, req.multiplicity) || !req.electronicStateConfirmed)) error('neb.reactantSource', '反应物来源已变、已关闭或与当前坐标/已确认电子态不一致，请重新选择并核对。');
  function orderedStructure(structure: Structure, source: InputStructureSource | null | undefined,
    mapping: { reactantId: string; productId: string }[] | undefined, confirmed: boolean | undefined, field: 'product' | 'tsGuess') {
    const label = field === 'product' ? 'Product' : 'TS初猜';
    if (source != null && (!inputStructureSourceIsCurrent(source, req.inputSources) || source.confirmed !== true
      || source.structure.charge !== source.charge || source.structure.multiplicity !== source.multiplicity
      || !inputStructureBodyMatches(source, structure, structure.charge!, structure.multiplicity!)
      || source.charge !== req.charge || source.multiplicity !== req.multiplicity || !req.electronicStateConfirmed)) {
      error(`neb.${field}Source`, `${label}文档来源已关闭、变更、声明无效或电子态/坐标不相容；须显式重新选择并核对真实快照。`);
      return [];
    }
    const mappingField = field === 'product' ? 'neb.mapping' : 'neb.tsGuessMapping';
    if (!confirmed) error(mappingField, `须确认${label}逐原子一一映射，不能凭元素排列推断身份。`);
    if (!Array.isArray(structure.atoms) || !Array.isArray(mapping) || mapping.some(pair => !pair || typeof pair.reactantId !== 'string' || typeof pair.productId !== 'string')) { error(mappingField, `${label}原子或映射记录无效。`); return []; }
    const ids = reactant!.atoms.map(atom => atom.id), otherIds = structure.atoms.map(atom => atom.id);
    if (ids.some(id => !id) || otherIds.some(id => !id) || new Set(ids).size !== ids.length || new Set(otherIds).size !== otherIds.length) error(mappingField, `${label}与反应物原子必须具有唯一稳定身份。`);
    const pairs = new Map(mapping.map(pair => [pair.reactantId, pair.productId]));
    if (structure.atoms.length !== ids.length || mapping.length !== ids.length || pairs.size !== ids.length || new Set(mapping.map(pair => pair.productId)).size !== otherIds.length || mapping.some(pair => !ids.includes(pair.reactantId) || !otherIds.includes(pair.productId))) error(mappingField, '映射必须完整覆盖且一一对应，不能遗漏、重复或引用失效原子。');
    const ordered = reactant!.atoms.map(atom => structure.atoms.find(other => other.id === pairs.get(atom.id!)));
    if (ordered.some((atom, index) => !atom || atom.element !== reactant!.atoms[index].element)) error(mappingField, '每对映射原子元素必须相同。');
    if (structure.charge === null || structure.multiplicity === null || structure.charge !== req.charge || structure.multiplicity !== req.multiplicity || !req.electronicStateConfirmed) error(`neb.${field}`, `须核对${label}与反应物同一已确认电荷/自旋态。`);
    if (structure.cell || structure.dimension === 2 || structure.atoms.some(atom => !ELEMENTS.includes(atom.element) || ![atom.x, atom.y, atom.z].every(Number.isFinite))) error(`neb.${field}`, `${label}须为有限、显式非周期三维Cartesian坐标（Å）。`);
    return ordered;
  }
  const orderedProduct = orderedStructure(s.product, s.productSource, s.mapping, s.mappingConfirmed, 'product');
  const orderedTs = s.tsGuess ? orderedStructure(s.tsGuess, s.tsGuessSource, s.tsGuessMapping, s.tsGuessMappingConfirmed, 'tsGuess') : null;
  if (!s.tsGuess && s.tsGuessSource != null) error('neb.tsGuessSource', 'TS初猜来源存在但结构已缺失，请重新选择或清除来源。');
  if (!Number.isSafeInteger(s.images) || s.images < 3) error('neb.images', 'NEB总珠子数必须为含两个端点的至少3个整数。');
  if (!['sidpp', 'idpp', 'linear'].includes(s.interpolation)) error('neb.interpolation', '未知初始路径插值方式。');
  if (typeof s.freeEnds !== 'boolean' || typeof s.preOptimize !== 'boolean') error('neb.endpoints', '端点策略须明确选择。');
  if (req.settings.version === '5' && s.interpolation === 'sidpp') error('neb.interpolation', 'S-IDPP需要ORCA 6.0或已核对后续版本。');
  const overrides = orcaNebEffectiveConvergence(s);
  if (s.customConvergenceEnabled !== undefined && typeof s.customConvergenceEnabled !== 'boolean') error('neb.customConvergenceEnabled', '自定义收敛参数启用状态无效。');
  if (req.settings.version === '5' && (variant === 'neb-ts' || s.tsGuess || hasValues(overrides))) error('neb.version', 'NEB-TS、TS初猜及收敛参数的本模块已核对接口需要ORCA 6.0。');
  if (overrides?.convType !== undefined && !['all', 'cionly'].includes(overrides.convType)) error('neb.convergence.convType', 'ConvType只支持all或CIOnly。');
  function renderOverrides(value: OrcaNebConvergence | OrcaNebTsConvergence | undefined, fields: [string, string][], prefix: string) {
    const lines: string[] = [];
    for (const [key, keyword] of fields) {
      const number = (value as Record<string, unknown> | undefined)?.[key];
      if (number === undefined) continue;
      if (!positive(number) || key === 'maxIterations' && !Number.isSafeInteger(number)) error(`${prefix}.${key}`, `${keyword}须为有限正数${key === 'maxIterations' ? '整数' : ''}。`);
      else lines.push(`  ${keyword} ${number}`);
    }
    return lines;
  }
  const nebLines = renderOverrides(overrides, nebFields, 'neb.convergence');
  if (overrides?.convType !== undefined) nebLines.unshift(`  ConvType ${overrides.convType === 'cionly' ? 'CIOnly' : 'all'}`);
  const tsLines = variant === 'neb-ts' ? renderOverrides(s.tsConvergence, tsFields, 'neb.tsConvergence') : [];
  if (result.issues.some(issue => issue.severity === 'error')) return result;
  function addXyz(suffix: string, ordered: typeof orderedProduct, comment: string) {
    const name = `${ctx.stem}-${suffix}.xyz`;
    if (!safeOrcaFilename(name)) { error('name', 'NEB附属结构文件名必须为安全ASCII basename。'); return name; }
    result.files.push({ name, role: 'structure', text: `${ordered.length}\n${comment}\n${ordered.map(atom => `${atom!.element} ${atom!.x} ${atom!.y} ${atom!.z}`).join('\n')}\n` });
    return name;
  }
  const productName = addXyz('product', orderedProduct, 'Mapped Product; original source is unchanged');
  const tsName = orderedTs ? addXyz('ts-guess', orderedTs, 'Mapped TS guess; Angstrom; original source is unchanged') : null;
  result.keywords = [variant === 'neb-ts' ? 'NEB-TS' : 'NEB-CI'];
  result.blocksBeforeCoordinates.push(['%neb', `  Product "${productName}"`, ...(tsName ? [`  TS "${tsName}"`] : []), `  NImages ${s.freeEnds ? s.images : s.images - 2}`, `  Free_End ${s.freeEnds}`, `  PreOpt ${s.preOptimize}`, `  Interpolation ${s.interpolation === 'linear' ? 'LINEAR' : 'IDPP'}`, ...(s.interpolation === 'sidpp' ? ['  SIDPP true'] : []), ...nebLines, 'end'].join('\n'));
  if (tsLines.length) result.blocksBeforeCoordinates.push(['%geom', ...tsLines, 'end'].join('\n'));
  return result;
}
