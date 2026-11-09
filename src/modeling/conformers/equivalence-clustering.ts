import {conformerCalculationIdentityKey,type ConformerClusterSet,type ConformerOptimizationResult,type ConformerCluster,type ConformerClusterGroup,type ConformerClusteringProgress} from './clustering';
import {createElementGeometryComparer,ELEMENT_GEOMETRY_ALGORITHM} from './element-geometry';
import {elementCompositionKey,elementConstraintProfile,elementConstraintsMatch} from './element-constraints';
import {convertEnergy} from '../../results/energy';
import {superposeViewAtoms} from '../view-superposition';
export interface ConformerEquivalenceSummary{
 algorithmVersion:typeof ELEMENT_GEOMETRY_ALGORITHM;energyThresholdKcalMol:0.03;
 poolingVersion:'composition-identity-v1';
 ordinaryClusterCount:number;finalClusterCount:number;eligiblePairCount:number;radialRejectedPairCount:number;
 fixedEvidencePairCount:number;assignmentPairCount:number;unresolvedPairCount:number;
 unresolvedClusterCount:number;
 ordinaryClusters:{groupId:string;clusterId:string;representativeCandidateId:string;memberCandidateIds:string[]}[];
 ordinaryToFinal:{groupId:string;ordinaryClusterId:string;finalGroupId:string;finalClusterId:string}[];
 elapsedMs:number;preparationMs:number;
}
/** Only compares ordinary representatives to retained lower-energy centres.
 * Entire original membership is retained. No permutation is persisted. */
export function eliminateEquivalentClusters(result:ConformerClusterSet,records:readonly ConformerOptimizationResult[],onProgress?:(p:ConformerClusteringProgress)=>void){
 const started=performance.now(),matcher=createElementGeometryComparer(),threshold=convertEnergy({value:.03,unit:'kcal/mol'},'hartree')!;
 const ordinaryClusterCount=result.groups.reduce((n,g)=>n+g.clusters.length,0);
 const summary:ConformerEquivalenceSummary={algorithmVersion:ELEMENT_GEOMETRY_ALGORITHM,poolingVersion:'composition-identity-v1',energyThresholdKcalMol:.03,ordinaryClusterCount,finalClusterCount:0,eligiblePairCount:0,radialRejectedPairCount:0,fixedEvidencePairCount:0,assignmentPairCount:0,unresolvedPairCount:0,unresolvedClusterCount:0,
 ordinaryClusters:result.groups.flatMap(group=>group.clusters.map(cluster=>({groupId:group.id,clusterId:cluster.id,representativeCandidateId:cluster.representative.candidateId,memberCandidateIds:cluster.members.map(member=>member.candidateId)}))),ordinaryToFinal:[],elapsedMs:0,preparationMs:0};
 onProgress?.({phase:'eliminate-equivalent',completed:0,total:ordinaryClusterCount});
 const prepared=performance.now();for(const group of result.groups)for(const cluster of group.clusters)matcher.prepare(cluster.representative.structure);summary.preparationMs=performance.now()-prepared;
 const source=new Map(records.map(record=>[record.candidateId,record]));let completed=0;
 type Entry={origin:ConformerClusterGroup;cluster:ConformerCluster;constraints:ReturnType<typeof elementConstraintProfile>};
 const pools=new Map<string,Entry[]>();
 for(const origin of result.groups)for(const cluster of origin.clusters){
  const rep=cluster.representative,constraints=elementConstraintProfile(rep.structure,rep.constraints);
  // Ordinary graph/ID keys never enter this pool key. Constraint metadata is
  // only a coarse screen; each merging witness checks its physical definition.
  const key=JSON.stringify([conformerCalculationIdentityKey(rep.identity),elementCompositionKey(rep.structure),constraints.key]);
  const entries=pools.get(key)??[];entries.push({origin,cluster,constraints});pools.set(key,entries);
 }
 const finalGroups:ConformerClusterGroup[]=[];result.memberToCluster=[];
 for(const [key,entries]of [...pools].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  entries.sort((a,b)=>a.cluster.representative.energyHartree-b.cluster.representative.energyHartree||(a.cluster.representative.candidateId<b.cluster.representative.candidateId?-1:1));
  const retained:(Entry&{finalGroup:ConformerClusterGroup})[]=[],byOrigin=new Map<string,ConformerClusterGroup>();let windowStart=0;
  // Without physical constraints every record in this pool is scientifically
  // comparable. Constrained, unconfirmed records retain their ordinary groups;
  // only a verified mapping is allowed to transfer members across them.
  let commonGroup:ConformerClusterGroup|undefined;
  const makeGroup=(entry:Entry)=>{
   const rep=entry.cluster.representative,heavy=rep.structure.atoms.filter(atom=>atom.element!=='H');
   const group:ConformerClusterGroup={id:`element-group-${finalGroups.length+1}`,comparisonKey:key,comparisonSemantics:'element-geometry',identity:{...rep.identity},
    atomIds:rep.structure.atoms.map(atom=>atom.id!).sort(),fitAtomIds:(heavy.length?heavy:rep.structure.atoms).map(atom=>atom.id!).sort(),fitScope:heavy.length?'heavy-atoms':'all-atoms',rmsdMatching:'fixed',clusters:[]};
   finalGroups.push(group);return group;
  };
  for(const entry of entries){
   const ordinary=entry.cluster;
   const energy=ordinary.representative.energyHartree;
   while(windowStart<retained.length&&energy-retained[windowStart].cluster.representative.energyHartree>=threshold)windowStart++;
   let destination:(Entry&{finalGroup:ConformerClusterGroup})|undefined,unresolved=false;
   for(let i=windowStart;i<retained.length;i++){
    const candidate=retained[i];if(!(Math.abs(energy-candidate.cluster.representative.energyHartree)<threshold))continue;
    summary.eligiblePairCount++;
    // Numeric-range failures or a bounded search that cannot certify a witness
    // retain the original cluster; they never justify a merge or data loss.
    let fit:ReturnType<typeof matcher.compare>;
    try{fit=entry.constraints.kind==='unresolved'||candidate.constraints.kind==='unresolved'
      ?{matched:false,rmsdAngstrom:null,route:'incompatible',iterations:0}
      :matcher.compare(ordinary.representative.structure,candidate.cluster.representative.structure,result.policy.rmsdThresholdAngstrom,
        pairs=>elementConstraintsMatch(entry.constraints,candidate.constraints,pairs));}
    catch{fit={matched:false,rmsdAngstrom:null,route:'unresolved',iterations:0};}
    if(fit.route==='radial-rejected')summary.radialRejectedPairCount++;
    else if(fit.route==='fixed')summary.fixedEvidencePairCount++;
    else if(fit.route==='assignment')summary.assignmentPairCount++;
    else {if(fit.route==='unresolved')summary.assignmentPairCount++;summary.unresolvedPairCount++;unresolved=true;}
    if(fit.matched){destination=candidate;break;}
   }
   if(!destination){
    let finalGroup:ConformerClusterGroup;
    if(entry.constraints.kind==='unconstrained')finalGroup=commonGroup??(commonGroup=makeGroup(entry));
    else {finalGroup=byOrigin.get(entry.origin.id)??makeGroup(entry);byOrigin.set(entry.origin.id,finalGroup);}
    finalGroup.clusters.push(ordinary);destination={...entry,finalGroup};retained.push(destination);if(unresolved)summary.unresolvedClusterCount++;
   }
   else{
    const target=destination.cluster,existing=new Set(target.members.map(m=>m.candidateId));
    for(const member of ordinary.members)if(!existing.has(member.candidateId)){
     const structure=source.get(member.candidateId)?.structure,reference=target.representative.structure;
     const heavy=structure?.atoms.filter(a=>a.element!=='H'),refHeavy=reference.atoms.filter(a=>a.element!=='H');
     const fit=heavy?.length?superposeViewAtoms({movingAtoms:heavy,referenceAtoms:refHeavy,pairs:heavy.map(a=>({movingAtomId:a.id!,referenceAtomId:a.id!})),mappingConfirmed:true}):undefined;
     target.members.push({...member,rmsdToRepresentativeAngstrom:fit?.ok?fit.rmsd:null});existing.add(member.candidateId);
    }
   }
   summary.ordinaryToFinal.push({groupId:entry.origin.id,ordinaryClusterId:ordinary.id,finalGroupId:destination.finalGroup.id,finalClusterId:destination.cluster.id});
   onProgress?.({phase:'eliminate-equivalent',completed:++completed,total:ordinaryClusterCount});
  }
 }
 result.groups=finalGroups;
 for(const group of finalGroups){summary.finalClusterCount+=group.clusters.length;for(const cluster of group.clusters)for(const member of cluster.members)result.memberToCluster.push({candidateId:member.candidateId,groupId:group.id,clusterId:cluster.id,representativeCandidateId:cluster.representative.candidateId});}
 summary.elapsedMs=performance.now()-started;result.equivalence=summary;
}
