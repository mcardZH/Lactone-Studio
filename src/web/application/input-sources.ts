import type { GaussianSettings } from '../../core/types';
import type { OrcaSettings } from '../../core/orca';
import { isQstTask } from '../../core/gaussian-qst';

/** Only source roles of the active input task enter the common workspace. */
export function inputSourceRoleKey(engine: 'gaussian' | 'orca', gaussian: GaussianSettings, orca: OrcaSettings, documentId?: string): string {
  return JSON.stringify(engine === 'gaussian' && isQstTask(gaussian.task)
    ? [gaussian.task, gaussian.qst?.reactantSource?.documentId, gaussian.qst?.product?.documentId, gaussian.task === 'qst3' ? gaussian.qst?.tsGuess?.documentId : null]
    : engine === 'orca' && orca.task === 'neb'
      ? ['NEB', orca.neb.reactantSource?.documentId ?? documentId, orca.neb.productSource?.documentId, orca.neb.tsGuessSource?.documentId] : []);
}

export function inputSourceRoles(key: string): { documentId: string; label: string }[] {
  const [task, reactant, product, tsGuess] = JSON.parse(key) as (string | undefined)[];
  return task ? [[reactant, '反应物'], [product, '产物'], [tsGuess, '过渡态初猜']].flatMap(([documentId, role]) => documentId ? [{ documentId, label: `${task.toUpperCase()} · ${role}` }] : []) : [];
}
