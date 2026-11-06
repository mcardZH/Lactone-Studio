import type { Atom, Bond, Structure, Vector3 } from './types';
import { assertBuilderStereoPreserved, builderDoubleBondConfiguration, builderTetrahedralParity, requestedBuilder2DParity, updateBuilderStereo } from './builder-stereo';
import { minimumImage, periodicBonds, fractionalToCartesian, validatePeriodicEndpointImages } from './periodic';
import { refreshManualStereo } from './manual-stereo';
import { InfinitePeriodicNetworkError, resolveFinitePeriodicFragment } from './modeling/periodic-modeling';

export interface BuilderGeometryResult {structure:Structure;touchedIds:string[];createdFrom?:Record<string,string>;removedIds?:string[]}
export interface BuilderGeometryEdit {coordinate:'B'|'A'|'D';atomIds:string[];value:number;moving?:'branch'|'selected'|'atom';movingAtomIds?:string[];fixedSide?:'first'|'last'}
/** Deliberate Cartesian edit from one baseline. Two movable sides share the
 * change equally; explicit side lists never guess a click-order partition. */
export interface BalancedGeometryEdit {
  coordinate:'B'|'A'|'D'; atomIds:string[]; value:number;
  /** Exact ordered measurement endpoints for a periodic distance. */
  images?:Vector3[];
  moving?:'branch'|'selected'|'atom'; selectedAtomIds?:string[];
  sideAtomIds?:{first:string[];last:string[]};
  /** Independent scopes opt in to disconnected-component geometry. The old
   * moving API retains its established strict connected-branch behavior. */
  sideModes?:{first:GeometrySideMode;last:GeometrySideMode};
  /** A scope containing a frozen atom stays rigid and fixed as a whole. */
  fixedAtomIds?:readonly string[];
}
export type GeometrySideMode='fixed'|'atom'|'branch';
export interface BalancedGeometrySides {firstIds:string[];lastIds:string[];anchorIds:string[]}
export interface BuilderGeometryFrame {
  /** Guide-only Cartesian frame. Stable atom indices/IDs are unchanged; never
   * replace the physical model with this explicitly unwrapped structure. */
  structure:Structure; value:number; positions:Vector3[]; resolvedAtomIds:string[];
  /** Explicit endpoint images may repeat a base atom. positions/value then
   * define display only; structure is the unchanged base model, not a solver frame. */
  displayOnly?:true;
  endpointOnly?:true;
}
export interface BuilderTransformEdit {type:'translate'|'rotate'|'reflect'|'invert-center';atomIds?:string[];atomId?:string;delta?:Vector3;axis?:'x'|'y'|'z';degrees?:number;pivot?:Vector3}
export const builderVector={
  add:(a:Vector3,b:Vector3):Vector3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],
  sub:(a:Vector3,b:Vector3):Vector3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],
  scale:(a:Vector3,s:number):Vector3=>[a[0]*s,a[1]*s,a[2]*s],
  dot:(a:Vector3,b:Vector3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
  cross:(a:Vector3,b:Vector3):Vector3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
};
const {add,sub,scale,dot,cross}=builderVector;
export const builderPosition=(a:Atom):Vector3=>[a.x,a.y,a.z];
const norm=(a:Vector3)=>Math.hypot(...a);
export const builderUnit=(a:Vector3):Vector3=>{const n=norm(a);if(n<1e-10)throw new Error('几何方向退化，不能确定旋转轴。');return scale(a,1/n);};
export function builderRotate(p:Vector3,pivot:Vector3,axis:Vector3,angle:number):Vector3{
  const v=sub(p,pivot),u=builderUnit(axis),c=Math.cos(angle),s=Math.sin(angle);
  return add(pivot,add(add(scale(v,c),scale(cross(u,v),s)),scale(u,dot(u,v)*(1-c))));
}
const indices=(s:Structure,ids:string[])=>ids.map(id=>{const i=s.atoms.findIndex(a=>a.id===id);if(i<0)throw new Error(`原子 ${id} 不存在。`);return i;});
function selectionImages(s:Structure,selected:number[]):Map<number,Vector3>{
  const result=new Map<number,Vector3>();if(!s.cell)return result;const chosen=new Set(selected);
  for(const root of selected){if(result.has(root))continue;result.set(root,builderPosition(s.atoms[root]));const todo=[root];
    while(todo.length){const i=todo.shift()!;for(const b of s.bonds??[]){const n=b.a===i?b.b:b.b===i?b.a:-1;if(n<0||!chosen.has(n)||result.has(n))continue;
      let delta=sub(builderPosition(s.atoms[n]),builderPosition(s.atoms[i]));
      if(b.image)b.image.forEach((v,j)=>{delta=add(delta,scale(s.cell!.vectors[j],v*(b.a===i?1:-1)));});else delta=minimumImage(s,i,n).delta;
      result.set(n,add(result.get(i)!,delta));todo.push(n);
    }}
  }
  return result;
}
function move(s:Structure,ids:string[],fn:(p:Vector3)=>Vector3):BuilderGeometryResult{
  const chosen=new Set(ids),ii=indices(s,ids),unwrapped=selectionImages(s,ii);
  const atoms=s.atoms.map((a,i)=>{if(!a.id||!chosen.has(a.id))return a;const original=builderPosition(a),image=unwrapped.get(i)??original,p=sub(fn(image),sub(image,original));if(!p.every(Number.isFinite))throw new Error('几何坐标必须有限。');return {...a,x:p[0],y:p[1],z:p[2]};});
  const changed={...s,atoms,dimension:3 as const,molfile:undefined};
  return {structure:refreshManualStereo(s,changed,[...chosen]),touchedIds:[...chosen]};
}
function movingBranch(s:Structure,start:number,blocked:number):number[]{
  const visited=new Set<number>([start]),todo=[start];
  while(todo.length){const i=todo.pop()!;for(const b of s.bonds??[]){if(b.kind==='coordination')continue;
    if((b.a===start&&b.b===blocked)||(b.b===start&&b.a===blocked))continue;
    const n=b.a===i?b.b:b.b===i?b.a:-1;if(n>=0&&!visited.has(n)){visited.add(n);todo.push(n);}
  }}
  if(visited.has(blocked))throw new Error('环或多重连接无法自动确定移动侧；请明确选中移动原子。');
  return [...visited];
}
function coordinatePositions(s:Structure,ids:string[]):Vector3[]{
  const ii=indices(s,ids),p:Vector3[]=[builderPosition(s.atoms[ii[0]])];
  for(let k=1;k<ii.length;k++){
    const b=s.bonds?.find(b=>(b.a===ii[k-1]&&b.b===ii[k])||(b.b===ii[k-1]&&b.a===ii[k]));
    let delta=sub(builderPosition(s.atoms[ii[k]]),builderPosition(s.atoms[ii[k-1]]));
    if(s.cell){if(b?.image){const image=scale(b.image,b.a===ii[k-1]?1:-1);image.forEach((n,j)=>{delta=add(delta,scale(s.cell!.vectors[j],n));});}
      else delta=minimumImage(s,ii[k-1],ii[k]).delta;}
    p.push(add(p[k-1],delta));
  }
  return p;
}
export function builderCoordinateValue(s:Structure,kind:'B'|'A'|'D',ids:string[],images?:readonly Vector3[]):number{
  const count={B:2,A:3,D:4}[kind];
  if(ids.length!==count)throw new Error('请提供有效且不同的内坐标原子。');
  validatePeriodicEndpointImages(s,ids,images);
  const p=images?builderImageEndpointPositions(s,ids,images):coordinatePositions(s,ids);
  if(p.some(q=>!q.every(Number.isFinite)))throw new Error('几何坐标必须有限。');
  if(kind==='B')return norm(sub(p[1],p[0]));
  if(kind==='A'){return Math.acos(Math.max(-1,Math.min(1,dot(builderUnit(sub(p[0],p[1])),builderUnit(sub(p[2],p[1]))))))*180/Math.PI;}
  const b0=sub(p[0],p[1]),b1=builderUnit(sub(p[2],p[1])),b2=sub(p[3],p[2]);
  const v=sub(b0,scale(b1,dot(b0,b1))),w=sub(b2,scale(b1,dot(b2,b1)));
  if(norm(v)<1e-9||norm(w)<1e-9)throw new Error('共线原子不能定义二面角。');
  return Math.atan2(dot(cross(b1,v),w),dot(v,w))*180/Math.PI;
}
/** Ordered image-resolved points; never guesses a first bond or minimum image. */
export function builderImageEndpointPositions(s:Structure,ids:readonly string[],images:readonly Vector3[]):Vector3[]{
  validatePeriodicEndpointImages(s,ids,images);
  const positions=ids.map((id,index)=>{const atom=s.atoms.find(atom=>atom.id===id)!;const shift=images[index].some(Boolean)?fractionalToCartesian(s.cell!,images[index],false):[0,0,0];return [atom.x+shift[0],atom.y+shift[1],atom.z+shift[2]] as Vector3;});
  if(positions.some(point=>!point.every(Number.isFinite)))throw new Error('几何坐标必须有限。');
  return positions;
}
export function editBuilderGeometry(structure:Structure,edit:BuilderGeometryEdit):BuilderGeometryResult{
  const count={B:2,A:3,D:4}[edit.coordinate];
  if(edit.atomIds.length!==count||new Set(edit.atomIds).size!==count||!Number.isFinite(edit.value))throw new Error('请提供有效且不同的内坐标原子。');
  if(edit.coordinate==='B'&&edit.value<=0)throw new Error('键长必须大于零。');
  if(edit.coordinate==='A'&&(edit.value<=0||edit.value>=180))throw new Error('键角必须位于 0 与 180° 之间。');
  const s=inferBuilderBonds(structure),i=indices(s,edit.atomIds),p=coordinatePositions(s,edit.atomIds);
  const fixedFirst=edit.fixedSide!=='last', start=fixedFirst?i[count-1]:i[0], blocked=edit.coordinate==='D'?(fixedFirst?i[1]:i[2]):(fixedFirst?i[count-2]:i[1]);
  let moved:number[];
  if(edit.moving==='selected')moved=indices(s,edit.movingAtomIds??[]);
  else if(edit.moving==='atom')moved=[start];
  else {const cutA=edit.coordinate==='D'?(fixedFirst?i[2]:i[1]):start;
    try { moved=movingBranch(s,cutA,blocked).filter(n=>edit.coordinate!=='D'||n!==cutA); }
    catch (error) { if (edit.coordinate !== 'B') throw error; moved=[start]; }
  }
  if(!moved.includes(start)||moved.includes(fixedFirst?i[0]:i[count-1]))throw new Error('移动选区必须含移动端，且不能含固定端。');
  // Keep lattice offsets constant while applying a local transform to unwrapped
  // coordinates. Thus all old Cartesian positions and the real box survive.
  const offsets=new Map<number,Vector3>(i.map((n,k)=>[n,sub(p[k],builderPosition(s.atoms[n]))]));
  const pending=[...i],done=new Set<number>();
  while(pending.length){const current=pending.shift()!;if(done.has(current))continue;done.add(current);
    for(const b of s.bonds??[]){const next=b.a===current?b.b:b.b===current?b.a:-1;if(next<0||!moved.includes(next))continue;
      let offset=offsets.get(current)??[0,0,0] as Vector3;
      if(s.cell&&b.image){const image=scale(b.image,b.a===current?1:-1);image.forEach((n,j)=>{offset=add(offset,scale(s.cell!.vectors[j],n));});}
      else if(s.cell){const raw=sub(builderPosition(s.atoms[next]),builderPosition(s.atoms[current]));offset=add(offset,sub(minimumImage(s,current,next).delta,raw));}
      if(offsets.has(next)){if(norm(sub(offsets.get(next)!,offset))>1e-6&&(edit.moving??'branch')==='branch')throw new Error('周期环的晶胞图像不唯一；请明确选中移动原子。');}
      else{offsets.set(next,offset);pending.push(next);}
    }
  }
  const ids=moved.map(n=>s.atoms[n].id!);let fn:(p:Vector3)=>Vector3;
  const old=builderCoordinateValue(s,edit.coordinate,edit.atomIds);
  if(edit.coordinate==='B'){const dir=builderUnit(sub(p[1],p[0]));const delta=scale(dir,(edit.value-old)*(fixedFirst?1:-1));fn=q=>add(q,delta);}
  else if(edit.coordinate==='A'){
    const axis=builderUnit(cross(sub(p[0],p[1]),sub(p[2],p[1]))),angle=(edit.value-old)*Math.PI/180*(fixedFirst?1:-1);
    fn=q=>builderRotate(q,p[1],axis,angle);
  }else{const axis=sub(p[2],p[1]),angle=(edit.value-old)*Math.PI/180*(fixedFirst?1:-1);fn=q=>builderRotate(q,p[1],axis,angle);}
  let result:BuilderGeometryResult;
  if(s.cell){const chosen=new Set(moved);const atoms=s.atoms.map((a,n)=>{if(!chosen.has(n))return a;const offset=offsets.get(n)??[0,0,0],q=sub(fn(add(builderPosition(a),offset)),offset);return {...a,x:q[0],y:q[1],z:q[2]};});
    const changed={...s,atoms,molfile:undefined};result={structure:refreshManualStereo(s,changed,ids),touchedIds:ids};
  }else result=move(s,ids,fn);
  const actual=builderCoordinateValue(result.structure,edit.coordinate,edit.atomIds);
  const error=edit.coordinate==='D'?Math.abs((((actual-edit.value)%360+540)%360)-180):Math.abs(actual-edit.value);
  if(error>1e-5)throw new Error('选区不能满足指定内坐标，请检查固定侧和移动端。');
  return result;
}

function balancedFrame(structure:Structure,edit:BalancedGeometryEdit):{indices:number[];anchors:number[];cuts:Set<string>}{
  const count={B:2,A:3,D:4}[edit.coordinate];
  if(!count||!Array.isArray(edit.atomIds)||edit.atomIds.length!==count||new Set(edit.atomIds).size!==count||!Number.isFinite(edit.value))throw new Error('请提供有效且不同的内坐标原子及有限目标。');
  if(edit.coordinate==='B'&&edit.value<=0)throw new Error('键长必须大于零。');
  if(edit.coordinate==='A'&&(edit.value<=0||edit.value>=180))throw new Error('键角必须位于 0 与 180° 之间。');
  if(structure.atoms.some(atom=>!atom.id)||new Set(structure.atoms.map(atom=>atom.id)).size!==structure.atoms.length)throw new Error('双侧几何需要唯一稳定原子身份。');
  const ii=indices(structure,edit.atomIds),anchors=edit.coordinate==='A'?[ii[1]]:edit.coordinate==='D'?[ii[1],ii[2]]:[];
  const edges=edit.coordinate==='B'?[[ii[0],ii[1]]]:edit.coordinate==='A'?[[ii[0],ii[1]],[ii[1],ii[2]]]:[[ii[1],ii[2]]];
  return {indices:ii,anchors,cuts:new Set(edges.map(([a,b])=>`${Math.min(a,b)}:${Math.max(a,b)}`))};
}
/** Cut only the defining covalent links. A vertex and D axis anchors stay put;
 * alternate paths/overlapping sides must be resolved explicitly by the user. */
export function resolveBalancedGeometrySides(structure:Structure,edit:BalancedGeometryEdit):BalancedGeometrySides{
  const frame=balancedFrame(structure,edit),ii=frame.indices,anchors=new Set(frame.anchors),start=ii[0],end=ii.at(-1)!;
  const moving=edit.moving??'branch';
  if(!['branch','selected','atom'].includes(moving))throw new Error('未知几何移动范围。');
  if(edit.sideModes&&(!['fixed','atom','branch'].includes(edit.sideModes.first)||!['fixed','atom','branch'].includes(edit.sideModes.last)))throw new Error('未知首侧或末侧移动范围。');
  if(edit.sideModes&&moving==='selected'&&!edit.sideAtomIds)throw new Error('逐侧范围不能与未分侧黄色选区混用，请明确指定两侧。');
  const resolveIds=(ids:unknown,label:string):number[]=>{
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error(`${label}原子身份无效或重复。`);
    return indices(structure,ids);
  };
  let first:number[],last:number[];
  if(edit.sideAtomIds){
    if(moving!=='selected')throw new Error('明确两侧原子列表只用于明确选区。');
    first=resolveIds(edit.sideAtomIds.first,'首侧');last=resolveIds(edit.sideAtomIds.last,'末侧');
  }else if((edit.sideModes&&edit.sideModes.first!=='branch'&&edit.sideModes.last!=='branch')||(!edit.sideModes&&moving==='atom')){first=[start];last=[end];}
  else{
    if(structure.bonds===undefined)throw new Error('连接分支需要已有真实键图，不能为几何编辑自动猜键。');
    if(!edit.sideModes)for(const key of frame.cuts)if(!structure.bonds.some(b=>b.kind!=='coordination'&&`${Math.min(b.a,b.b)}:${Math.max(b.a,b.b)}`===key))throw new Error('测量不对应可拆分的真实连接；请使用端原子或明确两侧选区。');
    const walk=(root:number)=>{
      const visited=new Set<number>([root]),todo=[root];
      while(todo.length){const current=todo.pop()!;for(const bond of structure.bonds!){
        if(bond.kind==='coordination'||frame.cuts.has(`${Math.min(bond.a,bond.b)}:${Math.max(bond.a,bond.b)}`))continue;
        const next=bond.a===current?bond.b:bond.b===current?bond.a:-1;
        if(next<0||visited.has(next))continue;
        if(!structure.atoms[next])throw new Error('连接图引用了不存在的原子。');
        visited.add(next);todo.push(next);
      }}return [...visited];
    };
    first=!edit.sideModes||edit.sideModes.first==='branch'?walk(start):[start];last=!edit.sideModes||edit.sideModes.last==='branch'?walk(end):[end];
    const overlap=first.some(index=>last.includes(index)||(anchors.has(index)&&(edit.coordinate!=='D'||index!==ii[1])))||last.some(index=>anchors.has(index)&&(edit.coordinate!=='D'||index!==ii[2]));
    if(overlap){
      if(edit.coordinate!=='B')throw new Error('环、跨连接或两侧重叠无法唯一拆侧；请明确指定首侧和末侧选区。');
      // Distance in a ring/network has no separable sides. Only the actual
      // endpoints move; their real freezes still determine the fractions.
      first=[start];last=[end];
    }
    // D components contain their own stationary axis atom by construction.
    first=first.filter(index=>!anchors.has(index));last=last.filter(index=>!anchors.has(index));
    if(moving==='selected'){
      const chosen=resolveIds(edit.selectedAtomIds??[],'黄色选区');
      if(chosen.some(index=>!first.includes(index)&&!last.includes(index)&&!anchors.has(index)))throw new Error('黄色选区含无法归属首侧或末侧的原子；请明确指定两侧。');
      first=first.filter(index=>chosen.includes(index));last=last.filter(index=>chosen.includes(index));
    }
  }
  if(edit.coordinate==='B'&&moving!=='selected'&&structure.cell?.pbc.some(Boolean)){
    try { resolveFinitePeriodicFragment(structure,structure.atoms[start].id!); }
    catch(error){if(!(error instanceof InfinitePeriodicNetworkError))throw error;first=[start];last=[end];}
  }
  if(!first.includes(start)||!last.includes(end))throw new Error('首侧和末侧选区必须分别包含对应端原子。');
  if(first.some(index=>last.includes(index)||anchors.has(index))||last.some(index=>anchors.has(index))||first.includes(end)||last.includes(start))throw new Error('两侧选区不能重叠、交叉包含端原子或包含固定轴/顶点。');
  const ids=(values:number[])=>structure.atoms.filter((_,index)=>values.includes(index)).map(atom=>atom.id!);
  return {firstIds:ids(first),lastIds:ids(last),anchorIds:ids(frame.anchors)};
}

/** Positive fractions of the requested coordinate change; zero means fixed.
 * No partial branch motion is introduced to work around a frozen member. */
export function geometrySideFractions(structure:Structure,edit:BalancedGeometryEdit,sides=resolveBalancedGeometrySides(structure,edit)):{first:number;last:number}{
  const fixed=edit.fixedAtomIds??[];
  if(!Array.isArray(fixed)||fixed.some(id=>typeof id!=='string'||!structure.atoms.some(atom=>atom.id===id))||new Set(fixed).size!==fixed.length)throw new Error('冻结原子身份无效或重复。');
  const firstFixed=edit.sideModes?.first==='fixed'||sides.firstIds.some(id=>fixed.includes(id));
  const lastFixed=edit.sideModes?.last==='fixed'||sides.lastIds.some(id=>fixed.includes(id));
  return {first:firstFixed?0:lastFixed?1:.5,last:lastFixed?0:firstFixed?1:.5};
}

/** The one explicit-image coordinate frame for editable BAD labels, values and
 * the balanced solver. It never guesses minimum images, infers bonds or writes
 * physical coordinates. Missing/contradictory image evidence is an error. */
export function builderExplicitGeometryFrame(structure:Structure,coordinate:'B'|'A'|'D',atomIds:readonly string[],images?:readonly Vector3[]):BuilderGeometryFrame{
  if(images)return {structure:structuredClone(structure),positions:builderImageEndpointPositions(structure,atomIds,images),value:builderCoordinateValue(structure,coordinate,[...atomIds],images),resolvedAtomIds:[...new Set(atomIds)],displayOnly:true};
  const frame=balancedFrame(structure,{coordinate,atomIds:[...atomIds],value:coordinate==='B'?1:coordinate==='A'?90:0}),ii=frame.indices;
  const displayPositions=new Map<number,Vector3>();
  const periodic=!!structure.cell?.pbc.some(Boolean);
  if(periodic){
    const cell=structure.cell!,bonds=structure.bonds;
    if(!bonds)throw new Error('周期几何需要已有真实键及明确晶胞图像。');
    displayPositions.set(ii[0],builderPosition(structure.atoms[ii[0]]));const todo=[ii[0]];
    while(todo.length){const current=todo.shift()!;for(const bond of bonds){
      if(bond.kind==='coordination')continue;
      const next=bond.a===current?bond.b:bond.b===current?bond.a:-1;if(next<0)continue;
      if(!structure.atoms[next]||!Array.isArray(bond.image)||bond.image.length!==3||!bond.image.every(Number.isSafeInteger))throw new Error('周期几何缺少明确有效的键图像；不能以最短像猜测。');
      let delta=sub(builderPosition(structure.atoms[next]),builderPosition(structure.atoms[current]));
      bond.image.forEach((image,k)=>{delta=add(delta,scale(cell.vectors[k],image*(bond.a===current?1:-1)));});
      const candidate=add(displayPositions.get(current)!,delta),previous=displayPositions.get(next);
      if(previous){if(norm(sub(previous,candidate))>1e-8)throw new Error('周期环或跨连接的晶胞图像不唯一，不能编辑几何。');}
      else{displayPositions.set(next,candidate);todo.push(next);}
    }}
    for(const id of atomIds)if(!displayPositions.has(indices(structure,[id])[0]))throw new Error('周期测量图像无法唯一对应。');
  }
  const position=(index:number)=>displayPositions.get(index)??builderPosition(structure.atoms[index]);
  const p=ii.map(position);
  if(p.some(point=>!point.every(Number.isFinite)))throw new Error('几何坐标必须有限。');
  // Independent of periodic minimum-image conventions: use the explicit frame.
  const frameStructure={...structure,cell:undefined,atoms:structure.atoms.map((atom,index)=>{const q=position(index);return {...atom,x:q[0],y:q[1],z:q[2]};})};
  return {structure:frameStructure,value:builderCoordinateValue(frameStructure,coordinate,[...atomIds]),positions:p,
    resolvedAtomIds:periodic?[...displayPositions.keys()].map(index=>structure.atoms[index].id!):structure.atoms.map(atom=>atom.id!)};
}

/** Shared editable value/frame for the panel, wheel and solver. B may use its
 * exact two image endpoints even when a network has no global finite unwrap.
 * A/D retain the established complete, unambiguous-frame requirement. */
export function builderEditableGeometryFrame(structure:Structure,coordinate:'B'|'A'|'D',atomIds:readonly string[],images?:readonly Vector3[]):BuilderGeometryFrame{
  if(coordinate!=='B'){
    if(images){
      validatePeriodicEndpointImages(structure,atomIds,images);
      if(images.some(image=>image.some(Boolean)))throw new Error('当前A/D手动编辑不支持显式跨胞镜像路径。');
    }
    // Explicit all-zero images still require the complete editable frame;
    // the explicit-image branch of builderExplicitGeometryFrame is display
    // only and must never admit a cyclic/ambiguous A/D solver frame.
    const frame=builderExplicitGeometryFrame(structure,coordinate,atomIds);
    if(images){
      const endpoints=builderImageEndpointPositions(structure,atomIds,images);
      if(endpoints.some((point,index)=>norm(sub(point,frame.positions[index]))>1e-8))throw new Error('A/D显式端点与可编辑周期路径不一致。');
    }
    return frame;
  }
  if(images)validatePeriodicEndpointImages(structure,atomIds,images);
  try {
    const full=builderExplicitGeometryFrame(structure,coordinate,atomIds);
    if(!images)return full;
    const endpoints=builderImageEndpointPositions(structure,atomIds,images),relative=sub(full.positions[1],full.positions[0]),requested=sub(endpoints[1],endpoints[0]);
    if(norm(sub(relative,requested))<1e-8)return full;
  }catch(error){
    if(!structure.cell)throw error;
  }
  const [a,b]=indices(structure,[...atomIds]);
  if(a===b)throw new Error('固定晶胞时不能以移动同一基胞原子改变其自镜像距离。');
  let endpointImages=images;
  if(!endpointImages){
    const edges=(structure.bonds??[]).filter(edge=>edge.a===a&&edge.b===b||edge.a===b&&edge.b===a);
    if(edges.length!==1||!structure.cell)throw new Error('周期距离图像无法唯一对应（图像不唯一），请明确指定两个镜像端点。');
    endpointImages=[[0,0,0],scale(edges[0].image??[0,0,0],edges[0].a===a?1:-1)];
  }
  const positions=builderImageEndpointPositions(structure,atomIds,endpointImages);
  const frameStructure={...structure,cell:undefined,atoms:structure.atoms.map((atom,index)=>{const p=index===a?positions[0]:index===b?positions[1]:builderPosition(atom);return {...atom,x:p[0],y:p[1],z:p[2]};})};
  return {structure:frameStructure,positions,value:norm(sub(positions[1],positions[0])),resolvedAtomIds:[...atomIds],endpointOnly:true};
}

/** Equal geometric halves, or full motion opposite a fixed side. Not a
 * mass-weighted motion or force-field relaxation.
 * No store writes, graph inference, implicit unfreezing or stereo preservation
 * assertion. The store validates actual frozen XYZ and commits one transaction. */
export function editBuilderGeometryBalanced(structure:Structure,edit:BalancedGeometryEdit):BuilderGeometryResult{
  const sides=resolveBalancedGeometrySides(structure,edit);
  const frame=builderEditableGeometryFrame(structure,edit.coordinate,edit.atomIds,edit.images);
  if([...sides.firstIds,...sides.lastIds].some(id=>!frame.resolvedAtomIds.includes(id)))throw new Error('周期选区与测量图像无法唯一对应。');
  const first=new Set(sides.firstIds),last=new Set(sides.lastIds);
  const position=(index:number)=>builderPosition(frame.structure.atoms[index]),p=frame.positions,old=frame.value;
  const difference=edit.coordinate==='D'?((edit.value-old)%360+540)%360-180:edit.value-old;
  const fractions=geometrySideFractions(structure,edit,sides);
  if(difference===0)return {structure,touchedIds:[]};
  if(!fractions.first&&!fractions.last)throw new Error('两侧均固定或含冻结原子，无法改变目标几何。');
  let transform:(point:Vector3,side:number)=>Vector3;
  if(edit.coordinate==='B'){
    const axis=builderUnit(sub(p[1],p[0]));transform=(q,side)=>add(q,scale(axis,side*difference));
  }else if(edit.coordinate==='A'){
    const axis=builderUnit(cross(sub(p[0],p[1]),sub(p[2],p[1])));
    transform=(q,side)=>builderRotate(q,p[1],axis,side*difference*Math.PI/180);
  }else{
    const axis=builderUnit(sub(p[2],p[1]));transform=(q,side)=>builderRotate(q,p[1],axis,side*difference*Math.PI/180);
  }
  const touchedIds:string[]=[];
  const atoms=structure.atoms.map((atom,index)=>{
    const side=first.has(atom.id!)?-fractions.first:last.has(atom.id!)?fractions.last:0;if(!side)return atom;
    const original=builderPosition(atom),image=position(index),q=sub(transform(image,side),sub(image,original));
    if(!q.every(Number.isFinite))throw new Error('几何坐标必须有限。');
    if(q.every((value,k)=>Object.is(value,original[k])))return atom;
    touchedIds.push(atom.id!);return {...atom,x:q[0],y:q[1],z:q[2]};
  });
  const candidate={...structure,atoms,dimension:3 as const,molfile:undefined};
  const actualFrame={...candidate,cell:undefined,atoms:candidate.atoms.map((atom,index)=>{const offset=sub(position(index),builderPosition(structure.atoms[index])),q=add(builderPosition(atom),offset);return {...atom,x:q[0],y:q[1],z:q[2]};})};
  const actual=builderCoordinateValue(actualFrame,edit.coordinate,edit.atomIds),error=edit.coordinate==='D'?Math.abs(((actual-edit.value)%360+540)%360-180):Math.abs(actual-edit.value);
  if(error>1e-5)throw new Error('两侧选区不能满足指定内坐标；未修改模型。');
  return {structure:refreshManualStereo(structure,candidate,touchedIds),touchedIds};
}
export function transformBuilderSelection(structure:Structure,edit:BuilderTransformEdit):BuilderGeometryResult{
  const selectedIds=edit.atomIds??(edit.atomId?[edit.atomId]:[]);
  const chosen=indices(structure,selectedIds);if(!chosen.length)throw new Error('请先选择原子。');
  const unwrapped=selectionImages(structure,chosen);
  const pivot=edit.pivot??scale(chosen.reduce<Vector3>((sum,i)=>add(sum,unwrapped.get(i)??builderPosition(structure.atoms[i])),[0,0,0]),1/chosen.length);
  if(edit.type==='translate'){if(!edit.delta?.every(Number.isFinite))throw new Error('平移向量无效。');return move(structure,selectedIds,p=>add(p,edit.delta!));}
  const axisIndex={x:0,y:1,z:2}[edit.axis??'z'];
  if(edit.type==='rotate'){if(!Number.isFinite(edit.degrees))throw new Error('旋转角无效。');const axis:Vector3=[0,0,0];axis[axisIndex]=1;return move(structure,selectedIds,p=>builderRotate(p,pivot,axis,edit.degrees!*Math.PI/180));}
  if(edit.type==='reflect')return move(structure,selectedIds,p=>{const q=[...p] as Vector3;q[axisIndex]=2*pivot[axisIndex]-q[axisIndex];return q;});
  if(selectedIds.length!==1)throw new Error('局部反转请只指定一个中心。');
  const c=chosen[0],center=builderPosition(structure.atoms[c]);
  const bonds=structure.bonds??[],neighbours=bonds.filter(b=>b.a===c||b.b===c).map(b=>b.a===c?b.b:b.a);
  if(neighbours.length!==4)throw new Error('反转中心须有四个显式邻居。');
  const moving=movingBranch(structure,neighbours[0],c),other=movingBranch(structure,neighbours[1],c);
  if(moving.some(n=>other.includes(n)))throw new Error('环状中心不能自动交换取代基。');
  // Exchange two substituent directions by proper rotations. This inverts only
  // the selected centre while preserving stereocentres inside either branch.
  const p0=coordinatePositions(structure,[structure.atoms[c].id!,structure.atoms[neighbours[0]].id!])[1],p1=coordinatePositions(structure,[structure.atoms[c].id!,structure.atoms[neighbours[1]].id!])[1];
  const v0=builderUnit(sub(p0,center)),v1=builderUnit(sub(p1,center));
  const axis=builderUnit(cross(v0,v1)),angle=Math.acos(Math.max(-1,Math.min(1,dot(v0,v1))));
  const shift0=sub(p0,builderPosition(structure.atoms[neighbours[0]])),shift1=sub(p1,builderPosition(structure.atoms[neighbours[1]]));
  const first=move(structure,moving.map(n=>structure.atoms[n].id!),p=>sub(builderRotate(add(p,shift0),center,axis,angle),shift0));
  const second=move(first.structure,other.map(n=>structure.atoms[n].id!),p=>sub(builderRotate(add(p,shift1),center,axis,-angle),shift1));
  return {structure:second.structure,touchedIds:[...first.touchedIds,...second.touchedIds]};
}
/** Explicit E/Z edit: rotate a separable substituent side by 180° around C=C.
 * An optional allow-list restricts this operation to newly drawn atoms. */
export function setBuilderDoubleBondConfiguration(structure:Structure,aId:string,bId:string,configuration:'E'|'Z',movableAtomIds?:string[]):BuilderGeometryResult{
  if(builderDoubleBondConfiguration(structure,aId,bId)===configuration)return {structure,touchedIds:[]};
  const [a,b]=indices(structure,[aId,bId]),allowed=movableAtomIds?new Set(movableAtomIds):undefined;
  for(const [movingEnd,fixedEnd]of [[b,a],[a,b]]){
    let branch:number[];try{branch=movingBranch(structure,movingEnd,fixedEnd).filter(i=>i!==movingEnd);}catch{continue;}
    if(!branch.length||branch.some(i=>allowed&&!allowed.has(structure.atoms[i].id!)))continue;
    const p=coordinatePositions(structure,[structure.atoms[fixedEnd].id!,structure.atoms[movingEnd].id!]),pivot=p[1],axis=sub(p[1],p[0]);
    const all=[movingEnd,...branch],unwrapped=selectionImages(structure,all),endShift=sub(pivot,unwrapped.get(movingEnd)??builderPosition(structure.atoms[movingEnd]));
    const originShift=add(endShift,sub(unwrapped.get(branch[0])??builderPosition(structure.atoms[branch[0]]),builderPosition(structure.atoms[branch[0]])));
    const candidate=move(structure,branch.map(i=>structure.atoms[i].id!),q=>sub(builderRotate(add(q,originShift),pivot,axis,Math.PI),originShift));
    if(builderDoubleBondConfiguration(candidate.structure,aId,bId)===configuration)return candidate;
  }
  throw new Error('该双键的 E/Z 不能通过单一可移动分支改变；请明确移动取代基。');
}
const RADII:Record<string,number>={H:.31,B:.85,C:.76,N:.71,O:.66,F:.57,Si:1.11,P:1.07,S:1.05,Cl:1.02,Br:1.2,I:1.39};
const VALENCE:Record<string,number>={H:1,B:3,C:4,N:3,O:2,F:1,Si:4,P:3,S:2,Cl:1,Br:1,I:1};
export function inferBuilderBonds(s:Structure):Structure{
  if(s.periodicSource?.completeness==='partial')throw new Error('部分平移向量不足以推断完整周期连接；未将此来源当有限分子。');
  if(s.bonds!==undefined)return s; // An explicit empty bond list is authoritative, too.
  if(s.cell?.pbc.some(Boolean))return {...s,bonds:periodicBonds(s),bondSource:'inferred'};
  const bonds:Bond[]=[],valences=Array(s.atoms.length).fill(0);
  const candidates:{a:number;b:number;d:number;r:number}[]=[];
  const cellWidth=2*Math.max(...Object.values(RADII))*1.22, bins=new Map<string,number[]>();
  const bin=(atom:Atom)=>[atom.x,atom.y,atom.z].map(value=>Math.floor(value/cellWidth));
  s.atoms.forEach((atom,index)=>{if(!RADII[atom.element])return;const key=bin(atom).join(',');const list=bins.get(key);if(list)list.push(index);else bins.set(key,[index]);});
  for(let a=0;a<s.atoms.length;a++){
    const aa=s.atoms[a];if(!RADII[aa.element])continue;
    const [x,y,z]=bin(aa), nearby:number[]=[], visitedBins=new Set<string>();
    for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(let k=-1;k<=1;k++){const key=[x+i,y+j,z+k].join(',');if(visitedBins.has(key))continue;visitedBins.add(key);for(const b of bins.get(key)??[])if(b>a)nearby.push(b);}
    nearby.sort((a,b)=>a-b);
    for(const b of nearby){const bb=s.atoms[b],r=RADII[aa.element]+RADII[bb.element];
      const d=norm(sub(builderPosition(aa),builderPosition(bb)));if(d>.4&&d<r*1.22&&!(aa.element==='H'&&bb.element==='H'))candidates.push({a,b,d,r});}
  }
  candidates.sort((a,b)=>a.d/a.r-b.d/b.r);
  for(const {a,b}of candidates)if(valences[a]<targetValence(s.atoms[a])&&valences[b]<targetValence(s.atoms[b])){
    bonds.push({a,b,order:1});valences[a]++;valences[b]++;
  }
  return {...s,bonds,bondSource:'inferred'};
}
const targetValence=(a:Atom)=>{
  const q=a.formalCharge??0;if(!Number.isInteger(q))return 0;
  if(a.element==='C'||a.element==='Si')return q===0?4:Math.abs(q)===1?3:0;
  if(a.element==='B')return q===0?3:q===-1?4:q===1?2:0;
  if(a.element==='N')return q===0?3:q===1?4:q===-1?2:0;
  if(a.element==='O')return q===0?2:q===-1?1:q===1?3:0;
  if(['F','Cl','Br','I','H'].includes(a.element))return q===0?1:0;
  return q===0?(VALENCE[a.element]??0):0;
};
/** The existing organic start-state policy, not a hard editing limit. */
export function builderDefaultValence(atom: Atom): number { return targetValence(atom); }
/** Aromatic 1.5 is a delocalized drawing convention, not a literal valence
 * contribution on every atom (furan O and fused carbon are counterexamples). */
export function builderCovalentValence(s:Pick<Structure,'atoms'|'bonds'>,index:number):number{
  const atom=s.atoms[index],edges=(s.bonds??[]).filter(b=>b.kind!=='coordination'&&(b.a===index||b.b===index));
  const aromatic=edges.filter(b=>b.aromatic||b.order===1.5),sigma=edges.filter(b=>!b.aromatic&&b.order!==1.5).reduce((sum,b)=>sum+b.order,0);
  if(!aromatic.length)return sigma;
  const count=aromatic.length,q=atom.formalCharge??0;
  if(['O','S','P','B'].includes(atom.element))return sigma+count;
  if(atom.element==='N'&&q<=0)return sigma+count+(q===0&&count===2&&sigma===0&&!atom.aromaticHydrogen?1:0);
  return sigma+count+(count>=2?1:.5);
}
/** Validate edited ordinary covalent atoms only; unfamiliar metal/coordination
 * chemistry remains explicit rather than acquiring a blanket organic valence. */
export function validateBuilderValence(s:Structure,atomIds?:string[]):void{
  const chosen=atomIds?new Set(atomIds):undefined;
  for(let i=0;i<s.atoms.length;i++){
    const a=s.atoms[i];if(chosen&&!chosen.has(a.id!))continue;if(!Object.hasOwn(VALENCE,a.element))continue;
    if((s.bonds??[]).some(b=>b.orderKnown===false&&(b.a===i||b.b===i)))continue;
    const q=a.formalCharge??0,target=targetValence(a);
    const maximum=a.element==='P'&&q===0?5:a.element==='S'&&q===0?6:target;
    const unsupported=target===0&&!(['F','Cl','Br','I','H'].includes(a.element)&&Math.abs(q)===1);
    if(unsupported)continue;
    const order=builderCovalentValence(s,i);
    if(order>maximum+1e-6)throw new Error(`${a.element} 原子 ${a.id??i+1} 的共价键价 ${order} 超过当前形式电荷允许值 ${maximum}；请选择要替换的显式氢或删除相应键。`);
  }
}
function localHydrogenDirections(existing:Vector3[],count:number,planar:boolean,linear:boolean):Vector3[]{
  const tetra=([[1,1,1],[1,-1,-1],[-1,1,-1],[-1,-1,1]] as Vector3[]).map(builderUnit);
  if(!existing.length)return (linear?[[1,0,0],[-1,0,0]]:planar?[[1,0,0],[-.5,Math.sqrt(3)/2,0],[-.5,-Math.sqrt(3)/2,0]]:tetra).slice(0,count) as Vector3[];
  if(existing.length===1){const u=existing[0];if(linear)return [scale(u,-1)];
    const e=builderUnit(cross(u,Math.abs(u[2])<.9?[0,0,1]:[0,1,0])),f=cross(u,e),c=planar?-.5:-1/3,r=Math.sqrt(1-c*c);
    const step=planar?Math.PI:2*Math.PI/3;
    return Array.from({length:count},(_,i)=>add(scale(u,c),scale(add(scale(e,Math.cos(i*step)),scale(f,Math.sin(i*step))),r)));
  }
  const sum=existing.reduce<Vector3>((v,u)=>add(v,u),[0,0,0]);
  if(existing.length===2&&!planar&&count===2&&norm(sum)>1e-8&&norm(cross(existing[0],existing[1]))>1e-8){
    const bisector=scale(builderUnit(sum),-1),normal=builderUnit(cross(existing[0],existing[1]));
    const projection=Math.sqrt(Math.max(1e-9,(1+dot(existing[0],existing[1]))/2)),a=Math.min(.95,1/(3*projection)),b=Math.sqrt(1-a*a);
    return [add(scale(bisector,a),scale(normal,b)),add(scale(bisector,a),scale(normal,-b))];
  }
  if(count===1&&norm(sum)>1e-8)return [builderUnit(scale(sum,-1))];
  // Unusual fixed local arrangements: maximin sphere placement, with no old
  // atom movement and no claim of an optimized conformation.
  const sphere:Vector3[]=[...tetra];for(let k=0;k<128;k++){const z=1-2*(k+.5)/128,r=Math.sqrt(1-z*z),t=k*Math.PI*(3-Math.sqrt(5));sphere.push([r*Math.cos(t),r*Math.sin(t),z]);}
  const chosen=[...existing],result:Vector3[]=[];
  for(let h=0;h<count;h++){const direction=sphere.reduce((best,v)=>{const score=Math.min(...chosen.map(d=>1-dot(d,v)));return score>best.score?{v,score}:best;},{v:tetra[0],score:-Infinity}).v;chosen.push(direction);result.push(direction);}
  return result;
}
export function placeBuilderHydrogens(structure:Structure,atomIds:string[],mode:'auto'|'explicit'='auto'):BuilderGeometryResult{
  const original=inferBuilderBonds(structure),unknown=new Set((original.bonds??[]).filter(b=>b.orderKnown===false).flatMap(b=>[original.atoms[b.a].id!,original.atoms[b.b].id!]));
  if(mode==='explicit'&&atomIds.some(id=>unknown.has(id)))throw new Error('局部周期连接键级未知，不能据此猜测饱和补氢；请先明确所需键级。');
  // Automatic molecular saturation must not interpret a drawing placeholder
  // as a known single bond; retain these sites and all their existing H.
  atomIds=atomIds.filter(id=>!unknown.has(id));
  const selected=new Set(atomIds),remove=new Set<number>();
  indices(original,atomIds);
  for(let i=0;i<original.atoms.length;i++){
    const a=original.atoms[i];if(!a.id||!selected.has(a.id)||!targetValence(a)||(mode==='auto'&&a.hydrogenMode==='explicit'))continue;
    const connected=(original.bonds??[]).filter(b=>b.kind!=='coordination'&&(b.a===i||b.b===i));
    let surplus=builderCovalentValence(original,i)-targetValence(a);
    for(const b of connected){if(surplus<1-1e-6)break;const n=b.a===i?b.b:b.a,h=original.atoms[n];
      if(h.element==='H'&&h.hydrogenMode==='auto'&&b.order===1){remove.add(n);surplus--;}}
  }
  const remap=new Map<number,number>(),kept=original.atoms.filter((_,i)=>!remove.has(i));let next=0;
  original.atoms.forEach((_,i)=>{if(!remove.has(i))remap.set(i,next++);});
  const s={...original,atoms:kept,bonds:(original.bonds??[]).filter(b=>!remove.has(b.a)&&!remove.has(b.b)).map(b=>({...b,a:remap.get(b.a)!,b:remap.get(b.b)!}))};
  validateBuilderValence(s,atomIds);
  const chosen=indices(s,atomIds),atoms=s.atoms.map(a=>({...a})),bonds=(s.bonds??[]).map(b=>({...b})),createdFrom:Record<string,string>={},touchedIds:string[]=[];
  const nextId=()=>`builder-h-${crypto.randomUUID()}`;
  for(const i of chosen){const a=atoms[i];if(!a.id||!['B','C','N','O','F','Si','P','S','Cl','Br','I'].includes(a.element)||(mode==='auto'&&a.hydrogenMode==='explicit'))continue;
    const neighbours=bonds.filter(b=>b.kind!=='coordination'&&(b.a===i||b.b===i)),valence=builderCovalentValence({atoms,bonds},i);
    const missing=Math.max(0,Math.floor(targetValence(a)-valence+1e-6));if(!missing)continue;
    const center=builderPosition(a),directions=neighbours.map(b=>{
      const j=b.a===i?b.b:b.a;let delta=sub(builderPosition(atoms[j]),center);
      if(s.cell){if(b.image)b.image.forEach((v,k)=>{delta=add(delta,scale(s.cell!.vectors[k],v*(b.a===i?1:-1)));});else delta=minimumImage(s,i,j).delta;}
      return builderUnit(delta);
    });
    const linear=neighbours.some(b=>b.order>=3),planar=neighbours.some(b=>b.order>=2||b.aromatic)||(a.element==='C'&&a.formalCharge===1)||(a.element==='B'&&(a.formalCharge??0)>=0);
    const generated=localHydrogenDirections(directions,missing,planar,linear);
    for(let h=0;h<missing;h++){
      const direction=generated[h];if(!direction)throw new Error('该局部价态无法用普通有机几何补氢。');
      directions.push(direction);const length=a.element==='C'?1.09:a.element==='N'?1.01:a.element==='O'?.97:1.15;
      const p=add(center,scale(direction,length)),id=nextId();atoms.push({id,element:'H',x:p[0],y:p[1],z:p[2],hydrogenMode:mode});bonds.push({a:i,b:atoms.length-1,order:1});createdFrom[id]=a.id;touchedIds.push(id);
    }
    atoms[i]={...a,hydrogenMode:mode};touchedIds.push(a.id);
  }
  const changed={...s,atoms,bonds,molfile:undefined,dimension:3 as const};assertBuilderStereoPreserved(s,changed);
  return {structure:updateBuilderStereo(changed).structure,touchedIds,createdFrom,removedIds:[...remove].map(i=>original.atoms[i].id!).filter(Boolean)};
}
/** Local Cartesian seed for newly drawn atoms only. Surviving atoms are immutable
 * anchors. This is idealized geometry, never a force-field/quantum optimization. */
export function initializeBuilderNewGeometry(structure:Structure,newAtomIds:string[]):BuilderGeometryResult{
  const s=inferBuilderBonds(structure),newIds=new Set(newAtomIds);indices(s,newAtomIds);
  const atoms=s.atoms.map(a=>({...a})),placed=new Set(atoms.map((a,i)=>!newIds.has(a.id!)?i:-1).filter(i=>i>=0));
  const edges=s.bonds??[],requested=new Map(s.atoms.filter(a=>a.id).map(a=>[a.id!,requestedBuilder2DParity(s,a.id!)]));
  const sketchAtoms=s.atoms.map(a=>{const p=a.id?s.layout2D?.[a.id]:undefined;return {...a,x:p?.x??a.x,y:p?.y??a.y,z:0};});
  const requestedDouble=edges.filter(b=>b.order===2).map(b=>({a:b.a,b:b.b,configuration:builderDoubleBondConfiguration({...s,atoms:sketchAtoms,cell:undefined},s.atoms[b.a].id!,s.atoms[b.b].id!)}));
  const neighbours=(i:number)=>edges.filter(b=>b.kind!=='coordination'&&(b.a===i||b.b===i)).map(b=>({i:b.a===i?b.b:b.a,bond:b}));
  const length=(a:Atom,b:Atom,order:number)=>{
    if(order>=3)return 1.18;if(order>=2)return a.element==='O'||b.element==='O'?1.23:1.34;if(order>1)return a.element==='O'||b.element==='O'?1.36:1.4;
    const radii:Record<string,number>={H:.31,C:.76,N:.71,O:.66,F:.57,B:.85,Si:1.11,P:1.07,S:1.05,Cl:1.02,Br:1.2,I:1.39};return (radii[a.element]??.76)+(radii[b.element]??.76);
  };
  const localPosition=(from:number,to:number)=>{let delta=sub(builderPosition(atoms[to]),builderPosition(atoms[from]));const edge=edges.find(b=>(b.a===from&&b.b===to)||(b.a===to&&b.b===from));
    if(s.cell&&edge?.image)edge.image.forEach((v,k)=>{delta=add(delta,scale(s.cell!.vectors[k],v*(edge.a===from?1:-1)));});else if(s.cell)delta=minimumImage({...s,atoms},from,to).delta;return delta;};
  // A newly drawn ring is not an immutable anchor. Reuse its valid native 2D
  // graph embedding as a planar Cartesian seed (correct for aromatic systems),
  // scaled in physical units. This also retains fused-ring closure exactly.
  // Existing atoms remain anchors and are never passed through this embedding.
  const seenNew=new Set<number>();
  for(let root=0;root<atoms.length;root++){
    if(!newIds.has(atoms[root].id!)||seenNew.has(root))continue;
    const connected:number[]=[],todo=[root];seenNew.add(root);
    while(todo.length){const i=todo.pop()!;connected.push(i);for(const n of neighbours(i))if(newIds.has(atoms[n.i].id!)&&!seenNew.has(n.i)){seenNew.add(n.i);todo.push(n.i);}}
    const members=new Set(connected);let peeled=true;
    while(peeled){peeled=false;for(const i of members)if(neighbours(i).filter(n=>members.has(n.i)).length<2){members.delete(i);peeled=true;}}
    const component=[...members];if(!component.length)continue;
    const internal=edges.filter(b=>b.kind!=='coordination'&&members.has(b.a)&&members.has(b.b));
    const external=edges.filter(b=>b.kind!=='coordination'&&(members.has(b.a)!==members.has(b.b))&&!newIds.has(atoms[members.has(b.a)?b.b:b.a].id!));
    if(external.length>1)continue; // Explicit multi-anchor geometry still needs actual closure checks.
    const diagram=(i:number):Vector3=>{const p=s.layout2D?.[atoms[i].id!];return p?[p.x,p.y,0]:[s.atoms[i].x,s.atoms[i].y,0];};
    const distances=internal.map(b=>norm(sub(diagram(b.a),diagram(b.b))));if(distances.some(d=>d<1e-7))continue;
    const sorted=[...distances].sort((a,b)=>a-b),target=internal.map(b=>length(atoms[b.a],atoms[b.b],b.aromatic?1.5:b.order)).sort((a,b)=>a-b),factor=target[Math.floor(target.length/2)]/sorted[Math.floor(sorted.length/2)];
    let anchor=component[0],origin=builderPosition(atoms[component[0]]);
    if(external.length){const edge=external[0],inside=members.has(edge.a)?edge.a:edge.b,outside=edge.a===inside?edge.b:edge.a;anchor=inside;
      const hint=sub(diagram(inside),diagram(outside)),direction=norm(hint)>1e-7?builderUnit(hint):[1,0,0] as Vector3;origin=add(builderPosition(atoms[outside]),scale(direction,length(atoms[outside],atoms[inside],edge.order)));
      if(s.cell&&edge.image)edge.image.forEach((v,k)=>{origin=sub(origin,scale(s.cell!.vectors[k],v*(edge.a===outside?1:-1)));});
    }
    const diagramOrigin=diagram(anchor);
    for(const i of component){const p=add(origin,scale(sub(diagram(i),diagramOrigin),factor));atoms[i]={...atoms[i],x:p[0],y:p[1],z:p[2]};placed.add(i);}
  }
  while(placed.size<atoms.length){
    let progress=false;
    // Grow from old anchors and then from the first atom of each new component.
    for(let i=0;i<atoms.length;i++){
      if(placed.has(i))continue;const ready=neighbours(i).filter(n=>placed.has(n.i));if(!ready.length)continue;
      const parent=ready[0].i,origin=builderPosition(atoms[parent]),parentNeighbours=neighbours(parent),existing=parentNeighbours.filter(n=>placed.has(n.i)&&n.i!==i).map(n=>builderUnit(localPosition(parent,n.i)));
      const maxOrder=Math.max(...parentNeighbours.map(n=>n.bond.order),1),planar=maxOrder>=2||parentNeighbours.some(n=>n.bond.aromatic)||(atoms[parent].element==='C'&&atoms[parent].formalCharge===1)||(atoms[parent].element==='B'&&(atoms[parent].formalCharge??0)>=0),linear=maxOrder>=3;
      const options=localHydrogenDirections(existing,Math.max(1,parentNeighbours.filter(n=>!placed.has(n.i)).length),planar,linear);
      const oldDirection=localPosition(parent,i),hint=norm(oldDirection)>1e-8?builderUnit(oldDirection):[1,0,0] as Vector3;
      let direction=options.reduce((best,d)=>dot(d,hint)>dot(best,hint)?d:best,options[0]);
      let position=add(origin,scale(direction,length(atoms[parent],atoms[i],ready[0].bond.order)));
      if(ready.length>1){
        // Ring closure: intersect the two anchor spheres. Choosing the closest
        // point on that circle respects existing bond lengths without moving old atoms.
        const other=ready[1],delta=localPosition(parent,other.i),distance=norm(delta),u=builderUnit(delta),r1=length(atoms[parent],atoms[i],ready[0].bond.order),r2=length(atoms[other.i],atoms[i],other.bond.order);
        const x=(r1*r1-r2*r2+distance*distance)/(2*distance),height2=r1*r1-x*x;
        if(height2<-1e-5)throw new Error('新环的两个固定连接点无法满足局部键长；请调整新原子或使用明确模板。');
        const middle=add(origin,scale(u,x)),hintOffset=sub(position,middle),perp=sub(hintOffset,scale(u,dot(hintOffset,u)));
        direction=norm(perp)>1e-8?builderUnit(perp):builderUnit(cross(u,Math.abs(u[2])<.9?[0,0,1]:[0,1,0]));
        position=add(middle,scale(direction,Math.sqrt(Math.max(0,height2))));
      }
      // Store a new atom in the parent's current image; a newly created bond
      // normally has no image, while imported image topology remains unchanged.
      const image=ready[0].bond.image;if(s.cell&&image)image.forEach((v,k)=>{position=sub(position,scale(s.cell!.vectors[k],v*(ready[0].bond.a===parent?1:-1)));});
      atoms[i]={...atoms[i],x:position[0],y:position[1],z:position[2]};placed.add(i);progress=true;
    }
    if(!progress){const root=atoms.findIndex((_,i)=>!placed.has(i));placed.add(root);atoms[root]={...atoms[root],x:atoms[root].x,y:atoms[root].y,z:atoms[root].z};}
  }
  let changed:Structure={...s,atoms,dimension:3,molfile:undefined};
  // A requested wedge may orient only a newly added, separable substituent.
  // It must never mirror surviving skeleton coordinates to satisfy a sketch.
  for(const [id,wanted]of requested){if(!wanted)continue;const center=atoms.findIndex(a=>a.id===id),actual=builderTetrahedralParity(changed,id);if(!actual||actual===wanted)continue;
    const ns=neighbours(center);let adjusted=false;
    for(const n of ns){if(!newIds.has(atoms[n.i].id!))continue;let branch:number[];try{branch=movingBranch(changed,n.i,center);}catch{continue;}if(branch.some(i=>!newIds.has(atoms[i].id!)))continue;
      const fixed=ns.filter(other=>other.i!==n.i);if(fixed.length<3)continue;const origin=builderPosition(atoms[center]),p0=localPosition(center,fixed[0].i),p1=localPosition(center,fixed[1].i),p2=localPosition(center,fixed[2].i),normal=cross(sub(p1,p0),sub(p2,p0));if(norm(normal)<1e-8)continue;const u=builderUnit(normal);
      const initial=localPosition(center,n.i),reflected=sub(initial,scale(u,2*dot(sub(initial,p0),u))),target=scale(builderUnit(reflected),norm(initial));
      const axis=cross(initial,target);if(norm(axis)<1e-8){const perpendicular=builderUnit(cross(initial,Math.abs(initial[2])<.9?[0,0,1]:[0,1,0]));axis.splice(0,3,...perpendicular);}
      const angle=Math.acos(Math.max(-1,Math.min(1,dot(builderUnit(initial),builderUnit(target))))),branchSet=new Set(branch);
      const candidate={...changed,atoms:changed.atoms.map((a,i)=>{if(!branchSet.has(i))return a;const q=builderRotate(builderPosition(a),origin,axis,angle);return {...a,x:q[0],y:q[1],z:q[2]};})};
      if(builderTetrahedralParity(candidate,id)===wanted){changed=candidate;adjusted=true;break;}
    }
    if(!adjusted)throw new Error('新绘制手性无法在不移动原骨架时确定；请明确局部几何。');
  }
  for(const desired of requestedDouble){if(desired.configuration==='undefined')continue;const aId=atoms[desired.a].id!,bId=atoms[desired.b].id!;
    if(builderDoubleBondConfiguration(changed,aId,bId)===desired.configuration)continue;
    changed=setBuilderDoubleBondConfiguration(changed,aId,bId,desired.configuration,[...newIds]).structure;
  }
  return {structure:updateBuilderStereo(changed).structure,touchedIds:[...newIds]};
}
