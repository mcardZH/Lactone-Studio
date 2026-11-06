import {createContext,useContext,useLayoutEffect,useRef,type ReactNode,type RefObject} from 'react';

export type TransientLayerId = symbol;
export type TransientDismissReason = 'outside-pointer'|'outside-focus'|'escape'|'scope-change'|'peer-open'|'ancestor-close';
export interface TransientLayerRegistration {
  id?:TransientLayerId;
  trigger:HTMLElement;
  content:HTMLElement;
  parentId?:TransientLayerId|null;
  peerGroup?:string;
  onDismiss(reason:TransientDismissReason):void;
}
interface Layer extends TransientLayerRegistration {id:TransientLayerId;dismissed:boolean;order:number}
interface Gesture {pointerId:number;released:boolean}
const registries=new WeakMap<Document,LayerRegistry>();
const parentContext=createContext<TransientLayerId|null>(null);
function registry(doc:Document){let value=registries.get(doc);if(!value){value=new LayerRegistry(doc);registries.set(doc,value);}return value;}
function pathHas(event:Event,node:HTMLElement){const path=event.composedPath?.()??[];return path.includes(node)||Boolean(event.target&&node.contains(event.target as Node));}
function canvasSurface(event:Event){const target=event.target as Element|null;return Boolean(target?.closest?.('[data-testid="model-interaction-surface"]'));}
function nativeAutoLayers(doc:Document){
  return [...doc.querySelectorAll<HTMLElement>('[popover]')].filter(node=>{
    const kind=node.getAttribute('popover');if(kind!==''&&kind!=='auto')return false;
    try{return node.matches(':popover-open');}catch{return false;}
  }).map(panel=>({panel,trigger:[...doc.querySelectorAll<HTMLElement>('[popovertarget],[aria-controls]')].find(node=>node.getAttribute('popovertarget')===panel.id||(node.getAttribute('aria-controls')??'').split(/\s+/).includes(panel.id))??null}));
}
function fieldHelpLayers(doc:Document){
  return [...doc.querySelectorAll<HTMLElement>('[data-task-help][role="tooltip"]')].filter(node=>Boolean(node.getAttribute('data-task-help'))).map(panel=>({panel,trigger:[...doc.querySelectorAll<HTMLElement>('[aria-describedby]')].find(node=>(node.getAttribute('aria-describedby')??'').split(/\s+/).includes(panel.id))??null}));
}
class LayerRegistry {
  layers=new Map<TransientLayerId,Layer>();
  order=0;owners=0;listening=false;watchingNative=false;
  pending:PointerEvent|null=null;gesture:Gesture|null=null;
  constructor(readonly doc:Document){}
  active(){return [...this.layers.values()].filter(layer=>!layer.dismissed);}
  ancestors(id:TransientLayerId,keep:Set<TransientLayerId>){let next=this.layers.get(id)?.parentId;while(next&&!keep.has(next)){keep.add(next);next=this.layers.get(next)?.parentId;}}
  depth(layer:Layer){const seen=new Set<TransientLayerId>();let id=layer.parentId;while(id&&!seen.has(id)){seen.add(id);id=this.layers.get(id)?.parentId;}return seen.size;}
  close(layer:Layer,reason:TransientDismissReason){if(layer.dismissed)return;layer.dismissed=true;layer.onDismiss(reason);}
  inside(event:Event){
    const keep=new Set<TransientLayerId>(),active=this.active();
    for(const layer of active)if(pathHas(event,layer.trigger)||pathHas(event,layer.content))keep.add(layer.id);
    // Native auto panels keep their existing browser lifetime. Their portal
    // anchor still proves which registered parent owns an inside interaction.
    for(const native of [...nativeAutoLayers(this.doc),...fieldHelpLayers(this.doc)])if(pathHas(event,native.panel)&&native.trigger)for(const layer of active)if(layer.content.contains(native.trigger)||layer.trigger.contains(native.trigger))keep.add(layer.id);
    for(const id of [...keep])this.ancestors(id,keep);
    return keep;
  }
  closeOutside(event:Event,reason:TransientDismissReason){const keep=this.inside(event),outside=this.active().filter(layer=>!keep.has(layer.id)).sort((a,b)=>this.depth(b)-this.depth(a)||b.order-a.order);for(const layer of outside)this.close(layer,reason);return outside.length>0;}
  down=(event:PointerEvent)=>{
    // A new physical press can never inherit the previous dismissal gesture.
    this.gesture=null;this.pending=null;
    const nativeOutside=nativeAutoLayers(this.doc).some(layer=>!pathHas(event,layer.panel)&&!(layer.trigger&&pathHas(event,layer.trigger)));
    const willDismiss=this.active().some(layer=>!this.inside(event).has(layer.id))||nativeOutside;
    if(willDismiss&&event.button===0&&canvasSurface(event))this.pending=event;
    this.closeOutside(event,'outside-pointer');
    queueMicrotask(()=>{if(this.pending===event)this.pending=null;this.sync();});
    this.sync();
  };
  focus=(event:FocusEvent)=>{this.closeOutside(event,'outside-focus');this.sync();};
  key=(event:KeyboardEvent)=>{
    if(event.key!=='Escape'||event.defaultPrevented||event.isComposing)return;
    if(fieldHelpLayers(this.doc).length)return; // Existing help owner consumes its innermost Esc.
    const native=nativeAutoLayers(this.doc).filter(n=>!this.active().some(layer=>layer.content===n.panel));
    if(native.length)return; // Native auto/editor layers keep their own Esc.
    const top=this.active().sort((a,b)=>this.depth(b)-this.depth(a)||b.order-a.order)[0];if(!top)return;
    event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();this.close(top,'escape');this.sync();
  };
  move=(event:PointerEvent)=>{if(this.gesture?.pointerId===event.pointerId&&!this.gesture.released)this.consume(event);};
  up=(event:PointerEvent)=>{if(this.gesture?.pointerId!==event.pointerId)return;this.gesture.released=true;this.consume(event);};
  cancel=(event:PointerEvent)=>{if(this.gesture?.pointerId!==event.pointerId)return;this.consume(event);this.gesture=null;this.sync();};
  click=(event:MouseEvent)=>{
    const id=(event as PointerEvent).pointerId,g=this.gesture;
    if(g?.released&&event.detail>0&&(id===undefined||id===g.pointerId)){this.consume(event);this.gesture=null;this.sync();}
  };
  consume(event:Event){event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();}
  nativeToggle=()=>queueMicrotask(()=>this.sync());
  sync(){
    const needed=this.active().length>0||nativeAutoLayers(this.doc).length>0||this.pending!==null||this.gesture!==null;
    if(needed===this.listening)return;this.listening=needed;
    const method=needed?'addEventListener':'removeEventListener';
    this.doc[method]('pointerdown',this.down as EventListener,true);this.doc[method]('focusin',this.focus as EventListener,true);this.doc[method]('keydown',this.key as EventListener,true);
    this.doc[method]('pointermove',this.move as EventListener,true);this.doc[method]('pointerup',this.up as EventListener,true);this.doc[method]('pointercancel',this.cancel as EventListener,true);this.doc[method]('click',this.click as EventListener,true);
  }
  own(){this.owners++;if(!this.watchingNative){this.watchingNative=true;this.doc.addEventListener('beforetoggle',this.nativeToggle,true);this.doc.addEventListener('toggle',this.nativeToggle,true);}this.sync();return()=>{this.owners--;if(this.owners===0){this.watchingNative=false;this.doc.removeEventListener('beforetoggle',this.nativeToggle,true);this.doc.removeEventListener('toggle',this.nativeToggle,true);this.pending=null;this.gesture=null;}this.sync();};}
  add(input:TransientLayerRegistration){
    const layer:Layer={...input,id:input.id??Symbol('transient-layer'),dismissed:false,order:++this.order};
    if(layer.peerGroup)for(const peer of this.active())if(peer.id!==layer.id&&peer.peerGroup===layer.peerGroup&&peer.parentId===layer.parentId)this.close(peer,'peer-open');
    this.layers.set(layer.id,layer);this.sync();
    return()=>{if(this.layers.get(layer.id)!==layer)return;this.layers.delete(layer.id);for(const child of this.active()){const keep=new Set<TransientLayerId>();this.ancestors(child.id,keep);if(keep.has(layer.id)||child.parentId===layer.id)this.close(child,'ancestor-close');}this.sync();};
  }
}
/** Low-level binding for existing manual/native positioning owners. */
export function registerTransientLayer(input:TransientLayerRegistration):()=>void{
  if(input.content.ownerDocument!==input.trigger.ownerDocument)throw Error('Transient layer and trigger must use the same ownerDocument');
  return registry(input.trigger.ownerDocument).add(input);
}
export function dismissTransientLayers(doc:Document,reason:TransientDismissReason='scope-change'){
  const own=registry(doc);for(const layer of own.active().sort((a,b)=>own.depth(b)-own.depth(a)||b.order-a.order))own.close(layer,reason);
  if(reason==='scope-change')for(const layer of nativeAutoLayers(doc))if(layer.panel.matches('.viewport-image-export-menu,.fragment-library-panel,.personal-fragment-popup'))layer.panel.hidePopover();
  own.sync();
}
/** Only renderer hitTest may claim the pending press as actual blank canvas. */
export function claimTransientCanvasDismiss(event:PointerEvent,empty:boolean):boolean{
  const doc=(event.currentTarget as Node|null)?.ownerDocument??(event.target as Node|null)?.ownerDocument;if(!doc)return false;
  const own=registries.get(doc);if(!own||own.pending!==event)return false;own.pending=null;
  if(!empty){own.sync();return false;}own.gesture={pointerId:event.pointerId,released:false};own.sync();return true;
}
export interface UseTransientLayerOptions {
  open:boolean;
  triggerRef:RefObject<HTMLElement|null>;
  contentRef:RefObject<HTMLElement|null>;
  onDismiss(reason:TransientDismissReason):void;
  parentId?:TransientLayerId|null;
  scopeKey?:unknown;
  layerKey?:unknown;
  peerGroup?:string;
}
export function useTransientLayer(options:UseTransientLayerOptions):TransientLayerId{
  const inherited=useContext(parentContext),id=useRef<TransientLayerId>(Symbol('transient-layer')),latest=useRef(options);latest.current=options;
  const parentId=options.parentId===undefined?inherited:options.parentId,priorScope=useRef({key:options.scopeKey,layerKey:options.layerKey});
  useLayoutEffect(()=>{if(!Object.is(priorScope.current.key,options.scopeKey)&&Object.is(priorScope.current.layerKey,options.layerKey)&&options.open)latest.current.onDismiss('scope-change');priorScope.current={key:options.scopeKey,layerKey:options.layerKey};},[options.scopeKey,options.layerKey,options.open]);
  useLayoutEffect(()=>{
    const trigger=options.triggerRef.current,content=options.contentRef.current;if(!options.open||!trigger||!content)return;
    return registerTransientLayer({id:id.current,trigger,content,parentId,peerGroup:options.peerGroup,onDismiss:reason=>latest.current.onDismiss(reason)});
  },[options.open,options.triggerRef,options.contentRef,parentId,options.layerKey,options.peerGroup]);
  return id.current;
}
export function TransientLayerParent({id,children}:{id:TransientLayerId;children:ReactNode}){return <parentContext.Provider value={id}>{children}</parentContext.Provider>;}
/** Main/independent-window owner supplies document/source/stage, never a frame. */
export function useTransientLayerScope(doc:Document|null|undefined,scopeKey:unknown){
  const previous=useRef<{doc:Document|null|undefined;key:unknown}>({doc,key:scopeKey});
  useLayoutEffect(()=>doc?registry(doc).own():undefined,[doc]);
  useLayoutEffect(()=>{if(doc&&previous.current.doc===doc&&!Object.is(previous.current.key,scopeKey))dismissTransientLayers(doc);previous.current={doc,key:scopeKey};},[doc,scopeKey]);
}
