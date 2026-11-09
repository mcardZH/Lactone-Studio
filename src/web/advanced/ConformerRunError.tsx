import {useState} from 'react';
import type {AdvancedTaskRun} from '../../modeling/advanced/contracts';

type NativePair={atomIndices?:unknown;elements?:unknown;distanceAngstrom?:unknown};
function pairLabel(value:unknown):string {
  if(!value||typeof value!=='object')return '';
  const pair=value as NativePair;
  if(!Array.isArray(pair.atomIndices)||!Array.isArray(pair.elements)||pair.atomIndices.length!==2||pair.elements.length!==2)return '';
  const elements=pair.elements,atoms=pair.atomIndices.map((index,i)=>`${elements[i]}${index}`).join('–');
  return atoms+(typeof pair.distanceAngstrom==='number'&&Number.isFinite(pair.distanceAngstrom)?` ${pair.distanceAngstrom.toFixed(3)} Å`:'');
}

/** Present genuine native evidence separately from the stable per-run error identity. */
export function conformerRunErrorPresentation(run:AdvancedTaskRun){
  const terminal=run.sampling?.terminal,event=terminal?.event==='error'?terminal.error:undefined;
  const code=event?.code??'run-error';
  const details=event&&'details' in event&&event.details&&typeof event.details==='object'?event.details as Record<string,unknown>:undefined;
  let summary=event?.message??run.error??'';
  const rows:string[]=[];
  if(code==='SAMPLING_NATIVE_MD_SHAKE_PAIRING'){
    summary='含氢键约束与原生配对不一致。';
    for(const [key,label] of [['nativePairs','原生配对'],['sourcePairs','模型连接']] as const){
      const pairs=details?.[key];if(Array.isArray(pairs)){const labels=pairs.map(pairLabel).filter(Boolean);if(labels.length)rows.push(`${label}：${labels.join('；')}`);}
    }
  }else if(code==='SAMPLING_NATIVE_MD_OVERTEMPERATURE'){
    const temperature=details?.temperatureK;
    summary=typeof temperature==='number'&&Number.isFinite(temperature)?`原生 MD 提前结束：瞬时温度达到 ${Number(temperature.toFixed(2))} K。`:'原生 MD 因温度过高提前结束。';
    if(typeof details?.targetTemperatureK==='number')rows.push(`目标温度：${details.targetTemperatureK} K`);
  }
  for(const key of ['reason','nativeReason','stdout','stderr'] as const)if(typeof details?.[key]==='string'&&details[key])rows.push(`${key}：\n${details[key]}`);
  if(!rows.length&&run.error&&run.error!==summary)rows.push(run.error);
  // Unknown native errors retain their actual message. Extra lines are details,
  // not a guessed diagnosis or a second permanent copy of the same error.
  const lines=summary.split(/\r?\n/);summary=lines[0];if(lines.length>1)rows.unshift(lines.slice(1).join('\n'));
  return {identity:`${run.taskId}:${run.id}:${code}:${summary}`,summary,details:rows.join('\n\n')};
}

export default function ConformerRunError({run}:{run:AdvancedTaskRun}){
  const presentation=conformerRunErrorPresentation(run);
  const [dismissed,setDismissed]=useState<ReadonlySet<string>>(()=>new Set());
  if(!presentation.summary||dismissed.has(presentation.identity))return null;
  return <div role="alert" className="dismissible-notice conformer-run-error">
    <div className="dismissible-notice-content"><span>{presentation.summary}</span>
      {presentation.details&&<details><summary>详情</summary><pre>{presentation.details}</pre></details>}
    </div>
    <button type="button" className="dismissible-notice-close" aria-label="关闭提示" title="关闭提示" onClick={()=>setDismissed(previous=>new Set([...previous,presentation.identity]))}>×</button>
  </div>;
}
