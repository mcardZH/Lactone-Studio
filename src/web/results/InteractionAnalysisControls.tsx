import {DismissibleNotice} from '../DismissibleNotice';
import MultiwfnErrorNotice from './MultiwfnErrorNotice';
import {ProjectUiScope,ProjectNativeDetailsBoundary,useProjectUiScope,projectUiSourceIdentity,useProjectState} from '../../projects/ui-state';
import {analysisOriginalCubeKey,openAnalysisOriginalCube,useAnalysisProjectSnapshot,rebindAnalysisContext,isRestoredAnalysisData} from '../../projects/analysis-state';
import { exportSavedCube } from './export-saved-cube';
import {ResultsMcpPortRegistration} from './results-mcp-context';
import {patchColorbarLayout,patchMeshFinish,settingArray,settingBool,settingColor,settingColorbarLayout,settingColorRange,settingDecimals,settingEnum,settingMeshFinish,settingPositive,settingText,spatialGridSetting,validateColorRange} from './analysis-mcp-settings';
import {analysisCube,analysisText} from './analysis-mcp-assets';
import {objectSchema} from '../mcp/types';
import {matchingSliderRange} from '../numeric-step';
import NumericInput from '../NumericInput';
import {SelectionGroupHeader,SelectionAddButton,SelectionRemoveButton} from '../InteractiveSelectionField';
import {calculationRangeFromGrid,estimatedCalculationRange,prepareCalculationRange} from '../../results/calculation-range';
import {sha256Utf8} from '../../core/file-identity';
import CalculationRangeControl from './CalculationRangeControl';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	InteractionContributions,
	InteractionFragment,
	InteractionGeneratedFields,
	InteractionGridQuality,
	InteractionMethod
} from "../../results/interaction-contracts";
import type { SurfaceScalarField } from "../../results/surface-contracts";
import { sameSurfaceContext } from "../../results/surface-field";
import {
	interactionScatterData,
	validateInteractionContributions,
	validateInteractionGeneratedFields,
	validateInteractionFieldPair
} from "../../results/interaction-field";
import { DEFAULT_RESULT_DECIMALS } from "../../results/numeric-format";
import {
	activeAnalysisRows,
	analysisRowBindings,
	toggleAnalysisRow,
	ANALYSIS_PALETTES
} from "./analysis-display";
import { surfaceContextKey } from "./surface-presentation";
import { surfaceColor } from "../modeling/render/surface-layer";
import { InputSettingsField, InputSettingsRow } from "../InputSettingsFields";
import {
	InputSettingsAction,
	InputSettingsCheckbox,
	InputSettingsLayout,
	InputSettingsSection
} from "../InputSettingsLayout";
import NumericPrecisionControl from "./NumericPrecisionControl";
import MeshFinishControls from "./MeshFinishControls";
import SurfaceAppearanceControls from './SurfaceAppearanceControls';
import { interactionAppearance } from './surface-appearance';
import { useSurfaceAppearanceDefaults } from './useSurfaceAppearanceDefaults';
import SaveSurfaceAppearanceDefault from './SaveSurfaceAppearanceDefault';
import { captureInteractionAppearance, restoreInteractionAppearance, type SavedMeshAppearance } from './surface-appearance-defaults';
import MultiwfnProgress from "./MultiwfnProgress";
import ScientificScatterPlot from "./ScientificScatterPlot";
import { ScientificDataTable } from "./ScientificDataTable";
import { scientificTableText, type ScientificTableProjection } from "./scientific-table";
import { exportBlob } from "./export-image";
import { useAnalysisFeedback } from "./AnalysisFeedback";
import {
	initialInteractionDisplay,
	interactionComponents,
	interactionContributionHighlights,
	interactionContributionKey,
	interactionContributionTables,
	interactionDefinitionKey,
	interactionHasFragments,
	interactionHasContributions,
	interactionIntegralTable,
	interactionSourceFragments,
	interactionScatterInitialViewport,
	nextInteractionFragment,
	INTERACTION_COMPONENT_LABELS,
	INTERACTION_METHOD_LABELS,
	type InteractionContributionSort
} from "./interaction-presentation";
import type {
	InteractionAnalysisControlsProps,
	InteractionDisplaySettings,
	InteractionGenerateInvocation,
	InteractionProjection
} from "./interaction-controls-contracts";
import "./Postprocess.css";
import './interaction-analysis-controls.css';
import { SpatialGridSummary, AnalysisTaskLayout, AnalysisTaskSection, CalculationQualityControl, type CalculationQualityTier } from './AnalysisTaskLayout';
import { INTERACTION_QUALITY_OPTIONS, interactionQualityIssue, interactionQualityPreset, interactionQualityTier } from './interaction-quality';
import { surfaceGridPreview } from './surface-quality';
import AnalysisColorbarLayoutControls from './AnalysisColorbarLayoutControls';
import { interactionSurfaceColorbar } from './interaction-controls-contracts';
import { normalizeAnalysisColorbarLayout, type AnalysisColorbarLayout } from './analysis-colorbar-layout';
import { interactionUsesStructure } from '../../results/interaction-structure-context';

interface FieldDescriptor {
	fieldId: string;
	sourceId: string;
	sourceRevision: string;
	name: string;
}
interface CubeSlot {
	field: SurfaceScalarField | null;
	descriptor?: FieldDescriptor;
	pendingName?: string;
	error?: string;
}
interface MethodState {
 showRange?:boolean;
	input: "internal" | "external";
	fragments: readonly InteractionFragment[];
	quality: InteractionGridQuality;
	qualityTier?: CalculationQualityTier;
	display: InteractionDisplaySettings;
	role: InteractionDisplaySettings["component"];
	units: { field: string; mapping: string };
	slots: { field: CubeSlot; mapping: CubeSlot };
	pair: [string, string];
	integrationQuality: 2 | 3 | 4;
	pins: readonly string[];
	hover: string | null;
	current?: string | null;
	tab: "surface" | "scatter";
	sort: InteractionContributionSort;
  pairSort?: InteractionContributionSort;
}
interface GenerationRecord {
	request: InteractionGenerateInvocation;
	generationId: string;
	generated?: InteractionGeneratedFields;
}
export interface InteractionAnalysisSnapshot {
  contextKey: string; method: InteractionMethod; decimals: number; scatterDecimals: number;
  contributionDecimals: { atoms: number; pairs: number };
  states: Record<string, MethodState>; records: Record<string, GenerationRecord>;
  contributions: Record<string, InteractionContributions>;
  appearanceSeeds?: Record<string, SavedMeshAppearance | null>;
}
const emptySlot = (): CubeSlot => ({ field: null });
const describeField = (field: SurfaceScalarField): FieldDescriptor => ({
	fieldId: field.id,
	sourceId: field.source.id,
	sourceRevision: field.source.revision,
	name: field.source.name
});
const initialState = (
	method: InteractionMethod,
	p: InteractionAnalysisControlsProps
): MethodState => ({
	input: "internal",
 showRange:true,
	fragments: [
		{ id: "fragment-a", label: "A", atomIds: [] },
		{ id: "fragment-b", label: "B", atomIds: [] }
	],
	quality: { mode: "medium" },
	qualityTier: 'medium',
	display: initialInteractionDisplay(method, p.methodDefaults),
	role: interactionComponents(method)[0],
	units: { field: "", mapping: "" },
	slots: { field: emptySlot(), mapping: emptySlot() },
	pair: ["fragment-a", "fragment-b"],
	integrationQuality: 2,
	pins: [],
	hover: null,
	tab: "surface",
	sort: { column: "identity", direction: "asc" }
});
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Instance-local state; no model writes and no automatic scientific requests. */
function InteractionAnalysisControlsInner(p: InteractionAnalysisControlsProps) {
	const [colorbarOwner] = useState(() => crypto.randomUUID());
	const appearanceDefaults=useSurfaceAppearanceDefaults();
	const { notify, feedback } = useAnalysisFeedback();
	const sourceDraft = p.draftState?.current;
	const saved = sourceDraft?.contextKey === surfaceContextKey(p.context) ? sourceDraft : undefined;
	const [method, setMethod] = useState<InteractionMethod>(saved?.method ?? p.initialMethod ?? (p.methods.includes("iri") ? "iri" : p.methods[0] ?? "iri")),
		[decimals, setDecimals] = useState(saved?.decimals ?? DEFAULT_RESULT_DECIMALS);
	const [scatterDecimals, setScatterDecimals] = useState(saved?.scatterDecimals ?? DEFAULT_RESULT_DECIMALS);
	const [contributionDecimals, setContributionDecimals] = useState(saved?.contributionDecimals ?? { atoms: DEFAULT_RESULT_DECIMALS, pairs: DEFAULT_RESULT_DECIMALS });
	const [states, setStates] = useState<Record<string, MethodState>>(() => saved ? Object.fromEntries(Object.entries(saved.states).map(([key, state]) => [key, {
		...state, hover: null, slots: { field: { ...state.slots.field, pendingName: undefined }, mapping: { ...state.slots.mapping, pendingName: undefined } }
	}])) : {}),
		[records, setRecords] = useState<Record<string, GenerationRecord>>(saved?.records ?? {}),
		[contributions, setContributions] = useState<Record<string, InteractionContributions>>(saved?.contributions ?? {});
	const [appearanceSeeds, setAppearanceSeeds] = useState<Record<string, SavedMeshAppearance | null>>(saved?.appearanceSeeds ?? {});
	const [busy, setBusy] = useState<{
			id: string;
			owner: string;
			label: string;
			stopping: boolean;
		} | null>(null),
		[failure, setFailure] = useState<{ owner: string; value: string } | null>(null),
		[restoreRetry, setRestoreRetry] = useState(0);
	const [lastRun, setLastRun] = useState<{ id: string; owner: string; label: string } | null>(null);
	const contextKey = surfaceContextKey(p.context),
		stateKey = `${contextKey}:${method}`;
 useAnalysisProjectSnapshot(`controls:interaction:${projectUiSourceIdentity(p)}`,async()=>{
  const snapshot:InteractionAnalysisSnapshot={contextKey,method,decimals,scatterDecimals,contributionDecimals,states:structuredClone(states),records:structuredClone(records),contributions:structuredClone(contributions),appearanceSeeds:structuredClone(appearanceSeeds)};
  for(const [key,state] of Object.entries(snapshot.states)){
   const [sourceId,sourceRevision,jobIndex,sourceFrameIndex,generation,documentId,documentRevision]=JSON.parse(key.slice(0,key.lastIndexOf(':')));
   const sourceContext={...p.context,sourceId,sourceRevision,jobIndex,sourceFrameIndex,generation,documentId,documentRevision};
   state.hover=null;state.current=state.current??null;
   for(const slot of Object.values(state.slots))if(!slot.field&&slot.descriptor){
    if(!p.bridge.restoreCube)throw new Error('无法完整保存相互作用Cube：已释放格点缺少只读恢复接口。');
    const d=slot.descriptor;slot.field=await p.bridge.restoreCube({context:sourceContext,requestId:crypto.randomUUID(),fieldId:d.fieldId,sourceId:d.sourceId,sourceRevision:d.sourceRevision},new AbortController().signal);
    if(slot.field.id!==d.fieldId||slot.field.source.revision!==d.sourceRevision)throw new Error('相互作用Cube恢复身份不符。');
   }
  }
  for(const record of Object.values(snapshot.records))if(!record.generated){
   if(!p.bridge.restoreFields)throw new Error('无法完整保存相互作用结果：已释放格点缺少只读恢复接口。');
   record.generated=await p.bridge.restoreFields({context:record.request.context,requestId:crypto.randomUUID(),generationId:record.generationId},new AbortController().signal);
   validateInteractionGeneratedFields(record.generated,{...record.request,stamp:record.generated.stamp});
  }
  return snapshot;
 },saved=>{const value=rebindAnalysisContext(saved,p.context);setMethod(value.method);setDecimals(value.decimals);setScatterDecimals(value.scatterDecimals);setContributionDecimals(value.contributionDecimals);setStates(value.states);setRecords(value.records);setContributions(value.contributions);setAppearanceSeeds(value.appearanceSeeds??{});setBusy(null);setFailure(null);},undefined,()=>({records,contributions}));
	if (p.draftState) p.draftState.current = { contextKey, method, decimals, scatterDecimals, contributionDecimals, states, records, contributions, appearanceSeeds };
	function initialMethodState(nextMethod:InteractionMethod) {
		const nextKey=`${contextKey}:${nextMethod}`,initial = initialState(nextMethod, p), configured = p.methodDefaults?.[nextMethod], seed = appearanceSeeds[nextKey];
		const legacyAppearance = configured?.color !== undefined || configured?.finish !== undefined;
		return seed && !legacyAppearance ? { ...initial, display: restoreInteractionAppearance(initial.display, seed) } : initial;
	}
	const fallback = useMemo(() => initialMethodState(method), [contextKey, method, p.methodDefaults, appearanceSeeds, stateKey]);
	const state = states[stateKey] ?? fallback;
	useEffect(() => {
		if (!appearanceDefaults.ready || appearanceDefaults.error || !appearanceDefaults.snapshot || appearanceDefaults.snapshot.error || states[stateKey] || Object.hasOwn(appearanceSeeds, stateKey)) return;
		const saved = appearanceDefaults.snapshot.value[`interaction:${method}`];
		// A successful read fixes only this instance's appearance. Scientific
		// defaults stay live until an actual user/scientific action creates state.
		const seed = saved && 'colors' in saved ? structuredClone(saved) : null;
		setAppearanceSeeds(values => Object.hasOwn(values, stateKey) ? values : { ...values, [stateKey]: seed });
	}, [appearanceDefaults.ready, appearanceDefaults.error, appearanceDefaults.snapshot, stateKey, states, appearanceSeeds, method]);
	const latest = useRef({ p, state, stateKey, contextKey });
	latest.current = { p, state, stateKey, contextKey };
	const root = useRef<HTMLElement>(null);
	const alive = useRef(true),
		running = useRef<{
			id: string;
			controller: AbortController;
			cancel?: () => void | Promise<void>;
		} | null>(null),
		restoreAttempts = useRef(new Set<string>());
	const update = useCallback(
		(change: Partial<MethodState> | ((previous: MethodState) => MethodState)) =>
			setStates((previous) => {
				const before = previous[stateKey] ?? fallback;
				return {
					...previous,
					[stateKey]: typeof change === "function" ? change(before) : { ...before, ...change }
				};
			}),
		[stateKey, fallback]
	);
	const patchDisplay = (change: Partial<InteractionDisplaySettings>) =>
		update((before) => ({ ...before, display: { ...before.display, ...change } }));
	const qualityTier = state.qualityTier ?? interactionQualityTier(state.quality);
	const plannedRange = useMemo(() => prepareCalculationRange(() => {
		if (state.input !== 'internal') return null;
		const key = sha256Utf8(JSON.stringify([contextKey, method, state.quality]));
		return estimatedCalculationRange(p.structure, state.quality, 1.5, `interaction-range:estimate:${key}`, '相互作用');
	}), [contextKey, p.structure, method, state.input, state.quality]);
	const rangeRejectsSpacing = state.input === 'internal' && state.quality.mode === 'spacing' && !plannedRange.value && p.structure.atoms.length > 0;
	const nativeQualityIssue = useMemo(() => interactionQualityIssue(state.quality, method, p.resourceBudgetBytes), [state.quality, method, p.resourceBudgetBytes]);
	const qualityIssue = nativeQualityIssue
		?? (rangeRejectsSpacing ? `当前格距无法形成可用的计算范围，请修改格距。${plannedRange.issue}` : null);
	const source = useMemo(() => {
		try {
			return {
				fragments: interactionHasFragments(method)
					? interactionSourceFragments(state.fragments, p.sourceAtomOrder)
					: [],
				error: ""
			};
		} catch (error) {
			return { fragments: [], error: message(error) };
		}
	}, [method, state.fragments, p.sourceAtomOrder]);
	const definitionKey = interactionDefinitionKey(
			p.context,
			method,
			source.fragments,
			state.quality
		),
		record = records[definitionKey],
		generated = state.input === "internal" ? (record?.generated ?? null) : null;
	const contributionKey = interactionContributionKey(
			p.context,
			method,
			source.fragments,
			state.pair,
			state.integrationQuality
		),
		contribution = state.input === "internal" ? (contributions[contributionKey] ?? null) : null;
	const membershipError = interactionHasFragments(method)
		? source.error ||
			(state.fragments.length < 2
				? "至少定义两个非空片段。"
				: state.fragments.some((row) => row.atomIds.length === 0)
					? "片段不能为空。"
					: new Set(state.fragments.flatMap((row) => [...row.atomIds])).size !==
						  state.fragments.reduce((sum, row) => sum + row.atomIds.length, 0)
						? "片段原子重复，请重新确认。"
						: "")
		: "";
	const assigned = new Set(state.fragments.flatMap((row) => [...row.atomIds])),
		unassigned = p.structure.atoms.filter((atom) => !assigned.has(atom.id!)).length;
	const currentBusy = busy?.owner === contextKey ? busy : null,
		disabled = p.available === false || !!busy;
	const cancel = useCallback(() => {
		const job = running.current;
		if (!job) return;
		job.controller.abort();
		setBusy((previous) => (previous?.id === job.id ? { ...previous, stopping: true } : previous));
		void Promise.resolve(job.cancel?.()).catch((error) => {
			if (alive.current) latest.current.p.onError?.(message(error));
		});
	}, []);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			const job = running.current;
			job?.controller.abort();
			void Promise.resolve(job?.cancel?.()).catch(() => {});
		};
	}, []);
	const run = async (
		label: string,
		work: (signal: AbortSignal, requestId: string) => Promise<void>
	) => {
		if (running.current) {
			notify("当前分析仍有任务运行。");
			return;
		}
		const id = crypto.randomUUID(),
			controller = new AbortController(),
			bridge = p.bridge;
		running.current = { id, controller, cancel: () => bridge.cancel?.(id) };
		setBusy({ id, owner: contextKey, label, stopping: false });
		setLastRun({ id, owner: contextKey, label });
		setFailure(null);
		try {
			await work(controller.signal, id);
		} catch (error) {
			const stale = latest.current.contextKey !== contextKey;
			if (stale) restoreAttempts.current.clear();
			if (
				alive.current &&
				!controller.signal.aborted &&
				!(error instanceof Error && error.name === "AbortError")
			) {
				const text = message(error);
				setFailure({ owner: contextKey, value: text });
			}
		} finally {
			if (running.current?.id === id) {
				running.current = null;
				if (alive.current) setBusy(null);
			}
		}
	};
	const accept = (signal: AbortSignal) => alive.current && !signal.aborted;
	const assertStamp = (stamp: InteractionGeneratedFields["stamp"], requestId: string) => {
		if (stamp.requestId !== requestId || !sameSurfaceContext(stamp, p.context))
			throw Error("结果与本次来源、帧或请求不一致。");
	};
	const computeIssue = membershipError || (!interactionUsesStructure(method) && !p.wavefunctionAvailable ? "当前帧缺少匹配波函数。"
		: !p.methods.includes(method) || !p.bridge.generate ? "当前来源尚不能计算此方法。" : qualityIssue);
	const compute = () => {
		if (computeIssue) { notify(computeIssue); return; }
		void run(`生成 ${INTERACTION_METHOD_LABELS[method]} 格点`, async (signal, requestId) => {
			const request = {
					context: p.context,
					requestId,
					method,
					fragments: source.fragments,
					quality: state.quality
				},
				result = await p.bridge.generate!(request, signal);
			if (!accept(signal)) return;
			assertStamp(result.stamp, requestId);
			validateInteractionGeneratedFields(result, { ...request, stamp: result.stamp });
			setRecords((previous) => ({
				...previous,
				[definitionKey]: { request, generationId: requestId, generated: result }
			}));
		});
	};
	const contributionIssue =
			!interactionHasContributions(method) ||
			!p.methods.includes(method) ||
			state.input === "external" ||
			(method !== "migm" && !p.wavefunctionAvailable) ||
			!p.bridge.contributions
		? method === "migm" ? "mIGM 贡献分析需要当前结构及内部片段定义。" : "贡献分析需要当前帧可靠绑定的波函数及内部片段定义。"
		: membershipError || (state.pair[0] === state.pair[1] || state.pair.some(id => !state.fragments.some(row => row.id === id)) ? "请选择两个不同片段。" : "");
	const computeContributions = () => {
		if (contributionIssue) { notify(contributionIssue); return; }
		void run("计算片段贡献", async (signal, requestId) => {
			const request = {
					context: p.context,
					requestId,
					method: method as "igmh" | "migm",
					fragments: source.fragments,
					pair: state.pair,
					integrationQuality: state.integrationQuality
				},
				result = await p.bridge.contributions!(request, signal);
			if (!accept(signal)) return;
			assertStamp(result.stamp, requestId);
			validateInteractionContributions(result, { ...request, stamp: result.stamp });
			setContributions((previous) => ({ ...previous, [contributionKey]: result }));
		});
	};
	const mcpPort=<ResultsMcpPortRegistration kind="runs" id={p.analysisId??null} port={{
		sourceRevision:JSON.stringify([contextKey,definitionKey,contributionKey,state.input,state.fragments,state.role,state.display,state.showRange,decimals,scatterDecimals,generated?.stamp.requestId]),
		methods:p.active&&p.available!==false&&state.input==='internal'?[...(computeIssue?[]:['interaction-grid']),...(contributionIssue?[]:['interaction-contributions'])]:[],
		plots:():Record<string,{sourceKey:string;open():string|void}>=>p.active&&p.available!==false&&scatterSnapshot&&p.onOpenScatter?
			{'interaction-scatter':{sourceKey:scatterSnapshot.analysisSourceKey,open:()=>p.onOpenScatter!(scatterSnapshot)}}:{},
		assets:()=>{
			if(!p.active||p.available===false)return [];
			const cube=(id:string,field:SurfaceScalarField)=>analysisCube(id,field,{source:field.source,context:field.context,function:field.function,method},
				field.source.kind==='external-cube'&&p.analysisId?async()=>{
					const original=await openAnalysisOriginalCube(analysisOriginalCubeKey(p.analysisId!,field.context,field.id));
					if(!original||original.sourceRevision!==field.source.revision)throw new Error('当前外部 Cube 缺少已核对的原始字节。');
					return original;
				}:undefined);
			return [...(shape?[cube('interaction-shape',shape)]:[]),...(mapping?[cube('interaction-mapping',mapping)]:[]),
				...(generated?.integrals.length?[analysisText('interaction-integrals',()=>scientificTableText(interactionIntegralTable(generated,decimals)),{stamp:generated.stamp,method})]:[]),
				...(contribution?[analysisText('interaction-contributions',()=>JSON.stringify(contribution,null,2),{stamp:contribution.stamp,method},'json')]:[])];
		},
		read:()=>({kind:'interaction',method,fragments:state.fragments,pair:state.pair,quality:state.quality,integrationQuality:state.integrationQuality,
			busy:currentBusy,progress:p.progress,error:failure?.owner===contextKey?failure.value:undefined,
			field:generated&&{stamp:generated.stamp},contribution}),
		execution:()=>({status:currentBusy?.stopping?'stopping':taskProgress?.phase??(running.current?'running':'idle'),
			requestId:running.current?.id??taskProgress?.identity.runId,stoppable:Boolean(running.current&&!running.current.controller.signal.aborted),progress:taskProgress}),
		stop:cancel,
		configuration:{schema:objectSchema({method:settingEnum(p.methods),quality:spatialGridSetting,
			fragments:settingArray(objectSchema({id:settingText,label:settingText,atomIds:settingArray(settingText)},['id','label','atomIds'])),
			pair:settingArray(settingText,2,2),integrationQuality:settingEnum([2,3,4]),isovalue:settingPositive,showRange:settingBool,decimals:settingDecimals}),
			read:()=>({method,quality:state.quality,fragments:state.fragments,pair:state.pair,integrationQuality:state.integrationQuality,
				isovalue:state.display.isovalue,showRange:state.showRange,decimals}),
			apply(values){
				if(!p.active||p.available===false||running.current)throw new Error('当前相互作用设置不可编辑。');
				const patch=values as Partial<{method:InteractionMethod;quality:InteractionGridQuality;fragments:InteractionFragment[];
					pair:MethodState['pair'];integrationQuality:MethodState['integrationQuality'];isovalue:number;showRange:boolean;decimals:number}>;
				const nextMethod=patch.method??method,nextKey=`${contextKey}:${nextMethod}`,before=states[nextKey]??initialMethodState(nextMethod);
				if(patch.quality){const issue=interactionQualityIssue(patch.quality,nextMethod,p.resourceBudgetBytes);if(issue)throw new Error(issue);}
				const fragments=patch.fragments??before.fragments;
				const knownAtoms=new Set(p.sourceAtomOrder.map(row=>row.atomId)),knownFragments=new Set(fragments.map(row=>row.id));
				if(patch.fragments&&(!interactionHasFragments(nextMethod)||knownFragments.size!==fragments.length||fragments.some(row=>!row.id||!row.label||row.atomIds.some(id=>!knownAtoms.has(id)))))
					throw new Error('片段需要当前方法和来源的有效原子及独立标识。');
				if(patch.pair&&(patch.pair[0]===patch.pair[1]||patch.pair.some(id=>!knownFragments.has(id))))throw new Error('请选择两个不同的已有片段。');
				const {method:chosen,decimals:precision,isovalue,...rest}=patch;
				if(Object.keys(rest).length||isovalue!==undefined)setStates(previous=>({...previous,[nextKey]:{...before,...rest,
					...(patch.quality?{qualityTier:interactionQualityTier(patch.quality)}:{}),...(isovalue===undefined?{}:{display:{...before.display,isovalue}})}}));
				if(chosen!==undefined)setMethod(chosen);
				if(precision!==undefined)setDecimals(precision);
			}},
		presentation:{
			schema:objectSchema({visible:settingBool,component:settingEnum(interactionComponents(method)),isovalue:settingPositive,
				opacity:{type:'number',minimum:.05,maximum:1},range:settingColorRange,colors:settingArray(settingColor,2),reverse:settingBool,
				colorbarLayout:settingColorbarLayout,finish:settingMeshFinish}),
			read:()=>({visible:state.display.visible,component:state.display.component,isovalue:state.display.isovalue,opacity:state.display.opacity,
				range:colors&&Number.isFinite(colors.min)&&Number.isFinite(colors.max)&&colors.min<colors.max?{min:colors.min,max:colors.max}:null,
				colors:colors?.colors,reverse:colors?.reverse??false,unit:mapping?.valueUnit,
				colorbarLayout:normalizeAnalysisColorbarLayout(state.display.colorbarLayout),finish:patchMeshFinish(state.display.finish,{})}),
			apply(values){
				if(!p.active||p.available===false)throw new Error('当前相互作用显示不可编辑。');
				const {range,colors:stops,reverse,colorbarLayout,finish,...display}=values as Pick<Partial<InteractionDisplaySettings>,'visible'|'component'|'isovalue'|'opacity'> &
					{range?:{min:number;max:number}|null;colors?:string[];reverse?:boolean;colorbarLayout?:unknown;finish?:unknown};
				validateColorRange(range);
				const base=initialInteractionDisplay(method,p.methodDefaults).color;
				const selected=state.display.color??base;
				const limits=range===null?base:range??selected;
				const color={min:limits?.min??NaN,max:limits?.max??NaN,colors:stops??selected?.colors??['#0000ff','#00ff00','#ff0000'],
					reverse:reverse??selected?.reverse,zeroCentered:true};
				patchDisplay({...display,
					...((range!==undefined||stops!==undefined||reverse!==undefined)&&{color,appearancePreset:'custom'}),
					...(colorbarLayout!==undefined&&{colorbarLayout:patchColorbarLayout(state.display.colorbarLayout,colorbarLayout)}),
					...(finish!==undefined&&{finish:patchMeshFinish(state.display.finish,finish)}),
				});
			},
		},
		run(operation,retry,parameters){
			if(Object.keys(parameters).length)throw new Error('相互作用分析使用当前面板的片段和精度。');
			if(!p.active||p.available===false||state.input!=='internal')throw new Error('当前分析未激活或没有内部分析来源。');
			if(running.current)throw new Error('已有相互作用分析正在运行。');
			if(operation==='interaction-grid'){
				if(generated&&!retry)return {status:'ready',stamp:generated.stamp};
				if(computeIssue)throw new Error(computeIssue);compute();
			}else if(operation==='interaction-contributions'){
				if(contribution&&!retry)return {status:'ready',stamp:contribution.stamp};
				if(contributionIssue)throw new Error(contributionIssue);computeContributions();
			}else throw new Error('当前相互作用操作不可用。');
			return {status:'submitted',method,fragments:source.fragments,quality:state.quality,integrationQuality:state.integrationQuality};
		},
	}}/>;
	const shape =
			state.input === "external"
				? null
				: (generated?.fields[state.display.component] ?? null),
		mapping = state.input === "external" ? null : (generated?.mapping ?? null);
	const fieldData = useMemo(() => {
		if (!shape || !mapping) return { draft: null, scatter: null, error: "" };
		try {
			if (
				!sameSurfaceContext(shape.context, p.context) ||
				!sameSurfaceContext(mapping.context, p.context)
			)
				throw Error("格点与当前来源/帧不一致。");
			if (state.input === "external") {
				if (!p.cubeGeometryError) throw Error("外部格点与当前结构的原子对应尚未核对。");
				for (const field of [shape, mapping]) {
					const problem = p.cubeGeometryError(field);
					if (problem) throw Error(problem);
				}
			}
			const draft = {
				kind: "interaction" as const,
				method,
				component: state.display.component,
				shape,
				mapping,
				inside: method === "iri" || method === "rdg" ? ("below" as const) : ("above" as const)
			};
			return { draft, scatter: interactionScatterData(draft), error: "" };
		} catch (error) {
			return { draft: null, scatter: null, error: message(error) };
		}
	}, [
		shape,
		mapping,
		p.context,
		p.cubeGeometryError,
		method,
		state.input,
		state.display.component
	]);
	const fieldView = useMemo(() => {
		const { draft, scatter, error } = fieldData;
		if (!draft || state.display.isovalue === null) return { pair: null, scatter, error };
		const pair = { ...draft, isovalue: state.display.isovalue };
		const validation = validateInteractionFieldPair(pair);
		return validation.compatible ? { pair, scatter, error } : { pair: null, scatter, error: validation.reasons.join("；") };
	}, [fieldData, state.display.isovalue]);
	const highlights = useMemo(
		() =>
			({ atoms: interactionContributionHighlights(
				contribution,
				activeAnalysisRows(state.pins, state.hover ?? state.current ?? null),
				p.sourceAtomOrder,
				p.structure,
				contributionDecimals.atoms
			).atoms, pairs: interactionContributionHighlights(contribution, activeAnalysisRows(state.pins, state.hover ?? state.current ?? null), p.sourceAtomOrder, p.structure, contributionDecimals.pairs).pairs }),
		[contribution, state.pins, state.hover, state.current, p.sourceAtomOrder, p.structure, contributionDecimals]
	);
	const effectiveDisplay = useMemo(() => {
		const color = state.display.color;
		return {
			...state.display,
			color:
				color && Number.isFinite(color.min) && Number.isFinite(color.max) && color.min < color.max
					? color
					: null
		};
	}, [state.display]);
	const actualRange = useMemo(() => prepareCalculationRange(() => {
		if (!fieldView.pair) return null;
		const key = sha256Utf8(JSON.stringify([contextKey, method, fieldView.pair.shape.id]));
		return calculationRangeFromGrid(fieldView.pair.shape.grid, `interaction-range:actual:${key}`, '相互作用');
	}), [contextKey, method, fieldView.pair]);
	const range = fieldView.pair ? actualRange.value : plannedRange.value;
 const calculationRanges=useMemo(()=>state.showRange!==false&&range?[range]:[],[state.showRange,range]);
	const projection = useMemo<InteractionProjection>(
		() => ({
			context: p.context,
 calculationRanges,
			method,
			fields: fieldView.pair,
			display: effectiveDisplay,
			generated,
			contributions: contribution,
			highlights,
			decimals,
			colorbarSourceKey: fieldView.pair ? JSON.stringify([colorbarOwner, contextKey, method, fieldView.pair.shape.id, fieldView.pair.mapping.id]) : undefined
		}),
		[
			p.context,
			method,
			fieldView.pair,
 calculationRanges,
			effectiveDisplay,
			generated,
			contribution,
			highlights,
			decimals,
			colorbarOwner,
			contextKey
		]
	);
	useEffect(() => {
		p.onProjection(p.active && p.available !== false ? projection : null);
	}, [projection, p.active, p.available, p.onProjection]);
	const accepted = useRef(new Set<string>());
	useEffect(() => {
		const completed: ReadonlyArray<
			readonly [
				InteractionGeneratedFields | InteractionContributions | undefined,
				"fields" | "contributions"
			]
		> = [
			...Object.values(records).map((record) => [record.generated, "fields"] as const),
			...Object.values(contributions).map((result) => [result, "contributions"] as const)
		];
		for (const [result, operation] of completed)
			if (result && !accepted.current.has(result.stamp.requestId)) {
				accepted.current.add(result.stamp.requestId);
				p.onResultAccepted?.(result.stamp.requestId, operation);
			}
	}, [records, contributions, p.onResultAccepted]);
	const hover = useCallback((key: string | null) => update({ hover: key }), [update]),
		toggle = useCallback(
			(key: string) =>
				update((before) => ({ ...before, pins: toggleAnalysisRow(before.pins, key) })),
			[update]
		);
	const releaseFields = useCallback(() => {
		setRecords((previous) =>
			Object.fromEntries(
				Object.entries(previous).map(([key, value]) => [key, { ...value, generated: undefined }])
			)
		);
		setStates((previous) =>
			Object.fromEntries(
				Object.entries(previous).map(([key, value]) => [
					key,
					{
						...value,
						slots: {
							field: { ...value.slots.field, field: null },
							mapping: { ...value.slots.mapping, field: null }
						}
					}
				])
			)
		);
		restoreAttempts.current.clear();
	}, []);
	const setColorbarLayout = useCallback((colorbarLayout: AnalysisColorbarLayout) => update(before => ({ ...before, display: { ...before.display, colorbarLayout: normalizeAnalysisColorbarLayout(colorbarLayout) } })), [update]);
	useEffect(() => {
		p.onInteractionReady?.({ hover, toggle, releaseFields, setColorbarLayout });
		return () => p.onInteractionReady?.(null);
	}, [hover, toggle, releaseFields, setColorbarLayout, p.onInteractionReady]);
	useEffect(() => {
		if (
			!p.active ||
			p.available === false ||
			state.input !== "internal" ||
			busy ||
			!record ||
			generated ||
			!p.bridge.restoreFields ||
			restoreAttempts.current.has(`${definitionKey}:${restoreRetry}`)
		)
			return;
		restoreAttempts.current.add(`${definitionKey}:${restoreRetry}`);
		void run("恢复已有显示格点", async (signal, requestId) => {
			const result = await p.bridge.restoreFields!(
				{ context: p.context, requestId, generationId: record.generationId },
				signal
			);
			if (!accept(signal)) return;
			assertStamp(result.stamp, requestId);
			validateInteractionGeneratedFields(result, { ...record.request, stamp: result.stamp });
			setRecords((previous) => ({
				...previous,
				[definitionKey]: { ...record, generated: result }
			}));
		});
	}, [
		definitionKey,
		record,
		generated,
		p.active,
		p.available,
		p.bridge.restoreFields,
		busy,
		restoreRetry,
		state.input
	]);
	useEffect(() => {
		const missing = (["field", "mapping"] as const).filter(
			(which) => !state.slots[which].field && state.slots[which].descriptor
		);
		const key = `external:${stateKey}:${missing.map((which) => state.slots[which].descriptor!.fieldId).join(":")}:${restoreRetry}`;
		if (
			!p.active ||
			p.available === false ||
			state.input !== "external" ||
			busy ||
			!missing.length ||
			!p.bridge.restoreCube ||
			restoreAttempts.current.has(key)
		)
			return;
		restoreAttempts.current.add(key);
		void run("恢复已有 Cube", async (signal, requestId) => {
			for (const which of missing) {
				const descriptor = state.slots[which].descriptor!;
				const field = await p.bridge.restoreCube!(
					{
						context: p.context,
						requestId,
						fieldId: descriptor.fieldId,
						sourceId: descriptor.sourceId,
						sourceRevision: descriptor.sourceRevision
					},
					signal
				);
				if (!accept(signal)) return;
				if (
					!sameSurfaceContext(field.context, p.context) ||
					field.id !== descriptor.fieldId ||
					field.source.id !== descriptor.sourceId ||
					field.source.revision !== descriptor.sourceRevision
				)
					throw Error("恢复格点与原始 artifact 身份不一致。");
				setStates((previous) => {
					const before = previous[stateKey] ?? state;
					return {
						...previous,
						[stateKey]: { ...before, slots: { ...before.slots, [which]: { field, descriptor } } }
					};
				});
			}
		});
	}, [
		stateKey,
		state.input,
		state.slots,
		p.active,
		p.available,
		p.bridge.restoreCube,
		busy,
		restoreRetry
	]);
	const tables = contribution
		? { atoms: interactionContributionTables(contribution, contributionDecimals.atoms, state.sort).atoms, pairs: interactionContributionTables(contribution, contributionDecimals.pairs, state.pairSort??{column:"identity",direction:"asc"}).pairs }
		: null;
	const table = (value: ScientificTableProjection, name: string, interactive = false) => (
		<>

			<ScientificDataTable
				title={interactive ? name.includes('-atoms.') ? '原子贡献' : '原子对贡献' : ''}
				onExport={() =>
					exportBlob(
						new Blob([scientificTableText(value)], { type: "text/plain;charset=utf-8" }),
						name,
						root.current?.ownerDocument
					)
				}
				projection={value}
                sorting={interactive?{value:(name.includes("-atoms.")?state.sort:state.pairSort??{column:"identity",direction:"asc"}).column,direction:(name.includes("-atoms.")?state.sort:state.pairSort??{column:"identity",direction:"asc"}).direction,options:[{value:"identity",label:"原子编号"},{value:"value",label:"δG"},{value:"percent",label:"占比"}],onChange:(column,direction)=>update(name.includes("-atoms.")?{sort:{column:column as InteractionContributionSort["column"],direction}}:{pairSort:{column:column as InteractionContributionSort["column"],direction}})}:undefined}
				format={interactive ? { decimals: name.includes('-atoms.') ? contributionDecimals.atoms : contributionDecimals.pairs, onDecimalsChange: decimals => setContributionDecimals(previous => ({ ...previous, [name.includes('-atoms.') ? 'atoms' : 'pairs']: decimals })), ariaLabel: name.includes('-atoms.') ? '原子贡献' : '原子对贡献' } : undefined}
				selectionScope={JSON.stringify([contextKey, name, interactive ? contributionKey : definitionKey, interactive ? contribution?.stamp.requestId : generated?.stamp.requestId])}
				activeRowKey={interactive ? state.current ?? undefined : undefined}
				onRowPreview={interactive ? row => hover(row?.key ?? null) : undefined}
				onRowActivate={interactive ? row => update({ current: row.key }) : undefined}
				onClearActive={interactive ? () => update({ current: null, hover: null }) : undefined}
				rowAction={interactive ? { label: row => `${state.pins.includes(row.key) ? "取消固定" : "固定"} ${row.cells[0]}`, active: row => state.pins.includes(row.key), onActivate: row => toggle(row.key), kind: "pin" } : undefined}
			/>
		</>
	);
	const exportField = (field: SurfaceScalarField | null) => {
    if(field&&isRestoredAnalysisData(field)&&field.source.kind!=='external-cube'){
      void run('导出 Cube',async signal=>{await exportSavedCube(field,'Ester-Studio-interaction.cube',{desktop:window.sciyueDesktop,signal});});
      return;
    }
		if (field && p.bridge.exportCube)
			void run("导出 Cube", async (signal,requestId) => {
				try{
					await p.bridge.exportCube!(field, signal,requestId);
					if(accept(signal))p.onResultAccepted?.(requestId,'export');
					else if(alive.current)p.onResultRejected?.(requestId,'export','cancelled');
				}catch(error){
					if(alive.current)p.onResultRejected?.(requestId,'export',signal.aborted||error instanceof Error&&error.name==='AbortError'?'cancelled':'failed',message(error));
					throw error;
				}
			});
	};
	const visibleRun = currentBusy ?? (lastRun?.owner === contextKey ? lastRun : null);
	const taskProgress =
		p.progress &&
		visibleRun &&
		p.progress.identity.runId === visibleRun.id &&
		p.progress.identity.sourceId === p.context.sourceId &&
		p.progress.identity.sourceRevision === p.context.sourceRevision &&
		p.progress.identity.jobIndex === p.context.jobIndex &&
		p.progress.identity.sourceFrameIndex === p.context.sourceFrameIndex &&
		p.progress.identity.generation === p.context.generation
			? p.progress
			: null;
	const sourceColors=state.display.color,paletteKey=JSON.stringify(sourceColors?.colors??null);
	const colors = useMemo(()=>sourceColors?{...sourceColors,colors:[...sourceColors.colors],zeroCentered:true}:null,[sourceColors?.min,sourceColors?.max,sourceColors?.reverse,paletteKey]);
	const scatterColorForX=useCallback((value:number)=>colors&&Number.isFinite(colors.min)&&Number.isFinite(colors.max)&&colors.min<colors.max?surfaceColor(value,colors):"#64748b",[colors]);
	const scatterColorLegend=useMemo(()=>colors&&Number.isFinite(colors.min)&&Number.isFinite(colors.max)&&colors.min<colors.max
		?{...colors,colors:colors.reverse?[...colors.colors].reverse():colors.colors}:undefined,[colors]);
	const gridPreview = useMemo(() => prepareCalculationRange(() => qualityTier === 'custom' && state.quality.mode !== 'spacing' && state.quality.mode !== 'dimensions'
		? surfaceGridPreview(state.quality, p.structure, 1.5, generated?.mapping.grid)
		: null), [qualityTier, state.quality, p.structure, generated?.mapping.grid]);
	const rangeIssue = actualRange.issue || plannedRange.issue || gridPreview.issue;
	const patchColors = (color: InteractionDisplaySettings['color']) => patchDisplay({ color });
	const scatterSnapshot = fieldView.scatter
		? {
				context: p.context,
				method,
				component: state.display.component,
				data: fieldView.scatter,
				xLabel: `sign(λ₂)ρ / ${mapping?.valueUnit ?? "单位未确认"}`,
				yLabel: `${INTERACTION_COMPONENT_LABELS[state.display.component]} / ${shape?.valueUnit ?? "单位未确认"}`,
				display: effectiveDisplay,
				decimals: scatterDecimals,
				analysisSourceKey:JSON.stringify(['interaction-scatter',contextKey,method,state.display.component,shape?.id,shape?.source.revision,mapping?.id,mapping?.source.revision])
			}
		: null;
	const colorControls = () => <InputSettingsRow>
    <div className="analysis-control-group">
		<InputSettingsField label="下限"><NumericInput aria-label="相互作用色标下限"  step="any" value={Number.isFinite(colors?.min) ? colors!.min : ''} onChange={event => patchColors({ min: event.currentTarget.valueAsNumber, max: colors?.max ?? NaN, colors: colors?.colors ?? ['#0000ff', '#00ff00', '#ff0000'], reverse: colors?.reverse })}/></InputSettingsField>
		<InputSettingsField label="上限"><NumericInput aria-label="相互作用色标上限"  step="any" value={Number.isFinite(colors?.max) ? colors!.max : ''} onChange={event => patchColors({ min: colors?.min ?? NaN, max: event.currentTarget.valueAsNumber, colors: colors?.colors ?? ['#0000ff', '#00ff00', '#ff0000'], reverse: colors?.reverse })}/></InputSettingsField>
    </div>
		{(!state.display.appearancePreset?.startsWith('gallery-'))&&<><InputSettingsField label="配色"><select aria-label="相互作用配色" value={JSON.stringify(colors?.colors ?? ['#0000ff', '#00ff00', '#ff0000'])} onChange={event => patchColors({ min: colors?.min ?? NaN, max: colors?.max ?? NaN, colors: JSON.parse(event.target.value), reverse: colors?.reverse })}>
			{colors&&!Object.values(ANALYSIS_PALETTES).some(value=>JSON.stringify(value)===JSON.stringify(colors.colors))&&JSON.stringify(colors.colors)!==JSON.stringify(['#0000ff','#00ff00','#ff0000'])&&<option value={JSON.stringify(colors.colors)} disabled>自定义色带</option>}<option value={JSON.stringify(['#0000ff', '#00ff00', '#ff0000'])}>蓝–绿–红</option>{Object.entries(ANALYSIS_PALETTES).map(([id, values]) => <option key={id} value={JSON.stringify(values)}>{id === 'blue-red' ? '蓝–白–红' : id === 'purple-green' ? '紫–白–绿' : 'Viridis'}</option>)}
		</select></InputSettingsField></>}
		{colors && <InputSettingsCheckbox label="反转色标" checked={!!colors.reverse} onChange={reverse => patchDisplay({ color: { ...colors, reverse }, appearancePreset: 'custom' })}/>}
	</InputSettingsRow>;
	return (
		<section
			ref={root}
			className="analysis-controls"
			aria-label="相互作用分析"
			data-testid="interaction-analysis-controls"
			data-interaction-method={method}
			data-interaction-state={
				currentBusy
					? currentBusy.stopping
						? "stopping"
						: "running"
					: fieldView.scatter
						? "fields-ready"
						: "idle"
			}
			data-source-id={p.context.sourceId}
			data-source-frame={p.context.sourceFrameIndex ?? ""}
		>
			{mcpPort}
			<InputSettingsLayout>
				{feedback}
				{failure?.owner === contextKey && <MultiwfnErrorNotice message={failure.value} identity={lastRun?.id}/>}

				<AnalysisTaskLayout variant="card" methodDetails plottingSections
					title="相互作用分析"
					onRestoreQuality={state.input === 'internal' ? () => { const defaults=initialState(method,p); update({quality:defaults.quality,qualityTier:defaults.qualityTier,showRange:defaults.showRange}); } : undefined}
					qualityDisabled={disabled}
					className="interaction-analysis-task"
					setup={
						<>
							<InputSettingsRow>
								<InputSettingsField label="方法">
									<select
										aria-label="相互作用方法"
										value={method}
										disabled={disabled}
										onChange={(event) => setMethod(event.target.value as InteractionMethod)}
									>
										{(["iri", "rdg", "igmh", "migm", "igm"] as const).map((value) => (
											<option value={value} key={value}>
												{INTERACTION_METHOD_LABELS[value]}
											</option>
										))}
									</select>
								</InputSettingsField>
							</InputSettingsRow>
							{state.input === "internal" &&
								!interactionUsesStructure(method) &&
								!p.wavefunctionAvailable && (
									<p className="postprocess-note">当前帧缺少匹配波函数。</p>
								)}
              {state.input === 'internal' && !interactionUsesStructure(method) && p.wavefunctionAvailable && !p.methods.includes(method) &&
                <p className="postprocess-note">当前波函数来源未通过此电子方法的适用性核验；结构 IGM/mIGM 仍可使用。</p>}
							{interactionHasFragments(method) && state.input === "internal" && (
								<div className="interaction-fragments" aria-label="片段">
									<SelectionGroupHeader title={`片段（${state.fragments.length}）`} actions={<SelectionAddButton label="添加片段" disabled={disabled} onClick={()=>update(before=>({...before,fragments:[...before.fragments,nextInteractionFragment(before.fragments)]}))}/>}/>
									{state.fragments.map((fragment) => (
										<div key={fragment.id}>
											{p.renderFragmentSelection?.({
												fragmentId: fragment.id,
												label: fragment.label,
												atomIds: fragment.atomIds,
												fragments: state.fragments,
												disabled,
												renderHeader: () => <SelectionGroupHeader title={`片段 ${fragment.label}`} actions={<SelectionRemoveButton label={`删除片段${fragment.label}`} disabled={disabled} onClick={() => {
                          update(before => ({ ...before, fragments: before.fragments.filter(row => row.id !== fragment.id) }));
                        }}/>}/>,
												onConfirm: (next, assertCurrent) => {
													assertCurrent();
													const current = latest.current;
													if (
														current.stateKey !== stateKey ||
														JSON.stringify(current.state.fragments) !==
															JSON.stringify(state.fragments)
													)
														throw Error("片段捕获已过期，请重新选择。");
													update({ fragments: next });
												}
											}) ?? <p className="postprocess-note">当前环境缺少公共原子选择接口。</p>}
										</div>
									))}
									{unassigned > 0 && (
										<p className="postprocess-note">未分配 {unassigned} 个原子。</p>
									)}
									{membershipError && <DismissibleNotice className="postprocess-note">{membershipError}</DismissibleNotice>}
								</div>
							)}
							{state.input === "external" && <DismissibleNotice role="alert">旧记录引用了外部 Cube；当前不再支持此输入，原文件保留。</DismissibleNotice>}
						</>
					}
					quality={
						state.input === "internal" ? (
							<>
								<CalculationQualityControl
									value={qualityTier}
									options={INTERACTION_QUALITY_OPTIONS}
									ariaLabel="相互作用网格质量"
									disabled={disabled}
									onChange={(tier) =>
										update({
											qualityTier: tier,
											quality: interactionQualityPreset(tier, state.quality, generated&&JSON.stringify(generated.quality)===JSON.stringify(state.quality)?generated.mapping.grid.dimensions:undefined)
										})
									}
								>
									{qualityTier === "custom" && (
										<InputSettingsField label="网格方式">
											<select
												aria-label="相互作用自定义网格方式"
												value={state.quality.mode === "dimensions" ? "dimensions" : "spacing"}
												disabled={disabled}
												onChange={(event) =>
													update({
														qualityTier: "custom",
														quality:
															event.target.value === "dimensions"
																? {
																		mode: "dimensions",
																		dimensions: generated&&JSON.stringify(generated.quality)===JSON.stringify(state.quality)
																			? [...generated.mapping.grid.dimensions]
																			: [NaN, NaN, NaN]
																	}
																: { mode: "spacing", spacingBohr: NaN }
													})
												}
											>
												<option value="spacing">格距</option>
												<option value="dimensions">XYZ 点数</option>
											</select>
										</InputSettingsField>
									)}
									{qualityTier === "custom" && state.quality.mode !== "dimensions" && (
										<InputSettingsField label={`${state.quality.mode==='spacing'?'格距':'预计格距'} / Bohr`}>
											<NumericInput
												aria-label="相互作用格距"
												aria-invalid={!!qualityIssue || undefined}

												step="any"
												min={0}
												value={state.quality.mode==='spacing'?Number.isFinite(state.quality.spacingBohr)?state.quality.spacingBohr:'':gridPreview.value?.spacingBohr?Number(gridPreview.value.spacingBohr.toPrecision(6)):''}
												disabled={disabled}
												onChange={(event) =>
													update({
														qualityTier: "custom",
														quality: {
															mode: "spacing",
															spacingBohr: event.currentTarget.valueAsNumber
														}
													})
												}
											/>
										</InputSettingsField>
									)}
									{qualityTier === "custom" && state.quality.mode === "dimensions" && (
										<div className="interaction-grid-dimensions">
											{(["X", "Y", "Z"] as const).map((axis, index) => (
												<InputSettingsField key={axis} label={axis}>
													<NumericInput
														aria-label={`相互作用${axis}点数`}

														min={2}
														step={1}
														disabled={disabled}
														value={
															Number.isFinite(
																state.quality.mode === "dimensions"
																	? state.quality.dimensions[index]
																	: NaN
															) && state.quality.mode === "dimensions"
																? state.quality.dimensions[index]
																: ""
														}
														onChange={(event) =>
															update((before) => {
																const dimensions: [number, number, number] =
																	before.quality.mode === "dimensions"
																		? [...before.quality.dimensions]
																		: [NaN, NaN, NaN];
																dimensions[index] = event.currentTarget.valueAsNumber;
																return {
																	...before,
																	qualityTier: "custom",
																	quality: { mode: "dimensions", dimensions }
																};
															})
														}
													/>
												</InputSettingsField>
											))}
										</div>
									)}
								</CalculationQualityControl>
								<CalculationRangeControl checked={state.showRange!==false} onChange={showRange=>update({showRange})} range={range}/>
								{qualityIssue ? <DismissibleNotice identity={stateKey}>{qualityIssue}</DismissibleNotice>
									: rangeIssue && <DismissibleNotice identity={stateKey}>相互作用范围暂无法显示。{rangeIssue}</DismissibleNotice>}
							</>
						) : undefined
					}
					actions={
						state.input === "internal" ? (
							<InputSettingsAction
								variant="primary"
								disabled={
									disabled ||
									!!membershipError ||
									!!qualityIssue ||
									(!interactionUsesStructure(method) && !p.wavefunctionAvailable) ||
									!p.methods.includes(method)
								}
								onClick={compute}
							>
								计算相互作用格点
							</InputSettingsAction>
						) : undefined
					}
					progress={
						<>
							<MultiwfnProgress
								progress={taskProgress}
								showFailureReason={!failure}
								operationLabel={visibleRun?.label ?? "相互作用"}
								onStop={cancel}
							/>
							{currentBusy && !taskProgress && (
								<InputSettingsRow>
									<output role="status">
										{currentBusy.stopping ? "正在停止" : currentBusy.label}
									</output>
									<InputSettingsAction disabled={currentBusy.stopping} onClick={cancel}>
										停止
									</InputSettingsAction>
								</InputSettingsRow>
							)}
						</>
					}
					plotting={
						shape && mapping ? <>
							{(
								<AnalysisTaskSection title="等值面" onRestore={() => { const base=initialInteractionDisplay(method,p.methodDefaults), saved=appearanceDefaults.snapshot?.value[`interaction:${method}`]; const next=saved && 'colors' in saved ? restoreInteractionAppearance(base,saved) : base; patchDisplay({visible:next.visible,opacity:next.opacity,color:next.color,finish:next.finish,appearancePreset:next.appearancePreset,colorbarLayout:undefined}); }}>
									<div className="interaction-surface-flow">
									<NumericPrecisionControl
										value={decimals}
										onChange={setDecimals}
										ariaLabel="相互作用显示小数位"
									/>
									<InputSettingsRow>
										{interactionComponents(method).length > 1 && (
											<InputSettingsField label="显示分量">
												<select
													aria-label="相互作用显示分量"
													value={state.display.component}
													onChange={(event) =>
														patchDisplay({
															component: event.target
																.value as InteractionDisplaySettings["component"]
														})
													}
												>
													{interactionComponents(method).map((component) => (
														<option value={component} key={component}>
															{INTERACTION_COMPONENT_LABELS[component]}
														</option>
													))}
												</select>
											</InputSettingsField>
										)}
										<InputSettingsField label={`等值 / ${shape?.valueUnit ?? "来源单位"}`}>
											<NumericInput
												stepper adaptiveStep={0.01} aria-label="相互作用等值"

												min={0}
												step="any"
												value={state.display.isovalue ?? ""}
												onChange={(event) =>
													patchDisplay({
														isovalue:
															event.currentTarget.value === ""
																? null
																: event.currentTarget.valueAsNumber
													})
												}
											/>
										</InputSettingsField>
										<InputSettingsCheckbox
											label="显示等值面"
											checked={state.display.visible}
											onChange={(visible) => patchDisplay({ visible })}
										/>
										<InputSettingsField label="透明度">
											<input
												aria-label="相互作用透明度"
												type="range"
												{...matchingSliderRange(state.display.opacity,.05,1,.05)}
												value={state.display.opacity}
												onChange={(event) =>
													patchDisplay({ opacity: event.currentTarget.valueAsNumber })
												}
											/>
											<NumericInput stepper adaptiveStep={0.1} aria-label="相互作用透明度数值"  min={.05} max={1} step={.05} value={state.display.opacity} onChange={event => { const opacity = event.currentTarget.valueAsNumber; if (Number.isFinite(opacity) && opacity >= .05 && opacity <= 1) patchDisplay({ opacity }); }}/>
										</InputSettingsField>
									</InputSettingsRow>
									<SurfaceAppearanceControls label="相互作用" presets={[interactionHasFragments(method)?'igmh':'iri']} value={state.display.appearancePreset} onChange={id=>patchDisplay(interactionAppearance(state.display,id))} actions={<SaveSurfaceAppearanceDefault family={`interaction:${method}`} appearance={captureInteractionAppearance(state.display)}/>}><MeshFinishControls
										labelPrefix="相互作用"
										value={state.display.finish}
										onChange={(finish) => patchDisplay({ finish })}
									/></SurfaceAppearanceControls>
									</div>
									<InputSettingsRow>
										<InputSettingsAction
											disabled={!shape || !p.bridge.exportCube}
											onClick={() => exportField(shape)}
										>
											导出方法格点 Cube
										</InputSettingsAction>
										<InputSettingsAction
											disabled={!mapping || !p.bridge.exportCube}
											onClick={() => exportField(mapping)}
										>
											导出着色 Cube
										</InputSettingsAction>
									</InputSettingsRow>
									{shape && state.display.isovalue === null && (
										<p className="postprocess-note">请明确当前方法的等值。</p>
									)}
									<div className="field-colorbar-settings" aria-label="色标">{colorControls()}
									<AnalysisColorbarLayoutControls
										layout={state.display.colorbarLayout}
										onChange={setColorbarLayout}
										colorbar={interactionSurfaceColorbar(projection)}
										disabled={p.available === false}
										palette={colors ? { ...colors, labelPrefix: '相互作用', onChange: next => patchDisplay({ color: { ...colors, colors: next }, appearancePreset: 'custom' }) } : undefined}
									/>
									</div>
								</AnalysisTaskSection>
							)}
							{(
								<AnalysisTaskSection title="散点图">
									{colorControls()}
									<NumericPrecisionControl
										value={scatterDecimals}
										onChange={setScatterDecimals}
										ariaLabel="相互作用散点小数位"
									/>
									{scatterSnapshot ? (
										<>
											{p.onOpenScatter && <InputSettingsAction variant="surface" onClick={() => p.onOpenScatter?.(scatterSnapshot)}>在独立图窗打开</InputSettingsAction>}
											<ScientificScatterPlot
                                                appearanceKey={`interaction-scatter:${contextKey}:${method}:${state.display.component}`}
												title={`${INTERACTION_METHOD_LABELS[method]} · ${INTERACTION_COMPONENT_LABELS[state.display.component]}`}
												xLabel={scatterSnapshot.xLabel}
												yLabel={scatterSnapshot.yLabel}
												data={scatterSnapshot.data}
												colorForX={scatterColorForX}
												colorLegend={scatterColorLegend}
												decimals={scatterDecimals}
												pointSize={state.display.scatterPointSize}
												opacity={state.display.scatterOpacity}
												viewport={state.display.scatterViewport}
												initialViewport={interactionScatterInitialViewport(
													method,
													state.display.component
												)}
												onViewportChange={(scatterViewport) => patchDisplay({ scatterViewport })}
												resetKey={
													state.input === "external" ? `${shape?.id}:${mapping?.id}` : definitionKey
												}
											/>
										</>
									) : (
										<p className="postprocess-note">请先计算格点或载入匹配的成对 Cube。</p>
									)}
								</AnalysisTaskSection>
							)}
						</> : <><AnalysisTaskSection title="等值面" onRestore={() => { const base=initialInteractionDisplay(method,p.methodDefaults), saved=appearanceDefaults.snapshot?.value[`interaction:${method}`]; const next=saved && 'colors' in saved ? restoreInteractionAppearance(base,saved) : base; patchDisplay({visible:next.visible,opacity:next.opacity,color:next.color,finish:next.finish,appearancePreset:next.appearancePreset,colorbarLayout:undefined}); }}><p className="postprocess-note">尚未生成等值面。</p></AnalysisTaskSection><AnalysisTaskSection title="散点图"><p className="postprocess-note">尚未生成散点数据。</p></AnalysisTaskSection></>
					}
				>
					{fieldView.error && <DismissibleNotice role="alert">{fieldView.error}</DismissibleNotice>}
					{!record &&
						Object.values(records).some(
							(value) =>
								value.request.method === method &&
								surfaceContextKey(value.request.context) === contextKey
						) && <p className="postprocess-note">当前定义尚未计算；已完成的旧定义仍保留。</p>}
					{record && !generated && (
						<InputSettingsRow>
							<output role="status">显示格点已释放，可只读恢复。</output>
							<InputSettingsAction
								disabled={disabled || !p.bridge.restoreFields}
								onClick={() => setRestoreRetry((value) => value + 1)}
							>
								恢复已有显示格点
							</InputSettingsAction>
						</InputSettingsRow>
					)}

					{!!generated?.integrals.length && <AnalysisTaskSection title="整体积分">{table(interactionIntegralTable(generated, decimals), 'Ester-Studio-interaction-integrals.txt')}</AnalysisTaskSection>}
					{interactionHasContributions(method) && (
						<AnalysisTaskSection title="原子与原子对贡献">
							<AnalysisTaskLayout
								onRestoreQuality={state.input === 'internal' ? () => update({integrationQuality:initialState(method,p).integrationQuality}) : undefined}
								qualityDisabled={disabled}
								setup={
									<InputSettingsRow>
										{([0, 1] as const).map((index) => (
											<InputSettingsField key={index} label={`片段 ${index ? "B" : "A"}`}>
												<select
													aria-label={`贡献片段${index ? "B" : "A"}`}
													value={state.pair[index]}
													disabled={disabled}
													onChange={(event) =>
														update((before) => ({
															...before,
															pair: index
																? [before.pair[0], event.target.value]
																: [event.target.value, before.pair[1]]
														}))
													}
												>
													{state.fragments.map((fragment) => (
														<option value={fragment.id} key={fragment.id}>
															{fragment.label}
														</option>
													))}
												</select>
											</InputSettingsField>
										))}
									</InputSettingsRow>
								}
								quality={
									<InputSettingsField label="积分精度">
										<select
											aria-label="积分精度" title="粗糙：40×170；中等：60×302；精细：75×434（径向×角向点数）"
											value={state.integrationQuality}
											disabled={disabled}
											onChange={(event) =>
												update({ integrationQuality: Number(event.target.value) as 2 | 3 | 4 })
											}
										>
											<option value={2}>粗糙</option>
											<option value={3}>中等</option>
											<option value={4}>精细</option>
										</select>
									</InputSettingsField>
								}
								actions={
									<InputSettingsAction
										variant="primary"
										disabled={
											disabled ||
											state.input === "external" ||
											(method !== "migm" && !p.wavefunctionAvailable) ||
											!p.methods.includes(method) ||
											!p.bridge.contributions ||
											!!membershipError
										}
										onClick={computeContributions}
									>
										计算原子与原子对贡献
									</InputSettingsAction>
								}
							>
								{state.input === "external" && (
									<p className="postprocess-note">外部格点仅用于绘图，不能补算原子贡献。</p>
								)}
								{tables && (
									<>
										{table(tables.atoms, "Ester-Studio-interaction-atoms.txt", true)}
										{table(tables.pairs, "Ester-Studio-interaction-pairs.txt", true)}
									</>
								)}
							</AnalysisTaskLayout>
						</AnalysisTaskSection>
					)}
					{(generated?.provenance ?? contribution?.provenance)?.notices.map((notice, index) => <p key={index} className="postprocess-note">{notice}</p>)}
				</AnalysisTaskLayout>
			</InputSettingsLayout>
		</section>
	);
}

export default function InteractionAnalysisControls(p: Parameters<typeof InteractionAnalysisControlsInner>[0]) {
  const project=useProjectUiScope();
  return project?<ProjectUiScope scope={['InteractionAnalysisControls',projectUiSourceIdentity(p)]}><ProjectNativeDetailsBoundary><InteractionAnalysisControlsInner {...p}/></ProjectNativeDetailsBoundary></ProjectUiScope>:InteractionAnalysisControlsInner(p);
}
