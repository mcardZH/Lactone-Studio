import { createBuilderDraft } from '../../core/builder-draft';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { transportLocalAttachmentPorts } from '../../core/modeling/attachment-ports';
import { coordinatesFingerprint, graphFingerprint } from '../../core/modeling/graph';
import type { XtbPreparationProvenance } from '../../core/types';
import { effectiveModelConstraints, modelCoordinateKey } from '../constraints';
import type { ModelDocument } from '../contracts';
import { validXtbOptimizationTerminal } from './optimization-terminal';
import { supportsXtbAlpb, xtbSolvents } from '../../core/xtb-capabilities';
import { XTB_METHOD_LABELS, type XtbCoordinateResult, type XtbStoppedCoordinateResult, type XtbRequest, type XtbPeriodicCoordinateChartEvidence, type XtbPeriodicEvidence, type XtbSolvation, type XtbSolvationEvidence } from './contracts';

function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sorted = (ids: readonly string[]) => [...ids].sort().join('\0');
const delta = (type: string, value: number) => type === 'D' ? ((value + 180) % 360 + 360) % 360 - 180 : value;
function validCoordinateChart(chart:XtbPeriodicCoordinateChartEvidence|undefined, atoms?:readonly {id?:string}[]):boolean {
  if(!chart||chart.schema!=='ester-xtb-periodic-coordinate-chart/v1'||chart.projection!=='source-atom-lattice-images'
    ||JSON.stringify(chart.nativeOriginAngstrom)!=='[0,0,0]'||!(/^[a-f0-9]{64}$/.test(chart.sourceImagesSha256))
    ||!Number.isSafeInteger(chart.nonzeroAtomImageCount)||chart.nonzeroAtomImageCount<0
    ||atoms&&chart.nonzeroAtomImageCount>atoms.length)return false;
  const images=chart.sourceImages;
  if(images===undefined)return true;
  if(!Array.isArray(images)||images.length!==chart.nonzeroAtomImageCount)return false;
  const order=atoms&&new Map(atoms.map((atom,index)=>[atom.id,index]));
  let previous=-1;
  const seen=new Set<string>();
  return images.every(row=>{
    if(!row||typeof row.atomId!=='string'||!row.atomId||seen.has(row.atomId)||!Array.isArray(row.image)||row.image.length!==3
      ||!row.image.every(component=>Number.isSafeInteger(component)&&Math.abs(component)<2**52)||!row.image.some(Boolean))return false;
    seen.add(row.atomId);
    if(!order)return true;
    const index=order.get(row.atomId);
    if(index===undefined||index<=previous)return false;
    previous=index;
    return true;
  });
}
/** Harmonic force constant and reference deviations shown with the result. */
export const XTB_INTERNAL_CONSTRAINT_POLICY = Object.freeze({ forceConstant: 20, forceConstantUnit: 'hartree/bohr^2', bondToleranceAngstrom: 0.001, angleToleranceDegree: 0.1 } as const);
export type XtbPreoptimizationSolvation = XtbSolvation;
export function xtbPreoptimizationSolvationIssue(method:XtbRequest['method'], solvation:XtbRequest['solvation'], periodic=false):string|undefined {
  if(solvation===undefined)return;
  if(periodic)return '周期xTB预优化仅支持气相，请选择气相。';
  if(solvation?.model!=='alpb'||!supportsXtbAlpb(method,solvation.solvent))return '当前xTB预优化方法不支持所选溶剂，请选择有效介质。';
}
function validateXtbPreoptimizationSolvation(request:XtbRequest,evidence:XtbSolvationEvidence|undefined):void {
  const issue=xtbPreoptimizationSolvationIssue(request.method,request.solvation,Boolean(request.structure.cell));
  if(issue)throw new Error(issue);
  if(!request.solvation){requireValue(evidence===undefined,'气相xTB预优化混入隐式溶剂结果。');return;}
  requireValue(matchesNativeAlpb(request.method,request.solvation.solvent,evidence),'xTB预优化缺少匹配的原生ALPB溶剂回执。');
}
function matchesNativeAlpb(method:XtbRequest['method'],solvent:string,evidence:XtbSolvationEvidence|undefined):boolean {
  return supportsXtbAlpb(method,solvent)&&evidence?.model==='alpb'&&evidence.solvent===solvent
    &&evidence.kernel==='p16'&&evidence.referenceState==='gsolv'&&evidence.temperatureKelvin===298.15
    &&evidence.sourceField==='stdout:solvation-model'&&evidence.parameterSet===`internal ${XTB_METHOD_LABELS[method]}/ALPB`;
}
/** Read retained results without guessing a method or execution from status text. */
export function isXtbPreparationProvenance(value:unknown,after:unknown,unit:unknown):value is XtbPreparationProvenance {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const receipt=value as XtbPreparationProvenance;
  const text=(input:unknown)=>typeof input==='string'&&input.trim().length>0;
  const ordinal=(input:unknown)=>typeof input==='number'&&Number.isSafeInteger(input)&&input>=0;
  if(receipt.schema!==1||receipt.engine!=='xtb'||typeof receipt.method!=='string'||!Object.hasOwn(XTB_METHOD_LABELS,receipt.method)
    ||!text(receipt.documentId)||!ordinal(receipt.sourceRevision)||!Number.isSafeInteger(receipt.charge)
    ||(receipt.method==='gfnff'?receipt.multiplicity!==null:!ordinal(receipt.multiplicity)||receipt.multiplicity===0))return false;
  if(receipt.periodic!==undefined&&(!text(receipt.periodic?.optimizerVersion)||receipt.method==='gxtb'
    ||receipt.periodic.backend!==(receipt.method==='gfn2'||receipt.periodic.optimizer==='native-fire'&&receipt.method==='gfn1'?'tblite':'native')))return false;
  if(receipt.periodic?.coordinateChart!==undefined&&(receipt.periodic.optimizer!=='native-fire'||!validCoordinateChart(receipt.periodic.coordinateChart)))return false;
  if(receipt.periodic?.gradientTargetHartreePerBohr!==undefined){
    const {movableGradientNormHartreePerBohr:gradient,gradientTargetHartreePerBohr:target,gradientTargetMet:met}=receipt.periodic;
    if(receipt.periodic.optimizer!=='native-fire'||target!==1e-4||typeof gradient!=='number'||!Number.isFinite(gradient)||gradient<0||met!==(gradient<=target))return false;
  }
  if(receipt.internalConstraints!==undefined&&(!Array.isArray(receipt.internalConstraints)||!receipt.internalConstraints.every(row=>row&&['B','A','D'].includes(row.type)&&row.mode==='native-harmonic'&&row.action==='freeze'&&row.unit===(row.type==='B'?'angstrom':'degree')&&Array.isArray(row.atomIds)&&row.atomIds.length==={B:2,A:3,D:4}[row.type]&&row.atomIds.every(text)&&new Set(row.atomIds).size===row.atomIds.length&&[row.target,row.actual,row.residual].every(Number.isFinite)&&Math.abs(row.residual-delta(row.type,row.actual-row.target))<1e-6)))return false;
  if(receipt.terminal==='stopped')return ordinal(receipt.frameSeq)&&ordinal(receipt.step)&&after===undefined&&unit===undefined
    &&!Object.hasOwn(receipt,'version')&&!Object.hasOwn(receipt,'solvation');
  if(!['completed','unconverged'].includes(receipt.terminal)||!text(receipt.version)||typeof after!=='number'||!Number.isFinite(after)||unit!=='hartree')return false;
  if(receipt.terminal==='unconverged'&&(!ordinal(receipt.iterations)||receipt.convergenceStatus!=='step-limit'))return false;
  if(receipt.solvation===undefined)return true;
  const solvation=receipt.solvation;
  if(receipt.periodic||typeof solvation?.solvent!=='string'||!/^[a-z0-9]+$/.test(solvation.solvent))return false;
  if(solvation.model==='alpb')return matchesNativeAlpb(receipt.method,solvation.solvent,solvation);
  return solvation.model==='gbsa'&&xtbSolvents(receipt.method,'gbsa').includes(solvation.solvent)&&solvation.kernel==='still'&&solvation.referenceState==='gsolv'
    &&solvation.temperatureKelvin===298.15&&solvation.sourceField==='stdout:solvation-model'&&solvation.parameterSet===`internal ${XTB_METHOD_LABELS[receipt.method]}/GBSA`;
}
export function validateXtbPeriodicity(request:XtbRequest,evidence:XtbPeriodicEvidence|undefined):void{
  const cell=request.structure.cell,periodic=Boolean(cell);
  if(!periodic){requireValue(evidence===undefined,'非周期xTB结果混入周期运行元数据。');return;}
  requireValue(evidence&&JSON.stringify(evidence.sourceCell)===JSON.stringify(cell)&&JSON.stringify(evidence.sourcePbc)===JSON.stringify(cell!.pbc)&&JSON.stringify(evidence.effectivePbc)==='[true,true,true]'&&evidence.fixedCell===true,'周期xTB的原始晶胞或原始/有效周期轴不符。');
  if(request.calculation==='singlepoint'){
    requireValue(evidence.backend==='tblite-api'&&evidence.bondOrderScope==='atom-pair-periodic-aggregate'&&evidence.imageResolved===false&&typeof evidence.version==='string'&&evidence.version.length>0&&typeof evidence.libraryVersion==='string'&&evidence.libraryVersion.length>0&&evidence.parameters?.method==='GFN2-xTB'&&evidence.parameters.accuracy===1&&evidence.parameters.maxIterations===(request.maxSccIterations??250)&&evidence.parameters.electronicTemperatureHartree===.00095,'周期GFN2原子对聚合键级的来源或参数不符。');
    return;
  }
  requireValue('optimizer' in evidence&&request.method!=='gxtb'&&typeof evidence.optimizerVersion==='string'&&evidence.optimizerVersion.length>0&&evidence.gradientUnit==='hartree/bohr','周期xTB优化方法路线不符。');
  if(evidence.optimizer==='native-fire'){
    requireValue(evidence.backend===(['gfn1','gfn2'].includes(request.method)?'tblite':'native')&&evidence.accuracy===0.01&&evidence.optimizationLevel==='extreme','周期xTB缺少固定晶胞FIRE质量设置。');
    requireValue(validCoordinateChart(evidence.coordinateChart,request.structure.atoms),'周期FIRE缺少匹配的固定晶格坐标表示。');
  }else{
    requireValue(evidence.optimizer==='scipy-lbfgsb'&&evidence.backend===(request.method==='gfn2'?'tblite':'native'),'旧周期优化来源不一致。');
    if(request.method==='gfnff')requireValue(/^[a-f0-9]{64}$/.test(evidence.forceFieldTopologySha256??''),'旧GFN-FF结果缺少本次原生初始拓扑身份。');
  }
}

export function xtbOptimizationStepKind(request:XtbRequest,periodic?:XtbPeriodicEvidence) {
  if(!request.structure.cell)return 'native-log-frame';
  return periodic&&'optimizer' in periodic&&periodic.optimizer==='native-fire'?'native-fire-cycle':'outer-optimizer-iteration';
}

function xtbPreparationSource(request:XtbRequest,periodic:XtbPeriodicEvidence|undefined) {
  return {
    schema:1,engine:'xtb',method:request.method,documentId:request.stamp.documentId,sourceRevision:request.stamp.revision,
    charge:request.charge,multiplicity:request.method==='gfnff'||request.uhf===undefined?null:request.uhf+1,
    ...(periodic&&'optimizer' in periodic?{periodic:{backend:periodic.backend,optimizerVersion:periodic.optimizerVersion,optimizer:periodic.optimizer,
      ...(periodic.coordinateChart?{coordinateChart:structuredClone(periodic.coordinateChart)}:{}),
      ...(periodic.movableGradientNormHartreePerBohr===undefined?{}:{movableGradientNormHartreePerBohr:periodic.movableGradientNormHartreePerBohr}),
      ...(periodic.gradientTargetHartreePerBohr===undefined?{}:{gradientTargetHartreePerBohr:periodic.gradientTargetHartreePerBohr,gradientTargetMet:periodic.gradientTargetMet})}}:{}),
  } as const satisfies Pick<XtbPreparationProvenance,'schema'|'engine'|'method'|'documentId'|'sourceRevision'|'charge'|'multiplicity'|'periodic'>;
}

/** Stop snapshots retain geometry only. No convergence, energy or MBO is invented. */
export function applyXtbStoppedCoordinates(document:ModelDocument,result:XtbStoppedCoordinateResult,movableAtomIds:readonly string[]):ModelDocument{
  const {request,frame}=result,original=document.draft.structure;
  requireValue((request.calculation??'optimize')==='optimize'&&frame.stepKind===xtbOptimizationStepKind(request,frame.periodic)&&typeof frame.sessionId==='string'&&frame.sessionId.length>0&&Number.isSafeInteger(frame.seq)&&frame.seq>=0&&Number.isSafeInteger(frame.step)&&frame.step>=0,'xTB停止快照缺少可靠原生帧身份。');
  validateXtbPeriodicity(request,frame.periodic);
  requireValue(request.stamp.documentId===document.id&&request.stamp.revision===document.revision&&JSON.stringify(frame.stamp)===JSON.stringify(request.stamp),'xTB停止帧已不属于当前模型修订。');
  requireValue(graphFingerprint(request.structure)===graphFingerprint(original)&&coordinatesFingerprint(request.structure)===coordinatesFingerprint(original),'xTB停止请求与原始模型不一致。');
  const constraints=effectiveModelConstraints(document),ids=new Set(original.atoms.map(atom=>atom.id!)),movable=new Set(movableAtomIds);
  requireValue(movable.size>0&&movable.size===movableAtomIds.length&&movableAtomIds.every(id=>ids.has(id))&&constraints.frozenAtomIds.every(id=>!movable.has(id)),'xTB停止帧可动范围或已有冻结无效。');
  const fixed=new Set(original.atoms.filter(atom=>!movable.has(atom.id!)).map(atom=>atom.id!));
  requireValue(request.frozenAtomIds.length===fixed.size&&sorted(request.frozenAtomIds)===sorted([...fixed]),'xTB停止帧冻结集合与已签发范围不一致。');
  requireValue(frame.coordinates.length===original.atoms.length,'xTB停止帧改变了原子数量。');
  const next=structuredClone(document);
  next.draft.structure.atoms=original.atoms.map((atom,index)=>{const point=frame.coordinates[index];requireValue(point?.id===atom.id&&point.element===atom.element&&[point.x,point.y,point.z].every(value=>Number.isFinite(value)&&Math.abs(value)<=1e6),'xTB停止帧原子身份、顺序或坐标无效。');if(fixed.has(atom.id!))requireValue(Object.is(point.x,atom.x)&&Object.is(point.y,atom.y)&&Object.is(point.z,atom.z),'xTB停止帧改变了固定原子坐标。');return{...atom,x:point.x,y:point.y,z:point.z};});
  requireValue(constraints.coordinates.length===request.constraints.length&&constraints.coordinates.every(row=>row.action==='freeze')&&(!constraints.coordinates.length||request.internalConstraintsConfirmed===true),'xTB停止帧内坐标冻结库存或确认无效。');
  const internalConstraints = constraints.coordinates.map(row => {
    const requested=request.constraints.find(item=>modelCoordinateKey(item)===modelCoordinateKey(row));
    requireValue(requested?.action==='freeze','xTB停止帧约束来源不匹配。');
    const target=row.value??builderCoordinateValue(original,row.type,row.atomIds),actual=builderCoordinateValue(next.draft.structure,row.type,row.atomIds),residual=delta(row.type,actual-target);
    requireValue([target,actual,residual].every(Number.isFinite)&&(requested.value===undefined||Math.abs(requested.value-target)<1e-7),'xTB停止帧内坐标目标或测量无效。');
    return {...row,target,actual,residual,unit:row.type==='B'?'angstrom' as const:'degree' as const,mode:'native-harmonic' as const};
  });
  createBuilderDraft(next.draft.structure);
  next.attachmentPorts=transportLocalAttachmentPorts(next.attachmentPorts??[],original,next.draft.structure).ports;
  next.draft.structure.preparation={
    status:`${XTB_METHOD_LABELS[request.method]}已停止，保留最后可靠结构`,
    xtb:{...xtbPreparationSource(request,frame.periodic),terminal:'stopped',frameSeq:frame.seq,step:frame.step,...(internalConstraints.length?{internalConstraints}:{})},
  };
  return next;
}

/** Pure coordinate acceptance. Caller owns issued-stamp checking and the single Store commit. */
export function applyXtbCoordinates(document: ModelDocument, result: XtbCoordinateResult, movableAtomIds: readonly string[]): ModelDocument {
  const { request, coordinates, metadata } = result, original = document.draft.structure;
  requireValue((request.calculation ?? 'optimize') === 'optimize' && (metadata.calculation ?? 'optimize') === 'optimize', '单点结果不能作为优化坐标提交。');
  requireValue(request.stamp.documentId === document.id && request.stamp.revision === document.revision, 'xTB结果已不属于当前模型修订。');
  requireValue(graphFingerprint(request.structure) === graphFingerprint(original) && coordinatesFingerprint(request.structure) === coordinatesFingerprint(original), 'xTB请求与原始模型不一致。');
  const stepLimit=request.maxSteps??(request.structure.cell?1000:500);
  requireValue(metadata.engine === 'xtb' && metadata.method === request.method && metadata.charge === request.charge, 'xTB方法或电子态结果不匹配。');
  requireValue((request.optimizationStepPolicy==='native-default'&&!request.structure.cell||metadata.maxSteps===stepLimit)
    &&validXtbOptimizationTerminal(request,metadata),'xTB优化收敛状态与实际步数不符。');
  validateXtbPeriodicity(request,metadata.periodic);
  if(metadata.periodic&&'optimizer' in metadata.periodic&&metadata.periodic.optimizer==='native-fire'){
    const gradient=metadata.periodic.movableGradientNormHartreePerBohr;
    requireValue(typeof gradient==='number'&&Number.isFinite(gradient)&&gradient>=0,'周期FIRE结果缺少有效的可动梯度。');
    requireValue(metadata.periodic.gradientTargetHartreePerBohr===undefined||metadata.periodic.gradientTargetHartreePerBohr===1e-4&&metadata.periodic.gradientTargetMet===(gradient<=1e-4),'周期FIRE精度目标与实际梯度不一致。');
  }
  validateXtbPreoptimizationSolvation(request,metadata.solvation);
  if(request.structure.cell)requireValue(metadata.bondOrders===undefined,'周期优化不能消费没有镜像身份的原子对键级。');
  requireValue(metadata.uhf === (request.method === 'gfnff' ? null : request.uhf), 'xTB自旋结果不匹配。');
  requireValue(Number.isFinite(metadata.energyHartree) && metadata.energyUnit === 'hartree' && metadata.coordinateUnit === 'angstrom', 'xTB结果单位或能量无效。');
  requireValue(typeof metadata.version === 'string' && metadata.version.length > 0, 'xTB完成元数据无效。');
  const constraints = effectiveModelConstraints(document), ids=new Set(original.atoms.map(atom=>atom.id!)),movable = new Set(movableAtomIds);
  // The Store supplies the variable set from its issued stamp. Additional
  // request-only fixes are exactly its complement, never new document freezes.
  requireValue(movable.size>0&&movable.size===movableAtomIds.length&&movableAtomIds.every(id=>ids.has(id)), 'xTB可动范围身份无效。');
  requireValue(constraints.frozenAtomIds.every(id=>!movable.has(id)), 'xTB可动范围包含已有冻结原子。');
  const fixed = new Set(original.atoms.filter(atom=>!movable.has(atom.id!)).map(atom=>atom.id!));
  requireValue(request.frozenAtomIds.length===fixed.size&&sorted(request.frozenAtomIds)===sorted([...fixed])&&metadata.frozenAtomIds.length===fixed.size&&sorted(metadata.frozenAtomIds)===sorted(request.frozenAtomIds), 'xTB冻结集合与已签发可动范围不一致。');
  requireValue(coordinates.length === original.atoms.length, 'xTB改变了原子数量。');
  const next = structuredClone(document);
  next.draft.structure.atoms = original.atoms.map((atom, index) => {
    const point = coordinates[index];
    requireValue(point?.id === atom.id && point.element === atom.element && [point.x, point.y, point.z].every(Number.isFinite), 'xTB原子身份、顺序或坐标无效。');
    if (fixed.has(atom.id!)) requireValue(Object.is(point.x, atom.x) && Object.is(point.y, atom.y) && Object.is(point.z, atom.z), 'xTB改变了固定原子坐标。');
    return { ...atom, x: point.x, y: point.y, z: point.z };
  });
  const rows = constraints.coordinates;
  requireValue(rows.every(row => row.action === 'freeze'), 'xTB预优化不执行内坐标扫描。');
  requireValue(rows.length === request.constraints.length && rows.length === metadata.internalConstraints.length, 'xTB内坐标约束库存不匹配。');
  requireValue(metadata.internalConstraintMode === (rows.length ? 'native-harmonic' : 'none') && (!rows.length || request.internalConstraintsConfirmed === true), 'xTB原生约束尚未确认。');
  for (const row of rows) {
    const key = modelCoordinateKey(row), requested = request.constraints.find(item => modelCoordinateKey(item) === key), measured = metadata.internalConstraints.find(item => modelCoordinateKey(item) === key);
    requireValue(requested && measured && requested.action === 'freeze' && measured.mode === 'native-harmonic', 'xTB约束来源不匹配。');
    const target = row.value ?? builderCoordinateValue(original, row.type, row.atomIds);
    const actual = builderCoordinateValue(next.draft.structure, row.type, row.atomIds);
    const residual = delta(row.type, actual - target);
    requireValue([target, actual, residual, measured.target, measured.actual, measured.residual].every(Number.isFinite), 'xTB约束测量无效。');
    requireValue(measured.unit === (row.type === 'B' ? 'angstrom' : 'degree') && Math.abs(measured.target - target) < 1e-7 && Math.abs(delta(row.type, measured.actual - actual)) < 1e-6 && Math.abs(measured.residual - residual) < 1e-6, 'xTB约束残差与实际坐标不一致。');
    requireValue(requested.value === undefined || Math.abs(requested.value - target) < 1e-7, 'xTB请求修改了约束目标。');
  }
  createBuilderDraft(next.draft.structure);
  next.attachmentPorts = transportLocalAttachmentPorts(next.attachmentPorts ?? [], original, next.draft.structure).ports;
  next.draft.structure.preparation = {
    after:metadata.energyHartree,unit:metadata.energyUnit,status:metadata.converged?`${XTB_METHOD_LABELS[request.method]}优化完成${metadata.periodic&&'optimizer' in metadata.periodic&&metadata.periodic.gradientTargetMet===false?' · 未达到周期梯度目标':''}`:`${XTB_METHOD_LABELS[request.method]}达到 ${metadata.iterations} 步，尚未收敛`,
    xtb:{...xtbPreparationSource(request,metadata.periodic),...(metadata.converged?{terminal:'completed'}:{terminal:'unconverged',convergenceStatus:'step-limit'}),version:metadata.version,
      iterations:metadata.iterations,...(metadata.optimizer?{optimizer:metadata.optimizer}:{}),
      ...(metadata.engineIdentity?{engineIdentity:structuredClone(metadata.engineIdentity)}:{}),
      ...(rows.length?{internalConstraints:structuredClone(metadata.internalConstraints)}:{}),
      ...(metadata.solvation?{solvation:structuredClone(metadata.solvation)}:{})},
  };
  return next;
}
