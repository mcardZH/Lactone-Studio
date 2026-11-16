import {DismissibleNotice} from '../DismissibleNotice';
import { useRef,useState } from 'react';
import {pairEditedElectronicState,type ElectronicStateEditField} from '../../core/base-electronic-state';
import type { Structure } from '../../core/types';
import { electronicStateWarning } from '../../core/elements';
import {electronicStateIntegerInput} from '../BaseElectronicStateFields';
import ElectronicStateWarning from '../ElectronicStateWarning';
import { requiresElectronicStateConfirmation, type ElectronicStateContext } from '../../modeling/application/electronic-state-context';
import {DialogSurface} from '../DialogShell';

export interface SaveElectronicState { charge: number; multiplicity: number }
export interface SaveStateRequest extends ElectronicStateContext {}
export function saveRequiresStateConfirmation(structure: Structure, request?: SaveStateRequest): boolean {
  return requiresElectronicStateConfirmation(structure,request);
}
export function initialSaveState(structure: Structure, request?: SaveStateRequest): SaveElectronicState {
  return { charge: structure.charge ?? request?.charge ?? Number.NaN, multiplicity: structure.multiplicity ?? request?.multiplicity ?? Number.NaN };
}
export function validateSaveState(structure: Structure, state: SaveElectronicState): void {
  if (!Number.isSafeInteger(state.charge) || !Number.isSafeInteger(state.multiplicity) || state.multiplicity < 1) throw new Error('电荷须为整数，多重度须为正整数。');
}
export default function SaveStateDialog({ structure, request, onConfirm, onCancel }: { structure: Structure; request?: SaveStateRequest; onConfirm(state: SaveElectronicState): void; onCancel(): void }) {
  const initial = initialSaveState(structure, request);
  const [charge, setCharge] = useState(Number.isFinite(initial.charge)?String(initial.charge):''), [multiplicity, setMultiplicity] = useState(Number.isFinite(initial.multiplicity)?String(initial.multiplicity):''), [error, setError] = useState('');
  const raw=useRef({charge,multiplicity}),lastField=useRef<ElectronicStateEditField|null>(null),[pairingIssue,setPairingIssue]=useState<string|null>(null);
  function change(field:ElectronicStateEditField,text:string){raw.current={...raw.current,[field]:text};lastField.current=field;(field==='charge'?setCharge:setMultiplicity)(text);setPairingIssue(null);}
  function commit(field:ElectronicStateEditField,text=raw.current[field]){
    if(lastField.current!==field&&text===raw.current[field])return;
    raw.current={...raw.current,[field]:text};
    if(!/^[+-]?\d+$/.test(raw.current.charge)||!/^\+?\d+$/.test(raw.current.multiplicity))return;
    const values={charge:Number(raw.current.charge),multiplicity:Number(raw.current.multiplicity)},result=pairEditedElectronicState(structure.atoms,values,field,values[field]);
    setPairingIssue(result.error);if(result.error)return;
    raw.current={charge:String(result.values.charge),multiplicity:String(result.values.multiplicity)};setCharge(raw.current.charge);setMultiplicity(raw.current.multiplicity);lastField.current=null;
  }
  return <DialogSurface aria-label="确认本次保存电子态" className="model-inline-dialog model-save-state" onCancel={onCancel}>
    <p>{structure.charge != null && structure.multiplicity != null ? '当前模型记录的电子态' : request?'沿当前任务预填电子态':'请填写本次导出的电子态'} · 仅用于本次保存</p>
    <label>电荷{electronicStateIntegerInput({text:charge,field:'charge',label:'保存电荷',onChange:text=>change('charge',text),onCommit:text=>commit('charge',text)})}</label>
    <label>多重度{electronicStateIntegerInput({text:multiplicity,field:'multiplicity',label:'保存多重度',onChange:text=>change('multiplicity',text),onCommit:text=>commit('multiplicity',text)})}</label>
    <ElectronicStateWarning message={pairingIssue||(charge.trim()&&multiplicity.trim()?electronicStateWarning(structure.atoms,Number(charge),Number(multiplicity)):null)}/>
    <button onClick={() => { try { if(lastField.current)commit(lastField.current);const current=raw.current; if (!current.charge.trim() || !current.multiplicity.trim()) throw new Error('请填写电荷与多重度。'); const state = { charge: Number(current.charge), multiplicity: Number(current.multiplicity) }; validateSaveState(structure, state); onConfirm(state); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>确认并保存</button>
    <button onClick={onCancel}>取消</button>{error && <DismissibleNotice role="alert">{error}</DismissibleNotice>}
  </DialogSurface>;
}
