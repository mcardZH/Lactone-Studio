import { copyPlainText } from './clipboard-text';
import {DismissibleNotice} from './DismissibleNotice';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type SetStateAction } from 'react';
import {createPortal} from 'react-dom';
import {useTrajectoryObservationController} from './results/trajectory-observation';
import {snapshotAdvancedInputTemplate} from './advanced/input-template-snapshot';
import { ArrowRight, Atom as AtomIcon, BookOpen, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Code2, Cpu, FileCode2, FileText, FlaskConical, Gauge, Info, Layers, Leaf, Monitor, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, Upload, Waves, X } from 'lucide-react';
import {desktopBridge} from '../modeling/platform/desktop';
import {batchInputTaskAllowed,prepareBatchInputPlan} from '../modeling/application/batch-input-session';
import {readProjectInputDrafts,restoredOrcaProjectRequest} from '../modeling/application/project-input-draft';
import type {OrcaGeneratedDrafts,OrcaGeneratedDraft} from '../modeling/application/orca-generated-draft';
import GeneratedInputEditor from './GeneratedInputEditor';
import type {AdvancedInputTemplate} from '../modeling/application/advanced-frame-output';
import {assertAdvancedOutputManifest,advancedOutputPartialLines} from './advanced/AdvancedFrameOutputControls-state';
import type { FileSettings, GaussianSettings, JobRequest, MethodId, Structure, TaskId } from '../core/types';
import { importStructureFiles } from '../core/file-import';
import { withAtomIds, extractSelection } from '../core/structures';
import { defaultAdvanced } from '../core/advanced';
import { taskStem } from '../core/naming';
import { electronicStateError, molecularFormula, suggestedMultiplicity } from '../core/elements';
import { initialBaseElectronicState, retainBaseElectronicStateConfirmation } from '../core/base-electronic-state';
import { taskSelectionRowSignature, validateInputCaptureContext, validateInputCaptureResult, rebaseInputCaptureContext, orcaFreezeCaptureObjectId } from '../core/input-capture-binding';
import { inputSelectionIndices } from '../core/input-selection';
import type { TaskSelectionIntent, TaskSelectionHandle, SelectionCaptureRequest, SelectionCaptureResult } from '../modeling/contracts';
import BaseElectronicStateFields from './BaseElectronicStateFields';
import {ScientificEditCancelledError} from '../core/modeling/analysis-binding';
import {analysisSourceElectronicState,mayMirrorElectronicState,ownsSourceElectronicState} from './modeling/analysis-electronic-state';
import { InputSettingsField, InputSettingsRow } from './InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsLayout, InputSettingsReferenceRow, InputSettingsSection } from './InputSettingsLayout';
import InputTaskPicker from './InputTaskPicker';
import { inheritGaussianSourceLevel, inheritOrcaSourceLevel } from '../core/input-source-inheritance';
import { remapSourceLevelToCurrent } from '../modeling/application/source-level-identity';
import { buildGaussian, defaultFiles, defaultSettings, previewGaussian, isSemiempirical, METHODS, methodDefaults, sourceLevel, TASKS, validateJob, setUse5D } from '../core/gaussian';
import MethodChooser from './MethodChooser';
import AdvancedOptions from './AdvancedOptions';
import SelectionPanel from './SelectionPanel';
import { SourceOptions } from './CheckpointOptions';
import MoleculeViewer from './MoleculeViewer';
import NoticeToast from './NoticeToast';
import type { Notice } from './NoticeToast';
import { humanizeValidation,useValidationNavigation } from './validationNavigation';
import TaskParameters from './TaskParameters';
import AtomPickerModal, { type AtomPickerRequest } from './AtomPickerModal';
import XtbOptions from './XtbOptions';
import { isXtb,defaultXtb,XTB_TASKS,xtbNeedsFrequency } from '../core/xtb';
import { TASK_GROUPS,defaultTaskOptions,isOptimizationTask,isEnergyTask,isZindo,supportsConstraints,coordinateAction,usesEfficientGrid,taskRecommendation } from '../core/tasks';
import type { TaskOptions } from '../core/types';
import { excitedFrequencyOnly,excitedOptimizationFrequency,excitedTarget,isExcitedOptimization,isUksOptimization } from '../core/excited-state';
import { sectionDefaults,SCF_ADVANCED_FIELDS,type DefaultSection } from '../core/section-defaults';
import { fragmentRegions } from '../core/regions';
import ResourceControls,{type ResourcePatch} from './ResourceControls';
import './workspace-eight.css';
import { deriveInheritedSettings, type SourceIssue } from '../core/gaussian-source';
import MixedBasisOptions from './MixedBasisOptions';
import GaussianFreezeControls from './FreezeControls';
import { gaussianInputFreezeDisplay, orcaInputFreezeDisplay } from '../modeling/application/input-freeze-projection';
import { applyGaussianBasisTransition, captureGaussianBasisState, transitionGaussianBasis, type GaussianBasisAction } from '../modeling/application/gaussian-basis-transition';
import { solventModelForTaskChange, solventSelectionForModelChange } from '../core/solvents';
import SoftwareChooser from './SoftwareChooser';
import GaussianImportPanel from './GaussianImportPanel';
import StructureSummary from './StructureSummary';
import FontSizeControl from './FontSizeControl';
import DialogShell from './DialogShell';
import {useInterfaceFontSize} from './interface-font-preferences';
import { basisDisplayRegions,type ViewerHighlights } from '../core/display-highlights';
import { activeCoordinates,activeFrozenAtoms } from '../core/tasks';
import { fragmentColor } from '../core/regions';
import './readability-nine.css';
import './inheritance-nine.css';
import ModelWorkspace from './modeling/ModelWorkspace';
import { builderCommittedCharge, captureBuilderAssignments } from '../core/builder-integration';
import { applySharedGaussianConstraints, captureDesktopAssignments, captureGaussianCoordinates, captureGaussianBoundCoordinates, invalidateGaussianObjectBindings, integrateDesktopBuilderResult, restoreGaussianModelSettings } from '../modeling/application/gaussian-bridge';
import { modelCoordinateKey } from '../modeling/constraints';
import { gaussianFreezeDefinitions, orcaFreezeDefinitions, projectCanonicalGaussianFreezes, projectCanonicalOrcaFreezes, freezeDefinitionSignature, preserveCanonicalFreezeTargets } from '../modeling/application/canonical-freezes';
import type { SharedModelConstraints } from '../modeling/contracts';
import { createInputExportGuard, type GuardedInputRequest } from '../modeling/application/input-export-guard';
import { clampWorkbenchPaneSize, WORKBENCH_PANE_LIMITS } from '../modeling/workbench-layout';
import { applySharedOrcaConstraints, captureOrcaAssignments, captureOrcaCoordinates, integrateOrcaBuilderResult, invalidateOrcaRequestForModel } from '../modeling/application/orca-bridge';
import { createModelStore } from '../core/modeling';
import { formalInputStructure,projectSessionElectronicState,projectSessionModel,sessionProjectionKey } from '../modeling/application/session-projection';
import { modelChange } from '../modeling/application/model-change';
import { rebaseCachedGaussianSettings, rebaseCachedOrcaSettings } from '../modeling/application/cached-input-settings';
import { inputResetPaths, applyInputResetPatch } from './input-reset-patch';
import type { DynamicsController } from '../modeling/dynamics/controller';
import { type BuilderApplyResult, type BuilderAssignment } from '../core/builder-draft';
import { editInputLayerDrafts, inputLayerCapabilityError, inputLayerPrefix, isInputLayerDraft, structureWithoutInputLayerDrafts } from '../core/input-layer-capability';
import InputLayerDraftEditor from './InputLayerDraftEditor';
import './builder-shell.css';
import './desktop-shell.css';
import { SolventControls, type SolventDraftMemory } from './SolventControls';
import { pausedGaussianCapability, pausedOrcaCapability } from './input-capabilities';
import { defaultOniomSettings } from '../core/oniom';
import OrcaWorkbench from './orca/OrcaWorkbench';
import { gaussianExternalInputDraft } from '../task-system/integration/input-draft';
import { ORCA_TASKS } from './orca/task-catalog';
import { orcaTaskStem } from '../core/orca/naming';
import { projectOrcaImportedNaming, orcaImportSystemStem, type OrcaNamingPolicy } from '../modeling/application/orca-import-naming';
import OrcaInputSummary from './orca/OrcaInputSummary';
import { createOrcaCommonSettings, type OrcaJobRequest } from '../core/orca';
import './integration-twelve.css';
import { WorkflowHeader, WorkflowSteps, WorkflowContentCard, WorkflowNavigation, WORKFLOW_STEPS } from './WorkflowPresentation';
import './workflow-presentation.css';
import WorkbenchShell from './WorkbenchShell';
import EngineInputPreview from './EngineInputPreview';
import { WorkbenchLayoutProvider, useWorkbenchLayout } from './modeling/WorkbenchLayout';
import WorkspaceShell,{type DocumentWorkspaceSurface} from './modeling/WorkspaceShell';
import type {WorkspaceActivationStamp,WorkspaceInputTaskStamp,WorkspaceDesktopBridge,WorkspaceMembership} from '../modeling/workspace-contracts';
import SharedModelWindow from './modeling/SharedModelWindow';
import {projectGaussianTaskStructure} from '../modeling/application/task-structure-projection';
import './modeling-v0202.css';
import { defaultTitle, foldPreviewCoordinates, gaussianReplacementConfirmation, jobSignature } from './application/input-presentation';
import { capturePausedGaussianRequest, capturePausedOrcaRequest, inputExportConditions } from './application/input-requests';
import { importAppStructures } from './application/structure-import';
import { inputSourceRoleKey, inputSourceRoles } from './application/input-sources';
import { inputCoordinateFold, inputFormWidth, isMultiDocumentMode, sharedWindowMembership, sharedWorkspacePresentation as projectWorkspacePresentation } from './application/app-layout';
import {applicationVersion} from '../application-version';
export { gaussianReplacementConfirmation } from './application/input-presentation';

const STEP_NAMES = WORKFLOW_STEPS;
const TASK_ICONS = { sp: Gauge, opt: AtomIcon, freq: Waves, optfreq: Layers };

function Formula({ value }: { value: string }) { return <>{value.split(/(\d+)/).map((part, i) => /^\d+$/.test(part) ? <sub key={i}>{part}</sub> : <span key={i}>{part}</span>)}</>; }
interface ModelHistoryEntry { structure:Structure|null;settings:GaussianSettings;files:FileSettings;charge:number;multiplicity:number;stateConfirmed:boolean;frequencyConfirmed:boolean;selection:number[] }

export default function App() {
  useTrajectoryObservationController();
 // This is the desktop application entry, including local development without IPC.
 // The historical browser components remain separate source files.
 const multiDocument=isMultiDocumentMode(window.location.search,true);
 const nativeBridge=window.sciyueDesktop?.readWorkspaceDocuments?window.sciyueDesktop as typeof window.sciyueDesktop&WorkspaceDesktopBridge:null;
 const [membership,setMembership]=useState<WorkspaceMembership|null>(null),[checking,setChecking]=useState(Boolean(multiDocument&&nativeBridge)),[identityError,setIdentityError]=useState('');
 useEffect(()=>{if(!multiDocument||!nativeBridge)return;let alive=true;void nativeBridge.readWorkspaceDocuments().then(rows=>{if(!alive)return;setMembership(sharedWindowMembership(rows));setChecking(false);}).catch(cause=>{if(alive){setIdentityError(cause instanceof Error?cause.message:String(cause));setChecking(false);}});return()=>{alive=false;};},[multiDocument,nativeBridge]);
 return <WorkbenchLayoutProvider>{identityError?<DismissibleNotice className="workspace-global-error">{identityError}</DismissibleNotice>:checking?<div role="status">正在连接模型文档…</div>:membership&&nativeBridge?<SharedModelWindow membership={membership} bridge={nativeBridge}/>:multiDocument?<WorkspaceShell renderDocument={surface=><AppContent workspaceSurface={surface}/>}/>:<AppContent/>}</WorkbenchLayoutProvider>;
}

function AppContent({workspaceSurface}:{workspaceSurface?:DocumentWorkspaceSurface}) {
  const batchInputSession=workspaceSurface?.batchInputSession;
  const batchSavingRef=useRef(false);
  const applicationRoot=useRef<HTMLDivElement>(null);
  const solventDraft=useRef<SolventDraftMemory['current']>(null);
  const desktopMode = true;
  const [sessionStore] = useState(() => workspaceSurface?.entry.store??createModelStore());
  const [savedInput]=useState(()=>readProjectInputDrafts(workspaceSurface?.entry.drafts,sessionStore.getSnapshot()));
  const savedGaussian=savedInput.gaussian,savedOrca=savedInput.orca;
  const [orcaGeneratedDrafts,setOrcaGeneratedDrafts]=useState<OrcaGeneratedDrafts>(()=>savedOrca?.generatedDrafts??{});
  const acceptOrcaGeneratedDraft=useCallback((task:OrcaJobRequest['settings']['task'],draft:OrcaGeneratedDraft)=>{inputDraftTouched.current=true;setOrcaGeneratedDrafts(previous=>({...previous,[task]:draft}));},[]);
  const inputDraftTouched=useRef(false);
  const sharedConstraintKey=useSyncExternalStore(sessionStore.subscribe,()=>JSON.stringify(sessionStore.getSnapshot().sharedConstraints??null));
  const sharedConstraints=useMemo(()=>sharedConstraintKey==='null'?undefined:JSON.parse(sharedConstraintKey) as import('../modeling/contracts').SharedModelConstraints,[sharedConstraintKey]);
  const coordinateObjectKey=useSyncExternalStore(sessionStore.subscribe,()=>JSON.stringify(sessionStore.getSnapshot().coordinateObjects??[]));
  const initialStructure=useRef(workspaceSurface?.entry.store.getSnapshot().draft.structure.atoms.length?workspaceSurface.entry.store.getSnapshot().draft.structure:null);
  const initialInput=useRef(workspaceSurface?.entry.initialInput);
  // Immutable source-to-ID anchor. Edited coordinates never redefine source
  // center numbers; newly added atoms cannot steal a deleted source center.
  const importedStructure=useRef<Structure|null>(initialStructure.current?structuredClone(initialStructure.current):null);
  const workspaceLive=useRef(workspaceSurface);workspaceLive.current=workspaceSurface;
  const [captureRequest,setCaptureRequest]=useState<SelectionCaptureRequest>();
  const [layerDraftRevision,setLayerDraftRevision]=useState(0);
  const captureIntent=useRef<{intent:TaskSelectionIntent;request:SelectionCaptureRequest;rowSignature:string;formOwner:GaussianSettings|OrcaJobRequest;charge:number;multiplicity:number;activation:WorkspaceActivationStamp|null;externalConditions:string}|null>(null);
  const captureDraft=useRef<string[]>([]);
  const captureImages=useRef<SelectionCaptureResult['images']>(undefined);
  const committingCapture=useRef<NonNullable<typeof captureIntent.current>|null>(null);
  const confirmSelectionAction=useRef<(result:SelectionCaptureResult)=>void>(()=>{});
  const runtimeController = useRef<DynamicsController | null>(null);
  const exportLifetime=useRef({alive:true,generation:0});
  useEffect(()=>{exportLifetime.current.alive=true;return()=>{exportLifetime.current.alive=false;exportLifetime.current.generation++;};},[]);
  const [engine,setEngine]=useState<'gaussian'|'orca'>(()=>savedGaussian||savedOrca?savedInput.activeEngine:initialInput.current?.engine??(new URLSearchParams(window.location.search).get('engine')==='orca'?'orca':'gaussian'));
  const [orcaRequest,setOrcaRequest]=useState<OrcaJobRequest>(()=>savedOrca?restoredOrcaProjectRequest(savedOrca,initialStructure.current):{structure:initialStructure.current,settings:projectCanonicalOrcaFreezes(initialStructure.current,initialInput.current?.orca??createOrcaCommonSettings('optfreq'),sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]}),charge:initialStructure.current?.charge??0,multiplicity:initialStructure.current?.multiplicity??1,electronicStateConfirmed:false,name:batchInputSession?orcaImportSystemStem(initialStructure.current?.name??'molecule'):initialInput.current?.engine==='orca'?'molecule-irc':'molecule-optdft-freq',title:initialInput.current?.engine==='orca'?'Molecule - IRC':'Molecule - optimization and frequencies',cores:1,memoryGB:1,resourcesConfirmed:false,assets:[]});
  const [orcaEffectiveRequest, setOrcaEffectiveRequest] = useState<OrcaJobRequest>(orcaRequest);
  const orcaEffectiveLive = useRef(orcaEffectiveRequest);
  const workspaceOrcaRequest=useMemo(()=>workspaceSurface?{...orcaRequest,inputSources:workspaceSurface.sources}:orcaRequest,[orcaRequest,workspaceSurface?.sources]);
  const privateOrcaModelRequest=useMemo(()=>({...workspaceOrcaRequest,charge:orcaEffectiveRequest.charge,multiplicity:orcaEffectiveRequest.multiplicity,electronicStateConfirmed:orcaEffectiveRequest.electronicStateConfirmed}),[workspaceOrcaRequest,orcaEffectiveRequest.charge,orcaEffectiveRequest.multiplicity,orcaEffectiveRequest.electronicStateConfirmed]);
  const acceptOrcaEffectiveRequest = useCallback((next: OrcaJobRequest) => { orcaEffectiveLive.current = next; setOrcaEffectiveRequest(next); }, []);
  const orcaInitialized=useRef(Boolean(savedOrca)||initialInput.current?.engine==='orca');
  const orcaNamingPolicy=useRef<OrcaNamingPolicy>(savedOrca?.naming??{systemNameTouched:Boolean(savedOrca),outputNameTouched:Boolean(savedOrca)||!!batchInputSession,titleTouched:Boolean(savedOrca)});
  const acceptOrcaNamingPolicy=useCallback((policy:OrcaNamingPolicy)=>{orcaNamingPolicy.current={...policy};},[]);
  const [orcaDirty,setOrcaDirty]=useState(savedOrca?.editorDirty??false);
  const [inputResetSerial,setInputResetSerial]=useState(0);
  const [orcaStep,setOrcaStep]=useState(savedOrca?.step??(initialInput.current?.engine==='orca'?2:0));
  const orcaNavigation=useRef<((step:number)=>void)|null>(null);
  const acceptOrcaNavigation=useCallback((navigate:((step:number)=>void)|null)=>{orcaNavigation.current=navigate;},[]);
  const [toolHost,setToolHost]=useState<HTMLDivElement|null>(null);
  const Workspace = ModelWorkspace;
  const [structures, setStructures] = useState<Structure[]>(initialStructure.current?[initialStructure.current]:[]);
  const [selected, setSelected] = useState(0);
  const [workingStructure,setWorkingStructure]=useState<Structure|null>(initialStructure.current);
  const [history,setHistory]=useState<ModelHistoryEntry[]>([]);
  const [atomSelection,setAtomSelection]=useState<number[]>([]);
  const [builderOpenRequest,setBuilderOpenRequest]=useState(0);
  const [builderDirty,setBuilderDirty]=useState(false);
  const workbench=useWorkbenchLayout();
  const [legacyFormWidth,setLegacyFormWidth]=useState(35);
  const formWidth=desktopMode?workbench.layout.paneSizes.leftWidth:legacyFormWidth;
  function setFormWidth(action:SetStateAction<number>){const next=typeof action==='function'?action(formWidth):action;if(desktopMode)workbench.updateLayout(current=>inputFormWidth(current,next));else setLegacyFormWidth(next);}
  const [summaryOpen,setSummaryOpen]=useState(false);
  const [pickerRequest,setPickerRequest]=useState<AtomPickerRequest|null>(null);
  const [legacyFoldCoordinates,setLegacyFoldCoordinates]=useState(true);
  const foldCoordinates=desktopMode?workbench.layout.folds['input.coordinates']!==false:legacyFoldCoordinates;
  function setFoldCoordinates(fold:boolean){if(desktopMode)workbench.updateLayout(current=>inputCoordinateFold(current,fold));else setLegacyFoldCoordinates(fold);}
  const [fontSize,setFontSize]=useInterfaceFontSize();
  const [inheritanceOpen,setInheritanceOpen]=useState(false);
  const [sourcePanelDismissed,setSourcePanelDismissed]=useState(false);
  const [importTarget,setImportTarget]=useState<TaskId>('optfreq');
  const [mobilePreview,setMobilePreview]=useState(false);
  const structure = formalInputStructure(workingStructure ?? structures[selected] ?? null);
  const [files, setFiles] = useState<FileSettings>(()=>savedGaussian?.files??(initialInput.current?.gaussian?{...defaultFiles(),hessian:'calcfc',readCheckpoint:false,guessRead:false,basisFromCheckpoint:false,compatibilityConfirmed:false}:defaultFiles()));
  const [step, setStep] = useState(savedGaussian?.step??(initialInput.current?.gaussian?2:0));
  useEffect(()=>{setSummaryOpen(step===3);},[step]);
  const [settings, setSettings] = useState<GaussianSettings>(()=>{if(savedGaussian)return savedGaussian.settings;const base=initialInput.current?.gaussian??defaultSettings('optfreq');if(workspaceSurface&&initialStructure.current){const result=projectSessionModel(sessionStore.getSnapshot(),initialStructure.current,captureDesktopAssignments(initialStructure.current,base),captureGaussianCoordinates(initialStructure.current,base),true);return projectCanonicalGaussianFreezes(initialStructure.current,integrateDesktopBuilderResult(initialStructure.current,result,base).settings,sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]});}return base;});
  useEffect(()=>{
    if(!desktopMode)return;
    const document=sessionStore.getSnapshot(),sanitized=invalidateGaussianObjectBindings(structure,settings,document.coordinateObjects??[]);
    if(sanitized!==settings){setSettings(sanitized);return;}
    try{sessionStore.synchronizeGaussianBoundCoordinates?.(captureGaussianBoundCoordinates(structure,settings,document.coordinateObjects??[]));}
    catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);}
  },[desktopMode,sessionStore,structure,settings,coordinateObjectKey]);
  const touched = useRef(new Set<keyof GaussianSettings>(savedGaussian?.touched??[]));
  const excitedResolution = useRef(new Set<string>());
  const [charge, setCharge] = useState(savedGaussian?.charge??(initialStructure.current?initialBaseElectronicState(initialStructure.current).charge:0));
  const [multiplicity, setMultiplicity] = useState(savedGaussian?.multiplicity??(initialStructure.current?initialBaseElectronicState(initialStructure.current).multiplicity:1));
  const [stateConfirmed, setStateConfirmed] = useState(()=>savedGaussian?.stateConfirmed??Boolean(workspaceSurface?.entry.derivation&&sessionStore.getSnapshot().electronicStateConfirmed));
  const spinLocked = useRef(false);
  const [frequencyConfirmed, setFrequencyConfirmed] = useState(savedGaussian?.frequencyConfirmed??false);
  const [cores, setCores] = useState(savedGaussian?.cores??0);
  const [memory, setMemory] = useState(savedGaussian?.memory??0);
  const [resourcesConfirmed, setResourcesConfirmed] = useState(savedGaussian?.resourcesConfirmed??false);
  const [sourceName,setSourceName]=useState(savedGaussian?.sourceName??initialStructure.current?.name??'molecule');
  const systemNameTouched=useRef(savedGaussian?.naming?.systemNameTouched??Boolean(savedGaussian));
  const [jobName, setJobName] = useState(savedGaussian?.jobName??(batchInputSession?orcaImportSystemStem(initialStructure.current?.name??'molecule'):initialStructure.current?taskStem(initialStructure.current.name,initialInput.current?.gaussian?'irc':'optfreq',initialInput.current?.gaussian?.method??'b3lyp'):'molecule-optdft-freq'));
  const [title, setTitle] = useState(savedGaussian?.title??(initialStructure.current?defaultTitle(initialStructure.current.name,initialInput.current?.gaussian?'irc':'optfreq',initialInput.current?.gaussian?.method??'b3lyp'):'Molecule - geometry optimization and frequencies'));
  const nameTouched = useRef(savedGaussian?.naming?.nameTouched??(Boolean(savedGaussian)||!!batchInputSession));
  const titleTouched = useRef(savedGaussian?.naming?.titleTouched??Boolean(savedGaussian));
  const [output, setOutput] = useState(savedGaussian?.output??'');
  const [generatedName, setGeneratedName] = useState(savedGaussian?.generatedName??'');
  const [generatedSignature, setGeneratedSignature] = useState(savedGaussian?.generatedSignature??'');
  const [editorDirty, setEditorDirty] = useState(savedGaussian?.editorDirty??false);
  const liveDraftProtection=useRef({builderDirty,editorDirty});liveDraftProtection.current={builderDirty,editorDirty};
  const [errors, setErrors] = useState<string[]>([]);
  const [notice,setNotice]=useState<Notice|null>(null);const noticeSequence=useRef(0);

  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [modal, setModal] = useState<{ title: string; text: string; action: () => void; label: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importSequence = useRef(0);
  const currentTask = TASKS.find(task => task.id === settings.task)??TASKS.find(task=>task.id==='opt')!;
  const currentMethod = METHODS.find(method => method.id === settings.method)!;
  const stateError = files.geometry === 'explicit' && structure ? electronicStateError(structure.atoms, charge, multiplicity) : files.geometry === 'check' && (!Number.isInteger(charge) || !Number.isInteger(multiplicity) || multiplicity < 1) ? '电荷必须为整数，多重度须为正整数。' : null;
  const semi = isSemiempirical(settings.method);
  const external=isXtb(settings.method);
  const zindo=isZindo(settings);
  const regions=useMemo(()=>settings.task==='bsse'&&structure?fragmentRegions((settings.taskOptions??defaultTaskOptions()).fragments):[],[settings.task,settings.taskOptions?.fragments,structure]);
  const reuseFrequency = settings.task === 'freq' && files.hessian === 'readfc';
  // Every Gaussian task uses the one user-confirmed electronic state above.
  // Target S/T and TD/UKS compatibility remain the writer's validation concern.
  const effectiveMultiplicity = multiplicity;
  const effectiveStateConfirmed = stateConfirmed;
  const privateRequest: JobRequest = useMemo(() => ({ structure, settings, charge, multiplicity: effectiveMultiplicity, electronicStateConfirmed: effectiveStateConfirmed, cores, memoryGB: memory, resourcesConfirmed, name: jobName, title, frequencyConditionsConfirmed: frequencyConfirmed, files,inputSources:workspaceSurface?.sources }), [structure, settings, charge, effectiveMultiplicity, effectiveStateConfirmed, cores, memory, resourcesConfirmed, jobName, title, frequencyConfirmed, files,workspaceSurface?.sources]);
  const sharedGaussian=useMemo(()=>applySharedGaussianConstraints(structure,settings,sharedConstraints),[structure,settings,sharedConstraints]);
  const sharedOrca=useMemo(()=>applySharedOrcaConstraints(orcaRequest.structure,orcaRequest.settings,sharedConstraints),[orcaRequest,sharedConstraints]);
  const request=useMemo(()=>projectGaussianTaskStructure({...privateRequest,settings:sharedGaussian.settings}),[privateRequest,sharedGaussian.settings]);
  const exportConditionEpoch=useRef('');
  const exportConditionKey=JSON.stringify([engine,settings,files,charge,effectiveMultiplicity,effectiveStateConfirmed,cores,memory,resourcesConfirmed,jobName,title,frequencyConfirmed,sharedConstraints??null,orcaRequest.settings,orcaRequest.charge,orcaRequest.multiplicity,orcaRequest.electronicStateConfirmed,orcaRequest.cores,orcaRequest.memoryGB,orcaRequest.resourcesConfirmed,orcaRequest.name,orcaRequest.title,orcaRequest.assets,editorDirty?output:null]);
  if(exportConditionEpoch.current!==exportConditionKey){exportConditionEpoch.current=exportConditionKey;exportLifetime.current.generation++;}
  // Model projections may legitimately change settings, q/m and confirmation.
  // Capture owns separate non-model guards; export's broader epoch must not
  // cancel an otherwise valid stable-ID selection after an atom edit.
  const {compatibilityConfirmed:_captureCompatibility,...captureFiles}=files;
  const captureExternalValue={engine,files:captureFiles,cores,memory,jobName,title,orca:{cores:orcaRequest.cores,memory:orcaRequest.memoryGB,name:orcaRequest.name,title:orcaRequest.title,assets:orcaRequest.assets},manualText:editorDirty?output:null};
  const captureExternalValueRef=useRef(captureExternalValue);captureExternalValueRef.current=captureExternalValue;
  const captureExternalKey=JSON.stringify(captureExternalValue);
  const captureExternalConditions=useRef(captureExternalKey);captureExternalConditions.current=captureExternalKey;
  const signature = jobSignature(request);
  const latestGaussian = useRef({ request, output, generatedName, generatedSignature, editorDirty });
  latestGaussian.current = { request, output, generatedName, generatedSignature, editorDirty };
  useEffect(() => {
    if (!desktopMode || editorDirty || savedGaussian&&!inputDraftTouched.current || sharedGaussian.errors.length || validateJob(request).length) return;
    setOutput(buildGaussian(request)); setGeneratedName(request.name); setGeneratedSignature(signature);
  }, [desktopMode, editorDirty, signature]);
const highlights:ViewerHighlights=useMemo(()=>({fragments:regions,basis:basisDisplayRegions(structure,settings),layers:settings.oniom?.enabled&&structure?[{id:'oniom-high',label:'QM',color:fragmentColor(10),atomIndices:structure.atoms.flatMap((atom,i)=>settings.oniom!.qmAtomIds.includes(atom.id!)?[i]:[]),style:'ball' as const},{id:'oniom-low',label:'UFF',color:fragmentColor(11),atomIndices:structure.atoms.flatMap((atom,i)=>settings.oniom!.qmAtomIds.includes(atom.id!)?[]:[i]),style:'stick' as const}]:[],frozenAtoms:activeFrozenAtoms(request).map(i=>i-1),scan:activeCoordinates(request).filter(c=>coordinateAction(c,settings.task)==='scan').map((c,i)=>({id:'scan-'+i,type:c.type,atoms:c.atoms.map(n=>n-1)})),frozenCoordinates:activeCoordinates(request).filter(c=>coordinateAction(c,settings.task)==='freeze').map((c,i)=>({id:'freeze-'+i,type:c.type,atoms:c.atoms.map(n=>n-1)}))}),[regions,settings.mixedBasis,settings.oniom,settings.taskOptions,settings.task,structure]);
const builderAssignments=useMemo(()=>{const base=(desktopMode?captureDesktopAssignments:captureBuilderAssignments)(structure,settings),context=desktopMode?sessionStore.getContext('gaussian'):undefined;return context?.assignments.layers.some(isInputLayerDraft)?{...base,layers:context.assignments.layers}:base;},[desktopMode,structure,settings.oniom,settings.mixedBasis,settings.task,settings.taskOptions?.constraintsEnabled,settings.taskOptions?.fragments,settings.taskOptions?.frozenAtoms,sessionStore,layerDraftRevision]);
  const formalModel=useRef({structure,settings,files,charge,multiplicity,stateConfirmed,frequencyConfirmed,selection:atomSelection});
  formalModel.current={structure,settings,files,charge,multiplicity,stateConfirmed,frequencyConfirmed,selection:atomSelection};
  const orcaLive = useRef(orcaRequest); orcaLive.current = orcaRequest;
  const engineLive = useRef(engine); engineLive.current = engine;
  const engineSwitchGeneration=useRef(0);
  const projectedStructure = useRef<Structure | null>(initialStructure.current);
  const projectedRevision = useRef(sessionProjectionKey(sessionStore.getSnapshot()));
  const projectedIdentity = useRef({id:sessionStore.getSnapshot().id,revision:sessionStore.getSnapshot().revision});
  const projectedDocument = useRef(sessionStore.getSnapshot());
  useEffect(() => {
    if (!desktopMode) return;
    return sessionStore.subscribe(() => {
      const document = sessionStore.getSnapshot();
      const projectionKey=sessionProjectionKey(document);
      if (projectionKey === projectedRevision.current) return;
      const previousIdentity=projectedIdentity.current;
      const previousDocument=projectedDocument.current;projectedDocument.current=document;
      projectedRevision.current = projectionKey;
      projectedIdentity.current={id:document.id,revision:document.revision};
      const live = formalModel.current, orca = orcaLive.current;
      try {
        const gaussianContext=sessionStore.getContext('gaussian');
        const gaussianDocument=gaussianContext?{...document,draft:{...document.draft,assignments:gaussianContext.assignments},internalCoordinates:gaussianContext.coordinates}:document;
        const gaussianResult = projectSessionModel(gaussianDocument, live.structure, captureDesktopAssignments(live.structure,live.settings), captureGaussianCoordinates(live.structure,live.settings), engineLive.current === 'gaussian'||!!gaussianContext);
        const integrated = integrateDesktopBuilderResult(live.structure, gaussianResult, live.settings);
        if(document.sharedConstraints?.canonical)integrated.settings=projectCanonicalGaussianFreezes(integrated.structure,integrated.settings,document.sharedConstraints);
        const change = modelChange(live.structure,integrated.structure);
        const electronicChanged=previousDocument.draft.structure.charge!==document.draft.structure.charge||previousDocument.draft.structure.multiplicity!==document.draft.structure.multiplicity||(previousDocument.electronicStateConfirmed??false)!==(document.electronicStateConfirmed??false);
        const analysisOrigin=ownsSourceElectronicState(workspaceLive.current?.entry);
        const {charge:q,multiplicity:m}=analysisOrigin?analysisSourceElectronicState(document.draft.structure):electronicChanged?{charge:document.draft.structure.charge??live.charge,multiplicity:document.draft.structure.multiplicity??live.multiplicity}:projectSessionElectronicState(previousIdentity,document,live.structure,integrated.structure,live,spinLocked.current||live.stateConfirmed);
        const confirmed = electronicChanged?(document.electronicStateConfirmed??false):retainBaseElectronicStateConfirmation(live.stateConfirmed,integrated.structure,{charge:q,multiplicity:m});
        const shared = { ...integrated.structure, charge:analysisOrigin?document.draft.structure.charge:q, multiplicity:analysisOrigin?document.draft.structure.multiplicity:m };
        if(document.draft.structure.gaussianSource){shared.gaussianSource=structuredClone(document.draft.structure.gaussianSource);shared.gaussianSources=structuredClone(document.draft.structure.gaussianSources);shared.sourceRoute=document.draft.structure.sourceRoute;setSourcePanelDismissed(false);}
        const orcaContext=sessionStore.getContext('orca');
        const orcaDocument=orcaContext?{...document,draft:{...document.draft,assignments:orcaContext.assignments},internalCoordinates:orcaContext.coordinates}:document;
        const orcaResult = projectSessionModel(orcaDocument,orca.structure,captureOrcaAssignments(orca.structure,orca.settings),captureOrcaCoordinates(orca.structure,orca.settings),engineLive.current === 'orca'||!!orcaContext);
        const namedOrca=orcaResult.structure.id!==orca.structure?.id?projectOrcaImportedNaming(orca,orcaResult.structure,orcaNamingPolicy.current,ORCA_TASKS.find(task=>task.id===orca.settings.task)!.label):orca;
        const nextOrca = invalidateOrcaRequestForModel(namedOrca,integrateOrcaBuilderResult(orca.structure,orcaResult,orca.settings));
        if(document.sharedConstraints?.canonical)nextOrca.settings=projectCanonicalOrcaFreezes(nextOrca.structure,nextOrca.settings,document.sharedConstraints);
        const formalStructure=formalInputStructure(shared);
        nextOrca.structure = formalStructure; nextOrca.charge=q; nextOrca.multiplicity=m; nextOrca.electronicStateConfirmed=confirmed;
        projectedStructure.current=shared;
        formalModel.current={...live,structure:formalStructure,settings:integrated.settings,charge:q,multiplicity:m,stateConfirmed:confirmed};
        orcaLive.current=nextOrca;
        const bound=captureIntent.current;
        if(bound&&committingCapture.current!==bound){
          const activeEngine=engineLive.current;
          const beforeSettings=activeEngine==='gaussian'?live.settings:orca.settings;
          const nextSettings=activeEngine==='gaussian'?integrated.settings:nextOrca.settings;
          const nextRow=taskSelectionRowSignature(bound.intent,nextSettings,document);
          const rebased=rebaseInputCaptureContext(bound.request,document,previousIdentity,{
            engine:activeEngine,task:nextSettings.task,previousFormMatches:bound.externalConditions===captureExternalConditions.current&&bound.formOwner===(activeEngine==='gaussian'?live.settings:orca)&&bound.charge===live.charge&&bound.multiplicity===live.multiplicity,
            previousRow:taskSelectionRowSignature(bound.intent,beforeSettings,previousDocument),expectedRow:bound.rowSignature,nextRow,
          });
          if(rebased){
            try {
              if(bound.activation)workspaceLive.current?.assertIdentityCurrent(bound.activation);
              if(workspaceLive.current?.active===false)throw new Error('选择文档已失活。');
              bound.request=rebased;bound.rowSignature=nextRow!;
              bound.formOwner=activeEngine==='gaussian'?integrated.settings:nextOrca;
              bound.charge=q;bound.multiplicity=m;
              // Only this verified projection may invalidate retained asset
              // confirmations. New/replaced assets still fail the old guard.
              const external=captureExternalValueRef.current;
              const nextExternal={...external,orca:{...external.orca,assets:nextOrca.assets}};
              captureExternalValueRef.current=nextExternal;
              bound.externalConditions=captureExternalConditions.current=JSON.stringify(nextExternal);
              if(bound.activation)bound.activation={...bound.activation,revision:document.revision};
              const ids=new Set(document.draft.structure.atoms.map(atom=>atom.id));
              captureDraft.current=captureDraft.current.filter(id=>ids.has(id));
              setCaptureRequest(rebased);
            } catch { cancelTaskSelection(); }
          }
        }
        setWorkingStructure(shared);setSettings(integrated.settings);setOrcaRequest(nextOrca);setCharge(q);setMultiplicity(m);setStateConfirmed(confirmed);setBuilderDirty(false);
        if(change.inventory || change.geometry || change.graph){setFrequencyConfirmed(false);setFiles(previous=>({...previous,compatibilityConfirmed:false}));}
      } catch(cause) { setErrors([cause instanceof Error ? cause.message : String(cause)]); }
    });
  },[desktopMode,sessionStore]);
  const cancelTaskSelection=useCallback(()=>{
    const bound=captureIntent.current;captureIntent.current=null;captureDraft.current=[];captureImages.current=undefined;setCaptureRequest(undefined);
    if(bound&&committingCapture.current!==bound)bound.intent.onEnd?.('cancelled');
  },[]);
  function assertTaskSelectionCurrent(bound:NonNullable<typeof captureIntent.current>) {
    if(!exportLifetime.current.alive||bound.externalConditions!==captureExternalConditions.current)throw new Error('输入选择界面或条件已变化，请重新选择。');
    if(bound.activation)workspaceLive.current?.assertCurrent(bound.activation);
    if(workspaceLive.current?.active===false)throw new Error('请先激活目标模型文档。');
    const document=sessionStore.getSnapshot(),activeEngine=engineLive.current,activeSettings=activeEngine==='gaussian'?formalModel.current.settings:orcaLive.current.settings;
    if(bound.formOwner!==(activeEngine==='gaussian'?formalModel.current.settings:orcaLive.current)||bound.charge!==formalModel.current.charge||bound.multiplicity!==formalModel.current.multiplicity)throw new Error('输入条件已变化，请重新选择。');
    const issue=validateInputCaptureContext(bound.request,document,activeEngine,activeSettings.task,bound.rowSignature,taskSelectionRowSignature(bound.intent,activeSettings,document));
    if(issue)throw new Error(issue);
  }
  const requestTaskSelection=useCallback((intent:TaskSelectionIntent):TaskSelectionHandle|void=>{
    try{
      cancelTaskSelection();
      const activeEngine=engineLive.current;
      if(workspaceLive.current?.inputActive)workspaceLive.current.onActivate();
      if(workspaceLive.current&&!workspaceLive.current.active)throw new Error('请先激活目标模型文档。');
      // Capture owns its draft; entering it never clears the modeling selection.
      const document=sessionStore.getSnapshot();
      const activeSettings=activeEngine==='gaussian'?formalModel.current.settings:orcaLive.current.settings;
      if(intent.engine!==activeEngine || intent.taskId&&intent.taskId!==activeSettings.task)throw new Error('选择入口与当前引擎/任务不一致。');
      const rowSignature=taskSelectionRowSignature(intent,activeSettings,document);
      if(rowSignature===null)throw new Error('选择目标行已失效。');
      inputSelectionIndices(document.draft.structure,intent.initialAtomIds??[]);
      const captured:SelectionCaptureRequest={requestId:crypto.randomUUID(),documentId:document.id,revision:document.revision,engineScope:activeEngine,taskId:activeSettings.task,rowId:intent.rowId,kind:intent.kind,purpose:intent.purpose,initialAtomIds:[...(intent.initialAtomIds??[])]};
      const bound={intent,request:captured,rowSignature,formOwner:activeEngine==='gaussian'?formalModel.current.settings:orcaLive.current,charge:formalModel.current.charge,multiplicity:formalModel.current.multiplicity,activation:workspaceLive.current?.stamp()??null,externalConditions:captureExternalConditions.current};
      captureIntent.current=bound;captureDraft.current=[...captured.initialAtomIds];setCaptureRequest(captured);
      intent.onDraftChange?.([...captureDraft.current]);
      return {
        assertCurrent:()=>assertTaskSelectionCurrent(bound),
        cancel:()=>{if(captureIntent.current?.request.requestId===captured.requestId)cancelTaskSelection();},
        confirm:()=>{
          assertTaskSelectionCurrent(bound);
          if(captureIntent.current?.request.requestId!==captured.requestId)throw new Error('交互式选择已结束或已被替换。');
          const current=sessionStore.getSnapshot();
          if(!captureDraft.current.length)throw new Error('请先选择原子或内坐标。');
          confirmSelectionAction.current({requestId:captured.requestId,documentId:current.id,revision:current.revision,atomIds:[...captureDraft.current],images:captureImages.current?.map(image=>[...image])});
        }
      };
    }catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);}
  },[sessionStore,cancelTaskSelection]);
  const previewTaskSelection=useCallback((result:SelectionCaptureResult)=>{
    const bound=captureIntent.current;
    if(!bound||bound.request.requestId!==result.requestId)return;
    try{
      assertTaskSelectionCurrent(bound);
      if(result.documentId!==bound.request.documentId||result.revision!==bound.request.revision)throw new Error('选择预览已失效。');
      inputSelectionIndices(sessionStore.getSnapshot().draft.structure,result.atomIds);
      captureDraft.current=[...result.atomIds];captureImages.current=result.images?.map(image=>[...image]);bound.intent.onDraftChange?.([...result.atomIds],captureImages.current);
    }catch(cause){cancelTaskSelection();setErrors([cause instanceof Error?cause.message:String(cause)]);}
  },[sessionStore,cancelTaskSelection]);
  const confirmTaskSelection=useCallback((result:SelectionCaptureResult)=>{
    const bound=captureIntent.current;
    if(!bound)return;
    try{
      assertTaskSelectionCurrent(bound);
      const document=sessionStore.getSnapshot(),activeEngine=engineLive.current,activeSettings=activeEngine==='gaussian'?formalModel.current.settings:orcaLive.current.settings;
      if(bound.formOwner!==(activeEngine==='gaussian'?formalModel.current.settings:orcaLive.current)||bound.charge!==formalModel.current.charge||bound.multiplicity!==formalModel.current.multiplicity)throw new Error('输入条件已变化，请重新选择。');
      const issue=validateInputCaptureResult(bound.request,result,document,activeEngine,activeSettings.task,bound.rowSignature,taskSelectionRowSignature(bound.intent,activeSettings,document));
      if(issue)throw new Error(issue);
      committingCapture.current=bound;
      let accepted:boolean|void;
      try{accepted=bound.intent.onConfirm([...result.atomIds],result.images?.map(image=>[...image]));}finally{committingCapture.current=null;}
      if(accepted===false)return;
      if(bound.intent.purpose==='coordinate'&&bound.intent.kind!=='atoms'){
        const coordinateType=bound.intent.kind==='coordinate'?({2:'B',3:'A',4:'D'} as const)[result.atomIds.length as 2|3|4]:bound.intent.kind;
        const committed=sessionStore.getSnapshot(),object=(committed.coordinateObjects??[]).find(object=>modelCoordinateKey(object)===modelCoordinateKey({type:coordinateType,atomIds:result.atomIds}));
        if(activeEngine==='gaussian')setSettings(previous=>invalidateGaussianObjectBindings(committed.draft.structure,{...previous,taskOptions:{...(previous.taskOptions??defaultTaskOptions()),coordinateDrafts:previous.taskOptions?.coordinateDrafts?.map(row=>row.id===bound.intent.rowId?{...row,objectId:object?.id}:row)}},committed.coordinateObjects??[]));
        else setOrcaRequest(previous=>{const frozen=orcaFreezeCaptureObjectId(bound.intent.rowId),md=bound.intent.rowId.startsWith('orca-md-'),index=Number(bound.intent.rowId.match(/-(\d+)$/)?.[1]);const bind=(row:OrcaJobRequest['settings']['constraints'][number],i:number)=>frozen?row.objectId===frozen.objectId:bound.intent.rowId.includes('coordinate-new-')?modelCoordinateKey(row)===modelCoordinateKey({type:coordinateType,atomIds:result.atomIds}):i===index;const next={...previous,settings:md?{...previous.settings,md:{...previous.settings.md,constraints:previous.settings.md.constraints.map((row,i)=>bind(row,i)?{...row,objectId:object?.id}:row)}}:{...previous.settings,constraints:previous.settings.constraints.map((row,i)=>bind(row,i)?{...row,objectId:object?.id}:row)}};orcaLive.current=next;return next;});
      }
      if(captureIntent.current===bound){captureIntent.current=null;captureDraft.current=[];setCaptureRequest(undefined);}
      bound.intent.onEnd?.('confirmed');setErrors([]);
    }catch(cause){cancelTaskSelection();setErrors([cause instanceof Error?cause.message:String(cause)]);}
  },[sessionStore,cancelTaskSelection]);
  confirmSelectionAction.current=confirmTaskSelection;
  const rebaseTaskSelection=useCallback((result:SelectionCaptureResult&{previousRevision:number;invalidatedAtomIds:string[]})=>{
    const bound=captureIntent.current;if(!bound||bound.request.requestId!==result.requestId)return;
    try {
      // Revision advancement already happened synchronously in the Store
      // projection above, never by trusting a stale viewport callback.
      if(result.documentId!==bound.request.documentId||result.revision!==bound.request.revision)return;
      assertTaskSelectionCurrent(bound);
      inputSelectionIndices(sessionStore.getSnapshot().draft.structure,result.atomIds);
      captureDraft.current=[...result.atomIds];captureImages.current=result.images?.map(image=>[...image]);bound.intent.onDraftChange?.([...result.atomIds],captureImages.current);
    } catch(cause){cancelTaskSelection();setErrors([cause instanceof Error?cause.message:String(cause)]);}
  },[sessionStore,cancelTaskSelection]);
  useEffect(()=>{
    const bound=captureIntent.current;if(!bound)return;
    const document=sessionStore.getSnapshot(),activeSettings=engine==='gaussian'?settings:orcaRequest.settings;
    if(bound.externalConditions!==captureExternalConditions.current||document.id!==bound.request.documentId||document.revision!==bound.request.revision||engine!==bound.request.engineScope||activeSettings.task!==bound.request.taskId||bound.formOwner!==(engine==='gaussian'?settings:orcaRequest)||bound.charge!==charge||bound.multiplicity!==multiplicity||taskSelectionRowSignature(bound.intent,activeSettings,document)!==bound.rowSignature)cancelTaskSelection();
  },[captureRequest,engine,settings,orcaRequest,charge,multiplicity,structure,captureExternalKey,sessionStore,cancelTaskSelection]);
  function layersFor(scope:'gaussian'|'orca'):BuilderAssignment[]{
    const context=sessionStore.getContext(scope);
    // Only uncommitted region drafts own an independent layer projection.
    // Scientific QM/MD activity must follow the current engine form.
    if(context?.assignments.layers.some(isInputLayerDraft))return context.assignments.layers;
    return (scope==='gaussian'?captureDesktopAssignments(structure,settings):captureOrcaAssignments(structure,orcaRequest.settings)).layers;
  }
  function layerCapabilityFor(scope:'gaussian'|'orca',source:Structure|null|undefined=structure):string|null{
    const paused=scope==='gaussian'?pausedGaussianCapability(formalModel.current.settings,layersFor(scope).some(isInputLayerDraft)):pausedOrcaCapability(orcaLive.current.settings);
    if(paused)return paused;
    if(!desktopMode)return null;
    const scientific=scope==='gaussian'?{enabled:formalModel.current.settings.oniom?.enabled??false,qmAtomIds:formalModel.current.settings.oniom?.qmAtomIds??[]}:{enabled:orcaLive.current.settings.multiscale.mode!=='none',qmAtomIds:orcaLive.current.settings.multiscale.qmAtomIds};
    return inputLayerCapabilityError(source??null,layersFor(scope),{...scientific,engine:scope});
  }
  function changeLayerDrafts(layers:BuilderAssignment[]){
    try{
      runtimeController.current?.beforeExternalEdit('输入区域草稿已变化');
      const context=sessionStore.getContext(engine),base=engine==='gaussian'?captureDesktopAssignments(structure,settings):captureOrcaAssignments(structure,orcaRequest.settings);
      const coordinates=context?.coordinates??(engine==='gaussian'?captureGaussianCoordinates(structure,settings):captureOrcaCoordinates(structure,orcaRequest.settings));
      const stable=editInputLayerDrafts(engine,layers).map((layer,index)=>({...layer,id:layers.some(value=>value.id===layer.id&&!isInputLayerDraft(value))?inputLayerPrefix(engine)+crypto.randomUUID():layer.id,label:layer.label??`区域 ${index+1}`}));
      sessionStore.synchronizeContext(context?.assignments??base,coordinates,engine);
      sessionStore.execute({type:'set-assignments',assignments:{...((context?.assignments)??base),layers:stable}});
      setLayerDraftRevision(value=>value+1);cancelTaskSelection();setErrors([]);
    }catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);}
  }
  function abandonLayerDrafts(scope:'gaussian'|'orca'=engine,orcaSettings:OrcaJobRequest['settings']=orcaRequest.settings){
    try{
      runtimeController.current?.beforeExternalEdit('显式放弃输入区域草稿');
      const source=structureWithoutInputLayerDrafts(structure,scope),context=sessionStore.getContext(scope);
      const base=scope==='gaussian'?captureDesktopAssignments(source,settings):captureOrcaAssignments(source,orcaSettings);
      const coordinates=context?.coordinates??(scope==='gaussian'?captureGaussianCoordinates(structure,settings):captureOrcaCoordinates(structure,orcaRequest.settings));
      sessionStore.synchronizeContext(context?.assignments??base,coordinates,scope);
      sessionStore.execute({type:'set-assignments',assignments:{...((context?.assignments)??base),layers:base.layers}});
      setLayerDraftRevision(value=>value+1);cancelTaskSelection();setErrors([]);
      return true;
    }catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);return false;}
  }
  function exitOrcaMultiscale(){
    const next={...orcaLive.current.settings,multiscale:{...orcaLive.current.settings.multiscale,mode:'none' as const,configurationConfirmed:false}};
    if(abandonLayerDrafts('orca',next))changeOrca({...orcaLive.current,settings:next});
  }
  const gaussianLayerError=layerCapabilityFor('gaussian');
  const orcaLayerError=layerCapabilityFor('orca');
  function layerEditor(){
    if(!desktopMode||engine!=='orca'||orcaRequest.settings.multiscale.mode!=='qm-xtb')return null;
    const active=true;
    return <InputLayerDraftEditor engine={engine} taskId={orcaRequest.settings.task} structure={structure} layers={layersFor(engine)} capabilityError={orcaLayerError} enabled={active} onChange={changeLayerDrafts} onAbandon={abandonLayerDrafts} onRequestSelection={requestTaskSelection} onMap={qmAtomIds=>{changeOrca({...orcaRequest,settings:{...orcaRequest.settings,multiscale:{...orcaRequest.settings.multiscale,qmAtomIds,configurationConfirmed:false}}});}}/>;
  }
  function gaussianPausedNotice(){
    if(!pausedGaussianCapability(settings,layersFor('gaussian').some(isInputLayerDraft)))return null;
    return <div className="input-capability-paused"><DismissibleNotice>{gaussianLayerError}</DismissibleNotice><button type="button" onClick={()=>{abandonLayerDrafts();update('oniom',{...(settings.oniom??defaultOniomSettings()),enabled:false});}}>明确切换为普通 Gaussian 设置</button></div>;
  }
  useEffect(() => {
    if(!desktopMode || structure===projectedStructure.current) return;
    const source=structure;
    if(!source)return;
    // Imported/restored geometry enters the same window document once.
    sessionStore.execute({type:'replace-structure',structure:{...source,charge,multiplicity},assignments:captureDesktopAssignments(source,settings)});
  },[structure,desktopMode,sessionStore]);
  useEffect(() => {
    if(!desktopMode)return;
    const model=sessionStore.getSnapshot().draft.structure;
    // Suggested form defaults are not evidence that an imported calculation
    // had q/M. Only explicit edits below may replace a bound source's values.
    if(!mayMirrorElectronicState(ownsSourceElectronicState(workspaceLive.current?.entry),model,{charge,multiplicity}))return;
    try {
      if(model.charge!==charge||model.multiplicity!==multiplicity||(sessionStore.getSnapshot().electronicStateConfirmed??false)!==stateConfirmed)sessionStore.setElectronicState(charge,multiplicity,stateConfirmed);
      if(model.charge!==charge || model.multiplicity!==multiplicity)runtimeController.current?.beforeExternalEdit('共享基础电子态已变化');
    } catch (cause) {
      setCharge(model.charge ?? 0); setMultiplicity(model.multiplicity ?? 1);
      setErrors(cause instanceof ScientificEditCancelledError?[]:[cause instanceof Error ? cause.message : String(cause)]); return;
    }
    setOrcaRequest(previous=> previous.charge===charge && previous.multiplicity===multiplicity && previous.electronicStateConfirmed===stateConfirmed ? previous : {...previous,structure:structure?{...structure,charge,multiplicity}:null,charge,multiplicity,electronicStateConfirmed:stateConfirmed});
  },[charge,multiplicity,stateConfirmed,structure,desktopMode,sessionStore]);
  const acceptRuntimeController=useCallback((controller:DynamicsController|null)=>{runtimeController.current=controller;workspaceLive.current?.onRuntime(controller);},[]);
  useEffect(()=>{workspaceLive.current?.onCancelSourcePick();},[engine,settings.task,orcaRequest.settings.task,workspaceSurface?.module]);
  const sourceRoleKey=inputSourceRoleKey(engine,settings,orcaRequest.settings,workspaceSurface?.entry.id);
  useEffect(()=>{workspaceLive.current?.onSourceRolesChange(inputSourceRoles(sourceRoleKey));},[sourceRoleKey]);
  useEffect(()=>{if(workspaceSurface&&(!workspaceSurface.active||!workspaceSurface.inputActive))cancelTaskSelection();},[workspaceSurface?.active,workspaceSurface?.inputActive,workspaceSurface?.module,cancelTaskSelection]);
  const gaussianTaskDrafts=useRef(new Map<TaskId,GaussianTaskDraft>((savedGaussian?.taskDrafts??[]) as [TaskId,GaussianTaskDraft][]));
  const orcaTaskNaming=useRef(new Map<OrcaJobRequest['settings']['task'],OrcaNamingPolicy>((savedOrca?.taskNaming??[]) as [OrcaJobRequest['settings']['task'],OrcaNamingPolicy][]));
  const orcaTaskDrafts=useRef(new Map<OrcaJobRequest['settings']['task'],OrcaJobRequest>((savedOrca?.taskDrafts??[]) as [OrcaJobRequest['settings']['task'],OrcaJobRequest][]));
  const gaussianDraftSignature=JSON.stringify({settings,files,charge,multiplicity,stateConfirmed,frequencyConfirmed,cores,memory,resourcesConfirmed,sourceName,jobName,title,output,generatedName,generatedSignature,editorDirty,step,activeEngine:engine,owner:{documentId:sessionStore.getSnapshot().id},naming:{systemNameTouched:systemNameTouched.current,nameTouched:nameTouched.current,titleTouched:titleTouched.current},touched:[...touched.current],taskDrafts:[...gaussianTaskDrafts.current]});
  const orcaDraftSignature=JSON.stringify({...orcaRequest,structure:null,inputSources:undefined,step:orcaStep,editorDirty:orcaDirty,activeEngine:engine,owner:{documentId:sessionStore.getSnapshot().id},naming:orcaNamingPolicy.current,taskDrafts:[...orcaTaskDrafts.current],taskNaming:[...orcaTaskNaming.current],generatedDrafts:orcaGeneratedDrafts});
  const initialDraftSignatures=useRef<{gaussian?:string;orca?:string}>({});
  useEffect(()=>{if(!workspaceLive.current)return;if(!inputDraftTouched.current)initialDraftSignatures.current.gaussian=gaussianDraftSignature;workspaceLive.current.onDraftState('gaussian',JSON.parse(gaussianDraftSignature),savedGaussian&&!inputDraftTouched.current?workspaceLive.current.entry.inputDirty.gaussian:editorDirty||initialDraftSignatures.current.gaussian!==gaussianDraftSignature);},[gaussianDraftSignature,editorDirty,workspaceSurface?.inputTaskId]);
  useEffect(()=>{if(!workspaceLive.current)return;if(!inputDraftTouched.current)initialDraftSignatures.current.orca=orcaDraftSignature;workspaceLive.current.onDraftState('orca',JSON.parse(orcaDraftSignature),savedOrca&&!inputDraftTouched.current?workspaceLive.current.entry.inputDirty.orca:orcaDirty||initialDraftSignatures.current.orca!==orcaDraftSignature);},[orcaDraftSignature,orcaDirty,workspaceSurface?.inputTaskId]);
  const stale = !!output && signature !== generatedSignature;
  const validation=useValidationNavigation(request,step,setStep,notify,()=>workspaceLive.current?.inputHost??applicationRoot.current,workspaceSurface?.inputActive??true);

  function notify(text:string,kind:'success'|'error'='success'){setNotice({id:++noticeSequence.current,text,kind});}
  function chooseBasis(action:GaussianBasisAction){
    try{
      runtimeController.current?.beforeExternalEdit('基组设置已变化');cancelTaskSelection();
      const next=desktopMode?applyGaussianBasisTransition(sessionStore,structure,settings,action):transitionGaussianBasis(settings,action);
      touched.current.add('basis');touched.current.add('mixedBasis');
      setSettings(changedConditions(next,['basis','mixedBasis']));setFiles(previous=>({...previous,compatibilityConfirmed:false}));setFrequencyConfirmed(false);setErrors([]);
    }catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);}
  }
  useEffect(()=>{if(!desktopMode||formalModel.current.settings!==settings||formalModel.current.structure!==structure)return;try{sessionStore.synchronizeGaussianBasisState?.(captureGaussianBasisState(settings),captureDesktopAssignments(structure,settings).basis);}catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);}},[desktopMode,sessionStore,settings.basis,settings.mixedBasis,settings.inheritedRoute?.basisKeyword,settings.inheritedRoute?.basisTail,settings.inheritanceIssues,structure]);
  function updateSolventModel(model:GaussianSettings['solventModel'],origin?:'manual'|'automatic'){
    update('solventModel',model);
    if(model!==settings.solventModel)update('solvation',solventSelectionForModelChange({engine:'gaussian',selection:settings.solvation,currentModel:settings.solventModel,nextModel:model}));
    if(origin==='manual')update('solventModelManuallySelected',true);
  }
  function updateSolvent(change:{solvent:string;solvation?:GaussianSettings['solvation']}){update('solvent',change.solvent==='gas'?'':change.solvent);update('solvation',change.solvation);}
  function update5D(enabled:boolean){touched.current.add('use5D');setSettings(previous=>changedConditions(setUse5D(previous,enabled),['use5D']));setFiles(previous=>({...previous,compatibilityConfirmed:false}));setFrequencyConfirmed(false);setErrors([]);}
  function changedConditions(previous:GaussianSettings,keys:string[]):GaussianSettings{const options=previous.taskOptions??defaultTaskOptions();const scientific=keys.some(key=>['method','basis','mixedBasis','dispersion','grid','integral','scf','solvent','solvation','solventModel','use5D','oniom','unrestricted','advanced','nosymm','xtb'].includes(key));if(!scientific)return previous;return {...previous,...(previous.oniom&& !keys.includes('oniom')?{oniom:{...previous.oniom,statesConfirmed:false}}:{}),taskOptions:{...options,irc:{...options.irc,confirmed:false},stable:{...options.stable,confirmed:false},fragmentStatesConfirmed:false}};}
  function update<K extends keyof GaussianSettings>(key: K, value: GaussianSettings[K]) { if(key==='xtb'&&external&&!nameTouched.current)setJobName(taskStem(sourceName,settings.task,settings.method,(value as GaussianSettings['xtb'])?.level,settings));touched.current.add(key); setSettings(previous => {const changesConditions=key!=='xtb'||(['scriptPath','executable','level','entryBasis'] as const).some(field=>(previous.xtb??defaultXtb())[field]!==((value as GaussianSettings['xtb'])??defaultXtb())[field]);const inherited={...previous.inheritedRoute};const scfChanged=key==='advanced'&&SCF_ADVANCED_FIELDS.some(field=>previous.advanced?.[field]!==((value as GaussianSettings['advanced'])??defaultAdvanced(previous.task))[field]);if(key==='unrestricted')delete inherited.methodKeyword;if(key==='scf'||scfChanged)delete inherited.scf;if(key==='grid'||key==='integral')delete inherited.integration;if(key==='solvent'||key==='solvation'||key==='solventModel')delete inherited.solvent;if(key==='basis'||key==='mixedBasis'){delete inherited.basisTail;delete inherited.basisKeyword;}return { ...changedConditions(previous,changesConditions?[key]:[]), [key]: value,inheritedRoute:inherited,inheritanceIssues:previous.inheritanceIssues?.filter(issue=>issue.field!==key&&!(key==='taskOptions'&&issue.field==='freeze')&&!(scfChanged&&issue.field==='scf')) };}); setErrors([]); setFiles(previous => ({ ...previous, compatibilityConfirmed: false })); if (settings.task === 'freq') setFrequencyConfirmed(false); }


  function defaultsForTask(task:TaskId){const next=defaultSettings(task);if(isXtb(settings.method)){Object.assign(next,methodDefaults('gfn2-xtb',task));return next;}if(!isEnergyTask(task))next.scf='default';return next;}
  function clearStructureOptions(previous:GaussianSettings):GaussianSettings{const options=previous.taskOptions??defaultTaskOptions();return {...previous,oniom:previous.oniom?{...previous.oniom,qmAtomIds:[],boundaries:[],atomTypes:{},partialCharges:{},statesConfirmed:false,topologyConfirmed:false}:undefined,mixedBasis:undefined,inheritedRoute:undefined,inheritanceIssues:undefined,taskOptions:{...options,constraintsEnabled:false,coordinates:[],coordinateDrafts:[],frozenAtoms:[],inactiveFrozenAtoms:[],fragments:defaultTaskOptions().fragments,fragmentStatesConfirmed:false,irc:{...options.irc,confirmed:false},stable:{...options.stable,confirmed:false}}};}
  function commitInputFreezes(definitions:SharedModelConstraints){
    runtimeController.current?.beforeExternalEdit('模型冻结已变化');
    if(!committingCapture.current)cancelTaskSelection();
    if(sessionStore.executeBatch){sessionStore.executeBatch([{type:'replace-shared-atom-freezes',atomIds:definitions.frozenAtomIds},{type:'replace-shared-coordinate-freezes',coordinates:definitions.coordinates}],'设置模型冻结');return;}
    sessionStore.beginTransaction('设置模型冻结');
    try{
      sessionStore.execute({type:'replace-shared-atom-freezes',atomIds:definitions.frozenAtomIds});
      sessionStore.execute({type:'replace-shared-coordinate-freezes',coordinates:definitions.coordinates});
      sessionStore.endTransaction();
    }catch(cause){sessionStore.cancelTransaction();throw cause;}
  }
  function updateTaskOptions(options:TaskOptions){
    if(!desktopMode){update('taskOptions',{...options,constraintsEnabled:true,freezeEnabled:true,inheritModelFreeze:undefined});return;}
    const live=formalModel.current,previous=live.settings,next={...previous,taskOptions:{...options,constraintsEnabled:true,freezeEnabled:true,inheritModelFreeze:undefined},inheritanceIssues:previous.inheritanceIssues?.filter(issue=>issue.field!=='freeze')};
    const shared=sessionStore.getSnapshot().sharedConstraints;
    const before=preserveCanonicalFreezeTargets(gaussianFreezeDefinitions(live.structure,previous),shared),definitions=preserveCanonicalFreezeTargets(gaussianFreezeDefinitions(live.structure,next),shared);
    if(freezeDefinitionSignature(before)===freezeDefinitionSignature(definitions)){update('taskOptions',projectCanonicalGaussianFreezes(live.structure,next,shared??{frozenAtomIds:[],coordinates:[]}).taskOptions!);return;}
    try{
      touched.current.add('taskOptions');formalModel.current={...live,settings:next};setSettings(next);
      commitInputFreezes(definitions);setErrors([]);
    }catch(cause){formalModel.current={...live,settings:previous};setSettings(previous);setErrors([cause instanceof Error?cause.message:String(cause)]);throw cause;}
  }
  function invalidateElectronicConditions(){setSettings(previous=>{const options=previous.taskOptions??defaultTaskOptions();return {...previous,taskOptions:{...options,irc:{...options.irc,confirmed:false},stable:{...options.stable,confirmed:false},fragmentStatesConfirmed:false}};});}
  function acceptBaseElectronicEdit(nextCharge:number,nextMultiplicity:number):boolean {
    if(!desktopMode||!ownsSourceElectronicState(workspaceLive.current?.entry))return true;
    const before=sessionStore.getSnapshot();
    try {
      const unchanged=Object.is(nextCharge,before.draft.structure.charge)&&Object.is(nextMultiplicity,before.draft.structure.multiplicity);
      sessionStore.setElectronicState(nextCharge,nextMultiplicity,unchanged&&(before.electronicStateConfirmed??false));
      if(before!==sessionStore.getSnapshot())runtimeController.current?.beforeExternalEdit('共享基础电子态已变化');
      return true;
    } catch(cause) {setErrors(cause instanceof ScientificEditCancelledError?[]:[cause instanceof Error?cause.message:String(cause)]);return false;}
  }
  function updateBaseState(patch:{charge?:number;multiplicity?:number}){
    const nextCharge=patch.charge??charge,nextMultiplicity=patch.multiplicity??multiplicity;
    if(!acceptBaseElectronicEdit(nextCharge,nextMultiplicity))return;
    if(patch.charge!==undefined)setCharge(patch.charge);
    if(patch.multiplicity!==undefined){setMultiplicity(patch.multiplicity);spinLocked.current=true;}
    invalidateElectronicConditions();setFrequencyConfirmed(false);setFiles(previous=>({...previous,compatibilityConfirmed:false}));setErrors([]);
    setStateConfirmed(false);
  }
  function pickAtoms(pick:AtomPickerRequest){setPickerRequest({...pick,regions:pick.regions??regions,highlights:pick.highlights??highlights,onApply:indices=>{setAtomSelection(indices);pick.onApply(indices);}});}

  function installStructure(list: Structure[], index: number) {
    const normalized=list.map(withAtomIds);const next = normalized[index];
    importedStructure.current=structuredClone(next);
    const namedOrca=projectOrcaImportedNaming(orcaLive.current,next,orcaNamingPolicy.current,ORCA_TASKS.find(task=>task.id===orcaLive.current.settings.task)!.label);
    orcaLive.current=namedOrca;setOrcaRequest(namedOrca);
    setStructures(normalized); setSelected(index);setWorkingStructure(null);setHistory([]);setAtomSelection([]);if(!systemNameTouched.current)setSourceName(next.name);validation.reset();setSettings(clearStructureOptions);
    setSourcePanelDismissed(false);setInheritanceOpen(false);setImportTarget(settings.task);
    setFiles(previous => ({ ...previous, compatibilityConfirmed: false }));
    const nextCharge = next.charge ?? 0;
    const importedState=initialBaseElectronicState(next);setCharge(importedState.charge);setMultiplicity(importedState.multiplicity);
    spinLocked.current = next.multiplicity !== null;
    setStateConfirmed(false);
    setFrequencyConfirmed(false); setErrors([]);
    if (!nameTouched.current) setJobName(taskStem(systemNameTouched.current?sourceName:next.name,settings.task,settings.method,settings.xtb?.level,settings));
    if (!titleTouched.current) setTitle(defaultTitle(systemNameTouched.current?sourceName:next.name, settings.task,settings.method,settings));
  }

  function rememberModel(){setHistory(previous=>[...previous.slice(-19),structuredClone(formalModel.current)]);}
  function openBuilder(){if(files.geometry!=='explicit'){notify('请先选择显式坐标，再编辑结构。','error');return;}if(!builderDirty)setBuilderOpenRequest(value=>value+1);setMobilePreview(true);document.querySelector('[data-testid="builder-workspace"]')?.scrollIntoView({block:'nearest'});}
  function applyBuilderModel(result:BuilderApplyResult){
    try{
      const current=formalModel.current;
      const first=integrateDesktopBuilderResult(current.structure,result,current.settings);
      const action=()=>{
        try{
          const live=formalModel.current,integrated=integrateDesktopBuilderResult(live.structure,result,live.settings);
          const nextCharge=builderCommittedCharge(live.structure,integrated.structure,live.charge);
          if(integrated.materialChanged)integrated.structure.charge=nextCharge;
          rememberModel();setWorkingStructure(withAtomIds(integrated.structure));setSettings(integrated.settings);setBuilderDirty(false);
          const ids=new Set(live.selection.flatMap(index=>live.structure?.atoms[index]?.id?[live.structure.atoms[index].id!]:[]));setAtomSelection(integrated.structure.atoms.flatMap((atom,index)=>ids.has(atom.id!)?[index]:[]));
          if(integrated.materialChanged){
            setCharge(nextCharge);
            if(!live.structure){setMultiplicity(integrated.structure.multiplicity??suggestedMultiplicity(integrated.structure.atoms,nextCharge));spinLocked.current=false;}
            setStateConfirmed(previous=>retainBaseElectronicStateConfirmation(previous,integrated.structure,{charge:nextCharge,multiplicity:live.multiplicity}));setFrequencyConfirmed(false);setErrors([]);setInheritanceOpen(false);setSourcePanelDismissed(true);
            setFiles(previous=>({...previous,geometry:'explicit',guessRead:false,hessian:['readfc','rcfc'].includes(previous.hessian)?'none':previous.hessian,basisFromCheckpoint:false,compatibilityConfirmed:false}));
          }
          if(integrated.constraintsChanged){setFrequencyConfirmed(false);setFiles(previous=>({...previous,compatibilityConfirmed:false}));}
          if(!live.structure&&sourceName==='molecule'){setSourceName(integrated.structure.name);if(!nameTouched.current)setJobName(taskStem(integrated.structure.name,settings.task,settings.method,settings.xtb?.level,settings));if(!titleTouched.current)setTitle(defaultTitle(integrated.structure.name,settings.task,settings.method,settings));}
          notify(integrated.invalidatedCoordinates.length?'结构已应用；删除原子的内坐标行需重新指定。':integrated.warnings.length?'结构已应用，区域定义有待复核项。':'结构已应用，原有分区按原子身份保留。');
          return true;
        }catch(reason){notify(reason instanceof Error?reason.message:'无法提交建模草稿。','error');return false;}
      };
      if(first.materialChanged&&editorDirty){setModal({title:'保留手工输入文本',text:'结构将更新，当前手工输入文本保留并标为未同步。',action,label:'应用结构并保留文本'});return false;}else{return action();}
    }catch(reason){notify(reason instanceof Error?reason.message:'无法提交建模草稿。','error');return false;}
  }
  function applyModel(next:Structure){
    rememberModel();setWorkingStructure(withAtomIds({...next,gaussianSource:undefined,gaussianSources:undefined}));setAtomSelection([]);setInheritanceOpen(false);setSourcePanelDismissed(true);
    if(!structure&&sourceName==='molecule'){setSourceName(next.name);if(!nameTouched.current)setJobName(taskStem(next.name,settings.task,settings.method,settings.xtb?.level,settings));if(!titleTouched.current)setTitle(defaultTitle(next.name,settings.task,settings.method,settings));}
    resetModelState(next);notify('当前工作结构已更新；原始导入结构保留。');
  }
  function resetModelState(next:Structure|null){
    const q=next?.charge??0;setCharge(q);setMultiplicity(next?.multiplicity??suggestedMultiplicity(next?.atoms??[],q));spinLocked.current=false;
    setStateConfirmed(false);setFrequencyConfirmed(false);setErrors([]);
    setSettings(clearStructureOptions);
    setFiles(previous=>({...previous,geometry:'explicit',guessRead:false,hessian:['readfc','rcfc'].includes(previous.hessian)?'none':previous.hessian,basisFromCheckpoint:false,compatibilityConfirmed:false}));
  }
  function undoModel(){const next=history.at(-1);if(!next)return;setWorkingStructure(next.structure);setHistory(previous=>previous.slice(0,-1));setAtomSelection(next.selection);setCharge(next.charge);setMultiplicity(next.multiplicity);setStateConfirmed(next.stateConfirmed);setFrequencyConfirmed(next.frequencyConfirmed);setFiles(next.files);setSettings(previous=>restoreGaussianModelSettings(previous,next.settings));notify('已撤销结构操作，并恢复对应分区。');}
  function restoreModel(){const original=structures[selected]??null;if(!original){setErrors(['本次没有导入原结构；可用撤销回到前一版本。']);return;}applyModel(original);notify('已恢复未加氢/未优化的导入原结构。');}
  function extractModel(){if(!structure)return;try{applyModel(extractSelection(structure,atomSelection));notify('已提取所选片段，不自动封端；请确认边界与电子态。');}catch(error){setErrors([(error as Error).message]);}}
  function groupModel(name:string){if(!structure)return;setWorkingStructure({...structure,groups:[...(structure.groups??[]),{name,atomIds:atomSelection.map(i=>structure.atoms[i].id!)}]});notify('分组已保存，全体系仍保留。');}

  function guardedStructureChange(action: () => void) {
    if(liveDraftProtection.current.builderDirty)setModal({title:'建模草稿尚未应用',text:'继续会放弃当前建模草稿，已提交结构和手工输入文本会保留。',action:()=>{setBuilderDirty(false);action();},label:'放弃草稿并继续'});
    else if (liveDraftProtection.current.editorDirty) setModal({ title: '输入文本已有手工修改', text: '导入新结构不会覆盖当前编辑文本；旧文本将标为未同步，之后重新生成时会再次提醒。', action, label: '继续导入结构' });
    else action();
  }

  async function importFiles(fileList: File[]) {
    await importAppStructures(fileList,{delegate:workspaceLive.current?files=>workspaceLive.current!.onImportFiles(files):undefined,load:importStructureFiles,begin:()=>++importSequence.current,isCurrent:sequence=>sequence===importSequence.current,busy:setBusy,guardChange:guardedStructureChange,
      commit:parsed=>{installStructure(parsed,0);if(parsed[0].gaussianSource)setStep(2);notify(`已读取 ${parsed[0].atoms.length} 个原子${parsed.length > 1 ? `，共${parsed.length}个结构可选` : ''}`);},error:message=>setErrors([message])});
  }

  type GaussianTaskDraft={source:Structure|null;settings:GaussianSettings;files:FileSettings;cores:number;memory:number;resourcesConfirmed?:boolean;name:string;title:string;frequencyConfirmed:boolean;output:string;generatedName:string;generatedSignature:string;editorDirty:boolean;touched:(keyof GaussianSettings)[];nameTouched:boolean;titleTouched:boolean};
  function captureGaussianTask():GaussianTaskDraft{return structuredClone({source:structure,settings,files,cores,memory,resourcesConfirmed,name:jobName,title,frequencyConfirmed,output,generatedName,generatedSignature,editorDirty,touched:[...touched.current],nameTouched:nameTouched.current,titleTouched:titleTouched.current});}
  function restoreGaussianTask(draft:GaussianTaskDraft){cancelInputDraftOperations();const change=modelChange(draft.source,structure),changed=change.inventory||change.geometry||change.graph||draft.source?.charge!==structure?.charge||draft.source?.multiplicity!==structure?.multiplicity,rebased=rebaseCachedGaussianSettings(draft.source,structure,draft.settings);setSettings(projectCanonicalGaussianFreezes(structure,rebased,sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]}));setFiles({...draft.files,compatibilityConfirmed:changed?false:draft.files.compatibilityConfirmed});setCores(draft.cores);setMemory(draft.memory);setResourcesConfirmed(draft.resourcesConfirmed===true);setJobName(draft.name);setTitle(draft.title);setFrequencyConfirmed(changed?false:draft.frequencyConfirmed);setOutput(draft.output);setGeneratedName(draft.generatedName);setGeneratedSignature(draft.generatedSignature);setEditorDirty(draft.editorDirty);touched.current=new Set(draft.touched);nameTouched.current=draft.nameTouched;titleTouched.current=draft.titleTouched;setErrors([]);}
  type InputResetEntry=({engine:'gaussian';task:TaskId;value:GaussianTaskDraft}|{engine:'orca';task:OrcaJobRequest['settings']['task'];value:OrcaJobRequest})&{cursor?:symbol;paths?:string[][]};
  const inputResetPast=useRef<InputResetEntry[]>([]),inputResetFuture=useRef<InputResetEntry[]>([]);
  const pendingLocalReset=useRef<InputResetEntry|null>(null);
  function currentResetSnapshot():InputResetEntry{return {...(engineLive.current==='gaussian'?{engine:'gaussian' as const,task:settings.task,value:captureGaussianTask()}:{engine:'orca' as const,task:orcaLive.current.settings.task,value:structuredClone(orcaLive.current)}),cursor:sessionStore.getHistoryCursor?.()};}
  function restoreResetSnapshot(entry:InputResetEntry){if(entry.engine==='gaussian')restoreGaussianTask(structuredClone(entry.value));else{cancelInputDraftOperations();const live=orcaLive.current,next={...structuredClone(entry.value),structure:live.structure,charge:live.charge,multiplicity:live.multiplicity,electronicStateConfirmed:live.electronicStateConfirmed};next.settings=projectCanonicalOrcaFreezes(structure,rebaseCachedOrcaSettings(entry.value.structure,structure,next.settings),sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]});orcaLive.current=next;setOrcaRequest(next);}}
  function matchingReset(entry:InputResetEntry){return entry.engine===engineLive.current&&entry.task===(entry.engine==='gaussian'?settings.task:orcaLive.current.settings.task);}
  function nextReset(kind:'undo'|'redo'){return [...(kind==='undo'?inputResetPast.current:inputResetFuture.current)].reverse().find(matchingReset);}
  function canResetHistory(kind:'undo'|'redo'){const entry=nextReset(kind);return !!entry&&entry.cursor===sessionStore.getHistoryCursor?.();}
  function recordLocalReset(){const entry=currentResetSnapshot();inputResetPast.current.push(entry);pendingLocalReset.current=entry;inputResetFuture.current=inputResetFuture.current.filter(entry=>!matchingReset(entry));}
  useEffect(()=>{const entry=pendingLocalReset.current;if(!entry)return;pendingLocalReset.current=null;const after=currentResetSnapshot();entry.paths=inputResetPaths(entry.value,after.value).filter(path=>!['source','structure','charge','multiplicity','electronicStateConfirmed'].includes(path[0]));if(!entry.paths.length)inputResetPast.current=inputResetPast.current.filter(value=>value!==entry);});
  const inputCanUndo=canResetHistory('undo'),inputCanRedo=canResetHistory('redo');
  useEffect(()=>{workspaceLive.current?.onInputHistoryChange?.();},[inputCanUndo,inputCanRedo]);
  function inputResetHistory(kind:'undo'|'redo'){const from=kind==='undo'?inputResetPast.current:inputResetFuture.current,to=kind==='undo'?inputResetFuture.current:inputResetPast.current,entry=nextReset(kind);if(!entry||!canResetHistory(kind))return false;const current=currentResetSnapshot();to.push({...current,paths:entry.paths});from.splice(from.indexOf(entry),1);const restore={...entry,value:entry.paths?applyInputResetPatch(current.value,entry.value,entry.paths):entry.value} as InputResetEntry;restoreResetSnapshot(restore);notify(kind==='undo'?'已撤销当前卡片或任务恢复默认。':'已重做当前卡片或任务恢复默认。');return true;}
  function resetCurrentTask(){
    recordLocalReset();cancelInputDraftOperations();
    const shared=sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]};
    if(engineLive.current==='gaussian'){const next=projectCanonicalGaussianFreezes(structure,defaultsForTask(settings.task),shared);touched.current.clear();excitedResolution.current.clear();solventDraft.current=null;setSettings(next);setFiles({...defaultFiles(),hessian:settings.task==='ts'||settings.task==='irc'?'calcfc':'none'});setCores(0);setMemory(0);setResourcesConfirmed(false);setFrequencyConfirmed(false);setOutput('');setGeneratedName('');setGeneratedSignature('');setEditorDirty(false);}
    else{const current=orcaLive.current,next={...current,settings:projectCanonicalOrcaFreezes(structure,createOrcaCommonSettings(current.settings.task,structure),shared),assets:[],cores:1,memoryGB:1,resourcesConfirmed:false};orcaLive.current=next;setOrcaRequest(next);setInputResetSerial(value=>value+1);}
    setErrors([]);notify('已恢复当前任务默认；任务名、结构电子态和共有冻结保留。');
  }
  function chooseTask(task: TaskId) {
    if(batchInputSession&&!batchInputTaskAllowed('gaussian',task))return;
    if(zindo&&task!=='td'){notify('ZINDO/S仅用于当前垂直激发能任务；请先在计算设置中切回TDDFT或TDA，再选择其它任务。','error');return;}
    if(task===settings.task){setStep(2);return;}
    gaussianTaskDrafts.current.set(settings.task,captureGaussianTask());
    const saved=gaussianTaskDrafts.current.get(task);
    if(saved){restoreGaussianTask(structuredClone(saved));setStep(2);setImportTarget(task);return;}
    touched.current.clear();excitedResolution.current.clear();nameTouched.current=!!batchInputSession;titleTouched.current=false;solventDraft.current=null;
    const next=projectCanonicalGaussianFreezes(structure,defaultsForTask(task),sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]});
    const taskFiles={...defaultFiles(),hessian:(task==='ts'||task==='irc'?'calcfc':'none') as FileSettings['hessian']};
    setSettings(next);setFiles(taskFiles);setCores(0);setMemory(0);setResourcesConfirmed(false);setFrequencyConfirmed(false);setOutput('');setGeneratedName('');setGeneratedSignature('');setEditorDirty(false);setErrors([]);
    setJobName(batchInputSession?orcaImportSystemStem(sourceName):taskStem(sourceName,task,next.method,next.xtb?.level,next));setTitle(defaultTitle(sourceName,task,next.method,next));setStep(2);
    setImportTarget(task);
    if(task==='irc')notify('IRC须与实际过渡态保持相同的方法、基组、色散、溶剂、电子态及数值条件；可在导入面板拖入TS的GJF、OUT或FCHK。');
  }

  function chooseMethod(method: MethodId) {
    ['method', 'dispersion', 'grid'].forEach(key => touched.current.add(key as keyof GaussianSettings));
    setSettings(previous => ({ ...changedConditions(previous,['method']), ...methodDefaults(method, previous.task),inheritedRoute:{...previous.inheritedRoute,sourceId:undefined,methodKeyword:undefined},inheritanceIssues:previous.inheritanceIssues?.filter(issue=>issue.field!=='method') }));
    if(!nameTouched.current)setJobName(taskStem(sourceName,settings.task,method,settings.xtb?.level,{...settings,method}));
    if(!titleTouched.current)setTitle(defaultTitle(sourceName,settings.task,method,{...settings,method}));
    setFrequencyConfirmed(false);
    setFiles(previous => isXtb(method)?{...previous,saveCheckpoint:false,readCheckpoint:false,oldCheckpoint:'',geometry:'explicit',guessRead:false,hessian:'none',basisFromCheckpoint:false,writeCores:false,compatibilityConfirmed:false}:{ ...previous,saveCheckpoint:external?true:previous.saveCheckpoint, guessRead: isSemiempirical(method) ? false : previous.guessRead, compatibilityConfirmed: false });
    if(isXtb(method)){if(files.geometry!=='explicit')setStateConfirmed(false);notify('已切换xTB挂接：清除不适用的CHK/几何读取及Gaussian溶剂；线程沿原接口，未修改脚本。');}
  }

  function restoreDefaults() {
    recordLocalReset();
    const defaults=defaultsForTask(settings.task);
    const inherited={...settings.inheritedRoute};delete inherited.basisTail;delete inherited.basisKeyword;delete inherited.integration;delete inherited.sourceId;delete inherited.methodKeyword;
    const restored={...changedConditions(settings,['method','basis']),method:defaults.method,basis:defaults.basis,dispersion:defaults.dispersion,grid:defaults.grid,customMethod:'',inheritedRoute:inherited,inheritanceIssues:settings.inheritanceIssues?.filter(issue=>!['method','basis'].includes(issue.field??''))};
    setSettings(restored);['method','basis','dispersion','grid','customMethod'].forEach(key=>touched.current.delete(key as keyof GaussianSettings));
    setFiles(previous=>({...previous,compatibilityConfirmed:false}));setFrequencyConfirmed(false);setErrors([]);
    notify('已恢复本任务方法/基组及配套色散、积分；其它模块设置保留。');
    if(!nameTouched.current)setJobName(taskStem(sourceName,settings.task,defaults.method,defaults.xtb?.level,restored));
    if(!titleTouched.current)setTitle(defaultTitle(sourceName,settings.task,restored.method,restored));
  }

  function resetSection(section:DefaultSection){
    recordLocalReset();
    const patch=sectionDefaults(settings,files,section,{atomCount:structure?.atoms.length});
    const conditionsChanged=Object.entries(patch.settings).some(([key,value])=>JSON.stringify(settings[key as keyof GaussianSettings])!==JSON.stringify(value))||Object.entries(patch.files).some(([key,value])=>files[key as keyof FileSettings]!==value);
    setSettings(previous=>{const inherited={...previous.inheritedRoute};if(section==='scf')delete inherited.scf;if(section==='integration')delete inherited.integration;return {...changedConditions(previous,['advanced',...Object.keys(patch.settings)]),...patch.settings,parameterDrafts:section==='scf'?{...previous.parameterDrafts,scf:undefined,vshift:undefined,scfMaxCycle:undefined,vshiftEnabled:undefined,scfMaxCycleEnabled:undefined}:section==='integration'?{...previous.parameterDrafts,integration:undefined}:previous.parameterDrafts,inheritedRoute:inherited};});
    setFiles(previous=>({...previous,...patch.files,compatibilityConfirmed:conditionsChanged?false:previous.compatibilityConfirmed}));
    if(section==='scf')touched.current.delete('scf');
    if(section==='integration'){touched.current.delete('grid');touched.current.delete('integral');touched.current.delete('nosymm');}else touched.current.add('advanced');
    setFrequencyConfirmed(false);setErrors([]);notify('已恢复'+({scf:'SCF',opt:'OPT',integration:'积分与对称性'}[section])+'默认，其它模块保留。');
  }
  function updateResources(patch:ResourcePatch){setResourcesConfirmed(false);if(patch.cores!==undefined)setCores(patch.cores);if(patch.memory!==undefined)setMemory(patch.memory);setFiles(previous=>({...previous,...(patch.writeCores!==undefined?{writeCores:patch.writeCores}:{}),...(patch.writeMemory!==undefined?{writeMemory:patch.writeMemory}:{})}));setErrors([]);}
  function updateExcited(patch:Partial<TaskOptions['excited']>){
    Object.keys(patch).forEach(key=>excitedResolution.current.add(key));
    const options=settings.taskOptions??defaultTaskOptions();const excited={...options.excited,...patch};
    const updated={...settings,inheritanceIssues:excitedResolution.current.has('root')&&excitedResolution.current.has('targetSpin')?settings.inheritanceIssues?.filter(issue=>issue.code!=='mixed-spin-opt-target'):settings.inheritanceIssues,taskOptions:{...options,excited,irc:{...options.irc,confirmed:false},stable:{...options.stable,confirmed:false},fragmentStatesConfirmed:false},advanced:{...(settings.advanced??defaultAdvanced(settings.task)),...(patch.frequency!==undefined?{optConvergence:defaultAdvanced(settings.task,excited.frequency).optConvergence}:{})}};
    setSettings(updated);touched.current.add('taskOptions');setFiles(previous=>({...previous,compatibilityConfirmed:false,...(excitedFrequencyOnly(updated)?{hessian:'none' as const}:{})}));setFrequencyConfirmed(false);setErrors([]);
    if(!nameTouched.current)setJobName(taskStem(sourceName,updated.task,updated.method,updated.xtb?.level,updated));
    if(!titleTouched.current)setTitle(defaultTitle(sourceName,updated.task,updated.method,updated));
  }
  function resetTaskParameters(){
    recordLocalReset();
    const options=settings.taskOptions??defaultTaskOptions(),defaults=defaultTaskOptions();
    const task=settings.task,optimization=isOptimizationTask(task)&&!excitedFrequencyOnly(settings);
    const optPatch=optimization?sectionDefaults(settings,files,'opt',{atomCount:structure?.atoms.length}):{settings:{},files:{}};
    const patch:Partial<TaskOptions>={...(task==='freq'||task==='optfreq'||task==='ts'||isExcitedOptimization(settings)?{frequency:defaults.frequency}:{}),...(task==='td'||isExcitedOptimization(settings)?{excited:defaults.excited}:{}),...(task==='irc'?{irc:defaults.irc}:task==='nmr'?{nmr:defaults.nmr}:task==='stable'?{stable:defaults.stable}:{})};
    setSettings(previous=>({...changedConditions(previous,['advanced','taskOptions']),...optPatch.settings,taskOptions:{...options,...patch}}));
    setFiles(previous=>({...previous,...optPatch.files,...(task==='irc'?{hessian:'calcfc' as const,recalcInterval:null}:{}),compatibilityConfirmed:false}));setFrequencyConfirmed(false);setErrors([]);
    notify('已恢复本任务核心参数默认；方法、扫描成员、共有冻结和片段定义保留。');
  }

  function updateFile<K extends keyof FileSettings>(key: K, value: FileSettings[K], discardDraft=false) {
    if(key==='geometry'&&value!==files.geometry&&builderDirty&&!discardDraft){setModal({title:'建模草稿尚未应用',text:'切换几何来源会放弃当前建模草稿，已提交结构保留。',action:()=>{setBuilderDirty(false);updateFile(key,value,true);},label:'放弃草稿并切换'});return;}
    if (key === 'geometry') setStateConfirmed(false);
    if (key === 'geometry' || key === 'hessian' || key === 'oldCheckpoint') setFrequencyConfirmed(false);
    setFiles(previous => {
      const next = { ...previous, [key]: value };
      if (!['saveCheckpoint', 'checkpointName', 'writeMemory', 'writeCores', 'compatibilityConfirmed'].includes(key)) next.compatibilityConfirmed = false;
      if (key === 'geometry') {
        if (value !== 'explicit') {
          next.readCheckpoint = true;
        }
      }
      if (key === 'hessian' && value === 'readfc' && settings.task === 'freq') next.guessRead = false;
      if (key === 'hessian' && ['readfc','rcfc'].includes(String(value))) next.readCheckpoint=true;
      if (key === 'readCheckpoint' && !value) { next.guessRead = false; next.basisFromCheckpoint=false;if(['readfc','rcfc'].includes(next.hessian)) next.hessian = 'none'; }
      return next;
    });
    setErrors([]);
  }

  function exportGuard(target:'gaussian'|'orca'){
    exportLifetime.current.generation++;
    return createInputExportGuard<WorkspaceInputTaskStamp>(()=>{
      const document=sessionStore.getSnapshot(),workspace=workspaceLive.current;
      const base=target==='gaussian'?latestGaussian.current.request:orcaEffectiveLive.current;
      const req=workspace?{...base,inputSources:workspace.getCurrentSources()}:base;
      return {...exportLifetime.current,runtimeOwner:runtimeController.current,runtimeSessionId:runtimeController.current?.getSnapshot().sessionId,active:(workspace?.inputActive??true)&&engineLive.current===target,documentId:document.id,revision:document.revision,structure:desktopMode?document.draft.structure:req.structure,
        conditions:inputExportConditions(target,req,document.sharedConstraints,target==='gaussian'&&latestGaussian.current.editorDirty?latestGaussian.current.output:null),
        activationStamp:workspace?.inputStamp,assertIdentityCurrent:workspace?.assertInputIdentityCurrent};
    });
  }
  function captureRuntimeSnapshot(){const controller=runtimeController.current;return controller?.getSnapshot().mode==='md'?controller.captureSnapshot():controller?.pauseAndSnapshot();}
  async function pausedGaussianRequest():Promise<GuardedInputRequest<JobRequest>> {
    return capturePausedGaussianRequest({createGuard:()=>exportGuard('gaussian'),readRequest:()=>latestGaussian.current.request,readSettings:()=>formalModel.current.settings,readSharedConstraints:()=>sessionStore.getSnapshot().sharedConstraints,pauseAndSnapshot:captureRuntimeSnapshot,layerCapabilityFor,currentSources:()=>workspaceLive.current?.getCurrentSources()});
  }
  async function pausedOrcaRequest(initial:OrcaJobRequest):Promise<GuardedInputRequest<OrcaJobRequest>> {
    return capturePausedOrcaRequest(initial,{createGuard:()=>exportGuard('orca'),readSharedConstraints:()=>sessionStore.getSnapshot().sharedConstraints,pauseAndSnapshot:captureRuntimeSnapshot,layerCapabilityFor,currentSources:()=>workspaceLive.current?.getCurrentSources()});
  }
  const generatingInput=useRef(false);
  const [generationBusy,setGenerationBusy]=useState(false);
  const submittingExternal=useRef(false);
  const [externalSubmitBusy,setExternalSubmitBusy]=useState(false);
  const [externalSubmitError,setExternalSubmitError]=useState<{message:string}|null>(null);
  async function submitExternalInput() {
    const submit=workspaceLive.current?.onSubmitExternalInput;
    if(!submit||batchInputSession||submittingExternal.current||busy||generationBusy||builderDirty)return;
    submittingExternal.current=true;setExternalSubmitBusy(true);setExternalSubmitError(null);
    const generation=exportLifetime.current.generation;
    try {
      const current=latestGaussian.current;
      // Current editor text is the snapshot, even when the form has since changed.
      await submit(gaussianExternalInputDraft(current.output,current.generatedName||current.request.name));
    } catch(cause) {
      if(exportLifetime.current.alive&&exportLifetime.current.generation===generation)setExternalSubmitError({message:cause instanceof Error?cause.message:String(cause)});
    } finally {
      submittingExternal.current=false;if(exportLifetime.current.alive)setExternalSubmitBusy(false);
    }
  }
  async function generate() {
    if(generatingInput.current)return;
    generatingInput.current=true;setGenerationBusy(true);
    try {
    let captured: JobRequest;
    let guard:()=>void;
    try { const prepared = await pausedGaussianRequest();prepared.assertCurrent();captured=prepared.request;guard=prepared.assertCurrent; }
    catch (cause) { setErrors([cause instanceof Error ? cause.message : String(cause)]); return; }
    setErrors([]);const invalid=validateJob(captured);if(inheritanceOpen&&step===3){if(invalid.length){notify(humanizeValidation(invalid[0],captured),'error');return;}}else if(validation.report('full',invalid))return;
    if(batchInputSession){try{await saveBatchInputs({engine:'gaussian',request:captured},guard);}catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);}return;}
    const commitCaptured=(accepted:JobRequest)=>{setOutput(buildGaussian(accepted));setGeneratedName(accepted.name);setGeneratedSignature(jobSignature(accepted));setEditorDirty(false);setErrors([]);validation.reset();setStep(3);notify('已生成完整输入模板，可继续编辑。');};
    const confirmation=gaussianReplacementConfirmation({request:captured,assertCurrent:guard},commitCaptured,message=>setErrors([message]));
    if(latestGaussian.current.editorDirty){setModal(confirmation);return;}
    confirmation.action();
    } finally {generatingInput.current=false;setGenerationBusy(false);}
  }

  async function saveBatchInputs(template:AdvancedInputTemplate,assertCurrent:()=>void){
    if(batchSavingRef.current)throw new Error('本批输入正在保存，请等待当前操作结束。');
    const session=workspaceLive.current?.batchInputSession;
    if(!session)throw new Error('批量输入会话已结束。');
    const bridge=desktopBridge();
    if(!bridge?.chooseAdvancedOutput||!bridge.writeAdvancedOutput||!bridge.abandonAdvancedOutput)throw new Error('批量输入需在桌面程序中选择输出目录。');
    const plan=prepareBatchInputPlan(session,template,sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]});
    if(!plan.ready)throw new Error(plan.errors.join('\n'));
    let selectedToken:string|undefined,savedSuccessfully=false;
    batchSavingRef.current=true;
    try{
      assertCurrent();
      const result=await bridge.chooseAdvancedOutput({mode:'existing-directory',files:plan.files,reservedNames:plan.manifest.frames.flatMap(frame=>frame.runtimeOutputNames??[])});
      if(result.status==='cancelled')return;
      selectedToken=result.token;
      assertCurrent();
      if(workspaceLive.current?.batchInputSession?.id!==session.id)throw new Error('批量输入会话已变化，未写入文件。');
      assertAdvancedOutputManifest(plan,result.manifest);
      const saved=await bridge.writeAdvancedOutput(result.token);selectedToken=undefined;
      if(saved.status!=='saved')throw new Error([saved.error.message,...advancedOutputPartialLines(saved.error.advancedOutput)].join('\n'));
      assertAdvancedOutputManifest(plan,saved.manifest);
      for(const file of plan.files)if(template.engine==='gaussian'?/\.gjf$/i.test(file.name):/\.inp$/i.test(file.name))workspaceSurface?.onPreparedInput({engine:template.engine,name:file.name,text:file.text,outcome:'saved'});
      savedSuccessfully=true;
    }finally{
      try{if(selectedToken)await bridge.abandonAdvancedOutput(selectedToken);}
      finally{batchSavingRef.current=false;}
    }
    if(savedSuccessfully)workspaceLive.current?.onFinishBatchInput?.(session.id);
  }

  function inheritImportedSource(){
    const anchor=importedStructure.current,source=anchor?.gaussianSource,current=formalModel.current;
    if(!source||!anchor||!current.structure)return;
    try {
      cancelTaskSelection();
      const mapped=remapSourceLevelToCurrent(source,anchor,current.structure);
      const inherited=inheritGaussianSourceLevel(mapped,current.settings,{basisIdentityMapped:true});
      if(!inherited.applied){setErrors(inherited.issues.map(issue=>issue.message));notify('来源计算级别不能完整应用，请核对提示。','error');return;}
      const next=changedConditions(inherited.settings,['method','basis','dispersion','solvent']);
      if(desktopMode){
        sessionStore.synchronizeGaussianBasisState?.(captureGaussianBasisState(current.settings),captureDesktopAssignments(current.structure,current.settings).basis);
        if(JSON.stringify(captureGaussianBasisState(current.settings))!==JSON.stringify(captureGaussianBasisState(next)))
          sessionStore.execute({type:'set-gaussian-basis-state',state:captureGaussianBasisState(next),assignments:captureDesktopAssignments(current.structure,next).basis});
      }
      formalModel.current={...formalModel.current,settings:next};setSettings(next);
      for(const key of ['method','basis','dispersion','solvent','solventModel'] as const)touched.current.add(key);
      setFrequencyConfirmed(false);setFiles(previous=>({...previous,compatibilityConfirmed:false}));
      setInheritanceOpen(false);setErrors([]);validation.reset();
      notify('已继承方法、基组、色散和溶剂；任务、资源、冻结、扫描、层与片段仍按当前配置。');
    } catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);}
  }
  function inheritOrcaLevel(){
    const source=importedStructure.current?.orcaSource;if(!source)return;
    cancelTaskSelection();
    const inherited=inheritOrcaSourceLevel(source,orcaLive.current.settings);
    if(!inherited.applied){setErrors(inherited.issues.map(issue=>issue.message));notify('来源计算级别不能由当前ORCA预设准确表达。','error');return;}
    const next={...orcaLive.current,settings:inherited.settings};
    orcaLive.current=next;setOrcaRequest(next);setErrors([]);
    notify('已继承方法、基组、色散和溶剂；任务、资源、冻结、扫描、层与片段仍按当前配置。');
  }
  function updateMixedBasis(value:GaussianSettings['mixedBasis']){
    if(desktopMode&&committingCapture.current?.intent.purpose==='basis'){
      const live=formalModel.current,next={...live.settings,mixedBasis:value};
      sessionStore.synchronizeGaussianBasisState?.(captureGaussianBasisState(live.settings),captureDesktopAssignments(live.structure,live.settings).basis);
      sessionStore.execute({type:'set-gaussian-basis-state',state:captureGaussianBasisState(next),assignments:captureDesktopAssignments(live.structure,next).basis});
    }
    update('mixedBasis',value);
  }

  function acknowledgeSourceIssue(issue:SourceIssue){setSettings(previous=>{const inherited={...previous.inheritedRoute};if(issue.field==='route')inherited.extra=inherited.extra?.filter(token=>!issue.message.endsWith(token)&&token!==(issue as SourceIssue&{raw?:string}).raw);if(issue.field==='solvent')delete inherited.solvent;return {...previous,inheritedRoute:inherited,inheritanceIssues:previous.inheritanceIssues?.filter(item=>item!==issue)};});}

  function proceed() {
    setErrors([]);
    if (step === 0) { void chooseSoftware('gaussian'); return; }
    if (step === 1) { setStep(2); return; }
    if(files.geometry!=='allcheck'&&stateError){validation.report('start',[stateError]);return;}
    void generate();
  }

  function useCurrentText(action: () => void, text = output, textStale = stale) {
    if (!text.trim()) { setErrors(['输入文本为空，无法导出。']); return; }
    if (textStale) setModal({ title: '表单与当前文本尚未同步', text: '你修改了结构或表单，但没有重新生成。继续将导出现有编辑器文本，而不是上方的新设置。', action, label: '使用当前编辑文本' });
    else action();
  }

  async function exportText() {
    try {
      const currentText=latestGaussian.current;
      if(!currentText.output.trim()){setErrors(['输入文本为空，请先生成或填写输入。']);return null;}
      const generation=exportLifetime.current.generation,lease=workspaceLive.current?.inputStamp();
      const assertCurrent=()=>{if(!exportLifetime.current.alive||exportLifetime.current.generation!==generation||engineLive.current!=='gaussian'||latestGaussian.current.output!==currentText.output)throw new Error('输入任务或文本已变化，请重新操作。');if(lease)workspaceLive.current?.assertInputIdentityCurrent(lease);};
      assertCurrent();
      return {text:currentText.output,name:currentText.generatedName||currentText.request.name,stale:jobSignature(currentText.request)!==currentText.generatedSignature,assertCurrent};
    } catch (cause) { setErrors([cause instanceof Error ? cause.message : String(cause)]); return null; }
  }
  async function download() {
    if(batchInputSession){await generate();return;}
    const captured = await exportText(); if (!captured) return;
    try{captured.assertCurrent();}catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);return;}
    useCurrentText(() => {
      try{captured.assertCurrent();}catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);return;}
      const blob = new Blob([captured.text.replace(/\r\n?/g, '\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `${captured.name || 'gaussian_input'}.gjf`; link.click();
      workspaceSurface?.onPreparedInput({engine:'gaussian',name:link.download,text:captured.text,outcome:'requested'});
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); notify('已按当前编辑文本请求下载 GJF。');
    }, captured.text, captured.stale);
  }

  async function copy() {
    const captured = await exportText(); if (!captured) return;
    try{captured.assertCurrent();}catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);return;}
    useCurrentText(() => {try{captured.assertCurrent();}catch(cause){setErrors([cause instanceof Error?cause.message:String(cause)]);return;}copyPlainText(captured.text).then(() => {captured.assertCurrent();workspaceSurface?.onPreparedInput({engine:'gaussian',name:`${captured.name||'gaussian_input'}.gjf`,text:captured.text,outcome:'copied'});notify('输入文件已复制。');}).catch(cause => {try{captured.assertCurrent();}catch{return;}setErrors([cause instanceof Error?cause.message:'剪贴板不可用，请在编辑器全选复制，或直接下载GJF。']);}); }, captured.text, captured.stale);
  }

  const previewResult=gaussianLayerError||sharedGaussian.errors.length?{text:'',errors:[...(gaussianLayerError?[gaussianLayerError]:[]),...sharedGaussian.errors]}:previewGaussian(request);
  const previewText=humanizeValidation(previewResult.text,request);
  const preview=foldCoordinates&&files.geometry==='explicit'?foldPreviewCoordinates(previewText,structure?.atoms.length??0):previewText;
  const progress = Math.round((step + 1) / 4 * 100);

  function chooseSystemName(value:string){systemNameTouched.current=true;setSourceName(value);if(!nameTouched.current)setJobName(taskStem(value,settings.task,settings.method,settings.xtb?.level,settings));if(!titleTouched.current)setTitle(defaultTitle(value,settings.task,settings.method,settings));}
  async function switchEngine(value: 'gaussian' | 'orca') {
    if(structure?.cell){setErrors(['周期结构暂不支持生成 Gaussian / ORCA 输入。']);return false;}
    const epoch=++engineSwitchGeneration.current,lease=workspaceLive.current?.inputStamp();
    // A navigation attempt invalidates pending exports, but its own ORCA
    // initialization may legitimately change export conditions while pausing.
    exportLifetime.current.generation++;
    validation.reset();
    cancelTaskSelection();
    try { await captureRuntimeSnapshot();
      if(!exportLifetime.current.alive||epoch!==engineSwitchGeneration.current)return false;
      if(workspaceLive.current?.inputActive===false)throw new Error('输入任务已变化，请重新选择计算软件。');
      if(lease)workspaceLive.current?.assertInputIdentityCurrent(lease);
      setEngine(value);engineLive.current=value;return true;
    }
    catch (cause) { if(epoch===engineSwitchGeneration.current)setErrors([cause instanceof Error ? cause.message : String(cause)]);return false; }
  }
  function openOrca(){if(builderDirty)return;if(!orcaInitialized.current){setOrcaRequest(previous=>({...previous,structure,charge,multiplicity,electronicStateConfirmed:stateConfirmed,systemName:orcaImportSystemStem(sourceName),name:orcaImportSystemStem(sourceName)+(batchInputSession?'':'-optdft-freq')}));orcaInitialized.current=true;}void switchEngine('orca');}
  async function chooseSoftware(value:'gaussian'|'orca'){
    if(builderDirty||orcaDirty)return;
    if(value==='orca'&&!orcaInitialized.current){setOrcaRequest(previous=>({...previous,structure,charge,multiplicity,electronicStateConfirmed:stateConfirmed,systemName:orcaImportSystemStem(sourceName),name:orcaImportSystemStem(sourceName)+(batchInputSession?'':'-optdft-freq')}));orcaInitialized.current=true;}
    if(await switchEngine(value)){if(value==='gaussian')setStep(1);else setOrcaStep(1);}
  }
  function changeOrca(next:OrcaJobRequest){
    const previous=orcaLive.current;
    if(next.settings.task!==previous.settings.task){
      orcaTaskDrafts.current.set(previous.settings.task,structuredClone(previous));orcaTaskNaming.current.set(previous.settings.task,{...orcaNamingPolicy.current});
      const saved=orcaTaskDrafts.current.get(next.settings.task);
      next=saved?{...structuredClone(saved),settings:rebaseCachedOrcaSettings(saved.structure,previous.structure,saved.settings),structure:previous.structure,charge:previous.charge,multiplicity:previous.multiplicity,electronicStateConfirmed:previous.electronicStateConfirmed}:{...next,settings:createOrcaCommonSettings(next.settings.task,structure),assets:[],cores:1,memoryGB:1,resourcesConfirmed:false};
      orcaNamingPolicy.current={...(orcaTaskNaming.current.get(next.settings.task)??{systemNameTouched:false,outputNameTouched:!!batchInputSession,titleTouched:false})};
      if(!saved){next.name=batchInputSession?orcaImportSystemStem(sourceName):orcaTaskStem(next.systemName??orcaImportSystemStem(sourceName),next.settings);next.title=defaultTitle(sourceName,next.settings.task as TaskId,settings.method);}
      next.settings=projectCanonicalOrcaFreezes(structure,next.settings,sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]});
    }
    const change=modelChange(structure,next.structure);
    const imported=next.structure!==previous.structure&&!!next.structure&&(change.inventory||change.geometry||change.graph);
    if(!imported&&(next.charge!==previous.charge||next.multiplicity!==previous.multiplicity||next.electronicStateConfirmed&&!previous.electronicStateConfirmed)&&!acceptBaseElectronicEdit(next.charge,next.multiplicity))return;
    if(desktopMode&&!imported){
      const submitted={...next.settings,freezeEnabled:true,inheritModelFreeze:undefined};
      const before=orcaFreezeDefinitions(previous.structure,previous.settings),definitions=orcaFreezeDefinitions(next.structure,submitted);
      if(next.settings.task===previous.settings.task&&freezeDefinitionSignature(before)!==freezeDefinitionSignature(definitions)){
        // An edited explicit target must remain valid; an invalid number is not
        // permission to remove the old canonical definition silently.
        for(const row of (submitted.task==='md'?submitted.md.constraints:submitted.constraints))if(row.action==='freeze'&&row.value!==undefined&&(!Number.isFinite(row.value)||row.type==='B'&&row.value<=0||row.type==='A'&&(row.value<=0||row.value>=180)))throw new Error('冻结内坐标目标值无效，请核对数值和单位。');
        try{orcaLive.current={...next,settings:submitted};setOrcaRequest(orcaLive.current);commitInputFreezes(definitions);next=orcaLive.current;}
        catch(cause){orcaLive.current=previous;setOrcaRequest(previous);setErrors([cause instanceof Error?cause.message:String(cause)]);throw cause;}
      }else next={...next,settings:projectCanonicalOrcaFreezes(next.structure,submitted,sessionStore.getSnapshot().sharedConstraints??{frozenAtomIds:[],coordinates:[]})};
    }
    if(next.multiplicity!==multiplicity)spinLocked.current=true;
    if(next.charge!==charge||next.multiplicity!==multiplicity){
      invalidateElectronicConditions();setFrequencyConfirmed(false);setFiles(previous=>({...previous,compatibilityConfirmed:false}));
    }
    orcaInitialized.current=true;orcaLive.current=next;setOrcaRequest(next);
    if(next.structure!==orcaRequest.structure && next.structure && (change.inventory||change.geometry||change.graph)){
      runtimeController.current?.beforeExternalEdit('ORCA导入新的共享模型');
      const shared={...next.structure!,charge:next.charge,multiplicity:next.multiplicity};
      projectedStructure.current=shared;setWorkingStructure(shared);formalModel.current={...formalModel.current,structure:shared,charge:next.charge,multiplicity:next.multiplicity,stateConfirmed:next.electronicStateConfirmed};
      sessionStore.synchronizeContext(captureOrcaAssignments(next.structure,next.settings),captureOrcaCoordinates(next.structure,next.settings),'orca');
      sessionStore.execute({type:'replace-structure',structure:shared,assignments:captureOrcaAssignments(next.structure,next.settings)});
    }
    setCharge(next.charge);setMultiplicity(next.multiplicity);setStateConfirmed(next.electronicStateConfirmed);
  }
  function gaussianReferenceControls(){
    return <div data-input-section="reference-options"><InputSettingsReferenceRow><InputSettingsCheckbox ariaLabel="Gaussian非限制性参考" checked={!!settings.unrestricted||isUksOptimization(settings)} disabled={external||semi||zindo||reuseFrequency||settings.method==='custom'||isUksOptimization(settings)} onChange={value=>update('unrestricted',value)} label="非限制性参考（UKS）"/>{!external&&!semi&&!zindo&&!reuseFrequency&&<InputSettingsCheckbox ariaLabel="主动开启5D" checked={!!settings.use5D} onChange={update5D} label="写入 5D"/>}</InputSettingsReferenceRow></div>;
  }
  function setModelFreezesEnabled(enabled:boolean){try{cancelTaskSelection();sessionStore.execute({type:'set-shared-freezes-enabled',enabled});setErrors([]);}catch(cause){setErrors(cause instanceof ScientificEditCancelledError?[]:[cause instanceof Error?cause.message:String(cause)]);}}
  function resetElectronicState(){
    const initial=workspaceLive.current?.entry.initialElectronicState??initialBaseElectronicState(importedStructure.current);
    try{
      if(desktopMode){sessionStore.execute({type:'set-electronic-state',...initial,confirmed:false});runtimeController.current?.beforeExternalEdit('恢复来源基础电子态');}
      setCharge(initial.charge);setMultiplicity(initial.multiplicity);setStateConfirmed(false);spinLocked.current=true;
      const next={...orcaLive.current,...initial,electronicStateConfirmed:false};orcaLive.current=next;setOrcaRequest(next);
      invalidateElectronicConditions();setFrequencyConfirmed(false);setFiles(previous=>({...previous,compatibilityConfirmed:false}));setErrors([]);
    }catch(cause){setErrors(cause instanceof ScientificEditCancelledError?[]:[cause instanceof Error?cause.message:String(cause)]);}
  }
  function gaussianFreezeControls(){return <GaussianFreezeControls internalCoordinatesDisabled={!!batchInputSession} freezeEnabled={sharedConstraints?.enabled!==false} onFreezeEnabledChange={setModelFreezesEnabled} sharedFreezeCounts={sharedFreezeCounts} settings={settings} files={files} structure={structure} selected={atomSelection} onChange={updateTaskOptions} onPick={pickAtoms} onRequestSelection={desktopMode?requestTaskSelection:undefined}/>;}
  function baseStateControls() {
    return <>
      <BaseElectronicStateFields onReset={resetElectronicState} disabled={files.geometry==='explicit'&&!structure?.atoms.length} charge={charge} multiplicity={multiplicity} confirmed={stateConfirmed} error={stateError} chargeLabel="总电荷" multiplicityLabel="自旋多重度" onChargeChange={value=>updateBaseState({charge:value})} onMultiplicityChange={value=>updateBaseState({multiplicity:value})} confirmationLabel="确认Gaussian基础电子态" onConfirm={()=>{if(!acceptBaseElectronicEdit(charge,multiplicity))return;setStateConfirmed(true);spinLocked.current=true;}}/>
    </>;
  }
  function newInput(){
    if(workspaceLive.current){workspaceLive.current.onNewInputTask();return;}
    if(engine==='orca'){orcaNavigation.current?.(0);notify('已开始新的输入，当前结构和参数仍保留。');return;}
    const action=()=>{setOutput('');setEditorDirty(false);setStep(0);setErrors([]);notify('已开始新的输入，当前结构仍保留。');};
    if(output)setModal({title:'开始新的输入',text:'当前编辑器文本将清空，结构和参数会保留。请先下载需要保留的文件。',action,label:'开始新的输入'});else action();
  }
  function cancelInputDraftOperations(){exportLifetime.current.generation++;engineSwitchGeneration.current++;importSequence.current++;cancelTaskSelection();setModal(null);}
  function resetInputDraft(){
    setOrcaGeneratedDrafts({});
    solventDraft.current=null;gaussianTaskDrafts.current.clear();orcaTaskDrafts.current.clear();orcaTaskNaming.current.clear();inputResetPast.current=[];inputResetFuture.current=[];
    cancelInputDraftOperations();const document=sessionStore.getSnapshot(),source=formalInputStructure(document.draft.structure),shared=document.sharedConstraints??{frozenAtomIds:[],coordinates:[]};
    touched.current.clear();excitedResolution.current.clear();spinLocked.current=false;nameTouched.current=!!batchInputSession;titleTouched.current=false;systemNameTouched.current=false;inputDraftTouched.current=false;initialDraftSignatures.current={};
    const gaussian=projectCanonicalGaussianFreezes(source,defaultSettings('optfreq'),shared),orca=projectCanonicalOrcaFreezes(source,createOrcaCommonSettings('optfreq'),shared);
    setSettings(gaussian);setFiles(defaultFiles());setStep(0);setOrcaStep(0);setEngine('gaussian');engineLive.current='gaussian';orcaInitialized.current=false;initialInput.current=undefined;
    setCharge(source?.charge??0);setMultiplicity(source?.multiplicity??1);setStateConfirmed(document.electronicStateConfirmed===true);setFrequencyConfirmed(false);setCores(0);setMemory(0);setResourcesConfirmed(false);
    const name=source?.name??'molecule';setSourceName(name);setJobName(batchInputSession?orcaImportSystemStem(name):taskStem(name,'optfreq',gaussian.method));setTitle(defaultTitle(name,'optfreq',gaussian.method));
    const nextOrca:OrcaJobRequest={structure:source,settings:orca,charge:source?.charge??0,multiplicity:source?.multiplicity??1,electronicStateConfirmed:document.electronicStateConfirmed===true,name:orcaImportSystemStem(name)+(batchInputSession?'':'-optdft-freq'),title:'Molecule - optimization and frequencies',cores:1,memoryGB:1,resourcesConfirmed:false,assets:[]};
    setOrcaRequest(nextOrca);setOrcaEffectiveRequest(nextOrca);orcaEffectiveLive.current=nextOrca;orcaNamingPolicy.current={systemNameTouched:false,outputNameTouched:!!batchInputSession,titleTouched:false};
    setOutput('');setGeneratedName('');setGeneratedSignature('');setEditorDirty(false);setOrcaDirty(false);setErrors([]);setNotice(null);setPickerRequest(null);setInheritanceOpen(false);setSourcePanelDismissed(false);validation.reset();setInputResetSerial(value=>value+1);
  }
  const getAdvancedInputTemplate=()=>snapshotAdvancedInputTemplate({hasInputTask:Boolean(workspaceLive.current?.inputTaskId),engine:engineLive.current,gaussian:latestGaussian.current.request,orca:orcaEffectiveLive.current});
  const inputController=useRef({history:inputResetHistory,canUndo:()=>canResetHistory('undo'),canRedo:()=>canResetHistory('redo'),reset:resetInputDraft,cancel:cancelInputDraftOperations,isBusy:()=>busy||batchSavingRef.current,getAdvancedInputTemplate});
  inputController.current={history:inputResetHistory,canUndo:()=>canResetHistory('undo'),canRedo:()=>canResetHistory('redo'),reset:resetInputDraft,cancel:cancelInputDraftOperations,isBusy:()=>busy||batchSavingRef.current,getAdvancedInputTemplate};
  useEffect(()=>{const publish=workspaceLive.current?.onInputController;if(!publish)return;publish({history:kind=>inputController.current.history(kind),canUndo:()=>inputController.current.canUndo(),canRedo:()=>inputController.current.canRedo(),reset:()=>inputController.current.reset(),cancel:()=>inputController.current.cancel(),isBusy:()=>inputController.current.isBusy(),getAdvancedInputTemplate:()=>inputController.current.getAdvancedInputTemplate()});return()=>publish(null);},[workspaceSurface?.onInputController]);
  const atSoftwareChoice=(engine==='orca'?orcaStep:step)===0;
  const workflowFooter=<>{desktopMode&&!atSoftwareChoice&&<EngineInputPreview engine="gaussian" gaussianRequest={step===3?undefined:request} capabilityError={step===3?undefined:gaussianLayerError} text={step===3?output:previewText} atomCount={files.geometry==='explicit'?structure?.atoms.length??0:0} issues={step===3?[]:previewResult.errors.map(issue=>humanizeValidation(issue,request))} foldCoordinates={foldCoordinates} onFoldCoordinates={setFoldCoordinates} manualText={editorDirty}/>}
{!atSoftwareChoice&&<WorkflowNavigation engine="gaussian" step={step} busy={generationBusy} onBack={()=>{validation.reset();setStep(previous=>Math.max(0,previous-1));setErrors([]);}} onNext={proceed} onGenerate={()=>void generate()}/>} </>;
  const gaussianDisplayStep=atSoftwareChoice?0:step;
  const sharedFreezeCounts={atoms:sharedConstraints?.frozenAtomIds.length??0,coordinates:sharedConstraints?.coordinates.length??0};
  function inputSurface(content:ReactNode,key:string){
    if(!workspaceSurface)return content;
    return workspaceSurface.inputHost?createPortal(content,workspaceSurface.inputHost,key):null;
  }
  function overlaySurface(content:ReactNode){
    if(!workspaceSurface)return content;
    return workspaceSurface.active||workspaceSurface.inputActive?createPortal(content,document.body):null;
  }
  const sharedWorkspacePresentation=projectWorkspacePresentation(desktopMode,workspaceSurface);
  if(!desktopMode&&engine==='orca')return <OrcaWorkbench onExitMultiscale={exitOrcaMultiscale} namingPolicy={orcaNamingPolicy.current} onNamingPolicyChange={acceptOrcaNamingPolicy} request={orcaRequest} onChange={changeOrca} onGaussian={()=>{if(!orcaDirty)void switchEngine('gaussian');}} onDirtyChange={setOrcaDirty} onEffectiveRequest={acceptOrcaEffectiveRequest}/>;

  return <div ref={applicationRoot} className={'app-shell builder-version'+(desktopMode?' desktop-mode':'')} data-font-size={fontSize} style={{'--form-width':formWidth+'%'} as CSSProperties} onChangeCapture={()=>{inputDraftTouched.current=true;}} onClickCapture={event=>{if(event.target instanceof Element&&event.target.closest('.form-card,.stepper,.software-tabs'))inputDraftTouched.current=true;}}>
    <input ref={fileInput} id="structure-upload" aria-label="导入结构文件" hidden type="file" multiple onChange={event=>{const list=Array.from(event.target.files??[]);if(list.length)void importFiles(list);event.target.value='';}}/>
    {!desktopMode&&<aside className="sidebar">
      <a className="brand" href="#" onClick={event => event.preventDefault()} aria-label="Ester Studio 本地工具"><span className="brand-mark"><span className="brand-initials" aria-hidden="true">ES</span></span><span><strong>Ester Studio<span className="brand-dot">.</span></strong><small>科学计算工具</small></span></a>
      <div className="sidebar-group-label">WORKSPACE</div>
      <nav className="side-navigation"><div className="nav-item selected"><FileCode2 size={18} /><span>输入文件生成器</span><ChevronRight size={14} /></div><div className="nav-item unavailable"><AtomIcon size={18} /><span>结构工具</span><span className="soon-tag">规划中</span></div><div className="nav-item unavailable"><BookOpen size={18} /><span>知识库</span><span className="soon-tag">规划中</span></div></nav>
      <div className="sidebar-divider" /><div className="sidebar-group-label">LOCAL WORKSPACE</div>
      <div className="preview-note"><span className="preview-note-dot" /><div><strong>Gaussian · 本地输入准备</strong><p>先把输入准备这件事做好。</p></div></div>
      <div className="sidebar-bottom"><div className="private-note"><ShieldCheck size={18} /><strong>结构在本机处理</strong><p>通过导出文件保留模型和输入。</p></div><button className="sidebar-help" onClick={() => setHelp(true)}><CircleHelp size={16} />使用说明与支持范围<ChevronRight size={13} /></button><div className="sidebar-version">INPUT STUDIO <span>{applicationVersion.label}</span></div></div>
    </aside>}

    <div className="main-shell">
      {inputSurface(<WorkflowHeader engine={engine} disabled={builderDirty||!!structure?.cell} onEngine={value=>{if(value==='orca')openOrca();else void switchEngine('gaussian');}}>{!desktopMode&&<FontSizeControl value={fontSize} onChange={setFontSize}/>}<span className="local-status"><span />本地处理</span><button className="icon-button" aria-label="使用说明" onClick={() => setHelp(true)}><CircleHelp size={18} /></button><span className="avatar">S</span></WorkflowHeader>,'workflow-header')}
      <main className="workspace">
        <div className="page-heading"><div><div className="eyebrow"><span />QUANTUM INPUT STUDIO</div><h1>输入工作台<span className="beta-label">{desktopMode?'桌面建模':'本地输入'}</span></h1><p>从分子结构到计算输入，把准备工作变得简单一点。</p></div><button className="button button-white new-input" onClick={newInput}><Plus size={16} />新建输入</button></div>





        {inputSurface((desktopMode||engine==='gaussian')&&<WorkflowSteps step={engine==='orca'?orcaStep:step} onStep={index=>{if(engine==='orca'){orcaNavigation.current?.(index);return;}validation.reset();setErrors([]);if(index===1||index===2){setStep(index);return;}if(index===3&&!output)void generate();else setStep(index);}}/>,'workflow-steps')}

        <WorkbenchShell desktop={desktopMode} onToolHost={setToolHost} externalToolHost={workspaceSurface?.sharedLayout}>
          {inputSurface(<>
          {desktopMode&&<div className="shared-orca-form" hidden={engine!=='orca'||atSoftwareChoice} style={engine!=='orca'||atSoftwareChoice?{display:'none'}:undefined}><OrcaWorkbench active={engine==='orca'&&(workspaceSurface?.inputActive??true)} generatedDraft={orcaGeneratedDrafts[workspaceOrcaRequest.settings.task]} onGeneratedDraftChange={acceptOrcaGeneratedDraft} onSubmitExternalInput={workspaceSurface?.onSubmitExternalInput} onPreparedInput={workspaceSurface?.onPreparedInput} onResetElectronicState={resetElectronicState} onBeforeLocalReset={recordLocalReset} onGenerateBatch={batchInputSession?(request,guard)=>saveBatchInputs({engine:'orca',request},guard):undefined} onFreezeEnabledChange={setModelFreezesEnabled} key={inputResetSerial} onExitMultiscale={exitOrcaMultiscale} namingPolicy={orcaNamingPolicy.current} onNamingPolicyChange={acceptOrcaNamingPolicy} embedded onInheritLevel={inheritOrcaLevel} canInheritLevel={!!importedStructure.current?.orcaSource} onResetTask={resetCurrentTask} sharedConstraints={sharedConstraints} sourceCandidates={workspaceSurface?.sources} onRequestSourcePick={workspaceSurface?.onRequestSourcePick} onImportSources={workspaceSurface?.onImportSources} request={workspaceOrcaRequest} capabilityError={orcaLayerError} inputLayerEditor={engine==='orca'?layerEditor():null} onRequestSelection={requestTaskSelection} workflowStep={orcaStep} onWorkflowStep={setOrcaStep} onNavigationReady={acceptOrcaNavigation} inputPreview={<EngineInputPreview engine="orca" capabilityError={orcaStep===3?undefined:orcaLayerError||sharedOrca.errors.join('\n')||null} orcaRequest={orcaStep===3?undefined:orcaEffectiveRequest} snapshotFiles={orcaStep===3?orcaGeneratedDrafts[workspaceOrcaRequest.settings.task]?.files:undefined} minimumVersionLabel={orcaStep===3&&!orcaGeneratedDrafts[workspaceOrcaRequest.settings.task]?.editedNames.length?(orcaGeneratedDrafts[workspaceOrcaRequest.settings.task]?.minimumVersion==='5'?'5.0.3+':orcaGeneratedDrafts[workspaceOrcaRequest.settings.task]?.minimumVersion?'≥'+orcaGeneratedDrafts[workspaceOrcaRequest.settings.task]?.minimumVersion:undefined):undefined} atomCount={structure?.atoms.length??0} foldCoordinates={foldCoordinates} onFoldCoordinates={setFoldCoordinates}/>} selected={atomSelection} onSelectionChange={setAtomSelection} onChange={changeOrca} onGaussian={()=>void switchEngine('gaussian')} onDirtyChange={setOrcaDirty} onEffectiveRequest={acceptOrcaEffectiveRequest} beforeExport={pausedOrcaRequest}/></div>}
          <WorkflowContentCard hidden={engine!=='gaussian'&&!atSoftwareChoice} style={engine!=='gaussian'&&!atSoftwareChoice?{display:'none'}:undefined} className={!atSoftwareChoice && step === 3 ? 'editor-card' : ''} title={STEP_NAMES[gaussianDisplayStep]} step={gaussianDisplayStep} footer={workflowFooter}>
            {errors.length > 0 && <DismissibleNotice className="error-box" identity={errors}><Info size={16} /><div>{errors.map((error, i) => <p key={i}>{error}</p>)}</div></DismissibleNotice>}

            {atSoftwareChoice&&structure?.cell&&<p role="status">周期结构暂不支持 Gaussian / ORCA 输入。</p>}
            {atSoftwareChoice && <SoftwareChooser disabled={builderDirty||orcaDirty||!!structure?.cell} onChoose={value=>void chooseSoftware(value)}/>}

            {!atSoftwareChoice && step === 1 && <div className="step-content task-step engine-step-content"><InputSettingsLayout><InputTaskPicker groups={TASK_GROUPS} value={settings.task} onChange={chooseTask} tasks={TASKS.map(task=>{const Icon=TASK_ICONS[task.id as keyof typeof TASK_ICONS]??FlaskConical;return {id:task.id,group:task.group,label:task.name,code:external&&task.id==='ts'?'TS · 最终Freq验收':task.code,icon:<Icon size={22} strokeWidth={1.6}/>,disabled:external&&!XTB_TASKS.includes(task.id)||!!batchInputSession&&!batchInputTaskAllowed('gaussian',task.id),title:zindo&&task.id!=='td'?'请先切回TDDFT/TDA再选择其它任务':undefined};})}/></InputSettingsLayout></div>}

            {!atSoftwareChoice && step === 2 && <div className="step-content settings-step engine-step-content"><InputSettingsLayout className="input-parameter-settings">
              <InputSettingsRow className="input-task-name-row"><InputSettingsField label="任务名"><input aria-label="任务名" value={jobName} onChange={event=>{nameTouched.current=true;setJobName(event.target.value);}}/></InputSettingsField><button type="button" className="button button-primary" style={{width:104,height:36,flex:'0 0 104px'}} onClick={resetCurrentTask}>恢复默认</button></InputSettingsRow>
              {baseStateControls()}
              <MethodChooser settings={settings} files={files} structure={structure} onRecommend={restoreDefaults} onMethod={chooseMethod} onBasis={basis=>chooseBasis({type:'basis',basis})} onMixedBasis={enabled=>chooseBasis({type:'mixed',enabled})} onInherit={inheritImportedSource} inheritDisabled={!importedStructure.current?.gaussianSource}>
                <MixedBasisOptions gaussianSettings={settings} structure={structure} globalBasis={settings.basis} value={settings.mixedBasis} selected={atomSelection} fragments={settings.task==='bsse'?settings.taskOptions?.fragments:undefined} disabledReason={external||semi||zindo?'本方法不使用轨道基组':files.geometry!=='explicit'||files.basisFromCheckpoint||reuseFrequency?'需要显式坐标和新的轨道基组分配':undefined} onChange={updateMixedBasis} onPick={pickAtoms} onRequestSelection={desktopMode?requestTaskSelection:undefined}/>
                {settings.method==='custom'&&<InputSettingsField label="Gaussian 方法关键词"><input aria-label="自定义方法关键词" value={settings.customMethod} onChange={event=>update('customMethod',event.target.value)} placeholder="例如 b3lyp；需自行核对支持范围"/></InputSettingsField>}
                {external&&<XtbOptions settings={settings.xtb} onChange={value=>update('xtb',value)}/>}
                {gaussianPausedNotice()}
                {gaussianReferenceControls()}
              </MethodChooser>
              <TaskParameters updateSettings={update} sharedFreezeCounts={sharedFreezeCounts} qstRequest={request} sourceCandidates={workspaceSurface?.sources} onRequestSourcePick={workspaceSurface?.onRequestSourcePick} onImportSources={workspaceSurface?.onImportSources} qstReactantSource={workspaceSurface?.sources.find(source=>source.documentId===workspaceSurface.entry.id)} onQstChange={qst=>update('qst',qst)} settings={settings} files={files} structure={structure} selected={atomSelection} multiplicity={effectiveMultiplicity} onChange={updateTaskOptions} updateFile={updateFile} onPick={pickAtoms} onRequestSelection={desktopMode?requestTaskSelection:undefined} onExcitedChange={updateExcited} onResetTask={resetTaskParameters}>
                {(isExcitedOptimization(settings)||settings.task==='irc'||settings.task==='freq'||reuseFrequency)&&<>
                  {settings.task==='irc'&&<p className="muted-note">请使用实际过渡态结构，在上方明确继承或核对相同计算级别；冻结请在冻结区域单独采用。</p>}
                  {reuseFrequency&&<div className="frequency-note"><Info size={16}/><div><strong>复用来源CHK中的频率力常数</strong><p>不按上面的方法/基组重新计算Hessian；方法、基组及原计算条件以来源CHK为准。本任务不进行新的SCF，不能用它改变计算级别。</p></div></div>}
                </>}
              </TaskParameters>
              {gaussianFreezeControls()}
              {!external&&<div data-input-section="solvent"><SolventControls onReset={()=>{recordLocalReset();solventDraft.current=null;const defaults=defaultsForTask(settings.task);setSettings(previous=>({...previous,solvent:defaults.solvent,solventModel:defaults.solventModel,solvation:defaults.solvation,solventModelManuallySelected:false}));setFrequencyConfirmed(false);setFiles(previous=>({...previous,compatibilityConfirmed:false}));}} draftMemory={solventDraft} task={settings.task} modelManuallySelected={settings.solventModelManuallySelected} engine="gaussian" model={settings.solventModel} solvent={settings.solvent} selection={settings.solvation} requireRefractiveIndex={settings.task==='td'||settings.task==='tdopt'} disabled={reuseFrequency} onChange={updateSolvent} onModelChange={(model,origin)=>updateSolventModel(model as GaussianSettings['solventModel'],origin)}/></div>}
              <div data-input-section="advanced"><AdvancedOptions settings={settings} files={files} update={update} updateFile={updateFile} onResetSection={resetSection}/></div>
              <InputSettingsSection sectionKey="naming-resources" title="计算资源" status={resourcesConfirmed?'confirmed':'pending'} actions={<InputSettingsAction reset ariaLabel="恢复计算资源默认" onClick={()=>{recordLocalReset();setCores(0);setMemory(0);setResourcesConfirmed(false);setFiles(previous=>({...previous,writeCores:false,writeMemory:false}));}}>恢复计算资源默认</InputSettingsAction>}>
                <ResourceControls files={files} external={external} cores={cores} memory={memory} confirmed={resourcesConfirmed} onConfirm={()=>setResourcesConfirmed(true)} onChange={updateResources}/>
              </InputSettingsSection>
              <div data-input-section="source">{external?<p className="muted-note">Gaussian固定%nprocshared=1；xTB实际线程以原脚本为准。挂接输入不写CHK/oldchk，也不formchk。</p>:<SourceOptions onReset={()=>{recordLocalReset();const defaults=defaultFiles();setFiles({...defaults,writeCores:files.writeCores,writeMemory:files.writeMemory});setFrequencyConfirmed(false);}} batchMode={!!batchInputSession} files={files} update={updateFile} task={settings.task} name={jobName} semi={semi} frequencyOnly={excitedFrequencyOnly(settings)}/>}</div>
            </InputSettingsLayout></div>}

            {!atSoftwareChoice && step === 3 && <div className="step-content engine-output-step"><GeneratedInputEditor engine="gaussian" files={[{name:`${generatedName||jobName}.gjf`,text:output,role:'input'}]} edited={editorDirty} stale={stale} busy={generationBusy} readOnly={!!batchInputSession} onEdit={text=>{setOutput(text);setEditorDirty(true);}} onCopy={()=>void copy()} onDownload={()=>void download()} onSubmit={workspaceSurface?.onSubmitExternalInput?()=>void submitExternalInput():undefined} submitDisabled={!output.trim()||!!batchInputSession||busy||builderDirty} submitTitle={batchInputSession?'批量输入请导出后逐文件提交。':undefined} submitting={externalSubmitBusy}>
              {external&&xtbNeedsFrequency(settings,files,structure?.atoms.length)&&<div className="frequency-note xtb-followup"><Info size={15}/><p>本次TS尚需独立频率：完成后导入实际最后完整帧，再按相同接口级别生成Freq；不得把当前初猜当作优化末帧。</p></div>}
              {externalSubmitError&&<DismissibleNotice className="error-box" identity={externalSubmitError}>{externalSubmitError.message}</DismissibleNotice>}
            </GeneratedInputEditor></div>}

          </WorkflowContentCard>

          </>,'input-parameters')}
          {desktopMode&&!workspaceSurface?.sharedLayout&&<div className="workspace-divider" role="separator" aria-label="调整参数区宽度" aria-orientation="vertical" aria-valuemin={WORKBENCH_PANE_LIMITS.leftWidth.min} aria-valuemax={WORKBENCH_PANE_LIMITS.leftWidth.max} aria-valuenow={formWidth} tabIndex={0}
            onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);}}
            onPointerMove={event=>{if(!event.currentTarget.hasPointerCapture(event.pointerId))return;const bounds=event.currentTarget.parentElement!.getBoundingClientRect();setFormWidth(clampWorkbenchPaneSize('leftWidth',(event.clientX-bounds.left)/bounds.width*100));}}
            onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
            onPointerCancel={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
            onDoubleClick={()=>setFormWidth(27)} onKeyDown={event=>{if(event.key==='Home'){event.preventDefault();setFormWidth(27);}else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setFormWidth(value=>clampWorkbenchPaneSize('leftWidth',value+(event.key==='ArrowLeft'?-1:1)));}}}/>}

          <aside className="preview-column" data-summary-open={summaryOpen}>
            <section className={'work-card preview-card sticky-structure-card '+(mobilePreview?'mobile-preview-open':'')}>
              {!desktopMode&&<div className="preview-card-heading"><h2><AtomIcon size={16}/>{files.geometry==='explicit'?'结构预览':'参考结构预览'}</h2>
                <button className="mobile-preview-toggle text-button" onClick={()=>setMobilePreview(value=>!value)}>{mobilePreview?'收起模型':'查看模型'}</button>
                {!desktopMode&&<label className="workspace-width-control">参数区<input aria-label="参数区宽度" type="range" min="25" max="50" step="1" value={formWidth} onChange={event=>setFormWidth(Number(event.target.value))}/></label>}
                <button className="text-button" aria-expanded={summaryOpen} onClick={()=>{const open=!summaryOpen;setSummaryOpen(open);requestAnimationFrame(()=>{const card=document.querySelector<HTMLElement>(open?`[data-engine-summary="${engine}"]`:'.sticky-structure-card');card?.scrollIntoView({block:'start',behavior:'smooth'});if(open)card?.focus({preventScroll:true});});}}>输入预览</button>
              </div>}
              {!desktopMode&&structure&&<StructureSummary structure={structure} reference={files.geometry!=='explicit'}/>}
              <div className="structure-visual-content">
                {(desktopMode||files.geometry==='explicit')?
                  <Workspace {...sharedWorkspacePresentation} {...(desktopMode?{store:sessionStore,realtime:true,toolHost:workspaceSurface?.sharedLayout?workspaceSurface.toolHost:toolHost,sharedLayout:workspaceSurface?.sharedLayout,toolbarHost:workspaceSurface?.toolbarHost,documentName:workspaceSurface?.entry.label,onSavedName:workspaceSurface?.onSavedName,onActivate:workspaceSurface?.onActivate,onViewportState:workspaceSurface?.onViewportState,initialCameraView:workspaceSurface?.initialCameraView,initialViewTransform:workspaceSurface?.initialViewTransform,onViewportController:workspaceSurface?.onViewportController,viewportDockTarget:workspaceSurface?.viewportDockTarget,displaySettings:workspaceSurface?.displaySettings,onDisplaySettingsChange:workspaceSurface?.onDisplaySettingsChange,onOpenSettings:workspaceSurface?.onOpenSettings,sharedShowAxes:workspaceSurface?.sharedShowAxes,onSharedShowAxesChange:workspaceSurface?.onSharedShowAxesChange,toolIntent:workspaceSurface?.toolIntent,workspaceModule:workspaceSurface?.module,onToolIntentChange:workspaceSurface?.onToolIntentChange,viewportActive:workspaceSurface?.viewportActive,legendVisible:workspaceSurface?.legendVisible,layoutActions:workspaceSurface?.layoutActions,inputFreezeDisplay:workspaceSurface?.module==='modeling'?undefined:engine==='gaussian'?gaussianInputFreezeDisplay(structure,settings,sharedConstraints):orcaInputFreezeDisplay(structure,orcaRequest.settings,sharedConstraints),jobRequest:engine==='gaussian'?privateRequest:undefined,orcaJobRequest:engine==='orca'?privateOrcaModelRequest:undefined,captureRequest,onCaptureRebase:rebaseTaskSelection,onCaptureConfirm:confirmTaskSelection,onCapturePreview:previewTaskSelection,onCaptureCancel:cancelTaskSelection,onDynamicsController:acceptRuntimeController,active:workspaceSurface?.active??true,activationStamp:workspaceSurface?.stamp,assertActivation:workspaceSurface?.assertCurrent,assertActivationIdentity:workspaceSurface?.assertIdentityCurrent,assertRuntimeCurrent:workspaceSurface?.assertRuntimeCurrent,onNewDocument:workspaceSurface?.onNewDocument,onImportFiles:workspaceSurface?.onImportFiles,onImportTwoDFiles:workspaceSurface?.onImportTwoDFiles,onOpenTwoD:workspaceSurface?.onOpenTwoD,twoDActive:workspaceSurface?.twoDActive}:{})} structure={structure} assignments={engine==='orca'?{...captureOrcaAssignments(structure,orcaRequest.settings),layers:layersFor('orca')}:builderAssignments} selected={atomSelection} highlights={engine==='gaussian'?highlights:undefined} openRequest={builderOpenRequest}
                    {...(desktopMode?{freezeEditingAllowed:workspaceSurface?.freezeEditingAllowed,onOpenStructureLibrary:workspaceSurface?.onOpenStructureLibrary,samplingSphereDraft:workspaceSurface?.samplingSphereDraft,onSamplingSphereRadiusChange:workspaceSurface?.onSamplingSphereRadiusChange,onDisplayProjection:workspaceSurface?.onDisplayProjection,onCipLabelsUsed:workspaceSurface?.onCipLabelsUsed,onLeftToolSurfaceChange:workspaceSurface?.onLeftToolSurfaceChange,advancedModelingRoute:workspaceSurface?.advancedModelingRoute,onAdvancedModelingRouteChange:workspaceSurface?.onAdvancedModelingRouteChange,onAdvancedModelingBack:workspaceSurface?.onAdvancedModelingBack,onDeriveStructure:workspaceSurface?.onDeriveStructure,onWorkspaceHistory:workspaceSurface?.onWorkspaceHistory,workspaceCanUndo:workspaceSurface?.workspaceCanUndo,workspaceCanRedo:workspaceSurface?.workspaceCanRedo,...(workspaceSurface?.module==='advanced'&&workspaceSurface.entry.conformerGroup?.role!=='initial'||workspaceSurface?.entry.trajectory&&workspaceSurface?.analysisCanvas?{observationOnly:true}: {})}:{})}
                    derivedSupercellSource={workspaceSurface?.entry.derivation?.operation==='supercell'?workspaceSurface.entry.derivation.sourceStructure:undefined}
                    onSelectIds={ids=>{const live=formalModel.current.structure,wanted=new Set(ids);setAtomSelection(live?live.atoms.flatMap((atom,index)=>wanted.has(atom.id!)?[index]:[]):[]);}}
                    onApply={applyBuilderModel} onDraftChange={setBuilderDirty} onExtract={()=>guardedStructureChange(extractModel)} onCopied={notify}/>
                  :structure?<MoleculeViewer atoms={structure.atoms} bonds={structure.bonds} cell={structure.cell} regions={regions} highlights={highlights} selected={atomSelection}
                    onSelect={undefined}/>
                  :<div className="empty-structure"><strong>几何将从来源 CHK 读取</strong><p>选择显式坐标可进入建模工作区。</p></div>}
              </div>
              {!desktopMode&&<div className="molecule-meta"><span><span className="meta-dot teal"/>{files.geometry==='explicit'?'坐标单位 Å':'CHK几何未验证'}</span><span><span className={'meta-dot '+(stateConfirmed&&files.geometry!=='allcheck'?'teal':'amber')}/>{files.geometry==='allcheck'?'电子态继承CHK':stateConfirmed?'电子态已确认':'电子态待确认'}</span></div>}
            </section>
            {!desktopMode&&<>
            <section className="work-card summary-card" data-engine-summary="gaussian" tabIndex={-1} hidden={engine==='orca'} style={engine==='orca'?{display:'none'}:undefined}><div className="preview-card-heading"><h2><FlaskConical size={15} />当前计算方案</h2><span className="recommend-tag">可修改</span></div><dl><div><dt>计算任务</dt><dd>{external&&settings.task==='ts'&&xtbNeedsFrequency(settings,files,structure?.atoms.length)?'TS · 末帧另补Freq':isExcitedOptimization(settings)?excitedTarget(settings)+' '+(isUksOptimization(settings)?'UKS':'TD/TDA')+(excitedFrequencyOnly(settings)?' 仅频率':excitedOptimizationFrequency(settings)?' 优化＋频率':' 优化'):currentTask.name}</dd></div><div><dt>计算方法</dt><dd>{reuseFrequency ? '继承来源CHK' : zindo ? 'ZINDO/S' : isUksOptimization(settings)?currentMethod.label+' · UKS' : settings.method === 'custom' ? settings.customMethod || '待填写' : currentMethod.label}</dd></div><div><dt>基组 / 级别</dt><dd>{reuseFrequency ? '继承力常数 · 不重算' : external?(settings.xtb??defaultXtb()).level:zindo||semi ? '内置半经验参数' : settings.mixedBasis?.enabled?'混合基组 · '+settings.mixedBasis.dForm:settings.basis}</dd></div><div><dt>电荷 / 多重度</dt><dd className={stateError ? 'invalid-text' : ''}>{files.geometry === 'allcheck' ? '继承CHK · 未验证' : <>{charge} / {effectiveMultiplicity}{!effectiveStateConfirmed && <span className="pending-tag">待确认</span>}</>}</dd></div><div><dt>环境</dt><dd>{reuseFrequency ? '来源计算条件' : external?'沿接口脚本（见计算级别）':settings.solvent ? `${settings.solventModel.toUpperCase()} · ${settings.solvent}` : '气相'}</dd></div><div><dt>计算资源</dt><dd>{external?'Gaussian 1核；xTB沿脚本':files.writeCores ? cores ? `${cores} 核` : '核数待填' : '核数不预设'} · {files.writeMemory ? memory ? `${memory} GB` : '内存待填' : '内存不预设'}</dd></div></dl><div className="summary-file-options"><span>{external?'无CHK挂接':files.saveCheckpoint ? '保存CHK' : '不命名CHK'}</span><span>{files.geometry === 'explicit' ? '显式坐标' : files.geometry === 'check' ? 'Geom=Check' : 'Geom=AllCheck'}</span>{files.guessRead && <span>Guess=Read</span>}{files.hessian !== 'none' && <span>{files.hessian.toUpperCase()}</span>}</div><div className="route-preview-label"><Code2 size={12} />完整输入预览<span className="preview-validation-badge">{previewResult.errors.length?'待校验':'与生成输入一致'}</span></div>{files.geometry==='explicit'&&!!structure&&<label className="check-line preview-controls"><input aria-label="折叠预览坐标" type="checkbox" checked={foldCoordinates} onChange={event=>setFoldCoordinates(event.target.checked)}/><span>折叠坐标（不影响复制或下载）</span></label>}<code className="route-preview full-input-preview" aria-label="完整Gaussian输入预览">{preview}</code>{stale && <div className="summary-stale">表单与已有编辑文本未同步，请以导出文本为准。</div>}</section>
            <OrcaInputSummary request={orcaEffectiveRequest} hidden={engine!=='orca'}/>
            </>}
            {(structure?.notes ?? []).length > 0 && <div className="structure-notes"><Info size={13} /><div>{(structure?.notes ?? []).map((note, index) => <p key={index}>{note}</p>)}</div></div>}
            <div className="completion-note"><div className="completion-track"><span style={{ width: `${progress}%` }} /></div><span>准备进度</span><strong>{progress}%</strong></div>
          </aside>
        </WorkbenchShell>
        <footer className="page-footer"><span>Ester Studio · 科学计算，从清晰的输入开始。</span><span><Monitor size={12} />本地输入准备 · 不运行量化计算 · 未部署云端</span></footer>
      </main>
    </div>
    {overlaySurface(<>{notice&&<NoticeToast key={notice.id} notice={notice} onClose={()=>setNotice(null)}/>}{validation.hint}
    {pickerRequest&&structure&&<AtomPickerModal structure={structure} request={pickerRequest} onClose={()=>setPickerRequest(null)}/>}
    {(modal || help) && <DialogShell className="modal" backdropClassName="modal-backdrop" aria-labelledby="modal-title" onCancel={()=>{setModal(null);setHelp(false);}}>
      <button className="modal-close icon-button" aria-label="关闭对话框" onClick={() => { setModal(null); setHelp(false); }}><X size={18} /></button>
      {modal ? <><span className="modal-symbol"><Info size={25} /></span><h2 id="modal-title">{modal.title}</h2><p>{modal.text}</p><div className="modal-buttons"><button className="button button-white" onClick={() => setModal(null)}>取消</button><button className="button button-primary" onClick={() => { const action = modal.action; setModal(null); action(); }}>{modal.label}</button></div></> : <>
        <span className="modal-symbol"><Leaf size={26} /></span><h2 id="modal-title">统一建模与输入准备</h2>
        <p>Gaussian分四组、12类任务，保留来源继承、混合基组、冻结和扫描。{desktopMode?'三维工作区支持直接编辑、临时二维绘图、复制模型与文件保存。':'统一二维/三维草稿支持原子、键、片段、B/A/D及局部变换。'}点击“应用结构”提交到当前计算任务。</p>
        <p>局部整理只移动选中或刚编辑的原子；全分子整理与重建三维需主动操作。二维排版、旋转观察和“按二维图定向”不改变实际坐标。</p>
        <p>周期读取支持CIF、POSCAR、CP2K INP/restart及配套坐标/包含文件、PDB CRYST1、MOL2 CRYSIN、扩展XYZ晶胞。周期体系允许选区几何编辑与含盒/无盒导出，不执行周期力场或全体系三维重建。未知晶胞、空间群设置和条件宏会报告，不制造盒子或缺失数据。</p>
        <p>结构在本机处理。{desktopMode?'Ctrl+C/V复制和粘贴模型副本，Ctrl+Z/Y撤销和重做，Ctrl+S选择格式保存。':'通过导出文件保留结构与输入。'}Gaussian输入仍由当前表单生成。</p>
        <button className="button button-primary" onClick={() => setHelp(false)}>知道了<ArrowRight size={15} /></button>
      </>}
    </DialogShell>}</>)}
  </div>;
}
