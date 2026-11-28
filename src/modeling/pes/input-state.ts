import { initialBaseElectronicState, type BaseElectronicStateValues } from '../../core/base-electronic-state';
import { electronicInventorySignature } from '../../core/modeling/electronic-state-policy';
import type { PesGeometry, PesGroup, PesNode, PesRun } from './contracts';

export function pesEditableElectronicNode(group: PesGroup, geometry: PesGeometry): PesNode | undefined {
  const source=geometry.source;
  if(geometry.inputSnapshotId || source?.runId || source?.frameId || source?.recordId || geometry.originFrame?.frameId && !source) return;
  if(source) {
    if(source.groupId!==group.id)return;
    return group.nodes.find(node=>node.id===source.nodeId&&node.geometry.documentId===geometry.documentId&&(node.kind==='initial'||node.kind==='workbench'));
  }
  return group.nodes.find(node=>node.geometry.documentId===geometry.documentId&&(node.kind==='initial'||node.kind==='workbench'));
}

export function pesElectronicSourceKey(group: PesGroup, geometry: PesGeometry): string {
  const members=electronicInventorySignature(geometry.structure);
  const editable=pesEditableElectronicNode(group,geometry), source=geometry.source;
  const owner=geometry.inputSnapshotId ? ['snapshot',geometry.inputSnapshotId]
    : editable ? ['model',editable.id,geometry.structure.id]
    : source?.runId ? ['run',source.groupId,source.nodeId,source.runId,source.seriesId,source.frameId,source.recordId]
    : ['source',source?.groupId,source?.nodeId,geometry.originFrame??[geometry.documentId,geometry.revision]];
  return JSON.stringify([group.id, owner, members]);
}

export function pesElectronicDraft(group: PesGroup, geometry: PesGeometry) {
  const electronic=group.electronic;
  const key=pesElectronicSourceKey(group,geometry);
  const saved=electronic.drafts?.[key];
  if(electronic.pendingUnscopedEdit || electronic.sourceKey===key || !electronic.drafts && pesEditableElectronicNode(group,geometry)?.id===group.initialNodeId)
    return {charge:electronic.charge,multiplicity:electronic.multiplicity};
  if(saved)return saved;
  const {charge,multiplicity}=initialBaseElectronicState(geometry.structure);
  return {charge:String(charge),multiplicity:String(multiplicity)};
}

export function pesElectronicConfirmation(group: PesGroup, geometry: PesGeometry) {
  const {charge,multiplicity}=pesElectronicDraft(group,geometry);
  const key=pesElectronicSourceKey(group,geometry);
  const confirmed=group.electronic.confirmationHistory?.[JSON.stringify([key,Number(charge),Number(multiplicity)])];
  if(confirmed?.charge===Number(charge) && confirmed.multiplicity===Number(multiplicity))return confirmed;
  const source=geometry.source;
  const run=source?.groupId===group.id&&source.runId&&group.runs[source.runId];
  if(!run||run.nodeId!==source?.nodeId||!source.frameId||!run.workerSettled||
    Number(charge)!==run.request.charge||Number(multiplicity)!==run.request.uhf+1||
    geometry.structure.charge!==run.request.charge||geometry.structure.multiplicity!==run.request.uhf+1)return;
  const frames=source.recordId?run.result?.pathRecords?.find(record=>record.id===source.recordId)?.frames:run.result?.frames;
  if(frames?.some(frame=>frame.id===source.frameId&&frame.seriesId===source.seriesId))
    return {charge:run.request.charge,multiplicity:run.request.uhf+1};
}

export function pesElectronicConfirmed(group: PesGroup, geometry: PesGeometry): boolean {
  return pesElectronicConfirmation(group,geometry)!==undefined;
}

export function savePesElectronicDraft(electronic: PesGroup['electronic'], key: string,
  draft: { charge: string; multiplicity: string }, confirmed?: BaseElectronicStateValues): PesGroup['electronic'] {
  const {charge,multiplicity}=draft;
  const receiptKey=JSON.stringify([key,Number(charge),Number(multiplicity)]);
  const confirmationHistory={...electronic.confirmationHistory};
  if(confirmed)confirmationHistory[receiptKey]=confirmed;
  else delete confirmationHistory[receiptKey];
  return {charge,multiplicity,confirmed,sourceKey:key,confirmationHistory,drafts:{...electronic.drafts,[key]:{charge,multiplicity}}};
}

export function hasSuccessfulWorkbenchResult(run: Pick<PesRun, 'request' | 'status' | 'result' | 'error'> | undefined): boolean {
  if (!run || run.status !== 'completed' || run.error || !run.result ||
    !['completed', 'converged'].includes(run.result.status) || !['ts', 'hessian'].includes(run.request.operation)) return false;
  const hessian = run.result.hessian as {frameId?:string; projectedDegreesOfFreedom?:number; vibrationalDegreesOfFreedom?:number} | undefined;
  const frequencies = run.result.frequencies;
  const frequencyResult = Array.isArray(frequencies) && (frequencies.length > 0 || hessian?.vibrationalDegreesOfFreedom === 0 ||
    hessian?.projectedDegreesOfFreedom === 0 && hessian.vibrationalDegreesOfFreedom === undefined);
  return frequencyResult && !!hessian?.frameId && run.result.frames.some(frame => frame.id === hessian.frameId);
}

export class PesCompositionChange extends Error {
  constructor(readonly groupId: string, readonly atomCount: number, readonly existingAtomCounts: readonly number[],
    readonly conflictingResults: readonly { atomCount: number; label: string }[],
    readonly continueInNewGroup: () => PesNode) {
    const results = conflictingResults.map(result => `${result.label}（${result.atomCount} 个原子）`).join('、');
    super(`本次输入有 ${atomCount} 个原子。本组已有结果 ${results}。是否在新势能面组继续本次计算？`);
    this.name = 'PesCompositionChange';
  }
}

export class PesSubmissionChanged extends Error {
  constructor() {
    super('输入或任务已变化，请从当前计算卡或结构重新提交。');
    this.name = 'PesSubmissionChanged';
  }
}
