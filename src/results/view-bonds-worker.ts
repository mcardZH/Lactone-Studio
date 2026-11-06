import {createViewBondSnapshot} from './view-bonds-core';
import type {Structure} from '../core/types';
globalThis.onmessage=(event:MessageEvent<{structure:Structure;index:number}>)=>{
  try{globalThis.postMessage({snapshot:createViewBondSnapshot(event.data.structure,event.data.index)});}
  catch(error){globalThis.postMessage({error:error instanceof Error?error.message:String(error)});}
};
