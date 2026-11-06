import type { ReactNode } from 'react';
import { BASES, canonicalBasis, METHODS } from '../core/catalog';
import { authorBasisEvaluation, authorMethodEvaluation } from '../core/author-evaluations';
import { angularBasisPlan, basisComparison, BASIS_DATA_SOURCES } from '../core/basis';
import type { FileSettings, GaussianSettings, MethodId, Structure } from '../core/types';
import { isSemiempirical,defaultSettings } from '../core/gaussian';
import CardDropdown from './CardDropdown';
import { isXtb } from '../core/xtb';
import { isZindo } from '../core/tasks';
import { mixedBasisSize } from '../core/mixed-basis';
import { InputSettingsCard } from './InputSettingsFields';
import { InputSettingsAction } from './InputSettingsLayout';

/** Each alternative has its own ordinary basis defaults; only the selected basis uses source/mixed shells. */
export function methodBasisComparison(structure:Structure|null,settings:GaussianSettings,basis:string,reference:string){
  const current=canonicalBasis(basis)===canonicalBasis(settings.basis);
  const candidate=current?settings:{...settings,basis,mixedBasis:undefined,inheritedRoute:undefined};
  const angular=angularBasisPlan(candidate);
  const comparison=basisComparison(structure,basis,reference,angular.dForm,angular.fForm,settings.use5D?'5D':undefined);
  if(current&&settings.mixedBasis?.enabled){const size=mixedBasisSize(structure,basis,settings.mixedBasis,angular.dForm,angular.fForm),ratio=size.count&&comparison.reference?size.count/comparison.reference:null;return {...comparison,...size,ratio,costIndex:ratio===null?null:ratio**4};}
  return comparison;
}
export default function MethodChooser({settings,files,structure,onRecommend,onMethod,onBasis,onMixedBasis,onInherit,inheritDisabled=false,children}:{settings:GaussianSettings;files:FileSettings;structure:Structure|null;onRecommend:()=>void;onMethod:(id:MethodId)=>void;onBasis:(basis:string)=>void;onMixedBasis?:(enabled:boolean)=>void;onInherit?:()=>void;inheritDisabled?:boolean;children?:ReactNode}){
  const external=isXtb(settings.method);
  const zindo=isZindo(settings);
  const defaults=external?{...defaultSettings(settings.task),method:'gfn2-xtb' as const,dispersion:'none' as const,basis:''}:defaultSettings(settings.task);
  const reference=defaults.basis;
  const coordinates=files.geometry==='explicit'&&structure?.atoms.length?structure:null;
  const semi=isSemiempirical(settings.method),stored=settings.task==='freq'&&files.hessian==='readfc';
  const inherited=stored||files.basisFromCheckpoint;
  function sizeText(value:string){if(!coordinates)return '无显式坐标：不统计';if(settings.mixedBasis?.enabled&&canonicalBasis(value)===canonicalBasis(settings.basis)){const angular=angularBasisPlan(settings),data=mixedBasisSize(coordinates,value,settings.mixedBasis,angular.dForm,angular.fForm);return data.count===null?data.reason:'混合分配共 '+data.count+' 个基函数';}const data=methodBasisComparison(coordinates,settings,value,reference);return data.count===null?data.reason:data.count+' 个基函数';}
  function sizeSummary(value:string){const text=sizeText(value);return <span className="basis-stat" title={text} data-testid={canonicalBasis(settings.basis)===canonicalBasis(value)?'basis-count':undefined}>{inherited?'继承CHK，不统计':semi?'半经验内置参数':!coordinates?'无显式坐标：不统计':text?.match(/\d+ 个基函数/)?.[0]??'基函数数待核实'}</span>;}
  function methodLabel(id:MethodId,dispersion:GaussianSettings['dispersion']){const method=METHODS.find(item=>item.id===id);return (method?.label??id)+(dispersion==='gd3bj'?'-D3(BJ)':dispersion==='gd3'?'-D3':'');}
  const methods=METHODS.map(item=>({value:item.id,label:methodLabel(item.id,item.dispersion),disabled:!!item.pending,body:<p>{authorMethodEvaluation('gaussian',item.id)??item.description}</p>}));
  const bases=BASES.map(item=>{const data=coordinates?methodBasisComparison(coordinates,settings,item.value,reference):null;return {value:item.value,label:item.label,disabled:!!item.pending,summary:sizeSummary(item.value),body:<><p>{authorBasisEvaluation('gaussian',item.value)??item.description}</p><strong className="basis-stat">{sizeText(item.value)}</strong>{data?.convention&&<details className="basis-count-details" onClick={event=>event.stopPropagation()}><summary>计数口径</summary><small>{data.convention}；仅计收缩轨道基函数，不计ECP项。</small>{data.ratio!==null&&data.costIndex!==null&&<small>相对参考基组 {reference}：基函数数 ×{data.ratio.toFixed(2)}，N⁴指数 ×{data.costIndex.toFixed(2)}。N⁴是规模指数，不是实际耗时预测。</small>}</details>}</>};});
  if(!bases.some(item=>item.value===settings.basis))bases.unshift({value:settings.basis,label:settings.basis+' · 来源名称待核实',disabled:false,summary:<span>未核实目录</span>,body:<p>请改选已核实完整数据，不能只填Gen/GenECP名称。</p>});
  if(onMixedBasis)bases.unshift({value:'__mixed__',label:'混合基组',disabled:files.geometry!=='explicit'||!!inherited||semi,summary:settings.mixedBasis?.enabled?sizeSummary(settings.basis):<span>按原子区域分配</span>,body:<p>添加区域，确认成员后选择各自基组；保留当前全局基组供其余原子使用。</p>});
  return <InputSettingsCard title="方法与基组" sectionKey="level" className="method-chooser input-level-card" actions={<>{onInherit&&<InputSettingsAction disabled={inheritDisabled} onClick={onInherit}>继承级别</InputSettingsAction>}<InputSettingsAction reset ariaLabel="恢复方法/基组" disabled={stored} onClick={onRecommend}>恢复默认</InputSettingsAction></>}>
    {zindo?<div className="zindo-method-note" data-testid="zindo-method"><strong>ZINDO/S · 垂直激发</strong><p>使用ZINDO/S内置半经验参数，不使用轨道基组、DFT泛函或额外色散。原有方法与基组选择保留，切回TD/TDA后恢复显示。</p></div>:<>
    <div className="shared-method-fields">
    <CardDropdown label="计算方法" triggerLabel={methodLabel(settings.method,settings.dispersion)} layout="catalog" value={settings.method} options={methods} disabled={stored} onChange={value=>onMethod(value as MethodId)}/>
    {!external&&<CardDropdown label="基组" layout="catalog" value={onMixedBasis&&settings.mixedBasis?.enabled?'__mixed__':settings.basis} options={bases} disabled={semi||!!inherited} onChange={value=>{if(value==='__mixed__'){onMixedBasis?.(true);return;}onBasis(value);}} footer={<details className="basis-source-details"><summary>科学数据来源与计数说明</summary><p>def2-SV(P) 缺少独立计数数据时保留未知，不猜数字。N⁴是基函数规模指数，不是实际耗时预测。</p><a href={BASIS_DATA_SOURCES.standard} target="_blank" rel="noreferrer">Basis Set Exchange 数据来源</a><a href={BASIS_DATA_SOURCES.ma} target="_blank" rel="noreferrer">ma-def2 原始数据</a></details>}/>}</div></>}
    {stored&&<p className="muted-note">已有频率力常数重分析，不按新方法/基组重算。</p>}
    {children}
  </InputSettingsCard>;
}
