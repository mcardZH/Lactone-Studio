import type { Structure } from '../../core/types';
import type { ChemistryRequest } from '../contracts';
import type { ComputeResourceEvidence, ComputeResourceSnapshot } from '../resource-preferences';
import type { XtbRequest, XtbMetadata } from '../xtb/contracts';
import type { AdvancedOptimizationMethod } from './contracts';
import type { AdvancedFrameSource } from './frame-source';

/** Host batch handles are scoped to a trusted window owner, never filesystem paths. */
export interface ConformerBatchIdentity { taskId: string; runId: string; stageId: string; revision: number }
export interface ConformerBatchInput {
  candidateId: string; source: AdvancedFrameSource; originalInput?: AdvancedFrameSource;
  request?: { backend: 'xtb'; request: XtbRequest } | { backend: 'forcefield'; request: ChemistryRequest };
}
export interface ConformerBatchBegin {
  identity: ConformerBatchIdentity; total: number; method: AdvancedOptimizationMethod;
  /** Renderer preference snapshot for provenance only; never an effective grant.
   * The host captures actual resources afresh at start and keeps them immutable. */
  resources?: ComputeResourceSnapshot; metadata?: Record<string, unknown>;
}
export interface ConformerBatchResult {
  structure: Structure; energyHartree: number; metadata?: XtbMetadata;
  identity?: import('../conformers').ConformerCalculationIdentity;
  sessionId?: string; resourceGrant?: ComputeResourceEvidence;
}
export interface ConformerBatchEntry extends ConformerBatchInput {
  index: number; status: 'pending' | 'succeeded' | 'discarded';
  result?: ConformerBatchResult; reason?: { code: string; message: string };
}
export interface ConformerBatchProgress {
  schema: 1; batchId: string; identity: ConformerBatchIdentity; seq: number;
  phase: 'registering' | 'ready' | 'running' | 'stopping' | 'completed' | 'stopped' | 'error';
  total: number; succeeded: number; discarded: number; pending: number; running: number;
  elapsedMs: number; etaMs: number | null;
  error?: { code: string; message: string };
}
export interface ConformerBatchBridge {
  begin(request: ConformerBatchBegin): Promise<{ batchId: string }>;
  /** Contiguous upload; each packet is limited to 32 candidates and 8 MiB. */
  upload(batchId: string, packet: { offset: number; inputs: ConformerBatchInput[] }): Promise<{ received: number }>;
  seal(batchId: string): Promise<ConformerBatchProgress>;
  /** Repeated start after stop resumes pending inputs only. */
  start(batchId: string): Promise<ConformerBatchProgress>;
  stop(batchId: string): Promise<ConformerBatchProgress>;
  status(batchId: string): Promise<ConformerBatchProgress>;
  /** Terminal read, input order; at most 64 entries and 8 MiB per packet.
   * Advance the cursor by entries.length, which may be less than limit. */
  read(batchId: string, page: { offset: number; limit: number }): Promise<{ entries: ConformerBatchEntry[]; total: number }>;
  /** Existing owned handle only; never starts scientific work. */
  restore(batchId: string): Promise<ConformerBatchProgress>;
  destroy(batchId: string): Promise<{ destroyed: boolean }>;
  onProgress(listener: (event: ConformerBatchProgress) => void): () => void;
}
