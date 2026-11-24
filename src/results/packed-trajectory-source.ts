import type { Atom, Structure } from '../core/types';
import { assertResultNotAborted, type TrajectoryResult } from './contracts';
import { trajectoryBinaryAssetPort, TrajectoryPageAsset, type TrajectoryByteRange } from './trajectory-page-assets';

export type PackedTrajectoryAtom = Readonly<Omit<Atom, 'x' | 'y' | 'z'>>;

export interface PackedTrajectoryFrame {
  readonly header: Readonly<Omit<Structure, 'atoms'>>;
  readonly topology: readonly PackedTrajectoryAtom[];
  /** A structure collection may assign distinct atom IDs per record while sharing its ordered atom descriptors. */
  readonly atomId?: (index: number) => string;
  /** Borrowed from the source owner. Consumers must not mutate or detach it. */
  readonly coordinates: Float64Array;
}

type PackedProvider = { get(index:number):PackedTrajectoryFrame|undefined;
  read?(index:number,signal?:AbortSignal):Promise<PackedTrajectoryFrame|undefined>;
  paged?(index:number):boolean };
const sources = new WeakMap<TrajectoryResult,PackedProvider>();

export function registerPackedTrajectorySource(result: TrajectoryResult, getFrame: PackedProvider['get'], options?: Pick<PackedProvider,'read'|'paged'>): void {
  sources.set(result, { get:getFrame,...options });
}

export function packedTrajectoryFrame(result: TrajectoryResult, index: number): PackedTrajectoryFrame | undefined {
  return sources.get(result)?.get(index);
}

export function isPagedPackedTrajectoryFrame(result:TrajectoryResult,index:number):boolean {
  return sources.get(result)?.paged?.(index) === true;
}
export async function readPackedTrajectoryFrame(result:TrajectoryResult,index:number,signal?:AbortSignal) {
  const source=sources.get(result);assertResultNotAborted(signal);
  return source?.get(index) ?? source?.read?.(index,signal);
}

let packedByteTarget = Infinity, packedResident = 0;
export function setPackedTrajectoryByteTarget(bytes:number|undefined) { packedByteTarget = bytes ?? Infinity; }

type PackedHeader = Omit<PackedTrajectoryFrame,'coordinates'>;
interface StoredPackedFrame { meta:PackedHeader; frame?:PackedTrajectoryFrame; range?:TrajectoryByteRange }
/** Source-owned numeric pages. Storage selection is a scheduling choice;
 * individual scientific frames may span any number of transfer pages. */
export class PackedTrajectoryFrames {
  private frames:StoredPackedFrame[]=[];
  private written=0;
  private resident=0;
  private asset?:TrajectoryPageAsset;
  private hot?:{index:number;frame:PackedTrajectoryFrame};
  private closed=false;

  get length(){return this.frames.length;}
  append(frame:PackedTrajectoryFrame){
    if(this.closed)throw Error('轨迹坐标来源已关闭。');
    const {coordinates,...meta}=frame;
    this.frames.push({meta,frame});
    this.resident+=coordinates.byteLength;packedResident+=coordinates.byteLength;
  }
  metadata(index:number){return this.frames[index]?.meta;}
  paged=(index:number)=>this.frames[index]?.range!==undefined;
  get=(index:number):PackedTrajectoryFrame|undefined=>{
    const stored=this.frames[index];
    if(!stored)return;
    if(stored.frame)return stored.frame;
    if(this.hot?.index===index)return this.hot.frame;
  };
  read=async(index:number,signal?:AbortSignal):Promise<PackedTrajectoryFrame|undefined>=>{
    assertResultNotAborted(signal);
    if(this.closed)throw Error('轨迹坐标来源已关闭。');
    const hot=this.get(index);if(hot)return hot;
    const stored=this.frames[index];if(!stored?.range)return;
    const bytes=await this.asset!.read(stored.range,signal);
    if(this.closed)throw new DOMException('轨迹坐标来源已关闭。','AbortError');
    if(bytes.byteLength!==stored.meta.topology.length*24)throw Error('轨迹坐标页不完整。');
    const frame={...stored.meta,coordinates:new Float64Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/8)};
    this.hot={index,frame};return frame;
  };
  async drain(){
    if(!this.asset){const port=trajectoryBinaryAssetPort();if(!port||packedResident<=packedByteTarget)return;this.asset=new TrajectoryPageAsset(port);}
    for(;this.written<this.frames.length;this.written++){
      const frame=this.frames[this.written],numbers=frame.frame!.coordinates;
      const bytes=new Uint8Array(numbers.buffer,numbers.byteOffset,numbers.byteLength);
      const range=await this.asset.append([bytes]);
      if(range.length!==bytes.byteLength)throw Error('轨迹坐标页写入不完整。');
      frame.range=range;frame.frame=undefined;
      this.resident-=bytes.byteLength;packedResident-=bytes.byteLength;
    }
  }
  async seal(){await this.drain();await this.asset?.seal();}
  async dispose(){
    if(!this.closed){this.closed=true;packedResident-=this.resident;this.resident=0;this.frames=[];this.hot=undefined;}
    await this.asset?.dispose();
  }
}

export function materializePackedTrajectoryFrame(frame: PackedTrajectoryFrame): Structure {
  const { header, topology, coordinates, atomId } = frame;
  const atoms = topology.map((atom, index): Atom => {
    const offset = 3 * index;
    return { ...atom, ...(atomId ? { id: atomId(index) } : {}), x: coordinates[offset], y: coordinates[offset + 1], z: coordinates[offset + 2] };
  });
  return { ...structuredClone(header), atoms };
}
