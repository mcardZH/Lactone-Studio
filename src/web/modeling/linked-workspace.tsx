import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createLinkedModels,type AtomReindexCandidates,type LinkedModels} from '../../modeling/application/linked-models';
import type {WorkspaceRegistry} from '../../modeling/workspace-registry';
import DialogShell from '../DialogShell';

interface NumberingPlan {documentId:string;label:string;revision:number;before:{id:string;element:string}[];result:AtomReindexCandidates;chosen:number}
/** UI state only; scientific transactions and history remain inside ModelStore. */
export function useLinkedWorkspace(registry:WorkspaceRegistry,activeId:string|undefined,canEdit:(id:string)=>boolean,onEnter:()=>void,onError:(message:string)=>void){
  const [group,setGroup]=useState<LinkedModels|null>(null),[selecting,setSelecting]=useState(false),[selected,setSelected]=useState<string[]>([]);
  const [swapping,setSwapping]=useState(false),[firstAtom,setFirstAtom]=useState<{documentId:string;atomId:string}|null>(null);
  const [preview,setPreview]=useState<{referenceId:string;plans:NumberingPlan[]}|null>(null);
  const workspace=useSyncExternalStore(registry.subscribe,registry.getSnapshot,registry.getSnapshot);
  useEffect(()=>{const restored=registry.adoptRestoredLinkedModels();if(restored){setGroup(restored);setSelecting(false);setSelected([]);setSwapping(false);setFirstAtom(null);setPreview(null);}},[registry,workspace.version]);
  const live=useRef({activeId,canEdit,onEnter,onError,group,swapping,firstAtom});live.current={activeId,canEdit,onEnter,onError,group,swapping,firstAtom};
  const subscribe=useCallback((listener:()=>void)=>group?.subscribe(listener)??(()=>{}),[group]);
  const getSnapshot=useCallback(()=>group?.getSnapshot()??null,[group]);
  const linked=useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  const documents=registry.getSnapshot().documents.filter(entry=>!entry.result);
  const signature=documents.map(entry=>entry.id).join('|');
  const clear=useCallback(()=>{live.current.group?.dispose();setGroup(null);setSelecting(false);setSelected([]);setSwapping(false);setFirstAtom(null);setPreview(null);},[]);
  useEffect(()=>()=>group?.dispose(),[group]);
  useEffect(()=>{if(group&&group.getSnapshot().documentIds.some(id=>!registry.getSnapshot().documents.some(entry=>entry.id===id)))clear();},[signature,group,registry,clear]);
  useEffect(()=>{setFirstAtom(null);},[activeId]);
  function start(ids:string[]){
    const reference=live.current.activeId;
    if(!reference||!ids.includes(reference))throw new Error('请把当前激活模型也选入关联组，作为初始参照。');
    const next=createLinkedModels(ids.map(id=>({store:registry.document(id).store,canEdit:()=>live.current.canEdit(id),isPresent:()=>registry.getSnapshot().documents.some(entry=>entry.id===id)})),reference);
    setGroup(next);setSelecting(false);setSelected([]);live.current.onEnter();
  }
  function toggle(){
    if(group||selecting){clear();return;}
    try{
      if(documents.length<2)throw new Error('请先打开至少两个不同的模型文档。');
      live.current.onEnter();
      if(documents.length===2)start(documents.map(entry=>entry.id));
      else{setSelected(activeId?[activeId]:[]);setSelecting(true);}
    }catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
  }
  function toggleMember(id:string){
    if(!selecting)return;
    const entry=registry.document(id);
    if(entry.result||!entry.store.getSnapshot().draft.structure.atoms.length){onError('只能关联含原子的可编辑模型。');return;}
    setSelected(previous=>previous.includes(id)?previous.filter(value=>value!==id):[...previous,id]);
  }
  function confirmMembers(){try{start(selected);onError('');}catch(cause){onError(cause instanceof Error?cause.message:String(cause));}}
  function beginRenumber(){
    if(!group||!activeId)return;
    try{
      if(!group.getSnapshot().documentIds.includes(activeId))throw new Error('请激活关联组内的参照模型。');
      const plans=group.getSnapshot().documentIds.map(id=>{
        const entry=registry.document(id),snapshot=entry.store.getSnapshot(),before=snapshot.draft.structure.atoms.map(atom=>({id:atom.id!,element:atom.element}));
        const result=id===activeId?{candidates:[{atomIds:before.map(atom=>atom.id),rmsd:0,needsConfirmation:true as const}],truncated:false,searchedNodes:0,reason:'当前参照模型，不改变编号。'}:group.candidates(activeId,id);
        return{documentId:id,label:entry.label,revision:snapshot.revision,before,result,chosen:0};
      });
      setSwapping(false);setFirstAtom(null);setPreview({referenceId:activeId,plans});
    }catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
  }
  function applyRenumber(){
    if(!preview||!group)return;
    try{
      const plans=preview.plans.map(plan=>{const candidate=plan.result.candidates[plan.chosen];if(!candidate)throw new Error(`${plan.label}没有可确认的完整映射。`);return{documentId:plan.documentId,atomIds:candidate.atomIds,expectedRevision:plan.revision};});
      group.reindexMany(plans,preview.referenceId);setPreview(null);setFirstAtom(null);onError('');
    }catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
  }
  function pickAtom(documentId:string,atomId:string){
    const own=live.current;if(!own.group||!own.swapping||!own.group.getSnapshot().documentIds.includes(documentId))return;
    if(!own.firstAtom||own.firstAtom.documentId!==documentId){setFirstAtom({documentId,atomId});return;}
    if(own.firstAtom.atomId===atomId){setFirstAtom(null);return;}
    try{own.group.swapAtomNumbers(documentId,own.firstAtom.atomId,atomId);setFirstAtom(null);own.onError('');}
    catch(cause){own.onError(cause instanceof Error?cause.message:String(cause));setFirstAtom(null);}
  }
  const actions=<div className="linked-atom-controls" data-testid="linked-atom-controls">
    <button type="button" aria-pressed={Boolean(group||selecting)} onClick={toggle}>{group||selecting?'取消关联':'关联原子'}</button>
    {selecting&&<><span>点击模型框或标签选择成员（{selected.length}）</span><button type="button" disabled={selected.length<2} onClick={confirmMembers}>确认关联</button></>}
    {group&&<><button type="button" onClick={beginRenumber}>重新编号</button><button type="button" aria-pressed={swapping} onClick={()=>{setSwapping(value=>!value);setFirstAtom(null);}}>{swapping?'结束交换编号':'交换编号'}</button>
      {linked?.status==='needs-alignment'&&<button type="button" onClick={()=>{try{group.align(activeId??'');onError('');}catch(cause){onError(cause instanceof Error?cause.message:String(cause));}}}>确认编号关联</button>}
      <span role="status">{swapping?firstAtom?'已选第一个原子，再点同一模型中的第二个原子交换编号。':'依次点击同一模型的两个原子；只换编号，不移动坐标。':linked?.status==='active'?`已关联 ${linked.documentIds.length} 个模型`:linked?.reason}</span>
    </>}
  </div>;
  const dialog=preview&&<DialogShell className="modal atom-reindex-dialog" backdropClassName="modal-backdrop" aria-label="确认原子重新编号" onCancel={()=>setPreview(null)}><h2>以当前模型为参照重新编号</h2><p>只改变编号，不移动坐标。对称原子的方案按刚体对齐后 RMSD 排序；请核对反应原子身份。</p>
    {preview.plans.filter(plan=>plan.documentId!==preview.referenceId).map(plan=><section key={plan.documentId}><h3>{plan.label}</h3><p>{plan.result.reason}</p>{plan.result.candidates.length>0&&<><label>映射方案<select aria-label={`${plan.label}编号方案`} value={plan.chosen} onChange={event=>setPreview(previous=>previous?{...previous,plans:previous.plans.map(item=>item.documentId===plan.documentId?{...item,chosen:Number(event.target.value)}:item)}:null)}>{plan.result.candidates.map((candidate,index)=><option key={index} value={index}>方案 {index+1} · RMSD {candidate.rmsd.toFixed(4)} Å</option>)}</select></label><div className="atom-reindex-pairs">{plan.result.candidates[plan.chosen].atomIds.map((id,index)=>{const old=plan.before.findIndex(atom=>atom.id===id);return <span key={id}>{plan.before[old].element}{old+1} → {index+1}</span>;})}</div></>}</section>)}
    <div className="modal-buttons"><button onClick={()=>setPreview(null)}>取消</button><button disabled={preview.plans.some(plan=>!plan.result.candidates.length)} onClick={applyRenumber}>确认并应用编号</button></div></DialogShell>;
  return{linked,selecting,selected,swapping,firstAtom,actions,dialog,toggleMember,pickAtom,clear};
}
