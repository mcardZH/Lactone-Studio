import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { baseElectronicStateParameterError as baseElectronicStateError, initialBaseElectronicState, pairEditedElectronicState, type BaseElectronicStateValues } from '../../core/base-electronic-state';
import {electronicStateWarning} from '../../core/elements';
import type { SharedModelConstraints } from '../../core/modeling/contracts';
import {pickerStructureIdentity} from '../../core/geometry-guides';
import {coordinatesFingerprint,graphFingerprint} from '../../core/modeling/graph';
import type {Structure} from '../../core/types';
import { confirmCoordinateSelection } from '../../modeling/application/coordinate-selection';
import { modelCoordinateKey } from '../../modeling/constraints';
import type { PesCardKind, PesGeometry, PesNode, PesParameter, PesConvergencePreset, PesSellaCoordinateSystem } from '../../modeling/pes/contracts';
import type { PesController } from '../../modeling/pes/controller';
import { PES_ALGORITHMS, PES_CARD_LABELS, PES_CONVERGENCE_OPTIONS, pesId, pesParameterSections, isSellaTsAlgorithm, usesPesExecutionProfile, sellaPresetParameters, withTsSellaCoordinates } from '../../modeling/pes/defaults';
import { cardSource, resolvePesConstraintTarget } from '../../modeling/pes/request';
import {pesElectronicConfirmed,PesCompositionChange,PesBranchInputError,pesElectronicSourceKey} from '../../modeling/pes/input-state';
import {readScanSource,scanSourceChoices,scanSourceKey} from '../../modeling/pes/scan-source';
import BaseElectronicStateFields from '../BaseElectronicStateFields';
import { DismissibleNotice } from '../DismissibleNotice';
import { InputSettingsCard, InputSettingsRow, InputSettingsStack } from '../InputSettingsFields';
import { InputSettingsCheckbox, InputSettingsLayout } from '../InputSettingsLayout';
import DialogShell from '../DialogShell';
import ConformerConstraintSettings from './ConformerConstraintSettings';
import { PesCalculationCard } from './pes-cards';
import type {AnalysisCaptureTarget} from '../results/useAnalysisAtomCapture';
import { isPesRunLive, PesDetails, PesExpressionEditor, pesMessage, PesMethodFields,
  PesParameterSections, PesRunControls, PesSelect, PesText, type PesSelectionScope } from './pes-fields';
import './pes-workspace.css';

export interface PesWorkspaceProps {
  controller: PesController;
  groupId: string;
  activeNodeId: string;
  geometry: PesGeometry;
  sourceReady?: boolean;
  captureActive?:boolean;
  onActivateNode(node: PesNode): void;
  onError?(message:string):void;
  selectionOwner:PesSelectionScope['owner'];
  onRequestSelection:PesSelectionScope['request'];
  onSelectionHighlight?:PesSelectionScope['highlight'];
  onElectronicStateChange?(values: BaseElectronicStateValues): void;
  onConstraintsChange?(constraints: SharedModelConstraints): SharedModelConstraints|void;
  additionalSources?: PesGeometry[];
}

const constraintKey=(row:SharedModelConstraints['coordinates'][number])=>row.id??modelCoordinateKey(row);
function GlobalConstraints({scope,geometry,value,change,targets,editTarget,perform,disabled}:{scope:PesSelectionScope;geometry:PesGeometry;value:SharedModelConstraints;
  change(update:(value:SharedModelConstraints)=>SharedModelConstraints,clearTargets?:readonly string[]):void;
  targets:Record<string,string>;editTarget(key:string,text:string|undefined):void;perform(action:()=>void):void;disabled:boolean;
}){
  const structure=scope.target.structure;
  const coordinates=value.coordinates.filter(row=>row.action==='freeze');
  function coordinate(id:string,atomIds:string[],existing?:SharedModelConstraints['coordinates'][number]){
    const measured=confirmCoordinateSelection(structure,atomIds);
    const row={type:measured.type,atomIds:measured.atomIds,value:measured.value,action:'freeze' as const,steps:1,increment:null,id:existing?.id??id};
    change(current=>{
      if(existing&&!current.coordinates.some(item=>constraintKey(item)===id))throw Error('内坐标约束已关闭。');
      if(current.coordinates.some(item=>constraintKey(item)!==id&&modelCoordinateKey(item)===modelCoordinateKey(row)))throw Error('该内坐标已有全局约束。');
      return {...current,coordinates:existing?current.coordinates.map(item=>constraintKey(item)===id?row:item):[...current.coordinates,row]};
    },existing?[id]:undefined);
  }
  const port={owner:scope.owner,contextKey:scope.target.contextKey,assertCurrent:()=>scope.target.assertCurrent(),requestSelection:(intent:Parameters<PesSelectionScope['request']>[0])=>scope.request({...intent,purpose:'advanced-region'},scope.target)};
  const source=structure.atoms.length?{structure,coordinateUnit:'angstrom' as const,label:scope.target.label??structure.name,constraints:value,
    ref:{documentId:geometry.documentId,documentEpoch:scope.target.contextKey,revision:geometry.revision,sourceId:geometry.source?.nodeId,runId:geometry.source?.runId,frameId:geometry.source?.frameId},
    stamp:{documentId:geometry.documentId,revision:geometry.revision,graphFingerprint:graphFingerprint(structure),coordinatesFingerprint:coordinatesFingerprint(structure),constraintsFingerprint:JSON.stringify(value)}}:null;
  return <PesDetails title="结构保护与约束" level="card">
    <InputSettingsCheckbox label="启用全局冻结与约束" checked={value.enabled!==false} onChange={enabled=>perform(()=>change(current=>({...current,enabled})))}/>
    <ConformerConstraintSettings title={null} source={source} atomIds={value.frozenAtomIds} coordinates={coordinates} ownerKey={scope.owner.id}
      atomPort={port} coordinatePort={port} atomsEditable={!disabled} coordinatesEditable={!disabled} onAtomRequest={()=>{}} onCoordinateRequest={()=>{}}
      onAtoms={frozenAtomIds=>change(current=>({...current,frozenAtomIds}))}
      onCoordinate={(ids,frozen,previous)=>{
        scope.target.assertCurrent();const key=modelCoordinateKey({type:previous?.type??confirmCoordinateSelection(structure,ids).type,atomIds:previous?.atomIds??ids});
        const row=coordinates.find(item=>modelCoordinateKey(item)===key);
        if(!frozen){if(!row)throw Error('冻结定义已变化。');const id=constraintKey(row);change(current=>({...current,coordinates:current.coordinates.filter(item=>constraintKey(item)!==id)}),[id]);}
        else coordinate(row?constraintKey(row):pesId('constraint'),ids,row);
        return true;
      }} renderCoordinateDetails={(row,index)=>{
      const identity=constraintKey(row);
      const field=targets[identity]??row.value?.toString()??'';
      let invalid=false;
      try{if(field.trim())resolvePesConstraintTarget(field,row.type,0);}catch{invalid=true;}
      return <PesText label={'约束目标'+(index+1)} value={field} unit={row.type==='B'?'Å':'°'} invalid={invalid} placeholder="运行源当前值" long
          onChange={text=>editTarget(identity,text)}
          onBlur={()=>{if(targets[identity]===undefined||invalid)return;perform(()=>{
            const value=field.trim()?resolvePesConstraintTarget(field,row.type,0):undefined;
            change(current=>({...current,coordinates:current.coordinates.map(item=>constraintKey(item)===identity?{...item,value}:item)}),[identity]);
          });}}/>;
    }}/>
  </PesDetails>;
}
export default function PesWorkspace(props: PesWorkspaceProps) {
  const { controller, groupId, activeNodeId, geometry } = props;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const group = snapshot.groups.find(group => group.id === groupId);
  useEffect(() => { controller.initializeTsSource(groupId, activeNodeId, geometry); },
    [controller, groupId, activeNodeId, geometry.ffModel?.modelId, geometry.source?.runId]);
  const [adding, setAdding] = useState(false);
  const [issue, setIssue] = useState({ text: '', version: 0 });
  const [compositionChange,setCompositionChange]=useState<PesCompositionChange|null>(null);
  const [electronicContext,setElectronicContext]=useState<{groupId:string;nodeId:string;cardId?:string;geometry?:PesGeometry}|null>(null);
  const [loadingSource,setLoadingSource]=useState<string|null>(null);
  const sourceRequest=useRef(0);
  const lastElectronic=useRef<{key:string;values:BaseElectronicStateValues}|null>(null);
  const editedElectronic=useRef(new Set<'charge'|'multiplicity'>());
  const latest = useRef(props); latest.current = props;
  const identities=useRef(new WeakMap<Structure,string>());
  if (!group) return null;
  const groupNode = group.nodes.find(node => node.id === activeNodeId);
  const activeSelection=groupNode?.selection;
  const activeFollow=groupNode?.followRunId;
  const activePreview=activeFollow?group.runs[activeFollow]?.preview:undefined;
  const latestEditableRun = groupNode && (groupNode.kind === 'workbench' || groupNode.kind === 'initial') ? group.runs[groupNode.runIds.at(-1) ?? ''] : undefined;
  const latestWorkbenchRun = latestEditableRun?.request.operation === 'opt' ? undefined : latestEditableRun;
  const latestOptimizationRun = latestEditableRun?.request.operation === 'opt' ? latestEditableRun : undefined;
  const sourceReady = props.sourceReady !== false;
  const currentSourceActions=sourceReady&&!props.captureActive;
  const workbenchLive = isPesRunLive(latestEditableRun);
  const calculationLocked = controller.calculationCardLocked(groupId);
  const browsedRun=group.runs[activeSelection?.runId??activeFollow??''];
  let electronicGeometry=browsedRun?.source??geometry;
  if(electronicContext?.groupId===groupId&&electronicContext.nodeId===activeNodeId){
    if(electronicContext.cardId){const card=group.cards.find(row=>row.id===electronicContext.cardId);if(card)try{electronicGeometry=cardSource(group,card);}catch{/* The card source field keeps its missing-source error. */}}
    else if(electronicContext.geometry)electronicGeometry=electronicContext.geometry;
  }
  const q = group.electronic.charge, m = group.electronic.multiplicity;
  const validQ = /^[+-]?\d+$/.test(q) && Number.isSafeInteger(Number(q));
  const validM = /^\+?\d+$/.test(m) && Number.isSafeInteger(Number(m)) && Number(m) > 0;
  const electronicIssue = validQ && validM ? baseElectronicStateError(electronicGeometry.structure, { charge: Number(q), multiplicity: Number(m) }) : '电荷必须为整数，自旋多重度必须为正整数。';
  const electronicKey=pesElectronicSourceKey(group,electronicGeometry);
  const electronicOwnerKey=JSON.stringify([groupId,electronicKey]);
  if(lastElectronic.current?.key!==electronicOwnerKey){lastElectronic.current={key:electronicOwnerKey,values:validQ&&validM?{charge:Number(q),multiplicity:Number(m)}:initialBaseElectronicState(electronicGeometry.structure)};editedElectronic.current.clear();}
  function sourceIdentity(structure:Structure){
    const cached=identities.current.get(structure);
    if(cached!==undefined)return cached;
    const identity=pickerStructureIdentity(structure);
    identities.current.set(structure,identity);
    return identity;
  }
  function selectionScope(source:PesGeometry,identity:string,assertSource:()=>void):PesSelectionScope{
    const target:AnalysisCaptureTarget={
      structure:source.structure,label:source.label??source.structure.name,displayGeometry:source,
      contextKey:JSON.stringify([groupId,activeNodeId,identity,source.documentId,source.revision,source.source,sourceIdentity(source.structure)]),
      assertCurrent(){
        if(latest.current.groupId!==groupId||latest.current.activeNodeId!==activeNodeId)throw Error('势能面选择所属页面已切换。');
        const owned=controller.getSnapshot().groups.find(item=>item.id===groupId),node=owned?.nodes.find(item=>item.id===activeNodeId);
        if(!node||node.selection!==activeSelection||node.followRunId!==activeFollow||activeFollow&&owned?.runs[activeFollow]?.preview!==activePreview)
          throw Error('势能面选择所属帧已变化，请重新选择。');
        assertSource();
      },
    };
    return {target,owner:props.selectionOwner,request:props.onRequestSelection,highlight:props.onSelectionHighlight};
  }
  const currentSelection=selectionScope(geometry,'current',()=>{
    const current=latest.current.geometry;
    if(latest.current.sourceReady===false||current.documentId!==geometry.documentId||current.revision!==geometry.revision||
      JSON.stringify(current.source)!==JSON.stringify(geometry.source)||sourceIdentity(current.structure)!==sourceIdentity(geometry.structure))
      throw Error('当前科学帧或结构版本已变化，请重新选择。');
  });
  const report = (error: unknown) => setIssue(previous => ({ text: pesMessage(error), version: previous.version + 1 }));
  const perform = (action: () => void) => {
    try { action(); setIssue(previous => ({ ...previous, text: '' })); }
    catch (error) {
      if(error instanceof PesCompositionChange){setCompositionChange(error);return;}
      if(error instanceof PesBranchInputError){props.onActivateNode(error.initial);props.onError?.(error.message);}
      report(error);
    }
  };
  function commitElectronic(field:'charge'|'multiplicity',text:string){
    if(!editedElectronic.current.has(field))return;
    const valid=field==='charge'?/^[+-]?\d+$/.test(text):/^\+?\d+$/.test(text);
    if(!valid||!Number.isSafeInteger(Number(text))||field==='multiplicity'&&Number(text)<1)return;
    const paired=pairEditedElectronicState(electronicGeometry.structure.atoms,lastElectronic.current!.values,field,Number(text));
    if(paired.error){report(paired.error);return;}
    lastElectronic.current={key:electronicOwnerKey,values:paired.values};editedElectronic.current.delete(field);
    const values={charge:String(paired.values.charge),multiplicity:String(paired.values.multiplicity)};
    if(values.charge!==q||values.multiplicity!==m)controller.editElectronicPair(groupId,values);
  }
  const stop = (runId: string) => { void controller.stop(groupId, runId).catch(report); };
  const ts = group.ts, values = ts.parametersByAlgorithm[ts.algorithm] ?? {};
  const sources = [...(sourceReady ? [{ ...geometry, label: '当前结构', source: { ...geometry.source, groupId, nodeId: activeNodeId } }] : []),
    ...group.nodes.map(node => controller.nodeGeometry(groupId, node.id)).filter((item): item is PesGeometry => !!item), ...(props.additionalSources ?? [])];
  const scanSources=scanSourceChoices(group);
  async function selectScanSource(cardId:string,key:string){
    const serial=++sourceRequest.current,selectedGroup=controller.getSnapshot().groups.find(row=>row.id===groupId),card=selectedGroup?.cards.find(row=>row.id===cardId);
    if(!selectedGroup||!card)return;
    setLoadingSource(cardId);
    try{
      const source=await readScanSource(selectedGroup,key,(runId,seriesId,frameId,recordId)=>controller.readFrame(groupId,runId,seriesId,frameId,undefined,recordId));
      const current=controller.getSnapshot().groups.find(row=>row.id===groupId),currentCard=current?.cards.find(row=>row.id===cardId);
      if(serial!==sourceRequest.current||latest.current.groupId!==groupId||latest.current.activeNodeId!==activeNodeId)return;
      if(!current||!currentCard||currentCard.slots!==card.slots||!scanSourceChoices(current).some(choice=>choice.key===key))throw Error('来源读取期间已变化，请重新选择。');
      const oldNode=selectedGroup.nodes.find(row=>row.id===source.source?.nodeId),node=current.nodes.find(row=>row.id===source.source?.nodeId);
      if(!source.source?.frameId&&oldNode?.geometry!==node?.geometry)throw Error('来源结构读取期间已变化，请重新选择。');
      controller.setSlot(groupId,cardId,'start',source);setElectronicContext({groupId,nodeId:activeNodeId,cardId});setIssue(previous=>({...previous,text:''}));
    }catch(error){if(serial===sourceRequest.current&&latest.current.groupId===groupId)report(error);}
    finally{if(serial===sourceRequest.current)setLoadingSource(null);}
  }
  const changeConstraints = (update: (value: SharedModelConstraints) => SharedModelConstraints,clearTargets?:readonly string[]) => {
    const previous = controller.getSnapshot().groups.find(item => item.id === groupId)?.constraints;
    if (!previous) return;
    const next = update(previous);
    controller.updateConstraints(groupId,next,{clearTargets,commitModel:()=>props.onConstraintsChange?.(next)});
  };
  const setTsParameter = (key: string, value: PesParameter) => controller.updateTs(groupId, draft => ({ ...draft, parametersByAlgorithm: {
    ...draft.parametersByAlgorithm, [ts.algorithm]: { ...draft.parametersByAlgorithm[ts.algorithm], [key]: value,
      ...(key === 'fmaxHartreePerBohr' ? { convergencePreset: 'custom' } : {}) },
  } }));
  return <InputSettingsLayout variant="standard" className="pes-workspace advanced-settings-surface"><InputSettingsStack kind="cards">
    {!controller.available && <DismissibleNotice>当前运行环境未连接势能面求解器。</DismissibleNotice>}
    <InputSettingsCard title="基础设置" sectionKey={`pes-base:${groupId}`} stack>
      <BaseElectronicStateFields embedded charge={Number(q)} multiplicity={Number(m)} confirmed={pesElectronicConfirmed(group,electronicGeometry)}
        rawText={{ charge: q, multiplicity: m }} rawInvalid={{ charge: !validQ, multiplicity: !validM }} error={electronicIssue}
        warning={validQ&&validM?electronicStateWarning(electronicGeometry.structure.atoms,Number(q),Number(m)):null}
        onChargeChange={value => controller.editElectronic(groupId, 'charge', String(value))}
        onMultiplicityChange={value => controller.editElectronic(groupId, 'multiplicity', String(value))}
        onRawTextChange={(field, value) => {editedElectronic.current.add(field);controller.editElectronic(groupId, field, value);}} onRawTextCommit={commitElectronic} confirmButtonText="确认"
        confirmationDisabled={!electronicGeometry.structure.atoms.length} onConfirm={() => perform(() => {
          const values = controller.confirmElectronic(groupId, electronicGeometry);
          if(!Object.values(group.runs).some(isPesRunLive)&&!activeSelection&&!activeFollow&&electronicKey===pesElectronicSourceKey(group,geometry))props.onElectronicStateChange?.(values);
        })}/>
    </InputSettingsCard>
    <GlobalConstraints scope={currentSelection} geometry={geometry} value={group.constraints} change={changeConstraints} perform={perform} disabled={!sourceReady}
      targets={group.constraintTargets ?? {}} editTarget={(id, text) => controller.editConstraintTarget(groupId, id, text)}/>
    <InputSettingsRow>
      <button type="button" className="button button-primary" disabled={calculationLocked} aria-expanded={adding} onClick={() => setAdding(value => !value)}>选择计算卡</button>
      {adding && !calculationLocked && [
        {kind:'scan' as const,algorithm:'sella-scan',label:'内坐标扫描'},
        {kind:'path' as const,algorithm:'ci-neb',label:'CI-NEB'},
        {kind:'path' as const,algorithm:'fsm',label:'FSM'},
        {kind:'path' as const,algorithm:'de-gsm',label:'GSM'},
      ].map(choice => <button type="button" className="button" key={choice.algorithm} onClick={() => perform(() => {
        controller.selectCalculationCard(groupId,choice.kind,choice.algorithm); setAdding(false);
      })}>{choice.label}</button>)}
    </InputSettingsRow>
    {group.cards.map(card => {
      const run = group.runs[card.runIds.at(-1) ?? ''];
      let source:PesGeometry,sourceIssue='';
      try{source=cardSource(group,card);}catch(error){sourceIssue=pesMessage(error);source=group.nodes.find(node=>node.id===group.initialNodeId)?.geometry??geometry;}
      const slot=card.kind==='path'?'reactant':'start';
      const scope=selectionScope(source,card.id+':'+slot,()=>{
        const current=controller.getSnapshot().groups.find(item=>item.id===groupId),currentCard=current?.cards.find(item=>item.id===card.id);
        if(!current||!currentCard||currentCard.algorithm!==card.algorithm||currentCard.slots!==card.slots)
          throw Error('计算卡的来源槽已变化，请重新选择。');
        const actual=cardSource(current,currentCard);
        if(actual.documentId!==source.documentId||actual.revision!==source.revision||sourceIdentity(actual.structure)!==sourceIdentity(source.structure)||scanSourceKey(actual)!==scanSourceKey(source))throw Error('计算卡的起始结构已变化，请重新选择。');
      });
      return <div key={card.id} className="pes-card-input-owner" onFocusCapture={()=>setElectronicContext({groupId,nodeId:activeNodeId,cardId:card.id})}>
      <PesCalculationCard card={card} source={source} sources={sources} scope={scope} run={run} available={controller.available} canCapture={currentSourceActions}
        scanSources={scanSources} sourceIssue={sourceIssue} sourceLoading={loadingSource===card.id} selectScanSource={key=>{void selectScanSource(card.id,key);}}
        update={edit => controller.updateCard(groupId, card.id, edit)} setSlot={(slot, source) => controller.setSlot(groupId, card.id, slot, source)}
        capture={slot => perform(() => {currentSelection.target.assertCurrent();controller.captureSnapshot(groupId, card.id, slot, { ...geometry, source: { ...geometry.source, groupId, nodeId: activeNodeId } });setElectronicContext({groupId,nodeId:activeNodeId,cardId:card.id});})}
        start={() => {setElectronicContext({groupId,nodeId:activeNodeId,cardId:card.id});perform(() => props.onActivateNode(controller.startCard(groupId, card.id, geometry.documentId)));}}
        selectAlgorithm={algorithm=>perform(()=>{controller.selectCalculationCard(groupId,'path',algorithm);})}
        stop={() => { if (run) stop(run.request.id); }} move={direction => controller.moveCard(groupId, card.id, direction)}
        remove={() => perform(() => controller.removeCard(groupId, card.id))}/></div>;
    })}
    {latestOptimizationRun && <PesRunControls run={latestOptimizationRun} stop={() => stop(latestOptimizationRun.request.id)}/>}
    <PesDetails title="过渡态搜索" sectionKey={'pes-ts:'+groupId} level="card" defaultOpen>
      <p>当前结构 {groupNode?.name ?? geometry.structure.name}{geometry.source?.frameId ? ' · 所选帧' : ''}</p>
      <PesMethodFields value={ts.method} onChange={method => controller.updateTs(groupId, draft => ({ ...draft, method }))}/>
      <InputSettingsRow className="pes-algorithm-coordinate-row">
        <PesSelect label="优化算法" value={ts.algorithm} options={PES_ALGORITHMS.ts} onChange={algorithm => controller.updateTs(groupId, draft => ({ ...draft, algorithm }))}/>
        {isSellaTsAlgorithm(ts.algorithm) && <PesSelect label="坐标系" value={usesPesExecutionProfile(values)?ts.sellaCoordinateSystem??(values.coordinateSystem==='ric'?'ric':'xyz'):'xyz'} options={{xyz:'XYZ（推荐）',ric:'冗余内坐标'}}
          onChange={value => controller.updateTs(groupId, draft => withTsSellaCoordinates(draft,value as PesSellaCoordinateSystem))}/>}
      </InputSettingsRow>
      {ts.algorithm === 'climb' && <PesExpressionEditor label="爬坡坐标" value={ts.reaction} scope={currentSelection} rowPrefix="ts:climb"
        change={update => controller.updateTs(groupId, draft => ({ ...draft, reaction: update(draft.reaction) }))}/>}
      {isSellaTsAlgorithm(ts.algorithm) && <PesSelect label="TS收敛标准" value={usesPesExecutionProfile(values) ? String(values.convergencePreset ?? 'custom') : 'legacy'}
        options={{ ...(!usesPesExecutionProfile(values) ? { legacy: '旧版四项判据' } : {}), ...PES_CONVERGENCE_OPTIONS }}
        onChange={value => controller.updateTs(groupId, draft => ({ ...draft, parametersByAlgorithm: { ...draft.parametersByAlgorithm,
          [draft.algorithm]: sellaPresetParameters(draft.algorithm, draft.parametersByAlgorithm[draft.algorithm] ?? {}, value as PesConvergencePreset) } }))}/>}
      <PesParameterSections sections={pesParameterSections(ts.algorithm,values)} values={values} method={ts.method.method} onChange={setTsParameter}/>
      {!workbenchLive && <InputSettingsRow variant="actions">{(['ts', 'hessian'] as const).map(operation => <button key={operation} type="button" className="button button-primary"
        disabled={!controller.available || !currentSourceActions} onClick={() => {setElectronicContext({groupId,nodeId:activeNodeId,geometry});perform(() => props.onActivateNode(controller.startWorkbench(groupId, activeNodeId, geometry, operation)));}}>
        {operation === 'ts' ? '计算TS' : '计算Hessian'}</button>)}</InputSettingsRow>}
      <p>TS优化收敛后自动进行频率分析。</p>
      {latestWorkbenchRun && <PesRunControls run={latestWorkbenchRun} stop={() => stop(latestWorkbenchRun.request.id)}/>}
    </PesDetails>
    <DismissibleNotice identity={issue.version}>{issue.text}</DismissibleNotice>
    {compositionChange&&<DialogShell aria-label="原子组成已改变" onCancel={()=>setCompositionChange(null)} className="pes-composition-dialog"><h2>原子组成已改变</h2><p>{compositionChange.message}</p><div className="modal-buttons">
      <button type="button" className="button" onClick={()=>setCompositionChange(null)}>留在此页</button>
      <button type="button" className="button button-primary" onClick={()=>{const action=compositionChange;setCompositionChange(null);perform(()=>props.onActivateNode(action.continueInNewGroup()));}}>在新页继续</button>
    </div></DialogShell>}
  </InputSettingsStack></InputSettingsLayout>;
}
