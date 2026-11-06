import type { GaussianSettings, JobRequest, Structure } from '../../core/types';
import type { OrcaJobRequest } from '../../core/orca';
import type { SharedModelConstraints } from '../../modeling/contracts';
import { isQstTask } from '../../core/gaussian-qst';
import { applySharedGaussianConstraints } from '../../modeling/application/gaussian-bridge';
import { applySharedOrcaConstraints } from '../../modeling/application/orca-bridge';
import { linkedInputSourceSignature, linkedOrcaInputSourceSignature } from '../../modeling/application/input-source-signature';
import type { createInputExportGuard, GuardedInputRequest, InputExportSnapshot } from '../../modeling/application/input-export-guard';

type Engine = 'gaussian' | 'orca';
type PauseGuard = ReturnType<typeof createInputExportGuard>;
interface PausedInputPorts {
  createGuard(): PauseGuard;
  readSharedConstraints(): SharedModelConstraints | undefined;
  pauseAndSnapshot(): Promise<InputExportSnapshot> | undefined;
  layerCapabilityFor(engine: Engine, structure: Structure | null): string | null;
  currentSources(): JobRequest['inputSources'];
}

/** Serialize only task conditions; geometry/revision remain owned by the existing guard. */
export function inputExportConditions(target: Engine, request: JobRequest | OrcaJobRequest, shared: SharedModelConstraints | undefined, manualText: string | null): string {
  const { structure: _structure, inputSources: _sources, ...conditions } = request;
  return JSON.stringify([conditions, shared ?? null, target === 'gaussian' ? linkedInputSourceSignature(request as JobRequest) : linkedOrcaInputSourceSignature(request as OrcaJobRequest), target === 'gaussian' ? manualText : null]);
}

/** Capture legacy paused frames or independent continuous-MD frames.
 * Scientific projection is delegated to the existing engine application bridges. */
export async function capturePausedGaussianRequest(ports: PausedInputPorts & { readRequest(): JobRequest; readSettings(): GaussianSettings }): Promise<GuardedInputRequest<JobRequest>> {
  const guard = ports.createGuard(), current = structuredClone(ports.readRequest()), privateSettings = structuredClone(ports.readSettings()), shared = structuredClone(ports.readSharedConstraints());
  const captured = await ports.pauseAndSnapshot(); guard.afterSnapshot(captured);
  const snapshot = captured?.detached ? structuredClone(captured) : captured;
  const taskStructure = isQstTask(current.settings.task) && current.settings.qst?.reactantSource ? current.structure : snapshot?.structure ?? current.structure;
  const issue = ports.layerCapabilityFor('gaussian', taskStructure); if (issue) throw new Error(issue);
  const projected = applySharedGaussianConstraints(taskStructure, privateSettings, shared); if (projected.errors.length) throw new Error(projected.errors.join('\n'));
  guard.assertCurrent();
  return { request: { ...current, settings: projected.settings, structure: taskStructure, inputSources: ports.currentSources() ?? current.inputSources }, assertCurrent: guard.assertCurrent, ...(snapshot?.detached?{snapshot}:{}) };
}

export async function capturePausedOrcaRequest(initial: OrcaJobRequest, ports: PausedInputPorts): Promise<GuardedInputRequest<OrcaJobRequest>> {
  const guard = ports.createGuard(), current = structuredClone(initial), privateSettings = structuredClone(initial.settings), shared = structuredClone(ports.readSharedConstraints());
  const captured = await ports.pauseAndSnapshot(); guard.afterSnapshot(captured);
  const snapshot = captured?.detached ? structuredClone(captured) : captured;
  const taskStructure = current.settings.task === 'neb' && current.settings.neb.reactantSource ? current.structure : snapshot?.structure ?? current.structure;
  const issue = ports.layerCapabilityFor('orca', taskStructure); if (issue) throw new Error(issue);
  const projected = applySharedOrcaConstraints(taskStructure, privateSettings, shared); if (projected.errors.length) throw new Error(projected.errors.join('\n'));
  guard.assertCurrent();
  return { request: { ...current, settings: projected.settings, structure: taskStructure, inputSources: ports.currentSources() ?? current.inputSources }, assertCurrent: guard.assertCurrent, ...(snapshot?.detached?{snapshot}:{}) };
}
