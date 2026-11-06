import {validateCenterInput,centerCacheKey,centerFromSums,type CenterInput,type CenterProgress,type CenterResourcePort,type TrajectoryCenterResult} from './trajectory-center-math';
export * from './trajectory-center-math';
/** Source lifetime belongs to the collection. This owner holds one grant and
 * one real worker; all cancellation paths terminate it before releasing grant. */
export class TrajectoryCenterOwner {
 private epoch=0;private current?:{id:string;worker?:Worker;port:CenterResourcePort;cancelled:boolean;reject?:(reason:unknown)=>void};
 private cache=new Map<string,TrajectoryCenterResult>();
 get(input:CenterInput){return this.cache.get(centerCacheKey(input));}
 async cancel(){const own=this.current;if(!own)return;own.cancelled=true;this.epoch++;own.worker?.terminate();own.reject?.(new DOMException('中心帧搜索已取消。','AbortError'));if(!own.worker)await own.port.cancel(own.id);}
 async start(input:CenterInput,port:CenterResourcePort,onProgress?:(progress:CenterProgress)=>void):Promise<TrajectoryCenterResult>{
  await this.cancel();const ids=validateCenterInput(input),cached=this.get(input);if(cached)return cached;
  if(input.structures.length===1){const result=centerFromSums(input,new Float64Array(1),0);this.cache.set(result.cacheKey,result);return result;}
  const own={id:`trajectory-center-${crypto.randomUUID()}`,port,cancelled:false} as NonNullable<TrajectoryCenterOwner['current']>,epoch=++this.epoch;this.current=own;let granted=false;
  try{
   await port.acquire(own.id);granted=true;if(own.cancelled||this.epoch!==epoch)throw new DOMException('中心帧搜索已取消。','AbortError');
   const worker=new Worker(new URL('./trajectory-center-worker.ts',import.meta.url),{type:'module'});own.worker=worker;
   const total=input.structures.length*(input.structures.length-1)/2;
   const compared=await new Promise<{sums:Float64Array;completedPairs:number}>((resolve,reject)=>{own.reject=reject;worker.onerror=event=>reject(Error(event.message||'中心帧后台计算失败。'));worker.onmessage=event=>{if(own.cancelled||this.epoch!==epoch)return;const message=event.data;if(message.kind==='progress')onProgress?.({completedPairs:message.completedPairs,totalPairs:total});else if(message.kind==='result')resolve({sums:message.sums,completedPairs:message.completedPairs});else if(message.kind==='error')reject(Error(message.message));};worker.postMessage({structures:input.structures,ids});});
   if(own.cancelled||this.epoch!==epoch)throw new DOMException('中心帧搜索已取消。','AbortError');const result=centerFromSums(input,compared.sums,compared.completedPairs);this.cache.set(result.cacheKey,result);return result;
  }finally{own.worker?.terminate();own.reject=undefined;if(granted)await port.release(own.id);if(this.current===own)this.current=undefined;}
 }
}
