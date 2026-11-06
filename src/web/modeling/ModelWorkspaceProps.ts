import type { Structure } from '../../core/types';
import type { BuilderAssignments, BuilderApplyResult } from '../../core/builder-draft';
import type { ViewerHighlights } from '../../core/display-highlights';

/** Shared model presentation contract, independent of the legacy browser engine. */
export interface ModelWorkspaceBaseProps {
  structure: Structure | null; assignments?: BuilderAssignments; selected?: number[]; onSelect?: (indices:number[])=>void;
  highlights?: ViewerHighlights; onApply:(result:BuilderApplyResult)=>boolean|void; openRequest?:number;
  onDraftChange?:(dirty:boolean)=>void; onCancel?:()=>void; onSelectIds?:(ids:string[])=>void;
  onExtract?:()=>void; onCopied?:(message:string)=>void;
}
