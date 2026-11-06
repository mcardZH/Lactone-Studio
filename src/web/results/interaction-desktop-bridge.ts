import type { Structure } from '../../core/types';
import { registerAnalysisRuntimeOwner } from '../../modeling/application/analysis-runtime-owners';
import type { DesktopBridge } from '../../modeling/contracts';
import type { InteractionGeneratedFields, InteractionMethod, InteractionSource } from '../../results/interaction-contracts';
import type { SurfaceContext, SurfaceCubeSourceRef, SurfaceScalarField, SurfaceStamp } from '../../results/surface-contracts';
import { molecularCubeField, parseMolecularCube } from '../../results/cube-reader';
import { sameSurfaceContext, sameSurfaceStamp, validateSurfaceScalarField } from '../../results/surface-field';
import { postprocessWavefunctionFrame, type PostprocessDocument } from '../../results/postprocess-document';
import { validateInteractionGeneratedFields, validateInteractionContributions } from '../../results/interaction-field';
import { assertSurfaceCubeSourceGeometry } from './surface-desktop-bridge';
import type { InteractionControlsBridge } from './interaction-controls-contracts';
import { assertStructureInteractionContext, assertStructureInteractionSource, interactionUsesStructure } from '../../results/interaction-structure-context';
import { analysisOriginalCubeKey, loadAnalysisProjectSnapshot, markRestoredAnalysisData, notifyAnalysisProjectStateChanged, rebindAnalysisContext, retainAnalysisProjectSnapshot, type AnalysisOriginalCube } from '../../projects/analysis-state';

export type InteractionDesktopApi = Pick<DesktopBridge, 'openInteractionSession' | 'generateInteraction' | 'interactionContributions' | 'restoreInteractionFields' | 'exportInteractionCube' | 'cancelInteraction' | 'closeInteractionSession'
  | 'importSurfaceCube' | 'registerSurfaceCube' | 'readRegisteredSurfaceCube' | 'releaseSurfaceCube' | 'exportRegisteredSurfaceCube' | 'onMultiwfnProgress' | 'orbitalResourceInfo'>;
export interface InteractionDesktopBridgeOptions {
  desktop: InteractionDesktopApi; analysisId: string; context: SurfaceContext; document: PostprocessDocument | null;
  structure: Structure; coordinateRoundingAngstrom: number | null; active: boolean; onCleanupError?(message: string): void;
}
type Session = { id: string; kind: InteractionSource['kind']; methods: readonly InteractionMethod[] };
type Operation = { requestId: string; epoch: number; abort: AbortController; sessionId?: string; cancelling?: Promise<unknown>; readOnly: boolean };
type Artifact = { session: Session; method: InteractionMethod; fragments: InteractionGeneratedFields['fragments']; quality: InteractionGeneratedFields['quality']; signatures: readonly string[] };
type Imported = { token: string; metadata: SurfaceCubeSourceRef['fieldMetadata']; signature: string; projectDomain?: {sourceRevision:string;validDomain:SurfaceScalarField['validDomain']} };
const MAX_SOURCE = Number.MAX_SAFE_INTEGER;
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
const aborted = () => new DOMException('相互作用请求已取消或来源已改变。', 'AbortError');
const fieldFunctions = { iri: 'iri', rdg: 'rdg', inter: 'delta-g-inter', intra: 'delta-g-intra', total: 'delta-g', mapping: 'sign-lambda2-rho' } as const;
function signature(field: SurfaceScalarField): string {
  const domain = field.validDomain;
  return JSON.stringify([field.id, field.source, field.function, field.valueUnit, field.grid, field.context, domain.kind, domain.kind === 'node-mask' ? [domain.evidence, domain.restrictedTo, domain.mask.length] : domain], (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value);
}
function metadata(field: SurfaceScalarField): SurfaceCubeSourceRef['fieldMetadata'] { const { values: _values, ...rest } = field; return structuredClone({ ...rest, validDomain: field.validDomain.kind === 'node-mask' ? { kind: 'unknown', reason: '受限域由内容绑定的宿主快照只读恢复。' } : field.validDomain }); }

/** One analysis/source lifetime. Native sessions/artifacts survive inactive
 * display; restore and external Cube paths never manufacture science calls. */
export function createInteractionDesktopBridge(options: InteractionDesktopBridgeOptions) {
  const desktop = options.desktop, context = { ...options.context }, structure = structuredClone(options.structure);
  assert(options.analysisId && context.sourceId && context.sourceRevision, '相互作用缺少分析/来源身份。');
  if (!options.document) assertStructureInteractionContext(context, structure);
  const sessions = new Map<InteractionSource['kind'], Session>(), artifacts = new Map<string, Artifact>(), generated = new Map<string, { session: Session; signature: string }>();
  const imported = new Map<string, Imported>(), tokens = new Set<string>(), tasks = new Set<Promise<unknown>>(),orphanSessions=new Set<string>();
  const progressSubscriptions=new Set<()=>void>();
  let active = options.active, disposed = false, epoch = 0, operation: Operation | null = null;
  const report = (reason: unknown) => { if(disposed)return;try { options.onCleanupError?.(reason instanceof Error ? reason.message : String(reason)); } catch { /* Independent cleanup continues. */ } };
  const checkedContext = (value: SurfaceContext) => assert(sameSurfaceContext(value, context), '相互作用请求不属于当前来源/作业/原帧/代际。');
  const stamp = (requestId: string): SurfaceStamp => ({ ...context, analysisId: options.analysisId, requestId });
  const current = (op: Operation) => { if (disposed || !active && !op.readOnly || op.epoch !== epoch || op.abort.signal.aborted || operation !== op) throw aborted(); };
  async function cancelOperation(op: Operation) { op.abort.abort(); if (op.sessionId && !op.cancelling) { assert(desktop.cancelInteraction, '当前环境缺少相互作用停止入口。'); op.cancelling = desktop.cancelInteraction(op.sessionId); } await op.cancelling; }
  function run<T>(id: string, signal: AbortSignal, execute: (op: Operation) => Promise<T>, readOnly = false): Promise<T> {
    if (disposed || !active && !readOnly || signal.aborted) return Promise.reject(aborted());
    if (operation) return Promise.reject(new Error('此相互作用实例已有操作，请先完成或停止。'));
    assert(id, '相互作用操作缺少请求身份。'); const op: Operation = { requestId: id, epoch, abort: new AbortController(), readOnly }; operation = op;
    const abort = () => { void cancelOperation(op).catch(report); }; signal.addEventListener('abort', abort, { once: true });
    const task = Promise.resolve().then(async () => { current(op); const value = await execute(op); current(op); if(!op.readOnly)notifyAnalysisProjectStateChanged(); return value; }).finally(() => { signal.removeEventListener('abort', abort); if (operation === op) operation = null; tasks.delete(task); }); tasks.add(task); return task;
  }
  async function releaseToken(token: string) { assert(desktop.releaseSurfaceCube, '当前环境缺少Cube来源释放入口。'); const result = await desktop.releaseSurfaceCube(token); assert(result.released, 'Cube来源尚未释放。'); tokens.delete(token); }
  async function restoreImported(fieldId: string): Promise<Imported | undefined> {
    const existing=imported.get(fieldId);if(existing)return existing;
    const original=await loadAnalysisProjectSnapshot<AnalysisOriginalCube>(analysisOriginalCubeKey(options.analysisId,context,fieldId));
    if(!original)return undefined;
    assert(!disposed&&desktop.registerSurfaceCube,'当前环境缺少项目Cube原始素材注册入口。');
    const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(original.originalBytes),value=await desktop.registerSurfaceCube({name:original.name,text:raw});
    if(disposed){await desktop.releaseSurfaceCube?.(value.token);throw aborted();}
    if(value.sourceRevision!==original.sourceRevision){await desktop.releaseSurfaceCube?.(value.token);throw new Error('项目Cube原始素材内容身份不一致。');}
    const fieldMetadata=rebindAnalysisContext(original.fieldMetadata,context),field=molecularCubeField(parseMolecularCube(raw),fieldMetadata,{sourceRevision:original.sourceRevision,validDomain:fieldMetadata.validDomain});
    const entry={token:value.token,metadata:metadata(field),signature:signature(field),projectDomain:{sourceRevision:original.sourceRevision,validDomain:fieldMetadata.validDomain}};imported.set(fieldId,entry);tokens.add(value.token);return entry;
  }
  async function ensureSession(method: InteractionMethod, op: Operation): Promise<Session> {
    assert(desktop.openInteractionSession && desktop.closeInteractionSession, '当前环境没有相互作用会话入口。');
    if (options.document) assert(options.document.result.source.id === context.sourceId && options.document.result.jobIndex === context.jobIndex, '相互作用来源文档已改变。');
    let source: InteractionSource;
    if (interactionUsesStructure(method)) { assertStructureInteractionSource(structure); source = { kind: 'structure', structure, context }; }
    else {
      assert(options.document, '当前模型没有原始波函数；请选择结构 IGM/mIGM。');
      const attachment = options.document.wavefunction, frame = postprocessWavefunctionFrame(options.document), original = frame === null ? null : options.document.result.frames.find(value => value.index === frame)?.sourceFrameIndex ?? frame;
      assert(attachment?.source.metadata && attachment.readSourceText && original === context.sourceFrameIndex, '当前帧没有可靠绑定的原始波函数，未改用近似密度。');
      const value = await attachment.readSourceText(op.abort.signal); current(op);
      assert(value.sourceId === attachment.source.metadata.sourceId && value.sourceRevision === attachment.source.metadata.sourceRevision && value.name && (value.text || value.sourceToken), '原始波函数快照身份或预算不符。');
      source = { kind: 'wavefunction', ...value, context };
    }
    current(op); const existing = sessions.get(source.kind); if (existing) { op.sessionId = existing.id; assert(existing.methods.includes(method), '当前来源不支持此相互作用方法。'); return existing; }
    const session: Session = { id: 'interaction-' + crypto.randomUUID(), kind: source.kind, methods: [] }; op.sessionId = session.id;
    try { const info = await desktop.openInteractionSession({ sessionId: session.id, source }); current(op); assert(info.sessionId === session.id && sameSurfaceContext(info.context, context) && info.atomCount === structure.atoms.length && info.methods.includes(method), '相互作用会话身份/能力不符。'); session.methods = info.methods; sessions.set(source.kind, session); return session; }
    catch (error) { try{await desktop.closeInteractionSession(session.id);}catch(closeError){orphanSessions.add(session.id);report(closeError);}throw error; }
  }
  function acceptFields(result: InteractionGeneratedFields, expected: SurfaceStamp): readonly SurfaceScalarField[] {
    assert(sameSurfaceStamp(result.stamp, expected), '相互作用格点回执身份不符。');
    validateInteractionGeneratedFields(result);
    const fields = Object.values(result.fields).filter((field): field is SurfaceScalarField => !!field);
    return [...fields, result.mapping];
  }
  const ports: InteractionControlsBridge = {
    generate(request, signal) { return run(request.requestId, signal, async op => {
      checkedContext(request.context); const session = await ensureSession(request.method, op); assert(desktop.generateInteraction, '相互作用生成入口不可用。');
      const expected = stamp(request.requestId), result = await desktop.generateInteraction(session.id, { stamp: expected, method: request.method, fragments: request.fragments, quality: request.quality }); current(op);
      assert(result.method === request.method && JSON.stringify(result.fragments) === JSON.stringify(request.fragments) && JSON.stringify(result.quality) === JSON.stringify(request.quality), '相互作用方法/片段/质量发生变化。');
      const fields = acceptFields(result, expected); artifacts.set(request.requestId, { session, method: result.method, fragments: result.fragments, quality: result.quality, signatures: fields.map(signature) }); for (const field of fields) generated.set(field.id, { session, signature: signature(field) }); return result;
    }); },
    contributions(request, signal) { return run(request.requestId, signal, async op => {
      checkedContext(request.context); const session = await ensureSession(request.method, op); assert(desktop.interactionContributions, '相互作用贡献入口不可用。'); const expected = stamp(request.requestId);
      const result = await desktop.interactionContributions(session.id, { stamp: expected, method: request.method, fragments: request.fragments, pair: request.pair, integrationQuality: request.integrationQuality }); current(op);
      validateInteractionContributions(result, { stamp: expected, method: request.method, fragments: request.fragments, pair: request.pair, integrationQuality: request.integrationQuality });
      assert(sameSurfaceStamp(result.stamp, expected) && result.method === request.method && JSON.stringify(result.fragments) === JSON.stringify(request.fragments) && JSON.stringify(result.pair) === JSON.stringify(request.pair) && result.integrationQuality === request.integrationQuality && result.percentageDefinition === 'atoms-within-each-fragment;pairs-within-selected-pair', '相互作用贡献回执身份/分母不符。'); return result;
    }); },
    restoreFields(request, signal) { return run(request.requestId, signal, async op => {
      checkedContext(request.context); const artifact = artifacts.get(request.generationId); assert(artifact && sessions.get(artifact.session.kind) === artifact.session, '相互作用artifact已释放，不能用新计算冒恢复。'); assert(desktop.restoreInteractionFields, '只读相互作用恢复入口不可用。'); op.sessionId = artifact.session.id;
      const expected = stamp(request.requestId), result = await desktop.restoreInteractionFields(artifact.session.id, { stamp: expected, generationId: request.generationId }); current(op); const fields = acceptFields(result, expected);
      assert(result.method === artifact.method && JSON.stringify(result.fragments) === JSON.stringify(artifact.fragments) && JSON.stringify(result.quality) === JSON.stringify(artifact.quality) && JSON.stringify(fields.map(signature)) === JSON.stringify(artifact.signatures), '恢复格点与原artifact身份不符。'); return result;
    }, true); },
    importCube(request, signal) { return run(request.requestId, signal, async op => {
      checkedContext(request.context); assert(desktop.importSurfaceCube && desktop.releaseSurfaceCube, '当前环境没有可信Cube文件入口。'); assert(request.file.size > 0 && request.file.size <= MAX_SOURCE, 'Cube须为非空的完整文件。');
      assert(request.role === 'mapping' || (request.method === 'iri' || request.method === 'rdg' ? request.role === request.method : ['inter', 'intra', 'total'].includes(request.role)), 'Cube明确角色与方法不符。');
      const value = await desktop.importSurfaceCube(request.file); if (!value) throw aborted(); tokens.add(value.token); let accepted = false;
      try { current(op); assert(value.token && value.sourceRevision && value.bytes === request.file.size && new TextEncoder().encode(value.text).byteLength === value.bytes, 'Cube快照身份或字节数不符。');
        const field = molecularCubeField(parseMolecularCube(value.text), { id: 'interaction-field-' + crypto.randomUUID(), context, function: fieldFunctions[request.role], functionLabel: request.role, valueUnit: request.valueUnit,
          definitionEvidence: { kind: 'user-provided', description: `用户明确${request.method}/${request.role}函数与单位` }, source: { id: value.token, name: value.name, revision: value.sourceRevision, kind: 'external-cube', producer: 'unknown' }, validDomain: { kind: 'full-grid', evidence: '按用户确认的外部Cube直接绘图约定使用全部文件节点；并非独立验证计算覆盖，内容绑定域记录优先' } }, value.knownDomain);
        validateSurfaceScalarField(field); current(op); imported.set(field.id, { token: value.token, metadata: metadata(field), signature: signature(field) }); tokens.add(value.token);
        const {values:_values,...fieldMetadata}=field;retainAnalysisProjectSnapshot(analysisOriginalCubeKey(options.analysisId,context,field.id),{name:value.name,originalBytes:new TextEncoder().encode(value.text),sourceRevision:value.sourceRevision,fieldMetadata} satisfies AnalysisOriginalCube);
        accepted = true; return field;
      } finally { if (!accepted) await releaseToken(value.token).catch(report); }
    }); },
    restoreCube(request, signal) { return run(request.requestId, signal, async op => {
      checkedContext(request.context); const entry = await restoreImported(request.fieldId);current(op);assert(entry && entry.metadata.source.id === request.sourceId && entry.metadata.source.revision === request.sourceRevision && desktop.readRegisteredSurfaceCube, 'Cube恢复来源不属于当前owner。');
      const value = await desktop.readRegisteredSurfaceCube(entry.token); current(op); assert(value.token === entry.token && value.sourceRevision === request.sourceRevision && value.bytes <= MAX_SOURCE && new TextEncoder().encode(value.text).byteLength === value.bytes, 'Cube快照身份已变化。');
      const field = molecularCubeField(parseMolecularCube(value.text), entry.metadata, value.knownDomain??entry.projectDomain); validateSurfaceScalarField(field); assert(signature(field) === entry.signature, 'Cube恢复缺失原身份/网格/域。'); return entry.projectDomain?markRestoredAnalysisData(field):field;
    }, true); },
    exportCube(field, signal, requestId) { return run(requestId, signal, async op => {
      checkedContext(field.context); validateSurfaceScalarField(field); const external = imported.get(field.id);
      if (external) { assert(signature(field) === external.signature && desktop.exportRegisteredSurfaceCube, '外部Cube身份或安全导出入口不符。'); const result = await desktop.exportRegisteredSurfaceCube({ token: external.token, fieldMetadata: external.metadata }); current(op); if (result.cancelled) throw aborted(); assert(typeof result.path==='string'&&result.path.length>0,'Cube导出未确认保存，不能报告成功。'); return; }
      const entry = generated.get(field.id); assert(entry && signature(field) === entry.signature && sessions.get(entry.session.kind) === entry.session && desktop.exportInteractionCube, '生成格点没有当前可信artifact。'); op.sessionId = entry.session.id;
      const result = await desktop.exportInteractionCube(entry.session.id, { stamp: stamp(op.requestId), fieldId: field.id }); current(op); if (result.cancelled) throw aborted(); assert(result.saved === true, 'Cube导出未确认保存，不能报告成功。');
    },true); },
    async cancel(requestId) { if (operation?.requestId === requestId) await cancelOperation(operation); },
  };
  const runtimeOwner=registerAnalysisRuntimeOwner({analysisId:options.analysisId,kind:'interaction',label:'相互作用分析',sourceId:context.sourceId,sourceRevision:context.sourceRevision,documentId:context.documentId},{
    isBusy:()=>Boolean(operation)||tasks.size>0,hasData:()=>sessions.size>0||tokens.size>0||artifacts.size>0||orphanSessions.size>0,
    revision:()=>[[...sessions.values()].map(session=>session.id),[...artifacts.keys()],[...tokens],[...orphanSessions]],
    retire(){disposed=true;active=false;epoch++;for(const off of progressSubscriptions)off();progressSubscriptions.clear();},
    async release(){
      if(operation)await cancelOperation(operation).catch(report);await Promise.allSettled([...tasks]);
      const ids=new Set([...sessions.values()].map(session=>session.id).concat([...orphanSessions]));
      const closed=await Promise.allSettled([...ids].map(async id=>{assert(desktop.closeInteractionSession,'当前环境缺少相互作用关闭入口。');await desktop.closeInteractionSession(id);orphanSessions.delete(id);for(const[kind,session]of sessions)if(session.id===id)sessions.delete(kind);}));
      const released=await Promise.allSettled([...tokens].map(releaseToken));imported.clear();generated.clear();artifacts.clear();
      const failures=[...closed,...released].filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);if(failures.length)throw new AggregateError(failures,'部分相互作用来源未确认释放。');
    },
  });
  return { bridge: ports,
    generatedFieldSource(field: SurfaceScalarField): InteractionSource['kind'] | null {
      if (disposed || !sameSurfaceContext(field.context, context)) return null;
      const entry = generated.get(field.id); return entry && sessions.get(entry.session.kind) === entry.session && signature(field) === entry.signature ? entry.session.kind : null;
    },
    cubeGeometryError(field: SurfaceScalarField): string | null { try { checkedContext(field.context); assertSurfaceCubeSourceGeometry(field, structure, options.coordinateRoundingAngstrom); return null; } catch (error) { return error instanceof Error ? error.message : String(error); } },
    onProgress(listener: Parameters<NonNullable<DesktopBridge['onMultiwfnProgress']>>[0]) { if(disposed)return()=>{};const off=desktop.onMultiwfnProgress?.(snapshot => { const id = snapshot.identity; if (!disposed && id.ownerId === options.analysisId && id.analysisId === options.analysisId && id.sourceId === context.sourceId && id.sourceRevision === context.sourceRevision && id.jobIndex === context.jobIndex && id.sourceFrameIndex === context.sourceFrameIndex && id.generation === context.generation) listener(snapshot); }) ?? (() => {});progressSubscriptions.add(off);return()=>{if(progressSubscriptions.delete(off))off();}; },
    async setActive(value: boolean) { if (disposed || value === active) return; active = value; epoch++; if (!value && operation) await cancelOperation(operation); },
    dispose:runtimeOwner.dispose,
  };
}
