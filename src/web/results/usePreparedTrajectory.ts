import { useEffect,useMemo } from 'react';
import type { Structure } from '../../core/types';
import { createChemistryPort } from '../../modeling/chemistry';
import type { TrajectoryResult } from '../../results/contracts';
import { EmpiricalFrameBonds, empiricalFrameBondDisplayWarnings, empiricalFrameBondDisplayStructure } from '../../results/empirical-frame-bonds';
import { PreparationBudgetError, existingPreparedTrajectoryView, preparedTrajectoryView, type PreparedTrajectorySource, type PreparedTrajectoryView } from '../../results/prepared-trajectory';

export type PreparedTrajectoryAdmission =
  | { prepared: PreparedTrajectoryView; error: null }
  | { prepared: null; error: PreparationBudgetError };
export type TrajectoryGeometryPreparation = 'empirical' | 'preserve-source-graph';

// Weak facts only: no duplicate geometry, native result or source lifetime is retained here.
const empiricalAccepted = new WeakSet<Structure>();
export interface EmpiricalFramePreparationState {status:'inferred'|'unavailable'|'failed';warnings:readonly string[]}
const empiricalStates=new WeakMap<Structure,EmpiricalFramePreparationState>();
export function empiricalFramePreparationState(prepared:PreparedTrajectoryView|null,index:number):EmpiricalFramePreparationState|null {
  const sourceIndex=prepared?.indices[index],frame=sourceIndex===undefined?undefined:prepared?.owner.get(sourceIndex);
  return frame?empiricalStates.get(frame.raw)??null:null;
}
const ownerIds = new WeakMap<PreparedTrajectorySource, string>();
const ownerModes = new WeakMap<PreparedTrajectorySource, TrajectoryGeometryPreparation>();
let ownerSerial = 0;
const geometryContracts={empirical:Object.freeze({mode:'empirical',policy:'composite-v1'}),'preserve-source-graph':Object.freeze({mode:'preserve-source-graph'})};

/** One preparation owner for import, model handoff and every result view. */
export function prepareTrajectoryView(result: TrajectoryResult, mode: TrajectoryGeometryPreparation = 'empirical'): PreparedTrajectoryView {
      const prepared = preparedTrajectoryView(result, (source, warn) => {
        // Read the current bridge on each operation: the owner can outlive initial
        // desktop capability discovery without becoming a permanent WASM fallback.
        const empirical = new EmpiricalFrameBonds({ port: {
          capabilities: () => createChemistryPort().capabilities(),
          start: request => createChemistryPort().start(request),
        }, sourceId: source.id, retainCache: false,
          operationContext: { sourceId: source.source.id, resultId: source.id, jobIndex: source.jobIndex } });
        return {
          reuseContract:geometryContracts[mode],
          onInherited:(frame,previous)=>{if(empiricalAccepted.has(previous.raw))empiricalAccepted.add(frame.raw);const state=empiricalStates.get(previous.raw);if(state)empiricalStates.set(frame.raw,state);},
          prepareFrame: async (raw: Structure, sourceFrameIndex: number, signal: AbortSignal) => {
            // An uncomputed captured-model preview owns an actual graph, not
            // an empirical result. Keep it without fabricating native proof.
            if (mode === 'preserve-source-graph' && raw.bonds !== undefined) {
              if (signal.aborted) throw new DOMException('帧预备已取消。', 'AbortError');
              return structuredClone(raw);
            }
            const value = await empirical.resolve(raw, sourceFrameIndex, { signal });
            if (value.status === 'cancelled' || value.status === 'stale') throw new DOMException('帧预备已取消。', 'AbortError');
            for (const warning of empiricalFrameBondDisplayWarnings(value)) warn(warning);
            // D01: a failed optional drawing operation does not discard valid
            // scientific geometry. Retain failure warnings and false empirical
            // proof, using only this exact frame's validated source graph.
            if(value.status==='inferred')empiricalAccepted.add(raw);else empiricalAccepted.delete(raw);
            empiricalStates.set(raw,{status:value.status,warnings:empiricalFrameBondDisplayWarnings(value)});
            return empiricalFrameBondDisplayStructure(value);
          },
          dispose: () => empirical.dispose(),
        };
      });
      // Stages share their original source owner. A mode is immutable for that
      // lifetime; never silently expose a projection made by another mode.
      const existingMode = ownerModes.get(prepared.owner);
      if (existingMode !== undefined && existingMode !== mode) throw new Error('同一来源的几何预备模式不能在缓存生命周期中切换。');
      ownerModes.set(prepared.owner, mode);
      return prepared;
}

/** Return an editable copy of the same prepared frame used by result display.
 * An unavailable backend must not revive the builder's legacy inference. */
export async function readPreparedTrajectoryFrame(result: TrajectoryResult, index: number, signal?: AbortSignal): Promise<Structure> {
  const view = existingPreparedTrajectoryView(result) ?? prepareTrajectoryView(result);
  try {
    const frame = await view.ensure(index, signal);
    return { ...structuredClone(frame.structure), bonds: structuredClone(frame.structure.bonds ?? []) };
  } finally { view.release(); }
}

/** The error branch must not mount a legacy player. retryKey changes only on an explicit retry. */
export function usePreparedTrajectory(result: TrajectoryResult, retryKey: number | string = 0, mode: TrajectoryGeometryPreparation = 'empirical'): PreparedTrajectoryAdmission {
  const admission:PreparedTrajectoryAdmission=useMemo(() => {
    try {
      return { prepared: prepareTrajectoryView(result, mode), error: null };
    } catch (error) {
      if (error instanceof PreparationBudgetError) return { prepared: null, error };
      throw error;
    }
  }, [result, retryKey, mode]);
  const prepared=admission.prepared;
  useEffect(()=>{prepared?.reacquire();return()=>prepared?.release();},[prepared]);
  return admission;
}

/** A read-only capture on explicit diagnostics/preparation updates, not a per-render measurement hook.
 * The source publishes an entry only after raw validation, display preparation and final validation.
 * Empirical completion additionally requires the actual inferred result for that exact raw object. */
export function preparationDiagnostic(prepared: PreparedTrajectoryView | null) {
  if (!prepared) return null;
  let cacheOwnerId = ownerIds.get(prepared.owner);
  if (!cacheOwnerId) { cacheOwnerId = `prepared-owner:${++ownerSerial}`; ownerIds.set(prepared.owner, cacheOwnerId); }
  const snapshot = prepared.snapshot();
  const frames = prepared.indices.flatMap((sourceFrameIndex, localFrameIndex) => {
    const frame = prepared.get(localFrameIndex);
    const ownerFrame=prepared.owner.get(sourceFrameIndex);
    return frame ? [{ localFrameIndex, sourceFrameIndex, rawSettled: true, empiricalSettled: Boolean(ownerFrame&&empiricalAccepted.has(ownerFrame.raw)), validationSettled: true }] : [];
  });
  const readyIndices = frames.map(frame => frame.localFrameIndex), allReady = prepared.indices.length > 0 && readyIndices.length === prepared.indices.length;
  return {
    ...snapshot, cacheOwnerId, sourceId: prepared.owner.source.source.id, resultId: prepared.owner.source.id, jobIndex: prepared.owner.source.jobIndex,
    readyIndices, readySourceIndices: frames.map(frame => frame.sourceFrameIndex), settledFrames: frames,
    rawSettled: allReady, empiricalSettled: allReady && frames.every(frame => frame.empiricalSettled), validationSettled: allReady,
  };
}
