import type { Structure } from '../../core/types';

/** Model preparation owns periodic axes. This view never requests confirmation. */
export default function PeriodicCellControls({structure}:{structure:Structure;disabled?:boolean;onConfirm?(pbc:[boolean,boolean,boolean]):void}) {
  const cell=structure.cell;
  if(structure.periodicSource?.completeness==='partial')return <p role="status">周期矢量不完整：可查看结构，暂不能进行周期整理或xTB优化。</p>;
  if(!cell)return null;
  return <div className="periodic-cell-controls" data-testid="periodic-cell-controls">
    <span>晶胞固定 · 工作周期：{cell.pbc.map((flag,index)=>flag?'XYZ'[index]:'').join('')||'无'}</span>
  </div>;
}
