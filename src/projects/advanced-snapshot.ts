import type { AdvancedTaskRecord } from '../modeling/advanced/contracts';
import {migrateConformerInputSemantics} from '../modeling/advanced/conformer-cluster-collection';

export interface AdvancedProjectSnapshot { schema: 1|2; tasks: AdvancedTaskRecord[] }
const terminal = new Set(['completed', 'failed', 'stopped', 'checkpoint']);
/** Native ownership is deliberately absent after reopening. Scientific input,
 * full accepted frames, ordering, configurations and result provenance remain. */
export function captureAdvancedProjectSnapshot(tasks: readonly AdvancedTaskRecord[]): AdvancedProjectSnapshot {
  // Source objects are scientific records. A field with a runtime-sounding name
  // inside a source is not an active host lease and must survive unchanged.
  // Shared initial sources recur in every samplingOrigin. Clone each immutable
  // scientific object once while building this temporary graph. The existing
  // JSON boundary below still emits exactly the same self-contained schema.
  const scientificCopies=new WeakMap<object,unknown>(),runtimeCopies=new WeakMap<object,unknown>(),active=new WeakSet<object>();
  const detach=(value:unknown,key='',scientific=false):unknown=>{
    if(typeof value==='number'&&!Number.isFinite(value))return null;
    if(typeof value==='bigint')throw Error('项目高级任务包含不支持的整数。');
    if(value===null||typeof value!=='object')return value;
    if(value instanceof Date)return value.toJSON();
    if(active.has(value))throw Error('项目高级任务包含循环引用。');
    scientific=scientific||['source','input','originalInput','structure'].includes(key);
    if(scientific&&Object.values(value).some(item=>typeof item==='function'||typeof item==='symbol'))throw Error('项目科学来源包含不支持的运行对象。');
    const memo=scientific?scientificCopies:runtimeCopies,cached=memo.get(value);if(cached)return cached;
    active.add(value);
    const copy=Array.isArray(value)?value.map(part=>{const item=detach(part,'',scientific);return item===undefined||typeof item==='function'||typeof item==='symbol'?null:item;}):Object.fromEntries(Object.entries(value).filter(([name,item])=>(scientific||!['sessionId','diagnosticDirectory','resultHandle'].includes(name))&&item!==undefined&&typeof item!=='function'&&typeof item!=='symbol').map(([name,part])=>[name,detach(part,name,scientific)]));
    active.delete(value);memo.set(value,copy);return copy;
  };
  const copies=detach(tasks) as AdvancedTaskRecord[];
  for(const task of copies){const frames=new Map(task.runs.flatMap(run=>run.frames).map(frame=>[frame.id,frame]));
    for(const batch of task.mixedSampling?.batches??[])for(const card of batch.cards){
      const active=card.status==='running'||card.status==='pending';if(active)card.status='stopped';
      for(const segment of card.segments)if(segment.status==='running'){
        segment.status='stopped';segment.completedTimeFs=Math.max(0,...segment.frameIds.map(id=>{const frame=frames.get(id);return frame?.process?.kind==='sampling'?frame.process.data.timeFs:0;}));
      }
      if(active&&card.segments.length)card.completedTimeFs=card.segments.reduce((sum,segment)=>sum+segment.completedTimeFs,0);
      if(active)card.receivedFrameCount=card.frameIds.length;
    }
  }
  for (const task of copies) for (const run of task.runs) {
    delete run.backgroundProgress;
    // Only these result records contain native electronic artifact leases.
    // A scientific source's similarly named property is ordinary saved data.
    for (const result of [...run.results, ...run.stages.flatMap(stage => stage.results)]) delete result.electronic;
    if (!terminal.has(run.status)) {
      run.status = 'stopped'; run.stopReason = 'project-snapshot-no-live-process';
      run.error = '项目保存了截至快照时的完整结果；重新打开未恢复或续启原生进程。';
      run.checkpoint = undefined;
    }
    for (const stage of run.stages) {
      delete stage.batchId;
      if (stage.status === 'running' || stage.status === 'pending') stage.status = 'stopped';
      if(task.conformerWorkflow||stage.progress){const succeeded=stage.results.filter(result=>result.status==='completed').length,discarded=stage.results.filter(result=>result.status!=='completed').length;
        stage.progress={...stage.progress,total:stage.inputCandidateIds.length,completed:succeeded,interrupted:0,failed:discarded,succeeded,discarded,running:0,pending:Math.max(0,stage.inputCandidateIds.length-succeeded-discarded),etaMs:null};}
    }
    for (const card of run.mixedSampling?.cards ?? []) if (card.status === 'running' || card.status === 'pending') card.status = 'stopped';
  }
  for(const task of copies){
    const frames=new Set([...task.guessFrames,...task.runs.flatMap(run=>run.frames)].map(frame=>frame.id));
    for(const state of task.conformerWorkflow?.stages??[]){const run=task.runs.find(run=>run.id===state.producerRunId),stage=run?.stages.find(stage=>stage.id===state.stageRunId);if(!stage)continue;
      state.resultFrameIds=stage.results.filter(result=>result.status==='completed'&&result.frameId&&frames.has(result.frameId)).map(result=>result.frameId!);
      state.completed??=stage.status==='completed';state.valid=state.valid&&stage.status==='completed';
      state.inputFrameIds??=stage.inputs?.flatMap(input=>input.source.ref.frameId?[input.source.ref.frameId]:[]);state.inputCollectionRevision??=stage.inputCollectionRevision;
      state.progress=stage.progress?{...stage.progress}:state.progress;
    }
  }
  return { schema: 2, tasks: copies };
}
export function restoreAdvancedProjectSnapshot(snapshot: AdvancedProjectSnapshot): AdvancedTaskRecord[] {
  if (![1,2].includes(snapshot.schema) || !Array.isArray(snapshot.tasks)) throw new Error('不支持的高级任务项目快照。');
  const tasks = captureAdvancedProjectSnapshot(snapshot.tasks).tasks, ids = new Set<string>(), runIds = new Set<string>();
  for (const task of tasks) {
    migrateConformerInputSemantics(task);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(task.id) || ids.has(task.id) || !Array.isArray(task.runs) || !Array.isArray(task.guessFrames)) throw new Error('项目高级任务身份无效或重复。');
    ids.add(task.id);
    for (const run of task.runs) {
      if (run.taskId !== task.id || !run.id || runIds.has(run.id)) throw new Error('项目高级运行归属无效或重复。');
      runIds.add(run.id);
      for (const frame of run.frames) if (frame.taskId !== task.id || frame.runId !== run.id) throw new Error('项目高级任务帧归属不一致。');
    }
    for (const frame of task.guessFrames) if (frame.taskId !== task.id) throw new Error('项目初猜帧归属不一致。');
  }
  return tasks;
}

/** Delete a task before its lazy advanced owner is mounted. This edits only the
 * pending project data; it neither opens native owners nor releases disk data.
 * The caller marks the project dirty and persists this replacement snapshot. */
export function removeAdvancedProjectTask(snapshot: AdvancedProjectSnapshot, taskId: string): AdvancedProjectSnapshot {
  const tasks = restoreAdvancedProjectSnapshot(snapshot);
  // Unknown IDs are an observable no-op, including the original object identity.
  if (!tasks.some(task => task.id === taskId)) return snapshot;
  return { schema: 2, tasks: tasks.filter(task => task.id !== taskId) };
}
