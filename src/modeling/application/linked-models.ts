import type { Structure } from '../../core/types';
import { createModelStoreLinkGroup } from '../../core/modeling/model-store';
import { clone, getFrozenAtomIds } from '../../core/modeling/graph';
import type { ModelCoordinate, ModelCoordinateObject, ModelDocument, ModelStore } from '../contracts';
import { modelCoordinateKey } from '../constraints';
import { superposeViewAtoms } from '../view-superposition';

export interface LinkedModelMember { store: ModelStore; canEdit?: () => boolean; isPresent?: () => boolean }
export interface LinkedModelsSnapshot { documentIds: string[]; status: 'active' | 'needs-alignment'; reason: string }
export interface AtomReindexCandidate { atomIds: string[]; rmsd: number; needsConfirmation: true }
export interface AtomReindexCandidates { candidates: AtomReindexCandidate[]; truncated: boolean; searchedNodes: number; reason: string }

function composition(structure: Structure) { return JSON.stringify(structure.atoms.map(atom => atom.element).sort()); }
function sequence(structure: Structure) { return JSON.stringify(structure.atoms.map(atom => [atom.id, atom.element])); }
function assertSameComposition(members: readonly LinkedModelMember[]) {
  const first = members[0].store.getSnapshot().draft.structure;
  if (!first.atoms.length || members.some(member => composition(member.store.getSnapshot().draft.structure) !== composition(first))) throw new Error('关联要求非空、原子数与元素组成完全相同的模型。');
}
function sequentialElements(members: readonly LinkedModelMember[]) {
  const elements = members[0].store.getSnapshot().draft.structure.atoms.map(atom => atom.element);
  return members.every(member => member.store.getSnapshot().draft.structure.atoms.every((atom, index) => atom.element === elements[index]));
}
function sharedKey(document: ModelDocument) {
  return JSON.stringify([document.selection.atomIds, getFrozenAtomIds(document),document.sharedConstraints?.enabled!==false,document.sharedConstraints?.frozenAtomIds??[], document.coordinateObjects ?? [],
    (document.sharedConstraints?.coordinates ?? []).map(row => [row.type, row.atomIds]), document.draft.structure.charge, document.draft.structure.multiplicity, document.electronicStateConfirmed ?? false]);
}
function linkedProjection(source: ModelDocument, target: ModelDocument): ModelDocument {
  const sourceAtoms = source.draft.structure.atoms, targetAtoms = target.draft.structure.atoms;
  if (sourceAtoms.length !== targetAtoms.length || sourceAtoms.some((atom, index) => atom.element !== targetAtoms[index].element)) throw new Error('逐位元素不匹配，关联同步未执行。');
  const map = new Map(sourceAtoms.map((atom, index) => [atom.id!, targetAtoms[index].id!]));
  const remap = (ids: string[]) => ids.map(id => { const mapped = map.get(id); if (!mapped) throw new Error('关联原子引用失效。'); return mapped; });
  const next = clone(target), oldObjects = target.coordinateObjects ?? [];
  const objects = (source.coordinateObjects ?? []).map(object => {
    const tuple = { type: object.type, atomIds: remap(object.atomIds) };
    const previous = oldObjects.find(row => modelCoordinateKey(row) === modelCoordinateKey(tuple));
    return { ...tuple, id: previous?.id ?? `linked:${source.id}:${object.id}` } satisfies ModelCoordinateObject;
  });
  const coordinates = (source.sharedConstraints?.coordinates ?? []).map(row => {
    const tuple = { type: row.type, atomIds: remap(row.atomIds) };
    const previous = target.sharedConstraints?.coordinates.find(item => modelCoordinateKey(item) === modelCoordinateKey(tuple));
    const object = objects.find(item => modelCoordinateKey(item) === modelCoordinateKey(tuple));
    // Numerical targets belong to this conformation. New freezes use its own
    // current geometry rather than copying a different conformation's value.
    return { ...(previous ? clone(previous) : {}), ...tuple, id: previous?.id ?? `linked-freeze:${object?.id ?? modelCoordinateKey(tuple)}`,
      ...(object ? { objectId: object.id } : {}), action: 'freeze', steps: 1, increment: null } satisfies ModelCoordinate;
  });
  next.selection.atomIds = remap(source.selection.atomIds);
  next.coordinateObjects = objects;
  const definedAtoms=[...new Set([...(source.sharedConstraints?.frozenAtomIds??[]),...getFrozenAtomIds(source)])];
  next.sharedConstraints = { canonical: true,...(source.sharedConstraints?.enabled===undefined?{}:{enabled:source.sharedConstraints.enabled}), frozenAtomIds: remap(definedAtoms), coordinates };
  next.draft.assignments.frozenAtomIds = [];
  // Frozen source layers project to atom locks; local layer membership remains
  // local, but cannot add a second hidden freeze set after synchronization.
  next.draft.assignments.layers = next.draft.assignments.layers.map(layer => layer.frozen ? { ...layer, frozen: false } : layer);
  next.draft.structure.charge = source.draft.structure.charge;
  next.draft.structure.multiplicity = source.draft.structure.multiplicity;
  next.electronicStateConfirmed = source.electronicStateConfirmed ?? false;
  return next;
}

/** Session-only membership. Existing store ports are intercepted by the core,
 * so UI controls, keyboard paths and replicas share the same transaction. */
export function createLinkedModels(members: readonly LinkedModelMember[], referenceDocumentId: string, restored?:{id:string;confirmedOrder:string[]|null}) {
  if (members.length < 2 || new Set(members.map(member => member.store)).size !== members.length) throw new Error('关联至少需要两个不同模型。');
  assertSameComposition(members);
  const member = (id: string) => { const found = members.find(entry => entry.store.getSnapshot().id === id); if (!found) throw new Error('模型不属于当前关联组。'); return found; };
  member(referenceDocumentId);
  let disposed = false, confirmedOrder: string[] | null = restored?clone(restored.confirmedOrder):sequentialElements(members) ? members.map(entry => sequence(entry.store.getSnapshot().draft.structure)) : null;
  const listeners = new Set<() => void>();
  const isAligned = () => !disposed && confirmedOrder !== null && members.every((entry, index) => sequence(entry.store.getSnapshot().draft.structure) === confirmedOrder![index]) && sequentialElements(members);
  const validate = () => {
    if (members.some(entry => entry.isPresent && !entry.isPresent())) throw new Error('原关联组成员已关闭，不能回放或修改整组历史。');
    if (members.some(entry => entry.canEdit && !entry.canEdit())) throw new Error('关联成员当前不可编辑或仍有异步操作；整组操作未提交。');
  };
  const assertActive = () => { if (disposed) throw new Error('关联会话已结束。'); validate(); };
  let state: LinkedModelsSnapshot;
  const refresh = () => { state = { documentIds: members.map(entry => entry.store.getSnapshot().id), status: isAligned() ? 'active' : 'needs-alignment', reason: isAligned() ? '' : '原子编号待对齐；请以当前激活模型为参照重新编号，再明确确认。' }; for (const listener of listeners) listener(); };
  const core = createModelStoreLinkGroup(members.map(entry => entry.store), { isAligned, sharedStateKey: sharedKey, mapDocument: linkedProjection, validate, projectState:()=>({referenceDocumentId,confirmedOrder:clone(confirmedOrder)}) },restored?.id);
  const unsubscribers = members.map(entry => entry.store.subscribe(refresh));
  try { if (!restored&&isAligned()) core.synchronize(member(referenceDocumentId).store); } catch (error) { unsubscribers.forEach(unsubscribe => unsubscribe()); core.dispose(); throw error; }
  refresh();
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    align(referenceId: string) {
      assertActive(); assertSameComposition(members); member(referenceId);
      if (!sequentialElements(members)) throw new Error('逐位元素仍不一致，不能确认关联。');
      const previous = confirmedOrder; confirmedOrder = members.map(entry => sequence(entry.store.getSnapshot().draft.structure));
      try { core.synchronize(member(referenceId).store); } catch (error) { confirmedOrder = previous; refresh(); throw error; } refresh();
    },
    reindex(documentId: string, orderedAtomIds: string[]) {
      assertActive(); const store = member(documentId).store, current = store.getSnapshot();
      store.execute({ type: 'reorder-atoms', atomIds: [...orderedAtomIds], documentId, expectedRevision: current.revision });
    },
    reindexMany(plans: { documentId: string; atomIds: string[]; expectedRevision: number }[], referenceId = referenceDocumentId) {
      assertActive(); core.reindexMany(plans.map(plan => ({ ...plan, store: member(plan.documentId).store })), member(referenceId).store);
      confirmedOrder = members.map(entry => sequence(entry.store.getSnapshot().draft.structure)); refresh();
    },
    swapAtomNumbers(documentId: string, firstId: string, secondId: string) {
      const store = member(documentId).store, ids = store.getSnapshot().draft.structure.atoms.map(atom => atom.id!);
      const first = ids.indexOf(firstId), second = ids.indexOf(secondId);
      if (first < 0 || second < 0 || first === second) throw new Error('交换编号需要两个不同且仍存在的原子。');
      [ids[first], ids[second]] = [ids[second], ids[first]];
      this.reindex(documentId, ids);
    },
    candidates(referenceId: string, targetId: string, options?: { maxCandidates?: number; maxSearchNodes?: number }) {
      return findAtomReindexCandidates(member(referenceId).store.getSnapshot().draft.structure, member(targetId).store.getSnapshot().draft.structure, options);
    },
    dispose() { if (disposed) return; core.dispose(); disposed = true; unsubscribers.forEach(unsubscribe => unsubscribe()); refresh(); listeners.clear(); },
  };
}
export type LinkedModels = ReturnType<typeof createLinkedModels>;

/** Complete graph isomorphisms are proposals only. A proper rigid fit ranks
 * symmetric alternatives but never silently decides reaction-atom identity. */
export function findAtomReindexCandidates(reference: Structure, target: Structure, options: { maxCandidates?: number; maxSearchNodes?: number } = {}): AtomReindexCandidates {
  const maxCandidates = options.maxCandidates ?? 64, maxSearchNodes = options.maxSearchNodes ?? 100000;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || !Number.isSafeInteger(maxSearchNodes) || maxSearchNodes < 1) throw new Error('原子对应搜索预算无效。');
  const result: AtomReindexCandidates = { candidates: [], truncated: false, searchedNodes: 0, reason: '' };
  if (!reference.atoms.length || reference.atoms.length !== target.atoms.length || composition(reference) !== composition(target)) return { ...result, reason: '原子数或元素组成不同，无法重新编号。' };
  if([reference,target].some(structure=>structure.atoms.length>1&&!Array.isArray(structure.bonds)))return{...result,reason:'键连尚未确定，不能按无键图猜编号；请先确认成键，或使用手动交换编号。'};
  if (reference.atoms.length > 1 && (reference.bonds === undefined || target.bonds === undefined)) return { ...result, reason: '缺少明确键连图；不能以元素或空间近邻替代化学对应。' };
  for (const structure of [reference, target]) if (structure.atoms.some(atom => !atom.id || ![atom.x, atom.y, atom.z].every(Number.isFinite)) || new Set(structure.atoms.map(atom => atom.id)).size !== structure.atoms.length) return { ...result, reason: '稳定原子ID或坐标无效。' };
  const adjacency = (structure: Structure) => {
    const rows = structure.atoms.map(() => new Map<number, string[]>());
    for (const bond of structure.bonds ?? []) {
      if (!rows[bond.a] || !rows[bond.b] || bond.a === bond.b) throw new Error('键图含无效原子引用。');
      const label = (reverse: boolean) => JSON.stringify([bond.aromatic || bond.order === 4 ? 1.5 : bond.order, bond.kind ?? 'covalent', bond.fractional ?? false, (bond.image ?? [0, 0, 0]).map(value => reverse && value ? -value : value)]);
      rows[bond.a].set(bond.b, [...(rows[bond.a].get(bond.b) ?? []), label(false)].sort());
      rows[bond.b].set(bond.a, [...(rows[bond.b].get(bond.a) ?? []), label(true)].sort());
    }
    return rows;
  };
  const ra = adjacency(reference), ta = adjacency(target), n = reference.atoms.length;
  const signatures = (structure: Structure, rows: Map<number, string[]>[]) => structure.atoms.map((atom, index) => JSON.stringify([atom.element, [...rows[index]].map(([other, labels]) => [structure.atoms[other].element, labels]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  const rs = signatures(reference, ra), ts = signatures(target, ta);
  const allowed = rs.map(signature => ts.flatMap((candidate, index) => signature === candidate ? [index] : []));
  if (allowed.some(row => !row.length)) return { ...result, reason: '元素及带键型的邻接关系不一致，没有完整同构方案。' };
  const order = Array.from({ length: n }, (_, index) => index).sort((a, b) => allowed[a].length - allowed[b].length || ra[b].size - ra[a].size || a - b);
  const mapping = new Array<number>(n).fill(-1), used = new Set<number>();
  const walk = (depth: number) => {
    if (result.searchedNodes >= maxSearchNodes || result.candidates.length >= maxCandidates) { result.truncated = true; return; }
    result.searchedNodes++;
    if (depth === n) {
      const pairs = mapping.map((index, referenceIndex) => ({ movingAtomId: target.atoms[index].id!, referenceAtomId: reference.atoms[referenceIndex].id! }));
      const fit = superposeViewAtoms({ movingAtoms: target.atoms, referenceAtoms: reference.atoms, pairs, mappingConfirmed: true });
      if (fit.ok) result.candidates.push({ atomIds: mapping.map(index => target.atoms[index].id!), rmsd: fit.rmsd, needsConfirmation: true });
      else result.reason = fit.issues.map(issue => issue.message).join(' ');
      return;
    }
    const ref = order[depth];
    for (const candidate of allowed[ref]) {
      if (used.has(candidate)) continue;
      if (order.slice(0, depth).some(prior => JSON.stringify(ra[ref].get(prior) ?? []) !== JSON.stringify(ta[candidate].get(mapping[prior]) ?? []))) continue;
      mapping[ref] = candidate; used.add(candidate); walk(depth + 1); used.delete(candidate); mapping[ref] = -1;
      if (result.truncated) break;
    }
  };
  walk(0);
  result.candidates.sort((a, b) => a.rmsd - b.rmsd || JSON.stringify(a.atomIds).localeCompare(JSON.stringify(b.atomIds)));
  result.reason ||= result.candidates.length ? result.truncated ? '已达到搜索预算；所列方案不保证穷尽，须明确确认原子对应。' : '方案按刚体对齐后位移排序；须明确确认，不能视为反应原子映射。' : '没有找到保持元素与键连的完整同构方案。';
  return result;
}
