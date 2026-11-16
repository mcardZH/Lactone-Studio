import { ELEMENTS } from '../../core/elements';
export interface GroupAtom { label:string; x:number; y:number; charge?:number; attachedHydrogens?:number; props?:Record<string,unknown> }
export const GROUP_CATEGORIES = ['烷基','含氧','含氮','含硫','芳基/保护基'] as const;
export type GroupCategory = typeof GROUP_CATEGORIES[number];
export interface GroupTemplate {
  name:string; aliases:readonly string[]; version:1; attachment:number;
  category:GroupCategory;
  atoms:GroupAtom[]; bonds:{a:number;b:number;order:number}[];
  /** External attachment replaces one ordinary H; maximum external bond sum. */
  externalBondOrderMax:number;
}
const hex=Array.from({length:6},(_,i)=>({label:'C',x:1-Math.cos(i*Math.PI/3),y:Math.sin(i*Math.PI/3)}));
const hexEdges=Array.from({length:6},(_,i)=>({a:i,b:(i+1)%6,order:i%2 ? 1 : 2}));
type AtomSpec = [label:string,x:number,y:number,charge?:number];
type EdgeSpec = [a:number,b:number,order?:number];
const h=Math.sqrt(3)/2;
const arylAtoms=(x=0,y=0):AtomSpec[]=>hex.map(a=>['C',a.x+x,a.y+y]);
const arylBonds=(offset=0):EdgeSpec[]=>hexEdges.map(b=>[b.a+offset,b.b+offset,b.order]);
function group(name:string,category:GroupCategory,aliases:string[],atomSpecs:AtomSpec[],edgeSpecs:EdgeSpec[]=[]):GroupTemplate {
  const bonds=edgeSpecs.map(([a,b,order=1])=>({a,b,order}));
  const atoms=atomSpecs.map(([label,x,y,charge],index)=>{
    const valence=label==='C'?4:label==='N'?(charge===1?4:3):label==='O'?(charge===-1?1:2):2;
    const occupied=bonds.filter(b=>b.a===index||b.b===index).reduce((n,b)=>n+b.order,index===0?1:0);
    return {label,x,y,...(charge?{charge}:{}),attachedHydrogens:Math.max(0,valence-occupied)};
  });
  return {name,category,aliases:[name,...aliases],version:1,attachment:0,externalBondOrderMax:1,atoms,bonds};
}
const acyl:AtomSpec[]=[['C',0,0],['O',.5,h]];
const ester:AtomSpec[]=[...acyl,['O',.5,-h]];
const esterBonds:EdgeSpec[]=[[0,1,2],[0,2]];
const tsAtoms:AtomSpec[]=[['S',0,0],['O',0,1],['O',0,-1],...arylAtoms(1),['C',4,0]];
const tsBonds:EdgeSpec[]=[[0,1,2],[0,2,2],[0,3],...arylBonds(3),[6,9]];

// 9-Fluorenylmethoxycarbonyl: the alkoxy methylene bonds to the sp3 carbon
// of the central five-ring. The two six-rings share its opposite flank edges.
function fmoc():GroupTemplate {
  const atoms:AtomSpec[]=[...ester,['C',1.5,-h]];
  const edges:EdgeSpec[]=[...esterBonds,[2,3],[3,4]];
  const r=1/(2*Math.sin(Math.PI/5));
  for(let i=0;i<5;i++) atoms.push(['C',2.5+r*(1-Math.cos(i*2*Math.PI/5)),-h+r*Math.sin(i*2*Math.PI/5)]);
  for(let i=0;i<5;i++) edges.push([4+i,4+(i+1)%5,[1,3].includes(i)?2:1]);
  for(const [a,b] of [[5,6],[7,8]]) {
    const ids=[a,b]; let dx=atoms[b][1]-atoms[a][1],dy=atoms[b][2]-atoms[a][2];
    const cx=2.5+r-(atoms[a][1]+atoms[b][1])/2,cy=-h-(atoms[a][2]+atoms[b][2])/2;
    const sin=(dx*cy-dy*cx>0?-1:1)*h;
    for(let i=2;i<6;i++) {
      [dx,dy]=[dx*.5-dy*sin,dx*sin+dy*.5]; const prev=atoms[ids.at(-1)!];
      ids.push(atoms.length);atoms.push(['C',prev[1]+dx,prev[2]+dy]);
    }
    for(let i=1;i<6;i++) edges.push([ids[i],ids[(i+1)%6],i%2?1:2]);
  }
  return group('Fmoc','芳基/保护基',['fluorenylmethoxycarbonyl','芴甲氧羰基'],atoms,edges);
}
export const GROUP_TEMPLATES: readonly GroupTemplate[] = [
  group('Me','烷基',['CH3','methyl','甲基'],[['C',0,0]]),
  group('Et','烷基',['C2H5','ethyl','乙基'],[['C',0,0],['C',1,0]],[[0,1]]),
  group('n-Pr','烷基',['nPr','propyl','正丙基'],[['C',0,0],['C',h,.5],['C',2*h,0]],[[0,1],[1,2]]),
  group('i-Pr','烷基',['iPr','isopropyl','异丙基'],[['C',0,0],['C',.5,h],['C',.5,-h]],[[0,1],[0,2]]),
  group('t-Bu','烷基',['tBu','tert-butyl','叔丁基'],[['C',0,0],['C',.5,h],['C',.5,-h],['C',1,0]],[[0,1],[0,2],[0,3]]),
  group('OH','含氧',['hydroxy','羟基'],[['O',0,0]]),
  group('OMe','含氧',['OCH3','methoxy','甲氧基'],[['O',0,0],['C',1,0]],[[0,1]]),
  group('OEt','含氧',['OC2H5','ethoxy','乙氧基'],[['O',0,0],['C',h,.5],['C',2*h,0]],[[0,1],[1,2]]),
  group('CHO','含氧',['formyl','甲酰基'],acyl,[[0,1,2]]),
  group('COCH3','含氧',['acetyl','乙酰基'],[...acyl,['C',.5,-h]],esterBonds),
  group('COOH','含氧',['CO2H','carboxyl','羧基'],ester,esterBonds),
  group('COOMe','含氧',['CO2Me','COOCH3','methoxycarbonyl','甲氧羰基'],[...ester,['C',1.5,-h]],[...esterBonds,[2,3]]),
  group('NH2','含氮',['amino','氨基'],[['N',0,0]]),
  group('NHMe','含氮',['NHCH3','methylamino','甲氨基'],[['N',0,0],['C',1,0]],[[0,1]]),
  group('NMe2','含氮',['N(CH3)2','dimethylamino','二甲氨基'],[['N',0,0],['C',.5,h],['C',.5,-h]],[[0,1],[0,2]]),
  group('NO2','含氮',['nitro','硝基'],[['N',0,0,1],['O',.5,h],['O',.5,-h,-1]],esterBonds),
  group('CN','含氮',['cyano','氰基'],[['C',0,0],['N',1,0]],[[0,1,3]]),
  group('SH','含硫',['thiol','巯基'],[['S',0,0]]),
  group('SMe','含硫',['SCH3','methylthio','甲硫基'],[['S',0,0],['C',1,0]],[[0,1]]),
  group('Ph','芳基/保护基',['phenyl','苯基'],arylAtoms(),arylBonds()),
  group('Bn','芳基/保护基',['benzyl','苄基'],[['C',0,0],...arylAtoms(1)],[[0,1],...arylBonds(1)]),
  group('Boc','芳基/保护基',['tert-butoxycarbonyl','叔丁氧羰基'],[...ester,['C',1.5,-h],['C',1.8,.09],['C',1.8,-1.82],['C',2.5,-h]],[...esterBonds,[2,3],[3,4],[3,5],[3,6]]),
  group('Cbz','芳基/保护基',['Z','benzyloxycarbonyl','苄氧羰基'],[...ester,['C',1.5,-h],...arylAtoms(2.5,-h)],[...esterBonds,[2,3],[3,4],...arylBonds(4)]),
  fmoc(),
  group('Ts','芳基/保护基',['tosyl','对甲苯磺酰基'],tsAtoms,tsBonds),
  group('OTs','芳基/保护基',['tosyloxy','对甲苯磺酰氧基'],[['O',0,0],...tsAtoms.map(([l,x,y,q]):AtomSpec=>[l,x+1,y,q])],[[0,1],...tsBonds.map(([a,b,o]):EdgeSpec=>[a+1,b+1,o])]),
];
export type LabelResolution = {ok:true;kind:'element';element:string}|{ok:true;kind:'group';template:GroupTemplate}|{ok:false;reason:string};
export function parseLabel(text:string):LabelResolution {
  const value=text.trim();
  const group=GROUP_TEMPLATES.find(t=>t.aliases.some(alias=>alias.toLowerCase()===value.toLowerCase()));
  if(group)return {ok:true,kind:'group',template:structuredClone(group)};
  const alkyl=/^C([1-9]\d*)H([1-9]\d*)$/.exec(value);
  if(alkyl){
    const n=Number(alkyl[1]),h=Number(alkyl[2]);
    if(!Number.isSafeInteger(n)||!Number.isSafeInteger(h)||h!==2*n+1)return {ok:false,reason:'仅CnH(2n+1)可明确解释为端部连接的直链烷基。'};
    // Same existing drawing/read capacity; never allocate an unbounded string input.
    if(n>10000)return {ok:false,reason:'直链烷基超过当前二维图10000原子读取容量。'};
    return {ok:true,kind:'group',template:{name:value,aliases:[value],version:1,attachment:0,externalBondOrderMax:1,category:'烷基',
      atoms:Array.from({length:n},(_,i)=>({label:'C',x:i*Math.sqrt(3)/2,y:i%2*.5})),bonds:Array.from({length:n-1},(_,i)=>({a:i,b:i+1,order:1}))}};
  }
  const element=value[0]?.toUpperCase()+value.slice(1).toLowerCase();
  if(ELEMENTS.includes(element))return {ok:true,kind:'element',element};
  return {ok:false,reason:`未知元素或基团“${value}”；请保留文字并选择明确模板。`};
}
export type RingTemplateName='benzene'|'cyclopentadiene'|'cyclopropane'|'cyclobutane'|'cyclopentane'|'cyclohexane'|'cycloheptane'|'cyclooctane';
export function ringDefinition(name:RingTemplateName):{size:number;orders:number[];conjugated:number[]} {
  const size={benzene:6,cyclopentadiene:5,cyclopropane:3,cyclobutane:4,cyclopentane:5,cyclohexane:6,cycloheptane:7,cyclooctane:8}[name];
  if(!size)throw new Error('未知环模板。');
  const orders=Array<number>(size).fill(1);
  if(name==='benzene')for(let i=0;i<size;i+=2)orders[i]=2;
  if(name==='cyclopentadiene'){orders[0]=2;orders[2]=2;}
  return {size,orders,conjugated:name==='benzene'?Array.from({length:size},(_,i)=>i):[]};
}
