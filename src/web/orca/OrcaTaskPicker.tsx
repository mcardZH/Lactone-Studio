import type { OrcaTask } from '../../core/orca';
import { ORCA_TASKS } from './task-catalog';
import InputTaskPicker from '../InputTaskPicker';
import { WORKFLOW_TASK_GROUPS, workflowTaskDisplay } from '../task-choice-presentation';

export default function OrcaTaskPicker({ value, onChange, taskAllowed }: { value: OrcaTask; onChange: (task: OrcaTask) => void; taskAllowed?:(task:OrcaTask)=>boolean }) {
  return <InputTaskPicker groups={WORKFLOW_TASK_GROUPS} value={value} onChange={onChange} tasks={ORCA_TASKS.map(task=>({
    id:task.id,...workflowTaskDisplay(task,'input'),disabled:task.pending||taskAllowed?.(task.id)===false,testId:`orca-task-${task.id}`,
  }))}/>;
}
