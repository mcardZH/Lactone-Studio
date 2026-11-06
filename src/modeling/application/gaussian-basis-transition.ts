import type { BuilderAssignments } from '../../core/builder-draft';
import { captureBuilderAssignments } from '../../core/builder-integration';
import { defaultMixedBasis } from '../../core/mixed-basis';
import type { GaussianSettings, Structure } from '../../core/types';
import type { ModelStore } from '../contracts';
import type { GaussianBasisState } from '../../core/modeling/contracts';
export type { GaussianBasisState } from '../../core/modeling/contracts';

export type GaussianBasisAction = { type: 'basis'; basis: string } | { type: 'mixed'; enabled: boolean };

export function captureGaussianBasisState(settings: GaussianSettings): GaussianBasisState {
  return structuredClone({ basis: settings.basis, mixedBasis: settings.mixedBasis,
    inheritedBasis: { basisKeyword: settings.inheritedRoute?.basisKeyword, basisTail: settings.inheritedRoute?.basisTail },
    basisIssues: (settings.inheritanceIssues ?? []).filter(issue => issue.field === 'basis' || issue.field === 'mixedBasis') });
}

export function restoreGaussianBasisState(settings: GaussianSettings, state: GaussianBasisState): GaussianSettings {
  const inheritedRoute = { ...settings.inheritedRoute };
  delete inheritedRoute.basisKeyword; delete inheritedRoute.basisTail;
  return { ...settings, basis: state.basis, mixedBasis: structuredClone(state.mixedBasis),
    inheritedRoute: { ...inheritedRoute, ...structuredClone(state.inheritedBasis) },
    ...(state.basisIssues !== undefined ? { inheritanceIssues: [...(settings.inheritanceIssues ?? []).filter(issue => issue.field !== 'basis' && issue.field !== 'mixedBasis'), ...structuredClone(state.basisIssues)] } : {}) };
}

/** Selecting a builtin basis exits mixed mode; a later enable begins with empty regions. */
export function transitionGaussianBasis(settings: GaussianSettings, action: GaussianBasisAction): GaussianSettings {
  const inheritedRoute = { ...settings.inheritedRoute };
  delete inheritedRoute.basisKeyword; delete inheritedRoute.basisTail;
  const mixedBasis = { ...(settings.mixedBasis ?? defaultMixedBasis()),
    enabled: action.type === 'mixed' && action.enabled,
    regions: action.type === 'mixed' && action.enabled && settings.mixedBasis?.enabled ? structuredClone(settings.mixedBasis.regions) : [] };
  return { ...settings, basis: action.type === 'basis' ? action.basis : settings.basis, mixedBasis, inheritedRoute,
    inheritanceIssues: settings.inheritanceIssues?.filter(issue => issue.field !== 'basis' && issue.field !== 'mixedBasis') };
}

/** Seed the pre-edit snapshot without a history step, then commit controls and memberships together. */
export function applyGaussianBasisTransition(store: ModelStore, structure: Structure | null,
  settings: GaussianSettings, action: GaussianBasisAction): GaussianSettings {
  const next = transitionGaussianBasis(settings, action);
  const previousAssignments = settings.mixedBasis?.enabled ? captureBuilderAssignments(structure, settings).basis : [];
  store.synchronizeGaussianBasisState?.(captureGaussianBasisState(settings), previousAssignments);
  const assignments: BuilderAssignments['basis'] = next.mixedBasis?.enabled ? captureBuilderAssignments(structure, next).basis : [];
  store.execute({ type: 'set-gaussian-basis-state', state: captureGaussianBasisState(next), assignments });
  return next;
}
