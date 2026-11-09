import type { BondPerceptionMode, ChemistryJob, ChemistryPort, ChemistryResult, ModelDocument, ModelStore } from '../contracts';
import { effectiveModelConstraints } from '../constraints';
import { bondOrderObservation, periodicBondOrderConnections, validateBondOrderEvidence } from '../bond-orders';
import { DEFAULT_EMPIRICAL_BOND_PARAMETERS, validateEmpiricalBondParameters, type EmpiricalBondPerceptionParameters } from '../../core/bond-perception-parameters';
import { perceivePeriodicConnections } from '../../core/periodic';
import type { XtbBondOrders, XtbBridge, XtbCoordinateResult, XtbEvent, XtbMetadata, XtbMethod, XtbRequest, XtbPreviewFrame, XtbOptimizationScope } from './contracts';
import { XTB_METHOD_LABELS } from './contracts';
import { applyXtbCoordinates, applyXtbStoppedCoordinates, validateXtbPeriodicity } from './accept-result';
import {coordinatesFingerprint} from '../../core/modeling/graph';
import { empiricalBondAdmission } from '../empirical-bond-admission';
import {runtimePreviewSourceCurrent} from '../../core/modeling/runtime-source-lineage';

export interface XtbOptions { method: XtbMethod; charge: number; multiplicity: number; rebuildBonds: boolean; threads?: number; maxSteps?: number; maxSccIterations?: number; scope?: XtbOptimizationScope; empiricalBondParameters?:EmpiricalBondPerceptionParameters }
/** Capture a variable set only; the native calculation retains the complete
 * molecule and its electronic state. Scope never changes persistent freezes. */
export function xtbOptimizationMovableAtomIds(document:ModelDocument,scope:XtbOptimizationScope='all'):string[]{
  if(!['all','selection','unselected'].includes(scope))throw new Error('未知xTB优化范围。');
  const fixed=new Set(effectiveModelConstraints(document).frozenAtomIds),selected=new Set(document.selection.atomIds);
  return document.draft.structure.atoms.flatMap(atom=>!fixed.has(atom.id!)&&(scope==='all'||(scope==='selection'?selected.has(atom.id!):!selected.has(atom.id!)))?[atom.id!]:[]);
}
export interface XtbState { running: boolean; phase: 'idle' | 'optimizing' | 'playing' | 'bonding' | 'stopping'; operation?:'optimize'|'singlepoint'|'perceive-bonds'; status: string; error: string; metadata?: XtbMetadata; previewFrame?: XtbPreviewFrame; previewSkippedFrames?: number; retainedResult?: XtbCoordinateResult; retainedStoppedFrame?: XtbPreviewFrame; retainedBondResult?: ChemistryResult; canContinue?:boolean; sourceChain?:string[]; trajectoryFrames?:XtbPreviewFrame[]; workingSource?: { documentId: string; revision: number } }
export interface XtbControllerDependencies {
  store: ModelStore; bridge: Partial<XtbBridge> | null; chemistry: ChemistryPort;
  /** Enabled only where the working viewport is isolated from task previews. */
  allowWorkingEdits?: true;
  confirmConstraints(): boolean;
  assertCurrent(): void;
}
const initialState = (): XtbState => ({ running: false, phase: 'idle', status: '', error: '' });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const XTB_PLAYBACK_INTERVAL_MS = 16;
export const XTB_PLAYBACK_MAX_TAIL_MS = 750;
export const XTB_PLAYBACK_MAX_QUEUED_FRAMES = 48;
export const XTB_PLAYBACK_MAX_QUEUED_COORDINATES = 24000;
interface Playback {
  sessionId: string; request: XtbRequest; queue: XtbPreviewFrame[];
  timer?: ReturnType<typeof setTimeout>; lastStep: number; completed: boolean;
  resolve?: () => void; reject?: (error: Error) => void;
}

/** Frame validation does not apply coordinates or require optimizer convergence. */
function validatePreviewFrame(event: XtbEvent, request: XtbRequest, lastStep: number): XtbPreviewFrame {
  if (request.calculation === 'singlepoint' || event.stepKind !== (request.structure.cell?'outer-optimizer-iteration':'native-log-frame') || !Number.isSafeInteger(event.step) || event.step! < 0 || event.step! <= lastStep || !Array.isArray(event.coordinates) || event.coordinates.length !== request.structure.atoms.length) throw new Error('xTB原生帧类型、序号或原子数量无效。');
  validateXtbPeriodicity(request,event.periodic);
  const fixed = new Set(request.frozenAtomIds);
  event.coordinates.forEach((point, index) => {
    const original = request.structure.atoms[index];
    if (!point || point.id !== original.id || point.element !== original.element || ![point.x,point.y,point.z].every(value => Number.isFinite(value) && Math.abs(value) <= 1e6)) throw new Error('xTB原生帧身份、顺序或坐标无效。');
    if (fixed.has(point.id) && ![point.x,point.y,point.z].every((value, axis) => Object.is(value, original[(['x','y','z'] as const)[axis]]))) throw new Error('xTB原生帧改变了冻结原子坐标。');
  });
  return { sessionId:event.sessionId, stamp:structuredClone(event.stamp), seq:event.seq, step:event.step!, stepKind:event.stepKind, coordinates:structuredClone(event.coordinates),...(event.periodic?{periodic:structuredClone(event.periodic)}:{}) };
}

/** A single document-owned operation: real xTB result, then optional existing bond perception. */
export class XtbController {
  private state = initialState();
  private listeners = new Set<() => void>();
  private sessionId?: string;
  private cancelRequested = false;
  private chemistryJob?: ChemistryJob;
  private gone = false;
  private unsubscribe?: () => void;
  private rejectPending?: (error: Error) => void;
  private playback?: Playback;
  private lastReliableFrame?:XtbPreviewFrame;
  private nativeClosed=false;
  private continuation?:{options:XtbOptions; fingerprint:string; documentId:string};
  private continuing=false;
  async continueOptimization(maxSteps?:number,maxSccIterations?:number){
    const pending=this.continuation,document=this.deps.store.getSnapshot();
    if(!pending||this.state.running||document.id!==pending.documentId||coordinatesFingerprint(document.draft.structure)!==pending.fingerprint)throw Error('继续优化的结构已变化，请重新启动优化。');
    this.continuing=true;await this.run({...pending.options,...(maxSteps===undefined?{}:{maxSteps}),...(maxSccIterations===undefined?{}:{maxSccIterations})});
  }
  private rememberContinuation(options:XtbOptions){
    const document=this.deps.store.getSnapshot();
    this.continuation={options:structuredClone(options),fingerprint:coordinatesFingerprint(document.draft.structure),documentId:document.id};
    this.update({canContinue:true});
  }
  private runSettled?:Promise<void>;
  private stopTask?:Promise<unknown>;
  private sourceDocument?: ModelDocument;
  private perceptionDetached = false;
  getWorkingSourceDocument=()=>this.sourceDocument;
  private previewSourceStillCurrent(){return runtimePreviewSourceCurrent(this.sourceDocument,this.deps.store.getSnapshot())&&this.runtimeOwnerCurrent();}
  private runtimeOwnerCurrent(){try{this.deps.assertCurrent();return true;}catch{return false;}}
  private sourceStillCurrent() { const now=this.deps.store.getSnapshot(),source=this.sourceDocument;if(!source||now.id!==source.id||now.revision!==source.revision||now.analysisBindingId!==source.analysisBindingId)return false;try{this.deps.assertCurrent();return true;}catch{return false;} }
  private stopAcknowledgement():Promise<unknown>|undefined{return this.stopTask;}
  constructor(private readonly deps: XtbControllerDependencies) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<XtbState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  connect() { this.gone = false; }
  disconnect() { this.gone = true; void this.stop().catch(()=>{}); this.rejectPending?.(new Error('xTB运行视图已关闭。')); }
  async stop() {
    if (!this.state.running) return;
    if(this.state.phase==='stopping'){await this.runSettled;return;}
    const previousPhase=this.state.phase;
    this.cancelRequested = true; this.update({ phase: 'stopping', status: '正在停止xTB…' });
    const stopped = new Error('已停止xTB。');
    this.clearPlayback(stopped,true);
    this.chemistryJob?.cancel();
    if (this.sessionId) {
      let failed=false;
      this.stopTask=Promise.resolve(this.deps.bridge?.commandXtb?.(this.sessionId, { command: 'stop' })).catch(error=>{if(!this.nativeClosed){failed=true;this.update({phase:previousPhase,status:'停止请求失败，后台尚未确认停止。',error:error instanceof Error?error.message:String(error)});}});
      await this.stopTask;
      if(failed)return;
    }
    await this.runSettled;
  }
  private retainStoppedFrame(request:XtbRequest):boolean{
    if(this.gone)throw new Error('xTB运行视图已关闭，停止帧未应用。');
    const {store}=this.deps,frame=this.lastReliableFrame;
    if(!frame){this.update({status:'已停止xTB，尚无可靠结构帧，保留原结构。',error:''});return false;}
    if(!this.previewSourceStillCurrent()){this.update({status:'已停止xTB，最后可靠结构保留为原任务候选。',error:'',retainedStoppedFrame:structuredClone(frame)});return false;}
    const result={request,frame},current=store.getSnapshot();
    const movable=request.structure.atoms.map(atom=>atom.id!).filter(id=>!request.frozenAtomIds.includes(id));
    const next=applyXtbStoppedCoordinates(this.sourceDocument??current,result,movable);
    if(coordinatesFingerprint(next.draft.structure)===coordinatesFingerprint(current.draft.structure)){this.update({status:'已停止xTB，最后可靠结构未变化。',error:''});return false;}
    store.acceptXtbStoppedCoordinates(result,this.sourceDocument);this.update({status:'已停止xTB，保留最后可靠结构。',error:'',metadata:undefined});return true;
  }
  private clearPlayback(error?: Error, retainPreview = false) {
    const playback=this.playback;this.playback=undefined;
    if(playback?.timer!==undefined)clearTimeout(playback.timer);
    if(playback){playback.queue=[];if(error)playback.reject?.(error);}
    if(!retainPreview&&this.state.previewFrame)this.update({previewFrame:undefined});
  }
  private thinPlayback(playback: Playback, maximum: number) {
    const queue=playback.queue;if(queue.length<=maximum)return;
    playback.queue=Array.from({length:maximum},(_,index)=>queue[Math.floor(index*(queue.length-1)/(maximum-1))]);
    this.update({previewSkippedFrames:(this.state.previewSkippedFrames??0)+queue.length-maximum});
  }
  private assertPlaybackCurrent(playback: Playback) {
    const current=this.deps.store.getSnapshot();
    if(this.cancelRequested||this.gone)throw new Error('xTB预览已取消。');
    return current.id===playback.request.stamp.documentId&&this.previewSourceStillCurrent();
  }
  private schedulePlayback(playback: Playback) {
    if(this.playback!==playback||playback.timer!==undefined)return;
    playback.timer=setTimeout(()=>{
      playback.timer=undefined;if(this.playback!==playback)return;
      try {
        if(!this.assertPlaybackCurrent(playback)){playback.resolve?.();this.clearPlayback();return;}
        const frame=playback.queue.shift();
        if(frame)this.update({previewFrame:frame,...(!playback.completed?{status:`${XTB_METHOD_LABELS[playback.request.method]}正在优化 · 原生帧${frame.step}`}:{})});
        else if(playback.completed){playback.resolve?.();playback.resolve=undefined;playback.reject=undefined;return;}
        this.schedulePlayback(playback);
      }catch(error){const failure=error instanceof Error?error:new Error(String(error));this.cancelRequested=true;this.clearPlayback(failure);this.rejectPending?.(failure);}
    },XTB_PLAYBACK_INTERVAL_MS);
  }
  private enqueuePreview(frame: XtbPreviewFrame, request: XtbRequest) {
    if(!this.previewSourceStillCurrent()){this.clearPlayback();return;}
    const playback=this.playback??{sessionId:frame.sessionId,request,queue:[],lastStep:-1,completed:false};
    if(playback.sessionId!==frame.sessionId)throw new Error('xTB播放会话已改变。');
    this.playback=playback;playback.lastStep=frame.step;playback.queue.push(frame);
    const maximum=Math.min(XTB_PLAYBACK_MAX_QUEUED_FRAMES,Math.floor(XTB_PLAYBACK_MAX_QUEUED_COORDINATES/request.structure.atoms.length));
    if(maximum<2)throw new Error('xTB预览原子数量超过有界播放内存。');
    this.thinPlayback(playback,maximum);this.schedulePlayback(playback);
  }
  private finishPlayback(): Promise<void> {
    const playback=this.playback!;playback.completed=true;
    // Reserve a presentation interval for the final real frame. This is a UI
    // delay budget only, never native iteration duration or physical time.
    this.thinPlayback(playback,Math.floor(XTB_PLAYBACK_MAX_TAIL_MS/XTB_PLAYBACK_INTERVAL_MS)-1);
    const drained=new Promise<void>((resolve,reject)=>{playback.resolve=resolve;playback.reject=reject;});
    this.update({phase:'playing',status:'优化已完成，正在播放迭代过程…'});this.schedulePlayback(playback);
    return drained;
  }
  private async perceiveCurrent(mode: BondPerceptionMode, electronic?: {charge:number;multiplicity:number}, evidence?: XtbBondOrders, parameters:EmpiricalBondPerceptionParameters=DEFAULT_EMPIRICAL_BOND_PARAMETERS, candidate?:ModelDocument): Promise<ChemistryResult> {
    const {store}=this.deps,current=store.getSnapshot(),structure=structuredClone((candidate??current).draft.structure),fixed=new Set(effectiveModelConstraints(current).frozenAtomIds),ids=structure.atoms.map(atom=>atom.id!).filter(id=>!fixed.has(id));
    if(electronic){structure.charge=electronic.charge;structure.multiplicity=electronic.multiplicity;}
    if(evidence)validateBondOrderEvidence(evidence,structure);
    const stamp=store.stamp(ids);
    this.perceptionDetached=false;
    this.update({workingSource:{documentId:current.id,revision:current.revision},retainedBondResult:undefined});
    store.beginRuntimeSession(this.deps.allowWorkingEdits?{isolated:true}:undefined);
    try{
      this.chemistryJob=this.deps.chemistry.start({stamp,operation:'perceive-bonds',structure,movableAtomIds:ids,aggression:'standard',bondPerceptionPolicy:'composite-v1',...(evidence?{bondOrderEvidence:structuredClone(evidence)}:{empiricalBondParameters:validateEmpiricalBondParameters(parameters)})});
      const result=await this.chemistryJob.promise;
      if(!this.deps.allowWorkingEdits)this.deps.assertCurrent();
      if(this.cancelRequested||this.gone)throw new Error('成键判断已停止，原连接未替换。');
      const summary=result.bondPerceptionSummary;
      if(result.operation!=='perceive-bonds'||result.bondPerceptionPolicy!=='composite-v1'||!same(result.stamp,stamp)||!same(result.structure.atoms,structure.atoms)||result.structure.charge!==structure.charge||result.structure.multiplicity!==structure.multiplicity||!Array.isArray(result.structure.bonds)||!summary||summary.method!==(evidence?'gfn2-assisted':'empirical')||summary.bondCount!==result.structure.bonds.length||summary.coordinationCount!==result.structure.bonds.filter(bond=>bond.kind==='coordination').length||summary.evidenceCount!==(evidence?.entries.length??0)||!['bondCount','coordinationCount','evidenceCount','conflictCount','rdkitComponentCount','fallbackComponentCount'].every(key=>Number.isSafeInteger(summary[key as keyof typeof summary])&&Number(summary[key as keyof typeof summary])>=0))throw new Error('综合成键结果身份、原子内容或方法回执不匹配。');
      store.finishRuntimeSession();
      const latest=store.getSnapshot();let active=true;try{this.deps.assertCurrent();}catch{active=false;}
      if(this.deps.allowWorkingEdits&&(!active||latest.id!==current.id||latest.revision!==current.revision)){
        this.perceptionDetached=true;this.update({retainedBondResult:structuredClone(result),status:'成键任务完成；工作结构已修改，结果保留在原任务。'});return result;
      }
      // Preoptimization prepares against the accepted candidate before either
      // coordinates or graph are written. The caller commits both together.
      if(candidate)return result;
      if(this.deps.allowWorkingEdits)store.beginTransaction('成键判断');
      try{store.execute({type:'infer-bonds',mode,aggression:'standard',perceivedBonds:result.structure.bonds,perceivedIssues:result.structure.bondPerceptionIssues,stamp:result.stamp});if(this.deps.allowWorkingEdits)store.endTransaction();}
      catch(error){if(this.deps.allowWorkingEdits)store.cancelTransaction();throw error;}
      return result;
    }finally{store.finishRuntimeSession();this.chemistryJob=undefined;}
  }
  async perceiveEmpirical(electronic?: {charge:number;multiplicity:number}, mode:BondPerceptionMode='rebuild', parameters:EmpiricalBondPerceptionParameters=DEFAULT_EMPIRICAL_BOND_PARAMETERS){
    const validated=validateEmpiricalBondParameters(parameters);
    const {store}=this.deps;
    if(this.state.running||store.hasTransaction?.()||store.isRuntimeSessionActive?.())throw new Error('请先结束当前编辑或优化。');
    this.deps.assertCurrent();
    const structure=store.getSnapshot().draft.structure;
    const admission = empiricalBondAdmission(structure); if (admission) throw new Error(admission);
    this.cancelRequested=false;this.update({running:true,phase:'bonding',operation:'perceive-bonds',status:'正在按经验判断成键…',error:'',metadata:undefined});
    const transaction=!this.deps.allowWorkingEdits||!!structure.cell?.pbc.some(Boolean);
    if(transaction)store.beginTransaction('经验判断成键');let accepted=false;
    try{if(structure.cell?.pbc.some(Boolean)){const result=perceivePeriodicConnections({...structure,bonds:[]},{parameters:validated,preserveExisting:false,allowUnconfirmedPreview:true});store.execute({type:'infer-bonds',mode,aggression:'standard',perceivedBonds:result.bonds,perceivedIssues:result.issues});accepted=true;this.update({status:structure.cell.pbcProvenance?.kind==='unconfirmed'?'已按来源候选周期轴生成连接预览。':'周期经验成键完成。'});}else{const result=await this.perceiveCurrent(mode,electronic,undefined,validated);accepted=true;this.update({status:result.structure.bondPerceptionIssues?.length?'局部连接待确认，其余区域已完成识别。':'经验成键完成。'});}}
    catch(error){this.update({status:'',error:error instanceof Error?error.message:String(error)});}
    finally{store.finishRuntimeSession();if(transaction){if(accepted)store.endTransaction();else store.cancelTransaction();}if(this.perceptionDetached)this.update({status:'成键任务完成；工作结构已修改，结果保留在原任务。'});this.update({running:false,phase:'idle'});}
  }
  async run(options: XtbOptions, calculation:'optimize'|'singlepoint'='optimize', perceptionMode:BondPerceptionMode='rebuild') {
    if (this.state.running) throw new Error('当前xTB任务尚未结束。');
    const { store, bridge } = this.deps;
    if (!bridge?.startXtb || !bridge.commandXtb || !bridge.onXtbEvent) throw new Error('当前环境没有随包xTB运行入口。');
    this.deps.assertCurrent();
    if (store.hasTransaction?.()||store.isRuntimeSessionActive?.()) throw new Error('请先结束当前模型编辑或优化。');
    const singlepoint=calculation==='singlepoint';
    if(options.empiricalBondParameters)validateEmpiricalBondParameters(options.empiricalBondParameters);
    if(singlepoint&&options.method!=='gfn2')throw new Error('辅助成键使用GFN2-xTB。');
    const document = store.getSnapshot(), structure = structuredClone(document.draft.structure);
    if (structure.dimension !== 3 || !structure.atoms.length || structure.periodicSource?.completeness==='partial') throw new Error('xTB预优化需要三维结构及完整晶胞。');
    const periodic=Boolean(structure.cell);
    const constraints = effectiveModelConstraints(document);
    if(periodic&&!singlepoint&&constraints.coordinates.length)throw new Error('周期内坐标冻结尚未验证，请明确调整本次约束后运行；原子冻结仍受支持。');
    if (!singlepoint&&constraints.coordinates.some(row => row.action !== 'freeze')) throw new Error('xTB预优化不执行内坐标扫描。');
    if (!singlepoint&&constraints.coordinates.length && !this.deps.confirmConstraints()) return;
    this.deps.assertCurrent();
    if(store.getSnapshot().id!==document.id||store.getSnapshot().revision!==document.revision)throw new Error('模型或选区已变化，请重新优化。');
    const movable = xtbOptimizationMovableAtomIds(document,singlepoint?'all':options.scope??'all'),movableSet=new Set(movable);
    const frozen = structure.atoms.map(atom=>atom.id!).filter(id=>!movableSet.has(id));
    if (!movable.length&&!singlepoint) throw new Error('当前优化范围没有可动原子；请检查选区及已有冻结。');
    const stamp = store.stamp(movable);
    this.sourceDocument = document;
    const request: XtbRequest = { stamp, structure, method: options.method, calculation, charge: options.charge,
      ...(options.method === 'gfnff' ? {} : { uhf: options.multiplicity - 1 }),
      frozenAtomIds: frozen, constraints: singlepoint?[]:structuredClone(constraints.coordinates),
      internalConstraintsConfirmed: !singlepoint&&constraints.coordinates.length > 0, maxSteps: options.maxSteps ?? 500, maxSccIterations: options.maxSccIterations ?? 250 };
    this.clearPlayback(); this.cancelRequested = false;this.lastReliableFrame=undefined;this.nativeClosed=false;this.stopTask=undefined;
    this.sessionId = crypto.randomUUID();
    const sessionId = this.sessionId;
    const sourceChain=this.continuing?[...(this.state.sourceChain??[]),sessionId]:[sessionId];this.continuing=false;this.continuation=undefined;
    this.update({canContinue:false,sourceChain,trajectoryFrames:sourceChain.length>1?this.state.trajectoryFrames??[]:[]});
    let settleRun!:()=>void;this.runSettled=new Promise<void>(resolve=>{settleRun=resolve;});
    this.update({ running: true, phase: 'optimizing', operation:calculation, workingSource:{documentId:document.id,revision:document.revision}, error: '', status: singlepoint?'GFN2-xTB正在计算MBO…':`${XTB_METHOD_LABELS[options.method]}正在优化…`, metadata: undefined, previewFrame:undefined, previewSkippedFrames:0, retainedResult:undefined, retainedStoppedFrame:undefined });
    let transaction = false, accepted = false, lastSequence = -1;
    try {
      if(!periodic)store.clearBondOrders();
      if(this.deps.allowWorkingEdits)store.beginRuntimeSession({isolated:true});
      else { store.beginTransaction(singlepoint?'GFN2辅助判断成键':'xTB预优化');transaction=true;store.beginRuntimeSession(); }
      const result = await new Promise<XtbCoordinateResult|{stopped:true}>((resolve, reject) => {
        this.rejectPending = reject;
        this.unsubscribe = bridge.onXtbEvent!((event: XtbEvent) => {
          if (event.sessionId !== sessionId) return;
          if (this.gone || this.cancelRequested&&!['stopped','completed','error'].includes(event.event)) return;
          try {
            if (event.schema !== 1 || event.operation !== (singlepoint?'xtb-singlepoint':'xtb-optimize') || event.method !== request.method || !same(event.stamp, stamp) || !Number.isSafeInteger(event.seq) || event.seq <= lastSequence) throw new Error('xTB事件身份或顺序不匹配。');
            if (!['started','progress','frame','completed','stopped','error'].includes(event.event)) throw new Error('xTB事件类型无效。');
            lastSequence = event.seq;
            if (event.event === 'frame') {
              const frame=validatePreviewFrame(event,request,this.lastReliableFrame?.step??-1);this.lastReliableFrame=frame;this.update({trajectoryFrames:[...(this.state.trajectoryFrames??[]),structuredClone(frame)]});this.enqueuePreview(frame,request);
            }
            if (event.event === 'progress' && !this.cancelRequested) this.update({ status: event.status?`${XTB_METHOD_LABELS[options.method]} · ${event.status}`:singlepoint?'GFN2-xTB正在计算MBO…':`${XTB_METHOD_LABELS[options.method]}正在优化${event.step === undefined ? '…' : ` · ${event.step}步`}` });
            if (event.event === 'error') {
              if(event.exit&&(event.exit.code===null||Number.isSafeInteger(event.exit.code))&&(event.exit.signal===null||typeof event.exit.signal==='string'))this.nativeClosed=true;
              if(event.coordinates){const final=validatePreviewFrame(event,request,-1);if(!this.lastReliableFrame||final.step>=this.lastReliableFrame.step){if(!this.lastReliableFrame||final.step>this.lastReliableFrame.step)this.update({trajectoryFrames:[...(this.state.trajectoryFrames??[]),structuredClone(final)]});this.lastReliableFrame=final;}}
              reject(new Error(event.error?.code==='XTB_STEP_LIMIT'||event.error?.code==='XTB_PERIODIC_STEP_LIMIT'?`本轮已达${request.maxSteps}步，尚未收敛；可从最后有效结构继续优化。`:event.error?.message || 'xTB运行失败。'));
            }
            if (event.event === 'stopped') {
              if(!event.exit||!(event.exit.code===null||Number.isSafeInteger(event.exit.code))||!(event.exit.signal===null||typeof event.exit.signal==='string'))throw new Error('xTB停止缺少原生退出确认。');
              if(event.coordinates){const final=validatePreviewFrame(event,request,-1);if(this.lastReliableFrame&&final.step<this.lastReliableFrame.step)throw new Error('xTB停止帧顺序回退。');if(!this.lastReliableFrame||final.step>this.lastReliableFrame.step)this.update({trajectoryFrames:[...(this.state.trajectoryFrames??[]),structuredClone(final)]});this.lastReliableFrame=final;}
              this.nativeClosed=true;this.cancelRequested=true;resolve({stopped:true});
            }
            if (event.event === 'completed') {
              if (!event.coordinates || !event.metadata || event.exit?.code !== 0 || event.exit.signal !== null) throw new Error('xTB缺少真实成功结果。');
              const completed={request,coordinates:structuredClone(event.coordinates),metadata:structuredClone(event.metadata)};
              // Validate the strict final result before any tail playback. The
              // pure helper does not publish into the authoritative Store.
              if(singlepoint)bondOrderObservation(completed,document.draft.structure,sessionId);
              else applyXtbCoordinates(document,completed,movable);
              this.nativeClosed=true;resolve(this.cancelRequested?{stopped:true}:completed);
            }
          } catch (error) { const failure=error instanceof Error?error:new Error(String(error));this.cancelRequested=true;this.clearPlayback(failure);reject(failure); }
        });
        void bridge.startXtb!(request, sessionId).catch(reject);
      });
      this.unsubscribe?.(); this.unsubscribe = undefined; this.rejectPending = undefined; this.sessionId = undefined;
      if('stopped' in result){store.finishRuntimeSession();if(!singlepoint){accepted=this.retainStoppedFrame(request);if(accepted||this.lastReliableFrame&&this.sourceStillCurrent())this.rememberContinuation(options);}else this.update({status:'已停止GFN2-xTB，原结构未更改。',error:''});return;}
      if(result.metadata.trajectoryWarning)this.clearPlayback(undefined,true);
      else if(this.playback)await this.finishPlayback();
      if (this.cancelRequested || this.gone) throw new Error('xTB结果已取消，未应用坐标。');
      store.finishRuntimeSession();
      if(!(singlepoint?this.sourceStillCurrent():this.previewSourceStillCurrent())){this.update({metadata:result.metadata,retainedResult:structuredClone(result),status:'xTB任务完成；工作结构已修改，结果保留在原任务。'});return;}
      let optimizedBonds:ChemistryResult|undefined,bondFailure:string|undefined;
      if(!singlepoint&&!periodic&&options.rebuildBonds&&options.method!=='gfnff'){
        this.update({phase:'bonding',status:options.method==='gfn2'?'正在按本次MBO更新成键…':'正在按本次优化坐标进行经验判键…'});
        try{
          const evidence=options.method==='gfn2'?result.metadata.bondOrders:undefined;
          if(options.method==='gfn2'&&!evidence)throw new Error(result.metadata.bondOrdersWarning?.message??'本次GFN2结果没有可用MBO。');
          const candidate=applyXtbCoordinates(this.sourceDocument??store.getSnapshot(),result,movable);
          optimizedBonds=await this.perceiveCurrent('rebuild',{charge:options.charge,multiplicity:options.multiplicity},evidence,options.empiricalBondParameters,candidate);
        }catch(error){bondFailure=error instanceof Error?error.message:String(error);}
        if(this.cancelRequested||this.gone)throw new Error('成键判断已停止，未提交本次结果。');
        if(this.perceptionDetached||!this.previewSourceStillCurrent()){this.update({metadata:result.metadata,retainedResult:structuredClone(result),status:'xTB及成键任务完成；工作结构已修改，结果保留在原任务。'});return;}
      }
      if(!transaction){store.beginTransaction(singlepoint?'GFN2辅助判断成键':'xTB预优化');transaction=true;}
      if(singlepoint){
        if(!same(stamp,store.stamp(movable)))throw new Error('MBO结果已不属于当前模型。');
        bondOrderObservation(result,store.getSnapshot().draft.structure,sessionId);
        if(periodic&&structure.cell!.pbc.some(Boolean)&&structure.cell!.pbcProvenance?.kind!=='unconfirmed'){
          const perceived=periodicBondOrderConnections(structure,result.metadata.bondOrders!,options.empiricalBondParameters);
          store.execute({type:'infer-bonds',mode:perceptionMode,aggression:'standard',perceivedBonds:perceived.bonds,perceivedIssues:perceived.issues});
        }
      }else {
        store.acceptXtbCoordinates(result,this.sourceDocument);
        if(optimizedBonds)store.execute({type:'infer-bonds',mode:'rebuild',aggression:'standard',perceivedBonds:optimizedBonds.structure.bonds,perceivedIssues:optimizedBonds.structure.bondPerceptionIssues});
      }
      accepted = true;
      if(this.deps.allowWorkingEdits&&transaction){store.endTransaction();transaction=false;}
      // Keep the final shown native frame until the authoritative final result
      // has committed; do not notify a transient return to the original model.
      this.clearPlayback();
      this.update({ metadata: result.metadata, status: singlepoint?'GFN2-xTB单点完成。':`${XTB_METHOD_LABELS[options.method]}优化完成。` });
      if(singlepoint&&periodic&&(!structure.cell!.pbc.some(Boolean)||structure.cell!.pbcProvenance?.kind==='unconfirmed'))this.update({status:structure.cell!.pbc.some(Boolean)?'原子对键级已保留；周期轴未确认，未用于连接。':'原子对键级已保留；当前模型无周期轴，未用于连接。'});
      if (!periodic&&options.method === 'gfn2' && singlepoint) {
        this.update({ phase: 'bonding', status: singlepoint?'正在综合判断成键…':'xTB优化完成，正在重新判断全部成键…' });
        try {
          if(!result.metadata.bondOrders)throw new Error(result.metadata.bondOrdersWarning?.message??'本次GFN2结果没有可用MBO。');
          await this.perceiveCurrent(singlepoint?perceptionMode:'rebuild',{charge:options.charge,multiplicity:options.multiplicity},result.metadata.bondOrders,options.empiricalBondParameters);
          if(this.perceptionDetached){this.update({retainedResult:structuredClone(result),status:'xTB及成键任务完成；工作结构已修改，结果保留在原任务。'});return;}
          this.update({ status: singlepoint?'MBO分档成键完成（0.5 / 1 / 1.5 / 2 / 3）。':'GFN2-xTB优化及MBO分档成键完成。' });
        } catch (error) {
          this.update({ error: `${singlepoint?'原坐标及连接未替换':'优化坐标已保留，原连接未替换'}：${error instanceof Error ? error.message : String(error)}`, status: singlepoint?'辅助成键未完成。':'xTB优化完成，成键重建未完成。' });
        }
      }
      if(optimizedBonds)this.update({status:options.method==='gfn2'?'GFN2-xTB优化及MBO分档成键完成。':`${XTB_METHOD_LABELS[options.method]}优化及经验判键完成。`});
      if(bondFailure)this.update({error:`优化坐标已保留，原连接未替换：${bondFailure}`,status:'xTB优化完成，成键重建未完成。'});
      if(periodic&&!singlepoint&&options.rebuildBonds)this.update({error:'周期优化未计算辅助原子对键级，原连接已保留。'});
      if(result.metadata.bondOrders&&!this.cancelRequested&&!this.gone){
        this.deps.assertCurrent();
        store.publishBondOrders(result,store.stamp(),sessionId);
      }
      const warnings=[result.metadata.bondOrdersWarning?.message,result.metadata.trajectoryWarning?.message].filter((message):message is string=>typeof message==='string'&&message.length>0);
      if(warnings.length){let message=this.state.error;for(const warning of warnings)if(!message.includes(warning))message+=(message?'；':'')+warning;this.update({error:message});}
    } catch (error) {
      if(this.nativeClosed&&!accepted&&!singlepoint){
        const message=error instanceof Error?error.message:String(error);
        try{store.finishRuntimeSession();accepted=this.retainStoppedFrame(request);if(accepted||this.lastReliableFrame&&this.sourceStillCurrent())this.rememberContinuation(options);if(!this.cancelRequested)this.update({status:accepted?'优化未收敛，已保留最后有效结构；可继续优化。':'优化未完成。',error:message});}catch(failure){this.update({status:'已停止xTB，停止帧未通过校验，保留原结构。',error:failure instanceof Error?failure.message:String(failure)});}
        return;
      }
      if (this.sessionId) void bridge.commandXtb(this.sessionId, { command: 'stop' }).catch(() => {});
      this.update({ error: error instanceof Error ? error.message : String(error), status: accepted&&!singlepoint ? '已保留优化坐标。' : '' });
    } finally {
      this.clearPlayback();
      this.unsubscribe?.(); this.unsubscribe = undefined; this.rejectPending = undefined; this.sessionId = undefined;
      await this.stopAcknowledgement()?.catch(()=>{});
      store.finishRuntimeSession();
      if (transaction) { if (accepted) store.endTransaction(); else store.cancelTransaction(); }
      this.lastReliableFrame=undefined;this.update({ running: false, phase: 'idle' });settleRun();
    }
  }
}
