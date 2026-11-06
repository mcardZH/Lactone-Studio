import type {PostprocessAttachment} from '../../results/postprocess-document';
import {listExplicitExcitationCompanions,updateExplicitExcitationCompanion} from '../../projects/companion-sources';
import type {ResultInputFile} from '../../results/contracts';
import type {PostprocessFileSlot,PostprocessSlotKey} from './PostprocessSidebar';

export type ExcitationSlotKey='excitation-json'|'excitation-cis';
export const isExcitationSlot=(key:PostprocessSlotKey|undefined):key is ExcitationSlotKey=>key==='excitation-json'||key==='excitation-cis';
/** Raw source selection is not amplitude/state validation. Either role alone is
 * retained, and native capability checks decide which analyses are supported. */
export function postprocessExcitationSlots(attachment:PostprocessAttachment):PostprocessFileSlot[]{
 if(attachment.source.kind!=='orca-output'||!attachment.source.tasks.includes('td'))return[];
 const files=listExplicitExcitationCompanions(attachment);
 return(['excitation-json','excitation-cis'] as const).map(slotKey=>{
  const role=slotKey==='excitation-json'?'orcaJson':'orcaCis',matches=files.filter(file=>file.role===role);
  return{role:'companions',slotKey,name:matches.length?matches.map(file=>file.name).join('；'):undefined,sourceId:`${attachment.source.result.source.id}:${role}`,status:matches.length?'unverified':undefined,message:matches.length?'已保留原始候选；振幅与电子态由原生后端核对。':undefined};
 });
}
export async function updatePostprocessExcitationSlot(attachment:PostprocessAttachment,key:ExcitationSlotKey,input:ResultInputFile|null,signal?:AbortSignal){
 return updateExplicitExcitationCompanion(attachment,key==='excitation-json'?'orcaJson':'orcaCis',input,signal);
}
