import type {JobRequest} from '../../core/types';
import type {OrcaJobRequest} from '../../core/orca/types';
import {inputStructureSourceIdentity} from '../../core/input-structure-source';
/** Only task-bound sources affect a generated editor's freshness. */
export function linkedInputSourceSignature(request:JobRequest):string|null {
 if(request.settings.task!=='qst2'&&request.settings.task!=='qst3')return null;
 const q=request.settings.qst,slots=[q?.reactantSource,q?.product,...(request.settings.task==='qst3'?[q?.tsGuess]:[])];
 return JSON.stringify(slots.map(source=>source?[source.documentId,(request.inputSources??[]).filter(candidate=>candidate.documentId===source.documentId).map(inputStructureSourceIdentity)]:null));
}
export function linkedOrcaInputSourceSignature(request:OrcaJobRequest):string|null {
 if(request.settings.task!=='neb')return null;
 const n=request.settings.neb,slots=[n.reactantSource,n.productSource,n.tsGuessSource];
 return JSON.stringify(slots.map(source=>source?[source.documentId,(request.inputSources??[]).filter(candidate=>candidate.documentId===source.documentId).map(inputStructureSourceIdentity)]:null));
}
