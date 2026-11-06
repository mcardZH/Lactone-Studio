import {DismissibleNotice} from './DismissibleNotice';
import { copyPlainText } from './clipboard-text';
import { useEffect, useRef, useState } from 'react';
import { Info, Scissors, Copy } from 'lucide-react';
import type { Structure } from '../core/types';
import { formatAtomSelection, parseAtomSelection } from '../core/structures';
export default function SelectionPanel({structure,selected,onSelect,onExtract,onCopied}:{structure:Structure;selected:number[];onSelect:(indices:number[])=>void;onExtract:()=>void;onGroup?:(name:string)=>void;onCopied?:(message:string)=>void}){
  const canonical=formatAtomSelection(selected),signature=selected.join(',');
  const copyIdentity=useRef<object|null>(null);const sourceIdentity=useRef({structure,signature});
  if(sourceIdentity.current.structure!==structure||sourceIdentity.current.signature!==signature){sourceIdentity.current={structure,signature};copyIdentity.current=null;}
  useEffect(()=>()=>{copyIdentity.current=null;},[]);
  const [text,setText]=useState(canonical),[error,setError]=useState('');
  useEffect(()=>{setText(canonical);setError('');},[signature,structure.id,canonical]);
  function apply(){try{const indices=parseAtomSelection(text,structure.atoms.length);onSelect(indices);setText(formatAtomSelection(indices));setError('');}catch(reason){setError(reason instanceof Error?reason.message:'无法应用原子编号。');}}
  async function copy(){const identity={};copyIdentity.current=identity;try{await copyPlainText(formatAtomSelection(selected));if(copyIdentity.current===identity)onCopied?.('已选原子编号已复制。');}catch(cause){if(copyIdentity.current===identity)setError(cause instanceof Error?cause.message:'剪贴板不可用，请在编号框中选中复制。');}}
  return <section className="selection-panel shared-selection-panel"><div className="subheading"><h3>原子选择</h3><span className="selected-count" aria-live="polite">已选 {selected.length} / {structure.atoms.length}</span></div>
    <div className="selected-serials"><label className="field" htmlFor="shared-atom-selection">已选原子编号<textarea id="shared-atom-selection" aria-label="已选原子编号" aria-describedby="shared-atom-selection-hint" aria-invalid={!!error} value={text} placeholder="1-10,21,23,25-60；输入后按 Enter 应用" onChange={event=>{setText(event.target.value);setError('');}} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();apply();}}}/></label><button className="button button-white" disabled={!selected.length} onClick={copy}><Copy size={14}/>复制编号</button></div>
    {error&&<DismissibleNotice className="inline-selection-error" role="alert">{error} 原有有效选择未改变。</DismissibleNotice>}<p className="muted-note" id="shared-atom-selection-hint"><Info size={12}/>点选、框选会同步编号；输入后按 Enter 应用（空白可清空）。再次点选可取消，范围含两端。</p>
    {text!==canonical&&!error&&<p className="selection-pending" role="status">编号尚未应用，请按 Enter；复制与提取仍使用当前有效选择。</p>}
    <button className="button button-white" disabled={!selected.length} onClick={onExtract}><Scissors size={14}/>提取所选原子用于输入</button>
    {structure.mapping&&<details className="group-details"><summary>原始编号 → 当前编号</summary><p className="mapping-list">{structure.mapping.map(item=>item.original+'→'+item.current).join(', ')}</p></details>}
  </section>;
}
