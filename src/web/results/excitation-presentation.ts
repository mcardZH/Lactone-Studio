import type { ExcitationStateRef,ExcitationSessionInfo, HoleElectronResult, NtoAnalysisResult, NtoPair } from '../../results/excitation-contracts';
import type { SurfaceContext } from '../../results/surface-contracts';
import { formatResultValue } from '../../results/numeric-format';
import type { ScientificTableProjection } from './scientific-table';
export const excitationStateKey = (context: SurfaceContext, state: ExcitationStateRef) => JSON.stringify([context.sourceId,context.sourceRevision,context.jobIndex,context.sourceFrameIndex,context.generation,context.documentId,context.documentRevision,state.frameIndex,state.sourceLine,state.index,state.multiplicity??null]);
export const excitationPairKey = (pair: Pick<NtoPair,'index'|'spin'>) => `${pair.spin}:${pair.index}`;
export const excitationStateDisplayLabel = (state:Pick<ExcitationStateRef,'index'|'label'|'multiplicity'>) => state.multiplicity===1?`S${state.index}`:state.multiplicity===3?`T${state.index}`:`State ${state.index} · ${state.label}`;
const CAPABILITY_REASONS:Readonly<Record<string,string>>={
 'The current Gaussian stage has no analyzable printed TD states; no state was borrowed from another job.':'当前 Gaussian 阶段没有可分析的 TD 态；未借用其他 job 的结果。',
 'The current Gaussian TD batch contains no printed configuration amplitudes.':'当前 Gaussian TD 批次未打印可用组态振幅。',
 'Full ORCA TDDFT requires same-job X/Y amplitudes from JSON or original CIS; combined printed weights are insufficient.':'完整 ORCA TDDFT 需要同一作业的 JSON 或原始 CIS X/Y 振幅；打印权重不能替代。',
 'ORCA TDA/full-RPA identity or this approximation is not supported by a verified amplitude route.':'当前 ORCA TDA/full-RPA 近似或振幅读取路线尚未可靠确认。',
 'ORCA TDA output lacks signed c= configuration amplitudes; printed weights alone do not establish their phases.':'当前 ORCA TDA 输出缺少带符号 c= 振幅；打印权重不足以确定相位。',
 'ORCA source lacks explicit supported singlet/triplet identity.':'当前 ORCA 输出缺少已支持的明确单重态／三重态身份。',
 'ORCA derivation requires a corresponding restricted closed-shell Molden orbital source.':'当前 ORCA 派生分析需要匹配的受限闭壳层 Molden 波函数。',
};
export function excitationCapabilityReason(info:ExcitationSessionInfo):string{return info.capabilities.reasons.map(reason=>CAPABILITY_REASONS[reason]??reason).join('；')||(info.states.length?'当前来源不满足此激发态分析的已验证前提。':'当前阶段没有可分析的激发态；请核对阶段及波函数归属。');}
const INTEGRITY_WARNINGS:Readonly<Record<string,string>>={
 'Loaded configuration coefficients deviate from their expected normalization; raw coefficients/weights/density integrals have not been renormalized.':'组态系数归一化偏差超过后端警告阈值；结果保留原始系数，未自动归一化。',
 'Native hole/electron integrals depart from 1 by more than 0.01; coefficients, grid spacing and spatial extent limit quantitative interpretation.':'空穴或电子密度积分偏离 1 超过 0.01；定量解释受组态系数、网格和空间范围影响。',
};
export function excitationIntegrity(result:NtoAnalysisResult|HoleElectronResult):{warnings:string[];details:{key:string;label:string;value:string}[];notices:readonly string[]}{
 const evidence=result.coefficients,details:{key:string;label:string;value:string}[]=[];
 const add=(key:string,label:string,value:unknown)=>{if(value!==undefined)details.push({key,label,value:String(value)});};
 for(const [key,label] of [['coefficientCount','原始组态数'],['excitationSquared','原始 ΣX²'],['deexcitationSquared','原始 ΣY²'],['netSquared','原始 X²−Y²'],['expectedNormalization','预期归一化'],['normalizationDeviation','原始归一偏差'],['nativeExcitationSquared','原生 ΣX²'],['nativeDeexcitationSquared','原生 ΣY²'],['nativeNetSquared','原生 X²−Y²'],['nativeNormalizationDeviation','原生归一偏差']] as const)add(key,label,evidence[key]);
 for(const [key,label] of [['crossTermCoefficientThreshold','交叉项系数截断阈值'],['coefficientExpectedNormalization','原生预期归一化'],['coefficientNormalizationDeviation','原生输出归一偏差'],['coefficientNormalizationWarningTolerance','归一偏差警告阈值']] as const)add(key,label,result.provenance.parameters[key]);
 for(const [key,label] of [['analysisOutputJobIndex','分析来源原始 job 索引'],['analysisOutputEndSourceLine','分析来源原文终止行'],['analysisOutputRevision','分析来源原文校验']] as const)add(key,label,result.provenance.parameters[key]);
 if(result.operation==='hole-electron')for(const [key,label] of [['hole-integral','原生空穴积分'],['electron-integral','原生电子积分']] as const){const metric=result.metrics.find(row=>row.key===key);if(metric)add(key,label,metric.rawValue);}
 return{warnings:[...new Set(result.provenance.notices.flatMap(notice=>INTEGRITY_WARNINGS[notice.trim()]?[INTEGRITY_WARNINGS[notice.trim()]]:[]))],details,notices:result.provenance.notices};
}
export function ntoPairTable(result:NtoAnalysisResult,decimals=2,all=true):ScientificTableProjection {
 return {columns:[{key:'pair',label:'轨道对'},{key:'spin',label:'自旋'},{key:'weight',label:'贡献 / %',heading:'贡献',headerUnit:'%'}],rows:result.pairs.filter(pair=>all||100*pair.eigenvalue>1).map(pair=>({key:excitationPairKey(pair),cells:[String(pair.index),pair.spin==='restricted'?'—':pair.spin==='alpha'?'α':'β',formatResultValue(pair.weightPercent,decimals)]}))};
}
export function ntoEigenvalueTable(result:NtoAnalysisResult,decimals=2):ScientificTableProjection {
 return {columns:[{key:'pair',label:'轨道对'},{key:'spin',label:'自旋'},{key:'lambda',label:'特征值 λ'}],rows:result.pairs.map(pair=>({key:excitationPairKey(pair),cells:[String(pair.index),pair.spin==='restricted'?'—':pair.spin==='alpha'?'α':'β',formatResultValue(pair.eigenvalue,decimals)]}))};
}
export function ntoMoTable(pair:NtoPair,decimals=2):ScientificTableProjection {
 return {columns:[{key:'side',label:'NTO'},{key:'mo',label:'来源 MO'},{key:'spin',label:'自旋'},{key:'amplitude',label:'展开系数'},{key:'percent',label:'贡献 / %',heading:'贡献',headerUnit:'%'}],rows:([pair.hole,pair.electron]).flatMap(orbital=>orbital.moContributions.map((row,index)=>({key:`${orbital.side}:${index}`,cells:[orbital.side==='hole'?'空穴':'电子',String(row.sourceIndex),row.spin==='restricted'?'—':row.spin==='alpha'?'α':'β',formatResultValue(row.amplitude,decimals),formatResultValue(row.percent,decimals)]})))};
}
const CORE=new Set(['d','sr','t','hdi','edi']);
const METRIC_LABELS:Readonly<Record<string,string>>={d:'空穴–电子中心距离 D',sr:'空穴–电子重叠 Sr',sm:'密度重叠 Sm',t:'电荷转移长度 t',hdi:'空穴离域指数 HDI',edi:'电子离域指数 EDI',h:'空间展宽 H','h-ct':'转移方向展宽 H_CT','hole-integral':'空穴密度积分','electron-integral':'电子密度积分','transition-integral':'跃迁密度积分','excitation-energy':'激发能','ghost-hunter':'Ghost-hunter 指标','ghost-hunter-first':'Ghost-hunter 第一项','ghost-hunter-second':'Ghost-hunter 第二项'};
const COMPONENT_LABELS:Readonly<Record<string,string>>={'hole-centroid':'空穴质心','electron-centroid':'电子质心','hole-rmsd':'空穴空间展宽 RMSD','electron-rmsd':'电子空间展宽 RMSD','delta-sigma':'展宽变化 Δσ',h:'空间展宽 H',d:'中心位移 D','transition-dipole':'跃迁偶极矩 μ','delta-dipole':'偶极矩变化 Δμ'};
const metricLabel=(row:HoleElectronResult['metrics'][number])=>{if(METRIC_LABELS[row.key])return METRIC_LABELS[row.key];const component=row.key.match(/^(.*)-(x|y|z|norm|overall)$/);return component&&COMPONENT_LABELS[component[1]]?`${COMPONENT_LABELS[component[1]]} · ${component[2]==='norm'?'模':component[2]==='overall'?'总值':component[2].toUpperCase()}`:row.label;};
export function holeElectronTables(result:HoleElectronResult,decimals=2,lengthUnit:'angstrom'|'bohr'='angstrom'):{summary:ScientificTableProjection;complete:ScientificTableProjection} {
 const table=(rows:HoleElectronResult['metrics']):ScientificTableProjection=>({columns:[{key:'metric',label:'指标'},{key:'value',label:'数值'},{key:'unit',label:'单位'}],rows:rows.map(row=>{const factor=row.unit==='angstrom'||row.unit==='Å'?1:row.unit==='bohr'?.529177210903:null,value=factor!==null&&row.value!==null?row.value*factor/(lengthUnit==='bohr'?.529177210903:1):row.value;return{key:row.key,cells:[metricLabel(row),formatResultValue(value,decimals),factor!==null?lengthUnit==='bohr'?'bohr':'Å':row.unit??'—']};})});
 const metrics=[...result.metrics];
 if(result.coulomb.requested){metrics.push({key:'coulomb-model',label:'电子–空穴库仑模型',value:result.coulomb.valueEV,unit:'eV',sourceLine:result.coulomb.sourceLine??0,rawValue:String(result.coulomb.valueEV??'')});}
 return {summary:table(metrics.filter(row=>CORE.has(row.key))),complete:table(metrics)};
}
