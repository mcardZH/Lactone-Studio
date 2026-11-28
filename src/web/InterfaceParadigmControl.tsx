import { Moon, Sun } from 'lucide-react';
import type { InterfaceParadigm, ViewportBackdrop } from './interface-paradigm-preferences';

const PARADIGM_OPTIONS: readonly { id: InterfaceParadigm; label: string; hint: string; icon: 'sun' | 'moon' }[] = [
  { id: 'studio', label: '白天 · 苹果通透', hint: '柔影磨砂与清透留白，适配日间长时间科研办公', icon: 'sun' },
  { id: 'dark-studio', label: '夜间 · 深色影棚', hint: '低眩光深石墨暗棚，保护夜间视线并支持白底画布', icon: 'moon' },
];

const BACKDROP_OPTIONS: readonly { id: ViewportBackdrop; label: string }[] = [
  { id: 'auto', label: '跟随昼夜' },
  { id: 'white', label: '纯白投稿底' },
  { id: 'dark', label: '深色影棚底' },
];

export default function InterfaceParadigmControl({
  value,
  onChange,
  backdrop,
  onBackdropChange,
}: {
  value: InterfaceParadigm;
  onChange(value: InterfaceParadigm): void;
  backdrop?: ViewportBackdrop;
  onBackdropChange?(value: ViewportBackdrop): void;
}) {
  return <div className="interface-paradigm-control-wrap">
    <div className="interface-surface-control interface-paradigm-control" role="radiogroup" aria-label="昼夜外观模式">
      {PARADIGM_OPTIONS.map(item => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={value === item.id}
          className="interface-surface-option"
          onClick={() => onChange(item.id)}
        >
          <span className="interface-surface-option-title">
            {item.icon === 'sun' ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
            {item.label}
          </span>
          <small className="interface-surface-option-hint">{item.hint}</small>
        </button>
      ))}
    </div>
    {backdrop && onBackdropChange && (
      <div className="interface-backdrop-row" role="radiogroup" aria-label="3D 视口画布底色">
        <span className="interface-backdrop-label">3D 画布底色</span>
        {BACKDROP_OPTIONS.map(opt => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={backdrop === opt.id}
            className="interface-backdrop-chip"
            onClick={() => onBackdropChange(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    )}
  </div>;
}
