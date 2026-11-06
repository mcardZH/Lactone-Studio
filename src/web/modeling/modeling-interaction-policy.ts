import type { DisplaySettings, MeasurementState, ModelCommand, ModelDocument, PickResult, ScreenPoint, SelectionCaptureRequest, SelectionCaptureResult } from '../../modeling/contracts';
import type { Atom, Structure, Vector3 } from '../../core/types';
import type { BondOrderEntry } from '../../modeling/xtb/contracts';
import { add, coordinates, point, rotatedAtoms, subtract } from './render/geometry';
import { bondRefKey } from './render/geometry';
import { builderCoordinateValue } from '../../core/builder-geometry';

export const MODEL_HOVER_COLOR = '#168bd2';
/** Scalar text has its own contrast colour; native hover outlines stay blue. */
export const MODEL_HOVER_LABEL_COLOR = '#153846';
export type PointerMode = 'select' | 'freeze' | null;
export interface MeasurementPickCallbacks {
  onMeasurementPick?(atomId:string|null,image?:Vector3):void;
  onMeasurementBondPick?(pick:Extract<PickResult,{kind:'bond'}>):void;
}
/** Normalize only the geometric pair delivered to the existing B callback.
 * The original auxiliary pick/relation ID remains authoritative for hover,
 * selection and graph edits; this never creates a physical bond. */
export function measurementConnectionPair(document:ModelDocument,pick:PickResult):Extract<PickResult,{kind:'bond'}>|null{
  if(pick.kind==='bond')return pick;
  if(pick.kind!=='auxiliary')return null;
  const relation=document.auxiliaryRelations.find(value=>value.id===pick.relationId);
  if(!relation||relation.a===relation.b||![relation.a,relation.b].every(id=>document.draft.structure.atoms.some(atom=>atom.id===id)))return null;
  return {kind:'bond',atomIds:[relation.a,relation.b]};
}
/** The periodic canvas draws base atoms unless an actual replica is identified.
 * Explicit zero is a drawn endpoint, not a guessed minimum image or graph unwrap. */
export function dispatchMeasurementPick(pick:PickResult,mode:MeasurementState['mode'],callbacks:MeasurementPickCallbacks,context:{periodic?:boolean;document?:ModelDocument}={}):boolean {
  if(!mode)return false;
  if(pick.kind==='atom'){callbacks.onMeasurementPick?.(pick.atomId,pick.image??(context.periodic?[0,0,0]:undefined));return true;}
  if(pick.kind==='bond'&&(mode==='auto'||mode==='distance')){callbacks.onMeasurementBondPick?.(pick);return true;}
  if(pick.kind==='auxiliary'&&(mode==='auto'||mode==='distance')&&context.document){const pair=measurementConnectionPair(context.document,pick);if(pair){callbacks.onMeasurementBondPick?.(pair);return true;}}
  if(pick.kind==='none'){callbacks.onMeasurementPick?.(null);return true;}
  return false;
}
export interface CaptureRebaseResult extends SelectionCaptureResult { previousRevision: number; invalidatedAtomIds: string[] }
/** The synchronous held-key lease wins over delayed React display state. */
export function pointerModeAtPress(held: { mode: Exclude<PointerMode, null> } | null, freezeTool: unknown): PointerMode {
  return held?.mode ?? (freezeTool ? 'freeze' : null);
}
/** A purpose never forces a gesture. The same box controls/R own normal and capture selection. */
export function useBoxGesture(mode: PointerMode, box: boolean, observation: string | undefined, button: number): boolean {
  return (button === 0 || button === 2) && (!!mode || box || observation === 'box');
}
/** Fragment previews always use displacement from the original pointer anchor. */
export function fragmentPointerStep(from: ScreenPoint, to: ScreenPoint): { stepX: number; stepY: number } | null {
  const stepX = to.x - from.x, stepY = to.y - from.y;
  return stepX === 0 && stepY === 0 ? null : { stepX, stepY };
}
export interface FragmentPreviewSource {
  /** Only selected atoms, in the once-resolved Cartesian frame. */
  atoms: Atom[];
  offsets: ReadonlyMap<string, Vector3>;
}
/** Resolve membership once at press time; later frames never scan static atoms.
 * Periodic positions are supplied by the existing finite-fragment resolver. */
export function createFragmentPreviewSource(source: readonly Atom[], atomIds: readonly string[], positions?: Readonly<Record<string, Vector3>>): FragmentPreviewSource {
  const ids = new Set(atomIds), offsets = new Map<string,Vector3>();
  if (!ids.size || ids.size !== atomIds.length) throw new Error('拖动原子范围无效或重复。');
  const atoms = source.flatMap(atom => {
    if (!atom.id || !ids.has(atom.id)) return [];
    const position = positions?.[atom.id] ?? coordinates(atom);
    if (!position.every(Number.isFinite)) throw new Error('拖动预览坐标必须有限。');
    offsets.set(atom.id, subtract(position, coordinates(atom)));
    return [{ ...atom, ...point(position) }];
  });
  if (atoms.length !== ids.size) throw new Error('拖动原子身份已失效。');
  return { atoms, offsets };
}
/** Display-only absolute raw coordinates for the affected set. This function
 * has no Store callback, history, revision or scientific invalidation path. */
export function fragmentFramePresentation(source: FragmentPreviewSource, command: Extract<ModelCommand, { type: 'transform-fragment' }>): { preview: Atom[] } {
  if (command.atomIds.length !== source.atoms.length || new Set(command.atomIds).size !== command.atomIds.length || command.atomIds.some(id => !source.offsets.has(id))) throw new Error('拖动预览范围已变化。');
  const transformed = command.rotation ? rotatedAtoms(source.atoms, command.atomIds, command.rotation) : source.atoms;
  return { preview: transformed.map(atom => ({ ...atom, ...point(subtract(add(coordinates(atom), command.delta ?? [0,0,0]), source.offsets.get(atom.id!)!)) })) };
}
/** The result owner supplies the scientific scheme and value text. Missing,
 * stale or nonfinite scalar rows never become a fabricated charge/spin zero. */
export function atomHoverLabel(atoms: readonly Atom[], atomId: string, values?: readonly { atomIndex: number; value: number; label?: string }[]): string | null {
  const index = atoms.findIndex(atom => atom.id === atomId);
  if (index < 0) return null;
  const value = values?.find(row => row.atomIndex === index && Number.isFinite(row.value) && row.label?.trim());
  return `${atoms[index].element}${index + 1}${value ? '\n' + value.label!.trim() : ''}`;
}
/** Frame queues cannot carry edits across an owner, revision or capture lifetime. */
export function gestureLeaseCurrent(gesture: { documentId: string; revision: number; kind: string; captureRequestId?: string }, document: ModelDocument, request?: SelectionCaptureRequest): boolean {
  return gesture.documentId === document.id && (gesture.kind === 'camera' || gesture.revision === document.revision) && gesture.captureRequestId === request?.requestId;
}
export function captureViewportDisplay(display: DisplaySettings, request?: SelectionCaptureRequest): DisplaySettings {
  const mode = request?.purpose === 'basis' ? 'basis' : request?.purpose === 'fragment' ? 'fragments' : request?.purpose === 'layer' ? 'layers' : null;
  return mode ? { ...display, colorMode: mode, regionHighlights: true, regionLabels: true } : display;
}
export function captureRebaseResult(request: SelectionCaptureRequest, document: ModelDocument, previousIds: readonly string[]): CaptureRebaseResult | null {
  if (request.documentId !== document.id) return null;
  const known = new Set(document.draft.structure.atoms.map(atom => atom.id));
  return { requestId: request.requestId, documentId: document.id, previousRevision: request.revision, revision: document.revision,
    atomIds: [...document.selection.atomIds], invalidatedAtomIds: [...new Set(previousIds)].filter(id => !known.has(id)) };
}
/** Store listeners publish only after the entire synchronous emit (including
 * App's scientific projection) has completed. Superseded notifications drop. */
export function createCaptureRebasePublisher(read: () => { active: boolean; request?: SelectionCaptureRequest; document: Pick<ModelDocument, 'id' | 'revision'> }, publish: (result: CaptureRebaseResult) => void, enqueue: (callback: () => void) => void = queueMicrotask) {
  let serial = 0, disposed = false;
  return {
    invalidate() { serial++; },
    dispose() { disposed = true; serial++; },
    schedule(result: CaptureRebaseResult, assertIdentity?: () => void) {
      const token = ++serial, pending = { ...result, atomIds: [...result.atomIds], invalidatedAtomIds: [...result.invalidatedAtomIds] };
      enqueue(() => {
        if (disposed || token !== serial) return;
        const current = read();
        if (!current.active || current.request?.requestId !== pending.requestId || current.request.documentId !== pending.documentId || current.document.id !== pending.documentId || current.document.revision !== pending.revision) return;
        try { assertIdentity?.(); } catch { return; }
        publish(pending);
      });
    },
  };
}
/** Measure the physical declared image, never a clipped visual bond segment. */
export function hoverBondLength(structure: Structure, pick: PickResult): string | null {
  if (pick.kind !== 'bond') return null;
  try{const value=builderCoordinateValue(structure,'B',pick.atomIds,[[0,0,0],pick.image??[0,0,0]]);return Number.isFinite(value)?value.toFixed(3)+' Å':null;}catch{return null;}
}

export type HoverBondOrderLookup = ReadonlyMap<string, number>;
const bondPairKey = (ids: readonly [string, string]) => JSON.stringify(ids[0] < ids[1] ? ids : [ids[1], ids[0]]);
/** Build once per current-result array, never once per pointer movement. */
export function indexHoverBondOrders(entries: readonly BondOrderEntry[] = []): HoverBondOrderLookup {
  const values = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.atomIds[0] || !entry.atomIds[1] || entry.atomIds[0] === entry.atomIds[1] || !Number.isFinite(entry.value) || entry.value < 0) continue;
    values.set(bondPairKey(entry.atomIds), entry.value);
  }
  return values;
}
/** Native results are optional presentation data. Never replace missing MBO by zero. */
export function hoverBondLabel(structure: Structure, pick: PickResult, entries: readonly BondOrderEntry[] | HoverBondOrderLookup = []): string | null {
  const length = hoverBondLength(structure, pick);
  if (!length || pick.kind !== 'bond') return length;
  const bond=structure.bonds?.find(bond=>bondRefKey({atomIds:[structure.atoms[bond.a]?.id!,structure.atoms[bond.b]?.id!],image:bond.image})===bondRefKey(pick));
  if(bond?.orderKnown===false)return `${length}\n${bond.kind==='coordination'?'周期经验配位连接':'周期经验连接'} · 键级未知`;
  if(structure.cell?.pbc.some(Boolean)||pick.image?.some(Boolean)){
    // The raw tblite matrix is aggregated over atom pairs, not measured for
    // every image. Only the core's proven nearest-image mapping owns its aid.
    // Exact reference matching above also handles reversed endpoint images.
    if(bond?.perception==='periodic-gfn2'&&pick.atomIds[0]!==pick.atomIds[1]&&typeof bond.mbo==='number'&&Number.isFinite(bond.mbo))
      return `${length}\n原子对键级 ${bond.mbo.toFixed(3)} MBO（聚合）`;
    return bond?.kind==='coordination'?`${length}\n配位连接`:length;
  }
  const lookup = Array.isArray(entries) ? indexHoverBondOrders(entries) : entries as HoverBondOrderLookup;
  const value = lookup.get(bondPairKey(pick.atomIds));
  if (value !== undefined && Number.isFinite(value) && value >= 0) return `${length}\n${value.toFixed(3)} MBO`;
  if (bond?.mbo !== undefined && Number.isFinite(bond.mbo)) return `${length}\n${bond.mbo.toFixed(3)} MBO（来源）`;
  return bond?.perception === 'metal-distance' ? `${length}\n距离辅助配位` : length;
}
