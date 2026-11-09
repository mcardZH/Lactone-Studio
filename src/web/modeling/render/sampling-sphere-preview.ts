import type {SamplingSphereViewportDraft} from '../../../modeling/advanced/sampling-sphere';
import type {ModelDocument} from '../../../modeling/contracts';
import type {SamplingSphereDisplay} from '../../../modeling/view-multiframe';
import {MODEL_HOVER_COLOR} from '../modeling-interaction-policy';

/** Appearance only. The sphere owner still supplies the exact physical centre/radius. */
export const SAMPLING_SPHERE_APPEARANCE=Object.freeze({color:MODEL_HOVER_COLOR,wireframe:true,linewidth:1.1,opacity:.75,clickable:false,hoverable:false});

/** A live radius editor uses the same renderer as retained sampling spheres.
 * A stale/disabled editor cannot leave its former source's envelope behind. */
export function viewportSamplingSphere(document:Pick<ModelDocument,'id'|'revision'>,draft:SamplingSphereViewportDraft|null|undefined,retained?:SamplingSphereDisplay):SamplingSphereDisplay|undefined{
  if(!draft)return retained;
  if(draft.sourceDocumentId!==document.id||draft.sourceRevision!==document.revision||!draft.previewEnabled||draft.disabled||!Number.isFinite(draft.radiusAngstrom)||draft.radiusAngstrom<=0||!draft.centerAngstrom.every(Number.isFinite))return undefined;
  return {centerAngstrom:[...draft.centerAngstrom],radiusAngstrom:draft.radiusAngstrom};
}
