import type { ReactNode } from 'react';
import { ChevronsDown, ChevronsUp, Columns3, Download, RotateCcw } from 'lucide-react';
import ScientificTableFormatControls from './ScientificTableFormatControls';
import type { ScientificTableFormat, ScientificTableSorting } from './scientific-table';
import './ScientificTableToolbar.css';

export interface ScientificTableToolbarProps {
  format?: ScientificTableFormat;
  unitLabel?: string;
  onArrange(): void;
  onRestore(): void;
  expansion?: { expanded: boolean; onToggle(): void };
  onExport(): void;
  exportDisabled?: boolean;
  sorting?: ScientificTableSorting;
  extraControls?: ReactNode;
}
/** One complete action strip, independent of the resized data body. */
export default function ScientificTableToolbar(p: ScientificTableToolbarProps) {
  return <div className="scientific-table-actions">
    {(p.format||p.sorting)&&<div className="scientific-table-parameters">
    {p.format&&<ScientificTableFormatControls format={p.format} alwaysVisible unitLabel={p.unitLabel}/>}
    {p.sorting&&<div className="scientific-table-sort"><label>排序<select aria-label={`${p.format?.ariaLabel??'本表'}排序字段`} value={p.sorting.value} onChange={event=>p.sorting!.onChange(event.currentTarget.value,p.sorting!.direction)}>{p.sorting.options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label><select aria-label={`${p.format?.ariaLabel??'本表'}排序方向`} value={p.sorting.direction} onChange={event=>p.sorting!.onChange(p.sorting!.value,event.currentTarget.value as 'asc'|'desc')}><option value="asc">升序</option><option value="desc">降序</option></select></div>}
    </div>}
    <div className="scientific-table-layout-actions">
    {p.extraControls}
    <button type="button" className="scientific-table-tool" onClick={p.onArrange}><Columns3 size={16} strokeWidth={1.75}/>整理</button>
    <button type="button" className="scientific-table-tool" onClick={p.onRestore}><RotateCcw size={16} strokeWidth={1.75}/>恢复布局</button>
    {p.expansion&&<button type="button" className="scientific-table-tool" aria-expanded={p.expansion.expanded} onClick={p.expansion.onToggle}>{p.expansion.expanded?<ChevronsUp size={16} strokeWidth={1.75}/>:<ChevronsDown size={16} strokeWidth={1.75}/ >}{p.expansion.expanded?'收起':'展开'}</button>}
    <button type="button" className="scientific-table-tool scientific-table-export" disabled={p.exportDisabled} onClick={p.onExport}><Download size={16} strokeWidth={1.75}/>导出</button>
    </div>
  </div>;
}
