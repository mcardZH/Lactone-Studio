import {validateCenterInput,centerCacheKey,centerFromSums,type CenterInput,type CenterFrameInput,type CenterProgress,type CenterResourcePort,type TrajectoryCenterResult} from './trajectory-center-math';
export * from './trajectory-center-math';
/** Source lifetime belongs to the collection. This owner holds one grant and
 * one real worker; all cancellation paths terminate it before releasing grant. */
export class TrajectoryCenterOwner {
 private epoch=0;private current?:{id:string;worker?:Worker;port:CenterResourcePort;cancelled:boolean; abort:AbortController; reject?:(reason:unknown)=>void};
 private cache=new Map<string,TrajectoryCenterResult>();
 get(input:CenterInput|CenterFrameInput|Pick<CenterInput,'collection'|'fitAtoms'>){return this.cache.get(centerCacheKey(input));}
 async cancel(){const own=this.current;if(!own)return;own.cancelled=true;this.epoch++;own.abort.abort();own.worker?.terminate();own.reject?.(new DOMException('中心帧搜索已取消。','AbortError'));if(!own.worker)await own.port.cancel(own.id);}
 async start(input:CenterInput|CenterFrameInput,port:CenterResourcePort,onProgress?:(progress:CenterProgress)=>void):Promise<TrajectoryCenterResult>{
  await this.cancel();const ids=validateCenterInput(input),cached=this.get(input);if(cached)return cached;
  const count=input.collection.frames.length;
  if(count===1){const result=centerFromSums(input,new Float64Array(1),0);this.cache.set(result.cacheKey,result);return result;}
  const own={id:`trajectory-center-${crypto.randomUUID()}`,port,cancelled:false,abort:new AbortController()} as NonNullable<TrajectoryCenterOwner['current']>,epoch=++this.epoch;this.current=own;let granted=false;
  let accepted:(()=>void)|undefined;
  try{
   await port.acquire(own.id);granted=true;if(own.cancelled||this.epoch!==epoch)throw new DOMException('中心帧搜索已取消。','AbortError');
   const worker=new Worker(new URL('./trajectory-center-worker.ts',import.meta.url),{type:'module'});own.worker=worker;
   const total=count*(count-1)/2;
   const outcome=new Promise<{sums:Float64Array;completedPairs:number}>((resolve,reject)=>{own.reject=reject;worker.onerror=event=>reject(Error(event.message||'中心帧后台计算失败。'));worker.onmessage=event=>{if(own.cancelled||this.epoch!==epoch)return;const message=event.data;if(message.kind==='progress')onProgress?.({completedPairs:message.completedPairs,totalPairs:total});else if(message.kind==='accepted')accepted?.();else if(message.kind==='result')resolve({sums:message.sums,completedPairs:message.completedPairs});else if(message.kind==='error')reject(Error(message.message));};});
   if('structures'in input)worker.postMessage({structures:input.structures,ids});
   else {
     const atoms=new Map(input.reference.atoms.map(atom=>[atom.id,atom]));
     const elements=ids.map(id=>atoms.get(id)!.element);
     worker.postMessage({kind:'begin-paged', ids, elements, count});
     const feed=async()=>{
       for(let index=0;index<count;index++){
         own.abort.signal.throwIfAborted();
         const frame=await input.readFrame(index,own.abort.signal);
         own.abort.signal.throwIfAborted();
         const byId=new Map(frame.atoms.map(atom=>[atom.id,atom])),coordinates=new Float64Array(ids.length*3);
         for(let i=0;i<ids.length;i++){
           const atom=byId.get(ids[i]);
           if(!atom||atom.element!==elements[i]||![atom.x,atom.y,atom.z].every(Number.isFinite))throw Error('中心帧的原子对应或坐标无效。');
           coordinates[3*i]=atom.x;coordinates[3*i+1]=atom.y;coordinates[3*i+2]=atom.z;
         }
         await new Promise<void>((resolve,reject)=>{
           accepted=resolve;
           try{worker.postMessage({kind:'paged-frame',index,coordinates},[coordinates.buffer]);}catch(error){reject(error);}
         });
       }
       own.abort.signal.throwIfAborted();worker.postMessage({kind:'finish-paged'});
     };
     void feed().catch(error=>own.reject?.(error));
   }
   const compared=await outcome;
   if(own.cancelled||this.epoch!==epoch)throw new DOMException('中心帧搜索已取消。','AbortError');const result=centerFromSums(input,compared.sums,compared.completedPairs);this.cache.set(result.cacheKey,result);return result;
  }finally{own.abort.abort();accepted?.();own.worker?.terminate();own.reject=undefined;if(granted)await port.release(own.id);if(this.current===own)this.current=undefined;}
 }
}
