export type ReferenceExtension = 'chk' | 'xyz' | 'gbw' | 'hess';
export interface ReferenceFileSelection { name: string; path?: string }

export function referenceBasename(value: string): string {
  return value.trim().split(/[\\/]/).at(-1) ?? '';
}
export function absoluteReferencePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/]|\/)/.test(value.trim());
}
export function selectedReference(selection: ReferenceFileSelection, extensions: readonly ReferenceExtension[]): ReferenceFileSelection {
  const name = referenceBasename(selection.name);
  if (!name || !extensions.some(extension => name.toLowerCase().endsWith('.' + extension)))
    throw new Error(`请选择 ${extensions.map(extension => '.' + extension).join(' / ')} 来源文件。`);
  const path = selection.path && absoluteReferencePath(selection.path) ? selection.path : undefined;
  return { name, ...(path ? { path } : {}) };
}
export function checkpointNameCollision(source: string, destination: string): boolean {
  return !!source.trim() && referenceBasename(source).toLowerCase() === referenceBasename(destination).toLowerCase();
}
