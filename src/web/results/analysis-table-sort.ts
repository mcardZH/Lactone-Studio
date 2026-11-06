import type { ScientificTableProjection } from './scientific-table';

export interface AnalysisTableSort { column: string; direction: 'asc' | 'desc' }
/** Sorting is a view projection over stable keys and full precision values. */
export function sortAnalysisTable(table: ScientificTableProjection, sort: AnalysisTableSort,
  value: (rowKey: string, column: string) => number | null | undefined): ScientificTableProjection {
  if (!sort.column) return table;
  return { ...table, rows: table.rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const av = value(a.row.key, sort.column), bv = value(b.row.key, sort.column);
    const af = av != null && Number.isFinite(av), bf = bv != null && Number.isFinite(bv);
    if (af !== bf) return af ? -1 : 1;
    return af && bf ? (av! - bv!) * (sort.direction === 'asc' ? 1 : -1) || a.index - b.index : a.index - b.index;
  }).map(({ row }) => row) };
}
