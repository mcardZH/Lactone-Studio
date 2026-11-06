import SoftwareChooser from '../SoftwareChooser';
import {WorkflowContentCard,WorkflowSteps} from '../WorkflowPresentation';
export type AdvancedSection='xtb2'|'conformer'|'path';
export type ConformerSamplingChoice='md'|'metadynamics'|'anneal'|'conformer-search';
export const CONFORMER_SAMPLING_CHOICES=[
  {id:'md',symbol:'MD',label:'高温MD',description:'恒温采样，按间隔提取候选。'},
  {id:'metadynamics',symbol:'MTD',label:'Metadynamics',description:'RMSD偏置采样。'},
  {id:'conformer-search',symbol:'D',label:'柔性键采样',description:'定义可旋转二面角并生成初猜。'},
] as const;
const sections=[
  {id:'xtb2',symbol:'x',label:'XTB2波函数分析',description:'由当前帧显式生成波函数，进入完整后处理。'},
  {id:'conformer',symbol:'C',label:'构象搜索',description:'采样初猜、多级优化与归簇筛选。'},
  {id:'path',symbol:'R',label:'反应路径探索（开发中）',description:'扫描、过渡态及双端反应路径。'},
] as const;
const steps=['选择任务','任务设置'] as const;
const choices=sections.map(section=>({...section,action:'进入任务 →'}));
export default function AdvancedWorkflowNavigation(p:{activeSection?:AdvancedSection|null;onSectionChange(section:AdvancedSection|null):void;disabled?:boolean;samplingOperation?:ConformerSamplingChoice|null;onSamplingOperation?(operation:ConformerSamplingChoice|null):void}){
  if(p.activeSection==='conformer'&&p.onSamplingOperation){
    const progress=<WorkflowSteps label="高级任务步骤" steps={steps} step={1} disabled={p.disabled} onStep={index=>{if(!p.disabled&&index===0)p.onSectionChange(null);}}/>;
    return <section className="advanced-workflow-navigation" aria-label="高级任务导航" data-testid="advanced-workflow-navigation">{progress}<div className="advanced-workflow-current"><strong>构象搜索</strong></div></section>;
  }
  const progress=<WorkflowSteps label="高级任务步骤" steps={steps} step={p.activeSection?1:0} disabled={p.disabled} onStep={index=>{if(!p.disabled&&index===0)p.onSectionChange(null);}}/>;
  if(p.activeSection)return <section className="advanced-workflow-navigation" aria-label="高级任务导航" data-testid="advanced-workflow-navigation">{progress}<div className="advanced-workflow-current"><strong>{sections.find(row=>row.id===p.activeSection)!.label}</strong></div></section>;
  return <div className="advanced-workflow-entry" data-testid="advanced-workflow-entry">{progress}<WorkflowContentCard title="选择任务" step={0} total={steps.length}><SoftwareChooser<AdvancedSection> choices={choices} title="高级任务" description="选择需要完成的任务，使用当前帧准备参数。" ariaLabel="高级任务" testId="advanced-workflow-chooser" disabled={p.disabled} onChoose={p.onSectionChange}/></WorkflowContentCard></div>;
}
