import type { Structure } from '../../core/types';
import { createModelStore, getMovableAtomIds } from '../../core/modeling';
import type { ChemistryPort, ChemistryJob, ChemistryResult, FragmentSnapshot } from '../contracts';
import type { ScientificSourceFile } from '../../results/input-file';
import { detectTwoDFormat } from '../two-d';
import type { TwoDSourceInput } from '../two-d/types';
import type { DecodedTwoDImage, TwoDImageMime } from '../two-d/image-types';
import { twoDImageMime } from '../two-d/static-image';
import { decodeStaticImage } from '../two-d/static-image-decode';
export { twoDImageMime } from '../two-d/static-image';

/** A temporary import owns a frozen copy, not a path into a customer project. */
export interface TwoDImportFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  kind: 'structure' | 'image';
  mime?: TwoDImageMime;
  /** Session-only decoded display. Never store canvas objects as formal provenance. */
  image?: DecodedTwoDImage;
  source?: TwoDSourceInput;
}

const MAX_TWO_D_BYTES = 32 * 1024 ** 2;
const namedTwoD = (name: string) => /\.(?:cdx|cdxml|png|jpe?g|bmp|tiff?|webp|gif)$/i.test(name);

/** Ordinary model/result import keeps its existing routing, including MOL/SDF. */
export async function isTwoDImportFile(file: ScientificSourceFile): Promise<boolean> {
  if (namedTwoD(file.name)) return true;
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return false;
  const prefix = new Uint8Array(await file.slice(0, Math.min(file.size, 4096)).arrayBuffer());
  const format = detectTwoDFormat(prefix);
  return format === 'cdx' || format === 'cdxml' || Boolean(twoDImageMime(prefix));
}

/** Explicit 2D import may also accept the editor's MOL/KET exchange formats. */
export async function readTwoDImportFile(file: ScientificSourceFile, signal?: AbortSignal): Promise<TwoDImportFile> {
  const guard = () => { if (signal?.aborted) throw new Error('二维文件载入已取消。'); };
  guard();
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('二维文件为空或字节数无效。');
  if (file.size > MAX_TWO_D_BYTES) throw new Error('二维文件超过32 MiB，请选取单个图纸或裁剪后的图片。');
  const bytes = new Uint8Array(await file.slice(0, file.size).arrayBuffer()).slice();
  guard();
  if (bytes.length !== file.size) throw new Error('二维文件读取不完整，未创建草稿。');
  const id = `two-d-${crypto.randomUUID()}`, mime = twoDImageMime(bytes);
  if (mime) {
    const image = await decodeStaticImage(bytes, signal); guard();
    return { id, name: file.name, bytes, kind: 'image', mime, image };
  }
  const format = detectTwoDFormat(bytes);
  if (!format) throw new Error('未读到支持的CDX/CDXML、MOL/KET或静态PNG/JPEG/BMP/TIFF/WebP/GIF内容，请检查原文件。');
  return { id, name: file.name, bytes, kind: 'structure', source: { id, name: file.name, format, data: bytes.slice() } };
}

/** Generation owns only a temporary model. The caller owns the final commit. */
export function generateTwoDFragment(structure: Structure, options: {
  port: ChemistryPort;
  signal?: AbortSignal;
  guard(): void;
  onJob?(job: ChemistryJob | null): void;
}): Promise<{ fragment: FragmentSnapshot; result: ChemistryResult }> {
  return (async () => {
    const guard = () => { if (options.signal?.aborted) throw new Error('三维生成已取消。'); options.guard(); };
    guard();
    const temporary = createModelStore(structuredClone(structure));
    temporary.execute({ type: 'prepare-2d-hydrogens' });
    const prepared = temporary.getSnapshot(), movableAtomIds = getMovableAtomIds(prepared, 'all');
    const job = options.port.start({ stamp: temporary.stamp(movableAtomIds), operation: 'generate3d',
      structure: prepared.draft.structure, movableAtomIds });
    const cancel = () => job.cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    options.onJob?.(job);
    try {
      if (options.signal?.aborted) cancel();
      const result = await job.promise;
      guard();
      temporary.acceptCoordinates(result);
      const completed = temporary.getSnapshot();
      return { fragment: { structure: completed.draft.structure, assignments: completed.draft.assignments,
        auxiliaryRelations: [], deletedBonds: [] }, result };
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      options.onJob?.(null);
    }
  })();
}
