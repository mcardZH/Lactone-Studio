import { useEffect, useRef } from 'react';
import type { DesktopBridge } from '../../modeling/contracts';
import type { WorkspaceModule } from '../../modeling/workspace-contracts';
import type { createWorkspaceRegistry } from '../../modeling/workspace-registry';

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

export interface McpOpenDocumentSummary {
  id: string;
  label: string;
  active: boolean;
  revision: number;
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
  documents?: McpOpenDocumentSummary[];
}

export type McpFrontendActionHandler = (
  payload: Record<string, unknown>
) => Promise<unknown> | unknown;

export function collectWorkbenchStatusSnapshot(options: {
  registry: WorkspaceRegistryInstance;
  taskCenterOpen: boolean;
  includeDocuments?: boolean;
}): McpWorkbenchStatusSnapshot {
  const snapshot = options.registry.getSnapshot();
  const activeView = snapshot.views.find(view => view.id === snapshot.activeViewId);
  const activeDocumentId = activeView?.documentId ?? null;
  const includeDocuments = options.includeDocuments !== false;

  const documents: McpOpenDocumentSummary[] | undefined = includeDocuments
    ? snapshot.documents.map(entry => {
        const modelDoc = entry.store.getSnapshot();
        const structure = modelDoc.draft.structure;
        const frozenAtoms = modelDoc.sharedConstraints?.frozenAtomIds
          ?? modelDoc.draft.assignments?.frozenAtomIds
          ?? [];
        const coordinates = modelDoc.sharedConstraints?.coordinates
          ?? modelDoc.internalCoordinates
          ?? [];
        return {
          id: entry.id,
          label: entry.label,
          active: entry.id === activeDocumentId,
          revision: modelDoc.revision,
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
      })
    : undefined;

  return {
    workbenchOnline: true,
    module: snapshot.module,
    taskCenterOpen: Boolean(options.taskCenterOpen),
    activeViewId: snapshot.activeViewId,
    activeDocumentId,
    documentCount: snapshot.documents.length,
    ...(documents !== undefined ? { documents } : {})
  };
}

export function createMcpFrontendDispatcher(options: {
  getRegistry: () => WorkspaceRegistryInstance;
  isTaskCenterOpen: () => boolean;
  getExtraHandlers?: () => Record<string, McpFrontendActionHandler> | undefined;
}) {
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
        const status = collectWorkbenchStatusSnapshot({
          registry: options.getRegistry(),
          taskCenterOpen: options.isTaskCenterOpen(),
          includeDocuments
        });
        return {
          requestId,
          ok: true,
          result: status
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
  extraHandlers?: Record<string, McpFrontendActionHandler>;
}): void {
  const registryRef = useRef(options.registry);
  registryRef.current = options.registry;

  const taskCenterOpenRef = useRef(options.taskCenterOpen);
  taskCenterOpenRef.current = options.taskCenterOpen;

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
