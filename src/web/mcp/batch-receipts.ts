export interface BatchItemReceipt {
  index: number;
  status: string;
  result?: unknown;
  error?: string;
  code?: string;
  data?: unknown;
}

export interface BatchReceipt {
  id: string;
  action: string;
  status: 'running' | 'complete' | 'partial' | 'interrupted';
  requested: number;
  items: BatchItemReceipt[];
  counts: ReturnType<typeof batchCounts>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function batchCounts(requested: number, items: readonly BatchItemReceipt[]) {
  let succeeded = 0, pending = 0, partial = 0, failed = 0, cancelled = 0;
  const acceptedRunIds = new Set<string>(), observedNativeRunIds = new Set<string>();
  for (const item of items) {
    if (item.status === 'cancelled') cancelled++;
    else if (item.status === 'pending') pending++;
    else if (item.status === 'partial') partial++;
    else if (item.status === 'failed' || item.status === 'rejected') failed++;
    else succeeded++;

    const value = record(item.result) ?? record(item);
    if (typeof value?.runId === 'string' && value.accepted === true) acceptedRunIds.add(value.runId);
    if (typeof value?.runId === 'string' && value.nativeStarted === true) observedNativeRunIds.add(value.runId);
  }
  return {
    requested, processed: items.length, succeeded, pending, partial, failed, cancelled,
    unprocessed: requested - items.length, acceptedRuns: acceptedRunIds.size,
    observedNativeStarts: observedNativeRunIds.size,
  };
}

export function makeBatchReceipt(action: string, requested: number): BatchReceipt {
  return { id: crypto.randomUUID(), action, status: 'running', requested, items: [], counts: batchCounts(requested, []) };
}

export function finishBatchReceipt(receipt: BatchReceipt) {
  receipt.counts = batchCounts(receipt.requested, receipt.items);
  if (receipt.status !== 'interrupted') {
    receipt.status = receipt.counts.succeeded === receipt.requested ? 'complete' : 'partial';
  }
  return receipt;
}
