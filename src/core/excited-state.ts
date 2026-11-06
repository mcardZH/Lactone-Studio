import type { GaussianSettings } from './types';

export const isExcitedOptimization=(settings:GaussianSettings):boolean=>settings.task==='tdopt'||settings.task==='t1opt';
/** UKS is available only for the lowest triplet; invalid requests are validated. */
export function isUksOptimization(settings:GaussianSettings):boolean {
  return settings.task==='t1opt'||settings.task==='tdopt'&&settings.taskOptions?.excited.targetSpin==='triplets'&&settings.taskOptions.excited.root===1&&settings.taskOptions.excited.useUks===true;
}
export function excitedOptimizationFrequency(settings:GaussianSettings):boolean {
  return isExcitedOptimization(settings)&&settings.taskOptions?.excited.frequency===true;
}
export const excitedFrequencyOnly=(settings:GaussianSettings):boolean=>settings.task==='tdopt'&&settings.taskOptions?.excited.frequency===true&&settings.taskOptions.excited.frequencyOnly===true;
export function excitedOptimizationTarget(settings:GaussianSettings):string {
  if(settings.task==='t1opt')return 'T1';
  const excited=settings.taskOptions?.excited;
  return (excited?.targetSpin==='triplets'?'T':'S')+(excited?.root??1);
}
export const excitedTarget=excitedOptimizationTarget;
export function excitedMode(settings:GaussianSettings):'uks'|'td'|'tda' {
  return isUksOptimization(settings)?'uks':settings.taskOptions?.excited.approximation==='tda'?'tda':'td';
}
export function excitedOptimizationTitle(settings:GaussianSettings):string {
  return excitedOptimizationTarget(settings)+(isUksOptimization(settings)?' UKS':' '+(settings.taskOptions?.excited.approximation==='tda'?'TDA':'TD'))+(excitedFrequencyOnly(settings)?' frequencies':' geometry optimization'+(excitedOptimizationFrequency(settings)?' and frequencies':''));
}
export function excitedOptimizationStem(settings:GaussianSettings):string {
  return excitedOptimizationTarget(settings).toLowerCase()+'-'+(isUksOptimization(settings)?'uks':settings.taskOptions?.excited.approximation==='tda'?'tda':'td')+(excitedFrequencyOnly(settings)?'freq':'opt'+(excitedOptimizationFrequency(settings)?'-freq':''));
}
