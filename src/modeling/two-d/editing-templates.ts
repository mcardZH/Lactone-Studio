import { ELEMENTS } from '../../core/elements';
export interface GroupAtom { label:string; x:number; y:number; charge?:number; props?:Record<string,unknown> }
export interface GroupTemplate {
  name:string; aliases:readonly string[]; version:1; attachment:number;
  atoms:GroupAtom[]; bonds:{a:number;b:number;order:number}[];
  /** External attachment replaces one ordinary H; maximum external bond sum. */
  externalBondOrderMax:number;
}
const hex=Array.from({length:6},(_,i)=>({label:'C',x:1-Math.cos(i*Math.PI/3),y:Math.sin(i*Math.PI/3)}));
const hexEdges=Array.from({length:6},(_,i)=>({a:i,b:(i+1)%6,order:i%2 ? 1 : 2}));
const ph:GroupTemplate={name:'Ph',aliases:['Ph','ph'],version:1,attachment:0,atoms:hex,bonds:hexEdges,externalBondOrderMax:1};
const cooh:GroupTemplate={name:'COOH',aliases:['COOH'],version:1,attachment:0,atoms:[{label:'C',x:0,y:0},{label:'O',x:.5,y:.866025403784},{label:'O',x:.5,y:-.866025403784}],bonds:[{a:0,b:1,order:2},{a:0,b:2,order:1}],externalBondOrderMax:1};
const no2:GroupTemplate={name:'NO2',aliases:['NO2'],version:1,attachment:0,atoms:[{label:'N',x:0,y:0,charge:1},{label:'O',x:.5,y:.866025403784},{label:'O',x:.5,y:-.866025403784,charge:-1}],bonds:[{a:0,b:1,order:2},{a:0,b:2,order:1}],externalBondOrderMax:1};
// O attachment -> sulfonyl S -> para-tolyl carbon; explicit graph, no alias atom.
const ots:GroupTemplate={name:'OTs',aliases:['OTs','OTS'],version:1,attachment:0,
  atoms:[{label:'O',x:0,y:0},{label:'S',x:1,y:0},{label:'O',x:1,y:1},{label:'O',x:1,y:-1},...hex.map(a=>({...a,x:a.x+2})),{label:'C',x:5,y:0}],
  bonds:[{a:0,b:1,order:1},{a:1,b:2,order:2},{a:1,b:3,order:2},{a:1,b:4,order:1},...hexEdges.map(b=>({...b,a:b.a+4,b:b.b+4})),{a:7,b:10,order:1}],externalBondOrderMax:1};
export const GROUP_TEMPLATES: readonly GroupTemplate[] = [ph,ots,cooh,no2];
export type LabelResolution = {ok:true;kind:'element';element:string}|{ok:true;kind:'group';template:GroupTemplate}|{ok:false;reason:string};
export function parseLabel(text:string):LabelResolution {
  const value=text.trim();
  const group=GROUP_TEMPLATES.find(t=>t.aliases.includes(value));
  if(group)return {ok:true,kind:'group',template:structuredClone(group)};
  const alkyl=/^C([1-9]\d*)H([1-9]\d*)$/.exec(value);
  if(alkyl){
    const n=Number(alkyl[1]),h=Number(alkyl[2]);
    if(!Number.isSafeInteger(n)||!Number.isSafeInteger(h)||h!==2*n+1)return {ok:false,reason:'仅CnH(2n+1)可明确解释为端部连接的直链烷基。'};
    // Same existing drawing/read capacity; never allocate an unbounded string input.
    if(n>10000)return {ok:false,reason:'直链烷基超过当前二维图10000原子读取容量。'};
    return {ok:true,kind:'group',template:{name:value,aliases:[value],version:1,attachment:0,externalBondOrderMax:1,
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
