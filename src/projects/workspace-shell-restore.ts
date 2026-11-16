import { decodeDiagnostic, type DiagnosticProjectSnapshot } from './diagnostic-snapshot';
import type { ProjectAssetReader } from './result-snapshot';
import type { ResultDiagnostic } from '../results/contracts';

type JsonRecord = Record<string, unknown>;
export interface WorkspaceRestoreIssue { assetId: string; message: string }
export const isProjectAssetId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }
function placement(value: unknown): boolean {
  return record(value) && [value.x,value.y,value.width,value.height].every(Number.isFinite) &&
    Number(value.width)>0 && Number(value.height)>0 && (value.maximized === undefined || typeof value.maximized === 'boolean');
}
function frameOrder(value: unknown): boolean {
  if (!record(value) || ![value.documentId,value.documentEpoch,value.resultId].every(text) ||
      !strings(value.availableFrameIds) || !strings(value.frameIds)) return false;
  const available = new Set(value.availableFrameIds);
  return available.size === value.availableFrameIds.length && new Set(value.frameIds).size === available.size &&
    value.frameIds.length === available.size && value.frameIds.every(id => available.has(id));
}
function plot(value: unknown): boolean {
  if (!record(value) || !text(value.id) || typeof value.title !== 'string' || !record(value.source)) return false;
  if (value.kind === 'file-path') return Array.isArray(value.nodes);
  return ['scf','levels'].includes(String(value.kind)) && Array.isArray(value.scfCycles) &&
    value.scfCycles.every(cycle => record(cycle) && Array.isArray(cycle.points) && cycle.points.every(record)) &&
    Array.isArray(value.orbitals) && value.orbitals.every(channel => record(channel) && Array.isArray(channel.orbitals) && channel.orbitals.every(record));
}
function advancedObservation(value: unknown): boolean {
  if (!record(value) || !record(value.ref) || !record(value.stamp) || !record(value.structure) ||
      !record(value.constraints) || value.coordinateUnit !== 'angstrom') return false;
  const {ref,stamp,structure,constraints} = value;
  return text(ref.documentId) && text(ref.documentEpoch) && Number.isSafeInteger(ref.revision) && Number(ref.revision)>=0 &&
    stamp.documentId===ref.documentId && stamp.revision===ref.revision &&
    Number.isInteger(structure.charge) && Number.isInteger(structure.multiplicity) && Number(structure.multiplicity)>=1 &&
    Array.isArray(structure.atoms) && structure.atoms.length>0 && structure.atoms.every(atom=>record(atom)&&text(atom.id)&&text(atom.element)&&[atom.x,atom.y,atom.z].every(Number.isFinite)) &&
    strings(constraints.frozenAtomIds) && Array.isArray(constraints.coordinates) && constraints.coordinates.every(row=>record(row)&&strings(row.atomIds));
}

/** Restore known UI containers without letting one damaged pane replace the
 * entire workspace. Keep its original saved value available for inspection. */
export function projectWorkspaceShell(value: unknown, reader: ProjectAssetReader, issues: WorkspaceRestoreIssue[]) {
  const original = record(value) ? value : {};
  const shell: JsonRecord = { ...original };
  const prior = original.preservedInvalidShellFields;
  const retained: JsonRecord = record(prior) ? { ...prior } : {};
  const diagnostics: ResultDiagnostic[] = [];
  function invalid(path: string, raw: unknown, reason = '保存状态无效，已暂时停用。') {
    const values = Array.isArray(retained[path]) ? retained[path] as unknown[] : [];
    if (!values.some(value => JSON.stringify(value) === JSON.stringify(raw))) retained[path] = [...values, structuredClone(raw)];
    issues.push({ assetId: path, message: reason });
  }
  function field(name: string, validate: (value: unknown) => boolean) {
    if (shell[name] !== undefined && !validate(shell[name])) { invalid(`shell.${name}`, shell[name]); delete shell[name]; }
  }
  function entries(value: unknown, path: string, validate: (value: unknown) => boolean) {
    if (value === undefined) return;
    if (!record(value)) { invalid(path, value); return; }
    return Object.fromEntries(Object.entries(value).filter(([id,row]) => {
      if (validate(row)) return true;
      invalid(`${path}.${id}`, row);
      return false;
    }));
  }
  if (value !== undefined && !record(value)) invalid('shell', value);
  if (prior !== undefined && !record(prior)) invalid('shell.preservedInvalidShellFields', prior);
  delete shell.preservedInvalidShellFields;
  field('order', strings);
  field('deckMode', value => value === 'single' || value === 'tiled' || value === 'free');
  field('multiMode', value => value === 'tiled' || value === 'free');
  field('mainDocumentId', value => value === null || text(value));
  field('borrowedBatchAsset', isProjectAssetId);
  field('displaySettings', record);
  field('workbench', record);
  field('plots', Array.isArray);
  if (Array.isArray(shell.plots)) shell.plots = shell.plots.filter((value,index) => {
    if (plot(value)) return true;
    invalid(`shell.plots[${index}]`, value); return false;
  });
  shell.conformerFrameOrders = entries(shell.conformerFrameOrders, 'shell.conformerFrameOrders', frameOrder);
  shell.conformerGroups = entries(shell.conformerGroups, 'shell.conformerGroups', row => record(row) && typeof row.label === 'string' && typeof row.collapsed === 'boolean');
  shell.advancedObservations = entries(shell.advancedObservations, 'shell.advancedObservations', advancedObservation);
  shell.cameras = entries(shell.cameras, 'shell.cameras', row => row === null || Array.isArray(row) && row.length === 8 && row.every(Number.isFinite));
  field('windowPlacements', record);
  if (record(shell.windowPlacements)) {
    const windows = { ...shell.windowPlacements };
    if (windows.main !== undefined && !placement(windows.main)) { invalid('shell.windowPlacements.main',windows.main); delete windows.main; }
    windows.detached = entries(windows.detached, 'shell.windowPlacements.detached', placement);
    shell.windowPlacements = windows;
  }
  field('sourceDiagnostics', Array.isArray);
  if (Array.isArray(shell.sourceDiagnostics)) shell.sourceDiagnostics = shell.sourceDiagnostics.filter((value,index) => {
    try { diagnostics.push(decodeDiagnostic(value as DiagnosticProjectSnapshot, reader)); return true; }
    catch (error) { invalid(`shell.sourceDiagnostics[${index}]`, value, error instanceof Error ? error.message : String(error)); return false; }
  });
  const retainedShell = { ...shell, ...(Object.keys(retained).length ? { preservedInvalidShellFields: retained } : {}) };
  return { shell, retainedShell, diagnostics };
}
