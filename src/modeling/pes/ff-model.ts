import type { Structure } from '../../core/types';
import type { PesFfModel, PesGroup, PesGeometry, PesRun } from './contracts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function isPesFfModel(value: unknown): value is PesFfModel {
  if (!object(value) || value.schemaVersion !== 1 || value.method !== 'gfnff' || typeof value.modelId !== 'string' || !value.modelId ||
    !object(value.reference) || !Array.isArray(value.reference.atoms) || !value.reference.atoms.length || !Array.isArray(value.atomOrder) ||
    value.atomOrder.length !== value.reference.atoms.length || new Set(value.atomOrder).size !== value.atomOrder.length ||
    !Number.isSafeInteger(value.reference.charge) || !Number.isSafeInteger(value.reference.multiplicity) || Number(value.reference.multiplicity) < 1) return false;
  return value.reference.atoms.every((atom, index) => object(atom) && typeof atom.id === 'string' && !!atom.id && atom.id === (value.atomOrder as unknown[])[index] &&
    typeof atom.element === 'string' && !!atom.element && [atom.x, atom.y, atom.z].every(Number.isFinite)) &&
    (value.parameterIdentity === undefined || object(value.parameterIdentity));
}

export function pesFfModelMatches(model: unknown, structure: Structure, charge: number, multiplicity: number, solvation?: PesFfModel['solvation']): model is PesFfModel {
  return isPesFfModel(model) && model.reference.charge === charge && model.reference.multiplicity === multiplicity &&
    model.solvation?.model === solvation?.model && model.solvation?.solvent === solvation?.solvent &&
    model.reference.atoms.length === structure.atoms.length && structure.atoms.every((atom, index) =>
      atom.id === model.atomOrder[index] && atom.element === model.reference.atoms[index].element);
}

export function pesSourceFfModel(group: PesGroup, source: PesGeometry): PesFfModel | undefined {
  const run = source.source?.runId ? group.runs[source.source.runId] : undefined;
  const candidate = run?.result?.provenance.ffModel ?? source.ffModel ?? run?.request.ffModel;
  if (!isPesFfModel(candidate)) return;
  const runtime = run?.result?.provenance.ffModelRuntime;
  const parameterIdentity = object(runtime) && object(runtime.parameterIdentity) ? runtime.parameterIdentity : undefined;
  return parameterIdentity ? { ...candidate, parameterIdentity } : candidate;
}

export function createPesFfModel(modelId: string, structure: Structure, charge: number, multiplicity: number, solvation?: PesFfModel['solvation']): PesFfModel {
  return { schemaVersion: 1, modelId, method: 'gfnff', atomOrder: structure.atoms.map(atom => atom.id!),
    ...(solvation ? { solvation: { ...solvation } } : {}),
    reference: { atoms: structure.atoms.map(({ id, element, x, y, z }) => ({ id, element, x, y, z })), charge, multiplicity } };
}

/** Only newly represented model semantics raise the format floor; old PES records stay unchanged. */
type FfSnapshotGroup = Pick<PesGroup, 'cards' | 'cardDrafts' | 'nodes'> & { runs: Record<string, Pick<PesRun, 'request' | 'source' | 'result'>> };
export function pesSnapshotUsesFfModel(snapshot: { groups: readonly FfSnapshotGroup[] } | undefined): boolean {
  return !!snapshot?.groups.some(group => group.nodes.some(node => node.geometry.ffModel !== undefined) ||
    [...group.cards, ...Object.values(group.cardDrafts ?? {})].some(card => Object.values(card.slots).some(slot => slot?.ffModel !== undefined)) ||
    Object.values(group.runs).some(run => run.request.ffModel !== undefined || run.source.ffModel !== undefined || run.result?.provenance.ffModel !== undefined));
}
