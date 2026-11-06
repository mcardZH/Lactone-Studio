import { deriveInheritedSettings, type GaussianSourceMeta, type InheritedRouteSettings, type SourceIssue } from './gaussian-source';
import { getOrcaMethodProfile } from './orca/catalog';
import { getSolventEntries } from './solvents';
import type { GaussianSettings } from './types';
import type { OrcaInputSourceMeta, OrcaSettings } from './orca/types';

export interface SourceLevelInheritance<T> { settings: T; applied: boolean; issues: SourceIssue[] }
const blocking = (issue: SourceIssue) => issue.severity !== 'warning' && ['level','method','basis','ecp','dispersion','solvent'].includes(issue.field ?? '');
const fail = <T>(settings: T, issues: SourceIssue[], code: string, message: string, field = 'level'): SourceLevelInheritance<T> =>
  ({ settings, applied: false, issues: [...issues, { code, message, field, severity: 'unsupported' }] });

/** Source level is an explicit, narrow operation. The existing broad source
 * decoder is reused, then only reviewed level fields cross this boundary.
 * Task/SCF/grid/advanced/resources/constraints/scans never cross it.
 */
export function inheritGaussianSourceLevel(source: GaussianSourceMeta, current: GaussianSettings, context?: { basisIdentityMapped: true }): SourceLevelInheritance<GaussianSettings> {
  const issues = structuredClone(source.issues);
  if (source.files.basisFromCheckpoint) return fail(current, issues, 'source-level-chkbasis', 'CHK中的真实轨道基组未被解析，不能把ChkBasis转换为已继承的表单基组。', 'basis');
  if (!source.settings.method || issues.some(blocking)) return { settings: current, applied: false, issues };
  if (issues.some(issue => issue.code === 'route-extra' || issue.code === 'duplicate-route-field' && /(?:empiricaldispersion|\bem\b)/i.test(issue.message)))
    return fail(current, issues, 'source-level-route-review', '来源含未确认的级别相关路由文本，保留原文，不把它替换为默认计算级别。');
  const candidate = deriveInheritedSettings(source, current, current.task);
  let mixedBasis = source.settings.mixedBasis ? structuredClone(source.settings.mixedBasis) : undefined;
  if (mixedBasis?.enabled) {
    if (context?.basisIdentityMapped !== true) return fail(current, issues, 'source-level-basis-identity', '来源分区基组需要先由稳定原子身份映射到当前模型，不能直接重用原文件行号。', 'basis');
    if (mixedBasis.regions.some(region => !region.atoms.length || region.atoms.some(index => !Number.isSafeInteger(index) || index < 1)))
      return fail(current, issues, 'source-level-basis-member', '来源基组区域仍含失效或空成员，未自动移交到其它原子。', 'basis');
    // The model owner's imported stable-ID anchor already mapped these rows.
    // sourceIndex alone is not unique after cloning/adding/replacing atoms.
  } else if (source.routeOverrides.basisTail || source.routeOverrides.basisKeyword)
    return fail(current, issues, 'source-level-raw-basis', '来源原始Gen/ECP段尚不能安全绑定当前原子身份，保留原文且不复制旧中心编号。', 'basis');
  const inheritedRoute: InheritedRouteSettings = { ...current.inheritedRoute };
  for (const key of ['methodKeyword','basisTail','basisKeyword','angular','fForm'] as const) delete inheritedRoute[key];
  inheritedRoute.sourceId = source.id;
  for (const key of ['methodKeyword','angular','fForm'] as const) if (source.routeOverrides[key] !== undefined)
    Object.assign(inheritedRoute, { [key]: source.routeOverrides[key] });
  const settings: GaussianSettings = { ...current, inheritedRoute, mixedBasis,
    inheritanceIssues: [...(current.inheritanceIssues ?? []).filter(issue => !blocking(issue)), ...issues.filter(issue => blocking(issue))],
  };
  for (const key of ['method','customMethod','basis','dispersion','unrestricted','solvent','solventModel'] as const)
    if (source.settings[key] !== undefined) Object.assign(settings, { [key]: candidate[key] });
  // A source level change must not retain a foreign custom solvent descriptor.
  settings.solvation = source.settings.solvation ? structuredClone(source.settings.solvation) : undefined;
  if (source.routeOverrides.angular) settings.use5D = source.routeOverrides.angular === '5D';
  return { settings, applied: true, issues };
}

/** Only source combinations exactly expressible by the existing method profile
 * are inherited; e.g. plain B3LYP or B3LYP-D4 cannot become B3LYP-D3BJ.
 */
export function inheritOrcaSourceLevel(source: OrcaInputSourceMeta, current: OrcaSettings): SourceLevelInheritance<OrcaSettings> {
  const issues = structuredClone(source.issues), level = source.level;
  if (!level.method || issues.some(blocking)) return { settings: current, applied: false, issues };
  const method = getOrcaMethodProfile(level.method, current.version);
  if (!method || !method.tasks.includes(current.task)) return fail(current, issues, 'orca-source-level-target', '来源方法不属于当前已核实的任务/版本组合；当前任务保留，未自动换任务。', 'method');
  const expectedDispersion = method.keywords.some(keyword => /^d3bj$/i.test(keyword)) ? 'd3bj'
    : method.keywords.some(keyword => /^d4$/i.test(keyword)) ? 'd4'
    : method.family === 'composite' || /(?:-d3|-d4|-[vm])(?:\/\d+)?$/i.test(method.keywords[0]) ? 'builtin' : 'none';
  if (level.dispersion !== expectedDispersion) return fail(current, issues, 'orca-source-dispersion-profile', '已识别来源方法/色散原文，但当前方法预设不能准确写出该组合；未用预设色散替换来源。', 'dispersion');
  if (level.ecpKeywords.some(keyword => !/^def2-ecp$/i.test(keyword)) || level.ecpKeywords.length && method.basisPolicy !== 'uniform-def2')
    return fail(current, issues, 'orca-source-ecp-profile', '来源ECP不能由当前方法/统一def2基组策略准确表达。', 'ecp');
  if (method.basisPolicy === 'uniform-def2' && !level.basis) return fail(current, issues, 'orca-source-basis-unresolved', '来源轨道基组未可靠识别，未套用当前推荐基组。', 'basis');
  if (method.basisPolicy !== 'uniform-def2' && level.basisKeyword) return fail(current, issues, 'orca-source-builtin-basis', '来源为方法内置基组路线，却另外指定轨道基组；该组合不能准确继承。', 'basis');
  let solventId: string | undefined;
  if (level.solvent) {
    const solvent = level.solvent, entry = getSolventEntries('orca', solvent.model, current.version).find(entry =>
      (solvent.model === 'smd' ? entry.orca?.smd : entry.orca?.cpcm)?.toLowerCase() === solvent.name.toLowerCase());
    if (!entry) return fail(current, issues, 'orca-source-solvent-profile', '来源溶剂没有当前目标版本可用的可靠内置身份，未改成近似项。', 'solvent');
    solventId = entry.id;
  }
  const settings: OrcaSettings = { ...current, method: level.method, basis: method.basisPolicy === 'uniform-def2' ? level.basis! : '',
    solvent: level.solvent?.name ?? '', solvation: solventId ? { mode: 'builtin', id: solventId } : undefined,
    ...(level.solvent ? { solventModel: level.solvent.model, solventModelManuallySelected: true } : {}),
    ...(level.unrestricted === undefined ? {} : { unrestricted: level.unrestricted }),
  };
  return { settings, applied: true, issues };
}
