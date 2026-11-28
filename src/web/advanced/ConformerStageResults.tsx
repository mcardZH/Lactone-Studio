import {isPeriodic} from '../../core/periodic';
import {useCallback,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {useProjectState} from '../../projects/ui-state';
import type {AdvancedCalculationResult,AdvancedResultFrame,AdvancedTaskRun} from '../../modeling/advanced/contracts';
import type {XtbConstraintResult} from '../../modeling/xtb/contracts';
import type {EnergyUnit} from '../../results/energy';
import {InputSettingsCard,InputSettingsField,InputSettingsNumericControl,InputSettingsRow,InputSettingsStack} from '../InputSettingsFields';
import {InputSettingsAction} from '../InputSettingsLayout';
import {ScientificDataTable} from '../results/ScientificDataTable';
import {scientificTableText} from '../results/scientific-table';
import {exportBlob} from '../results/export-image';
import {netMethods,ordinaryOptimizers} from '../modeling/tool-session';
import {isPesNetMethod} from '../../modeling/pes/contracts';
import {XTB_METHOD_LABELS,isXtbMethod} from '../../core/xtb-capabilities';
import type {ConformerSamplingStageEvent} from '../../modeling/advanced/sampling-contracts';
import {CONFORMER_VISIBLE_ROWS,conformerResultProjection,selectedConformerFrames,type ConformerResultSort,type ConformerDisplayCollection} from './conformer-results-presentation';
import ConformerEnergyPlot from './ConformerEnergyPlot';
import {ResultsMcpPlotScope,ResultsMcpPlotSourceRegistration} from '../results/results-mcp-context';

export interface ConformerStageResultsProps {
  collections:readonly ConformerDisplayCollection[];collectionId?:string;onCollection(id:string):void;
  selectedFrameId?:string|null;onFrame(frame:AdvancedResultFrame):void;run?:AdvancedTaskRun;runs?:readonly AdvancedTaskRun[];active:boolean;
  onFrameOrder?(collectionId:string,frames:readonly AdvancedResultFrame[]):void;
  displayFramesForCollection?(collectionId:string):readonly AdvancedResultFrame[]|undefined;
  onPrepareBatchInput?(frames:readonly AdvancedResultFrame[]):void;
  onOrganize?(collectionId:string):void;
  busy?:boolean;
  collectionStates?:Readonly<Record<string,{runId?:string;message?:string;partial?:boolean;interrupted?:boolean}>>;
  progress?:ReactNode;actions?:ReactNode;output?:ReactNode;overlay?:ReactNode;
}
const emptyProjection:ReturnType<typeof conformerResultProjection>={frames:[],optimized:false,projection:{columns:[],rows:[]},energyLabel:'',populationMessage:''};
/** Observation, trajectory documents and playback belong to the parent. */
export default function ConformerStageResults(p:ConformerStageResultsProps){
  const activeId=p.collectionId??p.collections[0]?.id;
  return <div className="conformer-stage-results" data-testid="conformer-stage-results">
    {!p.collections.length&&<InputSettingsCard title="构象结果"><p role="status">完成采样后，在此查看轨迹与各级优化结果。</p></InputSettingsCard>}
    {p.collections.map(collection=>{const runId=collection.clusterCollection?.producerRunId??p.collectionStates?.[collection.id]?.runId??collection.frames[0]?.runId;const run=runId?p.runs?.find(row=>row.id===runId)??(p.run?.id===runId?p.run:undefined):p.run;return <ConformerResultCard key={collection.id} {...p} run={run} collection={collection} expanded={collection.id===activeId}/>;})}
  </div>;
}
export function ConformerResultCard(p:ConformerStageResultsProps&{collection:ConformerDisplayCollection;expanded:boolean}){
  const [allRows,setAllRows]=useState(false),[decimals,setDecimals]=useState(2),[temperatureK,setTemperatureK]=useState(298.15),[temperatureDraft,setTemperatureDraft]=useState(298.15);
  const [unit,setUnit]=useProjectState<EnergyUnit>('conformer.result.energyUnit','kcal/mol',p.collection.id);
  const [sort,setSort]=useState<ConformerResultSort>('energy'),[direction,setDirection]=useState<'asc'|'desc'>('asc');
  const [batchIds,setBatchIds]=useState<ReadonlySet<string>>(()=>new Set()),[batchMessage,setBatchMessage]=useState('');
  const [showEnergyPlot,setShowEnergyPlot]=useState(false);
  const root=useRef<HTMLDivElement>(null),previouslyExpanded=useRef(false),orderCallback=useRef(p.onFrameOrder),frameCallback=useRef(p.onFrame);
  orderCallback.current=p.onFrameOrder;
  frameCallback.current=p.onFrame;
  useEffect(()=>{if(p.expanded&&!previouslyExpanded.current&&p.active)root.current?.scrollIntoView({block:'nearest'});previouslyExpanded.current=p.expanded;},[p.expanded,p.active]);
  const visible=p.active&&p.expanded;
  const clusters=p.collection.clusterCollection;
  // Keep a visited cluster table attached to its card so switching between
  // prepared collections does not recreate all rows and their controls.
  const visitedCluster=useRef<string|undefined>(undefined);
  if(visible&&clusters)visitedCluster.current=p.collection.id;
  const retainRows=visible||Boolean(clusters&&visitedCluster.current===p.collection.id);
  const retainedDisplayOrder=useRef<readonly AdvancedResultFrame[]|undefined>(undefined);
  if(visible){
    const providedOrder=p.displayFramesForCollection?.(p.collection.id);
    retainedDisplayOrder.current=providedOrder===p.collection.frames?undefined:providedOrder;
  }
  const displayFrames=retainedDisplayOrder.current;
  // Only a visited card prepares its table. Collapsing and revisiting reuse the
  // actual scientific projection while result, sorting, and format inputs agree.
  const project=useMemo(()=>{
    let projection:ReturnType<typeof conformerResultProjection>|undefined;
    return()=>projection??=conformerResultProjection(p.collection,p.run,{decimals,unit,temperatureK,sort,direction},displayFrames);
  },[p.collection.frames,clusters,p.run?.id,p.run?.stages,p.run?.results,displayFrames,decimals,unit,temperatureK,sort,direction]);
  const view=retainRows?project():emptyProjection;
  const terminal=p.run?.sampling?.terminal;
  const thermostatWarning=!view.optimized&&terminal?.event==='completed'?terminal.thermostatWarning:undefined;
  const frameOrder=useMemo(()=>JSON.stringify(view.frames.map(frame=>frame.id)),[view.frames]);
  const energyPlotAvailable=useMemo(()=>Boolean(clusters?.comparison&&clusters.clusters.some(row=>row.energyHartree!==null&&Number.isFinite(row.energyHartree))),[clusters]);
  const sampling=useMemo(()=>p.collection.frames.some(frame=>frame.kind==='sampling-trajectory'||frame.kind==='sampled-candidate'),[p.collection.frames]);
  const energyPlotId=`conformer:${p.collection.id}:energy`;
  const openEnergyPlot=()=>{p.onCollection(p.collection.id);setShowEnergyPlot(true);};
  const completedStage=clusters&&p.run?.stages.find(stage=>stage.id===clusters.stageRunId||stage.configurationId===clusters.configurationId);
  const resultStage=completedStage??p.run?.stages.find(stage=>stage.collectionId===p.collection.id);
  const stageResults=resultStage?.results;
  const resultAtFrame=useMemo(()=>{
    let byId:Map<string,AdvancedCalculationResult>|undefined;
    return (frameId:string)=>{
      if(!stageResults?.length)return undefined;
      if(!byId){
        byId=new Map();
        for(const result of stageResults)if(result.frameId)byId.set(result.frameId,result);
      }
      return byId.get(frameId);
    };
  },[stageResults,stageResults?.length,resultStage?.resultRevision]);
  const selectedResult=visible&&view.optimized&&p.selectedFrameId?resultAtFrame(p.selectedFrameId):undefined;
  const nativeConstraints=selectedResult?.metadata?.internalConstraintMode==='native-harmonic'
    ?selectedResult.metadata.internalConstraints:undefined;
  const resultStatus=resultStage?.status??p.run?.status;
  const stageMethod=resultStage?.configuration?.method;
  const optimizer=stageMethod&&stageMethod.backend!=='forcefield'?stageMethod.optimizer:undefined;
  const fixedCell=isPeriodic(p.collection.frames[0]?.source.structure);
  const retainedBatch=completedStage?.adoptionError??p.run?.stages.find(stage=>stage.collectionId===p.collection.id)?.adoptionError;
  const equivalence=clusters?.settlement==='complete'?completedStage?.clustering?.equivalence:undefined;
  const indexRows=useMemo(()=>{
    let rows:ReadonlyMap<string,{frame:AdvancedResultFrame;ordinal:number}>|undefined;
    let representatives:ReadonlyMap<string,string>|undefined;
    return {
      rows(){
        if(rows)return rows;
        const frames=new Map(p.collection.frames.map(frame=>[frame.id,frame]));
        rows=new Map(clusters?clusters.clusters.flatMap((row,index)=>{const frame=row.representativeFrameId?frames.get(row.representativeFrameId):undefined;return frame&&!row.unavailableReason?[[row.clusterId,{frame,ordinal:index+1}] as const]:[]}):p.collection.frames.map((frame,index)=>[frame.id,{frame,ordinal:index+1}] as const));
        return rows;
      },
      representative(frameId:string|null|undefined){
        if(!clusters||frameId==null)return undefined;
        if(!representatives){
          const result=new Map<string,string>();
          for(const row of clusters.clusters)if(row.representativeFrameId&&!result.has(row.representativeFrameId))result.set(row.representativeFrameId,row.clusterId);
          representatives=result;
        }
        return representatives.get(frameId);
      },
    };
  },[p.collection.frames,clusters]);
  const framesById=retainRows?indexRows.rows():undefined;
  useEffect(()=>{if(visible)orderCallback.current?.(p.collection.id,view.frames);},[visible,p.collection.id,frameOrder]);
  const table=useMemo(()=>clusters||allRows?view.projection:{...view.projection,rows:view.projection.rows.slice(0,CONFORMER_VISIBLE_ROWS)},[clusters,allRows,view.projection]);
  const frameCount=clusters?.clusters.length??p.collection.frames.length;
  const selected=useMemo(()=>!batchIds.size?[]:clusters?clusters.clusters.flatMap(row=>batchIds.has(row.clusterId)&&framesById?.has(row.clusterId)?[framesById.get(row.clusterId)!.frame]:[]):selectedConformerFrames(view.frames,batchIds),[clusters,batchIds,framesById,view.frames]);
  useEffect(()=>{if(framesById)setBatchIds(previous=>[...previous].every(id=>framesById.has(id))?previous:new Set([...previous].filter(id=>framesById.has(id))));},[framesById]);
  const activateRow=useCallback((row:{key:string})=>{const frame=framesById?.get(row.key)?.frame;if(frame)frameCallback.current(frame);},[framesById]);
  const batchAction=useMemo(()=>view.optimized&&p.onPrepareBatchInput?{kind:'checkbox' as const,label:(row:{key:string})=>`选择构象 ${framesById?.get(row.key)?.ordinal??''} 用于批量输入`,active:(row:{key:string})=>batchIds.has(row.key),onActivate:(row:{key:string})=>{if(!framesById?.has(row.key)){setBatchMessage('此簇代表结构不可用。');return;}setBatchMessage('');setBatchIds(previous=>{const next=new Set(previous);if(next.has(row.key))next.delete(row.key);else next.add(row.key);return next;});}}:undefined,[view.optimized,!!p.onPrepareBatchInput,framesById,batchIds]);
  return <div ref={root} className="conformer-result-card" data-collection-id={p.collection.id}><InputSettingsCard title={p.collection.label} stack>
    <ResultsMcpPlotSourceRegistration source={{kind:'conformer-energy',targetRef:p.collection.id,plotId:energyPlotId,
      collectionId:p.collection.id,runId:clusters?.producerRunId??p.run?.id,stageId:clusters?.stageRunId??resultStage?.id,label:p.collection.label,active:p.active,
      open:energyPlotAvailable?openEnergyPlot:undefined,unavailableReason:energyPlotAvailable?undefined:clusters
        ?'The stage has no comparable representative energies in its admitted cluster collection.'
        :sampling?'The sampling collection does not contain an optimized representative energy ranking.'
          :'This stage has no admitted cluster collection with comparable representative energies.'}}/>
    <button type="button" className="shared-input-action conformer-result-stage" aria-label={`查看${p.collection.label}`} aria-expanded={p.expanded} aria-pressed={p.expanded} onClick={()=>p.onCollection(p.collection.id)}><span>{frameCount} {clusters?'簇':'帧'}</span><span>{p.expanded?'当前结果':'展开结果'}</span></button>
    {retainRows&&<div hidden={!visible}><InputSettingsStack>
      {!retainedBatch&&p.collectionStates?.[p.collection.id]?.message&&<p role="status">{resultStatus==='completed'&&clusters?.settlement==='complete'?'已完成':resultStatus==='failed'?(frameCount?'本次运行失败，已有有效结果仍可浏览。':'本次运行失败，尚无可用结果。'):p.collectionStates[p.collection.id].message}</p>}
      {equivalence&&<p role="status">常规归簇 {equivalence.ordinaryClusterCount} → 最终 {equivalence.finalClusterCount} 簇</p>}
      {clusters&&clusters.settlement!=='complete'&&<p role="status">{clusters.settlement==='needs-clustering'?'已有有效优化结果，待明确整理归簇。':clusters.settlement==='historical-incomplete'?'历史集合不完整，不能作为完整归簇输入。':'部分归簇 · 尚未正式结算'}</p>}
      {clusters&&p.onOrganize&&<InputSettingsAction disabled={p.busy} onClick={()=>p.onOrganize?.(p.collection.id)}>整理归簇</InputSettingsAction>}
      {!frameCount?<p role="status">{p.collectionStates?.[p.collection.id]?.partial?'尚无已收敛的有效结果':p.collectionStates?.[p.collection.id]?.message?'尚无可用的最终代表帧':'当前阶段尚未运行'}</p>:<>
        {p.collectionStates?.[p.collection.id]?.partial&&<p className="muted-note">这里显示已经有效完成的部分结果，当前排名不作为已发布晋级名单。</p>}
        {thermostatWarning&&<p role="status" data-testid="conformer-thermostat-warning">xTB平均温度 {Number(thermostatWarning.averageTemperatureK.toFixed(2))} K（目标 {Number(thermostatWarning.targetTemperatureK.toFixed(2))} K）· 温控统计警告</p>}
        {(view.energyLabel||!!nativeConstraints?.length)&&<p className="conformer-energy-kind">{view.energyLabel}{nativeConstraints?.length?(view.energyLabel?' · 含原生约束势':'能量含原生约束势'):''}</p>}
        {selectedResult&&!!nativeConstraints?.length&&<ConformerNativeConstraintDetails result={selectedResult} rows={nativeConstraints}/>}
        {energyPlotAvailable&&<InputSettingsAction onClick={()=>setShowEnergyPlot(value=>!value)}>{showEnergyPlot?'收起能量图':'绘制相对能量图'}</InputSettingsAction>}
        {visible&&showEnergyPlot&&energyPlotAvailable&&<ResultsMcpPlotScope scope={{id:energyPlotId,kind:'conformer-energy',collectionId:p.collection.id,
          runId:clusters!.producerRunId,stageId:clusters!.stageRunId,display:{eligible:p.active&&p.expanded,visible:p.active&&p.expanded,active:p.active&&p.expanded,
            activate:openEnergyPlot,close:()=>setShowEnergyPlot(false)}}}>
          <ConformerEnergyPlot collection={p.collection} selectedFrameId={p.selectedFrameId} onFrame={p.onFrame}/>
        </ResultsMcpPlotScope>}
        {view.optimized&&optimizer&&<p className="conformer-energy-kind">优化算法 {optimizer.algorithm==='native-rf'?'xTB 原生 RF':ordinaryOptimizers[optimizer.algorithm]}{fixedCell?' · 固定晶胞':''}{stageMethod?.backend==='net'?` · ${netMethods[stageMethod.options.method]} · ${stageMethod.options.device.toUpperCase()}`:''}</p>}
        {!view.optimized&&<ConformerSamplingRunSettings run={p.run}/>}
        {view.optimized&&view.projection.columns.some(column=>column.key==='population')&&<InputSettingsRow><InputSettingsField label="布居温度" unit="K" controlWidth="number"><InputSettingsNumericControl ariaLabel={`${p.collection.label}布居温度`} min={.01} value={temperatureDraft} onValue={value=>{setTemperatureDraft(value);if(Number.isFinite(value)&&value>0)setTemperatureK(value);}}/></InputSettingsField></InputSettingsRow>}
        {p.expanded&&p.overlay}
        <ScientificDataTable hideTitle projection={table} numericColumnWidths="content" selectionScope={`conformer:${p.collection.id}`} liveActiveRow activeRowKey={clusters?indexRows.representative(p.selectedFrameId):p.selectedFrameId??undefined}
          rowAction={batchAction}
          onRowActivate={activateRow}
          expansion={!clusters&&frameCount>CONFORMER_VISIBLE_ROWS?{expanded:allRows,onToggle:()=>setAllRows(value=>!value)}:undefined}
          format={{decimals,onDecimalsChange:setDecimals,unit,units:[{value:'kJ/mol',label:'kJ/mol'},{value:'kcal/mol',label:'kcal/mol'},{value:'eV',label:'eV'},{value:'hartree',label:'Eh'}],onUnitChange:value=>setUnit(value as EnergyUnit),ariaLabel:p.collection.label}}
          sorting={view.optimized&&!clusters?{value:sort,direction,options:[{value:'energy',label:'能量'},{value:'frame',label:'构象编号'}],onChange:(value,next)=>{setSort(value as ConformerResultSort);setDirection(next);}}:undefined}
          onExport={()=>{const exported=batchIds.size?{...table,rows:table.rows.filter(row=>batchIds.has(row.key))}:table;exportBlob(new Blob([scientificTableText(exported)],{type:'text/plain;charset=utf-8'}),'Ester-Studio-conformers.txt',root.current?.ownerDocument);}}
          exportFileName="Ester-Studio-conformers"/>
        {!clusters&&frameCount>CONFORMER_VISIBLE_ROWS&&<output>显示 {table.rows.length} / {frameCount} 帧</output>}
        {view.optimized&&p.onPrepareBatchInput&&<InputSettingsRow><InputSettingsAction onClick={()=>{const output=batchIds.size?selected:clusters&&p.collection.playbackAvailable!==false?view.frames:[];if(!output.length){setBatchMessage(p.collection.playbackAvailable===false?'当前完整集合含不可用代表，请明确选择可用簇。':clusters?'当前集合尚无可用簇。':'请先勾选需要产生输入文件的构象行。');return;}setBatchMessage('');p.onPrepareBatchInput?.(output);}}>批量产生输入文件</InputSettingsAction><output>已选 {selected.length} {clusters?'簇':'帧'}</output>{batchMessage&&<p role="status">{batchMessage}</p>}</InputSettingsRow>}
        {p.expanded&&<>{p.actions}{p.output}</>}
      </>}
    </InputSettingsStack></div>}
  </InputSettingsCard></div>;
}

function ConformerNativeConstraintDetails({result,rows}:{result:AdvancedCalculationResult;rows:readonly XtbConstraintResult[]}){
  const atomNumbers=new Map(result.input.structure.atoms.map((atom,index)=>[atom.id,index+1]));
  const display=(value:number)=>Number(value.toPrecision(9));
  return <details className="xtb-constraint-results"><summary>当前帧原生 B/A/D 约束（{rows.length}）</summary>
    <div className="xtb-constraint-table-scroll"><table aria-label="原生约束目标与偏差"><thead><tr>
      <th scope="col">类型</th><th scope="col">原子</th><th scope="col">目标</th><th scope="col">实际</th><th scope="col">偏差</th>
    </tr></thead><tbody>{rows.map(row=>{
      const atoms=row.atomIds.map(id=>atomNumbers.get(id)??id).join('–');
      const unit=row.unit==='angstrom'?'Å':'°';
      return <tr key={row.id??`${row.type}:${atoms}`}><th scope="row">{row.type}</th><td>{atoms}</td>
        <td>{display(row.target)} {unit}</td><td>{display(row.actual)} {unit}</td><td>{display(row.residual)} {unit}</td></tr>;
    })}</tbody></table></div>
  </details>;
}

function ConformerSamplingRunSettings({run}:{run?:AdvancedTaskRun}){
  function setting(events:readonly ConformerSamplingStageEvent[]|undefined){
    return events?.find(event=>event.integration&&event.configuration)??events?.find(event=>event.integration);
  }
  const rows: (readonly [string,ConformerSamplingStageEvent])[]=run?.mixedSampling?.cards.flatMap((card,index)=>{
    const event=setting(card.sampling?.stageEvents);
    return event?[[`采样 ${index+1}`,event] as const]:[];
  })??[];
  const single=rows.length?undefined:setting(run?.sampling?.stageEvents);
  if(single)rows.push(['采样',single]);
  if(!rows.length)return null;
  return <details className="xtb-constraint-results"><summary>本次采样设置</summary>
    {rows.map(([label,event])=>{
      const {method,integration,configuration}=event;
      if(!integration)return null;
      const engine=integration.driver==='ASE-Bussi'?'ASE':integration.driver==='ASE-Langevin'?'ASE Langevin':'xTB 原生';
      const level=isPesNetMethod(method)?netMethods[method]:isXtbMethod(method)?XTB_METHOD_LABELS[method]:method;
      const values=[level,engine,`${integration.dtFs} fs`,
        integration.thermostat==='Bussi'?'V-rescale':integration.thermostat,
        integration.thermostatTimeConstantFs===undefined?undefined:`耦合时间 ${integration.thermostatTimeConstantFs} fs`,
        integration.hydrogenMassAmu==null?undefined:`氢质量 ${integration.hydrogenMassAmu} amu`,
        integration.shakeHydrogenBonds===undefined?undefined:`含氢键长约束${integration.shakeHydrogenBonds?'开启':'关闭'}`,
        configuration?.device?.toUpperCase(),configuration?.structure.cell?'固定晶胞':undefined,
        configuration?.solvation?`${configuration.solvation.model.toUpperCase()} ${configuration.solvation.solvent}`:undefined];
      return <p key={label}>{label} · {values.filter(Boolean).join(' · ')}</p>;
    })}
  </details>;
}
