import { Atom, FlaskConical, Gauge, Layers, Waves, type LucideIcon } from 'lucide-react';
import { TASK_GROUPS } from '../core/tasks';

export const WORKFLOW_TASK_GROUPS = [...TASK_GROUPS, { id: 'dynamics', label: '分子动力学' }] as const;

type TaskDisplay = { label: string; code: string; icon?: LucideIcon };
const commonTaskDisplay: Readonly<Partial<Record<string, TaskDisplay>>> = {
  trajectory: { label: '结构 / 轨迹', code: 'XYZ' },
  sp: { label: '单点能', code: 'SP', icon: Gauge },
  opt: { label: '结构优化', code: 'Opt', icon: Atom },
  freq: { label: '振动分析', code: 'Freq', icon: Waves },
  optfreq: { label: '优化 + 振动分析', code: 'Opt + Freq', icon: Layers },
  scan: { label: '势能面扫描', code: 'Scan' },
  ts: { label: '过渡态', code: 'TS' },
  irc: { label: 'IRC 反应路径', code: 'IRC' },
  neb: { label: 'NEB 路径', code: 'NEB' },
  td: { label: '垂直激发 / 光谱', code: 'TD / TDA' },
  tdopt: { label: 'S/T 激发态结构', code: 'S/T Opt / Freq' },
  nmr: { label: 'NMR 屏蔽 / 耦合', code: 'NMR' },
  stable: { label: '波函数稳定性', code: 'Stable' },
  bsse: { label: 'BSSE 校正', code: 'Counterpoise' },
  md: { label: '分子动力学', code: 'MD' },
};
const inputCombinations: Readonly<Partial<Record<string, TaskDisplay>>> = {
  ts: { label: '过渡态搜索＋频率', code: 'TS + Freq' },
  irc: { label: '双向 IRC', code: 'IRC' },
};

/** Presentation only. The caller's inventory and availability remain authoritative. */
export function workflowTaskDisplay(task: { id: string; group: string; label: string; code: string }, scene: 'input' | 'results') {
  const key = task.id === 'stability' ? 'stable' : task.id;
  const common = commonTaskDisplay[key];
  const combined = scene === 'input' ? inputCombinations[key] : undefined;
  const display = combined ?? common ?? task;
  const Icon = combined?.icon ?? common?.icon ?? FlaskConical;
  const group = task.group === 'reaction' ? 'path' : task.group === 'property' ? 'properties' : task.group;
  return { group, label: display.label, code: display.code, icon: <Icon size={22} strokeWidth={1.6}/> };
}
