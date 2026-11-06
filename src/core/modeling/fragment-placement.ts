import type { Structure, Vector3 } from '../types';
import type { AttachmentPort } from '../../modeling/contracts';
import { getBuilderTemplate } from '../builder-templates';
import { builderPosition, builderRotate, builderVector } from '../builder-geometry';
import { minimumImage } from '../periodic';
import { newModelId, saturateNewSitesInPrivateCandidate } from './hydrogen-policy';
import { clone, unique } from './graph';
import { validateAttachmentPorts } from './attachment-ports';
import { avoidObviousNewAtomClashes, hasObviousPlacementClash } from './local-placement';
import { constructionBondLength, terminalHydrogenSlot } from './connection-length';
import { templateConnectionDirection } from './template-connection-direction';
import { templateAmideCarbonyl } from './template-amide-geometry';
import { getElementPreset } from './element-presets';

export interface FragmentPlacementOptions {
  templateId: string; activeAtomIndex?: number; targetAtomId?: string; targetPortId?: string;
  position: Vector3; attachmentPorts?: readonly AttachmentPort[];
}
export interface FragmentPlacementResult {
  structure: Structure; touchedIds: string[]; createdFrom: Record<string, string>; removedIds: string[]; attachmentPorts: AttachmentPort[];
}

/** Map the active atom to a stable identity. A terminal H construction slot
 * changes length along its declared bond; true in-place replacement keeps XYZ.
 * This is manual construction, not automatic chemistry or a FF optimization. */
export function placeBuilderFragment(input: Structure, options: FragmentPlacementOptions, idFactory: () => string = newModelId): FragmentPlacementResult {
  const template = getBuilderTemplate(options.templateId);
  if (!template) throw new Error('未知片段模板。');
  const active = options.activeAtomIndex ?? template.connectionAnchor;
  if (!Number.isSafeInteger(active) || active < 0 || active >= template.atoms.length) throw new Error('片段活性原子索引无效。');
  if (options.position.length !== 3 || !options.position.every(Number.isFinite)) throw new Error('片段放置坐标必须有限。');
  if (options.targetAtomId && options.targetPortId) throw new Error('片段不能同时替换原子和接入端口。');
  validateAttachmentPorts(options.attachmentPorts, input);
  const structure = clone(input), oldIds = new Set(input.atoms.map(a => a.id!));
  const ports = clone(options.attachmentPorts ?? []) as AttachmentPort[];
  const used = new Set([...oldIds, ...ports.map(p => p.id)]);
  const makeId = () => { const id = idFactory(); if (!id || used.has(id)) throw new Error('片段新增身份重复。'); used.add(id); return id; };
  const touched: string[] = [], createdFrom: Record<string, string> = {};
  const hostIndex = options.targetAtomId ? structure.atoms.findIndex(a => a.id === options.targetAtomId) : -1;
  if (options.targetAtomId && hostIndex < 0) throw new Error('片段替换原子已不存在。');
  const port = options.targetPortId ? ports.find(p => p.id === options.targetPortId) : undefined;
  if (options.targetPortId && !port) throw new Error('待接端口已不存在，未接入。');
  // Do not flatten the preserved multiple/fractional order into an ordinary
  // single connection. Unrepresentable constructions fail before consuming it.
  if (port && ![1, 1.5, 2, 3].includes(port.order)) throw new Error('片段端口键级无效。');
  const parent = port ? structure.atoms.find(a => a.id === port.hostAtomId) : undefined;
  if (port && !parent) throw new Error('待接端宿主已不存在。');
  const slot = terminalHydrogenSlot(structure, hostIndex, template.atoms[active].element);
  const externalCount = hostIndex < 0 ? 0 : (structure.bonds ?? []).filter(b => b.a === hostIndex || b.b === hostIndex).length;
  let origin: Vector3 = hostIndex >= 0 ? builderPosition(structure.atoms[hostIndex]) : [...options.position];
  let direction: Vector3 = [1, 0, 0];
  let hasExternalConnection = !!port;
  if (port) {
    direction = [...port.direction];
    const length = constructionBondLength(parent!.element, template.atoms[active].element, port.order);
    origin = builderVector.add(builderPosition(parent!), builderVector.scale(direction, length));
  } else if (hostIndex >= 0) {
    const directions = (structure.bonds ?? []).flatMap(b => {
      const other = b.a === hostIndex ? b.b : b.b === hostIndex ? b.a : -1;
      if (other < 0 || other === hostIndex) return [];
      hasExternalConnection = true;
      let delta = minimumImage(structure, hostIndex, other).delta;
      if (structure.cell && b.image) delta = builderVector.add(builderVector.sub(builderPosition(structure.atoms[other]), origin), structure.cell.vectors.reduce<Vector3>((v, axis, k) => builderVector.add(v, builderVector.scale(axis, b.image![k] * (b.a === hostIndex ? 1 : -1))), [0, 0, 0]));
      const length = Math.hypot(...delta);
      if (!Number.isFinite(length) || length <= 1e-9) throw new Error('片段外部连接方向退化，未提交；请选择有明确连接方向的活性位点。');
      return [builderVector.scale(delta, 1 / length)];
    });
    const away = builderVector.scale(directions.reduce<Vector3>(builderVector.add, [0, 0, 0]), -1);
    if (hasExternalConnection && Math.hypot(...away) <= 1e-9) throw new Error('片段外部连接方向退化，未提交；请选择有明确连接方向的活性位点。');
    if (Math.hypot(...away) > 1e-9) direction = builderVector.scale(away, 1 / Math.hypot(...away));
  }
  if (slot) { origin = slot.origin; direction = slot.direction; }
  const activePoint = builderPosition(template.atoms[active]);
  const primaryBond = template.bonds.find(b => b.a === active || b.b === active);
  const neighbour = primaryBond ? (primaryBond.a === active ? primaryBond.b : primaryBond.a) : -1;
  let sourceDirection = neighbour >= 0 ? builderVector.sub(builderPosition(template.atoms[neighbour]), activePoint) : [1, 0, 0] as Vector3;
  // A junction must point the whole cluster away from the old connection,
  // not put its arbitrarily first bond on that axis. Unit vectors give each
  // real seed neighbour equal weight without changing any internal geometry.
  // Free placement and single-neighbour chains retain their previous path.
  const neighbours = [...new Set(template.bonds.flatMap(b => b.a === active ? [b.b] : b.b === active ? [b.a] : []))];
  if (hasExternalConnection && neighbours.length > 1) {
    sourceDirection = neighbours.reduce<Vector3>((sum, index) => {
      const delta = builderVector.sub(builderPosition(template.atoms[index]), activePoint), length = Math.hypot(...delta);
      if (!Number.isFinite(length) || length <= 1e-9) throw new Error('片段模板连接方向退化，未提交；请选择其它活性原子。');
      return builderVector.add(sum, builderVector.scale(delta, 1 / length));
    }, [0, 0, 0]);
    if (Math.hypot(...sourceDirection) <= 1e-9) throw new Error('片段模板连接方向退化，未提交；请选择其它活性原子。');
  }
  if (hasExternalConnection && (port || externalCount === 1)) {
    const exterior = port ?? structure.bonds!.find(b => b.a === hostIndex || b.b === hostIndex)!;
    const order = 'aromatic' in exterior && exterior.aromatic || exterior.order === 4 ? 1.5 : exterior.order;
    const vacant = templateConnectionDirection(template, active, order);
    // direction points away from the host, so rotate the opposite vacancy
    // onto it. This is the same proper rotation as vacancy -> active-to-host.
    if (vacant) sourceDirection = builderVector.scale(vacant, -1);
  }
  const axis = builderVector.cross(sourceDirection, direction), cosine = builderVector.dot(sourceDirection, direction) / Math.hypot(...sourceDirection);
  const align = (p: Vector3) => Math.hypot(...axis) > 1e-9 ? builderRotate(p, [0, 0, 0], axis, Math.acos(Math.max(-1, Math.min(1, cosine))))
    : cosine < 0 ? builderRotate(p, [0, 0, 0], builderVector.cross(sourceDirection, Math.abs(sourceDirection[0]) < .8 * Math.hypot(...sourceDirection) ? [1, 0, 0] : [0, 1, 0]), Math.PI) : p;
  const mapping = new Map<number, number>();
  template.atoms.forEach((atom, index) => {
    if (index === active && hostIndex >= 0) {
      const host = structure.atoms[hostIndex];
      const replacement = { ...host, ...atom, id: host.id, x: origin[0], y: origin[1], z: origin[2], hydrogenMode: 'auto' as const };
      delete replacement.geometryPresetId; delete replacement.stereoParity;
      structure.atoms[hostIndex] = replacement; mapping.set(index, hostIndex); touched.push(host.id!); return;
    }
    const p = builderVector.add(align(builderVector.sub(builderPosition(atom), activePoint)), origin), id = makeId();
    mapping.set(index, structure.atoms.length); structure.atoms.push({ ...atom, id, x: p[0], y: p[1], z: p[2], hydrogenMode: 'auto' }); touched.push(id);
    if (options.targetAtomId || parent) createdFrom[id] = options.targetAtomId ?? parent!.id!;
  });
  structure.bonds = [...(structure.bonds ?? []), ...template.bonds.map(b => ({ ...b, a: mapping.get(b.a)!, b: mapping.get(b.b)! }))];
  if (port) {
    structure.bonds.push({ a: structure.atoms.findIndex(a => a.id === parent!.id), b: mapping.get(active)!, order: port.order, ...(port.order === 1.5 ? { fractional: true, aromatic: false } : {}) });
    ports.splice(ports.findIndex(p => p.id === port.id), 1); touched.push(parent!.id!);
  }
  // Saturate only template atoms and the mapped host. Over-valence is explicit
  // and permitted; no preserved exterior H is removed to repair it.
  // Generate a complete seed before exposing it to unrelated environmental
  // obstacles. Direct exterior neighbours remain for the actual local angle.
  // Final rigid search below checks every generated H against the full model.
  const templateIndices = new Set(mapping.values()), seedIndices = new Set(templateIndices);
  for (const bond of structure.bonds) {
    if (templateIndices.has(bond.a)) seedIndices.add(bond.b);
    if (templateIndices.has(bond.b)) seedIndices.add(bond.a);
  }
  const seedAtoms = structure.atoms.filter((_, index) => seedIndices.has(index));
  const localIndex = new Map(seedAtoms.map((atom, index) => [atom.id!, index]));
  const seedStructure: Structure = { ...structure, atoms: seedAtoms.map(clone), bonds: structure.bonds.filter(b => seedIndices.has(b.a) && seedIndices.has(b.b)).map(b => ({ ...b, a: localIndex.get(structure.atoms[b.a].id!)!, b: localIndex.get(structure.atoms[b.b].id!)! })) };
  const planarAtomIds = template.atoms.flatMap((atom, index) => templateAmideCarbonyl(template, index)
    && (!atom.geometryPresetId || ['trigonal-planar', 'bent-planar'].includes(getElementPreset(atom.geometryPresetId).geometry)) ? [structure.atoms[mapping.get(index)!].id!] : []);
  const saturated = saturateNewSitesInPrivateCandidate(seedStructure, [...mapping.values()].map(index => structure.atoms[index].id!), { planarAtomIds });
  const globalIndex = new Map(structure.atoms.map((atom, index) => [atom.id!, index]));
  for (const atom of saturated.structure.atoms) if (!globalIndex.has(atom.id!)) { globalIndex.set(atom.id!, structure.atoms.length); structure.atoms.push(atom); }
  for (const bond of saturated.structure.bonds ?? []) {
    const a = saturated.structure.atoms[bond.a].id!, b = saturated.structure.atoms[bond.b].id!;
    if (!localIndex.has(a) || !localIndex.has(b)) structure.bonds.push({ ...bond, a: globalIndex.get(a)!, b: globalIndex.get(b)! });
  }
  let candidate = structure; touched.push(...saturated.touchedIds);
  for (const [child, immediateParent] of Object.entries(saturated.createdFrom)) createdFrom[child] = options.targetAtomId ?? parent?.id ?? immediateParent;
  const newIds = candidate.atoms.filter(a => !oldIds.has(a.id!)).map(a => a.id!);
  // Junction clearance is torsion only: arbitrary-axis rotations would bend
  // the external construction angle while leaving the old atoms stationary.
  if (slot && hasObviousPlacementClash(candidate, [structure.atoms[hostIndex].id!])) throw new Error('末端H接入位存在明显重叠，未移动旧骨架或提交。');
  candidate = avoidObviousNewAtomClashes(input, candidate, newIds, hasExternalConnection ? { pivot: origin, axis: direction, locked: externalCount > 1, optimizeClearance: true } : hostIndex >= 0 ? { pivot: origin } : {});
  for (const old of input.atoms) {
    if (slot && old.id === options.targetAtomId) continue;
    const atom = candidate.atoms.find(a => a.id === old.id);
    if (!atom || ![Object.is(old.x, atom.x), Object.is(old.y, atom.y), Object.is(old.z, atom.z)].every(Boolean)) throw new Error('片段候选改变了旧原子坐标，未提交。');
  }
  candidate = { ...candidate, molfile: undefined, dimension: 3, bondSource: 'drawn', layout2D: { ...candidate.layout2D, ...Object.fromEntries(candidate.atoms.filter(a => touched.includes(a.id!)).map(a => [a.id!, { x: a.x, y: a.y }])) } };
  validateAttachmentPorts(ports, candidate);
  return { structure: candidate, touchedIds: unique(touched), createdFrom, removedIds: [], attachmentPorts: ports };
}
