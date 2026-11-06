import type {ConformerSamplingRequest} from './sampling-contracts';
import type {AdvancedRunBudget} from './contracts';

export interface SamplingSchedule {totalSteps:number;candidateCount:number;recordCount:number}
type SamplingScheduleRequest=Pick<ConformerSamplingRequest,'operation'|'dtFs'|'reportEvery'|'molecularMD'|'metadynamics'|'annealing'|'sphericalMD'>;
function exactSteps(duration:number,dt:number):number|null{
 const value=Math.round(duration/dt);
 return Number.isFinite(duration)&&duration>=0&&Number.isSafeInteger(value)&&Math.abs(value*dt-duration)<=1e-9?value:null;
}
/** Counts complete candidate extractions separately from retained intermediate records.
 * Missing fields use the historical worker defaults, never new UI defaults. */
export function conformerSamplingSchedule(request:SamplingScheduleRequest):SamplingSchedule|null{
 const dt=request.dtFs??.5,reports=request.reportEvery??20;
 if(!Number.isFinite(dt)||dt<=0||!Number.isSafeInteger(reports)||reports<1)return null;
 if(request.operation==='anneal'){
  const a=request.annealing??{},cycles=a.cycles??5;
  if(!Number.isSafeInteger(cycles)||cycles<1)return null;
  const legacy=[a.heatingFs,a.highHoldFs,a.coolingFs,a.lowHoldFs].some(v=>v!==undefined),duration=a.cycleDurationFs??400;
  const values=legacy?[a.heatingFs??100,a.highHoldFs??100,a.coolingFs??100,a.lowHoldFs??100]:[duration*.1,duration*.7,duration*.2];
  const counts=values.map(v=>exactSteps(v,dt));
  if(counts.some(v=>v===null))return null;
  const totalSteps=counts.reduce<number>((sum,n)=>sum+n!,0)*cycles;
  return{totalSteps,candidateCount:cycles,recordCount:Math.floor(totalSteps/reports)+cycles};
 }
 const a=request.operation==='md'?request.molecularMD:request.operation==='metadynamics'?request.metadynamics:request.sphericalMD;
 const n=exactSteps(a?.durationFs??(request.operation==='md'?10000:1000),dt),interval=exactSteps(a?.sampleEveryFs??100,dt);
 if(n===null||interval===null||n<1||interval<1)return null;
 const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
 const overlap=Math.floor(n/(interval*reports/gcd(interval,reports)))+Number(n%reports===0&&n%interval!==0);
 return{totalSteps:n,candidateCount:Math.ceil(n/interval),recordCount:Math.ceil(n/interval)+Math.floor(n/reports)-overlap};
}

/** Admission only; never raises a task's capacity or truncates the requested schedule. */
export function conformerSamplingBudgetPlan(request:SamplingScheduleRequest&{maxFrames?:number},atomCount:number,
 limits:Pick<AdvancedRunBudget,'maxRetainedFrames'|'maxRetainedCoordinates'>&{maxCandidates?:number}):SamplingSchedule{
 const plan=conformerSamplingSchedule(request);
 if(!plan||!Number.isSafeInteger(atomCount)||atomCount<1)throw Error('采样时间须对应完整积分步和完整原子来源。');
 if(limits.maxCandidates!==undefined&&plan.candidateCount>limits.maxCandidates)throw Error(`预计${plan.candidateCount}个采样候选超过本任务${limits.maxCandidates}个候选预算，请新建匹配数量的任务。`);
 if(!Number.isSafeInteger(plan.recordCount*atomCount))throw Error('完整轨迹坐标数量超过可精确表示的整数范围。');
 return plan;
}

export interface ConformerWorkProgress {
 kind:'sampling'|'optimization'|'torsion';completed:number;total:number|null;remaining:number|null;
 valid:number;failed:number;recordCount:number;phase:'running'|'finishing'|'stopping'|'stopped'|'failed'|'complete';
}
export function conformerWorkProgressLabel(progress:ConformerWorkProgress):string{
 const terminal=['stopped','failed','complete'].includes(progress.phase);
 const total=progress.total===null?'?':String(progress.total),remaining=terminal||progress.remaining===null?'':` · 剩余${progress.remaining}${progress.kind==='optimization'?'':'帧'}`;
 return progress.kind==='optimization'?`已处理${progress.completed}/${total} · 有效${progress.valid} · 失败${progress.failed}${remaining}`
  :`已完成${progress.completed}/${total}帧${remaining}`;
}
