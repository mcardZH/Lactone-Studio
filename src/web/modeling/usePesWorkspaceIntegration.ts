import {useEffect,useRef,useState} from 'react';
import {desktopBridge} from '../../modeling/platform/desktop';
import {PES_SCHEMA,type PesGeometry,type PesGroup,type PesNode,type PesProjectSnapshot} from '../../modeling/pes/contracts';
import {PesController} from '../../modeling/pes/controller';
import {protectedPesDocument,type WorkspaceDocumentEntry,type WorkspacePesGroup,type WorkspaceRegistry} from '../../modeling/workspace-registry';
import type {WorkspacePesAsset} from '../../projects/workspace-snapshot';
import type {SharedModelConstraints} from '../../core/modeling/contracts';
import type {Structure} from '../../core/types';
import type {ModelCommand,ModelDocument,ModelSelection} from '../../modeling/contracts';
import {isFrameBondCommand} from '../../core/modeling/frame-bond-overrides';
import {modelCoordinateKey} from '../../modeling/constraints';
import type {WorkspaceCommand} from '../../modeling/workspace-contracts';
import {frameBondTargetCurrent,type WorkspaceViewportEvent,type WorkspaceViewportState} from './workspace-viewport';

type SavedPesDocuments=Record<string,WorkspacePesGroup&{documentId:string}>;
type PendingPes={asset:WorkspacePesAsset;read():Promise<PesProjectSnapshot|undefined>;pending?:Promise<void>};
const empty=():PesProjectSnapshot=>({schema:PES_SCHEMA,groups:[]});
const live=new Set(['starting','running','stopping']);
export const pesRunActive=(group:PesGroup,nodeId?:string)=>Object.values(group.runs).some(run=>(!nodeId||run.nodeId===nodeId)&&live.has(run.status));
const text=(value:unknown):value is string=>typeof value==='string'&&Boolean(value.trim());
export const pesScientificModelKey=(structure:Structure)=>JSON.stringify([structure.atoms,structure.bonds,structure.cell,structure.dimension,structure.charge,structure.multiplicity,structure.preparation]);

/** The same reader owns a visible PES page in the task and modeling modules.
 * Tiled pages remain separate observers; only the task module owns its panels. */
export function pesReaderVisible(context:{module:string;section?:string|null;documentId:string;activeDocumentId?:string|null;displayedDocumentId?:string|null;deckMode:string;blocked:boolean}):boolean {
  if(context.blocked)return false;
  return context.module==='modeling'?(context.deckMode!=='single'||context.documentId===context.displayedDocumentId)
    :context.module==='advanced'&&context.section==='path'&&context.documentId===context.activeDocumentId;
}

export function pesWorkspaceBindings(entries:readonly WorkspaceDocumentEntry[]):SavedPesDocuments{
  return Object.fromEntries(entries.flatMap(entry=>entry.pesGroup?[[entry.pesGroup.nodeId,{...entry.pesGroup,documentId:entry.id}]]:[]));
}
export function restoredPesBindings(value:unknown,entries:readonly WorkspaceDocumentEntry[]):SavedPesDocuments{
  const ids=new Set(entries.filter(entry=>!entry.result&&!entry.conformerGroup&&!entry.trajectory).map(entry=>entry.id));
  const bindings:SavedPesDocuments={};
  if(!value||typeof value!=='object'||Array.isArray(value))return bindings;
  for(const [id,row] of Object.entries(value)){
    if(!row||typeof row!=='object'||row.nodeId!==id||!text(id)||!text(row.groupId)||!text(row.documentId)||!['initial','snapshot','result','workbench'].includes(row.kind)||!ids.delete(row.documentId))continue;
    bindings[id]={documentId:row.documentId,groupId:row.groupId,nodeId:id,kind:row.kind};
  }
  return bindings;
}
export function currentPesRegistryGeometry(entry:WorkspaceDocumentEntry,geometry:PesGeometry,projected=false):PesGeometry{
  const current=entry.store.getSnapshot();
  return {...geometry,documentId:entry.id,revision:current.revision,label:entry.label,structure:projected?geometry.structure:current.draft.structure};
}
/** A successful local OPT returns one geometry to its original editable Store. */
export function adoptPesOptimizationGeometry(registry:WorkspaceRegistry,context:{groupId:string;nodeId:string;source:PesGeometry;geometry:PesGeometry}):void{
  const {groupId,nodeId,source,geometry}=context;
  const entry=registry.getSnapshot().documents.find(row=>row.pesGroup?.groupId===groupId&&row.pesGroup.nodeId===nodeId);
  if(!entry||protectedPesDocument(entry))throw Error('优化所属编辑页面已关闭，结果未覆盖原结构。');
  const document=entry.store.getSnapshot();
  if(document.id!==source.documentId||document.revision!==source.revision)throw Error('优化期间原结构已变化，结果未覆盖当前结构。');
  const identity=(structure:Structure)=>JSON.stringify(structure.atoms.map(atom=>[atom.id,atom.element]));
  if(identity(document.draft.structure)!==identity(geometry.structure))throw Error('优化结果的原子身份或顺序改变，未覆盖原结构。');
  entry.store.execute({type:'replace-structure',structure:structuredClone(geometry.structure)});
}
/** Old OPT views become editable without discarding the last displayed geometry. */
export function restorePesEditableOptGeometry(registry:WorkspaceRegistry,before:PesProjectSnapshot,after:PesProjectSnapshot):void{
  for(const group of before.groups)for(const node of group.nodes){
    if(node.kind!=='initial'&&node.kind!=='workbench')continue;
    const run=group.runs[node.selection?.runId??''];
    if(run?.request.operation!=='opt'||run.status!=='completed'||run.error||!['completed','converged'].includes(run.result?.status??''))continue;
    const restored=after.groups.find(value=>value.id===group.id)?.nodes.find(value=>value.id===node.id);
    const entry=registry.getSnapshot().documents.find(value=>value.pesGroup?.groupId===group.id&&value.pesGroup.nodeId===node.id);
    if(!restored||!entry||protectedPesDocument(entry))continue;
    const current=entry.store.getSnapshot();
    if(pesScientificModelKey(current.draft.structure)!==pesScientificModelKey(node.geometry.structure)
      ||pesScientificModelKey(current.draft.structure)===pesScientificModelKey(restored.geometry.structure))continue;
    adoptPesOptimizationGeometry(registry,{groupId:group.id,nodeId:node.id,source:{documentId:entry.id,revision:current.revision,structure:current.draft.structure},geometry:restored.geometry});
  }
}
/** Published PES frames admit observation through the authoritative viewport. */
export interface PesFrameBondCommandContext {
  frameBondEditing?:WorkspaceViewportState['frameBondEditing'];
  projectionSerial?:number|null;
  selection?:ModelSelection;
}
export function assertPesWorkspaceCommandAllowed(entry:WorkspaceDocumentEntry,command:WorkspaceCommand,context?:PesFrameBondCommandContext):void{
  if(!protectedPesDocument(entry))return;
  const refuse=()=>{throw Error('势能面来源帧为只读，请先在工作台继续编辑。');};
  if(command.type!=='workspace.viewport-event')return refuse();
  const event=command.event as unknown as WorkspaceViewportEvent;
  const selection=context?.selection??entry.store.getSnapshot().selection;
  const frameEdit=()=>{
    const current=context?.frameBondEditing,target=event.frameBondTarget;
    return Boolean(current&&!current.blocked&&current.frameKey&&target&&frameBondTargetCurrent(current,context?.projectionSerial??undefined,event));
  };
  if(!event||event.type==='cell-editor'||event.type==='sampling-sphere')return refuse();
  if(event.type==='command'){
    if(frameEdit()&&isFrameBondCommand(event.command,selection))return;
    return refuse();
  }
  if(event.type==='object-delete'){
    if(frameEdit()&&['bond','auxiliary','port'].includes(event.pick.kind))return;
    return refuse();
  }
  if((event.type==='atom-state'||event.type==='object-state')&&event.action!=='select-add'&&event.action!=='select-remove')return refuse();
  if(event.type==='clear'&&event.kind==='frozen'||event.type==='marker-delete'&&event.marker?.kind!=='selection')return refuse();
  if(event.type==='key'&&!event.release){
    const key=event.key.toLowerCase();
    if((event.ctrlKey||event.metaKey)&&['z','y'].includes(key)){
      const redo=key==='y'||event.shiftKey===true;
      if(frameEdit()&&!event.altKey&&(redo?context?.frameBondEditing?.canRedo:context?.frameBondEditing?.canUndo))return;
      return refuse();
    }
    if(!event.ctrlKey&&!event.metaKey&&!event.altKey){
      if(['Delete','Backspace'].includes(event.key)){
        if(event.measurementRecordId||event.hover.kind==='coordinate'||event.marker?.kind==='selection')return;
        const pure=['bond','auxiliary','port'].includes(event.hover.kind)||event.hover.kind==='none'&&isFrameBondCommand({type:'delete-objects'},selection);
        if(pure&&frameEdit())return;
        return refuse();
      }
      if(['1','2','3','4','5'].includes(key)&&(event.hover.kind==='bond'||selection.atomIds.length===2)&&!frameEdit())return refuse();
    }
  }
}
export function applyPesConstraints(entry:WorkspaceDocumentEntry,constraints:SharedModelConstraints):SharedModelConstraints{
  if(protectedPesDocument(entry))return constraints;
  const current=entry.store.getSnapshot(),have=current.sharedConstraints,ids=new Set(current.draft.structure.atoms.map(atom=>atom.id));
  const frozenAtomIds=constraints.frozenAtomIds.filter(id=>ids.has(id)),coordinates=constraints.coordinates.filter(row=>row.atomIds.every(id=>ids.has(id)));
  const commands:ModelCommand[]=[];
  if(JSON.stringify(frozenAtomIds)!==JSON.stringify(have?.frozenAtomIds??[]))commands.push({type:'replace-shared-atom-freezes',atomIds:frozenAtomIds});
  if(JSON.stringify(coordinates)!==JSON.stringify(have?.coordinates??[]))commands.push({type:'replace-shared-coordinate-freezes',coordinates});
  if((constraints.enabled!==false)!==(have?.enabled!==false))commands.push({type:'set-shared-freezes-enabled',enabled:constraints.enabled!==false});
  if(commands.length){if(!entry.store.executeBatch)throw Error('当前模型不支持约束事务。');entry.store.executeBatch(commands);}
  const canonical=entry.store.getSnapshot().sharedConstraints;
  const byGeometry=new Map(canonical?.coordinates.map(row=>[modelCoordinateKey(row),row]));
  return {...constraints,canonical:canonical?.canonical??constraints.canonical,coordinates:constraints.coordinates.map(row=>{
    const matching=byGeometry.get(modelCoordinateKey(row));
    return matching?{...row,id:matching.id,objectId:matching.objectId}:row;
  })};
}

function groupConstraintsFromStore(model:ModelDocument,group:PesGroup):SharedModelConstraints{
  const shared=model.sharedConstraints!,ids=new Set(model.draft.structure.atoms.map(atom=>atom.id));
  return {...shared,
    frozenAtomIds:[...shared.frozenAtomIds,...group.constraints.frozenAtomIds.filter(id=>!ids.has(id))],
    coordinates:[...shared.coordinates,...group.constraints.coordinates.filter(row=>row.atomIds.some(id=>!ids.has(id)))],
  };
}
export async function settlePesWorkspaceRuns(controller:PesController,groupId:string,nodeId?:string){
  const read=()=>controller.getSnapshot().groups.find(group=>group.id===groupId);
  const group=read();if(!group)throw Error('势能面任务组已关闭。');
  const runs=Object.values(group.runs).filter(run=>(!nodeId||run.nodeId===nodeId)&&live.has(run.status));
  if(!runs.length)return;
  let unsubscribe=()=>{};
  const settled=new Promise<void>(resolve=>{
    const check=()=>{const group=read();if(!group||runs.every(run=>!live.has(group.runs[run.request.id]?.status)))resolve();};
    unsubscribe=controller.subscribe(check);check();
  });
  try{await Promise.all(runs.map(run=>controller.stop(groupId,run.request.id)));await settled;}
  finally{unsubscribe();}
}

export interface McpClosePesControllerPort {
  getSnapshot(): { groups: readonly PesGroup[] };
  removeNode(groupId: string, nodeId: string): void | Promise<void>;
  removeGroup(groupId: string): void | Promise<void>;
}

export interface McpCloseWorkspaceDocumentPorts<TImpact extends { documents: readonly { id: string; epoch: string }[] }> {
  registry: WorkspaceRegistry;
  guardClose(documentId: string, discardUnsaved: boolean): void;
  isClosing?(documentId: string): boolean;
  closePlainDocument(documentId: string, discardUnsaved: boolean): Promise<void>;
  readLatestError?: () => string;
  pes: {
    controller: McpClosePesControllerPort | null | undefined;
    ensure(): Promise<void>;
    isDeleting(): boolean;
    setDeleting(deleting: boolean): void;
    buildDiscardImpact(documentId: string, wholeGroup: boolean): Promise<TImpact>;
    executeDiscard(impact: TImpact): Promise<void>;
    onGroupRemoved?(groupId: string): void;
    onCloseSettled?(groupId: string, nodeId?: string): void;
  };
}

const MCP_CLOSE_BUSY_TOKENS = ['运行', '任务', '仍在计算', '仍在处理', '仍在读取', '仍在导出', '仍在读写', '仍有待处理', '正在关闭'] as const;

function mapMcpCloseError(error: unknown): Error {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('MCP_')) {
      return error instanceof Error ? error : Object.assign(new Error(String(error)), { code });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('未保存')) {
    return Object.assign(new Error(message), { code: 'MCP_DOCUMENT_UNSAVED' });
  }
  if (MCP_CLOSE_BUSY_TOKENS.some(token => message.includes(token))) {
    return Object.assign(new Error(message), { code: 'MCP_DOCUMENT_BUSY' });
  }
  return Object.assign(new Error(message), { code: 'MCP_DOCUMENT_CLOSE_FAILED' });
}

export async function closeWorkspaceDocumentForMcp<TImpact extends { documents: readonly { id: string; epoch: string }[] }>(
  id: string,
  discard: boolean,
  ports: McpCloseWorkspaceDocumentPorts<TImpact>
): Promise<void> {
  const before = ports.registry.getSnapshot().documents.find(entry => entry.id === id);
  if (!before) {
    throw Object.assign(new Error(`Document not found: ${id}`), { code: 'MCP_DOCUMENT_NOT_FOUND' });
  }

  const assertCloseableEntries = (entries: readonly WorkspaceDocumentEntry[]) => {
    for (const entry of entries) {
      if (ports.isClosing?.(entry.id)) {
        throw Object.assign(new Error('文档正在关闭，请稍后重试。'), { code: 'MCP_DOCUMENT_BUSY' });
      }
      const isProtectedPes = protectedPesDocument(entry);
      if (!discard && !isProtectedPes) {
        const snap = entry.store.getSnapshot();
        if (snap.draft.dirty || entry.inputDirty?.gaussian || entry.inputDirty?.orca) {
          throw Object.assign(
            new Error(`Document "${entry.label}" (${entry.id}) has unsaved modifications. Pass discardUnsaved: true to force close.`),
            { code: 'MCP_DOCUMENT_UNSAVED' }
          );
        }
      }
      try {
        ports.guardClose(entry.id, discard || isProtectedPes);
      } catch (error) {
        throw mapMcpCloseError(error);
      }
    }
  };

  if (before.pesGroup) {
    if (ports.pes.isDeleting()) {
      throw Object.assign(new Error('势能面正在关闭，请稍后重试。'), { code: 'MCP_DOCUMENT_BUSY' });
    }
    const controller = ports.pes.controller;
    if (!controller) {
      throw Object.assign(new Error('势能面控制器尚未就绪，无法关闭势能面标签。'), { code: 'MCP_DOCUMENT_CLOSE_FAILED' });
    }
    ports.pes.setDeleting(true);
    try {
      try {
        await ports.pes.ensure();
      } catch (error) {
        throw mapMcpCloseError(error);
      }
      const verified = ports.registry.getSnapshot().documents.find(entry => entry.id === id && entry.epoch === before.epoch);
      if (!verified?.pesGroup) {
        throw Object.assign(new Error('势能面标签已变化，请重新选择。'), { code: 'MCP_DOCUMENT_CLOSE_FAILED' });
      }
      const groupId = verified.pesGroup.groupId;
      const nodeId = verified.pesGroup.kind === 'initial' ? undefined : verified.pesGroup.nodeId;
      const readGroup = () => controller.getSnapshot().groups.find(group => group.id === groupId);
      const initialGroup = readGroup();
      if (!initialGroup) {
        throw Object.assign(new Error('势能面任务组已变化，请重新选择。'), { code: 'MCP_DOCUMENT_CLOSE_FAILED' });
      }
      if (pesRunActive(initialGroup, nodeId)) {
        throw Object.assign(new Error('该势能面仍有计算任务正在运行，请先停止后再关闭。'), { code: 'MCP_DOCUMENT_BUSY' });
      }
      const entries = ports.registry.getSnapshot().documents.filter(
        entry => entry.pesGroup?.groupId === groupId && (!nodeId || entry.pesGroup.nodeId === nodeId)
      );
      if (!entries.length) {
        throw Object.assign(new Error('势能面标签已变化，请重新选择。'), { code: 'MCP_DOCUMENT_CLOSE_FAILED' });
      }
      assertCloseableEntries(entries);
      let impact: TImpact;
      try {
        impact = await ports.pes.buildDiscardImpact(entries[0].id, !nodeId);
      } catch (error) {
        throw mapMcpCloseError(error);
      }
      const impactKeys = new Set(impact.documents.map(doc => `${doc.id}\0${doc.epoch}`));
      assertCloseableEntries(
        ports.registry.getSnapshot().documents.filter(entry => impactKeys.has(`${entry.id}\0${entry.epoch}`))
      );
      const latestGroup = readGroup();
      if (!latestGroup) {
        throw Object.assign(new Error('势能面任务组已变化，请重新选择。'), { code: 'MCP_DOCUMENT_CLOSE_FAILED' });
      }
      if (pesRunActive(latestGroup, nodeId)) {
        throw Object.assign(new Error('该势能面仍有计算任务正在运行，请先停止后再关闭。'), { code: 'MCP_DOCUMENT_BUSY' });
      }
      if (impact.documents.some(doc => ports.isClosing?.(doc.id))) {
        throw Object.assign(new Error('文档正在关闭，请稍后重试。'), { code: 'MCP_DOCUMENT_BUSY' });
      }
      await ports.pes.executeDiscard(impact);
      const entryKeys = new Set(entries.map(target => `${target.id}\0${target.epoch}`));
      const remaining = ports.registry.getSnapshot().documents;
      if (
        remaining.some(row => {
          const rowKey = `${row.id}\0${row.epoch}`;
          return entryKeys.has(rowKey) || impactKeys.has(rowKey);
        })
      ) {
        const latestError = ports.readLatestError?.();
        if (latestError) {
          throw mapMcpCloseError(new Error(latestError));
        }
        throw Object.assign(
          new Error(`Failed to close PES document "${before.label}" (${id})`),
          { code: 'MCP_DOCUMENT_CLOSE_FAILED' }
        );
      }
      if (nodeId) {
        await controller.removeNode(groupId, nodeId);
      } else {
        await controller.removeGroup(groupId);
        ports.pes.onGroupRemoved?.(groupId);
      }
      ports.pes.onCloseSettled?.(groupId, nodeId);
    } finally {
      ports.pes.setDeleting(false);
    }
    return;
  }

  if (ports.isClosing?.(id)) {
    throw Object.assign(new Error('文档正在关闭，请稍后重试。'), { code: 'MCP_DOCUMENT_BUSY' });
  }
  try {
    ports.guardClose(id, discard);
  } catch (error) {
    throw mapMcpCloseError(error);
  }
  await ports.closePlainDocument(id, discard);
  if (ports.registry.getSnapshot().documents.some(entry => entry.id === id && entry.epoch === before.epoch)) {
    const latestError = ports.readLatestError?.();
    if (latestError) {
      throw mapMcpCloseError(new Error(latestError));
    }
    throw Object.assign(
      new Error(`Failed to close document "${before.label}" (${id})`),
      { code: 'MCP_DOCUMENT_CLOSE_FAILED' }
    );
  }
}

export function usePesWorkspaceIntegration(registry:WorkspaceRegistry,onError:(error:string)=>void,mayFollow:()=>boolean){
  const [controller,setController]=useState<PesController|null>(null);
  const [revision,bump]=useState(0),[loaded,bumpLoad]=useState(0);
  const persistentRevision=useRef(0);
  const owner=useRef<PesController|null>(null),pending=useRef<PendingPes|null>(null),retained=useRef<WorkspacePesAsset|undefined>(undefined),restoring=useRef(false);
  const follow=useRef(mayFollow);follow.current=mayFollow;
  const observed=useRef(new WeakMap<WorkspaceDocumentEntry['store'],ModelDocument>());
  const constraintProjection=useRef(false);
  const initialOwner=useRef<WorkspaceDocumentEntry|undefined>(undefined);

  function createInitialGroup(initial:PesGeometry, constraints:SharedModelConstraints|undefined, existing?:WorkspaceDocumentEntry) {
    const current=owner.current;
    if(!current)throw Error('势能面工作台尚未就绪。');
    initialOwner.current=existing;
    try{return current.createGroup(initial,undefined,{constraints,initialName:existing?.labelOrigin==='manual'?existing.label:undefined});}
    finally{initialOwner.current=undefined;}
  }

  function register(groupId:string,node:PesNode):WorkspaceDocumentEntry {
    const existing=registry.getSnapshot().documents.find(row=>row.pesGroup?.nodeId===node.id&&row.pesGroup.groupId===groupId&&row.pesGroup.kind===node.kind);
    if(existing)return existing;
    const reuse=initialOwner.current;
    if(reuse&&node.kind==='initial'&&reuse.id===node.geometry.documentId&&!reuse.pesGroup){
      const binding={groupId,nodeId:node.id,kind:node.kind};
      registry.bindPesDocument(reuse.id,binding);
      if(reuse.labelOrigin!=='manual')registry.namePesInitial(reuse.id,node.name);
      return registry.document(reuse.id);
    }
    return registry.addPesDocument(node.geometry.structure,node.name,{groupId,nodeId:node.id,kind:node.kind});
  }
  function reconcile(current:PesController){
    for(const group of current.getSnapshot().groups)for(const node of group.nodes)register(group.id,node);
  }
  function syncStore(current:PesController){
    if(restoring.current)return;
    const registryState=registry.getSnapshot();
    const active=registryState.views.find(view=>view.id===registryState.activeViewId)?.documentId;
    for(const entry of registryState.documents){
      const link=entry.pesGroup;
      if(!link||protectedPesDocument(entry))continue;
      // Registry publications replace the entry wrapper, while its Store owns the document history.
      const model=entry.store.getSnapshot(),previous=observed.current.get(entry.store);
      if(previous && previous.revision===model.revision &&
        previous.draft.structure.charge===model.draft.structure.charge && previous.draft.structure.multiplicity===model.draft.structure.multiplicity)continue;
      const group=current.getSnapshot().groups.find(row=>row.id===link.groupId),node=group?.nodes.find(row=>row.id===link.nodeId);
      if(!group||!node)continue;
      observed.current.set(entry.store,model);
      if(!previous)continue;
      const previousStructure=previous.draft.structure,structure=model.draft.structure;
      if(pesScientificModelKey(previousStructure)!==pesScientificModelKey(structure)){
        const ids=new Set(structure.atoms.map(atom=>atom.id));
        current.updateNodeGeometry(group.id,node.id,{...node.geometry,documentId:entry.id,revision:model.revision,structure},{
          removedAtomIds:previousStructure.atoms.flatMap(atom=>atom.id&&!ids.has(atom.id)?[atom.id]:[]),
          electronicChanged:previousStructure.charge!==structure.charge||previousStructure.multiplicity!==structure.multiplicity,
          electronicConfirmed:model.electronicStateConfirmed===true,
        });
      }
      if(active===entry.id&&!constraintProjection.current&&model.sharedConstraints&&model.sharedConstraints!==previous.sharedConstraints){
        const liveGroup=current.getSnapshot().groups.find(row=>row.id===link.groupId);
        if(!liveGroup)continue;
        const constraints=groupConstraintsFromStore(model,liveGroup);
        if(JSON.stringify(constraints)!==JSON.stringify(liveGroup.constraints))current.updateConstraints(group.id,constraints);
      }
    }
  }
  useEffect(()=>{
    const desktop=desktopBridge();
    const bridge=desktop?.startPes&&desktop.stopPes&&desktop.onPesEvent?{startPes:desktop.startPes.bind(desktop),stopPes:desktop.stopPes.bind(desktop),onPesEvent:desktop.onPesEvent.bind(desktop),
      readPesPathRecord:desktop.readPesPathRecord?.bind(desktop),releasePesPathRecords:desktop.releasePesPathRecords?.bind(desktop)}:undefined;
    const current=new PesController(bridge,undefined,{onPathSourceReleaseError:onError,submittingDocument:()=>JSON.stringify([registry.stamp().documentId,registry.stamp().activationEpoch]),
    onOptimizationGeometry(context){adoptPesOptimizationGeometry(registry,context);},canFollowWorkbench(groupId,nodeId){
      const state=registry.getSnapshot(),id=state.views.find(view=>view.id===state.activeViewId)?.documentId;
      const binding=state.documents.find(entry=>entry.id===id)?.pesGroup;
      return follow.current()&&state.module==='advanced'&&binding?.groupId===groupId&&binding.nodeId===nodeId;
    }});owner.current=current;setController(current);
    const persistent=current.subscribePersistence(()=>{
      try{reconcile(current);if(!restoring.current)bump(++persistentRevision.current);}
      catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
    });
    const documents=registry.subscribe(()=>syncStore(current));
    return()=>{persistent();documents();current.dispose();if(owner.current===current)owner.current=null;};
  },[registry,onError]);

  function restore(asset:WorkspacePesAsset|undefined,read:PendingPes['read'],bindings:unknown){
    restoring.current=true;
    try{
      pending.current=asset?{asset,read}:null;retained.current=asset;
      owner.current?.importSnapshot(empty());observed.current=new WeakMap();
      if(asset)for(const binding of Object.values(restoredPesBindings(bindings,registry.getSnapshot().documents)))registry.bindPesDocument(binding.documentId,binding);
      for(const entry of registry.getSnapshot().documents){
        if(entry.pesGroup&&!protectedPesDocument(entry))observed.current.set(entry.store,entry.store.getSnapshot());
      }
      bumpLoad(value=>value+1);
    }finally{restoring.current=false;}
  }
  async function ensure(){
    const target=pending.current,current=owner.current;
    if(!target)return;
    if(!current)throw Error('势能面工作区正在准备，请稍后重试。');
    if(target.pending)return target.pending;
    target.pending=(async()=>{
      const snapshot=await target.read();
      if(pending.current!==target||owner.current!==current)throw Error('项目已切换，未恢复旧势能面数据。');
      restoring.current=true;
      try{
        if(snapshot){
          for(const binding of Object.values(pesWorkspaceBindings(registry.getSnapshot().documents))){
            if(!snapshot.groups.some(group=>group.id===binding.groupId&&group.nodes.some(node=>node.id===binding.nodeId&&node.kind===binding.kind)))throw Error('势能面标签和来源资产身份不一致。');
          }
          current.importSnapshot(snapshot);
          restorePesEditableOptGeometry(registry,snapshot,current.getSnapshot());
        }
        pending.current=null;bumpLoad(value=>value+1);
      }finally{restoring.current=false;}
      syncStore(current);
    })();
    try{await target.pending;}finally{target.pending=undefined;}
  }
  function projectConstraints(entry:WorkspaceDocumentEntry,constraints:SharedModelConstraints){
    constraintProjection.current=true;
    try{return applyPesConstraints(entry,constraints);}finally{constraintProjection.current=false;}
  }
  return {controller,revision,readRevision:()=>persistentRevision.current,loaded,pending,restore,ensure,register,createInitialGroup,projectConstraints,
    capture:()=>({pes:pending.current?undefined:owner.current?.exportSnapshot(),retainedPes:retained.current}),
    citationSnapshot:()=>pending.current?pending.current.read():Promise.resolve(owner.current?.exportSnapshot()),
  };
}
