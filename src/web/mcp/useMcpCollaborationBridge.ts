import { useEffect, useRef } from 'react';
import { builderCoordinateValue } from '../../core/builder-geometry';
import { electronicStateError, elementSymbol } from '../../core/elements';
import { bondReference } from '../../core/modeling/graph';
import { obviousClashDistance } from '../../core/modeling/local-placement';
import { prepareStructureTransform, type StructureTransformEdit } from '../../core/modeling/structure-transform';
import {
  cartesianToFractional,
  cellParameters,
  cross3,
  dot3,
  fractionalToCartesian,
  minimumImage,
  norm3
} from '../../core/periodic';
import type { Structure, Vector3 } from '../../core/types';
import { createConformerSnapshot, findRotatableTorsions } from '../../modeling/conformers/geometry';
import {
  assertAtomScanCompatibility,
  effectiveModelConstraints,
  modelCoordinateKey
} from '../../modeling/constraints';
import {
  DEFAULT_DISPLAY,
  type BondOrder,
  type DesktopBridge,
  type DisplaySettings,
  type ModelCommand,
  type ModelCoordinate,
  type ModelCoordinateObject,
  type ModelDocument
} from '../../modeling/contracts';
import {
  launchSourceFile,
  type LaunchImportBridge,
  type LaunchSourceDescriptor
} from '../../modeling/platform/launch-import';
import { modelFragmentsFromStructures } from '../../modeling/platform/files';
import type { WorkspaceModule } from '../../modeling/workspace-contracts';
import type { createWorkspaceRegistry } from '../../modeling/workspace-registry';
import { importWorkspaceItems } from '../../results/import-workspace';
import { resultFile, type ScientificSourceFile } from '../../results/input-file';
import type { TrajectoryResult } from '../../results/contracts';
import {
  composePostprocessDocument,
  composePostprocessFileDocument,
  disposePostprocessAttachments,
  isScientificFileDocument,
  postprocessFileDisplayDocument,
  postprocessWavefunctionFrame,
  retainPostprocessFileSourceBytes,
  retainPostprocessManagedSource,
  retainPostprocessOutputSourceText,
  retainPostprocessSourceBytes,
  retainPostprocessSourceText,
  type PostprocessAttachment,
  type PostprocessDocument,
  type PostprocessScientificFileDocument
} from '../../results/postprocess-document';
import {
  identifyPostprocessSource,
  isScientificFileSource,
  pairPostprocessSourcesForFrames,
  postprocessMetadataConflict,
  readPostprocessAuxiliary,
  readPostprocessFileOutput,
  readPostprocessWavefunction
} from '../../results/postprocess-sources';
import type { AnalysisPage } from '../results/PostprocessDisplayPanel';
import {
  defaultPostprocessCompanion,
  preparePostprocessFileIncoming,
  preparePostprocessIncoming
} from '../results/postprocess-import-policy';
import { readInitialPostprocessStructure } from '../results/usePostprocessWorkspace';
import {
  orientObjectView,
  rotateObjectView,
  rotateObjectViewStep,
  type ViewFrame
} from '../modeling/render/camera';
import {
  cellViewFrame,
  principalInertiaFrame,
  type CellViewPreset
} from '../modeling/render/view-frame';
import {
  isConformerWorkspaceResult,
  workspaceFreezeEditingAllowed
} from '../modeling/workspace-freeze-policy';
import {
  buildConfiguredCalculation,
  computeHillFormula,
  recommendCalculationMethod,
  type ConfigureCalculationResult
} from './calculation-config';
import type { XtbBridge, XtbMethod, XtbSolvation } from '../../modeling/xtb/contracts';
import type { XtbOptions, XtbState } from '../../modeling/xtb/controller';
import type { TaskCategory, TaskSystemBridge } from '../../task-system/application-contracts';
import {
  createTaskSystemBridge,
  type NativeTaskSystemPort
} from '../../task-system/integration/desktop-bridge';
import type { ExternalInputDraft } from '../../task-system/integration/input-draft';
import {
  applySubmissionDraftOverrides,
  buildExternalDraftFromSavedEntry,
  executeAutoSubmitToTaskCenter,
  executeMcpConformerSearch,
  executeTaskManageAction,
  formatXtbSinglepointOrOptimizeOutcome,
  resolveValidatedElectronicState,
  resolveXtbSolvation,
  runStandaloneXtbCalculation,
  type LocalXtbCalculation,
  type SubmitTaskMode,
  type TaskManageAction
} from './task-execution';
import {
  buildExportArtifactPayload,
  executeWavefunctionAnalysis,
  McpAnalysisTableStore,
  summarizeAnalysisTarget,
  type McpAnalysisViewportOverlay
} from './analysis-export';

export { computeHillFormula };

export type WorkspaceRegistryInstance = ReturnType<typeof createWorkspaceRegistry>;

export type McpCameraPreset = 'principal-inertia' | 'X' | 'Y' | 'Z' | CellViewPreset;
export type McpRotateStep = 'left' | 'right' | 'up' | 'down';

export interface McpViewportDisplayState {
  style: DisplaySettings['representation'];
  showAtomIndices: boolean;
  showElementLabels: boolean;
  showBondLengths: boolean;
  showFrozenMarks: boolean;
  showCell: boolean;
  showAxes: boolean;
}

export interface McpViewportSnapshot {
  cameraView: number[];
  displaySettings: DisplaySettings;
  showAxes: boolean;
}

export interface McpScreenshotRenderOutcome {
  base64Png: string;
  width: number;
  height: number;
  renderer: 'webgl' | 'fallback-2d';
}

export interface McpFrontendRequest {
  requestId: string;
  action: string;
  payload?: Record<string, unknown>;
}

export interface McpFrontendReply {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    sourceAdopted?: boolean;
  };
}

export interface McpLayoutState {
  deckMode: 'single' | 'tiled' | 'free';
  multiMode: 'tiled' | 'free';
}

export interface McpOpenDocumentSummary {
  id: string;
  label: string;
  active: boolean;
  revision: number;
  dirty: boolean;
  formula: string;
  atomCount: number;
  bondCount: number;
  charge: number | null;
  multiplicity: number | null;
  electronicStateConfirmed: boolean;
  isPeriodic: boolean;
  selectedAtomCount: number;
  frozenAtomCount: number;
  coordinateConstraintCount: number;
  hasResult: boolean;
  runtimePhase: string;
}

export interface McpWorkbenchStatusSnapshot {
  workbenchOnline: true;
  module: WorkspaceModule;
  taskCenterOpen: boolean;
  activeViewId: string | null;
  activeDocumentId: string | null;
  documentCount: number;
  layout?: McpLayoutState;
  documents?: McpOpenDocumentSummary[];
}

export interface McpImportedFileOutcome {
  openedDocumentId: string | null;
  openedDocumentIds: string[];
  targetChoice: 'structure' | 'analysis';
  warnings?: string[];
  document?: McpOpenDocumentSummary | null;
}

export interface McpResolvedAnalysisTarget {
  documentId: string;
  label: string;
  entry?: ReturnType<WorkspaceRegistryInstance['getSnapshot']>['documents'][number] | null;
  postprocessDocument?: PostprocessDocument | null;
  fileDocument?: PostprocessScientificFileDocument | null;
  trajectoryResult?: TrajectoryResult | null;
  currentFrameIndex?: number;
  currentStructure?: Structure | null;
  activePanel?: AnalysisPage | null;
}

export interface McpCollaborationCallbacks {
  navigateModule?: (module: WorkspaceModule) => void;
  activateDocument?: (documentId: string) => void;
  createDocument?: (options?: { label?: string; module?: WorkspaceModule }) => string;
  closeDocument?: (documentId: string, discardUnsaved: boolean) => Promise<void>;
  setTaskCenterOpen?: (open: boolean) => void;
  getLayoutState?: () => McpLayoutState;
  setLayoutState?: (options: { layout?: 'single' | 'tiled' | 'free'; arrange?: boolean }) => McpLayoutState;
  importScientificFile?: (
    file: ScientificSourceFile,
    options: { choice: 'structure' | 'analysis'; label?: string }
  ) => Promise<McpImportedFileOutcome>;
  getViewportState?: (documentId: string) => Partial<McpViewportSnapshot> | undefined;
  applyViewportState?: (
    documentId: string,
    next: {
      cameraView?: number[];
      displaySettings?: DisplaySettings;
      showAxes?: boolean;
      resetView?: boolean;
    }
  ) => void | Promise<void>;
  captureViewportScreenshot?: (
    documentId: string,
    options: {
      width: number;
      height: number;
      transparent: boolean;
      includeAnnotations: boolean;
      cameraView: number[];
      displaySettings: DisplaySettings;
      showAxes: boolean;
    }
  ) => Promise<McpScreenshotRenderOutcome>;
  assertCalculationConfigurable?: (documentId: string) => void;
  switchToConfiguredInputView?: (documentId: string) => void;
  applyCalculationConfig?: (documentId: string, configured: ConfigureCalculationResult) => void;
  runLocalXtb?: (
    documentId: string,
    options: {
      calculation: 'singlepoint' | 'optimize';
      xtbOptions: XtbOptions;
      timeoutSeconds?: number;
    }
  ) => Promise<XtbState>;
  runConformerSearch?: (
    documentId: string,
    params: {
      method: XtbMethod;
      solvation?: XtbSolvation;
      maxSteps: number;
      maxCandidates: number;
      pointsPerTorsion: number;
      timeoutSeconds?: number;
    }
  ) => Promise<Record<string, unknown>>;
  captureLiveSubmissionDraft?: (
    documentId: string,
    preferredEngine?: 'gaussian' | 'orca'
  ) => ExternalInputDraft | null | undefined;
  openTaskSubmissionDialog?: (
    documentId: string,
    draft: ExternalInputDraft,
    options?: { environmentId?: string; displayName?: string }
  ) => Promise<void>;
  getTaskSystemBridge?: () => TaskSystemBridge | null | undefined;
  getProjectId?: () => string | null;
  openSubmittedTaskInCenter?: (taskId: string) => void;
  trackTaskOperation?: (operationId: string) => void;
  openTaskSnapshotInAnalysis?: (taskId: string) => Promise<{ documentId: string }>;
  openResultFileInAnalysis?: (
    file: ScientificSourceFile,
    options: { targetDocumentId?: string; label?: string; frameIndex?: number }
  ) => Promise<{ documentId: string }>;
  getAnalysisTarget?: (requestedId?: string) => McpResolvedAnalysisTarget | null | undefined;
  syncAnalysisPresentation?: (
    documentId: string,
    options: {
      panel?: AnalysisPage;
      frameIndex?: number;
      overlay?: McpAnalysisViewportOverlay | null;
    }
  ) => void;
}

export type McpFrontendActionHandler = (
  payload: Record<string, unknown>
) => Promise<unknown> | unknown;

const VALID_MODULES: ReadonlySet<WorkspaceModule> = new Set([
  'modeling',
  'advanced-modeling',
  'input',
  'advanced',
  'analysis'
]);

const VALID_LAYOUTS: ReadonlySet<'single' | 'tiled' | 'free'> = new Set([
  'single',
  'tiled',
  'free'
]);

const CELL_PRESETS: ReadonlySet<CellViewPreset> = new Set([
  'a',
  'a*',
  'b',
  'b*',
  'c',
  'c*'
]);

const ROTATE_STEPS: ReadonlySet<McpRotateStep> = new Set([
  'left',
  'right',
  'up',
  'down'
]);

const DISPLAY_STYLES: ReadonlySet<DisplaySettings['representation']> = new Set([
  'ball-stick',
  'stick',
  'vdw'
]);

export function computeStructurePivot(
  atoms: ReadonlyArray<{ x: number; y: number; z: number }>
): Vector3 {
  if (!atoms.length) return [0, 0, 0];
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const atom of atoms) {
    sx += atom.x;
    sy += atom.y;
    sz += atom.z;
  }
  const n = atoms.length;
  return [sx / n, sy / n, sz / n];
}

export function defaultCameraViewForPivot(pivot: Vector3): number[] {
  return [-pivot[0], -pivot[1], -pivot[2], 125, 0, 0, 0, 1];
}

export function cartesianViewFrame(preset: 'X' | 'Y' | 'Z'): ViewFrame {
  if (preset === 'X') {
    return {
      right: [0, 1, 0],
      up: [0, 0, 1],
      toward: [1, 0, 0]
    };
  }
  if (preset === 'Y') {
    return {
      right: [0, 0, 1],
      up: [1, 0, 0],
      toward: [0, 1, 0]
    };
  }
  return {
    right: [1, 0, 0],
    up: [0, 1, 0],
    toward: [0, 0, 1]
  };
}

export function formatMcpDisplayState(
  display: DisplaySettings,
  showAxes: boolean
): McpViewportDisplayState {
  return {
    style: display.representation,
    showAtomIndices: Boolean(display.atomNumbers),
    showElementLabels: Boolean(display.elementNames),
    showBondLengths: Boolean(display.measurementMarks),
    showFrozenMarks: Boolean(display.frozenMarks),
    showCell: Boolean(display.cell),
    showAxes: Boolean(showAxes)
  };
}

export function applyMcpDisplayPatch(
  currentDisplay: DisplaySettings,
  currentShowAxes: boolean,
  patch: Record<string, unknown> | undefined
): { displaySettings: DisplaySettings; showAxes: boolean; changedDisplay: boolean; changedAxes: boolean } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return {
      displaySettings: currentDisplay,
      showAxes: currentShowAxes,
      changedDisplay: false,
      changedAxes: false
    };
  }
  const nextDisplay: DisplaySettings = { ...currentDisplay };
  let nextShowAxes = currentShowAxes;
  let changedDisplay = false;
  let changedAxes = false;

  if (typeof patch.style === 'string' && DISPLAY_STYLES.has(patch.style as DisplaySettings['representation'])) {
    nextDisplay.representation = patch.style as DisplaySettings['representation'];
    changedDisplay = true;
  }
  if (typeof patch.showAtomIndices === 'boolean') {
    nextDisplay.atomNumbers = patch.showAtomIndices;
    changedDisplay = true;
  }
  if (typeof patch.showElementLabels === 'boolean') {
    nextDisplay.elementNames = patch.showElementLabels;
    changedDisplay = true;
  }
  if (typeof patch.showBondLengths === 'boolean') {
    nextDisplay.measurementMarks = patch.showBondLengths;
    changedDisplay = true;
  }
  if (typeof patch.showFrozenMarks === 'boolean') {
    nextDisplay.frozenMarks = patch.showFrozenMarks;
    changedDisplay = true;
  }
  if (typeof patch.showCell === 'boolean') {
    nextDisplay.cell = patch.showCell;
    changedDisplay = true;
  }
  if (typeof patch.showAxes === 'boolean') {
    nextShowAxes = patch.showAxes;
    changedAxes = true;
  }

  return {
    displaySettings: nextDisplay,
    showAxes: nextShowAxes,
    changedDisplay,
    changedAxes
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(typeBytes: Uint8Array, dataBytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < typeBytes.length; i++) {
    c = CRC32_TABLE[(c ^ typeBytes[i]) & 0xff] ^ (c >>> 8);
  }
  for (let i = 0; i < dataBytes.length; i++) {
    c = CRC32_TABLE[(c ^ dataBytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  let i = 0;
  const len = bytes.length;
  while (i < len) {
    const end = Math.min(len, i + 5552);
    while (i < end) {
      s1 += bytes[i++];
      s2 += s1;
    }
    s1 %= 65521;
    s2 %= 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    typeBytes[i] = type.charCodeAt(i) & 0xff;
  }
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(typeBytes, data), false);
  return chunk;
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const globalBuffer = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (globalBuffer && typeof globalBuffer.from === 'function') {
    return globalBuffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  return uint8ArrayToBase64(new Uint8Array(arrayBuffer));
}

export function encodeRgbaToPngBytes(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const rowStride = width * 4 + 1;
  const rawScanlines = new Uint8Array(rowStride * height);
  for (let y = 0; y < height; y++) {
    const dstOffset = y * rowStride;
    rawScanlines[dstOffset] = 0;
    const srcOffset = y * width * 4;
    rawScanlines.set(rgba.subarray(srcOffset, srcOffset + width * 4), dstOffset + 1);
  }

  const maxBlock = 65535;
  const blockCount = Math.max(1, Math.ceil(rawScanlines.length / maxBlock));
  const zlibData = new Uint8Array(2 + blockCount * 5 + rawScanlines.length + 4);
  zlibData[0] = 0x78;
  zlibData[1] = 0x01;

  let writeOffset = 2;
  let readOffset = 0;
  for (let b = 0; b < blockCount; b++) {
    const isFinal = b === blockCount - 1;
    const blockLen = Math.min(maxBlock, rawScanlines.length - readOffset);
    const nlen = (~blockLen) & 0xffff;
    zlibData[writeOffset++] = isFinal ? 0x01 : 0x00;
    zlibData[writeOffset++] = blockLen & 0xff;
    zlibData[writeOffset++] = (blockLen >>> 8) & 0xff;
    zlibData[writeOffset++] = nlen & 0xff;
    zlibData[writeOffset++] = (nlen >>> 8) & 0xff;
    zlibData.set(rawScanlines.subarray(readOffset, readOffset + blockLen), writeOffset);
    writeOffset += blockLen;
    readOffset += blockLen;
  }

  const checksum = adler32(rawScanlines);
  const adlerView = new DataView(zlibData.buffer, writeOffset, 4);
  adlerView.setUint32(0, checksum, false);

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const ihdrChunk = makePngChunk('IHDR', ihdr);
  const idatChunk = makePngChunk('IDAT', zlibData);
  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  const output = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let pos = 0;
  output.set(signature, pos);
  pos += signature.length;
  output.set(ihdrChunk, pos);
  pos += ihdrChunk.length;
  output.set(idatChunk, pos);
  pos += idatChunk.length;
  output.set(iendChunk, pos);
  return output;
}

const ELEMENT_FALLBACK_RGB: Readonly<Record<string, [number, number, number]>> = {
  H: [240, 244, 248],
  C: [80, 86, 94],
  N: [48, 96, 224],
  O: [224, 48, 48],
  F: [112, 208, 80],
  P: [240, 128, 32],
  S: [224, 196, 40],
  Cl: [32, 192, 64],
  Br: [166, 42, 42],
  I: [148, 0, 148]
};

function rotateByCameraQuaternion(point: Vector3, quat: readonly number[]): Vector3 {
  const [qx = 0, qy = 0, qz = 0, qw = 1] = quat;
  const [vx, vy, vz] = point;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx)
  ];
}

export function renderFallbackViewportPngBase64(options: {
  structure: Structure;
  cameraView: readonly number[];
  pivot: Vector3;
  width: number;
  height: number;
  transparent: boolean;
}): string {
  const { structure, cameraView, pivot, width, height, transparent } = options;
  const rgba = new Uint8Array(width * height * 4);

  if (!transparent) {
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 248;
      rgba[i + 1] = 250;
      rgba[i + 2] = 251;
      rgba[i + 3] = 255;
    }
  }

  const setPixel = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    rgba[idx] = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;
    rgba[idx + 3] = a;
  };

  const drawLine = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => {
    let cx = Math.round(x0);
    let cy = Math.round(y0);
    const tx = Math.round(x1);
    const ty = Math.round(y1);
    const dx = Math.abs(tx - cx);
    const dy = Math.abs(ty - cy);
    const sx = cx < tx ? 1 : -1;
    const sy = cy < ty ? 1 : -1;
    let err = dx - dy;
    let steps = 0;
    const maxSteps = width + height + 4;
    while (steps++ < maxSteps) {
      setPixel(cx, cy, r, g, b);
      setPixel(cx + 1, cy, r, g, b);
      setPixel(cx, cy + 1, r, g, b);
      if (cx === tx && cy === ty) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        cx += sx;
      }
      if (e2 < dx) {
        err += dx;
        cy += sy;
      }
    }
  };

  const drawDisk = (cx: number, cy: number, radius: number, r: number, g: number, b: number) => {
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    const rad = Math.max(2, Math.round(radius));
    const r2 = rad * rad;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx * dx + dy * dy <= r2) {
          setPixel(ix + dx, iy + dy, r, g, b);
        }
      }
    }
  };

  const atoms = structure.atoms;
  if (atoms.length > 0) {
    const quat = cameraView.length >= 8 ? cameraView.slice(4, 8) : [0, 0, 0, 1];
    const zoomFactor = Math.max(0.2, Math.min(8, (cameraView[3] || 125) / 125));
    const rotated = atoms.map(atom => {
      const rel: Vector3 = [atom.x - pivot[0], atom.y - pivot[1], atom.z - pivot[2]];
      const rot = rotateByCameraQuaternion(rel, quat);
      return { atom, x: rot[0], y: rot[1], z: rot[2] };
    });

    let maxExtent = 2.0;
    for (const item of rotated) {
      maxExtent = Math.max(maxExtent, Math.abs(item.x), Math.abs(item.y));
    }
    const scale = (Math.min(width, height) * 0.34 * zoomFactor) / maxExtent;
    const centerX = width / 2;
    const centerY = height / 2;

    const projectedList = rotated.map(item => {
      const sx = centerX + item.x * scale;
      const sy = centerY - item.y * scale;
      return { sx, sy, z: item.z, element: item.atom.element };
    });

    for (const bond of structure.bonds ?? []) {
      const a = projectedList[bond.a];
      const b = projectedList[bond.b];
      if (a && b) {
        drawLine(a.sx, a.sy, b.sx, b.sy, 110, 122, 134);
      }
    }

    const sortedAtoms = [...projectedList].sort((a, b) => a.z - b.z);
    const atomRadius = Math.max(4, Math.min(18, Math.round(Math.min(width, height) * 0.018 * zoomFactor)));
    for (const item of sortedAtoms) {
      const [r, g, b] = ELEMENT_FALLBACK_RGB[item.element] ?? [100, 140, 180];
      drawDisk(item.sx, item.sy, item.element === 'H' ? Math.max(3, Math.round(atomRadius * 0.65)) : atomRadius, r, g, b);
    }
  }

  return uint8ArrayToBase64(encodeRgbaToPngBytes(width, height, rgba));
}

export function resolveOpenFileTargetChoice(
  fileName: string,
  target: unknown = 'auto'
): 'structure' | 'analysis' {
  if (target === 'modeling') return 'structure';
  if (target === 'analysis') return 'analysis';
  return /\.(?:fchk?|molden|wfn|wfx|log|out|hess)$/i.test(fileName)
    ? 'analysis'
    : 'structure';
}

export function createInMemoryScientificSourceFile(name: string, text: string): ScientificSourceFile {
  const bytes = new TextEncoder().encode(text);
  const size = bytes.byteLength;
  return {
    name,
    size,
    async text() {
      return text;
    },
    stream() {
      let sent = false;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          if (sent) {
            controller.close();
            return;
          }
          sent = true;
          const copy = new Uint8Array(size);
          copy.set(bytes);
          controller.enqueue(copy);
          controller.close();
        }
      });
    },
    slice(start = 0, end = size) {
      const bound = (value: number) => Math.min(size, Math.max(0, value < 0 ? size + value : value));
      const from = bound(Math.trunc(start));
      const to = Math.max(from, bound(Math.trunc(end)));
      return {
        async arrayBuffer() {
          return bytes.slice(from, to).buffer as ArrayBuffer;
        }
      };
    }
  };
}

export function summarizeRegistryDocument(
  entry: WorkspaceRegistryInstance['getSnapshot'] extends () => { documents: ReadonlyArray<infer D> } ? D : never,
  activeDocumentId: string | null
): McpOpenDocumentSummary {
  const modelDoc = entry.store.getSnapshot();
  const structure = modelDoc.draft.structure.atoms.length > 0
    ? modelDoc.draft.structure
    : (entry.result?.initialStructure ?? modelDoc.draft.structure);
  let frozenAtomCount = 0;
  let coordinateConstraintCount = 0;
  try {
    const effective = effectiveModelConstraints(modelDoc);
    frozenAtomCount = effective.frozenAtomIds.length;
    coordinateConstraintCount = effective.coordinates.length;
  } catch {
    frozenAtomCount = (modelDoc.sharedConstraints?.frozenAtomIds ?? modelDoc.draft.assignments?.frozenAtomIds ?? []).length;
    coordinateConstraintCount = (modelDoc.sharedConstraints?.coordinates ?? []).length + (modelDoc.internalCoordinates ?? []).length;
  }
  const dirty = Boolean(
    modelDoc.draft.dirty ||
    entry.inputDirty?.gaussian ||
    entry.inputDirty?.orca
  );
  return {
    id: entry.id,
    label: entry.label,
    active: entry.id === activeDocumentId,
    revision: modelDoc.revision,
    dirty,
    formula: computeHillFormula(structure.atoms),
    atomCount: structure.atoms.length,
    bondCount: structure.bonds?.length ?? 0,
    charge: structure.charge,
    multiplicity: structure.multiplicity,
    electronicStateConfirmed: Boolean(entry.electronicStateConfirmed || modelDoc.electronicStateConfirmed),
    isPeriodic: Boolean(structure.cell && structure.cell.pbc?.some(Boolean)),
    selectedAtomCount: modelDoc.selection.atomIds.length,
    frozenAtomCount,
    coordinateConstraintCount,
    hasResult: Boolean(entry.result || entry.legacyResult || entry.analysisBinding),
    runtimePhase: entry.runtime.phase
  };
}

export function collectWorkbenchStatusSnapshot(options: {
  registry: WorkspaceRegistryInstance;
  taskCenterOpen: boolean;
  includeDocuments?: boolean;
  layout?: McpLayoutState;
}): McpWorkbenchStatusSnapshot {
  const snapshot = options.registry.getSnapshot();
  const activeView = snapshot.views.find(view => view.id === snapshot.activeViewId);
  const activeDocumentId = activeView?.documentId ?? null;
  const includeDocuments = options.includeDocuments !== false;

  const documents: McpOpenDocumentSummary[] | undefined = includeDocuments
    ? snapshot.documents.map(entry => summarizeRegistryDocument(entry, activeDocumentId))
    : undefined;

  return {
    workbenchOnline: true,
    module: snapshot.module,
    taskCenterOpen: Boolean(options.taskCenterOpen),
    activeViewId: snapshot.activeViewId,
    activeDocumentId,
    documentCount: snapshot.documents.length,
    ...(options.layout ? { layout: options.layout } : {}),
    ...(documents !== undefined ? { documents } : {})
  };
}

function isLaunchSourceDescriptor(value: unknown): value is LaunchSourceDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.token === 'string' &&
    record.token.length > 0 &&
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    typeof record.size === 'number' &&
    Number.isSafeInteger(record.size) &&
    record.size >= 0
  );
}

export function createMcpFrontendDispatcher(options: {
  getRegistry: () => WorkspaceRegistryInstance;
  isTaskCenterOpen: () => boolean;
  getDesktop?: () => DesktopBridge | undefined;
  getCallbacks?: () => McpCollaborationCallbacks | undefined;
  getExtraHandlers?: () => Record<string, McpFrontendActionHandler> | undefined;
}) {
  let internalLayoutState: McpLayoutState = {
    deckMode: 'single',
    multiMode: 'tiled'
  };
  let taskCenterOpenOverride: boolean | null = null;
  let internalDisplaySettings: DisplaySettings = { ...DEFAULT_DISPLAY };
  let internalShowAxes = true;
  const internalCameraViews = new Map<string, number[]>();
  const analysisTableStore = new McpAnalysisTableStore();
  const standalonePostprocessDocs = new Map<string, PostprocessDocument>();
  const standaloneFileDocs = new Map<string, PostprocessScientificFileDocument>();
  const standaloneActivePanels = new Map<string, AnalysisPage>();
  const standaloneFrameIndices = new Map<string, number>();
  let standaloneLastFileDocId: string | null = null;
  let overlaySerialCounter = 0;

  function setTaskCenterOpenSync(open: boolean): void {
    taskCenterOpenOverride = open;
    const setter = options.getCallbacks?.()?.setTaskCenterOpen;
    if (setter) {
      setter(open);
      queueMicrotask(() => {
        if (taskCenterOpenOverride === open) {
          taskCenterOpenOverride = null;
        }
      });
    }
  }

  function resolveEffectiveTaskCenterOpen(): boolean {
    if (taskCenterOpenOverride !== null) {
      return taskCenterOpenOverride;
    }
    return Boolean(options.isTaskCenterOpen());
  }

  function currentStatusSnapshot(includeDocuments = true): McpWorkbenchStatusSnapshot {
    const callbacks = options.getCallbacks?.();
    const layout = callbacks?.getLayoutState ? callbacks.getLayoutState() : internalLayoutState;
    return collectWorkbenchStatusSnapshot({
      registry: options.getRegistry(),
      taskCenterOpen: resolveEffectiveTaskCenterOpen(),
      includeDocuments,
      layout
    });
  }

  function resolveTargetDocument(
    snapshot: ReturnType<WorkspaceRegistryInstance['getSnapshot']>,
    documentIdRaw: unknown,
    labelRaw: unknown
  ) {
    const documentId = typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';
    const label = typeof labelRaw === 'string' ? labelRaw.trim() : '';
    if (documentId) {
      const byId = snapshot.documents.find(entry => entry.id === documentId);
      if (byId) return byId;
    }
    if (label) {
      const byLabel = snapshot.documents.find(entry => entry.label === label);
      if (byLabel) return byLabel;
    }
    if (documentId) {
      const byLabelFallback = snapshot.documents.find(entry => entry.label === documentId);
      if (byLabelFallback) return byLabelFallback;
    }
    return undefined;
  }

  async function handleWindowManage(payload: Record<string, unknown>): Promise<unknown> {
    const registry = options.getRegistry();
    const callbacks = options.getCallbacks?.();
    const manageAction = typeof payload.action === 'string' ? payload.action : '';

    if (manageAction === 'list') {
      return {
        action: 'list',
        workbench: currentStatusSnapshot(true)
      };
    }

    if (manageAction === 'switch-module') {
      const targetModule = payload.module as WorkspaceModule;
      if (!VALID_MODULES.has(targetModule)) {
        throw Object.assign(new Error(`Invalid workbench module: ${String(payload.module)}`), {
          code: 'INVALID_MODULE'
        });
      }
      setTaskCenterOpenSync(false);
      if (callbacks?.navigateModule) {
        callbacks.navigateModule(targetModule);
      } else {
        registry.setModule(targetModule);
      }
      return {
        action: 'switch-module',
        module: registry.getSnapshot().module,
        workbench: currentStatusSnapshot(true)
      };
    }

    if (manageAction === 'activate-document') {
      const requestedId = typeof payload.documentId === 'string' ? payload.documentId.trim() : '';
      const requestedLabel = typeof payload.label === 'string' ? payload.label.trim() : '';
      if (!requestedId && !requestedLabel) {
        throw Object.assign(new Error('activate-document requires documentId or label'), {
          code: 'MISSING_DOCUMENT_ID'
        });
      }
      const snapshot = registry.getSnapshot();
      const targetDoc = resolveTargetDocument(snapshot, requestedId, requestedLabel);
      if (!targetDoc) {
        throw Object.assign(
          new Error(`Document not found: ${requestedId || requestedLabel}`),
          { code: 'MCP_DOCUMENT_NOT_FOUND' }
        );
      }
      const documentId = targetDoc.id;
      setTaskCenterOpenSync(false);
      if (callbacks?.activateDocument) {
        callbacks.activateDocument(documentId);
      } else {
        const view = snapshot.views.find(v => v.documentId === documentId);
        if (view) registry.activate(view.id);
      }
      if (typeof payload.module === 'string' && VALID_MODULES.has(payload.module as WorkspaceModule)) {
        const targetModule = payload.module as WorkspaceModule;
        if (callbacks?.navigateModule) {
          callbacks.navigateModule(targetModule);
        } else {
          registry.setModule(targetModule);
        }
      }
      const nextStatus = currentStatusSnapshot(true);
      return {
        action: 'activate-document',
        activatedDocumentId: documentId,
        document: nextStatus.documents?.find(doc => doc.id === documentId) ?? null,
        workbench: nextStatus
      };
    }

    if (manageAction === 'create-document') {
      const label = typeof payload.label === 'string' && payload.label.trim()
        ? payload.label.trim()
        : undefined;
      const targetModule = typeof payload.module === 'string' && VALID_MODULES.has(payload.module as WorkspaceModule)
        ? (payload.module as WorkspaceModule)
        : undefined;

      setTaskCenterOpenSync(false);
      let createdId: string;
      if (callbacks?.createDocument) {
        createdId = callbacks.createDocument({ label, module: targetModule });
      } else {
        const entry = registry.addDocument(null, label);
        if (targetModule) {
          registry.setModule(targetModule);
        }
        createdId = entry.id;
      }
      if (label && registry.getSnapshot().documents.some(entry => entry.id === createdId)) {
        registry.rename(createdId, label);
      }
      const nextStatus = currentStatusSnapshot(true);
      return {
        action: 'create-document',
        createdDocumentId: createdId,
        document: nextStatus.documents?.find(doc => doc.id === createdId) ?? null,
        workbench: nextStatus
      };
    }

    if (manageAction === 'close-document') {
      const snapshot = registry.getSnapshot();
      const activeView = snapshot.views.find(view => view.id === snapshot.activeViewId);
      const requestedId = typeof payload.documentId === 'string' ? payload.documentId.trim() : '';
      const requestedLabel = typeof payload.label === 'string' ? payload.label.trim() : '';
      const entry = (requestedId || requestedLabel)
        ? resolveTargetDocument(snapshot, requestedId, requestedLabel)
        : snapshot.documents.find(doc => doc.id === (activeView?.documentId ?? ''));
      const targetId = entry?.id ?? (requestedId || requestedLabel || activeView?.documentId || '');
      const standaloneOnlyFileDoc = !entry && targetId ? standaloneFileDocs.get(targetId) : undefined;
      if (!entry && !standaloneOnlyFileDoc) {
        throw Object.assign(new Error(`Document not found: ${targetId || '(none)'}`), {
          code: 'MCP_DOCUMENT_NOT_FOUND'
        });
      }
      if (entry) {
        if (['starting', 'running', 'pausing', 'paused', 'stopping'].includes(entry.runtime.phase)) {
          throw Object.assign(
            new Error(`Document "${entry.label}" (${targetId}) has an active runtime task and cannot be closed`),
            { code: 'MCP_DOCUMENT_BUSY' }
          );
        }
        const discardUnsaved = payload.discardUnsaved === true;
        const modelDoc = entry.store.getSnapshot();
        const isDirty = Boolean(
          modelDoc.draft.dirty ||
          entry.inputDirty?.gaussian ||
          entry.inputDirty?.orca
        );
        if (isDirty && !discardUnsaved) {
          throw Object.assign(
            new Error(`Document "${entry.label}" (${targetId}) has unsaved modifications. Pass discardUnsaved: true to force close.`),
            { code: 'MCP_DOCUMENT_UNSAVED' }
          );
        }
        if (callbacks?.closeDocument) {
          await callbacks.closeDocument(targetId, discardUnsaved);
        } else {
          await registry.closeDocument(targetId, discardUnsaved);
          if (registry.getSnapshot().documents.length === 0) {
            registry.addDocument();
          }
        }
      }
      await disposeStandaloneAnalysisDoc(targetId);
      return {
        action: 'close-document',
        closedDocumentId: targetId,
        workbench: currentStatusSnapshot(true)
      };
    }

    if (manageAction === 'open-task-center' || manageAction === 'close-task-center') {
      const shouldOpen = manageAction === 'open-task-center';
      setTaskCenterOpenSync(shouldOpen);
      return {
        action: manageAction,
        taskCenterOpen: shouldOpen,
        workbench: currentStatusSnapshot(true)
      };
    }

    if (manageAction === 'set-layout') {
      const requestedLayout = typeof payload.layout === 'string'
        ? (payload.layout as 'single' | 'tiled' | 'free')
        : undefined;
      if (requestedLayout !== undefined && !VALID_LAYOUTS.has(requestedLayout)) {
        throw Object.assign(new Error(`Invalid layout mode: ${String(payload.layout)}`), {
          code: 'INVALID_LAYOUT_MODE'
        });
      }
      const arrange = payload.arrange === true;
      let layout: McpLayoutState;
      if (callbacks?.setLayoutState) {
        layout = callbacks.setLayoutState({ layout: requestedLayout, arrange });
      } else {
        if (requestedLayout) {
          internalLayoutState = {
            deckMode: requestedLayout,
            multiMode: requestedLayout === 'single' ? internalLayoutState.multiMode : requestedLayout
          };
        }
        layout = internalLayoutState;
      }
      return {
        action: 'set-layout',
        layout,
        arranged: arrange,
        workbench: collectWorkbenchStatusSnapshot({
          registry,
          taskCenterOpen: resolveEffectiveTaskCenterOpen(),
          includeDocuments: true,
          layout
        })
      };
    }

    throw Object.assign(new Error(`Unsupported window-manage action: ${manageAction}`), {
      code: 'INVALID_WINDOW_ACTION'
    });
  }

  async function handleOpenFile(payload: Record<string, unknown>): Promise<unknown> {
    const registry = options.getRegistry();
    const callbacks = options.getCallbacks?.();
    const desktop = options.getDesktop?.();

    const fileName = typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim()
      : 'imported.xyz';
    const choice = resolveOpenFileTargetChoice(fileName, payload.target);
    const label = typeof payload.label === 'string' && payload.label.trim()
      ? payload.label.trim()
      : undefined;

    const launchBridge = desktop as (DesktopBridge & Partial<LaunchImportBridge>) | undefined;
    let sourceFile: ScientificSourceFile;
    if (
      isLaunchSourceDescriptor(payload.sourceDescriptor) &&
      typeof launchBridge?.readLaunchSource === 'function' &&
      typeof launchBridge?.closeLaunchSource === 'function'
    ) {
      sourceFile = launchSourceFile(payload.sourceDescriptor, launchBridge as DesktopBridge & LaunchImportBridge);
    } else if (typeof payload.text === 'string') {
      sourceFile = createInMemoryScientificSourceFile(fileName, payload.text);
    } else {
      throw Object.assign(
        new Error(`Unable to read file source "${fileName}": no launch token or text payload available`),
        { code: 'MCP_FILE_SOURCE_UNAVAILABLE' }
      );
    }

    setTaskCenterOpenSync(false);

    try {
      if (callbacks?.importScientificFile) {
        const outcome = await callbacks.importScientificFile(sourceFile, { choice, label });
        const nextStatus = currentStatusSnapshot(true);
        const docSummary = outcome.document
          ?? (outcome.openedDocumentId
            ? nextStatus.documents?.find(doc => doc.id === outcome.openedDocumentId) ?? null
            : null);
        return {
          openedDocumentId: outcome.openedDocumentId,
          openedDocumentIds: outcome.openedDocumentIds,
          targetChoice: outcome.targetChoice,
          ...(outcome.warnings?.length ? { warnings: outcome.warnings } : {}),
          document: docSummary,
          workbench: nextStatus
        };
      }

      const items = await importWorkspaceItems([sourceFile]);
      const openedIds: string[] = [];
      let lastKind: 'model' | 'result' = 'model';

      for (const item of items) {
        if (item.kind === 'model') {
          const entry = registry.addFragmentDocument(item.fragment);
          openedIds.push(entry.id);
          lastKind = 'model';
        } else if (item.kind === 'result') {
          if (choice === 'structure') {
            try {
              const lastFrame = await item.result.getFrame(Math.max(0, item.result.frames.length - 1));
              const [fragment] = modelFragmentsFromStructures([lastFrame]);
              const entry = registry.addFragmentDocument(fragment);
              openedIds.push(entry.id);
              lastKind = 'model';
            } finally {
              await Promise.resolve(item.result.dispose());
            }
          } else {
            const entry = registry.addEditableResultDocument(item.result, item.result.initialStructure);
            openedIds.push(entry.id);
            lastKind = 'result';
          }
        } else if (item.kind === 'diagnostic') {
          await Promise.resolve(item.diagnostic.dispose());
        }
      }

      if (!openedIds.length) {
        throw Object.assign(new Error(`No valid molecular structure or calculation result found in "${fileName}"`), {
          code: 'MCP_FILE_IMPORT_FAILED'
        });
      }

      const openedDocumentId = openedIds.at(-1)!;
      if (label) {
        registry.rename(openedDocumentId, label);
      }
      const view = registry.getSnapshot().views.find(v => v.documentId === openedDocumentId);
      if (view) {
        registry.activate(view.id);
      }
      registry.setModule(lastKind === 'result' ? 'analysis' : 'modeling');

      const nextStatus = currentStatusSnapshot(true);
      return {
        openedDocumentId,
        openedDocumentIds: openedIds,
        targetChoice: choice,
        document: nextStatus.documents?.find(doc => doc.id === openedDocumentId) ?? null,
        workbench: nextStatus
      };
    } finally {
      await Promise.resolve(sourceFile.close?.()).catch(() => {});
    }
  }

  function resolveTargetOrActiveDocument(documentIdRaw: unknown) {
    const registry = options.getRegistry();
    const snapshot = registry.getSnapshot();
    const requestedId = typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';
    const activeView = snapshot.views.find(view => view.id === snapshot.activeViewId);
    const entry = requestedId
      ? resolveTargetDocument(snapshot, requestedId, undefined)
      : snapshot.documents.find(doc => doc.id === (activeView?.documentId ?? '')) ?? snapshot.documents[0];
    if (!entry) {
      throw Object.assign(
        new Error(`Document not found: ${requestedId || '(no open document)'}`),
        { code: 'MCP_DOCUMENT_NOT_FOUND' }
      );
    }
    const modelDoc = entry.store.getSnapshot();
    const structure = modelDoc.draft.structure.atoms.length > 0
      ? modelDoc.draft.structure
      : (entry.result?.initialStructure ?? modelDoc.draft.structure);
    return { entry, modelDoc, structure };
  }

  function readEffectiveViewportState(documentId: string, pivot: Vector3): McpViewportSnapshot {
    const callbacks = options.getCallbacks?.();
    const external = callbacks?.getViewportState?.(documentId);
    const externalCamera = Array.isArray(external?.cameraView) && external.cameraView.length === 8
      ? [...external.cameraView]
      : null;
    const storedCamera = internalCameraViews.get(documentId);
    const cameraView = externalCamera
      ?? (storedCamera && storedCamera.length === 8 ? [...storedCamera] : defaultCameraViewForPivot(pivot));
    const displaySettings = external?.displaySettings
      ? { ...external.displaySettings }
      : { ...internalDisplaySettings };
    const showAxes = typeof external?.showAxes === 'boolean'
      ? external.showAxes
      : internalShowAxes;
    return {
      cameraView,
      displaySettings,
      showAxes
    };
  }

  async function handleViewportCamera(payload: Record<string, unknown>): Promise<unknown> {
    const callbacks = options.getCallbacks?.();
    const { entry, structure } = resolveTargetOrActiveDocument(payload.documentId);
    const pivot = computeStructurePivot(structure.atoms);
    const current = readEffectiveViewportState(entry.id, pivot);

    let nextView = [...current.cameraView];
    let cameraChanged = false;
    const resetView = payload.resetView === true;
    if (resetView) {
      nextView = defaultCameraViewForPivot(pivot);
      cameraChanged = true;
    }

    if (typeof payload.preset === 'string') {
      const preset = payload.preset as McpCameraPreset;
      let frame: ViewFrame | null = null;
      if (preset === 'principal-inertia') {
        frame = structure.atoms.length > 0
          ? principalInertiaFrame(structure.atoms)
          : cartesianViewFrame('Z');
      } else if (preset === 'X' || preset === 'Y' || preset === 'Z') {
        frame = cartesianViewFrame(preset);
      } else if (CELL_PRESETS.has(preset)) {
        if (!structure.cell) {
          throw Object.assign(
            new Error(`Cannot apply crystal cell camera preset "${preset}" to non-periodic structure "${entry.label}"`),
            { code: 'MCP_STRUCTURE_NOT_PERIODIC' }
          );
        }
        frame = cellViewFrame(structure.cell, preset);
        if (!frame) {
          throw Object.assign(
            new Error(`Degenerate unit cell cannot orient to preset "${preset}"`),
            { code: 'MCP_DEGENERATE_CELL' }
          );
        }
      } else {
        throw Object.assign(
          new Error(`Unsupported camera preset: ${String(payload.preset)}`),
          { code: 'INVALID_CAMERA_PRESET' }
        );
      }
      nextView = orientObjectView(nextView, frame, pivot);
      cameraChanged = true;
    }

    if (typeof payload.rotateStep === 'string') {
      if (!ROTATE_STEPS.has(payload.rotateStep as McpRotateStep)) {
        throw Object.assign(
          new Error(`Invalid rotateStep: ${String(payload.rotateStep)}`),
          { code: 'INVALID_ROTATE_STEP' }
        );
      }
      nextView = rotateObjectViewStep(nextView, payload.rotateStep as McpRotateStep, pivot);
      cameraChanged = true;
    }

    if (payload.rotateDelta && typeof payload.rotateDelta === 'object' && !Array.isArray(payload.rotateDelta)) {
      const delta = payload.rotateDelta as Record<string, unknown>;
      const dx = typeof delta.dx === 'number' && Number.isFinite(delta.dx) ? delta.dx : 0;
      const dy = typeof delta.dy === 'number' && Number.isFinite(delta.dy) ? delta.dy : 0;
      nextView = rotateObjectView(nextView, dx, dy, pivot);
      cameraChanged = true;
    }

    if (typeof payload.zoom === 'number' && Number.isFinite(payload.zoom) && payload.zoom > 0) {
      nextView = [...nextView];
      const baseZoom = Number.isFinite(nextView[3]) && nextView[3] > 0 ? nextView[3] : 125;
      nextView[3] = Math.max(5, Math.min(2000, baseZoom * payload.zoom));
      cameraChanged = true;
    }

    const displayPatch = applyMcpDisplayPatch(
      current.displaySettings,
      current.showAxes,
      payload.display as Record<string, unknown> | undefined
    );

    internalCameraViews.set(entry.id, [...nextView]);
    internalDisplaySettings = { ...displayPatch.displaySettings };
    internalShowAxes = displayPatch.showAxes;

    if (callbacks?.applyViewportState) {
      await callbacks.applyViewportState(entry.id, {
        ...(cameraChanged ? { cameraView: [...nextView] } : {}),
        ...(resetView ? { resetView: true } : {}),
        ...(displayPatch.changedDisplay ? { displaySettings: { ...displayPatch.displaySettings } } : {}),
        ...(displayPatch.changedAxes ? { showAxes: displayPatch.showAxes } : {})
      });
    }

    return {
      documentId: entry.id,
      label: entry.label,
      cameraView: nextView,
      pivot: [...pivot],
      display: formatMcpDisplayState(displayPatch.displaySettings, displayPatch.showAxes),
      workbench: currentStatusSnapshot(false)
    };
  }

  async function handleViewportScreenshot(payload: Record<string, unknown>): Promise<unknown> {
    const callbacks = options.getCallbacks?.();
    const { entry, structure } = resolveTargetOrActiveDocument(payload.documentId);
    const pivot = computeStructurePivot(structure.atoms);
    const current = readEffectiveViewportState(entry.id, pivot);

    const width = typeof payload.width === 'number' && Number.isInteger(payload.width)
      ? Math.max(160, Math.min(4096, payload.width))
      : 1200;
    const height = typeof payload.height === 'number' && Number.isInteger(payload.height)
      ? Math.max(120, Math.min(4096, payload.height))
      : 900;
    const transparent = payload.transparent === true;
    const includeAnnotations = payload.includeAnnotations !== false;

    let rendered: McpScreenshotRenderOutcome | null = null;
    if (callbacks?.captureViewportScreenshot) {
      try {
        rendered = await callbacks.captureViewportScreenshot(entry.id, {
          width,
          height,
          transparent,
          includeAnnotations,
          cameraView: current.cameraView,
          displaySettings: current.displaySettings,
          showAxes: current.showAxes
        });
      } catch {
        rendered = null;
      }
    }

    if (!rendered || typeof rendered.base64Png !== 'string' || !rendered.base64Png) {
      const base64Png = renderFallbackViewportPngBase64({
        structure,
        cameraView: current.cameraView,
        pivot,
        width,
        height,
        transparent
      });
      rendered = {
        base64Png,
        width,
        height,
        renderer: 'fallback-2d'
      };
    }

    return {
      documentId: entry.id,
      label: entry.label,
      formula: computeHillFormula(structure.atoms),
      atomCount: structure.atoms.length,
      width: rendered.width,
      height: rendered.height,
      transparent,
      includeAnnotations,
      renderer: rendered.renderer,
      cameraView: current.cameraView,
      pivot: [...pivot],
      display: formatMcpDisplayState(current.displaySettings, current.showAxes),
      base64Png: rendered.base64Png
    };
  }

  function resolveEditableTargetDocument(
    documentIdRaw: unknown,
    access: 'edit' | 'selection' | 'history' | 'constraints' = 'edit',
    hasScans = false
  ) {
    const resolved = resolveTargetOrActiveDocument(documentIdRaw);
    const { entry, modelDoc } = resolved;
    if (entry.result || isConformerWorkspaceResult(entry)) {
      throw Object.assign(
        new Error(`Document "${entry.label}" is a read-only calculation or conformer collection result; extract a frame to a modeling document before editing`),
        { code: 'MCP_READ_ONLY_RESULT' }
      );
    }
    if (access === 'constraints' && !workspaceFreezeEditingAllowed(entry)) {
      throw Object.assign(
        new Error(`Document "${entry.label}" does not allow constraint editing in its current role`),
        { code: 'MCP_READ_ONLY_RESULT' }
      );
    }
    if ((access === 'edit' || (access === 'constraints' && hasScans)) && modelDoc.analysisBindingId) {
      throw Object.assign(
        new Error(`Document "${entry.label}" is bound to an active calculation/analysis result; extract a frame to a modeling document before editing structure or scan coordinates`),
        { code: 'MCP_READ_ONLY_RESULT' }
      );
    }
    if (
      ['starting', 'running', 'pausing', 'paused', 'stopping'].includes(entry.runtime.phase) ||
      entry.store.isRuntimeSessionActive?.() ||
      entry.store.hasTransaction?.()
    ) {
      throw Object.assign(
        new Error(`Document "${entry.label}" is currently busy with an active runtime session or gesture transaction`),
        { code: 'MCP_DOCUMENT_BUSY' }
      );
    }
    return resolved;
  }

  function resolveOneBasedAtomIndices(
    structure: Structure,
    indicesRaw: unknown,
    fieldName = 'atoms'
  ): { indices: number[]; atomIds: string[] } {
    if (!Array.isArray(indicesRaw)) {
      throw Object.assign(
        new Error(`${fieldName} must be an array of 1-based atom indices`),
        { code: 'INVALID_ATOM_INDICES' }
      );
    }
    const maxIndex = structure.atoms.length;
    const indices: number[] = [];
    const atomIds: string[] = [];
    for (const raw of indicesRaw) {
      const idx = Number(raw);
      if (!Number.isInteger(idx) || idx < 1 || idx > maxIndex) {
        throw Object.assign(
          new Error(`Atom index ${String(raw)} in ${fieldName} is out of range (1..${maxIndex})`),
          { code: 'MCP_ATOM_INDEX_OUT_OF_RANGE' }
        );
      }
      const atom = structure.atoms[idx - 1];
      if (!atom?.id) {
        throw Object.assign(
          new Error(`Atom at index ${idx} is missing a stable atomId`),
          { code: 'MCP_INVALID_STRUCTURE_STATE' }
        );
      }
      indices.push(idx);
      atomIds.push(atom.id);
    }
    return { indices, atomIds };
  }

  function formatConstraintsSnapshot(modelDoc: ModelDocument, structure: Structure) {
    const atomIdToIndex = new Map(structure.atoms.map((atom, idx) => [atom.id ?? '', idx + 1]));
    let effective = {
      frozenAtomIds: [] as string[],
      coordinates: [] as ModelCoordinate[]
    };
    try {
      effective = effectiveModelConstraints(modelDoc);
    } catch {
      effective = {
        frozenAtomIds: modelDoc.sharedConstraints?.frozenAtomIds ?? modelDoc.draft.assignments?.frozenAtomIds ?? [],
        coordinates: [
          ...(modelDoc.sharedConstraints?.coordinates ?? []),
          ...(modelDoc.internalCoordinates ?? [])
        ]
      };
    }

    const frozenAtomIndices = effective.frozenAtomIds
      .map(id => atomIdToIndex.get(id) ?? 0)
      .filter(idx => idx > 0);

    const coordinates = effective.coordinates.map(coord => {
      const atoms = coord.atomIds.map(id => atomIdToIndex.get(id) ?? 0);
      let currentValue: number | null = null;
      try {
        currentValue = Number(builderCoordinateValue(structure, coord.type, coord.atomIds, coord.images).toFixed(6));
      } catch {
        currentValue = null;
      }
      const normalizedSteps = coord.source === 'orca' && coord.action === 'scan' && coord.steps > 1
        ? coord.steps - 1
        : coord.steps;
      return {
        ...(coord.id ? { id: coord.id } : {}),
        ...(coord.objectId ? { objectId: coord.objectId } : {}),
        type: coord.type,
        atoms,
        atomIds: [...coord.atomIds],
        action: coord.action,
        currentValue,
        unit: coord.type === 'B' ? ('angstrom' as const) : ('degree' as const),
        ...(coord.value !== undefined ? { targetValue: coord.value } : {}),
        ...(coord.action === 'scan'
          ? {
              steps: normalizedSteps,
              increment: coord.increment,
              ...(coord.start !== undefined ? { start: coord.start } : {}),
              ...(coord.end !== undefined ? { end: coord.end } : {})
            }
          : {})
      };
    });

    return {
      enabled: modelDoc.sharedConstraints?.enabled !== false,
      frozenAtomIndices,
      frozenAtomIds: [...effective.frozenAtomIds],
      coordinates
    };
  }

  async function handleGetStructureInfo(payload: Record<string, unknown>): Promise<unknown> {
    const { entry, modelDoc, structure } = resolveTargetOrActiveDocument(payload.documentId);
    const includeAtoms = payload.includeAtoms !== false;
    const includeBonds = payload.includeBonds !== false;
    const includeRotatableTorsions = payload.includeRotatableTorsions === true;
    const selectedOnly = payload.selectedOnly === true;

    const atomIdToIndex = new Map(structure.atoms.map((atom, idx) => [atom.id ?? '', idx + 1]));
    const selectedIdSet = new Set(modelDoc.selection.atomIds);
    const constraints = formatConstraintsSnapshot(modelDoc, structure);
    const frozenIdSet = new Set(constraints.frozenAtomIds);

    const neighborSets = structure.atoms.map(() => new Set<number>());
    const formattedBonds = (structure.bonds ?? []).map((bond, bondIdx) => {
      const aAtom = structure.atoms[bond.a];
      const bAtom = structure.atoms[bond.b];
      if (aAtom && bAtom) {
        neighborSets[bond.a]?.add(bond.b + 1);
        neighborSets[bond.b]?.add(bond.a + 1);
      }
      let lengthAngstrom = 0;
      if (aAtom && bAtom) {
        if (structure.cell && bond.image?.some(Boolean)) {
          const shift = fractionalToCartesian(structure.cell, bond.image, false);
          lengthAngstrom = Math.hypot(
            bAtom.x + shift[0] - aAtom.x,
            bAtom.y + shift[1] - aAtom.y,
            bAtom.z + shift[2] - aAtom.z
          );
        } else if (structure.cell && structure.cell.pbc?.some(Boolean)) {
          lengthAngstrom = minimumImage(structure, bond.a, bond.b).distance;
        } else {
          lengthAngstrom = Math.hypot(bAtom.x - aAtom.x, bAtom.y - aAtom.y, bAtom.z - aAtom.z);
        }
      }
      return {
        index: bondIdx + 1,
        a: bond.a + 1,
        b: bond.b + 1,
        aIndex: bond.a + 1,
        bIndex: bond.b + 1,
        aAtomId: aAtom?.id ?? '',
        bAtomId: bAtom?.id ?? '',
        aElement: aAtom?.element ?? '',
        bElement: bAtom?.element ?? '',
        order: bond.order,
        lengthAngstrom: Number(lengthAngstrom.toFixed(6)),
        aromatic: Boolean(bond.aromatic),
        kind: (bond.kind ?? 'covalent') as 'covalent' | 'coordination' | 'auxiliary',
        ...(bond.image?.some(Boolean) ? { image: [...bond.image] } : {})
      };
    });

    for (const rel of modelDoc.auxiliaryRelations ?? []) {
      const aOneBased = atomIdToIndex.get(rel.a) ?? 0;
      const bOneBased = atomIdToIndex.get(rel.b) ?? 0;
      if (aOneBased < 1 || bOneBased < 1) continue;
      const aAtom = structure.atoms[aOneBased - 1];
      const bAtom = structure.atoms[bOneBased - 1];
      if (!aAtom || !bAtom) continue;
      neighborSets[aOneBased - 1]?.add(bOneBased);
      neighborSets[bOneBased - 1]?.add(aOneBased);
      const lengthAngstrom = structure.cell && structure.cell.pbc?.some(Boolean)
        ? minimumImage(structure, aOneBased - 1, bOneBased - 1).distance
        : Math.hypot(bAtom.x - aAtom.x, bAtom.y - aAtom.y, bAtom.z - aAtom.z);
      formattedBonds.push({
        index: formattedBonds.length + 1,
        a: aOneBased,
        b: bOneBased,
        aIndex: aOneBased,
        bIndex: bOneBased,
        aAtomId: rel.a,
        bAtomId: rel.b,
        aElement: aAtom.element,
        bElement: bAtom.element,
        order: rel.order,
        lengthAngstrom: Number(lengthAngstrom.toFixed(6)),
        aromatic: false,
        kind: 'auxiliary'
      });
    }

    let cellInfo: Record<string, unknown> | null = null;
    if (structure.cell) {
      try {
        const [a, b, c, alpha, beta, gamma] = cellParameters(structure.cell);
        const [va, vb, vc] = structure.cell.vectors;
        const volumeAngstrom3 = Math.abs(dot3(va, cross3(vb, vc)));
        cellInfo = {
          vectors: structure.cell.vectors.map(v => [...v]),
          pbc: [...structure.cell.pbc],
          origin: structure.cell.origin ? [...structure.cell.origin] : [0, 0, 0],
          parameters: {
            a: Number(a.toFixed(6)),
            b: Number(b.toFixed(6)),
            c: Number(c.toFixed(6)),
            alpha: Number(alpha.toFixed(4)),
            beta: Number(beta.toFixed(4)),
            gamma: Number(gamma.toFixed(4))
          },
          volumeAngstrom3: Number(volumeAngstrom3.toFixed(6))
        };
      } catch {
        cellInfo = {
          vectors: structure.cell.vectors.map(v => [...v]),
          pbc: [...structure.cell.pbc],
          origin: structure.cell.origin ? [...structure.cell.origin] : [0, 0, 0]
        };
      }
    }

    const allAtoms = structure.atoms.map((atom, idx) => {
      const atomId = atom.id ?? `atom-${idx + 1}`;
      const neighbors = [...(neighborSets[idx] ?? [])].sort((x, y) => x - y);
      let fractional: Vector3 | undefined;
      if (structure.cell) {
        try {
          const frac = cartesianToFractional(structure.cell, [atom.x, atom.y, atom.z]);
          fractional = [
            Number(frac[0].toFixed(6)),
            Number(frac[1].toFixed(6)),
            Number(frac[2].toFixed(6))
          ];
        } catch {
          fractional = undefined;
        }
      }
      return {
        index: idx + 1,
        atomId,
        element: atom.element,
        x: Number(atom.x.toFixed(6)),
        y: Number(atom.y.toFixed(6)),
        z: Number(atom.z.toFixed(6)),
        ...(fractional ? { fractional } : {}),
        formalCharge: atom.formalCharge ?? 0,
        neighbors,
        coordinationNumber: neighbors.length,
        selected: selectedIdSet.has(atomId),
        frozen: frozenIdSet.has(atomId)
      };
    });

    const filteredAtoms = selectedOnly ? allAtoms.filter(a => a.selected) : allAtoms;
    const filteredBonds = selectedOnly
      ? formattedBonds.filter(b => selectedIdSet.has(b.aAtomId) || selectedIdSet.has(b.bAtomId))
      : formattedBonds;

    let rotatableTorsions: Record<string, unknown> | undefined;
    if (includeRotatableTorsions) {
      if (structure.cell?.pbc?.some(Boolean)) {
        rotatableTorsions = {
          available: false,
          reason: 'Periodic structures do not support finite-molecule rotatable torsion discovery',
          count: 0,
          torsions: []
        };
      } else if (structure.atoms.length < 4 || !(structure.bonds?.length)) {
        rotatableTorsions = {
          available: false,
          reason: 'Structure requires at least 4 bonded atoms for rotatable dihedral torsion discovery',
          count: 0,
          torsions: []
        };
      } else {
        try {
          const snapshot = createConformerSnapshot(
            structure,
            { documentId: entry.id, revision: modelDoc.revision },
            {
              frozenAtomIds: constraints.frozenAtomIds,
              coordinates: (modelDoc.sharedConstraints?.coordinates ?? []).filter(c => c.action === 'freeze')
            }
          );
          const discovery = findRotatableTorsions(snapshot);
          const torsions = discovery.torsions.map(t => {
            const atoms = t.atomIds.map(id => atomIdToIndex.get(id) ?? 0) as [number, number, number, number];
            const elements = t.atomIds.map(id => {
              const idx = atomIdToIndex.get(id);
              return idx ? structure.atoms[idx - 1]?.element ?? '' : '';
            }) as [string, string, string, string];
            const movingAtomIndices = t.movingAtomIds
              .map(id => atomIdToIndex.get(id) ?? 0)
              .filter(idx => idx > 0)
              .sort((a, b) => a - b);
            return {
              atoms,
              atomIds: [...t.atomIds],
              axisAtoms: [atoms[1], atoms[2]] as [number, number],
              elements,
              dihedralDegrees: Number(t.sourceDegrees.toFixed(4)),
              movingSide: t.movingSide,
              movingAtomIndices
            };
          });
          rotatableTorsions = {
            available: true,
            count: torsions.length,
            excludedCount: discovery.excluded.length,
            torsions
          };
        } catch (error) {
          rotatableTorsions = {
            available: false,
            reason: error instanceof Error ? error.message : String(error),
            count: 0,
            torsions: []
          };
        }
      }
    }

    const selectedAtomIndices = modelDoc.selection.atomIds
      .map(id => atomIdToIndex.get(id) ?? 0)
      .filter(idx => idx > 0);

    return {
      documentId: entry.id,
      label: entry.label,
      revision: modelDoc.revision,
      readOnly: Boolean(entry.result || isConformerWorkspaceResult(entry) || modelDoc.analysisBindingId),
      freezeEditingAllowed: !entry.result && workspaceFreezeEditingAllowed(entry),
      formula: computeHillFormula(structure.atoms),
      atomCount: structure.atoms.length,
      bondCount: formattedBonds.length,
      charge: structure.charge,
      multiplicity: structure.multiplicity,
      electronicStateConfirmed: Boolean(entry.electronicStateConfirmed || modelDoc.electronicStateConfirmed),
      isPeriodic: Boolean(structure.cell && structure.cell.pbc?.some(Boolean)),
      cell: cellInfo,
      selection: {
        selectedAtomIndices,
        selectedAtomIds: [...modelDoc.selection.atomIds]
      },
      constraints,
      ...(includeAtoms ? { atoms: filteredAtoms } : {}),
      ...(includeBonds ? { bonds: filteredBonds } : {}),
      ...(rotatableTorsions !== undefined ? { rotatableTorsions } : {})
    };
  }

  async function handleMeasureGeometry(payload: Record<string, unknown>): Promise<unknown> {
    const { entry, modelDoc, structure } = resolveTargetOrActiveDocument(payload.documentId);
    const highlightAtoms = new Set<string>();
    const measuredResults: Array<Record<string, unknown>> = [];

    if (Array.isArray(payload.measurements)) {
      for (const rawItem of payload.measurements) {
        if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
        const item = rawItem as { type?: unknown; atoms?: unknown };
        const type = item.type as 'B' | 'A' | 'D';
        const expectedCount = type === 'B' ? 2 : type === 'A' ? 3 : 4;
        const { indices, atomIds } = resolveOneBasedAtomIndices(structure, item.atoms, `measurements[${type}].atoms`);
        if (indices.length !== expectedCount || new Set(indices).size !== expectedCount) {
          throw Object.assign(
            new Error(`Measurement ${type} requires ${expectedCount} distinct 1-based atom indices`),
            { code: 'INVALID_MEASUREMENT_SPEC' }
          );
        }
        const value = Number(builderCoordinateValue(structure, type, atomIds).toFixed(6));
        const elements = indices.map(idx => structure.atoms[idx - 1].element);
        for (const id of atomIds) highlightAtoms.add(id);
        measuredResults.push({
          type,
          atoms: indices,
          atomIds,
          elements,
          label: `${type}(${indices.map((idx, i) => `${elements[i]}${idx}`).join('-')})`,
          value,
          unit: type === 'B' ? 'angstrom' : 'degree'
        });
      }
    }

    let neighborShellResult: Record<string, unknown> | undefined;
    if (payload.neighborShell && typeof payload.neighborShell === 'object' && !Array.isArray(payload.neighborShell)) {
      const shellSpec = payload.neighborShell as {
        centerAtom?: unknown;
        cutoffAngstrom?: unknown;
        includeAngles?: unknown;
      };
      const { indices: [centerAtom], atomIds: [centerAtomId] } = resolveOneBasedAtomIndices(
        structure,
        [shellSpec.centerAtom],
        'neighborShell.centerAtom'
      );
      const centerIdx = centerAtom - 1;
      const centerElement = structure.atoms[centerIdx].element;
      const cutoffAngstrom = typeof shellSpec.cutoffAngstrom === 'number' && Number.isFinite(shellSpec.cutoffAngstrom) && shellSpec.cutoffAngstrom > 0
        ? Math.min(20, shellSpec.cutoffAngstrom)
        : 3.0;
      const includeAngles = shellSpec.includeAngles !== false;

      highlightAtoms.add(centerAtomId);
      const bondMap = new Map<number, number>();
      for (const bond of structure.bonds ?? []) {
        if (bond.a === centerIdx) bondMap.set(bond.b, bond.order);
        else if (bond.b === centerIdx) bondMap.set(bond.a, bond.order);
      }

      const neighborsWithDelta: Array<{
        atom: number;
        atomId: string;
        element: string;
        distanceAngstrom: number;
        bonded: boolean;
        bondOrder: number | null;
        image: Vector3;
        delta: Vector3;
      }> = [];

      for (let idx = 0; idx < structure.atoms.length; idx++) {
        if (idx === centerIdx) continue;
        const minImg = minimumImage(structure, centerIdx, idx);
        if (minImg.distance <= cutoffAngstrom + 1e-9 && minImg.distance > 1e-8) {
          const other = structure.atoms[idx];
          const otherId = other.id ?? `atom-${idx + 1}`;
          highlightAtoms.add(otherId);
          neighborsWithDelta.push({
            atom: idx + 1,
            atomId: otherId,
            element: other.element,
            distanceAngstrom: Number(minImg.distance.toFixed(6)),
            bonded: bondMap.has(idx),
            bondOrder: bondMap.get(idx) ?? null,
            image: [...minImg.image],
            delta: minImg.delta
          });
        }
      }

      neighborsWithDelta.sort((a, b) => a.distanceAngstrom - b.distanceAngstrom || a.atom - b.atom);

      let angles: Array<{
        atoms: [number, number, number];
        elements: [string, string, string];
        angleDegrees: number;
      }> | undefined;
      if (includeAngles && neighborsWithDelta.length >= 2) {
        angles = [];
        const maxShellForAngles = Math.min(neighborsWithDelta.length, 12);
        for (let i = 0; i < maxShellForAngles; i++) {
          for (let j = i + 1; j < maxShellForAngles; j++) {
            const ni = neighborsWithDelta[i];
            const nj = neighborsWithDelta[j];
            const lenI = norm3(ni.delta);
            const lenJ = norm3(nj.delta);
            if (lenI > 1e-8 && lenJ > 1e-8) {
              const cosTheta = Math.max(-1, Math.min(1, dot3(ni.delta, nj.delta) / (lenI * lenJ)));
              const angleDegrees = Number((Math.acos(cosTheta) * 180 / Math.PI).toFixed(4));
              angles.push({
                atoms: [ni.atom, centerAtom, nj.atom],
                elements: [ni.element, centerElement, nj.element],
                angleDegrees
              });
            }
          }
        }
      }

      neighborShellResult = {
        centerAtom,
        centerAtomId,
        centerElement,
        cutoffAngstrom,
        coordinationCount: neighborsWithDelta.length,
        neighbors: neighborsWithDelta.map(({ delta: _delta, ...rest }) => rest),
        ...(angles !== undefined ? { angles } : {})
      };
    }

    let selectedAtomIndices: number[] | undefined;
    if (payload.selectMeasuredAtoms === true && !entry.result && modelDoc.draft.structure.atoms.length > 0) {
      const atomIdsToSelect = [...highlightAtoms];
      entry.store.select({
        atomIds: atomIdsToSelect,
        bonds: [],
        auxiliaryIds: []
      });
      const atomIdToIndex = new Map(structure.atoms.map((atom, idx) => [atom.id ?? '', idx + 1]));
      selectedAtomIndices = atomIdsToSelect
        .map(id => atomIdToIndex.get(id) ?? 0)
        .filter(idx => idx > 0);
    }

    return {
      documentId: entry.id,
      label: entry.label,
      revision: entry.store.getSnapshot().revision,
      measurements: measuredResults,
      ...(neighborShellResult ? { neighborShell: neighborShellResult } : {}),
      ...(selectedAtomIndices !== undefined ? { selectedAtomIndices } : {})
    };
  }

  async function handleEditStructure(payload: Record<string, unknown>): Promise<unknown> {
    const registry = options.getRegistry();
    const operation = String(payload.operation ?? '');
    const accessMode: 'edit' | 'selection' | 'history' = operation === 'select-atoms'
      ? 'selection'
      : (operation === 'undo' || operation === 'redo')
        ? 'history'
        : 'edit';
    const { entry, modelDoc, structure } = resolveEditableTargetDocument(payload.documentId, accessMode);
    const previousRevision = modelDoc.revision;

    if (operation === 'set-electronic-state') {
      const charge = Number(payload.charge);
      const multiplicity = Number(payload.multiplicity);
      const confirmed = payload.confirmed !== false;
      if (!Number.isInteger(charge) || !Number.isInteger(multiplicity) || multiplicity < 1) {
        throw Object.assign(
          new Error('set-electronic-state requires integer charge and integer multiplicity >= 1'),
          { code: 'INVALID_ELECTRONIC_STATE' }
        );
      }
      if (structure.atoms.length > 0) {
        const stateErr = electronicStateError(structure.atoms, charge, multiplicity);
        if (stateErr) {
          throw Object.assign(new Error(stateErr), { code: 'INVALID_ELECTRONIC_STATE' });
        }
      }
      entry.store.execute({
        type: 'set-electronic-state',
        charge,
        multiplicity,
        confirmed
      });
    } else if (operation === 'select-atoms') {
      const { atomIds } = resolveOneBasedAtomIndices(structure, payload.atoms ?? [], 'atoms');
      entry.store.select({
        atomIds: [...new Set(atomIds)],
        bonds: [],
        auxiliaryIds: []
      });
    } else if (operation === 'set-geometry') {
      const { atomIds } = resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms');
      const coordinate = (typeof payload.coordinate === 'string'
        ? payload.coordinate
        : ({ 2: 'B', 3: 'A', 4: 'D' }[atomIds.length])) as 'B' | 'A' | 'D';
      const value = Number(payload.value);
      const fixedSide = payload.fixedSide === 'last' ? 'last' : 'first';
      const moving = (payload.moving === 'selected' || payload.moving === 'atom')
        ? payload.moving
        : 'branch';
      const movingAtomIds = payload.movingAtoms !== undefined
        ? [...new Set(resolveOneBasedAtomIndices(structure, payload.movingAtoms, 'movingAtoms').atomIds)]
        : undefined;
      entry.store.execute({
        type: 'legacy',
        command: {
          type: 'geometry',
          coordinate,
          atomIds,
          value,
          fixedSide,
          moving,
          ...(movingAtomIds ? { movingAtomIds } : {})
        }
      });
    } else if (operation === 'change-element') {
      const { atomIds } = resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms');
      let symbol: string;
      try {
        symbol = elementSymbol(String(payload.element ?? '').trim());
      } catch (err) {
        throw Object.assign(
          new Error(err instanceof Error ? err.message : String(err)),
          { code: 'INVALID_ELEMENT' }
        );
      }
      entry.store.execute({
        type: 'legacy',
        command: {
          type: 'change-element',
          atomIds: [...new Set(atomIds)],
          element: symbol
        }
      });
    } else if (operation === 'add-atom') {
      let symbol: string;
      try {
        symbol = elementSymbol(String(payload.element ?? '').trim());
      } catch (err) {
        throw Object.assign(
          new Error(err instanceof Error ? err.message : String(err)),
          { code: 'INVALID_ELEMENT' }
        );
      }
      const posRaw = payload.position as number[];
      const position: Vector3 = [Number(posRaw[0]), Number(posRaw[1]), Number(posRaw[2])];
      let anchorAtomId: string | undefined;
      if (payload.anchorAtom !== undefined) {
        anchorAtomId = resolveOneBasedAtomIndices(structure, [payload.anchorAtom], 'anchorAtom').atomIds[0];
      }
      const isPeriodic = Boolean(structure.cell && structure.cell.pbc?.some(Boolean));
      const probeAtom = { element: symbol, x: position[0], y: position[1], z: position[2] };
      for (let i = 0; i < structure.atoms.length; i++) {
        const existing = structure.atoms[i];
        const dist = isPeriodic
          ? minimumImage(structure, probeAtom, existing).distance
          : Math.hypot(position[0] - existing.x, position[1] - existing.y, position[2] - existing.z);
        if (dist < obviousClashDistance(symbol, existing.element)) {
          throw Object.assign(
            new Error(`New ${symbol} atom at [${position.join(', ')}] severely overlaps with existing atom ${i + 1} (${existing.element}, d=${dist.toFixed(4)} Å)`),
            { code: 'MCP_ATOM_POSITION_CLASH' }
          );
        }
      }
      const prevIds = new Set(structure.atoms.map(a => a.id!));
      entry.store.beginTransaction('MCP add-atom');
      let committed = false;
      try {
        const afterPlace = entry.store.execute({
          type: 'place-element',
          element: symbol,
          presetId: `${symbol.toLowerCase()}-atom`,
          position
        });
        if (anchorAtomId) {
          const addedAtom = afterPlace.draft.structure.atoms.find(a => a.id && !prevIds.has(a.id));
          if (!addedAtom?.id) {
            throw Object.assign(
              new Error('Failed to resolve newly placed atom identity for anchor bond creation'),
              { code: 'MCP_ADD_ATOM_FAILED' }
            );
          }
          entry.store.execute({
            type: 'set-bond-order',
            atomIds: [anchorAtomId, addedAtom.id],
            order: 1
          });
        }
        entry.store.endTransaction();
        committed = true;
      } catch (err) {
        if (!committed) entry.store.cancelTransaction();
        throw err;
      }
    } else if (operation === 'delete-atoms') {
      const { atomIds } = resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms');
      entry.store.execute({
        type: 'delete-objects',
        selection: {
          atomIds: [...new Set(atomIds)],
          bonds: [],
          auxiliaryIds: []
        }
      });
    } else if (operation === 'add-single-hydrogen') {
      const { atomIds } = resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms');
      const uniqueAtomIds = [...new Set(atomIds)];
      const commands: ModelCommand[] = uniqueAtomIds.map(atomId => ({
        type: 'add-single-hydrogen',
        atomId
      }));
      if (commands.length === 1) {
        entry.store.execute(commands[0]);
      } else if (entry.store.executeBatch) {
        entry.store.executeBatch(commands, 'MCP add-single-hydrogen');
      } else {
        for (const cmd of commands) entry.store.execute(cmd);
      }
    } else if (operation === 'set-bond-order') {
      const { indices, atomIds } = resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms');
      const order = Number(payload.order) as BondOrder;
      const idxA = indices[0] - 1;
      const idxB = indices[1] - 1;
      let image: Vector3 | undefined;
      if (Array.isArray(payload.image) && payload.image.length === 3) {
        image = [Number(payload.image[0]), Number(payload.image[1]), Number(payload.image[2])];
      } else {
        const candidates = (structure.bonds ?? []).filter(
          b => (b.a === idxA && b.b === idxB) || (b.a === idxB && b.b === idxA)
        );
        if (candidates.length === 1 && candidates[0].image?.some(Boolean)) {
          const matched = candidates[0];
          image = matched.a === idxA
            ? [...matched.image!]
            : (matched.image!.map(v => (v === 0 ? 0 : -v)) as Vector3);
        }
      }
      entry.store.execute({
        type: 'set-bond-order',
        atomIds: [atomIds[0], atomIds[1]],
        order,
        ...(image?.some(Boolean) ? { image } : {})
      });
    } else if (operation === 'delete-bond') {
      const { indices, atomIds } = resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms');
      const idxA = indices[0] - 1;
      const idxB = indices[1] - 1;
      const explicitImage: Vector3 | undefined = Array.isArray(payload.image) && payload.image.length === 3
        ? [Number(payload.image[0]), Number(payload.image[1]), Number(payload.image[2])]
        : undefined;

      const matchingBonds = (structure.bonds ?? [])
        .filter(bond => {
          const sameOrder = bond.a === idxA && bond.b === idxB;
          const reverseOrder = bond.a === idxB && bond.b === idxA;
          if (!sameOrder && !reverseOrder) return false;
          if (!explicitImage) return true;
          const orientedBondImage: Vector3 = bond.image
            ? (sameOrder ? [...bond.image] : (bond.image.map(v => (v === 0 ? 0 : -v)) as Vector3))
            : [0, 0, 0];
          return (
            orientedBondImage[0] === explicitImage[0] &&
            orientedBondImage[1] === explicitImage[1] &&
            orientedBondImage[2] === explicitImage[2]
          );
        })
        .map(bond => bondReference(structure, bond));

      const matchingAuxIds = (!explicitImage || explicitImage.every(v => v === 0))
        ? (modelDoc.auxiliaryRelations ?? [])
            .filter(
              rel =>
                (rel.a === atomIds[0] && rel.b === atomIds[1]) ||
                (rel.a === atomIds[1] && rel.b === atomIds[0])
            )
            .map(rel => rel.id)
        : [];

      if (matchingBonds.length === 0 && matchingAuxIds.length === 0) {
        throw Object.assign(
          new Error(`No bond found between atoms ${indices[0]} and ${indices[1]}`),
          { code: 'MCP_BOND_NOT_FOUND' }
        );
      }

      entry.store.execute({
        type: 'delete-objects',
        selection: {
          atomIds: [],
          bonds: matchingBonds,
          auxiliaryIds: matchingAuxIds
        }
      });
    } else if (operation === 'translate') {
      const deltaRaw = payload.delta as number[];
      const delta: Vector3 = [Number(deltaRaw[0]), Number(deltaRaw[1]), Number(deltaRaw[2])];
      const atomIds = payload.atoms !== undefined
        ? [...new Set(resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms').atomIds)]
        : undefined;
      const candidate = prepareStructureTransform(entry.store.getSnapshot(), {
        type: 'translate',
        delta,
        ...(atomIds ? { atomIds } : {})
      });
      entry.store.execute({ type: 'apply-structure-transform', candidate });
    } else if (operation === 'rotate') {
      const degrees = Number(payload.degrees);
      const axisRaw = payload.axis;
      const axis: Vector3 = axisRaw === 'x'
        ? [1, 0, 0]
        : axisRaw === 'y'
          ? [0, 1, 0]
          : axisRaw === 'z'
            ? [0, 0, 1]
            : [Number((axisRaw as number[])[0]), Number((axisRaw as number[])[1]), Number((axisRaw as number[])[2])];
      if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-12) {
        throw Object.assign(
          new Error('rotate axis vector cannot be the zero vector [0, 0, 0]'),
          { code: 'INVALID_ROTATION_OPTIONS' }
        );
      }
      const pivotRaw = Array.isArray(payload.pivot) ? (payload.pivot as number[]) : undefined;
      const pivot: Vector3 | undefined = pivotRaw
        ? [Number(pivotRaw[0]), Number(pivotRaw[1]), Number(pivotRaw[2])]
        : undefined;
      const atomIds = payload.atoms !== undefined
        ? [...new Set(resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms').atomIds)]
        : undefined;
      const candidate = prepareStructureTransform(entry.store.getSnapshot(), {
        type: 'rotate',
        axis,
        degrees,
        ...(pivot ? { pivot } : {}),
        ...(atomIds ? { atomIds } : {})
      });
      entry.store.execute({ type: 'apply-structure-transform', candidate });
    } else if (operation === 'center') {
      const mode = payload.centerMode === 'mass' ? 'mass' : 'geometry';
      const targetRaw = Array.isArray(payload.target) ? (payload.target as number[]) : undefined;
      const target: Vector3 | undefined = targetRaw
        ? [Number(targetRaw[0]), Number(targetRaw[1]), Number(targetRaw[2])]
        : undefined;
      const atomIds = payload.atoms !== undefined
        ? [...new Set(resolveOneBasedAtomIndices(structure, payload.atoms, 'atoms').atomIds)]
        : undefined;
      const candidate = prepareStructureTransform(entry.store.getSnapshot(), {
        type: 'center',
        mode,
        ...(target ? { target } : {}),
        ...(atomIds ? { atomIds } : {})
      });
      entry.store.execute({ type: 'apply-structure-transform', candidate });
    } else if (operation === 'supercell') {
      const rep = payload.repeat as number[];
      const repeat: Vector3 = [Number(rep[0]), Number(rep[1]), Number(rep[2])];
      const candidate = prepareStructureTransform(entry.store.getSnapshot(), {
        type: 'supercell',
        repeat
      });
      entry.store.execute({ type: 'apply-structure-transform', candidate });
    } else if (operation === 'vacuum') {
      const axisMap: Record<string, 0 | 1 | 2> = {
        '0': 0, a: 0, x: 0,
        '1': 1, b: 1, y: 1,
        '2': 2, c: 2, z: 2
      };
      const axis: 0 | 1 | 2 = axisMap[String(payload.axis ?? 2)] ?? 2;
      const vacuum = Number(payload.vacuumAngstrom);
      const center = payload.centerSlab !== false;
      const edit: StructureTransformEdit = {
        type: 'vacuum',
        axis,
        vacuum,
        center
      };
      const candidate = prepareStructureTransform(entry.store.getSnapshot(), edit);
      entry.store.execute({ type: 'apply-structure-transform', candidate });
    } else if (operation === 'wrap') {
      const candidate = prepareStructureTransform(entry.store.getSnapshot(), { type: 'wrap' });
      entry.store.execute({ type: 'apply-structure-transform', candidate });
    } else if (operation === 'undo') {
      const undone = registry.undo(entry.id);
      if (!undone) {
        throw Object.assign(
          new Error(`Nothing to undo for document "${entry.label}"`),
          { code: 'MCP_NOTHING_TO_UNDO' }
        );
      }
    } else if (operation === 'redo') {
      const redone = registry.redo(entry.id);
      if (!redone) {
        throw Object.assign(
          new Error(`Nothing to redo for document "${entry.label}"`),
          { code: 'MCP_NOTHING_TO_REDO' }
        );
      }
    } else {
      throw Object.assign(
        new Error(`Unsupported structure edit operation: ${operation}`),
        { code: 'INVALID_EDIT_OPERATION' }
      );
    }

    const updatedDoc = entry.store.getSnapshot();
    const nextStatus = currentStatusSnapshot(true);
    return {
      documentId: entry.id,
      label: entry.label,
      operation,
      previousRevision,
      revision: updatedDoc.revision,
      canUndo: registry.canUndo(entry.id),
      canRedo: registry.canRedo(entry.id),
      document: nextStatus.documents?.find(doc => doc.id === entry.id) ?? null,
      workbench: nextStatus
    };
  }

  async function handleSetConstraints(payload: Record<string, unknown>): Promise<unknown> {
    const hasRequestedScans = Array.isArray(payload.coordinates) && payload.coordinates.some(
      c => c !== null && typeof c === 'object' && !Array.isArray(c) && (c as { action?: unknown }).action === 'scan'
    );
    const { entry, modelDoc, structure } = resolveEditableTargetDocument(
      payload.documentId,
      'constraints',
      hasRequestedScans
    );
    const previousRevision = modelDoc.revision;

    const existingAtomIds = new Set(structure.atoms.map(a => a.id!));
    const rawShared = modelDoc.sharedConstraints;
    const rawFrozenBase = rawShared?.canonical
      ? rawShared.frozenAtomIds
      : (rawShared?.frozenAtomIds ?? modelDoc.draft.assignments.frozenAtomIds ?? []);
    let nextFrozenAtomIds = rawFrozenBase.filter(id => existingAtomIds.has(id));
    let shouldUpdateAtoms = !rawShared?.canonical && nextFrozenAtomIds.length > 0;

    if (payload.clearFrozenAtoms === true) {
      nextFrozenAtomIds = [];
      shouldUpdateAtoms = true;
    }

    const hasFrozenInput = Array.isArray(payload.frozenAtoms) || payload.freezeSelected === true;
    if (hasFrozenInput) {
      const inputIds: string[] = [];
      if (Array.isArray(payload.frozenAtoms)) {
        inputIds.push(...resolveOneBasedAtomIndices(structure, payload.frozenAtoms, 'frozenAtoms').atomIds);
      }
      if (payload.freezeSelected === true) {
        inputIds.push(...modelDoc.selection.atomIds.filter(id => existingAtomIds.has(id)));
      }
      const uniqueInputIds = [...new Set(inputIds)];
      const mode = payload.mode === 'append' || payload.mode === 'remove' ? payload.mode : 'replace';
      if (mode === 'replace') {
        nextFrozenAtomIds = uniqueInputIds;
      } else if (mode === 'append') {
        nextFrozenAtomIds = [...new Set([...nextFrozenAtomIds, ...uniqueInputIds])];
      } else {
        const removeSet = new Set(uniqueInputIds);
        nextFrozenAtomIds = nextFrozenAtomIds.filter(id => !removeSet.has(id));
      }
      shouldUpdateAtoms = true;
    }

    const exportedScope = entry.store.exportProjectState?.()?.contextScope;
    const activeScope: 'gaussian' | 'orca' = exportedScope === 'orca'
      ? 'orca'
      : exportedScope === 'gaussian'
        ? 'gaussian'
        : ((modelDoc.internalCoordinates ?? []).some(c => c.source === 'orca') ? 'orca' : 'gaussian');

    const existingFreezeCoords = (rawShared?.coordinates ?? []).filter(
      c => c.action === 'freeze' && c.atomIds.every(id => existingAtomIds.has(id))
    );
    const existingScanCoords = (modelDoc.internalCoordinates ?? []).filter(
      c => c.action === 'scan' && c.atomIds.every(id => existingAtomIds.has(id))
    );

    let nextFreezeCoords: ModelCoordinate[] = [...existingFreezeCoords];
    let nextScanCoords: ModelCoordinate[] = [...existingScanCoords];
    const objectsToUpsert: ModelCoordinateObject[] = [];
    let shouldUpdateCoordinates = false;
    const coordinateMode = payload.coordinateMode === 'append' ? 'append' : 'replace';
    const clearAllCoordinates =
      payload.clearCoordinates === true ||
      (Array.isArray(payload.coordinates) && coordinateMode === 'replace');

    if (payload.clearCoordinates === true) {
      nextFreezeCoords = [];
      nextScanCoords = [];
      shouldUpdateCoordinates = true;
    }

    if (Array.isArray(payload.coordinates)) {
      if (coordinateMode === 'replace') {
        nextFreezeCoords = [];
        nextScanCoords = [];
      }

      const existingObjects = modelDoc.coordinateObjects ?? [];
      for (const rawCoord of payload.coordinates) {
        if (!rawCoord || typeof rawCoord !== 'object' || Array.isArray(rawCoord)) continue;
        const spec = rawCoord as {
          type: 'B' | 'A' | 'D';
          atoms: number[];
          action: 'freeze' | 'scan';
          steps?: number;
          increment?: number;
          value?: number;
        };
        const expectedCount = spec.type === 'B' ? 2 : spec.type === 'A' ? 3 : 4;
        const { atomIds } = resolveOneBasedAtomIndices(structure, spec.atoms, `coordinates[${spec.type}].atoms`);
        if (atomIds.length !== expectedCount || new Set(atomIds).size !== expectedCount) {
          throw Object.assign(
            new Error(`Coordinate ${spec.type} requires ${expectedCount} distinct 1-based atom indices`),
            { code: 'INVALID_COORDINATE_CONSTRAINT' }
          );
        }

        const key = modelCoordinateKey({ type: spec.type, atomIds });

        if (spec.action === 'freeze') {
          const existingObj = existingObjects.find(obj => modelCoordinateKey(obj) === key)
            ?? objectsToUpsert.find(obj => modelCoordinateKey(obj) === key);
          const objectId = existingObj?.id ?? `mcp-coord:${key}`;
          if (!existingObj) {
            objectsToUpsert.push({
              id: objectId,
              type: spec.type,
              atomIds: [...atomIds]
            });
          }
          nextScanCoords = nextScanCoords.filter(row => modelCoordinateKey(row) !== key);
          nextFreezeCoords = nextFreezeCoords.filter(row => modelCoordinateKey(row) !== key);
          nextFreezeCoords.push({
            id: `shared-freeze:${objectId}`,
            objectId,
            type: spec.type,
            atomIds: [...atomIds],
            action: 'freeze',
            steps: 1,
            increment: null,
            ...(typeof spec.value === 'number' && Number.isFinite(spec.value)
              ? { value: spec.value, source: 'orca' as const }
              : {})
          });
        } else {
          const steps = Number(spec.steps);
          const increment = Number(spec.increment);
          nextFreezeCoords = nextFreezeCoords.filter(row => modelCoordinateKey(row) !== key);
          nextScanCoords = nextScanCoords.filter(row => modelCoordinateKey(row) !== key);
          if (activeScope === 'orca') {
            const start = Number(builderCoordinateValue(structure, spec.type, atomIds).toFixed(6));
            const end = Number((start + steps * increment).toFixed(6));
            const validOrcaEndpoint = (val: number) =>
              Number.isFinite(val) &&
              (spec.type === 'B' ? val > 0 : spec.type === 'A' ? val > 0 && val < 180 : true);
            if (!validOrcaEndpoint(start) || !validOrcaEndpoint(end) || start === end) {
              throw Object.assign(
                new Error(`ORCA scan range [${start}, ${end}] for ${spec.type} is physically invalid`),
                { code: 'INVALID_COORDINATE_CONSTRAINT' }
              );
            }
            nextScanCoords.push({
              id: `orca-constraints-${nextScanCoords.length}`,
              type: spec.type,
              atomIds: [...atomIds],
              action: 'scan',
              source: 'orca',
              start,
              end,
              steps: steps + 1,
              increment
            });
          } else {
            nextScanCoords.push({
              id: `mcp-scan:${key}`,
              type: spec.type,
              atomIds: [...atomIds],
              action: 'scan',
              steps,
              increment
            });
          }
        }
      }
      shouldUpdateCoordinates = true;
    }

    const hasActiveFreezeMutation =
      (hasFrozenInput && nextFrozenAtomIds.length > 0) ||
      (Array.isArray(payload.coordinates) && nextFreezeCoords.length > 0);
    const currentEnabled = rawShared?.enabled !== false;
    const nextEnabled = typeof payload.enabled === 'boolean'
      ? payload.enabled
      : (hasActiveFreezeMutation ? true : currentEnabled);

    try {
      effectiveModelConstraints({
        draft: {
          ...modelDoc.draft,
          assignments: {
            ...modelDoc.draft.assignments,
            frozenAtomIds: []
          }
        },
        internalCoordinates: nextScanCoords,
        sharedConstraints: {
          canonical: true,
          enabled: nextEnabled,
          frozenAtomIds: nextFrozenAtomIds,
          coordinates: nextFreezeCoords
        }
      });
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : String(error)),
        { code: 'MCP_CONSTRAINT_CONFLICT' }
      );
    }

    const commands: ModelCommand[] = [];
    if (nextEnabled === false && currentEnabled) {
      commands.push({
        type: 'set-shared-freezes-enabled',
        enabled: false
      });
    }
    if (shouldUpdateCoordinates) {
      if (clearAllCoordinates) {
        for (const boundRow of modelDoc.gaussianBoundCoordinates ?? []) {
          commands.push({
            type: 'delete-source-constraint',
            scope: 'gaussian',
            kind: 'coordinate',
            id: boundRow.rowId
          });
        }
        const inactiveScope: 'gaussian' | 'orca' = activeScope === 'gaussian' ? 'orca' : 'gaussian';
        const inactiveCoords = entry.store.getContext?.(inactiveScope)?.coordinates ?? [];
        for (const row of inactiveCoords) {
          if (row.id) {
            commands.push({
              type: 'delete-source-constraint',
              scope: inactiveScope,
              kind: 'coordinate',
              id: row.id
            });
          }
        }
      }
      if ((modelDoc.internalCoordinates ?? []).length > 0) {
        commands.push({ type: 'set-internal-coordinates', coordinates: [] });
      }
      if ((rawShared?.coordinates ?? []).length > 0) {
        commands.push({ type: 'replace-shared-coordinate-freezes', coordinates: [] });
      }
    }
    if (shouldUpdateAtoms) {
      commands.push({
        type: 'replace-shared-atom-freezes',
        atomIds: nextFrozenAtomIds
      });
    }
    for (const obj of objectsToUpsert) {
      commands.push({
        type: 'upsert-coordinate-object',
        object: obj
      });
    }
    if (shouldUpdateCoordinates) {
      commands.push({
        type: 'replace-shared-coordinate-freezes',
        coordinates: nextFreezeCoords
      });
      commands.push({
        type: 'set-internal-coordinates',
        coordinates: nextScanCoords
      });
    }
    if (nextEnabled === true && !currentEnabled) {
      commands.push({
        type: 'set-shared-freezes-enabled',
        enabled: true
      });
    }

    try {
      if (commands.length === 1) {
        entry.store.execute(commands[0]);
      } else if (commands.length > 1) {
        if (entry.store.executeBatch) {
          entry.store.executeBatch(commands, 'MCP constraints update');
        } else {
          for (const cmd of commands) entry.store.execute(cmd);
        }
      }
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : String(error)),
        { code: (error as { code?: string })?.code ?? 'MCP_CONSTRAINT_CONFLICT' }
      );
    }

    const updatedDoc = entry.store.getSnapshot();
    const updatedStructure = updatedDoc.draft.structure;
    const constraints = formatConstraintsSnapshot(updatedDoc, updatedStructure);
    const nextStatus = currentStatusSnapshot(true);

    return {
      documentId: entry.id,
      label: entry.label,
      previousRevision,
      revision: updatedDoc.revision,
      constraints,
      document: nextStatus.documents?.find(doc => doc.id === entry.id) ?? null,
      workbench: nextStatus
    };
  }

  async function handleRecommendMethod(payload: Record<string, unknown>): Promise<unknown> {
    const { entry, modelDoc, structure } = resolveTargetOrActiveDocument(payload.documentId);
    const engineRaw = typeof payload.engine === 'string' ? payload.engine : 'gaussian';
    if (engineRaw !== 'gaussian' && engineRaw !== 'orca' && engineRaw !== 'both') {
      throw Object.assign(
        new Error(`Unsupported engine "${engineRaw}" (expected "gaussian", "orca", or "both")`),
        { code: 'INVALID_ENGINE' }
      );
    }
    const task = typeof payload.task === 'string' && payload.task.trim()
      ? payload.task.trim()
      : 'optfreq';
    const solvent = typeof payload.solvent === 'string' ? payload.solvent.trim() : undefined;

    return recommendCalculationMethod({
      documentId: entry.id,
      label: entry.label,
      structure,
      electronicStateConfirmed: Boolean(entry.electronicStateConfirmed || modelDoc.electronicStateConfirmed),
      engine: engineRaw,
      task,
      solvent
    });
  }

  async function handleConfigureCalculation(payload: Record<string, unknown>): Promise<unknown> {
    const registry = options.getRegistry();
    const callbacks = options.getCallbacks?.();
    const engineRaw = typeof payload.engine === 'string' ? payload.engine : '';
    if (engineRaw !== 'gaussian' && engineRaw !== 'orca') {
      throw Object.assign(
        new Error(`Unsupported engine "${engineRaw}" (expected "gaussian" or "orca")`),
        { code: 'INVALID_ENGINE' }
      );
    }
    const patch = payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)
      ? (payload.settings as Record<string, unknown>)
      : {};
    const switchToInputView = payload.switchToInputView !== false;
    const generateOutput = payload.generateOutput !== false;

    const { entry, modelDoc } = resolveEditableTargetDocument(payload.documentId, 'selection');
    callbacks?.assertCalculationConfigurable?.(entry.id);

    const snapBefore = registry.getSnapshot();
    const sources = snapBefore.documents
      .filter(doc => !doc.result && !isConformerWorkspaceResult(doc))
      .flatMap(doc => {
        try {
          return [registry.source(doc.id)];
        } catch {
          return [];
        }
      });

    const configured = buildConfiguredCalculation({
      documentId: entry.id,
      label: entry.label,
      store: entry.store,
      existingDrafts: entry.drafts,
      sources,
      engine: engineRaw,
      patch,
      generateOutput,
      isAnalysisBound: Boolean(modelDoc.analysisBindingId)
    });

    if (switchToInputView) {
      setTaskCenterOpenSync(false);
      const liveCallbacks = options.getCallbacks?.();
      if (liveCallbacks?.switchToConfiguredInputView) {
        liveCallbacks.switchToConfiguredInputView(entry.id);
      } else {
        if (liveCallbacks?.activateDocument) {
          liveCallbacks.activateDocument(entry.id);
        } else {
          const view = registry.getSnapshot().views.find(v => v.documentId === entry.id);
          if (view) registry.activate(view.id);
        }
        const postActivateCallbacks = options.getCallbacks?.();
        if (postActivateCallbacks?.navigateModule) {
          postActivateCallbacks.navigateModule('input');
        } else {
          registry.setModule('input');
        }
      }
    }

    if (configured.gaussianDraft) {
      registry.setDraft(
        entry.id,
        'gaussian',
        JSON.parse(JSON.stringify(configured.gaussianDraft)),
        true
      );
    }
    if (configured.orcaDraft) {
      registry.setDraft(
        entry.id,
        'orca',
        JSON.parse(JSON.stringify(configured.orcaDraft)),
        true
      );
    }

    options.getCallbacks?.()?.applyCalculationConfig?.(entry.id, configured);

    const nextStatus = currentStatusSnapshot(true);
    return {
      documentId: entry.id,
      label: entry.label,
      switchedToInputView: switchToInputView,
      ...configured.response,
      document: nextStatus.documents?.find(doc => doc.id === entry.id) ?? null,
      workbench: nextStatus
    };
  }

  function resolveTaskBridge(): TaskSystemBridge {
    const callbacks = options.getCallbacks?.();
    const explicit = callbacks?.getTaskSystemBridge?.();
    if (explicit) return explicit;
    const desktop = options.getDesktop?.() as unknown as Partial<NativeTaskSystemPort> | undefined;
    if (
      desktop &&
      typeof desktop.taskSystemRequest === 'function' &&
      typeof desktop.cancelTaskSystemRequest === 'function'
    ) {
      return createTaskSystemBridge(desktop as NativeTaskSystemPort);
    }
    return createTaskSystemBridge();
  }

  async function handleRunLocalXtb(payload: Record<string, unknown>) {
    const calcRaw = typeof payload.calculation === 'string' ? payload.calculation.trim() : '';
    if (!['singlepoint', 'optimize', 'conformer-search'].includes(calcRaw)) {
      throw Object.assign(
        new Error('calculation must be "singlepoint", "optimize", or "conformer-search"'),
        { code: 'INVALID_XTB_CALCULATION' }
      );
    }
    const calculation = calcRaw as LocalXtbCalculation;

    const methodRaw = typeof payload.method === 'string' ? payload.method.trim() : 'gfn2';
    if (!['gfn2', 'gfn1', 'gfn0', 'gfnff'].includes(methodRaw)) {
      throw Object.assign(
        new Error('method must be "gfn2", "gfn1", "gfn0", or "gfnff"'),
        { code: 'INVALID_XTB_METHOD' }
      );
    }
    const method = methodRaw as XtbMethod;
    if (calculation === 'singlepoint' && method !== 'gfn2') {
      throw Object.assign(
        new Error('calculation "singlepoint" only supports method "gfn2"'),
        { code: 'INVALID_XTB_METHOD' }
      );
    }

    const maxSteps = payload.maxSteps === undefined ? 500 : Number(payload.maxSteps);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 5000) {
      throw Object.assign(
        new Error('maxSteps must be an integer between 1 and 5000'),
        { code: 'INVALID_XTB_MAX_STEPS' }
      );
    }

    const maxCandidates = payload.maxCandidates === undefined ? 24 : Number(payload.maxCandidates);
    if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 500) {
      throw Object.assign(
        new Error('maxCandidates must be an integer between 1 and 500'),
        { code: 'INVALID_XTB_MAX_CANDIDATES' }
      );
    }

    const pointsPerTorsion = payload.pointsPerTorsion === undefined ? 3 : Number(payload.pointsPerTorsion);
    if (!Number.isInteger(pointsPerTorsion) || pointsPerTorsion < 2 || pointsPerTorsion > 12) {
      throw Object.assign(
        new Error('pointsPerTorsion must be an integer between 2 and 12'),
        { code: 'INVALID_XTB_POINTS_PER_TORSION' }
      );
    }

    const timeoutSeconds = payload.timeoutSeconds === undefined ? 300 : Number(payload.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
      throw Object.assign(
        new Error('timeoutSeconds must be a positive number up to 600'),
        { code: 'INVALID_XTB_TIMEOUT' }
      );
    }

    const solvationModelRaw = payload.solvationModel === undefined
      ? undefined
      : String(payload.solvationModel).trim();
    if (solvationModelRaw !== undefined && solvationModelRaw !== 'alpb' && solvationModelRaw !== 'gbsa') {
      throw Object.assign(
        new Error('solvationModel must be "alpb" or "gbsa"'),
        { code: 'INVALID_XTB_SOLVATION' }
      );
    }

    const { entry, modelDoc } = resolveEditableTargetDocument(
      payload.documentId,
      calculation === 'conformer-search' ? 'selection' : 'edit'
    );
    options.getCallbacks?.()?.assertCalculationConfigurable?.(entry.id);

    const structure = modelDoc.draft.structure;
    if (!structure.atoms.length || structure.dimension !== 3 || structure.periodicSource?.completeness === 'partial') {
      throw Object.assign(
        new Error('xTB 计算要求非空三维原子结构（周期体系需具备完整晶胞）。'),
        { code: 'MCP_INVALID_XTB_STRUCTURE' }
      );
    }

    const solvation = resolveXtbSolvation({
      calculation,
      method,
      solvent: typeof payload.solvent === 'string' ? payload.solvent : undefined,
      solvationModel: solvationModelRaw,
      isPeriodic: Boolean(structure.cell)
    });

    if (calculation === 'conformer-search') {
      setTaskCenterOpenSync(false);
      const liveCallbacks = options.getCallbacks?.();
      const outcome = liveCallbacks?.runConformerSearch
        ? await liveCallbacks.runConformerSearch(entry.id, {
            method,
            solvation,
            maxSteps,
            maxCandidates,
            pointsPerTorsion,
            timeoutSeconds
          })
        : await executeMcpConformerSearch(
            {
              entry,
              bridge: (options.getDesktop?.() as unknown as Partial<XtbBridge> | undefined) ?? null
            },
            {
              method,
              solvation,
              maxSteps,
              maxCandidates,
              pointsPerTorsion,
              timeoutSeconds
            }
          );
      const nextStatus = currentStatusSnapshot(true);
      const resultDocId = typeof outcome.documentId === 'string' ? outcome.documentId : entry.id;
      return {
        ...outcome,
        document: nextStatus.documents?.find(doc => doc.id === resultDocId) ?? null,
        workbench: nextStatus
      };
    }

    const electronic = resolveValidatedElectronicState(modelDoc);
    const constraints = effectiveModelConstraints(modelDoc);
    if (structure.cell && calculation === 'optimize' && constraints.coordinates.length > 0) {
      throw Object.assign(
        new Error('周期性体系的 xTB 优化暂不支持内坐标冻结约束；原子坐标冻结仍受支持。'),
        { code: 'MCP_XTB_CONSTRAINT_UNSUPPORTED' }
      );
    }
    if (calculation === 'optimize' && constraints.coordinates.some(row => row.action !== 'freeze')) {
      throw Object.assign(
        new Error('本机 xTB 预优化不执行内坐标柔性扫描（scan），请改为 freeze 或提交至 Gaussian / ORCA。'),
        { code: 'MCP_XTB_SCAN_UNSUPPORTED' }
      );
    }

    setTaskCenterOpenSync(false);
    const registry = options.getRegistry();
    const liveCallbacks = options.getCallbacks?.();
    if (liveCallbacks?.activateDocument) {
      liveCallbacks.activateDocument(entry.id);
    } else {
      const view = registry.getSnapshot().views.find(v => v.documentId === entry.id);
      if (view) registry.activate(view.id);
    }
    const postActivateCallbacks = options.getCallbacks?.();
    if (postActivateCallbacks?.navigateModule) {
      postActivateCallbacks.navigateModule('modeling');
    } else {
      registry.setModule('modeling');
    }

    const rebuildBonds = typeof payload.rebuildBonds === 'boolean'
      ? payload.rebuildBonds
      : !structure.cell && method !== 'gfnff';

    const xtbOptions: XtbOptions = {
      method,
      charge: electronic.charge,
      multiplicity: electronic.multiplicity,
      rebuildBonds,
      ...(solvation ? { solvation } : {}),
      maxSteps,
      maxWallTimeSeconds: Math.max(1, Math.ceil(timeoutSeconds))
    };

    const runCallbacks = options.getCallbacks?.();
    const xtbState = runCallbacks?.runLocalXtb
      ? await runCallbacks.runLocalXtb(entry.id, {
          calculation,
          xtbOptions,
          timeoutSeconds
        })
      : await runStandaloneXtbCalculation({
          store: entry.store,
          bridge: (options.getDesktop?.() as unknown as Partial<XtbBridge> | undefined) ?? null,
          calculation,
          xtbOptions,
          timeoutSeconds
        });

    const formatted = formatXtbSinglepointOrOptimizeOutcome(
      entry.id,
      entry.store.getSnapshot(),
      calculation,
      method,
      xtbState
    );
    const nextStatus = currentStatusSnapshot(true);
    return {
      ...formatted,
      document: nextStatus.documents?.find(doc => doc.id === entry.id) ?? null,
      workbench: nextStatus
    };
  }

  async function handleSubmitTask(payload: Record<string, unknown>) {
    const modeRaw = payload.mode === undefined ? 'open-dialog' : String(payload.mode).trim();
    if (modeRaw !== 'open-dialog' && modeRaw !== 'auto-submit') {
      throw Object.assign(
        new Error('mode must be "open-dialog" or "auto-submit"'),
        { code: 'INVALID_SUBMIT_MODE' }
      );
    }
    const mode = modeRaw as SubmitTaskMode;

    const engineRaw = payload.engine === undefined ? undefined : String(payload.engine).trim();
    if (engineRaw !== undefined && engineRaw !== 'gaussian' && engineRaw !== 'orca') {
      throw Object.assign(
        new Error('engine must be "gaussian" or "orca"'),
        { code: 'INVALID_CALCULATION_ENGINE' }
      );
    }

    const environmentId = typeof payload.environmentId === 'string' && payload.environmentId.trim()
      ? payload.environmentId.trim()
      : undefined;
    const taskName = typeof payload.taskName === 'string' && payload.taskName.trim()
      ? payload.taskName.trim()
      : undefined;
    if (taskName && (taskName.length > 128 || /[\r\n\0]/.test(taskName))) {
      throw Object.assign(
        new Error('taskName must be a single-line string up to 128 characters'),
        { code: 'INVALID_TASK_NAME' }
      );
    }

    let cores: number | undefined;
    if (payload.cores !== undefined) {
      const c = Number(payload.cores);
      if (!Number.isInteger(c) || c < 1 || c > 1024) {
        throw Object.assign(
          new Error('cores must be an integer between 1 and 1024'),
          { code: 'INVALID_SUBMIT_CORES' }
        );
      }
      cores = c;
    }

    let memoryGB: number | undefined;
    if (payload.memoryGB !== undefined) {
      const m = Number(payload.memoryGB);
      if (!Number.isFinite(m) || m <= 0 || m > 16384) {
        throw Object.assign(
          new Error('memoryGB must be a positive finite number up to 16384'),
          { code: 'INVALID_SUBMIT_MEMORY' }
        );
      }
      memoryGB = m;
    }

    const { entry } = resolveEditableTargetDocument(payload.documentId, 'selection');
    const registry = options.getRegistry();
    const liveCallbacks = options.getCallbacks?.();
    liveCallbacks?.assertCalculationConfigurable?.(entry.id);

    const sources = registry
      .getSnapshot()
      .documents.filter(doc => !doc.result && !isConformerWorkspaceResult(doc))
      .flatMap(doc => {
        try {
          return [registry.source(doc.id)];
        } catch {
          return [];
        }
      });

    const liveDraft = liveCallbacks?.captureLiveSubmissionDraft?.(entry.id, engineRaw);
    const baseDraft = liveDraft ?? buildExternalDraftFromSavedEntry(entry, engineRaw, sources).draft;
    const patchedDraft = applySubmissionDraftOverrides(baseDraft, {
      taskName,
      cores,
      memoryGB
    });

    if (mode === 'open-dialog') {
      setTaskCenterOpenSync(false);
      const dialogCallbacks = options.getCallbacks?.();
      if (!dialogCallbacks?.openTaskSubmissionDialog) {
        throw Object.assign(
          new Error('当前界面未挂载交互式任务提交对话框入口，可使用 mode="auto-submit" 直接提交。'),
          { code: 'MCP_SUBMIT_DIALOG_UNAVAILABLE' }
        );
      }
      await dialogCallbacks.openTaskSubmissionDialog(entry.id, patchedDraft, {
        environmentId,
        displayName: taskName
      });
      const nextStatus = currentStatusSnapshot(true);
      return {
        submitted: false,
        mode: 'open-dialog' as const,
        status: 'dialog-opened',
        taskId: null,
        documentId: entry.id,
        engine: patchedDraft.engineId,
        inputName: patchedDraft.inputName,
        displayName: patchedDraft.suggestedName,
        ...(environmentId ? { environmentId } : {}),
        workbench: nextStatus
      };
    }

    const bridge = resolveTaskBridge();
    const submitted = await executeAutoSubmitToTaskCenter({
      bridge,
      draft: patchedDraft,
      projectId: liveCallbacks?.getProjectId?.() ?? null,
      environmentId,
      taskName,
      onSubmittedOpenTask: taskId => {
        setTaskCenterOpenSync(true);
        options.getCallbacks?.()?.openSubmittedTaskInCenter?.(taskId);
      }
    });

    const nextStatus = currentStatusSnapshot(true);
    return {
      documentId: entry.id,
      ...submitted,
      workbench: nextStatus
    };
  }

  async function handleTaskManage(payload: Record<string, unknown>) {
    const actionRaw = typeof payload.action === 'string' ? payload.action.trim() : '';
    if (!['list-tasks', 'task-detail', 'read-log', 'stop-task', 'list-environments'].includes(actionRaw)) {
      throw Object.assign(
        new Error('action must be one of: list-environments, list-tasks, task-detail, read-log, stop-task'),
        { code: 'INVALID_TASK_MANAGE_ACTION' }
      );
    }
    const action = actionRaw as TaskManageAction;
    const requiresTaskId = ['task-detail', 'read-log', 'stop-task'].includes(action);
    const taskId = typeof payload.taskId === 'string' && payload.taskId.trim()
      ? payload.taskId.trim()
      : undefined;
    if (requiresTaskId && !taskId) {
      throw Object.assign(
        new Error(`taskId is required when action is "${action}"`),
        { code: 'MISSING_TASK_ID' }
      );
    }

    let tailLines: number | undefined;
    if (payload.tailLines !== undefined) {
      const t = Number(payload.tailLines);
      if (!Number.isInteger(t) || t < 1 || t > 500) {
        throw Object.assign(
          new Error('tailLines must be an integer between 1 and 500'),
          { code: 'INVALID_TAIL_LINES' }
        );
      }
      tailLines = t;
    }

    const categoryRaw = payload.category === undefined ? undefined : String(payload.category).trim();
    if (
      categoryRaw !== undefined &&
      !['all', 'active', 'unverified', 'completed', 'failed', 'archived', 'recycle', 'ungrouped'].includes(categoryRaw)
    ) {
      throw Object.assign(
        new Error('Invalid task category filter'),
        { code: 'INVALID_TASK_CATEGORY' }
      );
    }

    const artifactId = typeof payload.artifactId === 'string' && payload.artifactId.trim()
      ? payload.artifactId.trim()
      : undefined;

    const bridge = resolveTaskBridge();
    const outcome = await executeTaskManageAction({
      bridge,
      params: {
        action,
        taskId,
        tailLines,
        category: categoryRaw as TaskCategory | undefined,
        artifactId
      },
      taskCenterOpen: resolveEffectiveTaskCenterOpen(),
      trackOperation: options.getCallbacks?.()?.trackTaskOperation
    });

    return {
      ...outcome,
      workbench: currentStatusSnapshot(false)
    };
  }

  function buildScientificSourceFileFromPayload(
    sourcePayload: Record<string, unknown>,
    defaultName = 'result.log'
  ): ScientificSourceFile {
    const desktop = options.getDesktop?.();
    const fileName =
      typeof sourcePayload.name === 'string' && sourcePayload.name.trim()
        ? sourcePayload.name.trim()
        : typeof sourcePayload.filePath === 'string' && sourcePayload.filePath.trim()
          ? sourcePayload.filePath.trim().split(/[\\/]/).pop() || defaultName
          : defaultName;
    const launchBridge = desktop as (DesktopBridge & Partial<LaunchImportBridge>) | undefined;
    if (
      isLaunchSourceDescriptor(sourcePayload.sourceDescriptor) &&
      typeof launchBridge?.readLaunchSource === 'function' &&
      typeof launchBridge?.closeLaunchSource === 'function'
    ) {
      return launchSourceFile(sourcePayload.sourceDescriptor, launchBridge as DesktopBridge & LaunchImportBridge);
    }
    if (typeof sourcePayload.text === 'string') {
      return createInMemoryScientificSourceFile(fileName, sourcePayload.text);
    }
    throw Object.assign(
      new Error(`Unable to read analysis file "${fileName}": no launch token or text payload available`),
      { code: 'MCP_FILE_SOURCE_UNAVAILABLE' }
    );
  }

  async function closeStandaloneNativeSession(sessionId: string): Promise<void> {
    const desktop = options.getDesktop?.();
    if (desktop?.closeOrbitalSession) {
      await desktop.closeOrbitalSession(sessionId).catch(() => {});
      return;
    }
    if (desktop?.commandOrbitals) {
      await desktop.commandOrbitals(sessionId, { operation: 'close' }).catch(() => {});
    }
  }

  async function disposeStandaloneFileDocResources(fileDoc: PostprocessScientificFileDocument): Promise<void> {
    await disposePostprocessAttachments(
      [fileDoc.wavefunction, ...(fileDoc.companions ?? [])],
      closeStandaloneNativeSession
    ).catch(() => {});
    await Promise.resolve(fileDoc.output.source.dispose()).catch(() => {});
    for (const extra of fileDoc.extraSources ?? []) {
      await Promise.resolve(extra.dispose()).catch(() => {});
    }
    if (
      fileDoc.displayResult &&
      !fileDoc.output.source.jobs.includes(fileDoc.displayResult) &&
      !(fileDoc.companions ?? []).some(item => item.source.result === fileDoc.displayResult)
    ) {
      await Promise.resolve(fileDoc.displayResult.dispose()).catch(() => {});
    }
  }

  async function disposeStandaloneAnalysisDoc(docId: string): Promise<void> {
    const fileDoc = standaloneFileDocs.get(docId);
    const postDoc = standalonePostprocessDocs.get(docId);
    standalonePostprocessDocs.delete(docId);
    standaloneFileDocs.delete(docId);
    standaloneActivePanels.delete(docId);
    standaloneFrameIndices.delete(docId);
    analysisTableStore.clear(docId);
    if (standaloneLastFileDocId === docId) {
      standaloneLastFileDocId = null;
    }
    if (fileDoc) {
      await disposeStandaloneFileDocResources(fileDoc);
    } else if (postDoc) {
      await disposePostprocessAttachments(
        [postDoc.output, postDoc.wavefunction, ...(postDoc.companions ?? [])],
        closeStandaloneNativeSession
      ).catch(() => {});
    }
  }

  async function standaloneOpenFileInAnalysis(
    sourceFile: ScientificSourceFile,
    targetDocumentId?: string,
    customLabel?: string,
    requestedFrameIndex?: number
  ): Promise<{ documentId: string }> {
    const registry = options.getRegistry();
    const desktop = options.getDesktop?.();
    const input = resultFile(sourceFile);
    let nativeSessionId: string | undefined;
    let adopted = false;

    const assertValidStandaloneFrame = (availableFrames: number, docId: string) => {
      if (requestedFrameIndex !== undefined && availableFrames > 0 && requestedFrameIndex >= availableFrames) {
        throw Object.assign(
          new Error(
            `frameIndex ${requestedFrameIndex} is out of range (document "${docId}" has ${availableFrames} frame(s), valid indices: 0..${availableFrames - 1})`
          ),
          { code: 'INVALID_FRAME_INDEX' }
        );
      }
    };

    try {
      const baseDoc = targetDocumentId ? standalonePostprocessDocs.get(targetDocumentId) : undefined;
      const baseFileDoc = targetDocumentId ? standaloneFileDocs.get(targetDocumentId) : undefined;
      if (targetDocumentId && !baseDoc && !baseFileDoc) {
        if (registry.getSnapshot().documents.some(d => d.id === targetDocumentId)) {
          throw Object.assign(
            new Error(`Target document "${targetDocumentId}" does not contain an active Result Analysis output to pair onto.`),
            { code: 'MCP_ANALYSIS_UNAVAILABLE' }
          );
        }
        throw Object.assign(new Error(`Document not found: ${targetDocumentId}`), {
          code: 'MCP_DOCUMENT_NOT_FOUND'
        });
      }

      const identity = await identifyPostprocessSource(input);

      if (identity.kind === 'gaussian-output' || identity.kind === 'orca-output') {
        const source = await readPostprocessFileOutput(input);
        if (isScientificFileSource(source)) {
          const retained = retainPostprocessFileSourceBytes({ source }, input);
          const prepared = baseFileDoc || baseDoc
            ? await preparePostprocessFileIncoming([retained], baseFileDoc ?? baseDoc, () => {})
            : undefined;
          const composed = composePostprocessFileDocument(
            baseFileDoc?.id ?? baseDoc?.id ?? `analysis-file-${crypto.randomUUID()}`,
            prepared?.output ?? retained,
            prepared?.wavefunction,
            prepared
          );
          if (isScientificFileDocument(composed)) {
            const displayDoc = postprocessFileDisplayDocument(composed);
            assertValidStandaloneFrame(
              displayDoc?.result.frames.length ?? 0,
              targetDocumentId ?? composed.id
            );
            if (displayDoc) {
              const initStructure = await readInitialPostprocessStructure(displayDoc);
              if (targetDocumentId && registry.getSnapshot().documents.some(d => d.id === targetDocumentId)) {
                adopted = true;
                registry.replaceAnalysisDocument(
                  targetDocumentId,
                  displayDoc.result,
                  initStructure,
                  displayDoc.id
                );
                if (customLabel) registry.rename(targetDocumentId, customLabel);
                standalonePostprocessDocs.set(targetDocumentId, displayDoc);
                standaloneFileDocs.set(targetDocumentId, composed);
                registry.setModule('analysis');
                if (baseFileDoc) {
                  await Promise.resolve(baseFileDoc.output.source.dispose()).catch(() => {});
                } else if (baseDoc?.output) {
                  await disposePostprocessAttachments([baseDoc.output], closeStandaloneNativeSession).catch(() => {});
                }
                return { documentId: targetDocumentId };
              }
              adopted = true;
              const entry = registry.addAnalysisDocument(
                displayDoc.result,
                initStructure,
                displayDoc.id,
                true,
                'analysis'
              );
              if (customLabel) registry.rename(entry.id, customLabel);
              standalonePostprocessDocs.set(entry.id, displayDoc);
              standaloneFileDocs.set(entry.id, composed);
              standaloneLastFileDocId = null;
              registry.setModule('analysis');
              return { documentId: entry.id };
            }
            const docKey = targetDocumentId ?? composed.id;
            adopted = true;
            standaloneFileDocs.set(docKey, composed);
            standaloneLastFileDocId = docKey;
            registry.setModule('analysis');
            if (baseFileDoc) {
              await Promise.resolve(baseFileDoc.output.source.dispose()).catch(() => {});
            }
            return { documentId: docKey };
          }
          assertValidStandaloneFrame(composed.result.frames.length, targetDocumentId ?? composed.id);
          const initStructure = await readInitialPostprocessStructure(composed);
          adopted = true;
          const entry = registry.addAnalysisDocument(
            composed.result,
            initStructure,
            composed.id,
            true,
            'analysis'
          );
          if (customLabel) registry.rename(entry.id, customLabel);
          standalonePostprocessDocs.set(entry.id, composed);
          standaloneLastFileDocId = null;
          registry.setModule('analysis');
          return { documentId: entry.id };
        }

        const outAttachment = retainPostprocessOutputSourceText({ source }, input);
        let pair;
        if (baseDoc?.wavefunction) {
          try {
            pair = await pairPostprocessSourcesForFrames(outAttachment.source, baseDoc.wavefunction.source);
          } catch (err) {
            throw Object.assign(
              new Error(err instanceof Error ? err.message : String(err)),
              { code: 'MCP_WAVEFUNCTION_UNPAIRED' }
            );
          }
          const conflict = postprocessMetadataConflict(pair);
          if (conflict || pair.conflicts.length) {
            throw Object.assign(
              new Error(conflict ?? 'New output conflicts with attached wavefunction electronic state'),
              { code: 'MCP_WAVEFUNCTION_UNPAIRED' }
            );
          }
        }
        const composed = composePostprocessDocument(
          baseDoc?.id ?? `analysis-${crypto.randomUUID()}`,
          outAttachment,
          baseDoc?.wavefunction,
          pair,
          { companions: baseDoc?.companions }
        );
        assertValidStandaloneFrame(composed.result.frames.length, targetDocumentId ?? composed.id);
        const initStructure = await readInitialPostprocessStructure(composed);
        adopted = true;
        if (targetDocumentId && baseDoc && registry.getSnapshot().documents.some(d => d.id === targetDocumentId)) {
          registry.replaceAnalysisDocument(
            targetDocumentId,
            composed.result,
            initStructure,
            composed.id
          );
          if (customLabel) registry.rename(targetDocumentId, customLabel);
          standalonePostprocessDocs.set(targetDocumentId, composed);
          registry.setModule('analysis');
          if (baseDoc.output) {
            await disposePostprocessAttachments([baseDoc.output], closeStandaloneNativeSession).catch(() => {});
          }
          return { documentId: targetDocumentId };
        }
        const entry = registry.addAnalysisDocument(
          composed.result,
          initStructure,
          composed.id,
          true,
          'analysis'
        );
        if (customLabel) registry.rename(entry.id, customLabel);
        standalonePostprocessDocs.set(entry.id, composed);
        standaloneLastFileDocId = null;
        registry.setModule('analysis');
        return { documentId: entry.id };
      }

      if (identity.kind === 'fchk' || identity.kind === 'molden') {
        if (!desktop?.openOrbitalSession) {
          throw Object.assign(
            new Error('Desktop bridge does not provide openOrbitalSession for .fchk/.molden wavefunction parsing'),
            { code: 'MCP_WAVEFUNCTION_BACKEND_MISSING' }
          );
        }
        nativeSessionId = `orbital-${crypto.randomUUID()}`;
        const sourceToken = await input.readCompanionSourceToken?.();
        const rawText = sourceToken ? undefined : await sourceFile.text();
        const metadata = await desktop.openOrbitalSession({
          sessionId: nativeSessionId,
          sourceId: input.id,
          name: sourceFile.name,
          ...(sourceToken ? { sourceToken } : { text: rawText })
        });
        const wfSource = await readPostprocessWavefunction(input, metadata);
        const wfAttachment: PostprocessAttachment = sourceToken
          ? await retainPostprocessManagedSource({ source: wfSource, nativeSessionId }, input)
          : await retainPostprocessSourceText({ source: wfSource, nativeSessionId }, rawText!, input);

        if (targetDocumentId) {
          if (baseFileDoc) {
            const prepared = await preparePostprocessFileIncoming([wfAttachment], baseFileDoc, () => {});
            if (!prepared.wavefunction || prepared.sourceWarnings.length > 0) {
              throw Object.assign(
                new Error(
                  prepared.sourceWarnings.map(w => w.message).join('；') ||
                    'Wavefunction could not be paired reliably onto the target file document'
                ),
                { code: 'MCP_WAVEFUNCTION_UNPAIRED' }
              );
            }
            const nextFileDoc = composePostprocessFileDocument(
              baseFileDoc.id,
              prepared.output ?? baseFileDoc.output,
              prepared.wavefunction,
              prepared
            ) as PostprocessScientificFileDocument;
            const displayDoc = postprocessFileDisplayDocument(nextFileDoc);
            assertValidStandaloneFrame(displayDoc?.result.frames.length ?? 0, targetDocumentId);
            const initStructure = displayDoc ? await readInitialPostprocessStructure(displayDoc) : null;
            adopted = true;
            standaloneFileDocs.set(targetDocumentId, nextFileDoc);
            if (displayDoc && initStructure && registry.getSnapshot().documents.some(d => d.id === targetDocumentId)) {
              registry.replaceAnalysisDocument(targetDocumentId, displayDoc.result, initStructure, displayDoc.id);
              standalonePostprocessDocs.set(targetDocumentId, displayDoc);
            }
            if (customLabel && registry.getSnapshot().documents.some(d => d.id === targetDocumentId)) {
              registry.rename(targetDocumentId, customLabel);
            }
            registry.setModule('analysis');
            if (baseFileDoc.wavefunction && baseFileDoc.wavefunction.source !== nextFileDoc.wavefunction?.source) {
              await disposePostprocessAttachments([baseFileDoc.wavefunction], closeStandaloneNativeSession).catch(() => {});
            }
            return { documentId: targetDocumentId };
          }

          if (!baseDoc?.output) {
            throw Object.assign(
              new Error(`Target document "${targetDocumentId}" lacks a calculation output file to pair wavefunction "${sourceFile.name}" onto`),
              { code: 'MCP_FILE_IMPORT_FAILED' }
            );
          }
          let pair;
          try {
            pair = await pairPostprocessSourcesForFrames(baseDoc.output.source, wfAttachment.source);
          } catch (err) {
            throw Object.assign(
              new Error(err instanceof Error ? err.message : String(err)),
              { code: 'MCP_WAVEFUNCTION_UNPAIRED' }
            );
          }
          const conflict = postprocessMetadataConflict(pair);
          if (conflict || pair.conflicts.length || pair.frameIndex === undefined) {
            throw Object.assign(
              new Error(conflict ?? 'Wavefunction geometry or electronic state conflicts with target output document'),
              { code: 'MCP_WAVEFUNCTION_UNPAIRED' }
            );
          }
          const displayedResult = await defaultPostprocessCompanion(baseDoc.output, baseDoc.companions ?? []);
          const composed = composePostprocessDocument(baseDoc.id, baseDoc.output, wfAttachment, pair, {
            companions: baseDoc.companions,
            displayedResult
          });
          assertValidStandaloneFrame(composed.result.frames.length, targetDocumentId);
          const initStructure = await readInitialPostprocessStructure(composed);
          adopted = true;
          registry.replaceAnalysisDocument(
            targetDocumentId,
            composed.result,
            initStructure,
            composed.id
          );
          if (customLabel) registry.rename(targetDocumentId, customLabel);
          standalonePostprocessDocs.set(targetDocumentId, composed);
          registry.setModule('analysis');
          if (baseDoc.wavefunction) {
            await disposePostprocessAttachments([baseDoc.wavefunction], closeStandaloneNativeSession).catch(() => {});
          }
          return { documentId: targetDocumentId };
        }

        const composed = composePostprocessDocument(
          `analysis-${crypto.randomUUID()}`,
          undefined,
          wfAttachment
        );
        assertValidStandaloneFrame(composed.result.frames.length, composed.id);
        const initStructure = await readInitialPostprocessStructure(composed);
        adopted = true;
        const entry = registry.addAnalysisDocument(
          composed.result,
          initStructure,
          composed.id,
          true,
          'analysis'
        );
        if (customLabel) registry.rename(entry.id, customLabel);
        standalonePostprocessDocs.set(entry.id, composed);
        standaloneLastFileDocId = null;
        registry.setModule('analysis');
        return { documentId: entry.id };
      }

      if (identity.kind === 'xyz' || identity.kind === 'hess') {
        const auxSource = await readPostprocessAuxiliary(input);
        const auxAttachment = retainPostprocessSourceBytes({ source: auxSource }, input);

        if (targetDocumentId) {
          if (baseFileDoc) {
            const prepared = await preparePostprocessFileIncoming([auxAttachment], baseFileDoc, () => {});
            if (prepared.sourceWarnings.length > 0 || !prepared.companions.length) {
              throw Object.assign(
                new Error(
                  prepared.sourceWarnings.map(w => w.message).join('；') ||
                    `Companion file "${sourceFile.name}" could not be paired onto document "${targetDocumentId}"`
                ),
                { code: 'MCP_FILE_IMPORT_FAILED' }
              );
            }
            const nextFileDoc = composePostprocessFileDocument(
              baseFileDoc.id,
              prepared.output ?? baseFileDoc.output,
              prepared.wavefunction,
              prepared
            ) as PostprocessScientificFileDocument;
            const displayDoc = postprocessFileDisplayDocument(nextFileDoc);
            assertValidStandaloneFrame(displayDoc?.result.frames.length ?? 0, targetDocumentId);
            const initStructure = displayDoc ? await readInitialPostprocessStructure(displayDoc) : null;
            adopted = true;
            standaloneFileDocs.set(targetDocumentId, nextFileDoc);
            if (displayDoc && initStructure && registry.getSnapshot().documents.some(d => d.id === targetDocumentId)) {
              registry.replaceAnalysisDocument(targetDocumentId, displayDoc.result, initStructure, displayDoc.id);
              standalonePostprocessDocs.set(targetDocumentId, displayDoc);
            }
            if (customLabel && registry.getSnapshot().documents.some(d => d.id === targetDocumentId)) {
              registry.rename(targetDocumentId, customLabel);
            }
            registry.setModule('analysis');
            const retainedCompanions = new Set((nextFileDoc.companions ?? []).map(c => c.source));
            const superseded = (baseFileDoc.companions ?? []).filter(c => !retainedCompanions.has(c.source));
            if (superseded.length) {
              await disposePostprocessAttachments(superseded, closeStandaloneNativeSession).catch(() => {});
            }
            return { documentId: targetDocumentId };
          }

          if (!baseDoc?.output) {
            throw Object.assign(
              new Error(`Target document "${targetDocumentId}" lacks a calculation output file to pair companion "${sourceFile.name}" onto`),
              { code: 'MCP_FILE_IMPORT_FAILED' }
            );
          }
          const { enrichedOutput, companions, sourceWarnings } = await preparePostprocessIncoming(
            [auxAttachment],
            baseDoc,
            () => {}
          );
          if (sourceWarnings.length > 0 || !companions.length) {
            throw Object.assign(
              new Error(
                sourceWarnings.map(w => w.message).join('；') ||
                  `Companion file "${sourceFile.name}" could not be paired onto document "${targetDocumentId}"`
              ),
              { code: 'MCP_FILE_IMPORT_FAILED' }
            );
          }
          const nextOutput = enrichedOutput ?? baseDoc.output;
          const mergedCompanions: readonly PostprocessAttachment[] = [
            ...(baseDoc.companions ?? []).filter(
              old => !companions.some(next => next.source.result.role === old.source.result.role)
            ),
            ...companions
          ];
          let nextPair = baseDoc.pair;
          if (enrichedOutput && baseDoc.wavefunction) {
            nextPair = await pairPostprocessSourcesForFrames(nextOutput.source, baseDoc.wavefunction.source);
          }
          const displayedResult = await defaultPostprocessCompanion(nextOutput, mergedCompanions);
          const composed = composePostprocessDocument(
            baseDoc.id,
            nextOutput,
            baseDoc.wavefunction,
            nextPair,
            {
              companions: mergedCompanions,
              displayedResult
            }
          );
          assertValidStandaloneFrame(composed.result.frames.length, targetDocumentId);
          const initStructure = await readInitialPostprocessStructure(composed);
          adopted = true;
          registry.replaceAnalysisDocument(
            targetDocumentId,
            composed.result,
            initStructure,
            composed.id
          );
          if (customLabel) registry.rename(targetDocumentId, customLabel);
          standalonePostprocessDocs.set(targetDocumentId, composed);
          registry.setModule('analysis');
          const retainedIds = new Set(mergedCompanions.map(c => c.source.result.source.id));
          const superseded = (baseDoc.companions ?? []).filter(c => !retainedIds.has(c.source.result.source.id));
          if (superseded.length) {
            await disposePostprocessAttachments(superseded, closeStandaloneNativeSession).catch(() => {});
          }
          return { documentId: targetDocumentId };
        }

        const composed = composePostprocessDocument(
          `analysis-${crypto.randomUUID()}`,
          auxAttachment
        );
        assertValidStandaloneFrame(composed.result.frames.length, composed.id);
        const initStructure = await readInitialPostprocessStructure(composed);
        adopted = true;
        const entry = registry.addAnalysisDocument(
          composed.result,
          initStructure,
          composed.id,
          true,
          'analysis'
        );
        if (customLabel) registry.rename(entry.id, customLabel);
        standalonePostprocessDocs.set(entry.id, composed);
        standaloneLastFileDocId = null;
        registry.setModule('analysis');
        return { documentId: entry.id };
      }

      throw Object.assign(
        new Error(identity.message || `Unsupported analysis file format: ${sourceFile.name}`),
        { code: 'MCP_FILE_IMPORT_FAILED' }
      );
    } finally {
      if (!adopted) {
        if (nativeSessionId) {
          await closeStandaloneNativeSession(nativeSessionId);
        }
        await Promise.resolve(input.close?.()).catch(() => {});
      }
    }
  }

  function resolveEffectiveAnalysisTarget(requestedIdRaw?: unknown): McpResolvedAnalysisTarget {
    const callbacks = options.getCallbacks?.();
    const requestedId = typeof requestedIdRaw === 'string' && requestedIdRaw.trim()
      ? requestedIdRaw.trim()
      : undefined;

    if (callbacks?.getAnalysisTarget) {
      const liveTarget = callbacks.getAnalysisTarget(requestedId);
      if (liveTarget) return liveTarget;
      throw Object.assign(
        new Error(`Analysis document not found: ${requestedId || '(no active analysis document)'}`),
        { code: 'MCP_DOCUMENT_NOT_FOUND' }
      );
    }

    if (requestedId && standaloneFileDocs.has(requestedId) && !standalonePostprocessDocs.has(requestedId)) {
      const fileDoc = standaloneFileDocs.get(requestedId)!;
      return {
        documentId: requestedId,
        label: fileDoc.output.source.identity.name,
        fileDocument: fileDoc,
        postprocessDocument: postprocessFileDisplayDocument(fileDoc),
        currentFrameIndex: standaloneFrameIndices.get(requestedId) ?? 0,
        activePanel: standaloneActivePanels.get(requestedId) ?? null
      };
    }

    if (!requestedId && standaloneLastFileDocId && standaloneFileDocs.has(standaloneLastFileDocId)) {
      const fileDoc = standaloneFileDocs.get(standaloneLastFileDocId)!;
      return {
        documentId: standaloneLastFileDocId,
        label: fileDoc.output.source.identity.name,
        fileDocument: fileDoc,
        postprocessDocument: postprocessFileDisplayDocument(fileDoc),
        currentFrameIndex: standaloneFrameIndices.get(standaloneLastFileDocId) ?? 0,
        activePanel: standaloneActivePanels.get(standaloneLastFileDocId) ?? null
      };
    }

    const { entry, structure } = resolveTargetOrActiveDocument(requestedId);
    const postDoc = standalonePostprocessDocs.get(entry.id) ?? null;
    const fileDoc = standaloneFileDocs.get(entry.id) ?? null;
    const trajResult = entry.result ?? entry.analysisBinding?.result ?? entry.legacyResult ?? null;
    const defaultFrame = postDoc
      ? (postprocessWavefunctionFrame(postDoc) ?? Math.max(0, postDoc.result.frames.length - 1))
      : trajResult
        ? Math.max(0, trajResult.frames.length - 1)
        : 0;
    const frameIndex = standaloneFrameIndices.get(entry.id) ?? defaultFrame;

    return {
      documentId: entry.id,
      label: entry.label,
      entry,
      postprocessDocument: postDoc,
      fileDocument: fileDoc,
      trajectoryResult: trajResult,
      currentFrameIndex: frameIndex,
      currentStructure: structure,
      activePanel: standaloneActivePanels.get(entry.id) ?? null
    };
  }

  async function handleOpenResultAnalysis(payload: Record<string, unknown>): Promise<unknown> {
    const registry = options.getRegistry();
    const callbacks = options.getCallbacks?.();
    const requestedDocId = typeof payload.documentId === 'string' && payload.documentId.trim()
      ? payload.documentId.trim()
      : undefined;
    const label = typeof payload.label === 'string' && payload.label.trim()
      ? payload.label.trim()
      : undefined;
    const panel = typeof payload.panel === 'string' && payload.panel.trim()
      ? (payload.panel.trim() as AnalysisPage)
      : undefined;
    const frameIndex = typeof payload.frameIndex === 'number' && Number.isInteger(payload.frameIndex) && payload.frameIndex >= 0
      ? payload.frameIndex
      : undefined;

    setTaskCenterOpenSync(false);

    let resolvedDocId = requestedDocId;
    let sourceDescriptorAdopted = false;
    const source = payload.source && typeof payload.source === 'object' && !Array.isArray(payload.source)
      ? (payload.source as Record<string, unknown>)
      : undefined;

    try {
      if (source) {
        if (typeof source.taskId === 'string' && source.taskId.trim()) {
          const taskId = source.taskId.trim();
          if (!callbacks?.openTaskSnapshotInAnalysis) {
            throw Object.assign(
              new Error('Task snapshot analysis opening requires an active WorkspaceShell task bridge'),
              { code: 'MCP_TASK_SNAPSHOT_UNAVAILABLE' }
            );
          }
          const opened = await callbacks.openTaskSnapshotInAnalysis(taskId);
          resolvedDocId = opened.documentId;
          analysisTableStore.clear(resolvedDocId);
        } else if (source.filePath !== undefined || source.text !== undefined || source.sourceDescriptor !== undefined) {
          const sourceFile = buildScientificSourceFileFromPayload(source);
          try {
            let pairTargetId: string | undefined;
            if (requestedDocId) {
              const existingEntry = resolveTargetDocument(registry.getSnapshot(), requestedDocId, undefined);
              pairTargetId = existingEntry?.id ?? requestedDocId;
            }
            if (callbacks?.openResultFileInAnalysis) {
              const opened = await callbacks.openResultFileInAnalysis(sourceFile, {
                targetDocumentId: pairTargetId,
                label,
                frameIndex
              });
              resolvedDocId = opened.documentId;
            } else {
              const opened = await standaloneOpenFileInAnalysis(
                sourceFile,
                pairTargetId,
                label,
                frameIndex
              );
              resolvedDocId = opened.documentId;
            }
            sourceDescriptorAdopted = true;
            analysisTableStore.clear(resolvedDocId);
            if (frameIndex === undefined) {
              standaloneFrameIndices.delete(resolvedDocId);
            }
          } finally {
            await Promise.resolve(sourceFile.close?.()).catch(() => {});
          }
        }
      }

      const target = resolveEffectiveAnalysisTarget(resolvedDocId);

      if (frameIndex !== undefined) {
        const availableFrames =
          target.postprocessDocument?.result.frames.length ??
          target.trajectoryResult?.frames.length ??
          0;
        if (availableFrames > 0 && frameIndex >= availableFrames) {
          throw Object.assign(
            new Error(`frameIndex ${frameIndex} is out of range (document "${target.documentId}" has ${availableFrames} frame(s), valid indices: 0..${availableFrames - 1})`),
            { code: 'INVALID_FRAME_INDEX' }
          );
        }
      }

      if (callbacks?.syncAnalysisPresentation) {
        callbacks.syncAnalysisPresentation(target.documentId, {
          ...(panel ? { panel } : {}),
          ...(frameIndex !== undefined ? { frameIndex } : {})
        });
      } else {
        const view = registry.getSnapshot().views.find(v => v.documentId === target.documentId);
        if (view) registry.activate(view.id);
        registry.setModule('analysis');
        if (panel) standaloneActivePanels.set(target.documentId, panel);
        if (frameIndex !== undefined) standaloneFrameIndices.set(target.documentId, frameIndex);
      }

      const refreshedTarget = resolveEffectiveAnalysisTarget(target.documentId);
      let structureAtFrame = refreshedTarget.currentStructure ?? null;
      const effectiveFrame = frameIndex ?? refreshedTarget.currentFrameIndex ?? 0;
      const activeTraj = refreshedTarget.postprocessDocument?.result ?? refreshedTarget.trajectoryResult;
      if (activeTraj && activeTraj.frames[effectiveFrame]) {
        try {
          structureAtFrame = await activeTraj.getFrame(effectiveFrame);
        } catch {
          // Keep currentStructure fallback
        }
      }

      const summary = summarizeAnalysisTarget({
        documentId: refreshedTarget.documentId,
        label: refreshedTarget.label,
        postprocessDocument: refreshedTarget.postprocessDocument,
        fileDocument: refreshedTarget.fileDocument,
        trajectoryResult: refreshedTarget.trajectoryResult,
        currentFrameIndex: effectiveFrame,
        currentStructure: structureAtFrame,
        activePanel: panel ?? refreshedTarget.activePanel ?? null
      });

      return {
        ...summary,
        workbench: currentStatusSnapshot(false)
      };
    } catch (error) {
      if (sourceDescriptorAdopted && error && typeof error === 'object') {
        (error as { sourceAdopted?: boolean }).sourceAdopted = true;
      }
      throw error;
    }
  }

  async function handleRunWavefunctionAnalysis(payload: Record<string, unknown>): Promise<unknown> {
    const registry = options.getRegistry();
    const callbacks = options.getCallbacks?.();
    const desktop = options.getDesktop?.();

    const requestedDocId = typeof payload.documentId === 'string' && payload.documentId.trim()
      ? payload.documentId.trim()
      : undefined;
    const kind = payload.kind as 'charges' | 'bond-orders' | 'composition' | 'orbitals' | 'reactivity';
    const method = typeof payload.method === 'string' && payload.method.trim()
      ? payload.method.trim()
      : undefined;
    const orbitalKey = typeof payload.orbitalKey === 'string' && payload.orbitalKey.trim()
      ? payload.orbitalKey.trim()
      : undefined;
    const isovalue = typeof payload.isovalue === 'number' && Number.isFinite(payload.isovalue)
      ? payload.isovalue
      : undefined;
    const gridSpacingAngstrom = typeof payload.gridSpacingAngstrom === 'number' && Number.isFinite(payload.gridSpacingAngstrom)
      ? payload.gridSpacingAngstrom
      : undefined;
    const renderInViewport = payload.renderInViewport !== false;
    const timeoutSeconds =
      typeof payload.timeoutSeconds === 'number' &&
      Number.isFinite(payload.timeoutSeconds) &&
      payload.timeoutSeconds > 0
        ? payload.timeoutSeconds
        : undefined;

    if (renderInViewport) {
      setTaskCenterOpenSync(false);
    }

    const target = resolveEffectiveAnalysisTarget(requestedDocId);
    const postDoc = target.postprocessDocument ?? (target.fileDocument ? postprocessFileDisplayDocument(target.fileDocument) : null);
    if (!postDoc) {
      throw Object.assign(
        new Error(
          `Document "${target.documentId}" does not have a geometry-backed Result Analysis document with wavefunction support. Open a calculation output + wavefunction (.fchk/.molden) via ester_open_result_analysis first.`
        ),
        { code: 'MCP_WAVEFUNCTION_UNAVAILABLE' }
      );
    }

    const modelDocument = target.entry?.store.getSnapshot();
    const fallbackStructure =
      target.currentStructure ??
      postDoc.result.initialStructure ??
      modelDocument?.draft.structure;
    if (!fallbackStructure || !fallbackStructure.atoms.length) {
      throw Object.assign(
        new Error(`Document "${target.documentId}" has no atomic coordinates for wavefunction analysis`),
        { code: 'MCP_EMPTY_STRUCTURE' }
      );
    }

    const nextSerial = ++overlaySerialCounter;
    const execution = await executeWavefunctionAnalysis({
      documentId: target.documentId,
      document: postDoc,
      structure: fallbackStructure,
      modelDocument,
      frameIndex: target.currentFrameIndex ?? 0,
      desktop,
      tableStore: analysisTableStore,
      overlaySerial: nextSerial,
      params: {
        kind,
        method,
        orbitalKey,
        isovalue,
        gridSpacingAngstrom,
        renderInViewport,
        timeoutSeconds
      }
    });

    if (renderInViewport) {
      if (callbacks?.syncAnalysisPresentation) {
        callbacks.syncAnalysisPresentation(target.documentId, {
          panel: execution.targetPanel,
          frameIndex: execution.targetFrameIndex,
          overlay: execution.overlay
        });
      } else {
        const view = registry.getSnapshot().views.find(v => v.documentId === target.documentId);
        if (view) registry.activate(view.id);
        registry.setModule('analysis');
        standaloneActivePanels.set(target.documentId, execution.targetPanel);
        standaloneFrameIndices.set(target.documentId, execution.targetFrameIndex);
      }
    }

    return {
      ...execution.response,
      workbench: currentStatusSnapshot(false)
    };
  }

  async function handleExportArtifact(payload: Record<string, unknown>): Promise<unknown> {
    const registry = options.getRegistry();
    const callbacks = options.getCallbacks?.();

    const requestedDocId = typeof payload.documentId === 'string' && payload.documentId.trim()
      ? payload.documentId.trim()
      : undefined;
    const kind = payload.kind as 'structure' | 'input-script' | 'analysis-table';
    const format = typeof payload.format === 'string' && payload.format.trim()
      ? payload.format.trim()
      : undefined;
    const withCell = typeof payload.withCell === 'boolean' ? payload.withCell : undefined;
    const analysisKind = typeof payload.analysisKind === 'string' && payload.analysisKind.trim()
      ? (payload.analysisKind.trim() as 'charges' | 'bond-orders' | 'composition' | 'reactivity' | 'printed-charges')
      : undefined;
    const method = typeof payload.method === 'string' && payload.method.trim()
      ? payload.method.trim()
      : undefined;
    const outputPath = typeof payload.outputPath === 'string' ? payload.outputPath.trim() : '';

    const snapshot = registry.getSnapshot();
    const workspaceInputSources = snapshot.documents
      .filter(doc => !doc.result)
      .map(doc => registry.source(doc.id));

    if (kind === 'input-script') {
      const { entry } = resolveTargetOrActiveDocument(requestedDocId);
      return buildExportArtifactPayload({
        documentId: entry.id,
        entry,
        tableStore: analysisTableStore,
        inputSources: workspaceInputSources,
        captureLiveDraft: preferredEngine =>
          callbacks?.captureLiveSubmissionDraft?.(entry.id, preferredEngine),
        params: {
          kind,
          format,
          outputPath
        }
      });
    }

    let analysisTarget: McpResolvedAnalysisTarget | null = null;
    try {
      analysisTarget = resolveEffectiveAnalysisTarget(requestedDocId);
    } catch (error) {
      if (kind === 'analysis-table') throw error;
    }

    if (analysisTarget) {
      let structureForExport = analysisTarget.currentStructure ?? null;
      if (kind === 'structure') {
        const activeTraj = analysisTarget.postprocessDocument?.result ?? analysisTarget.trajectoryResult;
        const frameIdx = analysisTarget.currentFrameIndex ?? 0;
        // Prefer live ModelStore coordinates for ordinary modeling tabs; for analysis/trajectory tabs use the current frame!
        const entryDraftAtoms = analysisTarget.entry?.store.getSnapshot().draft.structure.atoms.length ?? 0;
        const isPureModelingTab = Boolean(
          analysisTarget.entry &&
          entryDraftAtoms > 0 &&
          !analysisTarget.postprocessDocument &&
          !analysisTarget.fileDocument &&
          !analysisTarget.trajectoryResult
        );
        if (!isPureModelingTab && activeTraj && activeTraj.frames[frameIdx]) {
          try {
            structureForExport = await activeTraj.getFrame(frameIdx);
          } catch {
            // Keep currentStructure fallback
          }
        }
      }

      return buildExportArtifactPayload({
        documentId: analysisTarget.documentId,
        entry: analysisTarget.entry ?? null,
        postprocessDocument: analysisTarget.postprocessDocument ?? null,
        fileDocument: analysisTarget.fileDocument ?? null,
        currentStructure: structureForExport,
        currentFrameIndex: analysisTarget.currentFrameIndex ?? 0,
        tableStore: analysisTableStore,
        inputSources: workspaceInputSources,
        params: {
          kind,
          format,
          withCell,
          analysisKind,
          method,
          outputPath
        }
      });
    }

    const { entry, structure } = resolveTargetOrActiveDocument(requestedDocId);
    return buildExportArtifactPayload({
      documentId: entry.id,
      entry,
      currentStructure: structure,
      tableStore: analysisTableStore,
      inputSources: workspaceInputSources,
      params: {
        kind,
        format,
        withCell,
        analysisKind,
        method,
        outputPath
      }
    });
  }

  async function handleRequest(request: McpFrontendRequest): Promise<McpFrontendReply> {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const action = typeof request?.action === 'string' ? request.action : '';
    const payload = request?.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
      ? request.payload
      : {};

    try {
      if (action === 'frontend.ping') {
        return {
          requestId,
          ok: true,
          result: {
            workbenchOnline: true,
            timestamp: Date.now(),
            ...(typeof payload.message === 'string' ? { echo: payload.message } : {})
          }
        };
      }

      if (action === 'frontend.status') {
        const includeDocuments = payload.includeDocuments !== false;
        return {
          requestId,
          ok: true,
          result: currentStatusSnapshot(includeDocuments)
        };
      }

      if (action === 'frontend.windowManage') {
        try {
          const result = await handleWindowManage(payload);
          return {
            requestId,
            ok: true,
            result
          };
        } finally {
          if (options.getCallbacks?.()?.setTaskCenterOpen) {
            taskCenterOpenOverride = null;
          }
        }
      }

      if (action === 'frontend.openFile') {
        try {
          const result = await handleOpenFile(payload);
          return {
            requestId,
            ok: true,
            result
          };
        } finally {
          if (options.getCallbacks?.()?.setTaskCenterOpen) {
            taskCenterOpenOverride = null;
          }
        }
      }

      if (action === 'frontend.viewportCamera') {
        const result = await handleViewportCamera(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      if (action === 'frontend.viewportScreenshot') {
        const result = await handleViewportScreenshot(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      if (action === 'frontend.getStructureInfo') {
        const result = await handleGetStructureInfo(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      if (action === 'frontend.measureGeometry') {
        const result = await handleMeasureGeometry(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      if (action === 'frontend.editStructure') {
        const result = await handleEditStructure(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      if (action === 'frontend.setConstraints') {
        const result = await handleSetConstraints(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      if (action === 'frontend.recommendMethod') {
        const result = await handleRecommendMethod(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      if (action === 'frontend.configureCalculation') {
        try {
          const result = await handleConfigureCalculation(payload);
          return {
            requestId,
            ok: true,
            result
          };
        } finally {
          if (options.getCallbacks?.()?.setTaskCenterOpen) {
            taskCenterOpenOverride = null;
          }
        }
      }

      if (action === 'frontend.runLocalXtb') {
        try {
          const result = await handleRunLocalXtb(payload);
          return {
            requestId,
            ok: true,
            result
          };
        } finally {
          if (options.getCallbacks?.()?.setTaskCenterOpen) {
            taskCenterOpenOverride = null;
          }
        }
      }

      if (action === 'frontend.submitTask') {
        try {
          const result = await handleSubmitTask(payload);
          return {
            requestId,
            ok: true,
            result
          };
        } finally {
          if (options.getCallbacks?.()?.setTaskCenterOpen) {
            taskCenterOpenOverride = null;
          }
        }
      }

      if (action === 'frontend.taskManage') {
        const result = await handleTaskManage(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      if (action === 'frontend.openResultAnalysis') {
        try {
          const result = await handleOpenResultAnalysis(payload);
          return {
            requestId,
            ok: true,
            result
          };
        } finally {
          if (options.getCallbacks?.()?.setTaskCenterOpen) {
            taskCenterOpenOverride = null;
          }
        }
      }

      if (action === 'frontend.runWavefunctionAnalysis') {
        try {
          const result = await handleRunWavefunctionAnalysis(payload);
          return {
            requestId,
            ok: true,
            result
          };
        } finally {
          if (options.getCallbacks?.()?.setTaskCenterOpen) {
            taskCenterOpenOverride = null;
          }
        }
      }

      if (action === 'frontend.exportArtifact') {
        const result = await handleExportArtifact(payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      const extraHandlers = options.getExtraHandlers?.();
      if (extraHandlers && typeof extraHandlers[action] === 'function') {
        const result = await extraHandlers[action](payload);
        return {
          requestId,
          ok: true,
          result
        };
      }

      return {
        requestId,
        ok: false,
        error: {
          code: 'MCP_UNKNOWN_FRONTEND_ACTION',
          message: `Unsupported frontend MCP action: ${action}`
        }
      };
    } catch (error) {
      const sourceAdopted = Boolean((error as { sourceAdopted?: boolean })?.sourceAdopted);
      return {
        requestId,
        ok: false,
        error: {
          code: (error as { code?: string })?.code ?? 'MCP_FRONTEND_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error),
          ...(sourceAdopted ? { sourceAdopted: true } : {})
        }
      };
    }
  }

  return {
    handleRequest
  };
}

export function useMcpCollaborationBridge(options: {
  desktop?: DesktopBridge;
  registry: WorkspaceRegistryInstance;
  taskCenterOpen: boolean;
  callbacks?: McpCollaborationCallbacks;
  extraHandlers?: Record<string, McpFrontendActionHandler>;
}): void {
  const registryRef = useRef(options.registry);
  registryRef.current = options.registry;

  const taskCenterOpenRef = useRef(options.taskCenterOpen);
  taskCenterOpenRef.current = options.taskCenterOpen;

  const desktopRef = useRef(options.desktop);
  desktopRef.current = options.desktop;

  const callbacksRef = useRef(options.callbacks);
  callbacksRef.current = options.callbacks;

  const extraHandlersRef = useRef(options.extraHandlers);
  extraHandlersRef.current = options.extraHandlers;

  useEffect(() => {
    const desktop = options.desktop;
    if (!desktop?.onMcpFrontendRequest || !desktop?.replyMcpFrontendRequest) {
      return;
    }

    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registryRef.current,
      isTaskCenterOpen: () => taskCenterOpenRef.current,
      getDesktop: () => desktopRef.current,
      getCallbacks: () => {
        const current = callbacksRef.current;
        if (!current) return undefined;
        return {
          ...current,
          setTaskCenterOpen: open => {
            taskCenterOpenRef.current = open;
            current.setTaskCenterOpen?.(open);
          }
        };
      },
      getExtraHandlers: () => extraHandlersRef.current
    });

    const unsubscribe = desktop.onMcpFrontendRequest(request => {
      void dispatcher.handleRequest(request).then(reply => {
        if (!reply.requestId) return;
        return desktop.replyMcpFrontendRequest?.(reply);
      }).catch(() => {
        // Ignore IPC reply errors if window is closing
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [options.desktop]);
}
