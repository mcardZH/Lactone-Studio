import NumericInput from '../NumericInput';
import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {useProjectState} from '../../projects/ui-state';
import type { AdvancedController } from "../../modeling/advanced/controller";
import type { AdvancedResultFrame, AdvancedTaskRun,AdvancedSamplingCardState,AdvancedMixedSamplingCard } from "../../modeling/advanced/contracts";
import type { AdvancedFrameSource } from "../../modeling/advanced/frame-source";
import type { ConformerResultCollection } from "../../modeling/conformers/trajectory";
import {
	allocateConformerTorsionPoints,
	conformerTorsionCombinationCount,
	createConformerSnapshot,
	createConformerTorsionPreview,
	discoverConformerTorsionRows,
	inspectManualConformerTorsion,
	planConformerTorsionHierarchy,
	type TorsionAtoms
} from "../../modeling/conformers";
import { NATIVE_CONFORMER_CORE_PROTECTION } from "../../modeling/advanced/sampling-contracts";
import {
	applySamplingSphereRadiusChange,
	createSamplingSphereDraft,
	type SamplingSphereDraft
} from "../../modeling/advanced/sampling-sphere";
import { conformerSamplingSchedule } from "../../modeling/advanced/sampling-progress";
import { molecularFormula } from "../../core/elements";
import { baseElectronicStateError } from "../../core/base-electronic-state";
import BaseElectronicStateFields from "../BaseElectronicStateFields";
import { InputSettingsCard, InputSettingsField, InputSettingsRow } from "../InputSettingsFields";
import {
	InputSettingsAction,
	InputSettingsCheckbox,
	InputSettingsLayout,
	InputSettingsSection
} from "../InputSettingsLayout";
import { WorkflowSessionBar } from "../WorkflowPresentation";
import { confirmSynchronousOperation } from "../confirmation";
import { useAnalysisAtomCapture } from "../results/useAnalysisAtomCapture";

import { trajectoryIndices } from "../../results/contracts";
import {
	activateMultiframeDisplay,
	type MultiframeDisplayPlan
} from "../../modeling/view-multiframe";
import { AdvancedRegionField, AdvancedSamplingControls } from "./AdvancedProcessControls";
import ConformerTorsionControls from "./ConformerTorsionControls";
import ConformerOptimizationStages from "./ConformerOptimizationStages";
import {conformerUpstreamSummary} from '../../modeling/advanced/conformer-cluster-collection';
import ConformerStageResults from "./ConformerStageResults";
import SamplingSphereEditor from "./SamplingSphereEditor";
import { overrideAdvancedTaskSource } from "./capture-source";
import {conformerInitialGeometrySelected,conformerInitialCompatible,conformerInitialHasInformation} from './conformer-initial-state';
import {advancedElectronicConfirmationKey,advancedElectronicDraftState} from './electronic-state-sync';
import {
	createAdvancedDisplay,
	sameDisplaySource,
	type AdvancedDisplayFit
} from "./advanced-display";
import {
	compileMixedDefinition,
	mixedConformerAtomConfigurationIssues,
	compileMixedStages,
	createMixedConformerDraft,
	createMixedSamplingCard,
	createMixedTaskSpec,
	MIXED_SAMPLING_CHOICES,
	restoreMixedConformerDraft,
	type MixedConformerDraft,
	type MixedSamplingCardDraft,
	type MixedSamplingChoice
} from "./mixed-conformer-draft";
import { compileSampling } from "./process-config";
import {protectionStrengthToDisplay} from './protection-units';
import {samplingRemainingLabel} from './sampling-time-estimate';
import {optimizationActionView,conformerPlaybackReference} from './conformer-incremental-presentation';
import {submitConformerSampling,commitConformerElectronicDraft} from './conformer-sampling-action';
import {ConformerSamplingCardProgress,conformerGenerationProgressForCard} from './ConformerSamplingProgress';
import {createConformerPlaybackResolver,projectConformerPlaybackCollection} from './conformer-playback';
import {
	buildConformerResultCollections,
	conformerCollectionRevision,
	conformerTerminalResultCollection,
	refreshConformerSamplingInitial,
	type AdvancedWorkspaceProps
} from "./AdvancedWorkspace";

interface PageCache {
	draft: MixedConformerDraft;
	source?: AdvancedFrameSource;
	taskId?: string;
	sphere?: SamplingSphereDraft | null;
	collectionId?: string;
	fit?: AdvancedDisplayFit;
	displayCoreIds?:string[];playbackReferenceMode?:'raw'|'fixed';
	displayCoreAutomatic?:boolean;
}

const pageCaches = new WeakMap<AdvancedController, Map<string, PageCache>>();
/** Called by the discard owner after controller removal; navigation alone keeps
 * drafts. Project/controller disposal also releases the WeakMap key. */
export function releaseMixedConformerPageCache(controller:AdvancedController,taskId:string):void{
	const cache=pageCaches.get(controller);if(!cache)return;for(const[key,value]of cache)if(value.taskId===taskId||key===taskId)cache.delete(key);
}
export function mixedConformerTaskHasInformation(controller:AdvancedController,taskId:string):boolean {
	return conformerInitialHasInformation(controller.getSnapshot().tasks.find(task=>task.id===taskId));
}
const EMPTY = {
	id: "mixed-empty",
	name: "",
	format: "xyz" as const,
	notes: [],
	atoms: [],
	charge: null,
	multiplicity: null
};
const running = (run?: AdvancedTaskRun) =>
	!!run && ["queued", "running", "stopping"].includes(run.status);
const RUN_LABEL: Record<AdvancedTaskRun["status"], string> = {
	queued: "排队中",
	running: "运行中",
	stopping: "正在终止",
	checkpoint: "已完成",
	completed: "已完成",
	failed: "部分失败",
	stopped: "已终止"
};
const RESOURCES_WAITING = "全局计算资源尚未就绪；配置载入或修复后可开始采样和优化。";
const EMPTY_DISPLAY_CORE:string[]=[];
function usableComputeResources(value:AdvancedWorkspaceProps['computeResources']) {
  return value&&Number.isSafeInteger(value.threads)&&value.threads>0&&Number.isSafeInteger(value.memoryBudgetBytes)&&value.memoryBudgetBytes>0?value:null;
}

/** One page owns one search. Controller snapshots own all scientific runs. */
export default function MixedConformerWorkspace(p: AdvancedWorkspaceProps) {
	const state = useSyncExternalStore(
		p.controller.subscribe,
		p.controller.getSnapshot,
		p.controller.getSnapshot
	);
	const scope = p.contextTaskId ?? p.contextKey ?? "mixed-default";
	const cache = useMemo(() => {
		let pages = pageCaches.get(p.controller);
		if (!pages) {
			pages = new Map();
			pageCaches.set(p.controller, pages);
		}
		return pages;
	}, [p.controller]);
	const initial = useRef<PageCache | undefined>(cache.get(scope));
	const [localTaskId, setLocalTaskId] = useState<string | null>(
		p.contextTaskId ?? initial.current?.taskId ?? null
	);
	const task = state.tasks.find((value) => value.id === (p.contextTaskId ?? localTaskId));
	const [draft, setDraft] = useState<MixedConformerDraft>(
		() =>
			initial.current?.draft ??
			(task ? restoreMixedConformerDraft(task) : createMixedConformerDraft())
	);
	// Controller protection is the already-confirmed transaction receipt. A
	// cached editor draft must never overwrite it on a later render/effect.
	const confirmedCoreIds=task?.mixedSampling?.draft.protectedAtomIds??draft.shared.coreIds;
	const confirmedCoreKey=JSON.stringify(confirmedCoreIds);
	const effectiveDraft=useMemo(()=>JSON.stringify(draft.shared.coreIds)===confirmedCoreKey?draft:{...draft,shared:{...draft.shared,coreIds:[...confirmedCoreIds]}},[draft,confirmedCoreKey]);
	const [fallbackSource, setFallbackSource] = useState<AdvancedFrameSource | null>(
		initial.current?.source ?? null
	);
	const selectedInitial = task?.mixedSampling?.initialGuesses.find(
		(value) => value.id === task.mixedSampling?.selectedInitialGuessId
	);
	const run = task?.runs.at(-1);
	const taskSource = selectedInitial?.source ?? task?.spec.source ?? fallbackSource;
	const [capturing, setCapturing] = useState(false),
		[submitting, setSubmitting] = useState(false),
		[clearing,setClearing]=useState(false),
		[error, setError] = useState(""),
		[adding, setAdding] = useState(false);
	const busy = running(run) || submitting;
	// The selected initial owns scientific input. Observation is used only by
	// an explicit capture or while creating a new search.
	const editingInitial = Boolean(task && p.activeConformerInitial?.taskId===task.id&&p.activeConformerInitial?.initialId===selectedInitial?.id);
	const [initialGeometryCurrent,setInitialGeometryCurrent]=useState(true);
	const [observedInitialSource,setObservedInitialSource]=useState<AdvancedFrameSource|null>(null);
	// The editable initial's current document is the display/input draft. A run
	// and every retained batch keep the controller's immutable captured source.
	const source = !busy&&editingInitial ? p.displayedSource??null : taskSource ?? (!busy ? p.displayedSource : null) ?? null;
	const frameSelected = Boolean(initialGeometryCurrent&&taskSource&&(!editingInitial||conformerInitialGeometrySelected(taskSource,source)));
	const requiresNewSearch=Boolean(conformerInitialHasInformation(task)&&taskSource&&editingInitial&&source&&!conformerInitialCompatible(taskSource,source));
	const [sphere, setSphere] = useState<SamplingSphereDraft | null>(initial.current?.sphere ?? null);
	const [collectionId, setCollectionId] = useState(initial.current?.collectionId ?? "");
	const [fit, setFit] = useState<AdvancedDisplayFit>(initial.current?.fit ?? "proper");
	const [displayCoreIds,setDisplayCoreIds]=useProjectState<string[]|null>('conformer.playback.displayCoreIds',initial.current?.displayCoreIds??null,scope);
	const [displayCoreAutomatic,setDisplayCoreAutomatic]=useProjectState('conformer.playback.automaticCore',initial.current?.displayCoreAutomatic??true,scope);
	const [playbackReferenceMode,setPlaybackReferenceMode]=useProjectState<'raw'|'fixed'|undefined>('conformer.playback.reference',()=>initial.current?.playbackReferenceMode,scope);
	const [range, setRange] = useState({ start: 0, end: 0 }),
		[displayStride, setDisplayStride] = useState(1);
	const [overlay, setOverlay] = useState<{
		collectionId: string;
		plan: MultiframeDisplayPlan;
	} | null>(null);
	const [preview, setPreview] = useState<{ cardId: string; rowId: string } | null>(null),
		[hover, setHover] = useState<{ cardId: string; rowId: string } | null>(null);
	const sourceElectronic=advancedElectronicDraftState(source??taskSource,p.sourceElectronicState,p.displayedSource,p.displayTargetId,busy);
	const [electronic, setElectronic] = useState(sourceElectronic);
	const [confirmedElectronic,setConfirmedElectronic]=useState(task?.mixedSampling?.electronicConfirmation??'');
	const confirmationSource=editingInitial?source:observedInitialSource??taskSource;
	const electronicConfirmationKey=advancedElectronicConfirmationKey(confirmationSource,electronic);
	const electronicConfirmed=frameSelected&&(confirmedElectronic===electronicConfirmationKey||task?.mixedSampling?.electronicConfirmation===electronicConfirmationKey);
	const [clock,setClock]=useState(()=>Date.now());
	useEffect(()=>{if(!p.active||!running(run))return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[p.active,run?.id,run?.status]);
	const resources = usableComputeResources(p.computeResources);
	const root = useRef<HTMLDivElement>(null),
		alive = useRef(true),
		captureEpoch = useRef(0),
		submitLock = useRef(false),
		autoCapture = useRef(false);
	const latest = useRef({ p, draft, source, task, sphere, collectionId, fit,displayCoreIds,playbackReferenceMode,displayCoreAutomatic });
	latest.current = { p, draft, source, task, sphere, collectionId, fit,displayCoreIds,playbackReferenceMode,displayCoreAutomatic };
	useEffect(()=>{if(task)cache.set(scope,{draft,source:source??undefined,taskId:task.id,sphere,collectionId,fit});},[cache,scope,task?.id,draft,source,sphere,collectionId,fit]);
	// Check the unique initial once on activation/source edits, including when
	// returning to a result page. Playback ticks never recapture the initial.
	const initialDisplaySource=editingInitial?source:null;
	useEffect(()=>{if(!p.active||!task||busy||!p.onReadConformerInitialSource)return;
		try{const current=p.onReadConformerInitialSource(task.id);setObservedInitialSource(current);setInitialGeometryCurrent(conformerInitialGeometrySelected(taskSource,current));}
		catch{setObservedInitialSource(null);setInitialGeometryCurrent(false);}
	},[p.active,task?.id,busy,taskSource,initialDisplaySource]);
	useEffect(() => {
		alive.current = true;
		setCapturing(false);
		return () => {
			alive.current = false;
			captureEpoch.current++;
			autoCapture.current = false;
			const own = latest.current;
			if(p.controller.getSnapshot().disposed){pageCaches.delete(p.controller);return;}
			if(own.task&&!p.controller.getSnapshot().tasks.some(task=>task.id===own.task?.id)){releaseMixedConformerPageCache(p.controller,own.task.id);return;}
			cache.set(scope, {
				draft: own.draft,
				source: own.source ?? undefined,
				taskId: own.task?.id,
				sphere: own.sphere,
				collectionId: own.collectionId,
				fit: own.fit,displayCoreIds:own.displayCoreIds??undefined,playbackReferenceMode:own.playbackReferenceMode,displayCoreAutomatic:own.displayCoreAutomatic
			});
		};
	}, [cache, scope]);
	const act = (action: () => unknown | Promise<unknown>) => {
		try {
			void Promise.resolve(action()).catch((cause) => report(cause));
		} catch (cause) {
			report(cause);
		}
	};
	function report(cause: unknown) {
		const message = cause instanceof Error ? cause.message : String(cause);
		if (alive.current) setError(message);
		latest.current.p.onError(message);
	}
	const atomConfigurationIssues=useMemo(()=>source?mixedConformerAtomConfigurationIssues(effectiveDraft,source):{cards:{}},[effectiveDraft,source]);
	const protectedSource = useMemo(
		() => {
			if(!source)return null;
			const ids=effectiveDraft.shared.coreIds.filter(id=>source.structure.atoms.some(atom=>atom.id===id));
			if(baseElectronicStateError(source.structure,{charge:source.structure.charge!,multiplicity:source.structure.multiplicity!}))return {...source,constraints:{...source.constraints,frozenAtomIds:ids}};
			return overrideAdvancedTaskSource(source,{protectionAtomIds:ids});
		},
		[source, effectiveDraft.shared.coreIds]
	);
	const selectionEnabled = !!(
		p.active &&
		source &&
		!busy &&
		sameDisplaySource(p.displayedSource, source)
	);
	const captureOptions = {
		ownerId: "mixed-configuration",
		structure: source?.structure ?? EMPTY,
		documentId: source?.ref.documentId ?? "",
		revision: source?.ref.revision ?? 0,
		sourceId: JSON.stringify(source?.ref ?? ""),
		frameIndex: source?.ref.sourceFrameIndex ?? 0,
		activationEpoch: p.displayTargetId ?? "",
		active: selectionEnabled
	};
	const coordinateCapture = useAnalysisAtomCapture({
			...captureOptions,
			purpose: "advanced-coordinate"
		}),
		regionCapture = useAnalysisAtomCapture({ ...captureOptions, purpose: "advanced-region" });

	async function capture() {
		if (!usableComputeResources(latest.current.p.computeResources) || submitLock.current || busy || capturing) return;
		const request = ++captureEpoch.current;
		setCapturing(true);
		setError("");
		try {
			const existing=latest.current.task;
			let next = existing&&p.onReadConformerInitialSource ? p.onReadConformerInitialSource(existing.id) : await p.onCaptureSource();
			if (!alive.current || captureEpoch.current !== request) return;
			const owned = latest.current.task;
			if (owned&&(!conformerInitialHasInformation(owned)||conformerInitialCompatible(owned.spec.source,next))) {
				p.controller.updateInitialSource(owned.id,next);
				p.controller.clearMixedElectronicConfirmation(owned.id);
				setConfirmedElectronic('');
				setInitialGeometryCurrent(true);
				setFallbackSource(next);
				p.onObserve(next);
			} else {
				// A new search may use a retained result frame. Existing task
				// initial/optimization settings stay in the branch above.
				if(p.onPrepareNewTaskSource){const prepared=await p.onPrepareNewTaskSource(next);if(!prepared)return;if(prepared.ref.documentId===next.ref.documentId&&(!alive.current||captureEpoch.current!==request))return;next=prepared;}
				const baseDraft=owned?createMixedConformerDraft():latest.current.draft;
				const nextDraft = {
					...baseDraft,
					shared: { ...baseDraft.shared, coreIds: [...next.constraints.frozenAtomIds] }
				};
				const currentResources=usableComputeResources(latest.current.p.computeResources);
				if(!currentResources){setFallbackSource(next);setDraft(nextDraft);autoCapture.current=false;return;}
				const id = p.controller.createTask(createMixedTaskSpec(next, nextDraft, currentResources));
				setLocalTaskId(id);
				setFallbackSource(next);
				setDraft(nextDraft);
				cache.set(id, { draft: nextDraft, source: next, taskId: id });
				p.onTaskCreated?.(id, next);
			}
		} finally {
			if (alive.current && captureEpoch.current === request) setCapturing(false);
		}
	}
	useEffect(() => {
		if (resources && p.active && !task && !autoCapture.current && p.displayedSource) {
			autoCapture.current = true;
			act(() => capture());
		}
	}, [p.active, task, source, p.displayedSource,resources?.threads,resources?.memoryBudgetBytes]);
	useEffect(() => {
		if (!source) return;
		if(sourceElectronic.charge!==electronic.charge||sourceElectronic.multiplicity!==electronic.multiplicity)setConfirmedElectronic('');
		setElectronic(sourceElectronic);
	}, [sourceElectronic.charge,sourceElectronic.multiplicity,task?.id]);
	const sphereSource = JSON.stringify([
		selectedInitial?.id,
		source?.ref.documentId,
		source?.ref.revision,
		source?.stamp.coordinatesFingerprint
	]);
	const sphereSourceRef = useRef("");
	const sphereGeometrySource=useRef<AdvancedFrameSource|null>(null);
	useEffect(() => {
		if (!source || sphereSourceRef.current === sphereSource) return;
		const cached = sphereSourceRef.current===''?initial.current?.sphere:undefined;
		const reusable=sphere&&conformerInitialGeometrySelected(sphereGeometrySource.current,source)?{...sphere,sourceDocumentId:source.ref.documentId,sourceRevision:source.ref.revision}:undefined;
		const next = reusable??(
			cached &&
			cached.sourceDocumentId === source.ref.documentId &&
			cached.sourceRevision === source.ref.revision
				? cached
				: createSamplingSphereDraft(
						source.ref.documentId,
						source.ref.revision,
						source.structure.atoms.map((atom) => [atom.x, atom.y, atom.z]),
						draft.shared.spherePaddingAngstrom
					));
		sphereSourceRef.current = sphereSource;
		sphereGeometrySource.current=source;
		setSphere(next);
		setPreview(null);
		setHover(null);
		setOverlay(null);
		setDraft((value) => ({
			...value,
			shared: {
				...value.shared,
				sphere: {
					...value.shared.sphere,
					centerAngstrom: next.centerAngstrom,
					radiusAngstrom: next.radiusAngstrom
				}
			}
		}));
	}, [sphereSource, source]);
	function acceptSphere(next: SamplingSphereDraft) {
		if (
			!source ||
			busy ||
			next.sourceDocumentId !== source.ref.documentId ||
			next.sourceRevision !== source.ref.revision
		)
			return;
		setSphere(next);
		setDraft((value) => ({
			...value,
			shared: {
				...value.shared,
				spherePaddingAngstrom: next.marginAngstrom,
				sphere: {
					...value.shared.sphere,
					centerAngstrom: next.centerAngstrom,
					radiusAngstrom: next.radiusAngstrom
				}
			}
		}));
	}
	useEffect(() => {
		if (p.sphereRadiusChange && sphere && !busy)
			act(() => acceptSphere(applySamplingSphereRadiusChange(sphere, p.sphereRadiusChange!)));
	}, [p.sphereRadiusChange]);
	useEffect(() => {
		p.onSphereDraft?.(
			p.active &&
				draft.shared.sphereEnabled &&
				sameDisplaySource(source, p.displayedSource) &&
				sphere?.previewEnabled
				? sphere
				: undefined
		);
		return () => p.onSphereDraft?.(undefined);
	}, [p.active, p.onSphereDraft, draft.shared.sphereEnabled, sphere, source, p.displayedSource]);
	const definition = useMemo(() => {
		if (!source || !resources) return null;
		try {
			return compileMixedDefinition(effectiveDraft, source, resources);
		} catch {
			return null;
		}
	}, [effectiveDraft, source, resources?.threads, resources?.memoryBudgetBytes]);
	const definitionKey = definition ? JSON.stringify(definition) : "",
		savedDefinition = useRef("");
	useEffect(() => {
		if (
			!task?.mixedSampling ||
			busy ||
			!definition ||
			(task.mixedSampling.draft.deduplicationEnabled!==false)!==(definition.deduplicationEnabled!==false) ||
			(task.mixedSampling.draft.dedupRmsdAngstrom??.01)!==definition.dedupRmsdAngstrom ||
			savedDefinition.current === `${task.id}:${definitionKey}`
		)
			return;
		act(() => {p.controller.configureMixedSampling(task.id, definition);savedDefinition.current = `${task.id}:${definitionKey}`;});
	}, [task?.id, task?.spec.source, busy, definitionKey, p.controller]);
	const resultRevision=conformerCollectionRevision(task);
	const resolvePlayback=useMemo(()=>createConformerPlaybackResolver(task),[resultRevision]);
	const retainedCollections=useRef<ConformerResultCollection[]>([]);
	const collections=useMemo(()=>{const next=buildConformerResultCollections(task,draft.stages,retainedCollections.current);retainedCollections.current=next;return next.map(collection=>projectConformerPlaybackCollection(collection,task));},[resultRevision,draft.stages]);
	const currentCollection =
		collections.find(
			(value) =>
				value.id ===
				(p.activeConformerFrame && p.activeConformerFrame.taskId === task?.id
					? p.activeConformerFrame.collectionId
					: collectionId)
		) ??
		collections.find((value) => value.id === collectionId) ??
		collections[0];
	// Immutable collection identity owns this order. A new optimizer result does
	// not change the sampling collection's ancestry or require sorting it again.
	const currentDisplayFrames=currentCollection?.frames;
	const selectedFrame =
		currentCollection?.frames.find((value) => value.id === p.activeConformerFrame?.frameId) ??
		currentCollection?.frames[0];
	const playbackResolution=selectedFrame?resolvePlayback(selectedFrame):undefined;
	const shownCoreIds=playbackResolution?.coreAtomIds??EMPTY_DISPLAY_CORE;
	const effectivePlaybackReference=conformerPlaybackReference(undefined,playbackResolution,shownCoreIds).mode;
	const displayedPlaybackFrame=Boolean(selectedFrame&&p.activeConformerFrame?.taskId===task?.id&&p.activeConformerFrame?.frameId===selectedFrame.id);
	const displayCoreCapture=useAnalysisAtomCapture({ownerId:'conformer-playback-reference',structure:p.displayedSource?.structure??EMPTY,documentId:p.displayedSource?.ref.documentId??'',revision:p.displayedSource?.ref.revision??0,sourceId:JSON.stringify(p.displayedSource?.ref??''),frameIndex:p.displayedSource?.ref.sourceFrameIndex??0,activationEpoch:p.displayTargetId??'',active:Boolean(p.active&&displayedPlaybackFrame&&p.displayedSource),purpose:'advanced-region'});
	useEffect(()=>{p.onCaptureProjection?.(displayCoreCapture.viewportCapture??coordinateCapture.viewportCapture??regionCapture.viewportCapture);return()=>p.onCaptureProjection?.(undefined);},[p.onCaptureProjection,displayCoreCapture.viewportCapture,coordinateCapture.viewportCapture,regionCapture.viewportCapture]);
	const published = useRef(new Map<string, string>()),
		openCallback = useRef(p.onOpenConformerCollection);
	openCallback.current = p.onOpenConformerCollection;
	useEffect(() => {
		if (!task) return;
		for (const collection of collections) {
			if(collection.playbackAvailable===false)continue;
			const key = collection.frames.map((value) => value.id).join("|");
			if (!collection.frames.length && !published.current.has(collection.id)) continue;
			if (published.current.get(collection.id) === key) continue;
			published.current.set(collection.id, key);
			try{openCallback.current?.(collection, undefined, { activate: false });}catch(cause){report(cause);}
		}
		}, [collections]);
	function openCollection(collection: ConformerResultCollection, frameId?: string, preserveOverlay=false) {
		if(!preserveOverlay)setOverlay(null);
		setCollectionId(collection.id);
		if(collection.playbackAvailable===false){if(frameId){const frame=collection.frames.find(value=>value.id===frameId);if(frame)p.onObserve(frame.source);}return;}
		try{p.onOpenConformerCollection?.(collection, frameId, { activate: true });}catch(cause){report(cause);}
	}
	const observedRun=useRef({id:run?.id,status:run?.status}),terminalToActivate=useRef<string|undefined>(undefined);
	useEffect(()=>{
		const previous=observedRun.current;
		if(run&&previous.id===run.id&&previous.status&&['queued','running','stopping'].includes(previous.status)&&['completed','checkpoint','stopped'].includes(run.status))terminalToActivate.current=run.id;
		observedRun.current={id:run?.id,status:run?.status};
		if(!p.active||terminalToActivate.current!==run?.id)return;
		const collection=conformerTerminalResultCollection(collections,run);
		if(!collection)return;
		terminalToActivate.current=undefined;openCollection(collection);
	},[run?.id,run?.status,collections,p.active]);
	const ownerDocument = () => root.current?.ownerDocument;
	const confirm = (message: string) => confirmSynchronousOperation(message, ownerDocument());
	function beginSampling(mode: "continue" | "append" | "restart") {
		if (submitLock.current || !task?.mixedSampling || busy) return;
		if (!resources) throw Error(RESOURCES_WAITING);
		if (!source || !draft.cards.length) throw Error("请先添加采样方式。");
		if (!electronicConfirmed || baseElectronicStateError(source.structure,electronic)) throw Error("请先确认本次任务的电荷与自旋多重度。");
		if(p.onReadConformerInitialSource&&!conformerInitialGeometrySelected(taskSource,p.onReadConformerInitialSource(task.id)))throw Error('初始结构已修改，请确认电荷与自旋多重度。');
		submitLock.current = true;
		setSubmitting(true);
		setError("");
		try {
			const current=refreshConformerSamplingInitial(p.controller,task,mode,p.onReadConformerInitialSource);
			const initial=current.mixedSampling?.initialGuesses.find(value=>value.id===current.mixedSampling?.selectedInitialGuessId);
			if(!initial)throw Error("请明确选择本次采样使用的初猜。");
			const canonical=initial.source;
			if(canonical.structure.charge!==electronic.charge||canonical.structure.multiplicity!==electronic.multiplicity||baseElectronicStateError(canonical.structure,electronic))throw Error("初始结构的电子态已改变，请确认当前电荷与自旋多重度后再开始。");
			const submittedDraft={...effectiveDraft,shared:{...effectiveDraft.shared,coreIds:[...(current.mixedSampling?.draft.protectedAtomIds??effectiveDraft.shared.coreIds)]}};
			const configuration=compileMixedDefinition(submittedDraft,canonical,resources),stages=compileMixedStages(submittedDraft.stages,resources.threads);
			const submitted=submitConformerSampling({controller:p.controller,task:current,definition:configuration,stages,electronic,mode,confirm});
			if(submitted){setFallbackSource(submitted.source);setOverlay(null);setPreview(null);setDraft(value=>({...value,cards:value.cards.map(card=>({...card,expanded:false}))}));}
		} finally {
			submitLock.current = false;
			setSubmitting(false);
		}
	}
	async function clearSampling() {
		if (!task || busy || !hasSamplingHistory) return;
		if (!confirm("清空本任务全部采样批次及所有下游优化结果？初猜和采样设置保留，不会开始新采样。")) return;
		setOverlay(null);
		setSubmitting(true);setClearing(true);
		try{await p.controller.clearSampling(task.id);setCollectionId('');}finally{setSubmitting(false);setClearing(false);}
	}
	function startOptimization(index?: number, action:'continue'|'restart'='continue') {
		if (!task || busy) return;
		if(!resources)throw Error(RESOURCES_WAITING);
		if(!electronicConfirmed||!source||baseElectronicStateError(source.structure,electronic))throw Error("请先确认本次任务的电荷与自旋多重度。");
		setError("");
		const configurations=compileMixedStages(draft.stages,resources.threads),impact=p.controller.previewStageConfiguration(task.id,configurations);
		if(action==='restart'&&!confirm(`${index===undefined?'全部优化':'第'+(index+1)+'级及其后续优化'}将从固定上游输入重新处理全部候选，不复用旧完成标记。继续？`))return;
		if(action!=='restart'&&impact.requiresConfirmation&&!confirm(`更改优化设置将使本级及更高级的 ${impact.affectedFrameCount} 个已有结果失效，上游采样保留。继续？`))return;
		p.controller.configureStages(task.id,configurations);
		if(index===undefined){if(action==='restart')p.controller.restartAllStages(task.id);else p.controller.runAllStages(task.id);}
		else if(action==='restart')p.controller.restartStage(task.id,draft.stages[index].id);
		else p.controller.continueStage(task.id,draft.stages[index].id);
	}
	function changeStages(stages:typeof draft.stages){
		if(!task||!resources){setDraft(value=>({...value,stages}));return;}
		let configurations;try{configurations=compileMixedStages(stages,resources.threads);}catch{setDraft(value=>({...value,stages}));return;}
		const impact=p.controller.previewStageConfiguration(task.id,configurations);
		if(impact.requiresConfirmation&&!confirm(`更改本级设置将使本级及更高级的 ${impact.affectedFrameCount} 个已有结果失效，上游采样和较低级结果保留。继续？`))return;
		p.controller.configureStages(task.id,configurations);setDraft(value=>({...value,stages}));
	}
	function changeDeduplication(patch:Partial<Pick<MixedConformerDraft,'deduplicationEnabled'|'dedupRmsdAngstrom'>>){
		const next={...draft,...patch},previous=task?.mixedSampling?.draft;
		if(!task||!source||!resources||!previous){setDraft(next);return;}
		const changed=(previous.deduplicationEnabled!==false)!==(next.deduplicationEnabled!==false)||(previous.dedupRmsdAngstrom??.01)!==next.dedupRmsdAngstrom;
		if(!changed)return;
		const configuration=compileMixedDefinition({...next,shared:{...next.shared,coreIds:[...confirmedCoreIds]}},source,resources);
		const downstream=task.conformerWorkflow?.stages.some(stage=>(stage.resultFrameIds?.length??0)+stage.representativeFrameIds.length+stage.promotedFrameIds.length>0);
		if(downstream&&!confirm("修改去重设置将重新整理已有采样，并使下游优化结果失效。继续？")){setDraft(value=>({...value,deduplicationEnabled:previous.deduplicationEnabled!==false,dedupRmsdAngstrom:previous.dedupRmsdAngstrom??.01}));return;}
		p.controller.configureMixedSampling(task.id,configuration);
		setDraft(next);
		if(task.mixedSampling?.currentBatchId)p.controller.reorganizeSampling(task.id);
	}
	function commitElectronic() {
		if (!task || !source || busy) return;
		const captured=p.onReadConformerInitialSource?.(task.id)??source;
		const initialId=selectedInitial?.id;
		if(!initialId)throw Error('请明确选择本次采样使用的初猜。');
		const issue = baseElectronicStateError(captured.structure, electronic);
		if (issue) {
			setError(issue);
			return;
		}
		const previous={charge:task.spec.source.structure.charge!,multiplicity:task.spec.source.structure.multiplicity!};
		const hasResults=collections.some(collection=>collection.frames.length>0)||Boolean(task.mixedSampling?.batches?.some(batch=>batch.cards.some(card=>card.frameIds.length)))||task.runs.some(run=>run.frames.length>0);
		const accepted=commitConformerElectronicDraft(previous,electronic,hasResults,confirm,()=>{
			if(p.onConformerElectronicStateChange)p.onConformerElectronicStateChange(task.id,initialId,captured,{...electronic,confirmed:false});
			else p.onElectronicStateChange?.(captured,{...electronic,confirmed:false});
			const current=p.onReadConformerInitialSource?.(task.id)??captured;
			if(current.ref.documentId!==captured.ref.documentId||current.ref.documentEpoch!==captured.ref.documentEpoch||!conformerInitialGeometrySelected(captured,current))throw Error('初始帧在确认期间已变化，请重新确认。');
			setConfirmedElectronic(p.controller.confirmMixedInitialSource(task.id,current,electronic));
			setInitialGeometryCurrent(true);setObservedInitialSource(current);setFallbackSource(current);
		});
		if(!accepted)setElectronic(previous);
	}
	function changeElectronic(patch:Partial<typeof electronic>) {
		const next={...electronic,...patch};
		setConfirmedElectronic('');setElectronic(next);
	}
	function updateCard(id: string, patch: Partial<MixedSamplingCardDraft>) {
		setDraft((value) => ({
			...value,
			cards: value.cards.map((card) => (card.id === id ? { ...card, ...patch } : card))
		}));
	}
	function addCard(kind: MixedSamplingChoice) {
		setDraft((value) => ({
			...value,
			cards: [...value.cards, createMixedSamplingCard(kind, protectedSource)]
		}));
		setAdding(false);
	}
	function moveCard(index: number, delta: number) {
		setDraft((value) => {
			const cards = [...value.cards];
			const next = index + delta;
			if (next < 0 || next >= cards.length) return value;
			[cards[index], cards[next]] = [cards[next], cards[index]];
			return { ...value, cards };
		});
	}
	async function changeCore(ids: string[]) {
		const before=new Set(confirmedCoreIds),next=new Set(ids);
		if(before.size===next.size&&[...before].every(id=>next.has(id)))return;
		if(!confirm("更改保护原子将清空本任务全部采样及各级优化结果，并应用新的保护集合。继续？"))return;
		if(task){if(!p.onCommitConformerCoreChange)throw Error("保护集合更新入口暂不可用。");if(!await p.onCommitConformerCoreChange(task.id,[...next]))return;}
		else if(source)p.onProtectionChange?.(source,[...next]);
		setDraft((value) => ({ ...value, shared: { ...value.shared, coreIds: [...next] } }));
		setOverlay(null);setCollectionId('');
	}
	const sharedFreezeKey = JSON.stringify(task?.mixedSampling?.draft.protectedAtomIds??p.sourceProtectionAtomIds);
	useEffect(() => {
		const ids=task?.mixedSampling?.draft.protectedAtomIds??p.sourceProtectionAtomIds;
		if (!source || busy || ids === undefined) return;
		if (ids.some(id => !source.structure.atoms.some(atom => atom.id === id))) return;
		setDraft(value => JSON.stringify(value.shared.coreIds) === JSON.stringify(ids) ? value :
			{...value, shared: {...value.shared, coreIds: [...ids]}});
	}, [sharedFreezeKey, p.activeConformerInitial?.taskId, p.activeConformerInitial?.initialId, selectedInitial?.id, task?.id, busy]);
	const previewOwner = hover ?? preview;
	const torsionPreview = useMemo(() => {
		if (
			!p.active ||
			!protectedSource ||
			busy ||
			!previewOwner ||
			!sameDisplaySource(source, p.displayedSource)
		)
			return null;
		const row = draft.cards
			.find((card) => card.id === previewOwner.cardId)
			?.torsions.find((value) => value.id === previewOwner.rowId);
		if (!row || row.atomIds.length !== 4) return null;
		try {
			const snapshot = createConformerSnapshot(
				protectedSource.structure,
				protectedSource.ref,
				protectedSource.constraints
			);
			const checked = inspectManualConformerTorsion(snapshot, row.atomIds as TorsionAtoms);
			return checked.accepted
				? {
						snapshot,
						torsion: planConformerTorsionHierarchy(
							snapshot,
							[checked.torsion],
							draft.shared.coreIds.length ? draft.shared.coreIds : undefined
						).torsions[0].torsion
					}
				: null;
		} catch {
			return null;
		}
	}, [
		p.active,
		p.displayedSource,
		protectedSource,
		source,
		busy,
		previewOwner,
		draft.cards,
		draft.shared.coreIds
	]);
	useEffect(() => {
		if (!p.active || !p.displayedSource) {
			p.onDisplayLayers?.(undefined);
			return;
		}
		let animation = 0;
		const began = performance.now();
		const emit = (now: number) => {
			let previewStructure;
			try {
				if (torsionPreview)
					previewStructure = createConformerTorsionPreview(
						torsionPreview.snapshot,
						torsionPreview.torsion,
						(now - began) / 4000
					);
			} catch {
				setPreview(null);
				setHover(null);
			}
			p.onDisplayLayers?.(
				overlay || previewStructure || displayedPlaybackFrame&&playbackResolution?.referenceSource
					? {
							targetId: p.displayTargetId,
							source: p.displayedSource!,
							multiframeDisplay: overlay?.plan,
							previewStructure,
							playbackReference:displayedPlaybackFrame&&playbackResolution?.referenceSource?{mode:effectivePlaybackReference,referenceSource:playbackResolution.referenceSource,coreAtomIds:shownCoreIds}:undefined
						}
					: undefined
			);
			if (torsionPreview) animation = requestAnimationFrame(emit);
		};
		emit(began);
		return () => {
			cancelAnimationFrame(animation);
			p.onDisplayLayers?.(undefined);
		};
	}, [p.active, p.displayTargetId, p.displayedSource, p.onDisplayLayers, torsionPreview, overlay,displayedPlaybackFrame,playbackResolution,effectivePlaybackReference,shownCoreIds]);
	useEffect(() => {
		const row = previewOwner
			? draft.cards
					.find((card) => card.id === previewOwner.cardId)
					?.torsions.find((value) => value.id === previewOwner.rowId)
			: undefined;
		p.onTaskHighlights?.(p.active && row && source ? { source, atomIds: row.atomIds } : undefined);
		return () => p.onTaskHighlights?.(undefined);
	}, [p.active, previewOwner, source, draft.cards, p.onTaskHighlights]);
	const overlayControls = undefined;
	const viewControls = useRef(p.onConformerViewControls);
	viewControls.current = p.onConformerViewControls;
	useEffect(() => {
		viewControls.current?.(p.active ? overlayControls : undefined);
		return () => viewControls.current?.(undefined);
	}, [
		p.active,
		currentCollection?.id,
		currentCollection?.frames.length,
		overlay,
		fit,
		range,
		displayStride,
		draft.shared.coreIds,displayCoreIds,displayCoreAutomatic,playbackReferenceMode,effectivePlaybackReference,playbackResolution
	]);
	const samplingRun = task?.runs
			.slice()
			.reverse()
			.find((value) => value.intent === "sampling"),
		mix = samplingRun?.mixedSampling;
	const batches=task?.mixedSampling?.batches??[],currentBatch=batches.find(batch=>batch.id===task?.mixedSampling?.currentBatchId);
	const hasSamplingHistory=batches.length>0||Boolean(task?.runs.some(run=>run.intent==='sampling'))||Boolean(collections[0]?.frames.length);
	const atomConfigurationError=atomConfigurationIssues.core??Object.values(atomConfigurationIssues.cards)[0]??'';
	let samplingConfigurationError='';
	let samplingImpact:ReturnType<AdvancedController['previewMixedConfiguration']>|undefined;
	try{samplingImpact=task&&definition?p.controller.previewMixedConfiguration(task.id,definition):undefined;}catch(cause){samplingConfigurationError=cause instanceof Error?cause.message:String(cause);}
	const batchLocked=Boolean(currentBatch?.sealed||samplingImpact?.sealed);
	const renderCardProgress=(card:AdvancedSamplingCardState,configuration:AdvancedMixedSamplingCard,index:number)=><ConformerSamplingCardProgress card={card} configuration={configuration} index={index} batchRunning={running(samplingRun)} configurationChanged={samplingImpact?.affectedCardIds.includes(card.id)} remainingMs={card.id===currentCard?.id?remaining:null} generationProgress={conformerGenerationProgressForCard(samplingRun,task?.id,currentBatch?.id,card.id)}/>;
	const currentCard=mix?.definition.cards[mix.currentCardIndex];
	const currentSchedule=currentCard?.kind==='sampling'?conformerSamplingSchedule(currentCard.sampling):null;
	const currentProgress=running(samplingRun)?samplingRun?.sampling?.progress:undefined;
	const currentGenerated=running(samplingRun)?samplingRun?.sampling?.candidateFrameIds.length??0:0;
	const generated=(mix?.generated??0)+currentGenerated;
	const currentCompleted=currentProgress?.candidateCount??currentGenerated;
	const currentTotal=currentSchedule?.candidateCount;
	const currentElapsed=Math.max(0,clock-(samplingRun?.sampling?.startedAt??clock));
	const remaining=currentTotal&&currentCompleted>1&&currentElapsed>0?Math.max(0,currentElapsed/currentCompleted*(currentTotal-currentCompleted)):null;
	const canStartStage = (index: number) =>
		!!(
			resources &&
			electronicConfirmed &&
			task?.conformerWorkflow?.candidateSet?.valid &&
			task.conformerWorkflow.candidateSet.frameIds.length &&
			(index === 0 ||
				conformerUpstreamSummary(task,index,draft.stages[index].inputClusterCount??10,draft.stages[index].inputStride??1).ready)
		);
	const collectionStates = Object.fromEntries(
		collections.map((collection) => {
			const owned = task?.runs.find((value) => value.id === collection.identity.runId);
			const interrupted=collection.id.endsWith(':interrupted'),stage=task?.conformerWorkflow?.stages.find(stage=>stage.collectionId===collection.id||stage.collectionId+':interrupted'===collection.id),partial=!interrupted&&stage?.resultFrameIds!==undefined&&!stage.completed;
			const stale=collection.includeEnergies&&stage&&!stage.valid&&!partial&&stage.representativeFrameIds.length;
			return [
				collection.id,
				{
					runId: owned?.id,
					partial,interrupted,
					message: interrupted?'本级中断时的可信结构，未收敛；不计入当前有效完成或晋级名单。':partial?`部分有效结果可浏览；本级晋级尚未结算${owned?' · '+RUN_LABEL[owned.status]:''}`:stale?'待更新：尚未包含当前采样集合':owned
						? `${RUN_LABEL[owned.status]}${owned.error ? " · " + owned.error : owned.stopReason ? " · " + owned.stopReason : ""}`
						: undefined
				}
			];
		})
	);
	const electronicError = source ? baseElectronicStateError(source.structure, electronic) : "";

	const configuration = (
		<div
			ref={root}
			className="advanced-configuration"
			hidden={!p.active}
			data-testid="mixed-conformer-workspace"
		>
			<WorkflowSessionBar label="构象搜索" />
			<div className="engine-parameter-scroll" data-page-scroll="advanced-configuration" data-testid="mixed-conformer-scroll">
			<InputSettingsLayout>
				{!resources&&<output role="status" aria-label="构象搜索资源状态">{RESOURCES_WAITING}</output>}
				{requiresNewSearch&&<InputSettingsAction disabled={busy||capturing||!resources} onClick={()=>act(capture)}>以当前帧建立新搜索</InputSettingsAction>}
				<BaseElectronicStateFields
                    disabled={!source || !task || busy || capturing || requiresNewSearch}
                    charge={electronic.charge} multiplicity={electronic.multiplicity}
                    confirmed={electronicConfirmed} error={electronicError}
                    chargeLabel="本次任务电荷" multiplicityLabel="本次任务自旋多重度"
                    confirmationLabel="确认构象搜索基础电子态"
                    onChargeChange={charge=>act(()=>changeElectronic({charge}))}
                    onMultiplicityChange={multiplicity=>act(()=>changeElectronic({multiplicity}))}
                    onConfirm={()=>act(commitElectronic)}
                >
                    <p className="conformer-current-source" data-initial-guess-id={selectedInitial?.id}>{source?`初猜：${selectedInitial?.label??`帧 ${(source.ref.sourceFrameIndex??0)+1}`} · ${molecularFormula(source.structure.atoms)} · ${source.structure.atoms.length} 原子`:'尚无当前帧'}</p>
                    {task&&!frameSelected&&<p role="status">{requiresNewSearch?'当前体系与原搜索不兼容，请以当前帧建立新搜索；原搜索及结果保留。':'初始结构已修改，请确认电荷与自旋多重度。'}</p>}
                </BaseElectronicStateFields>
				<InputSettingsCard title="混合采样" testId="mixed-sampling-settings">
					<div className="mixed-sampling-definition">
						<details className="conformer-advanced-sampling"><summary>高级采样设置{draft.shared.coreIds.length||draft.shared.sphereEnabled?' · 已启用':''}</summary><fieldset disabled={busy||!source} className="conformer-advanced-groups">
							<section><strong>保护核心</strong><AdvancedRegionField source={source} port={regionCapture.selectionPort} enabled={selectionEnabled} ids={draft.shared.coreIds} label="保护原子" onRequest={()=>coordinateCapture.cancel()} onConfirm={ids=>act(()=>changeCore(ids))}/>{atomConfigurationIssues.core&&<output role="status">{atomConfigurationIssues.core}</output>}{draft.shared.coreIds.length>0&&<output>原生 MD／MTD：{Number(protectionStrengthToDisplay(draft.shared.coreForce).toPrecision(10)).toLocaleString('en-US')} kJ·mol⁻¹·nm⁻² · RMSD &lt; {NATIVE_CONFORMER_CORE_PROTECTION.maxRmsdAngstrom} Å</output>}</section>
							<section><InputSettingsCheckbox label="限制在球内" ariaLabel="将体系限制在一个球内" checked={draft.shared.sphereEnabled} onChange={sphereEnabled=>setDraft(value=>({...value,shared:{...value.shared,sphereEnabled}}))}/>{draft.shared.sphereEnabled&&<SamplingSphereEditor draft={sphere} disabled={busy} onChange={acceptSphere} onRefit={()=>source&&acceptSphere(createSamplingSphereDraft(source.ref.documentId,source.ref.revision,source.structure.atoms.map(atom=>[atom.x,atom.y,atom.z]),draft.shared.spherePaddingAngstrom))}/>}</section>
						</fieldset></details>
						{draft.cards.map((card, index) => (
							<div key={card.id} className="conformer-sampling-card">
							<details
								className="shared-input-card shared-input-subcard mixed-sampling-card"
								open={card.expanded}
								data-sampling-card-id={card.id}
								onToggle={(event) => {
									if (event.currentTarget.open !== card.expanded)
										updateCard(card.id, { expanded: event.currentTarget.open });
								}}
							>
								<summary className="shared-input-card-title">
									<span>
										采样{index + 1} ·{" "}
										{MIXED_SAMPLING_CHOICES.find((value) => value.id === card.kind)?.label}
									</span>
									<span className="mixed-sampling-card-actions">
										{[-1, 1].map((delta) => (
											<button
												key={delta}
												type="button"
												className="shared-input-action"
												aria-label={`采样${index + 1}${delta < 0 ? "上移" : "下移"}`}
												disabled={busy || index + delta < 0 || index + delta >= draft.cards.length}
												onClick={(event) => {
													event.preventDefault();
													event.stopPropagation();
													moveCard(index, delta);
												}}
											>
												{delta < 0 ? "↑" : "↓"}
											</button>
										))}
										<button
											type="button"
											className="shared-input-action"
											aria-label={`删除采样${index + 1}`}
											disabled={busy}
											onClick={(event) => {
												event.preventDefault();
												event.stopPropagation();
												setDraft((value) => ({
													...value,
													cards: value.cards.filter((row) => row.id !== card.id)
												}));
											}}
										>
											删除
										</button>
									</span>
								</summary>
								<fieldset disabled={busy||!source} className="conformer-sampling-parameters">
								{atomConfigurationIssues.cards[card.id]&&<output role="status">{atomConfigurationIssues.cards[card.id]}</output>}
								{card.kind === "conformer-search" ? (
									<>
										<ConformerTorsionControls
											source={protectedSource}
											rows={card.torsions}
											activeId={card.activeTorsionId}
											onActive={(activeTorsionId) => updateCard(card.id, { activeTorsionId })}
											onChange={(rows) =>
												act(() =>
													updateCard(card.id, {
														torsions: allocateConformerTorsionPoints(
															rows,
															card.targetText.trim() ? Number(card.targetText) : null
														)
													})
												)
											}
											selectionPort={coordinateCapture.selectionPort}
											selectionEnabled={selectionEnabled}
											onRequest={() => regionCapture.cancel()}
											validate={(ids) => {
												if (!protectedSource) throw Error("请先取用初猜。");
												const inspected = inspectManualConformerTorsion(
													createConformerSnapshot(
														protectedSource.structure,
														protectedSource.ref,
														protectedSource.constraints
													),
													ids as TorsionAtoms
												);
												if (!inspected.accepted) throw Error(`二面角不可旋转：${inspected.reason}`);
											}}
											onAutomatic={() =>
												act(() => {
													if (protectedSource)
														updateCard(card.id, {
															torsions: allocateConformerTorsionPoints(
																discoverConformerTorsionRows(
																	createConformerSnapshot(
																		protectedSource.structure,
																		protectedSource.ref,
																		protectedSource.constraints
																	)
																),
																card.targetText.trim() ? Number(card.targetText) : null
															)
														});
												})
											}
											onHover={(rowId) => setHover(rowId ? { cardId: card.id, rowId } : null)}
											onPreview={(rowId) => setPreview(rowId ? { cardId: card.id, rowId } : null)}
											previewId={preview?.cardId === card.id ? preview.rowId : null}
										/>
										<InputSettingsField label="目标帧数（可选）">
											<NumericInput
												aria-label={`采样${index + 1}目标帧数`}

												min={1}
												value={card.targetText}
												onChange={(event) =>
													updateCard(card.id, { targetText: event.target.value })
												}
												onBlur={() =>
													act(() =>
														updateCard(card.id, {
															torsions: allocateConformerTorsionPoints(
																card.torsions,
																card.targetText.trim() ? Number(card.targetText) : null
															)
														})
													)
												}
											/>
										</InputSettingsField>
										<output>理论组合数 {conformerTorsionCombinationCount(card.torsions)}</output>
									</>
								) : (
									<AdvancedSamplingControls
										embedded
										sharedConstraints
										value={card.sampling}
										onChange={(sampling) => updateCard(card.id, { sampling })}
										source={source}
										regionPort={regionCapture.selectionPort}
										selectionEnabled={selectionEnabled}
										onRegionRequest={() => coordinateCapture.cancel()}
										frameSummary={
											<output>
												{(() => {
													if(!resources)return "等待全局计算资源配置";
													try {
														return `预计采样 ${conformerSamplingSchedule(compileSampling({ ...card.sampling, ...resources, coreIds: [] }, overrideAdvancedTaskSource(source!, { protectionAtomIds: [] })))?.candidateCount ?? '—'} 帧`;
													} catch {
														return "采样参数待完善";
													}
												})()}
											</output>
										}
									/>
								)}
								</fieldset>
							</details>
							{currentBatch?.cards.find(value=>value.id===card.id)&&renderCardProgress(currentBatch.cards.find(value=>value.id===card.id)!,definition?.cards.find(value=>value.id===card.id)??currentBatch.cards.find(value=>value.id===card.id)!.configuration,index)}
							</div>
						))}
						<InputSettingsRow>
							<InputSettingsAction
								ariaLabel="添加采样方式"
								disabled={busy||!source}
								onClick={() => setAdding((value) => !value)}
							>
								添加采样方式
							</InputSettingsAction>
							{adding &&
								MIXED_SAMPLING_CHOICES.map((choice) => (
									<InputSettingsAction
										key={choice.id}
										disabled={busy||!source}
										ariaLabel={`添加${choice.label}`}
										onClick={() => addCard(choice.id)}
									>
										{choice.label}
									</InputSettingsAction>
								))}
						</InputSettingsRow>
						<fieldset disabled={busy||!source||!resources} className="conformer-deduplication"><InputSettingsCheckbox label="去重" ariaLabel="采样末尾去重" checked={draft.deduplicationEnabled!==false} onChange={deduplicationEnabled=>act(()=>changeDeduplication({deduplicationEnabled}))}/>
						{draft.deduplicationEnabled!==false&&<InputSettingsField label="RMSD / Å">
							<NumericInput
								aria-label="采样去重 RMSD"

								min={0.000001}
								step={0.001}
								value={draft.dedupRmsdAngstrom}
								onBlur={()=>act(()=>changeDeduplication({dedupRmsdAngstrom:draft.dedupRmsdAngstrom}))}
								onChange={(event) =>
									setDraft((value) => ({
										...value,
										dedupRmsdAngstrom: event.currentTarget.valueAsNumber
									}))
								}
							/>
						</InputSettingsField>}
						{draft.deduplicationEnabled!==false&&samplingRun?.backgroundProgress?.phase==='deduplicate'&&(()=>{const progress=samplingRun.backgroundProgress;return <><output>总共收到 {progress.total??'—'}帧，已处理 {progress.completed} / {progress.total??'—'}</output><div className="conformer-progress-row"><progress aria-label="采样末尾去重进度" max={progress.total??undefined} value={progress.total===null?undefined:progress.completed}/><output>{progress.total?Number((progress.completed/progress.total*100).toFixed(1)):0}%　预计剩余 {progress.etaMs==null?'估算中':samplingRemainingLabel(progress.etaMs)}</output></div></>;})()}
						{samplingRun?.backgroundProgress?.phase==='prepare-results'&&<div className="conformer-progress-row"><output role="status">{samplingRun.status==='stopping'?'采样计算已停止 · 正在准备保留结果':'正在准备采样结果'}</output><progress aria-label="准备采样结果"/><output>预计剩余 估算中</output></div>}
						{mix?.deduplicationCompleted&&<output>保留 {collections[0]?.frames.length??0} 帧</output>}
						{mix?.deduplicationCompleted===false&&<output role="status">去重未完成 · 已处理 {mix.deduplicationProcessed??0} / {mix.deduplicationTotal??0} 帧，未分类完整帧已保留</output>}
						</fieldset>
					</div>
					<div className="mixed-sampling-actions conformer-progress-row">
						<InputSettingsAction
							variant="primary"
							disabled={
								busy ||
								capturing ||
								!source ||
								!draft.cards.length ||
                                !electronicConfirmed ||
								!resources ||
								!task?.mixedSampling || batchLocked || !samplingImpact?.canContinue || Boolean(samplingConfigurationError||atomConfigurationError)
							}
							onClick={() => act(() => beginSampling("continue"))}
						>
							{hasSamplingHistory ? "继续采样" : "开始采样"}
						</InputSettingsAction>
						<InputSettingsAction disabled={busy||!resources||!electronicConfirmed||!draft.cards.length||!hasSamplingHistory||Boolean(samplingConfigurationError||atomConfigurationError)} onClick={()=>act(()=>beginSampling('restart'))}>重新采样</InputSettingsAction>
						<InputSettingsAction
							disabled={
								busy || !electronicConfirmed || !draft.cards.length || !hasSamplingHistory || !resources || Boolean(samplingConfigurationError||atomConfigurationError)
							}
							onClick={() => act(() => beginSampling("append"))}
						>
							追加采样
						</InputSettingsAction>
						<button
							type="button"
							className="shared-input-action conformer-stop-action"
							disabled={!running(samplingRun) || samplingRun?.status === "stopping"}
							onClick={() => act(() => task && samplingRun && p.controller.stop(task.id, samplingRun.id))}
						>
							{samplingRun?.status === "stopping" ? "正在终止" : "终止采样"}
						</button>
						<InputSettingsAction
							disabled={busy || !hasSamplingHistory}
							onClick={() => act(clearSampling)}
						>
							清空采样
						</InputSettingsAction>
					</div>
					{samplingRun?.error&&error!==samplingRun.error&&<DismissibleNotice identity={samplingRun.id}>{samplingRun.error}</DismissibleNotice>}
					{clearing&&<p role="status">正在清空并释放本任务资源…</p>}
					{samplingConfigurationError&&<DismissibleNotice>{samplingConfigurationError}</DismissibleNotice>}
					{error&&<DismissibleNotice>{error}</DismissibleNotice>}
				</InputSettingsCard>
				<ConformerOptimizationStages
					stages={draft.stages}
					samplingInputCount={task?.conformerWorkflow?.candidateSet?.valid?task.conformerWorkflow.candidateSet.frameIds.length:undefined}
					busy={busy}
					onChange={(stages) => act(()=>changeStages(stages))}
					canStart={canStartStage}
					upstreamForStage={index=>conformerUpstreamSummary(task,index,draft.stages[index].inputClusterCount??10,draft.stages[index].inputStride??1)}
					onStart={(index) => act(() => startOptimization(index))}
					onRunAll={() => act(() => startOptimization())}
					actionForStage={(id)=>optimizationActionView(task,id)}
					onContinue={(index)=>act(()=>startOptimization(index))}
					onRestart={(index)=>act(()=>startOptimization(index,'restart'))}
					onRestartAll={()=>act(()=>startOptimization(undefined,'restart'))}
					onPause={(index)=>act(()=>{const owned=optimizationActionView(task,draft.stages[index].id).run;if(task&&owned)p.controller.pauseOptimization(task.id,owned.id);})}
					onViewResults={(index)=>{const id=task?.conformerWorkflow?.stages.find(stage=>stage.stageId===draft.stages[index].id)?.collectionId??`pending:${task?.id}:${draft.stages[index].id}`,collection=collections.find(value=>value.id===id);if(collection?.frames.length)openCollection(collection);}}
				/>
			</InputSettingsLayout>
			</div>
		</div>
	);
	const results = (
		<div className="advanced-results" hidden={!p.active} data-testid="conformer-results">
			<WorkflowSessionBar label="采样与优化结果" />
			<InputSettingsLayout>
				<ConformerStageResults busy={busy} onOrganize={id=>act(()=>{const collection=collections.find(row=>row.id===id);if(task&&collection?.clusterCollection)p.controller.organizeStage(task.id,collection.clusterCollection.configurationId);})}
					collections={collections}
					collectionId={currentCollection?.id}
					collectionStates={collectionStates}
					selectedFrameId={selectedFrame?.id}
					run={run}
					runs={task?.runs}
					active={p.active}
					onFrameOrder={p.onConformerFrameOrder}
						displayFramesForCollection={id=>id===currentCollection?.id?currentDisplayFrames:undefined}
					onCollection={(id) => {
						const value = collections.find((collection) => collection.id === id);
						if (value) openCollection(value);
					}}
					onFrame={(frame) => {
						const collection = collections.find((value) =>
							value.frames.some((row) => row.id === frame.id)
						);
						if (collection) {
							if (overlay?.plan.frames.some((value) => value.key === frame.id))
								setOverlay({ ...overlay, plan: activateMultiframeDisplay(overlay.plan, frame.id) });
							openCollection(collection, frame.id,true);
						}
					}}
                    onPrepareBatchInput={p.onPrepareBatchInput ? frames=>act(()=>p.onPrepareBatchInput!(frames.map(frame=>frame.source),draft.shared.coreIds,selectedFrame?.source.ref.frameId)) : undefined}
				/>
			</InputSettingsLayout>
		</div>
	);
	return (
		<>
			{p.configurationHost ? createPortal(configuration, p.configurationHost) : null}
			{p.resultHost ? createPortal(results, p.resultHost) : null}
		</>
	);
}
