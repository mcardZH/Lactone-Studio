import {centerPairRmsd} from './trajectory-center-math';
import type {Structure} from '../core/types';
const send=self.postMessage.bind(self) as unknown as (message:unknown,transfer?:Transferable[])=>void;
self.onmessage=(event:MessageEvent<{structures:Structure[];ids:string[]}>)=>{
 try{const {structures,ids}=event.data,n=structures.length,sums=new Float64Array(n);let completedPairs=0,last=performance.now();
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const d=centerPairRmsd(structures[i],structures[j],ids);sums[i]+=d;sums[j]+=d;completedPairs++;if(performance.now()-last>=250){self.postMessage({kind:'progress',completedPairs});last=performance.now();}}
  send({kind:'result',sums,completedPairs},[sums.buffer]);
 }catch(error){self.postMessage({kind:'error',message:error instanceof Error?error.message:String(error)});}
};
