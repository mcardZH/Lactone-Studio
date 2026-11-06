import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { TwoDImportFile } from '../../modeling/application/two-d-import';
import type { OcrCapabilities, OcrEngine } from '../../modeling/ocr/contracts';
import type { DecodedTwoDImage, TwoDImageCrop, TwoDImageDecoded, TwoDImageSelection } from '../../modeling/two-d/image-types';
import { TWO_D_OCR_LIMITS } from '../../modeling/two-d/image-types';
import { decodeStaticImage, fullImageCrop, imageCropLimitReason, imageSelectionPng } from '../../modeling/two-d/static-image-decode';
import './two-d-import.css';
import { TwoDIcon } from './TwoDInteractionLayer';
export type { TwoDImageCrop, TwoDImageDecoded, TwoDImageSelection } from '../../modeling/two-d/image-types';

export function normalizeImageCrop(a: { x: number; y: number }, b: { x: number; y: number }, width: number, height: number): TwoDImageCrop {
  const x = Math.max(0, Math.min(width - 1, Math.floor(Math.min(a.x, b.x))));
  const y = Math.max(0, Math.min(height - 1, Math.floor(Math.min(a.y, b.y))));
  return { x, y, width: Math.max(1, Math.min(width, Math.ceil(Math.max(a.x, b.x))) - x),
    height: Math.max(1, Math.min(height, Math.ceil(Math.max(a.y, b.y))) - y), imageWidth: width, imageHeight: height };
}

interface Props {
  file: TwoDImportFile; busy: boolean; capabilities?: OcrCapabilities;
  /** Deprecated compatibility props: product calls and displays only MolVec. */
  engine?: OcrEngine; onEngine?(engine: OcrEngine): void;
  crop?: TwoDImageCrop | null;
  onSelection?(crop: TwoDImageCrop): void;
  onDecoded?(value: TwoDImageDecoded): void;
  onChooseComponent(): void;
  onRecognize(selection: TwoDImageSelection): void;
  onError(message: string): void;
}

/** Canvas and crop are display/session state. OCR ownership lives in the workspace. */
export default function TwoDImageSource({ file, busy, capabilities, crop: controlledCrop, onSelection, onDecoded, onChooseComponent, onRecognize, onError }: Props) {
  const [display, setDisplay] = useState<{ id: string; image: DecodedTwoDImage } | null>(() => file.image ? { id: file.id, image: file.image } : null);
  const [localCrop, setLocalCrop] = useState<TwoDImageCrop | null>(() => file.image ? fullImageCrop(file.image.metadata) : null);
  const [preparing, setPreparing] = useState(false), [zoom, setZoom] = useState(1);
  const host = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; start: { x: number; y: number }; before: TwoDImageCrop | null } | null>(null);
  const currentFile = useRef(file.id); currentFile.current = file.id;
  const delivered = useRef(new Set<string>());
  const lifecycle = useRef(0);
  const latest = useRef({ onError, onRecognize, onDecoded, onSelection }); latest.current = { onError, onRecognize, onDecoded, onSelection };
  const decoded = display?.id === file.id ? display.image : null;
  const crop = controlledCrop === undefined ? localCrop : controlledCrop;
  const capability = capabilities?.engines.find(value => value.engine === 'molvec');
  const limits = { maxImageBytes: capabilities?.maxImageBytes ?? TWO_D_OCR_LIMITS.maxImageBytes, maxImagePixels: capabilities?.maxImagePixels ?? TWO_D_OCR_LIMITS.maxImagePixels };
  function select(value: TwoDImageCrop) { setLocalCrop(value); latest.current.onSelection?.(value); }

  useEffect(() => {
    let active = true;
    const generation = ++lifecycle.current;
    const controller = new AbortController(); drag.current = null; setPreparing(false);
    const load = async () => {
      try {
        const image = file.image ?? await decodeStaticImage(file.bytes, controller.signal);
        if (!active) return;
        setDisplay({ id: file.id, image });
        const full = fullImageCrop(image.metadata); setLocalCrop(full);
        // Parent owns restored selections; a new source starts with the whole image.
        if (controlledCrop === undefined) latest.current.onSelection?.(full);
        setZoom(Math.min(1, Math.max(.01, (scroll.current?.clientWidth ?? image.metadata.width) / image.metadata.width)));
        if (delivered.current.has(file.id)) return;
        const reason = imageCropLimitReason(full, limits);
        let selection: TwoDImageSelection | undefined, unavailableReason = reason;
        if (!reason) {
          try { selection = await imageSelectionPng(image, full, limits); }
          catch (cause) { unavailableReason = cause instanceof Error ? cause.message : String(cause); }
        }
        if (!active || currentFile.current !== file.id || delivered.current.has(file.id)) return;
        delivered.current.add(file.id);
        latest.current.onDecoded?.({ metadata: image.metadata, selection, unavailableReason });
      } catch (cause) { if (active) latest.current.onError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void load();
    return () => { active = false; if (lifecycle.current === generation) lifecycle.current++; controller.abort(); drag.current = null; };
    // A source is decoded once; capability polling and callbacks never restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  useEffect(() => {
    if (!decoded || !host.current) return;
    const canvas = decoded.canvas; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', '原始结构图片 ' + file.name);
    host.current.appendChild(canvas);
    return () => { canvas.remove(); };
  }, [decoded, file.name]);
  function point(clientX: number, clientY: number) {
    const bounds = decoded!.canvas.getBoundingClientRect(), size = decoded!.metadata;
    return { x: Math.max(0, Math.min(size.width, (clientX - bounds.left) / bounds.width * size.width)),
      y: Math.max(0, Math.min(size.height, (clientY - bounds.top) / bounds.height * size.height)) };
  }
  async function recognize() {
    if (busy || preparing || !decoded || !crop || capability?.status !== 'ready') return;
    const selected = { ...crop }, sourceId = file.id, generation = lifecycle.current;
    setPreparing(true);
    try {
      const selection = await imageSelectionPng(decoded, selected, limits);
      if (currentFile.current === sourceId && lifecycle.current === generation) latest.current.onRecognize(selection);
    } catch (cause) { if (currentFile.current === sourceId && lifecycle.current === generation) latest.current.onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (currentFile.current === sourceId && lifecycle.current === generation) setPreparing(false); }
  }
  const style = decoded ? { width: decoded.metadata.width * zoom } as CSSProperties : undefined;
  return <aside className="two-d-image-source" data-testid="two-d-image-source"
    data-source-mime={decoded?.metadata.mime} data-source-orientation={decoded?.metadata.orientation}
    data-source-bit-depth={decoded?.metadata.bitDepth} data-source-width={decoded?.metadata.sourceWidth}
    data-source-height={decoded?.metadata.sourceHeight} data-display-width={decoded?.metadata.width} data-display-height={decoded?.metadata.height}>
    <strong>原图</strong>
    <div className="two-d-image-controls">
      <button title="整图" aria-label="整图" disabled={!decoded} onClick={() => decoded && select(fullImageCrop(decoded.metadata))}><TwoDIcon name="fit"/></button>
      <button title="识别选区" aria-label="识别选区" disabled={busy || preparing || !decoded || !crop || crop.width < 2 || crop.height < 2 || capability?.status !== 'ready'} className="button button-primary" onClick={() => void recognize()}><TwoDIcon name="image"/></button>
      <button title="缩小原图" aria-label="缩小原图" disabled={!decoded || zoom <= .01} onClick={() => setZoom(value => Math.max(.01, value / 1.25))}>−</button>
      <span className="two-d-image-zoom">{Math.round(zoom * 100)}%</span>
      <button title="放大原图" aria-label="放大原图" disabled={!decoded || zoom >= 4} onClick={() => setZoom(value => Math.min(4, value * 1.25))}>＋</button>
    </div>
    <div className="two-d-image-scroll" ref={scroll}><div className="two-d-image-stage" style={style}
      onPointerDown={event => { if (!decoded || event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); const start = point(event.clientX, event.clientY); drag.current = { pointer: event.pointerId, start, before: crop }; select(normalizeImageCrop(start, start, decoded.metadata.width, decoded.metadata.height)); }}
      onPointerMove={event => { const current = drag.current; if (!current || current.pointer !== event.pointerId || !decoded) return; select(normalizeImageCrop(current.start, point(event.clientX, event.clientY), decoded.metadata.width, decoded.metadata.height)); }}
      onPointerUp={event => { if (drag.current?.pointer !== event.pointerId) return; drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { const previous = drag.current?.before; drag.current = null; if (previous) select(previous); }}
      onPointerCancel={() => { const previous = drag.current?.before; drag.current = null; if (previous) select(previous); }}>
      <div className="two-d-image-pixels" ref={host} />
      {decoded && crop && <div className="two-d-image-crop" style={{ left: `${crop.x / decoded.metadata.width * 100}%`, top: `${crop.y / decoded.metadata.height * 100}%`, width: `${crop.width / decoded.metadata.width * 100}%`, height: `${crop.height / decoded.metadata.height * 100}%` }} />}
    </div></div>
    {crop && <small>选区 {crop.width} × {crop.height} 像素</small>}
    {decoded && imageCropLimitReason(fullImageCrop(decoded.metadata), limits) && <small>{imageCropLimitReason(fullImageCrop(decoded.metadata), limits)}</small>}
    {capability?.status !== 'ready' && <div className="two-d-image-component"><p>{capability?.message || 'MolVec识别组件尚未就绪。'}</p><button disabled={busy || preparing} onClick={onChooseComponent}>选择离线识别组件</button></div>}
  </aside>;
}
