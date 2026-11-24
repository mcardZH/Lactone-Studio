import {useMemo,useState} from 'react';
import type {AdvancedResultFrame} from '../../modeling/advanced/contracts';
import {convertEnergy,type EnergyUnit} from '../../results/energy';
import {decimalEnergyValue} from '../../results/numeric-format';
import ScientificPlot from '../results/ScientificPlot';
import {EnergyPlotUnit,energyPlotUnits,plotEnergyUnit} from '../results/EnergyPlotControls';
import {usePlotFigure} from '../results/scientific-plot-figure';
import {objectSchema} from '../mcp/types';
import {settingEnum} from '../results/analysis-mcp-settings';
import type {ConformerDisplayCollection} from './conformer-results-presentation';

/** One published comparison group. Missing observations keep their original rank. */
export function conformerEnergyRows(collection:ConformerDisplayCollection,clusterIds?:readonly string[]) {
  const source=collection.clusterCollection;
  if(!source?.comparison)return;
  const ordinals=new Map(source.clusters.map((row,index)=>[row.clusterId,index+1]));
  const requested=clusterIds&&new Set(clusterIds),clusters=source.clusters.filter(row=>!requested||requested.has(row.clusterId));
  const finite=clusters.flatMap(row=>row.energyHartree!==null&&Number.isFinite(row.energyHartree)?[row.energyHartree]:[]);
  if(!finite.length)return;
  const zeroHartree=finite.reduce((minimum,value)=>Math.min(minimum,value),Infinity),frames=new Map(collection.frames.map(frame=>[frame.id,frame]));
  return {source,zeroHartree,rows:clusters.map(row=>({
    ordinal:ordinals.get(row.clusterId)!,clusterId:row.clusterId,candidateId:row.representativeCandidateId,
    frameId:row.representativeFrameId,frame:!row.unavailableReason&&row.representativeFrameId?frames.get(row.representativeFrameId):undefined,
    energyHartree:row.energyHartree!==null&&Number.isFinite(row.energyHartree)?row.energyHartree:null,
    unavailableReason:row.unavailableReason,
  }))};
}

export default function ConformerEnergyPlot({collection,selectedFrameId,onFrame}:{
  collection:ConformerDisplayCollection;selectedFrameId?:string|null;onFrame(frame:AdvancedResultFrame):void;
}) {
  const identity=`conformer:${collection.id}:energy`,record=usePlotFigure(identity);
  const clusterIds=record.figure.conformer?.clusterIds;
  const data=useMemo(()=>conformerEnergyRows(collection,clusterIds),[collection,clusterIds]);
  const [draftIds,setDraftIds]=useState<string|null>(null),[selectionError,setSelectionError]=useState('');
  const unit:EnergyUnit=record.figure.energy?.unit??'kcal/mol';
  const setUnit=(unit:EnergyUnit)=>record.replace(previous=>({...previous,energy:{unit,relative:true,reference:'min'}}));
  if(!data)return <p role="status">当前显示选择没有可用能量。<button type="button" onClick={()=>record.replace(previous=>({...previous,conformer:{}}))}>显示全部构象</button></p>;
  const {source,rows,zeroHartree}=data,unitLabel=plotEnergyUnit(unit);
  const available=new Set(source.clusters.map(row=>row.clusterId));
  const missing=clusterIds?.filter(id=>!available.has(id))??[];
  const applyPresentation=(values:Record<string,unknown>)=>{
    const ids=values.clusterIds as string[]|null|undefined;
    if(ids&&(new Set(ids).size!==ids.length||ids.some(id=>!available.has(id))))throw new Error('显示构象须使用当前集合中不同的真实簇 ID。');
    record.replace(previous=>({...previous,...(values.unit===undefined?{}:{energy:{unit:values.unit as EnergyUnit,relative:true,reference:'min'}}),
      ...(ids===undefined?{}:{conformer:{clusterIds:ids??undefined}})}));
    setDraftIds(null);setSelectionError('');
  };
  const selectedIds=new Set(clusterIds);
  const selectedOrdinals=source.clusters.flatMap((row,index)=>selectedIds.has(row.clusterId)?[index+1]:[]).join(', ');
  const applyOrdinals=()=>{
    if(draftIds===null)return;
    const text=draftIds.trim();
    if(!text){applyPresentation({clusterIds:null});return;}
    const ordinals=text.split(/[,，\s]+/).map(Number);
    if(ordinals.some(value=>!Number.isSafeInteger(value)||value<1||value>source.clusters.length)||new Set(ordinals).size!==ordinals.length){setSelectionError('请输入当前簇序号，用逗号分隔。');return;}
    applyPresentation({clusterIds:ordinals.map(ordinal=>source.clusters[ordinal-1].clusterId)});
  };
  const relative=(energy:number|null)=>energy===null?null:convertEnergy({value:energy-zeroHartree,unit:'hartree'},unit);
  return <ScientificPlot appearanceKey={identity} figureRecord={record} resetKey={source.revision}
    title="Conformer Relative Energies" xLabel="Conformer" yLabel={`Relative Energy / ${unitLabel}`}
    toolbar={<><EnergyPlotUnit unit={unit} onChange={setUnit} label="构象图能量单位"/>
      <label>显示簇序号 <input aria-label="能量图显示簇序号" value={draftIds??selectedOrdinals} placeholder="全部" onChange={event=>setDraftIds(event.target.value)} onBlur={applyOrdinals}
        onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();applyOrdinals();}}}/></label>
      {(selectionError||missing.length>0)&&<p role="status">{selectionError||'显示选择中有已变更的簇，请重新选择。'}</p>}</>}
    pointReadout={{kind:'Frame',yUnit:unitLabel}} selectedIndex={rows.findIndex(row=>row.frameId===selectedFrameId)}
    onSelectIndex={index=>{const frame=rows[index]?.frame;if(frame)onFrame(frame);}}
    series={[{id:'conformer-energy',label:'Energy',showPoints:true,points:rows.map((row,index)=>({
      x:row.ordinal,y:relative(row.energyHartree),index:row.frame?index:undefined,readoutId:row.ordinal,label:`Conformer ${row.ordinal}`,
      tooltip:`${collection.label} · ${row.clusterId}${row.unavailableReason?` · ${row.unavailableReason}`:''}`,
    }))}]}
    axisTransforms={{y:{scale:convertEnergy({value:1,unit:'hartree'},unit)!,offset:-convertEnergy({value:zeroHartree,unit:'hartree'},unit)!}}}
    mcpConfiguration={{schema:objectSchema({unit:settingEnum(energyPlotUnits),clusterIds:{description:'Choose exact native cluster IDs from availableClusters, or null for the entire collection.',anyOf:[{type:'null'},{type:'array',items:{type:'string'},minItems:1}]}}),read:()=>({unit,clusterIds:clusterIds??null,reference:'minimum-of-displayed-clusters',referenceHartree:zeroHartree,
      collectionId:collection.id,collectionRevision:source.revision,runId:source.producerRunId,stageId:source.stageRunId,
      availableClusters:source.clusters.map((row,index)=>({ordinal:index+1,clusterId:row.clusterId,frameId:row.representativeFrameId,energyHartree:row.energyHartree})),
      comparisonKey:source.comparison!.comparisonKey,settlement:source.settlement}),apply:applyPresentation}}
    metadata={{collectionId:collection.id,collectionRevision:source.revision,taskId:source.taskId,runId:source.producerRunId,stageId:source.stageRunId,
      comparison:source.comparison,settlement:source.settlement,referenceHartree:zeroHartree,
      points:rows.map(({frame:_frame,...row})=>row)}}
    testId="conformer-energy-svg" exportFileName="Ester-Studio-conformer-energies"
    exportText={{fileName:'Ester-Studio-conformer-energies.txt',text:()=>[
      `# collection ${collection.id}; revision ${source.revision}; run ${source.producerRunId}; stage ${source.stageRunId}`,
      `# comparison ${source.comparison!.comparisonKey}; settlement ${source.settlement}; reference ${decimalEnergyValue(zeroHartree)} Eh`,
      `Conformer\tCluster ID\tCandidate ID\tFrame ID\tEnergy / Eh\tRelative Energy / ${unitLabel}\tAvailability`,
      ...rows.map(row=>[row.ordinal,row.clusterId,row.candidateId,row.frameId??'',row.energyHartree===null?'':decimalEnergyValue(row.energyHartree),
        relative(row.energyHartree)??'',row.unavailableReason??''].join('\t')),
    ].join('\n')}}/>;
}
