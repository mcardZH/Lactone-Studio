import type { ModelDocument, ModelSelection } from '../../core/modeling/contracts';
import type { FrameBondOverrides } from '../../core/modeling/frame-bond-overrides';
import type { Bond, Structure } from '../../core/types';
import type { createWorkspaceRegistry } from '../../modeling/workspace-registry';

type Registry = ReturnType<typeof createWorkspaceRegistry>;
export type WorkspaceChange = {cursor:number;kind:string;target:string;revision?:number;version?:string;fields?:readonly string[];run?:Readonly<Omit<WorkspaceRunChange,'runId'>>};
export interface WorkspaceChangeFilter {target?:string;kinds?:readonly string[]}
export interface WorkspaceRunChange {runId:string;status:string;phase?:string;version?:string}

const matches = (change: WorkspaceChange, filter?: WorkspaceChangeFilter) =>
  (filter?.target === undefined || change.target === filter.target) &&
  (filter?.kinds === undefined || filter.kinds.includes(change.kind));

export class WorkspaceChanges {
  private cursor=0;
  private events:WorkspaceChange[]=[];
  private listeners=new Set<(change:WorkspaceChange)=>void>();
  record(change:Omit<WorkspaceChange,'cursor'>) {
    const event=Object.freeze({...change,cursor:++this.cursor,...(change.fields?{fields:Object.freeze([...change.fields])}:{})});
    this.events.push(event);
    if (this.events.length>1024) this.events.splice(0,256);
    for (const listener of this.listeners) listener(event);
  }
  private needsRefresh(since:number) {
    const first=this.events[0]?.cursor??this.cursor+1;
    return !Number.isSafeInteger(since)||since<first-1||since>this.cursor;
  }
  read(since?:number,filter?:WorkspaceChangeFilter) {
    const refresh=since!==undefined&&this.needsRefresh(since);
    return {cursor:this.cursor,refresh,changes:since===undefined||refresh?[]:this.events.filter(event=>event.cursor>since&&matches(event,filter))};
  }
  async wait(since:number,ms:number,signal?:AbortSignal,filter?:WorkspaceChangeFilter) {
    signal?.throwIfAborted();
    if(ms<=0||this.needsRefresh(since)||this.events.some(event=>event.cursor>since&&matches(event,filter)))return;
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.listeners.delete(onChange);signal?.removeEventListener('abort',abort);};
      const done=()=>{cleanup();resolve();};
      const abort=()=>{cleanup();reject(signal?.reason);};
      const onChange=(event:WorkspaceChange)=>{if(matches(event,filter)||this.needsRefresh(since))done();};
      const timer=setTimeout(done,ms);
      this.listeners.add(onChange);signal?.addEventListener('abort',abort,{once:true});
    });
  }
  /** Consume notice signals from actual run owners. A display or project
   * change may release the observer without affecting the underlying run. */
  followRuns(read:()=>Iterable<WorkspaceRunChange>,subscribe:(notify:()=>void)=>()=>void) {
    let previous=new Map<string,Omit<WorkspaceRunChange,'runId'>>();
    const sync=()=>{
      const current=new Map<string,Omit<WorkspaceRunChange,'runId'>>();
      for(const {runId,...run} of read()){
        const last=previous.get(runId), fields:string[]=[];
        if(last?.status!==run.status)fields.push('status');
        if(last?.phase!==run.phase)fields.push('phase');
        if(last?.version!==run.version)fields.push('progress');
        current.set(runId,run);
        if(fields.length)this.record({kind:'run',target:runId,version:run.version,fields,run:Object.freeze(run)});
      }
      previous=current;
    };
    const release=subscribe(sync);
    sync();
    return ()=>{release();previous.clear();};
  }
  follow(registry:Registry) {
    const subscriptions=new Map<string,{epoch:string;release:()=>void}>();
    let activation=-1;
    const sync=()=>{
      const state=registry.getSnapshot();
      for(const [id,sub] of subscriptions) if(!state.documents.some(doc=>doc.id===id&&doc.epoch===sub.epoch)){
        sub.release();subscriptions.delete(id);this.record({kind:'closed',target:id});
      }
      for(const entry of state.documents) {
        if(subscriptions.has(entry.id)) continue;
        let previous=entry.store.getSnapshot();
        const release=entry.store.subscribe(()=>{
          // A geometry gesture can publish a preview several times. Keep the
          // last committed snapshot until the native transaction settles.
          if(entry.store.hasTransaction?.())return;
          const next=entry.store.getSnapshot(), fields=modelChanges(previous,next);previous=next;
          if(fields.length) this.record({kind:'model',target:entry.id,revision:next.revision,fields});
        });
        subscriptions.set(entry.id,{epoch:entry.epoch,release});
        this.record({kind:'opened',target:entry.id,revision:previous.revision});
      }
      if(activation!==state.activationEpoch){
        activation=state.activationEpoch;this.record({kind:'view',target:state.activeViewId??''});
      }
    };
    sync();const unsubscribe=registry.subscribe(sync);
    return ()=>{unsubscribe();for(const sub of subscriptions.values())sub.release();};
  }
}

const sameValue = (before:unknown,after:unknown) => before===after||JSON.stringify(before)===JSON.stringify(after);

function sameSelection(before:ModelSelection,after:ModelSelection) {
  return before===after||sameValue(before.atomIds,after.atomIds)&&sameValue(before.bonds,after.bonds)&&
    sameValue(before.auxiliaryIds,after.auxiliaryIds)&&sameValue(before.portIds??[],after.portIds??[])&&
    sameValue(before.coordinateIds??[],after.coordinateIds??[]);
}

function atomChanges(before:Structure['atoms'],after:Structure['atoms']) {
  if(before===after)return {atoms:false,geometry:false};
  if(before.length!==after.length)return {atoms:true,geometry:true};
  let atoms=false,geometry=false;
  for(let i=0;i<before.length&&!(atoms&&geometry);i++){
    const a=before[i],b=after[i];
    if(a===b)continue;
    const reordered=a.id!==b.id;
    geometry ||= reordered||a.x!==b.x||a.y!==b.y||a.z!==b.z;
    atoms ||= reordered||a.element!==b.element||a.formalCharge!==b.formalCharge||a.stereoParity!==b.stereoParity||
      a.hydrogenMode!==b.hydrogenMode||a.aromaticHydrogen!==b.aromaticHydrogen||a.geometryPresetId!==b.geometryPresetId||
      a.sourceIndex!==b.sourceIndex;
  }
  return {atoms,geometry};
}

function sameBonds(before:Bond[]|undefined,after:Bond[]|undefined) {
  if(before===after)return true;
  if(!before||!after||before.length!==after.length)return false;
  return before.every((a,index)=>{
    const b=after[index];
    return a===b||a.a===b.a&&a.b===b.b&&a.order===b.order&&a.aromatic===b.aromatic&&a.stereo===b.stereo&&
      a.kind===b.kind&&a.orderKnown===b.orderKnown&&a.fractional===b.fractional&&a.perception===b.perception&&
      a.mbo===b.mbo&&sameValue(a.image,b.image);
  });
}

function sameFrameBonds(before?:FrameBondOverrides,after?:FrameBondOverrides) {
  if(before===after)return true;
  const previous=Object.keys(before??{}),next=Object.keys(after??{});
  return previous.length===next.length&&previous.every(key=>Boolean(after?.[key])&&
    sameValue(before![key].graph,after![key].graph));
}

function modelChanges(before:ModelDocument,after:ModelDocument) {
  const fields:string[]=[];
  const oldStructure=before.draft.structure,newStructure=after.draft.structure;
  const {atoms,geometry}=atomChanges(oldStructure.atoms,newStructure.atoms);
  const cell=!sameValue(oldStructure.cell,newStructure.cell)||!sameValue(oldStructure.periodicSource,newStructure.periodicSource);
  const bonds=!sameBonds(oldStructure.bonds,newStructure.bonds)||oldStructure.bondSource!==newStructure.bondSource||
    !sameValue(oldStructure.bondPerceptionIssues,newStructure.bondPerceptionIssues)||
    !sameValue(before.auxiliaryRelations,after.auxiliaryRelations)||!sameValue(before.deletedBonds,after.deletedBonds)||
    !sameFrameBonds(before.frameBondOverrides,after.frameBondOverrides);
  const electronic=before.electronicStateConfirmed!==after.electronicStateConfirmed||
    oldStructure.charge!==newStructure.charge||oldStructure.multiplicity!==newStructure.multiplicity;
  if(!sameSelection(before.selection,after.selection))fields.push('selection');
  if(atoms||geometry||cell||bonds||electronic||oldStructure.dimension!==newStructure.dimension)fields.push('structure');
  if(atoms)fields.push('atoms');
  if(geometry||cell||oldStructure.dimension!==newStructure.dimension)fields.push('geometry');
  if(cell)fields.push('cell');
  if(bonds)fields.push('bonds');
  if(!sameValue(before.attachmentPorts,after.attachmentPorts))fields.push('ports');
  if(!sameValue(before.coordinateObjects,after.coordinateObjects)||
    !sameValue(before.internalCoordinates,after.internalCoordinates)||
    !sameValue(before.gaussianBoundCoordinates,after.gaussianBoundCoordinates))fields.push('coordinates');
  const oldFreeze=before.sharedConstraints,newFreeze=after.sharedConstraints;
  if((oldFreeze?.enabled!==false)!==(newFreeze?.enabled!==false)||
    !sameValue(oldFreeze?.frozenAtomIds??[],newFreeze?.frozenAtomIds??[])||
    !sameValue(oldFreeze?.coordinates??[],newFreeze?.coordinates??[])||
    !sameValue(before.draft.assignments.frozenAtomIds,after.draft.assignments.frozenAtomIds))fields.push('constraints','freeze');
  if(electronic)fields.push('electronicState');
  if(before.revision!==after.revision)fields.push('revision');
  return fields;
}
