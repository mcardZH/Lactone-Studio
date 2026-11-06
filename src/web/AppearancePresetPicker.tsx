import { useId, useState, type ReactNode } from 'react';
import './appearance-preset-picker.css';

export interface AppearancePresetCard {
  id: string;
  label: string;
  /** A preview rendered by this product. Reference-gallery artwork is not a preview. */
  preview?: string;
}
export interface AppearancePresetPickerProps {
  label: string;
  presets: readonly AppearancePresetCard[];
  value?: string;
  onChange(id: string): void;
  disabled?: boolean;
  actions?: ReactNode;
}

/** One inline chooser for Global structure and Local analysis appearances. */
export default function AppearancePresetPicker({ label, presets, value = 'custom', onChange, disabled, actions }: AppearancePresetPickerProps) {
  const [open, setOpen] = useState(false);
  const id = `appearance-presets-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const current = presets.find(row => row.id === value);
  return <div className="appearance-preset-picker" data-appearance-family={label} data-selected-preset={current?.id ?? 'custom'}>
    <div className="appearance-preset-toolbar">
      <button type="button" aria-label={`${label}选择预设`} aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => setOpen(shown => !shown)}>选择预设</button>
      <button type="button" aria-label={`${label}自定义`} aria-pressed={!current} disabled={disabled} onClick={() => { onChange('custom'); setOpen(false); }}>自定义</button>
      <span className="appearance-preset-current" aria-label={`${label}当前预设`}>{current?.label ?? '自定义'}</span>
      {actions}
    </div>
    {open && <div className="appearance-preset-grid" id={id} role="group" aria-label={`${label}预设`}>
      {presets.map(preset => <button key={preset.id} type="button" className="appearance-preset-card" aria-pressed={value === preset.id} disabled={disabled} onClick={() => { onChange(preset.id); setOpen(false); }}>
        {preset.preview ? <img className="appearance-preset-preview" src={preset.preview} alt="" loading="lazy"/> : <span className="appearance-preset-preview appearance-preset-preview-pending" aria-hidden="true"/>}
        <span>{preset.label}</span>
      </button>)}
    </div>}
  </div>;
}
