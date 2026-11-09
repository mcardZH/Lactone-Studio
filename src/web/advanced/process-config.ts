import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {effectiveSharedFreezes} from '../../modeling/constraints';
import type {AdvancedPathTaskOptions,AdvancedSamplingTaskOptions} from '../../modeling/advanced/contracts';
import type {AdvancedPathOperation,AdvancedPathInitialPath} from '../../modeling/advanced/path-contracts';
import {getConformerSamplingCapability,NATIVE_CONFORMER_CORE_PROTECTION,type ConformerSamplingOperation,type ConformerSamplingMethod,type ConformerSamplingSphere,type ConformerNativeProtection} from '../../modeling/advanced/sampling-contracts';
import {coordinateValue} from '../../core/tasks';
import {inputSelectionIndices} from '../../core/input-selection';
import {advancedMethodSolvents} from './solvation';
import {protectionStrengthToNative} from './protection-units';
import {conformerSamplingSchedule} from '../../modeling/advanced/sampling-progress';
import {conformerSolvationIssue} from '../../modeling/advanced/conformer-solvation';

export interface ProcessResources {threads:number;maxSteps:number;maxEvaluations:number;maxWallTimeSeconds?:number}
export interface PathDraft extends ProcessResources {
 operation:AdvancedPathOperation;method:'gfn1'|'gfn2';forceToleranceEVPerAngstrom:number;
 coordinateIds:string[];start:number;stop:number;pointCount:number;seed:number;
 combination:'synchronous'|'grid';additionalCoordinates:{id:string;coordinateIds:string[];start:number;stop:number;pointCount:number}[];
 imageCount:number;initialPath:AdvancedPathInitialPath;springConstantEVPerAngstrom2:number;preoptimizeEndpoints:boolean;
 bpp:{npoint:number;anopt:number;kpush:number;kpull:number;ppull:number;alp:number};
 mapping:string[];mappingConfirmed:boolean;
}
export const initialPathDraft:PathDraft={operation:'scan',method:'gfn2',threads:2,maxSteps:200,maxEvaluations:5000,forceToleranceEVPerAngstrom:.05,coordinateIds:[],start:1,stop:2,pointCount:5,combination:'synchronous',additionalCoordinates:[],seed:731,imageCount:7,initialPath:'idpp',springConstantEVPerAngstrom2:.1,preoptimizeEndpoints:false,bpp:{npoint:25,anopt:10,kpush:.003,kpull:-.015,ppull:.05,alp:1.2},mapping:[],mappingConfirmed:false};
export function selectedCoordinate(source:AdvancedFrameSource,ids:string[]){
 inputSelectionIndices(source.structure,ids);
 if(ids.length<2||ids.length>4)throw Error('请按顺序确认2、3或4个不同原子。');
 return{id:'advanced-scan-coordinate',type:({2:'B',3:'A',4:'D'} as const)[ids.length as 2|3|4],atomIds:[...ids]};
}
export function coordinateStart(source:AdvancedFrameSource,ids:string[]){const coordinate=selectedCoordinate(source,ids);return coordinateValue({type:coordinate.type,atoms:inputSelectionIndices(source.structure,ids).map(i=>i+1),steps:1,increment:null},source.structure.atoms);}
function resources(value:ProcessResources,_legacyWallLimit=1800){
 for(const key of ['threads','maxSteps','maxEvaluations'] as const)if(!Number.isSafeInteger(value[key])||value[key]<1)throw Error('线程、步数与求值预算须为正整数。');
 return{threads:value.threads,maxSteps:value.maxSteps,maxEvaluations:value.maxEvaluations};
}
export function compilePath(draft:PathDraft,source:AdvancedFrameSource,product:AdvancedFrameSource|null,previewOnly=false):AdvancedPathTaskOptions{
 const base={...resources(draft),method:draft.method,forceToleranceEVPerAngstrom:draft.forceToleranceEVPerAngstrom};
 if(!Number.isFinite(base.forceToleranceEVPerAngstrom)||base.forceToleranceEVPerAngstrom<=0)throw Error('路径力阈值须为正数。');
 if(draft.operation==='scan'){
  const axes=[{...draft,id:'advanced-scan-coordinate'},...draft.additionalCoordinates].map(axis=>{
   const coordinate={...selectedCoordinate(source,axis.coordinateIds),id:axis.id};
   if(!Number.isSafeInteger(axis.pointCount)||axis.pointCount<2||axis.pointCount>128||![axis.start,axis.stop].every(Number.isFinite))throw Error('扫描需要2–128点和有限端点。');
   if(coordinate.type==='B'&&Math.min(axis.start,axis.stop)<=0||coordinate.type==='A'&&(Math.min(axis.start,axis.stop)<0||Math.max(axis.start,axis.stop)>180))throw Error('扫描端点超出内坐标有效范围。');
   return{coordinate,start:axis.start,stop:axis.stop,pointCount:axis.pointCount};
  });
  if(axes.length>3)throw Error('最多同时扫描3个内坐标。');
  const total=draft.combination==='grid'?axes.reduce((n,a)=>n*a.pointCount,1):draft.pointCount;if(total>128)throw Error('扫描总点数超过128点候选预算。');
  return{...base,operation:'scan',scan:axes.length===1?axes[0]:draft.combination==='grid'?{combination:'grid',coordinates:axes}:{combination:'synchronous',coordinates:axes.map(({pointCount,...axis})=>axis),pointCount:draft.pointCount}};
 }
 if(draft.operation==='ts')return{...base,operation:'ts',ts:{initialMode:{kind:'estimated',seed:draft.seed}}};
 if(!product)throw Error('请独立取用产品端完整结构帧。');
 if(previewOnly&&draft.preoptimizeEndpoints)throw Error('几何初路径预览不执行端点预优化，请关闭该项或开始物理任务。');
 if(draft.initialPath==='sidpp'&&draft.imageCount<4)throw Error('S-IDPP至少需要4个image。');
 if(draft.initialPath==='xtb-bpp'){
  if(previewOnly)throw Error('xTB-BPP是物理路径计算，不是免费几何初切片。');
  if(draft.preoptimizeEndpoints||[source,product].some(input=>effectiveSharedFreezes(input.constraints).frozenAtomIds.length||effectiveSharedFreezes(input.constraints).coordinates.length))throw Error('xTB-BPP尚不接受端点预优化和来源冻结，不会静默移除。');
 }
 if(source.structure.charge!==product.structure.charge||source.structure.multiplicity!==product.structure.multiplicity)throw Error('双端点电荷和多重度必须相同。');
 if(!draft.mappingConfirmed)throw Error('请核对并确认双端点原子映射。');
 const a=source.structure.atoms,b=product.structure.atoms;
 if(a.length!==b.length||draft.mapping.length!==a.length||new Set(draft.mapping).size!==b.length)throw Error('双端点映射须覆盖全部原子且一一对应。');
 const mapping=a.map((atom,i)=>{const target=b.find(row=>row.id===draft.mapping[i]);if(!target||target.element!==atom.element)throw Error('映射必须保持元素身份，不可按编号猜测。');return{reactantAtomId:atom.id!,productAtomId:target.id!};});
 return{...base,operation:'ci-neb-ts',neb:{product:product.structure,mapping,imageCount:draft.imageCount,initialPath:draft.initialPath,springConstantEVPerAngstrom2:draft.springConstantEVPerAngstrom2,preoptimizeEndpoints:draft.preoptimizeEndpoints,previewOnly,...(draft.initialPath==='xtb-bpp'?{bpp:{...draft.bpp}}:{})}};
}

export interface SamplingDraft extends ProcessResources {
 coreProtectionEnabled?:boolean;
 operation:ConformerSamplingOperation;method:ConformerSamplingMethod;solvationModel:'none'|'alpb'|'gbsa';solvent:string;
 seed:number;dtFs:number;frictionPerFs:number;reportEvery:number;maxFrames:number;
 lowTemperatureK:number;highTemperatureK:number;heatingFs:number;highHoldFs:number;coolingFs:number;lowHoldFs:number;cycles:number;
 temperatureK:number;durationFs:number;sampleEveryFs:number;depositEveryFs:number;heightEV:number;sigmaAngstrom:number;maxHistory:number;
 molecularTemperatureK:number;molecularDurationFs:number;molecularSampleEveryFs:number;
 shakeHydrogenBonds:boolean;supportedShakeHydrogenBonds?:boolean;hydrogenMassAmu?:4;metaScope?:'all'|'selected';cycleDurationFs:number;sphereEnabled:boolean;spherePaddingAngstrom:number;
 memoryBudgetBytes?:number;
 coreIds:string[];coreForce:number;metaIds:string[];sphere:ConformerSamplingSphere;
 operationDrafts?:Partial<Record<ConformerSamplingOperation,SamplingOperationDraft>>;
}
type SamplingOperationDraft=Omit<SamplingDraft,'operation'|'operationDrafts'|'coreIds'|'coreProtectionEnabled'|'metaIds'|'sphere'>;
export const initialSamplingDraft:SamplingDraft={operation:'md',method:'gfnff',threads:2,maxSteps:100000,maxEvaluations:200001,solvationModel:'none',solvent:'water',seed:731,dtFs:2,frictionPerFs:.01,reportEvery:20,maxFrames:2000,lowTemperatureK:0,highTemperatureK:600,heatingFs:1000,highHoldFs:7000,coolingFs:2000,lowHoldFs:0,cycleDurationFs:10000,cycles:5,temperatureK:300,durationFs:50000,sampleEveryFs:100,depositEveryFs:100,heightEV:.01,sigmaAngstrom:.5,maxHistory:1000,molecularTemperatureK:600,molecularDurationFs:50000,molecularSampleEveryFs:100,shakeHydrogenBonds:false,hydrogenMassAmu:4,metaScope:'all',sphereEnabled:false,spherePaddingAngstrom:3,coreIds:[],coreForce:protectionStrengthToNative(NATIVE_CONFORMER_CORE_PROTECTION.forceConstantKJMolNm2),metaIds:[],sphere:{centerAngstrom:[0,0,0],radiusAngstrom:5,forceConstantEVPerAngstrom2:1}};
function samplingOperationDraft(draft:SamplingDraft):SamplingOperationDraft{
 const{operation,operationDrafts,coreIds,coreProtectionEnabled,metaIds,sphere,...settings}=draft;return structuredClone(settings);
}
/** UI-only drafts never cache source-bound atom IDs or cross into task snapshots. */
export function changeSamplingOperation(draft:SamplingDraft,operation:ConformerSamplingOperation):SamplingDraft{
 if(draft.operation===operation)return draft;
 const operationDrafts={...draft.operationDrafts,[draft.operation]:samplingOperationDraft(draft)};
 const defaults={...samplingOperationDraft(initialSamplingDraft),method:operation==='spherical-md'?'gfn2' as const:'gfnff' as const,...(operation==='spherical-md'?{hydrogenMassAmu:undefined,shakeHydrogenBonds:true}:{})};
 return{...draft,...structuredClone(operationDrafts[operation]??defaults),operation,operationDrafts};
}
/** A method switch adopts route defaults, preserving an explicit supported SHAKE choice. */
export function changeSamplingMethod(draft:SamplingDraft,method:ConformerSamplingMethod):SamplingDraft{
 if(draft.method===method)return draft;
 const nativeGfnff=method==='gfnff';
 const supportedShakeHydrogenBonds=draft.method==='gfnff'?draft.supportedShakeHydrogenBonds:draft.shakeHydrogenBonds;
 return{...draft,method,hydrogenMassAmu:nativeGfnff?4:undefined,supportedShakeHydrogenBonds,
  shakeHydrogenBonds:getConformerSamplingCapability({...draft,method}).shakeSupported&&!nativeGfnff&&(supportedShakeHydrogenBonds??true)};
}
export const NATIVE_MD_CORE_UNAVAILABLE='此原生MD／MTD核心保护组合尚未通过定向短测。';
export function compileSampling(d:SamplingDraft,source:AdvancedFrameSource):AdvancedSamplingTaskOptions{
 if(d.operation==='anneal')throw Error('退火已停用，历史结果仍可查看；请选择其他采样任务。');
 if(effectiveSharedFreezes(source.constraints).coordinates.length)throw Error('MD采样尚不接受内坐标动量约束，请保留原定义并选择其他来源。');
 const capability=getConformerSamplingCapability(d),native=capability.driver==='native-xtb-md';
 if(native){const issue=conformerSolvationIssue(d.method,d.solvationModel,d.solvent);if(issue)throw Error(issue);}
 else if(d.solvationModel!=='none'&&(!['gfn1','gfn2'].includes(d.method)||!advancedMethodSolvents(d.method,d.solvationModel).includes(d.solvent)))throw Error('所选采样级别仅支持气相或不支持该隐式溶剂。');
 const activeCoreIds=d.coreProtectionEnabled===false?[]:d.coreIds;
 inputSelectionIndices(source.structure,activeCoreIds);if(d.metaScope==='selected'||d.metaScope===undefined)inputSelectionIndices(source.structure,d.metaIds);
 if(native&&d.operation==='metadynamics'&&d.depositEveryFs<2*d.dtFs)throw Error('原生MTD加偏置间隔至少为两个积分步。');
 const protectedIds=[...new Set([...effectiveSharedFreezes(source.constraints).frozenAtomIds,...activeCoreIds])];
 const nativeProtection:ConformerNativeProtection={};
 if(native&&protectedIds.length>=2){
  if(!capability.coreProtectionSupported)throw Error(NATIVE_MD_CORE_UNAVAILABLE);
  const profiles=NATIVE_CONFORMER_CORE_PROTECTION;
  const supportedStrength=[profiles.forceConstantKJMolNm2,profiles.legacyForceConstantKJMolNm2].some(value=>Math.abs(d.coreForce-protectionStrengthToNative(value))<=1e-9);
  if(d.dtFs!==profiles.dtFs||!Number.isFinite(d.coreForce)||!supportedStrength)throw Error('原生核心保护仅支持2 fs与500,000 kJ·mol⁻¹·nm⁻²，或已保存的5,000,000历史配置。');
  nativeProtection.core={kind:'pairwise-distance',atomIds:protectedIds,forceConstantEVPerAngstrom2:d.coreForce};
 }
 if(!native&&activeCoreIds.length&&(!Number.isFinite(d.coreForce)||d.coreForce<1e-6||d.coreForce>1000))throw Error('保护力常数超出当前执行范围。');
 if(native&&d.sphereEnabled){
  if(!capability.sphereSupported)throw Error('此原生MD级别尚未提供多项式球形约束。');
  if(d.sphere.centerAngstrom.length!==3||!d.sphere.centerAngstrom.every(Number.isFinite)||!Number.isFinite(d.sphere.radiusAngstrom)||d.sphere.radiusAngstrom<.01||d.sphere.radiusAngstrom>10000)throw Error('多项式球壁需要有限球心和0.01–10000 Å半径。');
  nativeProtection.sphere={kind:'polynomial',centerAngstrom:[...d.sphere.centerAngstrom],radiusAngstrom:d.sphere.radiusAngstrom,exponent:30};
 }
 const protection=native?(nativeProtection.core||nativeProtection.sphere?{nativeProtection}:{}):{...(d.sphereEnabled?{sphere:structuredClone(d.sphere)}:{}),...(activeCoreIds.length?{coreProtection:{atomIds:[...activeCoreIds],forceConstantEVPerAngstrom2:d.coreForce}}:{})};
 const mass=d.method==='gfnff'?d.hydrogenMassAmu:undefined;
 const schedule=conformerSamplingSchedule({operation:d.operation,dtFs:d.dtFs,reportEvery:d.reportEvery,
  molecularMD:{durationFs:d.molecularDurationFs,sampleEveryFs:d.molecularSampleEveryFs},metadynamics:{durationFs:d.durationFs,sampleEveryFs:d.sampleEveryFs},sphericalMD:{durationFs:d.durationFs,sampleEveryFs:d.sampleEveryFs}});
 if(!schedule||!Number.isSafeInteger(schedule.totalSteps*2+1))throw Error('采样总时间和抽帧间隔须对应可精确表示的完整积分步。');
 const base={threads:d.threads,maxSteps:schedule.totalSteps,maxEvaluations:native?schedule.totalSteps+2:schedule.totalSteps*2+1,method:d.method,seed:d.seed,dtFs:d.dtFs,frictionPerFs:d.frictionPerFs,reportEvery:d.reportEvery,maxFrames:schedule.recordCount,shakeHydrogenBonds:capability.shakeSupported&&d.shakeHydrogenBonds,...(mass===undefined?{}:{hydrogenMassAmu:mass}),...(d.memoryBudgetBytes===undefined?{}:{memoryBudgetBytes:d.memoryBudgetBytes}),...protection,...(d.solvationModel==='none'?{}:{solvation:{model:d.solvationModel,solvent:d.solvent}})};
 if(d.operation==='md')return{...base,operation:'md',molecularMD:{temperatureK:d.molecularTemperatureK,durationFs:d.molecularDurationFs,sampleEveryFs:d.molecularSampleEveryFs}};
 if(d.operation==='metadynamics'){
  const selected=d.metaScope==='selected'||(d.metaScope===undefined&&d.metaIds.length>0);
  if(selected&&d.metaIds.length<2)throw Error('自选RMSD偏置至少需要2个不同原子。');
  if(!selected&&source.structure.atoms.length<2)throw Error('RMSD偏置至少需要2个不同原子。');
  return{...base,operation:'metadynamics',metadynamics:{temperatureK:d.temperatureK,durationFs:d.durationFs,sampleEveryFs:d.sampleEveryFs,depositEveryFs:d.depositEveryFs,heightEV:d.heightEV,sigmaAngstrom:d.sigmaAngstrom,maxHistory:d.maxHistory,...(selected?{atomIds:[...d.metaIds]}:{})}};
 }
 return{...base,operation:'spherical-md',sphericalMD:{temperatureK:d.temperatureK,durationFs:d.durationFs,sampleEveryFs:d.sampleEveryFs},sphere:structuredClone(d.sphere)};
}
