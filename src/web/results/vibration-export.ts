import type { Structure } from '../../core/types';
import type { ResultFrameSummary, TrajectoryResult } from '../../results/contracts';
import { assertResultNotAborted } from '../../results/contracts';
import { displacedVibrationStructure } from '../../results/vibrations';
import type { VibrationMode } from '../../results/scientific-contracts';

export interface VibrationExportSnapshot { mode: VibrationMode; amplitude: number; phase: number; frameIndex: number; baseStructure: Structure }
/** A derived result carries its own coordinates and never the parent's computed energy. */
export function vibrationExportResult(parent: TrajectoryResult, snapshot: VibrationExportSnapshot, animation: boolean): TrajectoryResult {
  const groups = parent.scientific?.vibrationSets?.length ? parent.scientific.vibrationSets : parent.scientific?.vibrations ? [parent.scientific.vibrations] : [];
  if (!groups.some(group => group.frameIndex === snapshot.frameIndex && group.modes.some(mode => mode.index === snapshot.mode.index && mode.sourceLine === snapshot.mode.sourceLine))) throw new Error('振动模式与来源几何帧归属不符。');
  const count = animation ? 30 : 1;
  const phase = (index: number) => animation ? Math.sin(index / count * 2 * Math.PI) : snapshot.phase;
  const frames: ResultFrameSummary[] = Array.from({ length: count }, (_, index) => ({ index, sourceStep: null, time: null, energy: null, convergence: [], sourceLine: snapshot.mode.sourceLine,
    label: `模式 ${snapshot.mode.index} · 显示相位 ${phase(index).toFixed(6)}（非物理时间）` }));
  const initialStructure = displacedVibrationStructure(snapshot.baseStructure, snapshot.mode, snapshot.amplitude, phase(0));
  return { ...parent, id: `${parent.id}:vibration:${snapshot.mode.index}`, label: `${parent.label}-vibration-mode-${snapshot.mode.index}`, kind: 'calculation', scientific: undefined,
    messages: [`来源作业 ${parent.jobIndex + 1}，几何帧 ${snapshot.frameIndex + 1}，模式 ${snapshot.mode.index}，频率 ${snapshot.mode.frequency} cm⁻¹，模式源行 ${snapshot.mode.sourceLine}。`,
      `显示振幅 ${snapshot.amplitude} Å；${animation ? '30 等相位样本覆盖一个显示周期；' : ''}派生位移未重新计算，不附母结构能量、收敛或物理时间。`], frames, initialStructure,
    async getFrame(index, signal) { assertResultNotAborted(signal); if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error('振动导出帧号无效。'); return displacedVibrationStructure(snapshot.baseStructure, snapshot.mode, snapshot.amplitude, phase(index)); },
    dispose() { /* Source lifetime remains with the original result. */ },
  };
}
