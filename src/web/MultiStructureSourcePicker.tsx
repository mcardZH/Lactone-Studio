import {DismissibleNotice} from './DismissibleNotice';
import { useEffect, useRef, useState } from 'react';
import type { InputStructureSource } from '../core/types';
import { inputStructureSourceKey, inputStructureSourceIsCurrent } from '../core/input-structure-source';
export { inputStructureSourceKey, inputStructureSourceIsCurrent } from '../core/input-structure-source';

export interface StructureSourcePickRequest { label: string; onPick(source: InputStructureSource): void }
export interface MultiStructureSourceActions {
  onRequestSourcePick?(request: StructureSourcePickRequest): void;
  onImportSources?(files: File[]): Promise<InputStructureSource[]>;
}
interface Props extends MultiStructureSourceActions {label:string;value:InputStructureSource|null;candidates:InputStructureSource[];onChange(value:InputStructureSource|null):void}
export default function MultiStructureSourcePicker({label,value,candidates,onChange,onRequestSourcePick,onImportSources}:Props){
  const fileInput=useRef<HTMLInputElement>(null),epoch=useRef(0),alive=useRef(true);
  const latest=useRef({label,onChange});latest.current={label,onChange};
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[choices,setChoices]=useState<InputStructureSource[]>([]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
  function chooseInteractively(){
    const own=++epoch.current,originalLabel=label;setError('');setChoices([]);
    onRequestSourcePick?.({label,onPick:source=>{if(alive.current&&epoch.current===own&&latest.current.label===originalLabel)latest.current.onChange(structuredClone(source));}});
  }
  async function importFiles(files:File[]){
    if(!files.length||!onImportSources)return;
    const own=++epoch.current,originalLabel=label;setBusy(true);setError('');setChoices([]);
    try{
      const imported=await onImportSources(files);
      if(!alive.current||own!==epoch.current||latest.current.label!==originalLabel)return;
      if(imported.length===1)latest.current.onChange(structuredClone(imported[0]));
      else if(imported.length)setChoices(imported);
      else throw new Error('文件中没有完整的可选结构。');
    }catch(cause){if(alive.current&&own===epoch.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(alive.current&&own===epoch.current)setBusy(false);}
  }
  const current=inputStructureSourceIsCurrent(value,candidates),key=value?inputStructureSourceKey(value):'';
  return <div className="multi-structure-source"><div className="multi-structure-source-actions"><strong>{label}</strong>{onRequestSourcePick&&<button type="button" disabled={busy} aria-label={`${label}交互式选择`} onClick={chooseInteractively}>交互式选择</button>}{onImportSources&&<><button type="button" disabled={busy} aria-label={`${label}导入文件`} onClick={()=>fileInput.current?.click()}>{busy?'读取中…':'导入文件'}</button><input ref={fileInput} hidden type="file" multiple aria-label={`${label}文件`} onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';void importFiles(files);}}/></>}</div><label className="field"><span className="sr-only">{label}</span><select aria-label={label} value={key} disabled={busy} onChange={event=>{epoch.current++;const candidate=candidates.find(s=>inputStructureSourceKey(s)===event.target.value);onChange(candidate?structuredClone(candidate):null);}}><option value="">请选择真实文档快照</option>
    {value&&!candidates.some(s=>inputStructureSourceKey(s)===key)&&<option value={key} disabled>{value.label} · 已保存来源修订{value.revision}（需刷新）</option>}
    {candidates.map(source=><option key={inputStructureSourceKey(source)} value={inputStructureSourceKey(source)}>{source.label} · r{source.revision} · {source.structure.atoms.length}原子 · q/M {source.charge}/{source.multiplicity}{source.confirmed?'':' · 电子态待确认'}</option>)}</select></label>
    {value&&<p className="muted-note">{value.label} · {value.structure.atoms.length} 原子 · q/M {value.charge}/{value.multiplicity} · r{value.revision}{!value.confirmed?' · 请在来源模型确认电子态':''}</p>}
    {choices.length>1&&<label className="field">选择导入帧<select aria-label={`${label}导入帧`} value="" onChange={event=>{const selected=choices[Number(event.target.value)];if(selected){onChange(structuredClone(selected));setChoices([]);}}}><option value="">请选择具体结构帧</option>{choices.map((source,index)=><option key={source.documentId} value={index}>{source.label} · {source.structure.atoms.length}原子</option>)}</select></label>}
    {error&&<DismissibleNotice role="alert" className="inline-selection-error">{error}</DismissibleNotice>}
    {value&&!current&&<DismissibleNotice role="alert" className="inline-selection-error">来源已改变或不在当前注册文档中，请显式重新选择快照；不会自动刷新或确认。</DismissibleNotice>}
    {value&&<button type="button" className="text-button" onClick={()=>onChange(null)}>清除{label}</button>}
  </div>;
}
