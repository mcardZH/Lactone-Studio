import type { JobRequest, Structure } from '../../core/types';
import { ELEMENTS, electronicStateError } from '../../core/elements';
import { buildGaussian, defaultFiles } from '../../core/gaussian';
import { buildOrcaCommon, type OrcaJobRequest } from '../../core/orca';
import { exportStructure } from '../../core/structure-export';
import { createBuilderDraft } from '../../core/builder-draft';
import type { DocumentStamp, FragmentSnapshot, ModelCoordinateObject, SharedModelConstraints } from '../contracts';
import { advancedFrameWorkingCopy, assertAdvancedIsolated, captureAdvancedFrame, sameAdvancedFrame,
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
}
export type AdvancedInputTemplate = { engine: 'gaussian'; request: JobRequest } | { engine: 'orca'; request: OrcaJobRequest };
export interface AdvancedOutputItem {
  order: number;
  sourceRef: Readonly<AdvancedFrameRef>;
  stem?: string;
  errors: readonly string[];
  warnings: readonly string[];
  fileNames: readonly string[];
}
export interface AdvancedOutputFrameManifest {
  order: number;
  label: string;
  ref: Readonly<AdvancedFrameRef>;
  stamp: DocumentStamp;
  coordinateUnit: 'angstrom';
  atoms: { id: string; element: string; sourceIndex?: number }[];
  sourceElectronicState: { charge: number; multiplicity: number };
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
  electronicState = { charge: source.structure.charge!, multiplicity: source.structure.multiplicity! }): AdvancedOutputFrameManifest {
  return { order, label: source.label, ref: structuredClone(source.ref), stamp: structuredClone(source.stamp), coordinateUnit: 'angstrom',
    atoms: source.structure.atoms.map(atom => ({ id: atom.id!, element: atom.element, ...(atom.sourceIndex === undefined ? {} : { sourceIndex: atom.sourceIndex }) })),
    sourceElectronicState: { charge: source.structure.charge!, multiplicity: source.structure.multiplicity! },
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
function finishPlan(items: AdvancedOutputItem[], errors: string[], files: AdvancedOutputFile[], manifest: AdvancedOutputManifest,
  manifestStem: string): AdvancedFrameOutputPlan {
  try { requireStem(manifestStem); } catch (cause) { errors.push(message(cause)); }
  const manifestName = `${manifestStem}.manifest.json`, names = new Set<string>();
  for (const file of [...files, { name: manifestName, text: '' }]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,239}$/.test(file.name) || file.name.endsWith('.') || file.name.includes('..')
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file.name)
      || names.has(file.name.toLowerCase())) errors.push(`输出文件名称无效或重名：${file.name}`);
    names.add(file.name.toLowerCase());
  }
  errors.push(...items.flatMap(item => item.errors.map(issue => `第${item.order}项：${issue}`)));
  const ready = !errors.length && items.length > 0 && items.every(item => !item.errors.length);
  return immutable({ ready, items, errors, files: ready ? [...files, { name: manifestName, text: JSON.stringify(manifest, null, 2) + '\n' }] : [], manifest });
}

/** Pure preflight + existing writer projection. No store, draft, native run or file write. */
export function prepareAdvancedFrameInputs(request: { frames: readonly AdvancedFrameInput[]; template: AdvancedInputTemplate; manifestStem?: string; independentRuntimeNames?: boolean }): AdvancedFrameOutputPlan {
  const items: AdvancedOutputItem[] = [], errors: string[] = [], files: AdvancedOutputFile[] = [];
  const manifest: AdvancedOutputManifest = { schema: 'sciyue-advanced-frame-output', version: 1, kind: 'inputs',
    engine: request.template.engine, ordering: 'explicit-frame-order', coordinateUnit: 'angstrom', frames: [] };
  if (!request.frames.length) errors.push('请先明确选择需要准备输入的完整帧。');
  const names = new Map<string, number>(), runtimeNames = new Map<string, number>();
  request.frames.forEach((frame, index) => {
    const item: AdvancedOutputItem = { order: index + 1, sourceRef: structuredClone(frame.source.ref), stem: frame.stem, errors: [], warnings: [], fileNames: [] };
    const issues: string[] = [], warnings: string[] = []; let frameFiles: AdvancedOutputFile[] = [];
    try {
      const source = scientificSource(frame.source); requireStem(frame.stem); assertAdvancedIsolated(source);
      if (request.frames.slice(0, index).some(previous => sameAdvancedFrame(previous.source.ref, source.ref))) throw Error('同一来源帧重复选择，请确认输出顺序。');
      const previousName = names.get(frame.stem.toLowerCase());
      if (previousName !== undefined) throw Error(`输出名称与第${previousName + 1}项重名。`);
      names.set(frame.stem.toLowerCase(), index);
      if (frame.electronicState.confirmed !== true) throw Error('请逐结构确认电荷与多重度，模板确认不能代替本帧确认。');
      const stateError = electronicStateError(source.structure.atoms, frame.electronicState.charge, frame.electronicState.multiplicity);
      if (stateError) throw Error(stateError);
      const { sharedConstraints } = frameConstraints(source);
      assertImageCoordinateExecutionSupported(sharedConstraints.enabled===false?[]:sharedConstraints.coordinates);
      verifyIndependentTemplate(request.template); verifyTemplateAtoms(request.template, source.structure, sharedConstraints);
      const structure = advancedFrameWorkingCopy(source);
      structure.charge = frame.electronicState.charge; structure.multiplicity = frame.electronicState.multiplicity;
      const entry = frameManifest(source, index + 1, sharedConstraints, frame.electronicState);
      if (request.template.engine === 'gaussian') {
        const req = structuredClone(request.template.request), projection = applySharedGaussianConstraints(structure, req.settings, sharedConstraints);
        if (projection.errors.length) throw Error(projection.errors.join('\n'));
        const mapped: JobRequest = { ...req, structure, name: frame.stem, settings: projection.settings,
          charge: frame.electronicState.charge, multiplicity: frame.electronicState.multiplicity, electronicStateConfirmed: true };
        if(request.independentRuntimeNames) mapped.files={...(mapped.files??defaultFiles()),checkpointName:`${frame.stem}.chk`};
        const output = mapped.files ?? defaultFiles();
        const gaussianText=buildGaussian(mapped);
        if (output.saveCheckpoint && (!request.independentRuntimeNames || /^%chk=/mi.test(gaussianText))) {
          const checkpoint = output.checkpointName.trim() || `${frame.stem}.chk`, previous = runtimeNames.get(checkpoint.toLowerCase());
          if (previous !== undefined) throw Error(`新CHK名称与第${previous + 1}项冲突，请使用逐结构独立名称。`);
          runtimeNames.set(checkpoint.toLowerCase(), index); entry.runtimeOutputNames = [checkpoint];
        }
        frameFiles = [{ name: `${frame.stem}.gjf`, text: gaussianText }];
      } else {
        const req = structuredClone(request.template.request), projection = applySharedOrcaConstraints(structure, req.settings, sharedConstraints);
        if (projection.errors.length) throw Error(projection.errors.join('\n'));
        const built = buildOrcaCommon({ ...req, structure, name: frame.stem, settings: projection.settings,
          charge: frame.electronicState.charge, multiplicity: frame.electronicState.multiplicity, electronicStateConfirmed: true });
        const failed = built.issues.filter(issue => issue.severity === 'error');
        if (failed.length) throw Error(failed.map(issue => issue.message).join('\n'));
        if (!built.files.length) throw Error('现有ORCA写出器未产生完整文件组。');
        warnings.push(...built.issues.filter(issue => issue.severity === 'warning').map(issue => issue.message));
        frameFiles = built.files.map(file => ({ name: file.name, text: file.text }));
        if(request.independentRuntimeNames)entry.runtimeOutputNames=[`${frame.stem}.gbw`,`${frame.stem}.out`];
      }
      entry.fileNames = frameFiles.map(file => file.name); manifest.frames.push(entry);
    } catch (cause) { issues.push(message(cause)); }
    items.push({ ...item, errors: issues, warnings, fileNames: frameFiles.map(file => file.name) });
    files.push(...frameFiles);
  });
  return finishPlan(items, errors, files, manifest, request.manifestStem ?? 'frame-inputs');
}

/** Caller resolves range/filter selection; this exact sequence is the scientific output order. */
export function prepareAdvancedFrameTrajectory(request: { frames: readonly AdvancedFrameSource[]; format: 'xyz' | 'extxyz'; stem: string }): AdvancedFrameOutputPlan {
  const items: AdvancedOutputItem[] = [], errors: string[] = [], chunks: string[] = [];
  const manifest: AdvancedOutputManifest = { schema: 'sciyue-advanced-frame-output', version: 1, kind: 'trajectory',
    format: request.format, ordering: 'explicit-frame-order', coordinateUnit: 'angstrom', frames: [] };
  try { requireStem(request.stem); if (!['xyz', 'extxyz'].includes(request.format)) throw Error('多帧科学导出仅支持XYZ/extXYZ。'); }
  catch (cause) { errors.push(message(cause)); }
  if (!request.frames.length) errors.push('请先明确选择需要导出的完整帧。');
  const filename = `${request.stem}.${request.format}`;
  request.frames.forEach((frame, index) => {
    const issues: string[] = [];
    try {
      const source = scientificSource(frame);
      if (request.frames.slice(0, index).some(previous => sameAdvancedFrame(previous.ref, source.ref))) throw Error('同一来源帧重复选择，请确认导出顺序。');
      const stateError = electronicStateError(source.structure.atoms, source.structure.charge!, source.structure.multiplicity!);
      if (stateError) throw Error(stateError);
      const { sharedConstraints } = frameConstraints(source);
      const text = exportStructure(source.structure, request.format, true), firstNewline = text.indexOf('\n'), secondNewline = text.indexOf('\n', firstNewline + 1);
      const identity = encodeURIComponent(JSON.stringify(source.ref));
      chunks.push(text.slice(0, secondNewline) + ` coordinate_unit="angstrom" output_frame=${index + 1} sciyue_frame_ref=${identity}` + text.slice(secondNewline));
      const entry = frameManifest(source, index + 1, sharedConstraints); entry.fileNames = [filename]; manifest.frames.push(entry);
    } catch (cause) { issues.push(message(cause)); }
    items.push({ order: index + 1, sourceRef: structuredClone(frame.ref), errors: issues, warnings: [], fileNames: issues.length ? [] : [filename] });
  });
  return finishPlan(items, errors, chunks.length ? [{ name: filename, text: chunks.join('') }] : [], manifest, request.stem);
}
