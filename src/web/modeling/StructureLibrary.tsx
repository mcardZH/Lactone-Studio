import {DismissibleNotice} from '../DismissibleNotice';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { Structure, Vector3 } from '../../core/types';
import type { DisplaySettings } from '../../modeling/contracts';
import { createStructureLibraryClient, searchStructureLibrary, STRUCTURE_LIBRARY_CATEGORIES, structureLibraryCellLabel, type StructureLibraryCatalog, type StructureLibraryCategory, type StructureLibraryClient, type StructureLibraryEntry } from '../../modeling/structure-library';
import DialogShell from '../DialogShell';
import Fragment3DPreview from './Fragment3DPreview';
import { cellSegments } from './render/geometry';
import { elementColor } from './render/element-colors';
import { structureLibraryPreviewSnapshot, structureLibraryPreviewSummary } from './StructureLibraryPreview';
import './structure-library.css';

const defaultClient = createStructureLibraryClient();
const PAGE_SIZE = 24;
export interface StructureLibraryProps {
  onClose(): void;
  onLoad(entry: StructureLibraryEntry, snapshot: Structure): void | Promise<void>;
  display?: DisplaySettings;
  client?: StructureLibraryClient;
}
function useLibrarySnapshot(entry: StructureLibraryEntry | undefined, client: StructureLibraryClient, preview = false) {
  const [state, setState] = useState<{ entryId: string; structure: Structure | null; error: string }>({ entryId: '', structure: null, error: '' });
  useEffect(() => {
    let current = true;
    if (!entry) return;
    setState({ entryId: entry.id, structure: null, error: '' });
    void (preview ? client.preview(entry) : client.structure(entry)).then(structure => { if (current) setState({ entryId: entry.id, structure, error: '' }); }, error => { if (current) setState({ entryId: entry.id, structure: null, error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [entry, client, preview]);
  return state.entryId === entry?.id ? state : { entryId: entry?.id ?? '', structure: null, error: '' };
}
/** A cheap fixed projection of the same display-only neighborhood as the live
 * library preview. No viewer, bond perception or source-coordinate edit. */
export function StructureLibraryThumbnail({ structure, display }: { structure: Structure; display?: DisplaySettings }) {
  const graphic = useMemo(() => {
    const preview = structureLibraryPreviewSnapshot(structure), drawing = preview.structure;
    const project = ([x, y, z]: Vector3) => { const yaw = .55, pitch = -.35, u = x * Math.cos(yaw) + z * Math.sin(yaw), w = -x * Math.sin(yaw) + z * Math.cos(yaw); return { x: u, y: -y * Math.cos(pitch) + w * Math.sin(pitch), depth: y * Math.sin(pitch) + w * Math.cos(pitch) }; };
    const atoms = drawing.atoms.map(atom => ({ ...project([atom.x, atom.y, atom.z]), element: atom.element }));
    const edges = drawing.cell ? cellSegments(drawing.cell,preview.cellPresentation).map(edge => edge.map(project)) : [];
    const points = [...atoms, ...edges.flat()], xs = points.map(point => point.x), ys = points.map(point => point.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), scale = Math.min(156 / Math.max(x1 - x0, 1), 88 / Math.max(y1 - y0, 1));
    const transform = (point: { x: number; y: number }) => ({ x: 90 + (point.x - (x0 + x1) / 2) * scale, y: 56 + (point.y - (y0 + y1) / 2) * scale });
    // Paths group thousands of real atoms without thousands of SVG DOM objects.
    const groups = new Map<string, string[]>(), radius = Math.max(1.15, Math.min(3.3, 14 / Math.sqrt(Math.max(1, atoms.length) / 4)));
    for (const atom of atoms.sort((a, b) => a.depth - b.depth)) { const point = transform(atom), color = elementColor(atom.element, display?.elementColors), commands = groups.get(color) ?? []; commands.push(`M${(point.x - radius).toFixed(2)},${point.y.toFixed(2)}a${radius},${radius} 0 1,0 ${2 * radius},0a${radius},${radius} 0 1,0 ${-2 * radius},0`); groups.set(color, commands); }
    return { groups: [...groups].map(([color, path]) => ({ color, path: path.join('') })), cell: edges.map(([a, b]) => { const start = transform(a), end = transform(b); return `M${start.x},${start.y}L${end.x},${end.y}`; }).join(''), displayAtomCount: preview.displayAtomCount };
  }, [structure, display?.elementColors]);
  return <svg viewBox="0 0 180 112" role="img" aria-label={`${structure.name}真实结构缩略图`} data-atom-count={structure.atoms.length} data-display-atom-count={graphic.displayAtomCount}>
    <path d={graphic.cell} fill="none" stroke="var(--ui-control-muted)" strokeWidth=".7" opacity=".5"/>
    {graphic.groups.map(group => <path key={group.color} d={group.path} fill={group.color} stroke="#526879" strokeWidth=".28"/>)}
  </svg>;
}
function LibraryCard({ entry, selected, client, display, onSelect }: { entry: StructureLibraryEntry; selected: boolean; client: StructureLibraryClient; display?: DisplaySettings; onSelect(): void }) {
  const snapshot = useLibrarySnapshot(entry, client);
  return <button type="button" className="structure-library-card" data-library-entry={entry.id} aria-pressed={selected} onClick={onSelect}>
    <span className="structure-library-thumb">{snapshot.structure ? <StructureLibraryThumbnail structure={snapshot.structure} display={display}/> : <span className="structure-library-thumb-state">{snapshot.error ? '预览不可用' : '读取结构…'}</span>}</span>
    <span className="structure-library-card-copy"><strong>{entry.name}</strong><span>{entry.formula} · {entry.source.structureKind === 'derived' && entry.category === 'two-dimensional' ? '派生单层' : entry.phase}</span><span className="structure-library-card-source">{sourceRecordLabel(entry)}</span></span>
  </button>;
}
const sourceKindLabels = { experimental: '实验结构', computed: '计算结构', curated: '整理结构', derived: '派生结构' };
function sourceRecordLabel(entry: StructureLibraryEntry) {
  const name = entry.source.name === 'Crystallography Open Database (COD)' ? 'COD' : entry.source.name === 'NOMAD Repository' ? 'NOMAD' : entry.source.name;
  return `${name} ${entry.source.recordId}`;
}
export function StructureLibraryDetails({ entry, structure, previewStructure, previewError = '', error = '', pending = false, display, onLoad }: { entry: StructureLibraryEntry; structure: Structure | null; previewStructure?: Structure | null; previewError?: string; error?: string; pending?: boolean; display?: DisplaySettings; onLoad(): void }) {
  const cell = structure ? structureLibraryCellLabel(structure) : null;
  const drawing = previewStructure === undefined ? structure : previewStructure;
  const preview = useMemo(() => drawing ? structureLibraryPreviewSnapshot(drawing) : null, [drawing]);
  const derived = entry.source.structureKind === 'derived';
  return <aside className="structure-library-detail" data-testid="structure-library-detail" data-entry-id={entry.id} data-preview-bond-count={preview?.structure.bonds?.length ?? 0} data-source-atom-count={structure?.atoms.length ?? 0} data-preview-atom-count={preview?.displayAtomCount ?? 0} aria-label="结构详情">
    <header><h3>{entry.name}</h3><span>{entry.nameEn} · {entry.formula}</span></header>
    <p className="structure-library-source-line" data-testid="structure-library-source">{derived && <span>{entry.category === 'two-dimensional' ? '派生单层' : '派生结构'} · 母体 </span>}<a href={entry.source.url} target="_blank" rel="noreferrer">{sourceRecordLabel(entry)}</a>{entry.source.doi && <> · <a href={`https://doi.org/${entry.source.doi}`} target="_blank" rel="noreferrer" title={entry.source.doi}>DOI</a></>}</p>
    <div className="structure-library-preview">{preview ? <Fragment3DPreview snapshot={preview.structure} sourceKey={`library:${entry.id}`} kind="crystal" cellPresentation={preview.cellPresentation} display={display} height={218} summary={structureLibraryPreviewSummary(preview)}/> : <p role={error || previewError ? 'alert' : 'status'}>{error || previewError || '读取结构…'}</p>}</div>
    <dl className="structure-library-properties"><dt>结构版本</dt><dd>{entry.phase}</dd><dt>空间群</dt><dd>{entry.spaceGroup ? `${entry.spaceGroup.symbol}${entry.spaceGroup.number === undefined ? '' : `（${entry.spaceGroup.number}）`}` : '—'}</dd><dt>晶体点群</dt><dd>{entry.pointGroup ?? '—'}</dd><dt>a / b / c</dt><dd>{cell?.lengths ?? '—'}</dd><dt>α / β / γ</dt><dd>{cell?.angles ?? '—'}</dd><dt>周期方向</dt><dd>{structure ? structure.cell?.pbc.map((periodic, axis) => periodic ? ['a', 'b', 'c'][axis] : null).filter(Boolean).join(' / ') || '无' : '—'}</dd></dl>
    <details className="structure-library-reference"><summary>参考物性</summary><dl className="structure-library-properties"><dt>带隙</dt><dd>{entry.bandGap ? <>{entry.bandGap.value} eV<br/><span>{entry.bandGap.method}</span><br/><a href={entry.bandGap.source.url} target="_blank" rel="noreferrer">{entry.bandGap.source.name}</a></> : '—'}</dd></dl></details>
    <details className="structure-library-reference"><summary>来源与处理</summary><dl className="structure-library-properties"><dt>来源</dt><dd><a href={entry.source.url} target="_blank" rel="noreferrer">{entry.source.name} · {entry.source.recordId}</a></dd><dt>来源类型</dt><dd>{sourceKindLabels[entry.source.structureKind]}</dd><dt>许可</dt><dd><a href={entry.source.licenseUrl} target="_blank" rel="noreferrer">{entry.source.license}</a></dd>{entry.source.version && <><dt>来源版本</dt><dd>{entry.source.version}</dd></>}{entry.source.conditions && <><dt>条件</dt><dd>{entry.source.conditions}</dd></>}{entry.source.citation && <><dt>文献</dt><dd>{entry.source.citation}</dd></>}<dt>规范化</dt><dd>{entry.normalization.method}{entry.normalization.details?.length ? <ul>{entry.normalization.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul> : null}</dd></dl></details>
    <div className="structure-library-detail-actions"><button type="button" className="button button-primary" disabled={!structure || Boolean(error) || pending} onClick={onLoad}>{pending ? '正在载入…' : '载入为新模型'}</button></div>
  </aside>;
}
export default function StructureLibrary({ onClose, onLoad, display, client = defaultClient }: StructureLibraryProps) {
  const [catalog, setCatalog] = useState<StructureLibraryCatalog | null>(null), [failure, setFailure] = useState(''), [query, setQuery] = useState(''), [category, setCategory] = useState<StructureLibraryCategory | 'all'>('all'), [selectedId, setSelectedId] = useState(''), [page, setPage] = useState(0), [pending, setPending] = useState(false);
  const search = useRef<HTMLInputElement>(null), mounted = useRef(true), title = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { let current = true; setCatalog(null); setFailure(''); void client.catalog().then(value => { if (current) setCatalog(value); }, error => { if (current) setFailure(error instanceof Error ? error.message : String(error)); }); return () => { current = false; }; }, [client]);
  const entries = catalog?.entries ?? [], filtered = useMemo(() => searchStructureLibrary(entries, query, category), [entries, query, category]), selected = filtered.find(entry => entry.id === selectedId) ?? filtered[0];
  const snapshot = useLibrarySnapshot(selected, client), preview = useLibrarySnapshot(selected, client, true), pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), activePage = Math.min(page, pages - 1);
  const pageEntries = filtered.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE);
  async function load() {
    if (!selected || !snapshot.structure || snapshot.entryId !== selected.id || pending) return;
    setPending(true); setFailure('');
    try { await onLoad(structuredClone(selected), structuredClone(snapshot.structure)); if (mounted.current) onClose(); }
    catch (error) { if (mounted.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setPending(false); }
  }
  return <DialogShell className="structure-library-dialog" backdropClassName="structure-library-backdrop" data-testid="structure-library" aria-label="结构库" aria-labelledby={title} onCancel={onClose} initialFocus={() => search.current}>
    <header className="structure-library-header"><h2 id={title}>结构库</h2><button type="button" aria-label="关闭结构库" onClick={onClose}><X size={18}/></button></header>
    <div className="structure-library-search"><Search size={17} aria-hidden="true"/><input ref={search} type="search" aria-label="搜索名称、化学式或别名" placeholder="搜索名称、化学式或别名" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}/></div>
    {failure && <DismissibleNotice className="structure-library-error" role="alert">{failure}</DismissibleNotice>}
    <div className="structure-library-body"><nav className="structure-library-categories" aria-label="结构分类">{[{ id: 'all', label: '全部' } as const, ...STRUCTURE_LIBRARY_CATEGORIES.filter(item => item.id !== 'two-dimensional' && entries.some(entry => entry.category === item.id || entry.categories?.includes(item.id)))].map(item => <button type="button" key={item.id} aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setPage(0); }}>{item.label}</button>)}</nav>
      <section className="structure-library-gallery" aria-label="结构列表"><div className="structure-library-list-meta"><span>{category === 'all' ? '全部' : STRUCTURE_LIBRARY_CATEGORIES.find(item => item.id === category)?.label} · {filtered.length} 个结构</span>{pages > 1 && <span className="structure-library-pagination"><button type="button" aria-label="上一页结构" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>‹</button><span>{activePage + 1} / {pages}</span><button type="button" aria-label="下一页结构" disabled={activePage >= pages - 1} onClick={() => setPage(activePage + 1)}>›</button></span>}</div>
        {!catalog ? <p role="status">正在读取结构库…</p> : filtered.length ? <div className="structure-library-cards">{pageEntries.map((entry, index) => <Fragment key={entry.id}>{entry.family === 'carbon-nitrides' && pageEntries[index - 1]?.family !== entry.family && <h3 className="structure-library-group">g-C₃N₄ 与相关层状氮化碳</h3>}<LibraryCard entry={entry} selected={entry.id === selected?.id} client={client} display={display} onSelect={() => { setSelectedId(entry.id); setFailure(''); }}/></Fragment>)}</div> : <p className="structure-library-empty">没有匹配的结构</p>}
        {Boolean(catalog?.issues.length) && <details className="structure-library-load-issues"><summary>{catalog!.issues.length} 个分类读取异常</summary>{catalog!.issues.map(issue => <p key={issue.category}>{STRUCTURE_LIBRARY_CATEGORIES.find(item => item.id === issue.category)?.label}：{issue.message}</p>)}</details>}
      </section>
      {selected ? <StructureLibraryDetails entry={selected} structure={snapshot.structure} previewStructure={preview.structure} previewError={preview.error} error={snapshot.error} pending={pending} display={display} onLoad={() => { void load(); }}/> : <aside className="structure-library-detail structure-library-empty">选择结构查看详情</aside>}
    </div>
  </DialogShell>;
}
