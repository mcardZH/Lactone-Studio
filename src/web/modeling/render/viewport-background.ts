import { DEFAULT_BACKGROUND_COLOR } from './display-settings';

/** Interface defaults are presentation only; never materialize them in a model. */
export function interfaceCanvasBackgroundColor(
  theme: string | undefined,
  analysis = false,
  paradigm?: string,
  backdrop?: string,
): string {
  if (backdrop === 'dark') return '#141922';
  if (backdrop === 'white') return '#ffffff';
  if (paradigm === 'dark-studio') return '#141922';
  return analysis ? DEFAULT_BACKGROUND_COLOR : theme === 'mint' ? '#fbfefb' : '#ffffff';
}
export function viewportDefaultBackgroundColor(container:HTMLElement):string {
  // Dedicated export/thumbnail renderers retain their fixed default contract.
  if(!container.closest?.('.model-viewport'))return DEFAULT_BACKGROUND_COLOR;
  const ds=container.ownerDocument.documentElement?.dataset;
  return interfaceCanvasBackgroundColor(ds?.interfaceTheme,
    container.closest('[data-module]')?.getAttribute('data-module')==='analysis',
    ds?.interfaceParadigm,ds?.viewportBackdrop);
}
export function workspaceDefaultBackgroundColor(owner:Document):string {
  const ds=owner.documentElement?.dataset;
  return interfaceCanvasBackgroundColor(ds?.interfaceTheme,
    owner.querySelector?.('.sciyue-workspace-v18[data-module]')?.getAttribute('data-module')==='analysis',
    ds?.interfaceParadigm,ds?.viewportBackdrop);
}
/** Observe only presentation attributes, including module switches in a retained viewport. */
export function observeCanvasBackground(owner:Document,changed:()=>void):()=>void {
  const Observer=owner.defaultView?.MutationObserver;
  if(!Observer||!owner.documentElement)return()=>{};
  const observer=new Observer(changed);
  observer.observe(owner.documentElement,{subtree:true,attributes:true,attributeFilter:['data-interface-theme','data-interface-paradigm','data-viewport-backdrop','data-module']});
  return()=>observer.disconnect();
}
