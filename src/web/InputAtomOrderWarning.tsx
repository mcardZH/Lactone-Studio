import './input-atom-order.css';
/** Reuses the local yellow mismatch marker without confirming scientific input. */
export default function InputAtomOrderWarning({ label, message }: { label: string; message?: string | null }) {
  return message ? <details className="electronic-state-warning" data-testid="input-atom-order-warning"><summary aria-label={`${label}原子顺序不匹配说明`} title={`${label}原子顺序不匹配`}>!</summary><span role="note">{message}</span></details> : null;
}
