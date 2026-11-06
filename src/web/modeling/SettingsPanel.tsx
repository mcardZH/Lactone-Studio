import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {Atom} from '../../core/types';
import type {DisplaySettings} from '../../modeling/contracts';
import {useDialogSurfaceLifecycle} from '../DialogShell';
import ComputeResourceSettings from '../ComputeResourceSettings';
import MultiwfnPathControl from '../results/MultiwfnPathControl';
import FontSizeControl from '../FontSizeControl';
import {useInterfaceFontSize} from '../interface-font-preferences';
import WorkspaceDisplay from './WorkspaceDisplay';
import DisplayPresetControls from './DisplayPresetControls';
import WindowsAssociationCard from './WindowsAssociationCard';
import './settings-panel.css';

export type SettingsPage='display'|'labels'|'interface'|'resources'|'tools';
export interface SettingsPanelProps{
  onClose():void;display?:DisplaySettings;onDisplayChange?(display:DisplaySettings):void;
  atoms?:readonly Atom[];targetLabel?:string;hasCell?:boolean;showAxes?:boolean;onShowAxesChange?(value:boolean):void;
  initialPage?:SettingsPage;ownerDocument?:Document;extra?:ReactNode;
}
const pages=[['display','显示设置'],['labels','标注与观察'],['interface','界面'],['resources','计算资源'],['tools','工具与文件']] as const;
const memory:{page:SettingsPage;x?:number;y?:number;width?:number;height?:number}={page:'display'};
export default function SettingsPanel(p:SettingsPanelProps){
  const owner=p.ownerDocument??document,view=owner.defaultView??window;
  const [page,setPage]=useState<SettingsPage>(p.initialPage??memory.page),[font,setFont]=useInterfaceFontSize();
  const [position,setPosition]=useState(()=>({x:Math.max(8,Math.min(memory.x??Math.max(12,(view.innerWidth-860)/2),view.innerWidth-250)),y:Math.max(8,Math.min(memory.y??45,view.innerHeight-150))}));
  const panel=useRef<HTMLElement>(null),drag=useRef<{id:number;x:number;y:number;left:number;top:number}|null>(null);
  const keyDown=useDialogSurfaceLifecycle(panel,p.onClose,true,false);
  useEffect(()=>{memory.page=page;},[page]);
  useEffect(()=>{if(p.initialPage)setPage(p.initialPage);},[p.initialPage]);
  useEffect(()=>{
    const clamp=()=>setPosition(old=>{const rect=panel.current?.getBoundingClientRect();const next={x:Math.max(8,Math.min(old.x,view.innerWidth-Math.min(rect?.width??860,view.innerWidth-16)-8)),y:Math.max(8,Math.min(old.y,view.innerHeight-Math.min(rect?.height??700,view.innerHeight-16)-8))};memory.x=next.x;memory.y=next.y;return next;});
    view.addEventListener('resize',clamp);const node=panel.current,observer=new ResizeObserver(()=>{if(node){memory.width=node.offsetWidth;memory.height=node.offsetHeight;clamp();}});if(node)observer.observe(node);clamp();return()=>{view.removeEventListener('resize',clamp);observer.disconnect();};
  },[view]);
  const displayAvailable=!!p.display&&!!p.onDisplayChange;
  return createPortal(<section ref={panel} className="sy-settings-panel" role="dialog" aria-modal="false" aria-label="全局设置" tabIndex={-1}
    style={{left:position.x,top:position.y,width:memory.width??860,height:memory.height??720}} onKeyDown={event=>{keyDown(event);event.stopPropagation();}} onKeyUp={event=>event.stopPropagation()} onPointerDown={event=>event.stopPropagation()}>
    <header className="sy-settings-header" onPointerDown={event=>{if(event.button!==0||(event.target as HTMLElement).closest('button'))return;drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,left:position.x,top:position.y};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();}}
      onPointerMove={event=>{const current=drag.current;if(!current||current.id!==event.pointerId)return;const rect=panel.current?.getBoundingClientRect();const next={x:Math.max(8,Math.min(current.left+event.clientX-current.x,view.innerWidth-(rect?.width??250)-8)),y:Math.max(8,Math.min(current.top+event.clientY-current.y,view.innerHeight-(rect?.height??150)-8))};memory.x=next.x;memory.y=next.y;setPosition(next);}}
      onPointerUp={event=>{drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}} onPointerCancel={()=>{drag.current=null;}}>
      <strong>Settings</strong><span className="sy-settings-target">当前工作区：{p.targetLabel??(displayAvailable?'当前模型':'无可用显示目标')}</span><button type="button" onClick={p.onClose} aria-label="关闭全局设置">×</button>
    </header>
    <div className="sy-settings-body"><nav aria-label="设置分类">{pages.map(([id,label])=><button type="button" key={id} aria-selected={id===page} onClick={()=>setPage(id)}>{label}</button>)}</nav>
    <div className="sy-settings-content">
      {pages.map(([id,label])=><section key={id} hidden={id!==page} aria-label={label}><h2>{label}</h2>
        {(id==='display'||id==='labels')&&(!displayAvailable?<p>当前没有可用显示目标。</p>:<WorkspaceDisplay display={p.display!} onChange={p.onDisplayChange!} atoms={p.atoms??[]} page={id} hasCell={p.hasCell} showAxes={p.showAxes} onShowAxesChange={p.onShowAxesChange} presetControls={id==='display'?<DisplayPresetControls display={p.display} onDisplayChange={p.onDisplayChange}/>:undefined}/>)}
        {id==='interface'&&<div className="sy-settings-card"><h3>界面字号</h3><FontSizeControl value={font} onChange={setFont}/></div>}
        {id==='resources'&&<ComputeResourceSettings/>}
        {id==='tools'&&<><div className="sy-settings-card"><h3>Multiwfn</h3><MultiwfnPathControl showPath/></div>{view.sciyueDesktop?.syProject&&<WindowsAssociationCard invoke={view.sciyueDesktop.syProject} active={page==='tools'}/>}</>}
      </section>)}
      {p.extra&&page==='tools'&&p.extra}
    </div></div><footer className="sy-settings-footer"><span>显示修改即时应用；资源与工具沿各自确认操作。</span><button type="button" onClick={p.onClose}>关闭</button></footer>
  </section>,owner.body);
}
