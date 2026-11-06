/** Interaction ownership is distinct from viewport visibility. Every detached
 * window focus cycle arms one protected canvas press, even if native focus has
 * already activated the owner before renderer events. No elapsed-time guess. */
export interface ViewportInteractionOwner { active?: boolean; activationEpoch?: number }
export function createViewportActivationPointerGate(initialFocusProtection = false) {
  let focusLease: ViewportInteractionOwner | null = initialFocusProtection ? {} : null;
  let pointer: { id: number; activationOnly: boolean; released: boolean; owner: ViewportInteractionOwner } | null = null;
  return {
    focus(owner: ViewportInteractionOwner = {}) { focusLease = { ...owner }; },
    blur() { focusLease = {}; pointer = null; },
    explicitActivation() { focusLease = null; },
    begin(id: number, owner: ViewportInteractionOwner) {
      const activationOnly = focusLease !== null || owner.active !== true;
      pointer = { id, activationOnly, released: false, owner: { ...(focusLease ?? owner) } };
      focusLease = null;
      return activationOnly;
    },
    consumes(id: number) { return pointer?.id === id && !pointer.released && pointer.activationOnly; },
    end(id: number) {
      if (pointer?.id !== id) return false;
      pointer.released = true;
      // A renderer focus event may arrive after this pointerdown. It belongs
      // to this same activation-only sequence, rather than the next click.
      if (pointer.activationOnly) focusLease = null;
      return pointer.activationOnly;
    },
    cancel(id: number) {
      if (pointer?.id !== id) return false;
      const consumed = pointer.activationOnly; if (consumed) focusLease = null; pointer = null; return consumed;
    },
    lostCapture(id: number) { if (pointer?.id === id && !pointer.released) pointer = null; },
    click(id: number | undefined, detail: number) {
      const consumed = detail > 0 && Boolean(pointer?.activationOnly && pointer.released && (id === undefined || pointer.id === id));
      if (consumed) pointer = null;
      return consumed;
    },
  };
}

/** Headers, pane edges and splitters keep their presentation-only drag gesture.
 * Include stage overlays as well as the raw canvas so their first click cannot
 * clear constraints, select an object, or delete a marker. */
export function viewportActivationTarget(target: EventTarget | null): boolean {
  const element = target as { closest?(selector: string): Element | null } | null;
  return Boolean(element?.closest?.('.model-stage,.model-viewport,.shared-model-stage') &&
    !element.closest?.('.model-compact-legend,[role="separator"],.model-document-handle,.model-document-resize'));
}
