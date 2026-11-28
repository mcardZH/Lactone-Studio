import type { Atom, Structure } from '../core/types';
import type { PreparedFrame } from './prepared-trajectory';
import {materializePackedTrajectoryAtoms,type PackedTrajectoryFrame} from './packed-trajectory-source';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const escape = '\u0000es';

// The optional fields of a scientific structure distinguish an absent key, an
// explicit undefined value and null. JSON on its own also changes negative zero.
function writeMetadata(key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(escape)) return escape + 's' + value;
  if (value === undefined) return escape + 'u';
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return escape + 'z';
    if (Number.isNaN(value)) return escape + 'n';
    if (value === Infinity) return escape + 'p';
    if (value === -Infinity) return escape + 'm';
  }
  return value;
}

function readMetadata(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(escape)) {
    switch (value[escape.length]) {
      case 's': return value.slice(escape.length + 1);
      case 'u': return undefined;
      case 'z': return -0;
      case 'n': return NaN;
      case 'p': return Infinity;
      case 'm': return -Infinity;
      default: throw Error('轨迹准备页元数据转义无效。');
    }
  }
  if (Array.isArray(value)) return value.map(readMetadata);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, readMetadata(item)]));
  return value;
}

export function encodeTrajectoryRecordMetadata(value:unknown):string {
  return JSON.stringify(value,writeMetadata);
}

export function decodeTrajectoryRecordMetadata<T>(value:string):T {
  return readMetadata(JSON.parse(value)) as T;
}

type FrameHeader = Omit<Structure, 'atoms'>;
type AtomHeader = Omit<Atom, 'x' | 'y' | 'z'>;
interface PreparedFrameRecordMetadata { raw: FrameHeader; display?: FrameHeader; annotations?: readonly AtomHeader[] }

/** All coordinates are stored as their original Float64 values. The display
 * preparation contract has already proven the same ordered geometry. */
export function prepareFrameRecord(frame: PreparedFrame, packed?: PackedTrajectoryFrame, useSourceCoordinates=false): {pieces: Uint8Array[]; length: number} {
  const header=(structure:Structure)=>Object.fromEntries(Object.keys(structure).filter(key=>key!=='atoms')
    .map(key=>[key,structure[key as keyof Structure]])) as FrameHeader;
  const raw=header(frame.raw);
  const display=frame.raw===frame.structure?undefined:header(frame.structure);
  const annotations = useSourceCoordinates ? undefined : frame.raw.atoms.map(({ x: _x, y: _y, z: _z, ...atom }) => atom);
  const metadata = encoder.encode(encodeTrajectoryRecordMetadata({ raw, ...(display ? { display } : {}), ...(annotations ? {annotations} : {}) }));
  const prefix = new Uint8Array(8);
  const view = new DataView(prefix.buffer);
  view.setBigUint64(0, BigInt(metadata.length), true);
  if(useSourceCoordinates)return {pieces:[prefix,metadata],length:prefix.length+metadata.length};
  const atoms=frame.raw.atoms;
  const coordinates = packed?.coordinates ?? new Float64Array(atoms.length * 3);
  if (!packed) atoms.forEach((atom, index) => {
    coordinates[3 * index] = atom.x; coordinates[3 * index + 1] = atom.y; coordinates[3 * index + 2] = atom.z;
  });
  const numbers = new Uint8Array(coordinates.buffer, coordinates.byteOffset, coordinates.byteLength);
  return { pieces: [prefix, metadata, numbers], length: prefix.length + metadata.length + numbers.length };
}

export function readFrameRecord(bytes: Uint8Array<ArrayBuffer>, sourceIndex: number, packed?:PackedTrajectoryFrame,immutablePackedAtoms=false): PreparedFrame {
  if (bytes.length < 8) throw Error('轨迹准备页头不完整。');
  const start = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true)) + 8;
  if (!Number.isSafeInteger(start) || start > bytes.length) throw Error('轨迹准备页元数据范围无效。');
  const { raw, display, annotations } = decodeTrajectoryRecordMetadata<PreparedFrameRecordMetadata>(decoder.decode(bytes.subarray(8, start)));
  let atoms:Atom[];
  if(packed){
    if(annotations||start!==bytes.length||packed.coordinates.length!==packed.topology.length*3)throw Error('轨迹准备页坐标来源不一致。');
    atoms=materializePackedTrajectoryAtoms(packed,immutablePackedAtoms);
  }else{
    if (!Array.isArray(annotations) || !annotations.length || bytes.length - start !== annotations.length * 24) throw Error('轨迹准备页坐标范围不完整。');
    const numbers = new DataView(bytes.buffer, bytes.byteOffset + start, bytes.length - start);
    atoms=annotations.map((atom, index) => ({...atom, x: numbers.getFloat64(24*index,true), y: numbers.getFloat64(24*index+8,true), z: numbers.getFloat64(24*index+16,true)}));
  }
  const structure = { ...raw, atoms };
  return { raw: structure, structure: display ? { ...display, atoms } : structure, sourceIndex };
}
