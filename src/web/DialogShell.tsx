import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { bindDialogLifecycle } from './dialog-lifecycle';
import './dialog-shell.css';

export interface DialogShellProps extends Omit<HTMLAttributes<HTMLElement>, 'onCancel'> {
  children: ReactNode;
  onCancel(): void;
  initialFocus?(): HTMLElement | null;
  backdropClassName?: string;
  backdropTestId?: string;
  dismissOnBackdrop?: boolean;
  backdropDismissEvent?: 'click' | 'pointerdown';
  lockScroll?: boolean;
  portal?: boolean;
  ownerDocument?: Document;
  /** Release modal focus/scroll ownership while retaining the caller's subtree. */
  open?: boolean;
}

/** Native non-modal popovers reuse appearance without acquiring modal focus/scroll semantics. */
export function dialogSurfaceStyle():CSSProperties{return{background:'var(--ui-control-bg)',color:'var(--ui-control-ink)',borderColor:'var(--ui-control-border)',borderRadius:'var(--ui-surface-radius)',fontFamily:'"Segoe UI","Microsoft YaHei",sans-serif',fontSize:'var(--ui-control-caption-font)'};}

export function useDialogSurfaceLifecycle(panel:RefObject<HTMLElement|null>,onCancel:()=>void,enabled:boolean,modal=true){
  const latest=useRef(onCancel);latest.current=onCancel;
  const binding=useRef<ReturnType<typeof bindDialogLifecycle>|null>(null);
  useLayoutEffect(()=>{if(!enabled||!panel.current)return;const own=bindDialogLifecycle(panel.current,()=>latest.current(),{modal});binding.current=own;return()=>{own.dispose();if(binding.current===own)binding.current=null;};},[enabled,modal,panel]);
  return (event:Parameters<ReturnType<typeof bindDialogLifecycle>['handleKeyDown']>[0])=>binding.current?.handleKeyDown(event);
}

export interface DialogSurfaceProps extends Omit<HTMLAttributes<HTMLElement>,'onCancel'>{onCancel():void;children:ReactNode}
/** Inline scientific choices share presentation but retain non-modal Tab/background interaction. */
export function DialogSurface({onCancel,children,className='',style,onKeyDown,...attributes}:DialogSurfaceProps){
  const panel=useRef<HTMLElement>(null),keyDown=useDialogSurfaceLifecycle(panel,onCancel,true,false);
  return <section {...attributes} ref={panel} className={'dialog-surface '+className} role="dialog" aria-modal="false" tabIndex={-1}
    style={{...dialogSurfaceStyle(),...style}} onKeyDown={event=>{onKeyDown?.(event);keyDown(event);}}>{children}</section>;
}

/** Shared presentation and modal lifetime. Callers retain drafts and confirm/cancel semantics. */
export default function DialogShell({ children, onCancel, initialFocus, backdropClassName = '', backdropTestId, dismissOnBackdrop = false, backdropDismissEvent = 'click', lockScroll = true, portal = true, ownerDocument, open = true, className = '', style, onKeyDown, role = 'dialog', ...attributes }: DialogShellProps) {
  const anchor = useRef<HTMLSpanElement>(null), panel = useRef<HTMLElement>(null);
  const [portalDocument, setPortalDocument] = useState<Document | null>(ownerDocument ?? null);
  const current = useRef({ onCancel, initialFocus }); current.current = { onCancel, initialFocus };
  const lifecycle = useRef<ReturnType<typeof bindDialogLifecycle> | null>(null);
  useLayoutEffect(() => { if (portal) { const next=ownerDocument??anchor.current?.ownerDocument??null;setPortalDocument(previous=>previous===next?previous:next); } });
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const binding = bindDialogLifecycle(panel.current, () => current.current.onCancel(), { initialFocus: () => current.current.initialFocus?.() ?? null, lockScroll });
    lifecycle.current = binding;
    return () => { binding.dispose(); if (lifecycle.current === binding) lifecycle.current = null; };
  }, [portalDocument, portal, lockScroll, open]);
  const dialog = <div className={'dialog-backdrop ' + backdropClassName} data-testid={backdropTestId} hidden={!open} style={open?undefined:{display:'none'}} data-dialog-open={open}
    onPointerDown={event => { event.stopPropagation(); if (dismissOnBackdrop && backdropDismissEvent === 'pointerdown' && event.target === event.currentTarget) current.current.onCancel(); }}
    onClick={event => { event.stopPropagation(); if (dismissOnBackdrop && backdropDismissEvent === 'click' && event.target === event.currentTarget) current.current.onCancel(); }}>
    <section {...attributes} ref={panel} className={'dialog-shell ' + className} role={role} aria-modal="true" tabIndex={-1}
      style={{...dialogSurfaceStyle(),...style}}
      onKeyDown={event => { onKeyDown?.(event); lifecycle.current?.handleKeyDown(event); }} onKeyUp={event => event.stopPropagation()}>{children}</section>
  </div>;
  return <><span hidden ref={anchor} data-dialog-anchor="true"/>{portal && portalDocument ? createPortal(dialog, portalDocument.body) : dialog}</>;
}
