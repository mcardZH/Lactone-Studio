import type { Structure } from '../../core/types';
import type { PesFrame, PesRequest, PesResult, PesRunError, PesRunStatus } from './contracts';

/** Ordinary optimization moves the atoms of one sealed input with known
 * order. Its graph remains the input graph until an explicit final rebuild. */
export function projectOrdinaryOptimizationStructure(
  request: Pick<PesRequest, 'structure' | 'charge' | 'uhf'>,
  frame?: Pick<PesFrame, 'positions'>,
): Structure {
  const { structure, charge, uhf } = request;
  const multiplicity = uhf + 1;
  if (!frame && structure.charge === charge && structure.multiplicity === multiplicity) return structure;
  const atoms = frame ? structure.atoms.map((atom, index) => {
    const [x, y, z] = frame.positions[index];
    return { ...atom, x, y, z };
  }) : structure.atoms;
  return { ...structure, atoms, charge, multiplicity };
}

export function ordinaryOptimizationStatus(status: PesRunStatus, result?: PesResult, frame?: PesFrame): string | undefined {
  if (status === 'stopped') return '已停止';
  if (status === 'interrupted' || status === 'failed' && (frame || result?.finalObservation || result?.frames.length)) return '优化中断';
  if (status === 'failed') return '优化失败';
  if (status !== 'completed') return;
  if (result?.status === 'completed' || result?.status === 'converged') {
    const adopted=frame??(result.finalObservation as Pick<PesFrame,'converged'>|undefined)??result.frames.at(-1);
    if (adopted?.converged === false) return '已保留最后有效帧，尚未收敛';
    const warning = result.provenance.bondPerceptionWarning;
    return typeof warning === 'string' ? `已收敛 · ${warning}` : '已收敛';
  }
  if (result?.status === 'not-converged') {
    const optimizer = result.provenance.optimizer as {terminationReason?: string} | undefined;
    return optimizer?.terminationReason === 'no-feasible-step'
      ? '未找到可接受的下一步，尚未收敛' : '达到设定步数，尚未收敛';
  }
  return '尚未收敛';
}

export function ordinaryOptimizationError(error?: PesRunError, result?: PesResult): string | undefined {
  const adoption = result?.provenance.geometryAdoptionError;
  return [error?.message, error?.detail, typeof adoption === 'string' ? adoption : undefined].filter(Boolean).join(' ') || undefined;
}

export function ordinaryOptimizationPreparation(status: PesRunStatus, result: PesResult | undefined, frame: PesFrame): NonNullable<Structure['preparation']> {
  return { status: ordinaryOptimizationStatus(status, result, frame) ?? frame.status, after: frame.energyHartree ?? undefined, unit: 'hartree' };
}
