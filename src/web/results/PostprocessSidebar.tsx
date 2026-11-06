import { useRef, useState } from 'react';
import { Atom, FlaskConical, Gauge, Layers, Waves } from 'lucide-react';
import type { TrajectoryResult } from '../../results/contracts';
import {isScientificFileDocument,type PostprocessFileDocument,type PostprocessScientificFileDocument} from '../../results/postprocess-document';
import {postprocessFileJob,isScientificFileSource} from '../../results/postprocess-sources';
import {postprocessExcitationSlots} from './postprocess-excitation-slots';
import {postprocessSourceExtras} from '../../projects/postprocess-extra-sources';
import { TASK_GROUPS } from '../../core/tasks';
import SoftwareChooser from '../SoftwareChooser';
import InputTaskPicker from '../InputTaskPicker';
import { InputSettingsLayout } from '../InputSettingsLayout';
import { WorkflowContentCard, WorkflowHeader, WorkflowSteps } from '../WorkflowPresentation';
import { type PostprocessNumericBookProps, type PostprocessMetadata } from './PostprocessNumericBook';
import {PostprocessSourceCard,PostprocessSourceInformation,PostprocessSourceFeedback} from './PostprocessSourcePanels';
import './Postprocess.css';

export type PostprocessEngine = 'gaussian' | 'orca' | 'cp2k' | 'xtb' | 'unknown';
export type PostprocessTask = 'trajectory' | 'sp' | 'opt' | 'freq' | 'optfreq' | 'ts' | 'irc' | 'scan' | 'neb' | 'td' | 'nmr' | 'stability' | 'bsse';
export type PostprocessFileRole = 'output' | 'wavefunction' | 'companions';
export type PostprocessSlotKey = 'output'|'wavefunction'|'optimization-trajectory'|'hess'|'irc-full'|'irc-forward'|'irc-reverse'|'scan-point-set'|'neb-path'|'neb-iterations'|'neb-log'|'neb-interpolation'|'ts-optimization-trajectory'|'md-trajectory'|'md-log'|'excitation-json'|'excitation-cis'|'unassigned';
export interface PostprocessFileSlot { role: PostprocessFileRole; slotKey?:PostprocessSlotKey; sourceId?:string; name?: string; format?:'molden'|'xyz'|'hess'; software?:PostprocessEngine; status?: 'ready' | 'reading' | 'error' | 'unverified'; message?: string }
export interface PostprocessSidebarProps {
  engine: PostprocessEngine; task: PostprocessTask; stage: 'software' | 'tasks' | 'files';
  slots: readonly PostprocessFileSlot[]; result: TrajectoryResult | null; currentIndex: number; busy?: boolean;
  fileDocument?:PostprocessScientificFileDocument|null;onFileJob?(id:string):void;
  message?: string; sourceDifferences?: PostprocessNumericBookProps['sourceDifferences']; metadata?: PostprocessMetadata;
  onEngine(engine: PostprocessEngine): void; onTask(task: PostprocessTask): void; onStage(stage: PostprocessSidebarProps['stage']): void;
  onFiles(role: PostprocessFileRole, files: File[], explicitReplace?:boolean, slotKey?:PostprocessSlotKey,sourceId?:string): void; onRemove(role: PostprocessFileRole,slotKey?:PostprocessSlotKey,sourceId?:string): void;
  onClose?(): void; onExtract?(): void; onPrepareInput?(): void; onPrepareIrc?(): void; onOpenLegacy?(): void;
}
export const POSTPROCESS_TASK_CHOICES: readonly { id: PostprocessTask; group: string; label: string; code: string }[] = [
  {id:'trajectory',group:'structure',label:'结构 / 轨迹',code:'XYZ'},
  { id: 'sp', group: 'structure', label: '单点能', code: 'SP' }, { id: 'opt', group: 'structure', label: '结构优化', code: 'Opt' }, { id: 'freq', group: 'structure', label: '频率 / 热化学', code: 'Freq' }, { id: 'optfreq', group: 'structure', label: '优化与频率', code: 'Opt + Freq' },
  { id: 'ts', group: 'path', label: '过渡态', code: 'TS' }, { id: 'irc', group: 'path', label: '反应路径', code: 'IRC' }, { id: 'scan', group: 'path', label: '扫描', code: 'Scan' },{id:'neb',group:'path',label:'NEB路径',code:'NEB'}, { id: 'td', group: 'excited', label: '激发态', code: 'TD' }, { id: 'nmr', group: 'properties', label: 'NMR', code: 'NMR' }, { id: 'stability', group: 'properties', label: '稳定性', code: 'Stable' }, { id: 'bsse', group: 'properties', label: 'BSSE', code: 'BSSE' },
];
const unifiedTasks = new Set<PostprocessTask>(['trajectory', 'sp', 'opt', 'optfreq', 'ts', 'scan', 'irc', 'neb', 'freq', 'td']);
const stages = ['software', 'tasks', 'files'] as const;
const steps = ['选择软件', '选择任务', '计算文件'] as const;
const taskIcons = { sp: Gauge, opt: Atom, freq: Waves, optfreq: Layers };
/** Describe retained content and native role references, without reading a path
 * named by OUT. Empty conditional cards represent references, not loaded files. */
export function postprocessDocumentFileSlots(document:PostprocessFileDocument|null|undefined):PostprocessFileSlot[]{
 if(!document)return[];
 const source=document.output?.source,wave=document.wavefunction?.source;
 const identity=source?(isScientificFileSource(source)?source.identity:source.result.source):undefined;
 const waveWarning=isScientificFileDocument(document)?document.sourceWarnings?.filter(item=>item.sourceId===wave?.result.source.id).map(item=>item.message).filter((message,index,all)=>all.indexOf(message)===index).join('；'):undefined;
 const slots:PostprocessFileSlot[]=[{role:'output',slotKey:'output',sourceId:identity?.id,name:identity?.name,software:source?.software,format:source&&!isScientificFileSource(source)&&['xyz','hess'].includes(source.kind)?source.kind as 'xyz'|'hess':undefined,status:source?'ready':undefined},{role:'wavefunction',slotKey:'wavefunction',sourceId:wave?.result.source.id,name:wave?.result.source.name,software:wave?.software,format:wave?.kind==='molden'?'molden':undefined,status:wave?waveWarning?'unverified':'ready':undefined,message:waveWarning}];
 const roles=new Set(Object.keys(companionDescriptions));
 for(const attachment of document.companions??[]){
  const result=attachment.source.result,role=attachment.role??result.scientific?.ircEvidence?.role??(attachment.source.kind==='hess'?'hess':result.role),slotKey=role&&roles.has(role)?role as PostprocessSlotKey:'unassigned';
  const warning=isScientificFileDocument(document)?document.sourceWarnings?.find(item=>item.sourceId===result.source.id):undefined;
  slots.push({role:'companions',slotKey,sourceId:result.source.id,name:result.source.name,status:warning||slotKey==='unassigned'?'unverified':'ready',message:warning?.message??(slotKey==='unassigned'?'尚未确定任务角色，原始来源保留。':undefined)});
 }
 if(!isScientificFileDocument(document))for(const extra of postprocessSourceExtras(document)){
  const slotKey=extra.format==='orca-neb-log'?'neb-log':extra.format==='neb-interpolation'?'neb-interpolation':extra.format==='orca-md-log'||extra.format==='orca-md-statistics'?'md-log':'unassigned';
  slots.push({role:'companions',slotKey,sourceId:extra.sourceId,name:extra.name,status:'unverified',message:'已保留原始辅助来源；可用字段按对应路径核对。'});
 }
 if(source){
  const contexts=isScientificFileSource(source)?source.ircContexts:source.ircOutputContext?[source.ircOutputContext]:[];
  const selectedJob=isScientificFileSource(source)?postprocessFileJob(source)?.id:source.result.id;
  for(const ref of contexts.filter(context=>context.outputId===selectedJob).flatMap(context=>context.references))if(!slots.some(slot=>slot.slotKey===ref.role))slots.push({role:'companions',slotKey:ref.role,message:ref.role==='irc-full'?'补入完整 IRC 轨迹后可播放路径。':undefined});
  if(!isScientificFileSource(source)&&document.output)slots.push(...postprocessExcitationSlots(document.output as import('../../results/postprocess-document').PostprocessAttachment));
 }
 return slots;
}
const companionDescriptions:Record<Exclude<PostprocessSlotKey,'output'|'wavefunction'>,{label:string;extensions:string;accept:string}>={
 'optimization-trajectory':{label:'优化轨迹',extensions:'XYZ / extXYZ',accept:'.xyz,.extxyz'},
 hess:{label:'HESS 频率 / 模态',extensions:'.hess',accept:'.hess'},
 'irc-full':{label:'完整 IRC 轨迹',extensions:'.xyz',accept:'.xyz,.extxyz'},
 'irc-forward':{label:'正向 IRC 轨迹',extensions:'.xyz',accept:'.xyz,.extxyz'},
 'irc-reverse':{label:'反向 IRC 轨迹',extensions:'.xyz',accept:'.xyz,.extxyz'},
 'scan-point-set':{label:'扫描点结构 / 轨迹',extensions:'XYZ / extXYZ',accept:'.xyz,.extxyz'},
 'neb-path':{label:'NEB 路径',extensions:'.xyz',accept:'.xyz,.extxyz'},
 'neb-iterations':{label:'NEB 历轮轨迹',extensions:'XYZ / ALLXYZ',accept:'.xyz,.allxyz,.extxyz'},
 'neb-log':{label:'NEB 路径日志',extensions:'.log',accept:'.log'},
 'neb-interpolation':{label:'NEB 插值辅助',extensions:'已支持的插值文件',accept:'.interp,.xyz'},
 'ts-optimization-trajectory':{label:'TS 优化轨迹',extensions:'XYZ / extXYZ',accept:'.xyz,.extxyz'},
 'md-trajectory':{label:'MD 轨迹',extensions:'XYZ / extXYZ',accept:'.xyz,.extxyz'},
 'md-log':{label:'MD 日志 / 统计',extensions:'.md.log / .csv',accept:'.log,.out,.dat,.csv'},
 'excitation-json':{label:'ORCA 激发态 JSON',extensions:'.json · 按振幅来源能力补入',accept:'.json'},
 'excitation-cis':{label:'ORCA 激发态 CIS',extensions:'.cis · 按振幅来源能力补入',accept:'.cis'},
 unassigned:{label:'未归属配套文件',extensions:'保留的原始配套来源',accept:'.xyz,.extxyz,.hess,.log,.json,.cis'},
};
/** The selected task controls empty cards only. Loaded roles remain visible even
 * when a source's actual content differs from the user's initial choice. */
export function postprocessVisibleFileSlots(engine:PostprocessEngine,task:PostprocessTask,slots:readonly PostprocessFileSlot[],actualTasks:readonly string[]=[]):PostprocessFileSlot[]{
 const named=slots.filter(slot=>slot.name),output=slots.find(slot=>slot.role==='output');
 if(named.some(slot=>slot.role==='wavefunction')&&!output?.name)return slots.filter(slot=>slot.role==='wavefunction'||Boolean(slot.name));
 const savedStructure=output?.format==='xyz'||output?.format==='hess'||task==='trajectory'&&!output?.name;
 const keys:PostprocessSlotKey[]=['output'];
 const tasks=actualTasks.length?actualTasks:[task];
 if(engine==='orca'&&!savedStructure){
  if(tasks.some(id=>['opt','optfreq','ts'].includes(id)))keys.push(tasks.includes('neb')?'ts-optimization-trajectory':'optimization-trajectory');
  if(tasks.some(id=>['freq','optfreq'].includes(id)))keys.push('hess');
  if(tasks.includes('irc'))keys.push('irc-full');
  if(tasks.includes('scan'))keys.push('scan-point-set');
  if(tasks.includes('neb'))keys.push('neb-path','neb-iterations');
  if(tasks.includes('md'))keys.push('md-trajectory','md-log');
 }
 if(!savedStructure)keys.push('wavefunction');
 // Explicit capability/related-file descriptors control conditional roles.
 for(const slot of slots)if(slot.slotKey&&!keys.includes(slot.slotKey))keys.push(slot.slotKey);
 const result=keys.flatMap(key=>{
  const matching=slots.filter(slot=>(slot.slotKey??(slot.role==='companions'?'unassigned':slot.role))===key);
  return matching.length?matching:[{role:key==='output'?'output':key==='wavefunction'?'wavefunction':'companions',slotKey:key} as PostprocessFileSlot];
 });
 for(const slot of named)if(!result.includes(slot))result.push({...slot,slotKey:slot.slotKey??'unassigned'});
 const rank=(slot:PostprocessFileSlot)=>slot.role==='output'?0:slot.slotKey==='excitation-json'||slot.slotKey==='excitation-cis'?3:slot.role==='wavefunction'?2:1;
 return result.sort((a,b)=>rank(a)-rank(b));
}
export function postprocessFileDescription(engine: PostprocessEngine, role: PostprocessFileRole, format?:PostprocessFileSlot['format'],slotKey?:PostprocessSlotKey) {
  if(role==='companions'&&slotKey&&slotKey!=='output'&&slotKey!=='wavefunction')return companionDescriptions[slotKey];
  if(role==='companions')return{label:'配套轨迹 / 模态文件',extensions:'XYZ / HESS',accept:'.xyz,.extxyz,.hess'};
  if(role==='output'&&format==='xyz')return{label:'XYZ 已保存结构 / 轨迹',extensions:'XYZ / extXYZ',accept:'.xyz,.extxyz'};
  if(role==='output'&&format==='hess')return{label:'ORCA HESS 已保存频率 / 模态',extensions:'.hess',accept:'.hess'};
  if(role==='output'&&engine==='unknown')return{label:'已保存结果 / 轨迹',extensions:'OUT / XYZ / HESS',accept:'.out,.log,.xyz,.extxyz,.hess'};
  if(role==='wavefunction'&&(format==='molden'||engine==='unknown'||engine==='cp2k'||engine==='xtb'))return { label: `${engine==='gaussian'?'Gaussian ':engine==='orca'?'ORCA ':engine==='cp2k'?'CP2K ':engine==='xtb'?'GFN2-xTB ':''}Molden 波函数文件`, extensions: '.molden / .molden.input', accept: '.molden,.input' };
  return role === 'output' ? engine === 'gaussian' ? { label: '高斯 OUT 文件', extensions: '.out / .log', accept: '.out,.log' } : { label: 'ORCA OUT 文件', extensions: '.out', accept: '.out' }
    : engine === 'gaussian' ? { label: '高斯 FCHK / FCH 文件', extensions: '.fchk / .fch', accept: '.fchk,.fch' } : { label: 'ORCA Molden 文件', extensions: '.molden / .molden.input', accept: '.molden,.input' };
}
function FileSlot({ engine, slot, busy, onFiles, onRemove }: { engine: PostprocessEngine; slot: PostprocessFileSlot; busy?: boolean; onFiles(files: File[],explicitReplace?:boolean): void; onRemove(): void }) {
  const input = useRef<HTMLInputElement>(null), [over, setOver] = useState(false);
  const info = postprocessFileDescription(slot.role==='wavefunction'&&slot.format==='molden'?slot.software??engine:engine, slot.role,slot.format,slot.slotKey);
  return <PostprocessSourceCard title={info.label} status={slot.status} statusLabel={slot.status === 'ready' ? slot.role==='companions'?'已配对':'已读取' : slot.status === 'reading' ? '读取中' : slot.status === 'error' ? '未接入' : slot.name ? '待核对' : slot.role==='output'?'待补入':'可选 · 待补入'} dragover={over}
    onDragOver={event => { event.preventDefault(); if (!busy) { event.dataTransfer.dropEffect = 'copy'; setOver(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false); }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); setOver(false); if (!busy && event.dataTransfer.files.length) onFiles(Array.from(event.dataTransfer.files)); }}>
    <p className="postprocess-note">{info.extensions}</p>{slot.name ? <p className="postprocess-source-name">{slot.name}</p> : <p className="postprocess-note postprocess-source-drop-hint"><span>拖入文件，</span><span>或选择文件</span></p>}
    <input ref={input} type="file" hidden aria-label={`选择${info.label}`} accept={info.accept} multiple disabled={busy} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (!busy && files.length) onFiles(files,Boolean(slot.name)); }}/>
    <div className="postprocess-actions"><button type="button" disabled={busy} onClick={() => input.current?.click()}>{slot.name ? '替换文件' : '选择文件'}</button>{slot.name && <button type="button" disabled={busy} onClick={onRemove}>移除</button>}</div>
    {slot.message && (slot.name||slot.status==='error'?<PostprocessSourceFeedback key={`${slot.sourceId??slot.slotKey}:${slot.message}`} message={slot.message} error={slot.status==='error'}/>:<p className="postprocess-note">{slot.message}</p>)}
  </PostprocessSourceCard>;
}
export default function PostprocessSidebar(p: PostprocessSidebarProps) {
  const engineName = p.engine === 'gaussian' ? 'Gaussian' : p.engine === 'orca' ? 'ORCA' : p.engine==='cp2k'?'CP2K':p.engine==='xtb'?'GFN2-xTB':'生产软件未确认';
  const waveOnly=p.slots.some(slot=>slot.role==='wavefunction'&&slot.name)&&!p.slots.some(slot=>slot.role==='output'&&slot.name);
  const scientific=p.fileDocument?postprocessFileJob(p.fileDocument.output.source)?.scientific:p.result?.scientific;
  const fileSlots=postprocessVisibleFileSlots(p.engine,p.task,p.slots,scientific?.tasks);
  const hasSource = Boolean(p.fileDocument||p.result || p.slots.some(slot => slot.name));
  const step = stages.indexOf(p.stage), selectedTask = POSTPROCESS_TASK_CHOICES.find(task => task.id === p.task);
  const tasks = scientific?.tasks.filter(id=>id!=='unknown').map(id => {const choice=POSTPROCESS_TASK_CHOICES.find(task=>task.id===id);return choice?`${choice.label} ${choice.code}`:id==='md'?'分子动力学 MD':id.toUpperCase();});
  const sourceDescription = waveOnly && p.engine!=='xtb' ? `${p.engine==='unknown'?'Molden（生产软件未确认）':engineName} / 已保存波函数` : `${engineName} / ${tasks?.length ? tasks.join(' + ') : '任务未确认'}`;
  return <aside className="postprocess-sidebar workflow-panel-content" aria-label="后处理文件与数值" data-testid="postprocess-sidebar">
    <WorkflowHeader title="后处理" engine={p.engine === 'gaussian' || p.engine === 'orca' ? p.engine : null} disabled={p.busy} onEngine={p.onEngine}>{p.onClose && <button type="button" className="icon-button" onClick={p.onClose} aria-label="收起后处理侧栏">×</button>}</WorkflowHeader>
    <WorkflowSteps label="后处理步骤" steps={steps} step={step} disabled={p.busy} onStep={index => p.onStage(stages[index])}/>
    <WorkflowContentCard title={p.stage === 'software' ? '选择软件' : p.stage === 'tasks' ? `${engineName} · 选择任务` : '计算文件'} description={p.stage === 'files' ? hasSource ? sourceDescription : `${engineName} / ${selectedTask?.label ?? ''} ${selectedTask?.code ?? ''}` : undefined} step={step} total={steps.length}>
    {p.stage === 'software' && <SoftwareChooser disabled={p.busy} onChoose={p.onEngine} description="选择已有结果所属的软件。" content={{ gaussian: { description: 'Gaussian 输出与 FCHK / FCH 波函数。' }, orca: { description: 'ORCA 输出与 Molden 波函数。' } }}/>}
    {p.stage === 'tasks' && <div className="step-content task-step engine-step-content"><InputSettingsLayout><InputTaskPicker groups={TASK_GROUPS} value={p.task} onChange={p.onTask} disabled={p.busy || p.engine === 'cp2k'} ariaLabel="后处理任务" tasks={POSTPROCESS_TASK_CHOICES.map(task => { const Icon = taskIcons[task.id as keyof typeof taskIcons] ?? FlaskConical; return { ...task, disabled: !unifiedTasks.has(task.id), icon: <Icon size={22} strokeWidth={1.6}/> }; })}/></InputSettingsLayout></div>}
    {p.stage === 'files' && <div className="postprocess-file-content engine-step-content">
      <div className="postprocess-files-grid">{fileSlots.map((slot,index) => {
        const role=slot.role;
        const displayedSlot = role === 'output' && !slot.name && p.task === 'trajectory' ? { ...slot, format: 'xyz' as const } : slot;
        return <FileSlot key={`${p.engine}:${slot.slotKey??role}:${slot.sourceId??index}`} engine={p.engine} slot={displayedSlot} busy={p.busy} onFiles={(files,replace) => p.onFiles(role, files,replace,slot.slotKey,slot.sourceId)} onRemove={() => p.onRemove(role,slot.slotKey,slot.sourceId)}/>;
      })}</div>
      {p.engine === 'orca' && <details className="postprocess-guide"><summary>只有 GBW？</summary><p>请用 ORCA 自带工具转换为 Molden 后补入。</p><code>orca_2mkl basename -molden</code></details>}
      {p.message && <PostprocessSourceFeedback key={p.message} message={p.message}/>}
      {hasSource && <PostprocessSourceInformation result={p.result} fileDocument={p.fileDocument} onFileJob={p.onFileJob} currentIndex={p.currentIndex} metadata={p.metadata} sourceDifferences={p.sourceDifferences} busy={p.busy} onExtract={p.onExtract} onPrepareInput={p.onPrepareInput}/>}
    </div>}
    </WorkflowContentCard>
  </aside>;
}
