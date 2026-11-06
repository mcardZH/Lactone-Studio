import type { CitationFact } from './types';
import type {ModelDocument} from '../modeling/contracts';
import {cipGeometryInput} from '../core/stereochemistry-cip';

/** A completed scientific assignment consumed by a current, verified owner.
 * The caller owns document/epoch/geometry validation and persistence. This is
 * neither a display preference nor permission to invoke a chemical engine. */
export interface CipCitationReceipt {
  documentId: string;
  sourceId: string;
  sourceRevision?: string;
  frameId?: string;
  software: 'Indigo';
  version: string;
  operation: 'calculateCip';
  status: 'succeeded';
  assignments: readonly { atomId: string; element: 'C'; label: 'R' | 'S' }[];
}

const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());

/** Capture only actual, nonempty carbon CIP results. No engine call, source
 * reads, project mutation or inference from stereoParity/display switches. */
export function captureCipCitationFact(receipt: CipCitationReceipt): CitationFact | undefined {
  if (!receipt || receipt.software !== 'Indigo' || receipt.operation !== 'calculateCip' || receipt.status !== 'succeeded'
    || !text(receipt.documentId) || !text(receipt.sourceId) || !text(receipt.version)
    || receipt.sourceRevision !== undefined && !text(receipt.sourceRevision)
    || receipt.frameId !== undefined && !text(receipt.frameId)
    || !Array.isArray(receipt.assignments) || !receipt.assignments.length) return undefined;
  const ids = new Set<string>();
  for (const assignment of receipt.assignments) {
    if (!assignment || !text(assignment.atomId) || assignment.element !== 'C' || !['R', 'S'].includes(assignment.label)
      || ids.has(assignment.atomId)) return undefined;
    ids.add(assignment.atomId);
  }
  const assignments = receipt.assignments.map(item => ({ atomId: item.atomId, element: item.element, label: item.label }))
    .sort((a, b) => a.atomId < b.atomId ? -1 : a.atomId > b.atomId ? 1 : 0);
  const provenance = { sourceId: receipt.sourceId, sourceRevision: receipt.sourceRevision, frameId: receipt.frameId,
    software: receipt.software, version: receipt.version, operation: receipt.operation, assignments };
  return {
    // The full identity avoids a short-hash collision dropping distinct usage
    // receipts when a retained trajectory contains many actually viewed frames.
    id: `cip:${JSON.stringify([receipt.documentId, provenance])}`,
    documentId: receipt.documentId, sourceId: receipt.sourceId, frameId: receipt.frameId,
    kind: 'model-operation', retained: true, stage: 'stereochemistry-assignment',
    feature: 'stereochemistry-assignment', method: 'CIP', software: receipt.software, version: receipt.version,
    parameters: { assignmentCount: assignments.length, ...(receipt.sourceRevision === undefined ? {} : { sourceRevision: receipt.sourceRevision }) },
    evidence: [{ kind: 'metadata', locator: `${receipt.sourceId}:calculateCip`, detail: JSON.stringify(provenance) }],
    purpose: '当前文档实际完成并消费的碳原子CIP绝对构型赋值；显示开关和样式不构成使用证据',
  };
}

/** Verify a detached renderer's source against the owner's current complete
 * scientific geometry. Hashing the input invokes no stereochemistry engine. */
export async function cipReceiptSourceMatches(receipt:CipCitationReceipt,document:ModelDocument):Promise<boolean> {
  if(receipt.documentId!==document.id||receipt.sourceRevision!==String(document.revision)
    ||!/^cip-geometry-sha256:[a-f0-9]{64}$/.test(receipt.sourceId)||!captureCipCitationFact(receipt))return false;
  const input=cipGeometryInput(document.draft.structure);if(!input)return false;
  const atoms=new Map(document.draft.structure.atoms.map(atom=>[atom.id,atom]));
  if(receipt.assignments.some(row=>atoms.get(row.atomId)?.element!=='C'))return false;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input.mol));
  const actual='cip-geometry-sha256:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  return actual===receipt.sourceId;
}
