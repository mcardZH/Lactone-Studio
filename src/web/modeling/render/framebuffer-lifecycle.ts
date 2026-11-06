import {physicalViewportSize,samePhysicalViewportSize} from './resize-lifecycle';

/** SpritePlugin creates these directly, outside Renderer._programs leases.
 * The plugin is per renderer even when the actual Offscreen context is shared. */
function releaseSpritePlugin(renderer:any,plugin:any){
 const gl=renderer._gl,sprite=plugin?.sprite;
 if(!sprite||plugin.gl!==gl||!gl||gl.isContextLost?.())return;
 let failure:unknown;
 const release=(action:()=>void)=>{try{action();}catch(error){failure??=error;}};
 if(sprite.vertexBuffer||sprite.elementBuffer){
  // Plugin enables its attributes directly, bypassing the renderer cache.
  // Synchronize that cache before native disable/reset, never delete a live
  // sibling renderer's buffers or force-lose their shared context.
  for(const location of Object.values(sprite.attributes??{}))if(typeof location==='number'&&location>=0){
   if(renderer._enabledAttributes)renderer._enabledAttributes[location]=true;
   else release(()=>gl.disableVertexAttribArray(location));
  }
  release(()=>renderer.disableAttributes?.());renderer._currentGeometryGroupHash=-1;
 }
 const buffers=new Set<any>();
 for(const key of ['vertexBuffer','elementBuffer']){const handle=sprite[key];sprite[key]=null;if(handle&&!buffers.has(handle)){buffers.add(handle);release(()=>gl.deleteBuffer(handle));}}
 const program=sprite.program;sprite.program=null;
 if(program){
  // Unlike buildProgram, locked SpritePlugin also keeps its attached shaders.
  release(()=>{for(const shader of gl.getAttachedShaders?.(program)??[])gl.deleteShader(shader);});
  release(()=>gl.deleteProgram(program));
 }
 if(failure)throw failure;
}

/** Capture only synchronous constructor resize listeners, never user/app
 * listeners. Our container RO is the one sizing authority for owned viewers. */
export function captureNativeResizeListeners<T>(realm:Window,construct:()=>T){
 if(typeof realm.addEventListener!=='function')return{value:construct(),release:()=>{}};
 const descriptor=Object.getOwnPropertyDescriptor(realm,'addEventListener'),original=realm.addEventListener;
 const listeners:{listener:EventListenerOrEventListenerObject;capture:boolean}[]=[];let released=false;
 const release=()=>{if(released)return;released=true;for(const row of listeners)realm.removeEventListener('resize',row.listener,row.capture);};
 Object.defineProperty(realm,'addEventListener',{configurable:true,writable:true,value:function(type:string,listener:EventListenerOrEventListenerObject,options?:boolean|AddEventListenerOptions){original.call(realm,type,listener,options);if(type==='resize')listeners.push({listener,capture:typeof options==='boolean'?options:!!options?.capture});}});
 try{return{value:construct(),release};}catch(error){release();throw error;}finally{if(descriptor)Object.defineProperty(realm,'addEventListener',descriptor);else Reflect.deleteProperty(realm,'addEventListener');}
}

/** Locked 3Dmol 2.5.5 compatibility, scoped to one viewer's renderers.
 *
 * Renderer.setSize calls initFrameBuffer on every call (GLViewer.updateSize
 * calls setSize twice). Upstream overwrites live texture/FBO/VBO handles and
 * increments the three cached screen-program leases. setFrameBuffer already
 * resizes their storage on the next render, so reusing handles is sufficient.
 * Never touch molecule programs, geometries, surfaces, camera or GL version.
 */
export function retainViewerFramebuffers(viewer:any){
 const owned=new Map<any,()=>void>();let disposed=false;
 viewer.divwatcher?.disconnect();viewer.intwatcher?.disconnect();
 if(typeof viewer.getRenderer!=='function')return{dispose(){}};
 function install(renderer:any){
  if(!renderer||owned.has(renderer)||typeof renderer.initFrameBuffer!=='function'||typeof renderer.setSize!=='function')return;
  const initialize=renderer.initFrameBuffer,setSize=renderer.setSize,setFrameBuffer=renderer.setFrameBuffer;
  const spritePlugin=renderer.sprites;
  const initDescriptor=Object.getOwnPropertyDescriptor(renderer,'initFrameBuffer'),sizeDescriptor=Object.getOwnPropertyDescriptor(renderer,'setSize'),frameDescriptor=Object.getOwnPropertyDescriptor(renderer,'setFrameBuffer');
  const textures=['_targetTexture','_depthTexture','_shadingTexture','_scratchTexture'];
  const programs=['_screenshader','_AOshader','_blurshader'];
  const complete=()=>renderer._fb&&renderer._screenQuadVBO&&textures.every(key=>renderer[key])&&programs.every(key=>renderer[key]);
  let size=physicalViewportSize(renderer._canvas?.width??0,renderer._canvas?.height??0);
  let storage:ReturnType<typeof physicalViewportSize>=null;
  const init=function(this:any){
   if(this!==renderer)return initialize.call(this);
   const gl=renderer._gl;
   if(!renderer.isWebGL1()&&complete()&&!gl.isContextLost?.()){
    gl.enable(gl.SCISSOR_TEST);gl.scissor(0,0,renderer._viewportWidth,renderer._viewportHeight);gl.viewport(0,0,renderer._viewportWidth,renderer._viewportHeight);
    return;
   }
   storage=null;return initialize.call(renderer);
  };
  const resize=function(this:any,width:number,height:number){
   if(this!==renderer)return setSize.call(this,width,height);
   const realm=renderer._canvas?.ownerDocument?.defaultView??globalThis;
   let ratio=realm.devicePixelRatio??1;if(renderer._upscale&&ratio<2)ratio=2;
   const next=physicalViewportSize(width,height,ratio),gl=renderer._gl;
   if(next&&samePhysicalViewportSize(size,next)&&renderer._canvas.width===next.width&&renderer._canvas.height===next.height&&!gl?.isContextLost?.()&&(renderer.isWebGL1()||complete())){
    renderer.devicePixelRatio=ratio;
    // CSS coordinates can change within the same physical backbuffer pixel.
    renderer._canvas.style.width=width+'px';renderer._canvas.style.height=height+'px';return;
   }
   const value=setSize.call(renderer,width,height);size=next;return value;
  };
  const frame=function(this:any){
   if(this!==renderer||renderer.isWebGL1()||!complete())return setFrameBuffer.call(this);
   const next=physicalViewportSize(renderer._viewportWidth,renderer._viewportHeight),gl=renderer._gl;
   if(!samePhysicalViewportSize(storage,next)){
    const value=setFrameBuffer.call(renderer);storage=next;return value;
   }
   // The locked method otherwise reallocates RGBA/depth storage and recreates
   // two depth textures on EVERY render. Preserve its binding/depth-clear work
   // while keeping the four same-size allocations alive across ordinary frames.
   gl.enable(gl.SCISSOR_TEST);gl.scissor(0,0,renderer._viewportWidth,renderer._viewportHeight);gl.viewport(0,0,renderer._viewportWidth,renderer._viewportHeight);
   gl.bindFramebuffer(gl.FRAMEBUFFER,renderer._fb);
   gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,renderer._targetTexture,0);
   gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,renderer._shadingTexture,0);
   gl.clearDepth(1);gl.clear(gl.DEPTH_BUFFER_BIT);
   gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.TEXTURE_2D,renderer._depthTexture,0);
  };
  renderer.initFrameBuffer=init;renderer.setSize=resize;if(typeof setFrameBuffer==='function')renderer.setFrameBuffer=frame;
  owned.set(renderer,()=>{
   let failure:unknown;
   const release=(action:()=>void)=>{try{action();}catch(error){failure??=error;}};
   // WebGL objects are context-local; context loss already releases all of
   // them. Do not send old objects to a replacement context or delete twice.
   const gl=renderer._gl;
   if(gl&&!gl.isContextLost?.()){
    const released=new Set<any>();
    for(const key of textures){const handle=renderer[key];if(handle&&!released.has(handle)){release(()=>gl.deleteTexture(handle));released.add(handle);}renderer[key]=null;}
    if(renderer._fb)release(()=>gl.deleteFramebuffer(renderer._fb));renderer._fb=null;
    if(renderer._screenQuadVBO)release(()=>gl.deleteBuffer(renderer._screenQuadVBO));renderer._screenQuadVBO=null;
    // Each distinct screen program owns one upstream reference, shared with
    // any matching material program through upstream's own usedTimes count.
    for(const key of programs){if(renderer[key])release(()=>renderer.deallocateMaterial({program:renderer[key]}));renderer[key]=null;}
   }
   release(()=>releaseSpritePlugin(renderer,spritePlugin));
   if(renderer.initFrameBuffer===init){if(initDescriptor)Object.defineProperty(renderer,'initFrameBuffer',initDescriptor);else delete renderer.initFrameBuffer;}
   if(renderer.setSize===resize){if(sizeDescriptor)Object.defineProperty(renderer,'setSize',sizeDescriptor);else delete renderer.setSize;}
   if(renderer.setFrameBuffer===frame){if(frameDescriptor)Object.defineProperty(renderer,'setFrameBuffer',frameDescriptor);else delete renderer.setFrameBuffer;}
   if(failure)throw failure;
  });
 }
 const originalResize=viewer.resize,resizeDescriptor=Object.getOwnPropertyDescriptor(viewer,'resize');
 const ensure=()=>install(viewer.getRenderer?.());
 ensure();
 // A recovered context can replace GLViewer.renderer during resize. Install
 // the replacement before its next sizing operation, without changing recovery.
 const resize=function(this:any,...args:any[]){ensure();const value=originalResize.apply(this,args);ensure();return value;};
 if(typeof originalResize==='function')viewer.resize=resize;
 return{dispose(){if(disposed)return;disposed=true;let failure:unknown;for(const release of owned.values())try{release();}catch(error){failure??=error;}owned.clear();if(viewer.resize===resize){if(resizeDescriptor)Object.defineProperty(viewer,'resize',resizeDescriptor);else delete viewer.resize;}if(failure)throw failure;}};
}
