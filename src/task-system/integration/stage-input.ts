import type {TaskSystemBridge,SubmitTaskInput,SubmitDependencyView} from '../application-contracts';
import type {ExternalInputDraft,ExternalInputDependency} from './input-draft';
const CHUNK=1024*1024;

/** Stage generated companions and already-selected sources without re-running a writer. */
export async function stageExternalInput(draft:ExternalInputDraft,bridge:TaskSystemBridge,projectId:string|null,signal?:AbortSignal):Promise<SubmitTaskInput>{
  const dependencies:SubmitDependencyView[]=[];
  try{
    for(const dependency of draft.dependencies)dependencies.push(await stageDependency(dependency,bridge,signal));
    return {engineId:draft.engineId,inputName:draft.inputName,finalInputText:draft.finalInputText,suggestedName:draft.suggestedName,dependencies,projectId,resources:[]};
  }catch(error){await bridge.request('submission.release-dependencies',{sourceRefs:dependencies.map(row=>row.sourceRef)}).catch(()=>{});throw error;}
}

async function stageDependency(dependency:ExternalInputDependency,bridge:TaskSystemBridge,signal?:AbortSignal):Promise<SubmitDependencyView>{
  const generated=dependency.source.kind==='generated-text'?new TextEncoder().encode(dependency.source.text):null;
  const source=dependency.source.kind==='generated-text'?null:dependency.source.file;
  const size=generated?.byteLength??source!.size,release=source&&'retain'in source?source.retain?.():undefined;
  let token:string|undefined,finished=false;
  try{
    ({token}=await bridge.request('submission.stage-begin',{name:dependency.name,role:dependency.role,byteSize:size},{signal}));
    for(let offset=0;offset<size;offset+=CHUNK){
      if(signal?.aborted)throw new DOMException('已取消准备依赖。','AbortError');
      const end=Math.min(size,offset+CHUNK),bytes=generated?generated.slice(offset,end):new Uint8Array(await source!.slice(offset,end).arrayBuffer());
      if(bytes.byteLength!==end-offset)throw new Error('输入依赖读取不完整，未提交。');
      const receipt=await bridge.request('submission.stage-append',{token,offset,bytes},{signal});
      if(receipt.receivedBytes!==end)throw new Error('输入依赖接收位置不一致，未提交。');
    }
    const result=await bridge.request('submission.stage-finish',{token},{signal});finished=true;return result;
  }finally{
    if(token&&!finished)await bridge.request('submission.stage-abort',{token}).catch(()=>{});
    await release?.();
  }
}
