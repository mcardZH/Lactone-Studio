import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {AdvancedFrameSource} from '../../modeling/advanced/frame-source';
import type {SharedModelConstraints} from '../../core/modeling/contracts';
import type {AnalysisSelectionPort} from '../analysis-selection-intent';
import {confirmCoordinateSelection} from '../../modeling/application/coordinate-selection';
import {modelCoordinateKey} from '../../modeling/constraints';
import {pickerStructureIdentity} from '../../core/geometry-guides';
import InteractiveSelectionField,{SelectionAddButton,SelectionGroupHeader,SelectionRemoveButton} from '../InteractiveSelectionField';
import {InputSettingsCard,InputSettingsStack} from '../InputSettingsFields';
import {InputSettingsAction} from '../InputSettingsLayout';
import {DismissibleNotice} from '../DismissibleNotice';
import {useProjectState} from '../../projects/ui-state';
import './conformer-constraint-settings.css';

export interface ConformerCoordinateSelection {type:'B'|'A'|'D';atomIds:string[];images?:import('../../core/types').Vector3[]}
export interface ConformerConstraintSettingsProps {
 source:AdvancedFrameSource|null;atomIds:readonly string[];coordinates:SharedModelConstraints['coordinates'];
 ownerKey?:string;
 atomPort:AnalysisSelectionPort;coordinatePort:AnalysisSelectionPort;atomsEditable:boolean;coordinatesEditable:boolean;
 onAtomRequest():void;onCoordinateRequest():void;
 onAtoms(ids:string[]):void;
 onCoordinate(ids:string[],frozen:boolean,previous?:ConformerCoordinateSelection,images?:import('../../core/types').Vector3[]):boolean|Promise<boolean>;
 coordinateImageSelection?:boolean;
 title?:ReactNode;
 renderCoordinateDetails?(row:SharedModelConstraints['coordinates'][number],index:number):ReactNode;
}
interface CoordinateDraft {id:string;session:string;context:string;picking?:boolean}
interface CommitOperation {serial:number;draftId?:string;session:string;context:string}
const reason=(error:unknown)=>error instanceof Error?error.message:String(error);

/** Store owns confirmed freezes; this initial-page editor owns one unconfirmed
 * row. Neither the draft nor disclosure changes a sampling/run snapshot. */
export default function ConformerConstraintSettings(p:ConformerConstraintSettingsProps){
 const structure=p.source?.structure??null;
 const disclosureKey=JSON.stringify([p.ownerKey,p.source?.ref.documentId]);
 const identity=useMemo(()=>structure&&pickerStructureIdentity(structure),[structure]);
 const session=useMemo(()=>JSON.stringify([disclosureKey,p.source?.ref.documentEpoch,p.source?.ref.sourceId,p.source?.ref.sourceRevision,p.source?.ref.frameId,p.source?.ref.sourceFrameIndex,
  p.atomPort.owner.id,p.coordinatePort.owner.id,identity,structure?.charge,structure?.multiplicity,p.source?.stamp.graphFingerprint]),
  [disclosureKey,p.source?.ref.documentEpoch,p.source?.ref.sourceId,p.source?.ref.sourceRevision,p.source?.ref.frameId,p.source?.ref.sourceFrameIndex,p.atomPort.owner.id,p.coordinatePort.owner.id,identity,structure?.charge,structure?.multiplicity,p.source?.stamp.graphFingerprint]);
 const context=useMemo(()=>JSON.stringify([session,p.coordinatePort.contextKey,p.source?.ref.revision,p.source?.stamp]),[session,p.coordinatePort.contextKey,p.source?.ref.revision,p.source?.stamp]);
 const [draft,setDraft]=useState<CoordinateDraft|null>(null),draftRef=useRef(draft);draftRef.current=draft;
 const [collapsed,setCollapsed]=useProjectState('conformer-constraints.disclosure',{atoms:true,coordinates:true},disclosureKey);
 const fold=(kind:'atoms'|'coordinates',value:boolean)=>setCollapsed(previous=>({...previous,[kind]:value}));
 const [operation,setOperation]=useState<CommitOperation|null>(null),operationRef=useRef<CommitOperation|null>(null),serial=useRef(0);
 const [issue,setIssue]=useState<{serial:number;session:string;message:string}|null>(null);
 const alive=useRef(true),latest=useRef({p,session,context});latest.current={p,session,context};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;serial.current++;operationRef.current=null;draftRef.current=null;};},[]);
 useEffect(()=>{
  const current=draftRef.current,working=operationRef.current;
  if(working&&working.session!==session){serial.current++;operationRef.current=null;setOperation(null);}
  if(current&&(current.session!==session||current.context!==context&&!working)){draftRef.current=null;setDraft(null);}
  if(issue&&issue.session!==session)setIssue(null);
 },[session,context]);
 const currentDraft=draft?.session===session&&(draft.context===context||operation?.draftId===draft.id)?draft:null;
 const busy=operation!==null;
 const coordinateName=(ids:readonly string[])=>ids.map(id=>(structure?.atoms.findIndex(atom=>atom.id===id)??-1)+1).join(' ');
 const readout=(ids:readonly string[],images?:readonly import('../../core/types').Vector3[])=>{
  if(!structure)return '当前来源不可用';
  try{const value=confirmCoordinateSelection(structure,ids,images);return `${value.type} ${coordinateName(ids)} · ${Number(value.value.toPrecision(7))} ${value.unit}`;}
  catch(error){return reason(error);}
 };
 function cancelDraft(id:string){
  if(operationRef.current?.draftId===id||draftRef.current?.id!==id)return;
  draftRef.current=null;setDraft(null);setIssue(null);
 }
 function addDraft(){
  if(!p.coordinatesEditable||draftRef.current||operationRef.current)return;
  const next={id:`conformer-coordinate-new-${crypto.randomUUID()}`,session,context};
  draftRef.current=next;setDraft(next);setIssue(null);fold('coordinates',false);
 }
 function commit(ids:string[],frozen:boolean,previous?:ConformerCoordinateSelection,draftId?:string,images?:import('../../core/types').Vector3[]){
  const current=latest.current;
  if(!current.p.coordinatesEditable||current.session!==session||current.context!==context)throw Error('内坐标所属初猜或来源已变化，请重新编辑。');
  if(operationRef.current)throw Error('当前内坐标正在确认，请等待回执。');
  if(draftId&&(draftRef.current?.id!==draftId||draftRef.current.context!==context))throw Error('新增内坐标草稿已取消或失效。');
  if(!structure)throw Error('当前来源不可用。');
  const measured=confirmCoordinateSelection(structure,ids,images);
  if(frozen&&!previous&&p.coordinates.some(row=>modelCoordinateKey(row)===modelCoordinateKey(measured)))throw Error('该内坐标已有冻结定义，请编辑现有条目。');
  const own:CommitOperation={serial:++serial.current,draftId,session,context};operationRef.current=own;setOperation(own);setIssue(null);
  const finish=(accepted:boolean,error?:unknown,report=true)=>{
   if(!alive.current||operationRef.current!==own||latest.current.session!==own.session)return;
   operationRef.current=null;setOperation(null);
   if(accepted){if(draftId&&draftRef.current?.id===draftId){draftRef.current=null;setDraft(null);fold('coordinates',false);}return;}
   if(latest.current.context!==own.context){if(draftRef.current?.id===draftId){draftRef.current=null;setDraft(null);}return;}
   if(report)setIssue({serial:own.serial,session:own.session,message:error?reason(error):'本次内坐标未提交，请核对后重试。'});
  };
  try{
   const receipt=p.coordinateImageSelection?p.onCoordinate([...ids],frozen,previous,images):p.onCoordinate([...ids],frozen,previous);
   if(receipt&&typeof receipt==='object'&&'then' in receipt){void receipt.then(accepted=>finish(accepted===true),error=>finish(false,error));return;}
   if(receipt!==true)throw Error('本次内坐标未提交，请核对后重试。');
   finish(true);
  }catch(error){finish(false,error,false);throw error;}
 }
 const remove=(ids:string[],previous:ConformerCoordinateSelection)=>{try{commit(ids,false,p.coordinateImageSelection?previous:undefined,undefined,previous.images);}catch(error){setIssue({serial:++serial.current,session,message:reason(error)});}};
 const field=(ids:readonly string[],rowId:string,label:string,previous?:ConformerCoordinateSelection,draftId?:string)=><fieldset className="conformer-coordinate-editor" disabled={busy}><InteractiveSelectionField
  structure={structure} label={label} rowId={rowId} kind="coordinate" atomIds={ids} coordinateImages={previous?.images} captureOwner={p.coordinatePort.owner}
  contextKey={p.coordinatePort.contextKey} analysisPurpose="advanced-coordinate" disabled={!p.coordinatesEditable} liveNumberDraft wrapActions
  onRequestAnalysisSelection={intent=>{
   p.onCoordinateRequest();
   const handle=p.coordinatePort.requestSelection(intent);
   if(draftId&&draftRef.current?.id===draftId){const next={...draftRef.current,picking:true};draftRef.current=next;setDraft(next);}
   return handle;
  }}
  onConfirm={(ids,guard,_overwrite,images)=>{guard();commit(ids,true,previous,draftId,p.coordinateImageSelection?images:undefined);}}
  onEnd={result=>{if(draftId&&draftRef.current?.id===draftId){const next={...draftRef.current,picking:false};draftRef.current=next;setDraft(next);}if(result==='cancelled'&&draftId&&latest.current.p.coordinatesEditable)cancelDraft(draftId);}}
  renderHeader={previous?()=> <SelectionGroupHeader title={<span className="advanced-coordinate-readout">{readout(ids,previous.images)}</span>}
   actions={<SelectionRemoveButton label={`解除冻结 ${readout(ids,previous.images)}`} disabled={!p.coordinatesEditable||busy} onClick={()=>remove([...ids],previous)}/>}/>:undefined}
  renderDraft={(ids,images)=>ids.length>=2?<output className="advanced-coordinate-readout">当前值 {readout(ids,images)}</output>:undefined}/></fieldset>;
 return <InputSettingsCard level="inline" title={p.title===undefined?'结构保护与约束':p.title} stack testId="conformer-constraint-settings">
  <InteractiveSelectionField structure={structure} label="冻结原子" rowId="conformer:frozen-atoms" atomIds={p.atomIds}
   captureOwner={p.atomPort.owner} contextKey={p.atomPort.contextKey} analysisPurpose="advanced-region" disabled={!p.atomsEditable} liveNumberDraft wrapActions
   remainingAtomIds={structure?.atoms.flatMap(atom=>atom.id&&!p.atomIds.includes(atom.id)?[atom.id]:[])}
   onRequestAnalysisSelection={intent=>{p.onAtomRequest();return p.atomPort.requestSelection(intent);}}
   onConfirm={(ids,guard)=>{guard();p.onAtoms(ids);}}
   onClear={()=>p.onAtoms([])} clearLabel="清空冻结原子" clearDisabled={!p.atomIds.length}
   renderContainer={(body,clearAction)=><InputSettingsCard level="subcard" title={`冻结原子（${p.atomIds.length}）`} titleRole="subcard" stack testId="conformer-core-protection-card"
    sectionKey={`${disclosureKey}:atom-freezes`} actions={clearAction} disclosure={{collapsed:collapsed.atoms,onChange:value=>fold('atoms',value)}}>{body}</InputSettingsCard>}/>
  <InputSettingsCard level="subcard" title={`冻结内坐标（${p.coordinates.length}）`} titleRole="subcard" stack testId="conformer-coordinate-freeze-card"
   sectionKey={`${disclosureKey}:coordinate-freezes`} disclosure={{collapsed:collapsed.coordinates,onChange:value=>fold('coordinates',value)}}
   actions={<SelectionAddButton label="添加内坐标" disabled={!p.coordinatesEditable||!!currentDraft||busy} onClick={addDraft}/>}>
   {p.coordinates.map((row,index)=><InputSettingsStack key={row.id??`${row.type}:${row.atomIds.join(':')}`} className="advanced-coordinate-definition">
    {field(row.atomIds,`conformer:coordinate:${row.id??index}`,`冻结内坐标${index+1}`,{type:row.type,atomIds:[...row.atomIds],...(row.images?{images:row.images}:{})})}
    {p.renderCoordinateDetails?p.renderCoordinateDetails(row,index):row.value!==undefined&&<output className="advanced-coordinate-readout">冻结目标 {row.value} {row.type==='B'?'Å':'°'}</output>}
   </InputSettingsStack>)}
   {currentDraft&&<div data-testid="conformer-coordinate-pending" data-draft-id={currentDraft.id} data-submitting={busy||undefined}>
    <p role="status">冻结坐标 {p.coordinates.length+1} · {currentDraft.picking?'点选中':'待确认'}{busy?' · 正在确认':''}</p>
    {field([],currentDraft.id,'新内坐标',undefined,currentDraft.id)}
    <InputSettingsAction ariaLabel="取消添加内坐标" disabled={busy} onClick={()=>cancelDraft(currentDraft.id)}>取消添加</InputSettingsAction>
   </div>}
   {issue?.session===session&&<DismissibleNotice identity={issue.serial}>{issue.message}</DismissibleNotice>}
  </InputSettingsCard>
 </InputSettingsCard>;
}
