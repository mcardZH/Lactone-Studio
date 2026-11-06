import { sha256Utf8 } from '../core/file-identity';
import { ELEMENTS } from '../core/elements';
import type { Structure } from '../core/types';
import type { ModelDocument } from '../modeling/contracts';
import type { SurfaceContext } from './surface-contracts';

/** A model is its own scientific source. No synthetic output/job/frame is
 * created to enter the structure-only promolecular analysis route. */
export function assertStructureInteractionSource(structure: Structure): void {
  if (structure.cell || structure.periodicSource) throw new Error('结构 IGM/mIGM 当前仅支持孤立有限模型。');
  const atoms = structure.atoms;
  if (!atoms.length || atoms.length > 2000 || atoms.some(atom => !atom.id || !ELEMENTS.includes(atom.element)
    || ![atom.x, atom.y, atom.z].every(Number.isFinite)) || new Set(atoms.map(atom => atom.id)).size !== atoms.length)
    throw new Error('结构 IGM/mIGM 需要 1–2000 个具有唯一稳定编号和有限坐标的真实原子。');
}

export function createStructureInteractionContext(document: ModelDocument, activationEpoch = 0): SurfaceContext {
  const structure = document.draft.structure;
  assertStructureInteractionSource(structure);
  if (!document.id || !Number.isSafeInteger(document.revision) || document.revision < 0
    || !Number.isSafeInteger(activationEpoch) || activationEpoch < 0) throw new Error('结构分析缺少有效模型文档身份。');
  // Exact ordered Cartesian Å snapshot and stable IDs; bonds, camera, selection
  // and display metadata do not manufacture a quantum calculation source.
  const sourceRevision = sha256Utf8(JSON.stringify([document.id, document.revision,
    structure.atoms.map(atom => [atom.id, atom.element, atom.x, atom.y, atom.z])]));
  return { sourceId: `model:${document.id}`, sourceRevision, jobIndex: null, sourceFrameIndex: null,
    generation: 0, documentId: document.id, documentRevision: document.revision, activationEpoch };
}

export function assertStructureInteractionContext(context: SurfaceContext, structure: Structure): void {
  assertStructureInteractionSource(structure);
  if (!context.documentId || context.sourceId !== `model:${context.documentId}` || context.jobIndex !== null || context.sourceFrameIndex !== null
    || !Number.isSafeInteger(context.documentRevision) || context.documentRevision! < 0 || context.generation !== 0
    || context.sourceRevision !== sha256Utf8(JSON.stringify([context.documentId, context.documentRevision,
      structure.atoms.map(atom => [atom.id, atom.element, atom.x, atom.y, atom.z])])))
    throw new Error('结构相互作用必须绑定真实模型文档和几何快照，不能伪造量化来源。');
}

export function structureInteractionAtomOrder(structure: Structure): { atomId: string; sourceIndex: number }[] {
  assertStructureInteractionSource(structure);
  return structure.atoms.map((atom, index) => ({ atomId: atom.id!, sourceIndex: index + 1 }));
}

export const interactionUsesStructure = (method: string) => method === 'migm' || method === 'igm';
