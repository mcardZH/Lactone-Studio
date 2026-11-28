import type { WorkspaceDocumentEntry } from '../../modeling/workspace-registry';
import { editableNodeDisplayRun, structureForPesFrame, workbenchPartialTsFrame, type PesController } from '../../modeling/pes/controller';
import type { PesFrameSelection, PesGeometry, PesGroup, PesNode } from '../../modeling/pes/contracts';
import { pesId } from '../../modeling/pes/defaults';
import { pesSourceFfModel } from '../../modeling/pes/ff-model';
import { pesPathRecords } from '../../modeling/pes/path-records';
import type { AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import type { TrajectoryResult } from '../../results/contracts';
import type { PostprocessScientificFileDocument } from '../../results/postprocess-document';
import { postprocessFileJob } from '../../results/postprocess-sources';
import type { ObservedPostprocessFrame } from '../results/PostprocessResultView';
import { pesNodeObserving } from './pes-canvas-publication';
import { getPreparedTrajectoryFrame } from '../../results/prepared-trajectory';
import { readScientificTrajectoryFrame, scientificFrameForModel } from './scientific-frame-source';
import { isOrdinaryPesTabCandidate } from '../../modeling/pes/tab-admission';

export interface PesTabSnapshotSource {
  key: string;
  label: string;
  pesNode?: WorkspaceDocumentEntry['pesGroup'];
  ordinaryCandidate?: { documentId: string; groupId?: string };
  read(signal: AbortSignal): Promise<PesGeometry>;
}

interface TabSnapshotPorts {
  lookup(id: string): WorkspaceDocumentEntry | undefined;
  closing(id: string): boolean;
  candidateGroup?(id: string): string | undefined;
  controller: PesController | null | undefined;
  /** Undefined for a tab that has never published a result. Null blocks fallback
   * when a presented result has no attributable complete frame. */
  pesFrame?(entry: WorkspaceDocumentEntry): PesGeometry | null | undefined;
  conformer(entry: WorkspaceDocumentEntry): AdvancedFrameSource | undefined;
  result(entry: WorkspaceDocumentEntry): { result: TrajectoryResult; index: number | undefined } | undefined;
}

export interface PesFileObservation {
  readonly epoch: string;
  /** Undefined until first visible, null when the visible cursor is unready. */
  frame: ObservedPostprocessFrame | null | undefined;
  defaultFrame?: ObservedPostprocessFrame;
}

export function publishPesFileObservation(owner: PesFileObservation, frame: ObservedPostprocessFrame | null, kind?: 'default') {
  if (kind === 'default') {
    if (owner.frame === undefined) owner.defaultFrame = frame ?? undefined;
  } else {
    owner.frame = frame;
    owner.defaultFrame = undefined;
  }
}

/** A file source keeps its own job/reader. Only the exact observed stage frame
 * is borrowed, even when several jobs or companion paths share the page. */
export function pesFileSnapshotSources(
  documents: readonly PostprocessScientificFileDocument[],
  lookup: (id: string) => PostprocessScientificFileDocument | undefined,
  observation: (document: PostprocessScientificFileDocument) => PesFileObservation,
): PesTabSnapshotSource[] {
  return documents.flatMap(document => {
    if (!document.displayResult?.frames.length) return [];
    const output = document.output.source, selectedJob = postprocessFileJob(output);
    if (!selectedJob) return [];
    const owner = observation(document);
    const label = output.jobs.length > 1 ? selectedJob.label : output.identity.name;
    return [{
      key: JSON.stringify(['scientific-file-tab', document.id, owner.epoch]), label,
      async read(signal: AbortSignal) {
        const guard = () => {
          if (signal.aborted) throw Error('来源读取已取消。');
          if (lookup(document.id) !== document || observation(document) !== owner)
            throw Error('来源文件或作业已关闭或切换，请重新选择。');
        };
        guard();
        const currentFrame = () => owner.frame === undefined ? owner.defaultFrame : owner.frame;
        const frame = currentFrame(), summary = frame?.result.frames[frame.index];
        if (!frame || !summary) throw Error('来源文件的当前帧尚未就绪，请在后处理页选择一个完整结果帧。');
        const { result, index } = frame;
        const raw = await readScientificTrajectoryFrame(result, index, signal);
        guard();
        if (currentFrame() !== frame) throw Error('读取期间来源帧已切换，请重新选择。');
        const structure = scientificFrameForModel(raw, getPreparedTrajectoryFrame(result,index));
        const sourceId = summary.geometrySource?.id ?? result.source.id;
        const geometrySource = sourceId === result.source.id ? result.source
          : document.companions?.find(item => item.source.result.source.id === sourceId)?.source.result.source;
        const sourceRevision = (sourceId === output.identity.id ? output.identity.sha256 : undefined) ?? geometrySource?.sha256;
        const outputJobId = result.scientific?.ircEvidence?.outputId ?? frame.sourceResultId;
        const job = output.jobs.find(candidate => candidate.id === outputJobId) ?? selectedJob;
        const sourceFrameIndex = summary.geometrySource?.sourceFrameIndex ?? summary.sourceFrameIndex ?? index;
        return finishTabSnapshot({
          documentId: document.id, revision: 0, label: `${label} · 快照`, structure,
          originFrame: {
            documentId: document.id, documentEpoch: owner.epoch, revision: 0, sourceId, sourceRevision,
            outputJob: { sourceId: output.identity.id, sourceRevision: output.identity.sha256, id: job.id, index: job.jobIndex },
            collectionId: frame.collectionId, stageId: frame.stageId, frameId: frame.frameId, sourceFrameIndex,
          },
        });
      },
    }];
  });
}

function finishTabSnapshot(geometry: PesGeometry): PesGeometry {
  const { structure } = geometry;
  if (!structure.atoms.length || structure.dimension === 2 || structure.periodicSource?.completeness === 'partial'
    || structure.atoms.some(atom => !atom.id || ![atom.x, atom.y, atom.z].every(Number.isFinite)))
    throw Error('来源需要真实三维坐标，周期结构需要完整晶胞。');
  // Selection never activates the source tab or binds the card to later edits.
  return { ...geometry, inputSnapshotId: pesId('tab-snapshot') };
}

function initialResultFrame(group: PesGroup, node: PesNode): PesFrameSelection | undefined {
  const run = node.kind === 'initial' || node.kind === 'workbench'
    ? editableNodeDisplayRun(group, node.id) : group.runs[node.followRunId ?? ''];
  if (!run || run.nodeId !== node.id) return;
  const record = pesPathRecords(run)[0];
  const recorded = record?.frames[0];
  const frame = recorded ?? workbenchPartialTsFrame(run) ?? (run.result?.frames ?? run.acceptedFrames)?.[0];
  if (frame) return { runId: run.request.id, seriesId: frame.seriesId, frameId: frame.id,
    ...(recorded ? { recordId: record.id } : {}) };
}

function sealPesDraft(entry: WorkspaceDocumentEntry, structure: PesGeometry['structure']) {
  if (entry.store.hasTransaction?.()) throw Error('请先完成来源标签的几何预览，再记录快照。');
  return structure;
}

export function readEditablePesSource(entry: WorkspaceDocumentEntry, geometry: PesGeometry): PesGeometry {
  const model = entry.store.getSnapshot();
  return { ...geometry, documentId: entry.id, revision: model.revision, structure: sealPesDraft(entry, model.draft.structure),
    source: entry.pesGroup ? { groupId: entry.pesGroup.groupId, nodeId: entry.pesGroup.nodeId } : undefined };
}

type PesSnapshotBase = Pick<PesGeometry, 'documentId' | 'revision' | 'label'>;

/** Result lookup is shared by open same-group and cross-group sources, including
 * hidden tabs. Only a never-presented tab can use the controller's frame index. */
async function readPesNodeSnapshot(
  controller: PesController, groupId: string, nodeId: string, signal: AbortSignal,
  tab?: { entry: WorkspaceDocumentEntry; base: PesSnapshotBase; readSubmitted(): PesGeometry | null | undefined },
): Promise<PesGeometry> {
  const findGroup = () => controller.getSnapshot().groups.find(group => group.id === groupId);
  const group = findGroup(), node = group?.nodes.find(row => row.id === nodeId);
  if (!group || !node) throw Error('来源势能面标签已关闭，请重新选择。');
  const source = { groupId, nodeId };
  const base = tab?.base ?? { documentId: node.geometry.documentId, revision: node.geometry.revision, label: node.name };
  if (node.kind === 'snapshot') return { ...node.geometry, ...base, source: node.geometry.source ?? source };
  if (!pesNodeObserving(group, node)) return tab
    ? readEditablePesSource(tab.entry, { ...node.geometry, ...base })
    : { ...node.geometry, ...base, source };

  const submitted = tab?.readSubmitted();
  if (submitted === null) throw Error('请在来源势能面标签选择一个完整结果帧。');
  if (submitted) {
    const origin = submitted.source;
    if (submitted.documentId !== base.documentId || submitted.revision !== base.revision
      || origin?.groupId !== groupId || origin.nodeId !== nodeId || !origin.frameId || !origin.seriesId || !origin.runId
      || group.runs[origin.runId]?.nodeId !== nodeId || !node.runIds.includes(origin.runId))
      throw Error('来源标签或运行已变化，请重新选择。');
    return { ...structuredClone(submitted), ...base };
  }
  const selection = controller.getFrameSelection(groupId, nodeId) ?? initialResultFrame(group, node);
  const run = selection && group.runs[selection.runId];
  if (!selection || !run || run.nodeId !== nodeId) throw Error('请在来源势能面标签选择一个完整结果帧。');
  const frame = await controller.readFrame(groupId, selection.runId, selection.seriesId, selection.frameId, signal, selection.recordId);
  const currentGroup = findGroup(), currentNode = currentGroup?.nodes.find(row => row.id === nodeId);
  // The chosen identity stays fixed while the source owner prepares that frame.
  if (!currentNode?.runIds.includes(selection.runId) || currentGroup?.runs[selection.runId]?.request !== run.request)
    throw Error('读取期间来源运行已变化，请重新选择。');
  const ref = { ...source, ...selection };
  return { ...base, source: ref, structure: structureForPesFrame(run.request.structure, frame),
    ffModel: pesSourceFfModel(group, { ...run.source, source: ref }) };
}

export function pesGroupSnapshotSources(
  group: PesGroup, controller: PesController, tabs: readonly PesTabSnapshotSource[],
): PesTabSnapshotSource[] {
  const openNodes = new Map<string, PesTabSnapshotSource>();
  for (const tab of tabs) if (tab.pesNode?.groupId === group.id) openNodes.set(tab.pesNode.nodeId, tab);
  return group.nodes.map(node => ({
    key: JSON.stringify(['pes-node', group.id, node.id]), label: node.name,
    async read(signal: AbortSignal) {
      const tab = openNodes.get(node.id);
      if (tab) return tab.read(signal);
      if (signal.aborted) throw Error('来源读取已取消。');
      const geometry = await readPesNodeSnapshot(controller, group.id, node.id, signal);
      if (signal.aborted) throw Error('来源读取已取消。');
      return finishTabSnapshot(geometry);
    },
  }));
}

/** Reading an option captures the tab's current scientific geometry just once. */
export function pesTabSnapshotSources(entries: readonly WorkspaceDocumentEntry[], ports: TabSnapshotPorts): PesTabSnapshotSource[] {
  return entries.flatMap(tab => {
    if (!tab.pesGroup && !tab.result && !tab.legacyResult && !tab.trajectory && !tab.store.getSnapshot().draft.structure.atoms.length) return [];
    const ordinaryCandidate = isOrdinaryPesTabCandidate(tab) ? { documentId: tab.id, groupId: ports.candidateGroup?.(tab.id) } : undefined;
    return [{
      key: JSON.stringify(['workspace-tab', tab.id, tab.epoch]), label: tab.label, pesNode: tab.pesGroup, ordinaryCandidate,
      async read(signal: AbortSignal) {
        const entry = ports.lookup(tab.id);
        if (!entry || entry.epoch !== tab.epoch || ports.closing(tab.id)) throw Error('来源标签已关闭，请重新选择。');
        const model = entry.store.getSnapshot(), sourceEpoch = entry.sourceEpoch;
        const base = { documentId: entry.id, revision: model.revision, label: `${entry.label} · 快照` };
        const guard = () => {
          const current = ports.lookup(tab.id);
          if (signal.aborted) throw Error('来源读取已取消。');
          if (!current || current.epoch !== entry.epoch || ports.closing(tab.id)
            || current.sourceEpoch !== sourceEpoch || current.store.getSnapshot().revision !== model.revision)
            throw Error('读取期间来源标签或结构已变化，请重新选择。');
        };
        guard();
        let geometry: PesGeometry;
        if (entry.pesGroup) {
          const { groupId, nodeId } = entry.pesGroup;
          if (!ports.controller) throw Error('来源势能面标签已关闭，请重新选择。');
          geometry = await readPesNodeSnapshot(ports.controller, groupId, nodeId, signal,
            { entry, base, readSubmitted: () => ports.pesFrame?.(entry) });
        } else if (ordinaryCandidate?.groupId && isOrdinaryPesTabCandidate(entry)) {
          geometry = { ...base, structure: sealPesDraft(entry, model.draft.structure) };
        } else if (entry.trajectory) {
          const current = ports.conformer(entry);
          if (!current) throw Error('当前构象帧尚未准备，请在来源标签选择完整帧。');
          geometry = { ...base, structure: current.structure, originFrame: current.ref };
        } else {
          const observed = ports.result(entry);
          if (!observed) {
            if (entry.result) throw Error('请在来源标签选择一个完整结果帧。');
            geometry = { ...base, structure: sealPesDraft(entry, model.draft.structure) };
          } else {
            const { result, index } = observed, summary = index === undefined ? undefined : result.frames[index];
            if (!summary || index === undefined) throw Error('请在来源标签选择一个完整结果帧。');
            const structure = await readScientificTrajectoryFrame(result, index, signal);
            const current = ports.lookup(tab.id), observedNow = current && ports.result(current);
            if (!observedNow || observedNow.result !== result || observedNow.index !== index)
              throw Error('读取期间来源帧已切换，请重新选择。');
            geometry = { ...base, structure, originFrame: {
              documentId: entry.id, documentEpoch: entry.epoch, revision: model.revision, sourceId: result.source.id,
              sourceRevision: result.source.sha256, collectionId: result.id, stageId: summary.stageId,
              frameId: `${result.id}:${summary.sourceFrameIndex ?? index}`, sourceFrameIndex: summary.sourceFrameIndex ?? index,
            } };
          }
        }
        guard();
        return finishTabSnapshot(geometry);
      },
    }];
  });
}
