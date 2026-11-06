import { elementSymbol } from '../core/elements';
import { toMolfile, toXyz, withAtomIds } from '../core/structures';
import type { Structure } from '../core/types';
export type Forcefield = 'auto' | 'MMFF94' | 'MMFF94s' | 'UFF';
export interface ChemistryInput { text: string; format: 'mol' | 'xyz' | 'smi'; atomIds?: (string | null)[]; charge?: number | null; coordinates?: [number,number,number][]; cell?: Structure['cell']; pbc?: [boolean,boolean,boolean];dimension?:2|3;explicitHydrogenAtomIds?:string[] }
export interface ChemistryOptions { movableAtomIds?: string[] }
export interface ChemistryResult {
  atoms: { atomicNumber: number; x:number;y:number;z:number;formalCharge:number;isotope:number;sourceId:string|null;aromaticHydrogen?:boolean }[];
  bonds: { a:number;b:number;order:number;aromatic?:boolean;stereo?:number }[];
  molfile:string;smiles:string;charge:number;dimension:number;
  operation:string;forcefield?:string;seed?:string|null;status?:string;before?:number;after?:number;unit?:string;attempted?:number;maximum?:number;stoppedEarly?:boolean;
  converged?:boolean;limitReached?:boolean;evaluations?:number;movableAtomIds?:string[];fixedAtomCount?:number;
}
export function chemistryInput(structure: Structure): ChemistryInput {
  return { text: structure.bonds ? toMolfile(structure) : toXyz(structure), format:structure.bonds ? 'mol' : 'xyz', atomIds:structure.atoms.map(atom => atom.id ?? null), charge:structure.charge, coordinates:structure.atoms.map(atom=>[atom.x,atom.y,atom.z]), cell:structure.cell,dimension:structure.dimension,explicitHydrogenAtomIds:structure.atoms.filter(atom=>atom.hydrogenMode==='explicit'&&atom.id).map(atom=>atom.id!) };
}
export function startChemistry(operation: string, input: ChemistryInput, forcefield: Forcefield = 'auto', onProgress?: (text:string)=>void, steps=300, options:ChemistryOptions={}): { promise:Promise<ChemistryResult>; cancel:()=>void } {
  const worker = new Worker(new URL('chemistry/extra/engine-worker.js', document.baseURI));
  let rejectPending: (error:Error)=>void; let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<ChemistryResult>((resolve,reject) => {
    rejectPending=reject;
    timer=setTimeout(()=>{worker.terminate();reject(new Error('浏览器建模超过60秒，已停止；原结构未改变。'));},60000);
    worker.onerror=event=>{clearTimeout(timer);worker.terminate();reject(new Error(event.message || '浏览器化学内核失败。'));};
    worker.onmessage=event=>{
      if (event.data.progress) { onProgress?.(event.data.progress.message ?? '力场迭代 '+event.data.progress.attempted+' / '+event.data.progress.maximum+' 步上限'); return; }
      clearTimeout(timer);worker.terminate();event.data.error?reject(new Error(event.data.error)):resolve(event.data.result);
    };
    worker.postMessage({ id:1,operation,input,forcefield,steps,options });
  });
  return { promise, cancel:()=>{clearTimeout(timer);worker.terminate();rejectPending(new Error('已取消，原结构未改变。'));} };
}
export function chemistryStructure(result: ChemistryResult, original: Structure|null, name='drawn_molecule.mol'): Structure {
  if (result.atoms.some(atom=>atom.isotope)) throw new Error('返回结构含指定同位素，本版尚未输出对应Gaussian质量设置。');
  const sourceIds=result.atoms.map(atom=>atom.sourceId).filter((id):id is string=>id!==null);
  if (new Set(sourceIds).size!==sourceIds.length || original && new Set(original.atoms.map(atom=>atom.id).filter(Boolean)).size!==original.atoms.filter(atom=>atom.id).length) throw new Error('原子ID重复，无法可靠合并结构。');
  const originById=new Map(original?.atoms.map(atom=>[atom.id,atom]) ?? []);
  const atoms=result.atoms.map(atom=>{
    const element=elementSymbol(String(atom.atomicNumber)); const origin=atom.sourceId?originById.get(atom.sourceId):undefined;
    if (origin && origin.element !== element) throw new Error('原子身份与元素不一致，未替换原结构。');
    return {element,x:atom.x,y:atom.y,z:atom.z,formalCharge:atom.formalCharge || undefined,id:atom.sourceId ?? undefined,sourceIndex:origin?.sourceIndex,hydrogenMode:origin?.hydrogenMode,stereoParity:origin?.stereoParity,aromaticHydrogen:atom.aromaticHydrogen};
  });
  if (!atoms.length || !atoms.every(atom=>[atom.x,atom.y,atom.z].every(Number.isFinite))) throw new Error('化学内核未返回完整有限坐标。');
  const retainedIds=new Set(sourceIds);
  const groups=original?.groups?.map(group=>({...group,atomIds:group.atomIds.filter(id=>retainedIds.has(id))})).filter(group=>group.atomIds.length) ?? [];
  const layout2D=original?.layout2D?Object.fromEntries(Object.entries(original.layout2D).filter(([id])=>retainedIds.has(id))):undefined;
  const pair=(a:string|undefined|null,b:string|undefined|null)=>a&&b?[a,b].sort().join('\0'):null;
  const originBonds=new Map(original?.bonds?.map(bond=>[pair(original.atoms[bond.a]?.id,original.atoms[bond.b]?.id),bond])??[]);
  const outputById=new Map(result.atoms.map((atom,index)=>[atom.sourceId,index]));
  const bonds=result.bonds.map(bond=>{
    const key=pair(result.atoms[bond.a]?.sourceId,result.atoms[bond.b]?.sourceId);
    const previous=key?originBonds.get(key):undefined;
    if(!previous)return bond;
    const aromatic=!!bond.aromatic||bond.order===1.5||bond.order===4;const previousAromatic=!!previous.aromatic||previous.order===1.5||previous.order===4;
    // Retain display/region metadata only after actual native graph equivalence.
    // A genuine changed bond remains native and the strict draft merge rejects it.
    if(aromatic!==previousAromatic||!aromatic&&bond.order!==previous.order)return bond;
    if(result.operation==='layout2d')return {...previous,...bond};
    return {...previous,a:outputById.get(original!.atoms[previous.a].id!)!,b:outputById.get(original!.atoms[previous.b].id!)!};
  });
  return withAtomIds({ id:(original?.id ?? 'drawn')+'-prepared',name,format:'本地建模 · '+(result.dimension===3?'3D':'2D'),atoms,bonds,bondSource:original?.bondSource ?? (original?'inferred':'drawn'),charge:result.charge,multiplicity:null,dimension:result.dimension===3?3:2,molfile:result.molfile,groups,layout2D,cell:original?.cell?structuredClone(original.cell):undefined,notes:[result.forcefield?'浏览器本地'+result.forcefield+'预整理；不是量化优化，也不保证全局最低构象。':'浏览器本地结构处理，未上传。','原子集/结构已改变，请重新核对电子态及旧CHK兼容性。',...(original&&!original.bonds?['来源没有连接表，已按距离推断成键；请核对键级、形式电荷及配位关系。']:[])],preparation:{ forcefield:result.forcefield,before:result.before,after:result.after,unit:result.unit,status:'初猜预整理；'+(result.limitReached?'已达到局部优化时间/能量评估上限':result.converged?'局部力场已达到梯度阈值':result.stoppedEarly?'内核提前结束':'已运行所设步数范围') } });
}
