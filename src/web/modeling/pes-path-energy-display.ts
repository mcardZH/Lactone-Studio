import type { PesPathRecord, PesRun } from '../../modeling/pes/contracts';

export interface PesPathEnergyDisplay {
  recordId?: string;
  offered: readonly string[];
  drawn: readonly string[];
}

export const initialPesPathEnergyDisplay: PesPathEnergyDisplay = { offered: [], drawn: [] };

export function usesPathEnergyMilestones(request: PesRun['request'] | undefined): boolean {
  return request?.operation === 'path' && (request.algorithm === 'ci-neb' || request.algorithm === 'fsm');
}

const ciNebPhase = (record: PesPathRecord) => record.phase === 'ci-neb-ordinary' || record.phase === 'ci-neb-climb';
const hasEnergy = (frame: PesPathRecord['frames'][number]) => typeof frame.energyHartree === 'number' && Number.isFinite(frame.energyHartree);

export function pesPathEnergyMilestones(run: PesRun | undefined, records: readonly PesPathRecord[]): string[] {
  if (!run || !usesPathEnergyMilestones(run.request)) return [];
  const ciNeb = run.request.algorithm === 'ci-neb';
  const first = ciNeb ? records.find(record => ciNebPhase(record) && record.step === 0 && record.frames.length && record.frames.every(hasEnergy)) : undefined;
  const terminal = run.result;
  const complete = run.status === 'completed' && !run.error && terminal && ['completed', 'converged'].includes(terminal.status) && terminal.converged !== false;
  const last = complete && (terminal.lastPathRecordId
    ? records.find(record => record.id === terminal.lastPathRecordId)
    : [...records].reverse().find(record => record.kind === 'final'));
  const milestones = first ? [first.id] : [];
  if (last && (ciNeb ? ciNebPhase(last) : last.phase === 'fsm-growth') &&
      last.frames.some(hasEnergy) && !milestones.includes(last.id)) milestones.push(last.id);
  return milestones;
}

export function offerPesPathEnergyMilestones(display: PesPathEnergyDisplay, recordIds: readonly string[]): PesPathEnergyDisplay {
  const newIds = recordIds.filter(id => !display.offered.includes(id));
  if (!newIds.length) return display;
  // A fast task can deliver both records in one publication. Let the first
  // curve mount before offering the next, with no dependency on the solver.
  if (display.recordId && display.offered.includes(display.recordId) && !display.drawn.includes(display.recordId)) return display;
  const next = newIds.find(id => !display.drawn.includes(id));
  return { ...display, recordId: next ?? display.recordId,
    offered: [...display.offered, ...newIds.filter(id => id === next || display.drawn.includes(id))] };
}
