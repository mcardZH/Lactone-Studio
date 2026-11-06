import { atomicNumber } from '../../core/elements';
import { registerAnalysisRuntimeOwner } from '../../modeling/application/analysis-runtime-owners';
import type { Structure } from '../../core/types';
import type { DesktopBridge } from '../../modeling/contracts';
import { CUBE_READ_LIMITS, molecularCubeField, parseMolecularCube, type KnownCubeDomain } from '../../results/cube-reader';
import { postprocessWavefunctionFrame, type PostprocessDocument } from '../../results/postprocess-document';
import { sameSurfaceContext, sameSurfaceStamp, validateSurfaceAreaDistribution, validateSurfaceFieldPair, validateSurfaceScalarField } from '../../results/surface-field';
import type { SurfaceAnalysisResult, SurfaceCapability, SurfaceContext, SurfaceCubeQuality, SurfaceCubeSourceRef, SurfaceImportedCube, SurfaceScalarField, SurfaceSourceRequest, SurfaceStamp, SurfaceValidDomain } from '../../results/surface-contracts';
import type { SurfaceAnalysisInvocation, SurfaceCapabilityRequest, SurfaceControlsBridge } from './surface-controls-contracts';
import { traceTrajectoryOperation } from '../../results/trajectory-operations';
import {surfaceCapabilityKey} from './surface-capability';
import { analysisOriginalCubeKey, loadAnalysisProjectSnapshot, markRestoredAnalysisData, notifyAnalysisProjectStateChanged, rebindAnalysisContext, retainAnalysisProjectSnapshot, type AnalysisOriginalCube } from '../../projects/analysis-state';

export type SurfaceDesktopApi = Pick<DesktopBridge,
  'surfaceCapabilities' | 'openSurfaceSession' | 'analyzeSurface' | 'surfaceRegion' | 'surfaceDistribution' | 'generateSurface' | 'surfaceRestoreFields'
  | 'cancelSurface' | 'closeSurfaceSession' | 'importSurfaceCube' | 'registerSurfaceCube' | 'readRegisteredSurfaceCube' | 'releaseSurfaceCube' | 'exportSurfaceCube' | 'exportRegisteredSurfaceCube'> & Partial<Pick<DesktopBridge, 'orbitalResourceInfo'>> & Partial<import('../../results/multiwfn-progress').MultiwfnProgressBridge>;
export interface SurfaceDesktopBridgeOptions {
  desktop: SurfaceDesktopApi; analysisId: string; context: SurfaceContext; document: PostprocessDocument;
  /** Actual current source geometry, before camera/accepted wavefunction display fits. */
  structure: Structure; coordinateRoundingAngstrom: number | null; active: boolean;
  onCleanupError?(message: string): void;
}
interface SourceSession { id: string; key: string; function: 'esp' | 'alie'; analysis: SurfaceAnalysisResult | null; capabilities: readonly SurfaceCapability[] }
interface Operation { requestId: string; epoch: number; abort: AbortController; sessionId?: string; cancel?: Promise<unknown>; readOnly: boolean }
interface ImportedField { ref: SurfaceCubeSourceRef; revision: string; signature: string; projectRestored?: boolean }
interface GeneratedField { session: SourceSession; stamp: SurfaceStamp; revision: string }
interface GeneratedArtifact { session: SourceSession; stamp: SurfaceStamp; quality: SurfaceCubeQuality; shape: string; mapping: string | null }
const BOHR_TO_ANGSTROM = .529177210903;
const SOURCE_BYTES_LIMIT = CUBE_READ_LIMITS.bytes;
// Content restrictions survive a view/controller replacement. The host's
// persistent content registry remains authoritative across application restarts.
const knownDomains = new WeakMap<SurfaceDesktopApi, Map<string, KnownCubeDomain>>();
const abortError = () => new DOMException('分子表面请求已取消或来源已改变。', 'AbortError');
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function metadata(field: SurfaceScalarField): SurfaceCubeSourceRef['fieldMetadata'] {
  const { values: _values, ...rest } = field, domain = field.validDomain;
  const result:SurfaceCubeSourceRef['fieldMetadata']=structuredClone({...rest,validDomain:domain.kind==='node-mask'?{...domain,mask:new Uint8Array(0)}:domain});
  // Immutable field/cache data share one mask buffer, as they share values;
  // only the scalar array is excluded from session metadata.
  if(domain.kind==='node-mask'&&result.validDomain.kind==='node-mask')result.validDomain.mask=domain.mask;
  return result;
}
function fieldArtifactSignature(field: SurfaceScalarField): string {
  const domain=field.validDomain,c=field.context,g=field.grid,binding=domain.kind==='node-mask'?domain.restrictedTo:undefined;
  return JSON.stringify([field.id,field.source.id,field.source.revision,field.function,field.valueUnit,
    [c.sourceId,c.sourceRevision,c.jobIndex,c.sourceFrameIndex,c.generation,c.documentId,c.documentRevision,c.activationEpoch],
    [g.coordinateUnit,g.origin,g.axes,g.dimensions,g.ordering],domain.kind,domain.kind==='unknown'?domain.reason:domain.evidence,
    domain.kind==='node-mask'?[domain.mask.byteLength,binding?[binding.shapeFieldId,binding.isovalue,binding.shapeSourceRevision]:null]:null]);
}
function rememberDomain(domains: Map<string, KnownCubeDomain>, revision: string, domain: SurfaceValidDomain): void {
  const previous = domains.get(revision);
  if (previous && previous.validDomain.kind !== 'full-grid') return;
  domains.set(revision, { sourceRevision: revision, validDomain: domain.kind==='node-mask'?{...domain,restrictedTo:domain.restrictedTo?{...domain.restrictedTo}:undefined}:structuredClone(domain) });
}

/** Strict source correspondence only: no fit, atom permutation or grid resample.
 * A mismatching slot remains loaded; it simply cannot open a scientific session. */
export function assertSurfaceCubeSourceGeometry(field: Pick<SurfaceScalarField, 'atoms' | 'grid' | 'precision' | 'source'>, structure: Structure, roundingAngstrom: number | null): void {
  assert(roundingAngstrom !== null && Number.isFinite(roundingAngstrom) && roundingAngstrom >= 0, '当前来源缺少坐标打印精度，不能确认外部Cube与本帧对应。');
  assert(field.atoms.length === structure.atoms.length, '外部Cube与当前来源的原子数不一致；文件槽保留。');
  const factor = field.grid.coordinateUnit === 'bohr' ? BOHR_TO_ANGSTROM : 1;
  for (let index = 0; index < field.atoms.length; index++) {
    const source = field.atoms[index], atom = structure.atoms[index];
    assert(source.sourceIndex === index + 1 && source.atomicNumber === atomicNumber(atom.element), '外部Cube与当前来源逐序元素不一致；未自动重排。');
    const coordinates = [atom.x, atom.y, atom.z];
    for (let axis = 0; axis < 3; axis++) {
      const value = source.position[axis] * factor, expected = coordinates[axis];
      const tolerance = field.precision.atomCoordinates[index][axis] * factor + roundingAngstrom
        + 64 * Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(expected));
      assert(Number.isFinite(value) && Number.isFinite(expected) && Math.abs(value - expected) <= tolerance, '外部Cube与当前来源几何不符；未平移、旋转或重采样，文件槽保留。');
    }
  }
  const state = field.source.electronicState;
  if (state?.charge !== undefined && structure.charge !== null) assert(state.charge === structure.charge, '外部Cube明确记录的电荷与当前来源冲突。');
  if (state?.multiplicity !== undefined && structure.multiplicity !== null) assert(state.multiplicity === structure.multiplicity, '外部Cube明确记录的多重度与当前来源冲突。');
}

/** One analysis/source/job/frame/generation owns these real native sessions.
 * Construction, activation and capability reads never start scientific work. */
export function createSurfaceDesktopBridge(options: SurfaceDesktopBridgeOptions) {
  const desktop = options.desktop, context = { ...options.context }, structure = structuredClone(options.structure);
  const traceContext={sourceId:context.sourceId,sourceRevision:context.sourceRevision,resultId:options.document.result.id,jobIndex:context.jobIndex??undefined,
    sourceFrameIndex:context.sourceFrameIndex??undefined,analysisId:options.analysisId};
  assert(options.analysisId && context.sourceId && context.sourceRevision, '表面会话缺少分析与来源身份。');
  let active = options.active, disposed = false, epoch = 0, operation: Operation | null = null;
  const sessions = new Map<'esp' | 'alie', SourceSession>(), imported = new Map<string, ImportedField>(), generated = new Map<string, GeneratedField>();
  const artifacts=new Map<string,GeneratedArtifact>();
  const tokens = new Set<string>(), orphanSessions = new Set<string>();
  const inFlight = new Set<Promise<unknown>>();
  const progressSubscriptions=new Set<()=>void>();
  let remembered = knownDomains.get(desktop); if (!remembered) { remembered = new Map(); knownDomains.set(desktop, remembered); }
  // Full masks belong to this source lifetime. Cross-lifetime knowledge keeps
  // only a conservative restriction sentinel; the host restores bound masks.
  const domains = new Map(remembered);
  const retainDomain = (revision: string, domain: SurfaceValidDomain) => {
    rememberDomain(domains, revision, domain);
    rememberDomain(remembered!, revision, domain.kind === 'full-grid' ? domain : {
      kind: 'unknown', reason: '此内容已有受限有效域记录；需要宿主绑定的原始有效域说明。',
    });
  };
  const report = (error: unknown) => { if(disposed)return;try { options.onCleanupError?.(error instanceof Error ? error.message : String(error)); } catch { /* Keep releasing independent owned resources. */ } };
  const releaseToken = async (token: string) => { assert(desktop.releaseSurfaceCube, '当前环境缺少Cube来源令牌释放入口。'); const result=await desktop.releaseSurfaceCube(token); assert(result.released, 'Cube来源令牌仍在使用或未确认释放。'); tokens.delete(token); };
  const current = (op: Operation) => { if (disposed || !active && !op.readOnly || epoch !== op.epoch || operation !== op || op.abort.signal.aborted) throw abortError(); };
  const stamp = (requestId: string): SurfaceStamp => ({ ...context, analysisId: options.analysisId, requestId });
  function checkedContext(candidate: SurfaceContext) { assert(sameSurfaceContext(candidate, context), '表面请求与当前来源、作业、原帧或代际不一致。'); }
  async function cancelOperation(op: Operation): Promise<void> {
    op.abort.abort();
    if (op.sessionId && desktop.cancelSurface && !op.cancel) op.cancel = desktop.cancelSurface(op.sessionId);
    await op.cancel;
  }
  async function closeSession(session: SourceSession): Promise<void> {
    assert(desktop.closeSurfaceSession, '当前环境缺少表面会话关闭入口。');
    await desktop.closeSurfaceSession(session.id);
    for (const [id, owner] of generated) if (owner.session === session) generated.delete(id);
    for(const[id,owner]of artifacts)if(owner.session===session)artifacts.delete(id);
    if (sessions.get(session.function) === session) sessions.delete(session.function);
  }
  function run<T>(requestId: string, signal: AbortSignal, execute: (op: Operation) => Promise<T>, readOnly = false): Promise<T> {
    if (disposed || !active && !readOnly || signal.aborted) return Promise.reject(abortError());
    if (operation) return Promise.reject(new Error('当前表面操作尚未结束，请先完成或取消。'));
    assert(requestId, '表面操作缺少本次请求身份。');
    const op: Operation = { requestId, epoch, abort: new AbortController(), readOnly }; operation = op;
    const abort = () => { void cancelOperation(op).catch(report); };
    signal.addEventListener('abort', abort, { once: true });
    const promise = Promise.resolve().then(async () => { current(op); const value = await execute(op); current(op); if(!op.readOnly)notifyAnalysisProjectStateChanged(); return value; })
      .finally(() => { signal.removeEventListener('abort', abort); if (operation === op) operation = null; inFlight.delete(promise); });
    inFlight.add(promise); return promise;
  }
  function acceptedAnalysis(analysis: SurfaceAnalysisResult): SourceSession {
    checkedContext(analysis.stamp);
    assert(analysis.stamp.analysisId === options.analysisId, '表面结果属于另一个分析实例。');
    const session = sessions.get(analysis.function as 'esp' | 'alie');
    assert(session?.analysis && sameSurfaceStamp(session.analysis.stamp, analysis.stamp)
      && session.analysis.function === analysis.function && session.analysis.isovalue === analysis.isovalue, '表面分析已被替换或会话已关闭，请显式重新分析。');
    return session;
  }
  function sourceRef(field: SurfaceScalarField): SurfaceCubeSourceRef {
    validateSurfaceScalarField(field); checkedContext(field.context);
    const entry = imported.get(field.id);
    assert(entry && entry.revision === field.source.revision && entry.ref.fieldMetadata.source.id === field.source.id, '此Cube没有当前owner的可信导入令牌。');
    assert(entry.ref.fieldMetadata.function === field.function && entry.ref.fieldMetadata.valueUnit === field.valueUnit, '已导入Cube的物理量或单位已改变，请重新明确导入元数据。');
    return entry.ref;
  }
  async function restoreImported(fieldId: string): Promise<ImportedField | undefined> {
    const existing=imported.get(fieldId);if(existing)return existing;
    const original=await loadAnalysisProjectSnapshot<AnalysisOriginalCube>(analysisOriginalCubeKey(options.analysisId,context,fieldId));
    if(!original)return undefined;
    assert(!disposed&&desktop.registerSurfaceCube,'当前环境缺少项目Cube原始素材注册入口。');
    const raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(original.originalBytes),value=await desktop.registerSurfaceCube({name:original.name,text:raw});
    if(disposed){await desktop.releaseSurfaceCube?.(value.token);throw abortError();}
    if(value.sourceRevision!==original.sourceRevision){await desktop.releaseSurfaceCube?.(value.token);throw new Error('项目Cube原始素材内容身份不一致。');}
    const fieldMetadata=rebindAnalysisContext(original.fieldMetadata,context),field=molecularCubeField(parseMolecularCube(raw),fieldMetadata,{sourceRevision:original.sourceRevision,validDomain:fieldMetadata.validDomain});
    const entry={ref:{token:value.token,fieldMetadata:metadata(field)},revision:value.sourceRevision,signature:fieldArtifactSignature(field),projectRestored:true};
    imported.set(fieldId,entry);tokens.add(value.token);retainDomain(value.sourceRevision,field.validDomain);return entry;
  }
  async function sourceRequest(request: SurfaceAnalysisInvocation, op: Operation): Promise<SurfaceSourceRequest> {
    if (request.input.kind === 'cubes') {
      const pair = request.input.pair, validation = validateSurfaceFieldPair(pair);
      assert(validation.compatible && pair.isovalue === request.isovalue, validation.reasons.join('；') || 'Cube表面等值与本次请求不一致。');
      await restoreImported(pair.shape.id);if(pair.mapping)await restoreImported(pair.mapping.id);current(op);
      const shape = sourceRef(pair.shape), mapping = pair.mapping ? sourceRef(pair.mapping) : null;
      assertSurfaceCubeSourceGeometry(shape.fieldMetadata, structure, options.coordinateRoundingAngstrom);
      if (pair.mapping) {
        assert(pair.mapping.function === request.function, '映射Cube物理量与本次函数不一致。');
        assertSurfaceCubeSourceGeometry(mapping!.fieldMetadata, structure, options.coordinateRoundingAngstrom);
      }
      return { kind: 'cubes', shape, mapping, context };
    }
    const attachment = options.document.wavefunction, frame = postprocessWavefunctionFrame(options.document);
    const originalFrame = frame === null ? null : options.document.result.frames.find(row => row.index === frame)?.sourceFrameIndex ?? frame;
    assert(attachment?.readSourceText && attachment.source.metadata && originalFrame === context.sourceFrameIndex
      && options.document.result.source.id === context.sourceId && options.document.result.jobIndex === context.jobIndex,
    '当前帧没有已核对的原始波函数来源读取入口。');
    const value = await attachment.readSourceText(op.abort.signal); current(op);
    assert(value.sourceId === attachment.source.metadata.sourceId && value.sourceRevision === attachment.source.metadata.sourceRevision
      && value.name && (value.text || value.sourceToken), '原始波函数来源身份、内容或读取预算不符。');
    return { kind: 'wavefunction', text: value.text, sourceToken: value.sourceToken, name: value.name, sourceId: value.sourceId, sourceRevision: value.sourceRevision, context };
  }
  async function ensureSession(request: SurfaceAnalysisInvocation, op: Operation): Promise<SourceSession> {
    const key = surfaceCapabilityKey(request), existing = sessions.get(request.function);
    assert(desktop.openSurfaceSession && desktop.closeSurfaceSession, '当前环境没有独立表面会话入口。');
    // Validate source/geometry before closing a previously valid session.
    const source = await sourceRequest(request, op); current(op);
    if (existing?.key === key) { op.sessionId = existing.id; return existing; }
    if (existing) { await closeSession(existing); current(op); }
    const session: SourceSession = { id: `surface-${crypto.randomUUID()}`, key, function: request.function, analysis: null, capabilities: [] };
    op.sessionId = session.id;
    try {
      const opened = await desktop.openSurfaceSession({ sessionId: session.id, source }); current(op);
      assert(opened.sessionId === session.id && sameSurfaceContext(opened.context, context), '表面会话回执的来源身份不一致。');
      session.capabilities = opened.capabilities;
      sessions.set(request.function, session); return session;
    } catch (error) { await desktop.closeSurfaceSession(session.id).catch(reason=>{orphanSessions.add(session.id);report(reason);}); throw error; }
  }
  const ports: SurfaceControlsBridge = {
    onProgress(listener){if(disposed)return()=>{};const off=desktop.onMultiwfnProgress?.(snapshot=>{const id=snapshot.identity;if(!disposed&&id.analysisId===options.analysisId&&id.ownerId===options.analysisId&&id.sourceId===context.sourceId&&id.sourceRevision===context.sourceRevision&&id.jobIndex===context.jobIndex&&id.sourceFrameIndex===context.sourceFrameIndex&&id.generation===context.generation)listener(snapshot);})??(()=>{});progressSubscriptions.add(off);return()=>{if(progressSubscriptions.delete(off))off();};},
    analyze(request, signal) { return run(request.requestId, signal, async op => {
      checkedContext(request.context); assert(desktop.analyzeSurface, '当前环境没有表面分析入口。');
      const session = await ensureSession(request, op); current(op);
      session.analysis = null;
      const expected = stamp(request.requestId), result = await traceTrajectoryOperation('surface',traceContext,()=>desktop.analyzeSurface!(session.id, { stamp: expected, function: request.function, isovalue: request.isovalue,
        quantitativeGrid: request.quantitativeGrid, regions: [{ id: 'molecule', kind: 'molecule', label: '全分子', atomIndices: [] }] }));
      current(op); assert(sameSurfaceStamp(result.stamp, expected) && result.function === request.function && result.isovalue === request.isovalue
        && result.route === (request.input.kind === 'cubes' ? 'cube-interpolation' : 'wavefunction-direct'), '表面分析回执不属于本次请求。');
      session.analysis = result; return result;
    }); },
    analyzeRegion(request, signal) { return run(request.requestId, signal, async op => {
      const session = acceptedAnalysis(request.analysis); op.sessionId = session.id;
      assert(desktop.surfaceRegion, '当前环境没有原生表面区域分析入口。');
      const expected = stamp(request.requestId), result = await traceTrajectoryOperation('surface',traceContext,()=>desktop.surfaceRegion!(session.id, { stamp: expected, selection: request.selection }));
      current(op); assert(sameSurfaceStamp(result.stamp, expected) && JSON.stringify(result.region.selection) === JSON.stringify(request.selection), '表面区域回执身份或原子集合不一致。'); return result;
    }); },
    distribution(request, signal) { return run(request.requestId, signal, async op => {
      const session = acceptedAnalysis(request.analysis); op.sessionId = session.id;
      assert(desktop.surfaceDistribution, '当前环境没有原生表面积分布入口。');
      const expected = stamp(request.requestId), result = await traceTrajectoryOperation('surface',traceContext,()=>desktop.surfaceDistribution!(session.id, { stamp: expected, regionId: request.regionId,
        lower: request.lower, upper: request.upper, binCount: request.binCount, valueUnit: request.valueUnit }));
      current(op); assert(sameSurfaceStamp(result.stamp, expected) && result.regionId === request.regionId && result.valueUnit === request.valueUnit, '表面积分布回执身份不一致。');
      validateSurfaceAreaDistribution(result); return result;
    }); },
    generate(request, signal) { return run(request.requestId, signal, async op => {
      const session = acceptedAnalysis(request.analysis); op.sessionId = session.id;
      assert(desktop.generateSurface && request.analysis.function !== 'external', '当前环境没有此函数的表面生成入口。');
      const expected = stamp(request.requestId), result = await traceTrajectoryOperation('surface',traceContext,()=>desktop.generateSurface!(session.id, { stamp: expected, function: request.analysis.function as 'esp'|'alie',
        isovalue: request.analysis.isovalue, quality: request.quality }));
      current(op); assert(sameSurfaceStamp(result.stamp, expected) && JSON.stringify(result.quality) === JSON.stringify(request.quality), '表面格点生成回执身份或质量档不一致。');
      const validation = validateSurfaceFieldPair(result.pair); assert(validation.compatible, validation.reasons.join('；'));
      assert(result.pair.isovalue === request.analysis.isovalue && result.pair.mapping?.function === request.analysis.function, '生成格点物理量或表面等值与当前分析不一致。');
      for (const field of [result.pair.shape, ...(result.pair.mapping ? [result.pair.mapping] : [])]) {
        checkedContext(field.context); generated.set(field.id, { session, stamp: result.stamp, revision: field.source.revision }); retainDomain(field.source.revision, field.validDomain);
      }
      artifacts.set(request.requestId,{session,stamp:result.stamp,quality:result.quality,shape:fieldArtifactSignature(result.pair.shape),mapping:result.pair.mapping?fieldArtifactSignature(result.pair.mapping):null});
      return result;
    }); },
    restoreFields(request,signal){return run(request.requestId,signal,async op=>{
      checkedContext(request.context);assert(request.analysisId===options.analysisId,'表面格点恢复属于另一个分析实例。');
      const artifact=artifacts.get(request.generationId);
      assert(artifact&&sessions.get(artifact.session.function)===artifact.session,'原表面格点artifact已释放，不能用新会话冒恢复。');
      assert(desktop.surfaceRestoreFields,'当前环境没有只读表面格点恢复入口。');op.sessionId=artifact.session.id;
      const expected=stamp(request.requestId),result=await desktop.surfaceRestoreFields(artifact.session.id,{stamp:expected,generationId:request.generationId});current(op);
      assert(sameSurfaceStamp(result.stamp,expected)&&JSON.stringify(result.quality)===JSON.stringify(artifact.quality),'表面格点恢复回执身份或质量档不一致。');
      const validation=validateSurfaceFieldPair(result.pair);assert(validation.compatible,validation.reasons.join('；'));
      assert(fieldArtifactSignature(result.pair.shape)===artifact.shape&&(result.pair.mapping?fieldArtifactSignature(result.pair.mapping):null)===artifact.mapping,'恢复格点与原artifact的格点数据身份、网格或有效域不一致。');
      for(const field of[result.pair.shape,...(result.pair.mapping?[result.pair.mapping]:[])]){
        checkedContext(field.context);generated.set(field.id,{session:artifact.session,stamp:artifact.stamp,revision:field.source.revision});retainDomain(field.source.revision,field.validDomain);
      }
      return result;
    },true);},
    restoreCube(request,signal){return run(request.requestId,signal,async op=>{
      checkedContext(request.context);const entry=await restoreImported(request.fieldId);current(op);
      assert(entry&&entry.revision===request.sourceRevision&&entry.ref.fieldMetadata.source.id===request.sourceId,'Cube恢复不属于当前owner的可信来源。');
      assert(desktop.readRegisteredSurfaceCube,'当前环境没有只读Cube来源恢复入口。');
      const value=await desktop.readRegisteredSurfaceCube(entry.ref.token);current(op);
      assert(value.token===entry.ref.token&&value.sourceRevision===entry.revision&&value.bytes>0&&value.bytes<=SOURCE_BYTES_LIMIT&&new TextEncoder().encode(value.text).byteLength===value.bytes,'Cube快照内容或身份已改变。');
      const known=value.knownDomain??domains.get(value.sourceRevision)??remembered!.get(value.sourceRevision);
      if(known)assert(known.sourceRevision===value.sourceRevision,'Cube有效域记录与快照不一致。');
      const field=molecularCubeField(parseMolecularCube(value.text),entry.ref.fieldMetadata,known);
      validateSurfaceScalarField(field);assert(fieldArtifactSignature(field)===entry.signature,'Cube恢复缺少原有完整身份、网格或有效域说明。');current(op);
      entry.ref={token:entry.ref.token,fieldMetadata:metadata(field)};retainDomain(field.source.revision,field.validDomain);return entry.projectRestored?markRestoredAnalysisData(field):field;
    },true);},
    importCube(request, signal) { return run(`surface-import-${crypto.randomUUID()}`, signal, async op => {
      checkedContext(request.context);
      assert(desktop.importSurfaceCube && desktop.releaseSurfaceCube, '当前环境没有保留原文件身份及释放归属的Cube导入入口。');
      assert((request.role === 'shape') === (request.function === 'electron-density'), 'Cube文件槽与明确函数角色不一致。');
      assert(request.file.size > 0 && request.file.size <= SOURCE_BYTES_LIMIT, 'Cube须为可完整读取的非空文件。');
      const value: SurfaceImportedCube | null = await desktop.importSurfaceCube(request.file);
      if (!value) throw abortError();
      let accepted = false;
      try {
        current(op);
        assert(value.token && value.sourceRevision && value.name && value.bytes > 0 && value.bytes <= SOURCE_BYTES_LIMIT
          && value.bytes === request.file.size && new TextEncoder().encode(value.text).byteLength === value.bytes, 'Cube可信导入回执无效。');
        const parsed = parseMolecularCube(value.text);
        const sharedDomain = remembered!.get(value.sourceRevision), localDomain = domains.get(value.sourceRevision);
        if (sharedDomain && sharedDomain.validDomain.kind !== 'full-grid' && (!localDomain || localDomain.validDomain.kind === 'full-grid')) domains.set(value.sourceRevision, sharedDomain);
        if (value.knownDomain) {
          assert(value.knownDomain.sourceRevision === value.sourceRevision, 'Cube有效域记录与内容身份不一致。');
          if (domains.get(value.sourceRevision)?.validDomain.kind === 'unknown' && value.knownDomain.validDomain.kind === 'node-mask')
            domains.set(value.sourceRevision, structuredClone(value.knownDomain));
          retainDomain(value.sourceRevision, value.knownDomain.validDomain);
        }
        const known = domains.get(value.sourceRevision);
        const field = molecularCubeField(parsed, { id: `surface-field-${crypto.randomUUID()}`, context, function: request.function,
          functionLabel: request.function === 'electron-density' ? 'ρ' : request.function.toUpperCase(), valueUnit: request.valueUnit,
          definitionEvidence: { kind: 'user-provided', description: `用户在${request.role === 'shape' ? '表面定义' : '映射函数'}槽明确的函数与单位` },
          source: { id: value.token, name: value.name, revision: value.sourceRevision, kind: 'external-cube', producer: 'unknown' },
          validDomain: { kind: 'full-grid', evidence: '外部单标量Cube完整网格；未发现已有受限内容记录' } }, known);
        validateSurfaceScalarField(field); current(op);
        imported.set(field.id, { ref: { token: value.token, fieldMetadata: metadata(field) }, revision: value.sourceRevision,signature:fieldArtifactSignature(field) }); retainDomain(value.sourceRevision, field.validDomain);
        retainAnalysisProjectSnapshot(analysisOriginalCubeKey(options.analysisId,context,field.id),{name:value.name,originalBytes:new TextEncoder().encode(value.text),sourceRevision:value.sourceRevision,fieldMetadata:metadata(field)} satisfies AnalysisOriginalCube);
        tokens.add(value.token); accepted = true; return field;
      } finally { if (!accepted && value.token) await releaseToken(value.token).catch(report); }
    }); },
    exportCube(field, signal) { return run(`surface-export-${crypto.randomUUID()}`, signal, async op => {
      validateSurfaceScalarField(field); checkedContext(field.context);
      const external = imported.get(field.id);
      if (external) {
        assert(desktop.exportRegisteredSurfaceCube, '当前环境没有受保护的已导入Cube导出入口。');
        const result = await desktop.exportRegisteredSurfaceCube(sourceRef(field)); current(op); if (result.cancelled) throw abortError(); return;
      }
      const owner = generated.get(field.id); assert(owner && owner.revision === field.source.revision && sessions.get(owner.session.function) === owner.session, '此格点不属于当前有效生成会话。');
      assert(desktop.exportSurfaceCube, '当前环境没有受保护的Cube导出入口。'); op.sessionId = owner.session.id;
      const result = await desktop.exportSurfaceCube(owner.session.id, { fieldId: field.id, stamp: { ...owner.stamp, requestId: op.requestId } });
      current(op); if (result.cancelled) throw abortError();
    },true); },
    async cancel(requestId) { if (operation?.requestId === requestId) await cancelOperation(operation); },
  };
  const runtimeOwner=registerAnalysisRuntimeOwner({analysisId:options.analysisId,kind:'surface',label:'分子表面分析',sourceId:context.sourceId,sourceRevision:context.sourceRevision,documentId:context.documentId},{
    isBusy:()=>Boolean(operation)||inFlight.size>0,hasData:()=>sessions.size>0||tokens.size>0||artifacts.size>0,
    revision:()=>[[...sessions.values()].map(session=>session.id),[...artifacts.keys()],[...tokens]],
    retire(){disposed=true;active=false;epoch++;for(const off of progressSubscriptions)off();progressSubscriptions.clear();},
    async release(){
      if(operation)await cancelOperation(operation).catch(report);await Promise.allSettled([...inFlight]);
      const closed=await Promise.allSettled([...sessions.values()].map(closeSession).concat([...orphanSessions].map(async id=>{assert(desktop.closeSurfaceSession,'当前环境缺少表面会话关闭入口。');await desktop.closeSurfaceSession(id);orphanSessions.delete(id);}))),released=await Promise.allSettled([...tokens].map(releaseToken));
      imported.clear();generated.clear();artifacts.clear();domains.clear();
      const failures=[...closed,...released].filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
      if(failures.length)throw new AggregateError(failures,'部分表面会话或Cube来源未确认释放。');
    },
  });
  return {
    ports,
    async capabilities(request?: SurfaceCapabilityRequest): Promise<readonly SurfaceCapability[]> {
      if (disposed) return [];
      if(request){checkedContext(request.context);const session=sessions.get(request.function);if(session?.key===surfaceCapabilityKey(request))return session.capabilities;}
      if (!desktop.surfaceCapabilities) return [];
      const value = await desktop.surfaceCapabilities();
      if(disposed)return[];
      if(request?.input.kind==='wavefunction'){
        const attachment=options.document.wavefunction,frame=postprocessWavefunctionFrame(options.document);
        const original=frame===null?null:options.document.result.frames.find(row=>row.index===frame)?.sourceFrameIndex??frame;
        if(!attachment?.readSourceText||!attachment.source.metadata||original!==context.sourceFrameIndex
          ||options.document.result.source.id!==context.sourceId||options.document.result.jobIndex!==context.jobIndex)
          return value.map(cap=>({...cap,wavefunctionDirect:false,generation:false,reason:'当前帧缺少已核对的原始波函数来源。'}));
      }
      return value;
    },
    ownsGeneratedField(field: SurfaceScalarField): boolean {
      const owner = generated.get(field.id);
      return !disposed && Boolean(owner && owner.revision === field.source.revision && sessions.get(owner.session.function) === owner.session && sameSurfaceContext(field.context, context));
    },
    async setActive(value: boolean): Promise<void> {
      if (disposed || active === value) return; active = value; epoch++;
      if (!active) {
        const cancellation=operation?cancelOperation(operation):Promise.resolve();
        for(const entry of imported.values())if(entry.ref.fieldMetadata.validDomain.kind==='node-mask')entry.ref={...entry.ref,fieldMetadata:{...entry.ref.fieldMetadata,validDomain:{kind:'unknown',reason:'已释放前台域掩码；需由可信快照恢复。'}}};
        domains.clear();await cancellation;
      }
    },
    dispose:runtimeOwner.dispose,
  };
}
export type SurfaceDesktopController = ReturnType<typeof createSurfaceDesktopBridge>;
