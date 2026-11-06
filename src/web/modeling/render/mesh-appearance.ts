/** Only targets owned addCustom handles split below 3Dmol's 64k threshold.
 * Constant and per-vertex colors use the locked GLShape public style path;
 * never use volumetric getVal on its already-Float32 display positions. */
export function updateCustomMeshAppearance(handle: any, vertexCount: number, opacity: number, color?: string | readonly string[]): void {
  const groups = handle?.geo?.geometryGroups?.filter((group: any) => group.vertices > 0);
  if (typeof handle?.updateStyle !== 'function' || groups?.length !== 1 || groups[0].vertices !== vertexCount)
    throw new Error('当前自定义网格不具备已确认的外观更新接口。');
  if (Array.isArray(color) && color.length !== vertexCount) throw new Error('自定义网格逐顶点颜色数量不一致。');
  if (color === undefined) {
    // updateFromStyle otherwise resurrects stylespec.color after the surface
    // deleted handle.color. Avoid re-mapping an array for opacity alone and
    // retain any pending per-vertex colors even before the next globj call.
    const previous = handle.color;
    handle.updateStyle({ opacity, color: undefined });
    if (previous === undefined) delete handle.color; else handle.color = previous;
  } else handle.updateStyle({ opacity, color });
}
