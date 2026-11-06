import type { DocumentWorkspaceSurface } from '../modeling/WorkspaceShell';
import type { WorkspaceMembership } from '../../modeling/workspace-contracts';
import type { WorkbenchLayout } from '../../modeling/workbench-layout';
import { clampWorkbenchPaneSize } from '../../modeling/workbench-layout';

export function isMultiDocumentMode(search: string, hasDesktop: boolean): boolean {
  const requested = new URLSearchParams(search).get('modeler');
  return requested === 'v18' || hasDesktop && !requested;
}

export function isDesktopInputMode(search: string, hasDesktop: boolean, hasWorkspace: boolean): boolean {
  return hasWorkspace || hasDesktop || ['v11', 'v12', 'v13', 'v14', 'v15', 'v17'].includes(new URLSearchParams(search).get('modeler') ?? '');
}

/** A mirror is a member of one existing owner, never a source of Undo/run recovery. */
export function sharedWindowMembership(rows: WorkspaceMembership[]): WorkspaceMembership | null {
  const joined = rows.filter(row => !row.isOwner);
  if (rows.some(row => row.isOwner)) throw new Error('权威文档页面已重新载入，不能用镜像快照恢复撤销历史或运行所有权。请保留其它窗口并重新打开此版本。');
  if (joined.length > 1) throw new Error('共享窗口成员不唯一，请重新打开指定模型的浮窗。');
  return joined[0] ?? null;
}

export function inputFormWidth(layout: WorkbenchLayout, value: number): WorkbenchLayout {
  return { ...layout, paneSizes: { ...layout.paneSizes, leftWidth: clampWorkbenchPaneSize('leftWidth', value) } };
}

export function inputCoordinateFold(layout: WorkbenchLayout, fold: boolean): WorkbenchLayout {
  return { ...layout, folds: { ...layout.folds, 'input.coordinates': fold } };
}

/** Adapt the common workspace's presentation ports; do not copy scientific state. */
export function sharedWorkspacePresentation(desktopMode: boolean, surface?: DocumentWorkspaceSurface) {
  return desktopMode && surface?.sharedLayout ? {
    observationOnly: surface.module === 'analysis', allowModelEditing: true, analysisCanvas: surface.analysisCanvas, structureAnalysisActive: surface.structureAnalysisActive, presentationActive: surface.presentationActive,
    onToolSurfaceChange: surface.onToolSurfaceChange, onToolbarSurfaceChange: surface.onToolbarSurfaceChange, onLegendSurfaceChange: surface.onLegendSurfaceChange,
    legendExpanded: surface.legendExpanded, onLegendExpandedChange: surface.onLegendExpandedChange, linkedAtomActions: surface.linkedAtomActions, linkedAtomsActive: surface.linkedAtomsActive,
    workspaceInputRoles: surface.workspaceInputRoles, workspaceDocumentPickMode: surface.workspaceDocumentPickMode, workspaceDocumentPickSelected: surface.workspaceDocumentPickSelected, onAtomNumberPick: surface.onAtomNumberPick,
  } : {};
}
