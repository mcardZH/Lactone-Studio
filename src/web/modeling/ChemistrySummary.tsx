import type { ChemistryResult } from '../../modeling/contracts';
import { fullPrecisionValue } from '../../results/numeric-format';

export type ChemistryReceipt = Omit<ChemistryResult, 'structure' | 'text'> & { resultDocumentId: string; resultRevision: number };
export function chemistryReceipt(result: ChemistryResult, documentId: string, revision: number): ChemistryReceipt {
  const { structure: _structure, text: _text, ...receipt } = result;
  return structuredClone({ ...receipt, resultDocumentId: documentId, resultRevision: revision });
}
export function chemistrySummary(receipt: ChemistryReceipt): string {
  const engine = `${receipt.engine}${receipt.engineVersion ? ' ' + receipt.engineVersion : ''}`;
  const energy = Number.isFinite(receipt.before) && Number.isFinite(receipt.after)
    ? ` · ${fullPrecisionValue(receipt.before)} → ${fullPrecisionValue(receipt.after)}${receipt.unit ? ' ' + receipt.unit : ''}` : '';
  const convergence = receipt.converged === true ? '达到收敛阈值' : receipt.converged === false ? '未达到收敛阈值' : '完成（未提供收敛判据）';
  return `${engine}${receipt.forcefield ? ' · ' + receipt.forcefield : ''}${energy} · ${convergence}`;
}
export default function ChemistrySummary({ receipt }: { receipt: ChemistryReceipt }) {
  return <div className="model-chemistry-summary" data-testid="model-chemistry-summary">
    <span>{chemistrySummary(receipt)}</span>
    {receipt.warnings.length > 0 && <details><summary>提示 · {receipt.warnings.length}</summary>{receipt.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}
  </div>;
}
