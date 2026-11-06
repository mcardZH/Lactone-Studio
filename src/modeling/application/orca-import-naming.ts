import { cleanStem } from '../../core/naming';
import { orcaTaskStem } from '../../core/orca/naming';
import type { OrcaJobRequest } from '../../core/orca/types';
import type { Structure } from '../../core/types';

export interface OrcaNamingPolicy {
  systemNameTouched: boolean;
  outputNameTouched: boolean;
  titleTouched: boolean;
}

export const orcaImportSystemStem = (name:string):string => cleanStem(name).slice(0,70).replace(/[_.-]+$/g,'') || 'molecule';
/** The web caller supplies its existing catalog label; no duplicate UI catalog. */
export const orcaAutomaticTitle = (system:string,taskLabel:string):string => `${system} - ${taskLabel}`;
const currentSystem = (request:OrcaJobRequest):string => request.systemName ?? orcaImportSystemStem(request.structure?.name ?? 'molecule');
export function hasOrcaAutomaticTitle(request:OrcaJobRequest,taskLabel:string):boolean {
  const system=currentSystem(request);
  return request.title===orcaAutomaticTitle(system,taskLabel)
    || system==='molecule'&&request.settings.task==='optfreq'&&request.title==='Molecule - optimization and frequencies';
}

/** Unknown restored/custom values are conservative. Actual input edits may
 * also mark a value equal to the automatic spelling as touched. */
export function initialOrcaNamingPolicy(current:OrcaJobRequest,taskLabel:string):OrcaNamingPolicy {
  const system=currentSystem(current),source=orcaImportSystemStem(current.structure?.name??'molecule');
  return {
    systemNameTouched:current.systemName!==undefined&&current.systemName!==source,
    outputNameTouched:current.name!==orcaTaskStem(system,current.settings),
    titleTouched:!hasOrcaAutomaticTitle(current,taskLabel),
  };
}

/** Only names are projected. The caller owns the separate real model import;
 * neither structure nor any settings/evidence/confirmation is replaced here. */
export function projectOrcaImportedNaming(current:OrcaJobRequest,nextStructure:Structure,policy:OrcaNamingPolicy,taskLabel:string):OrcaJobRequest {
  const system=currentSystem(current),source=orcaImportSystemStem(current.structure?.name??'molecule');
  const nextSystem=!policy.systemNameTouched&&(current.systemName===undefined||current.systemName===source)
    ? orcaImportSystemStem(nextStructure.name) : system;
  return {
    ...current,
    systemName:nextSystem,
    name:!policy.outputNameTouched&&current.name===orcaTaskStem(system,current.settings)?orcaTaskStem(nextSystem,current.settings):current.name,
    title:!policy.titleTouched&&hasOrcaAutomaticTitle(current,taskLabel)?orcaAutomaticTitle(nextSystem,taskLabel):current.title,
  };
}
