import { defaultAdvanced } from './advanced';
import { supportsEfficientGrid } from './gaussian';
import { isEnergyTask, usesEfficientGrid } from './tasks';
import { isXtb } from './xtb';
import { excitedOptimizationFrequency } from './excited-state';
import type { AdvancedSettings, FileSettings, GaussianSettings } from './types';

export type DefaultSection = 'scf' | 'opt' | 'integration';
export const SCF_ADVANCED_FIELDS = ['scfAlgorithm','noVarAcc','noIncFock','fermi','noDIIS','vshift','scfMaxCycle','maxConventional'] as const;
export const OPT_ADVANCED_FIELDS = ['optConvergence','maxStep','optMaxCycles'] as const;
export interface SectionDefaultContext { atomCount?:number; compatibleHessian?:boolean }
export interface SectionDefaultPatch { settings:Partial<GaussianSettings>; files:Partial<FileSettings> }

/** Return one atomic patch without resetting fields owned by another section. */
export function sectionDefaults(settings:GaussianSettings,files:FileSettings,section:DefaultSection,context:SectionDefaultContext={}):SectionDefaultPatch {
  const defaults=defaultAdvanced(settings.task,excitedOptimizationFrequency(settings));
  const advanced:AdvancedSettings={...defaults,...settings.advanced};
  if(section==='scf'){
    for(const key of SCF_ADVANCED_FIELDS)Object.assign(advanced,{[key]:defaults[key]});
    return {settings:{scf:isEnergyTask(settings.task)&&!isXtb(settings.method)?'conver6':'default',advanced},files:{}};
  }
  if(section==='opt'){
    for(const key of OPT_ADVANCED_FIELDS)Object.assign(advanced,{[key]:defaults[key]});
    const compatible=context.compatibleHessian??(files.readCheckpoint&&(!!files.oldCheckpoint.trim()||files.saveCheckpoint)&&files.compatibilityConfirmed&&files.hessian==='rcfc');
    const hessian:FileSettings['hessian']=settings.task==='ts'
      ?isXtb(settings.method)?context.atomCount!==undefined&&context.atomCount<60?'calcall':'calcfc':compatible?'rcfc':'calcfc'
      :'none';
    return {settings:{advanced},files:{hessian,recalcInterval:null}};
  }
  const efficient=supportsEfficientGrid(settings.method)&&usesEfficientGrid(settings.task);
  return {settings:{grid:efficient?'efficient':'default',integral:efficient?{grid:'fine',acc2e:10}:{},nosymm:true},files:{}};
}
