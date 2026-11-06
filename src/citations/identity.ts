import type { CitationRecord } from './types';

export function normalizeDoi(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  let doi = value.trim().replace(/^doi\s*:\s*/i, '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  try { doi = decodeURIComponent(doi); } catch { /* Preserve malformed input for validation. */ }
  return doi.trim().toLowerCase();
}
export function normalizeSelector(value?: string): string { return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' '); }
export function citationKey(record: CitationRecord): string {
  const doi = normalizeDoi(record.doi);
  if (doi) return `doi:${doi}`;
  const identity = normalizeSelector(record.identity) || normalizeSelector(record.url)?.replace(/\/$/, '') || normalizeSelector(record.title);
  if (record.kind === 'software' || record.kind === 'dataset') return `${record.kind}:${identity}${record.version ? `@${normalizeSelector(record.version)}` : ''}`;
  return `${record.kind}:${identity}|${record.year ?? ''}|${record.authors.map(a => normalizeSelector(a.literal || a.family)).join(';')}`;
}
export function stableToken(value: string): string {
  let hash = 2166136261;
  for (const char of value) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
}
