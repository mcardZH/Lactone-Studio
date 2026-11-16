import { useEffect, useRef, useState } from 'react';
import { confirmCoordinateSelection } from '../../modeling/application/coordinate-selection';
import { parseInteractiveSelection } from '../../modeling/application/region-selection';
import type { PesAxis, PesCard, PesConvergencePreset } from '../../modeling/pes/contracts';
import { SCAN_CONVERGENCE_PRESETS, PES_CONVERGENCE_OPTIONS, pesId, pesParameterSections, sellaPresetParameters } from '../../modeling/pes/defaults';
import { compilePesExpression, nextCoordinateName, renameCoordinate, renameScanCoordinate, scanAxisDefinition, sharedScanCard, updateScanCoordinates } from '../../modeling/pes/expressions';
import { parameterValue } from '../../modeling/pes/request';
import type { ScanSourceChoice } from '../../modeling/pes/scan-source';
import { scanSourceKey } from '../../modeling/pes/scan-source';
import { editScanRange, scanRangeNumber, scanRangeValues, settleScanStep, type ScanRangeField } from '../../modeling/pes/scan-range';
import { DismissibleNotice } from '../DismissibleNotice';
import { InputSettingsField, InputSettingsRow, InputSettingsStack } from '../InputSettingsFields';
import { SelectionAddButton, SelectionGroupHeader, SelectionRemoveButton } from '../InteractiveSelectionField';
import { PesDetails, PesSelect, PesSelectionField, PesText, pesMessage, type PesSelectionScope } from './pes-fields';
import './pes-scan-settings.css';

type Change = (edit: (card: PesCard) => PesCard) => void;
export function PesScanSourceRow({card,choices,issue,loading,canCapture,onSelect,capture}:{card:PesCard;choices:ScanSourceChoice[];issue?:string;loading?:boolean;canCapture:boolean;onSelect(key:string):void;capture():void}){
  const snapshot=card.slots.start?.inputSnapshotId,snapshotKey=snapshot?`__snapshot:${snapshot}`:undefined;
  const key=snapshotKey??(card.slots.start?scanSourceKey(card.slots.start):card.requiredSlots?.includes('start')?'':choices.find(row=>row.category==='初始结构')?.key??'');
  const valid=!!snapshotKey||choices.some(row=>row.key===key);
  return <InputSettingsStack><InputSettingsRow className="pes-source-row">
    <InputSettingsField label="起始结构" controlWidth="select"><select aria-label="起始结构" value={valid?key:'__missing'} aria-invalid={!valid||undefined} disabled={loading}
      onChange={event=>onSelect(event.target.value)}>
      {!valid&&<option value="__missing" disabled>原来源已移除，请重选</option>}
      {snapshotKey&&<option value={snapshotKey}>{card.slots.start?.label??'本卡临时快照'}</option>}
      {(['初始结构','已记录快照','工作台编辑结构','结果帧'] as const).map(category=>{const rows=choices.filter(row=>row.category===category);return rows.length?<optgroup key={category} label={category}>{rows.map(row=><option key={row.key} value={row.key}>{row.label}</option>)}</optgroup>:null;})}
    </select></InputSettingsField>
    <span className="pes-source-actions"><button type="button" className="button button-primary" disabled={!canCapture||loading} aria-label="起始结构记录快照" onClick={capture}>记录快照</button></span>
  </InputSettingsRow>{loading&&<output>正在读取所选来源…</output>}<DismissibleNotice identity={issue}>{issue}</DismissibleNotice></InputSettingsStack>;
}

export function PesScanCoordinates({card,scope,update}:{card:PesCard;scope:PesSelectionScope;update:Change}){
  const current=sharedScanCard(card),coordinates=current.scanCoordinates??[],drafts=current.scanCoordinateDrafts??[];
  const structure=scope.target.structure;
  const [issue,setIssue]=useState('');
  const change:Change=edit=>update(previous=>edit(sharedScanCard(previous)));
  const editDraft=(id:string,patch:Partial<NonNullable<PesCard['scanCoordinateDrafts']>[number]>)=>change(previous=>{
    const existing=previous.scanCoordinates?.find(row=>row.id===id),stored=previous.scanCoordinateDrafts??[];
    const old=stored.find(row=>row.id===id)??{id,name:existing?.nameDraft??existing?.name??'',atomText:existing?.atomIds.map(id=>structure.atoms.findIndex(atom=>atom.id===id)+1).join(',')??''};
    const next={...old,...patch},canonical=existing?.atomIds.map(id=>{const index=structure.atoms.findIndex(atom=>atom.id===id);return index<0?'?':index+1;}).join(',');
    if(existing&&next.name===existing.name&&next.atomText===canonical&&!next.automaticName)return {...previous,scanCoordinateDrafts:stored.filter(row=>row.id!==id)};
    return {...previous,scanCoordinateDrafts:stored.some(row=>row.id===id)?stored.map(row=>row.id===id?next:row):[...stored,next]};
  });
  function confirm(id:string,atomIds:string[]){
    const measured=confirmCoordinateSelection(structure,atomIds);
    change(previous=>{
      const original=previous.scanCoordinates?.find(row=>row.id===id),draft=previous.scanCoordinateDrafts?.find(row=>row.id===id);
      if(!original&&!draft)throw Error('内坐标行已删除，请重新添加。');
      let name=draft?.automaticName?nextCoordinateName(measured.type,(previous.scanCoordinates??[]).filter(row=>row.id!==id)):draft?.name??original?.name??nextCoordinateName(measured.type,previous.scanCoordinates??[]);
      let next=previous;
      if(original)next=renameScanCoordinate(previous,id,name);
      else {
        const row={id,name:nextCoordinateName(measured.type,previous.scanCoordinates??[]),type:measured.type,atomIds:[...atomIds]};
        const definition=renameCoordinate({coordinates:[...(previous.scanCoordinates??[]),row],expression:''},id,name);
        next=updateScanCoordinates(previous,definition.coordinates);
      }
      next=updateScanCoordinates(next,(next.scanCoordinates??[]).map(row=>row.id===id?{...row,type:measured.type,atomIds:[...atomIds]}:row));
      const first=coordinates.length===0;
      if(first&&!next.axes[0].definition.expression.trim())next={...next,axes:[{...next.axes[0],definition:{...next.axes[0].definition,expression:name}},next.axes[1]]};
      return {...next,scanCoordinateDrafts:next.scanCoordinateDrafts?.filter(row=>row.id!==id)};
    });setIssue('');
  }
  const members=[...coordinates.map(row=>row.id),...drafts.filter(draft=>!coordinates.some(row=>row.id===draft.id)).map(row=>row.id)];
  const ids=[...(current.scanCoordinateOrder??[]).filter(id=>members.includes(id)),...members.filter(id=>!current.scanCoordinateOrder?.includes(id))];
  return <InputSettingsStack className="pes-scan-coordinates">
    <SelectionGroupHeader title={`基础内坐标（${coordinates.length}）`} actions={<SelectionAddButton label="添加内坐标" onClick={()=>change(previous=>{const id=pesId('q');return {...previous,scanCoordinateOrder:[...ids,id],scanCoordinateDrafts:[...(previous.scanCoordinateDrafts??[]),{id,name:nextCoordinateName('B',[...(previous.scanCoordinates??[]),...(previous.scanCoordinateDrafts??[]).map(row=>({id:row.id,name:row.name,type:'B' as const,atomIds:[]}))]),atomText:'',automaticName:true}]};})}/>}/>
    {ids.map((id,index)=>{
      const coordinate=coordinates.find(row=>row.id===id),draft=drafts.find(row=>row.id===id),label=`基础内坐标${index+1}`;
      const atomText=draft?.atomText??coordinate?.atomIds.map(id=>{const index=structure.atoms.findIndex(atom=>atom.id===id);return index<0?'?':index+1;}).join(',')??'';
      const name=draft?.name??coordinate?.nameDraft??coordinate?.name??'';
      let preview='',type='—';
      try {const selected=parseInteractiveSelection(atomText,structure,'coordinate'),data=confirmCoordinateSelection(structure,selected);type=data.type;preview=`${Number(data.value.toPrecision(7))} ${data.unit}`;}catch{if(coordinate&&!draft)preview='缺少原子，请重选';}
      return <InputSettingsStack key={id} className="pes-scan-coordinate-row">
        <PesSelectionField scope={scope} rowId={`${card.id}:scan:${id}`} label={label} kind="coordinate" ids={coordinate?.atomIds??[]}
            numberText={atomText} onNumberTextChange={atomText=>editDraft(id,{atomText})} preserveNumberDraftOnCancel
            disabled={!structure.atoms.length} onConfirm={atomIds=>confirm(id,atomIds)} renderHeader={()=>null}
            renderSelectionRow={(numberControl,actions)=><div className="pes-scan-coordinate-line">
              <div className="pes-scan-coordinate-data">
                <InputSettingsField label="名称" controlWidth="text"><input aria-label={`${label}名称`} value={name} onChange={event=>editDraft(id,{name:event.target.value,automaticName:false})}/></InputSettingsField>
                <span className="pes-scan-coordinate-numbers">{numberControl}</span>
                <output className="pes-scan-coordinate-type" aria-label={`${label}类型`}>{type}</output>
                <output className="pes-scan-coordinate-value" aria-label={`${label}读数`}>{preview||'—'}</output>
              </div>
              <span className="interactive-selection-buttons pes-scan-coordinate-actions">{actions}<SelectionRemoveButton label={`删除${label}`} onClick={()=>change(previous=>({...updateScanCoordinates(previous,(previous.scanCoordinates??[]).filter(row=>row.id!==id)),scanCoordinateOrder:ids.filter(row=>row!==id),scanCoordinateDrafts:previous.scanCoordinateDrafts?.filter(row=>row.id!==id)}))}/></span>
            </div>}/>
      </InputSettingsStack>;
    })}
    {!structure.atoms.length&&<p>先添加或导入原子</p>}
    <DismissibleNotice identity={issue}>{issue}</DismissibleNotice>
  </InputSettingsStack>;
}

function ScanAxisEditor({card,axis,index,scope,update}:{card:PesCard;axis:PesAxis;index:number;scope:PesSelectionScope;update:Change}){
  const input=useRef<HTMLInputElement>(null),touched=axis.rangeTouched??{};
  const definition=scanAxisDefinition(card,axis);
  let current:number|undefined,unit='',issue='';
  try{const compiled=compilePesExpression(definition,scope.target.structure);current=compiled.value;unit=compiled.unit;}catch(cause){if(definition.expression.trim())issue=pesMessage(cause);}
  const automatic=axis.lowerMode==='automatic'||axis.lowerMode===undefined&&!axis.lower;
  const lower=automatic?(current===undefined?'':String(current)):axis.lower;
  const edit=(patch:Partial<PesAxis>)=>update(previous=>{const next=sharedScanCard(previous),axes=[...next.axes] as PesCard['axes'];axes[index]={...axes[index],...patch};return {...next,axes};});
  const expression=(text:string)=>edit({definition:{...definition,expression:text}});
  function insert(token:string){const node=input.current,start=node?.selectionStart??axis.definition.expression.length,end=node?.selectionEnd??start;expression(axis.definition.expression.slice(0,start)+token+axis.definition.expression.slice(end));requestAnimationFrame(()=>{node?.focus();node?.setSelectionRange(start+token.length,start+token.length);});}
  const {start,end,points,actualStep}=scanRangeValues(axis,current);
  const validPoints=points!==undefined&&Number.isSafeInteger(points)&&points>=2;
  const step=axis.rangeDriver==='step'?axis.step??'':actualStep===undefined?'':String(actualStep);
  const enteredStep=scanRangeNumber(step),validStep=enteredStep!==undefined&&enteredStep>0;
  const range=(field:ScanRangeField,text:string)=>update(previous=>{const next=sharedScanCard(previous),axes=[...next.axes] as PesCard['axes'];axes[index]=editScanRange(axes[index],field,text,current);return {...next,axes};});
  useEffect(()=>{
    if(!automatic||axis.rangeDriver!=='step')return;
    const next=editScanRange(axis,'step',axis.step??'',current);
    if(next.points!==axis.points)edit({points:next.points});
  },[automatic,current,axis.lower,axis.upper,axis.step,axis.rangeDriver,axis.points]);
  const blur=(field:ScanRangeField)=>update(previous=>{const next=sharedScanCard(previous),axes=[...next.axes] as PesCard['axes'];const row={...axes[index],rangeTouched:{...axes[index].rangeTouched,[field]:true}};axes[index]=field==='step'?settleScanStep(row,current):row;return {...next,axes};});
  const rangeField=(field:ScanRangeField,label:string,value:string,invalid:boolean)=><InputSettingsField label={label} controlWidth="number" className={field==='points'?'pes-scan-range-count':'pes-scan-range-number'}><input aria-label={`q${label}`} type="text" inputMode={field==='points'?'numeric':'decimal'} value={value} aria-invalid={touched[field]&&invalid||undefined} onChange={event=>range(field,event.target.value)} onBlur={()=>blur(field)}/>{field!=='points'&&unit&&<span>{unit}</span>}</InputSettingsField>;
  return <InputSettingsStack className="pes-scan-axis">
    <InputSettingsField label="q =" controlWidth="full"><input ref={input} aria-label="q表达式" placeholder="例如 2*B1-3*B2" value={axis.definition.expression} aria-invalid={!!issue||undefined} onChange={event=>expression(event.target.value)}/></InputSettingsField>
    <InputSettingsRow>{definition.coordinates.map(row=><button key={row.id} type="button" className="button" onClick={()=>insert(row.name)}>{row.name}</button>)}{['+','−','×','÷'].map(token=><button key={token} type="button" className="button" aria-label={`q插入${token}`} onClick={()=>insert(token==='×'?'*':token==='÷'?'/':token==='−'?'-':token)}>{token}</button>)}{current!==undefined&&<output>当前 q {Number(current.toPrecision(8))} {unit}</output>}</InputSettingsRow>
    <div className="pes-scan-range-row">
      <div className="pes-scan-range-pair">{rangeField('lower','起点',lower,start===undefined)}{rangeField('upper','终点',axis.upper,end===undefined)}</div>
      <div className="pes-scan-range-pair">{rangeField('points','点数',axis.points,!validPoints)}{rangeField('step','步长',step,!validStep)}</div>
    </div>
    {axis.rangeDriver==='step'&&actualStep!==undefined&&validStep&&enteredStep!==actualStep&&<output>实际步长 {actualStep} {unit}</output>}
    <DismissibleNotice identity={issue}>{issue}</DismissibleNotice>
  </InputSettingsStack>;
}

export function PesScanAxes({card,scope,update}:{card:PesCard;scope:PesSelectionScope;update:Change}){
  const current=sharedScanCard(card),axis=current.axes[0];
  return <InputSettingsStack>
    <ScanAxisEditor key={axis.id} card={current} axis={axis} index={0} scope={scope} update={update}/>
  </InputSettingsStack>;
}

export function PesScanOptimization({card,update}:{card:PesCard;update:Change}){
  const algorithm=card.algorithm,values=card.parametersByAlgorithm[algorithm]??{},[touched,setTouched]=useState<Record<string,boolean>>({});
  const fields=pesParameterSections(algorithm,values).flatMap(section=>section.fields).filter(field=>
    !(['gfn0','gfnff'].includes(card.method.method)&&['electronicTemperatureK','maxSccIterations'].includes(field.key))),native=algorithm==='sella-scan';
  const inferred=Object.entries(SCAN_CONVERGENCE_PRESETS).find(([,preset])=>Object.entries(preset).every(([key,value])=>Number(values[key]??fields.find(field=>field.key===key)?.initial)===Number(value)))?.[0]??'custom';
  const preset=native?String(values.convergencePreset??'loose'):card.scanConvergencePreset??inferred;
  const change=(key:string,text:string)=>update(previous=>({...previous,scanConvergencePreset:key==='maxSteps'?previous.scanConvergencePreset:'custom',parametersByAlgorithm:{...previous.parametersByAlgorithm,[algorithm]:{...previous.parametersByAlgorithm[algorithm],[key]:text,...(native&&key!=='maxSteps'?{convergencePreset:'custom'}:{})}}}));
  return <PesDetails title="每点优化设置">
    <InputSettingsRow><PesSelect label="扫描优化器" value={algorithm} options={{...(!native?{slsqp:'SLSQP（已有设置）'}:{}),'sella-scan':'Sella'}} onChange={algorithm=>update(previous=>({...previous,algorithm,scanConvergencePreset:'custom',parametersByAlgorithm:{...previous.parametersByAlgorithm,[algorithm]:{...sellaPresetParameters(algorithm,previous.parametersByAlgorithm[previous.algorithm]??{},'custom'),coordinateSystem:'ric'}}}))}/>
      {native?<PesSelect label="坐标系" value={String(values.coordinateSystem??'ric')} options={{ric:'冗余内坐标（RIC）',xyz:'XYZ'}} onChange={coordinateSystem=>update(previous=>({...previous,parametersByAlgorithm:{...previous.parametersByAlgorithm,[algorithm]:{...previous.parametersByAlgorithm[algorithm],coordinateSystem}}}))}/>:<span className="pes-method-fact">坐标系 Cartesian 等式约束</span>}</InputSettingsRow>
    <PesSelect label="每点优化收敛标准" value={preset} options={PES_CONVERGENCE_OPTIONS} onChange={value=>update(previous=>({...previous,scanConvergencePreset:value as PesCard['scanConvergencePreset'],parametersByAlgorithm:{...previous.parametersByAlgorithm,[algorithm]:native?sellaPresetParameters(algorithm,previous.parametersByAlgorithm[algorithm]??{},value as PesConvergencePreset):{...previous.parametersByAlgorithm[algorithm],...(value==='custom'?{}:SCAN_CONVERGENCE_PRESETS[value as keyof typeof SCAN_CONVERGENCE_PRESETS])}}}))}/>
    <InputSettingsRow>{fields.map(field=>{const value=values[field.key]??field.initial;let invalid=false;try{parameterValue(field,value);}catch{invalid=true;}return <PesText key={field.key} label={field.label} value={String(value)} unit={field.unit} invalid={!!touched[field.key]&&invalid} long={field.key!=='maxSteps'} onChange={text=>change(field.key,text)} onBlur={()=>setTouched(previous=>({...previous,[field.key]:true}))}/>;})}</InputSettingsRow>
  </PesDetails>;
}
