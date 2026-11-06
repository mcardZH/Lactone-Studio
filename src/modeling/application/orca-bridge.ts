import type { BuilderApplyResult, BuilderAssignments, BuilderAssignment } from '../../core/builder-draft';
import { builderCommittedCharge, builderMaterialSignature } from '../../core/builder-integration';
import { builderCoordinateValue } from '../../core/builder-geometry';
import type { OrcaCoordinate, OrcaJobRequest, OrcaSettings } from '../../core/orca/types';
import type { Structure } from '../../core/types';
import type { ModelCoordinate, ModelDocument, SharedModelConstraints } from '../contracts';
import { assertAtomScanCompatibility, mergeModelCoordinates, modelCoordinateKey } from '../constraints';
import { getMovableAtomIds } from '../../core/modeling';
import { modelChange } from './model-change';
import { invalidateHessianPathEvidence } from '../../core/orca/hessian-path';
import { initialBaseElectronicState, retainBaseElectronicStateConfirmation } from '../../core/base-electronic-state';
import { isInputLayerDraft, isInputLayerDraftForEngine, migrateInputLayerDraft } from '../../core/input-layer-capability';
import { inheritedSharedFreezes } from './shared-freeze-inheritance';
import { projectOrcaFreezeSettings } from '../../core/input-freezes';
import { projectCanonicalOrcaFreezes } from './canonical-freezes';

type OrcaApplyResult = BuilderApplyResult & { internalCoordinates?: ModelCoordinate[] };
export interface OrcaBuilderIntegration { structure: Structure; settings: OrcaSettings; warnings: string[]; materialChanged: boolean; constraintsChanged: boolean }
const clone = <T,>(value: T): T => structuredClone(value);
const QM_REGION = 'orca-qm-region';
const LOW_REGION = 'orca-low-region';
const QM_FIXED_REGION = `${QM_REGION}-fixed`;
const LOW_FIXED_REGION = `${LOW_REGION}-fixed`;
const MD_ACTIVE_REGION = 'orca-md-active';
const MD_FIXED_REGION = 'orca-md-fixed';
const OWN_REGIONS = [QM_REGION, LOW_REGION, QM_FIXED_REGION, LOW_FIXED_REGION, MD_ACTIVE_REGION, MD_FIXED_REGION];
const rowId = (scope: 'constraints' | 'md', index: number) => `orca-${scope}-${index}`;

/** Consumer-only merge. Private ORCA settings keep their original provenance and are not overwritten. */
export function applySharedOrcaConstraints(structure:Structure|null,settings:OrcaSettings,shared?:SharedModelConstraints):{settings:OrcaSettings;errors:string[]} {
  if(shared?.canonical){
    const next=projectCanonicalOrcaFreezes(structure,settings,shared),errors:string[]=[];
    if(shared.enabled===false)return {settings:projectOrcaFreezeSettings(next),errors};
    if(!shared.frozenAtomIds.length&&!shared.coordinates.length)return {settings:next,errors};
    if(!structure)return {settings:next,errors:['模型冻结缺少对应三维结构。']};
    if(!['opt','optfreq','ts','scan','tdopt','md'].includes(settings.task))errors.push('当前ORCA任务不支持模型冻结；请选择支持约束的任务或解除对应冻结。');
    const known=new Set(structure.atoms.map(atom=>atom.id));
    if([...shared.frozenAtomIds,...shared.coordinates.flatMap(row=>row.atomIds)].some(id=>!known.has(id)))errors.push('模型冻结引用了失效原子身份。');
    try{assertAtomScanCompatibility(shared.frozenAtomIds,captureOrcaCoordinates(structure,next));}catch(cause){errors.push(cause instanceof Error?cause.message:String(cause));}
    if(settings.task==='md'){
      const frozen=new Set(shared.frozenAtomIds);next.frozenAtomIds=[];
      next.md.activeAtomIds=(settings.md.activeAtomIds.length?settings.md.activeAtomIds:structure.atoms.map(atom=>atom.id!)).filter(id=>!frozen.has(id));
      if(!next.md.activeAtomIds.length)errors.push('模型冻结排除了全部ORCA MD活动原子；空活动列表不能代替全部冻结。');
      next.md.constraints=next.md.constraints.map(row=>row.action==='freeze'&&row.value===undefined?{...row,value:builderCoordinateValue(structure,row.type,row.atomIds)}:row);
    }
    return {settings:next,errors};
  }
  if(settings.freezeEnabled===false)return {settings:projectOrcaFreezeSettings(settings),errors:[]};
  shared=inheritedSharedFreezes(shared,settings.inheritModelFreeze);
  if(!shared||!shared.frozenAtomIds.length&&!shared.coordinates.length)return {settings,errors:[]};
  const next=clone(settings),errors:string[]=[];
  if(!structure)return {settings:next,errors:['建模共有冻结缺少对应模型。']};
  const known=new Set(structure.atoms.map(atom=>atom.id));
  if([...shared.frozenAtomIds,...shared.coordinates.flatMap(row=>row.atomIds)].some(id=>!known.has(id)))errors.push('建模共有冻结引用已失效原子。');
  const privateRows=captureOrcaCoordinates(structure,settings);
  try{mergeModelCoordinates(privateRows,shared.coordinates);}catch(error){errors.push(error instanceof Error?error.message:String(error));}
  const privateKeys=new Set(privateRows.map(modelCoordinateKey)),added=shared.coordinates.filter(row=>!privateKeys.has(modelCoordinateKey(row))).map(row=>({type:row.type,atomIds:[...row.atomIds],objectId:row.objectId,action:'freeze' as const}));
  const effectiveAtoms=[...new Set([...next.frozenAtomIds,...shared.frozenAtomIds])];
  try{assertAtomScanCompatibility(effectiveAtoms,mergeModelCoordinates(privateRows,shared.coordinates));}catch(error){const message=error instanceof Error?error.message:String(error);if(!errors.includes(message))errors.push(message);}
  if(settings.task==='md'){
    if(settings.inheritModelFreeze?.atoms!==false){const frozen=new Set(shared.frozenAtomIds);next.md.activeAtomIds=(next.md.activeAtomIds.length?next.md.activeAtomIds:structure.atoms.map(atom=>atom.id!)).filter(id=>!frozen.has(id));}
    if(settings.inheritModelFreeze?.atoms!==false&&!next.md.activeAtomIds.length)errors.push('共有冻结排除了全部ORCA MD活动原子；空活动列表不能代替全部冻结。');
    next.md.constraints=[...next.md.constraints,...added.map(row=>({...row,value:builderCoordinateValue(structure,row.type,row.atomIds)}))];
  }else{next.frozenAtomIds=effectiveAtoms;next.constraints=[...next.constraints,...added];}
  return {settings:next,errors};
}

/** Stable identities are scientific memberships; model selection never changes them. */
export function captureOrcaAssignments(structure: Structure | null, settings: OrcaSettings): BuilderAssignments {
  if (!structure) return { layers: [], basis: [], fragments: [], frozenAtomIds: [] };
  const ids = new Set(structure.atoms.map(atom => atom.id!)), known = (values: string[]) => values.filter(id => ids.has(id));
  const layers: BuilderAssignment[] = clone(structure.modelLayers ?? []).filter(layer => isInputLayerDraft(layer) || !OWN_REGIONS.includes(layer.id) && !['gaussian-oniom-high','gaussian-oniom-low'].includes(layer.id));
  const layerDrafts = layers.filter(layer => isInputLayerDraftForEngine(layer,'orca')).map(migrateInputLayerDraft);
  if (layerDrafts.length) return { layers: layerDrafts, basis: [], fragments: settings.fragments.flatMap(fragment => known(fragment.atomIds).length && Number.isInteger(fragment.charge) && Number.isInteger(fragment.multiplicity) && fragment.multiplicity > 0 ? [{ ...clone(fragment), atomIds: known(fragment.atomIds), label: fragment.id }] : []), frozenAtomIds: settings.freezeEnabled===false?[]:known(settings.frozenAtomIds) };
  for (let i=layers.length-1;i>=0;i--) if (isInputLayerDraft(layers[i])) layers.splice(i,1);
  const multiscaleActive = settings.multiscale.mode !== 'none' && settings.multiscale.activeAtomIds?.length ? new Set(settings.multiscale.activeAtomIds) : null;
  const mdActive = settings.task === 'md' && settings.md.activeAtomIds.length ? new Set(settings.md.activeAtomIds) : null;
  const active = (id: string) => (!multiscaleActive || multiscaleActive.has(id)) && (!mdActive || mdActive.has(id));
  const partition = (id: string, fixedId: string, label: string, kind: 'qm' | 'mm' | undefined, members: string[], freezeAll = false) => {
    if (!members.length) return;
    if (!multiscaleActive && !mdActive) { layers.push({ id, label, kind, atomIds: members, frozen: freezeAll }); return; }
    const movable = members.filter(atomId => !freezeAll && active(atomId)), fixed = members.filter(atomId => freezeAll || !active(atomId));
    if (movable.length) layers.push({ id, label: `${label} · 可动`, kind, atomIds: movable, frozen: false });
    if (fixed.length) layers.push({ id: fixedId, label: `${label} · 固定`, kind, atomIds: fixed, frozen: true });
  };
  if (settings.multiscale.mode !== 'none') {
    partition(QM_REGION, QM_FIXED_REGION, 'ORCA QM', 'qm', known(settings.multiscale.qmAtomIds));
    const low = structure.atoms.flatMap(atom => settings.multiscale.qmAtomIds.includes(atom.id!) ? [] : [atom.id!]);
    partition(LOW_REGION, LOW_FIXED_REGION, 'ORCA low layer', 'mm', low, settings.multiscale.freezeLowLayer);
  } else if (mdActive) partition(MD_ACTIVE_REGION, MD_FIXED_REGION, 'ORCA MD活动范围', undefined, structure.atoms.map(atom => atom.id!));
  return { layers, basis: [], fragments: settings.fragments.flatMap(fragment => known(fragment.atomIds).length && Number.isInteger(fragment.charge) && Number.isInteger(fragment.multiplicity) && fragment.multiplicity > 0
    ? [{ ...clone(fragment), atomIds: known(fragment.atomIds), label: fragment.id }] : []), frozenAtomIds: settings.freezeEnabled===false?[]:known(settings.frozenAtomIds) };
}

/** An explicit activity list also keeps newly placed, unassigned atoms fixed. */
export function getOrcaMovableAtomIds(document: ModelDocument, settings: OrcaSettings, scope: 'all' | 'selection'): string[] {
  const movable = getMovableAtomIds(document, scope);
  const restricted = settings.multiscale.mode !== 'none' && Boolean(settings.multiscale.activeAtomIds?.length) || settings.task === 'md' && settings.md.activeAtomIds.length > 0;
  if (!restricted) return movable;
  const activeRegions = settings.multiscale.mode !== 'none' ? [QM_REGION, LOW_REGION] : [MD_ACTIVE_REGION];
  const active = new Set(document.draft.assignments.layers.filter(layer => activeRegions.includes(layer.id) && !layer.frozen).flatMap(layer => layer.atomIds));
  return movable.filter(id => active.has(id));
}

function modelReady(row: OrcaCoordinate, structure: Structure): boolean {
  const count = { B: 2, A: 3, D: 4 }[row.type], ids = new Set(structure.atoms.map(atom => atom.id));
  if (!count || row.atomIds.length !== count || new Set(row.atomIds).size !== count || row.atomIds.some(id => !ids.has(id))) return false;
  const valid = (value: number | undefined) => value !== undefined && Number.isFinite(value) && (row.type === 'B' ? value > 0 : row.type === 'A' ? value > 0 && value < 180 : true);
  if (row.action === 'freeze') return row.value === undefined || valid(row.value);
  return row.action === 'scan' && (row.values !== undefined
    ? row.values.length >= 2 && row.values.every(valid) && !row.values.every(value => value === row.values![0]) && row.start === undefined && row.end === undefined && row.steps === undefined
    : valid(row.start) && valid(row.end) && row.start !== row.end && Number.isInteger(row.steps) && row.steps! >= 2);
}

/** Model locks retain the existing private rows, independent of the input-only freeze master. */
export function captureOrcaCoordinates(structure: Structure | null, settings: OrcaSettings): ModelCoordinate[] {
  if (!structure) return [];
  const rows = settings.task === 'md' ? settings.md.constraints : settings.constraints;
  return rows.flatMap((row, index) => modelReady(row, structure) && (row.action!=='freeze'||settings.freezeEnabled!==false) ? [{ id: rowId(settings.task === 'md' ? 'md' : 'constraints', index), type: row.type,
    atomIds: [...row.atomIds], action: row.action, source: 'orca', value: row.value, start: row.start, end: row.end, values: row.values ? [...row.values] : undefined, steps: row.steps ?? row.values?.length ?? 1,...(row.objectId?{objectId:row.objectId}:{}),
    increment: row.start !== undefined && row.end !== undefined && (row.steps ?? 0) > 1 ? (row.end - row.start) / (row.steps! - 1) : null }] : []);
}

function validateIds(structure: Structure): Set<string> {
  const ids = structure.atoms.map(atom => atom.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('ORCA建模原子身份缺失或重复，不能按顺序猜测。');
  return new Set(ids as string[]);
}
function coordinateRows(coordinates: ModelCoordinate[], settings: OrcaSettings, ids: Set<string>, original: Structure): OrcaCoordinate[] {
  const previousRows = settings.task === 'md' ? settings.md.constraints : settings.constraints;
  const previous = new Map(previousRows.map((row, index) => [rowId(settings.task === 'md' ? 'md' : 'constraints', index), row]));
  const mapped = coordinates.flatMap(row => {
    if (row.atomIds.some(id => !ids.has(id))) return [];
    if (row.source === 'orca') return [{ type: row.type, action: row.action, atomIds: [...row.atomIds], value: row.value,...(row.objectId?{objectId:row.objectId}:{}),
      start: row.start, end: row.end, values: row.values ? [...row.values] : undefined,
      steps: row.action === 'scan' && !row.values ? row.steps : undefined }];
    const old = row.id ? previous.get(row.id) : undefined;
    if (old && old.type === row.type && old.action === row.action && JSON.stringify(old.atomIds) === JSON.stringify(row.atomIds)) return [{ ...clone(old), atomIds: [...row.atomIds] }];
    if (row.action === 'scan') throw new Error('新增ORCA扫描须在ORCA任务页明确起点、终点或数值列表，不能从Gaussian步长猜测。');
    return [{ type: row.type, atomIds: [...row.atomIds], action: row.action,...(row.objectId?{objectId:row.objectId}:{}) }];
  });
  const oldIds = new Set(original.atoms.map(atom => atom.id));
  // Incomplete or invalid form drafts were never model constraints. Keep them
  // invalid, rather than silently treating an Apply as deletion or correction.
  return [...mapped, ...previousRows.filter(row => (!modelReady(row, original) || settings.freezeEnabled === false && row.action === 'freeze')
    && !row.atomIds.some(id => oldIds.has(id) && !ids.has(id))
    && !mapped.some(current => current.type === row.type && current.action === row.action && JSON.stringify(current.atomIds) === JSON.stringify(row.atomIds))).map(clone)];
}

/** Until the forcefield port accepts explicit targets, do not freeze a different geometry. */
export function assertOrcaForcefieldTargets(structure: Structure, coordinates: ModelCoordinate[]): void {
  for (const row of coordinates) {
    if (row.source !== 'orca' || row.action !== 'freeze' || row.value === undefined) continue;
    const actual = builderCoordinateValue(structure, row.type, row.atomIds);
    const difference = row.type === 'D' ? Math.abs((((actual - row.value + 180) % 360 + 360) % 360) - 180) : Math.abs(actual - row.value);
    if (difference > (row.type === 'B' ? 1e-6 : 1e-4)) throw new Error(`ORCA ${row.type} 冻结目标 ${row.value} 与当前几何 ${actual.toFixed(6)} 不同；请先用几何编辑落实目标，再整理力场。建模和输入导出仍保留原目标。`);
  }
}

/** Commit only after checking the immutable baseline and genuine surviving IDs. */
export function integrateOrcaBuilderResult(original: Structure | null, result: OrcaApplyResult, previous: OrcaSettings): OrcaBuilderIntegration {
  const structure = clone(result.structure), ids = validateIds(structure), settings = clone(previous);
  if (!original && result.baseAtomIds.length) throw new Error('原ORCA结构已移除，旧草稿不能覆盖。');
  if (original && (result.baseAtomIds.length !== original.atoms.length || result.baseAtomIds.some((id, index) => id !== original.atoms[index].id)
    || result.baseRevision !== (original.revision ?? 0))) throw new Error('ORCA结构身份或修订已变化，旧草稿不能覆盖。');
  const base = original?.bonds === undefined ? { ...result.baseStructure, bonds: undefined } : result.baseStructure;
  if (original && builderMaterialSignature(original) !== builderMaterialSignature(base)) throw new Error('ORCA结构内容已变化，旧草稿不能覆盖。');
  const surviving = (list: string[]) => [...new Set(list.filter(id => ids.has(id)))];
  for (const list of [result.assignments.frozenAtomIds, ...result.assignments.layers.map(region => region.atomIds), ...result.assignments.fragments.map(region => region.atomIds)]) {
    if (list.some(id => !ids.has(id))) throw new Error('ORCA模型分区引用不存在的原子。');
  }
  const oldIds = new Set(original?.atoms.map(atom => atom.id!) ?? []);
  settings.frozenAtomIds = [...surviving(result.assignments.frozenAtomIds), ...previous.frozenAtomIds.filter(id => !oldIds.has(id) && !ids.has(id))];
  const retainedDefinition = (values: string[]) => values.filter(id => !oldIds.has(id) || ids.has(id));
  settings.constraints = settings.constraints.filter(row => retainedDefinition(row.atomIds).length === row.atomIds.length);
  settings.md.constraints = settings.md.constraints.filter(row => retainedDefinition(row.atomIds).length === row.atomIds.length);
  if (result.internalCoordinates !== undefined) {
    const mapped = coordinateRows(result.internalCoordinates, previous, ids, original ?? result.baseStructure);
    if (settings.task === 'md') settings.md.constraints = mapped; else settings.constraints = mapped;
  }
  settings.md.activeAtomIds = retainedDefinition(settings.md.activeAtomIds);
  settings.fragments = result.assignments.fragments.map(region => {
    if (!Number.isInteger(region.charge) || !Number.isInteger(region.multiplicity) || region.multiplicity! < 1) throw new Error('ORCA片段须保留明确电荷和多重度。');
    return { id: region.id, atomIds: [...region.atomIds], charge: region.charge!, multiplicity: region.multiplicity! };
  });
  const capturedFragments = new Set(captureOrcaAssignments(original, previous).fragments.map(region => region.id));
  settings.fragments.push(...previous.fragments.filter(fragment => !capturedFragments.has(fragment.id) && retainedDefinition(fragment.atomIds).length === fragment.atomIds.length).map(clone));
  const qmRegions = result.assignments.layers.filter(region => !isInputLayerDraft(region) && [QM_REGION, QM_FIXED_REGION].includes(region.id));
  // Unrelated model layers remain independent; only this bridge's region owns QM membership.
  settings.multiscale.qmAtomIds = qmRegions.length ? [...new Set([...qmRegions.flatMap(region => region.atomIds), ...previous.multiscale.qmAtomIds.filter(id => !oldIds.has(id) && !ids.has(id))])] : retainedDefinition(settings.multiscale.qmAtomIds);
  const low = result.assignments.layers.find(region => !isInputLayerDraft(region) && region.id === LOW_REGION);
  if (low?.frozen !== undefined) settings.multiscale.freezeLowLayer = low.frozen;
  const newActive = (regionIds: string[]) => result.assignments.layers.filter(region => regionIds.includes(region.id) && !region.frozen).flatMap(region => region.atomIds).filter(id => !oldIds.has(id));
  if (settings.multiscale.mode !== 'none' && settings.multiscale.activeAtomIds?.length) settings.multiscale.activeAtomIds = [...new Set([...retainedDefinition(settings.multiscale.activeAtomIds), ...newActive([QM_REGION, LOW_REGION])])];
  if (settings.task === 'md' && settings.md.activeAtomIds.length) settings.md.activeAtomIds = [...new Set([...settings.md.activeAtomIds, ...newActive(settings.multiscale.mode !== 'none' ? [QM_REGION, LOW_REGION] : [MD_ACTIVE_REGION])])];
  if (previous.multiscale.mode !== 'none' && previous.multiscale.activeAtomIds?.length && !settings.multiscale.activeAtomIds?.length
    || previous.task === 'md' && previous.md.activeAtomIds.length && !settings.md.activeAtomIds.length) throw new Error('原活动范围中的原子已全部删除；空名单表示全部可动，请先明确重新指定活动范围或选择全部，再应用结构。');
  settings.multiscale.boundaries = settings.multiscale.boundaries.filter(row => ids.has(row.qmAtomId) && ids.has(row.lowAtomId));
  settings.neb.mapping = settings.neb.mapping.filter(row => ids.has(row.reactantId));
  structure.modelLayers = result.assignments.layers.flatMap(region => region.kind ? [{ id: region.id, label: region.label ?? region.id, kind: region.kind, atomIds: [...region.atomIds], ...(region.frozen !== undefined ? { frozen: region.frozen } : {}), ...(migrateInputLayerDraft(region).draftRole!==undefined?{draftRole:migrateInputLayerDraft(region).draftRole}:{}) }] : []);
  const materialChanged = builderMaterialSignature(original) !== builderMaterialSignature(structure);
  const science = (s: OrcaSettings) => JSON.stringify([s.frozenAtomIds, s.constraints, s.md.constraints, s.md.activeAtomIds, s.multiscale.qmAtomIds, s.multiscale.activeAtomIds, s.multiscale.freezeLowLayer, s.multiscale.boundaries, s.fragments]);
  const constraintsChanged = science(previous) !== science(settings);
  if (materialChanged || constraintsChanged) {
    settings.fragmentStatesConfirmed = false;
    settings.neb.mappingConfirmed = false; settings.md.restartConfirmed = false; settings.multiscale.configurationConfirmed = false;
    settings.multiscale.boundaries = settings.multiscale.boundaries.map(row => ({ ...row, confirmed: false }));
    if (settings.multiscale.graphEvidence) settings.multiscale.graphEvidence.confirmed = false;
  }
  if (materialChanged) { structure.molfile = undefined; structure.gaussianSource = undefined; structure.gaussianSources = undefined; structure.sourceRoute = undefined; }
  return { structure, settings, materialChanged, constraintsChanged, warnings: [...result.assignmentIssues] };
}

export function invalidateOrcaRequestForModel(request: OrcaJobRequest, integrated: OrcaBuilderIntegration): OrcaJobRequest {
  const next = clone(request); next.charge = builderCommittedCharge(request.structure, integrated.structure, request.charge);
  if (!request.structure) { const initial = initialBaseElectronicState(integrated.structure); next.charge = initial.charge; next.multiplicity = initial.multiplicity; }
  next.structure = { ...clone(integrated.structure), charge: next.charge, multiplicity: next.multiplicity }; next.settings = clone(integrated.settings);
  if (integrated.materialChanged || integrated.constraintsChanged) next.settings.fragmentStatesConfirmed = false;
  if (integrated.materialChanged || integrated.constraintsChanged) next.assets = next.assets.map(asset => ({ ...asset,
    orbitalEvidence: asset.orbitalEvidence ? { ...asset.orbitalEvidence, compatibilityConfirmed: false } : undefined,
    hessianEvidence: asset.hessianEvidence ? { ...invalidateHessianPathEvidence(asset.hessianEvidence)!, minimumConfirmed: false, atomOrderConfirmed: false } : undefined,
    mmEvidence: asset.mmEvidence ? { ...asset.mmEvidence, atomOrderConfirmed: false, bondedParametersConfirmed: false } : undefined,
    restartEvidence: asset.restartEvidence ? { ...asset.restartEvidence, conditionsConfirmed: false } : undefined }));
  if ((integrated.materialChanged || integrated.constraintsChanged) && next.settings.ircStartEvidence)
    next.settings.ircStartEvidence = { confirmed: false, context: '' };
  next.electronicStateConfirmed = retainBaseElectronicStateConfirmation(request.electronicStateConfirmed, next.structure, next);
  return next;
}

export function restoreOrcaModelSettings(current: OrcaSettings, snapshot: OrcaSettings): OrcaSettings {
  return { ...current, freezeEnabled: snapshot.freezeEnabled, frozenAtomIds: clone(snapshot.frozenAtomIds), constraints: clone(snapshot.constraints), fragments: clone(snapshot.fragments), fragmentStatesConfirmed: false,
    ircStartEvidence: current.ircStartEvidence ? { confirmed: false, context: '' } : undefined,
    md: { ...current.md, constraints: clone(snapshot.md.constraints), activeAtomIds: clone(snapshot.md.activeAtomIds), restartConfirmed: false },
    multiscale: { ...current.multiscale, qmAtomIds: clone(snapshot.multiscale.qmAtomIds), freezeLowLayer: snapshot.multiscale.freezeLowLayer,
      activeAtomIds: clone(snapshot.multiscale.activeAtomIds), boundaries: clone(snapshot.multiscale.boundaries), configurationConfirmed: false,
      graphEvidence: snapshot.multiscale.graphEvidence ? { ...clone(snapshot.multiscale.graphEvidence), confirmed: false } : undefined },
    neb: { ...current.neb, mapping: clone(snapshot.neb.mapping), mappingConfirmed: false } };
}
