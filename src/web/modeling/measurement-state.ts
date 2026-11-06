import type { MeasurementRecord, MeasurementSession, MeasurementState, PickResult } from '../../modeling/contracts';
import type { Vector3 } from '../../core/types';
import { modelCoordinateKey } from '../../modeling/constraints';

function imageValue(image:Vector3=[0,0,0]):Vector3 {if(!Array.isArray(image)||image.length!==3||!image.every(Number.isSafeInteger))throw new Error('测量端点需要明确整数镜像。');return [...image];}
function endpointImages(ids:readonly string[],images?:readonly Vector3[]):Vector3[]{if(images&&images.length!==ids.length)throw new Error('测量端点与镜像数量不符。');return ids.map((_,index)=>imageValue(images?.[index]));}
function normalizedImages(images:readonly Vector3[]):Vector3[]{const first=images[0]??[0,0,0];return images.map(image=>imageValue(image.map((value,axis)=>value-first[axis]) as Vector3));}
const endpointKey=(id:string,image:Vector3)=>JSON.stringify([id,image]);

export const emptyMeasurement = (mode: MeasurementState['mode'] = null): MeasurementState => ({ mode, atomIds: [] });
export function measurementLimit(mode: MeasurementState['mode']): number {
  return mode === 'distance' ? 2 : mode === 'angle' ? 3 : 4;
}
/** Ordered, independent display IDs: measuring never changes edit selection. */
export function pickMeasurement(state: MeasurementState, atomId: string,image?:Vector3|number): MeasurementState {
  if (!state.mode) return state;
  // Preserve the existing Array.reduce callback usage; its third argument is an index.
  if(typeof image==='number')image=undefined;
  const picked=imageValue(image),before=endpointImages(state.atomIds,state.images);
  if (state.atomIds.some((id,index)=>endpointKey(id,before[index])===endpointKey(atomId,picked))) return state;
  const reset=state.atomIds.length>=measurementLimit(state.mode),atomIds=reset?[atomId]:[...state.atomIds,atomId],images=reset?[picked]:[...before,picked];
  return { ...state, atomIds,...(image||state.images?{images}: {}) };
}
/** Read-only canvases own one transient measurement, not a modeling session.
 * A physical bond supplies both exact displayed endpoints even in auto mode. */
export function pickBondMeasurement(state:MeasurementState,pick:PickResult):MeasurementState {
  if(pick.kind!=='bond'||state.mode!=='auto'&&state.mode!=='distance')return state;
  const image=imageValue(pick.image);
  if(pick.atomIds[0]===pick.atomIds[1]&&!image.some(Boolean))return state;
  return {...state,atomIds:[...pick.atomIds],images:[[0,0,0],image]};
}
export function retainMeasurement(state: MeasurementState, atomIds: readonly string[]): MeasurementState {
  const allowed = new Set(atomIds), next = state.atomIds.filter(id => allowed.has(id));
  return next.length === state.atomIds.length ? state : { ...state, atomIds: next,...(state.images?{images:state.images.filter((_,index)=>allowed.has(state.atomIds[index]))}: {}) };
}

const measurementColors = ['#2374d1', '#c35b19', '#8b4ac2', '#16846e', '#c34070', '#737a19'];

function hexColor(channels: readonly number[]): string {
  return '#' + channels.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('');
}

function contrastOnWhite(channels: readonly number[]): number {
  const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return 1.05 / (.2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2] + .05);
}

function hueColor(hue: number, saturation: number, lightness: number): number[] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(hue / 60 % 2 - 1)), m = lightness - chroma / 2;
  const rgb = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x]
    : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return rgb.map(channel => Math.round((channel + m) * 255) / 255);
}

/** Reproducible hex colors: preserve legacy six, then use readable hues. */
function recordColor(serial: number, records: readonly MeasurementRecord[]): string {
  const occupied = new Set(records.map(record => record.color.toLowerCase()));
  const legacy = measurementColors[serial - 1];
  if (legacy && !occupied.has(legacy)) return legacy;
  const hue = ((serial - 7) * 137.50776405003785 % 360 + 360) % 360;
  let lightness = .38;
  let rgb = hueColor(hue, .74, lightness);
  while (contrastOnWhite(rgb) < 4.5) { lightness -= .005; rgb = hueColor(hue, .74, lightness); }
  const preferred = hexColor(rgb);
  if (!occupied.has(preferred)) return preferred;
  // The odd increment visits every 24-bit RGB exactly once. A collision never
  // recycles a live color, and every fallback retains contrast and saturation.
  const seed = Math.imul(serial, 0x9e3779) & 0xffffff;
  for (let attempt = 0; attempt < 0x1000000; attempt++) {
    const value = (seed + Math.imul(attempt, 0x6d2b79)) & 0xffffff;
    const channels = [value >>> 16, value >>> 8 & 255, value & 255].map(channel => channel / 255);
    const maximum = Math.max(...channels), minimum = Math.min(...channels);
    if (maximum === 0 || (maximum - minimum) / maximum < .5 || contrastOnWhite(channels) < 4.5) continue;
    const color = '#' + value.toString(16).padStart(6, '0');
    if (!occupied.has(color)) return color;
  }
  throw new RangeError('会话测量可用颜色已耗尽。');
}

/** Session annotations are display state, never task coordinates or selection. */
export function emptyMeasurementSession(mode: MeasurementState['mode'] = null): MeasurementSession {
  return { mode, pendingAtomIds: [], autoAtomIds: [], records: [], activeRecordId: null, nextRecordSerial: 1 };
}

/** A reversed path is equivalent; other permutations change its geometry. */
export function sameMeasurementPath(first: readonly string[], second: readonly string[],firstImages?:readonly Vector3[],secondImages?:readonly Vector3[]): boolean {
  if(first.length!==second.length)return false;
  const type=first.length===2?'B':first.length===3?'A':'D';
  return modelCoordinateKey({type,atomIds:[...first],images:firstImages?[...firstImages]:undefined})===modelCoordinateKey({type,atomIds:[...second],images:secondImages?[...secondImages]:undefined});
}

export function clearPendingMeasurement(state: MeasurementSession): MeasurementSession {
  return !state.pendingAtomIds.length && !state.autoAtomIds.length ? state
    : { ...state, pendingAtomIds: [], autoAtomIds: [],pendingImages:undefined,autoImages:undefined };
}

export function setMeasurementMode(state: MeasurementSession, mode: MeasurementState['mode']): MeasurementSession {
  const cleared = clearPendingMeasurement(state);
  return cleared.mode === mode ? cleared : { ...cleared, mode };
}

/** Recent distinct points in auto mode; complete BAD paths toggle one record. */
export function pickSessionMeasurement(state: MeasurementSession, atomId: string,image?:Vector3|number): MeasurementSession {
  if (!state.mode) return state;
  if(typeof image==='number')image=undefined;
  const picked=imageValue(image);
  if (state.mode === 'auto') {
    const before=endpointImages(state.autoAtomIds,state.autoImages),keep=state.autoAtomIds.map((id,index)=>({id,image:before[index]})).filter(row=>endpointKey(row.id,row.image)!==endpointKey(atomId,picked));
    const endpoints=[...keep,{id:atomId,image:picked}].slice(-4);
    return { ...state, autoAtomIds:endpoints.map(row=>row.id),...(image||state.autoImages?{autoImages:endpoints.map(row=>row.image)}:{}),pendingAtomIds:[],pendingImages:undefined };
  }
  const before=endpointImages(state.pendingAtomIds,state.pendingImages);
  if (state.pendingAtomIds.some((id,index)=>endpointKey(id,before[index])===endpointKey(atomId,picked))) return state;
  const pendingAtomIds = [...state.pendingAtomIds, atomId];
  const pendingImages=[...before,picked],explicit=!!(image||state.pendingImages),images=normalizedImages(pendingImages);
  if (pendingAtomIds.length < measurementLimit(state.mode)) return { ...state, pendingAtomIds,...(explicit?{pendingImages}: {}) };
  const existing = state.records.find(record => record.mode === state.mode && sameMeasurementPath(record.atomIds, pendingAtomIds,record.images,explicit?images:undefined));
  if (existing) return {
    ...state, pendingAtomIds: [],pendingImages:undefined, records: state.records.filter(record => record.id !== existing.id),
    activeRecordId: state.activeRecordId === existing.id ? null : state.activeRecordId,
  };
  const serial = state.nextRecordSerial;
  const record: MeasurementRecord = {
    id: `measurement-${serial}`, mode: state.mode, atomIds: pendingAtomIds,...(explicit?{images}: {}),
    color: recordColor(serial, state.records),
  };
  return { ...state, pendingAtomIds: [],pendingImages:undefined, records: [...state.records, record], activeRecordId: record.id, nextRecordSerial: serial + 1 };
}
/** A bond pick already declares the physical image; never infer its nearest image. */
export function pickSessionBondMeasurement(state:MeasurementSession,pick:PickResult):MeasurementSession {
  if(pick.kind!=='bond'||state.mode!=='auto'&&state.mode!=='distance')return state;
  const image=imageValue(pick.image);if(pick.atomIds[0]===pick.atomIds[1]&&!image.some(Boolean))return state;
  if(state.mode==='auto')return {...state,autoAtomIds:[...pick.atomIds],autoImages:[[0,0,0],image],pendingAtomIds:[],pendingImages:undefined};
  const first=pickSessionMeasurement({...state,pendingAtomIds:[],pendingImages:undefined},pick.atomIds[0],[0,0,0]);
  return pickSessionMeasurement(first,pick.atomIds[1],image);
}

export function activateMeasurementRecord(state: MeasurementSession, recordId: string | null): MeasurementSession {
  const activeRecordId = recordId && state.records.some(record => record.id === recordId) ? recordId : null;
  return activeRecordId === state.activeRecordId ? state : { ...state, activeRecordId };
}

export function clearSessionMeasurements(state: MeasurementSession): MeasurementSession {
  return { ...state, pendingAtomIds: [], autoAtomIds: [],pendingImages:undefined,autoImages:undefined, records: [], activeRecordId: null };
}

/** Removed atoms invalidate whole records rather than changing their arity. */
export function retainMeasurementSession(state: MeasurementSession, atomIds: readonly string[]): MeasurementSession {
  const allowed = new Set(atomIds);
  const records = state.records.filter(record => record.atomIds.every(id => allowed.has(id)));
  const pendingAtomIds = state.pendingAtomIds.every(id => allowed.has(id)) ? state.pendingAtomIds : [];
  const autoAtomIds = state.autoAtomIds.filter(id => allowed.has(id));
  const activeRecordId = records.some(record => record.id === state.activeRecordId) ? state.activeRecordId : null;
  if (records.length === state.records.length && pendingAtomIds === state.pendingAtomIds
    && autoAtomIds.length === state.autoAtomIds.length && activeRecordId === state.activeRecordId) return state;
  return { ...state, pendingAtomIds, autoAtomIds,...(state.pendingImages?{pendingImages:pendingAtomIds.length?state.pendingImages:undefined}:{}),...(state.autoImages?{autoImages:state.autoImages.filter((_,index)=>allowed.has(state.autoAtomIds[index]))}:{}), records, activeRecordId };
}

/** One legacy-shaped transient preview for the existing render port. */
export function transientMeasurement(state: MeasurementSession): MeasurementState {
  const images=state.mode==='auto'?state.autoImages:state.pendingImages;
  return { mode: state.mode, atomIds: [...(state.mode === 'auto' ? state.autoAtomIds : state.pendingAtomIds)],...(images?{images:normalizedImages(images)}:{}) };
}
