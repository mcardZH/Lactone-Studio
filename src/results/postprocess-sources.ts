import type { Structure, Vector3 } from '../core/types';
import { canonicalBasis } from '../core/catalog';
import { normalizedFchkNumber } from '../core/fchk-reader';
import { gaussianRouteTokens } from '../core/gaussian-source';
import { getOrcaMethods, ORCA_BASES } from '../core/orca/catalog';
import { orcaSourceKeywords, parseOrcaInputSource } from '../core/orca/input-source';
import { superposeViewAtoms, type ViewRigidTransform } from '../modeling/view-superposition';
import { assertResultNotAborted, type ResultDiagnostic, type ResultInputFile, type ResultReadOptions, type TrajectoryResult } from './contracts';
import { appendGaussianRouteSummary, readFchkScientificResult } from './fchk-scientific-reader';
import { streamFchkRecords } from '../core/fchk-records';
import type { WavefunctionMetadata } from './orbital-contracts';
import { outputLines } from './optimization-reader';
import { emptyScientificData, SCIENTIFIC_NUMBER, scientificNumber, type ScfCycle, type ScientificField, type ScientificLine, type ScientificTask } from './scientific-contracts';
import { readScientificFileResults, readScientificResults } from './scientific-reader';
import { readIrcOutputContext, type IrcOutputContext } from './irc-companion-association';
import { recognizeResultSource, type SourceSoftware } from './source-recognition';
import { readXyzTrajectory } from './xyz-reader';
import { readHessScientificResult } from './hess-scientific-reader';
import type { GeneratedXtbProvenance } from './xtb-generated-source';
import { bindNmrCouplingSource } from './nmr-coupling-projection';
import { bindMdStepSources } from './md-observations';
import {projectPostprocessParsedResults,type PostprocessParsedResultsLease} from './postprocess-reused-results';
import {readNebAuxiliary,type NebAuxiliarySource} from './neb-auxiliary-reader';
import {readNebOutputContext,type NebOutputContext} from './neb-companion-association';
import {VibronicSha256} from '../core/gaussian-vibronic/sha256-stream';
export type {PostprocessParsedResultsLease} from './postprocess-reused-results';
export interface PostprocessOutputReadOptions extends ResultReadOptions {reuseParsedResults?():PostprocessParsedResultsLease|null|Promise<PostprocessParsedResultsLease|null>}

export type PostprocessSourceKind = 'gaussian-output' | 'orca-output' | 'fchk' | 'molden' | 'xyz' | 'hess' | 'neb-auxiliary' | 'gbw' | 'unsupported';
export interface PostprocessSourceIdentity { kind: PostprocessSourceKind; software?: SourceSoftware; message?: string }
export class PostprocessSourceError extends Error {
  constructor(readonly code: string, message: string, readonly candidateFrameIndices?: readonly number[]) { super(message); this.name = 'PostprocessSourceError'; }
}
export interface PrintedObservation {
  /** Same definition and unit only; keys are not generic display labels. */
  definition: string; unit: string; value: number; sourceLine: number; token: string;
  rounding: number;
  frameIndex?: number | null;
}
export interface PostprocessSource {
  kind: 'gaussian-output' | 'orca-output' | 'fchk' | 'molden' | 'xyz' | 'hess';
  /** Format alone (notably Molden) never establishes the producing program. */
  software?: SourceSoftware;
  /** Set only by the retained host-artifact adapter, never text-format recognition. */
  generatedXtb?: GeneratedXtbProvenance;
  result: TrajectoryResult;
  tasks: readonly ScientificTask[];
  /** The parsed result remains intact for routing a combined opt/freq task. */
  results: readonly TrajectoryResult[];
  /** Set only after native boundary, task, state and exact final/first geometry validation. */
  nativeContinuations?: readonly { kind: 'gaussian-opt-freq'; optimizationResultId: string; frequencyResultId: string; evidenceSourceLine: number }[];
  /** Printed observations of the already validated native frequency continuation. */
  continuationObservations?: readonly PrintedObservation[];
  /** Explicit final IRC density/population reprint, not the last array element. */
  savedDensityFrameIndex?: number;
  metadata?: WavefunctionMetadata;
  observations: readonly PrintedObservation[];
  /** Maximum per-coordinate rounding interval established from this source. */
  coordinateRoundingAngstrom: number | null;
  /** Output coordinate print precision is local to each indexed geometry. */
  coordinateRoundingByFrame?: Readonly<Record<number, number | null>>;
  /** Native selected-OUT references/summary tokens only. The actual result
   * remains in its existing slot and is not duplicated into this context. */
  nebOutputContext?:Omit<NebOutputContext,'output'>;
  ircOutputContext?: Omit<IrcOutputContext, 'output'>;
  excitationCompanionSelection?: 'explicit' | 'none';
}
/** File/job data without requiring or manufacturing a computed geometry. */
export interface PostprocessScientificFileSource {
  fileOnly: true; kind: 'gaussian-output' | 'orca-output'; software?: SourceSoftware;
  identity: TrajectoryResult['source']; jobs: readonly (TrajectoryResult | ResultDiagnostic)[];
  selectedJobId?: string; tasks: readonly ScientificTask[];
  ircContexts: readonly Omit<IrcOutputContext, 'output'>[];
  /** Evidence scoped to an independently terminated native job, in the unchanged OUT. */
  jobEvidence?: Readonly<Record<string, { sourceId: string; sourceRevision: string; startLine: number; endLine: number;
    observations: readonly PrintedObservation[]; coordinateRoundingAngstrom: number | null;
    coordinateRoundingByFrame?: Readonly<Record<number, number | null>> }>>;
  dispose(): void | Promise<void>;
}
export type PostprocessFileSource = PostprocessSource | PostprocessScientificFileSource;
export function isScientificFileSource(source: PostprocessFileSource): source is PostprocessScientificFileSource { return 'fileOnly' in source && source.fileOnly; }
export function postprocessFileJob(source: PostprocessScientificFileSource): TrajectoryResult | ResultDiagnostic | undefined { return source.selectedJobId ? source.jobs.find(job => job.id === source.selectedJobId) : source.jobs.length === 1 ? source.jobs[0] : undefined; }
/** Non-owning geometry source. An input/diagnostic or unscoped job cannot grant a wavefunction. */
export function postprocessFileJobSource(source: PostprocessScientificFileSource): PostprocessSource | undefined {
  const job = postprocessFileJob(source), evidence = job && source.jobEvidence?.[job.id];
  if (!job || !('frames' in job) || !job.frames.length || job.scientific?.centers?.some(center => center.kind !== 'real')
    || !evidence || evidence.sourceId !== source.identity.id || evidence.sourceRevision !== source.identity.sha256
    || !Number.isSafeInteger(evidence.startLine) || !Number.isSafeInteger(evidence.endLine) || evidence.startLine < 1 || evidence.endLine < evidence.startLine
    || job.frames.some(frame => frame.sourceLine < evidence.startLine || frame.sourceLine > evidence.endLine)) return undefined;
  return { kind: source.kind, software: source.software, result: job, results: [job], tasks: job.scientific?.tasks ?? [],
    observations: evidence.observations, coordinateRoundingAngstrom: evidence.coordinateRoundingAngstrom,
    ...(evidence.coordinateRoundingByFrame ? { coordinateRoundingByFrame: evidence.coordinateRoundingByFrame } : {}) };
}
export interface PostprocessSourcePair {
  primary: PostprocessSource;
  wavefunction: PostprocessSource;
  sourceToDisplay: ViewRigidTransform;
  maxResidualAngstrom: number;
  coordinateToleranceAngstrom: number;
  /** Exact output geometry matched to the saved wavefunction; never inferred from filename/order. */
  frameIndex: number;
  comparisonResultId?: string;
  notices: string[];
  conflicts: { definition: string; unit: string; output: PrintedObservation; wavefunction: PrintedObservation }[];
}
/** Explicit metadata disagreement rejects cross-source participation at every
 * entry. Missing metadata and other informational notices remain independent. */
export function postprocessMetadataConflict(pair: PostprocessSourcePair): string | undefined {
  return pair.notices.find(note => /^来源.+记录不一致/.test(note));
}
const BOHR_ANGSTROM = 0.529177210903;
const numberTokens = (text: string) => [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_.])(${SCIENTIFIC_NUMBER})(?![A-Za-z0-9_.])`, 'g'))].map(match => match[1]);
function canEnrich(result:TrajectoryResult):boolean {
  const data=result.scientific;
  return !!data;
}

/** Half a last printed digit; scientific notation changes the absolute interval. */
export function printedRoundingInterval(token: string): number | null {
  if (scientificNumber(token) === null) return null;
  const [mantissa, exponent = '0'] = token.toLowerCase().replace('d', 'e').split('e');
  const decimals = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  const result = .5 * 10 ** (Number(exponent) - decimals);
  return Number.isFinite(result) && result > 0 ? result : null;
}

/** Inspect bytes rather than trusting a suffix. No conversion or file mutation. */
export async function identifyPostprocessSource(file: ResultInputFile, options: ResultReadOptions = {}): Promise<PostprocessSourceIdentity> {
  assertResultNotAborted(options.signal);
  const identity = await recognizeResultSource(file, options);
  if (identity.status === 'conflict') return { kind: 'unsupported', message: identity.message };
  if (identity.format === 'molden' || identity.format === 'fchk') return { kind: identity.format, software: identity.software };
  if (identity.format === 'xyz' || identity.format === 'hess') return { kind: identity.format, software: identity.software };
  if (identity.format === 'output' && identity.software === 'gaussian') return { kind: 'gaussian-output', software: identity.software };
  if (identity.format === 'output' && identity.software === 'orca') return { kind: 'orca-output', software: identity.software };
  if (identity.format === 'cif') return { kind: 'unsupported', software: identity.software, message: 'CIF为结构来源，请通过结构导入读取；生成软件元数据不将其变成结果OUT。' };
  if (identity.software === 'cp2k' && identity.format === 'output') return { kind: 'unsupported', message: '识别为CP2K来源；本入口尚不提供CP2K结果解析。' };
  if(identity.format==='unknown'){
    const auxiliary=await readPostprocessNebAuxiliary(file,options);
    if(auxiliary)return{kind:'neb-auxiliary',software:auxiliary.diagnostic.source.software};
  }
  // GBW has no supported public text grammar here. A binary .gbw is only a
  // conversion hint, never a successful wavefunction identity/parse claim.
  if (/\.gbw$/i.test(file.name)) { const bytes = await file.readRange(0, Math.min(file.size, 1024 * 1024), options.signal); assertResultNotAborted(options.signal); if (bytes.some(byte => byte === 0)) return { kind: 'gbw', message: 'GBW须先用对应ORCA版本的orca_2mkl <basename> -molden转换为Molden；本页不运行转换。' }; }
  return { kind: 'unsupported', message: '未从内容识别支持的OUT、XYZ、HESS、FCHK或Molden；二进制CHK/GBW须先在原软件转换。' };
}

const nebAuxiliarySources=new WeakMap<ResultInputFile,NebAuxiliarySource>();
/** Same native reader as workspace import; never a suffix-based identity or a
 * zero-atom trajectory. Classification and routing share its owned parse. */
export async function readPostprocessNebAuxiliary(file:ResultInputFile,options:ResultReadOptions={}):Promise<NebAuxiliarySource|null>{
 assertResultNotAborted(options.signal);const cached=nebAuxiliarySources.get(file);if(cached)return cached;
 const source=await readNebAuxiliary(file,options);if(source)nebAuxiliarySources.set(file,source);return source;
}
/** The existing project extra-source codec owns these original bytes. A small
 * independently verified selected auxiliary snapshot has no file/IO lease to
 * lose when a primary OUT is replaced, closed or saved under another name. */
export async function snapshotPostprocessNebAuxiliary(source:NebAuxiliarySource,options:ResultReadOptions={}){
 const identity=source.data.source,chunks:Uint8Array[]=[],hash=new VibronicSha256(),chunkBytes=8*1024**2;
 for(let start=0;start<identity.size;start+=chunkBytes){assertResultNotAborted(options.signal);const end=Math.min(identity.size,start+chunkBytes),bytes=await source.diagnostic.readSourceRange!(start,end,options.signal);if(bytes.length!==end-start)throw Error('NEB辅助原始字节长度发生变化。');chunks.push(bytes.slice());hash.update(bytes);}
 assertResultNotAborted(options.signal);const revision=hash.digest();if(!identity.sha256||revision!==identity.sha256)throw Error('NEB辅助原字节与已读版本不一致，未混合保存。');
 return{name:identity.name,sourceId:identity.id,revision,byteSize:identity.size,format:source.data.kind==='log'?'orca-neb-log':'neb-interpolation',async readRange(start:number,end:number,signal?:AbortSignal){
  assertResultNotAborted(signal);if(![start,end].every(Number.isSafeInteger)||start<0||end<start||end>identity.size)throw Error('NEB附加原始来源范围无效。');
  const bytes=new Uint8Array(end-start);let offset=0;for(const chunk of chunks){const next=offset+chunk.length;if(next>start&&offset<end){const first=Math.max(start,offset),last=Math.min(end,next);bytes.set(chunk.subarray(first-offset,last-offset),first-start);}offset=next;}return bytes;
 }};
}

const energyDefinition = (field: ScientificField): string | null => {
  if (field.key === 'scf-energy' || field.key === 'SCF Energy') return 'gaussian:SCF Energy';
  if (field.key === 'MP2 Energy' || /energy-E(?:U|\(R|\(U)MP2/.test(field.key)) return 'gaussian:MP2 Energy';
  return null;
};
/** A generic pairwise description is evidence, not a replacement for D3BJ/D4 identity. */
const dispersionKey = (value: string) => /\b(?:atom[- ]pairwise|pairwise)\b/i.test(value) && !/\bD[34]\b|D3BJ|DFT-NL|Grimme/i.test(value) ? 'dispersion-description' : 'dispersion';
function observation(definition: string, unit: string, token: string, sourceLine: number, fchk=false): PrintedObservation | null {
  const normalized=fchk?normalizedFchkNumber(token):token;
  const value = normalized===null?null:scientificNumber(normalized), rounding = normalized===null?null:printedRoundingInterval(normalized);
  return value !== null && rounding !== null ? { definition, unit, value, sourceLine, token, rounding } : null;
}

/** Explicit printed statements only; the caller supplies the indexed source frame. */
export function enrichSinglePointLine(result: TrajectoryResult, line: ScientificLine, currentFrame?: number | null): void {
  const data = result.scientific;
  if (!data||!canEnrich(result)) return;
  const text = line.text.trim(), frameIndex = currentFrame === undefined ? result.frames.at(-1)?.index ?? null : currentFrame;
  const put = (key: string, label: string, value: string | number, unit?: string, target: ScientificField[] = data.properties,rawValue?:string) => {
    if (target.some(field => field.key === key && field.sourceLine === line.number && field.frameIndex === frameIndex)) return;
    if (!canEnrich(result)) return;
    target.push({ key, label, value, sourceLine: line.number, frameIndex, ...(unit ? { unit } : {}),...(rawValue===undefined?{}:{rawValue}) });
  };
  let match: RegExpMatchArray | null;
  if (result.engine === 'gaussian') {
    if ((match = text.match(/^Standard basis:\s*(.+)$/i))) put('basis', 'Basis (printed)', match[1]);
    if ((match = text.match(/^SCF Done:\s+E\(([^)]+)\)/))) put('method', 'SCF method (printed)', match[1]);
    if ((match = text.match(/^SCF Done:.*?\bafter\s+(\d+)\s+cycles\b/i))) {
      // The native parser owns attempt outcomes, including failure markers
      // before/after SCF Done. Enrichment must not manufacture a second,
      // contradictory successful state from that printed energy record.
      if (!data.diagnostics?.scf.some(event => event.frameIndex === frameIndex)) put('scf-status', 'SCF convergence (printed)', 'converged', undefined, data.summary);
      put('scf-iterations', 'SCF cycles (printed)', Number(match[1]), undefined, data.summary, match[1]);
    }
    if ((match = text.match(/^Solvent\s*:\s*([^,]+)(?:,|$)/i))) put('solvent', 'Solvent (printed)', match[1].trim());
    if ((match = text.match(/^Model\s*:\s*(.+)$/i))) put('solvent-model', 'Solvent model (printed)', match[1]);
    if (/^Atomic radii\s*:\s*SMD-Coulomb/i.test(text)) put('solvent-model-smd', 'Solvent model (printed)', 'SMD');
    if ((match = text.match(new RegExp(String.raw`^S\*\*2 before annihilation\s*(${SCIENTIFIC_NUMBER}),?\s+after\s*(${SCIENTIFIC_NUMBER})`, 'i')))) {
      put('spin-squared-before', 'S² before annihilation', scientificNumber(match[1])!, 'dimensionless');
      put('spin-squared-after', 'S² after annihilation', scientificNumber(match[2])!, 'dimensionless');
    }
    if ((match = text.match(new RegExp(String.raw`^S\*\*2\s*=\s*(${SCIENTIFIC_NUMBER})`, 'i')))) put('spin-squared', 'S² (printed)', scientificNumber(match[1])!, 'dimensionless');
    if ((match = text.match(/\bEmpiricalDispersion\s*=\s*([^\s,)]+)/i))) put('dispersion', 'Dispersion (input echo)', match[1]);
  } else if (result.engine === 'orca') {
    if ((match = text.match(/^\*?\s*SCF CONVERGED AFTER\s+(\d+)\s+(?:CYCLES|ITERATIONS)\b/i))) {
      put('scf-status', 'SCF convergence (printed)', 'converged', undefined, data.summary);
      put('scf-iterations', 'SCF cycles (printed)', Number(match[1]), undefined, data.summary);
    }
    const energy = text.match(new RegExp(String.raw`^(SCF\s+Energy|NL\s+Energy|SC\+NL Energy|Old exchange energy|New exchange energy|Exchange energy change after final integration|SMD CDS free energy correction energy)\s*:\s*(${SCIENTIFIC_NUMBER})(?:\s+(Eh|hartree|[Kk]cal/mol))?\s*$`));
    if (energy) {
      const label = energy[1].replace(/\s+/g, ' '), value = scientificNumber(energy[2])!;
      const key = ({ 'SCF Energy': 'scf-energy-reference', 'NL Energy': 'nl-energy-correction', 'SC+NL Energy': 'sc-plus-nl-energy', 'Old exchange energy': 'exchange-energy-old', 'New exchange energy': 'exchange-energy-new', 'Exchange energy change after final integration': 'exchange-energy-integration-change', 'SMD CDS free energy correction energy': 'smd-cds-energy-correction' } as Record<string, string>)[label];
      const physicalLabel=({'scf-energy-reference':'SCF参考能 E(SCF)','nl-energy-correction':'非局域色散修正 E(NL)','sc-plus-nl-energy':'含非局域修正的电子能 E(SCF+NL)','exchange-energy-old':'旧交换能','exchange-energy-new':'新交换能','exchange-energy-integration-change':'最终积分交换能变化','smd-cds-energy-correction':'SMD CDS自由能修正'} as Record<string,string>)[key];
      // The compact post-SCF SCF/NL/SC+NL lines print no unit. Preserve that
      // absence rather than transferring the next block's Eh annotation.
      put(key, physicalLabel, value, energy[3] === 'Eh' ? 'hartree' : energy[3],data.properties,energy[2]);
    }
    if (/^Total energy after final integration\s*:/i.test(text)) {
      const note = 'ORCA此行打印最终积分后的已有总能量；展示时不将所列修正再次加到最终能量。';
      if (!data.notices.includes(note)) data.notices.push(note);
    }
    if (/^Total Energy after SMD CDS correction\s*=/i.test(text)) {
      const note = 'ORCA此行明确打印SMD CDS修正后的已有总能量；相邻SMD CDS修正项已计入该阶段总量，不再重复加总。';
      if (!data.notices.includes(note)) data.notices.push(note);
    }
    if ((match = text.match(/^Your calculation utilizes the basis:\s*(.+)$/i))) put('basis', 'Basis (printed)', match[1]);
    if ((match = text.match(/^Your calculation utilizes the (.+?) dispersion correction\.?$/i))) put(dispersionKey(match[1]), 'Dispersion (printed)', match[1]);
    if ((match = text.match(/^Your calculation utilizes the (.+?) solvation module\.?$/i))) put('solvent-model', 'Solvent model (printed)', match[1]);
    if ((match = text.match(/^Solvent:\s*\.{3}\s*(.+)$/i))) put('solvent', 'Solvent (printed)', match[1]);
    const methodKeywords = orcaSourceKeywords(data.route).filter(keyword => getOrcaMethods('6.1').some(method => method.keywords[0].toLowerCase() === keyword.toLowerCase()));
    const method = methodKeywords.length === 1 ? methodKeywords[0] : undefined;
    const echo = text.replace(/^\|\s*\d+>\s*/, '');
    if (method && echo.startsWith('!') && echo.slice(1).split(/\s+/).some(token => token.toLowerCase() === method.toLowerCase())) put('method', 'Method (input echo)', method);
    if ((match = text.match(new RegExp(String.raw`^Expectation value of <S\*\*2>\s*[:=.]*(?:\s+)(${SCIENTIFIC_NUMBER})`, 'i')))) put('spin-squared', 'S² (printed)', scientificNumber(match[1])!, 'dimensionless');
    if ((match = text.match(new RegExp(String.raw`^Total Dipole Moment\s*:\s*(${SCIENTIFIC_NUMBER})\s+(${SCIENTIFIC_NUMBER})\s+(${SCIENTIFIC_NUMBER})$`, 'i')))) {
      ['x', 'y', 'z'].forEach((axis, index) => put(`dipole-${axis}-au`, `Total dipole ${axis} (printed)`, scientificNumber(match![index + 1])!, 'e·bohr'));
    }
  }
}

/** Presentation metadata stays separate from input inheritance and energy targeting. */
function appendOutputSetting(result: TrajectoryResult, line: ScientificLine, key: string, label: string, value: string | number, unit?: string): void {
  if(!canEnrich(result))return;
  const summary = result.scientific!.summary;
  if (summary.some(field => field.key === key && field.label === label && field.value === value && field.unit === unit)) return;
  summary.push({ key, label, value, sourceLine: line.number, frameIndex: null, ...(unit ? { unit } : {}) });
}

function appendOrcaEchoSettings(result: TrajectoryResult, line: ScientificLine): void {
  if(!canEnrich(result))return;
  const text = line.text.replace(/^\s*\|\s*\d+>\s*/, '').trim();
  const put = (key: string, label: string, value: string) => appendOutputSetting(result, line, key, `${label} (input echo)`, value);
  if (text.startsWith('!')) {
    for (const token of orcaSourceKeywords(text)) {
      if (getOrcaMethods('6.1').some(method => method.keywords[0].toLowerCase() === token.toLowerCase()) || /^(?:[RU]?HF|ROHF|BLYP|BP86|PBE|MP2|CCSD(?:\(T\))?)$/i.test(token)) put('method', '方法', token);
      if (ORCA_BASES.some(basis => basis.toLowerCase() === token.toLowerCase()) || /^(?:aug-)?cc-pV[DTQ56]Z(?:-PP)?$|^STO-\dG$|^\d-\d+G[+*()\w,-]*$/i.test(token)) put('basis', '基组', token);
      if (/\/(?:J|JK|C|CABS)$/i.test(token) || /^(?:AutoAux|AutoAuxNo(?:RI|J|JK))$/i.test(token)) put('auxiliary-basis', '辅助基组', token);
      if (/^(?:RIJCOSX|RIJONX|RI|RIJ|RIK|RIJK|NORI)$/i.test(token)) put('ri', 'RI设置', token);
      if (/^(?:DEFGRID[123]|(?:NO)?FINALGRID\d+|GRIDX?\d+)$/i.test(token)) put('integration-grid', '积分格点', token);
      if (/^(?:tight|strong|normal|loose|verytight)SCF$|^(?:slowconv|soscf|nososcf)$/i.test(token)) put('scf-settings', 'SCF设置', token);
      if (/^(?:tight|normal|loose|verytight)?opt(?:ts)?$/i.test(token)) put('optimization-settings', '优化设置', token);
      if (/^(?:RHF|UHF|RKS|UKS|ROHF)$/i.test(token)) put('reference-state', '参考态', token);
      if (/^(?:D3(?:BJ|ZERO)?|D4|DFT-NL)$/i.test(token)) put('dispersion', '色散', token);
      if (/^(?:miniprint|smallprint|normalprint|largeprint)$/i.test(token)) put('output-verbosity', '输出级别', token);
      if (/^(?:DKH\d*|ZORA|X2C|SFX2C)$/i.test(token)) put('relativistic', '相对论设置', token);
      if (/ECP$/i.test(token)) put('ecp', 'ECP', token);
      const solvent = token.match(/^(CPCM|SMD|COSMO)\(([^)]+)\)$/i);
      if (solvent) { put('solvent-model', '溶剂模型', solvent[1]); put('solvent', '溶剂', solvent[2]); }
    }
  }
}

function appendPrintedSettings(result: TrajectoryResult, line: ScientificLine, gridContext: string): void {
  if(!canEnrich(result))return;
  const text = line.text.trim(), put = (key: string, label: string, value: string | number, unit?: string) => appendOutputSetting(result, line, key, `${label} (printed)`, value, unit);
  let match: RegExpMatchArray | null;
  if (result.engine === 'gaussian') {
    if ((match = text.match(/^Standard basis:\s*(.+)$/i))) put('basis', '基组', match[1]);
    if ((match = text.match(/^General basis read from cards:\s*(.+)$/i))) put('basis-shells', '显式基组壳类型', match[1]);
    if ((match = text.match(/^SCF Done:\s+E\(([^)]+)\)/))) {
      put('scf-method', 'SCF参考方法', match[1]);
      const reference = match[1].match(/^(RO)(?=HF)|^([RU])(?=[A-Za-z])/i)?.[0];
      if (reference) put('reference-state', '参考态', reference);
    }
    if ((match = text.match(/^Model\s*:\s*(.+)$/i))) put('solvent-model', '溶剂模型', match[1]);
    if (/^Atomic radii\s*:\s*SMD-Coulomb/i.test(text)) put('solvent-model', '溶剂模型', 'SMD');
    if ((match = text.match(/^Solvent\s*:\s*([^,]+)(?:,|$)/i))) put('solvent', '溶剂', match[1].trim());
    if ((match = text.match(new RegExp(String.raw`^Solvent\s*:.*?\bEps\s*=\s*(${SCIENTIFIC_NUMBER})`, 'i')))) put('solvent-epsilon', '溶剂介电常数', scientificNumber(match[1])!, 'dimensionless');
    if (/\bscrf\b/i.test(result.scientific!.route)&&!result.scientific!.summary.some(field=>field.sourceLine===line.number&&field.origin==='input-request'&&(field.key==='solvent-epsilon'||field.key==='solvent-epsilon-infinity'))) {
      if ((match = text.match(new RegExp(String.raw`^Eps\s*=\s*(${SCIENTIFIC_NUMBER})\s*$`, 'i')))) put('solvent-epsilon', '溶剂介电常数', scientificNumber(match[1])!, 'dimensionless');
      if ((match = text.match(new RegExp(String.raw`^Eps(?:Inf|\(infinity\))\s*=\s*(${SCIENTIFIC_NUMBER})\s*$`, 'i')))) put('solvent-epsilon-infinity', '光学介电常数', scientificNumber(match[1])!, 'dimensionless');
    }
    if ((match = text.match(new RegExp(String.raw`^R6Disp:\s*(Grimme-D3(?:\([^)]*\))?)\s+Dispersion energy\s*=\s*(${SCIENTIFIC_NUMBER})\s+Hartrees?\.?$`, 'i')))) {
      put('dispersion', '色散', match[1]);
      const data = result.scientific!, frameIndex = result.frames.filter(frame => frame.sourceLine <= line.number).at(-1)?.index ?? (result.frames.length === 1 ? 0 : null);
      data.properties.push({ key: 'dispersion-energy', label: `${match[1]} 色散修正`, value: scientificNumber(match[2])!, rawValue:match[2],unit: 'hartree', sourceLine: line.number, frameIndex });
    }
    if ((match = text.match(/^Requested convergence on\s+(.+?)\s*=\s*(.+)$/i))) put(`scf-convergence-${match[1].trim().toLowerCase().replace(/\s+/g, '-')}`, `SCF收敛 ${match[1].trim()}`, match[2]);
    if ((match = text.match(/\bNGrid\s*=\s*([+-]?\d+)/))) put('integration-grid-code', 'Gaussian NGrid代码', Number(match[1]));
    if (/^Convergence failure\s*--/i.test(text) && !result.scientific?.diagnostics?.scf.length) put('scf-status', 'SCF状态', 'not-converged');
    if ((match = text.match(/^(Maximum Force|RMS\s+Force|Maximum Displacement|RMS\s+Displacement)\s+\S+\s+(\S+)\s+(?:YES|NO)$/i))) {
      if (scientificNumber(match[2]) !== null) put(`optimization-threshold-${match[1].toLowerCase().replace(/\s+/g, '-')}`, `优化阈值 ${match[1]}`, scientificNumber(match[2])!);
    }
    if (/^Pseudopotential Parameters\s*$/i.test(text)) put('ecp', 'ECP', 'Pseudopotential Parameters block present; named potentials require the saved block');
  } else {
    if ((match = text.match(/^Your calculation utilizes the basis:\s*(.+)$/i))) put('basis', '基组', match[1]);
    if ((match = text.match(/^Your calculation utilizes the auxiliary basis:\s*(.+)$/i))) put('auxiliary-basis', '辅助基组', match[1]);
    if ((match = text.match(/^Your calculation utilizes the (.+?) dispersion correction\.?$/i))) put(dispersionKey(match[1]), '色散', match[1]);
    if ((match = text.match(/^Your calculation utilizes the (.+?) solvation module\.?$/i))) put('solvent-model', '溶剂模型', match[1]);
    if (/^\*?\s*SCF NOT CONVERGED AFTER\s+\d+\s+(?:CYCLES|ITERATIONS)\b/i.test(text)) put('scf-status', 'SCF状态', 'not converged');
    if ((match = text.match(/^Solvent:\s*\.{3}\s*(.+)$/i))) put('solvent', '溶剂', match[1]);
    if ((match = text.match(new RegExp(String.raw`^Epsilon\s+\.{3}\s*(${SCIENTIFIC_NUMBER})\s*$`, 'i')))) put('solvent-epsilon', '溶剂介电常数', scientificNumber(match[1])!, 'dimensionless');
    if (gridContext && (match = text.match(/^(Radial Grid Type|Angular Grid \(max\. ang\.\)|Angular grid pruning method|Int\. Accuracy|Total number of grid points)\s+(.*?)\s*\.{3}\s*(.+)$/i))) put('integration-grid', `积分格点 ${gridContext} ${match[1]}`, match[3]);
    if ((match = text.match(/^(?:Hartree-Fock type|HFTyp)\s*(?:\.{3}|:)\s*(.+)$/i))) put('reference-state', '参考态', match[1]);
    if ((match = text.match(/^(?:Energy Change|Density Change|Max\. Density Change|Orbital Gradient|RMS Gradient|MAX Gradient|RMS step|MAX step)\s+.*?(?:TolE|TolRMSP|TolMaxP|TolG|TolRMSG|TolMaxG|TolRMSD|TolMaxD)\s*\.{3}\s*(.+)$/i))) put('scf-convergence', '收敛阈值', text);
    if ((match = text.match(/^ECP PARAMETER INFORMATION\s*$/i))) put('ecp', 'ECP', match[0]);
  }
}

function isGaussianCounterpoiseResult(result:TrajectoryResult):boolean {
  return result.engine==='gaussian'&&(gaussianRouteTokens(result.scientific?.route??'').some(token=>/^counterpoise(?=$|[=(])/i.test(token))
    ||(result.scientific?.bsse??[]).some(field=>/^cp-component-\d+-role-kind$/.test(field.key)));
}
async function sourceEvidence(file: ResultInputFile, result: TrajectoryResult, kind: PostprocessSource['kind'], options: ResultReadOptions, bounds?: { start: number; end: number }) {
  const observations: PrintedObservation[] = [];
  // Counterpoise fragment responses are not ordinary complex-frame evidence.
  // Reuse the primary parser's proven component identity and source interval;
  // a shared .out, equal geometry or a matching numeric value is insufficient.
  const cp=kind==='gaussian-output'&&isGaussianCounterpoiseResult(result);
  const cpEnds=new Map((result.scientific?.bsse??[]).filter(field=>/^cp-component-\d+-source-end-line$/.test(field.key)&&typeof field.value==='number').map(field=>[field.key.replace(/-source-end-line$/,''),field.value as number]));
  const cpFullRanges=(result.scientific?.bsse??[]).filter(field=>/^cp-component-\d+-role-kind$/.test(field.key)&&field.value==='full-system').flatMap(field=>{const end=cpEnds.get(field.key.replace(/-role-kind$/,''));return end!==undefined&&end>=field.sourceLine?[{start:field.sourceLine,end}]:[];});
  const cpComplexLine=(sourceLine:number)=>!cp||cpFullRanges.some(range=>sourceLine>=range.start&&sourceLine<=range.end);
  const fieldsByLine = new Map<number, ScientificField[]>();
  for (const field of [...(result.scientific?.summary ?? []), ...(result.scientific?.properties ?? [])]) {
    if (typeof field.value === 'number' && energyDefinition(field)) fieldsByLine.set(field.sourceLine, [...(fieldsByLine.get(field.sourceLine) ?? []), field]);
  }
  let coordinateRounding: number | null = null, arrayField = '', arrayRemaining = 0, arrayOffset = 0, moldenAtoms = false, moldenScale = 1;
  const coordinateRoundingByFrame: Record<number, number | null> = {};
  const orbitalIndices = new Map<string, { count: number; virtual: boolean }>();
  let atomicTable: { scheme: string; rows: number; age: number; spin: boolean } | null = null;
  let orcaOrbitalSpin: 'restricted' | 'alpha' | 'beta' = 'restricted', orcaOrbitals = false;
  let moldenMos = false, moldenEnergy: { token: string; line: number } | null = null, moldenSpin = 'alpha';
  const moldenOrdinals = new Map<string, number>();
  let quadrupole: { prefix: string; unit: string; remaining: number } | null = null;
  let gaussianRouteSeen = false, settingsActive = canEnrich(result), gridContext = '', echoBlock = '';
  // Task availability does not govern whether already printed SCF data is readable.
  const needsOrcaScf = kind === 'orca-output';
  let scfMarkerLine = -100, scfColumnCount = 0, scfTable: ScfCycle | null = null;
  const finishScfTable = () => {
    if (scfTable?.points.length && !result.scientific!.scfCycles.some(cycle => cycle.frameIndex === scfTable!.frameIndex && cycle.sourceLine <= scfTable!.sourceLine && cycle.sourceLine >= scfTable!.sourceLine - 6)) result.scientific!.scfCycles.push(scfTable);
    scfTable = null; scfColumnCount = 0;
  };
  const count = result.initialStructure.atoms.length;
  let framePosition = -1;
  let ircSummarySeen = false, savedDensityFrameIndex: number | undefined, normalTermination = false;
  let detachedStart: number | null = null;
  const detachedRanges: {start:number;end:number}[] = [];
  async function* savedLines(){for await(const record of streamFchkRecords(file,options))if(!record.character)yield{text:record.text,number:record.sourceLine,start:record.start,end:record.end};}
  for await (const line of kind==='fchk'?savedLines():outputLines(file, options, ()=>undefined)) {
    if (bounds && line.number < bounds.start) continue;
    if (bounds && line.number >= bounds.end) break;
    if (kind === 'gaussian-output' && /^\s*(?:Standard|Input|Z-Matrix) orientation\s*:/i.test(line.text) || kind === 'orca-output' && /^\s*CARTESIAN COORDINATES\s*\((?:ANGSTROEM|ANGSTROM)\)/i.test(line.text)) detachedStart ??= line.number;
    while (framePosition + 1 < result.frames.length && result.frames[framePosition + 1].sourceLine <= line.number) framePosition++;
    const start = result.frames[framePosition]?.sourceLine ?? -1;
    if (detachedStart !== null && start === line.number) { detachedRanges.push({start:detachedStart,end:line.number}); detachedStart = null; }
    const frameIndex = detachedStart === null ? result.frames[framePosition]?.index ?? null : null;
    const ordinaryResponse=cpComplexLine(line.number);
    if(!ordinaryResponse){atomicTable=null;quadrupole=null;orbitalIndices.clear();}
    if (kind === 'gaussian-output' && result.scientific?.tasks.includes('irc')) {
      if (/Summary of reaction path following/i.test(line.text)) ircSummarySeen = true;
      if (ircSummarySeen && frameIndex !== null && /Copying SCF densities to generalized density/i.test(line.text)) savedDensityFrameIndex = frameIndex;
      if (/Normal termination of Gaussian/i.test(line.text)) normalTermination = true;
    }
    if (kind.endsWith('-output')) {
      const text = line.text.trim();
      if (kind === 'gaussian-output' && /^#[pnt]?(?=\s|$)/i.test(text)) {
        // A combined opt/freq continuation is another job. Do not attach its
        // printed settings to the first job's geometry or electronic state.
        if (gaussianRouteSeen) settingsActive = false;
        else { gaussianRouteSeen = true; if(canEnrich(result))appendGaussianRouteSummary(result.scientific!, result.scientific!.route, line.number, 'input echo'); }
      }
      if (settingsActive&&ordinaryResponse) {
        if (kind === 'orca-output') {
          appendOrcaEchoSettings(result, line);
          const echo = line.text.replace(/^\s*\|\s*\d+>\s*/, '').trim(), isEcho = /^\s*\|\s*\d+>/.test(line.text) || echo.startsWith('%');
          const block = echo.match(/^%(scf|geom|cpcm|method|basis|rel)\b/i)?.[1]?.toLowerCase();
          if (block && isEcho) echoBlock = block;
          if (isEcho && echoBlock) {
            const key = ({ scf: 'scf-settings', geom: 'optimization-settings', cpcm: 'solvent-settings', method: 'integration-settings', basis: 'basis-settings', rel: 'relativistic' } as Record<string, string>)[echoBlock];
            appendOutputSetting(result, line, key, `%${echoBlock} (input echo)`, echo);
            if (echoBlock === 'cpcm' && /\bsmd\s+true\b/i.test(echo)) appendOutputSetting(result, line, 'solvent-model', '溶剂模型 (input echo)', 'SMD');
            const solvent = echoBlock === 'cpcm' ? echo.match(/\bSMDsolvent\s+["']([^"']+)["']/i)?.[1] : undefined;
            if (solvent) appendOutputSetting(result, line, 'solvent', '溶剂 (input echo)', solvent);
            if (/\bend\s*$/i.test(echo)) echoBlock = '';
          }
          if (/^DFT GRID GENERATION\s*$/.test(text)) gridContext = 'DFT';
          else if (/^COSX GRID GENERATION\s*$/.test(text)) gridContext = 'COSX';
          else if (/^GRIDX\s+\d+/.test(text)) gridContext = `COSX ${text}`;
        }
        appendPrintedSettings(result, line, gridContext);
      }
      if (kind === 'gaussian-output' && /Normal termination of Gaussian/i.test(text) || kind === 'orca-output' && /ORCA TERMINATED NORMALLY/i.test(text)) appendOutputSetting(result, line, 'source-normal-termination', '文件正常结束标记', 'yes');
      if(ordinaryResponse)enrichSinglePointLine(result, line, frameIndex);
      if (needsOrcaScf) {
        const trimmed = line.text.trim();
        if (/^-+(?:D-I-I-S|S-O-S-C-F)-+$/.test(trimmed)) scfMarkerLine = line.number;
        if (line.number - scfMarkerLine <= 2 && /^Iteration\s+Energy\s*\(Eh\)\s+Delta-E\s+RMSDP\s+MaxDP\s+(?:DIISErr\s+Damp|MaxGrad)\s+Time\(sec\)$/.test(trimmed)) {
          scfTable ??= { sourceLine: line.number, frameIndex, unit: 'hartree', deltaEnergyUnit: 'hartree', sourceId: file.id, sourceName: file.name, points: [] };
          scfColumnCount = /DIISErr/.test(trimmed) ? 8 : 7;
        } else if (scfTable && scfColumnCount) {
          const columns = trimmed.split(/\s+/);
          if (columns.length === scfColumnCount && /^\d+$/.test(columns[0]) && columns.slice(1).every(token => scientificNumber(token) !== null)) {
            const iteration = Number(columns[0]);
            if (iteration === (scfTable.points.at(-1)?.iteration ?? 0) + 1) scfTable.points.push({ iteration, energy: scientificNumber(columns[1]), deltaEnergy: scientificNumber(columns[2]), sourceLine: line.number });
            else finishScfTable();
          } else if (trimmed && !/^-+|^\*/.test(trimmed)) finishScfTable();
          if (/SCF (?:CONVERGED|NOT CONVERGED)/i.test(trimmed)) finishScfTable();
        }
      }
      if (kind === 'orca-output' && isUnifiedPostprocessSource({ tasks: result.scientific?.tasks ?? [], result })) {
        const explicitState = line.text.replace(/^\s*\|\s*\d+>\s*/, '').match(/^\s*\*\s*xyz(?:file)?\s+([+-]?\d+)\s+(\d+)(?:\s|$)/i);
        if (explicitState) {
          const charge = Number(explicitState[1]), multiplicity = Number(explicitState[2]);
          if (!Number.isSafeInteger(charge) || !Number.isSafeInteger(multiplicity) || multiplicity < 1) throw new PostprocessSourceError('invalid-electronic-state', 'ORCA输入回显的电荷/多重度无效。');
          if (result.initialStructure.charge !== null && result.initialStructure.charge !== charge || result.initialStructure.multiplicity !== null && result.initialStructure.multiplicity !== multiplicity) throw new PostprocessSourceError('electronic-state-conflict', 'ORCA输入回显与输出电荷/多重度冲突。');
          result.initialStructure.charge = charge; result.initialStructure.multiplicity = multiplicity;
        }
      }
      const gaussianOrbital = line.text.match(/^\s*(Alpha|Beta)\s+(occ\.|virt\.)\s+eigenvalues\s*--\s*(.+)$/i);
      if (gaussianOrbital&&ordinaryResponse) {
        const spin = gaussianOrbital[1] === 'Beta' ? 'beta' : result.scientific?.orbitals.some(channel => channel.spin === 'restricted') ? 'restricted' : 'alpha';
        const virtual = gaussianOrbital[2].toLowerCase() === 'virt.', previous = orbitalIndices.get(spin);
        let index = previous && !(previous.virtual && !virtual) ? previous.count : 0;
        for (const token of gaussianOrbital[3].trim().split(/\s+/)) {
          const value = observation(`orbital:${spin}:${++index}:energy`, 'hartree', token, line.number); if (value) observations.push(value);
        }
        orbitalIndices.set(spin, { count: index, virtual });
      }
      if (/^\s*ORBITAL ENERGIES\s*$/i.test(line.text)) orcaOrbitals = true;
      if (orcaOrbitals && /SPIN UP ORBITALS/i.test(line.text)) orcaOrbitalSpin = 'alpha';
      if (orcaOrbitals && /SPIN DOWN ORBITALS/i.test(line.text)) orcaOrbitalSpin = 'beta';
      if (kind === 'orca-output' && orcaOrbitals) {
        const row = line.text.trim().split(/\s+/);
        if (row.length === 4 && /^\d+$/.test(row[0]) && row.slice(1).every(token => scientificNumber(token) !== null)) {
          const value = observation(`orbital:${orcaOrbitalSpin}:${Number(row[0]) + 1}:energy`, 'hartree', row[2], line.number); if (value) observations.push(value);
        } else if (/MULLIKEN|LOEWDIN|CHELPG|HIRSHFELD|FINAL SINGLE POINT|DIPOLE MOMENT/i.test(line.text)) orcaOrbitals = false;
      }
      const atomicHeader = line.text.match(/^\s*(Mulliken (?:charges|atomic charges)(?: and spin densities)?|ESP charges|Hirshfeld charges(?:, spin densities.*)?|MULLIKEN ATOMIC CHARGES(?: AND SPIN POPULATIONS)?|LOEWDIN ATOMIC CHARGES(?: AND SPIN POPULATIONS)?)\s*:?\s*$/i);
      if (atomicHeader&&ordinaryResponse) atomicTable = { scheme: /Mulliken/i.test(atomicHeader[1]) ? 'Mulliken' : /Hirshfeld/i.test(atomicHeader[1]) ? 'Hirshfeld' : /Loewdin/i.test(atomicHeader[1]) ? 'Loewdin' : 'ESP', rows: 0, age: 0, spin: /spin/i.test(atomicHeader[1]) };
      else if (atomicTable) {
        const row = line.text.trim().replace(/:/g, ' ').split(/\s+/), index = Number(row[0]), offset = kind === 'orca-output' ? 0 : 1;
        if (/^\d+$/.test(row[0]) && index === atomicTable.rows + offset && row[1] === result.initialStructure.atoms[atomicTable.rows]?.element && scientificNumber(row[2] ?? '') !== null) {
          const atomIndex = atomicTable.rows++;
          const value = observation(`atomic:charge:${atomicTable.scheme}:${atomIndex}`, 'e', row[2], line.number); if (value) observations.push(value);
          if (atomicTable.spin && row[3]) { const spin = observation(`atomic:spin:${atomicTable.scheme}:${atomIndex}`, 'e', row[3], line.number); if (spin) observations.push(spin); }
          if (atomicTable.rows === count) atomicTable = null;
        } else if (atomicTable.rows || ++atomicTable.age > 6) atomicTable = null;
      }
      // Enrichment is restricted to explicitly labelled two-line Gaussian
      // Cartesian tensors. Ordinary and traceless definitions remain distinct.
      const header = line.text.match(/^\s*(Traceless )?Quadrupole moment \(field-independent basis, (Debye-Ang)\):/i);
      if (header && ordinaryResponse&&isUnifiedPostprocessSource({ tasks: result.scientific?.tasks ?? [], result })) quadrupole = { prefix: header[1] ? 'quadrupole-traceless' : 'quadrupole-ordinary', unit: header[2], remaining: 2 };
      else if (quadrupole) {
        const pairs = [...line.text.matchAll(new RegExp(String.raw`\b(XX|YY|ZZ|XY|XZ|YZ)=\s*(${SCIENTIFIC_NUMBER})`, 'g'))];
        if (pairs.length === 3) for (const pair of pairs) result.scientific!.properties.push({ key: `${quadrupole.prefix}-${pair[1]}`, label: `${quadrupole.prefix} ${pair[1]} (printed)`, value: scientificNumber(pair[2])!, unit: quadrupole.unit, sourceLine: line.number, frameIndex });
        if (--quadrupole.remaining <= 0 || pairs.length !== 3) quadrupole = null;
      }
      for (const field of fieldsByLine.get(line.number) ?? []) {
        const tokens = numberTokens(line.text).filter(token => scientificNumber(token) === field.value);
        if (tokens.length !== 1) continue;
        const value = observation(energyDefinition(field)!, field.unit ?? '', tokens[0], line.number); if (value) observations.push(value);
      }
      if (line.number >= start && line.number < start + count) {
        const columns = line.text.trim().split(/\s+/), tokens = kind === 'gaussian-output' ? columns.slice(3) : columns.slice(1);
        if (tokens.length === 3 && tokens.every(token => scientificNumber(token) !== null)) for (const token of tokens) {
          const rounding = printedRoundingInterval(token) ?? 0;
          coordinateRounding = Math.max(coordinateRounding ?? 0, rounding);
          if (frameIndex !== null) coordinateRoundingByFrame[frameIndex] = Math.max(coordinateRoundingByFrame[frameIndex] ?? 0, rounding);
        }
      }
    } else if (kind === 'fchk') {
      if (line.number === 2 && /^\s*SP\s+/i.test(line.text) && result.scientific && result.scientific.tasks.length === 0) result.scientific.tasks.push('sp');
      const header = line.text.match(/^(.+?)\s+[IR]\s+(?:N=\s*(\d+)\s*|([+-]?[\d.EeDd+-]+)\s*)$/);
      if (header) {
        arrayField = header[1].trim(); arrayRemaining = Number(header[2] ?? 0); arrayOffset = 0;
        if (['SCF Energy', 'MP2 Energy'].includes(arrayField) && header[3]) { const value = observation(`gaussian:${arrayField}`, 'hartree', header[3], line.number,true); if (value) observations.push(value); }
      } else if (arrayRemaining > 0) {
        const tokens = line.text.trim().split(/\s+/); arrayRemaining -= tokens.length;
        if (arrayField === 'Current cartesian coordinates') for (const token of tokens) coordinateRounding = Math.max(coordinateRounding ?? 0, (printedRoundingInterval(normalizedFchkNumber(token)??'') ?? 0) * BOHR_ANGSTROM);
        const orbitalSpin = arrayField === 'Beta Orbital Energies' ? 'beta' : result.scientific?.orbitals.some(channel => channel.spin === 'restricted') ? 'restricted' : 'alpha';
        const scheme = ({ 'Mulliken Charges': 'Mulliken', 'ESP Charges': 'ESP', 'NPA Charges': 'NPA' } as Record<string, string>)[arrayField];
        for (const [index, token] of tokens.entries()) {
          const definition = /^(?:Alpha|Beta) Orbital Energies$/.test(arrayField) ? `orbital:${orbitalSpin}:${arrayOffset + index + 1}:energy` : scheme ? `atomic:charge:${scheme}:${arrayOffset + index}` : null;
          if (definition) { const value = observation(definition, scheme ? 'e' : 'hartree', token, line.number,true); if (value) observations.push(value); }
        }
        arrayOffset += tokens.length;
      }
    } else {
      const section = line.text.match(/^\s*\[([^\]]+)\](.*)$/);
      if (section) { moldenAtoms = /^atoms$/i.test(section[1]); moldenMos = /^mo$/i.test(section[1]); moldenScale = /\bAU\b/i.test(section[2]) ? BOHR_ANGSTROM : 1; }
      else if (moldenAtoms) {
        const tokens = line.text.trim().split(/\s+/);
        if (tokens.length === 6) for (const token of tokens.slice(3)) coordinateRounding = Math.max(coordinateRounding ?? 0, (printedRoundingInterval(token) ?? 0) * moldenScale);
      } else if (moldenMos) {
        const energy = line.text.match(/^\s*Ene\s*=\s*(\S+)\s*$/i), spin = line.text.match(/^\s*Spin\s*=\s*(Alpha|Beta)\s*$/i);
        if (energy) moldenEnergy = { token: energy[1], line: line.number };
        if (spin) moldenSpin = spin[1].toLowerCase();
        if (/^\s*Occup\s*=/i.test(line.text) && moldenEnergy) {
          const spinKey = result.scientific?.orbitals.some(channel => channel.spin === 'restricted') ? 'restricted' : moldenSpin;
          const ordinal = (moldenOrdinals.get(spinKey) ?? 0) + 1; moldenOrdinals.set(spinKey, ordinal);
          const value = observation(`orbital:${spinKey}:${ordinal}:energy`, 'hartree', moldenEnergy.token, moldenEnergy.line); if (value) observations.push(value);
          moldenEnergy = null;
        }
      }
    }
  }
  if (detachedStart !== null) detachedRanges.push({start:detachedStart,end:Infinity});
  finishScfTable();
  // A repeated final population/orbital table supersedes its earlier printing;
  // the result itself still preserves all source observations in ScientificData.
  const available = observations.filter(value => {
    if(!cpComplexLine(value.sourceLine))return false;
    const orbital = value.definition.match(/^orbital:(restricted|alpha|beta):(\d+):energy$/);
    if (orbital) return result.scientific?.orbitals.some(channel => channel.spin === orbital[1] && channel.orbitals.some(item => item.energy === value.value)) ?? false;
    const atomic = value.definition.match(/^atomic:(charge|spin):([^:]+):(\d+)$/);
    if (atomic) return result.scientific?.atomicProperties.some(table => table.kind === atomic[1] && table.scheme.startsWith(atomic[2]) && table.values.some(item => item.atomIndex === Number(atomic[3]) && item.value === value.value)) ?? false;
    return true;
  });
  const frameAtLine = (line: number) => {
    let rangeLow = 0, rangeHigh = detachedRanges.length - 1;
    while (rangeLow <= rangeHigh) { const middle = Math.floor((rangeLow + rangeHigh) / 2), range = detachedRanges[middle]; if (line < range.start) rangeHigh = middle - 1; else if (line >= range.end) rangeLow = middle + 1; else return null; }
    let low = 0, high = result.frames.length - 1, found: number | null = null;
    while (low <= high) { const middle = Math.floor((low + high) / 2); if (result.frames[middle].sourceLine <= line) { found = result.frames[middle].index; low = middle + 1; } else high = middle - 1; }
    return found;
  };
  for (const value of available) value.frameIndex = kind.endsWith('-output') ? frameAtLine(value.sourceLine) : 0;
  const latest = new Map(available.map(value => [`${value.frameIndex}\0${value.definition}\0${value.unit}`, value]));
  return { observations: [...latest.values()], coordinateRoundingAngstrom: coordinateRounding, ...(kind.endsWith('-output') ? { coordinateRoundingByFrame } : {}),
    ...(normalTermination && savedDensityFrameIndex !== undefined ? { savedDensityFrameIndex } : {}) };
}

function bindSourceProvenance(result: TrajectoryResult, file: ResultInputFile): void {
  const science = result.scientific; if (!science) return;
  bindNmrCouplingSource(science.nmrCouplings, file);
  bindMdStepSources(science.mdSteps, file, result.jobIndex);
  for (const field of [...science.summary, ...science.properties, ...science.thermochemistry, ...science.stability, ...science.bsse, ...science.orbitals, ...science.atomicProperties]) {
    field.sourceId = file.id; field.sourceName = file.name;
  }
  for (const cycle of science.scfCycles) { cycle.sourceId = file.id; cycle.sourceName = file.name; cycle.unit ??= 'hartree'; cycle.deltaEnergyUnit ??= 'hartree'; }
}

async function gaussianCombinedOptFreqContinuationLine(file: ResultInputFile, results: readonly TrajectoryResult[], options: ResultReadOptions): Promise<number | null> {
  if (results.length !== 2) return null;
  const [optimization, frequency] = results, first = optimization.initialStructure, second = frequency.initialStructure;
  const continuation = frequency.scientific?.route ?? '', tasks = frequency.scientific?.tasks ?? [];
  const excitedOptimization = optimization.scientific?.tasks.includes('td') ?? false;
  const excitedFrequency = tasks.includes('td');
  const tdOptions = continuation.match(/\bTD\s*(?:=\s*)?\(([^)]*)\)/i)?.[1].split(',').map(value => value.trim().toLowerCase());
  if (!(optimization.engine === 'gaussian' && frequency.engine === 'gaussian'
    && optimization.source.id === frequency.source.id && frequency.jobIndex > optimization.jobIndex
    && frequency.frames.length === 1
    && !!optimization.scientific?.tasks.includes('opt') && !!optimization.scientific?.tasks.includes('freq')
    && tasks.includes('freq') && tasks.every(task => task === 'freq' || task === 'td')
    && excitedOptimization === excitedFrequency
    && (!excitedFrequency || tdOptions?.length === 2 && tdOptions.includes('fc') && tdOptions.includes('read'))
    && /\bGeom\s*=\s*AllCheck\b/i.test(continuation) && /\bGuess\s*=\s*TCheck\b/i.test(continuation) && /\bGenChk\b/i.test(continuation)
    && first.charge !== null && first.charge === second.charge && first.multiplicity !== null && first.multiplicity === second.multiplicity
    && first.atoms.length === second.atoms.length && first.atoms.every((atom, index) => atom.element === second.atoms[index].element))) return null;
  const final = await optimization.getFrame(optimization.frames.length - 1, options.signal);
  // Native AllCheck output repeats the saved final Cartesian geometry. Require
  // that exact printed structure; a common inventory alone proves no continuation.
  if (final.charge !== second.charge || final.multiplicity !== second.multiplicity
    || final.atoms.some((atom, index) => atom.element !== second.atoms[index].element || atom.x !== second.atoms[index].x || atom.y !== second.atoms[index].y || atom.z !== second.atoms[index].z)) return null;
  let nativeBoundary: number | null = null;
  for await (const line of outputLines(file, options, ()=>undefined)) {
    if (line.number >= frequency.frames[0].sourceLine) break;
    const native = line.text.match(/^\s*Link1:\s*Proceeding to internal job step number\s+(\d+)\.\s*$/i);
    // Parser job indices may include a geometry-less internal segment; the
    // native Link1 ordinal, not an inferred array/index increment, is authoritative.
    if (native) nativeBoundary = Number(native[1]) === 2 ? line.number : null;
    else if (/^\s*--Link1--\s*$|^\s*Entering Gaussian System\b/i.test(line.text)) nativeBoundary = null;
  }
  return nativeBoundary !== null && nativeBoundary > optimization.frames.at(-1)!.sourceLine ? nativeBoundary : null;
}

/** Multiple independent jobs are rejected, while a single combined task routes intact. */
export async function readPostprocessOutput(file: ResultInputFile, options: PostprocessOutputReadOptions = {}): Promise<PostprocessSource> {
  const identity = await identifyPostprocessSource(file, options);
  if (identity.kind !== 'gaussian-output' && identity.kind !== 'orca-output') throw new PostprocessSourceError('wrong-source-kind', identity.message ?? '请选择Gaussian或ORCA文本输出。');
  const reused=await options.reuseParsedResults?.();
  const results = reused?await projectPostprocessParsedResults(file,reused):await readScientificResults(file, options);
  return assemblePostprocessOutput(file, identity, results, options);
}

async function assemblePostprocessOutput(file: ResultInputFile, identity: PostprocessSourceIdentity, results: TrajectoryResult[], options: ResultReadOptions): Promise<PostprocessSource> {
  if (identity.kind !== 'gaussian-output' && identity.kind !== 'orca-output') throw new PostprocessSourceError('wrong-source-kind', '几何输出组装只接入已识别的Gaussian或ORCA OUT。');
  try {
    const continuationLine = results.length > 1 ? await gaussianCombinedOptFreqContinuationLine(file, results, options) : null;
    if (results.length !== 1 && continuationLine === null) throw new PostprocessSourceError('multiple-jobs', '来源含多个独立作业或结构状态段；请分别提供单个作业输出，不能自动选作一个分析。');
    if (continuationLine !== null) for (const result of results) result.messages.push(`Gaussian原生OPT/FREQ续段：源行${continuationLine}，AllCheck/TCheck/GenChk与末/首几何、电荷和多重度一致；各job的帧、态、模式及能量分别保留。`);
    const result = results[0];
    const evidence = await sourceEvidence(file, result, identity.kind, options, continuationLine === null ? undefined : { start: 1, end: continuationLine });
    const continuationEvidence = continuationLine !== null ? await sourceEvidence(file, results[1], identity.kind, options, { start: continuationLine + 1, end: Infinity }) : undefined;
    if (result.engine === 'orca' && result.scientific && isUnifiedPostprocessSource({ tasks: result.scientific.tasks, result })) {
      const structure = result.initialStructure, charge = structure.charge, multiplicity = structure.multiplicity;
      if (charge !== null && multiplicity !== null && result.scientific.route) {
        const source = parseOrcaInputSource(result.scientific.route, file.name, result.jobIndex, structure.atoms.length, charge, multiplicity);
        structure.orcaSource = source;
        const getFrame = result.getFrame.bind(result);
        result.getFrame = async (index, signal) => { const frame = await getFrame(index, signal); frame.charge ??= charge; frame.multiplicity ??= multiplicity; frame.orcaSource ??= structuredClone(source); return frame; };
      }
    }
    results.forEach(result => bindSourceProvenance(result, file));
    if (results.length > 1) {
      const disposers = results.map(result => result.dispose.bind(result));
      result.dispose = async () => { await Promise.all(disposers.map(dispose => dispose())); };
    }
    const context=await readNebOutputContext(file,result,options);
    const nebOutputContext=context?{outputId:context.outputId,version:context.version,references:context.references,sourceLines:context.sourceLines}:undefined;
    const ircContext = await readIrcOutputContext(file, result, options);
    const ircOutputContext = ircContext ? { outputId: ircContext.outputId, references: ircContext.references } : undefined;
    return { kind: identity.kind, software: identity.software, result, results, tasks: result.scientific?.tasks ?? [], ...evidence,...(nebOutputContext?{nebOutputContext}:{}), ...(ircOutputContext ? { ircOutputContext } : {}),
      ...(continuationLine===null?{}:{nativeContinuations:[{kind:'gaussian-opt-freq' as const,optimizationResultId:results[0].id,frequencyResultId:results[1].id,evidenceSourceLine:continuationLine}],continuationObservations:continuationEvidence!.observations}) };
  } catch (error) { await Promise.all(results.map(result => result.dispose())); throw error; }
}

/** General file entry. All independent jobs and leases survive until explicit selection/disposal. */
export async function readPostprocessFileOutput(file: ResultInputFile, options: PostprocessOutputReadOptions = {}): Promise<PostprocessFileSource> {
  const identity = await identifyPostprocessSource(file, options);
  if (identity.kind !== 'gaussian-output' && identity.kind !== 'orca-output') throw new PostprocessSourceError('wrong-source-kind', identity.message ?? '请选择Gaussian或ORCA文本输出。');
  const reused = await options.reuseParsedResults?.();
  if (reused) return assemblePostprocessOutput(file, identity, await projectPostprocessParsedResults(file, reused), options);
  const snapshotHash = new VibronicSha256();
  for (let start = 0; start < file.size; start += 1024 ** 2) { const end = Math.min(file.size, start + 1024 ** 2), bytes = await file.readRange(start, end, options.signal); assertResultNotAborted(options.signal); if (bytes.length !== end - start) throw Error('来源建立快照时长度变化。'); snapshotHash.update(bytes); }
  const sha256 = snapshotHash.digest();
  const read = await readScientificFileResults(file, options);
  if (!read.diagnostics.length && (read.results.length === 1 || await gaussianCombinedOptFreqContinuationLine(file, read.results, options) !== null)) return assemblePostprocessOutput(file, identity, read.results, options);
  const jobs = [...read.results, ...read.diagnostics].sort((a, b) => (a.jobIndex ?? -1) - (b.jobIndex ?? -1));
  try {
    const contexts = [];
    for (const job of jobs) { const context = await readIrcOutputContext(file, job, options); if (context) contexts.push({ outputId: context.outputId, references: context.references }); }
    const jobEvidence: Record<string, NonNullable<PostprocessScientificFileSource['jobEvidence']>[string]> = {};
    let startLine = 1, scoped = jobs[0]?.jobIndex === 0;
    const independent = new Set(jobs.map(job => job.jobIndex)).size === jobs.length;
    for (const job of jobs) {
      const terminal = job.scientific?.diagnostics?.termination;
      const endLine = terminal?.sourceLine;
      // A missing native boundary cannot be guessed from the next geometry,
      // filename, input echo, or the last job in the array.
      if (!independent || !scoped || terminal?.status === 'not-observed' || endLine === undefined || endLine < startLine) { scoped = false; continue; }
      if ('frames' in job && job.frames.length && !job.scientific?.centers?.some(center => center.kind !== 'real')) {
        const evidence = await sourceEvidence(file, job, identity.kind, options, { start: startLine, end: endLine + 1 });
        jobEvidence[job.id] = { sourceId: file.id, sourceRevision: sha256, startLine, endLine,
          observations: evidence.observations, coordinateRoundingAngstrom: evidence.coordinateRoundingAngstrom,
          coordinateRoundingByFrame: evidence.coordinateRoundingByFrame };
      }
      startLine = endLine + 1;
    }
    let closed = false;
    return { fileOnly: true, kind: identity.kind, software: identity.software, identity: { id: file.id, name: file.name, size: file.size, sha256 }, jobs,
      ...(jobs.length === 1 ? { selectedJobId: jobs[0].id } : {}), tasks: [...new Set(jobs.flatMap(job => job.scientific?.tasks ?? []))], ircContexts: contexts, jobEvidence,
      async dispose() { if (closed) return; await Promise.all(jobs.map(job => job.dispose())); closed = true; } };
  } catch (error) { await Promise.all(jobs.map(job => job.dispose())); throw error; }
}

/** Metadata is supplied by the native wavefunction reader, never reconstructed here. */
export async function readPostprocessWavefunction(file: ResultInputFile, metadata: WavefunctionMetadata, options: ResultReadOptions = {}): Promise<PostprocessSource> {
  const identity = await identifyPostprocessSource(file, options);
  if (identity.kind !== 'fchk' && identity.kind !== 'molden') throw new PostprocessSourceError('wrong-source-kind', identity.message ?? '请选择FCHK或Molden。');
  if (identity.kind !== metadata.format || metadata.sourceId !== file.id) throw new PostprocessSourceError('metadata-source-mismatch', '波函数元数据与所选来源身份不一致。');
  let result: TrajectoryResult;
  if (identity.kind === 'fchk') {
    const results = await readFchkScientificResult(file, options);
    if (results.length !== 1) { await Promise.all(results.map(row => row.dispose())); throw new PostprocessSourceError('multiple-jobs', 'FCHK须只包含一个已保存结果。'); }
    result = results[0];
    if(result.status==='incomplete'){
      await result.dispose();
      throw new PostprocessSourceError('incomplete-wavefunction','FCHK含损坏或截断字段；完整保存结构和已有数值可通过普通导入查看，但此来源未作为可计算波函数绑定。');
    }
  } else {
    const structure = structuredClone(metadata.structure), science = emptyScientificData();
    science.notices.push('Molden保存原子、基组与MO；不证明作业任务、总能量、正常终止或未保存的电荷/多重度。', ...metadata.messages);
    for (const spin of ['restricted', 'alpha', 'beta'] as const) {
      const orbitals = metadata.orbitals.filter(orbital => orbital.spin === spin && orbital.energy !== null && orbital.occupation !== null);
      if (orbitals.length) science.orbitals.push({ spin, sourceLine: orbitals[0].sourceLine, frameIndex: 0, unit: 'hartree', orbitals: orbitals.map(orbital => ({ index: orbital.displayIndex, energy: orbital.energy!, occupation: orbital.occupation! })) });
    }
    let closed = false;
    result = { id: `${file.id}:molden`, label: `${file.name} · Molden 已保存波函数`, engine: 'structure', kind: 'calculation', jobIndex: 0, status: 'unknown', source: { id: file.id, name: file.name, size: file.size }, messages: [...science.notices], scientific: science, initialStructure: structure,
      frames: [{ index: 0, sourceStep: null, time: null, energy: null, convergence: [], sourceLine: 1 }],
      async getFrame(index, signal) { assertResultNotAborted(signal); if (closed) throw new Error('Molden来源已关闭。'); if (index !== 0) throw new Error('Molden只含一个已保存结构。'); return structuredClone(structure); },
      async dispose() { if (!closed) { closed = true; await file.close?.(); } } };
  }
  try { const evidence = await sourceEvidence(file, result, identity.kind, options); bindSourceProvenance(result, file); return { kind: identity.kind, software: identity.software, result, results: [result], tasks: result.scientific?.tasks ?? [], metadata, ...evidence }; }
  catch (error) { await result.dispose(); throw error; }
}

/** Saved trajectories and modes use the same readers as ordinary workspace import. */
export async function readPostprocessAuxiliary(file:ResultInputFile,options:ResultReadOptions={}):Promise<PostprocessSource> {
  const identity=await identifyPostprocessSource(file,options);
  if(identity.kind!=='xyz'&&identity.kind!=='hess')throw new PostprocessSourceError('wrong-source-kind','请选择已保存的XYZ轨迹或ORCA HESS。');
  const results=await(identity.kind==='xyz'?readXyzTrajectory(file,options):readHessScientificResult(file,options));
  try{
    if(results.length!==1)throw new PostprocessSourceError('multiple-jobs','来源含多个独立结构状态段；请分别提供，不自动选择最后一段。');
    const result=results[0];bindSourceProvenance(result,file);
    return{kind:identity.kind,software:result.source.software??identity.software,result,results,tasks:result.scientific?.tasks??[],observations:[],coordinateRoundingAngstrom:null};
  }catch(error){await Promise.all(results.map(result=>result.dispose()));throw error;}
}

export function postprocessDestination(source: Pick<PostprocessSource, 'tasks' | 'result'>): { engine: 'gaussian' | 'orca' | 'unknown'; task: string; isSinglePoint: boolean } {
  const tasks = source.tasks;
  const route = source.result.scientific?.route ?? '';
  // Gaussian QST is a TS optimization route; keep its original route/tasks as evidence.
  const task = source.result.engine === 'gaussian' && /\bqst[23]\b/i.test(route) ? 'ts'
    :tasks.includes('neb')?'neb':tasks.includes('irc')?'irc':tasks.includes('scan')?'scan':tasks.includes('ts') ? 'ts'
    : tasks.includes('opt') && tasks.includes('td') ? 'tdopt' : tasks.includes('opt') && tasks.includes('freq') ? 'optfreq'
      : tasks.includes('opt') ? 'opt' : tasks.includes('td') ? 'td' : tasks.includes('freq') ? 'freq'
      : tasks.includes('nmr') ? 'nmr' : tasks.includes('stability') ? 'stable' : tasks.includes('bsse') ? 'bsse' : (tasks.includes('sp') ? 'sp'
        :source.result.role==='scan-point-set'?'scan':source.result.role?.startsWith('irc')?'irc':source.result.role?.startsWith('neb')?'neb'
        :source.result.role==='optimization-trajectory'?'opt':source.result.role==='ts-optimization-trajectory'?'ts':source.result.engine==='xyz'?'trajectory':'unknown');
  return { engine: source.result.engine === 'gaussian' || source.result.engine === 'orca' ? source.result.engine : 'unknown', task, isSinglePoint: tasks.length === 1 && tasks[0] === 'sp' };
}

/** Approved process dimensions share presentation while retaining separate source stages. */
export function isUnifiedPostprocessSource(source: Pick<PostprocessSource, 'tasks' | 'result'>): boolean {
  if (/\bqst[23]\b/i.test(source.result.scientific?.route??'') && source.result.engine !== 'gaussian') return false;
  // Printed corrections/ancillary analyses do not revoke an approved primary workflow.
  // Unsupported standalone analyses still route to their own task and remain gated.
  return ['unknown','trajectory','sp','opt','optfreq','ts','scan','irc','neb','freq','td','tdopt','nmr','stable'].includes(postprocessDestination(source).task);
}

/** Read every candidate geometry without mutating the source/native owner.
 * Duplicate geometries need equivalent printed energy evidence to identify a
 * single scientific state; ordering is never used to resolve ambiguity. */
export async function pairPostprocessSourcesForFrames(output: PostprocessSource, wavefunction: PostprocessSource, options: ResultReadOptions = {}): Promise<PostprocessSourcePair> {
  if (!isUnifiedPostprocessSource(output)) throw new PostprocessSourceError('wrong-task', '该任务尚未接入统一来源配对。');
  const matches: PostprocessSourcePair[] = [];
  for (const frame of output.result.frames) {
    assertResultNotAborted(options.signal);
    const structure = await output.result.getFrame(frame.index, options.signal);
    assertResultNotAborted(options.signal);
    try { matches.push(pairAtStructure(output, wavefunction, structure, frame.index)); }
    catch (error) { if (!(error instanceof PostprocessSourceError) || error.code !== 'geometry-mismatch') throw error; }
  }
  if (!matches.length) throw new PostprocessSourceError('geometry-mismatch', '波函数几何与此输出的任何完整结构帧均不匹配。');
  if (matches.length === 1) return matches[0];
  const savedDensity = matches.find(pair => pair.frameIndex === output.savedDensityFrameIndex);
  if (savedDensity && !savedDensity.conflicts.length && output.observations.some(value => value.frameIndex === savedDensity.frameIndex && /^(?:orbital:|atomic:)/.test(value.definition)
    && wavefunction.observations.some(saved => saved.definition === value.definition && saved.unit === value.unit))) {
    savedDensity.notices.push('Gaussian IRC路径汇总后明确重新打印该几何并复制SCF密度；末端布居/轨道与波函数同定义字段一致，按此保存边界确认所属帧。');
    return savedDensity;
  }
  const savedEnergies = wavefunction.observations.filter(value => /^gaussian:(?:SCF|MP2) Energy$/.test(value.definition));
  const energyMatched = matches.filter(pair => {
    const comparable = output.observations.filter(value => value.frameIndex === pair.frameIndex && savedEnergies.some(saved => saved.definition === value.definition && saved.unit === value.unit));
    // A missing observation cannot exclude a geometrically matching frame.
    return !pair.conflicts.some(conflict => comparable.includes(conflict.output));
  });
  if (energyMatched.length === 1 && output.observations.some(value => value.frameIndex === energyMatched[0].frameIndex && savedEnergies.some(saved => saved.definition === value.definition && saved.unit === value.unit))) {
    energyMatched[0].notices.push('多个帧具有相同几何；已按同定义、同单位的打印能量及其精度唯一核对波函数所属帧。');
    return energyMatched[0];
  }
  const candidates = (energyMatched.length ? energyMatched : matches).map(pair => pair.frameIndex);
  throw new PostprocessSourceError('ambiguous-frame-match', `波函数几何匹配多个帧（${candidates.map(index => index + 1).join('、')}），已有来源信息不足以唯一确认所属科学帧；请保留为独立分析。`, candidates);
}

/** Pure pairing: inputs and current session remain untouched on every failure. */
export function pairPostprocessSources(output: PostprocessSource, wavefunction: PostprocessSource): PostprocessSourcePair {
  if (!postprocessDestination(output).isSinglePoint) throw new PostprocessSourceError('wrong-task', '多帧配对须逐帧读取并核对几何。');
  return pairAtStructure(output, wavefunction, output.result.initialStructure, 0);
}

function pairAtStructure(output: PostprocessSource, wavefunction: PostprocessSource, display: Structure, frameIndex: number): PostprocessSourcePair {
  if (!output.kind.endsWith('-output') || !wavefunction.metadata) throw new PostprocessSourceError('invalid-pair', '配对需要OUT主来源与已解析波函数。');
  if(isGaussianCounterpoiseResult(output.result)){
    const science=output.result.scientific!;
    if(!science.bsse.some(field=>/^cp-component-\d+-role-kind$/.test(field.key)&&field.value==='full-system')||!science.properties.some(field=>field.key==='scf-energy'&&field.frameIndex===frameIndex))throw new PostprocessSourceError('cp-complex-owner-unconfirmed','CP来源没有相应complex帧的强原生full-system与SCF证据；未将片段/未知组件或最后CHK冒作complex波函数。');
  }
  if (output.result.engine === 'orca' && wavefunction.kind !== 'molden' || output.result.engine === 'gaussian' && wavefunction.kind !== 'fchk') throw new PostprocessSourceError('engine-mismatch', 'Gaussian输出须配FCHK；ORCA输出须配Molden。');
  if(wavefunction.software&&wavefunction.software!=='unknown'&&wavefunction.software!==output.result.engine)throw new PostprocessSourceError('producer-mismatch','波函数明确生成来源与主OUT软件冲突，未按相同几何强行关联。');
  const source = wavefunction.metadata.structure, notices: string[] = [];
  if (!display.atoms.length || display.atoms.length !== source.atoms.length) throw new PostprocessSourceError('atom-count-mismatch', '来源原子数不一致。');
  if (display.atoms.some((atom, index) => atom.element !== source.atoms[index].element)) throw new PostprocessSourceError('atom-order-mismatch', '来源元素或原子顺序不一致；不会自动重排原子。');
  for (const [key, label] of [['charge', '电荷'], ['multiplicity', '多重度']] as const) {
    const a = display[key], b = source[key];
    if (a !== null && b !== null && a !== b) throw new PostprocessSourceError(`${key}-mismatch`, `来源${label}不一致。`);
    if (a === null || b === null) notices.push(`至少一个来源未保存${label}，无法核对；缺失值保持空缺。`);
  }
  const atoms = (structure: Structure) => structure.atoms.map((atom, index) => ({ ...atom, id: `a${index + 1}` }));
  const fit = superposeViewAtoms({ movingAtoms: atoms(source), referenceAtoms: atoms(display), mappingConfirmed: true });
  if (!fit.ok) throw new PostprocessSourceError(fit.issues[0].code, fit.issues[0].message);
  const roundA = output.coordinateRoundingByFrame ? output.coordinateRoundingByFrame[frameIndex] ?? null : output.coordinateRoundingAngstrom, roundB = wavefunction.coordinateRoundingAngstrom;
  if (roundA === null || roundB === null) throw new PostprocessSourceError('coordinate-precision-missing', '缺少来源坐标打印精度，不能确认两个来源仅有刚体变换。');
  // Each rounded Cartesian vector lies in a cube; compare all atoms after the
  // proper rigid fit. Centering contributes at most a second rounding radius.
  const scale = Math.max(1, ...source.atoms.flatMap(atom => [Math.abs(atom.x), Math.abs(atom.y), Math.abs(atom.z)]), ...display.atoms.flatMap(atom => [Math.abs(atom.x), Math.abs(atom.y), Math.abs(atom.z)]));
  const tolerance = 2 * Math.sqrt(3) * (roundA + roundB) + 128 * Number.EPSILON * scale;
  let maxResidual = 0;
  for (let index = 0; index < source.atoms.length; index++) {
    const atom = source.atoms[index], target = display.atoms[index], point: Vector3 = [atom.x, atom.y, atom.z];
    const transformed = fit.transform.rotation.map((row, axis) => row.reduce((sum, value, column) => sum + value * point[column], fit.transform.translation[axis])) as Vector3;
    maxResidual = Math.max(maxResidual, Math.hypot(transformed[0] - target.x, transformed[1] - target.y, transformed[2] - target.z));
  }
  if (maxResidual > tolerance) throw new PostprocessSourceError('geometry-mismatch', `来源几何不一致；全原子最大残差${maxResidual.toExponential(3)} Å超过打印精度界${tolerance.toExponential(3)} Å。`);
  if (fit.diagnostics.rotationAmbiguous) notices.push('线性/单原子几何的自由旋转无法由原子坐标唯一确定；采用已有确定性刚体变换。');
  // Compare only explicit, equivalently named metadata. Missing fields and
  // general-basis directives cannot establish a disagreement in the actual basis.
  const pm7 = (source: PostprocessSource) => {
    const science = source.result.scientific;
    const declared = gaussianRouteTokens(science?.route ?? '').map(token => token.toLowerCase());
    const printed = (science?.summary ?? []).filter(field => ['method','scf-method'].includes(field.key)).map(field => String(field.value).trim().toLowerCase());
    return declared.includes('pm7') && printed.every(value => /^(?:r|u)?pm7$/.test(value));
  };
  // Gaussian PM7 prints an internal VSTO representation in OUT and ZDO in
  // formchk's saved method header. This exception belongs only to that method;
  // the raw fields remain attached to their independent sources.
  const pm7Representation = output.kind === 'gaussian-output' && wavefunction.kind === 'fchk' && pm7(output) && pm7(wavefunction);
  for (const [key, label] of [['method', '方法'], ['basis', '基组'], ['reference-state', '参考态'], ['solvent', '溶剂'], ['solvent-model', '溶剂模型']] as const) {
    const values = (item: PostprocessSource) => [...new Set((item.result.scientific?.summary ?? []).filter(field => field.key === key && typeof field.value === 'string').map(field => String(field.value)))];
    const normalize = (value: string) => {
      if (key === 'basis') return canonicalBasis(value.replace(/\s+\((?:[567]\w|10F)[^)]*\)\s*$/i, '')).toLowerCase();
      if (key === 'method') return value.toLowerCase().replace(/^(?:ro|r|u)(?=hf|b3|m0|pbe|cam|wb|tps|bly|bp86)/, '');
      return value.trim().replace(/\.$/, '').toLowerCase();
    };
    const a = values(output), b = values(wavefunction), comparable = (value: string) => key !== 'basis' || !/^(?:gen|genecp)$/i.test(value);
    const normalizedA = a.filter(comparable).map(normalize), normalizedB = b.filter(comparable).map(normalize);
    if (key === 'basis' && pm7Representation && normalizedA.length === 1 && normalizedA[0] === 'vsto-6g' && normalizedB.length === 1 && normalizedB[0] === 'zdo') continue;
    if (normalizedA.length && normalizedB.length && !normalizedA.some(value => normalizedB.includes(value))) notices.push(`来源${label}记录不一致：OUT ${a.join(' / ')}；波函数 ${b.join(' / ')}。保留各自来源，主显示仍以OUT为准。`);
  }
  const conflicts: PostprocessSourcePair['conflicts'] = [];
  const continuation = frameIndex === output.result.frames.at(-1)?.index ? output.nativeContinuations?.find(item => item.optimizationResultId === output.result.id) : undefined;
  const comparisonResultId = continuation && output.continuationObservations ? continuation.frequencyResultId : undefined;
  const compared = comparisonResultId ? output.continuationObservations! : output.observations.filter(value => value.frameIndex === frameIndex || output.result.frames.length === 1 && value.frameIndex == null);
  if (comparisonResultId) notices.push('按已验证Gaussian原生Opt→Freq续段的保存波函数阶段核对数值；优化和频率原始字段分别保留。');
  const latest = new Map(compared.map(value => [`${value.definition}\0${value.unit}`, value]));
  for (const saved of wavefunction.observations) {
    const printed = latest.get(`${saved.definition}\0${saved.unit}`); if (!printed) continue;
    const roundoff = 4 * Number.EPSILON * Math.max(1, Math.abs(saved.value), Math.abs(printed.value));
    if (Math.abs(saved.value - printed.value) > saved.rounding + printed.rounding + roundoff) conflicts.push({ definition: saved.definition, unit: saved.unit, output: printed, wavefunction: saved });
  }
  if (conflicts.length) notices.push(`几何及原子身份已匹配；${conflicts.length}项同定义打印数值不一致，保留两个文件槽和各自数值，不合并波函数性质或开放依赖一致电子态的分析。`);
  return { primary: output, wavefunction, frameIndex, ...(comparisonResultId ? { comparisonResultId } : {}), sourceToDisplay: fit.transform, maxResidualAngstrom: maxResidual, coordinateToleranceAngstrom: tolerance, notices, conflicts };
}

/** A detached modeling copy preserves unknown q/M and every source note. */
export function extractPostprocessModel(source: PostprocessSource, companion?: PostprocessSource): Structure {
  const structure = structuredClone(source.result.initialStructure);
  for (const item of [source, ...(companion ? [companion] : [])]) {
    structure.notes.push(`后处理来源：${item.result.source.name} (${item.kind})；状态 ${item.result.status}。`);
    if (item !== source) structure.notes.push(...item.result.initialStructure.notes);
  }
  const gaussianSources = [source, ...(companion ? [companion] : [])].flatMap(item => [item.result.initialStructure.gaussianSource, ...(item.result.initialStructure.gaussianSources ?? [])]).filter((item): item is NonNullable<typeof item> => !!item);
  if (gaussianSources.length) structure.gaussianSources = [...new Map(gaussianSources.map(item => [item.id, structuredClone(item)])).values()];
  return structure;
}
