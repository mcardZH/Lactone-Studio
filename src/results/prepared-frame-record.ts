import type { Atom, Structure } from '../core/types';
import type { PreparedFrame } from './prepared-trajectory';
import type { PackedTrajectoryFrame } from './packed-trajectory-source';

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

type FrameHeader = Omit<Structure, 'atoms'>;
type AtomHeader = Omit<Atom, 'x' | 'y' | 'z'>;
interface PreparedFrameRecordMetadata { raw: FrameHeader; display?: FrameHeader; annotations?: readonly AtomHeader[] }

/** All coordinates are stored as their original Float64 values. The display
 * preparation contract has already proven the same ordered geometry. */
export function prepareFrameRecord(frame: PreparedFrame, packed?: PackedTrajectoryFrame, useSourceCoordinates=false): {pieces: Uint8Array[]; length: number} {
  const { atoms, ...raw } = frame.raw;
  const display = frame.raw === frame.structure ? undefined : Object.fromEntries(Object.keys(frame.structure).filter(key => key !== 'atoms')
    .map(key => [key, frame.structure[key as keyof Structure]])) as FrameHeader;
  const annotations = useSourceCoordinates ? undefined : atoms.map(({ x: _x, y: _y, z: _z, ...atom }) => atom);
  const metadata = encoder.encode(JSON.stringify({ raw, ...(display ? { display } : {}), ...(annotations ? {annotations} : {}) }, writeMetadata));
  const prefix = new Uint8Array(8);
  const view = new DataView(prefix.buffer);
  view.setBigUint64(0, BigInt(metadata.length), true);
  if(useSourceCoordinates)return {pieces:[prefix,metadata],length:prefix.length+metadata.length};
  const coordinates = packed?.coordinates ?? new Float64Array(atoms.length * 3);
  if (!packed) atoms.forEach((atom, index) => {
    coordinates[3 * index] = atom.x; coordinates[3 * index + 1] = atom.y; coordinates[3 * index + 2] = atom.z;
  });
  const numbers = new Uint8Array(coordinates.buffer, coordinates.byteOffset, coordinates.byteLength);
  return { pieces: [prefix, metadata, numbers], length: prefix.length + metadata.length + numbers.length };
}

export function readFrameRecord(bytes: Uint8Array<ArrayBuffer>, sourceIndex: number, packed?:PackedTrajectoryFrame): PreparedFrame {
  if (bytes.length < 8) throw Error('轨迹准备页头不完整。');
  const start = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true)) + 8;
  if (!Number.isSafeInteger(start) || start > bytes.length) throw Error('轨迹准备页元数据范围无效。');
  const { raw, display, annotations } = readMetadata(JSON.parse(decoder.decode(bytes.subarray(8, start)))) as PreparedFrameRecordMetadata;
  let atoms:Atom[];
  if(packed){
    if(annotations||start!==bytes.length||packed.coordinates.length!==packed.topology.length*3)throw Error('轨迹准备页坐标来源不一致。');
    atoms=packed.topology.map((atom,index)=>({...atom,...(packed.atomId?{id:packed.atomId(index)}:{}),x:packed.coordinates[index*3],y:packed.coordinates[index*3+1],z:packed.coordinates[index*3+2]}));
  }else{
    if (!Array.isArray(annotations) || !annotations.length || bytes.length - start !== annotations.length * 24) throw Error('轨迹准备页坐标范围不完整。');
    const numbers = new DataView(bytes.buffer, bytes.byteOffset + start, bytes.length - start);
    atoms=annotations.map((atom, index) => ({...atom, x: numbers.getFloat64(24*index,true), y: numbers.getFloat64(24*index+8,true), z: numbers.getFloat64(24*index+16,true)}));
  }
  const structure = { ...raw, atoms };
  return { raw: structure, structure: display ? { ...display, atoms } : structure, sourceIndex };
}
