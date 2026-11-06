import {useEffect, useSyncExternalStore} from 'react';
import {observeTrajectoryOperations} from '../../results/trajectory-operations';
import type {ViewportRenderCompletion} from '../modeling/render/render-completion';
import type {ViewportRenderIdentity} from '../modeling/render/render-completion';
import type {PreparedTrajectoryView} from '../../results/prepared-trajectory';
import {preparationDiagnostic} from './usePreparedTrajectory';

/** Opt-in, read-only diagnostics. The normal application retains no trace. */
let enabled = false;
const listeners = new Set<() => void>();
let controllers = 0;
let releaseOperations: (() => void) | undefined;
const preparations = new Map<PreparedTrajectoryView, () => void>();
const changed = () => { for (const listener of listeners) listener(); };
export function emitTrajectoryObservation(detail: unknown) {
  if (enabled && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sciyue:trajectory-observation', {detail}));
}
function setEnabled(value: boolean) {
  if (enabled === value) return;
  enabled = value;
  releaseOperations?.(); releaseOperations = undefined;
  if (!enabled) {for (const release of preparations.values()) release(); preparations.clear();}
  if (enabled) releaseOperations = observeTrajectoryOperations(event => emitTrajectoryObservation({type: 'operation', event}));
  changed();
}
const control = (event: Event) => {
  const detail = (event as CustomEvent).detail;
  if (detail && typeof detail.enabled === 'boolean') setEnabled(detail.enabled);
};
export function installTrajectoryObservationController() {
  if (controllers++ === 0) window.addEventListener('sciyue:trajectory-observation-control', control);
  let released=false;
  return () => {if(released)return;released=true;if (--controllers === 0) {window.removeEventListener('sciyue:trajectory-observation-control', control);setEnabled(false);}};
}
export function useTrajectoryObservationController() {
  useEffect(installTrajectoryObservationController, []);
}
const subscribe = (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};};
export function useTrajectoryObservationEnabled() {return useSyncExternalStore(subscribe, () => enabled, () => false);}
export function emitTrajectoryRenderCompletion(event: ViewportRenderCompletion, phase: {playing: boolean; previewing: boolean; prepared: boolean}) {
  emitTrajectoryObservation({type: 'render-completed', event, ...phase});
}
/** Subscription belongs to the observed source, so closing a React pane cannot
 * hide the source owner's final zero-allocation notification. */
export function observePreparedTrajectory(prepared: PreparedTrajectoryView, identity: ViewportRenderIdentity & {documentId: string}) {
  if (!enabled || preparations.has(prepared)) return;
  const publish = () => {
    const snapshot = preparationDiagnostic(prepared);
    emitTrajectoryObservation({type: 'preparation', identity, snapshot});
    if (snapshot?.retainedBytes === 0 && snapshot.workingBytes === 0) {preparations.get(prepared)?.(); preparations.delete(prepared);}
  };
  preparations.set(prepared, prepared.subscribe(publish));
  publish();
}
