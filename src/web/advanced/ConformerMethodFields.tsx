import { isPesNetMethod, isPesTrainedStateNetMethod } from '../../modeling/pes/contracts';
import { InputSettingsField } from '../InputSettingsFields';
import { netMethods } from '../modeling/tool-session';

export function ConformerMethodField({ method, onChange, ariaLabel, xtb, disabled, retainedLabel }: {
  method: string; onChange(method: string): void; ariaLabel: string;
  xtb: readonly (readonly [string, string])[];
  disabled?: boolean; retainedLabel?: string;
}) {
  const selected = xtb.find(([id]) => id === method)?.[1] ?? (isPesNetMethod(method) ? netMethods[method] : method);
  const retained = !xtb.some(([id]) => id === method);
  const methodTitle=isPesTrainedStateNetMethod(method)?`${selected} 使用训练态，电荷和多重度用于记录结构来源。`:selected;
  return <InputSettingsField label="计算级别" className="conformer-choice-field" controlWidth="select">
    <select aria-label={ariaLabel} title={retainedLabel ?? methodTitle} value={method} disabled={disabled} onChange={event => onChange(event.currentTarget.value)}>
      {retained && <option value={method} disabled>{retainedLabel ?? `${selected}（当前体系不可用）`}</option>}
      <optgroup label="xTB">{xtb.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</optgroup>
    </select>
  </InputSettingsField>;
}
