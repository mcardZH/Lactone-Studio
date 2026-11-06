import type { Atom, PeriodicCell, Structure, Vector3 } from './types';
import { elementSymbol } from './elements';
import { cartesianToFractional, cellFromParameters, cellInverse, cross3, dot3, fractionalToCartesian, minimumImage } from './periodic';
import cifSpaceGroups from '../data/cif-space-groups.json';

const BOHR=.529177210903;
function num(raw:string):number {const value=raw?.replace(/\(\d+\)$/,'').replace(/[dD]/,'e');if(!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value??''))throw new Error(`结构数值“${raw}”无效。`);const n=Number(value);if(!Number.isFinite(n))throw new Error('结构坐标必须为有限数值。');return n;}
function vec(row:string[]):Vector3 {if(row.length<3)throw new Error('三维向量截断。');return row.slice(0,3).map(num) as Vector3;}
function base(name:string,format:string,index=0):Structure {return {id:`${name}-${index}`,name,format,atoms:[],charge:null,multiplicity:null,notes:[],dimension:3};}
function add(s:Structure,element:string,p:Vector3,id?:string,sourceIndex?:number):void {s.atoms.push({element:elementSymbol(element),x:p[0],y:p[1],z:p[2],id:id??`${s.id}:atom:${s.atoms.length+1}`,sourceIndex:sourceIndex??s.atoms.length+1});}
function finish(s:Structure):Structure {if(!s.atoms.length)throw new Error('结构中没有原子。');if(s.cell)cellInverse(s.cell);if(new Set(s.atoms.map(a=>a.id)).size!==s.atoms.length)throw new Error('来源含重复原子ID。');return s;}
function pbc(value:string):[boolean,boolean,boolean] {const values=value.trim().split(/\s+/);if(values.length===1&&/^(XYZ|XY|XZ|YZ|X|Y|Z|NONE)$/i.test(values[0]))return ['X','Y','Z'].map(a=>values[0].toUpperCase().includes(a)) as [boolean,boolean,boolean];if(values.length!==3||values.some(x=>! /^(T|F|true|false|0|1)$/i.test(x)))throw new Error('周期方向声明无效。');return values.map(x=>/^(T|true|1)$/i.test(x)) as [boolean,boolean,boolean];}
function attrs(comment:string):Record<string,string> {const out:Record<string,string>={};for(const m of comment.matchAll(/([A-Za-z_][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g))out[m[1].toLowerCase()]=m[2]??m[3]??m[4];return out;}
/** Existing file readers/writers share this check; it does not confirm axes. */
export function validatePeriodicSourceMetadata(s:Structure):void {
  const evidence=(value:unknown)=>typeof value==='string'&&value.trim().length>0;
  if(s.cell?.pbcProvenance!==undefined){const p=s.cell.pbcProvenance;if(!p||!['source-explicit','format-defined','user-confirmed','unconfirmed'].includes(p.kind)||!evidence(p.evidence)||Object.keys(p).some(key=>!['kind','evidence'].includes(key)))throw new Error('周期轴来源声明与真实晶胞不一致。');}
  if(s.periodicSource!==undefined){const p=s.periodicSource;if(!p)throw new Error('部分周期来源元数据无效。');const v=p.translationVectors;
    if(s.cell||p.completeness!=='partial'||!evidence(p.evidence)||Object.keys(p).some(key=>!['translationVectors','completeness','evidence'].includes(key))||!Array.isArray(v)||![1,2].includes(v.length)||v.some(row=>!Array.isArray(row)||row.length!==3||row.some(value=>typeof value!=='number'||!Number.isFinite(value))||dot3(row,row)<1e-20)||v.length===2&&dot3(cross3(v[0],v[1]),cross3(v[0],v[1]))<1e-20)throw new Error('部分周期平移来源无效，未补造完整晶胞。');
  }
  if(s.periodicWorkingSource!==undefined){const raw=s.periodicWorkingSource;
    if(!raw||typeof raw.structureId!=='string'||typeof raw.name!=='string'||typeof raw.format!=='string'||raw.coordinateUnit!=='angstrom'||!raw.cell||!Array.isArray(raw.atoms)||!raw.atoms.length)throw new Error('三维工作表示的原来源记录无效。');
    if(!Array.isArray(raw.cell.pbc)||raw.cell.pbc.length!==3||raw.cell.pbc.some(value=>typeof value!=='boolean')||raw.atoms.some(atom=>typeof atom.element!=='string'||![atom.x,atom.y,atom.z].every(Number.isFinite)))throw new Error('三维工作表示的原始周期轴或坐标无效。');
    cellInverse(raw.cell);
    validatePeriodicSourceMetadata({id:raw.structureId,name:raw.name,format:raw.format,atoms:raw.atoms,charge:null,multiplicity:null,notes:[],cell:raw.cell});
  }
}
/** Explicit SciYue metadata preserves source status, not just candidate axes.
 * Invalid/contradictory metadata is rejected rather than silently confirmed. */
function restorePeriodicity(s:Structure,encoded:string|undefined):void {
  if(encoded===undefined)return;
  let meta:{version?:unknown;coordinateUnit?:unknown;pbcProvenance?:PeriodicCell['pbcProvenance'];periodicSource?:Structure['periodicSource'];periodicWorkingSource?:Structure['periodicWorkingSource']};
  try{meta=JSON.parse(decodeURIComponent(encoded));}catch{throw new Error('周期来源元数据损坏。');}
  if(!meta||meta.version!==1||meta.coordinateUnit!=='angstrom'||meta.pbcProvenance===undefined&&meta.periodicSource===undefined&&meta.periodicWorkingSource===undefined||Object.keys(meta).some(key=>!['version','coordinateUnit','pbcProvenance','periodicSource','periodicWorkingSource'].includes(key)))throw new Error('周期来源元数据版本、单位或字段无效。');
  if(meta.pbcProvenance!==undefined&&!s.cell)throw new Error('周期轴来源声明缺少真实晶胞。');
  validatePeriodicSourceMetadata({...s,...(meta.periodicSource===undefined?{}:{periodicSource:meta.periodicSource}),...(meta.periodicWorkingSource===undefined?{}:{periodicWorkingSource:meta.periodicWorkingSource}),...(s.cell?{cell:{...s.cell,...(meta.pbcProvenance===undefined?{}:{pbcProvenance:meta.pbcProvenance})}}:{})});
  if(meta.periodicWorkingSource!==undefined)s.periodicWorkingSource=structuredClone(meta.periodicWorkingSource);
  if(meta.pbcProvenance!==undefined)s.cell!.pbcProvenance={...meta.pbcProvenance};
  if(meta.periodicSource!==undefined){s.periodicSource={...meta.periodicSource,translationVectors:meta.periodicSource.translationVectors.map(row=>[...row] as Vector3)};s.notes.push('保留来源部分Tv平移信息；缺少完整晶胞，不能作为有限分子或完整周期来源运行。');}
}
function parseXyz(text:string,name:string):Structure[] {
  const lines=text.split('\n'),out:Structure[]=[];let i=0;
  while(i<lines.length){if(!lines[i].trim()){i++;continue;}if(!/^\d+$/.test(lines[i].trim()))throw new Error('XYZ原子数行无效。');const n=Number(lines[i++]);if(!Number.isSafeInteger(n)||n<1)throw new Error('XYZ原子数超出范围。');if(i>=lines.length)throw new Error('XYZ缺少注释。');const meta=attrs(lines[i++]),s=base(name,'extended XYZ',out.length),scale=meta.units?.toLowerCase()==='bohr'?BOHR:1;if(meta.units&&!/^(bohr|angstrom|ang|a)$/i.test(meta.units))throw new Error('未知XYZ坐标单位。');
    if(meta.lattice){const vals=meta.lattice.split(/\s+/).map(num);if(vals.length!==9)throw new Error('Lattice必须恰好为9个晶胞分量。');s.cell={vectors:[vals.slice(0,3),vals.slice(3,6),vals.slice(6,9)].map(v=>v.map(x=>x*scale)) as [Vector3,Vector3,Vector3],pbc:meta.pbc?pbc(meta.pbc):[true,true,true],source:name};if(meta.origin)s.cell.origin=vec(meta.origin.split(/\s+/)).map(x=>x*scale) as Vector3;cellInverse(s.cell);}else if(meta.pbc&&pbc(meta.pbc).some(Boolean))throw new Error('XYZ声明周期方向但没有真实Lattice。');
    restorePeriodicity(s,meta.builder_periodic);if(meta.cell_omitted==='true')s.notes.push('来源已明确省略原晶胞；当前文件仅保留坐标，不代表完整周期模型。');
    let species=0,pos=1,id=-1,source=-1,width=4;const schema=meta.properties?.split(':');if(schema){if(schema.length%3)throw new Error('Properties列定义不完整。');species=pos=-1;width=0;for(let j=0;j<schema.length;j+=3){const ncols=Number(schema[j+2]);if(!Number.isInteger(ncols)||ncols<1)throw new Error('Properties列宽无效。');if(schema[j]==='species'&&schema[j+1]==='S'&&ncols===1)species=width;if(schema[j]==='pos'&&schema[j+1]==='R'&&ncols===3)pos=width;if(schema[j]==='id'&&ncols===1)id=width;if(schema[j]==='source_index'&&ncols===1)source=width;width+=ncols;}if(species<0||pos<0)throw new Error('Properties必须含species:S:1和pos:R:3。');}
    let provenance:{id:string;sourceIndex:number}[]|undefined;if(meta.builder_atoms){try{provenance=JSON.parse(decodeURIComponent(meta.builder_atoms));}catch{throw new Error('XYZ来源原子元数据损坏。');}if(!Array.isArray(provenance)||provenance.length!==n||provenance.some(a=>typeof a?.id!=='string'||!Number.isSafeInteger(a?.sourceIndex)))throw new Error('XYZ来源原子元数据损坏。');}
    for(let j=0;j<n;j++){const row=lines[i++]?.trim().split(/\s+/);if(!row||row.length!==width)throw new Error('XYZ坐标行列数与声明不符。');const sourceIndex=source>=0?num(row[source]):provenance?.[j].sourceIndex??j+1;if(!Number.isSafeInteger(sourceIndex))throw new Error('来源原子序号必须为整数。');add(s,row[species],vec(row.slice(pos)).map(x=>x*scale) as Vector3,id>=0?decodeURIComponent(row[id]):provenance?.[j].id,sourceIndex);}
    for(const key of ['charge','multiplicity'] as const)if(meta[key]!==undefined){s[key]=num(meta[key]);if(!Number.isSafeInteger(s[key])||(key==='multiplicity'&&s[key]!<1))throw new Error('XYZ电子态元数据无效。');}
    out.push(finish(s));
  }return out;
}

interface CifLoop {headers:string[];rows:string[][]}
interface CifToken {value:string;quoted:boolean}
const cifTag=(value:string)=>value.toLowerCase().replace(/\./g,'_');
/** CIF 1.1 whitespace/quoted/semicolon tokenizer, without executing source expressions. */
function cifTokens(text:string):CifToken[] {const out:CifToken[]=[];let i=0;while(i<text.length){if(/\s/.test(text[i])){i++;continue;}if(text[i]==='#'){while(i<text.length&&text[i]!=='\n')i++;continue;}if(text[i]===';'&&(i===0||text[i-1]==='\n')){const end=text.indexOf('\n;',i+1);if(end<0)throw new Error('CIF多行字段未闭合。');out.push({value:text.slice(i+1,end),quoted:true});i=end+2;continue;}if(text[i]==='"'||text[i]==="'"){const quote=text[i++],start=i;while(i<text.length&&!(text[i]===quote&&(i+1===text.length||/\s|#/.test(text[i+1]))))i++;if(i>=text.length)throw new Error('CIF引号未闭合。');out.push({value:text.slice(start,i++),quoted:true});continue;}const start=i;while(i<text.length&&!/\s/.test(text[i]))i++;out.push({value:text.slice(start,i),quoted:false});}return out;}
function cifData(tokens:CifToken[]):{tags:Record<string,string>;loops:CifLoop[]} {const tags:Record<string,string>={},loops:CifLoop[]=[];let i=0;const reserved=(t:CifToken)=>!t.quoted&&/^_|^(?:loop_|stop_|data_|save_|global_)/i.test(t.value);while(i<tokens.length){const token=tokens[i++],t=cifTag(token.value);if(!token.quoted&&t==='loop_'){const headers:string[]=[];while(tokens[i]&&!tokens[i].quoted&&tokens[i].value.startsWith('_'))headers.push(cifTag(tokens[i++].value));if(!headers.length)throw new Error('CIF loop缺少表头。');const values:string[]=[];while(i<tokens.length&&!reserved(tokens[i]))values.push(tokens[i++].value);if(values.length%headers.length)throw new Error('CIF loop列数不完整。');loops.push({headers,rows:Array.from({length:values.length/headers.length},(_,k)=>values.slice(k*headers.length,(k+1)*headers.length))});}else if(!token.quoted&&t.startsWith('_')){if(i>=tokens.length||reserved(tokens[i]))throw new Error(`CIF字段${t}缺少值。`);tags[t]=tokens[i++].value;}}return {tags,loops};}
function symmetry(expr:string,f:Vector3):Vector3 {const parts=expr.toLowerCase().replace(/\s/g,'').split(',');if(parts.length!==3)throw new Error('CIF对称操作必须有三个分量。');return parts.map(part=>{const terms=part.match(/[+-]?[^+-]+/g);if(!terms||terms.join('')!==part)throw new Error('CIF对称表达式无效。');return terms.reduce((sum,term)=>{const m=term.match(/^([+-]?)(?:(\d+(?:\/\d+)?)\*?)?([xyz])$/);if(m){const coeff=m[2]?m[2].split('/').map(Number).reduce((a,b)=>a/b):1;return sum+(m[1]==='-'?-1:1)*coeff*f['xyz'.indexOf(m[3])];}if(!/^[+-]?\d+(?:\.\d*)?(?:\/\d+)?$/.test(term))throw new Error(`不支持的CIF对称表达式${term}。`);const [a,b='1']=term.split('/');if(Number(b)===0)throw new Error('CIF对称操作除数为0。');return sum+Number(a)/Number(b);},0);}) as Vector3;}
/** CIF type symbols may carry an oxidation state, unlike ordinary element input.
 * Keep this grammar local: an atom label or arbitrary suffix is not a type. */
function cifElement(raw:string):string {
  const match=raw.trim().match(/^([A-Z][a-z]?)(?:0|[1-9]\d*[+-]|[+-][1-9]\d*|[+-])?$/);
  if(!match)throw new Error(`CIF原子类型“${raw}”不是可靠元素/氧化态符号。`);
  return elementSymbol(match[1]);
}
/** Last printed decimal half-unit, not the experimental standard uncertainty.
 * Integer special-position tokens (including 0.) carry no rounding interval. */
function cifPrintedHalfUnit(token:string):number {
  const value=token.replace(/\(\d+\)$/,'').replace(/[dD]/,'e'),match=value.match(/^[+-]?(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/i);
  if(!match)return 0;const decimals=match[1].split('.')[1]?.length??0;
  return decimals||match[2]!==undefined?0.5*10**(Number(match[2]??0)-decimals):0;
}
interface CifImage {fraction:Vector3;matrix:[Vector3,Vector3,Vector3];element:string;sourceRow:number}
function cifImageMatrix(op:string):[Vector3,Vector3,Vector3] {
  const offset=symmetry(op,[0,0,0]),columns=([0,1,2] as const).map(i=>{const unit:Vector3=[0,0,0];unit[i]=1;return symmetry(op,unit).map((x,k)=>x-offset[k]);});
  return [0,1,2].map(i=>columns.map(column=>column[i]) as Vector3) as [Vector3,Vector3,Vector3];
}
function cifImageDelta(a:Vector3,b:Vector3,s:Structure):Vector3 {
  return a.map((x,i)=>{const delta=x-b[i];return s.cell?.pbc[i]?delta-Math.round(delta):delta;}) as Vector3;
}
/** Conservative candidate lookup for the existing machine-slack equality.
 * Wider global slack may admit extra pairs; the scientific predicate below
 * remains the oracle. Rebuild if a later non-normalized coordinate grows. */
class CifPositionIndex {
  private scale=1;
  private width:number;
  private entries:{image:CifImage;index:number}[]=[];
  private bins=new Map<string,{image:CifImage;index:number}[]>();
  constructor(private structure:Structure,private extraSlack=0){this.width=64*Number.EPSILON+extraSlack;}
  private axis(value:number,axis:number):number {
    if(!this.structure.cell?.pbc[axis])return Math.floor(value/this.width);
    const count=Math.max(1,Math.floor(1/this.width));return Math.min(count-1,Math.floor((value-Math.floor(value))*count));
  }
  private key(image:CifImage):string{return image.fraction.map((value,axis)=>this.axis(value,axis)).join(',');}
  private prepare(image:CifImage):void {
    const scale=Math.max(1,...image.fraction.map(Math.abs));if(scale<=this.scale)return;
    this.scale=scale;this.width=64*Number.EPSILON*scale+this.extraSlack;this.bins.clear();
    for(const entry of this.entries){const key=this.key(entry.image),bucket=this.bins.get(key)??[];bucket.push(entry);this.bins.set(key,bucket);}
  }
  candidates(image:CifImage):{image:CifImage;index:number}[] {
    this.prepare(image);
    const cell=image.fraction.map((value,axis)=>this.axis(value,axis)),keys=new Set<string>(),result:{image:CifImage;index:number}[]=[];
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
      const key=[x,y,z].map((delta,axis)=>{const value=cell[axis]+delta;if(!this.structure.cell?.pbc[axis])return value;const count=Math.max(1,Math.floor(1/this.width));return (value%count+count)%count;}).join(',');
      if(keys.has(key))continue;keys.add(key);const bucket=this.bins.get(key);if(bucket)for(const entry of bucket)result.push(entry);
    }
    return result;
  }
  add(image:CifImage,index:number):void {
    this.prepare(image);const entry={image,index},key=this.key(image),bucket=this.bins.get(key)??[];bucket.push(entry);this.bins.set(key,bucket);this.entries.push(entry);
  }
}
/** A single source-coordinate correction must satisfy ALL image components.
 * Test vertices of the <=3 dimensional rounding box / equality intersection;
 * independent component intervals alone can intersect inconsistently. */
function cifRoundingWitness(matrix:number[][],delta:number[],halfUnit:Vector3,slack:number):Vector3|undefined {
  if(delta.every(value=>Math.abs(value)<=slack))return [0,0,0];
  const columns=halfUnit.flatMap((u,j)=>u>0?[matrix.map(row=>row[j]*u)]:[]),n=columns.length;
  for(let code=0;code<3**n;code++){
    let state=code;const free:number[]=[],values=Array<number>(n).fill(0);
    for(let j=0;j<n;j++){const digit=state%3;state=Math.floor(state/3);if(digit===1)free.push(j);else values[j]=digit===0?-1:1;}
    const rhs=delta.map((value,i)=>-value-columns.reduce((sum,column,j)=>sum+column[i]*values[j],0));
    const equations=free.map(j=>[...free.map(k=>columns[j].reduce((sum,x,i)=>sum+x*columns[k][i],0)),columns[j].reduce((sum,x,i)=>sum+x*rhs[i],0)]);
    const scale=Math.max(0,...equations.flatMap(row=>row.slice(0,free.length).map(Math.abs)));let singular=false;
    for(let j=0;j<free.length;j++){
      let pivot=j;for(let k=j+1;k<free.length;k++)if(Math.abs(equations[k][j])>Math.abs(equations[pivot][j]))pivot=k;
      if(Math.abs(equations[pivot][j])<=scale*64*Number.EPSILON){singular=true;break;}
      [equations[j],equations[pivot]]=[equations[pivot],equations[j]];const divisor=equations[j][j];for(let k=j;k<=free.length;k++)equations[j][k]/=divisor;
      for(let k=0;k<free.length;k++)if(k!==j){const factor=equations[k][j];for(let l=j;l<=free.length;l++)equations[k][l]-=factor*equations[j][l];}
    }
    if(singular)continue;
    free.forEach((j,k)=>values[j]=equations[k][free.length]);
    if(values.some(value=>Math.abs(value)>1+1e-10))continue;
    if(delta.every((value,i)=>Math.abs(value+columns.reduce((sum,column,j)=>sum+column[i]*values[j],0))<=slack)){let active=0;return halfUnit.map(u=>u>0?u*values[active++]:0) as Vector3;}
  }
  return undefined;
}
/** Candidate equalities only. A pair-local witness never licenses dropping an
 * image: ALL candidates of the source row must share one witness below. */
function cifImageEquality(a:CifImage,b:CifImage,halfUnit:Vector3,s:Structure):{matrix:number[][];delta:Vector3;slack:number}|undefined {
  if(a.sourceRow!==b.sourceRow)return undefined;
  const delta=cifImageDelta(a.fraction,b.fraction,s),slack=64*Number.EPSILON*Math.max(1,...a.fraction.map(Math.abs),...b.fraction.map(Math.abs));
  const difference=a.matrix.map((row,i)=>row.map((value,j)=>value-b.matrix[i][j]));
  const bounds=difference.map(row=>row.reduce((sum,value,j)=>sum+Math.abs(value)*halfUnit[j],0));
  if(!delta.every((x,i)=>Math.abs(x)<=bounds[i]+slack))return undefined;
  // A broad printing box must not silently pick one of several lattice
  // aliases. Nonperiodic axes never have integer aliases at all.
  if(delta.some((x,i)=>s.cell?.pbc[i]&&bounds[i]>=1-Math.abs(x)-slack))throw new Error('CIF源坐标打印精度无法唯一确定晶格别名，舍入归并存在歧义；请提供更高精度坐标。');
  return delta.every(x=>Math.abs(x)<=slack)||cifRoundingWitness(difference,delta,halfUnit,slack)?{matrix:difference,delta,slack}:undefined;
}
/** Build the entire equivalence graph before choosing any representative.
 * Every connected component AND every separate component of this source row
 * uses the same original coordinate correction. Incompatible candidate
 * equalities are an ambiguity, not permission to choose a greedy partition. */
function cifOrbitRepresentatives(images:CifImage[],halfUnit:Vector3,s:Structure):number[] {
  if(images.length<2)return images.map((_,i)=>i);
  const parent=images.map((_,i)=>i),matrix:number[][]=[],delta:number[]=[],basis:{row:number[];pivot:number}[]=[];
  const independent=(row:number[],value:number):void=>{
    const reduced=row.map((x,j)=>x*halfUnit[j]);let scale=0;for(const x of reduced)scale=Math.max(scale,Math.abs(x));if(scale===0)return;
    for(const equation of basis){const factor=reduced[equation.pivot];for(let j=0;j<3;j++)reduced[j]-=factor*equation.row[j];reduced[equation.pivot]=0;}
    let pivot=-1;for(let j=0;j<3;j++)if(!basis.some(e=>e.pivot===j)&&(pivot<0||Math.abs(reduced[j])>Math.abs(reduced[pivot])))pivot=j;
    if(pivot<0||Math.abs(reduced[pivot])<=64*Number.EPSILON*scale)return;
    const divisor=reduced[pivot];basis.push({row:reduced.map(x=>x/divisor),pivot});matrix.push(row);delta.push(value);
  };
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  let deviation=0;
  for(const image of images)for(let axis=0;axis<3;axis++)deviation=Math.max(deviation,image.matrix[axis].reduce((sum,value,column)=>sum+Math.abs(value-images[0].matrix[axis][column])*halfUnit[column],0));
  function* candidatePairs():Generator<[number,number]>{
    // Triangle inequality bounds every pair's rounding displacement relative
    // to the same first matrix, including its floating subtraction error.
    const index=new CifPositionIndex(s,2*deviation);
    for(let i=0;i<images.length;i++){for(const entry of index.candidates(images[i]))yield[i,entry.index];index.add(images[i],i);}
  }
  for(const [i,j] of candidatePairs()){
    const equality=cifImageEquality(images[i],images[j],halfUnit,s);if(!equality)continue;
    equality.matrix.forEach((row,k)=>independent(row,equality.delta[k]));
    const a=root(i),b=root(j);parent[Math.max(a,b)]=Math.min(a,b);
  }
  let scale=1;for(const image of images)for(const x of image.fraction)scale=Math.max(scale,Math.abs(x));
  const witness=cifRoundingWitness(matrix,delta,halfUnit,64*Number.EPSILON*scale);
  const ambiguous=()=>new Error('CIF同一来源位点的全部舍入归并不能由同一坐标修正解释，存在歧义；请提供更高精度坐标或明确特殊位置。');
  if(!witness)throw ambiguous();
  // Constant-size basis selects a witness, but is NOT the acceptance oracle.
  // Revisit every original candidate equality at its own original machine
  // slack. No dependent/conflicting row disappears in the basis reduction.
  for(const [i,j] of candidatePairs()){
    const equality=cifImageEquality(images[i],images[j],halfUnit,s);if(!equality)continue;
    if(equality.matrix.some((row,k)=>Math.abs(row.reduce((sum,x,l)=>sum+x*witness[l],equality.delta[k]))>equality.slack))throw ambiguous();
  }
  return images.flatMap((_,i)=>root(i)===i?[i]:[]);
}
interface StandardSpaceGroup {number:number;symbol:string;fullSymbol:string;standardSetting:string;nameAliases:string[];hallAliases:string[];operations:string[]}
const standardGroups=cifSpaceGroups.groups as Record<string,StandardSpaceGroup>;
const normalizedGroup=(name:string)=>name.replace(/[\s_]/g,'').replace(/−/g,'-').toLowerCase();
const normalizedHall=(name:string)=>name.trim().replace(/\s+/g,' ').toLowerCase();
function standardCifOperations(tags:Record<string,string>,s:Structure):string[] {
  const present=(value:string|undefined)=>value&&!['.','?'].includes(value)?value:undefined;
  const name=present(tags['_space_group_name_h-m_alt'])??present(tags['_symmetry_space_group_name_h-m'])??present(tags['_space_group_name_h-m_ref']);
  const number=present(tags._space_group_it_number)??present(tags._symmetry_int_tables_number);
  const hall=present(tags._space_group_name_hall)??present(tags._symmetry_space_group_name_hall);
  const settings=Object.entries(tags).filter(([key,value])=>/coordinate_system_code|origin_choice|space_group_setting/.test(key)&&!['.','?'].includes(value));
  if(settings.length)throw new Error('CIF带自定义晶轴/原点设置，但未提供显式对称操作；当前标准设置表不能推测该变换。');
  if(!name&&!number&&!hall){if(Object.keys(tags).some(key=>/space_group_name|space_group_it_number|symmetry_int_tables_number/.test(key)))throw new Error('CIF声明的空间群未知且没有显式对称操作；不能假定P1。');return ['x,y,z'];}
  let candidates=Object.values(standardGroups);
  if(number){const n=num(number);if(!Number.isInteger(n)||n<1||n>230)throw new Error('CIF International空间群号须为1–230。');candidates=candidates.filter(g=>g.number===n);}
  if(name)candidates=candidates.filter(g=>g.nameAliases.some(alias=>normalizedGroup(alias)===normalizedGroup(name)));
  if(hall)candidates=candidates.filter(g=>g.hallAliases.some(alias=>normalizedHall(alias)===normalizedHall(hall)));
  if(candidates.length!==1)throw new Error('CIF空间群名称/Hall/编号不一致或设置未登记；请提供显式对称操作，不能猜测设置或视为P1。');
  const group=candidates[0];
  if(group.number!==1&&!s.cell)throw new Error('非P1空间群展开需要真实晶胞。');
  if(s.cell){
    const metric=s.cell.vectors.map(a=>s.cell!.vectors.map(b=>dot3(a,b))),tolerance=Math.max(...metric.flat().map(Math.abs),1)*1e-4;
    for(const op of group.operations){const t=symmetry(op,[0,0,0]),columns=([0,1,2] as const).map(i=>{const f:Vector3=[0,0,0];f[i]=1;return symmetry(op,f).map((x,k)=>x-t[k]) as Vector3;});
      for(let i=0;i<3;i++)for(let j=0;j<3;j++){const transformed=columns[i].reduce((sum,x,k)=>sum+x*columns[j].reduce((sum2,y,l)=>sum2+y*metric[k][l],0),0);if(Math.abs(transformed-metric[i][j])>tolerance)throw new Error('CIF晶胞与指定空间群的标准设置不相容；请提供对应晶轴设置及显式对称操作。');}
    }
  }
  s.notes.push(`未给出显式对称操作；按指定空间群${group.symbol}（IT ${group.number}）采用pymatgen ${cifSpaceGroups.provenance.pymatgenVersion}默认常规设置${group.number>=143&&group.number<=167?'（菱方群使用六方设置）':''}；非原子自动对称性识别。`);
  return group.operations;
}
function parseCif(text:string,name:string):Structure[] {
  const tokens=cifTokens(text),starts=tokens.flatMap((t,i)=>!t.quoted&&/^data_/i.test(t.value)?[i]:[]);if(!starts.length)starts.push(0);
  return starts.map((start,index)=>{const {tags,loops}=cifData(tokens.slice(start,starts[index+1]??tokens.length)),s=base(name,'CIF',index);const lengths=['a','b','c'].map(k=>tags[`_cell_length_${k}`]),angles=['alpha','beta','gamma'].map(k=>tags[`_cell_angle_${k}`]);
    if([...lengths,...angles].some(Boolean)){if([...lengths,...angles].some(x=>!x))throw new Error('CIF晶胞参数不完整。');s.cell=cellFromParameters(...([...lengths,...angles].map(num) as [number,number,number,number,number,number]),name);}
    if(tags._builder_cell_vectors){const vals=tags._builder_cell_vectors.split(/\s+/).map(num);if(vals.length!==9||!s.cell)throw new Error('CIF精确晶胞向量不完整。');s.cell.vectors=[vals.slice(0,3),vals.slice(3,6),vals.slice(6,9)] as [Vector3,Vector3,Vector3];if(tags._builder_cell_origin)s.cell.origin=vec(tags._builder_cell_origin.split(/\s+/));if(tags._builder_cell_pbc)s.cell.pbc=pbc(tags._builder_cell_pbc);cellInverse(s.cell);}
    if(s.cell){
      const audit=tags._audit_creation_method??'',cp2k=/^\s*CP2K version\s+\d+/im.test(audit),mask=cp2k?audit.match(/^\s*-\s*Periodicity of cell:\s*((?:[TF]\s+){2}[TF])\s*$/im)?.[1]:undefined;
      if(mask&&tags._builder_cell_pbc&&JSON.stringify(pbc(mask))!==JSON.stringify(pbc(tags._builder_cell_pbc)))throw new Error('CIF周期轴来源声明相互冲突，未自动选择。');
      if(mask||tags._builder_cell_pbc){s.cell.pbc=pbc(mask??tags._builder_cell_pbc);s.cell.pbcProvenance={kind:'source-explicit',evidence:mask?`CP2K CIF _audit_creation_method：Periodicity of cell: ${mask}`:'CIF _builder_cell_pbc显式周期轴声明。'};}
      else s.cell.pbcProvenance={kind:'unconfirmed',evidence:'CIF已给出晶胞，但未保存明确周期轴掩码；当前轴仅作预览，运行前须确认。'};
      if(cp2k)s.notes.push('生成来源：CP2K（CIF _audit_creation_method）；文件角色为结构，不作为CP2K结果OUT解析。');
    }
    restorePeriodicity(s,tags._builder_periodic_metadata);
    const opTag=['_space_group_symop_operation_xyz','_symmetry_equiv_pos_as_xyz'],opLoop=loops.find(l=>l.headers.some(h=>opTag.includes(h))),ops=opLoop?opLoop.rows.map(row=>row[opLoop.headers.findIndex(h=>opTag.includes(h))]):opTag.flatMap(k=>tags[k]?[tags[k]]:[]);
    if(!ops.length)ops.push(...standardCifOperations(tags,s));
    const loop=loops.find(l=>l.headers.includes('_atom_site_fract_x')||l.headers.includes('_atom_site_cartn_x'));if(!loop)throw new Error('CIF缺少原子坐标loop。');const col=(key:string)=>loop.headers.indexOf(`_atom_site_${key}`),get=(row:string[],key:string)=>row[col(key)];
    const fractional=col('fract_x')>=0;if(fractional&&!s.cell)throw new Error('CIF分数坐标需要真实晶胞。');if(!s.cell&&ops.some(op=>op.replace(/\s/g,'')!=='x,y,z'))throw new Error('无晶胞CIF不能展开对称操作。');const useExact=!!tags._builder_cell_vectors&&col('cartn_x')>=0;
    const operations:{op:string;matrix:[Vector3,Vector3,Vector3];sourceOperation:number}[]=[],operationKeys=new Set<string>(),images:CifImage[]=[],positions=new CifPositionIndex(s),explicitIds=col('builder_source_index')>=0&&ops.length===1;
    for(let opIndex=0;opIndex<ops.length;opIndex++){
      const op=ops[opIndex],matrix=cifImageMatrix(op),offset=symmetry(op,[0,0,0]).map((x,i)=>s.cell?.pbc[i]?x-Math.floor(x):x),key=JSON.stringify([matrix,offset]);
      if(operationKeys.has(key))continue;
      operationKeys.add(key);operations.push({op,matrix,sourceOperation:opIndex});
    }
    if(!explicitIds)s.notes.push('CIF原始位点标签以可逆编码保留在原行/对称像稳定ID中；sourceIndex保留原始位点行号。');
    loop.rows.forEach((row,sourceIndex)=>{const occupancy=get(row,'occupancy');if(occupancy&&(['.','?'].includes(occupancy)||Math.abs(num(occupancy)-1)>1e-8))throw new Error('CIF含未知/部分占位或无序，需先明确选定完整构型。');for(const key of ['disorder_group','disorder_assembly']){const d=get(row,key);if(d&&!['.','?','0'].includes(d))throw new Error('CIF含无序组，不能自动选择或合并构型。');}
      const label=get(row,'label')??`site${sourceIndex+1}`,raw=get(row,'type_symbol')??label.match(/^[A-Z][a-z]?/)?.[0];if(!raw)throw new Error('CIF原子缺少可靠元素。');const element=cifElement(raw),prefix=fractional?'fract':'cartn',coordinateTokens=['x','y','z'].map(k=>get(row,`${prefix}_${k}`)),coords=vec(coordinateTokens);
      const f=fractional?coords:s.cell?cartesianToFractional(s.cell,coords):coords;
      const halfUnit=coordinateTokens.map(cifPrintedHalfUnit) as Vector3,coordinateBasis:[Vector3,Vector3,Vector3]=fractional||!s.cell?[[1,0,0],[0,1,0],[0,0,1]]:cellInverse(s.cell);
      const orbit=operations.map(({op,matrix,sourceOperation})=>{let p:Vector3;if(useExact&&ops.length===1)p=vec(['x','y','z'].map(k=>get(row,`cartn_${k}`)));else if(ops.length===1&&op.replace(/\s/g,'').toLowerCase()==='x,y,z')p=fractional?fractionalToCartesian(s.cell!,coords):coords;else if(s.cell){const transformed=symmetry(op,f).map((x,i)=>s.cell!.pbc[i]?x-Math.floor(x):x) as Vector3;p=fractionalToCartesian(s.cell,transformed);}else p=coords;
        const rowMatrix=matrix.map(matrixRow=>([0,1,2] as const).map(j=>matrixRow.reduce((sum,value,k)=>sum+value*coordinateBasis[k][j],0)) as Vector3) as [Vector3,Vector3,Vector3];
        return {point:p,sourceOperation,image:{fraction:s.cell?cartesianToFractional(s.cell,p):p,matrix:rowMatrix,element,sourceRow:sourceIndex} satisfies CifImage};
      });
      const representatives=cifOrbitRepresentatives(orbit.map(item=>item.image),halfUnit,s);
      for(const opIndex of representatives){
        const {point:p,image,sourceOperation}=orbit[opIndex];
        const coincident=positions.candidates(image).map(entry=>entry.image).find(previous=>previous.sourceRow!==sourceIndex&&cifImageDelta(image.fraction,previous.fraction,s).every(x=>Math.abs(x)<=64*Number.EPSILON*Math.max(1,...image.fraction.map(Math.abs),...previous.fraction.map(Math.abs))));
        if(coincident)throw new Error(coincident.element!==element?'CIF同一位置含不同元素，属于未解析无序。':'CIF不同来源位点重合，需明确重复位点或无序，不能自动合并。');
        const provenance=get(row,'builder_source_index');const sourceNumber=provenance?num(provenance):sourceIndex+1;if(!Number.isSafeInteger(sourceNumber)||sourceNumber<1)throw new Error('CIF来源原子序号无效。');
        add(s,element,p,explicitIds?label:`${s.id}:site:${sourceIndex+1}:${encodeURIComponent(label)}:sym:${sourceOperation+1}`,sourceNumber);positions.add(image,images.length);images.push(image);
      }
    });if(ops.length>1)s.notes.push(`已按${ops.length}个对称操作展开并去重；sourceIndex保留原始位点，ID区分映像。`);return finish(s);
  });
}

function parsePoscar(text:string,name:string):Structure[] {const lines=text.split('\n');if(lines.length<8)throw new Error('POSCAR内容截断。');const s=base(name,'POSCAR'),scales=lines[1].trim().split(/\s+/).map(num);if(![1,3].includes(scales.length)||scales.some(x=>x===0)||(scales.length===3&&scales.some(x=>x<0)))throw new Error('POSCAR缩放因子须为一个非零值或三个正值。');const raw=[2,3,4].map(i=>vec(lines[i].trim().split(/\s+/))) as [Vector3,Vector3,Vector3];let scale:Vector3=scales.length===3?scales as Vector3:[scales[0],scales[0],scales[0]];if(scales.length===1&&scales[0]<0){const volume=Math.abs(dot3(raw[0],cross3(raw[1],raw[2])));if(volume<1e-10)throw new Error('POSCAR晶胞奇异。');const x=Math.cbrt(-scales[0]/volume);scale=[x,x,x];}s.cell={vectors:raw.map(v=>v.map((x,i)=>x*scale[i])) as [Vector3,Vector3,Vector3],pbc:[true,true,true],source:name};cellInverse(s.cell);
  let i=5;const symbols=lines[i++].trim().split(/\s+/);if(symbols.every(x=>/^\d+$/.test(x)))throw new Error('VASP4 POSCAR没有元素标签；请提供带元素行的POSCAR，不能猜测POTCAR。');symbols.forEach(elementSymbol);const counts=lines[i++]?.trim().split(/\s+/).map(Number);if(!counts||counts.length!==symbols.length||counts.some(n=>!Number.isInteger(n)||n<0)||!Number.isSafeInteger(counts.reduce((a,b)=>a+b,0))||!counts.some(Boolean))throw new Error('POSCAR元素数量声明无效。');const selective=/^s/i.test(lines[i]?.trim()??'');if(selective)i++;const mode=lines[i++]?.trim();if(!mode||! /^[dck]/i.test(mode))throw new Error('POSCAR缺少Direct/Cartesian坐标类型。');const direct=/^d/i.test(mode);const ids:string[]=[];const flags:string[]=[];
  symbols.forEach((element,k)=>{for(let j=0;j<counts[k];j++){const row=lines[i++]?.trim().split(/\s+/);if(!row||row.length<(selective?6:3))throw new Error('POSCAR坐标段截断。');const p=vec(row);if(selective){if(row.slice(3,6).some(v=>! /^[TF]$/i.test(v)))throw new Error('Selective dynamics约束标记无效。');flags.push(row.slice(3,6).join(' '));}const id=row.find(v=>v.startsWith('id='));ids.push(id?decodeURIComponent(id.slice(3)):`${s.id}:atom:${s.atoms.length+1}`);add(s,element,direct?fractionalToCartesian(s.cell!,p):p.map((x,k)=>x*scale[k]) as Vector3,ids.at(-1));}});
  if(selective)s.notes.push(`来源Selective dynamics标记（仅结构记录，不应用为优化约束）：${flags.join('; ')}。`);
  const metadata=lines.slice(i).find(line=>line.startsWith('# builder_metadata '));if(metadata){let m:{origin?:Vector3;pbc?:[boolean,boolean,boolean];sourceIndices?:number[];periodicMetadata?:string};try{m=JSON.parse(metadata.slice(19));}catch{throw new Error('POSCAR builder元数据损坏。');}if(m.origin)s.cell.origin=vec(m.origin.map(String));if(m.pbc)s.cell.pbc=pbc(m.pbc.map(x=>x?'T':'F').join(' '));restorePeriodicity(s,m.periodicMetadata);if(m.sourceIndices){if(m.sourceIndices.length!==s.atoms.length||m.sourceIndices.some(x=>!Number.isSafeInteger(x)))throw new Error('POSCAR来源序号元数据损坏。');s.atoms.forEach((a,k)=>a.sourceIndex=m.sourceIndices![k]);}}
  return [finish(s)];}

function parsePdb(text:string,name:string):Structure[] {const crystal=text.split('\n').find(l=>l.startsWith('CRYST1'));if(!crystal)throw new Error('PDB周期结构缺少CRYST1。');const cell=cellFromParameters(...([crystal.slice(6,15),crystal.slice(15,24),crystal.slice(24,33),crystal.slice(33,40),crystal.slice(40,47),crystal.slice(47,54)].map(v=>num(v.trim())) as [number,number,number,number,number,number]),name);cell.pbcProvenance={kind:'unconfirmed',evidence:'PDB CRYST1仅保存晶胞参数，未保存独立周期轴掩码；当前轴为预览候选，运行前须确认。'};const models:string[][]=[];let current:string[]=[];for(const line of text.split('\n')){if(/^MODEL |^ENDMDL/.test(line)){if(current.length){models.push(current);current=[];}}else if(/^(ATOM  |HETATM)/.test(line))current.push(line);}if(current.length)models.push(current);return models.flatMap((rows,model)=>{const alts=[...new Set(rows.map(l=>l[16]?.trim()).filter(Boolean))];return (alts.length?alts:['']).map((alt,index)=>{const s=base(name,`PDB CRYST1 model ${model+1}${alt?` alt ${alt}`:''}`,model*100+index);s.cell=structuredClone(cell);s.notes.push('PDB坐标按原固定列打印精度读取，不补原文件未记录的小数；CRYST1不证明二维周期轴。');for(const line of rows.filter(l=>!l[16]?.trim()||l[16]===alt)){const label=line.slice(12,16),letters=label.trim().replace(/^\d+/,'');let element=line.slice(76,78).trim();if(!element){element=/^\s|^\d/.test(label)?letters[0]:letters.slice(0,2);try{elementSymbol(element);}catch{element=letters[0];}}add(s,element,vec([line.slice(30,38),line.slice(38,46),line.slice(46,54)].map(x=>x.trim())),`${s.id}:serial:${line.slice(6,11).trim()}`,num(line.slice(6,11).trim()));}if(alt)s.notes.push(`使用替代位置${alt}及公共原子。`);return finish(s);});});}
interface Section {name:string;args:string[];lines:string[][];children:Section[]}
function cpComment(line:string):string {let quote='';for(let i=0;i<line.length;i++){if((line[i]==="'"||line[i]==='"')&&line[i-1]!=='\\'){if(quote===line[i])quote='';else if(!quote)quote=line[i];}else if(!quote&&/[!#]/.test(line[i]))return line.slice(0,i);}return line;}
function cpSections(text:string):Section {const root:Section={name:'ROOT',args:[],lines:[],children:[]},stack=[root];for(const raw of text.split('\n')){const line=cpComment(raw).trim();if(!line)continue;if(line.startsWith('@'))throw new Error('CP2K含未解析预处理指令；请提供展开后的坐标与晶胞。');const row=line.match(/"[^"]*"|'[^']*'|\S+/g)!.map(x=>x.replace(/^['"]|['"]$/g,''));if(/^&END$/i.test(row[0])){if(stack.length===1||row[1]&&row[1].toUpperCase()!==stack.at(-1)!.name)throw new Error('CP2K section结束不匹配。');stack.pop();}else if(row[0].startsWith('&')){const node:Section={name:row[0].slice(1).toUpperCase(),args:row.slice(1),lines:[],children:[]};stack.at(-1)!.children.push(node);stack.push(node);}else stack.at(-1)!.lines.push(row);}if(stack.length!==1)throw new Error('CP2K section未闭合。');return root;}
const findSections=(s:Section,name:string):Section[]=>[...(s.name===name?[s]:[]),...s.children.flatMap(c=>findSections(c,name))];
function unit(raw:string|undefined):number {if(!raw)return 1;const u=raw.replace(/^\[|\]$/g,'').toLowerCase();if(['angstrom','ang','a'].includes(u))return 1;if(['bohr','au','a.u.'].includes(u))return BOHR;if(u==='nm')return 10;throw new Error(`未覆盖CP2K长度单位${raw}。`);}
function externalText(files:Record<string,string>,file:string):string {const normalized=file.replace(/\\/g,'/').replace(/^\.\//,'');const entry=Object.entries(files).find(([key])=>key.replace(/\\/g,'/').replace(/^\.\//,'')===normalized);if(!entry)throw new Error(`CP2K依赖外部文件${file}，请一起提供；不读取任意本机路径。`);return entry[1].replace(/\r\n?/g,'\n');}
function expandCp2kIncludes(text:string,files:Record<string,string>,stack:string[]=[],variables=new Map<string,string>(),budget={characters:0}):string {
  const substitute=(input:string,path:string[]=[]):string=>input.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,(original,a:string,b:string)=>{
    const name=a??b,value=variables.get(name);if(value===undefined)return original;
    if(path.includes(name))throw new Error(`CP2K变量${name}存在循环依赖。`);
    return substitute(value,[...path,name]);
  });
  return text.split('\n').map(raw=>{
    const line=cpComment(raw).trim();if(!line)return '';
    if(/^@SET\b/i.test(line)){
      const match=line.match(/^@SET\s+([A-Za-z_]\w*)\s+(.+)$/i);if(!match)throw new Error('CP2K @SET需提供变量名和字面值。');variables.set(match[1],substitute(match[2].trim()));return '';
    }
    if(/^@INCLUDE\b/i.test(line)){
      const expanded=substitute(line),match=expanded.match(/^@INCLUDE\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))\s*$/i);
      if(!match)throw new Error('CP2K INCLUDE路径语法无效。');
      const file=match[1]??match[2]??match[3],key=file.replace(/\\/g,'/').replace(/^\.\//,'');if(/\$\{?\w/.test(file))throw new Error('CP2K INCLUDE路径含未解析变量。');
      if(stack.includes(key))throw new Error('CP2K INCLUDE存在循环依赖。');
      return expandCp2kIncludes(externalText(files,file),files,[...stack,key],variables,budget);
    }
    if(line.startsWith('@'))throw new Error('CP2K @IF/条件及其它预处理暂不支持，不能静默选择分支。');
    const expanded=substitute(line);budget.characters+=expanded.length+1;return expanded;
  }).join('\n');
}
function externalCoordinates(text:string,name:string,format:string):Structure[] {
  if(format==='mol2')throw new Error('已移除MOL2导入与导出；CP2K外部坐标请改用XYZ/PDB/CIF。');
  assertNoMol2Source(text,name);
  if(format==='xyz')return parseXyz(text,name);
  if(format==='cif')return parseCif(text,name);
  if(format==='pdb'){
    if(/^CRYST1/m.test(text))return parsePdb(text,name);
    if((text.match(/^MODEL /gm)??[]).length>1)throw new Error('CP2K外部PDB含多个模型，须先选定单帧。');
    const s=base(name,'PDB external coordinates');
    for(const line of text.split('\n').filter(l=>/^(ATOM  |HETATM)/.test(l))){if(line[16]?.trim())throw new Error('CP2K外部PDB含替代位置，须先选定构型。');const label=line.slice(12,16),letters=label.trim().replace(/^\d+/,'');let element=line.slice(76,78).trim();if(!element){element=/^\s|^\d/.test(label)?letters[0]:letters.slice(0,2);try{elementSymbol(element);}catch{element=letters[0];}}add(s,element,vec([line.slice(30,38),line.slice(38,46),line.slice(46,54)].map(x=>x.trim())),`${s.id}:serial:${line.slice(6,11).trim()}`,num(line.slice(6,11).trim()));}
    return [finish(s)];
  }
  throw new Error(`未覆盖CP2K外部坐标格式${format}。`);
}
function parseCp2k(text:string,name:string,external:Record<string,string>):Structure[] {const root=cpSections(text),subsystems=findSections(root,'SUBSYS');if(!subsystems.length)throw new Error('CP2K缺少SUBSYS。');return subsystems.map((sub,index)=>{const s=base(name,'CP2K structure',index),cell=sub.children.find(c=>c.name==='CELL'),coord=sub.children.find(c=>c.name==='COORD'),top=sub.children.find(c=>c.name==='TOPOLOGY');const get=(section:Section|undefined,key:string)=>section?.lines.find(l=>l[0].toUpperCase()===key)?.slice(1);
    const assertResolved=(section:Section):void=>{if([...section.args,...section.lines.flat()].some(value=>/\$\{?\w/.test(value)))throw new Error(`CP2K ${section.name}含未解析变量；不能猜测结构。`);section.children.forEach(assertResolved);};
    sub.children.filter(c=>['CELL','COORD','KIND'].includes(c.name)).forEach(assertResolved);
    if(top?.lines.filter(row=>['COORD_FILE_NAME','COORD_FILE_FORMAT','MULTIPLE_UNIT_CELL'].includes(row[0].toUpperCase())).flat().some(value=>/\$\{?\w/.test(value)))throw new Error('CP2K外部坐标文件含未解析变量。');
    const topologyMultiple=get(top,'MULTIPLE_UNIT_CELL');if(topologyMultiple&&topologyMultiple.some(v=>num(v)!==1))throw new Error('CP2K TOPOLOGY/MULTIPLE_UNIT_CELL需要显式展开，当前不能忽略复制。');
    const symmetryType=get(cell,'SYMMETRY')?.[0];if(symmetryType&&symmetryType.toUpperCase()!=='NONE')throw new Error('CP2K CELL/SYMMETRY可能重构晶胞，请提供最终显式晶胞。');
    const canonicalize=get(cell,'CANONICALIZE');if(canonicalize&&!/^(AUTO|F|FALSE|\.FALSE\.)$/i.test(canonicalize[0]??'TRUE'))throw new Error('CP2K显式CANONICALIZE会变换晶胞与坐标，请提供最终显式结构。');
    if(cell){const angles=cell.lines.find(l=>l[0].toUpperCase()==='ANGLES');if(angles&&!get(cell,'ALPHA_BETA_GAMMA'))angles[0]='ALPHA_BETA_GAMMA';}
    const readRow=(row:string[]):Vector3=>{const hasUnit=row[0]?.startsWith('['),scale=unit(hasUnit?row[0]:undefined);return vec(row.slice(hasUnit?1:0)).map(x=>x*scale) as Vector3;};
    if(cell){const a=get(cell,'A'),b=get(cell,'B'),c=get(cell,'C'),abc=get(cell,'ABC'),file=get(cell,'CELL_FILE_NAME');if([a,b,c].some(Boolean)){if(!a||!b||!c||abc||file)throw new Error('CP2K晶胞向量缺失或同时有多个不明确来源。');s.cell={vectors:[readRow(a),readRow(b),readRow(c)],pbc:[true,true,true],source:name};}else if(abc){if(file)throw new Error('CP2K晶胞有多个来源。');const lengths=readRow(abc),angles=get(cell,'ALPHA_BETA_GAMMA')??['90','90','90'];const offset=angles[0]?.startsWith('[')?1:0;if(offset&&!/^\[deg(?:ree)?\]$/i.test(angles[0]))throw new Error('未覆盖CP2K晶胞角度单位。');s.cell=cellFromParameters(...lengths,...vec(angles.slice(offset)),name);}else if(file){const content=externalText(external,file.join(' ')),format=get(cell,'CELL_FILE_FORMAT')?.[0]?.toLowerCase();if(format==='cp2k'||!format){const nested=cpSections(content),cs=findSections(nested,'CELL')[0];if(cs){const fake=`&SUBSYS\n${content}\n&COORD\nH 0 0 0\n&END\n&END`;s.cell=parseCp2k(fake,name,external)[0].cell;}else {const rows=content.split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));const last=rows.at(-1)?.split(/\s+/);if(!last||last.length<11)throw new Error('CP2K .cell外部文件需含step/time及9个向量分量。');const vals=last.slice(2,11).map(num);s.cell={vectors:[vals.slice(0,3),vals.slice(3,6),vals.slice(6,9)] as [Vector3,Vector3,Vector3],pbc:[true,true,true],source:file.join(' ')};}}else {const parsed=parsePeriodicStructures(content,`${file.join(' ')}${/\.[^.]+$/.test(file.join(' '))?'':'.'+format}`,external);s.cell=parsed?.[0].cell;if(!s.cell)throw new Error('CP2K外部晶胞文件无真实晶胞。');}}
      if(s.cell){const periodic=get(cell,'PERIODIC');if(periodic)s.cell.pbc=pbc(periodic.join(' '));const multiple=get(cell,'MULTIPLE_UNIT_CELL');if(multiple&&multiple.some(v=>num(v)!==1))throw new Error('CP2K MULTIPLE_UNIT_CELL非1需要显式展开结构，当前不静默复制。');cellInverse(s.cell);}}
    const kindMap=new Map(sub.children.filter(c=>c.name==='KIND').map(k=>[k.args[0],get(k,'ELEMENT')?.[0]??k.args[0]]));
    if(coord){const scaled=get(coord,'SCALED'),fractional=!!scaled&&!/^(F|FALSE|\.FALSE\.|0)$/i.test(scaled[0]??'T'),scale=unit(get(coord,'UNIT')?.[0]);if(fractional&&!s.cell)throw new Error('CP2K SCALED坐标缺少晶胞。');for(const row of coord.lines){if(['SCALED','UNIT'].includes(row[0].toUpperCase()))continue;if(row.length<4)throw new Error('CP2K COORD坐标截断。');const p=vec(row.slice(1));add(s,kindMap.get(row[0])??row[0],fractional?fractionalToCartesian(s.cell!,p):p.map(x=>x*scale) as Vector3);}}
    else {const file=get(top,'COORD_FILE_NAME')?.join(' ');if(!file)throw new Error('CP2K缺少内嵌COORD或外部坐标文件。');const format=get(top,'COORD_FILE_FORMAT')?.[0]?.toLowerCase()??file.split('.').at(-1)?.toLowerCase(),content=externalText(external,file);let structures:Structure[];if(format==='cp2k'){const fake=`&SUBSYS\n&COORD\n${content}\n&END\n&END`;structures=parseCp2k(fake,file,external);}else structures=externalCoordinates(content,file,format??'');if(structures.length!==1)throw new Error('CP2K外部坐标必须明确为单帧。');s.atoms=structures[0].atoms;if(!s.cell)s.cell=structures[0].cell;s.notes.push(`坐标来自一起提供的${file}；保留该文件原子ID和sourceIndex。`);}
    return finish(s);
  });}

/** Raw source admission only; saved native structure metadata bypasses readers. */
export function assertNoMol2Source(text:string,name:string):void {
  if(/\.mol2$/i.test(name)||/^\s*@<TRIPOS>(?:MOLECULE|ATOM|BOND|CRYSIN)\b/im.test(text))throw new Error('已移除MOL2导入与导出；请使用MOL或SDF。');
}

/** Return null only when the text is outside this adapter's format ownership. */
export function parsePeriodicStructures(raw:string,name:string,external:Record<string,string>={}):Structure[]|null {
  assertNoMol2Source(raw,name);
  const text=raw.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'),ext=name.split('.').at(-1)?.toLowerCase();
  if(raw.includes('\0'))throw new Error('结构必须为UTF-8文本。');
  if(ext==='cif'||/^\s*data_/im.test(text)&&/_atom_site_/i.test(text))return parseCif(text,name);
  if(/^(?:POSCAR|CONTCAR)(?:\.|$)/i.test(name.split(/[\\/]/).at(-1)??'')||ext==='vasp'||ext==='poscar')return parsePoscar(text,name);
  if(/^\s*&(?:SUBSYS|FORCE_EVAL)\b/im.test(text)&&(/^\s*&(?:CELL|COORD|TOPOLOGY)\b/im.test(text)||/^\s*@INCLUDE\b/im.test(text)))return parseCp2k(expandCp2kIncludes(text,external),name,external);
  if(/^CRYST1/m.test(text)&&/^(ATOM  |HETATM)/m.test(text))return parsePdb(text,name);
  if(/^\s*\d+\s*\n/.test(text)&&/\b(?:Lattice|Properties|pbc|builder_atoms)\s*=/i.test(text.split('\n')[1]??''))return parseXyz(text,name);
  return null;
}
