export type CaptureScientificImage = (ownerDocument: Document, signal: AbortSignal) => Blob | Promise<Blob>;

let latestPreparation: AbortController | undefined;
let latestBrowserWrite: Promise<void> | undefined;

/** Capture begins on the click turn, with the figure's own window and current
 * display. Only the destination consumes the resulting encoded image. */
export async function copyImageToClipboard(
  ownerDocument: Document, capture: CaptureScientificImage, ownerSignal: AbortSignal
): Promise<boolean> {
  const realm = ownerDocument.defaultView;
  if (!realm || realm.closed || ownerSignal.aborted) return false;
  latestPreparation?.abort();
  const preparation = new AbortController(), { signal } = preparation;
  latestPreparation = preparation;
  const cancel = () => preparation.abort();
  const cancelled = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  void cancelled.catch(() => undefined);
  ownerSignal.addEventListener('abort', cancel, { once: true });
  realm.addEventListener('pagehide', cancel, { once: true, signal });
  realm.addEventListener('beforeunload', cancel, { once: true, signal });
  // A React portal can render into an app-owned about:blank window without
  // preload. Its own document still captures, using this renderer's bridge.
  const desktop = realm.sciyueDesktop ?? (typeof window === 'undefined' ? undefined : window.sciyueDesktop);
  let reservation: Promise<number> | undefined;
  let token: number | undefined;
  let unsubscribe: (() => void) | undefined;
  let written = false;
  const capturePng = async () => {
    signal.throwIfAborted();
    const png = await Promise.race([capture(ownerDocument, signal), cancelled]);
    signal.throwIfAborted();
    if (!png.size || png.type !== 'image/png') throw new Error('当前图未生成有效 PNG。');
    return png;
  };
  try {
    if (desktop) {
      if (!desktop.beginImageClipboardCopy || !desktop.writeImageClipboard || !desktop.cancelImageClipboardCopy)
        throw new Error('当前环境无法写入图片剪贴板，可使用图像导出。');
      const superseded = new Set<number>();
      unsubscribe = desktop.onImageClipboardCopySuperseded?.(id => {
        if (id === token) cancel();
        else if (token === undefined) superseded.add(id);
      });
      reservation = desktop.beginImageClipboardCopy().then(id => {
        token = id;
        if (superseded.has(id)) cancel();
        return id;
      });
      const [id, png] = await Promise.all([reservation, capturePng()]);
      const bytes = new Uint8Array(await Promise.race([png.arrayBuffer(), cancelled]));
      if (realm.closed) cancel();
      signal.throwIfAborted();
      written = await Promise.race([desktop.writeImageClipboard(id, bytes), cancelled]);
    } else {
      const clipboard = realm.navigator.clipboard;
      if (!clipboard?.write || !realm.ClipboardItem) throw new Error('当前环境无法写入图片剪贴板，可使用图像导出。');
      const previous = latestBrowserWrite;
      const png = capturePng().then(async blob => {
        // If a previous browser commit already began, let it settle first.
        // The new intent owns the next payload even when capture is faster.
        await Promise.race([previous?.catch(() => undefined), cancelled]);
        if (realm.closed) cancel();
        signal.throwIfAborted();
        return blob;
      });
      // Pass a pending payload while the click still grants user activation.
      void png.catch(() => undefined);
      const write = clipboard.write([new realm.ClipboardItem({ 'image/png': png })]);
      latestBrowserWrite = write;
      void write.finally(() => {
        if (latestBrowserWrite === write) latestBrowserWrite = undefined;
      }).catch(() => undefined);
      await Promise.race([Promise.all([write, png]), cancelled]);
      written = true;
    }
    return written && !signal.aborted && !realm.closed;
  } catch (error) {
    if (signal.aborted) return false;
    throw error;
  } finally {
    cancel();
    ownerSignal.removeEventListener('abort', cancel);
    unsubscribe?.();
    if (latestPreparation === preparation) latestPreparation = undefined;
    if (desktop && !written && reservation) {
      // On capture failure the reservation can still be in transit. Its
      // cleanup can only cancel this exact intent, never a replacement.
      void reservation.then(id => desktop.cancelImageClipboardCopy?.(id)).catch(() => undefined);
    }
  }
}
