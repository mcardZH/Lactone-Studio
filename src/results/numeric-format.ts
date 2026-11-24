/** Presentation only. Source values, scientific tolerances and file writers stay untouched. */
export const DEFAULT_RESULT_DECIMALS = 2;
export type ResultNumberFormatMode = 'decimal' | 'significant';
export interface ResultNumberFormat {
  mode: ResultNumberFormatMode;
  digits: number;
}

export function normalizeResultNumberFormat(value?: ResultNumberFormat | null): ResultNumberFormat | undefined {
  if (value?.mode !== 'decimal' && value?.mode !== 'significant') return;
  const digits = resultDecimals(value.digits);
  return { mode: value.mode, digits: value.mode === 'significant' ? Math.max(1, digits) : digits };
}
export function resultDecimals(value = DEFAULT_RESULT_DECIMALS): number {
  return Number.isInteger(value) ? Math.max(0, Math.min(8, value)) : DEFAULT_RESULT_DECIMALS;
}
export function fullPrecisionValue(value: number | string | null | undefined): string {
  if (value == null || typeof value === 'number' && !Number.isFinite(value)) return '未输出';
  return typeof value === 'number' && value === 0 ? '0' : String(value);
}
/** Expand a source decimal token without passing its significant digits through Number. */
export function decimalEnergyValue(value: number | string | null | undefined): string {
  const text = fullPrecisionValue(value);
  const match = text.match(/^([+-]?)((?:\d+(?:\.\d*)?|\.\d+))[eEdD]([+-]?\d+)$/);
  if (!match) return text;
  const exponent = Number(match[3]);
  if (!Number.isSafeInteger(exponent)) return text;
  const point = match[2].indexOf('.');
  const digits = match[2].replace('.', '');
  const position = (point < 0 ? digits.length : point) + exponent;
  const decimal = position <= 0 ? '0.' + '0'.repeat(-position) + digits
    : position >= digits.length ? digits + '0'.repeat(position - digits.length)
    : digits.slice(0, position) + '.' + digits.slice(position);
  return match[1] + decimal;
}
/** Compact status only; plotted coordinates, source tokens and exports retain full precision. */
export function energySummaryValue(value: number | null | undefined, unit: string): string {
  if (value == null || !Number.isFinite(value)) return '未输出';
  const digits = unit === 'hartree' || unit === 'Eh' ? 8 : unit === 'eV' ? 6 : 4;
  const rounded = value.toFixed(digits);
  // Preserve tiny nonzero differences in decimal notation instead of displaying a false zero.
  return decimalEnergyValue(value !== 0 && Number(rounded) === 0 ? value.toPrecision(4) : rounded);
}
/** Keep the existing display precision while using calculator-friendly energy notation. */
export function formatEnergyValue(value: number | string | null | undefined, decimals = DEFAULT_RESULT_DECIMALS): string {
  return decimalEnergyValue(formatResultValue(value, decimals));
}
export function formatResultValue(value: number | string | null | undefined, decimals = DEFAULT_RESULT_DECIMALS, format?: ResultNumberFormat): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fullPrecisionValue(value);
  const explicit = normalizeResultNumberFormat(format);
  if (explicit?.mode === 'significant') return value.toPrecision(explicit.digits);
  if (explicit?.mode === 'decimal') {
    const text = value.toFixed(explicit.digits);
    return value !== 0 && Number(text) === 0 ? value.toExponential(Math.max(0, explicit.digits - 1)) : text;
  }
  const digits = resultDecimals(decimals), magnitude = Math.abs(value);
  if (magnitude === 0) return (0).toFixed(digits);
  const exponent = Math.floor(Math.log10(magnitude));
  const significantDigits = Math.max(1, digits);
  // Retain whichever carries more information: decimal places or significant digits.
  if (exponent < -4) return value.toExponential(significantDigits - 1);
  const roundedSignificant = Number(value.toPrecision(significantDigits));
  const roundedExponent = Number.isFinite(roundedSignificant) ? Math.floor(Math.log10(Math.abs(roundedSignificant))) : exponent;
  return value.toFixed(Math.max(digits, significantDigits - 1 - roundedExponent));
}
