import {DismissibleNotice} from './DismissibleNotice';
import type { FileSettings, TaskId } from '../core/types';
import { isOptimizationTask } from '../core/tasks';
import { safeGaussianCheckpointReference } from '../core/gaussian';
import { checkpointNameCollision } from './reference-file';
import { InputSettingsAction } from './InputSettingsLayout';
import './source-options.css';
type UpdateFiles = <K extends keyof FileSettings>(key: K, value: FileSettings[K]) => void;
export interface CheckpointOptionsProps { files: FileSettings; update: UpdateFiles; task: TaskId; name: string; semi: boolean; embedded?: boolean; frequencyOnly?: boolean; batchMode?:boolean; onReset?:()=>void }
export function GeometryOptions({files,update,external=false,batchMode=false}:{files:FileSettings;update:UpdateFiles;external?:boolean;batchMode?:boolean}){
  return <div className="checkpoint-file-row"><label className="check-line"><input aria-label="读取几何" type="checkbox" checked={files.geometry!=='explicit'} disabled={external||batchMode} onChange={event=>update('geometry',event.target.checked?'check':'explicit')}/><span>读取几何</span></label><select aria-label="几何来源" value={files.geometry==='explicit'?'check':files.geometry} disabled={external||batchMode||files.geometry==='explicit'} onChange={event=>update('geometry',event.target.value as FileSettings['geometry'])}><option value="check">Geom=Check</option><option value="allcheck">Geom=AllCheck</option></select></div>;
}
export function SourceOptions({external=false,...props}:CheckpointOptionsProps&{external?:boolean}){return external?null:<CheckpointOptions {...props}/>;}
export default function CheckpointOptions({files,update,task,name,semi,frequencyOnly=false,batchMode=false,onReset}:CheckpointOptionsProps){
  const usesSource=files.readCheckpoint||files.geometry!=='explicit'||files.guessRead||['readfc','rcfc'].includes(files.hessian),reuseFrequency=task==='freq'&&files.hessian==='readfc',multistructure=task==='qst2'||task==='qst3',optimization=isOptimizationTask(task)&&!multistructure&&!frequencyOnly,hessianSupported=task==='freq'||task==='irc'||optimization,hessianReading=['readfc','rcfc'].includes(files.hessian);
  const collision=usesSource&&files.saveCheckpoint&&checkpointNameCollision(files.oldCheckpoint,files.checkpointName.trim()||`${name}.chk`);
  return <section className="checkpoint-options source-options" aria-label="Gaussian来源设置">
    <header className="shared-input-card-header"><h3 className="shared-input-card-title">CHK文件的读取与产生</h3>{onReset&&<InputSettingsAction reset ariaLabel="恢复chk默认" onClick={onReset}>恢复默认</InputSettingsAction>}</header>
    <div className="checkpoint-file-rows">
      <div className="checkpoint-file-row"><label className="check-line"><input aria-label="保存chk" type="checkbox" checked={files.saveCheckpoint} onChange={event=>update('saveCheckpoint',event.target.checked)}/><span>保存CHK</span></label><input aria-label="新CHK文件名" disabled={batchMode||!files.saveCheckpoint} placeholder={batchMode?`${name}-001.chk、${name}-002.chk…`:`${name}.chk`} value={batchMode?'':files.checkpointName} onChange={event=>update('checkpointName',event.target.value)}/></div>
      <div className="checkpoint-file-row"><label className="check-line"><input data-field="read-checkpoint" aria-label="读取chk" type="checkbox" checked={usesSource} disabled={batchMode||files.geometry!=='explicit'||multistructure||files.guessRead||hessianReading} onChange={event=>update('readCheckpoint',event.target.checked)}/><span>读取CHK</span></label><input aria-label="来源CHK文件名" value={files.oldCheckpoint} disabled={!usesSource} placeholder="可留空" onChange={event=>update('oldCheckpoint',event.target.value)}/></div>
      <GeometryOptions files={files} update={update} batchMode={batchMode}/>
      <div className="checkpoint-file-row"><label className="check-line"><input data-field="guess-read" type="checkbox" disabled={semi||reuseFrequency||task==='bsse'||multistructure} checked={files.guessRead} onChange={event=>{if(event.target.checked)update('readCheckpoint',true);update('guessRead',event.target.checked);}}/><span>读取初猜</span></label><span>Guess=Read</span></div>
      <div className="checkpoint-file-row"><label className="check-line"><input aria-label="读取Hessian" type="checkbox" checked={hessianReading} disabled={semi||!hessianSupported} onChange={event=>{if(event.target.checked)update('readCheckpoint',true);update('hessian',event.target.checked?(task==='irc'?'rcfc':'readfc'):task==='ts'||task==='irc'?'calcfc':'none');}}/><span>读取Hessian</span></label><select aria-label="来源Hessian读取" disabled={!usesSource||semi||!hessianSupported||!hessianReading} value={hessianReading?files.hessian:task==='irc'?'rcfc':'readfc'} onChange={event=>update('hessian',event.target.value as FileSettings['hessian'])}>{task!=='irc'&&<option value="readfc">ReadFC</option>}{task!=='freq'&&<option value="rcfc">RCFC</option>}</select></div>
    </div>
    {collision&&<DismissibleNotice className="reference-file-error" role="alert">来源CHK与新CHK不能同名。</DismissibleNotice>}
    {usesSource&&files.oldCheckpoint.trim()&&!safeGaussianCheckpointReference(files.oldCheckpoint.trim())&&<DismissibleNotice className="reference-file-error" role="alert">请输入ASCII安全CHK文件名或绝对路径，不含空格。</DismissibleNotice>}
  </section>;
}
