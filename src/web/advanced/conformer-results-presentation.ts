import type {AdvancedResultFrame,AdvancedTaskRun,AdvancedClusterCollection} from '../../modeling/advanced/contracts';
import {estimateConformerPopulations,conformerCalculationIdentityKey} from '../../modeling/conformers';
import {convertEnergy,type EnergyUnit} from '../../results/energy';
import {formatResultValue} from '../../results/numeric-format';
import type {ScientificTableProjection} from '../results/scientific-table';
export interface ConformerDisplayCollection {id:string;label:string;frames:readonly AdvancedResultFrame[];clusterCollection?:AdvancedClusterCollection;playbackAvailable?:boolean}

export const CONFORMER_VISIBLE_ROWS=25;
export type ConformerResultSort='energy'|'frame';
const energyUnitLabel=(unit:EnergyUnit)=>unit==='kJ/mol'?'kJ·mol⁻¹':unit==='kcal/mol'?'kcal·mol⁻¹':unit==='hartree'?'Eh':unit;

/** Only the producing sampling record can supply these values. Optimizer
 * energies, requested temperatures and terminal averages are not substitutes. */
export function conformerSamplingCells(frame:AdvancedResultFrame,options:{decimals:number;unit:EnergyUnit}):string[]{
  const sample=frame.process?.kind==='sampling'?frame.process.data:undefined;
  const temperature=sample?.temperatureK,potential=sample?.sampledPotentialEV;
  const biases=sample?[sample.coreBiasEV,sample.metaBiasEV,sample.sphereBiasEV]:[];
  const bias=biases.some(value=>Number.isFinite(value)&&value!==0)?'含偏置':sample?.nativeMD?.energyDefinition==='native-total-including-sampling-potentials'?'含偏置项（未分解）':sample&&biases.every(value=>Number.isFinite(value))?'无偏置':'';
  return [Number.isFinite(temperature)?formatResultValue(temperature!,options.decimals):'',
    Number.isFinite(potential)?formatResultValue(convertEnergy({value:potential!,unit:'eV'},options.unit),options.decimals):'',bias];
}
/** Missing optional values do not create empty columns or synthetic observations. */
function populatedColumns(projection:ScientificTableProjection):ScientificTableProjection {
  const indices=projection.columns.map((_,index)=>index).filter(index=>index===0||projection.rows.some(row=>row.cells[index]!==''));
  return {columns:indices.map(index=>projection.columns[index]),rows:projection.rows.map(row=>({...row,cells:indices.map(index=>row.cells[index])}))};
}
/** Keep stable selection identities while using the current display order once, at entry. */
export function selectedConformerFrames(frames:readonly AdvancedResultFrame[],ids:ReadonlySet<string>):AdvancedResultFrame[]{
  return frames.filter(frame=>ids.has(frame.id));
}
export function conformerResultFrames(frames:readonly AdvancedResultFrame[],sort:ConformerResultSort='energy',direction:'asc'|'desc'='asc'){
  const optimized=frames.length>0&&frames.every(frame=>frame.kind==='optimized');
  if(!optimized)return [...frames];
  const indexed=frames.map((frame,index)=>({frame,index}));
  indexed.sort((a,b)=>{const av=a.frame.energyHartree,bv=b.frame.energyHartree;
    const delta=sort==='energy'?(Number.isFinite(av)&&Number.isFinite(bv)?av!-bv!:Number.isFinite(av)?-1:Number.isFinite(bv)?1:0):a.index-b.index;
    return (direction==='asc'?1:-1)*delta||a.index-b.index;});
  return indexed.map(row=>row.frame);
}

/** Build from the full immutable collection before applying the 25-row view limit. */
export function conformerResultProjection(collection:ConformerDisplayCollection,run:AdvancedTaskRun|undefined,options:{decimals:number;unit:EnergyUnit;temperatureK:number;sort:ConformerResultSort;direction:'asc'|'desc'},displayOrder?:readonly AdvancedResultFrame[]){
  if(collection.clusterCollection){
    const clusterCollection=collection.clusterCollection,clusters=clusterCollection.clusters,frameMap=new Map(collection.frames.map(frame=>[frame.id,frame]));
    const frames=clusters.flatMap(row=>!row.unavailableReason&&row.representativeFrameId&&frameMap.has(row.representativeFrameId)?[frameMap.get(row.representativeFrameId)!]:[]);
    const minimum=clusterCollection.comparison?Math.min(...clusters.map(row=>row.energyHartree??Infinity)):null;
    // The producer's complete scientific group owns the denominator. Display,
    // checkboxes, row folding and receiving-stage N/stride never define it.
    const comparison=clusterCollection.comparison,stage=run?.id===clusterCollection.producerRunId?run.stages.find(row=>row.id===clusterCollection.stageRunId):undefined;
    const groups=stage?.clustering?.groups??[],group=groups.length===1&&comparison&&groups[0].id===comparison.groupId&&groups[0].comparisonKey===comparison.comparisonKey&&conformerCalculationIdentityKey(groups[0].identity)===conformerCalculationIdentityKey(comparison.identity)?groups[0]:undefined;
    const scientificClusters=new Map(group?.clusters.map(cluster=>[cluster.id,cluster]));
    const complete=!!group&&clusterCollection.settlement==='complete'&&clusters.length===group.clusters.length&&new Set(clusters.map(row=>row.clusterId)).size===clusters.length&&clusters.every(row=>{
      const cluster=scientificClusters.get(row.clusterId);
      return !row.unavailableReason&&cluster&&row.representativeCandidateId===cluster.representative.candidateId&&row.energyHartree===cluster.representative.energyHartree&&row.memberCandidateIds.length===cluster.members.length&&new Set(row.memberCandidateIds).size===cluster.members.length&&cluster.members.every(member=>row.memberCandidateIds.includes(member.candidateId));
    });
    let populations:ReturnType<typeof estimateConformerPopulations>|undefined;
    if(complete){try{populations=estimateConformerPopulations(group!,options.temperatureK,options.unit);}catch{/* Preserve readable energies when the scientific group cannot be estimated. */}}
    const values=new Map(populations?.populations.map(row=>[row.representativeCandidateId,row]));
    const projection:ScientificTableProjection={columns:[{key:'cluster',label:'簇序号'},{key:'members',label:'成员数'},{key:'absolute',label:'绝对能量 / Eh',precision:'source'},{key:'relative',label:`相对能量 / ${energyUnitLabel(options.unit)}`,precision:'adjustable'},{key:'weight',label:'权重 / %',precision:'adjustable'},{key:'population',label:'玻尔兹曼占比 / %',precision:'adjustable'},{key:'availability',label:'状态'}],rows:clusters.map((row,index)=>{const value=values.get(row.representativeCandidateId);return {key:row.clusterId,cells:[String(index+1),row.memberCount===null?'':String(row.memberCount),row.energyHartree===null?'':String(row.energyHartree),minimum!==null&&row.energyHartree!==null?formatResultValue(convertEnergy({value:row.energyHartree-minimum,unit:'hartree'},options.unit),options.decimals):'',value?formatResultValue(value.weight*100,options.decimals):'',value?formatResultValue(value.fraction*100,options.decimals):'',row.unavailableReason??'']};})};
    return {frames,optimized:true,projection:populatedColumns(projection),energyLabel:!comparison?'':comparison.identity.energyKind==='forcefield-potential'?'力场势能 · 势能估算':'电子能量',populationMessage:''};
  }
  const optimized=collection.frames.length>0&&collection.frames.every(frame=>frame.kind==='optimized');
  const originals=new Map(collection.frames.map(frame=>[frame.id,frame]));
  if(displayOrder&&(displayOrder.length!==collection.frames.length||new Set(displayOrder.map(frame=>frame.id)).size!==originals.size||displayOrder.some(frame=>!originals.has(frame.id))))throw Error('显示顺序必须完整覆盖同一真实帧集合。');
  const frames=conformerResultFrames(displayOrder?displayOrder.map(frame=>originals.get(frame.id)!):collection.frames,options.sort,options.direction);
  const ordinals=new Map(collection.frames.map((frame,index)=>[frame.id,index+1]));
  if(frames.length&&frames.every(frame=>frame.kind==='intermediate'))return{frames,optimized:false,projection:populatedColumns({columns:[{key:'frame',label:'帧'},{key:'interruptedEnergy',label:'中间能量 / Eh（未收敛）',precision:'source'}],rows:frames.map(frame=>({key:frame.id,cells:[String(ordinals.get(frame.id)),Number.isFinite(frame.energyHartree)?String(frame.energyHartree):'']}))}),energyLabel:'中断末态 · 未收敛，不作为有效优化或晋级结果',populationMessage:''};
  if(!optimized)return {frames,optimized,projection:populatedColumns({columns:[{key:'frame',label:'帧'},{key:'temperature',label:'温度 / K',precision:'adjustable'},{key:'sampledPotential',label:`采样势能 / ${energyUnitLabel(options.unit)}`,precision:'adjustable'},{key:'bias',label:'偏置'}],rows:frames.map(frame=>({key:frame.id,cells:[String(ordinals.get(frame.id)),...conformerSamplingCells(frame,options)]}))}),energyLabel:'',populationMessage:''};
  const stageIds=new Set(frames.map(frame=>frame.stageId)),frameIds=new Set(frames.map(frame=>frame.id));
  const stage=run?.stages.find(stage=>stageIds.size===1&&stage.id===frames[0].stageId
    || stage.results.some(result=>result.reusedFromRunId)&&(()=>{const ids=new Set(stage.results.map(result=>result.frameId));return [...frameIds].every(id=>ids.has(id));})());
  const groups=stage?.clustering?.groups??[];
  const candidateIds=new Set(frames.map(frame=>frame.candidateId));
  const candidates=new Map(frames.map(frame=>[frame.candidateId,frame]));
  const resultsByFrame=new Map([...(run?.results??[]),...(stage?.results??[])].map(result=>[result.frameId,result]));
  // Membership and its original input/energy bind a frame to an actual scientific
  // comparison group. A shared energy kind alone does not establish comparability.
  const comparableGroups=candidateIds.size===frames.length?groups.filter(value=>{
    const identity=conformerCalculationIdentityKey(value.identity),members=new Map(value.clusters.flatMap(cluster=>cluster.members.map(member=>[member.candidateId,member] as const)));
    if(value.clusters.some(cluster=>conformerCalculationIdentityKey(cluster.representative.identity)!==identity))return false;
    return frames.every(frame=>{const member=members.get(frame.candidateId),result=resultsByFrame.get(frame.id),parent=frame.parentRef;
      return member&&Number.isFinite(frame.energyHartree)&&member.energyHartree===frame.energyHartree
        &&member.source.documentId===parent.documentId&&member.source.revision===parent.revision&&member.source.frameId===parent.frameId&&member.source.sourceId===parent.sourceId
        &&(!result?.identity||conformerCalculationIdentityKey(result.identity)===identity);
    });
  }):[];
  const comparableGroup=comparableGroups.length===1?comparableGroups[0]:undefined;
  const group=comparableGroup&&comparableGroup.clusters.length===frames.length&&comparableGroup.clusters.every(cluster=>candidates.get(cluster.representative.candidateId)?.energyHartree===cluster.representative.energyHartree)?comparableGroup:undefined;
  let populations:ReturnType<typeof estimateConformerPopulations>|undefined,populationMessage='缺少本级完整可比组，未估算比例。';
  if(group){try{populations=estimateConformerPopulations(group,options.temperatureK,options.unit);populationMessage='';}catch(error){populationMessage=error instanceof Error?error.message:'当前集合不可估算比例。';}}
  const values=new Map(populations?.populations.map(row=>[row.representativeCandidateId,row]));
  const kinds=new Set(frames.map(frame=>resultsByFrame.get(frame.id)?.identity?.energyKind));
  const kind=comparableGroup?.identity.energyKind??(kinds.size===1?[...kinds][0]:undefined);
  const energyLabel=kind==='forcefield-potential'?'力场势能 · 势能估算':kind==='electronic'?'电子能量':'';
  const minimum=comparableGroup?frames.reduce((value,frame)=>Math.min(value,frame.energyHartree!),Infinity):null;
  const projection:ScientificTableProjection={columns:[{key:'frame',label:'构象'},{key:'absolute',label:'绝对能量 / Eh',precision:'source'},{key:'relative',label:`相对能量 / ${energyUnitLabel(options.unit)}`,precision:'adjustable'},{key:'weight',label:'权重 / %',precision:'adjustable'},{key:'population',label:'玻尔兹曼占比 / %',precision:'adjustable'}],rows:frames.map(frame=>{
    const value=values.get(frame.candidateId),relative=value?.relativeEnergy??(minimum!==null&&Number.isFinite(frame.energyHartree)?convertEnergy({value:frame.energyHartree!-minimum,unit:'hartree'},options.unit):null);
    return{key:frame.id,cells:[String(ordinals.get(frame.id)),Number.isFinite(frame.energyHartree)?String(frame.energyHartree):'',relative===null?'':formatResultValue(relative,options.decimals),value?formatResultValue(value.weight*100,options.decimals):'',value?formatResultValue(value.fraction*100,options.decimals):'']};
  })};
  return {frames,optimized,projection:populatedColumns(projection),energyLabel,populationMessage};
}
