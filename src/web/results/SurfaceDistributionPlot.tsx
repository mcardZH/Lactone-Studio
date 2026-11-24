import {useMemo, type ReactNode} from 'react';
import type {SurfaceAreaDistribution, SurfaceFunction} from '../../results/surface-contracts';
import {convertSurfaceMappingValue, SURFACE_FUNCTIONS} from '../../results/surface-field';
import {InputSettingsField, InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsCheckbox} from '../InputSettingsLayout';
import {ScientificPlot} from './ScientificPlot';
import type {PlotFigureRecord} from './scientific-plot-figure';
import type {PlotFigureEdits} from '../../results/scientific-plot-editing';
import {scientificTableText} from './scientific-table';
import {surfaceDisplayUnit, surfaceDistributionSeries, surfaceDistributionSummary, surfaceDistributionTable} from './surface-presentation';
import {settingBool,settingEnum} from './analysis-mcp-settings';
import {objectSchema} from '../mcp/types';
import {ResultsMcpInlinePlotSource} from './results-mcp-context';

type SurfaceDistributionQuantity = 'area' | 'fraction';
interface SurfaceDistributionPlotProps {
  distribution: SurfaceAreaDistribution;
  fn: SurfaceFunction;
  appearanceKey: string;
  analysisId?:string;
  figureRecord: PlotFigureRecord;
  quantity: SurfaceDistributionQuantity;
  smooth: boolean;
  showBins: boolean;
  decimals: number;
  onQuantityChange(value: SurfaceDistributionQuantity): void;
  onUnitChange(value: string): void;
  onSmoothChange(value: boolean): void;
  onShowBinsChange(value: boolean): void;
  children?:ReactNode;
}

const espUnitText: Record<string, string> = {'hartree/e':'Eₕ/e', 'kcal/mol':'kcal mol⁻¹', 'kJ/mol':'kJ mol⁻¹'};

export function surfaceDistributionFigureKey(appearanceKey:string,distribution:SurfaceAreaDistribution) {
  return `${appearanceKey}:${distribution.stamp.analysisId}:${distribution.regionId}`;
}

export function updateSurfaceDistributionFigure(figure:PlotFigureRecord,patch:NonNullable<PlotFigureEdits['histogram']>) {
  figure.replace(previous=>({...previous,histogram:{...previous.histogram,...patch}}));
}

export function SurfaceDistributionPlot(p: SurfaceDistributionPlotProps) {
  const {distribution, fn, quantity, smooth, showBins, decimals} = p;
  const unit = distribution.valueUnit;
  const xUnit = espUnitText[unit] ?? unit;
  const yUnit = quantity === 'area' ? surfaceDisplayUnit(distribution.areaUnit) : '%';
  const series = useMemo(() => surfaceDistributionSeries(distribution, quantity, decimals, {smooth, showBins, showCenters:!showBins}),
    [distribution, quantity, decimals, smooth, showBins]);
  const table = useMemo(() => surfaceDistributionTable(distribution, decimals), [distribution, decimals]);
  const fileName = `Ester-Studio-surface-${fn}-distribution`;
  const figureIdentity = surfaceDistributionFigureKey(p.appearanceKey,distribution);
  const options = [...new Set([unit, ...SURFACE_FUNCTIONS[fn].units])];
  const scale = SURFACE_FUNCTIONS[fn].units.some(value=>value===unit)
    ? convertSurfaceMappingValue(1,fn,SURFACE_FUNCTIONS[fn].atomicUnit,unit) : 1;
  const quantityName = fn === 'esp' ? 'Electrostatic Potential' : 'Average Local Ionization Energy';
  const label = fn === 'esp' ? '表面静电势分布' : '平均局部电离能分布';
  return <>
    <ResultsMcpInlinePlotSource kind="surface-distribution" analysisId={p.analysisId}>
    <ScientificPlot plotStyle="histogram" title={`Surface ${quantityName} Distribution`}
      xLabel={`${quantityName} / ${xUnit}`} yLabel={`Surface Area / ${yUnit}`}
      ariaLabel={label} testId={`surface-${fn}-distribution-plot`}
      appearanceKey={figureIdentity} figureRecord={p.figureRecord} resetKey={figureIdentity} axisContext={quantity} axisTransforms={{x:{scale}}}
      mcpConfiguration={{schema:objectSchema({unit:settingEnum(options),quantity:settingEnum(['area','fraction']),smooth:settingBool,showBins:settingBool}),
        read:()=>({kind:'surface-distribution',unit,quantity,smooth,showBins}),
        apply(values){
          const patch=values as NonNullable<PlotFigureEdits['histogram']>;
          if(patch.unit!==undefined)convertSurfaceMappingValue(1,fn,distribution.valueUnit,patch.unit);
          updateSurfaceDistributionFigure(p.figureRecord,patch);
        }}}
      series={series} decimals={decimals} pointReadout={{kind:'Bin',xUnit,yUnit}}
      metadata={{source:{stamp:distribution.stamp, regionId:distribution.regionId, sourceLine:distribution.sourceLine}, distribution:{
        binCount:distribution.bins.length,valueUnit:unit, areaUnit:distribution.areaUnit, quantity,
        coveredArea:distribution.coveredArea, denominator:distribution.denominator, smooth, showBins,
      }}}
      toolbar={<InputSettingsRow>
        <InputSettingsField label="横轴单位"><select aria-label={`${label}横轴单位`} value={unit} onChange={event=>p.onUnitChange(event.currentTarget.value)}>
          {options.map(option=><option key={option} value={option}>{option}</option>)}
        </select></InputSettingsField>
        <InputSettingsField label="纵轴"><select aria-label="表面分布纵轴" value={quantity}
          onChange={event=>p.onQuantityChange(event.currentTarget.value as SurfaceDistributionQuantity)}>
          <option value="area">面积</option><option value="fraction">面积占比</option>
        </select></InputSettingsField>
        <InputSettingsCheckbox label="平滑曲线" checked={smooth} onChange={p.onSmoothChange}/>
        <InputSettingsCheckbox label="显示原始分箱" checked={showBins} onChange={p.onShowBinsChange}/>
      </InputSettingsRow>}
      exportFileName={fileName} exportText={{fileName:`${fileName}.txt`, text:()=>scientificTableText(table)}}/>
    </ResultsMcpInlinePlotSource>
    <p className="postprocess-note">{surfaceDistributionSummary(distribution, decimals)}</p>
    {p.children&&<details className="surface-distribution-data">
      <summary>分箱数据（{distribution.bins.length}）</summary>
      {p.children}
    </details>}
  </>;
}
