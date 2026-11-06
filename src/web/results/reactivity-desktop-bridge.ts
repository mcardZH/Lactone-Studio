import type { Structure } from '../../core/types';
import { registerAnalysisRuntimeOwner } from '../../modeling/application/analysis-runtime-owners';
import type { DesktopBridge } from '../../modeling/contracts';
import type { ReactivitySessionInfo } from '../../results/reactivity-contracts';
import type { WavefunctionMetadata } from '../../results/orbital-contracts';
import type { SurfaceContext } from '../../results/surface-contracts';
import { sameSurfaceContext, sameSurfaceStamp } from '../../results/surface-field';
import { postprocessWavefunctionFrame, type PostprocessDocument } from '../../results/postprocess-document';
import { createMultiwfnProgressTracker, type MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import type { ReactivityControlsBridge } from './reactivity-controls-contracts';
import { releaseOrbitalSession } from './useOrbitalField';
import { validateReactivityAnalysisResult } from '../../results/reactivity';
import { notifyAnalysisProjectStateChanged } from '../../projects/analysis-state';

export type ReactivityDesktopApi = Pick<DesktopBridge, 'openReactivitySession' | 'analyzeReactivity' | 'cancelReactivity' | 'closeReactivitySession' | 'forkOrbitalSession' | 'openOrbitalSession' | 'closeOrbitalSession' | 'onMultiwfnProgress'>;
export interface ReactivityDesktopBridgeOptions {
  desktop: ReactivityDesktopApi; analysisId: string; context: SurfaceContext; document: PostprocessDocument; structure: Structure;
  active: boolean; onCleanupError?(message: string): void; onProgress?(snapshot: MultiwfnProgressSnapshot): void;
}
type Opened = { info: ReactivitySessionInfo; metadata: WavefunctionMetadata; orbitalSessionId: string };
type Operation = { requestId: string; epoch: number; abort: AbortController; submitted?: boolean; cancelling?: Promise<unknown> };
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
const abortError = () => new DOMException('反应性分析已取消或来源已改变。', 'AbortError');
const sameScience = (a: SurfaceContext, b: SurfaceContext) => sameSurfaceContext({ ...a, activationEpoch: undefined }, { ...b, activationEpoch: undefined });

/** FMO analysis and its orbital view own independent native sessions. */
export function createReactivityDesktopBridge(options: ReactivityDesktopBridgeOptions) {
  const desktop = options.desktop, context = { ...options.context }, document = options.document;
  assert(options.analysisId && context.sourceId && context.sourceRevision, '反应性分析缺少来源身份。');
  let active = options.active, disposed = false, epoch = 0, sessionId: string | null = null, opened: Opened | null = null;
  let opening: Promise<Opened> | undefined, operation: Operation | null = null;
  const orphanForks=new Set<string>(),orphanSessions=new Set<string>();
  const tasks = new Set<Promise<unknown>>(), trackers = new Map<string, ReturnType<typeof createMultiwfnProgressTracker>>(), listeners = new Set<(snapshot: MultiwfnProgressSnapshot) => void>();
  const report = (reason: unknown) => { if(disposed)return;try { options.onCleanupError?.(reason instanceof Error ? reason.message : String(reason)); } catch { /* Cleanup continues. */ } };
  const publish = (snapshot: MultiwfnProgressSnapshot) => { if(disposed)return;options.onProgress?.(snapshot); for (const listener of listeners) listener(snapshot); };
  const off = desktop.onMultiwfnProgress?.(snapshot => trackers.get(snapshot.identity.runId)?.receive(snapshot));
  const current = (op: Operation) => { if (disposed || !active || epoch !== op.epoch || operation !== op || op.abort.signal.aborted) throw abortError(); };
  function bound() {
    assert(document.result.source.id === context.sourceId && document.wavefunction?.source.metadata?.sourceRevision === context.sourceRevision && document.result.jobIndex === context.jobIndex, '反应性来源/作业已改变。');
    const frame = postprocessWavefunctionFrame(document), original = frame === null ? null : document.result.frames.find(row => row.index === frame)?.sourceFrameIndex ?? frame;
    const attachment = document.wavefunction;
    assert(attachment?.source.metadata && attachment.readSourceText && original === context.sourceFrameIndex, '本原帧没有可靠配对的原始波函数。');
    if (document.output) assert(document.pair && document.pair.primary === document.output.source && document.pair.wavefunction === attachment.source && document.pair.frameIndex === frame && !document.pair.conflicts.length, '波函数与OUT配对未知或身份冲突。');
    return attachment;
  }
  async function closeFork(id: string) { assert(desktop.closeOrbitalSession,'当前环境缺少轨道会话关闭入口。');await desktop.closeOrbitalSession(id);releaseOrbitalSession(desktop,id);orphanForks.delete(id); }
  async function open(): Promise<Opened> {
    if (disposed || !active) throw abortError(); bound(); if (opened) return opened; if (opening) return opening;
    assert(desktop.openReactivitySession && desktop.closeReactivitySession && desktop.closeOrbitalSession && (desktop.forkOrbitalSession || desktop.openOrbitalSession), '当前环境缺少独立反应性/轨道会话入口。');
    const attachment = bound(), id = 'reactivity-' + crypto.randomUUID();
    opening = (async () => {
      const source = await attachment.readSourceText!(); if (disposed) throw abortError(); bound();
      assert(source.sourceId === attachment.source.metadata!.sourceId && source.sourceRevision === attachment.source.metadata!.sourceRevision && (source.text || source.sourceToken), '原始波函数快照身份不符。');
      let fork: Awaited<ReturnType<NonNullable<DesktopBridge['forkOrbitalSession']>>> | undefined;
      sessionId = id;
      try {
        const info = await desktop.openReactivitySession!({ sessionId: id, source: { kind: 'wavefunction', ...source, context } });
        if (disposed) throw abortError();
        assert(info.sessionId === id && sameSurfaceContext(info.context, context) && info.atomCount === options.structure.atoms.length, '反应性会话身份/原子数不符。');
        if (attachment.nativeSessionId) {
          assert(desktop.forkOrbitalSession, '当前环境缺少独立轨道会话入口。');
          fork = await desktop.forkOrbitalSession(attachment.nativeSessionId, 'reactivity-orbital-' + crypto.randomUUID());
        } else {
          assert(desktop.openOrbitalSession, '当前环境缺少项目波函数只读解析入口。');
          const orbitalSessionId = 'reactivity-project-orbital-' + crypto.randomUUID();
          try { const metadata = await desktop.openOrbitalSession({ sessionId: orbitalSessionId, sourceId: source.sourceId, name: source.name, text: source.text, sourceToken: source.sourceToken });
            fork = { sessionId: orbitalSessionId, metadata: { ...metadata, structure: attachment.source.metadata!.structure } };
          } catch (error) { try{await closeFork(orbitalSessionId);}catch(closeError){orphanForks.add(orbitalSessionId);report(closeError);}throw error; }
        }
        if (disposed) throw abortError();
        assert(fork.sessionId !== attachment.nativeSessionId && fork.metadata.sourceId === source.sourceId && fork.metadata.sourceRevision === source.sourceRevision, '反应性轨道视图未取得独立且同源的会话。');
        opened = { info, metadata: fork.metadata, orbitalSessionId: fork.sessionId }; return opened;
      } catch (error) { if(fork&&fork.sessionId!==attachment.nativeSessionId)try{await closeFork(fork.sessionId);}catch(closeError){orphanForks.add(fork.sessionId);report(closeError);}try{await desktop.closeReactivitySession!(id);}catch(closeError){orphanSessions.add(id);report(closeError);}if(sessionId===id)sessionId=null;throw error; }
    })().finally(() => { opening = undefined; });
    return opening;
  }
  async function cancelOperation(op: Operation) {
    op.abort.abort(); trackers.get(op.requestId)?.stopping();
    if (sessionId && !op.cancelling) { assert(desktop.cancelReactivity, '当前环境缺少反应性停止入口。'); op.cancelling = desktop.cancelReactivity(sessionId).then(value => { assert(value.nativeSettled && value.activeOperationPending === false, '反应性停止尚未得到原生结算。');
      const settlement = 'settlement' in value ? value.settlement : undefined;
      if (settlement === 'native-settled' || settlement === 'cancelled-before-start') trackers.get(op.requestId)?.stopped(settlement);
      else if (!op.submitted) trackers.get(op.requestId)?.stopped('cancelled-before-start');
    }); }
    await op.cancelling;
  }
  const bridge: ReactivityControlsBridge = {
    analyze(request, signal) {
      if (disposed || !active || signal.aborted) return Promise.reject(abortError());
      if (operation) return Promise.reject(new Error('当前反应性实例已有操作，请先完成或停止。'));
      assert(sameScience(request.stamp, context) && request.stamp.analysisId === options.analysisId && request.stamp.requestId, '反应性请求不属于当前来源/原帧/owner。');
      const op: Operation = { requestId: request.stamp.requestId, epoch, abort: new AbortController() }; operation = op;
      const abort = () => { void cancelOperation(op).catch(report); }; signal.addEventListener('abort', abort, { once: true });
      let task!: Promise<Awaited<ReturnType<NonNullable<ReactivityControlsBridge['analyze']>>>>;
      task = (async () => {
        try {
          current(op); const value = await open(); current(op); assert(desktop.analyzeReactivity, '反应性分析入口不可用。');
          trackers.set(op.requestId, createMultiwfnProgressTracker({ sourceId: context.sourceId, sourceRevision: context.sourceRevision, jobIndex: context.jobIndex, sourceFrameIndex: context.sourceFrameIndex, generation: context.generation, ownerId: options.analysisId, analysisId: options.analysisId, sessionId: sessionId!, runId: op.requestId, operation: 'reactivity-run' }, publish));
          op.submitted = true; const raw = await desktop.analyzeReactivity(sessionId!, request); current(op);
          const result = validateReactivityAnalysisResult(raw, request.stamp, options.structure.atoms.length, value.metadata.sourceId);
          assert(sameSurfaceStamp(result.stamp, request.stamp) && result.approximation === 'frozen-orbital' && result.partition === 'hirshfeld'
            && result.provenance.sourceId === value.metadata.sourceId && result.provenance.sourceRevision === value.metadata.sourceRevision, '反应性回执来源/科学定义不符。');
          assert(!result.capabilities.condensed || result.atoms.length === options.structure.atoms.length, '反应性原子表不完整。');
          for (const [index, atom] of result.atoms.entries()) assert(atom.sourceIndex === index + 1 && atom.element === value.metadata.structure.atoms[index]?.element && atom.element === options.structure.atoms[index]?.element, '反应性原子对应/顺序不符。');
          notifyAnalysisProjectStateChanged(); return { ...result, atoms: result.atoms.map((atom, index) => ({ ...atom, atomId: options.structure.atoms[index].id })) };
        } catch (error) { if (!op.abort.signal.aborted) { const tracker = trackers.get(op.requestId), settlement = op.submitted ? tracker?.getSnapshot().settlement : 'not-started'; if (settlement) tracker?.failed(settlement, error instanceof Error ? error.message : String(error)); } throw error; }
        finally { signal.removeEventListener('abort', abort); if (operation === op) operation = null; tasks.delete(task); }
      })(); tasks.add(task); return task;
    },
    async cancel(requestId) { if (operation?.requestId === requestId) await cancelOperation(operation); },
  };
  const runtimeOwner=registerAnalysisRuntimeOwner({analysisId:options.analysisId,kind:'reactivity',label:'反应性分析',sourceId:context.sourceId,sourceRevision:context.sourceRevision,documentId:context.documentId},{
    isBusy:()=>Boolean(operation||opening)||tasks.size>0,hasData:()=>Boolean(opened||sessionId)||orphanForks.size>0||orphanSessions.size>0,
    revision:()=>[sessionId,opened?.orbitalSessionId,[...trackers.keys()],[...orphanForks],[...orphanSessions]],
    retire(){disposed=true;active=false;epoch++;off?.();},
    async release(){
      if(operation)await cancelOperation(operation).catch(report);await opening?.catch(report);await Promise.allSettled([...tasks]);
      if(opened)orphanForks.add(opened.orbitalSessionId);if(sessionId)orphanSessions.add(sessionId);
      const forks=await Promise.allSettled([...orphanForks].map(async id=>{await closeFork(id);if(opened?.orbitalSessionId===id)opened=null;}));
      const closed=await Promise.allSettled([...orphanSessions].map(async id=>{assert(desktop.closeReactivitySession,'当前环境缺少反应性关闭入口。');await desktop.closeReactivitySession(id);orphanSessions.delete(id);if(sessionId===id)sessionId=null;}));
      listeners.clear();trackers.clear();const failures=[...forks,...closed].filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(failures.length)throw new AggregateError(failures,'部分反应性或轨道来源未确认释放。');
    },
  });
  return { bridge, open, get info() { return opened?.info ?? null; }, get metadata() { return opened?.metadata ?? null; }, get orbitalSessionId() { return opened?.orbitalSessionId ?? null; },
    accepted(requestId: string) { trackers.get(requestId)?.committed(); },
    onProgress(listener: (snapshot: MultiwfnProgressSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async setActive(value: boolean) { if (disposed || active === value) return; active = value; epoch++; if (!value && operation) await cancelOperation(operation); },
    dispose:runtimeOwner.dispose,
  };
}
