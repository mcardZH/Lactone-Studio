import type { Structure } from '../../core/types';

interface StructureImportPorts {
  delegate?: (files: File[]) => Promise<void>;
  load(files: File[]): Promise<Structure[]>;
  begin(): number;
  isCurrent(sequence: number): boolean;
  busy(value: boolean): void;
  guardChange(action: () => void): void;
  commit(structures: Structure[]): void;
  error(message: string): void;
}

/** The caller retains the operation sequence and draft-confirmation owner.
 * A late loader or confirmation cannot install into a replacement import. */
export async function importAppStructures(files: File[], ports: StructureImportPorts): Promise<void> {
  if (ports.delegate) { await ports.delegate(files); return; }
  const sequence = ports.begin();
  ports.busy(true);
  try {
    const parsed = await ports.load(files);
    if (!ports.isCurrent(sequence)) return;
    ports.guardChange(() => { if (ports.isCurrent(sequence)) ports.commit(parsed); });
  } catch (cause) {
    if (ports.isCurrent(sequence)) ports.error(`导入失败，原结构已保留：${(cause as Error).message}`);
  } finally {
    if (ports.isCurrent(sequence)) ports.busy(false);
  }
}
