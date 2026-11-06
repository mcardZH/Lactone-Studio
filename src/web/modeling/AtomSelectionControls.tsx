import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Structure } from '../../core/types';
import { atomSelectionGraphKey, expandAtomSelectionByBonds, parseAtomSelectionText, selectedAtomNumbers } from '../../modeling/application/atom-selection-tools';
import './atom-selection-controls.css';

export interface AtomSelectionToolsProps {
  documentId: string;
  structure: Structure;
  atomIds: readonly string[];
  /** Task captures and inactive document surfaces disable both controls. */
  disabled?: boolean;
  onSelect(atomIds: string[], origin: 'numbers' | 'bond'): void;
  onGestureBegin?(): void;
  onGestureEnd?(): void;
  assertCurrent?(): void;
}
export interface AtomSelectionControlState {
  text: string; message: string; invalid: boolean; disabled: boolean;
  bondEnabled: boolean; depth: number; hasSeeds: boolean;
  changeText(text: string): void;
  compositionStart(): void;
  compositionEnd(text: string): void;
  toggleBond(): void;
  changeDepth(depth: number): void;
  beginGesture(): void;
  endGesture(): void;
  /** Main calls this for ordinary manual selection, including equal-set picks. */
  resetSeeds(atomIds: readonly string[]): void;
}
const selectionKey = (ids: readonly string[]) => JSON.stringify([...new Set(ids)].sort());

/** Own only ephemeral text, fixed seeds and a slider gesture. Store owns the
 * yellow selection and its history; no model/scientific state is duplicated. */
export function useAtomSelectionTools(props: AtomSelectionToolsProps): AtomSelectionControlState {
  const latest = useRef(props); latest.current = props;
  const key = atomSelectionGraphKey(props.documentId, props.structure), selected = selectionKey(props.atomIds);
  const [text, setText] = useState(() => selectedAtomNumbers(props.structure, props.atomIds));
  const [message, setMessage] = useState(''), [invalid, setInvalid] = useState(false);
  const [bondEnabled, setBondEnabled] = useState(false), [depth, setDepth] = useState(0);
  const seed = useRef([...props.atomIds]), ownSelection = useRef<string | null>(null), graphKey = useRef(key);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), composing = useRef(false), gesture = useRef(false), alive = useRef(true);
  function cancelTimer() { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; }
  function endGesture() { if (!gesture.current) return; gesture.current = false; latest.current.onGestureEnd?.(); }
  function beginGesture() {
    if (latest.current.disabled || !bondEnabled || !seed.current.length || gesture.current) return;
    try { latest.current.assertCurrent?.(); latest.current.onGestureBegin?.(); gesture.current = true; }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); setInvalid(true); }
  }
  function resetSeeds(ids: readonly string[]) {
    cancelTimer(); endGesture(); seed.current = [...new Set(ids)]; setDepth(0); ownSelection.current = null;
    setText(selectedAtomNumbers(latest.current.structure,ids));setMessage('');setInvalid(false);
  }
  useEffect(() => {
    const differentGraph = graphKey.current !== key;
    if (differentGraph) { graphKey.current = key; setBondEnabled(false); }
    if (differentGraph || ownSelection.current !== selected) resetSeeds(props.atomIds);
    cancelTimer(); setText(selectedAtomNumbers(props.structure, props.atomIds)); setMessage(''); setInvalid(false);
  }, [key, selected]);
  useEffect(() => { if (props.disabled) { cancelTimer(); composing.current = false; endGesture(); } }, [props.disabled]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; cancelTimer(); endGesture(); }; }, []);
  function apply(ids: string[], origin: 'numbers' | 'bond') {
    const current = latest.current; current.assertCurrent?.();
    ownSelection.current = selectionKey(ids); current.onSelect(ids, origin);
    setText(selectedAtomNumbers(current.structure, ids)); setMessage(''); setInvalid(false);
  }
  function changeText(value: string) {
    setText(value); cancelTimer();
    if (latest.current.disabled || composing.current) return;
    const current = latest.current, capturedKey = atomSelectionGraphKey(current.documentId, current.structure), parsed = parseAtomSelectionText(value, current.structure);
    if (parsed.status !== 'valid') { setMessage(parsed.message); setInvalid(parsed.status === 'invalid'); return; }
    setMessage(''); setInvalid(false);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!alive.current || composing.current || latest.current.disabled || atomSelectionGraphKey(latest.current.documentId, latest.current.structure) !== capturedKey) return;
      try { resetSeeds(parsed.atomIds); apply(parsed.atomIds, 'numbers'); }
      catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); setInvalid(true); }
    }, 150);
  }
  function toggleBond() {
    if (latest.current.disabled) return;
    cancelTimer(); resetSeeds(latest.current.atomIds); setBondEnabled(previous => !previous);
  }
  function changeDepth(value: number) {
    if (latest.current.disabled || !bondEnabled || graphKey.current !== atomSelectionGraphKey(latest.current.documentId, latest.current.structure)) return;
    try { const ids = expandAtomSelectionByBonds(latest.current.structure, seed.current, value); apply(ids, 'bond'); setDepth(value); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); setInvalid(true); }
  }
  return { text, message, invalid, disabled: Boolean(props.disabled), bondEnabled, depth, hasSeeds: seed.current.length > 0,
    changeText, compositionStart: () => { composing.current = true; cancelTimer(); setMessage(''); setInvalid(false); },
    compositionEnd: value => { composing.current = false; changeText(value); }, toggleBond, changeDepth, beginGesture, endGesture, resetSeeds };
}

/** Single numbering row, placed below the right-hand selection group. */
export default function AtomSelectionControls({ controls }: { controls: AtomSelectionControlState }) {
  return <div className="atom-selection-controls" data-testid="atom-selection-controls" data-no-reorder onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    <label>被选择的原子<input aria-label="被选择的原子" data-testid="builder-selection-input" value={controls.text} placeholder="1-5,8" disabled={controls.disabled} aria-invalid={controls.invalid}
      onChange={event => controls.changeText(event.target.value)} onCompositionStart={controls.compositionStart} onCompositionEnd={event => controls.compositionEnd(event.currentTarget.value)} /></label>
    {controls.message && <span className="atom-selection-message" role="status">{controls.message}</span>}
  </div>;
}
const sliderKey = (event: KeyboardEvent<HTMLInputElement>) => ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key);
/** Main places this after point/box controls, retaining one shared seed owner. */
export function BondSelectionControls({ controls, showButton=true, showRange=true }: { controls: AtomSelectionControlState; showButton?:boolean; showRange?:boolean }) {
  return <div className="bond-selection-controls" data-testid={showButton?'bond-selection-controls':'bond-selection-range'} data-no-reorder onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    {showButton&&<button type="button" aria-label="键选" aria-pressed={controls.bondEnabled} disabled={controls.disabled} onClick={controls.toggleBond}>键选</button>}
    {showRange&&controls.bondEnabled && <label>键数<input type="range" aria-label="键选深度" min="0" max="4" step="1" value={controls.depth} disabled={controls.disabled || !controls.hasSeeds}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); controls.beginGesture(); }} onPointerUp={controls.endGesture} onPointerCancel={controls.endGesture} onLostPointerCapture={controls.endGesture}
      onKeyDown={event => { event.stopPropagation(); if (sliderKey(event)) controls.beginGesture(); }} onKeyUp={event => { event.stopPropagation(); if (sliderKey(event)) controls.endGesture(); }} onBlur={controls.endGesture}
      onChange={event => controls.changeDepth(Number(event.target.value))} /><output aria-label="当前键选深度">{controls.depth}</output></label>}
    {showRange&&controls.bondEnabled && !controls.hasSeeds && <span className="atom-selection-message">先选择种子原子。</span>}
  </div>;
}
