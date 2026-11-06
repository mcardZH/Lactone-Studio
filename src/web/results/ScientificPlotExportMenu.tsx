import { useRef,useState } from 'react';
import {useTransientLayer} from '../TransientLayer';

export interface ScientificPlotExportOption {
  key: string;
  label: string;
  disabled?: boolean;
  run(): void;
}

/** Export choices share the owning figure and never collect data themselves. */
export function ScientificPlotExportMenu({ options, disabled = false }: { options: readonly ScientificPlotExportOption[]; disabled?: boolean }) {
  const root = useRef<HTMLDetailsElement>(null),panel=useRef<HTMLDivElement>(null),[open,setOpen]=useState(false);
  useTransientLayer({open,triggerRef:root,contentRef:panel,onDismiss:()=>{if(root.current)root.current.open=false;setOpen(false);},peerGroup:'scientific-plot-export'});
  return <details ref={root} className="scientific-plot-export" onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}><summary aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault(); }}>导出</summary>
    <div ref={panel} className="scientific-plot-export-options">{options.map(option => <button type="button" key={option.key} disabled={disabled || option.disabled} onClick={() => {
      if (root.current) root.current.open = false;
      option.run();
    }}>{option.label}</button>)}</div>
  </details>;
}
