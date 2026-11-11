import { exportStructure } from '../../core/structure-export';
import type { InputStructureSource, Structure } from '../../core/types';
import type { DesktopBridge, ModelDocument } from '../../modeling/contracts';
import type { WorkspaceDocumentEntry } from '../../modeling/workspace-registry';
import type { ResultFrameSummary, ResultQuantity, TrajectoryResult } from '../../results/contracts';
import { convertEnergy } from '../../results/energy';
import { generatedXtbMethodAllowed } from '../../results/generated-xtb-policy';
import type {
  OrbitalField,
  OrbitalGridSpec,
  WavefunctionMetadata,
  WavefunctionOrbital
} from '../../results/orbital-contracts';
import {
  isScientificFileDocument,
  postprocessDipole,
  postprocessFileDisplayDocument,
  postprocessWavefunctionFrame,
  projectPostprocessFrame,
  type PostprocessAttachment,
  type PostprocessDocument,
  type PostprocessFileDocument,
  type PostprocessScientificFileDocument
} from '../../results/postprocess-document';
import { postprocessFileJob } from '../../results/postprocess-sources';
import { validateReactivityAnalysisResult } from '../../results/reactivity';
import type { ReactivityAnalysisResult } from '../../results/reactivity-contracts';
import type { ScientificData } from '../../results/scientific-contracts';
import type { SurfaceContext, SurfaceStamp } from '../../results/surface-contracts';
import type {
  AtomicChargeMethod,
  BondOrderMethod,
  OrbitalCompositionMethod,
  WavefunctionAnalysisRequest,
  WavefunctionAnalysisResult
} from '../../results/wavefunction-analysis';
import type { ExternalInputDraft } from '../../task-system/integration/input-draft';
import {
  analysisMethodAvailable,
  analysisText,
  BOND_METHODS,
  CHARGE_METHODS,
  compositionRows,
  type BondAnalysis,
  type ChargeAnalysis,
  type CompositionAnalysis
} from '../results/AnalysisControls';
import type { AnalysisPage } from '../results/PostprocessDisplayPanel';
import type { ReactivityAtomMetric } from '../results/reactivity-controls-contracts';
import { reactivityText } from '../results/reactivity-presentation';
import {
  DEFAULT_ORBITAL_SAMPLING,
  orbitalGridFor,
  type OrbitalSampling
} from '../results/useOrbitalField';
import { computeHillFormula } from './calculation-config';
import { buildExternalDraftFromSavedEntry } from './task-execution';

export interface McpAnalysisPanelRequest {
  serial: number;
  page: AnalysisPage;
}

export interface McpAnalysisFrameRequest {
  serial: number;
  frameIndex: number;
}

export interface McpAnalysisViewportOverlay {
  serial: number;
  sourceId: string;
  sourceRevision: string;
  frameIndex: number;
  page: AnalysisPage;
  chargeResult?: ChargeAnalysis;
  bondResult?: BondAnalysis;
  compositionResult?: CompositionAnalysis;
  orbitalField?: OrbitalField;
  orbitalIsovalue?: number;
  reactivityResult?: ReactivityAnalysisResult;
  reactivityMetric?: ReactivityAtomMetric;
}

export type CachedMcpAnalysisRecord =
  | {
      kind: 'charges' | 'bond-orders' | 'composition';
      method: string;
      sourceName: string;
      sourceRevision: string;
      updatedAt: number;
      result: WavefunctionAnalysisResult;
      tsv: string;
    }
  | {
      kind: 'reactivity';
      method: string;
      sourceName: string;
      sourceRevision: string;
      updatedAt: number;
      result: ReactivityAnalysisResult;
      tsv: string;
    };

export class McpAnalysisTableStore {
  private readonly byDocument = new Map<string, CachedMcpAnalysisRecord[]>();

  record(documentId: string, entry: CachedMcpAnalysisRecord): void {
    const existing = this.byDocument.get(documentId) ?? [];
    const filtered = existing.filter(
      item =>
        item.sourceRevision === entry.sourceRevision &&
        !(item.kind === entry.kind && item.method === entry.method)
    );
    filtered.push(entry);
    this.byDocument.set(documentId, filtered);
  }

  find(
    documentId: string,
    options?: {
      kind?: 'charges' | 'bond-orders' | 'composition' | 'reactivity';
      method?: string;
      expectedSourceRevision?: string | null;
    }
  ): CachedMcpAnalysisRecord | null {
    if (options?.expectedSourceRevision === null) return null;
    const entries = this.byDocument.get(documentId);
    if (!entries?.length) return null;
    const normalizedMethod = options?.method?.toLowerCase();
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i];
      if (
        options?.expectedSourceRevision !== undefined &&
        candidate.sourceRevision !== options.expectedSourceRevision
      ) {
        continue;
      }
      if (options?.kind && candidate.kind !== options.kind) continue;
      if (normalizedMethod && candidate.method.toLowerCase() !== normalizedMethod) continue;
      return candidate;
    }
    return null;
  }

  clear(documentId: string): void {
    this.byDocument.delete(documentId);
  }
}

const ORBITAL_METHOD_SPACING: Record<string, number> = {
  toy: 0.35,
  rough: 0.25,
  normal: 0.15,
  fine: 0.1
};

function roundNum(value: number | null | undefined, digits = 6): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

export function resolveOrbitalKeyAlias(
  metadata: WavefunctionMetadata,
  requestedKey: string
): WavefunctionOrbital {
  const trimmed = requestedKey.trim();
  const exact = metadata.orbitals.find(row => row.key === trimmed);
  if (exact) return exact;

  const caseInsensitiveExact = metadata.orbitals.find(
    row => row.key.toLowerCase() === trimmed.toLowerCase()
  );
  if (caseInsensitiveExact) return caseInsensitiveExact;

  const aliasMatch = /^(?:(restricted|alpha|beta|a|b)[:\s_-]+)?(homo|lumo)(?:\s*([+-])\s*(\d+))?$/i.exec(trimmed);
  if (aliasMatch) {
    const rawSpin = aliasMatch[1]?.toLowerCase();
    const preferredSpins: Array<WavefunctionOrbital['spin']> =
      rawSpin === 'alpha' || rawSpin === 'a'
        ? ['alpha']
        : rawSpin === 'beta' || rawSpin === 'b'
          ? ['beta']
          : rawSpin === 'restricted'
            ? ['restricted']
            : ['restricted', 'alpha', 'beta'];
    const targetRole = aliasMatch[2].toLowerCase() as 'homo' | 'lumo';
    const sign = aliasMatch[3];
    const offset = aliasMatch[4] ? Number.parseInt(aliasMatch[4], 10) : 0;

    if (
      (targetRole === 'homo' && sign === '+') ||
      (targetRole === 'lumo' && sign === '-')
    ) {
      throw Object.assign(
        new Error(`Invalid frontier orbital alias "${requestedKey}": use HOMO, HOMO-k, LUMO, or LUMO+k`),
        { code: 'MCP_ORBITAL_NOT_FOUND' }
      );
    }

    for (const spin of preferredSpins) {
      const channel = metadata.orbitals
        .filter(row => row.spin === spin)
        .slice()
        .sort((a, b) => {
          if (a.energy !== null && b.energy !== null && Number.isFinite(a.energy) && Number.isFinite(b.energy) && a.energy !== b.energy) {
            return a.energy - b.energy;
          }
          return a.ordinal - b.ordinal;
        });
      if (!channel.length) continue;

      const occupied = channel.filter(
        row => row.occupation !== null && Number.isFinite(row.occupation) && row.occupation > 1e-7
      );
      const homo = occupied.at(-1) ?? null;
      if (targetRole === 'homo') {
        if (!homo) continue;
        const idx = occupied.length - 1 - offset;
        if (idx >= 0 && idx < occupied.length) {
          return occupied[idx];
        }
      } else {
        const virtual = channel.filter(
          row =>
            row.occupation !== null &&
            Number.isFinite(row.occupation) &&
            row.occupation <= 1e-7 &&
            (!homo || row.ordinal > homo.ordinal || (row.energy !== null && homo.energy !== null && row.energy >= homo.energy))
        );
        if (offset >= 0 && offset < virtual.length) {
          return virtual[offset];
        }
      }
    }
  }

  const sampleKeys = metadata.orbitals.slice(0, 6).map(row => row.key).join(', ');
  throw Object.assign(
    new Error(
      `Orbital "${requestedKey}" was not found in wavefunction "${metadata.name}" (${metadata.orbitals.length} orbitals; examples: HOMO, LUMO, ${sampleKeys})`
    ),
    { code: 'MCP_ORBITAL_NOT_FOUND' }
  );
}

export function extractFrontierOrbitalsSummary(options: {
  metadata?: WavefunctionMetadata | null;
  scientific?: ScientificData;
  wavefunctionAvailable?: boolean;
}) {
  const { metadata, scientific, wavefunctionAvailable } = options;
  const channels: Array<{
    spin: 'restricted' | 'alpha' | 'beta';
    homo: { key: string; index: number; energyHartree: number | null; energyEv: number | null; occupation: number } | null;
    lumo: { key: string; index: number; energyHartree: number | null; energyEv: number | null; occupation: number } | null;
    gapEv: number | null;
  }> = [];

  if (metadata && wavefunctionAvailable !== false && metadata.orbitals.length > 0) {
    for (const spin of ['restricted', 'alpha', 'beta'] as const) {
      const spinRows = metadata.orbitals
        .filter(row => row.spin === spin)
        .slice()
        .sort((a, b) => (a.energy !== null && b.energy !== null ? a.energy - b.energy : a.ordinal - b.ordinal));
      if (!spinRows.length) continue;
      const occupied = spinRows.filter(row => row.occupation !== null && Number.isFinite(row.occupation) && row.occupation > 1e-7);
      const homoRow = occupied.at(-1) ?? null;
      const virtual = spinRows.filter(
        row =>
          row.occupation !== null &&
          Number.isFinite(row.occupation) &&
          row.occupation <= 1e-7 &&
          (!homoRow || row.ordinal > homoRow.ordinal)
      );
      const lumoRow = virtual[0] ?? null;
      const homoEv = homoRow?.energy !== null && homoRow?.energy !== undefined
        ? convertEnergy({ value: homoRow.energy, unit: 'hartree' }, 'eV')
        : null;
      const lumoEv = lumoRow?.energy !== null && lumoRow?.energy !== undefined
        ? convertEnergy({ value: lumoRow.energy, unit: 'hartree' }, 'eV')
        : null;
      channels.push({
        spin,
        homo: homoRow
          ? {
              key: homoRow.key,
              index: homoRow.displayIndex,
              energyHartree: roundNum(homoRow.energy, 6),
              energyEv: roundNum(homoEv, 4),
              occupation: homoRow.occupation ?? 0
            }
          : null,
        lumo: lumoRow
          ? {
              key: lumoRow.key,
              index: lumoRow.displayIndex,
              energyHartree: roundNum(lumoRow.energy, 6),
              energyEv: roundNum(lumoEv, 4),
              occupation: lumoRow.occupation ?? 0
            }
          : null,
        gapEv: homoEv !== null && lumoEv !== null ? roundNum(lumoEv - homoEv, 4) : null
      });
    }
  } else if (scientific?.orbitals.length) {
    for (const spin of ['restricted', 'alpha', 'beta'] as const) {
      const channel = scientific.orbitals.filter(row => row.spin === spin).at(-1);
      if (!channel?.orbitals.length) continue;
      const sorted = [...channel.orbitals].sort((a, b) => a.energy - b.energy || a.index - b.index);
      const occupied = sorted.filter(row => Number.isFinite(row.occupation) && row.occupation > 1e-7);
      const homoRow = occupied.at(-1) ?? null;
      const virtual = sorted.filter(row => Number.isFinite(row.occupation) && row.occupation <= 1e-7 && (!homoRow || row.index > homoRow.index));
      const lumoRow = virtual[0] ?? null;
      const toHartree = (val: number) => convertEnergy({ value: val, unit: channel.unit }, 'hartree');
      const toEv = (val: number) => convertEnergy({ value: val, unit: channel.unit }, 'eV');
      const homoEv = homoRow ? toEv(homoRow.energy) : null;
      const lumoEv = lumoRow ? toEv(lumoRow.energy) : null;
      channels.push({
        spin,
        homo: homoRow
          ? {
              key: `printed:${spin}:${homoRow.index}`,
              index: homoRow.index,
              energyHartree: roundNum(toHartree(homoRow.energy), 6),
              energyEv: roundNum(homoEv, 4),
              occupation: homoRow.occupation
            }
          : null,
        lumo: lumoRow
          ? {
              key: `printed:${spin}:${lumoRow.index}`,
              index: lumoRow.index,
              energyHartree: roundNum(toHartree(lumoRow.energy), 6),
              energyEv: roundNum(lumoEv, 4),
              occupation: lumoRow.occupation
            }
          : null,
        gapEv: homoEv !== null && lumoEv !== null ? roundNum(lumoEv - homoEv, 4) : null
      });
    }
  }

  const primary = channels[0] ?? null;
  return {
    available: channels.length > 0,
    homoEv: primary?.homo?.energyEv ?? null,
    lumoEv: primary?.lumo?.energyEv ?? null,
    gapEv: primary?.gapEv ?? null,
    channels
  };
}

function resolveSummaryEnergy(options: {
  frameSummary?: ResultFrameSummary;
  scientific?: ScientificData;
  fallbackScientific?: ScientificData;
  frameIndex?: number;
}): { raw: ResultQuantity | null; quantity: string | null } {
  const { frameSummary, scientific, fallbackScientific, frameIndex } = options;
  if (frameSummary?.energy && Number.isFinite(frameSummary.energy.value)) {
    return {
      raw: frameSummary.energy,
      quantity: frameSummary.energyQuantity ?? 'electronic'
    };
  }

  const candidateFields = [
    ...(scientific?.properties ?? []),
    ...(scientific?.summary ?? []),
    ...(fallbackScientific && fallbackScientific !== scientific
      ? [...fallbackScientific.properties, ...fallbackScientific.summary]
      : [])
  ];
  const matchesFrame = (fieldFrame: number | null | undefined) =>
    frameIndex === undefined || fieldFrame === undefined || fieldFrame === null || fieldFrame === frameIndex;

  for (const tier of ['target', 'scf'] as const) {
    for (let idx = candidateFields.length - 1; idx >= 0; idx--) {
      const field = candidateFields[idx];
      if (!matchesFrame(field.frameIndex)) continue;
      if (typeof field.value !== 'number' || !Number.isFinite(field.value) || !field.unit) continue;
      const isTargetKey =
        field.key === 'target-energy' ||
        field.key === 'total-energy' ||
        field.key === 'electronic-energy' ||
        field.key === 'final-energy' ||
        field.key === 'excited-total-energy' ||
        field.key === 'Total Energy' ||
        field.key === 'MP2 Energy' ||
        field.key === 'CCSD Energy' ||
        field.key === 'CCSD(T) Energy' ||
        field.key === 'CIS Energy' ||
        field.key === 'TD Energy' ||
        field.key.startsWith('energy-') ||
        (field.key.startsWith('orca-') &&
          field.key.endsWith('-total-energy') &&
          field.key !== 'orca-scf-total-energy');
      const isScfKey =
        field.key === 'scf-energy' ||
        field.key === 'orca-scf-total-energy' ||
        field.key === 'sc-plus-nl-energy' ||
        field.key === 'SCF Energy';
      if (tier === 'target' && !isTargetKey) continue;
      if (tier === 'scf' && !isScfKey) continue;
      const candidate: ResultQuantity = { value: field.value, unit: field.unit };
      if (convertEnergy(candidate, 'hartree') !== null) {
        return {
          raw: candidate,
          quantity: isScfKey ? 'scf-ground' : 'electronic'
        };
      }
    }
  }

  const cycles = scientific?.scfCycles?.length
    ? scientific.scfCycles
    : (fallbackScientific?.scfCycles ?? []);
  for (let idx = cycles.length - 1; idx >= 0; idx--) {
    const cycle = cycles[idx];
    if (!matchesFrame(cycle.frameIndex)) continue;
    const lastPoint = cycle.points.at(-1);
    if (lastPoint && lastPoint.energy !== null && Number.isFinite(lastPoint.energy) && cycle.unit) {
      const candidate: ResultQuantity = { value: lastPoint.energy, unit: cycle.unit };
      if (convertEnergy(candidate, 'hartree') !== null) {
        return {
          raw: candidate,
          quantity: 'scf-cycle'
        };
      }
    }
  }

  return { raw: null, quantity: frameSummary?.energyQuantity ?? null };
}

export function summarizeAnalysisTarget(options: {
  documentId: string;
  label: string;
  postprocessDocument?: PostprocessDocument | null;
  fileDocument?: PostprocessScientificFileDocument | null;
  trajectoryResult?: TrajectoryResult | null;
  currentFrameIndex?: number;
  currentStructure?: Structure | null;
  activePanel?: AnalysisPage | null;
}): Record<string, unknown> {
  const { documentId, label, activePanel } = options;
  const resolvedPostprocess =
    options.postprocessDocument ??
    (options.fileDocument ? postprocessFileDisplayDocument(options.fileDocument) : null);

  if (resolvedPostprocess) {
    const result = resolvedPostprocess.result;
    const frameCount = result.frames.length;
    const clampedFrame = frameCount > 0
      ? Math.max(0, Math.min(options.currentFrameIndex ?? Math.max(0, frameCount - 1), frameCount - 1))
      : 0;
    const frameSummary: ResultFrameSummary | undefined = result.frames[clampedFrame];
    const projected = frameCount > 0
      ? projectPostprocessFrame(resolvedPostprocess, clampedFrame)
      : {
          scientific: result.scientific,
          wavefunctionAvailable: false,
          frameIndex: 0,
          result
        };
    const scientific = projected.scientific ?? result.scientific;
    const structure = options.currentStructure ?? result.initialStructure;

    const resolvedEnergy = resolveSummaryEnergy({
      frameSummary,
      scientific,
      fallbackScientific: result.scientific,
      frameIndex: frameCount > 0 ? clampedFrame : undefined
    });
    const rawEnergy = resolvedEnergy.raw;
    const hartree = rawEnergy ? convertEnergy(rawEnergy, 'hartree') : null;
    const eV = rawEnergy ? convertEnergy(rawEnergy, 'eV') : null;
    const kcalPerMol = rawEnergy ? convertEnergy(rawEnergy, 'kcal/mol') : null;
    const scfStatus = scientific?.diagnostics?.scf.at(-1)?.status ?? null;

    // Resolve Gaussian --Link1-- Opt+Freq continuation partners when present so
    // converged optimization frames surface linked frequencies/thermochemistry and
    // linked frequency jobs retain optimization convergence status.
    let continuationFrequencyJob: TrajectoryResult | null = null;
    let continuationOptimizationJob: TrajectoryResult | null = null;
    for (const attachment of [resolvedPostprocess.output, ...(resolvedPostprocess.companions ?? [])]) {
      if (!attachment) continue;
      const continuations = attachment.source.nativeContinuations ?? [];
      for (const proof of continuations) {
        const optJob = attachment.source.results.find(r => r.id === proof.optimizationResultId);
        const freqJob = attachment.source.results.find(r => r.id === proof.frequencyResultId);
        if (!optJob || !freqJob) continue;
        const isOnOptFinalFrame =
          result.source.id === optJob.source.id &&
          result.jobIndex === optJob.jobIndex &&
          clampedFrame === Math.max(0, result.frames.length - 1);
        if (isOnOptFinalFrame) {
          continuationFrequencyJob ??= freqJob;
        }
        const isOnFreqJob =
          result.source.id === freqJob.source.id && result.jobIndex === freqJob.jobIndex;
        if (isOnFreqJob) {
          continuationOptimizationJob ??= optJob;
        }
      }
    }

    const optTaskStatus =
      scientific?.diagnostics?.tasks.find(
        t => t.task === 'opt' || t.task === 'optimization' || t.task === 'ts' || t.task === 'ts-optimization'
      )?.status ??
      continuationOptimizationJob?.scientific?.diagnostics?.tasks.find(
        t => t.task === 'opt' || t.task === 'optimization' || t.task === 'ts' || t.task === 'ts-optimization'
      )?.status ??
      null;
    const rawConvergence = frameSummary?.convergence?.length
      ? frameSummary.convergence
      : (continuationOptimizationJob?.frames.at(-1)?.convergence ?? []);
    const convergenceCriteria = rawConvergence.map(item => ({
      label: item.label,
      value: item.value,
      threshold: item.threshold,
      converged: item.converged,
      unit: item.unit
    }));

    const companionFreqResult = (resolvedPostprocess.companions ?? []).find(
      comp => comp.source.result.scientific?.vibrations?.modes?.length
    )?.source.result;
    const modes =
      scientific?.vibrations?.modes ??
      result.scientific?.vibrations?.modes ??
      continuationFrequencyJob?.scientific?.vibrations?.modes ??
      companionFreqResult?.scientific?.vibrations?.modes ??
      [];
    const vibrationalModes = modes.filter(mode => mode.kind !== 'translation' && mode.kind !== 'rotation');
    const imaginaryModes = vibrationalModes.filter(mode => Number.isFinite(mode.frequency) && mode.frequency < 0);
    const sortedFreqs = [...vibrationalModes]
      .filter(mode => Number.isFinite(mode.frequency))
      .sort((a, b) => a.frequency - b.frequency);

    const rawThermo = scientific?.thermochemistry?.length
      ? scientific.thermochemistry
      : result.scientific?.thermochemistry?.length
        ? result.scientific.thermochemistry
        : (continuationFrequencyJob?.scientific?.thermochemistry ??
           companionFreqResult?.scientific?.thermochemistry ??
           []);
    const thermochemistryFields = rawThermo.map(field => ({
      key: field.key,
      label: field.label,
      value: field.value,
      ...(field.unit ? { unit: field.unit } : {}),
      ...(field.rawValue ? { rawValue: field.rawValue } : {})
    }));

    const metadata = resolvedPostprocess.wavefunction?.source.metadata ?? null;
    const frontierOrbitals = extractFrontierOrbitalsSummary({
      metadata,
      scientific: scientific ?? result.scientific,
      wavefunctionAvailable: projected.wavefunctionAvailable
    });

    const excitedSource = scientific?.excitedStates?.length
      ? scientific.excitedStates
      : (result.scientific?.excitedStates ?? []);
    const excitedStates = excitedSource.slice(0, 20).map(state => ({
      index: state.index,
      label: state.label,
      multiplicity: state.multiplicity,
      energyEv: roundNum(state.energyEv, 4),
      ...(state.wavelengthNm !== undefined ? { wavelengthNm: roundNum(state.wavelengthNm, 2) } : {}),
      ...(state.oscillatorStrength !== undefined ? { oscillatorStrength: roundNum(state.oscillatorStrength, 5) } : {})
    }));

    const atomicProps = scientific?.atomicProperties?.length
      ? scientific.atomicProperties
      : (result.scientific?.atomicProperties ?? []);
    const printedSchemes = [...new Set(atomicProps.map(prop => `${prop.kind}:${prop.scheme}`))];

    const dipoleInfo = postprocessDipole(scientific ?? result.scientific, clampedFrame);
    const dipole = dipoleInfo
      ? {
          vector: dipoleInfo.vector.map(v => roundNum(v, 5)),
          magnitude: roundNum(Math.hypot(...dipoleInfo.vector), 5),
          unit: dipoleInfo.unit
        }
      : null;

    const waveFrame = postprocessWavefunctionFrame(resolvedPostprocess);

    return {
      documentId,
      label,
      documentKind: options.fileDocument ? 'scientific-file' : 'postprocess-document',
      engine: result.source.software ?? result.engine,
      status: result.status,
      taskTypes: [
        ...new Set([
          ...(result.scientific?.tasks ?? []),
          ...(continuationFrequencyJob?.scientific?.tasks ?? []),
          ...(continuationOptimizationJob?.scientific?.tasks ?? [])
        ])
      ],
      route: result.scientific?.route ?? '',
      messages: result.messages,
      frameCount,
      currentFrameIndex: clampedFrame,
      atomCount: structure.atoms.length,
      formula: computeHillFormula(structure.atoms),
      charge: structure.charge,
      multiplicity: structure.multiplicity,
      ...(activePanel ? { activePanel } : {}),
      energy: {
        hartree: roundNum(hartree, 8),
        eV: roundNum(eV, 6),
        kcalPerMol: roundNum(kcalPerMol, 4),
        quantity: resolvedEnergy.quantity ?? 'electronic',
        scfConverged: scfStatus ? scfStatus === 'converged' : null,
        optimizationStatus: optTaskStatus,
        convergenceCriteria
      },
      vibrations: {
        available: vibrationalModes.length > 0,
        modeCount: vibrationalModes.length,
        imaginaryCount: imaginaryModes.length,
        imaginaryFrequenciesCm1: imaginaryModes.map(mode => roundNum(mode.frequency, 2)),
        lowestFrequenciesCm1: sortedFreqs.slice(0, 6).map(mode => roundNum(mode.frequency, 2)),
        modesSample: sortedFreqs.slice(0, 10).map(mode => ({
          index: mode.index,
          frequencyCm1: roundNum(mode.frequency, 2),
          ...(mode.irIntensity !== undefined ? { irIntensity: roundNum(mode.irIntensity, 3) } : {}),
          ...(mode.ramanActivity !== undefined ? { ramanActivity: roundNum(mode.ramanActivity, 3) } : {})
        }))
      },
      thermochemistry: {
        available: thermochemistryFields.length > 0,
        fields: thermochemistryFields
      },
      frontierOrbitals,
      excitedStates: {
        available: excitedSource.length > 0,
        count: excitedSource.length,
        states: excitedStates
      },
      printedCharges: {
        available: printedSchemes.length > 0,
        schemes: printedSchemes
      },
      dipole,
      wavefunction: {
        available: Boolean(metadata),
        pairedWithCurrentFrame: projected.wavefunctionAvailable,
        pairedFrameIndex: waveFrame,
        format: metadata?.format ?? null,
        name: metadata?.name ?? null,
        basisCount: metadata?.basisCount ?? null,
        orbitalCount: metadata?.orbitals.length ?? null,
        generatedXtb: Boolean(resolvedPostprocess.wavefunction?.source.generatedXtb)
      }
    };
  }

  if (options.fileDocument) {
    const job = postprocessFileJob(options.fileDocument.output.source);
    const scientific = job?.scientific;
    const inputStructure = scientific?.inputGeometry?.structure ?? null;
    const modes = scientific?.vibrations?.modes ?? [];
    const vibrationalModes = modes.filter(mode => mode.kind !== 'translation' && mode.kind !== 'rotation');
    const imaginaryModes = vibrationalModes.filter(mode => Number.isFinite(mode.frequency) && mode.frequency < 0);
    const jobCharge = job && 'charge' in job ? job.charge : job?.initialStructure.charge;
    const jobMultiplicity = job && 'multiplicity' in job ? job.multiplicity : job?.initialStructure.multiplicity;
    const resolvedEnergy = resolveSummaryEnergy({ scientific });
    const rawEnergy = resolvedEnergy.raw;
    const scfStatus = scientific?.diagnostics?.scf.at(-1)?.status ?? null;
    return {
      documentId,
      label,
      documentKind: 'scientific-file',
      engine: job?.engine ?? 'unknown',
      status: job?.status ?? 'unknown',
      taskTypes: scientific?.tasks ?? [],
      route: scientific?.route ?? '',
      messages: job?.messages ?? [],
      frameCount: 0,
      currentFrameIndex: 0,
      atomCount: inputStructure?.atoms.length ?? 0,
      formula: inputStructure ? computeHillFormula(inputStructure.atoms) : '',
      charge: jobCharge ?? inputStructure?.charge ?? null,
      multiplicity: jobMultiplicity ?? inputStructure?.multiplicity ?? null,
      ...(activePanel ? { activePanel } : {}),
      energy: {
        hartree: rawEnergy ? roundNum(convertEnergy(rawEnergy, 'hartree'), 8) : null,
        eV: rawEnergy ? roundNum(convertEnergy(rawEnergy, 'eV'), 6) : null,
        kcalPerMol: rawEnergy ? roundNum(convertEnergy(rawEnergy, 'kcal/mol'), 4) : null,
        quantity: resolvedEnergy.quantity,
        scfConverged: scfStatus ? scfStatus === 'converged' : null,
        optimizationStatus: null,
        convergenceCriteria: []
      },
      vibrations: {
        available: vibrationalModes.length > 0,
        modeCount: vibrationalModes.length,
        imaginaryCount: imaginaryModes.length,
        imaginaryFrequenciesCm1: imaginaryModes.map(mode => roundNum(mode.frequency, 2)),
        lowestFrequenciesCm1: vibrationalModes.slice(0, 6).map(mode => roundNum(mode.frequency, 2)),
        modesSample: []
      },
      thermochemistry: {
        available: Boolean(scientific?.thermochemistry.length),
        fields: (scientific?.thermochemistry ?? []).map(field => ({
          key: field.key,
          label: field.label,
          value: field.value,
          ...(field.unit ? { unit: field.unit } : {})
        }))
      },
      frontierOrbitals: extractFrontierOrbitalsSummary({ scientific }),
      excitedStates: {
        available: Boolean(scientific?.excitedStates.length),
        count: scientific?.excitedStates.length ?? 0,
        states: (scientific?.excitedStates ?? []).slice(0, 20).map(s => ({
          index: s.index,
          label: s.label,
          multiplicity: s.multiplicity,
          energyEv: roundNum(s.energyEv, 4),
          ...(s.wavelengthNm !== undefined ? { wavelengthNm: roundNum(s.wavelengthNm, 2) } : {}),
          ...(s.oscillatorStrength !== undefined ? { oscillatorStrength: roundNum(s.oscillatorStrength, 5) } : {})
        }))
      },
      printedCharges: {
        available: Boolean(scientific?.atomicProperties.length),
        schemes: [...new Set((scientific?.atomicProperties ?? []).map(prop => `${prop.kind}:${prop.scheme}`))]
      },
      dipole: null,
      wavefunction: {
        available: Boolean(options.fileDocument.wavefunction?.source.metadata),
        pairedWithCurrentFrame: false,
        pairedFrameIndex: null,
        format: options.fileDocument.wavefunction?.source.metadata?.format ?? null,
        name: options.fileDocument.wavefunction?.source.metadata?.name ?? null,
        basisCount: options.fileDocument.wavefunction?.source.metadata?.basisCount ?? null,
        orbitalCount: options.fileDocument.wavefunction?.source.metadata?.orbitals.length ?? null,
        generatedXtb: false
      }
    };
  }

  if (options.trajectoryResult) {
    const result = options.trajectoryResult;
    const frameCount = result.frames.length;
    const clampedFrame = frameCount > 0
      ? Math.max(0, Math.min(options.currentFrameIndex ?? Math.max(0, frameCount - 1), frameCount - 1))
      : 0;
    const frameSummary = result.frames[clampedFrame];
    const structure = options.currentStructure ?? result.initialStructure;
    const rawEnergy = frameSummary?.energy ?? null;
    return {
      documentId,
      label,
      documentKind: 'trajectory-document',
      engine: result.source.software ?? result.engine,
      status: result.status,
      taskTypes: result.scientific?.tasks ?? [],
      route: result.scientific?.route ?? '',
      messages: result.messages,
      frameCount,
      currentFrameIndex: clampedFrame,
      atomCount: structure.atoms.length,
      formula: computeHillFormula(structure.atoms),
      charge: structure.charge,
      multiplicity: structure.multiplicity,
      ...(activePanel ? { activePanel } : {}),
      energy: {
        hartree: rawEnergy ? roundNum(convertEnergy(rawEnergy, 'hartree'), 8) : null,
        eV: rawEnergy ? roundNum(convertEnergy(rawEnergy, 'eV'), 6) : null,
        kcalPerMol: rawEnergy ? roundNum(convertEnergy(rawEnergy, 'kcal/mol'), 4) : null,
        quantity: frameSummary?.energyQuantity ?? 'electronic',
        scfConverged: null,
        optimizationStatus: null,
        convergenceCriteria: frameSummary?.convergence ?? []
      },
      vibrations: { available: false, modeCount: 0, imaginaryCount: 0, imaginaryFrequenciesCm1: [], lowestFrequenciesCm1: [], modesSample: [] },
      thermochemistry: { available: false, fields: [] },
      frontierOrbitals: extractFrontierOrbitalsSummary({ scientific: result.scientific }),
      excitedStates: { available: false, count: 0, states: [] },
      printedCharges: { available: false, schemes: [] },
      dipole: null,
      wavefunction: {
        available: false,
        pairedWithCurrentFrame: false,
        pairedFrameIndex: null,
        format: null,
        name: null,
        basisCount: null,
        orbitalCount: null,
        generatedXtb: false
      }
    };
  }

  throw Object.assign(
    new Error(`Document "${documentId}" does not contain any calculation result or wavefunction data for analysis`),
    { code: 'MCP_ANALYSIS_UNAVAILABLE' }
  );
}

interface AnalysisDeadlineController {
  readonly cancelled: boolean;
  throwIfCancelled(): void;
  onCancel(handler: () => Promise<void> | void): void;
  race<T>(promise: Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

function createAnalysisDeadlineController(timeoutSeconds: number | undefined): AnalysisDeadlineController {
  const effectiveSeconds = timeoutSeconds ?? 300;
  const deadlineAt = Date.now() + effectiveSeconds * 1000;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelPromise: Promise<void> | null = null;
  const cancelHandlers = new Set<() => Promise<void> | void>();
  const pendingRejecters = new Set<(error: Error) => void>();

  const makeTimeoutError = () =>
    Object.assign(
      new Error(`Multiwfn wavefunction analysis timed out after ${effectiveSeconds}s`),
      { code: 'MCP_WAVEFUNCTION_TIMEOUT' }
    );

  const triggerTimeout = () => {
    if (cancelled) return;
    cancelled = true;
    const handlers = [...cancelHandlers];
    cancelHandlers.clear();
    cancelPromise = Promise.allSettled(
      handlers.map(fn => Promise.resolve().then(fn))
    ).then(() => undefined);
    const err = makeTimeoutError();
    const rejecters = [...pendingRejecters];
    pendingRejecters.clear();
    for (const reject of rejecters) {
      reject(err);
    }
  };

  const armTimer = () => {
    if (cancelled || timer !== null) return;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      triggerTimeout();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      triggerTimeout();
    }, remainingMs);
  };

  return {
    get cancelled() {
      if (!cancelled && Date.now() >= deadlineAt) {
        triggerTimeout();
      }
      return cancelled;
    },
    throwIfCancelled() {
      if (!cancelled && Date.now() >= deadlineAt) {
        triggerTimeout();
      }
      if (cancelled) {
        throw makeTimeoutError();
      }
    },
    onCancel(handler) {
      if (cancelled) {
        const next = Promise.resolve().then(handler).catch(() => {});
        cancelPromise = cancelPromise ? cancelPromise.then(() => next) : next;
        return;
      }
      cancelHandlers.add(handler);
    },
    async race<T>(promise: Promise<T>): Promise<T> {
      this.throwIfCancelled();
      armTimer();
      let onReject!: (error: Error) => void;
      const timeoutRace = new Promise<never>((_, reject) => {
        onReject = reject;
        pendingRejecters.add(reject);
      });
      try {
        return await Promise.race([promise, timeoutRace]);
      } finally {
        pendingRejecters.delete(onReject);
      }
    },
    async dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      cancelHandlers.clear();
      pendingRejecters.clear();
      if (cancelPromise) {
        await cancelPromise;
      }
    }
  };
}

async function closeTemporaryOrbitalSession(desktop: DesktopBridge, sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  if (desktop.closeOrbitalSession) {
    await desktop.closeOrbitalSession(sessionId).catch(() => {});
    return;
  }
  if (desktop.commandOrbitals) {
    await desktop.commandOrbitals(sessionId, { operation: 'close' }).catch(() => {});
  }
}

async function acquireTemporaryOrbitalSession(options: {
  desktop: DesktopBridge;
  attachment: PostprocessAttachment;
  metadata: WavefunctionMetadata;
  prefix: string;
  deadline: AnalysisDeadlineController;
  onSessionAllocated: (sessionId: string) => void;
}): Promise<{ sessionId: string; metadata: WavefunctionMetadata }> {
  const { desktop, attachment, metadata, prefix, deadline, onSessionAllocated } = options;
  deadline.throwIfCancelled();

  if (attachment.nativeSessionId && desktop.forkOrbitalSession) {
    const forkPromise = desktop.forkOrbitalSession(
      attachment.nativeSessionId,
      `${prefix}-${crypto.randomUUID()}`
    );
    // Guarantee zero native session leaks even if deadline expires before forkOrbitalSession settles
    void forkPromise
      .then(forked => {
        if (deadline.cancelled) {
          void closeTemporaryOrbitalSession(desktop, forked.sessionId);
        }
      })
      .catch(() => {});
    const forked = await deadline.race(forkPromise);
    onSessionAllocated(forked.sessionId);
    deadline.throwIfCancelled();
    return forked;
  }

  if (!attachment.readSourceText || !desktop.openOrbitalSession) {
    throw Object.assign(
      new Error('Wavefunction source lacks native session fork or source-text reader capability'),
      { code: 'MCP_WAVEFUNCTION_SESSION_UNAVAILABLE' }
    );
  }
  const raw = await deadline.race(attachment.readSourceText());
  deadline.throwIfCancelled();

  const tempId = `${prefix}-${crypto.randomUUID()}`;
  onSessionAllocated(tempId);
  const openPromise = desktop.openOrbitalSession({
    sessionId: tempId,
    sourceId: raw.sourceId,
    name: raw.name,
    text: raw.text,
    sourceToken: raw.sourceToken
  });
  void openPromise
    .then(() => {
      if (deadline.cancelled) {
        void closeTemporaryOrbitalSession(desktop, tempId);
      }
    })
    .catch(() => {});
  const parsed = await deadline.race(openPromise);
  deadline.throwIfCancelled();
  return {
    sessionId: tempId,
    metadata: {
      ...parsed,
      structure: metadata.structure,
      ...(metadata.analysisPolicy ? { analysisPolicy: metadata.analysisPolicy } : {})
    }
  };
}

export async function executeWavefunctionAnalysis(options: {
  documentId: string;
  document: PostprocessDocument;
  structure: Structure;
  modelDocument?: ModelDocument;
  frameIndex: number;
  desktop: DesktopBridge | undefined;
  tableStore: McpAnalysisTableStore;
  overlaySerial: number;
  params: {
    kind: 'charges' | 'bond-orders' | 'composition' | 'orbitals' | 'reactivity';
    method?: string;
    orbitalKey?: string;
    isovalue?: number;
    gridSpacingAngstrom?: number;
    renderInViewport: boolean;
    timeoutSeconds?: number;
  };
}): Promise<{
  response: Record<string, unknown>;
  targetPanel: AnalysisPage;
  targetFrameIndex: number;
  overlay: McpAnalysisViewportOverlay | null;
}> {
  const { documentId, document, desktop, tableStore, overlaySerial, params } = options;
  const attachment = document.wavefunction;
  const metadata = attachment?.source.metadata ?? null;
  if (!attachment || !metadata) {
    throw Object.assign(
      new Error(
        `Document "${documentId}" does not have an attached wavefunction (.fchk / .molden). Call ester_open_result_analysis with source.filePath pointing to the .fchk/.molden file and documentId="${documentId}" first.`
      ),
      { code: 'MCP_WAVEFUNCTION_UNAVAILABLE' }
    );
  }

  const waveFrame = postprocessWavefunctionFrame(document);
  if (waveFrame === null) {
    throw Object.assign(
      new Error(
        `Wavefunction "${metadata.name}" could not be paired unambiguously with an output geometry frame in document "${documentId}".`
      ),
      { code: 'MCP_WAVEFUNCTION_UNPAIRED' }
    );
  }

  const targetFrameIndex = waveFrame;
  const projected = projectPostprocessFrame(document, targetFrameIndex);
  if (!projected.wavefunctionAvailable) {
    throw Object.assign(
      new Error(`Wavefunction is unavailable at frame ${targetFrameIndex} for document "${documentId}".`),
      { code: 'MCP_WAVEFUNCTION_UNPAIRED' }
    );
  }

  let frameStructure = options.structure;
  if (options.frameIndex !== targetFrameIndex && document.result.frames[targetFrameIndex]) {
    try {
      frameStructure = await document.result.getFrame(targetFrameIndex);
    } catch {
      frameStructure = options.structure;
    }
  }

  const generatedXtb = Boolean(attachment.source.generatedXtb);
  const analysisContext = {
    sessionId: 'policy-check',
    sourceRevision: metadata.sourceRevision,
    sourceName: metadata.name,
    sourceId: metadata.sourceId,
    format: metadata.format,
    generatedXtb,
    analysisPolicy: metadata.analysisPolicy
  };

  if (params.kind === 'orbitals' && !params.renderInViewport && !params.orbitalKey) {
    const frontier = extractFrontierOrbitalsSummary({
      metadata,
      scientific: projected.scientific,
      wavefunctionAvailable: true
    });
    return {
      targetPanel: 'orbitals',
      targetFrameIndex,
      overlay: null,
      response: {
        documentId,
        kind: 'orbitals',
        sourceName: metadata.name,
        format: metadata.format,
        basisCount: metadata.basisCount,
        orbitalCount: metadata.orbitals.length,
        renderedInViewport: false,
        frontierOrbitals: frontier,
        orbitals: metadata.orbitals.map(row => ({
          key: row.key,
          spin: row.spin,
          index: row.displayIndex,
          ordinal: row.ordinal,
          energyHartree: roundNum(row.energy, 6),
          energyEv: row.energy !== null ? roundNum(convertEnergy({ value: row.energy, unit: 'hartree' }, 'eV'), 4) : null,
          occupation: row.occupation
        }))
      }
    };
  }

  if (!desktop) {
    throw Object.assign(
      new Error('Desktop bridge is unavailable for native Multiwfn wavefunction analysis'),
      { code: 'MCP_DESKTOP_BRIDGE_UNAVAILABLE' }
    );
  }

  if (desktop.orbitalBackendInfo) {
    const backend = await desktop.orbitalBackendInfo();
    if (!backend.configured) {
      throw Object.assign(
        new Error(
          backend.message ||
            'Multiwfn backend is not configured. Configure Multiwfn in Global Settings or set SCIYUE_MULTIWFN.'
        ),
        { code: 'MCP_MULTIWFN_NOT_CONFIGURED' }
      );
    }
  }

  if (params.kind === 'charges' || params.kind === 'bond-orders' || params.kind === 'composition') {
    const effectiveMethod =
      params.kind === 'charges'
        ? (params.method ?? 'cm5')
        : params.kind === 'bond-orders'
          ? (params.method ?? 'mayer')
          : (params.method ?? (generatedXtb ? 'scpa' : 'mulliken'));

    if (!analysisMethodAvailable(params.kind, effectiveMethod, analysisContext)) {
      const reason =
        effectiveMethod === 'bader'
          ? 'Bader charge analysis requires an all-electron or pseudopotential .fchk wavefunction source (not Molden or generated xTB).'
          : generatedXtb && !generatedXtbMethodAllowed(metadata.analysisPolicy, metadata.sourceRevision, params.kind, effectiveMethod)
            ? `Method "${effectiveMethod}" is not permitted for generated GFN2-xTB wavefunctions.`
            : `Method "${effectiveMethod}" is not supported for ${params.kind}.`;
      throw Object.assign(new Error(reason), { code: 'MCP_METHOD_NOT_AVAILABLE' });
    }

    const resolvedOrbital =
      params.kind === 'composition'
        ? resolveOrbitalKeyAlias(metadata, params.orbitalKey!)
        : null;

    const deadline = createAnalysisDeadlineController(params.timeoutSeconds);
    let ownedSessionId: string | null = null;
    deadline.onCancel(async () => {
      if (ownedSessionId) {
        await desktop.cancelWavefunctionAnalysis?.(ownedSessionId).catch(() => {});
      }
    });

    try {
      const opened = await acquireTemporaryOrbitalSession({
        desktop,
        attachment,
        metadata,
        prefix: 'mcp-wf',
        deadline,
        onSessionAllocated: id => {
          ownedSessionId = id;
        }
      });

      if (!desktop.analyzeWavefunction) {
        throw Object.assign(
          new Error('Desktop bridge does not expose analyzeWavefunction'),
          { code: 'MCP_DESKTOP_BRIDGE_UNAVAILABLE' }
        );
      }

      const request: WavefunctionAnalysisRequest =
        params.kind === 'charges'
          ? effectiveMethod === 'bader'
            ? { kind: 'charges', method: 'bader' }
            : { kind: 'charges', method: effectiveMethod as Exclude<AtomicChargeMethod, 'bader'> }
          : params.kind === 'bond-orders'
            ? { kind: 'bond-orders', method: effectiveMethod as BondOrderMethod }
            : {
                kind: 'composition',
                method: effectiveMethod as OrbitalCompositionMethod,
                orbitalKey: resolvedOrbital!.key
              };

      const rawResult = await deadline.race(
        desktop.analyzeWavefunction(opened.sessionId, request)
      );

      if (
        rawResult.sessionId !== opened.sessionId ||
        rawResult.sourceRevision !== metadata.sourceRevision ||
        rawResult.kind !== request.kind ||
        rawResult.method !== request.method ||
        (rawResult.kind === 'composition' && rawResult.orbitalKey !== resolvedOrbital!.key)
      ) {
        throw Object.assign(
          new Error('Multiwfn wavefunction analysis receipt did not match the requested source or method'),
          { code: 'MCP_WAVEFUNCTION_RECEIPT_MISMATCH' }
        );
      }

      const cleanedResult: WavefunctionAnalysisResult =
        rawResult.kind === 'charges' && (generatedXtb || metadata.analysisPolicy !== undefined)
          ? rawResult.method === 'bader'
            ? {
                ...rawResult,
                spinAvailable: false,
                atoms: rawResult.atoms.map(row => {
                  const copy = { ...row };
                  delete copy.spinPopulation;
                  return copy;
                })
              }
            : {
                ...rawResult,
                spinAvailable: false,
                atoms: rawResult.atoms.map(row => {
                  const copy = { ...row };
                  delete copy.spinPopulation;
                  return copy;
                })
              }
          : rawResult;

      const tsv = analysisText(cleanedResult, metadata.name);
      tableStore.record(documentId, {
        kind: cleanedResult.kind,
        method: cleanedResult.method,
        sourceName: metadata.name,
        sourceRevision: metadata.sourceRevision,
        updatedAt: Date.now(),
        result: cleanedResult,
        tsv
      });

      const targetPanel: AnalysisPage =
        cleanedResult.kind === 'charges'
          ? 'charges'
          : cleanedResult.kind === 'bond-orders'
            ? 'bonds'
            : 'orbitals';

      const overlay: McpAnalysisViewportOverlay | null = params.renderInViewport
        ? {
            serial: overlaySerial,
            sourceId: document.result.source.id,
            sourceRevision: metadata.sourceRevision,
            frameIndex: targetFrameIndex,
            page: targetPanel,
            ...(cleanedResult.kind === 'charges' ? { chargeResult: cleanedResult } : {}),
            ...(cleanedResult.kind === 'bond-orders' ? { bondResult: cleanedResult } : {}),
            ...(cleanedResult.kind === 'composition' ? { compositionResult: cleanedResult } : {})
          }
        : null;

      if (cleanedResult.kind === 'charges') {
        const methodLabel = CHARGE_METHODS.find(m => m.value === cleanedResult.method)?.label ?? cleanedResult.method;
        return {
          targetPanel,
          targetFrameIndex,
          overlay,
          response: {
            documentId,
            kind: 'charges',
            method: cleanedResult.method,
            methodLabel,
            unit: cleanedResult.unit,
            quantity: cleanedResult.quantity ?? 'net-charge',
            chargeSum: roundNum(cleanedResult.sum, 6),
            spinAvailable: cleanedResult.spinAvailable,
            ...(cleanedResult.chargeConvention ? { chargeConvention: cleanedResult.chargeConvention } : {}),
            backend: cleanedResult.backend,
            warnings: cleanedResult.warnings,
            renderedInViewport: params.renderInViewport,
            activePanel: targetPanel,
            frameIndex: targetFrameIndex,
            atoms: cleanedResult.atoms.map(row => ({
              index: row.sourceIndex,
              atomId: row.atomId,
              element: row.element,
              charge: roundNum(row.value, 6),
              ...(row.spinPopulation !== undefined ? { spinPopulation: roundNum(row.spinPopulation, 6) } : {}),
              ...(row.electronPopulation !== undefined ? { electronPopulation: roundNum(row.electronPopulation, 6) } : {})
            }))
          }
        };
      }

      if (cleanedResult.kind === 'bond-orders') {
        const methodLabel = BOND_METHODS.find(m => m.value === cleanedResult.method)?.label ?? cleanedResult.method;
        const significantBonds = cleanedResult.bonds
          .filter(row => Number.isFinite(row.value) && row.value > 0.05)
          .sort((a, b) => b.value - a.value);
        return {
          targetPanel,
          targetFrameIndex,
          overlay,
          response: {
            documentId,
            kind: 'bond-orders',
            method: cleanedResult.method,
            methodLabel,
            totalPairs: cleanedResult.bonds.length,
            significantBondCount: significantBonds.length,
            backend: cleanedResult.backend,
            warnings: cleanedResult.warnings,
            renderedInViewport: params.renderInViewport,
            activePanel: targetPanel,
            frameIndex: targetFrameIndex,
            bonds: significantBonds.map(row => {
              const a = frameStructure.atoms[row.sourceIndex1 - 1];
              const b = frameStructure.atoms[row.sourceIndex2 - 1];
              const distanceAngstrom =
                a && b
                  ? roundNum(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), 4)
                  : null;
              return {
                atom1: row.sourceIndex1,
                atom2: row.sourceIndex2,
                element1: a?.element ?? null,
                element2: b?.element ?? null,
                bondOrder: roundNum(row.value, 4),
                ...(distanceAngstrom !== null ? { distanceAngstrom } : {})
              };
            })
          }
        };
      }

      const topAtoms = compositionRows(cleanedResult, 'top10');
      return {
        targetPanel,
        targetFrameIndex,
        overlay,
        response: {
          documentId,
          kind: 'composition',
          method: cleanedResult.method,
          orbitalKey: cleanedResult.orbitalKey,
          orbitalEnergyEv:
            resolvedOrbital!.energy !== null
              ? roundNum(convertEnergy({ value: resolvedOrbital!.energy, unit: 'hartree' }, 'eV'), 4)
              : null,
          occupation: resolvedOrbital!.occupation,
          sumPercent: roundNum(cleanedResult.sum, 3),
          angularPercent: cleanedResult.angular,
          backend: cleanedResult.backend,
          warnings: cleanedResult.warnings,
          renderedInViewport: params.renderInViewport,
          activePanel: targetPanel,
          frameIndex: targetFrameIndex,
          topAtomContributions: topAtoms.map(row => ({
            index: row.sourceIndex,
            atomId: row.atomId,
            element: row.element,
            percent: roundNum(row.value, 3)
          })),
          atoms: cleanedResult.atoms.map(row => ({
            index: row.sourceIndex,
            atomId: row.atomId,
            element: row.element,
            percent: roundNum(row.value, 3)
          }))
        }
      };
    } finally {
      await deadline.dispose();
      await closeTemporaryOrbitalSession(desktop, ownedSessionId);
    }
  }

  if (params.kind === 'orbitals') {
    const targetOrbital = resolveOrbitalKeyAlias(metadata, params.orbitalKey ?? 'HOMO');
    const isovalue = params.isovalue ?? 0.05;
    const spacingAngstrom =
      params.gridSpacingAngstrom ??
      (params.method && ORBITAL_METHOD_SPACING[params.method] ? ORBITAL_METHOD_SPACING[params.method] : DEFAULT_ORBITAL_SAMPLING.spacingAngstrom);

    const frontier = extractFrontierOrbitalsSummary({
      metadata,
      scientific: projected.scientific,
      wavefunctionAvailable: true
    });

    if (!params.renderInViewport) {
      return {
        targetPanel: 'orbitals',
        targetFrameIndex,
        overlay: null,
        response: {
          documentId,
          kind: 'orbitals',
          selectedOrbital: {
            key: targetOrbital.key,
            spin: targetOrbital.spin,
            index: targetOrbital.displayIndex,
            energyHartree: roundNum(targetOrbital.energy, 6),
            energyEv: targetOrbital.energy !== null ? roundNum(convertEnergy({ value: targetOrbital.energy, unit: 'hartree' }, 'eV'), 4) : null,
            occupation: targetOrbital.occupation
          },
          renderedInViewport: false,
          frontierOrbitals: frontier
        }
      };
    }

    if (!desktop.planOrbitalSession || !desktop.commandOrbitals || !desktop.readOrbitalField) {
      throw Object.assign(
        new Error('Desktop bridge lacks native 3D orbital grid generation methods'),
        { code: 'MCP_DESKTOP_BRIDGE_UNAVAILABLE' }
      );
    }

    const deadline = createAnalysisDeadlineController(params.timeoutSeconds);
    let ownedSessionId: string | null = null;
    let offEvent: (() => void) | undefined;
    deadline.onCancel(async () => {
      if (ownedSessionId && desktop.commandOrbitals) {
        await desktop.commandOrbitals(ownedSessionId, { operation: 'stop' }).catch(() => {});
      }
    });

    try {
      const sampling: OrbitalSampling = {
        ...DEFAULT_ORBITAL_SAMPLING,
        spacingAngstrom
      };
      if (desktop.orbitalResourceInfo) {
        try {
          const info = await deadline.race(desktop.orbitalResourceInfo());
          if (Number.isSafeInteger(info.threads) && info.threads > 0 && Number.isSafeInteger(info.memoryBudgetBytes) && info.memoryBudgetBytes > 0) {
            sampling.threads = info.threads;
            sampling.memoryBudgetBytes = info.memoryBudgetBytes;
          }
        } catch (err) {
          if ((err as { code?: string })?.code === 'MCP_WAVEFUNCTION_TIMEOUT') throw err;
          // Retain DEFAULT_ORBITAL_SAMPLING when resource query is unavailable
        }
      }

      const grid: OrbitalGridSpec = orbitalGridFor(metadata, sampling);

      const opened = await acquireTemporaryOrbitalSession({
        desktop,
        attachment,
        metadata,
        prefix: 'mcp-orb',
        deadline,
        onSessionAllocated: id => {
          ownedSessionId = id;
        }
      });

      const sessionId = opened.sessionId;
      const plan = await deadline.race(
        desktop.planOrbitalSession(sessionId, {
          mode: 'selected',
          grid,
          threads: sampling.threads,
          memoryBudgetBytes: sampling.memoryBudgetBytes
        })
      );
      if (!plan.withinBudget) {
        throw Object.assign(
          new Error('Orbital 3D grid memory estimate exceeds current memory budget; increase gridSpacingAngstrom (e.g. 0.25).'),
          { code: 'MCP_ORBITAL_MEMORY_BUDGET' }
        );
      }

      let resolveEvent!: () => void;
      let rejectEvent!: (err: Error) => void;
      let eventSettled = false;
      const waitForCompletion = new Promise<void>((resolve, reject) => {
        resolveEvent = () => {
          if (!eventSettled) {
            eventSettled = true;
            resolve();
          }
        };
        rejectEvent = (err: Error) => {
          if (!eventSettled) {
            eventSettled = true;
            reject(err);
          }
        };
      });

      if (desktop.onOrbitalEvent) {
        offEvent = desktop.onOrbitalEvent(event => {
          if (event.sessionId !== sessionId) return;
          if (Array.isArray(event.completedKeys) && event.completedKeys.includes(targetOrbital.key)) {
            resolveEvent();
          } else if (event.status === 'failed' || event.event === 'error') {
            rejectEvent(new Error(event.message || 'Orbital grid generation failed'));
          } else if (event.status === 'stopped') {
            rejectEvent(new Error('Orbital grid generation was stopped'));
          }
        });
      }

      const ack = (await deadline.race(
        desktop.commandOrbitals(sessionId, {
          operation: 'generate-one',
          orbitalKey: targetOrbital.key
        })
      )) as { completedKeys?: readonly string[]; status?: string; message?: string } | null | undefined;

      if (ack && Array.isArray(ack.completedKeys) && ack.completedKeys.includes(targetOrbital.key)) {
        resolveEvent();
      } else if (ack?.status === 'failed') {
        rejectEvent(new Error(ack.message || 'Orbital grid generation failed'));
      } else if (!desktop.onOrbitalEvent) {
        throw new Error('Orbital generation did not complete synchronously and onOrbitalEvent is unavailable');
      }

      await deadline.race(waitForCompletion);
      offEvent?.();
      offEvent = undefined;

      const field = await deadline.race(
        desktop.readOrbitalField(sessionId, targetOrbital.key)
      );

      const overlay: McpAnalysisViewportOverlay = {
        serial: overlaySerial,
        sourceId: document.result.source.id,
        sourceRevision: metadata.sourceRevision,
        frameIndex: targetFrameIndex,
        page: 'orbitals',
        orbitalField: field,
        orbitalIsovalue: isovalue
      };

      return {
        targetPanel: 'orbitals',
        targetFrameIndex,
        overlay,
        response: {
          documentId,
          kind: 'orbitals',
          selectedOrbital: {
            key: targetOrbital.key,
            spin: targetOrbital.spin,
            index: targetOrbital.displayIndex,
            energyHartree: roundNum(targetOrbital.energy, 6),
            energyEv: targetOrbital.energy !== null ? roundNum(convertEnergy({ value: targetOrbital.energy, unit: 'hartree' }, 'eV'), 4) : null,
            occupation: targetOrbital.occupation
          },
          grid: {
            dimensions: field.grid.dimensions,
            pointCount: field.values.length,
            spacingAngstrom,
            isovalue,
            valueUnit: field.valueUnit
          },
          renderedInViewport: true,
          activePanel: 'orbitals',
          frameIndex: targetFrameIndex,
          frontierOrbitals: frontier
        }
      };
    } finally {
      offEvent?.();
      await deadline.dispose();
      await closeTemporaryOrbitalSession(desktop, ownedSessionId);
    }
  }

  // kind === 'reactivity'
  if (generatedXtb) {
    throw Object.assign(
      new Error('Conceptual DFT FMO reactivity analysis is not supported on generated GFN2-xTB wavefunctions.'),
      { code: 'MCP_METHOD_NOT_AVAILABLE' }
    );
  }
  if (!attachment.readSourceText || !desktop.openReactivitySession || !desktop.analyzeReactivity || !desktop.closeReactivitySession) {
    throw Object.assign(
      new Error('Desktop bridge or wavefunction source lacks native conceptual DFT reactivity capabilities'),
      { code: 'MCP_REACTIVITY_UNAVAILABLE' }
    );
  }

  const metric = (params.method ?? 'dual') as ReactivityAtomMetric;
  const sourceFrameIndex = document.result.frames[targetFrameIndex]?.sourceFrameIndex ?? targetFrameIndex;
  const surfaceContext: SurfaceContext = {
    sourceId: document.result.source.id,
    sourceRevision: metadata.sourceRevision,
    jobIndex: document.result.jobIndex,
    sourceFrameIndex,
    generation: 0,
    documentId: options.modelDocument?.id ?? document.id,
    documentRevision: options.modelDocument?.revision ?? 0
  };
  const reactivitySessionId = `mcp-react-${crypto.randomUUID()}`;
  const analysisId = `mcp-reactivity-${crypto.randomUUID()}`;
  const requestId = crypto.randomUUID();
  const stamp: SurfaceStamp = {
    ...surfaceContext,
    analysisId,
    requestId
  };

  const deadline = createAnalysisDeadlineController(params.timeoutSeconds);
  let sessionOpened = false;
  deadline.onCancel(async () => {
    if (sessionOpened) {
      await desktop.cancelReactivity?.(reactivitySessionId).catch(() => {});
    }
  });

  try {
    const rawSource = await deadline.race(attachment.readSourceText());
    deadline.throwIfCancelled();

    sessionOpened = true;
    const openReactivityPromise = desktop.openReactivitySession({
      sessionId: reactivitySessionId,
      source: {
        kind: 'wavefunction',
        ...rawSource,
        context: surfaceContext
      }
    });
    // Guarantee cleanup even if deadline expires while openReactivitySession is in flight
    void openReactivityPromise
      .then(() => {
        if (deadline.cancelled) {
          void desktop.closeReactivitySession!(reactivitySessionId).catch(() => {});
        }
      })
      .catch(() => {});
    await deadline.race(openReactivityPromise);
    deadline.throwIfCancelled();

    const rawResult = await deadline.race(
      desktop.analyzeReactivity(reactivitySessionId, { stamp })
    );

    const validated = validateReactivityAnalysisResult(
      rawResult,
      stamp,
      frameStructure.atoms.length,
      metadata.sourceId
    );
    const enriched: ReactivityAnalysisResult = {
      ...validated,
      atoms: validated.atoms.map((atom, idx) => ({
        ...atom,
        atomId: frameStructure.atoms[idx]?.id
      }))
    };

    const tsv = reactivityText(enriched, 4, 4);
    tableStore.record(documentId, {
      kind: 'reactivity',
      method: metric,
      sourceName: metadata.name,
      sourceRevision: metadata.sourceRevision,
      updatedAt: Date.now(),
      result: enriched,
      tsv
    });

    const overlay: McpAnalysisViewportOverlay | null = params.renderInViewport
      ? {
          serial: overlaySerial,
          sourceId: document.result.source.id,
          sourceRevision: metadata.sourceRevision,
          frameIndex: targetFrameIndex,
          page: 'reactivity',
          reactivityResult: enriched,
          reactivityMetric: metric
        }
      : null;

    return {
      targetPanel: 'reactivity',
      targetFrameIndex,
      overlay,
      response: {
        documentId,
        kind: 'reactivity',
        metric,
        approximation: enriched.approximation,
        partition: enriched.partition,
        capabilities: enriched.capabilities,
        globalMetrics: enriched.globalMetrics,
        notices: enriched.notices,
        renderedInViewport: params.renderInViewport,
        activePanel: 'reactivity',
        frameIndex: targetFrameIndex,
        atoms: enriched.atoms.map(atom => ({
          index: atom.sourceIndex,
          atomId: atom.atomId,
          element: atom.element,
          fPlus: roundNum(atom.fPlus, 5),
          fMinus: roundNum(atom.fMinus, 5),
          fZero: roundNum(atom.fZero, 5),
          dual: roundNum(atom.dual, 5),
          omega: roundNum(atom.omega, 5),
          NNu: roundNum(atom.NNu, 5),
          sPlus: roundNum(atom.sPlus, 5),
          sMinus: roundNum(atom.sMinus, 5),
          sZero: roundNum(atom.sZero, 5)
        }))
      }
    };
  } finally {
    await deadline.dispose();
    if (sessionOpened) {
      await desktop.closeReactivitySession(reactivitySessionId).catch(() => {});
    }
  }
}

function inferExportFormat(
  kind: 'structure' | 'input-script' | 'analysis-table',
  outputPath: string,
  explicitFormat?: string
): 'xyz' | 'extxyz' | 'cif' | 'poscar' | 'gjf' | 'inp' | 'tsv' {
  if (explicitFormat) {
    return explicitFormat as 'xyz' | 'extxyz' | 'cif' | 'poscar' | 'gjf' | 'inp' | 'tsv';
  }
  const lower = outputPath.trim().toLowerCase();
  if (kind === 'structure') {
    if (lower.endsWith('.extxyz')) return 'extxyz';
    if (lower.endsWith('.cif')) return 'cif';
    if (lower.endsWith('.poscar') || lower.endsWith('.vasp') || /(?:^|[\\/])poscar$/i.test(outputPath.trim())) {
      return 'poscar';
    }
    return 'xyz';
  }
  if (kind === 'input-script') {
    if (lower.endsWith('.inp')) return 'inp';
    if (lower.endsWith('.gjf') || lower.endsWith('.com')) return 'gjf';
    return 'gjf';
  }
  return 'tsv';
}

function formatPrintedChargesTsv(
  document: PostprocessFileDocument,
  frameIndex: number,
  requestedScheme?: string
): { tsv: string; scheme: string; atomCount: number } {
  const result = isScientificFileDocument(document)
    ? (postprocessFileDisplayDocument(document)?.result ?? postprocessFileJob(document.output.source))
    : document.result;
  const props = (result?.scientific?.atomicProperties ?? []).filter(
    prop => prop.kind === 'charge' && (prop.frameIndex === frameIndex || prop.frameIndex === null)
  );
  if (!props.length) {
    throw Object.assign(
      new Error('No computed wavefunction analysis table or printed atomic charges are available on this document. Run ester_run_wavefunction_analysis first.'),
      { code: 'MCP_ANALYSIS_TABLE_UNAVAILABLE' }
    );
  }
  const matched = requestedScheme
    ? props.find(prop => prop.scheme.toLowerCase().includes(requestedScheme.toLowerCase()))
    : props.at(-1);
  if (!matched) {
    throw Object.assign(
      new Error(
        `Printed charge scheme "${requestedScheme}" was not found (available: ${props.map(p => p.scheme).join(', ')})`
      ),
      { code: 'MCP_ANALYSIS_TABLE_UNAVAILABLE' }
    );
  }
  const sourceName = isScientificFileDocument(document)
    ? document.output.source.identity.name
    : document.result.source.name;
  const cleanCell = (val: unknown) => String(val ?? '').replace(/[\t\r\n]/g, ' ');
  const lines = [
    `# source=${cleanCell(sourceName)}; method=${cleanCell(matched.scheme)}; produced_by=printed; frame=${frameIndex}`,
    'source_index\telement\tvalue\tunit'
  ];
  for (const row of matched.values) {
    lines.push([row.atomIndex + 1, row.element ?? '', row.value, matched.unit].map(cleanCell).join('\t'));
  }
  return {
    tsv: `${lines.join('\n')}\n`,
    scheme: matched.scheme,
    atomCount: matched.values.length
  };
}

export function buildExportArtifactPayload(options: {
  documentId: string;
  entry?: WorkspaceDocumentEntry | null;
  postprocessDocument?: PostprocessDocument | null;
  fileDocument?: PostprocessScientificFileDocument | null;
  currentStructure?: Structure | null;
  currentFrameIndex?: number;
  tableStore: McpAnalysisTableStore;
  inputSources?: InputStructureSource[];
  captureLiveDraft?: (preferredEngine?: 'gaussian' | 'orca') => ExternalInputDraft | null | undefined;
  params: {
    kind: 'structure' | 'input-script' | 'analysis-table';
    format?: string;
    withCell?: boolean;
    analysisKind?: 'charges' | 'bond-orders' | 'composition' | 'reactivity' | 'printed-charges';
    method?: string;
    outputPath: string;
  };
}): Record<string, unknown> {
  const { documentId, params } = options;

  if (params.kind === 'structure') {
    const format = inferExportFormat('structure', params.outputPath, params.format) as
      | 'xyz'
      | 'extxyz'
      | 'cif'
      | 'poscar';
    const structure =
      options.currentStructure ??
      (options.entry
        ? options.entry.store.getSnapshot().draft.structure.atoms.length > 0
          ? options.entry.store.getSnapshot().draft.structure
          : options.entry.result?.initialStructure
        : null) ??
      options.postprocessDocument?.result.initialStructure ??
      options.fileDocument?.displayResult?.initialStructure ??
      (options.fileDocument ? postprocessFileJob(options.fileDocument.output.source)?.scientific?.inputGeometry?.structure : null);

    if (!structure || !structure.atoms.length) {
      throw Object.assign(
        new Error(`Document "${documentId}" has no exportable atomic coordinates`),
        { code: 'MCP_EMPTY_STRUCTURE' }
      );
    }

    const withCell = params.withCell ?? Boolean(structure.cell);
    let content: string;
    try {
      content = exportStructure(structure, format, withCell);
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : String(error)),
        { code: 'MCP_STRUCTURE_EXPORT_FAILED' }
      );
    }

    return {
      documentId,
      kind: 'structure',
      format,
      atomCount: structure.atoms.length,
      formula: computeHillFormula(structure.atoms),
      withCell: Boolean(withCell && structure.cell),
      content
    };
  }

  if (params.kind === 'input-script') {
    if (!options.entry) {
      throw Object.assign(
        new Error(`Document "${documentId}" is a read-only file analysis view and has no editable Gaussian/ORCA input draft`),
        { code: 'MCP_INPUT_DRAFT_MISSING' }
      );
    }
    const preferredEngine: 'gaussian' | 'orca' | undefined =
      params.format === 'inp'
        ? 'orca'
        : params.format === 'gjf'
          ? 'gaussian'
          : params.outputPath.trim().toLowerCase().endsWith('.inp')
            ? 'orca'
            : params.outputPath.trim().toLowerCase().endsWith('.gjf') || params.outputPath.trim().toLowerCase().endsWith('.com')
              ? 'gaussian'
              : undefined;

    const draft: ExternalInputDraft =
      options.captureLiveDraft?.(preferredEngine) ??
      buildExternalDraftFromSavedEntry(options.entry, preferredEngine, options.inputSources).draft;

    const actualFormat = draft.engineId === 'orca' ? 'inp' : 'gjf';
    if (params.format && params.format !== actualFormat) {
      throw Object.assign(
        new Error(`Requested format "${params.format}" does not match configured engine "${draft.engineId}"`),
        { code: 'INVALID_EXPORT_FORMAT' }
      );
    }

    return {
      documentId,
      kind: 'input-script',
      format: actualFormat,
      engine: draft.engineId,
      inputFileName: draft.inputName,
      content: draft.finalInputText.endsWith('\n') ? draft.finalInputText : `${draft.finalInputText}\n`
    };
  }

  // kind === 'analysis-table'
  const resolvedPostprocessForExport =
    options.postprocessDocument ??
    (options.fileDocument ? postprocessFileDisplayDocument(options.fileDocument) : null);
  const expectedSourceRevision = resolvedPostprocessForExport
    ? (resolvedPostprocessForExport.wavefunction?.source.metadata?.sourceRevision ?? null)
    : options.fileDocument
      ? (options.fileDocument.wavefunction?.source.metadata?.sourceRevision ?? null)
      : undefined;

  if (params.analysisKind !== 'printed-charges') {
    const cached = options.tableStore.find(documentId, {
      kind: params.analysisKind,
      method: params.method,
      expectedSourceRevision
    });
    if (cached) {
      return {
        documentId,
        kind: 'analysis-table',
        format: 'tsv',
        analysisKind: cached.kind,
        method: cached.method,
        sourceName: cached.sourceName,
        content: cached.tsv
      };
    }
    if (params.analysisKind) {
      throw Object.assign(
        new Error(
          `No cached "${params.analysisKind}"${params.method ? ` (${params.method})` : ''} table found on document "${documentId}". Run ester_run_wavefunction_analysis first.`
        ),
        { code: 'MCP_ANALYSIS_TABLE_UNAVAILABLE' }
      );
    }
  }

  const targetDoc = options.postprocessDocument ?? options.fileDocument;
  if (!targetDoc) {
    throw Object.assign(
      new Error(`No computed wavefunction analysis table or printed charges found on document "${documentId}". Run ester_run_wavefunction_analysis first.`),
      { code: 'MCP_ANALYSIS_TABLE_UNAVAILABLE' }
    );
  }
  const frameIdx = options.currentFrameIndex ?? 0;
  const printed = formatPrintedChargesTsv(targetDoc, frameIdx, params.method);
  return {
    documentId,
    kind: 'analysis-table',
    format: 'tsv',
    analysisKind: 'printed-charges',
    method: printed.scheme,
    atomCount: printed.atomCount,
    content: printed.tsv
  };
}
