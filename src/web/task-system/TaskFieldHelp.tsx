import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { environmentHelp } from "./environment-assistant";

interface TaskFieldHelpOwner {
	button: HTMLElement;
	doc: Document;
	host: HTMLElement;
	panel: HTMLElement | null;
}

/** Resolve the real DOM owner, including intentionally embedded/nested dialogs. */
export function resolveTaskFieldHelpOwner(button: HTMLElement): TaskFieldHelpOwner | null {
	if (!button.isConnected || button.closest('[hidden],[inert],[aria-hidden="true"]')) return null;
	const doc = button.ownerDocument,
		backdrop = button.closest<HTMLElement>(".dialog-backdrop");
	if (backdrop && backdrop.getAttribute("data-dialog-open") !== "true") return null;
	return { button, doc, host: backdrop ?? doc.body, panel: button.closest<HTMLElement>(".dialog-shell") };
}

/** Tooltip lifetime consumes no focus or modal ownership of its own. */
export function bindTaskFieldHelpOwner(owner: TaskFieldHelpOwner, tooltip: () => HTMLElement | null, close: () => void) {
	const { button, doc, host, panel } = owner;
	let disposed = false;
	const current = () => {
		const next = resolveTaskFieldHelpOwner(button);
		return !disposed && next?.doc === doc && next.host === host && next.panel === panel;
	};
	const within = (target: EventTarget | null, node: HTMLElement | null) => Boolean(node && target && node.contains(target as Node));
	const ownsKeyboard = (target: EventTarget | null) => {
		if (within(target, tooltip()) || within(target, button)) return true;
		if (!within(target, panel)) return false;
		return (target as Element).closest?.(".dialog-backdrop") === (host === doc.body ? null : host);
	};
	const key = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		if (!current() || !ownsKeyboard(event.target)) { close(); return; }
		if (event.defaultPrevented) return;
		event.preventDefault();
		event.stopPropagation();
		close();
	};
	const outside = (event: PointerEvent) => {
		if (!current() || !within(event.target, button) && !within(event.target, tooltip())) close();
	};
	const focus = (event: FocusEvent) => {
		if (!current() || !ownsKeyboard(event.target)) close();
	};
	const scroll = () => close();
	doc.addEventListener("keydown", key, true);
	doc.addEventListener("pointerdown", outside, true);
	doc.addEventListener("focusin", focus, true);
	doc.addEventListener("scroll", scroll, true);
	const Observer = doc.defaultView?.MutationObserver;
	const observer = Observer ? new Observer(() => { if (!current()) close(); }) : null;
	observer?.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "data-dialog-open"] });
	return () => {
		disposed = true;
		observer?.disconnect();
		doc.removeEventListener("keydown", key, true);
		doc.removeEventListener("pointerdown", outside, true);
		doc.removeEventListener("focusin", focus, true);
		doc.removeEventListener("scroll", scroll, true);
	};
}

/** One short help at a time, scoped to its actual document and keyboard owner. */
export default function TaskFieldHelp({ topic, label }: { topic: string; label: string }) {
	const id = useId(),
		anchor = useRef<HTMLButtonElement>(null),
		tooltip = useRef<HTMLSpanElement>(null),
		pointerFocus = useRef(false),
		timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [owner, setOwner] = useState<TaskFieldHelpOwner | null>(null),
		[position, setPosition] = useState({ left: 0, top: 0 });
	const open = owner !== null;
	function cancelTimer() {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	}
	function close() {
		cancelTimer();
		setOwner(null);
	}
	function show() {
		cancelTimer();
		const button = anchor.current;
		if (!button) return;
		const next = resolveTaskFieldHelpOwner(button);
		if (!next) { close(); return; }
		const rect = button.getBoundingClientRect(),
			doc = next.doc;
		const HelpEvent = doc.defaultView?.CustomEvent ?? CustomEvent;
		doc.dispatchEvent(new HelpEvent("es-task-help-open", { detail: id }));
		const width = Math.min(300, doc.documentElement.clientWidth - 24);
		setPosition({
			left: Math.max(12, Math.min(rect.left, doc.documentElement.clientWidth - width - 12)),
			top:
				rect.bottom + 8 + 100 < doc.documentElement.clientHeight
					? rect.bottom + 8
					: Math.max(12, rect.top - 110)
		});
		setOwner(next);
	}
	function delayClose() {
		cancelTimer();
		timer.current = setTimeout(close, 150);
	}
	useEffect(() => {
		const doc = owner?.doc ?? anchor.current?.ownerDocument;
		if (!doc) return;
		const another = (event: Event) => {
			if ((event as CustomEvent).detail !== id) close();
		};
		doc.addEventListener("es-task-help-open", another);
		return () => {
			cancelTimer();
			doc.removeEventListener("es-task-help-open", another);
		};
	}, [id, owner?.doc]);
	useEffect(() => {
		if (!owner) return;
		return bindTaskFieldHelpOwner(owner, () => tooltip.current, close);
	}, [owner]);
	if (!environmentHelp[topic]) return null;
	return (
		<>
			<button
				ref={anchor}
				type="button"
				className="task-field-help"
				aria-label={`${label}帮助`}
				aria-describedby={open ? id : undefined}
				onMouseEnter={() => {
					cancelTimer();
					timer.current = setTimeout(show, 300);
				}}
				onMouseLeave={delayClose}
				onPointerDown={() => {
					pointerFocus.current = true;
				}}
				onFocus={() => {
					if (!pointerFocus.current) show();
				}}
				onBlur={close}
				onClick={() => {
					pointerFocus.current = false;
					open ? close() : show();
				}}
			>
				?
			</button>
			{open &&
				anchor.current &&
				createPortal(
					<span
						ref={tooltip}
						id={id}
						role="tooltip"
						data-task-help={id}
						className="task-short-help"
						style={position}
						onMouseEnter={cancelTimer}
						onMouseLeave={delayClose}
					>
						{environmentHelp[topic]}
					</span>,
					owner!.host
				)}
		</>
	);
}
