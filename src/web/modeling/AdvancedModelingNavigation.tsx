import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import SoftwareChooser, { type SoftwareChoice } from '../SoftwareChooser';
import { WorkflowContentCard } from '../WorkflowPresentation';
import { geometryTransformTasks, type GeometryTransformTask } from './GeometryTransformPanel';
import { periodicModelingTasks, type PeriodicModelingTask } from './PeriodicModelingPanel';

export type AdvancedModelingRoute =
  | { category: 'geometry'; task: GeometryTransformTask | null }
  | { category: 'periodic'; task: PeriodicModelingTask | null }
  | null;

/** Navigation shares the task-card presentation, not a computational wizard. */
export default function AdvancedModelingNavigation({ route, onChange, disabled = false, expandedTasks, onExpandedTasksChange, renderTask, onWrap, onDeleteCell, hasCell = false }: {
  route: AdvancedModelingRoute; onChange(route: AdvancedModelingRoute): void; disabled?: boolean;
  expandedTasks?: readonly string[];
  onExpandedTasksChange?(tasks: string[]): void;
  renderTask?(task: PeriodicModelingTask | GeometryTransformTask, active: boolean): ReactNode;
  onWrap?(): void; onDeleteCell?(): void; hasCell?: boolean;
}) {
  const categoryLabel = route?.category === 'periodic' ? '周期建模' : '几何变换';
  const tasks = route?.category === 'periodic' ? periodicModelingTasks : geometryTransformTasks;
  const current = tasks.find(task => task.id === route?.task);
  const choices: SoftwareChoice<string>[] = tasks.map(task => ({
    id: task.id, symbol: task.title.slice(0, 1), label: task.title, action: '进入设置 →',
  }));
  return <div className="advanced-modeling-navigation ui-control-surface" data-testid="advanced-modeling-navigation">
    <nav className="breadcrumb" aria-label="高级建模导航">
      <button type="button" className="shared-input-action" disabled={disabled || !route} onClick={() => onChange(null)}>高级建模</button>
      {route && <><ChevronRight size={13}/><button type="button" className="shared-input-action" disabled={disabled || !route.task}
        onClick={() => onChange({ ...route, task: null })}>{categoryLabel}</button></>}
      {current && <><ChevronRight size={13}/><strong aria-current="page">{current.title}</strong></>}
    </nav>
    {!route ? <WorkflowContentCard title="高级建模" heading={false}>
      <SoftwareChooser choices={[
        { id: 'periodic', symbol: '晶', label: '周期建模', description: '晶胞、对称性、切面与周期结构整理。', action: '选择任务 →' },
        { id: 'geometry', symbol: '形', label: '几何变换', description: '位置、朝向、几何与原子整理。', action: '选择任务 →' },
      ] as const} title="选择分类" description="" ariaLabel="高级建模分类" testId="advanced-modeling-categories"
        disabled={disabled} onChoose={category => onChange({ category, task: null })}/>
    </WorkflowContentCard> : renderTask ? <div className="advanced-modeling-accordion">
      {route.category === 'periodic' && <div className="advanced-modeling-actions">
        <button type="button" className="shared-input-action" disabled={disabled || !hasCell} onClick={onWrap}>回卷晶胞</button>
        <button type="button" className="shared-input-action" disabled={disabled || !hasCell} onClick={onDeleteCell}>删除晶胞</button>
      </div>}
      {tasks.map(task => {
        const expanded = expandedTasks?.includes(task.id) ?? route.task === task.id;
        const active = route.task === task.id;
        const toggle = () => {
          const next = new Set(expandedTasks ?? (route.task ? [route.task] : []));
          if (expanded) next.delete(task.id); else {if(route.category==='periodic')next.clear();next.add(task.id);}
          onExpandedTasksChange?.([...next]);
          const chosen = expanded ? (active ? [...next].at(-1) ?? null : route.task) : task.id;
          onChange(route.category === 'periodic' ? { category: 'periodic', task: chosen as PeriodicModelingTask | null }
            : { category: 'geometry', task: chosen as GeometryTransformTask | null });
        };
        return <section key={task.id} className="advanced-modeling-function-card" data-active={active || undefined}>
          <header className="advanced-modeling-card-heading">
          <button type="button" className="advanced-modeling-function-toggle" aria-expanded={expanded}
            disabled={disabled} onClick={toggle}>{expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<span>{task.title}</span></button>
          {expanded && <button type="button" className="advanced-modeling-card-close" disabled={disabled} aria-label={`收起${task.title}`} onClick={toggle}>×</button>}
          </header>
          {expanded && <div className="advanced-modeling-function-body"
            onPointerDownCapture={() => { if (!active) onChange(route.category === 'periodic'
              ? { category: 'periodic', task: task.id as PeriodicModelingTask }
              : { category: 'geometry', task: task.id as GeometryTransformTask }); }}
            onFocusCapture={() => { if (!active) onChange(route.category === 'periodic'
              ? { category: 'periodic', task: task.id as PeriodicModelingTask }
              : { category: 'geometry', task: task.id as GeometryTransformTask }); }}>
            {renderTask(task.id, active)}
          </div>}
        </section>;
      })}
    </div> : !route.task ? <WorkflowContentCard title={categoryLabel} heading={false}>
      {route.category==='geometry'?[...new Set(geometryTransformTasks.map(task=>task.group))].map(group=><SoftwareChooser key={group}
        choices={choices.filter(choice=>geometryTransformTasks.find(task=>task.id===choice.id)?.group===group)} title={group} description="" ariaLabel={group} testId="advanced-modeling-task-group" disabled={disabled}
        onChoose={task=>onChange({category:'geometry',task:task as GeometryTransformTask})}/>):<SoftwareChooser choices={choices} title={categoryLabel} description="" ariaLabel={`${categoryLabel}任务`} testId="advanced-modeling-tasks"
        disabled={disabled} onChoose={task => onChange(route.category === 'periodic'
          ? { category: 'periodic', task: task as PeriodicModelingTask }
          : { category: 'geometry', task: task as GeometryTransformTask })}/>}
    </WorkflowContentCard> : null}
  </div>;
}
