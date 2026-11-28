import type { ModelStore } from '../../modeling/contracts';
import { toolError } from './types';
import type { AdvancedInputTemplate } from '../../modeling/application/advanced-frame-output';
import type { OrcaAsset, OrcaOutputFile, OrcaSettings, OrcaTask } from '../../core/orca';
import type { OrcaHessianPathEvidence } from '../../core/orca/types';
import type { ExternalInputDraft } from '../../task-system/integration/input-draft';
import type { FileSettings, GaussianSettings, TaskId } from '../../core/types';
import type { WorkspaceRegistry } from '../../modeling/workspace-registry';
import type { SolventSelection } from '../../core/solvents';

export type InputEngine = 'gaussian' | 'orca';
export type InputSettingsPatch<T> = Omit<Partial<T>, 'solvation'> & { solvation?: SolventSelection | null };

export interface InputDraftConfiguration {
  engine: InputEngine;
  task?: TaskId | OrcaTask;
  settings?: InputSettingsPatch<GaussianSettings> | InputSettingsPatch<OrcaSettings>;
  files?: Partial<FileSettings>;
  name?: string;
  cores?: number;
  memoryGB?: number;
  resourcesConfirmed?: boolean;
  electronicState?: { charge: number; multiplicity: number; confirmed: boolean };
  frequencyConditionsConfirmed?: boolean;
  confirmIrcStart?: boolean;
}

export interface InputDraftView {
  draftVersion: string;
  documentId: string;
  documentRevision: number;
  engine: InputEngine;
  step: number;
  /** Full effective settings, excluding separately owned source and geometry data. */
  parameters: Record<string, unknown>;
  /** Admitted partial configuration for writes; parameters also retain read-only native facts. */
  configuration: InputDraftConfiguration;
  files: OrcaOutputFile[];
  editedFiles: string[];
  stale: boolean;
  issues?: unknown;
}

export interface InputEndpointBindings {
  reactant: {modelRef: string;revision: number};
  product: {modelRef: string;revision: number};
  tsGuess?: {modelRef: string;revision: number};
  confirm?: boolean;
}

export type InputScanRow = {atomIds:string[];increments:number;increment:number}
  | {atomIds:string[];start:number;end:number;points:number} | {atomIds:string[];values:number[]};
export type InputOrcaAssetKind = 'hessian' | 'gbw' | 'restart';
export interface InputOrcaHessianPatch extends Partial<Omit<NonNullable<OrcaAsset['hessianEvidence']>,'path'>> {
  fromCurrent?:boolean;
  path?:Partial<Omit<OrcaHessianPathEvidence,'schema'|'targetContext'>>;
}
export type InputOrcaAssetEdit =
  | {action:'import';asset:OrcaAsset;file:File;select:boolean;replace:boolean}
  | {action:'reference';kind:'hessian'|'gbw';name:string}
  | {action:'select';assetId:string}
  | {action:'remove';assetId:string}
  | {action:'clear';kind:InputOrcaAssetKind}
  | {action:'evidence';assetId:string;hessian?:InputOrcaHessianPatch;orbital?:Partial<NonNullable<OrcaAsset['orbitalEvidence']>>;
      restart?:Partial<NonNullable<OrcaAsset['restartEvidence']>>};

export interface LiveInputPort {
  read(): InputDraftView;
  configure(configuration: InputDraftConfiguration, expectedDraft: string, replaceEdited: boolean): InputDraftView;
  preview(expectedDraft?: string): unknown;
  generate(expectedDraft: string, replaceEdited: boolean): Promise<InputDraftView>;
  edit(expectedDraft: string, fileName: string, text: string): InputDraftView;
  bindEndpoints(expectedDraft: string, endpoints: InputEndpointBindings): InputDraftView;
  inherit(expectedDraft:string):InputDraftView;
  binaryOutputs(expectedDraft:string):Array<{name:string;file:File}>;
  scan(expectedDraft?:string,rows?:InputScanRow[]):unknown;
  assets(expectedDraft?:string,edit?:InputOrcaAssetEdit):unknown;
  template(expectedDraft?: string): AdvancedInputTemplate;
  external(expectedDraft: string, fileName?: string): ExternalInputDraft;
}

const liveInputs = new WeakMap<ModelStore, LiveInputPort>();
const inputVersions = new WeakMap<ModelStore, string>();
const inputObservers = new WeakMap<ModelStore, Set<(version:string)=>void>>();

export function registerLiveInput(store: ModelStore, port: LiveInputPort): () => void {
  liveInputs.set(store, port);
  return () => { if (liveInputs.get(store) === port) liveInputs.delete(store); };
}

export function liveInputFor(store: ModelStore): LiveInputPort {
  const port = liveInputs.get(store);
  if (!port) throw toolError('INPUT_EDITOR_UNAVAILABLE','该对象当前没有可编辑的 Gaussian / ORCA 输入工作台。');
  return port;
}

export function publishLiveInputVersion(store:ModelStore,version:string):void {
  if(inputVersions.get(store)===version)return;
  inputVersions.set(store,version);
  for(const listener of inputObservers.get(store)??[])listener(version);
}

/** Subscribe only to stores belonging to this window's current workspace. */
export function followInputChanges(registry:WorkspaceRegistry,onChange:(targetId:string,version:string)=>void):()=>void {
  const subscriptions=new Map<ModelStore,()=>void>();
  function refresh(){
    const current=new Set<ModelStore>();
    for(const entry of registry.getSnapshot().documents){
      current.add(entry.store);
      if(subscriptions.has(entry.store))continue;
      const listeners=inputObservers.get(entry.store)??new Set<(version:string)=>void>();
      inputObservers.set(entry.store,listeners);
      const listener=(version:string)=>onChange(entry.id,version);
      listeners.add(listener);
      subscriptions.set(entry.store,()=>listeners.delete(listener));
    }
    for(const [store,detach] of subscriptions)if(!current.has(store)){detach();subscriptions.delete(store);}
  }
  const unsubscribe=registry.subscribe(refresh);refresh();
  return ()=>{unsubscribe();for(const detach of subscriptions.values())detach();subscriptions.clear();};
}
