import type { Dispersion, MethodId } from './types';
import { authorBasisEvaluation, authorMethodEvaluation } from './author-evaluations';

// Confirmed personal evaluations are presentation copy, separate from Gaussian keywords and defaults.
export interface MethodEntry {
  id: MethodId; label: string; keyword: string; family: string; dispersion: Dispersion;
  description: string; cost: string; caution: string; pending?: string;
}
export const METHODS: MethodEntry[] = [
  { id: 'b3lyp', label: 'B3LYP', keyword: 'b3lyp', family: '杂化 DFT', dispersion: 'gd3bj', description: authorMethodEvaluation('gaussian', 'b3lyp')!, cost: '常规杂化 DFT', caution: '默认配套 D3(BJ)。' },
  { id: 'pbe0', label: 'PBE0', keyword: 'pbe1pbe', family: '杂化 DFT', dispersion: 'gd3bj', description: authorMethodEvaluation('gaussian', 'pbe0')!, cost: '常规杂化 DFT', caution: 'Gaussian 关键词是 PBE1PBE。' },
  { id: 'm062x', label: 'M06-2X', keyword: 'm062x', family: '杂化 meta-GGA', dispersion: 'gd3', description: authorMethodEvaluation('gaussian', 'm062x')!, cost: '杂化 DFT；成本取决于体系与基组', caution: '保留程序默认格点；不自动加入节时 Int。' },
  { id: 'wb97xd', label: 'ωB97X-D', keyword: 'wb97xd', family: '长程校正杂化 DFT', dispersion: 'none', description: authorMethodEvaluation('gaussian', 'wb97xd')!, cost: '常规杂化 DFT', caution: '已含色散，不额外叠加 D3 / D3BJ。' },
  { id: 'cam-b3lyp', label: 'CAM-B3LYP', keyword: 'cam-b3lyp', family: '长程校正杂化 DFT', dispersion: 'gd3bj', description: authorMethodEvaluation('gaussian', 'cam-b3lyp')!, cost: '杂化 DFT；无固定耗时倍数', caution: '默认配套 D3(BJ)。' },
  { id: 'tpss', label: 'TPSS', keyword: 'tpsstpss', family: '纯 meta-GGA', dispersion: 'gd3bj', description: authorMethodEvaluation('gaussian', 'tpss')!, cost: '不含精确交换；实际耗时仍依赖体系', caution: 'Gaussian 关键词 TPSSTPSS；使用程序默认格点。' },
  { id: 'tpssh', label: 'TPSSh', keyword: 'tpssh', family: '杂化 meta-GGA', dispersion: 'gd3bj', description: authorMethodEvaluation('gaussian', 'tpssh')!, cost: '杂化 DFT，实际耗时依赖体系', caution: '自动写入TPSSh专属D3BJ参数IOp；不是套用TPSS参数。' },
  { id: 'pm6', label: 'PM6', keyword: 'pm6', family: '半经验', dispersion: 'none', description: '低成本半经验计算；不指定轨道基组。', cost: '通常显著低于 DFT，非测速结论', caution: '需检查元素参数覆盖；不等于 DFT 精度。' },
  { id: 'pm7', label: 'PM7', keyword: 'pm7', family: '半经验', dispersion: 'none', description: '低成本半经验备选；不指定轨道基组。', cost: '通常显著低于 DFT，非测速结论', caution: '不额外叠加 DFT 的经验色散或积分格点。' },
  {id:'gfn2-xtb',label:'GFN2-xTB · Gaussian挂接',keyword:'',family:'External接口',dispersion:'none',description:'Gaussian控制优化/TS/IRC/扫描，由xTB脚本计算能量与导数。',cost:'Gaussian单核；实际xTB线程沿原脚本',caution:'需要运行环境已有xtb.sh、genxyz、extderi和xTB；无CHK，不自动部署或运行。'},
  { id: 'custom', label: '自定义方法', keyword: '', family: '高级', dispersion: 'none', description: '自行填写方法关键词；不猜测配套色散。', cost: '由实际方法决定', caution: '复杂方法及色散可在生成后的文本中编辑并自行核对。' },
];

export interface BasisEntry { value: string; label: string; size: string; description: string; diffuse?: boolean; pending?: string }
export const BASES: BasisEntry[] = [
  { value: 'def2SVP', label: 'def2-SVP', size: '双 ζ + 极化', description: authorBasisEvaluation('gaussian', 'def2SVP')! },
  { value: 'def2SVPP', label: 'def2-SV(P)', size: '计数暂无核实数据', description: authorBasisEvaluation('gaussian', 'def2SVPP')! },
  { value: 'def2TZVP', label: 'def2-TZVP', size: '三 ζ + 极化', description: authorBasisEvaluation('gaussian', 'def2TZVP')! },
  { value: 'def2TZVPP', label: 'def2-TZVPP', size: '三 ζ + 更多极化', description: authorBasisEvaluation('gaussian', 'def2TZVPP')! },
  { value: 'def2QZVP', label: 'def2-QZVP', size: '四 ζ + 极化', description: authorBasisEvaluation('gaussian', 'def2QZVP')! },
  { value: 'ma-def2TZVP', label: 'ma-def2-TZVP', size: '三 ζ + 少量弥散', diffuse: true, description: authorBasisEvaluation('gaussian', 'ma-def2TZVP')! },
  { value: '6-31G(d)', label: '6-31G* / 6-31G(d)', size: '双 ζ + 重原子极化', description: authorBasisEvaluation('gaussian', '6-31G(d)')! },
  { value: '6-31+G(d)', label: '6-31+G* / 6-31+G(d)', size: '双 ζ + 重原子极化 / 弥散', diffuse: true, description: authorBasisEvaluation('gaussian', '6-31+G(d)')! },
  { value: '6-31G(d,p)', label: '6-31G** / 6-31G(d,p)', size: '双 ζ + 重原子d / 氢p极化', description: authorBasisEvaluation('gaussian', '6-31G(d,p)')! },
  { value: '6-31+G(d,p)', label: '6-31+G** / 6-31+G(d,p)', size: '双 ζ + 极化 / 重原子弥散', diffuse: true, description: authorBasisEvaluation('gaussian', '6-31+G(d,p)')! },
  { value: '6-311G(d,p)', label: '6-311G(d,p)', size: '三重分裂价层 + 极化', description: authorBasisEvaluation('gaussian', '6-311G(d,p)')! },
  { value: '6-311+G(2d,p)',label:'6-311+G(2d,p)',size:'三重分裂价层 + 2d/p极化 / 弥散',diffuse:true,description: authorBasisEvaluation('gaussian', '6-311+G(2d,p)')! },
];
export function canonicalBasis(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/def2-/g, 'def2');
  if (key === 'def2sv(p)') return 'def2SVPP';
  if (key === '6-31g*') return '6-31G(d)';
  if (key === '6-31+g*') return '6-31+G(d)';
  if (key === '6-31g**') return '6-31G(d,p)';
  if (key === '6-31+g**') return '6-31+G(d,p)';
  return BASES.find(item => item.value.toLowerCase() === key)?.value ?? raw.trim();
}
export const CATALOG_SOURCES = [
  { label: 'Gaussian 手册 · DFT / 色散参数', url: 'https://www.conflex.co.jp/gaussian_support/dft.php' },
  { label: 'Gaussian 手册 · 基组关键词', url: 'https://www.conflex.co.jp/gaussian_support/basissets.php' },
  { label: 'Gaussian 手册 · Gen / GenECP', url: 'https://www.conflex.co.jp/gaussian_support/gen.php' },
  { label: 'Gaussian 手册 · 冗余内坐标与约束', url: 'https://www.conflex.co.jp/gaussian_support/geom.php' },
  { label: 'Gaussian 手册 · 频率的ModRedundant', url: 'https://www.conflex.co.jp/gaussian_support/freq.php' },
  { label: 'Gaussian 手册 · IRC输入与算法', url: 'https://www.conflex.co.jp/gaussian_support/irc.php' },
  { label: 'Gaussian 手册 · ZINDO/S', url: 'https://www.conflex.co.jp/gaussian_support/zindo.php' },
  { label: 'Gaussian 手册 · SCRF方法支持', url: 'https://www.conflex.co.jp/gaussian_support/scrf.php' },
];
