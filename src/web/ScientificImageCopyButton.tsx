import { useLayoutEffect, useRef, useState } from 'react';
import { DismissibleNotice } from './DismissibleNotice';
import { copyImageToClipboard, type CaptureScientificImage } from './image-clipboard';
import './scientific-image-copy.css';

export function ScientificImageCopyButton({ disabled, capture, resetKey }: {
  disabled?: boolean;
  capture: CaptureScientificImage;
  resetKey?: unknown;
}) {
  const job = useRef<AbortController | null>(null);
  const timer = useRef<{ owner: Window; id: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<{ detail: string } | null>(null);
  function clearTimer() {
    if (timer.current) timer.current.owner.clearTimeout(timer.current.id);
    timer.current = null;
  }
  useLayoutEffect(() => {
    setBusy(false);
    setCopied(false);
    setError(null);
    return () => {
      job.current?.abort();
      job.current = null;
      clearTimer();
    };
  }, [resetKey]);
  async function copy(ownerDocument: Document) {
    const owner = ownerDocument.defaultView;
    if (!owner || job.current) return;
    const controller = new AbortController();
    job.current = controller;
    clearTimer();
    setBusy(true);
    setCopied(false);
    setError(null);
    try {
      const success = await copyImageToClipboard(ownerDocument, capture, controller.signal);
      if (!success || job.current !== controller) return;
      setCopied(true);
      timer.current = { owner, id: owner.setTimeout(() => { timer.current = null; setCopied(false); }, 1800) };
    } catch (cause) {
      if (job.current === controller) setError({ detail: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (job.current === controller) { job.current = null; setBusy(false); }
    }
  }
  return <span className="scientific-image-copy" data-no-reorder onClick={event => event.stopPropagation()}>
    <button type="button" data-testid="copy-scientific-image" disabled={disabled || busy}
      onClick={event => { void copy(event.currentTarget.ownerDocument); }}>{busy ? '正在复制…' : '复制图片'}</button>
    {copied && <span role="status">图片已复制</span>}
    {error && <DismissibleNotice identity={error} onDismiss={() => setError(null)}>图片复制失败。{error.detail}</DismissibleNotice>}
  </span>;
}
