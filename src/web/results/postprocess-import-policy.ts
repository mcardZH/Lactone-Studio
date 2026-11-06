import { pairPostprocessSources, pairPostprocessSourcesForFrames, postprocessDestination, postprocessMetadataConflict, type PostprocessSource, type PostprocessSourcePair } from '../../results/postprocess-sources';
import type { PostprocessDocument, PostprocessAttachment, PostprocessFileAttachment, PostprocessFileDocument } from '../../results/postprocess-document';
import {projectPostprocessAttachment, sharePostprocessAttachment, isScientificFileDocument} from '../../results/postprocess-document';
import {isScientificFileSource,postprocessFileJob,postprocessFileJobSource} from '../../results/postprocess-sources';
import {bindIrcCompanion,mergeIrcBranches,type IrcOutputSource} from '../../results/irc-companion-association';
import type {PostprocessSourceKind} from '../../results/postprocess-sources';
import {recognizeSourceText} from '../../results/source-recognition';
import type {PostprocessTask} from './PostprocessSidebar';
import {bindTrajectoryCompanions} from '../../results/trajectory-companions';
import type {NebAuxiliarySource} from '../../results/neb-auxiliary-reader';
import type {MdAuxiliarySource} from '../../results/md-aux-reader';
import {projectTrajectoryStage} from '../../results/trajectory-stages';
import type {TrajectoryResult} from '../../results/contracts';
import {assessHessCompanion} from '../../results/hess-companion';

/** Saved HESS groups are a projection; the OUT reader's own result stays intact. */
export function unaugmentedPostprocessOutput(output:PostprocessAttachment|undefined):PostprocessAttachment|undefined {
  if(!output)return undefined;
  const original=output.source.results.find(result=>result.id===output.source.result.id);
  return original&&original!==output.source.result?projectPostprocessAttachment(output,original,output.source.results):output;
}

export async function defaultPostprocessCompanion(output:PostprocessAttachment|undefined,companions:readonly PostprocessAttachment[]):Promise<TrajectoryResult|undefined> {
  const tasks=output?.source.tasks??[];
  if(tasks.includes('md')){
    const matches=companions.filter(({source:{result}})=>result.role==='md-trajectory'
      && result.scientific?.source?.id===output?.source.result.source.id && result.jobIndex===output?.source.result.jobIndex);
    if(matches.length===1)return matches[0].source.result;
  }
  const roles=tasks.includes('scan')?['scan-point-set']:tasks.includes('irc')?['irc-full','irc-branch']:tasks.includes('neb')?['neb-path','neb-iterations']:[];
  for(const role of roles){
    const matches=companions.filter(value=>value.source.result.role===role && value.source.result.scientific?.source?.id === output?.source.result.source.id);
    if(matches.length!==1)continue;
    const result=matches[0].source.result,kind=tasks.includes('scan')?'scan-points':tasks.includes('irc')?'irc':'neb-path';
    const stage=result.stages?.find(stage=>stage.kind===kind);
    return stage?projectTrajectoryStage(result,stage.id):result;
  }
  return undefined;
}

/** Classify only explicitly selected sources; verified roles never come from a basename. */
export interface PostprocessSourceWarning { sourceId:string;code:'unpaired-trajectory'|'unpaired-modes'|'ambiguous-companion'|'pairing-conflict';message:string }
export async function preparePostprocessFileIncoming(incoming: readonly PostprocessFileAttachment[], base?: PostprocessFileDocument, guard: () => void = () => {}, options: { nebAuxiliaries?: readonly NebAuxiliarySource[]; mdAuxiliaries?: readonly MdAuxiliarySource[]; signal?: AbortSignal } = {}): Promise<{ output?: PostprocessFileAttachment; wavefunction?: PostprocessAttachment; companions: PostprocessAttachment[]; pair?: PostprocessSourcePair; sourceWarnings: PostprocessSourceWarning[]; displayedResult?: TrajectoryResult; extraSources?: import('../../results/postprocess-document').PostprocessScientificFileDocument['extraSources'] }> {
  const outputs = incoming.filter(item => item.source.kind.endsWith('-output'));
  if (outputs.length > 1) throw Error('多个主OUT需分别建立分析。');
  const owner = outputs[0] ?? base?.output;
  if (!owner || !isScientificFileSource(owner.source)) {
    if (incoming.some(item => isScientificFileSource(item.source))) throw Error('文件级科学来源需要作为主OUT保留。');
    return preparePostprocessIncoming(incoming as readonly PostprocessAttachment[], base && !isScientificFileDocument(base) ? base : undefined, guard, options);
  }
  const waves = incoming.filter(item => item.source.kind === 'fchk' || item.source.kind === 'molden') as PostprocessAttachment[];
  if (waves.length > 1) throw Error('多个波函数来源保独立，不能自动覆盖。');
  let wavefunction = waves[0] ?? (base && isScientificFileDocument(base) ? base.wavefunction : undefined);
  const companions: PostprocessAttachment[] = [], sourceWarnings: PostprocessSourceWarning[] = [];
  const fileSource = owner.source;
  const selected = postprocessFileJob(fileSource);
  const contexts = fileSource.ircContexts.flatMap(context => {
    const job = fileSource.jobs.find(job => job.id === context.outputId);
    return job && job.jobIndex !== null ? [{ ...context, output: job as IrcOutputSource }] : [];
  });
  const existing = base && isScientificFileDocument(base) ? base.companions ?? [] : [];
  const beforeOutput = base?.output && !base.output.source.kind.endsWith('-output') && !isScientificFileSource(base.output.source) ? [base.output as PostprocessAttachment] : [];
  const auxiliary = [...existing, ...beforeOutput, ...incoming.filter(item => item.source.kind === 'xyz' || item.source.kind === 'hess') as PostprocessAttachment[]];
  const seen = new Set<string>();
  for (const attachment of auxiliary) {
    if (attachment.source.kind === 'fchk' || attachment.source.kind === 'molden') { companions.push(attachment); continue; }
    const sourceId = attachment.source.result.source.id; if (seen.has(sourceId)) continue; seen.add(sourceId);
    const matches: TrajectoryResult[] = [];
    try {
      if (attachment.source.kind === 'xyz') for (const context of contexts) { const match = await bindIrcCompanion(context, attachment.source.results[0] ?? attachment.source.result, options.signal); guard(); if (match) matches.push(match); }
    } catch (error) { guard(); if (error instanceof DOMException && error.name === 'AbortError') throw error; sourceWarnings.push({ sourceId, code: 'unpaired-trajectory', message: error instanceof Error ? error.message : '配套读取受限。' }); }
    if (matches.length === 1) {
      const match = matches[0]; companions.push({ ...projectPostprocessAttachment(attachment, match, attachment.source.results), role: match.scientific!.ircEvidence!.role });
    } else {
      companions.push(attachment); sourceWarnings.push({ sourceId, code: matches.length > 1 ? 'ambiguous-companion' : attachment.source.kind === 'hess' ? 'unpaired-modes' : 'unpaired-trajectory', message: matches.length > 1 ? '配套可对应多个job，保独立来源并选择归属。' : '配套未取得唯一科学对应；主OUT及原来源保留。' });
    }
  }
  let displayedResult: TrajectoryResult | undefined = selected && 'frames' in selected ? selected : undefined;
  const eligible = selected ? companions.filter(item => item.source.result.scientific?.ircEvidence?.outputId === selected.id) : [];
  const conflicts = new Set<string>();
  const established = new Set(existing.map(item => item.source.result.source.id));
  for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
    const a = eligible[i].source.result, b = eligible[j].source.result;
    for (const frame of a.frames) {
      const other = b.frames.find(row => row.pathNode === frame.pathNode); if (!other) continue;
      const x = await a.getFrame(frame.index, options.signal), y = await b.getFrame(other.index, options.signal); guard();
      const rounding = (frame.coordinateRoundingAngstrom ?? 0) + (other.coordinateRoundingAngstrom ?? 0);
      if (x.atoms.length !== y.atoms.length || x.atoms.some((atom, k) => atom.element !== y.atoms[k].element || ['x', 'y', 'z'].some(axis => Math.abs(atom[axis as 'x'] - y.atoms[k][axis as 'x']) > rounding + Number.EPSILON * 8 * Math.max(1, Math.abs(atom[axis as 'x']))))) { if (!established.has(a.source.id) || established.has(b.source.id)) conflicts.add(a.source.id); if (!established.has(b.source.id) || established.has(a.source.id)) conflicts.add(b.source.id); break; }
    }
  }
  for (const sourceId of conflicts) sourceWarnings.push({ sourceId, code: 'pairing-conflict', message: 'Full与分支的同节点坐标冲突；保双方原资产，未自动选择显示。' });
  const ready = eligible.filter(item => !conflicts.has(item.source.result.source.id));
  const full = ready.filter(item => item.source.result.scientific?.ircEvidence?.role === 'irc-full');
  if (full.length === 1) displayedResult = full[0].source.result;
  else if (full.length > 1) sourceWarnings.push({ sourceId: owner.source.identity.id, code: 'ambiguous-companion', message: '多份完整IRC来源均可对应，需明确选择。' });
  else {
    const forward = ready.filter(item => item.source.result.scientific?.ircEvidence?.role === 'irc-forward'), reverse = ready.filter(item => item.source.result.scientific?.ircEvidence?.role === 'irc-reverse');
    if (forward.length === 1 && reverse.length === 1) { displayedResult = await mergeIrcBranches(forward[0].source.result, reverse[0].source.result, options.signal) ?? undefined; guard(); }
    if (!displayedResult && ready.length === 1) displayedResult = ready[0].source.result;
  }
  let pair: PostprocessSourcePair | undefined;
  const primary = postprocessFileJobSource(fileSource);
  const verify = async (candidate: PostprocessAttachment) => {
    if (!primary) return undefined;
    try { const value = await pairPostprocessSourcesForFrames(primary, candidate.source, options); guard(); return value; }
    catch (error) { guard(); if (error instanceof DOMException && error.name === 'AbortError') throw error;
      sourceWarnings.push({ sourceId: candidate.source.result.source.id, code: 'pairing-conflict', message: error instanceof Error ? error.message : '波函数未取得当前job的科学对应。' }); return undefined; }
  };
  if (wavefunction) {
    pair = await verify(wavefunction);
    const rejected = !pair || pair.conflicts.length > 0 || postprocessMetadataConflict(pair);
    if (rejected) {
      if (pair) sourceWarnings.push({ sourceId: wavefunction.source.result.source.id, code: 'pairing-conflict', message: pair.notices.join('；') });
      else if (!primary) sourceWarnings.push({ sourceId: wavefunction.source.result.source.id, code: 'pairing-conflict', message: '当前job缺少完整普通科学几何或原生作业范围证明；波函数保留独立来源。' });
      pair = undefined;
      const previous = base && isScientificFileDocument(base) ? base.wavefunction : undefined;
      // A rejected replacement never discards a good old slot. Keep the new
      // raw candidate independently, then re-evaluate the old slot for this job.
      if (waves[0] && previous && previous !== waves[0]) {
        companions.push(waves[0]); wavefunction = previous; pair = await verify(previous);
        if (pair && (pair.conflicts.length || postprocessMetadataConflict(pair))) pair = undefined;
      }
    }
  }
  // Pairing may still await a frame read or be cancelled. Acquire the borrowed
  // XYZ lease only after that final await and guard, so every clone has a caller
  // owner as soon as it exists. The standalone page keeps its original lease.
  guard();
  for (let index = 0; index < companions.length; index++) if (beforeOutput.some(item => item.source.result.source.id === companions[index].source.result.source.id)) {
    const before = companions[index]; companions[index] = sharePostprocessAttachment(before);
    if (displayedResult === before.source.result) displayedResult = companions[index].source.result;
  }
  return { output: owner, wavefunction, companions, sourceWarnings, ...(pair ? { pair } : {}), ...(displayedResult ? { displayedResult } : {}), ...(base && isScientificFileDocument(base) && base.extraSources?.length ? { extraSources: base.extraSources } : {}) };
}
export async function preparePostprocessIncoming(incoming:readonly PostprocessAttachment[],base?:PostprocessDocument,guard:()=>void=()=>{},options:{nebAuxiliaries?:readonly NebAuxiliarySource[];mdAuxiliaries?:readonly MdAuxiliarySource[];signal?:AbortSignal}={}):Promise<{output?:PostprocessAttachment;enrichedOutput?:PostprocessAttachment;wavefunction?:PostprocessAttachment;companions:PostprocessAttachment[];sourceWarnings:PostprocessSourceWarning[]}> {
  const outputs=incoming.filter(row=>row.source.kind.endsWith('-output')),waves=incoming.filter(row=>row.source.kind==='fchk'||row.source.kind==='molden');
  let auxiliary=incoming.filter(row=>row.source.kind==='xyz'||row.source.kind==='hess');
  if(outputs.length>1||waves.length>1)throw new Error('一次请提供一个主OUT、必要配套来源与一个波函数；多个主来源请分别建立分析。');
  let output=outputs[0];const wavefunction=waves[0];
  const owner=output??(base?.output?.source.kind.endsWith('-output')?base.output:undefined);
  if(options.mdAuxiliaries&&owner?.source.tasks.includes('md')&&!auxiliary.some(row=>row.source.result.role==='md-trajectory')){
    const existing=(base?.companions??[]).filter(row=>row.source.result.role==='md-trajectory');
    if(existing.length===1)auxiliary.push(existing[0]);
  }
  if(!owner&&auxiliary.length){if(auxiliary.length!==1)throw new Error('多份XYZ/HESS未取得同一主OUT的配套证明；请分别载入。');output=auxiliary[0];auxiliary=[];}
  const companions:PostprocessAttachment[]=[];
  const sourceWarnings:PostprocessSourceWarning[]=[];
  const independent=(attachment:PostprocessAttachment,code:PostprocessSourceWarning['code'],message:string)=>{companions.push(attachment);sourceWarnings.push({sourceId:attachment.source.result.source.id,code,message});};
  let enrichedOutput:PostprocessAttachment|undefined;
  for(const attachment of auxiliary){
    if(!owner)throw new Error('配套来源缺少主OUT。');
    if(attachment.source.kind==='hess'){
      if(companions.some(value=>value.source.kind==='hess')){independent(attachment,'ambiguous-companion','多份模式来源保独立，未自动选择。');continue;}
      const current=unaugmentedPostprocessOutput(enrichedOutput??owner)!,proof=await assessHessCompanion(current.source.result,attachment.source.result);guard();
      if(!proof.result){independent(attachment,'unpaired-modes',proof.reason??'HESS未取得唯一科学配对，保留独立来源。');continue;}
      enrichedOutput=projectPostprocessAttachment(current,proof.result,current.source.results);
      companions.push(attachment);continue;
    }
    if(attachment.source.kind!=='xyz')throw new Error('不支持的配套来源。');
    const md=attachment.source.result.role==='md-trajectory';
    const candidate=md?(attachment.source.results.find(result=>result.scientific?.source?.id===attachment.source.result.source.id)??attachment.source.result):attachment.source.result;
    const raw=md&&candidate!==attachment.source.result?projectPostprocessAttachment(attachment,candidate,attachment.source.results):attachment;
    let bound:TrajectoryResult|null;
    try{const primary=(enrichedOutput??owner).source,context=primary.nebOutputContext;
      const grouped=await bindTrajectoryCompanions([primary.result,candidate],options.signal,{contexts:context?[{...context,output:primary.result}]:[],auxiliaries:options.nebAuxiliaries??[]},md?{auxiliaries:options.mdAuxiliaries??[]}:undefined,{contexts:primary.ircOutputContext?[{...primary.ircOutputContext,output:primary.result}]:[]});guard();
      bound=grouped[1]!==candidate?grouped[1]:null;
    }
    catch(error){guard();if(error instanceof DOMException&&error.name==='AbortError')throw error;independent(raw,'unpaired-trajectory',error instanceof Error?error.message:'配套来源读取受限，主OUT仍可用。');continue;}
    if(!bound){independent(raw,'unpaired-trajectory',`配套来源 ${attachment.source.result.source.name} 未取得唯一角色、几何及能量对应，保独立来源，主OUT仍可用。`);continue;}
    if(companions.some(value=>value.source.result.role===bound.role)&&!bound.scientific?.nebEvidence?.geometryMapped){independent(attachment,'ambiguous-companion','多份配套来源具有相同角色，保独立来源，未自动选择。');continue;}
    companions.push(md?projectPostprocessAttachment(raw,bound,raw.source.results):projectPostprocessAttachment(attachment,bound));
  }
  return{output,enrichedOutput,wavefunction,companions,sourceWarnings};
}

export function postprocessDocumentEngine(document:PostprocessDocument):'gaussian'|'orca'|'cp2k'|'xtb'|'unknown' {
  const source=document.output?.source??document.wavefunction?.source;
  if(!source)return 'unknown';
  if(source.kind==='fchk')return 'gaussian';
  if(source.software)return source.software;
  if(source.result.engine==='gaussian')return 'gaussian';
  return source.result.engine==='orca'?'orca':'unknown';
}
export const postprocessSoftwareLabel=(software:string|undefined)=>software==='gaussian'?'Gaussian':software==='orca'?'ORCA':software==='cp2k'?'CP2K':software==='xtb'?'xTB':'生产软件未确认';
export function postprocessDocumentTask(document:PostprocessDocument):PostprocessTask {
  const source=document.output?.source??document.wavefunction?.source;
  if(!source)return 'trajectory';
  const task=postprocessDestination(source).task;
  if(task==='tdopt')return 'td';
  if(task==='stable')return 'stability';
  if(['sp','opt','freq','optfreq','ts','irc','scan','neb','td','nmr','stability','bsse'].includes(task))return task as PostprocessTask;
  return 'trajectory';
}

const tasks:Record<string,string>={sp:'单点能',opt:'结构优化',freq:'频率',optfreq:'优化与频率',ts:'过渡态',irc:'IRC',scan:'扫描',neb:'NEB',td:'激发态',tdopt:'激发态优化',nmr:'NMR',stable:'稳定性',bsse:'BSSE',qst2:'QST2',qst3:'QST3',trajectory:'结构轨迹'};
/** Preliminary message only; committed descriptions use the actual parser. */
export function previewImportDescription(kind:PostprocessSourceKind,text:string):string {
  if(kind==='fchk')return 'Gaussian FCHK / FCH 波函数文件';
  if(kind==='molden')return `${postprocessSoftwareLabel(recognizeSourceText(text).software)} Molden 波函数文件`;
  if(kind==='xyz')return 'XYZ 已保存结构 / 轨迹';
  if(kind==='hess')return 'ORCA HESS 已保存频率 / 模态';
  if(kind==='neb-auxiliary')return 'NEB 辅助表（不含独立结构或作业）';
  if(kind==='gbw')return 'ORCA GBW 文件（需转换为 Molden）';
  const route=kind==='gaussian-output'?text.match(/^\s*#[^\r\n]*(?:\r?\n(?!\s*-{3,})[^\r\n]+)*/m)?.[0]:text.split(/\r?\n/).filter(line=>/^\s*(?:\|\s*\d+>\s*)?!/.test(line)).join(' ');
  const task=route?/\b(?:ci-)?neb(?:-ts)?\b/i.test(route)?'NEB':/\birc\b/i.test(route)?'IRC':/RELAXED SURFACE SCAN|RELAXED POTENTIAL ENERGY SURFACE SCAN/i.test(text)?'扫描':/\bopt\b/i.test(route)&&/\bfreq\b/i.test(route)?'优化与频率':/\bopt\b/i.test(route)?'结构优化':/\bfreq\b/i.test(route)?'频率':/\b(?:td|tddft)\b/i.test(route)?'激发态':'单点能':'计算结果';
  return `${kind==='gaussian-output'?'Gaussian':'ORCA'} ${task} OUT 文件`;
}
export function describePostprocessSource(source:PostprocessSource):string {
  if(source.generatedXtb)return 'GFN2-xTB 自产单点 / Molden 波函数';
  if(source.kind==='fchk')return 'Gaussian FCHK / FCH 波函数文件';
  if(source.kind==='molden')return `${postprocessSoftwareLabel(source.software)} Molden 波函数文件`;
  if(source.kind==='xyz')return `${postprocessSoftwareLabel(source.software)} XYZ 已保存结构 / 轨迹`;
  if(source.kind==='hess')return 'ORCA HESS 已保存频率 / 模态';
  const destination=postprocessDestination(source),engine=destination.engine==='gaussian'?'Gaussian':destination.engine==='orca'?'ORCA':'';
  return `${engine} ${tasks[destination.task]??'计算结果'} OUT 文件`.trim();
}
/** Auto-drop fills only a verified matching empty counterpart; independent
 * calculations and occupied same-type slots always become a new analysis. */
export interface PostprocessImportMatch {reuse:boolean;pair?:PostprocessSourcePair;reason?:{code:string;message:string}}
function ineligibleTarget(base:PostprocessDocument|undefined,output:PostprocessAttachment|undefined,wave:PostprocessAttachment|undefined):PostprocessImportMatch|undefined {
  if(!base)return{reuse:false,reason:{code:'no-target',message:'当前没有可接入的分析来源。'}};
  if(!output&&!wave||output&&wave)return{reuse:false,reason:{code:'independent-import',message:'本次来源作为独立分析读取。'}};
  if(output&&base.output||wave&&base.wavefunction)return{reuse:false,reason:{code:'occupied-slot',message:'当前分析的同类来源槽已占用，不自动覆盖。'}};
}
function acceptedPair(pair:PostprocessSourcePair):PostprocessImportMatch {
  const conflict=postprocessMetadataConflict(pair);
  return conflict?{reuse:false,reason:{code:'metadata-conflict',message:conflict}}:{reuse:true,pair,
    ...(pair.conflicts.length?{reason:{code:'observation-conflict',message:`几何身份已核对；${pair.conflicts.length}项打印数值不一致，两槽分别保留，依赖一致电子态的分析不可用。`}}:{})};
}
function rejectedPair(error:unknown):PostprocessImportMatch {
  const value=error as {code?:unknown;message?:unknown};
  return{reuse:false,reason:{code:typeof value?.code==='string'?value.code:'pairing-error',message:typeof value?.message==='string'?value.message:'来源配对未取得可靠证明。'}};
}
export function matchingImportTarget(base:PostprocessDocument|undefined,output:PostprocessAttachment|undefined,wave:PostprocessAttachment|undefined):PostprocessImportMatch {
  const rejected=ineligibleTarget(base,output,wave);if(rejected)return rejected;
  const nextOutput=output??base!.output,nextWave=wave??base!.wavefunction;
  if(!nextOutput||!nextWave)return{reuse:false,reason:{code:'missing-counterpart',message:'缺少可核对的主OUT或波函数来源。'}};
  try{return acceptedPair(pairPostprocessSources(nextOutput.source,nextWave.source));}catch(error){return rejectedPair(error);}
}
/** The multi-frame route verifies actual geometries before filling a counterpart. */
export async function matchingImportTargetForFrames(base:PostprocessDocument|undefined,output:PostprocessAttachment|undefined,wave:PostprocessAttachment|undefined):Promise<PostprocessImportMatch> {
  const rejected=ineligibleTarget(base,output,wave);if(rejected)return rejected;
  const nextOutput=output??base!.output,nextWave=wave??base!.wavefunction;
  if(!nextOutput||!nextWave)return{reuse:false,reason:{code:'missing-counterpart',message:'缺少可核对的主OUT或波函数来源。'}};
  try{return acceptedPair(await pairPostprocessSourcesForFrames(nextOutput.source,nextWave.source));}catch(error){return rejectedPair(error);}
}

/** No mutations or filename/order heuristics. Callers own an async revision
 * guard and must recheck the returned document/source identities before commit. */
export async function resolvePostprocessImportTarget(candidates:readonly PostprocessDocument[],output:PostprocessAttachment|undefined,wave:PostprocessAttachment|undefined,currentId?:string|null):Promise<{status:'matched'|'ambiguous'|'unmatched';targetId?:string;pair?:PostprocessSourcePair;candidateIds:string[];reasons:{targetId:string;code:string;message:string}[]}> {
  const reasons:{targetId:string;code:string;message:string}[]=[];
  const check=async(document:PostprocessDocument)=>{const match=await matchingImportTargetForFrames(document,output,wave);if(match.reason)reasons.push({targetId:document.id,...match.reason});return match;};
  const current=candidates.find(document=>document.id===currentId);
  if(current){const match=await check(current);if(match.reuse)return{status:'matched',targetId:current.id,pair:match.pair,candidateIds:[current.id],reasons};}
  const matches:{document:PostprocessDocument;pair:PostprocessSourcePair}[]=[];
  for(const document of candidates){if(document===current)continue;const match=await check(document);if(match.reuse&&match.pair)matches.push({document,pair:match.pair});}
  return matches.length===1?{status:'matched',targetId:matches[0].document.id,pair:matches[0].pair,candidateIds:[matches[0].document.id],reasons}
    :{status:matches.length?'ambiguous':'unmatched',candidateIds:matches.map(match=>match.document.id),reasons};
}
