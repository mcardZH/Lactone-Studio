import type { ComputeResourceEvidence } from '../resource-preferences';

export type OcrEngine = 'molvec' | 'molscribe';
export interface OcrEngineCapability {
  engine: OcrEngine;
  status: 'ready' | 'not-installed' | 'invalid' | 'unsupported';
  version?: string;
  componentSHA256?: string;
  message?: string;
  confidence: 'none' | 'atom-and-bond';
}
export interface OcrCapabilities { engines: OcrEngineCapability[]; maxImageBytes: number; maxImagePixels: number }
export interface OcrRecognitionRequest { requestId: string; engine: OcrEngine; imageBytes: Uint8Array }
export interface OcrRecognitionResult {
  requestId: string; engine: OcrEngine; version: string; componentSHA256: string;
  imageSHA256: string; molblock: string; elapsedMs: number;
  effectiveResources: ComputeResourceEvidence;
  peakWorkingSetBytes?: number;
  /** Observed Windows process affinity, when the sampling monitor saw it. */
  affinityCpuCount?: number;
  confidence?: { atoms: number[]; bonds: number[] };
}
export interface OcrBridge {
  ocrCapabilities(): Promise<OcrCapabilities>;
  ocrChooseComponent(): Promise<OcrCapabilities>;
  ocrRecognize(request: OcrRecognitionRequest): Promise<OcrRecognitionResult>;
  ocrCancel(requestId: string): Promise<{ requestId: string; cancelled: boolean; settled: true }>;
}
