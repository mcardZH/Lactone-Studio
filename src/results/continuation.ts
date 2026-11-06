import { defaultSettings } from '../core/gaussian';
import { deriveInheritedSettings } from '../core/gaussian-source';
import { inheritOrcaSourceLevel } from '../core/input-source-inheritance';
import { createOrcaCommonSettings } from '../core/orca/common';
import type { OrcaSettings } from '../core/orca/types';
import type { GaussianSettings, Structure } from '../core/types';

export interface ResultInputIntent {
  engine: 'gaussian' | 'orca'; task: 'irc';
  gaussian?: GaussianSettings; orca?: OrcaSettings;
  notices: string[];
}
/** Prepare a new input owner only; never reuse checkpoints, Hessians, or submit a job. */
export function prepareIrcIntent(structure: Structure, engine: 'gaussian' | 'orca'): ResultInputIntent {
  if (!structure.atoms.length || structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) throw new Error('IRC起点必须是完整有效结构。');
  const notices = ['当前帧已复制为新的 IRC 输入模型；请核对 TS 模式、方法、基组、溶剂、电荷/多重度和数值条件。未关联检查点/Hessian，也未运行计算。'];
  if (engine === 'gaussian') {
    const source = structure.gaussianSource;
    if (!source?.settings.method) throw new Error('此结果缺少可可靠继承的 Gaussian 计算级别；请先提取模型并在输入页核对来源。');
    const settings = deriveInheritedSettings(source, defaultSettings('irc'), 'irc');
    const blocking = settings.inheritanceIssues?.filter(issue => issue.severity !== 'warning' && ['level', 'method', 'basis', 'ecp', 'dispersion', 'solvent', 'route'].includes(issue.field ?? '')) ?? [];
    if (blocking.length) throw new Error('无法完整继承 IRC 条件：' + blocking.map(issue => issue.message).join('；'));
    settings.taskOptions!.irc.confirmed = false;
    notices.push(...(settings.inheritanceIssues ?? []).map(issue => issue.message));
    return { engine, task: 'irc', gaussian: settings, notices };
  }
  const source = structure.orcaSource;
  if (!source) throw new Error('此结果没有可继承的 ORCA 输入回显；请先提取模型并核对来源级别。');
  const inherited = inheritOrcaSourceLevel(source, createOrcaCommonSettings('irc'));
  if (!inherited.applied) throw new Error('当前输入器不能准确继承此 ORCA 级别：' + inherited.issues.map(issue => issue.message).join('；'));
  // ORCA's current writer owns its reviewed numerical defaults. The source's
  // unmatched SCF/grid/auxiliary choices must not disappear behind a success label.
  const unresolved = inherited.issues.filter(issue => issue.severity !== 'warning' && issue.field !== 'freeze' && issue.field !== 'task');
  if (unresolved.length) throw new Error('此 ORCA 输入还含未能自动移交的条件：' + unresolved.map(issue => issue.message).join('；'));
  notices.push('已继承可表达的计算级别；SCF/网格及其它数值条件须对照保留的输入回显核对，未声称完整复制。');
  inherited.settings.ircStartEvidence = undefined;
  return { engine, task: 'irc', orca: inherited.settings, notices };
}
