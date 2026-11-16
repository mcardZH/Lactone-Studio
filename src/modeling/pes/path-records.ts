import type {PesFrame,PesPathRecord,PesRun} from './contracts';

export type PesPathRecordReader=(recordId:string,signal?:AbortSignal)=>Promise<readonly PesFrame[]>;
const aborted=()=>new DOMException('路径轮结构读取已取消。','AbortError');
const key=(frame:Pick<PesFrame,'id'|'seriesId'>)=>JSON.stringify([frame.seriesId,frame.id]);
export const pesPathRecordVersion=(record:PesPathRecord)=>JSON.stringify([record.id,record.seriesId,record.phase,record.step,record.frames,record.connections??null]);
export function validPesPathRecord(record:PesPathRecord):boolean{
  if(!record||!record.id||!record.seriesId||!record.phase||!Number.isSafeInteger(record.step)||!['initial','first-energy','interval','final'].includes(record.kind)||!Array.isArray(record.frames)||!record.frames.length)return false;
  const ids=new Set<string>();
  for(const frame of record.frames){if(!frame||!frame.id||ids.has(frame.id)||!frame.seriesId||!frame.phase||!Number.isSafeInteger(frame.step)||typeof frame.status!=='string'||
    frame.energyHartree!=null&&!Number.isFinite(frame.energyHartree)||frame.cv!==undefined&&(!Array.isArray(frame.cv)||!frame.cv.every(Number.isFinite))||Object.hasOwn(frame,'positions'))return false;ids.add(frame.id);}
  return record.connections===undefined||Array.isArray(record.connections)&&record.connections.every(pair=>Array.isArray(pair)&&pair.length===2&&pair.every(id=>ids.has(id)));
}
interface Entry{record:PesPathRecord;version:string;consumers:Set<object>;frames?:readonly PesFrame[];pending?:{abort:AbortController;promise:Promise<readonly PesFrame[]>}}
/** Raw coordinate ownership is independent from the UI snapshot and scientific
 * source. Only consumers keep a prepared complete round resident. */
export class PesPathRecordOwner {
  private entries=new Map<string,Entry>();
  private recordReaders=new Map<string,PesPathRecordReader>();
  private closed=false;
  private reads=0;
  private residentBytes=0;
  private peakResidentBytes=0;
  constructor(readonly atomCount:number,private readonly reader:PesPathRecordReader){
    if(!Number.isSafeInteger(atomCount)||atomCount<1)throw Error('路径轮缺少真实原子组成。');
  }
  update(records:readonly PesPathRecord[]):void{
    if(this.closed)return;
    for(const record of records){
      const version=pesPathRecordVersion(record),old=this.entries.get(record.id);
      if(old?.version===version){old.record=record;continue;}
      if(old)this.clear(old);
      this.entries.set(record.id,{record,version,consumers:old?.consumers??new Set()});
    }
  }
  private clear(entry:Entry){
    entry.pending?.abort.abort();entry.pending=undefined;
    if(entry.frames)this.residentBytes-=entry.frames.reduce((bytes,frame)=>bytes+frame.positions.length*3*8,0);
    entry.frames=undefined;
  }
  private entry(id:string){const entry=this.entries.get(id);if(this.closed||!entry)throw Error('该路径轮已关闭或不在当前结果索引中。');return entry;}
  get(recordId:string):readonly PesFrame[]|undefined{return this.closed?undefined:this.entries.get(recordId)?.frames;}
  frame(recordId:string,frameId:string):PesFrame|undefined{return this.get(recordId)?.find(frame=>frame.id===frameId);}
  /** Publish an immutable project source only after its index transaction commits. */
  setRecordReader(recordId:string,reader:PesPathRecordReader){if(this.closed)return;this.entry(recordId);this.recordReaders.set(recordId,reader);}
  acquire(recordId:string){
    const token={},entry=this.entry(recordId);entry.consumers.add(token);let released=false;
    const current=()=>{const active=this.entry(recordId);if(released||!active.consumers.has(token))throw aborted();return active;};
    return{
      get:()=>released?undefined:this.get(recordId),
      prepare:async(signal?:AbortSignal):Promise<readonly PesFrame[]>=>{
        signal?.throwIfAborted();const active=current();
        const shared=active.frames?Promise.resolve(active.frames):this.prepare(active);
        if(!signal)return shared.then(value=>{current();return value;});
        return new Promise((resolve,reject)=>{
          const cancel=()=>{cleanup();reject(aborted());},cleanup=()=>signal.removeEventListener('abort',cancel);
          signal.addEventListener('abort',cancel,{once:true});
          shared.then(value=>{cleanup();try{signal.throwIfAborted();current();resolve(value);}catch(error){reject(error);}},error=>{cleanup();reject(error);});
        });
      },
      release:()=>{if(released)return;released=true;const active=this.entries.get(recordId);active?.consumers.delete(token);if(active&&!active.consumers.size)this.clear(active);},
    };
  }
  private prepare(entry:Entry):Promise<readonly PesFrame[]>{
    if(entry.pending)return entry.pending.promise;
    const abort=new AbortController(),pending={abort,promise:undefined as unknown as Promise<readonly PesFrame[]>};
    entry.pending=pending;this.reads++;
    pending.promise=Promise.resolve().then(()=>(this.recordReaders.get(entry.record.id)??this.reader)(entry.record.id,abort.signal)).then(frames=>{
      abort.signal.throwIfAborted();
      if(this.closed||entry.pending!==pending||this.entries.get(entry.record.id)!==entry)throw aborted();
      const expected=entry.record.frames;
      if(!Array.isArray(frames)||frames.length!==expected.length||frames.some((frame:PesFrame,index:number)=>!frame||key(frame)!==key(expected[index])||!Array.isArray(frame.positions)||frame.positions.length!==this.atomCount||
        frame.positions.some((position:PesFrame['positions'][number])=>!Array.isArray(position)||position.length!==3||!position.every(Number.isFinite))||
        expected[index].energyHartree!=null&&frame.energyHartree!==expected[index].energyHartree))
        throw Error('路径轮的结构、能量或原子对应与来源索引不一致，原始数据已保留。');
      entry.frames=frames;
      this.residentBytes+=frames.reduce((bytes,frame)=>bytes+frame.positions.length*3*8,0);this.peakResidentBytes=Math.max(this.peakResidentBytes,this.residentBytes);
      return frames;
    }).finally(()=>{if(entry.pending===pending)entry.pending=undefined;});
    return pending.promise;
  }
  diagnostics(){return{records:this.entries.size,reads:this.reads,residentCoordinateBytes:this.residentBytes,peakResidentCoordinateBytes:this.peakResidentBytes,
    preparedRounds:[...this.entries.values()].filter(entry=>entry.frames).length,pendingReads:[...this.entries.values()].filter(entry=>entry.pending).length,
    consumers:[...this.entries.values()].reduce((sum,entry)=>sum+entry.consumers.size,0)};}
  dispose(){if(this.closed)return;this.closed=true;for(const entry of this.entries.values())this.clear(entry);this.entries.clear();this.recordReaders.clear();}
}
const owners=new WeakMap<PesRun,PesPathRecordOwner>();
export function pesPathRecords(run:PesRun):readonly PesPathRecord[]{return run.pathRecords??run.result?.pathRecords??[];}
export function bindPesPathRecordOwner(run:PesRun,owner:PesPathRecordOwner){owner.update(pesPathRecords(run));owners.set(run,owner);return run;}
export function transferPesPathRecordOwner(previous:PesRun,next:PesRun){const owner=owners.get(previous);if(owner)bindPesPathRecordOwner(next,owner);return next;}
export function pesPathRecordOwner(run:PesRun){return owners.get(run);}
export function acquirePesPathRecord(run:PesRun,recordId:string){const owner=owners.get(run);if(!owner)throw Error('该路径轮尚未绑定可读取的科学来源。');return owner.acquire(recordId);}
export async function readPesPathRecord(run:PesRun,recordId:string,signal?:AbortSignal){const lease=acquirePesPathRecord(run,recordId);try{return await lease.prepare(signal);}finally{lease.release();}}
