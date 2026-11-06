import type { DocumentStamp, ModelCoordinate } from '../../modeling/contracts';
import type { DynamicsTermination, GeometryTargetStatus } from '../../modeling/dynamics/contracts';

export type OptimizationChoice = 'auto' | 'UFF' | 'MMFF94' | 'geometry';
export type OptimizationScope = 'all' | 'selection' | 'unselected';
export interface OptimizationFailure {
  origin: 'native' | 'host' | 'controller' | 'transport'; code: string; message: string;
  stage: 'before-first-frame' | 'after-frame'; sessionId: string;
  stamp: DocumentStamp; operation: 'md' | 'optimize' | 'geometry';
  coordinatesAccepted: boolean; atomIds?: string[];
  identityVerified: boolean;
  movableAtomIds: string[]; constraints: ModelCoordinate[];
}
export interface OptimizationRuntimeState {
  status: string; sessionId?: string; mode?: 'md' | 'optimize' | 'geometry';
  error?: string; terminalFailure?: OptimizationFailure;
  lastFrame?: { forcefield?: string; engine?: string; converged?: boolean; reason?:string; geometryTargetStatus?:GeometryTargetStatus; hybridGeometry?: { mode: 'partial-uff-local' | 'geometry-only' } };
}
export interface OptimizationCapture {
  stamp: DocumentStamp; movableAtomIds: string[];
  constraints: ModelCoordinate[];
  assertCurrent(): void;
}
export interface OptimizationCoordinatorDependencies {
  capture(scope: OptimizationScope): OptimizationCapture;
  runtime: {
    getSnapshot(): OptimizationRuntimeState;
    subscribe(listener: () => void): () => void;
    start(mode: 'optimize' | 'geometry', config: { maxSteps?: number; movableAtomIds: string[]; forcefield?: 'auto' | 'UFF' | 'MMFF94'; geometryMode?: 'hybrid-local'; hybridScalePolicy?: 'uff-bond-stiffness-v1'; allowPureGeometryFallback?: true }): Promise<void>;
    waitForTermination(sessionId?: string): Promise<DynamicsTermination>;
  };
  notice(text: string): void;
  failure(value: OptimizationFailure | undefined): void;
}
const terminal = (status: string) => ['completed', 'stopped', 'error'].includes(status);
const sameStamp = (a: DocumentStamp, b: DocumentStamp) => a.documentId === b.documentId && a.revision === b.revision && a.graphFingerprint === b.graphFingerprint && a.coordinatesFingerprint === b.coordinatesFingerprint && a.constraintsFingerprint === b.constraintsFingerprint;
function mechanicalCompletionNotice(state: OptimizationRuntimeState): string | undefined {
  const frame = state.lastFrame, target = frame?.geometryTargetStatus;
  if (!target) return undefined;
  const missing = target.untargetedCoordinationCount ? `${target.untargetedCoordinationCount}条配位连接缺少可靠距离目标` : '';
  const fixed = target.unresolvedImmovableConnectionCount ? `${target.unresolvedImmovableConnectionCount}条距离目标受冻结、当前范围或固定晶胞限制` : '';
  const unresolved = [missing,fixed].filter(Boolean).join('；');
  if (frame?.reason === 'no-targets' || target.status === 'no-targets') return `机械调整未执行：当前范围没有可调整的几何目标${unresolved ? `；${unresolved}` : ''}。`;
  const prefix = frame?.converged === false ? '机械调整达到步数上限，保留最后已接受的几何' : '机械调整已结束';
  if (target.status === 'partial-targets') return `${prefix}；${unresolved}。`;
  if (target.status === 'collision-only') return `${prefix}，仅处理近距离碰撞，未设置连接距离目标。`;
  return frame?.converged === false ? `${prefix}，尚未收敛。` : '机械调整已完成（几何目标，非物理势能）。';
}

/** The explicitly approved AUTO route may use mechanical geometry when native
 * force-field construction fails. Raw errors stay visible; no message parsing,
 * graph/charge repair or scientific force-field substitution occurs here. */
export function permitsMechanicalFallback(choice: OptimizationChoice, failure: OptimizationFailure | undefined, capture: OptimizationCapture): boolean {
  return choice === 'auto' && !!failure && failure.origin === 'native' && failure.operation === 'optimize'
    && ['parameterization', 'fractional-parameterization', 'sanitization'].includes(failure.code)
    && failure.identityVerified === true && failure.stage === 'before-first-frame' && failure.coordinatesAccepted === false
    && sameStamp(failure.stamp, capture.stamp) && JSON.stringify(failure.movableAtomIds) === JSON.stringify(capture.movableAtomIds)
    && JSON.stringify(failure.constraints) === JSON.stringify(capture.constraints);
}

export function createOptimizationCoordinator(deps: OptimizationCoordinatorDependencies) {
  let epoch = 0, pending = false, cancelPhase: (() => void) | undefined;
  const assertEpoch = (own: number) => { if (own !== epoch) throw new Error('优化期间文档或活动工具上下文已变化，未继续运行。'); };
  async function phase(mode: 'optimize' | 'geometry', choice: OptimizationChoice, capture: OptimizationCapture, own: number, maxSteps: number, hybrid = false): Promise<OptimizationRuntimeState> {
    assertEpoch(own); capture.assertCurrent();
    let currentSession: string | undefined, unsubscribe = () => {};
    let resolveTerminal!: (state: OptimizationRuntimeState) => void, rejectTerminal!: (cause: Error) => void;
    const done = new Promise<OptimizationRuntimeState>((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
    void done.catch(() => {});
    cancelPhase = () => rejectTerminal(new Error('优化期间文档或活动上下文已变化，未继续运行。'));
    const check = () => {
      const state = deps.runtime.getSnapshot();
      if (state.mode === mode && state.status === 'starting') currentSession = state.sessionId;
      if (currentSession && state.sessionId === currentSession && terminal(state.status)) resolveTerminal(state);
    };
    unsubscribe = deps.runtime.subscribe(check);
    try {
      await deps.runtime.start(mode, { maxSteps, movableAtomIds: [...capture.movableAtomIds], ...(mode === 'optimize' ? { forcefield: choice === 'geometry' ? 'auto' : choice } : hybrid ? { geometryMode: 'hybrid-local' as const, hybridScalePolicy: 'uff-bond-stiffness-v1' as const, allowPureGeometryFallback: true as const } : {}) });
      check();
      const result = await done; assertEpoch(own); return result;
    } finally { unsubscribe(); cancelPhase = undefined; }
  }
  return {
    get busy() { return pending; },
    cancel() { epoch++; cancelPhase?.(); },
    async run(choice: OptimizationChoice, scope: OptimizationScope, maxSteps = 500): Promise<void> {
      if (pending) throw new Error('当前优化尚未结束，请先Stop并等待确认。');
      const own = ++epoch; pending = true;
      try {
        const capture = deps.capture(scope); capture.assertCurrent(); deps.failure(undefined);
        const initial = choice === 'geometry' ? 'geometry' : 'optimize';
        deps.notice(initial === 'geometry' ? '正在运行机械调整（几何目标，不表示物理势能）。' : `正在运行${choice === 'auto' ? '自动力场' : choice}优化。`);
        let result = await phase(initial, choice, capture, own, maxSteps), fallbackNotice = '';
        if (result.status === 'error' && permitsMechanicalFallback(choice, result.terminalFailure, capture)) {
          const rejected = result.terminalFailure!;
          // Error publication can precede the release receipt. Require the
          // controller-session-release settled gate; this is not OS exit proof.
          const receipt = await deps.runtime.waitForTermination(rejected.sessionId); assertEpoch(own); capture.assertCurrent();
          if (receipt.sessionId !== rejected.sessionId || receipt.status !== 'settled' || receipt.scope !== 'controller-session-release') throw new Error('原力场会话释放回执不匹配，未启动机械调整。');
          const latest = deps.runtime.getSnapshot();
          if (latest.status !== 'error' || latest.sessionId !== rejected.sessionId || latest.terminalFailure !== rejected) throw new Error('力场失败身份已变化，未启动机械调整。');
          deps.failure(rejected);
          fallbackNotice = `完整力场未能建立，正在尝试局部机械＋外围UFF。原错误 [${rejected.code}] ${rejected.message}`;
          deps.notice(fallbackNotice);
          result = await phase('geometry', 'geometry', capture, own, maxSteps, true);
        }
        if (result.status === 'error') {
          deps.failure(result.terminalFailure);
          const localized: Record<string,string> = {
            'bond-type': '当前辅助或配位连接不支持此力场入口，未改动连接表。',
            'hybrid-trusted-partition': '无法可靠隔离当前异常区域，未提交未验证的力场结果。',
            'hybrid-typing-isolation': '局部力场参数隔离未通过核验，未提交不可信结果。',
            'hybrid-nonfinite': '局部优化出现非有限目标或梯度，已停止。',
            'hybrid-local-fixed-overlap': '重叠位置受冻结限制，无法安全整理。',
            'hybrid-local-overlap': '未找到满足冻结与立体约束的安全消重叠步骤。',
            'hybrid-outside-overlap': '可信力场区域有完全重叠原子，无法安全启动。',
            'hybrid-scale-reference': '仍有可信UFF项，但缺少可靠的混合定标参考；未将这些力场项丢弃为纯几何。',
            'hybrid-complexity': '当前连接过于密集，已达到局部力场参数核查预算，未提交不完整结果。',
          };
          throw new Error(localized[result.terminalFailure?.code ?? ''] || result.error || result.terminalFailure?.message || '优化失败。');
        }
        const pure = result.lastFrame?.hybridGeometry?.mode === 'geometry-only';
        if (result.status === 'stopped') deps.notice(`${pure ? '纯几何整理' : fallbackNotice ? '局部机械＋外围UFF预优化' : '优化'}已停止，保留最后已接受的几何。`);
        if (result.status === 'completed') deps.notice(mechanicalCompletionNotice(result) ?? (pure ? '纯几何整理已完成（无法建立可信UFF混合目标，非物理势能）。' : fallbackNotice ? '局部机械＋外围UFF预优化已完成。' : result.mode === 'geometry' ? '机械调整已完成（几何目标，非物理势能）。' : `力场优化已完成；实际力场 ${result.lastFrame?.forcefield ?? (choice === 'auto' ? '以原生结果为准' : choice)}${result.lastFrame?.engine ? ' · ' + result.lastFrame.engine : ''}。`));
      } catch (cause) {
        deps.notice(`预优化未完成：${cause instanceof Error ? cause.message : String(cause)}`);
        throw cause;
      } finally { pending = false; }
    },
  };
}
