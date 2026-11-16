import type { SharedModelConstraints } from '../contracts';
import { captureAdvancedFrame, type AdvancedFrameSource } from '../advanced/frame-source';
import type { WorkspaceInputTask, WorkspaceModule } from '../workspace-contracts';
import type { WorkspaceProjectDocument, WorkspaceProjectState } from '../workspace-registry';
import type { ProjectAssetReader, ProjectAssetWriter } from '../../projects/desktop-bridge';
import { validateCoordinates } from '../../core/modeling/model-document-validation';
import { validateBondSemantics } from '../../core/bond-semantics';
import { prepareAdvancedFrameInputs, type AdvancedInputTemplate, type AdvancedFrameOutputPlan } from './advanced-frame-output';
import { projectCanonicalGaussianFreezes, projectCanonicalOrcaFreezes } from './canonical-freezes';

export interface BatchInputSession {
  id: string;
  sources: readonly AdvancedFrameSource[];
  coreIds: readonly string[];
  representativeFrameId: string;
}
export interface BorrowedBatchInput {
  session: BatchInputSession;
  documentId: string;
  documentEpoch: string;
  previousViewId: string | null;
  previousModule: WorkspaceModule;
  previousDocumentId?: string;
  previousDocumentEpoch?: string;
  previousFrameId?: string;
  input: { taskId: string; documentId: string; previous: WorkspaceInputTask | null };
  camera?: number[];
}

const batchAssetSchema = 'sciyue-borrowed-batch-input/v1';
const assetIdPattern = /^[a-f0-9]{64}$/;
const modules = new Set<WorkspaceModule>(['modeling', 'advanced-modeling', 'input', 'advanced', 'analysis', 'plot']);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
const sameInputOwner = (left: WorkspaceInputTask | null, right: WorkspaceInputTask | null) =>
  Boolean(left && right && left.id === right.id && left.documentId === right.documentId);

export async function writeBorrowedBatchInput(batch: BorrowedBatchInput, writer: Pick<ProjectAssetWriter, 'write'>): Promise<string> {
  const result = await writer.write('models', 'batch-input-session.json', JSON.stringify({ schema: batchAssetSchema, batch }));
  if (!assetIdPattern.test(result.assetId)) throw Error('批量输入配置资产回执无效。');
  return result.assetId;
}

interface BorrowedBatchInputRestore {
  registry: WorkspaceProjectState;
  batch: BorrowedBatchInput | null;
  notice?: string;
  unreadableAsset?: string;
}

/** Decode against the same saved registry graph before either owner mounts.
 * Losing an optional batch asset only disables that batch. */
export async function restoreBorrowedBatchInput(value: unknown, registry: WorkspaceProjectState,
  reader: ProjectAssetReader): Promise<BorrowedBatchInputRestore> {
  if (value == null && !registry.borrowedInputTask) return { registry, batch: null };
  const assetId = typeof value === 'string' && assetIdPattern.test(value) ? value : undefined;
  try {
    if (!assetId) throw Error('项目缺少批量输入配置资产。');
    const bytes = await reader.read(assetId);
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (payload?.schema !== batchAssetSchema) throw Error('批量输入配置版本无法读取。');
    return { registry, batch: hydrateBorrowedBatchInput(payload.batch, registry) };
  } catch {
    const notice = value == null && registry.borrowedInputTask
      ? '旧项目未保存批量输入的帧列表，批量配置不可恢复。模型和输入草稿已保留，可分别打开。'
      : '此项目的批量输入配置不可恢复。模型和输入草稿已保留，可分别打开。';
    return { registry: releaseIncompleteBorrow(registry), batch: null,
      notice,
      ...(assetId ? { unreadableAsset: assetId } : {}) };
  }
}

function projectTaskIsValid(task: WorkspaceInputTask | null | undefined, documents: ReadonlyMap<string, WorkspaceProjectDocument>): task is WorkspaceInputTask {
  const owner = task ? documents.get(task.documentId) : undefined;
  return Boolean(task && identity(task.id) && identity(task.documentId) && nonNegativeInteger(task.activationEpoch)
    && owner && !owner.attachments?.result);
}

function releaseIncompleteBorrow(registry: WorkspaceProjectState): WorkspaceProjectState {
  const borrowed = registry.borrowedInputTask;
  if (!borrowed) return registry;
  const documents = new Map(registry.documents.map(document => [document.id, document]));
  const tasks = new Map(registry.documentInputTasks.map(task => [task.documentId, task]));
  // Old saves may have the borrowed owner only in inputTask. Keep its identity
  // so the representative can still open its own ordinary G/O drafts.
  if (projectTaskIsValid(borrowed, documents) && !tasks.has(borrowed.documentId)) tasks.set(borrowed.documentId, borrowed);
  const previous = projectTaskIsValid(registry.previousInputTask, documents)
    && registry.previousInputTask.documentId !== borrowed.documentId ? registry.previousInputTask : null;
  if (previous && !tasks.has(previous.documentId)) tasks.set(previous.documentId, previous);
  const savedView = registry.views.find(view => view.id === registry.activeViewId);
  const previousView = savedView?.documentId === borrowed.documentId && previous
    ? registry.views.find(view => view.documentId === previous.documentId && view.kind === 'tab')
      ?? registry.views.find(view => view.documentId === previous.documentId)
    : undefined;
  const activeView = previousView ?? savedView;
  const ordinary = activeView ? tasks.get(activeView.documentId) : undefined;
  return {
    ...registry, borrowedInputTask: null, previousInputTask: previous,
    documentInputTasks: [...tasks.values()], inputTask: projectTaskIsValid(ordinary, documents) ? ordinary : null,
    activeViewId: activeView?.id ?? registry.activeViewId, module: activeView?.module ?? registry.module,
  };
}

function hydrateBorrowedBatchInput(value: BorrowedBatchInput, registry: WorkspaceProjectState): BorrowedBatchInput {
  const documents = new Map(registry.documents.map(document => [document.id, document]));
  const borrowed = registry.borrowedInputTask;
  if (!value || !value.input || !projectTaskIsValid(borrowed, documents) || !sameInputOwner(borrowed, registry.inputTask)
    || value.documentId !== borrowed.documentId || value.input.documentId !== borrowed.documentId || value.input.taskId !== borrowed.id
    || documents.get(value.documentId)?.epoch !== value.documentEpoch
    || registry.documentInputTasks.some(task => task.documentId === borrowed.documentId && !sameInputOwner(task, borrowed))
    || !registry.views.some(view => view.documentId === value.documentId))
    throw Error('批量输入代表帧或输入任务归属无效。');

  const session = value.session;
  if (!session || !identity(session.id) || !Array.isArray(session.sources) || !session.sources.length
    || !Array.isArray(session.coreIds) || !identity(session.representativeFrameId))
    throw Error('批量输入候选不完整。');
  const sources = session.sources.map(restoreBatchSource);
  const refKeys = sources.map(({ ref }) => JSON.stringify([ref.documentId, ref.documentEpoch, ref.revision, ref.sourceId,
    ref.sourceRevision, ref.taskId, ref.runId, ref.stageId, ref.collectionId, ref.frameId, ref.sourceFrameIndex]));
  if (new Set(refKeys).size !== sources.length) throw Error('批量输入候选来源重复。');
  const selected = sources.filter(source => source.ref.frameId === session.representativeFrameId);
  if (selected.length !== 1 && !(selected.length === 0 && session.representativeFrameId === 'first' && sources[0].ref.frameId === undefined))
    throw Error('批量输入代表帧身份无法核对。');
  const representative = selected[0] ?? sources[0];
  assertBatchAtomOrder(sources, representative.structure.atoms);
  assertBatchAtomOrder([representative], documents.get(value.documentId)!.model.document.draft.structure.atoms);
  const atomIds = new Set(representative.structure.atoms.map(atom => atom.id));
  if (new Set(session.coreIds).size !== session.coreIds.length || session.coreIds.some(id => !identity(id) || !atomIds.has(id)))
    throw Error('批量输入保护核心与候选原子不匹配。');

  if (!modules.has(value.previousModule)
    || (value.previousViewId !== null && !identity(value.previousViewId))
    || (value.previousDocumentId !== undefined && (!identity(value.previousDocumentId) || !identity(value.previousDocumentEpoch) || value.previousDocumentId === value.documentId))
    || (value.previousDocumentId === undefined && (value.previousDocumentEpoch !== undefined || value.previousViewId !== null || value.previousFrameId !== undefined))
    || (value.previousFrameId !== undefined && !identity(value.previousFrameId)))
    throw Error('批量输入返回位置无效。');
  const previousDocument = value.previousDocumentId ? documents.get(value.previousDocumentId) : undefined;
  const previousView = registry.views.find(view => view.id === value.previousViewId);
  if ((previousDocument && previousDocument.epoch !== value.previousDocumentEpoch)
    || (previousView && previousView.documentId !== value.previousDocumentId))
    throw Error('批量输入返回视图的归属已变化。');

  let previous = value.input.previous;
  if (previous !== null) {
    if (!previous || !identity(previous.id) || !identity(previous.documentId) || previous.documentId === value.documentId || !nonNegativeInteger(previous.activationEpoch))
      throw Error('批量输入的原输入任务身份无效。');
    if (!documents.has(previous.documentId)) previous = null;
    else if (!projectTaskIsValid(previous, documents) || !registry.documentInputTasks.some(task => sameInputOwner(task, previous)))
      throw Error('批量输入的原输入任务归属已变化。');
  }
  const camera = Array.isArray(value.camera) && value.camera.length === 8 && value.camera.every(Number.isFinite)
    && Math.hypot(...value.camera.slice(4)) >= 1e-10 ? value.camera : undefined;
  return freeze({ ...value, session: { ...session, sources }, input: { ...value.input, previous }, camera });
}

function restoreBatchSource(source: AdvancedFrameSource): AdvancedFrameSource {
  const structure = source?.structure;
  if (source?.coordinateUnit !== 'angstrom' || !identity(source.label) || !identity(source.ref?.documentId)
    || !identity(source.ref.documentEpoch) || !['graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'].every(key =>
      typeof source.stamp?.[key as keyof typeof source.stamp] === 'string')
    || !structure || typeof structure.id !== 'string' || typeof structure.name !== 'string' || typeof structure.format !== 'string'
    || !Array.isArray(structure.notes) || structure.notes.some(note => typeof note !== 'string')
    || !Array.isArray(structure.atoms) || structure.atoms.some(atom => !identity(atom?.id) || !identity(atom.element))
    || !Array.isArray(source.constraints?.coordinates) || !Array.isArray(source.constraints.frozenAtomIds)
    || (source.constraints.enabled !== undefined && typeof source.constraints.enabled !== 'boolean')
    || (source.constraints.canonical !== undefined && source.constraints.canonical !== true))
    throw Error('批量输入候选的来源、单位或结构无效。');
  for (const key of ['sourceId', 'sourceRevision', 'taskId', 'runId', 'stageId', 'collectionId', 'frameId'] as const)
    if (source.ref[key] !== undefined && !identity(source.ref[key])) throw Error('批量输入候选的来源身份无效。');
  if (structure.bonds !== undefined) {
    if (!Array.isArray(structure.bonds)) throw Error('批量输入候选的连接无效。');
    for (const bond of structure.bonds) {
      if (!bond || !nonNegativeInteger(bond.a) || !nonNegativeInteger(bond.b) || bond.a >= structure.atoms.length || bond.b >= structure.atoms.length)
        throw Error('批量输入候选的连接原子无效。');
      validateBondSemantics(bond, structure);
    }
  }
  validateCoordinates(source.constraints.coordinates, structure);
  return snapshotBatchSource(source);
}
const gaussianTasks = new Set(['sp','opt','freq','optfreq','constrained','ts','td','tdopt','t1opt','nmr','stable']);
const orcaTasks = new Set(['sp','opt','freq','optfreq','ts','td','tdopt','nmr','stable']);
export function batchInputTaskAllowed(engine:'gaussian'|'orca', task:string):boolean {
  return (engine === 'gaussian' ? gaussianTasks : orcaTasks).has(task);
}
function freeze<T>(value:T):T {
  if(value && typeof value==='object' && !Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;
}
function snapshotBatchSource(source: AdvancedFrameSource): AdvancedFrameSource {
  const captured = captureAdvancedFrame(source.structure, source.ref, source.stamp, source.label, source.constraints);
  return source.samplingPreparation ? freeze({ ...captured, samplingPreparation: structuredClone(source.samplingPreparation) }) : captured;
}
function assertBatchAtomOrder(sources: readonly AdvancedFrameSource[], reference: AdvancedFrameSource['structure']['atoms']): void {
  for (const [index, source] of sources.entries()) {
    const atoms = source.structure.atoms;
    if (atoms.length !== reference.length || atoms.some((atom, i) => atom.id !== reference[i].id || atom.element !== reference[i].element))
      throw Error(`第${index + 1}项原子身份或顺序与本批不兼容。`);
  }
}
export function createBatchInputSession({sources,coreIds=[],activeFrameId}:{sources:readonly AdvancedFrameSource[];coreIds?:readonly string[];activeFrameId?:string}):BatchInputSession {
  if(!sources.length)throw new Error('请先选择需要产生输入文件的优化结果。');
  const snapshots=sources.map(snapshotBatchSource);
  const reference=snapshots[0].structure.atoms;
  assertBatchAtomOrder(snapshots,reference);
  const ids=new Set(reference.map(atom=>atom.id!));
  if(coreIds.some(id=>!ids.has(id)))throw new Error('保护核心与本批原子身份不匹配。');
  const representative=snapshots.find(source=>source.ref.frameId===activeFrameId)??snapshots[0];
  return freeze({id:crypto.randomUUID(),sources:snapshots,coreIds:[...new Set(coreIds)],representativeFrameId:representative.ref.frameId??'first'});
}
export function batchInputRepresentative(session:BatchInputSession):AdvancedFrameSource {
  return session.sources.find(source=>source.ref.frameId===session.representativeFrameId)??session.sources[0];
}
export function batchInputInitialConstraints(session:BatchInputSession):SharedModelConstraints {
  return {canonical:true,enabled:true,frozenAtomIds:[...new Set([...session.coreIds,...session.sources.flatMap(source=>source.constraints.frozenAtomIds)])],coordinates:[]};
}
/** One confirmed shared configuration, but each member keeps its own scientific coordinates. */
export function prepareBatchInputPlan(session:BatchInputSession, template:AdvancedInputTemplate, constraints:SharedModelConstraints):AdvancedFrameOutputPlan {
  if(!batchInputTaskAllowed(template.engine,template.request.settings.task))throw new Error('批量模式仅支持可共享设置的单结构任务。');
  const reference=template.request.structure?.atoms;
  if(!reference)throw new Error('代表帧结构已失效。');
  for(const [index,source] of session.sources.entries())if(source.structure.atoms.length!==reference.length||source.structure.atoms.some((atom,i)=>atom.id!==reference[i].id||atom.element!==reference[i].element))throw new Error(`第${index+1}项与代表帧的原子身份或顺序不匹配。`);
  const frozenAtomIds=[...constraints.frozenAtomIds];
  const clean:SharedModelConstraints={canonical:true,enabled:constraints.enabled!==false,frozenAtomIds,coordinates:[]};
  template=structuredClone(template);
  if(template.engine==='gaussian'){
    template.request.settings=projectCanonicalGaussianFreezes(template.request.structure,template.request.settings,clean);
    if(template.request.settings.taskOptions){template.request.settings.taskOptions.coordinates=[];template.request.settings.taskOptions.coordinateDrafts=[];}
  }else{template.request.settings=projectCanonicalOrcaFreezes(template.request.structure,template.request.settings,clean);template.request.settings.constraints=[];}
  return prepareAdvancedFrameInputs({template,manifestStem:`${template.request.name}-inputs`,independentRuntimeNames:true,
    frames:session.sources.map((source,index)=>({source:{...source,constraints:clean},stem:`${template.request.name}-${String(index+1).padStart(3,'0')}`,electronicState:{charge:template.request.charge,multiplicity:template.request.multiplicity,confirmed:template.request.electronicStateConfirmed===true}}))});
}
