import type { Structure } from '../../core/types';
import { isPeriodic } from '../../core/periodic';
import { effectiveModelCoordinates } from '../constraints';
import type { DocumentStamp, ForcefieldChoice, ModelDocument, ModelStore, NativeMDPolicy, ScientificModelOperation } from '../contracts';
import { coordinatesFingerprint, getMovableAtomIds } from '../../core/modeling/graph';
import type { DynamicsCommand, DynamicsEvent, DynamicsFrame, MDIntegrator, MDMethod, DynamicsOperation, DynamicsRequest, DynamicsTerminalFailure, DynamicsTermination } from './contracts';
import type { DynamicsCapabilities, DynamicsPort } from './port';
import { acceptTransportedDynamicsStructure, validateDynamicsAdmission, validateDynamicsConfig, validateDynamicsStructure, validateDynamicsError } from './validation';
import { createRuntimeModelStore } from '../../core/modeling/model-store';
import {runtimePreviewSourceCurrent} from '../../core/modeling/runtime-source-lineage';
import { supportsXtbAlpb, XTB_METHOD_LABELS } from '../../core/xtb-capabilities';
import type { XtbSolvation } from '../xtb/contracts';
import { mdHydrogenSettings, resolveMDConstraint } from './md-methods';
import { BoundedDisplayQueue, createDisplayScheduler, DISPLAY_BYTE_LIMIT, DISPLAY_FRAME_LIMIT, DISPLAY_INTERVAL_MS, DISPLAY_MAX_WAIT_MS, serializedFrameBytes, type DisplayScheduler } from './display-queue';

export type DynamicsStatus = 'idle' | 'starting' | 'running' | 'pausing' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'error';
export interface DynamicsConfig { temperatureK?: number; maxSteps?: number; maxWallTimeSeconds?: number; forcefield?: ForcefieldChoice; method?: MDMethod; integrator?: MDIntegrator; shakeHydrogenBonds?: boolean; movableAtomIds?: string[]; seed?: number; solvation?:XtbSolvation; frictionPerFs?: number }
export interface DisplayDynamicsFrame extends DynamicsFrame { physicalTimeFs: number; instantTemperatureK?: number }
export interface DynamicsSnapshotObservation { step:number; timeFs:number; energyEV?:number; temperatureK?:number; targetTemperatureK?:number; forcefield?:string; nativeMD?:DynamicsEvent['nativeMD']; aseMD?:DynamicsEvent['aseMD']; engine?:string; engineVersion?:string; aseVersion?:string }
export interface DynamicsSnapshot { structure: Structure; seq: number; sessionId?: string; detached?: true; workingSource?: {documentId:string;revision:number}; modelDocument?:ModelDocument; observation?:DynamicsSnapshotObservation }
export interface DynamicsControllerState {
  status: DynamicsStatus; capabilities: DynamicsCapabilities; mode?: DynamicsOperation;
  sessionId?: string; referenceStructure?: Structure; lastFrame?: DisplayDynamicsFrame; displayFrame?:DisplayDynamicsFrame; error?: string; seed?: number;
  terminalFailure?: DynamicsTerminalFailure;
  termination?: DynamicsTermination;
  workingSource?: { documentId: string; revision: number };
  resultAdoption?: ReturnType<ScientificModelOperation['apply']>;
}
export interface DynamicsDependencies {
  getSnapshot(): ModelDocument;
  getWorkingSnapshot?(): ModelDocument;
  prepareSource?(capturedSource?:ModelDocument): ScientificModelOperation;
  getStamp(movableAtomIds?: string[], nativeMDPolicy?: NativeMDPolicy, sourceOperation?: ScientificModelOperation): DocumentStamp;
  beginRun(): void;
  acceptFrame(frame: DynamicsFrame): void;
  commitRun(): void;
  finishRun(adopt?: boolean, onAccepted?: () => void): DynamicsControllerState['resultAdoption'] | void;
  hasRuntimeLock?(): boolean;
  allowsWorkingEdits?(): boolean;
}
export type DynamicsUICommand = { type: 'pause' | 'stop' } | { type: 'resume'; temperatureK?: number };
const clone = <T,>(value: T): T => structuredClone(value);
type PresentationSample = {frame:DisplayDynamicsFrame;bytes:number};
function presentationSize(event: DynamicsEvent, fallback = event): number {
  const bytes = event.displayByteLength;
  return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : serializedFrameBytes(fallback);
}
const sameStamp = (a: DocumentStamp, b: DocumentStamp) => a.documentId === b.documentId && a.revision === b.revision && a.graphFingerprint === b.graphFingerprint && a.coordinatesFingerprint === b.coordinatesFingerprint && a.constraintsFingerprint === b.constraintsFingerprint && JSON.stringify(a.nativeMDPolicy) === JSON.stringify(b.nativeMDPolicy);
function validateMDMetadata(event:DynamicsEvent,request:DynamicsRequest):void {
  const stopped = event.event === 'stopped';
  if (!request.method || !event.structure && !stopped) return;
  const matches = (a:unknown, b:unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (request.integrator === 'ase') {
    const evidence = event.aseMD;
    const movable = new Set(request.movableAtomIds);
    const frozen = request.structure.atoms.filter(atom=>!movable.has(atom.id!)).map(atom=>atom.id!);
    if (event.nativeMD || !evidence || evidence.driver !== 'ase-bussi' || evidence.method !== request.method || evidence.dtFs !== 2
      || evidence.thermostat !== 'Bussi' || evidence.thermostatTimeConstantFs !== 500 || evidence.periodic !== isPeriodic(request.structure)
      || evidence.hydrogenMassAmu !== request.hydrogenMassAmu || evidence.shakeHydrogenBonds !== request.shakeHydrogenBonds
      || !matches(evidence.frozenAtomIds, frozen) || stopped && evidence.nativeClosed !== true) throw new Error('ASE MD方法、冻结或停止回执与运行请求不符。');
    return;
  }
  if (event.aseMD) throw new Error('原生MD运行收到ASE积分回执。');
  const metadata=event.nativeMD;
  if(!metadata || metadata.method!==request.method || metadata.dtFs!==2 || metadata.thermostat!=='Berendsen' || metadata.hydrogenMassAmu!==(request.hydrogenMassAmu??(request.method==='gfnff'?4:null)) || metadata.shakeHydrogenBonds!==(request.shakeHydrogenBonds??(request.method!=='gfnff')) || !matches(metadata.protectedAtomIds,request.protectedAtomIds??[]) || metadata.protection!==((request.protectedAtomIds??[]).length?'pairwise-distance':'none') || metadata.forceConstantKJMolNm2!==500000 || !Number.isSafeInteger(metadata.segment) || metadata.segment<0 || metadata.velocityInitialization!==(metadata.segment===0?'fresh':'restart') || typeof metadata.nativeClosed!=='boolean' || stopped&&!metadata.nativeClosed)throw new Error('原生MD方法、保护或停止回执与运行请求不符。');
  const periodic=isPeriodic(request.structure), constraints=periodic?[]:request.constraints??[];
  if(Boolean(metadata.periodic)!==periodic)throw new Error('原生MD固定晶胞回执与运行请求不符。');
  if(metadata.effectiveSeed!==undefined&&(metadata.effectiveSeed!==request.seed||metadata.seedTreatment!=='verified'||request.method==='gxtb'))throw new Error('原生MD实际种子回执不匹配。');
  if(metadata.seedTreatment!==undefined&&(request.method==='gxtb'?metadata.seedTreatment!=='program-random':event.engineVersion==='6.8.0'?metadata.seedTreatment!=='verified':metadata.seedTreatment!=='native-internal-initialization'))throw new Error('原生MD随机初始化回执不匹配。');
  if(metadata.solvation!==undefined&&(!request.solvation||metadata.solvation.model!=='alpb'||metadata.solvation.solvent!==request.solvation.solvent||metadata.solvation.parameterSet!==`internal ${XTB_METHOD_LABELS[request.method]}/ALPB`)
    ||event.step!>0&&request.solvation&&!metadata.solvation)throw new Error('原生MD溶剂回执不匹配。');
  if(event.step!>0&&(metadata.internalConstraints??[]).length!==constraints.length)throw new Error('原生MD内坐标回执与运行请求不符。');
  if(metadata.rawPotential){const p=metadata.rawPotential,protectedRun=(request.protectedAtomIds??[]).length>0||constraints.length>0;if(!Number.isFinite(p.value)||p.unit!=='hartree'||p.definition!==(protectedRun?'native-total-including-protection':'native-physical-potential')||p.includesProtection!==protectedRun||p.sourceArtifact!=='xtb.trj'||!Number.isSafeInteger(p.sourceStep)||p.sourceStep<0||p.sourceStep>event.step!||p.sourceTimeFs!==p.sourceStep*2||!Number.isSafeInteger(p.segment)||p.segment<0||p.segment>metadata.segment)throw new Error('原生MD总势能来源或含保护项定义不符。');}
}
const active = (status: DynamicsStatus) => ['starting', 'running', 'pausing', 'paused', 'stopping'].includes(status);
/** Headless controller: bounded latest-frame storage, independent runtime revision, grouped undo. */
export class DynamicsController {
  private workingSourceDocument?:ModelDocument;
  getWorkingSourceDocument=()=>this.workingSourceDocument;
  private workingOwnerDocument?:ModelDocument;
  getWorkingOwnerDocument=()=>this.workingOwnerDocument;
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
  private preparing?: { cancelled: boolean };
  private startIssued = false;
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
  /** Immutable observation only; the runtime retains request ownership. */
  getRequestSnapshot = () => this.request ? structuredClone(this.request) : undefined;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<DynamicsControllerState>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private begin() { if (!this.transaction) { this.deps.beginRun(); this.transaction = true; } }
  private commit() { if (this.transaction) { this.transaction = false; this.deps.commitRun(); } }
  private finish(adopt=false, onAccepted?:()=>void) { this.clearDisplayQueue();this.commit(); return this.deps.finishRun(adopt,onAccepted); }
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
  private presentMD(latest:PresentationSample,frames:PresentationSample[],queueLatest:boolean):void {
    const now=this.displayScheduler.now();
    if(latest.bytes>DISPLAY_BYTE_LIMIT){this.clearDisplayQueue();this.displayAt=now;this.update({lastFrame:latest.frame,displayFrame:latest.frame});return;}
    for(const item of frames)this.displayQueue.push(item.frame,now,item.bytes);
    if(queueLatest)this.displayQueue.push(latest.frame,now,latest.bytes);
    if(!this.state.displayFrame){this.displayAt=now;this.update({lastFrame:latest.frame,displayFrame:this.displayQueue.shift()??latest.frame});}
    else this.update({lastFrame:latest.frame});
    this.scheduleDisplay();
  }
  private presentationFrames(event:DynamicsEvent,request:DynamicsRequest):PresentationSample[] {
    if(request.operation!=='md' || event.event!=='frame' || !Array.isArray(event.displayFrames) || event.displayFrames.length>DISPLAY_FRAME_LIMIT)return [];
    let bytes=0,lastSeq=this.nextSeq,lastStep=this.state.lastFrame?.step??-1;const frames:PresentationSample[]=[];
    for(const item of event.displayFrames){
      if(!item || item.displayFrames!==undefined || item.schema!==1 || item.event!=='frame' || item.operation!=='md' || item.sessionId!==event.sessionId || !item.stamp || !sameStamp(item.stamp,request.stamp) || !Number.isSafeInteger(item.seq) || item.seq<=lastSeq || item.seq>=event.seq || !Number.isSafeInteger(item.step) || item.step<0 || item.step<lastStep || item.step>event.step! || !Number.isFinite(item.timeFs) || item.timeFs!==item.step*(request.dtFs??1) || !item.structure)continue;
      if([item.energyEV,item.kineticEnergyEV,item.temperatureK,item.targetTemperatureK].some(value=>value!==undefined&&!Number.isFinite(value)))continue;
      if(item.temperatureK!==undefined&&item.temperatureK<0 || item.targetTemperatureK!==undefined&&item.targetTemperatureK!==request.temperatureK)continue;
      try {
        const size=presentationSize(item);
        if(bytes+size>DISPLAY_BYTE_LIMIT)continue;
        const structure=acceptTransportedDynamicsStructure(request.structure,item.structure,request.movableAtomIds);
        validateMDMetadata(item,request);
        const {displayByteLength: _bytes,...sample}=item;
        frames.push({frame:{...clone({...sample,structure}),physicalTimeFs:item.timeFs,instantTemperatureK:item.temperatureK},bytes:size});
        bytes+=size;lastSeq=item.seq;lastStep=item.step;
      } catch {
        // A rejected display sample has no ownership of the native run.
      }
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
      movableAtomIds: [...request.movableAtomIds], constraints: clone(request.constraints ?? []),
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

  async start(mode: DynamicsOperation, config: DynamicsConfig = {}, capturedSource?:ModelDocument): Promise<void> {
    if (this.disposed) throw new Error('动态控制器已关闭。');
    this.connect();
    if (active(this.state.status)) throw new Error('请先停止当前动态会话。');
    const owner=this.deps.getWorkingSnapshot?.();
    if(capturedSource&&!this.deps.prepareSource)throw Error('当前动态控制器无法接收已确认的模型来源。');
    const operation=this.deps.prepareSource?.(capturedSource);
    const preparation=operation?{cancelled:false}:undefined;
    this.preparing=preparation;
    if(preparation)this.update({status:'starting',mode,sessionId:undefined,lastFrame:undefined,displayFrame:undefined,error:undefined,resultAdoption:undefined});
    try{await this.startRun(mode,config,owner,operation,preparation);}
    catch(cause){
      if(preparation?.cancelled)return;
      if(preparation&&this.preparing===preparation){
        this.request=undefined;this.expectedStamp=undefined;
        this.update({status:'idle'});
        const error=cause instanceof Error?cause:new Error(String(cause));
        this.settleWaiters(error);this.settleStarted(error);
      }
      throw cause;
    }finally{if(this.preparing===preparation)this.preparing=undefined;}
  }

  private async startRun(mode:DynamicsOperation,config:DynamicsConfig,owner?:ModelDocument,operation?:ScientificModelOperation,preparation?:{cancelled:boolean}):Promise<void> {
    if (this.state.termination?.status === 'pending') await this.waitForTermination();
    if(preparation?.cancelled)return;
    this.terminationTask = undefined; this.update({ terminalFailure: undefined, termination: undefined });
    const temperatureK = config.temperatureK ?? 300, maxSteps = config.maxSteps ?? 100000;
    validateDynamicsConfig(mode, temperatureK, maxSteps);
    const pendingGeneration = this.generation;
    const capabilities = await this.port.capabilities(); this.update({ capabilities });
    if(preparation?.cancelled)return;
    if (this.disposed) throw new Error('动态控制器已关闭。');
    if (pendingGeneration !== this.generation) throw new Error('启动期间模型或窗口已变化，动态请求已取消。');
    if (!capabilities.available) throw new Error(capabilities.reason || '动态引擎不可用。');
    if (!preparation&&active(this.state.status)) throw new Error('当前动态会话已启动。');
    if(operation&&!operation.isCurrent())throw new Error('启动期间模型或来源已变化，动态请求已取消。');
    const document = operation?.source??this.deps.getSnapshot(), structure = document.draft.structure;
    const constraints = effectiveModelCoordinates(document);
    validateDynamicsAdmission(structure, mode, { ...config, method: config.method ?? 'gfn2', constraints, attachmentPorts: document.attachmentPorts });
    if (!structure.atoms.length) throw new Error('动态整理需要非空显式原子结构。');
    if (document.attachmentPorts?.length) throw new Error('当前模型含未完成的悬空端口，属于编辑状态；完成连接或移除端口后才能运行真实MD。');
    const method = config.method ?? 'gfn2', periodicMD=isPeriodic(structure);
    if(temperatureK<=0) throw new Error('MD需要大于0 K的目标温度。');
    const ase = config.integrator === 'ase';
    const documentMovable = getMovableAtomIds(document, 'all');
    const editorMovable = ase ? documentMovable : config.movableAtomIds ?? documentMovable;
    const hydrogen = config.integrator ? mdHydrogenSettings(method, config.shakeHydrogenBonds) : undefined;
    if(config.solvation&&(config.solvation.model!=='alpb'||!supportsXtbAlpb(method,config.solvation.solvent,periodicMD)))throw new Error('所选MD方法或周期条件不支持此溶剂，请明确改选。');
    if((ase||!periodicMD)&&constraints.some(row=>row.action!=='freeze'||!ase&&row.images?.some(image=>image.some(Boolean))))throw new Error(ase?'ASE MD可应用B/A/D冻结。请先停用内坐标扫描。':'原生MD只应用非周期B/A/D保护，不能执行内坐标扫描。');
    const runConstraints=ase||!periodicMD?constraints.map(row=>resolveMDConstraint(structure,row)):[];
    const protectedAtomIds = periodicMD||ase?[]:structure.atoms.map(atom=>atom.id!).filter(id=>!editorMovable.includes(id));
    if (protectedAtomIds.length === 1) throw new Error('相对距离保护至少需要两个原子。');
    const movableAtomIds = ase ? editorMovable : structure.atoms.map(atom=>atom.id!);
    if (!movableAtomIds.length) throw new Error('没有可动原子。');
    const allowedMovable = new Set(documentMovable);
    if (editorMovable.some(id => !allowedMovable.has(id))) throw new Error('动态可动原子包含冻结或不存在的原子。');
    validateDynamicsStructure(structure, structure, movableAtomIds);
    this.nativeMDPolicy = ase ? undefined : {kind:'native-gfn-md',method,dtFs:2,protectedAtomIds:[...protectedAtomIds],forceConstantKJMolNm2:500000,
      ...hydrogen,...(periodicMD?{periodic:true as const}:{}),...(runConstraints.length?{internalConstraintMode:'native-harmonic' as const}:{})};
    const stamp = this.deps.getStamp(movableAtomIds,this.nativeMDPolicy,operation), sessionId = `${this.windowId}-${crypto.randomUUID()}`;
    const seed = method==='gxtb'?undefined:config.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] % 2**31;
    if(seed!==undefined&&(!Number.isSafeInteger(seed)||seed<0||seed>2147483647))throw new Error('MD的种子必须在0–2147483647之间。');
    this.request = { stamp, operation: mode, structure: clone(structure), movableAtomIds: [...movableAtomIds],
      constraints: clone(runConstraints),
      maxSteps, ...(config.maxWallTimeSeconds === undefined ? {} : {maxWallTimeSeconds: config.maxWallTimeSeconds}),
      method, ...(config.integrator?{integrator:config.integrator,...hydrogen}:{}), ...(!ase?{protectedAtomIds}:{}), ...(config.solvation ? { solvation: clone(config.solvation) } : {}),
      untilStopped: true, dtFs: 2, reportEvery: 10, temperatureK, seed };
    this.expectedStamp=clone(stamp);this.nextSeq=-1;this.coordinatesAccepted=false;this.terminationTask=undefined;this.startIssued=false;
    this.begin();this.preparing=undefined;
    const generation = ++this.generation;
    this.clearDisplayQueue();
    this.workingSourceDocument=document;
    this.workingOwnerDocument=owner??document;
    this.update({ status: 'starting', mode, sessionId, referenceStructure: clone(structure), workingSource:{documentId:this.workingOwnerDocument.id,revision:this.workingOwnerDocument.revision}, lastFrame: undefined,displayFrame:undefined, error: undefined, terminalFailure: undefined, termination: undefined, resultAdoption:undefined,seed });
    if(this.request===undefined||generation!==this.generation)return;
    try { this.startIssued=true;await this.port.start(this.request, sessionId); }
    catch (cause) {
      if(generation===this.generation&&this.state.status==='stopping'&&String(cause).includes('DYNAMICS_CANCELLED:')){this.complete('stopped');return;}
      if (generation === this.generation) this.fail(cause, { origin: 'transport', code: 'transport-start-failed' }); throw cause;
    }
  }

  async command(command: DynamicsUICommand): Promise<void> {
    if(command.type==='stop'&&this.preparing){
      this.preparing.cancelled=true;this.preparing=undefined;this.update({status:'stopped'});
      const error=new Error('动态会话已停止。');this.settleWaiters(error);this.settleStarted(error);return;
    }
    if (this.state.mode === 'md' && command.type !== 'stop') throw new Error('MD持续运行直到停止；运行中不能暂停、恢复或修改温度。');
    if (command.type === 'pause' && this.state.status === 'starting') await this.waitForStarted();
    const sessionId = this.state.sessionId;
    if (!sessionId || !this.request || !active(this.state.status)) throw new Error('当前没有活动动态会话。');
    if(command.type==='stop'&&!this.startIssued){this.complete('stopped');return;}
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
    if(this.preparing){this.preparing.cancelled=true;this.preparing=undefined;}
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
      const observation: DynamicsSnapshotObservation | undefined=frame?clone({step:frame.step,timeFs:frame.timeFs,...(frame.energyEV===undefined?{}:{energyEV:frame.energyEV}),...(frame.temperatureK===undefined?{}:{temperatureK:frame.temperatureK}),...(frame.targetTemperatureK===undefined?{}:{targetTemperatureK:frame.targetTemperatureK}),...(frame.forcefield===undefined?{}:{forcefield:frame.forcefield}),...(frame.nativeMD===undefined?{}:{nativeMD:frame.nativeMD}),...(frame.aseMD===undefined?{}:{aseMD:frame.aseMD}),...(frame.engine===undefined?{}:{engine:frame.engine}),...(frame.engineVersion===undefined?{}:{engineVersion:frame.engineVersion}),...(frame.aseVersion===undefined?{}:{aseVersion:frame.aseVersion})}):undefined;
      return { structure:clone(modelDocument.draft.structure),modelDocument,...(observation?{observation}:{}),seq:frame?.seq ?? 0,sessionId:this.state.sessionId,detached:true,workingSource:clone(source) };
    }
    return { structure:clone(working.draft.structure),seq:this.state.lastFrame?.seq ?? 0,sessionId:this.state.sessionId };
  }

  private complete(status:'stopped'|'completed'){
    const sessionId=this.state.sessionId;
    let resultAdoption:DynamicsControllerState['resultAdoption'],error:string|undefined;
    try{resultAdoption=this.finish(true,()=>{
      if(this.state.sessionId===sessionId&&this.state.resultAdoption==='pending')this.update({resultAdoption:'applied'});
    })??undefined;}
    catch(cause){if(!this.deps.prepareSource)throw cause;resultAdoption='retained';error=cause instanceof Error?cause.message:String(cause);}
    this.request=undefined;this.expectedStamp=undefined;
    this.update({status,resultAdoption,error,displayFrame:this.state.mode==='md'?this.state.lastFrame:this.state.displayFrame});
    this.settleWaiters();this.settleStarted(new Error('动态会话已结束。'));
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
      if (event.event === 'completed' && event.reason !== undefined && (event.reason !== 'step-limit' || event.converged !== false)) throw new Error('MD结束原因无效。');
      for (const value of [event.energyEV, event.kineticEnergyEV, event.temperatureK, event.targetTemperatureK]) if (value !== undefined && !Number.isFinite(value)) throw new Error('动态帧能量或温度非有限。');
      if (event.temperatureK !== undefined && event.temperatureK < 0 || event.targetTemperatureK !== undefined && (event.targetTemperatureK < 0 || event.targetTemperatureK > 5000)) throw new Error('动态帧温度无效。');
      const terminalError = event.event === 'error' ? validateDynamicsError(event.error, request.structure) : undefined;
      const displayFrames=this.presentationFrames(event,request);
      this.nextSeq = event.seq;
      if (event.structure) {
        if (this.state.status === 'paused' && event.event === 'frame') throw new Error('暂停期间收到未恢复的动态坐标帧。');
        const structure=acceptTransportedDynamicsStructure(request.structure,event.structure,request.movableAtomIds);
        // Native status/heartbeat events also carry the last validated snapshot.
        // Capture a pause's exact final step before ending its undo transaction.
        const {displayFrames: _displayBatch,displayByteLength: _displayBytes,...scientificEvent}=event;
        const frame = { ...scientificEvent, structure, event: 'frame' } as DynamicsFrame;
        const current = this.deps.getSnapshot().draft.structure;
        const ordered = structure.atoms.length === current.atoms.length && structure.atoms.every((atom, index) => atom.id === current.atoms[index].id);
        const changed = ordered ? structure.atoms.some((atom, index) => {
          const before = current.atoms[index];
          return atom.x !== before.x || atom.y !== before.y || atom.z !== before.z;
        }) : coordinatesFingerprint(structure) !== coordinatesFingerprint(current);
        // A terminal event can repeat the last coordinates but supply the
        // final energy and convergence record for the same accepted run.
        const terminalReceipt=this.deps.prepareSource&&this.coordinatesAccepted&&(event.event==='stopped'||event.event==='completed');
        if (changed||terminalReceipt) {
          if (changed && this.state.status === 'paused' && event.event !== 'resumed') throw new Error('暂停期间动态坐标发生改变。');
          if (!this.transaction) this.begin();
          this.deps.acceptFrame(frame);
          this.coordinatesAccepted = true;
          this.expectedStamp = this.deps.getStamp(request.movableAtomIds,this.nativeMDPolicy);
        }
        const latest={ ...clone(frame), physicalTimeFs: frame.timeFs, instantTemperatureK: frame.temperatureK };
        if(request.operation==='md')this.presentMD({frame:latest,bytes:presentationSize(event,latest)},displayFrames,event.event==='frame');
        else this.update({lastFrame:latest});
      } else if (event.event === 'frame') throw new Error('动态帧缺少结构。');
      if (event.event === 'started' || event.event === 'resumed') { this.update({ status: 'running' }); this.settleStarted(); }
      if (event.event === 'paused') { this.commit(); this.update({ status: 'paused' }); this.settleWaiters(); }
      if (event.event === 'stopped' || event.event === 'completed') {
        if (!event.structure && this.state.lastFrame) this.update({ lastFrame: { ...this.state.lastFrame, ...(event.reason === undefined ? {} : { reason:event.reason }), ...(event.converged === undefined ? {} : { converged:event.converged }) } });
        this.complete(event.event);
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

export function createStoreDynamicsDependencies(store: ModelStore, options?: { isolated: true; captureSource?(): ModelDocument }): DynamicsDependencies {
  if (!options?.isolated) return { getSnapshot: store.getSnapshot, getStamp: (ids,policy) => policy?store.stampNativeMD(policy):store.stamp(ids), hasRuntimeLock: () => store.isRuntimeSessionActive?.() ?? false, beginRun: () => { store.beginRuntimeSession(); store.beginTransaction('dynamics'); }, acceptFrame: frame => { store.acceptRuntimeFrame(frame); }, commitRun: () => store.endTransaction(), finishRun: () => store.finishRuntimeSession() };
  let runStore: ModelStore | undefined, source: ModelDocument | undefined, lastFrame: DynamicsFrame | undefined, operation:ScientificModelOperation|undefined,begun=false;
  return {
    getSnapshot: () => begun && runStore ? runStore.getSnapshot() : store.getSnapshot(),
    getWorkingSnapshot:store.getSnapshot,
    ...(options.captureSource&&store.createScientificOperation?{prepareSource:capturedSource=>store.createScientificOperation!(capturedSource??options.captureSource!())}:{}),
    getStamp: (ids,policy,preparedOperation) => {
      if (!begun) {
        operation=preparedOperation;source=operation?.source??store.getSnapshot();runStore=operation?.store??createRuntimeModelStore(source);
        if(!operation){if(policy)store.stampNativeMD(policy);else store.stamp(ids);}
      }
      return policy?runStore!.stampNativeMD(policy):runStore!.stamp(ids);
    },
    hasRuntimeLock: () => !!store.isRuntimeSessionActive?.() && !store.isRuntimeEditingAllowed?.(),
    allowsWorkingEdits: () => begun && store.isRuntimeEditingAllowed?.() === true,
    beginRun: () => {
      if(operation&&!begun&&(store.hasTransaction?.()||store.isRuntimeSessionActive?.()))throw new Error('请先结束当前模型编辑或优化。');
      if (!runStore) { source = store.getSnapshot(); runStore = createRuntimeModelStore(source); }
      begun = true; store.beginRuntimeSession({ isolated: true });
      runStore.beginRuntimeSession(); runStore.beginTransaction('dynamics');
    },
    acceptFrame: frame => { runStore!.acceptRuntimeFrame(frame); lastFrame = clone(frame); },
    commitRun: () => { runStore?.endTransaction(); },
    finishRun: (adopt,onAccepted) => {
      if(!begun)return;
      try {
        runStore?.endTransaction(); runStore?.finishRuntimeSession();
        if(operation)return adopt&&lastFrame?operation.apply('dynamics',onAccepted):undefined;
        // Exact monotonically increasing revision prevents edit -> Undo from
        // allowing an old run to overwrite the working document again.
        const current = store.getSnapshot();
        if (lastFrame && source && runtimePreviewSourceCurrent(source,current)) {
          store.beginTransaction('dynamics');
          try { store.acceptRuntimeFrame(lastFrame,source); store.endTransaction(); }
          catch (error) { store.cancelTransaction(); throw error; }
        }
      } finally { store.finishRuntimeSession(); runStore = undefined; source = undefined; lastFrame = undefined; operation=undefined;begun=false; }
    },
  };
}
