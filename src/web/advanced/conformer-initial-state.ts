import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {AdvancedTaskRecord} from '../../modeling/advanced/contracts';
import {workspaceSourceGeometryKey} from '../modeling/workspace-source-validity';

/** Selection follows scientific geometry, not selection/display revisions or q/M drafts. */
export function conformerInitialGeometrySelected(selected:AdvancedFrameSource|null|undefined,current:AdvancedFrameSource|null|undefined):boolean {
  return Boolean(selected&&current&&workspaceSourceGeometryKey(selected.structure)===workspaceSourceGeometryKey(current.structure));
}

export function conformerInitialCompatible(selected:AdvancedFrameSource|null|undefined,current:AdvancedFrameSource|null|undefined):boolean {
  return Boolean(selected&&current&&selected.structure.atoms.length===current.structure.atoms.length&&current.structure.atoms.every((atom,index)=>atom.element===selected.structure.atoms[index].element));
}

/** Configured cards/scalars are drafts, not retained scientific results. */
export function conformerInitialHasInformation(task:AdvancedTaskRecord|undefined):boolean {
  return Boolean(task&&(task.guessFrames.length||task.runs.some(run=>['queued','running','stopping'].includes(run.status)||run.frames.length>0)||task.mixedSampling?.batches?.some(batch=>batch.cards.some(card=>card.frameIds.length>0))));
}
