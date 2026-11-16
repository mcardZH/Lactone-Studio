import type { JobRequest } from '../../core/types';
import type { OrcaJobRequest } from '../../core/orca/types';
import { automaticFilename, automaticStem } from '../../core/naming';
import type { FormatDescriptor, ModelDocument, ModelFormat, ModelStore, SaveContext, SaveSelection } from '../contracts';
import type { WorkspaceActivationStamp } from '../workspace-contracts';
import { requiresElectronicStateConfirmation } from './electronic-state-context';
import { createWorkspaceAsyncGuard, type WorkspaceAsyncIdentity } from './workspace-async-guards';
import { createInputExportGuard, type InputExportSnapshot } from './input-export-guard';
import {captureStructureExportDocument} from './structure-export-snapshot';

export interface DocumentOperationContext extends WorkspaceAsyncIdentity {
  documentName?:string;
  documentNameOrigin?:'automatic'|'manual';
  jobRequest?: JobRequest; orcaJobRequest?: OrcaJobRequest;
  assertActivationIdentity?(stamp: WorkspaceActivationStamp): void;
  runtimeOwner?:unknown;
  runtimeSessionId?:string;
  runtimeConditions?:string;
  /** Stable result/collection identity, excluding playback frame and phase. */
  scientificSourceIdentity?:string;
}
export interface DocumentSaveOptions { withCell: boolean; staleAssignments: boolean; purpose?: SaveContext['purpose'] }
export interface DocumentElectronicState { charge: number; multiplicity: number }
export interface DocumentExportOptions extends DocumentSaveOptions {
  format: ModelFormat; token?: string; state?: DocumentElectronicState; inheritedGuard?: () => void;
  capturedDocument?: ModelDocument;
}
export interface DocumentFilePort {
  chooseSavePath(request: { name: string; formats: FormatDescriptor[] }): Promise<SaveSelection>;
  writeChosenFile(request: { token: string; text: string }): Promise<{ status: 'saved'; path: string }>;
}
export type DocumentOperationResult = (
  | { status: 'format-required'; snapshot?:ModelDocument; assertCurrent(): void; assertPublishCurrent(): void }
  | { status: 'state-required'; format: ModelFormat; token?: string; snapshot: ModelDocument; request?: JobRequest | OrcaJobRequest; purpose?: SaveContext['purpose']; assertCurrent(): void; assertPublishCurrent(): void }
  | { status: 'cancelled'; reason: 'path' | 'losses' }
  | { status: 'saved'; path: string; name: string; purpose?: SaveContext['purpose']; assertPublishCurrent(): void }
  | { status: 'downloaded'; filename: string; name: string; purpose?: SaveContext['purpose']; assertPublishCurrent(): void }
  // Native writing was already dispatched and returned success. A stale view
  // cannot turn it into cancellation or announce it into a different owner.
  | { status: 'written-without-current-view'; path: string }) & {
    snapshotSource?:Pick<InputExportSnapshot,'sessionId'|'seq'|'workingSource'>;
  };
export interface DocumentOperationPorts {
  read(): DocumentOperationContext;
  /** Optional complete observed scientific frame, sealed once at the user's action. */
  captureScientificSource?(): ModelDocument | undefined;
  pauseAndSnapshot(): Promise<InputExportSnapshot | void>;
  getFilePort(): DocumentFilePort | null;
  formats(context: DocumentOperationContext & { purpose?: SaveContext['purpose'] }): FormatDescriptor[];
  exportModel(snapshot: ModelDocument, format: ModelFormat, context: SaveContext): Promise<{ text: string; losses: string[] }>;
  confirmLosses(losses: readonly string[]): boolean;
  download(request: { filename: string; text: string; assertCurrent(): void }): void;
}

/** Document I/O coordination only: the injected serializer/chemistry port
 * stays authoritative. This module never commits a model or owns UI state. */
export function createDocumentOperations(ports: DocumentOperationPorts) {
  const labelForFilename = (filename: string) => filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const safeManualFilename = (name: string) => {
    const cleaned = name.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 160);
    return !cleaned || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `model${cleaned ? '_' + cleaned : ''}` : cleaned;
  };
  function guard(lifetimeOnly = false) {
    const sourceIdentity=ports.read().scientificSourceIdentity;
    const assertWorkspace=createWorkspaceAsyncGuard(() => {
      const current = ports.read();
      return { alive: current.alive, generation: current.generation, store: current.store, active: current.active,
        activationStamp: current.activationStamp, assertActivation: lifetimeOnly ? current.assertActivationIdentity : current.assertActivation };
    });
    return()=>{assertWorkspace();if(ports.read().scientificSourceIdentity!==sourceIdentity)throw new Error('结构导出所属结果来源已变化，请重新保存。');};
  }
  function snapshotGuard(purpose?:SaveContext['purpose'],format?:ModelFormat){
    return createInputExportGuard(()=>{
      const value=ports.read(),document=value.store.getSnapshot();
      return {alive:value.alive,active:value.active!==false,generation:value.generation,documentId:document.id,revision:document.revision,structure:document.draft.structure,
        runtimeOwner:value.runtimeOwner,runtimeSessionId:value.runtimeSessionId,conditions:JSON.stringify([value.runtimeConditions,purpose==='structure'?null:format==='inp'?value.orcaJobRequest:format?value.jobRequest:[value.jobRequest,value.orcaJobRequest]]),
        activationStamp:value.activationStamp,assertIdentityCurrent:value.assertActivationIdentity};
    });
  }
  async function writeExport(options: DocumentExportOptions): Promise<DocumentOperationResult> {
    const { format, token, state, inheritedGuard, withCell, staleAssignments, purpose } = options;
    const beforePause = inheritedGuard ?? guard(true); beforePause();
    const frameGuard=snapshotGuard(purpose,format);
    const source=options.capturedDocument??ports.captureScientificSource?.();
    const selected=source?(purpose==='structure'?captureStructureExportDocument(source):structuredClone(source)):undefined;
    const captured = selected?undefined:await ports.pauseAndSnapshot();
    // Legacy geometry/optimization still seals its accepted Store revision below.
    if(captured?.detached)frameGuard.afterSnapshot(captured);
    beforePause(); const assertCurrent = inheritedGuard ?? guard(purpose==='structure'); assertCurrent();
    if (purpose !== 'structure' && staleAssignments) throw new Error('任务分区已变化，请取消草稿后重新编辑。');
    const current = ports.read(), currentStore = current.store, workingSnapshot = currentStore.getSnapshot();
    const snapshot = selected??(captured?.detached ? { ...workingSnapshot, draft: { ...workingSnapshot.draft, structure: structuredClone(captured.structure) } } : workingSnapshot);
    if(snapshot.id!==workingSnapshot.id||purpose!=='structure'&&snapshot.revision!==workingSnapshot.revision)throw new Error('导出来源所属文档已变化，请重新导出。');
    const provenance=captured?.detached?{snapshotSource:structuredClone({sessionId:captured.sessionId,seq:captured.seq,workingSource:captured.workingSource})}:{};
    const request = purpose === 'structure' ? undefined : format === 'inp' ? current.orcaJobRequest : current.jobRequest;
    const structure = snapshot.draft.structure;
    const requestSignature = JSON.stringify(request);
    const assertExportCurrent = () => {
      assertCurrent(); const latest = ports.read();
      if(captured?.detached&&purpose!=='structure')frameGuard.assertCurrent();
      if (currentStore !== latest.store || snapshot.id !== currentStore.getSnapshot().id || purpose!=='structure'&&snapshot.revision !== currentStore.getSnapshot().revision) throw new Error('模型已变化，请重新保存。');
      if (purpose !== 'structure' && JSON.stringify(format === 'inp' ? latest.orcaJobRequest : latest.jobRequest) !== requestSignature) throw new Error('任务设置已变化，请重新保存。');
    };
    if (purpose === 'structure' && (format === 'gjf' || format === 'com') && !state && (structure.charge === null || structure.multiplicity === null)) {
      return { status: 'state-required', purpose, format, token, snapshot, assertCurrent: assertExportCurrent, assertPublishCurrent: assertExportCurrent, ...provenance };
    }
    if (['gjf', 'com', 'inp'].includes(format) && request && !state && requiresElectronicStateConfirmation(snapshot.draft.structure, request)) {
      return { status: 'state-required', format, token, snapshot, request: structuredClone(request), assertCurrent: captured?.detached?assertExportCurrent:assertCurrent, assertPublishCurrent: assertExportCurrent, ...provenance };
    }
    const saveRequest = state && request ? { ...request, charge: state.charge, multiplicity: state.multiplicity, electronicStateConfirmed: true,
      ...(format === 'inp' ? { structure: { ...snapshot.draft.structure, charge: state.charge, multiplicity: state.multiplicity } } : {}) } : request;
    const exportSnapshot = state && (format === 'inp' || purpose === 'structure') ? { ...snapshot, draft: { ...snapshot.draft, structure: { ...snapshot.draft.structure, charge: state.charge, multiplicity: state.multiplicity } } } : snapshot;
    const result = await ports.exportModel(exportSnapshot, format, { jobRequest: format === 'inp' ? undefined : saveRequest as JobRequest | undefined,
      orcaJobRequest: format === 'inp' ? saveRequest as OrcaJobRequest | undefined : undefined, withCell, ...(purpose ? { purpose } : {}) });
    assertExportCurrent();
    if (result.losses.length && !ports.confirmLosses(result.losses)) return { status: 'cancelled', reason: 'losses' };
    assertExportCurrent();
    const filePort = ports.getFilePort();
    if (token && filePort) {
      const receipt = await filePort.writeChosenFile({ token, text: result.text });
      const assertPublishCurrent=captured?.detached?assertExportCurrent:assertCurrent;
      try { assertPublishCurrent(); } catch { return { status: 'written-without-current-view', path: receipt.path, ...provenance }; }
      // Keep the original post-dispatch lifetime/activation check; task text
      // was sealed before writing and cannot retroactively undo a saved file.
      return { status: 'saved', path: receipt.path, name: labelForFilename(receipt.path), purpose, assertPublishCurrent, ...provenance };
    }
    const sourceName = current.documentName ?? structure.name;
    const extension = format === 'poscar' ? 'vasp' : format;
    const filename = current.documentNameOrigin === 'manual'
      ? safeManualFilename(sourceName.replace(/\.(?:es|sciyue|gjf|com|inp|sdf|mol|mol2|pdb|xyz|extxyz|cif|poscar|vasp)$/i, '')) + '.' + extension
      : automaticFilename(sourceName, extension);
    ports.download({ filename, text: result.text, assertCurrent: assertExportCurrent });
    return { status: 'downloaded', filename, name: labelForFilename(filename), purpose, assertPublishCurrent: assertExportCurrent, ...provenance };
  }
  async function save(options: DocumentSaveOptions): Promise<DocumentOperationResult> {
    const beforePause = guard(true),frameGuard=snapshotGuard(options.purpose);
    const source=ports.captureScientificSource?.(),selected=source?(options.purpose==='structure'?captureStructureExportDocument(source):source):undefined;
    const captured=selected?undefined:await ports.pauseAndSnapshot(); beforePause();
    if(captured?.detached)frameGuard.afterSnapshot(captured);
    // Legacy pause may admit a final Store revision; continuous MD only seals its unchanged source.
    const assertWorkspace=guard(options.purpose==='structure'),assertCurrent=()=>{assertWorkspace();if(captured?.detached&&options.purpose!=='structure')frameGuard.assertCurrent();}, filePort = ports.getFilePort();
    const sourceDocument=ports.read().store.getSnapshot();
    const sealed=selected??(options.purpose==='structure'?captureStructureExportDocument(sourceDocument,captured?.detached?captured.structure:sourceDocument.draft.structure):undefined);
    if (!filePort) return { status: 'format-required', snapshot:sealed, assertCurrent, assertPublishCurrent: assertCurrent };
    const current = ports.read(), currentStore = current.store, revision = currentStore.getSnapshot().revision;
    const sourceName = current.documentName ?? currentStore.getSnapshot().draft.structure.name;
    const name = current.documentNameOrigin === 'manual' ? safeManualFilename(sourceName) : automaticStem(sourceName);
    const choice = await filePort.chooseSavePath({ name, formats: ports.formats({ ...current, purpose: options.purpose }) });
    assertCurrent();
    if (choice.status === 'cancelled') return { status: 'cancelled', reason: 'path' };
    if (!choice.token || !choice.format) throw new Error('保存路径或格式未确认。');
    if (currentStore !== ports.read().store || options.purpose!=='structure'&&revision !== currentStore.getSnapshot().revision) throw new Error('模型已变化，请重新保存。');
    return writeExport({ ...options, format: choice.format, token: choice.token, inheritedGuard: assertCurrent, capturedDocument:sealed });
  }
  return { save, writeExport };
}

export interface CapturedStructureExportPorts extends Pick<DocumentOperationPorts,'getFilePort'|'formats'|'exportModel'|'confirmLosses'|'download'> {
  /** Validates the original file/window lifetime, without re-reading geometry. */
  assertCurrent():void;
  documentName?:string;
  documentNameOrigin?:'automatic'|'manual';
}

/** File-only and detached viewers share the regular save/qM/format pipeline.
 * The read-only facade supplies identity checks only; it never owns edits,
 * registry activation, native work, or a new model history. */
export function createCapturedStructureOperations(document:ModelDocument,ports:CapturedStructureExportPorts){
  const snapshot=captureStructureExportDocument(document);
  const store={getSnapshot:()=>snapshot} as ModelStore;
  const operations=createDocumentOperations({...ports,
    read:()=>{ports.assertCurrent();return{alive:true,active:true,generation:0,store,documentName:ports.documentName,documentNameOrigin:ports.documentNameOrigin};},
    captureScientificSource:()=>snapshot,pauseAndSnapshot:async()=>{},
  });
  return{
    save:(options:{withCell?:boolean}={})=>operations.save({withCell:options.withCell??Boolean(snapshot.draft.structure.cell),staleAssignments:false,purpose:'structure'}),
    writeExport:(options:Omit<DocumentExportOptions,'purpose'|'staleAssignments'|'withCell'> & {withCell?:boolean})=>operations.writeExport({...options,withCell:options.withCell??Boolean(snapshot.draft.structure.cell),staleAssignments:false,purpose:'structure',capturedDocument:snapshot}),
  };
}
