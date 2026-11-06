import {useEffect,useLayoutEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import {analysisColorbarGradient,formatAnalysisValue,type AnalysisColorbar} from './analysis-display';
import {moveAnalysisColorbarLayout,normalizeAnalysisColorbarLayout,resizeAnalysisColorbarLayout,resolveAnalysisColorbarRect,type AnalysisColorbarLayout} from './analysis-colorbar-layout';
import './analysis-colorbar.css';

export interface AnalysisColorbarOverlayProps {colorbar:AnalysisColorbar;onLayoutChange?(layout:AnalysisColorbarLayout):void;contextKey?:string}
export default function AnalysisColorbarOverlay({colorbar,onLayoutChange,contextKey=''}:AnalysisColorbarOverlayProps){
  const root=useRef<HTMLElement>(null),[size,setSize]=useState({width:800,height:600}),[draft,setDraft]=useState<AnalysisColorbarLayout|null>(null);
  const values=[formatAnalysisValue(colorbar.min,colorbar.decimals),formatAnalysisValue(colorbar.max,colorbar.decimals)] as const;
  const layout=normalizeAnalysisColorbarLayout(draft??colorbar.layout),rect=resolveAnalysisColorbarRect(layout,size,colorbar.label,1,values);
  const identity=JSON.stringify([contextKey,colorbar.label,colorbar.min,colorbar.max,colorbar.palette,colorbar.reverse,colorbar.colors,colorbar.zeroCentered]);
  const latest=useRef({identity,onLayoutChange});latest.current={identity,onLayoutChange};
  const drag=useRef<{pointerId:number;kind:'move'|'left'|'right';x:number;y:number;layout:AnalysisColorbarLayout;identity:string}|null>(null);
  function cancel(){drag.current=null;setDraft(null);}
  useEffect(()=>{cancel();},[identity]);
  useEffect(()=>{cancel();},[colorbar.layout?.x,colorbar.layout?.y,colorbar.layout?.length]);
  useLayoutEffect(()=>{
    const parent=root.current?.parentElement;if(!parent)return;
    const measure=()=>{const bounds=parent.getBoundingClientRect();if(bounds.width>0&&bounds.height>0)setSize(previous=>previous.width===bounds.width&&previous.height===bounds.height?previous:{width:bounds.width,height:bounds.height});};
    measure();const win=parent.ownerDocument.defaultView,Observer=win?.ResizeObserver,observer=Observer?new Observer(()=>{cancel();measure();}):null;
    observer?.observe(parent);win?.addEventListener('blur',cancel);return()=>{observer?.disconnect();win?.removeEventListener('blur',cancel);};
  },[]);
  function begin(event:ReactPointerEvent<HTMLElement>,kind:'move'|'left'|'right'){
    if(!onLayoutChange||event.button!==0)return;event.preventDefault();event.stopPropagation();
    const effective={...layout,x:(rect.left+rect.width/2)/size.width,y:(rect.top+rect.height/2)/size.height,length:rect.width/size.width};
    drag.current={pointerId:event.pointerId,kind,x:event.clientX,y:event.clientY,layout:effective,identity};event.currentTarget.setPointerCapture(event.pointerId);
  }
  function next(event:ReactPointerEvent<HTMLElement>){const own=drag.current;if(!own||own.pointerId!==event.pointerId||own.identity!==latest.current.identity)return null;return own.kind==='move'?moveAnalysisColorbarLayout(own.layout,{x:event.clientX-own.x,y:event.clientY-own.y},size):resizeAnalysisColorbarLayout(own.layout,(event.clientX-own.x)*(own.kind==='left'?-1:1),size.width);}
  function move(event:ReactPointerEvent<HTMLElement>){event.stopPropagation();const value=next(event);if(value)setDraft(value);}
  function end(event:ReactPointerEvent<HTMLElement>){event.stopPropagation();const value=next(event);drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);setDraft(null);if(value)latest.current.onLayoutChange?.(value);}
  function key(event:React.KeyboardEvent<HTMLElement>,kind:'move'|'left'|'right'){
    event.stopPropagation();if(event.key==='Escape'){event.preventDefault();cancel();return;}
    if(!onLayoutChange||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();
    const step=event.shiftKey ? .05 : .01,dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
    const effective={...layout,x:(rect.left+rect.width/2)/size.width,y:(rect.top+rect.height/2)/size.height,length:rect.width/size.width};
    onLayoutChange(kind==='move'?moveAnalysisColorbarLayout(effective,{x:dx*size.width,y:dy*size.height},size):resizeAnalysisColorbarLayout(effective,((kind==='left'?-dx:dx)||-dy)*size.width/2,size.width));
  }
  const gestureProps={onPointerMove:move,onPointerUp:end,onPointerCancel:(event:ReactPointerEvent<HTMLElement>)=>{event.stopPropagation();cancel();},onLostPointerCapture:(event:ReactPointerEvent<HTMLElement>)=>{event.stopPropagation();cancel();}};
  return <section ref={root} className="result-analysis-colorbar" data-testid="result-analysis-colorbar" data-interactive={Boolean(onLayoutChange)} data-editing={Boolean(draft)} aria-label={colorbar.label+'色标'}
    style={{left:rect.left,top:rect.top,width:rect.width,height:rect.height,fontSize:rect.fontSize,pointerEvents:onLayoutChange?'auto':'none'}}
    onPointerDown={event=>event.stopPropagation()} onWheel={event=>event.stopPropagation()} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape')cancel();}} onKeyUp={event=>event.stopPropagation()}>
    <div className="analysis-colorbar-title" style={{left:rect.padding,top:rect.padding,right:rect.padding,lineHeight:rect.lineHeight}}>
      {onLayoutChange?<button type="button" aria-label="移动色标" title="拖动位置；方向键微调" onPointerDown={event=>begin(event,'move')} onKeyDown={event=>key(event,'move')} {...gestureProps}>{rect.labelLines.map((line,index)=><span key={index}>{line||'\u00a0'}</span>)}</button>:rect.labelLines.map((line,index)=><span key={index}>{line||'\u00a0'}</span>)}
    </div>
    <span className="analysis-colorbar-gradient" style={{left:rect.padding,right:rect.padding,top:rect.barTop,height:rect.barHeight,background:analysisColorbarGradient(colorbar)}}/>
    <div className="analysis-colorbar-values" style={{left:rect.padding,right:rect.padding,top:rect.valuesTop,lineHeight:rect.lineHeight,flexDirection:rect.valueRows===2?'column':'row',gap:rect.valueRows===2?0:8}}><span>{values[0]}</span><span style={rect.valueRows===2?{alignSelf:'flex-end'}:undefined}>{values[1]}</span></div>
    {onLayoutChange&&(['left','right'] as const).map(side=><button key={side} type="button" className={`analysis-colorbar-resize analysis-colorbar-resize-${side}`} data-export-exclude="true" aria-label={`调整色标长度（${side==='left'?'左端':'右端'}）`} title="以中心固定对称调整长度；方向键微调" style={{top:rect.barTop-5}} onPointerDown={event=>begin(event,side)} onKeyDown={event=>key(event,side)} {...gestureProps}><span aria-hidden="true">↔</span></button>)}
  </section>;
}
