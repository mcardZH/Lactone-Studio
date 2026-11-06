import { useMemo } from 'react';
import type { Structure } from '../../core/types';
import { createChemistryPort } from '../../modeling/chemistry';
import type { TrajectoryResult } from '../../results/contracts';
import { EmpiricalFrameBonds, empiricalFrameBondDisplayWarnings } from '../../results/empirical-frame-bonds';
import { PreparationBudgetError, preparedTrajectoryView, type PreparedTrajectorySource, type PreparedTrajectoryView } from '../../results/prepared-trajectory';

export type PreparedTrajectoryAdmission =
  | { prepared: PreparedTrajectoryView; error: null }
  | { prepared: null; error: PreparationBudgetError };
export type TrajectoryGeometryPreparation = 'empirical' | 'preserve-source-graph';

// Weak facts only: no duplicate geometry, native result or source lifetime is retained here.
const empiricalAccepted = new WeakSet<Structure>();
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
        const incomplete = new WeakSet<Structure>();
        return {
          reuseContract:geometryContracts[mode],
          onInherited:(frame,previous)=>{if(empiricalAccepted.has(previous.raw))empiricalAccepted.add(frame.raw);incomplete.delete(frame.raw);},
          canReuse: (frame) => !incomplete.has(frame.raw),
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
            // Capability absence is a usable atoms-only display, not a broken
            // scientific frame. Keep its warning and empirical proof false;
            // actual native failures/invalid replies still cannot become warm.
            if (value.status !== 'inferred' && value.status !== 'unavailable') throw new Error(value.warnings.join('\n') || '当前帧经验连接未准备完成。');
            if(value.status==='inferred'){empiricalAccepted.add(raw);incomplete.delete(raw);}
            else incomplete.add(raw);
            return value.structure;
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
  const view = prepareTrajectoryView(result);
  try {
    const frame = await view.ensure(index, signal);
    return { ...structuredClone(frame.structure), bonds: structuredClone(frame.structure.bonds ?? []) };
  } finally { view.release(); }
}

/** The error branch must not mount a legacy player. retryKey changes only on an explicit retry. */
export function usePreparedTrajectory(result: TrajectoryResult, retryKey: number | string = 0, mode: TrajectoryGeometryPreparation = 'empirical'): PreparedTrajectoryAdmission {
  return useMemo(() => {
    try {
      return { prepared: prepareTrajectoryView(result, mode), error: null };
    } catch (error) {
      if (error instanceof PreparationBudgetError) return { prepared: null, error };
      throw error;
    }
  }, [result, retryKey, mode]);
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
    return frame ? [{ localFrameIndex, sourceFrameIndex, rawSettled: true, empiricalSettled: empiricalAccepted.has(frame.raw), validationSettled: true }] : [];
  });
  const readyIndices = frames.map(frame => frame.localFrameIndex), allReady = prepared.indices.length > 0 && readyIndices.length === prepared.indices.length;
  return {
    ...snapshot, cacheOwnerId, sourceId: prepared.owner.source.source.id, resultId: prepared.owner.source.id, jobIndex: prepared.owner.source.jobIndex,
    readyIndices, readySourceIndices: frames.map(frame => frame.sourceFrameIndex), settledFrames: frames,
    rawSettled: allReady, empiricalSettled: allReady && frames.every(frame => frame.empiricalSettled), validationSettled: allReady,
  };
}
