import type {Structure,Vector3} from '../../core/types';
import {superposeViewAtoms} from '../view-superposition';

export class SamplingCandidatePreparationError extends Error {}

/** Rigidly move the entire raw candidate before restoring its protected core.
 * The returned structure is a new optimization input; raw trajectory is intact. */
export function prepareSamplingOptimization(raw:Structure,initial:Structure,protectedIds:readonly string[]){
  const ids=new Set(protectedIds),reference=new Map(initial.atoms.map(atom=>[atom.id,atom]));
  if(ids.size!==protectedIds.length||!ids.size||protectedIds.some(id=>!reference.has(id)))
    throw Error('采样优化参考结构的保护原子身份无效。');
  if(raw.atoms.length!==initial.atoms.length||new Set(raw.atoms.map(atom=>atom.id)).size!==raw.atoms.length)
    throw new SamplingCandidatePreparationError('采样候选的原子数或原子身份重复，未启动优化。');
  const invalid=raw.atoms.find(atom=>!atom.id||reference.get(atom.id)?.element!==atom.element||![atom.x,atom.y,atom.z].every(Number.isFinite));
  if(invalid)throw new SamplingCandidatePreparationError(`采样候选原子 ${invalid.id??'未知'} 的身份或坐标无效，未启动优化。`);
  const core=raw.atoms.filter(atom=>ids.has(atom.id!));
  const fit=superposeViewAtoms({movingAtoms:core,referenceAtoms:initial.atoms.filter(atom=>ids.has(atom.id!)),
    mappingConfirmed:true,pairs:protectedIds.map(id=>({movingAtomId:id,referenceAtomId:id}))});
  if(!fit.ok)throw new SamplingCandidatePreparationError(fit.issues.map(issue=>issue.message).join('；'));
  const {rotation,translation}=fit.transform;
  const result=structuredClone(raw);result.preparation=undefined;result.molfile=undefined;
  let maxResidual=0;
  result.atoms=result.atoms.map(atom=>{
    const point=[atom.x,atom.y,atom.z];
    const moved=rotation.map((row,i)=>row.reduce((sum,v,j)=>sum+v*point[j],translation[i])) as Vector3;
    if(!moved.every(Number.isFinite))throw new SamplingCandidatePreparationError(`采样候选原子 ${atom.id} 叠合产生非有限坐标，未启动优化。`);
    if(ids.has(atom.id!)){const original=reference.get(atom.id!)!;maxResidual=Math.max(maxResidual,Math.hypot(moved[0]-original.x,moved[1]-original.y,moved[2]-original.z));return{...atom,x:original.x,y:original.y,z:original.z};}
    return{...atom,x:moved[0],y:moved[1],z:moved[2]};
  });
  // A rigid fit preserves all distances. Compare against the raw pair to
  // identify overlaps introduced by exact core restoration.
  for(let i=0;i<result.atoms.length;i++)for(let j=0;j<i;j++){
    if(!ids.has(result.atoms[i].id!)&&!ids.has(result.atoms[j].id!))continue;
    const a=result.atoms[i],b=result.atoms[j];
    if(Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)>=.2)continue;
    const beforeA=raw.atoms[i],beforeB=raw.atoms[j];
    if(Math.hypot(beforeA.x-beforeB.x,beforeA.y-beforeB.y,beforeA.z-beforeB.z)>=.2)
      throw new SamplingCandidatePreparationError(`恢复保护核心后原子 ${a.id} 与 ${b.id} 间距小于 0.2 Å，该候选未启动优化。`);
  }
  return{structure:result,fitRmsdAngstrom:fit.rmsd,maxResidualAngstrom:maxResidual,
    rotationAmbiguous:fit.diagnostics.rotationAmbiguous,protectedAtomIds:[...protectedIds],transform:fit.transform};
}
