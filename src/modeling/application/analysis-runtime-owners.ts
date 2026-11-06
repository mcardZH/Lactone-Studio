import type { WorkspaceDiscardTransaction } from '../workspace-contracts';
export interface AnalysisRuntimeIdentity { analysisId:string;kind:string;sourceId:string;sourceRevision:string;documentId?:string;label?:string }
export interface AnalysisRuntimeOwnerPorts { isBusy():boolean;hasData():boolean;revision?():unknown;retire():void;release():Promise<void> }
export function createAnalysisRuntimeOwners(){
  let serial=0;
  type Record={id:number;identity:Readonly<AnalysisRuntimeIdentity>;ports:AnalysisRuntimeOwnerPorts;retired:boolean;inflight?:Promise<void>};
  const owners=new Map<number,Record>();
  const selected=(documentIds:string|readonly string[],sourceIds:readonly string[]=[])=>{
    const documents=new Set(typeof documentIds==='string'?[documentIds]:documentIds),sources=new Set(sourceIds);
    return [...owners.values()].filter(record=>record.identity.documentId?documents.has(record.identity.documentId):sources.has(record.identity.sourceId));
  };
  const revision=(records:readonly Record[])=>JSON.stringify(records.map(record=>[record.id,record.identity,record.retired,record.ports.hasData(),record.ports.revision?.()]));
  const idle=(records:readonly Record[])=>{if(records.some(record=>record.inflight||record.ports.isBusy()))throw Object.assign(Error('分析来源仍有运行、读取或关闭中的任务，请先停止并取得实际结束回执。'),{code:'ANALYSIS_RUNTIME_BUSY'});};
  function retire(record:Record){if(record.retired)return;record.retired=true;record.ports.retire();}
  function dispose(record:Record):Promise<void>{
    if(!owners.has(record.id))return Promise.resolve();if(record.inflight)return record.inflight;
    retire(record);
    record.inflight=Promise.resolve().then(()=>record.ports.release()).then(()=>{owners.delete(record.id);}).finally(()=>{record.inflight=undefined;});return record.inflight;
  }
  return{
    register(identity:AnalysisRuntimeIdentity,ports:AnalysisRuntimeOwnerPorts){
      if(!identity.analysisId||!identity.sourceId||!identity.sourceRevision)throw Error('分析资源owner缺少来源身份。');
      const record:Record={id:++serial,identity:Object.freeze({...identity}),ports,retired:false};owners.set(record.id,record);
      return{dispose:()=>dispose(record),isBusy:()=>Boolean(record.inflight)||ports.isBusy(),retire:()=>retire(record)};
    },
    describeDocumentClose(documentId:string,sourceIds:readonly string[]=[]){const records=selected(documentId,sourceIds);return{revision:revision(records),hasData:records.some(record=>record.ports.hasData()),labels:[...new Set(records.filter(record=>record.ports.hasData()).map(record=>record.identity.label??record.identity.kind))]};},
    assertDocumentIdle(documentId:string|readonly string[],sourceIds:readonly string[]=[]){idle(selected(documentId,sourceIds));},
    prepareDocumentClose(documentIds:string|readonly string[],sourceIds:readonly string[]=[],stillLiveSourceIds:readonly string[]=[]):WorkspaceDiscardTransaction{
      const matches=selected(documentIds,sourceIds),baseline=revision(matches),live=new Set(stillLiveSourceIds),retiring=matches.filter(record=>Boolean(record.identity.documentId)||!live.has(record.identity.sourceId));let committed=false;
      const assertCurrent=()=>{if(committed)return;const now=selected(documentIds,sourceIds);if(revision(now)!==baseline)throw Error('分析资源owner在确认期间已变化，请重新确认。');idle(now);};
      assertCurrent();return{assertCurrent,commit(){if(committed)return;assertCurrent();for(const record of retiring)retire(record);committed=true;},async release(){if(!committed)throw Error('分析资源尚未退休，不能提前释放。');const outcomes=await Promise.allSettled(retiring.map(dispose)),failures=outcomes.filter((outcome):outcome is PromiseRejectedResult=>outcome.status==='rejected');if(failures.length)throw Object.assign(new AggregateError(failures.map(outcome=>outcome.reason),'部分分析进程或来源仍待实际释放。'),{code:'ANALYSIS_RUNTIME_CLEANUP_PENDING'});}};
    },
    pending:()=>[...owners.values()].filter(record=>record.retired).map(record=>({id:record.id,...record.identity,busy:Boolean(record.inflight)||record.ports.isBusy()})),
  };
}
const registry=createAnalysisRuntimeOwners();
export const registerAnalysisRuntimeOwner=registry.register;
export const describeAnalysisDocumentClose=registry.describeDocumentClose;
export const assertAnalysisDocumentIdle=registry.assertDocumentIdle;
export const prepareAnalysisDocumentClose=registry.prepareDocumentClose;
export const pendingAnalysisRuntimeOwners=registry.pending;
