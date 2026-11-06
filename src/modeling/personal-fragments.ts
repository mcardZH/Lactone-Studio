import type { ClipboardPayload, FragmentSnapshot } from './contracts';
import { createCopiedFragmentSeed } from '../core/modeling/copied-fragment';
import { newModelId } from '../core/modeling/hydrogen-policy';
import { getElementPreset, type ElementPreset } from '../core/modeling/element-presets';
import { emptyPersonalFragmentLibrary, validatePersonalFragmentLibrary as validateLibraryShape, validatePersonalFragmentTemplate as validateTemplateShape, serializePersonalFragmentLibrary as serializeLibraryShape, type PersonalFragmentLibraryData, type PersonalFragmentTemplate } from '../../desktop/personal-fragments-schema.mjs';
export { emptyPersonalFragmentLibrary };
export type { PersonalFragmentLibraryData, PersonalFragmentTemplate };
export interface PersonalFragmentSnapshot { library:PersonalFragmentLibraryData;version:string;writable:boolean;error?:string }
export interface PersonalFragmentStoreAPI { read():Promise<PersonalFragmentSnapshot>;update(value:{baseVersion:string;library:PersonalFragmentLibraryData}):Promise<PersonalFragmentSnapshot> }
export interface PersonalFragmentCapture {payload:ClipboardPayload;activeIndex:number}
export type PersonalFragmentImportResult={cancelled:true}|{cancelled:false;library:unknown};
export interface PersonalFragmentExportResult {cancelled:boolean}
const pick = <T extends object,K extends keyof T>(value:T, keys:readonly K[]):Pick<T,K> => Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])) as Pick<T,K>;
// Capture only public catalog identities. Arbitrary historical source tags are
// still omitted by the existing geometry-only privacy boundary.
function publicPreset(id:unknown):ElementPreset|undefined { if(typeof id!=='string')return;try{return getElementPreset(id);}catch{return;} }
function assertNamedGeometry(template:PersonalFragmentTemplate):void {
  for(const atom of template.atoms)if(atom.geometryPresetId){const preset=getElementPreset(atom.geometryPresetId);if(preset.element!==atom.element)throw new Error('个人片段几何预设与元素不一致。');}
  const occupied=new Set<string>();
  for(const port of template.ports)if(port.presetId){
    const preset=getElementPreset(port.presetId),slot=preset.slots.find(item=>item.id===port.slotId);
    if(!slot||slot.fill!=='open'||slot.order!==port.order)throw new Error('个人片段命名槽位与几何预设不一致。');
    const key=JSON.stringify([port.hostAtomId,port.slotId]);if(occupied.has(key))throw new Error('个人片段命名槽位重复。');occupied.add(key);
  }
}
// Host JSON validation owns bounded shapes/identities; the domain additionally
// binds optional named metadata to the current public geometry catalog.
export function validatePersonalFragmentTemplate(value:unknown):PersonalFragmentTemplate { const template=validateTemplateShape(value);assertNamedGeometry(template);return template; }
export function validatePersonalFragmentLibrary(value:unknown):PersonalFragmentLibraryData { const library=validateLibraryShape(value);for(const template of library.fragments)assertNamedGeometry(template);return library; }
export function serializePersonalFragmentLibrary(value:unknown):string { return serializeLibraryShape(validatePersonalFragmentLibrary(value)); }

/** The caller must explicitly copy the selected/whole fragment first. We
 * validate that snapshot, retain all real H/XYZ/graph/configuration and ports,
 * then deliberately omit source paths, assignments, constraints and history.
 * Canonical local IDs do not claim to be original document atom identities. */
export function createPersonalFragment(payload:ClipboardPayload, options:{name:string;category:string;activeIndex?:number;id?:string}):PersonalFragmentTemplate {
  if(payload.fragment?.structure?.atoms?.some(atom=>['isotope','mass','massNumber'].some(key=>Object.hasOwn(atom,key))))throw new Error('当前原子契约未支持指定同位素/质量，不能静默丢弃。');
  const seed=createCopiedFragmentSeed(payload,options.activeIndex??0),s=seed.fragment.structure;
  if(s.dimension!==3||s.cell||(s.bonds??[]).some(b=>b.image?.some(Boolean)))throw new Error('个人片段仅保存真实非周期3D片段；不丢弃晶胞或跨盒键。');
  // Ordered-neighbour parity uses lexicographic stable IDs. Match old and new
  // ID ordering without changing atom order/XYZ or rewriting parity/wedges.
  const oldIds=s.atoms.map(atom=>atom.id!).sort(),localIds=s.atoms.map((_,i)=>'a'+i).sort();
  const map=new Map(oldIds.map((id,i)=>[id,localIds[i]]));
  const atoms=s.atoms.map(atom=>{const preset=publicPreset(atom.geometryPresetId);if(preset&&preset.element!==atom.element)throw new Error('个人片段几何预设与元素不一致。');return{...pick(atom,['element','x','y','z','formalCharge','stereoParity','hydrogenMode','aromaticHydrogen']),id:map.get(atom.id!)!,...(preset?{geometryPresetId:preset.id}:{})};});
  const template=validatePersonalFragmentTemplate({id:options.id??newModelId(),name:options.name.trim(),category:options.category.trim(),activeIndex:seed.activeIndex,
    atoms,
    bonds:(s.bonds??[]).map(bond=>pick(bond,['a','b','order','aromatic','stereo','kind','fractional','perception','mbo'])),
    ports:(seed.fragment.attachmentPorts??[]).map((port,i)=>{const preset=publicPreset(port.presetId);return{...pick(port,['direction','order','displayLength']),id:'p'+i,hostAtomId:map.get(port.hostAtomId)!,...(preset?{presetId:preset.id,slotId:port.slotId}:{})};}),
  });
  return template;
}
export function personalFragmentClipboard(value:PersonalFragmentTemplate):ClipboardPayload {
  const template=validatePersonalFragmentTemplate(value);
  const fragment:FragmentSnapshot={structure:{id:'personal:'+template.id,name:template.name,format:'个人片段',dimension:3,charge:null,multiplicity:null,notes:[],atoms:template.atoms,bonds:template.bonds,bondSource:'file'},
    assignments:{layers:[],basis:[],fragments:[],frozenAtomIds:[]},auxiliaryRelations:[],deletedBonds:[],internalCoordinates:[],attachmentPorts:template.ports};
  const payload:ClipboardPayload={schema:'sciyue-model-fragment',version:1,sourceDocumentId:'personal:'+template.id,fragment};
  createCopiedFragmentSeed(payload,template.activeIndex);return payload;
}
export function personalFragmentSeed(value:PersonalFragmentTemplate,activeIndex=value.activeIndex){return createCopiedFragmentSeed(personalFragmentClipboard(value),activeIndex);}
export function capturedPersonalFragment(value:PersonalFragmentCapture,options:{name:string;category:string;id?:string}):PersonalFragmentTemplate {
  return createPersonalFragment(value.payload,{...options,activeIndex:value.activeIndex});
}
/** Categories are retained independently of their final card. Legacy v1 files
 * need no migration: their fragment categories remain visible until next save. */
export function personalFragmentCategories(value:PersonalFragmentLibraryData):string[] {
  const library=validatePersonalFragmentLibrary(value);
  return [...new Set([...(library.categories??[]),...library.fragments.map(item=>item.category)])];
}
export function personalFragmentNameConflict(library:PersonalFragmentLibraryData,item:Pick<PersonalFragmentTemplate,'name'|'category'>):PersonalFragmentTemplate|undefined {
  return library.fragments.find(row=>row.category.trim()===item.category.trim()&&row.name.trim()===item.name.trim());
}
/** Same-name replacement must carry the exact identity shown to the user.
 * No model store or builtin catalog is reachable from these transitions. */
export function savePersonalFragment(library:PersonalFragmentLibraryData,item:PersonalFragmentTemplate,replaceId?:string):PersonalFragmentLibraryData {
  const current=validatePersonalFragmentLibrary(library),candidate=validatePersonalFragmentTemplate(item),conflict=personalFragmentNameConflict(current,candidate);
  if(conflict&&conflict.id!==replaceId)throw new Error('此分类下已有同名片段，请改名另存或明确替换。');
  if(replaceId&&(!conflict||conflict.id!==replaceId))throw new Error('待替换片段已变化，请重新确认分类和名称。');
  const fragments=replaceId?current.fragments.map(row=>row.id===replaceId?{...candidate,id:replaceId}:row):[...current.fragments,candidate];
  return validatePersonalFragmentLibrary({...current,categories:[...new Set([...personalFragmentCategories(current),candidate.category])],fragments});
}
export function deletePersonalFragment(library:PersonalFragmentLibraryData,id:string):PersonalFragmentLibraryData {
  const current=validatePersonalFragmentLibrary(library);
  if(!current.fragments.some(item=>item.id===id))throw new Error('个人片段已变化，请重新读取后删除。');
  return validatePersonalFragmentLibrary({...current,categories:personalFragmentCategories(current),fragments:current.fragments.filter(item=>item.id!==id)});
}
export function importPersonalFragments(current:PersonalFragmentLibraryData,incoming:unknown):PersonalFragmentLibraryData {
  const base=validatePersonalFragmentLibrary(current),add=validatePersonalFragmentLibrary(incoming);
  const ids=new Set(base.fragments.map(item=>item.id));
  if(add.fragments.some(item=>ids.has(item.id)))throw new Error('已有相同个人片段ID，未覆盖；请选择不冲突的库，或删除明确的旧项后重试。');
  const categories=base.categories||add.categories?{categories:[...new Set([...personalFragmentCategories(base),...personalFragmentCategories(add)])]}:{};
  return validatePersonalFragmentLibrary({...base,...categories,fragments:[...base.fragments,...add.fragments]});
}
