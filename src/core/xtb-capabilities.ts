import data from '../data/conformer-solvation.json';

/** One product capability source shared with the desktop and native adapters.
 * The historical filename is retained; physical solvent references are optional
 * display data and are never substituted for the native parameter set. */
export type XtbNativeMethod = keyof typeof data.methodDefinitions;
export type XtbNativeOperation = 'optimize'|'singlepoint'|'md'|'metadynamics'|'wavefunction'|'bond-perception';
export interface XtbAlpbPreset { id:string; label:string; dielectric?:number }
export const XTB_METHOD_IDS = Object.freeze(Object.keys(data.methodDefinitions) as XtbNativeMethod[]);
export const XTB_METHOD_LABELS:Readonly<Record<XtbNativeMethod,string>> = Object.freeze(
  Object.fromEntries(XTB_METHOD_IDS.map(id=>[id,data.methodDefinitions[id].label])) as Record<XtbNativeMethod,string>,
);
export const XTB_ALPB_PRESETS:readonly Readonly<XtbAlpbPreset>[] = Object.freeze(data.presets.map(row=>Object.freeze({
  id:row.id,label:row.label,...('dielectric' in row&&Number.isFinite(row.dielectric)?{dielectric:row.dielectric}:{}),
})));
export function isXtbMethod(method:string):method is XtbNativeMethod { return Object.hasOwn(data.methodDefinitions,method); }
export function xtbMethodCapability(method:string) { return isXtbMethod(method)?data.methodDefinitions[method]:undefined; }
export function supportsXtbOperation(method:string,operation:XtbNativeOperation,periodic=false):boolean {
  const row=xtbMethodCapability(method);if(!row||periodic&&!row.periodic)return false;
  if(operation==='wavefunction')return !periodic&&row.wavefunction;
  if(operation==='bond-perception')return method==='gfn2';
  if(operation==='singlepoint')return method==='gfn2'||method==='gxtb'&&!periodic;
  if(operation==='metadynamics')return !periodic;
  return true;
}
export function usesXtbSccIterations(method:string):boolean { return method==='gfn1'||method==='gfn2'||method==='gxtb'; }
/** GBSA lists identify old settings/results only. New task UIs expose ALPB. */
export function xtbSolvents(method:string,model:'alpb'|'gbsa',periodic=false):readonly string[] {
  if(periodic)return [];
  if(model==='alpb')return data.nativeMethods.includes(method)?data.presets.map(row=>row.id):[];
  return Object.hasOwn(data.legacyGbsaSolvents,method)?data.legacyGbsaSolvents[method as keyof typeof data.legacyGbsaSolvents]:[];
}
export function supportsXtbAlpb(method:string,solvent:string,periodic=false):boolean {
  return !periodic&&data.nativeMethods.includes(method)&&data.presets.some(row=>row.id===solvent);
}
