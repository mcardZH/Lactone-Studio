import { parseStructures } from './parsers';
import { parseOrcaInput, referencedXyz } from './orca-readers';
import { QuantumOutputReader } from './gaussian-reader';
import type { Structure } from './types';
import { FchkReader } from './fchk-reader';
import { looksLikeFchk,streamFchkRecords } from './fchk-records';
import { gaussianRouteTokens } from './gaussian-source';
import { parsePeriodicStructures } from './periodic-parsers';
export type StructureImportFile = Pick<File, 'name' | 'size' | 'text' | 'stream'>;
async function consumeLines(file:StructureImportFile,consume:(line:string)=>boolean|void):Promise<void>{
  const reader=file.stream().getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let pending='';
  try{while(true){const {value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});if(pending.includes('\0'))throw new Error('文件含二进制/UTF-16内容，请另存UTF-8文本。');const lines=pending.split('\n');pending=lines.pop()??'';for(const line of lines){if(consume(line.replace(/\r$/,''))===true){await reader.cancel();return;}}if(done){if(pending)consume(pending);return;}}}finally{try{await reader.cancel();}finally{reader.releaseLock();}}
}
async function readFchk(file:StructureImportFile):Promise<Structure[]>{
  const reader=new FchkReader();for await(const record of streamFchkRecords(file))reader.consume(record.text,{sourceLine:record.sourceLine,byteProven:true});return reader.finish(file.name);
}
async function isFchkFile(file:StructureImportFile):Promise<boolean>{
 const reader=file.stream().getReader(),parts:Uint8Array[]=[];let length=0;
 try{while(length<65536){const next=await reader.read();if(next.done)break;const part=next.value.subarray(0,65536-length);parts.push(part);length+=part.length;}const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return looksLikeFchk(new TextDecoder().decode(bytes));}
 finally{try{await reader.cancel();}finally{reader.releaseLock();}}
}
async function readGaussianFile(file:StructureImportFile):Promise<Structure[]>{
  if(/\.fch(?:k)?$/i.test(file.name)||await isFchkFile(file))return readFchk(file);
  if(/\.(out|log)$/i.test(file.name)){const reader=new QuantumOutputReader();await consumeLines(file,line=>reader.consume(line));return reader.finishAll(file.name);}
  return parseStructures(await file.text(),file.name);
}
const stem=(name:string)=>name.replace(/\.[^.]+$/,'').toLowerCase();
function identicalGeometry(a:Structure,b:Structure):boolean{return a.charge===b.charge&&a.multiplicity===b.multiplicity&&a.atoms.length===b.atoms.length&&a.atoms.every((atom,i)=>atom.element===b.atoms[i].element&&Math.hypot(atom.x-b.atoms[i].x,atom.y-b.atoms[i].y,atom.z-b.atoms[i].z)<1e-5);}
/** Only exact same-stem, same-frame/state sources may supply one another's missing metadata. */
export function reconcileGaussianSources(structures:Structure[]):Structure[]{
  return structures.map(structure=>{
    if(!structure.gaussianSource||structure.gaussianSource.format==='gjf')return structure;
    const candidates=structures.filter(other=>other!==structure&&other.gaussianSource?.format==='gjf'&&stem(other.name)===stem(structure.name));
    if(!candidates.length)return structure;const exact=candidates.filter(other=>identicalGeometry(other,structure));
    const result=structuredClone(structure),source=result.gaussianSource!;
    if(exact.length!==1){source.issues.push({code:'paired-frame-unproven',message:'同名输入/输出文件未能唯一证明同一原子顺序、坐标帧和电子态；不借用另一文件的冻结/设置。请单独选择来源。',field:'geometry',severity:'conflict'});return result;}
    const donor=exact[0].gaussianSource!,a=source.settings,b=donor.settings;
    const norm=(value:unknown)=>typeof value==='string'?value.toLowerCase().replace(/[()\s]/g,'').replace(/^integral=/,'int='):value;
    const fullRoute=Boolean(source.route)&&!source.issues.some(i=>i.code==='fchk-route-missing');
    const conflicts=['method','customMethod','basis','unrestricted'].filter(key=>!(key==='basis'&&source.routeOverrides.basisKeyword&&source.routeOverrides.basisKeyword===donor.routeOverrides.basisKeyword)&&a[key as keyof typeof a]!==undefined&&b[key as keyof typeof b]!==undefined&&norm(a[key as keyof typeof a])!==norm(b[key as keyof typeof b]));
    if(fullRoute){for(const key of ['dispersion','solvent','solventModel','nosymm'] as const)if(norm(a[key])!==norm(b[key]))conflicts.push(key);
      for(const key of ['scf','integration','solvent','angular','fForm'] as const)if(norm(source.routeOverrides[key])!==norm(donor.routeOverrides[key]))conflicts.push('route.'+key);
      const canonicalRoute=(route:string)=>gaussianRouteTokens(route).map(token=>norm(token) as string).sort().join(' ');
      if(canonicalRoute(source.route)!==canonicalRoute(donor.route))conflicts.push('completeRoute/task/stateOptions');
    }
    if(source.routeOverrides.basisTail&&donor.routeOverrides.basisTail&&norm(source.routeOverrides.basisTail)!==norm(donor.routeOverrides.basisTail))conflicts.push('basisTail');
    if(source.fragments&&donor.fragments&&JSON.stringify(source.fragments)!==JSON.stringify(donor.fragments))conflicts.push('fragmentStates');
    if(source.frozenAtoms!==null&&JSON.stringify(source.frozenAtoms)!==JSON.stringify(donor.frozenAtoms))conflicts.push('frozenAtoms');
    if(source.coordinates!==null&&JSON.stringify(source.coordinates)!==JSON.stringify(donor.coordinates))conflicts.push('coordinates');
    if(conflicts.length){
      source.issues.push({code:'paired-level-conflict',message:`同帧Gaussian文件科学设置冲突（${conflicts.join(', ')}）；不自动合并，保留各自来源。`,field:'method',severity:'conflict'});return result;
    }
    result.gaussianSources=[structuredClone(donor),structuredClone(source)];
    const resolved=['constraints-unknown','fchk-route-missing','method-missing','basis-tail-missing','fchk-ecp'];
    result.gaussianSource={...structuredClone(donor),id:source.id,fileName:source.fileName,format:source.format,jobIndex:source.jobIndex,routeOverrides:{...structuredClone(donor.routeOverrides),sourceId:source.id},issues:[...source.issues.filter(i=>!resolved.includes(i.code)),...donor.issues,{code:'paired-exact-frame',message:`已用同名、逐原子坐标和电子态一致的 ${exact[0].name} 补齐输入元数据；FCHK仍不能替代CHK。`,field:'route',severity:'warning'}]};
    result.sourceRoute=donor.route;return result;
  });
}
export async function importStructureFiles(files:StructureImportFile[]):Promise<Structure[]>{
  if(!files.length)throw new Error('没有选择文件。');
  for(const file of files)if(!Number.isSafeInteger(file.size)||file.size<0)throw new Error('来源文件字节数无效。');
  if(files.length>1&&files.every(file=>/\.(gjf|com|fch|fchk|out|log)$/i.test(file.name))){const structures:Structure[]=[];for(const file of files)structures.push(...await readGaussianFile(file));return reconcileGaussianSources(structures);}
  const main=files.find(file=>/\.(?:inp|restart)(?:-\d+)?$/i.test(file.name))??files[0];
  if(/\.fch(?:k)?$/i.test(main.name)||await isFchkFile(main))return readFchk(main);
  if(/\.(out|log)$/i.test(main.name)){const reader=new QuantumOutputReader();await consumeLines(main,line=>reader.consume(line));return reader.finishAll(main.name);}
  const text=await main.text();
  if (/\.(?:inp|restart)(?:-\d+)?$/i.test(main.name) && /^\s*&(?:SUBSYS|FORCE_EVAL)\b/im.test(text)) {
    const external:Record<string,string>={};
    for(const file of files.filter(file=>file!==main)){
      if(Object.keys(external).some(name=>name.toLowerCase()===file.name.toLowerCase()))throw new Error('依赖文件名重复：'+file.name);
      external[file.name]=await file.text();
    }
    const periodic=parsePeriodicStructures(text,main.name,external);if(periodic)return periodic;
  }
  if(/\.inp$/i.test(main.name)){
    const external:Record<string,Structure[]>={};for(const name of referencedXyz(text)){const matches=files.filter(file=>file!==main&&file.name.toLowerCase()===name.toLowerCase());if(matches.length!==1)throw new Error('请将INP引用的XYZ一起选择：'+name);const file=matches[0];external[file.name]=parseStructures(await file.text(),file.name);}
    return parseOrcaInput(text,main.name,external);
  }
  return parseStructures(text,main.name);
}
