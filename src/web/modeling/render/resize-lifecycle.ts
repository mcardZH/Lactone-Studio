/** CSS jitter below a physical pixel must not reallocate a WebGL backbuffer. */
export function physicalViewportSize(width:number,height:number,ratio=1){
 if(![width,height,ratio].every(Number.isFinite)||width<=0||height<=0||ratio<=0)return null;
 return{width:Math.max(1,Math.floor(width*ratio)),height:Math.max(1,Math.floor(height*ratio))};
}
export function samePhysicalViewportSize(a:ReturnType<typeof physicalViewportSize>,b:ReturnType<typeof physicalViewportSize>){return a!==null&&b!==null&&a.width===b.width&&a.height===b.height;}
export const VIEWPORT_LAYOUT_RESIZE_EVENT='sciyue-layout-resize';
/** DOM-local lease: does not enter workspace/scientific state or cross windows. */
export function publishViewportLayoutResize(node:HTMLElement,active:boolean){
 if(node.dataset.layoutResizing===String(active))return;
 node.dataset.layoutResizing=String(active);
 const EventClass=node.ownerDocument.defaultView?.Event??Event;
 node.dispatchEvent(new EventClass(VIEWPORT_LAYOUT_RESIZE_EVENT));
}
/** A toolbar divider is a sibling of the deck, so its physical workspace is
 * the lease owner. Portalled controls outside that workspace are not claimed. */
export function createLayoutResizeBoundary(root:HTMLElement,schedule:(run:()=>void)=>number,cancelFrame:(id:number)=>void){
 const pointers=new Set<number>();let frame:number|null=null;
 const cancelRelease=()=>{if(frame!==null)cancelFrame(frame);frame=null;};
 const release=()=>{cancelRelease();frame=schedule(()=>{frame=null;if(!pointers.size)publishViewportLayoutResize(root,false);});};
 return{
  begin(event:Pick<PointerEvent,'button'|'pointerId'|'target'>){
   const target=event.target as Element|null,separator=target?.closest?.('[role="separator"]');
   if(event.button!==0||!separator||!root.contains(separator))return false;
   cancelRelease();pointers.add(event.pointerId);publishViewportLayoutResize(root,true);return true;
  },
  end(event:Pick<PointerEvent,'pointerId'>){if(pointers.delete(event.pointerId)&&!pointers.size)release();},
  cancel(){pointers.clear();release();},
  dispose(){pointers.clear();cancelRelease();publishViewportLayoutResize(root,false);},
 };
}

/** RO may deliver several nested layout changes in one frame. Keep one final
 * measurement, and cancel it with the viewport's own lifetime. */
export function createViewportResizeQueue(schedule:(run:()=>void)=>number,cancel:(id:number)=>void,run:()=>void){
 let frame:number|null=null,disposed=false;
 return{
  request(){if(disposed||frame!==null)return;frame=schedule(()=>{frame=null;if(!disposed)run();});},
  dispose(){disposed=true;if(frame!==null)cancel(frame);frame=null;},
 };
}
/** Trailing edge for expensive GPU storage changes. Real pointer picks may
 * flush synchronously; ordinary projection/draw work must not bypass it. */
export function createViewportResizeSettler(schedule:(run:()=>void)=>number,cancel:(id:number)=>void,run:()=>void){
 let timer:number|null=null,disposed=false,after:(()=>void)|undefined;
 const flush=()=>{if(timer===null||disposed)return false;cancel(timer);timer=null;run();const callback=after;after=undefined;callback?.();return true;};
 return{
  pending:()=>timer!==null,
  request(callback?:()=>void){if(disposed)return;if(timer!==null)cancel(timer);after=callback;timer=schedule(flush);},
  flush,
  dispose(){disposed=true;if(timer!==null)cancel(timer);timer=null;after=undefined;},
 };
}
