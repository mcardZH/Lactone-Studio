import type {JobRequest} from '../../core/types';
import type {OrcaJobRequest} from '../../core/orca';
import type {AdvancedInputTemplate} from '../../modeling/application/advanced-frame-output';

/** Snapshot only. No validation repair, electronic confirmation, draft reset,
 * engine switch, model extraction or new input-task ownership is performed. */
export function snapshotAdvancedInputTemplate(p:{hasInputTask:boolean;engine:'gaussian'|'orca';gaussian:JobRequest;orca:OrcaJobRequest}):AdvancedInputTemplate|undefined{
 if(!p.hasInputTask)return;
 return p.engine==='gaussian'?{engine:'gaussian',request:structuredClone(p.gaussian)}:{engine:'orca',request:structuredClone(p.orca)};
}
