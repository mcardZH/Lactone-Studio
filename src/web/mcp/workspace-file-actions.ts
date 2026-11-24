import type { ChemistryPort, ModelDocument, ModelFormat } from '../../modeling/contracts';
import { automaticFilename } from '../../core/naming';
import { createChemistryPort } from '../../modeling/chemistry';
import { exportModel, getFormatDescriptors } from '../../modeling/platform/files';
import { launchSourceFile, type LaunchImportBridge, type LaunchSourceDescriptor } from '../../modeling/platform/launch-import';
import { resultFile, type ScientificSourceFile } from '../../results/input-file';
import type { PostprocessDocument, PostprocessScientificFileDocument } from '../../results/postprocess-document';
import { identifyPostprocessSource, postprocessFileJob } from '../../results/postprocess-sources';
import { postprocessDocumentFileSlots, type PostprocessSlotKey } from '../results/PostprocessSidebar';
import { isExcitationSlot } from '../results/postprocess-excitation-slots';
import type { usePostprocessWorkspace } from '../results/usePostprocessWorkspace';
import { mcpBridge } from './bridge';
import { toolError, type McCall } from './types';

export type WorkspaceImportMode = 'auto' | 'analysis' | 'structure';
export interface WorkspaceImportAgent {
  show: boolean;
  signal: AbortSignal;
  created(id: string): void;
  issues(messages: string[]): void;
}
export interface WorkspaceFileContext {
  importFiles(files: ScientificSourceFile[], mode: WorkspaceImportMode, agent: WorkspaceImportAgent): Promise<void>;
  postprocess(): Pick<ReturnType<typeof usePostprocessWorkspace>, 'read' | 'captureFileDocuments' | 'readExcitationFiles'>;
  modelAttachmentOwners(): readonly ModelAttachmentOwner[];
  attachmentEpoch(): number;
  captureStructure(target: string | undefined, signal: AbortSignal): Promise<{ document: ModelDocument; source: unknown; assertCurrent?(): void }>;
  chemistry?: ChemistryPort;
}

interface ModelAttachmentOwner {
  ownerId: string;
  document: PostprocessDocument;
  aliases: readonly (string | undefined)[];
  assertCurrent(): void;
}

type AttachmentTarget =
  | { scope: 'model-result'; ownerId: string; document: PostprocessDocument; assertCurrent(): void }
  | { scope: 'scientific-file'; ownerId: string; document: PostprocessScientificFileDocument; jobId?: string };

function attachmentTarget(context: WorkspaceFileContext, ref: string): AttachmentTarget {
  const files = context.postprocess().captureFileDocuments();
  if (ref.startsWith('["es-file-job",')) {
    let tuple: unknown;
    try { tuple = JSON.parse(ref); } catch { throw Error('文件作业引用格式无效。'); }
    if (!Array.isArray(tuple) || tuple.length !== 3 || typeof tuple[1] !== 'string' || typeof tuple[2] !== 'string') throw Error('文件作业引用格式无效。');
    const document = Object.hasOwn(files, tuple[1]) ? files[tuple[1]] : undefined;
    const job = document?.output.source.jobs.find(row => row.id === tuple[2]);
    if (!document || !job) throw toolError('SOURCE_TARGET_UNAVAILABLE', '文件作业来源已关闭或替换。', { requestedRef: ref });
    return { scope: 'scientific-file', ownerId: document.id, document, jobId: job.id };
  }
  const matches: AttachmentTarget[] = [];
  for (const document of Object.values(files)) {
    const source = document.output.source;
    const jobId = source.jobs.find(row => row.id === ref)?.id ?? (document.displayResult?.id === ref ? postprocessFileJob(source)?.id : undefined);
    if (document.id === ref || source.identity.id === ref) {
      matches.push({ scope: 'scientific-file', ownerId: document.id, document });
    } else if (jobId) {
      matches.push({ scope: 'scientific-file', ownerId: document.id, document, jobId });
    }
  }
  for (const candidate of context.modelAttachmentOwners()) {
    if ([candidate.ownerId, candidate.document.id, candidate.document.result.id, candidate.document.result.source.id, ...candidate.aliases].includes(ref)) {
      matches.push({ scope: 'model-result', ...candidate });
    }
  }
  if (matches.length > 1) throw toolError('SOURCE_TARGET_AMBIGUOUS', '此引用对应多个分析来源，请使用确切的所有者或文件作业引用。', {
    requestedRef: ref, owners: matches.map(row => row.ownerId),
  });
  if (!matches[0]) throw toolError('SOURCE_TARGET_UNAVAILABLE', '当前窗口没有此可写分析来源。', { requestedRef: ref });
  return matches[0];
}

function attachedFileJobs(document: PostprocessScientificFileDocument, slots: ReturnType<typeof postprocessDocumentFileSlots>) {
  const sourceIds = new Set(slots.map(slot => slot.sourceId));
  const ids = new Set<string>();
  if (document.pair && sourceIds.has(document.pair.wavefunction.result.source.id)) ids.add(document.pair.primary.result.id);
  for (const companion of document.companions ?? []) {
    const result = companion.source.result, jobId = result.scientific?.ircEvidence?.outputId;
    if (jobId && sourceIds.has(result.source.id) && !document.sourceWarnings?.some(warning => warning.sourceId === result.source.id)) ids.add(jobId);
  }
  return [...ids];
}

type SourceReplyItem = { index: number; source: LaunchSourceDescriptor } | { index: number; error: string; code?: string };
type Opened = { index: number; file: ScientificSourceFile };
type FileReceipt = { index: number; status: 'opened'; name: string } | { index: number; status: 'failed'; error: string; code?: string };
const formats = getFormatDescriptors({ purpose: 'structure' }).filter(format => format.id !== 'sciyue');
const humanError = (error: unknown) => error instanceof Error ? error.message : String(error);

function requireText(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${name} 需要非空文本。`);
  return value;
}

async function withSources<T extends object>(call: McCall, consume: (files: Opened[], receipts: FileReceipt[]) => Promise<T>): Promise<T & { cleanupWarnings?: string[] }> {
  call.signal.throwIfAborted();
  const desktop = window.sciyueDesktop as unknown as LaunchImportBridge | undefined;
  const bridge = mcpBridge();
  if (!bridge || !desktop?.readLaunchSource || !desktop.closeLaunchSource) throw Error('当前窗口没有受管文件读取入口。');
  const response = await bridge.file({ requestId: call.requestId, batchIndex:call.batchIndex, action: 'sources' }) as { items: SourceReplyItem[] } | LaunchSourceDescriptor[];
  const rows = Array.isArray(response) ? response.map((source, index) => ({ index, source })) : response.items;
  const handles = new Map<string, LaunchSourceDescriptor>();
  for (const row of rows) if ('source' in row && row.source?.token) handles.set(row.source.token, row.source);
  const opened: Opened[] = [];
  let failure: { cause: unknown } | undefined;
  let receipt: T | undefined;
  try {
    const receipts: FileReceipt[] = [];
    for (const row of rows) {
      call.signal.throwIfAborted();
      if ('error' in row) { receipts.push({ ...row, status: 'failed' }); continue; }
      const file = launchSourceFile(row.source, desktop);
      handles.delete(row.source.token);
      opened.push({ index: row.index, file });
      receipts.push({ index: row.index, status: 'opened', name: file.name });
    }
    receipt = await consume(opened, receipts);
  } catch (cause) { failure = { cause }; }
  const settled = await Promise.allSettled([
    ...opened.map(({ file }) => Promise.resolve().then(() => file.close?.())),
    ...[...handles.keys()].map(token => Promise.resolve().then(() => desktop.closeLaunchSource(token))),
  ]);
  const cleanupWarnings = settled.flatMap(row => row.status === 'rejected' ? [humanError(row.reason)] : []);
  if (failure) {
    if (!cleanupWarnings.length) throw failure.cause;
    const cause = failure.cause as { code?: string; data?: unknown } | undefined;
    const data = cause?.data && typeof cause.data === 'object' && !Array.isArray(cause.data)
      ? cause.data : cause?.data === undefined ? {} : { originalData: cause.data };
    throw toolError(cause?.code ?? 'ES_OPERATION_FAILED', humanError(failure.cause), { ...data, cleanupWarnings });
  }
  return { ...receipt!, ...(cleanupWarnings.length ? { cleanupWarnings } : {}) };
}

function actionMode(value: unknown): WorkspaceImportMode {
  if (value === undefined || value === 'auto') return 'auto';
  if (value === 'analysis' || value === 'structure') return value;
  throw Error('选择 auto、analysis 或 structure 导入模式。');
}

function attachRole(value: unknown): PostprocessSlotKey | 'companions' | undefined {
  if (value === undefined) return undefined;
  const role = requireText(value, 'role');
  return (role === 'companion' ? 'companions' : role) as PostprocessSlotKey | 'companions';
}

async function importGroups(opened: Opened[], mode: WorkspaceImportMode, signal: AbortSignal) {
  const files = opened.map(({ file }) => file);
  if (mode !== 'analysis' || files.length < 2) return [files];
  let primary = 0;
  for (const file of files) {
    signal.throwIfAborted();
    const input = resultFile(file);
    try {
      const recognized = await identifyPostprocessSource(input, { signal });
      if (recognized.kind === 'gaussian-output' || recognized.kind === 'orca-output') primary++;
    } catch { signal.throwIfAborted(); }
    finally { await input.close?.(); }
    if (primary > 1) return files.map(file => [file]);
  }
  return [files];
}

export function createWorkspaceFileActions(context: WorkspaceFileContext) {
  return {
    async importFiles(args: Record<string, unknown>, call: McCall, attach: boolean) {
      if (attach) {
        const requestedRef = requireText(args.result, 'result');
        const role = attachRole(args.role);
        const epoch = context.attachmentEpoch(), target = attachmentTarget(context, requestedRef);
        const { ownerId, document: existing, scope } = target;
        const requestedJobId = target.scope === 'scientific-file' ? target.jobId : undefined;
        const selectedJobId = target.scope === 'scientific-file' ? postprocessFileJob(target.document.output.source)?.id : undefined;
        const identity = { target: ownerId, requestedRef, scope, ...(requestedJobId ? { requestedJobId } : {}) };
        const guard = () => {
          call.signal.throwIfAborted();
          if (context.attachmentEpoch() !== epoch || target.scope === 'scientific-file' && context.postprocess().captureFileDocuments()[ownerId] !== target.document) {
            throw toolError('SOURCE_TARGET_CHANGED', '目标项目、文件或选定作业已变化，附件未接入。', identity);
          }
          if (target.scope === 'model-result') target.assertCurrent();
        };
        const slotKey = role === 'companions' ? undefined : role;
        if (scope === 'scientific-file' && isExcitationSlot(slotKey)) throw toolError('SOURCE_SLOT_UNAVAILABLE', 'ORCA 振幅文件槽由模型结果页面持有。', identity);
        if (requestedJobId && role === 'output') throw toolError('SOURCE_SLOT_SCOPE', '主 OUT 替换作用于整个文件来源，请指定文件引用。', identity);
        guard();
        return withSources(call, async ([selected]) => {
          if (!selected) throw Error('未打开指定配套来源。');
          guard();
          const postprocess = context.postprocess();
          const replace = args.replace === true;
          let slots: ReturnType<typeof postprocessDocumentFileSlots> | undefined;
          let boundJobIds: string[] = [];
          let committedSourceId: string | undefined;
          let committedSelectedJobId: string | undefined;
          let warnings = '';
          if (isExcitationSlot(slotKey)) {
            slots = await postprocess.readExcitationFiles([selected.file], slotKey, ownerId, { replace, signal: call.signal, guard });
          } else {
            const occupied = replace && role ? postprocessDocumentFileSlots(existing).filter(slot => slot.slotKey === role && slot.sourceId) : [];
            const replacementSlot = occupied.length === 1 ? { slotKey: occupied[0].slotKey, sourceId: occupied[0].sourceId } : undefined;
            await postprocess.read([selected.file], ownerId, undefined, replace ? 'replace' : 'smart', {
              signal: call.signal, guard, throwOnFailure: true, canNavigate: () => false,
              async beforeFileCommit(value, admitted) {
                committedSourceId = value.output.source.identity.id;
                committedSelectedJobId = postprocessFileJob(value.output.source)?.id;
                boundJobIds = attachedFileJobs(value, admitted ?? []);
                if (!requestedJobId) return;
                const evidence = { ...identity, selectedJobId, boundJobIds };
                if (admitted?.some(slot => slot.role === 'output')) throw toolError('SOURCE_SLOT_SCOPE', '主 OUT 替换作用于整个文件来源，请指定文件引用。', evidence);
                if (boundJobIds.length !== 1 || boundJobIds[0] !== requestedJobId) throw toolError('SOURCE_JOB_BINDING_UNVERIFIED', '附件未取得与指定作业的唯一原生对应。若只需保留为文件级来源，请使用文件引用。', evidence);
                if (target.scope === 'scientific-file') {
                  const retained = new Set(postprocessDocumentFileSlots(value).map(slot => slot.sourceId));
                  const removed = postprocessDocumentFileSlots(target.document).filter(slot => slot.sourceId && !retained.has(slot.sourceId));
                  if (removed.some(slot => {
                    const jobs = attachedFileJobs(target.document, [slot]);
                    return jobs.length !== 1 || jobs[0] !== requestedJobId;
                  })) throw toolError('SOURCE_SLOT_SCOPE', '所选替换会移除其他作业或文件共享附件，请指定整个文件来源。', evidence);
                }
              },
              attachToTarget: { role, replace, onAttached: (actual, notice) => { slots = actual; warnings = notice; } },
            }, replacementSlot);
          }
          if (!slots?.length) throw Error('配套文件未提交到目标分析。');
          return { status: 'attached', ...identity, ...(scope === 'scientific-file' ? { sourceId: committedSourceId, selectedJobId: committedSelectedJobId, boundJobIds } : {}), slots, warnings };
        });
      }
      const mode = actionMode(args.mode);
      return withSources(call, async (opened, sources) => {
        const createdIds: string[] = [];
        const issues = sources.flatMap(row => row.status === 'failed' ? [`文件 ${row.index + 1}：${row.error}`] : []);
        for (const files of opened.length ? await importGroups(opened, mode, call.signal) : []) {
          try {
            await context.importFiles(files, mode, {
              show: args.show !== false, signal: call.signal, created: id => createdIds.push(id), issues: messages => issues.push(...messages),
            });
          } catch (error) { call.signal.throwIfAborted(); issues.push(humanError(error)); }
        }
        call.signal.throwIfAborted();
        if (!createdIds.length && !issues.length) issues.push('导入未创建可用的模型、分析或诊断。');
        return { status: createdIds.length ? issues.length ? 'partial' : 'imported' : 'failed', mode, createdIds, sources, issues };
      });
    },

    async exportFile(args: Record<string, unknown>, call: McCall) {
      call.signal.throwIfAborted();
      const bridge = mcpBridge();
      if (!bridge) throw Error('当前窗口没有受管文件写入入口。');
      const requestedFormat = requireText(args.format, 'format').toLowerCase();
      const descriptor = formats.find(entry => entry.id === requestedFormat || entry.extensions.includes(requestedFormat));
      if (!descriptor) throw toolError('EXPORT_FORMAT_UNAVAILABLE', '当前结构导出入口不使用此格式。', { formats: formats.map(entry => entry.id) });
      const format: ModelFormat = descriptor.id;
      if (args.destination !== undefined && args.directory !== undefined) throw toolError('DESTINATION_CONFLICT', '请选择完整文件路径或目录。');
      if (args.destination !== undefined) requireText(args.destination, 'destination');
      if (args.directory !== undefined) requireText(args.directory, 'directory');
      const target = args.target === undefined ? undefined : requireText(args.target, 'target');
      const captured = await context.captureStructure(target, call.signal);
      call.signal.throwIfAborted();
      const { text, losses } = await exportModel(captured.document, format, { purpose: 'structure', withCell: true }, context.chemistry ?? createChemistryPort());
      if (losses.length && args.allowLosses !== true) throw toolError('EXPORT_LOSS_CONFIRMATION_REQUIRED', '所选格式有明确的结构数据损失，需要确认后导出。', { format, losses, source: captured.source });
      captured.assertCurrent?.();
      call.signal.throwIfAborted();
      const fileName = automaticFilename(captured.document.draft.structure.name, format === 'poscar' ? 'vasp' : descriptor.extensions[0], { fallback: 'structure' });
      const receipt = await bridge.file({ requestId: call.requestId, batchIndex:call.batchIndex, action: 'write', fileName, bytes: new TextEncoder().encode(text) }) as { status?: string };
      return { status: receipt.status ?? 'written', format, source: captured.source, losses, receipt };
    },
  };
}
