import type { Structure } from '../core/types';
import { atomicNumber } from '../core/elements';
import type { VibrationMode } from './scientific-contracts';

export const MAX_VIBRATION_AMPLITUDE_ANGSTROM = 10;

function validateDisplacement(amplitudeAngstrom: number, phase: number): void {
  if (!Number.isFinite(amplitudeAngstrom) || amplitudeAngstrom < 0 || amplitudeAngstrom > MAX_VIBRATION_AMPLITUDE_ANGSTROM) {
    throw new Error(`振动显示振幅须为0–${MAX_VIBRATION_AMPLITUDE_ANGSTROM} Å。`);
  }
  if (!Number.isFinite(phase) || Math.abs(phase) > 1) throw new Error('振动相位须为[-1,1]的有限数。');
}

/** Display displacement only. Amplitude is the largest atom displacement in Å at phase=1. */
export function displacedVibrationStructure(structure: Structure, mode: VibrationMode, amplitudeAngstrom: number, phase = 1): Structure {
  validateDisplacement(amplitudeAngstrom, phase);
  return prepareCartesianVibration(structure, mode).derive(amplitudeAngstrom, phase);
}

export function prepareCartesianVibration(structure: Structure, mode: VibrationMode) {
  if (!structure.atoms.length || structure.atoms.some(atom => !atomicNumber(atom.element) || ![atom.x, atom.y, atom.z].every(Number.isFinite))) {
    throw new Error('振动显示需要完整真实原子与有限Å坐标。');
  }
  const vectors = mode.displacements;
  if (!vectors || vectors.length !== structure.atoms.length || vectors.some(vector => !Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite))) {
    throw new Error('正常模式向量缺失、形状不符或含非有限数。');
  }
  if (mode.atomElements && (mode.atomElements.length !== structure.atoms.length || mode.atomElements.some((element, index) => element !== structure.atoms[index].element))) {
    throw new Error('振动模式逐序元素身份与结构不符。');
  }
  // Scale before norm calculation so finite large/small vectors cannot overflow/underflow.
  let largestComponent = 0;
  for (const vector of vectors) for (const component of vector) largestComponent = Math.max(largestComponent, Math.abs(component));
  if (largestComponent === 0) throw new Error('全零正常模式不能生成振动位移。');
  const scaled = vectors.map(vector => vector.map(value => value / largestComponent));
  const maxNorm = scaled.reduce((norm, vector) => Math.max(norm, Math.hypot(...vector)), 0);
  const base = structuredClone(structure);
  base.name = `${structure.name} · 振动模式 ${mode.index} 显示位移`;
  // Source metadata describes the parent calculation, never a continuation-ready derived frame.
  delete base.gaussianSource; delete base.gaussianSources; delete base.orcaSource;
  delete base.preparation; delete base.molfile; delete base.layout2D;
  function sampleAtoms(amplitudeAngstrom: number, phase: number) {
    validateDisplacement(amplitudeAngstrom, phase);
    const amount = amplitudeAngstrom * phase / maxNorm;
    return base.atoms.map((atom, index) => {
      const x = atom.x + scaled[index][0] * amount, y = atom.y + scaled[index][1] * amount, z = atom.z + scaled[index][2] * amount;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('振动位移后的坐标超出有限数范围。');
      return { ...atom, x, y, z };
    });
  }
  function derivedMetadata(amplitudeAngstrom: number, phase: number) {
    return {
      id: `${structure.id}:vibration:${mode.index}:amplitude:${amplitudeAngstrom}:phase:${phase}`,
      notes: [
        `派生自 ${structure.name}（${structure.id}），模式 ${mode.index}，源行 ${mode.sourceLine}，原始频率 ${mode.frequency} cm⁻¹。`,
        `正常模式完整向量归一化；最大原子显示位移 ${amplitudeAngstrom} Å，相位 ${phase}。此振幅仅供显示。`,
        '派生几何未重新计算；不继承母结构的收敛、驻点频率或CHK可续算承诺。',
        ...(mode.atomElements ? [] : ['模式未持有逐序元素身份；本次只保证向量形状，调用方须保证模式来自该结构帧。']),
      ],
    };
  }
  const playbackBase = {...base, ...derivedMetadata(0, 1)};
  return {
    base: playbackBase,
    vectors: scaled.map(vector => vector.map(value => value / maxNorm) as [number, number, number]),
    sample(amplitudeAngstrom: number, phase: number): Structure {
      return { ...playbackBase, atoms: sampleAtoms(amplitudeAngstrom, phase) };
    },
    derive(amplitudeAngstrom: number, phase: number): Structure {
      return { ...base, ...derivedMetadata(amplitudeAngstrom, phase), atoms: sampleAtoms(amplitudeAngstrom, phase) };
    },
  };
}
