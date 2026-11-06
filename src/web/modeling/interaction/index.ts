import { ELEMENTS } from '../../../core/elements';
import type {
  BondOrder, InteractionAction, InteractionState, ModelInteractionPort, ModelKeyEvent,
} from '../../../modeling/contracts';

const elements = new Set(ELEMENTS);
const orders: Record<string, BondOrder> = { '1': 1, '2': 2, '3': 3, '4': 1.5, '5': 0.5 };
const shortcuts: Record<string, InteractionAction['type']> = {
  c: 'copy', v: 'paste', s: 'save', z: 'undo', y: 'redo',
};

function symbol(value: string): string | null {
  if (!/^[a-z]{1,2}$/i.test(value)) return null;
  const normalized = value[0].toUpperCase() + value.slice(1).toLowerCase();
  return elements.has(normalized) ? normalized : null;
}
export const elementForHoldTap = (key: string): string | null => symbol(key);

/**
 * Framework-free keyboard state. The adapter supplies editable/IME scope and
 * dispatches returned actions; this port never reads or changes a document.
 * Held letters are bounded by the alphabet and never use a timing window.
 */
export function createModelInteraction(options: { getSelectKey?(): string } = {}): ModelInteractionPort & { suspend(): void } {
  let state: InteractionState = { element: null, box: false, alt: false, gesture: 'none' };
  const held = new Set<string>();
  let pending: string | null = null;
  let pendingHydrogen: string | null = null;
  let carbonDigits: string | null = null;
  let carbonOverflow = false;

  function clearHeld(): void {
    held.clear();
    pending = null;
    pendingHydrogen = null;
    carbonDigits = null;
    carbonOverflow = false;
    state.box = false;
  }

  function reset(reason: 'blur' | 'cancel' | 'document-change'): void {
    clearHeld();
    state = {
      element: reason === 'blur' ? state.element : null,
      box: false, alt: false, gesture: 'none',
    };
  }

  function keyDown(event: ModelKeyEvent): InteractionAction[] {
    // Focus can move to a text field without a window blur. Discard held state
    // at that boundary too, so typing never completes a canvas chord later.
    if (event.editable || event.isComposing) {
      reset('blur');
      return [];
    }
    if (event.repeat) return [];
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      reset('cancel');
      return [{ type: 'escape' }];
    }
    if (key === 'alt' || event.altKey) {
      clearHeld();
      state.alt = true;
      return [];
    }
    if (event.ctrlKey || event.metaKey || key === 'control' || key === 'meta') {
      clearHeld();
      state.alt = false;
      // New adapters provide the actual hover context after checking canvas
      // focus. Legacy ports keep their previous unknown-Ctrl behavior.
      if (key === 'a' && event.hoverKind !== undefined) return [{ type: 'select-all' }];
      const action = shortcuts[key];
      if (action === 'copy' || action === 'paste' || action === 'save' || action === 'undo' || action === 'redo') {
        return [{ type: action }];
      }
      return [];
    }
    if (key === 'delete' || key === 'backspace') return [{ type: 'delete' }];
    if (event.hoverKind !== undefined && state.gesture !== 'none' && /^\d$/.test(key)) return [];
    if (/^\d$/.test(key) && held.has('c') && pending === 'c' && carbonDigits !== null) {
      // Keep the chord bounded even if a key stream never releases C. Actual
      // explicit atom limits belong to the template/command dispatcher.
      if (carbonDigits.length < 16) carbonDigits += key;
      else carbonOverflow = true;
      return [];
    }
    if (event.hoverKind === 'none' && ['2', '3', '4'].includes(key)) {
      clearHeld();
      state.element = null;
      return [{ type: 'measurement-mode', mode: key === '2' ? 'distance' : key === '3' ? 'angle' : 'dihedral' }];
    }
    if (orders[key] !== undefined) return [{ type: 'bond-order', order: orders[key] }];
    if (!/^[a-z]$/.test(key)) return [];
    // A duplicate down without repeat=true is still the same physical hold.
    if (held.has(key)) return [];
    held.add(key);
    // Pointer-down locks the gesture immediately, before any drag threshold.
    if (state.gesture !== 'none') return [];
    const combined = pending !== null && held.has(pending) ? symbol(pending + key) : null;
    if (combined) {
      state.element = combined;
      state.box = false;
      // Both letters remain held but neither can seed another combination.
      pending = null;
      pendingHydrogen = null;
      carbonDigits = null;
      carbonOverflow = false;
      return [];
    }
    // A fresh R starts the temporary box tool unless it completed a symbol.
    if (key === (options.getSelectKey?.() ?? 'r')) {
      state.box = true;
      pending = key;
      carbonDigits = null;
      carbonOverflow = false;
      return event.hoverKind === undefined ? [] : [{ type: 'clear-measurement-pending' }];
    }
    if (state.box) return [];
    // A hovered H waits for release, so a held H can still become He/Hf/Hg/Ho.
    // Preserve the current element tool while this one-shot edit is pending.
    pendingHydrogen = key === 'h' ? event.hoverAtomId ?? null : null;
    const single = symbol(key);
    if (single && pendingHydrogen === null) state.element = single;
    // Non-element initials (A/D/E/G/L/M/T/X/Z) can still form real symbols.
    pending = key;
    carbonDigits = key === 'c' ? '' : null;
    carbonOverflow = false;
    return key === 'c' && event.hoverKind !== undefined ? [{ type: 'clear-measurement-pending' }] : [];
  }

  function keyUp(event: ModelKeyEvent): InteractionAction[] {
    const key = event.key.toLowerCase();
    const hydrogen = key === 'h' && held.has(key) && pending === key ? pendingHydrogen : null;
    const chain = key === 'c' && held.has(key) && pending === key && carbonDigits && !carbonOverflow ? Number(carbonDigits) : null;
    // Release bookkeeping is unconditional: the key may be released after
    // focus moved into an input or after modifier flags changed.
    held.delete(key);
    if (pending === key) pending = null;
    if (key === 'h') pendingHydrogen = null;
    if (key === 'c') { carbonDigits = null; carbonOverflow = false; }
    if (key === (options.getSelectKey?.() ?? 'r')) state.box = false;
    if (key === 'alt') state.alt = false;
    else if (event.altKey !== undefined) state.alt = event.altKey;
    if (event.editable || event.isComposing) { reset('blur'); return []; }
    if (chain !== null && Number.isSafeInteger(chain) && chain > 0 && !event.ctrlKey && !event.metaKey && !event.altKey && state.gesture === 'none') {
      return [{ type: 'carbon-chain', count: chain }];
    }
    if (hydrogen && event.hoverAtomId === hydrogen && !event.ctrlKey && !event.metaKey && !event.altKey && state.gesture === 'none') {
      return [{ type: 'add-hydrogen', atomId: hydrogen }];
    }
    return [];
  }

  return {
    getSnapshot: () => ({ ...state }),
    keyDown,
    keyUp,
    setElement(value) {
      const normalized = value === null ? null : symbol(value);
      if (value !== null && normalized === null) throw new RangeError(`Unknown element: ${value}`);
      reset('cancel');
      state.element = normalized;
    },
    beginGesture(gesture) {
      if (state.gesture === 'none') {
        state.gesture = gesture;
        pending = null;
        pendingHydrogen = null;
        carbonDigits = null;
        carbonOverflow = false;
      }
    },
    endGesture() {
      state.gesture = 'none';
    },
    // A runtime/editing lock ends temporary input, not the chosen tool. Keep
    // this separate from explicit Escape and document replacement semantics.
    suspend() { reset('blur'); },
    reset,
  };
}
