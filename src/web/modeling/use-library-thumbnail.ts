import { useEffect, useRef, useState } from 'react';

const visibilityObservers = new WeakMap<Document, {
  observer: IntersectionObserver;
  callbacks: WeakMap<Element, () => void>;
}>();

/** Gallery cards defer preparation until they enter a visible scroll pane. */
export function useLibraryThumbnail<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const target = ref.current;
    if (!target || visible) return;
    const document = target.ownerDocument, Observer = document.defaultView?.IntersectionObserver;
    if (!Observer) { setVisible(true); return; }
    let state = visibilityObservers.get(document);
    if (!state) {
      const callbacks = new WeakMap<Element, () => void>();
      const observer = new Observer(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          callbacks.get(entry.target)?.();
          callbacks.delete(entry.target);
          observer.unobserve(entry.target);
        }
      });
      state = { observer, callbacks };
      visibilityObservers.set(document, state);
    }
    const { observer, callbacks } = state;
    callbacks.set(target, () => setVisible(true));
    observer.observe(target);
    return () => { callbacks.delete(target); observer.unobserve(target); };
  }, [visible]);
  return { ref, visible };
}
