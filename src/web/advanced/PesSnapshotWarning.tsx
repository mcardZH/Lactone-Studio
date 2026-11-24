export function PesSnapshotWarning({ label, issues }: { label: string; issues: readonly string[] }) {
  if (!issues.length) return null;
  return <details className="pes-local-failures">
    <summary aria-label={label} title={label}><span aria-hidden="true">!</span></summary>
    <div role="note">{issues.map(issue => <p key={issue}>{issue}</p>)}</div>
  </details>;
}
