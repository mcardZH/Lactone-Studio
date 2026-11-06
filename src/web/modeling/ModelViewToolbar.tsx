export const MODEL_CELL_VIEWS = ['a','a*','b','b*','c','c*'] as const;
export type ModelCellView = typeof MODEL_CELL_VIEWS[number];
export type ModelViewRequest = {kind:'standard'} | {kind:'cell';preset:ModelCellView};
export interface ModelViewToolbarProps {
  showAxes:boolean; hasAtoms:boolean; hasCell:boolean; showCell:boolean;
  onCamera(request:ModelViewRequest):void;
  onReset():void; onToggleAxes():void; onToggleCell():void;
}

/** Observation only. The owning workspace retains camera serials, display
 * settings and all model/runtime ownership; no new orientation algorithm. */
export default function ModelViewToolbar(props:ModelViewToolbarProps){
  return <div className="model-view-toolbar" data-testid="model-view-toolbar" role="toolbar" aria-label="建模观察">
    <button type="button" aria-pressed={props.showAxes} title="显示真实物理坐标轴，不改变坐标" onClick={props.onToggleAxes}>XYZ</button>
    <button type="button" disabled={!props.hasCell} aria-pressed={props.showCell} title="显示或隐藏当前晶胞" onClick={props.onToggleCell}>盒子</button>
    <button type="button" disabled={!props.hasAtoms} title="标准观察方向，只改变视角" onClick={()=>props.onCamera({kind:'standard'})}>标准</button>
    <button type="button" data-testid="model-reset-view" title="居中当前模型，只改变视角" onClick={props.onReset}>居中</button>
    {MODEL_CELL_VIEWS.map(preset=><button key={preset} type="button" className="model-view-axis" data-cell-view={preset} disabled={!props.hasCell}
      title={preset.endsWith('*')?`正对${preset[0]}晶胞面观察`:`沿${preset}晶胞轴观察`} onClick={()=>props.onCamera({kind:'cell',preset})}>{preset}</button>)}
  </div>;
}
