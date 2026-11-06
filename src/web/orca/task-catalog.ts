import type { OrcaTask } from '../../core/orca';

export const ORCA_TASK_GROUPS = [
  { id: 'structure', label: '结构与能量' },
  { id: 'reaction', label: '反应与路径' },
  { id: 'excited', label: '激发态' },
  { id: 'property', label: '性质分析' },
  { id: 'dynamics', label: '分子动力学' },
] as const;
type Group = typeof ORCA_TASK_GROUPS[number]['id'];
export const ORCA_TASKS: { id: OrcaTask; group: Group; label: string; description: string; code: string; pending?: boolean }[] = [
  { id: 'sp', group: 'structure', label: '单点能', code: 'SP', description: '固定几何的能量与电子结构' },
  { id: 'opt', group: 'structure', label: '结构优化', code: 'Opt', description: '基态结构优化' },
  { id: 'freq', group: 'structure', label: '频率分析', code: 'Freq', description: '当前几何的振动频率' },
  { id: 'optfreq', group: 'structure', label: '优化＋频率', code: 'Opt + Freq', description: '优化后分析振动模式' },
  { id: 'scan', group: 'reaction', label: '势能面扫描', code: 'Scan', description: 'B/A/D 松弛扫描' },
  { id: 'ts', group: 'reaction', label: '过渡态优化＋频率', code: 'TS + Freq', description: 'OptTS 与最终频率' },
  { id: 'irc', group: 'reaction', label: '双向 IRC', code: 'IRC', description: '一个任务内向两侧追踪' },
  { id: 'neb', group: 'reaction', label: 'NEB', code: 'NEB', description: 'CI-NEB / NEB-TS、端点与可选过渡态初猜' },
  { id: 'td', group: 'excited', label: '激发态光谱', code: 'TD', description: 'TDDFT / TDA / sTD-DFT / sTDA' },
  { id: 'tdopt', group: 'excited', label: 'S/T 激发态结构', code: 'S/T Opt / Freq', description: '目标态优化、独立频率或优化+频率' },
  { id: 'esd', group: 'excited', label: 'ESD', code: '待开发', description: '', pending: true },
  { id: 'nmr', group: 'property', label: 'NMR', code: 'NMR', description: '屏蔽张量或耦合' },
  { id: 'stable', group: 'property', label: '波函数稳定性', code: 'Stable', description: '检查或优化轨道稳定性' },
  { id: 'bsse', group: 'property', label: 'BSSE', code: 'BSSE', description: '分片 Counterpoise 独立输入组' },
  { id: 'md', group: 'dynamics', label: '分子动力学', code: 'MD', description: '明确条件与可核对的重启资产' },
];
