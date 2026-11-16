import type { WavefunctionAnalysisRequest } from './wavefunction-analysis';
import type { GeneratedXtbProvenance } from './xtb-generated-source';

/** Bind permissions to the actual analysis role without altering the raw asset identity. */
export function generatedXtbAnalysisRevision(source:GeneratedXtbProvenance,currentRevision?:string):string {
  const role=source.kind==='trusted-generated-gxtb-sp'?'analysis-molden':'molden';
  const files=source.files.filter(file=>file.role===role);
  return files.length===1&&(currentRevision===undefined||currentRevision===files[0].sha256)?files[0].sha256:'';
}

/** Mirror of the trusted host policy, never inferred from a filename or method.
 * These are applicability permissions, not properties measured in the source.
 * Only the host determines closed-shell eligibility from source print evidence.
 */
export const GENERATED_XTB_POLICY_VERSION = 'generated-gfn2-prerequisites-20261023-2' as const;
export const GENERATED_GXTB_POLICY_VERSION = 'generated-gxtb-valence-20261111-1' as const;
export interface GeneratedXtbAnalysisPolicy {
  schema: 'sciyue-generated-analysis-policy/v1';
  policyVersion: typeof GENERATED_XTB_POLICY_VERSION | typeof GENERATED_GXTB_POLICY_VERSION;
  sourceRevision: string;
  requestedUhf: number;
  sourceSpinResolution: 'spin-summed' | 'restricted' | 'alpha-beta';
  chargeMethods: readonly ('mulliken' | 'lowdin' | 'adch' | 'hirshfeld' | 'hirshfeld-i' | 'cm5' | 'resp' | 'scpa')[];
  compositionMethods: readonly ('mulliken' | 'scpa')[];
  bondOrderMethods: readonly ('mayer' | 'wiberg-lowdin' | 'mulliken' | 'laplacian' | 'fuzzy')[];
  spinPopulation: boolean;
  spinDensity: false;
  independentAlphaBeta: boolean;
  realSpaceMethods: readonly ('esp' | 'alie' | 'iri' | 'rdg' | 'igmh')[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isGeneratedXtbAnalysisPolicy(value: unknown, sourceRevision: string): value is GeneratedXtbAnalysisPolicy {
  if (!object(value) || value.schema !== 'sciyue-generated-analysis-policy/v1' || value.policyVersion !== GENERATED_XTB_POLICY_VERSION && value.policyVersion !== GENERATED_GXTB_POLICY_VERSION
    || !/^[a-f0-9]{64}$/.test(sourceRevision) || value.sourceRevision !== sourceRevision || !Number.isSafeInteger(value.requestedUhf) || Number(value.requestedUhf) < 0
    || value.spinDensity !== false) return false;
  const gxtb=value.policyVersion===GENERATED_GXTB_POLICY_VERSION;
  if(gxtb){
    if(value.sourceSpinResolution!=='restricted'&&value.sourceSpinResolution!=='alpha-beta')return false;
    if(value.sourceSpinResolution==='restricted'&&value.requestedUhf!==0)return false;
  }else if(value.sourceSpinResolution!=='spin-summed')return false;
  const independent=value.sourceSpinResolution==='alpha-beta';
  if(value.spinPopulation!==independent||value.independentAlphaBeta!==independent)return false;
  const subset = (candidate: unknown, methods: readonly string[]) => Array.isArray(candidate) && new Set(candidate).size===candidate.length && candidate.every(v => methods.includes(v));
  return subset(value.chargeMethods, ['mulliken','lowdin','adch','hirshfeld','hirshfeld-i','cm5','resp','scpa']) && subset(value.compositionMethods, ['mulliken','scpa'])
    && subset(value.realSpaceMethods, ['esp','alie','iri','rdg','igmh']) && subset(value.bondOrderMethods,gxtb||value.requestedUhf===0?['mayer','wiberg-lowdin','mulliken','laplacian','fuzzy']:['laplacian']);
}

/** Unknown kinds and unaccepted methods fail closed for this generated source. */
export function generatedXtbMethodAllowed(policy: unknown, sourceRevision: string, kind: string, method: string): boolean {
  if (!isGeneratedXtbAnalysisPolicy(policy, sourceRevision)) return false;
  const allowed: Readonly<Record<string, readonly string[]>> = { charges: policy.chargeMethods, composition: policy.compositionMethods, 'bond-orders': policy.bondOrderMethods, surface:policy.realSpaceMethods.filter(value=>value==='esp'||value==='alie'),interaction:policy.realSpaceMethods.filter(value=>value==='iri'||value==='rdg'||value==='igmh') };
  return allowed[kind]?.includes(method) ?? false;
}

/** Ordinary external sources retain their existing general-method behavior. */
export function wavefunctionMethodAllowedByPolicy(metadata: { sourceRevision: string; analysisPolicy?: GeneratedXtbAnalysisPolicy }, request: Pick<WavefunctionAnalysisRequest, 'kind' | 'method'>): boolean {
  return metadata.analysisPolicy === undefined || generatedXtbMethodAllowed(metadata.analysisPolicy, metadata.sourceRevision, request.kind, request.method);
}
