import type { Structure } from '../core/types';
import type { TrajectoryRange, TrajectoryResult } from './contracts';
import { advancePlayback, LatestFrameReader, playbackRange, trajectoryViewDocument, type PlaybackDirection, type PlaybackMode } from './playback';
import type { PreparedTrajectoryView, PreparationSnapshot } from './prepared-trajectory';
import { recordTrajectoryOperation } from './trajectory-operations';

export interface OptPlaybackSnapshot {
  frame: { index: number; structure: Structure };
  /** A source-confirmed TS in this result's local frame numbering, never an energy maximum. */
  tsFrameIndex: number | null;
  preparation: PreparationSnapshot | null;
  busy: boolean; error: string; playing: boolean; previewing: boolean;
  loading: boolean; loadCancelled: boolean; silentLoading: boolean;
  /** Live incremental handoff keeps the selected ready frame while preparing its tail. */
  holdingFrameDuringPreparation?:boolean;
  /** Failed/busy preparation is retryable and is never a user cancellation. */
  loadFailed?: boolean;
  previewStartedAt: number | null; previewCompletedAt: number | null;
  frameDelayMs: number; fps: number; direction: PlaybackDirection; mode: PlaybackMode; range: TrajectoryRange; endpointPauseMs: number;
}

export interface OptPlaybackSessionOptions {
  autoPreview?: boolean;
  /** New sessions preview at25FPS too; an explicit historical delay remains valid. */
  previewFrameDelayMs?: number;
  /** Explicit source-confirmed local TS. null disables the stage-derived TS. */
  tsFrameIndex?: number | null;
  /** Prepare an existing frame's display projection; never start a QM or analysis request. */
  prepareFrame?(raw: Structure, index: number, signal?: AbortSignal): Promise<Structure>;
  prepared?: PreparedTrajectoryView;
  initialFrameIndex?: number;
  mode?: PlaybackMode;
  frameOrder?: readonly number[];
  notifyPreparation?: boolean;
  restored?: Pick<OptPlaybackSnapshot, 'frameDelayMs' | 'fps' | 'direction' | 'mode' | 'range' | 'endpointPauseMs'> & { frameIndex: number };
  /** Only an already-open, proven same-source incremental view may supply this intent. */
  liveContinuation?:Pick<OptPlaybackSnapshot,'playing'|'silentLoading'>;
}
export type OptPlaybackViewState=NonNullable<OptPlaybackSessionOptions['restored']>&Pick<OptPlaybackSnapshot,'playing'|'silentLoading'>;
/** Historical sessions scheduled milliseconds. A missing millisecond field
 * may use an explicit FPS; zero/invalid values are never treated as missing. */
export function restoredPlaybackRate(saved:{frameDelayMs?:number;fps?:number}){
 const frameDelayMs=saved.frameDelayMs===undefined?1000/(saved.fps??NaN):saved.frameDelayMs;
 if(!Number.isFinite(frameDelayMs)||frameDelayMs<=0||!Number.isFinite(1000/frameDelayMs))throw Error('保存的轨迹播放速度无效。');
 return{frameDelayMs,fps:1000/frameDelayMs};
}

function confirmedTsFrame(result: TrajectoryResult, supplied: number | null | undefined): number | null {
  const stage = result.stages?.length === 1 ? result.stages[0] : undefined;
  const completeStage = stage?.kind === 'irc' && stage.frameIndices.length === result.frames.length
    && new Set(stage.frameIndices).size === result.frames.length
    && stage.frameIndices.every(index => Number.isSafeInteger(index) && index >= 0 && index < result.frames.length);
  const candidate = supplied !== undefined ? supplied : completeStage ? stage.tsFrameIndex : undefined;
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate < result.frames.length
    && (supplied !== undefined || stage!.frameIndices.includes(candidate)) ? candidate : null;
}

/** A display-only owner: it reads and prepares existing frames without mutating models or requesting QM. */
export class OptPlaybackSession {
  private state: OptPlaybackSnapshot;
  private listeners = new Set<() => void>();
  private reader = new LatestFrameReader();
  private readController: AbortController | null = null;
  private batchController: AbortController | null = null;
  private batchProgressTimer?: ReturnType<typeof setInterval>;
  private lastPreparationUpdate = -Infinity;
  private batchAttempted = false;
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerSerial = 0;
  private active = false;
  private ready = false;
  private previewAttempted = false;
  private previewReturning = false;
  private landingIndex: number | undefined;
  private readonly autoPreview: boolean;
  private readonly prepareFrame: OptPlaybackSessionOptions['prepareFrame'];
  private initialFramePrepared: boolean;
  private playAfterPreparation = false;
  private readonly prepared?: PreparedTrajectoryView;
  private frameOrder: readonly number[];
  private unsubscribePreparation?: () => void;
  private readonly notifyPreparation: boolean;
  private readonly liveContinuation:boolean;
  private liveResumePlaying=false;
  /** Spatial restore survives batch preparation independently of live play intent. */
  private preparationLanding:number|undefined;
  readonly previewFrameDelayMs: number;
  onError?: (message: string) => void;

  constructor(readonly result: TrajectoryResult, options: boolean | OptPlaybackSessionOptions = true) {
    const configuration = typeof options === 'boolean' ? { autoPreview: options } : options;
    this.autoPreview = configuration.autoPreview ?? true;
    this.previewFrameDelayMs = configuration.previewFrameDelayMs ?? 40;
    if (!Number.isInteger(this.previewFrameDelayMs) || this.previewFrameDelayMs < 1 || this.previewFrameDelayMs > 10000) throw new Error('首次预览的帧延迟无效。');
    this.prepareFrame = configuration.prepareFrame;
    this.notifyPreparation = configuration.notifyPreparation ?? true;
    this.prepared = configuration.prepared;
    this.liveContinuation=Boolean(configuration.liveContinuation&&configuration.restored);
    this.frameOrder = configuration.frameOrder ?? result.frames.map((_, index) => index);
    this.validateFrameOrder(this.frameOrder);
    this.initialFramePrepared = !(this.prepareFrame || this.prepared) || result.frames.length === 0;
    const tsFrameIndex = confirmedTsFrame(result, configuration.tsFrameIndex);
    if (!this.autoPreview && tsFrameIndex !== null) this.landingIndex = tsFrameIndex;
    if (configuration.initialFrameIndex !== undefined) this.landingIndex = configuration.initialFrameIndex;
    this.state = { frame: { index: 0, structure: result.initialStructure }, tsFrameIndex, preparation: this.prepared?.snapshot() ?? null, loading: false, loadCancelled: false, silentLoading: false, busy: !this.initialFramePrepared, error: '', playing: false, previewing: false, previewStartedAt: null, previewCompletedAt: null,
      frameDelayMs: 40, fps: 25, direction: 1, mode: configuration.mode ?? 'once', range: { start: 0, end: Math.max(0, result.frames.length - 1), stride: 1 }, endpointPauseMs: 0 };
    if (configuration.restored) {
      const saved = configuration.restored;
      const rate=restoredPlaybackRate(saved);
      playbackRange(saved.range, result.frames.length);
      if (!Number.isSafeInteger(saved.frameIndex) || saved.frameIndex < 0 || saved.frameIndex >= result.frames.length
        || ![1,-1].includes(saved.direction) || !['once','loop','bounce'].includes(saved.mode)
        || !Number.isInteger(saved.endpointPauseMs) || saved.endpointPauseMs < 0 || saved.endpointPauseMs > 10000) throw new Error('保存的轨迹播放设置无效。');
      this.state = {...this.state, ...rate, direction:saved.direction, mode:saved.mode, range:{...saved.range}, endpointPauseMs:saved.endpointPauseMs};
      this.landingIndex = saved.frameIndex; this.preparationLanding=saved.frameIndex; this.previewAttempted = true;
      if(this.liveContinuation){this.liveResumePlaying=Boolean(configuration.liveContinuation?.playing);this.state={...this.state,silentLoading:Boolean(configuration.liveContinuation?.silentLoading)};}
      const current=this.prepared?.canReuse(saved.frameIndex)?this.prepared.get(saved.frameIndex):undefined;if(current){this.state={...this.state,frame:{index:saved.frameIndex,structure:current.structure},busy:false};this.initialFramePrepared=true;}
    }
  }
  getSnapshot = () => this.state;
  captureViewState=():OptPlaybackViewState=>({frameIndex:this.preparationLanding??this.state.frame.index,frameDelayMs:this.state.frameDelayMs,fps:this.state.fps,direction:this.state.direction,mode:this.state.mode,range:{...this.state.range},endpointPauseMs:this.state.endpointPauseMs,silentLoading:this.state.silentLoading,playing:this.liveContinuation&&this.state.loading?this.liveResumePlaying:this.state.playing});
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<OptPlaybackSnapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private clearTimer() { this.timerSerial++; if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  private waitUntil(deadline: number, action: () => void, serial = this.timerSerial) {
    const remaining = Math.max(0, deadline - performance.now());
    // Long native waits were late in the measured renderer. Reserve a short final wait,
    // then check the real deadline; never advance a frame early or poll a long pause.
    this.timer = setTimeout(() => {
      if (serial !== this.timerSerial) return;
      this.timer = undefined;
      if (!this.active || !this.ready || !this.state.playing) return;
      if (performance.now() < deadline) this.waitUntil(deadline, action, serial);
      else action();
    }, Math.min(2147483647,remaining > 20 ? remaining - 20 : remaining));
  }
  private cancelRead(cancelBackground = true) { this.epoch++; this.readController?.abort(); this.readController = null; this.reader.cancel(); if (cancelBackground) this.prepared?.cancelPrefetch(); }
  private validateFrameOrder(order: readonly number[]) {
    if (order.length !== this.result.frames.length || new Set(order).size !== order.length || order.some(index => !Number.isSafeInteger(index) || index < 0 || index >= order.length)) throw new Error('轨迹播放顺序必须包含全部帧且不得重复。');
  }
  setFrameOrder(order: readonly number[]) { this.validateFrameOrder(order); if (order.every((index, position) => index === this.frameOrder[position])) return; this.pause(); this.frameOrder = [...order]; }
  /** Effect cleanup is reversible: StrictMode may set up this same owner again.
   * Keep preview/manual intent, but release every live resource and invalidate reads.
   * The source itself belongs to the workspace and must not be disposed here. */
  dispose() {
    this.active = false; this.ready = false;
    this.clearTimer(); this.cancelRead(); this.batchController?.abort(); this.batchController = null; this.batchAttempted = false; clearInterval(this.batchProgressTimer); this.batchProgressTimer = undefined;
    this.unsubscribePreparation?.(); this.unsubscribePreparation = undefined; this.prepared?.release();
    this.state = { ...this.state, busy: false, ...(this.prepared ? { loading: false, playing: false, previewing: false } : {}) };
    this.listeners.clear();
  }
  setEnvironment(active: boolean, ready: boolean) {
    this.active = active; this.ready = ready;
    if (!this.unsubscribePreparation && this.prepared) this.unsubscribePreparation = this.prepared.subscribe(() => this.updatePreparation());
    if (!active) {
      const attempted = this.previewAttempted, landingIndex = this.landingIndex;
      this.pause(); this.previewAttempted = attempted; this.landingIndex = landingIndex;
      return;
    }
    if (!ready) { this.clearTimer(); return; }
    if (this.prepared && !this.batchAttempted && !this.state.loadCancelled && !this.state.loadFailed && this.prepared.snapshot().completed < this.prepared.indices.length) {
      void this.loadBatch(); return;
    }
    if (this.state.loading || this.state.loadCancelled || this.state.loadFailed) return;
    // A source may have been opened before native capability was ready. React
    // activation/readiness must refresh that same frame without a manual seek.
    if (this.initialFramePrepared && this.prepared && !this.prepared.get(this.state.frame.index) && !this.readController) {
      void this.load(this.state.frame.index); return;
    }
    if (this.initialFramePrepared && this.prepared?.canReuse(this.state.frame.index)) this.prepared.pin(this.state.frame.index);
    this.resumeReady();
  }
  private resumeReady(publishedAt?: number) {
    if (!this.active || !this.ready) return;
    if (this.state.loading || this.state.loadCancelled || this.state.loadFailed) return;
    if (!this.initialFramePrepared) { this.schedule(); return; }
    if(this.liveContinuation&&this.liveResumePlaying){this.liveResumePlaying=false;this.play();return;}
    if (this.playAfterPreparation) { this.playAfterPreparation = false; this.play(); return; }
    if (!this.prepared && !this.previewAttempted && this.autoPreview && this.result.frames.length > 1) {
      this.previewAttempted = true; this.publish({ playing: true, previewing: true, previewStartedAt: Date.now(), previewCompletedAt: null });
    }
    this.schedule(publishedAt);
  }
  private updatePreparation() {
    if(!this.prepared||this.state.loading&&Date.now()-this.lastPreparationUpdate<250)return;
    this.lastPreparationUpdate=Date.now();const preparation=this.prepared.snapshot();
    const preview=this.state.loading&&!this.state.silentLoading&&!this.state.holdingFrameDuringPreparation&&this.active&&preparation.completed>0?this.prepared.get(preparation.completed-1):undefined;
    if(preview)this.initialFramePrepared=true;
    if(this.notifyPreparation||this.state.loading)this.publish({preparation,...(preview&&this.state.frame.structure!==preview.structure?{frame:{index:preparation.completed-1,structure:preview.structure}}:{})});
  }
  pause = () => { this.liveResumePlaying=false;this.previewAttempted = true; this.playAfterPreparation = false; this.landingIndex = undefined; this.clearTimer(); this.cancelRead(); this.publish({ playing: false, previewing: false, busy: false }); };
  seek = (index: number) => {
    if (this.state.loading || this.state.loadCancelled || this.state.loadFailed) return;
    this.pause();
    if (this.active && this.ready) void this.load(index);
  };
  seekTs = () => { if (this.state.tsFrameIndex !== null) this.seek(this.state.tsFrameIndex); };
  prepare = () => { this.pause(); if (this.active && this.ready && this.prepared) void this.loadBatch(); };
  setSilentLoading = (silentLoading: boolean) => { this.publish({ silentLoading,...(this.liveContinuation?{holdingFrameDuringPreparation:false}:{}) }); };
  cancelPreparation = () => {
    this.liveResumePlaying=false;
    this.batchController?.abort(); this.batchController = null;
    clearInterval(this.batchProgressTimer); this.batchProgressTimer = undefined;
    this.publish({ loading: false, busy: false, previewing: false, playing: false, loadCancelled: true, loadFailed:false, preparation: this.prepared?.snapshot() ?? null });
  };
  private async loadBatch() {
    if (!this.prepared || this.batchController) return;
    const resume=this.liveResumePlaying,landing=this.preparationLanding??this.landingIndex??(this.liveContinuation?this.state.frame.index:0);
    this.batchAttempted = true; this.pause();this.preparationLanding=landing;if(this.liveContinuation)this.liveResumePlaying=resume;
    const controller = new AbortController(); this.batchController = controller;
    this.batchProgressTimer = setInterval(() => { if(this.batchController===controller)this.updatePreparation(); },250);
    this.publish({ loading: true, loadCancelled: false, loadFailed:false, silentLoading:this.liveContinuation?this.state.silentLoading:false, busy: true, error: '', previewing:!this.liveContinuation,previewStartedAt:this.liveContinuation?null:Date.now(),previewCompletedAt:null,...(this.liveContinuation?{holdingFrameDuringPreparation:true}:{}) });
    try {
      await this.prepared.prepare(controller.signal);
      if (controller.signal.aborted || this.batchController !== controller) return;
      const preparation = this.prepared.snapshot(), first = this.prepared.get(landing);
      if (preparation.completed !== preparation.total || !first) throw new Error('轨迹尚未完整准备，不能开始全量播放。');
      this.initialFramePrepared = true; this.landingIndex = undefined;this.preparationLanding=undefined;this.previewAttempted = true; this.prepared.pin(landing);
      this.publish({ frame: { index: landing, structure: first.structure }, preparation, loading: false, busy: false, playing: false, previewing: false, previewCompletedAt:this.liveContinuation?null:Date.now(),...(this.liveContinuation?{holdingFrameDuringPreparation:false}:{}) });
      if(this.liveContinuation&&this.liveResumePlaying&&this.active&&this.ready){this.liveResumePlaying=false;this.play();}
    } catch (cause) {
      if (!controller.signal.aborted && this.batchController === controller) {
        const error = cause instanceof Error ? cause.message : String(cause);
        this.publish({ error, loading: false, busy: false, previewing: false, loadCancelled: false, loadFailed:true, preparation: this.prepared.snapshot() }); this.onError?.(error);
      }
    } finally { if (this.batchController === controller) { this.batchController = null; clearInterval(this.batchProgressTimer); this.batchProgressTimer = undefined; } }
  }
  step = (direction: PlaybackDirection) => {
    if (this.state.loading || this.state.loadCancelled || this.state.loadFailed) return;
    this.pause();
    if (!this.active || !this.ready || !this.result.frames.length) return;
    const next = advancePlayback(this.frameOrder.indexOf(this.state.frame.index), this.state.range, this.result.frames.length, direction, 'once');
    if (!next.stopped) void this.load(this.frameOrder[next.index]);
  };
  play = () => {
    if (!this.active || !this.ready || this.result.frames.length < 2) return;
    if (this.prepared && (this.state.loading || this.state.loadCancelled || this.state.loadFailed || this.prepared.snapshot().completed !== this.prepared.indices.length)) return;
    if (!this.initialFramePrepared) { this.previewAttempted = true; this.playAfterPreparation = true; this.schedule(); return; }
    this.pause();
    const { range, direction, mode, frame } = this.state;
    const bounds = playbackRange(range, this.result.frames.length);
    if (bounds.length < 2) return;
    const playbackIndex = this.frameOrder.indexOf(frame.index);
    const position = (playbackIndex - range.start) / (bounds.sign * range.stride);
    const restart = position < 0 || position >= bounds.length || mode === 'once' && playbackIndex === (direction === 1 ? bounds.last : bounds.first);
    this.publish({ playing: true });
    if (restart) void this.load(this.frameOrder[direction === 1 ? bounds.first : bounds.last]);
    else this.schedule();
  };
  setFrameDelay = (frameDelayMs: number) => {
    if (Number.isFinite(frameDelayMs) && frameDelayMs > 0 && Number.isFinite(1000/frameDelayMs)) this.configure({ frameDelayMs, fps: 1000 / frameDelayMs });
  };
  setFps = (fps: number) => { if (Number.isFinite(fps) && fps > 0 && Number.isFinite(1000/fps)) this.configure({ frameDelayMs: 1000 / fps, fps }); };
  setDirection = (direction: PlaybackDirection) => { if (direction === 1 || direction === -1) this.configure({ direction }); };
  setMode = (mode: PlaybackMode) => { if (['once', 'loop', 'bounce'].includes(mode)) this.configure({ mode }); };
  setEndpointPause = (endpointPauseMs: number) => { if (Number.isInteger(endpointPauseMs) && endpointPauseMs >= 0 && endpointPauseMs <= 10000) this.configure({ endpointPauseMs }); };
  setRange = (range: TrajectoryRange) => {
    playbackRange(range, this.result.frames.length);
    this.pause(); this.publish({ range });
  };
  private configure(patch: Partial<OptPlaybackSnapshot>) {
    if (this.state.previewing) this.pause();
    this.clearTimer(); this.publish(patch); this.schedule();
  }
  private async load(index: number, initial?: Structure, prepareAll = false) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.result.frames.length || !this.active || !this.ready) return;
    if (index === this.state.frame.index && this.initialFramePrepared && !prepareAll && (!this.prepared || this.prepared.get(index))) { this.landingIndex = undefined;this.preparationLanding=undefined; this.schedule(); return; }
    this.cancelRead(false);
    const epoch = this.epoch, controller = new AbortController(); this.readController = controller;
    const current = () => epoch === this.epoch && this.active && !controller.signal.aborted;
    const cached = this.prepared?.get(index);
    if (!cached) this.publish({ busy: true, error: '' });
    try {
      let structure: Structure;
      if (this.prepared) {
        const pending = cached ?? this.prepared.ensure(index, controller.signal);
        this.prepared.cancelPrefetch();
        const frame = await pending;
        if (!current()) return;
        recordTrajectoryOperation('memory', { sourceId: this.prepared.owner.source.source.id, resultId: this.prepared.owner.source.id,
          jobIndex: this.prepared.owner.source.jobIndex, sourceFrameIndex: frame.sourceIndex, stageId: this.result.stages?.[0]?.id, localFrameIndex: index });
        this.prepared.pin(index); structure = frame.structure;
      } else {
        const raw = initial ?? await this.reader.read(this.result, index, controller.signal);
        if (!raw || !current()) return;
        trajectoryViewDocument(this.result, raw, index);
        structure = this.prepareFrame ? await this.prepareFrame(raw, index, controller.signal) : raw;
        if (!current()) return;
        if (this.prepareFrame) trajectoryViewDocument(this.result, structure, index);
      }
      this.initialFramePrepared = true;
      if (this.landingIndex === index) this.landingIndex = undefined;
      this.preparationLanding = undefined;
      const interval = this.state.preparation?.window;
      const changedWindow = this.state.preparation?.mode === 'window' && (!interval || index < interval.start || index > interval.end);
      const publishedAt = performance.now();
      this.publish({ frame: { index, structure }, busy: false,
        ...(this.prepared && (!cached || initial || prepareAll || changedWindow) ? { preparation: this.prepared.snapshot() } : {}) });
      if (!current()) return;
      if (this.state.previewing && (this.previewReturning || index === this.result.frames.length - 1 && (this.state.tsFrameIndex === null || this.state.tsFrameIndex === index)))
        this.publish({ playing: false, previewing: false, previewCompletedAt: Date.now() });
      else if (this.state.playing && !this.state.previewing && this.state.mode === 'once') {
        const bounds = playbackRange(this.state.range, this.result.frames.length);
        if (this.frameOrder.indexOf(index) === (this.state.direction === 1 ? bounds.last : bounds.first)) this.publish({ playing: false });
      }
      this.resumeReady(publishedAt);
      // Current frame is already visible. A background consumer can be aborted
      // independently when the user seeks, pauses or closes this view.
    } catch (cause) {
      if (!current()) return;
      const error = cause instanceof Error ? cause.message : String(cause);
      this.pause(); this.publish({ error }); this.onError?.(error);
    } finally { if (this.readController === controller) this.readController = null; }
  }
  private schedule(publishedAt?: number) {
    this.clearTimer();
    if (this.state.loading || this.state.loadCancelled || this.state.loadFailed) return;
    if (!this.active || !this.ready) return;
    const landing = this.preparationLanding ?? this.landingIndex;
    if (!this.initialFramePrepared) {
      if (!this.readController) { const index = landing ?? 0; void this.load(index, index===0?this.result.initialStructure:undefined); }
      return;
    }
    if (this.state.busy) return;
    if (landing !== undefined) { void this.load(landing); return; }
    if (!this.state.playing) return;
    // Anchor only this displayed frame. Never carry a missed deadline into a later frame/read.
    const deadline = (delay: number) => (publishedAt ?? performance.now()) + delay;
    if (this.state.previewing) {
      this.waitUntil(deadline(this.previewFrameDelayMs), () => {
        if (this.state.frame.index === this.result.frames.length - 1) {
          if (this.state.tsFrameIndex !== null) { this.previewReturning = true; void this.load(this.state.tsFrameIndex); }
        } else void this.load(this.state.frame.index + 1);
      });
    } else {
      const { frame, range, direction, mode, frameDelayMs, endpointPauseMs } = this.state;
      const playbackIndex = this.frameOrder.indexOf(frame.index);
      const bounds = playbackRange(range, this.result.frames.length);
      this.waitUntil(deadline(frameDelayMs + (playbackIndex === bounds.first || playbackIndex === bounds.last ? endpointPauseMs : 0)), () => {
        const next = advancePlayback(playbackIndex, range, this.result.frames.length, direction, mode);
        if (next.stopped) this.publish({ playing: false });
        else { if (next.direction !== this.state.direction) this.publish({ direction: next.direction }); void this.load(this.frameOrder[next.index]); }
      });
    }
  }
}
