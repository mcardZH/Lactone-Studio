import {validXtbResourceOverride} from '../modeling/resource-preferences';
import {InputSettingsField} from './InputSettingsFields';
import NumericInput from './NumericInput';

export function XtbResourceOverrideField({label,ariaLabel=label,value,disabled,onChange}:{
  label:string;ariaLabel?:string;value?:number;disabled?:boolean;onChange(value:number|undefined):void;
}){
  return <InputSettingsField label={label} controlWidth="number"><NumericInput aria-label={ariaLabel}
    aria-invalid={!validXtbResourceOverride(value)||undefined} disabled={disabled} min={1} step={1} stepper
    value={Number.isFinite(value)?value:''} placeholder="沿全局" onChange={event=>{
      const text=event.currentTarget.value;onChange(text.trim()?Number(text):undefined);
    }}/></InputSettingsField>;
}
