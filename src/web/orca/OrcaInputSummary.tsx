import { useMemo, useState } from 'react';
import { Code2, FlaskConical } from 'lucide-react';
import { buildOrca, getOrcaMethodProfile, type OrcaJobRequest } from '../../core/orca';
import { ORCA_TASKS } from './task-catalog';

export interface OrcaInputSummaryProps { request: OrcaJobRequest; hidden?: boolean }

export default function OrcaInputSummary({ request, hidden = false }: OrcaInputSummaryProps) {
  const result = useMemo(() => buildOrca(request), [request]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const selectedIndex = previewIndex < result.files.length ? previewIndex : 0;
  const file = result.files[selectedIndex];
  const settings = request.settings;
  const method = getOrcaMethodProfile(settings.method, settings.version);
  const errors = result.issues.filter(issue => issue.severity === 'error');
  const multiscale = settings.multiscale;
  return <section className="work-card summary-card" data-engine-summary="orca" tabIndex={-1} hidden={hidden} style={hidden ? { display: 'none' } : undefined}>
    <div className="preview-card-heading"><h2><FlaskConical size={15} />ORCA 当前计算方案</h2><span className="recommend-tag">可修改</span></div>
    <dl>
      <div><dt>计算任务</dt><dd>{ORCA_TASKS.find(task => task.id === settings.task)?.label ?? settings.task}</dd></div>
      <div><dt>计算方法</dt><dd>{method?.label ?? settings.method}</dd></div>
      <div><dt>基组 / 级别</dt><dd>{method?.basisPolicy === 'uniform-def2' ? settings.basis : method?.basisPolicy === 'builtin' ? '方法内置' : '无轨道基组'}</dd></div>
      <div><dt>{settings.task === 'tdopt' ? '任务参考电荷 / 多重度' : '基础电荷 / 多重度'}</dt><dd>{request.charge} / {request.multiplicity}{!request.electronicStateConfirmed && <span className="pending-tag">待确认</span>}</dd></div>
      {multiscale.mode !== 'none' && <div><dt>QM 区域</dt><dd>{multiscale.qmAtomIds.length} 原子 · {multiscale.mode} · {multiscale.qmCharge} / {multiscale.qmMultiplicity}</dd></div>}
      <div><dt>计算资源</dt><dd>{request.cores} 核 · {request.memoryGB} GB</dd></div>
    </dl>
    <div className="route-preview-label"><Code2 size={12} />ORCA 实际输入预览<span className="preview-validation-badge">{errors.length ? '待补齐' : '与生成输入一致'}</span></div>
    {!!result.issues.length && <ul className="orca-issues" aria-label="ORCA右侧预览校验">{result.issues.map((issue, index) => <li className={issue.severity} key={`${issue.field}-${index}`}><span>{issue.message}</span></li>)}</ul>}
    {file ? <><label className="field">预览文件（{result.files.length}）<select aria-label="ORCA右侧预览文件" value={selectedIndex} onChange={event => setPreviewIndex(Number(event.target.value))}>{result.files.map((entry, index) => <option value={index} key={entry.name}>{entry.name} · {entry.role}</option>)}</select></label><code className="route-preview full-input-preview" aria-label="完整ORCA输入预览">{file.text}</code></> : <p className="orca-note" role="status">请补齐校验项后查看实际生成文件。</p>}
  </section>;
}
