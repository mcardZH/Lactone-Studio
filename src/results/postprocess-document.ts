import { assertResultNotAborted, type ResultFrameSummary, type ResultInputFile, type TrajectoryResult } from './contracts';
import type { Structure } from '../core/types';
import type { OrbitalChannel, ScientificData } from './scientific-contracts';
import { isScientificFileSource, postprocessFileJob, postprocessFileJobSource, postprocessMetadataConflict, type PostprocessFileSource, type PostprocessScientificFileSource, type PostprocessSource, type PostprocessSourcePair } from './postprocess-sources';
import { registerPreparedTrajectoryProjection } from './prepared-trajectory';
import { publishNmrCouplings } from './nmr-coupling-projection';
import { mdQuantityKeys } from './md-observations';

export interface PostprocessAttachment {
  source: PostprocessSource;
  role?: PostprocessAttachmentRole;
  /** Only the wavefunction attachment owns a native cache session. */
  nativeSessionId?: string;
  /** One immutable source snapshot shared by every non-owning stage/view. */
  readonly readSourceText?: (signal?: AbortSignal) => Promise<Readonly<PostprocessSourceText>>;
  /** Host registration remains owned by the original OUT input lease. */
  readonly readCompanionSourceToken?: (signal?: AbortSignal) => Promise<string | undefined>;
}
export type PostprocessAttachmentRole = import('./contracts').ResultFileRole | 'irc-forward' | 'irc-reverse' | 'hess' | 'wavefunction' | 'excitation-json' | 'excitation-cis';
export interface PostprocessScientificFileAttachment { source: PostprocessScientificFileSource; role?: PostprocessAttachmentRole }
export type PostprocessFileAttachment = PostprocessAttachment | PostprocessScientificFileAttachment;
export interface PostprocessSourceText { name: string; text?: string; sourceToken?: string; sourceId: string; sourceRevision: string }
interface RetainedSourceText {
  snapshot: Readonly<PostprocessSourceText> | null;
  closed?: boolean;
  read(signal?: AbortSignal): Promise<Readonly<PostprocessSourceText>>;
  readCompanionSourceToken?: PostprocessAttachment['readCompanionSourceToken'];
}
const retainedSourceText = new WeakMap<PostprocessFileSource, RetainedSourceText>();
const retainedSourceInputs = new WeakMap<PostprocessFileSource, ResultInputFile>();
const retiredByteSources = new WeakSet<PostprocessFileSource>();
const projectedByteOwners = new WeakMap<PostprocessSource, PostprocessSource>();
function sourceBytesRetired(source: PostprocessSource): boolean {
  return retiredByteSources.has(projectedByteOwners.get(source) ?? source);
}
interface SharedAttachmentOwner { users: number; close(): Promise<void> }
const sharedAttachmentOwners = new WeakMap<PostprocessSource, SharedAttachmentOwner>();
/** A second document borrows the same immutable asset with an independent
 * consumer lease. Closing either document cannot retire the other's reader. */
export function sharePostprocessAttachment(attachment: PostprocessAttachment): PostprocessAttachment {
  if (attachment.nativeSessionId || !['xyz','hess'].includes(attachment.source.kind)) throw Error('仅已保存几何/模态配套可借来源卡共享；原生分析会话保原owner。');
  let owner = sharedAttachmentOwners.get(attachment.source);
  if (!owner) {
    const results = [...new Set([attachment.source.result, ...attachment.source.results])], disposers = results.map(result => result.dispose.bind(result));
    let closing: Promise<void> | undefined, done = false;
    owner = { users: 1, close() { if (done) return Promise.resolve(); if (closing) return closing; closing = Promise.all(disposers.map(dispose => dispose())).then(() => { done = true; }).finally(() => { closing = undefined; }); return closing; } };
    const state = owner; let released = false;
    const release = async () => { if (!released) { released = true; state.users--; } if (!state.users) await state.close(); };
    for (const result of results) result.dispose = release;
    sharedAttachmentOwners.set(attachment.source, owner);
  }
  owner.users++;
  const state = owner; let released = false;
  const release = async () => { if (!released) { released = true; state.users--; } if (!state.users) await state.close(); };
  const clones = new Map<TrajectoryResult, TrajectoryResult>();
  const clone = (result: TrajectoryResult) => { let value = clones.get(result); if (!value) { value = { ...result, getFrame: result.getFrame.bind(result), dispose: release }; clones.set(result, value); } return value; };
  const source: PostprocessSource = { ...attachment.source, result: clone(attachment.source.result), results: attachment.source.results.map(clone) };
  sharedAttachmentOwners.set(source, owner);
  const input = retainedSourceInputs.get(attachment.source); if (input) retainedSourceInputs.set(source, input);
  const text = retainedSourceText.get(attachment.source); if (text) retainedSourceText.set(source, text);
  return { ...attachment, source };
}

export function retainPostprocessFileSourceBytes<T extends PostprocessFileAttachment>(attachment: T, input: ResultInputFile): T {
  if (!isScientificFileSource(attachment.source)) { retainPostprocessSourceBytes(attachment as PostprocessAttachment, input); return attachment; }
  const source = attachment.source, identity = source.identity;
  if (identity.id !== input.id || identity.name !== input.name || identity.size !== input.size) throw Error('文件来源原始字节身份不一致。');
  if (retiredByteSources.has(source)) throw Error('文件来源已关闭。');
  const existing = retainedSourceInputs.get(source);
  if (existing && existing !== input) throw Error('文件来源读取租约不能被替换。');
  if (!existing) {
    const dispose = source.dispose.bind(source);
    source.dispose = async () => { await dispose(); retiredByteSources.add(source); };
  }
  retainedSourceInputs.set(source, input); return attachment;
}
export async function readPostprocessFileSourceBytes(attachment: PostprocessFileAttachment, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!isScientificFileSource(attachment.source)) return readPostprocessSourceBytes(attachment as PostprocessAttachment, start, end, signal);
  assertResultNotAborted(signal);
  const source = attachment.source, input = retainedSourceInputs.get(source), identity = source.identity;
  if (retiredByteSources.has(source) || !input || input.id !== identity.id || input.size !== identity.size || input.name !== identity.name) throw Error('无法取得文件来源原始读取租约。');
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > identity.size) throw Error('文件来源字节范围无效。');
  const bytes = await input.readRange(start, end, signal); assertResultNotAborted(signal);
  if (retiredByteSources.has(source) || bytes.length !== end - start) throw Error('文件来源已变化或关闭。');
  return bytes;
}

/** Select a job while retaining the entire file and its original lease. */
export function selectPostprocessFileJob(attachment: PostprocessScientificFileAttachment, jobId: string): PostprocessScientificFileAttachment {
  if (!attachment.source.jobs.some(job => job.id === jobId)) throw Error('所选job不属于当前文件。');
  if (retiredByteSources.has(attachment.source)) throw Error('文件来源已关闭。');
  const job = attachment.source.jobs.find(job => job.id === jobId)!;
  const source: PostprocessScientificFileSource = { ...attachment.source, selectedJobId: jobId, tasks: job.scientific?.tasks ?? [] };
  const input = retainedSourceInputs.get(attachment.source); if (input) retainedSourceInputs.set(source, input);
  return { ...attachment, source };
}

/** Reuse the inspected source lease. Native consumers snapshot this token to
 * their owned directory and verify the content revision, without a text JSON. */
export async function retainPostprocessManagedSource(attachment: PostprocessAttachment, input: ResultInputFile, signal?: AbortSignal): Promise<PostprocessAttachment> {
  retainPostprocessSourceBytes(attachment, input);
  const source = attachment.source, metadata = source.metadata;
  const descriptor = await input.readCompanionSourceDescriptor?.(signal);
  assertResultNotAborted(signal);
  if (!descriptor) throw new Error('当前来源没有可验证的受管读取通道。');
  if (descriptor.name !== input.name || descriptor.size !== input.size || !/^[a-f0-9]{64}$/.test(descriptor.revision)
    || metadata && (metadata.sourceId !== input.id || metadata.sourceRevision !== descriptor.revision)) throw new Error('受管来源与已读取的科学来源不对应。');
  const existing = retainedSourceText.get(source);
  if (existing) return { ...attachment, readSourceText: existing.read, readCompanionSourceToken: existing.readCompanionSourceToken };
  const state: RetainedSourceText = {
    snapshot: Object.freeze({ name: input.name, sourceToken: descriptor.token, sourceId: input.id, sourceRevision: descriptor.revision }),
    async read(signal) {
      assertResultNotAborted(signal);
      if (!state.snapshot || retiredByteSources.has(source)) throw new Error('原始受管来源已关闭。');
      await input.readRange(0, 0, signal); assertResultNotAborted(signal);
      if (!state.snapshot || retiredByteSources.has(source)) throw new Error('原始受管来源已关闭。');
      if (source.result.source.id !== input.id || source.result.source.name !== input.name || source.result.source.size !== input.size
        || source.metadata && (source.metadata.sourceId !== state.snapshot.sourceId || source.metadata.sourceRevision !== state.snapshot.sourceRevision)) throw new Error('原始受管来源已失效。');
      return state.snapshot;
    },
    async readCompanionSourceToken(signal) { return (await state.read(signal)).sourceToken; },
  };
  retainedSourceText.set(source, state);
  for (const result of new Set([source.result, ...source.results])) {
    const originalDispose = result.dispose.bind(result); let disposed: Promise<void> | undefined;
    result.dispose = () => { state.snapshot = null; state.closed = true; if (!disposed) disposed = Promise.resolve().then(originalDispose); return disposed; };
  }
  return { ...attachment, readSourceText: state.read, readCompanionSourceToken: state.readCompanionSourceToken };
}

/** Project persistence borrows the exact import lease, never a path lookup.
 * Ranges stay bounded so large OUT files are copied without materializing a
 * second full-file text representation. The source owner retains disposal. */
export function retainPostprocessSourceBytes(attachment: PostprocessAttachment, input: ResultInputFile): PostprocessAttachment {
  const { source } = attachment, identity = source.result.source;
  if (identity.id !== input.id || identity.name !== input.name || identity.size !== input.size) throw new Error('原始字节与已导入来源不对应。');
  const existing = retainedSourceInputs.get(source);
  if (retiredByteSources.has(source)) throw new Error('原始来源已关闭。');
  if (existing && existing !== input) throw new Error('已绑定的来源读取器不能被替换。');
  if (!existing) for (const result of new Set([source.result, ...source.results])) {
    const dispose = result.dispose.bind(result);
    result.dispose = () => { retiredByteSources.add(source); return dispose(); };
  }
  retainedSourceInputs.set(source, input);
  return attachment;
}
/** A scientific stage/display projection of the SAME selected raw asset.
 * Transfer its existing byte/text mapping, not a guessed filename or a new
 * reader. The derived result keeps the original reader's disposal owner. */
export function projectPostprocessAttachment(attachment:PostprocessAttachment,result:TrajectoryResult,results:readonly TrajectoryResult[]=[result]):PostprocessAttachment {
  const before=attachment.source.result.source,after=result.source;
  if(before.id!==after.id||before.name!==after.name||before.size!==after.size||before.sha256&&after.sha256&&before.sha256!==after.sha256)throw Error('配套投影与原始资产身份不一致，未转移来源读取器。');
  if(results.some(row=>row.source.id!==before.id||row.source.name!==before.name||row.source.size!==before.size||before.sha256&&row.source.sha256&&before.sha256!==row.source.sha256))throw Error('配套投影结果混入其他原始资产。');
  if(sourceBytesRetired(attachment.source))throw Error('原始来源已关闭，不能重新投影。');
  const source:PostprocessSource={...attachment.source,result,results};
  projectedByteOwners.set(source, projectedByteOwners.get(attachment.source) ?? attachment.source);
  const input=retainedSourceInputs.get(attachment.source);if(input)retainedSourceInputs.set(source,input);
  const text=retainedSourceText.get(attachment.source);if(text)retainedSourceText.set(source,text);
  return{...attachment,source};
}
export async function readPostprocessSourceBytes(attachment: PostprocessAttachment, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
  assertResultNotAborted(signal);
  const input = retainedSourceInputs.get(attachment.source), identity = attachment.source.result.source;
  if (sourceBytesRetired(attachment.source)) throw new Error('原始来源已关闭。');
  if (!input || input.id !== identity.id || input.name !== identity.name || input.size !== identity.size) throw new Error('无法取得已绑定来源的原始字节；未从同名路径替换。');
  const bytes = await input.readRange(start, end, signal);
  assertResultNotAborted(signal);
  if (sourceBytesRetired(attachment.source)) throw new Error('原始来源已关闭。');
  if (bytes.byteLength !== end - start) throw new Error('原始来源字节读取不完整。');
  return bytes;
}

/** Retain the owned OUT reader only. Full text and its content revision are
 * materialized once, on an explicit derived-analysis request. */
export function retainPostprocessOutputSourceText(attachment: PostprocessAttachment, input: ResultInputFile): PostprocessAttachment {
  retainPostprocessSourceBytes(attachment, input);
  const source = attachment.source;
  if (!['gaussian-output', 'orca-output'].includes(source.kind) || source.result.source.id !== input.id
    || source.result.source.name !== input.name || source.result.source.size !== input.size) throw new Error('原始OUT读取器与已导入来源不对应。');
  const existing = retainedSourceText.get(source);
  if (existing) return { ...attachment, readSourceText: existing.read, ...(existing.readCompanionSourceToken ? { readCompanionSourceToken: existing.readCompanionSourceToken } : {}) };
  let pending: Promise<Readonly<PostprocessSourceText>> | undefined;
  const live = () => { if (state.closed) throw new Error('原始OUT来源已关闭。'); };
  const state: RetainedSourceText = { snapshot: null, closed: false,
    async read(signal) {
      assertResultNotAborted(signal); live();
      if (!input.size) throw new Error('派生分析的原始OUT须非空。');
      await input.readRange(0, 0, signal); assertResultNotAborted(signal); live();
      if (!state.snapshot) {
        if (!pending) pending = (async () => {
          const descriptor = await input.readCompanionSourceDescriptor?.(signal); live();
          if (descriptor) {
            if (descriptor.name !== input.name || descriptor.size !== input.size || !/^[a-f0-9]{64}$/.test(descriptor.revision)) throw new Error('受管OUT与已读取来源不对应。');
            state.snapshot = Object.freeze({ name: input.name, sourceToken: descriptor.token, sourceId: input.id, sourceRevision: descriptor.revision });
            return state.snapshot;
          }
          const parts: Uint8Array[] = [];
          for (let start = 0; start < input.size; start += 256 * 1024) {
            const end = Math.min(input.size, start + 256 * 1024), part = await input.readRange(start, end, signal); live();
            if (part.length !== end - start) throw new Error('原始OUT文本读取不完整。');
            parts.push(part);
          }
          const bytes = new Uint8Array(input.size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
          if (bytes.byteLength !== input.size) throw new Error('原始OUT文本读取不完整。');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const encoded = new TextEncoder().encode(text);
          if (!text) throw new Error('原始OUT文本为空。');
          const digest = await crypto.subtle.digest('SHA-256', encoded); live();
          const sourceRevision = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
          state.snapshot = Object.freeze({ name: input.name, text, sourceId: input.id, sourceRevision });
          return state.snapshot;
        })().finally(() => { pending = undefined; });
        await pending;
      }
      assertResultNotAborted(signal); live();
      if (source.result.source.id !== input.id || source.result.source.name !== input.name || source.result.source.size !== input.size || !state.snapshot) throw new Error('原始OUT来源已失效。');
      return state.snapshot;
    },
  };
  if (input.readCompanionSourceToken) state.readCompanionSourceToken = async signal => {
    assertResultNotAborted(signal); live(); await input.readRange(0, 0, signal); live();
    const token = await input.readCompanionSourceToken!(signal); assertResultNotAborted(signal); live(); return token;
  };
  retainedSourceText.set(source, state);
  for (const result of new Set([source.result, ...source.results])) {
    const originalDispose = result.dispose.bind(result); let disposed: Promise<void> | undefined;
    result.dispose = () => { state.closed = true; state.snapshot = null;
      if (!disposed) { try { disposed = Promise.resolve(originalDispose()); } catch (error) { disposed = Promise.reject(error); } }
      return disposed;
    };
  }
  return { ...attachment, readSourceText: state.read, ...(state.readCompanionSourceToken ? { readCompanionSourceToken: state.readCompanionSourceToken } : {}) };
}

/** Bind the exact text sent to the inspected wavefunction backend, not a new
 * source guess or native-session alias. SHA validation occurs once at import. */
export async function retainPostprocessSourceText(attachment: PostprocessAttachment, text: string, input: ResultInputFile, signal?: AbortSignal): Promise<PostprocessAttachment> {
  assertResultNotAborted(signal);
  const source = attachment.source, metadata = source.metadata;
  if (!metadata || !['fchk', 'molden'].includes(source.kind) || metadata.sourceId !== input.id || source.result.source.id !== input.id || metadata.name !== input.name
    || !/^[a-f0-9]{64}$/.test(metadata.sourceRevision)) throw new Error('原始波函数文本与已导入来源元数据不对应。');
  const existing = retainedSourceText.get(source);
  if (existing) {
    if (!existing.snapshot || existing.snapshot.text !== text) throw new Error('已保留波函数来源已关闭或内容改变。');
    return { ...attachment, readSourceText: existing.read };
  }
  const encoded = new TextEncoder().encode(text);
  if (!encoded.byteLength) throw new Error('原始波函数文本须非空。');
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  assertResultNotAborted(signal);
  const revision = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (revision !== metadata.sourceRevision) throw new Error('原始波函数文本SHA与已导入元数据不一致；未开放表面来源。');
  // Keep the import lease for project byte copying. Project persistence compares
  // its bytes against this inspected text; normal analysis need not reread it.
  retainPostprocessSourceBytes(attachment, input);
  await input.readRange(0, 0, signal); assertResultNotAborted(signal);
  const state: RetainedSourceText = {
    snapshot: Object.freeze({ name: input.name, text, sourceId: input.id, sourceRevision: revision }),
    async read(signal) {
      assertResultNotAborted(signal);
      if (!state.snapshot) throw new Error('原始波函数来源已关闭。');
      // The retained input owner checks close/change. A zero-byte liveness
      // probe never recopies or rehashes the 64 MiB immutable source snapshot.
      await input.readRange(0, 0, signal); assertResultNotAborted(signal);
      if (!state.snapshot || source.metadata?.sourceId !== state.snapshot.sourceId || source.metadata.sourceRevision !== state.snapshot.sourceRevision) throw new Error('原始波函数来源已失效。');
      return state.snapshot;
    },
  };
  retainedSourceText.set(source, state);
  for (const result of new Set([source.result, ...source.results])) {
    const originalDispose = result.dispose.bind(result); let disposed: Promise<void> | undefined;
    result.dispose = () => {
      state.snapshot = null;
      if (!disposed) { try { disposed = Promise.resolve(originalDispose()); } catch (error) { disposed = Promise.reject(error); } }
      return disposed;
    };
  }
  return { ...attachment, readSourceText: state.read };
}
export interface PostprocessDocument {
  id: string;
  output?: PostprocessAttachment;
  wavefunction?: PostprocessAttachment;
  companions?: readonly PostprocessAttachment[];
  pair?: PostprocessSourcePair;
  /** Explicit override used by non-owning stage projections; null disables native fields. */
  wavefunctionFrameIndex?: number | null;
  result: TrajectoryResult;
}
export interface PostprocessScientificFileDocument {
  kind: 'scientific-file'; id: string; output: PostprocessScientificFileAttachment;
  wavefunction?: PostprocessAttachment; companions?: readonly PostprocessAttachment[];
  /** Only actual, proven companion/output geometry; input echo stays separate. */
  displayResult?: TrajectoryResult;
  /** Only the selected computed job; native sessions are never part of this proof. */
  pair?: PostprocessSourcePair;
  sourceWarnings?: readonly { sourceId: string; code: string; message: string }[];
  /** Explicitly supplied manifest assets without a parsed geometry/native session. */
  extraSources?: readonly PostprocessFileExtraSource[];
}
export interface PostprocessFileExtraSource {
  name: string; sourceId: string; revision: string; byteSize: number; format: string; role?: string;
  readRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
  dispose(): void | Promise<void>;
}
export type PostprocessFileDocument = PostprocessDocument | PostprocessScientificFileDocument;
export function isScientificFileDocument(document: PostprocessFileDocument): document is PostprocessScientificFileDocument { return 'kind' in document && document.kind === 'scientific-file'; }
export function composePostprocessFileDocument(id: string, output: PostprocessFileAttachment, wavefunction?: PostprocessAttachment, options: { companions?: readonly PostprocessAttachment[]; displayedResult?: TrajectoryResult; pair?: PostprocessSourcePair; sourceWarnings?: readonly { sourceId: string; code: string; message: string }[]; extraSources?: readonly PostprocessFileExtraSource[] } = {}): PostprocessFileDocument {
  if (!isScientificFileSource(output.source)) return composePostprocessDocument(id, output as PostprocessAttachment, wavefunction, undefined, options);
  const job = postprocessFileJob(output.source), displayed = options.displayedResult;
  if (options.pair && (!wavefunction || options.pair.conflicts.length || postprocessMetadataConflict(options.pair) || options.pair.wavefunction !== wavefunction.source || options.pair.primary.result !== job || !postprocessFileJobSource(output.source) || !options.pair.primary.result.frames.some(frame => frame.index === options.pair!.frameIndex))) throw Error('文件配对证明与当前job或波函数来源不一致。');
  if (displayed && (!job || displayed.scientific?.ircEvidence?.outputId !== job.id && displayed !== job || !displayed.frames.length)) throw Error('显示轨迹没有所选job的真实配套证明。');
  return { kind: 'scientific-file', id, output: output as PostprocessScientificFileAttachment, wavefunction, ...(options.pair ? { pair: options.pair } : {}), ...(options.companions ? { companions: options.companions } : {}), ...(displayed ? { displayResult: displayed } : {}), ...(options.sourceWarnings ? { sourceWarnings: options.sourceWarnings } : {}), ...(options.extraSources?.length ? { extraSources: options.extraSources } : {}) };
}
/** A computed-job view borrows its file owner. Companion paths never inherit
 * an OUT frame binding; input echoes and special centers stay separate. */
export function postprocessFileDisplayDocument(document: PostprocessScientificFileDocument): PostprocessDocument | null {
  const displayed = document.displayResult;
  if (!displayed) return null;
  const selected = postprocessFileJob(document.output.source), source = postprocessFileJobSource(document.output.source);
  if (!source || displayed.id !== selected?.id) return { id: document.id, result: displayed, wavefunction: document.wavefunction, wavefunctionFrameIndex: null };
  const pair = document.pair?.primary.result === selected && document.pair.wavefunction === document.wavefunction?.source ? document.pair : undefined;
  return composePostprocessDocument(document.id, { source: pair?.primary ?? source }, document.wavefunction, pair);
}
export async function disposePostprocessFileDocument(document: PostprocessFileDocument, closeNative: (id: string) => Promise<void>): Promise<void> {
  const issues: unknown[] = [];
  if (isScientificFileDocument(document)) {
    if (document.displayResult && !document.companions?.some(item => item.source.result === document.displayResult)) try { await document.displayResult.dispose(); } catch (error) { issues.push(error); }
    issues.push(...await disposePostprocessAttachments([document.wavefunction, ...document.companions ?? []], closeNative));
    for (const extra of document.extraSources ?? []) try { await extra.dispose(); } catch (error) { issues.push(error); }
    try { await document.output.source.dispose(); } catch (error) { issues.push(error); }
  } else issues.push(...await disposePostprocessAttachments([document.output, document.wavefunction, ...document.companions ?? []], closeNative));
  if (issues.length) throw new AggregateError(issues, '科学文件部分资源仍待实际释放。');
}

/** OUT has priority for duplicate printed values. The original sources remain
 * untouched and available for precision checks and explicit source details. */
export function composePostprocessDocument(id: string, output?: PostprocessAttachment, wavefunction?: PostprocessAttachment, pair?: PostprocessSourcePair, options: { companions?: readonly PostprocessAttachment[]; displayedResult?: TrajectoryResult } = {}): PostprocessDocument {
  const primary = output?.source.result ?? wavefunction?.source.result;
  if (!primary) throw new Error('后处理文档至少需要一个已读取来源。');
  if (pair && (!output || !wavefunction || pair.primary !== output.source || pair.wavefunction !== wavefunction.source || !primary.frames.some(frame => frame.index === pair?.frameIndex))) throw new Error('配对证明与当前来源或结构帧不一致。');
  // Retain both independent slots when an old or newly rebuilt proof carries an
  // explicit metadata conflict; it cannot supplement fields or grant a frame.
  if (pair && postprocessMetadataConflict(pair)) pair = undefined;
  const waveFrame = pair?.frameIndex ?? null;
  const savedScience = output && wavefunction && waveFrame !== null && !pair?.conflicts.length ? wavefunction.source.result.scientific : undefined;
  const remap = <T extends { frameIndex?: number | null }>(rows: readonly T[]): T[] => rows.map(row => ({ ...row, frameIndex: waveFrame! }));
  const secondary = output && wavefunction ? wavefunction.source.result : null;
  const supplementary = savedScience ? { ...savedScience, summary: remap(savedScience.summary), properties: remap(savedScience.properties), thermochemistry: remap(savedScience.thermochemistry),
    // A geometry/wavefunction pair alone does not establish an NMR response-property pairing.
    nmrCouplings: undefined,
    mdSteps: undefined, mdSourceDifferences: undefined,
    orbitals: remap(savedScience.orbitals), atomicProperties: remap(savedScience.atomicProperties), scfCycles: remap(savedScience.scfCycles), excitedStates: remap(savedScience.excitedStates), stability: remap(savedScience.stability), bsse: remap(savedScience.bsse),
    vibrations: savedScience.vibrations ? { ...savedScience.vibrations, frameIndex: waveFrame! } : undefined, vibrationSets: savedScience.vibrationSets ? remap(savedScience.vibrationSets) : undefined } : undefined;
  let scientific = primary.scientific;
  if (!scientific && supplementary) scientific = supplementary;
  else if (scientific && supplementary && secondary) {
    const a = scientific, b = supplementary;
    const fill = <T extends { key: string; unit?: string; frameIndex?: number | null }>(first: readonly T[], second: readonly T[]): T[] => {
      const keys = new Set(first.map(row => `${row.frameIndex}\0${row.key}\0${row.unit ?? ''}`));
      return [...first, ...second.filter(row => !keys.has(`${row.frameIndex}\0${row.key}\0${row.unit ?? ''}`))];
    };
    const atomicKeys = new Set(a.atomicProperties.map(row => `${row.kind}\0${row.scheme}\0${row.frameIndex}`));
    const channels: OrbitalChannel[] = a.orbitals.filter(row => row.frameIndex !== waveFrame);
    for (const spin of ['restricted', 'alpha', 'beta'] as const) {
      const printedChannels = a.orbitals.filter(row => row.spin === spin && row.frameIndex === waveFrame);
      const printed = printedChannels.at(-1);
      const saved = b.orbitals.find(row => row.spin === spin && row.frameIndex === waveFrame);
      if (!saved) { channels.push(...printedChannels); continue; }
      channels.push(...printedChannels.slice(0, -1));
      // Molden MO block ordinals are one-based. ORCA's OUT orbital table is
      // zero-based; the paired result explicitly records this display mapping.
      const offset = primary.engine === 'orca' && wavefunction?.source.kind === 'molden' ? -1 : 0;
      const savedRows = saved.orbitals.map(row => ({ ...row, index: row.index + offset, sourceIndex:row.sourceIndex??row.index,
        sourceId:row.sourceId??saved.sourceId??secondary.source.id,sourceName:row.sourceName??saved.sourceName??secondary.source.name,sourceLine:row.sourceLine??saved.sourceLine }));
      const printedByIndex = new Map(printed?.orbitals.map(row => [row.index, {...row,sourceIndex:row.sourceIndex??row.index,
        sourceId:row.sourceId??printed.sourceId??primary.source.id,sourceName:row.sourceName??printed.sourceName??primary.source.name,sourceLine:row.sourceLine??printed.sourceLine}]) ?? []);
      const rows = savedRows.map(row => printedByIndex.get(row.index) ?? row);
      const seen = new Set(rows.map(row => row.index));
      for (const row of printedByIndex.values()) if (!seen.has(row.index)) rows.push(row);
      rows.sort((x, y) => x.index - y.index);
      channels.push({ ...saved, sourceName: printed ? `${printed.sourceName ?? primary.source.name}（重合项优先） / ${saved.sourceName ?? secondary.source.name}（补充）` : saved.sourceName,
        orbitals: rows });
    }
    scientific = { ...a, summary: fill(a.summary, b.summary), properties: fill(a.properties, b.properties), thermochemistry: fill(a.thermochemistry, b.thermochemistry),
      orbitals: channels, atomicProperties: [...a.atomicProperties, ...b.atomicProperties.filter(row => !atomicKeys.has(`${row.kind}\0${row.scheme}\0${row.frameIndex}`))],
      scfCycles: [...a.scfCycles, ...b.scfCycles], excitedStates: [...a.excitedStates, ...b.excitedStates], stability: fill(a.stability, b.stability), bsse: fill(a.bsse, b.bsse),
      vibrations: a.vibrations ?? b.vibrations, vibrationSets: [...(a.vibrationSets ?? (a.vibrations ? [a.vibrations] : [])), ...(b.vibrationSets ?? (b.vibrations ? [b.vibrations] : []))],
      notices: [...a.notices, `配对波函数：${secondary.source.name}；重复定义以OUT打印值优先，补充字段保留各自来源。`,
        ...(primary.engine === 'orca' && wavefunction?.source.kind === 'molden' ? ['配对轨道编号：ORCA OUT 从0计数；Molden保存块从1计数，显示编号=保存块序号−1。'] : []), ...(pair?.notices ?? [])] };
  }
  const displayed = options.displayedResult ?? primary;
  if (displayed !== primary) scientific = displayed.scientific;
  const result: TrajectoryResult = { ...displayed, id, scientific: publishScientificData(scientific), frames: publishFrameSummaries(displayed.frames),
    messages: [...displayed.messages, ...(pair?.notices ?? [])],
    // The attachment owner, not a view/registry alias, disposes the source readers.
    dispose: () => undefined };
  registerPreparedTrajectoryProjection(displayed, result, displayed.frames.map((_, index) => index));
  return { id, output, wavefunction, pair, result, ...(options.companions?.length ? { companions: options.companions } : {}), ...(displayed !== primary ? { wavefunctionFrameIndex: null } : {}) };
}

/** A stage changes observation indices, never the attachment or native-session owner. */
export function observePostprocessSource(document: PostprocessDocument, result: TrajectoryResult): PostprocessDocument {
  if (result.source.id === document.result.source.id && result.jobIndex === document.result.jobIndex
    && result.scientific === document.result.scientific && result.frames === document.result.frames) return document;
  const nativeRoot = document.output?.source.result;
  const matchesNative = nativeRoot && result.source.id === nativeRoot.source.id && result.jobIndex === nativeRoot.jobIndex;
  return { ...document, result: publishProjectionResult(result), wavefunctionFrameIndex: matchesNative ? document.pair?.frameIndex ?? null : continuedWavefunctionFrame(document,result) };
}

/** Only the already-proven native Opt→Freq boundary may carry the paired
 * saved geometry to another job. It never carries TD states or properties. */
function continuedWavefunctionFrame(document:PostprocessDocument,result:TrajectoryResult):number|null{
 const output=document.output?.source,pair=document.pair,wave=document.wavefunction?.source;
 if(!output||output.kind!=='gaussian-output'||!pair||pair.primary!==output||pair.wavefunction!==wave||pair.conflicts.length||result.source.id!==output.result.source.id)return null;
 for(const proof of output.nativeContinuations??[]){
  const optimization=output.results.find(row=>row.id===proof.optimizationResultId),frequency=output.results.find(row=>row.id===proof.frequencyResultId);
  if(!optimization||!frequency||optimization.id!==output.result.id||pair.frameIndex!==optimization.frames.at(-1)?.index||frequency.frames.length!==1||result.jobIndex!==frequency.jobIndex)continue;
  const index=result.frames.findIndex(row=>(row.sourceFrameIndex??row.index)===frequency.frames[0].index);
  return index<0?null:index;
 }
 return null;
}

/** Pair ownership and projected frame identity are separate and both verified. */
export function postprocessExcitationWavefunctionBinding(document:PostprocessDocument):{frameIndex:number;sourceFrameIndex:number;pairFrameIndex:number}|null{
 const pair=document.pair,output=document.output?.source,frameIndex=postprocessWavefunctionFrame(document);
 if(!pair||!output||pair.primary!==output||pair.wavefunction!==document.wavefunction?.source||pair.conflicts.length||frameIndex===null||!document.result.frames[frameIndex])return null;
 const sourceFrameIndex=document.result.frames[frameIndex].sourceFrameIndex??frameIndex;
 if(document.result.source.id!==output.result.source.id)return null;
 const original=document.result.jobIndex===output.result.jobIndex&&sourceFrameIndex===pair.frameIndex;
 if(!original&&continuedWavefunctionFrame(document,document.result)!==frameIndex)return null;
 return{frameIndex,sourceFrameIndex,pairFrameIndex:pair.frameIndex};
}

/** A stage changes observation indices, never the attachment or native-session owner. */
export function projectPostprocessStage(document: PostprocessDocument, result: TrajectoryResult): PostprocessDocument {
  const originalWave = postprocessWavefunctionFrame(document);
  const originalSourceIndex = originalWave === null ? null : document.result.frames[originalWave]?.sourceFrameIndex ?? originalWave;
  const wavefunctionFrameIndex = originalSourceIndex === null ? null : result.frames.findIndex(frame => (frame.sourceFrameIndex ?? frame.index) === originalSourceIndex);
  return { ...document, result: publishProjectionResult(result), wavefunctionFrameIndex: wavefunctionFrameIndex === -1 ? null : wavefunctionFrameIndex };
}

export function postprocessDifferences(document: PostprocessDocument): { label: string; message: string }[] {
  return document.pair?.conflicts.map(row => ({ label: row.definition,
    message: `OUT ${row.output.value} ${row.unit}（行${row.output.sourceLine}）；波函数 ${row.wavefunction.value} ${row.unit}（行${row.wavefunction.sourceLine}）。差异超过各自打印精度；主显示仍用OUT。` })) ?? [];
}

export function postprocessDipole(data: ScientificData | undefined, frameIndex = 0): { vector: [number, number, number]; unit: string; sourceId?:string } | null {
  const fields = [...(data?.summary ?? []), ...(data?.properties ?? [])].filter(row => row.frameIndex === frameIndex);
  for (const keys of [['dipole-total-x', 'dipole-total-y', 'dipole-total-z'], ['dipole-x', 'dipole-y', 'dipole-z'], ['dipole-X', 'dipole-Y', 'dipole-Z'], ['dipole-x-au', 'dipole-y-au', 'dipole-z-au'],['Dipole Moment:X','Dipole Moment:Y','Dipole Moment:Z']]) {
   for(const first of fields.filter(row=>row.key===keys[0])){
    const rows = keys.map(key => fields.find(row => row.key === key && row.sourceId===first.sourceId&&row.sourceName===first.sourceName&&row.unit===first.unit));
    if (rows.every(row => row && typeof row.value === 'number' && Number.isFinite(row.value)) && rows.every(row => row!.unit === rows[0]!.unit)) {
      const nativeTotal = keys[0] === 'dipole-total-x', unit = rows[0]!.unit;
      if (nativeTotal && !['a.u.', 'e·bohr', 'Debye'].includes(unit ?? '')) continue;
      const factor = nativeTotal && (unit === 'a.u.' || unit === 'e·bohr') ? 2.541746473 : 1;
      return { vector: rows.map(row => (row!.value as number) * factor) as [number, number, number], unit: factor === 1 ? unit ?? '来源单位未标明' : 'Debye',sourceId:first.sourceId };
    }
   }
  }
  return null;
}

/** Saved wavefunctions have one geometry. A paired output grants it only to the
 * verified frame; browsing another frame never creates a new native owner. */
export function postprocessWavefunctionFrame(document: PostprocessDocument): number | null {
  if (document.wavefunctionFrameIndex !== undefined) return document.wavefunctionFrameIndex;
  if (!document.wavefunction) return null;
  return document.output ? document.pair?.frameIndex ?? null : 0;
}

const globalMetadata = /^(?:method|basis|basis-shells|basis-settings|charge|multiplicity|reference-state|solvent(?:-.+)?|dispersion|ecp|ri|relativistic|output-verbosity|integration-.+|optimization-settings|scf-settings|source-normal-termination|Number of .+|Pure\/Cartesian .+|Highest angular momentum|Gaussian Version)$/;

// Parsers/enrichment own mutable data until publication. Only independent display
// snapshots have the immutable membership contract needed for a persistent index.
// Never freeze a source row or deep-copy its orbital/atomic/vibration payload.
const publishedScience = new WeakSet<ScientificData>();
const publishedFrames = new WeakSet<readonly ResultFrameSummary[]>();
const publishedRowArrays = new WeakSet<readonly unknown[]>();
const publishedRows = new WeakSet<object>();
function readonlyRows<T>(rows: readonly T[], copies = new WeakMap<object, object>()): T[] {
  if (publishedRowArrays.has(rows)) return rows as T[];
  const snapshot = Object.freeze(rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    if (publishedRows.has(row)) return row;
    let copy = copies.get(row);
    if (!copy) { copy = Object.freeze({ ...row }); copies.set(row, copy); publishedRows.add(copy); }
    return copy as T;
  })) as T[];
  publishedRowArrays.add(snapshot); return snapshot;
}
function publishScientificData(data: ScientificData | undefined): ScientificData | undefined {
  if (!data || publishedScience.has(data)) return data;
  const snapshot = { ...data }, copies = new WeakMap<object, object>();
  for (const key of Object.keys(snapshot) as (keyof ScientificData)[]) {
    const rows = snapshot[key];
    if (key === 'nmrCouplings' && data.nmrCouplings) { snapshot.nmrCouplings = publishNmrCouplings(data.nmrCouplings); continue; }
    if (key === 'mdSteps' && data.mdSteps) {
      snapshot.mdSteps = Object.freeze(data.mdSteps.map(row => Object.freeze(Object.assign({ ...row }, ...mdQuantityKeys.map(key => row[key] ? { [key]: Object.freeze({ ...row[key], ...(row[key]!.unitEvidence ? { unitEvidence: Object.freeze({ ...row[key]!.unitEvidence }) } : {}) }) } : {}))))) as unknown as ScientificData['mdSteps']; continue;
    }
    if (Array.isArray(rows)) (snapshot as unknown as Record<string, unknown>)[key] = readonlyRows<unknown>(rows, copies);
  }
  if (data.vibrations) {
    let vibrations = publishedRows.has(data.vibrations) ? data.vibrations : copies.get(data.vibrations);
    if (!vibrations) { vibrations = Object.freeze({ ...data.vibrations }); publishedRows.add(vibrations); }
    snapshot.vibrations = vibrations as ScientificData['vibrations'];
  }
  Object.freeze(snapshot); publishedScience.add(snapshot); return snapshot;
}
function publishFrameSummaries(frames: readonly ResultFrameSummary[]): readonly ResultFrameSummary[] {
  if (publishedFrames.has(frames)) return frames;
  const snapshot = readonlyRows(frames); publishedFrames.add(snapshot); return snapshot;
}
function publishProjectionResult(result: TrajectoryResult): TrajectoryResult {
  const scientific = publishScientificData(result.scientific), frames = publishFrameSummaries(result.frames);
  if (scientific === result.scientific && frames === result.frames) return result;
  const projection = { ...result, scientific, frames };
  registerPreparedTrajectoryProjection(result, projection, result.frames.map((_, index) => index));
  return projection;
}

const frameMembership = new WeakMap<readonly ResultFrameSummary[], Set<number>>();
function includesProjectionFrame(frames: readonly ResultFrameSummary[], index: number): boolean {
  if (!publishedFrames.has(frames)) return frames.some(frame => frame.index === index);
  let indices = frameMembership.get(frames);
  if (!indices) { indices = new Set(frames.map(frame => frame.index)); frameMembership.set(frames, indices); }
  return indices.has(index);
}

interface IndexedRows<T> {
  rows: readonly T[];
  byFrame: Map<number, number[]>;
  unscoped: number[];
  global: number[];
}
function indexRows<T extends { frameIndex?: number | null }>(rows: readonly T[], global?: (row: T) => boolean): IndexedRows<T> {
  const indexed: IndexedRows<T> = { rows, byFrame: new Map(), unscoped: [], global: [] };
  rows.forEach((row, ordinal) => {
    if (row.frameIndex == null) {
      indexed.unscoped.push(ordinal); if (global?.(row)) indexed.global.push(ordinal);
    } else {
      let bucket = indexed.byFrame.get(row.frameIndex);
      if (!bucket) { bucket = []; indexed.byFrame.set(row.frameIndex, bucket); }
      bucket.push(ordinal);
    }
  });
  return indexed;
}
function selectRows<T>(indexed: IndexedRows<T>, frameIndex: number, single: boolean, fields = false): T[] {
  const own = indexed.byFrame.get(frameIndex) ?? [], extra = single ? indexed.unscoped : fields ? indexed.global : [];
  const selected: T[] = []; let a = 0, b = 0;
  // Merge source ordinals, not values: global rows retain their exact original
  // position even when interleaved with frame rows. No global copies per frame
  // are retained until a frame is actually requested.
  while (a < own.length || b < extra.length) {
    const ordinal = b >= extra.length || a < own.length && own[a] < extra[b] ? own[a++] : extra[b++];
    selected.push(indexed.rows[ordinal]);
  }
  return Object.freeze(selected) as T[];
}
function createScientificFrameIndex(data: ScientificData) {
  const fields = (row: ScientificData['summary'][number]) => globalMetadata.test(row.key);
  const indices = { summary: indexRows(data.summary, fields), properties: indexRows(data.properties, fields),
    thermochemistry: indexRows(data.thermochemistry), orbitals: indexRows(data.orbitals), atomicProperties: indexRows(data.atomicProperties),
    scfCycles: indexRows(data.scfCycles), excitedStates: indexRows(data.excitedStates), stability: indexRows(data.stability), bsse: indexRows(data.bsse),
    vibrationSets: data.vibrationSets ? indexRows(data.vibrationSets) : undefined };
  const couplings = data.nmrCouplings ? indexRows(data.nmrCouplings) : undefined;
  const mdSteps = data.mdSteps ? indexRows(data.mdSteps) : undefined, mdDifferences = data.mdSourceDifferences ? indexRows(data.mdSourceDifferences) : undefined;
  const recent = new Map<string, ScientificData>();
  return (frameIndex: number, single: boolean): ScientificData => {
    const key = `${single ? 1 : 0}:${frameIndex}`, found = recent.get(key);
    if (found) { recent.delete(key); recent.set(key, found); return found; }
    const scientific: ScientificData = { ...data,
      summary: selectRows(indices.summary, frameIndex, single, true), properties: selectRows(indices.properties, frameIndex, single, true),
      thermochemistry: selectRows(indices.thermochemistry, frameIndex, single), orbitals: selectRows(indices.orbitals, frameIndex, single),
      atomicProperties: selectRows(indices.atomicProperties, frameIndex, single), scfCycles: selectRows(indices.scfCycles, frameIndex, single),
      ...(couplings ? { nmrCouplings: selectRows(couplings, frameIndex, single) } : {}),
      ...(mdSteps ? { mdSteps: selectRows(mdSteps, frameIndex, single) } : {}), ...(mdDifferences ? { mdSourceDifferences: selectRows(mdDifferences, frameIndex, single) } : {}),
      excitedStates: selectRows(indices.excitedStates, frameIndex, single), stability: selectRows(indices.stability, frameIndex, single), bsse: selectRows(indices.bsse, frameIndex, single),
      vibrations: data.vibrations && (data.vibrations.frameIndex === frameIndex || single && data.vibrations.frameIndex == null) ? data.vibrations : undefined,
      vibrationSets: indices.vibrationSets ? selectRows(indices.vibrationSets, frameIndex, single) : undefined };
    Object.freeze(scientific); recent.set(key, scientific);
    if (recent.size > 8) recent.delete(recent.keys().next().value!);
    return scientific;
  };
}
const scientificFrameIndices = new WeakMap<ScientificData, ReturnType<typeof createScientificFrameIndex>>();

/** Read-only current-frame projection. Frame indices, document id and source
 * reader/native lifetimes remain original. Geometry may be supplied after an
 * independently guarded getFrame call; this function performs no I/O or science. */
export function projectPostprocessFrame(document: PostprocessDocument, frameIndex: number, structure?: Structure): { result: TrajectoryResult; scientific: ScientificData | undefined; frameIndex: number; wavefunctionAvailable: boolean; nativeSessionId?: string } {
  if (!Number.isSafeInteger(frameIndex) || !includesProjectionFrame(document.result.frames, frameIndex)) throw new Error('后处理帧序号越界。');
  const data = document.result.scientific, single = document.result.frames.length === 1;
  const scoped = <T extends { frameIndex?: number | null }>(rows: readonly T[]) => rows.filter(row => row.frameIndex === frameIndex || single && row.frameIndex == null);
  const fields = <T extends { frameIndex?: number | null; key: string }>(rows: readonly T[]) => rows.filter(row => row.frameIndex === frameIndex || row.frameIndex == null && (single || globalMetadata.test(row.key)));
  let scientific: ScientificData | undefined;
  if (data && publishedScience.has(data)) {
    let indexed = scientificFrameIndices.get(data);
    if (!indexed) { indexed = createScientificFrameIndex(data); scientificFrameIndices.set(data, indexed); }
    scientific = indexed(frameIndex, single);
  } else scientific = data ? { ...data, summary: fields(data.summary), properties: fields(data.properties), thermochemistry: scoped(data.thermochemistry),
    orbitals: scoped(data.orbitals), atomicProperties: scoped(data.atomicProperties), scfCycles: scoped(data.scfCycles), excitedStates: scoped(data.excitedStates), stability: scoped(data.stability), bsse: scoped(data.bsse),
    ...(data.nmrCouplings ? { nmrCouplings: scoped(data.nmrCouplings) } : {}),
    ...(data.mdSteps ? { mdSteps: scoped(data.mdSteps) } : {}), ...(data.mdSourceDifferences ? { mdSourceDifferences: scoped(data.mdSourceDifferences) } : {}),
    vibrations: data.vibrations && scoped([data.vibrations]).length ? data.vibrations : undefined, vibrationSets: data.vibrationSets ? scoped(data.vibrationSets) : undefined } : undefined;
  const wavefunctionAvailable = postprocessWavefunctionFrame(document) === frameIndex;
  return { frameIndex, scientific, wavefunctionAvailable, ...(wavefunctionAvailable && document.wavefunction?.nativeSessionId ? { nativeSessionId: document.wavefunction.nativeSessionId } : {}),
    result: { ...document.result, scientific, ...(structure ? { initialStructure: structure } : {}) } };
}

/** Result views never own source files or native cache lifetime. */
export async function commitPostprocessReplacement(commit:()=>void, attachments:readonly (PostprocessAttachment|undefined)[], closeNative:(id:string)=>Promise<unknown>):Promise<string[]>{
  commit();
  return disposePostprocessAttachments(attachments,closeNative);
}

export async function disposePostprocessAttachments(attachments: readonly (PostprocessAttachment | undefined)[], closeNative: (id: string) => Promise<unknown>, releaseResult:(result:TrajectoryResult)=>void|Promise<void>=result=>result.dispose()): Promise<string[]> {
  const seen = new Set<PostprocessSource>();
  const issues:string[]=[];
  for (const attachment of attachments) {
    if (!attachment || seen.has(attachment.source)) continue;
    seen.add(attachment.source);
    const retained = retainedSourceText.get(attachment.source); if (retained) { retained.closed = true; retained.snapshot = null; }
    // A failed native close response cannot prevent independent source readers
    // from closing or make the tab permanently uncloseable on a second attempt.
    const operations=[...(attachment.nativeSessionId?[Promise.resolve().then(()=>closeNative(attachment.nativeSessionId!))]:[]),...attachment.source.results.map(result=>Promise.resolve().then(()=>releaseResult(result)))];
    for(const outcome of await Promise.allSettled(operations))if(outcome.status==='rejected')issues.push(outcome.reason instanceof Error?outcome.reason.message:String(outcome.reason));
  }
  return issues;
}

interface PostprocessReleaseResources {
  attachments?: readonly (PostprocessAttachment | undefined)[];
  fileSources?: readonly PostprocessScientificFileSource[];
  extras?: readonly PostprocessFileExtraSource[];
  results?: readonly TrajectoryResult[];
}
/** Removed/replaced resources retain a precise owner until their own close
 * succeeds. Independent successes are never replayed because another close
 * failed, and concurrent close/retry requests share the same operation. */
export function createPostprocessReleaseQueue(closeNative: (id: string) => Promise<unknown>) {
  const states = new WeakMap<object, { done: boolean; pending?: Promise<void> }>();
  const native = new Map<string, { done: boolean; pending?: Promise<void> }>();
  const pending = new Map<number, { id: string; sourceNames: string[]; issues: string[]; release(): Promise<string[]> }>();
  let serial = 0;
  const once = (state: { done: boolean; pending?: Promise<void> }, close: () => unknown): Promise<void> => {
    if (state.done) return Promise.resolve();
    if (state.pending) return state.pending;
    state.pending = Promise.resolve().then(close).then(() => { state.done = true; }).finally(() => { state.pending = undefined; });
    return state.pending;
  };
  const objectClose = (owner: object, close: () => unknown) => {
    let state = states.get(owner); if (!state) { state = { done: false }; states.set(owner, state); }
    return once(state, close);
  };
  const nativeClose = (id: string) => {
    let state = native.get(id); if (!state) { state = { done: false }; native.set(id, state); }
    return once(state, () => closeNative(id));
  };
  function releaseResources(id: string, resources: PostprocessReleaseResources): Promise<string[]> {
    const attachments = [...resources.attachments ?? []], sources = [...resources.fileSources ?? []], extras = [...resources.extras ?? []], results = [...resources.results ?? []];
    if (!attachments.some(Boolean) && !sources.length && !extras.length && !results.length) return Promise.resolve([]);
    const key = ++serial;
    let inflight: Promise<string[]> | undefined;
    const entry = { id, sourceNames: [...new Set([...attachments.flatMap(item => item ? [item.source.result.source.name] : []), ...sources.map(source => source.identity.name), ...extras.map(extra => extra.name), ...results.map(result => result.source.name)])], issues: [] as string[], release(): Promise<string[]> {
      if (!pending.has(key)) return Promise.resolve([]); if (inflight) return inflight;
      inflight = (async () => {
        const issues = await disposePostprocessAttachments(attachments, nativeClose, result => objectClose(result, () => result.dispose()));
        const outcomes = await Promise.allSettled([
          ...sources.map(source => objectClose(source, () => source.dispose())),
          ...extras.map(extra => objectClose(extra, () => extra.dispose())),
          ...results.map(result => objectClose(result, () => result.dispose())),
        ]);
        for (const outcome of outcomes) if (outcome.status === 'rejected') issues.push(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason));
        entry.issues = issues;
        if (!issues.length) { pending.delete(key); if (!pending.size) native.clear(); }
        return issues;
      })().finally(() => { inflight = undefined; });
      return inflight;
    } };
    pending.set(key, entry);
    return entry.release();
  }
  return {
    releaseResources,
    releaseFile(id: string, value: PostprocessScientificFileDocument) {
      return releaseResources(id, { attachments: [value.wavefunction, ...value.companions ?? []], fileSources: [value.output.source], extras: value.extraSources,
        results: value.displayResult && !value.output.source.jobs.includes(value.displayResult) && !value.companions?.some(item => item.source.result === value.displayResult) ? [value.displayResult] : [] });
    },
    pending: () => [...pending].map(([retirementId, entry]) => ({ retirementId, id: entry.id, sourceNames: [...entry.sourceNames], issues: [...entry.issues] })),
    async retry(id?: string) {
      const issues = (await Promise.all([...pending.values()].filter(entry => id === undefined || entry.id === id).map(entry => entry.release()))).flat();
      if (issues.length) throw Object.assign(new Error('仍有来源资源待实际关闭：' + issues.join('；')), { issues });
    },
  };
}
