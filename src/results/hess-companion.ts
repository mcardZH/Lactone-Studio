import type { Structure, Vector3 } from '../core/types';
import { superposeViewAtoms, type ViewRigidTransform } from '../modeling/view-superposition';
import { assertResultNotAborted, type TrajectoryResult } from './contracts';
import type { VibrationMode, Vibrations } from './scientific-contracts';

export interface HessCompanionAssessment { result: TrajectoryResult | null; reason: string | null }
const rejected = (reason: string): HessCompanionAssessment => ({ result: null, reason });
const groups = (result: TrajectoryResult) => result.scientific?.vibrationSets ?? (result.scientific?.vibrations ? [result.scientific.vibrations] : []);
const interval = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;
const roundoff = (...values: number[]) => 128 * Number.EPSILON * Math.max(1, ...values.map(Math.abs));
const rotate = (transform: ViewRigidTransform, vector: readonly number[]): Vector3 => transform.rotation.map(row => row.reduce((sum, value, i) => sum + value * vector[i], 0)) as Vector3;
function inventory(a: Structure, b: Structure): boolean {
  return a.atoms.length > 0 && a.atoms.length === b.atoms.length && a.atoms.every((atom, i) => atom.element === b.atoms[i].element)
    && (a.charge === null || b.charge === null || a.charge === b.charge) && (a.multiplicity === null || b.multiplicity === null || a.multiplicity === b.multiplicity);
}
function complete(group: Vibrations, structure: Structure): boolean {
  const atoms = structure.atoms.length;
  return group.modes.length === 3 * atoms && new Set(group.modes.map(mode => mode.sourceIndex)).size === 3 * atoms
    && group.modes.some(mode => mode.displacements?.some(vector => vector.some(component => component !== 0)))
    && group.modes.every(mode => Number.isSafeInteger(mode.sourceIndex) && mode.sourceIndex! >= 0 && mode.sourceIndex! < 3 * atoms
      && Number.isFinite(mode.frequency) && interval(mode.frequencyRounding) && interval(mode.displacementRounding)
      && mode.atomElements?.length === atoms && mode.atomElements.every((element, i) => element === structure.atoms[i].element)
      && mode.displacementConvention === 'cartesian' && mode.displacements?.length === atoms
      && mode.displacements.every(vector => vector.length === 3 && vector.every(Number.isFinite)));
}
function modesAgree(saved: VibrationMode, printed: VibrationMode, transform: ViewRigidTransform): boolean {
  if (Math.abs(saved.frequency - printed.frequency) > saved.frequencyRounding! + printed.frequencyRounding! + roundoff(saved.frequency, printed.frequency)) return false;
  // A single mode may have the opposite global phase. Never change or
  // independently flip atomic components in the retained source vectors.
  return [1, -1].some(sign => saved.displacements!.every((vector, atom) => {
    const rotated = rotate(transform, vector), target = printed.displacements![atom];
    return rotated.every((value, axis) => Math.abs(sign * value - target[axis]) <= printed.displacementRounding!
      + transform.rotation[axis].reduce((sum, component) => sum + Math.abs(component) * saved.displacementRounding!, 0) + roundoff(value, target[axis]));
  }));
}

/** Selected files only. Complete scientific fingerprints establish content
 * correspondence even when ORCA prints no HESS filename. No filesystem search,
 * atom permutation, Hessian diagonalization or frequency/intensity conversion. */
export async function assessHessCompanion(output: TrajectoryResult, hess: TrajectoryResult, signal?: AbortSignal): Promise<HessCompanionAssessment> {
  assertResultNotAborted(signal);
  if (output.engine !== 'orca' || hess.engine !== 'orca' || !output.scientific || !hess.scientific || hess.frames.length !== 1
    || hess.initialStructure.format !== 'ORCA HESS') return rejected('配对需要ORCA输出与独立ORCA HESS已保存结果。');
  const savedGroups = groups(hess);
  if (savedGroups.length !== 1 || !complete(savedGroups[0], hess.initialStructure)) return rejected('HESS缺少完整模式号、Cartesian向量或来源打印精度；保留为独立来源。');
  const saved = savedGroups[0], geometry = await hess.getFrame(0, signal);
  assertResultNotAborted(signal);
  const savedRound = hess.frames[0].coordinateRoundingAngstrom;
  if (!interval(savedRound)) return rejected('HESS缺少来源坐标打印精度。');
  const matching: { frameIndex: number; transform: ViewRigidTransform }[] = [];
  for (const printed of groups(output)) {
    assertResultNotAborted(signal);
    const frameIndex = printed.frameIndex;
    if (frameIndex === null || !output.frames[frameIndex]) continue;
    const printRound = output.frames[frameIndex].coordinateRoundingAngstrom;
    if (!interval(printRound)) continue;
    const display = await output.getFrame(frameIndex, signal);
    assertResultNotAborted(signal);
    if (!complete(printed, display)) continue;
    if (!inventory(geometry, display)) continue;
    const atoms = (structure: Structure) => structure.atoms.map((atom, i) => ({ ...atom, id: `a${i + 1}` }));
    const fit = superposeViewAtoms({ movingAtoms: atoms(geometry), referenceAtoms: atoms(display), mappingConfirmed: true });
    if (!fit.ok || fit.diagnostics.rotationAmbiguous) continue;
    // Same source-rounding cube bound already used by pairAtStructure. This is
    // not a new empirical geometry tolerance.
    const scale = Math.max(1, ...geometry.atoms.flatMap(atom => [Math.abs(atom.x), Math.abs(atom.y), Math.abs(atom.z)]), ...display.atoms.flatMap(atom => [Math.abs(atom.x), Math.abs(atom.y), Math.abs(atom.z)]));
    const tolerance = 2 * Math.sqrt(3) * (savedRound + printRound) + 128 * Number.EPSILON * scale;
    const byIndex = new Map(printed.modes.map(mode => [mode.sourceIndex, mode]));
    // Rounded coordinates need not determine one exact least-squares rotation.
    // A translation-only correspondence is another candidate, admitted only by
    // the same geometry bounds and the complete unchanged mode fingerprint.
    const translation = geometry.atoms.reduce<Vector3>((sum, atom, i) => sum.map((value, axis) => value
      + ([display.atoms[i].x, display.atoms[i].y, display.atoms[i].z][axis] - [atom.x, atom.y, atom.z][axis]) / geometry.atoms.length) as Vector3, [0, 0, 0]);
    const identity: ViewRigidTransform = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translation, anchorIds: fit.transform.anchorIds };
    for (const transform of [fit.transform, identity]) {
      const geometryAgrees = geometry.atoms.every((atom, i) => {
        const point = rotate(transform, [atom.x, atom.y, atom.z]);
        return Math.hypot(...point.map((value, axis) => value + transform.translation[axis] - [display.atoms[i].x, display.atoms[i].y, display.atoms[i].z][axis])) <= tolerance;
      });
      if (geometryAgrees && saved.modes.every(mode => modesAgree(mode, byIndex.get(mode.sourceIndex)!, transform))) {
        matching.push({ frameIndex, transform });
        break; // One shared transform must explain every mode in this frame.
      }
    }
  }
  const unique = [...new Map(matching.map(match => [match.frameIndex, match])).values()];
  if (unique.length !== 1) return rejected(unique.length ? 'HESS科学内容匹配多个帧，未自动选择所属帧。' : 'HESS与OUT未同时满足唯一帧几何、完整频率和Cartesian模式来源匹配。');
  const match = unique[0];
  const companion: Vibrations = { ...structuredClone(saved), frameIndex: match.frameIndex, sourceId: hess.source.id, sourceName: hess.source.name,
    modes: saved.modes.map(mode => ({ ...structuredClone(mode), displacements: mode.displacements!.map(vector => rotate(match.transform, vector)),
      displacementRounding: Math.max(...match.transform.rotation.map(row => row.reduce((sum, component) => sum + Math.abs(component) * mode.displacementRounding!, 0))) })) };
  const data = output.scientific, existing = groups(output);
  if (existing.some(group => group.sourceId === hess.source.id && group.frameIndex === match.frameIndex)) return { result: output, reason: null };
  // The original OUT group stays the compatibility group. The independent
  // saved group is selected explicitly and carries its own source identity.
  const result: TrajectoryResult = { ...output, scientific: { ...data, vibrationSets: [...existing, companion] },
    messages: [...output.messages, `已按完整频率、Cartesian模式及唯一帧几何匹配HESS来源 ${hess.source.name}（帧 ${match.frameIndex + 1}）。`] };
  return { result, reason: null };
}
export async function bindHessCompanion(output: TrajectoryResult, hess: TrajectoryResult, signal?: AbortSignal): Promise<TrajectoryResult | null> {
  return (await assessHessCompanion(output, hess, signal)).result;
}
