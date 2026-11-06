import type { AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import { prepareAdvancedFrameInputs, prepareAdvancedFrameTrajectory, type AdvancedFrameOutputPlan, type AdvancedInputTemplate } from '../../modeling/application/advanced-frame-output';
import type { AdvancedOutputManifest, AdvancedOutputPartial } from '../../modeling/advanced/output-contracts';
import type { AdvancedOutputBridge } from '../../modeling/advanced/output-contracts';

export interface AdvancedFrameOutputCandidate { id: string; source: AdvancedFrameSource }
/** Candidate collection position, independent from checked output order. */
export const advancedOutputCandidateLabel = (candidate: AdvancedFrameOutputCandidate, candidateIndex: number) => `第 ${candidateIndex + 1} 帧 · ${candidate.source.label}`;
export interface AdvancedFrameOutputRow { sourceKey: string; stem: string; charge: string; multiplicity: string; confirmed: boolean }
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
  return { ...draft, rows: { ...draft.rows, [id]: { ...row, ...patch, ...(confirmationChanged ? { confirmed: false } : {}) } } };
}
export function advancedOutputDraftKey(candidates: readonly AdvancedFrameOutputCandidate[], draft: AdvancedFrameOutputDraft): string {
  return JSON.stringify([draft.mode, draft.format, draft.stem, draft.directoryName, draft.selectedIds.map(id => [id, draft.rows[id],
    candidates.find(candidate => candidate.id === id) ? advancedOutputSourceKey(candidates.find(candidate => candidate.id === id)!.source) : null])]);
}
export function prepareAdvancedOutputDraft(candidates: readonly AdvancedFrameOutputCandidate[], draft: AdvancedFrameOutputDraft, template?: AdvancedInputTemplate | null): { plan: AdvancedFrameOutputPlan | null; errors: readonly string[] } {
  if (new Set(candidates.map(row => row.id)).size !== candidates.length || candidates.some(row => !row.id)) return { plan: null, errors: ['候选帧身份重复或缺失。'] };
  const chosen = draft.selectedIds.map(id => candidates.find(row => row.id === id));
  if (chosen.some(row => !row)) return { plan: null, errors: ['已选帧已不在当前来源中，请重新选择。'] };
  if (draft.mode === 'inputs' && !template) return { plan: null, errors: ['尚未提供当前 Gaussian / ORCA 输入模板。'] };
  const plan = draft.mode === 'trajectory' ? prepareAdvancedFrameTrajectory({ frames: chosen.map(row => row!.source), format: draft.format, stem: draft.stem })
    : prepareAdvancedFrameInputs({ frames: chosen.map(candidate => { const row = draft.rows[candidate!.id]; return { source: candidate!.source, stem: row?.stem ?? '',
      electronicState: { charge: /^-?\d+$/.test(row?.charge ?? '') ? Number(row.charge) : NaN,
        multiplicity: /^\d+$/.test(row?.multiplicity ?? '') ? Number(row.multiplicity) : NaN, confirmed: row?.confirmed === true } }; }), template: template! });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(draft.directoryName) || draft.directoryName.endsWith('.') || draft.directoryName.includes('..')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(draft.directoryName)) {
    const errors = [...plan.errors, '新目录名称须为安全ASCII名称，不能含路径或Windows保留名称。'];
    return { plan: { ...plan, ready: false, files: [], errors }, errors };
  }
  return { plan, errors: plan.errors };
}
/** Verify the host's sealed list against the entire prepared batch before a
 * write confirmation is enabled. File text remains the existing writer's data. */
export function assertAdvancedOutputManifest(plan: AdvancedFrameOutputPlan, manifest: AdvancedOutputManifest): void {
  const encoder = new TextEncoder(), expected = plan.files.map(file => ({ name: file.name, bytes: encoder.encode(file.text).byteLength }));
  if (!plan.ready || manifest.schema !== 'sciyue-advanced-output' || manifest.version !== 1 || manifest.files.length !== expected.length
    || manifest.files.some((file, index) => file.name !== expected[index].name || file.bytes !== expected[index].bytes || !/^[a-f0-9]{64}$/.test(file.sha256))
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
