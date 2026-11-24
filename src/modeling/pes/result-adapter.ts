import type { ResultConvergence, ResultFrameSummary, TrajectoryResult } from '../../results/contracts';
import { convertEnergy, type EnergyUnit } from '../../results/energy';
import { emptyScientificData, type VibrationMode } from '../../results/scientific-contracts';
import type { PesFrame, PesFrameIndex, PesPathRecord, PesRun, PesScanPoint } from './contracts';
import { structureForPesFrame } from './controller';
import {registerPreparedTrajectoryFrameIdentities} from '../../results/prepared-trajectory';
import {attachTrajectoryStages} from '../../results/trajectory-stages';
import type {TrajectoryEnergyGap} from '../../results/trajectory-energy-extension';

interface FrameSeries { id: string; rawSeriesId: string; label: string; frames: readonly PesFrame[] }
const seriesLabels: Record<string, string> = { opt:'几何优化',scan: '扫描点', ts: 'TS优化', hessian: 'Hessian几何', irc: 'IRC 路径', path: '最终路径', 's-idpp': 'S-IDPP初始路径' };
const frameGroups = new WeakMap<readonly PesFrame[], {labels:unknown;groups:FrameSeries[]}>();
const convergedScans = new WeakMap<readonly PesFrame[], readonly PesFrame[]>();

/** Unconverged/missing scan records stay on the run; only converged points
 * enter its trajectory, curve and matrix. TS formal accepted steps all remain. */
export function pesFramesForPlot(run: PesRun): readonly PesFrame[] {
  const frames=run.result?.frames??run.acceptedFrames??[];
  if(run.request.operation!=='scan')return frames;
  let projected=convergedScans.get(frames);
  if(!projected){projected=frames.filter(frame=>frame.converged===true&&!['unconverged','failed','stopped'].includes(frame.status)||frame.converged===undefined&&frame.status==='converged');convergedScans.set(frames,projected);}
  return projected;
}

export function pesScanPoints(run:PesRun):readonly PesScanPoint[] {
  if(run.result?.scanPoints)return run.result.scanPoints;
  if(run.scanPoints)return run.scanPoints;
  // Retained projects used the same point DTO under `points`.
  if(Array.isArray(run.result?.points))return run.result.points;
  return (run.result?.frames??run.acceptedFrames??[]).map(frame=>({pointIndex:frame.step,indices:Array.isArray(frame.gridIndices)?frame.gridIndices:[],targets:Array.isArray(frame.cvTargets)?frame.cvTargets:[],actual:frame.cv,status:frame.status,energyHartree:frame.energyHartree??null,frameId:frame.id}));
}

/** A failed requested point is a plot gap, never a substitute player frame.
 * Actual q is used when present; otherwise target q only locates the gap. */
export function pesScanPlotGaps(run:PesRun):TrajectoryEnergyGap[]{
  if(run.request.operation!=='scan'||!Array.isArray(run.request.parameters.axes)||run.request.parameters.axes.length!==1)return[];
  const frames=pesFramesForPlot(run),accepted=new Set(frames.map(frame=>frame.id));
  return [...pesScanPoints(run)].sort((a,b)=>a.pointIndex-b.pointIndex).flatMap(point=>{
    if(point.frameId&&accepted.has(point.frameId))return[];
    const actual=point.actual?.[0],target=point.targets[0];
    const hasActual=typeof actual==='number'&&Number.isFinite(actual),x=hasActual?actual:typeof target==='number'&&Number.isFinite(target)?target:null;
    const next=frames.findIndex(frame=>frame.step>point.pointIndex);
    return[{beforeIndex:next<0?frames.length:next,x,scanPoint:point.pointIndex+1,label:`扫描点 ${point.pointIndex+1} · ${point.status} · ${hasActual?'实际 q':'目标 q'} ${x??'缺失'}`}];
  });
}

const otherScanGroups=new WeakMap<PesFrame,FrameSeries>();
function otherScanSeries(run:PesRun):FrameSeries[]{
  if(run.request.operation!=='scan')return[];
  const accepted=new Set(pesFramesForPlot(run));
  return(run.result?.frames??run.acceptedFrames??[]).filter(frame=>!accepted.has(frame)).map(frame=>{
    let group=otherScanGroups.get(frame);if(!group){group={id:`scan-other:${frame.id}`,rawSeriesId:frame.seriesId,label:`其他扫描点 ${frame.step+1} · ${frame.status}`,frames:[frame]};otherScanGroups.set(frame,group);}return group;
  });
}

function frameSeries(run: PesRun): FrameSeries[] {
  const frames = pesFramesForPlot(run);
  if (!frames?.length) return [];
  const cached = frameGroups.get(frames);
  if (cached&&cached.labels===run.result?.series) return cached.groups;
  const series = new Map<string, FrameSeries>();
  for (const frame of frames) {
    // A path iteration is a different band, not the next molecular frame of its previous band.
    const iteration = frame.seriesId === 'path-iterations';
    const id = iteration ? `${frame.seriesId}:${frame.phase}:${frame.step}` : frame.seriesId;
    let entry = series.get(id);
    if (!entry) {
      const label = iteration ? `${frame.phase} · 第${frame.step}次迭代` : seriesLabels[id] ?? run.result?.series?.find(row => row.id === id)?.label ?? id;
      entry = { id, rawSeriesId: frame.seriesId, label, frames: [] };
      series.set(id, entry);
    }
    (entry.frames as PesFrame[]).push(frame);
  }
  const result = [...series.values()];
  frameGroups.set(frames, {labels:run.result?.series,groups:result});
  return result;
}

export function pesResultSeries(run: PesRun): { id: string; rawSeriesId: string; label: string }[] {
  return [...frameSeries(run),...otherScanSeries(run)].map(({ id, rawSeriesId, label }) => ({ id, rawSeriesId, label }));
}

export function pesSeriesForFrame(run: PesRun, frameId: string): string | undefined {
  return [...frameSeries(run),...otherScanSeries(run)].find(series => series.frames.some(frame => frame.id === frameId))?.id;
}

/** Use the values measured on accepted source frames. Missing points remain gaps. */
export function projectPesScanSurface(frames: readonly PesFrame[] | undefined, unit: EnergyUnit) {
  const points = (frames ?? []).filter(frame => frame.cv?.length === 2 && frame.cv.every(Number.isFinite) && Number.isFinite(frame.energyHartree));
  const data = { x: Float64Array.from(points, frame => frame.cv![0]), y: Float64Array.from(points, frame => frame.cv![1]) };
  const absolute = Float64Array.from(points, frame => convertEnergy({ value: frame.energyHartree!, unit: 'hartree' }, unit)!);
  let minimum = Infinity, maximum = -Infinity;
  for (const energy of absolute) { minimum = Math.min(minimum, energy); maximum = Math.max(maximum, energy); }
  const delta = Float64Array.from(absolute, energy => energy - minimum);
  return { points, data, delta, range: maximum > minimum ? { min: 0, max: maximum - minimum } : undefined };
}

/** Plot and matrix consume the identical accepted frame objects. Planned grid
 * indices locate cells; relaxed CV values are never rounded into a grid slot. */
export function projectPesScanGrid(run:PesRun,unit:EnergyUnit) {
  const surface=projectPesScanSurface(pesFramesForPlot(run),unit);
  const records=pesScanPoints(run),byFrame=new Map(records.filter(row=>row.frameId).map(row=>[row.frameId!,row]));
  const axes=Array.isArray(run.request.parameters.axes)?run.request.parameters.axes:[];
  const cells=new Map<string,{frame:PesFrame;delta:number;absolute:number}>();
  surface.points.forEach((frame,index)=>{
    const indices=Array.isArray(frame.gridIndices)?frame.gridIndices:byFrame.get(frame.id)?.indices;
    if(!indices||indices.length!==2||!indices.every((value,axis)=>Number.isSafeInteger(value)&&value>=0&&value<axes[axis]?.points))return;
    cells.set(`${indices[0]}:${indices[1]}`,{frame,delta:surface.delta[index],absolute:convertEnergy({value:frame.energyHartree!,unit:'hartree'},unit)!});
  });
  return{...surface,cells};
}

const convergenceLabels = {
  energyDifferenceHartree: ['相邻步能量差', 'Eh'],
  stationaryEnergyVerificationHartree: ['驻点复核能量差', 'Eh'],
  gradientNormHartreePerBohr: ['可动空间梯度范数', 'Eh/Bohr'],
  sellaMaxAtomForceHartreePerBohr: ['最大投影原子力', 'Eh/Bohr'],
  maxForceHartreePerBohr: ['最大力', 'Eh/Bohr'], rmsForceHartreePerBohr: ['RMS 力', 'Eh/Bohr'],
  maxAtomForceHartreePerBohr: ['最大原子力（诊断）', 'Eh/Bohr'],
  maxDisplacementBohr: ['最大位移', 'Bohr'], rmsDisplacementBohr: ['RMS 位移', 'Bohr'],
  maxAtomDisplacementBohr: ['最大原子位移（诊断）', 'Bohr'],
  sellaNativeConstraintResidualNorm: ['约束残差范数（诊断）', '原生单位'],
} as const;

function convergence(run: PesRun, frame: PesFrameIndex): ResultConvergence[] {
  const observed = frame.convergence;
  if (!observed || typeof observed !== 'object') return [];
  const metrics = observed as Record<string, unknown>;
  const returned=run.result?.provenance.convergenceThresholds as Record<string,unknown>|undefined;
  const optEnergyLimit=returned?.energyDifferenceHartree??run.request.parameters.energyDifferenceHartree;
  return Object.entries(convergenceLabels).flatMap(([key, [label, unit]]) => {
    const value = metrics[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return [];
    const nativeSella=typeof metrics.sellaMaxAtomForceHartreePerBohr==='number';
    const unified=run.request.parameters.policyVersion==='v212';
    const thresholdValue=key==='stationaryEnergyVerificationHartree'?optEnergyLimit:
      key==='energyDifferenceHartree'?(typeof metrics.stationaryEnergyVerificationHartree==='number'?null:optEnergyLimit):
      key==='gradientNormHartreePerBohr'?returned?.[key]??run.request.parameters[key]:
      key==='sellaMaxAtomForceHartreePerBohr'?(returned?.fmaxHartreePerBohr??(unified&&run.request.parameters.fmaxHartreePerBohr===undefined?null:metrics.fmaxHartreePerBohr??run.request.parameters.fmaxHartreePerBohr)):
      nativeSella&&!unified?null:run.request.parameters[key];
    const threshold = typeof thresholdValue==='number'&&Number.isFinite(thresholdValue)?thresholdValue:null;
    return [{ label, unit, value, threshold, converged: threshold === null ? null : key==='sellaMaxAtomForceHartreePerBohr'?value<threshold:value<=threshold }];
  });
}

function vibrationModes(run: PesRun, series: FrameSeries): { index: number; modes: VibrationMode[] } | undefined {
  const hessian = run.result?.hessian as { frameId?: string; atomIds?: string[]; geometryAngstrom?: number[][] } | undefined;
  const modes = run.result?.frequencies;
  if (!hessian?.frameId || !Array.isArray(modes) || !hessian.atomIds || !hessian.geometryAngstrom) return;
  const index = series.frames.findIndex(frame => frame.id === hessian.frameId);
  if (index < 0) return;
  const atoms = run.request.structure.atoms;
  if (hessian.atomIds.length !== atoms.length || atoms.some((atom, i) => atom.id !== hessian.atomIds![i])) return;
  if (series.frames[index].positions.some((xyz, i) => !xyz.every((value, axis) => hessian.geometryAngstrom?.[i]?.[axis] === value))) return;
  const projected: VibrationMode[] = [];
  for (const mode of modes) {
    if (!mode || typeof mode !== 'object' || !Number.isSafeInteger(mode.mode) || !Number.isFinite(mode.wavenumberCm1) ||
      !Array.isArray(mode.displacements) || mode.displacements.length !== atoms.length ||
      !mode.displacements.every((row: unknown) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite))) return;
    projected.push({ index: mode.mode, sourceIndex: mode.mode, frequency: mode.wavenumberCm1, sourceLine: 0, kind: 'vibration',
      atomElements: atoms.map(atom => atom.element), displacements: mode.displacements, displacementConvention: 'cartesian' });
  }
  return { index, modes: projected };
}

export interface PesTrajectoryView { result: TrajectoryResult; frameIds: string[]; seriesId: string; rawSeriesId: string;revision:string;baseRevision:string|null;incremental:boolean }
const views = new WeakMap<FrameSeries, {request:PesRun['request'];result:PesRun['result'];status:PesRun['status'];view:PesTrajectoryView;identities:readonly object[]}>();
const frameIdentities=new WeakMap<PesFrame,object>();
const requestFrames=new WeakMap<PesRun['request'],Map<string,{frame:PesFrame;identity:object}>>();
const latestViews=new WeakMap<PesRun['request'],Map<string,{view:PesTrajectoryView;identities:readonly object[]}>>();
let publication=0;
function frameIdentity(run:PesRun,frame:PesFrame):object{
  const known=frameIdentities.get(frame);if(known)return known;
  let records=requestFrames.get(run.request);if(!records){records=new Map();requestFrames.set(run.request,records);}
  const key=JSON.stringify([frame.seriesId,frame.id]),previous=records.get(key);
  const same=previous&&previous.frame.positions.length===frame.positions.length&&previous.frame.positions.every((row,index)=>row.every((value,axis)=>value===frame.positions[index][axis]));
  const identity=same?previous.identity:Object.freeze({});records.set(key,{frame,identity});frameIdentities.set(frame,identity);return identity;
}

/** Adapt a homogeneous source series once, using its native scientific order and original energy. */
export function pesTrajectory(run: PesRun, seriesId?: string): PesTrajectoryView | undefined {
  const groups = [...frameSeries(run),...otherScanSeries(run)];
  const group = (seriesId ? groups.find(row => row.id === seriesId) : groups.find(row => row.id === 'path')) ?? groups[0];
  if (!group) return;
  return adaptPesSeries(run,group);
}

/** Explicitly prepared path records share the same player and vibration
 * adapter. This function only consumes memory; it never reads an asset. */
export function pesPathTrajectory(run:PesRun,record:{id:string;seriesId:string;phase:string;step:number;kind:string},frames:readonly PesFrame[]):PesTrajectoryView|undefined {
  if(!frames.length)return;
  let groups=pathGroups.get(frames);if(!groups){groups=new Map();pathGroups.set(frames,groups);}
  let group=groups.get(record.id);const label=record.kind==='initial'?'初始路径':`${record.phase} · 第${record.step}轮`;
  if(!group||group.label!==label){group={id:record.id,rawSeriesId:record.seriesId,label,frames};groups.set(record.id,group);}
  return adaptPesSeries(run,group,true);
}
const pathGroups=new WeakMap<readonly PesFrame[],Map<string,FrameSeries>>();
const frameSummaries=new WeakMap<PesRun['request'],WeakMap<PesFrame,ResultFrameSummary>>();

function pesResultFrameSummary(run:PesRun, frame:PesFrameIndex, index:number, recordId?:string):ResultFrameSummary {
  const {operation}=run.request;
  const axes=Array.isArray(run.request.parameters.axes)?run.request.parameters.axes:[];
  return {
    index, sourceStep:frame.step, time:null, sourceLine:0, label:frame.status,
    pesOrigin:{groupId:run.request.runIdentity.groupId,nodeId:run.nodeId,taskId:run.request.runIdentity.taskId,
      runId:run.request.runIdentity.runId,
      ...(recordId?{recordId}:{}),seriesId:frame.seriesId,frameId:frame.id},
    energy:frame.energyHartree==null?null:{value:frame.energyHartree,unit:'hartree'},
    energyQuantity:'electronic',convergence:convergence(run,frame),
    ...(operation==='scan'&&axes.length===1&&frame.cv?.length===1?{
      coordinate:{value:frame.cv[0],unit:axes[0].unit,label:axes[0].name,sourceValue:frame.cv[0]},
    }:{}),
    ...(operation==='irc'&&frame.cv?.length===1?{
      coordinate:{value:frame.cv[0],unit:'Å·√amu',label:'质量加权路径距离',sourceValue:frame.cv[0]},
      pathDirection:frame.ircDirection==='origin'?'ts':frame.ircDirection==='reverse'?'reverse':'forward',
      ...(typeof frame.ircStep==='number'&&Number.isSafeInteger(frame.ircStep)&&frame.ircStep>0?{pathNode:frame.ircStep}:{}),
    }:{}),
    ...(typeof frame.bead==='number'?{sourcePathImage:frame.bead,pathImage:frame.bead}:{}),
  };
}

/** One snapshot of the record metadata, with each geometry read from its native lease. */
export function pesRecordedTrajectory(run:PesRun, record:PesPathRecord, first:PesFrame,
  read:(frameId:string,seriesId:string,signal?:AbortSignal)=>Promise<PesFrame>):TrajectoryResult {
  function matches(frame:PesFrame,index:PesFrameIndex|undefined) {
    if(!index||frame.id!==index.id||frame.seriesId!==index.seriesId)throw Error('路径几何与所选原生帧身份不符。');
    return frame;
  }
  const {structure,operation,algorithm}=run.request;
  const id=`${run.request.id}:${record.id}`,label=record.kind==='initial'?'初始路径':`${record.phase} · 第${record.step}轮`;
  const scientific=emptyScientificData();
  scientific.route=[run.request.method,algorithm,run.request.solvation?.solvent].filter(Boolean).join(' / ');
  scientific.tasks=operation==='path'?['neb']:['unknown'];
  return attachTrajectoryStages({
    id,label,kind:'trajectory',engine:'structure', role:operation==='path'?'neb-path':'unknown',
    source:{id,name:label,size:0,nativeJobName:algorithm},jobIndex:0,scientific,
    status:run.status==='completed'&&['completed','converged'].includes(run.result?.status??'')?'completed':'incomplete',
    messages:run.error?[run.error.message]:[],frames:record.frames.map((frame,index)=>pesResultFrameSummary(run,frame,index,record.id)),
    initialStructure:structureForPesFrame(structure,matches(first,record.frames[0])),
    async getFrame(index,signal) {
      signal?.throwIfAborted();
      const frame=record.frames[index];
      if(!frame)throw Error('所选路径轮没有此帧。');
      return structureForPesFrame(structure,matches(await read(frame.id,frame.seriesId,signal),frame));
    },
    dispose(){ /* The controller retains and releases the scientific record. */ },
  });
}

function adaptPesSeries(run:PesRun,group:FrameSeries,pathRecord=false):PesTrajectoryView {
  const cached = views.get(group);
  if (cached&&cached.request===run.request&&cached.result===run.result&&cached.status===run.status) return cached.view;
  const { operation, structure, id: runId, algorithm } = run.request;
  const id = `${runId}:${group.id}`;
  const status = run.status === 'completed' && ['completed','converged'].includes(run.result?.status??'') ? 'completed' : run.status === 'failed' && !group.frames.length ? 'failed' : 'incomplete';
  let summaries=frameSummaries.get(run.request);
  if(!summaries){summaries=new WeakMap();frameSummaries.set(run.request,summaries);}
  const cachedSummaries=summaries;
  const frames = group.frames.map((frame, index): ResultFrameSummary => {
    const cached=cachedSummaries.get(frame);
    const recordId=pathRecord?group.id:undefined;
    if(cached?.index===index&&cached.pesOrigin?.recordId===recordId)return cached;
    const summary=pesResultFrameSummary(run,frame,index,recordId);
    cachedSummaries.set(frame,summary);
    return summary;
  });
  const scientific = emptyScientificData();
  scientific.route = [run.request.method, algorithm, run.request.solvation?.solvent].filter(Boolean).join(' / ');
  scientific.tasks = operation === 'scan' ? ['scan'] : operation === 'path' ? ['neb'] : operation === 'hessian' ? ['freq'] : operation === 'ts' ? ['ts'] : operation==='opt'?['opt']:operation==='irc'?['irc']:['unknown'];
  const net = ['aimnet2-auto','aimnet2-rxn','orbmol-v2'].includes(run.request.method);
  const vibration = vibrationModes(run, group);
  if (vibration?.modes.length) {
    scientific.vibrations = { sourceId: id, sourceName: group.label, frameIndex: vibration.index, modes: vibration.modes,
      atomBinding: 'geometry-bound', convention: net ? 'NET 自动微分 Hessian · Cartesian' : 'xTB 数值 Hessian · Cartesian' };
    if (operation === 'ts') scientific.tasks.push('freq');
  }
  // A path round is owned by its active read lease. Never retain its frames
  // or view in the request-scoped incremental TS/scan history maps.
  const identities=pathRecord?group.frames:group.frames.map(frame=>frameIdentity(run,frame));
  let previousViews=pathRecord?undefined:latestViews.get(run.request);if(!pathRecord&&!previousViews){previousViews=new Map();latestViews.set(run.request,previousViews);}
  const previous=pathRecord?cached:previousViews?.get(group.id),incremental=!!previous&&identities.length>=previous.identities.length&&previous.identities.every((value,index)=>value===identities[index]);
  let disposed=false;
  const view: PesTrajectoryView = { frameIds: group.frames.map(frame => frame.id), seriesId: group.id, rawSeriesId: group.rawSeriesId,
    revision:`pes-publication-${++publication}`,baseRevision:incremental?previous!.view.revision:null,incremental,
    result: { id, label: group.label, kind: operation === 'ts'||operation==='opt' ? 'optimization' : 'trajectory', engine: 'structure',
      role: operation === 'scan' ? 'scan-point-set' : operation === 'path' ? 'neb-path' : operation === 'ts' ? 'ts-optimization-trajectory' : operation==='opt'?'optimization-trajectory':operation==='irc'?'irc-full':'unknown',
      source: { id, name: group.label, size: 0, software: net || operation==='opt'&&algorithm==='workspace-forcefield'?'unknown':'xtb', nativeJobName: algorithm }, jobIndex: 0, status,
      messages: run.error ? [run.error.message] : [], scientific, frames,
      initialStructure: structureForPesFrame(structure, group.frames[0]),
      async getFrame(index, signal) {
        signal?.throwIfAborted();
        if(disposed)throw Error('该显示轨迹已释放，请重新选择来源。');
        const frame = group.frames[index];
        if (!frame) throw Error('该帧已不在当前来源轨迹中。');
        return structureForPesFrame(structure, frame);
      },
      dispose() {if(disposed)return;disposed=true;if(views.get(group)?.view===view)views.delete(group);if(previousViews?.get(group.id)?.view===view)previousViews.delete(group.id);},
    } };
  views.set(group, {request:run.request,result:run.result,status:run.status,view,identities});
  // Publish the existing stage attribution on this same owner. A metadata-only
  // clone must not become a second preparation lifetime for one PES series.
  view.result.stages=attachTrajectoryStages(view.result).stages;
  registerPreparedTrajectoryFrameIdentities(view.result,identities);
  previousViews?.set(group.id,{view,identities});
  return view;
}
