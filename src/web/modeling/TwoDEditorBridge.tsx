import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Editor } from "ketcher-react";
import { fromNewCanvas, type Ketcher } from "ketcher-core";
import "ketcher-react/dist/index.css";
import {
	parseKetDraft,
	parseTwoDDraft,
	remainingTwoDSourceIssues,
	twoDComponentFormalCharge
} from "../../modeling/two-d";
import type { TwoDCommitData, TwoDDraft, TwoDSourceInput } from "../../modeling/two-d";
import {prepareTwoDAssembly,type TwoDAssemblyInput} from '../../modeling/application/two-d-assembly';
import { calculateGeometryCip, createTwoDEditorProvider, twoDIndigoConverter } from "./two-d-editor-service";
import { deriveTwoDCipResult, paintTwoDBoardLabels, type TwoDCipLabel, type TwoDCipResult } from "./two-d-board-display";
import "./two-d-editor-ui.css";
import { ScientificImageCopyButton } from "../ScientificImageCopyButton";
import { captureTwoDBoardPng } from "./two-d-image-copy";
import TwoDInteractionLayer, { TwoDIcon } from "./TwoDInteractionLayer";
import { TwoDSourceOperation } from "./two-d-source-operation";
import {
	canonicalizeTwoDSource,
	nativeEditorApi,
	performTwoDHistory,
	fitTwoDSourceViewport,
	zoomTwoDViewport
} from "./two-d-ketcher-api";
import { normalizeTwoDDisplayKet, assertTwoDSelectedGraph } from "./two-d-display-normalization";
import TwoDPreviewSplit from './TwoDPreviewSplit';

export interface TwoDEditorSnapshot {
	documentKey?: string;
	ket: string;
	revision: number;
	hasContent: boolean;
	dirty: boolean;
	source?: TwoDSourceInput;
	sourceMetadata?: unknown;
}
export interface TwoDEditorRuntime {
	getSnapshot(): Promise<TwoDEditorSnapshot>;
	applyKet(ket:string, expectedRevision:number, assertCurrent:()=>void): Promise<TwoDEditorSnapshot>;
	history(direction:'undo'|'redo', expectedRevision:number): Promise<TwoDEditorSnapshot>;
	prepareGeneration(expectedRevision:number): Promise<{assembly:TwoDAssemblyInput;commit:TwoDCommitData;editorSnapshot:TwoDEditorSnapshot}>;
	readonly ready:boolean;
	stereochemistry(expectedRevision:number,shown?:boolean,retry?:boolean):Promise<{revision:number;shown:boolean;labels:TwoDCipLabel[];errors:string[];status:string}>;
	readonly revision: number;
	readonly hasContent: boolean;
	cancelGesture(): void;
	replaceSource(
		source: TwoDSourceInput,
		options?: { history?: "reset" | "append"; metadata?: unknown; expectedRevision?: number; preserveGesture?:boolean; assertCurrent?:()=>void; stillCurrent?:()=>boolean }
	): Promise<boolean>;
}
/** Captured synchronously by the generating click, before editor serialization. */
export type TwoDGenerationGuard = (()=>void)&{target?:{kind:'new'}|{kind:'replace';documentId:string;revision:number}};

interface Props {
	busy: boolean;
	initialSource?: TwoDSourceInput;
	sourceName?: string;
	onGenerate(assembly: TwoDAssemblyInput, draft?: TwoDCommitData, snapshot?: TwoDEditorSnapshot, guard?: TwoDGenerationGuard): void;
	onAssembly?(assembly:TwoDAssemblyInput, draft:TwoDCommitData, snapshot:TwoDEditorSnapshot):void;
	previewEnabled?:boolean;
	onPreviewEnabledChange?(enabled:boolean):void;
	previewPanel?:ReactNode;
	captureGenerationGuard?(): TwoDGenerationGuard;
	onClose(): void;
	onError(message: string): void;
	onImportFiles?(files: File[]): void;
	onRecognizeImage?(file: File): void;
	sourcePanel?: ReactNode;
	status?: string;
	onStop?(): void;
	onDirtyChange?(dirty: boolean): void;
	visible?: boolean;
	editingDisabled?: boolean;
	onRuntime?(runtime: TwoDEditorRuntime | null): void;
	onSnapshot?(snapshot: TwoDEditorSnapshot): void;
	imageAccept?: string;
	documentKey?: string;
}
const hidden = { hidden: true };
// These four names are supported by Ketcher 3.18's runtime action registry and
// toolbar hiddenButtons, although its published ButtonName union omits them.
const buttons = {
	open: hidden,
	save: hidden,
	undo: hidden,
	redo: hidden,
	recognize: hidden,
	miew: hidden,
	"reaction-plus": hidden,
	arrows: hidden,
	"reaction-mapping-tools": hidden,
	rgroup: hidden,
	sgroup: hidden,
	"sgroup-data": hidden,
	"create-monomer": hidden,
	shape: hidden,
	"shape-ellipse": hidden,
	"shape-rectangle": hidden,
	"shape-line": hidden,
	text: hidden,
	help: hidden,
	fullscreen: hidden
};
const emptyKet = JSON.stringify({ root: { nodes: [] } });
const showRsByWindow = new WeakMap<Document,boolean>();
function emptyDraft(sourceId: string, ket = emptyKet): TwoDDraft {
	return parseKetDraft(ket, { sourceId, allowEmpty: true });
}

/** Ketcher owns the only 2D history. Formal document transactions belong to the caller. */
export default function TwoDEditorBridge({
	busy,
	initialSource,
	sourceName,
	onGenerate,
	onAssembly,
	previewEnabled=false,
	onPreviewEnabledChange,
	previewPanel,
	captureGenerationGuard,
	onClose,
	onError,
	onImportFiles,
	onRecognizeImage,
	sourcePanel,
	status,
	onStop,
	onDirtyChange,
	visible = true,
	editingDisabled = busy,
	onRuntime,
	onSnapshot,
	imageAccept = "image/png,image/jpeg,image/bmp,image/tiff,image/webp,image/gif",
	documentKey
}: Props) {
	const [provider] = useState(createTwoDEditorProvider);
	const [editor, setEditor] = useState<Ketcher | null>(null);
	const [showRS,setShowRS]=useState(()=>showRsByWindow.get(document)??false);
	const showRSRef=useRef(showRS);
	const visibleRef=useRef(visible);visibleRef.current=visible;
	const cipJob=useRef<{ket:string;revision:number;controller:AbortController;promise:Promise<TwoDCipResult|undefined>;labels?:TwoDCipLabel[]} | null>(null);
	const [cipFailures,setCipFailures]=useState<string[]>([]);
	const [nativeReadyEpoch, setNativeReadyEpoch] = useState(0);
	const [sourceEpoch, setSourceEpoch] = useState(0);
	const [sourceVisibility, setSourceVisibility] = useState<{ key?: string; hidden: boolean }>({
		hidden: false
	});
	const sourceHidden = sourceVisibility.key === documentKey && sourceVisibility.hidden;
	// With macromolecules disabled Ketcher first publishes the micro editor,
	// then publishes the same Ketcher object again when CoreEditor is ready.
	// Keep this lifecycle signal separate from source loading and graph history.
	const acceptNativeInit = useCallback((value: Ketcher) => {
		setEditor(value);
		setNativeReadyEpoch((previous) => previous + 1);
	}, []);
	const [draftState,setDraft] = useState<{draft:TwoDDraft;revision:number}|null>(null);
	const draft=draftState?.draft;
	const [loading, setLoading] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [history, setHistory] = useState({ undo: 0, redo: 0 });
	const source = useRef<TwoDDraft | null>(null);
	const editorBaseline = useRef<TwoDDraft | null>(null);
	const originalKet = useRef(emptyKet);
	const revision = useRef(0);
	const session = useRef(0);
	const mounted = useRef(true);
	const loadingRef = useRef(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const imageInput = useRef<HTMLInputElement>(null);
	const latest = useRef({ onError, onGenerate, captureGenerationGuard });
	latest.current = { onError, onGenerate, captureGenerationGuard };
	const manualId = useRef(crypto.randomUUID());
	const sourceDocumentKey = useRef<string | undefined>(undefined);
	const sourceInput = useRef<TwoDSourceInput | undefined>(undefined),
		sourceMetadata = useRef<unknown>(undefined),
		hasContent = useRef(false);
	const cancelGesture = useRef<(() => void) | null>(null);
	const activeEdit = useRef<(() => boolean) | undefined>(undefined);
	const snapshotCallback = useRef(onSnapshot);
	snapshotCallback.current = onSnapshot;
	const registerCancel = useCallback((cancel: (() => void) | null, isEditing?:()=>boolean) => {
		cancelGesture.current = cancel;
		activeEdit.current = isEditing;
	}, []);
	const getRevision = useCallback(() => revision.current, []);
	function discardCip() {
		cipJob.current?.controller.abort();cipJob.current=null;
		setCipFailures([]);
		if(editor)paintTwoDBoardLabels(editor,[]);
	}
	function setStereoVisibility(checked:boolean,owner:Document){
		showRsByWindow.set(owner,checked);showRSRef.current=checked;setShowRS(checked);if(!checked)discardCip();
	}
	function boardCip(ket:string,expected:number,retry=false) {
		const current=cipJob.current;
		if(!retry&&current?.ket===ket&&current.revision===expected)return current.promise;
		current?.controller.abort();
		const controller=new AbortController();
		const job:NonNullable<typeof cipJob.current>={ket,revision:expected,controller,promise:Promise.resolve(undefined),labels:retry&&current?.revision===expected?current.labels:undefined};
		cipJob.current=job;
		setCipFailures([]);
		job.promise=deriveTwoDCipResult(ket,calculateGeometryCip,controller.signal).catch(error=>({
			labels:[],failures:[error instanceof Error?error.message:String(error)]
		})).then(({labels,failures})=>{
			if(cipJob.current!==job||controller.signal.aborted||!showRSRef.current||!visibleRef.current||revision.current!==expected)return;
			job.labels=labels;
			setCipFailures(failures);
			if(editor)paintTwoDBoardLabels(editor,labels);
			return {labels,failures};
		});
		return job.promise;
	}
	const snapshot = (ket: string): TwoDEditorSnapshot => ({
		documentKey: sourceDocumentKey.current,
		ket,
		revision: revision.current,
		hasContent: hasContent.current,
		dirty: ket !== originalKet.current,
		source: sourceInput.current,
		sourceMetadata: sourceMetadata.current
	});
	const sourceState = () => ({
		draft: source.current,
		baseline: editorBaseline.current,
		input: sourceInput.current,
		metadata: sourceMetadata.current,
		originalKet: originalKet.current
	});
	const restoreSource = (value: ReturnType<typeof sourceState>) => {
		source.current = value.draft;
		editorBaseline.current = value.baseline;
		sourceInput.current = value.input;
		sourceMetadata.current = value.metadata;
		originalKet.current = value.originalKet;
	};
	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			session.current++;
			cipJob.current?.controller.abort();cipJob.current=null;
			provider.dispose();
		};
	}, [provider]);
	useEffect(() => {
		if (!editor) return;
		let active = true;
		let sequence = 0;
		const update = async () => {
			if (loadingRef.current) return;
			const request = ++sequence;
			revision.current++;
			discardCip();
			try {
				const ket = await editor.getKet();
				if (!active || request !== sequence || loadingRef.current) return;
				setHistory(nativeEditorApi(editor).historySize());
				const sourceId = source.current?.source.id ?? manualId.current;
				const next = parseKetDraft(ket, {
					sourceId,
					filename: source.current?.source.name,
					allowEmpty: true
				});
				hasContent.current = next.components.some((c) => c.atoms.length > 0);
				setDraft({draft:next,revision:revision.current});
				setDirty(ket !== originalKet.current);
				snapshotCallback.current?.(snapshot(ket));
			} catch (error) {
				if (active) latest.current.onError(error instanceof Error ? error.message : String(error));
			}
		};
		const subscriber = editor.editor.subscribe("change", update);
		return () => {
			active = false;
			editor.editor.unsubscribe("change", subscriber);
		};
	}, [editor]);

	useEffect(() => {
		if (!editor) return;
		const controller = new AbortController();
		const epoch = ++session.current;
		cancelGesture.current?.();
		discardCip();
		loadingRef.current = true;
		setLoading(true);
		void (async () => {
			const next = initialSource
				? await parseTwoDDraft(initialSource.data, {
						sourceId: initialSource.id,
						filename: initialSource.name,
						indigo: twoDIndigoConverter,
						signal: controller.signal
					})
				: emptyDraft(documentKey ?? manualId.current);
			if (controller.signal.aborted || epoch !== session.current) return;
			const display = normalizeTwoDDisplayKet(next.ket);
			// Load the already-decided KET representation directly. setMolecule
			// may invoke upstream on-load chemistry settings; a failed reliable
			// conversion must remain the original restricted graph.
			const prepared = await canonicalizeTwoDSource(editor, display.ket);
			if (controller.signal.aborted || epoch !== session.current) return;
			editor.editor.selection(null);
			editor.editor.update(fromNewCanvas(editor.editor.render.ctab, prepared.struct));
			setSourceEpoch((value) => value + 1);
			if (initialSource) fitTwoDSourceViewport(editor);
			if (controller.signal.aborted || epoch !== session.current) return;
			originalKet.current = await editor.getKet();
			editorBaseline.current = parseKetDraft(originalKet.current, {
				sourceId: next.source.id,
				filename: next.source.name,
				allowEmpty: true
			});
			editor.editor.clearHistory();
			source.current = next;
			setDirty(false);
			setHistory({ undo: 0, redo: 0 });
			sourceInput.current = initialSource;
			sourceDocumentKey.current = documentKey;
			sourceMetadata.current = undefined;
			hasContent.current = next.components.some((c) => c.atoms.length > 0);
			revision.current++;
			setDraft({draft:editorBaseline.current,revision:revision.current});
			snapshotCallback.current?.(snapshot(originalKet.current));
			if (display.restriction) latest.current.onError(display.restriction);
		})()
			.catch((error) => {
				if (!controller.signal.aborted)
					latest.current.onError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (!controller.signal.aborted && epoch === session.current) {
					loadingRef.current = false;
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [editor, initialSource?.id, documentKey]);
	useEffect(()=>{
		if(!editor)return;
		const svg=editor.editor.render.paper.canvas;
		if(!svg)return;
		const repaint=()=>{const job=cipJob.current;paintTwoDBoardLabels(editor,showRSRef.current&&job?.revision===revision.current?job.labels??[]:[]);};
		const observer=new MutationObserver(records=>{
			if(records.some(r=>!(r.target as Element).closest?.('[data-two-d-derived-labels]')))repaint();
		});
		observer.observe(svg,{childList:true,subtree:true,attributes:true,attributeFilter:['viewBox']});
		repaint();
		return()=>{observer.disconnect();svg.querySelector('[data-two-d-derived-labels]')?.remove();};
	},[editor,nativeReadyEpoch]);
	useEffect(()=>{
		if(!editor||!showRSRef.current||!visibleRef.current){discardCip();return;}
		if(!draftState?.draft.components.length)return;
		const {revision:expected,draft:{ket}}=draftState;
		const timer=setTimeout(()=>{if(revision.current===expected&&showRSRef.current&&visibleRef.current)void boardCip(ket,expected);},90);
		return()=>clearTimeout(timer);
	},[editor,draftState,showRS,visible]);

	useEffect(() => {
		if (!visible) cancelGesture.current?.();
	}, [visible]);
	useEffect(() => {
		if (!editor) {
			onRuntime?.(null);
			return;
		}
		function assertEditable(expected:number,epoch:number){
			if(!mounted.current||loadingRef.current||session.current!==epoch)throw Error('二维编辑器尚未就绪或会话已切换。');
			if(revision.current!==expected)throw Error('二维草稿版本已变化，请重新读取。');
			if(activeEdit.current?.())throw Error('二维编辑器正在处理手势或原子标签编辑。');
		}
		async function readSnapshot(){
			const expected=revision.current,epoch=session.current;
			if(loadingRef.current)throw Error('二维编辑器正在载入草稿。');
			const ket=await editor!.getKet();
			if(!mounted.current||session.current!==epoch||revision.current!==expected)throw Error('二维草稿在读取期间发生变化。');
			const content=parseKetDraft(ket,{sourceId:source.current?.source.id??manualId.current,allowEmpty:true}).components.length>0;
			return {...snapshot(ket),hasContent:content};
		}
		const runtime: TwoDEditorRuntime = {
			get ready(){return mounted.current&&!loadingRef.current;},
			async stereochemistry(expected,shown,retry){
				const epoch=session.current;assertEditable(expected,epoch);
				const draft=await readSnapshot();assertEditable(expected,epoch);
				if(shown!==undefined)setStereoVisibility(shown,editor.editor.render.paper.canvas.ownerDocument);
				if(!showRSRef.current)return {revision:expected,shown:false,labels:[],errors:[],status:'hidden'};
				if(!draft.hasContent)return {revision:expected,shown:true,labels:[],errors:[],status:'empty'};
				const result=await boardCip(draft.ket,expected,retry);assertEditable(expected,epoch);
				if(!showRSRef.current)return {revision:expected,shown:false,labels:[],errors:[],status:'hidden'};
				if(!result||!visibleRef.current)return {revision:expected,shown:true,labels:[],errors:[],status:'superseded'};
				const {labels,failures:errors}=result;
				return {revision:expected,shown:true,labels,errors,status:errors.length?(labels.length?'partial':'failed'):'ready'};
			},
			get revision() {
				return revision.current;
			},
			get hasContent() {
				return hasContent.current;
			},
			cancelGesture() {
				cancelGesture.current?.();
			},
			getSnapshot:readSnapshot,
			async applyKet(ket,expected,assertCurrent){
				const epoch=session.current;assertEditable(expected,epoch);
				parseKetDraft(ket,{sourceId:source.current?.source.id??manualId.current,allowEmpty:true});
				const display=normalizeTwoDDisplayKet(ket);
				if(display.restriction)throw Error(display.restriction);
				const canonical=await canonicalizeTwoDSource(editor,display.ket);
				const before=await readSnapshot();assertCurrent();assertEditable(expected,epoch);
				if(before.ket===canonical.ket)return before;
				editor.editor.update(fromNewCanvas(editor.editor.render.ctab,canonical.struct));
				fitTwoDSourceViewport(editor);
				return readSnapshot();
			},
			async history(direction,expected){
				assertEditable(expected,session.current);
				setHistory(performTwoDHistory(editor,direction));
				return readSnapshot();
			},
			async prepareGeneration(expected){
				const epoch=session.current;assertEditable(expected,epoch);
				const current=await readSnapshot();assertEditable(expected,epoch);
				if(!current.hasContent)throw Error('请先绘制分子。');
				return assemblyDraft(parseKetDraft(current.ket,{sourceId:source.current?.source.id??manualId.current,allowEmpty:true}));
			},
			async replaceSource(input, options = {}) {
				const expected = options.expectedRevision ?? revision.current;
				const epoch = session.current;
				const next = await parseTwoDDraft(input.data, {
					sourceId: input.id,
					filename: input.name,
					indigo: twoDIndigoConverter
				});
				// Capture the serializer's actual representation before committing.
				// Raw OCR/import KET can differ in ordering, defaults and formatting.
				// This is prepared state in the native source operation, never a
				// post-commit mutation of the action or its inverse.
				const display = normalizeTwoDDisplayKet(next.ket);
				const { struct, ket: canonicalKet } = await canonicalizeTwoDSource(editor, display.ket);
				if (!mounted.current || epoch !== session.current || expected !== revision.current)
					return false;
				options.assertCurrent?.();
				if(options.stillCurrent&&!options.stillCurrent())return false;
				if(options.preserveGesture&&activeEdit.current?.())return false;
				cancelGesture.current?.();
				const baseline = parseKetDraft(canonicalKet, {
					sourceId: next.source.id,
					filename: next.source.name,
					allowEmpty: true
				});
				const metadata = {
					draft: next,
					baseline,
					input,
					metadata: options.metadata,
					originalKet: canonicalKet
				};
				editor.editor.selection(null);
				const action = fromNewCanvas(editor.editor.render.ctab, struct);
				action.addOp(new TwoDSourceOperation(sourceState, restoreSource, metadata).perform());
				editor.editor.update(action);
				setSourceEpoch((value) => value + 1);
				fitTwoDSourceViewport(editor);
				if (display.restriction) latest.current.onError(display.restriction);
				if (options.history === "reset") {
					editor.editor.clearHistory();
					setHistory({ undo: 0, redo: 0 });
					setDirty(false);
				}
				return true;
			}
		};
		onRuntime?.(runtime);
		return () => onRuntime?.(null);
	}, [editor, onRuntime]);
	function assemblyDraft(current:TwoDDraft) {
		const edited=current.ket!==originalKet.current;
		const assembly=prepareTwoDAssembly(current,{name:source.current?.source.name??'drawing',sourceIssues:component=>{
			const issues=source.current?remainingTwoDSourceIssues({sourceDraft:source.current,editorBaselineDraft:editorBaseline.current,currentComponent:component,edited}):[];
			try{assertTwoDSelectedGraph(component.ket);}catch(error){issues.push({code:'invalid-visible-graph',severity:'blocking',message:error instanceof Error?error.message:String(error),scope:'component',componentIds:[component.id]});}
			return issues;
		}});
		const commit:TwoDCommitData={source:source.current?.source??current.source,selectedComponentId:`${current.source.id}:all`,selectedComponentIds:assembly.selectedComponentIds,originalKet:source.current?.ket??emptyKet,finalKet:current.ket,finalGraph:assembly.finalGraph,issues:assembly.issues,edited};
		return {assembly,commit,editorSnapshot:snapshot(current.ket)};
	}
	useEffect(()=>{
		if(!draft||loading||!onAssembly)return;
		try{const prepared=assemblyDraft(draft);onAssembly(prepared.assembly,prepared.commit,prepared.editorSnapshot);}catch(error){latest.current.onError(error instanceof Error?error.message:String(error));}
	},[draft,loading,onAssembly]);
	async function generate() {
		if (!editor || loading || busy) return;
		const epoch = session.current;
		const expectedRevision = revision.current;
		cancelGesture.current?.();
		setLoading(true);
		try {
			const ownerGuard = latest.current.captureGenerationGuard?.();
			ownerGuard?.();
			const ket = await editor.getKet();
			if (!mounted.current || epoch !== session.current || expectedRevision !== revision.current)
				return;
			ownerGuard?.();
			const current = draft?.ket===ket?draft:parseKetDraft(ket, {
				sourceId: source.current?.source.id ?? manualId.current,
				allowEmpty: true
			});
			if(!current.components.length)throw new Error('请先绘制分子。');
			const prepared=assemblyDraft(current);
			if (!mounted.current || epoch !== session.current) return;
			latest.current.onGenerate(
				prepared.assembly,prepared.commit,prepared.editorSnapshot,
				ownerGuard
			);
		} catch (error) {
			if (mounted.current && epoch === session.current)
				latest.current.onError(error instanceof Error ? error.message : String(error));
		} finally {
			if (mounted.current && epoch === session.current) setLoading(false);
		}
	}
	const visibleIssues = draft?.issues.filter((issue) => issue.code !== "invalid-valence") ?? [];
	const canvasAtomCount=draft?.components.reduce((total,component)=>total+component.atoms.filter(atom=>!atom.sourceProperties.generatedFromImplicitH).length,0)??0;
	const charges=draft?.components.map(component=>{const issues=source.current?remainingTwoDSourceIssues({sourceDraft:source.current,editorBaselineDraft:editorBaseline.current,currentComponent:component,edited:draft.ket!==originalKet.current}):[];return twoDComponentFormalCharge({...component,issues:[...component.issues,...issues]});})??[];
	const charge=charges.length&&charges.every(value=>value!==null)?charges.reduce<number>((sum,value)=>sum+(value??0),0):null;
	return (
		<section
			className="model-plane-window two-d-editor-window"
			role="dialog"
			aria-label="临时二维绘图"
			data-testid="model-2d-window"
			hidden={!visible}
			style={!visible ? { display: "none" } : undefined}
			onKeyDown={(event) => event.stopPropagation()}
			onKeyUp={(event) => event.stopPropagation()}
			onKeyDownCapture={(event) => {
				if ((event.ctrlKey || event.metaKey) && ["o", "s", "m"].includes(event.key.toLowerCase())) {
					event.preventDefault();
					event.stopPropagation();
					if (event.key.toLowerCase() === "o" && !busy && !loading && onImportFiles)
						fileInput.current?.click();
				}
			}}
			onDragOverCapture={(event) => {
				if (event.dataTransfer.types.includes("Files")) {
					event.preventDefault();
					event.stopPropagation();
				}
			}}
			onDropCapture={(event) => {
				if (event.dataTransfer.files.length) {
					event.preventDefault();
					event.stopPropagation();
					const files = Array.from(event.dataTransfer.files);
					if (!busy && !loading && onImportFiles) onImportFiles(files);
				}
			}}
		>
			<header>
				<strong>二维建模</strong>
				<span>
					来源：{sourceInput.current?.name ?? sourceName ?? initialSource?.name ?? "手动绘制"}
					{dirty ? " · 已修改" : ""}
				</span>
				{busy && onStop && <button onClick={onStop}>停止</button>}
				<button
					onClick={() => {
						cancelGesture.current?.();
						onClose();
					}}
					aria-label="关闭二维绘图"
				>
					×
				</button>
			</header>
			<div
				className="two-d-editor-actions"
				data-history-undo={history.undo}
				data-history-redo={history.redo}
			>
				<button
					title="导入文件"
					aria-label="导入文件"
					disabled={!onImportFiles || busy || loading}
					onClick={() => fileInput.current?.click()}
				>
					<TwoDIcon name="open" />
				</button>
				<button
					title="从图片识别"
					aria-label="从图片识别"
					disabled={!onRecognizeImage || busy || loading}
					onClick={() => imageInput.current?.click()}
				>
					<TwoDIcon name="image" />
				</button>
				<button
					title="撤销（Ctrl+Z）"
					aria-label="撤销"
					disabled={!editor || editingDisabled || loading || !history.undo}
					onClick={() => {
						cancelGesture.current?.();
						if (editor) {
							setHistory(performTwoDHistory(editor, "undo"));
							editor.editor.render.clientArea.focus({ preventScroll: true });
						}
					}}
				>
					<TwoDIcon name="undo" />
				</button>
				<button
					title="重做（Ctrl+Y）"
					aria-label="重做"
					disabled={!editor || editingDisabled || loading || !history.redo}
					onClick={() => {
						cancelGesture.current?.();
						if (editor) {
							setHistory(performTwoDHistory(editor, "redo"));
							editor.editor.render.clientArea.focus({ preventScroll: true });
						}
					}}
				>
					<TwoDIcon name="redo" />
				</button>
				{sourcePanel && (
					<button
						title={sourceHidden ? "显示原图" : "隐藏原图"}
						aria-label={sourceHidden ? "显示原图" : "隐藏原图"}
						aria-pressed={!sourceHidden}
						onClick={() => setSourceVisibility({ key: documentKey, hidden: !sourceHidden })}
					>
						<TwoDIcon name="eye" />
					</button>
				)}
				<ScientificImageCopyButton
					disabled={!editor || !visible || loading || !draft?.components.length}
					resetKey={visible ? `${documentKey}:${sourceEpoch}` : undefined}
					capture={async(owner,signal)=>{
						if(!editor)throw new Error('当前二维画板不可用。');
						const expected=revision.current,enabled=showRSRef.current;
						const ket=await editor.getKet();signal.throwIfAborted();
						if(expected!==revision.current)throw new Error('二维结构已变化，请重新复制。');
						const result=enabled?await boardCip(ket,expected):undefined;signal.throwIfAborted();
						if(expected!==revision.current||enabled!==showRSRef.current||enabled&&!result)throw new Error('二维结构或标注已变化，请重新复制。');
						paintTwoDBoardLabels(editor,result?.labels??[]);
						return captureTwoDBoardPng(editor.editor.render.paper.canvas,owner,signal);
					}}
				/>
				<label className="two-d-rs-toggle"><input type="checkbox" checked={showRS} onChange={event=>setStereoVisibility(event.currentTarget.checked,event.currentTarget.ownerDocument)}/>显示R/S</label>
				{showRS&&cipFailures.length>0&&<details>
					<summary aria-label={cipJob.current?.labels?.length?'部分立体化学标注失败':'立体化学标注失败'}>⚠</summary>
					<div role="status">{cipFailures.join('；')}</div>
					<button type="button" onClick={()=>{const job=cipJob.current;if(job)void boardCip(job.ket,job.revision,true);}}>重试标注</button>
					<button type="button" aria-label="关闭立体化学标注警告" onClick={()=>setCipFailures([])}>×</button>
				</details>}
				{onPreviewEnabledChange&&<label className="two-d-preview-toggle"><input type="checkbox" checked={previewEnabled} onChange={event=>onPreviewEnabledChange(event.currentTarget.checked)}/>三维预览</label>}
				<input
					ref={fileInput}
					type="file"
					aria-label="二维结构文件"
					accept=".cdx,.cdxml,.mol,.sdf,.ket"
					hidden
					onChange={(event) => {
						const files = Array.from(event.target.files ?? []);
						event.target.value = "";
						if (files.length) onImportFiles?.(files);
					}}
				/>
				<input
					ref={imageInput}
					type="file"
					aria-label="二维识别图片"
					accept={imageAccept}
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (file) onRecognizeImage?.(file);
					}}
				/>
				{editor && (
					<label className="two-d-zoom">
						<span className="sr-only">视图缩放</span>
						<select
							aria-label="二维缩放"
							defaultValue="1"
							onChange={(e) => zoomTwoDViewport(editor, Number(e.target.value))}
						>
							{[0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].map((value) => (
								<option key={value} value={value}>
									{value * 100}%
								</option>
							))}
						</select>
					</label>
				)}
				<button
					title="适应画布"
					aria-label="适应画布"
					disabled={!editor || loading}
					onClick={() => editor && fitTwoDSourceViewport(editor)}
				>
					<TwoDIcon name="fit" />
				</button>
				<span>{status || (loading ? "正在准备二维结构…" : "")}</span>
			</div>
			<div className={`two-d-editor-content${sourcePanel && !sourceHidden ? " has-source" : ""}`}>
				{sourcePanel && (
					<aside
						className="two-d-editor-source"
						hidden={sourceHidden}
						style={sourceHidden ? { display: "none" } : undefined}
					>
						{sourcePanel}
					</aside>
				)}
				<TwoDPreviewSplit enabled={previewEnabled&&Boolean(previewPanel)} preview={previewPanel}>
				<div className="two-d-editor-canvas" inert={editingDisabled || loading ? true : undefined}>
					<Editor
						staticResourcesUrl="./ketcher"
						structServiceProvider={provider}
						disableMacromoleculesEditor
						buttons={buttons}
						errorHandler={onError}
						onInit={acceptNativeInit}
					/>
					{editor && (
						<TwoDInteractionLayer
							sourceEpoch={sourceEpoch}
							nativeReadyEpoch={nativeReadyEpoch}
							editor={editor}
							visible={visible}
							active={visible && !editingDisabled && !loading}
							revision={getRevision}
							onError={onError}
							onCancelReady={registerCancel}
							onHistoryChange={setHistory}
						/>
					)}
				</div>
				</TwoDPreviewSplit>
			</div>
			<footer>
				<div className="two-d-graph-state" aria-live="polite"><span>{canvasAtomCount} 原子</span><span>{draft?.components.length??0} 个片段</span><span>形式电荷合计 {charge===null?'未确定':charge>0?`+${charge}`:charge}</span></div>
				<button
					title="生成三维并退出"
					aria-label="生成三维并退出"
					disabled={!editor || loading || busy || !draft?.components.length}
					onClick={() => void generate()}
					data-testid="builder-generate-3d"
				>
					<TwoDIcon name="cube" />
				</button>
			</footer>
			{!!visibleIssues.length && (
				<div className="two-d-editor-issues" role="status">
					{visibleIssues.map((issue, index) => (
						<div key={`${issue.code}:${index}`}>{issue.message}</div>
					))}
				</div>
			)}
		</section>
	);
}
