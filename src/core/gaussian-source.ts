import type { AdvancedSettings, FileSettings, FragmentDefinition, GaussianSettings, InternalCoordinate, TaskId } from './types';
import { BASES, canonicalBasis, METHODS } from './catalog';
import { defaultAdvanced } from './advanced';
import { defaultTaskOptions, isOptimizationTask } from './tasks';
import { atomicNumber } from './elements';
import { extractGaussianBuiltinSolvent } from './solvents';
import { parseGaussianIntegral } from './gaussian-integral';

export interface SourceIssue { code:string; message:string; field?:string; severity:'missing'|'unsupported'|'conflict'|'warning'; raw?:string }
export interface InheritedRouteSettings { sourceId?:string; methodKeyword?:string; scf?:string; integration?:string; solvent?:string; extra?:string[]; angular?:'5D'|'6D'; fForm?:'7F'|'10F'; basisTail?:string; basisKeyword?:'gen'|'genecp' }
export interface GaussianSourceMeta {
  id:string; format:'gjf'|'out'|'fchk'; fileName:string; jobIndex:number; route:string; printedRoute?:string; title?:string; task?:TaskId;
  settings:Partial<GaussianSettings>; files:Partial<FileSettings>; resources?:{cores?:number;memoryGB?:number};
  frozenAtoms:number[]|null; coordinates:InternalCoordinate[]|null; issues:SourceIssue[]; routeOverrides:InheritedRouteSettings;
  rawTail?:string; fragments?:FragmentDefinition[]; layers?:{atoms:number[];label:string;kind:'qm'|'mm'|'middle'}[];
  charge?:number|null; multiplicity?:number|null;
}

/** Whitespace only separates tokens outside balanced parentheses and quoted paths. */
export function gaussianRouteTokens(route:string):string[] {
  const tokens:string[]=[];let token='',depth=0,quote='';
  for(const ch of route.replace(/^\s*#[pnt]?\s*/i,'')){
    if(quote){token+=ch;if(ch===quote)quote='';continue;}
    if(ch==='"'||ch==="'"){quote=ch;token+=ch;continue;}
    if(ch==='(')depth++;if(ch===')')depth--;
    if(/\s/.test(ch)&&depth===0){if(token)tokens.push(token);token='';}else token+=ch;
  }
  if(token)tokens.push(token);return tokens;
}
/** Reflow a native OUT echo without joining ordinary whitespace. Only a
 * physical newline inside one numeric IOp assignment has a proved numeric
 * continuation. Keep the unmodified physical echo separately at its owner. */
export function normalizeGaussianRouteEcho(printed:string):string {
  const header=printed.match(/^\s*#[pnt]?(?=\s|$)/i)?.[0].trim();
  const numeric=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
  const tokens=gaussianRouteTokens(printed).map(token=>{
    const iop=token.match(/^(iop(?:\s*=\s*)?\()([\s\S]*)(\))$/i);
    if(!iop)return token.replace(/\r?\n/g,' ');
    const body=iop[2].split(',').map(part=>{
      const assignment=part.match(/^(\s*\d+\s*\/\s*\d+\s*=\s*)([\s\S]*?)(\s*)$/);
      if(!assignment||!/[\d.eEdD+-][ \t]*\r?\n[ \t]*[\d.eEdD+-]/.test(assignment[2]))return part;
      const joined=assignment[2].replace(/[ \t]*\r?\n[ \t]*/g,'');
      return numeric.test(joined)?assignment[1]+joined+assignment[3]:part;
    }).join(',');
    return(iop[1]+body+iop[3]).replace(/\r?\n/g,' ');
  });
  return(header?header+' ':'')+tokens.join(' ');
}
const keyword=(token:string)=>token.match(/^([a-z][\w-]*)/i)?.[1].toLowerCase()??'';
const value=(token:string)=>token.replace(/^[^=(]+\s*=?\s*/,'').replace(/^\((.*)\)$/,'$1');
const optionNumber=(text:string,key:string)=>{const raw=text.match(new RegExp('(?:^|[,\\s])'+key+'\\s*=\\s*([+-]?\\d+)','i'))?.[1];return raw===undefined?undefined:Number(raw);};
const issue=(meta:GaussianSourceMeta,code:string,message:string,field:string,severity:SourceIssue['severity']='unsupported')=>meta.issues.push({code,message,field,severity});

/** A bounded method identity, shared by source-task inference and target-energy
 * selection. An arbitrary custom keyword is preserved but is not certified as
 * an SCF total or an implicit single point. */
export type GaussianMethodEnergyKind='scf'|'semiempirical'|'mp2'|'ccsd'|'ccsd(t)'|'qcisd';
export function gaussianMethodEnergyKind(method:string):GaussianMethodEnergyKind|null {
  const value=method.trim().toLowerCase();
  if(/^[ru]?pm[67]$/.test(value))return 'semiempirical';
  if(/^[ru]?mp2$/.test(value))return 'mp2';
  if(/^ccsd\(t\)$/.test(value))return 'ccsd(t)';
  if(/^ccsd$/.test(value))return 'ccsd';
  if(/^qcisd$/.test(value))return 'qcisd';
  return /^(?:[ru]?hf|rohf|[ru]?(?:b3lyp|b3pw91|blyp|bp86|pbe0|pbe1pbe|pbepbe|pbe|m06-2x|m062x|m06|m06l|m06-l|m052x|m05-2x|tpss|tpsstpss|tpssh|cam-b3lyp|camb3lyp|wb97xd|wb97x-d|wb97x|wb97m-v|b97d|b97-d|r2scan|scan|svwn|lsda))$/.test(value)?'scf':null;
}

/** Describes actual source settings, never recommended defaults. Source task and target task remain separate. */
export function parseGaussianSource(route:string,format:GaussianSourceMeta['format'],fileName:string,jobIndex=0):GaussianSourceMeta {
  const meta:GaussianSourceMeta={id:`${fileName}:${jobIndex}`,format,fileName,jobIndex,route,settings:{dispersion:'none',grid:'default',integral:{},scf:'default',nosymm:false,solvent:'',solventModel:'iefpcm',unrestricted:false},files:{geometry:'explicit',guessRead:false,basisFromCheckpoint:false},frozenAtoms:format==='gjf'?[]:null,coordinates:format==='gjf'?[]:null,issues:[],routeOverrides:{sourceId:`${fileName}:${jobIndex}`}};
  const tokens=gaussianRouteTokens(route),keys=tokens.map(keyword);
  for(const aliases of [['scf'],['int','integral'],['scrf'],['em','empiricaldispersion']])if(keys.filter(key=>aliases.includes(key)).length>1)issue(meta,'duplicate-route-field',`来源重复指定 ${aliases.join('/')}，不能只保留最后一项并声称完整继承。`,aliases[0]==='scrf'?'solvent':'route','conflict');
  const opt=tokens.find(t=>keyword(t)==='opt'),freq=keys.includes('freq'),td=tokens.find(t=>['td','tda','zindo'].includes(keyword(t)));
  meta.task=keys.includes('irc')?'irc':keys.includes('counterpoise')?'bsse':keys.includes('nmr')?'nmr':keys.includes('stable')?'stable':td?(opt||freq?'tdopt':'td'):opt?(/(?:^|[,=(])ts(?:[,)]|$)/i.test(opt)?'ts':freq?'optfreq':'opt'):freq?'freq':undefined;
  if(opt&&/\bqst[23]\b/i.test(opt))meta.task=/\bqst3\b/i.test(opt)?'qst3':'qst2';
  const advanced:AdvancedSettings=defaultAdvanced(meta.task??'sp');advanced.optConvergence='default';meta.settings.advanced=advanced;
  const taskOptions=defaultTaskOptions();meta.settings.taskOptions=taskOptions;
  let levelFound=false;
  for(const token of tokens){
    const key=keyword(token),arg=value(token);
    if(token.includes('/')&&!['iop','external'].includes(key)){
      const slash=token.indexOf('/'),rawMethod=token.slice(0,slash),rawBasis=token.slice(slash+1);
      if(!/^[a-z][\w-]*(?:\([^()]*\))?$/i.test(rawMethod)||!rawBasis){issue(meta,'method-format',`来源方法/基组写法尚未覆盖：${token}`,'method');continue;}
      const stripped=rawMethod.replace(/^[ru](?=b3lyp|m062x|pbe1pbe|cam-b3lyp|wb97xd|tpsstpss|tpssh)/i,'');
      const entry=METHODS.find(m=>m.keyword.toLowerCase()===stripped.toLowerCase());
      if(entry&&/^[ru]/i.test(rawMethod)&&stripped!==rawMethod)meta.routeOverrides.methodKeyword=rawMethod;
      meta.settings.method=entry?.id??'custom';meta.settings.customMethod=entry?'':rawMethod;meta.settings.unrestricted=/^u/i.test(rawMethod)&&Boolean(entry);
      meta.settings.basis=canonicalBasis(rawBasis);levelFound=true;
      if(/^gen(?:ecp)?$/i.test(rawBasis))meta.routeOverrides.basisKeyword=rawBasis.toLowerCase() as 'gen'|'genecp';
      else if(!BASES.some(b=>b.value===meta.settings.basis))issue(meta,'basis-catalog',`来源基组 ${rawBasis} 不在当前可编辑内置基组列表，请明确核对。`,'basis');
      continue;
    }
    const method=METHODS.find(m=>m.keyword.toLowerCase()===token.toLowerCase()&&['pm6','pm7'].includes(m.id));
    if(method){meta.settings.method=method.id;meta.settings.basis='';levelFound=true;continue;}
    if(['em','empiricaldispersion'].includes(key)){
      if(/^(gd3bj|gd3)$/i.test(arg))meta.settings.dispersion=arg.toLowerCase() as 'gd3bj'|'gd3';else issue(meta,'dispersion',`来源色散选项尚未覆盖：${token}`,'method');continue;
    }
    if(['int','integral'].includes(key)){meta.routeOverrides.integration=token;meta.settings.integral=parseGaussianIntegral(token);meta.settings.grid=/\bfine\b/i.test(arg)&&/acc2e\s*=\s*10/i.test(arg)?'efficient':'default';continue;}
    if(key==='scf'){
      meta.routeOverrides.scf=token;meta.settings.scf=/conver\s*=\s*6\b/i.test(arg)?'conver6':'default';
      advanced.scfAlgorithm=/\bxqc\b/i.test(arg)?'xqc':/\bqc\b/i.test(arg)?'qc':'default';
      advanced.noVarAcc=/\bnovaracc\b/i.test(arg);advanced.noIncFock=/\bnoincfock\b/i.test(arg);advanced.fermi=/\bfermi\b/i.test(arg);advanced.noDIIS=/\bnodiis\b/i.test(arg);
      advanced.vshift=optionNumber(arg,'vshift')??null;advanced.scfMaxCycle=optionNumber(arg,'maxcycles?')??null;advanced.maxConventional=optionNumber(arg,'maxconventionalcycles')??null;continue;
    }
    if(key==='scrf'){
      meta.routeOverrides.solvent=token;meta.settings.solventModel=/\bsmd\b/i.test(arg)?'smd':'iefpcm';meta.settings.solvent=extractGaussianBuiltinSolvent(arg,meta.settings.solventModel)??'';
      if(/\b(?:read|generic|external)\b/i.test(arg)||!meta.settings.solvent)issue(meta,'solvent-input',`SCRF需要额外参数或缺明确溶剂，不能仅凭路由完整恢复：${token}`,'solvent');continue;
    }
    if(key==='nosymm'){meta.settings.nosymm=true;continue;}
    if(key==='5d'||key==='6d'){meta.routeOverrides.angular=key.toUpperCase() as '5D'|'6D';continue;}
    if(key==='7f'||key==='10f'){meta.routeOverrides.fForm=key.toUpperCase() as '7F'|'10F';continue;}
    // Numeric angular keywords do not match the alphabetic keyword helper.
    if(/^(5d|6d)$/i.test(token)){meta.routeOverrides.angular=token.toUpperCase() as '5D'|'6D';continue;}
    if(/^(7f|10f)$/i.test(token)){meta.routeOverrides.fForm=token.toUpperCase() as '7F'|'10F';continue;}
    if(key==='opt'){
      advanced.optConvergence=/\bverytight\b/i.test(arg)?'verytight':/\btight\b/i.test(arg)?'tight':/\bloose\b/i.test(arg)?'loose':'default';advanced.maxStep=optionNumber(arg,'maxstep')??null;advanced.optMaxCycles=optionNumber(arg,'maxcycles')??null;
      if(advanced.maxStep!==null&&!/\bnotrust\b/i.test(arg))issue(meta,'maxstep-trust','来源MaxStep未配NoTrust；本界面小步长与NoTrust绑定，继承前需明确核对此差异。','task','conflict');
      if(advanced.maxStep===null&&/\bnotrust\b/i.test(arg))issue(meta,'notrust-unmapped','来源单独NoTrust当前未映射到控件；不能静默丢掉。','task');
      const hessian=arg.match(/\b(calcfc|calcall|rcfc|readfc|recalcfc)\b/i)?.[1]?.toLowerCase() as FileSettings['hessian']|undefined;
      if(hessian)meta.files.hessian=hessian;if(hessian==='recalcfc')meta.files.recalcInterval=optionNumber(arg,'recalcfc')??null;
      const rest=arg.split(',').map(v=>v.trim()).filter(v=>v&&!/^(?:ts|loose|tight|verytight|modredundant|calcfc|calcall|rcfc|readfc|noeigentest|notrust|recalcfc=\d+|maxstep=\d+|maxcycles=\d+)$/i.test(v));
      if(rest.length)issue(meta,'opt-options',`来源Opt还有未映射选项：${rest.join(', ')}；不会默默替换。`,'task');continue;
    }
    if(key==='freq'){if(arg&&arg!=='freq'&&arg.split(',').some(value=>!/^(modredundant|readfc|raman)$/i.test(value.trim())))issue(meta,'freq-options',`来源频率选项需要核对：${token}`,'task');if(/readfc/i.test(arg))meta.files.hessian='readfc';if(/\braman\b/i.test(arg))taskOptions.frequency={...taskOptions.frequency,raman:true};continue;}
    if(key==='temperature'||key==='pressure'){const n=Number(arg);if(!Number.isFinite(n)||n<=0)issue(meta,'thermochemistry-value','来源热化学温度或压力无效。','task');else taskOptions.frequency={...taskOptions.frequency,[key==='temperature'?'temperatureK':'pressureAtm']:n};continue;}
    if(key==='irc'){
      taskOptions.irc.maxPoints=optionNumber(arg,'maxpoints')??null;taskOptions.irc.stepSize=optionNumber(arg,'stepsize')??null;taskOptions.irc.lqa=/\blqa\b/i.test(arg);
      if(/\b(?:forward|reverse)\b/i.test(arg))issue(meta,'irc-direction','来源为单向IRC，目标网页生成单作业双向；请核对该差异。','task','conflict');
      if(/\brcfc\b/i.test(arg))meta.files.hessian='rcfc';else if(/\bcalcfc\b/i.test(arg))meta.files.hessian='calcfc';
      if(arg.split(',').some(v=>v.trim()&&!/^(?:rcfc|calcfc|lqa|forward|reverse|maxpoints=\d+|stepsize=\d+)$/i.test(v.trim())))issue(meta,'irc-options',`来源IRC还有未映射选项：${token}`,'task');continue;
    }
    if(['td','tda','zindo'].includes(key)){
      // An explicit TD/TDA source is not a UKS T1 optimization, even for Triplets Root=1.
      taskOptions.excited.useUks=false;
      taskOptions.excited.frequencyOnly=freq&&!opt;
      taskOptions.excited.approximation=key as 'td'|'tda'|'zindo';taskOptions.excited.root=optionNumber(arg,'root')??1;taskOptions.excited.nstates=optionNumber(arg,'nstates')??null;taskOptions.excited.spin=/50-50/i.test(arg)?'50-50':/triplets/i.test(arg)?'triplets':/singlets/i.test(arg)?'singlets':'default';taskOptions.excited.targetSpin=taskOptions.excited.spin==='triplets'?'triplets':'singlets';taskOptions.excited.frequency=freq;
      const unmapped=arg.split(',').map(v=>v.trim()).filter(v=>v&&!/^(?:singlets|triplets|50-50|root=\d+|nstates=\d+)$/i.test(v));if(unmapped.length)issue(meta,'excited-options',`来源${key.toUpperCase()}还有未映射选项：${unmapped.join(', ')}；不能静默丢失。`,'task');
      if(key==='zindo'){meta.settings.method='custom';meta.settings.customMethod='zindo';meta.settings.basis='';levelFound=true;}continue;
    }
    if(key==='nmr'){taskOptions.nmr.mode=/mixed/i.test(arg)?'mixed':/spinspin/i.test(arg)?'spinspin':'giao';if(arg.split(',').some(v=>v.trim()&&!/^(giao|spinspin|mixed)$/i.test(v.trim())))issue(meta,'nmr-options',`来源NMR还有未映射选项：${token}`,'task');continue;}
    if(key==='stable'){taskOptions.stable.optimize=/\bopt\b/i.test(arg);if(arg.split(',').some(v=>v.trim()&&!/^opt$/i.test(v.trim())))issue(meta,'stable-options',`来源Stable还有未映射选项：${token}`,'task');continue;}
    if(key==='counterpoise')continue;
    if(key==='iop'&&td&&/^9\s*\/\s*40\s*=\s*4$/i.test(arg)){taskOptions.excited.printCoefficients=true;continue;}
    if(key==='geom'){if(/check/i.test(arg))issue(meta,'geometry-chk','来源从CHK读取几何，继承仍需实际显式结构。','geometry','missing');else if(!/^modredundant$/i.test(arg))issue(meta,'geom-options',`来源Geom尚未映射：${token}`,'geometry');continue;}
    if(key==='guess'){if(/^read$/i.test(arg))meta.files.guessRead=true;else issue(meta,'guess-options',`来源初猜选项尚未映射：${token}`,'files');continue;}
    if(key==='chkbasis'){meta.files.basisFromCheckpoint=true;continue;}
    if(key==='units')continue;
    if(key==='pseudo'&&/read/i.test(arg)){meta.routeOverrides.basisKeyword='genecp';continue;}
    // Retain unknown text for explicit review rather than silently dropping it.
    (meta.routeOverrides.extra??=[]).push(token);
    meta.issues.push({code:'route-extra',message:`来源关键词需明确核对/保留：${token}`,field:'route',severity:'unsupported',raw:token});
  }
  if(!meta.task&&levelFound&&!keys.some(key=>['external','oniom'].includes(key))){
    const method=meta.settings.method==='custom'?meta.settings.customMethod:METHODS.find(entry=>entry.id===meta.settings.method)?.keyword;
    if(method&&gaussianMethodEnergyKind(method))meta.task='sp';
  }
  if(!meta.task)issue(meta,'task-unknown','来源未提供可可靠识别的任务；保留未知，不将缺失路由或未知方法标成单点能。','task','missing');
  if(!levelFound){issue(meta,'method-missing','来源未提供可可靠识别的方法/基组级别；请在最终页补齐，不以推荐默认值冒充继承。','method','missing');}
  if(meta.routeOverrides.basisKeyword)issue(meta,'basis-tail-missing','来源Gen/GenECP缺少可确认的完整基组附加段。','basis','missing');
  if(format!=='gjf')issue(meta,'constraints-unknown','该来源尚未提供可确认完整的冻结/约束输入；未发现不等于明确没有。','freeze','warning');
  return meta;
}

export function applyGaussianLink0(meta:GaussianSourceMeta,lines:string[]):void{
  meta.resources={};
  for(const line of lines){const match=line.match(/^\s*%([\w]+)\s*=\s*(.*?)\s*$/);if(!match)continue;const key=match[1].toLowerCase(),arg=match[2];
    if(key==='chk'){meta.files.saveCheckpoint=true;meta.files.checkpointName=arg;}
    else if(key==='oldchk'){meta.files.readCheckpoint=true;meta.files.oldCheckpoint=arg;}
    else if(key==='nprocshared'&&/^\d+$/.test(arg)){meta.resources.cores=Number(arg);meta.files.writeCores=true;}
    else if(key==='mem'){const memory=arg.match(/^(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|TW|GW|MW|KW)?$/i);if(memory){const unit=(memory[2]??'').toUpperCase(),factor:Record<string,number>={TB:1024,GB:1,MB:1/1024,KB:1/1024**2,TW:8*1024,GW:8,MW:8/1024,KW:8/1024**2,'':8/1024**3};const value=Number(memory[1])*factor[unit];if(Number.isFinite(value)&&value>0){meta.resources.memoryGB=value;meta.files.writeMemory=true;}else issue(meta,'memory-value',`来源内存数值无效：${arg}`,'files');}else issue(meta,'memory-unit',`来源内存单位尚未映射：${arg}`,'files');}
    else issue(meta,'link0',`来源Link0未映射：%${key}=${arg}`,'files');
  }
}

/** Supports actual F/S records only. Additional actions/explicit frozen values require review. */
export function applyGaussianTail(meta:GaussianSourceMeta,tail:string,atomCount:number,elements?:string[]):void{
  meta.issues=meta.issues.filter(i=>!['basis-tail-missing','ecp-tail-missing','basis-incomplete'].includes(i.code));
  meta.rawTail=tail;const basisStart=tail.split('\n').findIndex(line=>/^\s*(?:(?:\d+|[A-Za-z]{1,2})\s+)+0\s*$/.test(line));const lines=tail.split('\n');
  const coordinateLines=basisStart<0?lines:lines.slice(0,basisStart);const coordinates:InternalCoordinate[]=[];
  for(const raw of coordinateLines){const line=raw.split('!')[0].trim();if(!line)continue;const match=line.match(/^([BAD])\s+(.+?)\s+(F|S)(?:\s+(\d+)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?))?\s*$/i);
    if(!match){issue(meta,'tail-record',`未映射的坐标后附加输入：${line}`,'freeze');continue;}
    const atoms=match[2].split(/\s+/).map(Number),type=match[1].toUpperCase() as 'B'|'A'|'D',n=type==='B'?2:type==='A'?3:4;
    if(atoms.length!==n||new Set(atoms).size!==n||atoms.some(a=>!Number.isInteger(a)||a<1||a>atomCount)){issue(meta,'coordinate-reference',`来源内坐标引用/写法需核对：${line}`,'freeze','conflict');continue;}
    const scan=match[3].toUpperCase()==='S';if(scan&&!match[4]){issue(meta,'scan-incomplete',`扫描步数/增量不完整：${line}`,'freeze','missing');continue;}
    coordinates.push({type,atoms,action:scan?'scan':'freeze',steps:scan?Number(match[4]):1,increment:scan?Number(match[5].replace(/[dD]/,'e')):null});
  }
  meta.coordinates=coordinates;if(coordinates.some(c=>c.action==='scan'))meta.task='scan';
  if(basisStart>=0&&meta.routeOverrides.basisKeyword){const basisTail=lines.slice(basisStart).join('\n').trim();meta.routeOverrides.basisTail=basisTail;
    if(!/\*\*\*\*/.test(basisTail))issue(meta,'basis-incomplete','Gen基组段缺少****结束标记，不能完整继承。','basis','missing');
    const orbitalEnd=basisTail.lastIndexOf('****'),ecpTail=basisTail.slice(orbitalEnd+4).trim();
    if(meta.routeOverrides.basisKeyword==='genecp'&&!/^\s*(?:(?:\d+|[A-Za-z]{1,2})\s+)+0\s*\n\s*\S[\s\S]*$/.test(ecpTail))issue(meta,'ecp-tail-missing','来源GenECP没有可确认完整的ECP中心与势函数段；仅有轨道基组的****不代表ECP完整。','basis','missing');
    if(/(?:^|\n)\s*@/.test(basisTail))issue(meta,'basis-external','来源基组引用外部文件，当前未读取该文件；不能宣称完整恢复。','basis','missing');
    const covered=new Set<number>(),requiredEcp=new Set<number>(),builtinBlocks:{basis:string;atoms:number[]}[]=[];let simpleBuiltin=true;
    const centers=(line:string,kind:string):number[]=>{
      const match=line.trim().match(/^((?:-?[A-Za-z]{1,2}|\d+)(?:\s+(?:-?[A-Za-z]{1,2}|\d+))*)\s+0$/);if(!match){issue(meta,'basis-centers',`来源${kind}中心行无法可靠解析：${line}`,'basis','missing');return [];}
      const selected:number[]=[];for(const selector of match[1].split(/\s+/)){
        if(/^\d+$/.test(selector)){const n=Number(selector);if(n<1||n>atomCount)issue(meta,'basis-center-range',`来源${kind}引用范围外原子 ${selector}（共${atomCount}原子）。`,'basis','conflict');else selected.push(n);}
        else if(elements){const symbol=selector.replace(/^-/,'').toLowerCase(),matches=elements.flatMap((element,i)=>element.toLowerCase()===symbol?[i+1]:[]);if(!matches.length&&!selector.startsWith('-'))issue(meta,'basis-center-element',`来源${kind}元素 ${selector} 不在当前结构中。`,'basis','conflict');selected.push(...matches);}
        else issue(meta,'basis-center-unverified','来源以元素指定基组中心，但当前缺逐原子元素信息，尚未确认完整覆盖。','basis','missing');
      }return selected;
    };
    const orbital=basisTail.slice(0,orbitalEnd+4).split(/\*\*\*\*/).filter(block=>block.trim());
    for(const block of orbital){const rows=block.trim().split('\n').map(line=>line.trim()).filter(Boolean);const selected=centers(rows[0]??'','轨道基组');selected.forEach(n=>covered.add(n));if(rows.length<2)issue(meta,'basis-block-empty','来源基组中心后缺少基组名称/壳层数据。','basis','missing');
      if(rows.length===2){const basis=canonicalBasis(rows[1]);if(!BASES.some(entry=>entry.value===basis&&basis!=='ma-def2TZVP')){simpleBuiltin=false;issue(meta,'basis-name-unverified',`来源Gen名称 ${rows[1]} 不在当前已核实内置列表，保留原文但不能宣称完整恢复。`,'basis','unsupported');}else builtinBlocks.push({basis,atoms:selected});}else simpleBuiltin=false;
      if(rows.length===2&&/^def2/i.test(rows[1])&&elements)selected.filter(n=>atomicNumber(elements[n-1])>=37).forEach(n=>requiredEcp.add(n));
      else if(rows.length>2)issue(meta,'basis-shell-review','来源含显式壳层数值；已保留原文，但本轮未核验每个收缩/指数数据，请明确核对。','basis','unsupported');
    }
    if(covered.size!==atomCount)issue(meta,'basis-coverage',`来源Gen轨道基组只覆盖${covered.size}/${atomCount}个原子，不能宣称完整继承。`,'basis','missing');
    const ecpCovered=new Set<number>();
    if(meta.routeOverrides.basisKeyword==='genecp'&&ecpTail){for(const block of ecpTail.split(/\n\s*\n/).filter(b=>b.trim())){const rows=block.trim().split('\n').map(l=>l.trim()).filter(Boolean);centers(rows[0]??'','ECP').forEach(n=>ecpCovered.add(n));if(rows.length<2)issue(meta,'ecp-block-empty','来源ECP中心后缺少势函数名称/数据。','basis','missing');if(rows.length>2)issue(meta,'ecp-data-review','来源含显式ECP数值，已保留原文但尚未原生核验参数。','basis','unsupported');}
      if([...requiredEcp].some(n=>!ecpCovered.has(n)))issue(meta,'ecp-coverage','来源def2重元素中心缺少配套ECP覆盖，不能完整继承。','basis','missing');
    }
    if(requiredEcp.size&&meta.routeOverrides.basisKeyword!=='genecp')issue(meta,'ecp-required','来源Gen内def2重元素需要配套ECP，但未声明Pseudo=Read/GenECP。','basis','missing');
    const flattened=builtinBlocks.flatMap(block=>block.atoms),unique=flattened.length===new Set(flattened).size;
    const simpleEcp=meta.routeOverrides.basisKeyword!=='genecp'||(ecpCovered.size===requiredEcp.size&&[...ecpCovered].every(n=>requiredEcp.has(n))&&ecpTail.split(/\n\s*\n/).every(block=>{const rows=block.trim().split('\n').map(l=>l.trim()).filter(Boolean);return rows.length===2&&/^def2(?:ecp)?$/i.test(rows[1]);}));
    if(simpleBuiltin&&simpleEcp&&unique&&covered.size===atomCount&&builtinBlocks.length&&meta.routeOverrides.fForm!=='10F'&&!meta.issues.some(i=>i.field==='basis'&&i.severity!=='warning')){
      meta.settings.basis=builtinBlocks[0].basis;meta.settings.mixedBasis={enabled:true,dForm:meta.routeOverrides.angular??'5D',regions:builtinBlocks.slice(1).map((block,index)=>({id:`source-basis-${index+1}`,name:`来源基组区域 ${index+1}`,basis:block.basis,atoms:block.atoms}))};
    }else if(!unique)issue(meta,'basis-additive-overlap','来源Gen在同一中心含多个加和块；保留原文，不能当作区域覆盖式混合基组。','basis','unsupported');
  }else if(meta.routeOverrides.basisKeyword)issue(meta,'basis-tail-missing','来源Gen/GenECP缺少可确认的完整基组附加段。','basis','missing');
  if(meta.settings.taskOptions){meta.settings.taskOptions.coordinates=coordinates;meta.settings.taskOptions.frozenAtoms=meta.frozenAtoms??[];meta.settings.taskOptions.constraintsEnabled=Boolean(coordinates.some(c=>c.action!=='scan')||meta.frozenAtoms?.length);}
}

export function deriveInheritedSettings(source:GaussianSourceMeta,defaults:GaussianSettings,target:TaskId):GaussianSettings{
  const inherited=structuredClone(source.settings),options=structuredClone(defaults.taskOptions??defaultTaskOptions());
  const sourceOptions=inherited.taskOptions;
  if(sourceOptions){options.coordinates=structuredClone(source.coordinates??[]).filter(c=>c.action!=='scan'||target==='scan');options.coordinateDrafts=undefined;options.frozenAtoms=[...(source.frozenAtoms??[])];options.constraintsEnabled=Boolean(options.frozenAtoms.length||options.coordinates.some(c=>c.action!=='scan'));if(source.fragments)options.fragments=structuredClone(source.fragments);
    if(['freq','optfreq','ts','tdopt'].includes(target))options.frequency=structuredClone(sourceOptions.frequency);
    if(target==='td'||target==='tdopt')options.excited={...options.excited,...sourceOptions.excited};if(target==='irc'&&source.task==='irc')options.irc={...options.irc,...sourceOptions.irc,confirmed:false};if(target==='nmr')options.nmr={...sourceOptions.nmr};if(target==='stable')options.stable={...sourceOptions.stable,confirmed:false};
  }
  const advanced={...defaultAdvanced(target),...inherited.advanced};if(!isOptimizationTask(target)){advanced.maxStep=null;advanced.optMaxCycles=null;advanced.optConvergence='default';}
  const inheritanceIssues=structuredClone(source.issues);
  if(gaussianRouteTokens(source.route).some(token=>['td','tda','zindo'].includes(keyword(token)))&&!['td','tdopt'].includes(target))inheritanceIssues.push({code:'excited-surface-target',message:'来源使用TD/TDA激发态势能面，当前目标任务未实现同态转换；不能丢掉TD关键词生成基态输入。',field:'task',severity:'unsupported'});
  if(target==='tdopt'&&sourceOptions?.excited.spin==='50-50')inheritanceIssues.push({code:'mixed-spin-opt-target',message:'来源50-50混合求解的Root不能直接视为S或T内部根；统一S/T优化需明确目标自旋及对应Root，不能静默改成单重态。',field:'task',severity:'unsupported'});
  if(target!=='scan'&&source.coordinates?.some(coordinate=>coordinate.action==='scan'))inheritanceIssues.push({code:'scan-not-transferred',message:'来源扫描S记录不适用于当前目标，未转成冻结F；已保留真正冻结原子/内坐标。',field:'freeze',severity:'warning'});
  if(target==='tdopt'&&source.multiplicity===3&&source.settings.unrestricted&&!/(?:^|\s)(?:td|tda)[=(\s]/i.test(source.route)){options.excited.targetSpin='triplets';options.excited.useUks=true;options.excited.root=1;options.excited.frequency=source.task==='optfreq'||source.task==='freq';options.excited.frequencyOnly=source.task==='freq';}
  return {...defaults,...inherited,task:target,advanced,taskOptions:options,inheritedRoute:structuredClone(source.routeOverrides),inheritanceIssues};
}
