import { prepareDisplayMesh, preparePackedDisplayMeshWork, type MeshPreparation } from './surface-mesh-preparation';
import type { SurfaceMeshTopology } from './surface-mesh';
import { meshPacket, packDisplayMesh, type PackedChunk, type MeshBuildReply } from './surface-mesh-transfer';
import {runRenderWork} from './render-work';

type PendingMesh = { id: number; key: string; request: MeshPreparation; value?: PackedChunk[];
  error?: string; };

// Only one transient mesh construction/transfer occupies this renderer's
// staging space until its typed result is consumed. Requests wait and remain
// cancellable; no field, phase or displayed triangle is removed to admit one.
const meshBuildQueue=new Set<()=>void>();
let meshBuildOccupied=false;
function dispatchMeshBuild() {
  if(meshBuildOccupied)return;
  const next=meshBuildQueue.values().next().value;
  if(!next)return;
  meshBuildQueue.delete(next);meshBuildOccupied=true;next();
}
function acquireMeshBuild(start:()=>void) {
  let granted=false,released=false;
  const begin=()=>{granted=true;start();};
  meshBuildQueue.add(begin);queueMicrotask(dispatchMeshBuild);
  return()=>{
    if(released)return;released=true;
    meshBuildQueue.delete(begin);
    if(granted)meshBuildOccupied=false;
    queueMicrotask(dispatchMeshBuild);
  };
}

function sharedMeshSource(request:MeshPreparation):boolean {
  const shared=(buffer:ArrayBufferLike)=>Object.prototype.toString.call(buffer)==='[object SharedArrayBuffer]';
  const fields=[request.shape,...(request.kind==='surface'&&request.mapping?[request.mapping]:[])];
  return fields.every(field=>shared(field.values.buffer)&&(field.validDomain?.kind!=='node-mask'||shared(field.validDomain.mask.buffer)));
}

function sameMeshSource(first: MeshPreparation, second: MeshPreparation) {
  if (first.kind === 'surface' && second.kind === 'surface')
    return first.shape === second.shape && first.mapping === second.mapping;
  return first.kind === 'amplitude' && second.kind === 'amplitude' && first.shape.values === second.shape.values &&
    first.shape.grid === second.shape.grid && first.shape.validDomain === second.shape.validDomain;
}

/** One worker and one retained source per visible layer. Only the latest
 * waiting appearance survives while the current mesh is being generated. */
export function createSurfaceMeshJob(topology: SurfaceMeshTopology, notify?: () => void) {
  let worker: Worker | undefined;
  let cooperative:AbortController|undefined;
  let releaseGrant:(()=>void)|undefined;
  let current: PendingMesh | undefined, running: PendingMesh | undefined, source: MeshPreparation | undefined;
  let nextId = 0;
  function releaseWorker(keepGrant=false) {
    const owned = worker;
    worker = undefined;
    running = undefined;
    source = undefined;
    owned?.terminate();
    cooperative?.abort();cooperative=undefined;
    if(!keepGrant){releaseGrant?.();releaseGrant=undefined;}
  }
  function cancel() {
    current = undefined;
    releaseWorker();
  }
  function unavailable(owned: Worker | undefined) {
    if (worker !== owned) return;
    releaseWorker(true);
    if(current)startCooperative(current);
  }
  function complete(job:PendingMesh,reply:MeshBuildReply) {
    if(running!==job)return;
    running=undefined;
    if(job!==current){releaseGrant?.();releaseGrant=undefined;dispatch();return;}
    if('error' in reply)job.error=reply.error;
    else job.value=reply.chunks;
    notify?.();
  }
  function startCooperative(job:PendingMesh) {
    const lease=new AbortController();cooperative=lease;running=job;
    void runRenderWork(preparePackedDisplayMeshWork(job.request,topology),lease.signal).then(chunks=>{
      if(!lease.signal.aborted)complete(job,{id:job.id,chunks});
    },error=>{
      if(!lease.signal.aborted)complete(job,{id:job.id,error:error instanceof Error?error.message:String(error)});
    }).finally(()=>{if(cooperative===lease)cooperative=undefined;});
  }
  function dispatch() {
    if (!current || running||releaseGrant) return;
    const job = current;
    running=job;
    releaseGrant=acquireMeshBuild(()=>build(job));
  }
  function build(job:PendingMesh) {
    if(job!==current){releaseGrant?.();releaseGrant=undefined;running=undefined;dispatch();return;}
    // A transferable copy of a full volume doubles its live scalar storage.
    // Borrow ordinary Float64 buffers in the cooperative path and send only
    // already shared backing stores to the parallel worker.
    if(typeof Worker!=='function'||!sharedMeshSource(job.request)){startCooperative(job);return;}
    try {
      if (!worker) {
        const owned = new Worker(new URL('./surface-mesh-worker.ts', import.meta.url), { type: 'module' });
        worker = owned;
        owned.onmessage = (event: MessageEvent<MeshBuildReply>) => {
          if (worker !== owned || !running || event.data.id !== running.id) return;
          complete(running,event.data);
        };
        owned.onerror = event => { event.preventDefault(); unavailable(owned); };
        owned.onmessageerror = () => unavailable(owned);
      }
      const packet = meshPacket(job.id, job.request, !source || !sameMeshSource(source, job.request));
      if (!source) packet.topology = { edgeTable2: topology.edgeTable2, triTable2: topology.triTable2 };
      worker.postMessage(packet);
      source = job.request;
    } catch {
      unavailable(worker);
    }
  }
  return {
    cancel,
    pending:()=>!!running,
    read(key: string, request: MeshPreparation): PackedChunk[] | undefined {
      if (!notify) return packDisplayMesh(prepareDisplayMesh(request, topology)).chunks;
      if (current?.key === key && sameMeshSource(current.request, request)) {
        if(current.error!==undefined||current.value!==undefined){releaseGrant?.();releaseGrant=undefined;}
        if (current.error !== undefined) throw new Error(current.error);
        const value = current.value;
        if (value !== undefined) current = undefined;
        return value;
      }
      if (source && !sameMeshSource(source, request)) releaseWorker();
      if(cooperative||releaseGrant&&!running)releaseWorker();
      const job: PendingMesh = { id: ++nextId, key, request };
      current = job;
      // Source buffers are cloned once, leaving the scientific result intact.
      dispatch();
      return undefined;
    },
  };
}
