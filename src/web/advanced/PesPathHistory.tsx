import {useMemo} from 'react';
import type {PesFrameIndex,PesPathRecord,PesRun} from '../../modeling/pes/contracts';
import {pesPathRecords} from '../../modeling/pes/path-records';
import {useProjectState} from '../../projects/ui-state';
import {InputSettingsCard} from '../InputSettingsFields';
import {ScientificDataTable} from '../results/ScientificDataTable';
import type {TrajectoryEnergyOverlay} from '../../results/trajectory-energy-extension';
import {PesSelect} from './pes-fields';

const kindLabels={initial:'初始几何','first-energy':'首次物理能量',interval:'已记录',final:'末完整轮'};
const phaseLabels:Record<string,string>={'initial':'初始路径','s-idpp':'初始路径','native-dlc-initial':'原生DLC初始路径','neb':'路径优化','ci-neb-ordinary':'NEB','ci-neb-climb':'CI-NEB','de-gsm-growth':'生长','se-gsm-growth':'生长','de-gsm-optimize':'路径优化','de-gsm-optimization':'路径优化','de-gsm-climb':'攀爬','de-gsm-interrupted':'中断前结果','fsm-growth':'冻结弦生长','fsm-growth-interrupted':'冻结弦生长中断','se-gsm-optimize':'路径优化','grow':'生长','growing':'生长','optimize':'路径优化','optimization':'路径优化'};
const segmentPhaseLabels:Record<string,string>={growth:'生长',optimization:'路径优化',optimize:'路径优化',climb:'攀爬',interrupted:'中断前结果',anchors:'关键构型连接'};
export function pesPathPhaseLabel(phase:string){const segment=/^de-gsm-segment-(\d+)-(growth|optimization|optimize|climb|interrupted|anchors)$/.exec(phase);return segment?`第 ${segment[1]} 段 · ${segmentPhaseLabels[segment[2]]}`:phaseLabels[phase]??phase;}
const pathId=(record:PesPathRecord)=>record.pathId??record.seriesId;
export const pesPathRecordLabel=(record:PesPathRecord)=>`${pathId(record)==='path'?'':`事件 ${pathId(record)} · `}${record.kind==='initial'?'初始几何':`${pesPathPhaseLabel(record.phase)} · 第 ${record.step} 轮`}`;
const finiteEnergy=(frame:PesFrameIndex)=>typeof frame.energyHartree==='number'&&Number.isFinite(frame.energyHartree);
const bead=(frame:PesFrameIndex,index:number)=>typeof frame.bead==='number'&&Number.isFinite(frame.bead)?frame.bead:index+1;

/** History extension contains only lightweight indices, not another energy UI. */
export function pesPathEnergyOverlays(records:readonly PesPathRecord[],visibleIds:readonly string[],axis:'bead'|'arc'='bead'):TrajectoryEnergyOverlay[]{
  return records.filter(record=>visibleIds.includes(record.id)).map(record=>{
    const edges=record.connections&&new Set(record.connections.flatMap(([a,b])=>[`${a}\0${b}`,`${b}\0${a}`]));
    return{id:record.id,label:pesPathRecordLabel(record),points:record.frames.map((frame,index)=>{
      const previous=record.frames[index-1],number=bead(frame,index);
      const arc=typeof frame.arcLengthAngstrom==='number'&&Number.isFinite(frame.arcLengthAngstrom)?frame.arcLengthAngstrom:null;
      return{x:axis==='arc'?arc:number,energy:finiteEnergy(frame)?{value:frame.energyHartree!,unit:'hartree'}:null,frameId:frame.id,
        breakBefore:!!previous&&(edges?!edges.has(`${previous.id}\0${frame.id}`):Math.abs(number-bead(previous,index-1))!==1)};
    })};
  });
}

export function PesPathHistory({run,recordId,onView,overlays=[],onOverlaysChange}:{run:PesRun;recordId?:string;frameId?:string;onView(recordId:string,frameId?:string):void;overlays?:readonly string[];onOverlaysChange?(ids:readonly string[]):void}){
  const records=pesPathRecords(run);
  const [historyPath,setHistoryPath]=useProjectState('pes.path.history-path','',run.request.id);
  const paths=[...new Set(records.map(pathId))],selectedPath=records.find(record=>record.id===recordId);
  const historyPathId=paths.includes(historyPath)?historyPath:selectedPath?pathId(selectedPath):paths[0];
  const historyRecords=useMemo(()=>records.filter(record=>pathId(record)===historyPathId),[records,historyPathId]);
  const byId=new Map(historyRecords.map(record=>[record.id,record]));
  const projection=useMemo(()=>({columns:[{key:'record',label:'路径记录'},{key:'beads',label:'实际珠子数'},{key:'kind',label:'记录类型'}],rows:historyRecords.map(record=>({key:record.id,cells:[pesPathRecordLabel(record),String(record.frames.length),kindLabels[record.kind]]}))}),[historyRecords]);
  return <div data-testid="pes-path-history" className="pes-path-history">
    <InputSettingsCard title="路径记录" stack>
      {paths.length>1&&<PesSelect label="路径/事件" value={historyPathId??''} options={Object.fromEntries(paths.map(id=>[id,id==='path'?'路径':`事件 ${id}`]))} onChange={setHistoryPath}/>}
      <ScientificDataTable hideTitle projection={projection} selectionScope={`${run.request.id}:path-records`} exportFileName="Ester-Studio-path-records.txt" rowActions={[
        {kind:'checkbox',label:row=>`叠加${row.cells[0]}`,active:row=>overlays.includes(row.key),available:row=>!!onOverlaysChange&&row.key!==recordId&&!!byId.get(row.key)?.frames.some(finiteEnergy),onActivate:row=>onOverlaysChange?.(overlays.includes(row.key)?overlays.filter(id=>id!==row.key):[...overlays,row.key])},
        {kind:'select',label:row=>`查看${row.cells[0]}`,text:'查看',onActivate:row=>onView(row.key)},
      ]}/>
    </InputSettingsCard>
  </div>;
}
