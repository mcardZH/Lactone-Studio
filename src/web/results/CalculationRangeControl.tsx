import { InputSettingsCheckbox } from '../InputSettingsLayout';
import { BOHR_TO_ANGSTROM } from '../../core/orca/assets';
import type { CalculationRangeDisplay } from '../../results/calculation-range';
import { SpatialGridSummary } from './AnalysisTaskLayout';

/** Shared display switch; toggling this component never starts a scientific task. */
export default function CalculationRangeControl({checked,onChange,range,disabled=false}:{checked:boolean;onChange(value:boolean):void;range?:CalculationRangeDisplay|null;disabled?:boolean}){
  const grid=range?{dimensions:range.grid.dimensions,pointCount:range.grid.dimensions.reduce((total,value)=>total*value,1),axisSpacingBohr:range.grid.axes.map(axis=>Math.hypot(...axis)/(range.grid.coordinateUnit==='bohr'?1:BOHR_TO_ANGSTROM)),estimated:range.estimated}:null;
  return <><InputSettingsCheckbox label="显示计算范围" checked={checked} onChange={onChange} disabled={disabled}/>{checked&&range&&<output className="analysis-grid-summary" aria-label="计算范围信息">{range.estimated?'预计范围':'实际范围'} / Å：{range.grid.axes.map((axis,i)=>Number((Math.hypot(...axis)*(range.grid.dimensions[i]-1)*(range.grid.coordinateUnit==='bohr'?BOHR_TO_ANGSTROM:1)).toPrecision(4))).join(' × ')}</output>}{range&&<SpatialGridSummary preview={range.estimated?grid:null} actual={!range.estimated?grid:null}/>}</>;
}
