import type { AdvancedTaskRecord } from '../modeling/advanced/contracts';
import {migrateConformerInputSemantics} from '../modeling/advanced/conformer-cluster-collection';
import {isCapturedAdvancedStructure} from '../modeling/advanced/frame-source';

export interface AdvancedProjectSnapshot { schema: 1|2; tasks: AdvancedTaskRecord[] }
const terminal = new Set(['completed', 'failed', 'stopped', 'checkpoint']);
const decodedScience = new WeakSet<object>(), immutableScience = new WeakSet<object>();

/** Register a freshly materialized, verified JSON structure from the asset decoder. */
export function rememberDecodedAdvancedProjectStructure(value: object): void { decodedScience.add(value); }
export function isImmutableAdvancedProjectStructure(value: object): boolean { return immutableScience.has(value); }

function jsonScience(value: unknown, seen: WeakMap<object, boolean>, freeze: boolean): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || (!freeze && !Object.isFrozen(value))) return false;
  const known = seen.get(value);
  if (known !== undefined) return known;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype) return false;
  seen.set(value, false);
  for (const child of Array.isArray(value) ? value : Object.values(value)) if (!jsonScience(child, seen, freeze)) return false;
  if (freeze) Object.freeze(value);
  seen.set(value, true);
  return true;
}

function immutableStructure(value: object, adopt: boolean): boolean {
  if (immutableScience.has(value)) return true;
  const transfer = adopt && decodedScience.has(value);
  if (!transfer && !isCapturedAdvancedStructure(value)) return false;
  if (!jsonScience(value, new WeakMap(), transfer)) return false;
  immutableScience.add(value);
  return true;
}

/** Native ownership is deliberately absent after reopening. Scientific input,
 * full accepted frames, ordering, configurations and result provenance remain. */
export function captureAdvancedProjectSnapshot(tasks: readonly AdvancedTaskRecord[], options: {shareImmutableScience?: boolean} = {}): AdvancedProjectSnapshot {
  return detachAdvancedProjectSnapshot(tasks, options.shareImmutableScience === true, false);
}

function detachAdvancedProjectSnapshot(tasks: readonly AdvancedTaskRecord[], shareScience: boolean, adoptScience: boolean): AdvancedProjectSnapshot {
  // Source objects are scientific records. A field with a runtime-sounding name
  // inside a source is not an active host lease and must survive unchanged.
  // Shared initial sources recur in every samplingOrigin. Detach mutable data
  // once; the persistence path can reuse proven immutable coordinate objects.
  const scientificCopies=new WeakMap<object,unknown>(),runtimeCopies=new WeakMap<object,unknown>(),active=new WeakSet<object>();
  const detach=(value:unknown,key='',scientific=false):unknown=>{
    if(typeof value==='number'&&!Number.isFinite(value))return null;
    if(typeof value==='bigint')throw Error('项目高级任务包含不支持的整数。');
    if(value===null||typeof value!=='object')return value;
    if(value instanceof Date)return value.toJSON();
    if(active.has(value))throw Error('项目高级任务包含循环引用。');
    if(key==='structure'&&shareScience&&immutableStructure(value,adoptScience))return value;
    scientific=scientific||['source','input','originalInput','structure'].includes(key);
    if(scientific&&Object.values(value).some(item=>typeof item==='function'||typeof item==='symbol'))throw Error('项目科学来源包含不支持的运行对象。');
    const memo=scientific?scientificCopies:runtimeCopies,cached=memo.get(value);if(cached)return cached;
    active.add(value);
    const copy=Array.isArray(value)?value.map(part=>{const item=detach(part,'',scientific);return item===undefined||typeof item==='function'||typeof item==='symbol'?null:item;}):Object.fromEntries(Object.entries(value).filter(([name,item])=>(scientific||!['sessionId','diagnosticDirectory','resultHandle'].includes(name))&&item!==undefined&&typeof item!=='function'&&typeof item!=='symbol').map(([name,part])=>[name,detach(part,name,scientific)]));
    active.delete(value);memo.set(value,copy);return copy;
  };
  const copies=detach(tasks) as AdvancedTaskRecord[];
  for(const task of copies){
    let frames:Map<string,AdvancedTaskRecord['guessFrames'][number]>|undefined;
    for(const batch of task.mixedSampling?.batches??[])for(const card of batch.cards){
      const active=card.status==='running'||card.status==='pending';if(active)card.status='stopped';
      for(const segment of card.segments)if(segment.status==='running'){
        if(!frames){frames=new Map();for(const run of task.runs)for(const frame of run.frames)frames.set(frame.id,frame);}
        segment.status='stopped';segment.completedTimeFs=0;
        for(const id of segment.frameIds){const frame=frames.get(id);if(frame?.process?.kind==='sampling')segment.completedTimeFs=Math.max(segment.completedTimeFs,frame.process.data.timeFs);}
      }
      if(active&&card.segments.length)card.completedTimeFs=card.segments.reduce((sum,segment)=>sum+segment.completedTimeFs,0);
      if(active)card.receivedFrameCount=card.frameIds.length;
    }
  }
  for (const task of copies) for (const run of task.runs) {
    delete run.backgroundProgress;
    // Only these result records contain native electronic artifact leases.
    // A scientific source's similarly named property is ordinary saved data.
    for (const result of run.results) delete result.electronic;
    if (!terminal.has(run.status)) {
      run.status = 'stopped'; run.stopReason = 'project-snapshot-no-live-process';
      run.error = '项目保存了截至快照时的完整结果；重新打开未恢复或续启原生进程。';
      run.checkpoint = undefined;
    }
    if(run.mixedSampling?.executions?.some(execution=>execution.status==='running')){
      const framesBySegment=new Map<string,typeof run.frames>();
      for(const frame of run.frames){
        const segment=frame.samplingOrigin?.segmentId;if(!segment)continue;
        const frames=framesBySegment.get(segment)??[];frames.push(frame);framesBySegment.set(segment,frames);
      }
      for(const execution of run.mixedSampling.executions){
        if(execution.status!=='running')continue;
        execution.status='interrupted';
        const frames=framesBySegment.get(execution.segmentId)??[];
        execution.frameIds=frames.map(frame=>frame.id);
        execution.candidateFrameIds=frames.filter(frame=>frame.kind==='sampled-candidate'||frame.kind==='guess').map(frame=>frame.id);
        if(execution.kind==='sampling')execution.completedTimeFs=frames.reduce((value,frame)=>Math.max(value,frame.process?.kind==='sampling'?frame.process.data.timeFs:0),0);
      }
    }
    for (const stage of run.stages) {
      let succeeded=0;
      for(const result of stage.results){delete result.electronic;if(result.status==='completed')succeeded++;}
      delete stage.batchId;
      if (stage.status === 'running' || stage.status === 'pending') stage.status = 'stopped';
      if(task.conformerWorkflow||stage.progress){const discarded=stage.results.length-succeeded;
        stage.progress={...stage.progress,total:stage.inputCandidateIds.length,completed:succeeded,interrupted:0,failed:discarded,succeeded,discarded,running:0,pending:Math.max(0,stage.inputCandidateIds.length-succeeded-discarded),etaMs:null};}
    }
    for (const card of run.mixedSampling?.cards ?? []) if (card.status === 'running' || card.status === 'pending') card.status = 'stopped';
  }
  for(const task of copies){
    let frames:Set<string>|undefined;
    for(const state of task.conformerWorkflow?.stages??[]){const run=task.runs.find(run=>run.id===state.producerRunId),stage=run?.stages.find(stage=>stage.id===state.stageRunId);if(!stage)continue;
      if(!frames){frames=new Set(task.guessFrames.map(frame=>frame.id));for(const run of task.runs)for(const frame of run.frames)frames.add(frame.id);}
      const frameIds=frames;
      state.resultFrameIds=stage.results.flatMap(result=>result.status==='completed'&&result.frameId&&frameIds.has(result.frameId)?[result.frameId]:[]);
      state.completed??=stage.status==='completed';state.valid=state.valid&&stage.status==='completed';
      state.inputFrameIds??=stage.inputs?.flatMap(input=>input.source.ref.frameId?[input.source.ref.frameId]:[]);state.inputCollectionRevision??=stage.inputCollectionRevision;
      state.progress=stage.progress?{...stage.progress}:state.progress;
    }
  }
  return { schema: 2, tasks: copies };
}
export function restoreAdvancedProjectSnapshot(snapshot: AdvancedProjectSnapshot, options: {adoptDecodedScience?: boolean} = {}): AdvancedTaskRecord[] {
  if (![1,2].includes(snapshot.schema) || !Array.isArray(snapshot.tasks)) throw new Error('不支持的高级任务项目快照。');
  const adopt=options.adoptDecodedScience===true;
  const tasks = detachAdvancedProjectSnapshot(snapshot.tasks,adopt,adopt).tasks, ids = new Set<string>(), runIds = new Set<string>();
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
