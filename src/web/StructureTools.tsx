import {DismissibleNotice} from './DismissibleNotice';
import NumericInput from './NumericInput';
import { useEffect, useRef, useState } from 'react';
import { Atom, Pencil, RotateCcw, Undo2, X } from 'lucide-react';
import type { Structure } from '../core/types';
import { chemistryInput, chemistryStructure, startChemistry } from './chemistry';
export default function StructureTools({structure,charge,canUndo,onChange,onUndo,onRestore,onEdit,hideEdit=false}:{structure:Structure|null;charge:number;canUndo:boolean;onChange:(structure:Structure)=>void;onUndo:()=>void;onRestore:()=>void;onEdit:()=>void;hideEdit?:boolean}){
  const [steps,setSteps]=useState(300);const [busy,setBusy]=useState(false);const [status,setStatus]=useState('');const [error,setError]=useState('');
  const task=useRef<ReturnType<typeof startChemistry>|null>(null);
  const currentSource=useRef({key:'',revision:0});
  const sourceKey=JSON.stringify([structure,charge]);
  if(currentSource.current.key!==sourceKey)currentSource.current={key:sourceKey,revision:currentSource.current.revision+1};
  useEffect(()=>()=>task.current?.cancel(),[]);
  async function run(operation:'hydrogens'|'generate3d'|'optimize'){
    if(!structure)return;setError('');
    if(!Number.isSafeInteger(steps)||steps<1||steps>2000){setError('力场步数上限须为1–2000的整数。');return;}
    const sourceRevision=currentSource.current.revision;
    setBusy(true);setStatus('载入本地化学内核…');
    try{const input=chemistryInput(structure);input.charge=charge;const job=startChemistry(operation,input,'auto',setStatus,steps);task.current=job;const result=await job.promise;if(sourceRevision!==currentSource.current.revision)throw new Error('处理期间结构或电荷已改变，旧建模结果已丢弃；当前结构保留。');onChange(chemistryStructure(result,structure,structure.name));setStatus(operation==='hydrogens'?`加氢完成：${structure.atoms.length} → ${result.atoms.length}原子；请复核电子态。`:`${result.forcefield}：${result.before?.toFixed(4)} → ${result.after?.toFixed(4)} ${result.unit}；尝试${result.attempted}/${result.maximum}步，仅初猜预整理。`);}catch(error){setError((error as Error).message);setStatus('未替换当前结构。');}finally{task.current=null;setBusy(false);}
  }
  return <section className="structure-tools"><div className="subheading"><h3><Atom size={15}/>绘制与本地建模</h3><span className="field-caption">主动操作才改变结构</span></div><div className="structure-tool-buttons">{!hideEdit&&<button className="button button-white" onClick={onEdit} disabled={busy}><Pencil size={14}/>{structure?'二维编辑分子':'画一个分子'}</button>}<button className="button button-white" disabled={!structure||busy} onClick={()=>run('hydrogens')}>一键加氢</button><button className="button button-quiet" disabled={!canUndo||busy} onClick={onUndo}><Undo2 size={14}/>撤销</button><button className="button button-quiet" disabled={!structure||busy} onClick={onRestore}><RotateCcw size={14}/>恢复导入原结构</button></div>
    <details className="local-forcefield"><summary>生成三维 / 小力场预整理</summary><label className="field">附加精修步数上限<NumericInput aria-label="力场步数上限" disabled={busy}  min="1" max="2000" step="1" value={steps} onChange={event=>setSteps(Number(event.target.value))}/></label><div className="structure-tool-buttons"><button className="button button-white" disabled={!structure||busy} onClick={()=>run('generate3d')}>生成三维并预整理</button><button className="button button-white" disabled={!structure||structure.dimension===2||busy} onClick={()=>run('optimize')}>保持当前三维起点优化</button></div><p className="muted-note">自动采用MMFF94，仅参数化不支持时尝试UFF；结果显示实际力场及能量单位。生成三维会补齐隐式氢，已有三维优化保留原坐标起点与原子集。最多500原子，60秒超时，可取消；不是DFT优化或全局构象搜索。</p></details>
    <p className="muted-note">加氢依据连接表、键级与形式电荷，不做pH质子化；生成三维会补齐隐式氢，单独力场优化不补氢。XYZ/PDB缺失成键信息时会推断，配位体系尤其需要复核。原结构保留，可撤销。</p>
    {busy&&<button className="button button-white" onClick={()=>task.current?.cancel()}><X size={14}/>取消本地计算</button>}{status&&<p className="chemistry-status" role="status">{status}</p>}{error&&<DismissibleNotice className="inline-selection-error" role="alert">{error}</DismissibleNotice>}
  </section>;
}
