import type { DesktopBridge } from '../contracts';
import { desktopBridge } from '../platform/desktop';
import { bindNativeSourceStamp } from '../platform/native-source-stamp';
import type { DynamicsCommand, DynamicsEvent, DynamicsRequest } from './contracts';

export interface DynamicsCapabilities { available: boolean; reason?: string }
export interface DynamicsPort {
  capabilities(): Promise<DynamicsCapabilities>;
  subscribe(listener: (event: DynamicsEvent) => void): () => void;
  start(request: DynamicsRequest, sessionId: string): Promise<void>;
  command(sessionId: string, command: DynamicsCommand): Promise<void>;
  waitForClosed?(documentId: string, sessionId: string): Promise<void>;
}

export interface DynamicsBridge {
  info(): Promise<{ nativeChemistry: boolean }>;
  startDynamics(request: DynamicsRequest, sessionId: string): Promise<void>;
  commandDynamics(sessionId: string, command: DynamicsCommand): Promise<void>;
  waitForDynamicsClose?(documentId: string, sessionId: string): Promise<void>;
  onDynamicsEvent(callback: (event: DynamicsEvent) => void): () => void;
}

/** No browser fallback: an optimization animation cannot impersonate MD. */
export function createDynamicsPort(bridge: DesktopBridge | DynamicsBridge | null = desktopBridge()): DynamicsPort {
  const native = bridge as Partial<DynamicsBridge> | null;
  const complete = Boolean(native?.startDynamics && native?.commandDynamics && native?.onDynamicsEvent);
  const sources = new Map<string, ReturnType<typeof bindNativeSourceStamp>>();
  return {
    async capabilities() {
      if (!complete) return { available: false, reason: '当前浏览器预览没有有状态原生动态引擎。请在桌面版使用分子动力学。' };
      const info = await native!.info!();
      return info.nativeChemistry ? { available: true } : { available: false, reason: '桌面原生化学引擎不可用。' };
    },
    subscribe(listener) {
      if (!complete) return () => {};
      return native!.onDynamicsEvent!(event => {
        const binding = sources.get(event.sessionId);
        const stamp = binding?.restore(event.stamp);
        if (!binding || !stamp) { listener(event); return; }
        if (['completed', 'stopped', 'error'].includes(event.event)) sources.delete(event.sessionId);
        listener({ ...event, stamp, ...(event.displayFrames ? { displayFrames: event.displayFrames.map(frame => {
          const displayStamp = binding.restore(frame.stamp);
          return displayStamp ? { ...frame, stamp: displayStamp } : frame;
        }) } : {}) });
      });
    },
    async start(request, sessionId) {
      if (!complete) throw new Error('当前环境不支持原生动态力场。');
      const binding = bindNativeSourceStamp(request.stamp);
      sources.set(sessionId, binding);
      try { return await native!.startDynamics!({ ...request, stamp: binding.wire }, sessionId); }
      catch (error) { sources.delete(sessionId); throw error; }
    },
    async command(sessionId, command) {
      if (!complete) throw new Error('当前环境不支持原生动态力场。');
      return native!.commandDynamics!(sessionId, command);
    },
    ...(native?.waitForDynamicsClose ? { waitForClosed: async (documentId: string, sessionId: string) => { await native.waitForDynamicsClose!(documentId, sessionId); sources.delete(sessionId); } } : {}),
  };
}
