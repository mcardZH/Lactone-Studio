/** Format 15 protects fixed FF models, external program identities and explicit
 * input atom-order confirmations from older writers that cannot retain them. */
export function requiresProjectFormat15(root: unknown): boolean {
  const pending: unknown[] = [root], seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === 'object') pending.push(child);
      continue;
    }
    const row = value as Record<string, unknown>;
    if (row.schema === 'sciyue-xtb-engine-identity/v1' && row.kind === 'external-user-program' ||
      row.ffModel !== undefined || row.frameFormatVersion === 15 || typeof row.productOrderContext === 'string' && !!row.productOrderContext ||
      typeof row.tsGuessOrderContext === 'string' && !!row.tsGuessOrderContext) return true;
    for (const [key, child] of Object.entries(row)) {
      // Numerical geometry/grid payloads cannot contain a provenance identity.
      if (['atoms', 'positions', 'velocities', 'coordinates', 'matrixHartreePerBohr2', 'displacements'].includes(key)) continue;
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}
