export type ExcitedStructureStage = 'opt' | 'freq' | 'optfreq';

/** Both input engines expose the same three stages and the separate T1 UKS route. */
export default function ExcitedStructureStageControls(p: {
  frequency?: boolean; frequencyOnly?: boolean; useUks: boolean; uksAllowed: boolean;
  onStageChange(patch: { frequency: boolean; frequencyOnly: boolean }): void;
  onUksChange(value: boolean): void;
  section?: 'stage'|'uks'|'all';
}) {
  return <div className="excited-stage-controls">
    {p.section!=='uks'&&<label className="field">计算内容<select aria-label="激发态计算内容" value={p.frequency ? p.frequencyOnly ? 'freq' : 'optfreq' : 'opt'} onChange={event => p.onStageChange({ frequency: event.target.value !== 'opt', frequencyOnly: event.target.value === 'freq' })}>
      <option value="opt">仅优化</option><option value="freq">仅频率</option><option value="optfreq">优化＋频率</option>
    </select></label>}
    {p.section!=='stage'&&<label className="check-line uks-option"><input aria-label="使用UKS优化" type="checkbox" disabled={!p.uksAllowed} checked={p.useUks} onChange={event => p.onUksChange(event.target.checked)}/><span>使用UKS（仅T1）</span></label>}
  </div>;
}
