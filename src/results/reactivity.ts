import { convertEnergy } from './energy';
import type { SurfaceStamp } from './surface-contracts';
import type { ReactivityAnalysisResult, ReactivityMetricKey } from './reactivity-contracts';

const metricKeys: readonly ReactivityMetricKey[] = ['homo', 'lumo', 'gap', 'ip', 'ea', 'chi', 'mu', 'eta', 'softness', 'omega', 'NNu'];
const contextKeys = ['sourceId', 'sourceRevision', 'jobIndex', 'sourceFrameIndex', 'generation', 'documentId', 'documentRevision', 'activationEpoch', 'analysisId', 'requestId'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const ordinal = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function near(left: number, right: number, tolerance = 1e-9) { return Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right)); }
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Renderer/host admission for identity, units and independently recomputed
 * formula relationships. No scientific calculation or native launch occurs. */
export function validateReactivityAnalysisResult(value: unknown, stamp: SurfaceStamp, atomCount?: number, wavefunctionSourceId?: string): ReactivityAnalysisResult {
  requireValue(record(value) && record(value.stamp) && contextKeys.every(key => value.stamp[key] === stamp[key]), 'FMO source/request identity differs.');
  requireValue(value.approximation === 'frozen-orbital' && value.partition === 'hirshfeld', 'Unsupported FMO approximation or partition.');
  requireValue(record(value.capabilities) && typeof value.capabilities.global === 'boolean' && typeof value.capabilities.condensed === 'boolean'
    && typeof value.capabilities.orbitalDisplay === 'boolean' && Array.isArray(value.capabilities.reasons) && value.capabilities.reasons.every((item: unknown) => typeof item === 'string'), 'Invalid FMO capabilities.');
  requireValue(Array.isArray(value.notices) && value.notices.every((item: unknown) => typeof item === 'string') && Array.isArray(value.frontier), 'Invalid FMO notices/frontier.');
  const spins = new Set<string>();
  for (const channel of value.frontier) {
    requireValue(record(channel) && ['restricted', 'alpha', 'beta'].includes(channel.spin) && !spins.has(channel.spin), 'Invalid or duplicate FMO spin channel.');
    spins.add(channel.spin);
    requireValue(Number.isSafeInteger(channel.homoDegeneracy) && channel.homoDegeneracy >= 0 && Number.isSafeInteger(channel.lumoDegeneracy) && channel.lumoDegeneracy >= 0, 'Invalid FMO degeneracy evidence.');
    for (const orbital of [channel.homo, channel.lumo]) {
      if (orbital === null) continue;
      requireValue(record(orbital) && orbital.spin === channel.spin && ordinal(orbital.ordinal) && ordinal(orbital.sourceIndex) && ordinal(orbital.nativeIndex)
        && orbital.key === `${channel.spin}:${orbital.ordinal}` && finite(orbital.energyHartree) && finite(orbital.energyEV) && finite(orbital.occupation) && orbital.occupation >= 0 && orbital.occupation <= 2, 'Invalid FMO source orbital identity.');
      requireValue(near(orbital.energyEV, convertEnergy({ value: orbital.energyHartree, unit: 'hartree' }, 'eV')!), 'FMO source orbital energy unit differs.');
    }
  }
  requireValue(record(value.globalMetrics) && metricKeys.every(key => record(value.globalMetrics[key])
    && value.globalMetrics[key].unit === (key === 'softness' ? 'eV^-1' : 'eV')
    && (finite(value.globalMetrics[key].value) || (value.globalMetrics[key].value === null && typeof value.globalMetrics[key].reason === 'string'))), 'Invalid FMO global metrics or units.');
  const metrics = value.globalMetrics;
  const metric = (key: ReactivityMetricKey): number | null => metrics[key].value;
  const equation = (key: ReactivityMetricKey, expected: number | null) => requireValue(expected === null ? metric(key) === null : metric(key) !== null && near(metric(key)!, expected), `Inconsistent FMO ${key} definition.`);
  if (value.capabilities.global) {
    requireValue(value.frontier.length === 1 && value.frontier[0].spin === 'restricted' && Math.abs((value.frontier[0].homo?.occupation ?? -1) - 2) <= 1e-7, 'Global FMO metrics require a closed-shell occupied frontier.');
    const h = value.frontier[0].homo.energyEV, l = value.frontier[0].lumo?.energyEV ?? null;
    if (l !== null) requireValue(value.frontier[0].lumo.occupation <= 1e-7, 'Global FMO metrics require an empty virtual frontier.');
    equation('homo', h); equation('lumo', l); equation('ip', -h); equation('ea', l === null ? null : -l);
    equation('NNu', h - convertEnergy({ value: -.335198, unit: 'hartree' }, 'eV')!);
    const gap = l === null ? null : l - h, mu = l === null ? null : (h + l) / 2;
    equation('gap', gap); equation('eta', gap); equation('mu', mu); equation('chi', mu === null ? null : -mu);
    equation('softness', gap !== null && gap > 1e-10 ? 1 / gap : null);
    equation('omega', gap !== null && gap > 1e-10 && mu !== null ? mu * mu / (2 * gap) : null);
  } else requireValue(metricKeys.every(key => metric(key) === null), 'Inapplicable FMO source returned chemical descriptors.');
  requireValue(Array.isArray(value.atoms) && Array.isArray(value.integrals), 'Invalid FMO atom/integral tables.');
  requireValue(value.capabilities.condensed ? value.atoms.length > 0 && (atomCount === undefined || value.atoms.length === atomCount) : value.atoms.length === 0, 'FMO atom result differs from its capability/inventory.');
  const atoms = value.atoms;
  for (const [index, atom] of atoms.entries()) {
    requireValue(record(atom) && atom.sourceIndex === index + 1 && typeof atom.element === 'string' && /^[A-Z][a-z]?$/.test(atom.element)
      && (atom.atomId === undefined || typeof atom.atomId === 'string'), 'Invalid FMO source atom mapping.');
    requireValue(['fPlus', 'fMinus', 'fZero', 'dual'].every(key => finite(atom[key])) && atom.fPlus >= 0 && atom.fMinus >= 0 && atom.fPlus <= 1.00001 && atom.fMinus <= 1.00001, 'Invalid FMO atomic population.');
    requireValue(near(atom.fZero, (atom.fPlus + atom.fMinus) / 2) && near(atom.dual, atom.fPlus - atom.fMinus), 'Inconsistent FMO local response.');
    for (const [key, globalKey, fKey] of [['omega', 'omega', 'fPlus'], ['NNu', 'NNu', 'fMinus'], ['sPlus', 'softness', 'fPlus'], ['sMinus', 'softness', 'fMinus'], ['sZero', 'softness', 'fZero']] as const) {
      const factor = metric(globalKey);
      requireValue(factor === null ? atom[key] === null : finite(atom[key]) && near(atom[key], factor * atom[fKey]), `Inconsistent FMO local ${key}.`);
    }
  }
  const tolerance = atoms.length * .00001 / 2 + 1e-9;
  if (atoms.length) {
    requireValue(value.capabilities.global && value.frontier[0].homoDegeneracy === 1 && value.frontier[0].lumoDegeneracy === 1, 'Ambiguous frontier returned single-orbital local FMO descriptors.');
    for (const key of ['fPlus', 'fMinus', 'fZero'] as const) requireValue(Math.abs(atoms.reduce((sum: number, atom: any) => sum + atom[key], 0) - 1) <= tolerance, 'FMO atom population sum differs from native precision.');
    requireValue(Math.abs(atoms.reduce((sum: number, atom: any) => sum + atom.dual, 0)) <= tolerance * 2, 'FMO dual descriptor sum differs from zero.');
    requireValue(value.integrals.length === 2, 'Missing FMO raw integral evidence.');
    const expected = [value.frontier[0].homo, value.frontier[0].lumo];
    value.integrals.forEach((integral: any, index: number) => requireValue(record(integral) && integral.orbitalKey === expected[index].key && integral.sourceIndex === expected[index].nativeIndex
      && finite(integral.rawSum) && Math.abs(integral.rawSum - 1) <= .005 && integral.rawSumUnit === 'fraction' && integral.nativeNormalization === true
      && integral.printedFractionPrecision === .00001 && finite(integral.normalizedPrintedSum) && Math.abs(integral.normalizedPrintedSum - 1) <= tolerance, 'Invalid raw FMO Hirshfeld integration evidence.'));
  } else requireValue(value.integrals.length === 0, 'An empty local FMO result retained unrelated integral evidence.');
  requireValue(record(value.provenance) && typeof value.provenance.sourceId === 'string' && value.provenance.sourceId.length > 0
    && (wavefunctionSourceId === undefined || value.provenance.sourceId === wavefunctionSourceId) && value.provenance.sourceRevision === stamp.sourceRevision
    && /^[a-f0-9]{64}$/.test(value.provenance.sourceRevision) && typeof value.provenance.sourceName === 'string', 'Invalid FMO provenance source.');
  const provenance = value.provenance;
  requireValue(record(provenance.parameters) && provenance.parameters.hardnessConvention === 'eta=IP-EA;S=1/eta;omega=mu^2/(2eta)'
    && provenance.parameters.tceHomoHartree === -.335198 && provenance.parameters.tceReferenceLevel === 'B3LYP/6-31G*'
    && ['matched', 'unmatched', 'unknown'].includes(provenance.parameters.tceLevelMatch) && provenance.parameters.degeneracyScreenEV === .01, 'Invalid FMO convention/reference.');
  requireValue(Array.isArray(provenance.rawArtifacts), 'Invalid FMO raw artifacts.');
  if (atoms.length) requireValue(provenance.settlement === 'native-settled' && record(provenance.backend) && provenance.backend.name === 'Multiwfn'
    && typeof provenance.backend.version === 'string' && ordinal(provenance.backend.threads) && provenance.rawArtifacts.length === 1
    && provenance.rawArtifacts.every((artifact: any) => record(artifact) && artifact.role === 'native-output' && typeof artifact.name === 'string' && /^[a-f0-9]{64}$/.test(artifact.revision) && ordinal(artifact.bytes)), 'FMO native settlement/evidence is incomplete.');
  else requireValue(provenance.settlement === 'not-started' && provenance.backend === null && provenance.rawArtifacts.length === 0, 'FMO no-native result has inconsistent settlement evidence.');
  return structuredClone(value) as ReactivityAnalysisResult;
}
