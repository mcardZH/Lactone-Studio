import type { Atom, Bond } from '../src/core/types';
import type { AttachmentPort } from '../src/modeling/contracts';
export interface PersonalFragmentTemplate {
  id: string; name: string; category: string; activeIndex: number;
  atoms: Pick<Atom, 'id'|'element'|'x'|'y'|'z'|'formalCharge'|'stereoParity'|'hydrogenMode'|'aromaticHydrogen'|'geometryPresetId'>[];
  bonds: Pick<Bond,'a'|'b'|'order'|'aromatic'|'stereo'|'kind'|'fractional'|'perception'|'mbo'>[];
  ports: Pick<AttachmentPort,'id'|'hostAtomId'|'direction'|'order'|'displayLength'|'presetId'|'slotId'>[];
}
export interface PersonalFragmentLibraryData { schema:'sciyue-personal-fragments';version:1;fragments:PersonalFragmentTemplate[];categories?:string[] }
export const PERSONAL_FRAGMENT_LIMITS: Readonly<{bytes:number;fragments:number;atoms:number;totalAtoms:number;bonds:number;ports:number}>;
export function validatePersonalFragmentTemplate(value:unknown):PersonalFragmentTemplate;
export function validatePersonalFragmentLibrary(value:unknown):PersonalFragmentLibraryData;
export function emptyPersonalFragmentLibrary():PersonalFragmentLibraryData;
export function serializePersonalFragmentLibrary(value:unknown):string;
