import {useMemo,useSyncExternalStore} from 'react';
import type {ModelStore} from '../modeling/contracts';
import {ProjectUiStore,useProjectUiScope} from '../projects/ui-state';
import {commitModelElectronicDraft,editModelElectronicDraft,flushModelElectronicDraft,modelElectronicDraftKey,modelElectronicDraftValues,readModelElectronicDraft,replaceModelElectronicDraft} from '../modeling/application/model-electronic-draft';
import type {ElectronicStateEditField} from '../core/base-electronic-state';
import type {Atom} from '../core/types';
const fallbacks=new WeakMap<ModelStore,ProjectUiStore>();
export function useModelElectronicDraft(store:ModelStore,initial?:{charge:number;multiplicity:number},atoms?:readonly Atom[]){
  const context=useProjectUiScope();
  const ui=useMemo(()=>{if(context)return context.store;let value=fallbacks.get(store);if(!value){value=new ProjectUiStore();fallbacks.set(store,value);}return value;},[context?.store,store]);
  const version=useSyncExternalStore(ui.subscribe,ui.getVersion,ui.getVersion);
  const document=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);
  const draft=useMemo(()=>readModelElectronicDraft(store,ui),[document,ui,version]);
  const generation=context?.generation??ui.getGeneration();
  return {draft,present:ui.has(modelElectronicDraftKey(document.id)),read:()=>readModelElectronicDraft(store,ui),has:()=>ui.has(modelElectronicDraftKey(store.getSnapshot().id)),values:modelElectronicDraftValues(draft),change:(field:'charge'|'multiplicity',text:string)=>{if(generation===ui.getGeneration())editModelElectronicDraft(store,ui,field,text,initial);},
    replace:(values:{charge:number;multiplicity:number},confirmed=false)=>{if(generation===ui.getGeneration())replaceModelElectronicDraft(store,ui,values,confirmed);},
    commit:(field?:ElectronicStateEditField,text?:string)=>generation===ui.getGeneration()?commitModelElectronicDraft(store,ui,field,text,atoms):null,
    flush:(confirmed=false)=>generation===ui.getGeneration()&&flushModelElectronicDraft(store,ui,confirmed)};
}
