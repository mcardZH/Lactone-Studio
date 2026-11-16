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

/** Left tools carry their presentation owner, independently of the retained
 * per-document drafts. A late cleanup can only withdraw its own publication. */
export interface SharedSurfaceOwner { documentId: string; module: string; route: string }
export const sharedSurfaceOwnerKey = (owner: SharedSurfaceOwner) => JSON.stringify([owner.documentId, owner.module, owner.route]);
export function createOwnedSharedSurface() {
  let current: { ownerKey: string; content: ReactNode } | null = null;
  const listeners = new Set<() => void>();
  return {
    publish(owner: SharedSurfaceOwner, content: ReactNode) {
      const ownerKey=sharedSurfaceOwnerKey(owner);
      if(content===null||content===undefined){if(current?.ownerKey!==ownerKey)return;current=null;}
      else {if(current?.ownerKey===ownerKey&&current.content===content)return;current={ownerKey,content};}
      for(const listener of listeners)listener();
    },
    getSnapshot:()=>current,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  };
}
export function OwnedSharedSurface({channel,owner}:{channel:ReturnType<typeof createOwnedSharedSurface>;owner:SharedSurfaceOwner|null}) {
  const snapshot=useSyncExternalStore(channel.subscribe,channel.getSnapshot,channel.getSnapshot);
  return owner&&snapshot?.ownerKey===sharedSurfaceOwnerKey(owner)?snapshot.content:null;
}
