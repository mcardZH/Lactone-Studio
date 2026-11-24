import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent,type PointerEvent,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {Atom} from '../../core/types';
import type {DisplaySettings} from '../../modeling/contracts';
import {useDialogSurfaceLifecycle} from '../DialogShell';
import ComputeResourceSettings from '../ComputeResourceSettings';
import MultiwfnPathControl from '../results/MultiwfnPathControl';
import GxtbPathControl from '../results/GxtbPathControl';
import FontSizeControl from '../FontSizeControl';
import {InputSettingsLayout} from '../InputSettingsLayout';
import {InputSettingsStack} from '../InputSettingsFields';
import {useInterfaceFontSize} from '../interface-font-preferences';
import {applicationVersion} from '../../application-version';
import {useInterfaceTheme} from '../interface-theme-preferences';
import InterfaceThemeControl from '../InterfaceThemeControl';
import WorkspaceDisplay from './WorkspaceDisplay';
import {workspaceDefaultBackgroundColor,observeCanvasBackground} from './render/viewport-background';
import WindowsAssociationCard from './WindowsAssociationCard';
import {PlotSettingsPage} from '../results/PlotSettingsPage';
import {plotSettingsHosts,type PlotSettingsConnection} from '../results/plot-settings-host';
import McpConnectionCard from './McpConnectionCard';
import './settings-panel.css';

export type SettingsPage='display'|'plots'|'labels'|'interface'|'resources'|'tools'|'mcp'|'about';
export interface SettingsTarget {
  page:SettingsPage;
}
export interface SettingsNavigationResult {
  status:'selected'|'view-unavailable'|'superseded';
  message?:string;
}
export interface SettingsNavigation {
  target:SettingsTarget;
  isCurrent():boolean;
  complete(result:SettingsNavigationResult):void;
}
export interface SettingsPanelProps{
  onClose():void;display?:DisplaySettings;onDisplayChange?(display:DisplaySettings):void;
  atoms?:readonly Atom[];targetLabel?:string;hasCell?:boolean;showAxes?:boolean;onShowAxesChange?(value:boolean):void;
  initialPage?:SettingsPage;ownerDocument?:Document;extra?:ReactNode;
  navigation?:SettingsNavigation;
  plotEditor?:{category:string; content:ReactNode};
  onKeyDown?(event:KeyboardEvent):void;
}
export const SETTINGS_PAGES=[['display','显示设置'],['plots','绘图设置'],['labels','标注与观察'],['interface','界面'],['resources','计算资源'],['tools','工具与文件'],['mcp','AI 协作 (MCP)'],['about','关于与版本']] as const;
const pages=SETTINGS_PAGES;

export function SettingsAboutCard(){
  return <div className="sy-settings-card" data-testid="lactone-about-card">
    <h3>{applicationVersion.productName} ({applicationVersion.shortName}) · {applicationVersion.modificationNotice.unofficialLabel}</h3>
    <p><strong>修改版标识（遵循 LICENSE.txt 第三条）</strong>：本软件为基于 {applicationVersion.modificationNotice.upstreamName} v{applicationVersion.modificationNotice.upstreamVersion} 改造的<strong>{applicationVersion.modificationNotice.unofficialLabel}</strong>（Unofficial Modified Version）。本版本未获原作者审核、科学验证、支持或商业认可。</p>
    <p><strong>修改版本与修改者</strong>：v{applicationVersion.modificationNotice.modifiedVersion}（基线版本 v{applicationVersion.displayVersion}） · 修改者：{applicationVersion.modificationNotice.modifier}</p>
    <p><strong>对应源码获取地址</strong>：{applicationVersion.modificationNotice.sourceRepository}</p>
    <p><strong>上游来源声明</strong>：源自 {applicationVersion.modificationNotice.upstreamAuthor} 开发的 {applicationVersion.modificationNotice.upstreamName}（官方仓库：{applicationVersion.modificationNotice.upstreamRepository}），完整许可条款见根目录 LICENSE.txt 及 licenses/。</p>
    <p><strong>科研引用（遵循 LICENSE.txt 第四条）</strong>：使用本软件开展研究并发表相关论文时，须按协议在正文中引用原作者的 Ester Studio，并可另外说明使用了本修改版。</p>
  </div>;
}
type Rect={x:number;y:number;width:number;height:number};
type Edge='n'|'s'|'w'|'e'|'nw'|'ne'|'sw'|'se';
const handles:readonly Edge[]=['n','s','w','e','nw','ne','sw','se'];
const memory=new WeakMap<Document,{page:SettingsPage;rect:Rect}>();
const settingsInset=16;
const clamp=(value:number,low:number,high:number)=>Math.max(low,Math.min(value,high));
function fit(rect:Rect,view:Window):Rect{
  const width=Math.min(rect.width,Math.max(1,view.innerWidth-settingsInset*2));
  const height=Math.min(rect.height,Math.max(1,view.innerHeight-settingsInset*2));
  return {width,height,x:clamp(rect.x,settingsInset,view.innerWidth-width-settingsInset),
    y:clamp(rect.y,settingsInset,view.innerHeight-height-settingsInset)};
}
export default function SettingsPanel(p:SettingsPanelProps){
  const owner=p.ownerDocument??document,view=owner.defaultView??window;
  const [page,setPage]=useState<SettingsPage>(p.navigation?.target.page??p.initialPage??memory.get(owner)?.page??'display'),[font,setFont]=useInterfaceFontSize();
  const [connection,setConnection]=useState<PlotSettingsConnection>();
  const [session,setSession]=useState(0);
  const current=useRef<PlotSettingsConnection|undefined>(undefined);
  const slot=useRef<HTMLDivElement>(null);
  const [theme,setTheme]=useInterfaceTheme(owner);
  const [canvasBackground,setCanvasBackground]=useState(()=>workspaceDefaultBackgroundColor(owner));
  useEffect(()=>{const refresh=()=>setCanvasBackground(workspaceDefaultBackgroundColor(owner));refresh();return observeCanvasBackground(owner,refresh);},[owner]);
  const [rect,setRect]=useState(()=>fit(memory.get(owner)?.rect??
    {x:(view.innerWidth-940)/2,y:45,width:940,height:760},view));
  const panel=useRef<HTMLElement>(null);
  const content=useRef<HTMLDivElement>(null);
  const drag=useRef<{id:number;x:number;y:number;rect:Rect;edge?:Edge}|null>(null);
  const close=()=>{const active=current.current;current.current=undefined;active?.close();p.onClose();};
  const keyDown=useDialogSurfaceLifecycle(panel,close,true,false);
  useEffect(()=>{memory.set(owner,{page,rect});},[owner,page,rect]);
  useLayoutEffect(()=>{
    const host={
      connect(next:PlotSettingsConnection){
        current.current?.close();current.current=next;
        setConnection(next);setPage('plots');setSession(value=>value+1);
        return slot.current;
      },
      disconnect(previous:PlotSettingsConnection){
        if(current.current!==previous)return;
        current.current=undefined;setConnection(undefined);
      },
    };
    plotSettingsHosts.set(owner,host);
    return()=>{if(plotSettingsHosts.get(owner)===host)plotSettingsHosts.delete(owner);current.current?.close();};
  },[owner]);
  useEffect(()=>{if(p.initialPage&&!p.navigation)setPage(p.initialPage);},[p.initialPage]);
  useEffect(()=>{
    const resize=()=>setRect(old=>fit(old,view));
    view.addEventListener('resize',resize);return()=>view.removeEventListener('resize',resize);
  },[view]);
  const start=(event:PointerEvent<HTMLElement>,edge?:Edge)=>{
    if(event.button!==0||(event.target as HTMLElement).closest('button'))return;
    drag.current={id:event.pointerId,x:event.clientX,y:event.clientY,rect,edge};
    event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();
  };
  const move=(event:PointerEvent<HTMLElement>)=>{
    const active=drag.current;if(!active||active.id!==event.pointerId)return;
    const {rect:old,edge}=active, dx=event.clientX-active.x,dy=event.clientY-active.y;
    if(!edge){setRect(fit({...old,x:old.x+dx,y:old.y+dy},view));return;}
    const maxX=view.innerWidth-settingsInset,maxY=view.innerHeight-settingsInset;
    const minW=Math.min(340,maxX-settingsInset),minH=Math.min(300,maxY-settingsInset);
    const left=edge.includes('w')?clamp(old.x+dx,settingsInset,old.x+old.width-minW):old.x;
    const top=edge.includes('n')?clamp(old.y+dy,settingsInset,old.y+old.height-minH):old.y;
    const right=edge.includes('e')?clamp(old.x+old.width+dx,left+minW,maxX):old.x+old.width;
    const bottom=edge.includes('s')?clamp(old.y+old.height+dy,top+minH,maxY):old.y+old.height;
    setRect({x:left,y:top,width:right-left,height:bottom-top});
  };
  const stop=(event:PointerEvent<HTMLElement>)=>{if(drag.current?.id===event.pointerId)drag.current=null;};
  const displayAvailable=!!p.display&&!!p.onDisplayChange;
  const linked=p.plotEditor??connection;
  const navigation=p.navigation;
  useLayoutEffect(()=>{
    if(!navigation)return;
    if(!navigation.isCurrent()){navigation.complete({status:'superseded'});return;}
    if(linked){navigation.complete({status:'view-unavailable',message:'请先关闭当前绘图预设编辑。'});return;}
    const target=navigation.target;
    if(page!==target.page){setPage(target.page);return;}
    if(content.current)content.current.scrollTop=0;
    navigation.complete({status:panel.current?.getClientRects().length?'selected':'view-unavailable'});
  },[navigation,linked,page]);
  const model=p.display&&p.onDisplayChange?{display:p.display,onChange:p.onDisplayChange,atoms:p.atoms,showAxes:p.showAxes,onShowAxesChange:p.onShowAxesChange}:undefined;
  return createPortal(<section ref={panel} className="sy-settings-panel ui-control-surface" role="dialog" aria-modal="false"
    aria-label={linked?'绘图预设':'全局设置'} data-plot-editor-dialog={linked?true:undefined} tabIndex={-1}
    style={{left:rect.x,top:rect.y,width:rect.width,height:rect.height}} onKeyDown={event=>{p.onKeyDown?.(event);if(!event.defaultPrevented)keyDown(event);event.stopPropagation();}} onKeyUp={event=>event.stopPropagation()} onPointerDown={event=>event.stopPropagation()}>
    <header className="sy-settings-header" onPointerDown={event=>start(event)} onPointerMove={move}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
      <strong>Settings</strong>{(!linked||p.targetLabel||displayAvailable)&&
        <span className="sy-settings-target">当前工作区：{p.targetLabel??(displayAvailable?'当前模型':'无可用显示目标')}</span>}
      <button type="button" onClick={close} aria-label={linked?'关闭高级绘图设置':'关闭全局设置'}>×</button>
    </header>
    <div className="sy-settings-body"><nav aria-label="设置分类">{pages.map(([id,label])=><button type="button" key={id} aria-selected={id===page} onClick={()=>{navigation?.complete({status:'superseded'});setPage(id);}}>{label}</button>)}</nav>
    <div className="sy-settings-content" ref={content}><InputSettingsLayout>
      {pages.map(([id,label])=><section key={id} hidden={id!==page} aria-label={label}><InputSettingsStack kind="cards"><h2>{label}</h2>
        {(id==='display'||id==='labels')&&(!displayAvailable?<p>当前没有可用显示目标。</p>:<WorkspaceDisplay display={p.display!} onChange={p.onDisplayChange!} atoms={p.atoms??[]} page={id} active={id===page} showAxes={p.showAxes} onShowAxesChange={p.onShowAxesChange} defaultBackgroundColor={canvasBackground} managePresets={false}/>)}
        {id==='plots'&&<PlotSettingsPage connectionKey={session} ownerDocument={owner} model={model}
          category={linked?.category} editing={!!linked} slot={<div ref={slot}>{p.plotEditor?.content}</div>}/>}
        {id==='interface'&&<div className="sy-settings-card settings-interface">
          <div className="settings-interface-theme"><h3>界面配色</h3><InterfaceThemeControl value={theme} onChange={setTheme}/></div>
          <FontSizeControl value={font} onChange={setFont}/>
        </div>}
        {id==='resources'&&<ComputeResourceSettings/>}
        {id==='tools'&&<><section className="sy-settings-card" aria-label="外部程序">
          <h3>外部程序</h3>
          <div className="settings-tool-list"><MultiwfnPathControl showPath/><GxtbPathControl/></div>
        </section>
          {view.sciyueDesktop?.syProject&&<WindowsAssociationCard invoke={view.sciyueDesktop.syProject} active={page==='tools'}/>}</>}
        {id==='mcp'&&<McpConnectionCard desktop={view.sciyueDesktop} active={page==='mcp'}/>}
        {id==='about'&&<SettingsAboutCard/>}
      </InputSettingsStack></section>)}
      {p.extra&&page==='tools'&&p.extra}
    </InputSettingsLayout></div></div><footer className="sy-settings-footer"><span>显示修改即时应用，资源与工具设置需确认。</span><button type="button" onClick={close}>关闭</button></footer>
    {handles.map(edge=><div key={edge} className="sy-settings-resize" data-settings-resize={edge} aria-hidden="true"
      onPointerDown={event=>start(event,edge)} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}/>)}
  </section>,owner.body);
}
