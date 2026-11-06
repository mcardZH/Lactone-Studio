import { getSolventEntries, type SolventEngine } from './index';
import type { SolventEntry, SolventModel, SolventSelection } from './types';

export const CUSTOM_EPS_INF = 1.9;
export const CUSTOM_REFRACTIVE_INDEX = Math.sqrt(CUSTOM_EPS_INF);

export function pcmSolventModel(engine: SolventEngine): SolventModel {
  return engine === 'gaussian' ? 'iefpcm' : 'cpcm';
}

/** The approved new defaults are deliberately limited to SP and ground-state optimization. */
export function defaultSolventModel(engine: SolventEngine, task: string | undefined, fallback: SolventModel): SolventModel {
  if (task === 'sp') return 'smd';
  if (task === 'opt' || task === 'optfreq') return pcmSolventModel(engine);
  return fallback;
}

export function isEpsilonOnlySolvent(selection: SolventSelection | undefined): boolean {
  return selection?.mode === 'custom' && selection.custom?.opticalApproximation === 'epsinf-1.9';
}

/** Call only after a deliberate new-custom selection or a confirmed conversion. */
export function createEpsilonOnlySolvent(dielectric = Number.NaN): SolventSelection {
  return { mode: 'custom', custom: {
    name: 'custom-epsilon', dielectric, refractiveIndex: CUSTOM_REFRACTIVE_INDEX,
    opticalApproximation: 'epsinf-1.9',
  } };
}

/** Task changes preserve manual model choices and legacy scientific descriptor sets. */
export function solventModelForTaskChange(options: {
  engine: SolventEngine; task: string; currentModel: SolventModel;
  manuallySelected?: boolean; selection?: SolventSelection;
}): SolventModel {
  if (isEpsilonOnlySolvent(options.selection)) return pcmSolventModel(options.engine);
  if (options.manuallySelected || options.selection?.mode === 'custom') return options.currentModel;
  return defaultSolventModel(options.engine, options.task, options.currentModel);
}

/**
 * Only for an explicit UI model/task change. Match reviewed environment identity
 * within the source's exact profile; writers still reject unresolved source IDs.
 * No descriptors are copied between the two official model-specific entries.
 */
export function solventSelectionForModelChange(options: {
  engine: SolventEngine; selection?: SolventSelection;
  currentModel: SolventModel; nextModel: SolventModel; version?: number | string;
}): SolventSelection | undefined {
  const { engine, selection, currentModel, nextModel, version } = options;
  if (selection?.mode !== 'builtin' || !selection.id || currentModel === nextModel) return selection;
  if (getSolventEntries(engine, nextModel, version, selection.id).some(entry => entry.id === selection.id)) return selection;

  // Discover the reviewed profile through exact ID membership, never by guessing
  // a version from a name or falling back to a newer profile in the merged UI.
  const profiles = engine === 'orca' && version === 'common' ? ['5', '6.0', '6.1'] : [version];
  const sources = profiles.flatMap(profile => {
    const entry = getSolventEntries(engine, currentModel, profile).find(value => value.id === selection.id);
    return entry ? [{ profile, entry }] : [];
  });
  if (sources.length !== 1) return selection;
  const source = sources[0];
  const keyword = (entry: SolventEntry, model: SolventModel): string | undefined => engine === 'gaussian'
    ? model === 'smd' ? entry.gaussian?.smd : entry.gaussian?.pcm
    : model === 'smd' ? entry.orca?.smd : entry.orca?.cpcm;
  // Native keywords are case insensitive. Punctuation, spacing and aliases do
  // not participate in this conservative identity comparison.
  const sameName = (a: string | undefined, b: string | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
  const candidates = getSolventEntries(engine, nextModel, source.profile).filter(entry =>
    sameName(entry.englishName, source.entry.englishName) || sameName(keyword(entry, nextModel), keyword(source.entry, currentModel)));
  return candidates.length === 1 ? { ...selection, id: candidates[0].id } : selection;
}
