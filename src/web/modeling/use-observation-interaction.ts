import {
	useEffect,
	useRef,
	useState,
	type RefObject,
	type Dispatch,
	type SetStateAction
} from "react";
import type {
	InteractionState,
	MeasurementState,
	ModelDocument,
	ModelSelection,
	PickResult
} from "../../modeling/contracts";
import { useProjectState } from "../../projects/ui-state";
import { createModelInteraction } from "./interaction";
import { useModelShortcuts } from "./use-model-shortcuts";
import { bindModelWorkspaceKeys } from "./model-workspace-keyboard";
import { editableTarget } from "./workspace-actions";
import { emptyMeasurement } from "./measurement-state";

/** The shared key interpreter, with only observation actions admitted. No Store,
 * freeze, history, clipboard, native optimization or source-edit port exists. */
export function useObservationInteraction(p: {
	root: RefObject<HTMLElement | null>;
	document: ModelDocument;
	active: boolean;
	setMeasurement: Dispatch<SetStateAction<MeasurementState>>;
}) {
	const shortcuts = useModelShortcuts(),
		bindings = useRef(shortcuts.bindings);
	bindings.current = shortcuts.bindings;
	const [keyboard] = useState(() =>
		createModelInteraction({ getSelectKey: () => bindings.current.select })
	);
	const [interaction, setInteraction] = useState<InteractionState>({
		element: null,
		box: false,
		alt: false,
		gesture: "none"
	});
	const [selection, setSelection] = useProjectState<ModelSelection>(
		"observation.selection",
		{ atomIds: [], bonds: [], auxiliaryIds: [], portIds: [] },
		p.document.id
	);
	const hover = useRef<PickResult>({ kind: "none" }),
		inside = useRef(false),
		latest = useRef(p);
	latest.current = p;
	useEffect(() => {
		const root = p.root.current,
			owner = root?.ownerDocument.defaultView;
		if (!root || !owner) return;
		const reset = () => {
			inside.current = false;
			hover.current = { kind: "none" };
			keyboard.reset("blur");
			setInteraction({ element: null, box: false, alt: false, gesture: "none" });
		};
		const enter = () => {
				inside.current = true;
			},
			leave = () => {
				inside.current = false;
			};
		root.addEventListener("pointerenter", enter);
		root.addEventListener("pointerleave", leave);
		owner.addEventListener("blur", reset);
		const unbind = bindModelWorkspaceKeys(owner, (event, release) => {
			const value = latest.current,
				target = event.target;
			const inScope = inside.current || root.contains(root.ownerDocument.activeElement);
			if (
				!value.active ||
				editableTarget(target) ||
				editableTarget(root.ownerDocument.activeElement) ||
				event.isComposing ||
				(!release && !inScope)
			) {
				keyboard.reset("blur");
				setInteraction({ element: null, box: false, alt: false, gesture: "none" });
				return;
			}
			if (!release && event.defaultPrevented) return;
			const key = event.key.toLowerCase();
			if (
				![bindings.current.select, "escape", "2", "3", "4", "alt"].includes(key) &&
				!((event.ctrlKey || event.metaKey) && key === "a")
			)
				return;
			const input = {
				key: event.key,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				altKey: event.altKey,
				shiftKey: event.shiftKey,
				repeat: event.repeat,
				isComposing: event.isComposing,
				editable: false,
				hoverKind: hover.current.kind
			};
			const actions = release ? keyboard.keyUp(input) : keyboard.keyDown(input);
			for (const action of actions) {
				if (action.type === "measurement-mode") value.setMeasurement(emptyMeasurement(action.mode));
				if (action.type === "clear-measurement-pending" || action.type === "escape")
					value.setMeasurement((previous) => ({ ...previous, atomIds: [] }));
				if (action.type === "select-all")
					setSelection({
						atomIds: value.document.draft.structure.atoms.map((atom) => atom.id!),
						bonds: [],
						auxiliaryIds: [],
						portIds: []
					});
			}
			const state = keyboard.getSnapshot();
			setInteraction({ ...state, element: null });
			event.preventDefault();
		});
		return () => {
			unbind();
			root.removeEventListener("pointerenter", enter);
			root.removeEventListener("pointerleave", leave);
			owner.removeEventListener("blur", reset);
			reset();
		};
	}, [p.root, keyboard, p.document.id]);
	useEffect(() => {
		if (!p.active) {
			keyboard.reset("blur");
			setInteraction({ element: null, box: false, alt: false, gesture: "none" });
		}
	}, [p.active, keyboard]);
	return {
		interaction,
		selection,
		onSelection: setSelection,
		onHover: (pick: PickResult) => {
			hover.current = pick;
		},
		clearSelection: () => setSelection({ atomIds: [], bonds: [], auxiliaryIds: [], portIds: [] }),
		clearCoordinates: () => p.setMeasurement((previous) => emptyMeasurement(previous.mode))
	};
}
