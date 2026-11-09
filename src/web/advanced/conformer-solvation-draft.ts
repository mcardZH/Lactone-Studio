import {conformerSolvationIssue} from '../../modeling/advanced/conformer-solvation';

export interface ConformerSolvationDraft {solvationModel:'none'|'alpb'|'gbsa';solvent:string}
/** This only validates a proposed new conformer run. It never rewrites historical results. */
export function conformerSolvationDraftIssue(method:string,draft:ConformerSolvationDraft):string|undefined {
  return conformerSolvationIssue(method,draft.solvationModel,draft.solvent);
}
