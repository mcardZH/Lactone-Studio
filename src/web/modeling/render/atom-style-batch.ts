/** Apply the fully resolved structural styles, after all per-atom overlays.
 * Locked GLModel.setStyle scans the whole model and resets every cap per call.
 * Its public predicate selector lets equal final styles share one such scan.
 * Numeric selectors remain the compatibility path for other model adapters.
 */
export function applyResolvedAtomStyles(model: any, styles: readonly any[], fallback: (index: number, style: any) => void): void {
  if (typeof model?.setStyle !== 'function' || typeof model.atomIsSelected !== 'function') {
    for (let index = 0; index < styles.length; index++) fallback(index, styles[index]);
    return;
  }
  // These styles come from structureAtomStyle plus finite opacity overlays:
  // plain nested records of colors, radii, scales and booleans, with no callbacks.
  const groups = new Map<string, { style: any; indices: Set<number> }>();
  for (let index = 0; index < styles.length; index++) {
    const style = styles[index], key = JSON.stringify(style);
    const group = groups.get(key);
    if (group) group.indices.add(index);
    else groups.set(key, { style, indices: new Set([index]) });
  }
  for (const { style, indices } of groups.values()) {
    const first = indices.values().next().value!;
    model.setStyle(indices.size === 1 ? { index: first } : { predicate: (atom: { index: number }) => indices.has(atom.index) }, style);
  }
}
