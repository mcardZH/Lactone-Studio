import {DismissibleNotice} from '../DismissibleNotice';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type SetStateAction } from 'react';
import { Snowflake } from 'lucide-react';
import {copyPlainText} from '../clipboard-text';
import GeneratedInputEditor from '../GeneratedInputEditor';
import DialogShell from '../DialogShell';
import {editOrcaGeneratedFile,orcaGeneratedSource,type OrcaGeneratedDraft} from '../../modeling/application/orca-generated-draft';
import { buildOrcaCommon, createOrcaCommonSettings, getOrcaCommonMethodProfile, getOrcaCommonCompatibility, type OrcaJobRequest, type OrcaSettings } from '../../core/orca';
import { referencedOrcaAssets } from '../../core/orca/assets';
import { orcaExternalInputDraft, selectOrcaMainInput, type ExternalInputDraft, type SubmitExternalInput } from '../../task-system/integration/input-draft';
import type { InputStructureSource,Structure } from '../../core/types';
import type { BuilderApplyResult } from '../../core/builder-draft';
import { applySharedOrcaConstraints, captureOrcaAssignments, integrateOrcaBuilderResult, invalidateOrcaRequestForModel } from '../../modeling/application/orca-bridge';
import {createInputExportGuard,type GuardedInputRequest} from '../../modeling/application/input-export-guard';
import { captureOrcaCoordinates } from '../../modeling/application/orca-bridge';
import { createModelStore } from '../../core/modeling';
import { projectSessionModel } from '../../modeling/application/session-projection';
import { freezeDefinitionSignature, orcaFreezeDefinitions, projectCanonicalOrcaFreezes } from '../../modeling/application/canonical-freezes';
import { hasOrcaAutomaticTitle, initialOrcaNamingPolicy, projectOrcaImportedNaming, type OrcaNamingPolicy } from '../../modeling/application/orca-import-naming';
import { resolveOrcaElectronicState } from '../../modeling/application/orca-electronic-state';
import type { DynamicsController } from '../../modeling/dynamics/controller';
import { importStructureFiles } from '../../core/file-import';
import { withAtomIds } from '../../core/structures';
import { electronicStateError } from '../../core/elements';
import { initialBaseElectronicState } from '../../core/base-electronic-state';
import type { TaskSelectionHandle, TaskSelectionIntent } from '../../modeling/contracts';
import { inputSelectionIndices } from '../../core/input-selection';
import BaseElectronicStateFields from '../BaseElectronicStateFields';
import { OrcaResourceControls } from '../ResourceControls';
import { orcaIssueSelector, revealInputValidationTarget } from '../validationNavigation';
import OrcaBsseControls from './OrcaBsseControls';
import { orcaTaskStem } from '../../core/orca/naming';
import FontSizeControl from '../FontSizeControl';
import {useInterfaceFontSize} from '../interface-font-preferences';
import type {MultiStructureSourceActions} from '../MultiStructureSourcePicker';
import {projectOrcaTaskStructure} from '../../modeling/application/task-structure-projection';
import { SolventControls, type SolventDraftMemory } from '../SolventControls';
import SoftwareChooser from '../SoftwareChooser';
import InteractiveSelectionField from '../InteractiveSelectionField';
import ModelWorkspace from '../modeling/ModelWorkspace';
import OrcaTaskControls from './OrcaTaskControls';
import {batchInputTaskAllowed} from '../../modeling/application/batch-input-session';
import OrcaScfControls from './OrcaScfControls';
import OrcaFreezeControls from './OrcaFreezeControls';
import OrcaCoordinates, { atomNumbers } from './OrcaCoordinates';
import OrcaAssets from './OrcaAssets';
import OrcaTaskPicker from './OrcaTaskPicker';
import OrcaLevel from './OrcaLevel';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsLayout, InputSettingsReferenceRow, InputSettingsSection } from '../InputSettingsLayout';
import { solventModelForTaskChange, solventSelectionForModelChange } from '../../core/solvents';
import { pausedOrcaCapability } from '../input-capabilities';
import { ORCA_TASKS } from './task-catalog';
import { WorkflowContentCard, WorkflowHeader, WorkflowSteps, WorkflowNavigation, WORKFLOW_STEPS } from '../WorkflowPresentation';
import './orca.css';
import './orca-readability.css';
export { ORCA_TASKS } from './task-catalog';

export interface OrcaWorkbenchProps extends MultiStructureSourceActions {
  active?:boolean;
  generatedDraft?:OrcaGeneratedDraft;
  onGeneratedDraftChange?:(task:OrcaJobRequest['settings']['task'],draft:OrcaGeneratedDraft)=>void;
  onSubmitExternalInput?: SubmitExternalInput;
  onCaptureExternalDraft?: (capture: (() => ExternalInputDraft | null) | null) => void;
  onPreparedInput?:(input:import('../citations/state').PreparedCitationInput)=>void;
  onResetTask?:()=>void;
  onResetElectronicState?:()=>void;
  onBeforeLocalReset?:()=>void;
  onFreezeEnabledChange?:(enabled:boolean)=>void;
  onGenerateBatch?:(request:OrcaJobRequest,assertCurrent:()=>void)=>Promise<void>;
  sharedConstraints?:import('../../modeling/contracts').SharedModelConstraints;
  sourceCandidates?:InputStructureSource[];
  request: OrcaJobRequest;
  onChange: (next: OrcaJobRequest) => void;
  onGaussian: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
  selected?: number[];
  onSelectionChange?: (selection: number[]) => void;
  onModelResult?: (result: BuilderApplyResult) => boolean;
  beforeExport?: (request:OrcaJobRequest) => Promise<GuardedInputRequest<OrcaJobRequest>>;
  onEffectiveRequest?: (request: OrcaJobRequest) => void;
  workflowStep?: number;
  onWorkflowStep?: (step:number) => void;
  onNavigationReady?: (navigate:((step:number)=>void)|null) => void;
  inputPreview?: ReactNode;
  onRequestSelection?: (intent:TaskSelectionIntent)=>TaskSelectionHandle|void;
  capabilityError?: string | null;
  inputLayerEditor?: ReactNode;
  onExitMultiscale?:()=>void;
  namingPolicy?: OrcaNamingPolicy;
  onNamingPolicyChange?: (policy: OrcaNamingPolicy) => void;
  onInheritLevel?:()=>void;
  canInheritLevel?:boolean;
  onInheritFreezes?:()=>void;
  canInheritFreezes?:boolean;
}
function saveFile(name: string, content: BlobPart, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeDefaultStem(name: string) { return name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').replace(/\.{2,}/g, '.').slice(0, 70) || 'molecule'; }

export default function OrcaWorkbench({ request, onChange, onGaussian, onDirtyChange, embedded = false, selected, onSelectionChange, onModelResult, beforeExport, onEffectiveRequest, workflowStep, onWorkflowStep, onNavigationReady, inputPreview, onRequestSelection, capabilityError: inheritedCapabilityError, inputLayerEditor,onExitMultiscale,sourceCandidates,sharedConstraints,namingPolicy,onNamingPolicyChange,onInheritLevel,canInheritLevel=false,onInheritFreezes,canInheritFreezes=false,onRequestSourcePick,onImportSources,onFreezeEnabledChange,onGenerateBatch,onResetTask,onResetElectronicState,onBeforeLocalReset,onPreparedInput,onSubmitExternalInput,onCaptureExternalDraft,generatedDraft,onGeneratedDraftChange,active=true }: OrcaWorkbenchProps) {
  const [localGenerated,setLocalGenerated]=useState<Partial<Record<OrcaJobRequest['settings']['task'],OrcaGeneratedDraft>>>({});
  const generated=onGeneratedDraftChange?generatedDraft:localGenerated[request.settings.task];
  const generatedLive=useRef(generated);generatedLive.current=generated;
  function setGenerated(task:OrcaJobRequest['settings']['task'],draft:OrcaGeneratedDraft){generatedLive.current=draft;if(onGeneratedDraftChange)onGeneratedDraftChange(task,draft);else setLocalGenerated(previous=>({...previous,[task]:draft}));}
  const [replacement,setReplacement]=useState<{action:()=>void}|null>(null);
  const activeRef=useRef(active);activeRef.current=active;
  useEffect(()=>{if(!active)setReplacement(null);},[active]);
  const [localModelStore]=useState(()=>embedded?null:createModelStore(request.structure,captureOrcaAssignments(request.structure,request.settings),captureOrcaCoordinates(request.structure,request.settings)));
  const modelStore=localModelStore!;
  const modelRevision=useRef(modelStore?.getSnapshot().revision??0),projectedModel=useRef<Structure|null>(request.structure);
  const localDynamics=useRef<DynamicsController|null>(null);
  const [localStep, setLocalStep] = useState(0), [width, setWidth] = useState(30), [dirty, setDirty] = useState(false);
  const step=workflowStep??localStep;
  function setStep(action:SetStateAction<number>){const next=typeof action==='function'?action(step):action;setLocalStep(next);onWorkflowStep?.(next);}
  const [localSelection, setLocalSelection] = useState<number[]>([]), [openRequest, setOpenRequest] = useState(0);
  const selection = selected ?? localSelection;
  const [choices, setChoices] = useState<Structure[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const generating=useRef(false);
  const [generationBusy,setGenerationBusy]=useState(false);
  const submittingExternal=useRef(false);
  const [externalSubmitBusy,setExternalSubmitBusy]=useState(false);
  const [externalSubmitError,setExternalSubmitError]=useState<{message:string}|null>(null);
  const [validationFocus,setValidationFocus]=useState<{selector:string;sequence:number}|null>(null);
  const { effectiveRequest:privateEffectiveRequest } = useMemo(() => resolveOrcaElectronicState(projectOrcaTaskStructure(request)), [request]);
  const subscribeShared=useCallback((listener:()=>void)=>modelStore?.subscribe(listener)??(()=>{}),[modelStore]);
  const readSharedSnapshot=useCallback(()=>JSON.stringify(modelStore?.getSnapshot().sharedConstraints??null),[modelStore]);
  const localSharedKey=useSyncExternalStore(subscribeShared,readSharedSnapshot,readSharedSnapshot);
  const activeShared=useMemo(()=>embedded?sharedConstraints:localSharedKey==='null'?undefined:JSON.parse(localSharedKey),[embedded,sharedConstraints,localSharedKey]);
  const sharedProjection=useMemo(()=>applySharedOrcaConstraints(privateEffectiveRequest.structure,privateEffectiveRequest.settings,activeShared),[privateEffectiveRequest,activeShared]);
  const effectiveRequest=useMemo(()=>({...privateEffectiveRequest,settings:sharedProjection.settings}),[privateEffectiveRequest,sharedProjection.settings]);
  useEffect(() => { onEffectiveRequest?.(effectiveRequest); }, [effectiveRequest, onEffectiveRequest]);
  const [fontSize, setFontSize] = useInterfaceFontSize();
  const input = useRef<HTMLInputElement>(null), layout = useRef<HTMLDivElement>(null);
  const importRevision = useRef(0), dirtyRef = useRef(false);
  const solventDraft=useRef<SolventDraftMemory['current']>(null);
  const initialNaming=useRef(namingPolicy??initialOrcaNamingPolicy(request,ORCA_TASKS.find(task=>task.id===request.settings.task)!.label));
  const systemNameTouched=useRef(initialNaming.current.systemNameTouched),outputNameTouched=useRef(initialNaming.current.outputNameTouched),titleTouched=useRef(initialNaming.current.titleTouched);
  const namingPolicyKey=useRef(JSON.stringify(namingPolicy??initialNaming.current));
  if(namingPolicy&&namingPolicyKey.current!==JSON.stringify(namingPolicy)){
    namingPolicyKey.current=JSON.stringify(namingPolicy);systemNameTouched.current=namingPolicy.systemNameTouched;outputNameTouched.current=namingPolicy.outputNameTouched;titleTouched.current=namingPolicy.titleTouched;
  }
  function reportNamingPolicy(){onNamingPolicyChange?.({systemNameTouched:systemNameTouched.current,outputNameTouched:outputNameTouched.current,titleTouched:titleTouched.current});}
  useEffect(()=>{reportNamingPolicy();},[request.systemName,request.name,request.title,onNamingPolicyChange]);
  const binaryFiles = useRef(new Map<string, File>()), latest = useRef(request); latest.current = request;
  const sourceElectronicState=useRef({id:request.structure?.id,initial:request.structure?initialBaseElectronicState(request.structure):{charge:0,multiplicity:1}});
  if(sourceElectronicState.current.id!==request.structure?.id)sourceElectronicState.current={id:request.structure?.id,initial:request.structure?initialBaseElectronicState(request.structure):{charge:0,multiplicity:1}};
  function resetLocal(reset:()=>void){onBeforeLocalReset?.();reset();}
  const exportLifetime=useRef({alive:true,generation:0});
  const exportState=useRef({privateEffectiveRequest,activeShared});exportState.current={privateEffectiveRequest,activeShared};
  const conditionEpoch=useRef('');const {structure:_exportStructure,inputSources:_exportSources,...exportConditions}=privateEffectiveRequest;
  const conditionKey=JSON.stringify([exportConditions,activeShared??null]);
  if(conditionEpoch.current!==conditionKey){conditionEpoch.current=conditionKey;exportLifetime.current.generation++;}
  useEffect(()=>{exportLifetime.current.alive=true;return()=>{exportLifetime.current.alive=false;exportLifetime.current.generation++;};},[]);
  useEffect(()=>{
    if(embedded)return;
    return modelStore.subscribe(()=>{
      const document=modelStore.getSnapshot();if(document.revision===modelRevision.current)return;modelRevision.current=document.revision;
      try{const current=latest.current;const result=projectSessionModel(document,current.structure,captureOrcaAssignments(current.structure,current.settings),captureOrcaCoordinates(current.structure,current.settings),true);const next=invalidateOrcaRequestForModel(current,integrateOrcaBuilderResult(current.structure,result,current.settings));if(document.internalCoordinates?.some(row=>row.action==='scan')&&next.settings.task!=='scan'&&next.settings.task!=='md')next.settings={...next.settings,task:'scan'};if(document.sharedConstraints?.canonical)next.settings=projectCanonicalOrcaFreezes(next.structure,next.settings,document.sharedConstraints);projectedModel.current=next.structure;latest.current=next;onChange(next);setError('');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    });
  },[embedded,modelStore,onChange]);
  useEffect(()=>{if(!embedded&&request.structure&&request.structure!==projectedModel.current){projectedModel.current=request.structure;modelStore.execute({type:'replace-structure',structure:request.structure,assignments:captureOrcaAssignments(request.structure,request.settings)});}},[embedded,modelStore,request.structure]);
  useEffect(()=>{if(!embedded)modelStore.setElectronicState(request.charge,request.multiplicity);},[embedded,modelStore,request.charge,request.multiplicity]);
  const capabilityError = pausedOrcaCapability(request.settings) ?? inheritedCapabilityError;
  const s = !embedded&&activeShared?.canonical?projectCanonicalOrcaFreezes(request.structure,request.settings,activeShared):request.settings, selectedIds = selection.map(index => request.structure?.atoms[index]?.id).filter((id): id is string => !!id);
  const method = getOrcaCommonMethodProfile(s.method);
  const stateError = request.structure ? electronicStateError(request.structure.atoms, request.charge, request.multiplicity) : null;
  const result = useMemo(() => capabilityError||sharedProjection.errors.length ? {files:[],issues:[...(capabilityError?[capabilityError]:[]),...sharedProjection.errors].map(message=>({field:'settings.constraints',code:'shared-constraint-capability',severity:'error' as const,message}))} : buildOrcaCommon(effectiveRequest), [effectiveRequest,capabilityError,sharedProjection.errors]);
  const exportReady = !dirty && !!generated?.files.length;
  const generatedStale=!!generated&&generated.sourceSignature!==orcaGeneratedSource(effectiveRequest);
  const assignments = useMemo(() => captureOrcaAssignments(request.structure, s), [request.structure, s.task, s.multiscale, s.md.activeAtomIds, s.fragments, s.frozenAtomIds]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => () => { importRevision.current++; }, []);
  function reportDirty(value: boolean) { dirtyRef.current = value; setDirty(value); onDirtyChange?.(value); }
  function setSelection(value: number[]) { setLocalSelection(value); onSelectionChange?.(value); }
  const systemName = request.systemName ?? safeDefaultStem(request.structure?.name ?? 'molecule');
  function update(next: OrcaJobRequest) {
    const previousSystem = request.systemName ?? safeDefaultStem(request.structure?.name ?? 'molecule');
    const nextSystem = next.systemName ?? safeDefaultStem(next.structure?.name ?? 'molecule');
    const auto = !outputNameTouched.current && (request.name === orcaTaskStem(previousSystem, request.settings) || (!request.systemName && !request.structure));
    if (auto && next.name === request.name) next = { ...next, name: orcaTaskStem(nextSystem, next.settings) };
    if (!titleTouched.current && next.title === request.title && hasOrcaAutomaticTitle(request,ORCA_TASKS.find(task=>task.id===request.settings.task)!.label)) next = { ...next, title: `${nextSystem} - ${ORCA_TASKS.find(task => task.id === next.settings.task)!.label}` };
    latest.current=next;
    onChange(next);
  }
  function updateEffective(next: OrcaJobRequest) {
    update({ ...next, structure:request.structure, charge: request.charge, multiplicity: request.multiplicity, electronicStateConfirmed: request.electronicStateConfirmed });
  }
  function resetCoreParameters() {
    resetLocal(()=>{
      const defaults=createOrcaCommonSettings(s.task,request.structure),patch:Partial<OrcaSettings>={};
      if(['opt','optfreq','scan','ts','tdopt'].includes(s.task))patch.optimization=defaults.optimization;
      if(['freq','optfreq','ts','tdopt'].includes(s.task))patch.frequency=defaults.frequency;
      if(s.task==='td'||s.task==='tdopt')patch.excited=defaults.excited;
      if(s.task==='irc'){patch.ircMaxIterations=defaults.ircMaxIterations;patch.ircHessianId=undefined;}
      if(s.task==='nmr')patch.nmr=defaults.nmr;
      if(s.task==='stable')patch.stableOptimize=defaults.stableOptimize;
      if(s.task==='neb')patch.neb={...defaults.neb,product:s.neb.product,productSource:s.neb.productSource,reactantSource:s.neb.reactantSource,mapping:s.neb.mapping,mappingConfirmed:s.neb.mappingConfirmed,tsGuess:s.neb.tsGuess,tsGuessSource:s.neb.tsGuessSource,tsGuessMapping:s.neb.tsGuessMapping,tsGuessMappingConfirmed:s.neb.tsGuessMappingConfirmed};
      if(s.task==='md')patch.md={...defaults.md,activeAtomIds:s.md.activeAtomIds,constraints:s.md.constraints,taskIdentity:s.md.taskIdentity,restartAssetId:s.md.restartAssetId,restartConfirmed:false};
      settings(patch);
    });
  }
  function settings(patch: Partial<OrcaSettings>) {
    const current=latest.current;
    if(onGenerateBatch&&patch.task&&!batchInputTaskAllowed('orca',patch.task))return;
    if(patch.task&&patch.task!==current.settings.task)patch={...patch,solventModel:solventModelForTaskChange({engine:'orca',task:patch.task,currentModel:current.settings.solventModel,manuallySelected:current.settings.solventModelManuallySelected,selection:current.settings.solvation}) as OrcaSettings['solventModel']};
    if(patch.solventModel&&patch.solventModel!==current.settings.solventModel&&!('solvation' in patch))patch={...patch,solvation:solventSelectionForModelChange({engine:'orca',version:'common',selection:current.settings.solvation,currentModel:current.settings.solventModel,nextModel:patch.solventModel})};
    const scientific = ['version', 'method', 'basis', 'solvent', 'solvation', 'solventModel', 'unrestricted', 'multiscale'].some(key => key in patch);
    let nextSettings={...current.settings,...patch};
    if(!embedded){
      const shared=modelStore.getSnapshot().sharedConstraints!;
      const before=orcaFreezeDefinitions(current.structure,projectCanonicalOrcaFreezes(current.structure,current.settings,shared)),definitions=orcaFreezeDefinitions(current.structure,{...nextSettings,freezeEnabled:true});
      if(nextSettings.task===current.settings.task&&freezeDefinitionSignature(before)!==freezeDefinitionSignature(definitions)){
        try{
          for(const row of (nextSettings.task==='md'?nextSettings.md.constraints:nextSettings.constraints))if(row.action==='freeze'&&row.value!==undefined&&(!Number.isFinite(row.value)||row.type==='B'&&row.value<=0||row.type==='A'&&(row.value<=0||row.value>=180)))throw new Error('冻结内坐标目标值无效，请核对数值和单位。');
          localDynamics.current?.beforeExternalEdit('模型冻结已变化');latest.current={...current,settings:nextSettings};
          modelStore.beginTransaction('设置模型冻结');
          try{modelStore.execute({type:'replace-shared-atom-freezes',atomIds:definitions.frozenAtomIds});modelStore.execute({type:'replace-shared-coordinate-freezes',coordinates:definitions.coordinates});modelStore.endTransaction();}catch(cause){modelStore.cancelTransaction();throw cause;}
        }catch(cause){setError(cause instanceof Error?cause.message:String(cause));throw cause;}
      }
      nextSettings=projectCanonicalOrcaFreezes(current.structure,nextSettings,modelStore.getSnapshot().sharedConstraints!);
    }
    update({ ...current, settings:nextSettings, assets: scientific ? current.assets.map(asset => asset.orbitalEvidence ? { ...asset, orbitalEvidence: { ...asset.orbitalEvidence, compatibilityConfirmed: false } } : asset) : current.assets });
  }
  function acceptStructure(raw: Structure) {
    const current = latest.current, currentSettings = current.settings;
    const structure = withAtomIds(raw);
    const {charge,multiplicity}=initialBaseElectronicState(structure);
    const nextSettings = { ...currentSettings, frozenAtomIds: [], constraints: [], fragments: [], neb: { ...currentSettings.neb, mapping: [], mappingConfirmed: false }, md: { ...currentSettings.md, activeAtomIds: [], constraints: [], restartConfirmed: false }, multiscale: { ...currentSettings.multiscale, qmAtomIds: [], boundaries: [], graphEvidence: undefined, activeAtomIds: undefined, configurationConfirmed: false } };
    const importedNaming=projectOrcaImportedNaming(current,structure,{systemNameTouched:systemNameTouched.current,outputNameTouched:outputNameTouched.current,titleTouched:titleTouched.current},ORCA_TASKS.find(task=>task.id===currentSettings.task)!.label);
    onChange({ ...importedNaming, structure, charge, multiplicity, electronicStateConfirmed: false, settings: nextSettings, assets: current.assets.map(asset => ({ ...asset,
      orbitalEvidence: asset.orbitalEvidence ? { ...asset.orbitalEvidence, compatibilityConfirmed: false } : undefined,
      restartEvidence: asset.restartEvidence ? { ...asset.restartEvidence, conditionsConfirmed: false } : undefined,
      hessianEvidence: asset.hessianEvidence ? { ...asset.hessianEvidence, atomOrderConfirmed: false, minimumConfirmed: false } : undefined,
      mmEvidence: asset.mmEvidence ? { ...asset.mmEvidence, atomOrderConfirmed: false, bondedParametersConfirmed: false } : undefined,
    })) });
    setSelection([]); setOpenRequest(value => value + 1); setError('');
  }
  async function importFiles(files: File[]) {
    if (dirty) return;
    const revision = ++importRevision.current, original = latest.current.structure;
    setBusy(true); setError('');
    try {
      const imported = (await importStructureFiles(files)).map(withAtomIds);
      if (revision !== importRevision.current) return;
      if (dirtyRef.current || latest.current.structure !== original) throw new Error('读取期间模型已变化，请先处理当前草稿，再重新导入。');
      if (!imported.length) throw new Error('文件中没有完整结构。'); setChoices(imported); if (imported.length === 1) acceptStructure(imported[0]);
    } catch (cause) { if (revision === importRevision.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (revision === importRevision.current) setBusy(false); if (input.current) input.current.value = ''; }
  }
  function applyModel(applied: BuilderApplyResult) {
    try {
      if (onModelResult) {
        const accepted = onModelResult(applied);
        if (accepted) { setError(''); reportDirty(false); }
        return accepted;
      }
      const current = latest.current;
      const integrated = integrateOrcaBuilderResult(current.structure, applied, current.settings);
      update(invalidateOrcaRequestForModel(current, integrated));
      setError(integrated.warnings.join('；')); setSelection([]); reportDirty(false); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  }
  function resize(event: React.PointerEvent<HTMLDivElement>) {
    const target = event.currentTarget; target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => { const rect = layout.current?.getBoundingClientRect(); if (rect) setWidth(Math.max(26, Math.min(65, (next.clientX - rect.left) / rect.width * 100))); };
    const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
  }
  useEffect(()=>{
    if(step!==2||!validationFocus)return;
    const frame=requestAnimationFrame(()=>{
      const root=layout.current;if(!root)return;
      const target=revealInputValidationTarget(root,validationFocus.selector);
      root.querySelectorAll('.validation-target').forEach(item=>item.classList.remove('validation-target'));
      target?.classList.add('validation-target');
    });return()=>cancelAnimationFrame(frame);
  },[step,validationFocus]);
  async function generate() {
    if(generating.current)return;
    generating.current=true;setGenerationBusy(true);
    try{
      const first=result.issues.find(issue=>issue.severity==='error');
      if(first){setError(first.message);setStep(2);setValidationFocus(previous=>({selector:orcaIssueSelector(first.field),sequence:(previous?.sequence??0)+1}));return;}
      const previous=generatedLive.current;
      const prepared=await captureExport();prepared.assertCurrent();if(onGenerateBatch){await onGenerateBatch(prepared.captured,prepared.assertCurrent);return;}
      const commit=()=>{try{prepared.assertCurrent();if(!activeRef.current||generatedLive.current!==previous)throw new Error('输入任务或文本已变化，请重新生成。');setGenerated(prepared.captured.settings.task,{sourceSignature:orcaGeneratedSource(prepared.captured),files:structuredClone(prepared.built.files),minimumVersion:getOrcaCommonCompatibility(prepared.captured).minimumVersion,issues:structuredClone(prepared.built.issues),editedNames:[],assets:structuredClone(referencedOrcaAssets(prepared.captured))});setPreviewIndex(0);setValidationFocus(null);setError('');setStep(3);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}};
      if(previous?.editedNames.length){setReplacement({action:commit});return;}commit();
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{generating.current=false;setGenerationBusy(false);}
  }
  function navigateTo(index:number){
    // Step tabs allow inspection. Next and export retain scientific gates.
    if(index===1||index===2){setError('');setStep(index);return;}
    setError('');if(index===3&&!dirty&&!generated)void generate();else setStep(index);
  }
  useEffect(()=>{onNavigationReady?.(navigateTo);return()=>onNavigationReady?.(null);},[step,dirty,beforeExport,onNavigationReady,request,stateError]);
  function proceed() {
    if (dirty) { setError('建模草稿尚未应用，请先应用或取消。'); return; }
    setError('');
    if (step === 2) return generate(); else setStep(value => value + 1);
  }
  async function pausedInput():Promise<GuardedInputRequest<OrcaJobRequest>>{
    exportLifetime.current.generation++;
    const guard=createInputExportGuard(()=>{
      const req=exportState.current.privateEffectiveRequest,{structure:_structure,inputSources:_sources,...conditions}=req;
      const doc=modelStore?.getSnapshot();return {...exportLifetime.current,active:true,runtimeOwner:localDynamics.current,runtimeSessionId:localDynamics.current?.getSnapshot().sessionId,documentId:doc?.id??'embedded-orca',revision:doc?.revision??0,structure:embedded?null:doc?.draft.structure??req.structure,conditions:JSON.stringify([conditions,exportState.current.activeShared??null,dirtyRef.current])};
    });
    const initial=structuredClone(exportState.current.privateEffectiveRequest);
    if(beforeExport){const prepared=await beforeExport(initial);prepared.assertCurrent();guard.afterPause();return {request:prepared.request,snapshot:prepared.snapshot,assertCurrent:()=>{prepared.assertCurrent();guard.assertCurrent();}};}
    const controller=localDynamics.current,snapshot=await (controller?.getSnapshot().mode==='md'?controller.captureSnapshot():controller?.pauseAndSnapshot());guard.afterSnapshot(snapshot);guard.assertCurrent();return {request:{...initial,structure:snapshot?.structure??initial.structure},snapshot:snapshot?.detached?structuredClone(snapshot):undefined,assertCurrent:guard.assertCurrent};
  }
  async function captureExport() {
    if(capabilityError)throw new Error(capabilityError);
    const prepared=await pausedInput();prepared.assertCurrent();const captured=prepared.request;
    const projected=beforeExport?{settings:captured.settings,errors:[]}:applySharedOrcaConstraints(captured.structure,captured.settings,modelStore?.getSnapshot().sharedConstraints??activeShared);
    if(projected.errors.length)throw new Error(projected.errors.join('\n'));
    const built=buildOrcaCommon({...captured,settings:projected.settings});
    if(dirtyRef.current || !built.files.length || built.issues.some(issue=>issue.severity==='error'))throw new Error('请先补齐当前输入的科学校验项，再下载。');
    prepared.assertCurrent();return {captured,built,assertCurrent:prepared.assertCurrent};
  }
  async function downloadCurrent(){
    if(onGenerateBatch){await generate();return;}
    try{const file=generatedLive.current?.files[previewIndex]??generatedLive.current?.files[0];if(!file||dirtyRef.current)throw new Error('请先生成输入并应用建模草稿。');saveFile(file.name,file.text);if(file.role==='input')onPreparedInput?.({engine:'orca',name:file.name,text:file.text,outcome:'requested'});}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  }
  async function downloadAll() {
    if(onGenerateBatch){await generate();return;}
    try{
      const snapshot=generatedLive.current;if(!snapshot||dirtyRef.current)throw new Error('请先生成输入并应用建模草稿。');
      snapshot.files.forEach(file=>{saveFile(file.name,file.text);if(file.role==='input')onPreparedInput?.({engine:'orca',name:file.name,text:file.text,outcome:'requested'});});
      for(const asset of snapshot.assets){const file=binaryFiles.current.get(asset.id);if(file&&!snapshot.files.some(entry=>entry.name===asset.name))saveFile(asset.name,file,'application/octet-stream');}
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  }
  async function submitExternalInput() {
    if(!onSubmitExternalInput||onGenerateBatch||submittingExternal.current||!exportReady||busy||generationBusy)return;
    submittingExternal.current=true;setExternalSubmitBusy(true);setExternalSubmitError(null);
    const generation=exportLifetime.current.generation;
    try {
      // Snapshot the currently generated files; submission never invokes a writer or pauses 3D.
      const snapshot=generatedLive.current;if(!snapshot)throw new Error('请先生成输入。');
      const draft=orcaExternalInputDraft(snapshot.files,previewIndex,snapshot.assets,binaryFiles.current);
      await onSubmitExternalInput(draft);
    } catch(cause) {
      if(exportLifetime.current.alive&&exportLifetime.current.generation===generation)setExternalSubmitError({message:cause instanceof Error?cause.message:String(cause)});
    } finally {
      submittingExternal.current=false;if(exportLifetime.current.alive)setExternalSubmitBusy(false);
    }
  }
  const captureExternalDraftRef=useRef<()=>ExternalInputDraft|null>(()=>null);
  captureExternalDraftRef.current=()=>{
    const snapshot=generatedLive.current;
    if(!snapshot||dirtyRef.current||!exportReady||onGenerateBatch)return null;
    if(generatedStale){
      if(snapshot.editedNames.length>0)return null;
      if(!result.files.length||result.issues.some(issue=>issue.severity==='error'))return null;
      return orcaExternalInputDraft(result.files,0,referencedOrcaAssets(effectiveRequest),binaryFiles.current);
    }
    return orcaExternalInputDraft(snapshot.files,previewIndex,snapshot.assets,binaryFiles.current);
  };
  useEffect(()=>{if(!onCaptureExternalDraft)return;onCaptureExternalDraft(()=>captureExternalDraftRef.current());return()=>onCaptureExternalDraft(null);},[onCaptureExternalDraft]);
  function electronic(patch: Pick<Partial<OrcaJobRequest>, 'charge' | 'multiplicity'>) {
    const next={...request,...patch};
    update({ ...next, electronicStateConfirmed:false, settings: { ...s, neb: { ...s.neb, mappingConfirmed: false }, md: { ...s.md, restartConfirmed: false }, multiscale: { ...s.multiscale, configurationConfirmed: false } }, assets: request.assets.map(asset => asset.orbitalEvidence ? { ...asset, orbitalEvidence: { ...asset.orbitalEvidence, compatibilityConfirmed: false } } : asset) });
  }
  async function copyCurrent(){
    const snapshot=generatedLive.current,file=snapshot?.files[previewIndex]??snapshot?.files[0],generation=exportLifetime.current.generation;
    if(!file)return;
    try{await copyPlainText(file.text);if(!activeRef.current||!exportLifetime.current.alive||exportLifetime.current.generation!==generation||generatedLive.current!==snapshot)return;if(file.role==='input')onPreparedInput?.({engine:'orca',name:file.name,text:file.text,outcome:'copied'});}catch(cause){if(activeRef.current&&exportLifetime.current.alive&&exportLifetime.current.generation===generation)setError(cause instanceof Error?cause.message:'剪贴板不可用，请在编辑器全选复制。');}
  }
  const outputFiles=generated?.files??[],file=outputFiles[previewIndex]??outputFiles[0];
  const downloadCount=outputFiles.length+(generated?.assets.filter(asset=>binaryFiles.current.has(asset.id)&&!outputFiles.some(entry=>entry.name===asset.name)).length??0);
  const workflowFooter = <>{inputPreview}<WorkflowNavigation engine="orca" step={step} busy={generationBusy} onBack={()=>{setError('');setStep(value=>value-1);}} onNext={proceed} onGenerate={()=>void generate()}/></>;
  return <div className={`orca-workbench${embedded ? ' orca-workbench-embedded' : ''}`} data-testid="orca-workbench" data-font-size={embedded ? undefined : fontSize} data-embedded={embedded} style={embedded ? { height: '100%', minHeight: 0 } : undefined}>
    {!embedded && <WorkflowHeader engine="orca" disabled={dirty} onEngine={engine => { if (engine === 'gaussian') onGaussian(); }}><FontSizeControl value={fontSize} onChange={setFontSize} /><span className="local-status"><span />本地处理</span></WorkflowHeader>}
    {dirty && <p className="orca-dirty-status" role="status">建模草稿尚未应用，请先应用或取消，再切换软件。</p>}
    {!embedded&&<div className="orca-workflow-heading"><h1>输入工作台<span className="beta-label">桌面建模</span></h1><WorkflowSteps step={step} onStep={navigateTo} label="ORCA输入步骤" /></div>}
    <div className="orca-layout" ref={layout} style={{ '--orca-form-width': embedded ? '100%' : `${width}%`, ...(embedded ? { display: 'block' } : {}) } as CSSProperties}>
      <WorkflowContentCard className="orca-form-panel" title={WORKFLOW_STEPS[step]} heading={embedded} step={step} footer={workflowFooter}>
        <div className="orca-step-content engine-step-content">
          {step === 0 && !embedded && <SoftwareChooser disabled={dirty} onChoose={engine=>{if(engine==='orca'){setError('');setStep(1);}else onGaussian();}}/>}
          {step === 1 && <InputSettingsLayout><OrcaTaskPicker taskAllowed={onGenerateBatch?task=>batchInputTaskAllowed('orca',task):undefined} value={s.task} onChange={task => {settings({ task });setStep(2);}}/></InputSettingsLayout>}
          {step === 2 && <InputSettingsLayout className="input-parameter-settings">
            <InputSettingsRow className="input-task-name-row"><InputSettingsField label="任务名"><input aria-label="ORCA输出任务名" value={request.name} onChange={event=>{outputNameTouched.current=true;reportNamingPolicy();update({...request,name:event.target.value});}}/></InputSettingsField>{onResetTask&&<button type="button" className="button button-primary" style={{width:104,height:36,flex:'0 0 104px'}} onClick={onResetTask}>恢复默认</button>}</InputSettingsRow>
            <BaseElectronicStateFields onReset={onResetElectronicState??(()=>resetLocal(()=>electronic(sourceElectronicState.current.initial)))} charge={request.charge} multiplicity={request.multiplicity} confirmed={request.electronicStateConfirmed} disabled={!request.structure?.atoms.length} error={stateError} chargeLabel="ORCA总电荷" multiplicityLabel="ORCA多重度" onChargeChange={charge=>electronic({charge})} onMultiplicityChange={multiplicity=>electronic({multiplicity})} confirmationLabel="确认ORCA基础电子态" onConfirm={()=>update({...request,electronicStateConfirmed:true})}/>
            <OrcaLevel common structure={request.structure} settings={s}
              onMethod={id=>{const next=getOrcaCommonMethodProfile(id)!;settings({method:next.id,basis:next.basisPolicy==='uniform-def2'?s.basis||'def2-SVP':''});}}
              onBasis={basis=>settings({basis})}
              onRecommend={()=>resetLocal(()=>{const defaults=createOrcaCommonSettings(s.task,request.structure);settings({method:defaults.method,basis:defaults.basis});})}
              onInherit={onInheritLevel??(()=>{})} inheritDisabled={!onInheritLevel||!canInheritLevel}>
              {capabilityError&&<div className="input-capability-paused"><DismissibleNotice>{capabilityError}</DismissibleNotice>{s.task==='esd'?<button type="button" onClick={()=>setStep(1)}>选择其他任务</button>:<button type="button" onClick={()=>{
                if(onExitMultiscale){onExitMultiscale();return;}
                try{localDynamics.current?.beforeExternalEdit('退出已移除的多尺度路线');const snapshot=modelStore?.getSnapshot();if(snapshot)modelStore.execute({type:'set-assignments',assignments:{...snapshot.draft.assignments,layers:[]}});settings({multiscale:{...s.multiscale,mode:'none',configurationConfirmed:false}});}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
              }}>切换为常规全 QM</button>}</div>}
            <div data-input-section="reference-options"><InputSettingsReferenceRow><InputSettingsCheckbox ariaLabel="ORCA非限制性参考" checked={s.unrestricted} onChange={unrestricted=>settings({unrestricted})} label="非限制性参考（UKS）"/></InputSettingsReferenceRow></div>
            </OrcaLevel>
            {s.task!=='sp'&&<InputSettingsSection sectionKey="task-parameters" title={<>核心参数 <span className="input-task-code">{s.task.toUpperCase()}</span></>} actions={<InputSettingsAction reset ariaLabel="恢复ORCA核心参数默认" onClick={resetCoreParameters}>恢复默认</InputSettingsAction>}>
              <OrcaTaskControls section="task" request={privateEffectiveRequest} onChange={updateEffective} onBeforeLocalReset={onBeforeLocalReset} selectedIds={selectedIds} onRequestSelection={onRequestSelection} sourceCandidates={sourceCandidates} onRequestSourcePick={onRequestSourcePick} onImportSources={onImportSources}/>
              {s.task==='scan'&&<OrcaCoordinates mode="scan" value={s.constraints} onChange={constraints=>settings({constraints})} structure={request.structure} selectedIds={selectedIds} taskId={s.task} onRequestSelection={onRequestSelection}/>}
              {s.task==='bsse'&&<OrcaBsseControls request={request} onChange={update} selectedIds={selectedIds} onRequestSelection={onRequestSelection}/>}
            </InputSettingsSection>}
            <OrcaFreezeControls internalCoordinatesDisabled={!!onGenerateBatch} freezeEnabled={activeShared?.enabled!==false} onFreezeEnabledChange={embedded?onFreezeEnabledChange:enabled=>{try{modelStore.execute({type:'set-shared-freezes-enabled',enabled});setError('');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}} settings={s} structure={request.structure} selectedIds={selectedIds} onChange={settings} onRequestSelection={onRequestSelection} sharedFreezeCounts={{atoms:activeShared?.frozenAtomIds.length??0,coordinates:activeShared?.coordinates.length??0}} onInherit={onInheritFreezes??(()=>{})} inheritDisabled={!onInheritFreezes||!canInheritFreezes}/>
            <div data-input-section="solvent"><SolventControls onReset={()=>resetLocal(()=>{solventDraft.current=null;const defaults=createOrcaCommonSettings(s.task,request.structure);settings({solvent:defaults.solvent,solventModel:defaults.solventModel,solvation:defaults.solvation,solventModelManuallySelected:false});})} draftMemory={solventDraft} task={s.task} modelManuallySelected={s.solventModelManuallySelected} engine="orca" version="common" model={s.solventModel} solvent={s.solvent} selection={s.solvation} requireRefractiveIndex={['td','tdopt','esd'].includes(s.task)} onChange={patch=>settings(patch)} onModelChange={(model,origin)=>settings({solventModel:model as 'cpcm'|'smd',...(origin==='manual'?{solventModelManuallySelected:true}:{})})}/></div>
            {method?.family==='coupled-cluster'&&<InputSettingsSection sectionKey="advanced" title="软件高级设置" collapsible actions={<InputSettingsAction reset ariaLabel="恢复软件高级设置默认" onClick={()=>resetLocal(()=>settings({pno:createOrcaCommonSettings(s.task,request.structure).pno}))}>恢复软件高级设置默认</InputSettingsAction>}>
              <InputSettingsField label="PNO 等级"><select aria-label="ORCA PNO等级" value={s.pno} onChange={event=>settings({pno:event.target.value as OrcaSettings['pno']})}><option value="loose">LoosePNO</option><option value="normal">NormalPNO</option><option value="tight">TightPNO</option></select></InputSettingsField>
            </InputSettingsSection>}
            <OrcaScfControls settings={s} onChange={settings} onResetScf={()=>resetLocal(()=>settings({scf:createOrcaCommonSettings(s.task,request.structure).scf,parameterDrafts:{...s.parameterDrafts,scf:undefined}}))} onResetGrid={()=>resetLocal(()=>settings({grid:createOrcaCommonSettings(s.task,request.structure).grid,parameterDrafts:{...s.parameterDrafts,grid:undefined}}))}/>
            <InputSettingsSection sectionKey="naming-resources" title="计算资源" status={request.resourcesConfirmed===true?'confirmed':'pending'} actions={<InputSettingsAction reset ariaLabel="恢复ORCA计算资源默认" onClick={()=>resetLocal(()=>update({...request,cores:1,memoryGB:1,resourcesConfirmed:false}))}>恢复计算资源默认</InputSettingsAction>}>
              <OrcaResourceControls cores={request.cores} memory={request.memoryGB} confirmed={request.resourcesConfirmed===true} onConfirm={()=>update({...request,resourcesConfirmed:true})} onChange={patch=>update({...request,...patch,resourcesConfirmed:false})}/>
            </InputSettingsSection>
            <div data-input-section="source">
              <OrcaAssets request={privateEffectiveRequest} onChange={updateEffective} onBinary={(id,file)=>binaryFiles.current.set(id,file)}/>
            </div>
          </InputSettingsLayout>}
          {step === 3 && <GeneratedInputEditor engine="orca" files={outputFiles} index={previewIndex} onSelect={setPreviewIndex} edited={!!file&&!!generated?.editedNames.includes(file.name)} stale={generatedStale} busy={generationBusy} readOnly={!!onGenerateBatch||file?.role!=='input'} onEdit={text=>{if(generated)setGenerated(s.task,editOrcaGeneratedFile(generated,previewIndex<outputFiles.length?previewIndex:0,text));}} onCopy={()=>void copyCurrent()} onDownload={()=>void downloadCurrent()} onDownloadAll={()=>void downloadAll()} downloadCount={downloadCount} onSubmit={onSubmitExternalInput?()=>void submitExternalInput():undefined} submitDisabled={!exportReady||busy||!!onGenerateBatch||!selectOrcaMainInput(outputFiles,previewIndex)?.text.trim()} submitTitle={onGenerateBatch?'批量输入请导出后逐文件提交。':!selectOrcaMainInput(outputFiles,previewIndex)?'请选择一个主 .inp 文件后逐文件提交。':undefined} submitting={externalSubmitBusy}>
            {externalSubmitError&&<DismissibleNotice className="error-box" identity={externalSubmitError}>{externalSubmitError.message}</DismissibleNotice>}
            {!!generated?.issues?.length&&!generated.editedNames.length&&<details className="generated-input-dependency"><summary aria-label="生成输入提示">⚠ 输入提示</summary>{generated.issues.map((issue,i)=><p key={i}>{issue.message}</p>)}</details>}
            {generated?.assets.some(asset=>asset.kind==='gbw')&&<p className="generated-input-dependency">GBW 为独立二进制运行依赖；未保留原始文件的引用需另行提供对应文件。</p>}
          </GeneratedInputEditor>}
          {embedded && error && step !== 0 && <DismissibleNotice className="error-box" role="alert">{error}</DismissibleNotice>}
        </div>
      </WorkflowContentCard>
      {!embedded && <div className="orca-divider" role="separator" tabIndex={0} aria-label="调整ORCA参数区宽度" aria-orientation="vertical" aria-valuemin={26} aria-valuemax={65} aria-valuenow={Math.round(width)} onPointerDown={resize} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => Math.max(26, Math.min(65, value + (event.key === 'ArrowLeft' ? -2 : 2)))); } }} />}
      {!embedded && <aside className="orca-model-panel"><button type="button" className="button button-white" disabled={busy||dirty} onClick={()=>input.current?.click()}>{busy?'正在读取…':'导入结构'}</button><input type="file" ref={input} hidden multiple aria-label="ORCA结构文件" onChange={event=>void importFiles(Array.from(event.target.files??[]))}/>{choices.length>1&&<label className="orca-field">完整结构条目<select aria-label="ORCA导入结构条目" value={choices.findIndex(choice=>choice.id===request.structure?.id)} onChange={event=>acceptStructure(choices[Number(event.target.value)])}><option value={-1}>选择需要的完整结构</option>{choices.map((choice,i)=><option value={i} key={choice.id}>{choice.name} · {choice.atoms.length} 原子</option>)}</select></label>}<ModelWorkspace realtime store={modelStore} onDynamicsController={value=>{localDynamics.current=value;}} structure={request.structure} orcaJobRequest={privateEffectiveRequest} assignments={assignments} selected={selection} onSelect={setSelection} onApply={applyModel} onDraftChange={reportDirty} onCancel={() => reportDirty(false)} openRequest={openRequest} /><p className="orca-model-note">当前选区：{atomNumbers(selectedIds, request.structure) || '无'} · 仅在点击“采用选区”后写入 QM、冻结或 MD 活动区域</p>{error && <DismissibleNotice className="error-box" role="alert">{error}</DismissibleNotice>}</aside>}
    </div>
    {replacement&&<DialogShell className="input-replacement-dialog" aria-label="重新生成会替换手工编辑" onCancel={()=>setReplacement(null)}><h2>重新生成会替换手工编辑</h2><p>当前输入文本已修改。重新生成将使用已捕获的表单设置替换生成文件，是否继续？</p><div className="modal-buttons"><button type="button" className="button button-white" onClick={()=>setReplacement(null)}>取消</button><button type="button" className="button button-primary" onClick={()=>{const action=replacement.action;setReplacement(null);action();}}>替换并重新生成</button></div></DialogShell>}
  </div>;
}
