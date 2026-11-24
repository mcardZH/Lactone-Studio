import type { ClipboardPayload, MeasurementSession, MeasurementState } from '../../modeling/contracts';
import { isXtbMethod, supportsXtbOperation, XTB_ALPB_PRESETS, xtbSolvents, type XtbNativeMethod } from '../../core/xtb-capabilities';
import type { XtbPreoptimizationSolvation } from '../../modeling/xtb/accept-result';
import type { ActiveStructurePreviewSource } from './active-structure-preview';
import { emptyMeasurementSession, setMeasurementMode } from './measurement-state';
import {isPesNetMethod,type PesConvergencePreset,type PesGeometryLimits} from '../../modeling/pes/contracts';
import {periodicPesOperationAvailable} from '../../modeling/pes/periodic-capabilities';

export type PersistentModelTool = 'hydrogen' | 'delete' | 'fragment';
export type FreezeModelTool = 'point' | 'box' | 'remove';
export type ObservationModelTool = 'rotate' | 'pan' | 'select' | 'box';

/** Workspace UI preferences contain no model identity or electronic state. */
export const ordinaryOptimizers = { lbfgs: 'L-BFGS / XYZ', 'precon-exp': 'L-BFGS / Exp', fire2: 'FIRE2 / XYZ', 'sella-xyz': 'Sella-XYZ', 'sella-ric': 'Sella-RIC' } as const;
export const molecularNetMethods = { 'aimnet2-auto': 'AIMNet2-auto', 'aimnet2-rxn': 'AIMNet2-rxn', 'orbmol-v2': 'OrbMol-v2' } as const;
export const periodicNetMethods = {
  'orb-v3-omat':'ORB-v3-OMat','mace-polar-1-m':'MACE-POLAR-1 M','mace-mh1-omat-pbe':'MACE-MH-1 / OMat-PBE','mace-mh1-oc20':'MACE-MH-1 / OC20',
} as const;
export const netMethods = {...molecularNetMethods,...periodicNetMethods};
export type OrdinaryOptimizer = keyof typeof ordinaryOptimizers;
export type NetMethod = keyof typeof netMethods;
export const netMethodScopeNotes:Readonly<Record<keyof typeof molecularNetMethods,string>>={
  'aimnet2-auto':'H、B、C、N、O、F、Si、P、S、Cl、As、Se、Br、I。闭壳层使用通用权重，开壳层使用 NSE。',
  'aimnet2-rxn':'H、C、N、O 的中性闭壳层分子。',
  'orbmol-v2':'按本次提交的电荷和自旋多重度计算非周期气相分子。',
};
export function isNetGpuFailure(method:string,device:unknown,error:string|undefined,code?:string):boolean {
  if (!error || (device ?? 'gpu') !== 'gpu' || !isPesNetMethod(method)) return false;
  if (code) return code === 'PES_NET_DEVICE';
  // Older project errors have text only. A device name alone also appears in their generic errors.
  return /\b(?:CUDA (?:error:|out of memory\b|driver\b|initialization\b|illegal memory access\b|(?:is )?unavailable\b)|CUBLAS_STATUS_\w+|CUDNN_STATUS_\w+|(?:found )?no (?:NVIDIA driver|CUDA (?:GPUs?|devices?))\b)|NVIDIA GPU 或兼容的 CUDA 驱动不可用|显存不足|没有足够的显存/i.test(error);
}
export type GeometryLimits = PesGeometryLimits;
export type OptimizationScope = 'all'|'selection'|'unselected';
export interface OptimizationSettings {
  optimizer?: OrdinaryOptimizer;
  convergencePreset?: PesConvergencePreset;
  convergenceLimits?: GeometryLimits;
  maxSteps?: number;
}
export interface NetOptimizationPreferences extends OptimizationSettings {
  method: NetMethod;
  device: 'gpu'|'cpu';
  rebuildBonds?: boolean;
}
export const defaultNetOptimizationPreferences: Readonly<NetOptimizationPreferences> = {method:'aimnet2-auto',device:'gpu',rebuildBonds:true};
export function workspaceNetSettings(preferences:WorkspaceOptimizationPreferences,periodic:boolean):NetOptimizationPreferences {
  const saved=periodic?preferences.periodicNet:preferences.net;
  const method=periodic?'orb-v3-omat':defaultNetOptimizationPreferences.method;
  return {...defaultNetOptimizationPreferences,method,...saved};
}
export function availableOrdinaryOptimizer(method:string,periodic:boolean,optimizer:OrdinaryOptimizer):boolean {
  return periodic?periodicPesOperationAvailable(method,'opt',optimizer):optimizer!=='precon-exp';
}
export function resolveOrdinaryOptimizer(method:string,periodic:boolean,optimizer?:OrdinaryOptimizer):OrdinaryOptimizer {
  return optimizer&&availableOrdinaryOptimizer(method,periodic,optimizer)?optimizer:'lbfgs';
}
export function validCustomOptimizationLimits(limits:GeometryLimits|undefined):limits is GeometryLimits {
  return !!limits&&Number.isFinite(limits.energyDifferenceHartree)&&limits.energyDifferenceHartree>0
    &&Number.isFinite(limits.gradientNormHartreePerBohr)&&limits.gradientNormHartreePerBohr>0;
}
function checkedOptimizationSettings(input: OptimizationSettings): OptimizationSettings {
  const {optimizer,convergencePreset,convergenceLimits,maxSteps}=input;
  const custom=validCustomOptimizationLimits(convergenceLimits);
  return {
    ...(optimizer&&Object.hasOwn(ordinaryOptimizers,optimizer)?{optimizer}:{}),
    ...(convergencePreset&&(['loose','medium','tight'].includes(convergencePreset)||convergencePreset==='custom'&&custom)?{convergencePreset}:{}),
    ...(custom?{convergenceLimits:{
      energyDifferenceHartree:convergenceLimits.energyDifferenceHartree,gradientNormHartreePerBohr:convergenceLimits.gradientNormHartreePerBohr,
    }}:{}),
    ...(maxSteps!==undefined&&Number.isSafeInteger(maxSteps)&&maxSteps>0?{maxSteps}:{}),
  };
}
export interface WorkspaceOptimizationPreferences {
  version: 3;
  defaultKind: 'xtb' | 'net';
  periodicKind?: WorkspaceOptimizationPreferences['defaultKind'];
  periodicXtbMethod?: XtbNativeMethod;
  scope: OptimizationScope;
  xtb: OptimizationSettings & { method: XtbNativeMethod; rebuildBonds: boolean; maxSccIterations?:number; solvation?:XtbPreoptimizationSolvation };
  net?: NetOptimizationPreferences;
  periodicNet?: NetOptimizationPreferences;
}
export function workspaceOptimizationKind(preferences:WorkspaceOptimizationPreferences,periodic:boolean) {
  return periodic?preferences.periodicKind??preferences.defaultKind:preferences.defaultKind;
}
export function workspaceOptimizationMethodAvailable(method:string,periodic:boolean):boolean {
  if (!isXtbMethod(method)) return false;
  return periodic ? periodicPesOperationAvailable(method, 'opt') : supportsXtbOperation(method, 'optimize');
}
export function selectWorkspaceOptimizationMethod(preferences:WorkspaceOptimizationPreferences,periodic:boolean,method:string):WorkspaceOptimizationPreferences {
  if(!isXtbMethod(method)||!workspaceOptimizationMethodAvailable(method,periodic))return preferences;
  if(periodic)return {...preferences,periodicKind:'xtb',periodicXtbMethod:method};
  const previousPeriodic={periodicKind:workspaceOptimizationKind(preferences,true),periodicXtbMethod:workspaceXtbSettings(preferences,true).method};
  return {...preferences,...previousPeriodic,defaultKind:'xtb',xtb:{...preferences.xtb,method}};
}
export function workspaceOptimizationSolvation(method:string,periodic:boolean,saved?:XtbPreoptimizationSolvation) {
  return saved?.model==='alpb'&&xtbSolvents(method,'alpb',periodic).includes(saved.solvent)?saved:undefined;
}
export function workspaceXtbSettings(preferences:WorkspaceOptimizationPreferences,periodic:boolean) {
  const {method:saved,optimizer,solvation,...settings}=preferences.xtb;
  const candidate=periodic?preferences.periodicXtbMethod??saved:saved;
  const method=workspaceOptimizationMethodAvailable(candidate,periodic)?candidate:'gfn2';
  return {...settings,method,optimizer:resolveOrdinaryOptimizer(method,periodic,optimizer),scope:preferences.scope,
    solvation:workspaceOptimizationSolvation(method,periodic,solvation)};
}
export const OPTIMIZATION_PREFERENCE_KEY = 'sciyue.workspace-optimization.v1';
export const OPTIMIZATION_PREFERENCE_EVENT = 'sciyue-workspace-optimization-changed';
export const OPTIMIZATION_SOLVATION_EVENT = 'sciyue-workspace-optimization-solvation-changed';
export function defaultWorkspaceOptimizationPreferences(): WorkspaceOptimizationPreferences {
  return { version: 3, defaultKind: 'xtb', scope:'all', xtb: { method: 'gfn2', rebuildBonds: true,maxSccIterations:250 } };
}
type StoredOptimizationPreferences = Omit<WorkspaceOptimizationPreferences, 'version' | 'xtb' | 'net' | 'periodicNet' | 'defaultKind' | 'scope'> & {
  version: 1 | 2 | 3;
  defaultKind: WorkspaceOptimizationPreferences['defaultKind'] | 'forcefield';
  xtb: WorkspaceOptimizationPreferences['xtb'] & { scope?: OptimizationScope };
  net?: NetOptimizationPreferences & {scope?: OptimizationScope};
  periodicNet?: NetOptimizationPreferences & {scope?: OptimizationScope};
  scope?: OptimizationScope;
};
const validOptimizationScope=(scope:unknown):scope is OptimizationScope=>scope==='all'||scope==='selection'||scope==='unselected';
function checkedOptimizationPreferences(value: unknown): WorkspaceOptimizationPreferences | null {
  const row = value as Partial<StoredOptimizationPreferences> | null;
  const solvation = row?.xtb?.solvation;
  if (!row || ![1, 2, 3].includes(row.version ?? 0) || !['forcefield', 'xtb', 'net'].includes(row.defaultKind ?? '')
    || !isXtbMethod(row.xtb?.method ?? '') || row.xtb?.maxSteps !== undefined && (!Number.isSafeInteger(row.xtb.maxSteps)||row.xtb.maxSteps<1) || row.xtb?.maxSccIterations !== undefined && (!Number.isSafeInteger(row.xtb.maxSccIterations)||row.xtb.maxSccIterations<1) || typeof row.xtb?.rebuildBonds !== 'boolean'
    || !validOptimizationScope(row.scope??row.xtb?.scope??'all')
    || (solvation!==undefined&&!(solvation?.model==='alpb'&&XTB_ALPB_PRESETS.some(preset=>preset.id===solvation.solvent)
      ||solvation?.model==='gbsa'&&['gfn1','gfn2'].some(method=>xtbSolvents(method,'gbsa').includes(solvation.solvent))))) return null;
  const checkedNet=(net:StoredOptimizationPreferences['net'],periodic:boolean)=>
    net&&Object.hasOwn(periodic?periodicNetMethods:molecularNetMethods,net.method)&&['gpu','cpu'].includes(net.device)
      ? {...checkedOptimizationSettings(net),method:net.method,device:net.device,
        ...(typeof net.rebuildBonds==='boolean'?{rebuildBonds:net.rebuildBonds}:{})} : undefined;
  const net=checkedNet(row.net,false),periodicNet=checkedNet(row.periodicNet,true);
  const xtb=row.defaultKind==='forcefield'?defaultWorkspaceOptimizationPreferences().xtb
    : {...checkedOptimizationSettings(row.xtb!),method:row.xtb!.method,rebuildBonds:row.xtb!.rebuildBonds,maxSccIterations:row.xtb!.maxSccIterations??250,
      ...(solvation?{solvation:{model:solvation.model,solvent:solvation.solvent}}:{})};
  const defaultKind=row.version!==1&&row.defaultKind==='net'?'net':'xtb';
  const legacyNetScope=(net?row.net?.scope:undefined)??(periodicNet?row.periodicNet?.scope:undefined);
  const scope=row.defaultKind==='forcefield'?'all':row.scope??(defaultKind==='net'&&validOptimizationScope(legacyNetScope)?legacyNetScope:row.xtb?.scope??'all');
  return {version:3,defaultKind,scope,xtb,
    ...(row.periodicKind==='net'||row.periodicKind==='xtb'?{periodicKind:row.periodicKind}:{}),
    ...(typeof row.periodicXtbMethod==='string'&&isXtbMethod(row.periodicXtbMethod)?{periodicXtbMethod:row.periodicXtbMethod}:{}),
    ...(net?{net}:{}),...(periodicNet?{periodicNet}:{})};
}
export function parseWorkspaceOptimizationPreferences(value: unknown): WorkspaceOptimizationPreferences {
  return checkedOptimizationPreferences(value) ?? defaultWorkspaceOptimizationPreferences();
}
export function readWorkspaceOptimizationPreferences(): WorkspaceOptimizationPreferences {
  let value: unknown;
  try { value = JSON.parse(window.localStorage.getItem(OPTIMIZATION_PREFERENCE_KEY) ?? 'null'); }
  catch { return defaultWorkspaceOptimizationPreferences(); }
  const accepted = checkedOptimizationPreferences(value);
  if (!accepted) return defaultWorkspaceOptimizationPreferences();
  const stored=value as StoredOptimizationPreferences;
  if (stored.version!==accepted.version||stored.defaultKind!==accepted.defaultKind||Object.hasOwn(stored,'forcefield')||Object.hasOwn(stored,'periodicXtb')) {
    // Initialize safely even when storage is blocked/full. Keep the validated
    // method/range choices in memory and retry persistence on the next read.
    try { window.localStorage.setItem(OPTIMIZATION_PREFERENCE_KEY, JSON.stringify(accepted)); } catch { /* Read must not break UI initialization. */ }
  }
  return accepted;
}
export function workspaceOptimizationAlpb(preferences:WorkspaceOptimizationPreferences) {
  const solvation=preferences.xtb.solvation;
  return solvation?.model==='alpb'?{model:'alpb' as const,solvent:solvation.solvent}:undefined;
}
export function writeWorkspaceOptimizationPreferences(value: StoredOptimizationPreferences, explicitSolvent=false): WorkspaceOptimizationPreferences {
  const accepted = checkedOptimizationPreferences(value);
  if(!accepted)throw new Error('优化偏好中的方法、范围、迭代预算或溶剂无效。');
  window.localStorage.setItem(OPTIMIZATION_PREFERENCE_KEY, JSON.stringify(accepted));
  window.dispatchEvent(new CustomEvent(OPTIMIZATION_PREFERENCE_EVENT, { detail: accepted }));
  if(explicitSolvent)window.dispatchEvent(new CustomEvent(OPTIMIZATION_SOLVATION_EVENT,{detail:workspaceOptimizationAlpb(accepted)}));
  return accepted;
}

/** UI tool choices only. Model/Undo, yellow selection, input capture and shared
 * constraints are deliberately not members of this state. */
export interface ToolSessionState {
  element: string | null;
  persistentTool: PersistentModelTool | null;
  copiedTool: boolean;
  freezeTool: FreezeModelTool | null;
  geometryOpen: boolean;
  observationTool: ObservationModelTool;
  presetId: string;
  template: string;
  activeFragmentIndex: number;
  copiedPayload: ClipboardPayload | null;
  copyActiveIndex: number;
  previewSource: ActiveStructurePreviewSource;
  previewActiveIndex: number | undefined;
}

export type ToolSessionIntent =
  | { type: 'select-element'; element: string; presetId: string; origin?: 'keyboard' }
  | { type: 'clear-element' }
  | { type: 'select-persistent'; tool: PersistentModelTool }
  | { type: 'select-template'; templateId: string; activeIndex: number; activate: boolean }
  | { type: 'select-copy'; payload: ClipboardPayload; activeIndex: number }
  | { type: 'clipboard-cache'; payload: ClipboardPayload }
  | { type: 'preview-atom'; kind: 'element'; element: string; index: number }
  | { type: 'preview-atom'; kind: 'template' | 'copy'; index: number }
  | { type: 'observe'; tool: ObservationModelTool }
  | { type: 'freeze'; tool: FreezeModelTool | null }
  | { type: 'measure'; mode: MeasurementState['mode'] }
  | { type: 'clear-measurement-pending' }
  | { type: 'capture-start'; atomIds: readonly string[] }
  | { type: 'capture-end' }
  | { type: 'escape'; captureActive: boolean }
  | { type: 'document-reset' }
  | { type: 'runtime-status'; locked: boolean };

export type ToolMeasurementPolicy =
  | { type: 'preserve' }
  | { type: 'mode'; mode: MeasurementState['mode'] }
  | { type: 'document-reset' };
export interface ToolSessionTransition {
  /** Missing means preserve; an explicit undefined preview index means clear. */
  patch: Partial<ToolSessionState>;
  keyboard: 'preserve' | 'set-element' | 'document-reset' | 'suspend';
  measurement: ToolMeasurementPolicy;
  cancelManualGeometry: boolean;
  advancePreviewIntent: boolean;
  focusCanvas: boolean;
  /** Capture has its own identity/validation, not a modelling selection. */
  captureAtomIds?: string[];
}

const preserve = (): ToolSessionTransition => ({
  patch: {}, keyboard: 'preserve', measurement: { type: 'preserve' },
  cancelManualGeometry: false, advancePreviewIntent: false, focusCanvas: false,
});

/** Choosing an editing/observation tool retires pending interaction and asks
 * the workspace to close its geometry editor. Completed BAD records, other
 * selections and task definitions retain their own owners. */
function choice(patch: Partial<ToolSessionState>, keyboard: ToolSessionTransition['keyboard'] = 'set-element', focusCanvas = true): ToolSessionTransition {
  return {
    patch: { element: null, persistentTool: null, copiedTool: false, freezeTool: null,
      geometryOpen: false, observationTool: 'rotate', ...patch },
    keyboard, measurement: { type: 'mode', mode: null }, cancelManualGeometry: true,
    advancePreviewIntent: true, focusCanvas,
  };
}

/** Pure intent -> transition policy. Callers first validate preset/index,
 * edit locks and async identity; this layer never starts I/O or model edits.
 * Intent-specific branches intentionally replace a universal reset: capture,
 * document replacement, keyboard adoption and runtime completion differ. */
export function planToolSessionTransition(intent: ToolSessionIntent): ToolSessionTransition {
  switch (intent.type) {
    case 'select-element':
      return choice({ element: intent.element, presetId: intent.presetId,
        previewSource: { kind: 'element', presetId: intent.presetId }, previewActiveIndex: undefined },
      intent.origin === 'keyboard' ? 'preserve' : 'set-element', intent.origin !== 'keyboard');
    case 'clear-element':
      // The displayed seed/anchor remains available for Ctrl+V, as before.
      return choice({});
    case 'select-persistent':
      return choice({ persistentTool: intent.tool });
    case 'select-template': {
      const preview = { template: intent.templateId, activeFragmentIndex: intent.activeIndex,
        previewSource: { kind: 'template' as const, templateId: intent.templateId }, previewActiveIndex: undefined };
      // Retain the existing read-only template-preview update when activation
      // is blocked. Do not arm a tool, cancel a gesture or change its epoch.
      return intent.activate ? choice({ ...preview, persistentTool: 'fragment' }) : { ...preserve(), patch: preview };
    }
    case 'select-copy':
      return choice({ persistentTool: 'fragment', copiedTool: true, copiedPayload: intent.payload,
        copyActiveIndex: intent.activeIndex, previewSource: { kind: 'copy', payload: intent.payload }, previewActiveIndex: intent.activeIndex });
    case 'clipboard-cache':
      // An arriving clipboard notification is data, not a new user tool intent.
      return { ...preserve(), patch: { copiedPayload: intent.payload, copyActiveIndex: 0 } };
    case 'preview-atom':
      return choice(intent.kind === 'element'
        ? { element: intent.element, previewActiveIndex: intent.index }
        : { persistentTool: 'fragment', copiedTool: intent.kind === 'copy', previewActiveIndex: intent.index,
          ...(intent.kind === 'copy' ? { copyActiveIndex: intent.index } : { activeFragmentIndex: intent.index }) },
      'set-element', false);
    case 'observe':
      return choice({ observationTool: intent.tool });
    case 'freeze':
      return choice({ freezeTool: intent.tool });
    case 'measure':
      return { ...choice({}), measurement: { type: 'mode', mode: intent.mode } };
    case 'clear-measurement-pending':
      // C/R key processing has already updated the keyboard. Do not reset
      // held C digits, copied/freeze choices or the element at this boundary.
      return { ...preserve(), patch: { persistentTool: null, geometryOpen: false, observationTool: 'rotate' },
        measurement: { type: 'mode', mode: null }, cancelManualGeometry: true };
    case 'capture-start':
      // The workspace commits any existing manual gesture before this intent.
      // Capture IDs and BAD records remain separate from the yellow selection.
      return { ...preserve(), captureAtomIds: [...intent.atomIds], focusCanvas: true };
    case 'capture-end':
      // Never restore a pre-capture tool over a newer explicit user choice.
      return { ...preserve(), captureAtomIds: [] };
    case 'escape':
      // The keyboard port already performs Escape's own reset. Capture cancel
      // returns before clearing measurement/selection in the legacy workflow.
      return { ...preserve(), patch: { copiedTool: false, freezeTool: null, persistentTool: null,
        geometryOpen: false, ...(!intent.captureActive ? { observationTool: 'rotate' as const } : {}) },
        cancelManualGeometry: true,
        measurement: intent.captureActive ? { type: 'preserve' } : { type: 'mode', mode: 'auto' } };
    case 'document-reset':
      // Preserve the existing preview preferences; replace measurement history
      // only when document identity is reset, not on a tool/runtime transition.
      return { ...preserve(), patch: { element: null, freezeTool: null, persistentTool: null, geometryOpen: false },
        keyboard: 'document-reset', measurement: { type: 'document-reset' } };
    case 'runtime-status':
      // Runtime owns an edit lock, not a saved element/tool to restore later.
      return { ...preserve(), keyboard: intent.locked ? 'suspend' : 'preserve' };
  }
}

/** Apply only the specified measurement policy. The workspace separately
 * retires an editor-owned active record when a tool closes that editor. */
export function applyToolSessionMeasurement(previous: MeasurementSession, policy: ToolMeasurementPolicy): MeasurementSession {
  if (policy.type === 'preserve') return previous;
  return policy.type === 'document-reset' ? emptyMeasurementSession() : setMeasurementMode(previous, policy.mode);
}
