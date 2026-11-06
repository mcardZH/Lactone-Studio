import type { Structure } from '../../core/types';
import type { SamplingDeduplicationResult, SamplingWorkProgress } from './sampling-work';

interface Slot { worker:Worker; terminated?:boolean; failure?:Error; pending?: { id?:number; resolve(value:boolean):void; reject(error:Error):void } }
/** Source registration is fixed once per granted worker. Only stable indices
 * travel in comparison jobs; the coordinator alone chooses representatives in
 * original order, independent of completion order or worker count. */
export function startGeometryWorkPool(request:{candidates:Structure[];retained:Structure[];threshold:number},
  resources:{threads:number;memoryBudgetBytes:number;retainedMemoryEstimateBytes?:number},onProgress:(value:SamplingWorkProgress)=>void) {
  const structures=[...request.retained,...request.candidates];
  const sourceBytes=structures.reduce((sum,structure)=>sum+structure.atoms.length*512+(structure.bonds?.length??0)*96+1024,0);
  // A copy estimate selects concurrency only. A large source is still attempted
  // by one worker instead of being refused by a conservative predicted size.
  const availableEstimate=Math.max(0,resources.memoryBudgetBytes-(resources.retainedMemoryEstimateBytes??0));
  const width=Math.min(resources.threads,Math.max(1,structures.length-1),Math.max(1,Math.floor(availableEstimate/Math.max(1,sourceBytes*2))));
  const slots:Slot[]=[],accepted:number[]=[],retained=request.retained.map((_,index)=>index);
  let stopped=false,settled=false,processed=0,serial=0,lastProgress=0;
  const terminate=()=>{for(const slot of slots){if(!slot.terminated){slot.worker.terminate();slot.terminated=true;}slot.pending?.reject(new Error('几何工作块已停止。'));slot.pending=undefined;}};
  const send=(slot:Slot,value:object,id?:number)=>new Promise<boolean>((resolve,reject)=>{
    if(slot.failure){reject(slot.failure);return;}
    slot.pending={id,resolve,reject};try{slot.worker.postMessage(value);}catch(error){slot.pending=undefined;reject(error instanceof Error?error:new Error(String(error)));}
  });
  const promise=(async():Promise<SamplingDeduplicationResult>=>{
    try {
      const registrations:Promise<boolean>[]=[];
      for(let index=0;index<width;index++) {
        const worker=new Worker(new URL('./geometry-pair-worker.ts',import.meta.url),{type:'module'}),slot:Slot={worker};slots.push(slot);
        worker.onmessage=event=>{
          const value=event.data,pending=slot.pending;if(!pending||stopped)return;
          if(value.kind==='error'){slot.pending=undefined;pending.reject(new Error(value.error));}
          else if(value.kind==='registered'&&pending.id===undefined||value.kind==='compared'&&pending.id===value.id){slot.pending=undefined;pending.resolve(value.duplicate===true);}
        };
        worker.onerror=event=>{slot.failure=new Error(event.message||'几何工作块worker失败。');slot.pending?.reject(slot.failure);slot.pending=undefined;};
        const registration=send(slot,{kind:'register',structures,threshold:request.threshold});
        // A later Worker constructor can fail before Promise.all is reached.
        // Retain a rejection observer for every already-issued registration.
        void registration.catch(()=>{});registrations.push(registration);
      }
      await Promise.all(registrations);
      for(let index=0;index<request.candidates.length&&!stopped;index++) {
        const movingIndex=request.retained.length+index;
        const chunkSize=Math.max(1,Math.ceil(retained.length/slots.length)),jobs:Promise<boolean>[]=[];
        for(let offset=0;offset<retained.length;offset+=chunkSize){const slot=slots[jobs.length],id=++serial;jobs.push(send(slot,{kind:'compare',id,movingIndex,referenceIndices:retained.slice(offset,offset+chunkSize)},id));}
        const duplicates=await Promise.all(jobs);if(stopped)break;
        if(!duplicates.some(Boolean)){accepted.push(index);retained.push(movingIndex);}
        processed=index+1;
        const now=performance.now();if(now-lastProgress>=250||processed===request.candidates.length){lastProgress=now;onProgress({completed:processed,total:request.candidates.length,valid:accepted.length});}
      }
    } catch(error){if(!stopped)throw error;}
    finally {settled=true;terminate();}
    // Cancellation keeps all not-yet-classified complete structures. The run
    // explicitly records that deduplication was unfinished.
    for(let index=processed;index<request.candidates.length;index++)accepted.push(index);
    return {acceptedIndices:accepted,processed,completed:processed===request.candidates.length};
  })();
  return {promise,stop(){if(!settled){stopped=true;terminate();}},workerCount:width};
}
