import type { GaussianSettings, MethodId, TaskId } from './types';
import { excitedOptimizationStem, isExcitedOptimization } from './excited-state';

const knownSourceExtension = /\.(?:es|sy|sciyue|gjf|com|inp|out|log|fchk?|gbw|molden|sdf|mol2?|pdb|extxyz|xyz|cif|poscar|vasp|trj|traj|txt|json|csv|tsv|zip|png|gif)$/i;
const reservedDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const trimStem = (value: string) => value.replace(/^[_.-]+|[_.-]+$/g, '');

export interface AutomaticNameOptions {
  fallback?: string;
  sequence?: number;
  occupied?: Iterable<string>;
}

/** For generated suggestions only. Explicit names and selected paths bypass this helper. */
export function automaticStem(name: string, { fallback = 'model', sequence = 1, occupied = [] }: AutomaticNameOptions = {}): string {
  const base = name.replace(/^.*[\\/]/, '').replace(knownSourceExtension, '');
  const used = new Set(Array.from(occupied, value => value.toLowerCase()));
  let stem = trimStem(base.replace(/[^A-Za-z0-9_.-]+/g, '_'));
  if (!stem) {
    let number = sequence;
    do { stem = `${fallback}_${String(number++).padStart(3, '0')}`; } while (used.has(stem.toLowerCase()));
    return stem;
  }
  if (reservedDevice.test(stem)) stem = `model_${stem}`;
  stem = trimStem(stem.slice(0, 150));
  let candidate = stem;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    const suffix = `_${String(i).padStart(3, '0')}`;
    candidate = trimStem(stem.slice(0, 150 - suffix.length)) + suffix;
  }
  return candidate;
}

export function automaticFilename(name: string, extension: string, options?: AutomaticNameOptions): string {
  return `${automaticStem(name, options)}.${extension}`;
}

/** JSON text written in an ASCII-only field while retaining exact source strings. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function cleanStem(name:string):string{return automaticStem(name);}
export function taskStem(source:string,task:TaskId,method:MethodId,xtbLevel='--gfn 2',settings?:GaussianSettings):string{
  const gfn=xtbLevel.match(/--gfn\s+([012])\b/)?.[1]??'2';
  const opt=method==='pm6'?'optpm6':method==='pm7'?'optpm7':method==='gfn2-xtb'?'optxtb'+gfn:'optdft';
  const suffix:Record<TaskId,string>={sp:'sp',opt,freq:'freq',optfreq:opt+'-freq',ts:'ts',qst2:'qst2',qst3:'qst3',irc:'irc',scan:'scan',constrained:'constrained-'+opt,td:'tddft',tdopt:'tdopt',t1opt:'t1opt',nmr:'nmr',stable:'stable',bsse:'bsse'};
  if(settings&&isExcitedOptimization(settings))return cleanStem(source)+'-'+excitedOptimizationStem(settings);
  return cleanStem(source)+'-'+(method==='gfn2-xtb'&&!['opt','optfreq','constrained'].includes(task)?'xtb'+gfn+'-':'')+suffix[task];
}
