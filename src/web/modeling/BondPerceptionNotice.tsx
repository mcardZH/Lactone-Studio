import { useMemo } from 'react';
import type { BondPerceptionIssue, Structure } from '../../core/types';

const NO_ISSUES: readonly BondPerceptionIssue[] = [];
const ISSUE_TYPES = { partial: '候选部分连接', 'weak-contact': '弱接触', unresolved: '键级待确认' } as const;

export function bondPerceptionIssueKey(issue: BondPerceptionIssue): string {
  const image = issue.image ?? [0, 0, 0];
  const forward = JSON.stringify([issue.atomIds[0], issue.atomIds[1], image]);
  const reverse = JSON.stringify([issue.atomIds[1], issue.atomIds[0], image.map(value => -value || 0)]);
  return forward < reverse ? forward : reverse;
}

export default function BondPerceptionNotice({ structure, onSelect }: { structure: Structure; onSelect(ids: string[]): void }) {
  const atoms = structure.atoms, issues = structure.bondPerceptionIssues ?? NO_ISSUES;
  const hasIssues = issues.length > 0;
  // Linear signatures cover the actual presentation inputs, including callers
  // replacing/reordering data in an existing outer Structure object.
  const atomSignature = hasIssues ? JSON.stringify(atoms.map(atom => [typeof atom.id, atom.id, atom.element])) : '';
  const issueSignature = hasIssues ? JSON.stringify(issues.map(issue => [issue.atomIds, issue.image, issue.kind, issue.reason])) : '';
  const labels = useMemo(() => {
    const values = new Map<string | undefined, string>();
    if (!hasIssues) return values;
    atoms.forEach((atom, index) => { if (!values.has(atom.id)) values.set(atom.id, atom.element + (index + 1)); });
    return values;
  }, [atoms, hasIssues, atomSignature]);
  const rows = useMemo(() => issues.map(issue => ({
    key: bondPerceptionIssueKey(issue), title: issue.reason, ids: [...new Set(issue.atomIds)],
    text: issue.atomIds.map(id => labels.get(id) ?? '?').join('–'),
    image: issue.image?.some(Boolean) ? ` [${issue.image.map(value => value > 0 ? `+${value}` : value).join(', ')}]` : '',
    type: ISSUE_TYPES[issue.kind],
  })), [issues, issueSignature, labels]);
  if (!rows.length) return null;
  return <details className="model-bond-perception-notice" data-testid="bond-perception-notice">
    <summary>局部连接待确认 · {rows.length} 对</summary>
    <div>{rows.map(row => <button type="button" key={row.key} title={row.title} onClick={() => onSelect([...row.ids])}>{row.text}{row.image} · {row.type}</button>)}</div>
  </details>;
}
