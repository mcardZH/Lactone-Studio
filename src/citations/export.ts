import { normalizeDoi, stableToken } from './identity';
import type { CitationAuthor, CitationCollection, CitationExportRow, CitationRecord, CollectedCitation } from './types';

const unique = (values: readonly (string | undefined)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))].join('; ');
function initials(given?: string): string { return (given || '').split(/[\s-]+/).filter(Boolean).map(part => `${[...part][0]}.`).join(' '); }
export function formatCitationAuthor(author: CitationAuthor): string { return author.literal || `${author.family || ''}${author.given ? `, ${initials(author.given)}` : ''}`; }
/** ACS-like plain text with supplied journal abbreviations; never invent abbreviations. */
export function formatAcsCitation(record: CitationRecord): string {
  const authors = record.authors.map(formatCitationAuthor).join('; ');
  const pieces = [authors ? `${authors}${authors.endsWith('.') ? '' : '.'}` : '', `${record.title.replace(/\.$/, '')}.`];
  if (record.kind === 'article') {
    const journal = record.journalAbbreviation || record.journal;
    const details = [record.year, record.volume ? `${record.volume}${record.issue ? ` (${record.issue})` : ''}` : '', record.pages || record.articleNumber].filter(Boolean).join(', ');
    if (journal || details) pieces.push([journal, details].filter(Boolean).join(' ') + '.');
  } else if(record.kind==='book') {
    const details=[record.volume?`Vol. ${record.volume}`:'',record.publisher,record.year].filter(Boolean).join('; ');
    if(details)pieces.push(details+'.');
  } else if(record.kind==='chapter') {
    const editors=record.editors?.map(formatCitationAuthor).join('; ');
    pieces.push([record.bookTitle?`In ${record.bookTitle}`:'',editors?`${editors}, Eds.`:'',[record.series,record.volume].filter(Boolean).join(' '),[record.publisher,record.year].filter(Boolean).join(', '),record.pages?`pp ${record.pages}`:''].filter(Boolean).join('; ')+'.');
  } else {
    const details = [record.version ? `Version ${record.version}` : '', record.publisher, record.year].filter(Boolean).join('; ');
    if (details) pieces.push(`${details}.`);
  }
  if (record.doi) pieces.push(`https://doi.org/${normalizeDoi(record.doi)}`);
  else if (record.url) pieces.push(record.url);
  return pieces.filter(Boolean).join(' ');
}
function entryRow(entry: CollectedCitation, section: CitationExportRow['section']): CitationExportRow {
  const r = entry.record;
  return { section, key: entry.key, role: unique(entry.usages.map(u => u.role)), status: r.status,
    title: r.title, authors: r.authors.map(formatCitationAuthor).join('; '), year: r.year?.toString() || '',
    citation: formatAcsCitation(r), doi: normalizeDoi(r.doi) || '', url: r.url || '', version: unique([r.version, ...entry.usages.map(u => u.version)]),bookTitle:r.bookTitle||'',editors:r.editors?.map(formatCitationAuthor).join('; ')||'',series:r.series||'',
    methods: unique(entry.usages.map(u => u.methodSummaryZh)), purpose: unique(entry.usages.map(u => u.purpose)),
    usages: JSON.stringify(entry.usages), evidence: JSON.stringify(r.evidence), missing: entry.missing.join('; '),
    notes: unique([r.note, ...entry.reasons, entry.userDecision?.note, section === 'candidate' ? '待核实，未纳入已核实主表' : '', section === 'excluded' ? '用户排除；原建议与来源保留' : '', ...entry.usages.filter(u => u.kind === 'generated-input').map(() => '输入准备；无运行证据')]) };
}
export function citationExportRows(collection: CitationCollection): CitationExportRow[] {
  const rows = [
    ...collection.verified.map(e => entryRow(e, 'verified')),
    ...collection.candidates.map(e => entryRow(e, 'candidate')),
    ...collection.excluded.map(e => entryRow(e, 'excluded')),
  ];
  const issues = new Map([...collection.unknown, ...collection.issues].map(issue => [issue.id, issue]));
  for (const issue of issues.values()) rows.push({ section: 'unknown', key: issue.id, role: '', status: issue.code,
    title: issue.fact ? `待补充引用：${issue.fact.feature}${issue.fact.method ? ` / ${issue.fact.method}` : ''}` : '引用库待处理项',
    authors: '', year: '', citation: '', doi: '', url: '', version: issue.fact?.version || '',bookTitle:'',editors:'',series:'', methods: issue.fact?.method || '',
    purpose: issue.fact?.purpose || '', usages: issue.fact ? JSON.stringify(issue.fact) : '', evidence: issue.fact ? JSON.stringify(issue.fact.evidence) : '', missing: issue.message, notes: issue.recordId || '' });
  return rows;
}
const csvColumns: readonly (keyof CitationExportRow)[] = ['section', 'key', 'role', 'status', 'title', 'authors', 'year', 'citation', 'doi', 'url', 'version', 'methods', 'purpose', 'usages', 'evidence', 'missing', 'notes','bookTitle','editors','series'];
/** Quote CSV syntax AND neutralize spreadsheet formula payloads. */
export function escapeCitationCsv(value: string): string {
  const safe = /^[\s\uFEFF]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function exportCitationsCsv(collection: CitationCollection, options: { bom?: boolean } = {}): string {
  return (options.bom === false ? '' : '\uFEFF') + [csvColumns.join(','), ...citationExportRows(collection).map(row => csvColumns.map(c => escapeCitationCsv(row[c])).join(','))].join('\r\n') + '\r\n';
}
function bibEscape(value: string): string {
  const escapes: Record<string, string> = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&', '_': '\\_', '#': '\\#', '$': '\\$', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
  return value.replace(/[\\{}%&_#$~^]/g, char => escapes[char]).replace(/[\r\n\u0000-\u001f]+/g, ' ');
}
function bibAuthor(author: CitationAuthor): string {
  return author.literal ? `{${bibEscape(author.literal)}}` : [bibEscape(author.family || ''), author.given && bibEscape(author.given)].filter(Boolean).join(', ');
}
const bibKey = (key: string) => `es_${stableToken(key)}`;
function recordForRow(collection: CitationCollection, row: CitationExportRow): CitationRecord | undefined {
  return [...collection.verified, ...collection.candidates, ...collection.excluded].find(e => e.key === row.key)?.record;
}
function exportNote(row: CitationExportRow): string {
  return unique([`Ester Studio section: ${row.section}; status: ${row.status}; role: ${row.role}`, row.methods, row.purpose, row.missing, row.notes, `Usage: ${row.usages}`, `Evidence: ${row.evidence}`]);
}
export function exportCitationsBibtex(collection: CitationCollection): string {
  return citationExportRows(collection).map(row => {
    const r = recordForRow(collection, row);
    const fields: [string, string | undefined][] = [
      ['title', r?.title || row.title], ['author', r ? r.authors.map(bibAuthor).join(' and ') : undefined],
      ['year', r?.year?.toString()], ['journal', r?.journalAbbreviation || r?.journal], ['volume', r?.volume], ['number', r?.issue],
      ['pages', r?.pages?.replace(/[–—]/g, '--')], ['eid', r?.articleNumber], ['doi', normalizeDoi(r?.doi)], ['url', r?.url], ['publisher', r?.publisher], ['version', r?.version],
      ['booktitle',r?.bookTitle],['editor',r?.editors?.map(bibAuthor).join(' and ')],['series',r?.series],
      ['keywords', `ester-studio:${row.section}`], ['note', exportNote(row)],
    ];
    return `% Ester Studio: ${row.section}\n@${r?.kind === 'article' ? 'article' : r?.kind === 'book' ? 'book' : r?.kind === 'chapter' ? 'incollection' : r?.kind === 'preprint' ? 'unpublished' : 'misc'}{${bibKey(row.key)},\n${fields.filter(([, v]) => v !== undefined && v !== '').map(([name, value]) => `  ${name} = {${name === 'author'||name==='editor' ? value : bibEscape(value!)}},`).join('\n')}\n}`;
  }).join('\n\n') + '\n';
}
const risText = (value: string) => value.replace(/[\r\n\u0000-\u001f]+/g, ' ');
export function exportCitationsRis(collection: CitationCollection): string {
  return citationExportRows(collection).map(row => {
    const r = recordForRow(collection, row);
    const fields: [string, string | undefined][] = [
      ['TY', r?.kind === 'article' ? 'JOUR' : r?.kind === 'book' ? 'BOOK' : r?.kind === 'chapter' ? 'CHAP' : r?.kind === 'preprint' ? 'UNPB' : r?.kind === 'software' ? 'COMP' : r?.kind === 'dataset' ? 'DATA' : 'GEN'],
      ['ID', bibKey(row.key)], ['TI', r?.title || row.title],
      ...(r?.authors || []).map(a => ['AU', a.literal || [a.family, a.given].filter(Boolean).join(', ')] as [string, string]),
      ...(r?.editors||[]).map(a=>['A2',a.literal||[a.family,a.given].filter(Boolean).join(', ')] as [string,string]),['T3',r?.series],
      ['PY', r?.year?.toString()], ['JO', r?.journal], ['JA', r?.journalAbbreviation], ['VL', r?.volume], ['IS', r?.issue],
      ['SP', r?.pages?.split(/--|[–—-]/)[0] || r?.articleNumber], ['EP', r?.pages?.split(/--|[–—-]/)[1]], ['DO', normalizeDoi(r?.doi)], ['UR', r?.url],
      ['PB', r?.publisher], ['T2',r?.kind === 'chapter'?r.bookTitle:r?.kind === 'preprint' ? r.publisher : undefined], ['ET', r?.version], ['KW', `ester-studio:${row.section}`], ['N1', exportNote(row)], ['ER', ''],
    ];
    return fields.filter(([, value]) => value !== undefined).map(([tag, value]) => `${tag}  - ${risText(value!)}`).join('\r\n');
  }).join('\r\n\r\n') + '\r\n';
}
