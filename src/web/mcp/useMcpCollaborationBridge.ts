import { useEffect, useRef } from 'react';
import type { DesktopBridge } from '../../modeling/contracts';
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

export type WorkspaceRegistryInstance = ReturnType<typeof createWorkspaceRegistry>;

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
