import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { recommendCalculationMethod } from '../../../src/web/mcp/calculation-config';
import { createRecommendMethodTool, dispatchMcpFrontendRequest } from '../../../src/web/mcp/use-workspace-tools';
import { checkToolArguments } from '../../../src/web/mcp/tool-arguments';
import type { Structure } from '../../../src/core/types';

const repoRoot = path.resolve(__dirname, '../../..');

function makeDocEntry(id: string, label: string, structure: Structure, electronicStateConfirmed = true) {
  return {
    id,
    label,
    electronicStateConfirmed,
    store: {
      getSnapshot: () => ({
        electronicStateConfirmed,
        draft: { structure },
      }),
    },
  };
}

describe('ester_recommend_method & workspace integration', () => {
  it('recommends def2TZVP + GenECP + water solvent resolution for CH3I NMR across Gaussian & ORCA', () => {
    const ch3i: Structure = {
      dimension: 3,
      charge: 0,
      multiplicity: 1,
      atoms: [
        { id: 'c1', element: 'C', x: 0, y: 0, z: 0 },
        { id: 'i1', element: 'I', x: 2.14, y: 0, z: 0 },
        { id: 'h1', element: 'H', x: -0.36, y: 1.03, z: 0 },
        { id: 'h2', element: 'H', x: -0.36, y: -0.51, z: 0.89 },
        { id: 'h3', element: 'H', x: -0.36, y: -0.51, z: -0.89 },
      ],
      bonds: [
        { a: 0, b: 1, order: 1 },
        { a: 0, b: 2, order: 1 },
        { a: 0, b: 3, order: 1 },
        { a: 0, b: 4, order: 1 },
      ],
    };

    const rec = recommendCalculationMethod({
      documentId: 'doc-ch3i',
      label: 'CH3I',
      structure: ch3i,
      electronicStateConfirmed: true,
      engine: 'both',
      task: 'nmr',
      solvent: '水',
    }) as {
      formula: string;
      heavyEcpElements: string[];
      gaussian: {
        supported: boolean;
        recommended: { method: string; basis: string; requiresGenEcp: boolean; basisUpgradedReason?: string };
        solventResolution: { matched: boolean; englishName: string };
      };
      orca: {
        supported: boolean;
        recommended: { method: string; basis: string };
        solventResolution: { matched: boolean; englishName: string };
      };
    };

    expect(rec.formula).toBe('CH3I');
    expect(rec.heavyEcpElements).toEqual(['I']);
    expect(rec.gaussian.supported).toBe(true);
    expect(rec.gaussian.recommended.basis).toBe('def2TZVP');
    expect(rec.gaussian.recommended.requiresGenEcp).toBe(true);
    expect(rec.gaussian.recommended.basisUpgradedReason).toContain('6-311+G(2d,p)');
    expect(rec.gaussian.solventResolution.matched).toBe(true);
    expect(rec.gaussian.solventResolution.englishName.toLowerCase()).toBe('water');
    expect(rec.orca.supported).toBe(true);
    expect(rec.orca.solventResolution.matched).toBe(true);
  });

  it('flags periodic crystals and actinides/lanthanides with appropriate warnings', () => {
    const nacl: Structure = {
      dimension: 3,
      charge: 0,
      multiplicity: 1,
      atoms: [
        { id: 'na1', element: 'Na', x: 0, y: 0, z: 0 },
        { id: 'cl1', element: 'Cl', x: 2.82, y: 0, z: 0 },
      ],
      bonds: [],
      cell: { vectors: [[5.64, 0, 0], [0, 5.64, 0], [0, 0, 5.64]], pbc: [true, true, true] },
    };
    const rec = recommendCalculationMethod({
      documentId: 'doc-nacl',
      label: 'NaCl-Crystal',
      structure: nacl,
      electronicStateConfirmed: true,
      engine: 'gaussian',
      task: 'sp',
    }) as { isPeriodic: boolean; warnings: string[] };

    expect(rec.isPeriodic).toBe(true);
    expect(rec.warnings.some(w => w.includes('PBC') || w.includes('周期'))).toBe(true);

    const euComplex: Structure = {
      dimension: 3,
      charge: 3,
      multiplicity: 7,
      atoms: [{ id: 'eu1', element: 'Eu', x: 0, y: 0, z: 0 }],
      bonds: [],
    };
    const euRec = recommendCalculationMethod({
      documentId: 'doc-eu',
      label: 'Eu3+',
      structure: euComplex,
      electronicStateConfirmed: true,
      engine: 'both',
      task: 'sp',
    }) as { warnings: string[] };
    expect(euRec.warnings.some(w => w.includes('Eu'))).toBe(true);
  });

  it('exercises createRecommendMethodTool document lookup, error branches, schema validation, and frontend request dispatch', () => {
    const h2: Structure = {
      dimension: 3,
      charge: 0,
      multiplicity: 1,
      atoms: [
        { id: 'h1', element: 'H', x: 0, y: 0, z: 0 },
        { id: 'h2', element: 'H', x: 0, y: 0, z: 0.74 },
      ],
      bonds: [{ a: 0, b: 1, order: 1 }],
    };
    const emptyStruct: Structure = { dimension: 3, charge: 0, multiplicity: 1, atoms: [], bonds: [] };
    const badElemStruct: Structure = {
      dimension: 3,
      charge: 0,
      multiplicity: 1,
      atoms: [{ id: 'x1', element: 'Unobtainium' as never, x: 0, y: 0, z: 0 }],
      bonds: [],
    };

    const docs = [
      makeDocEntry('doc-1', 'SharedLabel', h2),
      makeDocEntry('doc-2', 'SharedLabel', h2),
      makeDocEntry('doc-empty', 'EmptyDoc', emptyStruct),
      makeDocEntry('doc-bad-el', 'BadElDoc', badElemStruct),
    ];

    const tool = createRecommendMethodTool(() => ({
      registry: {
        getSnapshot: () => ({
          activeViewId: 'view-1',
          views: [{ id: 'view-1', documentId: 'doc-1' }],
          documents: docs,
        }),
      } as never,
      project: {} as never,
    }));

    // Active view fallback + modelRef alias
    const activeResult = tool.call({ task: 'sp' }) as { ok: boolean; documentId: string };
    expect(activeResult.ok).toBe(true);
    expect(activeResult.documentId).toBe('doc-1');

    const byIdResult = tool.call({ modelRef: 'doc-2', engine: 'orca', solvent: 'water' }) as { ok: boolean; documentId: string };
    expect(byIdResult.ok).toBe(true);
    expect(byIdResult.documentId).toBe('doc-2');

    // Error branches
    expect(() => tool.call({ modelRef: 'SharedLabel' })).toThrow(/AMBIGUOUS_DOCUMENT|多个文档/);
    expect(() => tool.call({ documentId: 'does-not-exist' })).toThrow(/MCP_DOCUMENT_NOT_FOUND|未找到目标文档/);
    expect(() => tool.call({ documentId: 'doc-empty' })).toThrow(/EMPTY_STRUCTURE|空结构/);
    expect(() => tool.call({ documentId: 'doc-bad-el' })).toThrow(/未知元素 Unobtainium|UNSUPPORTED_ELEMENT/);
    expect(() => checkToolArguments(tool.inputSchema, { unexpectedFlag: true })).toThrow();

    // Runtime frontend IPC dispatcher
    expect(dispatchMcpFrontendRequest({ requestId: 'req-1', action: 'frontend.ping' }, 123)).toEqual({
      requestId: 'req-1',
      ok: true,
      result: { workbenchOnline: true, toolCount: 123 },
    });
    expect(dispatchMcpFrontendRequest({ requestId: 'req-2', action: 'legacy.removed' }, 123)).toMatchObject({
      requestId: 'req-2',
      ok: false,
      error: { code: 'UNSUPPORTED_FRONTEND_ACTION' },
    });

    // Ensure removed legacy collaboration bridge stays absent
    expect(fs.existsSync(path.join(repoRoot, 'src/web/mcp/useMcpCollaborationBridge.ts'))).toBe(false);
  });
});
