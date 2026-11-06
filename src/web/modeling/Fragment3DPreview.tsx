import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Structure } from '../../core/types';
import { DEFAULT_DISPLAY, type AttachmentPort, type ModelDocument, type DisplaySettings } from '../../modeling/contracts';
import { validateAttachmentPorts } from '../../core/modeling/attachment-ports';
import { cellSegments, type CellFramePresentation } from './render/geometry';
import { createRenderAdapter,requiresCooperativeDisplay, type RenderAdapter } from './render/adapter';
import { bondDisplayRadius } from './structure-display';
import './fragment-preview.css';

/** Exact read snapshot adapter: no builder initialization, bond perception,
 * hydrogen policy, forcefield, generation, seed edit or application store. */
export function fragmentPreviewDocument(snapshot: Structure, sourceKey = snapshot.id, attachmentPorts: readonly AttachmentPort[] = [], kind: 'fragment' | 'crystal' = 'fragment'): ModelDocument {
  const structure = structuredClone(snapshot), ids = structure.atoms.map(atom => atom.id);
  const limit = kind === 'crystal' ? 10000 : 500;
  if (kind === 'crystal' && ids.length > limit) throw new Error('结构超过10000个原子，请选择更小晶胞。');
  if (!ids.length || ids.length > limit || ids.some(id => !id) || new Set(ids).size !== ids.length
    || structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) throw new Error(`${kind === 'crystal' ? '晶体' : '片段'}预览需要1–${limit}个有稳定身份的真实有限坐标原子。`);
  if ((structure.bonds ?? []).some(bond => ![bond.a, bond.b].every(index => Number.isSafeInteger(index) && index >= 0 && index < ids.length))) throw new Error('片段预览的真实键端点无效。');
  validateAttachmentPorts(attachmentPorts, structure);
  const assignments = { layers: [], basis: [], fragments: [], frozenAtomIds: [] };
  return { id: `fragment-preview:${sourceKey}`, revision: 0, draft: { structure, assignments,
    revision: 0, selectedIds: [], touchedIds: [], assignmentIssues: [], createdFrom: {}, past: [], future: [], dirty: false,
    baseAtomIds: ids as string[], baseStructure: structuredClone(structure), baseAssignments: structuredClone(assignments),
  }, selection: { atomIds: [], bonds: [], auxiliaryIds: [], portIds: [] }, auxiliaryRelations: [], deletedBonds: [], attachmentPorts: structuredClone([...attachmentPorts]), canUndo: false, canRedo: false };
}

export interface Fragment3DPreviewProps { snapshot: Structure; attachmentPorts?: readonly AttachmentPort[]; sourceKey?: string; activeAtomIndex?: number; onActiveAtomChange?(index: number): void; disabled?: boolean; compact?: boolean; display?: DisplaySettings; height?: number; kind?: 'fragment' | 'crystal'; summary?: string; cellPresentation?: CellFramePresentation }
/** Preview observes appearance defaults, but keeps its own port/anchor semantics. */
export function fragmentPreviewDisplay(display: DisplaySettings = DEFAULT_DISPLAY, kind: 'fragment' | 'crystal' = 'fragment'): DisplaySettings {
  return { ...DEFAULT_DISPLAY, periodicDisplay:display.periodicDisplay, structurePreset:display.structurePreset,structureFinish:display.structureFinish,structureLighting:display.structureLighting,structureSizing:display.structureSizing,vdwShell:display.vdwShell, representation: display.representation, elementColors: display.elementColors, atomScale: display.atomScale, bondScale: display.bondScale, elementScales: display.elementScales, depthFade: display.depthFade, atomNumbers: kind !== 'crystal', legend: false, cell: kind === 'crystal', alignment: 'off' };
}
export const FRAGMENT_PREVIEW_CAMERA = { orthographic: true } as const;
/** Project atom centres with the renderer's exact current atom envelope.
 * Radius is display-only, never an atom-coordinate edit or bond length.
 * Orthographic projection is affine; the row norms give its screen radius
 * in any current rotation, including a one-atom snapshot. */
export function fragmentPreviewProjectedExtent(instance:Pick<RenderAdapter,'project'|'atomRadius'>,snapshot:Structure,display?:DisplaySettings,cellPresentation?:CellFramePresentation):number {
  const settings=display??DEFAULT_DISPLAY,bonded=new Set((snapshot.bonds??[]).flatMap(bond=>[bond.a,bond.b]));
  const points=snapshot.atoms.map((atom,index)=>{
    const origin:[number,number,number]=[atom.x,atom.y,atom.z],centre=instance.project(origin);
    // Thick rods can exceed a small CPK sphere. Their centreline lies between
    // these endpoints, so the shared bond radius also belongs in the bound.
    const envelope=Math.max(instance.atomRadius(atom.element,settings),settings.representation!=='vdw'&&bonded.has(index)?bondDisplayRadius(settings):0);
    const axes=([0,1,2] as const).map(axis=>{const p:[number,number,number]=[...origin];p[axis]+=envelope;const projected=instance.project(p);return {x:projected.x-centre.x,y:projected.y-centre.y};});
    return {x:centre.x,y:centre.y,rx:Math.hypot(...axes.map(p=>p.x)),ry:Math.hypot(...axes.map(p=>p.y))};
  });
  if (settings.cell && snapshot.cell) for (const corner of cellSegments(snapshot.cell,cellPresentation).flat()) {
    const projected = instance.project(corner);
    points.push({ x: projected.x, y: projected.y, rx: 0, ry: 0 });
  }
  if(!points.length||points.some(p=>![p.x,p.y,p.rx,p.ry].every(Number.isFinite)))return NaN;
  const bounds=points.reduce((box,p)=>({left:Math.min(box.left,p.x-p.rx),right:Math.max(box.right,p.x+p.rx),top:Math.min(box.top,p.y-p.ry),bottom:Math.max(box.bottom,p.y+p.ry)}),{left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity});return Math.max(bounds.right-bounds.left,bounds.bottom-bounds.top);
}
/** Bounded measured fit. The adapter's verified zoom mapping is exp(-.0015
 * delta), with delta capped at 300; remeasure after every step instead of
 * assuming a fixed model size or imposing an unverified zoom constant. */
export function fitFragmentPreview(instance:Pick<RenderAdapter,'project'|'atomRadius'|'zoom'>,snapshot:Structure,width:number,height:number,display?:DisplaySettings,cellPresentation?:CellFramePresentation):boolean {
  const shortSide=Math.min(width,height);if(!Number.isFinite(shortSide)||shortSide<32)return false;
  for(let step=0;step<12;step++){
    const extent=fragmentPreviewProjectedExtent(instance,snapshot,display,cellPresentation);if(!Number.isFinite(extent)||extent<=0)return false;
    if(extent>=shortSide*.62&&extent<=shortSide*.72)return true;
    const delta=Math.max(-300,Math.min(300,-Math.log(shortSide*.67/extent)/.0015));
    instance.zoom(delta);
  }
  const extent=fragmentPreviewProjectedExtent(instance,snapshot,display,cellPresentation);return extent>=shortSide*.6&&extent<=shortSide*.75;
}
export function fragmentPreviewChoiceIndex(snapshot: Structure, sourceKey: string | undefined, start: { snapshot: Structure; sourceKey?: string }, atomId: string): number | null {
  if (snapshot !== start.snapshot || sourceKey !== start.sourceKey) return null;
  const index = snapshot.atoms.findIndex(atom => atom.id === atomId);
  return index < 0 ? null : index;
}

export default function Fragment3DPreview(props: Fragment3DPreviewProps) {
  const canvas = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null), adapter = useRef<RenderAdapter | null>(null), latest = useRef(props);
  latest.current = props;
  const preview = useMemo(() => { try { return { document: fragmentPreviewDocument(props.snapshot, props.sourceKey, props.attachmentPorts, props.kind), error: '' }; } catch (error) { return { document: null, error: error instanceof Error ? error.message : String(error) }; } }, [props.snapshot, props.sourceKey, props.attachmentPorts, props.kind]);
  const current = useRef(preview); current.current = preview;
  const framed = useRef<{snapshot:Structure;sourceKey?:string;sizeKey:string}|null>(null),lastSize=useRef({width:0,height:0});
  const drag = useRef<{ pointerId: number; x: number; y: number; view: number[]; moved: boolean; snapshot: Structure; sourceKey?: string } | null>(null);
  const [ready, setReady] = useState(false), [failure, setFailure] = useState('');
  const drawing=useRef<AbortController|null>(null);
  function clearDrag() { const own = drag.current; drag.current = null; if (own && surface.current?.hasPointerCapture(own.pointerId)) surface.current.releasePointerCapture(own.pointerId); }
  function draw() {
    const document = current.current.document, p = latest.current; if (!document || !adapter.current) return;
    const atom = p.kind === 'crystal' ? undefined : document.draft.structure.atoms[p.activeAtomIndex ?? 0];
    const settings = fragmentPreviewDisplay(p.display, p.kind);
    const instance=adapter.current,renderDocument={ ...document, selection: { ...document.selection, atomIds: atom?.id ? [atom.id] : [] } };
    const fit=()=>{
    const sizeKey=JSON.stringify([p.kind,p.cellPresentation,p.display?.representation,p.display?.atomScale,p.display?.bondScale,p.display?.elementScales]);
    const sourceChanged=framed.current?.snapshot!==p.snapshot||framed.current.sourceKey!==p.sourceKey;
    if(sourceChanged||framed.current?.sizeKey!==sizeKey){
      if(sourceChanged)instance.resetView();
      const bounds=canvas.current!.getBoundingClientRect();lastSize.current={width:bounds.width,height:bounds.height};
      fitFragmentPreview(instance,p.snapshot,bounds.width,bounds.height,settings,p.cellPresentation);framed.current={snapshot:p.snapshot,sourceKey:p.sourceKey,sizeKey};
    }
    };
    if(instance.drawAsync&&(drawing.current||instance.cooperativeDisplay?.()||requiresCooperativeDisplay(renderDocument,settings))){
      drawing.current?.abort();const own=new AbortController();drawing.current=own;
      const isCurrent=()=>!own.signal.aborted&&drawing.current===own&&adapter.current===instance&&latest.current.snapshot===p.snapshot&&latest.current.sourceKey===p.sourceKey&&latest.current.display===p.display;
      void instance.drawAsync(renderDocument,settings,undefined,undefined,undefined,undefined,{cellPresentation:p.cellPresentation,isCurrent},own.signal).then(()=>{if(isCurrent())fit();}).catch(error=>{if(!own.signal.aborted&&isCurrent())setFailure(error instanceof Error?error.message:String(error));}).finally(()=>{if(drawing.current===own)drawing.current=null;});
    }else{instance.draw(renderDocument,settings,undefined,undefined,undefined,undefined,{cellPresentation:p.cellPresentation});fit();}
  }
  useEffect(() => {
    if (!current.current.document) return;
    let cancelled = false, resize: ResizeObserver | undefined;
    const node = canvas.current!, win = node.ownerDocument.defaultView!;
    const cancel = () => clearDrag();
    setReady(false);setFailure('');
    void createRenderAdapter(node, FRAGMENT_PREVIEW_CAMERA).then(instance => {
      if (cancelled) { instance.dispose(); return; }
      adapter.current = instance; draw(); setReady(true);
      resize = new ResizeObserver(() => { const bounds=node.getBoundingClientRect(),prior=lastSize.current;clearDrag();instance.resize();if(bounds.width===prior.width&&bounds.height===prior.height)return;lastSize.current={width:bounds.width,height:bounds.height}; }); resize.observe(node);
    }).catch(error => { if (!cancelled) setFailure(error instanceof Error ? error.message : String(error)); });
    win.addEventListener('blur', cancel);
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); if (!drag.current&&adapter.current) adapter.current.zoom(event.deltaY); };
    surface.current!.addEventListener('wheel', wheel, { passive: false });
    const target = surface.current!;
    return () => { cancelled = true;drawing.current?.abort();drawing.current=null; clearDrag(); win.removeEventListener('blur', cancel); target.removeEventListener('wheel', wheel); resize?.disconnect(); adapter.current?.dispose(); adapter.current = null;framed.current=null; };
  }, [Boolean(preview.document)]);
  useEffect(() => { clearDrag(); if (ready) draw(); }, [ready, preview, props.sourceKey, props.activeAtomIndex, props.display, props.cellPresentation]);
  function down(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation(); if (!adapter.current || !current.current.document || event.button !== 0 || drag.current) return;
    event.preventDefault(); drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, view: adapter.current.getView(), moved: false, snapshot: latest.current.snapshot, sourceKey: latest.current.sourceKey };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation(); const instance = adapter.current; if (!instance) return;
    const own = drag.current;
    if (!own) { instance.hover(instance.pick({ x: event.clientX, y: event.clientY })); return; }
    if (own.pointerId !== event.pointerId) return;
    const dx = event.clientX - own.x, dy = event.clientY - own.y; own.moved ||= Math.hypot(dx, dy) >= 4;
    if (own.moved) instance.camera(own.view, dx, dy, 'rotate');
  }
  function up(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation(); const own = drag.current; if (!own || own.pointerId !== event.pointerId) return;
    move(event); clearDrag(); const p = latest.current;
    if (own.moved || p.disabled || p.kind === 'crystal') return;
    const pick = adapter.current?.pick({ x: event.clientX, y: event.clientY });
    if (pick?.kind === 'atom') { const index = fragmentPreviewChoiceIndex(p.snapshot, p.sourceKey, own, pick.atomId); if (index !== null) p.onActiveAtomChange?.(index); }
  }
  return <section className={`fragment-3d-preview${props.compact?' fragment-3d-preview-compact':''}`} data-testid="fragment-3d-preview" data-preview-kind={props.kind ?? 'fragment'} data-source-key={props.sourceKey ?? props.snapshot.id} data-ready={ready} data-projection="orthographic" aria-label={props.kind === 'crystal' ? '真实晶体三维预览' : '真实片段三维预览'}>
    <div className="fragment-3d-stage" style={props.height===undefined?undefined:{height:props.height,minHeight:160}}><div ref={canvas} className="fragment-3d-canvas"/><div data-no-reorder ref={surface} className="fragment-3d-surface" data-testid="fragment-3d-surface" tabIndex={0} aria-label="旋转和缩放片段，方向键旋转，加减号缩放" onKeyDown={event=>{if(event.key==='+'||event.key==='='||event.key==='-'){event.preventDefault();event.stopPropagation();adapter.current?.zoom(event.key==='-'?80:-80);}else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();event.stopPropagation();adapter.current?.step(({ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'} as const)[event.key as 'ArrowLeft'|'ArrowRight'|'ArrowUp'|'ArrowDown']);}}} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={clearDrag} onLostPointerCapture={clearDrag} onPointerLeave={() => { if (!drag.current) adapter.current?.hover({ kind: 'none', worldPoint: [0, 0, 0] }); }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}/></div>
    {(preview.error || failure) && <DismissibleNotice role="alert">{preview.error || failure}</DismissibleNotice>}
    {props.kind === 'crystal' && <p>{props.summary ?? <>实际 {props.snapshot.atoms.length} 个原子</>}</p>}
  </section>;
}
