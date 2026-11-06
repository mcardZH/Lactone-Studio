import { FlaskConical, Hexagon, Link2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { BUILDER_TEMPLATES, builderTemplateCategory, builderTemplateFamily, getBuilderTemplate, type BuilderTemplate, type BuilderTemplateFamily } from '../../core/builder-templates';
import type { Structure } from '../../core/types';
import './workbench-tools.css';
import {dialogSurfaceStyle} from '../DialogShell';
export type FragmentLibraryMode = 'attach' | 'replace' | 'independent';
export interface FragmentLibraryProps { selectedId: string; onSelect(id: string): void; onAction?(id: string, mode: FragmentLibraryMode, activeAtomIndex?:number): void; activeAtomIndex?:number; onActiveAtomChange?(index:number):void; pointerMode?:boolean; disabled?: boolean; canAttach?: boolean; canReplace?: boolean; canIndependent?: boolean; previewSnapshot?: Structure | null; previewSourceKey?: string; onPreviewRequest?(templateId: string): void;category?:'all'|'functional'|'ring'|'chain'; previewPlacement?:'popup'|'dock'; previewCompact?:boolean; defaultPreviewOpen?:boolean }
const familyLabels:Record<BuilderTemplateFamily,string>={O:'含氧',N:'含氮',S:'含硫',P:'含磷',B:'含硼',Si:'含硅',halogen:'卤素',charged:'带电基团',conjugated:'不饱和 / 共轭'};
const elementColors:Record<string,string>={H:'#e8edf1',C:'#667785',O:'#df4545',N:'#4978df',F:'#61b860',Cl:'#47a65b',Br:'#985b3d',I:'#885cba',S:'#be941d',P:'#dc8a35',B:'#c98c7b',Si:'#a48077'};
export function FragmentPreview({ template, activeAtomIndex=template.connectionAnchor, onActiveAtomChange }: { template: BuilderTemplate; activeAtomIndex?:number; onActiveAtomChange?(index:number):void }) {
  const xs = template.atoms.map(atom => atom.x + atom.z * .3), ys = template.atoms.map(atom => -atom.y + atom.z * .2);
  const dx = Math.max(...xs) - Math.min(...xs), dy = Math.max(...ys) - Math.min(...ys), scale = Math.min(42, 88 / Math.max(dx, 1), 64 / Math.max(dy, 1));
  const px = (i: number) => 60 + (xs[i] - (Math.max(...xs) + Math.min(...xs)) / 2) * scale, py = (i: number) => 48 + (ys[i] - (Math.max(...ys) + Math.min(...ys)) / 2) * scale;
  return <svg viewBox="0 0 120 96" role="img" aria-label={`${template.label}，蓝圈标记连接位`} style={{display:'block',width:'100%',maxHeight:160}}>
    {template.bonds.map((bond, index) => { const x1 = px(bond.a), y1 = py(bond.a), x2 = px(bond.b), y2 = py(bond.b), len = Math.hypot(x2 - x1, y2 - y1) || 1, nx = -(y2 - y1) / len, ny = (x2 - x1) / len; const offsets = bond.order === 3 ? [-3, 0, 3] : bond.order === 2 ? [-2, 2] : [0];
      return <g key={index}>{offsets.map(offset => <line key={offset} x1={x1 + nx * offset} y1={y1 + ny * offset} x2={x2 + nx * offset} y2={y2 + ny * offset} stroke="#64748b" strokeWidth="1.8" />)}{bond.aromatic && <line x1={x1 + nx * 3} y1={y1 + ny * 3} x2={x2 + nx * 3} y2={y2 + ny * 3} stroke="#64748b" strokeDasharray="3 2" />}</g>;
    })}
    {template.atoms.map((atom, i) => <g key={i} role={onActiveAtomChange?'button':undefined} tabIndex={onActiveAtomChange?0:undefined} aria-label={onActiveAtomChange?`活性原子 ${i+1} ${atom.element}`:undefined} aria-pressed={onActiveAtomChange?i===activeAtomIndex:undefined} data-fragment-atom-index={i}
      onClick={onActiveAtomChange?event=>{event.stopPropagation();onActiveAtomChange(i);}:undefined}
      onKeyDown={onActiveAtomChange?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();onActiveAtomChange(i);}}:undefined}>
      {i === activeAtomIndex && <circle cx={px(i)} cy={py(i)} r="10" fill="none" stroke="#168bd2" strokeWidth="2" data-connection-anchor="true" />}<circle cx={px(i)} cy={py(i)} r="7" fill={elementColors[atom.element]??'#667785'} /><text x={px(i)} y={py(i) + 3} textAnchor="middle" fill={atom.element==='H'?'#334155':'white'} fontSize={atom.element.length>1?'8':'9'}>{atom.element}</text>{Boolean(atom.formalCharge)&&<text x={px(i)+9} y={py(i)-8} fill="#334155" fontSize="10" data-formal-charge={atom.formalCharge}>{Math.abs(atom.formalCharge!)>1?Math.abs(atom.formalCharge!):''}{atom.formalCharge!>0?'+':'−'}</text>}</g>)}
  </svg>;
}
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
  const cards = (items:BuilderTemplate[]) => <div className="fragment-library-cards">{items.map(template => <button type="button" key={template.id} disabled={disabled} className="fragment-library-card" data-fragment-id={template.id} aria-pressed={selectedId === template.id} onClick={() => selectEntry(template.id)}><FragmentPreview template={template}/><span>{template.label}</span></button>)}</div>;
  const entriesContent = <>{!fixedCategory&&<label>类别<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部</option><option value="functional">官能团</option><option value="ring">环</option><option value="chain">链段</option></select></label>}
      {category==='functional'?<div className="fragment-library-families">{(Object.keys(familyLabels) as BuilderTemplateFamily[]).map(family=>{const items=entries.filter(template=>builderTemplateFamily(template)===family);return items.length?<section key={family} data-fragment-family={family} aria-label={`${familyLabels[family]}片段`}><h4>{familyLabels[family]}</h4>{cards(items)}</section>:null;})}</div>:cards(entries)}
      <p className="fragment-library-detail">{selected?.label ?? '请选择片段'} · 在结构预览中选择接入原子</p>
      {pointerMode&&<p className="fragment-library-detail">点击画布空白放置；点 H 或连接端接入。</p>}
      {!pointerMode&&onAction && <div className="fragment-library-actions"><button type="button" disabled={disabled || !selected || !canIndependent} onClick={() => onAction(selectedId, 'independent',active)}>独立放置</button><button type="button" disabled={disabled || !selected || !canAttach} onClick={() => onAction(selectedId, 'attach',active)}>接入选中端</button><button type="button" disabled={disabled || !selected || !canReplace} onClick={() => onAction(selectedId, 'replace',active)}>替换选中片段</button></div>}
    </>;
  return <section className={`fragment-library${fixedCategory?' fragment-library-fixed-category':''}`} data-library-category={fixedCategory??'legacy'} aria-label="常见片段库"><button ref={categoryTrigger} type="button" className="fragment-library-toggle" aria-haspopup={fixedCategory?'dialog':undefined} aria-controls={panelId} aria-expanded={open} onClick={() => { if (open) closeLibrary(); else setOpen(true); }}>{fixedCategory&&<CategoryIcon size={17} aria-hidden="true"/>}<span className="fragment-trigger-label">{fixedCategory?categoryLabel:'片段库 · 官能团 / 环 / 链段'}<small aria-hidden="true">{open ? '−' : '+'}</small></span></button>
    {open&&(fixedCategory?<div id={panelId} ref={libraryPanel} className="fragment-library-panel" style={dialogSurfaceStyle()} data-testid="fragment-library-panel" data-fragment-category={fixedCategory} data-no-reorder="true" popover="auto" role="dialog" aria-modal="false" aria-label={`${categoryLabel}片段库`} onToggle={event=>{if((event.nativeEvent as ToggleEvent).newState==='closed'&&event.currentTarget.isConnected)setOpen(false);}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();closeLibrary();}}} onKeyUp={event=>event.stopPropagation()}>
      <header className="fragment-library-panel-header"><strong>{categoryLabel}片段库</strong><button type="button" aria-label={`关闭${categoryLabel}片段库`} onClick={closeLibrary}>×</button></header>{entriesContent}
    </div>:<div id={panelId} className="fragment-library-legacy-content">{entriesContent}</div>)}
  </section>;
}
