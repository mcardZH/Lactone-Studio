import { Atom, FlaskConical, Gauge, Layers, Waves } from 'lucide-react';
import type { OrcaTask } from '../../core/orca';
import { ORCA_TASK_GROUPS, ORCA_TASKS } from './task-catalog';
import InputTaskPicker from '../InputTaskPicker';

const ICONS = { sp: Gauge, opt: Atom, freq: Waves, optfreq: Layers };
export default function OrcaTaskPicker({ value, onChange, taskAllowed }: { value: OrcaTask; onChange: (task: OrcaTask) => void; taskAllowed?:(task:OrcaTask)=>boolean }) {
  return <InputTaskPicker groups={ORCA_TASK_GROUPS} value={value} onChange={onChange} tasks={ORCA_TASKS.map(task=>{
    const Icon = ICONS[task.id as keyof typeof ICONS] ?? FlaskConical;
    return {id:task.id,group:task.group,label:task.label,code:task.code,icon:<Icon size={22} strokeWidth={1.6}/>,disabled:task.pending||taskAllowed?.(task.id)===false,testId:`orca-task-${task.id}`};
  })}/>;
}
