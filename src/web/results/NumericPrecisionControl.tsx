import NumericInput from '../NumericInput';
import { resultDecimals } from '../../results/numeric-format';
import { InputSettingsField } from '../InputSettingsFields';

/** Local controlled UI: the analysis card, not this component, owns the setting. */
export default function NumericPrecisionControl({ value, onChange, label = '小数位', ariaLabel = '显示小数位', disabled = false }: {
  value: number; onChange(value: number): void; label?: string; ariaLabel?: string; disabled?: boolean;
}) {
  return <InputSettingsField label={label}><NumericInput stepper aria-label={ariaLabel} min={0} max={8} step={1}
    value={resultDecimals(value)} disabled={disabled} style={{ width: '5em' }} onChange={event => {
      const next = event.currentTarget.valueAsNumber;
      if (Number.isInteger(next) && next >= 0 && next <= 8) onChange(next);
    }}/></InputSettingsField>;
}
