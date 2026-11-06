import { normalizeDoi } from './identity';
import type { CitationRecord, CitationRegistry } from './types';

const text = (value?: string) => Boolean(value?.trim());
const url = (value?: string) => Boolean(value && /^https?:\/\/[^\s]+$/i.test(value));
const date = (value?: string) => Boolean(value && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value)));
export function missingCitationFields(record: CitationRecord): string[] {
  const missing: string[] = [];
  if (!text(record.title)) missing.push('title');
  if (!record.authors.length || record.authors.some(a => !text(a.literal) && !text(a.family))) missing.push('authors');
  if (record.kind === 'article' || record.kind === 'preprint' || record.kind === 'chapter' || record.kind === 'book') {
    if (!Number.isInteger(record.year) || record.year! < 1000 || record.year! > 9999) missing.push('year');
    if (record.kind === 'article' && !text(record.journal)) missing.push('journal');
    if (record.kind === 'preprint' && !text(record.publisher)) missing.push('preprint server/publisher');
    if (record.kind === 'chapter') {if(!text(record.bookTitle))missing.push('bookTitle');if(!text(record.publisher))missing.push('publisher');}
    if (record.kind === 'book' && !text(record.publisher)) missing.push('publisher');
  }
  const doi = normalizeDoi(record.doi);
  if (doi && !/^10\.\d{4,9}\/\S+$/i.test(doi)) missing.push('valid DOI');
  if (record.url && !url(record.url)) missing.push('valid URL');
  if (!record.evidence.some(e => ['publisher', 'doi', 'official', 'project'].includes(e.kind)
    && (url(e.url) || (e.kind === 'project' && text(e.locator))) && date(e.checkedAt))) missing.push('verification evidence');
  // A legitimate official citation does not require a DOI.
  if (!doi && !url(record.url) && !record.evidence.some(e => url(e.url) || e.kind === 'project' && text(e.locator))) missing.push('DOI or official source');
  return missing;
}
export function validateCitationRegistry(registry: CitationRegistry): string[] {
  const issues: string[] = [];
  if (registry.schemaVersion !== 1) issues.push('引用库schemaVersion须为1。');
  const ids = new Set<string>();
  for (const r of registry.records) {
    if (!r.id.trim() || ids.has(r.id)) issues.push(`引用记录ID为空或重复：${r.id}`);
    ids.add(r.id);
    if (!['article', 'book', 'chapter', 'preprint', 'software', 'dataset', 'web'].includes(r.kind)) issues.push(`引用类型无效：${r.id}`);
    if (!['verified', 'pending', 'unverified'].includes(r.status)) issues.push(`引用核验状态无效：${r.id}`);
    if (r.doi && !/^10\.\d{4,9}\/\S+$/i.test(normalizeDoi(r.doi)!)) issues.push(`DOI格式无效：${r.id}`);
    if (r.status === 'verified') for (const field of missingCitationFields(r)) issues.push(`已核实记录${r.id}缺少${field}。`);
  }
  const mappings = new Set<string>();
  for (const m of registry.mappings) {
    if (!m.id.trim() || mappings.has(m.id)) issues.push(`映射ID为空或重复：${m.id}`);
    mappings.add(m.id);
    if (!m.feature.trim() || !m.reasonZh.trim() || !m.citationIds.length) issues.push(`引用映射不完整：${m.id}`);
    if (!['scientific', 'runtime', 'data'].includes(m.role)) issues.push(`映射角色无效：${m.id}`);
    if (m.versionPrefix !== undefined && !/^\d+(?:\.\d+){0,2}$/.test(m.versionPrefix)) issues.push(`映射版本前缀须为固定数字版本：${m.id}`);
    if (m.versionContains !== undefined && (!m.versionContains.trim() || /[\u0000-\u001f]/.test(m.versionContains))) issues.push(`映射版本文本须为非空固定文本：${m.id}`);
    if (m.sourceId !== undefined && !m.sourceId.trim()) issues.push(`映射来源ID不能为空：${m.id}`);
    for (const id of m.citationIds) if (!ids.has(id)) issues.push(`映射${m.id}引用不存在的记录${id}。`);
    if (new Set(m.citationIds).size !== m.citationIds.length) issues.push(`映射重复引用同一记录：${m.id}`);
  }
  return issues;
}
