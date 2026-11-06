import type { Atom, GaussianQstSettings, InputStructureSource, JobRequest, Structure } from './types';
import { ELEMENTS, electronicStateError } from './elements';
import { inputStructureSourceIsCurrent } from './input-structure-source';

// Gaussian Opt/Input reference: two/three consecutive title + molecular
// specification sections; R, P, then the initial TS for QST3. TS is not an
// additional Opt option. https://www.conflex.co.jp/gaussian_support/opt.php
// https://www.conflex.co.jp/gaussian_support/input.php (Gaussian distributor's
// reproduced manufacturer reference; gaussian.com/opt returned HTTP 502).
export const isQstTask=(task:string):task is 'qst2'|'qst3'=>task==='qst2'||task==='qst3';
export const defaultGaussianQstSettings=():GaussianQstSettings=>({reactantSource:null,product:null,tsGuess:null,mapping:[],mappingConfirmed:false,targetContext:'',frequency:false});
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const nonempty=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value);
const ownership=(source:InputStructureSource)=>[source.documentEpoch??null,source.sourceEpoch??null];

function sourceErrors(value:unknown,label:string):string[]{
  if(!object(value))return [`QST ${label}需要明确选择的真实文档快照。`];
  const errors:string[]=[];
  if(value.documentEpoch!==undefined&&!nonempty(value.documentEpoch))errors.push(`QST ${label}来源documentEpoch声明无效。`);
  if(value.sourceEpoch!==undefined&&(!Number.isSafeInteger(value.sourceEpoch)||Number(value.sourceEpoch)<0))errors.push(`QST ${label}来源sourceEpoch声明无效。`);
  if(!nonempty(value.documentId)||!Number.isSafeInteger(value.revision)||Number(value.revision)<0||!nonempty(value.label)||typeof value.label==='string'&&(/[\r\n]/.test(value.label)||/^\s*[%#]|--Link1--/i.test(value.label)))errors.push(`QST ${label}的文档身份、修订或单行标签无效，不能含路由/Link1控制行。`);
  if(value.geometryUnits!=='angstrom')errors.push(`QST ${label}必须是明确Angstrom的实际坐标。`);
  if(value.confirmed!==true)errors.push(`QST ${label}电荷/多重度尚未明确确认。`);
  if(!object(value.structure)||!Array.isArray(value.structure.atoms)||!value.structure.atoms.length)return [...errors,`QST ${label}缺少完整真实原子坐标。`];
  const s=value.structure;
  if(!nonempty(s.id))errors.push(`QST ${label}结构身份缺失。`);
  if(s.dimension!==3||s.cell)errors.push(`QST ${label}首批仅接受有限、非周期的显式三维结构。`);
  const atoms=s.atoms as unknown[];
  if(atoms.some(atom=>!object(atom)||!nonempty(atom.id)||typeof atom.element!=='string'||!ELEMENTS.includes(atom.element)||![atom.x,atom.y,atom.z].every(finite)))return [...errors,`QST ${label}原子身份、元素或坐标无效；不支持ghost/dummy。`];
  if(new Set(atoms.map(atom=>(atom as Atom).id)).size!==atoms.length)errors.push(`QST ${label}原子身份重复。`);
  const state=electronicStateError(atoms as Atom[],value.charge as number,value.multiplicity as number);if(state)errors.push(`QST ${label}：${state}`);
  if(s.charge!=null&&s.charge!==value.charge||s.multiplicity!=null&&s.multiplicity!==value.multiplicity)errors.push(`QST ${label}结构正文与来源电子态矛盾。`);
  return errors;
}
function structureIdentity(s:Structure|null|undefined):unknown{
  return s?{id:s.id,dimension:s.dimension,cell:s.cell??null,charge:s.charge,multiplicity:s.multiplicity,atoms:s.atoms.map(a=>[a.id,a.element,a.x,a.y,a.z])}:null;
}
/** Invalid/missing declarations have an invalid binding, not scientific defaults. */
export function qstTargetContext(request:JobRequest):string{
  const q=request.settings.qst;
  if(!q||!object(q)||!Array.isArray(q.mapping)||q.mapping.some(pair=>!object(pair)||!nonempty(pair.reactantId)||!nonempty(pair.productId)||request.settings.task==='qst3'&&!nonempty(pair.tsGuessId))||sourceErrors(q.reactantSource,'反应物').length||sourceErrors(q.product,'Product').length||request.settings.task==='qst3'&&sourceErrors(q.tsGuess,'TS猜测').length)return 'qst-invalid';
  const source=(s:InputStructureSource|null)=>s?{documentId:s.documentId,revision:s.revision,ownership:ownership(s),confirmed:s.confirmed,units:s.geometryUnits,charge:s.charge,multiplicity:s.multiplicity,structure:structureIdentity(s.structure)}:null;
  const s=request.settings;
  return JSON.stringify({schema:1,purpose:s.task,charge:request.charge,multiplicity:request.multiplicity,confirmed:request.electronicStateConfirmed,reactant:structureIdentity(request.structure),sources:[source(q.reactantSource),source(q.product),s.task==='qst3'?source(q.tsGuess):null],mapping:q.mapping,
    level:[s.method,s.customMethod,s.basis,s.dispersion,s.unrestricted??false,s.solvent,s.solventModel,s.solvation??null,s.grid,s.scf,s.nosymm,s.use5D??false,s.advanced??null,s.inheritedRoute??null],frequency:q.frequency});
}
export function qstInputErrors(request:JobRequest):string[]{
  if(!isQstTask(request.settings.task))return [];
  const errors:string[]=[],s=request.settings,q=s.qst;
  if(request.electronicStateConfirmed!==true)errors.push('QST当前共享基础电子态尚未明确确认。');
  if(/^\s*[%#]|--Link1--/i.test(request.title))errors.push('QST反应物标题不能含路由或Link1控制行。');
  if(!q||!object(q))return ['QST需要独立多结构来源、映射及确认，不能从普通TS或单结构推断。'];
  if(typeof q.frequency!=='boolean'||typeof q.mappingConfirmed!=='boolean'||typeof q.targetContext!=='string')errors.push('QST频率/映射确认必须有正确声明形状，字符串不代表确认。');
  if(!['b3lyp','m062x','pbe0','cam-b3lyp','wb97xd','tpss','tpssh'].includes(s.method))errors.push('QST首批仅支持已核普通单层DFT方法，不通过customMethod、半经验或External/XTB路线绕入。');
  if(s.oniom?.enabled||s.mixedBasis?.enabled||s.inheritedRoute?.basisTail||s.inheritedRoute?.basisKeyword||/^gen(?:ecp)?$/i.test(s.basis)||s.basis==='ma-def2TZVP')errors.push('QST首批未核ONIOM、混基、复杂Gen/GenECP与外部基组组合。');
  if(s.inheritedRoute?.extra?.length||s.inheritedRoute?.methodKeyword||s.inheritedRoute?.solvent||s.inheritedRoute?.integration||s.inheritedRoute?.scf)errors.push('QST首批需要明确共享计算条件，不沿用额外来源路由片段。');
  if((request.files?.geometry??'explicit')!=='explicit'||request.files?.readCheckpoint||request.files?.guessRead||request.files?.basisFromCheckpoint||!['none',undefined].includes(request.files?.hessian))errors.push('QST首批使用完整显式结构，不接CHK初猜/几何/Hessian或独立OptTS策略。');
  const o=s.taskOptions;
  if(o&&(o.constraintsEnabled||o.frozenAtoms.length||o.coordinates.length||o.coordinateDrafts?.length))errors.push('QST首批未核冻结/扫描组合；请显式移除这些定义，不会静默丢弃。');
  const slots:[string,InputStructureSource|null][]=[['反应物',q.reactantSource],['Product',q.product],...(s.task==='qst3'?[['TS猜测',q.tsGuess] as [string,InputStructureSource|null]]:[])];
  for(const [label,source]of slots)errors.push(...sourceErrors(source,label));
  if(s.task==='qst2'&&q.tsGuess!==null)errors.push('QST2只接受反应物/Product，第三结构需明确选择QST3。');
  if(errors.length)return [...new Set(errors)];
  const catalog=request.inputSources;
  for(const [label,source]of slots)if(!inputStructureSourceIsCurrent(source,catalog))errors.push(`QST ${label}来源已改变/关闭或缺少当前注册快照，请显式刷新并重新核对。`);
  if(/^def2(?:SVP|SVPP|TZVP|TZVPP|QZVP)$/i.test(s.basis)&&slots.some(([,source])=>source!.structure.atoms.some(atom=>ELEMENTS.indexOf(atom.element)>=36)))errors.push('QST首批未核需要GenECP附加段的重元素def2组合。');
  const r=q.reactantSource!,p=q.product!,t=s.task==='qst3'?q.tsGuess:null;
  if(JSON.stringify(structureIdentity(r.structure))!==JSON.stringify(structureIdentity(request.structure))||r.charge!==request.charge||r.multiplicity!==request.multiplicity)errors.push('QST反应物来源必须与当前主结构/电子态逐项一致，请显式刷新来源。');
  for(const [label,source]of slots)if(source!.charge!==request.charge||source!.multiplicity!==request.multiplicity)errors.push(`QST ${label}必须采用相同目标电荷和多重度；不据奇偶猜物理态。`);
  if(!Array.isArray(q.mapping)||q.mapping.some(pair=>!object(pair)||!nonempty(pair.reactantId)||!nonempty(pair.productId)||t&&!nonempty(pair.tsGuessId)))return [...errors,'QST逐原子映射声明无效。'];
  const ra=r.structure.atoms,pa=p.structure.atoms,ta=t?.structure.atoms;
  if(pa.length!==ra.length||ta&&ta.length!==ra.length||q.mapping.length!==ra.length||new Set(q.mapping.map(pair=>pair.reactantId)).size!==ra.length||new Set(q.mapping.map(pair=>pair.productId)).size!==pa.length||ta&&new Set(q.mapping.map(pair=>pair.tsGuessId)).size!==ta.length)errors.push('QST映射必须完整一一覆盖所有结构，不遗漏或重复原子。');
  const rid=new Set(ra.map(a=>a.id)),pid=new Map(pa.map(a=>[a.id,a])),tid=new Map(ta?.map(a=>[a.id,a])??[]);
  for(const pair of q.mapping){const a=ra.find(a=>a.id===pair.reactantId),b=pid.get(pair.productId),c=t?tid.get(pair.tsGuessId):undefined;if(!rid.has(pair.reactantId)||!a||!b||a.element!==b.element||t&&(!c||a.element!==c.element))errors.push('QST映射含失效身份或元素不一致；同元素排列不证明物理对应。');}
  if(q.mappingConfirmed!==true||q.targetContext==='qst-invalid'||q.targetContext!==qstTargetContext(request))errors.push('请确认QST完整原子对应及当前共享科学条件；来源/坐标/电子态/级别变化后必须重新核对。');
  return [...new Set(errors)];
}
/** A caller must invoke this only following an explicit confirmation action. */
export function confirmQstMapping(request:JobRequest):GaussianQstSettings{
  const q=request.settings.qst;if(!q)throw new Error('QST来源未定义。');
  const targetContext=qstTargetContext(request),next={...q,mappingConfirmed:true,targetContext};
  const errors=qstInputErrors({...request,settings:{...request.settings,qst:next}});if(errors.length)throw new Error(errors.join('\n'));return next;
}
export function qstGeometrySections(request:JobRequest):string{
  const errors=qstInputErrors(request);if(errors.length)throw new Error(errors.join('\n'));
  const q=request.settings.qst!;
  const ordered=(source:InputStructureSource,key:'productId'|'tsGuessId')=>request.structure!.atoms.map(a=>{const pair=q.mapping.find(pair=>pair.reactantId===a.id)!;return source.structure.atoms.find(b=>b.id===pair[key])!;});
  const slots=[{title:request.title,atoms:request.structure!.atoms},{title:q.product!.label,atoms:ordered(q.product!,'productId')},...(request.settings.task==='qst3'?[{title:q.tsGuess!.label,atoms:ordered(q.tsGuess!,'tsGuessId')}]:[])];
  return slots.map(({title,atoms})=>`${title.trim()}\n\n${request.charge} ${request.multiplicity}\n${atoms.map(a=>`${a.element.padEnd(3)} ${a.x.toFixed(10).padStart(16)} ${a.y.toFixed(10).padStart(16)} ${a.z.toFixed(10).padStart(16)}`).join('\n')}\n\n`).join('');
}
/** Strict roundtrip observer for the narrow QST format, not a relaxed route
 * importer or an assertion that Gaussian has consumed this input. */
export function parseGaussianQstSections(text:string):{task:'qst2'|'qst3';sections:{title:string;charge:number;multiplicity:number;atoms:Pick<Atom,'element'|'x'|'y'|'z'>[]}[]}{
  const normalized=text.replace(/\r\n?/g,'\n'),route=normalized.split('\n').find(line=>/^#/.test(line));
  const task=route?.match(/\bqst([23])\b/i)?.[1];if(!task||/--Link1--|\bopt\s*=\s*\(?ts\b/i.test(normalized))throw new Error('不是本版独立QST输入。');
  const lines=normalized.split('\n'),routeIndex=lines.findIndex(line=>line===route);let i=routeIndex+1;while(lines[i]?.trim())i++;while(!lines[i]?.trim()&&i<lines.length)i++;
  const sections=[];
  for(let n=0;n<Number(task);n++){
    const title=lines[i++];if(!title?.trim()||lines[i++]?.trim())throw new Error('QST标题或空行无效。');
    const state=lines[i++]?.trim().match(/^(-?\d+)\s+(\d+)$/);if(!state)throw new Error('QST电子态段无效。');
    const atoms:Pick<Atom,'element'|'x'|'y'|'z'>[]=[];
    while(lines[i]?.trim()){const row=lines[i++].trim().split(/\s+/);if(row.length!==4||!ELEMENTS.includes(row[0])||row.slice(1).some(v=>!v.trim()||!Number.isFinite(Number(v))))throw new Error('QST Cartesian段无效。');atoms.push({element:row[0],x:Number(row[1]),y:Number(row[2]),z:Number(row[3])});}
    if(!atoms.length)throw new Error('QST缺少几何。');while(!lines[i]?.trim()&&i<lines.length)i++;
    sections.push({title,charge:Number(state[1]),multiplicity:Number(state[2]),atoms});
  }
  return {task:`qst${task}` as 'qst2'|'qst3',sections};
}
