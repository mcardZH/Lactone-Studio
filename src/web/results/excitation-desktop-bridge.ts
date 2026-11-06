import type { Structure } from '../../core/types';
import { registerAnalysisRuntimeOwner } from '../../modeling/application/analysis-runtime-owners';
import { notifyAnalysisProjectStateChanged } from '../../projects/analysis-state';
import { projectCompanionSourceToken, retainExcitationProjectCompanions, type ProjectCompanionBridge } from '../../projects/companion-sources';
import type { DesktopBridge } from '../../modeling/contracts';
import type { ExcitationDensityField, ExcitationResult, ExcitationSessionInfo, ExcitationStateRef, NtoField } from '../../results/excitation-contracts';
import type { SurfaceContext, SurfaceStamp } from '../../results/surface-contracts';
import { sameSurfaceContext, sameSurfaceStamp } from '../../results/surface-field';
import { postprocessExcitationWavefunctionBinding, type PostprocessDocument, type PostprocessSourceText } from '../../results/postprocess-document';
import { createMultiwfnProgressTracker, type MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import { validateExcitationResult } from '../../results/excitation-field';
import { assertSurfaceCubeSourceGeometry } from './surface-desktop-bridge';
import type { ExcitationControlsBridge } from './excitation-controls-contracts';
import {excitationCapabilityReason} from './excitation-presentation';

export type ExcitationDesktopApi = Pick<DesktopBridge, 'openExcitationSession' | 'runExcitation' | 'restoreExcitationFields' | 'exportExcitationCube' | 'cancelExcitation' | 'closeExcitationSession' | 'onMultiwfnProgress'> & ProjectCompanionBridge;
export interface ExcitationDesktopBridgeOptions {
  desktop: ExcitationDesktopApi; analysisId: string; context: SurfaceContext; document: PostprocessDocument;
  structure: Structure; coordinateRoundingAngstrom?: number | null; active: boolean;
  onCleanupError?(message: string): void; onProgress?(snapshot: MultiwfnProgressSnapshot): void;
}
type Tracker = ReturnType<typeof createMultiwfnProgressTracker>;
type Operation = { requestId: string; epoch: number; abort: AbortController; submitted?: boolean; cancelling?: Promise<unknown> };
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
const abortError = () => new DOMException('激发态分析已取消或来源已改变。', 'AbortError');
function hasSourcePayload(source: PostprocessSourceText): boolean {
  if (source.sourceToken === undefined) return typeof source.text === 'string' && source.text.length > 0;
  return source.text === undefined && typeof source.sourceToken === 'string' && source.sourceToken.length > 0
    && source.sourceToken.length <= 256 && !source.sourceToken.includes('\0') && /^[a-f0-9]{64}$/.test(source.sourceRevision);
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sameScience = (a: SurfaceContext, b: SurfaceContext) => sameSurfaceContext({ ...a, activationEpoch: undefined }, { ...b, activationEpoch: undefined });
const fieldSignature = (field: NtoField | ExcitationDensityField) => { const { values: _values, context: fieldContext, ...metadata } = field; return canonical({ ...metadata, context: { ...fieldContext, activationEpoch: undefined } }); };
const stateMatches = (native: ExcitationStateRef, requested: ExcitationStateRef) => native.index === requested.index && native.sourceLine === requested.sourceLine && native.frameIndex === requested.frameIndex
  && native.energyEv === requested.energyEv && native.multiplicity === requested.multiplicity && (native.label === requested.label || native.label === 'ORCA printed state');

/** This owner retains raw source/session identity; opening reads metadata only. */
export function createExcitationDesktopBridge(options: ExcitationDesktopBridgeOptions) {
  const desktop = options.desktop, context = { ...options.context }, document = options.document;
  assert(options.analysisId && context.sourceId && context.sourceRevision, '激发态分析缺少来源身份。');
  let active = options.active, disposed = false, epoch = 0, sessionId: string | null = null, info: ExcitationSessionInfo | null = null;
  let opening: Promise<ExcitationSessionInfo> | undefined, operation: Operation | null = null;
  const orphanSessions=new Set<string>();
  let outputRevision: string | undefined;
  const tasks = new Set<Promise<unknown>>(), trackers = new Map<string, Tracker>(), artifacts = new Map<string, ExcitationResult>(), fields = new Map<string, string>(), acceptedIds = new Set<string>();
  const listeners = new Set<(snapshot: MultiwfnProgressSnapshot) => void>();
  const report = (error: unknown) => { if(disposed)return;try { options.onCleanupError?.(error instanceof Error ? error.message : String(error)); } catch { /* Cleanup continues. */ } };
  const publish = (snapshot: MultiwfnProgressSnapshot) => { if(disposed)return;options.onProgress?.(snapshot); for (const listener of listeners) listener(snapshot); };
  const off = desktop.onMultiwfnProgress?.(snapshot => trackers.get(snapshot.identity.runId)?.receive(snapshot));
  const stamp = (requestId: string, requestContext = context): SurfaceStamp => ({ ...requestContext, analysisId: options.analysisId, requestId });
  const current = (op: Operation) => { if (disposed || !active || op.epoch !== epoch || op.abort.signal.aborted || operation !== op) throw abortError(); };
  function bound() {
    assert(document.result.source.id === context.sourceId && document.wavefunction?.source.metadata?.sourceRevision === context.sourceRevision && document.result.jobIndex === context.jobIndex, '激发态分析来源/作业已改变。');
    const binding=postprocessExcitationWavefunctionBinding(document);
    assert(document.output && document.wavefunction?.source.metadata && document.output.readSourceText && document.wavefunction.readSourceText && binding?.sourceFrameIndex === context.sourceFrameIndex, '当前原帧缺少已配对的OUT与原始波函数。');
    assert(document.pair && document.pair.primary === document.output.source && document.pair.wavefunction === document.wavefunction.source
      && document.pair.frameIndex === binding.pairFrameIndex && !document.pair.conflicts.length, 'OUT与波函数配对未知或存在身份冲突。');
    return { output: document.output, wavefunction: document.wavefunction };
  }
  async function open(): Promise<ExcitationSessionInfo> {
    if (disposed || !active) throw abortError();
    if (info) { const attachment = bound(); await Promise.all([attachment.output.readSourceText!(), attachment.wavefunction.readSourceText!()]); if (disposed) throw abortError(); bound(); return info; }
    if (opening) return opening;
    const attachment = bound(), id = 'excitation-' + crypto.randomUUID();
    assert(desktop.openExcitationSession && desktop.closeExcitationSession, '当前环境缺少激发态分析入口。');
    opening = (async () => {
      const [wave, output] = await Promise.all([attachment.wavefunction.readSourceText!(), attachment.output.readSourceText!()]);
      if (disposed) throw abortError(); bound();
      const outputSHA256 = attachment.output.source.result.source.sha256;
      assert(wave.sourceId === attachment.wavefunction.source.metadata!.sourceId && wave.sourceRevision === attachment.wavefunction.source.metadata!.sourceRevision
        && output.sourceId === attachment.output.source.result.source.id
        && (output.sourceToken === undefined || !outputSHA256 || output.sourceRevision === outputSHA256)
        && hasSourcePayload(wave) && hasSourcePayload(output), '原始波函数/OUT快照身份不符。');
      const savedCompanions=attachment.output.source.kind==='orca-output'?await projectCompanionSourceToken(attachment.output,context,desktop,{sourceId:output.sourceId,revision:output.sourceRevision}):{restored:false};
      const companionSourceToken = attachment.output.source.kind === 'orca-output' ? savedCompanions.restored?savedCompanions.token:await attachment.output.readCompanionSourceToken?.() : undefined;
      if (disposed) throw abortError(); bound();
      sessionId = id;
      outputRevision = output.sourceRevision;
      try {
        const result = await desktop.openExcitationSession!({ sessionId: id, source: { kind: 'wavefunction', ...wave, context }, output: { name: output.name, text: output.text, sourceToken: output.sourceToken, sourceId: output.sourceId, revision: output.sourceRevision, ...(companionSourceToken ? { companionSourceToken } : {}) } });
        if (disposed) throw abortError();
        assert(result.sessionId === id && sameSurfaceContext(result.context, context), '激发态会话身份不符。');
        if(companionSourceToken&&desktop.describeExcitationProjectCompanions){const originals=await desktop.describeExcitationProjectCompanions(id);if(originals)retainExcitationProjectCompanions(attachment.output,id,desktop);}
        else if(companionSourceToken)retainExcitationProjectCompanions(attachment.output,id,desktop);
        info = result; return result;
      } catch (error) { try{await desktop.closeExcitationSession!(id);}catch(closeError){orphanSessions.add(id);report(closeError);}if(sessionId===id)sessionId=null;throw error; }
    })().finally(() => { opening = undefined; });
    return opening;
  }
  async function cancelOperation(op: Operation) {
    op.abort.abort(); trackers.get(op.requestId)?.stopping();
    if (sessionId && !op.cancelling) { assert(desktop.cancelExcitation, '缺少激发态停止入口。'); op.cancelling = desktop.cancelExcitation(sessionId).then(value => { assert(value.nativeSettled && value.activeOperationPending === false, '停止尚未得到原生结算。');
      const settlement = 'settlement' in value ? value.settlement : undefined;
      if (settlement === 'native-settled' || settlement === 'cancelled-before-start') trackers.get(op.requestId)?.stopped(settlement);
      else if (!op.submitted) trackers.get(op.requestId)?.stopped('cancelled-before-start');
    }); }
    await op.cancelling;
  }
  function execute<T>(requestId: string, signal: AbortSignal, operationName: string, action: (op: Operation) => Promise<T>): Promise<T> {
    if (disposed || !active || signal.aborted) return Promise.reject(abortError());
    if (operation) return Promise.reject(new Error('当前激发态实例已有操作，请先完成或停止。'));
    const op: Operation = { requestId, epoch, abort: new AbortController() }; operation = op;
    const abort = () => { void cancelOperation(op).catch(report); }; signal.addEventListener('abort', abort, { once: true });
    let task!: Promise<T>;
    task = (async () => { try { current(op); await open(); current(op);
      trackers.set(requestId, createMultiwfnProgressTracker({ sourceId: context.sourceId, sourceRevision: context.sourceRevision, jobIndex: context.jobIndex, sourceFrameIndex: context.sourceFrameIndex, generation: context.generation, ownerId: options.analysisId, analysisId: options.analysisId, sessionId: sessionId!, runId: requestId, operation: operationName }, publish));
      const value = await action(op); current(op); return value;
    } catch (error) { if (!op.abort.signal.aborted) { const tracker = trackers.get(requestId), settlement = op.submitted ? tracker?.getSnapshot().settlement : 'not-started'; if (settlement) tracker?.failed(settlement, error instanceof Error ? error.message : String(error)); } throw error; }
    finally { signal.removeEventListener('abort', abort); if (operation === op) operation = null; tasks.delete(task); } })();
    tasks.add(task); return task;
  }
  function accept(result: ExcitationResult, expected: SurfaceStamp) {
    validateExcitationResult(result);
    assert(sameSurfaceStamp(result.stamp, expected) && info?.states.some(state => stateMatches(state, result.state)), '激发态回执来源/原始态不符。');
    const source = bound().wavefunction.source;
    const values = result.operation === 'nto-field' ? [result.field] : result.operation === 'hole-electron' ? [result.hole, result.electron] : [];
    for (const field of values) {
      assert(sameScience(field.context, context) && equal(field.state, result.state) && field.values instanceof Float64Array && field.values.length === field.grid.dimensions.reduce((a, b) => a * b, 1) && field.values.every(Number.isFinite), '激发态格点数据/来源无效。');
      assertSurfaceCubeSourceGeometry({ ...field, source: 'source' in field ? field.source : { id: context.sourceId, name: '', revision: context.sourceRevision, kind: 'generated-cube', producer: 'multiwfn' } }, source.metadata!.structure, source.coordinateRoundingAngstrom);
    }
    assert(result.provenance.wavefunctionRevision === source.metadata!.sourceRevision && result.provenance.outputRevision === outputRevision, '激发态回执波函数/OUT内容不符。');
    return values;
  }
  const bridge: ExcitationControlsBridge = {
    run(request, signal) { return execute(request.requestId, signal, 'excitation-run', async op => {
      assert(sameScience(request.context, context), '激发态请求不属于当前原帧。');
      assert(desktop.runExcitation && info, '激发态分析会话尚未就绪。');
      const capability = request.operation === 'hole-electron' ? info.capabilities.holeElectron : info.capabilities.nto;
      assert(capability, excitationCapabilityReason(info));
      assert(info.states.some(state => stateMatches(state, request.state)), '原始激发态不属于此OUT会话。');
      const { requestId, context: _context, ...parameters } = request;
      if (request.operation === 'nto-field') { const generation = request.generationId ? artifacts.get(request.generationId) : undefined;
        assert(request.generationId && acceptedIds.has(request.generationId) && generation?.operation === 'nto' && equal(generation.state, request.state) && generation.pairs.some(pair => pair.index === request.pairIndex && pair.spin === request.spin), 'NTO格点须引用当前已接受的成对分解。'); }
      const expected = stamp(requestId, request.context);
      op.submitted = true; const result = await desktop.runExcitation(sessionId!, { ...parameters, stamp: expected }); current(op);
      assert(result.operation === request.operation && equal(result.state, request.state), '激发态方法/原始态发生变化。');
      if (result.operation === 'nto-field') assert(result.field.pairIndex === request.pairIndex && result.field.spin === request.spin && result.field.side === request.side, '返回NTO格点不是所请求轨道对/自旋/侧。');
      if (result.operation === 'hole-electron') assert(result.coulomb.requested === !!request.includeCoulomb, '库仑计算请求发生变化。');
      for (const field of accept(result, expected)) fields.set(field.id, fieldSignature(field)); artifacts.set(requestId, result); notifyAnalysisProjectStateChanged(); return result;
    }); },
    exportCube(field, signal) { const id = 'excitation-export-' + crypto.randomUUID(); return execute(id, signal, 'excitation-export-cube', async op => {
      assert(fields.get(field.id) === fieldSignature(field) && desktop.exportExcitationCube, '此格点没有当前可信激发态artifact。');
      op.submitted = true; const result = await desktop.exportExcitationCube(sessionId!, { stamp: stamp(id, field.context), fieldId: field.id }); current(op); if (result.cancelled) throw abortError(); assert(result.saved, 'Cube尚未确认保存。');
    }); },
    async cancel(requestId) { if (operation?.requestId === requestId) await cancelOperation(operation); },
  };
  const runtimeOwner=registerAnalysisRuntimeOwner({analysisId:options.analysisId,kind:'excitation',label:'激发态分析',sourceId:context.sourceId,sourceRevision:context.sourceRevision,documentId:context.documentId},{
    isBusy:()=>Boolean(operation||opening)||tasks.size>0,hasData:()=>Boolean(info||sessionId)||artifacts.size>0||orphanSessions.size>0,
    revision:()=>[sessionId,[...artifacts.keys()],[...fields.keys()],[...orphanSessions]],
    retire(){disposed=true;active=false;epoch++;off?.();},
    async release(){
      if(operation)await cancelOperation(operation).catch(report);await opening?.catch(report);await Promise.allSettled([...tasks]);if(sessionId)orphanSessions.add(sessionId);
      const closed=await Promise.allSettled([...orphanSessions].map(async id=>{assert(desktop.closeExcitationSession,'当前环境缺少激发态关闭入口。');await desktop.closeExcitationSession(id);orphanSessions.delete(id);if(sessionId===id){sessionId=null;info=null;}}));
      fields.clear();artifacts.clear();trackers.clear();listeners.clear();const failures=closed.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(failures.length)throw new AggregateError(failures,'部分激发态来源未确认释放。');
    },
  });
  return { bridge, open, get info() { return info; },
    restoreFields(request: { requestId: string; context: SurfaceContext; generationId: string }, signal: AbortSignal) { return execute(request.requestId, signal, 'excitation-restore-fields', async op => {
      assert(sameScience(request.context, context) && artifacts.has(request.generationId) && desktop.restoreExcitationFields, '激发态artifact不属于当前owner，不能以新计算冒充恢复。');
      const original = artifacts.get(request.generationId)!;
      const expected = stamp(request.requestId, request.context);
      op.submitted = true; const result = await desktop.restoreExcitationFields(sessionId!, { stamp: expected, generationId: request.generationId }); current(op); const restored = accept(result, expected);
      assert(result.operation === original.operation && equal(result.state, original.state), '恢复结果与原激发态artifact不符。');
      for (const field of result.operation === 'nto-field' ? [result.field] : result.operation === 'hole-electron' ? [result.hole, result.electron] : []) {
        const previous = original.operation === 'nto-field' ? [original.field] : original.operation === 'hole-electron' ? [original.hole, original.electron] : [];
        assert(previous.some(saved => fieldSignature(saved) === fieldSignature(field)), '恢复格点已改变原artifact身份。');
      }
      for (const field of restored) fields.set(field.id, fieldSignature(field)); artifacts.set(request.requestId, result); return result;
    }); },
    accepted(requestId: string, renderRequired = false) { if (artifacts.has(requestId)) { acceptedIds.add(requestId); trackers.get(requestId)?.committed({ required: renderRequired }); } },
    renderCommitted(requestId: string) { trackers.get(requestId)?.renderCommitted(); },
    onProgress(listener: (snapshot: MultiwfnProgressSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async setActive(value: boolean) { if (disposed || active === value) return; active = value; epoch++; if (!value && operation) await cancelOperation(operation); },
    dispose:runtimeOwner.dispose,
  };
}
