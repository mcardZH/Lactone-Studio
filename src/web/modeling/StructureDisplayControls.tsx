import type { DisplaySettings } from '../../modeling/contracts';
import { DISPLAY_SCALE_LIMITS, displayScale } from './structure-display';
import { depthFadeAmount } from './render/depth-fade';
import './structure-display-controls.css';
import NumericInput from '../NumericInput';

/** One Global structure appearance control for modeling and read-only views. */
export default function StructureDisplayControls({ display, onChange, representationLabel = '模型样式' }: {
  display: DisplaySettings; onChange(display: DisplaySettings): void; representationLabel?: string;
}) {
  const changeScale = (key: 'atomScale' | 'bondScale', value: number) => { if (Number.isFinite(value)) onChange({ ...display, [key]: displayScale(value) }); };
  return <span className="model-structure-display" role="group" aria-label="结构样式与尺寸">
    <label>样式<select aria-label={representationLabel} value={display.representation} onChange={event => onChange({ ...display, representation: event.currentTarget.value as DisplaySettings['representation'] })}>
      <option value="vdw">VDW</option><option value="ball-stick">CPK</option><option value="stick">Licorice</option>
    </select></label>
    {(['atomScale', 'bondScale'] as const).map(key => {
      const label = key === 'atomScale' ? '全局球倍率' : '全局键倍率';
      const disabled = key === 'atomScale' ? display.representation === 'stick' : display.representation === 'vdw';
      return <label key={key} className="model-structure-size">{key === 'atomScale' ? '球' : '键'}
        <input type="range" aria-label={`${label}滑杆`} min={DISPLAY_SCALE_LIMITS.min} max={DISPLAY_SCALE_LIMITS.max} step="0.05" value={displayScale(display[key])} disabled={disabled} onChange={event => changeScale(key, event.currentTarget.valueAsNumber)}/>
        <NumericInput aria-label={label} min={DISPLAY_SCALE_LIMITS.min} max={DISPLAY_SCALE_LIMITS.max} step="0.05" value={displayScale(display[key])} disabled={disabled} onChange={event => changeScale(key, event.currentTarget.valueAsNumber)}/><span>×</span>
      </label>;
    })}
    <label className="model-structure-size">深度渐淡
      <input type="range" aria-label="全局深度渐淡滑杆" min="0" max="1" step="0.05" value={depthFadeAmount(display.depthFade)} onChange={event=>onChange({...display,depthFade:depthFadeAmount(event.currentTarget.valueAsNumber)})}/>
      <NumericInput aria-label="全局深度渐淡" min="0" max="1" step="0.05" value={depthFadeAmount(display.depthFade)} onChange={event=>{if(Number.isFinite(event.currentTarget.valueAsNumber))onChange({...display,depthFade:depthFadeAmount(event.currentTarget.valueAsNumber)});}}/>
    </label>
  </span>;
}
