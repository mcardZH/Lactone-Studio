import { citationKey, normalizeSelector, stableToken } from './identity';
import { missingCitationFields, validateCitationRegistry } from './registry';
import {academicCitationFact} from './academic-scope';
import { applicationVersionNote, displayApplicationVersion } from '../application-version';
import type { CitationCollection, CitationFact, CitationIssue, CitationMapping, CitationRecord, CitationUsage, CollectedCitation, CollectCitationsOptions } from './types';

function matches(mapping: CitationMapping, fact: CitationFact): boolean {
  const prefix=mapping.versionPrefix;
  const version=fact.version?.match(/(?:^|[^\d.])(\d+(?:\.\d+)*)(?![\d.])/)?.[1];
  return normalizeSelector(mapping.feature) === normalizeSelector(fact.feature)
    && (mapping.method === undefined || normalizeSelector(mapping.method) === normalizeSelector(fact.method))
    && (mapping.software === undefined || normalizeSelector(mapping.software) === normalizeSelector(fact.software))
    && (mapping.sourceId === undefined || mapping.sourceId === fact.sourceId)
    && (mapping.versionContains === undefined || Boolean(mapping.versionContains.trim() && fact.version?.toLowerCase().includes(mapping.versionContains.toLowerCase())))
    && (prefix === undefined || /^\d+(?:\.\d+){0,2}$/.test(prefix) && Boolean(version && (version === prefix || version.startsWith(prefix+'.'))));
}
function factIdentity(fact: CitationFact): string {
  return JSON.stringify([fact.documentId, fact.id, fact.sourceId, fact.jobId, fact.frameId, fact.taskId,
    fact.stage, fact.kind, fact.feature, fact.method, fact.software, fact.version]);
}
export function createSyStudioCitation(version: string): CitationRecord {
  const releaseNote = applicationVersionNote(version);
  return { id: 'sy-studio', kind: 'software', identity: 'sy-studio', title: 'Ester Studio',
    authors: [{ family: 'Zhang', given: 'Zixuan' }], version: displayApplicationVersion(version), status: 'verified',
    publisher: 'Zixuan Zhang', evidence: [{ kind: 'project', locator: 'Ester Studio LICENSE.txt and package.json', checkedAt: '2026-10-29', note: 'Author: Zixuan Zhang; ddwz@sciyue.cn' },...(releaseNote?[{kind:'project' as const,locator:'package.json version/displayVersion/releaseChannel',checkedAt:'2026-10-30',note:releaseNote}]:[])],
    methodSummaryZh: '本地计算化学建模、输入准备及结果分析工作台。', note: ['Contact: ddwz@sciyue.cn', releaseNote].filter(Boolean).join('; ') };
}
const rank = (record: CitationRecord) => ({ verified: 3, pending: 2, unverified: 1 })[record.status] * 100 - missingCitationFields(record).length;
function conflicts(a: CitationRecord, b: CitationRecord): boolean {
  const canonical = (v: string) => normalizeSelector(v).replace(/[^\p{L}\p{N}]/gu, '');
  return a.status === 'verified' && b.status === 'verified'
    && ((Boolean(a.title && b.title) && canonical(a.title) !== canonical(b.title)) || Boolean(a.year && b.year && a.year !== b.year));
}
export function collectCitations(options: CollectCitationsOptions): CitationCollection {
  const { registry, decisions } = options;
  const result: CitationCollection = { verified: [], candidates: [], unknown: [], excluded: [], issues: [] };
  const issue = (value: CitationIssue) => { result.issues.push(value); if (value.fact) result.unknown.push(value); };
  for (const [index, message] of validateCitationRegistry(registry).entries()) issue({ id: `registry:${index}`, code: 'registry', message });
  const records = new Map<string, CitationRecord>();
  for (const record of [...registry.records, ...(decisions?.records ?? [])]) {
    if (records.has(record.id)) { issue({ id: `duplicate:${record.id}`, code: 'registry', recordId: record.id, message: `补录记录ID与已有记录冲突，保留原记录：${record.id}` }); continue; }
    records.set(record.id, record);
  }
  const collected = new Map<string, CollectedCitation>();
  function add(record: CitationRecord, usage: CitationUsage) {
    const key = citationKey(record);
    let entry = collected.get(key);
    if (!entry) { entry = { key, record, recordIds: [], usages: [], missing: [], reasons: [] }; collected.set(key, entry); }
    if (conflicts(entry.record, record)) {
      const message = `同一引用身份的已核实书目存在冲突：${entry.record.id} / ${record.id}`;
      if (!entry.reasons.includes(message)) { entry.reasons.push(message); issue({ id: `conflict:${key}`, code: 'conflict', recordId: record.id, message }); }
    }
    if (rank(record) > rank(entry.record)) entry.record = record;
    if (!entry.recordIds.includes(record.id)) entry.recordIds.push(record.id);
    if (!entry.usages.some(u => u.id === usage.id)) entry.usages.push(usage);
  }
  const facts = options.facts.filter(f => academicCitationFact(f) && f.retained !== false && f.kind !== 'preview' && f.kind !== 'selection'
    && (!options.scope?.documentId || f.documentId === options.scope.documentId));
  for (const fact of facts) {
    if (!fact.evidence.some(e => e.locator.trim())) {
      issue({ id: `evidence:${factIdentity(fact)}`, code: 'missing-evidence', fact, message: '此项缺少可靠来源或操作证据，未推定已使用的方法。' }); continue;
    }
    const mappings = registry.mappings.filter(m => matches(m, fact));
    if (!mappings.length) issue({ id: `unmapped:${factIdentity(fact)}`, code: 'unmapped', fact, message: `尚无已审核引用映射：${fact.feature}${fact.method ? ` / ${fact.method}` : ''}` });
    for (const mapping of mappings) for (const id of mapping.citationIds) {
      const record = records.get(id);
      if (!record) { issue({ id: `record:${factIdentity(fact)}:${id}`, code: 'missing-record', fact, recordId: id, message: `映射${mapping.id}缺少书目${id}。` }); continue; }
      add(record, {
        id: JSON.stringify([factIdentity(fact), mapping.id, citationKey(record)]), factId: fact.id, mappingId: mapping.id,
        documentId: fact.documentId, sourceId: fact.sourceId, jobId: fact.jobId, frameId: fact.frameId, taskId: fact.taskId,
        kind: fact.kind, feature: fact.feature, method: fact.method, software: fact.software, version: fact.version,
        stage: fact.stage, role: mapping.role, reasonZh: mapping.reasonZh, purpose: fact.purpose || mapping.reasonZh,
        methodSummaryZh: mapping.methodSummaryZh || record.methodSummaryZh || '', evidence: fact.evidence,
      });
    }
  }
  for (const [index, addition] of (decisions?.additions ?? []).entries()) {
    if (options.scope?.documentId && addition.documentId !== options.scope.documentId) continue;
    const record = records.get(addition.recordId);
    if (!record) { issue({ id: `manual:${index}`, code: 'missing-record', recordId: addition.recordId, message: `用户补录引用不存在：${addition.recordId}` }); continue; }
    add(record, { id: `manual:${index}:${record.id}`, factId: `manual:${index}`, mappingId: 'user', documentId: addition.documentId || '', kind: 'data-source', feature: 'user-reference', role: record.kind === 'dataset' ? 'data' : 'scientific', reasonZh: addition.note || '用户补录', purpose: addition.purpose, methodSummaryZh: record.methodSummaryZh || '', evidence: [{ kind: 'user', locator: '用户补录', detail: addition.note }] });
  }
  if (options.softwareVersion && (facts.length || decisions?.additions?.length)) {
    const record = createSyStudioCitation(options.softwareVersion);
    add(record, { id: `sy-studio:${stableToken(record.version!)}`, factId: 'sy-studio', mappingId: 'sy-studio', documentId: options.scope?.documentId || '', kind: 'runtime-dependency', feature: 'workspace', software: 'Ester Studio', version: record.version, role: 'runtime', reasonZh: '当前项目使用Ester Studio工作台', purpose: '当前项目的建模、输入或结果组织', methodSummaryZh: record.methodSummaryZh!, evidence: [{ kind: 'metadata', locator: 'package.json version/displayVersion/releaseChannel', detail: applicationVersionNote(options.softwareVersion) }] });
  }
  for (const entry of [...collected.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    entry.missing = missingCitationFields(entry.record);
    entry.userDecision = decisions?.annotations?.find(a => a.citationKey === entry.key)
      ?? decisions?.annotations?.find(a => entry.recordIds.includes(a.citationKey));
    if (entry.userDecision?.excluded) result.excluded.push(entry);
    else if (entry.record.status === 'verified' && !entry.missing.length && !entry.reasons.length) result.verified.push(entry);
    else result.candidates.push(entry);
  }
  return result;
}
