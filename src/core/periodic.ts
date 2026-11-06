import type { Atom, Bond, PeriodicCell, Structure, Vector3 } from './types';
import { DEFAULT_EMPIRICAL_BOND_PARAMETERS, empiricalPairBounds, validateEmpiricalBondParameters, type EmpiricalBondPerceptionParameters } from './bond-perception-parameters';

export const dot3 = (a: Vector3, b: Vector3): number => a.reduce((s, x, i) => s + x * b[i], 0);
export const cross3 = (a: Vector3, b: Vector3): Vector3 => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const norm3 = (a: Vector3): number => Math.sqrt(dot3(a,a));
export function cellInverse(cell: PeriodicCell): [Vector3,Vector3,Vector3] {
  const [a,b,c] = cell.vectors; const volume = dot3(a,cross3(b,c));
  if (!cell.vectors.flat().every(Number.isFinite) || !Number.isFinite(volume) || Math.abs(volume) < 1e-10) throw new Error('晶胞无效或奇异，不能进行周期坐标转换。');
  return [cross3(b,c),cross3(c,a),cross3(a,b)].map(v=>v.map(x=>x/volume) as Vector3) as [Vector3,Vector3,Vector3];
}
export function fractionalToCartesian(cell: PeriodicCell, f: Vector3, includeOrigin = true): Vector3 {
  cellInverse(cell);
  return [0,1,2].map(k=>(includeOrigin ? cell.origin?.[k] ?? 0 : 0) + f.reduce((s,x,i)=>s+x*cell.vectors[i][k],0)) as Vector3;
}
export function cartesianToFractional(cell: PeriodicCell, p: Vector3, includeOrigin = true): Vector3 {
  const q = p.map((x,i)=>x-(includeOrigin ? cell.origin?.[i] ?? 0 : 0)) as Vector3;
  return cellInverse(cell).map(row=>dot3(row,q)) as Vector3;
}
export function cellFromParameters(a:number,b:number,c:number,alpha:number,beta:number,gamma:number,source?:string): PeriodicCell {
  if (![a,b,c,alpha,beta,gamma].every(Number.isFinite) || Math.min(a,b,c)<=0 || [alpha,beta,gamma].some(v=>v<=0||v>=180)) throw new Error('晶胞长度或夹角无效。');
  const r=Math.PI/180, ca=Math.cos(alpha*r), cb=Math.cos(beta*r), cg=Math.cos(gamma*r), sg=Math.sin(gamma*r);
  const cy=c*(ca-cb*cg)/sg, cz2=c*c-(c*cb)**2-cy*cy;
  if(cz2<=1e-16)throw new Error('晶胞角度组合产生奇异晶胞。');
  const cell:PeriodicCell={vectors:[[a,0,0],[b*cg,b*sg,0],[c*cb,cy,Math.sqrt(cz2)]],pbc:[true,true,true],source};cellInverse(cell);return cell;
}
export function cellParameters(cell:PeriodicCell):[number,number,number,number,number,number] {
  cellInverse(cell);const [a,b,c]=cell.vectors;const angle=(u:Vector3,v:Vector3)=>Math.acos(Math.max(-1,Math.min(1,dot3(u,v)/norm3(u)/norm3(v))))*180/Math.PI;
  return [norm3(a),norm3(b),norm3(c),angle(b,c),angle(a,c),angle(a,b)];
}
export function isPeriodic(structure:Structure):boolean {return !!structure.cell?.pbc.some(Boolean);}
export function requireConfirmedPeriodicity(structure: Structure): PeriodicCell {
  if (structure.periodicSource?.completeness === 'partial') throw new Error('来源只有部分平移矢量；完整晶胞和周期方向未确认，不能运行周期整理或优化。');
  const cell = structure.cell;
  if (!cell || !Array.isArray(cell.pbc) || cell.pbc.length !== 3 || !cell.pbc.every(value => typeof value === 'boolean')) throw new Error('需要完整晶胞及三个明确周期轴。');
  cellInverse(cell);
  if(cell.pbcProvenance&&(!['source-explicit','format-defined','user-confirmed','unconfirmed'].includes(cell.pbcProvenance.kind)||typeof cell.pbcProvenance.evidence!=='string'||!cell.pbcProvenance.evidence.trim()))throw new Error('周期方向依据无效，不能将未知来源视为已确认。');
  if (cell.pbcProvenance?.kind === 'unconfirmed') throw new Error('周期方向尚未确认；当前连接仅为候选周期轴下的预览。');
  return cell;
}
/** Absolute lattice images attached to ordered endpoints; the first is the
 * base image. Distinct images of one base atom remain distinct endpoints. */
export function validatePeriodicEndpointImages(structure: Structure, atomIds: readonly string[], images?: readonly Vector3[]): void {
  const known = new Set(structure.atoms.map(atom=>atom.id));
  if (atomIds.some(id=>!known.has(id))) throw new Error('周期坐标端点引用了缺失原子。');
  if (images === undefined) { if(new Set(atomIds).size!==atomIds.length)throw new Error('同一基胞原子的不同端点必须有明确镜像身份。');return; }
  if (images.length!==atomIds.length||images.some(image=>!Array.isArray(image)||image.length!==3||image.some((value,axis)=>!Number.isSafeInteger(value)||value!==0&&(!structure.cell||!structure.cell.pbc[axis])))||images[0]?.some(Boolean))throw new Error('周期坐标需要逐端点整数镜像，首端必须在基胞。');
  if(new Set(atomIds.map((id,index)=>JSON.stringify([id,images[index]]))).size!==atomIds.length)throw new Error('周期坐标不能重复同一原子镜像端点。');
  if(images.some(image=>image.some(Boolean)))cellInverse(structure.cell!);
}
type Point=Vector3|Atom|number;
function point(s:Structure,p:Point):Vector3 {if(typeof p==='number'){if(!s.atoms[p])throw new Error('周期坐标引用无效原子。');p=s.atoms[p];}return Array.isArray(p)?p:[p.x,p.y,p.z];}
export function imagesWithin(cell:PeriodicCell,q:Vector3,radius:number,visit:(image:Vector3,delta:Vector3,distance:number)=>void):void {
  if (!Number.isFinite(radius) || radius < 0 || !q.every(Number.isFinite)) throw new Error('周期搜索半径和坐标必须有限且非负。');
  const f=cartesianToFractional(cell,q,false), inverse=cellInverse(cell);
  const bounds=inverse.map((row,i)=>cell.pbc[i]?[Math.ceil(-f[i]-norm3(row)*radius-1e-9),Math.floor(-f[i]+norm3(row)*radius+1e-9)]:[0,0]);
  if(bounds.some(pair=>pair.some(value=>!Number.isSafeInteger(value))))throw new Error('周期映像范围超出精确整数表示，未进入枚举。');
  if(!bounds.flat().every(Number.isSafeInteger))throw new Error('周期映像边界超出可精确表示的整数范围。');
  for(let i=bounds[0][0];i<=bounds[0][1];i++)for(let j=bounds[1][0];j<=bounds[1][1];j++)for(let k=bounds[2][0];k<=bounds[2][1];k++){
    const image:Vector3=[i||0,j||0,k||0],shift=fractionalToCartesian(cell,image,false),delta=q.map((x,n)=>x+shift[n]) as Vector3,distance=norm3(delta);
    if(distance<=radius+1e-9)visit(image,delta,distance);
  }
}
/** Exact nearest lattice image, including highly skew cells; rounding fractional axes alone is insufficient. */
export function minimumImage(s:Structure,a:Point,b:Point):{delta:Vector3;image:Vector3;distance:number} {
  const pa=point(s,a),pb=point(s,b),q=pb.map((x,i)=>x-pa[i]) as Vector3;
  if(!q.every(Number.isFinite))throw new Error('周期坐标必须为有限数值。');
  if(!isPeriodic(s))return {delta:q,image:[0,0,0],distance:norm3(q)};
  const cell=s.cell!,f=cartesianToFractional(cell,q,false),image=f.map((x,i)=>cell.pbc[i]?(-Math.round(x)||0):0) as Vector3,shift=fractionalToCartesian(cell,image,false),delta=q.map((x,i)=>x+shift[i]) as Vector3;
  let best={delta,image,distance:norm3(delta)};
  imagesWithin(cell,q,best.distance,(im,d,distance)=>{if(distance<best.distance-1e-12)best={delta:d,image:im,distance};});return best;
}
// Radii in Angstrom for empirical connection thresholds, not construction
// lengths or force-field equilibrium values. B=.84 is distinct from the
// retained B=.85 construction/near-overlap policies; do not merge by name alone.
const RADII:Record<string,number>={H:.31,He:.28,Li:1.28,Be:.96,B:.84,C:.76,N:.71,O:.66,F:.57,Ne:.58,Na:1.66,Mg:1.41,Al:1.21,Si:1.11,P:1.07,S:1.05,Cl:1.02,K:2.03,Ca:1.76,Sc:1.70,Ti:1.60,V:1.53,Cr:1.39,Mn:1.39,Fe:1.32,Co:1.26,Ni:1.24,Cu:1.32,Zn:1.22,Ga:1.22,Ge:1.20,As:1.19,Se:1.20,Br:1.20,Rb:2.20,Sr:1.95,Y:1.90,Zr:1.75,Nb:1.64,Mo:1.54,Ru:1.46,Rh:1.42,Pd:1.39,Ag:1.45,Cd:1.44,In:1.42,Sn:1.39,Sb:1.39,Te:1.38,I:1.39,Cs:2.44,Ba:2.15,La:2.07,Ce:2.04,W:1.62,Pt:1.36,Au:1.36,Hg:1.32,Pb:1.46,Bi:1.48,U:1.96};
const PERIODIC_CONNECTION_SEARCH_SCALE=1.45;
/** Conservative display workload bound derived from the same radius rules. */
export const MAX_PERIODIC_CONNECTION_SEARCH_RADIUS=2*Math.max(...Object.values(RADII))*PERIODIC_CONNECTION_SEARCH_SCALE;
export function canonicalPeriodicBond(a: number, b: number, image: Vector3 = [0, 0, 0]): { a: number; b: number; image: Vector3; key: string } {
  let im = image.map(value => value || 0) as Vector3;
  if (a > b) { [a, b] = [b, a]; im = im.map(value => -value || 0) as Vector3; }
  if (a === b && (im.find(value => value !== 0) ?? 0) < 0) im = im.map(value => -value || 0) as Vector3;
  return { a, b, image: im, key: `${a}:${b}:${im.join(',')}` };
}
export interface PeriodicConnectivity { bonds: Bond[]; issues: NonNullable<Structure['bondPerceptionIssues']>; preview: boolean; warnings: string[] }
const NONMETALS = new Set(['H','He','B','C','N','O','F','Ne','Si','P','S','Cl','Ar','Ge','As','Se','Br','Kr','Sb','Te','I','Xe','At','Rn','Ts','Og']);
/** Empirical connectivity only: geometric proximity never supplies bond order.
 * An unconfirmed axis set is available only as an explicitly labelled preview. */
export function perceivePeriodicConnections(s: Structure, options: { allowUnconfirmedPreview?: boolean; preserveExisting?: boolean; parameters?: EmpiricalBondPerceptionParameters } = {}): PeriodicConnectivity {
  const parameters=validateEmpiricalBondParameters(options.parameters??DEFAULT_EMPIRICAL_BOND_PARAMETERS);
  if (s.periodicSource?.completeness === 'partial') throw new Error('部分平移矢量不足以建立完整周期映像；原子与原始矢量仍保留。');
  if (!isPeriodic(s)) return { bonds: structuredClone(s.bonds ?? []), issues: structuredClone(s.bondPerceptionIssues ?? []), preview: false, warnings: [] };
  const cell=s.cell!,result:Bond[]=[],seen=new Set<string>(),issues:PeriodicConnectivity['issues']=[];
  const ids=s.atoms.map(atom=>atom.id);if(ids.some(id=>!id)||new Set(ids).size!==ids.length||s.atoms.some(atom=>![atom.x,atom.y,atom.z].every(Number.isFinite)))throw new Error('周期连接需要唯一稳定原子身份与有限坐标。');
  cellInverse(cell);
  const preview = cell.pbcProvenance?.kind === 'unconfirmed';
  if (preview && !options.allowUnconfirmedPreview) requireConfirmedPeriodicity(s);
  const add=(bond:Bond)=>{const canonical=canonicalPeriodicBond(bond.a,bond.b,bond.image);if(canonical.a===canonical.b&&!canonical.image.some(Boolean))return;if(!seen.has(canonical.key)){seen.add(canonical.key);result.push({...bond,a:canonical.a,b:canonical.b,image:canonical.image});}};
  if (options.preserveExisting !== false) for(const bond of s.bonds??[])add({...bond,image:bond.image??[0,0,0]});
  type Candidate = { a:number;b:number;image:Vector3;distance:number;radius:number;metal:boolean };
  const candidates:Candidate[]=[], nearest=new Map<number,number>();
  for(let a=0;a<s.atoms.length;a++)for(let b=a;b<s.atoms.length;b++){
    const ra=RADII[s.atoms[a].element],rb=RADII[s.atoms[b].element];if(ra===undefined||rb===undefined)continue;
    const bounds=empiricalPairBounds(parameters,s.atoms[a].element,s.atoms[b].element,ra+rb);if(!bounds)continue;
    const q:[number,number,number]=[s.atoms[b].x-s.atoms[a].x,s.atoms[b].y-s.atoms[a].y,s.atoms[b].z-s.atoms[a].z];
    imagesWithin(cell,q,Math.max(bounds[1],(ra+rb)*PERIODIC_CONNECTION_SEARCH_SCALE),(image,_delta,distance)=>{
      if(a===b&&(!image.some(Boolean)||(image.find(value=>value!==0)??0)<0))return;
      const metal=!NONMETALS.has(s.atoms[a].element)||!NONMETALS.has(s.atoms[b].element);
      candidates.push({a,b,image,distance,radius:ra+rb,metal});
      if(distance>Math.max(.35,.60*(ra+rb)))for(const index of [a,b].filter(index=>!NONMETALS.has(s.atoms[index].element)))nearest.set(index,Math.min(nearest.get(index)??Infinity,distance));
    });
  }
  const issue=(candidate:Candidate,kind:PeriodicConnectivity['issues'][number]['kind'],reason:string)=>{
    const a=s.atoms[candidate.a].id,b=s.atoms[candidate.b].id;if(!a||!b)throw new Error('周期连接需要稳定原子ID。');
    issues.push({atomIds:[a,b],image:candidate.image,kind,reason});
  };
  for(const candidate of candidates){
    const {a,b,image,distance,radius,metal}=candidate;
    if(seen.has(canonicalPeriodicBond(a,b,image).key))continue;
    const bounds=empiricalPairBounds(parameters,s.atoms[a].element,s.atoms[b].element,radius)!;
    if(distance<bounds[0]){issue(candidate,'unresolved','原子或晶胞镜像过近；未写为化学连接。');continue;}
    const nearShell=!metal||distance<=1.25*Math.min(...[a,b].filter(index=>!NONMETALS.has(s.atoms[index].element)).map(index=>nearest.get(index)??distance));
    if(distance<=bounds[1]&&nearShell)add({a,b,image,order:1,orderKnown:false,perception:'periodic-distance',kind:metal?'coordination':'covalent'});
    else issue(candidate,'weak-contact','距离/局部近邻仅支持弱接触候选；不作为确定键或键级。');
  }
  if(parameters.bondOrderMode==='auto-organic')assignReliableOrganicOrders(s,result);
  return {bonds:result,issues,preview,warnings:preview?[`周期方向未确认；连接预览暂用候选 ${cell.pbc.map(value=>value?'T':'F').join(' ')}，运行前须确认。`]:[]};
}

/** Conservative local organic assignments. A repeated image pair or infinite
 * component has no finite valence budget and remains connectivity-only. */
function assignReliableOrganicOrders(s:Structure,bonds:Bond[]):void {
  const capacity:Record<string,number>={H:1,B:3,C:4,N:3,O:2,F:1,Si:4,P:3,S:2,Cl:1,Br:1,I:1};
  const adjacency=new Map<number,{other:number;bond:Bond;image:Vector3}[]>();
  const add=(atom:number,item:{other:number;bond:Bond;image:Vector3})=>adjacency.set(atom,[...(adjacency.get(atom)??[]),item]);
  for(const bond of bonds){if(bond.kind==='coordination'||!capacity[s.atoms[bond.a].element]||!capacity[s.atoms[bond.b].element])continue;
    const image=bond.image??[0,0,0];add(bond.a,{other:bond.b,bond,image});add(bond.b,{other:bond.a,bond,image:image.map(x=>-x) as Vector3});}
  const visited=new Set<number>();
  for(const root of adjacency.keys()){
    if(visited.has(root))continue;
    const offsets=new Map<number,Vector3>([[root,[0,0,0]]]),component=new Set<number>(),queue=[root];let finite=true;
    for(let cursor=0;cursor<queue.length;cursor++){const atom=queue[cursor];if(component.has(atom))continue;component.add(atom);visited.add(atom);
      for(const edge of adjacency.get(atom)??[]){const next=offsets.get(atom)!.map((v,i)=>v+edge.image[i]) as Vector3,prior=offsets.get(edge.other);
        if(prior&&prior.some((v,i)=>v!==next[i]))finite=false;
        if(!prior){offsets.set(edge.other,next);queue.push(edge.other);}}}
    if(!finite)continue;
    const local=bonds.filter(b=>component.has(b.a)&&component.has(b.b)&&b.kind!=='coordination'),used=new Map<number,number>();
    for(const index of component)used.set(index,local.reduce((n,b)=>n+(b.a===index||b.b===index?b.orderKnown===false?1:b.order:0),0));
    if([...component].some(index=>used.get(index)!>capacity[s.atoms[index].element]))continue;
    const length=(bond:Bond)=>{const a=s.atoms[bond.a],b=s.atoms[bond.b],shift=fractionalToCartesian(s.cell!,bond.image??[0,0,0],false);return Math.hypot(b.x+shift[0]-a.x,b.y+shift[1]-a.y,b.z+shift[2]-a.z);};
    // Six-member aromatic rings need a closed, finite, approximately planar
    // C/N cycle and all six distances in the conjugated range. Existing typed
    // edges, metal contacts and fused/high-degree ambiguity are left intact.
    const heavy=[...component].filter(i=>s.atoms[i].element!=='H'),ringEdges=local.filter(b=>s.atoms[b.a].element!=='H'&&s.atoms[b.b].element!=='H');
    const aromatic=heavy.length===6&&ringEdges.length===6&&heavy.every(i=>['C','N'].includes(s.atoms[i].element)&&ringEdges.filter(b=>b.a===i||b.b===i).length===2&&(adjacency.get(i)?.length??0)<=3)
      &&ringEdges.every(b=>b.orderKnown===false&&length(b)>=1.30&&length(b)<=1.48);
    if(aromatic){const positions=heavy.map(i=>{const atom=s.atoms[i],shift=fractionalToCartesian(s.cell!,offsets.get(i)!,false);return [atom.x+shift[0],atom.y+shift[1],atom.z+shift[2]] as Vector3;}),u=positions[1].map((x,k)=>x-positions[0][k]) as Vector3;
      const v=positions.find(p=>norm3(cross3(u,p.map((x,k)=>x-positions[0][k]) as Vector3))>.1),normal=v?cross3(u,v.map((x,k)=>x-positions[0][k]) as Vector3):[0,0,0] as Vector3;
      if(norm3(normal)>.1&&positions.every(p=>Math.abs(dot3(normal,p.map((x,k)=>x-positions[0][k]) as Vector3))/norm3(normal)<.12))for(const bond of ringEdges){bond.order=1.5;bond.aromatic=true;delete bond.orderKnown;bond.perception='empirical-organic';}
    }
    const seeds:Record<string,[number,number]>={'C:C':[1.40,1.25],'C:N':[1.34,1.21],'C:O':[1.29,0],'N:N':[1.30,1.15],'N:O':[1.26,0],'O:O':[1.26,0]};
    for(const bond of local.filter(b=>b.orderKnown===false).sort((a,b)=>length(a)-length(b))){const thresholds=seeds[[s.atoms[bond.a].element,s.atoms[bond.b].element].sort().join(':')];if(!thresholds)continue;
      const distance=length(bond),desired=thresholds[1]>0&&distance<=thresholds[1]?3:distance<=thresholds[0]?2:1;
      if(desired===1||used.get(bond.a)!+desired-1>capacity[s.atoms[bond.a].element]||used.get(bond.b)!+desired-1>capacity[s.atoms[bond.b].element])continue;
      bond.order=desired;delete bond.orderKnown;bond.perception='empirical-organic';used.set(bond.a,used.get(bond.a)!+desired-1);used.set(bond.b,used.get(bond.b)!+desired-1);
    }
  }
}
/** Compatibility drawing adapter; full callers consume preview/warnings too. */
export function periodicBonds(s:Structure):Bond[] {
  // Legacy drawing consumes array-index endpoints and can precede stable-ID
  // binding. These local identities never leave this adapter or mutate source.
  const drawing={...s,atoms:s.atoms.map((atom,index)=>({...atom,id:`periodic-drawing:${index}`})),bondPerceptionIssues:undefined};
  return perceivePeriodicConnections(drawing,{allowUnconfirmedPreview:true}).bonds;
}
