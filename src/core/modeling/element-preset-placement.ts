import type { Atom, Bond, Structure, Vector3 } from '../types';
import { builderVector } from '../builder-geometry';
import { atomIndex, clone, removeAtoms, unique } from './graph';
import { newModelId } from './hydrogen-policy';
import { getElementPreset, type ElementPreset, type ElementPresetSlot } from './element-presets';
import type { AttachmentPort } from '../../modeling/contracts';
import { rotateAttachmentDirection, validateAttachmentPorts } from './attachment-ports';
import { avoidObviousNewAtomClashes } from './local-placement';
import { elementPresetConstructionLength, ELEMENT_PRESET_COVALENT_RADII } from './element-preset-lengths';
import { metalHydrogenConstructionLength } from './connection-length';

export interface ElementPresetPlacement { presetId: string; position: Vector3; targetAtomId?: string; targetPortId?: string; attachmentPorts?: AttachmentPort[] }
export interface ElementPresetPlacementResult { structure: Structure; touchedIds: string[]; createdFrom: Record<string, string>; attachmentPorts: AttachmentPort[] }
const { add, sub, scale, cross } = builderVector;
const dot = (a: Vector3, b: Vector3) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const norm = (v: Vector3): Vector3 => {
  const length = Math.hypot(...v);
  if (length < 1e-9 || !Number.isFinite(length)) throw new Error('连接位与中心重合或坐标无效，无法确定片段方向。');
  return scale(v, 1 / length);
};
const position = (atom: Atom): Vector3 => [atom.x, atom.y, atom.z];
const bondOrder = (bond: Bond) => bond.aromatic || bond.order === 4 ? 1.5 : bond.order;
function imageOffset(structure: Structure, bond: Bond, centerIndex: number): Vector3 {
  let offset: Vector3 = [0, 0, 0];
  if (structure.cell && bond.image) bond.image.forEach((value, k) => { offset = add(offset, scale(structure.cell!.vectors[k], value * (bond.a === centerIndex ? 1 : -1))); });
  return offset;
}
const perpendicular = (v: Vector3) => norm(cross(v, Math.abs(v[0]) < .8 ? [1, 0, 0] : [0, 1, 0]));
type Rotation = (v: Vector3) => Vector3;
function fitRotation(source: Vector3[], target: Vector3[]): Rotation {
  if (!source.length) return v => [...v];
  const a = source[0], x = target[0];
  const pair = source.findIndex((v, i) => i > 0 && Math.hypot(...cross(a, v)) > 1e-7 && Math.hypot(...cross(x, target[i])) > 1e-7);
  const b = pair > 0 ? norm(sub(source[pair], scale(a, dot(a, source[pair])))) : perpendicular(a);
  const y = pair > 0 ? norm(sub(target[pair], scale(x, dot(x, target[pair])))) : perpendicular(x);
  const c = cross(a, b), z = cross(x, y);
  // Both bases are right handed: no reflection, scaling or movement of the skeleton.
  return v => add(add(scale(x, dot(v, a)), scale(y, dot(v, b))), scale(z, dot(v, c)));
}
interface Connection { order: number; direction: Vector3 }
/** Slot correspondence is bounded by ten named coordination slots.
 * Coordinates of existing neighbours are constraints, never an optimization target. */
function occupySlots(preset: ElementPreset, connections: Connection[], incomingPort = false): { occupied: Set<number>; rotate: Rotation } {
  if (!preset.slots.length) return { occupied: new Set(), rotate: v => [...v] };
  if (connections.length > preset.slots.length) return { occupied: new Set(preset.slots.map((_,index)=>index)), rotate:fitRotation([preset.slots[0].direction],[connections[0].direction]) };
  let best: { indices: number[]; score: number; pairScore: number; rotate: Rotation } | undefined;
  let visits = 0;
  const visit = (indices: number[], pairScore: number) => {
    // A bounded angular correspondence search supplies a geometry seed. It is
    // not a claim that a distorted high-coordinate complex has an exact fit.
    if (++visits > 60000 || best && pairScore > best.pairScore + 1e-9) return;
    if (indices.length === connections.length) {
      const rotate = fitRotation(indices.map(index => preset.slots[index].direction), connections.map(entry => entry.direction));
      const score = indices.reduce((sum, index, i) => sum + 1 - dot(rotate(preset.slots[index].direction), connections[i].direction), 0);
      if (!best || pairScore < best.pairScore - 1e-9 || Math.abs(pairScore - best.pairScore) <= 1e-9 && score < best.score - 1e-9) best = { indices: [...indices], score, pairScore, rotate };
      return;
    }
    const entry = connections[indices.length];
    preset.slots.forEach((slot, index) => {
      const preferred = incomingPort && connections.length === 1
        ? preset.slots.some(candidate => candidate.fill === 'open' && candidate.order === entry.order)
          ? slot.fill === 'open' && slot.order === entry.order
          : preset.slots.some(candidate => candidate.fill === 'hydrogen') ? slot.fill === 'hydrogen' : true
        : true;
      if (!indices.includes(index) && preferred) {
        const added = (slot.order===entry.order?0:1000) + indices.reduce((sum, prior, i) => sum + (dot(preset.slots[prior].direction, slot.direction) - dot(connections[i].direction, entry.direction)) ** 2, 0);
        visit([...indices, index], pairScore + added);
      }
    });
  };
  visit([], 0);
  if (!best) throw new Error('所选片段的连接方向无法建立；未改变原结构。');
  return { occupied: new Set(best.indices), rotate: best.rotate };
}
function attachmentLength(a: string, b: string, order = 1, policy?:ElementPreset['attachmentLengthPolicy']): number {
  const metalHydrogen=order===1?a==='H'?metalHydrogenConstructionLength(b):b==='H'?metalHydrogenConstructionLength(a):undefined:undefined;
  if(metalHydrogen!==undefined)return metalHydrogen;
  if(policy==='covalent-radii'||b!=='Fe'&&![a,b].every(element=>['H','C','N','O','Fe'].includes(element))&&[a,b].every(element=>ELEMENT_PRESET_COVALENT_RADII[element]!==undefined))return elementPresetConstructionLength(a,b,order);
  // Diagram seeds only; this does not claim a force-field equilibrium bond.
  if (a === 'H' || b === 'H') return a === 'Fe' || b === 'Fe' ? 1.6 : a === 'O' || b === 'O' ? .97 : a === 'N' || b === 'N' ? 1.01 : 1.09;
  if (a === 'Fe' || b === 'Fe') return a === 'Fe' && b === 'Fe' ? 2.5 : 2;
  if (a === 'C' && b === 'C') return order === 3 ? 1.2 : order === 2 ? 1.34 : order === 1.5 ? 1.4 : 1.54;
  return a === 'O' || b === 'O' ? 1.43 : a === 'N' || b === 'N' ? 1.47 : 1.5;
}
function terminalHydrogens(structure: Structure, center: number): string[] {
  return (structure.bonds ?? []).flatMap(edge => {
    const other = edge.a === center ? edge.b : edge.b === center ? edge.a : -1;
    if (other < 0 || structure.atoms[other].element !== 'H' || bondOrder(edge) !== 1) return [];
    return (structure.bonds ?? []).filter(bond => bond.a === other || bond.b === other).length === 1 ? [structure.atoms[other].id!] : [];
  });
}

/** Pure local graph edit. The caller commits this single patch as one undo step
 * and uses createdFrom for region/frozen-layer inheritance, including replaced H.
 * Multiple/aromatic slots are open, all cap atoms are real single-bonded H. */
export function prepareElementPreset(input: Structure, command: ElementPresetPlacement, idFactory: () => string = newModelId): ElementPresetPlacementResult {
  const preset = getElementPreset(command.presetId);
  if (command.position.length !== 3 || !command.position.every(Number.isFinite)) throw new Error('新增片段坐标必须有限。');
  let structure = clone(input), centerId = command.targetAtomId;
  validateAttachmentPorts(command.attachmentPorts, input);
  let ports = clone(command.attachmentPorts ?? []);
  if (command.targetAtomId && command.targetPortId) throw new Error('不能同时指定原子和端口接入。');
  const touched: string[] = [], createdFrom: Record<string, string> = {};
  const usedIds = new Set([...structure.atoms.map(atom => atom.id), ...ports.map(port => port.id)]);
  const newId = () => { const id = idFactory(); if (!id || usedIds.has(id)) throw new Error('新增片段原子身份重复。'); usedIds.add(id); return id; };
  if (command.targetPortId) {
    const port = ports.find(value => value.id === command.targetPortId);
    if (!port) throw new Error('待接端口已不存在，未接入。');
    const parent = structure.atoms[atomIndex(structure, port.hostAtomId)], direction = [...port.direction] as Vector3;
    occupySlots(preset, [{ order: port.order, direction: scale(direction, -1) }], true);
    const p = add(position(parent), scale(direction, attachmentLength(parent.element, preset.element, port.order,preset.attachmentLengthPolicy)));
    centerId = newId();
    structure.atoms.push({ id: centerId, element: preset.element, x: p[0], y: p[1], z: p[2], hydrogenMode: 'explicit', geometryPresetId: preset.id });
    structure.bonds = [...(structure.bonds ?? []), { a: atomIndex(structure, parent.id!), b: structure.atoms.length - 1, order: port.order, ...(port.order === 1.5 ? { fractional: true, aromatic: false } : {}) }];
    ports = ports.filter(value => value.id !== port.id);
    touched.push(parent.id!, centerId); createdFrom[centerId] = parent.id!;
  } else if (centerId) {
    const index = atomIndex(structure, centerId), target = structure.atoms[index];
    if (target.element === 'H') {
      const edges = (structure.bonds ?? []).filter(edge => edge.a === index || edge.b === index);
      if (edges.length !== 1 || bondOrder(edges[0]) !== 1) throw new Error('点 H 接枝需要一个明确的单键末端 H。');
      const edge = edges[0], parentIndex = edge.a === index ? edge.b : edge.a, parent = structure.atoms[parentIndex];
      const direction = norm(sub(add(position(target), imageOffset(structure, edge, parentIndex)), position(parent)));
      // Validate a matching single connection before removing anything.
      occupySlots(preset, [{ order: 1, direction: scale(direction, -1) }]);
      const oldId = centerId, image = edge.image?.map(v => v * (edge.a === parentIndex ? 1 : -1)) as Vector3 | undefined;
      const point = sub(add(position(parent), scale(direction, attachmentLength(parent.element, preset.element,1,preset.attachmentLengthPolicy))), imageOffset(structure, edge, parentIndex));
      structure = removeAtoms(structure, new Set([oldId])); centerId = newId();
      structure.atoms.push({ id: centerId, element: preset.element, x: point[0], y: point[1], z: point[2], hydrogenMode: 'explicit' });
      structure.bonds = [...(structure.bonds ?? []), { a: atomIndex(structure, parent.id!), b: structure.atoms.length - 1, order: 1, ...(edge.kind ? { kind: edge.kind } : {}), ...(image ? { image } : {}) }];
      createdFrom[centerId] = oldId; touched.push(oldId, parent.id!, centerId);
    } else {
      const removed = terminalHydrogens(structure, index);
      if (removed.length) structure = removeAtoms(structure, new Set(removed));
      const center = structure.atoms[atomIndex(structure, centerId)];
      center.element = preset.element; center.hydrogenMode = 'explicit'; delete center.aromaticHydrogen;
      touched.push(centerId, ...removed);
    }
    ports = ports.filter(port => port.hostAtomId !== centerId && structure.atoms.some(atom => atom.id === port.hostAtomId));
  } else {
    centerId = newId();
    structure.atoms.push({ id: centerId, element: preset.element, x: command.position[0], y: command.position[1], z: command.position[2], hydrogenMode: 'explicit' });
    touched.push(centerId);
  }
  const centerIndex = atomIndex(structure, centerId), center = structure.atoms[centerIndex], origin = position(center);
  center.geometryPresetId = preset.id;
  const connections = (structure.bonds ?? []).flatMap(edge => {
    const other = edge.a === centerIndex ? edge.b : edge.b === centerIndex ? edge.a : -1;
    return other < 0 ? [] : [{ order: bondOrder(edge), direction: norm(sub(add(position(structure.atoms[other]), imageOffset(structure, edge, centerIndex)), origin)) }];
  });
  const { occupied, rotate } = occupySlots(preset, connections, Boolean(command.targetPortId));
  preset.slots.forEach((slot: ElementPresetSlot, index) => {
    if (occupied.has(index)) return;
    if (slot.fill === 'open') {
      ports.push({ id: newId(), hostAtomId: centerId!, direction: rotate(slot.direction).map(v=>v===0?0:v) as Vector3, order: slot.order, displayLength: .8, presetId: preset.id, slotId: slot.id });
      return;
    }
    const point = add(origin, scale(rotate(slot.direction), preset.hydrogenLength)), id = newId();
    structure.atoms.push({ id, element: 'H', x: point[0], y: point[1], z: point[2], hydrogenMode: 'explicit' });
    structure.bonds = [...(structure.bonds ?? []), { a: centerIndex, b: structure.atoms.length - 1, order: 1 }];
    touched.push(id); createdFrom[id] = centerId!;
  });
  const oldIds=new Set(input.atoms.map(atom=>atom.id!)), newIds=structure.atoms.filter(atom=>!oldIds.has(atom.id!)).map(atom=>atom.id!);
  const fixedCenter=Boolean(command.targetAtomId||command.targetPortId);
  // Preserve preset geometry and its connections: a single connection permits
  // a rigid twist about that axis; independent seeds may translate together.
  const axis=connections.length===1?connections[0].direction:undefined;
  const existingPortIds=new Set(command.attachmentPorts?.map(port=>port.id));
  structure=avoidObviousNewAtomClashes(input,structure,newIds,fixedCenter?{
    pivot:origin,axis,locked:connections.length>1,optimizeClearance:connections.length===1,
    onRotation:(rotationAxis,degrees)=>{ports=ports.map(port=>existingPortIds.has(port.id)?port:{...port,direction:rotateAttachmentDirection(port.direction,rotationAxis,degrees)});},
  }:{});
  structure.layout2D = { ...structure.layout2D, ...Object.fromEntries(structure.atoms.filter(atom => touched.includes(atom.id!)).map(atom => [atom.id!, { x: atom.x, y: atom.y }])) };
  structure.bondSource = 'drawn';
  validateAttachmentPorts(ports, structure);
  return { structure, touchedIds: unique(touched), createdFrom, attachmentPorts: ports };
}
