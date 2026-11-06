import { useId, useState, type ReactNode } from 'react';
import {ProjectUiScope,useProjectState} from '../../projects/ui-state';
import { RotateCcw } from 'lucide-react';
import { BOHR_TO_ANGSTROM } from '../../core/orca/assets';
import './analysis-task-layout.css';

export interface AnalysisTaskLayoutProps {
  title?: string;
  headerActions?: ReactNode;
  ariaLabel?: string;
  testId?: string;
  className?: string;
  setup?: ReactNode;
  quality?: ReactNode;
  onRestoreQuality?(): void;
  qualityDisabled?: boolean;
  actions?: ReactNode;
  progress?: ReactNode;
  children?: ReactNode;
  plotting?: ReactNode;
  onRestorePlotting?(): void;
  /** Legacy remains available for task internals outside the current UI scope. */
  variant?: 'card' | 'legacy';
  plottingSections?: boolean;
  methodDetails?: boolean;
}

/**
 * Shared presentation only. The caller retains its scientific owner, request,
 * cancellation, result and local display state; rendering never starts work.
 */
export function AnalysisTaskLayout({
  title, headerActions, ariaLabel, testId, className = '', setup, quality, actions, progress,
  children, plotting, onRestorePlotting, variant = 'legacy', plottingSections = false, methodDetails = false, onRestoreQuality, qualityDisabled = false,
}: AnalysisTaskLayoutProps) {
  const [collapsed, setCollapsed] = useProjectState('analysis-card.collapsed',false, testId??ariaLabel??title??className), bodyId = useId();
  const qualityBlock=quality!=null&&quality!==false?<AnalysisQualitySettings onRestore={onRestoreQuality} disabled={qualityDisabled}>{quality}</AnalysisQualitySettings>:null;
  return <section className={`analysis-task-layout ${variant === 'card' ? 'analysis-task-card' : ''} ${className}`.trim()}
    aria-label={ariaLabel ?? title} data-testid={testId}>
    {title && <h3 className="analysis-task-title"><button type="button" className="analysis-card-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={()=>setCollapsed(value=>!value)}><span aria-hidden="true">{collapsed?'▸':'▾'}</span>{title}</button>{headerActions&&<span className="analysis-task-heading-actions">{headerActions}</span>}</h3>}
    <div className="analysis-task-body" id={bodyId} hidden={Boolean(title&&collapsed)}>
    {variant === 'card' && progress != null && <div className="analysis-task-progress">{progress}</div>}
    {variant === 'card' ? <div className="analysis-task-configuration">
      {setup != null && <div className="analysis-task-setup">{setup}</div>}
      {qualityBlock}
      {actions != null && <div className="analysis-task-actions">{actions}</div>}
    </div> : <>
      {setup != null && <div className="analysis-task-setup">{setup}</div>}
      {qualityBlock}
      {actions != null && <div className="analysis-task-actions">{actions}</div>}
      {progress != null && <div className="analysis-task-progress">{progress}</div>}
    </>}
    {children != null && <div className="analysis-task-results">{children}</div>}
    {plotting != null && (plottingSections ? plotting : <AnalysisPlotSettings onRestore={onRestorePlotting}>{plotting}</AnalysisPlotSettings>)}
    {methodDetails && <AnalysisMethodDetails/>}
    </div>
  </section>;
}

/** Shared presentation; reset is supplied only by a caller that owns defaults. */
export function AnalysisQualitySettings({children,onRestore,disabled=false}:{children:ReactNode;onRestore?():void;disabled?:boolean}) {
  return <section className="analysis-task-quality" aria-label="计算质量与范围"><header className="analysis-quality-heading"><h4>计算质量与范围</h4>{onRestore&&<button type="button" className="analysis-quality-reset" aria-label="恢复计算质量与范围" title="恢复计算质量与范围" disabled={disabled} onClick={onRestore}><RotateCcw size={16} strokeWidth={1.75}/></button>}</header><div className="analysis-quality-fields">{children}</div></section>;
}

export function AnalysisMethodDetails() {
  return <details className="analysis-method-details" aria-label="来源与方法详情"><summary>来源与方法详情</summary><p>暂无补充说明。</p></details>;
}

export interface AnalysisTaskSectionProps {
  title: string;
  children: ReactNode;
  controls?: ReactNode;
  className?: string;
  testId?: string;
  onRestore?(): void;
}

export function AnalysisTaskSection({
  title, children, controls, onRestore, className = '', testId,
}: AnalysisTaskSectionProps) {
  const [collapsed,setCollapsed] = useProjectState('analysis-section.collapsed',false,testId??title), bodyId=useId();
  return <section className={`analysis-task-section ${className}`.trim()}
    aria-label={title} data-testid={testId}>
    <header className="analysis-task-section-heading">
      <h4><button type="button" className="analysis-card-toggle" aria-expanded={!collapsed} aria-controls={bodyId} onClick={()=>setCollapsed(value=>!value)}><span aria-hidden="true">{collapsed?'▸':'▾'}</span>{title}</button></h4>
      {(controls != null || onRestore) && <div className="analysis-task-controls">{controls}{onRestore&&<button type="button" className="analysis-quality-reset" title={`恢复${title}默认`} aria-label={`恢复${title}默认`} onClick={onRestore}><RotateCcw size={16} strokeWidth={1.75}/></button>}</div>}
    </header>
    <div className="analysis-task-section-body" id={bodyId} hidden={collapsed}>{children}</div>
  </section>;
}

export function AnalysisPlotSettings({
  title = '绘图设置', children, controls, onRestore, className = '', testId,
}: Omit<AnalysisTaskSectionProps, 'title'> & { title?: string }) {
  return <AnalysisTaskSection title={title} controls={controls} onRestore={onRestore}
    className={`analysis-plot-settings ${className}`.trim()} testId={testId}>
    {children}
  </AnalysisTaskSection>;
}

export const CALCULATION_QUALITY_LABELS = {
  toy: '玩具', coarse: '粗糙', medium: '中等', fine: '精细', artistic: '艺术', custom: '自定义',
} as const;

export interface SpatialGridPreview {
  dimensions: readonly number[]; pointCount: number; axisSpacingBohr: readonly number[]; estimated: boolean;
}
export function SpatialGridSummary({ preview, actual, unit = 'Bohr' }: {
  preview: SpatialGridPreview | null; actual?: SpatialGridPreview | null; unit?: 'Bohr' | 'Å';
}) {
  const describe = (grid: SpatialGridPreview, current = false) => <>
    {current?'实际网格':grid.estimated?'预计网格':'网格'} {grid.dimensions.join(' × ')} · 总点数 {grid.pointCount.toLocaleString()}
    {' · '}{current?'实际格距':grid.estimated?'预计格距':'格距'} X/Y/Z：{grid.axisSpacingBohr.map(value=>Number((value*(unit==='Å'?BOHR_TO_ANGSTROM:1)).toPrecision(4))).join(' / ')} {unit}
  </>;
  return <output className="analysis-grid-summary" aria-label="空间网格信息">
    {preview&&<span data-grid-kind="planned">{describe(preview)}</span>}
    {actual&&<span data-grid-kind="actual">{describe(actual,true)}</span>}
  </output>;
}
export type CalculationQualityTier = keyof typeof CALCULATION_QUALITY_LABELS;

export interface CalculationQualityOption<T extends string = string> {
  value: T;
  tier: CalculationQualityTier;
  disabled?: boolean;
}

/** Native parameter mapping belongs to each method, not to this selector. */
export function CalculationQualityControl<T extends string>({
  value, options, onChange, effectiveParameters, children, disabled = false,
  label = '计算质量', ariaLabel,
}: {
  value: T;
  options: readonly CalculationQualityOption<T>[];
  onChange(value: T): void;
  effectiveParameters?: string;
  children?: ReactNode;
  disabled?: boolean;
  label?: string;
  ariaLabel?: string;
}) {
  return <div className="analysis-quality-control">
    <label><span>{label}</span><select aria-label={ariaLabel ?? label} value={value}
      disabled={disabled} onChange={event => {
        const option = options.find(item => item.value === event.target.value);
        if (option && !option.disabled) onChange(option.value);
      }}>
      {options.map(option => <option key={option.value} value={option.value}
        disabled={option.disabled}>{CALCULATION_QUALITY_LABELS[option.tier]}</option>)}
    </select></label>
    {effectiveParameters && <output className="analysis-quality-effective"
      aria-label={`${label}实际参数`}>{effectiveParameters}</output>}
    {children}
  </div>;
}
