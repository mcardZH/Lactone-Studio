import { useEffect, useRef, useState } from 'react';
import type { InteractionState, PickResult } from '../../modeling/contracts';
import type { createModelInteraction } from './interaction';
import { createHeldUndoRepeater } from './use-model-shortcuts';
import { editableTarget } from './workspace-actions';

interface Ref<T> { current: T }
interface HeldPointerKey { key: string; mode: 'select' | 'freeze'; used: boolean }
type HeldUndo = ReturnType<typeof createHeldUndoRepeater>;
interface UndoContext { undo(): void; allowed(): boolean }

/** Only owns listeners and their teardown. Shortcut decisions remain with the
 * model interaction/tool-session adapter and the current document callbacks. */
export function bindModelWorkspaceKeys(target: Window, keyEvent: (event: KeyboardEvent, release: boolean) => void) {
  const down = (event: KeyboardEvent) => keyEvent(event, false);
  const up = (event: KeyboardEvent) => keyEvent(event, true);
  target.addEventListener('keydown', down); target.addEventListener('keyup', up, {capture:true});
  return () => { target.removeEventListener('keydown', down); target.removeEventListener('keyup', up, {capture:true}); };
}

export function bindModelWorkspaceUndoGuards(heldUndo: HeldUndo, context: Ref<UndoContext>,
  environment: { window: Window; document: Document; MutationObserver: typeof MutationObserver }
    = { window, document, MutationObserver }) {
  const stop = () => heldUndo.stop();
  const check = () => { if (heldUndo.active && !context.current.allowed()) heldUndo.stop(); };
  environment.window.addEventListener('blur', stop); environment.document.addEventListener('focusin', check);
  const observer = new environment.MutationObserver(check);
  observer.observe(environment.document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['open', 'hidden', 'aria-hidden', 'inert'] });
  return () => {
    stop(); observer.disconnect(); environment.window.removeEventListener('blur', stop);
    environment.document.removeEventListener('focusin', check);
  };
}

interface KeyboardLifecycleOptions {
  keyboard: ReturnType<typeof createModelInteraction>;
  heldPointerKey: Ref<HeldPointerKey | null>;
  heldLetters: Ref<Set<string>>;
  pointerInCanvas: Ref<boolean>;
  hover: Ref<PickResult>;
  setTemporaryPointerMode(value: 'select' | 'freeze' | null): void;
  setInteraction(value: InteractionState): void;
  modalActive: boolean;
  documentId: string;
  active?: boolean;
  structureLocked: boolean;
  editingLayout: boolean;
  undo(): void;
  undoAllowed(): boolean;
}

/** Blur and modal suspension clear transient keyboard bookkeeping; they do not
 * cancel native runtime ownership or commit/cancel a model transaction. */
export function useModelWorkspaceKeyboardLifecycle(options: KeyboardLifecycleOptions) {
  const { keyboard, modalActive, documentId, active, structureLocked, editingLayout } = options;
  useEffect(() => {
    const blur = () => {
      options.heldPointerKey.current = null; options.heldLetters.current.clear(); options.setTemporaryPointerMode(null);
      options.pointerInCanvas.current = false; options.hover.current = { kind: 'none', worldPoint: [0, 0, 0] };
      keyboard.reset('blur'); options.setInteraction(keyboard.getSnapshot());
    };
    const focus = (event:FocusEvent) => { if(editableTarget(event.target))blur(); };
    window.addEventListener('blur', blur);document.addEventListener('focusin',focus);
    return () => {window.removeEventListener('blur', blur);document.removeEventListener('focusin',focus);};
  }, [keyboard]);
  const [heldUndo] = useState(createHeldUndoRepeater);
  const heldUndoContext = useRef<UndoContext>({ undo: options.undo, allowed: () => false });
  heldUndoContext.current = { undo: options.undo, allowed: options.undoAllowed };
  useEffect(() => { heldUndo.stop(); }, [heldUndo, documentId, active, structureLocked, modalActive, editingLayout]);
  useEffect(() => bindModelWorkspaceUndoGuards(heldUndo, heldUndoContext), [heldUndo]);
  useEffect(() => {
    if (!modalActive) return;
    options.pointerInCanvas.current = false; options.hover.current = { kind: 'none', worldPoint: [0, 0, 0] };
    keyboard.reset('blur'); options.setInteraction(keyboard.getSnapshot());
  }, [modalActive, keyboard]);
  return { heldUndo, heldUndoContext };
}
