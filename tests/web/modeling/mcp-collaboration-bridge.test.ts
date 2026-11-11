import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { DEFAULT_DISPLAY, type DesktopBridge } from '../../../src/modeling/contracts';
import { createWorkspaceRegistry } from '../../../src/modeling/workspace-registry';
import { defaultSettings } from '../../../src/core/gaussian';
import { createOrcaCommonSettings } from '../../../src/core/orca';
import {
  captureDesktopAssignments,
  captureGaussianCoordinates,
  integrateDesktopBuilderResult
} from '../../../src/modeling/application/gaussian-bridge';
import {
  captureOrcaAssignments,
  captureOrcaCoordinates,
  integrateOrcaBuilderResult
} from '../../../src/modeling/application/orca-bridge';
import { projectSessionModel } from '../../../src/modeling/application/session-projection';
import { readProjectInputDrafts } from '../../../src/modeling/application/project-input-draft';
import { builderCoordinateValue } from '../../../src/core/builder-geometry';
import { XtbController } from '../../../src/modeling/xtb/controller';
import type { XtbBridge, XtbEvent, XtbRequest } from '../../../src/modeling/xtb/contracts';
import type { TaskSystemBridge } from '../../../src/task-system/application-contracts';
import type { ExternalInputDraft } from '../../../src/task-system/integration/input-draft';
import {
  applySubmissionDraftOverrides,
  formatXtbSinglepointOrOptimizeOutcome,
  resolveXtbSolvation
} from '../../../src/web/mcp/task-execution';
import {
  collectWorkbenchStatusSnapshot,
  computeHillFormula,
  createMcpFrontendDispatcher,
  resolveOpenFileTargetChoice
} from '../../../src/web/mcp/useMcpCollaborationBridge';
import {
  buildExportArtifactPayload,
  executeWavefunctionAnalysis,
  McpAnalysisTableStore,
  resolveOrbitalKeyAlias,
  summarizeAnalysisTarget,
  type McpAnalysisViewportOverlay
} from '../../../src/web/mcp/analysis-export';
import { GENERATED_XTB_POLICY_VERSION } from '../../../src/results/generated-xtb-policy';
import type { WavefunctionMetadata } from '../../../src/results/orbital-contracts';
import { convertEnergy } from '../../../src/results/energy';

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

  it('controls 3D camera presets, rotations, zoom, display toggles, and captures valid PNG screenshots (Phase 3)', async () => {
    const registry = createWorkspaceRegistry();
    const nonPeriodicDoc = registry.addDocument(
      {
        id: 'struct-water',
        name: 'water.xyz',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        dimension: 3,
        notes: [],
        atoms: [
          { id: 'o1', element: 'O', x: 0, y: 0, z: 0.12 },
          { id: 'h1', element: 'H', x: 0, y: 0.76, z: -0.47 },
          { id: 'h2', element: 'H', x: 0, y: -0.76, z: -0.47 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 0, b: 2, order: 1 }
        ]
      },
      'Water-Model'
    );

    const periodicDoc = registry.addDocument(
      {
        id: 'struct-nacl',
        name: 'NaCl.cif',
        format: 'cif',
        charge: 0,
        multiplicity: 1,
        dimension: 3,
        notes: [],
        cell: {
          vectors: [
            [5.64, 0, 0],
            [0, 5.64, 0],
            [0, 0, 5.64]
          ],
          pbc: [true, true, true]
        },
        atoms: [
          { id: 'na1', element: 'Na', x: 0, y: 0, z: 0 },
          { id: 'cl1', element: 'Cl', x: 2.82, y: 2.82, z: 2.82 }
        ],
        bonds: []
      },
      'NaCl-Crystal'
    );

    const appliedStates: Array<{
      documentId: string;
      cameraView?: number[];
      displaySettings?: unknown;
      showAxes?: boolean;
    }> = [];

    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => false,
      getCallbacks: () => ({
        applyViewportState: (documentId, next) => {
          appliedStates.push({ documentId, ...next });
        }
      })
    });

    // 1. Orient non-periodic Water-Model to principal-inertia, step rotate, zoom, and toggle atom indices
    const camWaterReply = await dispatcher.handleRequest({
      requestId: 'cam-1',
      action: 'frontend.viewportCamera',
      payload: {
        documentId: nonPeriodicDoc.id,
        preset: 'principal-inertia',
        rotateStep: 'right',
        zoom: 1.5,
        display: {
          style: 'stick',
          showAtomIndices: true,
          showElementLabels: true,
          showAxes: false
        }
      }
    });
    expect(camWaterReply.ok).toBe(true);
    const camWaterResult = camWaterReply.result as {
      documentId: string;
      cameraView: number[];
      pivot: number[];
      display: {
        style: string;
        showAtomIndices: boolean;
        showElementLabels: boolean;
        showAxes: boolean;
      };
    };
    expect(camWaterResult.documentId).toBe(nonPeriodicDoc.id);
    expect(camWaterResult.cameraView).toHaveLength(8);
    expect(camWaterResult.cameraView[3]).toBeCloseTo(187.5, 4);
    expect(camWaterResult.display).toMatchObject({
      style: 'stick',
      showAtomIndices: true,
      showElementLabels: true,
      showAxes: false
    });
    expect(appliedStates.length).toBe(1);
    expect(appliedStates[0].documentId).toBe(nonPeriodicDoc.id);

    // 2. Requesting crystal cell preset ('a') on non-periodic Water-Model returns MCP_STRUCTURE_NOT_PERIODIC
    const badCellReply = await dispatcher.handleRequest({
      requestId: 'cam-2',
      action: 'frontend.viewportCamera',
      payload: {
        documentId: nonPeriodicDoc.id,
        preset: 'a'
      }
    });
    expect(badCellReply.ok).toBe(false);
    expect(badCellReply.error?.code).toBe('MCP_STRUCTURE_NOT_PERIODIC');

    // 3. Orient periodic NaCl-Crystal to crystal cell preset 'c*' and rotateDelta
    const camCrystalReply = await dispatcher.handleRequest({
      requestId: 'cam-3',
      action: 'frontend.viewportCamera',
      payload: {
        documentId: periodicDoc.id,
        preset: 'c*',
        rotateDelta: { dx: 25, dy: -15 }
      }
    });
    expect(camCrystalReply.ok).toBe(true);
    const camCrystalResult = camCrystalReply.result as {
      documentId: string;
      cameraView: number[];
      pivot: number[];
    };
    expect(camCrystalResult.documentId).toBe(periodicDoc.id);
    expect(camCrystalResult.pivot).toEqual([1.41, 1.41, 1.41]);

    // 4. Reset camera view on Water-Model
    const resetCamReply = await dispatcher.handleRequest({
      requestId: 'cam-4',
      action: 'frontend.viewportCamera',
      payload: {
        documentId: nonPeriodicDoc.id,
        resetView: true
      }
    });
    expect(resetCamReply.ok).toBe(true);
    const resetCamResult = resetCamReply.result as { cameraView: number[] };
    expect(resetCamResult.cameraView[3]).toBe(125);
    expect(resetCamResult.cameraView.slice(4, 8)).toEqual([0, 0, 0, 1]);

    // 5. Capture PNG screenshot of Water-Model (headless 2D projection fallback)
    const shotReply = await dispatcher.handleRequest({
      requestId: 'shot-1',
      action: 'frontend.viewportScreenshot',
      payload: {
        documentId: nonPeriodicDoc.id,
        width: 320,
        height: 240,
        transparent: false,
        includeAnnotations: true
      }
    });
    expect(shotReply.ok).toBe(true);
    const shotResult = shotReply.result as {
      documentId: string;
      formula: string;
      atomCount: number;
      width: number;
      height: number;
      renderer: string;
      base64Png: string;
    };
    expect(shotResult).toMatchObject({
      documentId: nonPeriodicDoc.id,
      formula: 'H2O',
      atomCount: 3,
      width: 320,
      height: 240,
      renderer: 'fallback-2d'
    });

    const pngBytes = Buffer.from(shotResult.base64Png, 'base64');
    // Verify PNG signature (89 50 4E 47 0D 0A 1A 0A) and IHDR dimensions (320x240)
    expect([...pngBytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngBytes.readUInt32BE(16)).toBe(320);
    expect(pngBytes.readUInt32BE(20)).toBe(240);

    // 6. Verify sequential relative zoom on non-active document tab accumulates against latest committed cameraView
    const zoom1Reply = await dispatcher.handleRequest({
      requestId: 'cam-5a',
      action: 'frontend.viewportCamera',
      payload: {
        documentId: nonPeriodicDoc.id,
        zoom: 2.0
      }
    });
    expect(zoom1Reply.ok).toBe(true);
    expect((zoom1Reply.result as { cameraView: number[] }).cameraView[3]).toBeCloseTo(250, 4);

    const zoom2Reply = await dispatcher.handleRequest({
      requestId: 'cam-5b',
      action: 'frontend.viewportCamera',
      payload: {
        documentId: nonPeriodicDoc.id,
        zoom: 1.5
      }
    });
    expect(zoom2Reply.ok).toBe(true);
    expect((zoom2Reply.result as { cameraView: number[] }).cameraView[3]).toBeCloseTo(375, 4);
    expect(appliedStates.at(-1)?.documentId).toBe(nonPeriodicDoc.id);
    expect(appliedStates.at(-1)?.cameraView?.[3]).toBeCloseTo(375, 4);
  });

  it('executes Phase 4 structure introspection, geometry measurement, structure editing, Undo/Redo, and constraints with real ModelStore', async () => {
    const registry = createWorkspaceRegistry();

    // Create a 4-heavy-atom non-periodic F2O2 molecule (F-O-O-F) with a rotatable central single bond
    const h2o2Doc = registry.addDocument(
      {
        id: 'struct-h2o2',
        name: 'DioxygenDifluoride',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'a1', element: 'O', x: 0.0, y: 0.0, z: 0.0 },
          { id: 'a2', element: 'O', x: 1.45, y: 0.0, z: 0.0 },
          { id: 'a3', element: 'F', x: -0.35, y: 0.9, z: 0.0 },
          { id: 'a4', element: 'F', x: 1.8, y: 0.45, z: 0.78 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 0, b: 2, order: 1 },
          { a: 1, b: 3, order: 1 }
        ]
      },
      'F2O2-Model'
    );

    const naclDoc = registry.addDocument(
      {
        id: 'struct-nacl-p4',
        name: 'NaCl',
        format: 'cif',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'na1', element: 'Na', x: 0.0, y: 0.0, z: 0.0 },
          { id: 'cl1', element: 'Cl', x: 2.82, y: 2.82, z: 2.82 }
        ],
        bonds: [],
        cell: {
          vectors: [
            [5.64, 0, 0],
            [0, 5.64, 0],
            [0, 0, 5.64]
          ],
          pbc: [true, true, true]
        }
      },
      'NaCl-UnitCell'
    );

    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => false
    });

    // 1. Inspect H2O2 structure info including rotatable torsions
    const infoReply = await dispatcher.handleRequest({
      requestId: 'p4-info-1',
      action: 'frontend.getStructureInfo',
      payload: {
        documentId: h2o2Doc.id,
        includeAtoms: true,
        includeBonds: true,
        includeRotatableTorsions: true
      }
    });
    expect(infoReply.ok).toBe(true);
    const info = infoReply.result as {
      formula: string;
      atomCount: number;
      bondCount: number;
      isPeriodic: boolean;
      atoms: Array<{ index: number; element: string; neighbors: number[] }>;
      bonds: Array<{ a: number; b: number; lengthAngstrom: number }>;
      rotatableTorsions: {
        available: boolean;
        count: number;
        torsions: Array<{ atoms: number[]; axisAtoms: number[]; dihedralDegrees: number }>;
      };
    };
    expect(info.formula).toBe('F2O2');
    expect(info.atomCount).toBe(4);
    expect(info.bondCount).toBe(3);
    expect(info.isPeriodic).toBe(false);
    expect(info.atoms[0]).toMatchObject({ index: 1, element: 'O', neighbors: [2, 3] });
    expect(info.bonds[0]).toMatchObject({ a: 1, b: 2 });
    expect(info.bonds[0].lengthAngstrom).toBeCloseTo(1.45, 4);
    expect(info.rotatableTorsions.available).toBe(true);
    expect(info.rotatableTorsions.count).toBe(1);
    expect(info.rotatableTorsions.torsions[0].axisAtoms).toEqual([1, 2]);

    // 2. Inspect periodic NaCl crystal structure info (fractional coordinates & cell parameters)
    const naclInfoReply = await dispatcher.handleRequest({
      requestId: 'p4-info-2',
      action: 'frontend.getStructureInfo',
      payload: {
        documentId: naclDoc.id,
        includeAtoms: true,
        includeRotatableTorsions: true
      }
    });
    expect(naclInfoReply.ok).toBe(true);
    const naclInfo = naclInfoReply.result as {
      isPeriodic: boolean;
      cell: { parameters: { a: number; alpha: number }; volumeAngstrom3: number };
      atoms: Array<{ index: number; fractional: number[] }>;
      rotatableTorsions: { available: boolean };
    };
    expect(naclInfo.isPeriodic).toBe(true);
    expect(naclInfo.cell.parameters.a).toBeCloseTo(5.64, 4);
    expect(naclInfo.cell.parameters.alpha).toBeCloseTo(90, 4);
    expect(naclInfo.cell.volumeAngstrom3).toBeCloseTo(5.64 ** 3, 2);
    expect(naclInfo.atoms[1].fractional).toEqual([0.5, 0.5, 0.5]);
    expect(naclInfo.rotatableTorsions.available).toBe(false);

    // 3. Measure geometry (B, A, D + neighborShell + selectMeasuredAtoms)
    const measureReply = await dispatcher.handleRequest({
      requestId: 'p4-meas-1',
      action: 'frontend.measureGeometry',
      payload: {
        documentId: h2o2Doc.id,
        measurements: [
          { type: 'B', atoms: [1, 2] },
          { type: 'A', atoms: [3, 1, 2] },
          { type: 'D', atoms: [3, 1, 2, 4] }
        ],
        neighborShell: {
          centerAtom: 1,
          cutoffAngstrom: 2.0,
          includeAngles: true
        },
        selectMeasuredAtoms: true
      }
    });
    expect(measureReply.ok).toBe(true);
    const measureRes = measureReply.result as {
      measurements: Array<{ type: string; value: number; unit: string }>;
      neighborShell: {
        centerAtom: number;
        coordinationCount: number;
        neighbors: Array<{ atom: number; element: string; distanceAngstrom: number }>;
        angles: Array<{ atoms: number[]; angleDegrees: number }>;
      };
      selectedAtomIndices: number[];
    };
    expect(measureRes.measurements[0]).toMatchObject({ type: 'B', value: 1.45, unit: 'angstrom' });
    expect(measureRes.measurements[1].type).toBe('A');
    expect(measureRes.measurements[2].type).toBe('D');
    expect(measureRes.neighborShell.coordinationCount).toBe(2);
    expect(measureRes.neighborShell.neighbors.map(n => n.atom)).toEqual([3, 2]);
    expect(measureRes.neighborShell.angles.length).toBe(1);
    expect(measureRes.selectedAtomIndices.sort()).toEqual([1, 2, 3, 4]);
    expect(h2o2Doc.store.getSnapshot().selection.atomIds.length).toBe(4);

    // 4. Edit structure: adjust O1-O2 bond length to 1.52 A and dihedral to 90 deg, then Undo/Redo
    const editBondReply = await dispatcher.handleRequest({
      requestId: 'p4-edit-1',
      action: 'frontend.editStructure',
      payload: {
        documentId: h2o2Doc.id,
        operation: 'set-geometry',
        coordinate: 'B',
        atoms: [1, 2],
        value: 1.52
      }
    });
    expect(editBondReply.ok).toBe(true);

    const editDihedralReply = await dispatcher.handleRequest({
      requestId: 'p4-edit-2',
      action: 'frontend.editStructure',
      payload: {
        documentId: h2o2Doc.id,
        operation: 'set-geometry',
        coordinate: 'D',
        atoms: [3, 1, 2, 4],
        value: 90.0
      }
    });
    expect(editDihedralReply.ok).toBe(true);

    const checkGeomReply = await dispatcher.handleRequest({
      requestId: 'p4-meas-2',
      action: 'frontend.measureGeometry',
      payload: {
        documentId: h2o2Doc.id,
        measurements: [
          { type: 'B', atoms: [1, 2] },
          { type: 'D', atoms: [3, 1, 2, 4] }
        ]
      }
    });
    const checkedMeasurements = (checkGeomReply.result as { measurements: Array<{ value: number }> }).measurements;
    expect(checkedMeasurements[0].value).toBeCloseTo(1.52, 4);
    expect(checkedMeasurements[1].value).toBeCloseTo(90.0, 3);

    // Test Undo & Redo
    const undoReply = await dispatcher.handleRequest({
      requestId: 'p4-undo-1',
      action: 'frontend.editStructure',
      payload: {
        documentId: h2o2Doc.id,
        operation: 'undo'
      }
    });
    expect(undoReply.ok).toBe(true);
    expect((undoReply.result as { canRedo: boolean }).canRedo).toBe(true);

    const redoReply = await dispatcher.handleRequest({
      requestId: 'p4-redo-1',
      action: 'frontend.editStructure',
      payload: {
        documentId: h2o2Doc.id,
        operation: 'redo'
      }
    });
    expect(redoReply.ok).toBe(true);

    // Test supercell on periodic NaCl crystal (2x1x1 -> 4 atoms)
    const supercellReply = await dispatcher.handleRequest({
      requestId: 'p4-edit-supercell',
      action: 'frontend.editStructure',
      payload: {
        documentId: naclDoc.id,
        operation: 'supercell',
        repeat: [2, 1, 1]
      }
    });
    expect(supercellReply.ok).toBe(true);
    expect(naclDoc.store.getSnapshot().draft.structure.atoms.length).toBe(4);

    // 5. Set constraints (freeze atoms [1, 2] + scan dihedral [3, 1, 2, 4])
    const setConstReply = await dispatcher.handleRequest({
      requestId: 'p4-const-1',
      action: 'frontend.setConstraints',
      payload: {
        documentId: h2o2Doc.id,
        frozenAtoms: [1, 2],
        coordinates: [
          { type: 'B', atoms: [1, 2], action: 'freeze' },
          { type: 'D', atoms: [3, 1, 2, 4], action: 'scan', steps: 12, increment: 30 }
        ]
      }
    });
    expect(setConstReply.ok).toBe(true);
    const constResult = (setConstReply.result as {
      constraints: {
        frozenAtomIndices: number[];
        coordinates: Array<{ type: string; action: string; steps?: number; increment?: number }>;
      };
    }).constraints;
    expect(constResult.frozenAtomIndices).toEqual([1, 2]);
    expect(constResult.coordinates.length).toBe(2);
    expect(constResult.coordinates.find(c => c.action === 'scan')).toMatchObject({
      type: 'D',
      action: 'scan',
      steps: 12,
      increment: 30
    });

    // Verify conflict rejection when scanning a bond whose atoms [1, 2] are both frozen
    const conflictReply = await dispatcher.handleRequest({
      requestId: 'p4-const-conflict',
      action: 'frontend.setConstraints',
      payload: {
        documentId: h2o2Doc.id,
        frozenAtoms: [1, 2],
        coordinates: [
          { type: 'B', atoms: [1, 2], action: 'scan', steps: 5, increment: 0.1 }
        ]
      }
    });
    expect(conflictReply.ok).toBe(false);
    expect(conflictReply.error?.code).toBe('MCP_CONSTRAINT_CONFLICT');

    // Clear all constraints
    const clearConstReply = await dispatcher.handleRequest({
      requestId: 'p4-const-clear',
      action: 'frontend.setConstraints',
      payload: {
        documentId: h2o2Doc.id,
        clearFrozenAtoms: true,
        clearCoordinates: true
      }
    });
    expect(clearConstReply.ok).toBe(true);
    const cleared = (clearConstReply.result as {
      constraints: { frozenAtomIndices: number[]; coordinates: unknown[] };
    }).constraints;
    expect(cleared.frozenAtomIndices).toEqual([]);
    expect(cleared.coordinates).toEqual([]);
  });

  it('covers Phase 4 electronic-state Undo/Redo, bare/anchored add-atom, auxiliary & periodic bonds, read-only guards, and Gaussian/ORCA scan round-trips', async () => {
    const registry = createWorkspaceRegistry();
    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => false
    });

    const molDoc = registry.addDocument(
      {
        id: 'struct-water-p4',
        name: 'Water',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'o1', element: 'O', x: 0.0, y: 0.0, z: 0.0 },
          { id: 'h1', element: 'H', x: 0.96, y: 0.0, z: 0.0 },
          { id: 'h2', element: 'H', x: -0.24, y: 0.93, z: 0.0 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 0, b: 2, order: 1 }
        ]
      },
      'Water-Edit'
    );

    // 1. Out-of-range atom index in measureGeometry returns MCP_ATOM_INDEX_OUT_OF_RANGE
    const oorMeasure = await dispatcher.handleRequest({
      requestId: 'p4-r2-oor',
      action: 'frontend.measureGeometry',
      payload: {
        documentId: molDoc.id,
        measurements: [{ type: 'B', atoms: [1, 99] }]
      }
    });
    expect(oorMeasure.ok).toBe(false);
    expect(oorMeasure.error?.code).toBe('MCP_ATOM_INDEX_OUT_OF_RANGE');

    // 2. select-atoms + selectedOnly: true + aIndex/bIndex bond fields + freezeSelected: true
    const selReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-sel',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'select-atoms',
        atoms: [1, 2]
      }
    });
    expect(selReply.ok).toBe(true);

    const selInfoReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-sel-info',
      action: 'frontend.getStructureInfo',
      payload: {
        documentId: molDoc.id,
        selectedOnly: true
      }
    });
    expect(selInfoReply.ok).toBe(true);
    const selInfo = selInfoReply.result as {
      freezeEditingAllowed: boolean;
      atoms: Array<{ index: number; selected: boolean }>;
      bonds: Array<{ aIndex: number; bIndex: number; aAtomId: string; bAtomId: string }>;
    };
    expect(selInfo.freezeEditingAllowed).toBe(true);
    expect(selInfo.atoms.map(a => a.index)).toEqual([1, 2]);
    expect(selInfo.bonds[0]).toMatchObject({
      aIndex: 1,
      bIndex: 2,
      aAtomId: 'o1',
      bAtomId: 'h1'
    });

    const freezeSelectedReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-freeze-sel',
      action: 'frontend.setConstraints',
      payload: {
        documentId: molDoc.id,
        freezeSelected: true
      }
    });
    expect(freezeSelectedReply.ok).toBe(true);
    expect(
      (freezeSelectedReply.result as { constraints: { frozenAtomIndices: number[] } }).constraints.frozenAtomIndices
    ).toEqual([1, 2]);

    // Verify mode: 'append' while enabled: false preserves previously stored disabled freezes
    const disableFreezesReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-disable-freeze',
      action: 'frontend.setConstraints',
      payload: {
        documentId: molDoc.id,
        enabled: false
      }
    });
    expect(disableFreezesReply.ok).toBe(true);

    const appendWhileDisabledReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-append-disabled',
      action: 'frontend.setConstraints',
      payload: {
        documentId: molDoc.id,
        frozenAtoms: [3],
        mode: 'append',
        enabled: false
      }
    });
    expect(appendWhileDisabledReply.ok).toBe(true);
    expect(molDoc.store.getSnapshot().sharedConstraints?.frozenAtomIds).toEqual(['o1', 'h1', 'h2']);

    // Re-enable freezes, then verify single-batch { enabled: false, coordinates: [scan on frozen atoms] } succeeds
    await dispatcher.handleRequest({
      requestId: 'p4-r2-reenable',
      action: 'frontend.setConstraints',
      payload: {
        documentId: molDoc.id,
        enabled: true
      }
    });
    const disableAndScanBatch = await dispatcher.handleRequest({
      requestId: 'p4-r2-disable-and-scan',
      action: 'frontend.setConstraints',
      payload: {
        documentId: molDoc.id,
        enabled: false,
        coordinates: [{ type: 'B', atoms: [1, 2], action: 'scan', steps: 4, increment: 0.05 }]
      }
    });
    expect(disableAndScanBatch.ok).toBe(true);

    // Clear constraints before structural edits
    await dispatcher.handleRequest({
      requestId: 'p4-r2-clear-all',
      action: 'frontend.setConstraints',
      payload: {
        documentId: molDoc.id,
        clearFrozenAtoms: true,
        clearCoordinates: true,
        enabled: true
      }
    });

    // 3. set-electronic-state parity validation, revision increment, and Undo restoration
    const badSpinReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-bad-spin',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'set-electronic-state',
        charge: 0,
        multiplicity: 2
      }
    });
    expect(badSpinReply.ok).toBe(false);
    expect(badSpinReply.error?.code).toBe('INVALID_ELECTRONIC_STATE');

    const validSpinReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-good-spin',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'set-electronic-state',
        charge: 1,
        multiplicity: 2
      }
    });
    expect(validSpinReply.ok).toBe(true);
    const spinResult = validSpinReply.result as {
      previousRevision: number;
      revision: number;
      canUndo: boolean;
      document: { charge: number; multiplicity: number };
    };
    expect(spinResult.revision).toBeGreaterThan(spinResult.previousRevision);
    expect(spinResult.canUndo).toBe(true);
    expect(spinResult.document).toMatchObject({ charge: 1, multiplicity: 2 });

    const undoSpinReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-undo-spin',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'undo'
      }
    });
    expect(undoSpinReply.ok).toBe(true);
    expect(molDoc.store.getSnapshot().draft.structure).toMatchObject({ charge: 0, multiplicity: 1 });

    // 4. add-atom WITHOUT anchorAtom (bare 'C' atom, NOT CH4) + clash check + WITH anchorAtom (single-step Undo)
    const bareCarbonReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-bare-c',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'add-atom',
        element: 'C',
        position: [0.0, 0.0, 2.5]
      }
    });
    expect(bareCarbonReply.ok).toBe(true);
    expect(molDoc.store.getSnapshot().draft.structure.atoms.length).toBe(4);
    expect(molDoc.store.getSnapshot().draft.structure.atoms[3]).toMatchObject({
      element: 'C',
      x: 0.0,
      y: 0.0,
      z: 2.5
    });

    const clashAtomReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-clash-atom',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'add-atom',
        element: 'O',
        position: [0.0, 0.0, 0.05]
      }
    });
    expect(clashAtomReply.ok).toBe(false);
    expect(clashAtomReply.error?.code).toBe('MCP_ATOM_POSITION_CLASH');

    const anchoredAtomReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-anchored-o',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'add-atom',
        element: 'O',
        anchorAtom: 4,
        position: [0.0, 0.0, 3.75]
      }
    });
    expect(anchoredAtomReply.ok).toBe(true);
    const afterAnchored = molDoc.store.getSnapshot().draft.structure;
    expect(afterAnchored.atoms.length).toBe(5);
    expect(afterAnchored.atoms[3]).toMatchObject({ element: 'C', x: 0.0, y: 0.0, z: 2.5 });
    expect(afterAnchored.atoms[4]).toMatchObject({ element: 'O', x: 0.0, y: 0.0, z: 3.75 });
    expect(afterAnchored.bonds?.some(b => (b.a === 3 && b.b === 4) || (b.a === 4 && b.b === 3))).toBe(true);

    // Single undo removes both the anchored atom and its bond
    await dispatcher.handleRequest({
      requestId: 'p4-r2-undo-anchored',
      action: 'frontend.editStructure',
      payload: { documentId: molDoc.id, operation: 'undo' }
    });
    expect(molDoc.store.getSnapshot().draft.structure.atoms.length).toBe(4);

    // 5. change-element, 0.5 auxiliary bond + delete-bond, and delete-atoms
    const changeElemReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-change-elem',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'change-element',
        atoms: [4],
        element: 'Si'
      }
    });
    expect(changeElemReply.ok).toBe(true);
    expect(molDoc.store.getSnapshot().draft.structure.atoms[3].element).toBe('Si');

    const auxBondReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-aux-bond',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'set-bond-order',
        atoms: [1, 4],
        order: 0.5
      }
    });
    expect(auxBondReply.ok).toBe(true);
    expect(molDoc.store.getSnapshot().auxiliaryRelations.length).toBe(1);

    const delAuxBondReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-del-aux-bond',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'delete-bond',
        atoms: [1, 4]
      }
    });
    expect(delAuxBondReply.ok).toBe(true);
    expect(molDoc.store.getSnapshot().auxiliaryRelations.length).toBe(0);

    const missingBondReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-missing-bond',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'delete-bond',
        atoms: [1, 4]
      }
    });
    expect(missingBondReply.ok).toBe(false);
    expect(missingBondReply.error?.code).toBe('MCP_BOND_NOT_FOUND');

    const delAtomsReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-del-atoms',
      action: 'frontend.editStructure',
      payload: {
        documentId: molDoc.id,
        operation: 'delete-atoms',
        atoms: [4]
      }
    });
    expect(delAtomsReply.ok).toBe(true);
    expect(molDoc.store.getSnapshot().draft.structure.atoms.length).toBe(3);

    // 6. Periodic cross-cell bond set-bond-order & delete-bond with explicit image: [1, 0, 0]
    const chainDoc = registry.addDocument(
      {
        id: 'struct-chain-p4',
        name: 'CarbonChain',
        format: 'cif',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'c1', element: 'C', x: 0.1, y: 0.0, z: 0.0 },
          { id: 'c2', element: 'C', x: 1.5, y: 0.0, z: 0.0 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }],
        cell: {
          vectors: [
            [2.9, 0, 0],
            [0, 10, 0],
            [0, 0, 10]
          ],
          pbc: [true, true, true]
        }
      },
      'Periodic-Chain'
    );
    const addCrossBond = await dispatcher.handleRequest({
      requestId: 'p4-r2-cross-bond-add',
      action: 'frontend.editStructure',
      payload: {
        documentId: chainDoc.id,
        operation: 'set-bond-order',
        atoms: [2, 1],
        order: 1,
        image: [1, 0, 0]
      }
    });
    expect(addCrossBond.ok).toBe(true);
    expect(chainDoc.store.getSnapshot().draft.structure.bonds?.length).toBe(2);

    // Deleting only the cross-cell [1, 0, 0] bond leaves the home-cell [0, 0, 0] bond intact
    const delCrossBond = await dispatcher.handleRequest({
      requestId: 'p4-r2-cross-bond-del',
      action: 'frontend.editStructure',
      payload: {
        documentId: chainDoc.id,
        operation: 'delete-bond',
        atoms: [2, 1],
        image: [1, 0, 0]
      }
    });
    expect(delCrossBond.ok).toBe(true);
    expect(chainDoc.store.getSnapshot().draft.structure.bonds?.length).toBe(1);
    expect(chainDoc.store.getSnapshot().draft.structure.bonds?.[0].image).toBeUndefined();

    // 7. Live Gaussian & ORCA scan projection round-trips
    // 7a. Gaussian: simulate App.tsx having initialized gaussianBoundCoordinates = []
    const gStructure = molDoc.store.getSnapshot().draft.structure;
    const gSettings = defaultSettings(gStructure);
    molDoc.store.synchronizeGaussianBoundCoordinates?.([], []);

    const gScanReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-gaussian-scan',
      action: 'frontend.setConstraints',
      payload: {
        documentId: molDoc.id,
        coordinates: [{ type: 'B', atoms: [1, 2], action: 'scan', steps: 6, increment: 0.05 }]
      }
    });
    expect(gScanReply.ok).toBe(true);
    const gDocAfter = molDoc.store.getSnapshot();
    const gProjected = projectSessionModel(
      gDocAfter,
      gStructure,
      captureDesktopAssignments(gStructure, gSettings),
      captureGaussianCoordinates(gStructure, gSettings),
      true
    );
    const gIntegrated = integrateDesktopBuilderResult(gStructure, gProjected, gSettings);
    gIntegrated.settings = { ...gIntegrated.settings, task: 'scan' };
    expect(gIntegrated.settings.taskOptions?.coordinates.filter(c => c.action === 'scan')).toHaveLength(1);
    expect(gIntegrated.settings.taskOptions?.coordinates[0]).toMatchObject({
      type: 'B',
      atoms: [1, 2],
      action: 'scan',
      steps: 6,
      increment: 0.05
    });
    expect(captureGaussianCoordinates(gIntegrated.structure, gIntegrated.settings)).toHaveLength(1);

    // 7b. ORCA: switch ModelStore active context to 'orca' and verify ORCA scan formatting (start, end, steps = steps + 1)
    const oSettings = createOrcaCommonSettings('optfreq');
    molDoc.store.synchronizeContext(captureOrcaAssignments(gStructure, oSettings), captureOrcaCoordinates(gStructure, oSettings), 'orca');

    const oScanReply = await dispatcher.handleRequest({
      requestId: 'p4-r2-orca-scan',
      action: 'frontend.setConstraints',
      payload: {
        documentId: molDoc.id,
        coordinates: [{ type: 'B', atoms: [1, 2], action: 'scan', steps: 5, increment: 0.1 }]
      }
    });
    expect(oScanReply.ok).toBe(true);
    const oScanFormatted = (oScanReply.result as {
      constraints: { coordinates: Array<{ steps?: number; start?: number; end?: number }> };
    }).constraints.coordinates[0];
    expect(oScanFormatted.steps).toBe(5);
    expect(oScanFormatted.start).toBeCloseTo(0.96, 4);
    expect(oScanFormatted.end).toBeCloseTo(1.46, 4);

    const oDocAfter = molDoc.store.getSnapshot();
    const oProjected = projectSessionModel(
      oDocAfter,
      gStructure,
      captureOrcaAssignments(gStructure, oSettings),
      captureOrcaCoordinates(gStructure, oSettings),
      true
    );
    const oIntegrated = integrateOrcaBuilderResult(gStructure, oProjected, oSettings);
    oIntegrated.settings = { ...oIntegrated.settings, task: 'scan' };
    expect(oIntegrated.settings.constraints.filter(c => c.action === 'scan')).toHaveLength(1);
    expect(oIntegrated.settings.constraints[0]).toMatchObject({
      type: 'B',
      action: 'scan',
      steps: 6
    });
    expect(captureOrcaCoordinates(oIntegrated.structure, oIntegrated.settings)).toHaveLength(1);

    // 8. Read-only guards on analysisBindingId & conformer collection documents
    const boundDoc = registry.addDocument(
      {
        id: 'struct-bound-p4',
        name: 'BoundResult',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'b1', element: 'H', x: 0, y: 0, z: 0 },
          { id: 'b2', element: 'H', x: 0.74, y: 0, z: 0 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }]
      },
      'Analysis-Bound'
    );
    const boundSnap = boundDoc.store.getSnapshot();
    boundDoc.store.bindAnalysisContext?.('xtb-observation:test', boundSnap.id, boundSnap.revision);

    const blockedEditOnBound = await dispatcher.handleRequest({
      requestId: 'p4-r2-bound-edit',
      action: 'frontend.editStructure',
      payload: {
        documentId: boundDoc.id,
        operation: 'set-geometry',
        coordinate: 'B',
        atoms: [1, 2],
        value: 0.85
      }
    });
    expect(blockedEditOnBound.ok).toBe(false);
    expect(blockedEditOnBound.error?.code).toBe('MCP_READ_ONLY_RESULT');

    const blockedScanOnBound = await dispatcher.handleRequest({
      requestId: 'p4-r2-bound-scan',
      action: 'frontend.setConstraints',
      payload: {
        documentId: boundDoc.id,
        coordinates: [{ type: 'B', atoms: [1, 2], action: 'scan', steps: 3, increment: 0.05 }]
      }
    });
    expect(blockedScanOnBound.ok).toBe(false);
    expect(blockedScanOnBound.error?.code).toBe('MCP_READ_ONLY_RESULT');

    // Conformer collection tab blocks both editStructure and setConstraints
    const conformerCollectionDoc = registry.addDocument(
      {
        id: 'struct-conf-coll-p4',
        name: 'ConformerCollection',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'k1', element: 'H', x: 0, y: 0, z: 0 },
          { id: 'k2', element: 'H', x: 0.74, y: 0, z: 0 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }]
      },
      'Conformer-Collection'
    );
    registry.bindConformerGroup(conformerCollectionDoc.id, 'conf-task-1', 'collection');

    const blockedFreezeOnCollection = await dispatcher.handleRequest({
      requestId: 'p4-r2-conf-freeze',
      action: 'frontend.setConstraints',
      payload: {
        documentId: conformerCollectionDoc.id,
        frozenAtoms: [1]
      }
    });
    expect(blockedFreezeOnCollection.ok).toBe(false);
    expect(blockedFreezeOnCollection.error?.code).toBe('MCP_READ_ONLY_RESULT');
  });

  it('recommends quantum chemistry methods/bases/solvents and configures Gaussian (.gjf) & ORCA (.inp) calculations with constraints and draft persistence (Phase 5)', async () => {
    const registry = createWorkspaceRegistry();
    const appliedConfigs: Array<{ documentId: string; engine: string; step: number }> = [];
    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => true,
      getCallbacks: () => ({
        applyCalculationConfig: (documentId, configured) => {
          appliedConfigs.push({ documentId, engine: configured.engine, step: configured.step });
        }
      })
    });

    // 1. Add iodomethane (CH3I, contains heavy element I with Z=53 >= 37) and periodic NaCl
    const ch3iDoc = registry.addDocument(
      {
        id: 'struct-ch3i',
        name: 'iodomethane',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'c1', element: 'C', x: 0.0, y: 0.0, z: 0.0 },
          { id: 'i1', element: 'I', x: 2.14, y: 0.0, z: 0.0 },
          { id: 'h1', element: 'H', x: -0.36, y: 1.03, z: 0.0 },
          { id: 'h2', element: 'H', x: -0.36, y: -0.51, z: 0.89 },
          { id: 'h3', element: 'H', x: -0.36, y: -0.51, z: -0.89 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 0, b: 2, order: 1 },
          { a: 0, b: 3, order: 1 },
          { a: 0, b: 4, order: 1 }
        ]
      },
      'CH3I-Model'
    );

    const naclDoc = registry.addDocument(
      {
        id: 'struct-nacl-p5',
        name: 'NaCl',
        format: 'cif',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'na1', element: 'Na', x: 0, y: 0, z: 0 },
          { id: 'cl1', element: 'Cl', x: 2.82, y: 2.82, z: 2.82 }
        ],
        bonds: [],
        cell: {
          vectors: [
            [5.64, 0, 0],
            [0, 5.64, 0],
            [0, 0, 5.64]
          ],
          pbc: [true, true, true]
        }
      },
      'NaCl-Crystal'
    );

    const emptyDoc = registry.addDocument(null, 'Empty-Tab');

    // 2. Test ester_recommend_method on CH3I for NMR (verifies 6-311+G(2d,p) -> def2TZVP auto-upgrade + GenECP + Chinese solvent alias '水')
    const recCh3iReply = await dispatcher.handleRequest({
      requestId: 'p5-rec-1',
      action: 'frontend.recommendMethod',
      payload: {
        documentId: ch3iDoc.id,
        engine: 'both',
        task: 'nmr',
        solvent: '水'
      }
    });
    expect(recCh3iReply.ok).toBe(true);
    const recCh3i = recCh3iReply.result as {
      formula: string;
      heavyEcpElements: string[];
      gaussian: {
        supported: boolean;
        recommended: {
          method: string;
          basis: string;
          requiresGenEcp: boolean;
          basisUpgradedReason?: string;
        };
        solventResolution: { matched: boolean; englishName: string };
      };
      orca: {
        supported: boolean;
        recommended: { method: string; basis: string };
        solventResolution: { matched: boolean; englishName: string };
      };
    };
    expect(recCh3i.formula).toBe('CH3I');
    expect(recCh3i.heavyEcpElements).toEqual(['I']);
    expect(recCh3i.gaussian.recommended.basis).toBe('def2TZVP');
    expect(recCh3i.gaussian.recommended.requiresGenEcp).toBe(true);
    expect(recCh3i.gaussian.recommended.basisUpgradedReason).toContain('6-311+G(2d,p)');
    expect(recCh3i.gaussian.solventResolution.matched).toBe(true);
    expect(recCh3i.gaussian.solventResolution.englishName.toLowerCase()).toBe('water');
    expect(recCh3i.orca.supported).toBe(true);
    expect(recCh3i.orca.solventResolution.matched).toBe(true);

    // 3. Test ester_recommend_method on periodic NaCl crystal -> reports isPeriodic: true & finite-molecule warning
    const recNaclReply = await dispatcher.handleRequest({
      requestId: 'p5-rec-nacl',
      action: 'frontend.recommendMethod',
      payload: {
        documentId: naclDoc.id,
        engine: 'gaussian',
        task: 'sp'
      }
    });
    expect(recNaclReply.ok).toBe(true);
    const recNacl = recNaclReply.result as { isPeriodic: boolean; warnings: string[] };
    expect(recNacl.isPeriodic).toBe(true);
    expect(recNacl.warnings.some(w => w.includes('PBC') || w.includes('周期'))).toBe(true);

    // 4. Set constraints on CH3I (freeze H atom 3 + scan C1-I2 bond), then configure Gaussian calculation
    const setConstReply = await dispatcher.handleRequest({
      requestId: 'p5-const-1',
      action: 'frontend.setConstraints',
      payload: {
        documentId: ch3iDoc.id,
        frozenAtoms: [3],
        coordinates: [
          { type: 'B', atoms: [1, 2], action: 'scan', steps: 5, increment: 0.1 }
        ]
      }
    });
    expect(setConstReply.ok).toBe(true);

    const cfgGaussianReply = await dispatcher.handleRequest({
      requestId: 'p5-cfg-g1',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: ch3iDoc.id,
        engine: 'gaussian',
        settings: {
          method: 'B3LYP',
          basis: 'def2-SVP',
          solventModel: 'smd',
          solvent: 'acetonitrile',
          cores: 16,
          memoryGB: 32,
          name: 'ch3i_scan_job'
        },
        switchToInputView: true,
        generateOutput: true
      }
    });
    expect(cfgGaussianReply.ok).toBe(true);
    const gOut = cfgGaussianReply.result as {
      task: string;
      method: string;
      basis: string;
      valid: boolean;
      validationErrors: string[];
      workflowStep: number;
      fileName: string;
      script: string;
      workbench: { module: string; activeDocumentId: string; taskCenterOpen: boolean };
    };
    // Auto-detected 'scan' task from ModelStore scan coordinate!
    expect(gOut.task).toBe('scan');
    expect(gOut.method).toBe('b3lyp');
    expect(gOut.basis).toBe('def2SVP');
    expect(gOut.valid).toBe(true);
    expect(gOut.validationErrors).toEqual([]);
    expect(gOut.workflowStep).toBe(3);
    expect(gOut.fileName).toBe('ch3i_scan_job.gjf');
    expect(gOut.workbench.module).toBe('input');
    expect(gOut.workbench.activeDocumentId).toBe(ch3iDoc.id);
    expect(gOut.workbench.taskCenterOpen).toBe(false);
    expect(gOut.script).toContain('%nprocshared=16');
    expect(gOut.script).toContain('%mem=32GB');
    expect(gOut.script).toContain('b3lyp/genecp');
    expect(gOut.script).toContain('scrf=(smd,solvent=acetonitrile)');
    // Frozen atom 3 has -1 flag and C1-I2 scan tail is written
    expect(gOut.script).toMatch(/H\s+-1\s+/);
    expect(gOut.script).toContain('B 1 2 S 5 0.1');
    expect(gOut.script).toContain('I 0\ndef2');
    expect(appliedConfigs.at(-1)).toEqual({
      documentId: ch3iDoc.id,
      engine: 'gaussian',
      step: 3
    });

    // Verify saved Gaussian draft passes readProjectInputDrafts cleanly
    const entryAfterGaussian = registry.getSnapshot().documents.find(d => d.id === ch3iDoc.id)!;
    const restoredAfterGaussian = readProjectInputDrafts(
      entryAfterGaussian.drafts,
      entryAfterGaussian.store.getSnapshot()
    );
    expect(restoredAfterGaussian.activeEngine).toBe('gaussian');
    expect(restoredAfterGaussian.gaussian?.jobName).toBe('ch3i_scan_job');

    // 5. Clear scan coordinates, test ORCA r2SCAN-3c Opt with active frozen atom 3, then suspend freezes for DLPNO-CCSD(T) SP
    await dispatcher.handleRequest({
      requestId: 'p5-clear-scan',
      action: 'frontend.setConstraints',
      payload: {
        documentId: ch3iDoc.id,
        clearCoordinates: true
      }
    });

    // Verify ORCA composite r2SCAN-3c Opt works without external basis and includes frozen atom 3 in %geom
    const cfgOrca3cReply = await dispatcher.handleRequest({
      requestId: 'p5-cfg-o2',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: ch3iDoc.id,
        engine: 'orca',
        settings: {
          task: 'opt',
          method: 'r2SCAN-3c'
        }
      }
    });
    expect(cfgOrca3cReply.ok).toBe(true);
    const o3cOut = cfgOrca3cReply.result as { valid: boolean; basis: string; script: string };
    expect(o3cOut.valid).toBe(true);
    expect(o3cOut.basis).toBe('');
    expect(o3cOut.script).toContain('r2SCAN-3c');
    expect(o3cOut.script).toContain('%geom');

    // Verify ORCA SP while atom freezes remain enabled surfaces validationErrors (valid: false) rather than silently ignoring freezes
    const cfgOrcaSpWithFreeze = await dispatcher.handleRequest({
      requestId: 'p5-cfg-o1-warn',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: ch3iDoc.id,
        engine: 'orca',
        settings: {
          task: 'sp',
          method: 'DLPNO-CCSD(T)',
          basis: 'def2-TZVP'
        }
      }
    });
    expect(cfgOrcaSpWithFreeze.ok).toBe(true);
    expect((cfgOrcaSpWithFreeze.result as { valid: boolean; validationErrors: string[] }).valid).toBe(false);
    expect(
      (cfgOrcaSpWithFreeze.result as { validationErrors: string[] }).validationErrors.some(msg =>
        msg.includes('不执行受约束几何优化')
      )
    ).toBe(true);

    // Disable shared freezes for single-point energy calculation, then configure DLPNO-CCSD(T) SP with SMD DMSO
    await dispatcher.handleRequest({
      requestId: 'p5-suspend-freeze',
      action: 'frontend.setConstraints',
      payload: {
        documentId: ch3iDoc.id,
        enabled: false
      }
    });

    const cfgOrcaSpReply = await dispatcher.handleRequest({
      requestId: 'p5-cfg-o1',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: ch3iDoc.id,
        engine: 'orca',
        settings: {
          task: 'sp',
          method: 'DLPNO-CCSD(T)',
          basis: 'def2-TZVP',
          solventModel: 'smd',
          solvent: 'DMSO',
          cores: 8,
          memoryGB: 16,
          name: 'ch3i_dlpno_sp'
        }
      }
    });
    expect(cfgOrcaSpReply.ok).toBe(true);
    const oSpOut = cfgOrcaSpReply.result as {
      valid: boolean;
      validationErrors: string[];
      workflowStep: number;
      fileName: string;
      script: string;
    };
    expect(oSpOut.valid).toBe(true);
    expect(oSpOut.workflowStep).toBe(3);
    expect(oSpOut.fileName).toBe('ch3i_dlpno_sp.inp');
    expect(oSpOut.script).toContain('DLPNO-CCSD(T)');
    expect(oSpOut.script).toContain('def2-TZVP');
    expect(oSpOut.script).toContain('def2-TZVP/C');
    expect(oSpOut.script).toContain('%pal nprocs 8 end');
    expect(oSpOut.script).toContain('%maxcore 1536');
    expect(oSpOut.script).toContain('smd true');

    // Verify readProjectInputDrafts now restores activeEngine === 'orca' even though gaussian draft also exists!
    const entryAfterOrca = registry.getSnapshot().documents.find(d => d.id === ch3iDoc.id)!;
    const restoredAfterOrca = readProjectInputDrafts(
      entryAfterOrca.drafts,
      entryAfterOrca.store.getSnapshot()
    );
    expect(restoredAfterOrca.activeEngine).toBe('orca');
    expect(restoredAfterOrca.orca?.name).toBe('ch3i_dlpno_sp');

    // Reject explicit def2-SVP basis on r2SCAN-3c composite method
    const bad3cBasis = await dispatcher.handleRequest({
      requestId: 'p5-cfg-bad-3c-basis',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: ch3iDoc.id,
        engine: 'orca',
        settings: {
          task: 'opt',
          method: 'r2SCAN-3c',
          basis: 'def2-SVP'
        }
      }
    });
    expect(bad3cBasis.ok).toBe(false);
    expect(bad3cBasis.error?.code).toBe('INVALID_BASIS');

    // 6. Verify error boundaries: periodic structure, empty structure, unknown method/solvent, read-only & analysisBindingId
    registry.setModule('modeling');
    const periodicCfgFail = await dispatcher.handleRequest({
      requestId: 'p5-cfg-periodic-fail',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: naclDoc.id,
        engine: 'gaussian',
        settings: { task: 'sp' }
      }
    });
    expect(periodicCfgFail.ok).toBe(false);
    expect(periodicCfgFail.error?.code).toBe('MCP_STRUCTURE_IS_PERIODIC');
    // Atomic failure: module stayed 'modeling'
    expect(registry.getSnapshot().module).toBe('modeling');

    const emptyCfgFail = await dispatcher.handleRequest({
      requestId: 'p5-cfg-empty-fail',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: emptyDoc.id,
        engine: 'gaussian'
      }
    });
    expect(emptyCfgFail.ok).toBe(false);
    expect(emptyCfgFail.error?.code).toBe('MCP_EMPTY_STRUCTURE');

    const badMethodFail = await dispatcher.handleRequest({
      requestId: 'p5-cfg-bad-method',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: ch3iDoc.id,
        engine: 'gaussian',
        settings: { method: 'nonexistent-dft-99' }
      }
    });
    expect(badMethodFail.ok).toBe(false);
    expect(badMethodFail.error?.code).toBe('INVALID_METHOD');

    const badSolventFail = await dispatcher.handleRequest({
      requestId: 'p5-cfg-bad-solvent',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: ch3iDoc.id,
        engine: 'gaussian',
        settings: { solvent: 'liquid-kryptonite' }
      }
    });
    expect(badSolventFail.ok).toBe(false);
    expect(badSolventFail.error?.code).toBe('INVALID_SOLVENT');

    // Conformer collection tab blocks ester_configure_calculation with MCP_READ_ONLY_RESULT
    const confCollection = registry.addDocument(
      {
        id: 'struct-conf-p5',
        name: 'ConfColl',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'x1', element: 'H', x: 0, y: 0, z: 0 },
          { id: 'x2', element: 'H', x: 0.74, y: 0, z: 0 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }]
      },
      'Conf-Coll-P5'
    );
    registry.bindConformerGroup(confCollection.id, 'task-conf-p5', 'collection');
    const confFail = await dispatcher.handleRequest({
      requestId: 'p5-cfg-conf-fail',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: confCollection.id,
        engine: 'gaussian'
      }
    });
    expect(confFail.ok).toBe(false);
    expect(confFail.error?.code).toBe('MCP_READ_ONLY_RESULT');

    // 7. Verify switchToInputView: false on a fresh modeling document preserves draft when later switching to 'input' module!
    const h2Doc = registry.addDocument(
      {
        id: 'struct-h2-bg-p5',
        name: 'Hydrogen',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'h_a', element: 'H', x: 0, y: 0, z: 0 },
          { id: 'h_b', element: 'H', x: 0.74, y: 0, z: 0 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }]
      },
      'H2-Background'
    );
    registry.setModule('modeling');
    const bgCfgReply = await dispatcher.handleRequest({
      requestId: 'p5-cfg-bg',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: h2Doc.id,
        engine: 'gaussian',
        settings: {
          task: 'sp',
          method: 'm062x',
          basis: 'def2TZVP',
          name: 'h2_bg_sp'
        },
        switchToInputView: false
      }
    });
    expect(bgCfgReply.ok).toBe(true);
    expect(registry.getSnapshot().module).toBe('modeling');
    // Now user switches to 'input' module -> draft MUST NOT be wiped by ensureInputTaskInternal!
    registry.setModule('input');
    const h2EntryAfterNav = registry.getSnapshot().documents.find(d => d.id === h2Doc.id)!;
    const h2Restored = readProjectInputDrafts(h2EntryAfterNav.drafts, h2EntryAfterNav.store.getSnapshot());
    expect(h2Restored.gaussian?.jobName).toBe('h2_bg_sp');
  });

  it('handles Phase 5 cross-engine scan conversion, actinide/lanthanide recommendations, atomic store rollback, analysisBindingId/result/busy guards, and injection sanitization', async () => {
    const registry = createWorkspaceRegistry();
    let simulateBusy = false;
    let switchedViewDocId: string | null = null;
    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => false,
      getCallbacks: () => ({
        assertCalculationConfigurable: () => {
          if (simulateBusy) {
            throw Object.assign(new Error('Simulated busy input controller'), {
              code: 'MCP_DOCUMENT_BUSY'
            });
          }
        },
        switchToConfiguredInputView: docId => {
          switchedViewDocId = docId;
          const view = registry.getSnapshot().views.find(v => v.documentId === docId);
          if (view) registry.activate(view.id);
          registry.setModule('input');
        }
      })
    });

    // 1. Cross-engine scan conversion: fresh doc (gaussian scope) -> setConstraints(scan) -> configureCalculation(orca) -> setConstraints(scan) -> configureCalculation(gaussian)
    const hfDoc = registry.addDocument(
      {
        id: 'struct-hf-scan',
        name: 'HydrogenFluoride',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'h1', element: 'H', x: 0, y: 0, z: 0 },
          { id: 'f1', element: 'F', x: 0.92, y: 0, z: 0 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }]
      },
      'HF-Scan'
    );

    await dispatcher.handleRequest({
      requestId: 'p5-r2-scan-1',
      action: 'frontend.setConstraints',
      payload: {
        documentId: hfDoc.id,
        coordinates: [{ type: 'B', atoms: [1, 2], action: 'scan', steps: 5, increment: 0.1 }]
      }
    });

    const orcaFromGaussianScan = await dispatcher.handleRequest({
      requestId: 'p5-r2-orca-scan',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: hfDoc.id,
        engine: 'orca',
        settings: {
          method: 'B3LYP',
          basis: 'def2-SVP'
        }
      }
    });
    expect(orcaFromGaussianScan.ok).toBe(true);
    const orcaScanOut = orcaFromGaussianScan.result as {
      task: string;
      valid: boolean;
      script: string;
    };
    expect(orcaScanOut.task).toBe('scan');
    expect(orcaScanOut.valid).toBe(true);
    expect(orcaScanOut.script).toContain('Scan');
    // 5 intervals -> 6 ORCA scan points
    expect(orcaScanOut.script).toMatch(/B 0 1 = 0\.92,\s*1\.42,\s*6/);
    expect(switchedViewDocId).toBe(hfDoc.id);

    // Now contextScope is 'orca': set a 4-interval scan (stored as 5 ORCA points), then configure Gaussian -> must emit 4 intervals (not 5!)
    await dispatcher.handleRequest({
      requestId: 'p5-r2-scan-2',
      action: 'frontend.setConstraints',
      payload: {
        documentId: hfDoc.id,
        coordinates: [{ type: 'B', atoms: [1, 2], action: 'scan', steps: 4, increment: 0.08 }]
      }
    });

    const gaussianFromOrcaScan = await dispatcher.handleRequest({
      requestId: 'p5-r2-gaussian-scan',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: hfDoc.id,
        engine: 'gaussian',
        settings: {
          method: 'B3LYP',
          basis: 'def2-SVP'
        }
      }
    });
    expect(gaussianFromOrcaScan.ok).toBe(true);
    const gScanOut = gaussianFromOrcaScan.result as {
      task: string;
      valid: boolean;
      script: string;
    };
    expect(gScanOut.task).toBe('scan');
    expect(gScanOut.valid).toBe(true);
    expect(gScanOut.script).toContain('B 1 2 S 4 0.08');

    // 2. Actinide (UF, Z=92) & Lanthanide (Ce) recommendations
    const ufDoc = registry.addDocument(
      {
        id: 'struct-uf-p5',
        name: 'UF',
        format: 'xyz',
        charge: 0,
        multiplicity: 2,
        notes: [],
        atoms: [
          { id: 'u1', element: 'U', x: 0, y: 0, z: 0 },
          { id: 'f2', element: 'F', x: 2.0, y: 0, z: 0 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }]
      },
      'UF-Actinide'
    );
    const ufRecReply = await dispatcher.handleRequest({
      requestId: 'p5-r2-uf-rec',
      action: 'frontend.recommendMethod',
      payload: {
        documentId: ufDoc.id,
        engine: 'both',
        task: 'opt'
      }
    });
    expect(ufRecReply.ok).toBe(true);
    const ufRec = ufRecReply.result as {
      superheavyElements: string[];
      gaussian: { recommended: { basisSupported: boolean; unsupportedElements: string[] } };
      orca: { recommended: { method: string; basis: string; methodSupported: boolean; methodUpgradedReason?: string } };
    };
    expect(ufRec.superheavyElements).toEqual(['U']);
    expect(ufRec.gaussian.recommended.basisSupported).toBe(false);
    expect(ufRec.gaussian.recommended.unsupportedElements).toEqual(['U']);
    expect(ufRec.orca.recommended.method).toBe('r2scan-3c');
    expect(ufRec.orca.recommended.basis).toBe('');
    expect(ufRec.orca.recommended.methodSupported).toBe(true);
    expect(ufRec.orca.recommended.methodUpgradedReason).toBeTruthy();

    // 3. Atomic ModelStore rollback when configureCalculation fails validation
    const cleanWater = registry.addDocument(
      {
        id: 'struct-clean-water-p5',
        name: 'CleanWater',
        format: 'xyz',
        charge: null,
        multiplicity: null,
        notes: [],
        atoms: [
          { id: 'o1', element: 'O', x: 0, y: 0, z: 0 },
          { id: 'h1', element: 'H', x: 0.96, y: 0, z: 0 },
          { id: 'h2', element: 'H', x: -0.24, y: 0.93, z: 0 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 0, b: 2, order: 1 }
        ]
      },
      'Clean-Water'
    );
    cleanWater.store.markApplied();
    const revBeforeFail = cleanWater.store.getSnapshot().revision;

    const atomicFail = await dispatcher.handleRequest({
      requestId: 'p5-r2-atomic-fail',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: cleanWater.id,
        engine: 'gaussian',
        settings: {
          charge: 1,
          multiplicity: 2,
          method: 'nonexistent-dft-xyz'
        }
      }
    });
    expect(atomicFail.ok).toBe(false);
    expect(atomicFail.error?.code).toBe('INVALID_METHOD');
    const snapAfterFail = cleanWater.store.getSnapshot();
    expect(snapAfterFail.revision).toBe(revBeforeFail);
    expect(snapAfterFail.draft.structure.charge).toBeNull();
    expect(snapAfterFail.draft.structure.multiplicity).toBeNull();
    expect(snapAfterFail.draft.dirty).toBe(false);

    // 4. analysisBindingId document with null q/M: preserves null q/M when omitted, rejects explicit q/M mutation
    const analysisBoundDoc = registry.addDocument(
      {
        id: 'struct-analysis-null-qm',
        name: 'BoundWater',
        format: 'xyz',
        charge: null,
        multiplicity: null,
        notes: [],
        atoms: [
          { id: 'o1', element: 'O', x: 0, y: 0, z: 0 },
          { id: 'h1', element: 'H', x: 0.96, y: 0, z: 0 },
          { id: 'h2', element: 'H', x: -0.24, y: 0.93, z: 0 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 0, b: 2, order: 1 }
        ]
      },
      'Bound-Null-QM'
    );
    const boundSnap0 = analysisBoundDoc.store.getSnapshot();
    analysisBoundDoc.store.bindAnalysisContext?.('analysis:null-qm', boundSnap0.id, boundSnap0.revision);
    const boundRev0 = analysisBoundDoc.store.getSnapshot().revision;

    // Explicit charge: 0 on null-charge analysis-bound doc must be rejected with MCP_READ_ONLY_RESULT
    const boundExplicitChargeFail = await dispatcher.handleRequest({
      requestId: 'p5-r2-bound-charge-fail',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: analysisBoundDoc.id,
        engine: 'gaussian',
        settings: { charge: 0, multiplicity: 1 }
      }
    });
    expect(boundExplicitChargeFail.ok).toBe(false);
    expect(boundExplicitChargeFail.error?.code).toBe('MCP_READ_ONLY_RESULT');

    // Omitting charge/multiplicity configures draft cleanly WITHOUT mutating ModelStore's null q/M or revision!
    const boundCfgOk = await dispatcher.handleRequest({
      requestId: 'p5-r2-bound-ok',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: analysisBoundDoc.id,
        engine: 'gaussian',
        settings: { task: 'sp', method: 'b3lyp', basis: 'def2SVP' }
      }
    });
    expect(boundCfgOk.ok).toBe(true);
    expect(analysisBoundDoc.store.getSnapshot().revision).toBe(boundRev0);
    expect(analysisBoundDoc.store.getSnapshot().draft.structure.charge).toBeNull();

    // 5. Busy guard (MCP_DOCUMENT_BUSY) & read-only TrajectoryResult (entry.result) guard
    simulateBusy = true;
    const busyFail = await dispatcher.handleRequest({
      requestId: 'p5-r2-busy-fail',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: cleanWater.id,
        engine: 'gaussian'
      }
    });
    expect(busyFail.ok).toBe(false);
    expect(busyFail.error?.code).toBe('MCP_DOCUMENT_BUSY');
    simulateBusy = false;

    const roResultDoc = registry.addResultDocument({
      id: 'res-traj-1',
      label: 'ReadOnlyOpt.log',
      engine: 'gaussian',
      kind: 'optimization',
      status: 'completed',
      initialStructure: {
        id: 'ro-s1',
        name: 'RO',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [{ id: 'a1', element: 'He', x: 0, y: 0, z: 0 }],
        bonds: []
      },
      frames: [],
      async getFrame() {
        throw new Error('unused');
      },
      dispose() {}
    });
    const roResultFail = await dispatcher.handleRequest({
      requestId: 'p5-r2-ro-result-fail',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: roResultDoc.id,
        engine: 'gaussian'
      }
    });
    expect(roResultFail.ok).toBe(false);
    expect(roResultFail.error?.code).toBe('MCP_READ_ONLY_RESULT');

    // 6. Adversarial script-injection & nested-field sanitization
    const injectionCases: Array<{ label: string; engine: 'gaussian' | 'orca'; settings: Record<string, unknown>; expectedCode: string }> = [
      {
        label: 'path traversal & newline in Gaussian name',
        engine: 'gaussian',
        settings: { name: '../../evil\n%rwf=/etc/passwd' },
        expectedCode: 'INVALID_CALCULATION_SETTINGS'
      },
      {
        label: 'double-dot in Gaussian checkpointName',
        engine: 'gaussian',
        settings: { checkpointName: 'bad..name.chk' },
        expectedCode: 'INVALID_CALCULATION_SETTINGS'
      },
      {
        label: 'newline / external keyword in Gaussian customMethod',
        engine: 'gaussian',
        settings: { method: 'custom', customMethod: "b3lyp\n#p external='sh'" },
        expectedCode: 'INVALID_METHOD'
      },
      {
        label: 'forbidden external keyword in Gaussian customMethod',
        engine: 'gaussian',
        settings: { method: 'custom', customMethod: 'external' },
        expectedCode: 'INVALID_METHOD'
      },
      {
        label: 'newline in title',
        engine: 'orca',
        settings: { title: 'Mol\n%pal nprocs 99 end' },
        expectedCode: 'INVALID_CALCULATION_SETTINGS'
      },
      {
        label: 'newline injection in Gaussian advanced.scfAlgorithm',
        engine: 'gaussian',
        settings: { advanced: { scfAlgorithm: "xqc\n%rwf=/tmp/pwn" } },
        expectedCode: 'INVALID_CALCULATION_SETTINGS'
      },
      {
        label: 'invalid enum in ORCA optimization.convergence',
        engine: 'orca',
        settings: { optimization: { convergence: 'TightOpt' } },
        expectedCode: 'INVALID_CALCULATION_SETTINGS'
      },
      {
        label: 'string injection in Gaussian irc.maxPoints',
        engine: 'gaussian',
        settings: { task: 'irc', irc: { maxPoints: "20) external='sh'" } },
        expectedCode: 'INVALID_CALCULATION_SETTINGS'
      },
      {
        label: 'non-positive temperatureK in frequency',
        engine: 'orca',
        settings: { frequency: { temperatureK: -10 } },
        expectedCode: 'INVALID_CALCULATION_SETTINGS'
      }
    ];

    for (const tc of injectionCases) {
      const res = await dispatcher.handleRequest({
        requestId: `p5-r2-inj-${tc.label}`,
        action: 'frontend.configureCalculation',
        payload: {
          documentId: cleanWater.id,
          engine: tc.engine,
          settings: tc.settings
        }
      });
      expect(res.ok, tc.label).toBe(false);
      expect(res.error?.code, tc.label).toBe(tc.expectedCode);
    }

    // 7. Verify copyForModeling + setDraft(..., false) emits updated inputTask snapshot cleanly
    await dispatcher.handleRequest({
      requestId: 'p5-r2-seed-water',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: cleanWater.id,
        engine: 'gaussian',
        settings: { task: 'sp', name: 'water_copy_seed' }
      }
    });
    const waterEntry = registry.getSnapshot().documents.find(d => d.id === cleanWater.id)!;
    registry.setDraft(cleanWater.id, 'gaussian', waterEntry.drafts.gaussian!, false);
    const copiedChild = registry.copyForModeling(registry.stamp());
    const childView = registry.getSnapshot().views.find(v => v.documentId === copiedChild.id)!;
    registry.activate(childView.id);
    expect(registry.getSnapshot().inputTask).toBeNull();
    const childEntry = registry.getSnapshot().documents.find(d => d.id === copiedChild.id)!;
    registry.setDraft(copiedChild.id, 'gaussian', childEntry.drafts.gaussian!, false);
    expect(registry.getSnapshot().inputTask?.documentId).toBe(copiedChild.id);
  });
});

describe('Frontend MCP Collaboration Bridge — Phase 6 (Local xTB, Conformer Search, Task Submission & Management)', () => {
  function createMockXtbBridge(options?: {
    onRequest?: (req: XtbRequest, sessionId: string) => void;
    optimizeShiftX?: number;
  }): XtbBridge {
    const listeners = new Set<(event: XtbEvent) => void>();
    const emit = (event: XtbEvent) => {
      for (const fn of [...listeners]) fn(event);
    };

    return {
      async startXtb(request, sessionId = `xtb-sess-${Math.random().toString(36).slice(2, 8)}`) {
        options?.onRequest?.(request, sessionId);
        const calc = request.calculation ?? 'optimize';
        const op = calc === 'singlepoint' ? 'xtb-singlepoint' : 'xtb-optimize';
        const methodNameMap = {
          gfn0: '',
          gfn1: 'GFN1-xTB',
          gfn2: 'GFN2-xTB',
          gfnff: 'GFN-FF'
        } as const;

        setTimeout(() => {
          emit({
            schema: 1,
            sessionId,
            stamp: request.stamp,
            ...(request.runIdentity ? { runIdentity: request.runIdentity } : {}),
            operation: op,
            seq: 1,
            method: request.method,
            event: 'started'
          });

          const fixedSet = new Set(request.frozenAtomIds);
          const shiftX = calc === 'optimize' && !request.runIdentity ? (options?.optimizeShiftX ?? 0.04) : 0;
          const finalCoords = request.structure.atoms.map((atom, idx) => ({
            id: atom.id!,
            element: atom.element,
            x: fixedSet.has(atom.id!) || idx > 0 ? atom.x : Number((atom.x + shiftX).toFixed(6)),
            y: atom.y,
            z: atom.z
          }));

          if (calc === 'optimize' && !request.runIdentity) {
            emit({
              schema: 1,
              sessionId,
              stamp: request.stamp,
              operation: op,
              seq: 2,
              method: request.method,
              event: 'frame',
              step: 1,
              stepKind: 'native-log-frame',
              coordinates: finalCoords
            });
          }

          // Compute realistic torsion-dependent energy for n-butane conformer search
          let energyHartree = -5.07045;
          if (request.structure.atoms.length >= 4 && request.structure.atoms.slice(0, 4).every(a => a.element === 'C')) {
            const cIds = request.structure.atoms.slice(0, 4).map(a => a.id!);
            const dihedralDeg = Math.abs(builderCoordinateValue(request.structure, 'D', cIds));
            // anti (~180 deg) is lowest (-13.1950 Eh), gauche (~60 deg) is +0.9 kcal/mol (-13.19356 Eh), eclipsed is higher
            const antiFactor = Math.cos((dihedralDeg * Math.PI) / 180); // -1 at 180, +0.5 at 60
            energyHartree = -13.1938 + 0.0012 * antiFactor;
          }

          const solvationEvidence = request.solvation
            ? {
                model: request.solvation.model,
                solvent: request.solvation.solvent,
                kernel: request.solvation.model === 'alpb' ? ('p16' as const) : ('still' as const),
                referenceState: 'gsolv' as const,
                temperatureKelvin: 298.15 as const,
                parameterSet: `internal ${methodNameMap[request.method]}/${request.solvation.model.toUpperCase()}`,
                sourceField: 'stdout:solvation-model' as const
              }
            : undefined;

          const bondOrders =
            calc === 'singlepoint' || (request.method === 'gfn2' && !request.structure.cell)
              ? {
                  definition: 'mayer-ao' as const,
                  sourceField: 'wbo' as const,
                  threshold: 0.1 as const,
                  entries:
                    request.structure.atoms.length >= 2
                      ? [
                          {
                            atomIds: [request.structure.atoms[0].id!, request.structure.atoms[1].id!] as [string, string],
                            value: 0.962
                          }
                        ]
                      : []
                }
              : undefined;

          emit({
            schema: 1,
            sessionId,
            stamp: request.stamp,
            ...(request.runIdentity ? { runIdentity: request.runIdentity } : {}),
            operation: op,
            seq: calc === 'optimize' && !request.runIdentity ? 3 : 2,
            method: request.method,
            event: 'completed',
            ...(request.runIdentity ? { diagnosticDirectory: `/tmp/xtb-diag-${sessionId}` } : {}),
            coordinates: finalCoords,
            metadata: {
              converged: true,
              ...(calc === 'singlepoint'
                ? { sccIterations: 8, sccIterationLimit: request.maxSccIterations ?? 250 }
                : { iterations: 6 }),
              energyHartree,
              energyUnit: 'hartree',
              coordinateUnit: 'angstrom',
              engine: 'xtb',
              version: '6.7.1',
              method: request.method,
              charge: request.charge,
              uhf: request.method === 'gfnff' ? null : (request.uhf ?? 0),
              spinTreatment: 'restricted',
              threads: request.threads ?? 1,
              maxSteps: request.maxSteps ?? 500,
              ...(request.maxWallTimeSeconds !== undefined ? { maxWallTimeSeconds: request.maxWallTimeSeconds } : {}),
              frozenAtomIds: [...request.frozenAtomIds],
              internalConstraintMode: request.constraints.length ? 'native-harmonic' : 'none',
              internalConstraints: request.constraints.map(row => {
                const target = row.value ?? builderCoordinateValue(request.structure, row.type, row.atomIds);
                return {
                  ...row,
                  target,
                  actual: target,
                  residual: 0,
                  unit: row.type === 'B' ? ('angstrom' as const) : ('degree' as const),
                  mode: 'native-harmonic' as const
                };
              }),
              calculation: calc,
              ...(solvationEvidence ? { solvation: solvationEvidence } : {}),
              ...(bondOrders ? { bondOrders } : {})
            },
            exit: { code: 0, signal: null }
          });
        }, 2);

        return { sessionId };
      },
      async commandXtb(sessionId) {
        return { sessionId, status: 'stopped' };
      },
      onXtbEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
  }

  it('executes ester_run_local_xtb (singlepoint, optimize, conformer-search) with implicit solvation and enforces scientific guards', async () => {
    // 1. Unit-test resolveXtbSolvation alias resolution & method/model/periodic guards
    expect(
      resolveXtbSolvation({
        calculation: 'optimize',
        method: 'gfn2',
        solvent: '水',
        isPeriodic: false
      })
    ).toEqual({ model: 'alpb', solvent: 'water' });
    expect(
      resolveXtbSolvation({
        calculation: 'optimize',
        method: 'gfn1',
        solvent: 'dcm',
        solvationModel: 'gbsa',
        isPeriodic: false
      })
    ).toEqual({ model: 'gbsa', solvent: 'ch2cl2' });
    expect(
      resolveXtbSolvation({
        calculation: 'singlepoint',
        method: 'gfn2',
        solvent: 'gas',
        isPeriodic: false
      })
    ).toBeUndefined();
    expect(() =>
      resolveXtbSolvation({
        calculation: 'optimize',
        method: 'gfn0',
        solvent: 'water',
        isPeriodic: false
      })
    ).toThrow(/GFN0-xTB/);
    expect(() =>
      resolveXtbSolvation({
        calculation: 'optimize',
        method: 'gfnff',
        solvent: 'water',
        solvationModel: 'gbsa',
        isPeriodic: false
      })
    ).toThrow(/ALPB/);
    expect(() =>
      resolveXtbSolvation({
        calculation: 'conformer-search',
        method: 'gfn2',
        solvent: 'water',
        solvationModel: 'gbsa',
        isPeriodic: false
      })
    ).toThrow(/ALPB/);
    expect(() =>
      resolveXtbSolvation({
        calculation: 'optimize',
        method: 'gfn2',
        solvent: 'water',
        isPeriodic: true
      })
    ).toThrow(/周期/);

    // 2. Verify XtbController forwards solvation and respects rebuildBonds: false on singlepoint
    const registry = createWorkspaceRegistry();
    const capturedRequests: XtbRequest[] = [];
    let perceiveCalls = 0;
    const mockXtbBridge = createMockXtbBridge({
      onRequest: req => capturedRequests.push(req),
      optimizeShiftX: 0.05
    });

    const waterDoc = registry.addDocument(
      {
        id: 'struct-water-p6',
        name: 'Water',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'o1', element: 'O', x: 0, y: 0, z: 0 },
          { id: 'h1', element: 'H', x: 0.96, y: 0, z: 0 },
          { id: 'h2', element: 'H', x: -0.24, y: 0.93, z: 0 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 0, b: 2, order: 1 }
        ]
      },
      'Water-P6'
    );
    const waterEntry = registry.getSnapshot().documents.find(d => d.id === waterDoc.id)!;

    // Direct XtbController check for rebuildBonds: false on singlepoint
    const directCtrl = new XtbController({
      store: waterEntry.store,
      bridge: mockXtbBridge,
      chemistry: {
        isSupported: () => true,
        generate3D() { throw new Error('unused'); },
        optimize() { throw new Error('unused'); },
        convert() { throw new Error('unused'); },
        perceiveBonds(structure) {
          perceiveCalls++;
          return {
            promise: Promise.resolve({
              operation: 'perceive-bonds' as const,
              engine: 'RDKit',
              structure,
              warnings: []
            }),
            cancel: () => {}
          };
        }
      },
      allowWorkingEdits: true,
      confirmConstraints: () => true,
      assertCurrent: () => {}
    });
    await directCtrl.run(
      {
        method: 'gfn2',
        charge: 0,
        multiplicity: 1,
        rebuildBonds: false,
        solvation: { model: 'alpb', solvent: 'water' }
      },
      'singlepoint'
    );
    expect(perceiveCalls).toBe(0);
    expect(capturedRequests.at(-1)?.solvation).toEqual({ model: 'alpb', solvent: 'water' });
    directCtrl.disconnect();

    let taskCenterOpen = true;
    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      getDesktop: () => mockXtbBridge as unknown as DesktopBridge,
      isTaskCenterOpen: () => taskCenterOpen,
      getCallbacks: () => ({
        setTaskCenterOpen: open => { taskCenterOpen = open; }
      })
    });

    // 3. MCP singlepoint via frontend.runLocalXtb
    const spReply = await dispatcher.handleRequest({
      requestId: 'p6-xtb-sp',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: waterDoc.id,
        calculation: 'singlepoint',
        method: 'gfn2',
        solvent: '水',
        rebuildBonds: false
      }
    });
    expect(spReply.ok).toBe(true);
    const spOut = spReply.result as {
      status: string;
      converged: boolean;
      sccIterations: number;
      energyHartree: number;
      energyKcalMol: number;
      wibergBondOrders: Array<{ atom1Index: number; atom2Index: number; order: number }>;
      workbench: { taskCenterOpen: boolean; module: string };
    };
    expect(spOut.converged).toBe(true);
    expect(spOut.sccIterations).toBe(8);
    expect(spOut.energyHartree).toBeCloseTo(-5.07045, 5);
    expect(spOut.wibergBondOrders.length).toBe(1);
    expect(spOut.wibergBondOrders[0].order).toBeCloseTo(0.962, 3);
    expect(spOut.workbench.taskCenterOpen).toBe(false);
    expect(spOut.workbench.module).toBe('modeling');
    expect(waterEntry.store.getSnapshot().draft.structure.atoms[0].x).toBe(0);

    // 4. MCP optimize via frontend.runLocalXtb updates coordinates & clears runtime lock
    const optReply = await dispatcher.handleRequest({
      requestId: 'p6-xtb-opt',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: waterDoc.id,
        calculation: 'optimize',
        method: 'gfn2',
        solvent: 'dcm',
        solvationModel: 'gbsa',
        maxSteps: 120,
        rebuildBonds: false
      }
    });
    expect(optReply.ok).toBe(true);
    const optOut = optReply.result as {
      converged: boolean;
      iterations: number;
      solvation: { model: string; solvent: string };
    };
    expect(optOut.converged).toBe(true);
    expect(optOut.iterations).toBe(6);
    expect(optOut.solvation).toMatchObject({ model: 'gbsa', solvent: 'ch2cl2', kernel: 'still' });
    expect(waterEntry.store.getSnapshot().draft.structure.atoms[0].x).toBeCloseTo(0.05, 5);
    expect(waterEntry.store.isRuntimeSessionActive?.()).toBe(false);

    // 5. Rigid H2O rejects conformer-search with MCP_NO_ROTATABLE_TORSIONS
    const rigidConfReply = await dispatcher.handleRequest({
      requestId: 'p6-xtb-conf-rigid',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: waterDoc.id,
        calculation: 'conformer-search',
        method: 'gfn2'
      }
    });
    expect(rigidConfReply.ok).toBe(false);
    expect(rigidConfReply.error?.code).toBe('MCP_NO_ROTATABLE_TORSIONS');

    // 6. Real conformer-search on n-butane (C4H10, 14 atoms, central rotatable C2-C3 single bond)
    const butaneDoc = registry.addDocument(
      {
        id: 'struct-butane-p6',
        name: 'n-Butane',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'c1', element: 'C', x: -1.911, y: -0.531, z: 0.000 },
          { id: 'c2', element: 'C', x: -0.521, y: 0.104, z: 0.000 },
          { id: 'c3', element: 'C', x: 0.521, y: -0.104, z: 1.102 },
          { id: 'c4', element: 'C', x: 1.911, y: 0.531, z: 1.102 },
          { id: 'h1', element: 'H', x: -2.658, y: 0.268, z: 0.000 },
          { id: 'h2', element: 'H', x: -2.063, y: -1.152, z: 0.888 },
          { id: 'h3', element: 'H', x: -2.063, y: -1.152, z: -0.888 },
          { id: 'h4', element: 'H', x: -0.618, y: 1.194, z: -0.056 },
          { id: 'h5', element: 'H', x: -0.025, y: -0.228, z: -0.917 },
          { id: 'h6', element: 'H', x: 0.618, y: -1.194, z: 1.158 },
          { id: 'h7', element: 'H', x: 0.025, y: 0.228, z: 2.019 },
          { id: 'h8', element: 'H', x: 2.658, y: -0.268, z: 1.102 },
          { id: 'h9', element: 'H', x: 2.063, y: 1.152, z: 0.214 },
          { id: 'h10', element: 'H', x: 2.063, y: 1.152, z: 1.990 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 1, b: 2, order: 1 },
          { a: 2, b: 3, order: 1 },
          { a: 0, b: 4, order: 1 },
          { a: 0, b: 5, order: 1 },
          { a: 0, b: 6, order: 1 },
          { a: 1, b: 7, order: 1 },
          { a: 1, b: 8, order: 1 },
          { a: 2, b: 9, order: 1 },
          { a: 2, b: 10, order: 1 },
          { a: 3, b: 11, order: 1 },
          { a: 3, b: 12, order: 1 },
          { a: 3, b: 13, order: 1 }
        ]
      },
      'Butane-P6'
    );

    const confReply = await dispatcher.handleRequest({
      requestId: 'p6-xtb-conf-butane',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: butaneDoc.id,
        calculation: 'conformer-search',
        method: 'gfn2',
        solvent: 'water',
        solvationModel: 'alpb',
        maxCandidates: 6,
        pointsPerTorsion: 3,
        maxSteps: 80
      }
    });
    expect(confReply.ok).toBe(true);
    const confOut = confReply.result as {
      calculation: string;
      rotatableTorsionCount: number;
      sampledCandidateCount: number;
      optimizedCount: number;
      clusterCount: number;
      lowestEnergyHartree: number;
      conformers: Array<{
        rank: number;
        energyHartree: number;
        relativeEnergyKcalMol: number;
        memberCount: number;
      }>;
      lowestConformerAtoms: Array<{ index: number; element: string }>;
    };
    expect(confOut.calculation).toBe('conformer-search');
    expect(confOut.rotatableTorsionCount).toBeGreaterThanOrEqual(1);
    expect(confOut.sampledCandidateCount).toBeGreaterThanOrEqual(2);
    expect(confOut.optimizedCount).toBeGreaterThanOrEqual(2);
    expect(confOut.clusterCount).toBeGreaterThanOrEqual(1);
    expect(confOut.lowestConformerAtoms).toHaveLength(14);
    expect(confOut.conformers[0].rank).toBe(1);
    expect(confOut.conformers[0].relativeEnergyKcalMol).toBeCloseTo(0, 6);
    for (let i = 1; i < confOut.conformers.length; i++) {
      expect(confOut.conformers[i].relativeEnergyKcalMol).toBeGreaterThanOrEqual(
        confOut.conformers[i - 1].relativeEnergyKcalMol
      );
    }

    // 7. Active scan coordinate blocks xTB optimize with MCP_XTB_SCAN_UNSUPPORTED
    await dispatcher.handleRequest({
      requestId: 'p6-set-scan',
      action: 'frontend.setConstraints',
      payload: {
        documentId: waterDoc.id,
        coordinates: [{ type: 'B', atoms: [1, 2], action: 'scan', steps: 4, increment: 0.05 }]
      }
    });
    const scanOptFail = await dispatcher.handleRequest({
      requestId: 'p6-xtb-scan-fail',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: waterDoc.id,
        calculation: 'optimize',
        method: 'gfn2'
      }
    });
    expect(scanOptFail.ok).toBe(false);
    expect(scanOptFail.error?.code).toBe('MCP_XTB_SCAN_UNSUPPORTED');
  });

  it('executes ester_submit_task & ester_task_manage with resource overrides, ambiguity/preview guards, log tail slicing, and safe preview release', async () => {
    // 1. Unit-test applySubmissionDraftOverrides for Gaussian & ORCA resource overrides
    const gPatched = applySubmissionDraftOverrides(
      {
        engineId: 'gaussian',
        inputName: 'mol.gjf',
        suggestedName: 'mol',
        finalInputText: '%nprocshared=4\n%mem=8GB\n#p opt b3lyp/def2svp\n\ntitle\n\n0 1\nH 0 0 0\nH 0 0 0.74\n\n',
        dependencies: []
      },
      { taskName: 'mol_high_mem', cores: 16, memoryGB: 1.5 }
    );
    expect(gPatched.suggestedName).toBe('mol_high_mem');
    expect(gPatched.finalInputText).toContain('%nprocshared=16');
    expect(gPatched.finalInputText).toContain('%mem=1536MB');

    const oPatched = applySubmissionDraftOverrides(
      {
        engineId: 'orca',
        inputName: 'mol.inp',
        suggestedName: 'mol',
        finalInputText: '! B3LYP D3BJ def2-SVP Opt\n%pal nprocs 4 end\n%maxcore 1000\n* xyz 0 1\nH 0 0 0\nH 0 0 0.74\n*\n',
        dependencies: []
      },
      { cores: 8, memoryGB: 16 }
    );
    expect(oPatched.finalInputText).toContain('%pal nprocs 8 end');
    // 16 * (768 / 8) = 1536 MB per core
    expect(oPatched.finalInputText).toContain('%maxcore 1536');

    // 2. Setup WorkspaceRegistry & mock TaskSystemBridge (using authentic bridge.request protocol)
    const registry = createWorkspaceRegistry();
    const h2Doc = registry.addDocument(
      {
        id: 'struct-h2-submit',
        name: 'Hydrogen',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'ha', element: 'H', x: 0, y: 0, z: 0 },
          { id: 'hb', element: 'H', x: 0.74, y: 0, z: 0 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }]
      },
      'H2-Submit'
    );
    const twoDDoc = registry.addDocument(
      {
        id: 'struct-2d-submit',
        name: 'Benzene2D',
        format: 'mol',
        dimension: 2,
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [{ id: 'c2d', element: 'C', x: 0, y: 0, z: 0 }],
        bonds: []
      },
      'Benzene-2D'
    );

    let taskCenterOpen = false;
    const openedDialogs: Array<{ documentId: string; draft: ExternalInputDraft; options?: { environmentId?: string; displayName?: string } }> = [];
    const openedCenterTaskIds: string[] = [];
    const trackedOperations: string[] = [];
    const releasedSourceRefs: string[] = [];
    const releasedPreviewOwners: string[] = [];
    const centerEnters: string[] = [];
    const centerLeaves: string[] = [];

    const mockEnvironments = [
      {
        environmentId: 'env-orca-local',
        displayName: 'Local macOS ORCA 6',
        engineId: 'orca',
        connectionKind: 'local',
        schedulerKind: 'direct',
        workingRoot: '/tmp/orca-local',
        check: { state: 'passed', checkedAt: '2026-11-10T09:00:00Z', version: { value: '6.0.1' } }
      },
      {
        environmentId: 'env-orca-cluster',
        displayName: 'Cluster Slurm ORCA 6',
        engineId: 'orca',
        connectionKind: 'ssh',
        schedulerKind: 'slurm',
        host: '10.0.0.21',
        port: 22,
        user: 'chem',
        privateKeySecret: 'NEVER_LEAK_ME',
        workingRoot: '/scratch/chem/orca',
        partition: 'cpu',
        timeLimit: '24:00:00'
      },
      {
        environmentId: 'env-g16-ssh',
        displayName: 'Server Gaussian 16',
        engineId: 'gaussian',
        connectionKind: 'ssh',
        schedulerKind: 'slurm',
        host: '10.0.0.22',
        port: 22,
        user: 'chem',
        workingRoot: '/scratch/chem/g16'
      }
    ];

    const mockTasks = [
      {
        taskId: 'task-900',
        runId: 'run-900',
        displayName: 'H2 Opt',
        engineId: 'orca',
        taskKind: 'opt',
        formula: 'H2',
        environmentId: 'env-orca-cluster',
        environmentName: 'Cluster Slurm ORCA 6',
        connectionKind: 'ssh',
        schedulerKind: 'slurm',
        executionState: 'running',
        verificationState: 'pending',
        archived: false,
        recycled: false,
        stopControl: { canRequest: true },
        workPath: '/scratch/chem/orca/task-900',
        archivePath: '/Users/test/Tasks/task-900',
        createdAt: '2026-11-10T10:00:00Z'
      },
      {
        taskId: 'task-899',
        runId: 'run-899',
        displayName: 'Water SP',
        engineId: 'gaussian',
        taskKind: 'sp',
        formula: 'H2O',
        environmentId: 'env-g16-ssh',
        environmentName: 'Server Gaussian 16',
        connectionKind: 'ssh',
        schedulerKind: 'slurm',
        executionState: 'ended',
        verificationState: 'verified',
        archived: false,
        recycled: false,
        workPath: '/scratch/chem/g16/task-899',
        archivePath: '/Users/test/Tasks/task-899',
        createdAt: '2026-11-10T09:00:00Z'
      }
    ];

    let mockRestrictions: string[] = [];
    const buildCenterView = () => ({
      library: { libraryId: 'lib-1', path: '/Users/test/Tasks' },
      manager: { access: 'manager' },
      environments: mockEnvironments,
      tasks: mockTasks
    });
    const buildDetailView = (taskId: string) => ({
      task: mockTasks.find(t => t.taskId === taskId) ?? mockTasks[0],
      stage: 'Geometry Optimization',
      iteration: 3,
      elapsedSeconds: 42,
      updatedAt: '2026-11-10T10:01:00Z',
      scientificStates: [{ key: 'opt', label: '几何收敛', state: 'in-progress', jobIndex: 1 }],
      notices: [],
      files: [
        { artifactId: 'art-inp', name: 'h2.inp', role: 'input', size: 120, kind: 'text', exists: true, readable: true },
        { artifactId: 'art-out', name: 'h2.out', role: 'primary-output', size: 4096, kind: 'text', exists: true, readable: true },
        { artifactId: 'art-gbw', name: 'h2.gbw', role: 'wavefunction', size: 65536, kind: 'binary', exists: true, readable: true }
      ]
    });

    const mockTaskBridge = {
      subscribe: () => () => {},
      request: async (channel: string, payload: Record<string, unknown>) => {
        switch (channel) {
          case 'center.read':
            return buildCenterView();
          case 'center.enter':
            centerEnters.push(String(payload.entryId));
            return buildCenterView();
          case 'center.leave':
            centerLeaves.push(String(payload.entryId));
            return { left: true };
          case 'submission.stage-begin':
            return { token: `stg-${String(payload.name)}` };
          case 'submission.stage-append':
            return { receivedBytes: Number(payload.offset) + (payload.bytes as Uint8Array).byteLength };
          case 'submission.stage-finish':
            return {
              name: String(payload.token).replace(/^stg-/, ''),
              role: 'companion',
              sourceRef: `ref-${String(payload.token)}`
            };
          case 'submission.release-dependencies':
            releasedSourceRefs.push(...((payload.sourceRefs as string[]) ?? []));
            return { released: true };
          case 'submission.preview':
            return {
              restrictions: mockRestrictions,
              suggestedDisplayName: (payload.displayName as string) || 'H2 Opt',
              submissionPlanId: 'sub-plan-900',
              workingPath: '/scratch/chem/orca/task-900',
              archivePath: '/Users/test/Tasks/task-900'
            };
          case 'submission.submit':
            return {
              taskId: 'task-900',
              runId: 'run-900',
              operationId: 'op-sub-900'
            };
          case 'task.details':
            return buildDetailView(String(payload.taskId));
          case 'monitor.read':
            return {
              ...buildDetailView(String(payload.taskId)),
              prepared: true,
              frameCount: 3,
              cards: [
                {
                  kind: 'energy',
                  title: 'SCF / Optimization Energy',
                  sourceLabel: 'h2.out',
                  columns: ['Step', 'Energy (Eh)'],
                  rows: [
                    ['1', '-1.1600'],
                    ['2', '-1.1655'],
                    ['3', '-1.1684']
                  ],
                  plot: {
                    xLabel: 'Step',
                    yLabel: 'Energy (Eh)',
                    series: [
                      {
                        id: 'total-energy',
                        label: 'Total Energy',
                        points: [
                          { x: 1, y: -1.1600 },
                          { x: 2, y: -1.1655 },
                          { x: 3, y: -1.1684 }
                        ]
                      }
                    ]
                  }
                }
              ]
            };
          case 'preview.read':
            return {
              artifactId: String(payload.artifactId),
              totalBytes: 128,
              byteStart: 0,
              byteEnd: 128,
              hasBefore: false,
              lines: [
                'ORCASCF Iteration 1: -1.1600',
                'ORCASCF Iteration 2: -1.1655',
                'ORCASCF Iteration 3: -1.1684',
                'HURRAY - OPTIMIZATION CONVERGED',
                ''
              ]
            };
          case 'preview.release':
            releasedPreviewOwners.push(String(payload.ownerId));
            return { released: true };
          case 'operation.plan':
            return {
              planId: 'plan-stop-900',
              items: [{ taskId: (payload.taskIds as string[])[0], eligible: true }]
            };
          case 'operation.execute':
            return { operationId: 'op-stop-900' };
          case 'operation.read':
            return {
              operationId: String(payload.operationId),
              state: 'succeeded',
              phase: 'done',
              items: [{ taskId: 'task-900', outcome: 'stopped', message: 'Slurm scancel succeeded' }]
            };
          default:
            throw new Error(`Unhandled mock task channel: ${channel}`);
        }
      }
    } as unknown as TaskSystemBridge;

    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => taskCenterOpen,
      getCallbacks: () => ({
        setTaskCenterOpen: open => { taskCenterOpen = open; },
        getTaskSystemBridge: () => mockTaskBridge,
        getProjectId: () => 'proj-1',
        openTaskSubmissionDialog: async (documentId, draft, opts) => {
          openedDialogs.push({ documentId, draft, options: opts });
        },
        openSubmittedTaskInCenter: taskId => {
          openedCenterTaskIds.push(taskId);
        },
        trackTaskOperation: opId => {
          trackedOperations.push(opId);
        }
      })
    });

    // 3. Untouched document (step: 0 or empty drafts) rejects with MCP_NO_CONFIGURED_CALCULATION
    const h2Entry = registry.getSnapshot().documents.find(d => d.id === h2Doc.id)!;
    const untouchedFail = await dispatcher.handleRequest({
      requestId: 'p6-sub-untouched',
      action: 'frontend.submitTask',
      payload: { documentId: h2Doc.id }
    });
    expect(untouchedFail.ok).toBe(false);
    expect(untouchedFail.error?.code).toBe('MCP_NO_CONFIGURED_CALCULATION');

    // 2D structure rejects with MCP_2D_STRUCTURE_NOT_READY
    const twoDFail = await dispatcher.handleRequest({
      requestId: 'p6-sub-2d',
      action: 'frontend.submitTask',
      payload: { documentId: twoDDoc.id }
    });
    expect(twoDFail.ok).toBe(false);
    expect(twoDFail.error?.code).toBe('MCP_2D_STRUCTURE_NOT_READY');

    // 4. Configure ORCA Opt on H2, then test open-dialog & auto-submit
    const cfgOrca = await dispatcher.handleRequest({
      requestId: 'p6-cfg-h2-orca',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: h2Doc.id,
        engine: 'orca',
        settings: {
          task: 'opt',
          method: 'r2SCAN-3c',
          cores: 4,
          memoryGB: 8,
          name: 'h2_r2scan_opt'
        }
      }
    });
    expect(cfgOrca.ok).toBe(true);

    // mode="open-dialog" pre-fills environmentId, displayName, and resource overrides
    const openDialogRes = await dispatcher.handleRequest({
      requestId: 'p6-sub-dialog',
      action: 'frontend.submitTask',
      payload: {
        documentId: h2Doc.id,
        mode: 'open-dialog',
        environmentId: 'env-orca-cluster',
        taskName: 'H2 Cluster Opt',
        cores: 12,
        memoryGB: 24
      }
    });
    expect(openDialogRes.ok).toBe(true);
    expect((openDialogRes.result as { submitted: boolean; status: string }).submitted).toBe(false);
    expect((openDialogRes.result as { status: string }).status).toBe('dialog-opened');
    expect(openedDialogs).toHaveLength(1);
    expect(openedDialogs[0].options).toEqual({
      environmentId: 'env-orca-cluster',
      displayName: 'H2 Cluster Opt'
    });
    expect(openedDialogs[0].draft.finalInputText).toContain('%pal nprocs 12 end');
    expect(openedDialogs[0].draft.finalInputText).toContain('%maxcore 1536');

    // mode="auto-submit" WITHOUT environmentId when 2 ORCA environments exist -> MCP_AMBIGUOUS_ENVIRONMENT
    const ambigRes = await dispatcher.handleRequest({
      requestId: 'p6-sub-ambig',
      action: 'frontend.submitTask',
      payload: {
        documentId: h2Doc.id,
        mode: 'auto-submit'
      }
    });
    expect(ambigRes.ok).toBe(false);
    expect(ambigRes.error?.code).toBe('MCP_AMBIGUOUS_ENVIRONMENT');

    // mode="auto-submit" WITH preview restriction -> MCP_SUBMISSION_RESTRICTED
    mockRestrictions = ['environment-unverified'];
    const blockedRes = await dispatcher.handleRequest({
      requestId: 'p6-sub-blocked',
      action: 'frontend.submitTask',
      payload: {
        documentId: h2Doc.id,
        mode: 'auto-submit',
        environmentId: 'env-orca-cluster'
      }
    });
    expect(blockedRes.ok).toBe(false);
    expect(blockedRes.error?.code).toBe('MCP_SUBMISSION_RESTRICTED');

    // Engine/environment mismatch -> MCP_ENGINE_ENVIRONMENT_MISMATCH
    mockRestrictions = [];
    const mismatchRes = await dispatcher.handleRequest({
      requestId: 'p6-sub-mismatch',
      action: 'frontend.submitTask',
      payload: {
        documentId: h2Doc.id,
        mode: 'auto-submit',
        environmentId: 'env-g16-ssh'
      }
    });
    expect(mismatchRes.ok).toBe(false);
    expect(mismatchRes.error?.code).toBe('MCP_ENGINE_ENVIRONMENT_MISMATCH');

    // Clear restriction -> mode="auto-submit" succeeds, opens TaskCenter & focuses task-900
    const autoSubRes = await dispatcher.handleRequest({
      requestId: 'p6-sub-auto-ok',
      action: 'frontend.submitTask',
      payload: {
        documentId: h2Doc.id,
        mode: 'auto-submit',
        environmentId: 'env-orca-cluster',
        taskName: 'H2 Opt'
      }
    });
    expect(autoSubRes.ok).toBe(true);
    const autoSubOut = autoSubRes.result as {
      submitted: boolean;
      taskId: string;
      environmentId: string;
      workbench: { taskCenterOpen: boolean };
    };
    expect(autoSubOut.submitted).toBe(true);
    expect(autoSubOut.taskId).toBe('task-900');
    expect(autoSubOut.environmentId).toBe('env-orca-cluster');
    expect(autoSubOut.workbench.taskCenterOpen).toBe(true);
    expect(taskCenterOpen).toBe(true);
    expect(openedCenterTaskIds).toEqual(['task-900']);

    // Verify manually edited stale Gaussian script rejects with MCP_STALE_EDITED_INPUT after geometry change
    await dispatcher.handleRequest({
      requestId: 'p6-cfg-h2-g16',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: h2Doc.id,
        engine: 'gaussian',
        settings: { task: 'sp', method: 'b3lyp', basis: 'def2SVP' }
      }
    });
    const latestH2Entry = registry.getSnapshot().documents.find(d => d.id === h2Doc.id)!;
    const savedG = structuredClone(latestH2Entry.drafts.gaussian as Record<string, unknown>);
    savedG.editorDirty = true;
    registry.setDraft(h2Doc.id, 'gaussian', savedG as never, true);
    // Mutate bond length so signature changes
    const editBondRes = await dispatcher.handleRequest({
      requestId: 'p6-edit-h2-bond',
      action: 'frontend.editStructure',
      payload: {
        documentId: h2Doc.id,
        operation: 'set-geometry',
        coordinate: 'B',
        atoms: [1, 2],
        value: 0.82
      }
    });
    expect(editBondRes.ok).toBe(true);
    const staleSubmitFail = await dispatcher.handleRequest({
      requestId: 'p6-sub-stale',
      action: 'frontend.submitTask',
      payload: {
        documentId: h2Doc.id,
        engine: 'gaussian'
      }
    });
    expect(staleSubmitFail.ok).toBe(false);
    expect(staleSubmitFail.error?.code).toBe('MCP_STALE_EDITED_INPUT');

    // 5. Test ester_task_manage: list-environments, list-tasks, task-detail, read-log, stop-task
    // Open TaskCenter first -> list-tasks & task-detail should NOT create/leave temporary center entries!
    taskCenterOpen = true;
    centerEnters.length = 0;
    centerLeaves.length = 0;

    const envRes = await dispatcher.handleRequest({
      requestId: 'p6-tm-envs',
      action: 'frontend.taskManage',
      payload: { action: 'list-environments' }
    });
    expect(envRes.ok).toBe(true);
    const envOut = envRes.result as {
      environmentCount: number;
      environments: Array<Record<string, unknown>>;
    };
    expect(envOut.environmentCount).toBe(3);
    // Verify privateKeySecret is stripped by sanitizeEnvironmentSummary!
    expect(JSON.stringify(envOut.environments)).not.toContain('NEVER_LEAK_ME');

    const listActiveRes = await dispatcher.handleRequest({
      requestId: 'p6-tm-list',
      action: 'frontend.taskManage',
      payload: { action: 'list-tasks', category: 'active' }
    });
    expect(listActiveRes.ok).toBe(true);
    expect((listActiveRes.result as { taskCount: number; tasks: unknown[] }).taskCount).toBe(1);
    expect(centerEnters).toHaveLength(0);
    expect(centerLeaves).toHaveLength(0);

    const detailRes = await dispatcher.handleRequest({
      requestId: 'p6-tm-detail',
      action: 'frontend.taskManage',
      payload: { action: 'task-detail', taskId: 'task-900' }
    });
    expect(detailRes.ok).toBe(true);
    const detailOut = detailRes.result as {
      task: { executionState: string };
      energyMonitor: {
        title: string;
        series: Array<{ pointCount: number; initialValue: number; latestValue: number }>;
      };
      frameCount: number;
    };
    expect(detailOut.task.executionState).toBe('running');
    expect(detailOut.energyMonitor.series[0].pointCount).toBe(3);
    expect(detailOut.energyMonitor.series[0].initialValue).toBeCloseTo(-1.1600, 5);
    expect(detailOut.energyMonitor.series[0].latestValue).toBeCloseTo(-1.1684, 5);
    expect(detailOut.frameCount).toBe(3);
    // TaskCenter was open -> did NOT call center.enter or center.leave!
    expect(centerEnters).toHaveLength(0);
    expect(centerLeaves).toHaveLength(0);

    // Close TaskCenter -> list-tasks creates & leaves temporary entry cleanly
    taskCenterOpen = false;
    const listClosedRes = await dispatcher.handleRequest({
      requestId: 'p6-tm-list-closed',
      action: 'frontend.taskManage',
      payload: { action: 'list-tasks' }
    });
    expect(listClosedRes.ok).toBe(true);
    expect(centerEnters).toHaveLength(1);
    expect(centerLeaves).toEqual(centerEnters);

    // read-log slices trailing 2 lines, rejects binary files, and always releases preview ownerId
    const logRes = await dispatcher.handleRequest({
      requestId: 'p6-tm-log',
      action: 'frontend.taskManage',
      payload: { action: 'read-log', taskId: 'task-900', tailLines: 2 }
    });
    expect(logRes.ok).toBe(true);
    const logOut = logRes.result as {
      fileName: string;
      lineCount: number;
      hasEarlierContent: boolean;
      text: string;
    };
    expect(logOut.fileName).toBe('h2.out');
    expect(logOut.lineCount).toBe(2);
    expect(logOut.hasEarlierContent).toBe(true);
    expect(logOut.text).toBe('ORCASCF Iteration 3: -1.1684\nHURRAY - OPTIMIZATION CONVERGED');
    expect(releasedPreviewOwners).toHaveLength(1);

    const binaryLogFail = await dispatcher.handleRequest({
      requestId: 'p6-tm-log-bin',
      action: 'frontend.taskManage',
      payload: { action: 'read-log', taskId: 'task-900', artifactId: 'art-gbw' }
    });
    expect(binaryLogFail.ok).toBe(false);
    expect(binaryLogFail.error?.code).toBe('MCP_BINARY_ARTIFACT_UNSUPPORTED');

    // stop-task plans, executes, tracks operationId, and leaves temporary center entry
    const stopRes = await dispatcher.handleRequest({
      requestId: 'p6-tm-stop',
      action: 'frontend.taskManage',
      payload: { action: 'stop-task', taskId: 'task-900' }
    });
    expect(stopRes.ok).toBe(true);
    expect((stopRes.result as { stopped: boolean; operationId: string }).stopped).toBe(true);
    expect(trackedOperations).toEqual(['op-stop-900']);
  });

  it('covers Phase 6 Round 1 edge cases: timeoutSeconds cancellation, periodic rebuildBonds=false, pointsPerTorsion grid, retainedResult detach, companion dependency release, endReason categories, uncached monitor polling, and queued log guard', async () => {
    const registry = createWorkspaceRegistry();

    // 1. Periodic crystal singlepoint with rebuildBonds: false preserves crystal bonds while publishing MBO
    const crystalDoc = registry.addDocument(
      {
        id: 'struct-nacl-p6',
        name: 'NaCl-Crystal',
        format: 'cif',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'na1', element: 'Na', x: 0, y: 0, z: 0 },
          { id: 'cl1', element: 'Cl', x: 2.82, y: 2.82, z: 2.82 }
        ],
        bonds: [{ a: 0, b: 1, order: 1 }],
        cell: {
          vectors: [
            [5.64, 0, 0],
            [0, 5.64, 0],
            [0, 0, 5.64]
          ],
          pbc: [true, true, true]
        }
      },
      'NaCl-P6'
    );
    const crystalEntry = registry.getSnapshot().documents.find(d => d.id === crystalDoc.id)!;
    const revBeforePeriodicSp = crystalEntry.store.getSnapshot().revision;

    const periodicListeners = new Set<(event: XtbEvent) => void>();
    const activeRequests = new Map<string, XtbRequest>();
    const stopCalls: string[] = [];
    let simulateSlowHang = false;
    const periodicAndSlowBridge: XtbBridge = {
      async startXtb(request, sessionId = `xtb-r1-${Math.random().toString(36).slice(2, 8)}`) {
        activeRequests.set(sessionId, request);
        if (simulateSlowHang) {
          setTimeout(() => {
            for (const fn of [...periodicListeners]) {
              fn({
                schema: 1,
                sessionId,
                stamp: request.stamp,
                ...(request.runIdentity ? { runIdentity: request.runIdentity } : {}),
                operation: request.calculation === 'singlepoint' ? 'xtb-singlepoint' : 'xtb-optimize',
                seq: 1,
                method: request.method,
                event: 'started'
              });
            }
          }, 1);
          return { sessionId };
        }

        setTimeout(() => {
          const isPeriodic = Boolean(request.structure.cell);
          for (const fn of [...periodicListeners]) {
            fn({
              schema: 1,
              sessionId,
              stamp: request.stamp,
              ...(request.runIdentity ? { runIdentity: request.runIdentity } : {}),
              operation: request.calculation === 'singlepoint' ? 'xtb-singlepoint' : 'xtb-optimize',
              seq: 1,
              method: request.method,
              event: 'completed',
              ...(request.runIdentity ? { diagnosticDirectory: `/tmp/diag-${sessionId}` } : {}),
              coordinates: request.structure.atoms.map(a => ({ id: a.id!, element: a.element, x: a.x, y: a.y, z: a.z })),
              metadata: {
                converged: true,
                ...(request.calculation === 'singlepoint'
                  ? { sccIterations: 5, sccIterationLimit: request.maxSccIterations ?? 250 }
                  : { iterations: 3 }),
                energyHartree: -12.3456,
                energyUnit: 'hartree',
                coordinateUnit: 'angstrom',
                engine: isPeriodic ? 'tblite' : 'xtb',
                version: '0.4.0',
                method: request.method,
                charge: request.charge,
                uhf: request.uhf ?? 0,
                spinTreatment: 'restricted',
                threads: request.threads ?? 1,
                maxSteps: request.maxSteps ?? 500,
                ...(request.maxWallTimeSeconds !== undefined ? { maxWallTimeSeconds: request.maxWallTimeSeconds } : {}),
                frozenAtomIds: [...request.frozenAtomIds],
                internalConstraintMode: 'none',
                internalConstraints: [],
                calculation: request.calculation ?? 'optimize',
                ...(isPeriodic
                  ? {
                      periodic: {
                        sourceCell: structuredClone(request.structure.cell!),
                        sourcePbc: [...request.structure.cell!.pbc] as [boolean, boolean, boolean],
                        effectivePbc: [true, true, true] as const,
                        fixedCell: true as const,
                        backend: 'tblite-api' as const,
                        bondOrderScope: 'atom-pair-periodic-aggregate' as const,
                        imageResolved: false as const,
                        version: '0.4.0',
                        libraryVersion: '0.4.0',
                        parameters: {
                          method: 'GFN2-xTB' as const,
                          accuracy: 1 as const,
                          maxIterations: request.maxSccIterations ?? 250,
                          electronicTemperatureHartree: 0.00095 as const
                        }
                      },
                      bondOrders: {
                        definition: 'mayer-wiberg' as const,
                        sourceField: 'tblite:bond-orders' as const,
                        threshold: 0 as const,
                        entries: [{ atomIds: ['na1', 'cl1'] as [string, string], value: 0.21 }]
                      }
                    }
                  : {})
              },
              exit: { code: 0, signal: null }
            });
          }
        }, 1);
        return { sessionId };
      },
      async commandXtb(sessionId) {
        stopCalls.push(sessionId);
        const req = activeRequests.get(sessionId);
        if (req) {
          setTimeout(() => {
            for (const fn of [...periodicListeners]) {
              fn({
                schema: 1,
                sessionId,
                stamp: req.stamp,
                ...(req.runIdentity ? { runIdentity: req.runIdentity } : {}),
                operation: req.calculation === 'singlepoint' ? 'xtb-singlepoint' : 'xtb-optimize',
                seq: 2,
                method: req.method,
                event: 'stopped',
                reason: 'stopped-by-user',
                exit: { code: null, signal: 'SIGTERM' }
              });
            }
          }, 1);
        }
        return { sessionId, status: 'stopped' };
      },
      onXtbEvent(listener) {
        periodicListeners.add(listener);
        return () => periodicListeners.delete(listener);
      }
    };

    const r1Dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      getDesktop: () => periodicAndSlowBridge as unknown as DesktopBridge,
      isTaskCenterOpen: () => false
    });

    const periodicSpReply = await r1Dispatcher.handleRequest({
      requestId: 'p6-r1-periodic-sp',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: crystalDoc.id,
        calculation: 'singlepoint',
        method: 'gfn2'
      }
    });
    expect(periodicSpReply.ok).toBe(true);
    // Verify crystal bonds were NOT overwritten and physical revision stayed unchanged!
    expect(crystalEntry.store.getSnapshot().revision).toBe(revBeforePeriodicSp);
    expect(crystalEntry.store.getSnapshot().draft.structure.bonds).toEqual([{ a: 0, b: 1, order: 1 }]);

    // 2. Verify formatXtbSinglepointOrOptimizeOutcome rejects detached retainedResult with MCP_XTB_DETACHED_BY_EDIT
    expect(() =>
      formatXtbSinglepointOrOptimizeOutcome(
        crystalDoc.id,
        crystalEntry.store.getSnapshot(),
        'optimize',
        'gfn2',
        {
          running: false,
          phase: 'idle',
          status: 'detached',
          error: '',
          metadata: { converged: true } as never,
          retainedResult: { request: {} as never, coordinates: [], metadata: {} as never }
        }
      )
    ).toThrow(/修改|切换/);

    // 3. Verify pointsPerTorsion (2 vs 4) produces distinct sampledCandidateCount on n-butane
    const butaneDoc = registry.addDocument(
      {
        id: 'struct-butane-r1',
        name: 'n-Butane',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'c1', element: 'C', x: -1.911, y: -0.531, z: 0.000 },
          { id: 'c2', element: 'C', x: -0.521, y: 0.104, z: 0.000 },
          { id: 'c3', element: 'C', x: 0.521, y: -0.104, z: 1.102 },
          { id: 'c4', element: 'C', x: 1.911, y: 0.531, z: 1.102 },
          { id: 'h1', element: 'H', x: -2.658, y: 0.268, z: 0.000 },
          { id: 'h2', element: 'H', x: -2.063, y: -1.152, z: 0.888 },
          { id: 'h3', element: 'H', x: -2.063, y: -1.152, z: -0.888 },
          { id: 'h4', element: 'H', x: -0.618, y: 1.194, z: -0.056 },
          { id: 'h5', element: 'H', x: -0.025, y: -0.228, z: -0.917 },
          { id: 'h6', element: 'H', x: 0.618, y: -1.194, z: 1.158 },
          { id: 'h7', element: 'H', x: 0.025, y: 0.228, z: 2.019 },
          { id: 'h8', element: 'H', x: 2.658, y: -0.268, z: 1.102 },
          { id: 'h9', element: 'H', x: 2.063, y: 1.152, z: 0.214 },
          { id: 'h10', element: 'H', x: 2.063, y: 1.152, z: 1.990 }
        ],
        bonds: [
          { a: 0, b: 1, order: 1 },
          { a: 1, b: 2, order: 1 },
          { a: 2, b: 3, order: 1 },
          { a: 0, b: 4, order: 1 },
          { a: 0, b: 5, order: 1 },
          { a: 0, b: 6, order: 1 },
          { a: 1, b: 7, order: 1 },
          { a: 1, b: 8, order: 1 },
          { a: 2, b: 9, order: 1 },
          { a: 2, b: 10, order: 1 },
          { a: 3, b: 11, order: 1 },
          { a: 3, b: 12, order: 1 },
          { a: 3, b: 13, order: 1 }
        ]
      },
      'Butane-R1'
    );

    const conf2Reply = await r1Dispatcher.handleRequest({
      requestId: 'p6-r1-conf-pt2',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: butaneDoc.id,
        calculation: 'conformer-search',
        method: 'gfn2',
        pointsPerTorsion: 2,
        maxCandidates: 24
      }
    });
    expect(conf2Reply.ok).toBe(true);
    const pt2Count = (conf2Reply.result as { sampledCandidateCount: number }).sampledCandidateCount;
    expect(pt2Count).toBeLessThanOrEqual(2);

    const conf4Reply = await r1Dispatcher.handleRequest({
      requestId: 'p6-r1-conf-pt4',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: butaneDoc.id,
        calculation: 'conformer-search',
        method: 'gfn2',
        pointsPerTorsion: 4,
        maxCandidates: 24
      }
    });
    expect(conf4Reply.ok).toBe(true);
    const pt4Count = (conf4Reply.result as { sampledCandidateCount: number }).sampledCandidateCount;
    expect(pt4Count).toBeGreaterThan(pt2Count);

    // 4. Verify timeoutSeconds cancels in-flight xTB job via commandXtb('stop') and unlocks ModelStore
    simulateSlowHang = true;
    stopCalls.length = 0;
    const timeoutReply = await r1Dispatcher.handleRequest({
      requestId: 'p6-r1-xtb-timeout',
      action: 'frontend.runLocalXtb',
      payload: {
        documentId: butaneDoc.id,
        calculation: 'optimize',
        method: 'gfn2',
        timeoutSeconds: 0.03
      }
    });
    expect(timeoutReply.ok).toBe(false);
    expect(timeoutReply.error?.code).toBe('MCP_XTB_TIMEOUT');
    expect(stopCalls.length).toBeGreaterThanOrEqual(1);
    const butaneEntry = registry.getSnapshot().documents.find(d => d.id === butaneDoc.id)!;
    expect(butaneEntry.store.isRuntimeSessionActive?.()).toBe(false);

    // 5. Verify companion dependency staging + release-dependencies on BOTH preview rejection AND submit success,
    //    plus endReason category filtering, uncached monitor polling when TaskCenter is closed, and queued read-log guard
    const releasedRefs: string[] = [];
    let monitorPolls = 0;
    let mockPreviewRestrictions: string[] = ['environment-unverified'];
    let stopOpState: 'succeeded' | 'failed' = 'failed';

    const mockTasksR1 = [
      {
        taskId: 't-active',
        runId: 'r-1',
        displayName: 'Active Job',
        engineId: 'orca',
        taskKind: 'opt',
        formula: 'C4H10',
        environmentId: 'env-1',
        environmentName: 'Local ORCA',
        connectionKind: 'local',
        schedulerKind: 'direct',
        executionState: 'queued',
        verificationState: 'verified',
        archived: false,
        recycled: false,
        stopControl: { canRequest: true },
        workPath: '/tmp/t-active',
        archivePath: null,
        createdAt: '2026-11-10T10:00:00Z'
      },
      {
        taskId: 't-completed',
        runId: 'r-2',
        displayName: 'Completed Job',
        engineId: 'orca',
        taskKind: 'sp',
        formula: 'C4H10',
        environmentId: 'env-1',
        environmentName: 'Local ORCA',
        connectionKind: 'local',
        schedulerKind: 'direct',
        executionState: 'ended',
        endReason: 'completed',
        failureKind: null,
        verificationState: 'verified',
        archived: false,
        recycled: false,
        workPath: '/tmp/t-completed',
        archivePath: null,
        createdAt: '2026-11-10T09:00:00Z'
      },
      {
        taskId: 't-interrupted',
        runId: 'r-3',
        displayName: 'Interrupted Job',
        engineId: 'orca',
        taskKind: 'opt',
        formula: 'C4H10',
        environmentId: 'env-1',
        environmentName: 'Local ORCA',
        connectionKind: 'local',
        schedulerKind: 'direct',
        executionState: 'ended',
        endReason: 'interrupted',
        failureKind: null,
        verificationState: 'verified',
        archived: false,
        recycled: false,
        workPath: '/tmp/t-interrupted',
        archivePath: null,
        createdAt: '2026-11-10T08:00:00Z'
      }
    ];

    const r1TaskBridge = {
      subscribe: () => () => {},
      request: async (channel: string, payload: Record<string, unknown>) => {
        switch (channel) {
          case 'center.read':
          case 'center.enter':
            return {
              library: { libraryId: 'lib-r1', path: '/tmp/lib-r1' },
              manager: { access: 'manager' },
              environments: [
                {
                  environmentId: 'env-1',
                  displayName: 'Local ORCA',
                  engineId: 'orca',
                  connectionKind: 'local',
                  schedulerKind: 'direct',
                  workingRoot: '/tmp/orca'
                }
              ],
              tasks: mockTasksR1
            };
          case 'center.leave':
            return { left: true };
          case 'submission.stage-begin':
            return { token: `tok-${String(payload.name)}` };
          case 'submission.stage-append':
            return { receivedBytes: Number(payload.offset) + (payload.bytes as Uint8Array).byteLength };
          case 'submission.stage-finish':
            return {
              name: String(payload.token).replace(/^tok-/, ''),
              role: 'companion',
              sourceRef: `staged-ref-${String(payload.token)}`
            };
          case 'submission.release-dependencies':
            releasedRefs.push(...((payload.sourceRefs as string[]) ?? []));
            return { released: true };
          case 'submission.preview':
            return {
              restrictions: mockPreviewRestrictions,
              suggestedDisplayName: 'Butane Companion Job',
              submissionPlanId: 'plan-r1',
              workingPath: '/tmp/orca/job-r1'
            };
          case 'submission.submit':
            return { taskId: 't-active', runId: 'r-1', operationId: 'op-sub-r1' };
          case 'task.details': {
            const id = String(payload.taskId);
            const task = mockTasksR1.find(t => t.taskId === id) ?? mockTasksR1[0];
            return {
              task,
              stage: 'Queued',
              iteration: null,
              elapsedSeconds: 5,
              updatedAt: '2026-11-10T10:00:05Z',
              scientificStates: [],
              notices: [],
              files:
                id === 't-active'
                  ? [
                      // Queued job: input exists, output does NOT exist yet!
                      { artifactId: 'a-inp', name: 'job.inp', role: 'input', size: 120, kind: 'text', exists: true, readable: true },
                      { artifactId: 'a-out', name: 'job.out', role: 'primary-output', size: 0, kind: 'text', exists: false, readable: false },
                      { artifactId: 'a-unk', name: 'job.tmp', role: 'scratch', size: 64, kind: 'unknown', exists: true, readable: true }
                    ]
                  : [
                      { artifactId: 'c-inp', name: 'sp.inp', role: 'input', size: 120, kind: 'text', exists: true, readable: true },
                      { artifactId: 'c-out', name: 'sp.out', role: 'primary-output', size: 2048, kind: 'text', exists: true, readable: true }
                    ]
            };
          }
          case 'monitor.read': {
            monitorPolls++;
            const base = {
              task: mockTasksR1[1],
              stage: 'Completed',
              iteration: 4,
              elapsedSeconds: 18,
              updatedAt: '2026-11-10T09:01:00Z',
              scientificStates: [],
              notices: [],
              files: [
                { artifactId: 'c-out', name: 'sp.out', role: 'primary-output', size: 2048, kind: 'text', exists: true, readable: true }
              ]
            };
            if (monitorPolls === 1) {
              // Simulate monitoring.cjs initial cold response: prepared: false, progress: null!
              return { ...base, prepared: false, progress: null, frameCount: 0, cards: [] };
            }
            return {
              ...base,
              prepared: true,
              progress: { stage: 'ready', percent: 100 },
              frameCount: 1,
              cards: [
                {
                  kind: 'energy',
                  title: 'SCF Energy',
                  sourceLabel: 'sp.out',
                  columns: ['Step', 'Energy'],
                  rows: [['1', '-158.3210']],
                  plot: {
                    xLabel: 'Step',
                    yLabel: 'Eh',
                    series: [{ id: 'scf', label: 'SCF', points: [{ x: 1, y: -158.3210 }] }]
                  }
                }
              ]
            };
          }
          case 'operation.plan':
            return { planId: 'plan-stop-r1', items: [{ taskId: String((payload.taskIds as string[])[0]), eligible: true }] };
          case 'operation.execute':
            return { operationId: 'op-stop-r1' };
          case 'operation.read':
            return {
              operationId: 'op-stop-r1',
              state: stopOpState,
              phase: 'done',
              items: [{ taskId: 't-completed', outcome: stopOpState === 'succeeded' ? 'stopped' : 'not-executed' }]
            };
          default:
            throw new Error(`Unhandled R1 channel: ${channel}`);
        }
      }
    } as unknown as TaskSystemBridge;

    const r1SubmitDispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => false,
      getCallbacks: () => ({
        getTaskSystemBridge: () => r1TaskBridge,
        captureLiveSubmissionDraft: () => ({
          engineId: 'orca',
          inputName: 'butane.inp',
          suggestedName: 'butane',
          finalInputText: '! r2SCAN-3c Opt\n* xyzfile 0 1 reactant.xyz\n',
          dependencies: [
            {
              name: 'reactant.xyz',
              role: 'structure',
              source: { kind: 'generated-text', text: '2\n\nH 0 0 0\nH 0 0 0.74\n' }
            }
          ]
        })
      })
    });

    // 5a. Preview restriction rejects with MCP_SUBMISSION_RESTRICTED AND releases staged companion dependency!
    const restrictedSub = await r1SubmitDispatcher.handleRequest({
      requestId: 'p6-r1-sub-restricted',
      action: 'frontend.submitTask',
      payload: {
        documentId: butaneDoc.id,
        mode: 'auto-submit',
        environmentId: 'env-1'
      }
    });
    expect(restrictedSub.ok).toBe(false);
    expect(restrictedSub.error?.code).toBe('MCP_SUBMISSION_RESTRICTED');
    expect(releasedRefs).toEqual(['staged-ref-tok-reactant.xyz']);

    // 5b. Clear restriction -> auto-submit stages & releases companion dependency cleanly
    releasedRefs.length = 0;
    mockPreviewRestrictions = [];
    const okSub = await r1SubmitDispatcher.handleRequest({
      requestId: 'p6-r1-sub-ok',
      action: 'frontend.submitTask',
      payload: {
        documentId: butaneDoc.id,
        mode: 'auto-submit',
        environmentId: 'env-1'
      }
    });
    expect(okSub.ok).toBe(true);
    expect(releasedRefs).toEqual(['staged-ref-tok-reactant.xyz']);

    // 5c. Verify list-tasks category parity with TaskCenter UI (interrupted NOT in completed, IS in failed!)
    const completedList = await r1SubmitDispatcher.handleRequest({
      requestId: 'p6-r1-list-completed',
      action: 'frontend.taskManage',
      payload: { action: 'list-tasks', category: 'completed' }
    });
    expect((completedList.result as { tasks: Array<{ taskId: string }> }).tasks.map(t => t.taskId)).toEqual([
      't-completed'
    ]);

    const failedList = await r1SubmitDispatcher.handleRequest({
      requestId: 'p6-r1-list-failed',
      action: 'frontend.taskManage',
      payload: { action: 'list-tasks', category: 'failed' }
    });
    expect((failedList.result as { tasks: Array<{ taskId: string }> }).tasks.map(t => t.taskId)).toEqual([
      't-interrupted'
    ]);

    // 5d. Verify task-detail polls past initial prepared: false, progress: null when TaskCenter is closed!
    const coldDetail = await r1SubmitDispatcher.handleRequest({
      requestId: 'p6-r1-cold-detail',
      action: 'frontend.taskManage',
      payload: { action: 'task-detail', taskId: 't-completed' }
    });
    expect(coldDetail.ok).toBe(true);
    expect(monitorPolls).toBeGreaterThanOrEqual(2);
    expect((coldDetail.result as { monitorPrepared: boolean }).monitorPrepared).toBe(true);
    expect(
      (coldDetail.result as { energyMonitor: { series: Array<{ latestValue: number }> } }).energyMonitor.series[0]
        .latestValue
    ).toBeCloseTo(-158.321, 4);

    // 5e. Verify read-log on queued task (exists: false output, exists: true input) rejects with MCP_LOG_ARTIFACT_UNAVAILABLE
    const queuedLog = await r1SubmitDispatcher.handleRequest({
      requestId: 'p6-r1-queued-log',
      action: 'frontend.taskManage',
      payload: { action: 'read-log', taskId: 't-active' }
    });
    expect(queuedLog.ok).toBe(false);
    expect(queuedLog.error?.code).toBe('MCP_LOG_ARTIFACT_UNAVAILABLE');

    // Explicit kind: 'unknown' artifact rejects with MCP_BINARY_ARTIFACT_UNSUPPORTED
    const unkLog = await r1SubmitDispatcher.handleRequest({
      requestId: 'p6-r1-unk-log',
      action: 'frontend.taskManage',
      payload: { action: 'read-log', taskId: 't-active', artifactId: 'a-unk' }
    });
    expect(unkLog.ok).toBe(false);
    expect(unkLog.error?.code).toBe('MCP_BINARY_ARTIFACT_UNSUPPORTED');

    // 5f. Verify stop-task reports stopped: false when opView.state === 'failed' on a naturally completed job
    stopOpState = 'failed';
    const failedStop = await r1SubmitDispatcher.handleRequest({
      requestId: 'p6-r1-stop-failed',
      action: 'frontend.taskManage',
      payload: { action: 'stop-task', taskId: 't-completed' }
    });
    expect(failedStop.ok).toBe(true);
    expect((failedStop.result as { stopped: boolean }).stopped).toBe(false);
  });
});

describe('Frontend MCP Collaboration Bridge — Phase 7 (Result Analysis, Multiwfn Wavefunction Analysis & Artifact Export)', () => {
  const SAMPLE_GAUSSIAN_FREQ_LOG = [
    ' Entering Gaussian System, Link 0=g16',
    ' ----------------------------------------------------------------------',
    ' #p B3LYP/def2SVP opt=(ts,calcfc,noeigentest) freq td=(nstates=2)',
    ' ----------------------------------------------------------------------',
    ' Symbolic Z-matrix:',
    ' Charge =  0 Multiplicity = 1',
    ' O                    0.000000    0.000000    0.117300',
    ' H                    0.000000    0.757200   -0.469200',
    ' H                    0.000000   -0.757200   -0.469200',
    ' ',
    '                         Standard orientation:                         ',
    ' ---------------------------------------------------------------------',
    ' Center     Atomic      Atomic             Coordinates (Angstroms)',
    ' Number     Number       Type             X           Y           Z',
    ' ---------------------------------------------------------------------',
    '      1          8           0        0.000000    0.000000    0.117300',
    '      2          1           0        0.000000    0.757200   -0.469200',
    '      3          1           0        0.000000   -0.757200   -0.469200',
    ' ---------------------------------------------------------------------',
    ' SCF Done:  E(RB3LYP) =  -76.384912500     A.U. after    9 cycles',
    ' Alpha  occ. eigenvalues --  -19.14200  -1.01200  -0.52800  -0.38200  -0.29500',
    ' Alpha virt. eigenvalues --    0.04200   0.12800   0.45100',
    ' Mulliken charges:',
    '               1',
    '    1  O   -0.612400',
    '    2  H    0.306200',
    '    3  H    0.306200',
    ' Sum of Mulliken charges =   0.00000',
    ' Dipole moment (field-independent basis, Debye):',
    '    X=              0.0000    Y=              0.0000    Z=             -1.9240  Tot=              1.9240',
    ' Excitation energies and oscillator strengths:',
    ' Excited State   1:      Singlet-B1     7.4125 eV  167.26 nm  f=0.0412  <S**2>=0.000',
    '      5 ->  6         0.70120',
    ' Excited State   2:      Singlet-A2     9.1850 eV  134.99 nm  f=0.0000  <S**2>=0.000',
    '      5 ->  7         0.69850',
    '         Item               Value     Threshold  Converged?',
    ' Maximum Force            0.000012     0.000450     YES',
    ' RMS     Force            0.000008     0.000300     YES',
    ' Maximum Displacement     0.000045     0.001800     YES',
    ' RMS     Displacement     0.000030     0.001200     YES',
    ' Optimization completed.',
    '    -- Stationary point found.',
    ' Harmonic frequencies (cm**-1), IR intensities (KM/Mole), Raman scattering',
    ' activities (A**4/AMU), depolarization ratios for plane and unpolarized',
    ' incident light, reduced masses (AMU), force constants (mDyne/A),',
    ' and normal coordinates:',
    '                      1                      2                      3',
    '                      A1                     A1                     B2',
    ' Frequencies --   -412.3500              1648.2000              3812.4500',
    ' Red. masses --      1.0820                 1.0840                 1.0450',
    ' Frc consts  --      0.1084                 1.7350                 8.9480',
    ' IR Inten    --     95.4200                72.1500                48.3000',
    '  Atom  AN      X      Y      Z        X      Y      Z        X      Y      Z',
    '     1   8     0.00   0.00   0.07     0.00   0.00   0.07     0.00   0.07   0.00',
    '     2   1     0.00  -0.43  -0.55     0.00  -0.43  -0.55     0.00  -0.56   0.43',
    '     3   1     0.00   0.43  -0.55     0.00   0.43  -0.55     0.00  -0.56  -0.43',
    ' - Thermochemistry -',
    ' Temperature   298.150 Kelvin.  Pressure   1.00000 Atm.',
    ' Zero-point correction=                           0.021145 (Hartree/Particle)',
    ' Thermal correction to Energy=                    0.023980',
    ' Thermal correction to Enthalpy=                  0.024924',
    ' Thermal correction to Gibbs Free Energy=         0.003512',
    ' Sum of electronic and zero-point Energies=           -76.363768',
    ' Sum of electronic and thermal Energies=              -76.360933',
    ' Sum of electronic and thermal Enthalpies=            -76.359989',
    ' Sum of electronic and thermal Free Energies=         -76.381401',
    ' Normal termination of Gaussian 16 at Tue Nov 10 12:00:00 2026.'
  ].join('\n');

  const BOHR = 0.529177210903;
  const zO = (0.1173 / BOHR).toExponential(8);
  const yH1 = (0.7572 / BOHR).toExponential(8);
  const zH = (-0.4692 / BOHR).toExponential(8);
  const yH2 = (-0.7572 / BOHR).toExponential(8);

  const SAMPLE_WATER_FCHK = [
    'water_ts_sp',
    'SP        RB3LYP                                                      def2SVP',
    'Number of atoms                            I                3',
    'Charge                                     I                0',
    'Multiplicity                               I                1',
    'Number of electrons                        I               10',
    'Number of alpha electrons                  I                5',
    'Number of beta electrons                   I                5',
    'Number of basis functions                  I               24',
    'Number of independent functions            I               24',
    'Atomic numbers                             I   N=           3',
    '           8           1           1',
    'Nuclear charges                            R   N=           3',
    '  8.00000000E+00  1.00000000E+00  1.00000000E+00',
    'Current cartesian coordinates              R   N=           9',
    `  0.00000000E+00  0.00000000E+00  ${zO}  0.00000000E+00  ${yH1}`,
    ` ${zH}  0.00000000E+00 ${yH2} ${zH}`,
    'SCF Energy                                 R     -7.638491250000000E+01',
    'Total Energy                               R     -7.638491250000000E+01',
    'Alpha Orbital Energies                     R   N=           8',
    ' -1.91420000E+01 -1.01200000E+00 -5.28000000E-01 -3.82000000E-01 -2.95000000E-01',
    '  4.20000000E-02  1.28000000E-01  4.51000000E-01'
  ].join('\n') + '\n';

  const SAMPLE_WATER_MOLDEN = [
    '[Molden Format]',
    '[Atoms] Angs',
    'O   1   8    0.000000    0.000000    0.117300',
    'H   2   1    0.000000    0.757200   -0.469200',
    'H   3   1    0.000000   -0.757200   -0.469200',
    '[GTO]',
    '  1 0',
    ' s   1 1.00',
    '      1.0000000000   1.0000000000',
    '',
    '[MO]',
    ' Sym= A1',
    ' Ene= -0.2950',
    ' Spin= Alpha',
    ' Occup= 2.000000',
    '   1   1.000000',
    ' Sym= B1',
    ' Ene= 0.0420',
    ' Spin= Alpha',
    ' Occup= 0.000000',
    '   1   1.000000',
    ''
  ].join('\n');

  function makeWaterMetadata(sourceId: string, name: string, rawText: string, format: 'fchk' | 'molden'): WavefunctionMetadata {
    const sourceRevision = createHash('sha256').update(rawText, 'utf8').digest('hex');
    const energies = [-19.142, -1.012, -0.528, -0.382, -0.295, 0.042, 0.128, 0.451];
    return {
      sourceId,
      sourceRevision,
      name,
      format,
      basisCount: 24,
      messages: [],
      structure: {
        id: `${sourceId}:struct`,
        name: 'water',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: `${sourceId}:a1`, element: 'O', x: 0, y: 0, z: 0.1173 },
          { id: `${sourceId}:a2`, element: 'H', x: 0, y: 0.7572, z: -0.4692 },
          { id: `${sourceId}:a3`, element: 'H', x: 0, y: -0.7572, z: -0.4692 }
        ],
        bonds: []
      },
      orbitals: energies.map((energy, idx) => ({
        key: `restricted:${idx + 1}`,
        spin: 'restricted' as const,
        ordinal: idx + 1,
        sourceIndex: idx + 1,
        displayIndex: idx + 1,
        energy,
        energyUnit: 'hartree' as const,
        occupation: idx < 5 ? 2 : 0,
        sourceLine: 20 + idx,
        sourceField: 'Alpha Orbital Energies'
      }))
    };
  }

  it('resolves HOMO/LUMO frontier orbital aliases and rejects invalid offsets', () => {
    const meta = makeWaterMetadata('src-1', 'water.fchk', SAMPLE_WATER_FCHK, 'fchk');
    expect(resolveOrbitalKeyAlias(meta, 'HOMO').key).toBe('restricted:5');
    expect(resolveOrbitalKeyAlias(meta, 'homo-1').key).toBe('restricted:4');
    expect(resolveOrbitalKeyAlias(meta, 'LUMO').key).toBe('restricted:6');
    expect(resolveOrbitalKeyAlias(meta, 'LUMO+1').key).toBe('restricted:7');
    expect(resolveOrbitalKeyAlias(meta, 'restricted:3').key).toBe('restricted:3');

    expect(() => resolveOrbitalKeyAlias(meta, 'HOMO+1')).toThrow(/Invalid frontier orbital alias/);
    expect(() => resolveOrbitalKeyAlias(meta, 'LUMO-1')).toThrow(/Invalid frontier orbital alias/);
    expect(() => resolveOrbitalKeyAlias(meta, 'HOMO-99')).toThrow(/was not found/);
  });

  it('opens Gaussian output & FCHK wavefunctions, summarizes imaginary frequencies & thermochemistry, runs Multiwfn charges/bonds/composition/orbitals/reactivity, syncs viewport overlays, and exports artifacts', async () => {
    const registry = createWorkspaceRegistry();
    registry.addDocument();

    const openedSessions = new Map<string, WavefunctionMetadata>();
    const closedOrbitalSessions: string[] = [];
    const openedReactivitySessions: string[] = [];
    const reactivitySessionSources = new Map<string, string>();
    const closedReactivitySessions: string[] = [];
    const cancelledAnalyses: string[] = [];
    const syncedPresentations: Array<{
      documentId: string;
      panel?: string;
      frameIndex?: number;
      overlay?: McpAnalysisViewportOverlay | null;
    }> = [];

    let multiwfnConfigured = true;
    let simulateSlowAnalysisMs = 0;
    let asyncOrbitalEventMode = false;
    const orbitalListeners = new Set<(event: any) => void>();

    const mockDesktop: DesktopBridge = {
      async orbitalBackendInfo() {
        return multiwfnConfigured
          ? { configured: true, path: '/opt/multiwfn/multiwfn' }
          : { configured: false, message: '未找到本机 Multiwfn 可执行文件' };
      },
      async orbitalResourceInfo() {
        return {
          threads: 4,
          memoryBudgetBytes: 2 * 1024 ** 3,
          totalPhysicalMemoryBytes: 16 * 1024 ** 3,
          logicalCpuCount: 8,
          threadSource: 'settings',
          memorySource: 'request',
          settingsPath: null,
          settingsPresent: false,
          settingsRevision: 'rev-1',
          temporaryOverrides: [],
          retainedOtherSettings: true,
          memoryIsBudget: true,
          configured: true
        };
      },
      async openOrbitalSession(req) {
        const format = req.name.endsWith('.molden') ? 'molden' : 'fchk';
        const rawText = req.text ?? (format === 'molden' ? SAMPLE_WATER_MOLDEN : SAMPLE_WATER_FCHK);
        const meta = makeWaterMetadata(req.sourceId, req.name, rawText, format);
        openedSessions.set(req.sessionId, meta);
        return meta;
      },
      async forkOrbitalSession(parentSessionId, instanceId) {
        const parent = openedSessions.get(parentSessionId);
        if (!parent) throw new Error(`Parent session not found: ${parentSessionId}`);
        const childId = `fork-${instanceId}`;
        openedSessions.set(childId, parent);
        return { sessionId: childId, metadata: parent };
      },
      async closeOrbitalSession(sessionId) {
        closedOrbitalSessions.push(sessionId);
        openedSessions.delete(sessionId);
        return { sessionId, status: 'closed' } as any;
      },
      async analyzeWavefunction(sessionId, req) {
        if (simulateSlowAnalysisMs > 0) {
          await new Promise(resolve => setTimeout(resolve, simulateSlowAnalysisMs));
        }
        const meta = openedSessions.get(sessionId);
        if (!meta) throw new Error(`Session closed: ${sessionId}`);
        const base = {
          sessionId,
          sourceRevision: meta.sourceRevision,
          geometryIdentity: 'geom-h2o',
          backend: { name: 'Multiwfn', version: '3.8', threads: 4 },
          warnings: [] as string[]
        };
        if (req.kind === 'charges') {
          if (req.method === 'bader') {
            return {
              ...base,
              kind: 'charges',
              method: 'bader',
              unit: 'e',
              quantity: 'net-charge',
              sum: 0,
              spinAvailable: false,
              chargeConvention: 'AIM net atomic charge',
              atoms: [
                { atomId: meta.structure.atoms[0].id!, sourceIndex: 1, element: 'O', value: -1.142, electronPopulation: 9.142, referenceCharge: 8, basinIds: [1] },
                { atomId: meta.structure.atoms[1].id!, sourceIndex: 2, element: 'H', value: 0.571, electronPopulation: 0.429, referenceCharge: 1, basinIds: [2] },
                { atomId: meta.structure.atoms[2].id!, sourceIndex: 3, element: 'H', value: 0.571, electronPopulation: 0.429, referenceCharge: 1, basinIds: [3] }
              ],
              bader: {
                electronRepresentation: 'all-electron',
                referenceConvention: 'nuclear-charge',
                basins: [],
                unassigned: { gridCount: 0, electronPopulation: 0, evidence: 'explicit-zero-grid-count' },
                boundary: { gridCount: 0, electronPopulation: 0, evidence: 'explicit-zero-grid-count' },
                expectedElectronCount: 10,
                integratedElectronCount: 10,
                electronResidual: 0,
                chargeIncludingNonAtomicBasins: 0,
                normalizationFactor: 1,
                nativeNormalizedCharges: [
                  { sourceIndex: 1, value: -1.142 },
                  { sourceIndex: 2, value: 0.571 },
                  { sourceIndex: 3, value: 0.571 }
                ],
                grid: {
                  originBohr: [-4, -4, -4],
                  spacingBohr: [0.1, 0.1, 0.1],
                  dimensions: [20, 20, 20],
                  pointCount: 8000,
                  paddedPointCount: 8000,
                  estimatedMemoryBytes: 64000,
                  integration: 'mixed-exact',
                  paddingBohr: 4,
                  threads: 4,
                  threadStackBytes: 8 * 1024 * 1024
                },
                integrationMethod: 'mixed-exact',
                scientificAcceptance: 'pending-native-calibration'
              }
            };
          }
          return {
            ...base,
            kind: 'charges',
            method: req.method,
            unit: 'e',
            quantity: 'net-charge',
            sum: 0,
            spinAvailable: false,
            chargeConvention: 'electrostatic-potential',
            atoms: [
              { atomId: meta.structure.atoms[0].id!, sourceIndex: 1, element: 'O', value: -0.824 },
              { atomId: meta.structure.atoms[1].id!, sourceIndex: 2, element: 'H', value: 0.412 },
              { atomId: meta.structure.atoms[2].id!, sourceIndex: 3, element: 'H', value: 0.412 }
            ]
          };
        }
        if (req.kind === 'bond-orders') {
          return {
            ...base,
            kind: 'bond-orders',
            method: req.method,
            unit: 'dimensionless',
            bonds: [
              {
                atomId1: meta.structure.atoms[0].id!,
                atomId2: meta.structure.atoms[1].id!,
                sourceIndex1: 1,
                sourceIndex2: 2,
                value: 0.9412
              },
              {
                atomId1: meta.structure.atoms[0].id!,
                atomId2: meta.structure.atoms[2].id!,
                sourceIndex1: 1,
                sourceIndex2: 3,
                value: 0.9412
              },
              {
                atomId1: meta.structure.atoms[1].id!,
                atomId2: meta.structure.atoms[2].id!,
                sourceIndex1: 2,
                sourceIndex2: 3,
                value: 0.012
              }
            ]
          };
        }
        return {
          ...base,
          kind: 'composition',
          method: req.method,
          orbitalKey: req.orbitalKey,
          unit: 'percent',
          sum: 100,
          angular: { s: 18.5, p: 79.5, d: 2.0, f: 0, other: 0 },
          atoms: [
            { atomId: meta.structure.atoms[0].id!, sourceIndex: 1, element: 'O', value: 78.4 },
            { atomId: meta.structure.atoms[1].id!, sourceIndex: 2, element: 'H', value: 10.8 },
            { atomId: meta.structure.atoms[2].id!, sourceIndex: 3, element: 'H', value: 10.8 }
          ]
        };
      },
      async cancelWavefunctionAnalysis(sessionId) {
        cancelledAnalyses.push(sessionId);
      },
      async planOrbitalSession(sessionId, req) {
        const meta = openedSessions.get(sessionId)!;
        const pointCount = req.grid.dimensions.reduce((a, b) => a * b, 1);
        const fieldBytes = pointCount * 8;
        return {
          gridKey: `grid-${pointCount}`,
          pointCount,
          orbitalCount: meta.orbitals.length,
          cacheBytes: fieldBytes,
          workingBytes: fieldBytes,
          totalBytes: fieldBytes * 2,
          withinBudget: true,
          mode: req.mode
        };
      },
      onOrbitalEvent(listener) {
        orbitalListeners.add(listener);
        return () => orbitalListeners.delete(listener);
      },
      async commandOrbitals(sessionId, req) {
        const meta = openedSessions.get(sessionId);
        if (req.operation === 'close') {
          closedOrbitalSessions.push(sessionId);
          openedSessions.delete(sessionId);
          return { sessionId, status: 'closed' } as any;
        }
        if (req.operation === 'generate-one' && req.orbitalKey) {
          if (asyncOrbitalEventMode) {
            setTimeout(() => {
              for (const fn of [...orbitalListeners]) {
                fn({
                  event: 'state',
                  seq: 2,
                  sessionId,
                  sourceRevision: meta?.sourceRevision ?? '',
                  gridKey: 'grid-async',
                  status: 'completed',
                  completedKeys: [req.orbitalKey!],
                  total: meta?.orbitals.length ?? 8,
                  currentKey: null,
                  cacheBytes: 1024
                });
              }
            }, 15);
            return {
              event: 'state',
              seq: 1,
              sessionId,
              sourceRevision: meta?.sourceRevision ?? '',
              gridKey: 'grid-async',
              status: 'queued',
              completedKeys: [],
              total: meta?.orbitals.length ?? 8,
              currentKey: req.orbitalKey,
              cacheBytes: 0
            };
          }
          return {
            event: 'state',
            seq: 1,
            sessionId,
            sourceRevision: meta?.sourceRevision ?? '',
            gridKey: 'grid-sync',
            status: 'completed',
            completedKeys: [req.orbitalKey],
            total: meta?.orbitals.length ?? 8,
            currentKey: null,
            cacheBytes: 1024
          };
        }
        return { sessionId, status: 'stopped', completedKeys: [] } as any;
      },
      async readOrbitalField(sessionId, orbitalKey) {
        const meta = openedSessions.get(sessionId)!;
        const dims: [number, number, number] = [4, 4, 4];
        const values = new Float64Array(64);
        values[0] = 0.08;
        values[1] = -0.08;
        return {
          sessionId,
          sourceRevision: meta.sourceRevision,
          gridKey: asyncOrbitalEventMode ? 'grid-async' : 'grid-sync',
          orbitalKey,
          grid: {
            coordinateUnit: 'bohr',
            origin: [-4, -4, -4],
            axes: [
              [0.5, 0, 0],
              [0, 0.5, 0],
              [0, 0, 0.5]
            ],
            dimensions: dims,
            ordering: 'z-fastest'
          },
          valueUnit: 'bohr^-3/2',
          values
        };
      },
      async openReactivitySession(req) {
        openedReactivitySessions.push(req.sessionId);
        if ('sourceId' in req.source && typeof req.source.sourceId === 'string') {
          reactivitySessionSources.set(req.sessionId, req.source.sourceId);
        }
        return {
          sessionId: req.sessionId,
          context: req.source.context,
          atomCount: 3,
          frontier: [],
          capabilities: { orbitalDisplay: true, global: true, condensed: true, reasons: [] },
          notices: []
        };
      },
      async analyzeReactivity(sessionId, req) {
        const homoH = -0.295;
        const lumoH = 0.042;
        const homoEv = convertEnergy({ value: homoH, unit: 'hartree' }, 'eV')!;
        const lumoEv = convertEnergy({ value: lumoH, unit: 'hartree' }, 'eV')!;
        const gap = lumoEv - homoEv;
        const mu = (homoEv + lumoEv) / 2;
        const softness = 1 / gap;
        const omega = (mu * mu) / (2 * gap);
        const NNu = homoEv - convertEnergy({ value: -0.335198, unit: 'hartree' }, 'eV')!;
        const fRows = [
          { sourceIndex: 1, element: 'O', fPlus: 0.2, fMinus: 0.7 },
          { sourceIndex: 2, element: 'H', fPlus: 0.4, fMinus: 0.15 },
          { sourceIndex: 3, element: 'H', fPlus: 0.4, fMinus: 0.15 }
        ];
        return {
          stamp: req.stamp,
          approximation: 'frozen-orbital',
          partition: 'hirshfeld',
          capabilities: { orbitalDisplay: true, global: true, condensed: true, reasons: [] },
          notices: [],
          frontier: [
            {
              spin: 'restricted',
              homoDegeneracy: 1,
              lumoDegeneracy: 1,
              homo: {
                key: 'restricted:5',
                spin: 'restricted',
                ordinal: 5,
                sourceIndex: 5,
                nativeIndex: 5,
                energyHartree: homoH,
                energyEV: homoEv,
                occupation: 2
              },
              lumo: {
                key: 'restricted:6',
                spin: 'restricted',
                ordinal: 6,
                sourceIndex: 6,
                nativeIndex: 6,
                energyHartree: lumoH,
                energyEV: lumoEv,
                occupation: 0
              }
            }
          ],
          globalMetrics: {
            homo: { value: homoEv, unit: 'eV' },
            lumo: { value: lumoEv, unit: 'eV' },
            gap: { value: gap, unit: 'eV' },
            ip: { value: -homoEv, unit: 'eV' },
            ea: { value: -lumoEv, unit: 'eV' },
            chi: { value: -mu, unit: 'eV' },
            mu: { value: mu, unit: 'eV' },
            eta: { value: gap, unit: 'eV' },
            softness: { value: softness, unit: 'eV^-1' },
            omega: { value: omega, unit: 'eV' },
            NNu: { value: NNu, unit: 'eV' }
          },
          atoms: fRows.map(r => {
            const fZero = (r.fPlus + r.fMinus) / 2;
            const dual = r.fPlus - r.fMinus;
            return {
              sourceIndex: r.sourceIndex,
              element: r.element,
              fPlus: r.fPlus,
              fMinus: r.fMinus,
              fZero,
              dual,
              omega: omega * r.fPlus,
              NNu: NNu * r.fMinus,
              sPlus: softness * r.fPlus,
              sMinus: softness * r.fMinus,
              sZero: softness * fZero
            };
          }),
          integrals: [
            {
              orbitalKey: 'restricted:5',
              sourceIndex: 5,
              rawSum: 1,
              normalizedPrintedSum: 1,
              rawSumUnit: 'fraction',
              nativeNormalization: true,
              printedFractionPrecision: 0.00001
            },
            {
              orbitalKey: 'restricted:6',
              sourceIndex: 6,
              rawSum: 1,
              normalizedPrintedSum: 1,
              rawSumUnit: 'fraction',
              nativeNormalization: true,
              printedFractionPrecision: 0.00001
            }
          ],
          provenance: {
            sourceId: reactivitySessionSources.get(sessionId) ?? req.stamp.sourceId,
            sourceRevision: req.stamp.sourceRevision,
            sourceName: 'water.fchk',
            backend: { name: 'Multiwfn', version: '3.8', threads: 4 },
            parameters: {
              hardnessConvention: 'eta=IP-EA;S=1/eta;omega=mu^2/(2eta)',
              tceHomoHartree: -0.335198,
              tceReferenceLevel: 'B3LYP/6-31G*',
              tceLevelMatch: 'unmatched',
              degeneracyScreenEV: 0.01,
              orbitalRepresentation: 'canonical',
              orbitalRepresentationEvidence: 'fchk'
            },
            rawArtifacts: [
              {
                role: 'native-output',
                name: 'fmo.txt',
                revision: 'a'.repeat(64),
                bytes: 512
              }
            ],
            settlement: 'native-settled'
          }
        };
      },
      async closeReactivitySession(sessionId) {
        closedReactivitySessions.push(sessionId);
        return { closed: true } as any;
      }
    };

    const dispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => false,
      getDesktop: () => mockDesktop,
      getCallbacks: () => ({
        syncAnalysisPresentation: (documentId, opts) => {
          syncedPresentations.push({ documentId, ...opts });
          const view = registry.getSnapshot().views.find(v => v.documentId === documentId);
          if (view) registry.activate(view.id);
          registry.setModule('analysis');
        }
      })
    });

    // 1. Open Gaussian TS+Freq+TD log in Result Analysis
    const openLogReply = await dispatcher.handleRequest({
      requestId: 'p7-open-log',
      action: 'frontend.openResultAnalysis',
      payload: {
        source: {
          name: 'water_ts_freq.log',
          text: SAMPLE_GAUSSIAN_FREQ_LOG
        },
        panel: 'vibrations',
        label: 'Water-TS-Analysis'
      }
    });
    expect(openLogReply.error).toBeUndefined();
    expect(openLogReply.ok).toBe(true);
    const logSummary = openLogReply.result as Record<string, any>;
    const analysisDocId = logSummary.documentId as string;
    expect(logSummary.label).toBe('Water-TS-Analysis');
    expect(logSummary.engine).toBe('gaussian');
    expect(logSummary.formula).toBe('H2O');
    expect(logSummary.energy.hartree).toBeCloseTo(-76.3849125, 6);
    expect(logSummary.vibrations.available).toBe(true);
    expect(logSummary.vibrations.imaginaryCount).toBe(1);
    expect(logSummary.vibrations.imaginaryFrequenciesCm1).toEqual([-412.35]);
    expect(logSummary.thermochemistry.available).toBe(true);
    expect(logSummary.excitedStates.count).toBe(2);
    expect(logSummary.printedCharges.available).toBe(true);
    expect(logSummary.wavefunction.available).toBe(false);
    expect(registry.getSnapshot().module).toBe('analysis');
    expect(syncedPresentations.at(-1)?.panel).toBe('vibrations');

    // Out-of-range frameIndex must fail cleanly with INVALID_FRAME_INDEX
    const badFrameReply = await dispatcher.handleRequest({
      requestId: 'p7-bad-frame',
      action: 'frontend.openResultAnalysis',
      payload: {
        documentId: analysisDocId,
        frameIndex: 99
      }
    });
    expect(badFrameReply.ok).toBe(false);
    expect(badFrameReply.error?.code).toBe('INVALID_FRAME_INDEX');

    // Wavefunction analysis before attaching .fchk must fail with MCP_WAVEFUNCTION_UNAVAILABLE
    const wfBeforeAttach = await dispatcher.handleRequest({
      requestId: 'p7-wf-before-fchk',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'charges',
        method: 'resp'
      }
    });
    expect(wfBeforeAttach.ok).toBe(false);
    expect(wfBeforeAttach.error?.code).toBe('MCP_WAVEFUNCTION_UNAVAILABLE');

    // Export printed Mulliken charges before running Multiwfn!
    const exportPrintedTsv = await dispatcher.handleRequest({
      requestId: 'p7-export-printed',
      action: 'frontend.exportArtifact',
      payload: {
        documentId: analysisDocId,
        kind: 'analysis-table',
        outputPath: '/tmp/printed_mulliken.tsv'
      }
    });
    expect(exportPrintedTsv.ok).toBe(true);
    expect((exportPrintedTsv.result as any).analysisKind).toBe('printed-charges');
    expect((exportPrintedTsv.result as any).content).toContain('-0.6124');

    // 2. Pair companion .fchk onto existing analysis document!
    const attachFchkReply = await dispatcher.handleRequest({
      requestId: 'p7-attach-fchk',
      action: 'frontend.openResultAnalysis',
      payload: {
        documentId: analysisDocId,
        source: {
          name: 'water_ts_sp.fchk',
          text: SAMPLE_WATER_FCHK
        },
        panel: 'charges'
      }
    });
    expect(attachFchkReply.ok).toBe(true);
    const pairedSummary = attachFchkReply.result as Record<string, any>;
    expect(pairedSummary.documentId).toBe(analysisDocId);
    expect(pairedSummary.wavefunction.available).toBe(true);
    expect(pairedSummary.wavefunction.pairedWithCurrentFrame).toBe(true);
    expect(pairedSummary.wavefunction.format).toBe('fchk');

    // 3. Multiwfn not configured guard
    multiwfnConfigured = false;
    const unconfiguredReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-unconfigured',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'charges',
        method: 'resp'
      }
    });
    expect(unconfiguredReply.ok).toBe(false);
    expect(unconfiguredReply.error?.code).toBe('MCP_MULTIWFN_NOT_CONFIGURED');
    multiwfnConfigured = true;

    // 4. Run RESP & Bader charges, Mayer bond orders, HOMO composition, LUMO 3D orbital, and FMO reactivity
    const closedBefore = closedOrbitalSessions.length;
    const respReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-resp',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'charges',
        method: 'resp',
        renderInViewport: true
      }
    });
    expect(respReply.ok).toBe(true);
    const respRes = respReply.result as Record<string, any>;
    expect(respRes.method).toBe('resp');
    expect(respRes.atoms[0].charge).toBeCloseTo(-0.824, 4);
    expect(closedOrbitalSessions.length).toBe(closedBefore + 1);
    expect(syncedPresentations.at(-1)?.overlay?.chargeResult?.method).toBe('resp');

    const baderReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-bader',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'charges',
        method: 'bader'
      }
    });
    expect(baderReply.ok).toBe(true);
    expect((baderReply.result as any).atoms[0].charge).toBeCloseTo(-1.142, 4);

    const mayerReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-mayer',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'bond-orders',
        method: 'mayer'
      }
    });
    expect(mayerReply.ok).toBe(true);
    expect((mayerReply.result as any).significantBondCount).toBe(2);
    expect(syncedPresentations.at(-1)?.overlay?.bondResult?.method).toBe('mayer');

    const compReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-comp',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'composition',
        method: 'scpa',
        orbitalKey: 'HOMO'
      }
    });
    expect(compReply.ok).toBe(true);
    expect((compReply.result as any).orbitalKey).toBe('restricted:5');
    expect((compReply.result as any).angularPercent.p).toBeCloseTo(79.5, 2);
    expect(syncedPresentations.at(-1)?.overlay?.compositionResult?.orbitalKey).toBe('restricted:5');

    // Orbitals with renderInViewport: false (table only) & renderInViewport: true (async event 3D grid)
    const orbTableReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-orb-table',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'orbitals',
        renderInViewport: false
      }
    });
    expect(orbTableReply.ok).toBe(true);
    expect((orbTableReply.result as any).orbitalCount).toBe(8);
    expect((orbTableReply.result as any).frontierOrbitals.gapEv).toBeGreaterThan(9);

    asyncOrbitalEventMode = true;
    const orbGridReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-orb-grid',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'orbitals',
        orbitalKey: 'LUMO',
        isovalue: 0.04,
        renderInViewport: true
      }
    });
    asyncOrbitalEventMode = false;
    expect(orbGridReply.ok).toBe(true);
    expect((orbGridReply.result as any).selectedOrbital.key).toBe('restricted:6');
    expect((orbGridReply.result as any).grid.pointCount).toBe(64);
    expect(syncedPresentations.at(-1)?.overlay?.orbitalField?.orbitalKey).toBe('restricted:6');
    expect(syncedPresentations.at(-1)?.overlay?.orbitalIsovalue).toBe(0.04);

    // Conceptual DFT reactivity
    const reactReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-reactivity',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'reactivity',
        method: 'dual'
      }
    });
    expect(reactReply.error).toBeUndefined();
    expect(reactReply.ok).toBe(true);
    expect((reactReply.result as any).atoms[0].dual).toBeCloseTo(-0.5, 4);
    expect(typeof (reactReply.result as any).atoms[0].sPlus).toBe('number');
    expect(typeof (reactReply.result as any).atoms[0].sMinus).toBe('number');
    expect(typeof (reactReply.result as any).atoms[0].sZero).toBe('number');
    expect(closedReactivitySessions.length).toBe(openedReactivitySessions.length);
    expect(syncedPresentations.at(-1)?.overlay?.reactivityResult?.partition).toBe('hirshfeld');

    // 5. Molden Bader guard & timeout cancellation guard
    const openMoldenReply = await dispatcher.handleRequest({
      requestId: 'p7-open-molden',
      action: 'frontend.openResultAnalysis',
      payload: {
        source: {
          name: 'water_orca.molden',
          text: SAMPLE_WATER_MOLDEN
        }
      }
    });
    expect(openMoldenReply.ok).toBe(true);
    const moldenDocId = (openMoldenReply.result as any).documentId as string;

    const moldenBaderFail = await dispatcher.handleRequest({
      requestId: 'p7-molden-bader-fail',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: moldenDocId,
        kind: 'charges',
        method: 'bader'
      }
    });
    expect(moldenBaderFail.ok).toBe(false);
    expect(moldenBaderFail.error?.code).toBe('MCP_METHOD_NOT_AVAILABLE');

    simulateSlowAnalysisMs = 1200;
    const timeoutReply = await dispatcher.handleRequest({
      requestId: 'p7-wf-timeout',
      action: 'frontend.runWavefunctionAnalysis',
      payload: {
        documentId: analysisDocId,
        kind: 'charges',
        method: 'cm5',
        timeoutSeconds: 0.05 as any
      }
    });
    simulateSlowAnalysisMs = 0;
    expect(timeoutReply.ok).toBe(false);
    expect(timeoutReply.error?.code).toBe('MCP_WAVEFUNCTION_TIMEOUT');
    expect(cancelledAnalyses.length).toBeGreaterThanOrEqual(1);

    // 6. Export structure (xyz, cif, poscar), input-script (gjf, inp), and cached analysis-table (resp, mayer, reactivity)
    const exportRespTsv = await dispatcher.handleRequest({
      requestId: 'p7-export-resp',
      action: 'frontend.exportArtifact',
      payload: {
        documentId: analysisDocId,
        kind: 'analysis-table',
        analysisKind: 'charges',
        method: 'resp',
        outputPath: '/tmp/water_resp.tsv'
      }
    });
    expect(exportRespTsv.ok).toBe(true);
    expect((exportRespTsv.result as any).content).toContain('method=resp');
    expect((exportRespTsv.result as any).content).toContain('-0.824');

    const exportReactTsv = await dispatcher.handleRequest({
      requestId: 'p7-export-react',
      action: 'frontend.exportArtifact',
      payload: {
        documentId: analysisDocId,
        kind: 'analysis-table',
        analysisKind: 'reactivity',
        outputPath: '/tmp/water_fmo.tsv'
      }
    });
    expect(exportReactTsv.ok).toBe(true);
    expect((exportReactTsv.result as any).content).toContain('FMO 反应性');

    const exportXyz = await dispatcher.handleRequest({
      requestId: 'p7-export-xyz',
      action: 'frontend.exportArtifact',
      payload: {
        documentId: analysisDocId,
        kind: 'structure',
        outputPath: '/tmp/water_opt.xyz'
      }
    });
    expect(exportXyz.ok).toBe(true);
    expect((exportXyz.result as any).format).toBe('xyz');
    expect((exportXyz.result as any).atomCount).toBe(3);

    // POSCAR on non-periodic molecule must fail with MCP_STRUCTURE_EXPORT_FAILED
    const exportPoscarFail = await dispatcher.handleRequest({
      requestId: 'p7-export-poscar-fail',
      action: 'frontend.exportArtifact',
      payload: {
        documentId: analysisDocId,
        kind: 'structure',
        format: 'poscar',
        outputPath: '/tmp/POSCAR'
      }
    });
    expect(exportPoscarFail.ok).toBe(false);
    expect(exportPoscarFail.error?.code).toBe('MCP_STRUCTURE_EXPORT_FAILED');

    // Periodic crystal POSCAR & CIF export + Gaussian .gjf input-script export
    const crystalDoc = registry.addDocument(
      {
        id: 'si-cell',
        name: 'Si2',
        format: 'cif',
        charge: 0,
        multiplicity: 1,
        notes: [],
        cell: {
          vectors: [
            [5.43, 0, 0],
            [0, 5.43, 0],
            [0, 0, 5.43]
          ],
          pbc: [true, true, true]
        },
        atoms: [
          { id: 'si1', element: 'Si', x: 0, y: 0, z: 0 },
          { id: 'si2', element: 'Si', x: 1.3575, y: 1.3575, z: 1.3575 }
        ],
        bonds: []
      },
      'Si-Crystal'
    );
    const exportPoscarOk = await dispatcher.handleRequest({
      requestId: 'p7-export-poscar-ok',
      action: 'frontend.exportArtifact',
      payload: {
        documentId: crystalDoc.id,
        kind: 'structure',
        outputPath: '/tmp/Si.poscar'
      }
    });
    expect(exportPoscarOk.ok).toBe(true);
    expect((exportPoscarOk.result as any).format).toBe('poscar');
    expect((exportPoscarOk.result as any).withCell).toBe(true);
    expect((exportPoscarOk.result as any).content).toContain('Cartesian');

    const molDoc = registry.addDocument(
      {
        id: 'mol-h2o',
        name: 'water',
        format: 'xyz',
        charge: 0,
        multiplicity: 1,
        notes: [],
        atoms: [
          { id: 'o1', element: 'O', x: 0, y: 0, z: 0.1173 },
          { id: 'h1', element: 'H', x: 0, y: 0.7572, z: -0.4692 },
          { id: 'h2', element: 'H', x: 0, y: -0.7572, z: -0.4692 }
        ],
        bonds: []
      },
      'Water-Input'
    );
    await dispatcher.handleRequest({
      requestId: 'p7-cfg-gjf',
      action: 'frontend.configureCalculation',
      payload: {
        documentId: molDoc.id,
        engine: 'gaussian',
        settings: { task: 'opt', method: 'b3lyp', basis: 'def2SVP', charge: 0, multiplicity: 1, cores: 8, memoryGB: 16 }
      }
    });
    const exportGjfOk = await dispatcher.handleRequest({
      requestId: 'p7-export-gjf',
      action: 'frontend.exportArtifact',
      payload: {
        documentId: molDoc.id,
        kind: 'input-script',
        outputPath: '/tmp/water_opt.gjf'
      }
    });
    expect(exportGjfOk.ok).toBe(true);
    expect((exportGjfOk.result as any).format).toBe('gjf');
    expect((exportGjfOk.result as any).content).toContain('b3lyp/def2SVP');
    expect((exportGjfOk.result as any).content).toContain('#p opt');

    // Task snapshot opening via openTaskSnapshotInAnalysis callback
    let openedSnapTaskId = '';
    const snapDispatcher = createMcpFrontendDispatcher({
      getRegistry: () => registry,
      isTaskCenterOpen: () => true,
      getDesktop: () => mockDesktop,
      getCallbacks: () => ({
        openTaskSnapshotInAnalysis: async taskId => {
          openedSnapTaskId = taskId;
          return { documentId: analysisDocId };
        },
        getAnalysisTarget: () => ({
          documentId: analysisDocId,
          label: 'Water-TS-Analysis',
          entry: registry.getSnapshot().documents.find(d => d.id === analysisDocId) ?? null,
          currentFrameIndex: 0,
          currentStructure: molDoc.store.getSnapshot().draft.structure,
          trajectoryResult: registry.getSnapshot().documents.find(d => d.id === analysisDocId)?.analysisBinding?.result ?? null
        }),
        syncAnalysisPresentation: (documentId, opts) => {
          syncedPresentations.push({ documentId, ...opts });
        }
      })
    });
    const snapReply = await snapDispatcher.handleRequest({
      requestId: 'p7-open-task-snap',
      action: 'frontend.openResultAnalysis',
      payload: {
        source: { taskId: 'task-center-99' },
        panel: 'energy'
      }
    });
    expect(snapReply.ok).toBe(true);
    expect(openedSnapTaskId).toBe('task-center-99');
  });

  it('covers Phase 7 Round 1 edge cases: generatedXtb policy & spin stripping, orbitals/reactivity/late-fork timeout & zero session/listener leaks, Link1 Opt+Freq continuations, ORCA/FCHK energy keys, sourceRevision cache invalidation, and strict pairing rollback', async () => {
    const sampleRev = 'b'.repeat(64);
    const metaBase = makeWaterMetadata('xtb-src-1', 'xtb.molden', SAMPLE_WATER_MOLDEN, 'molden');
    const openShellPolicy = {
      schema: 'sciyue-generated-analysis-policy/v1' as const,
      policyVersion: GENERATED_XTB_POLICY_VERSION,
      sourceRevision: sampleRev,
      requestedUhf: 1,
      sourceSpinResolution: 'spin-summed' as const,
      chargeMethods: ['mulliken', 'cm5', 'hirshfeld'] as const,
      compositionMethods: ['mulliken', 'scpa'] as const,
      bondOrderMethods: ['laplacian'] as const,
      spinPopulation: false as const,
      spinDensity: false as const,
      independentAlphaBeta: false as const,
      realSpaceMethods: ['esp', 'alie'] as const
    };
    const xtbMeta: WavefunctionMetadata = {
      ...metaBase,
      sourceRevision: sampleRev,
      analysisPolicy: openShellPolicy
    };

    const activeSessions = new Set<string>(['parent-xtb']);
    const activeReactivity = new Set<string>();
    const activeOrbitalListeners = new Set<(event: any) => void>();
    const stoppedOrbitalSessions: string[] = [];
    const cancelledReactivitySessions: string[] = [];
    let delayForkMs = 0;
    let delayOrbitalGenerateMs = 0;
    let delayReactivityMs = 0;

    const mockXtbDesktop: DesktopBridge = {
      async orbitalBackendInfo() {
        return { configured: true, path: '/opt/multiwfn/multiwfn' };
      },
      async forkOrbitalSession(_parent, instanceId) {
        const childId = `fork-${instanceId}`;
        if (delayForkMs > 0) {
          await new Promise(r => setTimeout(r, delayForkMs));
        }
        activeSessions.add(childId);
        return { sessionId: childId, metadata: xtbMeta };
      },
      async closeOrbitalSession(sessionId) {
        activeSessions.delete(sessionId);
        return { sessionId, status: 'closed' } as any;
      },
      async analyzeWavefunction(sessionId, req) {
        if (req.kind === 'charges') {
          return {
            sessionId,
            sourceRevision: sampleRev,
            geometryIdentity: 'geom-xtb',
            backend: { name: 'Multiwfn', version: '3.8', threads: 2 },
            warnings: [],
            kind: 'charges',
            method: req.method,
            unit: 'e',
            quantity: 'net-charge',
            sum: 0,
            spinAvailable: true,
            atoms: [
              { atomId: xtbMeta.structure.atoms[0].id!, sourceIndex: 1, element: 'O', value: -0.62, spinPopulation: 0.42 },
              { atomId: xtbMeta.structure.atoms[1].id!, sourceIndex: 2, element: 'H', value: 0.31, spinPopulation: 0.05 },
              { atomId: xtbMeta.structure.atoms[2].id!, sourceIndex: 3, element: 'H', value: 0.31, spinPopulation: 0.05 }
            ]
          };
        }
        return {
          sessionId,
          sourceRevision: sampleRev,
          geometryIdentity: 'geom-xtb',
          backend: { name: 'Multiwfn', version: '3.8', threads: 2 },
          warnings: [],
          kind: 'bond-orders',
          method: 'laplacian',
          unit: 'dimensionless',
          bonds: [
            {
              atomId1: xtbMeta.structure.atoms[0].id!,
              atomId2: xtbMeta.structure.atoms[1].id!,
              sourceIndex1: 1,
              sourceIndex2: 2,
              value: 0.88
            }
          ]
        };
      },
      async planOrbitalSession(_sessionId, req) {
        const pts = req.grid.dimensions.reduce((a, b) => a * b, 1);
        return {
          gridKey: 'g1',
          pointCount: pts,
          orbitalCount: 8,
          cacheBytes: pts * 8,
          workingBytes: pts * 8,
          totalBytes: pts * 16,
          withinBudget: true,
          mode: req.mode
        };
      },
      onOrbitalEvent(fn) {
        activeOrbitalListeners.add(fn);
        return () => activeOrbitalListeners.delete(fn);
      },
      async commandOrbitals(sessionId, req) {
        if (req.operation === 'stop') {
          stoppedOrbitalSessions.push(sessionId);
          return { sessionId, status: 'stopped', completedKeys: [] } as any;
        }
        if (req.operation === 'close') {
          activeSessions.delete(sessionId);
          return { sessionId, status: 'closed' } as any;
        }
        if (delayOrbitalGenerateMs > 0) {
          await new Promise(r => setTimeout(r, delayOrbitalGenerateMs));
        }
        return {
          event: 'state',
          seq: 1,
          sessionId,
          sourceRevision: sampleRev,
          gridKey: 'g1',
          status: 'queued',
          completedKeys: [],
          total: 8,
          currentKey: req.orbitalKey ?? null,
          cacheBytes: 0
        };
      },
      async readOrbitalField(sessionId, orbitalKey) {
        return {
          sessionId,
          sourceRevision: sampleRev,
          gridKey: 'g1',
          orbitalKey,
          grid: {
            coordinateUnit: 'bohr',
            origin: [-2, -2, -2],
            axes: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1]
            ],
            dimensions: [2, 2, 2],
            ordering: 'z-fastest'
          },
          valueUnit: 'bohr^-3/2',
          values: new Float64Array(8)
        };
      },
      async openReactivitySession(req) {
        if (delayReactivityMs > 0) {
          await new Promise(r => setTimeout(r, delayReactivityMs));
        }
        activeReactivity.add(req.sessionId);
        return {
          sessionId: req.sessionId,
          context: req.source.context,
          atomCount: 3,
          frontier: [],
          capabilities: { orbitalDisplay: true, global: true, condensed: true, reasons: [] },
          notices: []
        };
      },
      async analyzeReactivity() {
        await new Promise(r => setTimeout(r, 200));
        throw new Error('Should have timed out');
      },
      async cancelReactivity(sessionId) {
        cancelledReactivitySessions.push(sessionId);
      },
      async closeReactivitySession(sessionId) {
        activeReactivity.delete(sessionId);
        return { closed: true } as any;
      }
    };

    const tableStore = new McpAnalysisTableStore();
    const xtbDoc: any = {
      id: 'doc-xtb-gen',
      result: {
        id: 'doc-xtb-gen',
        engine: 'xtb',
        kind: 'single-point',
        status: 'completed',
        label: 'xtb-sp',
        source: { id: 'xtb-src-1', name: 'xtb.molden', size: 128 },
        jobIndex: 0,
        initialStructure: xtbMeta.structure,
        frames: [
          {
            index: 0,
            sourceStep: 0,
            time: null,
            energy: { value: -5.07, unit: 'hartree' },
            convergence: []
          }
        ],
        messages: [],
        getFrame: async () => xtbMeta.structure,
        dispose: () => undefined
      },
      wavefunction: {
        nativeSessionId: 'parent-xtb',
        readSourceText: async () => ({
          name: 'xtb.molden',
          text: SAMPLE_WATER_MOLDEN,
          sourceId: 'xtb-src-1',
          sourceRevision: sampleRev
        }),
        source: {
          kind: 'molden',
          metadata: xtbMeta,
          generatedXtb: {
            artifactId: 'art-1',
            sessionId: 'sess-1',
            stamp: {
              documentId: 'doc-xtb-gen',
              revision: 0,
              graphFingerprint: 'g',
              coordinatesFingerprint: 'c',
              constraintsFingerprint: 'k'
            },
            runIdentity: { taskId: 't1', runId: 'r1' }
          },
          result: {
            id: 'wf-res',
            engine: 'xtb',
            kind: 'single-point',
            status: 'completed',
            label: 'xtb.molden',
            source: { id: 'xtb-src-1', name: 'xtb.molden', size: 128 },
            jobIndex: 0,
            initialStructure: xtbMeta.structure,
            frames: [],
            messages: [],
            getFrame: async () => xtbMeta.structure,
            dispose: () => undefined
          },
          results: []
        }
      },
      wavefunctionFrameIndex: 0
    };

    // 1. generatedXtb policy: bader rejected, reactivity rejected, open-shell mayer rejected, laplacian allowed, spinPopulation stripped
    await expect(
      executeWavefunctionAnalysis({
        documentId: 'doc-xtb-gen',
        document: xtbDoc,
        structure: xtbMeta.structure,
        frameIndex: 0,
        desktop: mockXtbDesktop,
        tableStore,
        overlaySerial: 1,
        params: { kind: 'charges', method: 'bader', renderInViewport: true }
      })
    ).rejects.toMatchObject({ code: 'MCP_METHOD_NOT_AVAILABLE' });

    await expect(
      executeWavefunctionAnalysis({
        documentId: 'doc-xtb-gen',
        document: xtbDoc,
        structure: xtbMeta.structure,
        frameIndex: 0,
        desktop: mockXtbDesktop,
        tableStore,
        overlaySerial: 2,
        params: { kind: 'reactivity', method: 'dual', renderInViewport: true }
      })
    ).rejects.toMatchObject({ code: 'MCP_METHOD_NOT_AVAILABLE' });

    await expect(
      executeWavefunctionAnalysis({
        documentId: 'doc-xtb-gen',
        document: xtbDoc,
        structure: xtbMeta.structure,
        frameIndex: 0,
        desktop: mockXtbDesktop,
        tableStore,
        overlaySerial: 3,
        params: { kind: 'bond-orders', method: 'mayer', renderInViewport: true }
      })
    ).rejects.toMatchObject({ code: 'MCP_METHOD_NOT_AVAILABLE' });

    const xtbLaplacian = await executeWavefunctionAnalysis({
      documentId: 'doc-xtb-gen',
      document: xtbDoc,
      structure: xtbMeta.structure,
      frameIndex: 0,
      desktop: mockXtbDesktop,
      tableStore,
      overlaySerial: 4,
      params: { kind: 'bond-orders', method: 'laplacian', renderInViewport: true }
    });
    expect(xtbLaplacian.response.method).toBe('laplacian');

    const xtbCharges = await executeWavefunctionAnalysis({
      documentId: 'doc-xtb-gen',
      document: xtbDoc,
      structure: xtbMeta.structure,
      frameIndex: 0,
      desktop: mockXtbDesktop,
      tableStore,
      overlaySerial: 5,
      params: { kind: 'charges', method: 'cm5', renderInViewport: true }
    });
    expect(xtbCharges.response.spinAvailable).toBe(false);
    expect((xtbCharges.response.atoms as any[])[0].spinPopulation).toBeUndefined();
    expect(activeSessions.size).toBe(1);

    // 2. Timeout during late forkOrbitalSession, orbitals waitForCompletion, and reactivity openReactivitySession leaves ZERO leaked sessions or listeners
    delayForkMs = 90;
    await expect(
      executeWavefunctionAnalysis({
        documentId: 'doc-xtb-gen',
        document: xtbDoc,
        structure: xtbMeta.structure,
        frameIndex: 0,
        desktop: mockXtbDesktop,
        tableStore,
        overlaySerial: 6,
        params: { kind: 'charges', method: 'cm5', renderInViewport: true, timeoutSeconds: 0.02 }
      })
    ).rejects.toMatchObject({ code: 'MCP_WAVEFUNCTION_TIMEOUT' });
    await new Promise(r => setTimeout(r, 110));
    delayForkMs = 0;
    expect(activeSessions.size).toBe(1);

    await expect(
      executeWavefunctionAnalysis({
        documentId: 'doc-xtb-gen',
        document: xtbDoc,
        structure: xtbMeta.structure,
        frameIndex: 0,
        desktop: mockXtbDesktop,
        tableStore,
        overlaySerial: 7,
        params: { kind: 'orbitals', orbitalKey: 'HOMO', renderInViewport: true, timeoutSeconds: 0.03 }
      })
    ).rejects.toMatchObject({ code: 'MCP_WAVEFUNCTION_TIMEOUT' });
    expect(stoppedOrbitalSessions.length).toBe(1);
    expect(activeOrbitalListeners.size).toBe(0);
    expect(activeSessions.size).toBe(1);

    const nonXtbDoc: any = {
      ...xtbDoc,
      wavefunction: {
        ...xtbDoc.wavefunction,
        source: {
          ...xtbDoc.wavefunction.source,
          generatedXtb: undefined
        }
      }
    };
    delayReactivityMs = 80;
    await expect(
      executeWavefunctionAnalysis({
        documentId: 'doc-xtb-gen',
        document: nonXtbDoc,
        structure: xtbMeta.structure,
        frameIndex: 0,
        desktop: mockXtbDesktop,
        tableStore,
        overlaySerial: 8,
        params: { kind: 'reactivity', method: 'dual', renderInViewport: true, timeoutSeconds: 0.02 }
      })
    ).rejects.toMatchObject({ code: 'MCP_WAVEFUNCTION_TIMEOUT' });
    await new Promise(r => setTimeout(r, 100));
    delayReactivityMs = 0;
    expect(cancelledReactivitySessions.length).toBe(1);
    expect(activeReactivity.size).toBe(0);

    // 3. McpAnalysisTableStore sourceRevision provenance check rejects stale tables after wavefunction replacement
    expect(
      tableStore.find('doc-xtb-gen', {
        kind: 'charges',
        expectedSourceRevision: sampleRev
      })
    ).not.toBeNull();
    expect(
      tableStore.find('doc-xtb-gen', {
        kind: 'charges',
        expectedSourceRevision: 'c'.repeat(64)
      })
    ).toBeNull();
    expect(
      tableStore.find('doc-xtb-gen', {
        kind: 'charges',
        expectedSourceRevision: null
      })
    ).toBeNull();

    const docWithReplacedWave: any = {
      ...xtbDoc,
      wavefunction: {
        ...xtbDoc.wavefunction,
        source: {
          ...xtbDoc.wavefunction.source,
          metadata: {
            ...xtbMeta,
            sourceRevision: 'c'.repeat(64)
          }
        }
      }
    };
    expect(() =>
      buildExportArtifactPayload({
        documentId: 'doc-xtb-gen',
        postprocessDocument: docWithReplacedWave,
        tableStore,
        params: {
          kind: 'analysis-table',
          analysisKind: 'charges',
          outputPath: '/tmp/stale.tsv'
        }
      })
    ).toThrow(/No cached "charges" table found/);

    // 4. Gaussian --Link1-- Opt+Freq nativeContinuations & ORCA / FCHK energy summary keys
    const optJob: any = {
      id: 'job-opt',
      engine: 'gaussian',
      kind: 'optimization',
      status: 'completed',
      label: 'opt',
      source: { id: 'g-link1', name: 'optfreq.log', size: 512, software: 'gaussian' },
      jobIndex: 0,
      initialStructure: xtbMeta.structure,
      frames: [
        {
          index: 0,
          sourceStep: 1,
          time: null,
          energy: { value: -76.38, unit: 'hartree' },
          convergence: [{ label: 'Maximum Force', value: 0.0001, threshold: 0.00045, converged: true, unit: 'hartree/bohr' }]
        }
      ],
      scientific: {
        tasks: ['opt'],
        route: '#p B3LYP/def2SVP opt freq',
        summary: [],
        properties: [],
        thermochemistry: [],
        orbitals: [],
        atomicProperties: [],
        scfCycles: [],
        excitedStates: [],
        stability: [],
        bsse: [],
        notices: [],
        diagnostics: {
          termination: { status: 'normal', sourceLine: 10, raw: 'Normal termination' },
          scf: [{ status: 'converged', sourceLine: 5, frameIndex: 0 }],
          tasks: [{ task: 'opt', stageId: 'geometry-optimization', status: 'converged', sourceLine: 8, frameIndex: 0, raw: 'Optimization completed.' }],
          errors: [],
          fields: []
        }
      },
      messages: [],
      getFrame: async () => xtbMeta.structure,
      dispose: () => undefined
    };
    const freqJob: any = {
      ...optJob,
      id: 'job-freq',
      kind: 'frequency',
      jobIndex: 1,
      scientific: {
        ...optJob.scientific,
        tasks: ['freq'],
        thermochemistry: [{ key: 'gibbs-free-energy', label: 'Sum of electronic and thermal Free Energies', value: -76.365, sourceLine: 20, frameIndex: 0, unit: 'hartree' }],
        vibrations: {
          frameIndex: 0,
          modes: [
            { index: 1, frequency: 1620.5, irIntensity: 55.2, displacements: [] },
            { index: 2, frequency: 3650.1, irIntensity: 12.4, displacements: [] },
            { index: 3, frequency: 3755.8, irIntensity: 41.0, displacements: [] }
          ]
        }
      }
    };
    const link1Summary = summarizeAnalysisTarget({
      documentId: 'doc-link1',
      label: 'OptFreq-Link1',
      postprocessDocument: {
        id: 'doc-link1',
        result: { ...optJob, id: 'doc-link1' },
        output: {
          source: {
            kind: 'gaussian-output',
            software: 'gaussian',
            result: optJob,
            results: [optJob, freqJob],
            tasks: ['opt'],
            sha256: 'd'.repeat(64),
            observations: [],
            nativeContinuations: [
              {
                kind: 'gaussian-opt-freq',
                optimizationResultId: 'job-opt',
                frequencyResultId: 'job-freq',
                evidenceSourceLine: 12
              }
            ]
          }
        } as any
      }
    }) as Record<string, any>;
    expect(link1Summary.energy.optimizationStatus).toBe('converged');
    expect(link1Summary.vibrations.available).toBe(true);
    expect(link1Summary.vibrations.modeCount).toBe(3);
    expect(link1Summary.thermochemistry.available).toBe(true);
    expect(link1Summary.taskTypes).toEqual(['opt', 'freq']);

    // ORCA final-energy & FCHK SCF Energy fallback in summarizeAnalysisTarget
    const orcaNoFrameEnergyJob: any = {
      ...optJob,
      engine: 'orca',
      frames: [{ index: 0, sourceStep: 0, time: null, energy: null, convergence: [] }],
      scientific: {
        ...optJob.scientific,
        properties: [{ key: 'final-energy', label: 'FINAL SINGLE POINT ENERGY', value: -76.412345, sourceLine: 9, frameIndex: 0, unit: 'hartree' }]
      }
    };
    const orcaSummary = summarizeAnalysisTarget({
      documentId: 'doc-orca-e',
      label: 'ORCA-E',
      postprocessDocument: { id: 'doc-orca-e', result: orcaNoFrameEnergyJob } as any
    }) as Record<string, any>;
    expect(orcaSummary.energy.hartree).toBeCloseTo(-76.412345, 6);

    // 5. Post-import INVALID_FRAME_INDEX rollback in standaloneOpenFileInAnalysis & strict targetDocumentId pairing
    const reg2 = createWorkspaceRegistry();
    reg2.addDocument();
    const standaloneOpenedSessions = new Set<string>();
    const standaloneDesktop: DesktopBridge = {
      async openOrbitalSession(req) {
        standaloneOpenedSessions.add(req.sessionId);
        return makeWaterMetadata(req.sourceId, req.name, req.text ?? SAMPLE_WATER_FCHK, 'fchk');
      },
      async closeOrbitalSession(sessionId) {
        standaloneOpenedSessions.delete(sessionId);
        return { sessionId, status: 'closed' } as any;
      }
    };
    const disp2 = createMcpFrontendDispatcher({
      getRegistry: () => reg2,
      isTaskCenterOpen: () => false,
      getDesktop: () => standaloneDesktop
    });

    const docsBeforeInvalidFrame = reg2.getSnapshot().documents.length;
    const badImportFrame = await disp2.handleRequest({
      requestId: 'p7-bad-import-frame',
      action: 'frontend.openResultAnalysis',
      payload: {
        source: { name: 'water.fchk', text: SAMPLE_WATER_FCHK },
        frameIndex: 10
      }
    });
    expect(badImportFrame.ok).toBe(false);
    expect(badImportFrame.error?.code).toBe('INVALID_FRAME_INDEX');
    expect(badImportFrame.error?.sourceAdopted).toBeUndefined();
    expect(reg2.getSnapshot().documents.length).toBe(docsBeforeInvalidFrame);
    expect(standaloneOpenedSessions.size).toBe(0);

    // Pairing onto a plain modeling tab (no analysis output) must fail with MCP_ANALYSIS_UNAVAILABLE without creating orphan tabs
    const plainTabId = reg2.getSnapshot().documents[0].id;
    const pairOntoPlainFail = await disp2.handleRequest({
      requestId: 'p7-pair-plain-fail',
      action: 'frontend.openResultAnalysis',
      payload: {
        documentId: plainTabId,
        source: { name: 'water.fchk', text: SAMPLE_WATER_FCHK }
      }
    });
    expect(pairOntoPlainFail.ok).toBe(false);
    expect(pairOntoPlainFail.error?.code).toBe('MCP_ANALYSIS_UNAVAILABLE');
    expect(standaloneOpenedSessions.size).toBe(0);

    // Open a standalone .fchk tab, then close it via windowManage('close-document') and verify nativeSessionId is closed
    const openStandaloneFchk = await disp2.handleRequest({
      requestId: 'p7-open-fchk-close-test',
      action: 'frontend.openResultAnalysis',
      payload: {
        source: { name: 'water.fchk', text: SAMPLE_WATER_FCHK }
      }
    });
    expect(openStandaloneFchk.ok).toBe(true);
    expect(standaloneOpenedSessions.size).toBe(1);
    const fchkTabId = (openStandaloneFchk.result as any).documentId as string;

    const closeStandaloneFchk = await disp2.handleRequest({
      requestId: 'p7-close-fchk-test',
      action: 'frontend.windowManage',
      payload: {
        action: 'close-document',
        documentId: fchkTabId,
        discardUnsaved: true
      }
    });
    expect(closeStandaloneFchk.ok).toBe(true);
    expect(standaloneOpenedSessions.size).toBe(0);
  });
});
