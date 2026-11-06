/** Gaussian Link 0 memory uses an integer with GB/MB/KB, or 8-byte words.
 * Preserve the requested binary GB exactly; never round it to a new budget. */
export function vibronicGaussianMemory(memoryGB: number): string | null {
  if (!Number.isFinite(memoryGB) || memoryGB <= 0) return null;
  for (const [factor, unit] of [[1, 'GB'], [1024, 'MB'], [1024 ** 2, 'KB'], [1024 ** 3 / 8, '']] as const) {
    const value = memoryGB * factor;
    if (Number.isSafeInteger(value) && value > 0) return `${value}${unit}`;
  }
  return null;
}
