import { DEFAULT_BACKGROUND_COLOR } from './display-settings';

/** Interface defaults are presentation only; never materialize them in a model. */
export function interfaceCanvasBackgroundColor(theme:string|undefined,analysis=false):string {
  return analysis?DEFAULT_BACKGROUND_COLOR:theme==='mint'?'#fbfefb':'#ffffff';
}
export function viewportDefaultBackgroundColor(container:HTMLElement):string {
  // Dedicated export/thumbnail renderers retain their fixed default contract.
  if(!container.closest?.('.model-viewport'))return DEFAULT_BACKGROUND_COLOR;
  return interfaceCanvasBackgroundColor(container.ownerDocument.documentElement?.dataset.interfaceTheme,
    container.closest('[data-module]')?.getAttribute('data-module')==='analysis');
}
export function workspaceDefaultBackgroundColor(owner:Document):string {
  return interfaceCanvasBackgroundColor(owner.documentElement?.dataset.interfaceTheme,
    owner.querySelector?.('.sciyue-workspace-v18[data-module]')?.getAttribute('data-module')==='analysis');
}
/** Observe only presentation attributes, including module switches in a retained viewport. */
export function observeCanvasBackground(owner:Document,changed:()=>void):()=>void {
  const Observer=owner.defaultView?.MutationObserver;
  if(!Observer||!owner.documentElement)return()=>{};
  const observer=new Observer(changed);
  observer.observe(owner.documentElement,{subtree:true,attributes:true,attributeFilter:['data-interface-theme','data-module']});
  return()=>observer.disconnect();
}
