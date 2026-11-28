import type {Structure} from '../core/types';
import {assertResultNotAborted,type TrajectoryResult} from '../results/contracts';
import {hasCanonicalPackedTrajectorySource,materializePackedTrajectoryFrame,packedTrajectoryAtomId,readPackedTrajectoryFrame,registerPackedTrajectorySource,type PackedTrajectoryAtom,type PackedTrajectoryFrame} from '../results/packed-trajectory-source';
import {decodeTrajectoryRecordMetadata,encodeTrajectoryRecordMetadata} from '../results/prepared-frame-record';
import {PROJECT_CHUNK_BYTES,type ProjectAssetReader,type ProjectAssetWriter} from './desktop-bridge';

type FrameHeader=PackedTrajectoryFrame['header'];
interface BinaryFrame {header:string;topology:number;offset:number;prefix?:string;suffixes?:number}
interface BinaryPage {assetId:string;bytes:number}
export interface PackedTrajectorySnapshot {
  schema:1;
  chunkBytes:number;
  pages:BinaryPage[];
  topologies:string[];
  suffixGroups:string[][];
  frames:BinaryFrame[];
}
const littleEndian=new Uint8Array(Uint16Array.of(1).buffer)[0]===1;
const restoredPackedSnapshots=new WeakMap<TrajectoryResult,{snapshot:PackedTrajectorySnapshot;reader:ProjectAssetReader}>();

/** Source readers already own and validate these exact coordinates. Persist
 * their pages without materializing the repeated atom objects or display graph. */
export async function encodePackedTrajectorySnapshot(result:TrajectoryResult,writer:Pick<ProjectAssetWriter,'write'|'writeRange'>):Promise<PackedTrajectorySnapshot|undefined>{
  if(!hasCanonicalPackedTrajectorySource(result)||!result.frames.length)return;
  const restored=restoredPackedSnapshots.get(result);
  if(restored){
    const pages:BinaryPage[]=[];
    for(const {assetId,bytes} of restored.snapshot.pages){
      const name=`${result.id}-coordinates-${pages.length}.bin`;
      const receipt=writer.writeRange&&restored.reader.readRange&&/^[a-f0-9]{64}$/.test(assetId)
        ?await writer.writeRange('trajectories',name,{bytes,sha256:assetId,readRange:(offset,length)=>restored.reader.readRange!(assetId,offset,length,bytes)})
        :await writer.write('trajectories',name,await restored.reader.read(assetId));
      if(!receipt.assetId)throw Error('项目轨迹坐标页写入回执不完整。');
      pages.push({assetId:receipt.assetId,bytes});
    }
    return {...restored.snapshot,pages};
  }
  const chunkBytes=Math.min(PROJECT_CHUNK_BYTES,Math.max(24,result.initialStructure.atoms.length*24*result.frames.length));
  const snapshot:PackedTrajectorySnapshot={schema:1,chunkBytes,pages:[],topologies:[],suffixGroups:[],frames:[]};
  const topologies=new Map<readonly PackedTrajectoryAtom[],number>(),suffixGroups=new Map<readonly string[],number>();
  let page:Uint8Array|undefined,used=0,offset=0;
  async function flush(){
    if(!used)return;
    const bytes=page!.subarray(0,used);
    const {assetId}=await writer.write('trajectories',`${result.id}-coordinates-${snapshot.pages.length}.bin`,bytes);
    if(!assetId)throw Error('项目轨迹坐标页写入回执不完整。');
    snapshot.pages.push({assetId,bytes:used});page=undefined;used=0;
  }
  for(let index=0;index<result.frames.length;index++){
    const frame=await readPackedTrajectoryFrame(result,index);
    if(!frame||!frame.topology.length||frame.coordinates.length!==3*frame.topology.length||frame.atomId&&!frame.atomIds)throw Error('项目轨迹缺少对应的源坐标或原子身份。');
    let topology=topologies.get(frame.topology);
    if(topology===undefined){topology=snapshot.topologies.length;topologies.set(frame.topology,topology);snapshot.topologies.push(encodeTrajectoryRecordMetadata(frame.topology));}
    const record:BinaryFrame={header:encodeTrajectoryRecordMetadata(frame.header),topology,offset};
    if(frame.atomIds){
      record.prefix=frame.atomIds.prefix;
      const suffixes=frame.atomIds.suffixes;
      if(suffixes){
        let group=suffixGroups.get(suffixes);
        if(group===undefined){group=snapshot.suffixGroups.length;suffixGroups.set(suffixes,group);snapshot.suffixGroups.push([...suffixes]);}
        record.suffixes=group;
      }
    }
    snapshot.frames.push(record);
    const coordinates=littleEndian?new Uint8Array(frame.coordinates.buffer,frame.coordinates.byteOffset,frame.coordinates.byteLength):new Uint8Array(frame.coordinates.byteLength);
    if(!littleEndian){const view=new DataView(coordinates.buffer);frame.coordinates.forEach((value,i)=>view.setFloat64(i*8,value,true));}
    if(!Number.isSafeInteger(offset+coordinates.byteLength))throw Error('项目轨迹坐标总范围无效。');
    for(let copied=0;copied<coordinates.byteLength;){
      page??=new Uint8Array(chunkBytes);
      const length=Math.min(chunkBytes-used,coordinates.byteLength-copied);
      page.set(coordinates.subarray(copied,copied+length),used);
      used+=length;copied+=length;
      if(used===chunkBytes)await flush();
    }
    offset+=coordinates.byteLength;
  }
  await flush();
  return snapshot;
}

/** Keep a single page near the active frame. Old JSON and conformer readers
 * keep their original sources and do not pass through this adapter. */
export function createPackedTrajectorySnapshotReader(snapshot:PackedTrajectorySnapshot,reader:ProjectAssetReader,frameCount:number){
  if(snapshot.schema!==1||!Number.isSafeInteger(snapshot.chunkBytes)||snapshot.chunkBytes<8||snapshot.chunkBytes>PROJECT_CHUNK_BYTES||snapshot.chunkBytes%8!==0||
    !Array.isArray(snapshot.pages)||!snapshot.pages.length||!Array.isArray(snapshot.topologies)||!Array.isArray(snapshot.suffixGroups)||
    !Array.isArray(snapshot.frames)||snapshot.frames.length!==frameCount)throw Error('项目轨迹二进制索引无效。');
  const sizes=snapshot.pages.map(({bytes,assetId},index)=>{
    if(!assetId||!Number.isSafeInteger(bytes)||bytes<8||bytes>snapshot.chunkBytes||bytes%8!==0||index<snapshot.pages.length-1&&bytes!==snapshot.chunkBytes)throw Error('项目轨迹坐标页范围无效。');
    return bytes;
  });
  const topologies=snapshot.topologies.map(value=>{
    const atoms=decodeTrajectoryRecordMetadata<PackedTrajectoryAtom[]>(value);
    if(!Array.isArray(atoms)||!atoms.length||atoms.some(atom=>!atom||typeof atom.element!=='string'||Object.values(atom).some(value=>value!==null&&typeof value==='object')))throw Error('项目轨迹拓扑索引无效。');
    return Object.freeze(atoms.map(atom=>Object.freeze(atom)));
  });
  let indexedBytes=0;
  for(const frame of snapshot.frames){
    const topology=topologies[frame.topology];
    if(!topology||!Number.isSafeInteger(frame.topology)||frame.offset!==indexedBytes||typeof frame.header!=='string'||
      frame.prefix!==undefined&&typeof frame.prefix!=='string'||frame.suffixes!==undefined&&(!Number.isSafeInteger(frame.suffixes)||frame.prefix===undefined||snapshot.suffixGroups[frame.suffixes]?.length!==topology.length))throw Error('项目轨迹帧索引无效。');
    indexedBytes+=24*topology.length;
  }
  if(!Number.isSafeInteger(indexedBytes)||sizes.reduce((sum,bytes)=>sum+bytes,0)!==indexedBytes)throw Error('项目轨迹二进制总长无效。');
  const suffixGroups=snapshot.suffixGroups.map(suffixes=>{
    if(!Array.isArray(suffixes)||suffixes.some(suffix=>typeof suffix!=='string'))throw Error('项目轨迹原子编号索引无效。');
    return Object.freeze([...suffixes]);
  });
  let closed=false,hotPage:{index:number;bytes:Uint8Array}|undefined,hotFrame:{index:number;frame:PackedTrajectoryFrame}|undefined;
  let registered:TrajectoryResult|undefined;
  const pendingPages=new Map<number,Promise<Uint8Array>>();
  const get=(index:number)=>hotFrame?.index===index?hotFrame.frame:undefined;
  function page(index:number):Promise<Uint8Array>{
    if(hotPage?.index===index)return Promise.resolve(hotPage.bytes);
    let pending=pendingPages.get(index);
    if(!pending){
      const descriptor=snapshot.pages[index];
      pending=reader.read(descriptor.assetId).then(bytes=>{
        if(closed)throw new DOMException('项目轨迹来源已关闭。','AbortError');
        if(bytes.byteLength!==descriptor.bytes)throw Error('项目轨迹坐标页不完整。');
        hotPage={index,bytes};return bytes;
      }).finally(()=>pendingPages.delete(index));
      pendingPages.set(index,pending);
    }
    return pending;
  }
  async function read(index:number,signal?:AbortSignal):Promise<PackedTrajectoryFrame>{
    assertResultNotAborted(signal);
    if(closed)throw Error('项目轨迹来源已关闭。');
    const cached=get(index);if(cached)return cached;
    if(!Number.isSafeInteger(index)||index<0||index>=snapshot.frames.length)throw Error('项目轨迹帧索引越界。');
    const descriptor=snapshot.frames[index],topology=topologies[descriptor.topology],length=24*topology.length;
    let pageIndex=Math.floor(descriptor.offset/snapshot.chunkBytes),position=descriptor.offset%snapshot.chunkBytes;
    let bytes=await page(pageIndex);assertResultNotAborted(signal);
    if(position+length<=bytes.length){bytes=bytes.subarray(position,position+length);if(bytes.byteOffset%8!==0)bytes=bytes.slice();}
    else{
      const complete=new Uint8Array(length);
      let copied=0;
      while(copied<length){
        const portion=bytes.subarray(position,position+length-copied);
        complete.set(portion,copied);copied+=portion.length;
        if(copied<length){bytes=await page(++pageIndex);position=0;assertResultNotAborted(signal);}
      }
      bytes=complete;
    }
    if(closed)throw new DOMException('项目轨迹来源已关闭。','AbortError');
    const coordinates=littleEndian?new Float64Array(bytes.buffer,bytes.byteOffset,length/8):new Float64Array(length/8);
    if(!littleEndian){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<coordinates.length;i++)coordinates[i]=view.getFloat64(i*8,true);}
    const header=decodeTrajectoryRecordMetadata<FrameHeader>(descriptor.header);
    if(!header||typeof header.id!=='string'||typeof header.format!=='string'||!Array.isArray(header.notes))throw Error('项目轨迹帧元数据无效。');
    const atomIds=descriptor.prefix===undefined?undefined:{prefix:descriptor.prefix,...(descriptor.suffixes===undefined?{}:{suffixes:suffixGroups[descriptor.suffixes]})};
    const frame={header,topology,coordinates,...(atomIds?{atomIds,atomId:packedTrajectoryAtomId(atomIds)}:{})};
    hotFrame={index,frame};return frame;
  }
  return {
    async readFrame(index:number,signal?:AbortSignal):Promise<Structure>{return materializePackedTrajectoryFrame(await read(index,signal));},
    register(result:TrajectoryResult){
      registerPackedTrajectorySource(result,get,{read,paged:()=>true,canonical:true});
      restoredPackedSnapshots.set(result,{snapshot,reader});
      registered=result;
    },
    dispose(){closed=true;hotPage=undefined;hotFrame=undefined;pendingPages.clear();if(registered)restoredPackedSnapshots.delete(registered);registered=undefined;},
  };
}
