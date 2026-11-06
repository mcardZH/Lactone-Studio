import type { GaussianSettings } from './types';
import type { OrcaSettings } from './orca/types';
import type { TaskSelectionIntent, SelectionCaptureRequest, SelectionCaptureResult, ModelDocument } from '../modeling/contracts';
import { inputSelectionIndices } from './input-selection';
import { defaultTaskOptions, supportsConstraints } from './tasks';

export function orcaFreezeCaptureRowId(objectId:string,md=false):string{return `${md?'orca-md':'orca'}-freeze-object:${objectId}`;}
export function orcaFreezeCaptureObjectId(rowId:string):{objectId:string;md:boolean}|null{
  const md=rowId.startsWith('orca-md-freeze-object:'),prefix=md?'orca-md-freeze-object:':'orca-freeze-object:';
  return rowId.startsWith(prefix)?{objectId:rowId.slice(prefix.length),md}:null;
}

/** A row fingerprint binds capture to the intended form definition. It never
 * substitutes the global display selection or derives scientific parameters. */
export function taskSelectionRowSignature(intent: TaskSelectionIntent, settings: GaussianSettings | OrcaSettings, document?: ModelDocument): string | null {
  if (intent.taskId && intent.taskId !== settings.task) return null;
  if (intent.engine === 'gaussian' && !('version' in settings)) {
    const o = settings.taskOptions ?? defaultTaskOptions();
    if (intent.purpose === 'coordinate') {
      if (!supportsConstraints(settings.task)) return null;
      if(/^coordinate-new-(scan|freeze)-[0-9a-f-]{36}$/i.test(intent.rowId)&&intent.kind==='coordinate'){
        const action=intent.rowId.split('-')[2];
        return action==='scan'&&settings.task!=='scan'?null:JSON.stringify(['new-coordinate',intent.rowId,settings.task,o.coordinateDrafts??o.coordinates]);
      }
      const row = o.coordinateDrafts?.find(value => value.id === intent.rowId)
        ?? o.coordinates.find((_, index) => intent.rowId === `legacy-${index + 1}`);
      return row && (row.type === intent.kind || intent.kind === 'coordinate') ? JSON.stringify(row) : null;
    }
    if (intent.purpose === 'frozen-atoms') return supportsConstraints(settings.task) && intent.rowId === 'gaussian-frozen-atoms' ? JSON.stringify(o.frozenAtoms) : null;
    if (intent.purpose === 'fragment') {
      const row = o.fragments.find((value, index) => (value.id ?? `gaussian-fragment-${index}`) === intent.rowId);
      return settings.task === 'bsse' && row ? JSON.stringify(row) : null;
    }
    if (intent.purpose === 'layer' && intent.rowId === 'gaussian-oniom-high') return settings.oniom?.enabled ? JSON.stringify(settings.oniom.qmAtomIds) : null;
    if (intent.purpose === 'basis') { const row=settings.mixedBasis?.regions.find(value=>value.id===intent.rowId);return settings.mixedBasis?.enabled&&row&&intent.kind==='atoms'?JSON.stringify(row):null; }
  } else if (intent.engine === 'orca' && 'version' in settings) {
    if (intent.purpose === 'coordinate') {
      if(/^orca-(?:md-)?coordinate-new-(scan|freeze)-[0-9a-f-]{36}$/i.test(intent.rowId)&&intent.kind==='coordinate'){
        const md=intent.rowId.startsWith('orca-md-'),action=intent.rowId.split('-')[md?4:3];
        if(md!== (settings.task==='md')||action==='scan'&&settings.task!=='scan')return null;
        return JSON.stringify(['new-coordinate',intent.rowId,settings.task,md?settings.md.constraints:settings.constraints]);
      }
      const frozen=orcaFreezeCaptureObjectId(intent.rowId);
      if(frozen){
        if(frozen.md&&settings.task!=='md'||!frozen.md&&settings.task==='md')return null;
        const row=(frozen.md?settings.md.constraints:settings.constraints).find(row=>row.action==='freeze'&&row.objectId===frozen.objectId);
        if(document?.sharedConstraints?.canonical&&!document.sharedConstraints.coordinates.some(row=>row.objectId===frozen.objectId))return null;
        return row&&(row.type===intent.kind||intent.kind==='coordinate')?JSON.stringify(row):null;
      }
      const md = intent.rowId.startsWith('orca-md-'), rows = md ? settings.md.constraints : settings.constraints;
      const row = rows.find((_, index) => intent.rowId === `orca-${md ? 'md' : 'constraints'}-${index}`);
      return row && (row.type === intent.kind || intent.kind === 'coordinate') && (!md || settings.task === 'md') ? JSON.stringify(row) : null;
    }
    if (intent.purpose === 'frozen-atoms') return intent.rowId === 'orca-frozen-atoms' ? JSON.stringify(settings.frozenAtomIds) : null;
    if (intent.purpose === 'active-atoms') {
      if (intent.rowId === 'orca-md-active-atoms') return settings.task === 'md' ? JSON.stringify(settings.md.activeAtomIds) : null;
      if (intent.rowId === 'orca-multiscale-active-atoms') return settings.multiscale.mode !== 'none' ? JSON.stringify(settings.multiscale.activeAtomIds ?? null) : null;
      return null;
    }
    if (intent.purpose === 'fragment') { const row = settings.fragments.find(value => value.id === intent.rowId); return settings.task === 'bsse' && row ? JSON.stringify(row) : null; }
    if (intent.purpose === 'layer' && intent.rowId === 'orca-qm-region') return settings.multiscale.mode !== 'none' ? JSON.stringify(settings.multiscale.qmAtomIds) : null;
  }
  if (intent.purpose === 'layer' && document) { const row = document.draft.assignments.layers.find(value => value.id === intent.rowId); return row ? JSON.stringify(row) : null; }
  return null;
}

export function validateInputCaptureContext(request: SelectionCaptureRequest, document: ModelDocument,
  currentEngine: TaskSelectionIntent['engine'], currentTask: string, expectedRow: string, currentRow: string | null): string | null {
  if (document.id !== request.documentId || document.revision !== request.revision) return '模型或选择请求已变化，请重新选择。';
  if (request.engineScope !== currentEngine || request.taskId !== currentTask || currentRow === null || currentRow !== expectedRow) return '当前引擎、任务或目标行已变化，请重新选择。';
  return null;
}

/** Only a model-owner projection may advance a live capture's revision. The
 * shell proves the old form/row still match before projecting edited atoms. */
export function rebaseInputCaptureContext(request: SelectionCaptureRequest, document: ModelDocument, previous: { id: string; revision: number },
  context: { engine: TaskSelectionIntent['engine']; task: string; previousFormMatches: boolean; previousRow: string | null; expectedRow: string; nextRow: string | null }): SelectionCaptureRequest | null {
  if (!context.previousFormMatches || previous.id !== request.documentId || previous.revision !== request.revision
    || document.id !== request.documentId || document.revision === request.revision || context.engine !== request.engineScope
    || context.task !== request.taskId || context.previousRow !== context.expectedRow || context.nextRow === null) return null;
  const known = new Set(document.draft.structure.atoms.map(atom => atom.id));
  return { ...request, revision: document.revision, initialAtomIds: request.initialAtomIds.filter(id => known.has(id)) };
}

export function validateInputCaptureResult(request: SelectionCaptureRequest, result: SelectionCaptureResult, document: ModelDocument,
  currentEngine: TaskSelectionIntent['engine'], currentTask: string, expectedRow: string, currentRow: string | null): string | null {
  if (request.requestId !== result.requestId || request.documentId !== result.documentId || request.revision !== result.revision
    || document.id !== request.documentId || document.revision !== request.revision) return '模型或选择请求已变化，请重新选择。';
  const contextIssue = validateInputCaptureContext(request, document, currentEngine, currentTask, expectedRow, currentRow);
  if (contextIssue) return contextIssue;
  if (!Array.isArray(result.atomIds) || result.atomIds.some(id => typeof id !== 'string')) return '选择原子身份无效。';
  if(result.images!==undefined){
    if(request.kind!=='coordinate'&&request.kind!=='B'&&request.kind!=='A'&&request.kind!=='D')return '当前选择不接受周期镜像。';
    if(!Array.isArray(result.images)||result.images.length!==result.atomIds.length||result.images.some(image=>!Array.isArray(image)||image.length!==3||image.some(value=>!Number.isSafeInteger(value))))return '内坐标周期镜像身份无效。';
    if(result.images.some(image=>image.some(value=>value!==0)))return '当前输入后端不支持跨周期镜像内坐标。';
  }
  try {
    const indices = inputSelectionIndices(document.draft.structure, result.atomIds);
    if (request.kind === 'coordinate' && (indices.length < 2 || indices.length > 4)) return '请依次选择2、3或4个不同原子。';
    if (request.kind !== 'atoms' && request.kind !== 'coordinate' && indices.length !== { B: 2, A: 3, D: 4 }[request.kind]) return '请选择完整的有序内坐标原子。';
  } catch (cause) { return cause instanceof Error ? cause.message : '选择原子身份无效。'; }
  return null;
}
