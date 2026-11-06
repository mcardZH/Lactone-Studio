import {DismissibleNotice} from '../DismissibleNotice';
import {useEffect,useRef,useState} from 'react';
import type {DisplaySettings} from '../../modeling/contracts';
import {STRUCTURE_APPEARANCE_PRESETS} from '../../modeling/appearance-presets';
import {applyStructureAppearanceSnapshot,captureStructureAppearance,readModelDisplayPreferences,writeModelDisplayPreferences,restoreModelDisplayPreferences,type ModelDisplayPreferencesSnapshot} from '../../modeling/platform/display-preferences';

export interface DisplayPresetControlsProps {
  snapshot?: ModelDisplayPreferencesSnapshot | null;
  busy?: boolean;
  status?: string;
  error?: string;
  onSave?(): void;
  onRestore?(): void;
  display?:DisplaySettings;
  onDisplayChange?(display:DisplaySettings):void;
}

/** Shared Settings actions. Persistence is explicit and remains owned by the
 * caller's Global display state; rendering or changing props never saves. */
function NamedDisplayPresetControls({display,onDisplayChange}:Required<Pick<DisplayPresetControlsProps,'display'|'onDisplayChange'>>) {
  const [local,setLocal]=useState<ModelDisplayPreferencesSnapshot|null>(null),[pending,setPending]=useState(false),[notice,setNotice]=useState(''),[name,setName]=useState(''),[naming,setNaming]=useState(false),[overwrite,setOverwrite]=useState(false),[selectedName,setSelectedName]=useState(''),alive=useRef(true);
  useEffect(()=>{alive.current=true;if(display)void readModelDisplayPreferences().then(value=>{if(alive.current)setLocal(value);}).catch(cause=>{if(alive.current)setNotice(String(cause));});return()=>{alive.current=false;};},[Boolean(display)]);
    const current=local?.namedPresets??[],existing=current.find(item=>item.name===name.trim());
    const activeName=current.some(item=>item.name===selectedName&&JSON.stringify(item.appearance)===JSON.stringify(captureStructureAppearance(display)))?selectedName:'';
    const persist=async(kind:'named'|'default'|'restore')=>{
      if(!local?.writable||pending)return;
      const trimmed=name.trim();
      if(kind==='named'&&(!trimmed||trimmed.length>80)){setNotice('请填写1–80字符的预设名称。');return;}
      if(kind==='named'&&STRUCTURE_APPEARANCE_PRESETS.some(item=>item.label===trimmed)){setNotice('内置预设为只读，请使用其他名称。');return;}
      if(kind==='named'&&existing&&!overwrite){setNotice('同名预设已存在，请明确勾选覆盖或修改名称。');return;}
      setPending(true);setNotice('');
      try{
        const desired=kind==='named'?[...current.filter(item=>item.name!==trimmed),{name:trimmed,appearance:captureStructureAppearance(display)}]:undefined;
        const next=kind==='restore'?await restoreModelDisplayPreferences(local):await writeModelDisplayPreferences(local,kind==='named'?local.display:display,undefined,undefined,desired);
        if(alive.current){setLocal(next);setNotice(kind==='named'?'已保存结构外观预设；启动默认保持不变。':kind==='default'?'已设为后续工作区的启动默认，已打开对象保持不变。':'已恢复内置启动默认，当前显示保持不变。');if(kind==='named'){setNaming(false);setOverwrite(false);setSelectedName(trimmed);}}
      }catch(cause){if(alive.current)setNotice(cause instanceof Error?cause.message:String(cause));}finally{if(alive.current)setPending(false);}
    };
    return <div className="model-display-default-controls" data-testid="model-display-default-controls" data-loaded={!!local} data-writable={!!local?.writable} aria-busy={pending}>
      <label>我的预设<select aria-label="我的结构预设" value={activeName} disabled={pending||!current.length} onChange={event=>{const item=current.find(row=>row.name===event.currentTarget.value);if(item){setSelectedName(item.name);onDisplayChange(applyStructureAppearanceSnapshot(display,item.appearance));}}}><option value="">选择已保存预设</option>{current.map(item=><option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      <button type="button" disabled={!local?.writable||pending} onClick={()=>{setNaming(!naming);setOverwrite(false);}}>保存为预设…</button>
      {naming&&<div className="settings-preset-name"><label>预设名称<input aria-label="结构预设名称" maxLength={80} value={name} onChange={event=>{setName(event.currentTarget.value);setOverwrite(false);}}/></label>{existing&&<label><input type="checkbox" checked={overwrite} onChange={event=>setOverwrite(event.currentTarget.checked)}/>覆盖同名预设</label>}<button type="button" disabled={pending} onClick={()=>void persist('named')}>保存</button></div>}
      <button type="button" data-testid="model-save-display-default" disabled={!local?.writable||pending} onClick={()=>void persist('default')}>设为启动默认</button>
      <button type="button" data-testid="model-restore-display-default" disabled={!local?.writable||pending} onClick={()=>void persist('restore')}>恢复内置启动默认</button>
      <button type="button" disabled={pending} onClick={()=>{void readModelDisplayPreferences().then(value=>{if(alive.current)setLocal(value);}).catch(cause=>{if(alive.current)setNotice(String(cause));});}}>重新读取已保存预设</button>
      {!local&&<span role="status">正在读取已保存预设…</span>}
      {(notice||local?.error)&&<span role="status">{notice||local?.error}</span>}
    </div>;
}
export default function DisplayPresetControls(props:DisplayPresetControlsProps){
  if(props.display&&props.onDisplayChange)return <NamedDisplayPresetControls display={props.display} onDisplayChange={props.onDisplayChange}/>;
  const {snapshot,busy=false,status,error,onSave,onRestore}=props;
  const failure = error || snapshot?.error;
  return <div className="model-display-default-controls" data-testid="model-display-default-controls" data-loaded={Boolean(snapshot)} data-writable={Boolean(snapshot?.writable)} aria-busy={busy}>
    <button type="button" data-testid="model-save-display-default" disabled={!snapshot?.writable || busy} onClick={onSave}>保存为预设</button>
    {onRestore && <button type="button" data-testid="model-restore-display-default" disabled={!snapshot?.writable || busy} onClick={onRestore}>恢复内置显示</button>}
    {!snapshot && !failure && <span role="status">正在读取显示预设…</span>}
    {status && <span role="status">{status}</span>}
    {failure && <DismissibleNotice role="alert">{failure}</DismissibleNotice>}
  </div>;
}
