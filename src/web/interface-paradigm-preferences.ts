import { useCallback, useSyncExternalStore } from 'react';

export const INTERFACE_PARADIGMS = ['studio', 'dark-studio'] as const;
export type InterfaceParadigm = (typeof INTERFACE_PARADIGMS)[number];
export const INTERFACE_PARADIGM_KEY = 'sciyue.interface-paradigm';
export const DEFAULT_INTERFACE_PARADIGM: InterfaceParadigm = 'studio';

export const VIEWPORT_BACKDROPS = ['auto', 'white', 'dark'] as const;
export type ViewportBackdrop = (typeof VIEWPORT_BACKDROPS)[number];
export const VIEWPORT_BACKDROP_KEY = 'sciyue.viewport-backdrop';
export const DEFAULT_VIEWPORT_BACKDROP: ViewportBackdrop = 'auto';

const PARADIGM_EVENT = 'sciyue:interface-paradigm';
const BACKDROP_EVENT = 'sciyue:viewport-backdrop';

let currentParadigm: InterfaceParadigm | undefined;
let unsavedParadigm = false;
let currentBackdrop: ViewportBackdrop | undefined;
let unsavedBackdrop = false;

const validParadigm = (value: unknown): InterfaceParadigm =>
  typeof value === 'string' && (INTERFACE_PARADIGMS as readonly string[]).includes(value)
    ? (value as InterfaceParadigm)
    : DEFAULT_INTERFACE_PARADIGM;

const validBackdrop = (value: unknown): ViewportBackdrop =>
  typeof value === 'string' && (VIEWPORT_BACKDROPS as readonly string[]).includes(value)
    ? (value as ViewportBackdrop)
    : DEFAULT_VIEWPORT_BACKDROP;

function currentDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

function readStoredParadigm(): InterfaceParadigm {
  try {
    return validParadigm(window.localStorage.getItem(INTERFACE_PARADIGM_KEY));
  } catch {
    return currentParadigm ?? DEFAULT_INTERFACE_PARADIGM;
  }
}

function readStoredBackdrop(): ViewportBackdrop {
  try {
    return validBackdrop(window.localStorage.getItem(VIEWPORT_BACKDROP_KEY));
  } catch {
    return currentBackdrop ?? DEFAULT_VIEWPORT_BACKDROP;
  }
}

export function readInterfaceParadigm(): InterfaceParadigm {
  return (currentParadigm ??= typeof window === 'undefined' ? DEFAULT_INTERFACE_PARADIGM : readStoredParadigm());
}

export function readViewportBackdrop(): ViewportBackdrop {
  return (currentBackdrop ??= typeof window === 'undefined' ? DEFAULT_VIEWPORT_BACKDROP : readStoredBackdrop());
}

function syncParadigmDocument(target = currentDocument()) {
  if (!target) return;
  target.documentElement.dataset.interfaceParadigm = readInterfaceParadigm();
  target.documentElement.dataset.viewportBackdrop = readViewportBackdrop();
}

export function setInterfaceParadigm(value: InterfaceParadigm): void {
  currentParadigm = validParadigm(value);
  try {
    window.localStorage.setItem(INTERFACE_PARADIGM_KEY, currentParadigm);
    unsavedParadigm = false;
  } catch {
    unsavedParadigm = true;
  }
  syncParadigmDocument();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PARADIGM_EVENT));
}

export function setViewportBackdrop(value: ViewportBackdrop): void {
  currentBackdrop = validBackdrop(value);
  try {
    window.localStorage.setItem(VIEWPORT_BACKDROP_KEY, currentBackdrop);
    unsavedBackdrop = false;
  } catch {
    unsavedBackdrop = true;
  }
  syncParadigmDocument();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BACKDROP_EVENT));
}

export function subscribeInterfaceParadigm(listener: () => void, target = currentDocument()): () => void {
  if (typeof window === 'undefined') return () => {};
  const changed = () => {
    syncParadigmDocument(target);
    listener();
  };
  const stored = (event: StorageEvent) => {
    if (event.key !== INTERFACE_PARADIGM_KEY && event.key !== null) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    unsavedParadigm = false;
    currentParadigm = readStoredParadigm();
    changed();
  };
  window.addEventListener(PARADIGM_EVENT, changed);
  window.addEventListener('storage', stored);
  if (!unsavedParadigm) currentParadigm = readStoredParadigm();
  syncParadigmDocument(target);
  return () => {
    window.removeEventListener(PARADIGM_EVENT, changed);
    window.removeEventListener('storage', stored);
  };
}

export function subscribeViewportBackdrop(listener: () => void, target = currentDocument()): () => void {
  if (typeof window === 'undefined') return () => {};
  const changed = () => {
    syncParadigmDocument(target);
    listener();
  };
  const stored = (event: StorageEvent) => {
    if (event.key !== VIEWPORT_BACKDROP_KEY && event.key !== null) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    unsavedBackdrop = false;
    currentBackdrop = readStoredBackdrop();
    changed();
  };
  window.addEventListener(BACKDROP_EVENT, changed);
  window.addEventListener('storage', stored);
  if (!unsavedBackdrop) currentBackdrop = readStoredBackdrop();
  syncParadigmDocument(target);
  return () => {
    window.removeEventListener(BACKDROP_EVENT, changed);
    window.removeEventListener('storage', stored);
  };
}

export function bindInterfaceParadigmDocument(target: Document): () => void {
  const unsubParadigm = subscribeInterfaceParadigm(() => {}, target);
  const unsubBackdrop = subscribeViewportBackdrop(() => {}, target);
  const realm = target.defaultView;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubParadigm();
    unsubBackdrop();
    realm?.removeEventListener('beforeunload', dispose);
    realm?.removeEventListener('pagehide', dispose);
  };
  realm?.addEventListener('beforeunload', dispose);
  realm?.addEventListener('pagehide', dispose);
  return dispose;
}

export function useInterfaceParadigm(target?: Document): [InterfaceParadigm, (value: InterfaceParadigm) => void] {
  const subscribe = useCallback((listener: () => void) => subscribeInterfaceParadigm(listener, target), [target]);
  return [useSyncExternalStore(subscribe, readInterfaceParadigm, () => DEFAULT_INTERFACE_PARADIGM), setInterfaceParadigm];
}

export function useViewportBackdrop(target?: Document): [ViewportBackdrop, (value: ViewportBackdrop) => void] {
  const subscribe = useCallback((listener: () => void) => subscribeViewportBackdrop(listener, target), [target]);
  return [useSyncExternalStore(subscribe, readViewportBackdrop, () => DEFAULT_VIEWPORT_BACKDROP), setViewportBackdrop];
}
