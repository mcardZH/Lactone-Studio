import type { Bond, Structure } from '../../core/types';
import { coordinatesFingerprint, graphFingerprint } from '../../core/modeling/graph';
import { validateBondPerceptionIssues } from '../../core/bond-semantics';
import { perceivePeriodicConnections } from '../../core/periodic';
import type { ChemistryJob, ChemistryPort, ChemistryRequest, ChemistryResult, DocumentStamp } from '../contracts';

export type ImportBondPerceptionStatus = 'preserved' | 'inferred' | 'unavailable' | 'failed' | 'cancelled' | 'stale';
export interface ImportBondPerceptionResult { structure: Structure; status: ImportBondPerceptionStatus; warnings: string[]; preview?:boolean }
export interface ImportBondPerceptionOptions {
  port: ChemistryPort;
  /** Caller owns document lifetime/activation epoch, including A -> B -> A. */
  guard(): void;
  signal?: AbortSignal;
  stamp?: DocumentStamp;
}
export interface ImportBondPerceptionJob { promise: Promise<ImportBondPerceptionResult>; cancel(): void }

const stampKeys = ['documentId', 'revision', 'graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'] as const;
const checkedStamp = (actual: DocumentStamp, expected: DocumentStamp) => actual && stampKeys.every(key => actual[key] === expected[key]);

function acceptedStructure(reference: Structure, result: ChemistryResult, stamp: DocumentStamp): Structure {
  const candidate = result.structure, ids = reference.atoms.map(atom => atom.id!);
  if (result.bondPerceptionPolicy !== 'coordinate-import'
      || result.operation !== 'perceive-bonds' || !checkedStamp(result.stamp, stamp)
      || !Array.isArray(result.movableAtomIds) || JSON.stringify(result.movableAtomIds) !== JSON.stringify(ids))
    throw new Error('导入成键候选与真实请求身份不一致。');
  if (!candidate || candidate.id !== reference.id || !Array.isArray(candidate.atoms) || candidate.atoms.length !== ids.length
      || candidate.charge !== reference.charge || candidate.multiplicity !== reference.multiplicity)
    throw new Error('导入成键候选改变结构或电子态来源。');
  const declaredCharges = reference.atoms.some(atom => atom.formalCharge !== undefined);
  const atoms = reference.atoms.map((atom, i) => {
    const actual = candidate.atoms[i];
    if (!actual || actual.id !== atom.id || actual.element !== atom.element
        || actual.x !== atom.x || actual.y !== atom.y || actual.z !== atom.z)
      throw new Error('导入成键候选改变原子身份、数量或坐标。');
    // Absent charge retains the existing zero convention. Explicit protocol
    // null/string/fractional values are invalid rather than absence.
    const charge = actual.formalCharge === undefined ? 0 : actual.formalCharge;
    if (!Number.isSafeInteger(charge) || declaredCharges && charge !== (atom.formalCharge ?? 0))
      throw new Error('导入成键候选改变已有原子形式电荷。');
    return !declaredCharges && actual.formalCharge !== undefined ? { ...atom, formalCharge: charge } : { ...atom };
  });
  if (atoms.reduce((sum, atom) => sum + (atom.formalCharge ?? 0), 0) !== (reference.charge ?? 0))
    throw new Error('导入成键候选形式电荷与来源/中性识别假设不符。');
  if (!Array.isArray(candidate.bonds)) throw new Error('原生导入识别没有返回明确键表。');
  const seen = new Set<string>();
  const bonds: Bond[] = candidate.bonds.map(bond => {
    if (!Number.isInteger(bond.a) || !Number.isInteger(bond.b) || bond.a < 0 || bond.b < 0 || bond.a >= ids.length
        || bond.b >= ids.length || bond.a === bond.b || ![1, 1.5, 2, 3].includes(bond.order)
        || bond.fractional === true || bond.kind === 'coordination' || bond.image?.some(Boolean)
        || bond.aromatic !== undefined && typeof bond.aromatic !== 'boolean')
      throw new Error('导入成键候选含无效连接或未支持的化学键。');
    const pair = `${Math.min(bond.a, bond.b)}:${Math.max(bond.a, bond.b)}`;
    if (seen.has(pair)) throw new Error('导入成键候选重复连接同一原子对。');
    seen.add(pair);
    return { a: bond.a, b: bond.b, order: bond.order, ...(bond.aromatic ? { aromatic: true } : {}) };
  });
  // Preserve source/model metadata, not arbitrary extra fields from the engine.
  // Structure.molfile is the serialized graph cache reused by toMolfile.
  // It cannot accompany the newly accepted graph; source/GUI metadata remains.
  const preserved = structuredClone(reference);
  delete preserved.molfile;
  validateBondPerceptionIssues({ ...preserved, atoms, bonds, bondPerceptionIssues: candidate.bondPerceptionIssues });
  delete preserved.bondPerceptionIssues;
  return { ...preserved, atoms, bonds, bondSource: 'inferred', ...(candidate.bondPerceptionIssues?.length?{bondPerceptionIssues:structuredClone(candidate.bondPerceptionIssues)}:{}),
    notes: [...reference.notes, ...(candidate.notes ?? []).filter(note => typeof note === 'string' && !reference.notes.includes(note))] };
}

/** First-import candidates only. No store writes, hidden H, or electronic-state confirmation. */
export function startImportBondPerception(source: Structure, options: ImportBondPerceptionOptions): ImportBondPerceptionJob {
  const reference = structuredClone(source), sourceIdentity = JSON.stringify(source);
  let inner: ChemistryJob | null = null, cancelled = false, settled = false;
  let interrupt: () => void = () => {};
  const interrupted = new Promise<void>(resolve => { interrupt = resolve; });
  const cancel = () => { if (!settled) { cancelled = true; try { inner?.cancel(); } catch { /* cancellation still invalidates acceptance */ } finally { interrupt(); } } };
  const result = (status: ImportBondPerceptionStatus, warnings: string[] = []): ImportBondPerceptionResult => ({ structure: structuredClone(reference), status, warnings });
  const current = () => { options.guard(); if (JSON.stringify(source) !== sourceIdentity) throw new Error('导入来源已变化。'); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const operation = async (): Promise<ImportBondPerceptionResult> => {
    if (cancelled) return result('cancelled');
    try { current(); } catch { return result('stale'); }
    if (reference.bonds !== undefined) return result('preserved');
    if(reference.periodicSource?.completeness==='partial')return result('unavailable',['来源只有部分平移矢量，完整晶胞缺失；原子及原始矢量已保留，未当作有限分子。']);
    if (reference.dimension === 2 || reference.cell&&!reference.cell.pbc.some(Boolean))
      return result('unavailable', ['该来源仅二维坐标或未启用周期轴，未自动进行有限分子键级识别。']);
    const ids = reference.atoms.map(atom => atom.id);
    if (!ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
      return result('failed', ['导入成键识别需要唯一稳定原子ID；原结构已保留。']);
    try {
      if(reference.cell?.pbc.some(Boolean)){
        await Promise.resolve();if(cancelled)return result('cancelled');try{current();}catch{return result('stale');}
        const perceived=perceivePeriodicConnections(reference,{allowUnconfirmedPreview:true});
        if(cancelled)return result('cancelled');try{current();}catch{return result('stale');}
        const structure=structuredClone(reference);delete structure.molfile;delete structure.bondPerceptionIssues;
        structure.bonds=perceived.bonds;structure.bondSource='inferred';if(perceived.issues.length)structure.bondPerceptionIssues=perceived.issues;
        return {structure,status:'inferred',warnings:perceived.warnings,preview:perceived.preview};
      }
      const capabilities = await options.port.capabilities();
      if (cancelled) return result('cancelled');
      try { current(); } catch { return result('stale'); }
      if (!capabilities.native || !capabilities.operations.includes('perceive-bonds'))
        return result('unavailable', ['当前化学端口不支持原生键级识别；原结构已保留。']);
      const stamp = options.stamp ? { ...options.stamp } : { documentId: reference.id, revision: reference.revision ?? 0,
        graphFingerprint: graphFingerprint(reference), coordinatesFingerprint: coordinatesFingerprint(reference), constraintsFingerprint: '[]' };
      const request: ChemistryRequest = { stamp, operation: 'perceive-bonds',
        structure: structuredClone(reference), movableAtomIds: ids as string[], bondPerceptionPolicy: 'coordinate-import' };
      inner = options.port.start(request);
      const response = await inner.promise;
      if (cancelled) return result('cancelled');
      try { current(); } catch { return result('stale'); }
      return { structure: acceptedStructure(reference, response, stamp), status: 'inferred', warnings: [...response.warnings] };
    } catch (cause) {
      if (cancelled) return result('cancelled');
      try { current(); } catch { return result('stale'); }
      return result('failed', ['键级识别未接受，原结构已保留：' + (cause instanceof Error ? cause.message : String(cause))]);
    }
  };
  const promise = Promise.race([operation(), interrupted.then(() => result('cancelled'))]).finally(() => {
    settled = true; options.signal?.removeEventListener('abort', cancel);
  });
  return { promise, cancel };
}
