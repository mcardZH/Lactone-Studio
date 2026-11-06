import { assertResultNotAborted } from '../results/contracts';

interface ManagedSourceBridge {
  beginProjectCompanionBundle?(request: { files: { role: 'output'; name: string; bytes: number; revision?: string }[] }): Promise<{ bundleId: string }>;
  appendProjectCompanionBundle?(bundleId: string, role: 'output', start: number, bytes: Uint8Array): Promise<{ written: number }>;
  commitProjectCompanionBundle?(bundleId: string): Promise<{ bundleId: string; sourceToken: string; revision?: string }>;
  abortProjectCompanionBundle?(bundleId: string): Promise<unknown>;
  closeProjectCompanionBundle?(bundleId: string): Promise<unknown>;
  describeLaunchSource?(token: string): Promise<{ name: string; size: number; revision: string }>;
}
/** Restore source bytes in bounded chunks through the existing owner-bound
 * project-source store. No old absolute path or whole-source IPC is involved. */
export function createRestoredManagedSource(source: { name: string; size: number; revision?: string; stream(): ReadableStream<Uint8Array> }, api?: ManagedSourceBridge) {
  let closed = false, pending: Promise<{ bundleId: string; token: string; name: string; size: number; revision: string }> | undefined;
  let released=false,closing:Promise<void>|undefined;
  const pendingAborts=new Map<string,ManagedSourceBridge>();
  const bridge = () => api ?? (typeof window === 'undefined' ? undefined : window.sciyueDesktop) as ManagedSourceBridge | undefined;
  const live = () => { if (closed) throw new Error('项目原始来源已关闭。'); };
  async function describe(signal?: AbortSignal) {
    assertResultNotAborted(signal); live();
    if (!pending) {
      const host = bridge();
      if (!host?.beginProjectCompanionBundle || !host.appendProjectCompanionBundle || !host.commitProjectCompanionBundle || !host.abortProjectCompanionBundle) throw new Error('当前版本缺少项目原始来源恢复入口。');
      const task = (async () => {
        const { bundleId } = await host.beginProjectCompanionBundle!({ files: [{ role: 'output', name: source.name, bytes: source.size, ...(source.revision ? { revision: source.revision } : {}) }] });
        let input: ReadableStreamDefaultReader<Uint8Array> | undefined, start = 0;
        try {
          live(); input = source.stream().getReader();
          for (;;) {
            live(); const next = await input.read(); live(); if (next.done) break;
            for (let offset = 0; offset < next.value.byteLength; offset += 1024 ** 2) {
              const bytes = next.value.subarray(offset, Math.min(next.value.byteLength, offset + 1024 ** 2));
              const receipt = await host.appendProjectCompanionBundle!(bundleId, 'output', start, bytes); live();
              if (receipt.written !== bytes.byteLength) throw new Error('项目来源恢复写入不完整。'); start += bytes.byteLength;
            }
          }
          if (start !== source.size) throw new Error('项目来源恢复长度不一致。');
          const saved = await host.commitProjectCompanionBundle!(bundleId); live();
          const checked = saved.revision ? { name: source.name, size: source.size, revision: saved.revision } : await host.describeLaunchSource?.(saved.sourceToken);
          if (!checked || checked.name !== source.name || checked.size !== source.size || !/^[a-f0-9]{64}$/.test(checked.revision) || source.revision && checked.revision !== source.revision) throw new Error('项目来源恢复身份不一致。');
          return { bundleId, token: saved.sourceToken, ...checked };
        } catch (error) { try{await host.abortProjectCompanionBundle!(bundleId);}catch{pendingAborts.set(bundleId,host);}throw error; }
        finally { if (input) { await input.cancel().catch(() => {}); input.releaseLock(); } }
      })();
      pending = task; void task.catch(() => { if (pending === task) pending = undefined; });
    }
    const descriptor = await pending; assertResultNotAborted(signal); live(); return descriptor;
  }
  return {
    available: () => Boolean(bridge()?.beginProjectCompanionBundle),
    describe,
    async token(signal?: AbortSignal) { return (await describe(signal)).token; },
    async close() { if(released)return;if(closing)return closing;closed=true;closing=(async()=>{const restored=await pending?.catch(()=>undefined);if(restored){const host=bridge();if(!host?.closeProjectCompanionBundle)throw Error('项目来源关闭入口不可用，保留原owner等待重试。');await host.closeProjectCompanionBundle(restored.bundleId);}for(const[id,host]of pendingAborts){await host.abortProjectCompanionBundle!(id);pendingAborts.delete(id);}released=true;})().finally(()=>{closing=undefined;});return closing; },
  };
}
