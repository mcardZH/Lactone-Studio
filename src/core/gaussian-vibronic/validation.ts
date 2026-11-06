import { gaussianRouteTokens } from '../gaussian-source';
import { pairBinding, stateBinding } from './source';
import { vibronicGaussianMemory } from './resources';
import type { VibronicEvidence, VibronicRequest, VibronicValidation } from './types';

const key=(token:string)=>token.match(/^[a-z][\w-]*/i)?.[0].toLowerCase()??'';
const reservedName=(name:string)=>/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
export function retainedVibronicRoute(route:string):string[] {
  return gaussianRouteTokens(route).filter(token=>!['opt','freq','geom','guess'].includes(key(token)));
}
function sameGeometry(a:VibronicEvidence,b:VibronicEvidence):boolean {
  return a.atoms.length===b.atoms.length && a.atoms.every((atom,i)=>{
    const other=b.atoms[i];return atom.element===other.element&&Math.hypot(atom.x-other.x,atom.y-other.y,atom.z-other.z)<2e-4;
  });
}
export function validateVibronicRequest(request:VibronicRequest):VibronicValidation {
  const errors:VibronicValidation['errors']=[],warnings:string[]=[];
  const add=(code:string,message:string,state?:'initial'|'final')=>errors.push({code,message,state});
  if(!['spectrum','huang-rhys'].includes(request.mode))add('mode','任务入口无效。');
  if(!['FC','HT','FCHT'].includes(request.theory))add('theory','近似类型无效。');
  if(!['absorption','emission'].includes(request.direction))add('direction','跃迁方向无效。');
  if(request.calculation!==undefined&&!['reuse-frequencies','recompute-ground'].includes(request.calculation))add('calculation','频率复用方式无效。');
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(request.name)||request.name.includes('..')||reservedName(request.name))add('name','作业名须为1–80个ASCII字母、数字、点、短横或下划线，不含路径或Windows设备保留名。');
  if(!Number.isSafeInteger(request.cores)||request.cores<1)add('resources','CPU核数须为可精确表示的正整数。');
  if(vibronicGaussianMemory(request.memoryGB)===null)add('resources','内存须为有限正数，且能精确换算为Gaussian整数GB/MB/KB或8字节字；不会自动舍入。');
  if(request.temperatureK!==undefined&&(!Number.isFinite(request.temperatureK)||request.temperatureK<=0))add('temperature','本入口目前支持有限正温度（K）；0 K关键字边界尚未核定，留空使用Gaussian默认。');
  const spectrum=request.spectrum;
  if(spectrum){
    for(const field of ['lower','upper','grain','hwhm'] as const)if(spectrum[field]!==undefined&&!Number.isFinite(spectrum[field]))add('spectrum-number',`Spectrum ${field}须为有限数值，单位cm⁻¹。`);
    if((spectrum.lower===undefined)!==(spectrum.upper===undefined))add('spectrum-range','自定义范围须同时填写下限和上限；两项留空使用Gaussian默认。');
    if(spectrum.lower!==undefined&&spectrum.upper!==undefined&&(spectrum.lower>=spectrum.upper||!Number.isFinite(spectrum.upper-spectrum.lower)))add('spectrum-range','谱范围下限必须小于上限且区间宽度有限，均相对0–0跃迁。');
    if(spectrum.grain!==undefined&&spectrum.grain<=0)add('spectrum-grain','采样间隔Grain须大于0 cm⁻¹。');
    if(spectrum.grain!==undefined&&spectrum.lower!==undefined&&spectrum.upper!==undefined&&spectrum.grain>spectrum.upper-spectrum.lower)add('spectrum-grain','采样间隔不能大于所选谱范围。');
    if(spectrum.broadening!==undefined&&!['Gaussian','Lorentzian','Stick'].includes(spectrum.broadening))add('spectrum-broadening','展宽形状须为Gaussian、Lorentzian或Stick。');
    if(spectrum.hwhm!==undefined&&spectrum.hwhm<=0)add('spectrum-width','半高半宽HWHM须大于0 cm⁻¹；Stick不使用展宽。');
    if(spectrum.broadening==='Stick'&&spectrum.hwhm!==undefined)add('spectrum-stick','Stick离散谱不使用HWHM，请清空半高半宽。');
  }
  for(const side of ['initial','final'] as const) {
    const state=request[side],label=side==='initial'?'初态':'末态';
    if(!state.log)add('missing-log',`${label}尚未选定Gaussian频率LOG/OUT及其频率作业。`,side);
    if(!state.fchk)add('missing-fchk',`${label}缺少由对应CHK转换的完整FCHK。`,side);
    if(!state.checkpoint)add('missing-chk',`${label}尚未显式选择实际二进制CHK。`,side);
    for(const file of [state.log?.identity,state.fchk?.identity,state.checkpoint].filter(Boolean)) {
      if(!/^[a-f0-9]{64}$/i.test(file!.sha256)||!Number.isSafeInteger(file!.size)||file!.size<1)add('file-identity',`${label}来源身份缺失或无效。`,side);
    }
    if(state.checkpoint && (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.chk$/i.test(state.checkpoint.name)||state.checkpoint.name.includes('..')||reservedName(state.checkpoint.name)))add('chk-name',`${label}CHK需使用ASCII安全文件名（可另存命名副本后重新选择）；不把FCHK直接当CHK。`,side);
    if(state.confirmedBinding!==stateBinding(state))add('state-confirmation',`${label}需确认LOG/FCHK/CHK来自同一目标态、同一频率计算；更换来源后须重新确认。`,side);
    const {log,fchk}=state;
    for(const evidence of [log,fchk].filter(Boolean)){for(const message of evidence!.errors)add('evidence',`${label}：${message}`,side);warnings.push(...evidence!.warnings.map(message=>`${label}：${message}`));}
    if(log) {
      if(log.format!=='log'||!log.normalTermination)add('termination',`${label}没有可核正常终止的Gaussian LOG。`,side);
      const tokens=gaussianRouteTokens(log.route);
      const allowed=new Set(['opt','freq','td','cis','em','empiricaldispersion','int','integral','scf','scrf','nosymm','symmetry','geom','guess']);
      const unknown=tokens.filter(t=>!allowed.has(key(t))&&!/^(?:5d|6d|7f|10f)$/i.test(t)&&!(/^[A-Za-z][A-Za-z0-9-]*\/[^\s]+$/.test(t)&&!/^iop\b/i.test(t)));
      if(unknown.length)add('unmapped-route',`${label}有本入口未完整处理的Route设置：${unknown.join(' ')}；未静默丢弃。`,side);
      if(!tokens.some(t=>key(t)==='freq'))add('frequency-route',`${label}Route未请求频率，不能只凭数表认证。`,side);
      const unsafe=tokens.filter(t=>['oniom','external','counterpoise','irc','scan','stable','nmr','force','iop','scrf'].includes(key(t))&&!(key(t)==='scrf'&&!/read|generic|external|non.?equilibrium/i.test(t)));
      if(unsafe.length)add('unsupported-route',`${label}包含首批两态完整分子路线未覆盖的设置：${unsafe.join(' ')}。`,side);
      if(tokens.some(t=>/(?:\/gen(?:ecp)?\b|\bchkbasis\b|\bpseudo\s*=|\bmodredundant\b|\breadopt\b|\bselectnormalmodes\b|\breadisotopes\b|\breadiso\b|\bno.?savenm\b|\banharm|\bfragment|\bfreeze)/i.test(t)))add('additional-data',`${label}含外部基组、冻结、模式筛选或额外输入；本入口不能完整复用这些附加段。`,side);
      if(tokens.some(t=>/^(?:td|cis).*\b(?:read|add|restart)\b/i.test(t)))add('td-read','TD/CIS依赖另一个激发态检查点的Read/Add/Restart尚不能完整继承。',side);
      if(!tokens.some(t=>/^[A-Za-z][A-Za-z0-9-]*\/[^\s]+$/.test(t)))add('method',`${label}未读取到明确方法/基组。`,side);
    }
    if(log&&fchk) {
      if(fchk.format!=='fchk'||!fchk.completeHessian)add('hessian',`${label}缺少完整FCHK Hessian。`,side);
      if(!sameGeometry(log,fchk))add('geometry-evidence',`${label}LOG/FCHK的原子序列或频率几何不匹配；请核对文件对应和坐标框架。`,side);
      if(log.charge!==fchk.charge||log.multiplicity!==fchk.multiplicity)add('electronic-evidence',`${label}LOG/FCHK的电荷或多重度冲突。`,side);
      if(log.frequencies.length!==fchk.frequencies.length||log.frequencies.some((v,i)=>Math.abs(v-fchk.frequencies[i])>0.2))add('frequency-evidence',`${label}LOG/FCHK频率不一致。`,side);
      if(log.masses.length!==fchk.masses.length||log.masses.some((v,i)=>Math.abs(v-fchk.masses[i])>1e-4))add('mass-evidence',`${label}LOG/FCHK原子质量不一致。`,side);
      const level=(s:string)=>gaussianRouteTokens(s).find(t=>t.includes('/')&&!/^iop/i.test(t))?.toLowerCase().replace(/^r(?=[a-z])/,'');
      if(level(log.route)!==level(fchk.route))add('level-evidence',`${label}LOG/FCHK方法或基组冲突。`,side);
      if(fchk.routeComplete){
        const canonical=(route:string)=>gaussianRouteTokens(route).map(t=>t.toLowerCase().replace(/\s/g,'').replace(/^([a-z]+)\(/,'$1=(')).sort().join(' ');
        const inherited=log.selectedJob?.inheritedFrom;
        const knownRaw=Boolean(inherited&&[log.selectedJob!.route,inherited.route].some(route=>canonical(route)===canonical(fchk.route)));
        const physical=(route:string)=>gaussianRouteTokens(route).filter(t=>!['opt','freq','pop','geom','guess','genchk'].includes(key(t))).map(t=>{
          const normalized=t.toLowerCase().replace(/\s/g,'').replace(/^([a-z]+)\(/,'$1=(');return normalized.includes('/')?normalized.replace(/^r(?=[a-z])/,''):normalized;
        }).sort().join(' ');
        if(!knownRaw&&physical(log.route)!==physical(fchk.route))add('full-route-evidence',`${label}完整FCHK Route与已选频率作业的目标根、环境或数值设置冲突，不能仅凭方法/基组配对。`,side);
      }
    }
  }
  const a=request.initial.log,b=request.final.log;
  if(a&&b) {
    if(a.atoms.length!==b.atoms.length||a.atoms.some((atom,i)=>atom.element!==b.atoms[i]?.element))add('atom-order','初末态必须具有相同原子数、元素序列与逐原子对应；不自动重新排序。');
    if(a.masses.length!==b.masses.length||a.masses.some((v,i)=>Math.abs(v-b.masses[i])>1e-4))add('isotopes','两态同位素质量不一致。');
    if(a.charge!==b.charge||a.multiplicity!==b.multiplicity)add('state-pair','首批只支持相同电荷和参考态多重度的单重态基态↔TD/CIS激发态，不支持电离、SOC或磷光。');
    if(a.multiplicity!==1||b.multiplicity!==1)add('spin','首批限闭壳层单重态参考态。');
    const excited=request.direction==='absorption'?b:a,ground=request.direction==='absorption'?a:b;
    if(ground.root!==null||excited.root===null)add('direction-state','吸收需基态→明确TD/CIS根；发射需明确TD/CIS根→基态，请核对初末态顺序。');
    if(/\b(?:triplets|50-50|tda)\b/i.test(excited.route))add('excited-scope','本入口尚未核定TD三重态、混合自旋或TDA的振电适用性。');
    if(!excited.transitionDipole)add('transition-dipole','缺少目标根的跃迁电偶极矩数值；普通永久偶极矩或振动IR强度不能代替。');
    const environment=(e:VibronicEvidence)=>retainedVibronicRoute(e.route).filter(t=>!['td','cis'].includes(key(t))).map(t=>t.toLowerCase()).sort().join(' ');
    if(environment(a)!==environment(b))add('level-pair','两态方法、基组或环境/数值设置不一致；请提供同一已确认计算方案的来源。');
    if(request.theory!=='FC') {
      // Gaussian Freq documentation requires a completed TD/CIS frequency calculation with saved normal modes.
      const tokens=gaussianRouteTokens(excited.route),freq=tokens.find(t=>key(t)==='freq')??'';
      const options=freq.replace(/^freq\s*=?\s*/i,'').replace(/^\((.*)\)$/,'$1').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
      const fullFrequency=Boolean(freq)&&options.every(option=>['analytic','numer','savenm','savenormalmodes'].includes(option));
      if(!fullFrequency||!excited.normalTermination||!excited.completeModes)add('ht-prerequisite','HT/FCHT需正常完成的TD/CIS完整频率与保存的模式；不接受ReadFC、筛选模式或近似Hessian作为跃迁导数计算前提。');
      warnings.push('HT/FCHT按已完成的TD/CIS完整频率计算前提开放；未声称从二进制CHK独立解析或数值验收跃迁导数。');
    }
    if(request.correspondenceBinding!==pairBinding(request.initial,request.final))add('correspondence','请确认两态每一个原子的物理对应及目标电子态；元素序列相同不能证明同元素原子未交换。');
  }
  if(request.initial.checkpoint&&request.final.checkpoint) {
    if(request.initial.checkpoint.sha256===request.final.checkpoint.sha256)add('same-chk','初末态不能使用同一份CHK。');
    if(request.initial.checkpoint.name.toLowerCase()===request.final.checkpoint.name.toLowerCase())add('duplicate-name','初末态CHK同名会在运行目录冲突，请另存安全命名副本后重新选择。');
    if([request.initial.checkpoint.name,request.final.checkpoint.name].some(n=>n.toLowerCase()===`${request.name}.chk`.toLowerCase()))add('overwrite','新作业CHK名称与来源冲突。');
  }
  warnings.push('本入口仅准备输入。CHK内容仍由Gaussian读取；显式文件绑定确认不能替代Gaussian原生执行验收。');
  warnings.push(request.calculation==='recompute-ground'?'已选择重新计算基态频率：继承基态方法与显式坐标，会产生新的频率计算费用。':'默认复用已有频率：ReadFC与Geom=Check从基态CHK继承几何、质量与力常数，独立新CHK避免覆盖来源。');
  if(request.mode==='huang-rhys')warnings.push('Huang–Rhys使用Gaussian振电框架并打印因子及J/K；不承诺跳过内部光谱计算。');
  if(request.mode==='huang-rhys'&&request.spectrum)warnings.push('谱范围和展宽只控制伴随光谱，不改变本Adiabatic Hessian模型的Huang–Rhys因子定义。');
  return {valid:errors.length===0,errors,warnings};
}
