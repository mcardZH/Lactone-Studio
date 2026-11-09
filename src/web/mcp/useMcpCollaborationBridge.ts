import { useEffect, useRef } from 'react';
import type { Structure, Vector3 } from '../../core/types';
import { DEFAULT_DISPLAY, type DesktopBridge, type DisplaySettings } from '../../modeling/contracts';
import {
  launchSourceFile,
  type LaunchImportBridge,
  type LaunchSourceDescriptor
} from '../../modeling/platform/launch-import';
import { modelFragmentsFromStructures } from '../../modeling/platform/files';
import type { WorkspaceModule } from '../../modeling/workspace-contracts';
import type { createWorkspaceRegistry } from '../../modeling/workspace-registry';
import { importWorkspaceItems } from '../../results/import-workspace';
import type { ScientificSourceFile } from '../../results/input-file';
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

export function computeHillFormula(atoms: ReadonlyArray<{ element: string }>): string {
  if (!atoms.length) return '';
  const counts = new Map<string, number>();
  for (const atom of atoms) {
    const symbol = typeof atom.element === 'string' ? atom.element.trim() : '';
    if (!symbol) continue;
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }
  if (!counts.size) return '';

  const orderedSymbols: string[] = [];
  if (counts.has('C')) {
    orderedSymbols.push('C');
    if (counts.has('H')) {
      orderedSymbols.push('H');
    }
    const rest = [...counts.keys()]
      .filter(sym => sym !== 'C' && sym !== 'H')
      .sort((a, b) => a.localeCompare(b));
    orderedSymbols.push(...rest);
  } else {
    orderedSymbols.push(...[...counts.keys()].sort((a, b) => a.localeCompare(b)));
  }

  return orderedSymbols
    .map(sym => {
      const count = counts.get(sym) ?? 0;
      return count > 1 ? `${sym}${count}` : sym;
    })
    .join('');
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
  const structure = modelDoc.draft.structure;
  const frozenAtoms = modelDoc.sharedConstraints?.frozenAtomIds
    ?? modelDoc.draft.assignments?.frozenAtomIds
    ?? [];
  const coordinates = modelDoc.sharedConstraints?.coordinates
    ?? modelDoc.internalCoordinates
    ?? [];
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
    frozenAtomCount: frozenAtoms.length,
    coordinateConstraintCount: coordinates.length,
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

  function setTaskCenterOpenSync(open: boolean): void {
    taskCenterOpenOverride = open;
    options.getCallbacks?.()?.setTaskCenterOpen?.(open);
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
      if (!entry) {
        throw Object.assign(new Error(`Document not found: ${targetId || '(none)'}`), {
          code: 'MCP_DOCUMENT_NOT_FOUND'
        });
      }
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
      return {
        requestId,
        ok: false,
        error: {
          code: (error as { code?: string })?.code ?? 'MCP_FRONTEND_EXECUTION_ERROR',
          message: error instanceof Error ? error.message : String(error)
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
