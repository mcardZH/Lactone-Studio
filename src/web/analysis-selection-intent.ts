import type { TaskSelectionHandle } from '../modeling/contracts';

/** Analysis owns its capture independently from input engine/task ownership. */
export interface AnalysisSelectionOwner { kind: 'analysis'; id: string }
export type AnalysisSelectionHandle = TaskSelectionHandle;
export interface AnalysisSelectionIntent {
  owner: AnalysisSelectionOwner; purpose: 'surface-region' | 'interaction-fragment' | 'advanced-region' | 'advanced-coordinate' | 'hirshfeld-target'; kind: 'atoms' | 'coordinate';
  rowId: string; contextKey: string; origin: 'interactive' | 'text'; initialAtomIds: string[];
  onDraftChange?(atomIds: string[]): void;
  onEnd?(result: 'confirmed' | 'cancelled'): void;
  onConfirm(atomIds: string[]): boolean | void;
}
/** The enclosing analysis supplies an actual document/revision/activation seal.
 * The broker previews in its own capture state and never writes model selection. */
export interface AnalysisSelectionPort {
  owner: AnalysisSelectionOwner;
  contextKey: string;
  assertCurrent(): void;
  requestSelection(intent: AnalysisSelectionIntent): AnalysisSelectionHandle;
}

export function assertAnalysisSelectionPort(port: AnalysisSelectionPort): void {
  if (port.owner.kind !== 'analysis' || !port.owner.id.trim() || !port.contextKey) throw new Error('分析选择的来源身份尚未就绪。');
  port.assertCurrent();
}
