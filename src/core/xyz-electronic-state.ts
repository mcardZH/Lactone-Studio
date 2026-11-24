import type { Structure } from './types';

/** An XYZ comment may mix attributes with prose. Only complete, consistent
 * integer attributes describe the source state. */
export function readXyzElectronicState(comment: string, structure: Structure): void {
  const values = { charge: [] as string[], multiplicity: [] as string[] };
  const attributes = /(?:^|[\s,;])([A-Za-z_]\w*)\s*=(?:\s*(?:"([^"]*)"|'([^']*)'|((?![A-Za-z_]\w*\s*=)[^\s,;"']+)))?/g;
  for (const match of comment.matchAll(attributes)) {
    const key = match[1].toLowerCase();
    if (key === 'charge') values.charge.push((match[2] ?? match[3] ?? match[4] ?? '').trim());
    else if (key === 'multiplicity' || key === 'mult') values.multiplicity.push((match[2] ?? match[3] ?? match[4] ?? '').trim());
  }
  for (const key of ['charge', 'multiplicity'] as const) {
    const raw = values[key];
    if (!raw.length) continue;
    const parsed = raw.map(token => /^[+-]?\d+$/.test(token) ? Number(token) : NaN);
    const first = parsed[0];
    if (Number.isSafeInteger(first) && (key === 'charge' || first >= 1) && parsed.every(value => value === first)) {
      structure[key] = first;
    } else {
      const label = key === 'charge' ? '总电荷' : '自旋多重度';
      structure.notes.push(`XYZ来源${label}无法确定，原注释值：${raw.map(token => JSON.stringify(token)).join('、')}。`);
    }
  }
}
