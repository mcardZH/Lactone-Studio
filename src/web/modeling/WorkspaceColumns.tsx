import {
	forwardRef,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type HTMLAttributes
} from "react";
import { clampWorkbenchPaneSize } from "../../modeling/workbench-layout";
import "./workspace-columns.css";
import {beginWorkspaceDividerDrag,moveWorkspaceDividerDrag,endWorkspaceDividerDrag} from './workspace-divider-drag';
export interface WorkspaceColumnSizes {
	left: number;
	right: number | null;
}
export type WorkspaceColumnGeometry = {visible:false;reason:'unmounted'|'hidden'|'unmeasurable'} | {
	visible:true;container:{width:number;height:number};leftWidth:number;rightWidth:number;centerWidth:number;leftPercent:number;gridTemplateColumns:string;
};
/** Measure the committed native three-column grid, including container fitting.
 * Saved percentages and widths are deliberately not used as evidence of paint. */
export function readWorkspaceColumnGeometry(element:HTMLElement|null|undefined):WorkspaceColumnGeometry {
	if(!element?.isConnected)return {visible:false,reason:'unmounted'};
	const view=element.ownerDocument.defaultView,box=element.getBoundingClientRect();
	if(!view||!element.getClientRects().length||box.width<=0||box.height<=0)return {visible:false,reason:'hidden'};
	const style=view.getComputedStyle(element);
	if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')return {visible:false,reason:'hidden'};
	const columns=style.gridTemplateColumns.trim().split(/\s+/);
	if(columns.length!==5||columns.some(value=>!/^\d+(?:\.\d+)?px$/.test(value)))return {visible:false,reason:'unmeasurable'};
	const widths=columns.map(parseFloat);
	return {visible:true,container:{width:box.width,height:box.height},leftWidth:widths[0],rightWidth:widths[4],centerWidth:widths[2],leftPercent:widths[0]/box.width*100,gridTemplateColumns:style.gridTemplateColumns};
}
const defaults: WorkspaceColumnSizes = { left: 27, right: null };
export function fitWorkspaceColumns(width: number, sizes: WorkspaceColumnSizes, rightVisible = true) {
	const rightMinimum = rightVisible ? 220 : 0;
	const available = Math.max(0, width - (rightVisible ? 12 : 6));
	const center = Math.min(160, Math.max(0, available - 250 - rightMinimum));
	const left = Math.max(250, Math.min((width * sizes.left) / 100, available - rightMinimum - center));
	if (!rightVisible) return { left, right: 0 };
	const right = Math.max(
		rightMinimum,
		Math.min(sizes.right ?? Math.round(width * 0.2), available - left - center)
	);
	return { left, right };
}
export function readWorkspaceColumns(key: string): WorkspaceColumnSizes {
	try {
		const value = JSON.parse(localStorage.getItem(`es.workspace-columns:${key}`) ?? "null");
		if (
			value &&
			Number.isFinite(value.left) &&
			(value.right === null || Number.isFinite(value.right))
		)
			return {
				left: clampWorkbenchPaneSize("leftWidth", value.left),
				right: value.right === null ? null : clampWorkbenchPaneSize("rightWidth", value.right)
			};
	} catch {
		/* An unavailable preference store does not block observation. */
	}
	return defaults;
}
export function useWorkspaceColumns(key: string) {
	const [sizes, setSizes] = useState(() => readWorkspaceColumns(key));
	function update(patch: Partial<WorkspaceColumnSizes>) {
		setSizes((prior) => {
			const next = { ...prior, ...patch };
			try {
				localStorage.setItem(`es.workspace-columns:${key}`, JSON.stringify(next));
			} catch {}
			return next;
		});
	}
	return { sizes, update };
}
export const WorkspaceColumns = forwardRef<
	HTMLDivElement,
	HTMLAttributes<HTMLDivElement> & { sizes?: WorkspaceColumnSizes; rightVisible?: boolean }
>(function WorkspaceColumns({ sizes, rightVisible = true, style, className = "", ...props }, ref) {
	const host = useRef<HTMLDivElement | null>(null),
		[width, setWidth] = useState(0);
	useEffect(() => {
		if (!sizes || !host.current) return;
		const root = host.current,
			read = () => setWidth(root.getBoundingClientRect().width);
		read();
		const observer = new ResizeObserver(read);
		observer.observe(root);
		return () => observer.disconnect();
	}, [Boolean(sizes)]);
	const fitted = sizes ? fitWorkspaceColumns(width, sizes, rightVisible) : undefined;
	return (
		<div
			{...props}
			data-right-pane={rightVisible}
			ref={(node) => {
				host.current = node;
				if (typeof ref === "function") ref(node);
				else if (ref) ref.current = node;
			}}
			className={`${className}${sizes ? " workspace-three-columns" : ""}`}
			style={
				{
					...style,
					...(sizes
						? {
								"--shared-input-width": width ? `${fitted!.left}px` : `${sizes.left}%`,
								"--shared-tool-width": `${fitted!.right}px`,
								gridTemplateColumns:
									rightVisible
										? "minmax(250px,var(--shared-input-width)) 6px minmax(0,1fr) 6px minmax(220px,var(--shared-tool-width))"
										: "minmax(250px,var(--shared-input-width)) 6px minmax(0,1fr) 0px 0px"
							}
						: {})
				} as CSSProperties
			}
		/>
	);
});
export function WorkspaceColumnDivider(p: {
	side: "left" | "right";
	sizes: WorkspaceColumnSizes;
	gridRow?: CSSProperties["gridRow"];
	onChange(patch: Partial<WorkspaceColumnSizes>): void;
}) {
	function resize(node: HTMLElement, x: number) {
		const bounds = (
			node.closest<HTMLElement>(".workspace-three-columns") ?? node.parentElement!
		).getBoundingClientRect();
		if (p.side === "left")
			p.onChange({
				left: clampWorkbenchPaneSize(
					"leftWidth",
					(Math.max(250, x - bounds.left) / bounds.width) * 100
				)
			});
		else
			p.onChange({ right: clampWorkbenchPaneSize("rightWidth", Math.max(220, bounds.right - x)) });
	}
	return (
		<div
			style={{ gridColumn: p.side === "left" ? 2 : 4, gridRow: p.gridRow ?? "1 / 3" }}
			className={
				p.side === "left"
					? "workspace-input-divider workspace-column-divider"
					: "workspace-common-tool-divider workspace-column-divider"
			}
			role="separator"
			aria-label={p.side === "left" ? "调整参数区宽度" : "调整公共工具区宽度"}
			aria-orientation="vertical"
			tabIndex={0}
			onPointerDown={(event) => {
				event.preventDefault();
				beginWorkspaceDividerDrag(event.currentTarget,event.pointerId,event.clientX);
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				if (event.currentTarget.hasPointerCapture(event.pointerId)){
					moveWorkspaceDividerDrag(event.currentTarget,event.pointerId,event.clientX);
					resize(event.currentTarget, event.clientX);
				}
			}}
			onPointerUp={(event) => {
				endWorkspaceDividerDrag(event.currentTarget,event.pointerId);
				if (event.currentTarget.hasPointerCapture(event.pointerId))
					event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={(event) => {
				endWorkspaceDividerDrag(event.currentTarget,event.pointerId);
				if (event.currentTarget.hasPointerCapture(event.pointerId))
					event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onLostPointerCapture={event=>endWorkspaceDividerDrag(event.currentTarget,event.pointerId)}
			onDoubleClick={() => p.onChange(p.side === "left" ? { left: 27 } : { right: null })}
			onKeyDown={(event) => {
				if (event.key === "Home") {
					event.preventDefault();
					p.onChange(p.side === "left" ? { left: 27 } : { right: null });
				} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
					event.preventDefault();
					const delta = event.key === "ArrowLeft" ? -1 : 1,
						root =
							event.currentTarget.closest<HTMLElement>(".workspace-three-columns") ??
							event.currentTarget.parentElement!;
					p.onChange(
						p.side === "left"
							? { left: clampWorkbenchPaneSize("leftWidth", p.sizes.left + delta) }
							: {
									right: clampWorkbenchPaneSize(
										"rightWidth",
										(p.sizes.right ?? Math.max(220, root.clientWidth * 0.2)) - delta * 20
									)
								}
					);
				}
			}}
		/>
	);
}
