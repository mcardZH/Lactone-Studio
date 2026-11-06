/** Presentation intents only. Native model membership and analysis leases are
 * deliberately absent: each caller adapts the accepted intent to its protocol. */
export const WORKSPACE_TAB_DRAG_THRESHOLD = 7;
export interface WorkspaceTabTarget { x: number; y: number; width: number; height: number }
export function workspaceTabDragMoved(startX: number, startY: number, x: number, y: number): boolean {
  return [startX, startY, x, y].every(Number.isFinite) && Math.hypot(x - startX, y - startY) >= WORKSPACE_TAB_DRAG_THRESHOLD;
}
export function workspaceTabTargetContains(target: WorkspaceTabTarget | undefined, x: number, y: number): boolean {
  return Boolean(target && [target.x, target.y, target.width, target.height, x, y].every(Number.isFinite)
    && target.width > 0 && target.height > 0 && x >= target.x && y >= target.y && x <= target.x + target.width && y <= target.y + target.height);
}
export type WorkspaceTabDropIntent = 'none' | 'reorder' | 'dock' | 'detach';
export function resolveWorkspaceTabDropIntent(value: {
  moved: boolean; cancelled?: boolean; source: string; expectedSource: string; detached: boolean; insideTarget: boolean;
  itemId?: string; before?: string;
}): WorkspaceTabDropIntent {
  if (!value.moved || value.cancelled || value.source !== value.expectedSource) return 'none';
  if (value.insideTarget && !value.detached && value.itemId !== undefined && value.itemId === value.before) return 'none';
  return value.insideTarget ? value.detached ? 'dock' : 'reorder' : value.detached ? 'none' : 'detach';
}
