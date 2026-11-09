import { describe, it, expect } from 'vitest';
import { DEFAULT_DISPLAY, type DesktopBridge } from '../../../src/modeling/contracts';
import { createWorkspaceRegistry } from '../../../src/modeling/workspace-registry';
import {
  collectWorkbenchStatusSnapshot,
  computeHillFormula,
  createMcpFrontendDispatcher,
  resolveOpenFileTargetChoice
} from '../../../src/web/mcp/useMcpCollaborationBridge';

describe('Frontend MCP Collaboration Bridge (Phase 1 & Phase 2)', () => {
  it('computes Hill chemical formulas and resolves file import targets accurately', () => {
    expect(computeHillFormula([])).toBe('');
    expect(
      computeHillFormula([
        { element: 'O' },
        { element: 'H' },
        { element: 'H' }
      ])
    ).toBe('H2O');
    expect(
      computeHillFormula([
        { element: 'O' },
        { element: 'C' },
        { element: 'C' },
        { element: 'H' },
        { element: 'H' },
        { element: 'H' },
        { element: 'H' },
        { element: 'H' },
        { element: 'H' }
      ])
    ).toBe('C2H6O');
    expect(
      computeHillFormula([
        { element: 'O' },
        { element: 'Fe' },
        { element: 'O' },
        { element: 'Fe' },
        { element: 'O' }
      ])
    ).toBe('Fe2O3');

    expect(resolveOpenFileTargetChoice('ethanol.xyz', 'auto')).toBe('structure');
    expect(resolveOpenFileTargetChoice('benzene.gjf', 'auto')).toBe('structure');
    expect(resolveOpenFileTargetChoice('opt_freq.log', 'auto')).toBe('analysis');
    expect(resolveOpenFileTargetChoice('orca_sp.out', 'auto')).toBe('analysis');
    expect(resolveOpenFileTargetChoice('wavefn.fchk', 'auto')).toBe('analysis');
    expect(resolveOpenFileTargetChoice('opt_freq.log', 'modeling')).toBe('structure');
    expect(resolveOpenFileTargetChoice('ethanol.xyz', 'analysis')).toBe('analysis');
  });

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
      formula: 'C2O',
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

  it('manages workbench modules, document lifecycle, dirty-close guard, task center, and layout via frontend.windowManage', async () => {
    const registry = createWorkspaceRegistry();
    const doc1 = registry.addDocument(null, 'Doc-1');
    let taskCenterOpen = false;

    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => taskCenterOpen,
      getCallbacks: () => ({
        setTaskCenterOpen: open => {
          taskCenterOpen = open;
        }
      })
    });

    // 1. Switch module to input
    const switchRes = await dispatcher.handleRequest({
      requestId: 'wm-1',
      action: 'frontend.windowManage',
      payload: { action: 'switch-module', module: 'input' }
    });
    expect(switchRes.ok).toBe(true);
    expect(registry.getSnapshot().module).toBe('input');

    // 2. Create a new document with custom label and switch module to modeling
    const createRes = await dispatcher.handleRequest({
      requestId: 'wm-2',
      action: 'frontend.windowManage',
      payload: { action: 'create-document', label: 'Caffeine-Draft', module: 'modeling' }
    });
    expect(createRes.ok).toBe(true);
    const createdId = (createRes.result as { createdDocumentId: string }).createdDocumentId;
    expect(registry.getSnapshot().documents).toHaveLength(2);
    expect(registry.getSnapshot().module).toBe('modeling');
    expect(registry.document(createdId).label).toBe('Caffeine-Draft');

    // 3. Activate first document by documentId, then activate second document by label
    const activateRes = await dispatcher.handleRequest({
      requestId: 'wm-3',
      action: 'frontend.windowManage',
      payload: { action: 'activate-document', documentId: doc1.id }
    });
    expect(activateRes.ok).toBe(true);
    expect((activateRes.result as { activatedDocumentId: string }).activatedDocumentId).toBe(doc1.id);

    const activateByLabelRes = await dispatcher.handleRequest({
      requestId: 'wm-3b',
      action: 'frontend.windowManage',
      payload: { action: 'activate-document', label: 'Caffeine-Draft' }
    });
    expect(activateByLabelRes.ok).toBe(true);
    expect((activateByLabelRes.result as { activatedDocumentId: string }).activatedDocumentId).toBe(createdId);

    // 4. Mark created document dirty and verify close-document refuses without discardUnsaved: true
    registry.document(createdId).store.execute({
      type: 'place-element',
      element: 'C',
      position: [0, 0, 0]
    });
    expect(registry.document(createdId).store.getSnapshot().draft.dirty).toBe(true);

    const blockedCloseRes = await dispatcher.handleRequest({
      requestId: 'wm-4',
      action: 'frontend.windowManage',
      payload: { action: 'close-document', documentId: createdId, discardUnsaved: false }
    });
    expect(blockedCloseRes.ok).toBe(false);
    expect(blockedCloseRes.error?.code).toBe('MCP_DOCUMENT_UNSAVED');
    expect(registry.getSnapshot().documents).toHaveLength(2);

    // 5. Force close with discardUnsaved: true
    const forceCloseRes = await dispatcher.handleRequest({
      requestId: 'wm-5',
      action: 'frontend.windowManage',
      payload: { action: 'close-document', documentId: createdId, discardUnsaved: true }
    });
    expect(forceCloseRes.ok).toBe(true);
    expect(registry.getSnapshot().documents).toHaveLength(1);

    // 6. Open and close Task Center (verify workbench.taskCenterOpen is accurate)
    const openTcRes = await dispatcher.handleRequest({
      requestId: 'wm-6',
      action: 'frontend.windowManage',
      payload: { action: 'open-task-center' }
    });
    expect(openTcRes.ok).toBe(true);
    expect(taskCenterOpen).toBe(true);
    expect((openTcRes.result as { workbench: { taskCenterOpen: boolean } }).workbench.taskCenterOpen).toBe(true);

    const closeTcRes = await dispatcher.handleRequest({
      requestId: 'wm-7',
      action: 'frontend.windowManage',
      payload: { action: 'close-task-center' }
    });
    expect(closeTcRes.ok).toBe(true);
    expect(taskCenterOpen).toBe(false);
    expect((closeTcRes.result as { workbench: { taskCenterOpen: boolean } }).workbench.taskCenterOpen).toBe(false);

    // 7. Set viewport layout mode
    const layoutRes = await dispatcher.handleRequest({
      requestId: 'wm-8',
      action: 'frontend.windowManage',
      payload: { action: 'set-layout', layout: 'tiled', arrange: true }
    });
    expect(layoutRes.ok).toBe(true);
    expect((layoutRes.result as { layout: { deckMode: string } }).layout.deckMode).toBe('tiled');
  });

  it('imports molecular structure files (.xyz and .gjf) via frontend.openFile into WorkspaceRegistry', async () => {
    const registry = createWorkspaceRegistry();
    registry.addDocument(null, 'Initial');

    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => false
    });

    const waterXyz = [
      '3',
      'water molecule',
      'O  0.000000  0.000000  0.117300',
      'H  0.000000  0.757200 -0.469200',
      'H  0.000000 -0.757200 -0.469200',
      ''
    ].join('\n');

    const openXyzReply = await dispatcher.handleRequest({
      requestId: 'open-1',
      action: 'frontend.openFile',
      payload: {
        name: 'water.xyz',
        size: waterXyz.length,
        text: waterXyz,
        target: 'auto',
        label: 'Water-H2O'
      }
    });

    expect(openXyzReply.ok).toBe(true);
    const openResult = openXyzReply.result as {
      openedDocumentId: string;
      targetChoice: string;
      document: {
        id: string;
        label: string;
        formula: string;
        atomCount: number;
        active: boolean;
      };
    };
    expect(openResult.targetChoice).toBe('structure');
    expect(openResult.document).toMatchObject({
      id: openResult.openedDocumentId,
      label: 'Water-H2O',
      formula: 'H2O',
      atomCount: 3,
      active: true
    });

    const gjfContent = [
      '%chk=methane.chk',
      '#p B3LYP/6-31G(d) opt',
      '',
      'methane test',
      '',
      '0 1',
      'C   0.000000   0.000000   0.000000',
      'H   0.629118   0.629118   0.629118',
      'H  -0.629118  -0.629118   0.629118',
      'H   0.629118  -0.629118  -0.629118',
      'H  -0.629118   0.629118  -0.629118',
      ''
    ].join('\n');

    const openGjfReply = await dispatcher.handleRequest({
      requestId: 'open-2',
      action: 'frontend.openFile',
      payload: {
        name: 'methane.gjf',
        size: gjfContent.length,
        text: gjfContent,
        target: 'modeling'
      }
    });

    expect(openGjfReply.ok).toBe(true);
    const gjfResult = openGjfReply.result as {
      document: {
        formula: string;
        atomCount: number;
        charge: number;
        multiplicity: number;
      };
    };
    expect(gjfResult.document).toMatchObject({
      formula: 'CH4',
      atomCount: 5,
      charge: 0,
      multiplicity: 1
    });
  });
});
