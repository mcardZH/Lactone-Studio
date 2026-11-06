import type { AdvancedSettings, TaskId } from './types';
export function defaultAdvanced(task: TaskId,frequency=false): AdvancedSettings {
  return { scfAlgorithm:'default',noVarAcc:false,noIncFock:false,fermi:false,noDIIS:false,vshift:null,scfMaxCycle:null,maxConventional:null,optConvergence:['opt','scan','constrained','tdopt','t1opt'].includes(task)&&!(['tdopt','t1opt'].includes(task)&&frequency) ? 'loose' : 'default',maxStep:null,optMaxCycles:null };
}
export const SCF_OPTIONS = [
  { key:'noVarAcc',name:'NoVarAcc',description:'关闭SCF初期降低积分精度；弥散函数相关困难时可尝试，可能增加初期耗时。' },
  { key:'noIncFock',name:'NoIncFock',description:'关闭增量Fock矩阵构建；用于相关收敛困难，不保证有效。' },
  { key:'fermi',name:'Fermi',description:'初期占据数展宽，可用于小能隙困难；程序会配合部分辅助策略。' },
  { key:'noDIIS',name:'NoDIIS',description:'关闭DIIS外推；只在怀疑外推导致异常时尝试，可能更慢。' },
] as const;
export const SCF_REFERENCE = [
  { title:'先用较小基组获得初猜',text:'保持电子数、电荷/多重度及ECP兼容，在独立任务获得收敛波函数，再回目标级别Guess=Read。不是当前输入自动换基组。' },
  { title:'更换初猜或先用其它条件',text:'不同泛函、溶剂或轻微几何调整可能帮助得到初猜；这些是多步策略，需另行设置，不勾选就自动改变当前任务。' },
  { title:'先检查化学结构与电子态',text:'核对异常短距离、缺氢/截断边界、总电荷、多重度和基组/ECP。收敛困难不总是算法问题。' },
  { title:'QC/XQC不是强制收敛',text:'它们仍可能失败；收敛也不自动证明目标电子态正确。必要时再单独检查波函数稳定性。' },
];
