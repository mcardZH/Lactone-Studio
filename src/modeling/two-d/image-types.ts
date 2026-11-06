/** Original bytes remain owned by TwoDImportFile; these describe derived pixels only. */
export type TwoDImageMime = 'image/png' | 'image/jpeg' | 'image/bmp' | 'image/tiff' | 'image/webp' | 'image/gif';
export interface TwoDImageMetadata {
  mime: TwoDImageMime;
  format: 'png' | 'jpeg' | 'bmp' | 'tiff' | 'webp' | 'gif';
  sourceWidth: number;
  sourceHeight: number;
  /** Dimensions after EXIF/TIFF orientation, used by display and crop alike. */
  width: number;
  height: number;
  frameCount: 1;
  orientation: number;
  bitDepth: number;
  derivations: string[];
  compression?: number;
  photometric?: number;
}
export interface TwoDImageCrop {
  x: number; y: number; width: number; height: number; imageWidth: number; imageHeight: number;
}
export interface TwoDImageDerivation {
  coordinateSpace: 'oriented-display-pixels';
  mime: 'image/png';
  alphaBackground: 'white';
  bitDepth: 8;
  source: TwoDImageMetadata;
}
export interface TwoDImageSelection {
  bytes: Uint8Array;
  crop: TwoDImageCrop;
  derivation?: TwoDImageDerivation;
}
/** Session-only display allocation. Never serialize the canvas into an .es project. */
export interface DecodedTwoDImage {
  metadata: TwoDImageMetadata;
  canvas: HTMLCanvasElement;
}
export interface TwoDImageDecoded {
  metadata: TwoDImageMetadata;
  selection?: TwoDImageSelection;
  unavailableReason?: string;
}
export const TWO_D_OCR_LIMITS = { maxImageBytes: 20 * 1024 ** 2, maxImagePixels: 24_000_000, maxDimension: 16_000 } as const;
