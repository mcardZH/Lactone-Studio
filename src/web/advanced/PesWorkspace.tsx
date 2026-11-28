import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {XtbResourceOverrideField} from '../TaskResourceFields';
import {validXtbResourceOverride} from '../../modeling/resource-preferences';
import { baseElectronicStateParameterError as baseElectronicStateError, initialBaseElectronicState, pairEditedElectronicState, type BaseElectronicStateValues } from '../../core/base-electronic-state';
import {electronicStateWarning} from '../../core/elements';
import type { SharedModelConstraints } from '../../core/modeling/contracts';
import {pickerStructureIdentity} from '../../core/geometry-guides';
import {coordinatesFingerprint,graphFingerprint} from '../../core/modeling/graph';
import type {Structure,Vector3} from '../../core/types';
import { confirmCoordinateSelection } from '../../modeling/application/coordinate-selection';
import { modelCoordinateKey } from '../../modeling/constraints';
import {periodicPesOperationAvailable} from '../../modeling/pes/periodic-capabilities';
import type { PesGeometry, PesNode, PesParameter, PesParameters, PesConvergencePreset, PesSellaCoordinateSystem } from '../../modeling/pes/contracts';
import {isPesTrainedStateNetMethod} from '../../modeling/pes/contracts';
import type { PesController } from '../../modeling/pes/controller';
import { PES_ALGORITHMS, PES_CONVERGENCE_OPTIONS, defaultPesMethod, effectivePesScanAlgorithm, projectedForcePreset, pesId, pesParameterSections, isSellaTsAlgorithm, usesPesExecutionProfile, sellaPresetParameters, withTsSellaCoordinates } from '../../modeling/pes/defaults';
import { cardSource, mergePesConstraintEdit, projectPesConstraintDefinitions, resolvePesConstraintTarget } from '../../modeling/pes/request';
import {pesElectronicConfirmed,pesElectronicDraft,PesCompositionChange,pesElectronicSourceKey} from '../../modeling/pes/input-state';
import {samePesScanSource} from '../../modeling/pes/scan-source';
import {pesTabAdmissionIssue} from '../../modeling/pes/tab-admission';
import BaseElectronicStateFields from '../BaseElectronicStateFields';
import { DismissibleNotice } from '../DismissibleNotice';
import { InputSettingsCard, InputSettingsRow, InputSettingsStack } from '../InputSettingsFields';
import { InputSettingsCheckbox, InputSettingsLayout } from '../InputSettingsLayout';
import DialogShell from '../DialogShell';
import ConformerConstraintSettings from './ConformerConstraintSettings';
import { PesCalculationCard } from './pes-cards';
import type {AnalysisCaptureTarget} from '../results/useAnalysisAtomCapture';
import { pesGroupSnapshotSources, type PesTabSnapshotSource } from '../modeling/pes-tab-snapshot';
import { isPesNetMethod, isPesRunLive, PesDetails, PesExpressionEditor, pesMessage, PesMethodFields,
  PesParameterSections, PesRunControls, PesSelect, PesText, type PesSelectionScope } from './pes-fields';
import './pes-workspace.css';

export interface PesWorkspaceProps {
  controller: PesController;
  groupId: string;
  activeNodeId: string;
  geometry: PesGeometry;
  sourceReady?: boolean;
  readCurrentGeometry?():PesGeometry|undefined;
  readCurrentSnapshot?():PesGeometry|undefined;
  readCurrentScanGeometry?():PesGeometry|undefined;
  captureActive?:boolean;
  onActivateNode(node: PesNode): void;
  selectionOwner:PesSelectionScope['owner'];
  onRequestSelection:PesSelectionScope['request'];
  onSelectionHighlight?:PesSelectionScope['highlight'];
  onConstraintsChange?(constraints: SharedModelConstraints): SharedModelConstraints|void;
  additionalSources?: readonly PesTabSnapshotSource[];
}

const IRC_LIMITS = {
  loose: { endpointForce: .1, correctorForce: .02 },
  medium: { endpointForce: .05, correctorForce: .01 },
  tight: { endpointForce: .025, correctorForce: .005 },
};
const IRC_NUMBERS = [
  { key: 'stepMassAngstrom', label: '路径步长', unit: 'Å·√amu', fallback: .1, integer: false },
  { key: 'maxSteps', label: '每向最大步数', fallback: 50, integer: true },
  { key: 'endpointForce', label: '端点力', unit: 'eV/Å', fallback: .05, integer: false },
  { key: 'correctorForce', label: '点内校正力', unit: 'eV/Å', fallback: .01, integer: false },
  { key: 'recalcInterval', label: '每 N 个有效点重算', fallback: 5, integer: true },
] as const;
const validPositive = (value: unknown, integer = false) =>
  Number.isFinite(Number(value)) && Number(value) > 0 && (!integer || Number.isSafeInteger(Number(value)));
function IrcSettings({ groupId, values, update }: { groupId: string; values: PesParameters; update(patch: PesParameters): void }) {
  const preset = String(values.convergencePreset ?? 'medium');
  const recalculating = values.recalcInterval != null && Number(values.recalcInterval) !== 0 || values.recalcInterval === '';
  const renderNumber = ({ key, label, unit, fallback, integer }: (typeof IRC_NUMBERS)[number] & { unit?: string }) => {
    const value = values[key] ?? fallback;
    return <PesText key={key} label={label} unit={unit} value={String(value)} invalid={!validPositive(value, integer)}
      onChange={text => update({ [key]: text })}/>;
  };
  return <PesDetails title="IRC 设置" sectionKey={`pes-irc:${groupId}`} level="card">
    <InputSettingsRow>
      {IRC_NUMBERS.slice(0, 2).map(renderNumber)}
      <PesSelect label="IRC 收敛限度" value={preset} options={PES_CONVERGENCE_OPTIONS} onChange={convergencePreset =>
        update({ convergencePreset, ...IRC_LIMITS[convergencePreset as keyof typeof IRC_LIMITS] })}/>
    </InputSettingsRow>
    {preset === 'custom' && <InputSettingsRow>{IRC_NUMBERS.slice(2, 4).map(renderNumber)}</InputSettingsRow>}
    <InputSettingsRow>
      <PesSelect label="IRC Hessian 策略" value={recalculating ? 'periodic' : 'initial'}
        options={{ initial: '仅起点', periodic: '每 N 点重算' }} onChange={value => update({ recalcInterval: value === 'periodic' ? 5 : 0 })}/>
      {recalculating && renderNumber(IRC_NUMBERS[4])}
      <PesText label="起始模态" value={values.mode === 'auto' || values.mode === 0 ? '' : String(values.mode ?? '')}
        placeholder="自动" invalid={!!values.mode && values.mode !== 'auto' && !validPositive(values.mode, true)}
        onChange={mode => update({ mode: mode.trim() ? mode : 'auto' })}/>
    </InputSettingsRow>
  </PesDetails>;
}

function HessianSettings({ groupId, step, update }: { groupId: string; step: number; update(step: number): void }) {
  const [editing, setEditing] = useState<string>();
  const valid = editing === undefined || validPositive(editing);
  return <PesDetails title="Hessian 设置" sectionKey={`pes-hessian:${groupId}`} level="card">
    <PesText label="差分步长" unit="Bohr" value={editing ?? String(step)} invalid={!valid} long onChange={value => {
      setEditing(value);
      if (validPositive(value)) update(Number(value));
    }} onBlur={() => { if (valid) setEditing(undefined); }}/>
  </PesDetails>;
}

const constraintKey=(row:SharedModelConstraints['coordinates'][number])=>row.id??modelCoordinateKey(row);
function GlobalConstraints({scope,geometry,value,change,targets,editTarget,perform,disabled}:{scope:PesSelectionScope;geometry:PesGeometry;value:SharedModelConstraints;
  change(update:(value:SharedModelConstraints)=>SharedModelConstraints,clearTargets?:readonly string[]):void;
  targets:Record<string,string>;editTarget(key:string,text:string|undefined):void;perform(action:()=>void):void;disabled:boolean;
}){
  const structure=scope.target.structure;
  const coordinates=value.coordinates.filter(row=>row.action==='freeze');
  function coordinate(id:string,atomIds:string[],existing?:SharedModelConstraints['coordinates'][number],images?:Vector3[]){
    const measured=confirmCoordinateSelection(structure,atomIds,images);
    const row={type:measured.type,atomIds:measured.atomIds,value:measured.value,action:'freeze' as const,steps:1,increment:null,id:existing?.id??id,
      ...(images?.some(image=>image.some(Boolean))?{images}:{})};
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
    <InputSettingsCheckbox label="启用全局冻结与约束" checked={value.enabled!==false} disabled={disabled} onChange={enabled=>perform(()=>change(current=>({...current,enabled})))}/>
    <ConformerConstraintSettings title={null} source={source} atomIds={value.frozenAtomIds} coordinates={coordinates} ownerKey={scope.owner.id}
      atomPort={port} coordinatePort={port} atomsEditable={!disabled} coordinatesEditable={!disabled} coordinateImageSelection onAtomRequest={()=>{}} onCoordinateRequest={()=>{}}
      onAtoms={frozenAtomIds=>change(current=>({...current,frozenAtomIds}))}
      onCoordinate={(ids,frozen,previous,images)=>{
        scope.target.assertCurrent();const key=modelCoordinateKey(previous??{type:confirmCoordinateSelection(structure,ids,images).type,atomIds:ids,images});
        const row=coordinates.find(item=>modelCoordinateKey(item)===key);
        if(!frozen){if(!row)throw Error('冻结定义已变化。');const id=constraintKey(row);change(current=>({...current,coordinates:current.coordinates.filter(item=>constraintKey(item)!==id)}),[id]);}
        else coordinate(row?constraintKey(row):pesId('constraint'),ids,row,images);
        return true;
      }} renderCoordinateDetails={(row,index)=>{
      const identity=constraintKey(row);
      const field=targets[identity]??row.value?.toString()??'';
      let invalid=false;
      try{if(field.trim())resolvePesConstraintTarget(field,row.type,0);}catch{invalid=true;}
      return <PesText label={'约束目标'+(index+1)} value={field} unit={row.type==='B'?'Å':'°'} invalid={invalid} placeholder="运行源当前值" long disabled={disabled}
          onChange={text=>editTarget(identity,text)}
          onBlur={()=>{if(disabled||targets[identity]===undefined||invalid)return;perform(()=>{
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
  const [adding, setAdding] = useState(false);
  const [issue, setIssue] = useState({ text: '', version: 0 });
  const [compositionChange,setCompositionChange]=useState<{error:PesCompositionChange;nodeId:string}|null>(null);
  const [electronicContext,setElectronicContext]=useState<{groupId:string;nodeId:string;cardId?:string;geometry?:PesGeometry}|null>(null);
  const [loadingSource,setLoadingSource]=useState<string|null>(null);
  const sourceRequest=useRef<AbortController|null>(null);
  useEffect(()=>()=>sourceRequest.current?.abort(),[controller,groupId,activeNodeId]);
  const lastElectronic=useRef<{key:string;values:BaseElectronicStateValues}|null>(null);
  const editedElectronic=useRef(new Set<'charge'|'multiplicity'>());
  const latest = useRef(props); latest.current = props;
  const identities=useRef(new WeakMap<Structure,string>());
  if (!group) return null;
  const groupNode = group.nodes.find(node => node.id === activeNodeId);
  const nodeRun = group.runs[groupNode?.runIds.at(-1) ?? ''];
  const latestEditableRun = groupNode && (groupNode.kind === 'workbench' || groupNode.kind === 'initial') || nodeRun?.request.operation === 'irc' ? nodeRun : undefined;
  const latestWorkbenchRun = latestEditableRun?.request.operation === 'opt' ? undefined : latestEditableRun;
  const latestOptimizationRun = latestEditableRun?.request.operation === 'opt' ? latestEditableRun : undefined;
  const sourceReady = props.sourceReady !== false;
  const currentSourceActions=sourceReady&&!props.captureActive;
  const workbenchLive = isPesRunLive(latestEditableRun);
  const calculationLocked = controller.calculationCardLocked(groupId);
  const scanGeometry=group.cards.some(card=>card.kind==='scan')
    ? props.readCurrentScanGeometry?props.readCurrentScanGeometry():sourceReady?geometry:undefined
    : undefined;
  let electronicGeometry=geometry;
  if(scanGeometry)electronicGeometry=scanGeometry;
  if(electronicContext?.groupId===groupId&&electronicContext.nodeId===activeNodeId){
    if(electronicContext.cardId){const card=group.cards.find(row=>row.id===electronicContext.cardId);if(card)try{electronicGeometry=cardSource(group,card,scanGeometry);}catch{/* The card source field keeps its missing-source error. */}}
    else electronicGeometry=geometry;
  }
  const sharedMethod = group.sharedMethod ?? defaultPesMethod();
  let methodGeometry:PesGeometry|undefined=sourceReady?geometry:undefined;
  if(electronicContext?.groupId===groupId&&electronicContext.nodeId===activeNodeId&&electronicContext.geometry)
    methodGeometry=geometry;
  else if(group.cards[0]?.kind==='path'||group.cards[0]?.kind==='scan'){
    try{methodGeometry=cardSource(group,group.cards[0],scanGeometry);}catch{methodGeometry=undefined;}
  }
  const trainedState = isPesTrainedStateNetMethod(sharedMethod.method);
  const {charge: q, multiplicity: m} = pesElectronicDraft(group,electronicGeometry);
  const validQ = /^[+-]?\d+$/.test(q) && Number.isSafeInteger(Number(q));
  const validM = /^\+?\d+$/.test(m) && Number.isSafeInteger(Number(m)) && Number(m) > 0;
  const electronicIssue = validQ && validM ? baseElectronicStateError(electronicGeometry.structure, { charge: Number(q), multiplicity: Number(m) }) : '电荷必须为整数，自旋多重度必须为正整数。';
  const electronicKey=pesElectronicSourceKey(group,electronicGeometry);
  const {charge:sourceCharge,multiplicity:sourceMultiplicity}=electronicGeometry.structure;
  const electronicOwnerKey=JSON.stringify([electronicKey,sourceCharge,sourceMultiplicity]);
  if(lastElectronic.current?.key!==electronicOwnerKey){
    lastElectronic.current={key:electronicOwnerKey,values:validQ&&validM?{charge:Number(q),multiplicity:Number(m)}:initialBaseElectronicState(electronicGeometry.structure)};
    editedElectronic.current.clear();
  }else if(!editedElectronic.current.size&&validQ&&validM){
    lastElectronic.current.values={charge:Number(q),multiplicity:Number(m)};
  }
  const sourceMismatch=validQ&&validM&&Number.isSafeInteger(sourceCharge)&&Number.isSafeInteger(sourceMultiplicity)&&
    (Number(q)!==sourceCharge||Number(m)!==sourceMultiplicity);
  const electronicWarning=[
    sourceMismatch?`本次设置与此来源的电荷 ${sourceCharge}、多重度 ${sourceMultiplicity} 不同。`:null,
    !trainedState&&validQ&&validM?electronicStateWarning(electronicGeometry.structure.atoms,Number(q),Number(m)):null,
  ].filter(Boolean).join(' ');
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
        const owned=controller.getSnapshot().groups.find(item=>item.id===groupId);
        if(!owned?.nodes.some(item=>item.id===activeNodeId))throw Error('势能面选择所属页面已关闭。');
        assertSource();
      },
    };
    return {target,owner:props.selectionOwner,request:props.onRequestSelection,highlight:props.onSelectionHighlight};
  }
  function readCurrentGeometry(snapshot=false){
    const current=latest.current;
    if(current.groupId!==groupId||current.activeNodeId!==activeNodeId)throw Error('势能面所属页面已切换。');
    const read=snapshot?current.readCurrentSnapshot??current.readCurrentGeometry:current.readCurrentGeometry;
    const source=read?read():current.sourceReady===false?undefined:current.geometry;
    if(!source)throw Error('当前科学帧尚未显示。');
    return source;
  }
  function readScanGeometry(){
    const current=latest.current;
    if(current.groupId!==groupId||current.activeNodeId!==activeNodeId)return;
    return current.readCurrentScanGeometry?current.readCurrentScanGeometry():readCurrentGeometry();
  }
  const currentSelection=selectionScope(geometry,'current',()=>{
    const current=readCurrentGeometry();
    if(current.documentId!==geometry.documentId||current.revision!==geometry.revision||
      JSON.stringify(current.source)!==JSON.stringify(geometry.source)||sourceIdentity(current.structure)!==sourceIdentity(geometry.structure))
      throw Error('当前科学帧或结构版本已变化，请重新选择。');
  });
  const report = (error: unknown) => setIssue(previous => ({ text: pesMessage(error), version: previous.version + 1 }));
  const perform = (action: () => void) => {
    try { action(); setIssue(previous => ({ ...previous, text: '' })); }
    catch (error) {
      if(error instanceof PesCompositionChange){setIssue(previous=>({...previous,text:''}));setCompositionChange({error,nodeId:activeNodeId});return;}
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
    if(values.charge!==q||values.multiplicity!==m)controller.editElectronicPair(groupId,values,electronicGeometry);
  }
  const stop = (runId: string) => { void controller.stop(groupId, runId).catch(report); };
  const ts = group.ts, values = ts.parametersByAlgorithm[ts.algorithm] ?? {};
  const periodic=Boolean(geometry.structure.cell?.pbc.some(Boolean));
  const methodAvailable=!isPesNetMethod(sharedMethod.method);
  const tsAlgorithms = periodic ? Object.fromEntries(Object.entries(PES_ALGORITHMS.ts).filter(([algorithm]) =>
    periodicPesOperationAvailable(sharedMethod.method, 'ts', algorithm))) : PES_ALGORITHMS.ts;
  const tsAlgorithmSelected = Object.hasOwn(tsAlgorithms, ts.algorithm);
  const irc = group.ircParameters ?? {};
  const canStartIrc = sharedMethod.method !== 'gfnff' && IRC_NUMBERS.every(({key, fallback, integer}) =>
    key === 'recalcInterval' && Number(irc[key] ?? 0) === 0 && irc[key] !== '' || validPositive(irc[key] ?? fallback, integer))
    && (!irc.mode || irc.mode === 'auto' || validPositive(irc.mode, true));
  const additionalSources = props.additionalSources ?? [];
  const isLocalSource = (choice: PesTabSnapshotSource) => choice.pesNode?.groupId === groupId;
  const groupCandidates = additionalSources.filter(choice => choice.ordinaryCandidate?.groupId === groupId);
  const candidateIds = new Set(groupCandidates.map(choice => choice.ordinaryCandidate!.documentId));
  const pathTabSources = additionalSources.filter(choice => !isLocalSource(choice) && !choice.ordinaryCandidate);
  const chooserSources = group.cards.some(card => card.kind === 'path' && !card.collapsed)
    ? [...(currentSourceActions ? [{
      key: JSON.stringify(['current-pes-structure', groupId, activeNodeId]), label: '当前结构',
      async read(signal: AbortSignal) {
        signal.throwIfAborted();
        const source=readCurrentGeometry(true);
        return { ...source, label: '当前结构 · 快照', inputSnapshotId: pesId('tab-snapshot'), source: source.source ?? { groupId, nodeId: activeNodeId } };
      },
    }] : []), ...pesGroupSnapshotSources(group, controller, additionalSources), ...groupCandidates]
    : [];
  async function selectCardSource(cardId:string,slot:string,key:string){
    const selectedGroup=controller.getSnapshot().groups.find(row=>row.id===groupId),card=selectedGroup?.cards.find(row=>row.id===cardId);
    if(!selectedGroup||!card)return;
    const tab=chooserSources.find(row=>row.key===key)??pathTabSources.find(row=>row.key===key);
    if(!tab)return;
    sourceRequest.current?.abort();
    const request=new AbortController();
    sourceRequest.current=request;
    setLoadingSource(cardId);
    try{
      const source=await tab.read(request.signal);
      const current=controller.getSnapshot().groups.find(row=>row.id===groupId),currentCard=current?.cards.find(row=>row.id===cardId);
      if(request.signal.aborted||sourceRequest.current!==request||latest.current.groupId!==groupId||latest.current.activeNodeId!==activeNodeId)return;
      if(!current||!currentCard||currentCard.algorithm!==card.algorithm||currentCard.slots!==card.slots)
        throw Error('来源读取期间已变化，请重新选择。');
      if(tab.ordinaryCandidate){
        const retained = latest.current.additionalSources?.find(row => row.key === key);
        if(retained?.ordinaryCandidate?.groupId!==groupId)throw Error('来源标签已移出本组，请重新选择。');
        const issue=pesTabAdmissionIssue(current,source.structure);
        if(issue)throw Error(issue);
      }
      controller.setSlot(groupId,cardId,slot,tab.ordinaryCandidate?{...source,groupTabReference:groupId}:source);
      setElectronicContext({groupId,nodeId:activeNodeId,cardId});setIssue(previous=>({...previous,text:''}));
    }catch(error){if(!request.signal.aborted&&sourceRequest.current===request&&latest.current.groupId===groupId&&latest.current.activeNodeId===activeNodeId)report(error);}
    finally{if(sourceRequest.current===request){sourceRequest.current=null;setLoadingSource(null);}}
  }
  const changeConstraints = (update: (value: SharedModelConstraints) => SharedModelConstraints,clearTargets?:readonly string[]) => {
    const current = controller.getSnapshot().groups.find(item => item.id === groupId);
    if (!current) return;
    currentSelection.target.assertCurrent();
    const previous=projectPesConstraintDefinitions(current,geometry.structure).constraints;
    const next=mergePesConstraintEdit(current,geometry.structure,previous,update(previous));
    controller.updateConstraints(groupId,next,{clearTargets,commitModel:()=>props.onConstraintsChange?.(next)});
  };
  const setTsParameter = (key: string, value: PesParameter) => controller.updateTs(groupId, draft => ({ ...draft, parametersByAlgorithm: {
    ...draft.parametersByAlgorithm, [ts.algorithm]: { ...draft.parametersByAlgorithm[ts.algorithm], [key]: value,
      ...(key==='fmaxHartreePerBohr' ? { convergencePreset: 'custom' } : {}) },
  } }));
  const tsPreset=projectedForcePreset(values,'medium');
  const tsSettings=sellaPresetParameters(ts.algorithm,values,tsPreset);
  return <InputSettingsLayout variant="standard" className="pes-workspace advanced-settings-surface"><InputSettingsStack kind="cards">
    {!controller.available && <DismissibleNotice>当前运行环境未连接势能面求解器。</DismissibleNotice>}
    <InputSettingsCard title="基础设置" sectionKey={`pes-base:${groupId}`} stack>
      <PesMethodFields value={sharedMethod} periodic={Boolean(methodGeometry?.structure.cell?.pbc.some(Boolean))} onChange={method => controller.updateSharedMethod(groupId, method)}/>
      {trainedState&&<small className="muted-note">模型使用训练态，电荷和多重度用于记录结构来源。</small>}
      <BaseElectronicStateFields embedded charge={Number(q)} multiplicity={Number(m)} confirmed={pesElectronicConfirmed(group,electronicGeometry)}
        rawText={{ charge: q, multiplicity: m }} rawInvalid={{ charge: !validQ, multiplicity: !validM }} error={electronicIssue}
        warning={electronicWarning||null}
        onChargeChange={value => controller.editElectronic(groupId, 'charge', String(value),electronicGeometry)}
        onMultiplicityChange={value => controller.editElectronic(groupId, 'multiplicity', String(value),electronicGeometry)}
        onRawTextChange={(field, value) => {editedElectronic.current.add(field);controller.editElectronic(groupId, field, value,electronicGeometry);}} onRawTextCommit={commitElectronic} confirmButtonText="确认"
        confirmationDisabled={!electronicGeometry.structure.atoms.length} onConfirm={() => perform(() => {
          controller.confirmElectronic(groupId,electronicGeometry,undefined,true);
        })}/>
    </InputSettingsCard>
    <GlobalConstraints scope={currentSelection} geometry={geometry} value={projectPesConstraintDefinitions(group,geometry.structure).constraints} change={changeConstraints} perform={perform} disabled={!sourceReady||workbenchLive}
      targets={group.constraintTargets ?? {}} editTarget={(id, text) => controller.editConstraintTarget(groupId, id, text)}/>
    <InputSettingsRow>
      <button type="button" className="button pes-button-tonal" disabled={calculationLocked} aria-expanded={adding} onClick={() => setAdding(value => !value)}>选择计算卡</button>
      {adding && !calculationLocked && [
        {kind:'scan' as const,algorithm:'sella-scan',label:'内坐标扫描'},
        {kind:'path' as const,algorithm:'ci-neb',label:'CI-NEB'},
        {kind:'path' as const,algorithm:'fsm',label:'FSM'},
        {kind:'path' as const,algorithm:'de-gsm',label:'GSM'},
      ].map(choice => {
        return <button type="button" className="button" key={choice.algorithm} onClick={() => perform(() => {
            controller.selectCalculationCard(groupId,choice.kind,choice.algorithm); setAdding(false);
          })}>{choice.label}</button>;
      })}
    </InputSettingsRow>
    {group.cards.map(card => {
      const run = group.runs[card.runIds.at(-1) ?? ''];
      let source:PesGeometry,sourceIssue='';
      try{source=cardSource(group,card,scanGeometry);}catch(error){sourceIssue=pesMessage(error);source=card.kind==='scan'?geometry:group.nodes.find(node=>node.id===group.initialNodeId)?.geometry??geometry;}
      const slot=card.kind==='path'?'reactant':'start';
      const periodicSupported=sharedMethod.method!=='gxtb'&&(!!sourceIssue||!source.structure.cell?.pbc.some(Boolean)||periodicPesOperationAvailable(sharedMethod.method,card.kind,card.kind==='scan'?effectivePesScanAlgorithm(card.algorithm,true):card.algorithm));
      let constraintIssue: string | undefined;
      if(!sourceIssue&&group.constraints.enabled!==false&&(group.constraints.frozenAtomIds.length||group.constraints.coordinates.some(row=>row.action==='freeze'))){
        const {unmatchedAtomIds,unmatchedCoordinates}=projectPesConstraintDefinitions(group,source.structure,source.documentId);
        if(unmatchedAtomIds.length||unmatchedCoordinates.some(row=>row.action==='freeze'))
          constraintIssue='所选结构的原子编号与全局冻结或内坐标定义无法对应。';
      }
      const scope=selectionScope(source,card.id+':'+slot,()=>{
        const current=controller.getSnapshot().groups.find(item=>item.id===groupId),currentCard=current?.cards.find(item=>item.id===card.id);
        if(!current||!currentCard||currentCard.algorithm!==card.algorithm||currentCard.slots!==card.slots)
          throw Error('计算卡的来源槽已变化，请重新选择。');
        const actual=cardSource(current,currentCard,card.kind==='scan'?readScanGeometry():undefined);
        if(!samePesScanSource(actual,source))throw Error('计算卡的起始结构已变化，请重新选择。');
      });
      return <div key={card.id} className="pes-card-input-owner" data-pes-card-id={card.id} onFocusCapture={()=>setElectronicContext({groupId,nodeId:activeNodeId,cardId:card.id})}>
      <PesCalculationCard card={card} method={sharedMethod.method} source={source} sources={chooserSources} tabSources={pathTabSources} scope={scope} run={run}
        outsideGroup={geometry=>geometry.groupTabReference===groupId&&!candidateIds.has(geometry.documentId)}
        available={controller.available&&methodAvailable&&periodicSupported&&(card.kind!=='scan'||!!scanGeometry&&!props.captureActive)} canCapture={currentSourceActions}
        unavailableReason={!methodAvailable?'请先选择此版本提供的 xTB 计算级别。':periodicSupported?undefined:'当前计算级别或算法暂不支持此固定晶胞任务。'}
        constraintIssue={constraintIssue} sourceIssue={sourceIssue} sourceLoading={loadingSource===card.id}
        selectTab={(slot,key)=>{void selectCardSource(card.id,slot,key);}}
        update={edit => controller.updateCard(groupId, card.id, edit)} setSlot={(slot, source) => controller.setSlot(groupId, card.id, slot, source)}
        capture={slot => perform(() => {
          const source=readCurrentGeometry(true);
          controller.captureSnapshot(groupId,card.id,slot,{...source,source:source.source??{groupId,nodeId:activeNodeId}});
          setElectronicContext({groupId,nodeId:activeNodeId,cardId:card.id});
        })}
        start={() => {setElectronicContext({groupId,nodeId:activeNodeId,cardId:card.id});perform(() => props.onActivateNode(controller.startCard(
          groupId, card.id, geometry.documentId, card.kind==='scan'?()=>latest.current.captureActive?undefined:readScanGeometry():undefined,
        )));}}
        selectAlgorithm={algorithm=>perform(()=>{controller.selectCalculationCard(groupId,'path',algorithm);})}
        stop={() => { if (run) stop(run.request.id); }} move={direction => controller.moveCard(groupId, card.id, direction)}
        remove={() => perform(() => controller.removeCard(groupId, card.id))}/></div>;
    })}
    {latestOptimizationRun && <PesRunControls run={latestOptimizationRun} stop={() => stop(latestOptimizationRun.request.id)}/>}
    <PesDetails title="过渡态搜索设置" sectionKey={'pes-ts:'+groupId} level="card" defaultOpen>
      <p>当前结构 {groupNode?.name ?? geometry.structure.name}{geometry.source?.frameId ? ' · 所选帧' : ''}</p>
      {!!Object.keys(tsAlgorithms).length && <InputSettingsRow className="pes-algorithm-coordinate-row">
        <PesSelect label="优化算法" value={tsAlgorithmSelected ? ts.algorithm : ''} options={tsAlgorithmSelected ? tsAlgorithms : { '': '选择优化算法', ...tsAlgorithms }}
          onChange={algorithm => { if (algorithm) controller.updateTs(groupId, draft => ({ ...draft, algorithm })); }}/>
        {tsAlgorithmSelected && isSellaTsAlgorithm(ts.algorithm) && (periodic?<span className="pes-method-fact">坐标系 XYZ</span>:<PesSelect label="坐标系" value={usesPesExecutionProfile(values)?ts.sellaCoordinateSystem??(values.coordinateSystem==='ric'?'ric':'xyz'):'xyz'} options={{xyz:'XYZ（推荐）',ric:'冗余内坐标'}}
          onChange={value => controller.updateTs(groupId, draft => withTsSellaCoordinates(draft,value as PesSellaCoordinateSystem))}/>)}
      </InputSettingsRow>}
      {tsAlgorithmSelected && ts.algorithm === 'climb' && <PesExpressionEditor label="爬坡坐标" value={ts.reaction} scope={currentSelection} rowPrefix="ts:climb"
        change={update => controller.updateTs(groupId, draft => ({ ...draft, reaction: update(draft.reaction) }))}/>}
      {tsAlgorithmSelected && <PesSelect label="TS收敛标准" value={tsPreset} options={PES_CONVERGENCE_OPTIONS}
        onChange={value => controller.updateTs(groupId, draft => ({ ...draft, parametersByAlgorithm: { ...draft.parametersByAlgorithm,
          [draft.algorithm]: sellaPresetParameters(draft.algorithm, draft.parametersByAlgorithm[draft.algorithm] ?? {}, value as PesConvergencePreset) } }))}/>}
      {tsAlgorithmSelected && <PesParameterSections sections={pesParameterSections(ts.algorithm,tsSettings).filter(section=>section.title!=='收敛设置'||tsPreset==='custom')} values={tsSettings} method={sharedMethod.method} onChange={setTsParameter}/>}
      {!isPesNetMethod(sharedMethod.method)&&<details className="xtb-constraint-results"><summary>任务资源</summary><InputSettingsRow>
        <XtbResourceOverrideField label="TS、Hessian、IRC 的 xTB 线程" disabled={workbenchLive} value={ts.resourceOverrides?.xtbSingleTaskThreads}
          onChange={xtbSingleTaskThreads=>controller.updateTs(groupId,draft=>({...draft,resourceOverrides:xtbSingleTaskThreads===undefined?undefined:{xtbSingleTaskThreads}}))}/>
      </InputSettingsRow></details>}
      {!workbenchLive && sourceReady && !pesElectronicConfirmed(group,geometry) &&
        <p className="pes-method-fact" role="status">请先在基础设置确认当前结构的电荷和自旋多重度。</p>}
      {!workbenchLive && periodic && Object.keys(tsAlgorithms).length===0 &&
        <p className="pes-method-fact">当前计算级别未开放固定晶胞过渡态搜索。</p>}
      {!workbenchLive && <InputSettingsRow variant="actions">{(['ts', 'hessian', 'irc'] as const).map(operation => {
        const periodicSupported=!periodic||periodicPesOperationAvailable(sharedMethod.method,operation,operation==='ts'?ts.algorithm:undefined);
        const reason=sharedMethod.method==='gxtb'?'本工程的 g-xTB 计算级别尚未开放此操作'
          :!methodAvailable?'请先选择此版本提供的 xTB 计算级别'
          :!periodicSupported?'当前计算级别或算法暂不支持此固定晶胞任务'
          :!sourceReady?'等待当前帧准备'
          :props.captureActive?'请先结束当前选区操作'
          :operation==='irc'&&sharedMethod.method==='gfnff'?'请选择支持 IRC 的计算级别'
          :!pesElectronicConfirmed(group,geometry)?'请先确认当前结构的电荷和自旋多重度':undefined;
        return <button key={operation} type="button" className={operation === 'ts' ? 'button button-primary' : 'button pes-button-tonal'} title={reason}
          disabled={!controller.available || !currentSourceActions || !methodAvailable || !periodicSupported || (operation === 'irc' && !canStartIrc)||!validXtbResourceOverride(ts.resourceOverrides?.xtbSingleTaskThreads)} onClick={() => perform(() => {
            const source=readCurrentGeometry();
            setElectronicContext({groupId,nodeId:activeNodeId,geometry:source});
            props.onActivateNode(controller.startWorkbench(groupId,activeNodeId,source,operation));
          })}>
          {{ ts: '计算TS', hessian: '计算Hessian', irc: '计算IRC' }[operation]}</button>;
      })}</InputSettingsRow>}
      <p>TS优化收敛后自动进行频率分析。</p>
      {latestWorkbenchRun && <PesRunControls run={latestWorkbenchRun} stop={() => stop(latestWorkbenchRun.request.id)}/>}
    </PesDetails>
    <IrcSettings groupId={groupId} values={irc} update={patch => controller.updateIrc(groupId, patch)}/>
    {methodAvailable && <HessianSettings key={groupId} groupId={groupId} step={group.hessianStepBohr ?? .002}
      update={step => controller.setHessianStep(groupId, step)}/>}
    <DismissibleNotice identity={issue.version}>{issue.text}</DismissibleNotice>
    {compositionChange?.error.groupId===groupId&&compositionChange.nodeId===activeNodeId&&<DialogShell aria-label="本次输入与已有结果原子数不同"
      onCancel={()=>setCompositionChange(null)} className="pes-composition-dialog"><h2>本次输入与已有结果原子数不同</h2><p>{compositionChange.error.message}</p><div className="modal-buttons">
      <button type="button" className="button" onClick={()=>setCompositionChange(null)}>取消</button>
      <button type="button" className="button button-primary" onClick={()=>{const action=compositionChange.error;setCompositionChange(null);perform(()=>props.onActivateNode(action.continueInNewGroup()));}}>在新组继续</button>
    </div></DialogShell>}
  </InputSettingsStack></InputSettingsLayout>;
}
