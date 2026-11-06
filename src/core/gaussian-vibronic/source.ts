import { FchkReader, fchkNumber } from '../fchk-reader';
import { fchkTextRecords, fchkRecordText, looksLikeFchk, streamFchkRecords, type FchkRecord } from '../fchk-records';
import { atomicNumber } from '../elements';
import { GaussianOutputReader } from '../gaussian-reader';
import { gaussianRouteTokens } from '../gaussian-source';
import type { Atom } from '../types';
import type { VibronicEvidence, VibronicFileIdentity, VibronicState } from './types';
import { VibronicSha256 } from './sha256-stream';
import { selectVibronicLogJob } from './jobs';

const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const numbers = (text: string): number[] => text.trim().split(/\s+/).filter(Boolean).map(v => numberToken.test(v) ? Number(v.replace(/[dD]/, 'e')) : NaN);

export function expectedModeCount(atoms: Atom[]): number {
  if (atoms.length < 2) return 0;
  const a = atoms[0], far = atoms.find(b => Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z)>1e-8);
  if (!far) return 0;
  const v = [far.x-a.x,far.y-a.y,far.z-a.z], length = Math.hypot(...v);
  const linear = atoms.every(b => {
    const w=[b.x-a.x,b.y-a.y,b.z-a.z];
    return Math.hypot(v[1]*w[2]-v[2]*w[1],v[2]*w[0]-v[0]*w[2],v[0]*w[1]-v[1]*w[0])/length<1e-5;
  });
  return 3*atoms.length-(linear?5:6);
}

/** FCHK arrays are counted, including skipped arrays, to detect truncated evidence. */
function fchkArrays(records: FchkRecord[]): { arrays: Map<string, number[]>; errors: string[] } {
  const arrays = new Map<string, number[]>(), errors: string[]=[];
  const wanted = new Set(['Real atomic weights','Cartesian Force Constants','Vib-E2','Vib-Modes']);
  for (let i=2;i<records.length;i++) {
    const field=records[i].field;
    if (field?.count===undefined) continue;
    const {label,type,count}=field;
    if (!Number.isSafeInteger(count)||count<0) {errors.push(`FCHK ${label} 数组长度声明无效。`);break;}
    let seen=0;const values:number[]=[];
    while (seen<count && i+1<records.length) {
      if (records[i+1].field) break;
      const record=records[++i],line=record.text;
      if (type==='C'||type==='H') { seen+=record.character?.count??0;continue; }
      const parts=line.trim().split(/\s+/).filter(Boolean);seen+=parts.length;
      if (type==='L'?parts.some(v=>!/^[TF]$/.test(v)):parts.some(v=>fchkNumber(v)===null||type==='I'&&!Number.isSafeInteger(fchkNumber(v)))) errors.push(`FCHK ${label} 包含无效数值。`);
      if (wanted.has(label)) values.push(...parts.map(v=>fchkNumber(v)??NaN));
    }
    if (seen!==count) errors.push(`FCHK ${label} 数组不完整（${seen}/${count}）。`);
    if(wanted.has(label)) {if(arrays.has(label))errors.push(`FCHK ${label} 重复。`);arrays.set(label,values);}
  }
  return {arrays,errors};
}

function parseLogModes(lines:string[], atoms:Atom[]): { frequencies:number[]; complete:boolean } {
  const frequencies:number[]=[];let complete=true;
  for(let i=0;i<lines.length;i++) {
    const match=lines[i].match(/^\s*Frequencies\s+--\s+(.+)$/);if(!match)continue;
    const values=numbers(match[1]);frequencies.push(...values);
    let j=i+1;
    while(j<lines.length && j<i+14 && !/^\s*Atom\s+AN\b/.test(lines[j]) && !/Frequencies\s+--/.test(lines[j]))j++;
    if(j>=lines.length||!/^\s*Atom\s+AN\b/.test(lines[j])) {complete=false;continue;}
    for(let atom=1;atom<=atoms.length;atom++) {
      const row=numbers(lines[j+atom]??'');
      if(row.length!==2+3*values.length||row[0]!==atom||row[1]!==atomicNumber(atoms[atom-1].element)||!row.every(Number.isFinite))complete=false;
    }
  }
  return {frequencies,complete:complete&&frequencies.length>0};
}

/** Reads one explicitly selected complete frequency job; never merges frequency/root tables across jobs. */
export function parseVibronicEvidence(identity:VibronicFileIdentity,sourceText:string,options?:{jobIndex?:number}):VibronicEvidence {
  const format=looksLikeFchk(sourceText)?'fchk':'log';
  const selection=format==='log'?selectVibronicLogJob(sourceText,options?.jobIndex):undefined;
  const text=selection?.text??sourceText,lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
  const reader=format==='fchk'?new FchkReader():new GaussianOutputReader();
  const records=format==='fchk'?fchkTextRecords(text):undefined;
  if(records&&reader instanceof FchkReader)for(const record of records)reader.consume(record.text,{sourceLine:record.sourceLine,byteProven:true});
  else lines.forEach(line=>reader.consume(line));
  const structures=reader.finish(identity.name),structure=structures[0];
  if(structure.charge===null||structure.multiplicity===null)throw new Error('来源缺少电荷或多重度。');
  const modeCount=expectedModeCount(structure.atoms),errors:string[]=[...(selection?.errors??[])],warnings:string[]=[...(selection?.warnings??[])];
  if(reader instanceof FchkReader&&reader.incomplete)errors.push('FCHK含损坏或未完成字段，保留可读结构但不能作为完整振电计算来源。');
  for(const issue of structure.gaussianSource?.issues??[])if(issue.severity==='conflict')errors.push(issue.message);
  if(structure.gaussianSource?.frozenAtoms?.length)errors.push('来源含冻结原子，首批完整两态振动路线不接受部分Hessian。');
  const route=selection?.effectiveRoute??structure.sourceRoute??'',td=gaussianRouteTokens(route).find(t=>/^(?:td|cis)(?:\b|=|\()/i.test(t));
  const root=td?Number(td.match(/\broot\s*=\s*(\d+)/i)?.[1]??NaN):null;
  let masses:number[]=[],frequencies:number[]=[],completeModes=false,completeHessian=false,normalTermination=false,transitionDipole:[number,number,number]|null=null;
  if(format==='fchk') {
    const data=fchkArrays(records!);errors.push(...data.errors);
    masses=data.arrays.get('Real atomic weights')??[];
    frequencies=(data.arrays.get('Vib-E2')??[]).slice(0,modeCount);
    completeModes=data.arrays.get('Vib-Modes')?.length===3*structure.atoms.length*modeCount;
    completeHessian=data.arrays.get('Cartesian Force Constants')?.length===(3*structure.atoms.length)*(3*structure.atoms.length+1)/2;
    warnings.push('FCHK可检查力常数、模式、质量和坐标；它不是二进制CHK，也不证明Gaussian正常终止。');
  } else {
    const normalCount=(text.match(/Normal termination of Gaussian/g)??[]).length;
    if(!/Gaussian\s+16\b/.test(text)||/Gaussian\s+(?:09|03)\b/.test(text))errors.push('本入口的ReadFCHT语法与频率前提按Gaussian 16核定；来源版本不是可识别G16。');
    if(normalCount!==1||(text.match(/Entering Gaussian System/g)??[]).length>1||/Error termination|Link1:.*Proceeding to internal job step|--Link1--/.test(text))errors.push('须选择一个正常终止的独立频率作业；多作业或错误结束不能合并证据。');
    normalTermination=normalCount===1&&!/Error termination/.test(text);
    const modeData=parseLogModes(lines,structure.atoms);frequencies=modeData.frequencies;completeModes=modeData.complete;
    masses=Array(structure.atoms.length).fill(NaN);
    for(const line of lines) {const m=line.match(/Atom\s+(\d+)\s+has atomic number\s+\d+\s+and mass\s+([\d.EeDd+-]+)/);if(m)masses[Number(m[1])-1]=Number(m[2].replace(/[dD]/,'e'));}
    if(td && !Number.isSafeInteger(root))errors.push('激发态频率Route未明确Root；请提供含明确目标根的原作业证据。');
    if(root) {
      for(let i=0;i<lines.length;i++)if(/Ground to excited state transition electric dipole moments/i.test(lines[i])) {
        let inRows=false;
        for(let j=i+1;j<lines.length;j++) {
          const line=lines[j].trim();
          if(!inRows&&(!line||/^state\s+X\s+Y\s+Z/i.test(line)))continue;
          const row=numbers(line);
          if(row.length<5||!row.every(Number.isFinite)||!Number.isSafeInteger(row[0])||row[0]<1)break;
          inRows=true;
          if(row[0]===root){transitionDipole=row.slice(1,4) as [number,number,number];break;}
        }
      }
    }
  }
  if(modeCount<1)errors.push('缺少可定义完整振动模式的分子结构。');
  if(frequencies.length!==modeCount||!frequencies.every(Number.isFinite))errors.push(`频率数不完整：需${modeCount}个，读到${frequencies.length}个。`);
  if(frequencies.some(v=>v<=0))errors.push('来源含虚频或零频；本路线要求两个极小点的完整正频率，不自动删除模式。');
  if(!completeModes)errors.push('缺少完整正常模式向量。');
  if(masses.length!==structure.atoms.length||!masses.every(v=>Number.isFinite(v)&&v>0))errors.push('缺少完整逐原子质量，不能推定同位素一致。');
  if(format==='fchk'&&!completeHessian)errors.push('FCHK缺少完整Cartesian Force Constants矩阵。');
  const routeComplete=format==='log'||!structure.gaussianSource?.issues.some(issue=>issue.code==='fchk-route-missing');
  return {identity,format,atoms:structure.atoms,charge:structure.charge,multiplicity:structure.multiplicity,route,routeComplete,masses,frequencies,modeCount,completeModes,completeHessian,normalTermination,root:Number.isSafeInteger(root)?root:null,transitionDipole,errors,warnings,selectedJob:selection?.selectedJob};
}

export function stateBinding(state:VibronicState):string {
  return JSON.stringify([state.log?.identity,state.log?.selectedJob,state.fchk?.identity,state.checkpoint]);
}
export function pairBinding(initial:VibronicState,final:VibronicState):string {return JSON.stringify([stateBinding(initial),stateBinding(final)]);}

function checkCancelled(signal?:AbortSignal):void {if(signal?.aborted)throw new Error('已取消来源读取。');}
export async function identifyVibronicFile(file:Blob&{name:string},signal?:AbortSignal):Promise<VibronicFileIdentity> {
  if(!Number.isSafeInteger(file.size)||file.size<1)throw new Error('单个来源须为非空且字节长度可精确表示。');
  const hash=new VibronicSha256(),chunkSize=256*1024;
  for(let offset=0;offset<file.size;offset+=chunkSize){checkCancelled(signal);const chunk=new Uint8Array(await file.slice(offset,Math.min(file.size,offset+chunkSize)).arrayBuffer());checkCancelled(signal);hash.update(chunk);if(offset+chunkSize<file.size)await new Promise(resolve=>setTimeout(resolve,0));}
  checkCancelled(signal);return {name:file.name,size:file.size,sha256:hash.digest()};
}
export async function readVibronicText(file:Blob,signal?:AbortSignal):Promise<string> {
  if(!Number.isSafeInteger(file.size)||file.size<1)throw new Error('文本来源须为非空且字节长度可精确表示。');
  checkCancelled(signal);
  const prefix=new TextDecoder().decode(await file.slice(0,65536).arrayBuffer());checkCancelled(signal);
  if(looksLikeFchk(prefix)){
    // Parsing representation only: identity remains the hash of the original
    // bytes. Opaque H is masked without changing record widths or line breaks.
    const records:string[]=[];
    for await(const record of streamFchkRecords(file,{signal}))records.push(fchkRecordText(record)+'\n');
    return records.join('');
  }
  const decoder=new TextDecoder('utf-8',{fatal:true}),chunks:string[]=[],chunkSize=256*1024;
  for(let offset=0;offset<file.size;offset+=chunkSize){checkCancelled(signal);const bytes=await file.slice(offset,Math.min(file.size,offset+chunkSize)).arrayBuffer();checkCancelled(signal);chunks.push(decoder.decode(bytes,{stream:true}));if(offset+chunkSize<file.size)await new Promise(resolve=>setTimeout(resolve,0));}
  chunks.push(decoder.decode());checkCancelled(signal);return chunks.join('');
}
