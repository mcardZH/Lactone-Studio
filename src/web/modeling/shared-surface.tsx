import { useSyncExternalStore, type ReactNode } from 'react';

/** React owns the persistent tool subtree once. Document owners publish props,
 * never a second model or runtime, and an inactive owner cannot erase it. */
export function createSharedSurface() {
  let current: ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    publish(next: ReactNode) { if (next === current) return; current = next; for (const listener of listeners) listener(); },
    getSnapshot: () => current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type SharedSurfaceChannel = ReturnType<typeof createSharedSurface>;
export function SharedSurface({ channel }: { channel: SharedSurfaceChannel }) {
  return useSyncExternalStore(channel.subscribe, channel.getSnapshot, channel.getSnapshot);
}
