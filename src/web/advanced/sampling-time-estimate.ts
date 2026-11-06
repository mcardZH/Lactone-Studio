/** Client observation times only: no scientific duration, budget or worker input is changed. */
export interface SamplingTimeProgress { identity:string; rateStage:string; step:number; totalSteps:number|null;
 budget?:{jobSeconds:number;taskSeconds:number;jobDeadlineEpochMs:number;taskDeadlineEpochMs:number} }
export interface SamplingTimeObservation extends SamplingTimeProgress {
 points:{step:number;atMs:number}[]; observedAtMs:number; msPerStep:number|null;
 budgetAnchor?:{atMs:number;remainingMs:number};
}
export type SamplingTimeEstimate={kind:'estimating'}|{kind:'awaiting-receipt'}|{kind:'ready';remainingMs:number;finishEpochMs:number};

export function observeSamplingTime(previous:SamplingTimeObservation|null,progress:SamplingTimeProgress|null,atMs:number,epochMs?:number):SamplingTimeObservation|null{
 if(!progress||!Number.isFinite(atMs)||!Number.isSafeInteger(progress.step)||progress.step<0)return null;
 const budgetAnchor=previous?.identity===progress.identity&&previous.budgetAnchor&&atMs>=previous.budgetAnchor.atMs?previous.budgetAnchor
  :progress.budget&&Number.isFinite(epochMs)?{atMs,remainingMs:Math.max(0,Math.min(progress.budget.jobDeadlineEpochMs,progress.budget.taskDeadlineEpochMs)-epochMs!)}:undefined;
 const reset=()=>({...progress,points:[{step:progress.step,atMs}],observedAtMs:atMs,msPerStep:null,budgetAnchor});
 if(!previous||previous.identity!==progress.identity||previous.rateStage!==progress.rateStage||atMs<previous.observedAtMs||progress.step<previous.step)return reset();
 if(progress.step===previous.step)return previous.budgetAnchor===budgetAnchor?previous:{...previous,...progress,budgetAnchor};
 let points=previous.points;
 if(atMs-points.at(-1)!.atMs>=250){
  points=[...points,{step:progress.step,atMs}].slice(-8);
  while(points.length>3&&atMs-points[0].atMs>60000)points=points.slice(1);
 }
 const first=points[0],last=points.at(-1)!,span=last.atMs-first.atMs;
 const measured=points.length>=3&&span>=1000&&last.step>first.step?span/(last.step-first.step):null;
 const msPerStep=measured===null?previous.msPerStep:previous.msPerStep===null?measured:.65*previous.msPerStep+.35*measured;
 return{...progress,points,observedAtMs:atMs,msPerStep,budgetAnchor};
}
export function samplingEstimateExceedsBudget(observation:SamplingTimeObservation|null,estimate:SamplingTimeEstimate|null,atMs:number):boolean{
 const anchor=observation?.budgetAnchor;
 return estimate?.kind==='ready'&&!!anchor&&Number.isFinite(atMs)&&atMs>=anchor.atMs
  &&estimate.remainingMs>Math.max(0,anchor.remainingMs-(atMs-anchor.atMs));
}
export function samplingTimeEstimate(observation:SamplingTimeObservation|null,progress:SamplingTimeProgress|null,atMs:number,epochMs:number):SamplingTimeEstimate|null{
 if(!progress)return null;
 if(progress.totalSteps!==null&&progress.step>=progress.totalSteps)return{kind:'awaiting-receipt'};
 if(!observation||observation.identity!==progress.identity||observation.rateStage!==progress.rateStage||observation.step!==progress.step
  ||progress.totalSteps===null||!Number.isSafeInteger(progress.totalSteps)||progress.totalSteps<1||!observation.msPerStep
  ||!Number.isFinite(atMs)||!Number.isFinite(epochMs)||atMs<observation.observedAtMs)return{kind:'estimating'};
 const remainingAtObservation=(progress.totalSteps-progress.step)*observation.msPerStep,age=atMs-observation.observedAtMs;
 const points=observation.points,lastInterval=points.length>=2?points.at(-1)!.atMs-points.at(-2)!.atMs:0;
 // An overdue/stale estimate is not proof of completion or continued progress.
 if(age>=remainingAtObservation||age>Math.max(10000,lastInterval*3))return{kind:'estimating'};
 const remainingMs=remainingAtObservation-age,finishEpochMs=epochMs+remainingMs;
 return Number.isFinite(remainingMs)&&Number.isFinite(finishEpochMs)?{kind:'ready',remainingMs,finishEpochMs}:{kind:'estimating'};
}
export function samplingRemainingLabel(milliseconds:number):string{
 const seconds=Math.max(1,Math.ceil(milliseconds/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;
 return[hours?`${hours}小时`:'',minutes?`${minutes}分`:'',rest||!hours&&!minutes?`${rest}秒`:''].filter(Boolean).join('');
}
export function samplingFinishLabel(epochMs:number,nowEpochMs:number):string{
 const finish=new Date(epochMs),now=new Date(nowEpochMs),clock=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(finish);
 return finish.toDateString()===now.toDateString()?clock:`${finish.getMonth()+1}月${finish.getDate()}日 ${clock}`;
}
