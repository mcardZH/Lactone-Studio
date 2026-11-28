import type { Atom, Bond, Structure, Vector3 } from '../types';
import { electronicStateError, elementSymbol, suggestedMultiplicity } from '../elements';
import { bondEvidenceGeometryKey, clearBondEvidence } from '../bond-semantics';
import { perceivePeriodicConnections, requireConfirmedPeriodicity } from '../periodic';
import { createBuilderDraft, validateExplicitBonds, commitBuilderTransaction, executeBuilderCommand, type BuilderAssignments, type BuilderDraft } from '../builder-draft';
import { builderCoordinateValue, builderRotate, builderVector, editBuilderGeometry, transformBuilderSelection } from '../builder-geometry';
import { assertBuilder2DStereoPreserved, assertBuilderStereoPreserved, refreshBuilderStereoAfterNativeChange, updateBuilderStereo } from '../builder-stereo';
import { refreshManualStereo } from '../manual-stereo';
import type { ChemistryResult, ModelCommand, ModelStore } from '../../modeling/contracts';
import type { ClipboardPayload, DocumentStamp, NativeMDPolicy, FragmentSnapshot, ModelCoordinate, ModelDocument, ModelSelection, PasteConflict, PastePolicy, ScientificEditGuard, ScientificEditRequest, BondOrderObservation, ModelStoreProjectState, ModelStoreProjectHistoryArchive, ModelProjectHistoryEntry, ModelProjectReplayState, ModelProjectLinkedToken, ModelProjectLinkGroup } from './contracts';
import { analysisGeometryChanged, analysisSourceDraft, ScientificEditCancelledError } from './analysis-binding';
import {applyFrameBondOverride,defaultFrameBondIdentity,frameBondIdentityKey,frameBondScientificFingerprint,isFrameBondCommand,recordFrameBondOverride,replayFrameBondOverride,type FrameBondIdentity} from './frame-bond-overrides';
export { ScientificEditCancelledError } from './analysis-binding';
import { addSingleHydrogen, newModelId, prepare2DHydrogens } from './hydrogen-policy';
import { atomIndex, bondKey, bondReference, checkedInputLayerDraft, clone, coordinatesFingerprint, emptySelection, getFrozenAtomIds, getMovableAtomIds, graphFingerprint, referenceKey, removeAtoms, subsetStructure, unique } from './graph';
import { getInputLayerDraftRole, isInputLayerDraft } from '../input-layer-capability';
import type { DynamicsFrame } from '../../modeling/dynamics/contracts';
import { mdHydrogenSettings, resolveMDConstraint, supportsMDIntegrator } from '../../modeling/dynamics/md-methods';
import { getElementPreset, prepareElementPreset } from './element-presets';
import { rotateAttachmentDirection, transportAttachmentPorts, transportLocalAttachmentPorts, validateAttachmentPorts } from './attachment-ports';
import { placeBuilderFragment } from './fragment-placement';
import { prepareElement, removedSiteHydrogens } from './element-placement';
import { assertFrozenCoordinatesPreserved, cleanDocument, discardReplacedAtomDefinitions, finiteVector, MODEL_CONSTRAINT_TOLERANCE, validateCoordinates, validateExtras } from './model-document-validation';
import { createCopiedFragmentSeed,placeCopiedFragment } from './copied-fragment';
import { coordinateSelectionObjects } from './coordinate-selection';
import { associatedWithObject, effectiveModelCoordinates, effectiveModelConstraints, emptySharedConstraints, mergeModelCoordinates, modelCoordinateKey, retainSharedConstraints, validateCoordinateObject, validateSharedConstraints, validateGaussianBoundCoordinates, sharedFreezeEnabledForMerge } from '../../modeling/constraints';
import { bindImportedSourceAtomIds, sourceModelState } from '../../modeling/application/source-model-state';
import { canonicalFreezeRows, migrateCanonicalFreezes } from '../../modeling/application/canonical-freezes';
import { applyXtbCoordinates, applyXtbStoppedCoordinates } from '../../modeling/xtb/accept-result';
import { bondOrderObservation, bondOrderStructureKey } from '../../modeling/bond-orders';
import { validateOptimizationBondOrderObservation } from './bond-order-evidence';
import { supportsXtbOperation, XTB_METHOD_LABELS } from '../xtb-capabilities';
import { reindexStructureAtoms } from './graph-reindex';
import { mapStructureTransformDocument, mapStructureTransformContext } from './structure-transform-document';
import { resolveFinitePeriodicFragment } from './periodic-modeling';
import { captureCellCheckpoint, removeDocumentCell } from './cell-editor';
import { preparePeriodicAppendFragment, periodicAppendNote, periodicSelectionNote, type PeriodicAppendExtraction } from './periodic-append-fragment';
import {inheritRuntimePreviewLineage,runtimePreviewSourceCurrent} from './runtime-source-lineage';
import {electronicStateAfterModelEdit,electronicInventorySignature,reconcileElectronicStateAfterInventoryEdit} from './electronic-state-policy';
import {normalizeRestoredPeriodicProjectState,normalizePeriodicModelContentKey} from './periodic-working-structure';
import { assertPlainProjectModel, checkProjectHistoryEntry, checkProjectModelContexts, checkProjectModelDocument, modelHistorySaveBudget, prepareRestoredModelStoreHistories, selectProjectHistory } from './project-history-restore';

export { getConnectedComponent, getFrozenAtomIds, getMovableAtomIds } from './graph';
export { MODEL_CONSTRAINT_TOLERANCE } from './model-document-validation';
export { prepareRestoredModelStoreHistories } from './project-history-restore';

/** Typed conflicts leave both documents untouched; callers can present the
 * actual conflict without inventing a default metadata-discard policy. */
export class ModelConflictError extends Error {
  readonly code = 'model-paste-conflict';
  constructor(public readonly conflicts: PasteConflict[]) {
    super(conflicts.map(conflict => conflict.message).join(' '));
    this.name = 'ModelConflictError';
  }
}

const assignmentsOf = (partial: Partial<BuilderAssignments> = {}): BuilderAssignments => clone({ layers: [], basis: [], fragments: [], frozenAtomIds: [], ...partial });
const json = (value: unknown) => JSON.stringify(value);
const physicalStructure = (structure: Structure) => {
  const { revision: _revision, molfile: _molfile, preparation: _preparation, ...rest } = structure;
  return rest;
};
const contentKey = (document: ModelDocument) => json([physicalStructure(document.draft.structure), document.draft.assignments, document.auxiliaryRelations, document.deletedBonds, document.internalCoordinates ?? [], document.attachmentPorts ?? [],document.sharedConstraints??emptySharedConstraints(),document.coordinateObjects??[],document.gaussianBoundCoordinates??[],document.gaussianBasisState??null,document.electronicStateConfirmed??false,document.analysisBindingId??null]);
const dirtyContentKey = (document: ModelDocument) => json([contentKey({ ...document, analysisBindingId: undefined }), document.cellCheckpoint,
  ...(document.frameBondOverrides&&Object.keys(document.frameBondOverrides).length?[document.frameBondOverrides]:[])]);

/** The application supplies only the shared metadata projection. Checkpoints,
 * publication and linked Undo entries remain inside the model-store owner. */
export interface ModelStoreLinkPolicy {
  isAligned(): boolean;
  sharedStateKey(document: ModelDocument): string;
  mapDocument(source: ModelDocument, target: ModelDocument): ModelDocument;
  validate?(): void;
  projectState?():Pick<ModelProjectLinkGroup,'referenceDocumentId'|'confirmedOrder'>;
}
type LinkedHistoryKind = 'selection' | 'structure';
interface LinkedHistoryToken {
  kind: LinkedHistoryKind;
  group: CoreLinkedModelGroup|null;
  projectIdentity?:{id:string;groupId:string};
  projectSnapshot?:ModelProjectLinkedToken;
  validate?: () => void;
  members: { access: LinkedStoreAccess; before: (operation?: 'undo' | 'redo') => void; after: (operation?: 'undo' | 'redo') => void }[];
}
interface LinkedStoreAccess {
  store: ModelStore;
  attach(group: CoreLinkedModelGroup | null): void;
  group(): CoreLinkedModelGroup | null;
  checkpoint(): { rollback(): void; install(token: LinkedHistoryToken): void; restoreFuture(): void };
  replay(kind: LinkedHistoryKind): (operation?: 'undo' | 'redo') => void;
  replayProject(state:ModelProjectReplayState):(operation?:'undo'|'redo')=>void;
  replaceProjectToken(previous:LinkedHistoryToken,next:LinkedHistoryToken):void;
  top(direction: 'undo' | 'redo'): LinkedHistoryToken | null;
  move(token: LinkedHistoryToken, direction: 'undo' | 'redo'): void;
  discard(token: LinkedHistoryToken): void;
  batch(begin: boolean, publish?: boolean): void;
  call<T>(operation: () => T): T;
  apply(document: ModelDocument, kind: LinkedHistoryKind): void;
  assertEditable(): void;
}
const linkedStoreAccess = new WeakMap<ModelStore, LinkedStoreAccess>();
/** Only a source Store can issue this in-memory acceptance capability. It is
 * neither serialized nor reconstructed by replacing a request's document ID. */
const scientificResultTargets = new WeakMap<ModelStore, (source: ModelDocument, candidate: ModelDocument, label: string, origin: ModelStore) => ModelDocument>();
const projectReplayStates=new WeakMap<Function,ModelProjectReplayState>();
const projectPendingTokens=new WeakMap<ModelStore,Map<string,{token:LinkedHistoryToken;data:ModelProjectLinkedToken}>>();
function linkedProjectIdentity(token:LinkedHistoryToken){return token.projectIdentity??=({id:newModelId(),groupId:token.group!.id});}
function exportLinkedProjectToken(token:LinkedHistoryToken):ModelProjectLinkedToken{
  if(token.projectSnapshot)return clone(token.projectSnapshot);
  const identity=linkedProjectIdentity(token);
  return {...identity,kind:token.kind,members:token.members.map(member=>{
    const before=projectReplayStates.get(member.before),after=projectReplayStates.get(member.after);
    if(!before||!after)throw new Error('关联历史缺少可序列化的模型快照。');
    return {documentId:member.access.store.getSnapshot().id,before:clone(before),after:clone(after)};
  })};
}
export function getModelStoreProjectLinkGroups(stores:readonly ModelStore[]):ModelProjectLinkGroup[]{
  const groups=new Set(stores.map(store=>linkedStoreAccess.get(store)?.group()).filter((group):group is CoreLinkedModelGroup=>Boolean(group)));
  return [...groups].map(group=>{const metadata=group.policy.projectState?.();if(!metadata)throw new Error('当前关联类型缺少项目恢复契约。');return {id:group.id,documentIds:group.accesses.map(access=>access.store.getSnapshot().id),...clone(metadata)};});
}
/** Rebind serialized tokens only to the newly built graph, never old stores. */
export function restoreModelStoreProjectLinks(stores:readonly ModelStore[],isPresent?:(id:string,store:ModelStore)=>boolean):void{
  const byId=new Map(stores.map(store=>[store.getSnapshot().id,store]));
  const all=new Map<string,{data:ModelProjectLinkedToken;owners:{access:LinkedStoreAccess;token:LinkedHistoryToken}[]}>();
  for(const store of stores)for(const [id,pending] of projectPendingTokens.get(store)??[]){
    const previous=all.get(id);if(previous&&json(previous.data)!==json(pending.data))throw new Error('关联历史在不同文档间不一致。');
    const value=previous??{data:pending.data,owners:[]};value.owners.push({access:linkedStoreAccess.get(store)!,token:pending.token});all.set(id,value);
  }
  for(const {data,owners} of all.values()){
    const available=data.members.filter(member=>byId.has(member.documentId));
    if(data.members.length<2||new Set(data.members.map(member=>member.documentId)).size!==data.members.length||owners.length!==available.length||owners.some(owner=>!available.some(member=>member.documentId===owner.access.store.getSnapshot().id)))throw new Error('关联历史缺少成员模型。');
    const accesses=available.map(member=>linkedStoreAccess.get(byId.get(member.documentId)!)!);
    const active=accesses[0].group();
    const token:LinkedHistoryToken={kind:data.kind,group:active?.id===data.groupId?active:null,projectIdentity:{id:data.id,groupId:data.groupId},projectSnapshot:clone(data),
      validate(){if(available.length!==data.members.length)throw new Error('关联历史成员已关闭；关闭标签不能由Undo重新打开。');for(const access of accesses)if(isPresent&&!isPresent(access.store.getSnapshot().id,access.store))throw new Error('关联历史成员已关闭。');},
      members:available.map((member,index)=>({access:accesses[index],before:accesses[index].replayProject(member.before),after:accesses[index].replayProject(member.after)}))};
    for(const owner of owners)owner.access.replaceProjectToken(owner.token,token);
  }
  for(const store of stores)projectPendingTokens.delete(store);
}
const topologyKey = (structure: Structure) => graphFingerprint({ ...structure, charge: null, multiplicity: null });
const atomInventoryKey = (structure: Structure) => json(structure.atoms.map(atom => [atom.id, atom.element]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

class CoreLinkedModelGroup {
  readonly id:string;
  private disposed = false;
  private selectionBatch: { source: ModelStore; token?: LinkedHistoryToken; checkpoints?: ReturnType<LinkedStoreAccess['checkpoint']>[] } | null = null;
  readonly accesses: LinkedStoreAccess[];
  constructor(stores: readonly ModelStore[], readonly policy: ModelStoreLinkPolicy,projectId?:string) {
    this.id=projectId??newModelId();
    if (stores.length < 2 || new Set(stores).size !== stores.length) throw new Error('关联至少需要两个不同模型。');
    this.accesses = stores.map(store => {
      const access = linkedStoreAccess.get(store); if (!access) throw new Error('关联成员必须是本机唯一模型Store。');
      return access;
    });
    const attached: LinkedStoreAccess[] = [];
    try { for (const access of this.accesses) { access.attach(this); attached.push(access); } }
    catch (error) { attached.forEach(access => access.attach(null)); throw error; }
  }
  private validate() {
    if (this.disposed) throw new Error('关联会话已结束。');
    this.policy.validate?.();
    for (const access of this.accesses) access.assertEditable();
  }
  assertTopology(store: ModelStore, next: ModelDocument, previous = store.getSnapshot()) {
    if (atomInventoryKey(previous.draft.structure) !== atomInventoryKey(next.draft.structure)) throw new Error('关联模式禁止增删原子或改变稳定原子身份、元素；请先解除关联。');
  }
  preflight() { this.validate(); }
  beginSelection(source: ModelStore) {
    if (!this.policy.isAligned()) return false;
    if (this.selectionBatch?.source !== source) this.endSelection();
    this.selectionBatch ??= { source }; return true;
  }
  endSelection() {
    const batch = this.selectionBatch; this.selectionBatch = null;
    if (!batch?.token) return;
    // A complete gesture that returned to its initial atom selections has no
    // history effect. Compare replay snapshots without publishing intermediates.
    const checkpoints = this.accesses.map(access => access.checkpoint());
    const after = this.accesses.map(access => json(access.store.getSnapshot().selection));
    this.accesses.forEach(access => access.batch(true));
    try {
      batch.token.members.forEach(member => member.before());
      const unchanged = this.accesses.every((access, index) => json(access.store.getSnapshot().selection) === after[index]);
      checkpoints.forEach(checkpoint => checkpoint.rollback());
      if (unchanged) {
        this.accesses.forEach(access => access.discard(batch.token!));
        batch.checkpoints?.forEach(checkpoint => checkpoint.restoreFuture());
      }
    } finally { this.accesses.forEach(access => access.batch(false, true)); }
  }
  run(source: ModelStore, operation: () => ModelDocument, kind: LinkedHistoryKind = 'structure', force = false, recordHistory = true, allowLink = true): ModelDocument {
    const aligned = this.policy.isAligned();
    if (kind !== 'selection') this.endSelection();
    if (force || kind === 'selection' && aligned) this.validate();
    const checkpoints = this.accesses.map(access => access.checkpoint());
    const initial = this.accesses.map(access => access.store.getSnapshot());
    const before = this.accesses.map(access => access.replay(kind));
    this.accesses.forEach(access => access.batch(true));
    let success = false;
    try {
      const own = this.accesses.find(access => access.store === source)!;
      const result = own.call(operation);
      this.assertTopology(source, result, initial[this.accesses.indexOf(own)]);
      const changedShared = this.policy.sharedStateKey(initial[this.accesses.indexOf(own)]) !== this.policy.sharedStateKey(result);
      if ((allowLink && aligned && changedShared || force) && kind !== 'selection') this.validate();
      if (allowLink && aligned && changedShared || force) {
        for (const access of this.accesses) if (access !== own) access.call(() => access.apply(this.policy.mapDocument(result, access.store.getSnapshot()), kind));
        if (recordHistory && this.accesses.some((access, index) => access.store.getSnapshot() !== initial[index])) {
          const existing = kind === 'selection' && this.selectionBatch?.source === source ? this.selectionBatch.token : undefined;
          const token: LinkedHistoryToken = existing ?? { kind, group: this, validate: this.policy.validate, members: this.accesses.map((access, index) => ({ access, before: before[index], after: access.replay(kind) })) };
          token.members.forEach(member => { member.after = member.access.replay(kind); });
          checkpoints.forEach(checkpoint => checkpoint.install(token));
          if (kind === 'selection' && this.selectionBatch?.source === source && !existing) {
            this.selectionBatch.token = token; this.selectionBatch.checkpoints = checkpoints;
          }
        }
      }
      success = true; return source.getSnapshot();
    } catch (error) { checkpoints.forEach(checkpoint => checkpoint.rollback()); throw error; }
    finally { this.accesses.forEach(access => access.batch(false, success)); }
  }
  synchronize(source: ModelStore) {
    if (!this.policy.isAligned()) throw new Error('逐位元素或编号映射未确认，请先重新编号并确认对齐。');
    return this.run(source, () => { const access = this.accesses.find(member => member.store === source)!; access.apply(this.policy.mapDocument(source.getSnapshot(), source.getSnapshot()), 'structure'); return source.getSnapshot(); }, 'structure', true);
  }
  reindexMany(plans: readonly { store: ModelStore; atomIds: string[]; expectedRevision: number }[], reference?: ModelStore) {
    this.endSelection(); this.validate();
    if (plans.length !== this.accesses.length || new Set(plans.map(plan => plan.store)).size !== plans.length || plans.some(plan => !this.accesses.some(access => access.store === plan.store))) throw new Error('整组编号方案必须包含每个成员及参照模型，不能遗漏或重复。');
    if (reference && !this.accesses.some(access => access.store === reference)) throw new Error('编号参照不属于当前关联组。');
    for (const plan of plans) if (plan.store.getSnapshot().revision !== plan.expectedRevision) throw new Error('重新编号方案已过期，整组未提交；请按当前模型重新生成。');
    const checkpoints = this.accesses.map(access => access.checkpoint()), before = this.accesses.map(access => access.replay('structure'));
    const initial = this.accesses.map(access => access.store.getSnapshot());
    this.accesses.forEach(access => access.batch(true)); let success = false;
    try {
      for (const plan of plans) {
        const access = this.accesses.find(entry => entry.store === plan.store)!;
        access.call(() => plan.store.execute({ type: 'reorder-atoms', atomIds: plan.atomIds, documentId: plan.store.getSnapshot().id, expectedRevision: plan.expectedRevision }));
      }
      if (reference) {
        const own = this.accesses.find(access => access.store === reference)!;
        own.call(() => own.apply(this.policy.mapDocument(reference.getSnapshot(), reference.getSnapshot()), 'structure'));
        for (const access of this.accesses) if (access !== own) access.call(() => access.apply(this.policy.mapDocument(reference.getSnapshot(), access.store.getSnapshot()), 'structure'));
      }
      if (this.accesses.some((access, index) => access.store.getSnapshot() !== initial[index])) {
        const token: LinkedHistoryToken = { kind: 'structure', group: this, validate: this.policy.validate, members: this.accesses.map((access, index) => ({ access, before: before[index], after: access.replay('structure') })) };
        checkpoints.forEach(checkpoint => checkpoint.install(token));
      }
      success = true;
    } catch (error) { checkpoints.forEach(checkpoint => checkpoint.rollback()); throw error; }
    finally { this.accesses.forEach(access => access.batch(false, success)); }
  }
  history(token: LinkedHistoryToken, direction: 'undo' | 'redo') {
    this.endSelection(); this.validate();
    return replayLinkedHistory(token, direction);
  }
  dispose() {
    this.endSelection(); this.disposed = true;
    for (const access of this.accesses) access.attach(null);
  }
}

function replayLinkedHistory(token: LinkedHistoryToken, direction: 'undo' | 'redo'): void {
  token.validate?.();
  for (const member of token.members) {
    if (member.access.group() && member.access.group()!.id !== linkedProjectIdentity(token).groupId) throw new Error('该历史属于先前的关联组；请先解除当前关联再回放。');
    member.access.assertEditable();
    if (member.access.top(direction) !== token) throw new Error('关联成员有更晚的独立修改；请先撤销该修改，再撤销或重做关联操作。');
  }
  const checkpoints = token.members.map(member => member.access.checkpoint());
  token.members.forEach(member => member.access.batch(true));
  let success = false;
  try {
    token.members.forEach(member => { member.access.move(token, direction); member[direction === 'undo' ? 'before' : 'after'](direction); }); success = true;
  } catch (error) { checkpoints.forEach(checkpoint => checkpoint.rollback()); throw error; }
  finally { token.members.forEach(member => member.access.batch(false, success)); }
}

export function createModelStoreLinkGroup(stores: readonly ModelStore[], policy: ModelStoreLinkPolicy,projectId?:string) {
  const group = new CoreLinkedModelGroup(stores, policy,projectId);
  return { synchronize: (reference: ModelStore) => group.synchronize(reference), reindexMany: (plans: readonly { store: ModelStore; atomIds: string[]; expectedRevision: number }[], reference?: ModelStore) => group.reindexMany(plans, reference), dispose: () => group.dispose() };
}


function sourceAssignments(structure: Structure, partial: Partial<BuilderAssignments>): BuilderAssignments {
  const assignments = assignmentsOf(partial);
  // Authored/restored model layers are stable-ID model state. Raw source level,
  // layers and fragments remain evidence until an explicit task adoption.
  if (partial.layers === undefined) assignments.layers = structure.modelLayers?.map(layer => clone(layer)) ?? [];
  // Source freezes belong to the shared model, independent of the active task.
  // The sourceModelState projection below owns them; do not duplicate private locks.
  assignments.layers=assignments.layers.map(checkedInputLayerDraft);
  if(structure.modelLayers)structure.modelLayers=structure.modelLayers.map(checkedInputLayerDraft);
  return assignments;
}

/** Shared pure stamp factory for formats/chemistry; the store additionally
 * registers dispatched requests so arbitrary external results cannot commit. */
export function makeDocumentStamp(document: ModelDocument, movableAtomIds = getMovableAtomIds(document, 'all')): DocumentStamp {
  const valid = new Set(document.draft.structure.atoms.map(atom => atom.id!));
  if (unique(movableAtomIds).length !== movableAtomIds.length || movableAtomIds.some(id => !valid.has(id))) throw new Error('可动原子身份无效或重复。');
  const frozen = new Set(getFrozenAtomIds(document));
  if (movableAtomIds.some(id => frozen.has(id))) throw new Error('明确冻结原子不能作为可动变量。');
  return { documentId: document.id, revision: document.revision,
    graphFingerprint: graphFingerprint(document.draft.structure), coordinatesFingerprint: coordinatesFingerprint(document.draft.structure),
    constraintsFingerprint: json([document.draft.assignments, effectiveModelCoordinates(document),document.sharedConstraints??emptySharedConstraints(), [...movableAtomIds].sort()]),
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

// Consecutive selection publications share their latest scientific snapshot.
// A batched selection following a real edit must still republish workspace metadata.
const selectionLineage = new WeakMap<ModelDocument, ModelDocument>();
export function isSelectionOnlyModelChange(before: ModelDocument, after: ModelDocument): boolean {
  return before !== after && (selectionLineage.get(before) ?? before) === selectionLineage.get(after);
}

function makeNativeMDStamp(document: ModelDocument, policy: NativeMDPolicy): DocumentStamp {
  const structure=document.draft.structure,periodic=Boolean(structure.cell);
  if (!policy || policy.kind !== 'native-gfn-md' || !supportsXtbOperation(policy.method,'md',periodic) || Boolean(policy.periodic)!==periodic || policy.dtFs !== 2
    || !Number.isFinite(policy.forceConstantKJMolNm2) || policy.forceConstantKJMolNm2 <= 0 || !Array.isArray(policy.protectedAtomIds)) throw new Error('GFN MD专用策略无效。');
  if(structure.periodicSource?.completeness==='partial')throw new Error('原生MD需要完整周期晶胞。');
  if(periodic)requireConfirmedPeriodicity(structure);
  const frozen = periodic?[]:getFrozenAtomIds(document), constraints=periodic?[]:effectiveModelCoordinates(document);
  if (unique(policy.protectedAtomIds).length !== policy.protectedAtomIds.length || policy.protectedAtomIds.length === 1
    || json([...policy.protectedAtomIds].sort()) !== json([...frozen].sort())) throw new Error('GFN MD保护原子必须恰为当前冻结集合，且为0个或至少2个。');
  if(constraints.some(row=>row.action!=='freeze'||row.images?.some(image=>image.some(Boolean)))||policy.internalConstraintMode!==(constraints.length?'native-harmonic':undefined))throw new Error('原生MD内坐标保护与当前定义或周期策略不符。');
  const explicitHydrogen = policy.hydrogenMassAmu !== undefined || policy.shakeHydrogenBonds !== undefined;
  const hydrogen=explicitHydrogen?mdHydrogenSettings(policy.method,policy.shakeHydrogenBonds):undefined;
  if(hydrogen&&(policy.hydrogenMassAmu!==hydrogen.hydrogenMassAmu||policy.shakeHydrogenBonds!==hydrogen.shakeHydrogenBonds))throw new Error('原生MD氢质量与键长约束设置不一致。');
  const normalized: NativeMDPolicy = { kind:'native-gfn-md', method:policy.method, dtFs:2, protectedAtomIds:frozen, forceConstantKJMolNm2:policy.forceConstantKJMolNm2,
    ...hydrogen,...(periodic?{periodic:true as const}:{}),...(constraints.length?{internalConstraintMode:'native-harmonic' as const}:{}) };
  const base = makeDocumentStamp(document);
  return { ...base, constraintsFingerprint:json([base.constraintsFingerprint, normalized]), nativeMDPolicy:normalized };
}

function validateNativeMDFrame(frame: DynamicsFrame, policy: NativeMDPolicy): void {
  const metadata = frame.nativeMD;
  if (frame.operation !== 'md' || frame.aseMD || !metadata || metadata.method !== policy.method || metadata.dtFs !== policy.dtFs
    || metadata.thermostat !== 'Berendsen' || metadata.hydrogenMassAmu !== (policy.hydrogenMassAmu ?? (policy.method === 'gfnff' ? 4 : null))
    || metadata.shakeHydrogenBonds !== (policy.shakeHydrogenBonds ?? (policy.method !== 'gfnff')) || !Array.isArray(metadata.protectedAtomIds)
    || unique(metadata.protectedAtomIds).length !== metadata.protectedAtomIds.length
    || json([...metadata.protectedAtomIds].sort()) !== json([...policy.protectedAtomIds].sort())
    || metadata.protection !== (policy.protectedAtomIds.length ? 'pairwise-distance' : 'none')
    || metadata.forceConstantKJMolNm2 !== policy.forceConstantKJMolNm2 || Boolean(metadata.periodic)!==Boolean(policy.periodic)
    || (frame.step>0&&Boolean(metadata.internalConstraints?.length)!==(policy.internalConstraintMode==='native-harmonic'))
    || !Number.isSafeInteger(metadata.segment) || metadata.segment < 0
    || metadata.velocityInitialization !== (metadata.segment === 0 ? 'fresh' : 'restart') || typeof metadata.nativeClosed !== 'boolean'
    || (frame.event === 'stopped' && !metadata.nativeClosed) || frame.forcefield !== undefined) throw new Error('GFN MD帧方法、保护或原生运行证据与专用许可不符。');
  const p=metadata.rawPotential,protectedRun=policy.protectedAtomIds.length>0||policy.internalConstraintMode==='native-harmonic';
  if(p && (!Number.isFinite(p.value) || p.unit!=='hartree' || p.definition!==(protectedRun?'native-total-including-protection':'native-physical-potential')
    || p.includesProtection!==protectedRun || p.sourceArtifact!=='xtb.trj' || !Number.isSafeInteger(p.sourceStep) || p.sourceStep<0 || p.sourceStep>frame.step
    || p.sourceTimeFs!==p.sourceStep*policy.dtFs || !Number.isSafeInteger(p.segment) || p.segment<0 || p.segment>metadata.segment))throw new Error('GFN MD原始势能来源与专用许可或实际帧不符。');
}

function runtimeMDProvenance(frame:DynamicsFrame):import('../types').MDPreparationProvenance | undefined {
  if(frame.operation!=='md')return;
  const base={schema:1 as const,documentId:frame.stamp.documentId,sourceRevision:frame.stamp.revision,frameSeq:frame.seq,step:frame.step,timeFs:frame.timeFs};
  const version=(value:string|undefined)=>value?.trim()||undefined;
  if(frame.nativeMD && (frame.step>0 || frame.nativeMD.rawPotential)){
    const {dtFs,thermostat,hydrogenMassAmu,shakeHydrogenBonds,protection,protectedAtomIds,forceConstantKJMolNm2,segment,velocityInitialization,rawPotential,
      periodic,internalConstraints,solvation,seedTreatment,effectiveSeed,engineIdentity,degreesOfFreedom,restartInputSha256}=frame.nativeMD;
    return {...base,driver:'native-xtb-md',method:frame.nativeMD.method,software:[{name:'xTB',version:version(frame.engineVersion)}],
      native:{dtFs,thermostat,hydrogenMassAmu,shakeHydrogenBonds,protection,protectedAtomIds:[...protectedAtomIds],forceConstantKJMolNm2,segment,velocityInitialization,
        ...(rawPotential?{rawPotential:clone(rawPotential)}:{}),...(periodic?{periodic}:{}),...(internalConstraints?.length?{internalConstraints:clone(internalConstraints)}:{}),
        ...(solvation?{solvation:clone(solvation)}:{}),...(seedTreatment?{seedTreatment}:{}),...(effectiveSeed===undefined?{}:{effectiveSeed}),
        ...(engineIdentity?{engineIdentity:clone(engineIdentity)}:{}),...(degreesOfFreedom===undefined?{}:{degreesOfFreedom}),...(restartInputSha256?{restartInputSha256}:{})}};
  }
  if (frame.aseMD && Number.isFinite(frame.energyEV)) {
    const {nativeClosed: _nativeClosed,...ase}=frame.aseMD;
    const providerVersion=ase.calculatorEvidence?.version;
    const software=[{name:'ASE',version:version(ase.aseVersion)},{name:ase.backend==='tblite'?'tblite':'xTB',
      version:typeof providerVersion==='string'?version(providerVersion):undefined}];
    return {...base,driver:'ase-bussi',method:ase.method,software,ase:clone(ase)};
  }
  if(frame.engine==='RDKit+ASE' && frame.step>0 && Number.isFinite(frame.energyEV) && frame.forcefield){
    return {...base,driver:'ase-rdkit',method:frame.forcefield,software:[{name:'RDKit',version:version(frame.engineVersion)},{name:'ASE',version:version(frame.aseVersion)}]};
  }
}


function portPreparationStatus(status: string, ports: number, warnings: readonly string[], sourceWarnings: readonly string[] = []): string {
  if (!ports) return status;
  const summary = warnings.slice(0, 3).join('；') + (warnings.length > 3 ? `；另有 ${warnings.length - 3} 个宿主方向提示` : '');
  const sourceSummary = sourceWarnings.slice(0, 3).map(warning => warning.length > 240 ? `${warning.slice(0, 240)}…` : warning).join('；') + (sourceWarnings.length > 3 ? `；另有 ${sourceWarnings.length - 3} 条内核提示` : '');
  return `${status}${sourceSummary ? ` · 内核提示：${sourceSummary}` : ''} · 端口提示：局部构建约定${summary ? `；${summary}` : ''}`;
}

function clippedAssignments(assignments: BuilderAssignments, ids: Set<string>): BuilderAssignments {
  // Retain physical layer metadata; do not flatten derived freezes into user atom freezes.
  const clip = (entries: BuilderAssignments['layers'], preserveLayerDrafts=false) => entries.map(entry => ({ ...(preserveLayerDrafts?checkedInputLayerDraft(entry):clone(entry)), atomIds: entry.atomIds.filter(id => ids.has(id)) })).filter(entry => entry.atomIds.length || preserveLayerDrafts && isInputLayerDraft(entry));
  return { layers: clip(assignments.layers,true), basis: clip(assignments.basis), fragments: clip(assignments.fragments), frozenAtomIds: assignments.frozenAtomIds.filter(id => ids.has(id)) };
}



/** The store is one independent model/window. Every physical edit, including
 * its auxiliary objects and deletion intent, is one atomic undo step. */
export function createModelStore(initial: Structure | null = null, assignments: Partial<BuilderAssignments> = {}, initialCoordinates?: ModelCoordinate[], extras?:Pick<FragmentSnapshot,'auxiliaryRelations'|'deletedBonds'|'attachmentPorts'|'sharedConstraints'|'coordinateObjects'|'gaussianBoundCoordinates'|'cellCheckpoint'>, analysisBindingId?: string, runtimeSource?: ModelDocument): ModelStore {
  if (analysisBindingId !== undefined && !initial) throw new Error('后处理绑定需要已解析结构。');
  const restoredState = initialCoordinates !== undefined || extras?.sharedConstraints !== undefined || extras?.coordinateObjects !== undefined || extras?.gaussianBoundCoordinates !== undefined;
  const first = analysisBindingId !== undefined && initial ? analysisSourceDraft(initial, analysisBindingId) : createBuilderDraft(initial, assignmentsOf(assignments));
  if (!restoredState && analysisBindingId === undefined) {
    // The builder supplies missing raw atom IDs before the one-time binding.
    first.structure = bindImportedSourceAtomIds(first.structure);
    first.baseStructure.sourceAtomIds = clone(first.structure.sourceAtomIds);
  }
  first.structure.dimension ??= 3;
  first.baseStructure.dimension ??= 3;
  first.assignments = sourceAssignments(first.structure, assignments);
  first.baseAssignments = clone(first.assignments);
  // Explicit job arrays retain their existing override semantics. Direct file
  // restoration projects source freezes separately from task definitions.
  // Restored snapshots already own stable-ID state. Their retained raw source
  // centers describe the original import, possibly before deletion/reordering.
  const sourceState = restoredState ? { internalCoordinates: [], sharedConstraints: emptySharedConstraints(), coordinateObjects: [] } : sourceModelState(first.structure);
  const coordinates = initialCoordinates === undefined ? sourceState.internalCoordinates : clone(initialCoordinates);
  const shared = extras?.sharedConstraints ?? { frozenAtomIds: assignments.frozenAtomIds === undefined ? sourceState.sharedConstraints.frozenAtomIds : [], coordinates: initialCoordinates === undefined ? sourceState.sharedConstraints.coordinates : [] };
  const objects = extras?.coordinateObjects ?? (initialCoordinates === undefined ? sourceState.coordinateObjects : []);
  // Reject malformed retained identities before migration replaces row IDs.
  validateSharedConstraints(shared, objects, first.structure);
  let current: ModelDocument = { id: newModelId(), revision: first.revision, draft: first, selection: emptySelection(), auxiliaryRelations: clone(extras?.auxiliaryRelations??[]), deletedBonds: clone(extras?.deletedBonds??[]),attachmentPorts:clone(extras?.attachmentPorts??[]),internalCoordinates: coordinates,...(shared.frozenAtomIds.length||shared.coordinates.length||extras?.sharedConstraints?{sharedConstraints:clone(shared)}:{}),...(objects.length||extras?.coordinateObjects?{coordinateObjects:clone(objects)}:{}), canUndo: false, canRedo: false };
  if (analysisBindingId !== undefined) current.analysisBindingId = analysisBindingId;
  if (runtimeSource) { current = clone(runtimeSource); current.canUndo = false; current.canRedo = false; }
  let analysisSourceInitialized = analysisBindingId !== undefined;
  let scientificEditGuard: ScientificEditGuard | null = null;
  let scientificEditApproval: { documentId:string; bindingId:string; revision:number } | null = null;
  let rejectedRequest: Readonly<ScientificEditRequest> | null = null;
  let pendingEdit: { request: Readonly<ScientificEditRequest>; base: Structure; replay(target: ModelStore, validateCopy?: (document: ModelDocument) => void): unknown } | null = null;
  let scientificEditBase: Structure | null = null;
  let scientificEditBaseSelection: ModelSelection | null = null;
  let scientificEditFrame: {identity:FrameBondIdentity;document:ModelDocument}|null = null;
  let acceptingScientificResult = false;
  migrateCanonicalFreezes(current);
  validateExtras(current);
  if(extras?.gaussianBoundCoordinates){current.gaussianBoundCoordinates=clone(extras.gaussianBoundCoordinates);validateExtras(current);}
  if(extras?.cellCheckpoint){current.cellCheckpoint=clone(extras.cellCheckpoint);validateExtras(current);}
  type Context = { assignments: BuilderAssignments; coordinates: ModelCoordinate[] };
  type StructureHistoryEntry = { kind: 'structure'; document: ModelDocument; contexts: Record<string, Context> };
  type SelectionHistoryEntry = { kind: 'selection'; selection: ModelSelection };
  type LinkedHistoryEntry = { kind: 'linked'; token: LinkedHistoryToken };
  type HistoryEntry = StructureHistoryEntry | SelectionHistoryEntry | LinkedHistoryEntry;
  let contexts: Record<string, Context> = {};
  let contextScope:'gaussian'|'orca' = 'gaussian';
  let past: HistoryEntry[] = [], future: HistoryEntry[] = [];
  let projectHistoryLimited = current.projectHistoryLimited;
  let projectHistoryArchive: ModelStoreProjectHistoryArchive[] = [];
  let historyBaseline=Symbol('model-history');
  const historyEdges=new WeakMap<HistoryEntry,{before:symbol;after:symbol}>();
  const historyCursor=()=>{const top=past.at(-1);return top?historyEdges.get(top)?.after??historyBaseline:historyBaseline;};
  function trackHistory<T extends HistoryEntry>(entry:T,edge?:{before:symbol;after:symbol}):T{historyEdges.set(entry,edge??{before:historyCursor(),after:Symbol('model-history')});return entry;}
  const selectionSnapshot=(selection:ModelSelection)=>trackHistory<SelectionHistoryEntry>({kind:'selection',selection:clone(selection)});
  let linkedGroup: CoreLinkedModelGroup | null = null, linkedBypass = 0, publicationDepth = 0, publicationPending = false;
  let selectionTransaction: { initial: ModelSelection; previousFuture: HistoryEntry[]; entry?: SelectionHistoryEntry } | null = null;
  const sameSelection = (left: ModelSelection, right: ModelSelection) => {
    const key = (selection: ModelSelection) => json([[...selection.atomIds].sort(), selection.bonds.map(referenceKey).sort(), [...selection.auxiliaryIds].sort(), [...(selection.portIds??[])].sort(), [...(selection.coordinateIds??[])].sort()]);
    return key(left) === key(right);
  };
  function finishSelectionTransaction(publish = false): void {
    const own = selectionTransaction; selectionTransaction = null;
    if (!own) return;
    const unchanged = own.entry && sameSelection(current.selection, own.initial);
    if (unchanged && own.entry) {
      const index = past.indexOf(own.entry); if (index >= 0) past.splice(index, 1);
      future = own.previousFuture;
    }
    if (publish || unchanged) publishSelection(current.selection);
  }
  let transaction: StructureHistoryEntry | null = null;
  let transactionChanged = false;
  let xtbRebuild: { command: Extract<ModelCommand,{type:'infer-bonds'}>; owner: ModelDocument; transaction: StructureHistoryEntry } | undefined;
  let acceptingRuntime = false;
  let runtimeEditLock = false;
  let runtimeActive = false;
  let runtimeIsolated = false;
  // This cache is deliberately not restored from an Undo document snapshot.
  let activeBondOrders: BondOrderObservation | undefined;
  let runtime: { sessionId:string; stamp:DocumentStamp; nativeMDPolicy?:NativeMDPolicy; aseMethod?:NonNullable<DynamicsFrame['aseMD']>['method']; operation:DynamicsFrame['operation']; seq:number; step:number; timeFs:number; revision:number; movable:string[]; original:Structure; coordinates:ModelCoordinate[] } | null = null;
  function snapshot(): StructureHistoryEntry {
    // Only the selection fields on the draft shell can change before recording.
    const document = { ...current, draft: { ...current.draft } };
    return trackHistory({ kind: 'structure', document, contexts: clone({ ...contexts, [contextScope]: { assignments: current.draft.assignments, coordinates: current.internalCoordinates ?? [] } }) });
  }
  function restore(entry: StructureHistoryEntry, applyContexts = true): ModelDocument {
    const next = clone(entry.document), fallback = contexts[contextScope], restoredContexts = clone(entry.contexts);
    next.frameBondOverrides=clone(current.frameBondOverrides);
    next.cellCheckpoint = clone(current.cellCheckpoint);
    if (applyContexts) contexts = restoredContexts;
    const context = restoredContexts[contextScope] ?? fallback;
    if (context) {
      const ids = new Set(next.draft.structure.atoms.map(atom => atom.id));
      const region = (entries: BuilderAssignments['layers']) => entries.map(value => ({ ...clone(value), atomIds:value.atomIds.filter(id=>ids.has(id)) }));
      next.draft.assignments={layers:region(context.assignments.layers),basis:region(context.assignments.basis),fragments:region(context.assignments.fragments),frozenAtomIds:context.assignments.frozenAtomIds.filter(id=>ids.has(id))};
      next.internalCoordinates=clone(context.coordinates.filter(row=>row.atomIds.every(id=>ids.has(id))));
    }
    return next;
  }
  function recordStructureHistory(): void {
    if (!transaction) { past.push(snapshot()); future = []; return; }
    if (!transactionChanged) {
      // Selections before the first physical edit precede this transaction;
      // later selections stay independent of its one structural Undo step.
      transaction.document.selection = clone(current.selection);
      transaction.document.draft.selectedIds = [...current.selection.atomIds];
      past.push(transaction);
      future = [];
    }
    transactionChanged = true;
  }
  function restoreSelection(entry: SelectionHistoryEntry): ModelDocument { return publishSelection(normalizeSelection(entry.selection)); }
  /** Remove object identities and all their bound definitions together. Never
   * interpret a coordinate's atom tuple as atoms to delete or freeze. */
  function removeCoordinateObjects(next:ModelDocument,objects:ReturnType<typeof coordinateSelectionObjects>) {
    const ids=new Set(objects.map(object=>object.id)),matches=(row:Parameters<typeof associatedWithObject>[0])=>objects.some(object=>associatedWithObject(row,object));
    if(next.coordinateObjects)next.coordinateObjects=next.coordinateObjects.filter(object=>!ids.has(object.id));
    if(next.gaussianBoundCoordinates)next.gaussianBoundCoordinates=next.gaussianBoundCoordinates.filter(row=>!ids.has(row.objectId)&&!objects.some(object=>modelCoordinateKey(row)===modelCoordinateKey(object)));
    if(next.sharedConstraints)next.sharedConstraints.coordinates=next.sharedConstraints.coordinates.filter(row=>!matches(row));
    next.internalCoordinates=(next.internalCoordinates??[]).filter(row=>!matches(row));
    const changed=clone(contexts);for(const context of Object.values(changed))context.coordinates=context.coordinates.filter(row=>!matches(row));
    return changed;
  }
  function retireReplacement(next: ModelDocument, replaced: ReadonlySet<string>, renewingIds = false): Record<string, Context> {
    const removedObjects = discardReplacedAtomDefinitions(next, next.draft.assignments, replaced, renewingIds);
    next.selection.atomIds = next.selection.atomIds.filter(id => !replaced.has(id));
    next.selection.bonds = next.selection.bonds.filter(row => row.atomIds.every(id => !replaced.has(id)));
    next.selection.auxiliaryIds = next.selection.auxiliaryIds.filter(id =>
      !next.auxiliaryRelations.some(row => row.id === id && (replaced.has(row.a) || replaced.has(row.b))));
    if (next.selection.portIds) next.selection.portIds = next.selection.portIds.filter(id =>
      !next.attachmentPorts?.some(port => port.id === id && replaced.has(port.hostAtomId)));
    if (next.selection.coordinateIds) next.selection.coordinateIds = next.selection.coordinateIds.filter(id => !removedObjects.has(id));
    const changed = clone(contexts);
    for (const context of Object.values(changed)) {
      context.assignments.frozenAtomIds = context.assignments.frozenAtomIds.filter(id => !replaced.has(id));
      context.coordinates = context.coordinates.filter(row =>
        (row.action !== 'freeze' || row.atomIds.every(id => !replaced.has(id))) && (!row.objectId || !removedObjects.has(row.objectId)));
    }
    return changed;
  }
  // Placement candidates use the old site as a temporary graph anchor. Only
  // the committed object gets a new ID. Incoming definitions have already been
  // merged after retirement of the target definitions, so these are safe to map.
  function renewPlacedAtomId(next: ModelDocument, target: string) {
    const structure = next.draft.structure, replacement = newModelId();
    const remap = (id: string) => id === target ? replacement : id;
    const remapRows = (rows?: { atomIds: string[] }[]) => {
      for (const row of rows ?? []) row.atomIds = row.atomIds.map(remap);
    };
    structure.atoms[atomIndex(structure, target)].id = replacement;
    if (structure.layout2D?.[target]) {
      structure.layout2D[replacement] = structure.layout2D[target];
      delete structure.layout2D[target];
    }
    // The builder uses group membership of the old anchor when it inherits
    // memberships for additional atoms, then drops the absent ID.
    for (const group of structure.groups ?? []) if (group.atomIds.includes(target)) group.atomIds.push(replacement);
    remapRows(structure.modelLayers);
    remapRows(structure.bondPerceptionIssues);
    const assignments = next.draft.assignments;
    for (const rows of [assignments.layers, assignments.basis, assignments.fragments]) remapRows(rows);
    assignments.frozenAtomIds = assignments.frozenAtomIds.map(remap);
    if (next.sharedConstraints) {
      next.sharedConstraints.frozenAtomIds = next.sharedConstraints.frozenAtomIds.map(remap);
      remapRows(next.sharedConstraints.coordinates);
    }
    remapRows(next.internalCoordinates);
    remapRows(next.coordinateObjects);
    remapRows(next.gaussianBoundCoordinates);
    remapRows(next.deletedBonds);
    for (const row of next.auxiliaryRelations) { row.a = remap(row.a); row.b = remap(row.b); }
    for (const port of next.attachmentPorts ?? []) port.hostAtomId = remap(port.hostAtomId);
    return replacement;
  }
  let baseline = { structure: clone(first.structure), assignments: clone(first.assignments), content: dirtyContentKey(current) };
  const listeners = new Set<() => void>();
  const stamps = new Map<string, { movable:string[]; nativeMDPolicy?:NativeMDPolicy }>();
  const sourceStamps=new WeakMap<ModelDocument,Map<string,{movable:string[];nativeMDPolicy?:NativeMDPolicy}>>();
  let selectionAtoms: Structure['atoms'] | undefined, selectionBonds: Structure['bonds'] | undefined;
  let selectableAtomIds = new Set<string>(), selectableBondKeys = new Set<string>();
  function normalizeSelection(selection: ModelSelection): ModelSelection {
    const structure = current.draft.structure;
    if (selectionAtoms !== structure.atoms) {
      selectionAtoms = structure.atoms;
      selectableAtomIds = new Set(structure.atoms.map(atom => atom.id!));
      selectionBonds = undefined;
      selectableBondKeys = new Set();
    }
    if (selection.bonds.length && selectionBonds !== structure.bonds) {
      selectionBonds = structure.bonds;
      selectableBondKeys = new Set((structure.bonds ?? []).map(bond => referenceKey(bondReference(structure, bond))));
    }
    const next = clone(selection), seen = new Set<string>();
    next.atomIds = unique(next.atomIds).filter(id => selectableAtomIds.has(id));
    next.bonds = next.bonds.filter(reference => {
      const key = referenceKey(reference);
      if (!selectableBondKeys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const auxiliary = next.auxiliaryIds.length ? new Set(current.auxiliaryRelations.map(relation => relation.id)) : null;
    next.auxiliaryIds = auxiliary ? unique(next.auxiliaryIds).filter(id => auxiliary.has(id)) : [];
    const ports = next.portIds?.length ? new Set(current.attachmentPorts?.map(port => port.id)) : null;
    next.portIds = ports ? unique(next.portIds ?? []).filter(id => ports.has(id)) : [];
    if (next.coordinateIds !== undefined) {
      if (!Array.isArray(next.coordinateIds) || next.coordinateIds.some(id => typeof id !== 'string')) throw new Error('内坐标选区必须是稳定对象ID数组。');
      if (next.coordinateIds.length) {
        const coordinates = new Set(coordinateSelectionObjects(current).map(object => object.id));
        next.coordinateIds = unique(next.coordinateIds).filter(id => coordinates.has(id));
      }
    }
    return next;
  }
  function publish(next: ModelDocument): ModelDocument {
    current = freeze(next);
    if (publicationDepth) publicationPending = true;
    else for (const listener of [...listeners]) listener();
    return current;
  }
  function publishSelection(selection: ModelSelection): ModelDocument {
    const next = { ...current, selection, draft: { ...current.draft, selectedIds: [...selection.atomIds] },
      canUndo: past.length > 0 || transactionChanged, canRedo: future.length > 0 };
    inheritRuntimePreviewLineage(current, next);
    selectionLineage.set(next, selectionLineage.get(current) ?? current);
    return publish(next);
  }
  function rememberSourceStamp(result:DocumentStamp,entry:{movable:string[];nativeMDPolicy?:NativeMDPolicy}){
    let issued=sourceStamps.get(current);if(!issued){issued=new Map();sourceStamps.set(current,issued);}issued.set(json(result),clone(entry));
    if(issued.size>64)issued.delete(issued.keys().next().value!);
  }
  function requireRuntimeSourceStamp(source:ModelDocument,submitted:DocumentStamp){
    const issued=sourceStamps.get(source)?.get(json(submitted));
    if(!issued||!runtimePreviewSourceCurrent(source,current))throw new Error('旧运行来源、冻结编辑链或已签发范围无效，结果未应用。');
    return issued;
  }
  function emit(next: ModelDocument, replacementBondOrders?: { observation?: BondOrderObservation }): ModelDocument {
    if(next.id===current.id&&next.revision===current.revision)inheritRuntimePreviewLineage(current,next);
    if (replacementBondOrders) activeBondOrders = replacementBondOrders.observation;
    else if (activeBondOrders && bondOrderStructureKey(next.draft.structure) !== bondOrderStructureKey(current.draft.structure)) activeBondOrders = undefined;
    if (activeBondOrders) next.bondOrderObservation = activeBondOrders;
    else delete next.bondOrderObservation;
    next.draft.baseStructure = freeze(baseline.structure); next.draft.baseAssignments = freeze(baseline.assignments);
    next.draft.baseAtomIds = baseline.structure.atoms.map(atom => atom.id!);
    // A committed atom is now an inheritance anchor in its own right. Old
    // lineage through a deleted H must not bypass its new baseline membership.
    for (const id of next.draft.baseAtomIds) delete next.draft.createdFrom[id];
    next.draft.past = []; next.draft.future = [];
    next.draft.dirty = dirtyContentKey(next) !== baseline.content;
    next.canUndo = past.length > 0 || transactionChanged; next.canRedo = future.length > 0;
    if (projectHistoryLimited) next.projectHistoryLimited = projectHistoryLimited;
    else delete next.projectHistoryLimited;
    cleanDocument(next);
    // Consume only at successful publication, including a commit held inside
    // an atomic batch. Metadata revisions also invalidate unused approval.
    if (scientificEditApproval && (next.id !== scientificEditApproval.documentId || next.revision !== scientificEditApproval.revision || next.analysisBindingId !== scientificEditApproval.bindingId)) scientificEditApproval = null;
    return publish(next);
  }
  function authorizeScientificChange(next: ModelDocument, operation: ScientificEditRequest['operation'] = 'edit') {
    const bindingId = current.analysisBindingId;
    if (!bindingId || (!analysisGeometryChanged(current.draft.structure, next.draft.structure)
      && (operation === 'edit' || next.analysisBindingId === bindingId))) return;
    const before = current;
    const approved = operation === 'edit' && scientificEditApproval?.documentId === current.id
      && scientificEditApproval.bindingId === bindingId && scientificEditApproval.revision === current.revision;
    const request = Object.freeze({ documentId: current.id, revision: current.revision, bindingId, operation,
      ...(acceptingScientificResult ? { resultSource: true as const } : {}) });
    if (!approved && !scientificEditGuard?.(request)) { rejectedRequest = request; scientificEditApproval = null; throw new ScientificEditCancelledError(); }
    if (current !== before) throw new Error('确认期间模型已变化，请重新操作。');
    // A replay restores the recorded token, never fabricates a new association.
    if (operation === 'edit') delete next.analysisBindingId;
  }
  function commit(next: ModelDocument, touched: string[] = [], createdFrom: Record<string, string> = {}, prepared?: BuilderDraft, stereochemistry = true, preserveProvenance=false, preservePreparation=false,contextChanges?:Record<string,Context>,mappedContexts=false, replacementBondOrders?: { observation?: BondOrderObservation }): ModelDocument {
    if (linkedGroup && !linkedBypass) linkedGroup.assertTopology(store, next);
    next.draft.structure.dimension ??= 3;
    const inventoryEdit=electronicInventorySignature(current.draft.structure)!==electronicInventorySignature(next.draft.structure);
    if(!preserveProvenance&&inventoryEdit&&current.draft.structure.atoms.length){
      const state=electronicStateAfterModelEdit(current.draft.structure,next.draft.structure);
      next.draft.structure.charge=state.charge;next.draft.structure.multiplicity=state.multiplicity;
      next.electronicStateConfirmed=false;
    }
    if (!preserveProvenance && !replacementBondOrders?.observation && bondEvidenceGeometryKey(next.draft.structure) !== bondEvidenceGeometryKey(current.draft.structure)) clearBondEvidence(next.draft.structure);
    // A converged no-motion result can still provide a real receipt or a port
    // warning. Publish that metadata without a physical revision or Undo step.
    if (contentKey(next) === contentKey(current)&&(!contextChanges||json(contextChanges)===json(contexts))) return acceptingRuntime||preservePreparation ? emit(next,replacementBondOrders) : current;
    const revision = current.revision + 1;
    const input = prepared ?? { ...clone(current.draft), assignments: clone(next.draft.assignments) };
    // Every atom in the current realtime document is an authoritative anchor.
    // Historical ancestry through a replaced H must not bypass memberships
    // assigned later to that atom. Only this transaction's new lineage applies.
    input.createdFrom = {};
    const intendedCharge = next.draft.structure.charge;
    const provenance=preserveProvenance?next.draft.structure:current.draft.structure;
    const coordinatePreparation=acceptingRuntime||preservePreparation?clone(next.draft.structure.preparation):undefined;
    next.draft = commitBuilderTransaction(input, next.draft.structure, touched, createdFrom, stereochemistry,preserveProvenance);
    if(acceptingRuntime||preservePreparation)next.draft.structure.preparation=coordinatePreparation;
    // This transaction owns its total electronic state, including new sources.
    next.draft.structure.charge = intendedCharge;
    // Imported files describe their original geometry, not the current model.
    // Keep that evidence and its original center map through actual edits.
    next.draft.structure.gaussianSource=provenance.gaussianSource;next.draft.structure.gaussianSources=provenance.gaussianSources;
    next.draft.structure.orcaSource=provenance.orcaSource;next.draft.structure.sourceAtomIds=provenance.sourceAtomIds;
    next.draft.structure.libraryProvenance=clone(provenance.libraryProvenance);
    const materialChanged=graphFingerprint(current.draft.structure)!==graphFingerprint(next.draft.structure)||coordinatesFingerprint(current.draft.structure)!==coordinatesFingerprint(next.draft.structure);
    // Legacy sourceRoute consumers may auto-choose a level. Evidence routes are
    // retained inside gaussianSource, and only the explicit inherit button adopts them.
    next.draft.structure.sourceRoute=provenance.gaussianSource||provenance.gaussianSources?.length||materialChanged?undefined:provenance.sourceRoute;
    next.revision = revision; next.draft.revision = revision; next.draft.structure.revision = revision;
    cleanDocument(next);
    for(const [scope,context] of Object.entries(contextChanges??contexts))if(scope!==contextScope){const ids=new Set(next.draft.structure.atoms.map(atom=>atom.id!));const rows=context.coordinates.filter(row=>row.atomIds.every(id=>ids.has(id)));if(next.sharedConstraints?.frozenAtomIds.length||next.sharedConstraints?.coordinates.length)effectiveModelConstraints({...next,draft:{...next.draft,assignments:context.assignments},internalCoordinates:rows});else mergeModelCoordinates(rows,[]);}
    authorizeScientificChange(next);
    finishSelectionTransaction();
    if (!acceptingRuntime) runtime = null;
    recordStructureHistory();
    if(contextChanges)contexts=clone(contextChanges);
    for(const scope of Object.keys(contexts)){
      if(scope===contextScope)continue;
      if(mappedContexts)continue;
      const context=contexts[scope], previous=createBuilderDraft(current.draft.structure,context.assignments);
      const projected=commitBuilderTransaction(previous,next.draft.structure,touched,createdFrom,stereochemistry,preserveProvenance);
      const ids=new Set(next.draft.structure.atoms.map(atom=>atom.id));
      contexts[scope]={assignments:projected.assignments,coordinates:context.coordinates.filter(row=>row.atomIds.every(id=>ids.has(id)))};
    }
    stamps.clear();
    return emit(next,replacementBondOrders);
  }
  function stamp(movableAtomIds = getMovableAtomIds(current, 'all')): DocumentStamp {
    const result = makeDocumentStamp(current, movableAtomIds);
    stamps.set(json(result), {movable:[...movableAtomIds]});
    rememberSourceStamp(result,{movable:[...movableAtomIds]});
    if (stamps.size > 64) stamps.delete(stamps.keys().next().value!);
    return result;
  }
  function stampNativeMD(policy: NativeMDPolicy): DocumentStamp {
    const result = makeNativeMDStamp(current, policy);
    stamps.set(json(result), {movable:current.draft.structure.atoms.map(atom=>atom.id!), nativeMDPolicy:clone(result.nativeMDPolicy!)});
    rememberSourceStamp(result,{movable:current.draft.structure.atoms.map(atom=>atom.id!),nativeMDPolicy:clone(result.nativeMDPolicy!)});
    if (stamps.size > 64) stamps.delete(stamps.keys().next().value!);
    return result;
  }
  /** Constraint/object edits own history, but never run structural inheritance,
   * stereo normalization or preparation invalidation through the builder. */
  function commitMetadata(next:ModelDocument,contextChanges?:Record<string,Context>,atomFreezeOnly=false):ModelDocument {
    finishSelectionTransaction();
    if(json(next.draft.structure)!==json(current.draft.structure))throw new Error('元数据事务不能修改物理结构。');
    if(contentKey(next)===contentKey(current)&&(!contextChanges||json(contextChanges)===json(contexts)))return current;
    validateExtras(next);
    for(const [scope,context] of Object.entries(contextChanges??contexts))if(scope!==contextScope){
      if(next.sharedConstraints?.frozenAtomIds.length||next.sharedConstraints?.coordinates.length)effectiveModelConstraints({...next,draft:{...next.draft,assignments:context.assignments},internalCoordinates:context.coordinates});else mergeModelCoordinates(context.coordinates,[]);
    }
    recordStructureHistory();
    if(contextChanges)contexts=clone(contextChanges);
    next.revision=current.revision+1;next.draft.revision=next.revision;next.draft.structure.revision=next.revision;
    if(atomFreezeOnly)inheritRuntimePreviewLineage(current,next);
    runtime=null;stamps.clear();return emit(next);
  }
  /** Numbering/electronic metadata has its own history while retaining physical
   * coordinates, source centers and optimization receipts. */
  function commitIdentityMetadata(next: ModelDocument): ModelDocument {
    if (contentKey(next) === contentKey(current) && json(next.selection) === json(current.selection)) return current;
    validateExtras(next); authorizeScientificChange(next); finishSelectionTransaction(); recordStructureHistory();
    next.revision = current.revision + 1; next.draft.revision = next.revision; next.draft.structure.revision = next.revision;
    runtime = null; stamps.clear(); return emit(next);
  }
  function requireStamp(submitted: DocumentStamp): string[] {
    const registered = stamps.get(json(submitted));
    if (!registered || registered.nativeMDPolicy || submitted.nativeMDPolicy || json(makeDocumentStamp(current, registered.movable)) !== json(submitted)) throw new Error('文档或约束已变化，过期/异窗结果未应用。');
    return registered.movable;
  }
  const store: ModelStore = {
    createScientificOperation(source) {
      if (source.id !== current.id || source.revision !== current.revision || source.analysisBindingId !== current.analysisBindingId)
        throw new Error('科学帧所属文档或来源已变化，请重新选择完整帧。');
      if (json(source.draft.structure.atoms.map(atom => [atom.id, atom.element])) !== json(current.draft.structure.atoms.map(atom => [atom.id, atom.element])))
        throw new Error('科学帧原子身份或顺序与当前文档不一致。');
      // Reuse the complete reference/constraint check without consuming or
      // installing a future synchronous edit's one-shot projected basis.
      const previousBase=scientificEditBase, previousSelection=scientificEditBaseSelection;
      try { store.setScientificEditBase?.(source.draft.structure, source.selection); }
      finally { scientificEditBase=previousBase; scientificEditBaseSelection=previousSelection; }
      const owner=current, scientific=freeze(clone(source)), runStore=createRuntimeModelStore(scientific);
      const isCurrent=()=>runtimePreviewSourceCurrent(owner,current);
      let applied=false;
      return { source:scientific, store:runStore, isCurrent,
        apply(label,onAccepted) {
          if(applied)throw new Error('本次科学结果已接收，不能重复应用。');
          if(!isCurrent())return 'retained';
          if(runStore.hasTransaction?.()||runStore.isRuntimeSessionActive?.())throw new Error('科学结果尚未完成验证事务。');
          const candidate=freeze(clone(runStore.getSnapshot()));
          // A no-motion/no-graph-change result does not invalidate an observed
          // source merely because the owner's original model is another frame.
          if(!analysisGeometryChanged(scientific.draft.structure,candidate.draft.structure)
            &&analysisGeometryChanged(owner.draft.structure,scientific.draft.structure)){applied=true;return 'applied';}
          const replay=(target:ModelStore,validateCopy?:(document:ModelDocument)=>void)=>{
            if(applied||!isCurrent())throw new Error('科学结果所属来源已变化，原结果保留。');
            const accept=scientificResultTargets.get(target);if(!accept)throw new Error('结果目标不是可接收的本机模型。');
            const accepted=accept(scientific,candidate,label,store);
            validateCopy?.(accepted);
            applied=true;onAccepted?.(target);return accepted;
          };
          try { replay(store);return 'applied'; }
          catch(error) {
            if(!(error instanceof ScientificEditCancelledError)||!rejectedRequest)throw error;
            pendingEdit={request:rejectedRequest,base:clone(scientific.draft.structure),replay};
            for(const listener of [...listeners])listener();
            return 'pending';
          }
        },
      };
    },
    hasTransaction:()=>transaction!==null,
    getSnapshot: () => current,
    exportProjectState(options) {
      if(transaction)throw new Error('请先结束当前模型编辑，再保存项目。');
      const document=clone(current);document.draft.past=[];document.draft.future=[];
      const savedBaseline=options?.saved?{structure:clone(document.draft.structure),assignments:clone(document.draft.assignments),content:dirtyContentKey(document)}:clone(baseline);
      if(options?.saved){document.draft.baseStructure=clone(savedBaseline.structure);document.draft.baseAssignments=clone(savedBaseline.assignments);document.draft.baseAtomIds=savedBaseline.structure.atoms.map(atom=>atom.id!);document.draft.dirty=false;for(const id of document.draft.baseAtomIds)delete document.draft.createdFrom[id];}
      const projectEntry=(entry:HistoryEntry):ModelProjectHistoryEntry=>{
        if(entry.kind==='linked')return {kind:'linked',token:exportLinkedProjectToken(entry.token)};
        const result=clone(entry);if(result.kind==='structure'){result.document.draft.past=[];result.document.draft.future=[];delete result.document.bondOrderObservation;}return result;
      };
      const {past:savedPast,future:savedFuture}=selectProjectHistory(past.length,future.length,(direction,index)=>{
        const entry=direction==='past'?past[past.length-1-index]:future[index];
        return entry&&projectEntry(entry);
      });
      document.canUndo=savedPast.length>0;document.canRedo=savedFuture.length>0;
      return JSON.parse(json({schema:'sciyue-model-store',version:1,document,contexts,contextScope,analysisSourceInitialized,baseline:savedBaseline,past:savedPast,future:savedFuture,history:{...modelHistorySaveBudget,omittedPast:past.length-savedPast.length,omittedFuture:future.length-savedFuture.length},...(projectHistoryArchive.length?{projectHistoryArchive}:{})})) as ModelStoreProjectState;
    },
    restoreProjectState(saved,options) {
      if(runtimeActive||runtimeEditLock||transaction||linkedGroup)throw new Error('请先结束模型运行、编辑事务或关联编辑，再恢复项目。');
      if(saved?.schema!=='sciyue-model-store'||saved.version!==1||!['gaussian','orca'].includes(saved.contextScope)||!Array.isArray(saved.past)||!Array.isArray(saved.future))throw new Error('项目模型格式或版本无效。');
      const {projectHistoryArchive: archives,...source}=saved;
      const projection=prepareRestoredModelStoreHistories([source]);
      const data=clone(projection.models[0]);
      if(!options?.deferLinkedHistory&&[...data.past,...data.future].some(entry=>entry.kind==='linked'))throw new Error('关联历史须与整个项目的成员模型一起恢复。');
      assertPlainProjectModel(data);
      if(archives!==undefined&&(!Array.isArray(archives)||archives.some(archive=>archive?.schema!=='sciyue-model-store'||archive.version!==1||archive.document?.id!==data.document?.id)))throw new Error('项目历史档案身份无效。');
      // The archive is not a replay input. Keep its original JSON values, including invalid historical fields.
      const retainedArchives=clone(archives??[]);
      if(projection.limited)retainedArchives.push(clone(source));
      checkProjectModelDocument(data.document);checkProjectModelContexts(data.contexts,data.document);
      const stripDraftHistory=(document:ModelDocument)=>{document.draft.past=[];document.draft.future=[];};
      stripDraftHistory(data.document);
      const tokenSignatures=new Map<string,string>();
      for(const entry of [...data.past,...data.future]){
        checkProjectHistoryEntry(entry,data.document.id);
        if(entry.kind==='linked'){
          const signature=json(entry.token);if(tokenSignatures.has(entry.token.id)&&tokenSignatures.get(entry.token.id)!==signature)throw new Error('项目内关联历史身份重复。');tokenSignatures.set(entry.token.id,signature);
          for(const member of entry.token.members)for(const state of [member.before,member.after])if(state.kind==='structure')stripDraftHistory(state.document);
        }else if(entry.kind==='structure')stripDraftHistory(entry.document);
      }
      if(!data.baseline||typeof data.baseline.content!=='string')throw new Error('项目模型保存基线无效。');
      createBuilderDraft(data.baseline.structure,data.baseline.assignments);
      normalizeRestoredPeriodicProjectState(data);
      data.baseline.content=normalizePeriodicModelContentKey(data.baseline.content);
      // Install only after validation; requests/permissions belong to this run.
      contexts=data.contexts;contextScope=data.contextScope;baseline=data.baseline;
      projectHistoryLimited=data.document.projectHistoryLimited;projectHistoryArchive=retainedArchives;
      historyBaseline=Symbol('model-history');past=[];future=[];
      const pending=new Map<string,{token:LinkedHistoryToken;data:ModelProjectLinkedToken}>();
      const historyEntry=(entry:ModelProjectHistoryEntry):HistoryEntry=>{
        if(entry.kind!=='linked')return entry;
        let item=pending.get(entry.token.id);
        if(!item){item={token:{kind:entry.token.kind,group:null,projectIdentity:{id:entry.token.id,groupId:entry.token.groupId},members:[],validate(){throw new Error('关联历史成员尚未恢复。');}},data:entry.token};pending.set(entry.token.id,item);}
        return {kind:'linked',token:item.token};
      };
      for(const entry of data.past)past.push(trackHistory(historyEntry(entry)));
      let futureCursor=historyCursor();for(const entry of data.future){const edge={before:futureCursor,after:Symbol('model-history')};future.push(trackHistory(historyEntry(entry),edge));futureCursor=edge.after;}
      if(pending.size)projectPendingTokens.set(store,pending);else projectPendingTokens.delete(store);
      selectionTransaction=null;transaction=null;transactionChanged=false;
      runtime=null;runtimeActive=false;runtimeEditLock=false;runtimeIsolated=false;acceptingRuntime=false;stamps.clear();
      scientificEditGuard=null;scientificEditApproval=null;rejectedRequest=null;pendingEdit=null;scientificEditBase=null;scientificEditBaseSelection=null;scientificEditFrame=null;
      analysisSourceInitialized=data.analysisSourceInitialized??Boolean(data.document.analysisBindingId);activeBondOrders=data.document.bondOrderObservation;
      current=freeze(clone(data.document));
      emit(data.document);
    },
    bindAnalysisContext(bindingId, documentId, expectedRevision) {
      if(typeof bindingId!=='string'||!bindingId.trim())throw new Error('分析上下文绑定身份不能为空。');
      if(current.id!==documentId||current.revision!==expectedRevision||runtimeEditLock||transaction)return false;
      if(current.analysisBindingId)return current.analysisBindingId===bindingId;
      const next=clone(current);next.analysisBindingId=bindingId;scientificEditApproval=null;
      // Result registration owns no geometry/revision or Undo/Future entry.
      // Selection history and registered scientific requests remain untouched.
      emit(next);return true;
    },
    bindAnalysisFrameBondOrigin(bindingId,identity){
      frameBondIdentityKey(identity);
      if(current.analysisBindingId!==bindingId)return false;
      if(current.analysisFrameBondOrigin?.bindingId===bindingId)return frameBondIdentityKey(current.analysisFrameBondOrigin.identity)===frameBondIdentityKey(identity);
      const next=clone(current),wasDirty=current.draft.dirty,legacy=defaultFrameBondIdentity({...current,analysisFrameBondOrigin:undefined})!,legacyKey=frameBondIdentityKey(legacy),canonicalKey=frameBondIdentityKey(identity);
      const entry=next.frameBondOverrides?.[legacyKey];
      // This alias is proven by the owner's initial handoff, never by searching
      // geometrically equal trajectory frames. Keep ambiguous old histories.
      if(entry&&!next.frameBondOverrides?.[canonicalKey]&&entry.scientificFingerprint===frameBondScientificFingerprint(current.draft.structure)){
        next.frameBondOverrides![canonicalKey]={...entry,identity:clone(identity)};delete next.frameBondOverrides![legacyKey];
      }
      next.analysisFrameBondOrigin={bindingId,identity:clone(identity)};if(!wasDirty)baseline.content=dirtyContentKey(next);emit(next);return true;
    },
    setScientificEditGuard(guard) { scientificEditGuard = guard; scientificEditApproval = null; },
    setScientificEditBase(structure, selection, frame) {
      scientificEditBase = null; scientificEditBaseSelection = null; scientificEditFrame=null;
      if (!structure) return;
      createBuilderDraft(structure);
      const ids = new Set(structure.atoms.map(atom => atom.id));
      const requireIds = (references: readonly string[], label: string) => {
        if (references.some(id => !ids.has(id))) throw new Error(`当前静态帧的原子身份与${label}不一致；请先修复相关定义后再建模。`);
      };
      const requireAssignments = (assignments: BuilderAssignments) => {
        requireIds(assignments.frozenAtomIds, '原子冻结');
        for (const row of [...assignments.layers, ...assignments.basis, ...assignments.fragments]) requireIds(row.atomIds, '分区或基组');
      };
      requireAssignments(current.draft.assignments);
      for (const context of Object.values(contexts)) { requireAssignments(context.assignments); for (const row of context.coordinates) requireIds(row.atomIds, '任务内坐标'); }
      requireIds(current.sharedConstraints?.frozenAtomIds ?? [], '共享冻结');
      for (const row of [...(current.internalCoordinates ?? []), ...(current.sharedConstraints?.coordinates ?? []), ...(current.coordinateObjects ?? []), ...(current.gaussianBoundCoordinates ?? [])]) requireIds(row.atomIds, '内坐标');
      for (const row of current.auxiliaryRelations) requireIds([row.a, row.b], '辅助连接');
      for (const row of current.deletedBonds) requireIds(row.atomIds, '删键记录');
      for (const port of current.attachmentPorts ?? []) requireIds([port.hostAtomId], '待接端口');
      if (selection) { requireIds(selection.atomIds, '当前选区'); for (const bond of selection.bonds) requireIds(bond.atomIds, '当前键选区'); }
      // Validate existing image/coordinate definitions against the new cell
      // before any cleaner could prune a dangling stable identity.
      validateExtras({ ...current, draft: { ...current.draft, structure } });
      scientificEditBase = clone(structure); scientificEditBaseSelection = selection ? clone(selection) : null;
      if(frame)scientificEditFrame={identity:clone(frame.identity),document:clone(frame.document)};
    },
    replayFrameBondHistory(identity,document,direction){
      const overrides=replayFrameBondOverride(current,document,identity,direction);
      return overrides?emit({...clone(current),frameBondOverrides:overrides}):current;
    },
    getPendingScientificEdit() { return pendingEdit?.request ?? null; },
    getPendingScientificEditBase() { return pendingEdit ? clone(pendingEdit.base) : null; },
    resolvePendingScientificEdit(choice, targetStore, validateCopy) {
      const pending = pendingEdit; rejectedRequest = null;
      if (choice === 'cancel' || !pending) { pendingEdit=null;return current; }
      const request = pending.request;
      if (request.documentId !== current.id || request.revision !== current.revision || request.bindingId !== current.analysisBindingId) throw new Error('等待选择期间结构或来源已变化，请重新操作。');
      if (choice === 'copy') {
        if (!targetStore || targetStore === store || targetStore.getSnapshot().id === current.id || (analysisGeometryChanged(current.draft.structure, targetStore.getSnapshot().draft.structure)&&analysisGeometryChanged(pending.base,targetStore.getSnapshot().draft.structure)) || targetStore.getSnapshot().analysisBindingId) throw new Error('请先打开与来源结构一致的独立建模副本。');
        pending.replay(targetStore,validateCopy);pendingEdit=null; return targetStore.getSnapshot();
      }
      scientificEditApproval = { documentId: current.id, revision: current.revision, bindingId: request.bindingId };
      try { pending.replay(store);pendingEdit=null; return current; } finally { scientificEditApproval = null; }
    },
    requestScientificEditApproval() {
      const bindingId = current.analysisBindingId;
      if (!bindingId) { scientificEditApproval = null; return true; }
      if (scientificEditApproval?.documentId === current.id && scientificEditApproval.bindingId === bindingId && scientificEditApproval.revision === current.revision) return true;
      scientificEditApproval = null;
      const before = current;
      if (!scientificEditGuard?.(Object.freeze({ documentId:current.id, revision:current.revision, bindingId, operation:'edit' }))) return false;
      if (current !== before) throw new Error('确认期间模型已变化，请重新操作。');
      scientificEditApproval = { documentId:current.id, revision:current.revision, bindingId };
      return true;
    },
    clearScientificEditApproval() { scientificEditApproval = null; },
    replaceAnalysisSource(structure, bindingId,frameBondIdentity) {
      scientificEditApproval = null;
      if (runtimeEditLock || transaction || linkedGroup) throw new Error('请先结束运行、编辑事务或关联组，再替换分析来源。');
      const draft = analysisSourceDraft(structure, bindingId), revision = current.revision + 1;
      draft.revision = revision; draft.structure.revision = revision;
      const next:ModelDocument = { id:current.id, revision, draft, analysisBindingId:bindingId, selection:emptySelection(), auxiliaryRelations:[], deletedBonds:[], attachmentPorts:[], internalCoordinates:[], canUndo:false, canRedo:false,
        ...(current.frameBondOverrides?{frameBondOverrides:clone(current.frameBondOverrides)}:{}) };
      if(frameBondIdentity){frameBondIdentityKey(frameBondIdentity);next.analysisFrameBondOrigin={bindingId,identity:clone(frameBondIdentity)};}
      validateExtras(next);
      contexts = {}; past = []; future = []; historyBaseline=Symbol('model-history'); selectionTransaction = null;
      runtime = null; stamps.clear(); activeBondOrders = undefined; analysisSourceInitialized = true;
      baseline = { structure:clone(draft.structure), assignments:clone(draft.assignments), content:dirtyContentKey(next) };
      emit(next);
    },
    beginSelectionTransaction() {
      if (linkedGroup && !linkedBypass && linkedGroup.beginSelection(store)) return;
      if (!selectionTransaction) selectionTransaction = { initial: clone(current.selection), previousFuture: future };
    },
    endSelectionTransaction() { if (linkedGroup && !linkedBypass) linkedGroup.endSelection(); finishSelectionTransaction(true); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getContext(scope) { return scope===contextScope ? clone({assignments:current.draft.assignments,coordinates:current.internalCoordinates??[]}) : clone(contexts[scope]); },
    synchronizeGaussianBasisState(state, assignments) {
      const gaussian=contextScope==='gaussian'?{assignments:current.draft.assignments,coordinates:current.internalCoordinates??[]}:contexts.gaussian;
      if(json(current.gaussianBasisState)===json(state)&&(assignments===undefined||json(gaussian?.assignments.basis)===json(assignments)))return;
      if(runtimeEditLock||transaction)throw new Error('请先结束当前动态或几何事务，再同步基组设置。');
      const next=clone(current);next.gaussianBasisState=clone(state);
      if(assignments!==undefined){
        const ids=new Set(current.draft.structure.atoms.map(atom=>atom.id!));
        if(assignments.some(region=>region.atomIds.some(id=>!ids.has(id))))throw new Error('基组区域引用已失效原子。');
        if(contextScope==='gaussian')next.draft.assignments.basis=clone(assignments);
        else {const context=gaussian??{assignments:assignmentsOf(),coordinates:[]};contexts.gaussian={...clone(context),assignments:{...clone(context.assignments),basis:clone(assignments)}};}
      }
      emit(next);
    },
    synchronizeGaussianBoundCoordinates(definitions) {
      validateGaussianBoundCoordinates(definitions,current.coordinateObjects??[],current.draft.structure);
      if(json(current.gaussianBoundCoordinates??[])===json(definitions))return;
      if(runtimeEditLock||transaction)throw new Error('请先结束当前动态或几何事务，再同步对象关联定义。');
      const next=clone(current);next.gaussianBoundCoordinates=clone(definitions);emit(next);
    },
    beginTransaction() {
      finishSelectionTransaction(true);
      if (transaction) throw new Error('已有未结束的建模事务。');
      transaction = snapshot(); transactionChanged = false;
    },
    endTransaction() {
      scientificEditApproval = null;
      finishSelectionTransaction(true);
      if (!transaction) return;
      if (transactionChanged && contentKey(current) === contentKey(transaction.document)&&json(snapshot().contexts)===json(transaction.contexts)) {
        const index = past.indexOf(transaction); if (index >= 0) past.splice(index, 1);
      }
      transaction = null; transactionChanged = false; emit(clone(current));
    },
    cancelTransaction() {
      scientificEditApproval = null;
      finishSelectionTransaction(true);
      if (!transaction) return;
      if (!transactionChanged && contentKey(current)===contentKey(transaction.document)) {
        const selection=clone(current.selection),next=restore(transaction);next.selection=selection;
        transaction=null;runtime=null;emit(next);return;
      }
      const index=past.indexOf(transaction);if(index>=0)past.splice(index,1);
      const selection=clone(current.selection),next=restore(transaction);next.selection=selection;
      next.revision=current.revision+1;next.draft.revision=next.revision;next.draft.structure.revision=next.revision;
      transaction=null;transactionChanged=false;runtime=null;stamps.clear();emit(next);
    },
    synchronizeContext(assignments, coordinates, scope = contextScope) {
      finishSelectionTransaction(true);
      assignments={...clone(assignments),layers:assignments.layers.map(checkedInputLayerDraft)};
      if(current.sharedConstraints?.canonical){assignments.frozenAtomIds=[];coordinates=coordinates.filter(row=>row.action!=='freeze');}
      if (scope === contextScope && json(current.draft.assignments) === json(assignments) && json(current.internalCoordinates ?? []) === json(coordinates)) return;
      scientificEditApproval = null;
      if(runtimeEditLock&&(json(current.draft.assignments)!==json(assignments)||json(current.internalCoordinates??[])!==json(coordinates)))throw new Error('动态会话未停止，不能改变模型约束。');
      if (transaction) throw new Error('请先暂停动态计算或结束手势，再切换任务约束。');
      const candidate=clone(current);candidate.draft.assignments=clone(assignments);candidate.internalCoordinates=clone(coordinates);validateExtras(candidate);
      contexts[contextScope]={assignments:clone(current.draft.assignments),coordinates:clone(current.internalCoordinates??[])};
      contextScope=scope;contexts[scope]={assignments:clone(assignments),coordinates:clone(coordinates)};
      const next = clone(current); next.draft.assignments = clone(assignments); next.internalCoordinates = clone(coordinates);
      validateExtras(next); cleanDocument(next); stamps.clear(); emit(next);
    },
    synchronizeSharedConstraints(constraints) {
      if(runtimeActive||runtimeEditLock||transaction)throw new Error('模型正在运行或编辑，暂不能投影任务冻结。');
      const previous=current.sharedConstraints??emptySharedConstraints();
      const beforeIds=new Set(previous.frozenAtomIds),afterIds=new Set(constraints.frozenAtomIds);
      const removedIds=new Set(previous.frozenAtomIds.filter(id=>!afterIds.has(id))),addedIds=constraints.frozenAtomIds.filter(id=>!beforeIds.has(id));
      const beforeRows=new Map(previous.coordinates.map(row=>[modelCoordinateKey(row),row]));
      const afterRows=new Map(constraints.coordinates.map(row=>[modelCoordinateKey(row),row]));
      const removedRows=new Set([...beforeRows.keys()].filter(key=>!afterRows.has(key)));
      const replacedRows=[...afterRows].filter(([key,row])=>json(row)!==json(beforeRows.get(key)));
      const enabledChanged=(previous.enabled!==false)!==(constraints.enabled!==false);
      function mirror(document:ModelDocument,exact=false):ModelDocument {
        const shared=document.sharedConstraints??emptySharedConstraints(),structure=document.draft.structure;
        const ids=new Set(structure.atoms.map(atom=>atom.id));
        const rows=new Map(shared.coordinates.filter(row=>!removedRows.has(modelCoordinateKey(row))).map(row=>[modelCoordinateKey(row),row]));
        for(const [key,row] of replacedRows){
          if(!row.atomIds.every(id=>ids.has(id))||!structure.cell&&row.images?.some(image=>image.some(Boolean)))continue;
          rows.set(key,{...row,objectId:undefined});
        }
        const coordinates=canonicalFreezeRows(structure,exact?constraints.coordinates:[...rows.values()],document.coordinateObjects);
        const next={...document,coordinateObjects:coordinates.coordinateObjects,sharedConstraints:{...shared,canonical:true as const,
          ...(enabledChanged?{enabled:constraints.enabled}:{}),frozenAtomIds:exact?[...constraints.frozenAtomIds]:
            [...new Set([...shared.frozenAtomIds.filter(id=>!removedIds.has(id)),...addedIds.filter(id=>ids.has(id))])],coordinates:coordinates.coordinates}};
        validateExtras(next);return next;
      }
      const next=clone(mirror(current,true));
      if(contentKey(next)===contentKey(current))return;
      finishSelectionTransaction();
      const rebase=(entry:HistoryEntry):HistoryEntry=>entry.kind==='structure'?
        trackHistory({...entry,document:mirror(entry.document)},historyEdges.get(entry)):entry;
      const nextPast=past.map(rebase),nextFuture=future.map(rebase);
      const wasDirty=current.draft.dirty;
      past=nextPast;future=nextFuture;
      next.revision=current.revision+1;
      next.draft={...next.draft,revision:next.revision,structure:{...next.draft.structure,revision:next.revision}};
      if(!wasDirty)baseline.content=dirtyContentKey(next);
      scientificEditApproval=null;runtime=null;stamps.clear();emit(next);
    },
    setElectronicState(charge, multiplicity, confirmed) {
      if (!Number.isInteger(charge) || !Number.isInteger(multiplicity) || multiplicity < 1) return;
      if (linkedGroup && !linkedBypass) {
        linkedGroup.run(store, () => store.execute({ type: 'set-electronic-state', charge, multiplicity, confirmed: confirmed ?? current.electronicStateConfirmed ?? false })); return;
      }
      if (current.draft.structure.charge === charge && current.draft.structure.multiplicity === multiplicity && (confirmed === undefined || (current.electronicStateConfirmed ?? false) === confirmed)) return;
      if(runtimeEditLock)throw new Error('动态会话未停止，不能修改结构或电子态。');
      const next = clone(current); next.draft.structure.charge = charge; next.draft.structure.multiplicity = multiplicity;
      if (confirmed !== undefined) next.electronicStateConfirmed = confirmed;
      clearBondEvidence(next.draft.structure);
      if ((analysisSourceInitialized || runtimeActive) && (charge !== current.draft.structure.charge || multiplicity !== current.draft.structure.multiplicity)) { commitIdentityMetadata(next); return; }
      stamps.clear(); emit(next);
    },
    stamp, stampNativeMD,
    select(selection) {
      if (linkedGroup && !linkedBypass) return linkedGroup.run(store, () => store.select(selection), 'selection');
      const next = normalizeSelection(selection);
      if (json(next) === json(current.selection)) return current;
      if (!selectionTransaction) past.push(selectionSnapshot(current.selection));
      else if (!selectionTransaction.entry) {
        const entry = selectionSnapshot(selectionTransaction.initial);
        selectionTransaction.entry = entry; past.push(entry);
      }
      future = [];
      return publishSelection(next);
    },
    clearCaptureSelection(){
      if (linkedGroup && !linkedBypass) { linkedGroup.endSelection(); linkedGroup.run(store, () => { store.clearCaptureSelection?.(); return current; }, 'selection', false, false); return; }
      const selection=emptySelection();
      if(!sameSelection(selection,current.selection))publishSelection(normalizeSelection(selection));
    },
    executeBatch(commands, label) {
      if (!commands.length) return current;
      if (linkedGroup && !linkedBypass) {
        linkedGroup.preflight();
        return linkedGroup.run(store, () => store.executeBatch!(commands, label), 'structure', false, true, !commands.some(command => command.type === 'reorder-atoms'));
      }
      const owner = linkedStoreAccess.get(store)!, checkpoint = owner.checkpoint();
      const batchDocument = current.id, batchRevision = current.revision;
      owner.batch(true); let success = false;
      try {
        store.beginTransaction(label);
        for (const command of commands) {
          // A caller can bind ordered edits to the same external snapshot. The
          // Store advances each internal revision as the single batch runs.
          const boundEdit=command.type==='manual-coordinates'||command.type==='reorder-atoms';
          store.execute(boundEdit&&command.documentId===batchDocument&&command.expectedRevision===batchRevision
            ? {...command,expectedRevision:current.revision} : command);
        }
        store.endTransaction(); success = true;
      } catch (error) { checkpoint.rollback(); throw error; }
      finally { owner.batch(false, success); }
      return current;
    },
    execute(command) {
      try {
      if (linkedGroup && !linkedBypass) { if (command.type === 'reorder-atoms') linkedGroup.preflight(); return linkedGroup.run(store, () => store.execute(command), 'structure', false, true, command.type !== 'reorder-atoms'); }
      if(runtimeEditLock)throw new Error('动态会话未停止，不能修改结构。');
      // A Cartesian drag replaces only the coordinate array, rotated port
      // directions and stereo presentation before the shared commit validates it.
      let next = command.type==='transform-fragment'
        ? {...current,selection:{...current.selection},draft:{...current.draft,structure:{...current.draft.structure}}}
        : clone(current);
      let structure = next.draft.structure;
      let touched: string[] = [], createdFrom: Record<string, string> = {};
      let contextChanges:Record<string,Context>|undefined;
      switch (command.type) {
        case 'ensure-cell-checkpoint':
        case 'save-cell-checkpoint': {
          if (command.type === 'ensure-cell-checkpoint' && current.cellCheckpoint) return current;
          next.cellCheckpoint = captureCellCheckpoint(current);
          // A bookmark is not a geometry edit and must not clear either history stack.
          return emit(next);
        }
        case 'restore-cell-checkpoint': {
          if (!current.cellCheckpoint) return current;
          const saved = clone(current.cellCheckpoint), replacement = createBuilderDraft(saved.structure, saved.assignments);
          next.draft = replacement; next.selection = emptySelection();
          next.auxiliaryRelations = saved.auxiliaryRelations; next.deletedBonds = saved.deletedBonds;
          next.internalCoordinates = saved.internalCoordinates; next.sharedConstraints = saved.sharedConstraints;
          next.coordinateObjects = saved.coordinateObjects; next.gaussianBoundCoordinates = saved.gaussianBoundCoordinates;
          next.attachmentPorts = saved.attachmentPorts;
          delete next.bondOrderObservation; delete next.draft.structure.preparation;
          return commit(next, replacement.structure.atoms.map(atom => atom.id!), {}, replacement, false, true);
        }
        case 'remove-cell': {
          if (!structure.cell) return current;
          next = removeDocumentCell(current);
          const mapped = Object.fromEntries(Object.entries(contexts).map(([scope, context]) => {
            const projection = removeDocumentCell({ ...current, draft: { ...current.draft, assignments: context.assignments }, internalCoordinates: context.coordinates });
            return [scope, { assignments: projection.draft.assignments, coordinates: projection.internalCoordinates ?? [] }];
          }));
          return commit(next, [], {}, undefined, false, false, false, mapped, true);
        }
        case 'apply-structure-transform': {
          if(transaction)throw new Error('请先结束当前几何手势，再应用结构变换。');
          const candidate=command.candidate;
          next=mapStructureTransformDocument(current,candidate);
          const mapped:Record<string,Context>={};
          for(const [scope,context] of Object.entries(contexts))mapped[scope]=mapStructureTransformContext(current,candidate,context);
          // Prepared assignments already carry complete explicit lineage.
          // Neither legacy anchor inheritance nor source replacement may
          // manufacture a second history step or discard mapped metadata.
          const prepared={...clone(current.draft),assignments:clone(next.draft.assignments)};
          return commit(next,next.draft.structure.atoms.map(atom=>atom.id!),{},prepared,false,false,false,mapped,true);
        }
        case 'reorder-atoms': {
          if (command.documentId !== current.id || command.expectedRevision !== current.revision) throw new Error('重新编号方案已过期，请按当前模型重新生成。');
          next.draft.structure = reindexStructureAtoms(structure, command.atomIds);
          return commitIdentityMetadata(next);
        }
        case 'set-electronic-state': {
          if (!Number.isInteger(command.charge) || !Number.isInteger(command.multiplicity) || command.multiplicity < 1 || typeof command.confirmed !== 'boolean') throw new Error('电荷、多重度或确认状态无效。');
          next.draft.structure.charge = command.charge; next.draft.structure.multiplicity = command.multiplicity; next.electronicStateConfirmed = command.confirmed;
          if (command.charge !== current.draft.structure.charge || command.multiplicity !== current.draft.structure.multiplicity) clearBondEvidence(next.draft.structure);
          return commitIdentityMetadata(next);
        }
        case 'set-gaussian-basis-state': {
          if(!command.state.mixedBasis?.enabled&&command.assignments.length)throw new Error('普通基组不能保留有效混基区域。');
          const ids=new Set(structure.atoms.map(atom=>atom.id!));
          if(command.assignments.some(region=>region.atomIds.some(id=>!ids.has(id))))throw new Error('基组区域引用已失效原子。');
          const basis=clone(command.assignments);
          const changed=clone(contexts);
          if(contextScope==='gaussian')next.draft.assignments.basis=basis;
          else {
            const gaussian=changed.gaussian??{assignments:assignmentsOf(),coordinates:[]};
            changed.gaussian={...gaussian,assignments:{...gaussian.assignments,basis}};
          }
          next.gaussianBasisState=clone(command.state);
          return commitMetadata(next,contextScope==='gaussian'?undefined:changed);
        }
        case 'place-element': {
          if(command.presetId && getElementPreset(command.presetId).element!==elementSymbol(command.element))throw new Error('元素与片段几何预设不一致。');
          if (command.targetPortId && !command.presetId) throw new Error('端口接入需要明确元素几何预设。');
          if (command.presetId) {
            const result = prepareElementPreset(structure, { presetId:command.presetId, position:command.position, targetAtomId:command.targetAtomId, targetPortId:command.targetPortId, attachmentPorts:next.attachmentPorts });
            structure=result.structure; touched=result.touchedIds; createdFrom=result.createdFrom; next.attachmentPorts=result.attachmentPorts;
          } else { const result=prepareElement(structure,command);structure=result.structure;touched=result.touchedIds;createdFrom=result.createdFrom; }
          const target = command.targetAtomId;
          const site = target && structure.atoms.find(atom => atom.id === target);
          if (target && site && site.element !== current.draft.structure.atoms.find(old => old.id === target)?.element) {
            contextChanges = retireReplacement(next, new Set([target]));
          }
          break;
        }
        case 'place-fragment': {
          const result=placeBuilderFragment(structure,{templateId:command.templateId,activeAtomIndex:command.activeAtomIndex,position:command.position,targetAtomId:command.targetAtomId,targetPortId:command.targetPortId,attachmentPorts:next.attachmentPorts});
          const replaced = new Set(command.targetAtomId ? [command.targetAtomId] : []);
          assertFrozenCoordinatesPreserved(current,result.structure,replaced);
          if (replaced.size) contextChanges = retireReplacement(next, replaced, true);
          // Explicit graph construction can add atoms; refreshManualStereo is
          // intentionally reserved for same-inventory coordinate gestures.
          next.draft.structure=updateBuilderStereo(result.structure).structure;
          next.attachmentPorts=result.attachmentPorts;
          if (command.targetAtomId) {
            const replacement = renewPlacedAtomId(next, command.targetAtomId);
            result.createdFrom[replacement] = command.targetAtomId;
            result.touchedIds.push(replacement);
          }
          return commit(next,result.touchedIds,result.createdFrom,undefined,false,false,false,contextChanges);
        }
        case 'add-single-hydrogen': {
          // Keep both Cartesian freezes and every member of a frozen B/A/D
          // unchanged during local H placement; never fit the heavy skeleton.
          const fixedAtomIds = unique([
            ...getFrozenAtomIds(next),
            ...effectiveModelCoordinates(next).filter(coordinate => coordinate.action === 'freeze').flatMap(coordinate => coordinate.atomIds),
          ]);
          const host=structure.atoms[atomIndex(structure,command.atomId)],preset=host.geometryPresetId?getElementPreset(host.geometryPresetId):undefined;
          const namedOpen=preset?.attachmentLengthPolicy==='covalent-radii'&&preset.slots.length>0&&(preset.slots.every(slot=>slot.fill==='open')||preset.family==='coordination'&&(next.attachmentPorts??[]).some(port=>port.hostAtomId===command.atomId&&port.presetId===preset.id&&preset.slots.some(slot=>slot.id===port.slotId)));
          const available=namedOpen?(next.attachmentPorts??[]).filter(port=>port.hostAtomId===command.atomId&&port.order===1&&port.presetId===preset.id&&preset.slots.some(slot=>slot.id===port.slotId&&slot.order===1)):undefined;
          const result = addSingleHydrogen(structure, command.atomId, { fixedAtomIds,placement:'local-slots',...(available?.length?{openPortDirections:available.map(port=>port.direction)}:{}) });
          if(available?.length){
            const newId=Object.keys(result.createdFrom)[0],added=result.structure.atoms.find(atom=>atom.id===newId)!;
            const delta:Vector3=[added.x-host.x,added.y-host.y,added.z-host.z],length=Math.hypot(...delta);
            const consumed=available.find(port=>Math.hypot(...port.direction.map((value,i)=>value-delta[i]/length))<1e-6);
            if(!consumed)throw new Error('新增H未对应明确的单键开放槽，整笔未提交。');
            next.attachmentPorts=(next.attachmentPorts??[]).filter(port=>port.id!==consumed.id);
          }
          structure = result.structure; touched = result.touchedIds; createdFrom = result.createdFrom; break;
        }
        case 'prepare-2d-hydrogens': {
          const result = prepare2DHydrogens(structure);
          next.draft.structure = result.structure;
          // A planar seed must retain the user's wedge intent; do not derive
          // Cartesian stereo from the deliberately flat preparation geometry.
          return commit(next, result.touchedIds, result.createdFrom, undefined, false);
        }
        case 'place-copied-fragment': {
          const replaced = new Set(command.targetAtomId ? [command.targetAtomId] : []);
          // Retire the target's old definitions before the incoming fragment
          // maps its own explicitly saved definitions onto the new object.
          if (replaced.size) contextChanges = retireReplacement(next, replaced, true);
          const fragment:FragmentSnapshot={structure,assignments:next.draft.assignments,auxiliaryRelations:next.auxiliaryRelations,deletedBonds:next.deletedBonds,attachmentPorts:next.attachmentPorts,internalCoordinates:next.internalCoordinates,sharedConstraints:next.sharedConstraints,coordinateObjects:next.coordinateObjects,gaussianBoundCoordinates:next.gaussianBoundCoordinates};
          const seed=createCopiedFragmentSeed(command.payload,command.activeIndex);
          const result=placeCopiedFragment(fragment,seed,command);
          assertFrozenCoordinatesPreserved(current,result.fragment.structure,replaced);
          next.draft.structure=result.fragment.structure;next.draft.assignments=result.fragment.assignments;
          next.auxiliaryRelations=result.fragment.auxiliaryRelations;next.deletedBonds=result.fragment.deletedBonds;
          next.attachmentPorts=result.fragment.attachmentPorts;next.internalCoordinates=result.fragment.internalCoordinates;
          next.sharedConstraints=result.fragment.sharedConstraints;next.coordinateObjects=result.fragment.coordinateObjects;
          next.gaussianBoundCoordinates=result.fragment.gaussianBoundCoordinates;
          if (command.targetAtomId) result.touchedIds.push(renewPlacedAtomId(next, command.targetAtomId));
          // The returned source roles are already remapped. Do not assign all
          // copied atoms to the target active region through createdFrom.
          return commit(next,result.touchedIds,{},undefined,false,false,false,contextChanges);
        }
        case 'delete-objects': {
          const selection = command.selection ?? next.selection;
          if(selection.coordinateIds?.length){
            const known=new Map(coordinateSelectionObjects(next).map(object=>[object.id,object]));
            const objects=unique(selection.coordinateIds).map(id=>{const object=known.get(id);if(!object)throw new Error('所选内坐标对象已不存在；未删除。');return object;});
            contextChanges=removeCoordinateObjects(next,objects);
            if(!selection.atomIds.length&&!selection.bonds.length&&!selection.auxiliaryIds.length&&!selection.portIds?.length)return commitMetadata(next,contextChanges);
          }
          next.attachmentPorts = (next.attachmentPorts ?? []).filter(port => !(selection.portIds ?? []).includes(port.id));
          const removed = new Set(selection.atomIds);
          for (const id of removed) atomIndex(structure, id);
          // Only terminal heavy atoms carry their direct, unshared H along.
          for (const id of selection.atomIds) {
            const index = atomIndex(structure, id), atom = structure.atoms[index];
            if (atom.element === 'H') continue;
            const heavyNeighbours = (structure.bonds ?? []).filter(bond => bond.kind !== 'coordination' && (bond.a === index || bond.b === index)).filter(bond => structure.atoms[bond.a === index ? bond.b : bond.a].element !== 'H');
            if (heavyNeighbours.length <= 1) for (const hydrogen of removedSiteHydrogens(structure, id)) removed.add(hydrogen);
          }
          const deleting = new Set(selection.bonds.map(referenceKey));
          for (const bond of structure.bonds ?? []) {
            const reference = bondReference(structure, bond);
            if (deleting.has(referenceKey(reference))) next.deletedBonds.push({ atomIds: reference.atomIds, image: reference.image });
          }
          structure.bonds = (structure.bonds ?? []).filter(bond => !deleting.has(referenceKey(bondReference(structure, bond))));
          // Mark the surviving site as explicitly open, without refilling it.
          for (const bond of structure.bonds) {
            const a = structure.atoms[bond.a], b = structure.atoms[bond.b];
            if (a.element === 'H' && removed.has(a.id!) && !removed.has(b.id!)) b.hydrogenMode = 'explicit';
            if (b.element === 'H' && removed.has(b.id!) && !removed.has(a.id!)) a.hydrogenMode = 'explicit';
          }
          next.auxiliaryRelations = next.auxiliaryRelations.filter(relation => !selection.auxiliaryIds.includes(relation.id));
          touched = [...removed, ...selection.bonds.flatMap(reference => reference.atomIds)];
          structure = removeAtoms(structure, removed); break;
        }
        case 'set-bond-order': {
          const [a, b] = command.atomIds.map(id => atomIndex(structure, id));
          if (a === b && !command.image?.some(Boolean)) throw new Error('请选择两个不同原子。');
          if (command.image && !command.image.every(Number.isInteger)) throw new Error('周期键平移必须是整数。');
          const key = bondKey(command.atomIds, command.image);
          if (structure.bondPerceptionIssues) structure.bondPerceptionIssues = structure.bondPerceptionIssues.filter(issue => bondKey(issue.atomIds, issue.image) !== key);
          if (command.order === .5 && !(a === b || command.image?.some(Boolean))) {
            const replaced = (structure.bonds ?? []).some(bond => referenceKey(bondReference(structure, bond)) === key);
            structure.bonds = (structure.bonds ?? []).filter(bond => referenceKey(bondReference(structure, bond)) !== key);
            if (replaced) next.deletedBonds.push({ atomIds: [...command.atomIds], image: command.image ? clone(command.image) : undefined });
            if (!next.auxiliaryRelations.some(relation => bondKey([relation.a, relation.b]) === key)) next.auxiliaryRelations.push({ id: newModelId(), a: command.atomIds[0], b: command.atomIds[1], order: .5, kind: 'auxiliary' });
          } else {
            next.auxiliaryRelations = next.auxiliaryRelations.filter(relation => bondKey([relation.a, relation.b]) !== key);
            structure.bonds = (structure.bonds ?? []).filter(bond => referenceKey(bondReference(structure, bond)) !== key);
            structure.bonds.push({ a, b, order: command.order, aromatic: false, ...([.5,1.5].includes(command.order) ? { fractional: true } : {}), ...(command.image ? { image: clone(command.image) } : {}) });
            next.deletedBonds = next.deletedBonds.filter(reference => referenceKey(reference) !== key);
          }
          touched = [...command.atomIds]; break;
        }
        case 'break-bond': {
          const key=referenceKey({atomIds:command.atomIds,image:command.image});
          const edge=(structure.bonds??[]).find(bond=>referenceKey(bondReference(structure,bond))===key);
          if(!edge)throw new Error('待断化学键已不存在。');
          if(edge.orderKnown===false)throw new Error('经验周期连接没有确定键级；请使用删键，不将其转换为带确定键级的待接端口。');
          const a=structure.atoms[edge.a],b=structure.atoms[edge.b];
          let direction:Vector3=[b.x-a.x,b.y-a.y,b.z-a.z];
          if(edge.image?.some(Boolean)){
            if(!structure.cell)throw new Error('跨胞断键需要真实晶胞。');
            edge.image.forEach((n,index)=>{direction=builderVector.add(direction,builderVector.scale(structure.cell!.vectors[index],n));});
          }
          const length=Math.hypot(...direction);
          if(!Number.isFinite(length)||length<1e-8)throw new Error('重合的键端不能确定待接端口方向；未断键。');
          direction=builderVector.scale(direction,1/length).map(v=>v===0?0:v) as Vector3;
          const order=(edge.aromatic||edge.order===4?1.5:edge.order) as 1|1.5|2|3;
          if(![1,1.5,2,3].includes(order))throw new Error('该对象不是可断开的真实化学键。');
          const existing=new Set([...structure.atoms.map(atom=>atom.id),...(next.attachmentPorts??[]).map(port=>port.id)]);
          const id=()=>{let result=newModelId();while(existing.has(result))result=newModelId();existing.add(result);return result;};
          next.attachmentPorts=[...(next.attachmentPorts??[]),{id:id(),hostAtomId:a.id!,direction,order,displayLength:.8},{id:id(),hostAtomId:b.id!,direction:builderVector.scale(direction,-1).map(v=>v===0?0:v) as Vector3,order,displayLength:.8}];
          structure.bonds=(structure.bonds??[]).filter(bond=>referenceKey(bondReference(structure,bond))!==key);
          if(!next.deletedBonds.some(reference=>referenceKey(reference)===key))next.deletedBonds.push({atomIds:[a.id!,b.id!],...(edge.image?{image:clone(edge.image)}:{})});
          touched=[a.id!,b.id!];break;
        }
        case 'transform-fragment': {
          const ids = new Set(command.atomIds), atomsById = new Map(structure.atoms.map(atom => [atom.id, atom]));
          for (const id of ids) if (!atomsById.has(id)) throw new Error(`原子 ${id} 已不存在。`);
          if (command.delta && !finiteVector(command.delta) || command.rotation && (!finiteVector(command.rotation.axis) || !finiteVector(command.rotation.pivot) || !Number.isFinite(command.rotation.degrees))) throw new Error('变换参数必须有限。');
          const positions=new Map<string,Vector3>(),offsets=new Map<string,Vector3>();
          if(command.unwrapPeriodic){
            for(const id of ids){
              if(positions.has(id))continue;
              const fragment=resolveFinitePeriodicFragment(structure,id);
              if(fragment.atomIds.some(member=>!ids.has(member)))throw new Error('有限片段手势必须包含完整连接片段。');
              for(const member of fragment.atomIds){const atom=atomsById.get(member)!,point=fragment.positions[member];positions.set(member,point);offsets.set(member,builderVector.sub(point,[atom.x,atom.y,atom.z]));}
            }
          }
          structure.atoms = structure.atoms.map(atom => {
            if (!ids.has(atom.id!)) return atom;
            let point: Vector3 = positions.get(atom.id!)??[atom.x, atom.y, atom.z];
            if (command.rotation) point = builderRotate(point, command.rotation.pivot, command.rotation.axis, command.rotation.degrees * Math.PI / 180);
            if (command.delta) point = builderVector.add(point, command.delta);
            if(offsets.has(atom.id!))point=builderVector.sub(point,offsets.get(atom.id!)!);
            return { ...atom, x: point[0], y: point[1], z: point[2] };
          });
          assertFrozenCoordinatesPreserved(current, structure);
          if (command.rotation) next.attachmentPorts = (next.attachmentPorts ?? []).map(port => ids.has(port.hostAtomId) ? { ...port, direction:rotateAttachmentDirection(port.direction,command.rotation!.axis,command.rotation!.degrees) } : port);
          touched = [...ids]; next.draft.structure = refreshManualStereo(current.draft.structure, structure, touched);
          return commit(next,touched,{}, {...current.draft},false);
        }
        case 'manual-coordinates': {
          if(command.documentId!==current.id||command.expectedRevision!==current.revision)throw new Error('手工几何结果已过期或来自其它窗口。');
          if(!Array.isArray(command.atoms)||!command.atoms.length)throw new Error('手工几何原子列表无效。');
          const positions=new Map<string,Vector3>(),frozen=new Set(getFrozenAtomIds(current));
          for(const entry of command.atoms){
            const atom=structure.atoms[atomIndex(structure,entry.id)];
            if(positions.has(entry.id)||!finiteVector(entry.position))throw new Error('手工几何身份重复或坐标无效。');
            if(frozen.has(entry.id)&&entry.position.some((value,index)=>!Object.is(value,[atom.x,atom.y,atom.z][index])))throw new Error('手工几何不能改变明确冻结原子。');
            positions.set(entry.id,[...entry.position]);
          }
          touched=[...positions.keys()];
          structure.atoms=structure.atoms.map(atom=>{const p=positions.get(atom.id!);return p?{...atom,x:p[0],y:p[1],z:p[2]}:atom;});
          assertFrozenCoordinatesPreserved(current,structure);
          next.attachmentPorts=transportAttachmentPorts(next.attachmentPorts??[],current.draft.structure,structure,touched);
          next.draft.structure=refreshManualStereo(current.draft.structure,structure,touched);
          return commit(next,touched,{},undefined,false);
        }
        case 'apply-optimization-geometry': {
          if(command.documentId!==current.id||command.expectedRevision!==current.revision)throw new Error('优化期间原结构已变化，结果未覆盖当前结构。');
          const result=command.structure;
          if(result.atoms.length!==structure.atoms.length||result.atoms.some((atom,index)=>
            atom.id!==structure.atoms[index].id||atom.element!==structure.atoms[index].element||![atom.x,atom.y,atom.z].every(Number.isFinite)))
            throw new Error('优化结果的原子身份、顺序或坐标无效。');
          if(json(result.cell)!==json(structure.cell))throw new Error('优化结果的固定晶胞与原结构不一致。');
          structure.atoms=structure.atoms.map((atom,index)=>{
            const {x,y,z}=result.atoms[index];return {...atom,x,y,z};
          });
          structure.bonds=clone(result.bonds);
          structure.bondSource=result.bondSource;
          structure.bondPerceptionIssues=clone(result.bondPerceptionIssues);
          structure.charge=result.charge;structure.multiplicity=result.multiplicity;
          structure.preparation=clone(result.preparation);
          const observation=clone(command.bondOrderObservation);
          if(observation)validateOptimizationBondOrderObservation(observation,structure);
          const previous=current.draft.structure;
          next.draft.structure=refreshBuilderStereoAfterNativeChange(previous,structure,()=>graphFingerprint(previous)!==graphFingerprint(structure));
          next.attachmentPorts=transportLocalAttachmentPorts(next.attachmentPorts??[],previous,structure).ports;
          return commit(next,structure.atoms.map(atom=>atom.id!),{},undefined,false,false,true,undefined,false,{observation});
        }
        case 'infer-bonds': {
          if (command.stamp) requireStamp(command.stamp);
          const sameXtbRun=xtbRebuild?.command===command;
          if(sameXtbRun){
            const accepted=xtbRebuild!;
            xtbRebuild=undefined;
            if(current!==accepted.owner||transaction!==accepted.transaction)throw new Error('xTB优化结果已变化，原成键回执未应用。');
          }
          if (structure.periodicSource?.completeness === 'partial') throw new Error('完整晶胞缺失，不能建立周期连接；原始平移向量仍保留。');
          if (structure.cell?.pbc.some(Boolean) && !command.perceivedBonds) {
            const retained = command.mode === 'rebuild' ? (structure.bonds ?? []).filter(bond => bond.orderKnown !== false) : structure.bonds ?? [];
            const perceived = perceivePeriodicConnections({ ...structure, bonds: retained }, { allowUnconfirmedPreview: true });
            const excluded = new Set(next.deletedBonds.map(referenceKey));
            structure.bonds = perceived.bonds.filter(bond => !excluded.has(referenceKey(bondReference(structure, bond))));
            const issues = perceived.issues.filter(issue => !excluded.has(referenceKey(issue)));
            if (issues.length) structure.bondPerceptionIssues = issues; else delete structure.bondPerceptionIssues;
            structure.bondSource = retained.length ? structure.bondSource ?? 'file' : 'inferred';
            const previous=current.draft.structure;
            next.draft.structure=refreshBuilderStereoAfterNativeChange(previous,structure,()=>graphFingerprint(previous)!==graphFingerprint(structure));
            touched = structure.atoms.map(atom => atom.id!); return commit(next, touched, {}, undefined, false);
          }
          if (!command.perceivedBonds) throw new Error('请先由化学内核提供明确成键候选；未按距离伪造键型。');
          // Validate native candidates as a complete explicit graph before using them.
          const perceived = clone(command.perceivedBonds);
          validateExplicitBonds({ ...structure, bonds: perceived });
          if (command.mode === 'rebuild') { structure.bonds = perceived; next.deletedBonds = []; if(command.perceivedIssues?.length)structure.bondPerceptionIssues=clone(command.perceivedIssues);else delete structure.bondPerceptionIssues; }
          else {
            const protectedPairs = new Set([...(structure.bonds ?? []).map(bond => referenceKey(bondReference(structure, bond))), ...next.deletedBonds.map(referenceKey)]);
            const added = perceived.filter(bond => !protectedPairs.has(referenceKey(bondReference(structure, bond))));
            structure.bonds = [...(structure.bonds ?? []), ...added];
            const addedPairs = new Set(added.map(bond=>bondKey([structure.atoms[bond.a].id!,structure.atoms[bond.b].id!])));
            const deletedPairs = new Set(next.deletedBonds.map(reference=>bondKey(reference.atomIds)));
            const issues = new Map((structure.bondPerceptionIssues??[]).filter(issue=>!addedPairs.has(bondKey(issue.atomIds))).map(issue=>[bondKey(issue.atomIds),issue]));
            for(const issue of command.perceivedIssues??[])if(!deletedPairs.has(bondKey(issue.atomIds)))issues.set(bondKey(issue.atomIds),clone(issue));
            if(issues.size)structure.bondPerceptionIssues=[...issues.values()];else delete structure.bondPerceptionIssues;
          }
          const previous=current.draft.structure;
          next.draft.structure=refreshBuilderStereoAfterNativeChange(previous,structure,()=>graphFingerprint(previous)!==graphFingerprint(structure));
          touched = structure.atoms.map(atom => atom.id!); return commit(next, touched, {}, undefined, false, false, sameXtbRun);
        }
        case 'set-periodic-axes': {
          if(!structure.cell||structure.periodicSource?.completeness==='partial')throw new Error('只有完整真实晶胞才能确认三个周期轴。');
          if(!Array.isArray(command.pbc)||command.pbc.length!==3||!command.pbc.every(value=>typeof value==='boolean'))throw new Error('周期方向必须是三个明确布尔值。');
          if((structure.bonds??[]).some(bond=>bond.image?.some((value,index)=>value!==0&&!command.pbc[index])))throw new Error('当前连接引用了将关闭的周期轴；请先明确处理这些跨胞连接。');
          structure.cell={...structure.cell,pbc:[...command.pbc],pbcProvenance:{kind:'user-confirmed',evidence:command.evidence?.trim()||'用户明确确认周期轴'}};
          requireConfirmedPeriodicity(structure);touched=structure.atoms.map(atom=>atom.id!);return commit(next,touched,{},undefined,false);
        }
        case 'replace-structure': {
          const replacement = createBuilderDraft(command.structure, assignmentsOf(command.assignments));
          replacement.structure = bindImportedSourceAtomIds(replacement.structure);
          replacement.baseStructure.sourceAtomIds = clone(replacement.structure.sourceAtomIds);
          replacement.assignments = sourceAssignments(replacement.structure, command.assignments ?? {});
          if(command.assignments?.layers===undefined){
            // Authored input rows are drafts rather than inferred regions. Keep
            // their empty state across a new model; never turn it into a complement.
            // Explicit layers=[] and imported rows with the same ID still win.
            const ids=new Set(replacement.structure.atoms.map(atom=>atom.id!)), imported=new Set(replacement.assignments.layers.map(row=>row.id));
            replacement.assignments.layers.push(...current.draft.assignments.layers.filter(row=>isInputLayerDraft(row)&&!imported.has(row.id)).map(row=>({...checkedInputLayerDraft(row),atomIds:row.atomIds.filter(id=>ids.has(id))})));
          }
          next.draft = replacement; next.selection = emptySelection(); next.auxiliaryRelations = []; next.deletedBonds = []; next.attachmentPorts = [];
          const sourceState=sourceModelState(replacement.structure);
          next.internalCoordinates = sourceState.internalCoordinates;
          next.sharedConstraints=sourceState.sharedConstraints;next.coordinateObjects=sourceState.coordinateObjects;next.gaussianBoundCoordinates=undefined;next.gaussianBasisState=undefined;
          migrateCanonicalFreezes(next);
          return commit(next, replacement.structure.atoms.map(atom => atom.id!), {}, replacement,true,true);
        }
        case 'replace-document': {
          next.cellCheckpoint = clone(command.fragment.cellCheckpoint);
          const replacement = createBuilderDraft(command.fragment.structure, command.fragment.assignments);
          replacement.assignments.layers=replacement.assignments.layers.map(checkedInputLayerDraft);
          if(replacement.structure.modelLayers)replacement.structure.modelLayers=replacement.structure.modelLayers.map(checkedInputLayerDraft);
          next.draft = replacement; next.selection = emptySelection(); next.auxiliaryRelations = clone(command.fragment.auxiliaryRelations); next.deletedBonds = clone(command.fragment.deletedBonds);
          next.attachmentPorts = clone(command.fragment.attachmentPorts ?? []);
          // A FragmentSnapshot is authoritative restored model state, not a raw
          // file. Import readers already performed the source-to-ID projection.
          next.internalCoordinates = clone(command.fragment.internalCoordinates ?? []);
          next.sharedConstraints=clone(command.fragment.sharedConstraints);next.coordinateObjects=clone(command.fragment.coordinateObjects);
          next.gaussianBoundCoordinates=clone(command.fragment.gaussianBoundCoordinates);
          next.gaussianBasisState=undefined;
          if(command.electronicState==='new-source'){
            const state=reconcileElectronicStateAfterInventoryEdit(replacement.structure.atoms,replacement.structure);
            replacement.structure.charge=state.charge;replacement.structure.multiplicity=state.multiplicity;
            next.electronicStateConfirmed=false;
          }
          migrateCanonicalFreezes(next);
          validateExtras(next);
          return commit(next, replacement.structure.atoms.map(atom => atom.id!), {}, replacement,true,true);
        }
        case 'set-assignments': {
          next.draft.assignments = {...clone(command.assignments),layers:command.assignments.layers.map(checkedInputLayerDraft)};
          if(next.sharedConstraints?.canonical)next.draft.assignments.frozenAtomIds=[];
          // Current context assignments are authoritative. Source metadata must
          // not resurrect an explicitly abandoned/cleared draft on save/reload.
          // Foreign engine drafts and ordinary scientific layers stay untouched.
          const sourceRows=(structure.modelLayers??[]).map(checkedInputLayerDraft);
          const ownSource=new Map(sourceRows.filter(row=>{const role=getInputLayerDraftRole(row);return role.status==='valid'&&role.role.engine===contextScope;}).map(row=>[row.id,row]));
          const ownRows=next.draft.assignments.layers.filter(row=>{
            const role=getInputLayerDraftRole(row);return role.status==='valid'&&role.role.engine===contextScope;
          }).map(row=>{
            if(row.kind!=='qm'&&row.kind!=='middle'&&row.kind!=='mm')throw new Error('输入区域草稿理论层尚未指定，不能伪造来源层元数据。');
            const metadata={...clone(ownSource.get(row.id)),id:row.id,label:row.label??row.id,kind:row.kind,atomIds:[...row.atomIds],draftRole:clone(row.draftRole!)};
            if(row.frozen===undefined)delete metadata.frozen;else metadata.frozen=row.frozen;
            return metadata;
          });
          const pending=new Map(ownRows.map(row=>[row.id,row]));
          if(pending.size!==ownRows.length)throw new Error('输入区域草稿身份重复，不能同步来源层元数据。');
          const synchronized=sourceRows.flatMap(row=>{
            const role=getInputLayerDraftRole(row);if(role.status!=='valid'||role.role.engine!==contextScope)return[row];
            const replacement=pending.get(row.id);pending.delete(row.id);return replacement?[replacement]:[];
          });
          if(structure.modelLayers||ownRows.length)structure.modelLayers=[...synchronized,...pending.values()];
          break;
        }
        case 'set-internal-coordinates': {
          validateCoordinates(command.coordinates, structure);
          next.internalCoordinates = clone(next.sharedConstraints?.canonical?command.coordinates.filter(row=>row.action!=='freeze'):command.coordinates); return commitMetadata(next);
        }
        case 'upsert-coordinate-object': {
          validateCoordinateObject(command.object,structure);
          const old=(next.coordinateObjects??[]).find(object=>object.id===command.object.id);
          if(old&&modelCoordinateKey(old)!==modelCoordinateKey(command.object))throw new Error('已有B/A/D对象不能静默改换原子；请删除旧对象后另建。');
          next.coordinateObjects=[...(next.coordinateObjects??[]).filter(object=>object.id!==command.object.id),clone(command.object)];return commitMetadata(next);
        }
        case 'set-shared-freezes-enabled': {
          if(typeof command.enabled!=='boolean')throw new Error('共有冻结启用状态须为布尔值。');
          if((next.sharedConstraints?.enabled!==false)===command.enabled)return current;
          next.sharedConstraints={...(next.sharedConstraints??emptySharedConstraints()),enabled:command.enabled};return commitMetadata(next,undefined,!(current.sharedConstraints?.coordinates.length));
        }
        case 'set-shared-atom-freeze': {
          const ids=new Set(structure.atoms.map(atom=>atom.id));if(new Set(command.atomIds).size!==command.atomIds.length||command.atomIds.some(id=>!ids.has(id)))throw new Error('共有冻结选择含缺失或重复原子。');
          const shared=next.sharedConstraints??emptySharedConstraints();
          next.sharedConstraints={...shared,...(command.frozen&&command.atomIds.length?{enabled:true}:{}),frozenAtomIds:command.frozen?unique([...shared.frozenAtomIds,...command.atomIds]):shared.frozenAtomIds.filter(id=>!command.atomIds.includes(id))};return commitMetadata(next,undefined,true);
        }
        case 'replace-shared-atom-freezes': {
          const ids=new Set(structure.atoms.map(atom=>atom.id));if(new Set(command.atomIds).size!==command.atomIds.length||command.atomIds.some(id=>!ids.has(id)))throw new Error('冻结原子选择含缺失或重复身份。');
          next.sharedConstraints={...(next.sharedConstraints??emptySharedConstraints()),canonical:true,frozenAtomIds:[...command.atomIds]};return commitMetadata(next,undefined,true);
        }
        case 'replace-shared-coordinate-freezes': {
          if(command.coordinates.some(row=>row.action!=='freeze'))throw new Error('模型冻结事务不能提交扫描定义。');
          const result=canonicalFreezeRows(structure,command.coordinates,next.coordinateObjects);
          next.coordinateObjects=result.coordinateObjects;next.sharedConstraints={...(next.sharedConstraints??emptySharedConstraints()),canonical:true,coordinates:result.coordinates};return commitMetadata(next);
        }
        case 'set-shared-coordinate-freeze': {
          validateCoordinateObject(command.object,structure);const objects=next.coordinateObjects??[];
          const existing=objects.find(object=>object.id===command.object.id);if(existing&&modelCoordinateKey(existing)!==modelCoordinateKey(command.object))throw new Error('B/A/D对象身份已绑定另一原子路径。');
          if(command.frozen&&!existing)next.coordinateObjects=[...objects,clone(command.object)];
          const shared=next.sharedConstraints??emptySharedConstraints(),rows=shared.coordinates.filter(row=>!associatedWithObject(row,command.object));
          if(command.frozen)rows.push({id:`shared-freeze:${command.object.id}`,objectId:command.object.id,type:command.object.type,atomIds:[...command.object.atomIds],...(command.object.images?{images:clone(command.object.images)}:{}),action:'freeze',steps:1,increment:null});
          next.sharedConstraints={...shared,...(command.frozen?{enabled:true}:{}),coordinates:rows};return commitMetadata(next);
        }
        case 'clear-shared-freezes': next.sharedConstraints={...next.sharedConstraints,...emptySharedConstraints(),canonical:true};return commitMetadata(next,undefined,!(current.sharedConstraints?.coordinates.length));
        case 'delete-source-constraint': {
          if(command.scope==='gaussian'&&command.kind==='coordinate'&&next.gaussianBoundCoordinates)next.gaussianBoundCoordinates=next.gaussianBoundCoordinates.filter(row=>row.rowId!==command.id);
          if(command.scope==='shared'){
            const shared=next.sharedConstraints??emptySharedConstraints();next.sharedConstraints=command.kind==='atom'?{...shared,frozenAtomIds:shared.frozenAtomIds.filter(id=>id!==command.id)}:{...shared,coordinates:shared.coordinates.filter(row=>row.id!==command.id)};return commitMetadata(next,undefined,command.kind==='atom');
          }
          const changed=clone(contexts),context=command.scope===contextScope?{assignments:next.draft.assignments,coordinates:next.internalCoordinates??[]}:changed[command.scope];if(!context)return commitMetadata(next);
          if(command.kind==='atom')context.assignments.frozenAtomIds=context.assignments.frozenAtomIds.filter(id=>id!==command.id);else context.coordinates=context.coordinates.filter(row=>row.id!==command.id);
          if(command.scope===contextScope){next.draft.assignments=context.assignments;next.internalCoordinates=context.coordinates;}else changed[command.scope]=context;
          return commitMetadata(next,changed);
        }
        case 'delete-coordinate-object': {
          const object=coordinateSelectionObjects(next).find(row=>row.id===command.objectId);if(!object)break;
          return commitMetadata(next,removeCoordinateObjects(next,[object]));
        }
        case 'legacy': {
          // Old UI integrations can keep geometry/template commands, but graph
          // editing must still use v0.11 semantics at this single domain port.
          const old = command.command;
          if(old.type==='geometry'||old.type==='translate'||old.type==='rotate'||old.type==='reflect'||old.type==='invert-center'){
            const result=old.type==='geometry'?editBuilderGeometry(structure,old):transformBuilderSelection(structure,old.type==='invert-center'?{...old,atomIds:[old.atomId]}:old);
            assertFrozenCoordinatesPreserved(current, result.structure);
            next.draft.structure=refreshManualStereo(structure,result.structure,result.touchedIds);
            const moving=new Set(result.touchedIds);
            if(old.type==='rotate'){
              const axis:Vector3=old.axis==='x'?[1,0,0]:old.axis==='y'?[0,1,0]:[0,0,1];
              next.attachmentPorts=(next.attachmentPorts??[]).map(port=>moving.has(port.hostAtomId)?{...port,direction:rotateAttachmentDirection(port.direction,axis,old.degrees)}:port);
            }else if(old.type==='reflect'){
              const axis=old.axis==='x'?0:old.axis==='y'?1:2;
              next.attachmentPorts=(next.attachmentPorts??[]).map(port=>moving.has(port.hostAtomId)?{...port,direction:port.direction.map((v,i)=>v===0?0:i===axis?-v:v) as Vector3}:port);
            }else if(old.type==='geometry'||old.type==='invert-center'){
              next.attachmentPorts=transportAttachmentPorts(next.attachmentPorts??[],structure,result.structure,result.touchedIds);
            }
            return commit(next,result.touchedIds,{},undefined,false);
          }
          if (old.type === 'delete-atoms') return store.execute({ type: 'delete-objects', selection: { ...emptySelection(), atomIds: old.atomIds } });
          if (old.type === 'delete-bond') return store.execute({ type: 'delete-objects', selection: { ...emptySelection(), bonds: [{ kind: 'bond', atomIds: old.atomIds }] } });
          if (old.type === 'set-bond') {
            if (![1, 1.5, 2, 3, 4].includes(old.order)) throw new Error('不支持该键级。');
            return store.execute({ type: 'set-bond-order', atomIds: old.atomIds, order: old.order === 4 ? 1.5 : old.order as 1 | 1.5 | 2 | 3 });
          }
          if (old.type === 'add-atom') {
            if (old.order && old.order !== 1) throw new Error('新增初始位点请先使用单键，再明确修改键型。');
            return store.execute({ type: 'place-element', element: old.element, position: old.position, targetAtomId: old.anchorId });
          }
          if (old.type === 'change-element') {
            for (const id of old.atomIds) {
              const atom = structure.atoms[atomIndex(structure, id)];
              const result = prepareElement(structure, { type: 'place-element', element: old.element, targetAtomId: id, position: [atom.x, atom.y, atom.z] });
              structure = result.structure; touched.push(...result.touchedIds); Object.assign(createdFrom, result.createdFrom);
            }
            const previousElements = new Map(current.draft.structure.atoms.map(atom => [atom.id!, atom.element]));
            const targets = new Set(old.atomIds);
            const replaced = new Set(structure.atoms.filter(atom => targets.has(atom.id!) && previousElements.get(atom.id!) !== atom.element).map(atom => atom.id!));
            if (replaced.size) contextChanges = retireReplacement(next, replaced);
            next.draft.structure = structure; return commit(next, unique(touched), createdFrom,undefined,true,false,false,contextChanges);
          }
          if (old.type === 'add-hydrogens') throw new Error('桌面逐个加H请使用add-single-hydrogen；不调用旧全量饱和入口。');
          const result = executeBuilderCommand(clone(current.draft), command.command);
          next.draft = result;
          return commit(next, result.touchedIds, result.createdFrom, result);
        }
      }
      next.draft.structure = structure;

      return commit(next, touched, createdFrom,undefined,true,false,false,contextChanges);
      } catch (error) { scientificEditApproval = null; throw error; }
    },
    getHistoryKind: direction => { const entry = (direction === 'undo' ? past[past.length - 1] : future[0]); return entry?.kind === 'linked' ? entry.token.kind : entry?.kind ?? null; },
    getHistoryCursor:historyCursor,
    undo() {
      const frameIdentity=defaultFrameBondIdentity(current);
      if(frameIdentity){const overrides=replayFrameBondOverride(current,current,frameIdentity,'undo');if(overrides)return emit({...clone(current),frameBondOverrides:overrides});}
      scientificEditApproval = null;
      const candidate = past[past.length - 1];
      if (candidate?.kind === 'structure' && current.analysisBindingId) authorizeScientificChange(candidate.document, 'undo');
      if (linkedGroup && !linkedBypass) linkedGroup.endSelection();
      finishSelectionTransaction();
      const last = past[past.length - 1];
      if (last?.kind === 'linked') { if (linkedGroup) linkedGroup.history(last.token, 'undo'); else replayLinkedHistory(last.token, 'undo'); return current; }
      if (last?.kind === 'structure' && linkedGroup) linkedGroup.assertTopology(store, restore(last, false));
      if (last?.kind === 'selection') {
        past.pop(); future.unshift(trackHistory(selectionSnapshot(current.selection),historyEdges.get(last)));
        return restoreSelection(last);
      }
      if(runtimeEditLock)throw new Error('动态会话未停止，不能撤销结构。');
      store.endTransaction();
      const previous = past.pop(); if (!previous) return current;
      if(previous.kind==='selection') { future.unshift(trackHistory(selectionSnapshot(current.selection),historyEdges.get(previous)));return restoreSelection(previous); }
      if(previous.kind==='linked')throw new Error('关联历史边界发生变化，请重试。');
      future.unshift(trackHistory(snapshot(),historyEdges.get(previous))); const next = restore(previous);
      next.revision = current.revision + 1; next.draft.revision = next.revision; next.draft.structure.revision = next.revision;
      stamps.clear(); return emit(next);
    },
    redo() {
      const frameIdentity=defaultFrameBondIdentity(current);
      if(frameIdentity){const overrides=replayFrameBondOverride(current,current,frameIdentity,'redo');if(overrides)return emit({...clone(current),frameBondOverrides:overrides});}
      scientificEditApproval = null;
      const candidate = future[0];
      if (candidate?.kind === 'structure' && current.analysisBindingId) authorizeScientificChange(candidate.document, 'redo');
      if (linkedGroup && !linkedBypass) linkedGroup.endSelection();
      finishSelectionTransaction();
      const first = future[0];
      if (first?.kind === 'linked') { if (linkedGroup) linkedGroup.history(first.token, 'redo'); else replayLinkedHistory(first.token, 'redo'); return current; }
      if (first?.kind === 'structure' && linkedGroup) linkedGroup.assertTopology(store, restore(first, false));
      if (first?.kind === 'selection') {
        future.shift(); past.push(trackHistory(selectionSnapshot(current.selection),historyEdges.get(first)));
        return restoreSelection(first);
      }
      if(runtimeEditLock)throw new Error('动态会话未停止，不能重做结构。');
      store.endTransaction();
      const following = future.shift(); if (!following) return current;
      if(following.kind==='selection') { past.push(trackHistory(selectionSnapshot(current.selection),historyEdges.get(following)));return restoreSelection(following); }
      if(following.kind==='linked')throw new Error('关联历史边界发生变化，请重试。');
      past.push(trackHistory(snapshot(),historyEdges.get(following))); const next = restore(following);
      next.revision = current.revision + 1; next.draft.revision = next.revision; next.draft.structure.revision = next.revision;
      stamps.clear(); return emit(next);
    },
    beginRuntimeSession(options) { finishSelectionTransaction(true); runtimeActive = true; runtimeIsolated = options?.isolated === true; runtimeEditLock = !runtimeIsolated; },
    isRuntimeSessionActive() { return runtimeActive || runtimeEditLock; },
    isRuntimeEditingAllowed() { return runtimeActive && runtimeIsolated; },
    finishRuntimeSession() { finishSelectionTransaction(true); runtime = null; runtimeEditLock = false; runtimeActive = false; runtimeIsolated = false; scientificEditApproval = null; },
    acceptRuntimeFrame(frame: DynamicsFrame,sourceDocument?:ModelDocument) {
      try {

      if(sourceDocument&&sourceDocument.revision!==current.revision){
        if(!runtimePreviewSourceCurrent(sourceDocument,current)||sourceDocument.revision!==frame.stamp.revision)throw new Error('运行来源除原子冻结外已变化，旧动态结果未应用。');
        // Revalidate against the immutable run source, including its original
        // frozen coordinates. The new F metadata belongs only to the next run.
        const verified=createRuntimeModelStore(sourceDocument);
        const {movable}=requireRuntimeSourceStamp(sourceDocument,frame.stamp);
        const expected=frame.stamp.nativeMDPolicy?verified.stampNativeMD(frame.stamp.nativeMDPolicy):verified.stamp(movable);
        if(json(expected)!==json(frame.stamp))throw new Error('动态结果的启动来源或可动范围不匹配。');
        verified.beginRuntimeSession();verified.beginTransaction('runtime-source-validation');
        const accepted=verified.acceptRuntimeFrame(frame);verified.endTransaction();verified.finishRuntimeSession();
        const next=clone(current);next.draft.structure=clone(accepted.draft.structure);next.attachmentPorts=clone(accepted.attachmentPorts??[]);
        return commit(next,movable,{},undefined,true,false,true);
      }

      if(frame.schema!==1 || !frame.sessionId || !Number.isSafeInteger(frame.seq) || frame.seq<0 || !Number.isSafeInteger(frame.step) || frame.step<0 || !Number.isFinite(frame.timeFs) || frame.timeFs<0 || frame.operation!=='md')throw new Error('动态帧协议或数值身份无效。');
      const nativeMDPolicy = runtime?.nativeMDPolicy ?? stamps.get(json(frame.stamp))?.nativeMDPolicy;
      if(nativeMDPolicy)validateNativeMDFrame(frame,nativeMDPolicy);
      else if(frame.nativeMD || frame.stamp.nativeMDPolicy)throw new Error('GFN MD帧缺少当前文档注册的专用许可。');
      const ase=frame.aseMD, structure=current.draft.structure;
      if(ase&&(ase.driver!=='ase-bussi'||ase.dtFs!==2||ase.thermostat!=='Bussi'||ase.thermostatTimeConstantFs!==500
        ||ase.periodic!==Boolean(structure.cell)||!supportsMDIntegrator(ase.method,ase.periodic,'ase')))throw new Error('ASE MD积分器、方法或固定晶胞回执无效。');
      const dtFs=ase?.dtFs??nativeMDPolicy?.dtFs??1;
      if(frame.timeFs!==frame.step*dtFs)throw new Error(`MD帧时间必须对应${dtFs} fs固定步长。`);
      if(structure.periodicSource?.completeness==='partial')throw new Error('部分平移矢量来源不能接受MD结果。');
      if(structure.cell?.pbc.some(Boolean)&&!nativeMDPolicy?.periodic&&!ase?.periodic)throw new Error('周期MD需要实际固定晶胞的运行来源。');
      if (!transaction) throw new Error('动态帧必须属于已开启的单段事务。');
      if (!runtime) {
        let movable:string[];
        if(nativeMDPolicy){
          if(json(makeNativeMDStamp(current,nativeMDPolicy))!==json(frame.stamp))throw new Error('文档或约束已变化，过期GFN MD结果未应用。');
          movable=stamps.get(json(frame.stamp))!.movable;
        } else movable=requireStamp(frame.stamp);
        const coordinates=effectiveModelCoordinates(current);
        if(ase){
          if(structure.cell&&!requireConfirmedPeriodicity(structure).pbc.every(Boolean))throw new Error('固定晶胞 ASE MD需要工作模型启用 XYZ 三个周期轴。');
          if(json(movable)!==json(getMovableAtomIds(current,'all'))||json(ase.frozenAtomIds)!==json(getFrozenAtomIds(current)))throw new Error('ASE MD固定原子与当前文档冻结定义不符。');
          if(coordinates.some(row=>row.action!=='freeze'))throw new Error('ASE MD不能接管扫描定义。');
        }
        runtime={sessionId:frame.sessionId,stamp:clone(frame.stamp),nativeMDPolicy:clone(nativeMDPolicy),aseMethod:ase?.method,operation:frame.operation,seq:-1,step:-1,timeFs:-1,revision:current.revision,movable,original:clone(structure),coordinates:ase?coordinates.map(row=>resolveMDConstraint(structure,row)):coordinates};
      }
      const active=runtime;
      if(active.sessionId!==frame.sessionId || json(active.stamp)!==json(frame.stamp) || frame.operation!==active.operation || ase?.method!==active.aseMethod || frame.seq<=active.seq || frame.step<active.step || frame.timeFs<active.timeFs || current.revision!==active.revision) throw new Error('动态帧身份、操作、顺序或当前文档已失效。');
      if(frame.structure.dimension!==3 || graphFingerprint(frame.structure)!==graphFingerprint(active.original)) throw new Error('动态帧改变了原子身份、键图或电子态。');
      createBuilderDraft(frame.structure);
      const movable=new Set(active.movable), points=new Map(frame.structure.atoms.map(a=>[a.id!,a]));
      for(const atom of active.original.atoms){const point=points.get(atom.id!);if(!point || !movable.has(atom.id!) && ![Object.is(atom.x,point.x),Object.is(atom.y,point.y),Object.is(atom.z,point.z)].every(Boolean))throw new Error('动态帧改变了固定原子。');}
      const next=clone(current);next.draft.structure.atoms=next.draft.structure.atoms.map(a=>{const p=points.get(a.id!)!;return {...a,x:p.x,y:p.y,z:p.z};});
      if(!active.nativeMDPolicy)for(const coordinate of active.coordinates){
        if(coordinate.action!=='freeze')continue;
        const target=(ase?coordinate.value:undefined)??builderCoordinateValue(active.original,coordinate.type,coordinate.atomIds,coordinate.images);
        const actual=builderCoordinateValue(next.draft.structure,coordinate.type,coordinate.atomIds,coordinate.images);
        const delta=coordinate.type==='D'?Math.abs(((actual-target)%360+540)%360-180):Math.abs(actual-target);
        const distance=coordinate.type==='B';
        if((distance?delta:delta*Math.PI/180)>(distance?MODEL_CONSTRAINT_TOLERANCE.distanceAngstrom:MODEL_CONSTRAINT_TOLERANCE.angleRadians))throw new Error('动态帧改变了明确冻结的内坐标。');
      }
      const portTransport=transportLocalAttachmentPorts(next.attachmentPorts??[],current.draft.structure,next.draft.structure);
      next.attachmentPorts=portTransport.ports;
      if(active.nativeMDPolicy){
        const md=runtimeMDProvenance(frame);
        const policy=active.nativeMDPolicy;
        next.draft.structure.preparation={...(md?{forcefield:policy.method,after:frame.energyEV,unit:'eV',md}:{}),status:`${XTB_METHOD_LABELS[policy.method]} MD${policy.periodic?'（固定晶胞）':policy.protectedAtomIds.length||policy.internalConstraintMode?'（势能含保护项）':''}`};
      }
      else if(ase){
        const md=runtimeMDProvenance(frame);
        next.draft.structure.preparation={...(md?{forcefield:ase.method,after:frame.energyEV,unit:'eV',md}:{}),status:`${XTB_METHOD_LABELS[ase.method]} ASE MD${ase.periodic?'（固定晶胞）':''}`};
      }
      else if(frame.engine==='RDKit+ASE'){
        const md=runtimeMDProvenance(frame);next.draft.structure.preparation={...(md?{forcefield:frame.forcefield,after:frame.energyEV,unit:'eV',md}:{}),status:'内置力场MD'};
      }
      else next.draft.structure.preparation={forcefield:frame.forcefield,after:frame.energyEV,unit:'eV',status:'内置力场MD'};
      next.draft.structure.preparation.status=portPreparationStatus(next.draft.structure.preparation.status,portTransport.ports.length,portTransport.warnings);
      acceptingRuntime=true;
      try { const accepted=commit(next,active.movable,{},undefined,false);active.seq=frame.seq;active.step=frame.step;active.timeFs=frame.timeFs;active.revision=accepted.revision;runtimeEditLock=true;return accepted; }
      finally { acceptingRuntime=false; }
      } catch (error) { scientificEditApproval = null; throw error; }
    },
    acceptXtbCoordinates(result,sourceDocument,optimizedBonds){
      try {

      if(runtimeEditLock)throw new Error('动态会话未停止，不能提交xTB坐标结果。');
      const ownerTransaction=transaction;
      let movable:string[],next:ModelDocument;
      if(sourceDocument&&sourceDocument.revision!==current.revision){
        if(!runtimePreviewSourceCurrent(sourceDocument,current)||sourceDocument.revision!==result.request.stamp.revision)throw new Error('运行来源除原子冻结外已变化，旧xTB结果未应用。');
        ({movable}=requireRuntimeSourceStamp(sourceDocument,result.request.stamp));
        if(json(makeDocumentStamp(sourceDocument,movable))!==json(result.request.stamp))throw new Error('xTB结果的启动来源或可动范围不匹配。');
        const accepted=applyXtbCoordinates(sourceDocument,result,movable);
        next=clone(current);next.draft.structure=clone(accepted.draft.structure);next.attachmentPorts=clone(accepted.attachmentPorts??[]);
      }else{
        movable=requireStamp(result.request.stamp);
        next=applyXtbCoordinates(current,result,movable);
      }
      if(optimizedBonds){
        const request=result.request,structure=optimizedBonds.structure;
        requireStamp(optimizedBonds.stamp);
        if(!ownerTransaction||request.structure.cell||request.method==='gfnff'||optimizedBonds.operation!=='perceive-bonds'
          ||optimizedBonds.bondPerceptionPolicy!=='composite-v1'||!Array.isArray(structure.bonds)
          ||structure.charge!==request.charge||structure.multiplicity!==request.uhf!+1
          ||json(structure.atoms)!==json(next.draft.structure.atoms))throw new Error('成键回执与本次xTB优化的事务、电子态或坐标不匹配。');
      }
      next.draft.structure=refreshBuilderStereoAfterNativeChange(current.draft.structure,next.draft.structure);
      const accepted=commit(next,movable,{},undefined,false,false,true);
      if(!optimizedBonds)return accepted;
      if(current!==next||transaction!==ownerTransaction)throw new Error('xTB优化结果已变化，原成键回执未应用。');
      const command={type:'infer-bonds',mode:'rebuild',aggression:'standard',perceivedBonds:optimizedBonds.structure.bonds,
        perceivedIssues:optimizedBonds.structure.bondPerceptionIssues} as const;
      // The exact private command consumes the receipt within this call.
      // A later user rebuild follows the normal preparation lifecycle.
      xtbRebuild={command,owner:accepted,transaction:ownerTransaction!};
      try{return store.execute(command);}finally{xtbRebuild=undefined;}
      } catch (error) { scientificEditApproval = null; throw error; }
    },
    acceptXtbStoppedCoordinates(result,sourceDocument){
      try {

      if(runtimeEditLock)throw new Error('动态会话未停止，不能提交xTB停止帧。');
      if(sourceDocument&&sourceDocument.revision!==current.revision){
        if(!runtimePreviewSourceCurrent(sourceDocument,current)||sourceDocument.revision!==result.request.stamp.revision)throw new Error('运行来源除原子冻结外已变化，旧xTB停止帧未应用。');
        const {movable}=requireRuntimeSourceStamp(sourceDocument,result.request.stamp);
        if(json(makeDocumentStamp(sourceDocument,movable))!==json(result.request.stamp))throw new Error('xTB停止帧的启动来源或可动范围不匹配。');
        const accepted=applyXtbStoppedCoordinates(sourceDocument,result,movable),next=clone(current);next.draft.structure=clone(accepted.draft.structure);next.attachmentPorts=clone(accepted.attachmentPorts??[]);
        next.draft.structure=refreshBuilderStereoAfterNativeChange(current.draft.structure,next.draft.structure);
        return commit(next,movable,{},undefined,false,false,true);
      }
      const movable=requireStamp(result.request.stamp),next=applyXtbStoppedCoordinates(current,result,movable);
      next.draft.structure=refreshBuilderStereoAfterNativeChange(current.draft.structure,next.draft.structure);
      return commit(next,movable,{},undefined,false,false,true);
      } catch (error) { scientificEditApproval = null; throw error; }
    },
    publishBondOrders(result,stamp,runId){

      if(runtimeEditLock)throw new Error('运行尚未结束，不能发布MBO。');
      requireStamp(stamp);
      activeBondOrders=bondOrderObservation(result,current.draft.structure,runId);
      return emit(clone(current));
    },
    clearBondOrders(){
      if(!activeBondOrders&&!current.bondOrderObservation)return;
      activeBondOrders=undefined;emit(clone(current));
    },
    acceptCoordinates(result: ChemistryResult, sourceStereo) {
      try {

      if(runtimeEditLock)throw new Error('动态会话未停止，不能提交其它化学结果。');
      if (result.operation !== 'generate3d') throw new Error('该化学结果不是坐标事务。');
      if (current.draft.structure.cell?.pbc.some(Boolean)) throw new Error('周期结构不进行全体系三维重建。');
      const movable = requireStamp(result.stamp);
      if (json([...result.movableAtomIds].sort()) !== json([...movable].sort())) throw new Error('内核返回的可动原子集合不匹配。');
      const incoming = result.structure, original = current.draft.structure;
      if (incoming.dimension !== 3 || incoming.bonds === undefined || graphFingerprint(incoming) !== graphFingerprint(original)) throw new Error('内核结果未保持完整原子身份、键图、晶胞或电子态。');
      createBuilderDraft(incoming); // finite coordinates, unique identities, structural checks
      const movableSet = new Set(movable), coordinates = new Map(incoming.atoms.map(atom => [atom.id!, atom]));
      for (const atom of original.atoms) {
        const point = coordinates.get(atom.id!);
        if (!point || !movableSet.has(atom.id!) && ![Object.is(atom.x, point.x), Object.is(atom.y, point.y), Object.is(atom.z, point.z)].every(Boolean)) throw new Error('内核改变了固定原子坐标，整份结果已拒绝。');
      }
      const next = clone(current);
      next.draft.structure.atoms = next.draft.structure.atoms.map(atom => {
        const point = coordinates.get(atom.id!)!; return { ...atom, x: point.x, y: point.y, z: point.z };
      });
      next.draft.structure.dimension = 3;
      next.draft.structure.preparation = { status: 'ETKDGv3 初始三维结构' };
      for (const coordinate of effectiveModelCoordinates(current)) {
        if (coordinate.action !== 'freeze') continue;
        const before = builderCoordinateValue(original, coordinate.type, coordinate.atomIds);
        const after = builderCoordinateValue(next.draft.structure, coordinate.type, coordinate.atomIds);
        const difference = coordinate.type === 'D' ? Math.abs(((after - before + 540) % 360) - 180) : Math.abs(after - before);
        const residual = coordinate.type === 'B' ? difference : difference * Math.PI / 180;
        const tolerance = coordinate.type === 'B' ? MODEL_CONSTRAINT_TOLERANCE.distanceAngstrom : MODEL_CONSTRAINT_TOLERANCE.angleRadians;
        if (residual > tolerance) throw new Error('内核改变了明确冻结的内坐标，整份结果已拒绝。');
      }
      if(original.dimension===2)assertBuilder2DStereoPreserved(original,next.draft.structure,sourceStereo);
      else assertBuilderStereoPreserved(original,next.draft.structure);
      const portTransport=transportLocalAttachmentPorts(next.attachmentPorts??[],original,next.draft.structure);
      next.attachmentPorts=portTransport.ports;
      next.draft.structure.preparation!.status=portPreparationStatus(next.draft.structure.preparation!.status,portTransport.ports.length,portTransport.warnings,result.warnings);
      return commit(next, movable, {}, undefined, true, original.dimension===2, true);
      } catch (error) { scientificEditApproval = null; throw error; }
    },
    copy(scope) {

      if(scope==='selection'&&!current.selection.atomIds.length)throw new Error('复制选区需要先选择原子。');
      if(scope!=='all'&&current.selection.portIds?.length&&!current.selection.atomIds.length)throw new Error('复制待接端口需要同时选择其宿主原子。');
      if (scope!=='all'&&!current.selection.atomIds.length && (current.selection.bonds.length || current.selection.auxiliaryIds.length)) throw new Error('仅选键对象的复制尚未定义；请明确选择要复制的原子。');
      const structure = current.draft.structure;
      const ids = new Set(scope!=='all'&&current.selection.atomIds.length ? current.selection.atomIds : structure.atoms.map(atom => atom.id!));
      const complete = ids.size === structure.atoms.length;
      const fragment: FragmentSnapshot = { structure: subsetStructure(structure, [...ids]), assignments: clippedAssignments(current.draft.assignments, ids),
        auxiliaryRelations: clone(current.auxiliaryRelations.filter(relation => ids.has(relation.a) && ids.has(relation.b))), deletedBonds: clone(current.deletedBonds.filter(reference => reference.atomIds.every(id => ids.has(id)))),
        attachmentPorts: clone((current.attachmentPorts ?? []).filter(port => ids.has(port.hostAtomId))),
        internalCoordinates: clone((current.internalCoordinates ?? []).filter(coordinate => coordinate.atomIds.every(id => ids.has(id)))),
        ...(current.sharedConstraints?{sharedConstraints:clone(retainSharedConstraints(current.sharedConstraints,ids))}:{}),
        ...(current.coordinateObjects?{coordinateObjects:clone(current.coordinateObjects.filter(object=>object.atomIds.every(id=>ids.has(id))))}:{}),
        ...(current.gaussianBoundCoordinates?{gaussianBoundCoordinates:clone(current.gaussianBoundCoordinates.filter(row=>row.atomIds.every(id=>ids.has(id))))}:{}) };
      if(!complete){
        // A selection cut has a real leaving direction even if the user did
        // not break the source bond first. These ports exist only in the copy.
        const used=new Set<string>([...structure.atoms.map(atom=>atom.id!),...(current.attachmentPorts??[]).map(port=>port.id),...(current.coordinateObjects??[]).map(object=>object.id),...(current.internalCoordinates??[]).flatMap(row=>row.id?[row.id]:[]),...(current.sharedConstraints?.coordinates??[]).flatMap(row=>row.id?[row.id]:[]),...(current.gaussianBoundCoordinates??[]).map(row=>row.rowId),...current.auxiliaryRelations.map(row=>row.id)]);
        const periodicSelection=Boolean(structure.cell?.pbc.some(Boolean));
        if(periodicSelection)fragment.structure.notes.push(periodicSelectionNote(structure,current.id,[...ids]));
        for(const bond of structure.bonds??[]){
          const a=structure.atoms[bond.a],b=structure.atoms[bond.b];if(ids.has(a.id!)===ids.has(b.id!))continue;
          // Framework selection cuts are finite source facts. Coordination or
          // unknown-order edges cannot become invented covalent graft ports.
          if(periodicSelection&&(bond.kind==='coordination'||bond.orderKnown===false||![1,1.5,2,3,4].includes(bond.order)))continue;
          if(bond.kind==='coordination')throw new Error('复制选区边界含配位键，尚不能将其转为普通接枝端口。');
          const order=(bond.aromatic||bond.order===4?1.5:bond.order) as 1|1.5|2|3;
          if(![1,1.5,2,3].includes(order))throw new Error('复制选区边界键级不能表示为接入端口。');
          let direction:Vector3=[b.x-a.x,b.y-a.y,b.z-a.z];
          if(bond.image?.some(Boolean)){
            const cell=structure.cell;
            if(!cell||bond.image.some((value,index)=>!Number.isInteger(value)||value!==0&&!cell.pbc[index])||cell.vectors.length!==3||cell.vectors.some(vector=>vector.length!==3||!vector.every(Number.isFinite)))throw new Error('复制选区的跨胞边界需要完整晶胞和明确有效映像，未猜测周期方向。');
            for(let axis=0;axis<3;axis++)direction=builderVector.add(direction,builderVector.scale(cell.vectors[axis],bond.image[axis]));
          }
          // Missing image denotes the explicit same-cell bond, as elsewhere in
          // the model graph. Never infer or replace it with a minimum image.
          if(ids.has(b.id!))direction=builderVector.scale(direction,-1);
          const length=Math.hypot(...direction);if(!Number.isFinite(length)||length<1e-8)throw new Error('复制选区的边界键方向退化，不能生成接入端口。');
          let id=newModelId();while(used.has(id))id=newModelId();used.add(id);
          fragment.attachmentPorts!.push({id,hostAtomId:ids.has(a.id!)?a.id!:b.id!,direction:builderVector.scale(direction,1/length).map(value=>value===0?0:value) as Vector3,order,displayLength:.8});
        }
        validateAttachmentPorts(fragment.attachmentPorts,fragment.structure);
      }
      if (!complete) { fragment.structure.charge = null; fragment.structure.multiplicity = null; }
      return clone({ schema: 'sciyue-model-fragment', version: 1, sourceDocumentId: current.id, fragment });
    },
    paste(payload: ClipboardPayload, policy: PastePolicy = {}) {
      try {
      if(runtimeEditLock)throw new Error('动态会话未停止，不能粘贴结构。');
      if (payload.schema !== 'sciyue-model-fragment' || payload.version !== 1) throw new Error('不支持该模型剪贴板版本。');
      let source = clone(payload.fragment);const target = current.draft.structure;

      source.assignments.layers=source.assignments.layers.map(checkedInputLayerDraft);
      if(source.structure.modelLayers)source.structure.modelLayers=source.structure.modelLayers.map(checkedInputLayerDraft);
      let sourceDraft = createBuilderDraft(source.structure, source.assignments);
      // Metadata validation must not silently clip malformed clipboard references.
      const sourceIds = new Set(sourceDraft.structure.atoms.map(atom => atom.id!));
      for (const category of ['layers', 'basis', 'fragments'] as const) for (const entry of source.assignments[category]) if (entry.atomIds.some(id => !sourceIds.has(id))) throw new Error('剪贴板区域引用了缺失原子。');
      if (source.assignments.layers.some(layer => layer.frozen !== undefined && typeof layer.frozen !== 'boolean')) throw new Error('剪贴板层冻结标记必须是布尔值。');
      if (source.assignments.frozenAtomIds.some(id => !sourceIds.has(id))) throw new Error('剪贴板冻结引用了缺失原子。');
      validateCoordinates(source.internalCoordinates ?? [], sourceDraft.structure);
      validateSharedConstraints(source.sharedConstraints??emptySharedConstraints(),source.coordinateObjects??[],sourceDraft.structure);
      validateGaussianBoundCoordinates(source.gaussianBoundCoordinates??[],source.coordinateObjects??[],sourceDraft.structure);
      validateAttachmentPorts(source.attachmentPorts,sourceDraft.structure);
      const migrated={...clone(current),draft:sourceDraft,internalCoordinates:source.internalCoordinates,sharedConstraints:source.sharedConstraints,coordinateObjects:source.coordinateObjects};
      migrateCanonicalFreezes(migrated);source.assignments=migrated.draft.assignments;source.internalCoordinates=migrated.internalCoordinates;source.sharedConstraints=migrated.sharedConstraints;source.coordinateObjects=migrated.coordinateObjects;
      const conflicts: PasteConflict[] = [];
      // Empty/cleared input drafts are editable metadata, not a conflicting
      // scientific region. Preserve them, while keeping the ordinary overlap,
      // duplicate, foreign-member and empty science/basis/fragment checks.
      const conflictAssignments={...source.assignments,layers:source.assignments.layers.filter(row=>row.atomIds.length||!isInputLayerDraft(row))};
      const assignmentIssues=createBuilderDraft(source.structure,conflictAssignments).assignmentIssues;
      if (assignmentIssues.length) conflicts.push({ kind: 'assignments', message: `剪贴板区域有真实冲突：${assignmentIssues.join(' ')}` });
      for (const category of ['layers', 'basis', 'fragments'] as const) {
        const ids = source.assignments[category].map(entry => entry.id);
        if (unique(ids).length !== ids.length) conflicts.push({ kind: 'assignments', message: `剪贴板${category}区域身份重复，不能无歧义合并。` });
      }
      let extraction:PeriodicAppendExtraction|undefined;
      if(target.atoms.length&&target.cell?.pbc.some(Boolean)&&policy.cell===undefined){
        const normalized=preparePeriodicAppendFragment(source,payload.sourceDocumentId,target.cell);
        source=normalized.fragment;extraction=normalized.extraction;sourceDraft=createBuilderDraft(source.structure,source.assignments);
      }
      const cellKey = (structure: Structure) => structure.cell ? json([structure.cell.vectors, structure.cell.pbc, structure.cell.origin ?? [0, 0, 0]]) : 'null';
      const sameCell = cellKey(sourceDraft.structure) === cellKey(target);
      const anyCell = !!sourceDraft.structure.cell || !!target.cell;
      if (target.atoms.length && anyCell && !sameCell && (!policy.cell || policy.cell === 'require-compatible')) conflicts.push({ kind: 'cell', message: '源与目标晶胞不同，请明确晶胞保留策略；尚未粘贴。' });
      const sourceCrosses = sourceDraft.structure.bonds?.some(bond => bond.image?.some(Boolean));
      const targetCrosses = target.bonds?.some(bond => bond.image?.some(Boolean));
      if (target.atoms.length && !sameCell && sourceCrosses && policy.cell === 'keep-target' || policy.cell === 'omit' && (sourceCrosses || targetCrosses) || target.atoms.length && !sameCell && targetCrosses && policy.cell === 'use-source') conflicts.push({ kind: 'cell', message: '跨晶胞连接不能在更换/去除晶胞时直接解释；请先明确提取或使用兼容晶胞。' });
      if (conflicts.length) throw new ModelConflictError(conflicts);
      const offset = policy.offset ?? [0, 0, 0]; if (!finiteVector(offset)) throw new Error('粘贴位移必须有限。');
      const next = clone(current), structure = next.draft.structure;
      const idMap = new Map(sourceDraft.structure.atoms.map(atom => [atom.id!, newModelId()]));
      const objectMap=new Map((source.coordinateObjects??[]).map(object=>[object.id,newModelId()]));
      const rowMap=new Map<string,string>();const remapRow=(id?:string)=>{if(!id)return newModelId();if(!rowMap.has(id))rowMap.set(id,newModelId());return rowMap.get(id)!;};
      const remapId = (id: string): string => { const mapped = idMap.get(id); if (!mapped) throw new Error('剪贴板引用了未复制对象。'); return mapped; };
      const initialCount = structure.atoms.length;
      structure.atoms.push(...sourceDraft.structure.atoms.map(atom => ({ ...clone(atom), id: remapId(atom.id!), x: atom.x + offset[0], y: atom.y + offset[1], z: atom.z + offset[2] })));
      if (!initialCount && structure.atoms.length) {
        const { charge, multiplicity } = sourceDraft.structure;
        const validSource = charge !== null && multiplicity !== null && !electronicStateError(structure.atoms, charge, multiplicity);
        structure.charge = validSource ? charge : 0;
        structure.multiplicity = validSource ? multiplicity : suggestedMultiplicity(structure.atoms, 0);
        next.electronicStateConfirmed = false;
      }
      if(extraction)structure.notes.push(periodicAppendNote(extraction,Object.fromEntries(idMap)));
      structure.bonds = [...(structure.bonds ?? []), ...(sourceDraft.structure.bonds ?? []).map(bond => ({ ...clone(bond), a: bond.a + initialCount, b: bond.b + initialCount }))];
      if(sourceDraft.structure.bondPerceptionIssues?.length)structure.bondPerceptionIssues=[...(structure.bondPerceptionIssues??[]),...sourceDraft.structure.bondPerceptionIssues.map(issue=>({...clone(issue),atomIds:issue.atomIds.map(remapId) as [string,string]}))];
      if (!initialCount || policy.cell === 'use-source') structure.cell = clone(sourceDraft.structure.cell);
      if (policy.cell === 'omit') structure.cell = undefined;
      structure.layout2D = { ...structure.layout2D, ...Object.fromEntries(Object.entries(sourceDraft.structure.layout2D ?? {}).map(([id, point]) => [remapId(id), { x: point.x + offset[0], y: point.y + offset[1] }])) };
      // Clone all layer metadata (including frozen) while assigning new identities.
      for (const category of ['layers', 'basis', 'fragments'] as const) next.draft.assignments[category].push(...source.assignments[category].map(entry => ({ ...clone(entry), id: newModelId(), atomIds: entry.atomIds.map(remapId) })));
      next.draft.assignments.frozenAtomIds.push(...source.assignments.frozenAtomIds.map(remapId));
      structure.groups = [...(structure.groups ?? []), ...(sourceDraft.structure.groups ?? []).map(group => ({ ...clone(group), atomIds: group.atomIds.map(remapId) }))];
      structure.modelLayers = [...(structure.modelLayers ?? []), ...(sourceDraft.structure.modelLayers ?? []).map(layer => ({ ...clone(layer), id: newModelId(), atomIds: layer.atomIds.map(remapId) }))];
      next.auxiliaryRelations.push(...source.auxiliaryRelations.map(relation => ({ ...clone(relation), id: newModelId(), a: remapId(relation.a), b: remapId(relation.b) })));
      next.attachmentPorts = [...(next.attachmentPorts ?? []), ...(source.attachmentPorts ?? []).map(port => ({...clone(port),id:newModelId(),hostAtomId:remapId(port.hostAtomId)}))];
      next.deletedBonds.push(...source.deletedBonds.map(reference => ({ ...clone(reference), atomIds: [remapId(reference.atomIds[0]), remapId(reference.atomIds[1])] as [string, string] })));
      const remapCoordinate=(coordinate:ModelCoordinate):ModelCoordinate=>({...clone(coordinate),id:remapRow(coordinate.id),atomIds:coordinate.atomIds.map(remapId),...(coordinate.objectId?{objectId:objectMap.get(coordinate.objectId)}:{})});
      next.internalCoordinates = [...(next.internalCoordinates ?? []), ...(source.internalCoordinates ?? []).map(remapCoordinate)];
      if(source.coordinateObjects?.length)next.coordinateObjects=[...(next.coordinateObjects??[]),...source.coordinateObjects.map(object=>({...clone(object),id:objectMap.get(object.id)!,atomIds:object.atomIds.map(remapId)}))];
      if(source.sharedConstraints){const shared=next.sharedConstraints??emptySharedConstraints(),enabled=sharedFreezeEnabledForMerge(shared,source.sharedConstraints);next.sharedConstraints={...shared,...(enabled===undefined?{}:{enabled}),canonical:true,frozenAtomIds:[...shared.frozenAtomIds,...source.sharedConstraints.frozenAtomIds.map(remapId)],coordinates:[...shared.coordinates,...source.sharedConstraints.coordinates.map(remapCoordinate)]};}
      if(source.gaussianBoundCoordinates?.length)next.gaussianBoundCoordinates=[...(next.gaussianBoundCoordinates??[]),...source.gaussianBoundCoordinates.map(row=>({...clone(row),rowId:remapRow(row.rowId),objectId:objectMap.get(row.objectId)!,atomIds:row.atomIds.map(remapId)}))];
      next.selection = emptySelection();

      validateExtras(next);
      return commit(next, [...idMap.values()]);
      } catch (error) { scientificEditApproval = null; throw error; }
    },
    markApplied() {
      finishSelectionTransaction();
      baseline = { structure: clone(current.draft.structure), assignments: clone(current.draft.assignments), content: dirtyContentKey(current) };
      emit(clone(current));
    },
    markSaved(snapshot) {
      if(snapshot.id!==current.id)throw new Error('保存点不属于当前模型文档。');
      const content=dirtyContentKey(snapshot);
      if(baseline.content===content)return;
      baseline={structure:clone(snapshot.draft.structure),assignments:clone(snapshot.draft.assignments),content};
      emit(clone(current));
    },
  };
  const access: LinkedStoreAccess = {
    store,
    attach(group) { if (group && linkedGroup && linkedGroup !== group) throw new Error('模型已属于另一个关联组。'); linkedGroup = group; },
    group: () => linkedGroup,
    assertEditable() { if (runtimeEditLock || transaction) throw new Error('关联成员仍在运行或有未结束的建模事务；整组操作未提交。'); },
    checkpoint() {
      const savedTransaction = transaction ? clone(transaction) : null;
      if(savedTransaction&&transaction)trackHistory(savedTransaction,historyEdges.get(transaction));
      const savedCursor=historyCursor();
      const copyEntry = (entry: HistoryEntry): HistoryEntry => entry === transaction ? savedTransaction! : entry;
      const saved = { current, contexts: clone(contexts), contextScope, past: past.map(copyEntry), future: future.map(copyEntry),
        transaction: savedTransaction, transactionChanged, selectionTransaction: selectionTransaction ? { ...selectionTransaction, previousFuture: [...selectionTransaction.previousFuture] } : null,
        runtime: clone(runtime), stamps: new Map(stamps), activeBondOrders, publicationPending };
      return {
        rollback() { current = saved.current; contexts = saved.contexts; contextScope = saved.contextScope; past = saved.past; future = saved.future;
          scientificEditApproval = null;
          transaction = saved.transaction; transactionChanged = saved.transactionChanged; selectionTransaction = saved.selectionTransaction;
          runtime = saved.runtime; stamps.clear(); saved.stamps.forEach((value, key) => stamps.set(key, value)); activeBondOrders = saved.activeBondOrders; publicationPending = saved.publicationPending; },
        install(token) { const previous=saved.past.find(entry=>entry.kind==='linked'&&entry.token===token);const linked=previous??trackHistory<LinkedHistoryEntry>({kind:'linked',token},{before:savedCursor,after:Symbol('model-history')});past = [...saved.past.filter(entry => entry.kind !== 'linked' || entry.token !== token), linked]; future = []; selectionTransaction = null; publicationPending = true; },
        restoreFuture() { future = [...saved.future]; publicationPending = true; },
      };
    },
    replay(kind) {return access.replayProject(kind==='structure'?snapshot():{kind:'selection',selection:clone(current.selection)});},
    replayProject(state) {
      const saved=clone(state);if(saved.kind==='structure'){saved.document.draft.past=[];saved.document.draft.future=[];delete saved.document.bondOrderObservation;}
      const replay=(operation:'undo'|'redo'='undo')=>{
        if(saved.kind==='selection'){const next=clone(current);next.selection=clone(saved.selection);emit(next);return;}
        const next=restore(saved,false);authorizeScientificChange(next,operation);contexts=clone(saved.contexts);next.revision=current.revision+1;next.draft.revision=next.revision;next.draft.structure.revision=next.revision;
        runtime=null;stamps.clear();emit(next);
      };
      projectReplayStates.set(replay,saved);return replay;
    },
    replaceProjectToken(previous,next){
      const replace=(entry:HistoryEntry):HistoryEntry=>entry.kind==='linked'&&entry.token===previous?trackHistory<LinkedHistoryEntry>({kind:'linked',token:next},historyEdges.get(entry)):entry;
      past=past.map(replace);future=future.map(replace);
    },
    top(direction) { const entry = direction === 'undo' ? past[past.length - 1] : future[0]; return entry?.kind === 'linked' ? entry.token : null; },
    move(token, direction) {
      if (direction === 'undo') { const entry=past.pop();if(entry)future.unshift(entry); }
      else { const entry=future.shift();if(entry)past.push(entry); }
    },
    discard(token) { past = past.filter(entry => entry.kind !== 'linked' || entry.token !== token); publicationPending = true; },
    batch(begin, publish = true) {
      if (begin) { publicationDepth++; return; }
      if (publish && publicationDepth === 1 && publicationPending) emit(clone(current));
      publicationDepth--;
      if (!publicationDepth && publicationPending) { publicationPending = false; for (const listener of [...listeners]) listener(); }
    },
    call(operation) { linkedBypass++; try { return operation(); } finally { linkedBypass--; } },
    apply(next, kind) {
      // An aligned peer never transfers ownership of its result association.
      if (current.analysisBindingId === undefined) delete next.analysisBindingId;
      else next.analysisBindingId = current.analysisBindingId;
      if (topologyKey(next.draft.structure) !== topologyKey(current.draft.structure) || coordinatesFingerprint(next.draft.structure) !== coordinatesFingerprint(current.draft.structure)) throw new Error('关联投影不能改变科学结构、键连或坐标。');
      const removed = (current.coordinateObjects ?? []).filter(object => !(next.coordinateObjects ?? []).some(row => row.id === object.id));
      if (removed.length) contexts = removeCoordinateObjects(next, removed);
      if (kind === 'selection') { next = { ...clone(current), selection: clone(next.selection) }; emit(next); }
      else {
        if (next.draft.structure.charge !== current.draft.structure.charge || next.draft.structure.multiplicity !== current.draft.structure.multiplicity) clearBondEvidence(next.draft.structure);
        commitIdentityMetadata(next);
      }
    },
  };
  // Capture at public command boundaries, so retries rebuild the same complete
  // transaction (including engine contexts) instead of storing a partial draft.
  let commandDepth = 0;
  const methods = ['execute', 'executeBatch', 'paste', 'setElectronicState', 'acceptCoordinates', 'acceptXtbCoordinates', 'acceptXtbStoppedCoordinates'] as const;
  for (const method of methods) {
    const original = store[method]; if (!original) continue;
    const wrapped = (...args: unknown[]) => {
      const outer = commandDepth++ === 0;
      if (outer) { rejectedRequest = null; pendingEdit = null; }
      const projectedBase = outer ? scientificEditBase : null;
      const projectedSelection = outer ? scientificEditBaseSelection : null;
      const projectedFrame=outer?scientificEditFrame:null;
      if (outer) { scientificEditBase = null; scientificEditBaseSelection = null; scientificEditFrame=null; }
      const captured = clone(args);
      try {
        // Result display edits have a separate owner/history from scientific
        // model commits. The scratch command can derive display annotations,
        // but only its graph fields are retained, never its atoms or q/M.
        const frameIdentity=projectedFrame?.identity??(!projectedBase?defaultFrameBondIdentity(current):undefined);
        const commands=method==='execute'?[args[0] as ModelCommand]:method==='executeBatch'?args[0] as ModelCommand[]:undefined;
        const frameSelection=projectedSelection??current.selection;
        if(commands?.length&&frameIdentity&&commands.every(command=>isFrameBondCommand(command,frameSelection))){
          const raw=clone(projectedFrame?.document??current);
          if(projectedBase)raw.draft.structure=clone(projectedBase);
          const shown=clone(applyFrameBondOverride(current,raw,frameIdentity));
          shown.selection=clone(frameSelection);shown.draft.selectedIds=[...frameSelection.atomIds];
          delete shown.analysisBindingId;delete shown.frameBondOverrides;
          const scratch=createRuntimeModelStore(shown);
          if(method==='executeBatch')scratch.executeBatch!(clone(commands),args[1] as string|undefined);else scratch.execute(clone(commands[0]));
          const overrides=recordFrameBondOverride(current,raw,frameIdentity,scratch.getSnapshot());
          if(overrides===current.frameBondOverrides)return current;
          return emit({...clone(current),frameBondOverrides:overrides});
        }
        if (projectedBase && ['execute', 'executeBatch', 'paste', 'setElectronicState'].includes(method)) {
          const projectedDocument = clone(current); projectedDocument.draft.structure = clone(projectedBase);
          if (projectedSelection) { projectedDocument.selection = clone(projectedSelection); projectedDocument.draft.selectedIds = [...projectedSelection.atomIds]; }
          const scratch = createRuntimeModelStore(projectedDocument);
          for (const scope of ['gaussian', 'orca'] as const) if (contexts[scope]) scratch.synchronizeContext(clone(contexts[scope].assignments), clone(contexts[scope].coordinates), scope);
          scratch.synchronizeContext(clone(current.draft.assignments), clone(current.internalCoordinates ?? []), contextScope);
          (scratch[method] as (...values: unknown[]) => unknown)(...clone(args));
          const candidate = scratch.getSnapshot();
          // Metadata belongs to the working document and does not adopt a
          // trajectory/vibration display frame or revoke a wavefunction.
          if (analysisGeometryChanged(projectedBase, candidate.draft.structure)) {
            const next = clone(candidate); next.id = current.id;
            const changedContexts: Record<string, Context> = {};
            for (const scope of ['gaussian', 'orca'] as const) { const context = scratch.getContext(scope); if (context) changedContexts[scope] = clone(context); }
            return commit(next, next.draft.structure.atoms.map(atom => atom.id!), {}, clone(next.draft), false, false, true, changedContexts, true);
          }
          if (contentKey(candidate) === contentKey(projectedDocument)) return current;
        }
        return (original as (...values: unknown[]) => unknown)(...args);
      }
      catch (error) {
        if (outer && error instanceof ScientificEditCancelledError && rejectedRequest?.operation === 'edit') {
          const request = rejectedRequest;
          pendingEdit = { request, base:clone(projectedBase??current.draft.structure), replay(target,validateCopy) {
            const targetDocument = target.getSnapshot();
            const rebind = (value: unknown): unknown => {
              if (Array.isArray(value)) return value.map(rebind);
              if (!value || typeof value !== 'object') return value;
              return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, key === 'documentId' && part === request.documentId ? targetDocument.id : (key === 'expectedRevision' || key === 'revision' && 'documentId' in value) && part === request.revision ? targetDocument.revision : rebind(part)]));
            };
            if (projectedBase) target.setScientificEditBase?.(clone(projectedBase), projectedSelection ? clone(projectedSelection) : undefined);
            const result=(target[method] as (...values: unknown[]) => unknown)(...(target === store ? clone(captured) : captured.map(rebind)));
            validateCopy?.(target.getSnapshot());
            return result;
          } };
        }
        throw error;
      } finally { commandDepth--; }
    };
    (store as unknown as Record<string, unknown>)[method] = wrapped;
  }
  scientificResultTargets.set(store,(source,candidate,label,origin)=>{
    if(runtimeEditLock||transaction)throw new Error('请先结束目标模型的编辑或独占运行，再接收科学结果。');
    if(candidate.id!==source.id||json(candidate.draft.structure.atoms.map(atom=>[atom.id,atom.element]))!==json(source.draft.structure.atoms.map(atom=>[atom.id,atom.element])))
      throw new Error('科学结果原子身份或顺序与已签发来源不一致。');
    if(origin!==store){
      if(current.analysisBindingId||analysisGeometryChanged(source.draft.structure,current.draft.structure))throw new Error('科学结果目标不是原静态帧的独立副本。');
      if(json(effectiveModelConstraints(origin.getSnapshot()))!==json(effectiveModelConstraints(current)))throw new Error('科学结果目标的当前约束与原文档不一致。');
    }
    const checkpoint=access.checkpoint(),next=clone(current);
    next.draft.structure=clone(candidate.draft.structure);next.attachmentPorts=clone(candidate.attachmentPorts??[]);
    const previousAccepting=acceptingScientificResult;acceptingScientificResult=true;publicationDepth++;
    try{
      store.beginTransaction(label);
      commit(next,next.draft.structure.atoms.map(atom=>atom.id!),{},undefined,true,true,true);
      if(candidate.bondOrderObservation){activeBondOrders=clone(candidate.bondOrderObservation);emit(clone(current));}
      store.endTransaction();return current;
    }catch(error){const rejected=rejectedRequest;checkpoint.rollback();rejectedRequest=rejected;throw error;}
    finally{acceptingScientificResult=previousAccepting;publicationDepth--;if(!publicationDepth&&publicationPending){publicationPending=false;for(const listener of [...listeners])listener();}}
  });
  linkedStoreAccess.set(store, access);
  current = freeze(current);
  return store;
}

/** Private-task document with identical issued identity but independent state/history. */
export function createRuntimeModelStore(source: ModelDocument): ModelStore {
  const runtimeStore = createModelStore(source.draft.structure, source.draft.assignments, source.internalCoordinates ?? [], source, source.analysisBindingId, source);
  runtimeStore.setScientificEditGuard?.(() => true);
  return runtimeStore;
}
