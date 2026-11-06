import type { GaussianSettings, MethodId, TaskId } from './types';
import { excitedOptimizationStem, isExcitedOptimization } from './excited-state';
export function cleanStem(name:string):string{return name.replace(/\.[^.]+$/,'').replace(/[^A-Za-z0-9_.-]+/g,'_').replace(/^[_.-]+|[_.-]+$/g,'')||'molecule';}
export function taskStem(source:string,task:TaskId,method:MethodId,xtbLevel='--gfn 2',settings?:GaussianSettings):string{
  const gfn=xtbLevel.match(/--gfn\s+([012])\b/)?.[1]??'2';
  const opt=method==='pm6'?'optpm6':method==='pm7'?'optpm7':method==='gfn2-xtb'?'optxtb'+gfn:'optdft';
  const suffix:Record<TaskId,string>={sp:'sp',opt,freq:'freq',optfreq:opt+'-freq',ts:'ts',qst2:'qst2',qst3:'qst3',irc:'irc',scan:'scan',constrained:'constrained-'+opt,td:'tddft',tdopt:'tdopt',t1opt:'t1opt',nmr:'nmr',stable:'stable',bsse:'bsse'};
  if(settings&&isExcitedOptimization(settings))return cleanStem(source)+'-'+excitedOptimizationStem(settings);
  return cleanStem(source)+'-'+(method==='gfn2-xtb'&&!['opt','optfreq','constrained'].includes(task)?'xtb'+gfn+'-':'')+suffix[task];
}
