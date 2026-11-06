import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Maximize2, RotateCcw } from 'lucide-react';
import type { Atom, Bond, PeriodicCell } from '../core/types';
import { geometryGuide, type CoordinateGuide } from '../core/geometry-guides';
import './picker.css';
import { membershipColor,regionMembership,type MoleculeRegion } from '../core/regions';
import { availableColorModes, defaultColorMode, displayedRegions, validDisplayAtoms, SCAN_COLOR, FREEZE_COLOR, type BaseColorMode, type ViewerHighlights, type DisplayCoordinate } from '../core/display-highlights';
import RegionLegend from './RegionLegend';
import './viewer-highlights.css';
import './viewer-builder.css';
const EMPTY_REGIONS:MoleculeRegion[]=[];
const EMPTY_HIGHLIGHTS:ViewerHighlights={};
type ViewerColorMode=BaseColorMode|'frozen';
const BUILDER_COLOR_MODES:ViewerColorMode[]=['elements','frozen','basis','layers','fragments'];
const BUILDER_COLOR_LABELS:Record<ViewerColorMode,string>={elements:'本色（默认）',frozen:'冻结设置',basis:'基组',layers:'QM/MM',fragments:'片段'};

const COLORS: Record<string, string> = { C: '#46566b', H: '#e8edf1', O: '#ef6567', N: '#6c8fe3', S: '#e9bd4b', Cl: '#6eae77', F: '#77bca0', P: '#e99c53', Ca: '#82a878' };
export interface ViewerPoint {x:number;y:number;z:number}
export interface ViewerEditing {
  mode:'navigate'|'select'|'add'|'bond'|'delete'|'move';
  onAtomAction?:(index:number)=>void;
  onBondAction?:(a:number,b:number)=>void;
  onAddAtom?:(position:ViewerPoint)=>void;
  /** Total displacement from pointer-down; only commit=true persists the edit. */
  onMoveAtoms?:(indices:number[],delta:ViewerPoint,commit:boolean)=>void;
}
export interface ViewerOrientation2D {revision?:number;points:Record<string,{x:number;y:number}>|{index:number;x:number;y:number}[]}
const sub=(a:ViewerPoint,b:ViewerPoint):ViewerPoint=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const dot=(a:ViewerPoint,b:ViewerPoint)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:ViewerPoint,b:ViewerPoint):ViewerPoint=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const unit=(a:ViewerPoint)=>{const n=Math.hypot(a.x,a.y,a.z);return n>1e-9?{x:a.x/n,y:a.y/n,z:a.z/n}:null;};
const center=(points:ViewerPoint[]):ViewerPoint=>points.length?points.reduce((p,a)=>({x:p.x+a.x/points.length,y:p.y+a.y/points.length,z:p.z+a.z/points.length}),{x:0,y:0,z:0}):{x:0,y:0,z:0};

/** Invert the projected local basis with the minimum-norm solution: movement is
 * on the screen-parallel plane through the grabbed atom, including rotated views. */
export function screenPlaneDelta(project:(point:ViewerPoint)=>{x:number;y:number},origin:ViewerPoint,dx:number,dy:number):ViewerPoint {
  const p=project(origin),epsilon=.01;
  const cols=[{x:epsilon,y:0,z:0},{x:0,y:epsilon,z:0},{x:0,y:0,z:epsilon}].map(v=>{const q=project({x:origin.x+v.x,y:origin.y+v.y,z:origin.z+v.z});return {x:(q.x-p.x)/epsilon,y:(q.y-p.y)/epsilon};});
  const xx=cols.reduce((s,c)=>s+c.x*c.x,0),xy=cols.reduce((s,c)=>s+c.x*c.y,0),yy=cols.reduce((s,c)=>s+c.y*c.y,0),det=xx*yy-xy*xy;
  if(Math.abs(det)<1e-10)return {x:0,y:0,z:0};
  const a=(yy*dx-xy*dy)/det,b=(xx*dy-xy*dx)/det;
  return {x:cols[0].x*a+cols[0].y*b,y:cols[1].x*a+cols[1].y*b,z:cols[2].x*a+cols[2].y*b};
}

/** Build two right-handed frames. Their rotation always has determinant +1;
 * the diagram can orient a camera but can never flatten or mirror coordinates. */
export function orientationQuaternion(atoms:Atom[],signal:ViewerOrientation2D):number[]|null {
  const mapped=atoms.flatMap((atom,index)=>{const p=Array.isArray(signal.points)?signal.points.find(p=>p.index===index):atom.id?signal.points[atom.id]:undefined;return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)?[{source:atom,target:{x:p.x,y:-p.y,z:0}}]:[];});
  if(mapped.length<2)return null;
  let i0=0,i1=1,best=0;
  for(let i=0;i<mapped.length;i++)for(let j=i+1;j<mapped.length;j++){const d=dot(sub(mapped[j].source,mapped[i].source),sub(mapped[j].source,mapped[i].source));if(d>best&&Math.hypot(mapped[j].target.x-mapped[i].target.x,mapped[j].target.y-mapped[i].target.y)>1e-8){best=d;i0=i;i1=j;}}
  const s1=unit(sub(mapped[i1].source,mapped[i0].source)),t1=unit(sub(mapped[i1].target,mapped[i0].target));if(!s1||!t1)return null;
  let s3:ViewerPoint|null=null,t3:ViewerPoint|null=null,area=0;
  for(const p of mapped){const sc=cross(s1,sub(p.source,mapped[i0].source)),tc=cross(t1,sub(p.target,mapped[i0].target)),score=dot(sc,sc);if(score>area&&dot(tc,tc)>1e-12){area=score;s3=unit(sc);t3=unit(tc);}}
  if(!s3||!t3){const v=cross(s1,t1),w=1+dot(s1,t1);if(w<1e-8){const axis=unit(cross(s1,Math.abs(s1.x)<.8?{x:1,y:0,z:0}:{x:0,y:1,z:0}))!;return [axis.x,axis.y,axis.z,0];}const n=Math.hypot(v.x,v.y,v.z,w);return [v.x/n,v.y/n,v.z/n,w/n];}
  const s2=cross(s3,s1),t2=cross(t3,t1),s=[s1,s2,s3],t=[t1,t2,t3],axes=['x','y','z'] as const;
  const m=axes.map(row=>axes.map(col=>t.reduce((v,p,k)=>v+p[row]*s[k][col],0))),trace=m[0][0]+m[1][1]+m[2][2];let q:number[];
  if(trace>0){const n=Math.sqrt(trace+1)*2;q=[(m[2][1]-m[1][2])/n,(m[0][2]-m[2][0])/n,(m[1][0]-m[0][1])/n,n/4];}
  else {const k=m[0][0]>m[1][1]?(m[0][0]>m[2][2]?0:2):(m[1][1]>m[2][2]?1:2),a=(k+1)%3,b=(k+2)%3,n=Math.sqrt(1+m[k][k]-m[a][a]-m[b][b])*2;q=[0,0,0,(m[b][a]-m[a][b])/n];q[k]=n/4;q[a]=(m[a][k]+m[k][a])/n;q[b]=(m[b][k]+m[k][b])/n;}
  const n=Math.hypot(...q);return q.map(v=>v/n);
}

function cellPoint(cell:PeriodicCell,f:number[]):ViewerPoint {const o=cell.origin??[0,0,0];return {x:o[0]+cell.vectors.reduce((v,a,k)=>v+a[0]*f[k],0),y:o[1]+cell.vectors.reduce((v,a,k)=>v+a[1]*f[k],0),z:o[2]+cell.vectors.reduce((v,a,k)=>v+a[2]*f[k],0)};}
export function cellEdges(cell:PeriodicCell):[ViewerPoint,ViewerPoint][] {const result:[ViewerPoint,ViewerPoint][]=[];for(let n=0;n<8;n++)for(let k=0;k<3;k++)if(!(n&(1<<k))){const f=[n&1,(n>>1)&1,(n>>2)&1];const g=[...f];g[k]=1;result.push([cellPoint(cell,f),cellPoint(cell,g)]);}return result;}
export function periodicBondSegments(atoms:Atom[],bond:Bond,cell:PeriodicCell):[ViewerPoint,ViewerPoint][] {
  const a=atoms[bond.a],b=atoms[bond.b];if(!a||!b||!bond.image?.some(Boolean))return [];
  const [va,vb,vc]=cell.vectors.map(v=>({x:v[0],y:v[1],z:v[2]})),det=dot(va,cross(vb,vc));if(Math.abs(det)<1e-10)return [];
  const origin=cellPoint(cell,[0,0,0]),frac=(p:ViewerPoint)=>{const r=sub(p,origin);return [dot(r,cross(vb,vc))/det,dot(r,cross(vc,va))/det,dot(r,cross(va,vb))/det];};
  const shift=cellPoint({...cell,origin:[0,0,0]},bond.image),imageB={x:b.x+shift.x,y:b.y+shift.y,z:b.z+shift.z},imageA={x:a.x-shift.x,y:a.y-shift.y,z:a.z-shift.z};
  const clip=(p:ViewerPoint,q:ViewerPoint):[ViewerPoint,ViewerPoint]|null=>{const f=frac(p),g=frac(q);let lo=0,hi=1;for(let k=0;k<3;k++){if(!cell.pbc[k])continue;const d=g[k]-f[k];if(Math.abs(d)<1e-10){if(f[k]<-1e-8||f[k]>1+1e-8)return null;}else{const x=-f[k]/d,y=(1-f[k])/d;lo=Math.max(lo,Math.min(x,y));hi=Math.min(hi,Math.max(x,y));}}if(hi-lo<1e-9)return null;const at=(t:number)=>({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t,z:p.z+(q.z-p.z)*t});return [at(lo),at(hi)];};
  return [clip(a,imageB),clip(b,imageA)].filter((p):p is [ViewerPoint,ViewerPoint]=>!!p);
}

function FallbackMolecule({ atoms, bonds, selected, onSelect,labels,elements,interaction,coordinateGuide,regions,overlays,frozenAtoms }: { atoms: Atom[]; bonds?:Bond[]; selected:number[]; labels:boolean;elements:boolean;interaction:'rotate'|'click'|'box';coordinateGuide?:CoordinateGuide;regions:MoleculeRegion[];overlays:{coordinate:DisplayCoordinate;color:string}[];frozenAtoms:number[];onSelect?:(indices:number[])=>void }) {
  const [box,setBox]=useState<{x:number;y:number;endX:number;endY:number;add:boolean}|null>(null);
  const membership=regionMembership(atoms.length,regions);
  const xs = atoms.map(atom => atom.x + atom.z * 0.35);
  const ys = atoms.map(atom => atom.y - atom.z * 0.3);
  const x0 = Math.min(...(xs.length?xs:[0])), x1 = Math.max(...(xs.length?xs:[0])), y0 = Math.min(...(ys.length?ys:[0])), y1 = Math.max(...(ys.length?ys:[0]));
  const scale = Math.min(240 / Math.max(x1 - x0, 1), 180 / Math.max(y1 - y0, 1));
  const positions = atoms.map((atom, i) => ({ ...atom, cx: 190 + (xs[i] - (x0 + x1) / 2) * scale, cy: 130 - (ys[i] - (y0 + y1) / 2) * scale }));
  const pairs: [number, number][] = [];
  if(bonds) bonds.forEach(bond=>{if(positions[bond.a]&&positions[bond.b])pairs.push([bond.a,bond.b]);});
  else atoms.forEach((a, i) => atoms.forEach((b, j) => {
    if (j <= i) return;
    const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (distance > 0.25 && distance < (a.element === 'H' || b.element === 'H' ? 1.25 : 1.85)) pairs.push([i, j]);
  }));
  const project=(point:{x:number;y:number;z:number})=>({x:190+(point.x+point.z*.35-(x0+x1)/2)*scale,y:130-(point.y-point.z*.3-(y0+y1)/2)*scale});
  const pointAt=(event:React.PointerEvent<SVGSVGElement>)=>{const point=event.currentTarget.createSVGPoint();point.x=event.clientX;point.y=event.clientY;const matrix=event.currentTarget.getScreenCTM();return matrix?point.matrixTransform(matrix.inverse()):point;};
  const guide=coordinateGuide?geometryGuide(atoms,coordinateGuide):null;
  return <div className="fallback-view"><svg viewBox="0 0 380 260" aria-label="结构二维投影" data-testid="fallback-projection" style={{touchAction:interaction==='box'?'none':undefined}} onPointerDown={event=>{if(interaction!=='box'||!onSelect)return;const point=pointAt(event);setBox({x:point.x,y:point.y,endX:point.x,endY:point.y,add:true});event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(!box)return;const point=pointAt(event);setBox({...box,endX:point.x,endY:point.y});}} onPointerUp={event=>{if(!box||!onSelect)return;const point=pointAt(event);const indices=positions.flatMap((atom,i)=>atom.cx>=Math.min(box.x,point.x)&&atom.cx<=Math.max(box.x,point.x)&&atom.cy>=Math.min(box.y,point.y)&&atom.cy<=Math.max(box.y,point.y)?[i]:[]);onSelect([...new Set([...selected,...indices])]);setBox(null);}} onPointerCancel={()=>setBox(null)}>
    {pairs.map(([i, j]) => <line key={`${i}-${j}`} x1={positions[i].cx} y1={positions[i].cy} x2={positions[j].cx} y2={positions[j].cy} stroke={regions.length?membershipColor(membership.memberships[i]):'#b2beca'} strokeWidth={membership.memberships[i][0]?.style==='stick'&&membership.memberships[j][0]?.style==='stick'?3:7} strokeLinecap="round" />)}
    {guide?.paths.map((path,i)=><polyline key={i} points={path.map(point=>{const p=project(point);return `${p.x},${p.y}`;}).join(' ')} fill="none" stroke="#437c79" strokeWidth="1.4" strokeDasharray="4 4" pointerEvents="none"/>)}
    {overlays.flatMap(({coordinate,color})=>geometryGuide(atoms,coordinate).paths.map((path,i)=><polyline key={coordinate.id+'-'+i} data-highlight-coordinate={coordinate.id} points={path.map(point=>{const p=project(point);return `${p.x},${p.y}`;}).join(' ')} fill="none" stroke={color} strokeWidth="1.7" strokeDasharray="4 4" pointerEvents="none"/>))}
    {frozenAtoms.map(index=><circle key={'freeze-'+index} data-frozen-atom={index+1} cx={positions[index].cx} cy={positions[index].cy} r={positions[index].element==='H'?14:21} fill="none" stroke={FREEZE_COLOR} strokeWidth="2" strokeDasharray="3 3" pointerEvents="none"/>)}
    {positions.map((atom, i) => <g key={i} role="button" tabIndex={interaction==='click'?0:-1} aria-pressed={selected.includes(i)} aria-label={`原子 ${i+1} ${atom.element}`} data-region={membership.memberships[i].map(item=>item.id).join(',')} onKeyDown={event=>{if(interaction==='click'&&['Enter',' '].includes(event.key)){event.preventDefault();onSelect?.(selected.includes(i)?selected.filter(index=>index!==i):[...selected,i]);}}} onClick={()=>{if(interaction==='click')onSelect?.(selected.includes(i)?selected.filter(index=>index!==i):[...selected,i]);}}><circle cx={atom.cx} cy={atom.cy} r={membership.memberships[i].length===1&&membership.memberships[i][0]?.style==='stick'?5:atom.element === 'H' ? 10 : 17} fill={regions.length?membershipColor(membership.memberships[i]):selected.includes(i)?'#d9a454':COLORS[atom.element] ?? '#a27bca'} stroke={selected.includes(i)&&regions.length?'#c68d35':'white'} strokeWidth={selected.includes(i)&&regions.length?4:2} />{(labels||elements)&&<text x={atom.cx} y={atom.cy + 4} textAnchor="middle" fontSize="10" fill={atom.element === 'H'||membership.memberships[i][0]?.style==='stick' ? '#596375' : '#fff'}>{[labels?i+1:null,elements?atom.element:null].filter(value=>value!==null).join(' ')}</text>}</g>)}
    {box&&<rect x={Math.min(box.x,box.endX)} y={Math.min(box.y,box.endY)} width={Math.abs(box.endX-box.x)} height={Math.abs(box.endY-box.y)} fill="#2eae8b23" stroke="#27a583" pointerEvents="none"/>}
  </svg><span>WebGL不可用 · 当前为二维投影</span></div>;
}

export interface MoleculeViewerProps { atoms:Atom[]; bonds?:Bond[]; selected?:number[]; onSelect?:(indices:number[])=>void;initialInteraction?:'rotate'|'click'|'box';initialLabels?:boolean;initialElements?:boolean;coordinateGuide?:CoordinateGuide;regions?:MoleculeRegion[];highlights?:ViewerHighlights;selectionControls?:ReactNode;editing?:ViewerEditing;cell?:PeriodicCell;orientation2D?:ViewerOrientation2D }
export default function MoleculeViewer({ atoms, bonds, selected=[], onSelect, initialInteraction='rotate',initialLabels=false,initialElements=false,coordinateGuide,regions=EMPTY_REGIONS,highlights=EMPTY_HIGHLIGHTS,selectionControls,editing,cell,orientation2D }: MoleculeViewerProps) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<any>(null);
  const modelRef=useRef<any>(null);
  const initializedView=useRef(false);
  const current=useRef({selected,onSelect});current.current={selected,onSelect};
  const [interaction,setInteraction]=useState<'rotate'|'click'|'box'>(initialInteraction);
  const interactionRef=useRef(interaction);interactionRef.current=editing?.mode==='navigate'?'rotate':interaction;
  const [box,setBox]=useState<{x:number;y:number;endX:number;endY:number}|null>(null);
  const drag=useRef<{x:number;y:number;pageX:number;pageY:number;add:boolean}|null>(null);
  const [mode, setMode] = useState<'ball' | 'stick'>('ball');
  const [labels, setLabels] = useState(initialLabels);
  const [elements,setElements]=useState(initialElements);
  const mergedHighlights={...highlights,fragments:highlights.fragments??regions};
  const [baseMode,setBaseMode]=useState<ViewerColorMode|null>(null);
  const modes=editing?BUILDER_COLOR_MODES:availableColorModes(mergedHighlights);
  const activeMode=baseMode&&modes.includes(baseMode)?baseMode:editing?'elements':defaultColorMode(mergedHighlights);
  const [showRegionColors,setShowRegionColors]=useState(true);
  const rawFrozenAtoms=validDisplayAtoms(highlights.frozenAtoms??[],atoms.length);
  const activeRegions=showRegionColors?(activeMode==='frozen'?(rawFrozenAtoms.length?[{id:'viewer-active-freeze',label:'冻结设置',color:FREEZE_COLOR,atomIndices:rawFrozenAtoms}]:EMPTY_REGIONS):displayedRegions(mergedHighlights,activeMode)):EMPTY_REGIONS;
  const [showRegions,setShowRegions]=useState(true);
  const [showScan,setShowScan]=useState(true);
  const [showFreeze,setShowFreeze]=useState(true);
  const overlays=[...(showScan?(highlights.scan??[]).map(coordinate=>({coordinate,color:SCAN_COLOR})):[]),...(showFreeze?(highlights.frozenCoordinates??[]).map(coordinate=>({coordinate,color:FREEZE_COLOR})):[])];
  const frozenAtoms=showFreeze?rawFrozenAtoms:[];
  const guideShapes=useRef<any[]>([]);
  const guide=coordinateGuide?geometryGuide(atoms,coordinateGuide):null;
  const [fallback, setFallback] = useState(false);
  const [ready, setReady] = useState(false);
  const [bondAnchor,setBondAnchor]=useState<number|null>(null);
  const [moving,setMoving]=useState(false);
  const [moveAxis,setMoveAxis]=useState<'screen'|'x'|'y'|'z'>('screen');
  const moveDrag=useRef<{indices:number[];origin:ViewerPoint;x:number;y:number;delta:ViewerPoint;source:Atom[]}|null>(null);
  const renderGuideShapes=useRef<(positions:Atom[])=>void>(()=>{});
  const diagramOrientation=useMemo(()=>cell||!orientation2D?null:orientationQuaternion(atoms,orientation2D),[atoms,orientation2D?.points,cell]);
  const appearance=useRef<HTMLDivElement>(null);
  const [appearanceHeight,setAppearanceHeight]=useState(42);
  const builderLegend=!!editing&&showRegions&&activeMode!=='elements';
  useEffect(()=>{
    if(!editing||!appearance.current)return;
    const node=appearance.current,measure=()=>setAppearanceHeight(Math.ceil(node.getBoundingClientRect().height));measure();
    const observer=new ResizeObserver(measure);observer.observe(node);return ()=>observer.disconnect();
  },[!!editing]);
  useEffect(()=>{setBondAnchor(null);},[editing?.mode,atoms.length]);

  useEffect(() => {
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    async function mount() {
      try {
        const mol = await import('3dmol');
        if (cancelled || !container.current) return;
        const instance = mol.createViewer(container.current, { backgroundColor: '#f7f9fb', antialias: true });
        if (!instance) throw new Error('WebGL未初始化');
        viewer.current = instance;
        observer = new ResizeObserver(() => { instance.resize(); instance.render(); });
        observer.observe(container.current);
        setReady(true);
      } catch { if (!cancelled) setFallback(true); }
    }
    mount();
    return () => { cancelled = true; observer?.disconnect(); viewer.current?.clear(); viewer.current = null; container.current?.replaceChildren(); };
  }, []);

  useEffect(() => {
    if (!ready || !viewer.current) return;
    const instance = viewer.current;
    const savedView=initializedView.current?instance.getView():null;
    if(modelRef.current)instance.removeModel(modelRef.current);
    const xyz = `${atoms.length}\nPreview only\n${atoms.map(atom => `${atom.element} ${atom.x} ${atom.y} ${atom.z}`).join('\n')}\n`;
    const model=instance.addModel(xyz, 'xyz');
    modelRef.current=model;
    if(bonds){const displayed=model.selectedAtoms({});for(const atom of displayed){atom.bonds=[];atom.bondOrder=[];}for(const bond of bonds){if(cell&&bond.image?.some(Boolean))continue;displayed[bond.a]?.bonds.push(bond.b);displayed[bond.a]?.bondOrder.push(bond.order);displayed[bond.b]?.bonds.push(bond.a);displayed[bond.b]?.bondOrder.push(bond.order);}}
    instance.setClickable({},true,(atom:any)=>{if(interactionRef.current!=='click')return;const values=current.current.selected;current.current.onSelect?.(values.includes(atom.index)?values.filter(i=>i!==atom.index):[...values,atom.index]);});
    if(savedView)instance.setView(savedView);
    else if(atoms.length){if(cell)renderGuideShapes.current(atoms);instance.zoomTo();instance.rotate(18,'x');instance.rotate(-15,'y');instance.zoom(cell?1.02:editing?1.1:atoms.length<20?1.8:1.12);initializedView.current=true;}
    instance.render();
  }, [atoms,bonds,ready,cell]);
  useEffect(()=>{
    if(!ready||!viewer.current)return;const instance=viewer.current;
    instance.setStyle({},mode==='ball'?{stick:{radius:0.15,colorscheme:'Jmol'},sphere:{scale:0.27,colorscheme:'Jmol'}}:{stick:{radius:0.12,colorscheme:'Jmol'}});
    if(activeRegions.length){
      const membership=regionMembership(atoms.length,activeRegions);const groups=new Map<string,number[]>();
      membership.memberships.forEach((items,index)=>{const color=membershipColor(items);const ids=groups.get(color);if(ids)ids.push(index);else groups.set(color,[index]);});
      for(const [color,indices] of groups)instance.setStyle({index:indices},mode==='ball'?{stick:{radius:.15,color},sphere:{scale:.27,color}}:{stick:{radius:.12,color}});
      const selectedSet=new Set(selected);for(const [color,indices] of groups){const active=indices.filter(index=>selectedSet.has(index));if(active.length)instance.setStyle({index:active},mode==='ball'?{stick:{radius:.2,color},sphere:{scale:.36,color}}:{stick:{radius:.2,color}});}
      for(const region of activeRegions.filter(region=>region.style==='stick')){const ids=validDisplayAtoms(region.atomIndices,atoms.length).filter(index=>membership.memberships[index].length===1);instance.setStyle({index:ids},{stick:{radius:.1,color:region.color}});const chosen=ids.filter(index=>selected.includes(index));if(chosen.length)instance.setStyle({index:chosen},{stick:{radius:.19,color:region.color}});}
    }else if(selected.length)instance.setStyle({index:selected},editing?{stick:{radius:.2,colorscheme:'Jmol'},...(mode==='ball'?{sphere:{scale:.36,colorscheme:'Jmol'}}:{})}:{stick:{radius:0.18,color:'#d8a04b'},sphere:{scale:0.34,color:'#e5b365'}});
    instance.removeAllLabels();
    // Region labels belong in the side legend; no labels cover molecular centers.
    if(labels||elements)atoms.forEach((atom,i)=>instance.addLabel([labels?i+1:null,elements?atom.element:null].filter(value=>value!==null).join(' '),{position:{x:atom.x,y:atom.y,z:atom.z},fontSize:11,fontColor:selected.includes(i)?'#8e651d':'#334155',backgroundOpacity:0.75,backgroundColor:'white',borderThickness:0,inFront:true}));
    instance.render();
  },[ready,atoms,bonds,mode,labels,elements,selected,activeRegions,showRegions]);

  renderGuideShapes.current=(positions:Atom[])=>{
    if(!viewer.current)return;
    const instance=viewer.current;
    for(const shape of guideShapes.current)instance.removeShape(shape);
    guideShapes.current=[];
    for(const {coordinate,color} of [...(coordinateGuide?[{coordinate:coordinateGuide,color:'#437c79'}]:[]),...overlays]){
      const next=geometryGuide(positions,coordinate);
      for(const path of next.paths){
        if(path.length===2)guideShapes.current.push(instance.addLine({start:{...path[0]},end:{...path[1]},color,linewidth:1.25,dashed:true,dashLength:.08,gapLength:.07,opacity:.8}));
        else for(let i=1;i<path.length;i+=2)guideShapes.current.push(instance.addLine({start:{...path[i-1]},end:{...path[i]},color,linewidth:1.25,opacity:.8}));
      }
    }
    for(const index of frozenAtoms)guideShapes.current.push(instance.addSphere({center:{x:positions[index].x,y:positions[index].y,z:positions[index].z},radius:positions[index].element==='H'?.34:.52,color:FREEZE_COLOR,opacity:.22,wireframe:true}));
    if(cell){
      for(const [start,end] of cellEdges(cell))guideShapes.current.push(instance.addLine({start,end,color:'#8b9ba9',linewidth:1.3,opacity:.75}));
      for(const bond of bonds??[])for(const [start,end] of periodicBondSegments(positions,bond,cell))guideShapes.current.push(instance.addCylinder({start,end,radius:mode==='ball'?.12:.09,color:'#74899a',opacity:.85,fromCap:0,toCap:0}));
    }
    instance.render();
  };
  useEffect(()=>{if(ready)renderGuideShapes.current(atoms);},[ready,atoms,bonds,coordinateGuide,highlights,showScan,showFreeze,cell,mode]);

  const previewMove=(source:Atom[],indices:number[],delta:ViewerPoint)=>{
    const instance=viewer.current,model=modelRef.current;if(!instance||!model)return;
    const moved=new Set(indices),points=source.map((a,i)=>moved.has(i)?{...a,x:a.x+delta.x,y:a.y+delta.y,z:a.z+delta.z}:a),displayed=model.selectedAtoms({});
    for(const i of indices){if(!displayed[i])continue;Object.assign(displayed[i],{x:points[i].x,y:points[i].y,z:points[i].z});model.setStyle({index:i},displayed[i].style,true);}
    instance.removeAllLabels();
    if(labels||elements)points.forEach((atom,i)=>instance.addLabel([labels?i+1:null,elements?atom.element:null].filter(v=>v!==null).join(' '),{position:{x:atom.x,y:atom.y,z:atom.z},fontSize:11,fontColor:selected.includes(i)?'#8e651d':'#334155',backgroundOpacity:.75,backgroundColor:'white',borderThickness:0,inFront:true}));
    renderGuideShapes.current(points);instance.render();
  };
  const pickAtom=(x:number,y:number):number|null=>{
    const instance=viewer.current;if(!instance||!container.current)return null;
    const bounds=container.current.getBoundingClientRect(),nx=(x-window.scrollX-bounds.left)*2/bounds.width-1,ny=1-(y-window.scrollY-bounds.top)*2/bounds.height,displayed=modelRef.current?.selectedAtoms({})??[];
    // Pick actual rendered atom spheres separately from bond cylinders. A fixed
    // pixel threshold otherwise mistakes short bond midpoints for atom centers.
    const spheres=displayed.map((atom:any)=>({...atom,intersectionShape:{...atom.intersectionShape,cylinder:[],line:[],triangle:[]}}));
    for(const hit of instance.targetedObjects(nx,ny,spheres)){const index=hit.clickable?.index;if(Number.isInteger(index)&&atoms[index])return index;}
    for(const hit of instance.targetedObjects(nx,ny,displayed)){const index=hit.clickable?.index;if(!Number.isInteger(index)||!atoms[index])continue;const p=instance.modelToScreen(atoms[index]);if(Math.hypot(p.x-x,p.y-y)<8)return index;}
    return null;
  };
  const pickBond=(x:number,y:number):Bond|null=>{
    const instance=viewer.current;if(!instance)return null;let best=9,chosen:Bond|null=null;
    for(const bond of bonds??[]){if(!atoms[bond.a]||!atoms[bond.b])continue;const segments=cell&&bond.image?.some(Boolean)?periodicBondSegments(atoms,bond,cell):[[atoms[bond.a],atoms[bond.b]] as [ViewerPoint,ViewerPoint]];
      for(const segment of segments){const [a,b]=instance.modelToScreen(segment),dx=b.x-a.x,dy=b.y-a.y,n=dx*dx+dy*dy;if(n<1e-8)continue;const t=((x-a.x)*dx+(y-a.y)*dy)/n;if(t<.08||t>.92)continue;const distance=Math.hypot(x-a.x-t*dx,y-a.y-t*dy);if(distance<best){best=distance;chosen=bond;}}
    }return chosen;
  };
  const editingPointerDown=(event:React.PointerEvent<HTMLDivElement>)=>{
    if(event.button!==0||!editing||!viewer.current)return;
    const hit=pickAtom(event.pageX,event.pageY),bond=hit===null?pickBond(event.pageX,event.pageY):null;
    if(editing.mode==='move'){
      if(hit===null)return;const indices=selected.includes(hit)?validDisplayAtoms(selected,atoms.length):[hit];
      if(!selected.includes(hit))onSelect?.([hit]);
      moveDrag.current={indices,origin:{...atoms[hit]},x:event.pageX,y:event.pageY,delta:{x:0,y:0,z:0},source:atoms.map(a=>({...a}))};setMoving(true);event.currentTarget.setPointerCapture(event.pointerId);return;
    }
    if(bond&&(editing.mode==='bond'||editing.mode==='delete')){editing.onBondAction?.(bond.a,bond.b);setBondAnchor(null);return;}
    if(hit!==null){
      if(editing.mode==='bond'){if(bondAnchor!==null&&bondAnchor!==hit){editing.onBondAction?.(bondAnchor,hit);setBondAnchor(null);}else{setBondAnchor(hit);onSelect?.([...new Set([...selected,hit])]);}}
      else if(editing.mode==='select'){editing.onAtomAction?.(hit);if(!editing.onAtomAction)onSelect?.(selected.includes(hit)?selected.filter(i=>i!==hit):[...selected,hit]);}
      else editing.onAtomAction?.(hit);
      return;
    }
    if(editing.mode==='add'){
      const origin=center(selected.length?validDisplayAtoms(selected,atoms.length).map(i=>atoms[i]):atoms),p=viewer.current.modelToScreen(origin),delta=screenPlaneDelta(point=>viewer.current.modelToScreen(point),origin,event.pageX-p.x,event.pageY-p.y);
      editing.onAddAtom?.({x:origin.x+delta.x,y:origin.y+delta.y,z:origin.z+delta.z});
    }
  };
  const editingPointerMove=(event:React.PointerEvent<HTMLDivElement>)=>{
    const start=moveDrag.current;if(!start||!viewer.current)return;
    const dx=event.pageX-start.x,dy=event.pageY-start.y;
    let delta:ViewerPoint;
    if(moveAxis==='screen')delta=screenPlaneDelta(point=>viewer.current.modelToScreen(point),start.origin,dx,dy);
    else{const p=viewer.current.modelToScreen(start.origin),q=viewer.current.modelToScreen({...start.origin,[moveAxis]:start.origin[moveAxis]+1}),sx=q.x-p.x,sy=q.y-p.y,n=sx*sx+sy*sy,t=n>1e-8?(dx*sx+dy*sy)/n:0;delta={x:0,y:0,z:0};delta[moveAxis]=t;}
    start.delta=delta;previewMove(start.source,start.indices,delta);editing?.onMoveAtoms?.(start.indices,delta,false);
  };
  const finishMove=(commit:boolean)=>{
    const start=moveDrag.current;if(!start)return;moveDrag.current=null;setMoving(false);
    if(commit&&Math.hypot(start.delta.x,start.delta.y,start.delta.z)>1e-8)editing?.onMoveAtoms?.(start.indices,start.delta,true);
    else previewMove(start.source,start.indices,{x:0,y:0,z:0});
  };
  const editingOverlay=!!editing&&editing.mode!=='navigate'&&(editing.mode!=='select'||interaction==='click');

  return <div className={`molecule-stage viewer-highlights-stage${editing?' viewer-builder-stage':''}${builderLegend?' viewer-has-legend':''}`} data-editing-mode={editing?.mode} data-moving={moving} style={editing?{'--viewer-appearance-height':`${appearanceHeight}px`} as CSSProperties:undefined}>
    <div className="viewer-viewport">
    {editing&&<div ref={appearance} className="viewer-builder-appearance" data-testid="viewer-builder-appearance" role="group" aria-label="三维显示样式">
      <div className="segmented"><button className={mode==='ball'?'active':''} onClick={()=>setMode('ball')}>球棍</button><button className={mode==='stick'?'active':''} onClick={()=>setMode('stick')}>棒状</button></div>
      <label className="viewer-color-style">着色<select aria-label="结构着色层" value={activeMode} onChange={event=>setBaseMode(event.target.value as ViewerColorMode)}>{BUILDER_COLOR_MODES.map(value=><option key={value} value={value}>{BUILDER_COLOR_LABELS[value]}</option>)}</select></label>
      <label><input aria-label="显示原子序号" type="checkbox" checked={labels} onChange={event=>setLabels(event.target.checked)}/>序号</label>
      <label><input aria-label="显示元素名称" type="checkbox" checked={elements} onChange={event=>setElements(event.target.checked)}/>元素</label>
      <button className="viewer-orient-diagram" disabled={!ready||!diagramOrientation} onClick={()=>{if(!viewer.current||!diagramOrientation)return;const view=viewer.current.getView();view.splice(4,4,...diagramOrientation);viewer.current.setView(view);viewer.current.render();}}>按二维图定向</button>
      {activeMode!=='elements'&&<label><input aria-label="显示区域标签" type="checkbox" checked={showRegions} onChange={event=>setShowRegions(event.target.checked)}/>图例</label>}
      <button className="viewer-reset-view" aria-label="重置结构视角" onClick={()=>{viewer.current?.zoomTo();viewer.current?.render();}}><RotateCcw size={14}/></button>
    </div>}
    <div ref={container} className="molecule-canvas" data-testid="molecule-canvas" data-cell-edges={cell?12:0} data-periodic-bonds={cell?(bonds??[]).filter(b=>b.image?.some(Boolean)).length:0} data-region-mode={activeRegions.length?'membership':'elements'} data-color-mode={showRegionColors?activeMode:'elements'} data-scan-count={showScan?(highlights.scan?.length??0):0} data-frozen-count={frozenAtoms.length} data-freeze-coordinate-count={showFreeze?(highlights.frozenCoordinates?.length??0):0}/>
    {editingOverlay&&!fallback&&ready&&<div className="viewer-editing-overlay" data-testid="viewer-editing-overlay" data-mode={editing?.mode} onPointerDown={editingPointerDown} onPointerMove={editingPointerMove} onPointerUp={()=>finishMove(true)} onPointerCancel={()=>finishMove(false)} onLostPointerCapture={()=>finishMove(false)} onWheel={event=>{viewer.current?.zoom(event.deltaY>0?.92:1.08);viewer.current?.render();}}/>}
    {interaction==='box'&&onSelect&&!fallback&&(!editing||editing.mode==='select')&&<div className="selection-overlay" data-testid="selection-overlay" onPointerDown={event=>{const bounds=event.currentTarget.getBoundingClientRect();const x=event.clientX-bounds.left,y=event.clientY-bounds.top;drag.current={x,y,pageX:event.pageX,pageY:event.pageY,add:true};setBox({x,y,endX:x,endY:y});event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(!drag.current)return;const bounds=event.currentTarget.getBoundingClientRect();setBox({x:drag.current.x,y:drag.current.y,endX:event.clientX-bounds.left,endY:event.clientY-bounds.top});}} onPointerUp={event=>{if(!drag.current||!viewer.current)return;const start=drag.current;const positions=viewer.current.modelToScreen(atoms);const xmin=Math.min(start.pageX,event.pageX),xmax=Math.max(start.pageX,event.pageX),ymin=Math.min(start.pageY,event.pageY),ymax=Math.max(start.pageY,event.pageY);const indices:number[]=[];positions.forEach((point:any,i:number)=>{if(point.x>=xmin&&point.x<=xmax&&point.y>=ymin&&point.y<=ymax)indices.push(i);});onSelect([...new Set([...selected,...indices])]);drag.current=null;setBox(null);}} onPointerCancel={()=>{drag.current=null;setBox(null);}}>{box&&<div className="selection-rectangle" style={{left:Math.min(box.x,box.endX),top:Math.min(box.y,box.endY),width:Math.abs(box.x-box.endX),height:Math.abs(box.y-box.endY)}}/>}</div>}
    {fallback && <FallbackMolecule atoms={atoms} bonds={bonds} selected={selected} onSelect={onSelect} labels={labels} elements={elements} interaction={interaction} coordinateGuide={coordinateGuide} regions={activeRegions} overlays={overlays} frozenAtoms={frozenAtoms}/>}
    {guide&&<output className="coordinate-guide-value" data-testid="coordinate-guide" data-guide-paths={guide.paths.length} data-guide-renderer={fallback?'projection':'native-3d'} aria-live="polite">{guide.error??guide.label}</output>}
    {!fallback && !ready && <span className="viewer-loading">正在载入结构视图…</span>}
    {builderLegend&&<aside className="viewer-side-legend">{activeRegions.length?<RegionLegend regions={activeRegions} atomCount={atoms.length} selectionHint={false}/>:<div className="viewer-color-empty" data-testid="viewer-color-empty">{BUILDER_COLOR_LABELS[activeMode]} · 0项</div>}</aside>}
    {editing?.mode==='bond'&&bondAnchor!==null&&<output className="viewer-editing-hint">已选原子 {bondAnchor+1}，点击另一个原子成键</output>}
    {editing&&fallback&&<output className="viewer-editing-hint">当前仅支持投影选取；三维添加、成键和拖动需要 WebGL</output>}
    <div className="viewer-caption"><Maximize2 size={12} /><span>{fallback ? '二维投影；可用编号选择' : editing&&editing.mode!=='navigate'&&editing.mode!=='select'?{add:'点击空白添加原子 · 深度为当前选择中心',bond:'点两原子成键 · 点键修改键级',delete:'点击原子或键删除',move:moveAxis==='screen'?'拖动原子或选择片段 · 屏幕平面':`拖动原子或选择片段 · ${moveAxis.toUpperCase()}轴`}[editing.mode]:interaction==='box'?'框选自动增选（并集），含后侧原子':interaction==='click'||editing?.mode==='select'?'点击原子切换选择 · 拖动旋转':'拖动旋转 · 滚轮缩放'}</span><span className="unit-badge">Å</span></div>
    </div>
    <div className="viewer-bottom-controls">
      {!editing&&<div className="viewer-toolbar"><div className="segmented"><button className={mode === 'ball' ? 'active' : ''} onClick={() => setMode('ball')}>球棍</button><button className={mode === 'stick' ? 'active' : ''} onClick={() => setMode('stick')}>棒状</button></div><div className="viewer-actions"><button className="icon-button" aria-label="重置结构视角" onClick={() => { viewer.current?.zoomTo(); viewer.current?.render(); }}><RotateCcw size={15} /></button></div></div>}
      {onSelect&&(!editing||editing.mode==='select')&&<div className="viewer-selection-modes" role="group" aria-label="结构交互模式">{(['rotate','click','box'] as const).map(value=><button key={value} className={interaction===value?'active':''} aria-pressed={interaction===value} onClick={()=>setInteraction(value)}>{{rotate:'旋转',click:'点选',box:'框选'}[value]}</button>)}<button onClick={()=>onSelect(atoms.map((_,index)=>index))}>全选</button><button onClick={()=>onSelect(atoms.flatMap((_,index)=>selected.includes(index)?[]:[index]))}>反选</button><button className="clear-selection" disabled={!selected.length} onClick={()=>onSelect([])}>清空选择</button></div>}
      {editing?.mode==='move'&&<label className="viewer-move-axis">拖动方向<select aria-label="三维拖动方向" value={moveAxis} onChange={event=>setMoveAxis(event.target.value as typeof moveAxis)}><option value="screen">屏幕平面</option><option value="x">X轴</option><option value="y">Y轴</option><option value="z">Z轴</option></select></label>}
      {!editing&&<div className="viewer-label-toggles"><label><input type="checkbox" checked={labels} onChange={event=>setLabels(event.target.checked)}/>显示原子序号</label><label><input type="checkbox" checked={elements} onChange={event=>setElements(event.target.checked)}/>显示元素名称</label></div>}
      {selectionControls&&<div className="viewer-shared-selection">{selectionControls}</div>}
      {((!editing&&modes.length>1)||highlights.scan?.length||highlights.frozenAtoms?.length||highlights.frozenCoordinates?.length)?<div className="viewer-highlight-controls" role="group" aria-label="结构高亮显示">
        {!editing&&modes.length>1&&<label>着色层<select aria-label="结构着色层" value={activeMode} onChange={event=>setBaseMode(event.target.value as BaseColorMode)}>{modes.map(value=><option key={value} value={value}>{value==='frozen'?'冻结设置':{elements:'元素本色（关闭区域高亮）',fragments:'Fragment片段',basis:'基组区域',layers:'QM/MM层'}[value]}</option>)}</select></label>}
        {!editing&&modes.length>1&&<label><input aria-label="显示区域高亮" type="checkbox" checked={showRegionColors} onChange={event=>setShowRegionColors(event.target.checked)}/>区域高亮</label>}
        {!editing&&activeRegions.length>0&&<label><input aria-label="显示区域标签" type="checkbox" checked={showRegions} onChange={event=>setShowRegions(event.target.checked)}/>区域标签</label>}
        {!!highlights.scan?.length&&<label><input aria-label="显示扫描内坐标" type="checkbox" checked={showScan} onChange={event=>setShowScan(event.target.checked)}/>扫描虚线</label>}
        {!!(highlights.frozenAtoms?.length||highlights.frozenCoordinates?.length)&&<label><input aria-label="显示冻结高亮" type="checkbox" checked={showFreeze} onChange={event=>setShowFreeze(event.target.checked)}/>冻结标记</label>}
      </div>:null}
      {!editing&&<RegionLegend regions={activeRegions} atomCount={atoms.length}/>}
      {(overlays.length>0||frozenAtoms.length>0)&&<div className="viewer-overlay-legend" aria-label="扫描与冻结图例" data-testid="highlight-legend">{showScan&&!!highlights.scan?.length&&<span><i style={{borderColor:SCAN_COLOR}}/>扫描内坐标 · {highlights.scan.length}</span>}{showFreeze&&!!highlights.frozenCoordinates?.length&&<span><i style={{borderColor:FREEZE_COLOR}}/>冻结内坐标 · {highlights.frozenCoordinates.length}</span>}{!!frozenAtoms.length&&<span><i className="freeze-legend-marker" style={{borderColor:FREEZE_COLOR}}/>冻结原子 · {frozenAtoms.length}</span>}</div>}
    </div>
  </div>;
}
