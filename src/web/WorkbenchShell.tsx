import { type CSSProperties, type ReactNode } from 'react';
import './workbench-shell.css';
import { useWorkbenchLayout } from './modeling/WorkbenchLayout';
import { clampWorkbenchPaneSize, DEFAULT_WORKBENCH_PANE_SIZES, WORKBENCH_PANE_LIMITS } from '../modeling/workbench-layout';

export interface WorkbenchShellProps {
  desktop: boolean;
  children: ReactNode;
  onToolHost: (element: HTMLDivElement | null) => void;
  externalToolHost?:boolean;
  rightWidth?: number;
  onRightWidth?: (width: number) => void;
}

/** View composition only. Moving dividers never changes a model document. */
export default function WorkbenchShell({ desktop, children, onToolHost, rightWidth, onRightWidth, externalToolHost=false }: WorkbenchShellProps) {
  const workbench=useWorkbenchLayout();
  const width = rightWidth ?? workbench.layout.paneSizes.rightWidth;
  const resize = (value: number) => {
    const next = clampWorkbenchPaneSize('rightWidth', value);
    workbench.updateLayout(current=>({...current,paneSizes:{...current.paneSizes,rightWidth:next}}));onRightWidth?.(next);
  };
  const collapsed = width <= 48;
  return <div className={'workspace-grid'+(desktop?' unified-workbench-grid':'')} data-testid={desktop?'unified-workbench':undefined} data-external-tool-host={externalToolHost} data-tool-pane-collapsed={collapsed} data-left-pane-custom={workbench.layout.paneSizes.leftWidth!==DEFAULT_WORKBENCH_PANE_SIZES.leftWidth} style={{'--tool-width':width+'px','--input-preview-height':workbench.layout.paneSizes.previewHeight+'px'} as CSSProperties}>
    {children}
    {desktop && !externalToolHost && <><div className="workspace-divider tool-divider" role="separator" aria-label="调整工具区宽度" aria-orientation="vertical" aria-valuemin={WORKBENCH_PANE_LIMITS.rightWidth.min} aria-valuemax={WORKBENCH_PANE_LIMITS.rightWidth.max} aria-valuenow={width} tabIndex={0}
      onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(!event.currentTarget.hasPointerCapture(event.pointerId))return;const bounds=event.currentTarget.parentElement!.getBoundingClientRect();resize(bounds.right-event.clientX);}}
      onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onDoubleClick={()=>resize(DEFAULT_WORKBENCH_PANE_SIZES.rightWidth)}
      onKeyDown={event=>{if(event.key==='Home'){event.preventDefault();resize(DEFAULT_WORKBENCH_PANE_SIZES.rightWidth);}else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();resize(width+(event.key==='ArrowLeft'?10:-10));}}}/>
      <aside className="workbench-tool-pane" aria-label="建模工具区"><button type="button" className="workbench-pane-restore" aria-label="恢复工具区宽度" title="恢复工具区宽度" onClick={()=>resize(DEFAULT_WORKBENCH_PANE_SIZES.rightWidth)}>↔</button><div ref={onToolHost} className="workbench-tool-host" data-testid="workbench-tool-host"/></aside></>}
  </div>;
}
