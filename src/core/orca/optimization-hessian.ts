import { getOrcaMethodProfile } from './catalog';
import type { OrcaMethodProfile, OrcaSettings } from './types';

/** Optimizer Hessians belong to the optimized state, including TD/TDA roots.
 * ORCA 5/6 manuals: analytic Hessians apply to SCF energies; NumHess requests
 * numerical differentiation. This does not change the selected theory.
 * https://www.faccts.de/docs/orca/6.1/manual/contents/structurereactivity/frequencies.html
 * https://www.faccts.de/docs/orca/6.1/manual/contents/structurereactivity/optimizations.html
 */
export function orcaOptimizationHessianRoute(settings:OrcaSettings):OrcaMethodProfile['frequency'] {
  const method=getOrcaMethodProfile(settings.method,settings.version);
  if(!method||!method.tasks.includes(settings.task)||method.frequency==='none')return 'none';
  if(settings.task==='tdopt'&&!settings.excited.useUks){
    return settings.excited.approximation==='td'||settings.excited.approximation==='tda'?'numeric':'none';
  }
  return method.frequency;
}
