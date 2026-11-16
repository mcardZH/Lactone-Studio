import type { TwoDStereoSource } from '../../core/types';

/** Ketcher/Indigo KET labels, not a new absolute assignment. */
export function parseTwoDStereoLabel(value: unknown): { type: 'ABS' | 'AND' | 'OR'; id: string } | undefined {
  if (value === 'abs') return { type: 'ABS', id: 'abs' };
  if (typeof value !== 'string') return;
  const match = /^(and|&|or)([1-9]\d*)$/.exec(value);
  if (match) return { type: match[1] === 'or' ? 'OR' : 'AND', id: match[2] };
}

export function twoDStereoGroups(atoms: readonly {id: string; sourceProperties: Record<string, unknown>}[]): NonNullable<TwoDStereoSource['stereoGroups']> {
  const groups = new Map<string, NonNullable<TwoDStereoSource['stereoGroups']>[number]>();
  for (const atom of atoms) {
    const parsed = parseTwoDStereoLabel(atom.sourceProperties.stereoLabel);
    if (!parsed) continue;
    const key = `${parsed.type}:${parsed.id}`;
    const group = groups.get(key) ?? {...parsed, atomIds: []};
    group.atomIds.push(atom.id); groups.set(key, group);
  }
  return [...groups.values()];
}
