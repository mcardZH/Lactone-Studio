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
const stationaryLabels:Record<string,string>={minimum:'极小点','first-order-saddle':'一级鞍点','higher-order-saddle':'高阶鞍点',unverified:'驻点未鉴定','frequency-incomplete':'频率未完成'};
const ircDirectionLabels:Record<string,string>={origin:'起点',forward:'正向',reverse:'反向',downhill:'下坡'};
const ircStatusLabels:Record<string,string>={...labels,'step-limit':'达到步数上限'};
interface PesDiagnostic {message?:string;detail?:string}
interface IrcBranch {
  direction:string;status:string;attemptedSteps:number;acceptedSteps:number;
  skippedSteps?:number|({step:number}&PesDiagnostic)[];
  hessianRefreshes?:{step:number;error?:PesDiagnostic}[];
  error?:PesDiagnostic;
}
const ircSkippedCount=(branch:IrcBranch)=>Array.isArray(branch.skippedSteps)?branch.skippedSteps.length:branch.skippedSteps??0;

/** PES adds native statuses and read-only failed assets to the shared analysis. */
export function PesResultDetails({run,frameId,seek}:{run:PesRun;frameId?:string;seek(frame:PesFrame):void;plots?:boolean}){
  const axes=scanAxes(run),frames=run.result?.frames??run.acceptedFrames;
  const framesById=useMemo(()=>{
    const index=new Map<string,PesFrame>();
    for(const frame of frames??[])if(!index.has(frame.id))index.set(frame.id,frame);
    return index;
  },[frames]);
  const selected=frameId??run.preview?.id,frame=selected?framesById.get(selected):undefined;
  const hessian=run.result?.hessian as {frameId?:string;imaginaryCount?:number;projectedDegreesOfFreedom?:number}|undefined;
  const stationarity=run.result?.stationaryPoint;
  const irc=run.result?.irc as {branches?:IrcBranch[];mode?:number;imaginaryCount?:number}|undefined;
  const counts=useMemo(()=>{
    if(run.request.operation!=='scan')return;
    const points=pesScanPoints(run),total=scanAxes(run).reduce((count,axis)=>count*axis.points,1);
    const processed=points.filter(point=>!['missing','pending','unprocessed'].includes(point.status)).length;
    return {points,total,processed,valid:pesFramesForPlot(run).filter(frame=>Number.isFinite(frame.energyHartree)).length,
      failed:points.filter(point=>['failed','unconverged'].includes(point.status)).length,stopped:points.filter(point=>point.status==='stopped').length};
  },[run]);
  const staticDetails=useMemo(()=>{
    const points=counts?.points??[];
    const ircFailures=(irc?.branches??[]).flatMap(branch=>{
      const direction=ircDirectionLabels[branch.direction]??branch.direction;
      const diagnostics=[
        {label:direction, error:branch.error},
        ...(Array.isArray(branch.skippedSteps)?branch.skippedSteps:[]).map(step=>({label:direction+' · 第 '+step.step+' 步',error:step})),
        ...(branch.hessianRefreshes??[]).map(refresh=>({label:direction+' · 第 '+refresh.step+' 步重算 Hessian',error:refresh.error})),
      ];
      return diagnostics.flatMap(({label,error})=>{
        const message=[error?.message,error?.detail].filter((item,index,all)=>item&&all.indexOf(item)===index).join(' · ');
        return message?[{label,message}]:[];
      });
    });
    const otherPoints=points.filter(point=>point.status!=='converged'||point.energyHartree==null||!point.frameId);
    const otherProjection={columns:[{key:'point',label:'扫描点'},{key:'target',label:'目标 q'},{key:'actual',label:'实际 q'},{key:'status',label:'状态'},{key:'reason',label:'原生终态'},{key:'energy',label:'E / Eh'}],
      rows:otherPoints.map(point=>({key:String(point.pointIndex),cells:[String(point.pointIndex+1),(point.targets??[]).map(value=>formatResultValue(value,6)).join(', ')||'未输出',
        (point.actual??[]).map(value=>formatResultValue(value,6)).join(', ')||'未输出',labels[point.status]??point.status,String(point.terminationReason??'未输出'),point.energyHartree==null?'未输出':decimalEnergyValue(point.energyHartree)]}))};
    const terminalDiagnostic=run.result?.error as PesDiagnostic|undefined;
    const runIssue=terminalDiagnostic?.message??run.error?.detail??run.error?.message;
    const localFailures=[
      ...(runIssue?[{label:'本次运行',message:runIssue}]:[]),
      ...ircFailures,
      ...(run.result?.series??[]).flatMap(series=>typeof series.error==='string'&&series.error?[{label:series.label??series.id,message:series.error}]:[]),
      ...points.flatMap(point=>{const error=point.error as {message?:string}|undefined,warning=point.warning as {message?:string}|undefined,message=error?.message??warning?.message;
        return message?[{label:`扫描点 ${point.pointIndex+1}`,message}]:[];}),
    ];
    return {header:<>
      {irc&&<PesDetails title="IRC 分支结果" sectionKey={`${run.request.id}:irc-branches`} defaultOpen>
        {typeof irc.mode==='number'&&<p>选用模态 {irc.mode} · 虚频 {irc.imaginaryCount??'—'}</p>}
        {irc.branches?.map(branch=><p key={branch.direction}>{ircDirectionLabels[branch.direction]??branch.direction} · {ircStatusLabels[branch.status]??branch.status} · {branch.acceptedSteps} 个有效点 / {branch.attemptedSteps} 步
          {ircSkippedCount(branch)>0&&` · 跳过 ${ircSkippedCount(branch)} 步`}</p>)}
      </PesDetails>}
      {localFailures.length>0&&<details className="pes-local-failures">
        <summary aria-label="查看局部失败详情" title="查看失败原因"><span aria-hidden="true">!</span></summary>
        <div role="note">{localFailures.map((failure,index)=><p key={index}>{failure.label} · {failure.message}</p>)}</div>
      </details>}
      {counts&&<p className="postprocess-note" data-testid="pes-scan-counts">已处理 {counts.processed} / {counts.total} 点 · 收敛曲线 {counts.valid} 点 · 失败/未收敛 {counts.failed} 点 · 停止 {counts.stopped} 点 · 未处理 {Math.max(0,counts.total-counts.processed)} 点</p>}
    </>,other:otherPoints.length>0&&<PesDetails title="其他扫描点记录"><ScientificDataTable hideTitle projection={otherProjection} selectionScope={`${run.request.id}:other-scan-points`} exportFileName="Ester-Studio-SCAN-other-points.txt"
      rowAction={{kind:'select',label:'查看该点结构',text:'查看结构',available:row=>!!otherPoints.find(point=>String(point.pointIndex)===row.key)?.frameId,onActivate:row=>{
        const point=otherPoints.find(point=>String(point.pointIndex)===row.key),target=point?.frameId?framesById.get(point.frameId):undefined;if(target)seek(target);
      }}}/></PesDetails>};
  },[run,irc,counts,framesById,seek]);
  return <>
    {staticDetails.header}
    {frame&&<InputSettingsCard title="当前帧" stack sectionKey={`${run.request.id}:frame-details`}>
      <p>{labels[frame.status]??frame.status}{typeof frame.bead==='number'?` · 珠子 ${frame.bead}`:axes.length?` · 扫描点 ${frame.step+1}`:''}</p>
      {axes.map((axis,index)=><p key={index}>{axis.name} · 目标 {formatResultValue(Array.isArray(frame.cvTargets)?frame.cvTargets[index]:null,6)} / 实际 {formatResultValue(frame.cv?.[index],6)} {axis.unit}</p>)}
      {typeof frame.ircDirection==='string'&&<p>{ircDirectionLabels[frame.ircDirection]??frame.ircDirection} · 路径长度 {formatResultValue(frame.cv?.[0],6)} Å·√amu</p>}
      {hessian?.frameId===frame.id&&<p>虚频 {hessian.imaginaryCount??'—'} · 约束切空间 {hessian.projectedDegreesOfFreedom??'—'} 维{typeof stationarity==='string'?` · ${stationaryLabels[stationarity]??stationarity}`:''}</p>}
    </InputSettingsCard>}
    {staticDetails.other}
  </>;
}
