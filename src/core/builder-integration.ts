import type { BuilderApplyResult, BuilderAssignments } from './builder-draft';
import type { GaussianSettings, Structure } from './types';
import { coordinateAtoms, defaultTaskOptions } from './tasks';
import { isInputLayerDraftForEngine, migrateInputLayerDraft } from './input-layer-capability';

const unique = <T,>(values: T[]) => [...new Set(values)];
const idsFromNumbers = (structure: Structure, numbers: number[]) => unique(numbers.flatMap(number => structure.atoms[number - 1]?.id ? [structure.atoms[number - 1].id!] : []));
export const GAUSSIAN_ONIOM_HIGH_REGION = 'gaussian-oniom-high';
export const GAUSSIAN_ONIOM_LOW_REGION = 'gaussian-oniom-low';

/** Capture only real memberships; empty form rows remain form drafts, not model regions. */
export function captureBuilderAssignments(structure: Structure | null, settings: GaussianSettings): BuilderAssignments {
  if (!structure) return { layers: [], basis: [], fragments: [], frozenAtomIds: [] };
  const options = settings.taskOptions ?? defaultTaskOptions();
  // Imported source layers are evidence, not current task memberships. Only
  // explicit model regions or the current ONIOM form may enter this consumer.
  let layers: BuilderAssignments['layers'] = structure.modelLayers?.map(layer => ({ ...layer, atomIds: [...layer.atomIds] })) ?? [];
  if (settings.oniom?.enabled) {
    const known = new Set(structure.atoms.map(atom => atom.id));
    const qm = unique(settings.oniom.qmAtomIds.filter(id => known.has(id)));
    const high = new Set(qm);
    // An enabled scientific partition owns this view; do not overlay stale imported layers.
    const layerDrafts=layers.filter(layer=>isInputLayerDraftForEngine(layer,'gaussian')).map(migrateInputLayerDraft);
    layers = layerDrafts.length?layerDrafts:[
      { id: GAUSSIAN_ONIOM_HIGH_REGION, label: 'ONIOM QM', kind: 'qm', atomIds: qm },
      { id: GAUSSIAN_ONIOM_LOW_REGION, label: 'ONIOM UFF', kind: 'mm', frozen: settings.oniom.freezeLowLayer, atomIds: structure.atoms.flatMap(atom => atom.id && !high.has(atom.id) ? [atom.id] : []) },
    ];
  } else {
    layers = layers.map(layer => layer.id === GAUSSIAN_ONIOM_LOW_REGION ? { ...layer, frozen: false } : layer);
  }
  return {
    layers: layers.filter(layer => layer.atomIds.length > 0 || isInputLayerDraftForEngine(layer,'gaussian')).map(migrateInputLayerDraft),
    basis: (settings.mixedBasis?.regions ?? []).filter(region => region.atoms.length > 0).map(region => ({ id: region.id, label: region.name, basis: region.basis, atomIds: idsFromNumbers(structure, region.atoms) })),
    fragments: options.fragments.flatMap((fragment, index) => fragment.atoms.length ? [{ id: `fragment-${index}`, label: `Fragment ${index + 1}`, charge: fragment.charge, multiplicity: fragment.multiplicity, atomIds: idsFromNumbers(structure, fragment.atoms) }] : []),
    frozenAtomIds: idsFromNumbers(structure, options.frozenAtoms),
  };
}

export interface BuilderIntegrationResult {
  structure: Structure;
  settings: GaussianSettings;
  invalidatedCoordinates: string[];
  warnings: string[];
  materialChanged: boolean;
}

export function builderMaterialSignature(structure: Structure | null): string {
  if (!structure) return 'null';
  return JSON.stringify({ atoms: structure.atoms.map(atom => [atom.id, atom.element, atom.formalCharge ?? 0, atom.x, atom.y, atom.z]),
    bonds: (structure.bonds ?? []).map(bond => {
      const a=structure.atoms[bond.a]?.id??String(bond.a),b=structure.atoms[bond.b]?.id??String(bond.b),reverse=a>b;
      const image=(bond.image??[0,0,0]).map(value=>reverse?-value:value);
      return [reverse?b:a,reverse?a:b,bond.aromatic||bond.order===1.5||bond.order===4?'aromatic':bond.order,bond.kind??'covalent',image];
    }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    cell: structure.cell ?? null, charge: structure.charge, dimension: structure.dimension });
}

/** Presentation edits must not invalidate a generated Gaussian job. */
export function builderJobStructure(structure: Structure | null): unknown {
  if (!structure) return null;
  return { dimension:structure.dimension,
    atoms:structure.atoms.map(atom=>[atom.id,atom.element,atom.x,atom.y,atom.z]),
  };
}

/** Preserve the user's total charge, applying only an explicit formal-charge edit. */
export function builderCommittedCharge(original: Structure | null, next: Structure, currentCharge: number): number {
  const total = (structure: Structure | null) => structure?.atoms.reduce((sum, atom) => sum + (atom.formalCharge ?? 0), 0) ?? 0;
  return currentCharge + total(next) - total(original);
}

/** Numeric Gaussian centers are rebuilt once at commit from the stable editing identities. */
export function integrateBuilderResult(original: Structure | null, result: BuilderApplyResult, previous: GaussianSettings): BuilderIntegrationResult {
  const next = structuredClone(result.structure), settings = structuredClone(previous);
  const materialChanged = builderMaterialSignature(original) !== builderMaterialSignature(next);
  const options = settings.taskOptions ?? defaultTaskOptions();
  const newNumbers = new Map(next.atoms.map((atom, index) => [atom.id, index + 1]));
  if (newNumbers.has(undefined) || newNumbers.size !== next.atoms.length) throw new Error('建模结果的原子身份不完整或重复。');
  if (!original && result.baseAtomIds.length) throw new Error('原计算结构已移除，旧建模草稿不能恢复覆盖当前空工作区。');
  if (original && (result.baseAtomIds.length !== original.atoms.length || result.baseAtomIds.some((id, index) => id !== original.atoms[index].id))) throw new Error('计算结构已改变，旧建模草稿不能覆盖当前结构。');
  if (original && result.baseRevision !== (original.revision ?? 0)) throw new Error('计算结构修订已改变，旧建模草稿不能覆盖当前结构。');
  // XYZ-like sources have no authoritative graph; draft initialization may infer it.
  const formalBase = original?.bonds === undefined ? { ...result.baseStructure, bonds: undefined } : result.baseStructure;
  if (original && builderMaterialSignature(original) !== builderMaterialSignature(formalBase)) throw new Error('计算结构内容已改变，旧建模草稿不能覆盖当前结构。');
  const remap = (number: number): number | undefined => original?.atoms[number - 1]?.id ? newNumbers.get(original.atoms[number - 1].id) : undefined;
  const fromIds = (ids: string[]) => unique(ids.flatMap(id => newNumbers.has(id) ? [newNumbers.get(id)!] : []));
  const invalidatedCoordinates: string[] = [];
  options.coordinates = options.coordinates.map((coordinate, index) => {
    const mapped = coordinate.atoms.map(remap);
    if (mapped.some(value => value === undefined)) invalidatedCoordinates.push(`内坐标 ${index + 1}`);
    return { ...coordinate, atoms: mapped.map(value => value ?? 0) };
  });
  if (options.coordinateDrafts) options.coordinateDrafts = options.coordinateDrafts.map((draft, index) => {
    try {
      const numbers = coordinateAtoms(draft.atomText), mapped = numbers.map(remap);
      if (mapped.some(value => value === undefined)) invalidatedCoordinates.push(`内坐标草稿 ${index + 1}`);
      return { ...draft, atomText: mapped.map(value => value ?? '?').join(',') };
    } catch { return draft; } // Already-invalid user drafts stay invalid rather than acquire another atom.
  });
  options.frozenAtoms = fromIds(result.assignments.frozenAtomIds);
  options.fragments = options.fragments.map((fragment, index) => {
    const assignment = result.assignments.fragments.find(entry => entry.id === `fragment-${index}`);
    return { ...fragment, atoms: assignment ? fromIds(assignment.atomIds) : fragment.atoms.flatMap(number => remap(number) === undefined ? [] : [remap(number)!]),
      charge: assignment?.charge ?? fragment.charge, multiplicity: assignment?.multiplicity ?? fragment.multiplicity };
  });
  if (materialChanged) {
    options.fragmentStatesConfirmed = false;
    options.irc = { ...options.irc, confirmed: false };
    options.stable = { ...options.stable, confirmed: false };
  }
  settings.taskOptions = options;
  if (settings.mixedBasis) settings.mixedBasis.regions = settings.mixedBasis.regions.map(region => {
    const assignment = result.assignments.basis.find(entry => entry.id === region.id);
    return { ...region, atoms: assignment ? fromIds(assignment.atomIds) : region.atoms.flatMap(number => remap(number) === undefined ? [] : [remap(number)!]) };
  });
  next.modelLayers = result.assignments.layers.flatMap(entry => entry.kind ? [{ id: entry.id, label: entry.label ?? entry.id, kind: entry.kind,
    ...(entry.frozen !== undefined ? { frozen: entry.frozen } : {}), ...(migrateInputLayerDraft(entry).draftRole!==undefined?{draftRole:migrateInputLayerDraft(entry).draftRole}:{}), atomIds: entry.atomIds.filter(id => newNumbers.has(id)) }] : []);
  next.molfile = undefined;
  next.gaussianSource = undefined; next.gaussianSources = undefined; next.sourceRoute = undefined;
  if (!materialChanged && original) {
    next.gaussianSource = structuredClone(original.gaussianSource);
    next.gaussianSources = structuredClone(original.gaussianSources);
    next.sourceRoute = original.sourceRoute;
    next.preparation = structuredClone(original.preparation);
  }
  const changedCenters = !original || original.atoms.length !== next.atoms.length || original.atoms.some((atom, index) => atom.id !== next.atoms[index]?.id || atom.element !== next.atoms[index]?.element);
  if (changedCenters && settings.inheritedRoute?.basisTail) {
    const inherited = { ...settings.inheritedRoute }; delete inherited.basisTail; delete inherited.basisKeyword;
    settings.inheritedRoute = inherited;
    settings.inheritanceIssues = [...(settings.inheritanceIssues ?? []).filter(issue => issue.code !== 'builder-source-basis'), { code: 'builder-source-basis', field: 'basis', severity: 'missing', message: '原子中心已改变，请重新分配来源Gen基组或选择当前基组；旧中心段未沿用。' }];
  }
  const warnings = unique([...result.assignmentIssues, ...invalidatedCoordinates.map(label => `${label}引用的原子已删除，请重新指定或关闭该行。`)]);
  return { structure: next, settings, invalidatedCoordinates, warnings, materialChanged };
}
