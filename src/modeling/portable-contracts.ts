/** Explicit desktop maintenance actions; never a generic filesystem or shell port. */
export type PortableLocation = 'profile' | 'cache' | 'temp' | 'logs';
export type PortableToolsAction = 'info' | 'open-location' | 'preferences-export' | 'import-preview' | 'import-apply' | 'diagnostics' | 'diagnostics-export' | 'runtime-check' | 'cache-preview' | 'cache-apply';
export type PortableToolsRequest =
  | { action: 'info' | 'preferences-export' | 'import-preview' | 'diagnostics' | 'diagnostics-export' | 'runtime-check' | 'cache-preview' }
  | { action: 'open-location'; location: PortableLocation }
  | { action: 'import-apply' | 'cache-apply'; token: string; confirmed: true };
export interface PortableBackendInfo {
  name: 'mkl' | 'openblas' | 'unknown';
  /** Package provenance checked by the host, not a claim about a live DLL sample. */
  verified: boolean;
  numpy?: string; scipy?: string; python?: string; source?: string;
}
export interface PortableUsage { files: number; bytes: number; complete: boolean; error?: string }
export interface PortableRuntimeInfo {
  version: string; mode: 'portable'; backend: PortableBackendInfo;
  paths: { root: string; data: string; profile: string; cache: string; temp: string; logs: string; crashDumps: string };
  writable: boolean; writableLocations: Record<PortableLocation, boolean>;
  storageErrors?: Partial<Record<PortableLocation, string>>;
  filesystem: { atomicReplace: boolean; exclusivePublish: boolean };
  usage: Record<'data' | 'cache' | 'temp' | 'logs', PortableUsage>;
}
export interface PortableDiagnostic {
  schema: string; generatedAt: string; version: string; mode: 'portable'; backend: PortableBackendInfo;
  writable: boolean; filesystem: PortableRuntimeInfo['filesystem']; directoryIdentityVerified: boolean;
  nativeSmokePerformed: false; customerContentIncluded: false; limitations: string[];
  /** Prior explicit user check only; report/export itself never starts an engine. */
  lastNativeCheck?: Omit<PortableRuntimeCheck, 'error'> & { checkedAt: string; observationScope: 'last-explicit-user-runtime-check'; error?: { code: string } };
}
export interface PortableRuntimeCheck {
  passed: boolean; executableBundled: boolean; protocolValidated: boolean; directChildClosed: boolean;
  elapsedMs: number; operation: string; engine?: string; engineVersion?: string;
  error?: { code: string; message: string };
  /** A smoke request is not full scientific validation or clean-Windows proof. */
  completeScientificValidation: false;
}
export type PortableToolsResponse =
  | { ok: false; action: string; error: { code: string; message: string; retryable: boolean; preserved: boolean; recoveryRequired?: boolean; backup?: string; partial?: boolean; removedFiles?: number; removedBytes?: number; browserCacheCleared?: boolean; browserCacheAttempted?: boolean } }
  | { ok: true; action: 'info'; info: PortableRuntimeInfo }
  | { ok: true; action: 'open-location'; opened: true }
  | { ok: true; action: 'preferences-export' | 'diagnostics-export'; cancelled: true }
  | { ok: true; action: 'preferences-export' | 'diagnostics-export'; exported: true; path: string }
  | { ok: true; action: 'import-preview'; cancelled: true }
  | { ok: true; action: 'import-preview'; preview: { token: string; expiresAt: number; source: { version: string; label: string }; changes: { layouts: number; display: true }; backupRequired: true } }
  | { ok: true; action: 'import-apply'; imported: true; backup: string; layoutVersion: string; displayVersion: string }
  | { ok: true; action: 'diagnostics'; diagnostic: PortableDiagnostic }
  | { ok: true; action: 'runtime-check'; runtimeCheck: PortableRuntimeCheck }
  | { ok: true; action: 'cache-preview'; preview: { token: string; expiresAt: number; files: number; bytes: number; browserCacheBytes: number; clearsBrowserCache: boolean; skippedRuns: number; requiresIdle: true } }
  | { ok: true; action: 'cache-apply'; removedFiles: number; removedBytes: number; browserCacheCleared: boolean; emptyDirectoriesRetained: true };

export interface PortableDesktopBridge {
  portableTools(request: PortableToolsRequest): Promise<PortableToolsResponse>;
}
