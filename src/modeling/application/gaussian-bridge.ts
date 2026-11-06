import type { BuilderApplyResult, BuilderAssignments } from '../../core/builder-draft';
import { captureBuilderAssignments, GAUSSIAN_ONIOM_HIGH_REGION, GAUSSIAN_ONIOM_LOW_REGION, integrateBuilderResult, type BuilderIntegrationResult } from '../../core/builder-integration';
import type { CoordinateDraft } from '../../core/coordinate-drafts';
import { resolveCoordinateDrafts } from '../../core/coordinate-drafts';
import { activeFrozenAtoms, coordinateAction, defaultTaskOptions, constraintsEnabled } from '../../core/tasks';
import type { GaussianSettings, InternalCoordinate, Structure } from '../../core/types';
import type { GaussianBoundCoordinateDefinition, ModelCoordinate, ModelCoordinateObject, SharedModelConstraints } from '../contracts';
import { assertAtomScanCompatibility, mergeModelCoordinates, modelCoordinateKey, validateGaussianBoundCoordinates } from '../constraints';
import { supportsConstraints } from '../../core/tasks';
import { isMixedBuiltin } from '../../core/mixed-basis';
import { isInputLayerDraft, isInputLayerDraftForEngine, migrateInputLayerDraft } from '../../core/input-layer-capability';
import { inheritedSharedFreezes } from './shared-freeze-inheritance';
import { restoreGaussianBasisState, type GaussianBasisState } from './gaussian-basis-transition';
import { projectCanonicalGaussianFreezes } from './canonical-freezes';
import { builderCoordinateValue } from '../../core/builder-geometry';

export type DesktopBuilderApplyResult = BuilderApplyResult & { internalCoordinates?: ModelCoordinate[]; gaussianBoundCoordinates?:GaussianBoundCoordinateDefinition[]; coordinateObjects?:ModelCoordinateObject[]; gaussianBasisState?:GaussianBasisState };
export type DesktopBuilderIntegration = BuilderIntegrationResult & { constraintsChanged: boolean };
export interface GaussianBridgeConflict { kind: 'basis' | 'fragments' | 'layers' | 'frozen'; regionId?: string; message: string }
export class GaussianBridgeConflictError extends Error {
  readonly code = 'model-gaussian-assignment-conflict';
  constructor(public readonly conflicts: GaussianBridgeConflict[]) {
    super(conflicts.map(conflict => conflict.message).join(' ')); this.name = 'GaussianBridgeConflictError';
  }
}

/** Consumer-only projection: never write this derived settings object back to private task state. */
export function applySharedGaussianConstraints(structure:Structure|null,settings:GaussianSettings,shared?:SharedModelConstraints):{settings:GaussianSettings;errors:string[]} {
  if(shared?.canonical){
    const next=projectCanonicalGaussianFreezes(structure,settings,shared),errors:string[]=[];
    if(shared.enabled===false)return {settings:next,errors};
    if(!shared.frozenAtomIds.length&&!shared.coordinates.length)return {settings:next,errors};
    if(!structure)return {settings:next,errors:['模型冻结缺少对应三维结构。']};
    if(!supportsConstraints(settings.task))errors.push('当前Gaussian任务不支持模型冻结；请选择支持约束的任务或解除对应冻结。');
    const known=new Set(structure.atoms.map(atom=>atom.id));
    if([...shared.frozenAtomIds,...shared.coordinates.flatMap(row=>row.atomIds)].some(id=>!known.has(id)))errors.push('模型冻结引用了失效原子身份。');
    for(const row of shared.coordinates)if(row.value!==undefined){
      try{const actual=builderCoordinateValue(structure,row.type,row.atomIds),delta=row.type==='D'?Math.abs(((actual-row.value+540)%360)-180):Math.abs(actual-row.value);if(delta>1e-6)errors.push(`Gaussian不能将${row.type}冻结的显式目标${row.value}转换为当前值；请在ORCA保留该目标或明确重设冻结。`);}catch(cause){errors.push(cause instanceof Error?cause.message:String(cause));}
    }
    try{assertAtomScanCompatibility(shared.frozenAtomIds,captureGaussianInputCoordinates(structure,next));}catch(cause){errors.push(cause instanceof Error?cause.message:String(cause));}
    return {settings:next,errors};
  }
  if(settings.taskOptions?.freezeEnabled===false)return {settings,errors:[]};
  shared=inheritedSharedFreezes(shared,settings.taskOptions?.inheritModelFreeze);
  if(!shared||!shared.frozenAtomIds.length&&!shared.coordinates.length)return {settings,errors:[]};
  const errors:string[]=[],next=structuredClone(settings);
  if(!structure)return {settings:next,errors:['建模共有冻结缺少对应模型。']};
  if(!supportsConstraints(settings.task))errors.push('当前Gaussian任务不支持建模共有冻结；请选支持约束的任务或明确解除共有冻结。');
  const numbers=new Map(structure.atoms.map((atom,index)=>[atom.id,index+1]));
  if([...shared.frozenAtomIds,...shared.coordinates.flatMap(row=>row.atomIds)].some(id=>!numbers.has(id)))errors.push('建模共有冻结引用已失效原子。');
  const privateRows=captureGaussianInputCoordinates(structure,settings);
  try{mergeModelCoordinates(privateRows,shared.coordinates);}catch(error){errors.push(error instanceof Error?error.message:String(error));}
  const options=next.taskOptions??defaultTaskOptions(),wasEnabled=constraintsEnabled(settings);
  // Enabling the derived common switch must not revive stored inactive task definitions.
  const drafts=options.coordinateDrafts??options.coordinates.map((row,index)=>({id:`coordinate-${index}`,type:row.type,action:coordinateAction(row,settings.task),atomText:row.atoms.join(','),stepsText:String(row.steps),incrementText:row.increment===null?'':String(row.increment),enabled:true,...(row.objectId?{objectId:row.objectId}:{})}));
  const privateKeys=new Set(privateRows.map(modelCoordinateKey));
  options.coordinateDrafts=[...drafts.map(row=>({...row,enabled:row.enabled&&(row.action==='scan'||wasEnabled)})),...shared.coordinates.filter(row=>!privateKeys.has(modelCoordinateKey(row))).map(row=>({id:row.id!,type:row.type,objectId:row.objectId,action:'freeze' as const,atomText:row.atomIds.map(id=>numbers.get(id)??0).join(','),stepsText:'1',incrementText:'',enabled:true}))];
  options.frozenAtoms=[...new Set([...(wasEnabled?activeFrozenAtoms({settings}):[]),...shared.frozenAtomIds.map(id=>numbers.get(id)??0)])];options.constraintsEnabled=true;next.taskOptions=options;
  try{assertAtomScanCompatibility(options.frozenAtoms.flatMap(number=>structure.atoms[number-1]?.id?[structure.atoms[number-1].id!]:[]),mergeModelCoordinates(privateRows,shared.coordinates));}catch(error){const message=error instanceof Error?error.message:String(error);if(!errors.includes(message))errors.push(message);}
  return {settings:next,errors};
}

/** Model memberships follow the legacy private switch, independent of the input-only master. */
export function captureDesktopAssignments(structure: Structure | null, settings: GaussianSettings): BuilderAssignments {
  const assignments = captureBuilderAssignments(structure, settings);
  if (!settings.mixedBasis?.enabled) assignments.basis = [];
  const layerDrafts = structure?.modelLayers?.filter(layer => isInputLayerDraftForEngine(layer,'gaussian')).map(migrateInputLayerDraft);
  if (layerDrafts?.length) assignments.layers = structuredClone(layerDrafts);
  assignments.layers=assignments.layers.filter(layer=>isInputLayerDraft(layer)?isInputLayerDraftForEngine(layer,'gaussian'):!['orca-qm-region','orca-qm-region-fixed','orca-low-region','orca-low-region-fixed','orca-md-active','orca-md-fixed'].includes(layer.id)).map(migrateInputLayerDraft);
  if (structure) assignments.fragments = (settings.taskOptions?.fragments ?? []).flatMap((fragment, index) => fragment.atoms.length ? [{
    id: fragment.id ?? `fragment-${index}`, label: fragment.label ?? `Fragment ${index + 1}`, charge: fragment.charge, multiplicity: fragment.multiplicity,
    atomIds: fragment.atoms.flatMap(number => structure.atoms[number - 1]?.id ? [structure.atoms[number - 1].id!] : []),
  }] : []);
  if (!supportsConstraints(settings.task) || !settings.taskOptions?.constraintsEnabled || settings.taskOptions.freezeEnabled===false) assignments.frozenAtomIds = [];
  return assignments;
}

/** Model undo restores model-bound definitions while retaining current unrelated method choices. */
export function restoreGaussianModelSettings(current: GaussianSettings, snapshot: GaussianSettings): GaussianSettings {
  const saved = snapshot.taskOptions ?? defaultTaskOptions();
  return { ...current, mixedBasis: structuredClone(snapshot.mixedBasis), oniom: structuredClone(snapshot.oniom), taskOptions: { ...(current.taskOptions ?? defaultTaskOptions()),
    constraintsEnabled: saved.constraintsEnabled, freezeEnabled: saved.freezeEnabled, coordinates: structuredClone(saved.coordinates), coordinateDrafts: structuredClone(saved.coordinateDrafts),
    frozenAtoms: [...saved.frozenAtoms], inactiveFrozenAtoms: saved.inactiveFrozenAtoms ? [...saved.inactiveFrozenAtoms] : undefined,
    fragments: structuredClone(saved.fragments), fragmentStatesConfirmed: saved.fragmentStatesConfirmed } };
}

function activeRow(settings: GaussianSettings, action: 'freeze' | 'scan'): boolean {
  return action === 'scan' ? settings.task === 'scan' : constraintsEnabled(settings);
}

/** Capture only complete, explicitly object-bound definitions, regardless of enabled/master/task state. */
export function captureGaussianBoundCoordinates(structure:Structure|null,settings:GaussianSettings,objects:readonly ModelCoordinateObject[]):GaussianBoundCoordinateDefinition[] {
  if(!structure)return [];
  const options=settings.taskOptions??defaultTaskOptions();
  const drafts=options.coordinateDrafts??options.coordinates.map((row,index)=>({id:`coordinate-${index}`,objectId:row.objectId,type:row.type,action:coordinateAction(row,settings.task),atomText:row.atoms.join(','),stepsText:String(row.steps),incrementText:row.increment===null?'':String(row.increment),enabled:true}));
  return drafts.flatMap(draft=>{
    if(!draft.objectId)return [];
    const expanded=resolveCoordinateDrafts({...settings,task:draft.action==='scan'?'scan':'opt',taskOptions:{...options,constraintsEnabled:true,freezeEnabled:true,coordinateDrafts:[{...draft,enabled:true}]}});
    const coordinate=expanded.coordinates[0];if(expanded.errors.length||!coordinate)return [];
    const atomIds=coordinate.atoms.map(number=>structure.atoms[number-1]?.id);if(atomIds.some(id=>!id))return [];
    const row:GaussianBoundCoordinateDefinition={rowId:draft.id,objectId:draft.objectId,type:draft.type,atomIds:atomIds as string[],action:draft.action,rowEnabled:draft.enabled,stepsText:draft.stepsText,incrementText:draft.action==='scan'&&!draft.incrementText.trim()?String(coordinate.increment):draft.incrementText};
    try{validateGaussianBoundCoordinates([row],objects,structure);return [row];}catch{return [];}
  });
}

/** Invalid/incomplete edited definitions keep their text but must stop claiming a successful object binding. */
export function invalidateGaussianObjectBindings(structure:Structure|null,settings:GaussianSettings,objects:readonly ModelCoordinateObject[]):GaussianSettings {
  if(!settings.taskOptions?.coordinateDrafts?.some(row=>row.objectId))return settings;
  const valid=new Set(captureGaussianBoundCoordinates(structure,settings,objects).map(row=>row.rowId));
  let changed=false;const rows=settings.taskOptions.coordinateDrafts.map(row=>{if(!row.objectId||valid.has(row.id))return row;changed=true;const {objectId:_objectId,...draft}=row;return draft;});
  return changed?{...settings,taskOptions:{...settings.taskOptions,coordinateDrafts:rows}}:settings;
}

/** Input projection uses the task master; model capture below deliberately does not. */
function captureGaussianInputCoordinates(structure: Structure | null, settings: GaussianSettings): ModelCoordinate[] {
  if (!structure) return [];
  const options = settings.taskOptions ?? defaultTaskOptions();
  const candidates = options.coordinateDrafts === undefined
    ? options.coordinates.map((coordinate, index) => ({ id: `coordinate-${index}`, coordinate }))
    : options.coordinateDrafts.flatMap(draft => resolveCoordinateDrafts({ ...settings, taskOptions: { ...options, coordinateDrafts: [draft] } }).coordinates.map(coordinate => ({ id: draft.id, coordinate })));
  return candidates.flatMap(({ id, coordinate }) => {
    const action = coordinateAction(coordinate, settings.task);
    if (!activeRow(settings, action)) return [];
    const atomIds = coordinate.atoms.map(number => structure.atoms[number - 1]?.id);
    if (atomIds.length !== { B: 2, A: 3, D: 4 }[coordinate.type] || atomIds.some(id => !id) || new Set(atomIds).size !== atomIds.length) return [];
    return [{ id, type: coordinate.type, atomIds: atomIds as string[], action, steps: coordinate.steps, increment: coordinate.increment,...(coordinate.objectId?{objectId:coordinate.objectId}:{}) }];
  });
}

/** Only complete legacy-active rows become model locks. The input master never changes model context. */
export function captureGaussianCoordinates(structure: Structure | null, settings: GaussianSettings): ModelCoordinate[] {
  return captureGaussianInputCoordinates(structure, settings);
}

function formOnlyDraft(settings: GaussianSettings, draft: CoordinateDraft): boolean {
  if (!draft.enabled || !activeRow(settings, draft.action)) return true;
  return resolveCoordinateDrafts({ ...settings, taskOptions: { ...(settings.taskOptions ?? defaultTaskOptions()), coordinateDrafts: [draft] } }).errors.length > 0;
}

function coordinateSignature(settings: GaussianSettings, structure: Structure | null): string {
  const options = settings.taskOptions ?? defaultTaskOptions();
  const identity = (number: number) => structure?.atoms[number - 1]?.id ?? `missing-${number}`;
  const resolved = resolveCoordinateDrafts(settings);
  return JSON.stringify([options.constraintsEnabled ?? false, (constraintsEnabled(settings) ? options.frozenAtoms : []).map(identity).sort(),
    resolved.coordinates.map(coordinate => ({ ...coordinate, action: coordinateAction(coordinate, settings.task), atoms: coordinate.atoms.map(identity) })), resolved.errors]);
}

/** Commit model identities through the existing stale-base checks, then map once to current centers. */
export function integrateDesktopBuilderResult(original: Structure | null, result: DesktopBuilderApplyResult, previous: GaussianSettings): DesktopBuilderIntegration {
  if (result.gaussianBasisState) previous = restoreGaussianBasisState(previous, result.gaussianBasisState);
  if (previous.oniom?.enabled) result = { ...result, assignments: { ...result.assignments,
    layers: result.assignments.layers.filter(layer => layer.atomIds.length || ![GAUSSIAN_ONIOM_HIGH_REGION, GAUSSIAN_ONIOM_LOW_REGION].includes(layer.id)) } };
  const integrated = integrateBuilderResult(original, result, previous);
  if(result.gaussianBoundCoordinates!==undefined)validateGaussianBoundCoordinates(result.gaussianBoundCoordinates,result.coordinateObjects??[],integrated.structure);
  if (result.internalCoordinates !== undefined) {
    const options = integrated.settings.taskOptions ?? defaultTaskOptions();
    const numbers = new Map(integrated.structure.atoms.map((atom, index) => [atom.id!, index + 1]));
    mergeDesktopAssignments(result.assignments, previous, integrated, numbers);
    const coordinates: InternalCoordinate[] = [], drafts: CoordinateDraft[] = [];
    const ids = new Set<string>();
    for (const [index, coordinate] of result.internalCoordinates.entries()) {
      const count = { B: 2, A: 3, D: 4 }[coordinate.type];
      if (!count || coordinate.atomIds.length !== count || new Set(coordinate.atomIds).size !== count) throw new Error('建模内坐标的类型或原子身份无效。');
      const id = coordinate.id ?? `model-coordinate-${index}`;
      if (ids.has(id)) throw new Error('建模内坐标的行身份重复。');
      ids.add(id);
      const mapped = coordinate.atomIds.map(atomId => numbers.get(atomId));
      const valid = mapped.every(number => number !== undefined);
      coordinates.push({ type: coordinate.type, atoms: mapped.map(number => number ?? 0), action: coordinate.action, steps: coordinate.steps, increment: coordinate.increment,...(coordinate.objectId?{objectId:coordinate.objectId}:{}) });
      drafts.push({ id, type: coordinate.type, action: coordinate.action, atomText: mapped.map(number => number ?? '?').join(','),
        stepsText: String(coordinate.steps), incrementText: coordinate.increment === null ? '' : String(coordinate.increment), enabled: true,...(coordinate.objectId?{objectId:coordinate.objectId}:{}) });
      if (!valid) {
        integrated.invalidatedCoordinates.push(`内坐标 ${index + 1}`);
        integrated.warnings.push(`内坐标 ${index + 1}引用的原子已删除，请重新指定或关闭该行。`);
      }
    }
    // The legacy bridge has already remapped these incomplete/disabled numeric drafts.
    const preserved = (previous.taskOptions?.coordinateDrafts ?? []).flatMap((draft, index) => {
      const remapped = options.coordinateDrafts![index];
      return !ids.has(draft.id) && (formOnlyDraft(previous, draft) || formOnlyDraft(integrated.settings, remapped))
        ? [{ ...remapped, enabled: remapped.action === 'freeze' && previous.taskOptions?.freezeEnabled !== false && !constraintsEnabled(previous) ? false : remapped.enabled }] : [];
    });
    // Numeric-only inactive rows also survive a model commit, without becoming active.
    if (previous.taskOptions?.coordinateDrafts === undefined) {
      for (const [index, coordinate] of (previous.taskOptions?.coordinates ?? []).entries()) {
        const action = coordinateAction(coordinate, previous.task);
        const mapped = options.coordinates[index];
        if (!mapped) continue;
        const complete = mapped.atoms.length === { B: 2, A: 3, D: 4 }[mapped.type]
          && mapped.atoms.every(number => number > 0 && integrated.structure.atoms[number - 1]?.id)
          && new Set(mapped.atoms).size === mapped.atoms.length;
        if (activeRow(previous, action) && complete) continue;
        if (ids.has(`coordinate-${index}`)) continue;
        preserved.push({ id: `inactive-coordinate-${index}`, type: mapped.type, action,
          atomText: mapped.atoms.map(number => number || '?').join(','), stepsText: String(mapped.steps), incrementText: mapped.increment === null ? '' : String(mapped.increment), enabled: action !== 'freeze' || previous.taskOptions?.freezeEnabled === false || constraintsEnabled(previous) });
      }
    }
    options.coordinates = coordinates;
    options.coordinateDrafts = [...drafts, ...preserved];
    if(result.gaussianBoundCoordinates!==undefined){
      const bound=new Map(result.gaussianBoundCoordinates.map(row=>[row.rowId,row]));
      // Bound metadata is authoritative after cascade deletion or Undo. Unbound form drafts stay untouched.
      options.coordinateDrafts=options.coordinateDrafts.filter(row=>!row.objectId||bound.has(row.id));
      for(const row of result.gaussianBoundCoordinates){
        const definition:CoordinateDraft={id:row.rowId,objectId:row.objectId,type:row.type,action:row.action,atomText:row.atomIds.map(id=>numbers.get(id)!).join(','),stepsText:row.stepsText,incrementText:row.incrementText,enabled:row.rowEnabled};
        const index=options.coordinateDrafts.findIndex(draft=>draft.id===row.rowId);if(index<0)options.coordinateDrafts.push(definition);else options.coordinateDrafts[index]=definition;
      }
    }
    integrated.invalidatedCoordinates = options.coordinateDrafts.flatMap((draft, index) => draft.atomText.includes('?') ? [`内坐标 ${index + 1}`] : []);
    integrated.warnings = [...integrated.warnings.filter(warning => !warning.includes('引用的原子已删除')),
      ...integrated.invalidatedCoordinates.map(label => `${label}引用的原子已删除，请重新指定或关闭该行。`)];
    const oldFrozen = new Set(captureFrozenIds(original, previous));
    const newFrozen = constraintsEnabled(previous)
      ? result.assignments.frozenAtomIds.some(id => !oldFrozen.has(id))
      : result.assignments.frozenAtomIds.length > 0;
    const inactiveIds = (previous.taskOptions?.inactiveFrozenAtoms ?? []).flatMap(number => original?.atoms[number - 1]?.id ? [original.atoms[number - 1].id!] : []);
    if (!constraintsEnabled(previous)) inactiveIds.push(...oldFrozen);
    options.inactiveFrozenAtoms = [...new Set(inactiveIds.flatMap(id => numbers.has(id) && !result.assignments.frozenAtomIds.includes(id) ? [numbers.get(id)!] : []))];
    if (result.internalCoordinates.some(coordinate => coordinate.action === 'freeze') || newFrozen) options.constraintsEnabled = true;
    integrated.settings.taskOptions = options;
  }
  if (previous.taskOptions?.freezeEnabled === false && original) {
    // A model commit while suspended must not replace retained private atom rows
    // with the empty effective input projection. Remap only surviving identities.
    const options = integrated.settings.taskOptions ?? defaultTaskOptions();
    const numbers = new Map(integrated.structure.atoms.map((atom, index) => [atom.id, index + 1]));
    const retained = previous.taskOptions.frozenAtoms.flatMap(number => {
      const id = original.atoms[number - 1]?.id, mapped = id ? numbers.get(id) : undefined;
      return mapped === undefined ? [] : [mapped];
    });
    options.frozenAtoms = [...new Set([...options.frozenAtoms, ...retained])];
    integrated.settings.taskOptions = options;
  }
  const oniomChanged = mergeOniomAssignments(result.assignments, previous, integrated);
  const constraintsChanged = oniomChanged || coordinateSignature(previous, original) !== coordinateSignature(integrated.settings, integrated.structure);
  if (constraintsChanged) {
    const options = integrated.settings.taskOptions!;
    options.irc = { ...options.irc, confirmed: false };
    options.stable = { ...options.stable, confirmed: false };
    options.fragmentStatesConfirmed = false;
  }
  return { ...integrated, constraintsChanged };
}

/** Stable model layers own membership; typing, MM charges and link data follow surviving identities. */
function mergeOniomAssignments(assignments: BuilderAssignments, previous: GaussianSettings, integrated: BuilderIntegrationResult): boolean {
  if (!previous.oniom) return false;
  const settings = integrated.settings.oniom!;
  const known = new Set(integrated.structure.atoms.map(atom => atom.id!));
  const before = JSON.stringify([previous.oniom.qmAtomIds.slice().sort(), previous.oniom.freezeLowLayer, previous.oniom.boundaries]);
  const low = assignments.layers.find(layer => !isInputLayerDraft(layer) && layer.id === GAUSSIAN_ONIOM_LOW_REGION);
  if (previous.oniom.enabled && low?.frozen !== undefined) settings.freezeLowLayer = low.frozen;
  settings.qmAtomIds = [...new Set((previous.oniom.enabled
    ? assignments.layers.some(isInputLayerDraft) ? previous.oniom.qmAtomIds : assignments.layers.filter(layer => layer.kind === 'qm').flatMap(layer => layer.atomIds)
    : previous.oniom.qmAtomIds).filter(id => known.has(id)))];
  const qm = new Set(settings.qmAtomIds);
  settings.atomTypes = Object.fromEntries(Object.entries(settings.atomTypes).filter(([id]) => known.has(id)));
  settings.partialCharges = Object.fromEntries(Object.entries(settings.partialCharges).filter(([id]) => known.has(id)));
  settings.boundaries = settings.boundaries.filter(boundary => known.has(boundary.qmAtomId) && known.has(boundary.lowAtomId)
    && qm.has(boundary.qmAtomId) && !qm.has(boundary.lowAtomId));
  const changed = before !== JSON.stringify([settings.qmAtomIds.slice().sort(), settings.freezeLowLayer, settings.boundaries]);
  if (integrated.materialChanged || changed) {
    settings.statesConfirmed = false;
    settings.topologyConfirmed = false;
    settings.boundaries = settings.boundaries.map(boundary => ({ ...boundary, confirmed: false }));
    // Source metadata certifies the old partition, even when Cartesian positions did not move.
    integrated.structure.gaussianSource = undefined;
    integrated.structure.gaussianSources = undefined;
    integrated.structure.sourceRoute = undefined;
  }
  return changed;
}

/** The model owns all real region memberships, including newly pasted region identities. */
function mergeDesktopAssignments(assignments: BuilderAssignments, previous: GaussianSettings, integrated: BuilderIntegrationResult, numbers: Map<string, number>): void {
  const conflicts: GaussianBridgeConflict[] = [];
  for (const kind of ['basis', 'fragments', 'layers'] as const) {
    const ids = new Set<string>(), owners = new Map<string, string>();
    for (const entry of assignments[kind]) {
      if (kind === 'layers' && isInputLayerDraft(entry)) continue; // editable drafts are gated at input generation, never flattened here
      if (!entry.id || ids.has(entry.id)) conflicts.push({ kind, regionId: entry.id, message: `${kind}区域身份缺失或重复。` });
      ids.add(entry.id);
      // A deleted/fully transferred basis region remains an editable empty form
      // draft. It must not block geometry projection or acquire another center.
      if (!entry.atomIds.length && kind !== 'basis') conflicts.push({ kind, regionId: entry.id, message: `${kind}区域${entry.id}没有明确原子成员。` });
      for (const id of entry.atomIds) {
        if (!numbers.has(id)) conflicts.push({ kind, regionId: entry.id, message: `${kind}区域${entry.id}引用了不存在的原子。` });
        if (owners.has(id)) conflicts.push({ kind, regionId: entry.id, message: `${kind}区域在原子${numbers.get(id) ?? id}发生重复或重叠。` });
        owners.set(id, entry.id);
      }
      if (kind === 'basis' && (!entry.basis || !isMixedBuiltin(entry.basis))) conflicts.push({ kind, regionId: entry.id, message: `基组区域${entry.id}缺少受支持的明确基组。` });
      if (kind === 'fragments' && (!Number.isInteger(entry.charge) || !Number.isInteger(entry.multiplicity) || entry.multiplicity! < 1)) conflicts.push({ kind, regionId: entry.id, message: `片段${entry.id}缺少明确的整数电荷或正整数多重度。` });
      if (kind === 'layers' && !['qm', 'middle', 'mm'].includes(entry.kind ?? '')) conflicts.push({ kind, regionId: entry.id, message: `层${entry.id}缺少明确QM/MM层类型。` });
    }
  }
  if (assignments.frozenAtomIds.some(id => !numbers.has(id))) conflicts.push({ kind: 'frozen', message: '冻结定义引用了不存在的原子。' });
  if (conflicts.length) throw new GaussianBridgeConflictError(conflicts);
  const toNumbers = (ids: string[]) => ids.map(id => numbers.get(id)!);
  const settings = integrated.settings, options = settings.taskOptions!;
  const oldRegionIds = new Set(previous.mixedBasis?.regions.map(region => region.id) ?? []);
  if (assignments.basis.length || previous.mixedBasis) settings.mixedBasis = {
    enabled: previous.mixedBasis?.enabled === true || assignments.basis.some(entry => !oldRegionIds.has(entry.id)),
    dForm: previous.mixedBasis?.dForm ?? '5D',
    regions: [...assignments.basis.map(entry => ({ id: entry.id, name: entry.label ?? entry.id, basis: entry.basis!, atoms: toNumbers(entry.atomIds) })),
      ...(previous.mixedBasis?.regions.filter(region => !region.atoms.length && !assignments.basis.some(entry => entry.id === region.id)) ?? [])],
  };
  if (assignments.fragments.length) options.fragments = assignments.fragments.map(entry => ({ id: entry.id, ...(entry.label !== undefined ? { label: entry.label } : {}), atoms: toNumbers(entry.atomIds), charge: entry.charge!, multiplicity: entry.multiplicity! }));
  else options.fragments = (previous.taskOptions?.fragments ?? defaultTaskOptions().fragments).filter(fragment => !fragment.atoms.length);
  if (!options.fragments.length) options.fragments = defaultTaskOptions().fragments;
  const science = (value: GaussianSettings) => JSON.stringify([value.mixedBasis && [value.mixedBasis.enabled, value.mixedBasis.dForm, value.mixedBasis.regions.map(region => [region.basis, region.atoms])],
    value.taskOptions?.fragments.map(fragment => [fragment.atoms, fragment.charge, fragment.multiplicity])]);
  const scientificRegionsChanged = science(previous) !== science(settings);
  if (scientificRegionsChanged) {
    options.fragmentStatesConfirmed = false; options.irc = { ...options.irc, confirmed: false }; options.stable = { ...options.stable, confirmed: false };
  }
}

function captureFrozenIds(structure: Structure | null, settings: GaussianSettings): string[] {
  return (settings.taskOptions?.frozenAtoms ?? []).flatMap(number => structure?.atoms[number - 1]?.id ? [structure.atoms[number - 1].id!] : []);
}
