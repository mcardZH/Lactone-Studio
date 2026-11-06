import {DismissibleNotice} from './DismissibleNotice';
import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Structure } from '../core/types';
import { coordinateAtoms } from '../core/tasks';
import { parseAtomSelection } from '../core/structures';
import { coordinateSize, geometryGuide, pickerSelection, pickerStructureIdentity, type CoordinateGuide, type PickerKind } from '../core/geometry-guides';
import MoleculeViewer from './MoleculeViewer';
import type { MoleculeRegion } from '../core/regions';
import type { ViewerHighlights } from '../core/display-highlights';
import './picker.css';
import DialogShell from './DialogShell';

/** All indices, including the callback, are zero based. Only Apply commits the draft. */
export interface AtomPickerRequest {
  kind: PickerKind | 'coordinate';
  title: string;
  initial?: number[];
  regions?:MoleculeRegion[];
  highlights?:ViewerHighlights;
  onApply: (indices: number[]) => void;
}
export interface AtomPickerModalProps { structure: Structure; request: AtomPickerRequest; onClose: () => void }

/** Adaptive coordinates share the existing ordered draft policy, capped at D. */
export function atomPickerSelection(indices: number[], kind: AtomPickerRequest['kind'], count: number): number[] {
  return pickerSelection(indices, kind === 'coordinate' ? 'D' : kind, count);
}
export function atomPickerGeometry(structure: Structure, kind: AtomPickerRequest['kind'], active: number[]) {
  const type = kind === 'coordinate' ? active.length === 2 ? 'B' : active.length === 3 ? 'A' : active.length === 4 ? 'D' : undefined : kind === 'atoms' ? undefined : kind;
  const guide: CoordinateGuide | undefined = type ? { type, atoms: active } : undefined;
  const measurement = guide ? geometryGuide(structure.atoms, guide) : null;
  const complete = kind === 'atoms' || Boolean(guide && active.length === coordinateSize(guide.type) && measurement && measurement.value !== null && Number.isFinite(measurement.value) && !measurement.error);
  return { guide, measurement, complete };
}

export default function AtomPickerModal({ structure, request, onClose }: AtomPickerModalProps) {
  const [selected, setSelected] = useState(() => atomPickerSelection(request.initial ?? [], request.kind, structure.atoms.length));
  const [numbers, setNumbers] = useState('');
  const [error, setError] = useState('');
  const identity = useRef(pickerStructureIdentity(structure));
  const stale = identity.current !== pickerStructureIdentity(structure);
  const active = stale ? [] : selected;
  const required = request.kind === 'coordinate' ? 4 : coordinateSize(request.kind);
  const { guide, measurement, complete } = atomPickerGeometry(structure, request.kind, active);
  const elements = [...new Set(structure.atoms.map(atom => atom.element))];
  const update = (indices: number[]) => { if (stale) return; setSelected(atomPickerSelection(indices, request.kind, structure.atoms.length)); setError(''); };

  return <DialogShell className="atom-picker-dialog" backdropClassName="atom-picker-backdrop" backdropTestId="atom-picker-backdrop" aria-labelledby="atom-picker-title" data-testid="atom-picker" onCancel={onClose} dismissOnBackdrop>
      <header className="atom-picker-header"><div><h2 id="atom-picker-title">{request.title}</h2><p>{request.kind === 'atoms' ? '选择任意数量的原子；应用后写回当前设置。' : request.kind === 'coordinate' ? '依次选择2、3或4个原子，自动识别键长、键角或二面角；继续点选会保留最近4个。' : `依次选择${required}个原子；继续点选会保留最近${required}个。`}</p></div><button type="button" aria-label="关闭三维选择" className="atom-picker-close" onClick={onClose}><X size={19}/></button></header>
      {stale && <DismissibleNotice className="atom-picker-error" role="alert" data-testid="picker-stale">结构已替换，旧原子编号已失效。请关闭并重新打开选择。</DismissibleNotice>}
      <div className="atom-picker-body">
        <div className={'atom-picker-view'+(request.regions?.length||request.highlights?' with-regions':'')}><MoleculeViewer atoms={structure.atoms} bonds={structure.bonds} regions={request.regions} highlights={request.highlights} selected={active} onSelect={stale ? undefined : update} initialInteraction="click" initialLabels initialElements coordinateGuide={guide}/></div>
        <aside className="atom-picker-controls">
          <section><h3>按元素选择</h3><div className="atom-picker-elements" role="group" aria-label="按元素选择">{elements.map(element => { const indices = structure.atoms.flatMap((atom, index) => atom.element === element ? [index] : []); const all = indices.every(index => active.includes(index)); return <button type="button" key={element} disabled={stale} aria-pressed={all} data-element={element} onClick={() => update(all ? active.filter(index => !indices.includes(index)) : [...active, ...indices.filter(index => !active.includes(index))])}>{element}<small>{indices.length}</small></button>; })}</div></section>
          <section><label htmlFor="atom-picker-numbers">按编号{request.kind !== 'atoms' && '（依次）'}</label><div className="atom-picker-number-row"><input id="atom-picker-numbers" data-testid="picker-numbers" value={numbers} disabled={stale} placeholder={request.kind === 'atoms' ? '1-10,21,23' : '3,1,2'} onChange={event => setNumbers(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.parentElement?.querySelector('button')?.click(); } }}/><button type="button" disabled={stale} data-testid="picker-use-numbers" onClick={() => { try { const indices = request.kind === 'atoms' ? parseAtomSelection(numbers, structure.atoms.length) : coordinateAtoms(numbers).map(index => index - 1); if (indices.some(index => index >= structure.atoms.length)) throw new Error(`原子编号须在1–${structure.atoms.length}内。`); if (new Set(indices).size !== indices.length) throw new Error('内坐标编号不能重复。'); update(indices); } catch (reason) { setError(reason instanceof Error ? reason.message : '编号无效。'); } }}>选取</button></div><p className="atom-picker-hint">{request.kind === 'atoms' ? '支持范围；框选包含投影范围内前后侧原子。' : '编号顺序决定内坐标方向，不使用范围缩写。'}</p></section>
          <div className="atom-picker-operations"><button type="button" disabled={stale || !active.length} data-testid="picker-clear" onClick={() => update([])}>清空</button><button type="button" disabled={stale} data-testid="picker-invert" onClick={() => update(structure.atoms.flatMap((_, index) => active.includes(index) ? [] : [index]))}>反选</button></div>
          <section><h3>当前选择 <span data-testid="picker-count">{active.length}{request.kind === 'atoms' ? '' : ` / ${required}`}</span></h3><div className="atom-picker-selected" data-testid="picker-selected" aria-label="按选择顺序排列的原子">{active.length ? active.map((index, order) => <button type="button" key={index} disabled={stale} aria-label={`取消原子 ${index + 1}`} onClick={() => update(active.filter(value => value !== index))}><small>{order + 1}</small>{index + 1} {structure.atoms[index].element}<X size={11}/></button>) : <p>尚未选择原子</p>}</div></section>
          {measurement && <output className="atom-picker-measurement" data-testid="picker-measurement" aria-live="polite">{measurement.error ?? measurement.label}</output>}
          <p className="atom-picker-hint">再次点选已选原子可取消。所有改动仅为当前草稿，点击“应用选择”后生效。</p>
          {error && <DismissibleNotice className="atom-picker-error" role="alert">{error}</DismissibleNotice>}
        </aside>
      </div>
      <footer className="atom-picker-footer"><span>{request.kind === 'atoms' ? `已选择 ${active.length} / ${structure.atoms.length} 个原子` : '细虚线标示当前内坐标，数值由原始坐标计算。'}</span><button type="button" onClick={onClose}>取消</button><button type="button" className="atom-picker-apply" data-testid="picker-apply" disabled={stale || !complete} onClick={() => { if (stale || !complete) return; request.onApply([...active]); onClose(); }}>应用选择</button></footer>
  </DialogShell>;
}
