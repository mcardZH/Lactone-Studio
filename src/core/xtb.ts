import type { FileSettings,GaussianSettings,JobRequest,TaskId,XtbSettings } from './types';
import { defaultAdvanced } from './advanced';
import { defaultTaskOptions,activeCoordinates } from './tasks';
import { atomicNumber } from './elements';
import { hasSolvation } from './solvents';
export const isXtb=(method:GaussianSettings['method'])=>method==='gfn2-xtb';
export const XTB_TASKS:TaskId[]=['opt','optfreq','freq','ts','irc','scan','constrained'];
export function defaultXtb():XtbSettings{return {scriptPath:'./xtb.sh',executable:'xtb',level:'--gfn 2',entryBasis:false,scriptConfirmed:false};}
const safePath=/^(?:\.?\.?\/|\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const validPath=(value:string)=>safePath.test(value)&&!/[\s\0]/.test(value);
export function xtbLevelError(level:string):string|null{
  if(/[\r\n\0]/.test(level))return 'xTB计算级别必须为单行，不能通过换行增加命令。';
  const match=level.trim().match(/^--gfn\s+([012])(?:\s+--(gbsa|alpb)\s+([A-Za-z][A-Za-z0-9-]*))?$/);
  if(!match)return 'xTB计算级别仅接受--gfn 0/1/2及可选--gbsa/--alpb 溶剂；不接受电荷、自旋、执行或线程参数。';
  const [,gfn,model,raw]=match,solvent=raw?.toLowerCase();
  const alpb=['acetone','acetonitrile','aniline','benzaldehyde','benzene','ch2cl2','chcl3','cs2','dioxane','dmf','dmso','ethanol','ether','ethylacetate','furane','hexadecane','hexane','methanol','nitromethane','octanol','woctanol','phenol','toluene','thf','water'];
  const gbsa=['acetone','acetonitrile','ch2cl2','chcl3','cs2','dmso','ether','water','h2o','methanol','thf','toluene',...(gfn==='1'?['benzene']:['dmf','n-hexane'])];
  if(model&&(gfn==='0'||!(model.toLowerCase()==='alpb'?alpb:gbsa).includes(solvent!)))return '该GFN/溶剂模型/溶剂组合未进入本版核实表；不会将Gaussian溶剂名称直接套给xTB。';
  return null;
}
export function xtbHessian(settings:GaussianSettings,files:FileSettings,count:number|undefined){return files.hessian==='none'?(settings.task==='ts'?(count!==undefined&&count<60?'calcall':'calcfc'):'none'):files.hessian;}
export function xtbNeedsFrequency(settings:GaussianSettings,files:FileSettings,count:number|undefined){return settings.task==='ts'&&xtbHessian(settings,files,count)!=='calcall';}
export function xtbRoute(settings:GaussianSettings,files:FileSettings,count:number|undefined):string{
  const options=settings.taskOptions??defaultTaskOptions(),advanced=settings.advanced??defaultAdvanced(settings.task),xtb=settings.xtb??defaultXtb(),route:string[]=[],opt:string[]=[];
  if(settings.task==='ts')opt.push('ts');if(advanced.optConvergence==='loose')opt.push('loose');
  if(advanced.optConvergence==='tight'||advanced.optConvergence==='verytight')opt.push(advanced.optConvergence);
  const hessian=xtbHessian(settings,files,count);if(hessian==='recalcfc'){if(files.recalcInterval)opt.push('recalcfc='+files.recalcInterval);}else if(hessian!=='none')opt.push(hessian);
  if(settings.task==='ts')opt.push('noeigentest');
  const hasCoordinates=activeCoordinates({settings}).length>0;
  if(['opt','optfreq','ts','scan','constrained'].includes(settings.task)&&hasCoordinates)opt.push('modredundant');
  if(advanced.maxStep!==null)opt.push('maxstep='+advanced.maxStep,'notrust');if(advanced.optMaxCycles!==null)opt.push('maxcycles='+advanced.optMaxCycles);
  if(['opt','optfreq','ts','scan','constrained'].includes(settings.task)){opt.push('nomicro');route.push('opt=('+opt.join(',')+')');}
  if(settings.task==='freq'||settings.task==='optfreq'&&hessian!=='calcall')route.push(settings.task==='freq'&&hasCoordinates?'freq=modredundant':'freq');
  if(settings.task==='freq'||settings.task==='optfreq'||hessian==='calcall'){
    if(options.frequency?.temperatureK!=null)route.push('temperature='+options.frequency.temperatureK);
    if(options.frequency?.pressureAtm!=null)route.push('pressure='+options.frequency.pressureAtm);
  }
  if(settings.task==='irc'){const irc=['calcfc',...(options.irc.lqa?['lqa']:[]),'maxpoints='+(options.irc.maxPoints??100)];if(options.irc.stepSize!==null)irc.push('stepsize='+options.irc.stepSize);route.push('irc=('+irc.join(',')+')');}
  if(settings.task==='irc'&&hasCoordinates)route.push('geom=modredundant');
  if(xtb.entryBasis)route.push('ugbs');if(settings.nosymm)route.push('nosymm');route.push('external="'+xtb.scriptPath+'"');return '#p '+route.join(' ');
}
export function xtbInputErrors(request:JobRequest):string[]{
  const {settings}=request,files=request.files!,xtb=settings.xtb??defaultXtb(),errors:string[]=[];
  if(!XTB_TASKS.includes(settings.task))errors.push('本版xTB挂接支持Opt/OptFreq/Freq/TS/IRC/Scan/冻结优化；不将其它DFT性质任务直接套给External。');
  if(files.geometry!=='explicit')errors.push('xTB挂接必须使用显式坐标，不从CHK读取几何。');
  if(files.saveCheckpoint||files.readCheckpoint||files.guessRead||files.basisFromCheckpoint||['readfc','rcfc'].includes(files.hessian))errors.push('xTB挂接不使用CHK/oldchk/Guess=Read/ChkBasis/ReadFC/RCFC，请清除旧读取设置。');
  if(hasSolvation(settings))errors.push('xTB溶剂在接口脚本的计算级别中设置，不添加Gaussian SCRF。');
  if(request.structure?.atoms.some(atom=>atomicNumber(atom.element)>86))errors.push('当前GFN-xTB参数仅核实至Rn（Z=86）；UGBS不能补齐更重元素的xTB参数。');
  if(!validPath(xtb.scriptPath)||!xtb.scriptPath.endsWith('.sh'))errors.push('xTB挂接脚本路径须为安全ASCII Linux路径并以.sh结尾，不能含空格或附加命令。');
  if(!validPath(xtb.executable))errors.push('xTB可执行路径须为安全ASCII Linux路径或xtb，不接受附加命令。');
  const levelError=xtbLevelError(xtb.level);if(levelError)errors.push(levelError);
  if(!xtb.scriptConfirmed)errors.push('请核对运行环境的xTB脚本与当前路径/计算级别一致；网页不会部署或验证服务器文件。');
  return errors;
}
export interface ScriptPatch {text:string;changes:{line:number;before:string;after:string}[];threads:string[]}
/** Strictly patches only the two supported command lines and their exact Running mirrors. */
export function patchXtbScript(original:string,settings:XtbSettings):ScriptPatch{
  if(original.length>1024*1024||original.includes('\0')||original.startsWith('\uFEFF'))throw new Error('挂接脚本须为无BOM的文本，大小不超过1MB。');
  if(original.includes('\r'))throw new Error('挂接脚本需使用Linux LF换行；请先转换原文件后重新提供，本页不静默改写整份脚本。');
  if(!validPath(settings.executable))throw new Error('xTB可执行路径含不安全字符。');
  const levelError=xtbLevelError(settings.level);if(levelError)throw new Error(levelError);
  const lines=original.split('\n'),next=[...lines],changes:ScriptPatch['changes']=[],kinds=new Set<string>();let branch='';
  const command=/^(\s*)([A-Za-z0-9_./-]+)(\s+mol\.xyz\s+--chrg\s+\$charge\s+--uhf\s+\$uhf\s+)((?:--hess\s+)?--grad)(\s+)(--gfn\s+[012](?:\s+--(?:gbsa|alpb)\s+[A-Za-z0-9-]+)?)(\s+>\s*xtbout\s*)$/;
  for(let i=0;i<lines.length;i++){
    const condition=lines[i].match(/^\s*(?:if|elif)\s+\[\s+\$derivs\s+==\s+"([12])"\s*\]\s*;\s*then\s*$/);if(condition)branch=condition[1]==='2'?'hessian':'gradient';else if(/^\s*(?:fi|else)\s*(?:;.*)?$/.test(lines[i]))branch='';
    const match=lines[i].match(command);if(!match)continue;
    const kind=match[4].includes('--hess')?'hessian':'gradient';if(branch!==kind)throw new Error('xTB命令与derivs分支不一致，未修改未知导数逻辑。');if(kinds.has(kind))throw new Error('挂接脚本存在重复xTB分支，未按固定行号盲替换。');kinds.add(kind);
    const oldCommand=lines[i].trim(),mirror=lines[i-1]?.match(/^(\s*echo\s+"Running:\s*)(.*)("\s*)$/);
    if(!mirror||mirror[2].trim()!==oldCommand)throw new Error('xTB实际命令与相邻Running提示不匹配，未修改未知脚本结构。');
    const changed=match[1]+settings.executable+match[3]+match[4]+match[5]+settings.level.trim()+match[7];
    next[i]=changed;next[i-1]=mirror[1]+changed.trim()+mirror[3];
  }
  if(kinds.size!==2)throw new Error('未找到一组受支持的梯度/Hessian实际命令及Running提示；保留原脚本，不重写电荷/自旋或导数逻辑。');
  for(let i=0;i<lines.length;i++)if(lines[i]!==next[i])changes.push({line:i+1,before:lines[i],after:next[i]});
  if(changes.length>4)throw new Error('脚本改动超过允许四行，已停止。');
  return {text:next.join('\n'),changes,threads:lines.filter(line=>/^\s*export\s+(?:OMP|MKL)_NUM_THREADS=/.test(line)).map(line=>line.trim())};
}
