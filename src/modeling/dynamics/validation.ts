import type { Structure } from '../../core/types';
import { graphFingerprint } from '../../core/modeling/graph';
import { assertBuilderStereoPreserved, updateBuilderStereo } from '../../core/builder-stereo';
import { isPeriodic, requireConfirmedPeriodicity } from '../../core/periodic';
import type { DynamicsOperation, DynamicsError, DynamicsRequest } from './contracts';

const stereoBaselines = new WeakMap<Structure, Structure>();
const exactBonds = (structure: Structure) => JSON.stringify((structure.bonds ?? []).map(bond => [bond.a, bond.b, bond.order, bond.aromatic ?? false, bond.stereo ?? 0, bond.kind ?? 'covalent', bond.fractional ?? false, bond.image ?? null, bond.orderKnown ?? null, bond.perception ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

/** Periodic execution is only the fixed-cell mechanical objective, never a
 * molecular force field or an automatic hybrid fallback. Keep actual axes. */
export function validateDynamicsAdmission(structure: Structure, mode: DynamicsOperation, options: Pick<DynamicsRequest, 'constraints' | 'attachmentPorts' | 'geometryMode' | 'hybridScalePolicy' | 'allowPureGeometryFallback' | 'forcefield'> = {}): void {
  if (structure.dimension !== 3) throw new Error('动态整理需要正式3D坐标。');
  if (structure.periodicSource?.completeness === 'partial') throw new Error('部分平移矢量不能运行整理；需要完整晶胞和已确认周期轴。');
  if (structure.cell) requireConfirmedPeriodicity(structure);
  if (!isPeriodic(structure)) {
    if (structure.bonds?.some(bond => bond.image?.some(Boolean))) throw new Error('非周期模型不能执行跨镜像连接。');
    return;
  }
  if (mode !== 'geometry' || options.geometryMode !== undefined || options.hybridScalePolicy !== undefined || options.allowPureGeometryFallback !== undefined || options.forcefield !== undefined) throw new Error('周期模型仅支持固定晶胞机械几何整理，不支持UFF/MMFF、MD或混合回退。');
  if (options.constraints?.length) throw new Error('周期机械整理仅支持原子冻结，尚不支持B/A/D约束执行。');
  if (options.attachmentPorts?.length) throw new Error('周期机械整理不支持未完成的分子连接端口。');
  if (structure.atoms.some(atom => atom.stereoParity) || structure.bonds?.some(bond => bond.stereo)) throw new Error('周期机械整理尚未验证声明的分子立体约束。');
}

/** Keep real terminal codes/text. Invalid attribution is a protocol failure, not parameterization. */
export function validateDynamicsError(value: unknown, reference: Structure): DynamicsError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('动态终态错误缺少结构化code/message。');
  const error = value as Record<string, unknown>;
  if (typeof error.code !== 'string' || !error.code || error.code.length > 100 || typeof error.message !== 'string' || error.message.length > 8192) throw new Error('动态终态错误code/message无效。');
  const result: DynamicsError = { code: error.code, message: error.message };
  if (error.diagnostic === undefined) return result;
  const raw = error.diagnostic;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('动态错误诊断无效。');
  const diagnostic = raw as Record<string, unknown>;
  if (diagnostic.schema !== 1 || Object.keys(diagnostic).some(key => !['schema', 'phase', 'atomIds'].includes(key))) throw new Error('动态错误诊断schema或字段无效。');
  if (!['sanitization', 'parameterization', 'hybrid-partition'].includes(diagnostic.phase as string)) throw new Error('动态错误诊断phase无效。');
  if (diagnostic.phase === 'sanitization' ? error.code !== 'sanitization' : diagnostic.phase === 'hybrid-partition' ? !['hybrid-trusted-partition','hybrid-typing-isolation'].includes(error.code as string) : !['parameterization', 'fractional-parameterization'].includes(error.code as string)) throw new Error('动态错误诊断phase与实际错误code不符。');
  result.diagnostic = { schema: 1, phase: diagnostic.phase as NonNullable<DynamicsError['diagnostic']>['phase'] };
  if (diagnostic.atomIds !== undefined) {
    const ids = new Set(reference.atoms.map(atom => atom.id));
    if (!Array.isArray(diagnostic.atomIds) || diagnostic.atomIds.length > reference.atoms.length || diagnostic.atomIds.some(id => typeof id !== 'string' || !id || !ids.has(id)) || new Set(diagnostic.atomIds).size !== diagnostic.atomIds.length) throw new Error('动态错误诊断原子ID与真实请求图不符。');
    result.diagnostic.atomIds = [...diagnostic.atomIds] as string[];
  }
  return result;
}

/** Streaming output may update Cartesian positions only. Validate before any store write. */
export function validateDynamicsStructure(reference: Structure, candidate: Structure, movableAtomIds: readonly string[]): void {
  if (!candidate || !Array.isArray(candidate.atoms) || candidate.atoms.length !== reference.atoms.length) throw new Error('动态帧原子数改变。');
  if (candidate.id !== reference.id || candidate.dimension !== 3) throw new Error('动态帧结构身份或维度改变。');
  const ids = new Set(candidate.atoms.map(atom => atom.id));
  if (ids.has(undefined) || ids.size !== candidate.atoms.length) throw new Error('动态帧原子身份缺失或重复。');
  if (candidate.atoms.some((atom, index) => atom.id !== reference.atoms[index]?.id || atom.element !== reference.atoms[index]?.element)) throw new Error('动态帧原子身份或顺序改变。');
  if (candidate.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) throw new Error('动态帧存在非有限坐标。');
  if (graphFingerprint(reference) !== graphFingerprint(candidate)) throw new Error('动态帧键图、晶胞或电子态改变。');
  if (JSON.stringify(reference.periodicSource ?? null) !== JSON.stringify(candidate.periodicSource ?? null)) throw new Error('动态帧周期来源改变。');
  if (exactBonds(reference) !== exactBonds(candidate) || reference.atoms.some((atom, index) => atom.stereoParity !== candidate.atoms[index].stereoParity)) throw new Error('动态帧真实键级或立体定义改变。');
  const movable = new Set(movableAtomIds);
  if (movable.size !== movableAtomIds.length || movableAtomIds.some(id => !ids.has(id))) throw new Error('动态可动原子身份无效。');
  candidate.atoms.forEach((atom, index) => {
    if (!movable.has(atom.id!) && ![Object.is(atom.x, reference.atoms[index].x), Object.is(atom.y, reference.atoms[index].y), Object.is(atom.z, reference.atoms[index].z)].every(Boolean)) throw new Error('动态帧移动了冻结原子。');
  });
  // The periodic objective does not infer molecular tetrahedra from image
  // connectivity. Declared stereo is rejected at admission, not reinterpreted.
  if (isPeriodic(reference)) return;
  let stereo = stereoBaselines.get(reference);
  if (!stereo) { stereo = updateBuilderStereo(reference).structure; stereoBaselines.set(reference, stereo); }
  assertBuilderStereoPreserved(stereo, candidate);
}

export function validateDynamicsConfig(mode: DynamicsOperation, temperatureK: number, maxSteps: number): void {
  if (mode === 'md' && (!Number.isFinite(temperatureK) || temperatureK < 0 || temperatureK > 5000)) throw new Error('目标温度须在0–5000 K之间。');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('步数须为可精确表示的正整数。');
  if (!['md', 'optimize', 'geometry'].includes(mode)) throw new Error('动态模式无效。');
}
