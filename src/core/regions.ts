import type { FragmentDefinition } from './types';

/** Display-only membership; indices always refer to the unchanged full structure. */
export interface MoleculeRegion { id:string;label:string;color:string;atomIndices:number[];style?:'ball'|'stick' }
const PALETTE=['#63a997','#779bda','#c28bb5','#d5a357','#8fa96b','#8c91c7','#ca8c75','#66a5bb','#b69d54','#a783c5','#70b4a3','#c4798e','#8badcf','#a5ac62','#b98a5a','#7c9f73','#aa85a0','#6e90b2','#c5aa7d','#849faa'];
export const fragmentColor=(index:number)=>PALETTE[((index%PALETTE.length)+PALETTE.length)%PALETTE.length];
export const fragmentRegions=(fragments:FragmentDefinition[]):MoleculeRegion[]=>fragments.map((fragment,index)=>({id:'fragment-'+(index+1),label:'Fragment '+(index+1),color:fragmentColor(index),atomIndices:fragment.atoms.map(atom=>atom-1)}));
export function regionMembership(atomCount:number,regions:MoleculeRegion[]){
  const memberships=Array.from({length:atomCount},()=>[] as MoleculeRegion[]);
  for(const region of regions)for(const index of new Set(region.atomIndices))if(Number.isSafeInteger(index)&&index>=0&&index<atomCount)memberships[index].push(region);
  return {memberships,unassigned:memberships.flatMap((items,index)=>items.length?[]:[index]),overlapping:memberships.flatMap((items,index)=>items.length>1?[index]:[])};
}
export function membershipColor(membership:MoleculeRegion[]){return membership.length>1?'#d96d78':membership[0]?.color??'#b8c1c9';}
