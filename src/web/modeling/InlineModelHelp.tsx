import type {ReactNode} from 'react';
import './inline-model-help.css';

/** Optional explanation in the existing card, with no modal or focus transfer. */
export default function InlineModelHelp({label,children}:{label:string;children:ReactNode}){
  return <details className="model-inline-help"><summary aria-label={label} title={label}>ⓘ</summary><div role="note">{children}</div></details>;
}
