import type {Atom,Bond,Structure} from '../../../core/types';
import {createPeriodicBondGlyphCore,periodicBondGlyphContext,periodicBondGlyphTopology,periodicGlyphRequired,type BondGlyphPrimitive} from './periodic-bond-glyph-core';
export {periodicBondGlyphContext,periodicBondGlyphTopology,periodicGlyphRequired} from './periodic-bond-glyph-core';
export type {NativeBondPrimitive,BondGlyphPrimitive} from './periodic-bond-glyph-core';
/** Adapter-owned reusable CPU worker. Abort rejects one batch without destroying
 * its topology or any published geometry; actual worker release belongs to dispose. */
export function createPeriodicBondGlyphExporter(mol:any){
 const native=createPeriodicBondGlyphCore(mol);let disposed=false,worker:Worker|null=null,serial=0,contextKey='',workerContextKey='',registrationSerial=0;
 let cached:{structure:Structure;positions:readonly Atom[];styles:readonly any[];expanded:boolean;rows:Map<number,{unclipped:boolean;primitives:BondGlyphPrimitive[]}>}|null=null;
 let local:{key:string;structure:Structure;styles:readonly any[];prepared:Map<number,ReturnType<typeof periodicBondGlyphContext>>}|null=null;
 const pending=new Map<number,{resolve(rows:any[]):void;reject(error:unknown):void}>();
 const counters={registrations:0,batches:0,bonds:0,workerStarts:0,workerStops:0,cancellations:0,adjacencyBuilds:0};
 const topologyKey=(structure:Structure,styles:readonly any[])=>JSON.stringify([structure.atoms.map(a=>[a.id,a.element]),structure.bonds,structure.cell,styles]);
 const fail=(error:unknown)=>{for(const request of pending.values())request.reject(error);pending.clear();};
 function ownedWorker(){
   if(!worker){worker=new Worker(new URL('./periodic-glyph-worker.ts',import.meta.url),{type:'module'});counters.workerStarts++;
     worker.onmessage=event=>{const value=event.data;if(value.kind==='registration-error'){if(value.key===workerContextKey)fail(new Error(value.error));return;}const request=pending.get(value.requestId);if(!request)return;pending.delete(value.requestId);if(value.error)request.reject(new Error(value.error));else if(Array.isArray(value.rows))request.resolve(value.rows);else request.reject(new Error('周期键显示准备返回无效。'));};
     worker.onerror=event=>{fail(new Error(event.message||'周期键显示worker失败。'));worker?.terminate();counters.workerStops++;worker=null;contextKey='';};
   }return worker;
 }
 return {
    async prepareBatchAsync(structure:Structure,positions:readonly Atom[],styles:readonly any[],expanded:boolean,signal?:AbortSignal){
      if(disposed||signal?.aborted)throw new DOMException('周期键显示准备已取消。','AbortError');
      if(!(structure.bonds??[]).some(bond=>periodicGlyphRequired(structure,bond)))return;
      if(cached?.structure===structure&&cached.positions===positions&&cached.styles===styles&&cached.expanded===expanded)return;
      const owned=ownedWorker(),key=topologyKey(structure,styles),requestId=++serial;
      if(key!==contextKey){contextKey=key;workerContextKey='glyph:'+ ++registrationSerial;counters.registrations++;counters.adjacencyBuilds++;owned.postMessage({kind:'register',key:workerContextKey,structure,styles});}
      const registeredKey=workerContextKey;
      counters.batches++;
      let abort:()=>void=()=>{};
      try{
        const rows=await new Promise<any[]>((resolve,reject)=>{
          pending.set(requestId,{resolve,reject});
          abort=()=>{if(!pending.delete(requestId))return;counters.cancellations++;owned.postMessage({kind:'cancel',requestId});reject(new DOMException('周期键显示准备已取消。','AbortError'));};
          signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
          // Structured cloning freezes a consistent sample at submission.
          owned.postMessage({kind:'batch',key:registeredKey,requestId,positions,expanded});
        });
        if(disposed||signal?.aborted)throw new DOMException('周期键显示准备已取消。','AbortError');
        counters.bonds+=rows.length;cached={structure,positions,styles,expanded,rows:new Map(rows.map(row=>[row.index,row]))};
      }finally{signal?.removeEventListener('abort',abort);pending.delete(requestId);}
    },
    async prepareAsync(structure:Structure,_bond:Bond,positions:readonly Atom[],styles:readonly any[],expanded:boolean,signal?:AbortSignal){return this.prepareBatchAsync(structure,positions,styles,expanded,signal);},
    export(structure:Structure,bond:Bond,positions:readonly Atom[],styles:readonly any[],representation:'stick'|'line'='stick',prepared?:ReturnType<typeof periodicBondGlyphContext>,unclipped=false):BondGlyphPrimitive[]{
      if(disposed)throw new Error('周期键glyph导出器已关闭。');
      const index=structure.bonds?.indexOf(bond)??-1,row=cached?.structure===structure&&cached.positions===positions&&cached.styles===styles?cached.rows.get(index):undefined;
      if(row&&row.unclipped===unclipped&&representation==='stick')return row.primitives;
      if(!prepared){if(local?.structure!==structure||local.styles!==styles){const key=topologyKey(structure,styles);if(local?.key!==key){const adjacency=periodicBondGlyphTopology(structure),contexts=new Map<number,ReturnType<typeof periodicBondGlyphContext>>();counters.adjacencyBuilds++;for(const [i,edge]of(structure.bonds??[]).entries())if(periodicGlyphRequired(structure,edge))contexts.set(i,periodicBondGlyphContext(structure,edge,positions,adjacency));local={key,structure,styles,prepared:contexts};}else{local.structure=structure;local.styles=styles;}}prepared=local.prepared.get(index);}
      return native.export(structure,bond,positions,styles,representation,prepared,unclipped);
    },
    diagnostics:()=>({...counters,pending:pending.size}),
    dispose(){if(disposed)return;disposed=true;fail(new DOMException('周期键显示owner已关闭。','AbortError'));if(worker){worker.terminate();counters.workerStops++;}worker=null;cached=null;local=null;native.dispose();},
 };
}
