import type { GaussianSettings, JobRequest, MethodId, TaskId } from '../../core/types';
import { cleanStem } from '../../core/naming';
import { TASKS } from '../../core/tasks';
import { excitedOptimizationTitle, isExcitedOptimization } from '../../core/excited-state';
import { isXtb } from '../../core/xtb';
import { builderJobStructure } from '../../core/builder-integration';
import { linkedInputSourceSignature } from '../../modeling/application/input-source-signature';
import type { GuardedInputRequest } from '../../modeling/application/input-export-guard';

export function defaultTitle(name: string, task: TaskId, method?: MethodId, settings?: GaussianSettings): string {
  const stem = cleanStem(name);
  return stem[0].toUpperCase() + stem.slice(1) + ' - ' + (settings && isExcitedOptimization(settings) ? excitedOptimizationTitle(settings) : method && isXtb(method) && task === 'ts' ? 'transition state optimization' : (TASKS.find(item => item.id === task) ?? TASKS.find(item => item.id === 'opt')!).title);
}

export function jobSignature(request: JobRequest): string {
  return JSON.stringify([builderJobStructure(request.structure), request.settings, request.charge, request.multiplicity, request.electronicStateConfirmed, request.cores, request.memoryGB, request.resourcesConfirmed, request.name, request.title, request.frequencyConditionsConfirmed, request.files, linkedInputSourceSignature(request)]);
}

/** A replacement confirmation retains its captured lease; it never recaptures. */
export function gaussianReplacementConfirmation(prepared: GuardedInputRequest<JobRequest>, commit: (request: JobRequest) => void, onError: (message: string) => void) {
  return { title: '重新生成会替换手工编辑', text: '当前输入文本已修改。重新生成将使用已捕获的表单设置替换编辑器中的全部文本，是否继续？', label: '替换并重新生成', action: () => {
    try { prepared.assertCurrent(); commit(prepared.request); } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
  } };
}

/** Folding is display-only. Copy/download keep the complete validated formatter. */
export function foldPreviewCoordinates(text: string, atomCount: number): string {
  const lines = text.split('\n');
  const row = /^\s*[A-Z][a-z]?(?:\(Fragment=\d+\))?\s+(?:-1\s+)?[-+]?\d+(?:\.\d*)?(?:[EeDd][-+]?\d+)?\s+[-+]?\d+(?:\.\d*)?(?:[EeDd][-+]?\d+)?\s+[-+]?\d+(?:\.\d*)?(?:[EeDd][-+]?\d+)?\s*$/;
  const start = lines.findIndex(line => row.test(line));
  if (start < 0 || !atomCount) return text;
  let end = start; while (end < lines.length && row.test(lines[end])) end++;
  if (end - start !== atomCount) return text;
  return [...lines.slice(0, start), `<${atomCount} 个原子坐标已折叠，仅影响预览>`, ...lines.slice(end)].join('\n');
}
