import {DismissibleNotice} from '../DismissibleNotice';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DisplaySettings } from '../../modeling/contracts';
import { clampWorkbenchPaneSize } from '../../modeling/workbench-layout';
import Fragment3DPreview from './Fragment3DPreview';
import { type ActiveStructurePreviewModel } from './active-structure-preview';
import './fragment-preview.css';

export interface ActiveStructurePreviewProps {
  preview: ActiveStructurePreviewModel | null;
  activeAtomIndex?: number;
  onActiveAtomChange?(index: number): void;
  disabled?: boolean;
  error?: string;
  children?: ReactNode;
  display?: DisplaySettings;
  height?: number;
  onHeightChange?(height: number): void;
}

/** One persistent workspace surface. Toolbar children are owned by the
 * workspace, keeping copy-selection, copy-all and personal-library actions
 * reachable without coupling the preview to its canonical model store. */
export default function ActiveStructurePreview({ preview, activeAtomIndex, onActiveAtomChange, disabled = false, error, children, display, height, onHeightChange }: ActiveStructurePreviewProps) {
  const handle = useRef<HTMLDivElement>(null), gesture = useRef<{pointerId:number;startY:number;height:number}|null>(null);
  const [localHeight,setLocalHeight] = useState(220);
  const shownHeight = clampWorkbenchPaneSize('activePreviewHeight',height??localHeight);
  function changeHeight(value:number){const next=clampWorkbenchPaneSize('activePreviewHeight',value);setLocalHeight(next);onHeightChange?.(next);}
  function stopResize(){const own=gesture.current;gesture.current=null;if(own&&handle.current?.hasPointerCapture(own.pointerId))handle.current.releasePointerCapture(own.pointerId);}
  useEffect(()=>{const win=handle.current?.ownerDocument.defaultView;win?.addEventListener('blur',stopResize);return()=>{win?.removeEventListener('blur',stopResize);stopResize();};},[]);
  const index = preview && Number.isSafeInteger(activeAtomIndex) && activeAtomIndex! >= 0 && activeAtomIndex! < preview.structure.atoms.length
    ? activeAtomIndex! : preview?.defaultActiveAtomIndex ?? 0;
  return <section className="active-structure-preview" aria-label="结构预览" data-testid="active-structure-preview" data-preview-kind={preview?.kind ?? 'empty'} data-preview-key={preview?.key}>
    <header><strong>结构预览</strong>{preview && <span title={preview.label}>{preview.label}</span>}</header>
    {children && <div className="active-structure-preview-actions">{children}</div>}
    {error ? <DismissibleNotice role="alert">{error}</DismissibleNotice> : preview ? <>
      <Fragment3DPreview snapshot={preview.structure} attachmentPorts={preview.attachmentPorts} sourceKey={preview.key} activeAtomIndex={index} onActiveAtomChange={onActiveAtomChange} disabled={disabled} display={display} height={shownHeight} />
      <output className="active-structure-preview-anchor">接入位 {index + 1} · {preview.structure.atoms[index]?.element}</output>
    </> : <p className="active-structure-preview-empty">选择元素、环、链或官能团，或复制结构。</p>}
    <div data-no-reorder ref={handle} role="separator" aria-label="结构预览高度" aria-orientation="horizontal" aria-valuemin={160} aria-valuemax={520} aria-valuenow={shownHeight} tabIndex={0} className="active-structure-preview-resize" data-testid="active-structure-preview-resize" onPointerDown={event=>{event.preventDefault();event.stopPropagation();if(event.button!==0||gesture.current)return;gesture.current={pointerId:event.pointerId,startY:event.clientY,height:shownHeight};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const own=gesture.current;if(!own||own.pointerId!==event.pointerId)return;event.preventDefault();event.stopPropagation();changeHeight(own.height+event.clientY-own.startY);}} onPointerUp={event=>{if(gesture.current?.pointerId===event.pointerId){event.preventDefault();event.stopPropagation();stopResize();}}} onPointerCancel={stopResize} onLostPointerCapture={stopResize} onDoubleClick={event=>{event.preventDefault();event.stopPropagation();stopResize();changeHeight(220);}} onKeyDown={event=>{if(!['ArrowUp','ArrowDown','Home'].includes(event.key))return;event.preventDefault();event.stopPropagation();changeHeight(event.key==='Home'?220:shownHeight+(event.key==='ArrowUp'?-20:20));}}><span aria-hidden="true">⋯</span></div>
  </section>;
}
