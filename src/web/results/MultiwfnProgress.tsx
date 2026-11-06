import {useEffect,useRef,useState} from 'react';
import {MULTIWFN_PHASE_LABELS,multiwfnElapsedText,multiwfnProgressIdentityKey,multiwfnProgressMeasureText,multiwfnProgressPercent,multiwfnProgressTerminal,type MultiwfnProgressIdentity,type MultiwfnProgressSnapshot} from '../../results/multiwfn-progress';
import './multiwfn-progress.css';
const clock=()=>typeof performance==='undefined'?Date.now():performance.now();
export interface MultiwfnProgressProps {progress:MultiwfnProgressSnapshot|null;operationLabel?:string;onStop?:(identity:MultiwfnProgressIdentity)=>void;className?:string}
/** Elapsed ticks never advance the measured stage progress or schedule science. */
export default function MultiwfnProgress({progress,operationLabel='Multiwfn',onStop,className=''}:MultiwfnProgressProps){
 const [tick,setTick]=useState(0),key=progress?multiwfnProgressIdentityKey(progress.identity):'',active=!!progress&&!multiwfnProgressTerminal(progress.phase);
 const received=useRef({key:'',seq:-1,at:0});if(progress&&(received.current.key!==key||received.current.seq!==progress.seq))received.current={key,seq:progress.seq,at:clock()};
 useEffect(()=>{if(!active)return;const timer=setInterval(()=>setTick(value=>value+1),1000);return()=>clearInterval(timer);},[active,key]);
 if(!progress||progress.phase==='completed'||progress.phase==='stopped')return null;
 const elapsed=progress.elapsedMs+(active?Math.max(0,clock()-received.current.at):0),percent=multiwfnProgressPercent(progress.measure),measured=multiwfnProgressMeasureText(progress.measure),phase=progress.stageLabel??MULTIWFN_PHASE_LABELS[progress.phase];void tick;
 const failure=progress.phase==='failed',shortReason=progress.message?.split(/\r?\n/)[0].slice(0,160);
 return <section className={`multiwfn-progress ${className}`.trim()} data-phase={progress.phase} data-run-id={progress.identity.runId} data-active={active} aria-label={`${operationLabel}进度`}>
  <div className="multiwfn-progress-heading"><span>状态 <span role="status">{phase}</span> · {operationLabel}</span>{onStop&&active&&<button type="button" disabled={progress.phase==='stopping'} onClick={()=>onStop(progress.identity)}>停止</button>}</div>
  {failure?<>{shortReason&&<span className="multiwfn-progress-message">{shortReason}</span>}{progress.message&&progress.message!==shortReason&&<details className="multiwfn-progress-details"><summary>详情</summary><pre>{progress.message}</pre></details>}</>:<>
  <div className="multiwfn-progress-track" role="progressbar" aria-label="当前阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={measured||phase} data-indeterminate={percent===undefined}><span style={percent===undefined?undefined:{width:`${percent}%`}}/></div>
  {measured&&<output className="multiwfn-progress-measure">{measured}</output>}{progress.message&&<span className="multiwfn-progress-message">{progress.message}</span>}
  <div className="multiwfn-progress-timing"><output aria-label="已用时">已用时 {multiwfnElapsedText(elapsed)}</output></div>
  </>}
 </section>;
}
