import { resolveWorkspaceTabDropIntent, workspaceTabDragMoved, workspaceTabTargetContains, WORKSPACE_TAB_DRAG_THRESHOLD, type WorkspaceTabTarget } from './workspace-tab-drag';
export type DockTarget = WorkspaceTabTarget;
export const DETACHED_TAB_DRAG_THRESHOLD = WORKSPACE_TAB_DRAG_THRESHOLD;

/** Screen coordinates are CSS pixels, matching Electron content bounds. A click,
 * cancelled pointer or a release outside the owner tab strip never docks. */
export function createDetachedTabDrag() {
  let start: { pointerId: number; x: number; y: number; moved: boolean } | null = null;
  return {
    start(pointerId: number, x: number, y: number) { start = { pointerId, x, y, moved: false }; },
    move(pointerId: number, x: number, y: number) {
      if (!start || pointerId !== start.pointerId) return false;
      start.moved ||= workspaceTabDragMoved(start.x, start.y, x, y);
      return start.moved;
    },
    finish(pointerId: number, x: number, y: number, target?: DockTarget, cancel = false) {
      if (!start || pointerId !== start.pointerId) return { dock: false, moved: false };
      this.move(pointerId, x, y);
      const moved = start.moved;
      const dock = resolveWorkspaceTabDropIntent({ moved, cancelled: cancel, source: 'model', expectedSource: 'model', detached: true, insideTarget: workspaceTabTargetContains(target, x, y) }) === 'dock';
      start = null;
      return { dock, moved };
    },
    cancel() { start = null; },
  };
}
