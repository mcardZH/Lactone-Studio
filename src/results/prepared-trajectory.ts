import type { Structure } from '../core/types';
import { assertResultNotAborted, type TrajectoryResult } from './contracts';
import { trajectoryViewDocument } from './playback';
let resources: { memoryBudgetBytes: number; threads?: number } | null = null;
let retainedMemoryBytes=0;
const memoryListeners=new Set<(bytes:number)=>void>();
/** Stable owned JS data estimate, excluding speculative working-copy reserves and GPU memory. */
export function subscribePreparedTrajectoryMemory(callback:(bytes:number)=>void):()=>void{memoryListeners.add(callback);callback(retainedMemoryBytes);return()=>{memoryListeners.delete(callback);};}
function retainedMemoryChanged(delta:number){retainedMemoryBytes+=delta;for(const callback of memoryListeners)callback(retainedMemoryBytes);}
/** The shell supplies the actual global setting; estimates are accounting, never admission gates. */
export function setPreparedTrajectoryResources(value: typeof resources): void {
  if (value && (!Number.isSafeInteger(value.memoryBudgetBytes) || value.memoryBudgetBytes < 1)) throw new Error('轨迹载入资源设置无效。');
  resources = value ? { ...value } : null;
}
export interface PreparationSnapshot {
  mode: 'full' | 'window'; preparing: boolean; completed: number; total: number;
  window: { start: number; end: number } | null;
  retainedBytes: number; workingBytes: number; peakBytes: number; appBytes: number;
  sourceBudgetBytes: number; appBudgetBytes: number; elapsedMs: number; warnings: readonly string[];
  /** Geometry payloads may be referenced by several immutable publications. */
  ownedBytes?:number; sharedBytes?:number;
  /** Frames actually prepared in this owner's elapsed interval, excluding inherited work. */
  measuredCompleted?: number;
}
export interface PreparedFrame { raw: Structure; structure: Structure; sourceIndex: number; }
type PreparedGeometry=Pick<Structure,'atoms'|'bonds'|'bondSource'|'bondPerceptionIssues'|'cell'|'charge'|'multiplicity'|'dimension'|'periodicSource'>;
export type PreparedFrameMetadata=Omit<Structure,keyof PreparedGeometry>;
export type PreparedFrameHeaderAdapter=(frame:PreparedFrame,localIndex:number)=>PreparedFrameMetadata;
const geometryKeys=new Set(['atoms','bonds','bondSource','bondPerceptionIssues','cell','charge','multiplicity','dimension','periodicSource']);
export function preparedFrameMetadata(structure:Structure):PreparedFrameMetadata{
 const {atoms:_a,bonds:_b,bondSource:_s,bondPerceptionIssues:_i,cell:_c,charge:_q,multiplicity:_m,dimension:_d,periodicSource:_p,...metadata}=structure;return metadata;
}
function geometryFields(source:Structure):PreparedGeometry{return {atoms:source.atoms,charge:source.charge,multiplicity:source.multiplicity,
 ...(source.bonds!==undefined?{bonds:source.bonds}:{}),...(source.bondSource!==undefined?{bondSource:source.bondSource}:{}),...(source.bondPerceptionIssues!==undefined?{bondPerceptionIssues:source.bondPerceptionIssues}:{}),
 ...(source.cell!==undefined?{cell:source.cell}:{}),...(source.dimension!==undefined?{dimension:source.dimension}:{}),...(source.periodicSource!==undefined?{periodicSource:source.periodicSource}:{})};}
function withPreparedHeader(frame:PreparedFrame,index:number,adapter?:PreparedFrameHeaderAdapter):PreparedFrame{
 if(!adapter)return frame;const header=adapter(frame,index);
 if(!header||typeof header.id!=='string'||typeof header.name!=='string'||typeof header.format!=='string'||!Array.isArray(header.notes)||Object.keys(header).some(key=>geometryKeys.has(key)))throw new Error('预备帧header适配不得改变几何、电子态或显示连接。');
 const metadata=structuredClone(header),raw=freeze({...metadata,...geometryFields(frame.raw)}),structure=freeze({...metadata,...geometryFields(frame.structure)});
 return freeze({raw,structure,sourceIndex:frame.sourceIndex});
}
export interface PreparedFramePreparer {
  /** Object identity denotes one explicitly compatible preparation policy. */
  reuseContract?:object;
  onInherited?(frame:PreparedFrame,previous:PreparedFrame):void;
  prepareFrame(raw: Structure, sourceIndex: number, signal: AbortSignal): Promise<Structure>;
  /** Atoms-only capability fallbacks remain viewable, but must be retried
   * rather than reused as completed empirical preparation on a later visit. */
  canReuse?(frame: PreparedFrame): boolean;
  dispose?(): void;
}
export type PreparedFramePreparerFactory = (source: TrajectoryResult, warn: (message: string) => void) => PreparedFramePreparer;
export class PreparationBudgetError extends Error { constructor(message = '当前全局资源设置尚不可用，请等待设置就绪后重新载入。') { super(message); this.name = 'PreparationBudgetError'; } }

/** Conservative JS allocation estimate, including containers, strings and references.
 * Shared objects are counted once within the owned raw/display pair, not once per view. */
export function preparedBytes(value: unknown, seen = new Set<object>()): number {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return 24 + value.length * 2;
  if (typeof value !== 'object') return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 64 + value.byteLength;
  if (value instanceof ArrayBuffer) return 32 + value.byteLength;
  if (Array.isArray(value)) return 48 + value.length * 8 + value.reduce((sum, entry) => sum + preparedBytes(entry, seen), 0);
  return 64 + Object.entries(value).reduce((sum, [key, entry]) => sum + 16 + key.length * 2 + preparedBytes(entry, seen), 0);
}
function freeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value); for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}
function sameGeometry(a: Structure, b: Structure): boolean {
  return a.charge === b.charge && a.multiplicity === b.multiplicity && a.atoms.length === b.atoms.length
    && a.atoms.every((atom, index) => { const other = b.atoms[index]; return Object.keys(atom).length === Object.keys(other).length && Object.entries(atom).every(([key, value]) => value === other[key as keyof typeof other]); })
    && (a.cell === b.cell || JSON.stringify(a.cell ?? null) === JSON.stringify(b.cell ?? null));
}
const abortError = () => new DOMException('轨迹预备已取消。', 'AbortError');

/** One ledger for all source owners in this renderer; no allocation is pre-reserved globally. */
export class PreparedTrajectoryBudget {
  private bySource = new Map<string, number>();
  bytes = 0; peakBytes = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly sourceBytes = Infinity, readonly appBytes = Infinity) {}
  /** Serialize temporary frame preparation across owners instead of evicting active results. */
  async schedule<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  used(source: string) { return this.bySource.get(source) ?? 0; }
  resize(source: string, delta: number): boolean {
    const sourceBytes = this.used(source) + delta, appBytes = this.bytes + delta;
    if (sourceBytes < 0 || appBytes < 0) throw new Error('轨迹预备内存归属不一致。');
    if (sourceBytes) this.bySource.set(source, sourceBytes); else this.bySource.delete(source);
    this.bytes = appBytes; this.peakBytes = Math.max(this.peakBytes, appBytes); return true;
  }
}
const appBudget = new PreparedTrajectoryBudget();
type Entry = PreparedFrame & { bytes: number };
interface SharedGeometry {geometry:{raw:PreparedGeometry;structure:PreparedGeometry};warnings:readonly string[];bytes:number;references:number;budget:PreparedTrajectoryBudget;sourceKey:string}
// Metadata wrappers own their property slots and references; the two maps and
// entry node are charged here, while the shared geometry graphs are charged once.
const entryBytes=(frame:PreparedFrame)=>preparedBytes({raw:preparedFrameMetadata(frame.raw),structure:preparedFrameMetadata(frame.structure),sourceIndex:frame.sourceIndex})+192+24*(Object.keys(geometryFields(frame.raw)).length+Object.keys(geometryFields(frame.structure)).length);
const frameIdentities=new WeakMap<TrajectoryResult,{identities:readonly object[];header?:PreparedFrameHeaderAdapter}>();
/** An adapter registers its actual immutable geometry tokens, never IDs guessed from names. */
export function registerPreparedTrajectoryFrameIdentities(result:TrajectoryResult,identities:readonly object[],header?:PreparedFrameHeaderAdapter){
 if(identities.length!==result.frames.length||identities.some(value=>!value||typeof value!=='object')||new Set(identities).size!==identities.length)throw new Error('预备帧来源身份不完整或重复。');
 const old=frameIdentities.get(result);if(old){if(old.header!==header||old.identities.some((value,index)=>value!==identities[index]))throw new Error('固定结果不能重新绑定帧来源身份。');return;}
 frameIdentities.set(result,{identities:Object.freeze([...identities]),header});
}
function preparationContext(result:TrajectoryResult){const source=result.initialStructure;return JSON.stringify([result.id,result.source.id,result.source.name,result.engine,result.kind,result.jobIndex,
 source.charge,source.multiplicity,source.dimension??null,source.periodicSource??null,source.cell??null,
 source.atoms.map(({x:_x,y:_y,z:_z,...metadata})=>metadata)]);}
interface Pending {
  index: number; priority: boolean; controller: AbortController; consumers: number;
  promise: Promise<Entry>; resolve(value: Entry): void; reject(error: unknown): void;
}

/** Source lifetime owner. It never owns a Store, model, camera, selection or QM task. */
export class PreparedTrajectorySource {
  private entries = new Map<number, Entry>();
  private measuredFrames = new Set<number>();
  private shares=new Map<number,SharedGeometry>();
  private sharedBytes=0;
  private frameWarnings:Set<string>|null=null;
  private pins = new Map<number, number>();
  private pending = new Map<number, Pending>();
  private queue: Pending[] = [];
  private running = false;
  private closed = false;
  private retained = 0;
  private working = 0;
  private peak = 0;
  private elapsedMs = 0;
  private workingStartedAt: number | null = null;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private lastNotification = -Infinity;
  private resourceBytes = 0;
  private listeners = new Set<() => void>();
  private warnings = new Set<string>();
  private preparer: PreparedFramePreparer;
  private indexBytes: number;
  readonly indices: readonly number[];
  constructor(readonly source: TrajectoryResult, factory: PreparedFramePreparerFactory, readonly budget = appBudget) {
    this.indices = source.frames.map((_, index) => index);
    this.indexBytes = preparedBytes(source.frames) + preparedBytes(this.indices) + preparedBytes(source.initialStructure);
    if (!budget.resize(source.source.id, this.indexBytes)) throw new PreparationBudgetError();
    this.retained = this.indexBytes; this.peak = this.retained;
    try { this.preparer = factory(source, message => { this.frameWarnings?.add(message);if (!this.warnings.has(message)) { this.warnings.add(message); this.notify(); } }); }
    catch (error) { budget.resize(source.source.id, -this.retained); throw error; }
    if(this.budget===appBudget)retainedMemoryChanged(this.retained);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(immediate = false) {
    if (this.closed) return;
    const elapsed = Date.now() - this.lastNotification;
    if (!immediate && elapsed < 250) {
      this.notificationTimer ??= setTimeout(() => { this.notificationTimer = undefined; this.notify(true); }, 250 - elapsed);
      return;
    }
    if (this.notificationTimer !== undefined) clearTimeout(this.notificationTimer);
    this.notificationTimer = undefined; this.lastNotification = Date.now(); this.listeners.forEach(listener => listener());
  }
  snapshot(indices: readonly number[], focus = 0): PreparationSnapshot {
    const completed = indices.reduce((count, index) => count + Number(this.entries.has(index)), 0);
    let start = this.entries.has(indices[focus]) ? focus : indices.findIndex(index => this.entries.has(index)), end = start;
    if (start >= 0) {
      while (start > 0 && this.entries.has(indices[start - 1])) start--;
      while (end + 1 < indices.length && this.entries.has(indices[end + 1])) end++;
    }
    return { mode: 'full', preparing: this.pending.size > 0, completed, total: indices.length,
      window: start < 0 ? null : { start, end }, retainedBytes: this.retained+this.sharedBytes, ownedBytes:this.retained,sharedBytes:this.sharedBytes,workingBytes: this.working,
      peakBytes: this.peak, appBytes: this.budget.bytes, sourceBudgetBytes: this.resourceBytes, appBudgetBytes: this.resourceBytes,
      elapsedMs: this.elapsedMs + (this.workingStartedAt === null ? 0 : Date.now() - this.workingStartedAt), measuredCompleted: this.measuredFrames.size, warnings: [...this.warnings] };
  }
  get(index: number): PreparedFrame | undefined { return this.entries.get(index); }
  /** An atoms-only fallback may be displayed but cannot bypass ensure on reuse. */
  canReuse(index: number): boolean { const frame = this.entries.get(index); return !!frame && this.preparer.canReuse?.(frame) !== false; }
  get usesWindows() { return false; }
  pin(index: number) { if (!this.entries.has(index)) throw new Error('不能固定未预备帧。'); this.pins.set(index, (this.pins.get(index) ?? 0) + 1); }
  unpin(index: number) { const count = this.pins.get(index) ?? 0; if (count > 1) this.pins.set(index, count - 1); else this.pins.delete(index); }
  private allocate(bytes: number) {
    if (!this.budget.resize(this.source.source.id, bytes)) throw new PreparationBudgetError();
    this.working += bytes; this.peak = Math.max(this.peak, this.retained+this.sharedBytes + this.working);
    this.notify();
  }
  private removeEntry(index:number){const entry=this.entries.get(index);if(!entry)return;this.entries.delete(index);this.retained-=entry.bytes;this.budget.resize(this.source.source.id,-entry.bytes);if(this.budget===appBudget)retainedMemoryChanged(-entry.bytes);
   const shared=this.shares.get(index);this.shares.delete(index);if(shared){this.sharedBytes-=shared.bytes;if(--shared.references===0){shared.budget.resize(shared.sourceKey,-shared.bytes);if(shared.budget===appBudget)retainedMemoryChanged(-shared.bytes);}}
  }
  /** Explicit immutable prefix transfer; no read, parse, geometry clone or native operation. */
  inheritPrefix(previous:PreparedTrajectorySource,previousIndices:readonly number[],indices:readonly number[]):number{
   if(this.closed||previous.closed||this===previous||this.budget!==previous.budget||!this.preparer.reuseContract||this.preparer.reuseContract!==previous.preparer.reuseContract||preparationContext(this.source)!==preparationContext(previous.source))return 0;
   const from=frameIdentities.get(previous.source),next=frameIdentities.get(this.source);if(!from||!next)return 0;
   if(!next.header&&JSON.stringify(preparedFrameMetadata(this.source.initialStructure))!==JSON.stringify(preparedFrameMetadata(previous.source.initialStructure)))return 0;
   let inherited=0;for(let local=0;local<Math.min(previousIndices.length,indices.length);local++){
    const sourceIndex=previousIndices[local],index=indices[local];if(sourceIndex!==index||from.identities[sourceIndex]!==next.identities[index])break;
    if(this.entries.has(index)||this.pending.has(index)||!previous.canReuse(sourceIndex))continue;
    const old=previous.entries.get(sourceIndex),shared=previous.shares.get(sourceIndex);if(!old||!shared)continue;
    const frame=withPreparedHeader(old,local,next.header);trajectoryViewDocument(this.source,frame.raw,index);trajectoryViewDocument(this.source,frame.structure,index);
    if(!sameGeometry(old.raw,frame.raw)||!sameGeometry(old.structure,frame.structure))throw new Error('前缀继承不得改变源几何或电子态。');
    const bytes=entryBytes(frame),entry=freeze({...frame,sourceIndex:index,bytes});this.preparer.onInherited?.(entry,old);if(!this.budget.resize(this.source.source.id,bytes))throw new PreparationBudgetError();
    shared.references++;this.entries.set(index,entry);this.shares.set(index,shared);this.retained+=bytes;this.sharedBytes+=shared.bytes;if(this.budget===appBudget)retainedMemoryChanged(bytes);
    for(const warning of shared.warnings)this.warnings.add(warning);inherited++;
   }
   if(inherited){this.peak=Math.max(this.peak,this.retained+this.sharedBytes);this.notify(true);}return inherited;
  }
  /** All accepted frames remain resident until this source owner is disposed. */
  async ensure(index: number, signal?: AbortSignal, priority = false): Promise<PreparedFrame> {
    assertResultNotAborted(signal);
    if (this.closed) throw new Error('轨迹预备来源已关闭。');
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.source.frames.length) throw new Error('轨迹预备帧越界。');
    const ready = this.entries.get(index);
    if (ready && this.preparer.canReuse?.(ready) !== false) return ready;
    // Keep a usable atoms-only display and its accounted raw geometry while
    // retrying only the incomplete projection. Publication replaces it below.
    let job = this.pending.get(index);
    if (job?.controller.signal.aborted) job = undefined;
    if (!job) {
      let resolve!: Pending['resolve'], reject!: Pending['reject'];
      const promise = new Promise<Entry>((yes, no) => { resolve = yes; reject = no; });
      job = { index, priority, promise, resolve, reject, controller: new AbortController(), consumers: 0 };
      this.pending.set(index, job); this.queue.push(job);
      this.notify();
    } else if (priority) job.priority = true;
    const selected = job; selected.consumers++;
    return new Promise<PreparedFrame>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, frame?: PreparedFrame) => {
        if (done) return; done = true; signal?.removeEventListener('abort', stop); selected.consumers--;
        if (!selected.consumers && this.pending.get(index) === selected) selected.controller.abort();
        if (error) reject(error); else resolve(frame!);
      };
      const stop = () => finish(abortError());
      selected.promise.then(frame => finish(undefined, frame), error => finish(error));
      signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
      void this.pump();
    });
  }
  async fill(indices: readonly number[], signal?: AbortSignal, start = 0, end = indices.length): Promise<void> {
    if (this.budget === appBudget && !resources) throw new PreparationBudgetError();
    if (!this.resourceBytes) this.resourceBytes = resources?.memoryBudgetBytes ?? this.budget.appBytes;
    for (let local = start; local < Math.min(indices.length, end); local++) {
      const index = indices[local];
      assertResultNotAborted(signal);
      await this.ensure(index, signal);
    }
    this.notify(true);
  }
  private async pump() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        this.queue.sort((a, b) => Number(b.priority) - Number(a.priority));
        const job = this.queue.shift()!;
        const started = Date.now(); let reservation = 0;
        this.workingStartedAt = started;
        this.frameWarnings=new Set();
        try {
          assertResultNotAborted(job.controller.signal);
          // Include source-reader LRU, native/request/result clones and keys in the preparation reserve.
          const expected = preparedBytes(this.source.initialStructure);
          const reserve = (bytes: number) => this.allocate(bytes);
          const requested = expected * 16 + 4096;
          reserve(requested);
          reservation = requested;
          // initialStructure may be a collection's reference model, not its
          // first accepted candidate. Every frame uses its indexed geometry.
          const { raw, projection } = await this.budget.schedule(async () => {
            assertResultNotAborted(job.controller.signal);
            const raw = this.entries.get(job.index)?.raw ?? await this.source.getFrame(job.index, job.controller.signal);
            assertResultNotAborted(job.controller.signal);
            trajectoryViewDocument(this.source, raw, job.index); freeze(raw);
            const projection = await this.preparer.prepareFrame(raw, job.index, job.controller.signal);
            return { raw, projection };
          });
          assertResultNotAborted(job.controller.signal); if (this.closed) throw abortError();
          const actualReserve = preparedBytes(raw) * 16 + 4096;
          if (actualReserve > reservation) { reserve(actualReserve - reservation); reservation = actualReserve; }
          assertResultNotAborted(job.controller.signal); if (this.closed) throw abortError();
          trajectoryViewDocument(this.source, projection, job.index);
          if (!sameGeometry(raw, projection)) throw new Error('预备显示不得改变原帧原子、坐标或电子态。');
          const structure = { ...projection, atoms: raw.atoms }, frame = { raw, structure, sourceIndex: job.index };
          const geometry=freeze({raw:geometryFields(raw),structure:geometryFields(structure)}),warnings=Object.freeze([...(this.frameWarnings??[])]),payloadBytes=preparedBytes({geometry,warnings})+96;
          const bytes=entryBytes(frame),totalBytes=bytes+payloadBytes;
          if (totalBytes > reservation) { reserve(totalBytes - reservation); reservation = totalBytes; }
          const entry = freeze({ ...frame, bytes });
          this.removeEntry(job.index);
          const shared:SharedGeometry={geometry,warnings,bytes:payloadBytes,references:1,budget:this.budget,sourceKey:this.source.source.id};
          this.entries.set(job.index, entry);this.shares.set(job.index,shared); this.retained += bytes;this.sharedBytes+=payloadBytes;
          this.measuredFrames.add(job.index);
          if(this.budget===appBudget)retainedMemoryChanged(totalBytes);
          this.working -= totalBytes; reservation -= totalBytes;
          job.resolve(entry);
        } catch (error) { job.reject(error); }
        finally {
          if (reservation) { this.working -= reservation; this.budget.resize(this.source.source.id, -reservation); }
          this.elapsedMs += Date.now() - started;
          this.workingStartedAt = null;
          this.frameWarnings=null;
          if (this.pending.get(job.index) === job) this.pending.delete(job.index);
          this.notify();
        }
      }
    } finally { this.running = false; }
  }
  dispose() {
    if (this.closed) return; this.closed = true;
    if(this.notificationTimer!==undefined)clearTimeout(this.notificationTimer);this.notificationTimer=undefined;
    for (const job of this.pending.values()) { job.controller.abort(); job.reject(abortError()); }
    this.queue = []; this.pending.clear(); this.preparer.dispose?.();for(const index of this.entries.keys())this.removeEntry(index);this.shares.clear();this.sharedBytes=0;this.pins.clear();this.measuredFrames.clear();
    this.budget.resize(this.source.source.id, -this.retained); if(this.budget===appBudget)retainedMemoryChanged(-this.retained);this.retained = 0; this.listeners.clear();
    // In-flight reservations are released by pump's finally, not twice here.
  }
}

export class PreparedTrajectoryView {
  private pinned: number | undefined;
  private pendingPins = new Set<number>();
  private focus = 0;
  private prefetchController?: AbortController;
  private adapted?:{input:PreparedFrame;index:number;frame:PreparedFrame};
  private lifetime=new AbortController();
  private subscriptions=new Set<()=>void>();
  constructor(readonly owner: PreparedTrajectorySource, readonly indices: readonly number[],private header?:PreparedFrameHeaderAdapter) {}
  /** Independent view lifetime over the same immutable source and header policy. */
  fork(){return new PreparedTrajectoryView(this.owner,this.indices,this.header);}
  private present(frame:PreparedFrame|undefined,index:number){if(!frame||!this.header)return frame;if(this.adapted?.input===frame&&this.adapted.index===index)return this.adapted.frame;const value=withPreparedHeader(frame,index,this.header);this.adapted={input:frame,index,frame:value};return value;}
  subscribe = (listener: () => void) => {const stop=this.owner.subscribe(()=>{if(!this.lifetime.signal.aborted)listener();});this.subscriptions.add(stop);return()=>{stop();this.subscriptions.delete(stop);};};
  /** Only an explicit view/effect setup renews a released view lifetime. */
  reacquire(){if(this.lifetime.signal.aborted)this.lifetime=new AbortController();}
  private signal(signal?:AbortSignal){return signal?AbortSignal.any([this.lifetime.signal,signal]):this.lifetime.signal;}
  snapshot = () => this.owner.snapshot(this.indices, this.focus);
  get(index: number) { const original = this.indices[index]; return original === undefined ? undefined : this.present(this.owner.get(original),index); }
  canReuse(index: number) { const original = this.indices[index]; return original !== undefined && this.owner.canReuse(original); }
  async prepare(signal?: AbortSignal) { const current=this.signal(signal);await this.owner.fill(this.indices, current);assertResultNotAborted(current); }
  async ensure(index: number, signal?: AbortSignal) {
    signal=this.signal(signal);assertResultNotAborted(signal);
    if (!Number.isSafeInteger(index) || this.indices[index] === undefined) throw new Error('阶段预备帧越界。');
    const original = this.indices[index], frame = await this.owner.ensure(original, signal, true);
    assertResultNotAborted(signal);
    if (!this.pendingPins.has(original) && original !== this.pinned) { this.owner.pin(original); this.pendingPins.add(original); }
    return this.present(frame,index)!;
  }
  /** Never hold a foreground publication behind a window fill. A seek/pause or
   * the next view publication can cancel this view's background consumer. */
  prefetch(start = 0) {
    this.cancelPrefetch();
    const controller = new AbortController(); this.prefetchController = controller;
    void this.owner.fill(this.indices, this.signal(controller.signal), start).catch(() => { /* Foreground prepare reports real errors. */ })
      .finally(() => { if (this.prefetchController === controller) this.prefetchController = undefined; });
  }
  cancelPrefetch() { this.prefetchController?.abort(); this.prefetchController = undefined; }
  pin(index: number) {
    assertResultNotAborted(this.lifetime.signal);
    this.focus = index;
    const original = this.indices[index]; if (original === this.pinned) return;
    if (!this.pendingPins.delete(original)) this.owner.pin(original);
    if (this.pinned !== undefined) this.owner.unpin(this.pinned); this.pinned = original;
  }
  release() {
    this.lifetime.abort();for(const stop of this.subscriptions)stop();this.subscriptions.clear();
    this.cancelPrefetch();
    if (this.pinned !== undefined) this.owner.unpin(this.pinned); this.pinned = undefined;
    for (const index of this.pendingPins) this.owner.unpin(index); this.pendingPins.clear();
    this.adapted=undefined;
  }
}

interface PreparedProjectionBinding {source:TrajectoryResult;indices:readonly number[];header?:PreparedFrameHeaderAdapter;adapted?:{input:WeakRef<PreparedFrame>;index:number;frame:WeakRef<PreparedFrame>}}
const bindings = new WeakMap<TrajectoryResult, PreparedProjectionBinding>();
const owners = new WeakMap<TrajectoryResult, PreparedTrajectorySource>();
/** Read-only admission check. It must never allocate an owner or start work. */
export function isPreparedTrajectoryReady(result: TrajectoryResult): boolean {
  const binding = bindings.get(result), owner = owners.get(binding?.source ?? result);
  const indices = binding?.indices ?? owner?.indices;
  return !!owner && !!indices?.length && indices.every(index => owner.get(index) !== undefined);
}
export function getPreparedTrajectoryFrame(result: TrajectoryResult, index: number): PreparedFrame | undefined {
  const binding = bindings.get(result);
  const frame=owners.get(binding?.source ?? result)?.get(binding ? binding.indices[index] : index);if(!frame||!binding?.header)return frame;
  const cached=binding.adapted?.frame.deref();if(binding.adapted?.input.deref()===frame&&binding.adapted.index===index&&cached)return cached;
  const projected=withPreparedHeader(frame,index,binding.header);binding.adapted={input:new WeakRef(frame),index,frame:new WeakRef(projected)};return projected;
}
/** Called by the stage adapter: source identity is explicit, never inferred from an id string. */
export function registerPreparedTrajectoryProjection(source: TrajectoryResult, projection: TrajectoryResult, indices: readonly number[],header?:PreparedFrameHeaderAdapter) {
  const parent = bindings.get(source);
  const adapter=header??(parent?.header?((frame:PreparedFrame,index:number)=>parent.header!(frame,indices[index])):undefined);
  bindings.set(projection, { source: parent?.source ?? source, indices: parent ? indices.map(index => parent.indices[index]) : indices,header:adapter });
}
export function preparedTrajectoryView(result: TrajectoryResult, factory: PreparedFramePreparerFactory): PreparedTrajectoryView {
  const binding = bindings.get(result), source = binding?.source ?? result;
  let owner = owners.get(source);
  if (!owner) {
    owner = new PreparedTrajectorySource(source, factory); owners.set(source, owner);
    const dispose = source.dispose.bind(source), owned = owner;
    source.dispose = () => { owned.dispose(); return dispose(); };
  }
  return new PreparedTrajectoryView(owner, binding?.indices ?? owner.indices,binding?.header);
}
export function inheritPreparedTrajectoryPrefix(previous:PreparedTrajectoryView,next:PreparedTrajectoryView):number{return next.owner.inheritPrefix(previous.owner,previous.indices,next.indices);}
