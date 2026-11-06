import type { HTMLAttributes, ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, RotateCcw, ShieldCheck } from 'lucide-react';
import './workflow-presentation.css';

export const WORKFLOW_STEPS = ['选择软件', '选择任务', '计算级别', '生成与导出'] as const;

export function WorkflowNavigation({step,busy=false,onBack,onNext,onGenerate,engine}:{step:number;busy?:boolean;onBack:()=>void;onNext:()=>void;onGenerate:()=>void;engine:'gaussian'|'orca'}) {
  return <footer className="workflow-navigation" data-testid="engine-navigation"><button type="button" className="button button-quiet" disabled={step===0} onClick={onBack}><ArrowLeft size={14}/>上一步</button><span>{step+1} / 4</span>{step!==1&&<button type="button" disabled={busy} aria-label={step>=2?`生成 ${engine==='orca'?'ORCA':'Gaussian'} 输入`:'下一步'} className="button button-primary" onClick={step===3?onGenerate:onNext}>{step===3?<RotateCcw size={14}/>:null}{step>=2?'生成输入':'下一步'}{step<3&&<ArrowRight size={14}/>}</button>}</footer>;
}

// Presentation only: each engine owns navigation, validation and scientific state.
export function WorkflowHeader({ engine, disabled = false, onEngine, children, title = '输入文件生成器' }: {
  engine: 'gaussian' | 'orca' | null; disabled?: boolean; title?: ReactNode;
  onEngine: (engine: 'gaussian' | 'orca') => void; children?: ReactNode;
}) {
  return <header className="topbar input-workflow-header workflow-header"><div className="breadcrumb"><span>工具中心</span><ChevronRight size={13} /><strong>{title}</strong><div className="engine-switch" aria-label="计算引擎">{(['gaussian', 'orca'] as const).map(value => <button type="button" key={value} aria-pressed={engine === value} disabled={disabled} onClick={() => onEngine(value)}>{value === 'gaussian' ? 'Gaussian' : 'ORCA'}</button>)}</div></div><div className="topbar-actions">{children}</div></header>;
}

export function WorkflowSteps({ step, onStep, label = '生成步骤', steps = WORKFLOW_STEPS, disabled = false }: { step: number; onStep: (step: number) => void; label?: string; steps?: readonly string[]; disabled?: boolean }) {
  return <nav className="stepper input-workflow-steps workflow-steps" aria-label={label}>{steps.map((name, index) => <button type="button" key={name} disabled={disabled} className={`step ${step === index ? 'current' : ''} ${step > index ? 'complete' : ''}`} aria-label={name} aria-current={step === index ? 'step' : undefined} onClick={() => { if (!disabled) onStep(index); }}><span className="step-number" aria-hidden="true">{step > index ? <Check size={14} /> : index + 1}</span><span>{name}</span>{index < steps.length - 1 && <span className="step-line" />}</button>)}</nav>;
}

export interface WorkflowContentCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode; description?: ReactNode; step?: number; total?: number;
  actions?: ReactNode; footer?: ReactNode; heading?:boolean;
}
/** The shared card owns presentation and scroll placement; its caller owns all state. */
export function WorkflowContentCard({ title, description, step, total = WORKFLOW_STEPS.length, actions, footer, children, className = '', heading=true, ...sectionProps }: WorkflowContentCardProps) {
  return <section {...sectionProps} className={`work-card form-card workflow-content-card ${className}`.trim()}><div className="engine-parameter-scroll">{heading&&<div className="card-heading"><div className="heading-with-number">{step != null && <span className="section-number">{String(step + 1).padStart(2, '0')}</span>}<div><h2>{title}</h2>{description && <p>{description}</p>}</div></div>{step != null && <span className="small-step">{step + 1} / {total}</span>}{actions && <div className="workflow-card-actions">{actions}</div>}</div>}{children}</div>{footer}</section>;
}
export function WorkflowSessionBar({ label, actions }: { label: ReactNode; actions?: ReactNode }) {
  return <header className="workflow-session-bar"><span>{label}</span>{actions && <div className="workflow-session-actions">{actions}</div>}</header>;
}

export function ElectronicStatePanel({ confirmed, error, children }: { confirmed: boolean; error: string | null; children: ReactNode }) {
  return <div className={`electronic-state-panel ${confirmed && !error ? 'is-confirmed' : ''}`}><div className="subheading"><h3><ShieldCheck size={17} />核对电荷与自旋</h3><span className={confirmed ? 'text-status confirmed' : 'text-status'}>{confirmed ? '已确认' : '请合理选择'}</span></div>{children}</div>;
}
