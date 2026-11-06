import type { GaussianSettings, Structure } from '../../core/types';
import type { OrcaSettings } from '../../core/orca/types';
import { defaultTaskOptions, coordinateAtoms } from '../../core/tasks';
import { builderMaterialSignature } from '../../core/builder-integration';

/** Cached task numbers refer to the snapshot's stable atoms, never the new row order. */
export function rebaseCachedGaussianSettings(source:Structure|null,current:Structure|null,previous:GaussianSettings):GaussianSettings {
  const next=structuredClone(previous);
  if(builderMaterialSignature(source)===builderMaterialSignature(current)&&source?.multiplicity===current?.multiplicity)return next;
  const numbers=new Map(current?.atoms.map((atom,index)=>[atom.id,index+1])??[]);
  const number=(value:number)=>{const id=source?.atoms[value-1]?.id;return id?numbers.get(id):undefined;};
  const members=(values:number[])=>values.flatMap(value=>{const mapped=number(value);return mapped===undefined?[]:[mapped];});
  if(next.mixedBasis)next.mixedBasis.regions=next.mixedBasis.regions.map(region=>({...region,atoms:members(region.atoms)}));
  const options=next.taskOptions??defaultTaskOptions();
  next.taskOptions={...options,fragments:options.fragments.map(fragment=>({...fragment,atoms:members(fragment.atoms)})),
    coordinates:options.coordinates.map(row=>({...row,atoms:row.atoms.map(value=>number(value)??0)})),
    coordinateDrafts:options.coordinateDrafts?.map(row=>{try{return {...row,atomText:coordinateAtoms(row.atomText).map(value=>number(value)??'?').join(',')};}catch{return row;}}),
    frozenAtoms:members(options.frozenAtoms),inactiveFrozenAtoms:members(options.inactiveFrozenAtoms??[]),
    fragmentStatesConfirmed:false,irc:{...options.irc,confirmed:false},stable:{...options.stable,confirmed:false}};
  if(next.oniom){const known=new Set(current?.atoms.map(atom=>atom.id)??[]);next.oniom={...next.oniom,qmAtomIds:next.oniom.qmAtomIds.filter(id=>known.has(id)),statesConfirmed:false,topologyConfirmed:false};}
  const inventoryChanged=JSON.stringify(source?.atoms.map(atom=>[atom.id,atom.element]))!==JSON.stringify(current?.atoms.map(atom=>[atom.id,atom.element]));
  if(inventoryChanged&&next.inheritedRoute?.basisTail){next.inheritedRoute={...next.inheritedRoute,basisTail:undefined,basisKeyword:undefined};next.inheritanceIssues=[...(next.inheritanceIssues??[]),{code:'builder-source-basis',field:'basis',severity:'missing',message:'原子中心已改变，请重新分配来源Gen基组或选择当前基组；旧中心段未沿用。'}];}
  return next;
}

/** ORCA already binds coordinates to IDs; prune region members and revoke source confirmations. */
export function rebaseCachedOrcaSettings(source:Structure|null,current:Structure|null,previous:OrcaSettings):OrcaSettings {
  const next=structuredClone(previous);
  if(builderMaterialSignature(source)===builderMaterialSignature(current)&&source?.multiplicity===current?.multiplicity)return next;
  const known=new Set(current?.atoms.map(atom=>atom.id)??[]),members=(ids:string[])=>ids.filter(id=>known.has(id));
  next.fragments=next.fragments.map(fragment=>({...fragment,atomIds:members(fragment.atomIds)}));
  next.frozenAtomIds=members(next.frozenAtomIds);next.fragmentStatesConfirmed=false;
  next.multiscale={...next.multiscale,qmAtomIds:members(next.multiscale.qmAtomIds),activeAtomIds:next.multiscale.activeAtomIds?members(next.multiscale.activeAtomIds):undefined,configurationConfirmed:false};
  if(next.multiscale.graphEvidence)next.multiscale.graphEvidence={...next.multiscale.graphEvidence,confirmed:false};
  if(next.ircStartEvidence)next.ircStartEvidence={...next.ircStartEvidence,confirmed:false};
  // Deleted coordinate IDs remain invalid drafts; never drop an ID to turn B/A/D into a different target.
  return next;
}
