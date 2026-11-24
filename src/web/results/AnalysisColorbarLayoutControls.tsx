import { useRef, useState } from 'react';
import { DismissibleNotice } from '../DismissibleNotice';
import { InputSettingsField } from '../InputSettingsFields';
import { InputSettingsAction } from '../InputSettingsLayout';
import { ANALYSIS_COLORBAR_FONTS, ANALYSIS_COLORBAR_LIMITS, DEFAULT_ANALYSIS_COLORBAR_LAYOUT, normalizeAnalysisColorbarLayout,
  type AnalysisColorbarLayout } from './analysis-colorbar-layout';
import type { AnalysisColorbar } from './analysis-display';
import { exportAnalysisColorbar } from './analysis-colorbar-export';
import ResultNumberFormatFields from './ResultNumberFormatFields';
import './analysis-colorbar.css';

interface PaletteControls {
  colors: readonly string[];
  reverse?: boolean;
  zeroCentered?: boolean;
  labelPrefix: string;
  onChange(colors: readonly string[]): void;
}
export interface AnalysisColorbarLayoutControlsProps {
  layout?: AnalysisColorbarLayout;
  onChange(layout: AnalysisColorbarLayout): void;
  disabled?: boolean;
  colorbar?: AnalysisColorbar | null;
  palette?: PaletteControls;
}

const positions = [
  { id: 'bottom-right', label: '右下', x: .82, y: .9 },
  { id: 'bottom', label: '下方居中', x: .5, y: .9 },
  { id: 'top', label: '上方居中', x: .5, y: .1 },
  { id: 'left', label: '左侧居中', x: .1, y: .5 },
  { id: 'right', label: '右侧居中', x: .9, y: .5 },
  { id: 'center', label: '居中', x: .5, y: .5 },
] as const;

/** The same palette coordinates are consumed by mesh, legend and export. */
function AnalysisColorbarPalette({ colors, reverse, zeroCentered, labelPrefix, onChange, disabled }: PaletteControls & { disabled?: boolean }) {
  const ordered = reverse ? [...colors].reverse() : colors;
  return <>{ordered.map((color, index) => {
    const label = index === 0 ? '低值色' : index === ordered.length - 1 ? '高值色'
      : ordered.length === 3 ? (zeroCentered ? '零点色' : '中值色') : `色阶 ${index + 1}`;
    return <InputSettingsField key={index} label={label} controlWidth="short">
      <input type="color" aria-label={labelPrefix + label} disabled={disabled} value={color} onChange={event => {
        const selected = event.currentTarget.value;
        const next = ordered.map((value, i) => i === index ? selected : value);
        onChange(reverse ? next.reverse() : next);
      }}/>
    </InputSettingsField>;
  })}</>;
}

export default function AnalysisColorbarLayoutControls({ layout, onChange, disabled, colorbar, palette }: AnalysisColorbarLayoutControlsProps) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<{ source?: string; message: string } | null>(null);
  const value = normalizeAnalysisColorbarLayout(layout ?? colorbar?.layout);
  const position = positions.find(row => row.x === value.x && row.y === value.y)?.id ?? 'custom';
  const set = (change: Partial<AnalysisColorbarLayout>) => onChange(normalizeAnalysisColorbarLayout({ ...value, ...change }));
  const save = (format: 'svg' | 'png') => {
    const doc = root.current?.ownerDocument;
    if (!colorbar || !doc) return;
    setError(null);
    void exportAnalysisColorbar(colorbar, format, doc).catch(cause =>
      setError({ source: colorbar.sourceKey, message: cause instanceof Error ? cause.message : String(cause) }));
  };
  const { length, thickness, fontSize } = ANALYSIS_COLORBAR_LIMITS;
  return <div ref={root} className="analysis-colorbar-layout-controls" role="group" aria-label="色标外观">
    {palette && <AnalysisColorbarPalette {...palette} disabled={disabled}/>}
    <InputSettingsField label="方向"><select aria-label="色标方向" disabled={disabled} value={value.orientation}
      onChange={event => set({ orientation: event.currentTarget.value as AnalysisColorbarLayout['orientation'] })}>
      <option value="horizontal">横向</option><option value="vertical">纵向</option>
    </select></InputSettingsField>
    <InputSettingsField label="位置"><select aria-label="色标位置" disabled={disabled} value={position} onChange={event => {
      const next = positions.find(row => row.id === event.currentTarget.value);
      if (next) set({ x: next.x, y: next.y });
    }}>
      {positions.map(row => <option value={row.id} key={row.id}>{row.label}</option>)}
      {position === 'custom' && <option value="custom">手动位置</option>}
    </select></InputSettingsField>
    <InputSettingsField label="长度" controlWidth="short">
      <input type="range" aria-label="色标长度" min={length.min * 100} max={length.max * 100} step={1}
        disabled={disabled} value={Math.round(value.length * 100)} onChange={event => set({ length: event.currentTarget.valueAsNumber / 100 })}/>
      <output>{Math.round(value.length * 100)}%</output>
    </InputSettingsField>
    <InputSettingsField label="厚度" controlWidth="short">
      <input type="range" aria-label="色标厚度" {...thickness} step={1} disabled={disabled} value={value.thickness}
        onChange={event => set({ thickness: event.currentTarget.valueAsNumber })}/>
      <output>{value.thickness} px</output>
    </InputSettingsField>
    <InputSettingsField label="字体"><select aria-label="色标字体" disabled={disabled} value={value.fontFamily}
      onChange={event => set({ fontFamily: event.currentTarget.value as AnalysisColorbarLayout['fontFamily'] })}>
      {Object.entries(ANALYSIS_COLORBAR_FONTS).map(([id, font]) => <option key={id} value={id}>{font.label}</option>)}
    </select></InputSettingsField>
    <InputSettingsField label="字号" controlWidth="short">
      <input type="range" aria-label="色标字号" {...fontSize} step={1} disabled={disabled} value={value.fontSize}
        onChange={event => set({ fontSize: event.currentTarget.valueAsNumber })}/>
      <output>{value.fontSize} px</output>
    </InputSettingsField>
    <InputSettingsField label="文字颜色" controlWidth="short"><input type="color" aria-label="色标文字颜色" disabled={disabled} value={value.ink}
      onChange={event => set({ ink: event.currentTarget.value })}/></InputSettingsField>
    <ResultNumberFormatFields labelPrefix={palette?.labelPrefix ? palette.labelPrefix + '色标' : '色标'}
      value={value.numberFormat} fallbackDigits={colorbar?.decimals ?? 2} disabled={disabled}
      onChange={numberFormat => set({ numberFormat })}/>
    <InputSettingsAction disabled={disabled} onClick={() => onChange({ ...DEFAULT_ANALYSIS_COLORBAR_LAYOUT })}>重置色标</InputSettingsAction>
    {colorbar && <>
      <InputSettingsAction disabled={disabled} onClick={() => save('svg')}>导出色标 SVG</InputSettingsAction>
      <InputSettingsAction disabled={disabled} onClick={() => save('png')}>导出透明色标 PNG</InputSettingsAction>
    </>}
    {error && error.source === colorbar?.sourceKey && <DismissibleNotice onDismiss={() => setError(null)}>{error.message}</DismissibleNotice>}
  </div>;
}
