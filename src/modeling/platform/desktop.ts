import type { ChemistryPort, ChemistryRequest, ChemistryJob, DesktopBridge, EmpiricalFrameBondJob } from '../contracts';
import {traceTrajectoryOperation} from '../../results/trajectory-operations';

/** The same headless chemistry port used by the model core; no renderer filesystem access. */
export class DesktopChemistryPort implements ChemistryPort {
  constructor(private readonly bridge: DesktopBridge) {}
  async capabilities() {
    const info = await this.bridge.info();
    return { engine: 'native-desktop', native: info.nativeChemistry,
      operations: info.nativeChemistry ? ['generate3d', 'perceive-bonds', 'convert'] as const : [] } as Awaited<ReturnType<ChemistryPort['capabilities']>>;
  }
  startEmpiricalFrame(request: ChemistryRequest): EmpiricalFrameBondJob {
    if (!this.bridge.runEmpiricalFrameBonds) return this.start(request);
    const jobId = crypto.randomUUID(), { stamp, movableAtomIds } = request;
    const promise = this.bridge.runEmpiricalFrameBonds(request, jobId).then(receipt => {
      if (receipt.kind !== 'empirical-frame-graph-v1' || receipt.jobId !== jobId
        || receipt.documentId !== stamp.documentId || receipt.revision !== stamp.revision)
        throw new Error('经验判断回执与当前帧身份不一致。');
      // The exact stamp and ordered atoms belong to the request associated
      // with this IPC invocation and resident-worker receipt.
      return { ...receipt, stamp, movableAtomIds };
    });
    return { promise, cancel: () => { void this.bridge.cancelChemistry(jobId); } };
  }
  start(request: ChemistryRequest): ChemistryJob {
    const jobId = crypto.randomUUID();
    const invoke=()=>this.bridge.runChemistry(request,jobId);
    return { promise: request.operation==='perceive-bonds'?invoke():traceTrajectoryOperation('quantum',{sourceId:request.structure.id},invoke), cancel: () => { void this.bridge.cancelChemistry(jobId); } };
  }
}
export function desktopBridge(): DesktopBridge | null {
  return typeof window === 'undefined' ? null : window.sciyueDesktop ?? null;
}
export function createDesktopChemistryPort(bridge: DesktopBridge | null = desktopBridge()): DesktopChemistryPort | null {
  return bridge ? new DesktopChemistryPort(bridge) : null;
}

/** Narrow capability detection; loading a page never creates a surface/native session. */
export function hasDesktopSurfaceBridge(bridge: DesktopBridge | null = desktopBridge()): boolean {
  return Boolean(bridge?.surfaceCapabilities && bridge.openSurfaceSession && bridge.analyzeSurface && bridge.surfaceRegion && bridge.generateSurface && bridge.surfaceDistribution && bridge.cancelSurface && bridge.closeSurfaceSession);
}
