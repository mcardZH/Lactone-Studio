import {centerPairRmsd} from './trajectory-center-math';
import type {Structure} from '../core/types';
const send=self.postMessage.bind(self) as unknown as (message:unknown,transfer?:Transferable[])=>void;
type CenterMessage = {structures:Structure[];ids:string[]} | {kind:'begin-paged';ids:string[];elements:string[];count:number}
  | {kind:'paged-frame';index:number;coordinates:Float64Array} | {kind:'finish-paged'};
let page: {ids:string[];elements:string[];count:number; frames:Float64Array[]} | undefined;
function compare(n:number,distance:(a:number,b:number)=>number) {
 const sums=new Float64Array(n);let completedPairs=0,last=performance.now();
 for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const d=distance(i,j);sums[i]+=d;sums[j]+=d;completedPairs++;if(performance.now()-last>=250){self.postMessage({kind:'progress',completedPairs});last=performance.now();}}
 send({kind:'result',sums,completedPairs},[sums.buffer]);
}
self.onmessage=(event:MessageEvent<CenterMessage>)=>{
 try{
  const value=event.data;
  if('structures'in value){compare(value.structures.length,(a,b)=>centerPairRmsd(value.structures[a],value.structures[b],value.ids));return;}
  if(value.kind==='begin-paged'){page={...value,frames:[]};return;}
  if(!page)throw Error('中心帧的坐标页尚未登记。');
  if(value.kind==='paged-frame'){
   if(value.index!==page.frames.length||value.coordinates.length!==page.ids.length*3)throw Error('中心帧的坐标页顺序或尺寸无效。');
   page.frames.push(value.coordinates);send({kind:'accepted'});return;
  }
  const {ids,elements,count,frames}=page;page=undefined;
  if(frames.length!==count)throw Error('中心帧的坐标页尚未完整登记。');
  const working=():Structure=>({id:'center-work',name:'center-work',format:'center-work',charge:null,multiplicity:null,notes:[],atoms:ids.map((id,i)=>({id,element:elements[i],x:0,y:0,z:0}))});
  const a=working(),b=working();let previous=-1;
  function set(structure:Structure,coordinates:Float64Array){structure.atoms.forEach((atom,i)=>{atom.x=coordinates[3*i];atom.y=coordinates[3*i+1];atom.z=coordinates[3*i+2];});}
  compare(count,(i,j)=>{if(previous!==i){set(a,frames[i]);previous=i;}set(b,frames[j]);return centerPairRmsd(a,b,ids);});
 }catch(error){self.postMessage({kind:'error',message:error instanceof Error?error.message:String(error)});}
};
