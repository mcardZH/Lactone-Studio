import NumericInput from '../NumericInput';
import type {DisplaySettings} from '../../modeling/contracts';
import {effectiveStructureSizing,STRUCTURE_SIZING_LIMITS,updateStructureSizing,type StructureSizingAppearance} from '../../modeling/appearance-presets';

/** Same appearance sizing for ordinary, observed and exported structures. */
export default function StructureSizingControls({display,onChange}:{display:DisplaySettings;onChange(value:DisplaySettings):void}){
  const value=effectiveStructureSizing(display),fields=[['ballScale','普通球比例'],['hydrogenBallScale','氢球比例'],['bondRadiusAngstrom','键半径 / Å'],['bondColorLightening','键色浅化']] as const;
  return <details className="structure-sizing-controls"><summary>球棍外观尺寸</summary><div className="model-tools">
    {fields.map(([key,label])=><label key={key}>{label}<NumericInput aria-label={`结构外观${label}`} min={STRUCTURE_SIZING_LIMITS[key][0]} max={STRUCTURE_SIZING_LIMITS[key][1]} step={.01} value={value[key]} onChange={event=>{const next=event.currentTarget.valueAsNumber,[min,max]=STRUCTURE_SIZING_LIMITS[key];if(Number.isFinite(next)&&next>=min&&next<=max)onChange(updateStructureSizing(display,key as keyof StructureSizingAppearance,next));}}/></label>)}
    <button type="button" onClick={()=>{const {structureSizing:_sizing,...next}=display;onChange(next);}}>恢复原尺寸</button>
  </div></details>;
}
