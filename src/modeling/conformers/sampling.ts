import type { Structure } from '../../core/types';
import {sha256Utf8} from '../../core/file-identity';
import { builderCoordinateValue, builderPosition, builderVector } from '../../core/builder-geometry';
import { ELEMENT_PRESET_COVALENT_RADII, ELEMENT_PRESET_LENGTH_REFERENCE } from '../../core/modeling/element-preset-lengths';
import {allocateConformerTorsionPoints,type ConformerPointCountMode} from './point-allocation';
import {createConformerGeometryComparer} from './clustering';
import { assertConformerGeometryProtected, inspectConformerTorsion, inspectManualConformerTorsion, normalizeTorsionDegrees,
  rotateConformerTorsion, sampleTorsionAngles, torsionAngleInRange,
  type ConformerSnapshot, type ConformerTorsion, type TorsionAngleRange } from './geometry';

export interface ConformerTorsionSampling {
  torsion: ConformerTorsion; pointCount?: number; range?: TorsionAngleRange; pointCountMode?:ConformerPointCountMode;
}
export type ConformerQuantityPolicy =
  | { mode: 'per-torsion'; pointsPerTorsion: number }
  | { mode: 'total-effective'; targetCount: number; pointsPerTorsion: number; automaticPointAllocation?:boolean };
export interface ConformerSamplingLimits {
  maxCandidates: number; maxAttempts: number; maxAtoms: number; maxTorsions: number;
  duplicatePositionAngstrom: number;
}
/** Operational caps, not scientific convergence or exhaustiveness claims. */
export const DEFAULT_CONFORMER_SAMPLING_LIMITS: Readonly<ConformerSamplingLimits> = Object.freeze({
  maxCandidates: 2000, maxAttempts: 131072, maxAtoms: 512, maxTorsions: 64, duplicatePositionAngstrom: 1e-5,
});
export interface ConformerClashPolicy {
  severeRadiusRatio: number; severeFloorAngstrom: number; severeCeilingAngstrom: number;
  contactRadiusRatio: number; repairStepDegrees: number; maxRepairOffsetDegrees: number; maxRepairAttempts: number;
  /** Explicit additions/overrides only; absent radii stop screening, never become carbon. */
  radiiAngstrom: Readonly<Record<string, number>>;
}
/** Geometry heuristics based on the existing Cordero construction radii.
 * Ratios/caps are application choices, not vdW radii, FF energies or literature thresholds.
 * 1–2 / 1–3 pairs are invariant under whole-side torsions and omitted from contact screening.
 * Mild contacts remain eligible for the explicitly triggered first optimization stage. */
export const DEFAULT_CONFORMER_CLASH_POLICY: Readonly<ConformerClashPolicy> = Object.freeze({
  severeRadiusRatio: .55, severeFloorAngstrom: .32, severeCeilingAngstrom: .8,
  contactRadiusRatio: 1, repairStepDegrees: 5, maxRepairOffsetDegrees: 15, maxRepairAttempts: 24,
  radiiAngstrom: ELEMENT_PRESET_COVALENT_RADII,
});
export const CONFORMER_CLASH_RADIUS_SOURCE = ELEMENT_PRESET_LENGTH_REFERENCE;
export interface ConformerClashSummary {
  severity: 'clear' | 'contact' | 'severe'; severePairs: number; contactPairs: number;
  closestPair?: { atomIds: [string, string]; distanceAngstrom: number; severeThresholdAngstrom: number };
}
export interface ConformerGuess {
  id: string; source: ConformerSnapshot['source']; structure: Structure;
  /** IDs retain source atom order; UI numbering belongs to its adapter. */
  sourceAtomIds: string[]; attempt: number;
  torsions: { atomIds: [string, string, string, string]; targetDegrees: number; actualDegrees: number;pointIndex?:number;pointCount?:number }[];
  clash: ConformerClashSummary; repaired: boolean; repairAttempts: number;
}
export interface ConformerGuessSet {
  guesses: ConformerGuess[]; quantity: ConformerQuantityPolicy;
  requestedEffectiveCount: string; boundedTargetCount: number; combinationSpace: string;
  attempts: number; rejected: { severeClash: number; duplicate: number; geometry: number; coreProtection?:number };
  repairAttempts: number; status: 'complete' | 'partial';
  stopReason: 'target-reached' | 'candidate-limit' | 'attempt-limit' | 'combination-space-exhausted' | 'cancelled';
  /** Actual finite grids visited, including bounded automatic supplementation. */
  pointAllocations?: {pointCounts:number[];combinationSpace:string;attempts:number}[];
  continuation?:ConformerGuessContinuation;
}
/** Serializable traversal state; scientific identity excludes requested workload.
 * nextOrdinal always points at an unprocessed full combination boundary. */
export interface ConformerGuessContinuation {
  schema:'conformer-torsion-continuation/v1'|'conformer-torsion-continuation/v2'; configurationIdentity:string;
  countMode?:'unique'|'received';
  round:number; pointCounts:number[]; nextOrdinal:string; visited:string[];
  attempts:number; acceptedCount:number; rejected:ConformerGuessSet['rejected']; repairAttempts:number;
  pointAllocations:NonNullable<ConformerGuessSet['pointAllocations']>; exhausted:boolean;
}
interface PairCheck { a: number; b: number; severe: number; contact: number }

function validatePolicy(policy: ConformerClashPolicy): void {
  const numbers = [policy.severeRadiusRatio, policy.severeFloorAngstrom, policy.severeCeilingAngstrom,
    policy.contactRadiusRatio, policy.repairStepDegrees, policy.maxRepairOffsetDegrees];
  if (numbers.some(v => !Number.isFinite(v) || v <= 0) || policy.severeFloorAngstrom > policy.severeCeilingAngstrom
    || policy.contactRadiusRatio < policy.severeRadiusRatio || !Number.isInteger(policy.maxRepairAttempts)
    || policy.maxRepairAttempts < 0 || policy.maxRepairAttempts > 4096 || policy.maxRepairOffsetDegrees > 180) throw new Error('构象避碰策略无效。');
}
function preparePairs(source: Structure, policy: ConformerClashPolicy): PairCheck[] {
  validatePolicy(policy);
  const graph = source.atoms.map(() => new Set<number>());
  for (const b of source.bonds!) { graph[b.a].add(b.b); graph[b.b].add(b.a); }
  const radii = source.atoms.map(a => {
    const radius = policy.radiiAngstrom[a.element];
    if (!Number.isFinite(radius) || radius <= 0) throw new Error(`元素 ${a.element} 缺少明确的构象避碰半径。`);
    return radius;
  });
  const pairs: PairCheck[] = [];
  for (let a = 0; a < source.atoms.length; a++) for (let b = a + 1; b < source.atoms.length; b++) {
    if (graph[a].has(b) || [...graph[a]].some(n => graph[n].has(b))) continue;
    const radiusSum = radii[a] + radii[b];
    const severe = Math.min(policy.severeCeilingAngstrom, Math.max(policy.severeFloorAngstrom, policy.severeRadiusRatio * radiusSum));
    pairs.push({ a, b, severe, contact: Math.max(severe, policy.contactRadiusRatio * radiusSum) });
  }
  return pairs;
}
function inspectPairs(structure: Structure, pairs: readonly PairCheck[]): ConformerClashSummary {
  let severePairs = 0, contactPairs = 0, closest: PairCheck | undefined, closestDistance = Infinity;
  for (const p of pairs) {
    const a = structure.atoms[p.a], b = structure.atoms[p.b], distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    if (!Number.isFinite(distance)) throw new Error('构象避碰坐标无效。');
    if (distance < closestDistance) { closestDistance = distance; closest = p; }
    if (distance < p.severe) severePairs++;
    else if (distance < p.contact) contactPairs++;
  }
  return { severity: severePairs ? 'severe' : contactPairs ? 'contact' : 'clear', severePairs, contactPairs,
    ...(closest ? { closestPair: { atomIds: [structure.atoms[closest.a].id!, structure.atoms[closest.b].id!] as [string, string],
      distanceAngstrom: closestDistance, severeThresholdAngstrom: closest.severe } } : {}) };
}
export function inspectConformerClashes(snapshot: ConformerSnapshot, candidate: Structure = snapshot.structure,
  policy: ConformerClashPolicy = DEFAULT_CONFORMER_CLASH_POLICY): ConformerClashSummary {
  assertConformerGeometryProtected(snapshot, candidate);
  return inspectPairs(candidate, preparePairs(snapshot.structure, policy));
}
const defaultRange = (): TorsionAngleRange => ({ startDegrees: -180, endDegrees: 180 });

function inAllRanges(structure: Structure, entries: readonly ConformerTorsionSampling[]): boolean {
  return entries.every(e => torsionAngleInRange(builderCoordinateValue(structure, 'D', e.torsion.atomIds), e.range ?? defaultRange()));
}
function repair(snapshot: ConformerSnapshot, structure: Structure, entries: readonly ConformerTorsionSampling[],
  pairs: readonly PairCheck[], policy: ConformerClashPolicy): { structure: Structure; clash: ConformerClashSummary; attempts: number } | { attempts: number } {
  let attempts = 0;
  // Each trial starts from the same guess. No incremental drift, coordinate pushing,
  // hidden FF/SCF, arbitrary global rotation, or freeze/handedness relaxation.
  // Bound proposals as well as executed repairs: an extremely small user step
  // must not loop indefinitely when every proposal lies outside a narrow arc.
  const steps = Math.min(policy.maxRepairAttempts, Math.floor((policy.maxRepairOffsetDegrees + 1e-9) / policy.repairStepDegrees));
  for (let step = 1; step <= steps; step++) {
    for (const entry of entries) for (const sign of [1, -1]) {
      if (attempts >= policy.maxRepairAttempts) return { attempts };
      const original = builderCoordinateValue(structure, 'D', entry.torsion.atomIds);
      const degrees = normalizeTorsionDegrees(original + sign * step * policy.repairStepDegrees);
      if (!torsionAngleInRange(degrees, entry.range ?? defaultRange())) continue;
      attempts++;
      try {
        const changed = rotateConformerTorsion(snapshot, entry.torsion, degrees, structure, entries.map(row => row.torsion));
        if (!inAllRanges(changed, entries)) continue;
        const clash = inspectPairs(changed, pairs);
        if (clash.severity !== 'severe') return { structure: changed, clash, attempts };
      } catch { /* Failed protected trial is not a candidate. */ }
    }
  }
  return { attempts };
}
const gcd = (a: bigint, b: bigint): bigint => { while (b) { const c = a % b; a = b; b = c; } return a; };
/** Affine permutation visits every finite combination once, without materializing the product.
 * Coprime stride distributes bounded prefixes across torsions better than plain nested loops. */
function combinationStride(size: bigint): bigint {
  if (size <= 2n) return 1n;
  let stride = size * 618033n / 1000000n || 1n;
  for (let attempts = 0; attempts < 256; attempts++, stride++) if (gcd(stride, size) === 1n) return stride;
  return 1n;
}
function sameGeometry(a: Structure, b: Structure, tolerance: number): boolean {
  return a.atoms.every((atom, i) => Math.hypot(...builderVector.sub(builderPosition(atom), builderPosition(b.atoms[i]))) <= tolerance);
}

export interface ConformerGenerationOptions {
  countMode?:'unique'|'received';
  limits?:Partial<ConformerSamplingLimits>; clashPolicy?:Partial<ConformerClashPolicy>;
  /** Explicit card-local RMSD criterion; absent preserves legacy position-only uniqueness. */
  duplicateRmsdAngstrom?:number;
  /** Same existing protected-core admission, before counting a valid guess. */
  protection?:{snapshot:ConformerSnapshot;manualAxisBonds:[string,string][]};
  resume?:{continuation:ConformerGuessContinuation;accepted:ConformerGuess[]};
  onProgress?(state:ConformerGuessSet,reliableTotal:number|null):void;
}
type GenerationOptions=ConformerGenerationOptions;
export function generateConformerGuesses(snapshot: ConformerSnapshot, entries: readonly ConformerTorsionSampling[],
  quantity: ConformerQuantityPolicy, options: GenerationOptions = {}): ConformerGuessSet {
  const iterator = generateConformerGuessSteps(snapshot, entries, quantity, options);
  let value = iterator.next(); while (!value.done) value = iterator.next(); return value.value;
}
/** The synchronous scientific algorithm also exposes safe attempt boundaries
 * for a worker to yield control and accept cancellation without losing its prefix. */
export function* generateConformerGuessSteps(snapshot: ConformerSnapshot, entries: readonly ConformerTorsionSampling[],
  quantity: ConformerQuantityPolicy, options: GenerationOptions = {}): Generator<{ state: ConformerGuessSet; total: number | null }, ConformerGuessSet> {
  const limits = { ...DEFAULT_CONFORMER_SAMPLING_LIMITS, ...options.limits };
  const received=options.countMode==='received';
  if(received&&options.resume?.continuation.schema!=='conformer-torsion-continuation/v2'&&options.resume)
    throw Error('旧版二面角游标按去重后帧数计数，不能直接继续为接收帧计数；请保留旧结果并追加新批。');
  for (const value of [limits.maxCandidates, limits.maxAttempts, limits.maxAtoms, limits.maxTorsions]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('构象采样资源上限必须为正整数。');
  }
  if (!Number.isFinite(limits.duplicatePositionAngstrom) || limits.duplicatePositionAngstrom <= 0) throw new Error('构象去重容差无效。');
  if (!entries.length || entries.length > limits.maxTorsions || snapshot.structure.atoms.length > limits.maxAtoms) throw new Error('构象初猜超出本次有界几何处理范围。');
  if (!['per-torsion', 'total-effective'].includes(quantity.mode)) throw new Error('未知构象数量模式。');
  const axes = new Set<string>();
  entries.forEach(entry => {
    const inspected = (entry.torsion.origin === 'manual' ? inspectManualConformerTorsion : inspectConformerTorsion)(snapshot, entry.torsion.atomIds, entry.torsion.movingSide);
    if (!inspected.accepted) throw new Error(`二面角不准入：${inspected.reason}`);
    const axis = JSON.stringify(entry.torsion.atomIds.slice(1, 3).sort());
    if (axes.has(axis)) throw new Error('同一旋转轴不能重复参与组合采样。');
    axes.add(axis);
    sampleTorsionAngles(entry.pointCount ?? quantity.pointsPerTorsion, entry.range);
  });
  if (quantity.mode === 'total-effective' && (!Number.isSafeInteger(quantity.targetCount) || quantity.targetCount < 1
    || quantity.targetCount > limits.maxCandidates)) throw new Error('有效初猜目标数须为本次候选上限内的正整数。');
  const automatic=quantity.mode==='total-effective'&&quantity.automaticPointAllocation===true;
  let allocated=entries.map(entry=>({...entry,enabled:true,pointCount:entry.pointCount??quantity.pointsPerTorsion}));
  if(automatic&&quantity.mode==='total-effective')allocated=allocateConformerTorsionPoints(allocated,quantity.targetCount);
  const policy = { ...DEFAULT_CONFORMER_CLASH_POLICY, ...options.clashPolicy };
  if(options.duplicateRmsdAngstrom!==undefined&&(!Number.isFinite(options.duplicateRmsdAngstrom)||options.duplicateRmsdAngstrom<0))throw Error('本卡采样RMSD阈值须为有限非负数。');
  const scientificEntries=entries.map(({pointCount,...entry})=>automatic&&entry.pointCountMode!=='manual'?entry:{...entry,pointCount:pointCount??quantity.pointsPerTorsion});
  const fallbackIsScientific=!automatic||entries.some(entry=>entry.pointCountMode==='manual'&&entry.pointCount===undefined);
  const configurationIdentity=sha256Utf8(JSON.stringify({snapshot,entries:scientificEntries,quantity:{mode:quantity.mode,...(fallbackIsScientific?{pointsPerTorsion:quantity.pointsPerTorsion}:{}),automaticPointAllocation:automatic},policy,
    ...(received?{countMode:'received'}:{duplicatePositionAngstrom:limits.duplicatePositionAngstrom,duplicateRmsdAngstrom:options.duplicateRmsdAngstrom??null}),protection:options.protection??null}));
  const resumed=options.resume?structuredClone(options.resume):undefined;
  if(resumed){
    const cursor=resumed.continuation;
    if(cursor.schema!==(received?'conformer-torsion-continuation/v2':'conformer-torsion-continuation/v1')||cursor.configurationIdentity!==configurationIdentity)throw Error('二面角接续信息不属于当前初猜或科学配置。');
    if(!Number.isSafeInteger(cursor.round)||cursor.round<0||!/^\d+$/.test(cursor.nextOrdinal)||!Array.isArray(cursor.pointCounts)||cursor.pointCounts.length!==entries.length
      ||!Array.isArray(cursor.visited)||new Set(cursor.visited).size!==cursor.visited.length||cursor.visited.some(v=>typeof v!=='string')
      ||![cursor.attempts,cursor.acceptedCount,cursor.repairAttempts,...Object.values(cursor.rejected)].every(v=>Number.isSafeInteger(v)&&v>=0)
      ||cursor.attempts!==cursor.visited.length||cursor.acceptedCount!==resumed.accepted.length||!Array.isArray(cursor.pointAllocations)||typeof cursor.exhausted!=='boolean')throw Error('二面角接续游标或本卡有效结果不完整。');
    if(cursor.acceptedCount+cursor.rejected.severeClash+cursor.rejected.duplicate+cursor.rejected.geometry!==cursor.attempts
      ||(cursor.rejected.coreProtection??0)>cursor.rejected.geometry)throw Error('二面角接续的完整尝试与接纳/拒绝计数不一致。');
    const ids=new Set<string>();for(const guess of resumed.accepted){
      if(ids.has(guess.id)||guess.attempt>cursor.attempts||JSON.stringify(guess.source)!==JSON.stringify(snapshot.source))throw Error('二面角接续结果身份或来源不符。');
      ids.add(guess.id);assertConformerGeometryProtected(snapshot,guess.structure,entries.filter(entry=>entry.torsion.origin==='manual').map(entry=>[entry.torsion.atomIds[1],entry.torsion.atomIds[2]]));
    }
    allocated=allocated.map((entry,index)=>({...entry,pointCount:cursor.pointCounts[index]}));
  }
  let grids=allocated.map(entry=>sampleTorsionAngles(entry.pointCount,entry.range));
  let space=grids.reduce((product,grid)=>product*BigInt(grid.length),1n);
  const requested=quantity.mode==='total-effective'?BigInt(quantity.targetCount):space;
  const target=Number(requested>BigInt(limits.maxCandidates)?BigInt(limits.maxCandidates):requested);
  const cursor:ConformerGuessContinuation=resumed?.continuation??{schema:received?'conformer-torsion-continuation/v2':'conformer-torsion-continuation/v1',...(received?{countMode:'received' as const}:{}),configurationIdentity,
    round:0,pointCounts:allocated.map(entry=>entry.pointCount),nextOrdinal:'0',visited:[],attempts:0,acceptedCount:0,
    rejected:{severeClash:0,duplicate:0,geometry:0},repairAttempts:0,pointAllocations:[],exhausted:false};
  if(BigInt(cursor.nextOrdinal)>space)throw Error('二面角接续组合位置超出当前网格。');
  const pairs = preparePairs(snapshot.structure, policy);
  const result:ConformerGuessSet={guesses:resumed?.accepted??[],quantity:{...quantity},requestedEffectiveCount:requested.toString(),boundedTargetCount:target,
    combinationSpace:space.toString(),attempts:cursor.attempts,rejected:{...cursor.rejected},repairAttempts:cursor.repairAttempts,
    status:'partial',stopReason:'attempt-limit',pointAllocations:cursor.pointAllocations,continuation:cursor};
  // A work budget ends this invocation only; the next request resumes exactly
  // here. It cannot be reported as exhaustion of the allowed combinations.
  const attemptBudget=Math.min(limits.maxAttempts,Math.max(4096,target*32));
  const startedAttempts=result.attempts,visited=new Set(cursor.visited),compare=createConformerGeometryComparer();let stride=combinationStride(space);
  const sync=()=>{cursor.attempts=result.attempts;cursor.acceptedCount=result.guesses.length;cursor.rejected={...result.rejected};cursor.repairAttempts=result.repairAttempts;};
  while(!cursor.exhausted&&result.attempts-startedAttempts<attemptBudget&&result.guesses.length<target){
    let ordinal=BigInt(cursor.nextOrdinal);
    if(ordinal>=space){
      if(!automatic){cursor.exhausted=true;break;}
      const expanded=allocateConformerTorsionPoints(allocated,Number(space>BigInt(Number.MAX_SAFE_INTEGER)/2n?BigInt(Number.MAX_SAFE_INTEGER):space*2n));
      if(expanded.every((entry,index)=>entry.pointCount===allocated[index].pointCount)){cursor.exhausted=true;break;}
      allocated=expanded;grids=allocated.map(entry=>sampleTorsionAngles(entry.pointCount,entry.range));space=grids.reduce((product,grid)=>product*BigInt(grid.length),1n);
      stride=combinationStride(space);
      cursor.round++;cursor.pointCounts=allocated.map(entry=>entry.pointCount);cursor.nextOrdinal='0';ordinal=0n;result.combinationSpace=space.toString();
    }
    const allocation=cursor.pointAllocations[cursor.round]??(cursor.pointAllocations[cursor.round]={pointCounts:[...cursor.pointCounts],combinationSpace:space.toString(),attempts:0});
    const total=automatic||space>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(space);
    sync();yield {state:result,total};options.onProgress?.(result,total);
    let index=ordinal*stride%space;
    const pointIndices:number[]=[];
    const targets = grids.map(grid => { const pointIndex=Number(index % BigInt(grid.length));pointIndices.push(pointIndex);const value = grid[pointIndex]; index /= BigInt(grid.length); return value; });
    const signature=targets.map(value=>value.toFixed(10)).join(',');
    if(visited.has(signature)){cursor.nextOrdinal=(ordinal+1n).toString();continue;}
    visited.add(signature);cursor.visited.push(signature);result.attempts++;allocation.attempts++;
    try{
    let structure: Structure = snapshot.structure;
    try {
      entries.forEach((entry, i) => { structure = rotateConformerTorsion(snapshot, entry.torsion, targets[i], structure, entries.map(row => row.torsion)); });
      if (!inAllRanges(structure, entries)) throw new Error('目标范围不满足。');
    } catch { result.rejected.geometry++; continue; }
    let clash = inspectPairs(structure, pairs), repairAttempts = 0, repaired = false;
    if (clash.severity === 'severe') {
      const fixed = repair(snapshot, structure, entries, pairs, policy);
      result.repairAttempts += fixed.attempts; repairAttempts = fixed.attempts;
      if (!('structure' in fixed)) { result.rejected.severeClash++; continue; }
      structure = fixed.structure; clash = fixed.clash; repaired = true;
    }
    if(options.protection){try{assertConformerGeometryProtected(options.protection.snapshot,structure,options.protection.manualAxisBonds);}catch{result.rejected.geometry++;result.rejected.coreProtection=(result.rejected.coreProtection??0)+1;continue;}}
    if(!received&&result.guesses.some(guess=>{if(sameGeometry(guess.structure,structure,limits.duplicatePositionAngstrom))return true;
      if(options.duplicateRmsdAngstrom===undefined||guess.structure.charge!==structure.charge||guess.structure.multiplicity!==structure.multiplicity)return false;
      const fit=compare(structure,guess.structure);return fit.comparable&&fit.rmsdAngstrom<options.duplicateRmsdAngstrom;})){result.rejected.duplicate++;continue;}
    result.guesses.push({ id: `guess-${result.attempts}`, source: { ...snapshot.source }, structure,
      sourceAtomIds: snapshot.structure.atoms.map(a => a.id!), attempt: result.attempts, clash, repaired, repairAttempts,
      torsions: entries.map((entry, i) => ({ atomIds: [...entry.torsion.atomIds], targetDegrees: targets[i],pointIndex:pointIndices[i],pointCount:grids[i].length,
        actualDegrees: builderCoordinateValue(structure, 'D', entry.torsion.atomIds) })) });
    }finally{cursor.nextOrdinal=(ordinal+1n).toString();sync();}
  }
  if(!automatic&&BigInt(cursor.nextOrdinal)===space)cursor.exhausted=true;
  sync();
  if (result.guesses.length >= target) {
    result.status = requested <= BigInt(limits.maxCandidates) ? 'complete' : 'partial';
    result.stopReason = result.status === 'complete' ? 'target-reached' : 'candidate-limit';
  } else result.stopReason=cursor.exhausted?'combination-space-exhausted':'attempt-limit';
  return result;
}
