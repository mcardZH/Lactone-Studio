/**
 * Presentation copy confirmed by the user in v0.12, including the final
 * 6-311G(d,p) wording. This registry has no keywords, defaults or engine logic.
 * Engine mappings are explicit: related functional names are not aliases.
 */
export const AUTHOR_METHOD_EVALUATIONS = Object.freeze({
  b3lyp: '主族元素 OPT FREQ，价层垂直激发 TDDFT，HOMO-LUMO 等基础性质的计算。',
  pbe0: '过渡金属体系不知道选啥就选它，价层垂直激发 TDDFT。',
  m062x: '主族体系反应能、能垒、构象能、弱相互作用及 T1 激发能的计算。别用来算过渡金属。',
  wb97xd: '大共轭体系 OPT FREQ，弱相互作用，电荷转移及里德堡激发 TDDFT。',
  'cam-b3lyp': '大共轭体系、电荷转移及里德堡激发的 TDDFT 计算。',
  tpss: '3d 过渡金属、Cu/Ag/Au 团簇及静态相关较强体系的计算。',
  tpssh: '3d 过渡金属体系、Fe-S-Fe 等桥联体系及配合物自旋态能量差的计算。',
});

export const AUTHOR_BASIS_EVALUATIONS = Object.freeze({
  'def2-SVP': '计算量较小，适配范围广，是 OPT FREQ 的默认选择。',
  'def2-SV(P)': '去掉 H 极化，大小和 6-31G* 差不多，是 OPT FREQ 的最小容忍限。',
  'def2-TZVP': '单点能的默认选择，适合反应能、能垒等能量计算。',
  'def2-TZVPP': '更多极化函数，适合对单点能精度要求更高的计算。DFT 用到这一步基本就够了。',
  'def2-QZVP': '计算量较大，日常 DFT 一般用不到。',
  'ma-def2-TZVP': 'def2-TZVP 的弥散函数版本。阴离子、显著弱相互作用、电子云显著离域、电荷转移和里德堡激发等可以使用。',
  '6-31G(d)': '结构优化、振动分析的最小容忍限。',
  '6-31+G(d)': '6-31G(d) / 6-31G* 的弥散函数版本。阴离子、显著弱相互作用、电子云显著离域、电荷转移和里德堡激发等可以使用。',
  '6-31G(d,p)': '大小和 def2-SVP 差不多。',
  '6-31+G(d,p)': '6-31G(d,p) / 6-31G** 的弥散函数版本。阴离子、显著弱相互作用、电子云显著离域、电荷转移和里德堡激发等可以使用。',
  '6-311G(d,p)': '比6-31G**稍大，用作结构优化已经绰绰有余',
  '6-311+G(2d,p)': '6-311G(2d,p) 的弥散函数版本。阴离子、显著弱相互作用、电子云显著离域、电荷转移和里德堡激发等可以使用。',
});

type Engine = 'gaussian' | 'orca';
type MethodEvaluation = keyof typeof AUTHOR_METHOD_EVALUATIONS;
type BasisEvaluation = keyof typeof AUTHOR_BASIS_EVALUATIONS;
const methodMappings: Readonly<Record<Engine, Readonly<Record<string, MethodEvaluation>>>> = {
  gaussian: { b3lyp: 'b3lyp', pbe0: 'pbe0', m062x: 'm062x', wb97xd: 'wb97xd', 'cam-b3lyp': 'cam-b3lyp', tpss: 'tpss', tpssh: 'tpssh' },
  orca: { b3lyp: 'b3lyp', pbe0: 'pbe0', m062x: 'm062x', 'cam-b3lyp': 'cam-b3lyp', tpss: 'tpss', tpssh: 'tpssh' },
};
const basisMappings: Readonly<Record<Engine, Readonly<Record<string, BasisEvaluation>>>> = {
  gaussian: { def2SVP: 'def2-SVP', def2SVPP: 'def2-SV(P)', def2TZVP: 'def2-TZVP', def2TZVPP: 'def2-TZVPP', def2QZVP: 'def2-QZVP', 'ma-def2TZVP': 'ma-def2-TZVP', '6-31G(d)': '6-31G(d)', '6-31+G(d)': '6-31+G(d)', '6-31G(d,p)': '6-31G(d,p)', '6-31+G(d,p)': '6-31+G(d,p)', '6-311G(d,p)': '6-311G(d,p)', '6-311+G(2d,p)': '6-311+G(2d,p)' },
  orca: { 'def2-SVP': 'def2-SVP', 'def2-SV(P)': 'def2-SV(P)', 'def2-TZVP': 'def2-TZVP', 'def2-TZVPP': 'def2-TZVPP', 'def2-QZVP': 'def2-QZVP' },
};
export function authorMethodEvaluation(engine: Engine, id: string): string | undefined {
  const key = Object.hasOwn(methodMappings[engine], id) ? methodMappings[engine][id] : undefined;
  return key ? AUTHOR_METHOD_EVALUATIONS[key] : undefined;
}
export function authorBasisEvaluation(engine: Engine, value: string): string | undefined {
  const key = Object.hasOwn(basisMappings[engine], value) ? basisMappings[engine][value] : undefined;
  return key ? AUTHOR_BASIS_EVALUATIONS[key] : undefined;
}
