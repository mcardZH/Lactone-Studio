import { electronicStateError } from '../../core/elements';
import { buildGaussian, previewGaussian } from '../../core/gaussian';
import { makeDocumentStamp } from '../../core/modeling/model-store';
import {
  buildOrcaCommon,
  type OrcaAsset,
  type OrcaJobRequest,
  type OrcaOutputFile
} from '../../core/orca';
import { referencedOrcaAssets } from '../../core/orca/assets';
import type { InputStructureSource, JobRequest, Structure } from '../../core/types';
import { isConformerAlpbSupported } from '../../modeling/advanced/conformer-solvation';
import { AdvancedController } from '../../modeling/advanced/controller';
import type {
  AdvancedOptimizationStageConfig,
  AdvancedTaskRecord,
  AdvancedTaskRun
} from '../../modeling/advanced/contracts';
import { captureAdvancedFrame, type AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import {
  applySharedGaussianConstraints,
  captureDesktopAssignments,
  captureGaussianCoordinates,
  integrateDesktopBuilderResult
} from '../../modeling/application/gaussian-bridge';
import {
  applySharedOrcaConstraints,
  captureOrcaAssignments,
  captureOrcaCoordinates,
  integrateOrcaBuilderResult
} from '../../modeling/application/orca-bridge';
import { orcaGeneratedSource } from '../../modeling/application/orca-generated-draft';
import {
  readProjectInputDrafts,
  restoredOrcaProjectRequest
} from '../../modeling/application/project-input-draft';
import {
  formalInputStructure,
  projectSessionModel
} from '../../modeling/application/session-projection';
import {
  projectGaussianTaskStructure,
  projectOrcaTaskStructure
} from '../../modeling/application/task-structure-projection';
import { createChemistryPort } from '../../modeling/chemistry';
import {
  createConformerSnapshot,
  discoverConformerTorsionRows,
  inspectConformerTorsion,
  type TorsionAtoms
} from '../../modeling/conformers';
import type { ConformerResultCollection } from '../../modeling/conformers/trajectory';
import { effectiveModelConstraints } from '../../modeling/constraints';
import type { ChemistryPort, ModelDocument, ModelStore } from '../../modeling/contracts';
import type { WorkspaceDocumentEntry } from '../../modeling/workspace-registry';
import type { XtbBridge, XtbMethod, XtbSolvation } from '../../modeling/xtb/contracts';
import { XtbController, type XtbOptions, type XtbState } from '../../modeling/xtb/controller';
import { convertEnergy } from '../../results/energy';
import type {
  EnvironmentView,
  SubmitTaskRequest,
  TaskCardView,
  TaskCategory,
  TaskDetailView,
  TaskFileView,
  TaskMonitorView,
  TaskSystemBridge
} from '../../task-system/application-contracts';
import {
  gaussianExternalInputDraft,
  orcaExternalInputDraft,
  type ExternalInputDraft
} from '../../task-system/integration/input-draft';
import { stageExternalInput } from '../../task-system/integration/stage-input';
import {
  buildConformerResultCollections,
  conformerTerminalResultCollection
} from '../advanced/AdvancedWorkspace';
import {
  compileMixedDefinition,
  compileMixedStages,
  createMixedConformerDraft,
  createMixedSamplingCard,
  createMixedTaskSpec
} from '../advanced/mixed-conformer-draft';
import { advancedMethodSolvents } from '../advanced/solvation';
import { jobSignature } from '../application/input-presentation';
import { defaultFilters, filterTasks } from '../task-system/presentation';
import {
  patchSubmissionResource,
  readSubmissionResources,
  submissionRestrictionMessage
} from '../task-system/submission-resources';
import { releaseSubmissionDependencies } from '../task-system/submission-state';

export type LocalXtbCalculation = 'singlepoint' | 'optimize' | 'conformer-search';
export type SubmitTaskMode = 'open-dialog' | 'auto-submit';
export type TaskManageAction =
  | 'list-tasks'
  | 'task-detail'
  | 'read-log'
  | 'stop-task'
  | 'list-environments';

export interface RunLocalXtbParams {
  calculation: LocalXtbCalculation;
  method?: XtbMethod;
  solvent?: string;
  solvationModel?: 'alpb' | 'gbsa';
  maxSteps?: number;
  rebuildBonds?: boolean;
  maxCandidates?: number;
  pointsPerTorsion?: number;
  timeoutSeconds?: number;
}

export interface SubmitTaskParams {
  engine?: 'gaussian' | 'orca';
  mode?: SubmitTaskMode;
  environmentId?: string;
  taskName?: string;
  cores?: number;
  memoryGB?: number;
}

export interface TaskManageParams {
  action: TaskManageAction;
  taskId?: string;
  tailLines?: number;
  category?: TaskCategory;
  artifactId?: string;
}

const GAS_PHASE_SOLVENT_TOKENS = new Set([
  '',
  'none',
  'gas',
  'gasphase',
  'gas-phase',
  'vacuum',
  '气相',
  '真空',
  '无'
]);

const XTB_SOLVENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  water: 'water',
  h2o: 'water',
  水: 'water',
  acetone: 'acetone',
  propanone: 'acetone',
  丙酮: 'acetone',
  acetonitrile: 'acetonitrile',
  mecn: 'acetonitrile',
  ch3cn: 'acetonitrile',
  乙腈: 'acetonitrile',
  aniline: 'aniline',
  苯胺: 'aniline',
  benzaldehyde: 'benzaldehyde',
  苯甲醛: 'benzaldehyde',
  benzene: 'benzene',
  苯: 'benzene',
  ch2cl2: 'ch2cl2',
  dcm: 'ch2cl2',
  dichloromethane: 'ch2cl2',
  methylenechloride: 'ch2cl2',
  二氯甲烷: 'ch2cl2',
  chcl3: 'chcl3',
  chloroform: 'chcl3',
  trichloromethane: 'chcl3',
  氯仿: 'chcl3',
  三氯甲烷: 'chcl3',
  cs2: 'cs2',
  carbondisulfide: 'cs2',
  二硫化碳: 'cs2',
  dioxane: 'dioxane',
  '1,4-dioxane': 'dioxane',
  '14-dioxane': 'dioxane',
  二氧六环: 'dioxane',
  '1,4-二氧六环': 'dioxane',
  dmf: 'dmf',
  dimethylformamide: 'dmf',
  'n,n-dimethylformamide': 'dmf',
  'n,n-二甲基甲酰胺': 'dmf',
  dmso: 'dmso',
  dimethylsulfoxide: 'dmso',
  二甲基亚砜: 'dmso',
  ethanol: 'ethanol',
  etoh: 'ethanol',
  c2h5oh: 'ethanol',
  乙醇: 'ethanol',
  ether: 'ether',
  diethylether: 'ether',
  ethylether: 'ether',
  乙醚: 'ether',
  ethylacetate: 'ethylacetate',
  etoac: 'ethylacetate',
  乙酸乙酯: 'ethylacetate',
  furane: 'furane',
  furan: 'furane',
  呋喃: 'furane',
  hexadecane: 'hexadecane',
  'n-hexadecane': 'hexadecane',
  十六烷: 'hexadecane',
  正十六烷: 'hexadecane',
  hexane: 'hexane',
  'n-hexane': 'hexane',
  己烷: 'hexane',
  正己烷: 'hexane',
  methanol: 'methanol',
  meoh: 'methanol',
  ch3oh: 'methanol',
  甲醇: 'methanol',
  nitromethane: 'nitromethane',
  ch3no2: 'nitromethane',
  硝基甲烷: 'nitromethane',
  octanol: 'octanol',
  '1-octanol': 'octanol',
  'n-octanol': 'octanol',
  辛醇: 'octanol',
  正辛醇: 'octanol',
  woctanol: 'woctanol',
  'wet-octanol': 'woctanol',
  wetoctanol: 'woctanol',
  湿辛醇: 'woctanol',
  phenol: 'phenol',
  苯酚: 'phenol',
  toluene: 'toluene',
  methylbenzene: 'toluene',
  甲苯: 'toluene',
  thf: 'thf',
  tetrahydrofuran: 'thf',
  四氢呋喃: 'thf'
});

export function resolveXtbSolvation(options: {
  calculation: LocalXtbCalculation;
  method: XtbMethod;
  solvent?: string;
  solvationModel?: 'alpb' | 'gbsa';
  isPeriodic: boolean;
}): XtbSolvation | undefined {
  const rawSolvent = typeof options.solvent === 'string' ? options.solvent.trim() : '';
  const compactKey = rawSolvent.toLowerCase().replace(/\s+/g, '');

  if (!rawSolvent || GAS_PHASE_SOLVENT_TOKENS.has(compactKey)) {
    if (options.solvationModel !== undefined && !rawSolvent) {
      throw Object.assign(
        new Error('指定 solvationModel 时必须同时提供有效的 solvent 溶剂名称。'),
        { code: 'MCP_INVALID_XTB_SOLVATION' }
      );
    }
    return undefined;
  }

  if (options.isPeriodic) {
    throw Object.assign(
      new Error('xTB 隐式溶剂模型仅支持非周期孤立分子结构，周期晶胞体系请使用气相计算。'),
      { code: 'MCP_INVALID_XTB_SOLVATION' }
    );
  }

  if (options.method === 'gfn0') {
    throw Object.assign(
      new Error('GFN0-xTB 不支持隐式溶剂参数化，请改用 gfn2、gfn1 或 gfnff，或使用气相计算。'),
      { code: 'MCP_INVALID_XTB_SOLVATION' }
    );
  }

  const model: 'alpb' | 'gbsa' = options.solvationModel ?? 'alpb';
  if (model !== 'alpb' && model !== 'gbsa') {
    throw Object.assign(
      new Error('solvationModel 必须为 "alpb" 或 "gbsa"。'),
      { code: 'MCP_INVALID_XTB_SOLVATION' }
    );
  }

  if (options.calculation === 'conformer-search' && model !== 'alpb') {
    throw Object.assign(
      new Error('构象搜索（conformer-search）仅支持气相或 ALPB 隐式溶剂模型，不支持 GBSA。'),
      { code: 'MCP_INVALID_XTB_SOLVATION' }
    );
  }

  if (options.method === 'gfnff' && model !== 'alpb') {
    throw Object.assign(
      new Error('GFN-FF 仅支持 ALPB 隐式溶剂模型，不支持 GBSA。'),
      { code: 'MCP_INVALID_XTB_SOLVATION' }
    );
  }

  const canonical = XTB_SOLVENT_ALIASES[compactKey] ?? compactKey;
  const supported = advancedMethodSolvents(options.method, model);
  if (!supported.includes(canonical)) {
    throw Object.assign(
      new Error(
        `方法 ${options.method.toUpperCase()} (${model.toUpperCase()}) 不支持溶剂 "${rawSolvent}"。支持的溶剂包括：${supported.join(', ')}。`
      ),
      { code: 'MCP_INVALID_XTB_SOLVATION' }
    );
  }

  if (options.calculation === 'conformer-search' && !isConformerAlpbSupported(options.method, canonical)) {
    throw Object.assign(
      new Error(
        `构象搜索方法 ${options.method.toUpperCase()} 不支持 ALPB 溶剂 "${canonical}"。`
      ),
      { code: 'MCP_INVALID_XTB_SOLVATION' }
    );
  }

  return {
    model,
    solvent: canonical
  };
}

export function resolveValidatedElectronicState(doc: ModelDocument): {
  charge: number;
  multiplicity: number;
} {
  const structure = doc.draft.structure;
  if (doc.analysisBindingId && (structure.charge == null || structure.multiplicity == null)) {
    throw Object.assign(
      new Error('当前分析绑定文档缺少明确的电荷或自旋多重度，请先复制为建模页并设置电子态。'),
      { code: 'MCP_ELECTRONIC_STATE_REQUIRED' }
    );
  }
  const charge = Number.isSafeInteger(structure.charge) ? structure.charge! : 0;
  const multiplicity = Number.isSafeInteger(structure.multiplicity) && structure.multiplicity! >= 1
    ? structure.multiplicity!
    : 1;
  const err = electronicStateError(structure.atoms, charge, multiplicity);
  if (err) {
    throw Object.assign(
      new Error(`当前模型电子态（charge=${charge}, multiplicity=${multiplicity}）不合法：${err}`),
      { code: 'MCP_INVALID_ELECTRONIC_STATE' }
    );
  }
  return { charge, multiplicity };
}

export function formatXtbSinglepointOrOptimizeOutcome(
  documentId: string,
  doc: ModelDocument,
  calculation: 'singlepoint' | 'optimize',
  method: XtbMethod,
  xtbState: XtbState
) {
  if (xtbState.retainedResult || xtbState.retainedBondResult) {
    throw Object.assign(
      new Error('xTB 运行期间目标文档被切换或结构被手动修改，结果未写入当前模型；请保持目标文档激活且不修改结构后重试。'),
      { code: 'MCP_XTB_DETACHED_BY_EDIT' }
    );
  }
  const metadata = xtbState.metadata;
  if (!metadata) {
    const reason = xtbState.error || xtbState.status || 'xTB 未返回有效收敛结果。';
    throw Object.assign(
      new Error(`本机 xTB 计算未完成收敛：${reason}`),
      { code: 'MCP_XTB_FAILED' }
    );
  }

  const structure = doc.draft.structure;
  const atomIndexById = new Map<string, number>();
  structure.atoms.forEach((atom, idx) => {
    if (atom.id) atomIndexById.set(atom.id, idx + 1);
  });

  const wibergBondOrders = (metadata.bondOrders?.entries ?? []).map(entry => {
    const idx1 = atomIndexById.get(entry.atomIds[0]) ?? null;
    const idx2 = atomIndexById.get(entry.atomIds[1]) ?? null;
    const el1 = idx1 ? structure.atoms[idx1 - 1]?.element ?? '' : '';
    const el2 = idx2 ? structure.atoms[idx2 - 1]?.element ?? '' : '';
    return {
      atom1: idx1,
      atom2: idx2,
      element1: el1,
      element2: el2,
      order: Number(entry.value.toFixed(6))
    };
  });

  const warnings: string[] = [];
  if (metadata.bondOrdersWarning?.message) warnings.push(metadata.bondOrdersWarning.message);
  if (metadata.trajectoryWarning?.message) warnings.push(metadata.trajectoryWarning.message);
  if (xtbState.error && !warnings.includes(xtbState.error)) warnings.push(xtbState.error);

  const energyKcalMol = convertEnergy(
    { value: metadata.energyHartree, unit: 'hartree' },
    'kcal/mol'
  );

  return {
    documentId,
    revision: doc.revision,
    calculation,
    method: metadata.method,
    engine: metadata.engine,
    version: metadata.version,
    converged: metadata.converged,
    energyHartree: metadata.energyHartree,
    ...(energyKcalMol !== null ? { energyKcalMol: Number(energyKcalMol.toFixed(6)) } : {}),
    ...(metadata.iterations !== undefined ? { iterations: metadata.iterations } : {}),
    ...(metadata.sccIterations !== undefined ? { sccIterations: metadata.sccIterations } : {}),
    charge: metadata.charge,
    uhf: metadata.uhf,
    ...(metadata.solvation ? { solvation: metadata.solvation } : {}),
    ...(metadata.trajectory ? { trajectory: metadata.trajectory } : {}),
    bondCount: structure.bonds?.length ?? 0,
    wibergBondOrders,
    atoms: structure.atoms.map((atom, idx) => ({
      index: idx + 1,
      id: atom.id ?? `atom-${idx + 1}`,
      element: atom.element,
      x: Number(atom.x.toFixed(8)),
      y: Number(atom.y.toFixed(8)),
      z: Number(atom.z.toFixed(8))
    })),
    ...(warnings.length ? { warnings } : {}),
    status: xtbState.status
  };
}

export async function runStandaloneXtbCalculation(options: {
  store: ModelStore;
  bridge: Partial<XtbBridge> | null;
  chemistry?: ChemistryPort;
  calculation: 'singlepoint' | 'optimize';
  xtbOptions: XtbOptions;
  timeoutSeconds?: number;
}): Promise<XtbState> {
  const controller = new XtbController({
    store: options.store,
    bridge: options.bridge,
    chemistry: options.chemistry ?? createChemistryPort(),
    allowWorkingEdits: true,
    confirmConstraints: () => true,
    assertCurrent: () => {}
  });
  let timedOut = false;
  const deadlineTimer = options.timeoutSeconds && options.timeoutSeconds > 0
    ? setTimeout(() => {
        timedOut = true;
        void controller.stop().catch(() => {});
      }, options.timeoutSeconds * 1000)
    : undefined;
  try {
    const effectiveOptions: XtbOptions = {
      ...options.xtbOptions,
      ...(options.timeoutSeconds !== undefined ? { maxWallTimeSeconds: options.timeoutSeconds } : {})
    };
    await controller.run(effectiveOptions, options.calculation, 'rebuild');
    if (timedOut) {
      await controller.stop().catch(() => {});
      throw Object.assign(
        new Error(`本机 xTB 计算超过超时限制（${options.timeoutSeconds} 秒），已自动终止子进程。`),
        { code: 'MCP_XTB_TIMEOUT' }
      );
    }
    return controller.getSnapshot();
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    controller.disconnect();
  }
}

export interface ConformerSearchExecutionContext {
  entry: WorkspaceDocumentEntry;
  controller?: AdvancedController | null;
  bridge?: Partial<XtbBridge> | null;
  chemistry?: ChemistryPort;
  computeResources?: { threads: number; memoryBudgetBytes: number } | null;
  bindTaskToWorkspace?: (taskId: string, source: AdvancedFrameSource) => void;
  readInitialSource?: (taskId: string) => AdvancedFrameSource;
  openResultCollection?: (collection: ConformerResultCollection, frameId?: string) => void | Promise<void>;
}

export async function executeMcpConformerSearch(
  context: ConformerSearchExecutionContext,
  params: {
    method: XtbMethod;
    solvation?: XtbSolvation;
    maxSteps: number;
    maxCandidates: number;
    pointsPerTorsion: number;
    timeoutSeconds?: number;
  }
) {
  const { entry } = context;
  const doc = entry.store.getSnapshot();
  const structure = doc.draft.structure;

  if (structure.cell) {
    throw Object.assign(
      new Error('构象搜索（conformer-search）仅支持非周期孤立三维分子结构。'),
      { code: 'MCP_PERIODIC_NOT_SUPPORTED' }
    );
  }
  const constraints = effectiveModelConstraints(doc);
  if (constraints.coordinates.some(row => row.action !== 'freeze')) {
    throw Object.assign(
      new Error('构象搜索不执行内坐标扫描（scan），请先移除扫描坐标或改为 freeze。'),
      { code: 'MCP_CONFORMER_SCAN_UNSUPPORTED' }
    );
  }

  const electronic = resolveValidatedElectronicState(doc);
  if (structure.charge !== electronic.charge || structure.multiplicity !== electronic.multiplicity || !doc.electronicStateConfirmed) {
    entry.store.setElectronicState(electronic.charge, electronic.multiplicity, true);
  }

  const updatedDoc = entry.store.getSnapshot();
  const initialSource = captureAdvancedFrame(
    updatedDoc.draft.structure,
    {
      documentId: entry.id,
      documentEpoch: entry.epoch,
      revision: updatedDoc.revision
    },
    makeDocumentStamp(updatedDoc),
    entry.label,
    updatedDoc.sharedConstraints
  );

  const snapshot = createConformerSnapshot(
    initialSource.structure,
    initialSource.ref,
    initialSource.constraints
  );
  const discoveredRows = discoverConformerTorsionRows(snapshot).filter(row => {
    if (row.atomIds.length !== 4) return false;
    return inspectConformerTorsion(snapshot, row.atomIds as TorsionAtoms).accepted;
  });

  if (!discoveredRows.length) {
    throw Object.assign(
      new Error('当前分子未识别到可旋转柔性单键，无需构象搜索；可直接调用 calculation="optimize" 执行几何优化。'),
      { code: 'MCP_NO_ROTATABLE_TORSIONS' }
    );
  }

  const resources = context.computeResources && context.computeResources.threads > 0 && context.computeResources.memoryBudgetBytes > 0
    ? context.computeResources
    : { threads: 2, memoryBudgetBytes: 2 * 1024 ** 3 };

  const draft = createMixedConformerDraft();
  const card = createMixedSamplingCard('conformer-search', initialSource);
  card.targetText = String(params.maxCandidates);
  card.torsions = discoveredRows.map(row => ({
    ...row,
    enabled: true,
    pointCount: params.pointsPerTorsion,
    pointCountMode: 'manual' as const
  }));
  draft.cards = [card];
  draft.stages[0] = {
    ...draft.stages[0],
    method: {
      ...draft.stages[0].method,
      method: params.method,
      threads: resources.threads,
      maxSteps: params.maxSteps,
      solvationModel: params.solvation ? params.solvation.model : 'none',
      solvent: params.solvation ? params.solvation.solvent : 'water',
      internalConstraintsConfirmed: constraints.coordinates.length > 0
    }
  };

  let ownedController: AdvancedController | null = null;
  const controller = context.controller ?? (() => {
    ownedController = new AdvancedController({
      bridge: (context.bridge as XtbBridge | null) ?? null
    });
    return ownedController;
  })();

  let activeTaskId: string | undefined;
  let activeRunId: string | undefined;
  let timedOut = false;
  const deadlineTimer = params.timeoutSeconds && params.timeoutSeconds > 0
    ? setTimeout(() => {
        timedOut = true;
        if (activeTaskId && activeRunId) {
          void controller.stop(activeTaskId, activeRunId).catch(() => {});
        }
      }, params.timeoutSeconds * 1000)
    : undefined;

  try {
    const spec = createMixedTaskSpec(initialSource, draft, resources);
    const taskId = controller.createTask(spec);
    activeTaskId = taskId;
    context.bindTaskToWorkspace?.(taskId, initialSource);

    const canonicalSource = context.readInitialSource
      ? context.readInitialSource(taskId)
      : initialSource;
    const effectiveDocumentId = canonicalSource.ref.documentId || entry.id;
    controller.confirmMixedInitialSource(taskId, canonicalSource, electronic);

    const compiledDef = compileMixedDefinition(draft, canonicalSource, resources);
    const compiledStages: AdvancedOptimizationStageConfig[] = compileMixedStages(draft.stages, resources.threads);
    controller.configureMixedSampling(taskId, compiledDef);
    controller.configureStages(taskId, compiledStages);

    const samplingRunId = controller.startSampling(taskId, 'continue');
    activeRunId = samplingRunId;
    await controller.waitForRun(taskId, samplingRunId);
    if (timedOut) {
      await controller.stop(taskId, samplingRunId).catch(() => {});
      throw Object.assign(
        new Error(`本机 xTB 构象搜索超过超时限制（${params.timeoutSeconds} 秒），已自动终止任务。`),
        { code: 'MCP_XTB_TIMEOUT' }
      );
    }

    const afterSamplingTask = controller.getSnapshot().tasks.find(t => t.id === taskId);
    const samplingRun = afterSamplingTask?.runs.find(r => r.id === samplingRunId);
    if (!afterSamplingTask || !samplingRun || samplingRun.status === 'failed' || samplingRun.status === 'stopped') {
      throw Object.assign(
        new Error(`构象初猜采样未完成：${samplingRun?.error || samplingRun?.stopReason || '未知错误'}`),
        { code: 'MCP_CONFORMER_SAMPLING_FAILED' }
      );
    }

    const candidateCount = afterSamplingTask.conformerWorkflow?.candidateSet?.frameIds.length ?? 0;
    if (candidateCount === 0) {
      throw Object.assign(
        new Error('柔性键采样未产生无严重空间碰撞的有效候选构象。'),
        { code: 'MCP_CONFORMER_EMPTY_CANDIDATES' }
      );
    }

    const optRunId = controller.runAllStages(taskId);
    activeRunId = optRunId;
    await controller.waitForRun(taskId, optRunId);
    if (timedOut) {
      await controller.stop(taskId, optRunId).catch(() => {});
      throw Object.assign(
        new Error(`本机 xTB 构象搜索超过超时限制（${params.timeoutSeconds} 秒），已自动终止任务。`),
        { code: 'MCP_XTB_TIMEOUT' }
      );
    }

    const finalTask: AdvancedTaskRecord | undefined = controller.getSnapshot().tasks.find(t => t.id === taskId);
    const optRun: AdvancedTaskRun | undefined = finalTask?.runs.find(r => r.id === optRunId);
    if (!finalTask || !optRun || optRun.status === 'failed' || optRun.status === 'stopped') {
      throw Object.assign(
        new Error(`构象池 xTB 优化未完成：${optRun?.error || optRun?.stopReason || '未知错误'}`),
        { code: 'MCP_CONFORMER_OPTIMIZATION_FAILED' }
      );
    }

    const collections = buildConformerResultCollections(finalTask, draft.stages);
    const terminalCollection = conformerTerminalResultCollection(collections, optRun)
      ?? collections.filter(c => c.includeEnergies && c.frames.length > 0).at(-1)
      ?? collections.find(c => c.frames.length > 0);

    if (terminalCollection && context.openResultCollection) {
      await context.openResultCollection(terminalCollection, terminalCollection.frames[0]?.id);
    }

    const stageRun = optRun.stages.at(-1);
    const completedResults = (stageRun?.results ?? []).filter(
      r => r.status === 'completed' && typeof r.energyHartree === 'number' && Number.isFinite(r.energyHartree)
    );
    const minEnergyHartree = completedResults.length
      ? Math.min(...completedResults.map(r => r.energyHartree!))
      : null;

    const clusters = (stageRun?.clustering?.groups ?? []).flatMap(group =>
      group.clusters.map(cluster => {
        const rep = cluster.representative;
        const relKcal = minEnergyHartree !== null && Number.isFinite(rep.energyHartree)
          ? convertEnergy({ value: rep.energyHartree - minEnergyHartree, unit: 'hartree' }, 'kcal/mol')
          : null;
        return {
          candidateId: rep.candidateId,
          memberCount: cluster.members.length,
          energyHartree: rep.energyHartree,
          ...(relKcal !== null ? { relativeEnergyKcalMol: Number(relKcal.toFixed(4)) } : {})
        };
      })
    );

    clusters.sort((a, b) => a.energyHartree - b.energyHartree);

    const bestFrame = (terminalCollection?.frames ?? [])[0];
    const bestStructure: Structure | undefined = bestFrame?.source.structure;

    return {
      documentId: effectiveDocumentId,
      calculation: 'conformer-search' as const,
      taskId,
      samplingRunId,
      optimizationRunId: optRunId,
      method: params.method,
      ...(params.solvation ? { solvation: params.solvation } : {}),
      rotatableTorsionCount: card.torsions.length,
      sampledCandidateCount: candidateCount,
      optimizedCount: completedResults.length,
      failedCount: (stageRun?.results ?? []).filter(r => r.status !== 'completed').length,
      clusterCount: clusters.length,
      lowestEnergyHartree: minEnergyHartree,
      conformers: clusters.slice(0, 25).map((item, idx) => ({
        rank: idx + 1,
        ...item
      })),
      ...(bestStructure
        ? {
            lowestConformerAtoms: bestStructure.atoms.map((atom, idx) => ({
              index: idx + 1,
              id: atom.id ?? `atom-${idx + 1}`,
              element: atom.element,
              x: Number(atom.x.toFixed(8)),
              y: Number(atom.y.toFixed(8)),
              z: Number(atom.z.toFixed(8))
            }))
          }
        : {})
    };
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (ownedController) {
      await ownedController.dispose();
    }
  }
}

export interface LiveInputDraftCapture {
  engine: 'gaussian' | 'orca';
  draft: ExternalInputDraft;
}

export function buildExternalDraftFromSavedEntry(
  entry: WorkspaceDocumentEntry,
  preferredEngine?: 'gaussian' | 'orca',
  inputSources?: InputStructureSource[]
): LiveInputDraftCapture {
  const store = entry.store;
  const modelDoc = store.getSnapshot();
  if (modelDoc.draft.structure.dimension === 2) {
    throw Object.assign(
      new Error('当前文档为 2D 结构，请先生成 3D 坐标并配置量化输入后再提交任务。'),
      { code: 'MCP_2D_STRUCTURE_NOT_READY' }
    );
  }
  const structure = formalInputStructure(modelDoc.draft.structure);
  if (!structure || !structure.atoms.length) {
    throw Object.assign(
      new Error('当前文档没有可提交的原子结构。'),
      { code: 'MCP_EMPTY_STRUCTURE' }
    );
  }
  if (structure.cell) {
    throw Object.assign(
      new Error('周期性晶体结构暂不支持直接生成 Gaussian / ORCA 任务中心提交输入。'),
      { code: 'MCP_PERIODIC_NOT_SUPPORTED' }
    );
  }

  let restored: ReturnType<typeof readProjectInputDrafts> | undefined;
  try {
    restored = readProjectInputDrafts(
      {
        gaussian: entry.drafts.gaussian,
        orca: entry.drafts.orca
      },
      modelDoc
    );
  } catch {
    let gPart: ReturnType<typeof readProjectInputDrafts>['gaussian'];
    let oPart: ReturnType<typeof readProjectInputDrafts>['orca'];
    try {
      if (entry.drafts.gaussian !== undefined) {
        gPart = readProjectInputDrafts({ gaussian: entry.drafts.gaussian }, modelDoc).gaussian;
      }
    } catch {
      gPart = undefined;
    }
    try {
      if (entry.drafts.orca !== undefined) {
        oPart = readProjectInputDrafts({ orca: entry.drafts.orca }, modelDoc).orca;
      }
    } catch {
      oPart = undefined;
    }
    restored = gPart || oPart
      ? {
          gaussian: gPart,
          orca: oPart,
          activeEngine:
            gPart?.activeEngine ??
            oPart?.activeEngine ??
            (oPart && oPart.step > 0 && (!gPart || gPart.step === 0) ? 'orca' : 'gaussian'),
          structure
        }
      : undefined;
  }
  const savedG = restored?.gaussian && restored.gaussian.step > 0 ? restored.gaussian : undefined;
  const savedO = restored?.orca && restored.orca.step > 0 ? restored.orca : undefined;

  let engine: 'gaussian' | 'orca' | undefined = preferredEngine;
  if (!engine) {
    if (savedG && !savedO) engine = 'gaussian';
    else if (savedO && !savedG) engine = 'orca';
    else if (savedG && savedO) {
      engine = savedO.activeEngine === 'orca' && savedG.activeEngine === 'orca'
        ? 'orca'
        : 'gaussian';
    }
  }

  if (!engine || (engine === 'gaussian' && !savedG) || (engine === 'orca' && !savedO)) {
    throw Object.assign(
      new Error(
        preferredEngine
          ? `当前文档尚未配置 ${preferredEngine.toUpperCase()} 计算草稿，请先调用 ester_configure_calculation。`
          : '当前文档尚未配置 Gaussian 或 ORCA 计算草稿，请先调用 ester_configure_calculation 或在输入面板配置任务。'
      ),
      { code: 'MCP_NO_CONFIGURED_CALCULATION' }
    );
  }

  if (engine === 'gaussian') {
    const g = savedG!;
    const gCtx = store.getContext('gaussian');
    const gDoc: ModelDocument = {
      ...modelDoc,
      draft: {
        ...modelDoc.draft,
        structure,
        ...(gCtx ? { assignments: gCtx.assignments } : {})
      },
      ...(gCtx?.coordinates !== undefined
        ? { internalCoordinates: gCtx.coordinates }
        : {})
    };
    const projected = projectSessionModel(
      gDoc,
      structure,
      captureDesktopAssignments(structure, g.settings),
      captureGaussianCoordinates(structure, g.settings),
      true
    );
    const integrated = integrateDesktopBuilderResult(
      structure,
      projected,
      g.settings
    );
    const sharedProjected = applySharedGaussianConstraints(
      structure,
      integrated.settings,
      modelDoc.sharedConstraints
    );
    if (sharedProjected.errors.length > 0) {
      throw Object.assign(
        new Error(`Gaussian 输入约束校验未通过：${sharedProjected.errors.join('；')}`),
        { code: 'MCP_INVALID_CALCULATION_DRAFT' }
      );
    }
    const req: JobRequest = {
      name: g.jobName,
      title: g.title,
      charge: g.charge,
      multiplicity: g.multiplicity,
      electronicStateConfirmed: g.stateConfirmed,
      frequencyConditionsConfirmed: g.frequencyConfirmed,
      cores: g.cores,
      memoryGB: g.memory,
      resourcesConfirmed: g.resourcesConfirmed,
      structure,
      settings: sharedProjected.settings,
      files: g.files,
      ...(inputSources ? { inputSources } : {})
    };
    const effectiveReq = projectGaussianTaskStructure(req);
    const currentSig = jobSignature(effectiveReq);
    if (g.editorDirty) {
      const freshnessPreview = previewGaussian(effectiveReq);
      if (!g.output.trim() || g.generatedSignature !== currentSig || freshnessPreview.errors.length > 0) {
        throw Object.assign(
          new Error(
            freshnessPreview.errors.length > 0
              ? `Gaussian 输入脚本引用的关联结构或条件已变化：${freshnessPreview.errors.join('；')}`
              : 'Gaussian 输入脚本存在手动修改且模型或参数已变化，请先重新生成或确认输入脚本后再提交。'
          ),
          { code: 'MCP_STALE_EDITED_INPUT' }
        );
      }
      return {
        engine: 'gaussian',
        draft: gaussianExternalInputDraft(g.output, g.generatedName || g.jobName)
      };
    }

    const preview = previewGaussian(effectiveReq);
    if (preview.errors.length > 0) {
      throw Object.assign(
        new Error(`Gaussian 输入校验未通过：${preview.errors.join('；')}`),
        { code: 'MCP_INVALID_CALCULATION_DRAFT' }
      );
    }
    const finalText = buildGaussian(effectiveReq);
    return {
      engine: 'gaussian',
      draft: gaussianExternalInputDraft(finalText, effectiveReq.name)
    };
  }

  const o = savedO!;
  const baseOrcaReq = restoredOrcaProjectRequest(o, structure);
  const oCtx = store.getContext('orca');
  const oDoc: ModelDocument = {
    ...modelDoc,
    draft: {
      ...modelDoc.draft,
      structure,
      ...(oCtx ? { assignments: oCtx.assignments } : {})
    },
    ...(oCtx?.coordinates !== undefined
      ? { internalCoordinates: oCtx.coordinates }
      : {})
  };
  const projected = projectSessionModel(
    oDoc,
    structure,
    captureOrcaAssignments(structure, baseOrcaReq.settings),
    captureOrcaCoordinates(structure, baseOrcaReq.settings),
    true
  );
  const integrated = integrateOrcaBuilderResult(structure, projected, baseOrcaReq.settings);
  const reqWithStructure: OrcaJobRequest = {
    ...baseOrcaReq,
    structure,
    settings: integrated.settings,
    ...(inputSources ? { inputSources } : {})
  };
  const projectedTaskReq = projectOrcaTaskStructure(reqWithStructure);
  const sharedOrca = applySharedOrcaConstraints(
    projectedTaskReq.structure,
    projectedTaskReq.settings,
    modelDoc.sharedConstraints
  );
  if (sharedOrca.errors.length > 0) {
    throw Object.assign(
      new Error(`ORCA 输入约束校验未通过：${sharedOrca.errors.join('；')}`),
      { code: 'MCP_INVALID_CALCULATION_DRAFT' }
    );
  }
  const effectiveOrcaReq: OrcaJobRequest = {
    ...projectedTaskReq,
    settings: sharedOrca.settings
  };
  const currentSourceSig = orcaGeneratedSource(effectiveOrcaReq);
  const existingGen = o.generatedDrafts?.[effectiveOrcaReq.settings.task];

  const built = buildOrcaCommon(effectiveOrcaReq);
  const errors = built.issues.filter(issue => issue.severity === 'error');

  if (existingGen && existingGen.editedNames.length > 0) {
    if (existingGen.sourceSignature !== currentSourceSig || errors.length > 0) {
      throw Object.assign(
        new Error(
          errors.length > 0
            ? `ORCA 输入脚本引用的关联结构或条件已变化：${errors.map(e => e.message).join('；')}`
            : 'ORCA 输入脚本存在手动修改且模型或参数已变化，请先重新生成或确认输入脚本后再提交。'
        ),
        { code: 'MCP_STALE_EDITED_INPUT' }
      );
    }
    return {
      engine: 'orca',
      draft: orcaExternalInputDraft(existingGen.files, 0, existingGen.assets)
    };
  }

  if (errors.length > 0 || built.files.length === 0) {
    throw Object.assign(
      new Error(`ORCA 输入校验未通过：${errors.map(e => e.message).join('；') || '未生成有效 .inp 文件'}`),
      { code: 'MCP_INVALID_CALCULATION_DRAFT' }
    );
  }
  const assets: OrcaAsset[] = referencedOrcaAssets(effectiveOrcaReq);
  const files: OrcaOutputFile[] = built.files;
  return {
    engine: 'orca',
    draft: orcaExternalInputDraft(files, 0, assets)
  };
}

export function applySubmissionDraftOverrides(
  draft: ExternalInputDraft,
  overrides: {
    taskName?: string;
    cores?: number;
    memoryGB?: number;
  }
): ExternalInputDraft {
  let finalInputText = draft.finalInputText;
  const engine = draft.engineId;

  if (overrides.cores !== undefined) {
    finalInputText = patchSubmissionResource(engine, finalInputText, 'cpu', String(overrides.cores));
  }

  if (overrides.memoryGB !== undefined) {
    if (engine === 'gaussian') {
      const gbInt = Number.isInteger(overrides.memoryGB);
      if (gbInt) {
        finalInputText = patchSubmissionResource('gaussian', finalInputText, 'memory', String(overrides.memoryGB), 'GB');
      } else {
        const mb = Math.max(1, Math.round(overrides.memoryGB * 1024));
        finalInputText = patchSubmissionResource('gaussian', finalInputText, 'memory', String(mb), 'MB');
      }
    } else {
      const parsed = readSubmissionResources('orca', finalInputText);
      const effectiveCores = overrides.cores ?? (parsed.cpu && /^\d+$/.test(parsed.cpu) ? Number(parsed.cpu) : 1);
      const maxCoreMb = Math.max(1, Math.floor(overrides.memoryGB * (768 / Math.max(1, effectiveCores))));
      finalInputText = patchSubmissionResource('orca', finalInputText, 'memory', String(maxCoreMb), 'MB');
    }
  }

  const suggestedName = overrides.taskName?.trim() || draft.suggestedName;
  return {
    ...draft,
    finalInputText,
    suggestedName
  };
}

function sanitizeEnvironmentSummary(env: EnvironmentView) {
  return {
    environmentId: env.environmentId,
    displayName: env.displayName,
    engineId: env.engineId,
    connectionKind: env.connectionKind,
    schedulerKind: env.schedulerKind,
    ...(env.connectionKind === 'ssh' ? { host: env.host, port: env.port, user: env.user } : {}),
    ...(env.connectionKind === 'wsl' ? { distribution: env.distribution } : {}),
    workingRoot: env.workingRoot,
    ...(env.schedulerKind === 'slurm'
      ? {
          partition: env.partition,
          account: env.account,
          qos: env.qos,
          timeLimit: env.timeLimit,
          slurmMemoryPolicy: env.slurmMemoryPolicy ?? 'input-request'
        }
      : {}),
    ...(env.check
      ? {
          check: {
            state: env.check.state,
            checkedAt: env.check.checkedAt,
            version: env.check.version.value
          }
        }
      : {})
  };
}

function formatTaskCardSummary(card: TaskCardView) {
  return {
    taskId: card.taskId,
    runId: card.runId,
    displayName: card.displayName,
    engineId: card.engineId,
    taskKind: card.taskKind,
    formula: card.formula,
    environmentId: card.environmentId,
    environmentName: card.environmentName,
    connectionKind: card.connectionKind,
    schedulerKind: card.schedulerKind,
    executionState: card.executionState,
    verificationState: card.verificationState,
    ...(card.failureKind ? { failureKind: card.failureKind } : {}),
    ...(card.endReason ? { endReason: card.endReason } : {}),
    ...(card.elapsedSeconds != null ? { elapsedSeconds: card.elapsedSeconds } : {}),
    archived: card.archived,
    recycled: card.recycled,
    canStop: card.stopControl?.canRequest === true,
    ...(card.stopControl?.pending ? { stopPending: true } : {}),
    workPath: card.workPath,
    archivePath: card.archivePath,
    createdAt: card.createdAt,
    ...(card.lastSubmittedAt ? { lastSubmittedAt: card.lastSubmittedAt } : {})
  };
}

function resolveTargetEnvironment(
  environments: readonly EnvironmentView[],
  engineId: 'gaussian' | 'orca',
  requestedEnvironmentId?: string
): EnvironmentView {
  const engineEnvs = environments.filter(env => env.engineId === engineId);
  if (requestedEnvironmentId) {
    const exact = environments.find(env => env.environmentId === requestedEnvironmentId);
    if (!exact) {
      const available = engineEnvs.length
        ? engineEnvs.map(e => `${e.environmentId} (${e.displayName})`).join(', ')
        : '无';
      throw Object.assign(
        new Error(
          `未找到指定的计算环境 "${requestedEnvironmentId}"。当前可用的 ${engineId.toUpperCase()} 环境：${available}。`
        ),
        { code: 'MCP_ENVIRONMENT_NOT_FOUND' }
      );
    }
    if (exact.engineId !== engineId) {
      throw Object.assign(
        new Error(
          `计算环境 "${exact.displayName}" (${exact.environmentId}) 属于 ${exact.engineId.toUpperCase()}，不能用于提交 ${engineId.toUpperCase()} 任务。`
        ),
        { code: 'MCP_ENGINE_ENVIRONMENT_MISMATCH' }
      );
    }
    return exact;
  }

  if (engineEnvs.length === 0) {
    throw Object.assign(
      new Error(
        `任务中心尚未配置任何 ${engineId.toUpperCase()} 计算环境，请先在全局设置/任务中心添加环境。`
      ),
      { code: 'MCP_NO_MATCHING_ENVIRONMENT' }
    );
  }

  if (engineEnvs.length > 1) {
    const choices = engineEnvs
      .map(e => `${e.environmentId} (${e.displayName} · ${e.connectionKind}${e.schedulerKind === 'slurm' ? '/slurm' : ''})`)
      .join(', ');
    throw Object.assign(
      new Error(
        `检测到多个可用的 ${engineId.toUpperCase()} 计算环境：[${choices}]。自动提交（auto-submit）时请显式指定 environmentId，以防误投递到错误节点。`
      ),
      { code: 'MCP_AMBIGUOUS_ENVIRONMENT' }
    );
  }

  return engineEnvs[0];
}

export async function executeAutoSubmitToTaskCenter(options: {
  bridge: TaskSystemBridge;
  draft: ExternalInputDraft;
  projectId: string | null;
  environmentId?: string;
  taskName?: string;
  onSubmittedOpenTask?: (taskId: string) => void;
}) {
  const { bridge, draft, projectId, environmentId, taskName, onSubmittedOpenTask } = options;
  const entryId = `mcp-auto-submit-${crypto.randomUUID()}`;
  let entered = false;
  let stagedSourceRefs: string[] = [];

  try {
    let center = await bridge.request('center.enter', { entryId });
    entered = true;

    if (!center.library.libraryId || !center.library.path) {
      throw Object.assign(
        new Error('当前尚未关联任务中心存储目录，请先在任务中心关联任务库，或使用 mode="open-dialog" 在界面引导设置。'),
        { code: 'MCP_TASK_LIBRARY_UNASSOCIATED' }
      );
    }

    if (center.manager.access !== 'manager') {
      const acquired = await bridge.request('manager.acquire', { entryId });
      if (acquired.access !== 'manager') {
        throw Object.assign(
          new Error(`当前窗口未取得任务库管理权（${acquired.reason || '由其他实例占用'}），无法自动提交。`),
          { code: 'MCP_TASK_MANAGER_REQUIRED' }
        );
      }
      center = await bridge.request('center.read', {});
    }

    const env = resolveTargetEnvironment(center.environments, draft.engineId, environmentId);
    const preparedInput = await stageExternalInput(draft, bridge, projectId);
    stagedSourceRefs = preparedInput.dependencies.map(dep => dep.sourceRef);

    const submissionIntentId = `mcp-intent-${crypto.randomUUID()}`;
    const initialDisplayName = taskName?.trim() || preparedInput.suggestedName;
    const baseRequest: SubmitTaskRequest = {
      input: preparedInput,
      environmentId: env.environmentId,
      displayName: initialDisplayName,
      groupIds: preparedInput.initialGroupIds ?? [],
      submissionIntentId,
      ...(env.schedulerKind === 'slurm'
        ? {
            slurm: {
              partition: env.partition,
              account: env.account,
              qos: env.qos,
              timeLimit: env.timeLimit
            }
          }
        : {})
    };

    const preview = await bridge.request('submission.preview', baseRequest);
    if (preview.restrictions.length > 0) {
      const messages = preview.restrictions.map(
        code => `${code}: ${submissionRestrictionMessage(code, draft.engineId)}`
      );
      throw Object.assign(
        new Error(`提交前预检查未通过：${messages.join('；')}`),
        { code: 'MCP_SUBMISSION_RESTRICTED' }
      );
    }

    const finalDisplayName = taskName?.trim() || preview.suggestedDisplayName || initialDisplayName;
    const submitResult = await bridge.request('submission.submit', {
      ...baseRequest,
      displayName: finalDisplayName,
      ...(preview.submissionPlanId ? { submissionPlanId: preview.submissionPlanId } : {})
    });

    await releaseSubmissionDependencies(bridge, stagedSourceRefs).catch(() => {});
    stagedSourceRefs = [];

    let detail: TaskDetailView | null = null;
    try {
      detail = await bridge.request('task.details', { taskId: submitResult.taskId });
    } catch {
      // Optional immediate readback; submission itself already succeeded durably.
    }

    onSubmittedOpenTask?.(submitResult.taskId);

    return {
      submitted: true,
      mode: 'auto-submit' as const,
      status: detail?.task.executionState ?? 'submitted',
      taskId: submitResult.taskId,
      runId: submitResult.runId,
      operationId: submitResult.operationId,
      displayName: detail?.task.displayName ?? finalDisplayName,
      engine: draft.engineId,
      inputName: draft.inputName,
      environmentId: env.environmentId,
      environmentName: env.displayName,
      connectionKind: env.connectionKind,
      schedulerKind: env.schedulerKind,
      workingPath: preview.workingPath,
      ...(preview.archivePath ? { archivePath: preview.archivePath } : {}),
      executionState: detail?.task.executionState ?? 'submitting',
      verificationState: detail?.task.verificationState ?? 'pending'
    };
  } finally {
    if (stagedSourceRefs.length > 0) {
      await releaseSubmissionDependencies(bridge, stagedSourceRefs).catch(() => {});
    }
    if (entered) {
      await bridge.request('center.leave', { entryId }).catch(() => {});
    }
  }
}

function extractEnergyMonitorSummary(monitor: TaskMonitorView | null) {
  if (!monitor || !Array.isArray(monitor.cards) || monitor.cards.length === 0) {
    return null;
  }
  const energyCard = monitor.cards.find(c => c.kind === 'energy')
    ?? monitor.cards.find(c => c.kind === 'trajectory');
  if (!energyCard) return null;

  const seriesSummaries = (energyCard.plot?.series ?? []).map(series => {
    const validPoints = series.points.filter(pt => typeof pt.y === 'number' && Number.isFinite(pt.y));
    const first = validPoints[0] ?? null;
    const latest = validPoints.at(-1) ?? null;
    return {
      id: series.id,
      label: series.label ?? series.id,
      pointCount: validPoints.length,
      ...(first ? { initialStep: first.x, initialValue: first.y } : {}),
      ...(latest ? { latestStep: latest.x, latestValue: latest.y } : {}),
      recentPoints: validPoints.slice(-10).map(pt => ({ step: pt.x, value: pt.y }))
    };
  });

  return {
    title: energyCard.title,
    sourceLabel: energyCard.sourceLabel,
    ...(energyCard.plot ? { xLabel: energyCard.plot.xLabel, yLabel: energyCard.plot.yLabel } : {}),
    columns: energyCard.columns,
    recentRows: energyCard.rows.slice(-10),
    series: seriesSummaries
  };
}

function isPureInputOrCompanionArtifact(file: TaskFileView): boolean {
  const roleTokens = file.role
    .split(/[、,;\s]+/)
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
  if (roleTokens.length === 0) return false;
  return roleTokens.every(token =>
    ['input', 'primary-input', 'frozen-input', 'companion', 'script'].includes(token)
  );
}

function selectLogArtifact(files: readonly TaskFileView[], requestedArtifactId?: string): TaskFileView {
  if (requestedArtifactId) {
    const exact = files.find(f => f.artifactId === requestedArtifactId);
    if (!exact) {
      throw Object.assign(
        new Error(`在任务文件列表中未找到指定的 artifactId "${requestedArtifactId}"。`),
        { code: 'MCP_ARTIFACT_NOT_FOUND' }
      );
    }
    if (exact.kind !== 'text') {
      throw Object.assign(
        new Error(`文件 "${exact.name}" (${exact.artifactId}) 不是可预览的文本文件（kind="${exact.kind}"），不支持文本日志读取。`),
        { code: 'MCP_BINARY_ARTIFACT_UNSUPPORTED' }
      );
    }
    if (exact.exists === false || exact.readable === false) {
      throw Object.assign(
        new Error(`文件 "${exact.name}" (${exact.artifactId}) 当前尚未生成或不可读取。`),
        { code: 'MCP_LOG_ARTIFACT_UNAVAILABLE' }
      );
    }
    return exact;
  }

  const pool = files.filter(
    f =>
      f.kind === 'text' &&
      f.exists !== false &&
      f.readable !== false &&
      !isPureInputOrCompanionArtifact(f)
  );

  const primaryOutput = pool.find(f => f.role.split(/[、,;\s]+/).includes('primary-output'))
    ?? pool.find(f => /\.(?:log|out)$/i.test(f.name))
    ?? pool.find(f => /stdout/i.test(f.role) || /stdout/i.test(f.name))
    ?? pool.find(f => /stderr/i.test(f.role) || /stderr/i.test(f.name))
    ?? pool[0];

  if (!primaryOutput) {
    throw Object.assign(
      new Error('当前任务尚无已生成且可读取的文本输出日志文件（任务可能仍在排队或启动中）。'),
      { code: 'MCP_LOG_ARTIFACT_UNAVAILABLE' }
    );
  }
  return primaryOutput;
}

export async function executeTaskManageAction(options: {
  bridge: TaskSystemBridge;
  params: TaskManageParams;
  taskCenterOpen: boolean;
  trackOperation?: (operationId: string) => void;
}) {
  const { bridge, params, taskCenterOpen, trackOperation } = options;
  const { action } = params;

  if (action === 'list-environments') {
    const center = await bridge.request('center.read', {});
    return {
      action: 'list-environments' as const,
      library: {
        associated: Boolean(center.library.libraryId && center.library.path),
        libraryId: center.library.libraryId,
        path: center.library.path
      },
      managerAccess: center.manager.access,
      environmentCount: center.environments.length,
      environments: center.environments.map(sanitizeEnvironmentSummary)
    };
  }

  if (action === 'list-tasks') {
    let center = await bridge.request('center.read', {});
    if (!center.library.libraryId || !center.library.path) {
      return {
        action: 'list-tasks' as const,
        library: {
          associated: false,
          libraryId: null,
          path: null
        },
        category: params.category ?? 'all',
        taskCount: 0,
        tasks: []
      };
    }

    if (!taskCenterOpen && center.tasks.some(t => !t.noRun && t.executionState !== 'ended')) {
      const entryId = `mcp-list-refresh-${crypto.randomUUID()}`;
      try {
        center = await bridge.request('center.enter', { entryId });
      } finally {
        await bridge.request('center.leave', { entryId }).catch(() => {});
      }
    }

    const category: TaskCategory = params.category ?? 'all';
    const filtered = filterTasks([...center.tasks], { ...defaultFilters, category }, center.groups ?? []);
    return {
      action: 'list-tasks' as const,
      library: {
        associated: true,
        libraryId: center.library.libraryId,
        path: center.library.path
      },
      managerAccess: center.manager.access,
      category,
      totalCount: center.tasks.filter(t => !t.recycled).length,
      taskCount: filtered.length,
      tasks: filtered.map(formatTaskCardSummary)
    };
  }

  const taskId = params.taskId!;

  if (action === 'task-detail') {
    let tempEntryId: string | null = null;
    try {
      if (!taskCenterOpen) {
        tempEntryId = `mcp-detail-${crypto.randomUUID()}`;
        const entered = await bridge.request('center.enter', { entryId: tempEntryId });
        if (entered.manager.access !== 'manager') {
          await bridge.request('manager.acquire', { entryId: tempEntryId }).catch(() => {});
        }
      }
      let monitor: TaskMonitorView | null = null;
      let detail: TaskDetailView;
      try {
        monitor = await bridge.request('monitor.read', {
          taskId,
          refresh: true,
          knownRevision: null
        });
        const hasMonitorableRun = !monitor.task.noRun || Boolean(monitor.task.sourceSetId);
        const hasReadableOutput = monitor.files.some(
          f => f.exists !== false && f.readable !== false && !isPureInputOrCompanionArtifact(f)
        );
        if (
          !monitor.prepared &&
          hasMonitorableRun &&
          (monitor.progress !== null || hasReadableOutput) &&
          !['ready', 'failed'].includes(monitor.progress?.stage ?? '')
        ) {
          for (let attempt = 0; attempt < 8; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 150));
            monitor = await bridge.request('monitor.read', {
              taskId,
              refresh: false,
              knownRevision: null
            });
            if (
              monitor.prepared ||
              ['ready', 'failed'].includes(monitor.progress?.stage ?? '') ||
              (attempt >= 2 && !monitor.progress && !monitor.prepared)
            ) {
              break;
            }
          }
        }
        detail = monitor;
      } catch {
        detail = await bridge.request('task.details', { taskId });
      }

      return {
        action: 'task-detail' as const,
        task: formatTaskCardSummary(detail.task),
        stage: detail.stage,
        iteration: detail.iteration,
        elapsedSeconds: detail.elapsedSeconds,
        updatedAt: detail.updatedAt,
        resultSource: detail.resultSource ?? null,
        frameCount: monitor?.frameCount ?? 0,
        monitorPrepared: monitor?.prepared ?? false,
        energyMonitor: extractEnergyMonitorSummary(monitor),
        scientificStates: (detail.scientificStates ?? []).map(s => ({
          key: s.key,
          label: s.label,
          state: s.state,
          jobIndex: s.jobIndex,
          ...(s.reason ? { reason: s.reason } : {})
        })),
        notices: detail.notices,
        files: detail.files.map(f => ({
          artifactId: f.artifactId,
          name: f.name,
          role: f.role,
          size: f.size,
          kind: f.kind,
          sourceKind: f.sourceKind ?? null,
          exists: f.exists ?? null,
          readable: f.readable ?? null
        }))
      };
    } finally {
      if (tempEntryId) {
        await bridge.request('center.leave', { entryId: tempEntryId }).catch(() => {});
      }
    }
  }

  if (action === 'read-log') {
    const tailLines = params.tailLines ?? 80;
    const detail = await bridge.request('task.details', { taskId });
    const targetFile = selectLogArtifact(detail.files, params.artifactId);
    const previewOwnerId = `mcp-log-preview-${crypto.randomUUID()}`;
    const maxBytes = Math.min(256 * 1024, Math.max(16384, tailLines * 256));

    try {
      const chunk = await bridge.request('preview.read', {
        ownerId: previewOwnerId,
        artifactId: targetFile.artifactId,
        anchor: 'tail',
        maxBytes,
        ...(targetFile.previewSourceIdentity
          ? { expectedSourceIdentity: targetFile.previewSourceIdentity }
          : {})
      });
      const allLines = Array.isArray(chunk.lines) ? chunk.lines : [];
      // Drop trailing empty line if file ends with '\n' and has preceding content
      const normalizedLines =
        allLines.length > 1 && allLines.at(-1) === ''
          ? allLines.slice(0, -1)
          : allLines;
      const slicedLines = normalizedLines.slice(-tailLines);

      return {
        action: 'read-log' as const,
        taskId,
        artifactId: chunk.artifactId,
        fileName: targetFile.name,
        role: targetFile.role,
        totalBytes: chunk.totalBytes,
        byteStart: chunk.byteStart,
        byteEnd: chunk.byteEnd,
        hasEarlierContent: chunk.hasBefore || normalizedLines.length > slicedLines.length,
        lineCount: slicedLines.length,
        text: slicedLines.join('\n')
      };
    } finally {
      await bridge.request('preview.release', { ownerId: previewOwnerId }).catch(() => {});
    }
  }

  if (action === 'stop-task') {
    const entryId = `mcp-stop-task-${crypto.randomUUID()}`;
    let entered = false;
    try {
      const center = await bridge.request('center.enter', { entryId });
      entered = true;

      if (!center.library.libraryId) {
        throw Object.assign(
          new Error('当前尚未关联任务库目录。'),
          { code: 'MCP_TASK_LIBRARY_UNASSOCIATED' }
        );
      }

      if (center.manager.access !== 'manager') {
        const acquired = await bridge.request('manager.acquire', { entryId });
        if (acquired.access !== 'manager') {
          throw Object.assign(
            new Error(`当前窗口未取得任务库管理权（${acquired.reason || '由其他实例占用'}），无法停止任务。`),
            { code: 'MCP_TASK_MANAGER_REQUIRED' }
          );
        }
      }

      const plan = await bridge.request('operation.plan', {
        action: 'stop',
        taskIds: [taskId]
      });
      const item = plan.items.find(row => row.taskId === taskId) ?? plan.items[0];
      if (!item || !item.eligible) {
        return {
          action: 'stop-task' as const,
          taskId,
          stopped: false,
          eligible: false,
          reason: item?.reason ?? '当前任务不处于可停止的运行状态。'
        };
      }

      const started = await bridge.request('operation.execute', { planId: plan.planId });
      trackOperation?.(started.operationId);

      let opView = await bridge.request('operation.read', { operationId: started.operationId });
      for (let attempt = 0; attempt < 16; attempt++) {
        if (['succeeded', 'failed', 'cancelled', 'partial'].includes(opView.state)) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        opView = await bridge.request('operation.read', { operationId: started.operationId });
      }

      const latestDetail = await bridge.request('task.details', { taskId }).catch(() => null);
      const opItem = opView.items.find(row => row.taskId === taskId);

      return {
        action: 'stop-task' as const,
        taskId,
        operationId: started.operationId,
        stopped:
          opView.state === 'succeeded' ||
          (latestDetail?.task.executionState === 'ended' && latestDetail?.task.endReason === 'stopped'),
        operationState: opView.state,
        phase: opView.phase,
        ...(opItem?.outcome ? { itemOutcome: opItem.outcome } : {}),
        ...(opItem?.message ? { message: opItem.message } : {}),
        ...(latestDetail ? { task: formatTaskCardSummary(latestDetail.task) } : {})
      };
    } finally {
      if (entered) {
        await bridge.request('center.leave', { entryId }).catch(() => {});
      }
    }
  }

  throw Object.assign(
    new Error(`Unsupported task management action: ${String(action)}`),
    { code: 'INVALID_TASK_MANAGE_ACTION' }
  );
}
