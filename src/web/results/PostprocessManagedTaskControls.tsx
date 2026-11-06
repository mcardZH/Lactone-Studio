import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PostprocessDocument } from '../../results/postprocess-document';
import type { ManagedSourceOrigin, TaskGroupView, TaskSystemBridge } from '../../task-system/application-contracts';
import { createTaskSystemBridge } from '../../task-system/integration/desktop-bridge';
import { captureManagedPostprocessSourceSet, postprocessSourceIdentity, saveManagedPostprocessSourceSet, type PostprocessTaskAssociation } from '../../task-system/integration/postprocess-managed-source';
import { restoreTaskPostprocessCache, saveTaskPostprocessCache } from '../../task-system/integration/postprocess-cache';
import { getPostprocessTaskAssociation, setPostprocessTaskAssociation, postprocessTaskAssociationRestoredFromProject } from '../../projects/postprocess-task-association';
import { useProjectUiScope, type ProjectUiStore } from '../../projects/ui-state';
import { InputSettingsField } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsLayout } from '../InputSettingsLayout';
import { DismissibleNotice } from '../DismissibleNotice';
import DialogShell from '../DialogShell';
import './postprocess-managed-task.css';

type CacheInfo = { cacheId: string | null; savedAt: string | null; byteSize: number; state: 'absent' | 'complete' | 'incompatible' };
interface OperationState { busy: boolean; phase: string; completed: number; total: number | null; error: string; association?: PostprocessTaskAssociation; cache?: CacheInfo; restored?: boolean; displayName?: string; nameTaskId?: string }
/** Operation lifetime belongs to the source document, independently of views. */
const owners = new WeakMap<PostprocessDocument, { value: OperationState; listeners: Set<() => void>; releaseCache?: () => Promise<void>; bound?: boolean; cancelled?: boolean }>();
function owner(document: PostprocessDocument) { let value = owners.get(document); if (!value) { value = { value: { busy: false, phase: '', completed: 0, total: null, error: '', association: getPostprocessTaskAssociation(document) }, listeners: new Set() }; owners.set(document, value); } return value; }
export interface PostprocessManagedTaskControlsProps {
 documentId: string; document: PostprocessDocument; bridge?: TaskSystemBridge; origin?: ManagedSourceOrigin;
 association?: Pick<PostprocessTaskAssociation, 'taskId' | 'sourceSetId' | 'sourceVersion'> & Partial<PostprocessTaskAssociation>;
 uiStore?: ProjectUiStore; available?: boolean;
 /** Must check the captured document/source, never the current active tab. */
 assertCurrent?(): void;
 onAssociation?(value: PostprocessTaskAssociation): void; onOpenTask?(taskId: string): void; onError?(message: string): void;
}
export default function PostprocessManagedTaskControls(p: PostprocessManagedTaskControlsProps) {
 const stateOwner = owner(p.document), state = useSyncExternalStore(callback => { stateOwner.listeners.add(callback); return () => { stateOwner.listeners.delete(callback); }; }, () => stateOwner.value);
 const context = useProjectUiScope(), bridgeRef = useRef(p.bridge ?? createTaskSystemBridge()), bridge = p.bridge ?? bridgeRef.current;
 const [dialog, setDialog] = useState<'save' | 'save-new' | null>(null), [name, setName] = useState(p.document.result.label), [root, setRoot] = useState(''), [groups, setGroups] = useState<TaskGroupView[]>([]), [groupIds, setGroupIds] = useState<string[]>([]), [deletePlan, setDeletePlan] = useState<{ planId: string; byteSize: number; inUse: boolean } | null>(null), [sourceNames, setSourceNames] = useState<string[]>([]);
 const [admission,setAdmission]=useState<{eligible:boolean;reason?:string}>({eligible:!p.origin?.linkedRunId});
 const association = state.association ?? (p.association ? { locationId: '', directory: '', artifactIds: [], archived: true as const, documentId: p.documentId, sourceIdentity: postprocessSourceIdentity(p.document), ...p.association } : undefined);
 const origin:ManagedSourceOrigin|undefined=association&&association.sourceIdentity!==postprocessSourceIdentity(p.document)?{kind:p.document.wavefunction?.source.generatedXtb?'xtb-generated':'postprocess'}:p.origin;
 const uiStore = p.uiStore ?? context?.store;
 function update(patch: Partial<OperationState>) { stateOwner.value = { ...stateOwner.value, ...patch }; for (const notify of stateOwner.listeners) notify(); }
 const progress = (value: { phase: string; completed: number; total: number }) => update(value);
 const guard = () => { if(stateOwner.cancelled)throw new DOMException('已取消保存，原始来源及上次有效缓存保留。','AbortError');p.assertCurrent?.(); if (p.available === false) throw Error('当前来源不可用，未保存或覆盖任务。'); };
 async function act(work: () => Promise<void>) { if (stateOwner.value.busy) return;stateOwner.cancelled=false;update({ busy: true, error: '', phase: '准备来源', completed: 0, total: null }); try { await work(); } catch (error) { const message = error instanceof Error ? error.message : String(error); update({ error: message }); } finally { update({ busy: false, phase: '' });stateOwner.cancelled=false; } }
 const capture = (asNew = false) => captureManagedPostprocessSourceSet({ documentId: p.documentId, document: p.document, sourceSetId: asNew ? 'sources-' + crypto.randomUUID() : association?.sourceSetId, origin, guard });
 useEffect(()=>{if(!origin?.linkedRunId){setAdmission({eligible:true});return;}let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;setAdmission({eligible:false,reason:'正在核对原运行终态。'});const check=async()=>{try{const value=await bridge.request('source-save.admission',{origin:origin!});if(cancelled)return;setAdmission(value);if(!value.eligible)timer=setTimeout(()=>{void check();},3000);}catch(error){if(!cancelled)setAdmission({eligible:false,reason:error instanceof Error?error.message:String(error)});}};void check();return()=>{cancelled=true;if(timer)clearTimeout(timer);};},[origin?.linkedTaskId,origin?.linkedRunId,p.document]);
 useEffect(()=>{if(!association||stateOwner.value.nameTaskId===association.taskId)return;const taskId=association.taskId;let cancelled=false;void bridge.request('task.details',{taskId}).then(value=>{if(!cancelled)update({displayName:value.task.displayName,nameTaskId:taskId});},error=>{if(!cancelled)update({nameTaskId:taskId,error:error instanceof Error?error.message:String(error)});});return()=>{cancelled=true;};},[association?.taskId,p.document]);
 useEffect(() => {
  if (!stateOwner.bound) { stateOwner.bound = true; for (const result of new Set([p.document.result, p.document.output?.source.result, p.document.wavefunction?.source.result, ...p.document.companions?.map(row => row.source.result) ?? []].filter(Boolean))) { const original = result!.dispose.bind(result); result!.dispose = async () => { await stateOwner.releaseCache?.(); stateOwner.releaseCache = undefined; return original(); }; } }
  if (!association || stateOwner.value.restored || stateOwner.value.busy) return;
  let cancelled = false;
  void (async () => {if(postprocessTaskAssociationRestoredFromProject(p.document)){const cache=await bridge.request('postprocess-cache.describe',association);if(!cancelled)update({restored:true,association,cache});return;}const source = await capture(); if (cancelled) return; const restored = await restoreTaskPostprocessCache(bridge, association, source, { uiStore, guard, onWarning: message => update({ error: message }) }); if (cancelled) { await restored.release(); return; }if(!getPostprocessTaskAssociation(p.document))setPostprocessTaskAssociation(p.document,association);stateOwner.releaseCache = restored.release; update({ restored: true, association, cache: await bridge.request('postprocess-cache.describe', association) }); })().catch(error => { if (!cancelled) update({ error: error instanceof Error ? error.message : String(error), restored: true }); });
  return () => { cancelled = true; };
 }, [p.document, association?.taskId, association?.sourceVersion]);
 async function openSave(asNew: boolean) {
  if(stateOwner.value.displayName)setName(stateOwner.value.displayName);
  setDialog(asNew ? 'save-new' : 'save');
  await act(async () => { const [source, center] = await Promise.all([capture(asNew), bridge.request('center.read', {})]); setSourceNames(source.files.map(file => file.name)); setGroups(center.groups); });
 }
 async function save() { const asNew = dialog === 'save-new'; await act(async () => { const source = await capture(asNew); const saved = await saveManagedPostprocessSourceSet(bridge, source, { displayName: name, taskId: asNew ? undefined : association?.taskId, groupIds, archiveRootOverride: root.trim() || undefined, guard, onProgress: progress });try{guard();}catch{update({error:`已归档为任务 ${saved.taskId}；原页面已关闭或替换，未更改其他页面。`});return;}const next = { ...saved, documentId: p.documentId, sourceIdentity: postprocessSourceIdentity(p.document) }; setPostprocessTaskAssociation(p.document, next); update({ association: next, cache: undefined, restored: false,displayName:name,nameTaskId:next.taskId }); p.onAssociation?.(next); setDialog(null); }); }
 async function saveCache() { if (!association) return; await act(async () => { const source = await capture(); await saveTaskPostprocessCache(bridge, association, source, { uiStore, guard, onProgress: progress }); update({ cache: await bridge.request('postprocess-cache.describe', association) }); }); }
 async function planDelete() { if (!association || !state.cache?.cacheId) return; await act(async () => setDeletePlan(await bridge.request('postprocess-cache.delete-plan', { taskId: association.taskId, cacheId: state.cache!.cacheId! }))); }
 const percent = state.total !== null && state.total > 0 ? Math.min(100, Math.floor(state.completed / state.total * 100)) : undefined;
 const committing=state.phase==='登记任务'||state.phase==='提交缓存';
 const cancelDialog=()=>{if(stateOwner.value.busy&&!committing)stateOwner.cancelled=true;setDialog(null);};
 const progressView=state.busy&&<div className="postprocess-managed-progress" role="status"><span>{state.phase}</span><progress max={100} value={percent} aria-label="当前保存阶段"/>{percent!==undefined&&<span>{percent}%</span>}<span>预计剩余：估算中</span>{!committing&&!dialog&&<InputSettingsAction onClick={()=>{stateOwner.cancelled=true;}}>取消保存</InputSettingsAction>}</div>;
 const errorView=state.error&&<DismissibleNotice role="alert" onDismiss={()=>update({error:''})}>{state.error}</DismissibleNotice>;
 return <section className="postprocess-managed-task" aria-label="后处理任务保存" data-testid="postprocess-managed-task-controls" data-task-id={association?.taskId ?? ''}>
  <InputSettingsLayout>{association ? <><p className="postprocess-source-name">所属任务：{state.displayName??association.taskId}</p><div className="postprocess-actions"><InputSettingsAction disabled={state.busy} onClick={() => p.onOpenTask?.(association.taskId)}>打开任务</InputSettingsAction><InputSettingsAction disabled={state.busy || p.available === false || !admission.eligible} onClick={() => { void openSave(false); }}>保存当前来源</InputSettingsAction><InputSettingsAction disabled={state.busy || p.available === false || !admission.eligible} onClick={() => { void openSave(true); }}>明确另存为新任务</InputSettingsAction></div></> : <InputSettingsAction disabled={state.busy || p.available === false || !admission.eligible} onClick={() => { void openSave(false); }}>保存为受管理任务</InputSettingsAction>}
   {!admission.eligible&&<p className="postprocess-note">{admission.reason}</p>}
   <InputSettingsAction disabled={!association || state.busy || p.available === false} onClick={() => { void saveCache(); }}>保存/更新后处理缓存</InputSettingsAction>
   {association && <p className="postprocess-note">缓存：{state.cache?.state === 'complete' ? `已保存 · ${state.cache.savedAt ? new Date(state.cache.savedAt).toLocaleString() : ''} · ${state.cache.byteSize.toLocaleString()} 字节` : state.cache?.state === 'incompatible' ? '来源版本不兼容' : '未保存'}</p>}
   {state.cache?.cacheId && <InputSettingsAction disabled={state.busy} onClick={() => { void planDelete(); }}>删除后处理缓存</InputSettingsAction>}
  </InputSettingsLayout>
  {!dialog&&progressView}
  {!dialog&&!deletePlan&&errorView}
  {dialog && <DialogShell className="modal postprocess-managed-dialog" aria-label="保存为受管理任务" onCancel={cancelDialog}><h2>保存为受管理任务</h2><InputSettingsLayout><InputSettingsField label="任务名称"><input value={name} disabled={state.busy} onChange={event => setName(event.target.value)}/></InputSettingsField><InputSettingsField label="分组"><select multiple value={groupIds} disabled={state.busy} onChange={event => setGroupIds([...event.target.selectedOptions].map(option => option.value))}>{groups.map(group => <option key={group.groupId} value={group.groupId}>{group.displayName}</option>)}</select></InputSettingsField><InputSettingsField label="归档父目录"><input value={root} disabled={state.busy} placeholder="任务库默认归档位置" onChange={event => setRoot(event.target.value)}/></InputSettingsField><InputSettingsAction disabled={state.busy} onClick={() => { void act(async () => { const selected = await bridge.request('source-save.choose-directory', { path: root || undefined }); if (selected) setRoot(selected.directory); }); }}>选择文件夹</InputSettingsAction><div>源文件清单<ul>{sourceNames.map((file, index) => <li key={index}>{file}</li>)}</ul></div>{progressView}{errorView}<div className="postprocess-actions"><InputSettingsAction disabled={committing} onClick={cancelDialog}>取消</InputSettingsAction><InputSettingsAction variant="primary" disabled={state.busy || !name.trim() || !sourceNames.length} onClick={() => { void save(); }}>保存并归档</InputSettingsAction></div></InputSettingsLayout></DialogShell>}
  {deletePlan && <DialogShell className="modal postprocess-managed-dialog" aria-label="删除后处理缓存" onCancel={() => setDeletePlan(null)}><h2>删除后处理缓存</h2><p>将移除本任务已保存的派生数据和分析状态，共 {deletePlan.byteSize.toLocaleString()} 字节。任务卡、分组、标记、原始来源及独立项目保留。</p>{deletePlan.inUse && <p>当前有分析窗口使用缓存，释放其来源后可删除；不会关闭窗口。</p>}{errorView}<div className="postprocess-actions"><InputSettingsAction onClick={() => setDeletePlan(null)}>取消</InputSettingsAction><InputSettingsAction disabled={state.busy || deletePlan.inUse} onClick={() => { void act(async () => { const result = await bridge.request('postprocess-cache.delete', { planId: deletePlan.planId }); if (result.retained.length) throw Error(`仍保留 ${result.retained.length} 项：${result.retained.map(item => item.reason).join('；')}`); update({ cache: { cacheId: null, savedAt: null, byteSize: 0, state: 'absent' } }); setDeletePlan(null); }); }}>确认删除缓存</InputSettingsAction></div></DialogShell>}
 </section>;
}
