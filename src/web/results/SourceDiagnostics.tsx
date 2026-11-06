import type { ResultDiagnostic } from '../../results/contracts';
import DialogShell from '../DialogShell';
import './SourceDiagnostics.css';
import {PostprocessScientificStatus,postprocessPathTable} from './PostprocessFileInformation';
import {ScientificDataTable} from './ScientificDataTable';

const status = { completed: '正常结束', incomplete: '未完成', failed: '失败', unknown: '未知' };
const keepSourcePrecision=()=>{};
export default function SourceDiagnostics({ items, onClose, onRemove }: { items: readonly ResultDiagnostic[]; onClose(): void; onRemove(id: string): void }) {
  return <DialogShell aria-label="来源诊断" className="modal source-diagnostics" backdropClassName="modal-backdrop" onCancel={onClose}>
    <div className="source-diagnostics-heading"><h2>来源诊断</h2><button onClick={onClose}>关闭</button></div>
    <p>以下来源保留文件级信息、状态和已打印数值，可随项目保存。</p>
    <div className="source-diagnostics-list">{items.map(item => { const data = item.scientific, diagnostics = data.diagnostics;
      return <article key={item.id} data-diagnostic-id={item.id}>
        <div className="source-diagnostics-heading"><h3>{item.label}</h3><button aria-label={'移除来源诊断 ' + item.label} onClick={() => onRemove(item.id)}>移除</button></div>
        <dl><dt>来源</dt><dd>{item.source.name} · {item.source.size.toLocaleString()} bytes · {item.engine === 'gaussian' ? 'Gaussian' : item.engine === 'orca' ? 'ORCA' : '未知程序'} {data.version ?? ''}</dd>
          <dt>作业</dt><dd>{item.jobIndex === null ? '未关联作业' : `job ${item.jobIndex + 1} · 段 ${item.segmentIndex + 1}`} · {item.sourceRole === 'input' ? '输入请求（未运行）' : item.sourceRole === 'auxiliary' ? '辅助来源' : status[item.status]}</dd>
          <dt>电荷 / 多重度</dt><dd>{item.charge ?? '未知'} / {item.multiplicity ?? '未知'}</dd>
        </dl>
        <PostprocessScientificStatus data={data}/>
        {data.inputGeometry&&<p>输入 / 起始结构 · {data.inputGeometry.structure.atoms.length} 原子 · 原文第 {data.inputGeometry.sourceLine}–{data.inputGeometry.endSourceLine} 行</p>}
        {(['absolute','relative-to-ts'] as const).map(reference=>{const projection=postprocessPathTable(data,reference);return projection.rows.length?<ScientificDataTable key={reference} title={reference==='relative-to-ts'?'相对 TS 路径能量':'路径能量'} projection={projection} selectionScope={`${item.id}:${reference}`} format={{decimals:2,onDecimalsChange:keepSourcePrecision,locked:true}}/>:null;})}
        {item.messages.map((message, index) => <p key={index}>{message}</p>)}
        {diagnostics?.errors.map((error, index) => <div key={index}><span>原文第 {error.sourceLine} 行 · {error.category}</span><pre>{error.raw}</pre></div>)}
        {data.summary.length > 0 && <dl>{data.summary.map((field, index) => <div key={index}><dt>{field.label}{field.origin === 'input-request' ? '（输入请求）' : field.origin === 'observation' ? '（观测）' : ''}</dt><dd>{field.rawValue ?? field.value} {field.unit ?? ''} · 第 {field.sourceLine} 行</dd></div>)}</dl>}
        {data.printedRoute || data.route ? <details><summary>输入 / 路线原文</summary><pre>{data.printedRoute || data.route}</pre></details> : null}
      </article>;
    })}</div>
  </DialogShell>;
}
