import { isPeriodic } from '../../core/periodic';
import { supportsXtbOperation, XTB_METHOD_IDS } from '../../core/xtb-capabilities';
import type { AdvancedMixedSamplingDefinition, AdvancedSamplingTaskOptions } from '../../modeling/advanced/contracts';
import type { Structure } from '../../core/types';
import { getConformerSamplingCapability, NATIVE_CONFORMER_SEED_MAX, type ConformerSamplingMethod } from '../../modeling/advanced/sampling-contracts';
import { conformerSamplingSchedule } from '../../modeling/advanced/sampling-progress';
import type { ElectronicStateSourceContext } from '../../modeling/application/electronic-state-draft';
import { createConformerSnapshot, findRotatableTorsions } from '../../modeling/conformers';
import { desktopBridge } from '../../modeling/platform/desktop';
import { createMixedSamplingCard } from '../advanced/mixed-conformer-draft';
import { gxtbRunBlocked } from '../results/GxtbPathControl';

export const aseSamplingSeedMax = 0xffffffff;

export function availableSamplingCards(structure: Structure) {
  const periodic = isPeriodic(structure);
  const mdMethods = XTB_METHOD_IDS.filter(method => supportsXtbOperation(method, 'md', periodic));
  const seedRanges = { xtb: { minimum: 0, maximum: NATIVE_CONFORMER_SEED_MAX }, ase: { minimum: 0, maximum: aseSamplingSeedMax } };
  return [{ kind: 'md' as const, methods: mdMethods, integrators: periodic ? ['ase'] as const : ['xtb', 'ase'] as const,
    seedRanges: periodic ? { ase: seedRanges.ase } : seedRanges, omitSeedFor: ['gxtb'] },
  ...(!periodic ? [{ kind: 'metadynamics' as const, methods: XTB_METHOD_IDS.filter(method => supportsXtbOperation(method, 'metadynamics')),
    integrators: ['xtb'] as const, seedRanges: { xtb: seedRanges.xtb }, omitSeedFor: ['gxtb'] },
  { kind: 'conformer-search' as const, requires: 'independently rotatable torsions' }] : [])];
}

function torsionDiscovery(source: ElectronicStateSourceContext) {
  if (isPeriodic(source.structure)) return { status: 'unavailable', reason: 'fixed-cell-md-only', torsions: [], excluded: [] };
  try {
    const result = findRotatableTorsions(createConformerSnapshot(source.structure, source.ref, source.constraints));
    return {
      status: result.torsions.length ? 'available' : 'no-automatic-torsions',
      torsions: result.torsions.map(({ atomIds, sourceDegrees, movingSide }) => ({ atomIds, axisAtomIds: atomIds.slice(1, 3), sourceDegrees, movingSide })),
      excluded: result.excluded,
    };
  } catch (cause) {
    return { status: 'unavailable', reason: cause instanceof Error ? cause.message : String(cause), torsions: [], excluded: [] };
  }
}

function samplingSettings(sampling: AdvancedSamplingTaskOptions, periodic: boolean) {
  const capability = getConformerSamplingCapability({ ...sampling, periodic });
  const scheduleFields = sampling.operation === 'md' ? sampling.molecularMD :
    sampling.operation === 'metadynamics' ? sampling.metadynamics :
      sampling.operation === 'spherical-md' ? sampling.sphericalMD : sampling.annealing;
  return {
    method: sampling.method, driver: capability.driver, integrator: capability.integrator,
    dtFs: sampling.dtFs, reportEvery: sampling.reportEvery,
    ...scheduleFields,
    schedule: conformerSamplingSchedule(sampling),
  };
}

export function conformerSamplingPlan(definition: AdvancedMixedSamplingDefinition, structure: Structure) {
  const periodic = isPeriodic(structure);
  return definition.cards.map(card => card.kind === 'sampling' ?
    { cardId: card.id, kind: card.sampling.operation, ...samplingSettings(card.sampling, periodic) } :
    { cardId: card.id, kind: card.kind, quantity: card.search.quantity, maxCandidates: card.search.samplingLimits?.maxCandidates,
      torsionCount: card.search.torsions.length });
}

export async function discoverConformerSampling(source: ElectronicStateSourceContext) {
  const bridge = desktopBridge();
  const periodic = isPeriodic(source.structure), torsions = torsionDiscovery(source);
  const gxtbInfo = await Promise.resolve().then(() => bridge?.gxtbBackendInfo?.()).catch(() => undefined);
  const availableCards = availableSamplingCards(source.structure);
  const methods = availableCards.flatMap(card => 'methods' in card && card.methods ? card.methods : []);
  const runtimeEvidence = Object.fromEntries([...new Set(methods)].map(method => {
    if (method === 'gxtb') return [method, {
      state: gxtbInfo ? gxtbRunBlocked(gxtbInfo, method) ? 'unavailable' : gxtbInfo.status === 'ready' ? 'ready' : 'unverified' : 'unverified',
      status: gxtbInfo?.status, details: gxtbInfo?.details,
    }];
    return [method, { state: 'unverified' }];
  }));
  return {
    source: source.ref, atomCount: source.structure.atoms.length, periodic,
    samplingRuntimePort: bridge?.startConformerSampling && bridge.commandConformerSampling && bridge.onConformerSamplingEvent
      ? 'available' : 'unavailable',
    runtimeEvidence,
    availableSamplingCards: availableCards.map(card => {
      if (!('methods' in card) || !card.methods || !card.integrators) return { ...card, automaticTorsionStatus: torsions.status };
      const operation = card.kind;
      const choices = card.methods.map(method => ({
        method, routes: card.integrators.flatMap(integrator => {
          const supported = getConformerSamplingCapability({ operation, method: method as ConformerSamplingMethod, periodic, integrator });
          return supported.integrator === integrator ? [{ integrator, driver: supported.driver, shakeSupported: supported.shakeSupported }] : [];
        }),
      }));
      const { sampling } = createMixedSamplingCard(operation, source);
      const defaults = operation === 'md' ?
        { temperatureK: sampling.molecularTemperatureK, durationFs: sampling.molecularDurationFs, sampleEveryFs: sampling.molecularSampleEveryFs } :
        { temperatureK: sampling.temperatureK, durationFs: sampling.durationFs, sampleEveryFs: sampling.sampleEveryFs,
          depositEveryFs: sampling.depositEveryFs, heightEV: sampling.heightEV, sigmaAngstrom: sampling.sigmaAngstrom, maxHistory: sampling.maxHistory };
      const effective = getConformerSamplingCapability({ operation, method: sampling.method, periodic, integrator: periodic ? 'ase' : sampling.integrator });
      const schedule = conformerSamplingSchedule({ operation, dtFs: sampling.dtFs, reportEvery: sampling.reportEvery,
        ...(operation === 'md' ? { molecularMD: defaults } : { metadynamics: defaults }) });
      return { ...card, choices, defaults: { ...defaults, method: sampling.method, driver: effective.driver,
        integrator: effective.integrator, dtFs: sampling.dtFs, reportEvery: sampling.reportEvery, schedule } };
    }),
    torsions,
    ...(periodic ? { unavailableSamplingCards: ['metadynamics', 'conformer-search'].map(kind => ({ kind, reason: 'fixed-cell-md-only' })) } : {}),
  };
}
