import type { OrcaAsset, OrcaJobRequest, OrcaOutputFile, OrcaIssue } from '../../core/orca';

export interface OrcaGeneratedDraft {sourceSignature:string;files:OrcaOutputFile[];editedNames:string[];assets:OrcaAsset[];minimumVersion?:string;issues?:OrcaIssue[]}
export type OrcaGeneratedDrafts=Partial<Record<OrcaJobRequest['settings']['task'],OrcaGeneratedDraft>>;
export function orcaGeneratedSource(request:OrcaJobRequest):string {
  // Engine projection increments its local revision and adds display groups and
  // layers. Scientific memberships are retained in the engine settings; these
  // model presentation fields do not alter the captured writer request.
  const {revision:_revision,groups:_groups,modelLayers:_layers,layout2D:_layout,...structure}=request.structure??{};
  return JSON.stringify({...request,inputSources:undefined,structure:request.structure?structure:null},(_key,value)=>{
    // Object insertion order differs across ModelStore and engine projections.
    // Array order (including atoms), all numbers and scientific fields stay exact.
    return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value;
  });
}
export function editOrcaGeneratedFile(draft:OrcaGeneratedDraft,index:number,text:string):OrcaGeneratedDraft {
  const file=draft.files[index];
  if(!file||file.role!=='input'||!/\.inp$/i.test(file.name))return draft;
  return {...draft,files:draft.files.map((entry,i)=>i===index?{...entry,text}:entry),editedNames:[...new Set([...draft.editedNames,file.name])]};
}
