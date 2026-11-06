import {
	CoordinateTransformation,
	Vec2,
	SupportedFormat,
	provideEditorInstance,
	type Ketcher
} from "ketcher-core";
/** Ketcher 3.18 runtime APIs omitted from its published Editor interface.
 * Verified against dist/index.js findItem/historySize, not guessed names. */
interface NativeEditorRuntime {
	findItem(
		event: { clientX: number; clientY: number },
		maps: string[]
	): { map: string; id: number } | null;
	historySize(): { undo: number; redo: number };
	tool(
		name?: string,
		options?: unknown
	): {
		mousedown(event: PointerEvent): void;
		mouseup(event: PointerEvent): void;
		mousemove(event: PointerEvent): void;
	};
	hover(hit: { map: string; id: number } | null, tool?: unknown, event?: PointerEvent): void;
}
export function nativeEditorApi(ketcher: Ketcher): NativeEditorRuntime {
	const value = ketcher.editor as unknown as NativeEditorRuntime;
	if (typeof value.findItem !== "function" || typeof value.historySize !== "function")
		throw new Error("当前二维编辑器缺少受控命中和历史接口。");
	return value;
}

/** Read after the native command has returned; a change notification is not
 * the command's completion boundary. Does not own or synthesize any history. */
export function performTwoDHistory(ketcher: Ketcher, direction: "undo" | "redo") {
	if (nativeEditorApi(ketcher).historySize()[direction] > 0) ketcher.editor[direction]();
	return nativeEditorApi(ketcher).historySize();
}

/** Ketcher 3.18 editor.setOptions dispatches apiSettings -> Redux setupEditor
 * -> editor.options(), which calls struct(struct.clone()) and adds CanvasLoad
 * history. These are renderer-only presentation overrides: update the public
 * Render directly and redraw, preserving both Struct and native history. */
export function applyTwoDDisplayOptions(ketcher: Ketcher) {
	ketcher.editor.render.updateOptions(
		JSON.stringify({
			showHydrogenLabels: "Hetero",
			carbonExplicitly: false,
			showValenceWarnings: false,
			selectionStyle: { fill: "#ffdf5c", stroke: "#d5aa20" },
			hoverStyle: { fill: "#fff1ac", stroke: "#d5aa20", "stroke-width": 1 },
			innerHoverStyle: { fill: "none", stroke: "#d5aa20", "stroke-width": 4 }
		})
	);
	ketcher.editor.render.update(true);
}

/** Fit and pan the viewport, never centerStruct(): that upstream helper moves
 * the actual atom coordinates. zoomAccordingContent() alone only changes scale
 * and leaves source coordinates around zero clipped under the top/left edge. */
export function fitTwoDSourceViewport(ketcher: Ketcher) {
	const editor = ketcher.editor,
		struct = editor.struct();
	if (!struct.atoms.size) return;
	editor.zoomAccordingContent(struct);
	const box = struct.getCoordBoundingBox(),
		render = editor.render;
	const center = new Vec2((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2);
	const canvasCenter = CoordinateTransformation.viewToCanvas(
		CoordinateTransformation.modelToView(center, render),
		render
	);
	render.setViewBox((previous) => ({
		...previous,
		minX: canvasCenter.x - previous.width / 2,
		minY: canvasCenter.y - previous.height / 2
	}));
	render.update(true);
}

/** Ketcher.setZoom in 3.18 addresses the singleton CoreEditor/macromolecule
 * canvas. Our retained molecular drawing owns this separate micro Render.
 * Use its native zoom operation, which changes only viewport scale/position. */
export function zoomTwoDViewport(ketcher: Ketcher, value: number) {
	if (!Number.isFinite(value) || value <= 0) return;
	ketcher.editor.zoom(value);
	// Selection transforms are rendered by the owned interaction layer.
	ketcher.editor.rotateController.clean();
}

type NativeMode = ReturnType<typeof provideEditorInstance>["mode"];
interface OwnedKeyboardScope {
	owner: Ketcher;
	original: NativeMode["onKeyDown"];
	wrapped: NativeMode["onKeyDown"];
}
const keyboardScopes = new WeakMap<NativeMode, OwnedKeyboardScope>();

/** CoreEditor registers mode.onKeyDown on document even in micromolecule
 * mode. SequenceMode consumes Space before a surrounding 3D window listener.
 * Scope only this owned instance: outside keys keep their original propagation,
 * while the retained editor keeps its graph/history and native listener owner. */
export function bindTwoDNativeKeyboardScope(
	ketcher: Ketcher,
	scope: { root(): Element | null; active(): boolean; deferUntilOwned?: boolean }
) {
	const core = provideEditorInstance(),
		root = scope.root();
	if (!core || !root || (core.ketcherId !== ketcher.id && !root.contains(core.canvas))) {
		// The first micro-only onInit can precede lazy CoreEditor creation.
		// The caller retries on the native second onInit, never via a timer.
		if (scope.deferUntilOwned) return () => {};
		throw new Error("无法确认二维键盘监听所属编辑器。");
	}
	const mode = core.mode,
		existing = keyboardScopes.get(mode);
	if (existing) {
		if (existing.owner !== ketcher || mode.onKeyDown !== existing.wrapped)
			throw new Error("二维键盘监听所属编辑器已变化。");
		return () => {};
	}
	const original = mode.onKeyDown;
	const wrapped: NativeMode["onKeyDown"] = function (this: NativeMode, event) {
		const ownRoot = scope.root(),
			target = event.target as Node | null;
		if (
			!scope.active() ||
			!ownRoot ||
			!target ||
			typeof target.nodeType !== "number" ||
			!ownRoot.contains(target)
		)
			return Promise.resolve();
		return original.call(this, event);
	};
	const owned = { owner: ketcher, original, wrapped };
	keyboardScopes.set(mode, owned);
	mode.onKeyDown = wrapped;
	return () => {
		if (keyboardScopes.get(mode) !== owned) return;
		if (mode.onKeyDown === wrapped) mode.onKeyDown = original;
		keyboardScopes.delete(mode);
	};
}

/** Same formatter/server settings as Ketcher.getKet(), prepared before an
 * action exists. View selection is cleared at source replacement. */
export async function canonicalizeTwoDSource(ketcher: Ketcher, rawKet: string) {
	const formatter = ketcher.formatterFactory.create(
		SupportedFormat.ket,
		ketcher.editor.serverSettings
	);
	const struct = await formatter.getStructureFromStringAsync(rawKet);
	const ket = await formatter.getStringFromStructureAsync(struct, undefined, {});
	return { struct, ket };
}
