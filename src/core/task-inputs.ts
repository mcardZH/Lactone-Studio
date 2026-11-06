import type { JobRequest } from './types';
import { gaussianRealToken } from './gaussian-real-token';
import { electronicStateError } from './elements';
import { defaultTaskOptions,coordinateValue,spectrumStates,activeCoordinates,activeFrozenAtoms,coordinateAction,constraintsEnabled,isZindo } from './tasks';
import { resolveCoordinateDrafts } from './coordinate-drafts';
import { isUksOptimization } from './excited-state';
import { hasSolvation } from './solvents';
import { recommendedExcitedStates } from './input-recommendations';
export function taskInputErrors(request:JobRequest):string[]{
  const errors:string[]=[];const task=request.settings.task,options=request.settings.taskOptions??defaultTaskOptions();const atoms=request.structure?.atoms??[];const geometry=request.files?.geometry??'explicit';
  const coordinates=activeCoordinates(request),frozenAtoms=activeFrozenAtoms(request);
  errors.push(...resolveCoordinateDrafts(request.settings).errors);
  if((task==='scan'||task==='bsse'||constraintsEnabled(request.settings))&&geometry!=='explicit')errors.push('本版扫描/冻结/片段任务需要显式结构与可核对的原子编号。');
  if(task==='scan'||constraintsEnabled(request.settings)){
    if(options.coordinateDrafts===undefined&&task!=='scan'&&options.coordinates.some(c=>coordinateAction(c,task)==='scan'))errors.push('S扫描行只用于势能面扫描；当前任务请将内坐标设为冻结。');
    if(task==='scan'&&!coordinates.some(c=>coordinateAction(c,task)==='scan'))errors.push('请添加至少一个扫描内坐标。');
    if(task==='constrained'&&!coordinates.length&&!frozenAtoms.length)errors.push('请选择要冻结的原子或内坐标。');
    if(frozenAtoms.some(index=>!Number.isInteger(index)||index<1||index>atoms.length)||new Set(frozenAtoms).size!==frozenAtoms.length)errors.push('冻结原子编号越界或重复。');
    if(frozenAtoms.length&&frozenAtoms.length===atoms.length)errors.push('不能冻结全部原子；请选择需要分析或松弛的部分。');
    const seen=new Set<string>();for(const [i,coordinate] of coordinates.entries()){
      const scanning=coordinateAction(coordinate,task)==='scan';
      const n={B:2,A:3,D:4}[coordinate.type];if(!n||coordinate.atoms.length!==n||new Set(coordinate.atoms).size!==n||coordinate.atoms.some(index=>!Number.isInteger(index)||index<1||index>atoms.length)){errors.push('内坐标'+(i+1)+'的原子数量、顺序或编号无效。');continue;}
      const forward=coordinate.atoms.join(','),reverse=[...coordinate.atoms].reverse().join(',');const key=coordinate.type+':'+[forward,reverse].sort()[0];if(seen.has(key))errors.push('内坐标重复或反向重复，不能叠加冲突扫描/冻结定义。');seen.add(key);
      if(scanning&&(!Number.isSafeInteger(coordinate.steps)||coordinate.steps<1||coordinate.increment===null||!Number.isFinite(coordinate.increment)||coordinate.increment===0))errors.push('扫描增量次数须为可精确表示的正整数，增量须为非零有限数字。');
      try{const initial=coordinateValue(coordinate,atoms);if(scanning&&coordinate.increment!==null&&Number.isFinite(coordinate.increment)){const end=initial+coordinate.steps*coordinate.increment;if(!Number.isFinite(end))errors.push('扫描终点计算为非有限值，请修改增量/次数。');if(coordinate.type==='B'&&(initial<=0||end<=0))errors.push('键长扫描会达到非正键长，请修改增量/次数。');if(coordinate.type==='A'&&(end<0||end>180))errors.push('键角扫描目标超出0–180°，请修改增量/次数。');}}catch(error){errors.push('内坐标'+(i+1)+'：'+(error as Error).message);}
      if(scanning&&coordinate.atoms.every(index=>frozenAtoms.includes(index)))errors.push('扫描坐标涉及的全部原子都被冻结，不能同时改变该坐标。');
    }
  }
  if(task==='irc'){
    if(options.irc.maxPoints!==null&&(!Number.isSafeInteger(options.irc.maxPoints)||options.irc.maxPoints<1))errors.push('IRC每方向点数须为可精确表示的正整数。');
    if(options.irc.stepSize!==null&&(!Number.isSafeInteger(options.irc.stepSize)||options.irc.stepSize<1))errors.push('本版IRC StepSize须为正整数，单位0.01 Bohr，留空用程序默认。');
    if(!['none','calcfc','rcfc'].includes(request.files?.hessian??'none'))errors.push('IRC请选择CalcFC或兼容频率Hessian的RCFC，不使用优化器ReadFC/RecalcFC策略。');
  }
  if(task==='td'||task==='tdopt'){
    const excited=options.excited;
    if(task==='tdopt'&&excited.frequencyOnly&&!excited.frequency)errors.push('独立激发态频率须同时启用频率计算，请重新选择计算内容。');
    if(task==='tdopt'&&excited.frequencyOnly&&request.files?.hessian&&request.files.hessian!=='none')errors.push('独立激发态频率重新计算当前目标态Hessian；请关闭优化器Hessian/ReadFC设置。');
    const uks=isUksOptimization(request.settings);
    const nstates=excited.nstatesMode==='auto'||excited.nstates===null?recommendedExcitedStates(atoms.length,task,excited.root):excited.nstates;
    if(!uks&&(!Number.isSafeInteger(nstates)||nstates<1))errors.push('TD/TDA求解态数须为可精确表示的正整数；默认推荐最多100，明确自填值优先。');
    if(!uks&&(!Number.isSafeInteger(excited.root)||excited.root<1||excited.root>nstates))errors.push('目标Root必须在求解态数范围内。');
    if(task==='tdopt'&&excited.useUks&&(excited.targetSpin!=='triplets'||excited.root!==1))errors.push('UKS优化仅用于T1；S态或更高Tn请关闭使用UKS优化，选择对应TD/TDA目标根。');
    if(!request.settings.oniom?.enabled&&!uks&&(task==='tdopt'||excited.spin!=='default')&&(request.multiplicity!==1||geometry==='allcheck'||request.settings.unrestricted))errors.push('Singlets/Triplets选项仅用于已核对的闭壳层单重态参考；参考多重度须为1，并关闭UDFT。');
    if(excited.approximation==='zindo'&&task!=='td')errors.push('ZINDO/S只用于垂直激发能量，不支持本页激发态优化/频率。');
    if(isZindo(request.settings)&&hasSolvation(request.settings)&&request.settings.solventModel!=='iefpcm')errors.push('ZINDO/S当前仅核实PCM能量支持；请主动选择IEFPCM或气相，SMD组合尚未核实。');
    if(isZindo(request.settings)&&(request.files?.basisFromCheckpoint||request.files?.hessian!=='none'&&request.files?.hessian!==undefined))errors.push('ZINDO/S不使用轨道基组或优化/频率Hessian。');
  }
  if(isUksOptimization(request.settings)&&geometry==='allcheck')errors.push('T1优化不能从未知AllCheck推断电子态，请选择显式坐标或Geom=Check。');
  if(!request.settings.oniom?.enabled&&isUksOptimization(request.settings)&&geometry!=='allcheck'&&request.multiplicity!==3)errors.push('T1 UKS/UDFT优化需要明确核对三重态多重度3。');
  if(task==='nmr'&&!hasSolvation(request.settings))errors.push('请填写NMR实验溶剂，如chloroform或dmso，不自行猜测。');
  if(task==='bsse'){
    if(hasSolvation(request.settings))errors.push('Gaussian官方Counterpoise不支持SCRF组合；本版BSSE请使用气相或另行设计方案。');
    if(request.files?.guessRead)errors.push('本版BSSE不复用一份统一MO初猜；请关闭Guess=Read并核对片段设置。');
    if(options.fragments.length<2)errors.push('BSSE需要至少2个非空片段。');
    const assigned=new Set<number>();for(const [i,fragment] of options.fragments.entries()){
      if(!fragment.atoms.length)errors.push('BSSE片段'+(i+1)+'尚未分配原子。');
      const valid=fragment.atoms.every(index=>Number.isInteger(index)&&index>=1&&index<=atoms.length);if(!valid){errors.push('BSSE片段'+(i+1)+'的原子编号越界。');continue;}
      for(const index of fragment.atoms){if(assigned.has(index))errors.push('BSSE片段重叠：原子'+index+'被重复分配。');assigned.add(index);}
      if(fragment.atoms.length){const state=electronicStateError(fragment.atoms.map(index=>atoms[index-1]),fragment.charge,fragment.multiplicity);if(state)errors.push('BSSE片段'+(i+1)+'：'+state);}
    }
    if(assigned.size!==atoms.length)errors.push('BSSE片段必须完整覆盖全部原子，不遗漏或提取删除原子。');
    if(options.fragments.reduce((sum,f)=>sum+f.charge,0)!==request.charge)errors.push('BSSE片段电荷之和不等于总电荷。');
    const spins=options.fragments.map(f=>f.multiplicity-1),maximum=spins.reduce((s,n)=>s+n,0),minimum=Math.max(0,spins.reduce((largest,spin)=>Math.max(largest,spin),0)*2-maximum),total=request.multiplicity-1;
    if(total<minimum||total>maximum||(maximum-total)%2!==0)errors.push('BSSE总多重度与所选片段自旋耦合不相容。');
    if(!options.fragmentStatesConfirmed)errors.push('请确认全部BSSE片段的原子、电荷和多重度。');
  }
  if(!isZindo(request.settings)&&['td','tdopt','t1opt','nmr','stable','bsse'].includes(task)&&['pm6','pm7','gfn2-xtb','custom'].includes(request.settings.method))errors.push('本版该性质/电子态任务仅核实预设DFT模板，不直接导出半经验/External/自定义方法组合。');
  return [...new Set(errors)];
}
export function coordinateTail(request:JobRequest):string{const coordinates=activeCoordinates(request);return coordinates.length?coordinates.map(coordinate=>coordinate.type+' '+coordinate.atoms.join(' ')+(coordinateAction(coordinate,request.settings.task)==='scan'?' S '+coordinate.steps+' '+gaussianRealToken(coordinate.increment ?? ''):' F')).join('\n')+'\n\n':'';}
