import {DismissibleNotice} from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import {useEffect,useRef,useState} from 'react';
import {builderCoordinateValue} from '../../core/builder-geometry';
import type {ConformerPointCountMode} from '../../modeling/conformers/point-allocation';
import {DEFAULT_CONFORMER_SAMPLING_LIMITS} from '../../modeling/conformers/sampling';
import type {AnalysisSelectionPort} from '../analysis-selection-intent';
import InteractiveSelectionField,{SelectionGroupHeader,SelectionAddButton,SelectionRemoveButton} from '../InteractiveSelectionField';
import {InputSettingsField,InputSettingsRow} from '../InputSettingsFields';
import {InputSettingsAction,InputSettingsCheckbox} from '../InputSettingsLayout';
import '../geometry-controls.css';
import './conformer-torsion-controls.css';

export interface ConformerTorsionDraft {id:string;atomIds:readonly string[];enabled:boolean;pointCount:number;origin:'automatic'|'manual';pointCountMode?:ConformerPointCountMode}
export default function ConformerTorsionControls(p:{
  source:AdvancedFrameSource|null;rows:readonly ConformerTorsionDraft[];onChange(rows:ConformerTorsionDraft[]):void;
  activeId?:string;onActive(id:string):void;selectionPort:AnalysisSelectionPort;selectionEnabled:boolean;onRequest():void;
  validate(ids:readonly string[]):void;error?:string;onAutomatic?():void;
  onHover?(id:string|null):void;onPreview?(id:string|null):void;previewId?:string|null;
}){
  const latest=useRef(p);latest.current=p;
  const [pending,setPending]=useState<ConformerTorsionDraft|null>(null);
  useEffect(()=>setPending(null),[p.source?.ref.documentId,p.source?.ref.documentEpoch,p.source?.ref.revision,p.source?.ref.frameId]);
  useEffect(()=>()=>{latest.current.onHover?.(null);latest.current.onPreview?.(null);},[p.source?.ref.documentId,p.source?.ref.documentEpoch,p.source?.ref.revision,p.source?.ref.frameId]);
  useEffect(()=>{if(p.previewId&&!p.rows.some(row=>row.id===p.previewId&&row.atomIds.length===4))p.onPreview?.(null);},[p.previewId,p.rows]);
  const update=(id:string,patch:Partial<ConformerTorsionDraft>)=>{if(pending?.id===id)setPending({...pending,...patch});else p.onChange(p.rows.map(row=>row.id===id?{...row,...patch}:row));};
  const atomLabel=(id:string)=>{const index=p.source?.structure.atoms.findIndex(atom=>atom.id===id)??-1;return index<0?'未定义':`${p.source!.structure.atoms[index].element}${index+1}`;};
  const angle=(row:ConformerTorsionDraft)=>{try{return p.source&&row.atomIds.length===4?`${builderCoordinateValue(p.source.structure,'D',[...row.atomIds]).toFixed(1)}°`:'';}catch{return ''}};
  return <div className="geometry-controls conformer-torsion-controls" data-testid="conformer-torsion-controls">
    <SelectionGroupHeader title={`柔性键（${p.rows.length}）`} actions={<SelectionAddButton label="添加柔性键" disabled={!p.source||!!pending} onClick={()=>setPending({id:crypto.randomUUID(),atomIds:[],pointCount:3,enabled:true,origin:'manual',pointCountMode:'automatic'})}/>}/>
    <p className="muted-note">本卡最多启用{DEFAULT_CONFORMER_SAMPLING_LIMITS.maxTorsions}条柔性键</p>
    <InputSettingsRow>{p.onAutomatic&&<InputSettingsAction disabled={!p.source} onClick={p.onAutomatic}>自动判定柔性键</InputSettingsAction>}<InputSettingsAction disabled={!p.rows.length} onClick={()=>{p.onPreview?.(null);p.onHover?.(null);p.onChange([]);}}>清空柔性键</InputSettingsAction></InputSettingsRow>
    <div className="coordinate-list coordinate-draft-list">{[...p.rows,...(pending?[pending]:[])].map((row,index)=><article key={row.id} className={`coordinate-draft${row.enabled?'':' inactive-coordinate'}${row.id===p.activeId?' conformer-torsion-current':''}`} data-coordinate-id={row.id} onPointerEnter={()=>p.onHover?.(row.atomIds.length===4?row.id:null)} onPointerLeave={()=>p.onHover?.(null)} onPointerDown={()=>{if(row.id!==pending?.id)p.onActive(row.id);}}>
      <header className="shared-coordinate-row-header"><InputSettingsCheckbox label={`柔性键 ${index+1}${row.atomIds.length===4?` · ${atomLabel(row.atomIds[1])}—${atomLabel(row.atomIds[2])}`:''}`} ariaLabel={`启用柔性键${index+1}`} checked={row.enabled} onChange={enabled=>update(row.id,{enabled})}/><span className="conformer-torsion-angle">{angle(row)}</span><InputSettingsAction disabled={!p.source||row.atomIds.length!==4||!p.onPreview} onClick={()=>{p.onActive(row.id);p.onHover?.(null);p.onPreview?.(p.previewId===row.id?null:row.id);}}>{p.previewId===row.id?'停止预览':'预览动画'}</InputSettingsAction><SelectionRemoveButton label={`删除柔性键${index+1}`} onClick={()=>{p.onHover?.(null);if(row.id===pending?.id)setPending(null);else{if(p.previewId===row.id)p.onPreview?.(null);p.onChange(p.rows.filter(value=>value.id!==row.id));}}}/></header>
      <div className="conformer-torsion-body">
      <InteractiveSelectionField structure={p.source?.structure??null} label={`柔性键 ${index+1}`} rowId={row.id} kind="coordinate" atomIds={row.atomIds} disabled={!p.selectionEnabled} captureOwner={p.selectionPort.owner} contextKey={p.selectionPort.contextKey} analysisPurpose="advanced-coordinate" onRequestAnalysisSelection={intent=>{p.onRequest();return p.selectionPort.requestSelection(intent);}} onEnd={result=>{if(result==='cancelled'&&row.id===pending?.id)setPending(null);}} onConfirm={(ids,guard)=>{guard();if(ids.length!==4)throw Error('二面角需要按顺序选择4个不同原子。');p.validate(ids);if(row.id===pending?.id){p.onChange([...p.rows,{...row,atomIds:[...ids]}]);setPending(null);p.onActive(row.id);}else update(row.id,{atomIds:[...ids]});}}/>
      {row.id===pending?.id&&<InputSettingsAction onClick={()=>setPending(null)}>取消添加</InputSettingsAction>}
      <div className="conformer-torsion-count-group"><InputSettingsField label="撒点数" className="conformer-torsion-points"><NumericInput aria-label={`柔性键${index+1}撒点数`} stepper min={1} max={4096} step={1} value={Number.isFinite(row.pointCount)?row.pointCount:''} onChange={event=>update(row.id,{pointCount:event.currentTarget.valueAsNumber,pointCountMode:'manual'})}/></InputSettingsField>{row.pointCountMode==='manual'?<InputSettingsAction onClick={()=>update(row.id,{pointCountMode:'automatic'})}>恢复自动</InputSettingsAction>:<span className="conformer-torsion-auto">自动</span>}</div>
      </div>
    </article>)}</div>
    {!p.rows.length&&<p role="status">暂无柔性键定义</p>}{p.error&&<DismissibleNotice role="alert">{p.error}</DismissibleNotice>}
  </div>;
}
