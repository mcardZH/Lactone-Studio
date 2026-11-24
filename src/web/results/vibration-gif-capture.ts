import type { Structure } from '../../core/types';
import type { VibrationMode } from '../../results/scientific-contracts';
import { assertResultNotAborted } from '../../results/contracts';
import { prepareVibrationPlayback } from '../../results/spectroscopy';
import { createOffscreenCapture, currentViewportImageSnapshot, type OffscreenCaptureSnapshot } from './export-image';
import { exportVibrationGif, type VibrationGifOutput } from './vibration-gif-export';
import type {ResultByteSink} from '../../results/export';

export interface VibrationGifCaptureRequest {
  snapshot: OffscreenCaptureSnapshot;
  mode: VibrationMode; baseStructure: Structure; amplitude: number; periodMs: number; durationSeconds: number;
  signal?: AbortSignal; onProgress?(completed: number, total: number): void;
  ownerDocument?: Document;
  sink?:ResultByteSink;
}
/** Both result entry points export the same display mode and the same immutable
 * camera/style snapshot. Source frame readers and visible canvases are untouched. */
export async function captureVibrationGif(input: VibrationGifCaptureRequest): Promise<VibrationGifOutput> {
  assertResultNotAborted(input.signal);
  // The existing capture factory clones its explicit renderer fields before
  // allocating resources; callers may carry additional source-reader methods.
  const ownerDocument=input.ownerDocument??document;
  const snapshot=currentViewportImageSnapshot(input.snapshot,ownerDocument);
  const { mode, baseStructure } = structuredClone({ mode: input.mode, baseStructure: input.baseStructure });
  const amplitude = input.amplitude, periodMs = input.periodMs;
  const playback=prepareVibrationPlayback(baseStructure,mode);playback.sample(amplitude,0);
  const parentIndex = snapshot.scalarSourceFrameIndex ?? snapshot.document.revision;
  return exportVibrationGif({ width: snapshot.width, height: snapshot.height, periodMs, durationSeconds: input.durationSeconds,
    signal: input.signal, onProgress: input.onProgress, sink:input.sink }, async () => {
    const capture = await createOffscreenCapture({ ...snapshot, displayGeometry: 'vibration', vibrationBaseStructure: baseStructure }, input.signal,ownerDocument);
    let output: HTMLCanvasElement | null = null;
    return {
      async capture(sample, signal) {
        const phase = Math.sin(sample.timeMs * 2 * Math.PI / periodMs);
        const structure = playback.sample(amplitude, phase);
        const source = await capture.capture(structure, parentIndex, signal);
        assertResultNotAborted(signal);
        if (!output) { output = source.ownerDocument.createElement('canvas'); output.width = snapshot.width; output.height = snapshot.height; }
        const context = output.getContext('2d');
        if (!context || !source.width || !source.height) throw new Error('振动GIF缺少可读取的渲染画布。');
        const scale = Math.min(output.width / source.width, output.height / source.height), width = source.width * scale, height = source.height * scale;
        context.fillStyle = snapshot.display.backgroundColor!; context.fillRect(0, 0, output.width, output.height);
        context.drawImage(source, (output.width - width) / 2, (output.height - height) / 2, width, height);
        return context.getImageData(0, 0, output.width, output.height).data;
      },
      async dispose() { try { await capture.dispose(); } finally { if (output) { output.width = 0; output.height = 0; output = null; } } },
    };
  });
}
