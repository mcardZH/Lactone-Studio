import type { Structure } from '../core/types';
import { assertResultNotAborted, trajectoryIndices, type TrajectoryRange, type TrajectoryResult } from './contracts';
import type { EnergySeries } from './energy';
import {getPreparedTrajectoryFrame} from './prepared-trajectory';

export interface ResultByteSink { write(bytes: Uint8Array | Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export interface ResultExportOptions { signal?: AbortSignal; sink?: ResultByteSink; comment?:string; onProgress?(completed: number, total: number): void }
const quote = (value: string) => JSON.stringify(value.replace(/[\r\n]/g, ' '));
function numeric(value: number): string {
  if (!Number.isFinite(value)) throw new Error('导出包含非有限数值。');
  return String(value);
}
function provenance(structure: Structure) {
  return structure.atoms.map((atom, index) => ({ id: atom.id ?? `${structure.id}:atom:${index + 1}`, sourceIndex: atom.sourceIndex ?? index + 1 }));
}
function geometry(structure: Structure, extended: boolean): string {
  if (!structure.atoms.length) throw new Error('不能导出空结构帧。');
  const identities = provenance(structure);
  return structure.atoms.map((atom, index) => {
    if (!/^[A-Z][a-z]?$/.test(atom.element)) throw new Error('导出包含无效元素。');
    if (!Number.isSafeInteger(identities[index].sourceIndex)) throw new Error('导出包含无效原子来源序号。');
    return `${atom.element} ${numeric(atom.x)} ${numeric(atom.y)} ${numeric(atom.z)}`
      + (extended ? ` ${encodeURIComponent(identities[index].id)} ${identities[index].sourceIndex}` : '');
  }).join('\n');
}

/** Coordinates in the result contract are Cartesian angstrom; missing metadata stays missing. */
export async function exportTrajectoryXYZ(result: TrajectoryResult, range: TrajectoryRange,
  options: ResultExportOptions & { format?: 'xyz' | 'extxyz' } = {}): Promise<Blob> {
  const indices = trajectoryIndices(range, result.frames.length), chunks: BlobPart[] = []; let completed=0;
  for (const index of indices) {
    assertResultNotAborted(options.signal);
    const structure = getPreparedTrajectoryFrame(result,index)?.raw ?? await result.getFrame(index, options.signal);
    assertResultNotAborted(options.signal);
    const frame = result.frames[index];
    const fields = [`source=${quote(result.source.name)}`, `frame=${index + 1}`, `job=${result.jobIndex}`, 'coordinate_unit="angstrom"'];
    if (structure.charge !== null) {
      if (!Number.isSafeInteger(structure.charge)) throw new Error('导出电荷必须为整数。');
      fields.push(`charge=${structure.charge}`);
    }
    if (structure.multiplicity !== null) {
      if (!Number.isSafeInteger(structure.multiplicity) || structure.multiplicity < 1) throw new Error('导出自旋多重度无效。');
      fields.push(`multiplicity=${structure.multiplicity}`);
    }
    if (frame.sourceStep !== null) fields.push(`step=${frame.sourceStep}`);
    if (frame.time) fields.push(`time=${numeric(frame.time.value)}`, `time_unit=${quote(frame.time.unit)}`);
    if (frame.energy) fields.push(`energy=${numeric(frame.energy.value)}`, `energy_unit=${quote(frame.energy.unit)}`);
    if (options.format === 'extxyz') {
      fields.push('Properties=species:S:1:pos:R:3:id:S:1:source_index:I:1');
      if (structure.cell) {
        fields.push(`Lattice="${structure.cell.vectors.flat().map(numeric).join(' ')}"`,
          `pbc="${structure.cell.pbc.map(value => value ? 'T' : 'F').join(' ')}"`);
        if (structure.cell.origin) fields.push(`Origin="${structure.cell.origin.map(numeric).join(' ')}"`);
      }
    } else fields.push(`builder_atoms=${encodeURIComponent(JSON.stringify(provenance(structure)))}`);
    const chunk=`${structure.atoms.length}\n${fields.join(' ')}${options.comment?` ${options.comment}`:''}\n${geometry(structure, options.format === 'extxyz')}\n`;
    if(options.sink)await options.sink.write(new Blob([chunk]));else chunks.push(chunk);
    options.onProgress?.(++completed, indices.length);
  }
  assertResultNotAborted(options.signal);
  return new Blob(chunks, { type: 'chemical/x-xyz;charset=utf-8' });
}

/** Caller passes the exact plotted series; no second energy conversion/reference calculation. */
export function exportResultData(result: TrajectoryResult, range: TrajectoryRange, series?: EnergySeries): { txt: string; json: string } {
  const indices = trajectoryIndices(range, result.frames.length);
  const points = new Map(series?.points.map(point => [point.index, point]));
  const energyDisplay = series ? { unit: series.unit, relative: series.relative, reference: series.reference,
    referenceIndex: series.referenceIndex, referenceValue: series.referenceValue } : null;
  const frames = indices.map(index => ({ ...result.frames[index], frameNumber: index + 1,
    displayEnergy: series ? { value: points.get(index)?.value ?? null, unit: series.unit } : null }));
  const document = { schema: 'sciyue-result-data', version: 1, resultId: result.id, label: result.label,
    kind: result.kind, engine: result.engine, source: result.source, jobIndex: result.jobIndex,
    status: result.status, messages: result.messages, coordinateUnit: 'angstrom', range, energyDisplay, frames,
    ...(result.scientific ? { scientific: result.scientific } : {}) };
  const cell = (value: unknown) => value === null || value === undefined ? '' : String(value).replace(/[\t\r\n]/g, ' ');
  const rows = frames.map(frame => [frame.frameNumber, frame.sourceStep, frame.time?.value, frame.time?.unit,
    frame.energy?.value, frame.energy?.unit, frame.displayEnergy?.value, frame.displayEnergy?.unit,
    frame.sourceLine, JSON.stringify(frame.convergence)].map(cell).join('\t'));
  const txt = [`# Ester Studio result data v1`, `# source: ${JSON.stringify(result.source)}`,
    `# result: ${JSON.stringify({ id: result.id, kind: result.kind, engine: result.engine, jobIndex: result.jobIndex, status: result.status })}`,
    `# range (zero-based inclusive): ${JSON.stringify(range)}`, `# energy_display: ${JSON.stringify(energyDisplay)}`,
    '# Missing values are empty; frame is one-based; source units are retained.',
    ...(result.scientific ? [`# scientific metadata and printed properties: see paired JSON; original source units and frame associations retained.`] : []),
    'frame\tsource_step\ttime\ttime_unit\tenergy_raw\tenergy_raw_unit\tenergy_display\tenergy_display_unit\tsource_line\tconvergence_json', ...rows, ''].join('\n');
  return { txt, json: JSON.stringify(document, null, 2) + '\n' };
}

/** Portable ZIP store writer: UTF-8 names, deterministic metadata, and CRC-32. */
const crcTable=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=(value>>>1)^(0xedb88320&-(value&1));return value>>>0;});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc=(crc>>>8)^crcTable[(crc^byte)&255];
  return (crc ^ 0xffffffff) >>> 0;
}
export function createStoredZip(files: readonly { name: string; bytes: Uint8Array }[]): Blob {
  const writer=new StoredZipWriter();for(const file of files)writer.add(file.name,file.bytes);return writer.finish();
}

/** Incremental store writer. ZIP64 extends the actual ZIP32 format limits; numeric overflow still fails. */
export class StoredZipWriter {
  private parts:BlobPart[]=[]; private directory:Uint8Array<ArrayBuffer>[]=[]; private names=new Set<string>();
  private offset=0; private directorySize=0; private finished=false;
  private advance(bytes:number){if(!Number.isSafeInteger(this.offset+bytes))throw Error('ZIP大小超出可精确表示范围。');this.offset+=bytes;}
  add(filename:string,bytes:Uint8Array):void{
    if(this.finished)throw Error('ZIP已结束。');
    if(!filename||/(^|\/)\.\.($|\/)|^[\/]|[\\\x00]/.test(filename)||this.names.has(filename))throw Error('ZIP文件名无效或重复。');
    const name=new TextEncoder().encode(filename),size=bytes.byteLength,crc=crc32(bytes),largeSize=size>=0xffffffff,largeOffset=this.offset>=0xffffffff;
    if(name.length>65535)throw Error('ZIP文件名超出格式支持范围。');this.names.add(filename);
    const extra=(includeOffset:boolean)=>{const length=(largeSize?16:0)+(includeOffset&&largeOffset?8:0);if(!length)return new Uint8Array(0);const value=new Uint8Array(4+length),view=new DataView(value.buffer);view.setUint16(0,1,true);view.setUint16(2,length,true);let position=4;if(largeSize){view.setBigUint64(position,BigInt(size),true);view.setBigUint64(position+8,BigInt(size),true);position+=16;}if(includeOffset&&largeOffset)view.setBigUint64(position,BigInt(this.offset),true);return value;};
    const localExtra=extra(false),centralExtra=extra(true),version=largeSize||largeOffset?45:20;
    const local=new Uint8Array(30+name.length+localExtra.length),lv=new DataView(local.buffer);
    lv.setUint32(0,0x04034b50,true);lv.setUint16(4,version,true);lv.setUint16(6,0x800,true);lv.setUint16(12,33,true);lv.setUint32(14,crc,true);lv.setUint32(18,largeSize?0xffffffff:size,true);lv.setUint32(22,largeSize?0xffffffff:size,true);lv.setUint16(26,name.length,true);lv.setUint16(28,localExtra.length,true);local.set(name,30);local.set(localExtra,30+name.length);
    const central=new Uint8Array(46+name.length+centralExtra.length),cv=new DataView(central.buffer);
    cv.setUint32(0,0x02014b50,true);cv.setUint16(4,version,true);cv.setUint16(6,version,true);cv.setUint16(8,0x800,true);cv.setUint16(14,33,true);cv.setUint32(16,crc,true);cv.setUint32(20,largeSize?0xffffffff:size,true);cv.setUint32(24,largeSize?0xffffffff:size,true);cv.setUint16(28,name.length,true);cv.setUint16(30,centralExtra.length,true);cv.setUint32(42,largeOffset?0xffffffff:this.offset,true);central.set(name,46);central.set(centralExtra,46+name.length);
    this.parts.push(local,new Blob([bytes as Uint8Array<ArrayBuffer>]));this.directory.push(central);this.advance(local.byteLength+size);this.directorySize+=central.byteLength;
  }
  takeParts():BlobPart[]{const output=this.parts;this.parts=[];return output;}
  finishParts():BlobPart[]{
    if(this.finished)throw Error('ZIP已结束。');this.finished=true;
    const count=this.directory.length,offset=this.offset,size=this.directorySize,large=count>=65535||offset>=0xffffffff||size>=0xffffffff;
    if(!Number.isSafeInteger(offset+size+98))throw Error('ZIP大小超出可精确表示范围。');
    for(const entry of this.directory)this.parts.push(entry);this.directory=[];
    if(large){const record=new Uint8Array(56),v=new DataView(record.buffer);v.setUint32(0,0x06064b50,true);v.setBigUint64(4,44n,true);v.setUint16(12,45,true);v.setUint16(14,45,true);v.setBigUint64(24,BigInt(count),true);v.setBigUint64(32,BigInt(count),true);v.setBigUint64(40,BigInt(size),true);v.setBigUint64(48,BigInt(offset),true);const locator=new Uint8Array(20),l=new DataView(locator.buffer);l.setUint32(0,0x07064b50,true);l.setBigUint64(8,BigInt(offset+size),true);l.setUint32(16,1,true);this.parts.push(record,locator);}
    const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,large?65535:count,true);v.setUint16(10,large?65535:count,true);v.setUint32(12,large?0xffffffff:size,true);v.setUint32(16,large?0xffffffff:offset,true);this.parts.push(end);this.names.clear();return this.takeParts();
  }
  finish():Blob{return new Blob(this.finishParts(),{type:'application/zip'});}
}
