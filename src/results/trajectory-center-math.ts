import type {Structure} from '../core/types';
import {superposeViewAtoms} from '../modeling/view-superposition';
import {playbackCollectionComplete,type PlaybackCollection} from './playback-collection';

export const TRAJECTORY_CENTER_ALGORITHM='proper-rmsd-medoid-v1';
export interface CenterProgress {completedPairs:number;totalPairs:number}
export interface TrajectoryCenterResult {frameId:string;meanRmsd:number;cacheKey:string;comparedPairs:number}
export interface CenterResourcePort {acquire(id:string):Promise<{threads:number}>;cancel(id:string):Promise<void>;release(id:string):Promise<void>}
export interface CenterInput {collection:PlaybackCollection;structures:readonly Structure[];fitAtoms:'heavy'|'all'}
export function centerCacheKey(input:CenterInput){const c=input.collection;return JSON.stringify([c.identity,c.atomCorrespondenceKey,c.frames.map(frame=>frame.frameId),input.fitAtoms,TRAJECTORY_CENTER_ALGORITHM]);}
export function centerAtomIds(structure:Structure,fitAtoms:'heavy'|'all'){
 const ids=structure.atoms.filter(atom=>fitAtoms==='all'||atom.element!=='H').map(atom=>atom.id!);
 if(!ids.length)throw Error('当前集合没有重原子；请选择全部原子。');return ids;
}
/** Exact fixed-correspondence geometry only. No energy, atom permutation,
 * trajectory unwrapping, sampling or clustering algorithm is introduced. */
export function centerPairRmsd(a:Structure,b:Structure,ids:readonly string[]){
 const selected=new Set(ids),fit=superposeViewAtoms({movingAtoms:a.atoms.filter(atom=>selected.has(atom.id!)),referenceAtoms:b.atoms.filter(atom=>selected.has(atom.id!)),pairs:ids.map(id=>({movingAtomId:id,referenceAtomId:id})),mappingConfirmed:true});
 if(!fit.ok)throw Error(fit.issues.map(issue=>issue.message).join(' '));return fit.rmsd;
}
export function validateCenterInput(input:CenterInput){
 const {collection,structures}=input;
 if(!collection.fixed)throw Error('增长中的集合不能寻找自动中心帧；暂停播放不会固定科学来源。');
 if(!playbackCollectionComplete(collection)||structures.length!==collection.frames.length)throw Error('自动中心帧需要完整载入并校验的全部集合。');
 if(!structures.length)throw Error('空集合没有自动中心帧。');
 if(!Number.isSafeInteger(structures.length*(structures.length-1)/2))throw Error('精确比较总数超出安全整数表示范围。');
 return centerAtomIds(structures[0],input.fitAtoms);
}
export function centerFromSums(input:CenterInput,sums:Float64Array,comparedPairs:number):TrajectoryCenterResult {
 const n=input.structures.length,total=n*(n-1)/2;
 if(comparedPairs!==total||sums.length!==n||[...sums].some(value=>!Number.isFinite(value)))throw Error('中心帧比较尚未完整结束。');
 let selected=0;for(let i=1;i<n;i++)if(sums[i]<sums[selected])selected=i;
 return{frameId:input.collection.frames[selected].frameId,meanRmsd:n===1?0:sums[selected]/(n-1),cacheKey:centerCacheKey(input),comparedPairs};
}
/** Controlled mathematical oracle; production computation uses the cancellable
 * worker owner below. Callers must explicitly request it. */
export function exactTrajectoryCenter(input:CenterInput):TrajectoryCenterResult {
 const ids=validateCenterInput(input),sums=new Float64Array(input.structures.length);let count=0;
 for(let i=0;i<sums.length;i++)for(let j=i+1;j<sums.length;j++){const d=centerPairRmsd(input.structures[i],input.structures[j],ids);sums[i]+=d;sums[j]+=d;count++;}
 return centerFromSums(input,sums,count);
}
