import type { Atom, Bond, PeriodicCell, Structure, Vector3 } from '../../../core/types';
import type { AttachmentPort, ModelDocument, ModelSelection, PickResult, ScreenPoint, ScreenRect } from '../../../modeling/contracts';
import { getConnectedComponent } from '../../../core/modeling';
import { referenceKey } from '../../../core/modeling/graph';
import { builderExplicitGeometryFrame } from '../../../core/builder-geometry';
import { geometryGuide, type GeometryGuide } from '../../../core/geometry-guides';
import { cartesianToFractional, fractionalToCartesian } from '../../../core/periodic';
import {finishRenderWork,type RenderWork} from './render-work';

export const point = (a: Vector3) => ({ x: a[0], y: a[1], z: a[2] });
export const coordinates = (a: { x: number; y: number; z: number }): Vector3 => [a.x, a.y, a.z];
export const add = (a: Vector3, b: Vector3): Vector3 => a.map((n, i) => n + b[i]) as Vector3;
export const subtract = (a: Vector3, b: Vector3): Vector3 => a.map((n, i) => n - b[i]) as Vector3;
export const scale = (a: Vector3, n: number): Vector3 => a.map(v => v * n) as Vector3;
export const dot = (a: Vector3, b: Vector3) => a.reduce((n, v, i) => n + v * b[i], 0);
export const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function centroid(atoms: { x: number; y: number; z: number }[]): Vector3 {
  return atoms.length ? scale(atoms.reduce<Vector3>((sum, a) => add(sum, coordinates(a)), [0, 0, 0]), 1 / atoms.length) : [0, 0, 0];
}
/** Actual construction endpoint; no synthetic atom or auxiliary relation. */
export function attachmentPortEndpoint(host: Vector3, port: AttachmentPort): Vector3 | null {
  const length = Math.hypot(...port.direction);
  if (!port.direction.every(Number.isFinite) || !Number.isFinite(port.displayLength) || length < 1e-12 || port.displayLength <= 0) return null;
  return add(host, scale(port.direction, port.displayLength / length));
}
export function rotateVector(v: Vector3, q: number[]): Vector3 {
  const u: Vector3 = [q[0], q[1], q[2]], uv = cross(u, v), uuv = cross(u, uv);
  return add(v, add(scale(uv, 2 * q[3]), scale(uuv, 2)));
}
export interface DragPlane { origin: Vector3; right: Vector3; up: Vector3; projected: ScreenPoint; inverse: [number, number, number, number] }
/** A recoverable presentation failure. Never downgrade it to synthetic XYZ. */
export class ViewportProjectionError extends Error {
  constructor(public readonly code: 'viewport-unavailable' | 'invalid-view' | 'invalid-projection', message: string) {
    super(message); this.name = 'ViewportProjectionError';
  }
}
/** With an unchanged camera, two equal-depth view-plane basis vectors project
 * affinely even in perspective. No private camera or approximate XYZ Jacobian. */
export function dragPlane(project: (p: Vector3) => ScreenPoint, origin: Vector3, quaternion: number[]): DragPlane {
  const n = Math.hypot(...quaternion); if (quaternion.length !== 4 || !Number.isFinite(n) || n < 1e-12) throw new ViewportProjectionError('invalid-view', '视角四元数无效。');
  const q = quaternion.map((v, i) => (i < 3 ? -v : v) / n);
  const right = rotateVector([1, 0, 0], q), up = rotateVector([0, 1, 0], q), p = project(origin), x = project(add(origin, right)), y = project(add(origin, up));
  const a = x.x - p.x, b = y.x - p.x, c = x.y - p.y, d = y.y - p.y, det = a * d - b * c;
  if (![a, b, c, d, det].every(Number.isFinite) || Math.abs(det) < 1e-10) throw new ViewportProjectionError('invalid-projection', '当前视角无法建立拖动平面。');
  return { origin: [...origin], right, up, projected: p, inverse: [d / det, -b / det, -c / det, a / det] };
}
export function planeDelta(plane: DragPlane, dx: number, dy: number): Vector3 {
  const [a, b, c, d] = plane.inverse; return add(scale(plane.right, a * dx + b * dy), scale(plane.up, c * dx + d * dy));
}
export function planePoint(plane: DragPlane, screen: ScreenPoint): Vector3 { return add(plane.origin, planeDelta(plane, screen.x - plane.projected.x, screen.y - plane.projected.y)); }
export function rotatedAtoms(atoms: Atom[], ids: string[], rotation: { axis: Vector3; degrees: number; pivot: Vector3 }): Atom[] {
  const chosen = new Set(ids), length = Math.hypot(...rotation.axis); if (length < 1e-12) return atoms.map(a => ({ ...a }));
  const axis = scale(rotation.axis, 1 / length), angle = rotation.degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return atoms.map(atom => { if (!chosen.has(atom.id!)) return { ...atom }; const v = subtract(coordinates(atom), rotation.pivot), next = add(rotation.pivot, add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)))); return { ...atom, ...point(next) }; });
}
/** Auxiliary relations are intentionally absent: only actual graph edges join fragments. */
export function connectedIds(document: ModelDocument, start: string): string[] {
  return document.draft.structure.atoms.some(a => a.id === start) ? getConnectedComponent(document.draft.structure, start) : [];
}
export function selectionAfterPick(selection: ModelSelection, hit: PickResult): ModelSelection {
  const next = structuredClone(selection);
  if (hit.kind === 'atom') next.atomIds = next.atomIds.includes(hit.atomId) ? next.atomIds.filter(id => id !== hit.atomId) : [...next.atomIds, hit.atomId];
  else if (hit.kind === 'auxiliary') next.auxiliaryIds = next.auxiliaryIds.includes(hit.relationId) ? next.auxiliaryIds.filter(id => id !== hit.relationId) : [...next.auxiliaryIds, hit.relationId];
  else if (hit.kind === 'port') { const ids = next.portIds ?? []; next.portIds = ids.includes(hit.portId) ? ids.filter(id => id !== hit.portId) : [...ids, hit.portId]; }
  else if (hit.kind === 'bond') { const key = bondRefKey(hit), index = next.bonds.findIndex(b => bondRefKey(b) === key); if (index >= 0) next.bonds.splice(index, 1); else next.bonds.push(hit); }
  return next;
}
export function bondRefKey(ref: { atomIds: [string, string]; image?: Vector3 }): string {
  return referenceKey(ref);
}
export const bondConnectionOnly=(bond:Bond):boolean=>bond.orderKnown===false||bond.kind==='coordination';
/** UI-only endpoint array. Physical image resolution and scalar values have one core owner. */
export function measurementGeometryGuide(structure:Structure,type:'B'|'A'|'D',atomIds:readonly string[],images?:readonly Vector3[]):GeometryGuide {
  const frame=builderExplicitGeometryFrame(structure,type,atomIds,images);
  const endpoints=frame.positions.map((position,index)=>({...structure.atoms.find(atom=>atom.id===atomIds[index])!,...point(position)}));
  const guide=geometryGuide(endpoints,{type,atoms:endpoints.map((_,index)=>index)});
  const identity=atomIds.map((id,index)=>`${structure.atoms.findIndex(atom=>atom.id===id)+1}${images?.some(image=>image.some(Boolean))?'['+images[index].join(',')+']':''}`).join(' ');
  return {...guide,value:guide.error?null:frame.value,label:`${type} ${identity}${guide.error?'':` = ${frame.value.toFixed(type==='B'?3:2)}${type==='B'?' Å':'°'}`}`};
}
export function unionBox(selection: ModelSelection, atoms: Atom[], project: (point: Vector3) => ScreenPoint, rect: ScreenRect): ModelSelection {
  const ids = atoms.flatMap(a => { const p = project(coordinates(a)); return p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom ? [a.id!] : []; });
  return { ...structuredClone(selection), atomIds: [...new Set([...selection.atomIds, ...ids])] };
}
function cellPoint(cell: PeriodicCell, f: Vector3): Vector3 { return cell.vectors.reduce((sum, v, i) => add(sum, scale(v, f[i])), cell.origin ? [...cell.origin] : [0, 0, 0] as Vector3); }
/** A real cell is a complete box irrespective of its periodic directions.
 * A library layer reference plane is an explicit presentation-only exception. */
export type CellFramePresentation = 'full-box' | 'periodic-plane';
export function cellSegments(cell: PeriodicCell, presentation: CellFramePresentation = 'full-box'): [Vector3, Vector3][] {
  const axes=cell.pbc.flatMap((enabled,index)=>enabled?[index]:[]);
  if(presentation==='periodic-plane'&&axes.length===2){
    const [a,b]=axes,origin:Vector3=cell.origin?[...cell.origin]:[0,0,0],u=cell.vectors[a],v=cell.vectors[b];
    return [[origin,add(origin,u)],[add(origin,u),add(add(origin,u),v)],[add(add(origin,u),v),add(origin,v)],[add(origin,v),origin]];
  }
  const result: [Vector3, Vector3][] = []; for (let n = 0; n < 8; n++) for (let k = 0; k < 3; k++) if (!(n & (1 << k))) { const f: Vector3 = [n & 1, (n >> 1) & 1, (n >> 2) & 1], g: Vector3 = [...f]; g[k] = 1; result.push([cellPoint(cell, f), cellPoint(cell, g)]); } return result;
}
/** Explicit half-order bonds are physical short cylinders. Clip each dash in
 * the full physical relation's parameter so periodic face splits keep phase. */
export function dashedBondSections(section:CellPathSection,physicalLength:number,bondScale=1):CellPathSection[]{
  return finishRenderWork(dashedBondSectionsWork(section,physicalLength,bondScale));
}
export function* dashedBondSectionsWork(section:CellPathSection,physicalLength:number,bondScale=1):RenderWork<CellPathSection[]>{
  if(!Number.isFinite(physicalLength)||physicalLength<=1e-12)return [];
  const period=.34*bondScale/physicalLength,dash=.20*bondScale/physicalLength,result:CellPathSection[]=[];
  const delta=subtract(section.end,section.start),span=section.t1-section.t0;
  if(span<=1e-12)return result;
  if(!(period>0)||!Number.isFinite(period)||!Number.isSafeInteger(Math.ceil(1/period)))throw new Error('半键显示分段数超出可精确表示范围。');
  for(let index=Math.floor(section.t0/period),end=Math.ceil(section.t1/period);index<end;index++){
    yield;const t=index*period;if(t+period===t)throw new Error('半键显示步长超出坐标精度范围。');
    const t0=Math.max(t,section.t0),t1=Math.min(t+dash,section.t1);
    if(t1-t0>1e-10)result.push({...section,t0,t1,sourceT0:Math.max(0,t),sourceT1:Math.min(1,t+dash),start:add(section.start,scale(delta,(t0-section.t0)/span)),end:add(section.start,scale(delta,(t1-section.t0)/span))});
  }
  return result;
}
/** Clip a display primitive's centreline against the actual periodic axes.
 * Shared by ordinary image connections and native multi-bond primitives. */
export function clipCellSegment(start:Vector3,end:Vector3,cell:PeriodicCell):{start:Vector3;end:Vector3;cutStart:boolean;cutEnd:boolean}|null {
  const [u,v,w]=cell.vectors,det=dot(u,cross(v,w));if(Math.abs(det)<1e-10)return null;
  const frac=(p:Vector3):Vector3=>{const r=subtract(p,cell.origin??[0,0,0]);return [dot(r,cross(v,w))/det,dot(r,cross(w,u))/det,dot(r,cross(u,v))/det];};
  const f=frac(start),g=frac(end);let lo=0,hi=1;
  for(let axis=0;axis<3;axis++){
    if(!cell.pbc[axis])continue;
    const delta=g[axis]-f[axis];
    if(Math.abs(delta)<1e-10){if(f[axis]<-1e-8||f[axis]>1+1e-8)return null;}
    else {const a=-f[axis]/delta,b=(1-f[axis])/delta;lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));}
  }
  if(hi-lo<1e-9)return null;
  const delta=subtract(end,start);return {start:add(start,scale(delta,lo)),end:add(start,scale(delta,hi)),cutStart:lo>1e-9,cutEnd:hi<1-1e-9};
}
export interface CellPathSection {start:Vector3;end:Vector3;t0:number;t1:number;shift:Vector3;sourceT0?:number;sourceT1?:number}
/** Split a given physical/display segment at every crossed integer face.
 * No minimum-image choice: each returned tile is determined by this path.
 * Preflight the total face count before enumerating any plane. */
export function cellPathSections(start:Vector3,end:Vector3,cell:PeriodicCell):CellPathSection[] {
  return finishRenderWork(cellPathSectionsWork(start,end,cell));
}
export function* cellPathSectionsWork(start:Vector3,end:Vector3,cell:PeriodicCell):RenderWork<CellPathSection[]> {
  if(![...start,...end].every(Number.isFinite))throw new Error('晶胞显示路径需要有限坐标。');
  const delta=subtract(end,start);if(!delta.every(Number.isFinite))throw new Error('晶胞显示路径差值超出有限范围。');if(Math.hypot(...delta)<1e-12)return [];
  const first=cartesianToFractional(cell,start),last=cartesianToFractional(cell,end),df=subtract(last,first);
  if(![...first,...last,...df].every(Number.isFinite))throw new Error('晶胞显示路径分数坐标超出有限范围。');
  const ranges:{axis:number;lo:number;hi:number}[]=[];let crossings=0;
  for(let axis=0;axis<3;axis++){
    if(!cell.pbc[axis]||Math.abs(df[axis])<1e-12)continue;
    const lo=Math.floor(Math.min(first[axis],last[axis]))+1,hi=Math.ceil(Math.max(first[axis],last[axis]))-1;
    if(!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi))throw new Error('晶胞显示路径整数面超出安全范围。');
    crossings+=Math.max(0,hi-lo+1);if(!Number.isSafeInteger(crossings+1))throw new Error('晶胞显示路径段数超出可精确表示范围。');
    ranges.push({axis,lo,hi});
  }
  const timeTolerance=Math.max(16*Number.EPSILON,1e-10/Math.max(1,Math.hypot(...delta))),times=[0],result:CellPathSection[]=[];
  // Merge the three already ordered plane streams, avoiding a giant blocking sort.
  const streams=ranges.map(range=>({...range,step:df[range.axis]>0?1:-1,plane:df[range.axis]>0?range.lo:range.hi}));
  while(true){yield;let chosen:typeof streams[number]|undefined,time=Infinity;
    for(const stream of streams){if(stream.plane<stream.lo||stream.plane>stream.hi)continue;const next=(stream.plane-first[stream.axis])/df[stream.axis];if(next<time){chosen=stream;time=next;}}
    if(!chosen)break;chosen.plane+=chosen.step;if(time>0&&time<1&&time-times[times.length-1]>timeTolerance)times.push(time);
  }
  // Always keep the exact endpoint: a crossing near t=1 must not truncate
  // the final physical tail merely because a face is numerically nearby.
  times.push(1);
  for(let index=1;index<times.length;index++){
    yield;
    const t0=times[index-1],t1=times[index];if(t1<=t0)continue;
    const mid=(t0+t1)/2,shift=first.map((value,axis)=>{
      if(!cell.pbc[axis])return 0;
      // Preserve an existing constant base-cell face, e.g. z=1, rather than
      // moving an entire on-face path to the opposite side.
      if(Math.abs(df[axis])<1e-12&&value>=-1e-10&&value<=1+1e-10)return 0;
      return -Math.floor(value+df[axis]*mid)||0;
    }) as Vector3;
    const translation=fractionalToCartesian(cell,shift,false);
    result.push({start:add(add(start,scale(delta,t0)),translation),end:add(add(start,scale(delta,t1)),translation),t0,t1,shift});
  }
  return result;
}
export function bondPathSections(atoms:Atom[],bond:Bond,cell?:PeriodicCell):CellPathSection[] {
  return finishRenderWork(bondPathSectionsWork(atoms,bond,cell));
}
export function* bondPathSectionsWork(atoms:Atom[],bond:Bond,cell?:PeriodicCell):RenderWork<CellPathSection[]> {
  const a=atoms[bond.a],b=atoms[bond.b];if(!a||!b)return [];
  const start=coordinates(a),end=coordinates(b);
  if(!cell||!bond.image?.some(Boolean))return Math.hypot(...subtract(end,start))<1e-12?[]:[{start,end,t0:0,t1:1,shift:[0,0,0]}];
  const active={...cell,pbc:cell.pbc.map((enabled,axis)=>enabled&&!!bond.image?.[axis]) as [boolean,boolean,boolean]};
  return yield* cellPathSectionsWork(start,add(end,fractionalToCartesian(cell,bond.image,false)),active);
}
export function bondSegments(atoms: Atom[], bond: Bond, cell?: PeriodicCell): [Vector3, Vector3][] {
  return bondPathSections(atoms,bond,cell).map(section=>[section.start,section.end]);
}
