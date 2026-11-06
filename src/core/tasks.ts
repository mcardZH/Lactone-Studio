import type { TaskId,TaskOptions,InternalCoordinate,Atom,JobRequest,GaussianSettings } from './types';
import { resolveCoordinateDrafts } from './coordinate-drafts';
export const TASK_GROUPS=[{id:'structure',label:'结构与能量'},{id:'path',label:'反应路径'},{id:'excited',label:'激发态'},{id:'properties',label:'性质与诊断'}] as const;
export const TASKS:{id:TaskId;group:typeof TASK_GROUPS[number]['id'];name:string;code:string;description:string;title:string}[]=[
  {id:'sp',group:'structure',name:'单点能',code:'SP',description:'保持结构，计算电子能量',title:'single point energy'},
  {id:'opt',group:'structure',name:'结构优化',code:'Opt',description:'只优化，不附带频率',title:'geometry optimization'},
  {id:'freq',group:'structure',name:'振动分析',code:'Freq',description:'在已有结构上补算频率',title:'vibrational frequencies'},
  {id:'optfreq',group:'structure',name:'优化 + 振动分析',code:'Opt Freq',description:'先优化，再计算振动频率',title:'geometry optimization and frequencies'},
  {id:'scan',group:'path',name:'势能面扫描',code:'Scan',description:'柔性扫描键长、键角或二面角',title:'relaxed potential energy scan'},
  {id:'ts',group:'path',name:'过渡态搜索',code:'TS + Freq',description:'从初猜搜索鞍点，并计算最终频率',title:'transition state optimization and frequencies'},
  {id:'irc',group:'path',name:'双向 IRC',code:'IRC',description:'单个作业同时沿正反方向追踪反应路径',title:'bidirectional intrinsic reaction coordinate'},
  {id:'td',group:'excited',name:'垂直激发 / 光谱',code:'TD / TDA',description:'保持几何，计算电子激发态',title:'vertical electronic excitations'},
  {id:'tdopt',group:'excited',name:'S/T 激发态结构',code:'S/T Opt / Freq',description:'指定S/T目标态，优化、独立频率或优化+频率',title:'excited state geometry optimization'},
  {id:'nmr',group:'properties',name:'NMR 屏蔽 / 耦合',code:'NMR',description:'GIAO屏蔽；明确选择时计算J耦合',title:'NMR properties'},
  {id:'stable',group:'properties',name:'波函数稳定性',code:'Stable',description:'仅检测或按需优化波函数，不优化几何',title:'wavefunction stability'},
  {id:'bsse',group:'properties',name:'BSSE 校正',code:'Counterpoise',description:'保留全体系，按片段计算Counterpoise',title:'counterpoise correction'},
];
export const isOptimizationTask=(task:TaskId)=>['opt','optfreq','ts','qst2','qst3','scan','constrained','tdopt','t1opt'].includes(task);
export const isEnergyTask=(task:TaskId)=>task==='sp'||task==='bsse';
export const usesEfficientGrid=(task:TaskId)=>['opt','optfreq','freq','ts','qst2','qst3','irc','scan','constrained','tdopt','t1opt'].includes(task);
export function defaultTaskOptions():TaskOptions{return {constraintsEnabled:false,coordinates:[],frozenAtoms:[],irc:{maxPoints:null,stepSize:null,lqa:true,confirmed:false},excited:{nstates:null,root:1,approximation:'td',spin:'default',targetSpin:'singlets',useUks:false,frequency:false,printCoefficients:false},nmr:{mode:'giao'},stable:{optimize:false,confirmed:false},fragments:[{atoms:[],charge:0,multiplicity:1,multiplicityMode:'auto'},{atoms:[],charge:0,multiplicity:1,multiplicityMode:'auto'}],fragmentStatesConfirmed:false};}
export const supportsConstraints=(task:TaskId)=>['opt','optfreq','freq','ts','irc','scan','constrained','tdopt','t1opt'].includes(task);
export function constraintsEnabled(settings:GaussianSettings):boolean{return supportsConstraints(settings.task)&&(settings.taskOptions?.freezeEnabled??Boolean(settings.taskOptions?.constraintsEnabled));}
export function coordinateAction(coordinate:InternalCoordinate,task:TaskId):'freeze'|'scan'{return coordinate.action??(task==='scan'?'scan':'freeze');}
/** Scans are intrinsic to Scan; frozen entries are governed by the common switch. */
export function activeCoordinates(request:Pick<JobRequest,'settings'>):InternalCoordinate[]{return resolveCoordinateDrafts(request.settings).coordinates;}
export function activeFrozenAtoms(request:Pick<JobRequest,'settings'>):number[]{
  if(!constraintsEnabled(request.settings))return [];
  const options=request.settings.taskOptions;
  return options?.frozenAtoms??[];
}
export const isZindo=(settings:GaussianSettings)=>settings.task==='td'&&settings.taskOptions?.excited.approximation==='zindo';
export function spectrumStates(count:number){return count<=20?20:count<=30?30:count<=50?50:count<=80?80:100;}
export function ircPoints(count:number|undefined){return count===undefined?30:count<50?50:30;}
export function taskRecommendation(task:TaskId):string{return {
  sp:'单点默认 M06-2X / def2TZVP + D3；不会先优化结构。',opt:'仅优化默认 B3LYP / def2SVP + D3BJ，Opt=Loose，不自动频率。',freq:'频率沿实际优化级别；可靠识别的来源设置供你确认。',optfreq:'默认 B3LYP / def2SVP + D3BJ，普通Opt后做Freq，不自动追加SP。',
  scan:'柔性扫描默认B3LYP / def2SVP + D3BJ，Loose松弛其它自由度；扫描增量与优化MaxStep不同。',constrained:'固定请求的原子/内坐标，Loose松弛其余部分；不自动接TS。',ts:'TS默认B3LYP / def2SVP + D3BJ，CalcFC、NoEigenTest和最终频率；不使用QST2/QST3，不自动IRC。',irc:'继承实际TS势能面；单输入单作业双向，优先有兼容频率Hessian时RCFC，否则CalcFC，默认LQA。',
  qst2:'独立QST2：选择真实两端并确认完整原子对应；频率仅明确选择时追加，不认证TS或自动IRC。',qst3:'独立QST3：第三结构为用户提供的TS猜测，不是已验TS；频率仅明确选择时追加。',
  td:'垂直激发默认B3LYP / def2SVP + D3BJ，按原子数推荐20–100态；CAM/PBE0由客户主动选择。',tdopt:'选择S/T目标与Root；T1可用UKS，其它态用TD/TDA。仅优化默认Loose；仅频率保留当前几何，优化+频率用同态普通Opt Freq，不套光谱大态数。',t1opt:'默认三重态UDFT，明确多重度3和Loose；不是TD三重态路线，不自动频率。',nmr:'NMR默认B3LYP / 6-311+G(2d,p) + D3BJ，GIAO与SMD；实验溶剂必须指定。',stable:'继承被诊断任务的级别与电子态，选择只检测或必要时优化波函数，不优化几何。',bsse:'继承被校正SP条件；无可靠来源时以M06-2X / def2TZVP + D3为起点。完整分片，当前Gaussian文档不支持与SCRF组合。',
}[task];}
export function coordinateAtoms(text:string):number[]{if(!text.trim())return [];return text.trim().split(/[\s,，]+/).map(value=>{if(!/^\d+$/.test(value)||Number(value)<1||!Number.isSafeInteger(Number(value)))throw new Error('内坐标原子按顺序填写正整数，如1,2,3；不使用范围缩写。');return Number(value);});}
const minus=(a:Atom,b:Atom)=>[a.x-b.x,a.y-b.y,a.z-b.z];const dot=(a:number[],b:number[])=>a.reduce((n,v,i)=>n+v*b[i],0);const length=(a:number[])=>Math.hypot(...a);const cross=(a:number[],b:number[])=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function coordinateValue(definition:InternalCoordinate,atoms:Atom[]):number{
  const points=definition.atoms.map(index=>atoms[index-1]);if(points.some(point=>!point))throw new Error('内坐标引用了范围外的原子。');
  if(definition.type==='B')return length(minus(points[0],points[1]));
  if(definition.type==='A'){const a=minus(points[0],points[1]),b=minus(points[2],points[1]);if(length(a)*length(b)<1e-12)throw new Error('角度含重叠原子，不能可靠定义。');return Math.acos(Math.max(-1,Math.min(1,dot(a,b)/length(a)/length(b))))*180/Math.PI;}
  const b0=minus(points[0],points[1]),b1=minus(points[2],points[1]),b2=minus(points[3],points[2]);const norm=length(b1);if(norm<1e-12)throw new Error('二面角中间原子重叠。');const axis=b1.map(v=>v/norm),v=b0.map((n,i)=>n-dot(b0,axis)*axis[i]),w=b2.map((n,i)=>n-dot(b2,axis)*axis[i]);if(length(v)*length(w)<1e-12)throw new Error('共线原子不能可靠定义二面角。');return Math.atan2(dot(cross(axis,v),w),dot(v,w))*180/Math.PI;
}
