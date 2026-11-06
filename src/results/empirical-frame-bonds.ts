import { validateBondPerceptionIssues, validateBondSemantics } from '../core/bond-semantics';
import { coordinatesFingerprint, graphFingerprint } from '../core/modeling/graph';
import type { Bond, Structure } from '../core/types';
import { perceivePeriodicConnections } from '../core/periodic';
import { empiricalBondAdmission } from '../modeling/empirical-bond-admission';
import type { ChemistryJob, ChemistryPort, ChemistryRequest, ChemistryResult, DocumentStamp } from '../modeling/contracts';
import { traceTrajectoryOperation, type TrajectoryOperationContext } from './trajectory-operations';

export interface EmpiricalFrameBondOptions {
  port: ChemistryPort;
  /** One source/document lifetime; never share a provider between sources. */
  sourceId: string;
  sourceRevision?: string | number;
  /** PreparedTrajectory owns complete projections and accounts their memory itself. */
  retainCache?: boolean;
  operationContext?: TrajectoryOperationContext;
}
export interface EmpiricalFrameBondReadOptions {
  signal?: AbortSignal;
  /** Caller checks its document/activation epoch; this module never owns a store. */
  guard?(): void;
}
export interface EmpiricalFrameBondProjection {
  status: 'inferred' | 'unavailable' | 'failed' | 'cancelled' | 'stale';
  structure: Structure;
  warnings: string[];
  /** Candidate axes are usable for labelled drawing only, not scientific execution. */
  preview?: boolean;
  /** The source graph is evidence, separate from the default empirical drawing. */
  sourceBonds?: { bonds: Bond[]; bondSource?: Structure['bondSource']; bondPerceptionIssues?:Structure['bondPerceptionIssues'] };
}

const NATIVE_SUCCESS_ADVISORIES = new Set([
  'These are candidate bonds; domain merge must apply protected edges and deleted-bond exclusions.',
  'Distance/RDKit bond candidates were locally reconciled; source atoms, coordinates, formal charges, total charge and multiplicity were retained. Weak or unresolved reaction contacts are annotated separately from ordinary covalent bonds; no force-field validity or transition-state preservation is implied.',
]);
/** Display feedback only. Preserve the native warning array and cached evidence. */
export function empiricalFrameBondDisplayWarnings(projection: Pick<EmpiricalFrameBondProjection, 'status' | 'warnings'>): string[] {
  return projection.warnings.filter(warning => projection.status !== 'inferred' || !NATIVE_SUCCESS_ADVISORIES.has(warning));
}

const STAMP_KEYS = ['documentId', 'revision', 'graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'] as const;
const SUMMARY_COUNTS = ['bondCount', 'coordinationCount', 'evidenceCount', 'conflictCount', 'rdkitComponentCount', 'fallbackComponentCount'] as const;

function frameKey(source: Structure, index: number): string {
  return JSON.stringify([index, source.id, source.revision ?? null, source.atoms, source.cell ?? null, source.periodicSource ?? null,
    source.charge, source.multiplicity, source.bonds ?? null, source.bondSource ?? null]);
}
function atomOnly(source: Structure): Structure {
  const structure = structuredClone(source);
  delete structure.bonds; delete structure.bondSource; delete structure.bondPerceptionIssues; delete structure.molfile;
  return structure;
}
/** Select a reliable retained source graph without changing inference status.
 * Bad/unknown source evidence remains separate; it is never replaced by guessed bonds. */
export function empiricalFrameBondDisplayStructure(value: EmpiricalFrameBondProjection): Structure {
  if (value.status === 'inferred' || value.status === 'cancelled' || value.status === 'stale') return value.structure;
  // Missing graphs trigger the builder's raw-coordinate inference. A failed or
  // unavailable operation must instead carry an explicit display-only empty
  // graph; its original status/warnings/source evidence remain untouched.
  const empty = (): Structure => ({ ...value.structure, bonds: [] });
  if (!value.sourceBonds) return empty();
  const structure = { ...value.structure, bonds: value.sourceBonds.bonds, bondSource: value.sourceBonds.bondSource,
    ...(value.sourceBonds.bondPerceptionIssues?{bondPerceptionIssues:value.sourceBonds.bondPerceptionIssues}:{}) };
  try {
    for (const bond of structure.bonds) {
      if (!Number.isSafeInteger(bond.a) || !Number.isSafeInteger(bond.b) || !structure.atoms[bond.a] || !structure.atoms[bond.b]
        || bond.a === bond.b && !bond.image?.some(Boolean)
        || bond.image !== undefined && (!Array.isArray(bond.image) || bond.image.length !== 3 || bond.image.some((n, axis) => !Number.isSafeInteger(n) || n !== 0 && !structure.cell?.pbc[axis]))) return empty();
      validateBondSemantics(bond, structure);
    }
    validateBondPerceptionIssues(structure);
    return structure;
  } catch { return empty(); }
}
function accepted(source: Structure, result: ChemistryResult, request: ChemistryRequest): Structure {
  const candidate = result.structure, summary = result.bondPerceptionSummary;
  if (result.operation !== 'perceive-bonds' || result.bondPerceptionPolicy !== 'composite-v1'
      || !result.stamp || STAMP_KEYS.some(key => result.stamp[key] !== request.stamp[key])
      || JSON.stringify(result.movableAtomIds) !== JSON.stringify(request.movableAtomIds)
      || !summary || summary.method !== 'empirical' || summary.evidenceCount !== 0
      || SUMMARY_COUNTS.some(key => !Number.isSafeInteger(summary[key]) || summary[key] < 0))
    throw new Error('经验判断回执的方法、身份或来源不匹配。');
  if (!candidate || candidate.id !== source.id || candidate.charge !== source.charge || candidate.multiplicity !== source.multiplicity
      || JSON.stringify(candidate.atoms) !== JSON.stringify(source.atoms)
      || JSON.stringify(candidate.cell ?? null) !== JSON.stringify(source.cell ?? null)
      || !Array.isArray(candidate.bonds) || summary.bondCount !== candidate.bonds.length
      || summary.coordinationCount !== candidate.bonds.filter(bond => bond.kind === 'coordination').length)
    throw new Error('经验判断改变了来源原子、几何、电子态或连接回执。');
  const seen = new Set<string>();
  const bonds = candidate.bonds.map(bond => {
    if (!Number.isSafeInteger(bond.a) || !Number.isSafeInteger(bond.b) || bond.a < 0 || bond.b < 0
        || bond.a >= source.atoms.length || bond.b >= source.atoms.length || bond.a === bond.b
        || ![1, 1.5, 2, 3].includes(bond.order) || bond.fractional === true
        || bond.kind !== undefined && !['covalent', 'coordination'].includes(bond.kind)
        || bond.mbo !== undefined || bond.perception !== undefined || bond.image?.some(Boolean)
        || Boolean(bond.aromatic) !== (bond.order === 1.5))
      throw new Error('纯经验判断返回了无效连接或量化键级证据。');
    validateBondSemantics(bond,source);
    const key = `${Math.min(bond.a, bond.b)}:${Math.max(bond.a, bond.b)}`;
    if (seen.has(key)) throw new Error('经验判断重复连接同一原子对。');
    seen.add(key);
    return structuredClone(bond);
  });
  validateBondPerceptionIssues({ ...source, bonds, bondPerceptionIssues: candidate.bondPerceptionIssues });
  const structure = atomOnly(source);
  structure.bonds = bonds; structure.bondSource = 'inferred';
  if (candidate.bondPerceptionIssues?.length) structure.bondPerceptionIssues = structuredClone(candidate.bondPerceptionIssues);
  return structure;
}

/** Finite sources use the modeler's composite-v1 empirical operation;
 * periodic sources use the common local image-resolved connectivity rules.
 * Only display projections are returned: no store, selection, Undo or QM calls.
 * Native jobs are serialized per provider; completed exact frames use an LRU of 8.
 */
export class EmpiricalFrameBonds {
  private cache = new Map<string, EmpiricalFrameBondProjection>();
  private tail: Promise<void> = Promise.resolve();
  private lifetime = new AbortController();
  private closed = false;
  private capabilityWarmupUsed = false;
  constructor(private options: EmpiricalFrameBondOptions) {}

  cancel(): void { this.lifetime.abort(); this.lifetime = new AbortController(); }
  dispose(): void { this.closed = true; this.cancel(); this.cache.clear(); }

  resolve(source: Structure, index: number, options: EmpiricalFrameBondReadOptions = {}): Promise<EmpiricalFrameBondProjection> {
    const reference = structuredClone(source), key = frameKey(reference, index);
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const projection = (status: EmpiricalFrameBondProjection['status'], warnings: string[] = []): EmpiricalFrameBondProjection => ({
      status, structure: atomOnly(reference), warnings,
      ...(reference.bonds !== undefined ? { sourceBonds: { bonds: structuredClone(reference.bonds), bondSource: reference.bondSource,
        ...(reference.bondPerceptionIssues?{bondPerceptionIssues:structuredClone(reference.bondPerceptionIssues)}:{}) } } : {}),
    });
    const current = () => {
      if (this.closed || signal.aborted) return 'cancelled' as const;
      try { options.guard?.(); } catch { return 'stale' as const; }
      if (frameKey(source, index) !== key) return 'stale' as const;
      return null;
    };
    const run = async (): Promise<EmpiricalFrameBondProjection> => {
      let stale = current(); if (stale) return projection(stale);
      if (!Number.isSafeInteger(index) || index < 0) return projection('failed', ['经验判断帧序号无效。']);
      const message = empiricalBondAdmission(reference); if (message) return projection('unavailable', [message]);
      const cached = this.cache.get(key);
      if (cached) {
        this.cache.delete(key); this.cache.set(key, cached);
        // Only reuse the derived graph. Labels/source metadata belong to the
        // current caller snapshot even when its scientific geometry is equal.
        const structure = atomOnly(reference);
        structure.bonds = structuredClone(cached.structure.bonds); structure.bondSource = 'inferred';
        if (cached.structure.bondPerceptionIssues) structure.bondPerceptionIssues = structuredClone(cached.structure.bondPerceptionIssues);
        return { ...projection('inferred'), structure, warnings: [...cached.warnings], ...(cached.preview!==undefined?{preview:cached.preview}:{}) };
      }
      if(reference.cell?.pbc.some(Boolean)){
        try{
          const perceived=perceivePeriodicConnections(reference,{allowUnconfirmedPreview:true});
          stale=current();if(stale)return projection(stale);
          const structure=atomOnly(reference);structure.bonds=perceived.bonds;structure.bondSource='inferred';
          if(perceived.issues.length)structure.bondPerceptionIssues=perceived.issues;
          const result={...projection('inferred'),structure,warnings:perceived.warnings,preview:perceived.preview};
          if(this.options.retainCache!==false){this.cache.set(key,structuredClone(result));while(this.cache.size>8)this.cache.delete(this.cache.keys().next().value!);}
          return result;
        }catch(error){stale=current();if(stale)return projection(stale);return projection('failed',['周期经验连接未接受：'+(error instanceof Error?error.message:String(error))]);}
      }
      let job: ChemistryJob | undefined, abort: (() => void) | undefined;
      try {
        let capabilities = await Promise.race([this.options.port.capabilities(), new Promise<null>(resolve => {
          abort = () => resolve(null); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        })]);
        if (abort) signal.removeEventListener('abort', abort);
        stale = current(); if (stale) return projection(stale);
        // Import, first frame and later frames share the same bounded startup
        // grace. An unavailable renderer bridge is not a completed projection.
        if ((!capabilities?.native || !capabilities.operations.includes('perceive-bonds')) && !this.capabilityWarmupUsed) {
          this.capabilityWarmupUsed = true;
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 200);
            signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish();
          });
          stale = current(); if (stale) return projection(stale);
          capabilities = await Promise.race([this.options.port.capabilities(), new Promise<null>(resolve => {
            abort = () => resolve(null); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
          })]);
          if (abort) signal.removeEventListener('abort', abort);
          stale = current(); if (stale) return projection(stale);
        }
        if (!capabilities?.native || !capabilities.operations.includes('perceive-bonds'))
          return projection('unavailable', ['当前环境没有原生经验判断能力；当前仅显示原子。']);
        // Composite perception derives its graph from coordinates; retain the
        // original graph separately rather than submitting stale file evidence.
        const structure = atomOnly(reference);
        const stamp: DocumentStamp = { documentId: this.options.sourceId, revision: reference.revision ?? index,
          graphFingerprint: graphFingerprint(structure), coordinatesFingerprint: coordinatesFingerprint(structure),
          constraintsFingerprint: JSON.stringify([this.options.sourceRevision ?? null, index]) };
        const request: ChemistryRequest = { operation: 'perceive-bonds', structure, stamp,
          movableAtomIds: reference.atoms.map(atom => atom.id!), aggression: 'standard', bondPerceptionPolicy: 'composite-v1' };
        const result = await traceTrajectoryOperation('empirical', { sourceId: this.options.sourceId, ...this.options.operationContext, sourceFrameIndex: index }, async (): Promise<EmpiricalFrameBondProjection> => {
          job = this.options.port.start(request);
          const response = await Promise.race([job.promise, new Promise<null>(resolve => {
            abort = () => { try { job?.cancel(); } catch { /* invalidation still wins */ } finally { resolve(null); } };
            signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
          })]);
          if (current() || !response) throw new DOMException('经验判断已取消。', 'AbortError');
          return { ...projection('inferred'), structure: accepted(reference, response, request), warnings: [...response.warnings] };
        });
        if (this.options.retainCache !== false) {
          this.cache.set(key, structuredClone(result));
          while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
        }
        return result;
      } catch (error) {
        stale = current(); if (stale) return projection(stale);
        return projection('failed', ['经验判断未接受：' + (error instanceof Error ? error.message : String(error))]);
      } finally { if (abort) signal.removeEventListener('abort', abort); }
    };
    const pending = this.tail.then(run);
    this.tail = pending.then(() => undefined, () => undefined);
    // A queued caller can cancel promptly even while an earlier native job runs.
    let stop: (() => void) | undefined;
    return Promise.race([pending, new Promise<EmpiricalFrameBondProjection>(resolve => {
      stop = () => resolve(projection('cancelled'));
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    })]).finally(() => { if (stop) signal.removeEventListener('abort', stop); });
  }
}
