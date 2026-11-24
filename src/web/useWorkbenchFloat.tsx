import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Grip, PanelRight, X } from 'lucide-react';
import type { AnalysisWindowLease } from '../modeling/contracts';
import { bootstrapWindowVisuals } from './window-visual-bootstrap';
import './workbench-float.css';

type Point = { x: number; y: number };
type Bounds = Point & { width: number; height: number };
type Configuration = {
  kind: 'agent-tools' | 'model-tools';
  title: string;
  canDock?(point: Point): boolean;
  onDock?(point?: Point): void;
};
type Popup = { child: Window; lease: AnalysisWindowLease; dispose(): void };
type Drag = {
  popup: Popup;
  pointerId: number;
  start: Point;
  origin: Point;
  ownerBounds: Promise<Bounds | undefined>;
  next: Point;
  frame: number | undefined;
  moved: boolean;
};

function supplementStyles(source: Document, target: Document) {
  // Terminal CSS can arrive when selecting its lazy tab in a floating window.
  const styleObserver = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element && node.matches('link[rel="stylesheet"],style')) {
        target.head.appendChild(target.importNode(node, true));
      }
    }
  });
  styleObserver.observe(source.head, { childList: true });
  return () => styleObserver.disconnect();
}

export function useWorkbenchFloat(configuration: Configuration) {
  const options = useRef(configuration);
  options.current = configuration;
  const bridge = typeof window === 'undefined' ? undefined : window.sciyueDesktop;
  const available = !!(bridge?.prepareAnalysisWindow && bridge.releaseAnalysisWindow && bridge.moveWorkbenchFloat && bridge.onAnalysisWindowEvent);
  const [host] = useState(() => {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    const element = document.createElement('div');
    element.className = 'es-workbench-float-content';
    return element;
  });
  const [titlebar, setTitlebar] = useState<HTMLElement | null>(null);
  const [error, setError] = useState('');
  const [dragPoint, setDragPoint] = useState<Point>();
  const slot = useRef<HTMLDivElement | null>(null);
  const popup = useRef<Popup | null>(null);
  const attached = useRef(false);
  const pending = useRef(false);
  const drag = useRef<Drag | null>(null);

  const slotRef = useCallback((element: HTMLDivElement | null) => {
    slot.current = element;
    if (element && host && !popup.current) element.appendChild(host);
  }, [host]);

  const cancelDrag = useCallback(() => {
    const current = drag.current;
    if (current?.frame !== undefined && !current.popup.child.closed) current.popup.child.cancelAnimationFrame(current.frame);
    drag.current = null;
  }, []);

  const release = useCallback(() => {
    const current = popup.current;
    if (!current) return false;
    popup.current = null;
    cancelDrag();
    // Move the stable portal container first. A new React target would remount
    // its tabs and release the running terminal and assistant subscriptions.
    if (host && slot.current) slot.current.appendChild(host);
    else if (host) document.adoptNode(host);
    current.dispose();
    void bridge?.releaseAnalysisWindow?.({ leaseId: current.lease.leaseId }).catch(() => {
      if (!current.child.closed) current.child.close();
    });
    return true;
  }, [bridge, cancelDrag, host]);

  const dock = useCallback((point?: Point) => {
    if (!release() || !attached.current) return;
    setTitlebar(null);
    setDragPoint(undefined);
    options.current.onDock?.(point);
  }, [release]);

  useLayoutEffect(() => {
    attached.current = true;
    const unsubscribe = bridge?.onAnalysisWindowEvent?.(event => {
      if (event.leaseId !== popup.current?.lease.leaseId) return;
      if (event.kind === 'closed' || event.kind === 'dock-requested') dock();
    });
    return () => {
      attached.current = false;
      unsubscribe?.();
      release();
    };
  }, [bridge, dock, release]);

  async function detach(point?: Point) {
    if (!available || !host || pending.current || popup.current || !attached.current) return;
    pending.current = true;
    setError('');
    let lease: AnalysisWindowLease | undefined;
    let disposeVisuals: (() => void) | undefined;
    try {
      const { kind, title } = options.current;
      const width = kind === 'agent-tools' ? 700 : 440;
      const height = kind === 'agent-tools' ? 560 : 670;
      const x = Math.round(point ? point.x - 106 : window.screenX + (window.outerWidth - width) / 2);
      const y = Math.round(point ? point.y - 18 : window.screenY + (window.outerHeight - height) / 2);
      lease = await bridge!.prepareAnalysisWindow!({ instanceId: `workbench-${kind}`, title: `${title} · Ester Studio`, bounds: { x, y } });
      if (!attached.current) {
        await bridge!.releaseAnalysisWindow!({ leaseId: lease.leaseId });
        return;
      }
      const child = window.open('about:blank', lease.target, '');
      if (!child) throw new Error('无法打开独立窗口。');
      const source = slot.current?.ownerDocument ?? document;
      child.document.title = `${title} · Ester Studio`;
      disposeVisuals = bootstrapWindowVisuals(source, child.document);
      const stopStyles = supplementStyles(source, child.document);
      child.document.body.classList.add('es-workbench-float-window');
      child.document.body.dataset.workbenchFloat = kind;
      const header = child.document.createElement('header');
      header.className = 'es-workbench-float-header';
      const beforeUnload = () => { if (popup.current?.child === child) dock(); };
      const dispose = () => {
        if (!child.closed) child.removeEventListener('beforeunload', beforeUnload);
        stopStyles();
        disposeVisuals?.();
      };
      popup.current = { child, lease, dispose };
      child.addEventListener('beforeunload', beforeUnload);
      child.document.body.append(header, host);
      setTitlebar(header);
      child.focus();
    } catch (cause) {
      if (!release()) {
        disposeVisuals?.();
        if (lease) void bridge!.releaseAnalysisWindow!({ leaseId: lease.leaseId }).catch(() => {});
      }
      if (attached.current) {
        setTitlebar(null);
        setError(cause instanceof Error ? cause.message : '无法打开独立窗口。');
      }
    } finally {
      pending.current = false;
    }
  }

  const screenPoint = (event: PointerEvent<HTMLElement>): Point => ({ x: event.screenX, y: event.screenY });

  function beginDrag(event: PointerEvent<HTMLElement>) {
    const current = popup.current;
    if (event.button !== 0 || !current || !bridge?.moveWorkbenchFloat) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = screenPoint(event);
    drag.current = {
      popup: current, pointerId: event.pointerId, start, next: start, frame: undefined, moved: false,
      origin: { x: current.child.screenX, y: current.child.screenY },
      ownerBounds: bridge.workspaceWindowGeometry?.().catch(() => undefined) ?? Promise.resolve(undefined),
    };
  }

  async function dockPoint(current: Drag, point: Point) {
    const bounds = await current.ownerBounds;
    if (!bounds) return;
    const client = { x: point.x - bounds.x, y: point.y - bounds.y };
    if (client.x < 0 || client.y < 0 || client.x > bounds.width || client.y > bounds.height) return;
    const eligible = options.current.canDock?.(client) ?? (client.x >= bounds.width - 72);
    return eligible ? client : undefined;
  }

  function updateDrag(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.next = screenPoint(event);
    if (!current.moved && Math.hypot(current.next.x - current.start.x, current.next.y - current.start.y) < 5) return;
    current.moved = true;
    if (current.frame !== undefined) return;
    current.frame = current.popup.child.requestAnimationFrame(() => {
      current.frame = undefined;
      const point = current.next;
      moveWindow(current, point);
      void dockPoint(current, point).then(candidate => { if (drag.current === current) setDragPoint(candidate); });
    });
  }

  function moveWindow(current: Drag, point: Point) {
    const x = Math.round(current.origin.x + point.x - current.start.x);
    const y = Math.round(current.origin.y + point.y - current.start.y);
    void bridge?.moveWorkbenchFloat?.({ leaseId: current.popup.lease.leaseId, x, y }).catch(() => {});
  }

  function finishDrag(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    cancelDrag();
    setDragPoint(undefined);
    if (current.moved && event.type === 'pointerup') {
      const point = screenPoint(event);
      void dockPoint(current, point).then(candidate => {
        if (popup.current !== current.popup || drag.current) return;
        if (candidate) dock(candidate);
        else moveWindow(current, point);
      });
    }
  }

  const gripProps = { onPointerDown: beginDrag, onPointerMove: updateDrag, onPointerUp: finishDrag, onPointerCancel: finishDrag, onLostPointerCapture: finishDrag };
  const focus = () => popup.current?.child.focus();
  function render(content: ReactNode) {
    if (!host) return content;
    return <>
      {createPortal(content, host)}
      {titlebar && createPortal(<>
        <div className="es-workbench-float-grip" data-testid={`${configuration.kind}-float-grip`} {...gripProps}>
          <Grip size={15} aria-hidden="true" /><strong>{configuration.title}</strong>
        </div>
        <button type="button" onClick={() => dock()}><PanelRight size={15} aria-hidden="true" />贴回</button>
        <button type="button" aria-label="关闭并贴回" title="关闭并贴回" onClick={() => dock()}><X size={16} aria-hidden="true" /></button>
      </>, titlebar)}
    </>;
  }

  return { available, floating: titlebar !== null, slotRef, render, detach, dock, focus, dragPoint, error };
}
