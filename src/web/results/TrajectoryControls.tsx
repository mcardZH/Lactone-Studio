import NumericInput from '../NumericInput';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {DismissibleNotice} from '../DismissibleNotice';
import type {PlaybackCollection} from '../../results/playback-collection';
import {TransientLayerParent,useTransientLayer} from '../TransientLayer';
import {createPortal} from 'react-dom';
import type { TrajectoryRange } from '../../results/contracts';
import { playbackRange, type PlaybackDirection, type PlaybackMode } from '../../results/playback';
import type { PreparationSnapshot } from '../../results/prepared-trajectory';

interface PopoverPlacement {left:number;top:number;maxWidth:number;maxHeight:number}
/** Coordinates belong to the summary's document, including independent windows. */
export function trajectoryPopoverPlacement(anchor:Pick<DOMRect,'left'|'right'|'top'|'bottom'>,panel:{width:number;height:number},viewport:{width:number;height:number}):PopoverPlacement{
  const margin=8,maxWidth=Math.max(0,viewport.width-margin*2),maxHeight=Math.max(0,viewport.height-margin*2),width=Math.min(panel.width,maxWidth),height=Math.min(panel.height,maxHeight);
  const left=Math.max(margin,Math.min(anchor.right-width,viewport.width-width-margin)),below=anchor.bottom+5,above=anchor.top-height-5;
  const top=Math.max(margin,Math.min(below+height<=viewport.height-margin?below:above>=margin?above:below,viewport.height-height-margin));
  return{left,top,maxWidth,maxHeight};
}

/** An expanded details owns only its own layer/listeners; hiding keeps its controls mounted. */
export function bindTrajectoryPopover(details:HTMLDetailsElement,panel:HTMLDivElement,native:boolean,update:(position:PopoverPlacement|null,visible:boolean)=>void):()=>void{
  const doc=details.ownerDocument,view=doc.defaultView,anchor=details.querySelector('summary');
  if(!details.open||!view||!anchor)return()=>{};
  let disposed=false;
  const hide=()=>{if(native){if(panel.matches(':popover-open'))panel.hidePopover();}else panel.style.display='none';};
  const locate=()=>{
    if(disposed)return;
    const box=anchor.getBoundingClientRect(),unavailable=!details.isConnected||!panel.isConnected||!details.open||details.closest('[hidden],[inert],[aria-hidden="true"],details:not([open])')||!box.width||!box.height||box.right<=0||box.left>=view.innerWidth||box.bottom<=0||box.top>=view.innerHeight||view.getComputedStyle(anchor).visibility==='hidden';
    if(unavailable){hide();update(null,false);return;}
    if(native){if(!panel.matches(':popover-open'))panel.showPopover();}else{panel.style.display='flex';const style=view.getComputedStyle(details);if(style.font&&panel.style.font!==style.font)panel.style.font=style.font;if(style.color&&panel.style.color!==style.color)panel.style.color=style.color;}
    // Constrain before measuring so oversized content gets a real scroll area.
    panel.style.maxWidth=`${Math.max(0,view.innerWidth-16)}px`;panel.style.maxHeight=`${Math.max(0,view.innerHeight-16)}px`;
    update(trajectoryPopoverPlacement(box,panel.getBoundingClientRect(),{width:view.innerWidth,height:view.innerHeight}),true);
  };
  locate();
  const Resize=view.ResizeObserver,resize=Resize?new Resize(locate):null;resize?.observe(anchor);resize?.observe(panel);
  // Visibility/parent-details changes do not necessarily resize the anchor.
  const Mutation=view.MutationObserver,mutation=Mutation?new Mutation(locate):null;
  for(let owner:HTMLElement|null=details;owner;owner=owner.parentElement)mutation?.observe(owner,{attributes:true,attributeFilter:['hidden','inert','aria-hidden','style','class','open','data-font-size']});
  view.addEventListener('resize',locate);doc.addEventListener('scroll',locate,true);
  return()=>{disposed=true;resize?.disconnect();mutation?.disconnect();view.removeEventListener('resize',locate);doc.removeEventListener('scroll',locate,true);hide();};
}

function TrajectoryDetails({className,title,children}:{className:string;title:string;children:ReactNode}){
  const details=useRef<HTMLDetailsElement>(null),panel=useRef<HTMLDivElement>(null),[open,setOpen]=useState(false),[visible,setVisible]=useState(false);
  const layerId=useTransientLayer({open,triggerRef:details,contentRef:panel,onDismiss:()=>{if(details.current)details.current.open=false;setOpen(false);}});
  const [owner,setOwner]=useState<{doc:Document;host:HTMLElement;native:boolean;font:string;color:string}|null>(null),[position,setPosition]=useState<PopoverPlacement>({left:8,top:8,maxWidth:220,maxHeight:500});
  const resolveOwner=()=>{const node=details.current,popup=panel.current;if(!node||!popup)return;const doc=node.ownerDocument,style=doc.defaultView?.getComputedStyle(node),next={doc,host:node.closest<HTMLElement>('.dialog-backdrop')??doc.body,native:typeof popup.showPopover==='function'&&typeof popup.hidePopover==='function',font:style?.font??'',color:style?.color??''};setOwner(previous=>previous&&previous.doc===next.doc&&previous.host===next.host&&previous.native===next.native&&previous.font===next.font&&previous.color===next.color?previous:next);};
  useLayoutEffect(resolveOwner,[]);
  useLayoutEffect(()=>{const node=details.current,popup=panel.current;if(!owner||!node||!popup||!open)return;return bindTrajectoryPopover(node,popup,owner.native,(next,shown)=>{setVisible(shown);if(next)setPosition(previous=>previous.left===next.left&&previous.top===next.top&&previous.maxWidth===next.maxWidth&&previous.maxHeight===next.maxHeight?previous:next);});},[owner,open]);
  const content=<div ref={panel} className={`trajectory-control-popover ${className}-popover`} popover={owner?.native?'manual':undefined} data-trajectory-popover-mode={owner?.native?'top-layer':'portal'} style={{...position,font:owner&&!owner.native?owner.font||undefined:undefined,color:owner&&!owner.native?owner.color||undefined:undefined,display:owner?.native?undefined:open&&visible?'flex':'none'}}><TransientLayerParent id={layerId}>{children}</TransientLayerParent></div>;
  return <details ref={details} className={className} onToggle={event=>{if(event.target===event.currentTarget){if(event.currentTarget.open)resolveOwner();setOpen(event.currentTarget.open);}}}><summary>{title}</summary>{owner&&!owner.native?createPortal(content,owner.host):content}</details>;
}

export interface TrajectoryControlsProps {
  loadingHost?:HTMLElement|null;
  afterDetails?: ReactNode;
  detailsContent?:ReactNode;
  targets?:PlaybackCollection['targets'];onSeekTarget?(kind:'ts'|'ci'):void;
  preparation?: PreparationSnapshot | null; loading?: boolean; loadCancelled?: boolean; silentLoading?: boolean;
  onSilentLoading?(value: boolean): void; onCancelPreparation?(): void; onPrepare?(): void;
  compact?: boolean;
  previewing?: boolean; previewStartedAt?: number | null; previewCompletedAt?: number | null;
  frameDelayMs?: number; previewFrameDelayMs?: number; onFrameDelay?(value: number): void;
  count: number; index: number; playing: boolean; busy: boolean; disabled?: boolean;
  fps: number; direction: PlaybackDirection; mode: PlaybackMode; range: TrajectoryRange;
  endpointPauseMs?: number; onEndpointPause?(value: number): void;
  onPlay(): void; onPause(): void; onSeek(index: number): void; onStep(direction: PlaybackDirection): void;
  onFps(value: number): void; onDirection(value: PlaybackDirection): void; onMode(value: PlaybackMode): void; onRange(value: TrajectoryRange): void;
}
export default function TrajectoryControls(p: TrajectoryControlsProps) {
  const bounds = p.count?playbackRange(p.range, p.count):{first:0,last:0};
  const effectiveFps=p.previewing&&p.previewFrameDelayMs?1000/p.previewFrameDelayMs:p.frameDelayMs?1000/p.frameDelayMs:p.fps;
  const [fpsDraft,setFpsDraft]=useState(String(effectiveFps)),[fpsInvalid,setFpsInvalid]=useState(false),[fpsDirty,setFpsDirty]=useState(false);
  useEffect(()=>{setFpsDraft(String(effectiveFps));setFpsInvalid(false);setFpsDirty(false);},[effectiveFps]);
  const commitFps=()=>{if(!fpsDirty)return;const value=Number(fpsDraft);if(!fpsDraft.trim()||!Number.isFinite(value)||value<=0||!Number.isFinite(1000/value)){setFpsInvalid(true);return;}setFpsInvalid(false);setFpsDirty(false);p.onFps(value);};
  const sliderCount = Math.max(1, p.count), sliderValue = Math.max(1, Math.min(sliderCount, p.index + 1));
  const effectiveFrameDelayMs = p.previewing ? p.previewFrameDelayMs : p.frameDelayMs;
  const integer = (value: string, max: number) => Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max;
  const completed=p.preparation?.completed??0,total=p.preparation?.total??p.count;
  const elapsedSeconds=(p.preparation?.elapsedMs??0)/1000,seconds=Math.round(elapsedSeconds),measured=p.preparation?.measuredCompleted??completed,time=(value:number)=>`${Math.floor(value/60).toString().padStart(2,'0')}:${(value%60).toString().padStart(2,'0')}`;
  const loading=!p.loading&&!p.loadCancelled&&completed===total?null:<div className="trajectory-load-status" role="status" data-testid="trajectory-load-status">
    {p.loading?<><strong>轨迹载入 · 本批共{total}帧</strong>
      <div className="trajectory-load-progress"><progress aria-label="轨迹载入进度" max={total} value={completed}/><span>{completed} / {total}帧 · {total?Math.floor(completed/total*100):0}%</span></div>
      <span>{p.silentLoading?'静默载入中':completed?`正在预览：第${completed}帧`:'读取、校验与显示准备中'}</span>
      <span>已用：{time(seconds)}　预计剩余：{measured>1?`约${time(Math.round(elapsedSeconds/measured*(total-completed)))}`:'估算中'}</span>
      <div className="trajectory-load-actions"><button onClick={()=>p.onSilentLoading?.(!p.silentLoading)}>{p.silentLoading?'恢复载入预览':'静默载入'}</button><button onClick={p.onCancelPreparation}>取消载入</button></div></>
      :p.preparation?<><span>{p.loadCancelled?'载入未完成，来源已保留':'轨迹尚未载入'} · {completed} / {total}帧</span><button onClick={p.onPrepare}>重新载入</button></>:null}
  </div>;
  return <>{p.preparation&&loading&&(p.loadingHost?createPortal(loading,p.loadingHost):loading)}<div className={`trajectory-controls${p.compact ? ' trajectory-controls-compact' : ''}`} data-testid="trajectory-controls" aria-label="轨迹播放器"
    data-current-frame-index={p.index} data-frame-count={p.count} data-playing={p.playing} data-playback-mode={p.mode}
    data-previewing={p.previewing} data-preview-started-at={p.previewStartedAt ?? undefined} data-preview-completed-at={p.previewCompletedAt ?? undefined}
    data-preview-frame-delay-ms={p.previewFrameDelayMs} data-frame-delay-ms={p.frameDelayMs} data-effective-frame-delay-ms={effectiveFrameDelayMs}>
    <button title="范围首帧" aria-label="范围首帧" disabled={p.disabled} onClick={() => p.onSeek(bounds.first)}>⏮</button>
    <button title="上一帧（按步距）" aria-label="上一帧" disabled={p.disabled} onClick={() => p.onStep(-1)}>‹</button>
    <button className="trajectory-play" aria-label={p.playing ? '暂停' : '播放'} disabled={p.disabled || p.count < 2||!p.playing&&fpsInvalid} onClick={p.playing ? p.onPause : p.onPlay}>{p.playing ? 'Ⅱ' : '▶'}</button>
    <button title="下一帧（按步距）" aria-label="下一帧" disabled={p.disabled} onClick={() => p.onStep(1)}>›</button>
    <button title={p.compact ? '跳到最后一帧' : '范围末帧'} aria-label={p.compact ? '跳到最后一帧' : '范围末帧'} disabled={p.disabled} onClick={() => p.onSeek(p.compact ? p.count - 1 : bounds.last)}>⏭</button>
    <input className={`trajectory-slider${p.count < 2 ? ' trajectory-slider-single' : ''}`} aria-label="轨迹帧滑条" type="range" min={1} max={sliderCount} value={sliderValue} disabled={p.disabled || p.count < 2} onChange={e => p.onSeek(Number(e.target.value) - 1)}/>
    <label className="trajectory-frame-field"><NumericInput aria-label="跳到帧" stepper min={1} max={p.count} value={p.index + 1} disabled={p.disabled} onChange={e => { if (integer(e.target.value, p.count)) p.onSeek(Number(e.target.value) - 1); }}/><span>/ {p.count}</span></label>
    <TrajectoryDetails className="trajectory-playback-options" title="播放详情">
    <label>帧率<NumericInput aria-label="播放FPS" value={fpsDraft} aria-invalid={fpsInvalid||undefined} disabled={p.disabled} onChange={event=>{setFpsDraft(event.target.value);setFpsDirty(true);}} onBlur={commitFps} onKeyDown={event=>{if(event.key==='Enter')commitFps();}}/> FPS</label>
    {fpsInvalid&&<DismissibleNotice role="alert">帧率须为有限正数。</DismissibleNotice>}
    <select aria-label="播放方向" value={p.direction} disabled={p.disabled} onChange={e => p.onDirection(Number(e.target.value) as PlaybackDirection)}><option value={1}>正向</option><option value={-1}>反向</option></select>
    <select aria-label="循环模式" value={p.mode} disabled={p.disabled} onChange={e => p.onMode(e.target.value as PlaybackMode)}><option value="once">单次</option><option value="loop">循环</option><option value="bounce">往返</option></select>
    {p.onEndpointPause && <label>端点停顿 / ms<NumericInput aria-label="端点停顿"  min={0} max={10000} step={100} value={p.endpointPauseMs ?? 0} disabled={p.disabled} onChange={event => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 0 && value <= 10000) p.onEndpointPause?.(value); }}/></label>}
    <TrajectoryDetails className="trajectory-range" title="范围">
      <label>起帧<NumericInput aria-label="范围起帧" stepper min={1} max={p.count} value={p.range.start + 1} disabled={p.disabled} onChange={e => { if (integer(e.target.value, p.count)) p.onRange({ ...p.range, start: Number(e.target.value) - 1 }); }}/></label>
      <label>终帧<NumericInput aria-label="范围终帧" stepper min={1} max={p.count} value={p.range.end + 1} disabled={p.disabled} onChange={e => { if (integer(e.target.value, p.count)) p.onRange({ ...p.range, end: Number(e.target.value) - 1 }); }}/></label>
      <label>步距<NumericInput aria-label="帧步距" stepper min={1} max={p.count} value={p.range.stride} disabled={p.disabled} onChange={e => { if (integer(e.target.value, p.count)) p.onRange({ ...p.range, stride: Number(e.target.value) }); }}/></label>
      <small>顺序由起帧到终帧；反向按此顺序倒放。</small>
    </TrajectoryDetails>
    {p.detailsContent}
    </TrajectoryDetails>
    {(['ts','ci'] as const).map(kind=>p.targets?.[kind]&&<button key={kind} type="button" disabled={p.disabled||!p.targets[kind]?.frameId} title={p.targets[kind]?.reason} onClick={()=>p.onSeekTarget?.(kind)}>跳到 {kind.toUpperCase()}</button>)}
    {p.afterDetails}
    <span className="trajectory-loading" role="status">{p.busy ? '读取中' : ''}</span>
  </div></>;
}
