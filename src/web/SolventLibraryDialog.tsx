import { useId, useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { getSolventEntries, isCommonSolvent, searchSolvents, sortSolvents } from '../core/solvents';
import type { SolventEngine, SolventEntry, SolventModel, SolventSort } from '../core/solvents';
import './solvents.css';
import DialogShell from './DialogShell';

export interface SolventLibraryDialogProps {
  engine: SolventEngine; model: SolventModel; version?: '5' | '6.0' | '6.1' | 'common';
  currentId?: string; currentName?: string;
  onSelect: (entry: SolventEntry) => void;
  onClose: () => void;
}

export function solventDielectricLabel(entry: SolventEntry): string {
  return entry.dielectric !== null ? `ε ${entry.dielectric}` : entry.dielectricReference
    ? `参考 ε ${entry.dielectricReference.value}（${entry.dielectricReference.temperatureK} K）` : 'ε 未收录';
}

/** Browsing stays local until the user selects an exact reviewed entry. */
export default function SolventLibraryDialog({ engine, model, version, currentId, currentName, onSelect, onClose }: SolventLibraryDialogProps) {
  const titleId = useId(), search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(''), [sort, setSort] = useState<SolventSort>('common');
  const available = useMemo(() => getSolventEntries(engine, model, version, currentId), [engine, model, version, currentId]);
  const visible = useMemo(() => sortSolvents(searchSolvents(available, query), sort), [available, query, sort]);
  const incompatible = Boolean((currentId || currentName) && !available.some(entry => entry.id === currentId));
  return <DialogShell className="solvent-library-dialog catalog-popup" backdropClassName="solvent-library-backdrop" aria-labelledby={titleId} data-testid={`${engine}-solvent-library`}
    onCancel={onClose} initialFocus={()=>search.current} dismissOnBackdrop backdropDismissEvent="pointerdown">
      <header className="solvent-library-header"><div><h2 id={titleId}>溶剂目录</h2><span>{engine === 'gaussian' ? 'Gaussian' : 'ORCA'} · {model.toUpperCase()} · {visible.length}/{available.length} 项</span></div>
        <button type="button" className="solvent-library-close" aria-label="关闭溶剂目录" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="solvent-library-toolbar">
        <label className="solvent-library-search"><Search size={17} aria-hidden="true" /><input ref={search} aria-label={`${engine}搜索溶剂`} value={query} placeholder="中文 / English / DMSO / DCM" onChange={event => setQuery(event.target.value)} /></label>
        <label>排序<select aria-label={`${engine}溶剂排序`} value={sort} onChange={event => setSort(event.target.value as SolventSort)}><option value="common">常用优先</option><option value="dielectric-asc">ε 由小到大</option><option value="dielectric-desc">ε 由大到小</option><option value="name">名称</option></select></label>
      </div>
      <p className="solvent-library-note">常用为固定内置名单，不代表使用热度；参考 ε 仅用于浏览与排序，输入沿软件内置参数。</p>
      {incompatible && <p className="solvent-library-retained" role="alert">原选择 {currentName || currentId} 在当前软件、模型或版本中未核对，已保留；取消不会替换。</p>}
      <div className="solvent-library-grid" role="listbox" aria-label={`${engine}内置溶剂候选`} onKeyDown={event => {
        const target = event.target as HTMLElement;
        if (target.getAttribute('role') !== 'option' || !['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
        const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
        const current = cards.indexOf(target as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : (current + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + cards.length) % cards.length;
        event.preventDefault(); cards[next]?.focus();
      }}>
        {visible.map(entry => <button type="button" className={`solvent-library-card${entry.id === currentId ? ' selected' : ''}`} role="option" aria-selected={entry.id === currentId} key={entry.id} data-value={entry.id}
          onClick={() => { const reviewed = available.find(value => value.id === entry.id); if (reviewed) { onSelect(reviewed); onClose(); } }}>
          <span className="solvent-library-card-heading"><strong>{entry.chineseName}</strong>{entry.id === currentId ? <Check size={16} aria-hidden="true" /> : isCommonSolvent(entry) ? <small>常用</small> : null}</span>
          <span className="solvent-library-english">{entry.englishName}</span>
          <span className="solvent-library-epsilon" title={entry.dielectricReference?.source}>{solventDielectricLabel(entry)}</span>
          {version === 'common' && /^orca6\./.test(entry.id) && <small className="solvent-library-profile">来源 ORCA {entry.id.split(':')[0].slice(4)}</small>}
        </button>)}
        {!visible.length && <p className="solvent-library-empty">没有匹配的内置溶剂。试试中文名称、英文名称或缩写。</p>}
      </div>
      <footer className="solvent-library-footer"><span>点击卡片选择溶剂</span><button type="button" className="shared-input-action" onClick={onClose}>取消</button></footer>
  </DialogShell>;
}
