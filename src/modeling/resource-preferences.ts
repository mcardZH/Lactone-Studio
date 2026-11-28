/** Internal SciYue runtime resources, not Gaussian/ORCA input-file resources. */
export interface ComputeResourceValues {
  threads: number;
  /** An allowed total budget; not preallocation or an RSS hard-limit claim. */
  memoryBudgetBytes: number;
  /** Explicit cumulative output budget; omitted means no ES cumulative size cutoff. */
  outputBudgetBytes?: number;
}
export type XtbSingleTaskThreadMode = 'auto' | 'fixed';
export interface ComputeResourcePolicyFields {
  multiwfnThreads: number;
  xtbSingleTaskMode: XtbSingleTaskThreadMode;
  /** Auto ceiling for 40 or more atoms, or the fixed count for any structure. */
  xtbSingleTaskThreads: number;
  /** Independent maximum number of xTB candidates, each with one thread. */
  xtbBatchParallelism: number;
  netCpuThreads: number;
}
/** The thread alias keeps older callers and generic operations compatible. */
export type ComputeResourcePreferenceValues = ComputeResourceValues & Partial<ComputeResourcePolicyFields>;
export type ComputeResourceLane = 'multiwfn' | 'xtb-single' | 'xtb-batch' | 'net-cpu';
export interface XtbResourceOverrides {
  xtbSingleTaskThreads?: number;
  xtbBatchParallelism?: number;
}
export function validXtbResourceOverride(value: number | undefined): boolean {
  return value===undefined||Number.isSafeInteger(value)&&value>0;
}
export const NET_GPU_BATCH_LIMITS = ['auto', 1, 2, 4, 8] as const;
export type NetGpuBatchLimit = typeof NET_GPU_BATCH_LIMITS[number];
export function isNetGpuBatchLimit(value: unknown): value is NetGpuBatchLimit {
  return NET_GPU_BATCH_LIMITS.some(limit => limit === value);
}
export interface ComputeResourceSnapshot {
  /** Exact persisted preference version, used only for optimistic writes. */
  version: string;
  /** Identity of the effective values and their actual default/source inputs. */
  revision: string;
  value: ComputeResourcePreferenceValues | null;
  effective: ComputeResourcePreferenceValues;
  defaults: ComputeResourcePreferenceValues;
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
  threadLane?: ComputeResourceLane;
  xtbBatchParallelism?: number;
  netCpuThreads?: number;
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
  writeComputeResources(request: {baseVersion: string; value: ComputeResourcePreferenceValues}): Promise<ComputeResourceSnapshot>;
  onComputeResourcesChanged(callback: (snapshot: ComputeResourceSnapshot) => void): () => void;
}
