import { createBuilderDraft } from '../../core/builder-draft';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { assertBuilderStereoPreserved } from '../../core/builder-stereo';
import { transportLocalAttachmentPorts } from '../../core/modeling/attachment-ports';
import { coordinatesFingerprint, graphFingerprint } from '../../core/modeling/graph';
import { effectiveModelConstraints, modelCoordinateKey } from '../constraints';
import type { ModelDocument } from '../contracts';
import { XTB_METHOD_LABELS, type XtbCoordinateResult, type XtbStoppedCoordinateResult, type XtbRequest, type XtbPeriodicEvidence } from './contracts';

function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const sorted = (ids: readonly string[]) => [...ids].sort().join('\0');
const delta = (type: string, value: number) => type === 'D' ? ((value + 180) % 360 + 360) % 360 - 180 : value;
/** Mirrors the independent desktop boundary; these are acceptance limits,
 * not a guarantee that every constrained optimization will converge. */
export const XTB_INTERNAL_CONSTRAINT_POLICY = Object.freeze({ forceConstant: 20, forceConstantUnit: 'hartree/bohr^2', bondToleranceAngstrom: 0.001, angleToleranceDegree: 0.1 } as const);
export function validateXtbPeriodicity(request:XtbRequest,evidence:XtbPeriodicEvidence|undefined):void{
  const cell=request.structure.cell,periodic=Boolean(cell);
  if(!periodic){requireValue(evidence===undefined,'非周期xTB结果混入周期运行元数据。');return;}
  requireValue(evidence&&JSON.stringify(evidence.sourceCell)===JSON.stringify(cell)&&JSON.stringify(evidence.sourcePbc)===JSON.stringify(cell!.pbc)&&JSON.stringify(evidence.effectivePbc)==='[true,true,true]'&&evidence.fixedCell===true,'周期xTB的原始晶胞或原始/有效周期轴不符。');
  if(request.calculation==='singlepoint'){
    requireValue(evidence.backend==='tblite-api'&&evidence.bondOrderScope==='atom-pair-periodic-aggregate'&&evidence.imageResolved===false&&typeof evidence.version==='string'&&evidence.version.length>0&&typeof evidence.libraryVersion==='string'&&evidence.libraryVersion.length>0&&evidence.parameters?.method==='GFN2-xTB'&&evidence.parameters.accuracy===1&&evidence.parameters.maxIterations===(request.maxSccIterations??250)&&evidence.parameters.electronicTemperatureHartree===.00095,'周期GFN2原子对聚合键级的来源或参数不符。');
    return;
  }
  requireValue('optimizer' in evidence&&evidence.optimizer==='scipy-lbfgsb'&&typeof evidence.optimizerVersion==='string'&&evidence.optimizerVersion.length>0&&evidence.backend===(request.method==='gfn2'?'tblite':'native')&&evidence.gradientUnit==='hartree/bohr','周期xTB优化方法路线不符。');
  if(request.method==='gfnff')requireValue(/^[a-f0-9]{64}$/.test(evidence.forceFieldTopologySha256??''),'GFN-FF缺少本次原生初始拓扑身份。');
}

/** Stop snapshots retain geometry only. No convergence, energy or MBO is invented. */
export function applyXtbStoppedCoordinates(document:ModelDocument,result:XtbStoppedCoordinateResult,movableAtomIds:readonly string[]):ModelDocument{
  const {request,frame}=result,original=document.draft.structure;
  requireValue((request.calculation??'optimize')==='optimize'&&frame.stepKind===(request.structure.cell?'outer-optimizer-iteration':'native-log-frame')&&typeof frame.sessionId==='string'&&frame.sessionId.length>0&&Number.isSafeInteger(frame.seq)&&frame.seq>=0&&Number.isSafeInteger(frame.step)&&frame.step>=0,'xTB停止快照缺少可靠原生帧身份。');
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
  for(const row of constraints.coordinates){const requested=request.constraints.find(item=>modelCoordinateKey(item)===modelCoordinateKey(row));requireValue(requested?.action==='freeze','xTB停止帧约束来源不匹配。');const target=row.value??builderCoordinateValue(original,row.type,row.atomIds),actual=builderCoordinateValue(next.draft.structure,row.type,row.atomIds),residual=delta(row.type,actual-target),tolerance=row.type==='B'?XTB_INTERNAL_CONSTRAINT_POLICY.bondToleranceAngstrom:XTB_INTERNAL_CONSTRAINT_POLICY.angleToleranceDegree;requireValue([target,actual,residual].every(Number.isFinite)&&(requested.value===undefined||Math.abs(requested.value-target)<1e-7)&&Math.abs(residual)<=tolerance,'xTB停止帧内坐标冻结未达标，保留原模型。');}
  createBuilderDraft(next.draft.structure);assertBuilderStereoPreserved(original,next.draft.structure);
  next.attachmentPorts=transportLocalAttachmentPorts(next.attachmentPorts??[],original,next.draft.structure).ports;
  delete next.draft.structure.preparation;
  return next;
}

/** Pure coordinate acceptance. Caller owns issued-stamp checking and the single Store commit. */
export function applyXtbCoordinates(document: ModelDocument, result: XtbCoordinateResult, movableAtomIds: readonly string[]): ModelDocument {
  const { request, coordinates, metadata } = result, original = document.draft.structure;
  requireValue((request.calculation ?? 'optimize') === 'optimize' && (metadata.calculation ?? 'optimize') === 'optimize', '单点结果不能作为优化坐标提交。');
  requireValue(request.stamp.documentId === document.id && request.stamp.revision === document.revision, 'xTB结果已不属于当前模型修订。');
  requireValue(graphFingerprint(request.structure) === graphFingerprint(original) && coordinatesFingerprint(request.structure) === coordinatesFingerprint(original), 'xTB请求与原始模型不一致。');
  requireValue(metadata.converged === true && metadata.engine === 'xtb' && metadata.method === request.method && metadata.charge === request.charge, 'xTB方法或电子态结果不匹配。');
  validateXtbPeriodicity(request,metadata.periodic);
  if(request.structure.cell)requireValue(metadata.bondOrders===undefined,'周期优化不能消费没有镜像身份的原子对键级。');
  requireValue(metadata.uhf === (request.method === 'gfnff' ? null : request.uhf), 'xTB自旋结果不匹配。');
  requireValue(Number.isFinite(metadata.energyHartree) && metadata.energyUnit === 'hartree' && metadata.coordinateUnit === 'angstrom', 'xTB结果单位或能量无效。');
  requireValue(typeof metadata.iterations === 'number' && Number.isSafeInteger(metadata.iterations) && metadata.iterations >= 0 && typeof metadata.version === 'string' && metadata.version.length > 0, 'xTB完成元数据无效。');
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
    const tolerance = row.type === 'B' ? XTB_INTERNAL_CONSTRAINT_POLICY.bondToleranceAngstrom : XTB_INTERNAL_CONSTRAINT_POLICY.angleToleranceDegree;
    requireValue(Math.abs(residual) <= tolerance, `xTB内坐标冻结未达标：${row.type} ${row.atomIds.join('-')} 偏差 ${Math.abs(residual).toPrecision(6)} ${row.type === 'B' ? 'Å' : '°'}，超过 ${tolerance} ${row.type === 'B' ? 'Å' : '°'}；保留原模型。`);
  }
  createBuilderDraft(next.draft.structure);
  assertBuilderStereoPreserved(original, next.draft.structure);
  next.attachmentPorts = transportLocalAttachmentPorts(next.attachmentPorts ?? [], original, next.draft.structure).ports;
  next.draft.structure.preparation = { after: metadata.energyHartree, unit: 'hartree', status: `${XTB_METHOD_LABELS[request.method]}优化完成${rows.length ? ' · 内坐标冻结残差达标' : ''}` };
  return next;
}
