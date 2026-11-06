import { GaussianOutputReader } from '../gaussian-reader';
import { gaussianRouteTokens } from '../gaussian-source';
import type { VibronicLogJob } from './types';

const key=(token:string)=>token.match(/^[a-z][\w-]*/i)?.[0].toLowerCase()??'';
const norm=(token:string)=>token.toLowerCase().replace(/\s+/g,'');
function readRoute(lines:string[]):string {
  const first=lines.findIndex(line=>/^\s*#[pnt]?(?:\s+|$)/i.test(line));if(first<0)return '';
  const route=[lines[first].trim()];
  for(let i=first+1;i<lines.length&&lines[i].trim()&&!/^\s*-{5,}\s*$/.test(lines[i]);i++)route.push(lines[i].trim());
  return route.join(' ');
}
/** Boundaries are Gaussian execution markers, never arbitrary orientation/frequency tables. */
export function inspectVibronicLogJobs(text:string):VibronicLogJob[] {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/),starts:Array<{at:number;boundary:VibronicLogJob['boundary']}>= [{at:0,boundary:'first'}];
  let seenInvocation=false;
  for(let i=0;i<lines.length;i++) {
    if(/^\s*Entering Gaussian System\b/.test(lines[i])){if(seenInvocation&&i>0)starts.push({at:i,boundary:'new-invocation'});seenInvocation=true;}
    else if(/^\s*Link1:\s+Proceeding to internal job step number\s+\d+/.test(lines[i]))starts.push({at:i,boundary:'internal-link'});
  }
  return starts.map((start,index)=>{
    const end=starts[index+1]?.at??lines.length,body=lines.slice(start.at,end),segment=body.join('\n');
    return {index,startLine:start.at+1,endLine:end,route:readRoute(body),hasFrequencyData:/^\s*Frequencies\s+--/m.test(segment),normalTermination:(segment.match(/Normal termination of Gaussian/g)??[]).length===1&&!/Error termination/.test(segment),boundary:start.boundary};
  });
}
function segmentLines(lines:string[],job:VibronicLogJob):string[] {return lines.slice(job.startLine-1+(job.boundary==='internal-link'?1:0),job.endLine);}
function geometry(lines:string[]) {
  const reader=new GaussianOutputReader();lines.forEach(line=>reader.consume(line));return reader.finish('selected-frequency-job')[0];
}
const checkpointName=(value:string)=>{const clean=value.trim().replace(/^"(.*)"$/,'$1').replace(/\\/g,'/');return /\.chk$/i.test(clean)?clean:`${clean}.chk`;};

/** Resolves only a demonstrated adjacent automatic Opt -> Freq continuation.
 * Other selected jobs remain isolated and must contain their own explicit settings. */
export function selectVibronicLogJob(text:string,selectedIndex?:number):{text:string;effectiveRoute:string;selectedJob:VibronicLogJob&{inheritedFrom?:VibronicLogJob};errors:string[];warnings:string[]} {
  const jobs=inspectVibronicLogJobs(text),lines=text.replace(/^\uFEFF/,'').split(/\r?\n/);
  if(jobs.length>1&&selectedIndex===undefined)throw new Error('LOG含多个Gaussian作业，请明确选择具有完整频率数据的作业。');
  const job=jobs[selectedIndex??0];if(!job||!Number.isSafeInteger(selectedIndex??0))throw new Error('所选Gaussian作业索引无效。');
  const body=segmentLines(lines,job),tokens=gaussianRouteTokens(job.route),errors:string[]=[],warnings:string[]=[];
  const result={text:body.join('\n'),effectiveRoute:job.route,selectedJob:{...job} as VibronicLogJob&{inheritedFrom?:VibronicLogJob},errors,warnings};
  if(!job.hasFrequencyData)errors.push('所选作业没有完整频率数表；不能借用其它作业的频率。');
  const inherited=tokens.some(token=>/^genchk$/i.test(token)||/^scrf=check$/i.test(token)||/^guess=tcheck$/i.test(token));
  if(!inherited)return result;
  const previous=jobs[job.index-1];
  const bridge=tokens.some(t=>/^genchk$/i.test(t))&&tokens.some(t=>/^geom=allcheck$/i.test(t))&&tokens.some(t=>/^guess=tcheck$/i.test(t));
  if(!previous||job.boundary!=='internal-link'||!bridge){errors.push('自动Freq继承缺少相邻Opt作业及GenChk/Geom=AllCheck/Guess=TCheck完整桥；不能猜测SCRF或电子态。');return result;}
  const priorLines=segmentLines(lines,previous),priorText=priorLines.join('\n'),prior=gaussianRouteTokens(previous.route);
  if(!previous.normalTermination||previous.hasFrequencyData||!prior.some(t=>key(t)==='opt')||!prior.some(t=>key(t)==='freq')||!/Optimization completed/.test(priorText)){errors.push('自动Freq前一段未证明正常完成的Opt Freq优化；不跨段拼接科学证据。');return result;}
  if(prior.some(t=>key(t)==='opt'&&/\b(?:ts|qst2|qst3|modredundant|modfreeze|readopt|addredundant)\b/i.test(t))){errors.push('相邻优化带TS、扫描或约束定义；本入口不能将其自动当作完整极小点频率来源。');return result;}
  const declared=priorText.match(/^\s*%chk\s*=\s*(.+)$/im)?.[1];
  const actual=result.text.match(/Structure from the checkpoint file:\s*"([^"]+)"/i)?.[1];
  if(!declared||!actual||checkpointName(declared)!==checkpointName(actual)){errors.push('自动Freq读取的CHK与相邻Opt实际%chk未能唯一对应。');return result;}
  try {
    const a=geometry(priorLines),b=geometry(body);
    if(a.gaussianSource?.frozenAtoms?.length||a.gaussianSource?.coordinates?.length)errors.push('相邻优化含冻结原子或额外内坐标定义，未证明无约束极小点。');
    if(a.charge!==b.charge||a.multiplicity!==b.multiplicity||a.atoms.length!==b.atoms.length||a.atoms.some((atom,i)=>atom.element!==b.atoms[i].element||Math.hypot(atom.x-b.atoms[i].x,atom.y-b.atoms[i].y,atom.z-b.atoms[i].z)>2e-5))errors.push('自动Freq与相邻Opt最终几何、原子序列或电荷/多重度不一致。');
  }catch{errors.push('自动Freq或相邻Opt缺少完整可核对的几何/电子态。');}
  const level=(ts:string[])=>ts.find(t=>/^[A-Za-z][A-Za-z0-9-]*\/[^\s]+$/.test(t)&&key(t)!=='iop');
  const aLevel=level(prior),bLevel=level(tokens);
  if(!aLevel||!bLevel||!(norm(aLevel)===norm(bLevel)||'r'+norm(aLevel)===norm(bLevel)||norm(aLevel)==='r'+norm(bLevel)))errors.push('自动Freq与相邻Opt的方法/基组不一致。');
  const parentTd=prior.find(t=>['td','cis','tda'].includes(key(t))),childTd=tokens.find(t=>['td','cis','tda'].includes(key(t)));
  if(Boolean(parentTd)!==Boolean(childTd))errors.push('自动Freq与相邻Opt的激发态方法标记不一致，不能从另一段补目标根。');
  if(parentTd&&childTd){
    const root=(t:string)=>t.match(/\broot\s*=\s*(\d+)/i)?.[1];
    const options=(t:string)=>t.replace(/^[a-z]+\s*=?\s*/i,'').replace(/^\((.*)\)$/,'$1').split(',').map(norm).filter(v=>v&&v!=='read').sort().join(',');
    if(key(parentTd)!==key(childTd)||!root(parentTd)||root(parentTd)!==root(childTd)||options(parentTd)!==options(childTd))errors.push('自动Freq的TD/CIS根或状态参数未与相邻Opt一致证明。');
  }
  const parentScrf=prior.find(t=>key(t)==='scrf'),childScrf=tokens.find(t=>key(t)==='scrf');
  if(parentScrf&&(!childScrf||!(/^scrf=check$/i.test(childScrf)||norm(parentScrf)===norm(childScrf))))errors.push('相邻Opt明确使用SCRF，但自动Freq缺少SCRF=Check或一致的显式SCRF，不能恢复其溶剂环境。');
  const control=new Set(['genchk','geom','guess','freq','td','cis','tda']);
  for(const token of tokens){if(control.has(key(token))||token===bLevel||/^scrf=check$/i.test(token))continue;if(!prior.some(t=>norm(t)===norm(token)))errors.push(`自动Freq出现前段未确认的设置 ${token}，不静默替换。`);}
  if(prior.some(t=>/^scrf=check$/i.test(t)||/^genchk$/i.test(t)))errors.push('前段本身仍使用未展开的继承设置，无法证明完整科学条件。');
  if(errors.length)return result;
  const inheritedTokens=prior.filter(t=>!['opt','freq','pop','geom','guess','genchk'].includes(key(t)));
  const frequency=tokens.find(t=>key(t)==='freq');if(!frequency){errors.push('自动Freq缺少明确频率任务。');return result;}
  result.effectiveRoute='#p '+[...inheritedTokens,frequency].join(' ');result.selectedJob.inheritedFrom=previous;
  warnings.push(`明确选择作业${job.index+1}（第${job.startLine}–${job.endLine}行）；其方法和环境经相邻作业${previous.index+1}的CHK、最终几何和电子态核对后继承。`);
  if(!parentScrf&&childScrf&&/^scrf=check$/i.test(childScrf))warnings.push('完整优化Route未请求连续介质；自动频率的SCRF=Check经已核CHK桥保持气相。');
  if(prior.some(t=>key(t)==='pop'))warnings.push('前作业Pop分析属于其独立任务，自动频率Route未请求该分析，后续振电输入不重发。');
  return result;
}
