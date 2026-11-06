import type { Atom, Vector3, Structure } from '../../core/types';
import type { DisplaySettings, MeasurementRecord, ModelCommand, ModelDocument, ModelSelection, PickResult, ScreenPoint, ScreenRect, SelectionCaptureRequest } from '../../modeling/contracts';
import { geometryGuide, type GeometryGuide } from '../../core/geometry-guides';
import { bondRefKey, centroid, coordinates, measurementGeometryGuide, unionBox } from './render/geometry';
import { coordinateSelectionObjects } from '../../core/modeling/coordinate-selection';
import { modelCoordinateKey } from '../../modeling/constraints';

export interface MeasurementLabel { record: MeasurementRecord; label: string; valueLabel: string; detail: string; x: number; y: number; error?: string }
export type AtomStateAction = 'select-add' | 'select-remove' | 'freeze' | 'unfreeze';
export interface ViewportStateMarker { id: string; kind: 'selection' | 'freeze' | 'scan'; atomIds: readonly string[]; images?:readonly Vector3[]; label?: string; coordinateId?: string; removable?: boolean; inactive?: boolean }

/** A capture owns only this disposable presentation. It never replaces the
 * editable ModelSelection; unknown or repeated stable IDs are discarded. */
export function captureSelectionPresentation(document:ModelDocument,atomIds?:readonly string[]){
  const known=new Set(document.draft.structure.atoms.map(atom=>atom.id));
  const ids=[...new Set(atomIds??[])].filter(id=>known.has(id));
  const markers:ViewportStateMarker[]=ids.map(atomId=>({id:`capture-selection:${atomId}`,kind:'selection',atomIds:[atomId],label:'本次选择'}));
  return {active:atomIds!==undefined,atomIds:ids,markers};
}
/** An active capture replaces only visible selection marks, including when its
 * draft is empty. Frozen/scan marks keep their independent presentation. */
export function captureVisibleStateMarkers(markers:readonly ViewportStateMarker[],capture:ReturnType<typeof captureSelectionPresentation>){
  return capture.active?[...markers.filter(marker=>marker.kind!=='selection'),...capture.markers]:[...markers];
}

/** Dedicated pointer modes own both buttons and never fall through to deletion. */
export function pointerStateAction(mode: 'select' | 'freeze', button: number, freezeRemoval = false): AtomStateAction | null {
  if (button !== 0 && button !== 2) return null;
  return mode === 'select' ? button === 0 ? 'select-add' : 'select-remove' : button === 0 && !freezeRemoval ? 'freeze' : 'unfreeze';
}
/** A held mode owns the complete overlay press, even when its key is released
 * first. Coordinate decorations consume that press without editing atoms. */
export function overlayPointerStateAction(mode: 'select' | 'freeze' | null, button: number, marker?: ViewportStateMarker, freezeRemoval = false): { consumed: boolean; action: AtomStateAction | null } {
  if (!mode) return { consumed: false, action: null };
  const atomic = marker && !('coordinateId' in marker) && marker.atomIds.length === 1 && (marker.kind === 'selection' || marker.kind === 'freeze');
  return { consumed: true, action: atomic ? pointerStateAction(mode, button, freezeRemoval) : null };
}
/** Keyboard activation has detail=0 and owns no preceding pointer gesture. */
export function overlayClickAllowed(press: { pointerMode: 'select' | 'freeze' | null; moved: boolean; valid: boolean } | null, detail: number): boolean {
  return detail === 0 || !press || (press.valid && !press.moved && !press.pointerMode);
}
export function selectionWithAtomState(selection: ModelSelection, atomIds: readonly string[], action: 'select-add' | 'select-remove'): ModelSelection {
  const changed = new Set(atomIds);
  return { ...selection, atomIds: action === 'select-add' ? [...new Set([...selection.atomIds, ...atomIds])] : selection.atomIds.filter(id => !changed.has(id)) };
}
export interface ViewportObjectState { atomIds:string[]; coordinateIds:string[] }
export interface ViewportMarkerAction { consumed:boolean; action:AtomStateAction|null; objects:ViewportObjectState }
/** A claimed coordinate identity owns this press even when it cannot resolve.
 * Unknown observation/stale IDs, empty IDs and mismatched tuples must never
 * fall back to a physical atom action using the decoration's endpoints. */
export function resolveKnownCoordinateMarkerAction(document:ModelDocument,marker:ViewportStateMarker|undefined,mode:'select'|'freeze'|null,button:number,freezeRemoval=false):ViewportMarkerAction {
  const none:ViewportObjectState={atomIds:[],coordinateIds:[]};
  if(!mode)return {consumed:false,action:null,objects:none};
  if(marker&&'coordinateId' in marker){
    const object=typeof marker.coordinateId==='string'&&marker.coordinateId?coordinateSelectionObjects(document).find(object=>object.id===marker.coordinateId):undefined;
    const known=new Set(document.draft.structure.atoms.map(atom=>atom.id));
    if(!object||object.atomIds.some(id=>!known.has(id)))return {consumed:true,action:null,objects:none};
    try{if(modelCoordinateKey(object)!==modelCoordinateKey({type:object.type,atomIds:[...marker.atomIds],images:marker.images?[...marker.images]:undefined}))return {consumed:true,action:null,objects:none};}catch{return {consumed:true,action:null,objects:none};}
    const action=pointerStateAction(mode,button,freezeRemoval);
    return {consumed:true,action,objects:action?{atomIds:[],coordinateIds:[object.id]}:none};
  }
  const result=overlayPointerStateAction(mode,button,marker,freezeRemoval),known=new Set(document.draft.structure.atoms.map(atom=>atom.id));
  const action=result.action&&marker?.atomIds.every(id=>known.has(id))?result.action:null;
  return {...result,action,objects:action&&marker?{atomIds:[...marker.atomIds],coordinateIds:[]}:none};
}
export function stateMarkerObjects(marker:ViewportStateMarker):ViewportObjectState {
  return marker.coordinateId!==undefined?{atomIds:[],coordinateIds:marker.coordinateId?[marker.coordinateId]:[]}:{atomIds:[...marker.atomIds],coordinateIds:[]};
}
/** Backwards-compatible identity port. Capture material/markers travel through
 * their display-only feedback, never a replacement ModelDocument selection. */
export function captureRenderDocument(document:ModelDocument,request:SelectionCaptureRequest|undefined,atomIds:readonly string[]=[]):ModelDocument {
  return document;
}
export function selectionWithCoordinateState(selection:ModelSelection,coordinateIds:readonly string[],action:'select-add'|'select-remove'):ModelSelection {
  const changed=new Set(coordinateIds),previous=selection.coordinateIds??[];
  return {...selection,coordinateIds:action==='select-add'?[...new Set([...previous,...coordinateIds])]:previous.filter(id=>!changed.has(id))};
}
/** Label/coordinate marker modes never turn their tuple into an atom action. */
export function coordinateOverlayPointerAction(mode:'select'|'freeze'|null,button:number,coordinateId?:string,freezeRemoval=false):AtomStateAction|null {
  return mode&&coordinateId?pointerStateAction(mode,button,freezeRemoval):null;
}
/** Anchors use the same projected label positions the user can actually see.
 * Pending auto measurements are not passed as records/selectable identities. */
export function captureBoxCoordinateIds(labels:readonly MeasurementLabel[],rect:ScreenRect):string[] {
  return [...new Set(labels.filter(label=>Number.isFinite(label.x)&&Number.isFinite(label.y)&&label.x>=rect.left&&label.x<=rect.right&&label.y>=rect.top&&label.y<=rect.bottom).map(label=>label.record.id))];
}
/** Context deletion is restricted to the actual hit, including at release. */
export function sameViewportPick(a: PickResult, b: PickResult): boolean {
  if (a.kind !== b.kind || a.kind === 'none') return false;
  if (a.kind === 'atom' && b.kind === 'atom') return a.atomId === b.atomId&&JSON.stringify(a.image??[0,0,0])===JSON.stringify(b.image??[0,0,0]);
  if (a.kind === 'port' && b.kind === 'port') return a.portId === b.portId;
  if (a.kind === 'auxiliary' && b.kind === 'auxiliary') return a.relationId === b.relationId;
  if (a.kind === 'coordinate' && b.kind === 'coordinate') return a.coordinateId === b.coordinateId;
  if (a.kind === 'bond' && b.kind === 'bond') return bondRefKey(a)===bondRefKey(b);
  return false;
}

export function modelAtomLabel(atom: Pick<Atom, 'element'>, index: number, display: Pick<DisplaySettings, 'atomNumbers' | 'elementNames'>): string {
  return (display.elementNames ? atom.element : '') + (display.atomNumbers ? String(index + 1) : '');
}

export function rightDragBondCommand(document: ModelDocument, start: { documentId: string; revision: number; atomId: string }, targetAtomId: string | null, locked: boolean): Extract<ModelCommand, { type: 'set-bond-order' }> | null {
  if (locked || start.documentId !== document.id || start.revision !== document.revision || !targetAtomId || start.atomId === targetAtomId) return null;
  const atoms = document.draft.structure.atoms, sourceIndex = atoms.findIndex(atom => atom.id === start.atomId), targetIndex = atoms.findIndex(atom => atom.id === targetAtomId);
  if (sourceIndex < 0 || targetIndex < 0 || document.draft.structure.cell?.pbc.some(Boolean)) return null;
  if ((document.draft.structure.bonds ?? []).some(bond => (bond.a === sourceIndex && bond.b === targetIndex) || (bond.b === sourceIndex && bond.a === targetIndex))) return null;
  return { type: 'set-bond-order', atomIds: [start.atomId, targetAtomId], order: 1 };
}
/** The command keeps its old exported alias for historical callers. */
export const controlDragBondCommand = rightDragBondCommand;

export function projectStateMarkers(atoms: Atom[], markers: readonly ViewportStateMarker[], project: (position: Vector3) => ScreenPoint, offset: ScreenPoint, structure?: Structure): (ViewportStateMarker & { x: number; y: number })[] {
  const known = new Map(atoms.map(atom => [atom.id, atom]));
  const lanes = new Map<string, number>();
  return markers.flatMap(marker => {
    const members = marker.atomIds.flatMap(id => known.has(id) ? [known.get(id)!] : []);
    if (!members.length || members.length !== marker.atomIds.length) return [];
    let screen = project(centroid(members));
    if (marker.coordinateId && members.length >= 2 && members.length <= 4) {
      const label = projectMeasurementLabels(atoms, [{ id: marker.id, mode: members.length === 2 ? 'distance' : members.length === 3 ? 'angle' : 'dihedral', atomIds: [...marker.atomIds],images:marker.images?.map(image=>[...image]), color: '' }], project, { x: 0, y: 0 }, structure)[0];
      if (label) screen = { x: label.x, y: label.y };
    }
    if (![screen.x, screen.y].every(Number.isFinite)) return [];
    // Separate compact state targets around the host; never cover its center.
    const group = `${marker.kind}:${JSON.stringify([marker.atomIds,marker.images])}`, lane = lanes.get(group) ?? 0; lanes.set(group, lane + 1);
    const dx = marker.coordinateId ? 24 + lane * 19 : marker.kind === 'selection' ? -15 : marker.kind === 'freeze' ? 15 + lane * 19 : lane * 19;
    const dy = marker.coordinateId ? -10 : marker.kind === 'scan' ? -24 : -15;
    return [{ ...marker, ...(marker.removable === false ? { label: `来源只读 · ${(marker.label ?? '冻结').replace(/^(解除|移除|取消)/, '')}` } : {}), x: screen.x - offset.x + dx, y: screen.y - offset.y + dy }];
  });
}

/** Screen-space labels follow the same model-space guide as the native lines. */
export function projectMeasurementLabels(atoms: Atom[], records: readonly MeasurementRecord[], project: (position: Vector3) => ScreenPoint, offset: ScreenPoint, structure?: Structure): MeasurementLabel[] {
  const indices = new Map(atoms.map((atom, index) => [atom.id, index]));
  return records.flatMap(record => {
    const path = record.atomIds.map(id => indices.get(id) ?? -1);
    if (path.some(index => index < 0) || path.length !== (record.mode === 'distance' ? 2 : record.mode === 'angle' ? 3 : 4)) return [];
    const type=record.mode === 'distance' ? 'B' : record.mode === 'angle' ? 'A' : 'D';
    let guide:GeometryGuide;
    try {if(!structure&&record.images?.some(image=>image.some(Boolean)))throw new Error('周期测量缺少晶胞来源。');guide=structure?measurementGeometryGuide({...structure,atoms},type,record.atomIds,record.images):geometryGuide(atoms,{type,atoms:path});}
    catch(cause){const error=cause instanceof Error?cause.message:String(cause);guide={paths:[],value:null,label:error,error};}
    const labelPath = record.mode === 'distance' ? guide.paths[0] : guide.paths.at(-1);
    const anchor = labelPath?.length ? centroid(labelPath) : centroid(path.map(index => atoms[index]));
    const screen = project(anchor);
    if (![screen.x, screen.y].every(Number.isFinite)) return [];
    const valueLabel = guide.value === null || guide.error ? '—' : `${guide.value.toFixed(type === 'B' ? 3 : 2)}${type === 'B' ? ' Å' : '°'}`;
    const names = path.map((index,endpoint) => modelAtomLabel(atoms[index], index, { atomNumbers: true, elementNames: true })+(record.images?.some(image=>image.some(Boolean))?'['+(record.images[endpoint]?.join(',')??'?')+']':''));
    const detail = guide.error ?? `${type} ${names.join(' → ')} = ${valueLabel}`;
    return [{ record, label: guide.error ?? guide.label, valueLabel, detail, error: guide.error, x: screen.x - offset.x, y: screen.y - offset.y }];
  });
}

/** Capture boxes never inherit or mutate the yellow modeling selection. */
export function captureBoxAtomIds(atoms: Atom[], project: (position: Vector3) => ScreenPoint, rect: ScreenRect): string[] {
  return unionBox({ atomIds: [], bonds: [], auxiliaryIds: [] }, atoms, project, rect).atomIds;
}

export function projectCaptureMarkers(atoms: Atom[], atomIds: readonly string[], project: (position: Vector3) => ScreenPoint, offset: ScreenPoint): { atomId: string; ordinal: number; x: number; y: number }[] {
  const known = new Map(atoms.map(atom => [atom.id, atom]));
  return atomIds.flatMap((atomId, index) => {
    const atom = known.get(atomId); if (!atom) return [];
    const screen = project(coordinates(atom));
    return [screen.x, screen.y].every(Number.isFinite) ? [{ atomId, ordinal: index + 1, x: screen.x - offset.x, y: screen.y - offset.y }] : [];
  });
}
