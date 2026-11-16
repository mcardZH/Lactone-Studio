import type { ChemistryPort, ModelDocument, ModelStore } from '../contracts';
import { DynamicsController, createStoreDynamicsDependencies } from '../dynamics/controller';
import type { DynamicsPort } from '../dynamics/port';
import { XtbController } from '../xtb/controller';
import type { XtbBridge } from '../xtb/contracts';

interface DocumentRuntimeOptions {
  xtbBridge: Partial<XtbBridge> | null;
  chemistry: ChemistryPort;
  dynamicsPort: DynamicsPort;
  assertCurrent(): void;
  waitForNativeClose?(dynamicsSessionId?: string): Promise<void>;
}

interface PreparedRuntimeClose {
  commit(): void;
  cancel(): void;
}

/** Document lifetime owns the controllers. Presentation callbacks only capture new requests. */
export function createDocumentRuntimeOwner(store: ModelStore, options: DocumentRuntimeOptions) {
  const documentId = store.getSnapshot().id;
  const presentations = new Set<{ captureSource(): ModelDocument; isActive(): boolean }>();
  const activities = new Set<() => boolean>();
  let closing: Promise<PreparedRuntimeClose> | undefined;
  let closeTask: Promise<void> | undefined;
  let closed = false;
  // A cancelled preflight can clear the presentation session before an older worker closes.
  let lastDynamicsSessionId: string | undefined;
  let phaseSource: ModelDocument | undefined;
  let phaseDeferApplication=false;
  let optimizationSource: { document: ModelDocument; sessionId: string } | undefined;

  function assertCurrent() {
    if (closed || store.getSnapshot().id !== documentId) throw new Error('运行所属文档已关闭或已变化。');
    options.assertCurrent();
  }

  function assertCanStart() {
    assertCurrent();
    if (closing) throw new Error('文档正在释放运行资源。');
  }

  const activePresentation = () => [...presentations].reverse().find(presentation => presentation.isActive());
  const hasActivity = () => [...activities].some(activity => activity());

  function captureSource() {
    assertCanStart();
    const view = activePresentation();
    if (!view) throw new Error('当前文档没有可用于启动任务的活动视图。');
    return view.captureSource();
  }

  const xtb = new XtbController({ store, bridge: options.xtbBridge, chemistry: options.chemistry,
    allowWorkingEdits: true, captureSource, confirmConstraints: () => true,
    assertCurrent: assertCanStart,
  });
  const dynamicsPort = options.dynamicsPort;
  const dynamics = new DynamicsController({ ...dynamicsPort, start(request, sessionId) {
    assertCanStart();
    lastDynamicsSessionId = sessionId;
    return dynamicsPort.start(request, sessionId);
  } }, createStoreDynamicsDependencies(store, { isolated: true,deferApplication:()=>phaseDeferApplication, captureSource() {
    const source = phaseSource;
    phaseSource = undefined;
    return source ?? captureSource();
  } }));

  async function startOptimizationPhase(mode: 'optimize' | 'geometry', config: Parameters<DynamicsController['start']>[1] = {},capturedSource?:ModelDocument,options?:{deferApplication?:boolean}) {
    assertCanStart();
    const fallback = mode === 'geometry' && config.geometryMode === 'hybrid-local' && config.allowPureGeometryFallback === true;
    const previous = optimizationSource;
    optimizationSource = undefined;
    const view = activePresentation();
    let source: ModelDocument;
    if(capturedSource){
      const current=store.getSnapshot();
      if(capturedSource.id!==current.id||capturedSource.revision!==current.revision)throw Error('封存的优化来源已不属于当前文档修订。');
      source=structuredClone(capturedSource);
    }
    else if (view) source = view.captureSource();
    else {
      const owner = store.getSnapshot(), state = dynamics.getSnapshot();
      if (!fallback || !hasActivity() || !previous || previous.sessionId !== state.sessionId || state.status !== 'error' ||
          previous.document.id !== owner.id || previous.document.revision !== owner.revision || previous.document.analysisBindingId !== owner.analysisBindingId) {
        throw new Error('当前文档没有可用于继续预优化的有效来源。');
      }
      source = structuredClone(previous.document);
    }
    const saved = mode === 'optimize' && config.forcefield === 'auto' && hasActivity() ? structuredClone(source) : undefined;
    const priorSessionId = lastDynamicsSessionId;
    // Dynamics captures its immutable operation synchronously before preflight awaits.
    phaseSource = source;
    phaseDeferApplication=options?.deferApplication===true;
    try {
      return dynamics.start(mode, config).then(() => {
        const state = dynamics.getSnapshot(), sessionId = lastDynamicsSessionId;
        if (saved && sessionId && sessionId !== priorSessionId && state.sessionId === sessionId &&
            state.workingSource?.documentId === saved.id && state.workingSource.revision === saved.revision) {
          optimizationSource = { document: saved, sessionId };
        }
      });
    } finally { phaseSource = undefined;phaseDeferApplication=false; }
  }

  function isBusy() {
    const state = dynamics.getSnapshot();
    return xtb.getSnapshot().running || ['starting', 'running', 'pausing', 'paused', 'stopping'].includes(state.status)
      || state.termination?.status === 'pending' || store.isRuntimeSessionActive?.() === true
      || hasActivity();
  }

  function prepareClose(): Promise<PreparedRuntimeClose> {
    if (closed) return Promise.resolve({ commit() {}, cancel() {} });
    if (closing) return Promise.reject(new Error('文档运行资源已进入关闭准备。'));
    if (isBusy()) return Promise.reject(new Error('文档仍有运行中的计算，请先停止并等待结束。'));
    const pending = Promise.resolve().then(async () => {
      assertCurrent();
      const sessionId = lastDynamicsSessionId;
      if (options.waitForNativeClose) await options.waitForNativeClose(sessionId);
      else if (sessionId) {
        if (!options.dynamicsPort.waitForClosed) throw new Error('当前环境无法确认动态引擎已实际关闭。');
        await options.dynamicsPort.waitForClosed(documentId, sessionId);
      }
      if (isBusy()) throw new Error('等待结束期间文档启动了新的计算。');
      return {
        commit() {
          if (closed) return;
          if (closing !== pending) throw new Error('文档运行资源的关闭准备已失效。');
          closed = true;
          closing = undefined;
          presentations.clear();
          activities.clear();
          optimizationSource = undefined;
          xtb.disconnect();
          dynamics.dispose();
        },
        cancel,
      };
    }).catch(error => { cancel(); throw error; });
    function cancel() { if (closing === pending) closing = undefined; }
    closing = pending;
    return pending;
  }

  return {
    xtb,
    dynamics,
    startOptimizationPhase,
    isBusy,
    attachPresentation(capture: () => ModelDocument, isActive = () => true) {
      assertCurrent();
      const presentation = { captureSource: capture, isActive };
      presentations.add(presentation);
      return () => { presentations.delete(presentation); };
    },
    registerActivity(isActive: () => boolean) {
      assertCanStart();
      activities.add(isActive);
      return () => { activities.delete(isActive); };
    },
    prepareClose,
    close() {
      closeTask ??= prepareClose().then(prepared => { prepared.commit(); }).finally(() => { closeTask = undefined; });
      return closeTask;
    },
  };
}

export type DocumentRuntimeOwner = ReturnType<typeof createDocumentRuntimeOwner>;
