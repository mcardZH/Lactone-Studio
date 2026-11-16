import {useLayoutEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';

export interface TwoDWindowRect {left:number;top:number;width:number;height:number}
export interface TwoDWindowViewport {width:number;height:number}
export type TwoDWindowResizeDirection='n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'nw';
const preferredRects=new WeakMap<Document,TwoDWindowRect>();
const directions:{direction:TwoDWindowResizeDirection;label:string}[]=[{direction:'n',label:'上边缘'},{direction:'ne',label:'右上角'},{direction:'e',label:'右边缘'},{direction:'se',label:'右下角'},{direction:'s',label:'下边缘'},{direction:'sw',label:'左下角'},{direction:'w',label:'左边缘'},{direction:'nw',label:'左上角'}];
const between=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
// Keep the editor's established 420px usable-height baseline; a genuinely
// shorter host still wins so the dialog and its close control remain on-screen.
function limits(view:TwoDWindowViewport){const width=Math.max(1,view.width),height=Math.max(1,view.height),margin=Math.min(8,width/4,height/4);return{margin,maxWidth:width-margin*2,maxHeight:height-margin*2,minWidth:Math.min(480,width-margin*2),minHeight:Math.min(420,height-margin*2)};}
export function clampTwoDWindowRect(rect:TwoDWindowRect,view:TwoDWindowViewport):TwoDWindowRect {
  const bound=limits(view),width=between(rect.width,bound.minWidth,bound.maxWidth),height=between(rect.height,bound.minHeight,bound.maxHeight);
  return{width,height,left:between(rect.left,bound.margin,view.width-bound.margin-width),top:between(rect.top,bound.margin,view.height-bound.margin-height)};
}
export function resizeTwoDWindowRect(initial:TwoDWindowRect,dx:number,dy:number,direction:TwoDWindowResizeDirection,view:TwoDWindowViewport):TwoDWindowRect {
  const rect=clampTwoDWindowRect(initial,view),bound=limits(view);let left=rect.left,right=rect.left+rect.width,top=rect.top,bottom=rect.top+rect.height;
  if(direction.includes('w'))left=between(left+dx,bound.margin,right-bound.minWidth);
  if(direction.includes('e'))right=between(right+dx,left+bound.minWidth,view.width-bound.margin);
  if(direction.includes('n'))top=between(top+dy,bound.margin,bottom-bound.minHeight);
  if(direction.includes('s'))bottom=between(bottom+dy,top+bound.minHeight,view.height-bound.margin);
  return{left,top,width:right-left,height:bottom-top};
}
export function readTwoDWindowRect(owner:Document):TwoDWindowRect|null {const value=preferredRects.get(owner);return value?{...value}:null;}
export function rememberTwoDWindowRect(owner:Document,rect:TwoDWindowRect){preferredRects.set(owner,{...rect});}

/** Resize the existing dedicated 2D DialogShell only. Molecular editing and
 * preview owners stay mounted and receive their normal size observations. */
export default function TwoDWindowResize({visible}:{visible:boolean}) {
  const anchor=useRef<HTMLSpanElement>(null),panel=useRef<HTMLElement|null>(null),owner=useRef<Document|null>(null);
  const [preferred,setPreferred]=useState<TwoDWindowRect|null>(null),[draft,setDraft]=useState<TwoDWindowRect|null>(null),[viewport,setViewport]=useState<TwoDWindowViewport>({width:0,height:0});
  const gesture=useRef<{pointer:number;x:number;y:number;rect:TwoDWindowRect;direction:TwoDWindowResizeDirection;target:HTMLButtonElement;draft:TwoDWindowRect}|null>(null);
  const cancel=()=>{const active=gesture.current;gesture.current=null;setDraft(null);if(active?.target.hasPointerCapture(active.pointer))active.target.releasePointerCapture(active.pointer);};
  useLayoutEffect(()=>{
    const element=anchor.current?.parentElement,document=element?.ownerDocument,win=document?.defaultView;if(!element||!document||!win)return;
    panel.current=element;owner.current=document;setPreferred(readTwoDWindowRect(document));
    const original={position:element.style.position,left:element.style.left,top:element.style.top,width:element.style.width,height:element.style.height,maxWidth:element.style.maxWidth,maxHeight:element.style.maxHeight,margin:element.style.margin};
    const measure=()=>{cancel();setViewport({width:win.innerWidth,height:win.innerHeight});};measure();
    win.addEventListener('resize',measure);win.addEventListener('blur',cancel);
    return()=>{const active=gesture.current;gesture.current=null;if(active?.target.hasPointerCapture(active.pointer))active.target.releasePointerCapture(active.pointer);win.removeEventListener('resize',measure);win.removeEventListener('blur',cancel);Object.assign(element.style,original);panel.current=null;owner.current=null;};
  },[]);
  useLayoutEffect(()=>{if(!visible)cancel();},[visible]);
  useLayoutEffect(()=>{
    const element=panel.current;if(!element)return;
    const current=draft??preferred;
    if(!current){Object.assign(element.style,{position:'',left:'',top:'',width:'',height:'',maxWidth:'',maxHeight:'',margin:''});return;}
    const rect=clampTwoDWindowRect(current,viewport);
    Object.assign(element.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,maxWidth:'none',maxHeight:'none',margin:'0'});
  },[preferred,draft,viewport]);
  function start(event:ReactPointerEvent<HTMLButtonElement>,direction:TwoDWindowResizeDirection){
    if(event.button!==0||!panel.current||!visible)return;event.preventDefault();event.stopPropagation();
    const rect=panel.current.getBoundingClientRect(),box={left:rect.left,top:rect.top,width:rect.width,height:rect.height};
    gesture.current={pointer:event.pointerId,x:event.clientX,y:event.clientY,rect:box,direction,target:event.currentTarget,draft:box};event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event:ReactPointerEvent<HTMLButtonElement>){const active=gesture.current;if(!active||active.pointer!==event.pointerId)return;event.preventDefault();event.stopPropagation();const next=resizeTwoDWindowRect(active.rect,event.clientX-active.x,event.clientY-active.y,active.direction,viewport);active.draft=next;setDraft(next);}
  function finish(event:ReactPointerEvent<HTMLButtonElement>){const active=gesture.current;if(!active||active.pointer!==event.pointerId)return;move(event);gesture.current=null;setDraft(null);setPreferred(active.draft);if(owner.current)rememberTwoDWindowRect(owner.current,active.draft);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}
  return <><span ref={anchor} hidden aria-hidden="true"/>{directions.map(({direction,label})=><button key={direction} type="button" data-two-d-window-resize data-testid="two-d-window-resize" data-direction={direction} className="two-d-window-resize" aria-label={`调整二维窗口${label}`} tabIndex={visible?0:-1}
    onPointerDown={event=>start(event,direction)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={event=>{if(event.key==='Escape'){if(gesture.current){event.preventDefault();event.stopPropagation();cancel();}return;}const shifts:Record<string,[number,number]>={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]},shift=shifts[event.key];if(!shift||!panel.current||!owner.current)return;event.preventDefault();event.stopPropagation();const box=panel.current.getBoundingClientRect(),next=resizeTwoDWindowRect(box,shift[0],shift[1],direction,viewport);rememberTwoDWindowRect(owner.current,next);setPreferred(next);}} onKeyUp={event=>event.stopPropagation()}/>)}</>;
}
