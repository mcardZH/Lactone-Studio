import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ModelDocument, StructureTransformCandidate } from "../../core/modeling/contracts";
import type { PeriodicCell, Structure, Vector3 } from "../../core/types";
import { DialogSurface } from "../DialogShell";
import NumericInput from "../NumericInput";
import type { TransformPreviewGuides } from "./render/transform-guides";
import "./structure-transform-panel.css";

export interface StructureTransformPanelProps<Request> {
	document: ModelDocument;
	open: boolean;
	disabled?: boolean;
	/** The workspace left pane hosts the same controls without a floating dialog. */
	embedded?: boolean;
	/** Expanded cards may keep drafts mounted without owning the canvas. */
	previewActive?: boolean;
	previewLive?: boolean;
	onPreviewLiveChange?(enabled: boolean): void;
	onPrepare(request: Request): StructureTransformCandidate | Promise<StructureTransformCandidate>;
	/** The only write: Main creates and activates one derived workspace document. */
	onApply(candidate: StructureTransformCandidate): void | Promise<void>;
	/** A transient renderer overlay, never a model replacement or history entry. */
	onPreviewChange?(candidate: StructureTransformCandidate | null): void;
	onPreviewPresentationChange?(presentation: TransformPreviewPresentation | null): void;
	onClose(): void;
}
export interface TransformPreviewPresentation {
	mode: "single" | "slab";
	source: Structure;
	candidate: StructureTransformCandidate;
	sourceCell?: PeriodicCell;
	guides?: TransformPreviewGuides;
	candidateGuides?: TransformPreviewGuides;
	/** Source-world to candidate-world rotation, independent of camera state. */
	rotation?: [Vector3, Vector3, Vector3];
	updating?: boolean;
	displaySource?: boolean;
}
export interface TransformReferenceCapture {
	count: 1 | 2 | 3;
	label: string;
	onConfirm(ids: string[]): void;
}

export function parseTransformVector(text: string, label: string): Vector3 {
	const values = text
		.trim()
		.split(/[\s,，;；]+/)
		.map(Number);
	if (values.length !== 3 || values.some((value) => !Number.isFinite(value)))
		throw new Error(`${label}须填写3个有限数值。`);
	return values as Vector3;
}
export function parseTransformNumber(text: string, label: string, positive = false): number {
	const value = text.trim() ? Number(text) : NaN;
	if (!Number.isFinite(value) || (positive && value <= 0))
		throw new Error(`${label}须为${positive ? "正" : "有限"}数值。`);
	return value;
}
export function candidateMatchesDocument(
	candidate: StructureTransformCandidate,
	document: Pick<ModelDocument, "id" | "revision">
): boolean {
	return candidate.documentId === document.id && candidate.expectedRevision === document.revision;
}

/** Request lifetime belongs to this panel; model history and scientific guards belong to Store. */
export function useStructureTransformPreview<Request>(
	props: StructureTransformPanelProps<Request>,
	draftKey: string,
	request?: () => Request
) {
	const [prepared, setPrepared] = useState<{
		candidate: StructureTransformCandidate;
		key: string;
	} | null>(null);
	const [displayed, setDisplayed] = useState<{ candidate: StructureTransformCandidate; owner: string } | null>(null);
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const [localLive, setLocalLive] = useState(true);
	const live = props.previewLive ?? localLive;
	const active = props.open && props.previewActive !== false && !props.disabled;
	const serial = useRef(0),
		latest = useRef({ props, draftKey, request, live });
	latest.current = { props, draftKey, request, live };
	const alive = useRef(true),
		applying = useRef(false);
	const flight = useRef<Promise<StructureTransformCandidate | undefined> | null>(null);
	const preparedRef = useRef<{ candidate: StructureTransformCandidate; key: string } | null>(null);
	const owner = `${props.document.id}:${props.document.revision}`;
	const key = `${owner}:${draftKey}`;
	const candidate = prepared?.key === key ? prepared.candidate : null;
	const displayCandidate = displayed?.owner === owner ? displayed.candidate : null;
	const latestKey = useRef(key);
	latestKey.current = key;
	useEffect(() => {
		serial.current++;
		setPrepared(null);
		preparedRef.current = null;
		setDisplayed(null);
		setBusy(false);
		setError("");
		latest.current.props.onPreviewChange?.(null);
	}, [owner]);
	useEffect(() => {
		serial.current++;
		setError("");
		if (!live || !active || !request) {
			setBusy(false);
			latest.current.props.onPreviewChange?.(null);
			return;
		}
		if (candidate) {
			setDisplayed({ candidate, owner });
			latest.current.props.onPreviewChange?.(candidate);
			setBusy(false);
			return;
		}
		// Preserve the last valid structure and both viewport instances while
		// preparing new parameters. Only the latest request may publish.
		setBusy(true);
		// Coalesce same-turn parameter edits without imposing a visible debounce.
		// prepare() still serializes work and checks the latest draft/source owner.
		const timer = setTimeout(() => {
			void prepare(() => latest.current.request!());
		}, 0);
		return () => clearTimeout(timer);
	}, [key, live, active]);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			serial.current++;
			latest.current.props.onPreviewChange?.(null);
		};
	}, []);
	function discard() {
		serial.current++;
		setPrepared(null);
		preparedRef.current = null;
		setDisplayed(null);
		setBusy(false);
		latest.current.props.onPreviewChange?.(null);
	}
	async function prepare(request: () => Request) {
		const stamp = latestKey.current;
		while (flight.current) {
			const pending = flight.current;
			await pending;
			if (flight.current === pending) flight.current = null;
		}
		const current = latest.current.props;
		if (!alive.current || stamp !== latestKey.current || current.disabled || !current.open || current.previewActive === false || applying.current) return;
		if (preparedRef.current?.key === stamp) return preparedRef.current.candidate;
		const ticket = ++serial.current;
		setError("");
		setBusy(true);
		const pending = (async () => {
			try {
				const result = await latest.current.props.onPrepare(request());
				if (!alive.current || ticket !== serial.current || latestKey.current !== stamp) return;
				if (!candidateMatchesDocument(result, latest.current.props.document)) throw new Error("模型已变化，请重新预览。");
				setPrepared({ candidate: result, key: stamp });
				preparedRef.current = { candidate: result, key: stamp };
				setDisplayed({ candidate: result, owner });
				if (latest.current.live && latest.current.props.previewActive !== false) latest.current.props.onPreviewChange?.(result);
				return result;
			} catch (cause) {
				if (alive.current && ticket === serial.current && latestKey.current === stamp) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (alive.current && ticket === serial.current && latestKey.current === stamp) setBusy(false);
			}
		})();
		flight.current = pending;
		try { return await pending; } finally { if (flight.current === pending) flight.current = null; }
	}
	async function apply() {
		const current = latest.current.props;
		if (applying.current || busy || current.disabled || !current.open) return;
		const stamp = latestKey.current;
		const result =
			candidate ?? (latest.current.request ? await prepare(() => latest.current.request!()) : null);
		if (
			!result ||
			latestKey.current !== stamp ||
			!candidateMatchesDocument(result, latest.current.props.document)
		)
			return;
		applying.current = true;
		setBusy(true);
		setError("");
		try {
			await current.onApply(result);
			if (alive.current && latest.current.props.document.id === current.document.id) discard();
		} catch (cause) {
			if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			applying.current = false;
			if (alive.current) setBusy(false);
		}
	}
	return {
		candidate,
		displayCandidate,
		busy,
		error,
		setError,
		prepare,
		apply,
		discard,
		live,
		setLive(enabled: boolean) { setLocalLive(enabled); latest.current.props.onPreviewLiveChange?.(enabled); },
		close() {
			if (applying.current) return;
			discard();
			latest.current.props.onClose();
		}
	};
}

export function TransformToolSurface({
	title,
	onClose,
	children,
	testId,
	embedded
}: {
	title: string;
	onClose(): void;
	children: ReactNode;
	testId: string;
	embedded?: boolean;
}) {
	if (embedded)
		return (
			<section
				className="structure-transform-tool structure-transform-embedded ui-control-surface"
				aria-label={title}
				data-testid={testId}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					}
				}}
			>
				<header>
					<strong>{title}</strong>
					<button type="button" aria-label={`关闭${title}`} onClick={onClose}>
						×
					</button>
				</header>
				{children}
			</section>
		);
	return (
		<DialogSurface
			className="structure-transform-tool ui-control-surface"
			aria-label={title}
			data-testid={testId}
			onCancel={onClose}
			onPointerDown={(event) => event.stopPropagation()}
			onPointerMove={(event) => event.stopPropagation()}
			onPointerUp={(event) => event.stopPropagation()}
			onWheel={(event) => event.stopPropagation()}
			onKeyUp={(event) => event.stopPropagation()}
		>
			<header>
				<strong>{title}</strong>
				<button type="button" aria-label={`关闭${title}`} onClick={onClose}>
					×
				</button>
			</header>
			{children}
		</DialogSurface>
	);
}

export function TransformPreviewFooter({
	preview,
	disabled,
	actionLabel = "应用"
}: {
	preview: Pick<
		ReturnType<typeof useStructureTransformPreview>,
		"candidate" | "busy" | "error" | "apply" | "close" | "live" | "setLive"
	>;
	disabled?: boolean;
	actionLabel?: string;
}) {
	return (
		<>
			<div className="structure-transform-summary" aria-live="polite">
				{preview.busy
					? "正在处理…"
					: preview.candidate && preview.live
						? `预览 · ${preview.candidate.structure.atoms.length} 原子${preview.candidate.structure.cell ? " · 含晶胞" : ""}`
						: ""}
			</div>
			{preview.error && (
				<DismissibleNotice role="alert" className="structure-transform-error">
					{preview.error}
				</DismissibleNotice>
			)}
			<footer>
				<label className="structure-transform-check">
					<input
						type="checkbox"
						checked={preview.live}
						disabled={disabled}
						onChange={(event) => preview.setLive(event.target.checked)}
					/>
					实时预览
				</label>
				<button
					type="button"
					className="structure-transform-apply"
					disabled={disabled || preview.busy}
					onClick={() => void preview.apply()}
				>
					{actionLabel}
				</button>
				<button type="button" onClick={preview.close}>
					取消
				</button>
			</footer>
		</>
	);
}

/** One compact XYZ control, shared by every geometry and crystal task. */
export function TransformVectorFields({
	label,
	value,
	onChange,
	axes = ["X", "Y", "Z"],
	integer = false,
	stepper = false
}: {
	label: string;
	value: string;
	onChange(value: string): void;
	axes?: readonly string[];
	integer?: boolean;
	stepper?: boolean;
}) {
	const values = value.split(/[\s,，;；]+/);
	return (
		<div className="structure-transform-vector" role="group" aria-label={label}>
			<span>{label}</span>
			{axes.map((axis, index) => (
				<label key={axis}>
					{axis}
					<NumericInput
						aria-label={`${label} ${axis}`}
						stepper={stepper}
						step={integer ? "1" : "any"}
						value={values[index] ?? ""}
						onChange={(event) => {
							const next = axes.map((_, i) => values[i] ?? "");
							next[index] = event.target.value;
							onChange(next.join(" "));
						}}
					/>
				</label>
			))}
		</div>
	);
}
