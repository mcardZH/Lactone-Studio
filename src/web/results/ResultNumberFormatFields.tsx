import { normalizeResultNumberFormat, type ResultNumberFormat, type ResultNumberFormatMode } from '../../results/numeric-format';
import { InputSettingsField } from '../InputSettingsFields';
import NumericInput from '../NumericInput';

export default function ResultNumberFormatFields({ value, onChange, fallbackDigits, onFallbackDigitsChange, labelPrefix, disabled }: {
  value?: ResultNumberFormat;
  onChange(value: ResultNumberFormat | undefined): void;
  fallbackDigits: number;
  onFallbackDigitsChange?(digits: number): void;
  labelPrefix: string;
  disabled?: boolean;
}) {
  const format = normalizeResultNumberFormat(value);
  const minimum = format?.mode === 'significant' ? 1 : 0;
  const digitsLabel = format?.mode === 'significant' ? '有效位数' : '小数位数';
  return <>
    <InputSettingsField label="数值格式"><select aria-label={labelPrefix + '数值格式'} disabled={disabled}
      value={format?.mode ?? 'legacy'} onChange={event => {
        const mode = event.currentTarget.value;
        onChange(mode === 'legacy' ? undefined : normalizeResultNumberFormat({ mode: mode as ResultNumberFormatMode, digits: format?.digits ?? fallbackDigits }));
      }}>
      <option value="legacy">原有格式</option>
      <option value="decimal">小数位</option>
      <option value="significant">有效数字</option>
    </select></InputSettingsField>
    {(format || onFallbackDigitsChange) && <InputSettingsField label={digitsLabel} controlWidth="short">
      <NumericInput stepper min={minimum} max={8} step={1} value={format?.digits ?? fallbackDigits} disabled={disabled}
        aria-label={labelPrefix + digitsLabel} onChange={event => {
          const digits = event.currentTarget.valueAsNumber;
          if (!Number.isInteger(digits) || digits < minimum || digits > 8) return;
          if (format) onChange({ mode: format.mode, digits });
          else onFallbackDigitsChange?.(digits);
        }}/>
    </InputSettingsField>}
  </>;
}
