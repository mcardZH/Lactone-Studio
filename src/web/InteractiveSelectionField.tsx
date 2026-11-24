import {DismissibleNotice} from './DismissibleNotice';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MousePointer2, Check, Plus, Trash2 } from 'lucide-react';
import type { Structure, Vector3 } from '../core/types';
import { inputSelectionIndices } from '../core/input-selection';
import { validatePeriodicEndpointImages } from '../core/periodic';
import { pickerStructureIdentity } from '../core/geometry-guides';
import { formatAtomSelection } from '../core/structures';
import type { TaskSelectionHandle, TaskSelectionIntent } from '../modeling/contracts';
import { parseInteractiveSelection, RegionSelectionConflict, regionSelectionIdentityError } from '../modeling/application/region-selection';
import type { AtomPickerRequest } from './AtomPickerModal';
import type { AnalysisSelectionHandle, AnalysisSelectionIntent, AnalysisSelectionOwner } from './analysis-selection-intent';
import './interactive-selection.css';
import {InputSettingsCardHeader} from './InputSettingsFields';

interface SelectionFieldBase {
  structure: Structure | null; label: string; rowId: string;
  kind?: TaskSelectionIntent['kind']; atomIds: readonly string[]; contextKey?: string; disabled?: boolean;
  coordinateImages?:readonly Vector3[];
  onConfirm(ids: string[], assertCurrent: () => void, overwrite: boolean, images?:Vector3[]): void;
  onDraftChange?(ids: string[], images?:Vector3[]): void; onEnd?(result: 'confirmed' | 'cancelled'): void;
  remainingAtomIds?: readonly string[];
  draftChoices?: { label: string; atomIds: readonly string[] }[];
  onPick?: (request: AtomPickerRequest) => void;
  onClear?:()=>void; clearLabel?:string; clearDisabled?:boolean;
  /** Opt in to the same title/action header used by an adjacent subcard. */
  headerVariant?:'subcard';
  /** Retained for existing callers; the action pair now always wraps as one group. */
  wrapActions?:boolean;
  /** Analysis variants can repair obsolete IDs and type into the active capture draft. */
  liveNumberDraft?:boolean;
  /** Optional owner-held text, including incomplete input, for saved row drafts. */
  numberText?:string;
  onNumberTextChange?(text:string):void;
  preserveNumberDraftOnCancel?:boolean;
  autoPick?:boolean;
  renderDraft?(ids:readonly string[],images?:readonly Vector3[]):ReactNode;
  /** Fragment owners provide the first row; selection actions keep draft semantics here. */
  renderHeader?: (selectionActions: ReactNode) => ReactNode;
  /** A card can place this field's clear button in its own visible header. */
  renderContainer?: (field: ReactNode, clearAction: ReactNode) => ReactNode;
  /** Specialized rows may keep additional controls in the same wrapping action group. */
  renderSelectionRow?: (numberControl: ReactNode, actionButtons: ReactNode) => ReactNode;
}
export interface InteractiveSelectionFieldProps extends SelectionFieldBase {
  engine: TaskSelectionIntent['engine']; purpose: TaskSelectionIntent['purpose']; taskId?: string;
  onRequestSelection?: (intent: TaskSelectionIntent) => TaskSelectionHandle | void;
  captureOwner?: never; onRequestAnalysisSelection?: never;
}
export interface AnalysisInteractiveSelectionFieldProps extends SelectionFieldBase {
  captureOwner: AnalysisSelectionOwner; contextKey: string; kind?: 'atoms' | 'coordinate';
  analysisPurpose?: AnalysisSelectionIntent['purpose'];
  onRequestAnalysisSelection(intent: AnalysisSelectionIntent): AnalysisSelectionHandle | void;
  engine?: never; purpose?: never; taskId?: never; onRequestSelection?: never;
}
type SelectionFieldProps = InteractiveSelectionFieldProps | AnalysisInteractiveSelectionFieldProps;
/** Shared heading for collection groups and entries, including headings inside details. */
export function SelectionGroupHeader({title,actions}:{title:ReactNode;actions?:ReactNode}) {
  return <span className="interactive-selection-header"><strong className="shared-input-card-title">{title}</strong>{actions&&<span className="interactive-selection-header-actions" onClick={event=>{event.stopPropagation();event.preventDefault();}} onKeyDown={event=>event.stopPropagation()}>{actions}</span>}</span>;
}
export function SelectionRemoveButton({label,onClick,disabled}:{label:string;onClick:()=>void;disabled?:boolean}) {
  return <button type="button" className="icon-button shared-coordinate-row-delete" aria-label={label} title={label} disabled={disabled} onClick={onClick}><Trash2 size={14}/></button>;
}
export function SelectionAddButton({label,onClick,disabled,testId}:{label:string;onClick:()=>void;disabled?:boolean;testId?:string}) {
  return <button type="button" className="button button-white selection-add-button" data-testid={testId} disabled={disabled} onClick={onClick}><Plus size={14}/>{label}</button>;
}
const causeText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const selectionOwner = (props: SelectionFieldProps) => props.captureOwner ? JSON.stringify(['analysis', props.captureOwner.id, props.rowId, props.analysisPurpose ?? 'surface-region', props.kind ?? 'atoms']) : JSON.stringify([props.engine, props.taskId, props.rowId, props.purpose, props.kind ?? 'atoms']);
function formatSelection(props: SelectionFieldProps, ids: readonly string[], images?:readonly Vector3[]) {
  if (!props.structure) return '';
  try {
    if(props.kind==='coordinate'&&images){
      validatePeriodicEndpointImages(props.structure,ids,images);
      return ids.map(id=>props.structure!.atoms.findIndex(atom=>atom.id===id)+1).join(',');
    }
    const indices = inputSelectionIndices(props.structure, ids);
    return (props.kind ?? 'atoms') === 'atoms' ? formatAtomSelection(indices) : indices.map(index => index + 1).join(',');
  }
  catch { return ids.length ? '失效原子身份' : ''; }
}
export default function InteractiveSelectionField(props: SelectionFieldProps) {
  const kind = props.kind ?? 'atoms';
  const identity = props.structure ? pickerStructureIdentity(props.structure) : '';
  const members = JSON.stringify([props.atomIds,props.coordinateImages]);
  const owner = selectionOwner(props), canonical = formatSelection(props, props.atomIds,props.coordinateImages);
  const [localText, setLocalText] = useState(canonical), [error, setError] = useState(''), [picking, setPicking] = useState(false);
  const text=props.numberText??localText;
  function setText(value:string){setLocalText(value);latest.current.props.onNumberTextChange?.(value);}
  const [pending, setPending] = useState<{ ids: string[]; guard: () => void; conflict: RegionSelectionConflict } | null>(null);
  const latest = useRef({ props, identity, members, owner }); latest.current = { props, identity, members, owner };
  const alive = useRef(true), handle = useRef<AnalysisSelectionHandle | null>(null), epoch = useRef(0);
  const typing=useRef(false);
  const manualDraftText=useRef<string|null>(null);
  const captureOwner = useRef<string | null>(null), draftIds = useRef<string[]>([]);
  const draftImages=useRef<Vector3[]|undefined>(undefined);
  const overwritePermit = useRef<{ ids: string[]; guard: () => void } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; handle.current?.cancel(); }; }, []);
  useEffect(() => {
    const own = handle.current;
    if (own && captureOwner.current === owner && !props.disabled && !props.captureOwner) {
      try {
        // Main may rebase a legitimate model edit onto the same sealed row.
        // The handle remains the authority for document, activation and form.
        own.assertCurrent(); setText(formatSelection(latest.current.props, draftIds.current)); return;
      } catch { /* An unrelated form/document change still ends this capture. */ }
    }
    epoch.current++; handle.current = null; captureOwner.current = null; overwritePermit.current = null;
    own?.cancel(); setPicking(false); setLocalText(canonical); setError(''); setPending(null);
  }, [identity, owner, members, props.contextKey, props.disabled]);
  useEffect(()=>{if(props.autoPick)pick();},[]);
  function guard(strictSnapshot = Boolean(latest.current.props.captureOwner)) {
    const captured = latest.current, ownEpoch = epoch.current, ownHandle = handle.current;
    return () => {
      const current = latest.current;
      if (!alive.current || ownEpoch !== epoch.current || current.owner !== captured.owner || current.props.disabled) throw new Error('模型、区域或输入条件已变化，请重新选择。');
      if (ownHandle) {
        if (handle.current !== ownHandle) throw new Error('交互式选择已结束或已被替换。');
        ownHandle.assertCurrent();
      }
      if ((!ownHandle || strictSnapshot) && (current.identity !== captured.identity || current.members !== captured.members || current.props.contextKey !== captured.props.contextKey)) throw new Error('模型、区域或输入条件已变化，请重新选择。');
    };
  }
  function draft(ids: string[], images?:Vector3[]) { const changed=JSON.stringify(draftIds.current)!==JSON.stringify(ids)||JSON.stringify(draftImages.current)!==JSON.stringify(images); draftIds.current = [...ids];draftImages.current=images; if(!typing.current)setText(formatSelection(latest.current.props, ids, images)); if(changed){setError(''); setPending(null); overwritePermit.current = null;} latest.current.props.onDraftChange?.([...ids],images); }
  function updateNumbers(value:string){
    manualDraftText.current=value;
    setText(value);setError('');setPending(null);
    const current=latest.current.props,structure=current.structure;
    if(!structure)return;
    if(picking&&current.liveNumberDraft&&handle.current?.setAtomIds){
      try{
        const normalized=value.trim();
        const ids=!normalized?[]:kind==='coordinate'&&/^\d+$/.test(normalized)
          ?[structure.atoms[Number(normalized)-1]?.id??'']:parseInteractiveSelection(value,structure,kind);
        typing.current=true;handle.current.setAtomIds(ids);
      }catch{/* Leave incomplete text editable; confirmation validates it. */}
      finally{typing.current=false;}
    }else try{current.onDraftChange?.(parseInteractiveSelection(value,structure,kind));}catch{current.onDraftChange?.([]);}
  }
  function accept(ids: string[], assertCurrent = guard(), overwrite = false, propagateError = false, images?:Vector3[]) {
    try {
      assertCurrent();
      const current = latest.current.props;
      if (!current.structure) throw new Error('请先提供结构。');
      if (current.kind==='coordinate'&&images)validatePeriodicEndpointImages(current.structure,ids,images);
      else inputSelectionIndices(current.structure, ids);
      current.onConfirm([...ids], assertCurrent, overwrite, images); setPending(null); setError(''); return true;
    }
    catch (cause) { if (cause instanceof RegionSelectionConflict) { const snapshotGuard = guard(true); setPending({ ids: [...ids], guard: () => { assertCurrent(); snapshotGuard(); }, conflict: cause }); setError(''); } else { setPending(null); setError(causeText(cause)); if (propagateError) throw cause; } return false; }
  }
  function confirm() {
    try {
      if (picking && handle.current) {
        handle.current.assertCurrent();
        if(props.liveNumberDraft&&handle.current.setAtomIds&&props.structure&&
          (!draftImages.current||text!==formatSelection(props,draftIds.current,draftImages.current)))handle.current.setAtomIds(parseInteractiveSelection(text,props.structure,kind));
        handle.current.confirm();return;
      }
      const current=latest.current.props;
      if (!current.structure) throw new Error('请先提供结构。');
      if(current.coordinateImages&&text===formatSelection(current,current.atomIds,current.coordinateImages)){
        accept([...current.atomIds],guard(true),false,false,current.coordinateImages.map(image=>[...image]));return;
      }
      const ids = parseInteractiveSelection(text, current.structure, kind);
      // The manual-number path acquires the same owner/activation seal too.
      // Main's handle can confirm its initial draft synchronously; it does not
      // require a mounted viewport or a fabricated pointer gesture.
      if (latest.current.props.onRequestSelection || latest.current.props.onRequestAnalysisSelection) pick(ids, true);
      else accept(ids);
    } catch (cause) { setError(causeText(cause)); }
  }
  function pick(initialOverride?: string[], immediate = false) {
    try {
      const current = latest.current.props, currentKind = current.kind ?? 'atoms';
      if (!current.structure) throw new Error('请先提供结构。');
      let initial = initialOverride ?? (current.liveNumberDraft?[...new Set(current.atomIds.filter(id=>current.structure!.atoms.some(atom=>atom.id===id)))]:[]);
      if(current.preserveNumberDraftOnCancel&&initialOverride===undefined){
        manualDraftText.current=current.numberText??text;
        try{if(manualDraftText.current.trim())initial=parseInteractiveSelection(manualDraftText.current,current.structure,currentKind);}catch{/* An incomplete number draft remains available after cancelling capture. */}
      }
      handle.current?.cancel(); handle.current = null; epoch.current++;
      const assertLocal = guard(), captureEpoch = epoch.current;
      if (current.onRequestSelection || current.onRequestAnalysisSelection) {
        captureOwner.current = selectionOwner(current); draftIds.current = [...initial]; draftImages.current=undefined; overwritePermit.current = null;
        const callbacks: Omit<AnalysisSelectionIntent, 'owner' | 'purpose' | 'kind' | 'contextKey'> = { rowId: current.rowId, origin: immediate ? 'text' : 'interactive', initialAtomIds: initial,
          onDraftChange: (ids, images?:Vector3[]) => { if (alive.current && epoch.current === captureEpoch && latest.current.owner === captureOwner.current) draft(ids,images); },
          onConfirm: (ids, images?:Vector3[]) => {
            if (!alive.current || epoch.current !== captureEpoch || latest.current.owner !== captureOwner.current) throw new Error('模型、区域或输入条件已变化，请重新选择。');
            if (!handle.current) assertLocal();
            const permit = overwritePermit.current; overwritePermit.current = null;
            if (permit) { permit.guard(); if (JSON.stringify(ids) !== JSON.stringify(permit.ids)) throw new Error('选择草稿已变化，请重新确认覆盖。'); }
            const confirmed = !immediate && current.purpose === 'frozen-atoms' ? [...new Set([...latest.current.props.atomIds, ...ids])] : ids;
            return accept(confirmed, guard(), Boolean(permit), true, images);
          },
          onEnd: result => { if (!alive.current || epoch.current !== captureEpoch) return; epoch.current++; handle.current = null; captureOwner.current = null; overwritePermit.current = null; setPicking(false); if (result === 'cancelled') { setPending(null); if(latest.current.props.preserveNumberDraftOnCancel){if(manualDraftText.current!==null)setText(manualDraftText.current);}else{setText(formatSelection(latest.current.props, latest.current.props.atomIds,latest.current.props.coordinateImages)); latest.current.props.onDraftChange?.([...latest.current.props.atomIds]);} } latest.current.props.onEnd?.(result); },
        };
        const returned = current.captureOwner
          ? current.onRequestAnalysisSelection({ ...callbacks, owner: current.captureOwner, contextKey: current.contextKey, purpose: current.analysisPurpose ?? 'surface-region', kind: current.kind==='coordinate'?'coordinate':'atoms' })
          : current.onRequestSelection!({ ...callbacks, engine: current.engine, purpose: current.purpose, taskId: current.taskId, kind: currentKind });
        handle.current = returned ?? null; setPicking(Boolean(returned)); setError('');
        if (immediate && returned) { returned.assertCurrent(); returned.confirm(); }
      } else if (current.onPick) {
        current.onPick({ kind: currentKind, title: current.label + ' · 交互式选择', initial: inputSelectionIndices(current.structure, initial), onApply: indices => {
          assertLocal(); const current = latest.current.props.structure!; const ids = indices.map(index => current.atoms[index]?.id ?? ''); inputSelectionIndices(current, ids); draft(ids); accept(ids, assertLocal);
        } });
      } else throw new Error('当前界面没有交互式选择入口，请填写编号后确定。');
    } catch (cause) { setError(causeText(cause)); }
  }
  function confirmOverwrite() {
    if (!pending) return;
    try {
      pending.guard();
      if (handle.current) { overwritePermit.current = { ids: [...pending.ids], guard: pending.guard }; handle.current.confirm(); }
      else accept(pending.ids, pending.guard, true);
    } catch (cause) { overwritePermit.current = null; setPending(null); setError(causeText(cause)); }
  }
  const identityError = props.structure ? regionSelectionIdentityError(props.structure) : null;
  const disabled = props.disabled || !props.structure || Boolean(identityError);
  function appendRemaining() {
    try {
      // Single collections supply their complement; partitioned collections supply
      // all members not owned by other rows. Both preserve the current draft.
      const current = text.trim() ? parseInteractiveSelection(text, props.structure!, kind) : [];
      draft([...new Set([...current, ...(props.remainingAtomIds ?? [])])]);
    } catch (cause) { setError(causeText(cause)); }
  }
  const selectionActions = <>{kind==='atoms'&&props.remainingAtomIds && <button type="button" disabled={disabled || picking || !props.remainingAtomIds.length} onClick={appendRemaining}>使用剩余所有原子</button>}{!!props.draftChoices?.length&&<select aria-label={props.label+'更多选择'} value="" disabled={disabled||picking} onChange={event=>{const choice=props.draftChoices?.[Number(event.target.value)];if(choice)draft([...choice.atomIds]);}}><option value="" disabled>更多选择</option>{props.draftChoices.map((choice,index)=><option key={choice.label} value={index} disabled={!choice.atomIds.length}>{choice.label}</option>)}</select>}</>;
  function clear() { try{latest.current.props.onClear?.();handle.current?.cancel();handle.current=null;setPicking(false);setPending(null);}catch(cause){setError(causeText(cause));} }
  const actionButtons=<><button type="button" className="button button-white" disabled={disabled || picking || (!props.onRequestSelection && !props.onRequestAnalysisSelection && !props.onPick)} aria-label={props.label + '交互式选择'} title="交互式选择" onClick={() => pick()}><span className="interactive-selection-button-text">交互式选择</span><MousePointer2 className="interactive-selection-button-icon" size={15} aria-hidden="true"/></button>
      <button type="button" className="button button-primary" disabled={disabled} aria-label={props.label + '确定'} title="确定选择" onClick={confirm}><span className="interactive-selection-button-text">确定</span><Check className="interactive-selection-button-icon" size={15} aria-hidden="true"/></button></>;
  const clearAction = props.onClear && <SelectionRemoveButton label={props.clearLabel??`清空${props.label}定义`} disabled={disabled||props.clearDisabled} onClick={clear}/>;
  const numberControl = <label className="field">原子编号<input aria-label={props.label + '原子编号'} placeholder={kind === 'atoms' ? '1-10,21' : '按顺序填2、3或4个编号'} value={text} disabled={disabled || picking&&!props.liveNumberDraft} aria-invalid={!!error} onChange={event=>updateNumbers(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); confirm(); } }} /></label>;
  const field = <div className="interactive-selection-field" data-testid="interactive-selection-field" data-row-id={props.rowId} data-picking={picking}>
    {props.renderHeader ? props.renderHeader(null) : !props.renderContainer && clearAction && (props.headerVariant==='subcard'
      ? <InputSettingsCardHeader title={props.label} titleRole="subcard" actions={<span className="interactive-selection-header-actions">{clearAction}</span>}/>
      : <SelectionGroupHeader title={props.label} actions={clearAction}/>)}
    {props.renderSelectionRow ? props.renderSelectionRow(numberControl, actionButtons) : <div className="interactive-selection-row interactive-selection-row-wrap">{numberControl}
      <span className="interactive-selection-buttons">{actionButtons}</span></div>}
    {picking && <div className="interactive-selection-actions"><button type="button" onClick={() => { handle.current?.cancel(); handle.current = null; setPicking(false); if(!props.preserveNumberDraftOnCancel)setText(canonical); setPending(null); }}>取消本次选择</button></div>}
    {picking&&props.renderDraft?.(draftIds.current,draftImages.current)}
    {!picking&&(kind==='atoms'&&props.remainingAtomIds||props.draftChoices?.length)&&<div className="interactive-selection-actions">{selectionActions}</div>}
    {text !== canonical && !picking && !pending && <p className="interactive-selection-hint">编号草稿尚未确认，当前科学成员不变。</p>}
    {pending && <div role="alertdialog" aria-label="区域覆盖确认" className="interactive-selection-conflict"><p>{pending.conflict.message}</p><button type="button" onClick={confirmOverwrite}>确认覆盖</button><button type="button" onClick={() => { overwritePermit.current = null; setPending(null); }}>取消覆盖</button></div>}
    {error && <DismissibleNotice className="interactive-selection-error" role="alert">{error}</DismissibleNotice>}
    {identityError && <DismissibleNotice className="interactive-selection-error" role="alert">{identityError}</DismissibleNotice>}
  </div>;
  return props.renderContainer ? props.renderContainer(field, clearAction) : field;
}
