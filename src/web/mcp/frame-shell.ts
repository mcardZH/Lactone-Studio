import type { AdvancedTaskRecord } from '../../modeling/advanced/contracts';
import type { AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import type { WorkspaceDocumentEntry, WorkspaceRegistry } from '../../modeling/workspace-registry';
import type { PesFrame, PesPathRecord, PesRun } from '../../modeling/pes/contracts';
import { pesRecordedTrajectory, pesTrajectory } from '../../modeling/pes/result-adapter';
import type { PesResultFrameOrigin, TrajectoryResult } from '../../results/contracts';
import { trajectoryViewDocument } from '../../results/playback';
import type { PostprocessDocument, PostprocessScientificFileDocument } from '../../results/postprocess-document';
import { postprocessFileJob } from '../../results/postprocess-sources';
import { boundAdvancedCanvasResult } from '../advanced/capture-source';
import type { AnalysisCanvas } from '../results/analysis-canvas';
import type { TrajectoryPlaybackBridge } from '../results/trajectory-playback-bridge';
import type { FrameOwner, FrameToolContext } from './frame-tools';
import { viewTrajectoryCanvas } from './frame-tools';
import { toolError } from './types';

type ViewReceipt = ReturnType<typeof viewTrajectoryCanvas>;
export interface FrameShellPorts extends Pick<FrameToolContext, 'captureCurrent' | 'extract' | 'derive'> {
  registry: WorkspaceRegistry;
  projectEpoch(): string | number;
  activeTarget(): string | undefined;
  file(id: string): PostprocessScientificFileDocument | undefined;
  binding(id: string): PostprocessDocument | undefined;
  /** Only the viewport that currently owns presentation, including file-owned and legacy players. */
  canvas(id: string): AnalysisCanvas | undefined;
  /** Hidden retained panes may provide an existing stage; this callback never steers their player. */
  retainedCanvas?(id: string): AnalysisCanvas | undefined;
  cursor?(id: string): { resultId: string; frameIndex: number } | undefined;
  conformerTask?(id: string): AdvancedTaskRecord | undefined;
  resolveTarget?(ref: string): { targetId: string; collectionId?: string } | undefined;
  /** Materialize a real retained run collection without selecting a view or computing. */
  prepareRetainedCollection?(ref: string, signal?: AbortSignal): Promise<{ targetId: string; collectionId: string } | undefined>;
  pesRecord?(targetId: string, recordId: string): { run: PesRun; record: PesPathRecord;
    readFrame(frameId: string, seriesId: string, signal?: AbortSignal): Promise<PesFrame> } | undefined;
  retainedOptimization?(targetId: string, collectionId: string): PesRun | undefined;
  isClosing?(id: string): boolean;
  activate(owner: FrameOwner): void | Promise<void>;
}

export const pesRecordRef = (targetId: string, recordId: string) => JSON.stringify(['es-pes-record-v1', targetId, recordId]);
export function retainedOptimizationCollection(run: PesRun) {
  if(!run.retainTrajectory||run.request.operation!=='opt'||!run.workerSettled||!run.result?.frames.some(frame=>frame.seriesId==='opt'))return;
  const {groupId,runId}=run.request.runIdentity;
  return {collectionRef:JSON.stringify(['es-retained-opt-v1',groupId,runId]),collectionId:`${runId}:opt`};
}
export function parseOptimizationCollectionRef(ref: string): { groupId: string; runId: string } | undefined {
  if(!ref.startsWith('["es-retained-opt-v1",'))return;
  let value:unknown;
  try{value=JSON.parse(ref);}catch{throw Error('保留优化集合引用无效。');}
  if(!Array.isArray(value)||value.length!==3||typeof value[1]!=='string'||typeof value[2]!=='string')throw Error('保留优化集合引用无效。');
  return {groupId:value[1],runId:value[2]};
}
export const conformerRunCollectionId = (runId: string) => `${runId}:retained`;
export const conformerRunCollectionRef = (taskId: string, runId: string) => JSON.stringify(['es-conformer-run-v1', taskId, runId]);
export function parseConformerRunCollectionRef(ref: string): { taskId: string; runId: string } | undefined {
  if (!ref.startsWith('["es-conformer-run-v1",')) return;
  let value: unknown;
  try { value = JSON.parse(ref); } catch { throw Error('保留构象运行集合引用无效。'); }
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 'es-conformer-run-v1' ||
    typeof value[1] !== 'string' || !value[1].trim() || typeof value[2] !== 'string' || !value[2].trim())
    throw Error('保留构象运行集合引用无效。');
  return { taskId: value[1], runId: value[2] };
}
function namedScientificCollection(ref: string) {
  if (!ref.startsWith('["es-pes-record-v1",') && !ref.startsWith('["es-file-job",')) return undefined;
  let value: unknown;
  try { value = JSON.parse(ref); } catch { throw Error('科学集合引用无效。'); }
  if (!Array.isArray(value) || value.length !== 3 || typeof value[1] !== 'string' || typeof value[2] !== 'string')
    throw Error('科学集合引用无效。');
  return { targetId: value[1] as string, collectionId: value[2] as string,
    kind: value[0] === 'es-file-job' ? 'file-job' as const : 'pes-record' as const };
}

function samePesOwner(a?: PesResultFrameOrigin, b?: PesResultFrameOrigin) {
  return !!a && !!b && a.groupId === b.groupId && a.nodeId === b.nodeId && a.taskId === b.taskId && a.runId === b.runId && a.recordId === b.recordId;
}
function samePesRecord(a?: PesResultFrameOrigin, b?: PesResultFrameOrigin) {
  return !!a?.recordId && samePesOwner(a, b);
}

function sameSource(base: TrajectoryResult, view: TrajectoryResult): boolean {
  return base.source.id === view.source.id && base.source.sha256 === view.source.sha256
    && base.source.size === view.source.size && base.jobIndex === view.jobIndex;
}

function selectedIndex(entry: WorkspaceDocumentEntry, result: TrajectoryResult, canvas?: AnalysisCanvas, cursor?: { resultId: string; frameIndex: number }) {
  if (canvas?.result === result) return canvas.scientificFrameReady === false ? undefined : canvas.frameIndex;
  if (entry.trajectory && entry.legacyResult === result) {
    const index = entry.trajectory.frameIds.indexOf(entry.trajectory.currentFrameId);
    return index < 0 ? undefined : index;
  }
  if (cursor?.resultId === result.id) return cursor.frameIndex;
  return result.frames.length === 1 ? 0 : undefined;
}

function sameOwner(a: FrameOwner, b: FrameOwner) {
  return a.targetId === b.targetId && a.document.id === b.document.id && a.documentEpoch === b.documentEpoch
    && a.document.revision === b.document.revision && a.sourceEpoch === b.sourceEpoch
    && a.collection?.revision === b.collection?.revision && a.result === b.result;
}

const viewObservationMs = 1200;
const viewObservationStepMs = 25;
function waitForViewportTick(signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, viewObservationStepMs);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Frame targets use scientific owner versions. Viewport identity and cursor are independent. */
export function createFrameShell(getPorts: () => FrameShellPorts): FrameToolContext {
  const objectIds = new WeakMap<object, string>();
  const conformerIndex = new WeakMap<AdvancedTaskRecord, Map<string, AdvancedFrameSource>>();
  const fileDocuments = new WeakMap<TrajectoryResult, ReturnType<typeof trajectoryViewDocument>>();
  const recordResults = new WeakMap<PesPathRecord, TrajectoryResult>();
  let projectionCache = new WeakMap<object, { epoch: string; versions: Map<string, TrajectoryResult> }>();
  let projectEpoch: string | number | undefined;

  function token(object: object) {
    let id = objectIds.get(object);
    if (!id) { id = crypto.randomUUID(); objectIds.set(object, id); }
    return id;
  }
  function conformerFrames(task: AdvancedTaskRecord) {
    let frames = conformerIndex.get(task);
    if (!frames) {
      frames = new Map();
      for (const frame of task.guessFrames) frames.set(frame.id, frame.source);
      for (const run of task.runs) for (const frame of run.frames) frames.set(frame.id, frame.source);
      conformerIndex.set(task, frames);
    }
    return frames;
  }
  function assertCollection(result: TrajectoryResult | undefined, requested?: string) {
    if (requested && !result) throw Error('轨迹集合已关闭或来源已变化。');
    return result;
  }
  function collectionFor(targetId: string, result: TrajectoryResult, sourceRevision: string, collectionId = result.id, stageId?: string) {
    return { ownerId: targetId, collectionId, sourceId: result.source.id, sourceGeneration: 0,
      revision: sourceRevision, stageId: stageId ?? (result.stages?.length === 1 ? result.stages[0].id : result.frames[0]?.stageId ?? 'trajectory') };
  }
  function pickResult(target: object, epoch: string, base: TrajectoryResult | undefined, displayed: TrajectoryResult | undefined,
    requested?: string, alternateId?: string) {
    let cache = projectionCache.get(target);
    if (cache?.epoch !== epoch) {
      cache = { epoch, versions: new Map() };
      projectionCache.set(target, cache);
    }
    if (displayed && displayed !== base) cache.versions.set(displayed.id, displayed);
    if (!requested) return displayed ?? base;
    if (requested === base?.id || requested === alternateId) return base;
    return cache.versions.get(requested);
  }

  function locate(ports: FrameShellPorts, targetId?: string, collectionId?: string) {
    const input = targetId ?? ports.activeTarget();
    if (!input) throw Error('当前窗口没有结构或科学来源。');
    const named = namedScientificCollection(input);
    const knownOwner = ports.registry.getSnapshot().documents.some(row => row.id === input) || !!ports.file(input);
    const found = named ?? (knownOwner ? undefined : ports.resolveTarget?.(input));
    if (named && collectionId && named.collectionId !== collectionId)
      throw toolError('collection_conflict', '对象引用与指定科学集合不一致。', {
        targetRef: input, collectionId, expectedCollectionId: named.collectionId, committed: false,
        recovery: { tool: 'frames_select', arguments: { targetRef: input } },
      });
    return { targetId: found?.targetId ?? input, collectionId: collectionId ?? found?.collectionId, kind: named?.kind };
  }

  function selectedPesRecord(ports: FrameShellPorts, targetId: string, collectionId?: string) {
    const canvas = ports.canvas(targetId) ?? ports.retainedCanvas?.(targetId);
    const selectedId = canvas?.result?.frames[canvas.frameIndex ?? 0]?.pesOrigin?.recordId;
    const id = collectionId ?? selectedId;
    return id ? ports.pesRecord?.(targetId, id) : undefined;
  }

  function prepareOwner(targetId?: string, collectionId?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const ports = getPorts(), epoch = ports.projectEpoch();
    const retained = targetId && parseConformerRunCollectionRef(targetId);
    if (retained) {
      if (collectionId && collectionId !== conformerRunCollectionId(retained.runId)) throw Error('对象引用与指定保留运行集合不一致。');
      if (!ports.prepareRetainedCollection) throw Error('当前窗口尚未接入保留构象集合。');
      return ports.prepareRetainedCollection(targetId!, signal).then(prepared => {
        signal?.throwIfAborted();
        if (getPorts().projectEpoch() !== epoch) throw Error('准备期间所属项目已变化。');
        if (!prepared || prepared.collectionId !== conformerRunCollectionId(retained.runId)) throw Error('保留构象运行已关闭或集合尚不可用。');
        // Read the actual registered owner now. A callback receipt alone cannot
        // make a missing, replaced or unrelated collection available.
        const current = owner(prepared.targetId, prepared.collectionId);
        if (!current.result || current.collection?.collectionId !== prepared.collectionId) throw Error('保留构象集合尚未由工作台实际接管。');
        return prepared;
      });
    }
    const target = locate(ports, targetId, collectionId);
    if (ports.isClosing?.(target.targetId)) throw Error('目标正在关闭。');
    const selected = selectedPesRecord(ports, target.targetId, target.collectionId);
    if (target.kind === 'pes-record' && !selected) throw Error('指定的原生路径轮已关闭或不属于此节点。');
    const first = selected?.record.frames[0];
    if (!selected || !first) return;
    const prepared = { targetId: target.targetId, collectionId: selected.record.id };
    if (recordResults.has(selected.record)) return prepared;
    return selected.readFrame(first.id, first.seriesId, signal).then(frame => {
      signal?.throwIfAborted();
      const latest = getPorts();
      if (latest.projectEpoch() !== epoch || latest.pesRecord?.(target.targetId, selected.record.id)?.record !== selected.record)
        throw Error('读取期间路径轮的所有者或版本已变化。');
      if (!recordResults.has(selected.record)) recordResults.set(selected.record, pesRecordedTrajectory(selected.run, selected.record, frame, selected.readFrame));
      return prepared;
    });
  }

  function owner(targetId?: string, requestedCollection?: string): FrameOwner {
    const ports = getPorts(), epoch = ports.projectEpoch();
    if (projectEpoch !== epoch) { projectEpoch = epoch; projectionCache = new WeakMap(); }
    const located = locate(ports, targetId, requestedCollection);
    const target = located.targetId;
    requestedCollection = located.collectionId;
    if (ports.isClosing?.(target)) throw Error('目标正在关闭。');
    const activeCanvas = ports.canvas(target);
    const candidateCanvas = activeCanvas ?? ports.retainedCanvas?.(target);
    const canvas = candidateCanvas?.displayOnlySourcePreview ? undefined : candidateCanvas;
    const file = ports.file(target);
    if (located.kind === 'file-job' && !file) throw Error('指定的文件来源已关闭。');
    if (file) {
      const chosen = requestedCollection && file.output.source.jobs.find(job => job.id === requestedCollection);
      if (located.kind === 'file-job' && !chosen) throw Error('指定的 Job 已关闭或来源已变化。');
      if (chosen && (chosen.kind === 'diagnostic' || !chosen.frames.length)) throw Error('所选文件 Job 没有完整科学结构。');
      const selectedJob = postprocessFileJob(file.output.source);
      const declaredJob = chosen || selectedJob;
      const outputJob = declaredJob && { id: declaredJob.id, index: declaredJob.jobIndex,
        sourceId: file.output.source.identity.id, sourceRevision: file.output.source.identity.sha256 };
      const displayedBase = file.displayResult;
      const fileToken = token(file), fileSourceEpoch = JSON.stringify([epoch, fileToken, displayedBase ? token(displayedBase) : null]);
      const displayed = displayedBase && canvas?.result && sameSource(displayedBase, canvas.result) ? canvas.result : undefined;
      const picked = chosen || pickResult(file, fileSourceEpoch, displayedBase, displayed, requestedCollection);
      const candidate = assertCollection(picked, requestedCollection);
      if (!candidate) throw Error('当前科学文件的作业没有可靠的完整结构。');
      const exactJob = declaredJob && declaredJob.kind !== 'diagnostic' && candidate.id === declaredJob.id ? declaredJob : undefined;
      const result = exactJob ?? candidate;
      const fileEpoch = exactJob ? file.id : fileToken;
      const sourceEpoch = exactJob ? JSON.stringify([epoch, file.id, file.output.source.identity.sha256, token(result)]) : fileSourceEpoch;
      let viewDocument = fileDocuments.get(result);
      if (!viewDocument) {
        viewDocument = trajectoryViewDocument(result, result.initialStructure, 0);
        fileDocuments.set(result, viewDocument);
      }
      const document = { ...viewDocument, id: file.id };
      return {
        targetId: target, document, documentEpoch: fileEpoch, sourceEpoch, result, outputJob, selectOutputJob: !!exactJob,
        label: file.output.source.identity.name, collection: collectionFor(target, result, token(result)),
        currentIndex: activeCanvas?.result === result && activeCanvas.scientificFrameReady !== false ? activeCanvas.frameIndex : undefined,
      };
    }

    const entry = ports.registry.document(target);
    const optimization = requestedCollection && ports.retainedOptimization?.(target,requestedCollection);
    if(optimization){
      const result=pesTrajectory(optimization,'opt')?.result;
      if(!result||result.id!==requestedCollection)throw Error('保留优化轨迹不可用。');
      const visible=activeCanvas?.scientificFrameReady===false?undefined:activeCanvas?.result?.frames[activeCanvas.frameIndex??0]?.pesOrigin;
      const index=visible&&samePesOwner(result.frames[0]?.pesOrigin,visible)?result.frames.findIndex(frame=>frame.pesOrigin?.frameId===visible.frameId):-1;
      let snapshot=fileDocuments.get(result);
      if(!snapshot){snapshot=trajectoryViewDocument(result,result.initialStructure,0);fileDocuments.set(result,snapshot);}
      return {targetId:target,document:{...snapshot,id:entry.id,revision:entry.store.getSnapshot().revision},documentEpoch:entry.epoch,
        sourceEpoch:JSON.stringify([epoch,entry.epoch,optimization.request.id,token(result)]),label:result.label,result,
        collection:collectionFor(target,result,token(result),requestedCollection),currentIndex:index<0?undefined:index};
    }
    const record = selectedPesRecord(ports, target, requestedCollection);
    const recordResult = record && recordResults.get(record.record);
    if (recordResult) {
      const pes = recordResult.frames[0].pesOrigin!;
      const visible = activeCanvas?.result?.frames[activeCanvas.frameIndex ?? 0]?.pesOrigin;
      const index = activeCanvas?.scientificFrameReady !== false && samePesRecord(pes, visible)
        ? recordResult.frames.findIndex(frame => frame.pesOrigin?.frameId === visible?.frameId) : -1;
      let snapshot = fileDocuments.get(recordResult);
      if (!snapshot) {
        snapshot = trajectoryViewDocument(recordResult, recordResult.initialStructure, 0);
        fileDocuments.set(recordResult, snapshot);
      }
      return {
        targetId: target, document: { ...snapshot, id: entry.id, revision: entry.store.getSnapshot().revision }, documentEpoch: entry.epoch,
        sourceEpoch: JSON.stringify([epoch, entry.epoch, pes.runId, pes.recordId, token(recordResult)]),
        label: recordResult.label, result: recordResult,
        collection: collectionFor(target, recordResult, token(recordResult), pes.recordId),
        currentIndex: index < 0 ? undefined : index,
      };
    }
    if (record && requestedCollection) throw Error('路径轮正在准备。');
    const document = entry.store.getSnapshot();
    const analysisAvailable = ports.registry.analysisAvailable(target);
    const binding = analysisAvailable ? ports.binding(target) : undefined;
    const registered = entry.result ?? (analysisAvailable ? entry.legacyResult ?? binding?.result ?? entry.analysisBinding?.result : undefined);
    const separatePes = entry.pesGroup && !registered && canvas?.result && !canvas.displayOnlySourcePreview ? canvas.result : undefined;
    const displayed = canvas?.result && (registered && sameSource(registered, canvas.result) || boundAdvancedCanvasResult(binding, canvas) || separatePes)
      ? canvas.result : undefined;
    const base = registered ?? separatePes;
    const sourceEpoch = JSON.stringify([epoch, entry.epoch, entry.sourceEpoch, base ? token(base) : null, binding ? token(binding) : null]);
    const result = assertCollection(pickResult(entry, sourceEpoch, base, displayed, requestedCollection, entry.trajectory?.identity.collectionId), requestedCollection);
    if (!result && (entry.result || entry.legacyResult || entry.trajectory))
      throw Error('当前结果因模型来源已修改而不可用。');
    if (!result && (entry.store.hasTransaction?.() || entry.store.isRuntimeSessionActive?.()
      || ['starting', 'running', 'pausing', 'paused', 'stopping'].includes(entry.runtime.phase))) throw Error('当前模型正在运行或编辑，请先结束后读取完整结构。');
    const conformer = result && entry.trajectory && entry.legacyResult === result ? entry.trajectory : undefined;
    const task = conformer && ports.conformerTask?.(conformer.identity.taskId);
    const originalFrames = task ? conformerFrames(task) : undefined;
    const output = binding?.output?.source;
    const resultJob = result && output && [output.result, ...output.results].find(job =>
      job.jobIndex === result.jobIndex && job.source.id === result.source.id);
    const outputJob = resultJob && { id: resultJob.id, index: resultJob.jobIndex,
      sourceId: resultJob.source.id, sourceRevision: resultJob.source.sha256 };
    return {
      targetId: target, document, documentEpoch: entry.epoch, sourceEpoch, label: entry.label, result, outputJob,
      collection: result && collectionFor(target, result, token(result), conformer?.identity.collectionId, conformer?.identity.stageId),
      currentIndex: result && selectedIndex(entry, result, canvas, ports.cursor?.(target)),
      ...(conformer && originalFrames ? { advancedFrame: (index: number) => originalFrames.get(conformer.frameIds[index]) } : {}),
    };
  }

  function nativeCanvas(expected: FrameOwner): AnalysisCanvas | undefined {
    const canvas = getPorts().canvas(expected.targetId);
    if (canvas?.result && canvas.trajectoryPlayback && !canvas.displayOnlySourcePreview) return canvas;
  }
  function activeCanvas(expected: FrameOwner, stageResultId?: string): AnalysisCanvas | undefined {
    const canvas = nativeCanvas(expected);
    const source = expected.result, shown = canvas?.result;
    if (source && shown && (!stageResultId || shown.id === stageResultId) && (shown === source ||
      samePesRecord(source.frames[0]?.pesOrigin, shown.frames[0]?.pesOrigin) ||
      sameSource(source, shown) && (shown.id === source.id || shown.id.startsWith(`${source.id}:stage:`)))) return canvas;
  }
  function presentationIndex(expected: FrameOwner, canvas: AnalysisCanvas | undefined, index: number) {
    const source = expected.result, shown = canvas?.result;
    if (source && source === shown) return index;
    const original = source?.frames[index];
    if (!original || !shown) return undefined;
    const ordinal = original.sourceFrameIndex ?? original.index, pes = original.pesOrigin;
    const mapped = shown.frames.findIndex(frame => pes
      ? samePesOwner(pes, frame.pesOrigin) && frame.pesOrigin?.frameId === pes.frameId && frame.pesOrigin?.seriesId === pes.seriesId
      : (frame.sourceFrameIndex ?? frame.index) === ordinal && frame.sourceLine === original.sourceLine);
    return mapped < 0 ? undefined : mapped;
  }
  const superseded = (expected: FrameOwner, requestId?: string) => ({
    status: 'superseded', requestId: requestId ?? null, targetId: expected.targetId,
    collectionId: expected.collection?.collectionId ?? null,
  });
  const targeted = (expected: FrameOwner, receipt: ViewReceipt) => ({
    ...receipt, targetId: expected.targetId, collectionId: expected.collection?.collectionId ?? null,
  });
  function stillOwned(expected: FrameOwner) {
    try { return sameOwner(expected, owner(expected.targetId, expected.collection?.collectionId)); }
    catch { return false; }
  }

  return {
    owner,
    prepareOwner,
    captureCurrent: () => getPorts().captureCurrent(),
    extract: (...args) => getPorts().extract(...args),
    derive: result => getPorts().derive(result),
    async view(expected, command, requestId, signal, waitFor = 'scene') {
      signal?.throwIfAborted();
      if (!command) {
        const canvas = activeCanvas(expected);
        if (requestId && (!canvas || getPorts().activeTarget() !== expected.targetId)) return superseded(expected, requestId);
        return targeted(expected, viewTrajectoryCanvas(canvas, undefined, requestId));
      }
      if (!stillOwned(expected)) return superseded(expected);
      const deadline = performance.now() + viewObservationMs;
      if (!nativeCanvas(expected) || getPorts().activeTarget() !== expected.targetId || expected.selectOutputJob && !activeCanvas(expected))
        await getPorts().activate(expected);
      const activationEpoch = getPorts().registry.getSnapshot().activationEpoch;
      const sameActivation = () => getPorts().registry.getSnapshot().activationEpoch === activationEpoch && getPorts().activeTarget() === expected.targetId;
      let route: ReturnType<NonNullable<TrajectoryPlaybackBridge['routeFrame']>>;
      let recordRoute: { current(): boolean } | undefined;
      let attemptedRoute: TrajectoryResult | undefined, mappedResult: TrajectoryResult | undefined;
      let canvas = activeCanvas(expected), nativeIndex: number | undefined;
      const mapIndex = () => {
        if (command.action === 'seek' && canvas?.result !== mappedResult) {
          mappedResult = canvas?.result;
          nativeIndex = presentationIndex(expected, canvas, command.index);
        }
      };
      mapIndex();
      const awaiting = () => !canvas || command.action === 'seek' && (nativeIndex === undefined || canvas.trajectoryPlayback?.state.seekDisabled);
      while (awaiting() && performance.now() < deadline) {
        const pes = command.action === 'seek' ? expected.result?.frames[command.index]?.pesOrigin : undefined;
        if (!recordRoute && !canvas && pes?.recordId) recordRoute = getPorts().canvas(expected.targetId)?.selectPesRecord?.(pes);
        if (!route && command.action === 'seek' && nativeIndex === undefined && expected.result) {
          const live = nativeCanvas(expected);
          if (live?.result && live.result !== attemptedRoute) {
            attemptedRoute = live.result;
            route = live.trajectoryPlayback?.routeFrame?.(expected.result, command.index);
          }
        }
        await waitForViewportTick(signal);
        if (!sameActivation() || !stillOwned(expected) || route && !route.current() || recordRoute && !recordRoute.current()) return superseded(expected);
        canvas = activeCanvas(expected, route?.resultId);
        mapIndex();
      }
      signal?.throwIfAborted();
      if (!sameActivation() || !stillOwned(expected) || route && !route.current() || recordRoute && !recordRoute.current()) return superseded(expected);
      if (command.action === 'seek' && nativeIndex === undefined)
        return { status: route || recordRoute ? 'preparing-stage' : 'view-unavailable', targetId: expected.targetId,
          collectionId: expected.collection?.collectionId ?? null, requestedIndex: command.index,
          reason: route || recordRoute ? '原生视图正在准备目标阶段。' : '目标帧未关联到当前可用的原生阶段。' };
      const applied = command.action === 'seek' ? { ...command, index: nativeIndex! } : command;
      let result: ViewReceipt = viewTrajectoryCanvas(canvas, applied);
      const navigationRequest = 'requestId' in result ? result.requestId : undefined;
      if (!navigationRequest || command.action !== 'seek') return targeted(expected, result);
      while (result.status === 'preparing' || result.status === 'awaiting-scene' && waitFor === 'scene') {
        if (performance.now() >= deadline) break;
        await waitForViewportTick(signal);
        if (!sameActivation() || !stillOwned(expected) || route && !route.current() || recordRoute && !recordRoute.current()) return superseded(expected, navigationRequest);
        const current = activeCanvas(expected, route?.resultId);
        if (!current || current.result !== canvas?.result) return superseded(expected, navigationRequest);
        result = viewTrajectoryCanvas(current, undefined, navigationRequest);
      }
      if (waitFor === 'selected' && result.status === 'awaiting-scene' && 'current' in result &&
        result.current.index === nativeIndex && result.current.scientificFrameReady)
        return { ...targeted(expected, result), status: 'selected' };
      return targeted(expected, result);
    },
  };
}
