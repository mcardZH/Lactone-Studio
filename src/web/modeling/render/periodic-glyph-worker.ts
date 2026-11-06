import './periodic-glyph-worker-env';
import * as mol from '3dmol';
import { createPeriodicBondGlyphCore, periodicBondGlyphContext, periodicBondGlyphTopology, periodicGlyphRequired } from './periodic-bond-glyph-core';
import type { Structure, Atom } from '../../../core/types';
const native = createPeriodicBondGlyphCore(mol);
let context: { key:string; structure:Structure; styles:any[]; prepared:Map<number,ReturnType<typeof periodicBondGlyphContext>> } | null = null;
let active = 0;
let registration=Promise.resolve(),registrationGeneration=0;
type Request = { kind:'register'; key:string; structure:Structure; styles:any[] }
  | { kind:'batch'; key:string; requestId:number; positions:Atom[]; expanded:boolean }
  | { kind:'cancel'; requestId:number };
globalThis.onmessage = async (event:MessageEvent<Request>) => {
  const request=event.data;
  if(request.kind==='cancel'){if(active===request.requestId)active=0;return;}
  if(request.kind==='register'){
    active=0;const generation=++registrationGeneration;
    registration=(async()=>{
    try {
      const adjacency=periodicBondGlyphTopology(request.structure),prepared=new Map<number,ReturnType<typeof periodicBondGlyphContext>>();
      let deadline=performance.now()+4;
      for(const [index,bond] of (request.structure.bonds??[]).entries()){
        if(generation!==registrationGeneration)return;
        if(periodicGlyphRequired(request.structure,bond))prepared.set(index,periodicBondGlyphContext(request.structure,bond,request.structure.atoms,adjacency));
        if(performance.now()>=deadline){await new Promise<void>(resolve=>setTimeout(resolve,0));deadline=performance.now()+4;}
      }
      context={key:request.key,structure:request.structure,styles:request.styles,prepared};
    } catch(error){if(generation===registrationGeneration){context=null;globalThis.postMessage({kind:'registration-error',key:request.key,error:error instanceof Error?error.message:String(error)});}}
    })();
    return;
  }
  active=request.requestId;await registration;if(active!==request.requestId)return;
  const owned=context;
  try {
    if(!owned||owned.key!==request.key)throw new Error('周期键显示拓扑上下文已失效。');
    const rows=[];let deadline=performance.now()+4;
    for(const [index,prepared] of owned.prepared){
      if(active!==request.requestId||context!==owned)return;
      const bond=owned.structure.bonds![index],unclipped=request.expanded||!!bond.image?.some(Boolean);
      rows.push({index,unclipped,primitives:native.export(owned.structure,bond,request.positions,owned.styles,'stick',prepared,unclipped)});
      if(performance.now()>=deadline){await new Promise<void>(resolve=>setTimeout(resolve,0));deadline=performance.now()+4;}
    }
    if(active===request.requestId&&context===owned)globalThis.postMessage({requestId:request.requestId,rows});
  } catch(error){if(active===request.requestId)globalThis.postMessage({requestId:request.requestId,error:error instanceof Error?error.message:String(error)});}
};
