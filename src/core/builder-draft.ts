import { elementSymbol } from './elements';
import { validateBondSemantics, validateBondPerceptionIssues } from './bond-semantics';
import type { Bond, Structure, Vector3, InputLayerDraftRole } from './types';
import { editBuilderGeometry, transformBuilderSelection, placeBuilderHydrogens, inferBuilderBonds, initializeBuilderNewGeometry, validateBuilderValence, setBuilderDoubleBondConfiguration } from './builder-geometry';
import { attachBuilderTemplate } from './builder-templates';
import { synchronizeBuilderDoubleBondLayout } from './builder-layout';
import { updateBuilderStereo, assertBuilderStereoPreserved, requestedBuilder2DParity, builderTetrahedralParity, builderDoubleBondConfiguration } from './builder-stereo';

export interface BuilderAssignment {
  id: string; atomIds: string[]; label?: string; kind?: 'qm' | 'middle' | 'mm'; basis?: string; charge?: number; multiplicity?: number;
  /** Layer-derived physical freeze. User atom freezes remain independent in frozenAtomIds. */
  frozen?: boolean;
  draftRole?: InputLayerDraftRole;
}
export interface BuilderAssignments {
  layers: BuilderAssignment[]; basis: BuilderAssignment[]; fragments: BuilderAssignment[]; frozenAtomIds: string[];
}
interface BuilderSnapshot {
  structure: Structure; assignments: BuilderAssignments; selectedIds: string[]; touchedIds: string[]; assignmentIssues: string[];
  createdFrom: Record<string,string>;
}
export interface BuilderDraft extends BuilderSnapshot {
  revision: number; past: BuilderSnapshot[]; future: BuilderSnapshot[]; dirty: boolean;
  baseAtomIds: string[]; baseStructure: Structure; baseAssignments: BuilderAssignments;
}
export interface BuilderApplyResult {
  structure: Structure; assignments: BuilderAssignments; baseAtomIds: string[]; baseRevision: number; baseStructure: Structure; removedIds: string[]; touchedIds: string[]; assignmentIssues: string[];
}
export type BuilderCommand =
  | { type: 'add-atom'; element: string; position: Vector3; anchorId?: string; order?: number }
  | { type: 'delete-atoms'; atomIds: string[] }
  | { type: 'change-element'; atomIds: string[]; element: string }
  | { type: 'change-charge'; atomIds: string[]; charge: number }
  | { type: 'set-bond'; atomIds: [string, string]; order: number }
  | { type: 'delete-bond'; atomIds: [string, string] }
  | { type: 'attach-template'; templateId: string; anchorId?: string; replaceAtomIds?: string[]; position?: Vector3; direction?: Vector3 }
  | { type: 'geometry'; coordinate: 'B' | 'A' | 'D'; atomIds: string[]; value: number; moving: 'branch' | 'selected' | 'atom'; movingAtomIds?: string[]; fixedSide: 'first' | 'last' }
  | { type: 'translate'; atomIds: string[]; delta: Vector3 }
  | { type: 'rotate'; atomIds: string[]; axis: 'x' | 'y' | 'z'; degrees: number; pivot?: Vector3 }
  | { type: 'reflect'; atomIds: string[]; axis: 'x' | 'y' | 'z'; pivot?: Vector3 }
  | { type: 'invert-center'; atomId: string }
  | { type: 'add-hydrogens'; atomIds?: string[]; mode: 'auto' | 'explicit' };

const clone = <T,>(value: T): T => structuredClone(value);
const unique = (ids: string[]) => [...new Set(ids)];
const idOf = (structure: Structure, index: number): string => {
  const id = structure.atoms[index]?.id;
  if (!id) throw new Error('原子身份缺失；不能按数组顺序猜测映射。');
  return id;
};
const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `atom-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const periodic = (structure: Structure) => Boolean(structure.cell?.pbc.some(Boolean));
function validate(structure: Structure): void {
  const ids = structure.atoms.map(atom => atom.id), idSet = new Set(ids);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('原子ID必须存在且唯一。');
  for (const atom of structure.atoms) {
    elementSymbol(atom.element);
    if (![atom.x, atom.y, atom.z].every(Number.isFinite)) throw new Error('原子坐标必须是有限数值。');
    if (atom.formalCharge != null && !Number.isInteger(atom.formalCharge)) throw new Error('形式电荷必须是整数。');
  }
  const seen = new Set<string>();
  for (const bond of structure.bonds ?? []) {
    if (![bond.a, bond.b].every(i => Number.isInteger(i) && i >= 0 && i < ids.length) || (bond.a === bond.b && !bond.image?.some(Boolean))) throw new Error('键端点无效。');
    validateBondSemantics(bond,structure);
    if (bond.image && (bond.image.length!==3||bond.image.some((value,index)=>!Number.isSafeInteger(value)||value!==0&&(!structure.cell||!structure.cell.pbc[index])))) throw new Error('周期键平移必须是有效周期轴上的整数晶胞向量。');
    const key = bondIdentity(structure, bond, false);
    if (seen.has(key)) throw new Error('同一对原子存在重复键。');
    seen.add(key);
  }
  validateBondPerceptionIssues(structure);
  for (const [id, point] of Object.entries(structure.layout2D ?? {})) {
    if (!idSet.has(id) || ![point.x, point.y].every(Number.isFinite)) throw new Error('二维布局含无效身份或坐标。');
  }
}
function requireIds(structure: Structure, ids: string[]): number[] {
  const byId = new Map(structure.atoms.map((atom, index) => [atom.id, index]));
  const indices = unique(ids).map(id => byId.get(id));
  if (indices.some(index => index === undefined)) throw new Error('编辑目标已不存在；请重新选择原子。');
  return indices as number[];
}
function bondIdentity(structure: Structure, bond: Bond, chemistry = true): string {
  let a = idOf(structure, bond.a), b = idOf(structure, bond.b);
  let image = bond.image ?? [0, 0, 0];
  if (a > b || a===b&&(image.find(value=>value!==0)??0)<0) { [a, b] = [b, a]; image = image.map(v => -v||0) as Vector3; }
  const aromatic = !bond.fractional && (!!bond.aromatic || bond.order === 1.5 || bond.order === 4);
  return JSON.stringify([a, b, image, ...(chemistry ? [aromatic ? 'aromatic' : bond.order, bond.kind ?? 'covalent', ...(bond.fractional ? ['fractional'] : []),...(bond.orderKnown===false?['unknown-order']:[])] : [])]);
}
function graphIdentity(structure: Structure): string {
  return JSON.stringify({ atoms: structure.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))), bonds: (structure.bonds ?? []).map(bond => bondIdentity(structure, bond)).sort(), cell: structure.cell ?? null });
}
function aromaticHydrogenSignature(structure: Structure, id: string): string | null {
  const index=structure.atoms.findIndex(atom=>atom.id===id), atom=structure.atoms[index];
  if (!atom || atom.element !== 'N') return null;
  const neighbours=(structure.bonds ?? []).filter(bond => !bond.fractional && bond.kind !== 'coordination' && (bond.aromatic || bond.order === 1.5 || bond.order === 4) && (bond.a === index || bond.b === index))
    .map(bond => idOf(structure,bond.a === index ? bond.b : bond.a)).sort();
  return neighbours.length === 2 ? JSON.stringify([atom.element,atom.formalCharge ?? 0,neighbours]) : null;
}
/** Native [nH] intent survives geometry only. A graph mutation cannot silently
 * reuse that source annotation; a new reliable incoming annotation can replace it. */
function retainAromaticHydrogenHints(structure: Structure, previous?: Structure, authoritative = new Set<string>()): void {
  for (const atom of structure.atoms) {
    if (!atom.aromaticHydrogen) continue;
    const signature=aromaticHydrogenSignature(structure,atom.id!);
    const prior=previous?.atoms.find(candidate=>candidate.id===atom.id);
    if (!signature || (prior?.aromaticHydrogen && !authoritative.has(atom.id!) && aromaticHydrogenSignature(previous!,atom.id!) !== signature)) delete atom.aromaticHydrogen;
  }
}
function emptyAssignments(): BuilderAssignments { return { layers: [], basis: [], fragments: [], frozenAtomIds: [] }; }
function inheritanceAnchor(child: string, createdFrom: Record<string,string>): string {
  const visited = new Set<string>(); let parent = child;
  while (createdFrom[parent] && !visited.has(parent)) { visited.add(parent); parent = createdFrom[parent]; }
  return parent;
}
function snapshot(draft: BuilderSnapshot): BuilderSnapshot {
  return clone({ structure: draft.structure, assignments: draft.assignments, selectedIds: draft.selectedIds, touchedIds: draft.touchedIds, assignmentIssues: draft.assignmentIssues, createdFrom: draft.createdFrom });
}
function stateIdentity(structure: Structure, assignments: BuilderAssignments): string {
  const { revision: _revision, molfile: _molfile, preparation: _preparation, ...content } = structure;
  return JSON.stringify([content, assignments]);
}
function cleanAssignments(assignments: BuilderAssignments, structure: Structure, createdFrom: Record<string, string> = {}, baseline: BuilderAssignments = assignments): { assignments: BuilderAssignments; issues: string[] } {
  const result = clone(assignments), ids = new Set(structure.atoms.map(atom => atom.id!)), issues: string[] = [];
  for (const category of ['layers', 'basis', 'fragments'] as const) {
    for (const entry of result[category]) entry.atomIds = unique(entry.atomIds).filter(id => ids.has(id));
    for (const child of Object.keys(createdFrom)) {
      if (!ids.has(child)) continue;
      const parent = inheritanceAnchor(child, createdFrom);
      const activeMemberships = assignments[category].filter(entry => entry.atomIds.includes(parent));
      const memberships = activeMemberships.length ? activeMemberships : baseline[category].filter(entry => entry.atomIds.includes(parent));
      if (memberships.length > 1) issues.push(`${category}：锚点${parent}属于多个区域，新增原子${child}的归属待确认。`);
      else if (memberships.length === 1 && ids.has(child)) { const target = result[category].find(entry => entry.id === memberships[0].id)!; target.atomIds = unique([...target.atomIds, child]); }
    }
    const memberships = new Map<string, number>();
    for (const entry of result[category]) for (const id of entry.atomIds) memberships.set(id, (memberships.get(id) ?? 0) + 1);
    for (const [id, count] of memberships) if (count > 1) issues.push(`${category}：原子${id}的区域归属冲突。`);
    for (const entry of result[category]) if (!entry.atomIds.length) issues.push(`${category}：区域${entry.label ?? entry.id}已无有效原子，请复核。`);
  }
  result.frozenAtomIds = unique(result.frozenAtomIds).filter(id => ids.has(id));
  return { assignments: result, issues: unique(issues) };
}
function invalidate(structure: Structure): Structure {
  return { ...structure, molfile: undefined, preparation: undefined, sourceRoute: undefined, gaussianSource: undefined, gaussianSources: undefined };
}
function commit(draft: BuilderDraft, structure: Structure, touched: string[], createdFrom: Record<string, string> = {}, stereochemistry = true): BuilderDraft {
  createdFrom = { ...draft.createdFrom, ...createdFrom };
  structure = invalidate(clone(structure));
  if (structure.layout2D) structure.layout2D = Object.fromEntries(structure.atoms.map(atom => [atom.id!, structure.layout2D![atom.id!] ?? {x:atom.x,y:atom.y}]));
  if (stereochemistry) structure = synchronizeBuilderDoubleBondLayout(structure,touched);
  if (stereochemistry) { const stereo = updateBuilderStereo(structure); structure = stereo.structure; touched = unique([...touched,...stereo.touchedIds]); }
  validate(structure);
  const inherited = cleanAssignments(draft.assignments, structure, createdFrom, draft.baseAssignments);
  const ids = new Set(structure.atoms.map(atom => atom.id!));
  for (const category of ['layers', 'basis', 'fragments'] as const) for (const entry of draft.baseAssignments[category]) {
    if (entry.atomIds.some(id => !ids.has(id))) inherited.issues.push(`${category}：区域${entry.label ?? entry.id}的原子已删除，定义需复核。`);
  }
  const originalById = new Map((draft.structure.mapping ?? []).map(pair => [draft.structure.atoms[pair.current - 1]?.id, pair.original]));
  if (draft.structure.mapping) structure.mapping = structure.atoms.flatMap((atom,index) => originalById.has(atom.id) ? [{ original: originalById.get(atom.id)!, current: index + 1 }] : []);
  if (draft.structure.charge != null) structure.charge = draft.structure.charge + structure.atoms.reduce((sum,atom)=>sum+(atom.formalCharge??0),0) - draft.structure.atoms.reduce((sum,atom)=>sum+(atom.formalCharge??0),0);
  // Generic groups follow the same stable identity and explicit anchor inheritance.
  structure.groups = (structure.groups ?? []).map(group => ({ ...group, atomIds: unique([...group.atomIds, ...Object.keys(createdFrom).filter(child => group.atomIds.includes(inheritanceAnchor(child,createdFrom)))]).filter(id => ids.has(id)) }));
  const revision = draft.revision + 1;
  structure.revision = revision;
  return { ...draft, structure, assignments: inherited.assignments, assignmentIssues: inherited.issues, createdFrom,
    revision, selectedIds: draft.selectedIds.filter(id => ids.has(id)), touchedIds: unique([...draft.touchedIds, ...touched]),
    past: [...draft.past, snapshot(draft)], future: [], dirty: stateIdentity(structure, inherited.assignments) !== stateIdentity(draft.baseStructure, draft.baseAssignments) };
}

/** Commit an already prepared, explicitly scoped edit. The v0.11 model domain
 * owns hydrogen policy; this entry retains the shared structural, identity,
 * stereo and assignment validation without invoking legacy auto-saturation. */
export function commitBuilderTransaction(draft: BuilderDraft, structure: Structure, touchedIds: string[], createdFrom: Record<string, string> = {}, stereochemistry = true): BuilderDraft {
  // This transaction validates the complete structure and rebases accepted
  // state into input-task projections without starting a scientific operation.
  return commit(draft, structure, touchedIds, createdFrom, stereochemistry);
}

export function createBuilderDraft(input: Structure | null, assignments: BuilderAssignments = emptyAssignments()): BuilderDraft {
  const structure: Structure = input ? clone(input) : { id: newId(), name: 'untitled', format: 'builder', atoms: [], bonds: [], charge: null, multiplicity: null, notes: [], dimension: 3 };
  structure.atoms = structure.atoms.map(atom => ({ ...atom, id: atom.id ?? newId() }));
  structure.layout2D ??= Object.fromEntries(structure.atoms.map(atom => [atom.id!, { x: atom.x, y: atom.y }]));
  validate(structure);
  if (!periodic(structure)) Object.assign(structure, inferBuilderBonds(structure));
  retainAromaticHydrogenHints(structure);
  const cleaned = cleanAssignments(assignments, structure);
  const revision = structure.revision ?? 0;
  structure.revision = revision;
  return { structure, assignments: cleaned.assignments, assignmentIssues: cleaned.issues, createdFrom: {}, revision, selectedIds: [], touchedIds: [], past: [], future: [], dirty: false,
    baseAtomIds: structure.atoms.map(atom => atom.id!), baseStructure: clone(structure), baseAssignments: clone(cleaned.assignments) };
}

function removeAtoms(structure: Structure, ids: string[]): Structure {
  const removed = new Set(ids), indices = new Map<number,number>();
  requireIds(structure, ids);
  // Deleting an explicit H records an open valence on its surviving neighbour.
  for (const bond of structure.bonds ?? []) {
    const a = structure.atoms[bond.a], b = structure.atoms[bond.b];
    if (a.element === 'H' && removed.has(a.id!) && !removed.has(b.id!)) b.hydrogenMode = 'explicit';
    if (b.element === 'H' && removed.has(b.id!) && !removed.has(a.id!)) a.hydrogenMode = 'explicit';
  }
  structure.atoms = structure.atoms.filter((atom, index) => { if (removed.has(atom.id!)) return false; indices.set(index, indices.size); return true; });
  structure.bonds = (structure.bonds ?? []).filter(bond => indices.has(bond.a) && indices.has(bond.b)).map(bond => ({ ...bond, a: indices.get(bond.a)!, b: indices.get(bond.b)! }));
  structure.layout2D = Object.fromEntries(Object.entries(structure.layout2D ?? {}).filter(([id]) => !removed.has(id)));
  return structure;
}

export function executeBuilderCommand(draft: BuilderDraft, command: BuilderCommand): BuilderDraft {
  let structure = clone(draft.structure), touched: string[] = [], createdFrom: Record<string,string> = {};
  switch (command.type) {
    case 'add-atom': {
      const id = newId(), anchor = command.anchorId ? requireIds(structure, [command.anchorId])[0] : undefined;
      structure.atoms.push({ id, element: elementSymbol(command.element), x: command.position[0], y: command.position[1], z: command.position[2] });
      structure.layout2D = { ...structure.layout2D, [id]: { x: command.position[0], y: command.position[1] } };
      if (anchor != null) { structure.bonds = [...(structure.bonds ?? []), { a: anchor, b: structure.atoms.length - 1, order: command.order ?? 1 }]; createdFrom[id] = command.anchorId!; }
      touched = [id, ...(command.anchorId ? [command.anchorId] : [])]; break;
    }
    case 'delete-atoms': {
      touched = unique(command.atomIds);
      const removed = new Set(touched);
      for (const bond of structure.bonds ?? []) if (removed.has(idOf(structure,bond.a)) !== removed.has(idOf(structure,bond.b))) touched.push(removed.has(idOf(structure,bond.a)) ? idOf(structure,bond.b) : idOf(structure,bond.a));
      structure = removeAtoms(structure, command.atomIds); break;
    }
    case 'change-element': { touched = unique(command.atomIds); for (const i of requireIds(structure, touched)) structure.atoms[i].element = elementSymbol(command.element); break; }
    case 'change-charge': { if (!Number.isInteger(command.charge)) throw new Error('形式电荷必须是整数。'); touched = unique(command.atomIds); for (const i of requireIds(structure, touched)) structure.atoms[i].formalCharge = command.charge; break; }
    case 'set-bond': case 'delete-bond': {
      const [a,b] = requireIds(structure, command.atomIds); if (a === b || b == null) throw new Error('请选择两个不同的原子。');
      structure.bonds = (structure.bonds ?? []).filter(bond => !((bond.a === a && bond.b === b) || (bond.a === b && bond.b === a)));
      if (command.type === 'set-bond') structure.bonds.push({ a, b, order: command.order, aromatic: command.order === 1.5 || command.order === 4 });
      touched = [...command.atomIds]; break;
    }
    case 'geometry': { const result = editBuilderGeometry(structure, command); structure = result.structure; touched = result.touchedIds; break; }
    case 'translate': case 'rotate': case 'reflect': case 'invert-center': { const result = transformBuilderSelection(structure, command.type === 'invert-center' ? { type: command.type, atomIds: [command.atomId] } : command); structure = result.structure; touched = result.touchedIds; break; }
    case 'attach-template': {
      if (periodic(structure) && !command.anchorId && !command.replaceAtomIds?.length) throw new Error('周期结构接枝需要明确选择连接点或待替换原子。');
      const result = attachBuilderTemplate(structure, command); structure = result.structure; touched = [...result.touchedIds, ...(result.removedIds ?? [])]; createdFrom = result.createdFrom ?? {}; break;
    }
    case 'add-hydrogens': {
      if (periodic(structure) && !command.atomIds?.length) throw new Error('周期结构加氢需要明确选择局部原子；不执行全体系自动补氢。');
      const targets = command.atomIds ?? structure.atoms.map(atom => atom.id!);
      requireIds(structure, targets);
      const eligible = command.mode === 'auto' ? targets.filter(id => structure.atoms.find(atom => atom.id === id)?.hydrogenMode !== 'explicit') : targets;
      const result = placeBuilderHydrogens(structure, eligible, command.mode); structure = result.structure; touched = result.touchedIds; createdFrom = result.createdFrom ?? {}; break;
    }
  }
  retainAromaticHydrogenHints(structure,draft.structure);
  if (['add-atom','delete-atoms','change-element','change-charge','set-bond','delete-bond','attach-template'].includes(command.type) && (!periodic(structure) || command.type !== 'add-atom' || Boolean(command.anchorId))) {
    const ids = new Set(structure.atoms.map(atom => atom.id!));
    const result = placeBuilderHydrogens(structure, unique(touched).filter(id => ids.has(id)), 'auto');
    structure = result.structure; touched.push(...result.touchedIds, ...(result.removedIds ?? [])); createdFrom = { ...createdFrom, ...result.createdFrom };
  }
  if (['add-atom','delete-atoms','change-element','change-charge','set-bond','delete-bond','attach-template'].includes(command.type)) {
    const present = new Set(structure.atoms.map(atom => atom.id!)); validateBuilderValence(structure,unique(touched).filter(id => present.has(id)));
  }
  return commit(draft, structure, touched, createdFrom,true);
}

export function undoBuilder(draft: BuilderDraft): BuilderDraft {
  const previous = draft.past.at(-1); if (!previous) return draft;
  const restored = clone(previous), revision = draft.revision + 1;
  restored.structure.revision = revision;
  return { ...draft, ...restored, revision, past: draft.past.slice(0,-1), future: [snapshot(draft), ...draft.future], dirty: stateIdentity(restored.structure, restored.assignments) !== stateIdentity(draft.baseStructure, draft.baseAssignments) };
}
export function redoBuilder(draft: BuilderDraft): BuilderDraft {
  const next = draft.future[0]; if (!next) return draft;
  const restored = clone(next), revision = draft.revision + 1;
  restored.structure.revision = revision;
  return { ...draft, ...restored, revision, past: [...draft.past, snapshot(draft)], future: draft.future.slice(1), dirty: stateIdentity(restored.structure, restored.assignments) !== stateIdentity(draft.baseStructure, draft.baseAssignments) };
}

/** A diagram is a graph/layout edit, never a replacement of surviving Cartesian coordinates. */
export function mergeBuilder2D(draft: BuilderDraft, incoming: Structure): BuilderDraft {
  if (periodic(draft.structure)) throw new Error('周期结构不进入二维分子编辑器。');
  if (incoming.revision != null && incoming.revision !== draft.revision) throw new Error('二维草稿已过期；未应用旧连接表。');
  validate(incoming);
  const old = new Map(draft.structure.atoms.map(atom => [atom.id!, atom]));
  const incomingIds = new Set(incoming.atoms.map(atom => atom.id!));
  const removed = draft.structure.atoms.filter(atom => !incomingIds.has(atom.id!)).map(atom => atom.id!);
  let structure = removeAtoms(clone(draft.structure), removed);
  const previous = new Map(structure.atoms.map(atom => [atom.id!, atom]));
  const layout = Object.fromEntries(incoming.atoms.map(atom => [atom.id!, incoming.layout2D?.[atom.id!] ?? { x: atom.x, y: atom.y }]));
  const createdFrom: Record<string,string> = {}, placed = new Map(previous), touched = [...removed];
  const pending = incoming.atoms.filter(atom => !old.has(atom.id!));
  while (pending.length) {
    let progress = false;
    const hasAnchored = pending.some(atom => {
      const index = incoming.atoms.indexOf(atom);
      return (incoming.bonds ?? []).some(bond => bond.a === index && placed.has(idOf(incoming,bond.b)) || bond.b === index && placed.has(idOf(incoming,bond.a)));
    });
    for (let p = pending.length - 1; p >= 0; p--) {
      const atom = pending[p], index = incoming.atoms.indexOf(atom);
      const neighbours = (incoming.bonds ?? []).filter(bond => bond.a === index || bond.b === index).map(bond => incoming.atoms[bond.a === index ? bond.b : bond.a]).filter(neighbour => placed.has(neighbour.id!));
      if (!neighbours.length && (hasAnchored || progress)) continue;
      if (neighbours.length > 1) {
        const parents = unique(neighbours.map(neighbour => inheritanceAnchor(neighbour.id!, { ...draft.createdFrom, ...createdFrom })));
        for (const category of ['layers','basis','fragments'] as const) {
          const memberships = parents.map(parent => draft.assignments[category].filter(entry => entry.atomIds.includes(parent)).map(entry => entry.id).sort().join('|'));
          if (new Set(memberships).size > 1) throw new Error(`新增原子跨接不同${category}区域，归属冲突；请明确连接点和区域。`);
        }
      }
      const anchor = neighbours[0], point = layout[atom.id!];
      let x = point.x, y = point.y, z = 0;
      if (anchor) {
        const position = placed.get(anchor.id!)!, origin = layout[anchor.id!];
        let dx = point.x - origin.x, dy = point.y - origin.y, length = Math.hypot(dx,dy);
        if (length < 1e-8) { dx = 1; dy = 0; length = 1; }
        x = position.x + dx / length * 1.45; y = position.y + dy / length * 1.45; z = position.z;
        createdFrom[atom.id!] = anchor.id!;
      }
      placed.set(atom.id!, { ...clone(atom), x,y,z }); touched.push(atom.id!); pending.splice(p,1); progress = true;
    }
    if (!progress) throw new Error('无法确定新增片段的局部三维位置。');
  }
  structure.atoms = incoming.atoms.map(atom => {
    const prior = previous.get(atom.id!);
    if (!prior) return placed.get(atom.id!)!;
    if (prior.element !== atom.element || (prior.formalCharge ?? 0) !== (atom.formalCharge ?? 0)) touched.push(atom.id!);
    return { ...prior, element: atom.element, formalCharge: atom.formalCharge, aromaticHydrogen: atom.aromaticHydrogen };
  });
  structure.layout2D = layout; structure.bonds = clone(incoming.bonds ?? []); structure.bondSource = 'drawn'; structure.dimension = 3;
  retainAromaticHydrogenHints(structure,draft.structure,new Set(incoming.atoms.filter(atom=>atom.aromaticHydrogen).map(atom=>atom.id!)));
  const hintChanged=structure.atoms.filter(atom=>Boolean(atom.aromaticHydrogen)!==Boolean(old.get(atom.id!)?.aromaticHydrogen)).map(atom=>atom.id!);
  touched.push(...hintChanged);
  const newlyCreated = incoming.atoms.filter(atom => !old.has(atom.id!)).map(atom => atom.id!);
  if (newlyCreated.length) { const result = initializeBuilderNewGeometry(structure,newlyCreated); structure = result.structure; touched.push(...result.touchedIds); }
  if (graphIdentity(draft.structure) !== graphIdentity(structure) || hintChanged.length) {
    const oldBonds = new Set((draft.structure.bonds ?? []).map(bond => bondIdentity(draft.structure, bond)));
    for (const bond of structure.bonds ?? []) if (!oldBonds.has(bondIdentity(structure,bond))) touched.push(idOf(structure,bond.a),idOf(structure,bond.b));
    const newBonds = new Set((structure.bonds ?? []).map(bond => bondIdentity(structure,bond)));
    for (const bond of draft.structure.bonds ?? []) if (!newBonds.has(bondIdentity(draft.structure,bond))) touched.push(idOf(draft.structure,bond.a),idOf(draft.structure,bond.b));
    const ids = new Set(structure.atoms.map(atom => atom.id!));
    const result = placeBuilderHydrogens(structure, unique(touched).filter(id => ids.has(id)), 'auto');
    structure = result.structure; touched.push(...result.touchedIds, ...(result.removedIds ?? [])); Object.assign(createdFrom, result.createdFrom);
  }
  for (const atom of incoming.atoms) {
    const wedgeState = (s:Structure,id:string) => (s.bonds ?? []).filter(b => (idOf(s,b.a) === id || idOf(s,b.b) === id) && (b.stereo === 1 || b.stereo === 6)).map(b => JSON.stringify([idOf(s,b.a),idOf(s,b.b),b.stereo])).sort().join('|');
    const prior = old.get(atom.id!);
    // A new projection or an unchanged bridge round-trip cannot rotate,
    // mirror or otherwise alter an existing Cartesian configuration.
    if (prior && (atom.stereoParity ?? 0) === (prior.stereoParity ?? 0) && wedgeState(incoming,atom.id!) === wedgeState(draft.structure,atom.id!)) continue;
    const requested = requestedBuilder2DParity(incoming, atom.id!);
    if (!requested) continue;
    const actual = builderTetrahedralParity(structure, atom.id!);
    if (!actual) throw new Error('二维指定手性尚无非平面三维几何；请先完成明确的三维构建。');
    if (requested !== actual) {
      const result = transformBuilderSelection(structure, { type: 'invert-center', atomIds: [atom.id!] });
      structure = result.structure; touched.push(...result.touchedIds);
      if (builderTetrahedralParity(structure, atom.id!) !== requested) throw new Error('二维手性与三维构型不能可靠对应；本次编辑未应用。');
    }
  }
  const diagram = (s:Structure):Structure => ({ ...s, cell:undefined, atoms:s.atoms.map(atom => { const point=s.layout2D?.[atom.id!]; return {...atom,x:point?.x??atom.x,y:point?.y??atom.y,z:0}; }) });
  for (const bond of incoming.bonds ?? []) {
    if (bond.order !== 2 || bond.aromatic) continue;
    const a = idOf(incoming,bond.a), b = idOf(incoming,bond.b);
    const requested = builderDoubleBondConfiguration(diagram(incoming),a,b);
    if (requested === 'undefined') continue;
    const previous = builderDoubleBondConfiguration(diagram(draft.structure),a,b);
    if (previous === requested) continue;
    if (builderDoubleBondConfiguration(structure,a,b) !== requested) {
      const result = setBuilderDoubleBondConfiguration(structure,a,b,requested);
      structure = result.structure; touched.push(...result.touchedIds);
    }
  }
  return commit(draft, structure, unique(touched), createdFrom, false);
}

/** Async workers must return a complete, identity-bearing graph for the exact submitted revision. */
export function mergeBuilderCoordinates(draft: BuilderDraft, incoming: Structure, expectedRevision: number): BuilderDraft {
  if (draft.revision !== expectedRevision) throw new Error('草稿已改变，过期的三维结果已拒绝。');
  validate(incoming);
  if (graphIdentity(draft.structure) !== graphIdentity(incoming)) throw new Error('三维结果的原子身份或完整键图不匹配；未应用。');
  const coordinates = new Map(incoming.atoms.map(atom => [atom.id!, atom]));
  const structure = clone(draft.structure), touched: string[] = [];
  for (const atom of structure.atoms) {
    const point = coordinates.get(atom.id!)!;
    if (atom.x !== point.x || atom.y !== point.y || atom.z !== point.z) touched.push(atom.id!);
    atom.x = point.x; atom.y = point.y; atom.z = point.z;
  }
  assertBuilderStereoPreserved(draft.structure, structure);
  return commit(draft, structure, touched);
}

/** Commit a private preparation plus its native result as one atomic edit.
 * The staged preparation must be exactly one transaction derived from this
 * molecule/assignment history. Selection may change while the worker runs. */
export function mergeBuilderPreparedCoordinates(draft: BuilderDraft, staged: BuilderDraft, incoming: Structure, expectedRevision: number): BuilderDraft {
  if (draft.revision !== expectedRevision) throw new Error('草稿已改变，过期的准备/三维结果已拒绝。');
  if (periodic(draft.structure)) throw new Error('周期结构不执行整分子三维重建。');
  if (incoming.dimension !== 3) throw new Error('原生结果未明确为三维；准备草稿未应用。');
  const origin = staged.past.at(-1);
  const originIdentity = (state: BuilderSnapshot) => JSON.stringify({ structure: state.structure, assignments: state.assignments, touchedIds: state.touchedIds, assignmentIssues: state.assignmentIssues, createdFrom: state.createdFrom });
  if (!origin || staged.revision !== expectedRevision + 1 || staged.past.length !== draft.past.length + 1 ||
      originIdentity(origin) !== originIdentity(draft) || JSON.stringify(staged.past.slice(0,-1)) !== JSON.stringify(draft.past) ||
      JSON.stringify(staged.baseStructure) !== JSON.stringify(draft.baseStructure) || JSON.stringify(staged.baseAssignments) !== JSON.stringify(draft.baseAssignments) ||
      JSON.stringify(staged.baseAtomIds) !== JSON.stringify(draft.baseAtomIds)) {
    throw new Error('准备草稿与当前分子/区域历史不匹配；未应用三维结果。');
  }
  const prepared = mergeBuilderCoordinates(staged,incoming,staged.revision);
  prepared.structure.dimension = 3;
  const committed = commit(draft,prepared.structure,unique([...staged.touchedIds,...prepared.touchedIds]),prepared.createdFrom);
  // Preparation can carry its own explicit assignment diagnostics. The single
  // public history snapshot is still the original, unprepared draft.
  committed.assignments = clone(prepared.assignments);
  committed.assignmentIssues = clone(prepared.assignmentIssues);
  committed.dirty = stateIdentity(committed.structure,committed.assignments) !== stateIdentity(draft.baseStructure,draft.baseAssignments);
  return committed;
}

export function builderApplyResult(draft: BuilderDraft): BuilderApplyResult {
  validate(draft.structure);
  const ids = new Set(draft.structure.atoms.map(atom => atom.id!));
  return clone({ structure: draft.structure, assignments: draft.assignments, baseAtomIds: draft.baseAtomIds, baseRevision: draft.baseStructure.revision ?? 0, baseStructure: draft.baseStructure, removedIds: draft.baseAtomIds.filter(id => !ids.has(id)), touchedIds: draft.touchedIds, assignmentIssues: draft.assignmentIssues });
}
