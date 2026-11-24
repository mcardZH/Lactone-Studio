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
  } }, createStoreDynamicsDependencies(store, { isolated: true, captureSource }));

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
