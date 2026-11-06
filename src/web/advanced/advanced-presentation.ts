import type {AdvancedResultFrame,AdvancedTaskRun} from '../../modeling/advanced/contracts';
export function advancedFrameEnergyLabel(frame:AdvancedResultFrame,run:AdvancedTaskRun|undefined):string{
 if(frame.energyHartree===undefined)return '—';
 const result=run?.results.find(row=>row.frameId===frame.id),kind=result?.identity?.energyKind;
 return kind==='forcefield-potential'?'力场势能':kind==='electronic'?'电子能量':'能量';
}
