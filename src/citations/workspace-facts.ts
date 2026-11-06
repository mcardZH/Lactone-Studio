import { gaussianRouteTokens, parseGaussianSource, type GaussianSourceMeta } from '../core/gaussian-source';
import { parseOrcaInputSource, orcaSourceLine } from '../core/orca/input-source';
import { canonicalBasis, METHODS } from '../core/catalog';
import { getOrcaMethods } from '../core/orca/catalog';
import type { Structure } from '../core/types';
import type { WorkspaceDocumentEntry } from '../modeling/workspace-registry';
import type { PostprocessDocument,PostprocessScientificFileDocument } from '../results/postprocess-document';
import type { PostprocessSource,PostprocessScientificFileSource } from '../results/postprocess-sources';
import type { TrajectoryResult,ResultDiagnosticSnapshot } from '../results/contracts';
import type { CitationFact, CitationFactEvidence } from './types';
import { normalizeSelector, stableToken } from './identity';
import {assertStructureInteractionContext,interactionUsesStructure} from '../results/interaction-structure-context';
import type {ModelDocument} from '../modeling/contracts';
import type {SurfaceContext} from '../results/surface-contracts';

export interface GeneratedInputCitationReceipt {
  engine: 'gaussian' | 'orca'; text: string; documentId: string; receiptId: string; sourceName: string;
}
export interface WorkspaceCitationFactsOptions {
  documents: readonly WorkspaceDocumentEntry[];
  postprocessDocuments?: Readonly<Record<string, PostprocessDocument>>;
  fileDocuments?: Readonly<Record<string,PostprocessScientificFileDocument>>;
  additionalPostprocessDocuments?:readonly {documentId:string;document:PostprocessDocument}[];
  generated?: readonly CitationFact[]; inputReceipts?: readonly CitationFact[];
  /** Decoded, already retained scientific snapshots. No owners are invoked here. */
  analysis?: unknown;
  /** AdvancedControllerState (or its persisted {tasks} representation). */
  advanced?: unknown;
  analysisInstances?:readonly RetainedCitationAnalysisInstance[];
}
export interface RetainedCitationAnalysisInstance {documentId:string;analysisId:string;sourceId:string;sourceRevision:string;kind:string;structureOnly?:boolean}
/** Both model documents and geometry-free file documents are real owners. */
export function retainedCitationOwnerIds(documents:readonly {id:string}[],fileDocuments:Readonly<Record<string,PostprocessScientificFileDocument>>={}):string[]{
 return [...new Set([...documents.map(document=>document.id),...Object.values(fileDocuments).map(document=>document.id)])];
}
export function citationDocumentIdFromScope(scope:readonly unknown[]):string|undefined{
 const index=scope.findIndex(value=>value==='document'||value==='scientific-file'),id=index<0?undefined:scope[index+1];
 return typeof id==='string'?id:undefined;
}
type CitationJob=TrajectoryResult|ResultDiagnosticSnapshot;
type CitationSource=Pick<PostprocessSource,'software'|'metadata'>|Pick<PostprocessScientificFileSource,'software'>;
const jobState=(job:CitationJob)=>job.kind==='diagnostic'?{charge:job.charge,multiplicity:job.multiplicity}:{charge:job.initialStructure.charge,multiplicity:job.initialStructure.multiplicity};
/** No byte reads, frames, geometry creation or runtime handles. A modal's
 * snapshot is revoked when retained metadata or companion identity changes. */
export function scientificFileCitationIdentity(documents:Readonly<Record<string,PostprocessScientificFileDocument>>):unknown[]{
 const job=(value:CitationJob)=>[value.id,value.source,value.jobIndex,value.kind==='diagnostic'?value.segmentIndex:null,value.status,jobState(value),value.scientific?.version,value.scientific?.route,value.scientific?.tasks,value.scientific?.summary,value.scientific?.properties];
 const source=(value:PostprocessSource|PostprocessScientificFileSource)=>'fileOnly'in value?[value.kind,value.software,value.identity,value.selectedJobId,value.jobs.map(job)]:[value.kind,value.software,value.metadata?.sourceId,value.metadata?.sourceRevision,job(value.result),value.results.map(job)];
 return Object.values(documents).map(document=>[document.id,source(document.output.source),document.wavefunction?source(document.wavefunction.source):null,(document.companions??[]).map(item=>[item.role,source(item.source)]),document.displayResult?.id??null,(document.extraSources??[]).map(item=>[item.sourceId,item.revision,item.byteSize,item.role])]);
}
/** Read the same persisted instance list used by AnalysisWorkspace. Hidden or
 * detached instances remain present; a real close removes the instance. */
export function retainedCitationAnalysisInstances(snapshot:{values:Record<string,unknown>},ownerAliases:Readonly<Record<string,string>>={}):RetainedCitationAnalysisInstance[]{
 const result:RetainedCitationAnalysisInstance[]=[];
 const structureOwners=new Map<string,{id:string;context:SurfaceContext}[]>();
 for(const [key,value]of Object.entries(snapshot.values))try{const scope=JSON.parse(key) as unknown[],doc=scope.indexOf('document');if(doc<0||scope.at(-1)!=='structure-interaction-citation-owners'||!Array.isArray(value))continue;const documentId=String(scope[doc+1]);structureOwners.set(documentId,value.filter(owner=>owner&&typeof owner.id==='string'&&owner.context?.documentId===documentId&&owner.context?.sourceId===`model:${documentId}`&&typeof owner.context?.sourceRevision==='string'));}catch{/* Only the explicit structure-owner snapshot is relevant. */}
 for(const [key,value]of Object.entries(snapshot.values))try{
  const scope=JSON.parse(key) as unknown[],at=scope.indexOf('analysis-workspace'),owner=citationDocumentIdFromScope(scope),state=value as {instances?:{id:string;kind:string}[]};
  if(at<0||scope.at(-1)!=='state'||!Array.isArray(state?.instances))continue;
  const raw=String(scope[at+1]);
  if(owner&&raw===owner){
   const documentId=owner;if(state.instances.some(instance=>instance.kind==='interaction'))for(const owner of structureOwners.get(documentId)??[])result.push({documentId,analysisId:owner.id,sourceId:owner.context.sourceId,sourceRevision:owner.context.sourceRevision,kind:'interaction',structureOnly:true});
   continue;
  }
  const source=JSON.parse(raw) as unknown[];if(typeof source[1]!=='string')continue;const candidate=owner??String(source[0]),documentId=ownerAliases[candidate]??candidate;
  for(const instance of state.instances)if(typeof instance.id==='string')result.push({documentId,analysisId:instance.id,sourceId:source[1],sourceRevision:typeof source[2]==='string'?source[2]:source[1],kind:instance.kind});
 }catch{/* Unrelated UI scope is not an analysis owner. */}
 return result;
}
type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer) ? value as Bag : undefined;
const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
function producer(value?: string): string | undefined {
  if (!value || /^(unknown|xyz|structure)$/i.test(value)) return undefined;
  const known: Record<string, string> = { gaussian: 'Gaussian', orca: 'ORCA', multiwfn: 'Multiwfn', xtb: 'xTB', 'native-xtb': 'xTB', 'xtb-aiss': 'xTB', tblite: 'tblite', ase: 'ASE', rdkit: 'RDKit' };
  return known[value.toLowerCase()] || value;
}
/** Canonicalize only catalogued aliases; a custom label stays explicit. */
export function normalizeCitationMethod(value: string, software?: string): string {
  const raw = value.trim(), lower = raw.toLowerCase();
  // Gaussian's native SCF label separates the already catalogued TPSS
  // exchange/correlation names; do not erase arbitrary method punctuation.
  if (software === 'Gaussian' && /^(?:[ru])?tpss-tpss$/.test(lower)) return 'tpss';
  const exactAliases:Record<string,string>={'ωb97x-d':'wb97xd','wb97x-d':'wb97xd','ωb97x-d3':'wb97x-d3','m06-2x':'m062x'};
  if(exactAliases[lower])return exactAliases[lower];
  const xtb: Record<string, string> = { gfn0: 'gfn0-xtb', 'gfn0-xtb': 'gfn0-xtb', gfn1: 'gfn1-xtb', 'gfn1-xtb': 'gfn1-xtb', gfn2: 'gfn2-xtb', xtb2: 'gfn2-xtb', 'gfn2-xtb': 'gfn2-xtb', gfnff: 'gfn-ff', 'gfn-ff': 'gfn-ff' };
  if (xtb[lower]) return xtb[lower];
  if (software === 'ORCA') {
    const match = getOrcaMethods('6.1').find(m => m.id === lower || m.keywords[0].toLowerCase() === lower.replace(/^m06-2x$/, 'm062x'));
    if (match) return match.id;
  }
  const stripped = lower.replace(/^[ru](?=b3lyp|m062x|pbe1pbe|cam-b3lyp|wb97xd|tpsstpss|tpssh)/, '');
  return METHODS.find(m => m.id === stripped || m.keyword.toLowerCase() === stripped)?.id || lower;
}
/** Citation selectors use printed def2 spelling, independently of Gaussian's
 * internal catalog IDs. Only the observed pure-shell suffix is an alias;
 * diffuse/auxiliary/custom definitions retain their distinct labels. */
function citationBasis(value: string): string {
  const raw = value.trim();
  const base = /^def2-?TZVP\s*\(\s*5D\s*,\s*7F\s*\)$/i.test(raw) ? 'def2TZVP' : raw;
  const canonical = canonicalBasis(base);
  const known = canonical.match(/^def2(SVP|TZVP|TZVPP|QZVP|QZVPP|SVPD|TZVPD|TZVPPD|QZVPD|QZVPPD)$/i);
  return known ? `def2-${known[1].toUpperCase()}` : canonical;
}
const normalizedDispersion = (v: string) => ({ gd3: 'd3', gd3bj: 'd3bj', d3zero: 'd3' })[v.toLowerCase() as 'gd3'] || v.toLowerCase();
function addFact(output: CitationFact[], base: Omit<CitationFact, 'id' | 'feature'>, feature: string, method?: string, suffix = '') {
  output.push({ ...base, feature, method, id: `citation:${stableToken(JSON.stringify([base.documentId, base.sourceId, base.jobId, base.frameId, base.taskId, base.stage, base.kind, feature, method, base.software, base.version, suffix]))}` });
}
function gaussianFacts(meta: GaussianSourceMeta, base: Omit<CitationFact, 'id' | 'feature'>, output: CitationFact[]) {
  const route = meta.route || '';
  const external = /\bexternal\s*(?:=|\()/i.test(route), oniom = /\boniom\s*(?:=|\()/i.test(route);
  const method = meta.settings.method === 'custom' ? meta.settings.customMethod : meta.settings.method;
  if (external || oniom || !method) addFact(output, base, 'method', external ? 'unknown-external' : oniom ? 'unknown-oniom-levels' : 'unknown');
  else addFact(output, base, 'method', normalizeCitationMethod(method, 'Gaussian'));
  if (meta.settings.basis) addFact(output, base, 'basis', /^(gen|genecp)$/i.test(meta.settings.basis) ? 'unknown-custom-basis' : citationBasis(meta.settings.basis));
  if (meta.settings.dispersion && meta.settings.dispersion !== 'none') addFact(output, base, 'dispersion', normalizedDispersion(meta.settings.dispersion));
  const tokens = gaussianRouteTokens(route);
  const scrf = tokens.find(t => /^scrf(?:\b|=|\()/i.test(t));
  if (scrf) {
    const model = /\bsmd\b/i.test(scrf) ? 'smd' : /\biefpcm\b/i.test(scrf) ? 'iefpcm' : /\bcpcm\b/i.test(scrf) ? 'cpcm' : 'unknown-solvation';
    addFact(output, { ...base, parameters: { ...base.parameters, solvent: meta.settings.solvent || '', raw: scrf } }, 'solvation', model);
  }
}
function orcaFacts(text: string, name: string, jobIndex: number, base: Omit<CitationFact, 'id' | 'feature'>, output: CitationFact[]) {
  // Charge, multiplicity and atom count are only constraint-parser context here;
  // none are exported as scientific observations or inferred from these sentinels.
  const source = parseOrcaInputSource(text, name, jobIndex, 0, 0, 1), level = source.level;
  addFact(output, base, 'method', level.method ? normalizeCitationMethod(level.method, 'ORCA') : `unknown:${source.keywords.join(' ') || 'method'}`);
  if (level.basis) addFact(output, base, 'basis', level.basis);
  else if (level.basisKeyword || source.issues.some(i => i.field === 'basis')) addFact(output, base, 'basis', `unknown:${level.basisKeyword || 'basis'}`);
  if (level.dispersion && !['none', 'builtin'].includes(level.dispersion)) addFact(output, base, 'dispersion', normalizedDispersion(level.dispersion));
  if (level.solvent) addFact(output, { ...base, parameters: { ...base.parameters, solvent: level.solvent.name } }, 'solvation', level.solvent.model);
  else if (source.issues.some(i => i.field === 'solvent')) addFact(output, base, 'solvation', 'unknown-solvation');
  // Only native text actually printed in this job is evidence. Form defaults,
  // comments, filenames and method families never imply a fitting approximation.
  for(const keyword of source.keywords){
    if(/^RIJCOSX$/i.test(keyword))addFact(output,base,'method','rijcosx');
    if(/^def2\/J$/i.test(keyword))addFact(output,base,'basis','def2/J');
    else if(/^(?:def2-[A-Za-z0-9+()-]+|cc-[A-Za-z0-9+()-]+)\/(?:C|JK)$/i.test(keyword))addFact(output,base,'basis',keyword);
  }
  const clean=text.split(/\r?\n/).map(orcaSourceLine).join('\n');
  for(const block of clean.matchAll(/%basis\b([\s\S]*?)^\s*end\b/gim))for(const aux of block[1].matchAll(/^\s*(AuxC|AuxJ|AuxJK)\s+["']([^"']+)["']\s*$/gim))addFact(output,{...base,parameters:{...base.parameters,auxiliaryRole:aux[1]}},'basis',/^def2\/j$/i.test(aux[2])?'def2/J':aux[2]);
}
/** Call only after successful export; the actual edited text is authoritative. */
export function captureGeneratedInputFacts(receipt: GeneratedInputCitationReceipt): CitationFact[] {
  const output: CitationFact[] = [], software = receipt.engine === 'gaussian' ? 'Gaussian' : 'ORCA';
  const jobs = receipt.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(receipt.engine === 'gaussian' ? /^\s*--Link1--\s*$/im : /^\s*\$new_job\s*$/im);
  jobs.forEach((text, index) => {
    const evidence: CitationFactEvidence[] = [{ kind: 'generated-input', locator: `${receipt.receiptId}:${receipt.sourceName}:job:${index}`, detail: '实际成功导出的输入文本；输入准备，无运行证据' }];
    const base = { documentId: receipt.documentId, sourceId: receipt.receiptId, jobId: String(index), kind: 'generated-input' as const, software, evidence, purpose: '已导出输入准备；无运行证据' };
    addFact(output, base, 'software', software);
    try {
      if (receipt.engine === 'orca') orcaFacts(text, receipt.sourceName, index, base, output);
      else {
        const lines = text.split('\n'), start = lines.findIndex(line => /^\s*#/.test(line));
        let route = '';
        if (start >= 0) for (let i = start; i < lines.length && lines[i].trim(); i++) route += ` ${lines[i].trim()}`;
        gaussianFacts(parseGaussianSource(route.trim(), 'gjf', receipt.sourceName, index), base, output);
      }
    } catch (error) { addFact(output, { ...base, parameters: { parseError: error instanceof Error ? error.message : String(error) } }, 'method', 'unknown-input'); }
  });
  return output;
}

function libraryFacts(structure: Structure, documentId: string, output: CitationFact[], suffix = '') {
  const p = structure.libraryProvenance;
  if (!p) {
    if(/^cif$/i.test(structure.format)||/^cif$/i.test(structure.periodicWorkingSource?.format||''))addFact(output,{documentId,sourceId:`cif:${structure.id}`,kind:'data-source',evidence:[{kind:'metadata',locator:`${structure.id}:format`,detail:'CIF结构未保留可证明的数据库/原论文来源'}],purpose:'CIF结构来源待补充；格式不能证明数据库'},'data-source','unknown-cif-database',suffix);
    return;
  }
  const name = p.source.name, canonical = /crystallography open database|^cod$/i.test(name) ? 'cod' : /materials project/i.test(name) ? 'materials-project' : /pubchem/i.test(name) ? 'pubchem' : normalizeSelector(name);
  addFact(output, { documentId, sourceId: `library:${p.entryId}`, kind: 'data-source', software: name, version: p.source.version,
    evidence: [{ kind: 'metadata', locator: `libraryProvenance:${p.entryId}:${p.source.recordId}`, detail: JSON.stringify(p.source) }],
    parameters: { recordId: p.source.recordId, url: p.source.url, doi: p.source.doi || '', citation:p.source.citation||'', entryId: p.entryId },
    purpose: `结构来源：${p.name}；保留原记录${p.source.recordId}` }, 'data-source', canonical, suffix);
}
function modelingMDFacts(structure:Structure,documentId:string,output:CitationFact[],suffix:string):boolean {
  const md=structure.preparation?.md;
  if(!md)return false;
  // A new receipt is independent of a numeric energy in the current geometry.
  // A stopped native restart can retain a valid frame with no final potential.
  if(md.schema!==1 || !str(md.documentId) || !Number.isSafeInteger(md.sourceRevision) || md.sourceRevision<0
    || !Number.isSafeInteger(md.frameSeq) || md.frameSeq<0 || !Number.isSafeInteger(md.step) || md.step<0 || !Number.isFinite(md.timeFs) || md.timeFs<0
    || !Array.isArray(md.software))return true;
  const native=md.driver==='native-xtb-md',ase=md.driver==='ase-rdkit';
  if(!native&&!ase)return true;
  const raw=md.native?.rawPotential;
  const rawExecuted=Boolean(raw&&Number.isFinite(raw.value)&&raw.unit==='hartree'&&raw.sourceArtifact==='xtb.trj'
    &&Number.isSafeInteger(raw.sourceStep)&&raw.sourceStep>=0&&raw.sourceStep<=md.step&&raw.sourceTimeFs===raw.sourceStep*2);
  if(native && (!['gfn0','gfn1','gfn2','gfnff'].includes(md.method) || md.native?.dtFs!==2 || md.timeFs!==md.step*2 || md.step===0&&!rawExecuted))return true;
  if(ase && (md.step<=0 || !['mmff94','mmff94s','uff'].includes(md.method.toLowerCase())))return true;
  const software=native?'xTB':'RDKit',observed=md.software.find(item=>item?.name===software);
  if(!observed)return true;
  const base={documentId,sourceId:`md:${md.documentId}:${md.sourceRevision}`,frameId:String(md.frameSeq),stage:'modeling-md',kind:'model-operation' as const,
    software,version:str(observed.version),evidence:[{kind:'metadata' as const,locator:`${structure.id}:preparation:md`,detail:JSON.stringify(md)}],purpose:'保留的建模MD实际运行帧；方法、版本与原始输入来源分别记录'};
  addFact(output,base,'method',normalizeCitationMethod(md.method,software),suffix);
  // The driver determines which observed producers did scientific work. Native
  // xTB does not gain an ASE integrator citation from importing unit constants.
  for(const name of native?['xTB']:['RDKit','ASE']){
    const actual=md.software.find(item=>item?.name===name);if(!actual)continue;
    const source={...base,software:name,version:str(actual.version)};
    addFact(output,source,'software',name,suffix);
    addFact(output,{...source,kind:'runtime-dependency'},'runtime-dependency',name,suffix);
  }
  return true;
}
function structureSourceFacts(structure: Structure, documentId: string, output: CitationFact[], suffix = '') {
  libraryFacts(structure, documentId, output, suffix);
  const metas = structure.gaussianSources?.length ? structure.gaussianSources : structure.gaussianSource ? [structure.gaussianSource] : [];
  for (const meta of metas) {
    const base = { documentId, sourceId: `source:${meta.id}`, jobId: String(meta.jobIndex), kind: meta.format === 'gjf' ? 'generated-input' as const : 'retained-result' as const,
      software: 'Gaussian', evidence: [{ kind: 'source' as const, locator: `${meta.fileName}:job:${meta.jobIndex}`, detail: meta.route }], purpose: meta.format === 'gjf' ? '保留的输入来源；无运行证据' : '保留结构的原始科学来源' };
    addFact(output, base, 'software', 'Gaussian', suffix); gaussianFacts(meta, base, output);
  }
  if (structure.orcaSource) {
    const meta = structure.orcaSource;
    const base = { documentId, sourceId: `source:${meta.id}`, jobId: String(meta.jobIndex), kind: 'generated-input' as const, software: 'ORCA', evidence: [{ kind: 'source' as const, locator: `${meta.fileName}:job:${meta.jobIndex}`, detail: '保留的ORCA输入来源，未据此推定运行' }], purpose: '保留结构的输入来源；无运行证据' };
    addFact(output, base, 'software', 'ORCA', suffix); orcaFacts(meta.rawInput, meta.fileName, meta.jobIndex, base, output);
  }
  if (!modelingMDFacts(structure,documentId,output,suffix) && structure.preparation?.forcefield && typeof structure.preparation.after === 'number' && Number.isFinite(structure.preparation.after)) {
    addFact(output, { documentId, sourceId: structure.id, kind: 'model-operation', evidence: [{ kind: 'metadata', locator: `${structure.id}:preparation`, detail: JSON.stringify(structure.preparation) }], purpose: '保留模型的力场准备' }, 'method', structure.preparation.forcefield.toLowerCase());
  }
}
function resultFacts(result: CitationJob, documentId: string, output: CitationFact[], source?: CitationSource) {
  const software = producer(source?.software || result.source.software || result.engine), data = result.scientific;
  const state=jobState(result),segment=result.kind==='diagnostic'?result.segmentIndex:undefined,revision=source&&'metadata'in source?source.metadata?.sourceRevision:undefined;
  const base = { documentId, sourceId: result.source.id, jobId: result.jobIndex==null?undefined:String(result.jobIndex),stage:segment==null?undefined:`source-segment:${segment}`,kind: 'retained-result' as const, software, version: data?.version || undefined,
    parameters:{charge:state.charge??'unknown',multiplicity:state.multiplicity??'unknown',sourceRevision:revision??result.source.sha256??result.source.id},
    evidence: [{ kind: 'source' as const, locator: `${result.source.name}:job:${result.jobIndex??'unknown'}${segment==null?'':`:segment:${segment}`}`, detail: `status=${result.status}; source=${result.source.id}; job=${result.id}; charge=${state.charge??'unknown'}; multiplicity=${state.multiplicity??'unknown'}; version=${data?.version??'unknown'}` }], purpose: '保留的已读取科学来源；终止与收敛状态独立' };
  if (software) addFact(output, base, 'software', software);
  let methodFound = false;
  for (const row of [...(data?.summary || []), ...(data?.properties || [])]) {
    if (typeof row.value !== 'string' || !row.value.trim()) continue;
    const feature = /^(?:method|printed-method)$/i.test(row.key) ? 'method'
      : /^(?:basis|printed-orbital-basis)$/i.test(row.key) ? 'basis'
      : row.key === 'dispersion' ? 'dispersion' : row.key === 'solvent-model' ? 'solvation' : undefined;
    if (!feature || feature === 'dispersion' && /^(none|no|off)$/i.test(row.value)) continue;
    if (feature === 'method') methodFound = true;
    const value = feature === 'method' ? normalizeCitationMethod(row.value, software) : feature === 'basis' ? citationBasis(row.value) : feature === 'dispersion' ? normalizedDispersion(row.value) : row.value.toLowerCase();
    addFact(output, { ...base, sourceId: row.sourceId || base.sourceId, frameId: row.frameIndex == null ? undefined : String(row.frameIndex), evidence: [{ kind: 'source', locator: `${row.sourceName || result.source.name}:line:${row.sourceLine}:job:${result.jobIndex}`, detail: `${row.key}=${row.value}; origin=${row.origin || 'source'}` }] }, feature, value);
  }
  if (data?.route) {
    if (software === 'Gaussian') { const meta = parseGaussianSource(data.route, 'out', result.source.name, result.jobIndex??0); gaussianFacts(meta, base, output); methodFound ||= Boolean(meta.settings.method); }
    else if (software === 'ORCA') { orcaFacts(data.route, result.source.name, result.jobIndex??0, base, output); methodFound = true; }
  }
  if (!methodFound && software) addFact(output, base, 'method', 'unknown');
  if(result.kind!=='diagnostic')libraryFacts(result.initialStructure, documentId, output);
}

/** Visit only retained data. No I/O, native execution, form state or cache restoration. */
export function collectWorkspaceCitationFacts(options: WorkspaceCitationFactsOptions): CitationFact[] {
  const output: CitationFact[] = [], documentIds = new Set(retainedCitationOwnerIds(options.documents,options.fileDocuments));
  const sourceOwners = new Map<string, Set<string>>();
  const documentAliases=new Map<string,string>();
  const analysisSources=new Map<string,AnalysisCitationSource>();
  for (const entry of options.documents) {
    const model = entry.store.getSnapshot();
    const valid={ids:new Set<string>(),revisions:new Set<string>(),pairs:new Set<string>(),revision:model.revision,available:!entry.analysisBinding||model.analysisBindingId===entry.analysisBinding.id,trajectory:Boolean(entry.trajectory),bound:Boolean(entry.analysisBinding&&model.analysisBindingId===entry.analysisBinding.id)};analysisSources.set(entry.id,valid);
    structureSourceFacts(model.draft.structure, entry.id, output);
    if (model.bondOrderObservation) {
      const b = model.bondOrderObservation, software = producer(b.engine);
      const base = { documentId: entry.id, sourceId: b.runId, kind: 'model-operation' as const, software, version: b.version,
        evidence: [{ kind: 'metadata' as const, locator: `${entry.id}:bondOrderObservation:${b.runId}`, detail: `engine=${b.engine}; method=${b.method}; definition=${b.definition}` }], purpose: '保留的GFN2键级观测与辅助连接' };
      addFact(output, base, 'method', normalizeCitationMethod(b.method, software));
      if (software) addFact(output, { ...base, kind: 'runtime-dependency' }, 'runtime-dependency', software);
    }
    if (entry.derivation?.sourceStructure) structureSourceFacts(entry.derivation.sourceStructure, entry.id, output, 'ancestor');
    const posts = [options.postprocessDocuments?.[entry.id],...(options.additionalPostprocessDocuments??[]).filter(row=>row.documentId===entry.id).map(row=>row.document)].filter((post):post is PostprocessDocument=>Boolean(post));
    for(const post of posts){documentAliases.set(post.id,entry.id);const revision=post.wavefunction?.source.metadata?.sourceRevision??post.result.source.id;valid.pairs.add(JSON.stringify([post.result.source.id,revision]));}
    const sources = posts.flatMap(post=>[post.output?.source, post.wavefunction?.source, ...(post.companions?.map(a => a.source) || [])]).filter((s): s is PostprocessSource => Boolean(s));
    for (const attachment of posts.flatMap(post=>[post.output,post.wavefunction,...(post.companions||[])])) if (attachment) {
      valid.ids.add(attachment.source.result.source.id);if(attachment.source.metadata?.sourceId)valid.ids.add(attachment.source.metadata.sourceId);if(attachment.source.metadata?.sourceRevision)valid.revisions.add(attachment.source.metadata.sourceRevision);
      if(attachment.source.metadata?.sourceRevision)for(const id of [attachment.source.result.source.id,attachment.source.metadata.sourceId])if(id)valid.pairs.add(JSON.stringify([id,attachment.source.metadata.sourceRevision]));
      for (const key of [attachment.source.result.source.id,attachment.source.metadata?.sourceId,attachment.nativeSessionId && `session:${attachment.nativeSessionId}`, attachment.source.metadata?.sourceRevision && `revision:${attachment.source.metadata.sourceRevision}`]) if (key) {
        const owners = sourceOwners.get(key) || new Set<string>(); owners.add(entry.id); sourceOwners.set(key, owners);
      }
    }
    const results = new Map<string, { result: TrajectoryResult; source?: PostprocessSource }>();
    for (const r of [entry.result, entry.legacyResult, entry.analysisBinding?.result, ...posts.map(post=>post.result)]) if (r) results.set(r.id, { result: r });
    for (const source of sources) for (const r of [source.result, ...source.results]) results.set(r.id, { result: r, source });
    for (const { result, source } of results.values()) {
      valid.ids.add(result.source.id);valid.revisions.add(source?.metadata?.sourceRevision??result.source.id);
      valid.pairs.add(JSON.stringify([result.source.id,source?.metadata?.sourceRevision??result.source.id]));
      const owners = sourceOwners.get(result.source.id) || new Set<string>(); owners.add(entry.id); sourceOwners.set(result.source.id, owners);
      resultFacts(result, entry.id, output, source);
      for(const diagnostic of result.fileDiagnostics??[])resultFacts(diagnostic,entry.id,output);
    }
  }
  for(const document of Object.values(options.fileDocuments??{})){
    const valid:AnalysisCitationSource={ids:new Set(),revisions:new Set(),pairs:new Set(),revision:0,available:true,trajectory:true,bound:false,fileOwner:true};analysisSources.set(document.id,valid);documentAliases.set(document.id,document.id);
    const register=(id:string,revision:string)=>{
      valid.ids.add(id);valid.revisions.add(revision);valid.pairs.add(JSON.stringify([id,revision]));
      for(const key of [id,`revision:${revision}`]){const owners=sourceOwners.get(key)??new Set<string>();owners.add(document.id);sourceOwners.set(key,owners);}
    };
    const readJob=(job:CitationJob,source?:CitationSource)=>{
      const metadata=source&&'metadata'in source?source.metadata:undefined;
      const revision=metadata?.sourceRevision??job.source.sha256??job.source.id;register(job.source.id,revision);
      // Existing analysis contexts use the retained source ID when no metadata
      // revision is supplied. Both identities come from this exact source.
      if(!metadata?.sourceRevision)register(job.source.id,job.source.id);
      if(metadata?.sourceId)register(metadata.sourceId,revision);
      resultFacts(job,document.id,output,source);
      if(job.kind!=='diagnostic')for(const diagnostic of job.fileDiagnostics??[])readJob(diagnostic);
    };
    for(const job of document.output.source.jobs)readJob(job,document.output.source);
    for(const attachment of [document.wavefunction,...document.companions??[]])if(attachment){
      for(const job of new Map([attachment.source.result,...attachment.source.results].map(job=>[job.id,job])).values())readJob(job,attachment.source);
      if(attachment.nativeSessionId){const owners=sourceOwners.get(`session:${attachment.nativeSessionId}`)??new Set<string>();owners.add(document.id);sourceOwners.set(`session:${attachment.nativeSessionId}`,owners);}
    }
    if(document.displayResult)readJob(document.displayResult);
  }
  for (const receipt of [...(options.generated || []), ...(options.inputReceipts || [])]) if (documentIds.has(receipt.documentId)) {
    // Stored receipts predate selector fixes. Normalize a copy at collection,
    // retaining the receipt identity/evidence and its input-preparation role.
    const basis = receipt.feature === 'basis' && receipt.method ? citationBasis(receipt.method) : receipt.method;
    output.push(basis === receipt.method ? receipt : { ...receipt, method: basis });
  }
  collectAnalysisFacts(options.analysis, documentIds, sourceOwners, analysisSources,options.analysisInstances,documentAliases,new Map(options.documents.map(entry=>[entry.id,entry.store.getSnapshot()])),output);
  collectAdvancedFacts(options.advanced, options.documents, output);
  return [...new Map(output.map(f => [f.id, f])).values()];
}

interface AnalysisCitationSource {ids:Set<string>;revisions:Set<string>;pairs:Set<string>;revision:number;available:boolean;trajectory:boolean;bound:boolean;fileOwner?:boolean}
function collectAnalysisFacts(root: unknown, documents: Set<string>, sourceOwners: Map<string, Set<string>>,sources:Map<string,AnalysisCitationSource>,instances:readonly RetainedCitationAnalysisInstance[]|undefined,aliases:Map<string,string>,models:Map<string,ModelDocument>,output: CitationFact[]) {
  const visited = new WeakSet<object>();
  const skipped = new Set(['values', 'vertices', 'atoms', 'coordinates', 'originalBytes', 'precision', 'grid', 'mask', 'rawArtifacts', 'pairs', 'frontier', 'points', 'bins', 'metrics']);
  function visit(value: unknown,inherited?:Bag) {
    if (!value || typeof value !== 'object' || visited.has(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    visited.add(value);
    if (value instanceof Map) { for (const item of value.values()) visit(item,inherited); return; }
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item === 'object') visit(item,inherited); return; }
    const r = value as Bag;
    const inheritedOwner=bag(r.citationOwner)??inherited;
    const populationResult = ['charges', 'bond-orders', 'composition'].includes(str(r.kind) || '')
      && str(r.method) && bag(r.backend) && str(r.sourceRevision) && str(r.sessionId) && (Array.isArray(r.atoms) || Array.isArray(r.bonds));
    const provenance = bag(r.provenance) || (populationResult ? r : undefined);
    const ownContext=bag(r.stamp)||bag(r.context);
    const context = ownContext?{...inheritedOwner,...ownContext}:(populationResult?{...inheritedOwner,sourceId:inheritedOwner?.sourceId??`session:${r.sessionId}`,sourceRevision:r.sourceRevision,sessionId:r.sessionId}:inheritedOwner);
    const backend = bag(provenance?.backend);
    let method: string | undefined;
    if (context && provenance) {
      if (populationResult) method = `${r.kind}:${r.method}`;
      else if (['nto', 'nto-field', 'hole-electron'].includes(str(r.operation) || '')) method = r.operation === 'nto-field' ? 'nto' : str(r.operation);
      else if (str(r.method) && ['iri', 'rdg', 'igmh', 'migm', 'igm'].includes(str(r.method)! ) && (r.fields || r.integrals || r.atoms || r.pairs)) method = str(r.method);
      else if (r.approximation === 'frozen-orbital' && r.partition === 'hirshfeld' && r.globalMetrics) method = 'conceptual-dft-frozen-orbital';
      else if (r.quantitativeGrid && r.regions && str(r.function)) method = str(r.function);
      else if (r.kind === 'hirshfeld' && r.pair && Array.isArray(r.vertices) && r.source) method = 'hirshfeld-surface';
      else if (r.pair && r.quality && provenance.parameters) method = str(bag(provenance.parameters)?.function);
    }
    if (method && context && provenance) {
      const sourceId = str(context.sourceId), ownDocument = str(context.documentId);
      const scopedDocument=str(inheritedOwner?.documentId),scopedFile=scopedDocument&&sources.get(scopedDocument)?.fileOwner&&sourceId===str(inheritedOwner?.sourceId)&&str(context.sourceRevision)===str(inheritedOwner?.sourceRevision);
      // A file viewport has a derived read-only frame ID, not a Store ID. Its
      // real scoped owner is accepted only with the same exact source/revision;
      // the normal retained-source and live-instance guards below still apply.
      const resolvedDocument=scopedFile?scopedDocument:ownDocument?(aliases.get(ownDocument)??ownDocument):undefined;
      const owners = resolvedDocument ? documents.has(resolvedDocument) ? [resolvedDocument] : [] : [...new Set([...(sourceOwners.get(sourceId || '') || []), ...(populationResult ? sourceOwners.get(`revision:${str(context.sourceRevision)}`) || [] : [])])];
      for (const documentId of owners) {
        const valid=sources.get(documentId),revision=str(context.sourceRevision),analysisId=str(context.analysisId);
        const sourceMatches=valid?.pairs.has(JSON.stringify([sourceId,revision]))||populationResult&&sourceOwners.get(`revision:${revision}`)?.has(documentId);
        const structureSource=sourceId===`model:${documentId}`&&interactionUsesStructure(method);
        if(structureSource){const model=models.get(documentId);if(!model)continue;try{assertStructureInteractionContext(context as unknown as SurfaceContext,model.draft.structure);}catch{continue;}
         if(instances&&!instances.some(instance=>instance.structureOnly&&instance.documentId===documentId&&instance.analysisId===analysisId&&instance.sourceId===sourceId&&instance.sourceRevision===revision))continue;
        }else{
         if(!valid?.available||!revision||!valid.revisions.has(revision)||!sourceMatches||typeof context.documentRevision==='number'&&resolvedDocument===ownDocument&&!valid.trajectory&&!valid.bound&&context.documentRevision!==valid.revision)continue;
         if(instances&&!instances.some(instance=>instance.documentId===documentId&&instance.analysisId===analysisId&&valid.ids.has(instance.sourceId)&&instance.sourceRevision===revision))continue;
        }
        const software = producer(str(backend?.name));
        const evidence: CitationFactEvidence[] = [{ kind: 'metadata', locator: `analysis:${str(context.analysisId) || str(context.requestId) || method}:${sourceId || ''}`, detail: JSON.stringify({ backend, parameters: provenance.parameters, sourceId, jobIndex: context.jobIndex, sourceFrameIndex: context.sourceFrameIndex }) }];
        const base = { documentId, sourceId, jobId: context.jobIndex == null ? undefined : String(context.jobIndex), frameId: context.sourceFrameIndex == null ? undefined : String(context.sourceFrameIndex), taskId: str(context.analysisId), kind: 'retained-result' as const, software, version: str(backend?.version), evidence, purpose: `保留的${method}分析结果` };
        addFact(output, base, 'analysis', method, str(context.requestId));
        if (software) { addFact(output, base, 'software', software); addFact(output, { ...base, kind: 'runtime-dependency' }, 'runtime-dependency', software); }
      }
    }
    for (const [key, item] of Object.entries(r)) if (!skipped.has(key) && key !== 'provenance'&&key!=='citationOwner') visit(item,inheritedOwner);
  }
  visit(root);
}

function collectAdvancedFacts(root: unknown, documents: readonly WorkspaceDocumentEntry[], output: CitationFact[]) {
  for (const taskValue of items(bag(root)?.tasks)) {
    const task = bag(taskValue); if (!task) continue;
    const taskId = str(task.id), spec = bag(task.spec), sourceRef = bag(bag(spec?.source)?.ref);
    const owners = documents.filter(d => d.trajectory?.identity.taskId === taskId || d.conformerGroup?.taskId === taskId || d.id === sourceRef?.documentId);
    if (!owners.length) continue;
    for (const runValue of items(task.runs)) {
      const run = bag(runValue); if (!run) continue;
      const calculations = [...items(run.results), ...items(run.stages).flatMap(s => items(bag(s)?.results))];
      for (const calculationValue of calculations) {
        const calculation = bag(calculationValue), metadata = bag(calculation?.metadata);
        if (!metadata || !str(metadata.method) || !str(metadata.engine)) continue;
        for (const owner of owners) {
          const software = producer(str(metadata.engine)), method = normalizeCitationMethod(str(metadata.method)!, software);
          const base = { documentId: owner.id, sourceId: str(bag(bag(calculation?.input)?.ref)?.sourceId), taskId, stage: str(calculation?.stageId), frameId: str(calculation?.frameId), kind: 'retained-result' as const, software, version: str(metadata.version), evidence: [{ kind: 'metadata' as const, locator: `advanced:${taskId}:${str(run.id)}:${str(calculation?.stageId)}:${str(calculation?.candidateId)}`, detail: JSON.stringify({ engine: metadata.engine, version: metadata.version, method: metadata.method, status: calculation?.status }) }], purpose: '保留高级任务的实际计算结果' };
          addFact(output, base, 'method', method); if (software) { addFact(output, base, 'software', software); addFact(output, { ...base, kind: 'runtime-dependency' }, 'runtime-dependency', software); }
          const solvation = bag(metadata.solvation); if (str(solvation?.model)) addFact(output, base, 'solvation', str(solvation?.model));
        }
      }
      for (const branch of ['path', 'sampling', 'docking']) {
        const terminal = bag(bag(run[branch])?.terminal), backend = bag(terminal?.backend);
        if (!terminal || !['completed', 'stopped', 'search-checkpoint'].includes(str(terminal.event) || '')) continue;
        if (branch === 'sampling') {
          const frame = bag(terminal.lastFrame), native = bag(frame?.nativeMD) || bag(frame?.calculatorEvidence);
          if (frame && str(terminal.method) && (native || typeof frame.physicalEnergyEV === 'number')) for (const owner of owners) {
            const software = native ? 'xTB' : undefined;
            const base = { documentId: owner.id, taskId, stage: `${str(run.id)}:sampling`, kind: 'retained-result' as const, software, version: str(native?.version), evidence: [{ kind: 'metadata' as const, locator: `advanced:${taskId}:${str(run.id)}:sampling:terminal`, detail: JSON.stringify({ event: terminal.event, method: terminal.method, driver: terminal.driver, native }) }], purpose: '保留的实际采样帧；不是严格系综或优化收敛证明' };
            addFact(output, base, 'method', normalizeCitationMethod(str(native?.method) || str(terminal.method)!, software));
            if (software) addFact(output, { ...base, kind: 'runtime-dependency' }, 'runtime-dependency', software);
            for (const event of items(bag(run.sampling)?.stageEvents)) {
              const integration = bag(bag(event)?.integration);
              if (integration?.driver === 'ASE-Langevin' && str(integration.aseVersion)) addFact(output, { ...base, software: 'ASE', version: str(integration.aseVersion), kind: 'runtime-dependency' }, 'runtime-dependency', 'ASE');
            }
          }
        }
        if (!backend) continue;
        for (const owner of owners) {
          const base = { documentId: owner.id, taskId, stage: `${str(run.id)}:${branch}`, kind: 'retained-result' as const, evidence: [{ kind: 'metadata' as const, locator: `advanced:${taskId}:${str(run.id)}:${branch}:terminal`, detail: JSON.stringify(backend) }], purpose: `高级${branch}的实际终止来源；不推定优化收敛` };
          const software = producer(str(backend.engine)), calculator = producer(str(backend.calculator));
          const method = str(backend.method) || str(backend.precomputeMethod);
          if (method && backend.physicalCalculatorCreated !== false) addFact(output, { ...base, software, version: str(backend.version) }, 'method', normalizeCitationMethod(method, software));
          for (const [name, version] of [[software, str(backend.version)], [producer(str(backend.driver)), str(backend.aseVersion)], [backend.physicalCalculatorCreated === true ? calculator : undefined, undefined]]) if (name) addFact(output, { ...base, software: name, version, kind: 'runtime-dependency' }, 'runtime-dependency', name);
          if (str(backend.scoreMethod)) addFact(output, base, 'analysis', str(backend.scoreMethod)?.toLowerCase());
        }
      }
    }
  }
}
