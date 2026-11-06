import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PeriodicCell, Vector3 } from '../../core/types';
import type { StructureTransformCandidate } from '../../core/modeling/contracts';
import { cellParameters } from '../../core/periodic';
import NumericInput from '../NumericInput';
import { assignedCellLengths, cellOutsideAtomCount, orthogonalCellFrame, prepareCellEditorCandidate,
  type AssignCellRequest, type CellAxis, type CellAtomHandling, type CellEditorRequest } from '../../core/modeling/cell-editor';
import { TransformPreviewFooter, useStructureTransformPreview, type StructureTransformPanelProps } from './structure-transform-panel';
import './cell-editor.css';

export interface CellEditorViewportDraft {
  documentId: string; expectedRevision: number; cell: PeriodicCell;
  lengths: Vector3; activeAxis: CellAxis | null;
  /** Reuse physical-axis hover presentation outside the editable cell card. */
  readOnly?: boolean;
  onAxisHover(axis: CellAxis | null): void;
  onLengthChange(axis: CellAxis, length: number): void;
  onDragStart(): void;
  onDragEnd(cancel?: boolean): void;
  onLengthCommit(axis: CellAxis, length: number): void;
}
export interface CellEditorPanelProps extends Omit<StructureTransformPanelProps<CellEditorRequest>, 'onPrepare'> {
  onCellEditorChange?(draft: CellEditorViewportDraft | null): void;
  previewActive?: boolean;
  onCommitEdit?(candidate: StructureTransformCandidate): void | Promise<void>;
  onSaveCheckpoint?(): void;
  onRestoreCheckpoint?(): void | Promise<void>;
  draft?: CellEditorPanelState;
  onDraftChange?(draft: CellEditorPanelState): void;
}

export interface CellEditorPanelState {
  assign: AssignCellRequest; paddingText: string; assignTexts: LengthTexts; editTexts: LengthTexts;
  handling: [CellAtomHandling, CellAtomHandling, CellAtomHandling]; assignOpen: boolean; editOpen: boolean;
}
type LengthTexts = [string, string, string];
const axes = [0, 1, 2] as const;
const initialAssign: AssignCellRequest = { type: 'assign-cell', mode: 'padding', lengths: [10, 10, 10], padding: 5, shape: 'orthogonal', center: true };
const texts = (lengths: Vector3): LengthTexts => lengths.map(value => String(Number(value.toPrecision(12)))) as LengthTexts;

/** Two peer cards; model data alone determines whether an editable cell exists. */
export default function CellEditorPanel(props: CellEditorPanelProps) {
  const structure = props.document.draft.structure, hasCell = Boolean(structure.cell);
  const [assign, setAssign] = useState(props.draft?.assign ?? initialAssign), [paddingText, setPaddingText] = useState(props.draft?.paddingText ?? '5');
  const [assignTexts, setAssignTexts] = useState<LengthTexts>(props.draft?.assignTexts ?? ['10', '10', '10']);
  const [editTexts, setEditTexts] = useState<LengthTexts>(() => props.draft?.editTexts ?? (structure.cell ? texts(cellParameters(structure.cell).slice(0, 3) as Vector3) : ['10', '10', '10']));
  const [handling, setHandling] = useState<[CellAtomHandling, CellAtomHandling, CellAtomHandling]>(props.draft?.handling ?? ['cartesian', 'cartesian', 'cartesian']);
  const [assignOpen, setAssignOpen] = useState(props.draft?.assignOpen ?? !hasCell), [editOpen, setEditOpen] = useState(props.draft?.editOpen ?? true);
  const [commitError, setCommitError] = useState(''), [committing, setCommitting] = useState(false);
  const commitPending = useRef(false);
  const [activeAxis, setActiveAxis] = useState<CellAxis | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragBefore = useRef<LengthTexts | null>(null);
  let frame: ReturnType<typeof orthogonalCellFrame> | null = null, cellError = '';
  try { if (structure.cell) frame = orthogonalCellFrame(structure.cell); }
  catch (cause) { cellError = cause instanceof Error ? cause.message : String(cause); }
  const assignRequest = { ...assign, lengths: assignTexts.map(value => value.trim() ? Number(value) : NaN) as Vector3,
    padding: paddingText.trim() ? Number(paddingText) : NaN };
  const editRequest: CellEditorRequest = { type: 'edit-cell', lengths: editTexts.map(value => value.trim() ? Number(value) : NaN) as Vector3, handling };
  const request = hasCell ? editRequest : assignRequest;
  const key = JSON.stringify([request, dragging]);
  const preview = useStructureTransformPreview<CellEditorRequest>({ ...props, open: props.open && props.previewActive !== false && !hasCell,
    onPrepare: next => prepareCellEditorCandidate(props.document, next) }, key, () => request);
  const commitEdit = async (values: LengthTexts) => {
    if (!props.onCommitEdit || props.disabled || !frame || commitPending.current) return;
    try {
      const lengths = values.map(value => value.trim() ? Number(value) : NaN) as Vector3;
      if (lengths.every((value, axis) => value === frame.lengths[axis])) return;
      const candidate = prepareCellEditorCandidate(props.document, { type: 'edit-cell', lengths, handling });
      commitPending.current = true; setCommitting(true); setCommitError(''); await props.onCommitEdit(candidate);
    } catch (cause) { setCommitError(cause instanceof Error ? cause.message : String(cause)); }
    finally { commitPending.current = false; setCommitting(false); }
  };
  const latest = useRef({ props, frame, editTexts, preview, commitEdit });
  latest.current = { props, frame, editTexts, preview, commitEdit };
  useEffect(() => {
    setEditTexts(structure.cell ? texts(cellParameters(structure.cell).slice(0, 3) as Vector3) : ['10', '10', '10']);
    setActiveAxis(null); setDragging(false); dragBefore.current = null;
  }, [props.document.id, JSON.stringify(structure.cell)]);
  useEffect(() => { props.onDraftChange?.({ assign, paddingText, assignTexts, editTexts, handling, assignOpen, editOpen }); },
    [assign, paddingText, assignTexts, editTexts, handling, assignOpen, editOpen]);
  useEffect(() => {
    props.onPreviewPresentationChange?.(preview.live && preview.candidate ? {
      mode: 'single', source: structure, candidate: preview.candidate,
    } : null);
  }, [preview.live, preview.candidate]);
  useEffect(() => () => { latest.current.props.onPreviewPresentationChange?.(null); latest.current.props.onCellEditorChange?.(null); }, []);
  const handlers = useMemo(() => ({
    onAxisHover: (axis: CellAxis | null) => setActiveAxis(axis),
    onLengthChange: (axis: CellAxis, length: number) => {
      const current = latest.current;
      if (current.props.disabled || !current.frame || !Number.isFinite(length) || length <= 0) return;
      // Pointer placement has finite pixel precision; suppress projection noise
      // at 0.0001 Å without rounding explicitly typed lengths or source data.
      setEditTexts(previous => previous.map((value, index) => index === axis ? String(Number(length.toFixed(4))) : value) as LengthTexts);
    },
    onDragStart: () => {
      if (latest.current.props.disabled || !latest.current.frame) return;
      dragBefore.current = [...latest.current.editTexts]; setDragging(true);
    },
    onDragEnd: (cancel = false) => {
      if (cancel && dragBefore.current) setEditTexts(dragBefore.current);
      if (!cancel) void latest.current.commitEdit(latest.current.editTexts);
      dragBefore.current = null; setDragging(false); setActiveAxis(null);
    },
    onLengthCommit: (axis: CellAxis, length: number) => {
      const values = latest.current.editTexts.map((value, index) => index === axis ? String(length) : value) as LengthTexts;
      setEditTexts(values); void latest.current.commitEdit(values);
    },
  }), []);
  const { candidate, draftError } = useMemo(() => {
    try { return { candidate: prepareCellEditorCandidate(props.document, request), draftError: '' }; }
    catch (cause) { return { candidate: null, draftError: cause instanceof Error ? cause.message : String(cause) }; }
  }, [props.document, JSON.stringify(request)]);
  const shownLengths = hasCell ? frame?.lengths : (() => { try { return assignedCellLengths(structure, assignRequest); } catch { return null; } })();
  const validLengths = editRequest.lengths.every(value => Number.isFinite(value) && value > 0);
  // Hover callbacks are stable. Only actual draft/source/hover changes publish a new bridge.
  const viewportDraft = useMemo<CellEditorViewportDraft | null>(() => {
    if (!structure.cell || !frame || props.disabled || !props.open || props.previewActive === false || !editOpen) return null;
    let cell = structure.cell;
    if (validLengths) cell = { ...structure.cell, vectors: frame.directions.map((direction, axis) => direction.map(value => value * editRequest.lengths[axis]) as Vector3) as [Vector3, Vector3, Vector3] };
    return { documentId: props.document.id, expectedRevision: props.document.revision, cell,
      lengths: validLengths ? editRequest.lengths : frame.lengths, activeAxis, ...handlers };
  }, [props.document.id, props.document.revision, structure.cell, props.disabled, props.open, props.previewActive, editOpen, editTexts.join(','), activeAxis, Boolean(frame), handlers]);
  useEffect(() => { props.onCellEditorChange?.(viewportDraft); }, [viewportDraft, props.onCellEditorChange]);
  useEffect(() => {
    if (!hasCell) return;
    const active = props.open && props.previewActive !== false && editOpen && !props.disabled && validLengths;
    props.onPreviewChange?.(active && candidate ? candidate : null);
    props.onPreviewPresentationChange?.(active && candidate ? { mode: 'single', source: structure, candidate } : null);
  }, [hasCell, props.open, props.previewActive, props.disabled, editOpen, candidate]);
  const outside = useMemo(() => candidate ? cellOutsideAtomCount(candidate.structure) : 0, [candidate]);
  const updateText = (current: LengthTexts, axis: CellAxis, value: string) => current.map((text, index) => index === axis ? value : text) as LengthTexts;
  return <div className="cell-editor-cards ui-control-surface" data-testid="cell-editor-panel">
    <section className="cell-editor-card" aria-label="赋予晶胞">
      <h3><button type="button" className="cell-editor-card-toggle" aria-expanded={assignOpen} onClick={() => setAssignOpen(!assignOpen)}>赋予晶胞 <span>{hasCell ? '已有晶胞' : assignOpen ? '收起' : '展开'}</span></button></h3>
      {assignOpen && (hasCell ? <p className="structure-transform-muted">已有晶胞，请在下方编辑。</p> : <>
        <fieldset disabled={props.disabled}>
          <div className="structure-transform-row"><label>赋予方式<select aria-label="赋予方式" value={assign.mode} onChange={event => setAssign(current => ({ ...current, mode: event.target.value as AssignCellRequest['mode'] }))}><option value="padding">包围盒外扩</option><option value="lengths">直接长度</option></select></label>
            {assign.mode === 'padding' && <><label>盒形<select aria-label="赋予晶胞盒形" value={assign.shape} onChange={event => setAssign(current => ({ ...current, shape: event.target.value as AssignCellRequest['shape'] }))}><option value="orthogonal">正交盒</option><option value="cube">立方盒</option></select></label><label>每侧外扩 / Å<NumericInput step="any" min="0" aria-label="每侧外扩 / Å" value={paddingText} onChange={event => setPaddingText(event.target.value)}/></label></>}
          </div>
          {assign.mode === 'lengths' && <div className="structure-transform-row">{axes.map(axis => <label key={axis}>{'abc'[axis]} / Å<NumericInput aria-label={`赋予晶胞 ${'abc'[axis]} / Å`} step="any" min="0" value={assignTexts[axis]} onChange={event => setAssignTexts(current => updateText(current, axis, event.target.value))}/></label>)}</div>}
          <label className="structure-transform-check"><input type="checkbox" checked={assign.center} onChange={event => setAssign(current => ({ ...current, center: event.target.checked }))}/>分子居中（包围盒中心）</label>
          {shownLengths && <p className="cell-editor-facts">a / b / c = {shownLengths.map(value => Number(value.toPrecision(8))).join(' / ')} Å · α = β = γ = 90°</p>}
        </fieldset>
        {draftError && <DismissibleNotice role="alert" className="structure-transform-error">{draftError}</DismissibleNotice>}
        {outside > 0 && <p role="status" className="cell-editor-warning">{outside} 个原子在晶胞外；请增大盒长或调整居中。</p>}
        <TransformPreviewFooter preview={preview} disabled={props.disabled || Boolean(draftError)} actionLabel="赋予晶胞"/>
      </>)}
    </section>
    {hasCell && <section className="cell-editor-card" aria-label="编辑晶胞">
      <h3><button type="button" className="cell-editor-card-toggle" aria-expanded={editOpen} onClick={() => setEditOpen(!editOpen)}>编辑晶胞 <span>{editOpen ? '收起' : '展开'}</span></button></h3>
      {editOpen && <>
        {cellError ? <><p className="cell-editor-facts">{cellParameters(structure.cell!).map((value, index) => `${['a', 'b', 'c', 'α', 'β', 'γ'][index]} ${Number(value.toPrecision(8))}${index < 3 ? ' Å' : '°'}`).join(' · ')}</p><p role="status" className="cell-editor-warning">{cellError}</p></> : <fieldset disabled={props.disabled || committing}>
          {axes.map(axis => <div key={axis} className={`cell-editor-axis ${activeAxis === axis ? 'is-active' : ''}`} onPointerEnter={() => setActiveAxis(axis)} onPointerLeave={() => { if (!dragging) setActiveAxis(null); }}>
            <strong>{'abc'[axis]}</strong><span>当前 {Number((frame?.lengths[axis] ?? 0).toPrecision(8))} Å</span>
            <label>长度 / Å<NumericInput min="0" step="0.1" aria-label={`编辑晶胞 ${'abc'[axis]} 新长度 / Å`} value={editTexts[axis]} onChange={event => { const value = event.target.value; setEditTexts(current => updateText(current, axis, value)); }} onBlur={() => void commitEdit(editTexts)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void commitEdit(editTexts); } }}/></label>
            <label>原子处理<select aria-label={`晶胞 ${'abc'[axis]} 原子处理`} value={handling[axis]} onChange={event => setHandling(current => current.map((value, index) => index === axis ? event.target.value as CellAtomHandling : value) as typeof handling)}><option value="cartesian">仅改晶胞</option><option value="stretch">随胞拉伸</option></select></label>
          </div>)}
        </fieldset>}
        {!cellError && draftError && <DismissibleNotice role="alert" className="structure-transform-error">{draftError}</DismissibleNotice>}
        {outside > 0 && !cellError && <p role="status" className="cell-editor-warning">{outside} 个原子在修改后的晶胞外。</p>}
        {commitError && <DismissibleNotice role="alert" className="structure-transform-error">{commitError}</DismissibleNotice>}
        <footer><button type="button" className="structure-transform-apply" disabled={props.disabled || committing || Boolean(draftError)} onClick={() => props.onSaveCheckpoint?.()}>保存</button>
          <button type="button" disabled={props.disabled || committing} onClick={() => { void Promise.resolve(props.onRestoreCheckpoint?.()).catch(cause => setCommitError(cause instanceof Error ? cause.message : String(cause))); }}>恢复初始</button></footer>
      </>}
    </section>}
  </div>;
}
