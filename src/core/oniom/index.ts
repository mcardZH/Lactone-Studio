import type { Atom, GaussianSettings, JobRequest, Structure } from '../types';
import { atomicNumber, ELEMENTS, electronicStateError } from '../elements';
import { activeFrozenAtoms, defaultTaskOptions, spectrumStates } from '../tasks';
import { isUksOptimization } from '../excited-state';
import { BASES, canonicalBasis } from '../catalog';
import { unsupportedElements } from '../basis';
import type { GaussianOniomBoundary, GaussianOniomSettings } from './types';
export * from './types';

export interface GaussianOniomRender {
  methodKeyword:string;
  chargeLine:string;
  coordinateLines:string[];
  connectivityTail:string;
  issues:string[];
}
export interface OniomBoundaryCandidate { qmAtomId:string;lowAtomId:string;qmIndex:number;lowIndex:number;order:number;aromatic:boolean;kind:'covalent'|'coordination' }
/** Native Gaussian type labels only; syntax acceptance is not parameter coverage. */
export const gaussianUffTypePattern=/^[A-Za-z][A-Za-z0-9_+]{0,19}$/;
const config=(request:JobRequest)=>(request.settings as JobRequest['settings']&{oniom?:GaussianOniomSettings}).oniom;
const value=(n:number)=>Number.isFinite(n)?n.toFixed(10).padStart(16):'[待修正坐标]';
const pair=(q:number,m:number)=>`${q} ${m}`;
const key=(a:string,b:string)=>JSON.stringify([a,b]);

/** Topology only: no distance-based bond creation or mutation. */
export function oniomBoundaryCandidates(structure:Structure|null,qmAtomIds:string[]):OniomBoundaryCandidate[] {
  if(!structure)return [];
  const qm=new Set(qmAtomIds),found:OniomBoundaryCandidate[]=[];
  for(const bond of structure.bonds??[]){
    const a=structure.atoms[bond.a],b=structure.atoms[bond.b];
    if(!a?.id||!b?.id||qm.has(a.id)===qm.has(b.id)||!(bond.order>0.1))continue;
    const first=qm.has(a.id),high=first?a:b,low=first?b:a;
    found.push({qmAtomId:high.id!,lowAtomId:low.id!,qmIndex:(first?bond.a:bond.b)+1,lowIndex:(first?bond.b:bond.a)+1,order:bond.order,aromatic:!!bond.aromatic,kind:bond.kind??'covalent'});
  }
  return found;
}

/** Copy only reliable stable-ID layer membership; leave unrelated existing draft settings intact. */
export function oniomFromStructure(settings:GaussianOniomSettings,structure:Structure|null):GaussianOniomSettings {
  if(!structure||settings.qmAtomIds.length)return settings;
  const ids=new Set(structure.atoms.map(atom=>atom.id).filter((id):id is string=>!!id));
  const layers=structure.modelLayers??[];
  if(layers.some(layer=>layer.kind==='middle'))return settings;
  const high=layers.filter(layer=>layer.kind==='qm').flatMap(layer=>layer.atomIds);
  if(!high.length||new Set(high).size!==high.length||high.some(id=>!ids.has(id)))return settings;
  const assigned=layers.flatMap(layer=>layer.atomIds);
  if(new Set(assigned).size!==assigned.length||assigned.some(id=>!ids.has(id)))return settings;
  return {...settings,qmAtomIds:[...high],statesConfirmed:false,boundaries:[]};
}

function atomSpec(element:string,id:string,settings:GaussianOniomSettings):string {
  const type=settings.atomTypes[id]?.trim();
  if(settings.chargeSource==='provided')return `${element}-${type??''}-${settings.partialCharges[id]??'[待填写部分电荷]'}`;
  return type?`${element}-${type}`:element;
}
function linkSpec(boundary:GaussianOniomBoundary,settings:GaussianOniomSettings):string {
  const type=boundary.linkAtomType?.trim();
  if(settings.chargeSource==='provided')return `${boundary.linkElement}-${type??''}-${boundary.linkPartialCharge??'[待填写链接部分电荷]'}`;
  return type?`${boundary.linkElement}-${type}`:boundary.linkElement;
}
function modelAtoms(structure:Structure,qm:Set<string>,boundaries:GaussianOniomBoundary[]):Atom[] {
  return [...structure.atoms.filter(atom=>!!atom.id&&qm.has(atom.id)),...boundaries.filter(boundary=>ELEMENTS.includes(boundary.linkElement)).map(boundary=>({element:boundary.linkElement,x:0,y:0,z:0}))];
}

/** Parse complete element Gen blocks. Numeric centers have unresolved ONIOM mapping. */
function genModelIssues(tail:string,basis:string,model:Atom[]):string[] {
  const issues:string[]=[],elements=[...new Set(model.map(atom=>atom.element))],covered=new Set<string>(),ecpNeeded=new Set<string>();
  const rows=tail.replace(/\r/g,'').split('\n').map(line=>line.split('!')[0].trim());
  let index=0,finishedOrbitals=false;
  const next=()=>{while(index<rows.length&&!rows[index])index++;};
  const selector=(line:string):string[]|null=>{
    const match=line.match(/^((?:-?[A-Z][a-z]?|\d+)(?:\s+(?:-?[A-Z][a-z]?|\d+))*)\s+0$/i);
    if(!match)return null;
    const selected:string[]=[];
    for(const token of match[1].split(/\s+/)){
      if(/^\d+$/.test(token)){issues.push('ONIOM Gen数字中心与模型/link中心映射尚未核实，不能直接套用真实原子编号。');continue;}
      const name=token.replace(/^-/,'');const element=ELEMENTS.find(item=>item.toLowerCase()===name.toLowerCase());
      if(!element){issues.push('ONIOM Gen中心元素无法识别。');continue;}
      if(!elements.includes(element)&&!token.startsWith('-'))issues.push(`ONIOM Gen中心${element}不在实际QM+link模型中。`);
      if(elements.includes(element))selected.push(element);
    }
    return selected;
  };
  const number=(s:string)=>Number(s.replace(/[dD]/g,'e'));
  function completeBody(body:string[],selected:string[]):boolean {
    if(body.length===1){
      const builtin=canonicalBasis(body[0]);
      if(!BASES.some(entry=>entry.value===builtin&&!entry.pending&&builtin!=='ma-def2TZVP')){issues.push('ONIOM Gen基组名称不在已核实目录，不能凭一行文字认定完整基组。');return false;}
      if(unsupportedElements(builtin,selected).length){issues.push('ONIOM Gen所选基组缺少模型元素覆盖。');return false;}
      if(/^def2/i.test(builtin))selected.filter(element=>atomicNumber(element)>=37).forEach(element=>ecpNeeded.add(element));
      return true;
    }
    let cursor=0,shells=0;
    while(cursor<body.length){
      const header=body[cursor++].match(/^(S|P|D|F|G|H|I|K|L|M|SP)\s+(\d+)\s+([+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+\-]?\d+)?)$/i);
      if(!header){issues.push('ONIOM Gen数值壳层头不完整或含未核实语法。');return false;}
      const count=Number(header[2]),scale=number(header[3]),columns=header[1].toUpperCase()==='SP'?3:2;
      if(!Number.isSafeInteger(count)||count<1||count>10000||!Number.isFinite(scale)||scale<=0||cursor+count>body.length){issues.push('ONIOM Gen壳层primitive数量或缩放无效/截断。');return false;}
      for(let row=0;row<count;row++){
        const fields=body[cursor++].split(/\s+/),values=fields.map(number);
        if(fields.length!==columns||fields.some(field=>!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][-+]?\d+)?$/.test(field))||values.some(n=>!Number.isFinite(n))||values[0]<=0){issues.push('ONIOM Gen数值primitive的指数/收缩系数缺失或无效。');return false;}
      }
      shells++;
    }
    if(!shells){issues.push('ONIOM Gen中心后缺少真实基组/壳层定义。');return false;}
    return true;
  }
  next();
  while(index<rows.length){
    const selected=selector(rows[index]);
    if(!selected){issues.push('ONIOM Gen轨道基组中心行无法可靠解析。');break;}
    index++;const body:string[]=[];
    while(index<rows.length&&rows[index]!=='****'){
      if(rows[index])body.push(rows[index]);index++;
    }
    if(index>=rows.length){issues.push('ONIOM Gen/link元素基组块缺少完整定义和****结束标记。');break;}
    index++;
    if(completeBody(body,selected))selected.forEach(element=>covered.add(element));
    const beforeBlank=index;next();
    if(index>=rows.length){finishedOrbitals=true;break;}
    // ECP follows the blank record terminating orbital data; it has no ****.
    if(/^genecp$/i.test(basis)&&index>beforeBlank&&rows.slice(index).every(line=>line!=='****')){finishedOrbitals=true;break;}
  }
  const missing=elements.filter(element=>!covered.has(element));
  if(missing.length)issues.push('ONIOM Gen/GenECP缺少实际QM+link元素的完整基组段（link元素也必须覆盖）：'+missing.join(', ')+'。');
  if(!finishedOrbitals&&index>=rows.length&&covered.size)issues.push('ONIOM Gen轨道数据末段不完整。');
  if(ecpNeeded.size&&!/^genecp$/i.test(basis))issues.push('ONIOM Gen模型的def2重元素缺少配套GenECP。');
  if(/^genecp$/i.test(basis)){
    const ecpCovered=new Set<string>();next();
    while(index<rows.length){
      const selected=selector(rows[index]);if(!selected){issues.push('ONIOM GenECP势函数中心行无法可靠解析。');break;}
      index++;const body:string[]=[];
      while(index<rows.length&&rows[index])body.push(rows[index++]);
      if(body.length!==1||!/^def2(?:ecp)?$/i.test(body[0]))issues.push('ONIOM GenECP缺少已核实的完整def2势函数；显式ECP数据需独立核验。');
      else selected.forEach(element=>ecpCovered.add(element));next();
    }
    if([...ecpNeeded].some(element=>!ecpCovered.has(element)))issues.push('ONIOM GenECP模型重元素缺少实际配套ECP覆盖。');
  }
  return [...new Set(issues)];
}

export function validateGaussianOniom(request:JobRequest,highBasis=request.settings.basis,generatedBasisTail?:string):string[] {
  const settings=config(request);if(!settings?.enabled)return [];
  const issues:string[]=[],structure=request.structure;
  if(!structure?.atoms.length)return ['ONIOM需要完整显式三维结构。'];
  if((request.files?.geometry??'explicit')!=='explicit')issues.push('ONIOM分层需要显式坐标，不能向未知CHK几何分配层或链接原子。');
  if(structure.dimension===2||structure.cell?.pbc.some(Boolean))issues.push('ONIOM当前仅导出有限三维分子；二维或含周期晶胞模型须先明确处理。');
  const ids=structure.atoms.map(atom=>atom.id),known=new Set(ids);
  if(ids.some(id=>!id)||known.size!==ids.length)issues.push('ONIOM需要每个实际原子具有唯一稳定ID；不会用当前编号冒充身份。');
  const qm=new Set(settings.qmAtomIds);
  if(!qm.size||qm.size>=structure.atoms.length)issues.push('ONIOM须有非空QM区域及非空低层区域。');
  if(qm.size!==settings.qmAtomIds.length||settings.qmAtomIds.some(id=>!known.has(id)))issues.push('ONIOM QM分区有重复或失效原子身份，请重新核对分区。');
  if(settings.lowMethod!=='UFF')issues.push('本版Gaussian ONIOM低层仅核实UFF。');
  if(!['mechanical','electronic'].includes(settings.embedding))issues.push('ONIOM embedding选项无效。');
  if(!['none','qeq','provided'].includes(settings.chargeSource))issues.push('ONIOM MM电荷来源无效。');
  if(!structure.bonds||!['file','drawn'].includes(structure.bondSource??'')&&!settings.topologyConfirmed)issues.push('ONIOM需要可信实际键图；推断或未知来源的键须先逐项核对并确认，不能按距离猜边界。');
  const bonds=new Set<string>();
  for(const bond of structure.bonds??[]){
    if(!Number.isInteger(bond.a)||!Number.isInteger(bond.b)||bond.a<0||bond.b<0||bond.a>=ids.length||bond.b>=ids.length||bond.a===bond.b||!Number.isFinite(bond.order)||bond.order<=0){issues.push('ONIOM实际键图含无效端点或键级。');continue;}
    const bondKey=[bond.a,bond.b].sort((a,b)=>a-b).join(':');if(bonds.has(bondKey))issues.push('ONIOM实际键图含重复边。');bonds.add(bondKey);
    if(bond.image?.some(n=>n!==0))issues.push('ONIOM有限分子不能静默丢弃跨晶胞键。');
    if(bond.kind==='coordination')issues.push('ONIOM UFF配位键参数及原生类型尚未核实，请明确参数化后再导出该组合。');
  }
  const candidates=oniomBoundaryCandidates(structure,settings.qmAtomIds),expected=new Set(candidates.map(c=>key(c.qmAtomId,c.lowAtomId))),seen=new Set<string>(),lowOwners=new Set<string>();
  for(const candidate of candidates){
    if(candidate.order!==1||candidate.aromatic||candidate.kind!=='covalent')issues.push(`ONIOM边界${candidate.qmIndex}–${candidate.lowIndex}不是已核实的普通共价单键，不能自动用link原子封端。`);
    if(structure.atoms[candidate.qmIndex-1].element==='H'||structure.atoms[candidate.lowIndex-1].element==='H')issues.push('ONIOM边界不能以未核实的氢原子替换构造截断，请把相连氢保留在同层。');
    if(lowOwners.has(candidate.lowAtomId))issues.push('同一低层原子跨接多个QM原子，当前单link字段不能完整表达，请重新划分区域。');
    lowOwners.add(candidate.lowAtomId);
  }
  for(const boundary of settings.boundaries){
    const boundaryKey=key(boundary.qmAtomId,boundary.lowAtomId);
    if(!expected.has(boundaryKey))issues.push('ONIOM链接定义与当前实际跨层键不匹配；结构/分区变更后须重新核对。');
    if(seen.has(boundaryKey))issues.push('ONIOM链接定义重复，不能覆盖另一条边界。');seen.add(boundaryKey);
    if(!boundary.confirmed)issues.push('每条ONIOM跨层共价键的link元素、目标与缩放须明确确认。');
    if(!ELEMENTS.includes(boundary.linkElement))issues.push('ONIOM link元素须为一个真实元素符号。');
    for(const scale of [boundary.scaleLow,boundary.scaleHigh])if(scale!==null&&(!Number.isFinite(scale)||scale<0))issues.push('ONIOM link缩放须为非负有限数；留空或0采用Gaussian原生自动值。');
    if(boundary.linkAtomType&&!gaussianUffTypePattern.test(boundary.linkAtomType.trim()))issues.push('ONIOM link原子类型只能填一个原生Gaussian UFF标签。');
    if(settings.chargeSource==='provided'&&(!boundary.linkAtomType?.trim()||!Number.isFinite(boundary.linkPartialCharge)))issues.push('提供MM电荷时，每个link须有可信Gaussian UFF类型和有限部分电荷，不能自动填0。');
  }
  if(candidates.some(candidate=>!seen.has(key(candidate.qmAtomId,candidate.lowAtomId))))issues.push('ONIOM跨层共价键缺少显式link定义；Gaussian不会自动添加link原子。');
  for(const [id,type] of Object.entries(settings.atomTypes))if(type.trim()&&(!known.has(id)||!gaussianUffTypePattern.test(type.trim())))issues.push('ONIOM显式原子类型有失效身份或非法原生UFF标签。');
  for(const id of Object.keys(settings.partialCharges))if(!known.has(id))issues.push('ONIOM部分电荷引用失效原子身份，请删除旧数据后重新核对。');
  if(settings.chargeSource==='provided'){
    for(const id of ids)if(!id||!settings.atomTypes[id]?.trim()||!Number.isFinite(settings.partialCharges[id]))issues.push('提供MM电荷时，每个实际原子须有可信Gaussian UFF类型和有限部分电荷；不从形式电荷/任意UFF代码猜值。');
  }
  if(settings.embedding==='electronic'){
    if(settings.chargeSource==='none')issues.push('电子嵌入需要明确QEq或完整提供的MM部分电荷来源。');
    if(settings.chargeSource==='provided'&&!structure.atoms.some(atom=>atom.id&&!qm.has(atom.id)&&Number.isFinite(settings.partialCharges[atom.id])&&settings.partialCharges[atom.id]!==0))issues.push('电子嵌入的低层部分电荷全部为0或缺失，请核对实际电荷模型。');
  }
  if(!settings.statesConfirmed)issues.push('请确认ONIOM模型高层和模型低层的电荷/多重度（包括link原子）。');
  const model=modelAtoms(structure,qm,settings.boundaries);
  for(const [label,state] of [['高层',settings.modelHigh],['低层',settings.modelLow]] as const){const error=electronicStateError(model,state.charge,state.multiplicity);if(error)issues.push(`ONIOM模型${label}：${error}`);}
  const uks=isUksOptimization(request.settings),td=request.settings.task==='td'||request.settings.task==='tdopt';
  const sourceMethod=request.settings.inheritedRoute?.methodKeyword??(request.settings.method==='custom'?request.settings.customMethod:'');
  const unrestricted=uks||request.settings.unrestricted||/^u/i.test(sourceMethod);
  if(uks&&settings.modelHigh.multiplicity!==3)issues.push('ONIOM T1 UKS/UDFT高层模型（QM+link）需要明确三重态多重度3，不采用真实低层总多重度。');
  if(td&&!uks&&(settings.modelHigh.multiplicity!==1||unrestricted||/^ro/i.test(sourceMethod)))issues.push('ONIOM TD/TDA需要已核对的闭壳层单重态高层参考（模型多重度1且高层非U/RO）；真实低层总态不能替代高层参考。');
  if(!uks&&!td&&/^r(?!o)/i.test(sourceMethod)&&settings.modelHigh.multiplicity!==1)issues.push('ONIOM显式R高层方法与模型高层非单重态不相容，请核对高层方法/自旋。');
  if(['bsse','stable'].includes(request.settings.task))issues.push('本版尚未核实ONIOM与当前BSSE/Stable任务组合，请关闭其中一个模块。');
  if(request.settings.method==='gfn2-xtb')issues.push('Gaussian外部xTB接口与ONIOM-UFF是独立路线，不能合并生成。');
  if(request.settings.task==='td'&&request.settings.taskOptions?.excited.approximation==='zindo')issues.push('本版尚未核实ONIOM高层ZINDO组合。');
  if(request.files?.hessian==='readfc')issues.push('ONIOM分层变更后的Freq=ReadFC模型/Hessian对应尚未核实，不能把单层力常数当成ONIOM数据。');
  if(request.files?.basisFromCheckpoint)issues.push('ONIOM ChkBasis需要独立模型基组兼容证据，本版暂不接受未知CHK中心映射。');
  if(request.settings.mixedBasis?.enabled)issues.push('ONIOM按数字中心混基与link构造后的中心映射尚待专项验证；可使用已核实的统一基组/元素Gen段。普通Gaussian混基不受影响。');
  if(/^(gen|genecp)$/i.test(highBasis))issues.push(...genModelIssues(generatedBasisTail??request.settings.inheritedRoute?.basisTail??'',highBasis,model));
  return [...new Set(issues)];
}

/** Route-only composition; no fabricated structure/request or validation side effects. */
export function oniomMethodKeyword(settings:GaussianSettings,highMethod:string,highBasis:string,_atomCount?:number):string {
  const oniom=(settings as GaussianSettings&{oniom?:GaussianOniomSettings}).oniom;
  const spec=highMethod+(highBasis?'/'+highBasis:'');
  if(!oniom?.enabled)return spec;
  let high=spec;
  const options=(settings.taskOptions??defaultTaskOptions()).excited;
  const isTd=settings.task==='td'||settings.task==='tdopt'&&!isUksOptimization(settings);
  if(isTd&&options.approximation!=='zindo'){
    const terms:string[]=[],spin=settings.task==='tdopt'?options.targetSpin:options.spin;
    if(spin!=='default')terms.push(spin);
    if(settings.task==='td'||options.nstates!==null)terms.push('nstates='+(options.nstates??spectrumStates(oniom.qmAtomIds.length+oniom.boundaries.length)));
    if(settings.task==='tdopt'||options.root!==1)terms.push('root='+options.root);
    high+=' '+options.approximation+'=('+terms.join(',')+')';
  }
  return `oniom(${high}:${oniom.chargeSource==='qeq'?'UFF=QEq':'UFF'})=${oniom.embedding==='electronic'?'EmbedCharge':'NoEmbedCharge'}`;
}

/** highMethod already reflects the caller's inherited/R/U choice; never rewrite it. */
export function renderGaussianOniom(request:JobRequest,highMethod:string,highBasis:string,generatedBasisTail?:string):GaussianOniomRender {
  const settings=config(request),structure=request.structure,frozen=new Set(activeFrozenAtoms(request));
  const spec=highMethod+(highBasis?'/'+highBasis:'');
  if(!settings?.enabled)return {methodKeyword:spec,chargeLine:pair(request.charge,request.multiplicity),coordinateLines:structure?.atoms.map((atom,i)=>atom.element+(frozen.has(i+1)?' -1':'')+' '+[atom.x,atom.y,atom.z].map(value).join(' '))??[],connectivityTail:'',issues:[]};
  const issues=validateGaussianOniom(request,highBasis,generatedBasisTail),qm=new Set(settings.qmAtomIds),numbers=new Map(structure?.atoms.map((atom,i)=>[atom.id,i+1])??[]);
  const byLow=new Map(settings.boundaries.map(boundary=>[boundary.lowAtomId,boundary]));
  const coordinateLines=structure?.atoms.map((atom,i)=>{
    const isHigh=!!atom.id&&qm.has(atom.id),freeze=frozen.has(i+1)||!isHigh&&settings.freezeLowLayer?-1:0;
    let line=`${atomSpec(atom.element,atom.id??'',settings)} ${freeze} ${[atom.x,atom.y,atom.z].map(value).join(' ')} ${isHigh?'H':'L'}`;
    const boundary=atom.id?byLow.get(atom.id):undefined;
    if(boundary&&!isHigh){
      line+=` ${linkSpec(boundary,settings)} ${numbers.get(boundary.qmAtomId)??'[待确认连接目标]'}`;
      if(boundary.scaleLow!==null||boundary.scaleHigh!==null){line+=' '+(boundary.scaleLow??0);if(boundary.scaleHigh!==null)line+=' '+boundary.scaleHigh;}
    }
    return line;
  })??[];
  const adjacency=structure?.atoms.map((_,i)=>{
    const bonds=(structure.bonds??[]).filter(bond=>bond.order>0.1&&Math.min(bond.a,bond.b)===i).map(bond=>`${Math.max(bond.a,bond.b)+1} ${bond.aromatic?1.5:bond.order}`);
    return [i+1,...bonds].join(' ');
  })??[];
  return {methodKeyword:oniomMethodKeyword(request.settings,highMethod,highBasis),chargeLine:[pair(request.charge,request.multiplicity),pair(settings.modelHigh.charge,settings.modelHigh.multiplicity),pair(settings.modelLow.charge,settings.modelLow.multiplicity)].join(' '),coordinateLines,connectivityTail:adjacency.length?adjacency.join('\n')+'\n\n':'',issues};
}
