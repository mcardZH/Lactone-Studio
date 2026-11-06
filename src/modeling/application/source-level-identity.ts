import type { GaussianSourceMeta } from '../../core/gaussian-source';
import type { Structure } from '../../core/types';
import { sourceAtomIds, validateSourceAtomIdentity } from './source-model-state';

/** The imported source geometry is the stable-ID anchor. Moving coordinates does
 * not change its level; changed center order cannot reuse its raw Gen tail. */
export function remapSourceLevelToCurrent(source: GaussianSourceMeta, imported: Structure, current: Structure): GaussianSourceMeta {
  const next = structuredClone(source), numbers = new Map(current.atoms.map((atom, index) => [atom.id, index + 1]));
  if (numbers.has(undefined) || numbers.size !== current.atoms.length) throw new Error('当前模型原子身份缺失或重复。');
  const mixed = next.settings.mixedBasis;
  const identity = imported.sourceAtomIds ?? current.sourceAtomIds;
  if (!identity && (mixed?.enabled || next.routeOverrides.basisTail || next.routeOverrides.basisKeyword)) {
    next.issues.push({ code: 'source-basis-identity-unavailable', field: 'basis', severity: 'missing', message: '此来源没有首次导入时保存的中心稳定ID映射，不能将旧混合基组/Gen/ECP编号解释为当前原子；来源原文保留，请明确重新分配。' });
    return next;
  }
  validateSourceAtomIdentity({ sourceAtomIds: identity });
  const anchor = { ...imported, sourceAtomIds: identity };
  if (mixed) {
    let removedMembers = 0;
    mixed.regions = mixed.regions.map(region => {
      const ids = sourceAtomIds(anchor, region.atoms), atoms = ids.flatMap(id => numbers.has(id) ? [numbers.get(id)!] : []);
      removedMembers += ids.length - atoms.length;
      if (ids.length && !atoms.length) next.issues.push({ code: 'source-basis-region-empty', field: 'basis', severity: 'missing', message: `来源基组区域 ${region.name} 的成员已全部删除；保留空草稿，请明确重新分配或移除该区域。` });
      return { ...region, atoms };
    });
    if (removedMembers) next.issues.push({ code: 'source-basis-members-removed', field: 'basis', severity: 'warning', message: `来源基组已按稳定原子身份映射，移除 ${removedMembers} 个已删除成员；其它成员归属保留。` });
    const importedIds = new Set(identity);
    if (current.atoms.some(atom => atom.id === undefined || !importedIds.has(atom.id))) next.issues.push({ code: 'source-basis-new-centers', field: 'basis', severity: 'warning', message: '当前模型含来源未有的新原子，未自动加入来源基组区域；请核对它们使用的当前全局基组。' });
  }
  const sameCenters = identity?.length === current.atoms.length && identity.every((id, index) => id === current.atoms[index]?.id);
  if (!sameCenters && next.routeOverrides.basisTail) {
    delete next.routeOverrides.basisTail;
    if (mixed?.enabled) delete next.routeOverrides.basisKeyword;
    else next.issues.push({ code: 'source-basis-centers-changed', field: 'basis', severity: 'missing', message: '来源原子中心已改变，未映射的Gen/ECP原文不能按新序号复用；请明确分配基组。' });
  }
  return next;
}
