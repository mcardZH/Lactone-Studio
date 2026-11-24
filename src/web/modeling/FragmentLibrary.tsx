import { FlaskConical, Hexagon, Link2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { BUILDER_TEMPLATES, builderTemplateCategory, builderTemplateFamily, getBuilderTemplate, type BuilderTemplate, type BuilderTemplateFamily } from '../../core/builder-templates';
import type { Structure } from '../../core/types';
import { FragmentSkeletalThumbnail } from './FragmentSkeletalThumbnail';
import './workbench-tools.css';
import {dialogSurfaceStyle} from '../DialogShell';
export type FragmentLibraryMode = 'attach' | 'replace' | 'independent';
export interface FragmentLibraryProps { selectedId: string; onSelect(id: string): void; onAction?(id: string, mode: FragmentLibraryMode, activeAtomIndex?:number): void; activeAtomIndex?:number; onActiveAtomChange?(index:number):void; pointerMode?:boolean; disabled?: boolean; canAttach?: boolean; canReplace?: boolean; canIndependent?: boolean; previewSnapshot?: Structure | null; previewSourceKey?: string; onPreviewRequest?(templateId: string): void;category?:'all'|'functional'|'ring'|'chain'; previewPlacement?:'popup'|'dock'; previewCompact?:boolean; defaultPreviewOpen?:boolean }
const familyLabels:Record<BuilderTemplateFamily,string>={O:'含氧',N:'含氮',S:'含硫',P:'含磷',B:'含硼',Si:'含硅',halogen:'卤素',charged:'带电基团',conjugated:'不饱和 / 共轭'};
export default function FragmentLibrary({ selectedId, onSelect, onAction, activeAtomIndex, pointerMode=false, disabled = false, canAttach = true, canReplace = true, canIndependent = true, onPreviewRequest,category:fixedCategory }: FragmentLibraryProps) {
  const [open, setOpen] = useState(false), [selectedCategory, setCategory] = useState('all');const category=fixedCategory??selectedCategory;
  const panelId = useId();
  const categoryTrigger = useRef<HTMLButtonElement>(null), libraryPanel = useRef<HTMLDivElement>(null);
  const categoryLabel = fixedCategory && fixedCategory !== 'all' ? ({ functional: '官能团', ring: '环', chain: '链段' } as const)[fixedCategory] : '片段';
  const CategoryIcon=fixedCategory==='ring'?Hexagon:fixedCategory==='chain'?Link2:FlaskConical;
  const closeLibrary = () => { setOpen(false); categoryTrigger.current?.focus({ preventScroll: true }); };
  // The workspace owns one persistent preview. Choosing a card updates that
  // source; the library must never create another preview window or camera.
  const selectEntry = (id: string) => { if (fixedCategory) setOpen(false); onSelect(id); onPreviewRequest?.(id); };
  useEffect(() => { if (open && fixedCategory && libraryPanel.current?.showPopover) libraryPanel.current.showPopover(); }, [open, fixedCategory]);
  const belongsToCategory = (template:BuilderTemplate) => category === 'all' || builderTemplateCategory(template)===category;
  const entries = BUILDER_TEMPLATES.filter(belongsToCategory);
  const selected = getBuilderTemplate(selectedId);
  const active = selected&&Number.isSafeInteger(activeAtomIndex)&&activeAtomIndex!>=0&&activeAtomIndex!<selected.atoms.length?activeAtomIndex!:selected?.connectionAnchor;
  const cards = (items:BuilderTemplate[]) => <div className="fragment-library-cards">{items.map(template => <button type="button" key={template.id} disabled={disabled} className="fragment-library-card" data-fragment-id={template.id} aria-label={template.label} aria-pressed={selectedId === template.id} onClick={() => selectEntry(template.id)}><FragmentSkeletalThumbnail template={template}/><span>{template.label}</span></button>)}</div>;
  const entriesContent = <>{!fixedCategory&&<label>类别<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部</option><option value="functional">官能团</option><option value="ring">环</option><option value="chain">链段</option></select></label>}
      {category==='functional'?<div className="fragment-library-families">{(Object.keys(familyLabels) as BuilderTemplateFamily[]).map(family=>{const items=entries.filter(template=>builderTemplateFamily(template)===family);return items.length?<section key={family} data-fragment-family={family} aria-label={`${familyLabels[family]}片段`}><h4>{familyLabels[family]}</h4>{cards(items)}</section>:null;})}</div>:cards(entries)}
      <p className="fragment-library-detail">{selected ? selected.independentOnly ? `${selected.label} · 独立放置` : `${selected.label} · 在结构预览中选择接入原子` : '请选择片段'}</p>
      {pointerMode&&<p className="fragment-library-detail">{selected?.independentOnly ? '点击画布空白放置。' : '点击画布空白放置；点 H 或连接端接入。'}</p>}
      {!pointerMode&&onAction && <div className="fragment-library-actions"><button type="button" disabled={disabled || !selected || !canIndependent} onClick={() => onAction(selectedId, 'independent',active)}>独立放置</button><button type="button" disabled={disabled || !selected || selected.independentOnly || !canAttach} onClick={() => onAction(selectedId, 'attach',active)}>接入选中端</button><button type="button" disabled={disabled || !selected || selected.independentOnly || !canReplace} onClick={() => onAction(selectedId, 'replace',active)}>替换选中片段</button></div>}
    </>;
  return <section className={`fragment-library${fixedCategory?' fragment-library-fixed-category':''}`} data-library-category={fixedCategory??'legacy'} aria-label="常见片段库"><button ref={categoryTrigger} type="button" className="fragment-library-toggle" aria-haspopup={fixedCategory?'dialog':undefined} aria-controls={panelId} aria-expanded={open} onClick={() => { if (open) closeLibrary(); else setOpen(true); }}>{fixedCategory&&<CategoryIcon size={17} aria-hidden="true"/>}<span className="fragment-trigger-label">{fixedCategory?categoryLabel:'片段库 · 官能团 / 环 / 链段'}<small aria-hidden="true">{open ? '−' : '+'}</small></span></button>
    {open&&(fixedCategory?<div id={panelId} ref={libraryPanel} className="fragment-library-panel" style={dialogSurfaceStyle()} data-testid="fragment-library-panel" data-fragment-category={fixedCategory} data-no-reorder="true" popover="auto" role="dialog" aria-modal="false" aria-label={`${categoryLabel}片段库`} onToggle={event=>{if((event.nativeEvent as ToggleEvent).newState==='closed'&&event.currentTarget.isConnected)setOpen(false);}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();closeLibrary();}}} onKeyUp={event=>event.stopPropagation()}>
      <header className="fragment-library-panel-header"><strong>{categoryLabel}片段库</strong><button type="button" aria-label={`关闭${categoryLabel}片段库`} onClick={closeLibrary}>×</button></header>{entriesContent}
    </div>:<div id={panelId} className="fragment-library-legacy-content">{entriesContent}</div>)}
  </section>;
}
