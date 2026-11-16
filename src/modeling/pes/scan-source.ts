import type { PesCard, PesFrame, PesGeometry, PesGroup, PesSourceIdentity } from './contracts';
import { structureForPesFrame } from './controller';
import { pesPathRecords } from './path-records';

export interface ScanSourceChoice {
  key: string;
  label: string;
  category: '初始结构' | '已记录快照' | '工作台编辑结构' | '结果帧';
  source: Required<Pick<PesSourceIdentity, 'groupId' | 'nodeId'>> & PesSourceIdentity;
}
export const scanSourceKey = (value: Pick<PesGeometry, 'source'>) => JSON.stringify([
  value.source?.groupId, value.source?.nodeId, value.source?.runId, value.source?.seriesId, value.source?.frameId, value.source?.recordId,
]);

/** Menus consume identities and scalar frame indexes, never historical geometry. */
export function scanSourceChoices(group: PesGroup): ScanSourceChoice[] {
  const choices = new Map<string, ScanSourceChoice>();
  const add = (label: string, category: ScanSourceChoice['category'], source: ScanSourceChoice['source']) => {
    const key = scanSourceKey({ source });
    if (!choices.has(key)) choices.set(key, { key, label, category, source });
  };
  for (const node of group.nodes) {
    const source = { groupId: group.id, nodeId: node.id };
    if (node.id === group.initialNodeId) add(node.name === 'initial' ? 'initial' : `${node.name} · initial`, '初始结构', source);
    else if (node.kind === 'snapshot') add(node.name, '已记录快照', source);
    else if (node.kind === 'workbench') add(`${node.name} · 当前编辑结构`, '工作台编辑结构', source);
    for (const runId of node.runIds) {
      const run = group.runs[runId];
      if (!run || run.nodeId !== node.id) continue;
      const records=pesPathRecords(run),recorded=new Set(records.flatMap(record=>record.frames.map(frame=>JSON.stringify([frame.seriesId,frame.id]))));
      const frames = [...(run.result?.frames ?? run.acceptedFrames ?? []).filter(frame=>!recorded.has(JSON.stringify([frame.seriesId,frame.id]))).map(frame=>({frame,record:undefined})), ...records.flatMap(record => record.frames.map(frame=>({frame,record})))];
      for (const {frame,record} of frames) {
        const series = run.result?.series?.find(row => row.id === frame.seriesId)?.label ?? frame.phase ?? frame.seriesId;
        const position=record?`第 ${record.step} 轮`:`${run.request.operation === 'scan' ? '扫描点' : '帧'} ${frame.step + 1}`;
        const label = `${node.name} · ${series} · ${position}${typeof frame.bead === 'number' ? ` · 珠子 ${frame.bead}` : ''}`;
        add(label, '结果帧', { ...source, runId, seriesId: frame.seriesId, frameId: frame.id, ...(record?{recordId:record.id}:{}) });
      }
    }
  }
  return [...choices.values()];
}

function initialSource(group: PesGroup): PesGeometry {
  const node = group.nodes.find(row => row.id === group.initialNodeId);
  if (!node) throw Error('本组 initial 已不存在。');
  return { ...node.geometry, label: node.name, source: { groupId: group.id, nodeId: node.id } };
}

export function resolveScanSource(group: PesGroup, card: PesCard): PesGeometry {
  const selected = card.slots.start;
  if (!selected) {
    if (card.requiredSlots?.includes('start')) throw Error('请重新记录或选择起始结构。');
    return initialSource(group);
  }
  if (selected.inputSnapshotId) return selected;
  const source=selected.source,node=source?.groupId===group.id?group.nodes.find(row=>row.id===source.nodeId):undefined;
  if(!node||!source)throw Error('原来源已移除，请重选。');
  // Frame slots hold the independently read scientific geometry. Validation of
  // existence is index-only; committing a run never silently reloads a frame.
  if(source.frameId){
    const run=source.runId&&group.runs[source.runId];
    const matches=(frame:Pick<PesFrame,'id'|'seriesId'>)=>frame.id===source.frameId&&frame.seriesId===source.seriesId;
    if(!run||run.nodeId!==node.id||!node.runIds.includes(run.request.id)||!(source.recordId?pesPathRecords(run).some(record=>record.id===source.recordId&&record.frames.some(matches)):(run.result?.frames??run.acceptedFrames??[]).some(matches)||pesPathRecords(run).some(record=>record.frames.some(matches))))throw Error('原来源已移除，请重选。');
    return selected;
  }
  if(source.runId||source.seriesId||node.kind!=='initial'&&node.kind!=='snapshot'&&node.kind!=='workbench')throw Error('原来源已移除，请重选。');
  return { ...node.geometry, label: node.name, source: { groupId:group.id,nodeId:node.id } };
}

export async function readScanSource(group: PesGroup, key: string,
  readFrame: (runId: string, seriesId: string, frameId: string, recordId?:string) => Promise<PesFrame>): Promise<PesGeometry> {
  const choice = scanSourceChoices(group).find(row => row.key === key);
  if (!choice) throw Error('原来源已移除，请重选。');
  const node = group.nodes.find(row => row.id === choice.source.nodeId)!;
  const { runId, seriesId, frameId } = choice.source;
  if (!runId || !seriesId || !frameId) return { ...node.geometry, label: choice.label, source: choice.source };
  const run = group.runs[runId];
  const frame = await readFrame(runId, seriesId, frameId, choice.source.recordId);
  return { ...node.geometry, label: choice.label, source: choice.source, structure: structureForPesFrame(run.request.structure, frame) };
}
