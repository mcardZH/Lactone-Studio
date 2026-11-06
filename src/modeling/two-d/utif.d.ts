declare module 'utif' {
  interface TiffImage { width?: number; height?: number; data?: Uint8Array; [tag: string]: unknown }
  const UTIF: {
    decode(buffer: ArrayBuffer): TiffImage[];
    decodeImage(buffer: ArrayBuffer, image: TiffImage): void;
    toRGBA8(image: TiffImage): Uint8Array;
  };
  export default UTIF;
}
