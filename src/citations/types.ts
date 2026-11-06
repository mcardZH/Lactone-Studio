/** Local, evidence-backed bibliography. Project content never leaves this module. */
export type CitationKind = 'article' | 'book' | 'chapter' | 'preprint' | 'software' | 'dataset' | 'web';
export type CitationStatus = 'verified' | 'pending' | 'unverified';
export type CitationRole = 'scientific' | 'runtime' | 'data';
export interface CitationAuthor { family?: string; given?: string; literal?: string }
export interface CitationEvidence {
  kind: 'publisher' | 'doi' | 'official' | 'project' | 'user';
  url?: string; locator?: string; checkedAt?: string; note?: string;
}
export interface CitationRecord {
  id: string; kind: CitationKind; title: string; authors: readonly CitationAuthor[];
  year?: number; journal?: string; journalAbbreviation?: string; volume?: string; issue?: string;
  pages?: string; articleNumber?: string; doi?: string; url?: string; version?: string; publisher?: string;
  bookTitle?:string;editors?:readonly CitationAuthor[];series?:string;
  /** Stable software/data identity, e.g. an official product ID; never a local project path. */
  identity?: string; status: CitationStatus; evidence: readonly CitationEvidence[];
  methodSummaryZh?: string; note?: string;
}
/** Exact selectors only. Omitted selectors are unrestricted; no fuzzy scientific inference. */
export interface CitationMapping {
  id: string; feature: string; method?: string; software?: string;
  /** Fixed numeric version prefix, e.g. 6 or 6.1; never a regular expression. */
  versionPrefix?: string;
  /** Literal case-insensitive version text, combined with prefix by AND. */
  versionContains?: string;
  /** Exact retained scientific source identity; used for entry-specific citations. */
  sourceId?: string;
  citationIds: readonly string[]; role: CitationRole; reasonZh: string; methodSummaryZh?: string;
}
export interface CitationRegistry { schemaVersion: 1; records: readonly CitationRecord[]; mappings: readonly CitationMapping[] }
export interface CitationFactEvidence { kind: 'source' | 'metadata' | 'generated-input' | 'user'; locator: string; detail?: string }
export type CitationFactKind = 'retained-result' | 'generated-input' | 'model-operation' | 'data-source' | 'runtime-dependency' | 'preview' | 'selection';
/** An adapter supplies proven facts from retained content, never all available options. */
export interface CitationFact {
  id: string; documentId: string; sourceId?: string; jobId?: string; frameId?: string; taskId?: string;
  kind: CitationFactKind; feature: string; method?: string; software?: string; version?: string;
  parameters?: Readonly<Record<string, string | number | boolean>>;
  evidence: readonly CitationFactEvidence[]; retained?: boolean; stage?: string; purpose?: string;
}
export interface CitationUsage {
  id: string; factId: string; mappingId: string; documentId: string; sourceId?: string; jobId?: string;
  frameId?: string; taskId?: string; kind: CitationFactKind; feature: string; method?: string; software?: string;
  version?: string; stage?: string; role: CitationRole; reasonZh: string; purpose: string;
  methodSummaryZh: string; evidence: readonly CitationFactEvidence[];
}
export interface CitationDecision {
  /** citationKey() or a registry record id, so pre-existing user choices survive aliases. */
  citationKey: string; excluded?: boolean; note?: string;
}
export interface CitationDecisions {
  records?: readonly CitationRecord[]; annotations?: readonly CitationDecision[];
  /** Manual references are selected explicitly; merely adding a record does not claim use. */
  additions?: readonly { recordId: string; documentId?: string; purpose: string; note?: string }[];
}
export interface CollectedCitation {
  key: string; record: CitationRecord; recordIds: string[]; usages: CitationUsage[];
  missing: string[]; reasons: string[]; userDecision?: CitationDecision;
}
export interface CitationIssue {
  id: string; code: 'unmapped' | 'missing-evidence' | 'registry' | 'missing-record' | 'conflict';
  message: string; fact?: CitationFact; recordId?: string;
}
export interface CitationCollection {
  verified: CollectedCitation[]; candidates: CollectedCitation[]; unknown: CitationIssue[];
  excluded: CollectedCitation[]; issues: CitationIssue[];
}
export interface CollectCitationsOptions {
  registry: CitationRegistry; facts: readonly CitationFact[]; scope?: { documentId?: string };
  decisions?: CitationDecisions; softwareVersion?: string;
}
/** Both pending bibliography and unknown facts stay visible in every export format. */
export interface CitationExportRow {
  section: 'verified' | 'candidate' | 'unknown' | 'excluded'; key: string; role: string; status: string;
  title: string; authors: string; year: string; citation: string; doi: string; url: string;
  version: string; methods: string; purpose: string; usages: string; evidence: string;
  missing: string; notes: string;
  bookTitle:string;editors:string;series:string;
}
