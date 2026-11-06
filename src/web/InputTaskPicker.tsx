import type { ReactNode } from 'react';
import { InputTaskChoice } from './InputSettingsLayout';

export interface InputTaskChoiceItem<Id extends string=string> {
  id:Id;group:string;label:string;code:string;icon:ReactNode;disabled?:boolean;title?:string;testId?:string;
}
export interface InputTaskPickerProps<Id extends string=string> {
  groups:readonly {id:string;label:string}[];
  tasks:readonly InputTaskChoiceItem<Id>[];
  value:Id;
  onChange(value:Id):void;
  disabled?:boolean; ariaLabel?:string; title?:ReactNode; description?:ReactNode;
  capabilities?:Partial<Record<Id,boolean>>;
}

/** Layout only. Engine callers retain their catalogs, defaults and task transitions. */
export default function InputTaskPicker<Id extends string>({groups,tasks,value,onChange,disabled=false,ariaLabel,title,description,capabilities}:InputTaskPickerProps<Id>){
  return <div className="input-task-picker" aria-label={ariaLabel}>{title&&<h2>{title}</h2>}{description&&<p className="workflow-description">{description}</p>}{groups.map(group=><section key={group.id} className="task-category" aria-label={group.label}><h3>{group.label}</h3><div className="task-grid">{tasks.filter(task=>task.group===group.id).map(task=><InputTaskChoice key={task.id} label={task.label} code={task.code} icon={task.icon} selected={value===task.id} disabled={disabled||task.disabled||capabilities?.[task.id]===false} title={task.title} testId={task.testId} onSelect={()=>onChange(task.id)}/>)}</div></section>)}</div>;
}
