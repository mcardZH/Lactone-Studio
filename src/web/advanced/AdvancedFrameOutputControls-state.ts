import type { AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import { prepareAdvancedFrameInputs, prepareAdvancedFrameTrajectory, prepareAdvancedFrameTrajectoryStream,
  type AdvancedFrameOutputPlan, type AdvancedFrameStreamPlan, type AdvancedInputTemplate } from '../../modeling/application/advanced-frame-output';
import type { AdvancedOutputBinaryBridge, AdvancedOutputBridge, AdvancedOutputManifest, AdvancedOutputPartial } from '../../modeling/advanced/output-contracts';
import {pairEditedElectronicState,type ElectronicStateEditField} from '../../core/base-electronic-state';

export interface AdvancedFrameOutputCandidate { id: string; source: AdvancedFrameSource }
/** Candidate collection position, independent from checked output order. */
export const advancedOutputCandidateLabel = (candidate: AdvancedFrameOutputCandidate, candidateIndex: number) => `第 ${candidateIndex + 1} 帧 · ${candidate.source.label}`;
export interface AdvancedFrameOutputRow { sourceKey: string; stem: string; charge: string; multiplicity: string; confirmed: boolean; lastEditedField?:ElectronicStateEditField; pairingIssue?:string|null }
export interface AdvancedFrameOutputDraft {
  selectedIds: readonly string[]; rows: Readonly<Record<string, AdvancedFrameOutputRow>>;
  mode: 'inputs' | 'trajectory'; format: 'xyz' | 'extxyz'; stem: string; directoryName: string;
}
export const initialAdvancedFrameOutputDraft = (): AdvancedFrameOutputDraft => ({ selectedIds: [], rows: {}, mode: 'trajectory', format: 'xyz', stem: 'frames', directoryName: 'advanced-frames' });
export const advancedOutputSourceKey = (source: AdvancedFrameSource) => JSON.stringify([source.ref, source.stamp, source.coordinateUnit]);
export function reconcileAdvancedFrameOutput(candidates: readonly AdvancedFrameOutputCandidate[], draft: AdvancedFrameOutputDraft): AdvancedFrameOutputDraft {
  const rows: Record<string, AdvancedFrameOutputRow> = {}, valid = new Set<string>(); let changed = Object.keys(draft.rows).length !== candidates.length;
  candidates.forEach((candidate, index) => {
    const key = advancedOutputSourceKey(candidate.source), old = draft.rows[candidate.id];
    if (old?.sourceKey === key) { rows[candidate.id] = old; valid.add(candidate.id); }
    else { changed = true; rows[candidate.id] = { sourceKey: key, stem: `frame_${String(index + 1).padStart(4, '0')}`,
      charge: String(candidate.source.structure.charge ?? ''), multiplicity: String(candidate.source.structure.multiplicity ?? ''), confirmed: false }; }
  });
  const selectedIds = draft.selectedIds.filter(id => valid.has(id));
  return changed || selectedIds.length !== draft.selectedIds.length ? { ...draft, rows, selectedIds } : draft;
}
export function selectAdvancedOutputFrame(draft: AdvancedFrameOutputDraft, id: string, checked: boolean): AdvancedFrameOutputDraft {
  if (!draft.rows[id]) return draft;
  return { ...draft, selectedIds: checked ? draft.selectedIds.includes(id) ? draft.selectedIds : [...draft.selectedIds, id] : draft.selectedIds.filter(value => value !== id) };
}
export function moveAdvancedOutputFrame(draft: AdvancedFrameOutputDraft, id: string, offset: -1 | 1): AdvancedFrameOutputDraft {
  const order = [...draft.selectedIds], index = order.indexOf(id), target = index + offset;
  if (index < 0 || target < 0 || target >= order.length) return draft;
  [order[index], order[target]] = [order[target], order[index]]; return { ...draft, selectedIds: order };
}
export function editAdvancedOutputFrame(draft: AdvancedFrameOutputDraft, id: string, patch: Partial<Omit<AdvancedFrameOutputRow, 'sourceKey'>>): AdvancedFrameOutputDraft {
  const row = draft.rows[id]; if (!row) return draft;
  const confirmationChanged = patch.stem !== undefined && patch.stem !== row.stem || patch.charge !== undefined && patch.charge !== row.charge || patch.multiplicity !== undefined && patch.multiplicity !== row.multiplicity;
  return { ...draft, rows: { ...draft.rows, [id]: { ...row, ...patch,
    ...(patch.charge!==undefined?{lastEditedField:'charge' as const,pairingIssue:null}:patch.multiplicity!==undefined?{lastEditedField:'multiplicity' as const,pairingIssue:null}:{}),
    ...(confirmationChanged ? { confirmed: false } : {}) } } };
}
export function commitAdvancedOutputFrame(candidates:readonly AdvancedFrameOutputCandidate[],draft:AdvancedFrameOutputDraft,id:string,field?:ElectronicStateEditField,text?:string):AdvancedFrameOutputDraft {
  const row=draft.rows[id],candidate=candidates.find(value=>value.id===id),edited=field??row?.lastEditedField;
  if(!row||!candidate||!edited||field&&row.lastEditedField!==field&&(text===undefined||text===row[field]))return draft;
  const raw={...row,...(text===undefined?{}:{[edited]:text})};
  if(!/^[+-]?\d+$/.test(raw.charge)||!/^\+?\d+$/.test(raw.multiplicity))return draft;
  const values={charge:Number(raw.charge),multiplicity:Number(raw.multiplicity)},result=pairEditedElectronicState(candidate.source.structure.atoms,values,edited,values[edited]);
  if(result.error)return {...draft,rows:{...draft.rows,[id]:{...raw,pairingIssue:result.error}}};
  const next=editAdvancedOutputFrame(draft,id,{charge:String(result.values.charge),multiplicity:String(result.values.multiplicity)});
  return {...next,rows:{...next.rows,[id]:{...next.rows[id],lastEditedField:undefined,pairingIssue:null}}};
}
export function advancedOutputDraftKey(candidates: readonly AdvancedFrameOutputCandidate[], draft: AdvancedFrameOutputDraft): string {
  const indexed = new Map(candidates.map(candidate => [candidate.id, candidate]));
  return JSON.stringify([draft.mode, draft.format, draft.stem, draft.directoryName, draft.selectedIds.map(id => [id, draft.rows[id],
    indexed.has(id) ? advancedOutputSourceKey(indexed.get(id)!.source) : null])]);
}
function selectedCandidates(candidates: readonly AdvancedFrameOutputCandidate[], draft: AdvancedFrameOutputDraft) {
  const indexed = new Map(candidates.map(row => [row.id, row]));
  if (indexed.size !== candidates.length || indexed.has('')) throw Error('候选帧身份重复或缺失。');
  return draft.selectedIds.map(id => {
    const candidate = indexed.get(id);
    if (!candidate) throw Error('已选帧已不在当前来源中，请重新选择。');
    return candidate;
  });
}
function validOutputDirectory(name: string) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name) && !name.endsWith('.') && !name.includes('..')
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
const invalidDirectoryMessage = '新目录名称须为安全ASCII名称，不能含路径或Windows保留名称。';
export async function prepareAdvancedOutputStreamDraft(candidates: readonly AdvancedFrameOutputCandidate[], draft: AdvancedFrameOutputDraft,
  current: () => boolean): Promise<{ plan: AdvancedFrameStreamPlan | null; errors: readonly string[] }> {
  try {
    if (!validOutputDirectory(draft.directoryName)) return { plan: null, errors: [invalidDirectoryMessage] };
    const chosen = selectedCandidates(candidates, draft);
    const plan = await prepareAdvancedFrameTrajectoryStream({ frames: chosen.map(row => row.source), format: draft.format, stem: draft.stem }, current);
    return { plan, errors: plan.errors };
  } catch (cause) {
    return { plan: null, errors: [cause instanceof Error ? cause.message : String(cause)] };
  }
}
export function prepareAdvancedOutputDraft(candidates: readonly AdvancedFrameOutputCandidate[], draft: AdvancedFrameOutputDraft, template?: AdvancedInputTemplate | null): { plan: AdvancedFrameOutputPlan | null; errors: readonly string[] } {
  let chosen;
  try { chosen = selectedCandidates(candidates, draft); }
  catch (cause) { return { plan: null, errors: [cause instanceof Error ? cause.message : String(cause)] }; }
  if (draft.mode === 'inputs' && !template) return { plan: null, errors: ['尚未提供当前 Gaussian / ORCA 输入模板。'] };
  const plan = draft.mode === 'trajectory' ? prepareAdvancedFrameTrajectory({ frames: chosen.map(row => row.source), format: draft.format, stem: draft.stem })
    : prepareAdvancedFrameInputs({ frames: chosen.map(candidate => { const row = draft.rows[candidate.id]; return { source: candidate.source, stem: row?.stem ?? '',
      electronicState: { charge: /^-?\d+$/.test(row?.charge ?? '') ? Number(row.charge) : NaN,
        multiplicity: /^\d+$/.test(row?.multiplicity ?? '') ? Number(row.multiplicity) : NaN, confirmed: row?.confirmed === true } }; }), template: template! });
  if (!validOutputDirectory(draft.directoryName)) {
    const errors = [...plan.errors, invalidDirectoryMessage];
    return { plan: { ...plan, ready: false, files: [], errors }, errors };
  }
  return { plan, errors: plan.errors };
}
export const supportsAdvancedOutputStream = (bridge: AdvancedOutputBridge | null): bridge is AdvancedOutputBridge & AdvancedOutputBinaryBridge =>
  !!(bridge?.beginBinaryAsset && bridge.appendBinaryAsset && bridge.sealBinaryAsset && bridge.releaseBinaryAsset);

/** The byte window is only a transport buffer. Every source chunk is drained. */
export async function stageAdvancedOutputFile(file: AdvancedFrameStreamPlan['files'][number], bridge: AdvancedOutputBinaryBridge,
  ownedIds: string[], current: () => boolean) {
  const { id } = await bridge.beginBinaryAsset();
  ownedIds.push(id);
  const ensureCurrent = () => { if (!current()) throw Error('输出条件已变化，请重新预检。'); };
  ensureCurrent();
  const encoder = new TextEncoder(), buffer = new Uint8Array(1024 * 1024);
  let buffered = 0, size = 0;
  async function flush() {
    if (!buffered) return;
    ensureCurrent();
    const appended = await bridge.appendBinaryAsset(id, buffer.subarray(0, buffered));
    size += buffered;
    if (appended.size !== size) throw Error('轨迹暂存字节数不一致。');
    buffered = 0;
    ensureCurrent();
  }
  for (const text of file.chunks()) {
    let offset = 0;
    while (offset < text.length) {
      const { read, written } = encoder.encodeInto(text.slice(offset), buffer.subarray(buffered));
      offset += read; buffered += written;
      if (offset < text.length || buffered === buffer.length) await flush();
    }
  }
  await flush();
  const sealed = await bridge.sealBinaryAsset(id);
  ensureCurrent();
  if (sealed.size !== size || !sealed.sha256 || !/^[a-f0-9]{64}$/.test(sealed.sha256)) throw Error('轨迹暂存校验失败。');
  return { assetId: id, name: file.name, bytes: size, sha256: sealed.sha256 };
}
/** Verify the host's sealed list against the entire prepared batch before a
 * write confirmation is enabled. File text remains the existing writer's data. */
export function assertAdvancedOutputManifest(plan: AdvancedFrameOutputPlan | AdvancedFrameStreamPlan, manifest: AdvancedOutputManifest,
  seals?: AdvancedOutputManifest['files']): void {
  const encoder = new TextEncoder();
  const expected = 'streamed' in plan ? seals : plan.files.map(file => ({ name: file.name, bytes: encoder.encode(file.text).byteLength, sha256: undefined }));
  if (!plan.ready || !expected || manifest.schema !== 'sciyue-advanced-output' || manifest.version !== 1 || manifest.files.length !== expected.length
    || manifest.files.some((file, index) => file.name !== plan.files[index].name || file.name !== expected[index].name || file.bytes !== expected[index].bytes
      || !/^[a-f0-9]{64}$/.test(file.sha256) || (expected[index].sha256 !== undefined && file.sha256 !== expected[index].sha256))
    || manifest.totalBytes !== expected.reduce((sum, file) => sum + file.bytes, 0)) throw new Error('目标确认回执与整批预检文件清单或字节数不一致。');
}
export function advancedOutputPartialLines(partial?: AdvancedOutputPartial): string[] {
  if (!partial) return [];
  return [`目录：${partial.directory}`, `目录已创建：${partial.directoryCreated ? '是' : '否'}`, `令牌已消费：${partial.tokenConsumed ? '是' : '否'}`,
    ...partial.written.map(file => `已写入：${file.name} · ${file.bytes} B · SHA256 ${file.sha256}`),
    ...(partial.partialFile ? [`部分文件：${partial.partialFile.name}${partial.partialFile.bytes === undefined ? '' : ` · ${partial.partialFile.bytes} B`}`] : [])];
}

/** Own only sealed, unconsumed host tokens. Dropping UI state never substitutes
 * for releasing a host reservation; consumption transfers it to write forever. */
export function createAdvancedOutputTokenOwner(onFailure: (message: string) => void) {
  type Entry = { bridge: AdvancedOutputBridge; status: 'selected' | 'releasing' | 'failed'; release?: Promise<boolean> };
  const tokens = new Map<string, Entry>();
  async function release(token: string, retry = false): Promise<boolean> {
    const entry = tokens.get(token); if (!entry) return true;
    if (entry.release) return entry.release;
    if (entry.status === 'failed' && !retry) return false;
    entry.status = 'releasing';
    entry.release = Promise.resolve().then(async () => {
      try {
        // false also confirms no live reservation: expired, unknown or consumed
        // tokens are idempotent no-ops at the trusted owner boundary.
        await entry.bridge.abandonAdvancedOutput(token); tokens.delete(token); return true;
      } catch (error) {
        entry.status = 'failed'; const detail = error instanceof Error ? error.message : String(error);
        onFailure(`目录确认释放失败，尚未写入文件；请重试释放：${detail}`); return false;
      }
    }).finally(() => { entry.release = undefined; });
    return entry.release;
  }
  return {
    retain(token: string, bridge: AdvancedOutputBridge) { if (!tokens.has(token)) tokens.set(token, { bridge, status: 'selected' }); },
    /** A stale/releasing/failed token can never become a new write. */
    consume(token: string) { const entry = tokens.get(token); if (!entry || entry.status !== 'selected') return false; tokens.delete(token); return true; },
    release,
    async releaseAll() { const results = await Promise.all([...tokens.keys()].map(token => release(token))); return results.every(Boolean); },
    async retryFailed() { const results = await Promise.all([...tokens].filter(([, entry]) => entry.status === 'failed').map(([token]) => release(token, true))); return results.every(Boolean); },
    hasFailures: () => [...tokens.values()].some(entry => entry.status === 'failed'),
    retainedCount: () => tokens.size,
  };
}
