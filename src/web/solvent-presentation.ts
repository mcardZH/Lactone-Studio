import type {SolventEntry} from '../core/solvents';
import type {XtbAlpbPreset} from '../core/xtb-capabilities';
import {xtbSolventReference} from './xtb-solvent-reference';

/** Display-only evidence. Reference properties never become engine input. */
export interface SolventDielectricDisplay {
  value?:number;
  origin?:'reference'|'source';
  temperatureK?:number;
  approximate?:boolean;
  referenceNote?:string;
}
export function solventDielectricText(evidence:SolventDielectricDisplay={}):string {
  if(!Number.isFinite(evidence.value))return 'ε=未收录';
  const value=`ε${evidence.approximate?'≈':'='}${evidence.value}`;
  if(evidence.origin==='source')return `${value}（来源）`;
  if(evidence.origin==='reference')return `${value}（参考${Number.isFinite(evidence.temperatureK)?`，${evidence.temperatureK} K`:''}${evidence.referenceNote?`，${evidence.referenceNote}`:''}）`;
  return value;
}
export function solventLabel(name:string,model:string|undefined,dielectric:string):string {
  return `${name}(${model?.trim()?model.trim().replace(/\.$/,'').toUpperCase():'模型未收录'}) ${dielectric}`;
}
export function solventEntryDielectricText(entry:SolventEntry):string {
  return Number.isFinite(entry.dielectric)&&entry.dielectric!==null
    ?solventDielectricText({value:entry.dielectric})
    :solventDielectricText({value:entry.dielectricReference?.value,origin:'reference',temperatureK:entry.dielectricReference?.temperatureK});
}
export function solventEntryLabel(entry:SolventEntry,model:string):string {
  return solventLabel(`${entry.chineseName} / ${entry.englishName}`,model,solventEntryDielectricText(entry));
}
export function xtbSolventLabel(preset:Pick<XtbAlpbPreset,'label'|'dielectric'>&Partial<Pick<XtbAlpbPreset,'id'>>,model:string):string {
  const reference=xtbSolventReference(preset);
  return solventLabel(preset.label,model,solventDielectricText({...reference,origin:'reference'}));
}
