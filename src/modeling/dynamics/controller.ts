import type { Structure } from '../../core/types';
import { effectiveModelCoordinates } from '../constraints';
import type { DocumentStamp, ForcefieldChoice, ModelDocument, ModelStore, NativeMDPolicy } from '../contracts';
import { coordinatesFingerprint, getMovableAtomIds } from '../../core/modeling/graph';
import type { DynamicsCommand, DynamicsEvent, DynamicsFrame, DynamicsMethod, MDMethod, DynamicsOperation, DynamicsRequest, DynamicsTerminalFailure, DynamicsTermination, GeometryDistanceTarget, GeometryTargetStatus } from './contracts';
import type { DynamicsCapabilities, DynamicsPort } from './port';
import { validateDynamicsAdmission, validateDynamicsConfig, validateDynamicsStructure, validateDynamicsError } from './validation';
import { validateHybridMetadata } from './hybrid-metadata';
import { createRuntimeModelStore } from '../../core/modeling/model-store';
import {runtimePreviewSourceCurrent} from '../../core/modeling/runtime-source-lineage';
import { BoundedDisplayQueue, createDisplayScheduler, DISPLAY_BYTE_LIMIT, DISPLAY_FRAME_LIMIT, DISPLAY_INTERVAL_MS, DISPLAY_MAX_WAIT_MS, serializedFrameBytes, type DisplayScheduler } from './display-queue';

export type DynamicsStatus = 'idle' | 'starting' | 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'error';
export interface DynamicsConfig { temperatureK?: number; maxSteps?: number; maxWallTimeSeconds?: number; forcefield?: ForcefieldChoice; method?: MDMethod; movableAtomIds?: string[]; seed?: number; frictionPerFs?: number; geometryMode?: 'hybrid-local'; hybridScalePolicy?: 'uff-bond-stiffness-v1'; allowPureGeometryFallback?: true; geometryDistanceTargets?: GeometryDistanceTarget[] }
export interface DisplayDynamicsFrame extends DynamicsFrame { physicalTimeFs: number; instantTemperatureK?: number }
export interface DynamicsSnapshotObservation { step:number; timeFs:number; energyEV?:number; temperatureK?:number; targetTemperatureK?:number; forcefield?:string; nativeMD?:DynamicsEvent['nativeMD']; engine?:string; engineVersion?:string; aseVersion?:string }
export interface DynamicsSnapshot { structure: Structure; seq: number; sessionId?: string; detached?: true; workingSource?: {documentId:string;revision:number}; modelDocument?:ModelDocument; observation?:DynamicsSnapshotObservation }
export interface DynamicsControllerState {
  status: DynamicsStatus; capabilities: DynamicsCapabilities; mode?: DynamicsOperation;
  sessionId?: string; referenceStructure?: Structure; lastFrame?: DisplayDynamicsFrame; displayFrame?:DisplayDynamicsFrame; error?: string; seed?: number;
  terminalFailure?: DynamicsTerminalFailure;
  termination?: DynamicsTermination;
  workingSource?: { documentId: string; revision: number };
}
export interface DynamicsDependencies {
  getSnapshot(): ModelDocument;
  getWorkingSnapshot?(): ModelDocument;
  getStamp(movableAtomIds?: string[], nativeMDPolicy?: NativeMDPolicy): DocumentStamp;
  beginRun(): void;
  acceptFrame(frame: DynamicsFrame): void;
  commitRun(): void;
  finishRun(): void;
  hasRuntimeLock?(): boolean;
  allowsWorkingEdits?(): boolean;
}
export type DynamicsUICommand = { type: 'pause' | 'stop' } | { type: 'resume'; temperatureK?: number };
const clone = <T,>(value: T): T => structuredClone(value);
const sameStamp = (a: DocumentStamp, b: DocumentStamp) => a.documentId === b.documentId && a.revision === b.revision && a.graphFingerprint === b.graphFingerprint && a.coordinatesFingerprint === b.coordinatesFingerprint && a.constraintsFingerprint === b.constraintsFingerprint && JSON.stringify(a.nativeMDPolicy) === JSON.stringify(b.nativeMDPolicy);
function validateMDMetadata(event:DynamicsEvent,request:DynamicsRequest):void {
  if(!request.method || !event.structure)return;
  const metadata=event.nativeMD;
  if(!metadata || metadata.method!==request.method || metadata.dtFs!==2 || metadata.thermostat!=='Berendsen' || metadata.hydrogenMassAmu!==(request.method==='gfnff'?4:null) || metadata.shakeHydrogenBonds!==(request.method!=='gfnff') || JSON.stringify(metadata.protectedAtomIds)!==JSON.stringify(request.protectedAtomIds??[]) || metadata.protection!==((request.protectedAtomIds??[]).length?'pairwise-distance':'none') || metadata.forceConstantKJMolNm2!==500000 || !Number.isSafeInteger(metadata.segment) || metadata.segment<0 || metadata.velocityInitialization!==(metadata.segment===0?'fresh':'restart') || typeof metadata.nativeClosed!=='boolean')throw new Error('原生MD方法或保护元数据不符。');
  if(metadata.rawPotential){const p=metadata.rawPotential,protectedRun=(request.protectedAtomIds??[]).length>0;if(!Number.isFinite(p.value)||p.unit!=='hartree'||p.definition!==(protectedRun?'native-total-including-protection':'native-physical-potential')||p.includesProtection!==protectedRun||p.sourceArtifact!=='xtb.trj'||!Number.isSafeInteger(p.sourceStep)||p.sourceStep<0||p.sourceStep>event.step!||p.sourceTimeFs!==p.sourceStep*2||!Number.isSafeInteger(p.segment)||p.segment<0||p.segment>metadata.segment)throw new Error('原生MD总势能来源或含保护项定义不符。');}
}
const active = (status: DynamicsStatus) => ['starting', 'running', 'pausing', 'paused', 'stopping'].includes(status);
const targetKey = (atomIds: string[], image: number[] = [0,0,0]) => {
  const forward = JSON.stringify([atomIds,image]), reverse = JSON.stringify([[atomIds[1],atomIds[0]],image.map(value=>-value)]);
  return forward < reverse ? forward : reverse;
};
const targetEdges = (structure: Structure) => new Map((structure.bonds ?? []).map(edge => [targetKey([structure.atoms[edge.a].id!,structure.atoms[edge.b].id!],edge.image),edge]));
function targetEndpoint(row: { atomIds: string[]; image?: number[] }, structure: Structure): string {
  const ids = new Set(structure.atoms.map(atom=>atom.id)), image = row.image ?? [0,0,0];
  if (!Array.isArray(row.atomIds) || row.atomIds.length !== 2 || row.atomIds.some(id=>typeof id !== 'string' || !ids.has(id)) || !Array.isArray(image) || image.length !== 3 || image.some((v,i)=>!Number.isSafeInteger(v) || Math.abs(v)>1000000 || v !== 0 && !structure.cell?.pbc[i])) throw new Error('机械距离的原子或镜像身份无效。');
  return targetKey(row.atomIds,image);
}
function validateDistanceTargets(value: GeometryDistanceTarget[] | undefined, request: Pick<DynamicsRequest,'operation'|'geometryMode'|'structure'>): void {
  if (value === undefined) return;
  if (request.operation !== 'geometry' || request.geometryMode !== undefined || !Array.isArray(value) || value.length > 4000) throw new Error('显式机械距离仅适用于纯几何整理。');
  const edges = targetEdges(request.structure), seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Object.keys(row).some(k=>!['atomIds','image','distanceAngstrom'].includes(k)) || !Number.isFinite(row.distanceAngstrom) || row.distanceAngstrom<=0 || row.distanceAngstrom>1000000) throw new Error('显式机械距离无效。');
    const key = targetEndpoint(row,request.structure), edge = edges.get(key);
    if (!edge || edge.order === .5 || seen.has(key)) throw new Error('显式机械距离必须指向已有的非弱连接，不能新增连接。');
    seen.add(key);
  }
}
function validateTargetStatus(value: GeometryTargetStatus, request: DynamicsRequest): void {
  const counts = ['targetedConnectionCount','movableConnectionTargetCount','untargetedCoordinationCount','weakConnectionCount','unresolvedImmovableConnectionCount','angleTargetCount','planeTargetCount','activeCollisionCount'] as const;
  if (request.operation !== 'geometry' || request.geometryMode !== undefined || !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== counts.length+2 || Object.keys(value).some(k=>![...counts,'status','connectionTargets'].includes(k)) || counts.some(k=>!Number.isSafeInteger(value[k]) || value[k]<0)) throw new Error('机械目标状态字段无效。');
  if (!Array.isArray(value.connectionTargets) || value.connectionTargets.length !== (request.structure.bonds ?? []).length) throw new Error('机械目标项数无效。');
  const edges=targetEdges(request.structure), explicit=new Map((request.geometryDistanceTargets ?? []).map(row=>[targetKey(row.atomIds,row.image),row.distanceAngstrom])), movable=new Set(request.movableAtomIds), seen=new Set<string>();
  let targeted=0, available=0, unsupported=0, weak=0;
  for (const row of value.connectionTargets) {
    if (!row || typeof row !== 'object' || Object.keys(row).length!==5 || Object.keys(row).some(k=>!['atomIds','image','targetAngstrom','source','orderKnown'].includes(k))) throw new Error('机械连接目标字段无效。');
    const key=targetEndpoint(row,request.structure), edge=edges.get(key);
    if (!edge || seen.has(key) || row.orderKnown !== (edge.orderKnown !== false)) throw new Error('机械目标改变了连接或键级身份。'); seen.add(key);
    if (edge.order===.5) { if(row.source!=='weak-relation' || row.targetAngstrom!==null)throw new Error('弱连接不能成为普通共价目标。'); weak++; }
    else if(explicit.has(key)) { if(row.source!=='user-distance' || row.targetAngstrom!==explicit.get(key))throw new Error('显式机械距离未按请求保留。'); }
    else if(edge.kind==='coordination') { if(row.source!=='unavailable-coordination' || row.targetAngstrom!==null)throw new Error('配位连接缺少可靠距离目标。'); unsupported++; }
    else if(!['typical-covalent','covalent-radii'].includes(row.source) || edge.orderKnown===false && row.source!=='covalent-radii')throw new Error('未知键级不能被提升为已知共价键目标。');
    if(row.targetAngstrom!==null) {
      if(!Number.isFinite(row.targetAngstrom) || row.targetAngstrom<=0 || row.targetAngstrom>1000000)throw new Error('机械目标距离无效。'); targeted++;
      if(row.atomIds[0]!==row.atomIds[1] && row.atomIds.some(id=>movable.has(id)))available++;
    }
  }
  if(value.targetedConnectionCount!==targeted || value.movableConnectionTargetCount!==available || value.untargetedCoordinationCount!==unsupported || value.weakConnectionCount!==weak || value.unresolvedImmovableConnectionCount>targeted-available)throw new Error('机械目标摘要与连接记录不一致。');
  const hasTargets=available+value.angleTargetCount+value.planeTargetCount>0;
  const expected=hasTargets ? unsupported || value.unresolvedImmovableConnectionCount ? 'partial-targets' : 'targeted' : value.activeCollisionCount ? 'collision-only' : 'no-targets';
  if(value.status!==expected)throw new Error('机械状态与实际可调整目标不一致。');
}

/** Headless controller: bounded latest-frame storage, independent runtime revision, grouped undo. */
export class DynamicsController {
  private workingSourceDocument?:ModelDocument;
  getWorkingSourceDocument=()=>this.workingSourceDocument;
  private state: DynamicsControllerState = { status: 'idle', capabilities: { available: false, reason: '正在检查原生动态引擎。' } };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private request?: DynamicsRequest;
  private nativeMDPolicy?: NativeMDPolicy;
  private expectedStamp?: DocumentStamp;
  private nextSeq = -1;
  private transaction = false;
  private disposed = false;
  private generation = 0;
  private pendingCommand = false;
  private coordinatesAccepted = false;
  private terminationTask?: { sessionId: string; promise: Promise<DynamicsTermination & { status: 'settled' }> };
  private readonly windowId = crypto.randomUUID();
  private pausedWaiters: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }[] = [];
  private startedWaiters: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }[] = [];
  private readonly displayQueue=new BoundedDisplayQueue<DisplayDynamicsFrame>();
  private cancelDisplay?:()=>void;
  private displayAt=0;
  private readonly displayScheduler:DisplayScheduler;

  constructor(private readonly port: DynamicsPort, private readonly deps: DynamicsDependencies, options?:{displayScheduler?:DisplayScheduler}) {
    this.displayScheduler=options?.displayScheduler??createDisplayScheduler();
    void port.capabilities().then(capabilities => { if (!this.disposed) this.update({ capabilities }); }).catch(cause => this.update({ capabilities: { available: false, reason: String(cause) } }));
  }
  /** React StrictMode may mount/cleanup/remount the same committed instance. */
  connect(): void {
    if (this.disposed) throw new Error('动态控制器已关闭。');
    this.unsubscribe ??= this.port.subscribe(event => this.receive(event));
  }
  disconnect(): void { this.invalidateSession('模型窗口已断开'); this.unsubscribe?.(); this.unsubscribe = undefined; }
  getSnapshot = (): DynamicsControllerState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<DynamicsControllerState>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private begin() { if (!this.transaction) { this.deps.beginRun(); this.transaction = true; } }
  private commit() { if (this.transaction) { this.transaction = false; this.deps.commitRun(); } }
  private finish() { this.clearDisplayQueue();this.commit(); this.deps.finishRun(); }
  private clearDisplayQueue():void {this.cancelDisplay?.();this.cancelDisplay=undefined;this.displayQueue.clear();}
  private scheduleDisplay():void {
    if(this.cancelDisplay || this.state.mode!=='md' || !active(this.state.status))return;
    if(!this.displayQueue.count && this.state.displayFrame?.seq===this.state.lastFrame?.seq)return;
    const generation=this.generation,sessionId=this.state.sessionId;
    this.cancelDisplay=this.displayScheduler.request(()=>{
      this.cancelDisplay=undefined;
      if(this.disposed || generation!==this.generation || sessionId!==this.state.sessionId || !active(this.state.status))return;
      const now=this.displayScheduler.now(),oldest=this.displayQueue.oldestReceivedAt;
      let frame:DisplayDynamicsFrame|undefined;
      if(oldest!==undefined && now-oldest>DISPLAY_MAX_WAIT_MS){this.displayQueue.clear();frame=this.state.lastFrame;}
      else frame=this.displayQueue.shift()??this.state.lastFrame;
      if(frame){this.displayAt=now;this.update({displayFrame:frame});}
      this.scheduleDisplay();
    },Math.max(0,DISPLAY_INTERVAL_MS-(this.displayScheduler.now()-this.displayAt)));
  }
  private presentMD(frame:DisplayDynamicsFrame,frames:DisplayDynamicsFrame[]):void {
    const now=this.displayScheduler.now();
    if(serializedFrameBytes(frame)>DISPLAY_BYTE_LIMIT){this.clearDisplayQueue();this.displayAt=now;this.update({displayFrame:frame});return;}
    for(const item of frames)this.displayQueue.push(item,now);
    if(!this.state.displayFrame){this.displayAt=now;this.update({displayFrame:this.displayQueue.shift()??frame});}
    this.scheduleDisplay();
  }
  private validateDisplayBatch(event:DynamicsEvent,request:DynamicsRequest):DisplayDynamicsFrame[] {
    if(event.displayFrames===undefined)return event.event==='frame'&&request.operation==='md'&&serializedFrameBytes(event)<=DISPLAY_BYTE_LIMIT?[{...clone(event),event:'frame',physicalTimeFs:event.timeFs!,instantTemperatureK:event.temperatureK} as DisplayDynamicsFrame]:[];
    if(request.operation!=='md' || event.event!=='frame' || !Array.isArray(event.displayFrames) || event.displayFrames.length>DISPLAY_FRAME_LIMIT)throw new Error('动态显示批次类型或数量无效。');
    let bytes=0,lastSeq=this.nextSeq,lastStep=this.state.lastFrame?.step??-1;const frames:DisplayDynamicsFrame[]=[];
    for(const item of event.displayFrames){
      if(!item || item.displayFrames!==undefined || item.schema!==1 || item.event!=='frame' || item.operation!=='md' || item.sessionId!==event.sessionId || !item.stamp || !sameStamp(item.stamp,request.stamp) || !Number.isSafeInteger(item.seq) || item.seq<=lastSeq || item.seq>event.seq || !Number.isSafeInteger(item.step) || item.step<0 || item.step<lastStep || item.step>event.step! || !Number.isFinite(item.timeFs) || item.timeFs!==item.step*(request.dtFs??1) || !item.structure)throw new Error('动态显示帧身份、顺序或时间无效。');
      bytes+=serializedFrameBytes(item);if(bytes>DISPLAY_BYTE_LIMIT)throw new Error('动态显示批次超过载荷上限。');
      validateDynamicsStructure(request.structure,item.structure,request.movableAtomIds);validateMDMetadata(item,request);
      for(const value of [item.energyEV,item.kineticEnergyEV,item.temperatureK,item.targetTemperatureK])if(value!==undefined&&!Number.isFinite(value))throw new Error('动态显示帧物理数值无效。');
      if(item.temperatureK!==undefined&&item.temperatureK<0 || item.targetTemperatureK!==undefined&&item.targetTemperatureK!==request.temperatureK || item.geometryObjective!==undefined || item.hybridGeometry!==undefined || item.geometryTargetStatus!==undefined)throw new Error('动态显示帧物理定义无效。');
      frames.push({...clone(item),physicalTimeFs:item.timeFs,instantTemperatureK:item.temperatureK});lastSeq=item.seq;lastStep=item.step;
    }
    return frames;
  }
  private settleWaiters(error?: Error) {
    for (const waiter of this.pausedWaiters.splice(0)) { clearTimeout(waiter.timer); if (error) waiter.reject(error); else waiter.resolve(); }
  }
  private settleStarted(error?: Error) {
    for (const waiter of this.startedWaiters.splice(0)) { clearTimeout(waiter.timer); if (error) waiter.reject(error); else waiter.resolve(); }
  }
  private async waitForStarted(): Promise<void> {
    if (this.state.status !== 'starting') return;
    if (this.startedWaiters.length >= 16) throw new Error('已有过多待启动控制请求。');
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => { this.startedWaiters = this.startedWaiters.filter(item => item !== waiter); reject(new Error('等待原生动态引擎启动超时；尚未发送暂停指令。')); }, 10000) };
      this.startedWaiters.push(waiter);
    });
  }
  private fail(cause: unknown, details: { origin?: DynamicsTerminalFailure['origin']; code?: string; phase?: DynamicsTerminalFailure['phase']; atomIds?: string[]; nativeTerminal?: boolean } = {}) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const sessionId = this.state.sessionId, request = this.request;
    const terminalFailure: DynamicsTerminalFailure | undefined = sessionId && request ? {
      origin: details.origin ?? 'controller', code: details.code ?? 'controller-validation-failed', message: error.message,
      stage: this.coordinatesAccepted ? 'after-frame' : 'before-first-frame', coordinatesAccepted: this.coordinatesAccepted,
      identityVerified: details.nativeTerminal === true, sessionId, stamp: clone(request.stamp), operation: request.operation,
      forcefield: request.forcefield, movableAtomIds: [...request.movableAtomIds], constraints: clone(request.constraints ?? []),
      ...(details.phase === undefined ? {} : { phase: details.phase }), ...(details.atomIds === undefined ? {} : { atomIds: [...details.atomIds] }),
    } : undefined;
    this.generation++; this.request = undefined; this.expectedStamp = undefined; this.finish();
    const termination: DynamicsTermination | undefined = sessionId ? { sessionId, status: 'pending', scope: 'controller-session-release', via: details.nativeTerminal ? 'host-terminal-observed' : 'stop-request', workerExitVerified: false } : undefined;
    // The trusted host releases ownership and starts bounded stop BEFORE forwarding a terminal event.
    // A redundant renderer Stop would reject "no longer active"; this is not an OS-close witness.
    if (termination) {
      const promise = Promise.resolve().then(async () => {
        if (!details.nativeTerminal) await this.port.command(sessionId!, { command: 'stop' });
        const settled: DynamicsTermination & { status: 'settled' } = { ...termination, status: 'settled' };
        if (this.state.sessionId === sessionId && this.state.terminalFailure === terminalFailure) this.update({ termination: settled });
        return settled;
      }).catch(cause => {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        if (this.state.sessionId === sessionId && this.state.terminalFailure === terminalFailure) this.update({ termination: { ...termination, status: 'failed', error: failure.message } });
        throw failure;
      });
      promise.catch(() => {}); // waitForTermination remains the explicit rejection consumer.
      this.terminationTask = { sessionId: sessionId!, promise };
    }
    this.update({ status: 'error', error: error.message, terminalFailure, termination,displayFrame:this.state.lastFrame }); this.settleWaiters(error); this.settleStarted(error);
  }

  /** Await controller release/stop-request settlement only; never claim native worker exit. */
  async waitForTermination(sessionId = this.state.sessionId): Promise<DynamicsTermination & { status: 'settled' }> {
    if (!sessionId || !this.terminationTask || this.terminationTask.sessionId !== sessionId) throw new Error('没有匹配的动态终止请求。');
    const task = this.terminationTask, receipt = await task.promise;
    if (this.disposed || this.state.sessionId !== sessionId || this.terminationTask !== task) throw new Error('等待终止期间会话或窗口已变化。');
    return clone(receipt);
  }

  async start(mode: DynamicsOperation, config: DynamicsConfig = {}): Promise<void> {
    if (this.disposed) throw new Error('动态控制器已关闭。');
    this.connect();
    if (active(this.state.status)) throw new Error('请先停止当前动态会话。');
    if (this.state.termination?.status === 'pending') await this.waitForTermination();
    // A new preflight must never borrow an earlier native failure for AUTO fallback.
    this.terminationTask = undefined; this.update({ terminalFailure: undefined, termination: undefined });
    const temperatureK = config.temperatureK ?? 300, maxSteps = config.maxSteps ?? (mode === 'md' ? 100000 : 500);
    validateDynamicsConfig(mode, temperatureK, maxSteps);
    const pendingGeneration = this.generation;
    const capabilities = await this.port.capabilities(); this.update({ capabilities });
    if (this.disposed) throw new Error('动态控制器已关闭。');
    if (pendingGeneration !== this.generation) throw new Error('启动期间模型或窗口已变化，动态请求已取消。');
    if (!capabilities.available) throw new Error(capabilities.reason || '动态引擎不可用。');
    if (active(this.state.status)) throw new Error('当前动态会话已启动。');
    const document = this.deps.getSnapshot(), structure = document.draft.structure;
    const constraints = effectiveModelCoordinates(document);
    validateDynamicsAdmission(structure, mode, { ...config, constraints, attachmentPorts: document.attachmentPorts });
    validateDistanceTargets(config.geometryDistanceTargets, { operation:mode, geometryMode:config.geometryMode, structure });
    if (!structure.atoms.length) throw new Error('动态整理需要非空显式原子结构。');
    if (mode === 'md' && document.attachmentPorts?.length) throw new Error('当前模型含未完成的悬空端口，属于编辑状态；完成连接或移除端口后才能运行真实MD。');
    const nativeMD = mode === 'md' && ['gfnff','gfn0','gfn1','gfn2'].includes(config.method ?? '');
    if(nativeMD && temperatureK<=0) throw new Error('GFN原生MD需要大于0 K的目标温度。');
    if (config.method !== undefined && mode !== 'md') throw new Error('MD计算级别仅适用于MD。');
    const editorMovable = config.movableAtomIds ?? getMovableAtomIds(document, 'all');
    const protectedAtomIds = structure.atoms.map(atom=>atom.id!).filter(id=>!editorMovable.includes(id));
    if (nativeMD && protectedAtomIds.length === 1) throw new Error('GFN相对距离保护至少需要2个冻结原子；请增加冻结原子，或改用MMFF/UFF。');
    const movableAtomIds = nativeMD ? structure.atoms.map(atom=>atom.id!) : editorMovable;
    if (!movableAtomIds.length) throw new Error('没有可动原子。');
    const allowedMovable = new Set(getMovableAtomIds(document, 'all'));
    if (editorMovable.some(id => !allowedMovable.has(id))) throw new Error('动态可动原子包含冻结或不存在的原子。');
    validateDynamicsStructure(structure, structure, movableAtomIds);
    this.nativeMDPolicy = nativeMD ? {kind:'native-gfn-md',method:config.method as DynamicsMethod,dtFs:2,protectedAtomIds:[...protectedAtomIds],forceConstantKJMolNm2:500000} : undefined;
    const stamp = this.deps.getStamp(movableAtomIds,this.nativeMDPolicy), sessionId = `${this.windowId}-${crypto.randomUUID()}`;
    const seed = config.seed ?? (mode === 'md' ? crypto.getRandomValues(new Uint32Array(1))[0] : undefined);
    this.request = { stamp, operation: mode, structure: clone(structure), movableAtomIds: [...movableAtomIds],
      constraints: clone(constraints),
      maxSteps, ...(config.maxWallTimeSeconds === undefined ? {} : {maxWallTimeSeconds: config.maxWallTimeSeconds}),
      ...(mode === 'geometry' ? { attachmentPorts: clone(document.attachmentPorts ?? []), ...(config.geometryDistanceTargets === undefined ? {} : { geometryDistanceTargets:clone(config.geometryDistanceTargets) }), ...(config.geometryMode ? { geometryMode: config.geometryMode, hybridScalePolicy: config.hybridScalePolicy, ...(config.allowPureGeometryFallback === true ? { allowPureGeometryFallback: true } : {}) } : {}) }
        : { ...(nativeMD ? {method:config.method as DynamicsMethod, protectedAtomIds} : {forcefield: (config.method as ForcefieldChoice | undefined) ?? config.forcefield ?? 'auto'}), ...(mode === 'md' ? {untilStopped:true as const} : {}), dtFs: nativeMD ? 2 : 1, reportEvery: 10, temperatureK, seed, frictionPerFs: config.frictionPerFs }) };
    this.expectedStamp = clone(stamp); this.nextSeq = -1; this.coordinatesAccepted = false; this.terminationTask = undefined; this.begin();
    const generation = ++this.generation;
    this.clearDisplayQueue();
    this.workingSourceDocument=document;
    this.update({ status: 'starting', mode, sessionId, referenceStructure: clone(structure), workingSource:{documentId:document.id,revision:document.revision}, lastFrame: undefined,displayFrame:undefined, error: undefined, terminalFailure: undefined, termination: undefined, seed });
    try { await this.port.start(this.request, sessionId); }
    catch (cause) { if (generation === this.generation) this.fail(cause, { origin: 'transport', code: 'transport-start-failed' }); throw cause; }
  }

  async command(command: DynamicsUICommand): Promise<void> {
    if (this.state.mode === 'md' && command.type !== 'stop') throw new Error('MD持续运行直到停止；运行中不能暂停、恢复或修改温度。');
    if (command.type === 'pause' && this.state.status === 'starting') await this.waitForStarted();
    const sessionId = this.state.sessionId;
    if (!sessionId || !this.request || !active(this.state.status)) throw new Error('当前没有活动动态会话。');
    if (this.pendingCommand) throw new Error('上一条动态控制指令尚未完成。');
    if (command.type === 'pause' && this.state.status !== 'running' && this.state.status !== 'starting') throw new Error('当前会话不能暂停。');
    if (command.type === 'resume' && this.state.status !== 'paused') throw new Error('只有已暂停会话可继续。');
    const generation = this.generation;
    this.pendingCommand = true;
    try {
      if (command.type === 'resume') {
        if (command.temperatureK !== undefined && this.request.operation === 'md') {
          validateDynamicsConfig(this.request.operation, command.temperatureK, this.request.maxSteps!);
          await this.port.command(sessionId, { command: 'set-temperature', temperatureK: command.temperatureK });
          if (generation !== this.generation) return;
        }
        this.expectedStamp = this.deps.getStamp(this.request.movableAtomIds); this.begin();
      } else this.update({ status: command.type === 'pause' ? 'pausing' : 'stopping' });
      await this.port.command(sessionId, { command: command.type });
    } catch (cause) { if (generation === this.generation) this.fail(cause, { origin: 'transport', code: 'transport-command-failed' }); throw cause; }
    finally { this.pendingCommand = false; }
  }

  /** The editing lock stays active until the native stopped event arrives. */
  async stop(): Promise<void> { await this.command({ type: 'stop' }); }

  /** Paused runtimes still own the model; editing requires an acknowledged Stop. */
  assertCanEditStructure(): void {
    if (this.deps.allowsWorkingEdits?.()) return;
    if (active(this.state.status)) throw new Error('动态会话运行或暂停期间不能修改结构；请先Stop并等待停止确认。');
    if (this.deps.hasRuntimeLock?.()) throw new Error('其他优化仍在运行，请先停止并等待结束。');
  }

  beforeExternalEdit(reason = '模型已手工修改'): void {
    this.assertCanEditStructure();
    if (this.deps.allowsWorkingEdits?.()) return;
    this.invalidateSession(reason);
  }

  /** Window teardown invalidates the session before any late native event. */
  private invalidateSession(reason: string): void {
    this.clearDisplayQueue();
    this.generation++;
    this.terminationTask = undefined;
    if (!active(this.state.status)) { this.update({ terminalFailure: undefined, termination: undefined }); return; }
    const sessionId = this.state.sessionId;
    this.request = undefined; this.expectedStamp = undefined; this.finish();
    this.update({ status: 'stopped', error: undefined, terminalFailure: undefined, termination: undefined,displayFrame:this.state.lastFrame }); this.settleWaiters(new Error(reason)); this.settleStarted(new Error(reason));
    if (sessionId) void this.port.command(sessionId, { command: 'stop' }).catch(() => {});
  }

  /** Save/generate callers await native pause acknowledgement, then capture the latest accepted seq. */
  async pauseAndSnapshot(): Promise<DynamicsSnapshot> {
    if (this.state.mode === 'md') return this.captureSnapshot();
    if (['starting', 'running', 'pausing'].includes(this.state.status)) {
      if (this.pausedWaiters.length >= 16) throw new Error('已有过多待暂停快照请求，请等待当前请求完成。');
      const paused = new Promise<void>((resolve, reject) => {
        const waiter = { resolve, reject, timer: setTimeout(() => { this.pausedWaiters = this.pausedWaiters.filter(item => item !== waiter); reject(new Error('等待动态暂停确认超时；未捕获导出快照。')); }, 10000) };
        this.pausedWaiters.push(waiter);
      });
      if (this.state.status !== 'pausing') void this.command({ type: 'pause' }).catch(cause => this.settleWaiters(cause instanceof Error ? cause : new Error(String(cause))));
      await paused;
    }
    if (this.state.status === 'stopping') throw new Error('动态会话正在停止，请等待确认后导出。');
    return { structure: clone(this.deps.getSnapshot().draft.structure), seq: this.state.lastFrame?.seq ?? 0, sessionId: this.state.sessionId };
  }

  /** Capture one complete accepted snapshot while continuous MD keeps running. */
  async captureSnapshot(): Promise<DynamicsSnapshot> {
    const working=this.deps.getWorkingSnapshot?.() ?? this.deps.getSnapshot();
    if(this.request?.operation === 'md' && this.deps.getWorkingSnapshot) {
      const source=this.state.workingSource;
      if(!source || working.id!==source.documentId || working.revision!==source.revision) throw new Error('MD运行期间工作源已变化，不能导出旧MD快照。');
      const modelDocument=clone(this.deps.getSnapshot());
      const frame=this.state.lastFrame;
      const observation: DynamicsSnapshotObservation | undefined=frame?clone({step:frame.step,timeFs:frame.timeFs,...(frame.energyEV===undefined?{}:{energyEV:frame.energyEV}),...(frame.temperatureK===undefined?{}:{temperatureK:frame.temperatureK}),...(frame.targetTemperatureK===undefined?{}:{targetTemperatureK:frame.targetTemperatureK}),...(frame.forcefield===undefined?{}:{forcefield:frame.forcefield}),...(frame.nativeMD===undefined?{}:{nativeMD:frame.nativeMD}),...(frame.engine===undefined?{}:{engine:frame.engine}),...(frame.engineVersion===undefined?{}:{engineVersion:frame.engineVersion}),...(frame.aseVersion===undefined?{}:{aseVersion:frame.aseVersion})}):undefined;
      return { structure:clone(modelDocument.draft.structure),modelDocument,...(observation?{observation}:{}),seq:frame?.seq ?? 0,sessionId:this.state.sessionId,detached:true,workingSource:clone(source) };
    }
    return { structure:clone(working.draft.structure),seq:this.state.lastFrame?.seq ?? 0,sessionId:this.state.sessionId };
  }

  private receive(event: DynamicsEvent): void {
    const request = this.request;
    if (this.disposed || !request || event.sessionId !== this.state.sessionId) return;
    try {
      if (event.schema !== 1 || !Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error('动态事件协议或序号无效。');
      if (!['ready', 'started', 'heartbeat', 'frame', 'paused', 'resumed', 'temperature', 'stopped', 'completed', 'error'].includes(event.event)) throw new Error('动态事件类型无效。');
      if (event.seq <= this.nextSeq) return;
      if (event.event === 'ready') { this.nextSeq = event.seq; return; }
      if (!event.stamp || !sameStamp(event.stamp, request.stamp) || event.operation !== request.operation) throw new Error('动态事件文档或请求身份不符。');
      if (!this.expectedStamp || !sameStamp(this.deps.getStamp(request.movableAtomIds,this.nativeMDPolicy), this.expectedStamp)) throw new Error('模型在动态会话外发生变更，旧帧已失效。');
      if (!Number.isSafeInteger(event.step) || event.step! < 0 || !request.untilStopped && event.step! > request.maxSteps! || !Number.isFinite(event.timeFs) || event.timeFs! < 0) throw new Error('动态帧步数或物理时间无效。');
      if (this.state.lastFrame && (event.step! < this.state.lastFrame.step || event.timeFs! < this.state.lastFrame.timeFs)) throw new Error('动态物理进度回退。');
      if (request.operation === 'md' && Math.abs(event.timeFs! - event.step!*(request.dtFs ?? 1)) > 1e-7) throw new Error('MD累计时间与实际积分步长不一致。');
      if (request.untilStopped && (['paused','resumed','temperature'].includes(event.event) || event.targetTemperatureK !== undefined && event.targetTemperatureK !== request.temperatureK)) throw new Error('持续MD不能暂停或修改运行温度。');
      validateMDMetadata(event,request);
      if (request.method && event.event === 'stopped' && event.nativeMD?.nativeClosed !== true) throw new Error('原生MD尚未确认实际退出。');
      if (request.operation === 'geometry') {
        if (event.timeFs !== 0) throw new Error('机械几何整理没有物理累计时间。');
        if (event.event === 'temperature' || [event.energyEV, event.kineticEnergyEV, event.temperatureK, event.targetTemperatureK, event.forcefield].some(value => value !== undefined)) throw new Error('机械几何整理不能提供物理势能、力场或温度。');
        if (event.hybridGeometry !== undefined) {
          if (request.geometryMode !== 'hybrid-local') throw new Error('未请求局部混合优化，不能接受混合结果。');
          validateHybridMetadata(event.hybridGeometry, request.structure, event.geometryObjective);
          if (event.hybridGeometry.mode === 'geometry-only' && request.allowPureGeometryFallback !== true) throw new Error('未授权自动纯几何回退，不能接受该结果。');
        }
        if (request.geometryMode === 'hybrid-local' && event.structure && !event.hybridGeometry) throw new Error('局部混合结果缺少真实分区和目标。');
        if (event.geometryObjective !== undefined && (!Number.isFinite(event.geometryObjective) || !event.hybridGeometry && event.geometryObjective < 0)) throw new Error('机械几何目标无效。');
        if (event.structure && event.geometryObjective === undefined) throw new Error('机械几何帧缺少真实几何目标。');
        if (event.geometryTargetStatus !== undefined) validateTargetStatus(event.geometryTargetStatus, request);
        if (event.reason === 'no-targets' && (event.event !== 'completed' || event.converged !== false || event.geometryTargetStatus?.status !== 'no-targets')) throw new Error('没有可调整目标时不能声称机械收敛。');
      } else if (event.geometryObjective !== undefined || event.hybridGeometry !== undefined || event.geometryTargetStatus !== undefined || event.reason === 'no-targets') throw new Error('物理力场事件不能混入机械几何目标。');
      if (event.event === 'completed' && event.reason !== undefined && (!['converged','step-limit','no-targets'].includes(event.reason) || event.reason === 'converged' && event.converged !== true || event.reason === 'step-limit' && event.converged !== false)) throw new Error('动态结束原因无效。');
      if (event.event === 'completed' && event.geometryTargetStatus?.status === 'no-targets' && (event.reason !== 'no-targets' || event.converged !== false)) throw new Error('无目标的机械结束状态不完整。');
      for (const value of [event.energyEV, event.kineticEnergyEV, event.temperatureK, event.targetTemperatureK]) if (value !== undefined && !Number.isFinite(value)) throw new Error('动态帧能量或温度非有限。');
      if (event.temperatureK !== undefined && event.temperatureK < 0 || event.targetTemperatureK !== undefined && (event.targetTemperatureK < 0 || event.targetTemperatureK > 5000)) throw new Error('动态帧温度无效。');
      const terminalError = event.event === 'error' ? validateDynamicsError(event.error, request.structure) : undefined;
      const displayFrames=this.validateDisplayBatch(event,request);
      this.nextSeq = event.seq;
      if (event.structure) {
        if (this.state.status === 'paused' && event.event === 'frame') throw new Error('暂停期间收到未恢复的动态坐标帧。');
        validateDynamicsStructure(request.structure, event.structure, request.movableAtomIds);
        // Native status/heartbeat events also carry the last validated snapshot.
        // Capture a pause's exact final step before ending its undo transaction.
        const {displayFrames: _displayBatch,...scientificEvent}=event;
        const frame = { ...scientificEvent, event: 'frame' } as DynamicsFrame;
        const changed = coordinatesFingerprint(event.structure) !== coordinatesFingerprint(this.deps.getSnapshot().draft.structure);
        if (changed) {
          if (this.state.status === 'paused' && event.event !== 'resumed') throw new Error('暂停期间动态坐标发生改变。');
          if (!this.transaction) this.begin();
          this.deps.acceptFrame(frame);
          this.coordinatesAccepted = true;
          this.expectedStamp = this.deps.getStamp(request.movableAtomIds,this.nativeMDPolicy);
        }
        const latest={ ...clone(frame), physicalTimeFs: frame.timeFs, instantTemperatureK: frame.temperatureK };
        this.update({ lastFrame:latest });
        if(request.operation==='md')this.presentMD(latest,displayFrames);
      } else if (event.event === 'frame') throw new Error('动态帧缺少结构。');
      if (event.event === 'started' || event.event === 'resumed') { this.update({ status: 'running' }); this.settleStarted(); }
      if (event.event === 'paused') { this.commit(); this.update({ status: 'paused' }); this.settleWaiters(); }
      if (event.event === 'stopped' || event.event === 'completed') {
        if (!event.structure && this.state.lastFrame) this.update({ lastFrame: { ...this.state.lastFrame, ...(event.reason === undefined ? {} : { reason:event.reason }), ...(event.converged === undefined ? {} : { converged:event.converged }), ...(event.geometryTargetStatus === undefined ? {} : { geometryTargetStatus:clone(event.geometryTargetStatus) }) } });
        this.finish(); this.request = undefined; this.expectedStamp = undefined;
        this.update({ status: event.event,displayFrame:request.operation==='md'?this.state.lastFrame:this.state.displayFrame }); this.settleWaiters(); this.settleStarted(new Error('动态会话已结束。'));
      }
      if (terminalError) {
        const error = terminalError;
        this.fail(new Error(error.message), { origin: error.code.startsWith('DYNAMICS_') ? 'host' : 'native', code: error.code,
          phase: error.diagnostic?.phase, atomIds: error.diagnostic?.atomIds, nativeTerminal: true });
      }
    } catch (cause) { this.fail(cause); }
  }

  dispose(): void { if (this.disposed) return; this.disconnect(); this.disposed = true; this.listeners.clear(); this.settleWaiters(new Error('动态控制器已关闭。')); }
}

export function createStoreDynamicsDependencies(store: ModelStore, options?: { isolated: true }): DynamicsDependencies {
  if (!options?.isolated) return { getSnapshot: store.getSnapshot, getStamp: (ids,policy) => policy?store.stampNativeMD(policy):store.stamp(ids), hasRuntimeLock: () => store.isRuntimeSessionActive?.() ?? false, beginRun: () => { store.beginRuntimeSession(); store.beginTransaction('dynamics'); }, acceptFrame: frame => { store.acceptRuntimeFrame(frame); }, commitRun: () => store.endTransaction(), finishRun: () => store.finishRuntimeSession() };
  let runStore: ModelStore | undefined, source: ModelDocument | undefined, lastFrame: DynamicsFrame | undefined, begun = false;
  return {
    getSnapshot: () => begun && runStore ? runStore.getSnapshot() : store.getSnapshot(),
    getWorkingSnapshot:store.getSnapshot,
    getStamp: (ids,policy) => {
      if (!begun) { source = store.getSnapshot(); runStore = createRuntimeModelStore(source); if(policy)store.stampNativeMD(policy);else store.stamp(ids); }
      return policy?runStore!.stampNativeMD(policy):runStore!.stamp(ids);
    },
    hasRuntimeLock: () => !!store.isRuntimeSessionActive?.() && !store.isRuntimeEditingAllowed?.(),
    allowsWorkingEdits: () => begun && store.isRuntimeEditingAllowed?.() === true,
    beginRun: () => {
      if (!runStore) { source = store.getSnapshot(); runStore = createRuntimeModelStore(source); }
      begun = true; store.beginRuntimeSession({ isolated: true });
      runStore.beginRuntimeSession(); runStore.beginTransaction('dynamics');
    },
    acceptFrame: frame => { runStore!.acceptRuntimeFrame(frame); lastFrame = clone(frame); },
    commitRun: () => { runStore?.endTransaction(); },
    finishRun: () => {
      try {
        runStore?.endTransaction(); runStore?.finishRuntimeSession();
        // Exact monotonically increasing revision prevents edit -> Undo from
        // allowing an old run to overwrite the working document again.
        const current = store.getSnapshot();
        if (lastFrame && source && runtimePreviewSourceCurrent(source,current)) {
          store.beginTransaction('dynamics');
          try { store.acceptRuntimeFrame(lastFrame,source); store.endTransaction(); }
          catch (error) { store.cancelTransaction(); throw error; }
        }
      } finally { store.finishRuntimeSession(); runStore = undefined; source = undefined; lastFrame = undefined; begun = false; }
    },
  };
}
