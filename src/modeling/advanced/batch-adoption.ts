import type { Structure } from '../../core/types';
import { graphFingerprint } from '../../core/modeling/graph';
import { effectiveSharedFreezes } from '../constraints';
import { XTB_METHOD_LABELS, type XtbRequest } from '../xtb/contracts';
import type { AdvancedCalculationResult, AdvancedOptimizationMethod } from './contracts';
import type { AdvancedFrameSource } from './frame-source';
import { assertAdvancedForcefieldConstraints, assertAdvancedForcefieldGrant } from './forcefield-adapter';
import { validateAdvancedXtbResult } from './xtb-result';
import type { ConformerBatchBridge, ConformerBatchEntry, ConformerBatchIdentity, ConformerBatchProgress } from './batch-contracts';

export class ConformerBatchIntegrityError extends Error {}

export function isConformerBatchTerminal(progress: ConformerBatchProgress): boolean {
  return ['completed', 'stopped', 'error'].includes(progress.phase);
}

export function matchesConformerBatch(progress: ConformerBatchProgress, batchId: string, identity: ConformerBatchIdentity, total: number): boolean {
  return progress?.schema === 1 && progress.batchId === batchId && progress.total === total
    && progress.identity?.taskId === identity.taskId && progress.identity.runId === identity.runId
    && progress.identity.stageId === identity.stageId && progress.identity.revision === identity.revision
    && [progress.seq, progress.succeeded, progress.discarded, progress.pending, progress.running].every(n => Number.isSafeInteger(n) && n >= 0)
    && progress.succeeded + progress.discarded + progress.pending + progress.running === total;
}

/** Page order comes from the original registration. Each successful entry is
 * independently committed by the owner, so an invalid row cannot replace a
 * previously accepted frame or block unrelated valid rows in the same page. */
export async function readConformerBatch(
  bridge: ConformerBatchBridge, settled: ConformerBatchProgress, candidateIds: readonly string[],
  adopt: (entry: ConformerBatchEntry) => void,
): Promise<void> {
  const observed = { succeeded: 0, discarded: 0, pending: 0 };
  let rowError: unknown;
  for (let offset = 0; offset < candidateIds.length;) {
    const limit = Math.min(64, candidateIds.length - offset);
    let page: Awaited<ReturnType<ConformerBatchBridge['read']>>;
    try { page = await bridge.read(settled.batchId, { offset, limit }); }
    catch (error) {
      // The host proves this exact record failed and keeps it untouched.
      // A generic transport error cannot identify a record to skip.
      if (!(error instanceof Error) || !error.message.includes(`CONFORMER_BATCH_RECORD[${offset}]:`)) throw error;
      rowError ??= new ConformerBatchIntegrityError(error.message);
      offset++;
      continue;
    }
    if (page?.total !== candidateIds.length || !Array.isArray(page.entries) || !page.entries.length)
      throw new Error('后台批终态分页不完整。');
    if (page.entries.length > limit)
      throw new ConformerBatchIntegrityError('后台批终态候选顺序、状态或身份不符。');
    for (const [position, entry] of page.entries.entries()) {
      if (entry?.index !== offset + position || entry.candidateId !== candidateIds[offset + position]
        || !['succeeded', 'discarded', 'pending'].includes(entry.status)) {
        rowError ??= new ConformerBatchIntegrityError(`后台批终态候选 ${offset + position} 的顺序、状态或身份不符。`);
        continue;
      }
      observed[entry.status]++;
      try { adopt(entry); }
      catch (error) { rowError ??= error; }
    }
    offset += page.entries.length;
  }
  if (rowError) throw rowError;
  if (observed.succeeded !== settled.succeeded || observed.discarded !== settled.discarded || observed.pending !== settled.pending)
    throw new ConformerBatchIntegrityError('后台批终态统计与规范记录不一致。');
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export function validateConformerBatchEntry(entry: ConformerBatchEntry, source: AdvancedFrameSource, stageId: string,
  method: AdvancedOptimizationMethod, expectedRequest?: XtbRequest, expectsGrant = false, originalInput=source):
  (AdvancedCalculationResult & { structure?: Structure }) | undefined {
  try {
    if (!same(entry.source, source) || !same(entry.originalInput ?? entry.source, originalInput)) throw Error('后台批终态的执行或原始来源不符。');
    if (entry.status === 'pending') return;
    const result: AdvancedCalculationResult = { candidateId: entry.candidateId, stageId, input: source,
      originalInput, status: 'failed', error: entry.reason?.message ?? '候选优化未完成。' };
    let native: XtbRequest | undefined;
    if (method.backend === 'xtb') {
      native = entry.request?.backend === 'xtb' ? entry.request.request : undefined;
      if (!native || !same(native, expectedRequest))
        throw Error('落盘执行请求的方法、候选或来源不符。');
    }
    const unconverged=entry.status==='discarded'&&(native!==undefined&&entry.reason?.code==='XTB_STEP_LIMIT'
      &&entry.result?.metadata?.converged===false&&entry.result.metadata.convergenceStatus==='step-limit'
      ||method.backend==='forcefield'&&entry.reason?.code==='FORCEFIELD_NOT_CONVERGED'&&entry.result!==undefined);
    if (entry.status === 'discarded'&&!unconverged) return result;
    const raw = entry.result;
    if (!raw || !raw.structure || graphFingerprint(raw.structure) !== graphFingerprint(source.structure))
      throw Error('后台结果缺少原始连接或电子态。');
    const atomOrderMatches = raw.structure.atoms.length === source.structure.atoms.length && raw.structure.atoms.every((atom, index) => {
      const expected = source.structure.atoms[index];
      return atom.id === expected.id && atom.element === expected.element;
    });
    if (!atomOrderMatches) throw Error('后台结果的原子对应不符。');
    if (!Number.isFinite(raw.energyHartree)) return { ...result, error: '本候选优化没有有效的有限能量，已丢弃。' };
    if (raw.structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite)))
      return { ...result, error: '本候选优化没有有效的有限坐标，已丢弃。' };
    let structure = raw.structure, identity = raw.identity;
    if (native) {
      if(raw.metadata?.converged!==!unconverged)throw Error('后台优化状态与原生收敛回执不一致。');
      const zero = (value: number) => value === 0 ? 0 : value;
      const coordinates = structure.atoms.map(atom => ({ id: atom.id!, element: atom.element, x: zero(atom.x), y: zero(atom.y), z: zero(atom.z) }));
      structure = validateAdvancedXtbResult(native, coordinates, raw.metadata!, raw.resourceGrant);
      if (raw.energyHartree !== raw.metadata!.energyHartree) throw Error('后台能量与原生回执不符。');
      const expected = { method: `${XTB_METHOD_LABELS[native.method]}:${raw.metadata!.version}`,
        solvent: native.solvation ? `${native.solvation.model}:${native.solvation.solvent}` : 'none',
        energyKind: native.method === 'gfnff' ? 'forcefield-potential' as const : 'electronic' as const,
        charge: native.charge, multiplicity: structure.multiplicity!, settingsKey: JSON.stringify({ constraints: native.constraints, frozenAtomIds: native.frozenAtomIds, runtime:raw.metadata!.engineIdentity }) };
      if (identity && !same(identity, expected)) throw Error('后台结果的计算身份不符。');
      identity = expected;
    } else if (method.backend === 'forcefield') {
      const constraints = effectiveSharedFreezes(source.constraints), fixed = new Set(constraints.frozenAtomIds);
      const actualForcefield = identity?.method.split(':').at(-1);
      const settingsKey = JSON.stringify({ energyKind: 'forcefield-potential', actualForcefield, constraints: constraints.coordinates, frozenAtomIds: [...fixed] });
      if (!identity || !['UFF', 'MMFF94', 'MMFF94s'].includes(actualForcefield ?? '')
        || method.forcefield !== 'auto' && method.forcefield !== actualForcefield || identity.solvent !== 'none'
        || identity.energyKind !== 'forcefield-potential' || identity.charge !== structure.charge || identity.multiplicity !== structure.multiplicity
        || identity.settingsKey !== undefined && identity.settingsKey !== settingsKey)
        throw Error('后台力场方法、电子态或冻结设置不符。');
      if (structure.atoms.some((atom, index) => {
        const original = source.structure.atoms[index];
        return fixed.has(atom.id!) && (atom.x !== original.x || atom.y !== original.y || atom.z !== original.z);
      })) throw Error('后台力场结果改变了固定原子。');
      assertAdvancedForcefieldConstraints(source.structure, structure, constraints.coordinates);
      if (method.optimizationStepPolicy === 'native-default') {
        const optimizer = constraints.coordinates.length ? 'scipy-slsqp' : 'rdkit-minimize';
        if (raw.forcefieldOptimization?.optimizer !== optimizer
          || raw.forcefieldOptimization.maxSteps !== (optimizer === 'scipy-slsqp' ? 100 : 200))
          throw Error('后台力场结果缺少实际优化器或原生默认步数回执。');
      }
      if (expectsGrant && !raw.resourceGrant) throw Error('后台力场结果缺少原生资源授权回执。');
      assertAdvancedForcefieldGrant(raw.resourceGrant);
    }
    return { ...result, status: unconverged?'unconverged':'completed', error: unconverged?result.error:undefined, energyHartree: raw.energyHartree,
      metadata: raw.metadata, forcefieldOptimization: raw.forcefieldOptimization, sessionId: raw.sessionId, identity, structure };
  } catch (error) {
    throw new ConformerBatchIntegrityError(error instanceof Error ? error.message : String(error));
  }
}
