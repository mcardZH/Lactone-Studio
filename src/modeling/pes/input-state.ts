import type { PesGeometry, PesGroup, PesNode, PesRun } from './contracts';

// A confirmation is scoped to its PES group. Rendering a result or projecting
// the same source into a different workspace tab must not revoke it.
export function pesElectronicSourceKey(group: PesGroup, geometry: PesGeometry): string {
  const members = geometry.structure.atoms.map(atom => [atom.id, atom.element]).sort((a,b) =>
    String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])));
  return JSON.stringify([group.id, members]);
}

export function pesElectronicConfirmed(group: PesGroup, geometry: PesGeometry): boolean {
  const { confirmed, sourceKey, charge, multiplicity } = group.electronic;
  if(!confirmed||confirmed.charge!==Number(charge)||confirmed.multiplicity!==Number(multiplicity))return false;
  const key=pesElectronicSourceKey(group,geometry);
  if(sourceKey!==undefined)return key===sourceKey;
  return false;
}

export function hasSuccessfulWorkbenchResult(run: Pick<PesRun, 'request' | 'status' | 'result' | 'error'> | undefined): boolean {
  if (!run || run.status !== 'completed' || run.error || !run.result ||
    !['completed', 'converged'].includes(run.result.status) || !['ts', 'hessian'].includes(run.request.operation)) return false;
  const hessian = run.result.hessian as {frameId?:string; projectedDegreesOfFreedom?:number; vibrationalDegreesOfFreedom?:number} | undefined;
  const frequencies = run.result.frequencies;
  const frequencyResult = Array.isArray(frequencies) && (frequencies.length > 0 || hessian?.vibrationalDegreesOfFreedom === 0 ||
    hessian?.projectedDegreesOfFreedom === 0 && hessian.vibrationalDegreesOfFreedom === undefined);
  return frequencyResult && !!hessian?.frameId && run.result.frames.some(frame => frame.id === hessian.frameId);
}

export class PesCompositionChange extends Error {
  constructor(readonly groupId: string, readonly atomCount: number, readonly existingAtomCounts: readonly number[],
    readonly conflictingResults: readonly { atomCount: number; label: string }[],
    readonly continueInNewGroup: () => PesNode) {
    const results = conflictingResults.map(result => `${result.label}（${result.atomCount} 个原子）`).join('、');
    super(`本次输入有 ${atomCount} 个原子。本组已有结果 ${results}。是否在新势能面组继续本次计算？`);
    this.name = 'PesCompositionChange';
  }
}

export class PesSubmissionChanged extends Error {
  constructor() {
    super('输入或任务已变化，请从当前计算卡或结构重新提交。');
    this.name = 'PesSubmissionChanged';
  }
}
