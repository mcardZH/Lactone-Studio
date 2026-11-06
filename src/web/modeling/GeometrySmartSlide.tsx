import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useId, useRef, useState } from 'react';
import { builderEditableGeometryFrame, geometrySideFractions, type BalancedGeometryEdit, type GeometrySideMode } from '../../core/builder-geometry';
import type { Structure, Vector3 } from '../../core/types';
import { graphFingerprint } from '../../core/modeling/graph';
import {ScientificEditCancelledError} from '../../core/modeling/analysis-binding';
import './geometry-smart-slide.css';

export interface GeometrySmartSlideProps {
  structure: Structure;
  /** Blue, ordered measurement IDs. Never use the editing selection as fallback. */
  measurementAtomIds: readonly string[];
  /** Exact ordered periodic endpoints belong to the measurement, not a nearest-image guess. */
  measurementImages?: readonly Vector3[];
  selectedAtomIds: readonly string[];
  /** Main owns the completed measurement record and opens this view on demand. */
  open?: boolean;
  recordId?: string;
  onClose?(): void;
  floating?: boolean;
  initialPosition?: { x: number; y: number };
  explicitSideAtomIds?: { first: readonly string[]; last: readonly string[] };
  fixedAtomIds?: readonly string[];
  /** Keep wheel editing on the same deliberate side scopes as this panel. */
  onScopeChange?(scope:Pick<BalancedGeometryEdit,'moving'|'sideModes'|'sideAtomIds'>):void;
  /** Exact active connection supplied by Main when periodic images/auxiliary edges are involved. */
  bondOrder?: number | null;
  onBondOrderChange?(order: 0.5 | 1 | 1.5 | 2 | 3): void;
  disabled?: boolean;
  onBegin(): void;
  /** Solve this absolute target from baseline, then validate and commit its XYZ.
   * Throw when rejected so the tool cannot present a failed edit as accepted. */
  onPreview(edit: BalancedGeometryEdit, baseline: Structure): void;
  onCommit(): void;
  onCancel(): void;
  onError?(message: string): void;
}
type Gesture = { baseline: Structure; atomIds: string[]; images?: Vector3[]; selectedAtomIds: string[]; kind: 'B' | 'A' | 'D'; moving: 'branch' | 'selected' | 'atom'; sideAtomIds?: { first: string[]; last: string[] };sideModes?:BalancedGeometryEdit['sideModes'];fixedAtomIds:readonly string[] };
const reason = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const titles = { B: '距离', A: '夹角', D: '二面角' };
const coordinateKind = (count: number): 'B' | 'A' | 'D' | null => count === 2 ? 'B' : count === 3 ? 'A' : count === 4 ? 'D' : null;

export default function GeometrySmartSlide(props: GeometrySmartSlideProps) {
  const valueId = 'smart-slide-value-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const { structure, measurementAtomIds, selectedAtomIds, disabled = false, open = true, floating = true } = props;
  const callbacks = useRef(props); callbacks.current = props;
  const gesture = useRef<Gesture | null>(null), errorRef = useRef('');
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState<string | null>(null), [error, setError] = useState('');
  const [movingPreset, setMoving] = useState<'branch' | 'selected' | 'atom'>('branch');
  const [sideModes,setSideModes]=useState<{first:GeometrySideMode;last:GeometrySideMode}>({first:'branch',last:'branch'});
  const panel = useRef<HTMLElement | null>(null);
  const panelDrag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const [position, setPosition] = useState(() => props.initialPosition ?? { x: 64, y: 96 });
  const kind = coordinateKind(measurementAtomIds.length);
  const moving = kind === 'B' && movingPreset === 'selected' ? 'branch' : movingPreset;
  const pairIndices = measurementAtomIds.map(id => structure.atoms.findIndex(atom => atom.id === id));
  const pairBonds = kind === 'B' ? structure.bonds?.filter(bond => (bond.a === pairIndices[0] && bond.b === pairIndices[1]) || (bond.a === pairIndices[1] && bond.b === pairIndices[0])) ?? [] : [];
  const bondOrder = props.bondOrder !== undefined ? props.bondOrder : pairBonds.length === 1 ? pairBonds[0].order : null;
  let current: number | null = null, measurementError = '';
  if (kind) try {
    if (kind !== 'B' && props.measurementImages?.some(image => image.some(Boolean))) throw new Error('跨晶胞镜像的夹角与二面角仅供测量，暂不支持几何编辑。');
    current = builderEditableGeometryFrame(structure, kind, measurementAtomIds, props.measurementImages).value;
  } catch (cause) { measurementError = reason(cause); }
  const signature = JSON.stringify([structure.id, props.recordId, measurementAtomIds, props.measurementImages, selectedAtomIds, props.explicitSideAtomIds, props.fixedAtomIds, graphFingerprint(structure)]);
  const scopedSides=moving==='selected'&&props.explicitSideAtomIds?{first:[...props.explicitSideAtomIds.first],last:[...props.explicitSideAtomIds.last]}:undefined;
  const scopeSignature=JSON.stringify([moving,sideModes,scopedSides]);
  useEffect(()=>{callbacks.current.onScopeChange?.({moving,sideModes:moving==='selected'?undefined:sideModes,sideAtomIds:scopedSides});},[scopeSignature]);
  function showError(value: string) { errorRef.current = value; setError(value); if (value) callbacks.current.onError?.(value); }
  function cancel(clear = true) {
    if (gesture.current) { callbacks.current.onCancel(); gesture.current = null; }
    setEditing(false); setDraft(null); if (clear) showError('');
  }
  function failed(cause:unknown) {
    if (cause instanceof ScientificEditCancelledError) {
      callbacks.current.onCancel();gesture.current=null;setEditing(false);setDraft(null);showError('');return;
    }
    showError(reason(cause));
  }
  // A changed measurement/scope/graph or runtime transition cannot keep a stale
  // gesture. XYZ revisions produced by this gesture intentionally do not cancel it.
  useEffect(() => { if (gesture.current) cancel(); else { setDraft(null); showError(''); } }, [signature, disabled, open]);
  useEffect(() => () => { if (gesture.current) { callbacks.current.onCancel(); gesture.current = null; } }, []);
  function clampPosition(next: { x: number; y: number }) {
    const view = panel.current?.ownerDocument.defaultView;
    if (!view) return next;
    const bounds = panel.current!.getBoundingClientRect();
    return { x: Math.max(8, Math.min(next.x, Math.max(8, view.innerWidth - bounds.width - 8))),
      y: Math.max(8, Math.min(next.y, Math.max(8, view.innerHeight - bounds.height - 8))) };
  }
  useEffect(() => {
    if (!open || !floating) return;
    setPosition(currentPosition => clampPosition(props.initialPosition ?? currentPosition));
    const view = panel.current?.ownerDocument.defaultView;
    const resize = () => setPosition(currentPosition => clampPosition(currentPosition));
    view?.addEventListener('resize', resize);
    return () => view?.removeEventListener('resize', resize);
  }, [open, floating, props.initialPosition?.x, props.initialPosition?.y]);
  function begin() {
    if (gesture.current) return gesture.current;
    if (!open || disabled || !kind || current === null || measurementError) throw new Error(measurementError || '请指定完整的B、A或D测量。');
    callbacks.current.onBegin();
    gesture.current = { baseline: structuredClone(structure), atomIds: [...measurementAtomIds], images: props.measurementImages?.map(image => [...image] as Vector3), selectedAtomIds: [...selectedAtomIds], kind, moving,sideModes:moving==='selected'?undefined:{...sideModes},fixedAtomIds:[...(props.fixedAtomIds??[])],
      sideAtomIds: moving === 'selected' && props.explicitSideAtomIds ? { first: [...props.explicitSideAtomIds.first], last: [...props.explicitSideAtomIds.last] } : undefined };
    setEditing(true); return gesture.current;
  }
  function preview(text: string) {
    setDraft(text);
    const value = text.trim() === '' ? NaN : Number(text);
    if (!Number.isFinite(value)) { showError('请输入有限数值。'); return; }
    try {
      const active = begin();
      if (active.kind === 'B' && value <= 0) throw new Error('键长必须大于零。');
      if (active.kind === 'A' && (value <= 0 || value >= 180)) throw new Error('键角必须位于0与180°之间。');
      const edit: BalancedGeometryEdit = { coordinate: active.kind, atomIds: active.atomIds, images: active.images, value, moving: active.moving,
        selectedAtomIds: active.moving === 'selected' ? active.selectedAtomIds : undefined, sideAtomIds: active.sideAtomIds,sideModes:active.sideModes,fixedAtomIds:active.fixedAtomIds };
      callbacks.current.onPreview(edit, active.baseline); showError('');
    } catch (cause) { failed(cause); }
  }
  function commit() {
    if (!gesture.current) return;
    if (errorRef.current) { cancel(false); return; }
    try { callbacks.current.onCommit(); gesture.current = null; setEditing(false); setDraft(null); }
    catch (cause) { failed(cause); cancel(false); }
  }
  const base = gesture.current ? builderEditableGeometryFrame(gesture.current.baseline, gesture.current.kind, gesture.current.atomIds, gesture.current.images).value : current;
  const minimum = kind === 'B' ? .1 : kind === 'A' ? .1 : -180;
  const maximum = kind === 'B' ? Math.max(6, (base ?? 1.5) * 2) : kind === 'A' ? 179.9 : 180;
  const step = kind === 'B' ? .01 : kind === 'A' ? .1 : .5;
  const displayed = draft ?? (current === null ? '' : current.toFixed(kind === 'B' ? 3 : 2));
  const numeric = displayed.trim() === '' ? NaN : Number(displayed);
  const sliderValue = Math.max(minimum, Math.min(maximum, Number.isFinite(numeric) ? numeric : base ?? minimum));
  const labels = measurementAtomIds.map(id => { const i = structure.atoms.findIndex(atom => atom.id === id); return i < 0 ? '?' : `${i + 1}`; });
  const unavailable = disabled || !kind || current === null || Boolean(measurementError);
  let balance='两侧各半',scopeError='';
  if(kind&&current!==null)try{
    const fractions=geometrySideFractions(structure,{coordinate:kind,atomIds:[...measurementAtomIds],images:props.measurementImages?.map(image=>[...image] as Vector3),value:current,moving,sideModes:moving==='selected'?undefined:sideModes,sideAtomIds:scopedSides,selectedAtomIds:[...selectedAtomIds],fixedAtomIds:props.fixedAtomIds});
    balance=!fractions.first&&!fractions.last?'两侧固定':!fractions.first?'首侧固定 · 末侧全动':!fractions.last?'末侧固定 · 首侧全动':'两侧各半';
  }catch(cause){scopeError=reason(cause);}
  function close() { cancel(); props.onClose?.(); }
  if (!open) return null;
  return <section ref={panel} className="geometry-smart-slide" aria-label="B/A/D几何滑条" data-testid="geometry-smart-slide" data-gesture={editing ? 'active' : 'idle'} data-floating={floating}
    style={floating ? { left: position.x, top: position.y } : undefined}
    onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onWheel={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); if (gesture.current) cancel(); else props.onClose?.(); } }} onKeyUp={event => event.stopPropagation()}>
    <header className="geometry-smart-header" data-testid="geometry-floating-handle"
      onPointerDown={event => {
        if (!floating || event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
        event.preventDefault(); event.stopPropagation();
        panelDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: position.x, y: position.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { const active = panelDrag.current; if (active?.pointerId === event.pointerId) {
        event.preventDefault(); event.stopPropagation(); setPosition(clampPosition({ x: active.x + event.clientX - active.startX, y: active.y + event.clientY - active.startY }));
      } }}
      onPointerUp={event => { if (panelDrag.current?.pointerId === event.pointerId) { panelDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }}
      onPointerCancel={() => { panelDrag.current = null; }} onLostPointerCapture={() => { panelDrag.current = null; }}>
      <strong>编辑几何</strong><span className="geometry-measurement-order" data-testid="geometry-measurement-order">{kind ? `${kind} · ${labels.join(' → ')}` : '有序测量'}</span>
      {props.onClose && <button type="button" className="geometry-smart-close" aria-label="关闭几何编辑" onClick={close}>×</button>}
    </header>
    {!kind && <p className="geometry-smart-note">请选择已完成的B、A或D标注。</p>}
    <fieldset disabled={unavailable}>
      <div className="geometry-smart-value"><label htmlFor={valueId}>{kind ? titles[kind] : '目标值'}</label>
        <input id={valueId} aria-label="几何目标值" type="text" inputMode="decimal" value={displayed} onChange={event => preview(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} aria-invalid={Boolean(error)} />
        <span>{kind === 'B' ? 'Å' : '°'}</span><output aria-label="当前几何值">当前 {current === null ? '—' : current.toFixed(kind === 'B' ? 3 : 2)}</output>
      </div>
      <input className="geometry-smart-range" type="range" aria-label="几何连续滑条" min={minimum} max={maximum} step={step} value={sliderValue}
        onPointerDown={event => { try { begin(); event.currentTarget.setPointerCapture(event.pointerId); } catch (cause) { event.preventDefault();failed(cause); } }}
        onChange={event => preview(event.target.value)} onPointerUp={() => commit()} onPointerCancel={() => cancel()}
        onKeyDown={event => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) try { begin(); } catch (cause) { event.preventDefault();failed(cause); } }}
        onKeyUp={event => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) commit(); }}
        onBlur={() => { if (gesture.current && !errorRef.current) commit(); }} />
      <div className="geometry-smart-roles"><span className="geometry-smart-balance">首侧 {labels[0] ?? '—'} / 末侧 {labels.at(-1) ?? '—'}<small>{balance}</small></span>
        <label>范围预设<select aria-label="几何移动范围" value={moving} disabled={editing} onChange={event => {const value=event.target.value as 'branch' | 'selected' | 'atom';setMoving(value);if(value!=='selected')setSideModes({first:value,last:value});}}>
          <option value="branch">两侧连接分支</option>{kind !== 'B' && <option value="selected">明确选区</option>}<option value="atom">两端原子</option></select></label>
        {moving!=='selected'&&(['first','last'] as const).map(side=><label key={side}>{side==='first'?'首侧':'末侧'}<select aria-label={side==='first'?'几何首侧移动':'几何末侧移动'} value={sideModes[side]} disabled={editing} onChange={event=>setSideModes(value=>({...value,[side]:event.target.value as GeometrySideMode}))}>
          <option value="fixed">固定</option><option value="atom">仅端原子</option><option value="branch">连接片段</option>
        </select></label>)}
      </div>
      {kind === 'B' && props.onBondOrderChange && <div className="geometry-smart-bond"><label>键型／样式<select aria-label="距离键型与样式" value={bondOrder ?? ''} disabled={editing || bondOrder === null} onChange={event => { try { props.onBondOrderChange?.(Number(event.target.value) as 0.5 | 1 | 1.5 | 2 | 3); showError(''); } catch (cause) { failed(cause); } }}>
        {bondOrder === null && <option value="">未连接</option>}<option value="0.5">0.5 · 短杆虚线</option><option value="1">单键 · 实杆</option><option value="1.5">1.5键</option><option value="2">双键</option><option value="3">三键</option>
      </select></label></div>}
    </fieldset>
    {editing && <div className="geometry-smart-actions"><button type="button" onClick={commit} disabled={Boolean(error)}>确认几何</button><button type="button" onClick={() => cancel()}>取消几何</button></div>}
    <p className="geometry-smart-note">两侧可动时各半，一侧固定时另一侧全动。连接片段刚性移动；夹角顶点、二面角中轴不动。距离编辑不创建键。含冻结原子的移动侧整体固定。</p>
    {scopeError&&!error&&!measurementError&&<p className="geometry-smart-error" role="status">{scopeError}</p>}
    {(error || measurementError) && <DismissibleNotice className="geometry-smart-error" role="alert">{error || measurementError}</DismissibleNotice>}
  </section>;
}
