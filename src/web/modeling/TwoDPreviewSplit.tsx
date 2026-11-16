import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {readTwoDPreviewPreferences,writeTwoDPreviewPreferences} from './two-d-preview-preferences';
import './two-d-preview.css';

export const TWO_D_VERTICAL_CONTENT_HEIGHT=640;
export function twoDPreviewContentExtent(extent:number,vertical:boolean):number {
  return vertical?Math.max(TWO_D_VERTICAL_CONTENT_HEIGHT,extent):extent;
}
export function clampTwoDPreviewRatio(value:number,extent:number,vertical:boolean):number {
  const available=Math.max(1,twoDPreviewContentExtent(extent,vertical)-9),first=vertical?300:Math.min(300,available*.45),second=vertical?240:Math.min(240,available*.4);
  return Math.max(first/available,Math.min(1-second/available,value));
}

/** The divider changes viewport allocation only. It owns no molecular data,
 * editor revision, generation request, or camera state. */
export default function TwoDPreviewSplit(p:{enabled:boolean;preview:ReactNode;children:ReactNode}) {
  const root=useRef<HTMLDivElement>(null),preferenceOwner=useRef<Document|undefined>(typeof document==='undefined'?undefined:document);
  const [ratios,setRatios]=useState(()=>{const stored=readTwoDPreviewPreferences(preferenceOwner.current);return{horizontal:stored.horizontal,vertical:stored.vertical};});
  const [extent,setExtent]=useState({width:0,height:0});
  const vertical=extent.width>0&&extent.width<800;
  const drag=useRef<{pointer:number;start:number;ratio:number;extent:number;vertical:boolean}|null>(null);
  const desiredRatio=vertical?ratios.vertical:ratios.horizontal;
  const contentExtent=twoDPreviewContentExtent(vertical?extent.height:extent.width,vertical);
  const ratio=extent.width&&extent.height?clampTwoDPreviewRatio(desiredRatio,contentExtent,vertical):desiredRatio;
  useLayoutEffect(()=>{const owner=root.current?.ownerDocument;if(!owner)return;preferenceOwner.current=owner;const stored=readTwoDPreviewPreferences(owner);setRatios({horizontal:stored.horizontal,vertical:stored.vertical});},[]);
  useEffect(()=>{
    const element=root.current;if(!element)return;
    const measure=()=>{const box=element.getBoundingClientRect();if(box.width<=0||box.height<=0)return;setExtent(previous=>box.width===previous.width&&box.height===previous.height?previous:{width:box.width,height:box.height});};
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[]);
  const change=(value:number,orientation=vertical)=>{const key=orientation?'vertical':'horizontal',next=clampTwoDPreviewRatio(value,twoDPreviewContentExtent(orientation?extent.height:extent.width,orientation),orientation);writeTwoDPreviewPreferences(preferenceOwner.current,{[key]:next});setRatios(previous=>({...previous,[key]:next}));};
  const stop=()=>{drag.current=null;};
  useEffect(()=>{const owner=root.current?.ownerDocument.defaultView;owner?.addEventListener('blur',stop);return()=>owner?.removeEventListener('blur',stop);},[]);
  const available=Math.max(1,contentExtent-9),firstSize=available*ratio;
  const layout=p.enabled?(vertical?{gridTemplateRows:`${firstSize}px 9px ${available-firstSize}px`}:{gridTemplateColumns:`minmax(0, ${ratio}fr) 9px minmax(0, ${1-ratio}fr)`}):undefined;
  return <div ref={root} className={`two-d-preview-split${p.enabled?' has-preview':''}`} data-testid="two-d-preview-split" data-orientation={vertical?'vertical':'horizontal'} data-content-extent={p.enabled?contentExtent:undefined} style={layout as CSSProperties}>
    <div className="two-d-preview-editing">{p.children}</div>
    <div className="two-d-preview-divider" role="separator" tabIndex={p.enabled?0:-1} hidden={!p.enabled} aria-label="调整二维与三维区域大小" aria-orientation={vertical?'horizontal':'vertical'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio*100)}
      onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();const box=root.current!.getBoundingClientRect();drag.current={pointer:event.pointerId,start:vertical?event.clientY:event.clientX,ratio,extent:twoDPreviewContentExtent(vertical?box.height:box.width,vertical),vertical};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{const active=drag.current;if(!active||active.pointer!==event.pointerId)return;change(active.ratio+((active.vertical?event.clientY:event.clientX)-active.start)/Math.max(1,active.extent-9),active.vertical);}}
      onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
      onKeyDown={event=>{const backward=vertical?'ArrowUp':'ArrowLeft',forward=vertical?'ArrowDown':'ArrowRight';if(event.key!==backward&&event.key!==forward)return;event.preventDefault();event.stopPropagation();change(ratio+(event.key===forward ? .03 : -.03));}}><span/></div>
    <aside className="two-d-preview-region" hidden={!p.enabled}>{p.preview}</aside>
  </div>;
}
