import type { OrcaAsset, OrcaOutputFile } from '../../core/orca';
import type { ScientificSourceFile } from '../../results/input-file';

/** Sources carry real bytes or generated text, never an unverified local path. */
export type ExternalInputDependencySource =
  | { kind: 'generated-text'; text: string }
  | { kind: 'file'; file: File }
  | { kind: 'scientific-source'; file: ScientificSourceFile };

export interface ExternalInputDependency {
  name: string;
  role: 'structure' | 'dependency';
  source: ExternalInputDependencySource;
}

/** Presentation-to-task-system handoff. Resource/scientific inspection belongs to the host. */
export interface ExternalInputDraft {
  engineId: 'gaussian' | 'orca';
  inputName: string;
  finalInputText: string;
  suggestedName: string;
  taskKind?: string;
  formula?: string;
  dependencies: ExternalInputDependency[];
}

export type SubmitExternalInput = (draft: ExternalInputDraft) => void | Promise<void>;

export function gaussianExternalInputDraft(finalInputText: string, name: string): ExternalInputDraft {
  if (!finalInputText.trim()) throw new Error('输入文本为空，请先生成或填写输入。');
  const inputName = /\.(?:gjf|com)$/i.test(name) ? name : `${name || 'gaussian_input'}.gjf`;
  // Form fields may no longer describe hand-edited text. Do not copy their task/resources/formula.
  return { engineId: 'gaussian', inputName, finalInputText, suggestedName: inputName.replace(/\.[^.]+$/, ''), dependencies: [] };
}

/** Multiple variants require an explicit main-input selection; a companion is never a job. */
export function selectOrcaMainInput(files: readonly OrcaOutputFile[], selectedIndex: number): OrcaOutputFile | undefined {
  const inputs = files.filter(file => file.role === 'input' && /\.inp$/i.test(file.name));
  if (inputs.length === 1) return inputs[0];
  const selected = files[selectedIndex];
  return selected?.role === 'input' && /\.inp$/i.test(selected.name) ? selected : undefined;
}

export function orcaExternalInputDraft(
  files: readonly OrcaOutputFile[], selectedIndex: number,
  referencedAssets: readonly OrcaAsset[] = [], binaryFiles: ReadonlyMap<string, File> = new Map(),
): ExternalInputDraft {
  const input = selectOrcaMainInput(files, selectedIndex);
  if (!input) throw new Error('请选择一个主 .inp 文件后逐文件提交。');
  if (!input.text.trim()) throw new Error('主输入文本为空，请先生成输入。');
  const dependencies: ExternalInputDependency[] = files.filter(file => file.role !== 'input').map(file => ({
    name: file.name, role: file.role as 'structure' | 'dependency', source: { kind: 'generated-text', text: file.text },
  }));
  for (const asset of referencedAssets) {
    if (dependencies.some(dependency => dependency.name.toLowerCase() === asset.name.toLowerCase())) continue;
    const file = binaryFiles.get(asset.id);
    if (file) dependencies.push({ name: asset.name, role: 'dependency', source: { kind: 'file', file } });
    // A named GBW without a retained File remains missing for the host to report.
  }
  return { engineId: 'orca', inputName: input.name, finalInputText: input.text,
    suggestedName: input.name.replace(/\.inp$/i, ''), dependencies };
}
