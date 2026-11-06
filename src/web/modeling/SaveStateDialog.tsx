import {DismissibleNotice} from '../DismissibleNotice';
import { useState } from 'react';
import type { Structure } from '../../core/types';
import { electronCount } from '../../core/elements';
import { requiresElectronicStateConfirmation, type ElectronicStateContext } from '../../modeling/application/electronic-state-context';
import {DialogSurface} from '../DialogShell';

export interface SaveElectronicState { charge: number; multiplicity: number }
export interface SaveStateRequest extends ElectronicStateContext {}
export function saveRequiresStateConfirmation(structure: Structure, request?: SaveStateRequest): boolean {
  return requiresElectronicStateConfirmation(structure,request);
}
export function initialSaveState(structure: Structure, request: SaveStateRequest): SaveElectronicState {
  return { charge: structure.charge ?? request.charge, multiplicity: structure.multiplicity ?? request.multiplicity };
}
export function validateSaveState(structure: Structure, state: SaveElectronicState): void {
  const electrons = electronCount(structure.atoms, state.charge);
  if (!Number.isSafeInteger(state.charge) || !Number.isSafeInteger(state.multiplicity) || state.multiplicity < 1) throw new Error('电荷须为整数，多重度须为正整数。');
  if (electrons < 0 || state.multiplicity > electrons + 1 || (electrons - (state.multiplicity - 1)) % 2 !== 0) throw new Error('电荷/多重度与当前模型电子数不匹配。');
}
export default function SaveStateDialog({ structure, request, onConfirm, onCancel }: { structure: Structure; request: SaveStateRequest; onConfirm(state: SaveElectronicState): void; onCancel(): void }) {
  const initial = initialSaveState(structure, request);
  const [charge, setCharge] = useState(String(initial.charge)), [multiplicity, setMultiplicity] = useState(String(initial.multiplicity)), [error, setError] = useState('');
  return <DialogSurface aria-label="确认本次保存电子态" className="model-inline-dialog model-save-state" onCancel={onCancel}>
    <p>{structure.charge != null && structure.multiplicity != null ? '当前模型记录的电子态' : '沿当前任务预填电子态'} · 仅用于本次保存</p>
    <label>电荷<input aria-label="保存电荷" type="number" step="1" value={charge} onChange={event => setCharge(event.target.value)} /></label>
    <label>多重度<input aria-label="保存多重度" type="number" min="1" step="1" value={multiplicity} onChange={event => setMultiplicity(event.target.value)} /></label>
    <button onClick={() => { try { if (!charge.trim() || !multiplicity.trim()) throw new Error('请填写电荷与多重度。'); const state = { charge: Number(charge), multiplicity: Number(multiplicity) }; validateSaveState(structure, state); onConfirm(state); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>确认并保存</button>
    <button onClick={onCancel}>取消</button>{error && <DismissibleNotice role="alert">{error}</DismissibleNotice>}
  </DialogSurface>;
}
