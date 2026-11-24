import type { JobRequest, Structure } from '../../core/types';
import { ELEMENTS, electronicStateInputError } from '../../core/elements';
import { buildGaussian, defaultFiles } from '../../core/gaussian';
import { buildOrcaCommon, type OrcaJobRequest } from '../../core/orca';
import { exportXyzChunks, validateXyzGeometry } from '../../core/structure-export';
import { exportJsonChunks } from '../../core/export-json-chunks';
import { createBuilderDraft } from '../../core/builder-draft';
import type { DocumentStamp, FragmentSnapshot, ModelCoordinateObject, SharedModelConstraints } from '../contracts';
import { advancedFrameWorkingCopy, assertAdvancedIsolated, captureAdvancedFrame,
  type AdvancedFrameRef, type AdvancedFrameSource } from '../advanced/frame-source';
import { assertImageCoordinateExecutionSupported, modelCoordinateKey, validateSharedConstraints } from '../constraints';
import { applySharedGaussianConstraints } from './gaussian-bridge';
import { applySharedOrcaConstraints } from './orca-bridge';
import { freezeDefinitionSignature, gaussianFreezeDefinitions, orcaFreezeDefinitions } from './canonical-freezes';

export interface AdvancedOutputFile { name: string; text: string }
export interface AdvancedFrameInput {
  source: AdvancedFrameSource;
  stem: string;
  /** This confirmation belongs to this output frame, not to the shared template. */
  electronicState: { charge: number; multiplicity: number; confirmed: boolean };
  /** Explicit per-frame Gaussian checkpoint name, when independent names are requested. */
  outputCheckpointName?: string;
}
export type AdvancedInputTemplate = { engine: 'gaussian'; request: JobRequest } | { engine: 'orca'; request: OrcaJobRequest };
export interface AdvancedOutputItem {
  order: number;
  sourceRef: Readonly<AdvancedFrameRef>;
  stem?: string;
  errors: readonly string[];
  warnings: readonly string[];
  fileNames: readonly string[];
  effective?: { name:string; settings:JobRequest['settings']|OrcaJobRequest['settings']; cores:number; memoryGB:number;
    resourcesConfirmed?:boolean; files?:JobRequest['files'] };
}
export interface AdvancedOutputFrameManifest {
  order: number;
  label: string;
  ref: Readonly<AdvancedFrameRef>;
  stamp: DocumentStamp;
  coordinateUnit: 'angstrom';
  atoms: { id: string; element: string; sourceIndex?: number }[];
  sourceElectronicState: { charge: number | null; multiplicity: number | null };
  electronicState: { charge: number; multiplicity: number; confirmed?: boolean };
  constraints: SharedModelConstraints;
  fileNames: string[];
  runtimeOutputNames?: string[];
}
export interface AdvancedOutputManifest {
  schema: 'sciyue-advanced-frame-output';
  version: 1;
  kind: 'inputs' | 'trajectory';
  engine?: AdvancedInputTemplate['engine'];
  format?: 'xyz' | 'extxyz';
  ordering: 'explicit-frame-order';
  coordinateUnit: 'angstrom';
  frames: AdvancedOutputFrameManifest[];
}
export interface AdvancedFrameOutputPlan {
  ready: boolean;
  items: readonly AdvancedOutputItem[];
  errors: readonly string[];
  /** Empty on any preflight error. Names are basenames, never renderer-supplied paths. */
  files: readonly AdvancedOutputFile[];
  manifest: AdvancedOutputManifest;
}
export interface AdvancedFrameStreamPlan {
  streamed: true;
  ready: boolean;
  items: readonly AdvancedOutputItem[];
  errors: readonly string[];
  files: readonly { name: string; chunks(): Iterable<string> }[];
}
type TrajectoryRequest = { frames: readonly AdvancedFrameSource[]; format: 'xyz' | 'extxyz'; stem: string };

/** Match the stable fields of sameAdvancedFrame independently of property order. */
function trackFrameRefs() {
  const seen = new Set<string>();
  return (ref: AdvancedFrameRef) => {
    if (Number.isNaN(ref.outputJob?.index)) return false;
    const { documentId, documentEpoch, revision, sourceId, sourceRevision, outputJob, taskId, runId, stageId, collectionId, frameId, sourceFrameIndex } = ref;
    const key = JSON.stringify({ documentId, documentEpoch, revision, sourceId, sourceRevision, outputJobSource: outputJob?.sourceId,
      outputJobRevision: outputJob?.sourceRevision, outputJobId: outputJob?.id, outputJobIndex: outputJob?.index, taskId, runId, stageId, collectionId, frameId, sourceFrameIndex });
    const duplicate = seen.has(key); seen.add(key); return duplicate;
  };
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const part of Object.values(value)) immutable(part);
    Object.freeze(value);
  }
  return value;
}
function requireStem(stem: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(stem) || stem.endsWith('.') || stem.includes('..')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) throw Error('输出名称须为安全ASCII名称，不能含路径或Windows保留名称。');
}

/** Revalidate at the handoff boundary without consulting a current view or model. */
function scientificSource(source: AdvancedFrameSource): AdvancedFrameSource {
  if (source.coordinateUnit !== 'angstrom') throw Error('当前帧坐标单位必须明确为angstrom。');
  const snapshot = captureAdvancedFrame(source.structure, source.ref, source.stamp, source.label, source.constraints);
  if (snapshot.structure.dimension === 2 || snapshot.structure.atoms.some(atom => !ELEMENTS.includes(atom.element))) throw Error('当前帧需要已知元素的完整三维科学结构。');
  if (snapshot.structure.atoms.some(atom => atom.sourceIndex !== undefined && !Number.isSafeInteger(atom.sourceIndex))) throw Error('当前帧原子源编号无效。');
  return snapshot;
}

/** Only bind bookkeeping identities; never synthesize a scientific target value. */
function frameConstraints(source: AdvancedFrameSource): { sharedConstraints: SharedModelConstraints; coordinateObjects: ModelCoordinateObject[] } {
  const sharedConstraints: SharedModelConstraints = structuredClone(source.constraints);
  sharedConstraints.canonical = true;
  const coordinateObjects = sharedConstraints.coordinates.map(row => {
    row.objectId ??= `advanced-frame-coordinate:${modelCoordinateKey(row)}`;
    row.id ??= `advanced-frame-freeze:${row.objectId}`;
    return { id: row.objectId, type: row.type, atomIds: [...row.atomIds], ...(row.images ? { images: structuredClone(row.images) } : {}) };
  });
  validateSharedConstraints(sharedConstraints, coordinateObjects, source.structure);
  return { sharedConstraints, coordinateObjects };
}

/** A fresh model retains source freezes, independently of the original task/draft. */
export function advancedFrameFragment(source: AdvancedFrameSource): FragmentSnapshot {
  const snapshot = scientificSource(source), constraints = frameConstraints(snapshot), structure = advancedFrameWorkingCopy(snapshot);
  return { structure, assignments: createBuilderDraft(structure).assignments,
    auxiliaryRelations: [], deletedBonds: [], internalCoordinates: [], ...constraints };
}

function frameManifest(source: AdvancedFrameSource, order: number, constraints: SharedModelConstraints,
  electronicState = { charge: source.structure.charge!, multiplicity: source.structure.multiplicity! },
  sourceElectronicState = { charge: source.structure.charge ?? null, multiplicity: source.structure.multiplicity ?? null }): AdvancedOutputFrameManifest {
  return { order, label: source.label, ref: structuredClone(source.ref), stamp: structuredClone(source.stamp), coordinateUnit: 'angstrom',
    atoms: source.structure.atoms.map(atom => ({ id: atom.id!, element: atom.element, ...(atom.sourceIndex === undefined ? {} : { sourceIndex: atom.sourceIndex }) })),
    sourceElectronicState: structuredClone(sourceElectronicState),
    electronicState: structuredClone(electronicState), constraints: structuredClone(constraints), fileNames: [] };
}
function templateNeedsMatchingAtoms(template: AdvancedInputTemplate): boolean {
  if (template.engine === 'gaussian') {
    const s = template.request.settings, o = s.taskOptions;
    return Boolean(s.mixedBasis?.enabled || s.oniom?.enabled || o && (o.frozenAtoms.length || o.coordinates.length
      || o.coordinateDrafts?.length || o.fragments.some(fragment => fragment.atoms.length)));
  }
  const s = template.request.settings;
  return Boolean(s.constraints.length || s.frozenAtomIds.length || s.fragments.length || s.multiscale.mode !== 'none'
    || s.md.activeAtomIds.length || s.md.constraints.length);
}
function verifyTemplateAtoms(template: AdvancedInputTemplate, structure: Structure, constraints: SharedModelConstraints): void {
  if (!templateNeedsMatchingAtoms(template)) return;
  const original = template.request.structure;
  if (!original || original.atoms.length !== structure.atoms.length || original.atoms.some((atom, index) => !atom.id
    || atom.id !== structure.atoms[index].id || atom.element !== structure.atoms[index].element)) throw Error('模板含原子相关定义，其原子身份及顺序须逐帧对应，不能套用另一结构的序号。');
  const freezes = template.engine === 'gaussian' ? gaussianFreezeDefinitions(original, template.request.settings)
    : orcaFreezeDefinitions(original, template.request.settings);
  if ((freezes.frozenAtomIds.length || freezes.coordinates.length) && freezeDefinitionSignature(freezes) !== freezeDefinitionSignature(constraints)) throw Error('模板冻结与此帧来源冻结不一致，请为本批明确配置；不会替换或丢弃冻结。');
}
function verifyIndependentTemplate(template: AdvancedInputTemplate): void {
  if (template.engine === 'gaussian') {
    const req = template.request, f = req.files ?? defaultFiles();
    if (['qst2', 'qst3'].includes(req.settings.task) || f.geometry !== 'explicit' || f.readCheckpoint || f.guessRead
      || f.basisFromCheckpoint || ['readfc', 'rcfc'].includes(f.hessian)) throw Error('此批量模板依赖CHK或QST强来源，请逐结构在既有输入流程独立配置。');
  } else {
    const s = template.request.settings;
    if (['neb', 'esd'].includes(s.task) || s.initialOrbitalsId || s.ircHessianId || s.task === 'md' && s.md.restartAssetId
      || s.multiscale.mode !== 'none') throw Error('此批量模板依赖GBW/Hessian/重启或多结构来源，请逐结构在既有输入流程独立配置。');
  }
}
function finalizeInventory(items: readonly AdvancedOutputItem[], errors: string[], files: readonly { name: string }[], manifestStem: string): boolean {
  try { requireStem(manifestStem); } catch (cause) { errors.push(message(cause)); }
  const names = new Set<string>();
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,239}$/.test(file.name) || file.name.endsWith('.') || file.name.includes('..')
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name)
      || names.has(file.name.toLowerCase())) errors.push(`输出文件名称无效或重名：${file.name}`);
    names.add(file.name.toLowerCase());
  }
  for (const item of items) for (const issue of item.errors) errors.push(`第${item.order}项：${issue}`);
  return !errors.length && items.length > 0;
}
function finishPlan(items: AdvancedOutputItem[], errors: string[], files: AdvancedOutputFile[], manifest: AdvancedOutputManifest,
  manifestStem: string): AdvancedFrameOutputPlan {
  const manifestName = `${manifestStem}.manifest.json`;
  const ready = finalizeInventory(items, errors, [...files, { name: manifestName }], manifestStem);
  return immutable({ ready, items, errors, files: ready ? [...files, { name: manifestName, text: JSON.stringify(manifest, null, 2) + '\n' }] : [], manifest });
}

/** Pure preflight + existing writer projection. No store, draft, native run or file write. */
export function prepareAdvancedFrameInputs(request: { frames: readonly AdvancedFrameInput[]; template: AdvancedInputTemplate; manifestStem?: string; independentRuntimeNames?: boolean }): AdvancedFrameOutputPlan {
  const items: AdvancedOutputItem[] = [], errors: string[] = [], files: AdvancedOutputFile[] = [];
  const manifest: AdvancedOutputManifest = { schema: 'sciyue-advanced-frame-output', version: 1, kind: 'inputs',
    engine: request.template.engine, ordering: 'explicit-frame-order', coordinateUnit: 'angstrom', frames: [] };
  if (!request.frames.length) errors.push('请先明确选择需要准备输入的完整帧。');
  const names = new Map<string, number>(), runtimeNames = new Map<string, number>(), duplicateRef = trackFrameRefs();
  request.frames.forEach((frame, index) => {
    const item: AdvancedOutputItem = { order: index + 1, sourceRef: structuredClone(frame.source.ref), stem: frame.stem, errors: [], warnings: [], fileNames: [] };
    const issues: string[] = [], warnings: string[] = []; let frameFiles: AdvancedOutputFile[] = [];
    const duplicate = duplicateRef(frame.source.ref);
    try {
      const source = scientificSource(frame.source); requireStem(frame.stem); assertAdvancedIsolated(source);
      if (duplicate) throw Error('同一来源帧重复选择，请确认输出顺序。');
      const previousName = names.get(frame.stem.toLowerCase());
      if (previousName !== undefined) throw Error(`输出名称与第${previousName + 1}项重名。`);
      names.set(frame.stem.toLowerCase(), index);
      if (frame.electronicState.confirmed !== true) throw Error('请逐结构确认电荷与多重度，模板确认不能代替本帧确认。');
      const stateError = electronicStateInputError(source.structure.atoms, frame.electronicState.charge, frame.electronicState.multiplicity);
      if (stateError) throw Error(stateError);
      const { sharedConstraints } = frameConstraints(source);
      assertImageCoordinateExecutionSupported(sharedConstraints.enabled===false?[]:sharedConstraints.coordinates);
      verifyIndependentTemplate(request.template); verifyTemplateAtoms(request.template, source.structure, sharedConstraints);
      const structure = advancedFrameWorkingCopy(source);
      structure.charge = frame.electronicState.charge; structure.multiplicity = frame.electronicState.multiplicity;
      const entry = frameManifest(source, index + 1, sharedConstraints, frame.electronicState, frame.source.sourceElectronicState);
      if (request.template.engine === 'gaussian') {
        const req = structuredClone(request.template.request), projection = applySharedGaussianConstraints(structure, req.settings, sharedConstraints);
        if (projection.errors.length) throw Error(projection.errors.join('\n'));
        const mapped: JobRequest = { ...req, structure, name: frame.stem, settings: projection.settings,
          charge: frame.electronicState.charge, multiplicity: frame.electronicState.multiplicity, electronicStateConfirmed: true };
        if(request.independentRuntimeNames) mapped.files={...(mapped.files??defaultFiles()),checkpointName:frame.outputCheckpointName??`${frame.stem}.chk`};
        const output = mapped.files ?? defaultFiles();
        const gaussianText=buildGaussian(mapped);
        if (output.saveCheckpoint && (!request.independentRuntimeNames || /^%chk=/mi.test(gaussianText))) {
          const checkpoint = output.checkpointName.trim() || `${frame.stem}.chk`, previous = runtimeNames.get(checkpoint.toLowerCase());
          if (previous !== undefined) throw Error(`新CHK名称与第${previous + 1}项冲突，请使用逐结构独立名称。`);
          runtimeNames.set(checkpoint.toLowerCase(), index); entry.runtimeOutputNames = [checkpoint];
        }
        frameFiles = [{ name: `${frame.stem}.gjf`, text: gaussianText }];
        item.effective={name:mapped.name,settings:mapped.settings,cores:mapped.cores,memoryGB:mapped.memoryGB,resourcesConfirmed:mapped.resourcesConfirmed,
          files:{...output,checkpointName:entry.runtimeOutputNames?.[0]??''}};
      } else {
        const req = structuredClone(request.template.request), projection = applySharedOrcaConstraints(structure, req.settings, sharedConstraints);
        if (projection.errors.length) throw Error(projection.errors.join('\n'));
        const mapped={ ...req, structure, name: frame.stem, settings: projection.settings,
          charge: frame.electronicState.charge, multiplicity: frame.electronicState.multiplicity, electronicStateConfirmed: true };
        const built = buildOrcaCommon(mapped);
        const failed = built.issues.filter(issue => issue.severity === 'error');
        if (failed.length) throw Error(failed.map(issue => issue.message).join('\n'));
        if (!built.files.length) throw Error('现有ORCA写出器未产生完整文件组。');
        warnings.push(...built.issues.filter(issue => issue.severity === 'warning').map(issue => issue.message));
        frameFiles = built.files.map(file => ({ name: file.name, text: file.text }));
        item.effective={name:mapped.name,settings:mapped.settings,cores:mapped.cores,memoryGB:mapped.memoryGB,resourcesConfirmed:mapped.resourcesConfirmed};
        if(request.independentRuntimeNames)entry.runtimeOutputNames=[`${frame.stem}.gbw`,`${frame.stem}.out`];
      }
      entry.fileNames = frameFiles.map(file => file.name); manifest.frames.push(entry);
    } catch (cause) { issues.push(message(cause)); }
    items.push({ ...item, errors: issues, warnings, fileNames: frameFiles.map(file => file.name) });
    files.push(...frameFiles);
  });
  return finishPlan(items, errors, files, manifest, request.manifestStem ?? 'frame-inputs');
}

function newTrajectoryManifest(request: TrajectoryRequest): AdvancedOutputManifest {
  return { schema: 'sciyue-advanced-frame-output', version: 1, kind: 'trajectory',
    format: request.format, ordering: 'explicit-frame-order', coordinateUnit: 'angstrom', frames: [] };
}
function* preflightTrajectory(request: TrajectoryRequest, errors: string[]): Generator<AdvancedOutputItem> {
  try { requireStem(request.stem); if (!['xyz', 'extxyz'].includes(request.format)) throw Error('多帧科学导出仅支持XYZ/extXYZ。'); }
  catch (cause) { errors.push(message(cause)); }
  if (!request.frames.length) errors.push('请先明确选择需要导出的完整帧。');
  const filename = `${request.stem}.${request.format}`, duplicateRef = trackFrameRefs();
  for (const [index, frame] of request.frames.entries()) {
    const issues: string[] = [];
    const duplicate = duplicateRef(frame.ref);
    try {
      const source = scientificSource(frame);
      if (duplicate) throw Error('同一来源帧重复选择，请确认导出顺序。');
      const stateError = electronicStateInputError(source.structure.atoms, source.structure.charge!, source.structure.multiplicity!);
      if (stateError) throw Error(stateError);
      frameConstraints(source);
      validateXyzGeometry(source.structure, request.format, true);
    } catch (cause) { issues.push(message(cause)); }
    yield { order: index + 1, sourceRef: structuredClone(frame.ref), errors: issues, warnings: [], fileNames: issues.length ? [] : [filename] };
  }
}
function* trajectoryChunks(request: TrajectoryRequest): Generator<string> {
  for (const [index, source] of request.frames.entries()) {
    const identity = encodeURIComponent(JSON.stringify(source.ref));
    yield* exportXyzChunks(source.structure, request.format, true, ` coordinate_unit="angstrom" output_frame=${index + 1} sciyue_frame_ref=${identity}`);
  }
}
function* trajectoryManifestFrames(request: TrajectoryRequest, filename: string): Generator<AdvancedOutputFrameManifest> {
  for (const [index, source] of request.frames.entries()) {
    const entry = frameManifest(source, index + 1, frameConstraints(source).sharedConstraints);
    entry.fileNames = [filename];
    yield entry;
  }
}
function* trajectoryManifestChunks(request: TrajectoryRequest, filename: string): Generator<string> {
  const { frames: _frames, ...header } = newTrajectoryManifest(request);
  yield JSON.stringify(header, null, 2).slice(0, -2) + ',\n  "frames": [';
  let first = true;
  for (const entry of trajectoryManifestFrames(request, filename)) {
    yield first ? '\n    ' : ',\n    ';
    yield* exportJsonChunks(entry, 2, 2);
    first = false;
  }
  yield (first ? '' : '\n  ') + ']\n}\n';
}

/** Keep the old direct text projection for small independent callers. */
export function prepareAdvancedFrameTrajectory(request: TrajectoryRequest): AdvancedFrameOutputPlan {
  const errors: string[] = [], manifest = newTrajectoryManifest(request), filename = `${request.stem}.${request.format}`;
  const items = [...preflightTrajectory(request, errors)];
  // Keep original output indexes in partial preflight provenance.
  for (const [index, source] of request.frames.entries()) {
    if (items[index].errors.length) continue;
    const entry = frameManifest(source, index + 1, frameConstraints(source).sharedConstraints);
    entry.fileNames = [filename]; manifest.frames.push(entry);
  }
  const files = manifest.frames.length ? [{ name: filename, text: '' }] : [];
  if (manifest.frames.length === request.frames.length && !errors.length && files.length) files[0].text = [...trajectoryChunks(request)].join('');
  return finishPlan(items, errors, files, manifest, request.stem);
}

/** Pass through the event loop between batches; caller owns cancellation. */
export async function prepareAdvancedFrameTrajectoryStream(request: TrajectoryRequest, current: () => boolean): Promise<AdvancedFrameStreamPlan> {
  const items: AdvancedOutputItem[] = [], errors: string[] = [];
  let resumeAt = performance.now() + 16;
  for (const item of preflightTrajectory(request, errors)) {
    items.push(item);
    if (performance.now() >= resumeAt) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!current()) throw Error('输出条件已变化，请重新预检。');
      resumeAt = performance.now() + 16;
    }
  }
  const filename = `${request.stem}.${request.format}`;
  const files = [{ name: filename, chunks: () => trajectoryChunks(request) },
    { name: `${request.stem}.manifest.json`, chunks: () => trajectoryManifestChunks(request, filename) }];
  const ready = finalizeInventory(items, errors, files, request.stem);
  return { streamed: true, ready, items, errors, files: ready ? files : [] };
}
