import {useEffect,useRef,useState,type ReactNode} from 'react';
import NumericInput from '../NumericInput';
import type {Atom} from '../../core/types';
import type { DisplaySettings } from '../../modeling/contracts';
import {STRUCTURE_APPEARANCE_PRESETS,isSelectableStructureAppearancePreset,applyStructureAppearancePreset,effectiveStructureFinish,effectiveStructureSizing,updateStructureLighting,mixedStructureLighting,updateStructureSizing,STRUCTURE_SIZING_LIMITS} from '../../modeling/appearance-presets';
import {MESH_FINISH_LIMITS} from '../../results/mesh-appearance';
import {appearancePreview} from '../appearance-preview-assets';
import {periodicDisplaySettings} from './render/periodic-display';
import {effectiveBackgroundColor,effectiveBondStyle,effectiveCellStyle,effectiveAxisDisplay,effectiveRotationSpeedPercent,DISPLAY_APPEARANCE_LIMITS} from './render/display-settings';
import ElementColorControls from './ElementColorControls';
import {displayScale,DISPLAY_SCALE_LIMITS} from './structure-display';

let customExpanded=false;
const Card=({title,children}:{title:string;children:ReactNode})=><div className="sy-settings-card"><h3>{title}</h3><div className="sy-settings-fields">{children}</div></div>;
function NumberControl({label,value,min,max,step=.01,onChange,mixed=false}:{label:string;value:number;min:number;max:number;step?:number;mixed?:boolean;onChange(value:number):void}){
  const update=(value:number)=>{if(Number.isFinite(value)&&value>=min&&value<=max)onChange(value);};
  return <label>{label}<input type="range" aria-label={`${label}滑杆`} aria-valuetext={mixed?'混合':undefined} min={min} max={max} step={step} value={value} onChange={event=>update(event.currentTarget.valueAsNumber)}/><NumericInput aria-label={label} aria-valuetext={mixed?'混合':undefined} placeholder={mixed?'混合':undefined} min={min} max={max} step={step} value={mixed?'':value} onChange={event=>update(event.currentTarget.valueAsNumber)}/></label>;
}
type Flag=keyof Pick<DisplaySettings,'atomNumbers'|'elementNames'|'stereochemistry'|'legend'|'regionHighlights'|'regionLabels'|'frozenMarks'|'scanMarks'|'measurementMarks'|'cell'>;
/** Compose field edits synchronously while the runtime acknowledges whole
 * snapshots. An earlier local acknowledgement must not erase a later edit. */
export function createDisplayEditSequence(initial:DisplaySettings){
  let received=initial,latest=initial,pending:DisplaySettings[]=[];
  return{
    receive(display:DisplaySettings){
      if(display===received)return;
      const key=JSON.stringify(display),acknowledged=pending.map(value=>JSON.stringify(value)).lastIndexOf(key);
      // A publication outside the locally submitted prefix is authoritative.
      pending=acknowledged<0?[]:pending.slice(acknowledged+1);
      received=display;latest=pending.at(-1)??display;
    },
    change<K extends keyof DisplaySettings>(key:K,value:DisplaySettings[K]){
      latest={...latest,[key]:value};pending.push(latest);return latest;
    },
  };
}
/** Preserve intermediate text while settings acknowledgements arrive async. */
export function AnnotationFontSizeInput({value,onChange}:{value:number;onChange(value:number):void}){
  const [draft,setDraft]=useState(String(value)),editing=useRef(false);
  useEffect(()=>{if(!editing.current)setDraft(String(value));},[value]);
  const commit=(input:HTMLInputElement)=>{
    if(!input.checkValidity()){input.reportValidity();return false;}
    const next=input.valueAsNumber;
    if(!Number.isInteger(next)||next<8||next>24)return false;
    setDraft(String(next));if(next!==value)onChange(next);return true;
  };
  return <NumericInput aria-label="标注字号" min={8} max={24} step={1} stepper required value={draft}
    onFocus={()=>{editing.current=true;}} onChange={event=>setDraft(event.currentTarget.value)}
    onBlur={event=>{editing.current=false;if(!commit(event.currentTarget))setDraft(String(value));}}
    onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commit(event.currentTarget);}else if(event.key==='Escape'){event.preventDefault();setDraft(String(value));}}}/>;
}
/** Invalid intermediate input remains a local draft; the last valid speed stays active. */
export function parseRotationSpeedDraft(draft:string):number|null{
  const text=draft.trim();if(!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))return null;
  const value=Number(text);return Number.isFinite(value)&&value>0?value:null;
}
export function RotationSpeedInput({value,onChange}:{value:number;onChange(value:number):void}){
  const [draft,setDraft]=useState(String(value)),[invalid,setInvalid]=useState(false),[message,setMessage]=useState(false),editing=useRef(false),dirty=useRef(false);
  useEffect(()=>{if(!editing.current&&!dirty.current){setDraft(String(value));setInvalid(false);}},[value]);
  const commit=(input:HTMLInputElement)=>{
    const next=parseRotationSpeedDraft(input.value),valid=next!==null;
    setInvalid(!valid);setMessage(!valid);
    if(next===null)return;
    dirty.current=false;setDraft(String(next));if(next!==value)onChange(next);
  };
  return <div className="settings-rotation-speed"><label>旋转速度<input type="text" inputMode="decimal" aria-label="旋转速度" aria-invalid={invalid||undefined} aria-describedby={invalid&&message?'settings-rotation-speed-error':undefined} required value={draft}
    onFocus={()=>{editing.current=true;}} onChange={event=>{dirty.current=true;setDraft(event.currentTarget.value);if(invalid&&parseRotationSpeedDraft(event.currentTarget.value)!==null){setInvalid(false);setMessage(false);}}}
    onBlur={event=>{editing.current=false;commit(event.currentTarget);}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();commit(event.currentTarget);}}}/><span>%</span><button type="button" aria-label="恢复旋转速度" onClick={()=>{dirty.current=false;setDraft('100');setInvalid(false);setMessage(false);onChange(100);}}>恢复</button></label>
    {invalid&&message&&<span id="settings-rotation-speed-error" role="alert">请输入正的有限数值。<button type="button" aria-label="关闭旋转速度错误" onClick={()=>setMessage(false)}>×</button></span>}</div>;
}
export default function WorkspaceDisplay({display,onChange,atoms=[],page='display',hasCell,showAxes,onShowAxesChange,presetControls}:{display:DisplaySettings;onChange(display:DisplaySettings):void;atoms?:readonly Atom[];page?:'display'|'labels';hasCell?:boolean;showAxes?:boolean;onShowAxesChange?(value:boolean):void;presetControls?:ReactNode}){
  const [expanded,setExpanded]=useState(customExpanded),[choosing,setChoosing]=useState(false);
  const edits=useRef<ReturnType<typeof createDisplayEditSequence>|null>(null);edits.current??=createDisplayEditSequence(display);edits.current.receive(display);
  const set=<K extends keyof DisplaySettings>(key:K,value:DisplaySettings[K])=>onChange(edits.current!.change(key,value));
  const appearance=(next:DisplaySettings)=>onChange({...next,structurePreset:'custom'});
  const flag=(key:Flag,label:string)=><label key={key}><input type="checkbox" checked={!!display[key]} onChange={event=>set(key,event.currentTarget.checked)}/>{label}</label>;
  const selected=STRUCTURE_APPEARANCE_PRESETS.find(item=>isSelectableStructureAppearancePreset(display.structurePreset)&&item.id===display.structurePreset);
  const mixed=mixedStructureLighting(display),finish=effectiveStructureFinish(display),sizing=effectiveStructureSizing(display),periodic=periodicDisplaySettings(display),cell=effectiveCellStyle(display),axis=effectiveAxisDisplay(display),bond=effectiveBondStyle(display);
  if(page==='labels')return <>
    <Card title="原子与测量标注">{flag('atomNumbers','原子序号')}{flag('elementNames','元素符号')}{flag('stereochemistry','显示立体化学')}{flag('measurementMarks','测量标记')}<label>标注字号<AnnotationFontSizeInput value={display.fontSize} onChange={value=>set('fontSize',value)}/></label></Card>
    <Card title="视图交互"><RotationSpeedInput value={effectiveRotationSpeedPercent(display)} onChange={value=>set('rotationSpeedPercent',value)}/></Card>
    <Card title="区域与约束">{flag('regionHighlights','区域高亮')}{flag('regionLabels','区域标签')}{flag('frozenMarks','冻结标记')}{flag('scanMarks','扫描标记')}</Card>
    <Card title="着色与图例"><label>着色依据<select data-testid="model-color-mode" aria-label="模型着色" value={display.colorMode} onChange={event=>set('colorMode',event.currentTarget.value as DisplaySettings['colorMode'])}>{[['elements','元素本色'],['frozen','冻结设置'],['basis','基组'],['layers','QM/MM'],['fragments','片段']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>{flag('legend','显示图例')}</Card>
    <Card title="动态帧叠合"><label>叠合方式<select aria-label="动态帧叠合" value={display.alignment??'auto'} onChange={event=>set('alignment',event.currentTarget.value as DisplaySettings['alignment'])}><option value="auto">稳定主体（默认）</option><option value="heavy">全部重原子</option><option value="off">关闭</option></select></label><small>只调整观察画面</small></Card>
  </>;
  return <div className="settings-display-pages">
    <div className="sy-settings-card"><div className="sy-settings-fields"><button type="button" aria-expanded={choosing} onClick={()=>setChoosing(!choosing)}>选择预设</button><button type="button" aria-label="结构自定义" aria-expanded={expanded} onClick={()=>{customExpanded=!expanded;setExpanded(!expanded);}}>自定义</button><span aria-label="结构当前预设">{selected?.label??'自定义'}</span></div>
      {choosing&&<div className="appearance-preset-grid" aria-label="结构预设">{STRUCTURE_APPEARANCE_PRESETS.map(item=><button type="button" key={item.id} className="appearance-preset-card" aria-pressed={selected?.id===item.id} onClick={()=>{onChange(applyStructureAppearancePreset(display,item.id));setChoosing(false);}}><img className="appearance-preset-preview" src={appearancePreview('structure',item.id)} alt=""/><span>{item.label}</span></button>)}</div>}
      {presetControls}
    </div>
    <div hidden={!expanded}>
      <Card title="整体显示"><label>模型表示<select aria-label="模型样式" value={display.representation} onChange={event=>appearance({...display,representation:event.currentTarget.value as DisplaySettings['representation']})}><option value="ball-stick">CPK</option><option value="stick">Licorice</option><option value="vdw">VDW</option></select></label><label>画布背景<input type="color" aria-label="画布背景颜色" value={effectiveBackgroundColor(display)} onChange={event=>appearance({...display,backgroundColor:event.currentTarget.value})}/></label><NumberControl label="深度渐淡" value={display.depthFade??0} min={0} max={1} step={.05} onChange={value=>appearance({...display,depthFade:value})}/></Card>
      <Card title="光照">{(['ambient','diffuse'] as const).map(key=><NumberControl key={key} mixed={mixed.includes(key)} label={key==='ambient'?'环境光':'主光强度'} value={finish[key]??(key==='ambient'?.1:.9)} min={MESH_FINISH_LIMITS[key][0]} max={MESH_FINISH_LIMITS[key][1]} onChange={value=>appearance(updateStructureLighting(display,key,value))}/>)}</Card>
      <Card title="材质">{(['specular','exponent'] as const).map(key=><NumberControl key={key} mixed={mixed.includes(key)} label={key==='specular'?'高光强度':'高光锐度'} value={finish[key]} min={MESH_FINISH_LIMITS[key][0]} max={MESH_FINISH_LIMITS[key][1]} step={key==='exponent'?1:.01} onChange={value=>appearance(updateStructureLighting(display,key,value))}/>)}<details><summary>高级轮廓</summary><div className="sy-settings-fields">{(['outline','outlineWidth'] as const).map(key=><NumberControl key={key} label={key==='outline'?'轮廓强度':'轮廓宽度'} value={finish[key]??0} min={0} max={1} onChange={value=>appearance(updateStructureLighting(display,key,value))}/>)}</div></details></Card>
      <Card title="原子"><NumberControl label="整体球倍率" value={displayScale(display.atomScale)} min={DISPLAY_SCALE_LIMITS.min} max={DISPLAY_SCALE_LIMITS.max} step={.05} onChange={value=>appearance({...display,atomScale:value})}/>{(['ballScale','hydrogenBallScale'] as const).map(key=><NumberControl key={key} label={key==='ballScale'?'普通球比例':'氢球比例'} value={sizing[key]} min={STRUCTURE_SIZING_LIMITS[key][0]} max={STRUCTURE_SIZING_LIMITS[key][1]} onChange={value=>appearance(updateStructureSizing(display,key,value))}/>)}<ElementColorControls atoms={atoms} display={display} onChange={appearance} hideAlignment forceCustom/><label><input type="checkbox" checked={!!display.vdwShell} onChange={event=>{if(event.currentTarget.checked)appearance({...display,vdwShell:{color:'#abd9e6',opacity:.26}});else{const {vdwShell:_shell,...next}=display;appearance(next);}}}/>范德华外壳</label>{display.vdwShell&&<><label>外壳颜色<input type="color" value={display.vdwShell.color} onChange={event=>appearance({...display,vdwShell:{...display.vdwShell!,color:event.currentTarget.value}})}/></label><NumberControl label="外壳不透明度" value={display.vdwShell.opacity} min={0} max={1} onChange={value=>appearance({...display,vdwShell:{...display.vdwShell!,opacity:value}})}/></>}</Card>
      <Card title="化学键"><label><input type="checkbox" checked={display.showBonds!==false} onChange={event=>appearance({...display,showBonds:event.currentTarget.checked})}/>显示化学键</label><label>键着色<select value={bond.colorMode} onChange={event=>appearance({...display,bondStyle:{...bond,colorMode:event.currentTarget.value as typeof bond.colorMode}})}><option value="elements">跟随两端元素</option><option value="uniform">统一颜色</option></select></label>{bond.colorMode==='uniform'&&<label>统一键色<input type="color" value={bond.color} onChange={event=>appearance({...display,bondStyle:{...bond,color:event.currentTarget.value}})}/></label>}<NumberControl label="全局键倍率" value={displayScale(display.bondScale)} min={DISPLAY_SCALE_LIMITS.min} max={DISPLAY_SCALE_LIMITS.max} step={.05} onChange={value=>appearance({...display,bondScale:value})}/>{(['bondRadiusAngstrom','bondColorLightening'] as const).map(key=><NumberControl key={key} label={key==='bondRadiusAngstrom'?'键半径 / Å':'键色浅化'} value={sizing[key]} min={STRUCTURE_SIZING_LIMITS[key][0]} max={STRUCTURE_SIZING_LIMITS[key][1]} onChange={value=>appearance(updateStructureSizing(display,key,value))}/>)}</Card>
      <Card title="PBC与晶胞"><fieldset disabled={hasCell===false}><div className="sy-settings-fields">{flag('cell','显示晶胞')}<label>线型<select value={cell.lineStyle} onChange={event=>set('cellStyle',{...cell,lineStyle:event.currentTarget.value as typeof cell.lineStyle})}><option value="solid">实线</option><option value="dashed">虚线</option></select></label><label>晶胞颜色<input type="color" value={cell.color} onChange={event=>set('cellStyle',{...cell,color:event.currentTarget.value})}/></label><NumberControl label="晶胞线宽 / px" value={cell.width} min={DISPLAY_APPEARANCE_LIMITS.cellWidth[0]} max={DISPLAY_APPEARANCE_LIMITS.cellWidth[1]} step={.1} onChange={value=>set('cellStyle',{...cell,width:value})}/><label><input type="checkbox" checked={periodic.showCrossBoxBonds!==false} onChange={event=>set('periodicDisplay',{...periodic,showCrossBoxBonds:event.currentTarget.checked})}/>显示跨盒子的键</label><label>边界连接<select aria-label="周期边界连接样式" value={periodic.boundaryStyle} onChange={event=>set('periodicDisplay',{...periodic,boundaryStyle:event.currentTarget.value as 'thin'|'stubs'})}><option value="stubs">半键连接</option><option value="thin">细线连接</option></select></label><label><input type="checkbox" checked={periodic.images} onChange={event=>set('periodicDisplay',{...periodic,images:event.currentTarget.checked})}/>显示周期镜像</label><label>外扩距离 / Å<NumericInput aria-label="周期镜像外扩距离" min={0} step={.1} disabled={!periodic.images} value={periodic.rangeAngstrom} onChange={event=>{const value=event.currentTarget.valueAsNumber;if(Number.isFinite(value)&&value>=0)set('periodicDisplay',{...periodic,rangeAngstrom:value});}}/></label><label>外围颜色<input aria-label="周期外围颜色" type="color" value={periodic.outerColor} onChange={event=>set('periodicDisplay',{...periodic,outerColor:event.currentTarget.value})}/></label></div></fieldset>{hasCell===false&&<small>当前结构没有晶胞。</small>}</Card>
      <Card title="坐标轴"><label><input type="checkbox" checked={!!showAxes} disabled={!onShowAxesChange} onChange={event=>onShowAxesChange?.(event.currentTarget.checked)}/>显示XYZ坐标轴</label>{(['X','Y','Z'] as const).map(key=><label key={key}>{key}<input type="color" value={axis.colors[key]} onChange={event=>set('axisDisplay',{...axis,colors:{...axis.colors,[key]:event.currentTarget.value}})}/></label>)}{([['lineWidth','轴线宽 / px','axisLineWidth'],['length','轴长度 / px','axisLength'],['fontSize','轴标签字号 / px','axisFontSize']] as const).map(([key,label,limit])=><NumberControl key={key} label={label} value={axis[key]} min={DISPLAY_APPEARANCE_LIMITS[limit][0]} max={DISPLAY_APPEARANCE_LIMITS[limit][1]} step={key==='lineWidth'?.5:1} onChange={value=>set('axisDisplay',{...axis,[key]:value})}/>)}</Card>
    </div>
  </div>;
}
