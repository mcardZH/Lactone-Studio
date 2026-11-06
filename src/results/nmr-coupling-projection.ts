import type { NmrCouplingBlock, NmrCouplingNucleus, NmrCouplingValue, ScientificData } from './scientific-contracts';

type Source = { id: string; name: string };
type Data = Pick<ScientificData, 'nmrCouplings' | 'source'>;
/** Structurally compatible with the shared scientific table, without a domain→UI import. */
export interface NmrCouplingTableProjection {
  columns: { key: string; label: string; precision?: 'source' }[];
  rows: { key: string; cells: string[] }[];
}
const clean = (value: unknown) => String(value ?? '').replace(/[\t\r\n]/g, ' ');
const nucleusText = (nucleus: NmrCouplingNucleus) => nucleus.rawLabel + (nucleus.isotope && nucleus.isotope.rawLabel !== nucleus.rawLabel ? ` [${nucleus.isotope.rawLabel}]` : '');
function valueSource(block: NmrCouplingBlock, value: NmrCouplingValue, fallback: Source): Source {
  const id = value.sourceId ?? block.sourceId ?? fallback.id;
  const name = value.sourceName ?? (id === block.sourceId ? block.sourceName : undefined) ?? (id === fallback.id ? fallback.name : undefined) ?? '来源名未记录';
  return { id, name };
}
function* couplingRows(data: Data, fallback: Source, currentIndex?: number) {
  const source = data.source ?? fallback;
  for (const [blockIndex, block] of (data.nmrCouplings ?? []).entries()) {
    if (currentIndex !== undefined && block.frameIndex !== null && block.frameIndex !== currentIndex) continue;
    for (const [valueIndex, value] of block.values.entries()) yield { block, value, origin: valueSource(block, value, source), blockIndex, valueIndex };
  }
}
/** A source pair and a source scalar produce exactly one row. No mirroring,
 * component completion, symmetrisation, isotope defaults or K/J conversion. */
export function nmrCouplingTableProjection(data: Data, fallback: Source, currentIndex?: number): NmrCouplingTableProjection {
  return { columns: [{ key: 'nucleus-a', label: '核1' }, { key: 'nucleus-b', label: '核2' }, { key: 'quantity', label: '量 / 分项' }, { key: 'component', label: '分量' }, { key: 'value', label: '值', precision: 'source' }, { key: 'unit', label: '单位' }, { key: 'source', label: '来源' }],
    rows: [...couplingRows(data, fallback, currentIndex)].map(({ block, value, origin, blockIndex, valueIndex }) => ({ key: `${origin.id}:${block.jobIndex}:${block.sourceLine}:${blockIndex}:${value.sourceLine}:${valueIndex}`, cells: [nucleusText(block.pair[0]), nucleusText(block.pair[1]), [block.rawQuantityLabel || block.quantity, value.part].filter(Boolean).join(' · '), [value.component ? `${value.component.row}/${value.component.column}` : undefined, value.label].filter(Boolean).join(' · '), value.rawValue, value.rawUnit ?? value.unit ?? '单位未确认', `${origin.name} · ${value.sourceLine} · ${block.frameIndex === null ? '结构归属未确认' : `帧 ${block.frameIndex + 1}`}`] })) };
}
export function nmrCouplingAuditText(data: Data, fallback: Source, currentIndex?: number): string {
  const rows = ['quantity\traw_quantity\tform\tnucleus_a\ta_source_index\ta_index_base\ta_atom_index\ta_isotope\tnucleus_b\tb_source_index\tb_index_base\tb_atom_index\tb_isotope\tpart\trow\tcolumn\tlabel\tvalue\traw_value\tunit\traw_unit\tsource_name\tsource_id\tsource_line\tjob_index\tframe_index\tsource_frame_index\tstage_id\tblock_source_line\tblock_end_line\tvalue_start_byte\tvalue_end_byte\tunit_source_line\tmethod_label\tcomponent_basis'];
  for (const { block, value, origin } of couplingRows(data, fallback, currentIndex)) {
    const [a, b] = block.pair;
    rows.push([block.quantity, block.rawQuantityLabel, block.form, a.rawLabel, a.sourceIndex, a.indexBase, a.atomIndex, a.isotope?.rawLabel, b.rawLabel, b.sourceIndex, b.indexBase, b.atomIndex, b.isotope?.rawLabel, value.part, value.component?.row, value.component?.column, value.label, value.value, value.rawValue, value.unit, value.rawUnit, origin.name, origin.id, value.sourceLine, block.jobIndex, block.frameIndex, block.sourceFrameIndex ?? block.frameIndex, block.stageId, block.sourceLine, block.endLine, value.start, value.end, value.unitSourceLine, block.methodLabel, value.component?.basis].map(clean).join('\t'));
  }
  return rows.join('\n') + '\n';
}
/** Called only before publication. Explicit source slots are never overwritten by another file. */
export function bindNmrCouplingSource(blocks: readonly NmrCouplingBlock[] | undefined, source: Source): void {
  for (const block of blocks ?? []) {
    block.sourceId ??= source.id;
    if (!block.sourceName && block.sourceId === source.id) block.sourceName = source.name;
    for (const value of block.values) {
      value.sourceId ??= block.sourceId;
      if (!value.sourceName && value.sourceId === block.sourceId) value.sourceName = block.sourceName;
    }
  }
}
export function projectNmrCouplingFrames(blocks: readonly NmrCouplingBlock[] | undefined, indices: readonly (number | null)[]): NmrCouplingBlock[] | undefined {
  if (!blocks) return undefined;
  const mapping = new Map(indices.flatMap((original, index) => original === null ? [] : [[original, index] as const]));
  return blocks.flatMap(block => {
    if (block.frameIndex === null) return [block];
    const mapped = mapping.get(block.frameIndex);
    return mapped === undefined ? [] : [{ ...block, sourceFrameIndex: block.sourceFrameIndex ?? block.frameIndex, frameIndex: mapped }];
  });
}
/** Immutable publication copies only this optional branch; raw parser rows stay owned by their source. */
export function publishNmrCouplings(blocks: readonly NmrCouplingBlock[]): NmrCouplingBlock[] {
  return Object.freeze(blocks.map(block => Object.freeze({ ...block,
    pair: Object.freeze(block.pair.map(nucleus => Object.freeze({ ...nucleus, ...(nucleus.isotope ? { isotope: Object.freeze({ ...nucleus.isotope }) } : {}) }))),
    values: Object.freeze(block.values.map(value => Object.freeze({ ...value, ...(value.component ? { component: Object.freeze({ ...value.component }) } : {}) }))),
  }))) as unknown as NmrCouplingBlock[];
}
