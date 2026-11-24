import { ELEMENTS } from './elements';
import type { Bond, Structure } from './types';

export type CarbonCipLabel = 'R' | 'S';
export interface CipGeometryInput {
  mol: string;
  structure: Structure;
  eligibleCarbons: ReadonlySet<number>;
  sourceIndices: readonly number[];
}

/** Ordinary covalent edges that can enter a connection table. An absent
 * orderKnown flag is the legacy representation of an explicit bond. */
export function isCipCovalentBond(bond: Bond): boolean {
  return bond.kind !== 'coordination' && bond.orderKnown !== false && !bond.fractional &&
    (bond.aromatic ? bond.order === 1.5 : [1, 2, 3].includes(bond.order));
}

/** Build a fresh, full-precision connection table from supported covalent
 * components. Its input carries neither imported wedges nor derived parity. */
export function cipGeometryInput(structure: Structure): CipGeometryInput | null {
  const { atoms, bonds } = structure;
  if (structure.dimension === 2 || structure.cell?.pbc.some(Boolean) || structure.periodicSource?.completeness === 'partial' ||
      !atoms.length || !bonds?.length) return null;

  const validAtoms = atoms.map(atom => ELEMENTS.includes(atom.element) &&
    [atom.x, atom.y, atom.z].every(Number.isFinite) &&
    (atom.formalCharge === undefined || Number.isSafeInteger(atom.formalCharge)));
  const uncertain = new Set<number>();
  const neighbors = atoms.map(() => [] as number[]);
  const valence = atoms.map(() => 0);
  const aromatic = new Set<number>();
  const pairs = new Map<string, Bond[]>();
  for (const bond of bonds) {
    const { a, b } = bond;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !validAtoms[a] || !validAtoms[b] || a === b) {
      if (validAtoms[a]) uncertain.add(a);
      if (validAtoms[b]) uncertain.add(b);
      continue;
    }
    const key = pairKey(a, b);
    const entries = pairs.get(key);
    if (entries) entries.push(bond);
    else pairs.set(key, [bond]);
  }

  const covalent: Bond[] = [];
  for (const entries of pairs.values()) {
    const [bond] = entries;
    const { a, b, order } = bond;
    if (entries.length !== 1 || bond.image?.some(Boolean) || !isCipCovalentBond(bond)) {
      uncertain.add(a);
      uncertain.add(b);
      continue;
    }
    covalent.push(bond);
    neighbors[a].push(b);
    neighbors[b].push(a);
    valence[a] += order;
    valence[b] += order;
    if (bond.aromatic) { aromatic.add(a); aromatic.add(b); }
  }
  if (!covalent.length) return null;

  const byId = new Map(atoms.map((atom, index) => [atom.id, index]));
  for (const issue of structure.bondPerceptionIssues ?? []) {
    // An observed weak contact is not evidence of an uncertain covalent order.
    if (issue.kind === 'weak-contact') continue;
    for (const id of issue.atomIds) {
      const index = byId.get(id);
      if (index !== undefined) uncertain.add(index);
    }
  }
  atoms.forEach((atom, index) => {
    if (atom.hydrogenMode !== 'explicit') return;
    const charge = atom.formalCharge ?? 0, degree = neighbors[index].length;
    if (!aromatic.has(index)) {
      // Indigo can perceive a tetrahedron at a three-coordinate open carbon.
      if (atom.element === 'C' && degree === 3 && valence[index] === 3) uncertain.add(index);
      return;
    }
    // The ordinary-molecule loader gives zero implicit H in these aromatic cases.
    if ((charge === 0 && (atom.element === 'O' || degree === 3 && ['C', 'N', 'S'].includes(atom.element))) ||
        charge === 1 && atom.element === 'N' && degree === 3) return;
    uncertain.add(index);
  });

  const affected = new Set(uncertain);
  const queue = [...affected];
  for (const index of queue) for (const neighbor of neighbors[index]) {
    if (!affected.has(neighbor)) { affected.add(neighbor); queue.push(neighbor); }
  }
  const eligibleCarbons = new Set<number>();
  atoms.forEach((atom, index) => {
    const adjacent = neighbors[index], degree = adjacent.length;
    if (atom.element !== 'C' || uncertain.has(index) || aromatic.has(index) || degree !== valence[index] ||
        !(degree === 4 || degree === 3 && atom.hydrogenMode !== 'explicit')) return;
    // Only retain a centre in an affected component when its priorities are
    // fixed by the distinct elements of its directly attached ligands. An
    // unresolved attachment at the centre itself was already excluded.
    const elements = adjacent.map(neighbor => atoms[neighbor].element);
    if (degree === 3) elements.push('H');
    if (!affected.has(index) || new Set(elements).size === 4) eligibleCarbons.add(index);
  });

  return connectionTable(structure, validAtoms.flatMap((valid,index)=>valid?[index]:[]), covalent, eligibleCarbons);
}

function connectionTable(source:Structure, indices:readonly number[], bonds:readonly Bond[], eligibleCarbons:ReadonlySet<number>,
    sourceIndices=indices):CipGeometryInput {
  const reindex = new Map(indices.map((index, local) => [index, local]));
  const projected = { ...source, atoms: indices.map(index => source.atoms[index]),
    bonds: bonds.map(bond => ({ ...bond, a: reindex.get(bond.a)!, b: reindex.get(bond.b)! })) };
  const valence=indices.map(()=>0), aromatic=new Set<number>();
  for(const bond of projected.bonds)for(const index of [bond.a,bond.b]){
    valence[index]+=bond.order;
    if(bond.aromatic)aromatic.add(index);
  }
  const lines = ['ES current geometry', '  ES                3D', '', '  0  0  0     0  0            999 V3000',
    'M  V30 BEGIN CTAB', `M  V30 COUNTS ${indices.length} ${bonds.length} 0 0 0`, 'M  V30 BEGIN ATOM'];
  projected.atoms.forEach((atom, local) => {
    // HCOUNT is a query feature. VAL keeps open sites in an ordinary molecule.
    const explicitValence = atom.hydrogenMode === 'explicit' && !aromatic.has(local) ? ` VAL=${valence[local] || -1}` : '';
    lines.push(`M  V30 ${local + 1} ${atom.element} ${atom.x} ${atom.y} ${atom.z} ${sourceIndices[local] + 1}${atom.formalCharge ? ` CHG=${atom.formalCharge}` : ''}${explicitValence}`);
  });
  lines.push('M  V30 END ATOM', 'M  V30 BEGIN BOND');
  projected.bonds.forEach((bond, index) => lines.push(`M  V30 ${index + 1} ${bond.aromatic ? 4 : bond.order} ${bond.a + 1} ${bond.b + 1}`));
  lines.push('M  V30 END BOND', 'M  V30 END CTAB', 'M  END', '');
  return { mol: lines.join('\n'), structure: projected, eligibleCarbons, sourceIndices };
}

/** Isolate the affected Indigo input when the pooled table cannot be read.
 * Reuse the already checked candidate eligibility and original atom mapping. */
export function cipGeometryComponentInputs(input:CipGeometryInput):CipGeometryInput[] {
  const {structure,sourceIndices,eligibleCarbons}=input;
  const connections=structure.atoms.map(()=>[] as Bond[]);
  for(const bond of structure.bonds??[]){
    connections[bond.a].push(bond);
    connections[bond.b].push(bond);
  }
  const visited=new Set<number>(), components:CipGeometryInput[]=[];
  for(const start of structure.atoms.keys()){
    if(visited.has(start)||!connections[start].length)continue;
    const indices=[start], bonds=new Set<Bond>();
    visited.add(start);
    for(const index of indices)for(const bond of connections[index]){
      bonds.add(bond);
      const other=bond.a===index?bond.b:bond.a;
      if(!visited.has(other)){visited.add(other);indices.push(other);}
    }
    if(indices.length===structure.atoms.length)return [];
    const mapped=indices.map(index=>sourceIndices[index]);
    const eligible=new Set(mapped.filter(index=>eligibleCarbons.has(index)));
    if(eligible.size)components.push(connectionTable(structure,indices,[...bonds],eligible,mapped));
  }
  return components;
}

const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

/** The locked Indigo implementation ranks the complete supported molecular
 * graph. Verify its exact mapped geometry and graph before accepting R/S. */
export function readCarbonCipLabels(input: CipGeometryInput, ket: string): ReadonlyMap<number, CarbonCipLabel> {
  const data = JSON.parse(ket), { atoms, bonds } = input.structure;
  const sources = new Map(input.sourceIndices.map((index, local) => [index, atoms[local]]));
  const found = new Set<number>(), edges: string[] = [], labels = new Map<number, CarbonCipLabel>();
  if (!Array.isArray(data?.root?.nodes)) throw Error('立体化学解析未返回完整分子。');
  const key = (a: number, b: number, order: number) => `${pairKey(a, b)}:${order}`;
  for (const ref of data.root.nodes) {
    const node = data[ref.$ref];
    if (node?.type !== 'molecule' || !Array.isArray(node.atoms) || !(node.bonds === undefined || Array.isArray(node.bonds))) {
      throw Error('立体化学解析返回了不支持的结构。');
    }
    const indices: number[] = [];
    for (const atom of node.atoms) {
      const index = atom.mapping - 1, source = sources.get(index);
      if (!Number.isInteger(index) || !source || found.has(index) || atom.label !== source.element ||
          (atom.charge ?? 0) !== (source.formalCharge ?? 0) || !Array.isArray(atom.location) || atom.location.length !== 3 ||
          atom.location.some((v: unknown, axis: number) => typeof v !== 'number' || !Number.isFinite(v) ||
            Math.abs(v - [source.x, source.y, source.z][axis]) > 1e-6 * Math.max(1, Math.abs(v)))) {
        throw Error('立体化学解析原子与当前结构不一致。');
      }
      found.add(index);
      indices.push(index);
      if (input.eligibleCarbons.has(index) && (atom.cip === 'R' || atom.cip === 'S')) labels.set(index, atom.cip);
    }
    for (const bond of node.bonds ?? []) {
      if (!Array.isArray(bond.atoms) || bond.atoms.length !== 2 ||
          bond.atoms.some((i: number) => !Number.isInteger(i) || indices[i] === undefined) || ![1, 2, 3, 4].includes(bond.type)) {
        throw Error('立体化学解析键图不完整。');
      }
      edges.push(key(indices[bond.atoms[0]], indices[bond.atoms[1]], bond.type));
    }
  }
  const expected = bonds!.map(bond => key(input.sourceIndices[bond.a], input.sourceIndices[bond.b], bond.aromatic ? 4 : bond.order)).sort();
  if (found.size !== atoms.length || JSON.stringify(edges.sort()) !== JSON.stringify(expected)) {
    throw Error('立体化学解析未保留当前完整键图。');
  }
  return labels;
}
