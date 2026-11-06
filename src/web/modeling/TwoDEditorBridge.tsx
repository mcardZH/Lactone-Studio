import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Editor } from "ketcher-react";
import { fromNewCanvas, type Ketcher } from "ketcher-core";
import "ketcher-react/dist/index.css";
import type { Structure } from "../../core/types";
import {
	componentToStructure,
	parseKetDraft,
	parseTwoDDraft,
	remainingTwoDSourceIssues
} from "../../modeling/two-d";
import type { TwoDCommitData, TwoDDraft, TwoDSourceInput } from "../../modeling/two-d";
import { createTwoDEditorProvider, twoDIndigoConverter } from "./two-d-editor-service";
import "./two-d-editor-ui.css";
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
	readonly revision: number;
	readonly hasContent: boolean;
	cancelGesture(): void;
	replaceSource(
		source: TwoDSourceInput,
		options?: { history?: "reset" | "append"; metadata?: unknown; expectedRevision?: number }
	): Promise<boolean>;
}

interface Props {
	busy: boolean;
	initialSource?: TwoDSourceInput;
	sourceName?: string;
	onGenerate(structure: Structure, draft?: TwoDCommitData, snapshot?: TwoDEditorSnapshot): void;
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
function emptyDraft(sourceId: string, ket = emptyKet): TwoDDraft {
	return parseKetDraft(ket, { sourceId, allowEmpty: true });
}

/** Ketcher owns the only 2D history. Formal document transactions belong to the caller. */
export default function TwoDEditorBridge({
	busy,
	initialSource,
	sourceName,
	onGenerate,
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
	const [draft, setDraft] = useState<TwoDDraft | null>(null);
	const [selected, setSelected] = useState("");
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
	const latest = useRef({ onError, onGenerate });
	latest.current = { onError, onGenerate };
	const manualId = useRef(crypto.randomUUID());
	const sourceDocumentKey = useRef<string | undefined>(undefined);
	const sourceInput = useRef<TwoDSourceInput | undefined>(undefined),
		sourceMetadata = useRef<unknown>(undefined),
		hasContent = useRef(false);
	const cancelGesture = useRef<(() => void) | null>(null);
	const snapshotCallback = useRef(onSnapshot);
	snapshotCallback.current = onSnapshot;
	const registerCancel = useCallback((cancel: (() => void) | null) => {
		cancelGesture.current = cancel;
	}, []);
	const getRevision = useCallback(() => revision.current, []);
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
			try {
				const ket = await editor.getKet();
				if (!active || request !== sequence || loadingRef.current) return;
				setHistory(nativeEditorApi(editor).historySize());
				const sourceId = source.current?.source.id ?? manualId.current;
				const next = parseKetDraft(ket, {
					sourceId: `${sourceId}:edited:${revision.current}`,
					filename: source.current?.source.name,
					allowEmpty: true
				});
				hasContent.current = next.components.some((c) => c.atoms.length > 0);
				setDraft(next);
				setDirty(ket !== originalKet.current);
				snapshotCallback.current?.(snapshot(ket));
				setSelected((previous) =>
					next.components.some((value) => value.id === previous)
						? previous
						: next.components.length === 1
							? next.components[0].id
							: ""
				);
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
			setDraft(editorBaseline.current);
			setDirty(false);
			setHistory({ undo: 0, redo: 0 });
			sourceInput.current = initialSource;
			sourceDocumentKey.current = documentKey;
			sourceMetadata.current = undefined;
			hasContent.current = next.components.some((c) => c.atoms.length > 0);
			revision.current++;
			snapshotCallback.current?.(snapshot(originalKet.current));
			setSelected(
				editorBaseline.current.components.length === 1
					? editorBaseline.current.components[0].id
					: ""
			);
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

	useEffect(() => {
		if (!visible) cancelGesture.current?.();
	}, [visible]);
	useEffect(() => {
		if (!editor) {
			onRuntime?.(null);
			return;
		}
		const runtime: TwoDEditorRuntime = {
			get revision() {
				return revision.current;
			},
			get hasContent() {
				return hasContent.current;
			},
			cancelGesture() {
				cancelGesture.current?.();
			},
			async getSnapshot() {
				return snapshot(await editor.getKet());
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
	async function generate() {
		if (!editor || loading || busy) return;
		const epoch = session.current;
		const expectedRevision = revision.current;
		cancelGesture.current?.();
		setLoading(true);
		try {
			const ket = await editor.getKet();
			if (!mounted.current || epoch !== session.current || expectedRevision !== revision.current)
				return;
			const isEdited = ket !== originalKet.current;
			const current = parseKetDraft(ket, {
				sourceId: isEdited
					? `${source.current?.source.id ?? manualId.current}:edited:${revision.current}`
					: (source.current?.source.id ?? manualId.current),
				allowEmpty: true
			});
			const component =
				current.components.length === 1
					? current.components[0]
					: current.components.find((value) => value.id === selected);
			if (!component)
				throw new Error(
					current.components.length ? "请先选择要生成三维的结构。" : "请先绘制分子。"
				);
			assertTwoDSelectedGraph(component.ket);
			// Source-level fidelity failures cannot disappear merely because an
			// editor round trip omitted the original unsupported property.
			const sourceIssues = source.current
				? remainingTwoDSourceIssues({
						sourceDraft: source.current,
						editorBaselineDraft: editorBaseline.current,
						currentComponent: component,
						edited: isEdited
					})
				: [];
			const graph = componentToStructure(
				{ ...component, issues: [...component.issues, ...sourceIssues] },
				{ name: source.current?.source.name ?? "drawing" }
			);
			if (!mounted.current || epoch !== session.current) return;
			latest.current.onGenerate(
				graph,
				{
					source: source.current?.source ?? current.source,
					selectedComponentId: component.id,
					originalKet: source.current?.ket ?? emptyKet,
					finalKet: ket,
					finalGraph: { atoms: graph.atoms, bonds: graph.bonds, layout2D: graph.layout2D },
					issues: [...current.issues, ...component.issues, ...sourceIssues],
					edited: isEdited
				},
				snapshot(ket)
			);
		} catch (error) {
			if (mounted.current && epoch === session.current)
				latest.current.onError(error instanceof Error ? error.message : String(error));
		} finally {
			if (mounted.current && epoch === session.current) setLoading(false);
		}
	}
	const visibleIssues = draft?.issues.filter((issue) => issue.code !== "invalid-valence") ?? [];
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
							active={visible && !editingDisabled && !loading}
							revision={getRevision}
							onError={onError}
							onCancelReady={registerCancel}
							onHistoryChange={setHistory}
						/>
					)}
				</div>
			</div>
			<footer>
				<label>
					{(draft?.components.length ?? 0) > 1 ? (
						<select
							value={selected}
							onChange={(event) => setSelected(event.target.value)}
							aria-label="选择二维结构"
						>
							<option value="">请选择目标结构</option>
							{draft!.components.map((value) => (
								<option key={value.id} value={value.id}>
									{value.label} · {value.atoms.length} 原子
								</option>
							))}
						</select>
					) : (
						`${draft?.components[0]?.atoms.length ?? 0} 原子`
					)}
				</label>
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
