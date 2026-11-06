/** Internal SciYue runtime resources, not Gaussian/ORCA input-file resources. */
export interface ComputeResourceValues {
  threads: number;
  /** An allowed total budget; not preallocation or an RSS hard-limit claim. */
  memoryBudgetBytes: number;
  /** Explicit cumulative output budget; omitted means no ES cumulative size cutoff. */
  outputBudgetBytes?: number;
}
export interface ComputeResourceSnapshot {
  /** Exact persisted preference version, used only for optimistic writes. */
  version: string;
  /** Identity of the effective values and their actual default/source inputs. */
  revision: string;
  value: ComputeResourceValues | null;
  effective: ComputeResourceValues;
  defaults: ComputeResourceValues;
  /** Explicitly saved preferences confirm setup; omitted by legacy hosts. */
  confirmed?: boolean;
  source: string;
  logicalCpuCount: number;
  totalPhysicalMemoryBytes: number;
  writable: boolean;
  error?: string;
}
/** Legacy v1 preferences were only written by an explicit apply/reset action. */
export function needsComputeResourceConfirmation(snapshot: ComputeResourceSnapshot): boolean {
  return snapshot.writable && !snapshot.error && !(snapshot.confirmed ?? snapshot.value !== null);
}
/** Trusted host-only snapshot. Renderers cannot supply its source/version. */
export interface ComputeResourceGrant extends ComputeResourceValues {
  version: string;
  source: string;
}
/** Admission evidence shared by native engines; it is not renderer authority. */
export interface ComputeResourceEvidence extends ComputeResourceGrant {
  /** Retained renderer data estimate; guides concurrency, never a hard RSS gate. */
  retainedMemoryEstimateBytes?: number;
  configured: ComputeResourceValues;
  requested: ComputeResourceValues;
  reservedBytes: number;
  memoryEnforced: false;
  threadLimitReason?: string;
}
export interface ComputeResourcePreferencesBridge {
  readComputeResources(): Promise<ComputeResourceSnapshot>;
  writeComputeResources(request: {baseVersion: string; value: ComputeResourceValues}): Promise<ComputeResourceSnapshot>;
  onComputeResourcesChanged(callback: (snapshot: ComputeResourceSnapshot) => void): () => void;
}
