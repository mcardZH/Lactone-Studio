import {DismissibleNotice} from '../DismissibleNotice';
import { currentHessianSourceFields, defaultHessianPath, hessianPathContext, hessianPathShapeErrors, ircStartContext } from '../../core/orca/hessian-path';
import type { OrcaAsset, OrcaHessianPathEvidence, OrcaJobRequest } from '../../core/orca/types';
import { SolventControls } from '../SolventControls';

type Evidence = NonNullable<OrcaAsset['hessianEvidence']>;
export default function OrcaHessianPathEvidence({ asset, request, onChange }: {
  asset: OrcaAsset; request: OrcaJobRequest; onChange: (value: Evidence) => void;
}) {
  const e = asset.hessianEvidence ?? { state: '', source: '', charge: NaN, multiplicity: NaN,
    geometryUnits: 'bohr' as const, minimumConfirmed: false, atomOrderConfirmed: false };
  const p = e.path ?? defaultHessianPath(request);
  const matching = typeof p.targetContext === 'string' && !p.targetContext.startsWith('invalid-hessian-path') && p.targetContext === hessianPathContext(request, { ...asset, hessianEvidence: { ...e, path: p } });
  function patch(value: Partial<OrcaHessianPathEvidence>) {
    onChange({ ...e, path: { ...p, ...value, compatibilityConfirmed: false, transitionStateConfirmed: false, targetContext: '' } });
  }
  function confirm(field: 'compatibilityConfirmed' | 'transitionStateConfirmed', checked: boolean) {
    const path = { ...p, [field]: checked }, next = { ...e, path };
    path.targetContext = hessianPathContext(request, { ...asset, hessianEvidence: next });
    onChange(next);
  }
  const shapeErrors = e.path !== undefined ? hessianPathShapeErrors(asset) : [];
  if (shapeErrors.length) return <section className="orca-evidence" aria-label={`${asset.name}路径来源确认`}>
    <DismissibleNotice role="alert">来源证据格式无效：{shapeErrors.join(' ')}</DismissibleNotice>
    <button type="button" disabled={!request.structure} onClick={() => onChange(currentHessianSourceFields(request, asset))}>以当前条件填写，仍须核对</button>
  </section>;
  return <section className="orca-evidence" aria-label={`${asset.name}路径来源确认`}>
    <h4>{request.settings.task === 'irc' ? 'IRC 同一势能面来源' : 'TS 初始 Hessian 来源'}</h4>
    <button type="button" disabled={!request.structure} onClick={() => onChange(currentHessianSourceFields(request, asset))}>以当前条件填写，仍须核对</button>
    <p className="orca-note">此按钮只填写条件与原子身份；实际来源、物理态与确认需自行核对。极小点证据不能代替TS确认。</p>
    <label className="orca-field">来源确认用途<select aria-label={`${asset.name}确认用途`} value={p.purpose} onChange={event => patch({ purpose: event.target.value as typeof p.purpose })}><option value="ts-initial">TS 初始 Hessian</option><option value="irc">IRC 起始 Hessian</option></select></label>
    <label className="orca-field">来源级别关系<select aria-label={`${asset.name}级别关系`} value={p.levelRelation} onChange={event => patch({ levelRelation: event.target.value as typeof p.levelRelation })}>
      <option value="same-level">同级来源</option><option value="initial-approximation" disabled={request.settings.task === 'irc'}>明确的 TS 初始近似</option>
    </select></label>
    {p.levelRelation === 'initial-approximation' && <label className="orca-field">初始近似说明<textarea aria-label={`${asset.name}初始近似说明`} value={p.approximationNote} onChange={event => patch({ approximationNote: event.target.value })} placeholder="来源级别、为何可作初始近似；最终频率仍在目标级别验收" /></label>}
    <label className="orca-field">来源色散处理<select aria-label={`${asset.name}来源色散`} value={p.dispersion} onChange={event => patch({ dispersion: event.target.value as typeof p.dispersion })}>
      <option value="">明确选择</option><option value="none">无额外色散校正</option><option value="d3">D3</option><option value="d3bj">D3(BJ)</option><option value="d4">D4</option><option value="builtin">方法固有校正 / 非局域相关</option>
    </select></label>
    <label className="orca-field">来源环境模型<select aria-label={`${asset.name}来源环境模型`} value={p.solventModel} onChange={event => patch({ solventModel: event.target.value as typeof p.solventModel, solvation: undefined })}>
      <option value="">明确选择</option><option value="gas">气相</option><option value="cpcm">CPCM</option><option value="smd">SMD</option>
    </select></label>
    {(p.solventModel === 'cpcm' || p.solventModel === 'smd') && <div aria-label={`${asset.name}来源溶剂参数`}><SolventControls engine="orca" version="common" model={p.solventModel} solvent="" selection={p.solvation}
      onChange={change => patch({ solvation: change.solvation })} /></div>}
    <label className="orca-field">来源稳定原子 ID（按 Hessian 顺序，每行一个）<textarea aria-label={`${asset.name}路径原子身份`} value={p.atomIds.join('\n')} onChange={event => patch({ atomIds: event.target.value.split(/[\r\n]+/).filter(Boolean) })} /></label>
    <label className="orca-check"><input aria-label={`${asset.name}确认路径来源兼容`} type="checkbox" checked={p.compatibilityConfirmed === true && matching}
      onChange={event => confirm('compatibilityConfirmed', event.target.checked)} />已核对真实来源、当前用途、方法/基组/色散、环境、电子态和逐原子身份相容</label>
    {request.settings.task === 'irc' && <label className="orca-check"><input aria-label={`${asset.name}确认IRC起点TS`} type="checkbox" checked={p.transitionStateConfirmed === true && matching}
      onChange={event => confirm('transitionStateConfirmed', event.target.checked)} />已检查来源TS优化与频率模式，确认当前起点为目标反应的TS，且保持同一势能面</label>}
    {p.targetContext && !matching && <p role="status" className="orca-note">文件、来源或当前条件已变化，路径确认已失效，请重新核对。</p>}
  </section>;
}

export function OrcaIrcStartEvidence({ request, onChange }: { request: OrcaJobRequest; onChange: (request: OrcaJobRequest) => void }) {
  const e = request.settings.ircStartEvidence, context = ircStartContext(request);
  return <label className="orca-check"><input aria-label="确认IRC起点与来源条件" type="checkbox" checked={e?.confirmed === true && e.context === context}
    onChange={event => onChange({ ...request, settings: { ...request.settings, ircStartEvidence: { confirmed: event.target.checked, context } } })} />
    已检查当前TS结构、优化及频率模式，并核对IRC方法、基组、色散、环境与电子态沿用同一势能面
  </label>;
}
