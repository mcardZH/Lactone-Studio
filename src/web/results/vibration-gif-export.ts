import { assertResultNotAborted } from '../../results/contracts';
import { createGifEncoder, type GifFrame } from '../../results/gif';
import type { ResultByteSink } from '../../results/export';

export interface VibrationGifTimingOptions {
  durationSeconds: number;
  /** Current display period; never adjusted to fit an integer number of cycles. */
  periodMs: number;
  /** Sampling cadence, independent of the display period. Defaults to 25 fps. */
  frameDelayMs?: number;
}
export interface VibrationGifSample { index: number; timeMs: number; delayMs: number }
export interface VibrationGifPlan {
  requestedDurationMs: number; actualDurationMs: number; frameCount: number; periodMs: number;
  /** Samples are lazy so even validation of a long request allocates no frame array. */
  sample(index: number): VibrationGifSample;
}

/** GIF delays are integer centiseconds. Only duration/cadence are quantized;
 * callers drive the same on-screen vibration function with sample.timeMs. */
export function planVibrationGif(options: VibrationGifTimingOptions): VibrationGifPlan {
  const requestedDurationMs = options.durationSeconds * 1000;
  if (!Number.isFinite(requestedDurationMs) || requestedDurationMs < 5
    || !Number.isFinite(options.periodMs) || options.periodMs <= 0) {
    throw new Error('GIF时长须至少0.005秒，播放周期须为正有限数。');
  }
  const requestedDelay = options.frameDelayMs ?? 40;
  if (!Number.isFinite(requestedDelay) || requestedDelay < 10 || requestedDelay > 655350) {
    throw new Error('GIF帧延时应为10–655350毫秒。');
  }
  const ticks = Math.round(requestedDurationMs / 10), delayTicks = Math.round(requestedDelay / 10);
  if (!Number.isSafeInteger(ticks) || ticks < 1 || !Number.isSafeInteger(ticks * 10)) {
    throw new Error('GIF时长超出安全范围。');
  }
  const frameCount = Math.ceil(ticks / delayTicks), actualDurationMs = ticks * 10;
  return {
    requestedDurationMs, actualDurationMs, frameCount, periodMs: options.periodMs,
    sample(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= frameCount) throw new Error('GIF采样帧号无效。');
      const startTicks = index * delayTicks;
      return { index, timeMs: startTicks * 10, delayMs: Math.min(delayTicks, ticks - startTicks) * 10 };
    },
  };
}

export interface VibrationGifOptions extends VibrationGifTimingOptions {
  width: number; height: number; loop?: boolean; signal?: AbortSignal;
  sink?:ResultByteSink;
  onProgress?(completed: number, total: number): void;
}
export interface VibrationGifCapture {
  /** RGBA belongs to this capture and may be reused after this awaited call.
   * The exporter consumes each frame synchronously and retains no RGBA frames. */
  capture(sample: VibrationGifSample, signal?: AbortSignal): Promise<GifFrame['rgba']>;
  dispose(): void | Promise<void>;
}
export interface VibrationGifOutput {
  blob: Blob; requestedDurationMs: number; actualDurationMs: number; frameCount: number;
}

function validateBudget(options: VibrationGifOptions): void {
  if (![options.width, options.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)) throw new Error('GIF格式的宽和高须为1–65535像素。');
}

/** The capture factory owns the current camera/style snapshot and scientific
 * displacement. This scheduler never changes source frames or display settings.
 * Its only retained sequence data is the bounded encoded GIF byte stream. */
export async function exportVibrationGif(options: VibrationGifOptions,
  createCapture: () => Promise<VibrationGifCapture>): Promise<VibrationGifOutput> {
  assertResultNotAborted(options.signal);
  const plan = planVibrationGif(options);
  validateBudget(options);
  const capture = await createCapture();
  try {
    assertResultNotAborted(options.signal);
    const encoder = createGifEncoder(options.width, options.height, options.loop ?? true);
    for (let index = 0; index < plan.frameCount; index++) {
      assertResultNotAborted(options.signal);
      const sample = plan.sample(index);
      const rgba = await capture.capture(sample, options.signal);
      assertResultNotAborted(options.signal);
      encoder.addFrame({ rgba, delayMs: sample.delayMs });
      if(options.sink)for(const part of encoder.takeChunks())await options.sink.write(part);
      options.onProgress?.(index + 1, plan.frameCount);
      // Allow cancellation, document closure and progress painting between frames.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    assertResultNotAborted(options.signal);
    const parts = encoder.finishChunks();
    if(options.sink)for(const part of parts)await options.sink.write(part);
    return { blob: new Blob(options.sink?[]:parts, { type: 'image/gif' }), requestedDurationMs: plan.requestedDurationMs,
      actualDurationMs: plan.actualDurationMs, frameCount: plan.frameCount };
  } finally { await capture.dispose(); }
}
