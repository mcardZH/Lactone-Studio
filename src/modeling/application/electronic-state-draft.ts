import type { Structure } from '../../core/types';
import type { DocumentStamp, SharedModelConstraints } from '../../core/modeling/contracts';
import { baseElectronicStateParameterError as baseElectronicStateError } from '../../core/base-electronic-state';
import {coordinatesFingerprint,graphFingerprint} from '../../core/modeling/graph';
import type { AdvancedFrameRef, AdvancedFrameSource } from '../advanced/frame-source';
import { advancedElectronicDraftIdentity,advancedElectronicSourceConfirmationKey } from '../advanced/electronic-confirmation';

/** Editing context only. Unlike AdvancedFrameSource, absent electronic metadata
 * is retained and never becomes an executable scientific input. */
export interface ElectronicStateSourceContext {
  ref: Readonly<AdvancedFrameRef>;
  stamp: DocumentStamp;
  structure: Structure;
  constraints: SharedModelConstraints;
  coordinateUnit: 'angstrom';
  label: string;
}
export interface ElectronicStateDraft {
  sourceKey: string;
  chargeText: string;
  multiplicityText: string;
  sourceCharge: number | null;
  sourceMultiplicity: number | null;
  origin: 'explicit' | 'missing' | 'suggested';
  touched: { charge: boolean; multiplicity: boolean };
}
export interface ConfirmedElectronicSnapshot {
  source: AdvancedFrameSource;
  charge: number;
  multiplicity: number;
  uhf: number;
  confirmationKey: string;
}
export type ElectronicStateDraftField = 'charge' | 'multiplicity';

export function electronicDraftSourceKey(source: ElectronicStateSourceContext): string {
  return advancedElectronicDraftIdentity(source);
}
/** Safely retain raw drafts from the supported prior full-ref key. No geometry,
 * graph, q/M or explicit source frame is inferred from a name or atom count. */
export function electronicStateDraftForSource(source:ElectronicStateSourceContext,drafts:Readonly<Record<string,ElectronicStateDraft>>|undefined):ElectronicStateDraft|undefined{
  if(!drafts)return;
  const sourceKey=electronicDraftSourceKey(source),current=drafts[sourceKey];if(current)return current;
  const matches=Object.values(drafts).filter(draft=>{
    try{
      const old:unknown=JSON.parse(draft.sourceKey);
      return Array.isArray(old)&&old.length===4&&old[0]&&typeof old[0]==='object'
        &&advancedElectronicDraftIdentity({...source,ref:old[0] as AdvancedFrameRef})===sourceKey
        &&old[1]===coordinatesFingerprint(source.structure)&&old[2]===graphFingerprint(source.structure);
    }catch{return false;}
  });
  if(matches.length===1)return{...matches[0],sourceKey};
}
export function createElectronicStateDraft(source: ElectronicStateSourceContext): ElectronicStateDraft {
  const charge = source.structure.charge ?? null, multiplicity = source.structure.multiplicity ?? null;
  return { sourceKey: electronicDraftSourceKey(source),
    chargeText: charge === null ? '' : String(charge), multiplicityText: multiplicity === null ? '' : String(multiplicity),
    sourceCharge: charge, sourceMultiplicity: multiplicity,
    origin: charge === null || multiplicity === null ? 'missing' : 'explicit',
    touched: { charge: false, multiplicity: false } };
}
export function electronicDraftValues(draft: ElectronicStateDraft): { charge: number; multiplicity: number } | null {
  if (!/^[+-]?\d+$/.test(draft.chargeText) || !/^\+?\d+$/.test(draft.multiplicityText)) return null;
  const charge = Number(draft.chargeText), multiplicity = Number(draft.multiplicityText);
  return Number.isSafeInteger(charge) && Number.isSafeInteger(multiplicity) && multiplicity > 0 ? { charge, multiplicity } : null;
}
export function validateElectronicStateDraft(source: ElectronicStateSourceContext, draft: ElectronicStateDraft): string | null {
  if (draft.sourceKey !== electronicDraftSourceKey(source)) return '电子态所属来源已变化，请重新取用当前帧。';
  const values = electronicDraftValues(draft);
  if (!values) return '电荷必须为整数，自旋多重度必须为正整数。';
  return baseElectronicStateError(source.structure, values);
}
/** The UI verifies the owner-returned immutable snapshot. It never constructs a
 * fake confirmation by patching its local preview or a historical task source. */
export function assertConfirmedElectronicSnapshot(value: ConfirmedElectronicSnapshot, draft: ElectronicStateDraft): void {
  const values = electronicDraftValues(draft), source = value.source;
  if (!values || baseElectronicStateError(source.structure, values)
    || value.charge !== values.charge || value.multiplicity !== values.multiplicity || value.uhf !== values.multiplicity - 1
    || source.structure.charge !== values.charge || source.structure.multiplicity !== values.multiplicity
    || value.confirmationKey !== advancedElectronicSourceConfirmationKey(source, values))
    throw Error('确认电子态与本次单点来源不一致。');
}
