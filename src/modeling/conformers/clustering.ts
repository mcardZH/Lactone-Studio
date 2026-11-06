import type { Structure } from '../../core/types';
import type { SharedModelConstraints } from '../../core/modeling/contracts';
import { compareSymmetryConformerGeometry, createSymmetryConformerGeometryComparer, conformerSymmetryConnectivityIssue, symmetryGraphBucket, symmetryGraphsEquivalent } from './symmetry-matching';
import { assertBuilderStereoPreserved } from '../../core/builder-stereo';
import { superposeViewAtoms, VIEW_SUPERPOSITION_ATOM_LIMIT } from '../view-superposition';
import { convertEnergy, type EnergyUnit } from '../../results/energy';
import type { ConformerSourceIdentity } from './geometry';

/** Adapter-owned canonical scientific keys, never translated display labels.
 * method includes the full level/basis/parameterization; settingsKey distinguishes
 * further scientific settings not already represented by method and solvent. */
export interface ConformerCalculationIdentity {
  method: string; solvent: string; charge: number; multiplicity: number; settingsKey?: string;
  energyKind?: 'electronic' | 'forcefield-potential';
}
export interface ConformerOptimizationResult {
  candidateId: string; source: ConformerSourceIdentity; structure: Structure;
  identity: ConformerCalculationIdentity; converged: boolean;
  /** Unbiased energy; identity labels electronic vs force-field potential.
   * No MD bias, wall potential or docking score is accepted as this quantity. */
  energyHartree: number | null;
  /** Actual optimization constraints, independent from display selection. */
  constraints?: SharedModelConstraints;
  failureReason?: string;
}
export interface ConformerClusteringPolicy {
  /** Missing in historical results means fixed stable-ID correspondence. */
  rmsdMatching?: 'fixed' | 'symmetry';
  rmsdThresholdAngstrom: number;
  /** Disabled when absent. This optional additional gate uses Hartree explicitly. */
  maxDeltaEnergyHartree?: number;
  maxRecords: number;
}
/** Product clustering default, not an alignment error/convergence tolerance. */
export const DEFAULT_CONFORMER_CLUSTERING_POLICY: Readonly<ConformerClusteringPolicy> = Object.freeze({
  rmsdThresholdAngstrom: .10, maxDeltaEnergyHartree: convertEnergy({ value: .25, unit: 'kcal/mol' }, 'hartree')!, maxRecords: 1024,
});
/** Numerical equality slack only; not a scientific cluster threshold. */
export const CONFORMER_RMSD_ROUNDOFF_ANGSTROM = 1e-10;
export type ConformerResultRejection = 'duplicate-candidate-id' | 'invalid-source' | 'invalid-identity'
  | 'not-converged' | 'missing-energy' | 'invalid-energy' | 'invalid-geometry' | 'missing-connectivity'
  | 'invalid-connectivity' | 'incomplete-connectivity' | 'electronic-state-mismatch' | 'unsupported-geometry' | 'alignment-atom-limit' | 'alignment-failed';
export interface RejectedConformerResult {
  record: ConformerOptimizationResult; reason: ConformerResultRejection;
}
export interface ConformerClusterMember {
  candidateId: string; source: ConformerSourceIdentity; energyHartree: number;
  rmsdToRepresentativeAngstrom: number;
}
export interface ConformerCluster {
  id: string; representative: ConformerOptimizationResult & { energyHartree: number; converged: true };
  members: ConformerClusterMember[];
}
export interface ConformerClusterGroup {
  id: string; comparisonKey: string; identity: ConformerCalculationIdentity;
  atomIds: string[]; fitAtomIds: string[]; fitScope: 'heavy-atoms' | 'all-atoms';
  clusters: ConformerCluster[];
  rmsdMatching?: 'fixed' | 'symmetry';
}
export interface ConformerClusterSet {
  groups: ConformerClusterGroup[]; rejected: RejectedConformerResult[];
  memberToCluster: { candidateId: string; groupId: string; clusterId: string; representativeCandidateId: string }[];
  acceptedCount: number; policy: ConformerClusteringPolicy;
}
export interface ConformerPromotion {
  clusterId: string; representativeCandidateId: string; memberCandidateIds: string[];
  record: ConformerOptimizationResult & { energyHartree: number; converged: true };
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const byEnergy = (a: ConformerOptimizationResult & { energyHartree: number }, b: ConformerOptimizationResult & { energyHartree: number }) =>
  a.energyHartree < b.energyHartree ? -1 : a.energyHartree > b.energyHartree ? 1 : compareText(a.candidateId, b.candidateId);
const nonblank = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

export function conformerCalculationIdentityKey(identity: ConformerCalculationIdentity): string {
  return JSON.stringify([identity.method, identity.solvent, identity.charge, identity.multiplicity, identity.settingsKey ?? '', identity.energyKind ?? 'electronic']);
}
function identityValid(identity: ConformerCalculationIdentity): boolean {
  return !!identity && nonblank(identity.method) && nonblank(identity.solvent)
    && Number.isSafeInteger(identity.charge) && Number.isSafeInteger(identity.multiplicity) && identity.multiplicity > 0
    && (identity.energyKind === undefined || ['electronic', 'forcefield-potential'].includes(identity.energyKind))
    && (identity.settingsKey === undefined || typeof identity.settingsKey === 'string');
}
function sourceValid(source: ConformerSourceIdentity): boolean {
  return !!source && nonblank(source.documentId) && Number.isSafeInteger(source.revision) && source.revision >= 0
    && (source.frameId === undefined || nonblank(source.frameId)) && (source.sourceId === undefined || nonblank(source.sourceId));
}
function atomKey(s: Structure): string {
  // ID order is canonical for comparison only. Original coordinates/order are untouched.
  return JSON.stringify(s.atoms.map(a => [a.id!, a.element, a.formalCharge ?? null]).sort((a, b) => compareText(a[0] as string, b[0] as string)));
}
function graphKey(s: Structure): string {
  return JSON.stringify(s.bonds!.map(b => {
    const ids = [s.atoms[b.a].id!, s.atoms[b.b].id!].sort(compareText);
    return JSON.stringify([ids, b.order, b.aromatic ?? false, b.orderKnown !== false, b.kind ?? 'covalent']);
  }).sort(compareText));
}
function selectedFitAtomIds(s: Structure): string[] {
  const heavy = s.atoms.filter(a => a.element !== 'H');
  return (heavy.length ? heavy : s.atoms).map(a => a.id!).sort(compareText);
}
function rejection(record: ConformerOptimizationResult,rmsdMatching:'fixed'|'symmetry'='fixed'): ConformerResultRejection | undefined {
  if (!nonblank(record.candidateId) || !sourceValid(record.source)) return 'invalid-source';
  if (!identityValid(record.identity)) return 'invalid-identity';
  if (record.converged !== true) return 'not-converged';
  if (record.energyHartree === null || record.energyHartree === undefined) return 'missing-energy';
  if (typeof record.energyHartree !== 'number' || !Number.isFinite(record.energyHartree)) return 'invalid-energy';
  const s = record.structure;
  if (!s || !s.atoms?.length || s.atoms.some(a => !nonblank(a.id) || !nonblank(a.element)
    || ![a.x, a.y, a.z].every(Number.isFinite)) || new Set(s.atoms.map(a => a.id)).size !== s.atoms.length) return 'invalid-geometry';
  if (s.charge !== record.identity.charge || s.multiplicity !== record.identity.multiplicity) return 'electronic-state-mismatch';
  if (s.dimension === 2 || s.cell?.pbc.some(Boolean) || s.periodicSource || s.bonds?.some(b => b.image?.some(Boolean))) return 'unsupported-geometry';
  if (!Array.isArray(s.bonds)&&!(rmsdMatching==='symmetry'&&s.atoms.length===1)) return 'missing-connectivity';
  const edges = new Set<string>();
  for (const b of s.bonds??[]) {
    const key = JSON.stringify([Math.min(b.a, b.b), Math.max(b.a, b.b)]);
    if (![b.a, b.b].every(i => Number.isInteger(i) && i >= 0 && i < s.atoms.length) || b.a === b.b
      || !Number.isFinite(b.order) || b.order <= 0 || edges.has(key)) return 'invalid-connectivity';
    edges.add(key);
  }
  if (selectedFitAtomIds(s).length > VIEW_SUPERPOSITION_ATOM_LIMIT) return 'alignment-atom-limit';
  const ids = new Set(selectedFitAtomIds(s)), atoms = s.atoms.filter(a => ids.has(a.id!));
  if (!superposeViewAtoms({ movingAtoms: atoms, referenceAtoms: atoms,
    pairs: atoms.map(a => ({ movingAtomId: a.id!, referenceAtomId: a.id! })), mappingConfirmed: true }).ok) return 'alignment-failed';
}

/** Same atom identities and graph are required before the numerical fit.
 * Proper rotation alone is insufficient: shallow mirror pairs can lie within
 * a finite RMSD cutoff, so defined tetrahedral/E/Z states are guarded as well. */
type GeometryComparison =
  { comparable: true; rmsdAngstrom: number; fitAtomIds: string[]; fitScope: 'heavy-atoms' | 'all-atoms' }
  | { comparable: false; reason: 'atom-correspondence' | 'connectivity' | 'stereochemistry' | 'alignment'; detail?: string;message?:string };
type ComparisonIdentity = { atoms: string; graph: string; fitAtomIds: string[] };
const comparisonIdentity=(structure:Structure):ComparisonIdentity=>({atoms:atomKey(structure),graph:graphKey(structure),fitAtomIds:selectedFitAtomIds(structure)});
export function compareConformerGeometry(moving:Structure,reference:Structure,rmsdMatching:'fixed'|'symmetry'='fixed',movingConstraints?:SharedModelConstraints,referenceConstraints?:SharedModelConstraints):GeometryComparison {
  if(rmsdMatching==='symmetry'){
    const issue=conformerSymmetryConnectivityIssue(moving)??conformerSymmetryConnectivityIssue(reference);
    if(issue)return{comparable:false,reason:'connectivity',detail:issue.reason,message:issue.message};
    try{
      if(!symmetryGraphsEquivalent(moving,reference,movingConstraints,referenceConstraints))return{comparable:false,reason:'connectivity'};
      return compareSymmetryConformerGeometry(moving,reference,movingConstraints,referenceConstraints);
    }catch{return{comparable:false,reason:'connectivity',detail:'invalid-geometry-or-connectivity'};}
  }
  return comparePreparedGeometry(moving,reference,comparisonIdentity);
}
/** One immutable batch only. Cache the graph/ID/fit selection once per frame;
 * coordinate-dependent stereo and proper rigid fits are still checked per pair. */
export function createConformerGeometryComparer(rmsdMatching:'fixed'|'symmetry'='fixed') {
  if(rmsdMatching==='symmetry')return createSymmetryConformerGeometryComparer();
  const cache=new WeakMap<Structure,ComparisonIdentity>();
  const prepare=(structure:Structure)=>{let value=cache.get(structure);if(!value){value=comparisonIdentity(structure);cache.set(structure,value);}return value;};
  return (moving:Structure,reference:Structure,_movingConstraints?:SharedModelConstraints,_referenceConstraints?:SharedModelConstraints)=>comparePreparedGeometry(moving,reference,prepare);
}
function comparePreparedGeometry(moving: Structure, reference: Structure,prepare:(structure:Structure)=>ComparisonIdentity):GeometryComparison {
  let referenceIdentity:ComparisonIdentity;
  try {
    const movingIdentity=prepare(moving);referenceIdentity=prepare(reference);
    if (movingIdentity.atoms !== referenceIdentity.atoms) return { comparable: false, reason: 'atom-correspondence' };
    if (movingIdentity.graph !== referenceIdentity.graph) return { comparable: false, reason: 'connectivity' };
  } catch { return { comparable: false, reason: 'connectivity', detail: 'invalid-geometry-or-connectivity' }; }
  try {
    assertBuilderStereoPreserved(moving, reference);
    assertBuilderStereoPreserved(reference, moving);
  } catch { return { comparable: false, reason: 'stereochemistry' }; }
  const ids = referenceIdentity.fitAtomIds, selected = new Set(ids);
  const fit = superposeViewAtoms({ movingAtoms: moving.atoms.filter(a => selected.has(a.id!)),
    referenceAtoms: reference.atoms.filter(a => selected.has(a.id!)),
    pairs: ids.map(id => ({ movingAtomId: id, referenceAtomId: id })), mappingConfirmed: true });
  return fit.ok ? { comparable: true, rmsdAngstrom: fit.rmsd, fitAtomIds: ids,
    fitScope: reference.atoms.some(a => a.element !== 'H') ? 'heavy-atoms' : 'all-atoms' }
    : { comparable: false, reason: 'alignment', detail: fit.issues.map(i => i.code).join(',') };
}

export function clusterConformerResults(records: readonly ConformerOptimizationResult[],
  options: Partial<ConformerClusteringPolicy> = {}): ConformerClusterSet {
  const policy = { ...DEFAULT_CONFORMER_CLUSTERING_POLICY, ...options };
  const compareGeometry=createConformerGeometryComparer(policy.rmsdMatching);
  if (!Number.isFinite(policy.rmsdThresholdAngstrom) || policy.rmsdThresholdAngstrom < 0
    || policy.rmsdMatching!==undefined&&!['fixed','symmetry'].includes(policy.rmsdMatching)
    || !Number.isSafeInteger(policy.maxRecords) || policy.maxRecords < 1
    || (policy.maxDeltaEnergyHartree !== undefined && (!Number.isFinite(policy.maxDeltaEnergyHartree) || policy.maxDeltaEnergyHartree < 0))) throw new Error('构象归簇策略无效。');
  if (records.length > policy.maxRecords) throw new Error('构象归簇结果数超出本次有界预算。');
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.candidateId, (counts.get(record.candidateId) ?? 0) + 1);
  const accepted = new Map<string, (ConformerOptimizationResult & { energyHartree: number; converged: true })[]>();
  const result: ConformerClusterSet = { groups: [], rejected: [], memberToCluster: [], acceptedCount: 0, policy };
  for (const input of records) {
    const reason = counts.get(input.candidateId)! > 1 ? 'duplicate-candidate-id' : rejection(input,policy.rmsdMatching)
      ??(policy.rmsdMatching==='symmetry'?conformerSymmetryConnectivityIssue(input.structure)?.reason:undefined);
    if (reason) { result.rejected.push({ record: structuredClone(input), reason }); continue; }
    const record = structuredClone(input) as ConformerOptimizationResult & { energyHartree: number; converged: true };
    const symmetric=policy.rmsdMatching==='symmetry';
    let key = JSON.stringify([conformerCalculationIdentityKey(record.identity),symmetric?symmetryGraphBucket(record.structure,record.constraints):[atomKey(record.structure),graphKey(record.structure),record.constraints??null]]);
    // A graph invariant is only a bucket. Resolve any collision by complete
    // isomorphism before assigning one scientific comparison group.
    if(symmetric){const bucket=key;let suffix=0;
      while(accepted.has(key)&&!symmetryGraphsEquivalent(record.structure,accepted.get(key)![0].structure,record.constraints,accepted.get(key)![0].constraints))key=JSON.stringify([bucket,++suffix]);
    }
    const group = accepted.get(key) ?? []; group.push(record); accepted.set(key, group); result.acceptedCount++;
  }
  for (const [key, groupRecords] of [...accepted.entries()].sort(([a], [b]) => compareText(a, b))) {
    groupRecords.sort(byEnergy);
    const first = groupRecords[0], fitAtomIds = selectedFitAtomIds(first.structure);
    const group: ConformerClusterGroup = { id: `group-${result.groups.length + 1}`, comparisonKey: key,
      identity: { ...first.identity }, atomIds: first.structure.atoms.map(a => a.id!).sort(compareText), fitAtomIds,
      fitScope: first.structure.atoms.some(a => a.element !== 'H') ? 'heavy-atoms' : 'all-atoms', clusters: [],...(policy.rmsdMatching?{rmsdMatching:policy.rmsdMatching}:{}) };
    for (const record of groupRecords) {
      let found: ConformerCluster | undefined, matchedRmsd = 0;
      // Representative-centred greedy clustering, not transitive single linkage.
      // Ascending energy makes the first assigned representative the lowest-energy member.
      for (const cluster of group.clusters) {
        if (policy.maxDeltaEnergyHartree !== undefined && record.energyHartree - cluster.representative.energyHartree > policy.maxDeltaEnergyHartree) continue;
        const fit = compareGeometry(record.structure, cluster.representative.structure,record.constraints,cluster.representative.constraints);
        if (fit.comparable && fit.rmsdAngstrom <= policy.rmsdThresholdAngstrom + CONFORMER_RMSD_ROUNDOFF_ANGSTROM) {
          found = cluster; matchedRmsd = fit.rmsdAngstrom; break;
        }
      }
      if (!found) {
        found = { id: `cluster-${record.candidateId}`, representative: record, members: [] };
        group.clusters.push(found);
      }
      found.members.push({ candidateId: record.candidateId, source: { ...record.source }, energyHartree: record.energyHartree,
        rmsdToRepresentativeAngstrom: matchedRmsd });
      result.memberToCluster.push({ candidateId: record.candidateId, groupId: group.id, clusterId: found.id,
        representativeCandidateId: found.representative.candidateId });
    }
    result.groups.push(group);
  }
  result.rejected.sort((a, b) => compareText(a.record.candidateId, b.record.candidateId));
  return result;
}

/** Promotion is scoped to one comparable group; no cross-method energy ranking. */
export function selectConformerRepresentatives(group: ConformerClusterGroup, count: number): ConformerPromotion[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('晋级簇数必须为非负整数。');
  validateClusterGroup(group);
  return [...group.clusters].sort((a, b) => byEnergy(a.representative, b.representative)).slice(0, count).map(cluster => ({
    clusterId: cluster.id, representativeCandidateId: cluster.representative.candidateId,
    memberCandidateIds: cluster.members.map(member => member.candidateId), record: structuredClone(cluster.representative),
  }));
}

// Exact SI R = k_B N_A; Hartree conversion reuses the current results energy module (CODATA 2022).
export const CONFORMER_GAS_CONSTANT_J_MOL_K = 8.31446261815324;
const HARTREE_J_MOL = convertEnergy({ value: 1, unit: 'hartree' }, 'kJ/mol')! * 1000;
function validateClusterGroup(group: ConformerClusterGroup): void {
  if (!identityValid(group.identity)) throw new Error('构象可比组科学身份无效。');
  const key = conformerCalculationIdentityKey(group.identity), clusters = new Set<string>(), members = new Set<string>();
  const first = group.clusters[0]?.representative.structure;
  for (const cluster of group.clusters) {
    const rep = cluster.representative;
    if (clusters.has(cluster.id) || rejection(rep,group.rmsdMatching) || conformerCalculationIdentityKey(rep.identity) !== key
      || (group.rmsdMatching==='symmetry'?!symmetryGraphsEquivalent(rep.structure,first!,rep.constraints,group.clusters[0].representative.constraints):atomKey(rep.structure) !== atomKey(first!) || graphKey(rep.structure) !== graphKey(first!))
      || group.rmsdMatching!=='symmetry'&&JSON.stringify(rep.constraints??null)!==JSON.stringify(group.clusters[0].representative.constraints??null)
      || !cluster.members.some(member => member.candidateId === rep.candidateId && member.energyHartree === rep.energyHartree)) throw new Error('构象可比组包含重复、无效或不可比的代表结构。');
    clusters.add(cluster.id);
    for (const member of cluster.members) {
      if (members.has(member.candidateId) || !sourceValid(member.source) || !Number.isFinite(member.energyHartree)
        || member.energyHartree < rep.energyHartree || !Number.isFinite(member.rmsdToRepresentativeAngstrom)
        || member.rmsdToRepresentativeAngstrom < 0) throw new Error('构象簇成员或最低能代表映射无效。');
      members.add(member.candidateId);
    }
  }
}
export interface ConformerPopulation {
  clusterId: string; representativeCandidateId: string; energyHartree: number;
  relativeEnergyHartree: number | null; relativeEnergy: number | null; energyUnit: EnergyUnit;
  /** Overflow preserves the raw finite energy; an unrepresentable delta is never a false zero. */
  relativeEnergyOverflow: boolean; fraction: number;
  /** Relative to the minimum, with no population normalization or degeneracy. */
  weight: number;
}
export interface ConformerPopulations {
  groupId: string; identity: ConformerCalculationIdentity; temperatureK: number; referenceEnergyHartree: number | null;
  basis: 'relative-electronic-energy' | 'relative-potential-energy'; degeneracy: 'one-per-representative'; populations: ConformerPopulation[];
}
export function estimateConformerPopulations(group: ConformerClusterGroup, temperatureK: number,
  energyUnit: EnergyUnit = 'kJ/mol'): ConformerPopulations {
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) throw new Error('玻尔兹曼估算温度须为有限正数。');
  if (convertEnergy({ value: 1, unit: 'hartree' }, energyUnit) === null) throw new Error('能量显示单位无效。');
  validateClusterGroup(group);
  const representatives = [...group.clusters].sort((a, b) => byEnergy(a.representative, b.representative));
  const minimum = representatives[0]?.representative.energyHartree ?? null;
  const thermalHartree = temperatureK * (CONFORMER_GAS_CONSTANT_J_MOL_K / HARTREE_J_MOL);
  const weights = representatives.map(c => {
    const delta = c.representative.energyHartree - minimum!;
    return delta === 0 ? 1 : thermalHartree === 0 ? 0 : Math.exp(-delta / thermalHartree);
  });
  // Neumaier/Kahan compensation keeps many tiny finite terms without changing their definition.
  let sum = 0, correction = 0;
  for (const weight of weights) { const corrected = weight - correction, next = sum + corrected; correction = (next - sum) - corrected; sum = next; }
  const populations = representatives.map((c, i): ConformerPopulation => {
    const rawDelta = c.representative.energyHartree - minimum!, delta = Number.isFinite(rawDelta) ? rawDelta : null;
    const relativeEnergy = delta === null ? null : convertEnergy({ value: delta, unit: 'hartree' }, energyUnit);
    return { clusterId: c.id, representativeCandidateId: c.representative.candidateId, energyHartree: c.representative.energyHartree,
      relativeEnergyHartree: delta, relativeEnergy, energyUnit, relativeEnergyOverflow: delta === null || relativeEnergy === null, weight:weights[i], fraction: weights[i] / sum };
  });
  return { groupId: group.id, identity: { ...group.identity }, temperatureK, referenceEnergyHartree: minimum,
    basis: group.identity.energyKind === 'forcefield-potential' ? 'relative-potential-energy' : 'relative-electronic-energy', degeneracy: 'one-per-representative', populations };
}
