import {useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {Atom} from '../../core/types';
import type {DisplaySettings} from '../../modeling/contracts';
import {useDialogSurfaceLifecycle} from '../DialogShell';
import ComputeResourceSettings from '../ComputeResourceSettings';
import MultiwfnPathControl from '../results/MultiwfnPathControl';
import FontSizeControl from '../FontSizeControl';
import {useInterfaceFontSize} from '../interface-font-preferences';
import {applicationVersion} from '../../application-version';
import WorkspaceDisplay from './WorkspaceDisplay';
import DisplayPresetControls from './DisplayPresetControls';
import WindowsAssociationCard from './WindowsAssociationCard';
import './settings-panel.css';

export type SettingsPage='display'|'labels'|'interface'|'resources'|'tools'|'about';
export interface SettingsPanelProps{
  onClose():void;display?:DisplaySettings;onDisplayChange?(display:DisplaySettings):void;
  atoms?:readonly Atom[];targetLabel?:string;hasCell?:boolean;showAxes?:boolean;onShowAxesChange?(value:boolean):void;
  initialPage?:SettingsPage;ownerDocument?:Document;extra?:ReactNode;
}
export const SETTINGS_PAGES=[['display','显示设置'],['labels','标注与观察'],['interface','界面'],['resources','计算资源'],['tools','工具与文件'],['about','关于与版本']] as const;
const pages=SETTINGS_PAGES;

export function SettingsAboutCard(){
  return <div className="sy-settings-card" data-testid="lactone-about-card">
    <h3>{applicationVersion.productName} ({applicationVersion.shortName}) · {applicationVersion.modificationNotice.unofficialLabel}</h3>
    <p><strong>修改版标识（遵循 LICENSE.txt 第七条）</strong>：本软件为基于 {applicationVersion.modificationNotice.upstreamName} v{applicationVersion.modificationNotice.upstreamVersion} 改造的<strong>{applicationVersion.modificationNotice.unofficialLabel}</strong>（Unofficial Modified Version）。本版本未获原作者审核、科学验证、支持或商业认可。</p>
    <p><strong>修改版本与修改者</strong>：v{applicationVersion.modificationNotice.modifiedVersion}（基线版本 v{applicationVersion.displayVersion}） · 修改者：{applicationVersion.modificationNotice.modifier}</p>
    <p><strong>对应源码获取地址</strong>：{applicationVersion.modificationNotice.sourceRepository}</p>
    <p><strong>上游来源声明</strong>：源自 {applicationVersion.modificationNotice.upstreamAuthor} 开发的 {applicationVersion.modificationNotice.upstreamName}（官方仓库：{applicationVersion.modificationNotice.upstreamRepository}），完整许可条款见根目录 LICENSE.txt 及 licenses/。</p>
    <p><strong>科研引用（遵循 LICENSE.txt 第八条）</strong>：使用本软件开展研究并发表相关论文时，须按协议在正文中引用原作者的 Ester Studio，并可另外说明使用了本修改版。</p>
  </div>;
}
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
        {id==='about'&&<SettingsAboutCard/>}
      </section>)}
      {p.extra&&page==='tools'&&p.extra}
    </div></div><footer className="sy-settings-footer"><span>显示修改即时应用；资源与工具沿各自确认操作。</span><button type="button" onClick={p.onClose}>关闭</button></footer>
  </section>,owner.body);
}
