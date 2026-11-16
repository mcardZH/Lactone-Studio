export interface TwoDPreviewPreferences { enabled:boolean; horizontal:number; vertical:number }
const defaults:TwoDPreviewPreferences={enabled:true,horizontal:.65,vertical:.6};
const byWindow=new WeakMap<Document,TwoDPreviewPreferences>();

/** Presentation preferences belong to the live owning window, never to a
 * molecular source, project, saved file or persistent application profile. */
export function readTwoDPreviewPreferences(owner:Document|undefined):TwoDPreviewPreferences {
  return {...(owner?byWindow.get(owner):undefined)??defaults};
}
export function writeTwoDPreviewPreferences(owner:Document|undefined,patch:Partial<TwoDPreviewPreferences>):TwoDPreviewPreferences {
  const next={...readTwoDPreviewPreferences(owner),...patch};
  if(owner)byWindow.set(owner,next);
  return {...next};
}
