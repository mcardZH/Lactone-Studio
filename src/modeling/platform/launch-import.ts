import type { ScientificSourceFile } from '../../results/input-file';

export interface LaunchSourceDescriptor { token: string; name: string; size: number }
export interface LaunchImportBatch { id: string; sources: LaunchSourceDescriptor[]; error?: string }
export interface LaunchImportBridge {
  claimLaunchImport(): Promise<LaunchImportBatch | null>;
  finishLaunchImport(id: string): Promise<{ accepted: boolean }>;
  readLaunchSource(token: string, start: number, end: number): Promise<Uint8Array>;
  describeLaunchSource?(token: string): Promise<{ name: string; size: number; revision: string }>;
  closeLaunchSource(token: string): Promise<{ closed: boolean }>;
  onLaunchImportAvailable(listener: () => void): () => void;
}

/** Bounded lazy transport, with result leases surviving consumption of the batch. */
export function launchSourceFile(source: LaunchSourceDescriptor, bridge: LaunchImportBridge): ScientificSourceFile {
  if (!source || typeof source.token !== 'string' || !source.token || typeof source.name !== 'string' || !source.name
      || !Number.isSafeInteger(source.size) || source.size < 0) throw new Error('启动来源身份无效。');
  let refs = 1, rootClosed = false, closed = false;
  let handleClosed=false,closing:Promise<void>|undefined;
  const live = () => { if (closed) throw new Error('启动来源已关闭。'); };
  const closeHandle=():Promise<void>=>{if(handleClosed||refs!==0)return Promise.resolve();if(closing)return closing;closed=true;closing=Promise.resolve().then(()=>bridge.closeLaunchSource(source.token)).then(()=>{handleClosed=true;}).finally(()=>{closing=undefined;});return closing;};
  const release = async () => { refs--;await closeHandle(); };
  const read = async (start: number, end: number) => {
    live(); const bytes = await bridge.readLaunchSource(source.token, start, end); live();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== end - start) throw new Error('启动来源返回的字节范围不匹配。');
    return new Uint8Array(bytes);
  };
  return {
    name: source.name, size: source.size,
    async readCompanionSourceToken() { await read(0, 0); return source.token; },
    async readCompanionSourceDescriptor() {
      live(); if (!bridge.describeLaunchSource) return undefined;
      const descriptor = await bridge.describeLaunchSource(source.token); live();
      if (descriptor.name !== source.name || descriptor.size !== source.size || !/^[a-f0-9]{64}$/.test(descriptor.revision)) throw new Error('启动来源描述与所选文件不匹配。');
      return { token: source.token, ...descriptor };
    },
    async text() {
      live();
      const decoder = new TextDecoder('utf-8', { fatal: true }), parts: string[] = [];
      for (let start = 0; start < source.size; start += 1024 ** 2) parts.push(decoder.decode(await read(start, Math.min(source.size, start + 1024 ** 2)), { stream: true }));
      parts.push(decoder.decode()); live(); return parts.join('');
    },
    stream() {
      live(); let offset = 0, cancelled = false;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
          try {
            if (cancelled) return;
            if (offset === source.size) { controller.close(); return; }
            const end = Math.min(source.size, offset + 256 * 1024), bytes = await read(offset, end);
            if (cancelled) return;
            offset = end; controller.enqueue(bytes);
          } catch (error) { if (!cancelled) controller.error(error); }
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
    },
    slice(start = 0, end = source.size) {
      live();
      const bound = (value: number) => Math.min(source.size, Math.max(0, value < 0 ? source.size + value : value));
      const from = bound(Math.trunc(start)), to = Math.max(from, bound(Math.trunc(end)));
      return { arrayBuffer: async () => (await read(from, to)).buffer as ArrayBuffer };
    },
    retain() { live(); refs++; let released = false; return async () => { if (!released) { released = true; await release(); }else await closeHandle(); }; },
    async close() { if (!rootClosed) { rootClosed = true; await release(); }else await closeHandle(); },
  };
}

/** Subscribe before claiming so cold-start and ready-time notifications cannot race. */
export function consumeLaunchImports(bridge: LaunchImportBridge, consume: (files: ScientificSourceFile[]) => Promise<void>, onError: (error: string) => void,
    canConsume: () => boolean = () => true) {
  let alive = true, running = false, requested = false;
  async function drain() {
    requested = true;
    if (running) return;
    running = true;
    try {
      while (alive && requested && canConsume()) {
        requested = false;
        const batch = await bridge.claimLaunchImport();
        if (!batch) break;
        const files: ScientificSourceFile[] = [];
        try {
          if (!alive) break;
          if (batch.error) throw new Error(batch.error);
          for (const source of batch.sources) files.push(launchSourceFile(source, bridge));
          await consume(files);
        } catch (error) { if (alive) onError(error instanceof Error ? error.message : String(error)); }
        finally {
          await Promise.all(files.map(file => file.close?.()));
          // If unmounted before adaptation, close every unclaimed descriptor too.
          await Promise.all(batch.sources.slice(files.length).map(source => bridge.closeLaunchSource(source.token)));
          await bridge.finishLaunchImport(batch.id);
        }
        requested = true;
      }
    } catch (error) { if (alive) onError(error instanceof Error ? error.message : String(error)); }
    finally { running = false; if (alive && requested && canConsume()) void drain(); }
  }
  const unsubscribe = bridge.onLaunchImportAvailable(() => { void drain(); });
  void drain();
  return { retry: () => { void drain(); }, dispose() { alive = false; unsubscribe(); } };
}
