import type { ResultDiagnostic, ResultInputFile, TrajectoryResult } from '../../results/contracts';
import type { ScientificData, ScientificParserSnapshot } from '../../results/scientific-contracts';
import { recognizeSourceText, type SourceRecognition } from '../../results/source-recognition';
import { readHessScientificResult } from '../../results/hess-scientific-reader';
import { assessHessCompanion } from '../../results/hess-companion';
import { readXyzTrajectory } from '../../results/xyz-reader';
import { readMdAuxiliary } from '../../results/md-aux-reader';
import { readNebAuxiliary } from '../../results/neb-auxiliary-reader';
import { readScientificSnapshotResults } from '../../results/scientific-reader';
import { VibronicSha256 } from '../../core/gaussian-vibronic/sha256-stream';
import type { ArtifactRole, FileIdentity, SourceBoundary } from '../contracts';

export type CompanionCandidateKind = 'cis' | 'orca-json' | 'engrad' | 'gbw' | 'chk';
export interface CandidateProvenance {
  artifactId: string;
  runId: string;
  fileIdentity: FileIdentity;
  contentHash: { algorithm: 'sha256'; hash: string };
  sourceBoundary: SourceBoundary;
  origin: 'native-produced' | 'input-dependency' | 'unknown';
  runEvidenceRefs: string[];
  discovery: {
    kind: 'fixed-basename' | 'output-reference';
    primarySourceId?: string;
    sourceLine?: number;
    rawReference?: string;
    companionKind?: CompanionCandidateKind;
    /** Only B/Host's complete candidate set may establish this. */
    unambiguous?: boolean;
  };
}
export interface ClassifierPrimary {
  snapshotId: string;
  runId: string;
  index: ScientificParserSnapshot;
  /** A new owned lease of exactly index's frozen published prefix. */
  openSource(): Promise<ResultInputFile>;
}
export interface ScientificCandidateInput {
  /** Ownership transfers to this call; always closed, even for unknown content. */
  source: ResultInputFile;
  provenance: CandidateProvenance;
  primary?: ClassifierPrimary;
}
export type CandidateCapability = 'available' | 'partial' | 'unknown' | 'unsupported';
export interface CandidateFieldFamily {
  family: string;
  count: number;
  /** Only unit strings actually supplied by the existing reader. */
  units: string[];
  rawUnits: string[];
  firstSourceLine: number | null;
  lastSourceLine: number | null;
  sourceId: string;
}
export interface CandidateSegment {
  segmentIndex: number;
  readerResultId: string;
  frameCount: number;
  atomCount: number;
  charge: number | null;
  multiplicity: number | null;
  status: string;
  firstSourceLine: number | null;
  lastSourceLine: number | null;
}
export interface CandidateAssessment {
  artifactId: string;
  runId: string;
  sourceId: string;
  name: string;
  byteSize: number;
  identity: {
    format: string | null;
    formatState: 'known' | 'candidate' | 'unknown' | 'conflict';
    formatCandidate?: CompanionCandidateKind;
    representation: 'text' | 'binary' | 'unknown';
    software: string | null;
    softwareState: 'known' | 'unknown' | 'conflict';
    version: string | null;
    evidence: { kind: string; line?: number }[];
  };
  content: {
    state: 'validated' | 'partial' | 'recognized-only' | 'unrecognized' | 'refused' | 'cancelled' | 'source-changed';
    segments: CandidateSegment[];
    frameCount: number;
    atomCounts: number[];
    fieldFamilies: CandidateFieldFamily[];
  };
  /** Protocol-compatible roles; raw auxiliary identity is separate below. */
  roles: ArtifactRole[];
  candidateRole: 'auxiliary';
  association: {
    runState: 'confirmed' | 'unknown';
    origin: CandidateProvenance['origin'];
    runEvidenceRefs: string[];
    scienceState: 'confirmed' | 'unknown' | 'ambiguous' | 'conflict';
    matches: { jobIndex: number; segmentIndex: number; stageId: string | null; frameIndex: number; evidence: string[] }[];
    reasons: string[];
  };
  capabilities: Record<'structure' | 'trajectory' | 'modes' | 'auxiliaryTables' | 'gradient' | 'wavefunction' | 'excitationAmplitudes', CandidateCapability>;
  companionCandidate?: {
    kind: CompanionCandidateKind;
    rawReadable: boolean;
    originVerified: boolean;
    unambiguous: boolean;
    scientificState: 'unknown';
    evidence: string[];
  };
  diagnostics: { code: string; message: string }[];
  inspection: { prefixByteEnd: number; fullStreams: number; streamedBytes: number };
}

const PREFIX_BYTES = 1024 * 1024;
function fieldFamilies(data: ScientificData | undefined, sourceId: string): CandidateFieldFamily[] {
  if (!data) return [];
  const families: CandidateFieldFamily[] = [];
  const add = (family: string, rows: readonly unknown[]) => {
    if (!rows.length) return;
    const lineNumbers: number[] = [], units = new Set<string>(), rawUnits = new Set<string>();
    // Inspect only existing quantity metadata, not displacement/coefficient
    // matrices. Values and conversions remain the formal reader's authority.
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const row = value as Record<string, unknown>;
      if (typeof row.sourceLine === 'number') lineNumbers.push(row.sourceLine);
      if (typeof row.unit === 'string') units.add(row.unit);
      if (typeof row.rawUnit === 'string') rawUnits.add(row.rawUnit);
      for (const key of ['time', 'potentialEnergy', 'kineticEnergy', 'totalEnergy', 'temperature', 'energy', 'relativeEnergy'] as const) visit(row[key]);
      for (const key of ['fields', 'forces', 'images', 'values'] as const) if (Array.isArray(row[key])) for (const child of row[key]) visit(child);
    };
    for (const row of rows) visit(row);
    families.push({ family, count: rows.length, units: [...units], rawUnits: [...rawUnits], firstSourceLine: lineNumbers.length ? lineNumbers.reduce((a, b) => Math.min(a, b)) : null, lastSourceLine: lineNumbers.length ? lineNumbers.reduce((a, b) => Math.max(a, b)) : null, sourceId });
  };
  for (const key of ['summary', 'properties', 'atomicProperties', 'thermochemistry', 'excitedStates', 'stability', 'bsse', 'nmrCouplings', 'mdSteps', 'pathIterations'] as const) add(key, data[key] ?? []);
  add('vibrations', (data.vibrationSets ?? (data.vibrations ? [data.vibrations] : [])).flatMap(group => group.modes));
  add('nebIterations', data.nebEvidence?.auxiliaries.flatMap(auxiliary => auxiliary.iterations) ?? []);
  return families;
}
function ordinaryJob(job: ScientificParserSnapshot['jobs'][number]): boolean {
  return !!job.frames.length && !job.data.centers?.some(center => center.kind !== 'real') && !job.frames.some(frame => frame.geometry.centers?.some(center => center.kind !== 'real'));
}
function ownedSource(source: ResultInputFile): ResultInputFile {
  let closed = false;
  return { id: source.id, name: source.name, size: source.size, readTrace: source.readTrace,
    stream: () => source.stream(), readRange: (start, end, signal) => source.readRange(start, end, signal),
    close: async () => { if (closed) return; closed = true; await source.close?.(); } };
}

/** One fixed candidate only. A format hint and same-run provenance never count
 * as verified excitation amplitudes or a confirmed job/stage/frame match. */
export async function classifyScientificCandidate(input: ScientificCandidateInput, options: { signal?: AbortSignal } = {}): Promise<CandidateAssessment> {
  const source = ownedSource(input.source), p = input.provenance, signal = options.signal;
  const originVerified = p.origin === 'native-produced' && p.runEvidenceRefs.length > 0 && p.fileIdentity.verification === 'verified' && /^[a-f0-9]{64}$/i.test(p.contentHash.hash);
  const report: CandidateAssessment = {
    artifactId: p.artifactId, runId: p.runId, sourceId: source.id, name: source.name, byteSize: source.size,
    identity: { format: null, formatState: 'unknown', representation: 'unknown', software: null, softwareState: 'unknown', version: null, evidence: [] },
    content: { state: 'unrecognized', segments: [], frameCount: 0, atomCounts: [], fieldFamilies: [] }, roles: ['other'], candidateRole: 'auxiliary',
    association: { runState: p.origin !== 'unknown' && p.runEvidenceRefs.length > 0 && p.fileIdentity.verification === 'verified' ? 'confirmed' : 'unknown', origin: p.origin, runEvidenceRefs: [...p.runEvidenceRefs], scienceState: 'unknown', matches: [], reasons: ['候选保独立来源；尚未确认所属job/stage/frame。'] },
    capabilities: { structure: 'unknown', trajectory: 'unknown', modes: 'unknown', auxiliaryTables: 'unknown', gradient: 'unknown', wavefunction: 'unknown', excitationAmplitudes: 'unknown' },
    diagnostics: [], inspection: { prefixByteEnd: 0, fullStreams: 0, streamedBytes: 0 }
  };
  const disposers: (() => void | Promise<void>)[] = [];
  let sourceChanged = false;
  try {
    signal?.throwIfAborted();
    if (p.contentHash.algorithm !== 'sha256' || !Number.isSafeInteger(source.size) || source.size < 0 || p.fileIdentity.byteSize !== source.size
      || p.sourceBoundary.readByteRange.start !== 0 || p.sourceBoundary.readByteRange.end !== source.size
      || p.sourceBoundary.publishedByteRange.start !== 0 || p.sourceBoundary.publishedByteRange.end !== source.size) throw new Error('候选必须提供同一完整固定byte范围与文件身份。');
    for (const key of ['environmentId', 'path', 'fileId'] as const) if (Object.hasOwn(p.sourceBoundary.fileIdentity, key) && p.sourceBoundary.fileIdentity[key] !== p.fileIdentity[key]) {
      sourceChanged = true; throw new Error('候选byte边界与文件身份不一致。');
    }
    let end = Math.min(source.size, PREFIX_BYTES);
    const prefix = await source.readRange(0, end, signal); signal?.throwIfAborted();
    if (prefix.length !== end) { sourceChanged = true; throw new Error('候选前缀读取长度改变。'); }
    report.inspection.prefixByteEnd = end;
    let text = '', isText = true;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try { text = decoder.decode(prefix, { stream: end < source.size }); } catch { isText = false; }
    let recognized: SourceRecognition = isText ? recognizeSourceText(text) : { format: 'unknown', software: 'unknown', status: 'unknown', evidence: [] };
    while (isText && recognized.status === 'unknown' && !text.includes('\0') && end < source.size) {
      signal?.throwIfAborted();
      const nextEnd = Math.min(source.size, end + PREFIX_BYTES), bytes = await source.readRange(end, nextEnd, signal);
      signal?.throwIfAborted();
      if (bytes.length !== nextEnd - end) { sourceChanged = true; throw new Error('候选识别读取长度改变。'); }
      end = nextEnd; report.inspection.prefixByteEnd = end;
      try { text += decoder.decode(bytes, { stream: end < source.size }); } catch { isText = false; break; }
      recognized = recognizeSourceText(text);
      // Yield to cancellation and the owning source revision between blocks.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const opaqueFchk = recognized.format === 'fchk';
    report.identity.representation = !isText || text.includes('\0') && !opaqueFchk ? 'binary' : 'text';
    report.identity.format = recognized.format === 'unknown' ? null : recognized.format;
    report.identity.formatState = recognized.status === 'conflict' ? 'conflict' : recognized.format === 'unknown' ? 'unknown' : 'known';
    report.identity.software = recognized.software === 'unknown' ? null : recognized.software;
    report.identity.softwareState = recognized.status === 'conflict' ? 'conflict' : recognized.software === 'unknown' ? 'unknown' : 'known';
    report.identity.evidence = recognized.evidence.map(item => ({ ...item }));
    let companionKind = p.discovery.companionKind;
    if (!companionKind && isText && /The current total energy in Eh/.test(text) && /The current gradient in Eh\/bohr/.test(text) && /current coordinates in Bohr/i.test(text)) companionKind = 'engrad';
    if (companionKind) {
      report.identity.formatCandidate = companionKind;
      if (report.identity.formatState === 'unknown') report.identity.formatState = 'candidate';
      report.companionCandidate = { kind: companionKind, rawReadable: source.size > 0, originVerified, unambiguous: p.discovery.unambiguous === true, scientificState: 'unknown',
        evidence: [...p.runEvidenceRefs, 'origin:' + p.origin, ...(p.discovery.rawReference ? [p.discovery.rawReference] : []), '原始字节候选可读；未执行依赖OUT/Molden/电子态/维度的科学配对验证。'] };
    }
    if (recognized.status === 'conflict') { report.content.state = 'refused'; report.diagnostics.push({ code: 'identity-conflict', message: recognized.message ?? '候选含冲突的软件身份。' }); }
    else if (recognized.format === 'fchk' || recognized.format === 'molden' || recognized.format === 'output' || recognized.format === 'cif') {
      report.content.state = 'recognized-only';
      report.roles = recognized.format === 'output' ? ['primary-output'] : recognized.format === 'cif' ? ['structure'] : ['wavefunction'];
      report.diagnostics.push({ code: 'dedicated-reader-required', message: '格式已识别；本辅助classifier不运行主OUT、波函数或其他专用完整读者。' });
    } else if (report.identity.representation === 'text' && p.fileIdentity.verification === 'verified' && /^[a-f0-9]{64}$/i.test(p.contentHash.hash)) {
      const checked: ResultInputFile = {
        ...source,
        stream() {
          report.inspection.fullStreams++;
          let count = 0; const hash = new VibronicSha256();
          return source.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              for (let index = 0; index < Math.min(chunk.length, prefix.length - count); index++) if (chunk[index] !== prefix[count + index]) { sourceChanged = true; throw new Error('候选识别后原字节变化。'); }
              count += chunk.length; report.inspection.streamedBytes += chunk.length; hash.update(chunk); controller.enqueue(chunk);
            },
            flush() { if (count !== source.size || hash.digest() !== p.contentHash.hash.toLowerCase()) { sourceChanged = true; throw new Error('候选完整字节范围/SHA与固定来源不一致。'); } }
          }));
        }
      };
      let results: TrajectoryResult[] = [], diagnostic: ResultDiagnostic | null = null;
      if (recognized.format === 'hess') results = await readHessScientificResult(checked, options);
      else if (recognized.format === 'xyz') results = await readXyzTrajectory(checked, options);
      else {
        const md = await readMdAuxiliary(checked, options);
        if (md) { diagnostic = md.diagnostic; report.identity.format = md.kind === 'log' ? 'orca-md-log' : 'md-statistics'; }
        else {
          const neb = await readNebAuxiliary(checked, options);
          if (neb) { diagnostic = neb.diagnostic; report.identity.format = neb.data.kind === 'log' ? 'orca-neb-log' : 'neb-interpolation'; }
        }
      }
      disposers.push(...results.map(result => () => result.dispose()));
      if (diagnostic) disposers.push(() => diagnostic!.dispose());
      if (results.length || diagnostic) {
        report.identity.formatState = 'known'; report.content.state = 'validated';
        if (diagnostic) {
          report.roles = ['diagnostic']; report.capabilities.auxiliaryTables = diagnostic.status === 'incomplete' ? 'partial' : 'available';
          report.content.state = diagnostic.status === 'incomplete' || diagnostic.status === 'failed' ? 'partial' : 'validated';
          report.content.fieldFamilies = fieldFamilies(diagnostic.scientific, source.id);
          report.identity.software = diagnostic.engine === 'unknown' ? null : diagnostic.engine;
          report.identity.softwareState = diagnostic.engine === 'unknown' ? 'unknown' : 'known';
          report.diagnostics.push(...diagnostic.messages.map(message => ({ code: 'reader-notice', message })));
        }
        for (const [segmentIndex, result] of results.entries()) {
          const lines = result.frames.map(frame => frame.sourceLine).filter((line): line is number => typeof line === 'number');
          report.content.segments.push({ segmentIndex, readerResultId: result.id, frameCount: result.frames.length, atomCount: result.initialStructure.atoms.length, charge: result.initialStructure.charge, multiplicity: result.initialStructure.multiplicity,
            status: result.status, firstSourceLine: lines.length ? lines.reduce((a, b) => Math.min(a, b)) : null, lastSourceLine: lines.length ? lines.reduce((a, b) => Math.max(a, b)) : null });
          report.content.frameCount += result.frames.length; report.content.atomCounts.push(result.initialStructure.atoms.length);
          report.content.fieldFamilies.push(...fieldFamilies(result.scientific, source.id));
          report.diagnostics.push(...result.messages.map(message => ({ code: 'reader-notice', message })));
          if (result.status === 'incomplete' || result.status === 'failed') report.content.state = 'partial';
          if (result.source.software && result.source.software !== 'unknown') { report.identity.software = result.source.software; report.identity.softwareState = 'known'; }
          if (result.scientific?.version) report.identity.version = result.scientific.version;
        }
        if (results.length) {
          report.roles = ['structure']; report.capabilities.structure = report.content.state === 'partial' ? 'partial' : 'available';
          if (recognized.format === 'xyz' && report.content.frameCount > 1) { report.roles.push('trajectory'); report.capabilities.trajectory = report.capabilities.structure; }
          if (report.content.fieldFamilies.some(family => family.family === 'vibrations' && family.count > 0)) { report.roles.push('modes'); report.capabilities.modes = results.some(result => result.scientific?.notices.length) ? 'partial' : 'available'; }
        }
        if (recognized.format === 'hess' && results.length === 1 && input.primary) {
          try {
            const primary = input.primary;
            if (primary.runId !== p.runId) { report.association.scienceState = 'conflict'; report.association.reasons = ['主OUT与候选的runId不同；保独立来源。']; }
            else {
              const primarySource = ownedSource(await primary.openSource()); disposers.push(() => primarySource.close?.());
              if (primarySource.id !== primary.snapshotId || primarySource.size !== primary.index.publishedByteEnd) throw new Error('主OUT lease与冻结snapshot/index不一致。');
              const read = await readScientificSnapshotResults(primarySource, primary.index, options);
              disposers.push(...[...read.results, ...read.diagnostics].map(result => () => result.dispose()));
              const jobs = primary.index.jobs.filter(ordinaryJob);
              const reasons: string[] = [];
              for (const [index, output] of read.results.entries()) {
                const assessed = await assessHessCompanion(output, results[0], signal);
                if (assessed.result) {
                  const group = assessed.result.scientific?.vibrationSets?.find(item => item.sourceId === results[0].source.id);
                  if (group?.frameIndex !== null && group?.frameIndex !== undefined && jobs[index]) report.association.matches.push({ jobIndex: jobs[index].jobIndex, segmentIndex: jobs[index].segmentIndex, stageId: jobs[index].frames[group.frameIndex]?.stageId ?? null, frameIndex: group.frameIndex, evidence: ['唯一原子身份/几何、完整频率与Cartesian模式共同匹配；未凭basename或末帧选择。'] });
                } else if (assessed.reason) reasons.push(assessed.reason);
              }
              const ambiguous = reasons.some(reason => /匹配多个帧/.test(reason));
              const savedState = results[0].initialStructure;
              const stateConflict = read.results.length > 0 && read.results.every(output => {
                const state = output.initialStructure;
                return savedState.charge !== null && state.charge !== null && savedState.charge !== state.charge
                  || savedState.multiplicity !== null && state.multiplicity !== null && savedState.multiplicity !== state.multiplicity;
              });
              report.association.scienceState = ambiguous || report.association.matches.length > 1 ? 'ambiguous' : report.association.matches.length === 1 ? 'confirmed' : stateConflict ? 'conflict' : 'unknown';
              report.association.reasons = report.association.scienceState === 'confirmed' ? [] : report.association.scienceState === 'ambiguous' ? ['科学内容匹配多个job/segment/frame，未自动选择。']
                : stateConflict ? ['候选已打印的电子态与所有可用主OUT job明确不相容；保双方独立来源。'] : reasons.length ? [...new Set(reasons)] : ['没有取得唯一完整科学匹配。'];
            }
          } catch (error) { report.association.scienceState = 'unknown'; report.association.reasons = [error instanceof Error ? error.message : String(error)]; }
        }
      }
    }
    signal?.throwIfAborted();
  } catch (error) {
    report.content.state = signal?.aborted ? 'cancelled' : sourceChanged ? 'source-changed' : 'refused';
    report.diagnostics.push({ code: signal?.aborted ? 'cancelled' : sourceChanged ? 'source-changed' : 'candidate-read-failed', message: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const dispose of disposers.reverse()) try { await dispose(); } catch (error) { report.diagnostics.push({ code: 'release-failed', message: error instanceof Error ? error.message : String(error) }); }
    try { await source.close?.(); } catch (error) { report.diagnostics.push({ code: 'release-failed', message: error instanceof Error ? error.message : String(error) }); }
  }
  if (sourceChanged) {
    report.content.state = 'source-changed'; report.association.scienceState = 'unknown'; report.association.matches = [];
    for (const key of Object.keys(report.capabilities) as (keyof CandidateAssessment['capabilities'])[]) report.capabilities[key] = 'unknown';
  }
  return report;
}
