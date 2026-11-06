import { useState, type ReactNode } from 'react';

const PAGE_SIZE = 100;
/** Bound visible tables independently of source inventory/export completeness. */
export function PagedScientificRows<T>({ rows, renderRow, columns = 5 }: { rows: readonly T[]; renderRow(row: T, index: number): ReactNode; columns?: number }) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), current = Math.min(page, pages - 1);
  return <><tbody>{rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((row, index) => renderRow(row, current * PAGE_SIZE + index))}</tbody>{pages > 1 && <tfoot><tr><td colSpan={columns}><button disabled={!current} onClick={() => setPage(current - 1)}>上一页</button><span> {current + 1} / {pages} · 共 {rows.length} 项 </span><button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</button></td></tr></tfoot>}</>;
}
export function PagedScientificList<T>({ rows, renderRow }: { rows: readonly T[]; renderRow(row: T, index: number): ReactNode }) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), current = Math.min(page, pages - 1);
  return <div>{rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((row, index) => renderRow(row, current * PAGE_SIZE + index))}{pages > 1 && <div><button disabled={!current} onClick={() => setPage(current - 1)}>上一页</button><span> {current + 1} / {pages} · 共 {rows.length} 项 </span><button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</button></div>}</div>;
}
