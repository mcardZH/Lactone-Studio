import type {AdvancedMixedSamplingDefinition} from './contracts';
import type {AdvancedFrameSource} from './frame-source';
import {effectiveSharedFreezes} from '../constraints';
import {coordinatesFingerprint} from '../../core/modeling/graph';
import {getConformerSamplingCapability,NATIVE_CONFORMER_CORE_PROTECTION} from './sampling-contracts';
import type {AdvancedSamplingTaskOptions} from './contracts';

/** A run owns its reference and both independent selections. The raw MD frame
 * and its energy remain untouched; restoration is a derived display/input. */
export interface ConformerProtectionSnapshot {
  schema:1;
  mode?:'shared-freeze';
  reference:AdvancedFrameSource;
  hardFrozenAtomIds:string[];
  softProtectionEnabled:boolean;
  softProtectedAtomIds:string[];
  restorationAtomIds:string[];
  relativeConstraint:'none'|'single-atom-no-pair'|'pairwise-distance';
}
export function resolveConformerProtection(source:AdvancedFrameSource,definition:Pick<AdvancedMixedSamplingDefinition,'protectionMode'|'coreProtectionEnabled'|'protectedAtomIds'|'coreProtection'|'nativeProtection'>={}):ConformerProtectionSnapshot {
  if(definition.protectionMode!==undefined&&definition.protectionMode!=='shared-freeze')throw Error('构象保护模式不受支持。');
  const hard=[...effectiveSharedFreezes(source.constraints).frozenAtomIds];
  const shared=definition.protectionMode==='shared-freeze';
  const defined=definition.protectedAtomIds??definition.nativeProtection?.core?.atomIds??definition.coreProtection?.atomIds??hard;
  const enabled=!shared&&(definition.coreProtectionEnabled??defined.length>0);
  const soft=enabled?[...defined]:[];
  const ids=new Set(source.structure.atoms.map(atom=>atom.id));
  if(new Set(hard).size!==hard.length||new Set(soft).size!==soft.length||[...hard,...soft].some(id=>!ids.has(id)))throw Error('构象冻结或已启用保护集合不匹配当前初猜原子身份。');
  const restoration=[...new Set([...hard,...soft])];
  // References are lightweight projections sharing the immutable scientific
  // structure, never recursively nested prepared-input provenance.
  const {samplingPreparation:_,protection:__,...reference}=source;
  return{schema:1,...(shared?{mode:'shared-freeze' as const}:{}),reference,hardFrozenAtomIds:hard,softProtectionEnabled:enabled,softProtectedAtomIds:soft,restorationAtomIds:restoration,
    relativeConstraint:restoration.length>1?'pairwise-distance':restoration.length?'single-atom-no-pair':'none'};
}
export function conformerProtectionKey(snapshot:ConformerProtectionSnapshot):string {
  return JSON.stringify([...(snapshot.mode?[snapshot.mode]:[]),snapshot.hardFrozenAtomIds.slice().sort(),snapshot.softProtectionEnabled,snapshot.softProtectedAtomIds.slice().sort(),
    coordinatesFingerprint(snapshot.reference.structure)]);
}
/** Explicit new-run interpretation; does not convert stored legacy selections
 * into hard freezes or mutate historical definitions. */
export function sharedFreezeRunDefinition(definition:AdvancedMixedSamplingDefinition):AdvancedMixedSamplingDefinition{
 return {...definition,protectionMode:'shared-freeze'};
}
export function conformerTaskSharedFreezeRequiresFormat6(task:import('./contracts').AdvancedTaskRecord):boolean{
 const mode=(definition:AdvancedMixedSamplingDefinition|undefined)=>definition?.protectionMode==='shared-freeze';
 return mode(task.mixedSampling?.draft)||(task.spec.kind==='sampling'&&mode(task.spec.mixedSampling))
  ||(task.mixedSampling?.batches??[]).some(batch=>mode(batch.definition))
  ||task.runs.some(run=>mode(run.mixedSampling?.definition)||run.protection?.mode==='shared-freeze'
    ||run.frames.some(frame=>frame.samplingOrigin?.protection?.mode==='shared-freeze'||frame.source.protection?.mode==='shared-freeze'||frame.source.samplingPreparation?.protection?.mode==='shared-freeze'));
}
/** Resolve one fresh run without changing the card/draft or its stored values. */
export function conformerSamplingProtectionOptions(options:AdvancedSamplingTaskOptions,definition:AdvancedMixedSamplingDefinition,source:AdvancedFrameSource){
  const protection=resolveConformerProtection(source,definition),result=structuredClone(options);
  result.coreProtection=undefined;result.nativeProtection=undefined;result.sphere=undefined;
  if(getConformerSamplingCapability(result).driver==='native-xtb-md'){
    const native=structuredClone(definition.nativeProtection??{});delete native.core;
    if(protection.restorationAtomIds.length>=2){
      // Preserve the existing two supported profiles and units. A disabled
      // soft-core draft does not supply parameters for the independent F set.
      const strength=protection.softProtectionEnabled?(definition.nativeProtection?.core?.forceConstantEVPerAngstrom2??definition.coreProtection?.forceConstantEVPerAngstrom2):undefined;
      native.core={kind:'pairwise-distance',atomIds:[...protection.restorationAtomIds],forceConstantEVPerAngstrom2:strength??NATIVE_CONFORMER_CORE_PROTECTION.forceConstantKJMolNm2/9648.533212331};
    }
    if(definition.sphere)native.sphere={kind:'polynomial',centerAngstrom:[...definition.sphere.centerAngstrom],radiusAngstrom:definition.sphere.radiusAngstrom,exponent:30};
    if(native.core||native.sphere)result.nativeProtection=native;
  }else{
    if(protection.softProtectedAtomIds.length)result.coreProtection={...structuredClone(definition.coreProtection),atomIds:[...protection.softProtectedAtomIds],
      ...(definition.coreProtection?.forceConstantEVPerAngstrom2!==undefined?{forceConstantEVPerAngstrom2:definition.coreProtection.forceConstantEVPerAngstrom2}:{})};
    result.sphere=structuredClone(definition.sphere);
  }
  if(result.operation==='spherical-md'&&!result.sphere)throw Error('此采样卡需要共享球形范围，请按当前初猜确认球心。');
  return{options:result,protection};
}
export function conformerTaskProtectionRequiresFormat5(task:import('./contracts').AdvancedTaskRecord):boolean {
  const definition=(value:AdvancedMixedSamplingDefinition|undefined,_source?:AdvancedFrameSource)=>typeof value?.coreProtectionEnabled==='boolean';
  return definition(task.mixedSampling?.draft,task.spec.source)||task.spec.kind==='sampling'&&definition(task.spec.mixedSampling,task.spec.source)
    ||(task.mixedSampling?.batches??[]).some(batch=>definition(batch.definition))
    ||task.runs.some(run=>definition(run.mixedSampling?.definition)||!!run.protection?.restorationAtomIds.length
      ||run.frames.some(frame=>!!frame.samplingOrigin?.protection?.restorationAtomIds.length||!!frame.source.protection?.restorationAtomIds.length||!!frame.source.samplingPreparation?.protection?.restorationAtomIds.length));
}
