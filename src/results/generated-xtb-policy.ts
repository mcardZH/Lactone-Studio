import type { WavefunctionAnalysisRequest } from './wavefunction-analysis';

/** Mirror of the trusted host policy, never inferred from a filename or method.
 * These are applicability permissions, not properties measured in the source.
 * Only the host determines closed-shell eligibility from source print evidence.
 */
export const GENERATED_XTB_POLICY_VERSION = 'generated-gfn2-prerequisites-20261023-2' as const;
export interface GeneratedXtbAnalysisPolicy {
  schema: 'sciyue-generated-analysis-policy/v1';
  policyVersion: typeof GENERATED_XTB_POLICY_VERSION;
  sourceRevision: string;
  requestedUhf: number;
  sourceSpinResolution: 'spin-summed';
  chargeMethods: readonly ('mulliken' | 'lowdin' | 'adch' | 'hirshfeld' | 'hirshfeld-i' | 'cm5' | 'resp' | 'scpa')[];
  compositionMethods: readonly ('mulliken' | 'scpa')[];
  bondOrderMethods: readonly ('mayer' | 'wiberg-lowdin' | 'mulliken' | 'laplacian' | 'fuzzy')[];
  spinPopulation: false;
  spinDensity: false;
  independentAlphaBeta: false;
  realSpaceMethods: readonly ('esp' | 'alie' | 'iri' | 'rdg' | 'igmh')[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isGeneratedXtbAnalysisPolicy(value: unknown, sourceRevision: string): value is GeneratedXtbAnalysisPolicy {
  if (!object(value) || value.schema !== 'sciyue-generated-analysis-policy/v1' || value.policyVersion !== GENERATED_XTB_POLICY_VERSION
    || !/^[a-f0-9]{64}$/.test(sourceRevision) || value.sourceRevision !== sourceRevision || !Number.isSafeInteger(value.requestedUhf) || Number(value.requestedUhf) < 0
    || value.sourceSpinResolution !== 'spin-summed' || value.spinPopulation !== false || value.spinDensity !== false || value.independentAlphaBeta !== false) return false;
  const subset = (candidate: unknown, methods: readonly string[]) => Array.isArray(candidate) && new Set(candidate).size===candidate.length && candidate.every(v => methods.includes(v));
  return subset(value.chargeMethods, ['mulliken','lowdin','adch','hirshfeld','hirshfeld-i','cm5','resp','scpa']) && subset(value.compositionMethods, ['mulliken','scpa'])
    && subset(value.realSpaceMethods, ['esp','alie','iri','rdg','igmh']) && subset(value.bondOrderMethods,value.requestedUhf===0?['mayer','wiberg-lowdin','mulliken','laplacian','fuzzy']:['laplacian']);
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
