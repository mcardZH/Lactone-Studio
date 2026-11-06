/** Presentation only. Source values, scientific tolerances and file writers stay untouched. */
export const DEFAULT_RESULT_DECIMALS = 2;
export function resultDecimals(value = DEFAULT_RESULT_DECIMALS): number {
  return Number.isInteger(value) ? Math.max(0, Math.min(8, value)) : DEFAULT_RESULT_DECIMALS;
}
export function fullPrecisionValue(value: number | string | null | undefined): string {
  if (value == null || typeof value === 'number' && !Number.isFinite(value)) return '未输出';
  return typeof value === 'number' && value === 0 ? '0' : String(value);
}
export function formatResultValue(value: number | string | null | undefined, decimals = DEFAULT_RESULT_DECIMALS): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fullPrecisionValue(value);
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
