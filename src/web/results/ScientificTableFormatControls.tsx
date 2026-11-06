import NumericInput from '../NumericInput';
import { resultDecimals } from '../../results/numeric-format';
import type { ScientificTableFormat } from './scientific-table';

/** Controlled per-table display settings; the consumer builds the shared projection. */
export default function ScientificTableFormatControls({format,alwaysVisible=false,unitLabel=''}:{format:ScientificTableFormat;alwaysVisible?:boolean;unitLabel?:string}) {
  if(format.locked&&!alwaysVisible)return null;
  const prefix=format.ariaLabel??'本表';
  return <div className="scientific-table-format">
    <label title="按小数位与有效数字中保留信息较多者显示">精度 {format.locked?<input aria-label={`${prefix}显示精度`} value="来源精度" disabled readOnly/>:<NumericInput stepper min={0} max={8} step={1} aria-label={`${prefix}显示精度`} value={resultDecimals(format.decimals)} onChange={event=>{const value=event.currentTarget.valueAsNumber;if(Number.isInteger(value)&&value>=0&&value<=8)format.onDecimalsChange(value);}}/>}</label>
    {!format.hideUnit&&(!!format.units?.length&&format.onUnitChange||alwaysVisible&&!!unitLabel&&unitLabel!=='dimensionless')&&<label>单位 <select aria-label={`${prefix}显示单位`} disabled={format.locked||!format.units?.length||!format.onUnitChange} value={format.unit??unitLabel} onChange={event=>{if(format.units?.some(unit=>unit.value===event.target.value))format.onUnitChange?.(event.target.value);}}>{format.units?.length?format.units.map(unit=><option key={unit.value} value={unit.value}>{unit.label}</option>):<option value={format.unit??unitLabel}>{format.unit??unitLabel}</option>}</select></label>}
  </div>;
}
