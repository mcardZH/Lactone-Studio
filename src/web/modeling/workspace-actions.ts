import type { InteractionAction, ModelCommand, ModelDocument, PickResult } from '../../modeling/contracts';

/** Hover hotkeys do not silently enlarge the current object selection. */
export function hoverCommand(action: InteractionAction, hover: PickResult, document: ModelDocument, element: string | null = null): ModelCommand | null {
  if (action.type === 'delete') {
    if (hover.kind === 'atom') return document.draft.structure.atoms.some(atom => atom.id === hover.atomId)
      ? { type: 'delete-objects', selection: { atomIds: [hover.atomId], bonds: [], auxiliaryIds: [] } } : null;
    if (hover.kind === 'bond') return { type: 'delete-objects', selection: { atomIds: [], bonds: [hover], auxiliaryIds: [] } };
    if (hover.kind === 'auxiliary') return { type: 'delete-objects', selection: { atomIds: [], bonds: [], auxiliaryIds: [hover.relationId] } };
    if (hover.kind === 'port') return { type: 'delete-objects', selection: { atomIds: [], bonds: [], auxiliaryIds: [], portIds: [hover.portId] } };
    if (hover.kind === 'coordinate') return { type: 'delete-objects', selection: { atomIds: [], bonds: [], auxiliaryIds: [], coordinateIds: [hover.coordinateId] } };
    return { type: 'delete-objects' };
  }
  if (action.type === 'add-hydrogen') return hover.kind === 'atom' && action.atomId === hover.atomId && document.draft.structure.atoms.some(atom => atom.id === hover.atomId)
    ? { type: 'add-single-hydrogen', atomId: hover.atomId } : null;
  if (action.type !== 'bond-order') return null;
  if (hover.kind === 'atom' && action.order === 1 && element) {
    const atom = document.draft.structure.atoms.find(item => item.id === hover.atomId);
    return atom ? viewportCommand({ type: 'place-element', element, targetAtomId: hover.atomId, position: [atom.x, atom.y, atom.z] }) : null;
  }
  if (hover.kind === 'bond') return { type: 'set-bond-order', atomIds: hover.atomIds, order: action.order, image: hover.image };
  if (hover.kind === 'auxiliary') {
    const relation = document.auxiliaryRelations.find(item => item.id === hover.relationId);
    if (relation) return { type: 'set-bond-order', atomIds: [relation.a, relation.b], order: action.order };
  }
  return null;
}
/** Persistent mouse tools act only on the clicked object; blank is inert. */
export function persistentToolCommand(tool: 'hydrogen' | 'delete', pick: PickResult, document: ModelDocument): ModelCommand | null {
  if (pick.kind === 'none') return null;
  return tool === 'delete' ? hoverCommand({ type: 'delete' }, pick, document)
    : pick.kind === 'atom' ? hoverCommand({ type: 'add-hydrogen', atomId: pick.atomId }, pick, document) : null;
}
/** The H mouse tool is the same one-H edit as hovered H and atom 1 with H selected. */
export function viewportCommand(command: ModelCommand): ModelCommand {
  return command.type === 'place-element' && command.element === 'H' && command.targetAtomId
    ? { type: 'add-single-hydrogen', atomId: command.targetAtomId }
    : command;
}
export function editableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
}
export interface WorkspaceSpaceKey {
  key: string; code?: string; repeat?: boolean; isComposing?: boolean;
  ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean;
}
/** Modeling optimization uses stop/new-run; MD retains its own pause/resume UI. */
export function workspaceSpaceOptimizationAction(runtime:{xtbRunning:boolean;xtbPhase:string;xtbOperation?:string;dynamicsStatus:string;dynamicsMode?:string;canStart:boolean}):'stop'|'start'|'ignore'{
  if(runtime.xtbRunning)return runtime.xtbOperation==='optimize'&&runtime.xtbPhase!=='stopping'?'stop':'ignore';
  if(['starting','running','pausing','paused','stopping'].includes(runtime.dynamicsStatus))return ['optimize','geometry'].includes(runtime.dynamicsMode??'')&&runtime.dynamicsStatus!=='stopping'?'stop':'ignore';
  return runtime.canStart?'start':'ignore';
}
/** A one-press canvas shortcut, never text entry or a control's Space action.
 * Remote owners pass no local DOM targets, but still recheck the key flags. */
export function workspaceSpacePressAllowed(event: WorkspaceSpaceKey, release: boolean, target: EventTarget | null, activeElement: EventTarget | null): boolean {
  if (release || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.code !== 'Space' && event.key !== ' ') return false;
  const controls = 'input,textarea,select,button,option,optgroup,a[href],summary,label,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="textbox"],[role="combobox"],[role="listbox"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="treeitem"]';
  return ![target, activeElement].some(node => typeof Element !== 'undefined' && node instanceof Element && node.closest(controls));
}
/** A child/portal dialog owns its keys; a dialog containing this workspace
 * (the main modeler window) must still allow its own modeling shortcuts. */
export function blockingModelDialog(scope: HTMLElement | null): boolean {
  if (!scope) return false;
  return Array.from(scope.ownerDocument.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[popover]')).some(dialog =>
    !dialog.matches('.sy-settings-panel[aria-modal="false"]') &&
    !dialog.contains(scope) && !dialog.closest('[hidden],[inert],[aria-hidden="true"]') && dialog.getClientRects().length > 0
    && scope.ownerDocument.defaultView?.getComputedStyle(dialog).visibility !== 'hidden');
}
export function orderedAtomIds(text: string, document: ModelDocument): string[] {
  const tokens = text.trim().split(/[\s,，]+/).filter(Boolean);
  const ids = tokens.map(token => {
    if (!/^\d+$/.test(token)) throw new Error('按顺序输入几何原子编号。');
    const atom = document.draft.structure.atoms[Number(token) - 1];
    if (!atom) throw new Error('几何原子编号超出范围。');
    return atom.id!;
  });
  if (new Set(ids).size !== ids.length) throw new Error('几何原子编号不能重复。');
  return ids;
}
