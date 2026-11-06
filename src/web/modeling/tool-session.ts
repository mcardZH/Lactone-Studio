import type { ClipboardPayload, MeasurementSession, MeasurementState } from '../../modeling/contracts';
import type { ActiveStructurePreviewSource } from './active-structure-preview';
import { emptyMeasurementSession, setMeasurementMode } from './measurement-state';

export type PersistentModelTool = 'hydrogen' | 'delete' | 'fragment';
export type FreezeModelTool = 'point' | 'box' | 'remove';
export type ObservationModelTool = 'rotate' | 'pan' | 'select' | 'box';

/** Workspace UI preferences contain no model identity or electronic state. */
export interface WorkspaceOptimizationPreferences {
  version: 2;
  defaultKind: 'forcefield' | 'xtb';
  forcefield: { method: 'auto' | 'UFF' | 'MMFF94' | 'geometry'; scope: 'all' | 'selection' | 'unselected' };
  xtb: { method: 'gfn0' | 'gfn1' | 'gfn2' | 'gfnff'; rebuildBonds: boolean; scope:'all'|'selection'|'unselected'; maxSteps?:number;maxSccIterations?:number };
}
export const OPTIMIZATION_PREFERENCE_KEY = 'sciyue.workspace-optimization.v1';
export const OPTIMIZATION_PREFERENCE_EVENT = 'sciyue-workspace-optimization-changed';
export function defaultWorkspaceOptimizationPreferences(): WorkspaceOptimizationPreferences {
  return { version: 2, defaultKind: 'xtb', forcefield: { method: 'auto', scope: 'all' }, xtb: { method: 'gfn2', rebuildBonds: true,scope:'all',maxSteps:500,maxSccIterations:250 } };
}
type StoredOptimizationPreferences = Omit<WorkspaceOptimizationPreferences, 'version' | 'xtb'> & {
  version: 1 | 2;
  xtb: Omit<WorkspaceOptimizationPreferences['xtb'], 'scope'> & { scope?: WorkspaceOptimizationPreferences['xtb']['scope'] };
};
function checkedOptimizationPreferences(value: unknown): WorkspaceOptimizationPreferences | null {
  const row = value as Partial<StoredOptimizationPreferences> | null;
  if (!row || ![1, 2].includes(row.version ?? 0) || !['forcefield', 'xtb'].includes(row.defaultKind ?? '')
    || !['auto', 'UFF', 'MMFF94', 'geometry'].includes(row.forcefield?.method ?? '')
    || !['all', 'selection', 'unselected'].includes(row.forcefield?.scope ?? '')
    || !['gfn0', 'gfn1', 'gfn2', 'gfnff'].includes(row.xtb?.method ?? '') || row.xtb?.maxSteps !== undefined && (!Number.isSafeInteger(row.xtb.maxSteps)||row.xtb.maxSteps<1) || row.xtb?.maxSccIterations !== undefined && (!Number.isSafeInteger(row.xtb.maxSccIterations)||row.xtb.maxSccIterations<1) || typeof row.xtb?.rebuildBonds !== 'boolean'
    || !['all','selection','unselected'].includes(row.xtb?.scope??'all')) return null;
  // Version 2 records that the one-time Space-default migration was consumed.
  // A later explicit forcefield choice is authoritative, not legacy data.
  return { version: 2, defaultKind: row.version === 1 ? 'xtb' : row.defaultKind!, forcefield: { method: row.forcefield!.method, scope: row.forcefield!.scope }, xtb: { method: row.xtb!.method, rebuildBonds: row.xtb!.rebuildBonds,scope:row.xtb!.scope??'all',maxSteps:row.xtb!.maxSteps??500,maxSccIterations:row.xtb!.maxSccIterations??250 } };
}
export function parseWorkspaceOptimizationPreferences(value: unknown): WorkspaceOptimizationPreferences {
  return checkedOptimizationPreferences(value) ?? defaultWorkspaceOptimizationPreferences();
}
export function readWorkspaceOptimizationPreferences(): WorkspaceOptimizationPreferences {
  let value: unknown;
  try { value = JSON.parse(window.localStorage.getItem(OPTIMIZATION_PREFERENCE_KEY) ?? 'null'); }
  catch { return defaultWorkspaceOptimizationPreferences(); }
  const accepted = checkedOptimizationPreferences(value);
  if (!accepted) return defaultWorkspaceOptimizationPreferences();
  if ((value as StoredOptimizationPreferences).version === 1) {
    // Initialize safely even when storage is blocked/full. Keep the validated
    // method/range choices in memory and retry persistence on the next read.
    try { window.localStorage.setItem(OPTIMIZATION_PREFERENCE_KEY, JSON.stringify(accepted)); } catch { /* Read must not break UI initialization. */ }
  }
  return accepted;
}
export function writeWorkspaceOptimizationPreferences(value: StoredOptimizationPreferences): WorkspaceOptimizationPreferences {
  const accepted = checkedOptimizationPreferences(value);
  if(!accepted)throw new Error('优化偏好中的方法、范围或迭代预算无效。');
  window.localStorage.setItem(OPTIMIZATION_PREFERENCE_KEY, JSON.stringify(accepted));
  window.dispatchEvent(new CustomEvent(OPTIMIZATION_PREFERENCE_EVENT, { detail: accepted }));
  return accepted;
}

/** UI tool choices only. Model/Undo, yellow selection, input capture and shared
 * constraints are deliberately not members of this state. */
export interface ToolSessionState {
  element: string | null;
  persistentTool: PersistentModelTool | null;
  copiedTool: boolean;
  freezeTool: FreezeModelTool | null;
  geometryOpen: boolean;
  observationTool: ObservationModelTool;
  presetId: string;
  template: string;
  activeFragmentIndex: number;
  copiedPayload: ClipboardPayload | null;
  copyActiveIndex: number;
  previewSource: ActiveStructurePreviewSource;
  previewActiveIndex: number | undefined;
}

export type ToolSessionIntent =
  | { type: 'select-element'; element: string; presetId: string; origin?: 'keyboard' }
  | { type: 'clear-element' }
  | { type: 'select-persistent'; tool: PersistentModelTool }
  | { type: 'select-template'; templateId: string; activeIndex: number; activate: boolean }
  | { type: 'select-copy'; payload: ClipboardPayload; activeIndex: number }
  | { type: 'clipboard-cache'; payload: ClipboardPayload }
  | { type: 'preview-atom'; kind: 'element'; element: string; index: number }
  | { type: 'preview-atom'; kind: 'template' | 'copy'; index: number }
  | { type: 'observe'; tool: ObservationModelTool }
  | { type: 'freeze'; tool: FreezeModelTool | null }
  | { type: 'measure'; mode: MeasurementState['mode'] }
  | { type: 'clear-measurement-pending' }
  | { type: 'capture-start'; atomIds: readonly string[] }
  | { type: 'capture-end' }
  | { type: 'escape'; captureActive: boolean }
  | { type: 'document-reset' }
  | { type: 'runtime-status'; locked: boolean };

export type ToolMeasurementPolicy =
  | { type: 'preserve' }
  | { type: 'mode'; mode: MeasurementState['mode'] }
  | { type: 'document-reset' };
export interface ToolSessionTransition {
  /** Missing means preserve; an explicit undefined preview index means clear. */
  patch: Partial<ToolSessionState>;
  keyboard: 'preserve' | 'set-element' | 'document-reset' | 'suspend';
  measurement: ToolMeasurementPolicy;
  cancelManualGeometry: boolean;
  advancePreviewIntent: boolean;
  focusCanvas: boolean;
  /** Capture has its own identity/validation, not a modelling selection. */
  captureAtomIds?: string[];
}

const preserve = (): ToolSessionTransition => ({
  patch: {}, keyboard: 'preserve', measurement: { type: 'preserve' },
  cancelManualGeometry: false, advancePreviewIntent: false, focusCanvas: false,
});

/** Choosing an editing/observation tool retires pending interaction, not
 * completed BAD records. It never clears yellow selection or task definitions. */
function choice(patch: Partial<ToolSessionState>, keyboard: ToolSessionTransition['keyboard'] = 'set-element', focusCanvas = true): ToolSessionTransition {
  return {
    patch: { element: null, persistentTool: null, copiedTool: false, freezeTool: null,
      geometryOpen: false, observationTool: 'rotate', ...patch },
    keyboard, measurement: { type: 'mode', mode: null }, cancelManualGeometry: true,
    advancePreviewIntent: true, focusCanvas,
  };
}

/** Pure intent -> transition policy. Callers first validate preset/index,
 * edit locks and async identity; this layer never starts I/O or model edits.
 * Intent-specific branches intentionally replace a universal reset: capture,
 * document replacement, keyboard adoption and runtime completion differ. */
export function planToolSessionTransition(intent: ToolSessionIntent): ToolSessionTransition {
  switch (intent.type) {
    case 'select-element':
      return choice({ element: intent.element, presetId: intent.presetId,
        previewSource: { kind: 'element', presetId: intent.presetId }, previewActiveIndex: undefined },
      intent.origin === 'keyboard' ? 'preserve' : 'set-element', intent.origin !== 'keyboard');
    case 'clear-element':
      // The displayed seed/anchor remains available for Ctrl+V, as before.
      return choice({});
    case 'select-persistent':
      return choice({ persistentTool: intent.tool });
    case 'select-template': {
      const preview = { template: intent.templateId, activeFragmentIndex: intent.activeIndex,
        previewSource: { kind: 'template' as const, templateId: intent.templateId }, previewActiveIndex: undefined };
      // Retain the existing read-only template-preview update when activation
      // is blocked. Do not arm a tool, cancel a gesture or change its epoch.
      return intent.activate ? choice({ ...preview, persistentTool: 'fragment' }) : { ...preserve(), patch: preview };
    }
    case 'select-copy':
      return choice({ persistentTool: 'fragment', copiedTool: true, copiedPayload: intent.payload,
        copyActiveIndex: intent.activeIndex, previewSource: { kind: 'copy', payload: intent.payload }, previewActiveIndex: intent.activeIndex });
    case 'clipboard-cache':
      // An arriving clipboard notification is data, not a new user tool intent.
      return { ...preserve(), patch: { copiedPayload: intent.payload, copyActiveIndex: 0 } };
    case 'preview-atom':
      return choice(intent.kind === 'element'
        ? { element: intent.element, previewActiveIndex: intent.index }
        : { persistentTool: 'fragment', copiedTool: intent.kind === 'copy', previewActiveIndex: intent.index,
          ...(intent.kind === 'copy' ? { copyActiveIndex: intent.index } : { activeFragmentIndex: intent.index }) },
      'set-element', false);
    case 'observe':
      return choice({ observationTool: intent.tool });
    case 'freeze':
      return choice({ freezeTool: intent.tool });
    case 'measure':
      return { ...choice({}), measurement: { type: 'mode', mode: intent.mode } };
    case 'clear-measurement-pending':
      // C/R key processing has already updated the keyboard. Do not reset
      // held C digits, copied/freeze choices or the element at this boundary.
      return { ...preserve(), patch: { persistentTool: null, geometryOpen: false, observationTool: 'rotate' },
        measurement: { type: 'mode', mode: null }, cancelManualGeometry: true };
    case 'capture-start':
      // The workspace commits any existing manual gesture before this intent.
      // Capture IDs and BAD records remain separate from the yellow selection.
      return { ...preserve(), captureAtomIds: [...intent.atomIds], focusCanvas: true };
    case 'capture-end':
      // Never restore a pre-capture tool over a newer explicit user choice.
      return { ...preserve(), captureAtomIds: [] };
    case 'escape':
      // The keyboard port already performs Escape's own reset. Capture cancel
      // returns before clearing measurement/selection in the legacy workflow.
      return { ...preserve(), patch: { copiedTool: false, freezeTool: null, persistentTool: null,
        geometryOpen: false, ...(!intent.captureActive ? { observationTool: 'rotate' as const } : {}) },
        cancelManualGeometry: true,
        measurement: intent.captureActive ? { type: 'preserve' } : { type: 'mode', mode: 'auto' } };
    case 'document-reset':
      // Preserve the existing preview preferences; replace measurement history
      // only when document identity is reset, not on a tool/runtime transition.
      return { ...preserve(), patch: { element: null, freezeTool: null, persistentTool: null, geometryOpen: false },
        keyboard: 'document-reset', measurement: { type: 'document-reset' } };
    case 'runtime-status':
      // Runtime owns an edit lock, not a saved element/tool to restore later.
      return { ...preserve(), keyboard: intent.locked ? 'suspend' : 'preserve' };
  }
}

/** Apply only the specified measurement policy. Completed annotations and their
 * identity/color/active record survive every mode/tool transition. */
export function applyToolSessionMeasurement(previous: MeasurementSession, policy: ToolMeasurementPolicy): MeasurementSession {
  if (policy.type === 'preserve') return previous;
  return policy.type === 'document-reset' ? emptyMeasurementSession() : setMeasurementMode(previous, policy.mode);
}
