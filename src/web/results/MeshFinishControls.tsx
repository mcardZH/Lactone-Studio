import NumericInput from '../NumericInput';
import { MESH_FINISH_LIMITS, MESH_FINISH_PRESETS, normalizeMeshFinish, type MeshFinishSettings } from '../../results/mesh-appearance';
import './mesh-finish-controls.css';

/** One material editor; callers own Global structure or Local analysis state. */
export default function MeshFinishControls(p:{value?:MeshFinishSettings;onChange(value:MeshFinishSettings):void;onNumericChange?(key:Exclude<keyof MeshFinishSettings,'preset'>,value:number):void;mixedKeys?:readonly (keyof typeof MESH_FINISH_LIMITS)[];labelPrefix?:string;inline?:boolean}) {
  const value=normalizeMeshFinish(p.value), prefix=p.labelPrefix??'科学网格';
  const fields=[{key:'ambient',label:'环境光'},{key:'diffuse',label:'主光强度',aria:'主光强度（漫反射）'},{key:'specular',label:'高光强度'},{key:'exponent',label:'高光锐度'}] as const;
  const numeric=(key:keyof typeof MESH_FINISH_LIMITS,raw:string)=>{
    if(!raw.trim())return;const next=Number(raw),[min,max]=MESH_FINISH_LIMITS[key];
    if(Number.isFinite(next)&&next>=min&&next<=max){if(p.onNumericChange)p.onNumericChange(key,next);else p.onChange({...value,preset:'custom',[key]:next});}
  };
  return <div className={'mesh-finish-controls'+(p.inline?' mesh-finish-inline':'')}><label>材质 <select aria-label={`${prefix}材质`} value={value.preset} onChange={event=>{
    const preset=event.target.value;if(preset==='custom')p.onChange({...value,preset:'custom',ambient:value.ambient??.1,diffuse:value.diffuse??.9});else p.onChange(normalizeMeshFinish({preset}));
  }}>{MESH_FINISH_PRESETS.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}<option value="custom">自定义高光</option></select></label>
    {value.preset==='custom'&&<>{fields.map(field=>{const key=field.key,label='aria' in field?field.aria:field.label,current=value[key]??(key==='ambient'?.1:.9),mixed=p.mixedKeys?.includes(key);return <label className="mesh-finish-numeric" key={key}><span>{field.label}</span>
      <input aria-label={`${prefix}${label}滑杆`} aria-valuetext={mixed?'混合':undefined} type="range" min={MESH_FINISH_LIMITS[key][0]} max={MESH_FINISH_LIMITS[key][1]} step={key==='exponent'?1:.01} value={current} onChange={event=>numeric(key,event.target.value)}/>
      <NumericInput aria-label={`${prefix}${label}`} aria-valuetext={mixed?'混合':undefined} placeholder={mixed?'混合':undefined}  min={MESH_FINISH_LIMITS[key][0]} max={MESH_FINISH_LIMITS[key][1]} step={key==='exponent'?1:.01} value={mixed?'':current} onChange={event=>numeric(key,event.target.value)}/></label>;})}
      {value.outline!==undefined&&<label>描边<NumericInput aria-label={`${prefix}描边`}  min={0} max={1} step={.01} value={value.outline} onChange={event=>{const next=event.currentTarget.valueAsNumber;if(Number.isFinite(next)&&next>=0&&next<=1){if(p.onNumericChange)p.onNumericChange('outline',next);else p.onChange({...value,outline:next});}}}/></label>}
      {(value.outline!==undefined||value.outlineWidth!==undefined)&&<label className="mesh-finish-numeric"><span>轮廓宽度</span>{(['range','number'] as const).map(type=><input key={type} aria-label={`${prefix}轮廓宽度${type==='range'?'滑杆':''}`} type={type} min={0} max={1} step={.01} value={value.outlineWidth??0} onChange={event=>{if(!event.target.value.trim())return;const next=Number(event.target.value);if(Number.isFinite(next)&&next>=0&&next<=1){if(p.onNumericChange)p.onNumericChange('outlineWidth',next);else p.onChange({...value,outlineWidth:next});}}}/>)}</label>}</>}
  </div>;
}
