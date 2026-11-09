import { describe, it, expect } from 'vitest';
import { DEFAULT_DISPLAY, type DesktopBridge } from '../../../src/modeling/contracts';
import { createWorkspaceRegistry } from '../../../src/modeling/workspace-registry';
import {
  collectWorkbenchStatusSnapshot,
  createMcpFrontendDispatcher
} from '../../../src/web/mcp/useMcpCollaborationBridge';

describe('Frontend MCP Collaboration Bridge (Phase 1)', () => {
  it('collects live workbench status and open document summaries from WorkspaceRegistry', () => {
    expect(DEFAULT_DISPLAY.representation).toBe('ball-stick');
    const mockBridge: Pick<DesktopBridge, 'onMcpFrontendRequest' | 'replyMcpFrontendRequest'> = {
      onMcpFrontendRequest: () => () => {},
      replyMcpFrontendRequest: async () => ({ accepted: true })
    };
    expect(typeof mockBridge.onMcpFrontendRequest).toBe('function');
    const registry = createWorkspaceRegistry();
    const doc = registry.addDocument(
      {
        id: 'struct-ethanol',
        name: 'ethanol.xyz',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        dimension: 3,
        notes: [],
        atoms: [
          { id: 'a1', element: 'C', x: 0, y: 0, z: 0 },
          { id: 'a2', element: 'C', x: 1.52, y: 0, z: 0 },
          { id: 'a3', element: 'O', x: 2.1, y: 1.2, z: 0 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 1, b: 2, order: 1 }
        ]
      },
      'ethanol'
    );

    doc.store.execute({
      type: 'set-shared-atom-freeze',
      atomIds: ['a1'],
      frozen: true
    });

    const snapshot = collectWorkbenchStatusSnapshot({
      registry,
      taskCenterOpen: true,
      includeDocuments: true
    });

    expect(snapshot.workbenchOnline).toBe(true);
    expect(snapshot.module).toBe('modeling');
    expect(snapshot.taskCenterOpen).toBe(true);
    expect(snapshot.activeDocumentId).toBe(doc.id);
    expect(snapshot.documentCount).toBe(1);
    expect(snapshot.documents).toHaveLength(1);
    expect(snapshot.documents?.[0]).toMatchObject({
      id: doc.id,
      label: 'ethanol',
      active: true,
      atomCount: 3,
      bondCount: 2,
      charge: 0,
      multiplicity: 1,
      isPeriodic: false,
      frozenAtomCount: 1,
      runtimePhase: 'idle'
    });
  });

  it('dispatches frontend.ping, frontend.status, extraHandlers, and unknown action errors', async () => {
    const registry = createWorkspaceRegistry();
    registry.addDocument(null, 'benzene');

    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => false,
      getExtraHandlers: () => ({
        'frontend.customEcho': async payload => ({ custom: payload.value })
      })
    });

    const pingReply = await dispatcher.handleRequest({
      requestId: 'req-1',
      action: 'frontend.ping',
      payload: { message: 'hello-renderer' }
    });
    expect(pingReply.ok).toBe(true);
    expect(pingReply.requestId).toBe('req-1');
    expect(pingReply.result).toMatchObject({
      workbenchOnline: true,
      echo: 'hello-renderer'
    });

    const statusReply = await dispatcher.handleRequest({
      requestId: 'req-2',
      action: 'frontend.status',
      payload: { includeDocuments: false }
    });
    expect(statusReply.ok).toBe(true);
    expect(statusReply.result).toMatchObject({
      workbenchOnline: true,
      documentCount: 1,
      taskCenterOpen: false
    });
    expect((statusReply.result as { documents?: unknown }).documents).toBeUndefined();

    const extraReply = await dispatcher.handleRequest({
      requestId: 'req-3',
      action: 'frontend.customEcho',
      payload: { value: 42 }
    });
    expect(extraReply).toEqual({
      requestId: 'req-3',
      ok: true,
      result: { custom: 42 }
    });

    const unknownReply = await dispatcher.handleRequest({
      requestId: 'req-4',
      action: 'frontend.nonExistent'
    });
    expect(unknownReply.ok).toBe(false);
    expect(unknownReply.error?.code).toBe('MCP_UNKNOWN_FRONTEND_ACTION');
  });
});
