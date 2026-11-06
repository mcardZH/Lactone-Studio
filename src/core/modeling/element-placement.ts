import type { Structure, Vector3 } from '../types';
import { elementSymbol } from '../elements';
import { builderVector } from '../builder-geometry';
import type { ModelCommand } from '../../modeling/contracts';
import { atomIndex, clone, removeAtoms, unique } from './graph';
import { newModelId, saturateNewSite } from './hydrogen-policy';
import { avoidObviousNewAtomClashes } from './local-placement';
import { finiteVector } from './model-document-validation';

/** Construction candidate preparation only; the Store alone commits the resulting structure and provenance. */
export function removedSiteHydrogens(structure: Structure, atomId: string): Set<string> {
  const index = atomIndex(structure, atomId), removed = new Set<string>();
  for (const bond of structure.bonds ?? []) {
    if (bond.kind === 'coordination') continue;
    const other = bond.a === index ? bond.b : bond.b === index ? bond.a : -1;
    if (other >= 0 && structure.atoms[other].element === 'H') {
      const hydrogen = structure.atoms[other];
      const heavyNeighbours = (structure.bonds ?? []).filter(edge => edge.kind !== 'coordination' && (edge.a === other || edge.b === other)).filter(edge => structure.atoms[edge.a === other ? edge.b : edge.a].element !== 'H');
      if (heavyNeighbours.length !== 1) throw new Error('桥联H不能随普通位点替换删除，请先明确编辑对象。');
      removed.add(hydrogen.id!);
    }
  }
  return removed;
}

export function prepareElement(structure: Structure, command: Extract<ModelCommand, { type: 'place-element' }>) {
  const before=clone(structure);
  const element = elementSymbol(command.element);
  if (!finiteVector(command.position)) throw new Error('新增原子坐标必须有限。');
  let targetId = command.targetAtomId, touched: string[] = [], createdFrom: Record<string, string> = {};
  if (targetId) {
    const index = atomIndex(structure, targetId), target = structure.atoms[index];
    if (target.element === 'H') {
      const edges = (structure.bonds ?? []).filter(bond => bond.kind !== 'coordination' && (bond.a === index || bond.b === index));
      if (edges.length !== 1) throw new Error('点H接枝需要具有一个明确共价连接的H。');
      const edge = edges[0], parent = structure.atoms[edge.a === index ? edge.b : edge.a];
      const oldTarget = targetId, origin: Vector3 = [parent.x, parent.y, parent.z];
      let direction: Vector3 = [target.x - parent.x, target.y - parent.y, target.z - parent.z];
      if (structure.cell && edge.image) edge.image.forEach((value, k) => { direction = builderVector.add(direction, builderVector.scale(structure.cell!.vectors[k], value * (edge.a === index ? -1 : 1))); });
      const length = Math.hypot(...direction);
      if (length < 1e-8) throw new Error('接枝H与骨架重合，无法确定接枝方向。');
      const distance = element === 'C' && parent.element === 'C' ? 1.54 : element === 'N' ? 1.47 : element === 'O' ? 1.43 : 1.5;
      const point = builderVector.add(origin, builderVector.scale(direction, distance / length));
      structure = removeAtoms(structure, new Set([oldTarget]));
      targetId = newModelId();
      structure.atoms.push({ id: targetId, element, x: point[0], y: point[1], z: point[2], hydrogenMode: 'auto' });
      structure.bonds = [...(structure.bonds ?? []), { a: atomIndex(structure, parent.id!), b: structure.atoms.length - 1, order: 1 }];
      createdFrom[targetId] = oldTarget; touched = [oldTarget, parent.id!, targetId];
    } else {
      const removed = removedSiteHydrogens(structure, targetId);
      structure = removeAtoms(structure, removed);
      const surviving = structure.atoms[atomIndex(structure, targetId)];
      surviving.element = element; surviving.hydrogenMode = 'auto'; delete surviving.aromaticHydrogen;
      touched = [targetId, ...removed];
    }
  } else {
    targetId = newModelId();
    structure.atoms.push({ id: targetId, element, x: command.position[0], y: command.position[1], z: command.position[2], hydrogenMode: 'auto' });
    touched = [targetId];
  }
  const saturated = saturateNewSite(structure, targetId);
  structure = saturated.structure;
  touched.push(...saturated.touchedIds);
  createdFrom = { ...createdFrom, ...saturated.createdFrom };
  const oldIds=new Set(before.atoms.map(atom=>atom.id!)),newIds=structure.atoms.filter(atom=>!oldIds.has(atom.id!)).map(atom=>atom.id!);
  const center=structure.atoms[atomIndex(structure,targetId)],connections=(structure.bonds??[]).flatMap(bond=>{
    const other=bond.a===atomIndex(structure,targetId)?bond.b:bond.b===atomIndex(structure,targetId)?bond.a:-1;
    return other>=0&&oldIds.has(structure.atoms[other].id!)?[structure.atoms[other]]:[];
  });
  const axis=connections.length===1?builderVector.sub([connections[0].x,connections[0].y,connections[0].z],[center.x,center.y,center.z]):undefined;
  structure=avoidObviousNewAtomClashes(before,structure,newIds,command.targetAtomId?{pivot:[center.x,center.y,center.z],axis,locked:connections.length>1}:{});
  structure.layout2D = { ...structure.layout2D, ...Object.fromEntries(structure.atoms.filter(atom => touched.includes(atom.id!)).map(atom => [atom.id!, { x: atom.x, y: atom.y }])) };
  return { structure, touchedIds: unique(touched), createdFrom };
}

