import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { validateJob } from '../core/gaussian';
import type { JobRequest } from '../core/types';
export function orcaIssueSelector(field:string):string {
  const rules:[RegExp,string][]=[
    [/^name$/,'[aria-label="ORCA输出任务名"]'],[/^cores$/,'[aria-label="ORCA核数"]'],[/^memoryGB$/,'[aria-label="ORCA总内存"]'],
    [/^resourcesConfirmed$/,'[data-input-section="naming-resources"] [aria-label="确认计算资源"]'],
    [/electronicStateConfirmed/,'[aria-label="确认ORCA基础电子态"]'],[/multiplicity|charge/,'[aria-label="ORCA多重度"]'],
    [/^structure$/,'[data-input-section="electronic-state"]'],[/^method$|^version$/,'[data-input-section="level"]'],[/^basis$/,'[data-input-section="level"]'],
    [/^scf\.maxIterations$/,'[aria-label="ORCA SCF MaxIter"]'],[/^scf\.convergence$/,'[aria-label="ORCA SCF收敛标准"]'],[/^scf\.strategy$/,'[aria-label="ORCA SCF收敛策略"]'],[/^scf\.algorithm$/,'[aria-label="ORCA SCF算法"]'],[/^scf(?:\.|$)/,'[data-input-section="scf"]'],
    [/^optimization\.hessian$/,'[aria-label="ORCA Hessian策略"]'],[/^optimization\.recalcInterval$/,'[aria-label="ORCA Hessian重算间隔"]'],[/^optimization\.maxIterations$/,'[aria-label="优化步数"]'],[/^optimization\.maxStep$/,'[aria-label="优化步长 / au"]'],
    [/^frequency\.raman$/,'[aria-label="Raman"]'],[/^frequency\.temperatureK$/,'[aria-label="温度 / K"]'],[/^frequency\.pressureAtm$/,'[aria-label="压力 / atm"]'],
    [/initialOrbitals|assets/,'[data-input-section="source"]'],[/solvent|solvation/,'[data-input-section="solvent"]'],
    [/frozen|constraints|atomIds/,'[data-input-section="freeze"], .input-freeze-card'],
  ];
  return rules.find(([pattern])=>pattern.test(field))?.[1]??'[data-input-section="task-parameters"]';
}
export function revealInputValidationTarget(root:ParentNode,selector:string):HTMLElement|null {
  const element=root.querySelector<HTMLElement>(selector)??root.querySelector<HTMLElement>('[data-input-section="level"], .settings-step');if(!element)return null;
  let parent:Element|null=element;while(parent){if(parent.tagName==='DETAILS')(parent as HTMLDetailsElement).open=true;parent=parent.parentElement;}
  if(!element.matches('input,select,textarea,button,[tabindex]'))element.tabIndex=-1;
  element.scrollIntoView({behavior:'smooth',block:'center'});element.focus({preventScroll:true});return element;
}
export function issueLocation(message:string):{step:number;selector:string}{
  const draft=message.match(/内坐标草稿\s+([A-Za-z0-9_-]+)/);if(draft)return {step:2,selector:'[data-coordinate-id="'+draft[1]+'"]'};
  const rules:[RegExp,number,string][]=[
    [/QST/,2,'[data-field="qst"]'],
    [/Raman/,2,'[aria-label="Raman"]'],
    [/核对运行环境的xTB脚本/,2,'[data-field="xtb-confirmation"]'],[/xTB挂接必须/,2,'.geometry-choices'],[/xTB挂接不使用|xTB挂接支持/,2,'[aria-label="计算方法"]'],[/xTB计算级别|GFN\/溶剂|xTB溶剂/,2,'[aria-label="xTB计算级别"]'],[/xTB可执行路径/,2,'[aria-label="xTB可执行路径"]'],[/xTB挂接脚本路径/,2,'[aria-label="External脚本路径"]'],
[/Counterpoise不支持SCRF|NMR实验溶剂/,2,'[aria-label="gaussian启用溶剂模型"]'],[/本版BSSE不复用/,2,'[data-field="guess-read"]'],[/本版该性质/,2,'[aria-label="计算方法"]'],
    [/扫描\/冻结\/片段任务需要显式/,2,'.geometry-choices'],[/扫描|冻结|内坐标|二面角/,2,'[data-field="coordinates"]'],
    [/T1优化不能从未知AllCheck/,2,'.geometry-choices'],
    [/确认IRC/,2,'[data-field="irc-confirmation"]'],[/IRC每方向/,2,'[aria-label="IRC每方向点数"]'],[/IRC StepSize/,2,'[aria-label="IRC StepSize"]'],[/IRC请选择/,2,'[aria-label="IRC Hessian"]'],
    [/任务参考态|UKS.*多重度|TD\/TDA激发态优化需要|闭壳层单重态参考/,2,'[aria-label="自旋多重度"]'],[/UKS只适用于|S态不能/,2,'[aria-label="使用UKS优化"]'],[/目标Root|求解态数/,2,'[aria-label="TD求解态数"]'],[/Singlets\/Triplets/,2,'[aria-label="TD自旋选项"]'],[/T1 UDFT/,2,'[aria-label="自旋多重度"]'],
    [/确认Stable/,2,'[data-field="stable-confirmation"]'],[/BSSE/,2,'[data-field="fragments"]'],
    [/导入.*结构|二维结构|非有限坐标/,2,'[aria-label="导入结构或来源文件"]'],
    [/奇偶|电子数|总电荷/,2,'[aria-label="总电荷"]'],[/多重度必须|多重度超出/,2,'[aria-label="自旋多重度"]'],[/确认电荷/,2,'[aria-label="总电荷"]'],
    [/启用来源CHK/,2,'[data-field="read-checkpoint"]'],[/来源CHK文件名/,2,'[aria-label="来源CHK文件名"]'],[/来源CHK与新CHK|新CHK文件名/,2,'[aria-label="新CHK文件名"]'],[/核对来源CHK存在/,2,'[data-field="checkpoint-confirmation"]'],
    [/请确认本次输入的核数与内存/,2,'[data-input-section="naming-resources"] [aria-label="确认计算资源"]'],[/核数/,2,'[aria-label="CPU核数"]'],[/内存/,2,'[aria-label="总内存GB"]'],[/任务名/,2,'[aria-label="任务名"]'],[/标题/,2,'[aria-label="输入标题"]'],
    [/几何已经优化/,2,'[data-field="frequency-confirmation"]'],[/基组|元素覆盖|参数覆盖/,2,'[aria-label="基组"]'],[/方法|半经验/,2,'[aria-label="计算方法"]'],[/溶剂/,2,'[aria-label="gaussian启用溶剂模型"]'],
    [/RecalcFC/,2,'[aria-label="RecalcFC间隔"]'],[/MaxStep/,2,'[aria-label="优化步长 / 0.01 Bohr"]'],[/Opt MaxCycles/,2,'[aria-label="优化步数"]'],[/VShift/,2,'[aria-label="VShift"]'],[/SCF MaxCycle/,2,'[aria-label="MaxCycle"]'],[/MaxConventional/,2,'[aria-label="MaxConventionalCycles"]'],[/SCF/,2,'[aria-label="SCF收敛设置"]'],[/Hessian|ReadFC|RCFC/,2,'[aria-label="Hessian读取"]'],
  ];const match=rules.find(([pattern])=>pattern.test(message));return match?{step:match[1],selector:match[2]}:{step:2,selector:'.settings-step'};
}
export function isBaseInputIssue(message:string):boolean {
  return ['.geometry-choices','[aria-label="导入结构或来源文件"]','[aria-label="总电荷"]','[aria-label="自旋多重度"]'].includes(issueLocation(message).selector);
}
export function humanizeValidation(text:string,request:JobRequest):string {
  const drafts=request.settings.taskOptions?.coordinateDrafts??[];const counts={scan:0,freeze:0};
  for(const draft of drafts){const number=++counts[draft.action];text=text.replaceAll('内坐标草稿 '+draft.id,(draft.action==='scan'?'扫描':'冻结')+'坐标 '+number);}
  return text;
}
export function useValidationNavigation(request:JobRequest,step:number,setStep:(step:number)=>void,notify:(message:string,kind:'error')=>void,root?:()=>HTMLElement|null,active=true){
  const rootLive=useRef(root);rootLive.current=root;
  const [scope,setScope]=useState<'start'|'full'|null>(null);const [focus,setFocus]=useState<{message:string;step:number;selector:string;id:number}|null>(null);const [host,setHost]=useState<Element|null>(null);
  const sequence=useRef(0),handled=useRef(0);
  const messages=useMemo(()=>scope?validateJob(request).filter(message=>scope==='full'||isBaseInputIssue(message)):[],[request,scope]);
  function report(mode:'start'|'full',explicit?:string[]){const errors=explicit??validateJob(request).filter(message=>mode==='full'||isBaseInputIssue(message));setScope(mode);if(!errors.length)return false;const location=issueLocation(errors[0]);setFocus({message:errors[0],...location,id:++sequence.current});notify(humanizeValidation(errors[0],request),'error');return true;}
  useEffect(()=>{if(!active||!focus||handled.current===focus.id||sequence.current!==focus.id)return;if(step!==focus.step){setStep(focus.step);return;}let alive=true,second=0;const current=()=>alive&&active&&handled.current!==focus.id&&sequence.current===focus.id;const frame=requestAnimationFrame(()=>{if(!current())return;const parentRoot=rootLive.current?.()??document;const element=parentRoot.querySelector<HTMLElement>(focus.selector)??parentRoot.querySelector<HTMLElement>('.settings-step');if(!element){handled.current=focus.id;return;}if(!element.matches('input,select,textarea,button,[tabindex]'))element.tabIndex=-1;let parent:Element|null=element;while(parent){if(parent.tagName==='DETAILS')(parent as HTMLDetailsElement).open=true;parent=parent.parentElement;}second=requestAnimationFrame(()=>{if(!current())return;element.scrollIntoView({behavior:'smooth',block:'center'});element.focus({preventScroll:true});handled.current=focus.id;setHost(element.closest('.field,.check-line,.card-dropdown,.dropzone')??element.parentElement);});});return()=>{alive=false;cancelAnimationFrame(frame);if(second)cancelAnimationFrame(second);};},[focus,step,active]);
  const message=focus?messages.find(message=>issueLocation(message).selector===focus.selector):undefined;
  useEffect(()=>{if(!host||!message)return;host.classList.add('input-validation-host');return()=>host.classList.remove('input-validation-host');},[host,message]);
  useEffect(()=>{if(!active||!focus)return;const element=(rootLive.current?.()??document).querySelector(focus.selector);element?.classList.toggle('validation-target',!!message);return()=>element?.classList.remove('validation-target');},[focus,message,step,active]);
  return {report,reset:()=>{handled.current=sequence.current;setScope(null);setFocus(null);setHost(null);},hint:host&&message?createPortal(<span className="field-validation-message">{humanizeValidation(message,request)}</span>,host):null};
}
