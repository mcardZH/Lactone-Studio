import {useMemo} from 'react';
import type {PesFrame,PesRun} from '../../modeling/pes/contracts';
import {pesFramesForPlot,pesScanPoints} from '../../modeling/pes/result-adapter';
import {decimalEnergyValue,formatResultValue} from '../../results/numeric-format';
import {InputSettingsCard} from '../InputSettingsFields';
import {ScientificDataTable} from '../results/ScientificDataTable';
import {PesDetails} from './pes-fields';

interface ScanAxis {name:string;unit:string;points:number}
const scanAxes=(run:PesRun):ScanAxis[]=>run.request.operation==='scan'&&Array.isArray(run.request.parameters.axes)?run.request.parameters.axes:[];
const labels:Record<string,string>={accepted:'已接受',evaluated:'已求值',converged:'已收敛',unconverged:'未收敛',completed:'已完成',stopped:'已停止',failed:'失败',
  missing:'未处理',pending:'待处理',geometry:'几何初始路径',available:'可浏览',candidate:'候选',partial:'部分结果'};
const stationaryLabels:Record<string,string>={minimum:'极小点','first-order-saddle':'一级鞍点','higher-order-saddle':'高阶鞍点',unverified:'驻点未鉴定'};

/** PES adds native statuses and read-only failed assets to the shared analysis. */
export function PesResultDetails({run,frameId,seek}:{run:PesRun;frameId?:string;seek(frame:PesFrame):void;plots?:boolean}){
  const axes=scanAxes(run),frames=run.result?.frames??run.acceptedFrames;
  const selected=frameId??run.preview?.id,frame=selected?frames?.find(item=>item.id===selected):undefined;
  const hessian=run.result?.hessian as {frameId?:string;imaginaryCount?:number;projectedDegreesOfFreedom?:number}|undefined;
  const stationarity=run.result?.stationaryPoint,points=run.request.operation==='scan'?pesScanPoints(run):[];
  const otherPoints=points.filter(point=>point.status!=='converged'||point.energyHartree==null||!point.frameId);
  const otherProjection=useMemo(()=>({columns:[{key:'point',label:'扫描点'},{key:'target',label:'目标 q'},{key:'actual',label:'实际 q'},{key:'status',label:'状态'},{key:'reason',label:'原生终态'},{key:'energy',label:'E / Eh'}],
    rows:otherPoints.map(point=>({key:String(point.pointIndex),cells:[String(point.pointIndex+1),(point.targets??[]).map(value=>formatResultValue(value,6)).join(', ')||'未输出',
      (point.actual??[]).map(value=>formatResultValue(value,6)).join(', ')||'未输出',labels[point.status]??point.status,String(point.terminationReason??'未输出'),point.energyHartree==null?'未输出':decimalEnergyValue(point.energyHartree)]}))}),[otherPoints]);
  const localFailures=[
    ...(run.error?.message?[{label:'本次运行',message:run.error.message}]:[]),
    ...(run.result?.series??[]).flatMap(series=>typeof series.error==='string'&&series.error?[{label:series.label??series.id,message:series.error}]:[]),
    ...points.flatMap(point=>{const error=point.error as {message?:string}|undefined,warning=point.warning as {message?:string}|undefined,message=error?.message??warning?.message;
      return message?[{label:`扫描点 ${point.pointIndex+1}`,message}]:[];}),
  ];
  const processed=points.filter(point=>!['missing','pending','unprocessed'].includes(point.status)).length,total=axes.reduce((count,axis)=>count*axis.points,1);
  const valid=run.request.operation==='scan'?pesFramesForPlot(run).filter(frame=>Number.isFinite(frame.energyHartree)).length:0;
  return <>
    {localFailures.length>0&&<details className="pes-local-failures">
      <summary aria-label="查看局部失败详情" title="查看失败原因"><span aria-hidden="true">!</span></summary>
      <div role="note">{localFailures.map((failure,index)=><p key={index}>{failure.label} · {failure.message}</p>)}</div>
    </details>}
    {run.request.operation==='scan'&&<p className="postprocess-note" data-testid="pes-scan-counts">已处理 {processed} / {total} 点 · 收敛曲线 {valid} 点 · 失败/未收敛 {points.filter(point=>['failed','unconverged'].includes(point.status)).length} 点 · 停止 {points.filter(point=>point.status==='stopped').length} 点 · 未处理 {Math.max(0,total-processed)} 点</p>}
    {frame&&<InputSettingsCard title="当前帧" stack sectionKey={`${run.request.id}:frame-details`}>
      <p>{labels[frame.status]??frame.status}{typeof frame.bead==='number'?` · 珠子 ${frame.bead}`:axes.length?` · 扫描点 ${frame.step+1}`:''}</p>
      {axes.map((axis,index)=><p key={index}>{axis.name} · 目标 {formatResultValue(Array.isArray(frame.cvTargets)?frame.cvTargets[index]:null,6)} / 实际 {formatResultValue(frame.cv?.[index],6)} {axis.unit}</p>)}
      {hessian?.frameId===frame.id&&<p>虚频 {hessian.imaginaryCount??'—'} · 约束切空间 {hessian.projectedDegreesOfFreedom??'—'} 维{typeof stationarity==='string'?` · ${stationaryLabels[stationarity]??stationarity}`:''}</p>}
    </InputSettingsCard>}
    {otherPoints.length>0&&<PesDetails title="其他扫描点记录"><ScientificDataTable hideTitle projection={otherProjection} selectionScope={`${run.request.id}:other-scan-points`} exportFileName="Ester-Studio-SCAN-other-points.txt"
      rowAction={{kind:'select',label:'查看该点结构',text:'查看结构',available:row=>!!otherPoints.find(point=>String(point.pointIndex)===row.key)?.frameId,onActivate:row=>{
        const point=otherPoints.find(point=>String(point.pointIndex)===row.key),target=frames?.find(frame=>frame.id===point?.frameId);if(target)seek(target);
      }}}/></PesDetails>}
  </>;
}
