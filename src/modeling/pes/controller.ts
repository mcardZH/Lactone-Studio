import { baseElectronicStateParameterError as baseElectronicStateError, initialBaseElectronicState } from '../../core/base-electronic-state';
import type { SharedModelConstraints } from '../../core/modeling/contracts';
import type { Structure } from '../../core/types';
import { modelCoordinateKey } from '../constraints';
import { coordinatesFingerprint } from '../../core/modeling/graph';
import { PES_SCHEMA, PES_CALC_PROFILE, pesCardParameterDraft, type PesOptimizationInput, type PesOptimizationUpdate, type PesBridge, type PesCard, type PesCardKind, type PesEvent, type PesFrame, type PesFrameSelection, type PesGeometry,
  type PesGroup, type PesNode, type PesProjectSnapshot, type PesRun, type PesRunIdentity, type PesTsDraft, type PesOptimizationGeometryCommit } from './contracts';
import { defaultPesCard, defaultPesTs, pesId } from './defaults';
import { cardSource, preparePesRequest } from './request';
import { pesSourceFfModel } from './ff-model';
import {PesPathRecordOwner,acquirePesPathRecord,bindPesPathRecordOwner,pesPathRecordOwner,pesPathRecords,transferPesPathRecordOwner,validPesPathRecord} from './path-records';
import type {PesPathRecord} from './contracts';
import { PesBranchInputError, PesCompositionChange, pesComposition, pesCompositionDifference, pesElectronicConfirmed, pesElectronicSourceKey } from './input-state';

const isLive = (run: PesRun) => run.status === 'starting' || run.status === 'running' || run.status === 'stopping';
const msg = (error: unknown) => error instanceof Error ? error.message : String(error);
const cardPrefix: Record<PesCardKind, string> = { scan: 'SCAN', path: 'PATH', explore: 'EXPLORE' };
const algorithmPrefix: Record<string, string> = { 'ci-neb': 'CI-NEB', 'de-gsm': 'GSM', fsm: 'FSM' };
const pathEndpointSlots = ['reactant', 'product'] as const;

export function isSuccessfulWorkbenchRun(run:PesRun|undefined):run is PesRun {
  const hessian=run?.result?.hessian as {frameId?:string;projectedDegreesOfFreedom?:number;vibrationalDegreesOfFreedom?:number}|undefined;
  const frequencies=run?.result?.frequencies;
  const frequencyResult=Array.isArray(frequencies)&&(frequencies.length>0||hessian?.vibrationalDegreesOfFreedom===0||
    hessian?.projectedDegreesOfFreedom===0&&hessian.vibrationalDegreesOfFreedom===undefined);
  return !!run&&!run.supersededByRunId&&run.status==='completed'&&!run.error&&
    ['completed','converged'].includes(run.result?.status??'')&&['ts','hessian'].includes(run.request.operation)&&
    frequencyResult&&
    !!hessian?.frameId&&!!run.result?.frames.some(frame=>frame.id===hessian.frameId);
}
/** Only the last retained successful TS/Freq result belongs to a CALC page. */
export function currentWorkbenchResult(group:PesGroup,nodeId:string):PesRun|undefined {
  const node=group.nodes.find(value=>value.id===nodeId);
  if(node?.kind!=='workbench')return;
  return [...node.runIds].reverse().map(id=>group.runs[id]).find(isSuccessfulWorkbenchRun);
}
export function editableNodeActiveRun(group:PesGroup,nodeId:string):PesRun|undefined {
  const node=group.nodes.find(value=>value.id===nodeId);
  if(!node||node.kind!=='initial'&&node.kind!=='workbench')return;
  return [...node.runIds].reverse().map(id=>group.runs[id]).find(run=>run&&isLive(run));
}
function retireWorkbenchResults(group:PesGroup,node:PesNode,replacement:string,runs:Record<string,PesRun>):Record<string,PesRun> {
  const next={...runs};
  for(const id of node.runIds){
    const old=next[id];if(id===replacement||!isSuccessfulWorkbenchRun(old))continue;
    next[id]={...old,supersededByRunId:replacement,result:{frames:[],status:'superseded',provenance:old.result!.provenance}};
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
  return {...run.source,structure:structuredClone(candidate??structureForPesFrame(run.request.structure,frame)),
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

export function validPesFrame(frame: PesFrame, atoms: number): boolean {
  return !!frame && typeof frame.id==='string'&&!!frame.id && typeof frame.seriesId==='string'&&!!frame.seriesId && Number.isSafeInteger(frame.step) && Array.isArray(frame.positions)&&frame.positions.length === atoms &&
    frame.positions.every(point => Array.isArray(point)&&point.length === 3 && point.every(Number.isFinite)) &&
    (frame.energyHartree == null || Number.isFinite(frame.energyHartree));
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

function staticSnapshot(snapshot: PesProjectSnapshot): PesProjectSnapshot {
  if (snapshot.schema !== PES_SCHEMA) throw Error('不支持此势能面项目数据版本。');
  const copy = structuredClone(snapshot);
  for (const group of copy.groups) {
    if (group.lifecycleVersion === 'v223') {
      group.cards = group.cards.map(pesCardParameterDraft);
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
        const run=group.runs[id];if(run?.request.operation!=='opt')continue;
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
  private persistentListeners = new Set<() => void>();
  private bridgeUnsubscribe?: () => void;
  private nativePathSources=new Map<PesPathRecordOwner,PesRunIdentity>();
  private pathReleases=new Set<Promise<void>>();
  private optimizationStops=new Map<string,()=>Promise<void>>();
  private optimizationFrames=new Map<string,PesFrame>();

  constructor(private readonly bridge?: PesBridge, snapshot?: PesProjectSnapshot,
    private readonly options: { canFollowWorkbench?(groupId: string, nodeId: string, runId: string): boolean;
      submittingDocument?(): string;onPathSourceReleaseError?(message:string):void;
      onOptimizationGeometry?(commit:PesOptimizationGeometryCommit):void|false } = {}) {
    this.state = snapshot ? staticSnapshot(snapshot) : { schema: PES_SCHEMA, groups: [] };
    this.bridgeUnsubscribe = bridge?.onPesEvent(event => this.accept(event));
  }

  get available(): boolean { return !!this.bridge; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribePersistence = (listener: () => void) => { this.persistentListeners.add(listener); return () => { this.persistentListeners.delete(listener); }; };

  exportSnapshot(): PesProjectSnapshot { return staticSnapshot(this.state); }

  importSnapshot(snapshot: PesProjectSnapshot): void {
    if (this.state.groups.some(group => Object.values(group.runs).some(isLive))) throw Error('请等待势能面计算结束后再恢复项目。');
    this.publish(staticSnapshot(snapshot));
  }

  dispose(): void {
    this.bridgeUnsubscribe?.();
    this.bridgeUnsubscribe = undefined;
    this.listeners.clear();
    this.persistentListeners.clear();
    this.optimizationFrames.clear();this.optimizationStops.clear();
    for(const group of this.state.groups)for(const run of Object.values(group.runs))pesPathRecordOwner(run)?.dispose();
    for(const [owner,identity]of this.nativePathSources)this.retirePathSource(owner,identity);
    this.state = { schema:PES_SCHEMA, groups:[] };
  }
  async settlePathSourceReleases(){await Promise.all([...this.pathReleases]);}

  createGroup(initial: PesGeometry, groupId = pesId('pes'), options?: { constraints?: SharedModelConstraints; initialName?: string }): PesGroup {
    if (this.state.groups.some(group => group.id === groupId)) throw Error('该势能面组已存在。');
    const id = pesId('initial');
    const values = initialBaseElectronicState(initial.structure);
    const node: PesNode = { id, name: options?.initialName ?? 'initial', kind: 'initial', geometry: structuredClone(initial), runIds: [] };
    const group: PesGroup = { lifecycleVersion:'v223', id: groupId, name: nextName('pes', this.state.groups, true), initialNodeId: id, activeNodeId: id,
      nodes: [node], cards: [], runs: {}, electronic: { charge: String(values.charge), multiplicity: String(values.multiplicity) },
      constraints: options?.constraints ? structuredClone(options.constraints) : { frozenAtomIds: [], coordinates: [], enabled: true }, ts: defaultPesTs() };
    this.publish({ ...this.state, groups: [...this.state.groups, group] });
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

  nodeGeometry(groupId: string, nodeId: string): PesGeometry | undefined {
    const group = this.group(groupId);
    const node = group.nodes.find(item => item.id === nodeId);
    if (!node) return;
    // Stored geometry retains its origin. A selectable geometry identifies this node.
    const source = { groupId, nodeId };
    const selection = node.selection;
    const candidate = group.runs[selection?.runId ?? node.followRunId ?? ''];
    const run = candidate?.nodeId === nodeId ? candidate : undefined;
    const record=run&&selection?pesPathRecords(run).find(record=>(!selection.recordId||record.id===selection.recordId)&&record.frames.some(frame=>frame.id===selection.frameId&&frame.seriesId===selection.seriesId)):undefined;
    const frame = selection ? (run?.result?.frames ?? run?.acceptedFrames)?.find(item => item.id === selection.frameId && item.seriesId === selection.seriesId)??(run&&record?pesPathRecordOwner(run)?.frame(record.id,selection.frameId):undefined) : run?.preview;
    if (run && frame) return { ...node.geometry, label: node.name, structure: structureForPesFrame(run.request.structure, frame),
      ffModel: pesSourceFfModel(group, { ...run.source, source: { runId: run.request.id } }),
      source: { ...source, runId: run.request.id, seriesId: frame.seriesId, frameId: frame.id,...(record?{recordId:record.id}:{}) } };
    if(selection&&record)return;
    if (run && isLive(run) && node.followRunId === run.request.id) return { ...run.source, label: node.name,
      ffModel: pesSourceFfModel(group, { ...run.source, source: { runId: run.request.id } }), source: { ...source, runId: run.request.id } };
    return { ...node.geometry, label: node.name, source };
  }

  updateNodeGeometry(groupId: string, nodeId: string, geometry: PesGeometry, options?: { removedAtomIds?: readonly string[]; electronicChanged?:boolean; electronicConfirmed?:boolean }) {
    this.edit(groupId, group => {
      const node = group.nodes.find(item => item.id === nodeId);
      if (!node || (node.kind !== 'initial' && node.kind !== 'workbench')) return group;
      if (node.geometry.documentId === geometry.documentId && node.geometry.revision === geometry.revision &&
        node.geometry.structure.charge===geometry.structure.charge && node.geometry.structure.multiplicity===geometry.structure.multiplicity) return group;
      const removed = new Set(options?.removedAtomIds ?? []);
      const coordinates = group.constraints.coordinates.filter(row => !row.atomIds.some(id => removed.has(id)));
      const frozenAtomIds = group.constraints.frozenAtomIds.filter(id => !removed.has(id));
      const {charge,multiplicity}=geometry.structure;
      let electronic=options?.electronicChanged && charge!=null && multiplicity!=null &&
        (Number(group.electronic.charge)!==charge||Number(group.electronic.multiplicity)!==multiplicity)
        ? {charge:String(charge),multiplicity:String(multiplicity),confirmationHistory:group.electronic.confirmationHistory} : group.electronic;
      const sourceKey=pesElectronicSourceKey(group,geometry);
      if (sourceKey!==pesElectronicSourceKey(group,node.geometry) || options?.electronicChanged && options.electronicConfirmed) {
        const confirmed=electronic.confirmationHistory?.[JSON.stringify([sourceKey,Number(electronic.charge),Number(electronic.multiplicity)])];
        if (confirmed) electronic={...electronic,confirmed,sourceKey};
      }
      return { ...group, electronic, constraints: { ...group.constraints, frozenAtomIds, coordinates }, nodes: group.nodes.map(item => item.id !== nodeId ? item :
        { ...item, geometry: structuredClone({ ...geometry, ffModel: geometry.ffModel ?? node.geometry.ffModel }), selection: undefined, followRunId: undefined }) };
    });
  }

  clearFrameSelection(groupId: string, nodeId: string) {
    this.editNode(groupId, nodeId, node => node.selection || node.followRunId ? { ...node, selection: undefined, followRunId: undefined } : node);
  }

  selectFrame(groupId: string, nodeId: string, runId: string, seriesId: string, frameId: string,recordId?:string) {
    const run = this.group(groupId).runs[runId];
    if(run?.nodeId!==nodeId)return;
    const record=pesPathRecords(run).find(record=>(!recordId||record.id===recordId)&&record.frames.some(frame=>frame.id===frameId&&frame.seriesId===seriesId));
    const frame=(run.result?.frames??run.acceptedFrames)?.find(frame=>frame.id===frameId&&frame.seriesId===seriesId)??(record?pesPathRecordOwner(run)?.frame(record.id,frameId):undefined);
    if(!frame)return;
    const follows = isLive(run) && run.preview?.id === frameId && run.preview?.seriesId === seriesId;
    this.editNode(groupId, nodeId, node => !record&&node.selection?.runId === runId && node.selection.seriesId === seriesId && node.selection.frameId === frameId ? node :
      { ...node, geometry:record?{...node.geometry,structure:structureForPesFrame(run.request.structure,frame)}:node.geometry,
        selection: follows ? undefined : { runId, seriesId, frameId,...(record?{recordId:record.id}:{}) }, followRunId: follows ? runId : undefined });
  }

  acquirePathRecord(groupId:string,runId:string,recordId:string){const run=this.group(groupId).runs[runId];if(!run)throw Error('势能面来源运行已关闭。');return acquirePesPathRecord(run,recordId);}
  preparePathRecord(groupId:string,runId:string,recordId:string,signal?:AbortSignal){const lease=this.acquirePathRecord(groupId,runId,recordId);return lease.prepare(signal).finally(()=>lease.release());}
  getPreparedPathRecord(groupId:string,runId:string,recordId:string){const run=this.group(groupId).runs[runId];return run?pesPathRecordOwner(run)?.get(recordId):undefined;}
  pathRecordDiagnostics(groupId:string,runId:string){const run=this.group(groupId).runs[runId];return run?pesPathRecordOwner(run)?.diagnostics():undefined;}
  async readFrame(groupId:string,runId:string,seriesId:string,frameId:string,signal?:AbortSignal,recordId?:string):Promise<PesFrame>{
    const run=this.group(groupId).runs[runId];if(!run)throw Error('势能面来源运行已关闭。');signal?.throwIfAborted();
    const inline=(run.result?.frames??run.acceptedFrames)?.find(frame=>frame.id===frameId&&frame.seriesId===seriesId);if(inline)return inline;
    const record=pesPathRecords(run).find(record=>(!recordId||record.id===recordId)&&record.frames.some(frame=>frame.id===frameId&&frame.seriesId===seriesId));
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
    if (previous?.kind === kind && previous.algorithm === algorithm) return previous;
    if (this.calculationCardLocked(groupId)) throw Error('请等待当前常规计算结束或真正停止后再切换计算卡。');
    const cardDrafts = { ...group.cardDrafts };
    if (previous) cardDrafts[previous.algorithm] = pesCardParameterDraft(previous);
    let card = cardDrafts[algorithm] ?? { ...defaultPesCard(kind, nextName(cardPrefix[kind], Object.values(cardDrafts), true)), algorithm };
    if (previous?.kind === 'path' && kind === 'path') card = inheritPathEndpoints(previous, card);
    delete cardDrafts[algorithm];
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
        cardDrafts: card ? { ...group.cardDrafts, [card.algorithm]: pesCardParameterDraft(card) } : group.cardDrafts };
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
    const id = pesId('snapshot'), name = geometry.label ? `${geometry.label} · 快照` : '当前结构快照';
    const selected = { ...structuredClone(geometry), label: name, inputSnapshotId: id };
    const node: PesNode = { id, name, kind: 'snapshot', geometry: selected, runIds: [] };
    this.setSlot(groupId,cardId,slot,selected);
    return node;
  }

  createWorkbench(groupId: string, source: PesGeometry, prefix = 'CALC'): PesNode {
    const group = this.group(groupId);
    const node: PesNode = { id: pesId('workbench'), name: prefix==='CALC'?nextCalcName(group):nextName(prefix, group.nodes, true), kind: 'workbench', geometry: structuredClone({...source,ffModel:pesSourceFfModel(group,source)}), runIds: [], tsMethodInitialized: true, calcProfile:PES_CALC_PROFILE };
    const method = this.ffSourceMethod(group, source);
    this.edit(groupId, current => ({ ...current, ...(prefix==='CALC'?{calcSequence:Number(node.name.slice(5))}:{}),...(method ? { ts: { ...current.ts, method } } : {}), nodes: [...current.nodes, node], activeNodeId: node.id }));
    return node;
  }

  updateTs(groupId: string, edit: (draft: PesTsDraft) => PesTsDraft) { this.edit(groupId, group => ({ ...group, ts: edit(group.ts) })); }
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

  editElectronic(groupId: string, field: 'charge' | 'multiplicity', value: string) {
    const {charge,multiplicity}=this.group(groupId).electronic;
    this.editElectronicPair(groupId,{charge,multiplicity,[field]:value});
  }

  editElectronicPair(groupId:string, values:{charge:string;multiplicity:string}) {
    this.edit(groupId, group => group.electronic.charge===values.charge && group.electronic.multiplicity===values.multiplicity
      ? group : {...group,electronic:{...values,confirmationHistory:group.electronic.confirmationHistory}});
  }

  confirmElectronic(groupId: string, geometry: PesGeometry) {
    const group = this.group(groupId);
    const { charge: q, multiplicity: m } = group.electronic;
    if (!/^[+-]?\d+$/.test(q) || !/^\+?\d+$/.test(m)) throw Error('电荷必须为整数，自旋多重度必须为正整数。');
    const values = { charge: Number(q), multiplicity: Number(m) };
    if (!Number.isSafeInteger(values.charge) || !Number.isSafeInteger(values.multiplicity)) throw Error('请检查电荷与自旋多重度。');
    const error = baseElectronicStateError(geometry.structure, values);
    if (error) throw Error(error);
    const sourceKey = pesElectronicSourceKey(group, geometry);
    this.edit(groupId, current => ({ ...current, electronic: { ...current.electronic, confirmed: values, sourceKey,
      confirmationHistory:{...current.electronic.confirmationHistory,[JSON.stringify([sourceKey,values.charge,values.multiplicity])]:values} } }));
    return values;
  }

  startCard(groupId: string, cardId: string, authorizingDocumentId?: string): PesNode {
    const group = this.group(groupId);
    const card = group.cards.find(item => item.id === cardId);
    if (!card) throw Error('该计算卡已不存在。');
    if (card.kind === 'explore') throw Error('单端反应探索已停用，已有结果仍可查看和导出。');
    if (this.calculationCardLocked(groupId)) throw Error('该工作区的常规计算仍在运行，请等待或停止。');
    const source = cardSource(group, card), prefix = algorithmPrefix[card.algorithm] ?? cardPrefix[card.kind];
    return this.start(group, source, card.id, nextName(prefix, group.nodes, true), undefined, { card }, authorizingDocumentId);
  }

  startWorkbench(groupId: string, nodeId: string, source: PesGeometry, operation: 'ts' | 'hessian'): PesNode {
    let group = this.group(groupId);
    const node = group.nodes.find(item => item.id === nodeId);
    if (!node) throw Error('当前结构标签已关闭。');
    const workbench = node.kind === 'workbench' ? {...node,calcProfile:PES_CALC_PROFILE} : undefined;
    const name = workbench?.name ?? nextCalcName(group);
    // Initialize the newly created independent page once. Existing workbenches
    // keep the user's TS method/medium edits when browsing or running again.
    if (!workbench) this.initializeTsSource(groupId, nodeId, source);
    group = this.group(groupId);
    return this.start(group, source, workbench?.id ?? pesId('workbench'), name, workbench, { operation });
  }

  /** Route an ordinary optimizer without replacing its existing algorithm. */
  prepareOptimization(groupId:string,nodeId:string,source:PesGeometry):PesNode {
    const group=this.group(groupId),node=group.nodes.find(value=>value.id===nodeId);
    if(!node)throw Error('当前结构标签已关闭。');
    if(Object.values(group.runs).some(run=>run.nodeId===nodeId&&isLive(run)))throw Error('该计算仍在运行，请先等待或停止。');
    if(node.kind!=='initial'&&node.kind!=='workbench')return this.createWorkbench(groupId,source);
    return node;
  }

  /** Records a real ordinary-optimizer invocation; never calls the PES solver. */
  beginOptimization(groupId:string,nodeId:string,source:PesGeometry,input:PesOptimizationInput,stop:()=>Promise<void>):{node:PesNode;identity:PesRunIdentity} {
    const target=this.prepareOptimization(groupId,nodeId,source),group=this.group(groupId);
    const inputSource=structuredClone({...source,ffModel:pesSourceFfModel(group,source)});
    const id=pesId('run'),identity={groupId,taskId:target.id,runId:id};
    const request={schema:PES_SCHEMA,id,sourceDocumentId:source.documentId,runIdentity:identity,operation:'opt' as const,
      algorithm:input.algorithm,method:input.method,structure:structuredClone(source.structure),charge:input.charge,uhf:input.multiplicity-1,
      constraints:{frozenAtomIds:[...input.frozenAtomIds],coordinates:structuredClone(input.coordinates??[])},coordinates:[],
      parameters:{calcProfile:PES_CALC_PROFILE,ordinaryOptimization:structuredClone(input.parameters)},
      ...(input.method==='gfnff'&&inputSource.ffModel?{ffModel:inputSource.ffModel}:{}),
    };
    const node={...target,calcProfile:PES_CALC_PROFILE,runIds:[...target.runIds,id],followRunId:undefined};
    const run:PesRun={request,source:inputSource,nodeId:target.id,status:'starting',lastSeq:-1};
    this.optimizationStops.set(id,stop);
    this.edit(groupId,current=>({...current,activeNodeId:node.id,nodes:current.nodes.map(value=>value.id===node.id?node:value),runs:{...current.runs,[id]:run}}));
    return{node,identity};
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
    if (!group || !node || node.kind === 'workbench' || node.tsMethodInitialized) return;
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
    try { if(run.request.operation==='opt')await this.optimizationStops.get(runId)?.();else await this.bridge?.stopPes(run.request.runIdentity); }
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

  private branchInput(old:PesGroup, source:PesGeometry, input:{card:PesCard}|{operation:'ts'|'hessian'}, authorizingDocumentId:string) {
    const ids=new Set(source.structure.atoms.map(atom=>atom.id));
    const coordinates=old.constraints.coordinates.filter(row=>row.atomIds.every(id=>ids.has(id)));
    const constraints={...old.constraints,coordinates,frozenAtomIds:old.constraints.frozenAtomIds.filter(id=>ids.has(id))};
    const group=this.createGroup(source,undefined,{constraints});
    const initial=group.nodes[0];
    const targets=new Set(coordinates.map(row=>row.id??modelCoordinateKey(row)));
    const targetValues=Object.fromEntries(Object.entries(old.constraintTargets??{}).filter(([key])=>targets.has(key)));
    const migrated=old.cards.map(draft=>{
      const copy=structuredClone(draft);
      const selectedSource=copy.kind==='path'?'reactant':'start';
      delete copy.slots[selectedSource];
      for (const [slot,geometry] of Object.entries(copy.slots)) {
        if(!geometry)continue;
        const counts=pesComposition(geometry.structure);
        if(pesCompositionDifference(pesComposition(source.structure),counts)){
          delete copy.slots[slot];
          if(copy.mappings)delete copy.mappings[slot];
        }
      }
      return {...copy,id:pesId('card'),runIds:[]};
    });
    const electronic={charge:old.electronic.charge,multiplicity:old.electronic.multiplicity};
    this.edit(group.id,current=>({...current,ts:structuredClone(old.ts),cards:migrated,electronic,constraintTargets:targetValues}));
    if(!pesElectronicConfirmed(old,source))return initial;
    // A confirmed source is copied exactly. An unconfirmed changed geometry
    // stays editable in its new initial and requires its own confirmation.
    this.confirmElectronic(group.id,initial.geometry);
    try {
      if('card' in input){
        const index=old.cards.findIndex(card=>card.id===input.card.id);
        return this.startCard(group.id,migrated[index].id,authorizingDocumentId);
      }
      return this.startWorkbench(group.id,initial.id,initial.geometry,input.operation);
    } catch(error) { throw new PesBranchInputError(initial,msg(error)); }
  }

  private start(group: PesGroup, source: PesGeometry, taskId: string, name: string, existing: PesNode | undefined,
    input: { card: PesCard } | { operation: 'ts' | 'hessian' }, authorizingDocumentId?: string): PesNode {
    if (!this.bridge) throw Error('当前运行环境未连接势能面求解器。');
    if (Object.values(group.runs).some(run => run.request.runIdentity.taskId === taskId && isLive(run))) throw Error('该计算仍在运行，请先等待或停止。');
    const composition = pesComposition(source.structure);
    const firstRun = Object.values(group.runs)[0];
    const baseline = group.submittedComposition ?? (firstRun && pesComposition(firstRun.request.structure));
    const difference = baseline && pesCompositionDifference(baseline, composition);
    if (difference && source.structure.atoms.length) {
      const capturedKey=pesElectronicSourceKey(group,source);
      const capturedCoordinates=coordinatesFingerprint(source.structure);
      const activeDocument=this.options.submittingDocument?.();
      let handled=false;
      throw new PesCompositionChange(difference,()=>{
        const current=this.group(group.id);
        const currentGeometry='card' in input ? cardSource(current,current.cards.find(row=>row.id===taskId)??input.card)
          : this.nodeGeometry(group.id,group.activeNodeId);
        // The workspace may project display-only connections onto a computed
        // frame. Its immutable frame identity and coordinates establish that
        // the same selection is still present while the dialog was open.
        const sameFrame=source.source?.frameId && currentGeometry?.source?.frameId===source.source.frameId &&
          currentGeometry.source.runId===source.source.runId && currentGeometry.source.seriesId===source.source.seriesId &&
          currentGeometry.source.nodeId===source.source.nodeId &&
          coordinatesFingerprint(currentGeometry.structure)===coordinatesFingerprint(source.structure);
        if(handled || current.activeNodeId!==group.activeNodeId || current.electronic!==group.electronic || current.constraints!==group.constraints ||
          ('card' in input ? current.cards.find(card=>card.id===taskId)!==input.card : current.ts!==group.ts) ||
          !currentGeometry || (!sameFrame && (pesElectronicSourceKey(current,currentGeometry)!==capturedKey || coordinatesFingerprint(currentGeometry.structure)!==capturedCoordinates)) ||
          this.options.submittingDocument?.()!==activeDocument)throw Error('输入或任务已变化，请从当前计算卡重新提交。');
        handled=true;
        return this.branchInput(group,source,input,authorizingDocumentId??source.documentId);
      });
    }
    const runId = pesId('run'), identity: PesRunIdentity = { groupId: group.id, taskId, runId };
    const inputSource = structuredClone(source);
    const request = structuredClone(preparePesRequest(group, identity, inputSource, input));
    if (authorizingDocumentId) request.sourceDocumentId = authorizingDocumentId;
    const node: PesNode = existing ? { ...existing, runIds: [...existing.runIds, runId],
      followRunId:currentWorkbenchResult(group,existing.id)?undefined:runId } : {
      id: 'card' in input ? pesId('result') : taskId, name, kind: 'card' in input ? 'result' : 'workbench', geometry: inputSource, runIds: [runId], followRunId: runId,
      ...('card' in input ? {} : { tsMethodInitialized: true as const }),
      ...('card' in input ? {} : { calcProfile:PES_CALC_PROFILE }),
    };
    const inputSources = 'card' in input ? structuredClone({ slots: input.card.slots, mappings: input.card.mappings }) : undefined;
    const run: PesRun = { request, nodeId: node.id, source: inputSource, inputSources, status: 'starting', lastSeq: -1 };
    this.edit(group.id, current => ({ ...current, ...(!existing&&node.kind==='workbench'?{calcSequence:Number(name.slice(5))}:{}),submittedComposition: baseline ?? composition, activeNodeId: node.id,
      nodes: existing ? current.nodes.map(item => item.id === node.id ? node : item) : [...current.nodes, node],
      runs: { ...current.runs, [runId]: run }, cards: current.cards.map(card => card.id !== taskId ? card : { ...card, runIds: [...card.runIds, runId] }) }));
    void Promise.resolve().then(() => this.bridge!.startPes(request)).then(() => {
      // The run already owns a complete immutable input. Clear only the exact
      // inputs it adopted; later recordings in the configuration remain intact.
      if ('card' in input) this.releaseAdoptedInputs(group.id, input.card, runId);
    }).catch(error => {
      const owned = this.state.groups.find(item => item.id === group.id)?.runs[runId];
      if (!owned || owned.status !== 'starting' && owned.status !== 'stopping' || owned.lastSeq >= 0) return;
      this.replaceRun(group.id, runId, { ...owned, status: 'failed', error: { message: '无法启动势能面计算。', detail: msg(error) } });
    });
    return node;
  }

  private accept(event: PesEvent) {
    if (event.schema !== PES_SCHEMA) return;
    const { groupId, taskId, runId } = event.runIdentity;
    const group = this.state.groups.find(item => item.id === groupId), run = group?.runs[runId];
    if (!group || !run || !isLive(run) || taskId !== run.request.runIdentity.taskId || !Number.isSafeInteger(event.seq) || event.seq <= run.lastSeq) return;
    const next = { ...run, lastSeq: event.seq };
    if (['scan','path','explore'].includes(run.request.operation)) {
      const card = group.cards.find(card => card.id === taskId);
      if (card && run.inputSources) this.releaseAdoptedInputs(groupId,card,runId);
    }
    if (event.event === 'started' && next.status === 'starting') next.status = 'running';
    if (event.event === 'progress') next.progress = { stage: event.stage, completed: event.completed, total: event.total, elapsedSeconds: event.elapsedSeconds };
    if (event.event === 'frame' && validPesFrame(event.frame, run.request.structure.atoms.length)) {
      next.preview = event.frame;
      const previous=run.acceptedFrames??[],index=previous.findIndex(frame=>frame.id===event.frame.id&&frame.seriesId===event.frame.seriesId);
      next.acceptedFrames = index<0?[...previous,event.frame]:previous.map((frame,at)=>at===index?event.frame:frame);
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
    next.status = event.status;
    next.error = event.error;
    const result = event.result;
    if (result) {
      const seen = new Map<string,number>(),frames:PesFrame[]=[];let invalid=0;
      for(const frame of result.frames){
        const id = `${frame.seriesId}\u0000${frame.id}`;
        if(!validPesFrame(frame,run.request.structure.atoms.length)){invalid++;continue;}
        const previous=seen.get(id);
        if(previous!==undefined){const before=frames[previous];if(before.step!==frame.step||before.phase!==frame.phase||before.energyHartree!==frame.energyHartree||before.positions.some((position,index)=>position.some((value,axis)=>value!==frame.positions[index][axis]))){invalid++;continue;}frames[previous]={...before,...frame};}
        else{seen.set(id,frames.length);frames.push(frame);}
      }
      next.result = frames.length === result.frames.length ? result : { ...result, frames,...(invalid?{status:'partial'}:{}) };
      if(invalid)next.error = { message: '部分返回帧缺少可靠结构对应。', detail: event.error?.detail };
    }
    const records=this.mergePathRecords(pesPathRecords(run),result?.pathRecords??[]);
    if(records.length){next.pathRecords=records;if(next.result)next.result={...next.result,pathRecords:records};}
    if(result?.scanPoints)next.scanPoints=result.scanPoints;
    if (!next.result?.frames.length && run.acceptedFrames?.length) next.result = {
      ...(next.result ?? { status: 'partial', provenance: {} }), frames: [...run.acceptedFrames],
    };
    delete next.progress;
    delete next.preview;
    delete next.acceptedFrames;
    this.bindPathSource(run,next);
    const lastRecord=records.find(record=>record.id===result?.lastPathRecordId)??records.at(-1);
    const frame = lastRecord?selectInitialPesFrame(lastRecord.frames,run.request.operation):selectInitialPesFrame(next.result?.frames ?? [], run.request.operation);
    const selection: PesFrameSelection | undefined = frame ? { runId, seriesId: frame.seriesId, frameId: frame.id,...(lastRecord?{recordId:lastRecord.id}:{}) } : undefined;
    const node=group.nodes.find(value=>value.id===run.nodeId),editable=node&&(node.kind==='initial'||node.kind==='workbench');
    if(editable&&run.request.operation==='opt'){
      const final=next.result?.frames.at(-1);
      let geometry:PesGeometry|undefined,finalGeometry:PesGeometry|undefined;
      if(event.status==='completed'&&!next.error&&final&&['completed','converged'].includes(next.result?.status??'')&&final.converged!==false){
        try{
          geometry=finalGeometry=optimizationFinalGeometry(next,final);
          if(this.options.onOptimizationGeometry?.({groupId,nodeId:node.id,runId,source:structuredClone(run.source),geometry})===false)throw Error('优化最终结构未接管。');
        }catch(error){geometry=undefined;next.status='failed';next.error={message:msg(error)};}
      }
      if(next.result){const {positions:_positions,...finalObservation}=final??{};next.result={...next.result,frames:[],...(final?{finalObservation}:{}),...(finalGeometry?{finalStructure:finalGeometry.structure}:{})};}
      this.edit(groupId,current=>({...current,runs:geometry?retireWorkbenchResults(current,node,runId,{...current.runs,[runId]:next}):{...current.runs,[runId]:next},
        nodes:current.nodes.map(value=>value.id!==node.id?value:geometry?{...value,geometry,selection:undefined,followRunId:undefined}:{...value,followRunId:undefined})}));
      return;
    }
    if(editable&&['ts','hessian'].includes(run.request.operation)){
      const success=isSuccessfulWorkbenchRun(next);
      const hessian=next.result?.hessian as {frameId?:string}|undefined;
      if(success&&run.request.operation==='hessian'&&hessian?.frameId)next.result={...next.result!,frames:next.result!.frames.filter(frame=>frame.id===hessian.frameId)};
      const final=success?next.result!.frames.find(frame=>frame.id===hessian?.frameId):undefined;
      this.edit(groupId,current=>({...current,runs:success?retireWorkbenchResults(current,node,runId,{...current.runs,[runId]:next}):{...current.runs,[runId]:next},
        nodes:current.nodes.map(value=>value.id!==node.id?value:success?{...value,selection:{runId,seriesId:final!.seriesId,frameId:final!.id},followRunId:undefined}:{...value,followRunId:undefined})}));
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
    if (!group || !run?.inputSources) return;
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

  private edit(id: string, update: (group: PesGroup) => PesGroup, persistent = true) {
    const group = this.group(id), next = update(group);
    if (next !== group) this.publish({ ...this.state, groups: this.state.groups.map(item => item.id === id ? next : item) }, persistent);
  }

  private editNode(groupId: string, nodeId: string, update: (node: PesNode) => PesNode) {
    this.edit(groupId, group => {
      const node = group.nodes.find(item => item.id === nodeId);
      if (!node) return group;
      const next = update(node);
      return next === node ? group : { ...group, nodes: group.nodes.map(item => item.id === nodeId ? next : item) };
    });
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
  private retirePathSource(owner:PesPathRecordOwner,identity:PesRunIdentity){
    owner.dispose();this.nativePathSources.delete(owner);
    if(!this.bridge?.releasePesPathRecords)return;
    const released=this.bridge.releasePesPathRecords(identity).catch(error=>{this.options.onPathSourceReleaseError?.('路径来源临时资产尚未释放：'+msg(error));}).finally(()=>this.pathReleases.delete(released));
    this.pathReleases.add(released);
  }

  private publish(snapshot: PesProjectSnapshot, persistent = true) {
    const retained=new Set(snapshot.groups.flatMap(group=>Object.values(group.runs).map(pesPathRecordOwner)));
    for(const [owner,identity]of this.nativePathSources)if(!retained.has(owner))this.retirePathSource(owner,identity);
    this.state = snapshot;
    this.listeners.forEach(listener => listener());
    if (persistent) this.persistentListeners.forEach(listener => listener());
  }
}
