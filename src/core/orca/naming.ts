import type { OrcaSettings } from './types';
import { cleanStem } from '../naming';

export function orcaTaskStem(system:string,settings:OrcaSettings):string {
  const opt=settings.method==='xtb2'?'optxtb2':'optdft';
  const suffix:Record<OrcaSettings['task'],string>={sp:'sp',opt,freq:'freq',optfreq:opt+'-freq',scan:'scan',ts:'ts',irc:'irc',td:settings.excited.approximation==='stddft'?'stddft':settings.excited.approximation==='stda'?'stda':'tddft',tdopt:'tdopt',nmr:'nmr',stable:'stable',bsse:'bsse',neb:'ci-neb',esd:'esd-'+settings.esd.channel,md:'md'};
  const excitedSuffix=settings.task==='tdopt'&&settings.excited.frequency?(settings.excited.targetSpin==='triplet'?'t':'s')+settings.excited.root+'-'+(settings.excited.useUks?'uks':settings.excited.approximation)+(settings.excited.frequencyOnly?'freq':'opt-freq'):suffix[settings.task];
  return cleanStem(system)+'-'+excitedSuffix;
}
