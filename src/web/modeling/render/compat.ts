/** 3Dmol 2.5.5 binds these body listeners even with nomouse. This narrowly
 * scoped compatibility wrapper owns only listeners created synchronously by
 * its own constructor. It is not a public 3Dmol destroy API. */
export function captureViewerListeners<T>(body: HTMLElement, construct: () => T): { value: T; release: () => void } {
  const ownDescriptor = Object.getOwnPropertyDescriptor(body, 'addEventListener');
  const original = body.addEventListener;
  const owned: { type: string; callback: EventListenerOrEventListenerObject; capture: boolean }[] = [];
  let released = false;
  const release = () => { if (released) return; released = true; for (const item of owned) body.removeEventListener(item.type, item.callback, item.capture); };
  Object.defineProperty(body, 'addEventListener', { configurable: true, writable: true, value: function (type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    original.call(body, type, callback as EventListenerOrEventListenerObject, options);
    if (callback && (type === 'mouseup' || type === 'touchend')) owned.push({ type, callback, capture: typeof options === 'boolean' ? options : !!options?.capture });
  } });
  try { return { value: construct(), release }; }
  catch (error) { release(); throw error; }
  finally { if (ownDescriptor) Object.defineProperty(body, 'addEventListener', ownDescriptor); else Reflect.deleteProperty(body, 'addEventListener'); }
}
