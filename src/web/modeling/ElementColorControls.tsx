import NumericInput from '../NumericInput';
import type { Atom } from '../../core/types';
import { useState } from 'react';
import { ELEMENTS } from '../../core/elements';
import type { DisplaySettings } from '../../modeling/contracts';
import { elementColor } from './render/element-colors';
import ElementTable from './ElementTable';
import { DISPLAY_SCALE_LIMITS, displayScale } from './structure-display';
import './element-color-controls.css';
import { isSelectableStructureAppearancePreset } from '../../modeling/appearance-presets';

export const DISPLAY_ATOM_SCALE_LIMITS = DISPLAY_SCALE_LIMITS;
export { displayScale } from './structure-display';
export function restoreElementAppearance(display: DisplaySettings, element: string): DisplaySettings {
  const elementColors={...display.elementColors},elementScales={...display.elementScales};
  delete elementColors[element];delete elementScales[element];
  return {...display,elementColors,elementScales};
}
export function restoreAllElementAppearance(display: DisplaySettings): DisplaySettings {
  const {elementColors: _colors,elementScales: _scales,atomScale: _scale,...other}=display;
  return other;
}

export default function ElementColorControls({ atoms, display, onChange,hideAlignment=false,forceCustom=false }: {
  atoms: readonly Atom[]; display: DisplaySettings; onChange: (display: DisplaySettings) => void;hideAlignment?:boolean;forceCustom?:boolean;
}) {
  const [element, setElement] = useState(() => atoms.find(atom => ELEMENTS.includes(atom.element))?.element ?? 'C');
  const presentElements = new Set(atoms.map(atom => atom.element));
  const custom = forceCustom || !isSelectableStructureAppearancePreset(display.structurePreset);
  const restoreElement = () => {
    if (custom) { onChange(restoreElementAppearance(display, element)); return; }
    const elementScales = { ...display.elementScales }; delete elementScales[element];
    onChange({ ...display, elementScales });
  };
  const restoreAll = () => {
    if (custom) { onChange(restoreAllElementAppearance(display)); return; }
    const { elementScales: _scales, ...other } = display; onChange(other);
  };
  return <><details className="model-element-colors" data-testid="model-element-color-controls">
    <summary>{custom ? '元素配色与球大小' : '元素球大小'}</summary>
    <ElementTable onSelect={setElement} selectedElement={element} colors={display.elementColors??{}} presentElements={presentElements}/>
    <div className="model-element-appearance-fields">
      {custom && <label><strong>{element}</strong> 元素颜色<input type="color" aria-label={`${element}元素颜色`} value={elementColor(element,display.elementColors)} onChange={event => onChange({ ...display, elementColors: { ...display.elementColors, [element]: event.currentTarget.value } })} /></label>}
      <label>{element} 球倍率<NumericInput min={DISPLAY_ATOM_SCALE_LIMITS.min} max={DISPLAY_ATOM_SCALE_LIMITS.max} step="0.05" aria-label={`${element}元素球倍率`} value={displayScale(display.elementScales?.[element])} onChange={event=>{const value=event.currentTarget.valueAsNumber;if(Number.isFinite(value))onChange({...display,elementScales:{...display.elementScales,[element]:displayScale(value)}});}}/><span>×</span></label>
    </div>
    <div className="model-element-appearance-actions"><button type="button" onClick={restoreElement}>恢复 {element} 默认</button><button type="button" onClick={restoreAll}>恢复全部元素默认</button></div>
    <p className="model-element-appearance-note">{element}{presentElements.has(element)?' · 当前结构中存在':' · 当前结构中未出现'}；球大小仅改变显示。</p>
  </details>
    {!hideAlignment&&<label className="model-observation-alignment">动态帧叠合
      <select aria-label="动态帧叠合" value={display.alignment ?? 'auto'} onChange={event => onChange({ ...display, alignment: event.currentTarget.value as DisplaySettings['alignment'] })}>
        <option value="auto">稳定主体（默认）</option><option value="heavy">全部重原子</option><option value="off">关闭</option>
      </select>
      <small>只调整观察画面</small>
    </label>}
  </>;
}
