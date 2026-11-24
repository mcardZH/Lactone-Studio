import type { Structure } from '../../core/types';
import { graphFingerprint } from '../../core/modeling/graph';
import { acceptTransportedFixedAtom } from '../../core/modeling/transported-cartesian';
import { isPeriodic, requireConfirmedPeriodicity } from '../../core/periodic';
import type { DynamicsOperation, DynamicsError, DynamicsRequest } from './contracts';
import { supportsMDIntegrator } from './md-methods';

const exactBonds = (structure: Structure) => JSON.stringify((structure.bonds ?? []).map(bond => [bond.a, bond.b, bond.order, bond.aromatic ?? false, bond.stereo ?? 0, bond.kind ?? 'covalent', bond.fractional ?? false, bond.image ?? null, bond.orderKnown ?? null, bond.perception ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

/** Native coordinate frames normally preserve the input atom and bond order. */
function sameOrderedDynamicsGraph(reference: Structure, candidate: Structure): boolean {
  if (reference.charge !== candidate.charge || reference.multiplicity !== candidate.multiplicity
    || JSON.stringify(reference.cell ?? null) !== JSON.stringify(candidate.cell ?? null)) return false;
  if (!candidate.atoms.every((atom, index) => {
    const original = reference.atoms[index];
    return (atom.formalCharge ?? 0) === (original.formalCharge ?? 0)
      && (atom.aromaticHydrogen ?? false) === (original.aromaticHydrogen ?? false);
  })) return false;
  const bonds = candidate.bonds ?? [], originals = reference.bonds ?? [];
  return bonds.length === originals.length && bonds.every((bond, index) => {
    const original = originals[index];
    return !!candidate.atoms[bond.a]?.id && !!candidate.atoms[bond.b]?.id
      && bond.a === original.a && bond.b === original.b && bond.order === original.order
      && (bond.aromatic ?? false) === (original.aromatic ?? false) && (bond.stereo ?? 0) === (original.stereo ?? 0)
      && (bond.kind ?? 'covalent') === (original.kind ?? 'covalent') && (bond.fractional ?? false) === (original.fractional ?? false)
      && (bond.orderKnown ?? null) === (original.orderKnown ?? null) && (bond.perception ?? null) === (original.perception ?? null)
      && (bond.image === original.image || Boolean(bond.image && original.image && bond.image.length === original.image.length && bond.image.every((value, axis) => value === original.image![axis])));
  });
}

export function validateDynamicsAdmission(structure: Structure, mode: DynamicsOperation, options: Pick<DynamicsRequest,
  'constraints' | 'attachmentPorts' | 'forcefield' | 'integrator'> & { method?: string } = {}): void {
  if (mode !== 'md') throw new Error('仅支持分子动力学请求。');
  if (structure.dimension !== 3) throw new Error('分子动力学需要正式3D坐标。');
  if (structure.periodicSource?.completeness === 'partial') throw new Error('部分平移矢量不能运行MD；需要完整晶胞和已确认周期轴。');
  const periodic=isPeriodic(structure);
  if (periodic) {
    const cell=requireConfirmedPeriodicity(structure);
    if(options.integrator==='ase'&&!cell.pbc.every(Boolean))throw new Error('固定晶胞 ASE MD需要工作模型启用 XYZ 三个周期轴。');
    if (options.attachmentPorts?.length) throw new Error('周期MD需要完成连接端口。');
  }
  if ((options.method || periodic) && !supportsMDIntegrator(options.method ?? '', periodic, options.integrator)) throw new Error('所选方法与积分器不支持当前模型。');
  if (!periodic && structure.bonds?.some(bond => bond.image?.some(Boolean))) throw new Error('非周期模型不能执行跨镜像连接。');
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
  if (!['sanitization', 'parameterization'].includes(diagnostic.phase as string)) throw new Error('动态错误诊断phase无效。');
  if (diagnostic.phase === 'sanitization' ? error.code !== 'sanitization' : !['parameterization', 'fractional-parameterization'].includes(error.code as string)) throw new Error('动态错误诊断phase与实际错误code不符。');
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
  checkDynamicsStructure(reference, candidate, movableAtomIds, false);
}

/** Accept a worker's NDJSON geometry against the immutable run request. */
export function acceptTransportedDynamicsStructure(reference: Structure, candidate: Structure, movableAtomIds: readonly string[]): Structure {
  return checkDynamicsStructure(reference, candidate, movableAtomIds, true);
}

function checkDynamicsStructure(reference: Structure, candidate: Structure, movableAtomIds: readonly string[], transported: boolean): Structure {
  if (!candidate || !Array.isArray(candidate.atoms) || candidate.atoms.length !== reference.atoms.length) throw new Error('动态帧原子数改变。');
  if (candidate.id !== reference.id || candidate.dimension !== 3) throw new Error('动态帧结构身份或维度改变。');
  const ids = new Set(candidate.atoms.map(atom => atom.id));
  if (ids.has(undefined) || ids.size !== candidate.atoms.length) throw new Error('动态帧原子身份缺失或重复。');
  if (candidate.atoms.some((atom, index) => atom.id !== reference.atoms[index]?.id || atom.element !== reference.atoms[index]?.element)) throw new Error('动态帧原子身份或顺序改变。');
  if (candidate.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) throw new Error('动态帧存在非有限坐标。');
  const sameOrderedGraph = sameOrderedDynamicsGraph(reference, candidate);
  if (!sameOrderedGraph && graphFingerprint(reference) !== graphFingerprint(candidate)) throw new Error('动态帧键图、晶胞或电子态改变。');
  if (JSON.stringify(reference.periodicSource ?? null) !== JSON.stringify(candidate.periodicSource ?? null)) throw new Error('动态帧周期来源改变。');
  if ((!sameOrderedGraph && exactBonds(reference) !== exactBonds(candidate)) || reference.atoms.some((atom, index) => atom.stereoParity !== candidate.atoms[index].stereoParity)) throw new Error('动态帧真实键级或立体定义改变。');
  const movable = new Set(movableAtomIds);
  if (movable.size !== movableAtomIds.length || movableAtomIds.some(id => !ids.has(id))) throw new Error('动态可动原子身份无效。');
  let acceptedAtoms: Structure['atoms'] | undefined;
  const fixedMismatch = '动态帧移动了冻结原子。';
  for (const [index, atom] of candidate.atoms.entries()) {
    if (movable.has(atom.id!)) continue;
    const before = reference.atoms[index];
    if (transported) {
      const accepted = acceptTransportedFixedAtom(before, atom);
      if (!accepted) throw new Error(fixedMismatch);
      if (accepted !== atom) (acceptedAtoms ??= candidate.atoms.slice())[index] = accepted;
    } else if (!Object.is(atom.x, before.x) || !Object.is(atom.y, before.y) || !Object.is(atom.z, before.z)) {
      throw new Error(fixedMismatch);
    }
  }
  return acceptedAtoms ? { ...candidate, atoms: acceptedAtoms } : candidate;
}

export function validateDynamicsConfig(mode: DynamicsOperation, temperatureK: number, maxSteps: number): void {
  if (mode === 'md' && (!Number.isFinite(temperatureK) || temperatureK < 0 || temperatureK > 5000)) throw new Error('目标温度须在0–5000 K之间。');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new Error('步数须为可精确表示的正整数。');
  if (mode !== 'md') throw new Error('动态模式无效。');
}
