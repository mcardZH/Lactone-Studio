import { isEnergyUnit } from '../../results/energy';
import { decimalEnergyValue } from '../../results/numeric-format';

/** Display projection shared by the table, TXT and clipboard; no source data is mutated. */
export interface ScientificTableColumn {
  key: string;
  /** Complete single-line header for text export. */
  label: string;
  /** Optional first line when the screen header separates method and quantity. */
  heading?: string;
  /** Screen-only second header line; label retains the complete TXT identity. */
  headerUnit?: string;
  quantity?: 'net-charge' | 'spin-population' | 'electron-population' | 'bond-order' | 'bond-length';
  unit?: string;
  quantityLabel?: string;
  /** Original energies/thermochemistry keep their source token and unit. */
  precision?: 'source' | 'adjustable';
}
export interface ScientificTableRow { key: string; cells: readonly string[] }
export interface ScientificTableProjection { columns: readonly ScientificTableColumn[]; rows: readonly ScientificTableRow[] }
/** Energy columns and mixed-unit value rows share exact decimal screen/copy text. */
export function decimalEnergyTable(projection: ScientificTableProjection): ScientificTableProjection {
  const energyColumns = projection.columns.map(column => {
    const unit = column.unit ?? column.headerUnit ?? column.label.split(' / ').at(-1)?.replace(/[（(].*$/, '').trim();
    return isEnergyUnit(unit) || /energy/i.test(column.key) && /^(?:a\.?u\.?)$/i.test(unit ?? '');
  });
  const unitColumn = projection.columns.findIndex(column => column.key === 'unit');
  const valueColumn = projection.columns.findIndex(column => column.key === 'value');
  if (!energyColumns.some(Boolean) && (unitColumn < 0 || valueColumn < 0)) return projection;
  let changed = false;
  const rows = projection.rows.map(row => {
    const mixedEnergy = unitColumn >= 0 && isEnergyUnit(row.cells[unitColumn]);
    const cells = row.cells.map((cell, index) => {
      const value = energyColumns[index] || mixedEnergy && index === valueColumn ? decimalEnergyValue(cell) : cell;
      changed ||= value !== cell;
      return value;
    });
    return { ...row, cells };
  });
  return changed ? { ...projection, rows } : projection;
}
export interface TableCellAddress { row: number; column: number }
export interface TableSelection { anchor: TableCellAddress; end: TableCellAddress; kind?: 'cells' | 'columns' | 'rows' }
export interface ScientificTableFormat {
  decimals: number;
  onDecimalsChange(value: number): void;
  unit?: string;
  units?: readonly { value: string; label: string }[];
  onUnitChange?(value: string): void;
  /** Fixed-unit tables already identify units in their column headings. */
  hideUnit?: boolean;
  locked?: boolean;
  ariaLabel?: string;
}
export interface ScientificTableLayoutState {
  width?: number; height?: number; columnWidths?: readonly number[];
  /** Stable keys preserve manually sized columns when methods are added/reordered. */
  columnKeys?: readonly string[];
  /** Default height; individual stable row keys may override it. */
  rowHeight?: number;
  rowHeights?: Readonly<Record<string, number>>;
}
/** Display-only ordering, owned independently by each consuming table. */
export interface ScientificTableSorting {
  value: string;
  direction: 'asc' | 'desc';
  options: readonly { value: string; label: string }[];
  onChange(value: string, direction: 'asc' | 'desc'): void;
}
export function scientificTableHeader(column: ScientificTableColumn): string {
  return column.label.replace(/\s*\/\s*(?:无量纲|无单位|dimensionless)\s*$/i,'');
}
/** Default numeric columns share a width and fill half the card. The content
 * opt-in retains individual readable minima without stretching identifiers. */
export function scientificTableDefaultWidths(minima: readonly number[], numeric: readonly boolean[], availableWidth: number, actionWidth = 0, initialMinima?: readonly number[], numericColumnWidths:'uniform'|'content'='uniform'): number[] {
  const suggested = minima.map((value,index)=>Number.isFinite(initialMinima?.[index]) ? Math.max(value,initialMinima![index]) : value);
  if(numericColumnWidths==='content')return suggested;
  const shared = Math.max(0, ...suggested.filter((_, index) => numeric[index]));
  const widths = suggested.map((value, index) => numeric[index] ? shared : value);
  const natural = widths.reduce((sum, value) => sum + value, 0);
  const target = Math.max(natural, availableWidth / 2 - actionWidth - 2);
  return widths.map(value => natural ? value * target / natural : value);
}
export function scientificTableRetainedWidths(layout: ScientificTableLayoutState, keys: readonly string[], defaults: readonly number[]): number[] | undefined {
  if (!layout.columnWidths?.length) return undefined;
  return keys.map((key, index) => {
    const previous = layout.columnKeys ? layout.columnKeys.indexOf(key) : index;
    return previous >= 0 ? layout.columnWidths![previous] ?? defaults[index] ?? 48 : defaults[index] ?? 48;
  });
}
/** Resize actual cells, preserving their relative dimensions and readable minima. */
export function scientificTableScaleSizes(sizes: readonly number[], factor: number, minimum: number): number[] {
  const scale=Number.isFinite(factor)&&factor>0?factor:1;
  return sizes.map(size=>Math.max(minimum,(Number.isFinite(size)&&size>0?size:minimum)*scale));
}
export function scientificTableCellEdges(selection: TableSelection | null, row: number, column: number): string | undefined {
  if (!scientificTableCellSelected(selection,row,column)) return undefined;
  return [row===Math.min(selection!.anchor.row,selection!.end.row)?'top':'',row===Math.max(selection!.anchor.row,selection!.end.row)?'bottom':'',column===Math.min(selection!.anchor.column,selection!.end.column)?'left':'',column===Math.max(selection!.anchor.column,selection!.end.column)?'right':''].filter(Boolean).join(' ');
}
const textCell = (value: string) => value.replace(/[\t\r\n]/g, ' ');

/** A selected rectangle contains cells only; whole-table exports also include its header. */
export function scientificTableText(table: ScientificTableProjection, selection?: TableSelection): string {
  table = decimalEnergyTable(table);
  if (table.rows.some(row => row.cells.length !== table.columns.length)) throw new Error('表格显示投影的行列数不一致，未复制不完整数据。');
  if (!selection) return [table.columns.map(column => textCell(scientificTableHeader(column))).join('\t'), ...table.rows.map(row => row.cells.map(textCell).join('\t'))].join('\n') + '\n';
  const firstRow = Math.max(0, Math.min(selection.anchor.row, selection.end.row));
  const lastRow = Math.min(table.rows.length - 1, Math.max(selection.anchor.row, selection.end.row));
  const firstColumn = Math.max(0, Math.min(selection.anchor.column, selection.end.column));
  const lastColumn = Math.min(table.columns.length - 1, Math.max(selection.anchor.column, selection.end.column));
  if (lastRow < firstRow || lastColumn < firstColumn) return '';
  return table.rows.slice(firstRow, lastRow + 1).map(row => row.cells.slice(firstColumn, lastColumn + 1).map(textCell).join('\t')).join('\n');
}
export function scientificTableColumnSelected(selection: TableSelection | null, column: number): boolean {
  return selection?.kind === 'columns' && column >= Math.min(selection.anchor.column, selection.end.column) && column <= Math.max(selection.anchor.column, selection.end.column);
}
export function scientificTableCellSelected(selection: TableSelection | null, row: number, column: number): boolean {
  return !!selection && row >= Math.min(selection.anchor.row, selection.end.row) && row <= Math.max(selection.anchor.row, selection.end.row)
    && column >= Math.min(selection.anchor.column, selection.end.column) && column <= Math.max(selection.anchor.column, selection.end.column);
}
