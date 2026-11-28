import { createContext } from 'react';
import { isXtbMethod } from '../../core/xtb-capabilities';
import { isPesNetMethod, type PesMethodDraft, type PesProjectSnapshot } from '../../modeling/pes/contracts';
import { defaultPesMethod } from '../../modeling/pes/defaults';
import { defaultWorkspaceOptimizationPreferences, type WorkspaceOptimizationPreferences } from './tool-session';

export type ProjectOptimization = WorkspaceOptimizationPreferences & { calculationLevel: PesMethodDraft };

export const ProjectOptimizationContext = createContext<{
  preferences: ProjectOptimization;
  read(): ProjectOptimization;
  write(next: WorkspaceOptimizationPreferences): ProjectOptimization;
  prepare(): Promise<void>;
} | null>(null);

export function checkedProjectCalculationLevel(value: unknown): PesMethodDraft | undefined {
  if (typeof value !== 'object' || value === null) return;
  const row = value as Partial<PesMethodDraft>;
  const method = row.method;
  if (!method || !(isXtbMethod(method) || isPesNetMethod(method))) return;
  const solvationModel = row.solvationModel;
  if (solvationModel !== 'none' && solvationModel !== 'alpb' && solvationModel !== 'gbsa') return;
  if (typeof row.solvent !== 'string' || (solvationModel !== 'none' && !row.solvent.trim())) return;
  return { method, solvationModel, solvent: solvationModel === 'none' ? '' : row.solvent,
    ...(row.device === 'gpu' || row.device === 'cpu' ? { device: row.device } : {}) };
}

export function newProjectOptimization(level = defaultPesMethod()): ProjectOptimization {
  return { ...defaultWorkspaceOptimizationPreferences(), calculationLevel: level };
}

/** Only the selected editor may seed a migrated project. Unique legacy values
 * remain usable when the project was saved from an ordinary modeling tab. */
export function legacyProjectCalculationLevel(snapshot: PesProjectSnapshot, activeGroupId?: string): PesMethodDraft | undefined {
  const active = snapshot.groups.find(group => group.id === activeGroupId);
  const selected = checkedProjectCalculationLevel(active?.sharedMethod);
  if (selected) return selected;
  const unique = new Map(snapshot.groups.flatMap(group => {
    const level = checkedProjectCalculationLevel(group.sharedMethod);
    return level ? [[JSON.stringify(level), level] as const] : [];
  }));
  return unique.size === 1 ? unique.values().next().value : undefined;
}
