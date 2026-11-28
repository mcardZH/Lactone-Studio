import {useMemo, useRef} from 'react';
import {ChevronsDown, ChevronsUp} from 'lucide-react';
import type {PesFrameIndex,PesPathRecord,PesRun} from '../../modeling/pes/contracts';
import {pesPathRecords} from '../../modeling/pes/path-records';
import {useProjectState} from '../../projects/ui-state';
import {InputSettingsCard} from '../InputSettingsFields';
import {ScientificDataTable} from '../results/ScientificDataTable';
import {exportBlob} from '../results/export-image';
import {scientificTableText} from '../results/scientific-table';
import type {TrajectoryEnergyOverlay} from '../../results/trajectory-energy-extension';
import {PesSelect} from './pes-fields';

const kindLabels={initial:'初始几何','first-energy':'首次物理能量',interval:'已记录',final:'末完整轮'};
const phaseLabels:Record<string,string>={'initial':'初始几何','s-idpp':'S-IDPP 初始路径','fsm-native-initial':'初始几何','ci-fsm-initialization':'FSM 初始路径','native-dlc-initial':'原生DLC初始路径','neb':'路径优化','ci-neb-ordinary':'NEB','ci-neb-climb':'CI-NEB','de-gsm-growth':'生长','se-gsm-growth':'生长','de-gsm-optimize':'路径优化','de-gsm-optimization':'路径优化','de-gsm-climb':'攀爬','de-gsm-interrupted':'中断前结果','fsm-growth':'冻结弦生长','fsm-growth-interrupted':'冻结弦生长中断','se-gsm-optimize':'路径优化','grow':'生长','growing':'生长','optimize':'路径优化','optimization':'路径优化'};
const segmentPhaseLabels:Record<string,string>={growth:'生长',optimization:'路径优化',optimize:'路径优化',climb:'攀爬',interrupted:'中断前结果',anchors:'关键构型连接'};
export function pesPathPhaseLabel(phase:string):string{
  if(phase.endsWith('-incomplete'))return pesPathPhaseLabel(phase.slice(0,-'-incomplete'.length))+'（未完整轮）';
  if(phase==='ci-neb-interrupted')return 'CI-NEB 中断';
  if(phase==='ci-neb-ordinary-interrupted')return 'NEB 中断';
  if(phase==='ci-neb-climb-interrupted')return 'CI-NEB 中断';
  if(phase==='ci-fsm-initialization-interrupted')return 'FSM 初始路径中断';
  const segment=/^de-gsm-segment-(\d+)-(growth|optimization|optimize|climb|interrupted|anchors)$/.exec(phase);return segment?`第 ${segment[1]} 段 · ${segmentPhaseLabels[segment[2]]}`:phaseLabels[phase]??phase;}
const incompleteRound=(record:PesPathRecord)=>/-(?:interrupted|incomplete)$/.test(record.phase);
const pathId=(record:PesPathRecord)=>record.pathId??record.seriesId;
const initialGeometry=(record:PesPathRecord)=>record.kind==='initial'||['initial','s-idpp','fsm-native-initial','native-dlc-initial'].includes(record.phase);
function pathRoundLabel(record:PesPathRecord):string{
  if(initialGeometry(record))return record.phase==='s-idpp'?'S-IDPP 初始路径':'初始几何';
  if(record.phase==='ci-fsm-initialization'&&record.kind==='final')return 'FSM 初始路径';
  return `${pesPathPhaseLabel(record.phase)} · 第 ${record.step} 轮`;
}
export const pesPathRecordLabel=(record:PesPathRecord)=>`${pathId(record)==='path'?'':`事件 ${pathId(record)} · `}${pathRoundLabel(record)}`;
const finiteEnergy=(frame:PesFrameIndex)=>typeof frame.energyHartree==='number'&&Number.isFinite(frame.energyHartree);
const bead=(frame:PesFrameIndex,index:number)=>typeof frame.bead==='number'&&Number.isFinite(frame.bead)?frame.bead:index+1;
const isNebRound=(record:PesPathRecord)=>record.phase==='neb'||record.phase.startsWith('ci-neb-');
const usesCompactHistory=(algorithm:string)=>algorithm==='ci-neb'||algorithm==='fsm';

function historyOrder(records:readonly PesPathRecord[],algorithm:string):readonly PesPathRecord[]{
  if(!usesCompactHistory(algorithm))return records;
  const stage=(record:PesPathRecord)=>initialGeometry(record)?0:isNebRound(record)?2:1;
  return [...records].sort((a,b)=>stage(a)-stage(b)||a.step-b.step);
}

function compactHistory(records:readonly PesPathRecord[],algorithm:string):readonly PesPathRecord[]{
  if(!usesCompactHistory(algorithm))return records;
  const complete=records.filter(record=>!incompleteRound(record));
  const rounds=complete.filter(record=>algorithm==='ci-neb'?isNebRound(record):record.phase==='fsm-growth');
  const lastRounds=new Set(rounds.slice(-2).map(record=>record.id));
  return complete.filter(record=>initialGeometry(record)||lastRounds.has(record.id)
    ||algorithm==='ci-neb'&&(isNebRound(record)&&record.step<=1
      ||record.phase==='ci-fsm-initialization'&&record.kind==='final'));
}

/** History extension contains only lightweight indices, not another energy UI. */
export function pesPathEnergyOverlays(records:readonly PesPathRecord[],visibleIds:readonly string[],axis:'bead'|'arc'='bead'):TrajectoryEnergyOverlay[]{
  return records.filter(record=>visibleIds.includes(record.id)).map(record=>{
    const edges=record.connections&&new Set(record.connections.flatMap(([a,b])=>[`${a}\0${b}`,`${b}\0${a}`]));
    const round=initialGeometry(record)?(record.phase==='s-idpp'?'S-IDPP Initial Path':'Initial Geometry')
      :record.phase==='ci-fsm-initialization'&&record.kind==='final'?'FSM Initial Path':`${record.phase} · Round ${record.step}`;
    const plotLabel=pathId(record)==='path'?round:`Event ${pathId(record)} · ${round}`;
    return{id:record.id,label:pesPathRecordLabel(record),plotLabel,points:record.frames.map((frame,index)=>{
      const previous=record.frames[index-1],number=bead(frame,index);
      const arc=typeof frame.arcLengthAngstrom==='number'&&Number.isFinite(frame.arcLengthAngstrom)?frame.arcLengthAngstrom:null;
      return{x:axis==='arc'?arc:number,energy:finiteEnergy(frame)?{value:frame.energyHartree!,unit:'hartree'}:null,frameId:frame.id,frameNumber:index+1,
        markerLabel:frame.climbingImage===true?'CI':undefined,
        breakBefore:!!previous&&(edges?!edges.has(`${previous.id}\0${frame.id}`):Math.abs(number-bead(previous,index-1))!==1)};
    })};
  });
}

export function PesPathHistory({run,recordId,onView,overlays=[],onOverlaysChange}:{run:PesRun;recordId?:string;frameId?:string;onView(recordId:string,frameId?:string):void;overlays?:readonly string[];onOverlaysChange?(ids:readonly string[]):void}){
  const records=pesPathRecords(run);
  const [historyPath,setHistoryPath]=useProjectState('pes.path.history-path','',run.request.id);
  const root=useRef<HTMLDivElement>(null);
  const paths=[...new Set(records.map(pathId))],selectedPath=records.find(record=>record.id===recordId);
  const historyPathId=paths.includes(historyPath)?historyPath:selectedPath?pathId(selectedPath):paths[0];
  const [expanded,setExpanded]=useProjectState('pes.path.history-expanded',false,JSON.stringify([run.request.id,historyPathId]));
  const algorithm=run.request.algorithm;
  const historyRecords=useMemo(()=>historyOrder(records.filter(record=>pathId(record)===historyPathId),algorithm),[records,historyPathId,algorithm]);
  const compact=useMemo(()=>compactHistory(historyRecords,algorithm),[historyRecords,algorithm]);
  const byId=new Map(historyRecords.map(record=>[record.id,record]));
  const fullProjection=useMemo(()=>({columns:[{key:'record',label:'路径记录'},{key:'beads',label:'实际珠子数'},{key:'kind',label:'记录类型'}],rows:historyRecords.map(record=>({key:record.id,cells:[pesPathRecordLabel(record),String(record.frames.length),incompleteRound(record)?'未完整轮':kindLabels[initialGeometry(record)?'initial':record.kind]]}))}),[historyRecords]);
  const projection=useMemo(()=>{
    if(expanded||compact.length===historyRecords.length)return fullProjection;
    const ids=new Set(compact.map(record=>record.id));
    return {...fullProjection,rows:fullProjection.rows.filter(row=>ids.has(row.key))};
  },[expanded,compact,historyRecords.length,fullProjection]);
  const exportFileName='Ester-Studio-path-records.txt';
  const exportHistory=()=>exportBlob(new Blob([scientificTableText(fullProjection)],{type:'text/plain;charset=utf-8'}),exportFileName,root.current?.ownerDocument);
  return <div ref={root} data-testid="pes-path-history" className="pes-path-history">
    <InputSettingsCard title="路径记录" stack>
      {paths.length>1&&<PesSelect label="路径/事件" value={historyPathId??''} options={Object.fromEntries(paths.map(id=>[id,id==='path'?'路径':`事件 ${id}`]))} onChange={setHistoryPath}/>}
      <ScientificDataTable hideTitle projection={projection} selectionScope={`${run.request.id}:path-records`} exportFileName={exportFileName} onExport={exportHistory} rowActions={[
        {kind:'checkbox',label:row=>`叠加${row.cells[0]}`,active:row=>overlays.includes(row.key),available:row=>!!onOverlaysChange&&row.key!==recordId&&!!byId.get(row.key)?.frames.some(finiteEnergy),onActivate:row=>onOverlaysChange?.(overlays.includes(row.key)?overlays.filter(id=>id!==row.key):[...overlays,row.key])},
        {kind:'select',label:row=>`查看${row.cells[0]}`,text:'查看',onActivate:row=>onView(row.key)},
      ]}/>
      {compact.length<historyRecords.length&&<button type="button" className="button pes-path-history-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
        {expanded?<ChevronsUp size={16} strokeWidth={1.75} aria-hidden="true"/>:<ChevronsDown size={16} strokeWidth={1.75} aria-hidden="true"/>}
        {expanded?'收起路径记录':'展开全部路径记录'}
      </button>}
    </InputSettingsCard>
  </div>;
}
