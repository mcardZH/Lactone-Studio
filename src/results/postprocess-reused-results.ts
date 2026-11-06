import type {ResultInputFile,TrajectoryResult} from './contracts';
import {assertResultNotAborted} from './contracts';
import {getPreparedTrajectoryFrame,preparedFrameMetadata,registerPreparedTrajectoryProjection} from './prepared-trajectory';
import {createScientificStructureMetadata} from './scientific-structure-metadata';
import type {ScientificData} from './scientific-contracts';

/** Internal capability transferred only after the composition layer proves the
 * exact snapshot/publication boundary and complete scientific job coverage. */
export interface PostprocessParsedResultsLease {results:readonly TrajectoryResult[];release():void}
function bindScience(science:ScientificData,file:ResultInputFile,oldIds:ReadonlySet<string>){
 science.source={...science.source,id:file.id,name:file.name};
 const bind=(value:{sourceId?:string;sourceName?:string})=>{if(!value.sourceId||oldIds.has(value.sourceId)){value.sourceId=file.id;value.sourceName=file.name;}};
 for(const field of [...science.summary,...science.properties,...science.thermochemistry,...science.stability,...science.bsse,...science.atomicProperties,...science.scfCycles])bind(field);
 for(const channel of science.orbitals){bind(channel);for(const row of channel.orbitals)bind(row);}
 for(const block of science.nmrCouplings??[]){bind(block);for(const value of block.values)bind(value);}
 for(const vibration of new Set([science.vibrations,...science.vibrationSets??[]].filter(value=>value!==undefined))){bind(vibration);for(const mode of vibration.modes)for(const row of mode.rawCartesianComponents??[])bind(row);}
 for(const iteration of science.pathIterations??[])for(const field of iteration.fields)bind(field);
 for(const step of science.mdSteps??[]){bind(step);for(const field of [step.time,step.potentialEnergy,step.kineticEnergy,step.totalEnergy,step.temperature,step.scfIterations])if(field){bind(field);if(field.unitEvidence)bind(field.unitEvidence);}}
 for(const difference of science.mdSourceDifferences??[])for(const field of difference.values){bind(field);if(field.unitEvidence)bind(field.unitEvidence);}
}
/** New mutable metadata and independent disposal over an existing resident
 * geometry owner. No original monitor result is enriched or disposed here. */
export async function projectPostprocessParsedResults(file:ResultInputFile,lease:PostprocessParsedResultsLease):Promise<TrajectoryResult[]>{
 const projections:TrajectoryResult[]=[];let remaining=lease.results.length,released=false,closedInput=false,pendingClose:Promise<void>|undefined;
 const release=()=>{if(closedInput)return Promise.resolve();if(pendingClose)return pendingClose;pendingClose=(async()=>{try{await file.close?.();closedInput=true;}finally{if(!released){released=true;lease.release();}}})().finally(()=>{pendingClose=undefined;});return pendingClose;};
 try{
  if(!remaining)throw Error('复用科学结果集合为空。');
  for(const [ordinal,parent]of lease.results.entries()){
   if((parent.engine!=='gaussian'&&parent.engine!=='orca')||parent.source.size!==file.size||!parent.frames.length||!parent.scientific)throw Error('复用科学结果与固定来源或已读取能力不一致。');
   const {getFrame:_get,dispose:_dispose,...metadata}=parent,value=structuredClone(metadata),id=`${file.id}:scientific-reuse:${ordinal}`;
   const oldIds=new Set([parent.source.id,...(parent.scientific.source?.id?[parent.scientific.source.id]:[])]);bindScience(value.scientific!,file,oldIds);
   const anchor=(source:{id:string;name:string})=>{if(oldIds.has(source.id)){source.id=file.id;source.name=file.name;}};
   for(const frame of value.frames){for(const observation of frame.energyObservations??[])anchor(observation.source);if(frame.energyAssociation)anchor(frame.energyAssociation.source);if(frame.geometryAssociation){anchor(frame.geometryAssociation.source);anchor(frame.geometryAssociation.evidenceSource);}}
   const applyMetadata=createScientificStructureMetadata({engine:parent.engine,data:value.scientific!,jobIndex:parent.jobIndex,charge:value.initialStructure.charge,multiplicity:value.initialStructure.multiplicity,name:file.name,resultId:id});
   const initialStructure=applyMetadata(value.initialStructure,0,value.frames[0].sourceLine);let closed=false;
   const projection:TrajectoryResult={...value,id,source:{...value.source,id:file.id,name:file.name,size:file.size},label:`${file.name} · ${value.scientific!.tasks.join(' / ').toUpperCase()||'结果'} · job ${parent.jobIndex+1}`,initialStructure,
    async getFrame(index,signal){assertResultNotAborted(signal);if(closed)throw Error('后处理固定结果已关闭。');if(!Number.isSafeInteger(index)||index<0||index>=value.frames.length)throw Error('后处理固定结果帧序号越界。');const prepared=getPreparedTrajectoryFrame(parent,index),structure=prepared?structuredClone(prepared.raw):await parent.getFrame(index,signal);assertResultNotAborted(signal);if(closed)throw Error('后处理固定结果已关闭。');return applyMetadata(structure,index,value.frames[index].sourceLine);},
    async dispose(){if(!closed){closed=true;remaining--;}if(remaining===0)await release();}
   };
   registerPreparedTrajectoryProjection(parent,projection,parent.frames.map((_,index)=>index),(frame,index)=>preparedFrameMetadata(applyMetadata({...frame.raw},index,value.frames[index].sourceLine)));projections.push(projection);
  }
  return projections;
 }catch(error){await Promise.all(projections.map(result=>Promise.resolve(result.dispose())));try{await release();}catch(closeError){throw new AggregateError([error,closeError],'固定结果接入失败，来源关闭需要重试。');}throw error;}
}
