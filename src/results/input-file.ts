import { assertResultNotAborted, type ResultInputFile } from './contracts';
import { traceTrajectoryOperation } from './trajectory-operations';

/** Browser Files and host-issued sources share reading, never filesystem discovery. */
export interface ScientificSourceFile {
  name: string;
  size: number;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array<ArrayBuffer>>;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
  /** A result wrapper retains its source independently from the initial batch. */
  retain?(): () => void | Promise<void>;
  close?(): void | Promise<void>;
  /** An existing launch-source token is borrowed through the same file lease. */
  readCompanionSourceToken?(): Promise<string | undefined>;
  readCompanionSourceDescriptor?(signal?: AbortSignal): Promise<{ token: string; name: string; size: number; revision: string } | undefined>;
}

export interface ResultFileCompanionPorts {
  register(file: File): Promise<{ token: string; name: string; size: number }>;
  close(token: string): Promise<unknown>;
  describe?(token: string): Promise<{ name: string; size: number; revision: string }>;
}

export function resultFile(file: ScientificSourceFile, companionPorts?: ResultFileCompanionPorts): ResultInputFile {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('结果文件字节数须为非负安全整数。');
  const release = file.retain?.();
  const id = `result-source-${crypto.randomUUID()}`;
  let source: ScientificSourceFile | null = file;
  const streams = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let companion: Promise<string | undefined> | undefined, registeredToken: string | undefined, closing: Promise<void> | undefined;
  let leaseReleased=false,fullyClosed=false;
  const live = () => { if (!source) throw new Error('结果来源已关闭。'); return source; };
  const closeRegistered = async () => { const token = registeredToken;if(token){await companionPorts!.close(token);if(registeredToken===token)registeredToken=undefined;} };
  const input: ResultInputFile = {
    id, name: file.name, size: file.size, readTrace: 'source-boundary',
    stream() {
      const reader = live().stream().getReader(); streams.add(reader);
      let released = false;
      function release() { if (!released) { released = true; streams.delete(reader); reader.releaseLock(); } }
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            live();
            const next = await traceTrajectoryOperation('read', { sourceId: id, workPhase: 'stream-read' }, () => reader.read());
            live(); if (next.done) { controller.close(); release(); } else controller.enqueue(next.value);
          }
          catch (cause) { controller.error(cause); if (!released) { await reader.cancel().catch(() => {}); release(); } }
        },
        async cancel() { try { await reader.cancel(); } finally { release(); } },
      }, { highWaterMark: 0 });
    },
    async readRange(start, end, signal) {
      assertResultNotAborted(signal);
      if (![start,end].every(Number.isSafeInteger) || start < 0 || end < start || end > file.size || end-start > 64 * 1024 ** 2) throw new Error('结果帧字节范围无效或过大。');
      const current = live();
      const bytes = new Uint8Array(await traceTrajectoryOperation('read', { sourceId: id, workPhase: 'range-read' },
        () => current.slice(start,end).arrayBuffer()));
      assertResultNotAborted(signal); live(); return bytes;
    },
    async readCompanionSourceToken(signal) {
      assertResultNotAborted(signal); const current = live();
      if (!companion) companion = (async () => {
        if (current.readCompanionSourceToken) return current.readCompanionSourceToken();
        if (!companionPorts || typeof File === 'undefined' || !(current instanceof File)) return undefined;
        const descriptor = await companionPorts.register(current);
        if (typeof descriptor.token === 'string' && descriptor.token) registeredToken = descriptor.token;
        try {
          live();
          if (!registeredToken || descriptor.name !== file.name || descriptor.size !== file.size) throw new Error('OUT配套来源登记与所选文件不对应。');
          return registeredToken;
        } catch (error) { await closeRegistered(); throw error; }
      })();
      const token = await companion; assertResultNotAborted(signal); live(); return token;
    },
    async readCompanionSourceDescriptor(signal) {
      assertResultNotAborted(signal); const current = live();
      const descriptor = current.readCompanionSourceDescriptor
        ? await current.readCompanionSourceDescriptor(signal)
        : await (async () => {
          const token = await input.readCompanionSourceToken!(signal);
          if (!token || !companionPorts?.describe) return undefined;
          return { token, ...await companionPorts.describe(token) };
        })();
      assertResultNotAborted(signal); live();
      if (descriptor && (descriptor.name !== file.name || descriptor.size !== file.size || !/^[a-f0-9]{64}$/.test(descriptor.revision))) throw new Error('受管来源描述与所选文件不对应。');
      return descriptor;
    },
    async close() {
      if(fullyClosed)return;if (closing) return closing; source = null;
      closing = (async () => {
        await Promise.all([...streams].map(async reader => { await reader.cancel().catch(() => {}); }));
        await companion?.catch(() => {});
        const outcomes=await Promise.allSettled([closeRegistered(),(async()=>{if(!leaseReleased){await release?.();leaseReleased=true;}})()]);
        const failures=outcomes.filter((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');if(failures.length)throw new AggregateError(failures.map(outcome=>outcome.reason),'结果来源读取owner仍待实际关闭。');fullyClosed=true;
      })().finally(()=>{closing=undefined;}); return closing;
    },
  };
  return input;
}
