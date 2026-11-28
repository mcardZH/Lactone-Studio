import type { ScientificData, VibrationMode, Vibrations } from '../results/scientific-contracts';
import type { ProjectAssetReader, ProjectAssetWriter } from './result-snapshot';
import { readNumericRows, writeNumericRows, type NumericRowsAsset } from './numeric-row-assets';

type ModeRows = NonNullable<VibrationMode['displacements']>;
interface VibrationBlock {
  slots: { index: number; rows: number }[];
  values: NumericRowsAsset;
}
export interface VibrationAssets {
  primary?: number;
  sets?: (number | null)[];
  blocks: VibrationBlock[];
}

export function extractVibrationDisplacements(science: ScientificData) {
  const blocks: { slots: VibrationBlock['slots']; rows: ModeRows[]; rowCount: number }[] = [];
  const seen = new Map<Vibrations, { metadata: Vibrations; index: number | null }>();
  const extract = (group: Vibrations) => {
    const existing = seen.get(group);
    if (existing) return existing;
    const slots: VibrationBlock['slots'] = [], rows: ModeRows[] = [];
    let rowCount = 0;
    const modes = group.modes.map((mode, index) => {
      if (!mode.displacements?.length) return mode;
      const { displacements, ...metadata } = mode;
      slots.push({ index, rows: displacements.length }); rows.push(displacements);
      rowCount += displacements.length;
      return metadata;
    });
    const entry = { metadata: group, index: null as number | null };
    if (slots.length) {
      entry.metadata = { ...group, modes };
      entry.index = blocks.push({ slots, rows, rowCount }) - 1;
    }
    seen.set(group, entry);
    return entry;
  };
  const primary = science.vibrations ? extract(science.vibrations) : undefined;
  const sets = science.vibrationSets?.map(extract);
  if (!blocks.length) return undefined;
  return {
    science: { ...science, ...(primary ? { vibrations: primary.metadata } : {}), ...(sets ? { vibrationSets: sets.map(group => group.metadata) } : {}) },
    async write(writer: ProjectAssetWriter): Promise<VibrationAssets> {
      const values: VibrationBlock[] = [];
      for (const block of blocks) {
        function* displacements() { for (const mode of block.rows) yield* mode; }
        values.push({ slots: block.slots, values: await writeNumericRows(writer, 'vibration-displacements.f64', displacements(), block.rowCount, 3) });
      }
      return { ...(primary?.index != null ? { primary: primary.index } : {}), ...(sets ? { sets: sets.map(group => group.index) } : {}), blocks: values };
    },
  };
}

export async function restoreVibrationDisplacements(science: ScientificData | undefined, assets: VibrationAssets,
  reader: ProjectAssetReader, decoded = new Map<string, ModeRows>()): Promise<ScientificData> {
  const invalid = () => new Error('项目振动方向资产与原振动归属不一致，原有记录已保留。');
  if (!science || !Array.isArray(assets?.blocks) || !assets.blocks.length ||
      assets.sets !== undefined && (!Array.isArray(assets.sets) || assets.sets.length !== science.vibrationSets?.length)) throw invalid();
  const frames = new Map<number, { slots: VibrationBlock['slots']; rows: number }>();
  const inspect = (group: Vibrations | undefined, index: number | null | undefined) => {
    if (index == null) return;
    if (!group || !Number.isSafeInteger(index) || index < 0 || !Array.isArray(group.modes)) throw invalid();
    const block = assets.blocks[index];
    if (!block || !Array.isArray(block.slots) || !block.slots.length) throw invalid();
    let rows = 0, prior = -1;
    for (const slot of block.slots) {
      const mode = group.modes[slot?.index];
      if (!Number.isSafeInteger(slot?.index) || slot.index <= prior || !mode || mode.displacements !== undefined ||
          !Number.isSafeInteger(slot.rows) || slot.rows < 1) throw invalid();
      prior = slot.index; rows += slot.rows;
    }
    if (!Number.isSafeInteger(rows)) throw invalid();
    frames.set(index, { slots: block.slots, rows });
  };
  inspect(science.vibrations, assets.primary);
  assets.sets?.forEach((index, position) => inspect(science.vibrationSets![position], index));
  if (frames.size !== assets.blocks.length) throw invalid();
  const read = new Map<number, Map<number, ModeRows>>();
  for (const [index, frame] of frames) {
    const asset = assets.blocks[index].values;
    // One project index may contain the same immutable source and display
    // projection. Reuse rows only for a fully identical descriptor and shape.
    const key = JSON.stringify([asset, frame.rows, 3]);
    let coordinates = decoded.get(key);
    if (!coordinates) {
      coordinates = await readNumericRows(reader, asset, { rows: frame.rows, columns: 3 }) as ModeRows;
      for (const xyz of coordinates) Object.freeze(xyz);
      decoded.set(key, coordinates);
    }
    let offset = 0;
    read.set(index, new Map(frame.slots.map(slot => {
      const values = coordinates.slice(offset, offset + slot.rows);
      Object.freeze(values);
      offset += slot.rows;
      return [slot.index, values];
    })));
  }
  const restore = (group: Vibrations, index: number | null | undefined) => {
    if (index == null) return group;
    const values = read.get(index)!;
    return { ...group, modes: group.modes.map((mode, position) => !values.has(position) ? mode : { ...mode, displacements: values.get(position)! }) };
  };
  return { ...science, ...(science.vibrations ? { vibrations: restore(science.vibrations, assets.primary) } : {}),
    ...(science.vibrationSets ? { vibrationSets: science.vibrationSets.map((group, index) => restore(group, assets.sets?.[index])) } : {}) };
}
