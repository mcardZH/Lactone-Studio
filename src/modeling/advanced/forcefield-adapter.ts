import type { ChemistryJob, ChemistryPort } from '../contracts';
import { effectiveSharedFreezes } from '../constraints';
import { graphFingerprint } from '../../core/modeling/graph';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { assertBuilderStereoPreserved } from '../../core/builder-stereo';
import { convertEnergy } from '../../results/energy';
import { assertAdvancedIsolated } from './frame-source';
import type { AdvancedForcefieldAdapter } from './contracts';

/** Existing native molecular force fields run on one thread. Advanced requests
 * have no wall-clock deadline; promises settle only after actual child close. */
export function createAdvancedForcefieldAdapter(chemistry: ChemistryPort): AdvancedForcefieldAdapter {
  return {
    optimize({ source, method, taskId, runId, maxWallTimeSeconds, memoryBudgetBytes, optimizationPool }) {
      assertAdvancedIsolated(source);
      if (method.threads !== 1 || !Number.isInteger(method.maxSteps) || method.maxSteps < 1 || method.maxSteps > 500)
        throw new Error('力场优化采用单线程，步数须为1–5000。');
      if (!['none', 'gas', ''].includes(method.solvent)) throw new Error('当前分子力场不支持隐式溶剂。');
      if (maxWallTimeSeconds !== undefined && (!Number.isFinite(maxWallTimeSeconds) || maxWallTimeSeconds < 1)) throw new Error('力场作业时间预算无效。');
      if (memoryBudgetBytes !== undefined && (!Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes <= 0)) throw new Error('力场内存预算须为正整数字节。');
      const original = structuredClone(source.structure);
      const constraints=effectiveSharedFreezes(source.constraints),frozen = new Set(constraints.frozenAtomIds);
      if (constraints.coordinates.some(row => row.action !== 'freeze')) throw new Error('力场优化不能将扫描定义当成冻结。');
      const movableAtomIds = original.atoms.flatMap(atom => frozen.has(atom.id!) ? [] : [atom.id!]);
      if (!movableAtomIds.length) throw new Error('当前结构没有可优化原子。');
      let job: ChemistryJob | undefined, stopping = false;
      const promise = (async () => {
        const capability = await chemistry.capabilities();
        if (!capability.native || !capability.operations.includes('optimize')) throw new Error('高级构象优化需要实际原生分子力场后端。');
        if (stopping) throw new Error('力场优化已取消。');
        const request = { stamp: structuredClone(source.stamp), operation: 'optimize' as const,
          runIdentity: { taskId, runId }, ...(optimizationPool ? { optimizationPool } : {}),
          structure: original, movableAtomIds, forcefield: method.forcefield, steps: method.maxSteps,
          constraints: structuredClone(constraints.coordinates),
          ...(memoryBudgetBytes === undefined ? {} : { threads: 1, memoryBudgetBytes }) };
        job = chemistry.start(request);
        const result = await job.promise;
        if (stopping) throw new Error('力场优化已取消。');
        if (result.operation !== 'optimize' || JSON.stringify(result.stamp) !== JSON.stringify(source.stamp)
          || result.engine !== 'RDKit' || !result.engineVersion || result.unit !== 'kcal/mol'
          || !Number.isFinite(result.after) || !['MMFF94', 'MMFF94s', 'UFF'].includes(result.forcefield ?? ''))
          throw new Error('力场结果缺少匹配的方法、来源、能量或单位。');
        if (method.forcefield !== 'auto' && result.forcefield !== method.forcefield)
          throw new Error('所选力场缺少参数，后端的替代方法未作为本级结果接受。');
        const grant = result.resourceGrant;
        if (grant || memoryBudgetBytes !== undefined) {
          const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
          if (!grant || grant.threads !== 1 || !positive(grant.memoryBudgetBytes)
            || !/^[a-f0-9]{64}$/.test(grant.version) || typeof grant.source !== 'string' || !grant.source.trim()
            || grant.memoryEnforced !== false || !positive(grant.configured?.threads) || !positive(grant.configured?.memoryBudgetBytes)
            || !positive(grant.requested?.threads) || !positive(grant.requested?.memoryBudgetBytes)
            || (memoryBudgetBytes !== undefined && (grant.requested.threads !== 1 || grant.requested.memoryBudgetBytes !== memoryBudgetBytes))
            || (grant.configured.threads !== 1 && !(typeof grant.threadLimitReason === 'string' && grant.threadLimitReason.trim()))
            || !Number.isSafeInteger(grant.reservedBytes) || grant.reservedBytes < 0
            || grant.memoryBudgetBytes + grant.reservedBytes !== grant.configured.memoryBudgetBytes)
            throw new Error('力场结果缺少匹配的受管全局资源回执。');
        }
        const structure = result.structure;
        if (graphFingerprint(structure) !== graphFingerprint(original)
          || structure.charge !== original.charge || structure.multiplicity !== original.multiplicity
          || structure.atoms.length !== original.atoms.length || structure.atoms.some((atom, index) => {
            const before = original.atoms[index];
            return atom.id !== before.id || atom.element !== before.element || ![atom.x, atom.y, atom.z].every(Number.isFinite)
              || frozen.has(atom.id!) && (atom.x !== before.x || atom.y !== before.y || atom.z !== before.z);
          })) throw new Error('力场优化改变了来源身份、电子态或固定原子。');
        for (const row of constraints.coordinates) {
          const target = row.value ?? builderCoordinateValue(original, row.type, row.atomIds);
          const actual = builderCoordinateValue(structure, row.type, row.atomIds);
          const difference = row.type === 'D' ? ((actual - target + 180) % 360 + 360) % 360 - 180 : actual - target;
          if (!Number.isFinite(difference) || Math.abs(difference) > (row.type === 'B' ? 1e-6 : 1e-5 * 180 / Math.PI))
            throw new Error('力场优化的内坐标冻结残差超出当前后端合同。');
        }
        assertBuilderStereoPreserved(original, structure);
        const energyHartree = convertEnergy({ value: result.after!, unit: 'kcal/mol' }, 'hartree');
        if (energyHartree === null) throw new Error('力场能量无法按实际单位转换。');
        return { structure: structuredClone(structure), energyHartree,
          converged: result.converged === true, engine: result.engine, version: result.engineVersion,
          forcefield: result.forcefield!, energyKind: 'forcefield-potential' as const,
          effectiveResources: { threads: 1, ...(grant ? { memoryBudgetBytes: grant.memoryBudgetBytes } : {}) },
          ...(grant ? { resourceGrant: structuredClone(grant) } : {}) };
      })();
      return { promise, async stop() { stopping = true; job?.cancel(); await promise.catch(() => {}); } };
    },
  };
}
