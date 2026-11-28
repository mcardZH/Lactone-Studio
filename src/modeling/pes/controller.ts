import { readPesFloat64Rows } from './terminal-numeric';
import { clonePesSnapshotForPersistence, ownPesResultNumerics } from '../../projects/pes-asset-codec';
import { baseElectronicStateParameterError as baseElectronicStateError, initialBaseElectronicState, type BaseElectronicStateValues } from '../../core/base-electronic-state';
import type { BondOrderObservation, SharedModelConstraints } from '../../core/modeling/contracts';
import type { Structure } from '../../core/types';
import type { XtbResourceOverrides } from '../resource-preferences';
import { modelCoordinateKey } from '../constraints';
import { coordinatesFingerprint } from '../../core/modeling/graph';
import { samePesScanSource, scanCardDraft } from './scan-source';
import { PES_SCHEMA, PES_CALC_PROFILE, isPesNetMethod, pesCardParameterDraft, persistedPesCard, type PesOptimizationInput, type PesOptimizationUpdate, type PesBridge, type PesCard, type PesCardKind, type PesEvent, type PesFrame, type PesFrameSelection, type PesGeometry,
  type PesGroup, type PesMethodDraft, type PesParameters, type PesNode, type PesProjectSnapshot, type PesRecoveryClaim, type PesRun, type PesRunIdentity, type PesTsDraft, type PesOptimizationGeometryCommit } from './contracts';
import { defaultPesCard, defaultPesMethod, defaultPesTs, pesId } from './defaults';
import { cardSource, preparePesRequest, projectPesConstraintDefinitions, type PesWorkbenchInput } from './request';
import { createPesFfModel, pesFfModelMatches, pesSourceFfModel } from './ff-model';
import { ordinaryOptimizationPreparation, projectOrdinaryOptimizationStructure } from './ordinary-optimization-geometry';
import { lastOrdinaryOptimizationFrame, validPesFrame } from './frames';
import {PesPathRecordOwner,acquirePesPathRecord,bindPesPathRecordOwner,pesPathRecordOwner,pesPathRecords,transferPesPathRecordOwner,validPesPathRecord} from './path-records';
import type {PesPathRecord} from './contracts';
import { hasSuccessfulWorkbenchResult, PesCompositionChange, PesSubmissionChanged, pesElectronicConfirmation, pesElectronicDraft, pesElectronicSourceKey, savePesElectronicDraft } from './input-state';

const isLive = (run: PesRun) => run.status === 'starting' || run.status === 'running' || run.status === 'stopping';
const msg = (error: unknown) => error instanceof Error ? error.message : String(error);
const cardPrefix: Record<PesCardKind, string> = { scan: 'SCAN', path: 'PATH', explore: 'EXPLORE' };
const algorithmPrefix: Record<string, string> = { 'ci-neb': 'CI-NEB', 'de-gsm': 'GSM', fsm: 'FSM' };
const pathEndpointSlots = ['reactant', 'product'] as const;
const cardDraftKey = (card: PesCard) => card.kind === 'scan' ? 'sella-scan' : card.algorithm;
const pathFrameIndices = new WeakMap<PesPathRecord['frames'], ReadonlyMap<string, string>>();
const terminalFrameIndices = new WeakMap<readonly PesFrame[], ReadonlyMap<string, PesFrame>>();
const frameKey = (seriesId:string, frameId:string) => `${seriesId}\u0000${frameId}`;
const sameFrameSelection = (a:PesFrameSelection|undefined,b:PesFrameSelection) =>
  a?.runId===b.runId&&a.seriesId===b.seriesId&&a.frameId===b.frameId&&a.recordId===b.recordId;
function terminalFrame(frames:readonly PesFrame[],seriesId:string,frameId:string):PesFrame|undefined {
  let index=terminalFrameIndices.get(frames);
  if(!index){
    const firstByKey=new Map<string,PesFrame>();
    for(const frame of frames){
      const key=frameKey(frame.seriesId,frame.id);
      if(!firstByKey.has(key))firstByKey.set(key,frame);
    }
    index=firstByKey;
    terminalFrameIndices.set(frames,index);
  }
  return index.get(frameKey(seriesId,frameId));
}
interface ObservedPesFrame {
  groupId:string; nodeId:string; run:PesRun;
  anchor?:PesFrameSelection; followRunId?:string;
  selection:PesFrameSelection; frame:PesFrame; captured?:boolean;
}
type TerminalEvent = Extract<PesEvent, { event: 'terminal' }>;
type PreparedOptimizationGeometry={structure?:Structure;warning?:string;bondOrderObservation?:BondOrderObservation};
type BindOptimizationTarget = (node:PesNode) => Pick<PesGeometry,'documentId'|'revision'>;
interface TerminalPayload {
  result: TerminalEvent['result'];
  frames: Map<string, PesFrame>;
  frameIds: string[];
}
function pathRecordForFrame(run:PesRun, seriesId:string, frameId:string, recordId?:string) {
  return pesPathRecords(run).find(record=>{
    if(recordId&&record.id!==recordId)return false;
    let index=pathFrameIndices.get(record.frames);
    if(!index){
      index=new Map(record.frames.map(frame=>[frame.id,frame.seriesId]));
      pathFrameIndices.set(record.frames,index);
    }
    return index.get(frameId)===seriesId;
  });
}

export function isSuccessfulWorkbenchRun(run:PesRun|undefined):run is PesRun {
  return !!run && !run.supersededByRunId && hasSuccessfulWorkbenchResult(run);
}
/** Only the last retained successful TS/Freq result belongs to a CALC page. */
export function currentWorkbenchResult(group:PesGroup,nodeId:string):PesRun|undefined {
  const node=group.nodes.find(value=>value.id===nodeId);
  if(node?.kind==='workbench')return ownedWorkbenchResult(group, node);
}

function ownedWorkbenchResult(group: PesGroup, node: PesNode): PesRun | undefined {
  for (let index = node.runIds.length - 1; index >= 0; index--) {
    const run = group.runs[node.runIds[index]];
    if (run?.nodeId === node.id && isSuccessfulWorkbenchRun(run)) return run;
  }
}

function successfulPesResults(group: PesGroup): Map<number, string> {
  const counts = new Map<number, string>();
  const physical = (frame: Pick<PesFrame, 'energyHartree' | 'status'>) => Number.isFinite(frame.energyHartree) && frame.status !== 'partial';
  for (const node of group.nodes) {
    if (node.kind === 'workbench' || node.kind === 'initial') {
      const atomCount = ownedWorkbenchResult(group, node)?.request.structure.atoms.length;
      if (atomCount && !counts.has(atomCount)) counts.set(atomCount, node.name);
      continue;
    }
    if (node.kind !== 'result') continue;
    for (const id of node.runIds) {
      const run = group.runs[id], result = run?.result;
      if (!run || run.nodeId !== node.id || run.status !== 'completed' || run.error || run.supersededByRunId ||
        !result || !['completed', 'converged'].includes(result.status) || !['scan', 'path', 'irc'].includes(run.request.operation)) continue;
      const atomCount = run.request.structure.atoms.length;
      if (!atomCount || counts.has(atomCount)) continue;
      const inline = result.frames.some(physical);
      const compact = run.request.operation === 'path' && pesPathRecordOwner(run) &&
        pesPathRecords(run).some(record => record.kind !== 'initial' && record.frames.some(physical));
      if (inline || compact) counts.set(atomCount, node.name);
    }
  }
  return counts;
}

function runningIrc(group: PesGroup, source: PesGeometry): boolean {
  const sourceKey = JSON.stringify(source.source ?? source.documentId);
  return Object.values(group.runs).some(run => isLive(run) && run.request.operation === 'irc' &&
    JSON.stringify(run.source.source ?? run.source.documentId) === sourceKey &&
    coordinatesFingerprint(run.source.structure) === coordinatesFingerprint(source.structure));
}
export function workbenchPartialTsFrame(run:PesRun|undefined):PesFrame|undefined {
  if(!run||run.request.operation!=='ts'||run.status!=='failed'||run.result?.status!=='partial'||
    run.result.stationaryPoint!=='frequency-incomplete'||run.result.converged!==true)return;
  const frame=run.result.frames.at(-1);
  // The stationary check may confirm the last geometry without taking another step.
  const verified=run.result.stationaryVerification as {frameId?:string}|undefined;
  return frame&&(frame.converged===true||verified?.frameId===frame.id)&&
    validPesFrame(frame,run.request.structure.atoms.length)?frame:undefined;
}

export function currentWorkbenchPartialTs(group:PesGroup,nodeId:string):PesRun|undefined {
  const node=group.nodes.find(value=>value.id===nodeId);
  if(node?.kind!=='workbench')return;
  for(const id of [...node.runIds].reverse()){
    const run=group.runs[id];
    if(!run)continue;
    if(run.supersededByRunId||
      (run.request.operation==='opt'&&!!run.result?.finalStructure&&(node.geometry.source?.runId===id||
        run.status==='completed'&&['completed','converged'].includes(run.result.status)))||isSuccessfulWorkbenchRun(run))return;
    if(workbenchPartialTsFrame(run))return run;
  }
}

/** A partial TS is an observation source. The successful result keeps its ownership. */
export function editableNodeDisplayRun(group:PesGroup,nodeId:string):PesRun|undefined {
  const node=group.nodes.find(value=>value.id===nodeId);
  const success=currentWorkbenchResult(group,nodeId),active=editableNodeActiveRun(group,nodeId);
  const selected=node?.selection?group.runs[node.selection.runId]:undefined;
  if(!active&&selected?.nodeId===nodeId&&selected.request.operation==='opt'&&selected.retainTrajectory&&selected.result?.frames.length)return selected;
  const partial=currentWorkbenchPartialTs(group,nodeId);
  if(partial&&node?.selection?.runId===partial.request.id)return partial;
  return success??active??partial;
}

export function editableNodeActiveRun(group:PesGroup,nodeId:string):PesRun|undefined {
  const node=group.nodes.find(value=>value.id===nodeId);
  if(!node||node.kind!=='initial'&&node.kind!=='workbench')return;
  return [...node.runIds].reverse().map(id=>group.runs[id]).find(run=>run&&isLive(run));
}
function retireWorkbenchResults(group:PesGroup,node:PesNode,replacement:string,runs:Record<string,PesRun>,keepEvidence=false):Record<string,PesRun> {
  const next={...runs};
  for(const id of node.runIds){
    const old=next[id];if(id===replacement||!isSuccessfulWorkbenchRun(old))continue;
    next[id]={...old,supersededByRunId:replacement};
    if(keepEvidence)continue;
    next[id].result={frames:[],status:'superseded',provenance:old.result!.provenance};
    delete next[id].pathRecords;delete next[id].scanPoints;
  }
  return next;
}
function optimizationFinalGeometry(run:PesRun,frame:PesFrame):PesGeometry {
  const candidate=run.result?.finalStructure as Structure|undefined;
  if(candidate){
    if(candidate.atoms.length!==run.request.structure.atoms.length||candidate.atoms.some((atom,index)=>
      atom.id!==run.request.structure.atoms[index].id||atom.element!==run.request.structure.atoms[index].element||
      [atom.x,atom.y,atom.z].some((value,axis)=>value!==frame.positions[index][axis])))throw Error('优化最终结构与已核验末帧不一致。');
  }
  return {...run.source,structure:structuredClone(candidate??projectOrdinaryOptimizationStructure(run.request,frame)),
    source:{groupId:run.request.runIdentity.groupId,nodeId:run.nodeId,runId:run.request.id,seriesId:frame.seriesId,frameId:frame.id},
    ...(run.request.ffModel?{ffModel:structuredClone(run.request.ffModel)}:{})};
}

/** The single active path card owns the group's memory-only endpoint pair.
 * Method drafts keep parameters only; changing path method transfers these
 * exact selections, without transferring method-specific key structures. */
function inheritPathEndpoints(previous: PesCard, next: PesCard): PesCard {
  const slots = { ...next.slots }, mappings = { ...next.mappings };
  for (const slot of pathEndpointSlots) {
    delete slots[slot];
    delete mappings[slot];
    if (previous.slots[slot]) slots[slot] = previous.slots[slot];
    if (previous.mappings?.[slot]) mappings[slot] = previous.mappings[slot];
  }
  const endpoint = (slot: string) => pathEndpointSlots.some(key => key === slot);
  return { ...next, slots, mappings, requiredSlots: [...new Set([
    ...(next.requiredSlots ?? []).filter(slot => !endpoint(slot)),
    ...(previous.requiredSlots ?? []).filter(endpoint),
  ])] };
}

function nextName(prefix: string, existing: readonly { name: string }[], padded: boolean) {
  let index = 1;
  const used = new Set(existing.map(value => value.name));
  const candidate = () => `${prefix}${padded ? `_${String(index).padStart(3, '0')}` : index}`;
  while (used.has(candidate())) index += 1;
  return candidate();
}
function nextCalcName(group:PesGroup):string {
  const highest=Math.max(group.calcSequence??0,...group.nodes.map(node=>Number(/^CALC_(\d+)$/.exec(node.name)?.[1]??0)));
  return `CALC_${String(highest+1).padStart(3,'0')}`;
}

export function structureForPesFrame(template: Structure, frame: PesFrame): Structure {
  // The solver returns coordinates in input atom order. The source connection
  // graph and source-job geometry stay on the immutable request and source.
  const { bonds: _bonds, bondSource: _bondSource, bondPerceptionIssues: _bondIssues, molfile: _molfile, preparation: _preparation,
    gaussianSource: _gaussianSource, gaussianSources: _gaussianSources, orcaSource: _orcaSource, sourceRoute: _sourceRoute, layout2D: _layout2D,
    ...structure } = template;
  return { ...structure, atoms: template.atoms.map(({ stereoParity: _stereoParity, aromaticHydrogen: _aromaticHydrogen, ...atom }, index) => {
    const [x, y, z] = frame.positions[index];
    return { ...atom, x, y, z };
  }) };
}

/** Keep a physical peak within one series. Missing neighboring energies do not imply an extremum. */
export function selectInitialPesFrame<T extends Pick<PesFrame,'id'|'seriesId'|'energyHartree'>>(frames: readonly T[], operation: PesRun['request']['operation']): T | undefined {
  if (operation !== 'scan' && operation !== 'path') return frames.at(-1);
  const finalPath = operation === 'path' ? frames.filter(frame => frame.seriesId === 'path') : [];
  if (finalPath.length) frames = finalPath;
  let peak: T | undefined;
  for (let index = 1; index < frames.length - 1; index++) {
    const [before, current, after] = [frames[index - 1], frames[index], frames[index + 1]];
    if (before.seriesId !== current.seriesId || after.seriesId !== current.seriesId) continue;
    if (before.energyHartree == null || current.energyHartree == null || after.energyHartree == null) continue;
    if (current.energyHartree > before.energyHartree && current.energyHartree > after.energyHartree &&
      (peak?.energyHartree == null || peak.energyHartree < current.energyHartree)) peak = current;
  }
  return peak ?? frames.at(-1);
}

type XtbSolvation = { model: 'alpb'; solvent: string };
const solvationDraft = (solvation?: XtbSolvation) => ({ solvationModel: solvation?.model ?? 'none' as const, solvent: solvation?.solvent ?? '' });

function staticSnapshot(snapshot: PesProjectSnapshot, defaultSolvation?: XtbSolvation, shareProjectNumbers = false, projectLevel?: PesMethodDraft): PesProjectSnapshot {
  if (snapshot.schema !== PES_SCHEMA) throw Error('不支持此势能面项目数据版本。');
  const copy = shareProjectNumbers ? clonePesSnapshotForPersistence(snapshot) : structuredClone(snapshot);
  for (const group of copy.groups) {
    if (projectLevel) group.sharedMethod = projectLevel;
    else group.sharedMethod ??= { ...defaultPesMethod(), ...solvationDraft(defaultSolvation) };
    if (!Array.isArray(group.initialElementSequence) || !group.initialElementSequence.every(element => typeof element === 'string'))
      group.initialElementSequence = group.nodes.find(node => node.id === group.initialNodeId)?.geometry.structure.atoms.map(atom => atom.element);
    if (group.lifecycleVersion === 'v223') {
      group.cards = group.cards.map(card => persistedPesCard(group.id, card));
      if (group.cardDrafts) group.cardDrafts = Object.fromEntries(Object.entries(group.cardDrafts).map(([key,card]) => [key,pesCardParameterDraft(card)]));
    }
    for (const node of group.nodes) delete node.followRunId;
    for (const [runId,run] of Object.entries(group.runs)) {
      const original=snapshot.groups.find(value=>value.id===group.id)?.runs[runId];if(original)transferPesPathRecordOwner(original,run);
      if (isLive(run)) {
        run.status = 'interrupted';
        if (run.acceptedFrames?.length) run.result = { status: 'interrupted', provenance: {}, frames: [...run.acceptedFrames] };
      }
      delete run.progress;
      delete run.preview;
      delete run.acceptedFrames;
      run.lastSeq = -1;
    }
    for(const node of group.nodes){
      if(node.kind!=='initial'&&node.kind!=='workbench')continue;
      for(const id of node.runIds){
        const run=group.runs[id];if(run?.request.operation!=='opt'||run.retainTrajectory)continue;
        const last=run.result?.frames.at(-1);
        if(last&&validPesFrame(last,run.request.structure.atoms.length))try{
          const geometry=optimizationFinalGeometry(run,last);
          if(node.selection?.runId===id&&run.status==='completed'&&!run.error&&['completed','converged'].includes(run.result?.status??'')&&last.converged!==false)node.geometry=geometry;
          if(run.result){const {positions:_positions,...finalObservation}=last;run.result={...run.result,frames:[],finalStructure:geometry.structure,finalObservation};}
        }catch{/* A malformed historic final geometry remains diagnostic. */}
        if(run.result)run.result={...run.result,frames:[]};
        if(node.selection?.runId===id)delete node.selection;
      }
      const last=currentWorkbenchResult(group,node.id);
      if(last){const hessian=last.result!.hessian as {frameId:string};if(last.request.operation==='hessian')last.result={...last.result!,frames:last.result!.frames.filter(frame=>frame.id===hessian.frameId)};group.runs=retireWorkbenchResults(group,node,last.request.id,group.runs);
        if(node.selection&&node.selection.runId!==last.request.id&&group.runs[node.selection.runId]?.supersededByRunId){const frame=last.result!.frames.find(frame=>frame.id===hessian.frameId)!;node.selection={runId:last.request.id,seriesId:frame.seriesId,frameId:frame.id};}}
    }
  }
  return copy;
}

/** Application owner for all groups. Views may disappear without disposing a run. */
export class PesController {
  private state: PesProjectSnapshot;
  private listeners = new Set<() => void>();
  private persistentListeners = new Set<(kind:'content'|'cursor') => void>();
  private bridgeUnsubscribe?: () => void;
  private notificationFrame?: number;
  private nativePathSources=new Map<PesPathRecordOwner,PesRunIdentity>();
  private recoveryPathClaims=new WeakMap<PesPathRecordOwner,string>();
  private recoveryEpoch=0;
  private pathReleases=new Set<Promise<void>>();
  private terminalReads = new Map<PesRun['request'], AbortController>();
  private terminalAccepted = new Map<PesRun['request'], { identity: PesRunIdentity; assets: string[] }>();
  private optimizationStops=new Map<string,()=>Promise<void>>();
  private optimizationPreparation=new Map<string,AbortController>();
  private optimizationFrames=new Map<string,PesFrame>();
  private followedFrames=new Map<string,PesFrameSelection>();
  private observedFrames=new Map<string,ObservedPesFrame>();
  private liveFrameIndices=new WeakMap<PesRun['request'],Map<string,number>>();

  constructor(private readonly bridge?: PesBridge, snapshot?: PesProjectSnapshot,
    private readonly options: { canFollowWorkbench?(groupId: string, nodeId: string, runId: string): boolean;
      submittingDocument?(): string;onPathSourceReleaseError?(message:string):void;
      confirmLiveElectronicState?(groupId:string,geometry:PesGeometry,values:BaseElectronicStateValues):void;
      assertLiveElectronicSource?(groupId:string,geometry:PesGeometry):void;
      prepareOptimizationGeometry?(geometry:PesGeometry,frame:PesFrame,request:PesRun['request'],signal:AbortSignal):Promise<Structure>;
      prepareOptimizationBonds?(geometry:PesGeometry,frame:PesFrame,request:PesRun['request'],signal:AbortSignal,result:NonNullable<PesRun['result']>):Promise<PreparedOptimizationGeometry>;
      onOptimizationGeometry?(commit:PesOptimizationGeometryCommit):void|false|Pick<PesGeometry,'revision'|'structure'>;
      defaultXtbSolvation?(): XtbSolvation | undefined;
      projectCalculationLevel?: { read(): PesMethodDraft; update(patch: Partial<PesMethodDraft>): void };
    } = {}) {
    this.state = snapshot ? staticSnapshot(snapshot, options.defaultXtbSolvation?.(), false, options.projectCalculationLevel?.read()) : { schema: PES_SCHEMA, groups: [] };
    this.bridgeUnsubscribe = bridge?.onPesEvent(event => this.accept(event));
  }

  get available(): boolean { return !!this.bridge; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribePersistence = (listener: (kind:'content'|'cursor') => void) => { this.persistentListeners.add(listener); return () => { this.persistentListeners.delete(listener); }; };

  exportSnapshot(options?:{shareProjectNumbers?:boolean;trackCursorChanges?:boolean}): PesProjectSnapshot {
    if(!this.followedFrames.size&&!this.observedFrames.size)return staticSnapshot(this.state,undefined,options?.shareProjectNumbers);
    const groups=this.state.groups.map(group=>({...group,nodes:group.nodes.map(node=>{
      const observed=this.currentObservedFrame(group,node);
      if(observed){
        if(options?.trackCursorChanges)observed.captured=true;
        return this.applyObservedFrame(node,observed);
      }
      const selection=node.followRunId?this.followedFrames.get(node.followRunId):undefined;
      return selection?{...node,selection}:node;
    })}));
    return staticSnapshot({...this.state,groups},undefined,options?.shareProjectNumbers);
  }

  importSnapshot(snapshot: PesProjectSnapshot, options?:{shareProjectNumbers?:boolean}): void {
    if (this.state.groups.some(group => Object.values(group.runs).some(isLive))) throw Error('请等待势能面计算结束后再恢复项目。');
    const restored=staticSnapshot(snapshot, this.options.defaultXtbSolvation?.(),options?.shareProjectNumbers,this.options.projectCalculationLevel?.read());
    this.recoveryEpoch++;
    this.observedFrames.clear();
    this.publish(restored);
  }

  async recoverCompletedRun(claim: PesRecoveryClaim, guard?: () => void): Promise<{groupId:string;nodeId:string}> {
    const { request, terminal } = claim, { groupId, runId, taskId } = request.runIdentity;
    if (request.schema !== PES_SCHEMA || request.id !== runId || request.operation === 'opt' ||
        terminal.schema !== PES_SCHEMA || terminal.event !== 'terminal' || terminal.workerSettled !== true ||
        terminal.status !== 'completed' || terminal.runIdentity.groupId !== groupId ||
        terminal.runIdentity.runId !== runId || terminal.runIdentity.taskId !== taskId || !terminal.result)
      throw Error('PES 恢复记录与已完成的计算不符。');
    const epoch = this.recoveryEpoch;
    const current = () => {
      guard?.();
      if (this.recoveryEpoch !== epoch) throw new DOMException('恢复的势能面项目已改变。', 'AbortError');
      const group = this.state.groups.find(item => item.id === groupId);
      const previous = group && Object.hasOwn(group.runs, runId) ? group.runs[runId] : undefined;
      if (previous && (previous.status !== 'interrupted' || previous.request.sourceDocumentId !== request.sourceDocumentId ||
          previous.request.runIdentity.taskId !== taskId || previous.request.operation !== request.operation ||
          previous.request.method !== request.method || previous.request.algorithm !== request.algorithm))
        throw Error('该计算来源已在当前项目中使用。');
      return { group, previous };
    };
    current();
    const frameIds = terminal.resultFrameIds ?? terminal.result.frames.map(frame => frame.id);
    const payload: TerminalPayload = { result: terminal.result,
      frames: new Map(terminal.result.frames.map(frame => [frame.id, frame])), frameIds };
    let error = terminal.error;
    try {
      await this.readTerminalPayload(terminal, request, payload, current);
    } catch (cause) {
      current();
      const warning = 'PES 恢复资料读取受限，已保留可核验的结果：' + msg(cause);
      error = { message: warning, detail: terminal.error?.message };
      payload.result = { ...payload.result!, frames: frameIds.flatMap(id => {
        const frame = payload.frames.get(id);
        return frame && validPesFrame(frame, request.structure.atoms.length) ? [frame] : [];
      }), provenance: { ...terminal.result.provenance, terminalFrameAdoption: 'incomplete', terminalFrameAdoptionWarning: warning } };
    }
    const result = payload.result!;
    const records = (result.pathRecords ?? []).filter(validPesPathRecord);
    const preferredRecord = records.find(record => record.id === result.lastPathRecordId);
    const candidates = records.filter(record=>record!==preferredRecord).reverse();
    if(preferredRecord)candidates.unshift(preferredRecord);
    let lastRecord: PesPathRecord | undefined;
    if(candidates.length && !this.bridge?.readPesPathRecord) throw Error('当前环境无法读取恢复路径的原始帧。');
    for (const record of candidates) {
      try {
        const frames = await this.bridge!.readPesPathRecord!({ runIdentity: request.runIdentity, recordId: record.id });
        current();
        if (frames.length !== record.frames.length || frames.some((frame, index) =>
          frame.id !== record.frames[index].id || !validPesFrame(frame, request.structure.atoms.length)))
          throw Error('PES 恢复路径的坐标与帧记录不符。');
        lastRecord = record;
        break;
      } catch (cause) {
        current();
        error ??= {message:'部分恢复路径轮读取受限，原文件已保留。',detail:msg(cause)};
      }
    }
    if (!result.frames.length && !lastRecord)
      throw Error('PES 恢复记录中没有可读取的结果，原文件已保留。');
    ownPesResultNumerics(result);

    const { group, previous } = current();
    const source: PesGeometry = previous?.source ?? { documentId: request.sourceDocumentId, revision: 0, structure: request.structure };
    const owner = group ?? this.newGroup(source, groupId, { constraints: {
      frozenAtomIds: request.constraints.frozenAtomIds,
      coordinates: request.constraints.coordinates.map(coordinate => ({ ...coordinate, action:'freeze', steps:1, increment:null })),
    } });
    const previousNode = previous && owner.nodes.find(node => node.id === previous.nodeId);
    const nodeId = previousNode?.id ?? pesId('recovered');
    const selected = lastRecord ? selectInitialPesFrame(lastRecord.frames,request.operation) : selectInitialPesFrame(result.frames,request.operation);
    const selection = selected && { runId, frameId: selected.id, seriesId: selected.seriesId,
      ...(lastRecord ? { recordId: lastRecord.id } : {}) };
    const run: PesRun = { ...previous, request, source, nodeId, status: 'completed', workerSettled: true,
      lastSeq: terminal.seq, result, error, ...(records.length ? { pathRecords: records } : {}),
      ...(result.scanPoints ? { scanPoints: result.scanPoints } : {}) };
    if (records.length) {
      this.bindPathSource(run,run);
      const pathOwner = pesPathRecordOwner(run);
      if (pathOwner) this.recoveryPathClaims.set(pathOwner,claim.id);
    }
    const node: PesNode = previousNode ? { ...previousNode, selection: previousNode.selection ?? selection } :
      { id:nodeId, name:`${algorithmPrefix[request.algorithm] ?? request.operation.toUpperCase()} · 恢复`,
        kind:'result', geometry:source, runIds:[runId], selection };
    const updated = { ...owner, activeNodeId:nodeId, runs:{...owner.runs,[runId]:run},
      nodes: previousNode ? owner.nodes.map(item=>item.id===nodeId?node:item) : [...owner.nodes,node] };
    this.publish({ ...this.state, groups:group ? this.state.groups.map(item=>item===group?updated:item) : [...this.state.groups,updated] });
    if (!records.length) await this.bridge?.closePesRecovery?.(claim.id).catch(cause=>{
      this.options.onPathSourceReleaseError?.('PES 恢复读取资源尚未释放：'+msg(cause));
    });
    return { groupId, nodeId };
  }

  dispose(): void {
    this.recoveryEpoch++;
    this.bridgeUnsubscribe?.();
    this.bridgeUnsubscribe = undefined;
    this.cancelNotificationFrame();
    this.followedFrames.clear();
    this.observedFrames.clear();
    this.listeners.clear();
    this.persistentListeners.clear();
    this.optimizationFrames.clear();this.optimizationStops.clear();
    for (const work of this.optimizationPreparation.values()) work.abort();
    this.optimizationPreparation.clear();
    for (const work of this.terminalReads.values()) work.abort();
    this.terminalReads.clear();
    this.terminalAccepted.clear();
    for(const group of this.state.groups)for(const run of Object.values(group.runs))pesPathRecordOwner(run)?.dispose();
    for(const [owner,identity]of this.nativePathSources)this.retirePathSource(owner,identity);
    this.state = { schema:PES_SCHEMA, groups:[] };
  }
  async settlePathSourceReleases(){await Promise.all([...this.pathReleases]);}

  createGroup(initial: PesGeometry, groupId = pesId('pes'), options?: { constraints?: SharedModelConstraints; initialName?: string; electronicConfirmed?: boolean }): PesGroup {
    if (this.state.groups.some(group => group.id === groupId)) throw Error('该势能面组已存在。');
    const group = this.newGroup(initial, groupId, options);
    this.publish({ ...this.state, groups: [...this.state.groups, group] });
    return group;
  }

  private newGroup(initial: PesGeometry, groupId: string, options?: { constraints?: SharedModelConstraints; initialName?: string; electronicConfirmed?: boolean }): PesGroup {
    const id = pesId('initial');
    const values = initialBaseElectronicState(initial.structure);
    const node: PesNode = { id, name: options?.initialName ?? 'initial', kind: 'initial', geometry: structuredClone(initial), runIds: [] };
    const group:PesGroup={ lifecycleVersion:'v223', id: groupId, name: nextName('pes', this.state.groups, true), initialNodeId: id, activeNodeId: id,
      initialElementSequence: initial.structure.atoms.map(atom => atom.element),
      sharedMethod: this.defaultCalculationLevel(),
      nodes: [node], cards: [], runs: {}, electronic: { charge: String(values.charge), multiplicity: String(values.multiplicity) },
      constraints: options?.constraints ? structuredClone(options.constraints) : { frozenAtomIds: [], coordinates: [], enabled: true }, ts: defaultPesTs() };
    if(options?.electronicConfirmed && initial.structure.charge===values.charge && initial.structure.multiplicity===values.multiplicity &&
      !baseElectronicStateError(initial.structure,values)) {
      group.electronic=savePesElectronicDraft(group.electronic,pesElectronicSourceKey(group,initial),group.electronic,values);
    }
    return group;
  }

  renameGroup(groupId: string, name: string) { if (name.trim()) this.edit(groupId, group => ({ ...group, name: name.trim() })); }

  renameNode(groupId: string, nodeId: string, name: string) {
    if (name.trim()) this.editNode(groupId, nodeId, node => ({ ...node, name: name.trim() }));
  }

  setActiveNode(groupId: string, nodeId: string) {
    this.edit(groupId, group => group.activeNodeId === nodeId || !group.nodes.some(node => node.id === nodeId) ? group : { ...group, activeNodeId: nodeId });
  }

  async removeGroup(groupId: string): Promise<void> {
    const group = this.group(groupId);
    await this.settleRuns(groupId, Object.values(group.runs).filter(isLive));
    const current = this.group(groupId);
    if (Object.values(current.runs).some(isLive)) throw Error('该组仍有活动计算。');
    this.publish({ ...this.state, groups: this.state.groups.filter(item => item.id !== groupId) });
    await this.settlePathSourceReleases();
  }

  async removeNode(groupId: string, nodeId: string): Promise<void> {
    const group = this.group(groupId);
    if (nodeId === group.initialNodeId) throw Error('初始结构随势能面组管理。');
    await this.settleRuns(groupId, Object.values(group.runs).filter(run => run.nodeId === nodeId && isLive(run)));
    this.edit(groupId, current => {
      if (Object.values(current.runs).some(run => run.nodeId === nodeId && isLive(run))) throw Error('该标签仍有活动计算。');
      const runs = Object.fromEntries(Object.entries(current.runs).filter(([, run]) => run.nodeId !== nodeId));
      return { ...current, runs, nodes: current.nodes.filter(node => node.id !== nodeId),
        cards: current.cards.map(card => ({ ...card, runIds: card.runIds.filter(id => id in runs) })),
        activeNodeId: current.activeNodeId === nodeId ? current.initialNodeId : current.activeNodeId };
    });
    await this.settlePathSourceReleases();
  }

  private readonly pathProjections = new WeakMap<Structure,{frame:PesFrame;structure:Structure}>();

  private pathStructure(template:Structure,frame:PesFrame):Structure {
    const previous=this.pathProjections.get(template);
    if(previous?.frame===frame)return previous.structure;
    const structure=structureForPesFrame(template,frame);
    this.pathProjections.set(template,{frame,structure});
    return structure;
  }

  nodeGeometry(groupId: string, nodeId: string): PesGeometry | undefined {
    const group = this.group(groupId);
    const node = group.nodes.find(item => item.id === nodeId);
    if (!node) return;
    // Stored geometry retains its origin. A selectable geometry identifies this node.
    const source = { groupId, nodeId };
    const active = editableNodeActiveRun(group,nodeId);
    const optimization = active?.request.operation==='opt'?active:undefined;
    const observed=optimization?undefined:this.currentObservedFrame(group,node);
    const selection = optimization?undefined:observed?.selection??node.selection;
    const displayed=selection||node.followRunId?undefined:editableNodeDisplayRun(group,nodeId);
    const candidate = optimization??group.runs[selection?.runId ?? node.followRunId ?? '']??displayed;
    const run = candidate?.nodeId === nodeId ? candidate : undefined;
    const record=run&&selection?pathRecordForFrame(run,selection.seriesId,selection.frameId,selection.recordId):undefined;
    const frame = selection ? observed?.frame??(run?.result?.frames ?? run?.acceptedFrames)?.find(item => item.id === selection.frameId && item.seriesId === selection.seriesId)??(run&&record?pesPathRecordOwner(run)?.frame(record.id,selection.frameId):undefined) : run?.preview??workbenchPartialTsFrame(run);
    if (run && (frame||isLive(run)&&run.request.operation==='opt')) return { ...node.geometry, label: node.name,
      structure:run.request.operation==='opt'?projectOrdinaryOptimizationStructure(run.request,frame):record?this.pathStructure(run.request.structure,frame!):structureForPesFrame(run.request.structure,frame!),
      ffModel: pesSourceFfModel(group, { ...run.source, source: { runId: run.request.id } }),
      source: { ...source, runId: run.request.id, ...(frame?{seriesId:frame.seriesId,frameId:frame.id}:{}),...(record?{recordId:record.id}:{}) } };
    if(selection&&record)return;
    if (run && isLive(run) && node.followRunId === run.request.id) return { ...run.source, label: node.name,
      ffModel: pesSourceFfModel(group, { ...run.source, source: { runId: run.request.id } }), source: { ...source, runId: run.request.id } };
    return { ...node.geometry, ...(node.kind==='initial'||node.kind==='workbench'?{inputSnapshotId:undefined}:{}), label: node.name, source };
  }

  currentScanGeometry(groupId: string, readDisplayed?: () => PesGeometry | undefined): PesGeometry | undefined {
    const group = this.group(groupId);
    if (readDisplayed) {
      const source = readDisplayed();
      const identity = source?.source;
      if (identity?.groupId === groupId && group.nodes.some(node => node.id === identity.nodeId)) return source;
      return;
    }
    const node = group.nodes.find(row => row.id === group.activeNodeId);
    if (!node) return;
    const source = this.nodeGeometry(groupId, node.id);
    if (node.kind === 'result' && !source?.source?.frameId) return;
    return source;
  }

  updateNodeGeometry(groupId: string, nodeId: string, geometry: PesGeometry, options?: { removedAtomIds?: readonly string[]; electronicChanged?:boolean; electronicConfirmed?:boolean; geometryChanged?:boolean }) {
    this.edit(groupId, group => {
      const node = group.nodes.find(item => item.id === nodeId);
      if (!node || (node.kind !== 'initial' && node.kind !== 'workbench')) return group;
      if (!options?.electronicChanged && node.geometry.documentId === geometry.documentId && node.geometry.revision === geometry.revision &&
        node.geometry.structure.charge===geometry.structure.charge && node.geometry.structure.multiplicity===geometry.structure.multiplicity) return group;
      const removed = new Set(nodeId===group.initialNodeId?options?.removedAtomIds??[]:[]);
      const constraints=removed.size?{...group.constraints,coordinates:group.constraints.coordinates.filter(row=>!row.atomIds.some(id=>removed.has(id))),
        frozenAtomIds:group.constraints.frozenAtomIds.filter(id=>!removed.has(id))}:group.constraints;
      const updated={...node,geometry:structuredClone({...geometry,ffModel:geometry.ffModel??node.geometry.ffModel}),
        ...(options?.geometryChanged===false?{}:{selection:undefined,followRunId:undefined})};
      const next={...group,constraints,nodes:group.nodes.map(item=>item.id===nodeId?updated:item)};
      if(options?.electronicChanged) {
        const values=initialBaseElectronicState(geometry.structure);
        const draft={charge:String(values.charge),multiplicity:String(values.multiplicity)};
        const key=pesElectronicSourceKey(next,{...geometry,inputSnapshotId:undefined,source:{groupId,nodeId}});
        const confirmed=options.electronicConfirmed && geometry.structure.charge===values.charge &&
          geometry.structure.multiplicity===values.multiplicity && !baseElectronicStateError(geometry.structure,values) ? values : undefined;
        next.electronic=savePesElectronicDraft(group.electronic,key,draft,confirmed);
      }
      return next;
    });
  }

  clearFrameSelection(groupId: string, nodeId: string) {
    this.observedFrames.delete(JSON.stringify([groupId,nodeId]));
    this.editNode(groupId, nodeId, node => node.selection || node.followRunId ? { ...node, selection: undefined, followRunId: undefined } : node);
  }

  private currentObservedFrame(group:PesGroup,node:PesNode):ObservedPesFrame|undefined {
    const pending=this.observedFrames.get(JSON.stringify([group.id,node.id]));
    if(pending&&pending.anchor===node.selection&&pending.followRunId===node.followRunId&&group.runs[pending.selection.runId]===pending.run)return pending;
  }

  getFrameSelection(groupId:string,nodeId:string):PesFrameSelection|undefined {
    const group=this.state.groups.find(group=>group.id===groupId),node=group?.nodes.find(node=>node.id===nodeId);
    return group&&node?this.currentObservedFrame(group,node)?.selection??node.selection:undefined;
  }

  /** The fixed player already owns frame presentation. Cursor progress stays
   * readable by scientific consumers and snapshots without publishing a group edit. */
  observePlaybackFrame(groupId:string,nodeId:string,runId:string,seriesId:string,frameId:string,recordId?:string):void {
    const group=this.state.groups.find(group=>group.id===groupId),node=group?.nodes.find(node=>node.id===nodeId),run=group?.runs[runId];
    if(!group||!node||run?.nodeId!==nodeId||!run.result||isLive(run)||(node.selection?.runId??node.followRunId)!==runId)return;
    const selection:PesFrameSelection={runId,seriesId,frameId,...(recordId?{recordId}:{})};
    const previous=this.currentObservedFrame(group,node);
    if(sameFrameSelection(previous?.selection??node.selection,selection))return;
    const record=recordId?pathRecordForFrame(run,seriesId,frameId,recordId):undefined;
    const frame=recordId?record&&pesPathRecordOwner(run)?.frame(record.id,frameId):terminalFrame(run.result.frames,seriesId,frameId);
    if(!frame)return;
    this.observedFrames.set(JSON.stringify([groupId,nodeId]),{groupId,nodeId,run,anchor:node.selection,followRunId:node.followRunId,selection,frame});
    // Notify the first change after a project capture as well, so an in-flight
    // save cannot mark later playback progress as already written.
    if(!previous||previous.captured)this.persistentListeners.forEach(listener=>listener('cursor'));
  }

  private applyObservedFrame(node:PesNode,observed:ObservedPesFrame):PesNode {
    return {...node,selection:observed.selection,followRunId:undefined,
      geometry:observed.selection.recordId?{...node.geometry,structure:this.pathStructure(observed.run.request.structure,observed.frame)}:node.geometry};
  }

  settlePlaybackFrame(groupId:string,nodeId:string,runId:string,seriesId:string,recordId?:string):void {
    const group=this.state.groups.find(group=>group.id===groupId),node=group?.nodes.find(node=>node.id===nodeId);
    const pending=group&&node?this.currentObservedFrame(group,node):undefined;
    if(!pending||pending.selection.runId!==runId||pending.selection.seriesId!==seriesId||pending.selection.recordId!==recordId)return;
    this.observedFrames.delete(JSON.stringify([groupId,nodeId]));
    this.editNode(groupId,nodeId,node=>this.applyObservedFrame(node,pending),'cursor');
  }

  selectFrame(groupId: string, nodeId: string, runId: string, seriesId: string, frameId: string,recordId?:string,followingDisplay=false) {
    const group = this.group(groupId), run = group.runs[runId];
    if(run?.nodeId!==nodeId)return;
    const preview=run.preview?.id===frameId&&run.preview.seriesId===seriesId?run.preview:undefined;
    const follows=isLive(run)&&(Boolean(preview)||followingDisplay&&!recordId);
    const current = group.nodes.find(node=>node.id===nodeId);
    if(!current)return;
    const selection = current.selection;
    const observed=this.currentObservedFrame(group,current);
    const proposed:PesFrameSelection={runId,seriesId,frameId,...(recordId?{recordId}:{})};
    if(observed&&sameFrameSelection(observed.selection,proposed)){
      this.settlePlaybackFrame(groupId,nodeId,runId,seriesId,recordId);
      return;
    }
    if(!follows&&!observed&&sameFrameSelection(selection,proposed))return;
    const record=pathRecordForFrame(run,seriesId,frameId,recordId);
    const inline=run.result?.frames??run.acceptedFrames;
    const index=isLive(run)?this.liveFrameIndices.get(run.request)?.get(frameKey(seriesId,frameId)):undefined;
    const inlineFrame=run.result?terminalFrame(run.result.frames,seriesId,frameId):
      index===undefined?inline?.find(frame=>frame.id===frameId&&frame.seriesId===seriesId):inline?.[index];
    const frame=preview??inlineFrame??(record?pesPathRecordOwner(run)?.frame(record.id,frameId):undefined);
    if(!frame)return;
    if(follows&&followingDisplay){
      this.followedFrames.set(runId,{runId,seriesId,frameId});
      if(!selection&&current.followRunId===runId)return;
    }else if(follows&&!selection&&current.followRunId===runId)return;
    this.observedFrames.delete(JSON.stringify([groupId,nodeId]));
    this.editNode(groupId, nodeId, node => ({ ...node,
      geometry:record?{...node.geometry,structure:this.pathStructure(run.request.structure,frame)}:node.geometry,
      selection:follows?undefined:{runId,seriesId,frameId,...(record?{recordId:record.id}:{})},followRunId:follows?runId:undefined }), 'cursor');
  }

  acquirePathRecord(groupId:string,runId:string,recordId:string){const run=this.group(groupId).runs[runId];if(!run)throw Error('势能面来源运行已关闭。');return acquirePesPathRecord(run,recordId);}
  preparePathRecord(groupId:string,runId:string,recordId:string,signal?:AbortSignal){const lease=this.acquirePathRecord(groupId,runId,recordId);return lease.prepare(signal).finally(()=>lease.release());}
  getPreparedPathRecord(groupId:string,runId:string,recordId:string){const run=this.group(groupId).runs[runId];return run?pesPathRecordOwner(run)?.get(recordId):undefined;}
  pathRecordDiagnostics(groupId:string,runId:string){const run=this.group(groupId).runs[runId];return run?pesPathRecordOwner(run)?.diagnostics():undefined;}
  async readFrame(groupId:string,runId:string,seriesId:string,frameId:string,signal?:AbortSignal,recordId?:string):Promise<PesFrame>{
    const run=this.group(groupId).runs[runId];if(!run)throw Error('势能面来源运行已关闭。');signal?.throwIfAborted();
    const inline=(run.result?.frames??run.acceptedFrames)?.find(frame=>frame.id===frameId&&frame.seriesId===seriesId);if(inline)return inline;
    const record=pathRecordForFrame(run,seriesId,frameId,recordId);
    if(!record)throw Error('该帧已不在当前势能面来源索引中。');
    const lease=acquirePesPathRecord(run,record.id);try{const frames=await lease.prepare(signal);if(this.group(groupId).runs[runId]!==run&&pesPathRecordOwner(this.group(groupId).runs[runId])!==pesPathRecordOwner(run))throw Error('帧读取期间来源运行已替换。');const frame=frames.find(frame=>frame.id===frameId&&frame.seriesId===seriesId);if(!frame)throw Error('来源轮没有返回所选帧。');return frame;}finally{lease.release();}
  }

  createCard(groupId: string, kind: PesCardKind): PesCard {
    if (kind === 'explore') throw Error('单端反应探索已停用，已有结果仍可查看和导出。');
    return this.selectCalculationCard(groupId, kind);
  }

  calculationCardLocked(groupId: string): boolean {
    return Object.values(this.group(groupId).runs).some(run =>
      ['scan','path','explore'].includes(run.request.operation) && isLive(run));
  }

  selectCalculationCard(groupId: string, kind: 'scan' | 'path', algorithm = kind === 'scan' ? 'sella-scan' : 'ci-neb'): PesCard {
    if (kind === 'scan' ? algorithm !== 'sella-scan' : !['ci-neb','fsm','de-gsm'].includes(algorithm)) throw Error('请选择有效的计算卡。');
    const group = this.group(groupId), previous = group.cards[0];
    if (previous?.kind === kind && (kind === 'scan' || previous.algorithm === algorithm)) return previous;
    if (this.calculationCardLocked(groupId)) throw Error('请等待当前常规计算结束或真正停止后再切换计算卡。');
    const cardDrafts = { ...group.cardDrafts };
    if (previous) cardDrafts[cardDraftKey(previous)] = pesCardParameterDraft(previous);
    let card = (kind === 'scan' ? scanCardDraft(group) : cardDrafts[algorithm])
      ?? { ...defaultPesCard(kind, nextName(cardPrefix[kind], Object.values(cardDrafts), true)), ...(kind === 'path' ? { algorithm } : {}) };
    if (previous?.kind === 'path' && kind === 'path') card = inheritPathEndpoints(previous, card);
    delete cardDrafts[algorithm];
    if (kind === 'scan' && cardDrafts[card.algorithm] === card) delete cardDrafts[card.algorithm];
    this.edit(groupId, current => ({ ...current, lifecycleVersion:'v223', cards: [card], cardDrafts }));
    return card;
  }

  updateCard(groupId: string, cardId: string, edit: (card: PesCard) => PesCard) {
    this.edit(groupId, group => ({ ...group, cards: group.cards.map(card => {
      if (card.id !== cardId) return card;
      const next = edit(card);
      if ((next.kind !== card.kind || next.algorithm !== card.algorithm) && this.calculationCardLocked(groupId))
        throw Error('请等待当前常规计算结束或真正停止后再切换计算卡。');
      return next;
    }) }));
  }

  moveCard(groupId: string, cardId: string, direction: -1 | 1) {
    this.edit(groupId, group => {
      const index = group.cards.findIndex(card => card.id === cardId), target = index + direction;
      if (index < 0 || target < 0 || target >= group.cards.length) return group;
      const cards = [...group.cards];
      [cards[index], cards[target]] = [cards[target], cards[index]];
      return { ...group, cards };
    });
  }

  removeCard(groupId: string, cardId: string) {
    this.edit(groupId, group => {
      if (Object.values(group.runs).some(run => run.request.runIdentity.taskId === cardId && isLive(run))) throw Error('请先停止该卡片的活动计算。');
      const card = group.cards.find(card => card.id === cardId);
      return { ...group, cards: group.cards.filter(card => card.id !== cardId),
        cardDrafts: card ? { ...group.cardDrafts, [cardDraftKey(card)]: pesCardParameterDraft(card) } : group.cardDrafts };
    });
  }

  setSlot(groupId: string, cardId: string, slot: string, geometry: PesGeometry | undefined) {
    this.updateCard(groupId, cardId, card => {
      const mappings = { ...card.mappings };
      const requiredSlots = [...new Set([...(card.requiredSlots ?? []), slot])];
      if (slot === 'reactant') return { ...card, requiredSlots, slots: { ...card.slots, [slot]: geometry ? structuredClone(geometry) : undefined }, mappings: {} };
      delete mappings[slot];
      return { ...card, requiredSlots, slots: { ...card.slots, [slot]: geometry ? structuredClone(geometry) : undefined }, mappings };
    });
  }

  captureSnapshot(groupId: string, cardId: string, slot: string, geometry: PesGeometry): PesNode {
    const group = this.group(groupId);
    const card = group.cards.find(item => item.id === cardId);
    if (!card || !this.isSlot(card, slot)) throw Error('该选帧槽已不存在。');
    if (!geometry.structure.atoms.length || geometry.structure.dimension === 2) throw Error('请先提供可记录的三维结构。');
    this.options.assertLiveElectronicSource?.(groupId,geometry);
    const id = pesId('snapshot'), name = geometry.label ? `${geometry.label} · 快照` : '当前结构快照';
    const selected = { ...structuredClone(geometry), label: name, inputSnapshotId: id };
    const node: PesNode = { id, name, kind: 'snapshot', geometry: selected, runIds: [] };
    this.setSlot(groupId,cardId,slot,selected);
    const confirmed=pesElectronicConfirmation(group,geometry);
    if(confirmed&&(slot==='reactant'||slot==='start')) {
      const draft=pesElectronicDraft(group,geometry);
      this.edit(groupId,current=>({...current,electronic:savePesElectronicDraft(current.electronic,pesElectronicSourceKey(current,selected),draft,confirmed)}));
    }
    return node;
  }

  createWorkbench(groupId: string, source: PesGeometry, prefix = 'CALC'): PesNode {
    const group = this.group(groupId);
    const node=this.workbenchDraft(group,source,prefix);
    const method = this.ffSourceMethod(group, source);
    this.edit(groupId, current => ({ ...current, ...(prefix==='CALC'?{calcSequence:Number(node.name.slice(5))}:{}),...(method ? { ts: { ...current.ts, method } } : {}), nodes: [...current.nodes, node], activeNodeId: node.id }));
    return node;
  }

  private workbenchDraft(group:PesGroup,source:PesGeometry,prefix='CALC'):PesNode {
    return { id:pesId('workbench'),name:prefix==='CALC'?nextCalcName(group):nextName(prefix,group.nodes,true),
      kind:'workbench',geometry:structuredClone({...source,ffModel:pesSourceFfModel(group,source)}),
      runIds:[],tsMethodInitialized:true,calcProfile:PES_CALC_PROFILE };
  }

  updateTs(groupId: string, edit: (draft: PesTsDraft) => PesTsDraft) { this.edit(groupId, group => ({ ...group, ts: edit(group.ts) })); }
  defaultCalculationLevel(): PesMethodDraft {
    return this.options.projectCalculationLevel?.read() ?? { ...defaultPesMethod(), ...solvationDraft(this.options.defaultXtbSolvation?.()) };
  }
  syncProjectCalculationLevel() {
    const level=this.options.projectCalculationLevel?.read();
    if (!level || this.state.groups.every(group => group.sharedMethod === level)) return;
    this.publish({ ...this.state, groups: this.state.groups.map(group => ({ ...group, sharedMethod: level })) });
  }
  updateSharedMethod(groupId: string, patch: Partial<PesMethodDraft>) {
    if (this.options.projectCalculationLevel) {
      this.group(groupId);
      this.options.projectCalculationLevel.update(patch);
      this.syncProjectCalculationLevel();
      return;
    }
    this.edit(groupId, group => ({ ...group, sharedMethod: { ...defaultPesMethod(), ...group.sharedMethod, ...patch } }));
  }
  syncXtbSolvation(solvation?: XtbSolvation) {
    const draft = solvationDraft(solvation);
    const groups = this.state.groups.map(group => group.sharedMethod?.solvent === draft.solvent && group.sharedMethod.solvationModel === draft.solvationModel
      ? group : { ...group, sharedMethod: { ...defaultPesMethod(), ...group.sharedMethod, ...draft } });
    if (groups.some((group, index) => group !== this.state.groups[index])) this.publish({ ...this.state, groups });
  }
  updateIrc(groupId: string, patch: PesParameters) {
    this.edit(groupId, group => ({ ...group, ircParameters: { ...group.ircParameters, ...patch } }));
  }
  setHessianStep(groupId: string, value: number) {
    if (value > 0 && Number.isFinite(value)) this.edit(groupId, group => ({ ...group, hessianStepBohr: value }));
  }
  updateConstraints(groupId:string,constraints:SharedModelConstraints,options?:{clearTargets?:readonly string[];commitModel?():SharedModelConstraints|void}){
    this.group(groupId);
    const next=structuredClone(options?.commitModel?.()??constraints);
    this.edit(groupId,group=>{
      const key=(row:SharedModelConstraints['coordinates'][number])=>row.id??modelCoordinateKey(row);
      const rows=new Map(next.coordinates.map(row=>[key(row),row]));
      const byGeometry=new Map(next.coordinates.map(row=>[modelCoordinateKey(row),row]));
      const clear=new Set(options?.clearTargets);
      const constraintTargets=group.constraintTargets&&{...group.constraintTargets};
      for(const previous of group.constraints.coordinates){
        const id=key(previous),target=rows.get(id)??byGeometry.get(modelCoordinateKey(previous));
        if(!target||target.value!==previous.value||modelCoordinateKey(target)!==modelCoordinateKey(previous)){clear.add(id);continue;}
        if(key(target)!==id){
          if(constraintTargets&&constraintTargets[id]!==undefined&&!clear.has(id))constraintTargets[key(target)]=constraintTargets[id];
          clear.add(id);
        }
      }
      if(constraintTargets)for(const id of clear)delete constraintTargets[id];
      return {...group,constraints:next,constraintTargets};
    });
  }
  editConstraintTarget(groupId: string, key: string, value: string | undefined) {
    this.edit(groupId, group => {
      const constraintTargets = { ...group.constraintTargets };
      if (value === undefined) delete constraintTargets[key]; else constraintTargets[key] = value;
      return { ...group, constraintTargets };
    });
  }

  editElectronic(groupId: string, field: 'charge' | 'multiplicity', value: string, geometry?:PesGeometry) {
    const group=this.group(groupId);
    const {charge,multiplicity}=geometry?pesElectronicDraft(group,geometry):group.electronic;
    this.editElectronicPair(groupId,{charge,multiplicity,[field]:value},geometry);
  }

  editElectronicPair(groupId:string, values:{charge:string;multiplicity:string}, geometry?:PesGeometry) {
    this.edit(groupId,group=>{
      const draft=geometry?pesElectronicDraft(group,geometry):group.electronic;
      if(draft.charge===values.charge&&draft.multiplicity===values.multiplicity)return group;
      const electronic=geometry?savePesElectronicDraft(group.electronic,pesElectronicSourceKey(group,geometry),values)
        : {...group.electronic,...values,confirmed:undefined,sourceKey:undefined,pendingUnscopedEdit:true};
      return {...group,electronic};
    });
  }

  confirmElectronic(groupId: string, geometry: PesGeometry, explicit?:BaseElectronicStateValues, shareWithModel=false) {
    const group = this.group(groupId);
    const { charge: q, multiplicity: m } = explicit?{charge:String(explicit.charge),multiplicity:String(explicit.multiplicity)}:pesElectronicDraft(group,geometry);
    if (!/^[+-]?\d+$/.test(q) || !/^\+?\d+$/.test(m)) throw Error('电荷必须为整数，自旋多重度必须为正整数。');
    const values = { charge: Number(q), multiplicity: Number(m) };
    if (!Number.isSafeInteger(values.charge) || !Number.isSafeInteger(values.multiplicity)) throw Error('请检查电荷与自旋多重度。');
    const error = baseElectronicStateError(geometry.structure, values);
    if (error) throw Error(error);
    if(shareWithModel)this.options.confirmLiveElectronicState?.(groupId,geometry,values);
    this.edit(groupId,current=>({...current,electronic:savePesElectronicDraft(current.electronic,pesElectronicSourceKey(current,geometry),
      {charge:String(values.charge),multiplicity:String(values.multiplicity)},values)}));
    return values;
  }

  startCard(groupId: string, cardId: string, authorizingDocumentId?: string, readDisplayedScanGeometry?: () => PesGeometry | undefined,
    runMethod?: PesMethodDraft, resourceOverrides?: Pick<XtbResourceOverrides,'xtbBatchParallelism'>): PesNode {
    const group = this.group(groupId);
    const card = group.cards.find(item => item.id === cardId);
    if (!card) throw Error('该计算卡已不存在。');
    if (card.kind === 'explore') throw Error('单端反应探索已停用，已有结果仍可查看和导出。');
    if (this.calculationCardLocked(groupId)) throw Error('该工作区的常规计算仍在运行，请等待或停止。');
    const readScanGeometry = card.kind === 'scan' ? () => this.currentScanGeometry(groupId, readDisplayedScanGeometry) : undefined;
    const source = cardSource(group, card, readScanGeometry?.()), prefix = algorithmPrefix[card.algorithm] ?? cardPrefix[card.kind];
    return this.start(group, source, card.id, nextName(prefix, group.nodes, true), undefined, { card, readScanGeometry, runMethod, resourceOverrides }, authorizingDocumentId);
  }

  startWorkbench(groupId: string, nodeId: string, source: PesGeometry, operation: PesWorkbenchInput['operation']): PesNode {
    const group = this.group(groupId);
    const node = group.nodes.find(item => item.id === nodeId);
    if (!node) throw Error('当前结构标签已关闭。');
    if (operation === 'irc') {
      if (runningIrc(group, source)) throw Error('当前帧的 IRC 正在运行。');
      return this.start(group, source, pesId('irc'), nextName('IRC', group.nodes, true), undefined, { operation }, undefined, node);
    }
    const workbench = node.kind === 'workbench' ? {...node,calcProfile:PES_CALC_PROFILE} : undefined;
    return this.start(group, source, workbench?.id ?? pesId('workbench'), workbench?.name ?? nextCalcName(group),
      workbench, { operation }, undefined, node);
  }

  /** Route an ordinary optimizer without replacing its existing algorithm. */
  prepareOptimization(groupId:string,nodeId:string,source:PesGeometry):PesNode {
    const group=this.group(groupId);
    return this.editableOptimizationPage(group,nodeId)??this.createWorkbench(groupId,source);
  }

  private editableOptimizationPage(group:PesGroup,nodeId:string):PesNode|undefined {
    const node=group.nodes.find(value=>value.id===nodeId);
    if(!node)throw Error('当前结构标签已关闭。');
    // A result/snapshot page only supplies input. A live solver on that page
    // does not own the new CALC node or its editable Store.
    if(node.kind!=='initial'&&node.kind!=='workbench')return;
    if(Object.values(group.runs).some(run=>run.nodeId===nodeId&&isLive(run)))throw Error('该计算仍在运行，请先等待或停止。');
    return node;
  }

  /** Records a real ordinary-optimizer invocation; never calls the PES solver. */
  beginOptimization(groupId:string,nodeId:string,source:PesGeometry,input:PesOptimizationInput,stop?:()=>Promise<void>,
    bindTarget?:BindOptimizationTarget):{node:PesNode;identity:PesRunIdentity} {
    if(isPesNetMethod(input.method))throw Error('此版本提供 xTB 优化，请重新选择计算级别。');
    const group=this.group(groupId),editable=this.editableOptimizationPage(group,nodeId);
    const target=editable??this.workbenchDraft(group,source);
    const method=editable?undefined:this.ffSourceMethod(group,source);
    const inputSource=structuredClone({...source,ffModel:pesSourceFfModel(group,source)});
    const id=pesId('run'),identity={groupId,taskId:target.id,runId:id};
    const ffModel = input.method === 'gfnff' ? (stop ? inputSource.ffModel :
      pesFfModelMatches(inputSource.ffModel, source.structure, input.charge, input.multiplicity, input.solvation)
        ? inputSource.ffModel : createPesFfModel(id, source.structure, input.charge, input.multiplicity, input.solvation)) : undefined;
    const request={schema:PES_SCHEMA,id,sourceDocumentId:source.documentId,runIdentity:identity,operation:'opt' as const,
      algorithm:input.algorithm,method:input.method,structure:structuredClone(source.structure),charge:input.charge,uhf:input.multiplicity-1,
      constraints:{frozenAtomIds:[...input.frozenAtomIds],coordinates:structuredClone(input.coordinates??[])},coordinates:[],
      parameters:stop ? {calcProfile:PES_CALC_PROFILE,ordinaryOptimization:structuredClone(input.parameters)} :
        {...structuredClone(input.parameters),calcProfile:PES_CALC_PROFILE,policyVersion:'v212',...(input.device ? {device:input.device} : {})},
      ...(input.resourceOverrides ? {resourceOverrides:structuredClone(input.resourceOverrides)} : {}),
      ...(ffModel ? {ffModel} : {}), ...(input.solvation ? {solvation:input.solvation} : {}),
    };
    const node={...target,calcProfile:PES_CALC_PROFILE,runIds:[...target.runIds,id],followRunId:undefined};
    if(bindTarget){
      Object.assign(inputSource,bindTarget(node));
      request.sourceDocumentId=inputSource.documentId;
    }
    const run:PesRun={request,source:inputSource,nodeId:target.id,status:'starting',lastSeq:-1,
      ...(!stop&&input.retainTrajectory?{retainTrajectory:true as const}:{})};
    if (stop) this.optimizationStops.set(id,stop);
    this.edit(groupId,current=>({...current,activeNodeId:node.id,
      ...(!editable?{calcSequence:Number(node.name.slice(5))}:{}),...(method?{ts:{...current.ts,method}}:{}),
      nodes:editable?current.nodes.map(value=>value.id===node.id?node:value):[...current.nodes,node],
      runs:{...current.runs,[id]:run}}));
    return{node,identity};
  }

  startOrdinaryOptimization(groupId:string,nodeId:string,source:PesGeometry,input:PesOptimizationInput,bindTarget?:BindOptimizationTarget):PesNode {
    if (!this.bridge) throw Error('当前运行环境未连接结构优化器。');
    const { node, identity } = this.beginOptimization(groupId,nodeId,source,input,undefined,bindTarget);
    const run = this.group(groupId).runs[identity.runId];
    void this.bridge.startPes(run.request).catch(error => this.recordOptimization(identity, {
      event: 'terminal', workerSettled: true, status: 'failed', error: {message: '无法启动结构优化。', detail: msg(error)},
    }));
    return node;
  }

  recordOptimization(identity:PesRunIdentity,update:PesOptimizationUpdate):void {
    const run=this.state.groups.find(group=>group.id===identity.groupId)?.runs[identity.runId];
    if(!run||run.request.operation!=='opt'||run.request.runIdentity.taskId!==identity.taskId)return;
    if(update.event==='frame'){
      if(isLive(run)&&validPesFrame(update.frame,run.request.structure.atoms.length))this.optimizationFrames.set(identity.runId,structuredClone(update.frame));
      return;
    }
    if(update.event==='terminal'){
      const frame=update.result?.frames.at(-1)??this.optimizationFrames.get(identity.runId);
      update={...update,...(update.result?{result:{...update.result,frames:frame?[frame]:[]}}:{})};
    }
    this.accept({...update,schema:PES_SCHEMA,runIdentity:identity,seq:run.lastSeq+1} as PesEvent);
    if(update.event==='terminal'){this.optimizationStops.delete(identity.runId);this.optimizationFrames.delete(identity.runId);}
  }

  initializeTsSource(groupId: string, nodeId: string, source: PesGeometry): void {
    const group = this.state.groups.find(item => item.id === groupId), node = group?.nodes.find(item => item.id === nodeId);
    if (!group || group.sharedMethod || !node || node.kind === 'workbench' || node.tsMethodInitialized) return;
    const method = this.ffSourceMethod(group, source);
    if (!method) return;
    this.edit(groupId, current => ({ ...current, ts: { ...current.ts, method },
      nodes: current.nodes.map(item => item.id === nodeId ? { ...item, tsMethodInitialized: true } : item) }));
  }

  private ffSourceMethod(group: PesGroup, source: PesGeometry): PesTsDraft['method'] | undefined {
    const model = pesSourceFfModel(group, source);
    if (!model) return;
    return { method: 'gfnff', solvationModel: model.solvation ? 'alpb' : 'none', solvent: model.solvation?.solvent ?? '' };
  }

  async stop(groupId: string, runId: string): Promise<void> {
    const run = this.group(groupId).runs[runId];
    if (!run || !isLive(run) || run.status === 'stopping') return;
    this.replaceRun(groupId, runId, { ...run, status: 'stopping' }, false);
    const preparation = this.optimizationPreparation.get(runId);
    if (preparation) { preparation.abort(); return; }
    try { const localStop = this.optimizationStops.get(runId); if(localStop)await localStop();else await this.bridge?.stopPes(run.request.runIdentity); }
    catch (error) {
      const current = this.state.groups.find(group => group.id === groupId)?.runs[runId];
      if (!current || !isLive(current)) return;
      this.replaceRun(groupId, runId, { ...current, status: run.status, error: { message: '停止请求失败。', detail: msg(error) } }, false);
      throw error;
    }
  }

  private isSlot(card: PesCard, slot: string) {
    return card.kind === 'path' ? slot === 'reactant' || slot === 'product' || card.keys.some(key => key.id === slot) : slot === 'start';
  }

  private branchInput(old: PesGroup, source: PesGeometry, request: PesRun['request'], card?: PesCard): PesNode {
    const { constraints } = projectPesConstraintDefinitions(old, source.structure, source.documentId);
    const group = this.newGroup({ ...source, structure: request.structure }, pesId('pes'), { constraints });
    const confirmed = { charge: request.charge, multiplicity: request.uhf + 1 };
    const sourceKey = pesElectronicSourceKey(group, source);
    const targetKeys = new Set(constraints.coordinates.map(row => row.id ?? modelCoordinateKey(row)));
    Object.assign(group, structuredClone({ ts: old.ts, sharedMethod: old.sharedMethod, ircParameters: old.ircParameters,
      hessianStepBohr: old.hessianStepBohr, cardDrafts: old.cardDrafts }), {
      electronic:savePesElectronicDraft(group.electronic,sourceKey,{charge:String(confirmed.charge),multiplicity:String(confirmed.multiplicity)},confirmed),
      constraintTargets: Object.fromEntries(Object.entries(old.constraintTargets ?? {}).filter(([key]) => targetKeys.has(key))),
    });
    const migrated = card && { ...(card.kind === 'scan' ? pesCardParameterDraft(card) : card), id: pesId('card'), runIds: [] };
    if (migrated) {
      if (migrated.kind === 'path') migrated.slots = { ...migrated.slots, reactant: source };
      group.cards = [migrated];
    }
    const taskId = migrated?.id ?? pesId(request.operation === 'irc' ? 'irc' : 'workbench');
    const name = migrated ? nextName(algorithmPrefix[migrated.algorithm] ?? cardPrefix[migrated.kind], group.nodes, true)
      : request.operation === 'irc' ? nextName('IRC', group.nodes, true) : nextCalcName(group);
    return this.submit(group, source, { ...request, runIdentity: { ...request.runIdentity, groupId: group.id, taskId } }, name, undefined, migrated);
  }

  private start(group: PesGroup, source: PesGeometry, taskId: string, name: string, existing: PesNode | undefined,
    input: { card: PesCard; readScanGeometry?: () => PesGeometry | undefined; runMethod?: PesMethodDraft;
      resourceOverrides?: Pick<XtbResourceOverrides,'xtbBatchParallelism'> } | PesWorkbenchInput, authorizingDocumentId?: string, origin?: PesNode): PesNode {
    if (!this.bridge) throw Error('当前运行环境未连接势能面求解器。');
    this.options.assertLiveElectronicSource?.(group.id,source);
    if (Object.values(group.runs).some(run => run.request.runIdentity.taskId === taskId && isLive(run))) throw Error('该计算仍在运行，请先等待或停止。');
    const card = 'card' in input ? input.card : undefined;
    const readScanGeometry = 'card' in input ? input.readScanGeometry : undefined;
    const inheritedMethod = origin && !existing && !card && 'operation' in input && input.operation !== 'irc' &&
      !group.sharedMethod && !origin.tsMethodInitialized ? this.ffSourceMethod(group, source) : undefined;
    const settings = inheritedMethod ? { ...group, ts: { ...group.ts, method: inheritedMethod },
      nodes: group.nodes.map(node => node === origin ? { ...node, tsMethodInitialized: true as const } : node) } : group;
    const runId = pesId('run'), identity: PesRunIdentity = { groupId: group.id, taskId, runId };
    const inputSource = structuredClone(source);
    const requestSettings='card' in input&&input.runMethod?{...settings,sharedMethod:input.runMethod}:settings;
    const request = structuredClone(preparePesRequest(requestSettings, identity, inputSource, input));
    if('card'in input&&input.resourceOverrides){
      const slots=input.resourceOverrides.xtbBatchParallelism;
      if(request.operation!=='path'||!['ci-neb','fsm'].includes(request.algorithm)||isPesNetMethod(request.method)||!Number.isSafeInteger(slots)||slots!<1)
        throw Error('xTB 批量并行数仅适用于 xTB CI-NEB 或 FSM，且须为正整数。');
      request.resourceOverrides={xtbBatchParallelism:slots};
    }
    if (authorizingDocumentId) request.sourceDocumentId = authorizingDocumentId;
    const atomCount = request.structure.atoms.length;
    const results = successfulPesResults(group);
    const existingAtomCounts = [...results.keys()].sort((a, b) => a - b);
    const conflictingResults = existingAtomCounts.filter(count => count !== atomCount).map(count => ({ atomCount: count, label: results.get(count)! }));
    if (conflictingResults.length) {
      const activeDocument = this.options.submittingDocument?.();
      const sealedCard = card && structuredClone(card);
      let handled = false;
      throw new PesCompositionChange(group.id, atomCount, existingAtomCounts, conflictingResults, () => {
        const current = this.state.groups.find(item => item.id === group.id);
        const electronic=current&&pesElectronicConfirmation(current,inputSource);
        if (handled || !current || electronic?.charge!==request.charge || electronic.multiplicity!==request.uhf+1 || current.constraints !== group.constraints ||
          current.constraintTargets !== group.constraintTargets || current.sharedMethod !== group.sharedMethod ||
          current.hessianStepBohr !== group.hessianStepBohr || this.options.submittingDocument?.() !== activeDocument) throw new PesSubmissionChanged();
        if (card) {
          if (current.cards.find(item => item.id === card.id) !== card || this.calculationCardLocked(group.id)) throw new PesSubmissionChanged();
          let currentSource: PesGeometry;
          try { currentSource = cardSource(current, card, readScanGeometry?.()); } catch { throw new PesSubmissionChanged(); }
          if (readScanGeometry ? !samePesScanSource(currentSource, inputSource) : currentSource.structure !== source.structure) throw new PesSubmissionChanged();
        } else {
          const originNow = origin && current.nodes.find(node => node.id === origin.id);
          const duplicate = request.operation === 'irc' ? runningIrc(current, inputSource)
            : existing && Object.values(current.runs).some(run => run.request.runIdentity.taskId === taskId && isLive(run));
          if (!originNow || originNow.geometry !== origin?.geometry || originNow.selection !== origin?.selection ||
            current.ts !== group.ts || (request.operation === 'irc' && current.ircParameters !== group.ircParameters) || duplicate)
            throw new PesSubmissionChanged();
        }
        handled = true;
        return this.branchInput(settings, inputSource, request, sealedCard);
      });
    }
    return this.submit(settings, inputSource, request, name, existing, card);
  }

  private submit(group: PesGroup, inputSource: PesGeometry, request: PesRun['request'], name: string,
    existing?: PesNode, card?: PesCard): PesNode {
    const { runId, taskId } = request.runIdentity;
    const result = !!card || request.operation === 'irc';
    const node: PesNode = existing ? { ...existing, runIds: [...existing.runIds, runId],
      followRunId:currentWorkbenchResult(group,existing.id)?undefined:runId } : {
      id: card ? pesId('result') : taskId, name, kind: result ? 'result' : 'workbench', geometry: inputSource, runIds: [runId], followRunId: runId,
      ...(card ? {} : { tsMethodInitialized: true as const, calcProfile:PES_CALC_PROFILE }),
    };
    const inputSources = card && (card.kind === 'scan' ? { slots: { start: inputSource } } : structuredClone({ slots: card.slots, mappings: card.mappings }));
    const run: PesRun = { request, nodeId: node.id, source: inputSource, inputSources, status: 'starting', lastSeq: -1 };
    const next = { ...group, ...(!existing && node.kind === 'workbench' ? { calcSequence:Number(name.slice(5)) } : {}), activeNodeId: node.id,
      nodes: existing ? group.nodes.map(item => item.id === node.id ? node : item) : [...group.nodes, node],
      runs: { ...group.runs, [runId]: run }, cards: group.cards.map(item => item.id !== taskId ? item : { ...item, runIds: [...item.runIds, runId] }) };
    const groups = this.state.groups.some(item => item.id === group.id)
      ? this.state.groups.map(item => item.id === group.id ? next : item) : [...this.state.groups, next];
    this.publish({ ...this.state, groups });
    void Promise.resolve().then(() => this.bridge!.startPes(request)).then(() => {
      // The run already owns a complete immutable input. Clear only the exact
      // inputs it adopted; later recordings in the configuration remain intact.
      if (card) this.releaseAdoptedInputs(group.id, card, runId);
    }).catch(error => {
      const owned = this.state.groups.find(item => item.id === group.id)?.runs[runId];
      if (!owned || owned.status !== 'starting' && owned.status !== 'stopping' || owned.lastSeq >= 0) return;
      this.replaceRun(group.id, runId, { ...owned, status: 'failed', error: { message: '无法启动势能面计算。', detail: msg(error) } });
    });
    return node;
  }

  private async readTerminalPayload(event: TerminalEvent, request: PesRun['request'], payload: TerminalPayload, current: () => void) {
    const { frameIds, frames: available } = payload, { resultNumericAssets } = event;
    const identity = request.runIdentity;
    const ordered: PesFrame[] = [];
    current();
    if (!event.result || !Array.isArray(frameIds) || frameIds.some(id => typeof id !== 'string' || !id)
        || new Set(frameIds).size !== frameIds.length || event.resultFrameIds && event.result.frames.length)
      throw Error('优化终态的帧清单与来源不符。');
    const atomCount = request.structure.atoms.length;
    for (let offset = 0; offset < frameIds.length;) {
      const live = available.get(frameIds[offset]);
      if (live) { ordered.push(live); offset++; continue; }
      if (!this.bridge?.readPesTerminalFrames) throw Error('当前环境没有优化终态分页读取能力。');
      const limit = Math.min(64, frameIds.length - offset);
      const page = await this.bridge.readPesTerminalFrames({ runIdentity: identity, offset, limit });
      current();
      if (page.offset !== offset || page.total !== frameIds.length
          || !Array.isArray(page.frames) || !page.frames.length || page.frames.length > limit
          || page.done !== (offset + page.frames.length === frameIds.length))
        throw Error('优化终态分页边界与来源不符。');
      for (const frame of page.frames) {
        if (!validPesFrame(frame, atomCount) || frame.id !== frameIds[offset])
          throw Error('优化终态中的帧身份或坐标无效。');
        const original = available.get(frame.id);
        if (original && (original.seriesId !== frame.seriesId || original.step !== frame.step
            || original.phase !== frame.phase || original.energyHartree !== frame.energyHartree
            || original.positions.some((row, index) => row.some((value, axis) => value !== frame.positions[index][axis]))))
          throw Error('优化终态改变了已接管帧。');
        available.set(frame.id, original ?? frame);
        ordered.push(original ?? frame);
        offset++;
      }
    }
    payload.result = { ...event.result, frames: ordered };
    if (resultNumericAssets) {
      const read = this.bridge?.readBinaryAsset?.bind(this.bridge);
      if (!read) throw Error('当前环境没有优化数值资产分段读取能力。');
      if (resultNumericAssets.hessianMatrix) {
        const asset = resultNumericAssets.hessianMatrix;
        const [rows, columns] = asset.shape;
        if (asset.shape.length !== 2 || rows !== columns || !payload.result.hessian || typeof payload.result.hessian !== 'object')
          throw Error('优化 Hessian 资产形状无效。');
        const matrixHartreePerBohr2 = await readPesFloat64Rows(asset, rows, columns, read, current);
        payload.result = { ...payload.result, hessian: { ...payload.result.hessian, matrixHartreePerBohr2 } };
      }
      if (resultNumericAssets.modeDisplacements) {
        const asset = resultNumericAssets.modeDisplacements;
        const [modes, atoms, components] = asset.shape;
        if (asset.shape.length !== 3 || atoms !== atomCount || components !== 3
            || !Array.isArray(payload.result.frequencies) || payload.result.frequencies.length !== modes)
          throw Error('优化振动资产形状无效。');
        const triples = await readPesFloat64Rows(asset, modes * atoms, 3, read, current);
        payload.result = { ...payload.result, frequencies: payload.result.frequencies.map((mode, index) => ({
          ...mode, displacements: triples.slice(index * atoms, (index + 1) * atoms),
        })) };
      }
    }
    current();
  }

  private async adoptTerminalFrames(event: TerminalEvent, run: PesRun) {
    const request = run.request, identity = request.runIdentity;
    if (this.terminalReads.has(request)) return;
    const work = new AbortController();
    this.terminalReads.set(request, work);
    const frameIds = event.resultFrameIds ?? event.result?.frames.map(frame => frame.id) ?? [];
    const available = new Map([...(run.acceptedFrames ?? []), ...(event.result?.frames ?? [])].map(frame => [frame.id, frame]));
    const current = () => {
      work.signal.throwIfAborted();
      const owner = this.state.groups.find(group => group.id === identity.groupId)?.runs[identity.runId];
      if (!owner || owner.request !== request || !isLive(owner) || owner.lastSeq >= event.seq)
        throw new DOMException('优化终态来源已改变。', 'AbortError');
    };
    const { resultFrameIds: _frameIds, resultNumericAssets, ...terminal } = event;
    const payload = { result: event.result, frames: available, frameIds };
    try {
      await this.readTerminalPayload(event, request, payload, current);
      this.terminalAccepted.set(request, { identity, assets: Object.values(resultNumericAssets ?? {}).map(asset => asset.id) });
      this.accept({ ...terminal, result: payload.result });
    } catch (error) {
      if (work.signal.aborted || error instanceof Error && error.name === 'AbortError') return;
      const warning = '优化终态读取受限，已保留可用帧：' + msg(error);
      const usable = Array.isArray(frameIds) ? [...new Set(frameIds)].flatMap(id => {
        const frame = available.get(id);
        return frame ? [frame] : [];
      }) : [...available.values()];
      const result = payload.result;
      this.accept({ ...terminal, error: { message: warning, detail: event.error?.message },
        result: result ? { ...result, frames: usable,
          provenance: { ...result.provenance, terminalFrameAdoption: 'incomplete', terminalFrameAdoptionWarning: warning } } : undefined });
    } finally {
      this.terminalReads.delete(request);
    }
  }

  private accept(event: PesEvent, prepared?: PreparedOptimizationGeometry) {
    if (event.schema !== PES_SCHEMA) return;
    const { groupId, taskId, runId } = event.runIdentity;
    const group = this.state.groups.find(item => item.id === groupId), run = group?.runs[runId];
    if (!group || !run || !isLive(run) || taskId !== run.request.runIdentity.taskId || !Number.isSafeInteger(event.seq) || event.seq <= run.lastSeq) return;
    if (event.event === 'optimization-timing') return;
    if (event.event === 'terminal' && (event.resultFrameIds !== undefined || event.resultNumericAssets !== undefined)) {
      if (event.workerSettled === true && !this.terminalReads.has(run.request)) {
        this.replaceRun(groupId,runId,{...run,workerSettled:true},false);
        void this.adoptTerminalFrames(event, run);
      }
      return;
    }
    const next = { ...run, lastSeq: event.seq };
    if (['scan','path','explore'].includes(run.request.operation)) {
      const card = group.cards.find(card => card.id === taskId);
      if (card && run.inputSources) this.releaseAdoptedInputs(groupId,card,runId);
    }
    if (event.event === 'started') {
      next.nativeStarted=true;
      if(event.resourceGrant)next.resourceGrant=event.resourceGrant;
      if(next.status==='starting')next.status='running';
    }
    if (event.event === 'evaluation-started') next.nativeBackend=event.backend;
    if (event.event === 'net-batch' && isPesNetMethod(run.request.method) && (run.request.parameters.device??'gpu')==='gpu'
      && Number.isSafeInteger(event.size) && event.size>=1 && event.size<=8) next.actualGpuBatchWidth=event.size;
    if (event.event === 'progress') next.progress = { stage: event.stage, completed: event.completed, total: event.total, elapsedSeconds: event.elapsedSeconds };
    if (event.event === 'frame' && validPesFrame(event.frame, run.request.structure.atoms.length)) {
      next.preview = event.frame;
      const previous=run.acceptedFrames??[];
      let indices=this.liveFrameIndices.get(run.request);
      if(!indices){
        indices=new Map(previous.map((frame,index)=>[`${frame.seriesId}\u0000${frame.id}`,index]));
        this.liveFrameIndices.set(run.request,indices);
      }
      const key=`${event.frame.seriesId}\u0000${event.frame.id}`,index=indices.get(key);
      const frames=[...previous];
      if(index===undefined){indices.set(key,frames.length);frames.push(event.frame);}
      else frames[index]=event.frame;
      next.acceptedFrames=frames;
    }
    if(event.event==='path-record'){
      if(validPesPathRecord(event.record))next.pathRecords=this.mergePathRecords(pesPathRecords(run),[event.record]);
      else next.error={message:'路径轮索引缺少可靠成员或能量对应，原始来源已保留。'};
    }
    if(event.event==='scan-point'){
      const points=run.scanPoints??[],index=points.findIndex(point=>point.pointIndex===event.point.pointIndex);
      next.scanPoints=index<0?[...points,event.point]:points.map((point,at)=>at===index?event.point:point);
    }
    if (event.event !== 'terminal') { this.replaceRun(groupId, runId, next, false); return; }
    if (event.workerSettled !== true) return;
    next.workerSettled=true;
    this.followedFrames.delete(runId);
    this.liveFrameIndices.delete(run.request);
    next.status = event.status;
    next.error = event.error;
    const sharedOpt = run.request.operation === 'opt' && run.request.parameters.ordinaryOptimization === undefined;
    const result = event.result;
    if (result) {
      ownPesResultNumerics(result);
      const seen = new Map<string,number>(),frames:PesFrame[]=[];let invalid=0;
      for(const frame of result.frames){
        const id = `${frame.seriesId}\u0000${frame.id}`;
        if(!validPesFrame(frame,run.request.structure.atoms.length)){invalid++;continue;}
        const previous=seen.get(id);
        if(previous!==undefined){const before=frames[previous];if(before.step!==frame.step||before.phase!==frame.phase||before.energyHartree!==frame.energyHartree||before.positions.some((position,index)=>position.some((value,axis)=>value!==frame.positions[index][axis]))){invalid++;continue;}frames[previous]={...before,...frame};}
        else{seen.set(id,frames.length);frames.push(frame);}
      }
      next.result = frames.length === result.frames.length ? result : { ...result, frames,...(invalid&&!sharedOpt?{status:'partial'}:{}) };
      if(invalid)next.error ??= { message: '部分返回帧缺少可靠结构对应。' };
    }
    const records=this.mergePathRecords(pesPathRecords(run),result?.pathRecords??[]);
    if(records.length){next.pathRecords=records;if(next.result)next.result={...next.result,pathRecords:records};}
    if(result?.scanPoints)next.scanPoints=result.scanPoints;
    if (!next.result?.frames.length && run.acceptedFrames?.length) next.result = {
      ...(next.result ?? { status: sharedOpt && event.status === 'stopped' ? 'stopped' : 'partial', provenance: {} }), frames: [...run.acceptedFrames],
    };
    if (run.request.operation === 'irc' && next.result) {
      const frames = new Map((run.acceptedFrames ?? []).map(frame => [frame.id, frame]));
      for (const frame of next.result.frames) frames.set(frame.id, frame);
      next.result = { ...next.result, frames: [...frames.values()].sort((a,b) => (a.cv?.[0] ?? 0) - (b.cv?.[0] ?? 0)) };
    }
    delete next.progress;
    delete next.preview;
    delete next.acceptedFrames;
    this.bindPathSource(run,next);
    const lastRecord=records.find(record=>record.id===result?.lastPathRecordId)??records.at(-1);
    const frame = lastRecord?selectInitialPesFrame(lastRecord.frames,run.request.operation):selectInitialPesFrame(next.result?.frames ?? [], run.request.operation);
    const selection: PesFrameSelection | undefined = frame ? { runId, seriesId: frame.seriesId, frameId: frame.id,...(lastRecord?{recordId:lastRecord.id}:{}) } : undefined;
    const node=group.nodes.find(value=>value.id===run.nodeId),editable=node&&(node.kind==='initial'||node.kind==='workbench');
    if(editable&&run.request.operation==='opt'){
      const final=sharedOpt?lastOrdinaryOptimizationFrame(next.result?.frames??[],run.request.structure.atoms.length,run.preview):next.result?.frames.at(-1);
      const converged=event.status==='completed'&&!next.error&&['completed','converged'].includes(next.result?.status??'')&&final?.converged!==false;
      let geometry:PesGeometry|undefined,finalGeometry:PesGeometry|undefined;
      if(final&&(sharedOpt||converged)){
        try{
          geometry=finalGeometry=optimizationFinalGeometry(next,final);
          if(sharedOpt)geometry.structure.preparation=ordinaryOptimizationPreparation(event.status,next.result,final);
          const prepare=this.options.prepareOptimizationGeometry;
          const prepareBonds=this.options.prepareOptimizationBonds;
          const result=next.result;
          const canRebuild=converged||(sharedOpt&&run.request.method==='gfn2'&&
            event.status==='completed'&&!next.error&&result&&['not-converged','unconverged'].includes(result.status));
          if(canRebuild&&run.status!=='stopping'&&(prepare||prepareBonds)&&result&&run.request.parameters.rebuildBonds===true&&!prepared){
            if (this.optimizationPreparation.has(runId)) return;
            const work = new AbortController();
            this.optimizationPreparation.set(runId, work);
            const finish=(outcome:PreparedOptimizationGeometry)=>{
              if (this.optimizationPreparation.get(runId) !== work) return;
              this.optimizationPreparation.delete(runId);
              this.accept(event,work.signal.aborted?{}:outcome);
            };
            void (async () => {
              let outcome:PreparedOptimizationGeometry;
              try {
                outcome=prepareBonds?await prepareBonds(geometry!,final,run.request,work.signal,result)
                  :{structure:await prepare!(geometry!,final,run.request,work.signal)};
              }
              catch (error) { finish({ warning: msg(error) }); return; }
              finish(outcome);
            })();
            return;
          }
          if(prepared?.structure)geometry.structure=prepared.structure;
          if(prepared?.warning&&next.result)next.result={...next.result,provenance:{...next.result.provenance,bondPerceptionWarning:prepared.warning}};
          const commit={groupId,nodeId:node.id,runId,source:structuredClone(run.source),geometry};
          let adopted: void | false | Pick<PesGeometry,'revision'|'structure'>;
          try{adopted=this.options.onOptimizationGeometry?.({...commit,bondOrderObservation:prepared?.bondOrderObservation});}
          catch(error){
            if(!prepared?.structure)throw error;
            geometry.structure=optimizationFinalGeometry(next,final).structure;
            if(sharedOpt)geometry.structure.preparation=ordinaryOptimizationPreparation(event.status,next.result,final);
            if(next.result)next.result={...next.result,provenance:{...next.result.provenance,bondPerceptionWarning:msg(error)}};
            adopted=this.options.onOptimizationGeometry?.(commit);
          }
          if(adopted===false)throw Error('优化最终结构未接管。');
          if(adopted){geometry.revision=adopted.revision;geometry.structure=structuredClone(adopted.structure);}
        }catch(error){
          geometry=undefined;
          if(sharedOpt&&next.result)next.result={...next.result,provenance:{...next.result.provenance,geometryAdoptionError:msg(error)}};
          else {next.status='failed';next.error={message:msg(error)};}
        }
      }
      if(next.result){const {positions:_positions,...finalObservation}=final??{};next.result={...next.result,frames:run.retainTrajectory?next.result.frames:[],...(final?{finalObservation:{...finalObservation,...(geometry&&prepared?.bondOrderObservation?{bondOrderObservation:prepared.bondOrderObservation}:{})}}:{}),...(finalGeometry?{finalStructure:finalGeometry.structure}:{})};}
      const retainedSelection=run.retainTrajectory?selection:undefined;
      this.edit(groupId,current=>({...current,runs:geometry?retireWorkbenchResults(current,node,runId,{...current.runs,[runId]:next},!converged):{...current.runs,[runId]:next},
        nodes:current.nodes.map(value=>value.id!==node.id?value:geometry?{...value,geometry,selection:retainedSelection,followRunId:undefined}:
          {...value,...(retainedSelection?{selection:retainedSelection}:{}),followRunId:undefined})}));
      return;
    }
    if(editable&&['ts','hessian'].includes(run.request.operation)){
      const success=isSuccessfulWorkbenchRun(next);
      const hessian=next.result?.hessian as {frameId?:string}|undefined;
      if(success&&run.request.operation==='hessian'&&hessian?.frameId)next.result={...next.result!,frames:next.result!.frames.filter(frame=>frame.id===hessian.frameId)};
      const final=success?next.result!.frames.find(frame=>frame.id===hessian?.frameId):undefined;
      this.edit(groupId,current=>{
        const partial=workbenchPartialTsFrame(next);
        const selected=final??(!currentWorkbenchResult(current,node.id)?partial:undefined);
        return {...current,runs:success?retireWorkbenchResults(current,node,runId,{...current.runs,[runId]:next}):{...current.runs,[runId]:next},
          nodes:current.nodes.map(value=>value.id!==node.id?value:{...value,followRunId:undefined,
            ...(selected?{selection:{runId,seriesId:selected.seriesId,frameId:selected.id}}:{})})};
      });
      return;
    }
    this.edit(groupId, current => ({ ...current, runs: { ...current.runs, [runId]: next }, nodes: current.nodes.map(node => {
      if (node.id !== run.nodeId || node.followRunId !== runId) return node;
      if ((node.kind === 'workbench'||node.kind === 'initial') && (current.activeNodeId !== node.id || this.options.canFollowWorkbench?.(groupId, node.id, runId) === false))
        return { ...node, followRunId: undefined };
      return { ...node, selection, followRunId: undefined };
    }) }));
  }

  private async settleRuns(groupId: string, runs: PesRun[]) {
    if (!runs.length) return;
    const ids = runs.map(run => run.request.id);
    let unsubscribe = () => {};
    const settled = new Promise<void>(resolve => {
      const check = () => { const group = this.state.groups.find(item => item.id === groupId); if (!group || ids.every(id => !group.runs[id] || !isLive(group.runs[id]))) resolve(); };
      unsubscribe = this.subscribe(check);
      check();
    });
    try { await Promise.all(ids.map(id => this.stop(groupId, id))); await settled; }
    finally { unsubscribe(); }
  }

  private releaseAdoptedInputs(groupId: string, adopted: PesCard, runId: string) {
    const group = this.state.groups.find(group => group.id === groupId);
    const run = group?.runs[runId];
    if (!group || !run?.inputSources || adopted.kind === 'scan') return;
    this.edit(groupId,current => {
      let anyChanged = false;
      const cards = current.cards.map(card => {
      if (card.id !== adopted.id) return card;
      const slots = { ...card.slots };
      const mappings = { ...card.mappings };
      let changed = false;
      for (const [key,geometry] of Object.entries(slots)) {
        // Endpoints belong to the PES group's active path input, not this run.
        // A run already owns deep copies. Only key-structure snapshots retain
        // the original release-after-adoption behavior.
        if (card.kind === 'path' && pathEndpointSlots.some(slot => slot === key)) continue;
        const owned = run.inputSources!.slots[key];
        if (geometry && owned && (geometry.inputSnapshotId ? geometry.inputSnapshotId === owned.inputSnapshotId :
          JSON.stringify(geometry) === JSON.stringify(owned))) {
          delete slots[key]; delete mappings[key]; changed = true;
        }
      }
      anyChanged ||= changed;
      return changed ? { ...card, slots, mappings, requiredSlots: [...new Set([
        ...(card.requiredSlots ?? []), ...Object.keys(run.inputSources!.slots),
      ])] } : card;
      });
      return anyChanged ? {...current,cards} : current;
    });
  }

  private group(id: string) {
    const group = this.state.groups.find(item => item.id === id);
    if (!group) throw Error('势能面组已关闭。');
    return group;
  }

  private edit(id: string, update: (group: PesGroup) => PesGroup, persistent: boolean|'cursor' = true) {
    const group = this.group(id), next = update(group);
    if (next !== group) this.publish({ ...this.state, groups: this.state.groups.map(item => item.id === id ? next : item) }, persistent);
  }

  private editNode(groupId: string, nodeId: string, update: (node: PesNode) => PesNode, persistent: boolean|'cursor' = true) {
    this.edit(groupId, group => {
      const node = group.nodes.find(item => item.id === nodeId);
      if (!node) return group;
      const next = update(node);
      return next === node ? group : { ...group, nodes: group.nodes.map(item => item.id === nodeId ? next : item) };
    },persistent);
  }

  private replaceRun(groupId: string, runId: string, run: PesRun, persistent = true) {
    const previous=this.group(groupId).runs[runId];if(previous)this.bindPathSource(previous,run);
    this.edit(groupId, group => ({ ...group, runs: { ...group.runs, [runId]: run } }), persistent);
  }
  private mergePathRecords(previous:readonly PesPathRecord[],incoming:readonly PesPathRecord[]):readonly PesPathRecord[]{
    const values=[...previous];
    for(const record of incoming){if(!validPesPathRecord(record))continue;const index=values.findIndex(value=>value.id===record.id||value.seriesId===record.seriesId&&value.phase===record.phase&&value.step===record.step);
      if(index<0)values.push(record);else values[index]=record;}
    return values;
  }
  private bindPathSource(previous:PesRun,next:PesRun){
    transferPesPathRecordOwner(previous,next);
    if(!pesPathRecordOwner(next)&&pesPathRecords(next).length&&this.bridge?.readPesPathRecord){
      const identity=next.request.runIdentity;
      const owner=new PesPathRecordOwner(next.request.structure.atoms.length,async(recordId,signal)=>{
        signal?.throwIfAborted();const frames=await this.bridge!.readPesPathRecord!({runIdentity:identity,recordId});signal?.throwIfAborted();return frames;
      });bindPesPathRecordOwner(next,owner);this.nativePathSources.set(owner,identity);
    }
  }

  private cancelNotificationFrame() {
    if(this.notificationFrame===undefined)return;
    cancelAnimationFrame(this.notificationFrame);
    this.notificationFrame=undefined;
  }
  private retirePathSource(owner:PesPathRecordOwner,identity:PesRunIdentity){
    owner.dispose();this.nativePathSources.delete(owner);
    const recoveryId=this.recoveryPathClaims.get(owner);
    this.recoveryPathClaims.delete(owner);
    const release=recoveryId&&this.bridge?.closePesRecovery
      ? this.bridge.closePesRecovery(recoveryId) : this.bridge?.releasePesPathRecords?.(identity);
    if(!release)return;
    const released=release.catch(error=>{this.options.onPathSourceReleaseError?.('路径来源临时资产尚未释放：'+msg(error));}).finally(()=>this.pathReleases.delete(released));
    this.pathReleases.add(released);
  }

  private publish(snapshot: PesProjectSnapshot, persistent: boolean|'cursor' = true) {
    if(persistent===true&&this.nativePathSources.size){
      const retained=new Set(snapshot.groups.flatMap(group=>Object.values(group.runs).map(pesPathRecordOwner)));
      for(const [owner,identity]of this.nativePathSources)if(!retained.has(owner))this.retirePathSource(owner,identity);
    }
    this.state = snapshot;
    if(persistent===true)for(const [key,pending] of this.observedFrames){
      const group=snapshot.groups.find(group=>group.id===pending.groupId),node=group?.nodes.find(node=>node.id===pending.nodeId);
      if(!group||!node||!this.currentObservedFrame(group,node))this.observedFrames.delete(key);
    }
    if (persistent===true && this.terminalAccepted.size) for (const [request, receipt] of this.terminalAccepted) {
      const { identity, assets } = receipt;
      const owner = snapshot.groups.find(group => group.id === identity.groupId)?.runs[identity.runId];
      if (!owner || owner.request !== request || isLive(owner)) continue;
      this.terminalAccepted.delete(request);
      if (this.bridge?.releasePesTerminalFrames) {
        const released = Promise.resolve().then(async () => {
          if (assets.length && !this.bridge?.releaseBinaryAsset) throw Error('缺少二进制资产释放入口。');
          await Promise.all(assets.map(asset => this.bridge!.releaseBinaryAsset!(asset)));
          await this.bridge!.releasePesTerminalFrames!(identity);
        }).catch(error => {
          this.options.onPathSourceReleaseError?.('优化终态分页资产尚未释放：' + msg(error));
        }).finally(() => this.pathReleases.delete(released));
        this.pathReleases.add(released);
      }
    }
    // Only render notifications can coalesce. All accepted events are already
    // stored in sequence, and a terminal or persistent edit flushes immediately.
    if(!persistent&&typeof requestAnimationFrame==='function'){
      this.notificationFrame??=requestAnimationFrame(()=>{
        this.notificationFrame=undefined;
        this.listeners.forEach(listener=>listener());
      });
      return;
    }
    this.cancelNotificationFrame();
    this.listeners.forEach(listener => listener());
    if (persistent) this.persistentListeners.forEach(listener => listener(persistent==='cursor'?'cursor':'content'));
  }
}
