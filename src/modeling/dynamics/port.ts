import type { DesktopBridge } from '../contracts';
import { desktopBridge } from '../platform/desktop';
import type { DynamicsCommand, DynamicsEvent, DynamicsRequest } from './contracts';

export interface DynamicsCapabilities { available: boolean; reason?: string }
export interface DynamicsPort {
  capabilities(): Promise<DynamicsCapabilities>;
  subscribe(listener: (event: DynamicsEvent) => void): () => void;
  start(request: DynamicsRequest, sessionId: string): Promise<void>;
  command(sessionId: string, command: DynamicsCommand): Promise<void>;
}

export interface DynamicsBridge {
  info(): Promise<{ nativeChemistry: boolean }>;
  startDynamics(request: DynamicsRequest, sessionId: string): Promise<void>;
  commandDynamics(sessionId: string, command: DynamicsCommand): Promise<void>;
  onDynamicsEvent(callback: (event: DynamicsEvent) => void): () => void;
}

/** No browser fallback: an optimization animation cannot impersonate MD. */
export function createDynamicsPort(bridge: DesktopBridge | DynamicsBridge | null = desktopBridge()): DynamicsPort {
  const native = bridge as Partial<DynamicsBridge> | null;
  const complete = Boolean(native?.startDynamics && native?.commandDynamics && native?.onDynamicsEvent);
  return {
    async capabilities() {
      if (!complete) return { available: false, reason: '当前浏览器预览没有有状态原生动态引擎。请在桌面版使用机械几何整理、动态预优化或MD。' };
      const info = await native!.info!();
      return info.nativeChemistry ? { available: true } : { available: false, reason: '桌面原生化学引擎不可用。' };
    },
    subscribe(listener) { return complete ? native!.onDynamicsEvent!(listener) : () => {}; },
    async start(request, sessionId) {
      if (!complete) throw new Error('当前环境不支持原生动态力场。');
      return native!.startDynamics!(request, sessionId);
    },
    async command(sessionId, command) {
      if (!complete) throw new Error('当前环境不支持原生动态力场。');
      return native!.commandDynamics!(sessionId, command);
    },
  };
}
