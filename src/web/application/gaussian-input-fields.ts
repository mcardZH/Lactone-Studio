import type { GaussianSettings } from '../../core/types';
import { defaultTaskOptions } from '../../core/tasks';
import { setUse5D } from '../../core/gaussian';
import { defaultXtb } from '../../core/xtb';
import { defaultAdvanced } from '../../core/advanced';
import { SCF_ADVANCED_FIELDS } from '../../core/section-defaults';

const scientificFields=new Set(['method','basis','mixedBasis','dispersion','grid','integral','scf','solvent',
  'solvation','solventModel','use5D','oniom','unrestricted','advanced','nosymm','xtb']);

export function changedGaussianConditions(previous:GaussianSettings,keys:string[]):GaussianSettings{
  if(!keys.some(key=>scientificFields.has(key)))return previous;
  const options=previous.taskOptions??defaultTaskOptions();
  return {...previous,...(previous.oniom&&!keys.includes('oniom')?{oniom:{...previous.oniom,statesConfirmed:false}}:{}),
    taskOptions:{...options,irc:{...options.irc,confirmed:false},stable:{...options.stable,confirmed:false},fragmentStatesConfirmed:false}};
}

/** Shared scientific-field transition used before the native editor or a frame writer validates the request. */
export function applyGaussianField<K extends keyof GaussianSettings>(previous:GaussianSettings,key:K,value:GaussianSettings[K]):GaussianSettings{
  if(key==='use5D')previous=setUse5D(previous,value===true);
  const changesConditions=key!=='xtb'||(['scriptPath','executable','level','entryBasis'] as const)
    .some(field=>(previous.xtb??defaultXtb())[field]!==((value as GaussianSettings['xtb'])??defaultXtb())[field]);
  const inherited={...previous.inheritedRoute};
  const scfChanged=key==='advanced'&&SCF_ADVANCED_FIELDS.some(field=>previous.advanced?.[field]!==((value as GaussianSettings['advanced'])??defaultAdvanced(previous.task))[field]);
  if(key==='unrestricted'||key==='method')delete inherited.methodKeyword;
  if(key==='scf'||scfChanged)delete inherited.scf;
  if(key==='grid'||key==='integral')delete inherited.integration;
  if(key==='solvent'||key==='solvation'||key==='solventModel')delete inherited.solvent;
  if(key==='basis'||key==='mixedBasis'){delete inherited.basisTail;delete inherited.basisKeyword;}
  return {...changedGaussianConditions(previous,changesConditions?[key]:[]),[key]:value,inheritedRoute:inherited,
    inheritanceIssues:previous.inheritanceIssues?.filter(issue=>issue.field!==key&&!(key==='taskOptions'&&issue.field==='freeze')&&!(scfChanged&&issue.field==='scf'))};
}
