import type {Structure} from '../../core/types';
import {superposeViewAtoms} from '../../modeling/view-superposition';
import {identityTransform,type RigidTransform} from './render/alignment';

export type ConformerPlaybackReferenceMode='raw'|'fixed';
export interface ConformerPlaybackReferenceOptions {
 mode:ConformerPlaybackReferenceMode;
 /** One explicitly resolved rigid fragment. Absence never selects the whole molecule. */
 coreAtomIds?:readonly string[];
}
export interface ConformerPlaybackReference {
 readonly mode:ConformerPlaybackReferenceMode;
 readonly reference:Structure;
 readonly anchorAtomIds:readonly string[];
 readonly orientationUnique:boolean;
 readonly warnings:readonly string[];
 /** A simultaneous multiframe plan owns its own complete display transform. */
 transform(structure:Structure,options?:{multiframeActive?:boolean}):RigidTransform;
}
function immutableTransform(value:RigidTransform):RigidTransform{
 value.rotation.forEach(row=>Object.freeze(row));Object.freeze(value.rotation);Object.freeze(value.translation);Object.freeze(value.anchorIds);return Object.freeze(value);
}
/** Capture once per collection/reference selection. Fitting never adopts the
 * preceding displayed frame or changes anchors when a flexible end moves. */
export function createConformerPlaybackReference(source:Structure,options:ConformerPlaybackReferenceOptions):ConformerPlaybackReference {
 const reference=structuredClone(source),anchors=[...(options.coreAtomIds??[])],ids=new Map(reference.atoms.map(atom=>[atom.id,atom]));
 if(!['raw','fixed'].includes(options.mode))throw new Error('未知的构象播放参考模式。');
 const raw=immutableTransform(identityTransform());
 if(options.mode==='raw')return Object.freeze({mode:'raw',reference,anchorAtomIds:Object.freeze([] as string[]),orientationUnique:false,warnings:Object.freeze([] as string[]),transform:()=>raw});
 if(new Set(anchors).size!==anchors.length||anchors.some(id=>!ids.has(id)))throw new Error('播放固定端需要当前参考结构中唯一、有效的原子ID。');
 const selected=anchors.map(id=>ids.get(id)!),pairs=anchors.map(id=>({movingAtomId:id,referenceAtomId:id}));
 const quality=selected.length?superposeViewAtoms({movingAtoms:selected,referenceAtoms:selected,pairs,mappingConfirmed:true}):undefined;
 if(quality&&!quality.ok)throw new Error(quality.issues.map(issue=>issue.message).join('；')||'播放参考坐标无效。');
 const orientationUnique=!!quality?.ok&&quality.diagnostics.referenceRank>=2;
 const warnings:string[]=[];
 const mode=options.mode==='fixed'&&anchors.length?options.mode:'raw';
 if(options.mode==='fixed'&&!anchors.length)warnings.push('尚未选择固定端，保持原始坐标；未自动改用全分子拟合。');
 else if(options.mode==='fixed'&&!orientationUnique)warnings.push('固定端不足三个非共线原子，不能唯一固定姿态；仅采用确定的退化方向，不自动更换参考片段。');
 const cache=new WeakMap<object,RigidTransform>();
 for(const atom of reference.atoms)Object.freeze(atom);Object.freeze(reference.atoms);Object.freeze(reference);
 return Object.freeze({mode,reference,anchorAtomIds:Object.freeze(anchors),orientationUnique,warnings:Object.freeze(warnings),
  transform(structure:Structure,projection?:{multiframeActive?:boolean}){
   if(mode==='raw'||projection?.multiframeActive)return raw;
   const key=structure.atoms,ready=cache.get(key);if(ready)return ready;
   const immutable=Object.isFrozen(key)&&key.every(atom=>Object.isFrozen(atom));
   const current=new Map(structure.atoms.map(atom=>[atom.id,atom]));
   if(current.size!==structure.atoms.length||anchors.some(id=>!current.has(id)))throw new Error('当前帧与播放固定端的原子对应不一致。');
   const fit=superposeViewAtoms({movingAtoms:anchors.map(id=>current.get(id)!),referenceAtoms:selected,pairs,mappingConfirmed:true});
   if(!fit.ok)throw new Error(fit.issues.map(issue=>issue.message).join('；')||'当前帧的固定端无法显示拟合。');
   const transform=immutableTransform(fit.transform);if(immutable)cache.set(key,transform);return transform;
  }});
}

const references=new WeakMap<Structure,Map<string,ConformerPlaybackReference>>();
/** Compatibility seam. New collection owners use one explicit reference session. */
export function conformerFrameDisplayTransform(structure:Structure,reference:Structure,_previous?:RigidTransform,coreAtomIds?:readonly string[],policy:{mode?:ConformerPlaybackReferenceMode;multiframeActive?:boolean}={}):RigidTransform{
 const mode=policy.mode??'fixed';if(mode==='raw'||policy.multiframeActive)return identityTransform();
 const anchors=[...(coreAtomIds??[])];
 const key=JSON.stringify([mode,anchors]);let owned=references.get(reference);if(!owned){owned=new Map();references.set(reference,owned);}
 let session=owned.get(key);if(!session){session=createConformerPlaybackReference(reference,{mode,coreAtomIds:anchors});owned.set(key,session);}
 return session.transform(structure);
}
