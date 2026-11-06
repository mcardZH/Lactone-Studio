import type {Structure} from '../../core/types';
import {builderCoordinateValue} from '../../core/builder-geometry';
import {inspectConformerTorsion,inspectManualConformerTorsion,normalizeTorsionDegrees,rotateConformerTorsion,type ConformerSnapshot,type ConformerTorsion} from './geometry';

export interface ConformerTorsionHierarchy {
  coreAtomIds:string[];
  /** Core-near axes first (slow layer); terminal axes last (fast layer). */
  torsions:{torsion:ConformerTorsion;depth:number}[];
}
/** Select one reference core once, then orient whole-side rotations away from it.
 * Source atom order breaks equal-size ties, including small/collinear cores. */
export function planConformerTorsionHierarchy(snapshot:ConformerSnapshot,torsions:readonly ConformerTorsion[],coreAtomIds?:readonly string[]):ConformerTorsionHierarchy {
  const s=snapshot.structure,ids=s.atoms.map(atom=>atom.id!),indices=new Map(ids.map((id,index)=>[id,index]));
  const cuts=new Set(torsions.map(t=>t.atomIds.slice(1,3).sort().join('\0')));
  const graph=ids.map(()=>[] as number[]),rigid=ids.map(()=>[] as number[]);
  for(const bond of s.bonds!){graph[bond.a].push(bond.b);graph[bond.b].push(bond.a);if(!cuts.has([ids[bond.a],ids[bond.b]].sort().join('\0'))){rigid[bond.a].push(bond.b);rigid[bond.b].push(bond.a);}}
  const seen=new Set<number>(),components:number[][]=[];
  ids.forEach((_,root)=>{if(seen.has(root))return;const group=[root];seen.add(root);for(let i=0;i<group.length;i++)for(const n of rigid[group[i]])if(!seen.has(n)){seen.add(n);group.push(n);}components.push(group.sort((a,b)=>a-b));});
  components.sort((a,b)=>b.filter(i=>s.atoms[i].element!=='H').length-a.filter(i=>s.atoms[i].element!=='H').length||b.length-a.length||a[0]-b[0]);
  const core=coreAtomIds?.length?[...coreAtomIds]:components[0]?.map(i=>ids[i])??[];
  if(new Set(core).size!==core.length||core.some(id=>!indices.has(id)))throw Error('柔性键参考核心的原子身份无效。');
  if(core.length&&!components.some(component=>core.every(id=>component.includes(indices.get(id)!))))throw Error('播放固定端须位于同一刚性片段，不能跨越正在采样的柔性键。');
  const distances=ids.map(()=>Infinity),queue=core.map(id=>indices.get(id)!);queue.forEach(i=>{distances[i]=0;});
  for(let q=0;q<queue.length;q++)for(const n of graph[queue[q]])if(distances[n]===Infinity){distances[n]=distances[queue[q]]+1;queue.push(n);}
  const coreSet=new Set(core);
  const planned=torsions.map((original,index)=>{
    const inspect=original.origin==='manual'?inspectManualConformerTorsion:inspectConformerTorsion;
    const choices=(['first','last'] as const).map(side=>inspect(snapshot,original.atomIds,side)).filter(value=>value.accepted);
    choices.sort((a,b)=>a.torsion.movingAtomIds.filter(id=>coreSet.has(id)&&!original.atomIds.slice(1,3).includes(id)).length-b.torsion.movingAtomIds.filter(id=>coreSet.has(id)&&!original.atomIds.slice(1,3).includes(id)).length||a.torsion.movingAtomIds.length-b.torsion.movingAtomIds.length);
    if(!choices.length)throw Error('柔性键参考轴已失效。');
    return {torsion:choices[0].torsion,depth:Math.min(...original.atomIds.slice(1,3).map(id=>distances[indices.get(id)!])),index};
  }).sort((a,b)=>a.depth-b.depth||a.index-b.index);
  return {coreAtomIds:core,torsions:planned.map(({torsion,depth})=>({torsion,depth}))};
}
/** Pure temporary geometry. The caller owns animation lifecycle and view overlay;
 * this does not create a document, result frame, history entry or calculation. */
export function createConformerTorsionPreview(snapshot:ConformerSnapshot,torsion:ConformerTorsion,phase:number):Structure {
  if(!Number.isFinite(phase))throw Error('柔性键预览相位无效。');
  return rotateConformerTorsion(snapshot,torsion,torsion.sourceDegrees+phase*360);
}
/** Presentation projection only: core-near axes advance slowly while terminal
 * axes traverse their retained angle points in the same direction each round.
 * Sampling still visits a dispersed combination permutation; missing combinations
 * are skipped and retained IDs/structures are returned verbatim, never interpolated. */
export interface ConformerDiscreteTorsionPoint {atomIds:readonly string[];pointIndex?:number;pointCount?:number;targetDegrees:number}
export function orderConformerTorsionFrames<T>(frames:readonly T[],hierarchy:ConformerTorsionHierarchy,structureOf:(frame:T)=>Structure,discretePointsOf?:(frame:T)=>readonly ConformerDiscreteTorsionPoint[]|undefined):T[] {
  // One complete discrete contract per block. Mixing exact indices with angles
  // from repaired geometry would split the same slow-axis bin into false ranks.
  const axisKey=(ids:readonly string[])=>ids.slice(1,3).sort().join('\0');
  const discrete=frames.map(frame=>hierarchy.torsions.map(({torsion})=>discretePointsOf?.(frame)?.find(point=>axisKey(point.atomIds)===axisKey(torsion.atomIds))));
  const indexed=discrete.every(points=>points.every(point=>point&&Number.isSafeInteger(point.pointIndex)&&Number.isSafeInteger(point.pointCount)&&point.pointCount!>0&&point.pointIndex!>=0&&point.pointIndex!<point.pointCount!));
  const targets=discrete.every(points=>points.every(point=>point&&Number.isFinite(point.targetDegrees)));
  if(indexed||targets){
    return frames.map((frame,index)=>({frame,index,points:discrete[index]})).sort((left,right)=>{
      for(let axis=0;axis<left.points.length;axis++){
        const a=left.points[axis]!,b=right.points[axis]!,position=(point:ConformerDiscreteTorsionPoint)=>indexed?point.pointIndex!/point.pointCount!:((point.targetDegrees%360)+360)%360,
          delta=position(a)-position(b);
        if(delta)return delta;
      }return left.index-right.index;
    }).map(row=>row.frame);
  }
  const projected=frames.map((frame,index)=>({frame,index,angles:hierarchy.torsions.map(({torsion})=>{
    try{return (normalizeTorsionDegrees(builderCoordinateValue(structureOf(frame),'D',torsion.atomIds)-torsion.sourceDegrees)+360)%360;}catch{return Infinity;}
  })}));
  const ranks=hierarchy.torsions.map((_,axis)=>new Map([...new Set(projected.map(row=>Math.round(row.angles[axis]*1e6)))].sort((a,b)=>a-b).map((value,index)=>[value,index])));
  return projected.sort((a,b)=>{for(let i=0;i<a.angles.length;i++){
    const left=ranks[i].get(Math.round(a.angles[i]*1e6))!,right=ranks[i].get(Math.round(b.angles[i]*1e6))!;
    if(left!==right)return left-right;
  }return a.index-b.index;}).map(value=>value.frame);
}

export interface ConformerPlaybackOrderingOptions<T> {
 structureOf(frame:T):Structure;
 /** Resolve from this frame's actual batch/card/initial source, never the latest draft. */
 hierarchyFor(frame:T):ConformerTorsionHierarchy|undefined;
 /** Stable batch + card/version key. Only contiguous equal-key blocks are reordered. */
 blockKey(frame:T):string;
 discretePointsOf?(frame:T):readonly ConformerDiscreteTorsionPoint[]|undefined;
}
export interface ConformerPlaybackStep<T> {
 frame:T;blockKey:string;blockStart:boolean;
 changedTorsionAtomIds:readonly (readonly string[])[];
 /** More than one real axis changed; no synthetic intermediate frame was inserted. */
 discontinuous:boolean;
}
/** Stable display projection of already accepted frames. Frozen batch blocks,
 * MD time order and original objects/IDs are preserved verbatim. */
export function orderConformerPlaybackFrames<T>(frames:readonly T[],options:ConformerPlaybackOrderingOptions<T>):{frames:T[];steps:ConformerPlaybackStep<T>[];warnings:string[]}{
 const ordered:T[]=[],steps:ConformerPlaybackStep<T>[]=[],warnings:string[]=[];
 const signature=(hierarchy:ConformerTorsionHierarchy|undefined)=>hierarchy?JSON.stringify([hierarchy.coreAtomIds,hierarchy.torsions.map(row=>[row.torsion.atomIds,row.torsion.sourceDegrees,row.depth])]):'';
 for(let start=0;start<frames.length;){
  const key=options.blockKey(frames[start]);if(typeof key!=='string'||!key)throw Error('播放顺序需要明确的采样批次与卡身份。');
  let end=start+1;while(end<frames.length&&options.blockKey(frames[end])===key)end++;
  const block=frames.slice(start,end),hierarchy=options.hierarchyFor(block[0]),contract=signature(hierarchy),angles=new Map<T,number[]>();
  let valid=!!hierarchy?.torsions.length;
  for(const frame of block){
   if(signature(options.hierarchyFor(frame))!==contract){valid=false;warnings.push('同一播放块包含不同的柔性键定义，保持真实原顺序。');break;}
   if(!hierarchy?.torsions.length)continue;
   try{angles.set(frame,hierarchy.torsions.map(({torsion})=>builderCoordinateValue(options.structureOf(frame),'D',torsion.atomIds)));}
   catch{valid=false;warnings.push('部分保留帧缺少有效二面角，保持该块原顺序，不插补帧。');break;}
  }
  const projection=valid?orderConformerTorsionFrames(block,hierarchy!,options.structureOf,options.discretePointsOf):block;
  let previous:number[]|undefined;
  for(const frame of projection){
   const current=angles.get(frame),changed=previous&&current&&hierarchy?hierarchy.torsions.flatMap((row,index)=>Math.abs(normalizeTorsionDegrees(current[index]-previous![index]))>1e-5?[[...row.torsion.atomIds]]:[]):[];
   steps.push({frame,blockKey:key,blockStart:previous===undefined,changedTorsionAtomIds:changed,discontinuous:changed.length>1});
   ordered.push(frame);previous=current??[];
  }
  start=end;
 }
 return{frames:ordered,steps,warnings:[...new Set(warnings)]};
}
