import type { Structure } from '../../core/types';
import { clearBondEvidence } from '../../core/bond-semantics';
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
  const projected = { ...structure, atoms, charge, multiplicity };
  if (structure.bonds?.some(bond => bond.mbo !== undefined || bond.perception !== undefined)) {
    projected.bonds = structure.bonds.map(bond => ({ ...bond }));
    clearBondEvidence(projected);
  }
  return projected;
}

export function ordinaryOptimizationStatus(status: PesRunStatus, result?: PesResult, frame?: PesFrame): string | undefined {
  if (status === 'stopped') return '已停止';
  if (status === 'interrupted' || status === 'failed' && (frame || result?.finalObservation || result?.frames.length)) return '优化中断';
  if (status === 'failed') return '优化失败';
  if (status !== 'completed') return;
  const warning = result?.provenance.bondPerceptionWarning;
  const withWarning = (text: string) => typeof warning === 'string' ? `${text} · ${warning}` : text;
  if (result?.status === 'completed' || result?.status === 'converged') {
    const adopted=frame??(result.finalObservation as Pick<PesFrame,'converged'>|undefined)??result.frames.at(-1);
    if (adopted?.converged === false) return withWarning('已保留最后有效帧，尚未收敛');
    return withWarning('已收敛');
  }
  if (result?.status === 'not-converged') {
    const optimizer = result.provenance.optimizer as {terminationReason?: string} | undefined;
    return withWarning(optimizer?.terminationReason === 'no-feasible-step'
      ? '未找到可接受的下一步，尚未收敛' : '达到设定步数，尚未收敛');
  }
  return withWarning('尚未收敛');
}

export function ordinaryOptimizationError(error?: PesRunError, result?: PesResult): string | undefined {
  const adoption = result?.provenance.geometryAdoptionError;
  return [error?.message, error?.detail, typeof adoption === 'string' ? adoption : undefined].filter(Boolean).join(' ') || undefined;
}

export function ordinaryOptimizationPreparation(status: PesRunStatus, result: PesResult | undefined, frame: PesFrame): NonNullable<Structure['preparation']> {
  return { status: ordinaryOptimizationStatus(status, result, frame) ?? frame.status, after: frame.energyHartree ?? undefined, unit: 'hartree' };
}
