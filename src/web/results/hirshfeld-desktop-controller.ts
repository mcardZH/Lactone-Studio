import type { HirshfeldAnalysisResult, HirshfeldAnalyzeRequest, HirshfeldCluster, HirshfeldCubeExportRequest, HirshfeldOpenRequest, HirshfeldRestoreRequest, HirshfeldSessionInfo } from '../../results/hirshfeld-contracts';
import { validateHirshfeldAnalysisResult, validateHirshfeldCluster } from '../../results/hirshfeld-field';
import type { SurfaceContext } from '../../results/surface-contracts';
import type { MultiwfnProgressSnapshot } from '../../results/multiwfn-progress';
import { sameSurfaceContext } from '../../results/surface-field';
import type { OrbitalResourceInfo } from '../../results/orbital-contracts';
import type { HirshfeldControlsState } from './hirshfeld-controls-contracts';
import type {ComputeResourcePreferencesBridge} from '../../modeling/resource-preferences';

export interface HirshfeldDesktopApi extends Partial<ComputeResourcePreferencesBridge> {
  openHirshfeldSession?(request: HirshfeldOpenRequest): Promise<HirshfeldSessionInfo>;
  analyzeHirshfeld?(sessionId: string, request: HirshfeldAnalyzeRequest): Promise<HirshfeldAnalysisResult>;
  restoreHirshfeldFields?(sessionId: string, request: HirshfeldRestoreRequest): Promise<HirshfeldAnalysisResult>;
  exportHirshfeldCube?(sessionId: string, request: HirshfeldCubeExportRequest): Promise<{ saved: boolean; cancelled?: boolean }>;
  cancelSurface?(sessionId: string): Promise<{ cancelled: boolean }>;
  closeSurfaceSession?(sessionId: string): Promise<{ closed: boolean }>;
  onMultiwfnProgress?(listener: (snapshot: MultiwfnProgressSnapshot) => void): () => void;
  orbitalResourceInfo?(): Promise<OrbitalResourceInfo>;
}
const aborted = () => new DOMException('Hirshfeld分析已取消。', 'AbortError');
export function hirshfeldResourceRequest(draft: HirshfeldControlsState['resourceDraft'], defaults?: OrbitalResourceInfo | null): { threads: number; memoryBudgetBytes: number } | undefined {
  if (!draft.custom) return undefined;
  if (!defaults) throw new Error('请先读取本机资源配置。');
  if (!Number.isSafeInteger(draft.threads) || draft.threads! < 1 || draft.threads! > defaults.logicalCpuCount) throw new Error(`线程数须为1至${defaults.logicalCpuCount}之间的整数。`);
  const bytes = draft.memoryGiB === null ? NaN : Math.round(draft.memoryGiB * 1024 ** 3);
  if (!Number.isFinite(draft.memoryGiB) || draft.memoryGiB! <= 0 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > defaults.totalPhysicalMemoryBytes) throw new Error('内存预算须为正数，且不超过本机物理内存。');
  return { threads: draft.threads!, memoryBudgetBytes: bytes };
}
export function assertHirshfeldResourceInfo(info: HirshfeldSessionInfo, phase: 'open-grant' | 'analysis-grant'): void {
  const value = info.resources;
  if (info.resourceSnapshot !== phase || !value || !Number.isSafeInteger(value.threads) || value.threads < 1
    || ![value.configuredMemoryBudgetBytes, value.memoryBudgetBytes].every(bytes => Number.isSafeInteger(bytes) && bytes > 0)
    || !Number.isSafeInteger(value.sharedReservedBytes) || value.sharedReservedBytes < 0
    || value.memoryBudgetBytes + value.sharedReservedBytes !== value.configuredMemoryBudgetBytes) throw new Error('Hirshfeld会话缺少对应阶段的实际资源预算回执。');
}
export interface HirshfeldCompletedSession { sessionId: string; result: HirshfeldAnalysisResult; sessionInfo: HirshfeldSessionInfo; exportField(role: 'shape' | 'mapping'): Promise<void>; close(): Promise<void> }
/** Each explicit run owns a new native session. Cancellation cannot invalidate
 * a previously accepted generation and its original scientific Cube exports. */
export function createHirshfeldRun(desktop: HirshfeldDesktopApi, cluster: HirshfeldCluster, context: SurfaceContext,
  analysisId: string, sessionId: string, request: HirshfeldAnalyzeRequest,
  options?: { resources?: { threads: number; memoryBudgetBytes: number }; onSessionInfo?(info: HirshfeldSessionInfo): void }) {
  let stopped = false, opened = false, settled = false, closePromise: Promise<void> | null = null;
  const close = () => closePromise ??= (async () => { if (opened) { await desktop.closeSurfaceSession?.(sessionId); opened = false; } })();
  return {
    sessionId,
    async run(): Promise<HirshfeldCompletedSession> {
      validateHirshfeldCluster(cluster, request);
      if (!desktop.openHirshfeldSession || !desktop.analyzeHirshfeld || !desktop.closeSurfaceSession || !desktop.cancelSurface) throw new Error('当前环境没有Hirshfeld分析入口。');
      try {
        if (stopped) throw aborted();
        const info = await desktop.openHirshfeldSession({ sessionId, source: { kind: 'hirshfeld-cluster', context, cluster }, ...(options?.resources ? { resources: { ...options.resources } } : {}) }); opened = true;
        if (stopped) throw aborted();
        if (info.sessionId !== sessionId || info.family !== 'hirshfeld' || info.atomCount !== cluster.atoms.length || !sameSurfaceContext(info.context, context)) throw new Error('Hirshfeld会话来源不匹配。');
        assertHirshfeldResourceInfo(info, 'open-grant'); options?.onSessionInfo?.(info);
        const result = await desktop.analyzeHirshfeld(sessionId, request);
        if (stopped) throw aborted();
        validateHirshfeldAnalysisResult(result, request);
        if (result.sessionInfo.sessionId !== sessionId || !sameSurfaceContext(result.sessionInfo.context, context)) throw new Error('Hirshfeld实际运行资源回执属于其他会话。');
        assertHirshfeldResourceInfo(result.sessionInfo, 'analysis-grant'); settled = true;
        return { sessionId, result, sessionInfo: result.sessionInfo, close,
          async exportField(role) {
            if (!opened || !desktop.exportHirshfeldCube) throw new Error('当前Hirshfeld原始Cube会话已不可用。');
            await desktop.exportHirshfeldCube(sessionId, { stamp: { ...context, analysisId, requestId: `${request.stamp.requestId}-export-${role}` }, fieldId: result.pair[role].id });
          } };
      } catch (error) { await close(); throw error; }
    },
    async cancel() { stopped = true; if (opened && !settled) await desktop.cancelSurface?.(sessionId); if (opened) await close(); },
  };
}
