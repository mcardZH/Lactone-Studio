import { disposePostprocessAttachments, type PostprocessAttachment, type PostprocessDocument } from '../../results/postprocess-document';
import type { TrajectoryResult } from '../../results/contracts';
import type { WorkspaceDiscardTransaction } from '../workspace-contracts';

type Generated = Record<string,{document:PostprocessDocument;ownerId:string;bindingId:string}>;
interface Snapshot { documents:Record<string,PostprocessDocument>;generated:Generated }
const attachments=(document?:PostprocessDocument)=>(document?[document.output,document.wavefunction,...document.companions??[]]:[]).filter((item):item is PostprocessAttachment=>Boolean(item));
export interface PostprocessCloseSummary { id:string;revision:string;hasData:boolean;readOnlySource:true;sourceNames:readonly string[];hasWavefunction:boolean;hasOutput:boolean;generatedIds:readonly string[] }
export interface PreparedPostprocessClose extends WorkspaceDiscardTransaction { readonly ownerId:string;readonly summary:PostprocessCloseSummary }

/** Postprocess metadata retires synchronously with the registry/controller;
 * exact attachment/native leases stay owned here until actual release succeeds.
 * No user source path, export or saved-project asset is removed by this owner. */
export function createPostprocessRetirement(ports:{read():Snapshot;commit(snapshot:Snapshot):void;retire(id:string):void;closeNative(id:string):Promise<unknown>}){
  let serial=0;
  const pending=new Map<number,{id:string;sourceNames:readonly string[];issues:string[];release():Promise<void>}>(),nativeDone=new Set<string>(),nativeReleases=new Map<string,Promise<void>>();
  const resultReleases=new WeakMap<TrajectoryResult,{done:boolean;inflight?:Promise<void>}>();
  const owned=(snapshot:Snapshot,id:string)=>Object.entries(snapshot.generated).filter(([key,row])=>key===id||row.ownerId===id);
  function describeClose(id:string):PostprocessCloseSummary{
    const snapshot=ports.read(),value=snapshot.documents[id],generated=owned(snapshot,id),all=[value,...generated.map(([,row])=>row.document)].filter((item):item is PostprocessDocument=>Boolean(item));
    const identity=(document:PostprocessDocument)=>[document.id,document.result.id,...attachments(document).map(item=>[item.source.result.source,item.source.metadata?.sourceRevision,item.nativeSessionId])];
    const revision=JSON.stringify([value?identity(value):null,generated.map(([key,row])=>[key,row.ownerId,row.bindingId,identity(row.document)])]);
    return Object.freeze({id,revision,hasData:all.length>0,readOnlySource:true,sourceNames:Object.freeze([...new Set(all.flatMap(document=>attachments(document).map(item=>item.source.result.source.name)))]),hasWavefunction:all.some(document=>Boolean(document.wavefunction)),hasOutput:all.some(document=>Boolean(document.output)),generatedIds:Object.freeze(generated.map(([key])=>key))});
  }
  function releaseResult(result:TrajectoryResult){
    let state=resultReleases.get(result);if(!state){state={done:false};resultReleases.set(result,state);}const owned=state;
    if(owned.done)return;if(owned.inflight)return owned.inflight;
    owned.inflight=Promise.resolve().then(()=>result.dispose()).then(()=>{owned.done=true;}).finally(()=>{owned.inflight=undefined;});return owned.inflight;
  }
  function releaseNative(sessionId:string):Promise<void>{
    if(nativeDone.has(sessionId))return Promise.resolve();const active=nativeReleases.get(sessionId);if(active)return active;
    const operation=Promise.resolve().then(()=>ports.closeNative(sessionId)).then(()=>{nativeDone.add(sessionId);}).finally(()=>{nativeReleases.delete(sessionId);});nativeReleases.set(sessionId,operation);return operation;
  }
  function prepareClose(id:string):PreparedPostprocessClose{
    const captured=ports.read(),generated=owned(captured,id),summary=describeClose(id),key=++serial;
    let value:PostprocessDocument|undefined=captured.documents[id];
    const outgoing=[...attachments(value),...generated.flatMap(([,row])=>attachments(row.document))];
    let committed=false,inflight:Promise<void>|undefined;
    const assertCurrent=()=>{
      if(committed)return;
      const current=ports.read(),rows=owned(current,id);
      if(current.documents[id]!==value||rows.length!==generated.length||rows.some(([name,row],index)=>name!==generated[index][0]||row!==generated[index][1]))throw Error('待丢弃分析来源已变化，请重新确认。');
    };
    const transaction:PreparedPostprocessClose={ownerId:`postprocess:${id}`,summary,assertCurrent,
      commit(){
        if(committed)return;assertCurrent();
        const current=ports.read(),documents={...current.documents},nextGenerated={...current.generated};delete documents[id];for(const [name]of generated)delete nextGenerated[name];
        ports.retire(id);ports.commit({documents,generated:nextGenerated});committed=true;value=undefined;generated.length=0;
        pending.set(key,{id,sourceNames:summary.sourceNames,issues:[],release:transaction.release});
      },
      release(){
        if(!committed)return Promise.reject(Error('分析来源尚未丢弃，不能提前释放。'));
        if(!pending.has(key))return Promise.resolve();if(inflight)return inflight;
        inflight=(async()=>{
          const current=ports.read(),live=new Set([...Object.values(current.documents),...Object.values(current.generated).map(row=>row.document)].flatMap(attachments).map(item=>item.source));
          const abandoned=outgoing.filter(item=>!live.has(item.source));
          const issues=await disposePostprocessAttachments(abandoned,releaseNative,releaseResult);
          for(let index=outgoing.length-1;index>=0;index--){const attachment=outgoing[index];if(live.has(attachment.source)||(!attachment.nativeSessionId||nativeDone.has(attachment.nativeSessionId))&&attachment.source.results.every(result=>resultReleases.get(result)?.done))outgoing.splice(index,1);}
          if(issues.length){pending.get(key)!.issues=issues;throw Object.assign(new Error('分析内容已丢弃，但部分来源/原生资源仍待收尾：'+issues.join('；')),{code:'POSTPROCESS_CLOSE_CLEANUP_PENDING',documentId:id,metadataCommitted:true,issues});}
          pending.delete(key);if(!pending.size)nativeDone.clear();
        })().finally(()=>{inflight=undefined;});return inflight;
      },
    };return transaction;
  }
  return{
    describeClose,prepareClose,
    pendingCloses:()=>[...pending].map(([retirementId,value])=>({retirementId,id:value.id,sourceNames:value.sourceNames,issues:[...value.issues]})),
    async releasePendingCloses(id?:string){const outcomes=await Promise.allSettled([...pending.values()].filter(value=>id===undefined||value.id===id).map(value=>value.release()));const failures=outcomes.filter((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');if(failures.length)throw new AggregateError(failures.map(outcome=>outcome.reason),'仍有分析owner资源待收尾。');},
  };
}
