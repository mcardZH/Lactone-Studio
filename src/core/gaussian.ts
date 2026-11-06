import type { FileSettings, GaussianSettings, JobRequest, MethodId, TaskId } from './types';
import { atomicNumber, electronicStateError } from './elements';
import { BASES, canonicalBasis, METHODS } from './catalog';
import { defaultAdvanced } from './advanced';
import { angularBasisPlan, externalMaBasis, unsupportedElements } from './basis';
import { gaussianIntegralKeyword, parseGaussianIntegral } from './gaussian-integral';
export { effectiveGaussianIntegral } from './gaussian-integral';
import { TASKS,defaultTaskOptions,isOptimizationTask,isEnergyTask,usesEfficientGrid,spectrumStates,ircPoints,activeCoordinates,activeFrozenAtoms,isZindo } from './tasks';
import { taskInputErrors,coordinateTail } from './task-inputs';
import { isXtb,defaultXtb,xtbRoute,xtbInputErrors } from './xtb';
import { excitedFrequencyOnly, excitedOptimizationFrequency, isUksOptimization } from './excited-state';
import { mixedBasisErrors, mixedBasisPlan } from './mixed-basis';
import { buildGaussianSolvation, extractGaussianBuiltinSolvent } from './solvents';
import { oniomMethodKeyword, renderGaussianOniom, validateGaussianOniom } from './oniom';
import { defaultGaussianQstSettings, isQstTask, qstInputErrors, qstGeometrySections } from './gaussian-qst';
import { recommendedExcitedStates } from './input-recommendations';
export { METHODS } from './catalog';
export { TASKS } from './tasks';
export function defaultFiles(): FileSettings {
  return { saveCheckpoint: true, checkpointName: '', writeMemory: false, writeCores: false, readCheckpoint: false, oldCheckpoint: '', geometry: 'explicit', guessRead: false, hessian: 'none', recalcInterval: null, basisFromCheckpoint: false, compatibilityConfirmed: false, sourceElements: '' };
}
export function isSemiempirical(method: MethodId): boolean { return method === 'pm6' || method === 'pm7'; }
export function supportsGaussianRaman(settings:GaussianSettings,files:FileSettings):boolean {
  return !isXtb(settings.method)&&!isSemiempirical(settings.method)&&!isZindo(settings)
    &&(settings.method!=='custom'||/^(?:[ru]?hf|[ru]?mp2)$/i.test(settings.customMethod.trim()))
    &&!(settings.task==='tdopt'&&!isUksOptimization(settings))&&files.hessian!=='readfc';
}
export function supportsEfficientGrid(method: MethodId): boolean { return ['b3lyp', 'pbe0', 'cam-b3lyp'].includes(method); }
/** An active edit supersedes inherited d shells, so switching off cannot revive a stale 6D source. */
export function setUse5D(settings:GaussianSettings,enabled:boolean):GaussianSettings {
  const inheritedRoute=settings.inheritedRoute?{...settings.inheritedRoute,angular:undefined}:undefined;
  return {...settings,use5D:enabled,inheritedRoute,...(settings.mixedBasis?{mixedBasis:{...settings.mixedBasis,dForm:'5D',angularExplicit:false}}:{})};
}
export function defaultSettings(task: TaskId): GaussianSettings {
  const sp = isEnergyTask(task);
  return { task, method: sp ? 'm062x' : 'b3lyp', customMethod: '', basis: task==='nmr'?'6-311+G(2d,p)':sp ? 'def2TZVP' : 'def2SVP', dispersion: sp ? 'gd3' : 'gd3bj', grid: usesEfficientGrid(task) ? 'efficient' : 'default', scf: sp ? 'conver6' : 'default', nosymm: true, solvent: '', solventModel: sp||task==='nmr'||task==='td' ? 'smd' : 'iefpcm', advanced: defaultAdvanced(task),taskOptions:defaultTaskOptions(),...(isQstTask(task)?{qst:defaultGaussianQstSettings()}:{}) };
}
export function methodDefaults(method: MethodId, task: TaskId): Partial<GaussianSettings> {
  if(isXtb(method))return {method,dispersion:'none',grid:'default',integral:undefined,scf:'default',unrestricted:false,solvent:'',solvation:undefined,xtb:defaultXtb()};
  return { method, integral:undefined, dispersion: METHODS.find(item => item.id === method)!.dispersion, grid: supportsEfficientGrid(method) && usesEfficientGrid(task) ? 'efficient' : 'default',...(isSemiempirical(method)||method==='custom'?{unrestricted:false}:{}) };
}
export function sourceLevel(route: string | undefined): Partial<GaussianSettings> | null {
  if (!route) return null;
  const match = route.match(/\b([a-z][\w-]*)\/([^\s]+)/i);
  if (!match) return null;
  const entry = METHODS.find(item => item.keyword === match[1].toLowerCase().replace(/^[ru](?=b3lyp|m062x|pbe1pbe|cam-b3lyp|wb97xd|tpsstpss|tpssh)/, ''));
  if (!entry || /^(gen|genecp)$/i.test(match[2])) return null;
  const dispersion = /\b(?:em|empiricaldispersion)\s*=\s*gd3bj/i.test(route) ? 'gd3bj' : /\b(?:em|empiricaldispersion)\s*=\s*gd3\b/i.test(route) ? 'gd3' : 'none';
  const solventModel = /\bsmd\b/i.test(route) ? 'smd' : 'iefpcm';
  const solvent = extractGaussianBuiltinSolvent(route,solventModel) ?? '';
  if(/\bscrf\b/i.test(route)&&!solvent)return null;
  const integration=route.match(/\b(?:int|integral)\s*=\s*(?:\([^)]*\)|[^\s]+)/i)?.[0];
  return { method: entry.id, basis: canonicalBasis(match[2]), dispersion, solvent, solventModel, integral:integration?parseGaussianIntegral(integration):{},grid: /int\s*=\s*\(\s*fine\s*,\s*acc2e\s*=\s*10\s*\)/i.test(route) ? 'efficient' : 'default',scf:/\bconver\s*=\s*6\b/i.test(route)?'conver6':'default',unrestricted:/^u/i.test(match[1]) };
}
export function routeLine(settings: GaussianSettings, files = defaultFiles(), basisOverride?: string, atomCount?:number): string {
  const hasCoordinates=activeCoordinates({settings}).length>0;
  if(isXtb(settings.method)&&!isZindo(settings))return xtbRoute(settings,files,atomCount);
  if (settings.task === 'freq' && files.hessian === 'readfc') {
    const frequency=settings.taskOptions?.frequency;
    return '#p freq='+(hasCoordinates?'(readfc,modredundant)':'readfc') + (files.geometry === 'explicit' ? '' : ' geom=' + files.geometry)+(frequency?.temperatureK!=null?' temperature='+frequency.temperatureK:'')+(frequency?.pressureAtm!=null?' pressure='+frequency.pressureAtm:'');
  }
  const entry = METHODS.find(item => item.id === settings.method)!;
  let method = entry.id === 'custom' ? settings.customMethod.trim() : entry.keyword;
  if(settings.inheritedRoute?.methodKeyword&&!isUksOptimization(settings))method=settings.inheritedRoute.methodKeyword;
  if((isUksOptimization(settings)||settings.unrestricted)&&settings.method!=='custom'&&!isSemiempirical(settings.method)&&!method.toLowerCase().startsWith('u'))method='u'+method;
  const semi = isSemiempirical(settings.method);
  const route: string[] = [];
  const excitedFrequency=excitedOptimizationFrequency(settings);
  const advanced = settings.advanced ?? defaultAdvanced(settings.task,excitedFrequency);
  const options=settings.taskOptions??defaultTaskOptions();
  const opt: string[] = [];
  if(isQstTask(settings.task))opt.push(settings.task);
  if(settings.task==='ts')opt.push('ts');
  if (advanced.optConvergence === 'loose'&&!excitedFrequency) opt.push('loose');
  if (advanced.optConvergence === 'tight'||advanced.optConvergence === 'verytight') opt.push(advanced.optConvergence);
  if (files.hessian === 'recalcfc') { if (files.recalcInterval) opt.push('recalcfc=' + files.recalcInterval); }
  else if (files.hessian !== 'none') opt.push(files.hessian);
  else if(settings.task==='ts')opt.push('calcfc');
  if(settings.task==='ts')opt.push('noeigentest');
  if(hasCoordinates&&isOptimizationTask(settings.task))opt.push('modredundant');
  if (advanced.maxStep !== null) opt.push('maxstep=' + advanced.maxStep, 'notrust');
  if (advanced.optMaxCycles !== null) opt.push('maxcycles=' + advanced.optMaxCycles);
  if (isOptimizationTask(settings.task)&&!excitedFrequencyOnly(settings)) route.push(opt.length ? 'opt=' + (opt.length === 1 ? opt[0] : '(' + opt.join(',') + ')') : 'opt');
  if (excitedFrequencyOnly(settings)) route.push(hasCoordinates?'freq=modredundant':'freq');
  else if ((settings.task === 'optfreq'||settings.task==='ts'||excitedFrequency) && files.hessian !== 'calcall') route.push('freq');
  if(isQstTask(settings.task)&&settings.qst?.frequency===true)route.push('freq');
  if (settings.task === 'freq') route.push(hasCoordinates?'freq=modredundant':'freq');
  const frequency=options.frequency;
  const hasFrequency=route.some(keyword=>/^freq(?:=|$)/.test(keyword))||files.hessian==='calcall'&&isOptimizationTask(settings.task);
  if(hasFrequency){
    if(frequency?.raman){const i=route.findIndex(keyword=>/^freq(?:=|$)/.test(keyword));if(i>=0)route[i]=route[i]==='freq'?'freq=raman':route[i].startsWith('freq=(')?route[i].replace('freq=(', 'freq=(raman,'):'freq=(raman,'+route[i].slice(5)+')';else route.push('freq=raman');}
    if(frequency?.temperatureK!=null)route.push('temperature='+frequency.temperatureK);
    if(frequency?.pressureAtm!=null)route.push('pressure='+frequency.pressureAtm);
  }
  if(settings.task==='irc'){const irc=[files.hessian==='rcfc'?'rcfc':'calcfc',...(options.irc.lqa?['lqa']:[]),'maxpoints='+(options.irc.maxPoints??ircPoints(atomCount))];if(options.irc.stepSize!==null)irc.push('stepsize='+options.irc.stepSize);route.push('irc=('+irc.join(',')+')');}
  if((settings.task==='td'||settings.task==='tdopt'&&!isUksOptimization(settings))&&!settings.oniom?.enabled){const td:string[]=[];const spin=settings.task==='tdopt'?options.excited.targetSpin:options.excited.spin;if(spin!=='default')td.push(spin);td.push('nstates='+(options.excited.nstatesMode==='auto'||options.excited.nstates===null?recommendedExcitedStates(atomCount??20,settings.task,options.excited.root):options.excited.nstates));if(settings.task==='tdopt'||options.excited.root!==1)td.push('root='+options.excited.root);route.push(options.excited.approximation+'=('+td.join(',')+')');if(options.excited.printCoefficients)route.push('iop(9/40=4)');}
  if(settings.oniom?.enabled&&['td','tdopt'].includes(settings.task)&&options.excited.printCoefficients)route.push('iop(9/40=4)');
  if(settings.task==='nmr')route.push(options.nmr.mode==='giao'?'nmr=giao':options.nmr.mode==='mixed'?'nmr=(spinspin,mixed)':'nmr=spinspin');
  if(settings.task==='stable')route.push(options.stable.optimize?'stable=opt':'stable');
  if(settings.task==='bsse')route.push('counterpoise='+options.fragments.length);
  if(!isZindo(settings))route.push(settings.oniom?.enabled?oniomMethodKeyword(settings,method,semi?'':basisOverride??canonicalBasis(settings.basis),atomCount):semi ? method : method + '/' + (basisOverride ?? canonicalBasis(settings.basis)));
  if (!isZindo(settings)&&!semi && settings.method !== 'wb97xd' && settings.dispersion !== 'none') route.push('em=' + settings.dispersion);
  const inherited=settings.inheritedRoute;
  if (!isZindo(settings)&&!semi) { const integration=gaussianIntegralKeyword(settings);if(integration)route.push(integration); }
  if (!isZindo(settings)&&settings.method === 'tpssh' && settings.dispersion === 'gd3bj'&&!settings.inheritedRoute?.sourceId) route.push('iop(3/174=1000000,3/175=2238200,3/177=452900,3/178=4655000)');
  const scf: string[] = [];
  if (settings.scf === 'conver6') scf.push('conver=6');
  if (advanced.scfAlgorithm !== 'default') scf.push(advanced.scfAlgorithm==='qc'?'xqc':advanced.scfAlgorithm);
  for (const [key, keyword] of [['noVarAcc','novaracc'],['noIncFock','noincfock'],['fermi','fermi'],['noDIIS','nodiis']] as const) if (advanced[key]) scf.push(keyword);
  if (advanced.vshift !== null) scf.push('vshift=' + advanced.vshift);
  if (advanced.scfMaxCycle !== null) scf.push('maxcycle=' + advanced.scfMaxCycle);
  if (advanced.maxConventional !== null && advanced.scfAlgorithm === 'xqc') scf.push('maxconventionalcycles=' + advanced.maxConventional);
  if (inherited?.scf) route.push(inherited.scf.replace(/\bqc\b/gi,'xqc'));
  else if (scf.length) route.push('scf=' + (scf.length === 1 ? scf[0] : '(' + scf.join(',') + ')'));
  if(inherited?.solvent)route.push(inherited.solvent);
  else { const solvent=buildGaussianSolvation({...settings,requireRefractiveIndex:settings.task==='td'||settings.task==='tdopt'});if(solvent.route)route.push(solvent.route); }
  if (settings.nosymm) route.push('nosymm');
  if(settings.oniom?.enabled)route.push(settings.task==='irc'&&hasCoordinates?'geom=(modredundant,connectivity)':'geom=connectivity');
  else if(settings.task==='irc'&&hasCoordinates)route.push('geom=modredundant');
  if (files.geometry !== 'explicit') route.push('geom=' + (files.geometry === 'allcheck' ? 'allcheck' : 'check'));
  if (files.guessRead) route.push('guess=read');
  if(!isZindo(settings)&&!semi)route.push(...angularBasisPlan(settings,basisOverride).keywords);
  if(inherited?.extra?.length)route.push(...inherited.extra);
  return '#p ' + route.filter(Boolean).join(' ');
}
export function sourceElements(request: JobRequest): string[] {
  const files = request.files ?? defaultFiles();
  // Imported coordinates are authoritative only when they are actually output.
  if (files.geometry === 'explicit') {
    const oniom=request.settings.oniom;
    return [...new Set(oniom?.enabled?[...(request.structure?.atoms.filter(atom=>oniom.qmAtomIds.includes(atom.id??'')).map(atom=>atom.element)??[]),...oniom.boundaries.map(boundary=>boundary.linkElement)]:request.structure?.atoms.map(atom => atom.element) ?? [])];
  }
  return []; // CHK geometry deliberately has no element declaration or coverage/count check.
}
export function basisPlan(request: JobRequest): { keyword: string; tail: string } {
  if(isZindo(request.settings))return {keyword:'',tail:''};
  if (request.settings.task === 'freq' && request.files?.hessian === 'readfc') return { keyword: '', tail: '' };
  const basis = canonicalBasis(request.settings.basis);
  if(isXtb(request.settings.method))return {keyword:'',tail:''};
  if (isSemiempirical(request.settings.method)) return { keyword: '', tail: '' };
  if (request.files?.basisFromCheckpoint) return { keyword: 'ChkBasis', tail: '' };
  if(request.settings.mixedBasis?.enabled)return mixedBasisPlan(request);
  const inherited=request.settings.inheritedRoute;
  if(inherited?.basisKeyword&&inherited.basisTail)return {keyword:inherited.basisKeyword,tail:inherited.basisTail.trimEnd()+'\n\n'};
  // Keep an existing molecule's effective basis plan when only its coordinate
  // source changes. This does not certify the unknown contents of a CHK file.
  const elements = request.structure?.atoms.length
    ? sourceElements({...request,files:{...defaultFiles(),...request.files,geometry:'explicit'}})
    : sourceElements(request);
  if (basis === 'ma-def2TZVP') {
    if(!elements.length)throw new Error('ma-def2TZVP需要当前结构的实际元素或完整来源基组/ECP附加段；不为未知CHK扩写全元素基组。');
    return externalMaBasis(elements);
  }
  const heavy = elements.filter(element => atomicNumber(element) >= 37);
  if (/^def2(?:SVP|SVPP|TZVP|TZVPP|QZVP)$/i.test(basis) && heavy.length) {
    return { keyword: 'genecp', tail: elements.join(' ') + ' 0\n' + basis + '\n****\n\n' + heavy.join(' ') + ' 0\ndef2\n\n' };
  }
  return { keyword: basis, tail: '' };
}
export function previewRoute(request: JobRequest): string {
  try { return routeLine(request.settings, request.files, basisPlan(request).keyword,request.structure?.atoms.length); }
  catch { return routeLine(request.settings, request.files,undefined,request.structure?.atoms.length); }
}
export function headerLines(request: JobRequest): string[] {
  const files = request.files ?? defaultFiles(); const headers: string[] = [];
  if(isXtb(request.settings.method)&&!isZindo(request.settings)){if(files.writeMemory&&request.memoryGB>0)headers.push('%mem='+request.memoryGB+'GB');headers.push('%nprocshared=1');return headers;}
  if (files.readCheckpoint && files.oldCheckpoint.trim()) headers.push('%oldchk=' + files.oldCheckpoint.trim());
  if (files.saveCheckpoint) headers.push('%chk=' + (files.checkpointName.trim() || request.name + '.chk'));
  if (files.writeMemory && request.memoryGB > 0) headers.push('%mem=' + request.memoryGB + 'GB');
  if (files.writeCores && request.cores > 0) headers.push('%nprocshared=' + request.cores);
  return headers;
}
export function previewInputHeader(request: JobRequest): string { return [...headerLines(request), previewRoute(request)].join('\n'); }
const safeName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const chkName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.chk$/i;
const windowsDeviceName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
function safeGaussianStem(value: string): boolean {
  return safeName.test(value) && !value.endsWith('.') && !windowsDeviceName.test(value);
}
function safeGaussianCheckpoint(value: string): boolean {
  return chkName.test(value) && safeGaussianStem(value.slice(0, -4));
}
export function safeGaussianCheckpointReference(value: string): boolean {
  if (safeGaussianCheckpoint(value)) return true;
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(value) || !/^[A-Za-z0-9_./\\:-]+$/.test(value)) return false;
  const path = value.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 && parts.every(part => part !== '.' && part !== '..' && safeGaussianStem(part)) && safeGaussianCheckpoint(parts[parts.length - 1]);
}
export function validateJob(request: JobRequest): string[] {
  const errors: string[] = [];
  const files = request.files ?? defaultFiles();
  const { settings } = request;
  errors.push(...(settings.inheritanceIssues??[]).filter(issue=>issue.severity!=='warning').map(issue=>'来源继承：'+issue.message));
  if(settings.mixedBasis?.enabled)errors.push(...mixedBasisErrors(request));
  try{const oniomBasis=basisPlan(request);errors.push(...validateGaussianOniom(request,oniomBasis.keyword,oniomBasis.tail));}catch{errors.push(...validateGaussianOniom(request));}
  const explicit = files.geometry === 'explicit';
  const reuseFrequency = settings.task === 'freq' && files.hessian === 'readfc';
  if (explicit && !request.structure?.atoms.length) errors.push('请先导入完整结构。');
  if (explicit && request.structure?.dimension === 2) errors.push('当前是二维结构，请先生成真实三维，再导出量化坐标。');
  if (explicit && request.structure?.cell?.pbc.some(Boolean)) errors.push('当前为周期模型；本版Gaussian输入仅支持有限分子。请明确导出无盒模型并重新载入后生成，晶胞不会静默省略。');
  if (explicit && request.structure?.atoms.length) {
    const stateError = electronicStateError(request.structure.atoms, request.charge, request.multiplicity);
    if (stateError) errors.push(stateError);
    if (request.structure.atoms.some(atom => ![atom.x, atom.y, atom.z].every(Number.isFinite))) errors.push('结构包含非有限坐标。');
  } else if (files.geometry === 'check') {
    if (!Number.isInteger(request.charge)) errors.push('总电荷必须是整数。');
    if (!Number.isInteger(request.multiplicity) || request.multiplicity < 1) errors.push('自旋多重度必须是正整数。');
  }
  if (files.geometry !== 'allcheck' && !request.electronicStateConfirmed) errors.push('请先确认电荷和自旋多重度。');
  if (files.writeCores && (!Number.isSafeInteger(request.cores) || request.cores < 1)) errors.push('请选择核数，或填写可精确表示的正整数核数。');
  if (files.writeMemory && (!Number.isSafeInteger(request.memoryGB) || request.memoryGB < 1)) errors.push('请选择内存，或填写可精确表示的正整数 GB。');
  if (request.resourcesConfirmed === false) errors.push('请确认本次输入的核数与内存。');
  if (!safeGaussianStem(request.name)) errors.push('任务名只能使用英文字母、数字、点、连字符和下划线，不能含路径、Windows保留设备名或以点结尾。');
  if(isQstTask(settings.task))errors.push('QST2/QST3已撤下新输入生成；历史文件可继续查看。');
  const destination = files.checkpointName.trim() || request.name + '.chk';
  if (files.saveCheckpoint && (files.checkpointName.trim() || safeGaussianStem(request.name)) && !safeGaussianCheckpoint(destination)) errors.push('新CHK文件名须为ASCII安全名称并以.chk结尾，不包含路径或Windows保留设备名，扩展名前不能以点结尾。');
  const needsSource = files.geometry !== 'explicit' || files.guessRead || ['readfc','rcfc'].includes(files.hessian) || files.basisFromCheckpoint;
  if (needsSource && !files.readCheckpoint) errors.push('读取几何、初猜或Hessian前，请启用来源CHK。');
  if (files.readCheckpoint) {
    if (files.oldCheckpoint.trim()&&!safeGaussianCheckpointReference(files.oldCheckpoint.trim())) errors.push('请填写有效的来源CHK文件名或运行环境绝对路径（.chk）；仅支持ASCII安全路径，不含空格、保留设备名或父目录跳转。FCHK或ORCA .hess不能直接替代。');
    if (needsSource && !files.oldCheckpoint.trim() && !files.saveCheckpoint) errors.push('来源CHK留空时读取当前%chk，请启用当前CHK并指定有效名称。');
    if (files.saveCheckpoint && destination.toLowerCase() === files.oldCheckpoint.trim().replaceAll('\\','/').split('/').pop()?.toLowerCase()) errors.push('来源CHK与新CHK不能同名，避免覆盖来源。');
  }
  if (settings.task === 'sp' && files.hessian !== 'none') errors.push('单点能任务不读取Hessian。');
  if (!reuseFrequency && !isEnergyTask(settings.task) && settings.scf === 'conver6'&&!settings.inheritedRoute?.scf) errors.push('本版结构/性质表单保留默认SCF收敛限；Conver=6只用于能量单点。');
  if(!isOptimizationTask(settings.task)&&!['sp','freq','irc'].includes(settings.task)&&files.hessian!=='none')errors.push('当前任务不使用优化Hessian策略，请清除旧设置。');
  if (settings.task === 'freq' && files.hessian !== 'none' && files.hessian !== 'readfc') errors.push('频率重分析使用Freq=ReadFC，不使用Freq=RCFC或优化Hessian策略。');
  if (reuseFrequency && files.guessRead) errors.push('已有力常数重分析不进行SCF，也不读取波函数初猜，请关闭Guess=Read。');
  const semi = !isZindo(settings)&&isSemiempirical(settings.method);
  const external=!isZindo(settings)&&isXtb(settings.method);
  const method = METHODS.find(item => item.id === settings.method)!;
  if (!isZindo(settings)&&!reuseFrequency && method.pending) errors.push(method.label + '：' + method.pending + '。');
  if (semi && files.guessRead) errors.push('本版尚未核实半经验方法的Guess=Read组合，请关闭该选项。');
  if (!isZindo(settings)&&!reuseFrequency && settings.method === 'custom' && !/^[a-z][a-z0-9()+_.-]*$/i.test(settings.customMethod.trim())) errors.push('自定义方法请填写一个Gaussian方法关键词；复杂路由可在生成后编辑。');
  if(!isZindo(settings)&&settings.method==='custom'&&/^(opt|freq|irc|qst2|qst3|counterpoise|td|tda|stable|external)(?:\b|\()/i.test(settings.customMethod.trim()))errors.push('自定义方法框不接受任务/执行关键词；本版不通过该框添加QST或单向IRC。');
  const basis = canonicalBasis(settings.basis);
  const basisEntry = BASES.find(item => item.value === basis);
  if (!isZindo(settings)&&!reuseFrequency && !semi && !external && !files.basisFromCheckpoint && !basisEntry && !(settings.inheritedRoute?.basisKeyword&&settings.inheritedRoute.basisTail)) errors.push('该基组未进入本版已核实目录；Gen/GenECP需完整附加段，不能只填基组名称。');
  if (!isZindo(settings)&&!reuseFrequency && !semi && !external && !files.basisFromCheckpoint && basisEntry?.pending) errors.push(basisEntry.label + '：' + basisEntry.pending + '。');
  if (semi && files.basisFromCheckpoint) errors.push('半经验方法不使用ChkBasis轨道基组。');
  if (!isZindo(settings)&&!reuseFrequency&&!semi&&!external&&!files.basisFromCheckpoint&&!settings.mixedBasis?.enabled&&basis==='ma-def2TZVP'&&!request.structure?.atoms.length&&!(settings.inheritedRoute?.basisKeyword&&settings.inheritedRoute.basisTail)) errors.push('ma-def2TZVP需要当前结构的实际元素或完整来源基组/ECP附加段；不为未知CHK扩写全元素基组。');
  if(!reuseFrequency&&!settings.inheritedRoute?.solvent)errors.push(...buildGaussianSolvation({...settings,requireRefractiveIndex:settings.task==='td'||settings.task==='tdopt'}).issues.map(issue=>issue.message));
  if (!reuseFrequency&&!semi&&!external&&!isZindo(settings)&&settings.integral) {
    if(settings.integral.grid!==undefined&&!['fine','ultrafine','superfinegrid'].includes(settings.integral.grid))errors.push('请选择已支持的Gaussian积分网格。');
    if(settings.integral.acc2e!==undefined&&(!Number.isSafeInteger(settings.integral.acc2e)||settings.integral.acc2e<1))errors.push('Acc2E须为正整数。');
  }
  let elements: string[] = [];
  try { elements = sourceElements(request); } catch (error) { errors.push('来源元素声明无效：' + (error as Error).message); }
  if (!isZindo(settings)&&!reuseFrequency && explicit && !semi && !external && !files.basisFromCheckpoint && basisEntry&&!settings.mixedBasis?.enabled) {
    const unsupported = unsupportedElements(basis, elements);
    if (unsupported.length) errors.push('所选基组缺少已核实的元素覆盖：' + unsupported.join(', ') + '。请选择合适基组或完整外部基组/ECP。');
  }
  const advanced = settings.advanced ?? defaultAdvanced(settings.task);
  for(const [key,label] of [['temperatureK','热化学温度'],['pressureAtm','热化学压力']] as const){const value=settings.taskOptions?.frequency?.[key];if(value!=null&&(!Number.isFinite(value)||value<=0))errors.push(label+'须为正有限数值，留空使用程序默认。');}
  if(settings.taskOptions?.frequency?.raman&&!supportsGaussianRaman(settings,files))errors.push(files.hessian==='readfc'?'本版输入生成尚未核定ReadFC与显式Raman请求的组合；请取消Raman，或调整Hessian读取设置。':'当前方法或目标态尚未接入本版Raman输入；请取消Raman或核对计算设置。');
  if(!reuseFrequency&&!external&&!isZindo(settings)&&settings.parameterDrafts?.scf?.enabled!==false){
    for(const [key,label] of [['vshift','VShift'],['scfMaxCycle','SCF MaxCycle']] as const){
      if(settings.parameterDrafts?.[`${key}Enabled`]&&advanced[key]===null)errors.push('已启用'+label+'，请填写正整数。');
    }
  }
  for (const [key,label] of [['vshift','VShift'],['scfMaxCycle','SCF MaxCycle'],['maxConventional','MaxConventionalCycles'],['maxStep','MaxStep'],['optMaxCycles','Opt MaxCycles']] as const) {
    const value = advanced[key]; if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) errors.push(label + '须为正整数，留空则用程序默认。');
  }
  if (files.hessian === 'recalcfc' && (!Number.isSafeInteger(files.recalcInterval) || !files.recalcInterval || files.recalcInterval < 1)) errors.push('请填写RecalcFC的正整数间隔。');
  if (!isOptimizationTask(settings.task) && (advanced.maxStep !== null || advanced.optMaxCycles !== null)) errors.push('优化步长/步数设置只用于优化任务。');
  if(settings.method==='custom'&&/^rohf$/i.test(settings.customMethod.trim())&&advanced.scfAlgorithm!=='default')errors.push('ROHF不支持本版QC/XQC组合，请使用默认SCF或另行核对。');
  if (semi && !reuseFrequency) {
    const limit = settings.method === 'pm6' ? 56 : 57;
    if (elements.some(element => { const z = atomicNumber(element); return !(z <= limit || (z >= 71 && z <= 83)); })) errors.push('该结构包含超出当前半经验参数覆盖表的元素，请改用已核实的方法。');
  }
  if(external&&!isZindo(settings))errors.push(...xtbInputErrors({...request,files}));
  errors.push(...taskInputErrors(request),...qstInputErrors(request));return [...new Set(errors)];
}
function formatGaussian(request:JobRequest,preview=false):string {
  const files = request.files ?? defaultFiles();
  let plan:{keyword:string;tail:string};
  try{plan=basisPlan(request);}catch(error){if(!preview)throw error;plan={keyword:'[待补全基组]',tail:'[基组/ECP附加段待核对：'+(error as Error).message+']\n\n'};}
  const headers = headerLines(request);
  headers.push(routeLine(request.settings, files, plan.keyword,request.structure?.atoms.length));
  let text = headers.join('\n') + '\n\n';
  if(isQstTask(request.settings.task))return (text+qstGeometrySections(request)+plan.tail+buildGaussianSolvation(request.settings).tail).trimEnd()+'\n\n\n';
  const oniom=request.settings.oniom?.enabled?renderGaussianOniom(request,'',plan.keyword,plan.tail):null;
  if (files.geometry !== 'allcheck') {
    const options=request.settings.taskOptions??defaultTaskOptions();
    text += 'Generated by Ester Studio' + '\n\n' + (oniom?.chargeLine??((Number.isInteger(request.charge)?request.charge:'[待确认电荷]') + ' ' + (Number.isInteger(request.multiplicity)&&request.multiplicity>0?request.multiplicity:'[待确认多重度]')+(request.settings.task==='bsse'?' '+options.fragments.map(fragment=>fragment.charge+' '+fragment.multiplicity).join(' '):''))) + '\n';
    const frozen=activeFrozenAtoms(request);
    if (files.geometry === 'explicit') {
      if(oniom)text+=oniom.coordinateLines.join('\n')+'\n';
      else {
      text += request.structure?.atoms.length?request.structure.atoms.map((atom,i) => {const fragment=options.fragments.findIndex(fragment=>fragment.atoms.includes(i+1))+1;const label=request.settings.task==='bsse'?atom.element+'(Fragment='+(fragment||'[待分片]')+')':atom.element;const freeze=frozen.includes(i+1)?' -1':'';const value=(n:number)=>Number.isFinite(n)?n.toFixed(10).padStart(16):'[待修正坐标]';return label.padEnd(3)+freeze+' '+value(atom.x)+' '+value(atom.y)+' '+value(atom.z);}).join('\n')+'\n':'[待导入完整三维坐标]\n';
      }
    }
    text += '\n';
  }
  const solventTail=request.settings.task==='freq'&&files.hessian==='readfc'||request.settings.inheritedRoute?.solvent?'':buildGaussianSolvation({...request.settings,requireRefractiveIndex:request.settings.task==='td'||request.settings.task==='tdopt'}).tail;
  return (text + coordinateTail(request) + (oniom?.connectivityTail??'') + plan.tail + solventTail).trimEnd()+'\n\n\n';
}
/** Draft preview only. Validation is displayed separately, never embedded in exported code. */
export function previewGaussian(request:JobRequest):{text:string;errors:string[]}{
  const errors=validateJob(request);
  if(isQstTask(request.settings.task)&&errors.length)return {text:'',errors};
  const text=formatGaussian(request,true);
  return {text,errors};
}
export function buildGaussian(request: JobRequest): string {
  const errors=validateJob(request);
  if(errors.length)throw new Error(errors.join('\n'));
  return formatGaussian(request);
}
