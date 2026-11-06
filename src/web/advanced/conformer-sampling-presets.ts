import type {SamplingDraft} from './process-config';
/** Adjustable conformer starting points; no trajectory or ensemble guarantee. */
export const CONFORMER_SAMPLING_PRESETS=Object.freeze([
  {id:'conservative',label:'保守',temperatureK:400,metaTemperatureK:300,heightEV:.005},
  {id:'moderate',label:'适中',temperatureK:600,metaTemperatureK:300,heightEV:.01},
  {id:'aggressive',label:'激进',temperatureK:900,metaTemperatureK:450,heightEV:.02},
  {id:'extreme',label:'疯狂',temperatureK:1200,metaTemperatureK:600,heightEV:.04},
] as const);
export function conformerSamplingPresetId(value:SamplingDraft):string{
  return CONFORMER_SAMPLING_PRESETS.find(row=>value.operation==='metadynamics'?value.temperatureK===row.metaTemperatureK&&value.heightEV===row.heightEV:(value.operation==='md'?value.molecularTemperatureK:value.operation==='anneal'?value.highTemperatureK:value.temperatureK)===row.temperatureK)?.id??'custom';
}
export function applyConformerSamplingPreset(value:SamplingDraft,id:typeof CONFORMER_SAMPLING_PRESETS[number]['id']|'random'|'custom',random= Math.random):{draft:SamplingDraft;selected:string}{
  if(id==='custom')return{draft:{...value},selected:'custom'};
  const row=id==='random'?CONFORMER_SAMPLING_PRESETS[Math.min(CONFORMER_SAMPLING_PRESETS.length-1,Math.floor(Math.max(0,random())*CONFORMER_SAMPLING_PRESETS.length))]:CONFORMER_SAMPLING_PRESETS.find(row=>row.id===id)!;
  const changed=value.operation==='md'?{molecularTemperatureK:row.temperatureK}:value.operation==='anneal'?{highTemperatureK:row.temperatureK}:value.operation==='metadynamics'?{temperatureK:row.metaTemperatureK,heightEV:row.heightEV}:{temperatureK:row.temperatureK};
  return {draft:{...value,...changed},selected:row.id};
}
