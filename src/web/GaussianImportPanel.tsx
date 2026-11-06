import type { GaussianSourceMeta } from '../core/gaussian-source';
import type { TaskId } from '../core/types';
import { TASKS } from '../core/tasks';

export default function GaussianImportPanel({source,target,onTarget,onInherit,onGeometry}:{source:GaussianSourceMeta;target:TaskId;onTarget:(task:TaskId)=>void;onInherit:()=>void;onGeometry:()=>void}){
  return <section className="source-import-panel" aria-label="Gaussian来源继承">
    <h3>使用 Gaussian 文件中的设置</h3>
    <p>{source.fileName} · 作业 {source.jobIndex+1}。先选本次目标；继承只转换任务部分，不把来源任务重跑一遍。</p>
    <label className="field">本次目标任务<select aria-label="导入目标任务" value={target} onChange={event=>onTarget(event.target.value as TaskId)}>{TASKS.map(task=><option key={task.id} value={task.id}>{task.name}</option>)}</select></label>
    <details><summary>查看读取到的来源条件</summary><code>{source.route||'Route 未保存 / 未读取'}</code><p>冻结原子：{source.frozenAtoms===null?'来源无法证明':source.frozenAtoms.join(', ')||'明确未设置'}；内坐标：{source.coordinates===null?'来源无法证明':source.coordinates.length+' 项'}</p>{source.issues.map((issue,index)=><p key={index}>{issue.message}</p>)}</details>
    <div className="source-import-actions"><button className="button button-primary" onClick={onInherit}>继承级别与冻结，进入生成页</button><button className="button button-white" onClick={onGeometry}>仅使用几何，按常规设置</button></div>
  </section>;
}
