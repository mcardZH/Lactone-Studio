import type { ConformerBatchBridge, ConformerBatchProgress } from '../advanced/batch-contracts';

/** Narrow preload surface. Capability detection never registers or starts a job. */
export interface ConformerBatchDesktopBridge {
  conformerBatchCommand(command: string, payload: unknown): Promise<unknown>;
  onConformerBatchProgress(listener: (event: ConformerBatchProgress) => void): () => void;
}
export function createDesktopConformerBatchBridge(bridge: Partial<ConformerBatchDesktopBridge> | null | undefined): ConformerBatchBridge | null {
  if (!bridge?.conformerBatchCommand || !bridge.onConformerBatchProgress) return null;
  const command = bridge.conformerBatchCommand.bind(bridge), subscribe = bridge.onConformerBatchProgress.bind(bridge);
  const invoke = <T>(name: string, payload: unknown) => command(name, payload) as Promise<T>;
  return {
    begin: request => invoke('begin', request),
    upload: (batchId, packet) => invoke('upload', { batchId, ...packet }),
    seal: batchId => invoke('seal', { batchId }), start: batchId => invoke('start', { batchId }),
    stop: batchId => invoke('stop', { batchId }), status: batchId => invoke('status', { batchId }),
    read: (batchId, page) => invoke('read', { batchId, ...page }),
    restore: batchId => invoke('restore', { batchId }), destroy: batchId => invoke('destroy', { batchId }),
    onProgress: listener => subscribe(listener),
  };
}
