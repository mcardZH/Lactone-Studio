/** Presentation protocol only: no scheduling, scientific parameters or ETA. */
export type MultiwfnProgressPhase='queued'|'reading'|'running'|'write'|'parse'|'render'|'stopping'|'stopped'|'failed'|'completed';
export interface MultiwfnProgressIdentity {
 /** Stable logical analysis owner; never the current detached window. */
 ownerId:string;analysisId:string;sessionId:string;runId:string;sourceId:string;operation:string;
 sourceRevision?:string;jobIndex?:number|null;sourceFrameIndex?:number|null;generation?:number;
}
export type MultiwfnProgressMeasure={kind:'percent';value:number}|{kind:'items';completed:number;total:number;unit?:string};
export type MultiwfnProgressSettlement='not-started'|'cancelled-before-start'|'native-settled'|'not-required';
export interface MultiwfnProgressSnapshot {
 identity:MultiwfnProgressIdentity;seq:number;phase:MultiwfnProgressPhase;elapsedMs:number;
 stageId?:string;stageLabel?:string;measure?:MultiwfnProgressMeasure;message?:string;
 settlement?:MultiwfnProgressSettlement;
 /** Accepted/validated by the actual result owner, not just worker exit 0. */
 validated?:boolean;committed?:boolean;
 renderRequired?:boolean;renderCommitted?:boolean;
}
export interface MultiwfnProgressBridge {onMultiwfnProgress(listener:(snapshot:MultiwfnProgressSnapshot)=>void):()=>void}
const phases=new Set<MultiwfnProgressPhase>(['queued','reading','running','write','parse','render','stopping','stopped','failed','completed']);
export const multiwfnProgressTerminal=(phase:MultiwfnProgressPhase)=>phase==='completed'||phase==='stopped'||phase==='failed';
function requireValue(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
function plain(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
const text=(value:unknown,maximum=512):value is string=>typeof value==='string'&&value.length>0&&value.length<=maximum;
const ordinal=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const identityFields=['ownerId','analysisId','sessionId','runId','sourceId','operation','sourceRevision','jobIndex','sourceFrameIndex','generation'] as const;
export function validateMultiwfnProgressIdentity(value:unknown):MultiwfnProgressIdentity{
 requireValue(plain(value)&&Object.keys(value).every(key=>(identityFields as readonly string[]).includes(key)),'Invalid Multiwfn progress identity');
 for(const key of ['ownerId','analysisId','sessionId','runId','sourceId','operation'])requireValue(text(value[key]),'Incomplete Multiwfn progress identity');
 if(value.sourceRevision!==undefined)requireValue(text(value.sourceRevision),'Invalid Multiwfn source revision');
 for(const key of ['jobIndex','sourceFrameIndex'])if(value[key]!==undefined&&value[key]!==null)requireValue(ordinal(value[key]),'Invalid Multiwfn source ordinal');
 if(value.generation!==undefined)requireValue(ordinal(value.generation),'Invalid Multiwfn generation');
 return structuredClone(value) as unknown as MultiwfnProgressIdentity;
}
export function sameMultiwfnProgressIdentity(left:MultiwfnProgressIdentity,right:MultiwfnProgressIdentity):boolean{return identityFields.every(key=>left[key]===right[key]);}
export function multiwfnProgressIdentityKey(identity:MultiwfnProgressIdentity):string{return JSON.stringify(identityFields.map(key=>identity[key]??null));}
export function validateMultiwfnProgressSnapshot(value:unknown):MultiwfnProgressSnapshot{
 requireValue(plain(value),'Invalid Multiwfn progress');
 const identity=validateMultiwfnProgressIdentity(value.identity);
 requireValue(ordinal(value.seq)&&phases.has(value.phase as MultiwfnProgressPhase)&&typeof value.elapsedMs==='number'&&Number.isFinite(value.elapsedMs)&&value.elapsedMs>=0,'Invalid Multiwfn phase, sequence or elapsed time');
 for(const key of ['stageId','stageLabel','message'])if(value[key]!==undefined)requireValue(text(value[key],key==='message'?2048:256),'Invalid Multiwfn stage label');
 for(const key of ['validated','committed','renderRequired','renderCommitted'])if(value[key]!==undefined)requireValue(typeof value[key]==='boolean','Invalid Multiwfn commit state');
 if(value.settlement!==undefined)requireValue(['not-started','cancelled-before-start','native-settled','not-required'].includes(String(value.settlement)),'Invalid Multiwfn settlement');
 if(value.measure!==undefined){
  const m=value.measure;requireValue(plain(m),'Invalid Multiwfn stage measure');
  if(m.kind==='percent')requireValue(typeof m.value==='number'&&Number.isFinite(m.value)&&m.value>=0&&m.value<=100,'Invalid Multiwfn stage percent');
  else requireValue(m.kind==='items'&&ordinal(m.completed)&&ordinal(m.total)&&Number(m.total)>0&&Number(m.completed)<=Number(m.total)&&(m.unit===undefined||text(m.unit,32)),'Invalid Multiwfn stage count');
 }
 if(multiwfnProgressTerminal(value.phase as MultiwfnProgressPhase)){
  requireValue(value.settlement!==undefined,'Multiwfn terminal state needs actual settlement');
  if(value.phase==='stopped')requireValue(value.settlement==='cancelled-before-start'||value.settlement==='native-settled','A stopped task needs confirmed cancellation');
  if(value.phase==='failed')requireValue(value.settlement!=='not-required','A failed task cannot claim successful derived-only settlement');
  if(value.phase==='completed')requireValue((value.settlement==='native-settled'||value.settlement==='not-required')&&value.validated===true&&value.committed===true&&(!value.renderRequired||value.renderCommitted===true),'Multiwfn completion needs validated owner commit and required render commit');
 }
 return{...structuredClone(value),identity} as unknown as MultiwfnProgressSnapshot;
}
/** A stage may reset its native percent. It never resets task identity or elapsed time. */
export function reduceMultiwfnProgress(current:MultiwfnProgressSnapshot|null,expected:MultiwfnProgressIdentity,incoming:unknown):MultiwfnProgressSnapshot|null{
 const previous=current&&sameMultiwfnProgressIdentity(current.identity,expected)?current:null;
 let next:MultiwfnProgressSnapshot;try{next=validateMultiwfnProgressSnapshot(incoming);}catch{return previous;}
 if(!sameMultiwfnProgressIdentity(next.identity,expected)||previous&&(next.seq<=previous.seq||multiwfnProgressTerminal(previous.phase)))return previous;
 if(previous?.phase==='stopping'&&!['stopping','stopped','failed'].includes(next.phase))return previous;
 const renderRequired=!!(previous?.renderRequired||previous?.phase==='render'||next.renderRequired||next.phase==='render');
 if(next.phase==='completed'&&renderRequired&&!next.renderCommitted)return previous;
 return{...next,elapsedMs:Math.max(previous?.elapsedMs??0,next.elapsedMs),...(renderRequired?{renderRequired:true}:{})};
}
export const MULTIWFN_PHASE_LABELS:Record<MultiwfnProgressPhase,string>={queued:'排队中',reading:'读取来源',running:'计算中',write:'写出结果',parse:'解析结果',render:'绘图准备',stopping:'正在停止',stopped:'已停止',failed:'失败',completed:'已完成'};
export function multiwfnProgressPercent(measure:MultiwfnProgressMeasure|undefined):number|undefined{return measure?.kind==='percent'?measure.value:measure?.total?measure.completed/measure.total*100:undefined;}
export function multiwfnProgressMeasureText(measure:MultiwfnProgressMeasure|undefined):string{
 if(!measure)return'';return measure.kind==='percent'?`当前阶段 ${Number(measure.value.toFixed(1))}%`:`${measure.completed} / ${measure.total}${measure.unit?' '+measure.unit:''}`;
}
export function multiwfnElapsedText(elapsedMs:number):string{
 const seconds=Math.max(0,Math.floor(elapsedMs/1000)),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);
 return hours?`${hours}:${String(minutes%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:`${minutes}:${String(seconds%60).padStart(2,'0')}`;
}

/** Legacy states are evidence of worker work, not of renderer/result commit. */
export interface MultiwfnLegacyProgressOptions {
 identity:MultiwfnProgressIdentity;seq:number;elapsedMs:number;actualRequest:boolean;
 nativeSettled?:boolean;validated?:boolean;committed?:boolean;renderRequired?:boolean;renderCommitted?:boolean;
 requestedKeys?:readonly string[];
}
function legacySnapshot(status:string,options:MultiwfnLegacyProgressOptions,measure?:MultiwfnProgressMeasure):MultiwfnProgressSnapshot|null{
 if(!options.actualRequest||status==='idle')return null;
 const phase:MultiwfnProgressPhase=status==='cancelled'||status==='stopped'?'stopping':status==='failed'?'stopping':status==='queued'?'queued':'running';
 let result:MultiwfnProgressSnapshot={identity:options.identity,seq:options.seq,phase,elapsedMs:options.elapsedMs,...(measure?{measure}:{}),...(status==='completed'?{stageLabel:'等待结果提交'}:{})};
 if(options.nativeSettled){
  if(status==='cancelled'||status==='stopped')result={...result,phase:'stopped',settlement:'native-settled'};
  else if(status==='failed')result={...result,phase:'failed',settlement:'native-settled'};
  else if(status==='completed'&&options.validated&&options.committed&&(!options.renderRequired||options.renderCommitted))result={...result,phase:'completed',settlement:'native-settled',validated:true,committed:true,renderRequired:options.renderRequired,renderCommitted:options.renderCommitted};
 }
 return validateMultiwfnProgressSnapshot(result);
}
export function orbitalMultiwfnProgress(event:import('./orbital-contracts').OrbitalBackendEvent,options:MultiwfnLegacyProgressOptions):MultiwfnProgressSnapshot|null{
 if(event.sessionId!==options.identity.sessionId||event.sourceRevision!==options.identity.sourceRevision)return null;
 const keys=options.requestedKeys??(event.mode==='selected'?event.requestedKeys:undefined);
 const complete=new Set(event.completedKeys);let measure:MultiwfnProgressMeasure|undefined;
 if(complete.size!==event.completedKeys.length)return null;
 if(keys?.length&&new Set(keys).size===keys.length)measure={kind:'items',completed:keys.filter(key=>complete.has(key)).length,total:keys.length,unit:'轨道'};
 else if(event.mode!=='selected'&&Number.isSafeInteger(event.total)&&event.total>0&&complete.size<=event.total)measure={kind:'items',completed:complete.size,total:event.total,unit:'轨道'};
 return legacySnapshot(event.status,options,measure);
}
export function surfaceMultiwfnProgress(event:import('./surface-contracts').SurfaceRunState&{sessionId:string},options:MultiwfnLegacyProgressOptions):MultiwfnProgressSnapshot|null{
 const stamp=event.stamp,id=options.identity;
 if(event.sessionId!==id.sessionId||stamp.requestId!==id.runId||stamp.analysisId!==id.analysisId||stamp.sourceId!==id.sourceId||stamp.sourceRevision!==id.sourceRevision||stamp.jobIndex!==id.jobIndex||stamp.sourceFrameIndex!==id.sourceFrameIndex||stamp.generation!==id.generation)return null;
 const measure=Number.isSafeInteger(event.completed)&&Number.isSafeInteger(event.total)&&event.total!>0&&event.completed!>=0&&event.completed!<=event.total!?{kind:'items' as const,completed:event.completed!,total:event.total!}:undefined;
 return legacySnapshot(event.status,options,measure);
}

/** Owner-side display lease. Receiving a native event never commits its result. */
export function createMultiwfnProgressTracker(identity:MultiwfnProgressIdentity,publish:(snapshot:MultiwfnProgressSnapshot)=>void,now:()=>number=()=>performance.now()){
 const expected=validateMultiwfnProgressIdentity(identity),started=now();let current:MultiwfnProgressSnapshot={identity:expected,seq:0,phase:'queued',elapsedMs:0},accepted=false;
 const emit=(incoming:unknown)=>{const next=reduceMultiwfnProgress(current,expected,incoming);if(next&&next!==current){current=next;publish(next);}return current;};
 const phaseFields={stageId:undefined,stageLabel:undefined,measure:undefined};
 const finish=()=>{if(accepted&&(current.settlement==='native-settled'||current.settlement==='not-required')&&current.validated&&(!current.renderRequired||current.renderCommitted===true)&&current.phase!=='stopping'&&!multiwfnProgressTerminal(current.phase))emit({...current,...phaseFields,seq:current.seq+1,phase:'completed',committed:true,elapsedMs:Math.max(current.elapsedMs,now()-started)});};
 publish(current);
 return{
  identity:expected,getSnapshot:()=>current,
  receive(incoming:unknown){emit(incoming);finish();},
  stopping(){emit({...current,...phaseFields,seq:current.seq+1,phase:'stopping',elapsedMs:Math.max(current.elapsedMs,now()-started)});},
  /** Call only after validating and accepting this operation's result. */
  committed(render?:{required:boolean;committed?:boolean}){accepted=true;if(render?.required)emit({...current,...phaseFields,seq:current.seq+1,phase:'render',renderRequired:true,renderCommitted:render.committed===true});finish();},
  renderCommitted(){if(current.renderRequired)emit({...current,seq:current.seq+1,renderCommitted:true});finish();},
  /** Promise rejection is usable only when its platform contract awaits settlement. */
  failed(settlement:MultiwfnProgressSettlement,message?:string){emit({...current,...phaseFields,seq:current.seq+1,phase:'failed',settlement:settlement==='not-required'?'not-started':settlement,message,elapsedMs:Math.max(current.elapsedMs,now()-started)});},
  stopped(settlement:Extract<MultiwfnProgressSettlement,'cancelled-before-start'|'native-settled'>){emit({...current,...phaseFields,seq:current.seq+1,phase:'stopped',settlement,elapsedMs:Math.max(current.elapsedMs,now()-started)});},
 };
}
