/** Same-geometry BB-CP energies in the caller's common energy unit.
 * Own-basis energies must use the fragment coordinates in this complex, rather
 * than separately optimized monomers; no deformation energy is inferred. */
export function counterpoiseInteraction(complex: number, fragments: readonly { ghost: number; ownBasis: number }[]) {
  if (fragments.length < 2 || !Number.isFinite(complex) || fragments.some(fragment => !Number.isFinite(fragment.ghost) || !Number.isFinite(fragment.ownBasis))) {
    throw new Error('CP交互能需要完整复合物及至少两个片段的同几何ghost/自身基组有限能量。');
  }
  const uncorrected = complex - fragments.reduce((sum, fragment) => sum + fragment.ownBasis, 0);
  const corrected = complex - fragments.reduce((sum, fragment) => sum + fragment.ghost, 0);
  return { uncorrected, corrected, bsseCorrection: corrected - uncorrected };
}
