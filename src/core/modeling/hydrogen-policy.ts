import type { Atom, Bond, Structure, Vector3 } from '../types';
import { builderCovalentValence, builderDefaultValence, builderPosition, builderVector, placeBuilderHydrogens } from '../builder-geometry';
import { assertBuilderStereoPreserved, builderTetrahedralParity, updateBuilderStereo } from '../builder-stereo';
import { fitLocalHydrogenDirections, fitLocalHydrogenSlots, neighbourCountSlots } from './local-hydrogen-geometry';
import { getElementPreset } from './element-presets';
import { hasObviousPlacementClash, prepareObviousPlacementClash, prepareIncrementalNewAtomClash, type IncrementalNewAtomClash } from './local-placement';
import { minimumImage } from '../periodic';
import { templateAmidePlaneNormal } from './template-amide-geometry';
import { elementPresetHydrogenLength, ELEMENT_PRESET_COVALENT_RADII } from './element-preset-lengths';
import { externalBondDelta, metalHydrogenConstructionLength } from './connection-length';

export const newModelId = () => crypto.randomUUID();

/** Normal organic initial saturation is a one-time command policy. Never run
 * this after deleting H, changing a bond, copying, moving or optimizing. */
export function saturateNewSite(structure: Structure, atomId: string) {
  const index = structure.atoms.findIndex(atom => atom.id === atomId);
  const atom = structure.atoms[index];
  if (!atom) throw new Error('新增位点不存在。');
  const target = builderDefaultValence(atom);
  // Exotic/over-valent skeletons remain editable, without guessing new charge.
  if (!target || builderCovalentValence(structure, index) > target) {
    return { structure, touchedIds: [atomId], createdFrom: {} as Record<string, string> };
  }
  // Preserve the old general-purpose graph-inference entry for callers that
  // supply no graph. Interactive new-site transactions carry explicit bonds.
  if (!structure.bonds) {
    const candidate = { ...structure, atoms: structure.atoms.map(a => ({ ...a })), bonds: ((structure.bonds as Bond[] | undefined) ?? []).map(b => ({ ...b })) };
    candidate.atoms[index].hydrogenMode = 'auto';
    return placeBuilderHydrogens({ ...candidate, bonds: undefined }, [atomId], 'auto');
  }
  return saturateNewSites(structure, [atomId]);
}

interface NewHBatchSession {
  byId: Map<string | undefined, number>;
  edges: Map<number, Bond[]>;
  finiteValidated: boolean;
  clashes?: IncrementalNewAtomClash;
  layout: Map<string, { x: number; y: number }>;
  planarAtomIds?: ReadonlySet<string>;
}
function newHBatchSession(structure: Structure): NewHBatchSession {
  const byId = new Map<string | undefined, number>(), edges = new Map<number, Bond[]>();
  structure.atoms.forEach((atom, index) => { if (!byId.has(atom.id)) byId.set(atom.id, index); });
  const appendEdge = (index: number, edge: Bond) => { const list = edges.get(index); if (list) list.push(edge); else edges.set(index, [edge]); };
  for (const edge of structure.bonds ?? []) if (edge.kind !== 'coordination') {
    appendEdge(edge.a, edge); if (edge.b !== edge.a) appendEdge(edge.b, edge);
  }
  return { byId, edges, finiteValidated: false, layout: new Map() };
}

/** Atomic explicit-graph batch. Site order and H UUID consumption are exactly
 * the sequential single-site order; no later-site prevalidation or dedup. */
export function saturateNewSites(structure: Structure, orderedAtomIds: readonly string[]) {
  if (!structure.bonds) throw new Error('批量新增位点仅接受已有显式键图。');
  const untouched: string[] = [];
  for (let offset = 0; offset < orderedAtomIds.length; offset++) {
    const atomId = orderedAtomIds[offset], index = structure.atoms.findIndex(a => a.id === atomId), atom = structure.atoms[index];
    if (!atom) throw new Error('新增位点不存在。');
    const target = builderDefaultValence(atom);
    if (!target || builderCovalentValence(structure, index) > target) { untouched.push(atomId); continue; }
    const candidate = { ...structure, atoms: structure.atoms.map(a => ({ ...a })), bonds: structure.bonds.map(b => ({ ...b })) };
    const result = saturateNewSitesInPrivateCandidate(candidate, orderedAtomIds.slice(offset));
    return { structure: result.structure, touchedIds: [...untouched, ...result.touchedIds], createdFrom: result.createdFrom };
  }
  return { structure, touchedIds: untouched, createdFrom: {} as Record<string, string> };
}

/** Internal owned-candidate entry: fragment construction already cloned input.
 * A throw discards that whole private fragment before any store publication.
 * The optional planar sites are only explicit neutral N-C(=O) template sites;
 * ordinary batch and user H commands retain their established local rules. */
export function saturateNewSitesInPrivateCandidate(candidate: Structure, orderedAtomIds: readonly string[], options?: { planarAtomIds?: readonly string[] }) {
  if (!candidate.bonds) throw new Error('批量新增位点仅接受已有显式键图。');
  const session = newHBatchSession(candidate);
  if (options?.planarAtomIds?.length) {
    if (options.planarAtomIds.some(id => !orderedAtomIds.includes(id))) throw new Error('模板平面补H只能指定本次新增位点。');
    if (options.planarAtomIds.some(id => !templateAmidePlaneNormal({ atoms: candidate.atoms, bonds: candidate.bonds! }, session.byId.get(id) ?? -1))) throw new Error('模板平面补H仅支持明确的中性N-C(=O)位点。');
    session.planarAtomIds = new Set(options.planarAtomIds);
  }
  const touchedIds: string[] = [], createdFrom: Record<string, string> = {};
  for (const atomId of orderedAtomIds) {
    const index = session.byId.get(atomId), atom = index === undefined ? undefined : candidate.atoms[index];
    if (!atom) throw new Error('新增位点不存在。');
    const target = builderDefaultValence(atom), localGraph = { atoms: candidate.atoms, bonds: session.edges.get(index!) ?? [] };
    if (!target || builderCovalentValence(localGraph, index!) > target) { touchedIds.push(atomId); continue; }
    const missing = ['B','C','N','O','F','Si','P','S','Cl','Br','I'].includes(atom.element)
      ? Math.max(0, Math.floor(target - builderCovalentValence(localGraph, index!) + 1e-6)) : 0;
    for (let n = 0; n < missing; n++) {
      const result = addNewOnlyHydrogen(candidate, atomId, 'auto', session);
      const id = Object.keys(result.createdFrom)[0];
      candidate.atoms.at(-1)!.hydrogenMode = 'auto';
      touchedIds.push(id); Object.assign(createdFrom, result.createdFrom);
    }
    atom.hydrogenMode = 'auto'; touchedIds.push(atomId);
  }
  if (session.layout.size) candidate.layout2D = { ...candidate.layout2D, ...Object.fromEntries(session.layout) };
  return { structure: candidate, touchedIds, createdFrom };
}

const { add, sub, scale, cross } = builderVector;
const normalize = (v: Vector3): Vector3 | null => {
  const length = Math.hypot(...v);
  return Number.isFinite(length) && length > 1e-9 ? scale(v, 1 / length) : null;
};

export interface AddSingleHydrogenOptions {
  fixedAtomIds?: readonly string[];
  /** Only the explicit interactive single-H command opts into local-slots.
   * Initial saturation, fragment construction and old callers keep their policy. */
  placement?: 'new-only' | 'legacy-fit' | 'local-slots';
  /** Existing world-space single open-slot directions supplied by the store.
   * Available ports add ONE H with every old atom exact. Once exhausted,
   * explicit manual addition uses the normal local neighbour-count policy. */
  openPortDirections?: readonly Vector3[];
}

const candidateSphere: Vector3[] = Array.from({ length: 96 }, (_, i) => {
  const z = 1 - 2 * (i + .5) / 96, radius = Math.sqrt(1 - z * z), angle = i * Math.PI * (3 - Math.sqrt(5));
  return [radius * Math.cos(angle), radius * Math.sin(angle), z];
});

/** One new H at a finite construction direction, with every old XYZ fixed.
 * Full old-space broad phase is prepared once outside the candidate loop.
 * No old-H fit, whole-graph stereo refinement, force field or charge inference. */
export function addSingleHydrogenNewOnly(structure: Structure, atomId: string, mode: 'auto' | 'explicit' = 'explicit') {
  return addNewOnlyHydrogen(structure, atomId, mode);
}

function addNewOnlyHydrogen(structure: Structure, atomId: string, mode: 'auto' | 'explicit', session?: NewHBatchSession) {
  const index = session ? session.byId.get(atomId) ?? -1 : structure.atoms.findIndex(a => a.id === atomId), atom = structure.atoms[index];
  if (!atom) throw new Error('加氢目标已不存在。');
  if (!session?.finiteValidated) {
    if (structure.atoms.some(a => ![a.x,a.y,a.z].every(Number.isFinite))) throw new Error('加氢坐标必须有限。');
    if (session) session.finiteValidated = true;
  }
  const bonds = structure.bonds ?? [], origin = builderPosition(atom);
  const covalent = session ? session.edges.get(index) ?? [] : bonds.filter(b => b.kind !== 'coordination' && (b.a === index || b.b === index));
  const fixed: Vector3[] = covalent.flatMap(b => {
    const other = structure.atoms[b.a === index ? b.b : b.a];
    if (!other) throw new Error('加氢键图引用已失效。');
    let delta = sub(builderPosition(other), origin);
    if (structure.cell && b.image) b.image.forEach((value, axis) => { delta = add(delta, scale(structure.cell!.vectors[axis], value * (b.a === index ? 1 : -1))); });
    else if (structure.cell) delta = minimumImage(structure, index, b.a === index ? b.b : b.a).delta;
    const direction = normalize(delta); return direction ? [direction] : [];
  });
  const aromatic = (b: typeof covalent[number]) => !!b.aromatic || b.order === 1.5 || b.order === 4;
  const linear = covalent.some(b => !aromatic(b) && b.order >= 3), planar = covalent.some(b => aromatic(b) || b.order >= 2)
    || mode === 'auto' && (atom.element === 'C' && atom.formalCharge === 1 || atom.element === 'B' && (atom.formalCharge ?? 0) >= 0 || session?.planarAtomIds?.has(atomId));
  const count = covalent.length + 1;
  const ordinaryCosine = linear ? -1 : planar ? -.5
    : atom.element === 'O' ? Math.cos(((atom.formalCharge ?? 0) > 0 ? 107 : 104.5) * Math.PI / 180)
    : atom.element === 'N' && (atom.formalCharge ?? 0) <= 0 ? Math.cos(((atom.formalCharge ?? 0) < 0 ? 104.5 : 107) * Math.PI / 180) : -1 / 3;
  const cosine = count > (linear ? 2 : planar ? 3 : 4) ? -1 / (count - 1) : ordinaryCosine;
  let planeNormal: Vector3 | undefined;
  if (planar && !linear && count <= 3) {
    const first = fixed[0] ?? [1,0,0];
    planeNormal = (session?.planarAtomIds?.has(atomId) ? templateAmidePlaneNormal({ atoms: structure.atoms, bonds }, index) : undefined)
      ?? fixed.slice(1).map(v => normalize(cross(first,v))).find((v):v is Vector3 => !!v)
      ?? normalize(cross(first,Math.abs(first[0]) < .8 ? [1,0,0] : [0,1,0]))!;
  }
  const length = (mode==='explicit'?metalHydrogenConstructionLength(atom.element):undefined) ?? (mode==='explicit'&&ELEMENT_PRESET_COVALENT_RADII[atom.element]!==undefined&&!['H','C','N','O','Fe'].includes(atom.element)?elementPresetHydrogenLength(atom.element):atom.element === 'H' ? .74 : atom.element === 'C' ? 1.09 : atom.element === 'N' ? 1.01 : atom.element === 'O' ? .97 : 1.15);
  const id = newModelId(), hydrogen: Atom = { id, element:'H', x:origin[0], y:origin[1], z:origin[2], hydrogenMode:mode };
  const bond: Bond = { a: index, b: structure.atoms.length, order: 1 };
  const candidate = !session || atom.stereoParity && count === 4 ? { ...structure, atoms:[...structure.atoms,hydrogen], bonds:[...bonds,bond] } : undefined;
  const incremental = session ? session.clashes ??= prepareIncrementalNewAtomClash(structure) : undefined;
  const staticClashes = incremental ? undefined : prepareObviousPlacementClash(candidate!,[id],structure);
  const clashes = () => incremental ? incremental.hasClash(hydrogen) : staticClashes!([hydrogen]);
  const accept = ([direction]:Vector3[]) => {
    const p = add(origin,scale(direction,length));
    if (!p.every(Number.isFinite)) return false;
    [hydrogen.x,hydrogen.y,hydrogen.z] = p;
    if (clashes()) return false;
    return !atom.stereoParity || count !== 4 || builderTetrahedralParity(candidate!,atomId) === atom.stereoParity;
  };
  let direction: Vector3 | undefined;
  if (session?.planarAtomIds?.has(atomId) && planeNormal && fixed.length === 1) {
    // The amide plane is declared by the immutable N-C=O seed. Intersect its
    // plane with the exact angular cone directly: projecting a generic cone
    // candidate back into an oblique plane changes its target bond angle.
    const u = fixed[0], tangent = normalize(cross(planeNormal, u));
    if (!tangent) throw new Error('酰胺模板平面与固定键方向退化，未猜测补H方向。');
    const sideways = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    direction = [add(scale(u, cosine), scale(tangent, sideways)), sub(scale(u, cosine), scale(tangent, sideways))].find(v => accept([v]));
  }
  else if (fixed.length <= 2) direction = fitLocalHydrogenDirections(fixed,[null],cosine,accept,planeNormal)[0];
  else {
    // Analytic negative bisector is exact for a regular tetrahedral vacancy.
    // Other immutable local arrangements use a bounded angular ranking; never
    // iterate the old H or call this a molecular geometry optimization.
    const sum = normalize(scale(fixed.reduce((sum,v)=>add(sum,v),[0,0,0] as Vector3),-1));
    const candidates = [...(sum ? [sum] : []),...candidateSphere];
    const score = (v:Vector3) => count > 12 ? Math.max(...fixed.map(u=>builderVector.dot(v,u)))
      : fixed.reduce((sum,u)=>sum+(builderVector.dot(v,u)-cosine)**2,0);
    const ranked = candidates.map((v,order)=>({v,order,score:score(v)})).sort((a,b)=>Math.abs(a.score-b.score)>1e-9 ? a.score-b.score : a.order-b.order);
    direction = ranked.find(({v})=>accept([v]))?.v;
  }
  if (!direction) throw new Error('固定局部几何、已指定手性或明显重叠防线下无安全加氢候选。');
  // Reapply the chosen position: failed later candidate checks only modified
  // this private single-H buffer, never any original atom or structure field.
  const p = add(origin,scale(direction,length)); [hydrogen.x,hydrogen.y,hydrogen.z] = p;
  structure.atoms.push(hydrogen);
  if (session) {
    bonds.push(bond); structure.bonds = bonds;
    session.byId.set(id, structure.atoms.length - 1);
    const edges = session.edges.get(index); if (edges) edges.push(bond); else session.edges.set(index, [bond]);
    session.edges.set(structure.atoms.length - 1, [bond]);
    incremental!.appendAccepted(hydrogen);
    session.layout.set(id, { x: hydrogen.x, y: hydrogen.y });
  } else {
    structure.bonds = candidate!.bonds;
    structure.layout2D = { ...structure.layout2D,[id]:{x:hydrogen.x,y:hydrogen.y} };
  }
  return { structure, touchedIds:[atomId,id], createdFrom:{[id]:atomId} };
}

/** One explicit H and a local VSEPR angular fit of the centre's free terminal
 * H atoms. Every heavy atom, fixed H and original bond remains unchanged. */
export function addSingleHydrogen(structure: Structure, atomId: string, options: AddSingleHydrogenOptions = {}) {
  if(options.openPortDirections!==undefined){
    const index=structure.atoms.findIndex(atom=>atom.id===atomId),atom=structure.atoms[index];
    if(!atom?.geometryPresetId)throw new Error('手工H开放槽需要明确命名几何。');
    const preset=getElementPreset(atom.geometryPresetId);
    // Saved coordination ports retain their identities even though new seeds
    // with the same preset ID now create real H caps.
    if(preset.attachmentLengthPolicy!=='covalent-radii'||!preset.slots.length||preset.family!=='coordination'&&preset.slots.some(slot=>slot.fill!=='open'))throw new Error('该预设不使用手工H开放槽路径。');
    if(!options.openPortDirections.length)return addSingleHydrogen(structure,atomId,{fixedAtomIds:options.fixedAtomIds,placement:'local-slots'});
    if(structure.atoms.some(a=>![a.x,a.y,a.z].every(Number.isFinite)))throw new Error('加氢坐标必须有限。');
    const bonds=structure.bonds??[],origin=builderPosition(atom),id=newModelId();
    const hydrogen:Atom={id,element:'H',x:origin[0],y:origin[1],z:origin[2],hydrogenMode:'explicit'};
    const candidate={...structure,atoms:[...structure.atoms,hydrogen],bonds:[...bonds,{a:index,b:structure.atoms.length,order:1}]};
    const clashes=prepareObviousPlacementClash(candidate,[id],structure);
    const occupied=bonds.filter(bond=>bond.a===index||bond.b===index).map(bond=>externalBondDelta(structure,index,bond.a===index?bond.b:bond.a)).map(normalize).filter((v):v is Vector3=>!!v);
    const chosen=options.openPortDirections.find(direction=>{
      if(direction.length!==3||!direction.every(Number.isFinite)||Math.abs(Math.hypot(...direction)-1)>1e-6)throw new Error('手工H开放槽方向无效。');
      if(occupied.some(other=>Math.hypot(...sub(direction,other))<1e-6))return false;
      const point=add(origin,scale(direction,preset.hydrogenLength));[hydrogen.x,hydrogen.y,hydrogen.z]=point;
      if(!point.every(Number.isFinite)||clashes([hydrogen]))return false;
      try{assertBuilderStereoPreserved(structure,candidate);}catch{return false;}return true;
    });
    if(!chosen)throw new Error('未占用单键槽下无安全手工H候选，原结构未改变。');
    structure.atoms.push(hydrogen);structure.bonds=candidate.bonds;structure.layout2D={...structure.layout2D,[id]:{x:hydrogen.x,y:hydrogen.y}};
    return{structure,touchedIds:[atomId,id],createdFrom:{[id]:atomId}};
  }
  if (options.placement === 'new-only') return addSingleHydrogenNewOnly(structure, atomId);
  const index = structure.atoms.findIndex(atom => atom.id === atomId);
  const atom = structure.atoms[index];
  if (!atom) throw new Error('加氢目标已不存在。');
  const bonds = structure.bonds ?? [];
  const useSlots = options.placement === 'local-slots';
  const metalLength = metalHydrogenConstructionLength(atom.element);
  if (useSlots && structure.atoms.some(a => ![a.x, a.y, a.z].every(Number.isFinite))) throw new Error('加氢坐标必须有限。');
  const covalent = bonds.filter(bond => (useSlots || bond.kind !== 'coordination') && (bond.a === index || bond.b === index));
  const preset = useSlots && atom.geometryPresetId ? getElementPreset(atom.geometryPresetId) : undefined;
  const slots = useSlots ? preset?.slots.length && covalent.length + 1 <= preset.slots.length ? preset.slots.map(slot => slot.direction) : neighbourCountSlots(covalent.length + 1) : undefined;
  // A named seed describes initial geometry, not a manual valence ceiling.
  // Explicit additions beyond it reuse local neighbour-count construction;
  // crowded sites retain the existing bounded new-H-only fallback.
  if (useSlots && !slots) return addSingleHydrogenNewOnly(structure, atomId);
  const origin = builderPosition(atom);
  if (!origin.every(Number.isFinite)) throw new Error('加氢中心坐标必须有限。');
  const fixedIds = new Set(options.fixedAtomIds ?? []);
  const local = covalent.map(bond => {
    const otherIndex = bond.a === index ? bond.b : bond.a, other = structure.atoms[otherIndex];
    if (!other) throw new Error('加氢键图引用已失效。');
    let offset: Vector3 = [0, 0, 0];
    if (structure.cell && bond.image) for (let i = 0; i < 3; i++) {
      offset = add(offset, scale(structure.cell.vectors[i], bond.image[i] * (bond.a === index ? 1 : -1)));
    }
    else if (useSlots && structure.cell) offset = sub(minimumImage(structure, index, otherIndex).delta, sub(builderPosition(other), origin));
    const direction = normalize(sub(add(builderPosition(other), offset), origin));
    // Bridging/otherwise multiply connected H is conservatively fixed: moving
    // it would edit another centre's geometry as a side effect.
    const terminal = bonds.filter(b => b.a === otherIndex || b.b === otherIndex).length === 1;
    const oldLength = Math.hypot(...sub(add(builderPosition(other), offset), origin));
    return { other, otherIndex, offset, direction, oldLength, movable: other.element === 'H' && terminal && !fixedIds.has(other.id!)
      && (!useSlots || bond.kind !== 'coordination' && bond.order === 1 && !bond.aromatic) };
  });
  const count = local.length + 1;
  // Very crowded intentionally over-valent sites use bounded new-H placement;
  // keep their old Cartesian H positions as well as their old directions.
  const moving = metalLength===undefined && count <= 12 ? local.filter(entry => entry.movable) : [];
  const neighbours = local.filter(entry => !moving.includes(entry)).flatMap(entry => entry.direction ? [entry.direction] : []);
  const aromatic = (bond: typeof covalent[number]) => !!bond.aromatic || bond.order === 1.5 || bond.order === 4;
  const linear = covalent.some(bond => !aromatic(bond) && bond.order >= 3);
  const planar = covalent.some(bond => aromatic(bond) || bond.order >= 2);
  const ordinaryCosine = linear ? -1 : planar ? -.5
    : atom.element === 'O' ? Math.cos(((atom.formalCharge ?? 0) > 0 ? 107 : 104.5) * Math.PI / 180)
    : atom.element === 'N' && (atom.formalCharge ?? 0) <= 0 ? Math.cos(((atom.formalCharge ?? 0) < 0 ? 104.5 : 107) * Math.PI / 180)
    : -1 / 3;
  // Deliberate over-valence remains legal, using angular dispersion rather
  // than pretending a fifth H can occupy a tetrahedral vertex.
  const cosine = count > (linear ? 2 : planar ? 3 : 4) ? -1 / (count - 1) : ordinaryCosine;
  let planeNormal: Vector3 | undefined;
  if (planar && !linear && count <= 3) {
    const directions = [...neighbours, ...moving.flatMap(entry => entry.direction ? [entry.direction] : [])];
    const first = directions[0] ?? [1, 0, 0];
    planeNormal = directions.slice(1).map(other => normalize(cross(first, other))).find((normal): normal is Vector3 => !!normal)
      ?? normalize(cross(first, Math.abs(first[0]) < .8 ? [1, 0, 0] : [0, 1, 0]))!;
  }
  const length = metalLength ?? (useSlots && preset?.slots.length ? preset.hydrogenLength : useSlots&&ELEMENT_PRESET_COVALENT_RADII[atom.element]!==undefined&&!['H','C','N','O','Fe'].includes(atom.element)?elementPresetHydrogenLength(atom.element):atom.element === 'H' ? .74 : atom.element === 'C' ? 1.09 : atom.element === 'N' ? 1.01 : atom.element === 'O' ? .97 : 1.15);
  const id = newModelId();
  const candidateAtoms = structure.atoms.map(a => ({ ...a }));
  // Derive a validation-only reference from actual distinguishable substituent
  // graphs as well as explicit stereo metadata. updateBuilderStereo clones its
  // atoms/bonds, so neither inferred parity nor regenerated wedges are written
  // into the caller's structure. Equivalent H substituents remain achiral.
  const stereoReference = updateBuilderStereo(structure).structure;
  candidateAtoms.push({ id, element: 'H', x: origin[0], y: origin[1], z: origin[2] });
  const candidateBonds = [...bonds, { a: index, b: candidateAtoms.length - 1, order: 1 }];
  const setPoints = (directions: Vector3[]) => {
    moving.forEach((entry, i) => {
      const retainedLength = useSlots && Number.isFinite(entry.oldLength) && entry.oldLength > 1e-9 ? entry.oldLength : length;
      const p = sub(add(origin, scale(directions[i], retainedLength)), entry.offset);
      Object.assign(candidateAtoms[entry.otherIndex], { x: p[0], y: p[1], z: p[2] });
    });
    const p = add(origin, scale(directions[directions.length - 1], length));
    Object.assign(candidateAtoms[candidateAtoms.length - 1], { x: p[0], y: p[1], z: p[2] });
  };
  const candidate = { ...structure, atoms: candidateAtoms, bonds: candidateBonds };
  const changedIds = [...moving.map(entry => entry.other.id!), id];
  const slotClashes = useSlots ? prepareObviousPlacementClash(candidate, changedIds, structure) : undefined;
  const accept = (directions: Vector3[]) => {
    setPoints(directions);
    if (slotClashes ? slotClashes([...moving.map(entry => candidateAtoms[entry.otherIndex]), candidateAtoms.at(-1)!])
      : hasObviousPlacementClash(candidate, changedIds, structure)) return false;
    // Check the original graph first: explicit addition may make a chiral
    // centre over-valent, but must not invert its original four substituents or
    // an existing E/Z arrangement while moving their H. Metadata is untouched.
    try { assertBuilderStereoPreserved(stereoReference, { ...structure, atoms: candidateAtoms, bonds }); }
    catch { return false; }
    return !atom.stereoParity || count !== 4 || builderTetrahedralParity({ ...structure, atoms: candidateAtoms, bonds: candidateBonds }, atomId) === atom.stereoParity;
  };
  const initial = [...moving.map(entry => entry.direction), null];
  const directions = slots ? fitLocalHydrogenSlots(slots, local.filter(entry => !moving.includes(entry)).map(entry => entry.direction), initial, accept)
    : fitLocalHydrogenDirections(neighbours, initial, cosine, accept, planeNormal);
  setPoints(directions);
  if (candidateAtoms.some(a => ![a.x, a.y, a.z].every(Number.isFinite))) throw new Error('局部加氢不能生成非有限坐标。');
  const point = builderPosition(candidateAtoms[candidateAtoms.length - 1]);
  const hydrogen: Atom = { id, element: 'H', x: point[0], y: point[1], z: point[2], hydrogenMode: 'explicit' };
  const touchedIds = [atomId, id];
  for (const entry of moving) {
    const p = builderPosition(candidateAtoms[entry.otherIndex]);
    if (p.some((value, axis) => value !== builderPosition(entry.other)[axis])) {
      Object.assign(entry.other, { x: p[0], y: p[1], z: p[2] });
      if (entry.other.id) touchedIds.push(entry.other.id);
      structure.layout2D = { ...structure.layout2D, [entry.other.id!]: { x: p[0], y: p[1] } };
    }
  }
  structure.atoms.push(hydrogen);
  structure.bonds = [...bonds, { a: index, b: structure.atoms.length - 1, order: 1 }];
  structure.layout2D = { ...structure.layout2D, [id]: { x: point[0], y: point[1] } };
  return { structure, touchedIds, createdFrom: { [id]: atomId } };
}

/** Private 2D-to-3D preparation: fill ordinary missing valence only. Existing
 * drawn H, wedge bonds, open-valence intent and deliberately over-valent sites
 * remain untouched. Flat H positions are diagram seeds, never 3D optimization. */
export function prepare2DHydrogens(structure: Structure) {
  if (structure.dimension !== 2 || structure.cell?.pbc.some(Boolean)) throw new Error('二维生成准备仅接受非周期二维草稿。');
  const targets = structure.atoms.filter(atom => atom.element !== 'H' && atom.hydrogenMode !== 'explicit').map(atom => atom.id!);
  const touchedIds: string[] = [], createdFrom: Record<string, string> = {};
  for (const atomId of targets) {
    const index = structure.atoms.findIndex(atom => atom.id === atomId), atom = structure.atoms[index];
    const target = builderDefaultValence(atom), valence = builderCovalentValence(structure, index);
    if (!target || valence >= target) continue;
    const missing = Math.max(0, Math.floor(target - valence + 1e-6));
    for (let count = 0; count < missing; count++) {
      const neighbours = (structure.bonds ?? []).filter(bond => bond.kind !== 'coordination' && (bond.a === index || bond.b === index)).map(bond => structure.atoms[bond.a === index ? bond.b : bond.a]);
      const angles = neighbours.map(other => Math.atan2(other.y - atom.y, other.x - atom.x));
      const candidates = Array.from({ length: 72 }, (_, step) => step * Math.PI / 36);
      const score = (candidate: number) => angles.length ? Math.max(...angles.map(angle => Math.cos(candidate - angle))) : 0;
      const angle = candidates.reduce((best, candidate) => score(candidate) < score(best) - 1e-9 ? candidate : best);
      const length = atom.element === 'C' ? 1.09 : atom.element === 'N' ? 1.01 : atom.element === 'O' ? .97 : 1.15;
      const id = newModelId(), x = atom.x + Math.cos(angle) * length, y = atom.y + Math.sin(angle) * length;
      structure.atoms.push({ id, element: 'H', x, y, z: 0, hydrogenMode: 'auto' });
      structure.bonds = [...(structure.bonds ?? []), { a: index, b: structure.atoms.length - 1, order: 1 }];
      structure.layout2D = { ...structure.layout2D, [id]: { x, y } };
      touchedIds.push(id); createdFrom[id] = atomId;
    }
    if (missing) touchedIds.push(atomId);
  }
  return { structure, touchedIds, createdFrom };
}
