import type { Structure } from '../../core/types';
import type { ModelDocument } from '../../modeling/contracts';
import type { XtbPreviewFrame } from '../../modeling/xtb/contracts';
import type { XtbState } from '../../modeling/xtb/controller';

/** The visible frame is the single presentation authority; native diagnostics
 * remain in the run state/log without replacing the frame label every second. */
export function xtbOptimizationDisplayStatus(state: XtbState, shownFrame?: XtbPreviewFrame): string {
  if (!state.running || state.operation !== 'optimize') return state.status;
  if (state.phase === 'stopping') return '停止中…';
  if (state.phase === 'bonding') return '更新成键…';
  return shownFrame ? `第 ${shownFrame.step + 1} 帧` : '准备中…';
}

/** Read-only viewport projection. Neither the Store nor its Undo owns a preview. */
export function projectXtbPreview(document: ModelDocument, frame?: XtbPreviewFrame): ModelDocument {
  const atoms=document.draft.structure.atoms;
  if(!frame||frame.stamp.documentId!==document.id||frame.stamp.revision!==document.revision||frame.coordinates.length!==atoms.length)return document;
  if(frame.coordinates.some((point,index)=>point.id!==atoms[index].id||point.element!==atoms[index].element||![point.x,point.y,point.z].every(Number.isFinite)))return document;
  return {...document,draft:{...document.draft,structure:{...document.draft.structure,atoms:atoms.map((atom,index)=>{const point=frame.coordinates[index];return{...atom,x:point.x,y:point.y,z:point.z};})}}};
}

export interface XtbDisplayObservation {
  documentId:string; reference:Structure; epoch:string; frame:number; dynamicEpoch?:string; previewActive:boolean;
}
/** Keep the last display reference after a terminal result. Reverting to an
 * earlier force-field epoch would compose the same alignment a second time. */
export function nextXtbDisplayObservation(previous:XtbDisplayObservation|undefined,document:ModelDocument,preview:XtbPreviewFrame|undefined,reference:Structure|undefined,dynamicEpoch:string|undefined):XtbDisplayObservation|undefined {
  const old=previous?.documentId===document.id&&previous.reference.id===document.draft.structure.id&&previous.dynamicEpoch===dynamicEpoch?previous:undefined;
  if(preview&&reference&&preview.stamp.documentId===document.id&&preview.stamp.revision===document.revision){
    if(old?.epoch===preview.sessionId&&old.frame===preview.seq&&old.previewActive)return old;
    return{documentId:document.id,reference:old?.epoch===preview.sessionId?old.reference:reference,epoch:preview.sessionId,frame:preview.seq,dynamicEpoch,previewActive:true};
  }
  // A final commit or cancellation re-fits the actual authoritative coordinates
  // once, using the same run base; a cancellation thereby restores the old pose.
  return old?.previewActive?{...old,frame:old.frame+1,previewActive:false}:old;
}
