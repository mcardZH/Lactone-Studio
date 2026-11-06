interface DialogEntry { panel: HTMLElement; focusInside(): void }
interface DialogDocumentState { stack: DialogEntry[]; locks: number; previousOverflow: string; inert: Map<HTMLElement, { count:number; original:boolean }> }
const documents = new WeakMap<Document, DialogDocumentState>();
const focusableSelector = 'button:not(:disabled),a[href],input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

function focusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0 && !node.closest('[hidden],[inert],[aria-hidden="true"]'));
}

/** Each real document owns its modal stack and scroll lock; no ambient-window instanceof. */
export function bindDialogLifecycle(panel: HTMLElement, onCancel: () => void, options: { initialFocus?(): HTMLElement | null; lockScroll?: boolean; modal?:boolean } = {}) {
  const owner = panel.ownerDocument, previous = owner.activeElement as HTMLElement | null;
  const modal=options.modal!==false;
  const state:DialogDocumentState = documents.get(owner) ?? { stack: [], locks: 0, previousOverflow: '', inert:new Map() };
  if(modal)documents.set(owner, state);
  const entry: DialogEntry = { panel, focusInside: () => {
    const preferred = options.initialFocus?.();
    (preferred && panel.contains(preferred) ? preferred : focusable(panel)[0] ?? panel).focus();
  } };
  if(modal)state.stack.push(entry);
  // Isolate sibling branches, not the dialog's ancestor: this covers both body
  // portals and intentionally embedded dialogs without making the modal inert.
  const inertNodes:HTMLElement[]=[];
  if(modal){
    let branch:HTMLElement=panel.closest<HTMLElement>('.dialog-backdrop')??panel;
    while(branch.parentElement){
      for(const sibling of Array.from(branch.parentElement.children)){
        if(sibling===branch||typeof (sibling as HTMLElement).setAttribute!=='function')continue;
        const node=sibling as HTMLElement, prior=state.inert.get(node);
        if(prior)prior.count++;else state.inert.set(node,{count:1,original:node.hasAttribute('inert')});
        node.setAttribute('inert','');inertNodes.push(node);
      }
      if(branch.parentElement===owner.body)break;
      branch=branch.parentElement;
    }
  }
  const lock = modal&&options.lockScroll !== false;
  if (lock && state.locks++ === 0) { state.previousOverflow = owner.body.style.overflow; owner.body.style.overflow = 'hidden'; }
  let disposed = false;
  const topModal=()=>documents.get(owner)?.stack.at(-1);
  const isTop = () => !disposed && topModal() === entry;
  const focusin = (event: FocusEvent) => { if (modal&&isTop() && !panel.contains(event.target as Node | null)) entry.focusInside(); };
  if(modal)owner.addEventListener('focusin', focusin);
  // A background non-modal surface may mount asynchronously; it cannot take
  // focus or keyboard ownership from an existing unrelated modal.
  if(modal||!topModal()||topModal()!.panel.contains(panel))entry.focusInside();
  return {
    handleKeyDown(event: { key: string; shiftKey?: boolean; defaultPrevented?: boolean; preventDefault(): void; stopPropagation(): void }) {
      if(disposed)return;
      if(!modal){
        const top=topModal();
        if(event.key!=='Escape'||!panel.contains(owner.activeElement)||top&&!top.panel.contains(panel)||event.defaultPrevented)return;
        event.stopPropagation();event.preventDefault();onCancel();return;
      }
      if (!isTop()) return;
      event.stopPropagation();
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); return; }
      if (event.key !== 'Tab'||!modal) return;
      const nodes = focusable(panel), first = nodes[0], last = nodes.at(-1), active = owner.activeElement;
      if (!first) { event.preventDefault(); panel.focus(); }
      else if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || active === panel || !panel.contains(active))) { event.preventDefault(); first.focus(); }
    },
    dispose() {
      if (disposed) return;
      const top=topModal(),restore = modal?isTop():!top||top.panel.contains(panel); disposed = true;
      if(modal){owner.removeEventListener('focusin', focusin);const index = state.stack.indexOf(entry); if (index >= 0) state.stack.splice(index, 1);}
      for(const node of inertNodes){const record=state.inert.get(node);if(record&&--record.count===0){if(!record.original)node.removeAttribute('inert');state.inert.delete(node);}}
      if (lock && --state.locks === 0) owner.body.style.overflow = state.previousOverflow;
      if (restore&&!owner.defaultView?.closed) {
        const next = topModal();
        if (previous?.isConnected && typeof previous.focus === 'function' && (!next || next.panel.contains(previous))) previous.focus();
        else next?.focusInside();
      }
      if (modal&&documents.get(owner)===state&&!state.stack.length&&!state.locks)documents.delete(owner);
    },
  };
}
