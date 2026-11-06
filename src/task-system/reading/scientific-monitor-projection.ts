import type { ResultInputFile, ResultReadOptions, ScientificFileResults } from '../../results/contracts';
import type { ScientificParserSnapshot } from '../../results/scientific-contracts';
import { readScientificSnapshotResults } from '../../results/scientific-reader';
import type { ScientificReadSnapshot } from './contracts';

/** A monitoring consumer of the exact frozen byte/index pair. This calls no
 * semantic parser, bond perception, wavefunction analysis or native program. */
export async function projectScientificMonitorSnapshot(snapshot: ScientificReadSnapshot<ScientificParserSnapshot>, options: ResultReadOptions = {}): Promise<ScientificFileResults> {
  const lease = snapshot.bytes.retain();
  const size = snapshot.sourceBoundary.publishedByteRange.end;
  let closed = false;
  const close = () => { if (!closed) { closed = true; lease.release(); } };
  const file: ResultInputFile = {
    id: snapshot.snapshotId,
    name: snapshot.identity.path.split(/[\\/]/).at(-1) || 'output', size,
    async readRange(start, end, signal) {
      if (closed) throw new Error('监控科学来源已关闭。');
      if (end > size) throw new Error('请求超出已发布科学字节边界。');
      return lease.readRange(start, end, signal);
    },
    stream() {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (closed) { controller.error(new Error('监控科学来源已关闭。')); return; }
          if (offset >= size) { controller.close(); return; }
          const end = Math.min(size, offset + 256 * 1024); controller.enqueue(await lease.readRange(offset, end)); offset = end;
        }
      });
    }, close
  };
  try {
    const results = await readScientificSnapshotResults(file, snapshot.value, options);
    if (snapshot.integrity === 'damaged-tail') {
      for (const result of [...results.results, ...results.diagnostics]) {
        const scientific = result.scientific;
        if (scientific?.diagnostics) scientific.diagnostics = { ...scientific.diagnostics, integrity: { status: 'damaged-tail', message: '原始来源坏尾已隔离，仅使用此前完整科学前缀。' } };
      }
    }
    return results;
  } catch (error) { close(); throw error; }
}
