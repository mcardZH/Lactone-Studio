import type { Atom, Bond, Structure, Vector3 } from './types';
import { builderPosition, builderRotate, builderUnit, builderVector, inferBuilderBonds } from './builder-geometry';
import { assertBuilderStereoPreserved, updateBuilderStereo } from './builder-stereo';
import { minimumImage } from './periodic';

export type BuilderTemplateCategory = 'functional' | 'ring' | 'chain';
export type BuilderTemplateFamily = 'O' | 'N' | 'S' | 'P' | 'B' | 'Si' | 'halogen' | 'charged' | 'conjugated';
export interface BuilderTemplate {id:string;label:string;atoms:Atom[];bonds:Bond[];anchor:number;connectionAnchor:number;category?:BuilderTemplateCategory;family?:BuilderTemplateFamily}
export interface BuilderTemplateOptions {templateId:string;anchorId?:string;replaceAtomIds?:string[];position?:Vector3;direction?:Vector3}
const atom=(element:string,x:number,y=0,z=0,formalCharge?:number):Atom=>({element,x,y,z,...(formalCharge?{formalCharge}:{})});
const make=(id:string,label:string,atoms:Atom[],bonds:Bond[],anchor=0,family?:BuilderTemplateFamily):BuilderTemplate=>({id,label,atoms,bonds,anchor,connectionAnchor:anchor,...(family?{category:'functional' as const,family}:{})});
const bond=(a:number,b:number,order=1):Bond=>({a,b,order});
function ring(size:number,aromatic=false):BuilderTemplate{
  const chair=!aromatic&&size===6,bondLength=aromatic?1.4:1.53,radius=bondLength/(2*Math.sin(Math.PI/size))*(chair?Math.sqrt(8/9):1);
  const atoms=Array.from({length:size},(_,i)=>{const t=2*Math.PI*i/size;return atom('C',radius*(1-Math.cos(t)),radius*Math.sin(t),chair?(i%2?bondLength/6:-bondLength/6):0);});
  return make(aromatic?'phenyl':`cyclo${size}`,aromatic?'苯基':`${size}元碳环`,atoms,atoms.map((_,i)=>({...bond(i,(i+1)%size,aromatic?1.5:1),...(aromatic?{aromatic:true}:{})})));
}
function alkyl(n:number):BuilderTemplate{
  const atoms=Array.from({length:n},(_,i)=>atom('C',i*1.27,i%2?.85:0));
  return make(`alkyl${n}`,`${n}碳烷基`,atoms,atoms.slice(1).map((_,i)=>bond(i,i+1)));
}
/** Finite construction seed. Every chain connects at a terminal carbon; no FF
 * conformation or implicit hydrogen count is encoded by the template. */
export function createCarbonChainTemplate(n:number):BuilderTemplate{
  if(!Number.isSafeInteger(n)||n<1||n>20)throw new Error('碳链长度必须为 1–20 的整数。');
  return alkyl(n);
}
/** Carbon substituents around a tetrahedral connection site. The vacant
 * fourth direction points toward -X; all C-X distances are seed values. */
function tetraSubstituents(element:string,length:number):Atom[]{
  return [atom(element,length/3,length*Math.sqrt(8/9)),atom(element,length/3,-length*Math.sqrt(2/9),length*Math.sqrt(2/3)),atom(element,length/3,-length*Math.sqrt(2/9),-length*Math.sqrt(2/3))];
}
/** Catalog classification is independent of the construction graph. Legacy
 * IDs and user-selected terminal chain factories retain their meaning. */
export function builderTemplateCategory(template:BuilderTemplate):BuilderTemplateCategory{
  return template.category??(template.id==='phenyl'||template.id.startsWith('cyclo')?'ring':['methyl','ethyl'].includes(template.id)||template.id.startsWith('alkyl')?'chain':'functional');
}
export function builderTemplateFamily(template:BuilderTemplate):BuilderTemplateFamily{
  if(template.family)return template.family;
  if(template.atoms.reduce((sum,a)=>sum+(a.formalCharge??0),0)!==0)return 'charged';
  if(template.id==='CF3')return 'halogen';
  if(['NH2','NO2','CN'].includes(template.id))return 'N';
  return 'O';
}
export const BUILDER_TEMPLATES:BuilderTemplate[]=[
  make('methyl','甲基 CH₃',[atom('C',0)],[]),make('ethyl','乙基 C₂H₅',[atom('C',0),atom('C',1.27,.85)],[bond(0,1)]),
  ring(6,true),make('OH','羟基 OH',[atom('O',0)],[]),make('NH2','氨基 NH₂',[atom('N',0)],[]),
  make('NO2','硝基 NO₂',[atom('N',0,0,0,1),atom('O',.65,1.05),atom('O',.65,-1.05,0,-1)],[bond(0,1,2),bond(0,2)]),
  make('CN','氰基 CN',[atom('C',0),atom('N',1.16)],[bond(0,1,3)]),
  make('COOH','羧基 COOH',[atom('C',0),atom('O',.6,1.04),atom('O',.67,-1.16)],[bond(0,1,2),bond(0,2)]),
  make('COO-','羧酸根 COO⁻',[atom('C',0),atom('O',.62,1.07),atom('O',.62,-1.07,0,-1)],[bond(0,1,2),bond(0,2)]),
  make('CHO','醛基 CHO',[atom('C',0),atom('O',.6,1.04)],[bond(0,1,2)]),
  make('OMe','甲氧基 OMe',[atom('O',0),atom('C',1.2,.75)],[bond(0,1)]),
  make('CF3','三氟甲基 CF₃',[atom('C',0),atom('F',.45,1.27),atom('F',.45,-.635,1.1),atom('F',.45,-.635,-1.1)],[bond(0,1),bond(0,2),bond(0,3)]),
  // Ordinary connected Lewis graphs; implicit H is supplied by the existing
  // builder policy. Coordinates are finite initial seeds, never FF minima.
  make('OEt','乙氧基 OEt',[atom('O',0),atom('C',1.18,.8),atom('C',2.48,.0)],[bond(0,1),bond(1,2)],0,'O'),
  make('OAc','乙酰氧基 OAc',[atom('O',0),atom('C',1.18,.8),atom('O',1.21,2.02),atom('C',2.5,.05)],[bond(0,1),bond(1,2,2),bond(1,3)],0,'O'),
  make('COOMe','甲酯基 COOMe',[atom('C',0),atom('O',.61,1.06),atom('O',.67,-1.16),atom('C',2.09,-1.16)],[bond(0,1,2),bond(0,2),bond(2,3)],0,'O'),
  make('COMe','乙酰基 COMe',[atom('C',0),atom('O',.61,1.06),atom('C',.76,-1.32)],[bond(0,1,2),bond(0,2)],0,'O'),
  make('CONH2','酰胺基 CONH₂',[atom('C',0),atom('O',.61,1.06),atom('N',.67,-1.16)],[bond(0,1,2),bond(0,2)],0,'N'),
  make('NHMe','甲氨基 NHMe',[atom('N',0),atom('C',1.2,.85)],[bond(0,1)],0,'N'),
  make('NMe2','二甲氨基 NMe₂',[atom('N',0),...tetraSubstituents('C',1.47).slice(0,2)],[bond(0,1),bond(0,2)],0,'N'),
  make('NHNH2','肼基 NHNH₂',[atom('N',0),atom('N',1.18,.84)],[bond(0,1)],0,'N'),
  make('NCO','异氰酸酯基 NCO',[atom('N',0),atom('C',1.2),atom('O',2.37)],[bond(0,1,2),bond(1,2,2)],0,'N'),
  make('SH','巯基 SH',[atom('S',0)],[],0,'S'),
  make('SMe','甲硫基 SMe',[atom('S',0),atom('C',1.5,1.02)],[bond(0,1)],0,'S'),
  make('SCN','硫氰基 SCN',[atom('S',0),atom('C',1.75),atom('N',2.91)],[bond(0,1),bond(1,2,3)],0,'S'),
  make('PH2','膦基 PH₂',[atom('P',0)],[],0,'P'),
  make('PMe2','二甲基膦基 PMe₂',[atom('P',0),atom('C',.8,1.65),atom('C',.8,-.83,1.43)],[bond(0,1),bond(0,2)],0,'P'),
  make('B_OH2','硼酸基 B(OH)₂',[atom('B',0),atom('O',.68,1.18),atom('O',.68,-1.18)],[bond(0,1),bond(0,2)],0,'B'),
  make('B_OMe2','二甲氧基硼基 B(OMe)₂',[atom('B',0),atom('O',.68,1.18),atom('O',.68,-1.18),atom('C',2.1,1.18),atom('C',2.1,-1.18)],[bond(0,1),bond(0,2),bond(1,3),bond(2,4)],0,'B'),
  make('SiH3','硅烷基 SiH₃',[atom('Si',0)],[],0,'Si'),
  make('SiMe3','三甲基硅基 SiMe₃',[atom('Si',0),...tetraSubstituents('C',1.86)],[bond(0,1),bond(0,2),bond(0,3)],0,'Si'),
  ...['F','Cl','Br','I'].map(element=>make(element,`${{F:'氟',Cl:'氯',Br:'溴',I:'碘'}[element]} ${element}`,[atom(element,0)],[],0,'halogen')),
  make('NH3+','铵基 NH₃⁺',[atom('N',0,0,0,1)],[],0,'charged'),
  make('NMe3+','三甲基铵基 NMe₃⁺',[atom('N',0,0,0,1),...tetraSubstituents('C',1.5)],[bond(0,1),bond(0,2),bond(0,3)],0,'charged'),
  make('O-','氧负离子 O⁻',[atom('O',0,0,0,-1)],[],0,'charged'),
  make('vinyl','乙烯基 CH=CH₂',[atom('C',0),atom('C',1.34)],[bond(0,1,2)],0,'conjugated'),
  make('ethynyl','乙炔基 C≡CH',[atom('C',0),atom('C',1.2)],[bond(0,1,3)],0,'conjugated'),
  make('allyl','烯丙基 CH₂CH=CH₂',[atom('C',0),atom('C',1.28,.83),atom('C',2.49,.25)],[bond(0,1),bond(1,2,2)],0,'conjugated'),
  ...[3,4,5,6,7,8].map(n=>ring(n)),...[3,4,5,6,8,10].map(alkyl),
];
const aliases:Record<string,string>={oh:'OH',nh2:'NH2',no2:'NO2',cn:'CN',cooh:'COOH',coo:'COO-',cho:'CHO',ome:'OMe',cf3:'CF3',benzene:'phenyl',cyclopropyl:'cyclo3',cyclobutyl:'cyclo4',cyclopentyl:'cyclo5',cyclohexyl:'cyclo6',propyl:'alkyl3',butyl:'alkyl4'};
export function getBuilderTemplate(id:string):BuilderTemplate|undefined{
  const resolved=aliases[id]??id, existing=BUILDER_TEMPLATES.find(t=>t.id===resolved);
  if(existing)return existing;
  const chain=/^alkyl([1-9]\d*)$/.exec(resolved);
  return chain ? createCarbonChainTemplate(Number(chain[1])) : undefined;
}
export function attachBuilderTemplate(structure:Structure,options:BuilderTemplateOptions):{structure:Structure;touchedIds:string[];createdFrom:Record<string,string>;removedIds:string[]}{
  const template=getBuilderTemplate(options.templateId);
  if(!template)throw new Error('未知片段模板。');
  const s=inferBuilderBonds(structure),replace=new Set(options.replaceAtomIds??[]),removedIds=[...replace];
  for(const id of replace)if(!s.atoms.some(a=>a.id===id))throw new Error('待替换原子不存在。');
  const boundary=(s.bonds??[]).filter(b=>replace.has(s.atoms[b.a].id!)!==replace.has(s.atoms[b.b].id!));
  if(replace.size&&boundary.length>1)throw new Error('替换片段有多个连接边界；请保留骨架并选择单一连接片段。');
  let anchorId=options.anchorId;
  if(boundary.length){const b=boundary[0];const outside=replace.has(s.atoms[b.a].id!)?b.b:b.a;
    if(anchorId&&anchorId!==s.atoms[outside].id)throw new Error('替换连接点与已有骨架不一致。');anchorId=s.atoms[outside].id;
  }
  if(anchorId&&replace.has(anchorId))throw new Error('固定连接点不能同时被替换。');
  const anchor=anchorId?s.atoms.find(a=>a.id===anchorId):undefined;if(anchorId&&!anchor)throw new Error('模板连接原子不存在。');
  let direction=options.direction;
  const boundaryInside=boundary.length?(replace.has(s.atoms[boundary[0].a].id!)?boundary[0].a:boundary[0].b):undefined;
  const boundaryImage:Vector3|undefined=boundary[0]?.image?(boundary[0].a===s.atoms.indexOf(anchor!)?boundary[0].image:boundary[0].image.map(v=>-v) as Vector3):undefined;
  if(!direction&&boundaryInside!==undefined){direction=builderVector.sub(builderPosition(s.atoms[boundaryInside]),builderPosition(anchor!));
    if(s.cell){if(boundaryImage)boundaryImage.forEach((v,k)=>{direction=builderVector.add(direction!,builderVector.scale(s.cell!.vectors[k],v));});else direction=minimumImage(s,s.atoms.indexOf(anchor!),boundaryInside).delta;}}
  if(!direction&&anchor){const ai=s.atoms.indexOf(anchor);const n=(s.bonds??[]).filter(b=>b.a===ai||b.b===ai).map(b=>s.atoms[b.a===ai?b.b:b.a]);
    const sum=n.reduce<Vector3>((v,a)=>builderVector.add(v,builderUnit(s.cell?minimumImage(s,ai,s.atoms.indexOf(a)).delta:builderVector.sub(builderPosition(a),builderPosition(anchor)))),[0,0,0]);direction=Math.hypot(...sum)>1e-8?builderVector.scale(sum,-1):[1,0,0];}
  direction=builderUnit(direction??[1,0,0]);
  const pair=[anchor?.element??'C',template.atoms[template.anchor].element].sort().join('-');
  const lengths:Record<string,number>={'C-C':1.53,'C-N':1.47,'C-O':1.43,'C-F':1.35,'C-Cl':1.77,'C-Br':1.94,'C-I':2.14,'H-O':.97,'H-N':1.01,'C-H':1.09,'N-N':1.45,'N-O':1.4,'O-O':1.48};
  const bondLength=lengths[pair]??1.53;
  const position=options.position??(anchor?builderVector.add(builderPosition(anchor),builderVector.scale(direction,bondLength)):[0,0,0]);
  if(!position.every(Number.isFinite))throw new Error('模板放置位置无效。');
  const keep=s.atoms.map((a,i)=>({a,i})).filter(({a})=>!replace.has(a.id!)),mapping=new Map(keep.map(({i},j)=>[i,j]));
  const atoms=keep.map(({a})=>a),bonds=(s.bonds??[]).filter(b=>mapping.has(b.a)&&mapping.has(b.b)).map(b=>({...b,a:mapping.get(b.a)!,b:mapping.get(b.b)!}));
  const createdFrom:Record<string,string>={};const touchedIds:string[]=[];
  const base=atoms.length,origin=builderPosition(template.atoms[template.anchor]),from:Vector3=[1,0,0],axis=builderVector.cross(from,direction),cos=builderVector.dot(from,direction);
  const align=(p:Vector3)=>Math.hypot(...axis)>1e-9?builderRotate(p,[0,0,0],axis,Math.acos(Math.max(-1,Math.min(1,cos)))):cos<0?[-p[0],p[1],-p[2]] as Vector3:p;
  for(const a of template.atoms){const id=`builder-t-${crypto.randomUUID()}`;let p=builderVector.add(align(builderVector.sub(builderPosition(a),origin)),position);
    if(s.cell&&boundaryImage)boundaryImage.forEach((v,k)=>{p=builderVector.sub(p,builderVector.scale(s.cell!.vectors[k],v));});
    atoms.push({...a,id,x:p[0],y:p[1],z:p[2],hydrogenMode:'auto'});touchedIds.push(id);const parent=boundaryInside!==undefined?s.atoms[boundaryInside].id:anchorId??removedIds[0];if(parent)createdFrom[id]=parent;}
  template.bonds.forEach(b=>bonds.push({...b,a:base+b.a,b:base+b.b}));
  if(anchorId){const i=atoms.findIndex(a=>a.id===anchorId);bonds.push({a:i,b:base+template.anchor,order:boundary[0]?.order??1,...(boundary[0]?.image?{image:boundary[0].a===s.atoms.findIndex(a=>a.id===anchorId)?boundary[0].image:boundary[0].image.map(v=>-v) as Vector3}:{})});touchedIds.push(anchorId);}
  const layout2D=s.layout2D?Object.fromEntries(Object.entries(s.layout2D).filter(([id])=>!replace.has(id))):undefined;
  const result={...s,atoms,bonds,layout2D,molfile:undefined,dimension:3 as const};assertBuilderStereoPreserved(s,result);
  return {structure:updateBuilderStereo(result).structure,touchedIds,createdFrom,removedIds};
}
