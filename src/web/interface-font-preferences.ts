import { useSyncExternalStore } from 'react';
import type { FontSize } from './FontSizeControl';

export const INTERFACE_FONT_SIZE_KEY = 'sciyue.interface-font-size';
const CHANGE_EVENT = 'sciyue:interface-font-size';
let current: FontSize | undefined;

function validSize(value: unknown): FontSize {
  return value === 'large' || value === 'larger' ? value : 'standard';
}

function readStoredSize(): FontSize {
  try { return validSize(window.localStorage.getItem(INTERFACE_FONT_SIZE_KEY)); }
  catch { return current ?? 'standard'; }
}

export function readInterfaceFontSize(): FontSize {
  return current ??= typeof window === 'undefined' ? 'standard' : readStoredSize();
}

function currentDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

function syncDocument(target = currentDocument()) {
  if (target) target.documentElement.dataset.fontSize = readInterfaceFontSize();
}

export function setInterfaceFontSize(value: FontSize): void {
  current = validSize(value);
  try { window.localStorage.setItem(INTERFACE_FONT_SIZE_KEY, current); } catch { /* Keep the current session usable without storage. */ }
  syncDocument();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeInterfaceFontSize(listener: () => void, target = currentDocument()): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const changed = () => { syncDocument(target); listener(); };
  const stored = (event: StorageEvent) => {
    if (event.key !== INTERFACE_FONT_SIZE_KEY && event.key !== null) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    current = readStoredSize();
    changed();
  };
  window.addEventListener(CHANGE_EVENT, changed);
  window.addEventListener('storage', stored);
  // Every mounted App/Settings consumer uses the latest shared value, never its
  // own initial default. Unmounting a document must not restore an old size.
  current = readStoredSize();
  syncDocument(target);
  return () => {
    window.removeEventListener(CHANGE_EVENT, changed);
    window.removeEventListener('storage', stored);
  };
}

/** A visual subscriber only; the preference remains owned by the existing store.
 * Portalled analysis documents use the opener's store, model windows their own. */
export function bindInterfaceFontDocument(target: Document): () => void {
  const unsubscribe = subscribeInterfaceFontSize(() => undefined, target);
  const realm = target.defaultView;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    realm?.removeEventListener('beforeunload', dispose);
    realm?.removeEventListener('pagehide', dispose);
  };
  realm?.addEventListener('beforeunload', dispose);
  realm?.addEventListener('pagehide', dispose);
  return dispose;
}

export function useInterfaceFontSize(): [FontSize, (value: FontSize) => void] {
  return [useSyncExternalStore(subscribeInterfaceFontSize, readInterfaceFontSize, () => 'standard'), setInterfaceFontSize];
}
