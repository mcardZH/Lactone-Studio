import { useState } from 'react';
import type { Structure } from '../../core/types';

/** Explicit model-axis confirmation; xTB's approved XYZ policy is not a model edit. */
export default function PeriodicCellControls({structure,disabled,onConfirm}:{structure:Structure;disabled:boolean;onConfirm(pbc:[boolean,boolean,boolean]):void}) {
  const cell=structure.cell;
  const [draft,setDraft]=useState<{identity:string;pbc:[boolean,boolean,boolean]}|null>(null);
  if(structure.periodicSource?.completeness==='partial')return <p role="status">周期矢量不完整：可查看结构，暂不能进行周期整理或xTB优化。</p>;
  if(!cell)return null;
  const identity=JSON.stringify([structure.id,cell]);
  const axes=draft?.identity===identity?draft.pbc:cell.pbc;
  const unknown=cell.pbcProvenance?.kind==='unconfirmed';
  return <div className="periodic-cell-controls" data-testid="periodic-cell-controls">
    <span>晶胞固定 · xTB按当前盒子三维周期计算</span>
    <details open={unknown||undefined}><summary>模型周期轴：{unknown?'待确认':cell.pbc.map((flag,index)=>flag?'XYZ'[index]:'').join('')||'无'}</summary>
      <fieldset disabled={disabled} aria-label="模型周期轴">
        {(['X','Y','Z'] as const).map((axis,index)=><label key={axis}><input type="checkbox" aria-label={axis+'周期'} checked={axes[index]} onChange={event=>setDraft({identity,pbc:axes.map((value,i)=>i===index?event.target.checked:value) as [boolean,boolean,boolean]})}/>{axis}</label>)}
        <button type="button" onClick={()=>onConfirm([...axes] as [boolean,boolean,boolean])}>确认模型周期轴</button>
      </fieldset>
      {unknown&&<span role="status">来源未记录周期轴；经验连接为预览，机械调整前请确认。</span>}
    </details>
  </div>;
}
