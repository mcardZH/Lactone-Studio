import type { OcrBridge } from './contracts';

/** Optional desktop capability. A browser keeps ordinary 2D import available. */
export function ocrPort(): OcrBridge | undefined {
  const bridge = typeof window === 'undefined' ? undefined : window.sciyueDesktop;
  return bridge?.ocrCapabilities && bridge.ocrChooseComponent && bridge.ocrRecognize && bridge.ocrCancel
    ? bridge as OcrBridge : undefined;
}
