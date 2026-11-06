import type { ReactNode } from 'react';
import AppearancePresetPicker, { type AppearancePresetCard } from '../AppearancePresetPicker';
import { appearancePreview } from '../appearance-preview-assets';
import { surfaceAppearanceChoices, type SurfaceAppearancePresetId } from '../../results/surface-appearance-presets';

export type LocalAppearanceId = SurfaceAppearancePresetId | 'custom';
/** Shared chooser; callers keep scientific values and Local state ownership. */
export default function SurfaceAppearanceControls({ value, onChange, label, children, actions, presets, namedPresets = [], selectedNamedPreset, onNamedPreset }: {
  value?: LocalAppearanceId; onChange(id: LocalAppearanceId): void; label: string;
  children?: ReactNode; actions?: ReactNode; presets?: readonly SurfaceAppearancePresetId[];
  namedPresets?: readonly AppearancePresetCard[]; selectedNamedPreset?: string; onNamedPreset?(id: string): void;
}) {
  const choices = surfaceAppearanceChoices(presets);
  // Old project/default IDs keep their actual parameters in custom mode;
  // opening this chooser never applies the new factory appearance to them.
  const selected = choices.some(row => row.id === value) ? value : 'custom';
  return <>
    <AppearancePresetPicker label={label} value={selectedNamedPreset ?? selected} presets={[...choices.map(row => ({ ...row, preview: appearancePreview('surface', row.id) })), ...namedPresets]} onChange={id => namedPresets.some(row => row.id === id) ? onNamedPreset?.(id) : onChange(id as LocalAppearanceId)} actions={actions}/>
    {!selectedNamedPreset && selected === 'custom' && children}
  </>;
}
