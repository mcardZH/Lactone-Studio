import { useRef, useState, type ReactNode } from 'react';
import { Settings2 } from 'lucide-react';
import type { DisplaySettings } from '../../modeling/contracts';
import type {Atom} from '../../core/types';
import SettingsPanel from './SettingsPanel';
import './model-settings-popover.css';

export interface ModelSettingsPopoverProps {
  display: DisplaySettings;
  onDisplayChange(display: DisplaySettings): void;
  /** Existing element-color, alignment, default-persistence and manual tools.
   * Supply their one controlled instance; no copied display/settings state. */
  children?: ReactNode;
  disabled?: boolean;
  onOpenSettings?():void;
  atoms?:readonly Atom[];targetLabel?:string;hasCell?:boolean;showAxes?:boolean;onShowAxesChange?(value:boolean):void;
}
export default function ModelSettingsPopover({ display, onDisplayChange, children, disabled = false,onOpenSettings,atoms,targetLabel,hasCell,showAxes,onShowAxesChange }: ModelSettingsPopoverProps) {
  const trigger=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false);
  return <div className="model-settings-anchor" data-no-reorder onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    <button ref={trigger} type="button" className="model-settings-trigger" disabled={disabled} aria-label="显示设置" aria-expanded={open} title="显示、选择与建模设置" onClick={()=>onOpenSettings?onOpenSettings():setOpen(value=>!value)}><Settings2 size={15}/><span>显示设置</span></button>
    {open&&<SettingsPanel display={display} onDisplayChange={onDisplayChange} atoms={atoms} targetLabel={targetLabel} hasCell={hasCell} showAxes={showAxes} onShowAxesChange={onShowAxesChange} initialPage="display" ownerDocument={trigger.current?.ownerDocument} extra={children} onClose={()=>{setOpen(false);trigger.current?.focus();}}/>}
  </div>;
}
