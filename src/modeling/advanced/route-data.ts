import type { Structure } from '../../core/types';
import type { AdvancedPathFrameData, AdvancedPathRequest, AdvancedPathEvent, AdvancedPathScanSettings } from './path-contracts';
import type { ConformerSamplingFramePayload, ConformerSamplingRequest, ConformerSamplingEvent } from './sampling-contracts';
import { getConformerSamplingCapability, selectConformerSamplingDriver } from './sampling-contracts';
import type { AissRequest, AissCompletionEvent, AissSearchCheckpointEvent, AissAtomMapping } from './docking-contracts';

/** Preserve every scientific payload field, stripping only transport envelope. */
export function routePayload<T extends object>(value: T): T {
  const payload = structuredClone(value) as T & Record<string, unknown>;
  for (const field of ['schema', 'sessionId', 'stamp', 'runIdentity', 'operation', 'method', 'seq', 'event', 'kind', 'effectiveResources']) delete payload[field];
  return payload;
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const ordinal = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const vector = (n: unknown): n is [number, number, number] => Array.isArray(n) && n.length === 3 && n.every(finite);
export function pathScanPointCount(scan: AdvancedPathScanSettings): number {
  const axes = 'coordinates' in scan ? scan.coordinates : [scan];
  if (!axes.length || axes.length > 3 || axes.some(axis => !finite(axis.start) || !finite(axis.stop))) throw new Error('扫描坐标数量或有向区间无效。');
  const counts = 'combination' in scan && scan.combination === 'grid' ? scan.coordinates.map(axis => axis.pointCount) : [scan.pointCount];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 2)) throw new Error('扫描点数无效。');
  const total = counts.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(total)) throw new Error('扫描总点数超过可精确表示的整数范围。');
  return total;
}
export function pathScanPoint(scan: AdvancedPathScanSettings, pointIndex: number) {
  const count = pathScanPointCount(scan);
  if (!ordinal(pointIndex) || pointIndex >= count) throw new Error('扫描点序号越界。');
  const axes = 'coordinates' in scan ? scan.coordinates : [scan], grid = 'combination' in scan && scan.combination === 'grid';
  const synchronousCount = 'pointCount' in scan ? scan.pointCount : 0;
  const counts = grid ? scan.coordinates.map(axis => axis.pointCount) : axes.map(() => synchronousCount);
  let remaining = pointIndex; const gridIndices = axes.map(() => pointIndex);
  if (grid) for (let i = axes.length - 1; i >= 0; i--) { gridIndices[i] = remaining % counts[i]; remaining = Math.floor(remaining / counts[i]); }
  return { gridIndices, targets: axes.map((axis, i) => ({ ...axis.coordinate, target: axis.start + (axis.stop - axis.start) * gridIndices[i] / (counts[i] - 1), unit: axis.coordinate.type === 'B' ? 'angstrom' as const : 'degree' as const })) };
}
function validateScanPoint(scan: AdvancedPathScanSettings, data: { pointIndex?: number; target?: number; targets?: AdvancedPathFrameData['targets']; gridIndices?: number[] }) {
  if (!ordinal(data.pointIndex)) throw new Error('扫描点身份或目标无效。');
  const expected = pathScanPoint(scan, data.pointIndex!);
  if ('coordinates' in scan || data.targets !== undefined || data.gridIndices !== undefined) {
    if (JSON.stringify(data.gridIndices) !== JSON.stringify(expected.gridIndices) || data.targets?.length !== expected.targets.length) throw new Error('扫描网格索引或目标维度不符。');
    for (let i = 0; i < expected.targets.length; i++) {
      const actual = data.targets[i], target = expected.targets[i];
      if (actual.type !== target.type || JSON.stringify(actual.atomIds) !== JSON.stringify(target.atomIds) || actual.unit !== target.unit || !finite(actual.target)
        || Math.abs(actual.target - target.target) > 8 * Number.EPSILON * Math.max(1, Math.abs(target.target))) throw new Error('扫描点目标或原子对应发生变化。');
    }
  } else if (!finite(data.target) || Math.abs(data.target - expected.targets[0].target) > 8 * Number.EPSILON * Math.max(1, Math.abs(expected.targets[0].target))) throw new Error('扫描点目标与有向区间不符。');
}
export function routeStructure(source: Structure, coordinates: AdvancedPathFrameData['coordinates'], frozenAtomIds: readonly string[]): Structure {
  if (!Array.isArray(coordinates) || coordinates.length !== source.atoms.length) throw new Error('路径/采样帧原子数量不完整。');
  const fixed = new Set(frozenAtomIds), structure = structuredClone(source);
  structure.atoms = source.atoms.map((atom, index) => {
    const point = coordinates[index];
    if (point?.id !== atom.id || point.element !== atom.element || ![point.x, point.y, point.z].every(n => finite(n) && Math.abs(n) <= 1e6)) throw new Error('路径/采样帧稳定ID、元素、顺序或坐标无效。');
    if (fixed.has(atom.id!) && !(point.x === atom.x && point.y === atom.y && point.z === atom.z)) throw new Error('路径/采样帧改变了XYZ冻结原子。');
    return { ...atom, x: point.x, y: point.y, z: point.z };
  });
  structure.preparation = undefined; structure.molfile = undefined; return structure;
}
export function validatePathFrame(request: AdvancedPathRequest, data: AdvancedPathFrameData): Structure {
  if (!data.stageId || !data.collectionId || !ordinal(data.frameIndex) || !ordinal(data.iteration)
    || data.units?.coordinates !== 'angstrom' || data.units.energy !== 'eV' || data.units.forces !== 'eV/angstrom'
    || data.units.curvature !== 'eV/angstrom^2' || !Array.isArray(data.constraintResiduals)) throw new Error('路径帧过程层级或单位无效。');
  if (data.pointIndex !== undefined) {
    if (request.operation !== 'scan') throw new Error('非扫描过程不能携带扫描点身份。');
    validateScanPoint(request.scan, data);
  }
  if (data.imageIndex !== undefined && (!ordinal(data.imageIndex) || request.operation !== 'ci-neb-ts')) throw new Error('路径image身份无效。');
  if (data.role === 'initial-path') {
    if (!ordinal(data.imageIndex) || 'energyEV' in data && data.energyEV !== undefined) throw new Error('初路径几何不能携带物理能量。');
  } else if (!['optimizer', 'point-result', 'candidate'].includes(data.role) || !finite(data.energyEV)
    || !finite(data.projectedForceMaxEVPerAngstrom) || data.projectedForceMaxEVPerAngstrom < 0
    || !Array.isArray(data.rawForcesEVPerAngstrom) || data.rawForcesEVPerAngstrom.length !== request.structure.atoms.length
    || !data.rawForcesEVPerAngstrom.every(vector)) throw new Error('物理路径帧缺少实际能量或完整力。');
  return routeStructure(request.structure, data.coordinates, request.frozenAtomIds ?? []);
}
export function validatePathCompletion(request: AdvancedPathRequest, event: Extract<AdvancedPathEvent, { event: 'completed' }>): void {
  const preview = request.operation === 'ci-neb-ts' && request.neb.previewOnly === true;
  const expected = preview ? 'initial-path' : request.operation === 'scan' ? 'scan' : 'ts-candidate';
  if (event.resultKind !== expected || event.stationaryPointValidation !== 'not-run' || event.searchConverged !== !preview
    || !ordinal(event.evaluations) || event.evaluations > request.maxEvaluations! || !finite(event.elapsedSeconds)
    || event.backend?.driver !== 'ASE' || !event.backend.aseVersion || event.backend.method !== request.method
    || event.backend.physicalCalculatorCreated !== !preview || event.backend.calculator !== (preview ? 'none' : 'tblite')
    || preview && event.evaluations !== 0 || !preview && event.evaluations < 1 || event.exit.code !== 0 || event.exit.signal !== null) throw new Error('路径完成身份、物理计算声明或搜索/验证边界不符。');
  if (event.resultKind === 'scan') {
    if (request.operation !== 'scan' || event.points.length !== pathScanPointCount(request.scan)
      || new Set(event.points.map(point => point.pointIndex)).size !== event.points.length
      || event.points.some(point => !point.searchConverged || !finite(point.energyEV))) throw new Error('扫描完成没有覆盖完整有效点集合。');
    for (const point of event.points) validateScanPoint(request.scan, point);
  }
  if (event.resultKind === 'ts-candidate' && (!finite(event.curvatureEVPerAngstrom2) || event.lastFrame.role !== 'candidate')) throw new Error('TS搜索缺少候选曲率或候选来源，仍未作鞍点验证。');
  validatePathFrame(request, event.lastFrame);
}
function validateNativeSamplingProtection(request: ConformerSamplingRequest,data:ConformerSamplingFramePayload):void {
  const wanted=request.nativeProtection,evidence=data.nativeMD?.nativeProtection;
  if(!wanted&&evidence===undefined)return;
  if(!evidence)throw new Error('原生保护缺少实际定义/单位/原子对应。');
  const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),near=(a:unknown,b:number)=>finite(a)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b)),atoms=request.structure.atoms;
  if(wanted?.core){const c=evidence.core,w=wanted.core,indices=w.atomIds.map(id=>atoms.findIndex(a=>a.id===id)+1);
    if(!c||c.kind!=='pairwise-distance'||!same(c.atomIds,w.atomIds)||!same(c.nativeAtomIndices,indices)||c.forceConstantEVPerAngstrom2!==w.forceConstantEVPerAngstrom2||!near(c.inputForceConstantHartreePerBohr2,w.forceConstantEVPerAngstrom2*.529177210903**2/27.211386024367243)||!near(c.actualPairForceConstantEVPerAngstrom2,w.forceConstantEVPerAngstrom2/(indices.length-1))||c.pairs.length!==indices.length*(indices.length-1)/2)throw new Error('原生核心对距势参数或原子对应不符。');
    let index=0;for(let i=0;i<indices.length;i++)for(let j=0;j<i;j++){const p=c.pairs[index++],a=atoms[indices[i]-1],b=atoms[indices[j]-1];if(!p||!same(p.atomIds,[w.atomIds[i],w.atomIds[j]])||!same(p.nativeAtomIndices,[indices[i],indices[j]])||!near(p.referenceDistanceAngstrom,Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)))throw new Error('原生核心参考对距与源结构不符。');}
  }else if(evidence.core!==null)throw new Error('未请求原生核心势。');
  if(wanted?.sphere){const s=evidence.sphere,w=wanted.sphere;if(!s||s.kind!=='polynomial'||!same(s.centerAngstrom,w.centerAngstrom)||s.radiusAngstrom!==w.radiusAngstrom||s.exponent!==30||!same(s.nativeCenterBohr,[0,0,0])||!near(s.nativeRadiusBohr,w.radiusAngstrom/.529177210903)||s.energyScaleHartree!==1||s.appliesTo!=='all-atoms')throw new Error('原生30次幂球势的实际定义或单位不符。');
    const penetration=Math.max(0,...data.coordinates.map(a=>Math.hypot(a.x-w.centerAngstrom[0],a.y-w.centerAngstrom[1],a.z-w.centerAngstrom[2])-w.radiusAngstrom));if(!near(data.diagnostics.maxWallPenetrationAngstrom,penetration))throw new Error('原生球势穿透与源坐标不符。');
  }else if(evidence.sphere!==null)throw new Error('未请求原生球势。');
  const offset=wanted?.sphere?wanted.sphere.centerAngstrom.map(v=>-v):[0,0,0],transform=evidence.coordinateTransform;if(!transform||transform.kind!==(wanted?.sphere?'translation':'identity')||transform.offsetAngstrom.length!==3||!transform.offsetAngstrom.every((v,i)=>v===offset[i]))throw new Error('原生保护坐标平移及逆变换身份不符。');
}
export function validateSamplingFrame(request: ConformerSamplingRequest, data: ConformerSamplingFramePayload): Structure {
  const selected=selectConformerSamplingDriver(request),native=selected.driver==='native-xtb-md';
  if(request.nativeProtection&&!native)throw new Error('原生保护定义不能移贴到ASE采样方式。');
  const capability=getConformerSamplingCapability(request);
  if(native&&request.operation==='metadynamics'){
    const m=request.metadynamics??{},e=data.nativeMD?.metadynamics,near=(a:unknown,b:number)=>finite(a)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b));
    const ids=m.atomIds??request.structure.atoms.map(a=>a.id!),height=m.heightEV??.01,sigma=m.sigmaAngstrom??.5,interval=m.depositEveryFs??100,dt=request.dtFs??2;
    if(!e||JSON.stringify(e.atomIds)!==JSON.stringify(ids)||JSON.stringify(e.nativeAtomIndices)!==JSON.stringify(ids.map(id=>request.structure.atoms.findIndex(a=>a.id===id)+1))
      ||e.heightEV!==height||e.sigmaAngstrom!==sigma||e.depositEveryFs!==interval||e.maxHistory!==(m.maxHistory??1000)
      ||e.depositSteps!==Math.round(interval/dt)||!near(e.factorHartree,height/27.211386024367243)||!near(e.alphaInverseBohr2,.529177210903**2/(2*sigma*sigma))
      ||e.scoordFs!==(e.depositSteps-1)*dt||e.rampPerStep!==.03||e.initialReference!=='explicit-input-geometry'||e.historyPolicy!=='complete-no-rolling'
      ||e.depositTiming!=='pre-step'||e.instantaneousBiasEnergy!=='not-reported'||data.metaBiasEV!==null||data.physicalEnergyEV!==null)throw Error('原生MTD偏置参数、原子范围或能量证据不一致。');
  }
  if(!capability.shakeSupported&&request.shakeHydrogenBonds===true||native&&(request.coreProtection!==undefined||request.sphere!==undefined||request.frozenAtomIds?.length))throw new Error('普通原生MD不支持此SHAKE/保护组合，不能静默改为ASE或替换势定义。');
  if(request.driver!==undefined&&request.driver!==selected.driver||(data.driver??'ase-langevin')!==selected.driver)throw new Error('采样实际驱动与保护/方法能力不一致。');
  if (!ordinal(data.frameIndex) || !ordinal(data.step) || !finite(data.timeFs) || data.timeFs < 0
    || !data.stageId || data.optimizationPerformed !== false || !['trajectory', 'sampled-candidate'].includes(data.role)
    || data.collectionId !== (data.role === 'sampled-candidate' ? 'sampled-candidates' : 'sampling-trajectory')
    || data.requiresUnbiasedOptimization !== (data.role === 'sampled-candidate')
    || data.units?.coordinates !== 'angstrom' || data.units.energy !== 'eV' || data.units.velocity !== 'angstrom/fs'
    || data.units.time !== 'fs' || data.units.temperature !== 'K'
    || !finite(data.targetTemperatureK)||!(finite(data.metaBiasEV)||native&&data.metaBiasEV===null)||![data.coreBiasEV,data.sphereBiasEV].every(v=>finite(v)||native&&v===null)
    || ![data.physicalEnergyEV,data.sampledPotentialEV,data.kineticEnergyEV,data.temperatureK].every(v=>finite(v)||native&&v===null)
    || !(native&&data.velocitiesAngstromPerFs===null)&&(!Array.isArray(data.velocitiesAngstromPerFs)||data.velocitiesAngstromPerFs.length!==request.structure.atoms.length||!data.velocitiesAngstromPerFs.every(vector))) throw new Error('采样帧角色、单位、速度或能量分层无效。');
  if(data.physicalEnergyEV!==null&&data.sampledPotentialEV!==null&&data.coreBiasEV!==null&&data.metaBiasEV!==null&&data.sphereBiasEV!==null){const sum=data.physicalEnergyEV+data.coreBiasEV+data.metaBiasEV+data.sphereBiasEV;if(Math.abs(data.sampledPotentialEV-sum)>1e-8*Math.max(1,Math.abs(sum)))throw new Error('采样物理能与附加势总和不一致。');}
  if(!request.coreProtection&&!request.nativeProtection?.core&&data.coreBiasEV!==0||request.operation!=='metadynamics'&&data.metaBiasEV!==0||!request.sphere&&!request.nativeProtection?.sphere&&data.sphereBiasEV!==0)throw new Error('采样势能与物理/约束/偏置分项不一致。');
  if(Math.abs(data.timeFs-data.step*(request.dtFs??.5))>1e-8)throw new Error('采样帧时间与完整积分步数不一致。');
  const fixed = new Set(request.frozenAtomIds ?? []);
  if (request.structure.atoms.some((atom, i) => fixed.has(atom.id!) && (!data.velocitiesAngstromPerFs||data.velocitiesAngstromPerFs[i].some(n => n !== 0)))) throw new Error('XYZ冻结原子不能带有采样速度。');
  if (request.coreProtection) {
    const core = data.diagnostics?.core;
    if (!core || !finite(core.rmsdAngstrom) || core.rmsdAngstrom < 0 || !finite(core.maxResidualAngstrom) || core.maxResidualAngstrom < 0
      || ![0, 1, 2, 3].includes(core.rank) || core.orientationUnique !== (core.rank >= 2)) throw new Error('核心软保护缺少相对几何和旋转退化诊断。');
  }
  if(native){const evidence=data.nativeMD;
    if(!evidence||evidence.method!==request.method||!evidence.version||!/^[a-f0-9]{64}$/.test(evidence.inputSha256)||evidence.shakeHydrogenBonds!==(request.shakeHydrogenBonds??capability.shakeDefaultEnabled)||!ordinal(evidence.rawIndex)
      ||!['xtb.trj','mdrestart'].includes(evidence.sourceArtifact)||!['pre-step','restart-final'].includes(evidence.frameTiming)||!['half-step','restart','unavailable'].includes(evidence.velocityPhase)||typeof evidence.nativeClosed!=='boolean')throw new Error('原生MD帧缺少真实SHAKE/质量/时间相位及产物来源。');
    if(request.hydrogenMassAmu===4?evidence.hydrogenMassAmu!==4||evidence.hydrogenMassMode!=='fixed-amu'||evidence.hydrogenMassScaling!==undefined:evidence.hydrogenMassScaling!==1||evidence.hydrogenMassAmu!=null||(evidence.hydrogenMassMode!==undefined&&evidence.hydrogenMassMode!=='natural'))throw new Error('原生MD实际氢质量与请求不一致。');
    if((evidence.sourceArtifact==='mdrestart')!==(evidence.frameTiming==='restart-final'))throw new Error('原生MD产物与时间相位不一致。');
    if(request.nativeProtection||request.operation==='metadynamics'){if(evidence.energyDefinition!=='native-total-including-sampling-potentials'||data.physicalEnergyEV!==null||data.coreBiasEV!==(request.nativeProtection?.core?null:0)||data.sphereBiasEV!==(request.nativeProtection?.sphere?null:0))throw new Error('原生含势总能不能冒物理能或伪造分项为零。');}
    else if(evidence.energyDefinition!==undefined&&evidence.energyDefinition!=='native-physical-potential')throw new Error('未启用原生保护却声明含势总能。');
    validateNativeSamplingProtection(request,data);
    const finalStep=['md','metadynamics'].includes(request.operation)?Math.round(((request.operation==='metadynamics'?request.metadynamics:request.molecularMD)?.durationFs??50000)/(request.dtFs??2)):0;
    if(evidence.sourceArtifact==='mdrestart'&&(data.step!==finalStep||evidence.nativeClosed!==true||data.physicalEnergyEV!==null||data.sampledPotentialEV!==null||data.kineticEnergyEV!==null||data.temperatureK!==null))throw new Error('原生MD末restart不得挪用另一帧的步数、能量或温度。');
  }
  if(!native&&request.shakeHydrogenBonds===true){const shake=data.diagnostics?.shake;if(!shake||!shake.enabled||shake.algorithm!=='ASE-RATTLE'||!ordinal(shake.hydrogenBondCount)||!finite(shake.maxBondResidualAngstrom)||shake.maxBondResidualAngstrom<0||shake.maxBondResidualAngstrom>1e-6)throw new Error('已开启含氢键长约束，但缺少实际约束残差。');}
  if (!native&&request.method === 'gfnff') {
    const evidence = data.calculatorEvidence;
    if (!evidence || evidence.engine !== 'native-xtb' || evidence.method !== 'gfnff' || !evidence.version
      || typeof evidence.forceFieldTopologySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.forceFieldTopologySha256) || evidence.spinTreatment !== 'not-supported'
      || evidence.lastEvaluation?.nativeClosed !== true || !ordinal(evidence.evaluations) || evidence.evaluations < 1) throw new Error('GFN-FF采样缺少实际关闭的原生梯度和固定拓扑证据。');
  }
  const structure=routeStructure(request.structure, data.coordinates, request.frozenAtomIds ?? []);
  if(!native&&request.shakeHydrogenBonds===true){
    const pairs=(request.structure.bonds??[]).filter(bond=>request.structure.atoms[bond.a].element==='H'||request.structure.atoms[bond.b].element==='H');
    const distance=(atoms:Structure['atoms'],a:number,b:number)=>Math.hypot(atoms[a].x-atoms[b].x,atoms[a].y-atoms[b].y,atoms[a].z-atoms[b].z);
    const residual=Math.max(0,...pairs.map(bond=>Math.abs(distance(structure.atoms,bond.a,bond.b)-distance(request.structure.atoms,bond.a,bond.b))));
    if(data.diagnostics.shake!.hydrogenBondCount!==pairs.length||residual>1e-6||Math.abs(residual-data.diagnostics.shake!.maxBondResidualAngstrom!)>1e-9)throw new Error('含氢键约束回执与实际源/帧键长不一致。');
  }
  return structure;
}
export function validateSamplingCompletion(request: ConformerSamplingRequest, event: Extract<ConformerSamplingEvent, { event: 'completed' }>, frames: number, candidates: number): void {
  const native=selectConformerSamplingDriver(request).driver==='native-xtb-md',n=['md','metadynamics'].includes(request.operation)?Math.round(((request.operation==='metadynamics'?request.metadynamics:request.molecularMD)?.durationFs??50000)/(request.dtFs??2)):0;
  if (event.samplingCompleted !== true || event.optimizationPerformed !== false || event.requiresUnbiasedOptimization !== true
    || !ordinal(event.candidateCount) || event.candidateCount < 1 || event.candidateCount !== candidates || event.frameCount !== frames
    || !(native?event.driver==='native-xtb-md'&&event.evaluations===null&&event.evaluationCountSource==='not-reported-native-md'&&event.budgetEvaluationUpperBound===n+2:ordinal(event.evaluations)&&event.evaluations<=request.maxEvaluations!)
    || JSON.stringify(event.postSamplingPotentials) !== JSON.stringify({ core: false, metadynamics: false, sphere: false })
    || event.exit?.code !== 0 || event.exit.signal !== null) throw new Error('采样完成数量或后续撤势合同不匹配；候选没有被冒充优化结果。');
  validateSamplingFrame(request, event.lastFrame);
  const w=event.thermostatWarning;
  if(w){const target=request.operation==='metadynamics'?request.metadynamics?.temperatureK??300:request.molecularMD?.temperatureK??600;
    if(!native||event.nativeClosed!==true||event.step<500||w.kind!=='average-temperature-deviation'||w.message!=='thermostating problem'||w.targetTemperatureK!==target||!finite(w.averageTemperatureK)||w.averageTemperatureK<=0||w.averageTemperatureK>10000||!finite(w.relativeDeviation)||Math.abs(w.relativeDeviation)<=.02||Math.abs(w.relativeDeviation-(w.averageTemperatureK-target)/target)>1e-12)throw new Error('原生MD平均温度警告与实际目标或完成回执不一致。');
  }
}

/** Public defaults mirror desktop/aiss-security.cjs policy, not a scientific
 * convergence claim. Caller options remain explicit in the stored task/run. */
export const ADVANCED_DOCKING_DEFAULTS = Object.freeze({
  search: Object.freeze({ maxGenerations: 2, maxParents: 28, stackPoints: 32, angularStepDegrees: 90 as const, radialStepBohr: 4 }),
  refinement: Object.freeze({ candidateCount: 2, maxSteps: 50 }),
  calculator: Object.freeze({ accuracy: 1 as const, maxIterations: 250, electronicTemperatureK: 300 as const }),
});
export function dockingSettings(options: Pick<AissRequest, 'method' | 'threads' | 'search' | 'refinement' | 'calculator' | 'maxWallTimeSeconds'>) {
  const result = { ...structuredClone(options), search: { ...ADVANCED_DOCKING_DEFAULTS.search, ...options.search },
    refinement: { ...ADVANCED_DOCKING_DEFAULTS.refinement, ...options.refinement }, calculator: { ...ADVANCED_DOCKING_DEFAULTS.calculator, ...options.calculator } };
  const { search: s, refinement: r, calculator: c } = result;
  if (result.method !== 'gfn2' || !Number.isSafeInteger(result.threads) || result.threads! < 1 || result.threads! > 2
    || result.maxWallTimeSeconds !== undefined && (!finite(result.maxWallTimeSeconds) || result.maxWallTimeSeconds < .01 || result.maxWallTimeSeconds > 1800)
    || !Number.isSafeInteger(s.maxGenerations) || s.maxGenerations < 1 || s.maxGenerations > 10
    || !Number.isSafeInteger(s.maxParents) || s.maxParents < 28 || s.maxParents > 100
    || !Number.isSafeInteger(s.stackPoints) || s.stackPoints < 16 || s.stackPoints > 250
    || ![45, 60, 90, 120, 180].includes(s.angularStepDegrees) || !finite(s.radialStepBohr) || s.radialStepBohr < 1 || s.radialStepBohr > 20
    || Math.abs(s.radialStepBohr * 100 - Math.round(s.radialStepBohr * 100)) >= 1e-10
    || !Number.isSafeInteger(r.candidateCount) || r.candidateCount < 2 || r.candidateCount > Math.min(32, s.maxParents)
    || !Number.isSafeInteger(r.maxSteps) || r.maxSteps < 1 || r.maxSteps > 500
    || c.accuracy !== 1 || c.electronicTemperatureK !== 300 || !Number.isSafeInteger(c.maxIterations) || c.maxIterations < 1 || c.maxIterations > 250) throw new Error('aISS方法、线程或搜索/原生refinement预算无效，没有更换方法或无界补采。');
  return result;
}
/** The host owns namespacing. Preserve its mapping verbatim and rebuild only
 * the union of the two existing intramolecular graphs, never infer new bonds. */
export function dockingCombinedStructure(request: AissRequest, mapping: readonly AissAtomMapping[]): Structure {
  const count = request.sources.reduce((n, source) => n + source.structure.atoms.length, 0);
  if (!Array.isArray(mapping) || mapping.length !== count || new Set(mapping.map(row => row.combinedAtomId)).size !== count) throw new Error('aISS合并原子映射不完整或身份重复。');
  let offset = 0;
  const atoms: Structure['atoms'] = [], bonds: NonNullable<Structure['bonds']> = [];
  request.sources.forEach((source, sourceIndex) => {
    source.structure.atoms.forEach((atom, sourceAtomIndex) => {
      const row = mapping[offset + sourceAtomIndex];
      if (!row || typeof row.combinedAtomId !== 'string' || !row.combinedAtomId || row.sourceIndex !== sourceIndex || row.sourceAtomIndex !== sourceAtomIndex
        || row.sourceAtomId !== atom.id || row.element !== atom.element) throw new Error('aISS合并映射改变了源片段、原子顺序或元素。');
      atoms.push({ ...structuredClone(atom), id: row.combinedAtomId, sourceIndex: offset + sourceAtomIndex + 1 });
    });
    bonds.push(...(source.structure.bonds ?? []).map(bond => ({ ...structuredClone(bond), a: bond.a + offset, b: bond.b + offset })));
    offset += source.structure.atoms.length;
  });
  return { id: `${request.runIdentity.taskId}-combined`, name: request.sources.map(source => source.structure.name).join(' + '), format: 'aiss-combined', dimension: 3,
    atoms, bonds, charge: 0, multiplicity: 1, notes: [], sourceAtomIds: atoms.map(atom => atom.id!) };
}
function validateDockingResult(request: AissRequest, event: AissCompletionEvent | AissSearchCheckpointEvent): Structure {
  const settings = dockingSettings(request), backend = event.backend, n = settings.refinement.candidateCount;
  const checkpoint = event.event === 'search-checkpoint';
  if (checkpoint) {
    if (event.resultKind !== 'screened-pose-candidates' || event.disposition !== 'candidates-ready' || event.searchCheckpoint?.complete !== true
      || event.searchCheckpoint.artifact !== 'structures_after_gen.xyz' || !Number.isSafeInteger(event.searchCheckpoint.completedGenerations)
      || event.searchCheckpoint.completedGenerations < 1 || event.searchCheckpoint.completedGenerations > settings.search.maxGenerations
      || event.searchCheckpoint.completedGenerations !== backend?.counts?.geneticGenerations
      || !Number.isSafeInteger(event.exit?.code) || event.exit.code === 0 || event.exit.signal !== null
      || event.nativeRefinement?.status !== 'failed' || JSON.stringify(event.nativeRefinement.exit) !== JSON.stringify(event.exit)
      || event.nativeRefinement.error?.code !== 'AISS_NATIVE_REFINEMENT_FAILED' || !event.nativeRefinement.error.message
      || !event.artifacts?.some(file => file.name === 'structures_after_gen.xyz' && Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/.test(file.sha256))) throw new Error('aISS搜索checkpoint缺少完整阶段、文件或原生精修失败证据。');
  } else if (event.resultKind !== 'refined-pose-candidates' || event.optimizationAcceptance !== 'not-individually-verified'
    || event.exit?.code !== 0 || event.exit.signal !== null || !Array.isArray(event.refinedCandidates) || event.refinedCandidates.length !== n) throw new Error('aISS原生完整完成证据不符。');
  if (event.nativeClosed !== true || event.requiresUnbiasedOptimization !== true || event.evaluations !== null
    || JSON.stringify(event.sourceStamps) !== JSON.stringify(request.sources.map(source => source.stamp))
    || backend?.engine !== 'xtb-aiss' || !backend.version || backend.precomputeMethod !== 'gfn2' || backend.scoreMethod !== 'xTB-IFF' || backend.solvation !== 'gas'
    || backend.internalRefinement?.convergencePerPose !== 'not-reported' || backend.internalRefinement.method !== 'gfn2' || backend.internalRefinement.optLevel !== 'normal'
    || backend.internalRefinement.candidateCount !== n || backend.internalRefinement.maxSteps !== settings.refinement.maxSteps
    || !backend.search || Object.entries(settings.search).some(([key, value]) => backend.search[key as keyof typeof backend.search] !== value)
    || !backend.calculator || Object.entries(settings.calculator).some(([key, value]) => backend.calculator[key as keyof typeof backend.calculator] !== value)
    || backend.counts?.evaluations !== null || backend.counts.refinedCandidates !== (checkpoint ? 0 : n)
    || !Array.isArray(backend.monomerEnergiesHartree) || backend.monomerEnergiesHartree.length !== 2 || !backend.monomerEnergiesHartree.every(finite)
    || JSON.stringify(backend.sourceElectronicStates) !== JSON.stringify([{ charge: 0, uhf: 0 }, { charge: 0, uhf: 0 }])
    || JSON.stringify(backend.combinedElectronicState) !== JSON.stringify({ charge: 0, uhf: 0, coupling: 'sum-of-unpaired-electrons' })
    || !Array.isArray(event.screenedPoses) || event.screenedPoses.length !== n) throw new Error('aISS完成来源、实际方法、能量类型或未逐姿态收敛边界不符。');
  const combined = dockingCombinedStructure(request, event.sourceAtomMapping);
  for (const [i, pose] of event.screenedPoses.entries()) {
    if (pose.poseIndex !== i || pose.screening?.method !== 'xTB-IFF' || pose.screening.unit !== 'kcal/mol'
      || pose.screening.sourceField !== 'structures_after_gen.xyz:comment' || !finite(pose.screening.value)) throw new Error('aISS screened姿态身份或IFF评分口径无效。');
    routeStructure(combined, pose.coordinates, []);
  }
  for (const [i, candidate] of ('refinedCandidates' in event ? event.refinedCandidates : []).entries()) {
    if (candidate.candidateIndex !== i || !finite(candidate.refinementEnergyHartree) || candidate.screenedPoseId !== null || candidate.searchConverged !== null
      || candidate.requiresUnbiasedOptimization !== true) throw new Error('aISS refined候选没有逐姿态收敛或screened对应证明，不能伪造谱系。');
    routeStructure(combined, candidate.coordinates, []);
  }
  return combined;
}
export function validateDockingCompletion(request: AissRequest, event: AissCompletionEvent): Structure { return validateDockingResult(request, event); }
export function validateDockingSearchCheckpoint(request: AissRequest, event: AissSearchCheckpointEvent): Structure { return validateDockingResult(request, event); }
