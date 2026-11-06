import { elementSymbol } from '../elements';
import type { Vector3 } from '../types';
import { elementPresetHydrogenLength, ELEMENT_PRESET_LENGTH_REFERENCE } from './element-preset-lengths';
import { metalHydrogenConstructionLength } from './connection-length';

export type PresetBondOrder = 1 | 1.5 | 2 | 3;
export interface ElementPresetSlot {
  id: string;
  direction: Vector3;
  order: PresetBondOrder;
  /** Multiple/aromatic bonds remain explicit open connections, never C=H/C≡H. */
  fill: 'hydrogen' | 'open';
  preview: 'line' | 'wedge' | 'dash';
}
export interface ElementPreset {
  id: string; element: string; label: string; geometry: string;
  family: 'atom' | 'organic' | 'coordination';
  slots: readonly ElementPresetSlot[];
  hydrogenLength: number;
  description: string;
  /** UI grouping only; absent legacy metadata means common. */
  category?: 'common' | 'more';
  source?: string;
  hydrogenLengthSource?: string;
  /** New named seeds use checked constructor lengths; organic defaults stay unchanged. */
  attachmentLengthPolicy?: 'covalent-radii';
}

export const DEFAULT_ELEMENT_PRESET_ID = 'c-sp3';
/** The palette interaction follows the element-fragment concept in the official
 * GaussView manual. These are this application's explicit geometry seeds, not
 * a claim to reproduce undocumented GaussView fragment/metal parameters. */
export const ELEMENT_PRESET_REFERENCE = 'https://gaussian.com/wp-content/uploads/dl/gv6.pdf';
const unit = (v: Vector3): Vector3 => { const n = Math.hypot(...v); return v.map(x => x / n) as Vector3; };
const s = (direction: Vector3, order: PresetBondOrder = 1, preview: ElementPresetSlot['preview'] = 'line'): ElementPresetSlot => ({ id: '', direction: unit(direction), order, fill: order === 1 ? 'hydrogen' : 'open', preview });
const tetra = () => [s([1, 1, 1], 1, 'wedge'), s([1, -1, -1], 1, 'dash'), s([-1, 1, -1]), s([-1, -1, 1])];
const ring = (n: number, z = 0, phase = 0) => Array.from({ length: n }, (_, i) => s([Math.cos(phase + i * Math.PI * 2 / n), Math.sin(phase + i * Math.PI * 2 / n), z], 1, z > 0 ? 'wedge' : z < 0 ? 'dash' : 'line'));
const axes = () => [s([1, 0, 0]), s([-1, 0, 0]), s([0, 1, 0]), s([0, -1, 0]), s([0, 0, 1], 1, 'wedge'), s([0, 0, -1], 1, 'dash')];
const preset = (id: string, element: string, label: string, geometry: string, slots: ElementPresetSlot[], family: ElementPreset['family'] = 'organic', description = ''): ElementPreset => ({
  id, element, label, geometry, family,
  slots: slots.map((slot, index) => ({ ...slot, id: `${id}-slot-${index + 1}` })),
  hydrogenLength: family === 'coordination' ? metalHydrogenConstructionLength(element)! : element === 'C' ? 1.09 : element === 'N' ? 1.01 : element === 'O' ? .97 : 1.1,
  ...(family === 'coordination' ? {hydrogenLengthSource:ELEMENT_PRESET_LENGTH_REFERENCE+'；0.90×(r_cov(M)+r_cov(H))，H=0.31Å。'} : {}),
  description: description || (family === 'coordination' ? '几何种子；单键槽用真实 H 封端，电荷、自旋与力场适用性需另行确认。' : '单键槽用真实 H 封端；多键槽保持开价位。'),
  category: family === 'coordination' ? 'more' : 'common',
});
const angle = (degrees: number): Vector3 => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180), 0];
const pyramidHeight = Math.sqrt((Math.cos(107 * Math.PI / 180) + .5) / 1.5);
const pyramidRadius = Math.sqrt(1 - pyramidHeight ** 2);
const pyramid = Array.from({ length: 3 }, (_, i) => s([pyramidRadius * Math.cos(i * Math.PI * 2 / 3), pyramidRadius * Math.sin(i * Math.PI * 2 / 3), -pyramidHeight], 1, i === 0 ? 'wedge' : i === 1 ? 'dash' : 'line'));
const carbon = [
  preset('c-sp-triple', 'C', '线性 sp · 三＋单', 'linear', [s([1, 0, 0], 3), s([-1, 0, 0])]),
  preset('c-sp-double', 'C', '线性 sp · 两双', 'linear', [s([1, 0, 0], 2), s([-1, 0, 0], 2)]),
  preset('c-sp2', 'C', '平面 sp² · 双＋两单', 'trigonal-planar', [s([1, 0, 0], 2), s(angle(120)), s(angle(240))]),
  preset('c-aromatic', 'C', '芳香 · 两芳香＋单', 'trigonal-planar', [s([1, 0, 0], 1.5), s(angle(120), 1.5), s(angle(240))]),
  preset(DEFAULT_ELEMENT_PRESET_ID, 'C', '四面体 sp³', 'tetrahedral', tetra()),
];
const fe = (id: string, label: string, geometry: string, slots: ElementPresetSlot[]) => preset(id, 'Fe', label+' · H封端', geometry, slots, 'coordination');
const iron = [
  fe('fe-linear', '2 配位 · 线性', 'linear', [s([1, 0, 0]), s([-1, 0, 0])]),
  fe('fe-bent', '2 配位 · 弯曲', 'bent', [s(angle(0)), s(angle(120))]),
  fe('fe-trigonal-planar', '3 配位 · 平面三角', 'trigonal-planar', ring(3)),
  fe('fe-trigonal-pyramidal', '3 配位 · 三角锥', 'trigonal-pyramidal', pyramid.map(slot => ({ ...slot }))),
  fe('fe-t-shaped', '3 配位 · T 形', 't-shaped', [s([1, 0, 0]), s([-1, 0, 0]), s([0, 1, 0])]),
  fe('fe-tetrahedral', '4 配位 · 四面体', 'tetrahedral', tetra()),
  fe('fe-square-planar', '4 配位 · 平方平面', 'square-planar', ring(4)),
  fe('fe-seesaw', '4 配位 · 跷跷板', 'seesaw', [s([0, 0, 1], 1, 'wedge'), s([0, 0, -1], 1, 'dash'), s(angle(0)), s(angle(120))]),
  fe('fe-trigonal-bipyramidal', '5 配位 · 三角双锥', 'trigonal-bipyramidal', [...ring(3), s([0, 0, 1], 1, 'wedge'), s([0, 0, -1], 1, 'dash')]),
  fe('fe-square-pyramidal', '5 配位 · 四方锥', 'square-pyramidal', [...ring(4), s([0, 0, 1], 1, 'wedge')]),
  fe('fe-octahedral', '6 配位 · 八面体', 'octahedral', axes()),
  fe('fe-trigonal-prismatic', '6 配位 · 三角棱柱', 'trigonal-prismatic', [...ring(3, Math.sqrt(3) / 2), ...ring(3, -Math.sqrt(3) / 2)]),
  fe('fe-trigonal-antiprismatic', '6 配位 · 三角反棱柱 D₃d', 'trigonal-antiprismatic', [...ring(3, .6), ...ring(3, -.6, Math.PI / 3)]),
  fe('fe-pentagonal-bipyramidal', '7 配位 · 五角双锥', 'pentagonal-bipyramidal', [...ring(5), s([0, 0, 1], 1, 'wedge'), s([0, 0, -1], 1, 'dash')]),
  fe('fe-capped-octahedral', '7 配位 · 加帽八面体 C₃v', 'capped-octahedral', [...axes(), s([1, 1, 1], 1, 'wedge')]),
  fe('fe-square-antiprismatic', '8 配位 · 四方反棱柱', 'square-antiprismatic', [...ring(4, Math.sqrt(Math.SQRT1_2)), ...ring(4, -Math.sqrt(Math.SQRT1_2), Math.PI / 4)]),
  fe('fe-dodecahedral', '8 配位 · 十二面体 D₂d', 'dodecahedral', [s([.8, 0, 1], 1, 'wedge'), s([-.8, 0, 1], 1, 'wedge'), s([0, .8, -1], 1, 'dash'), s([0, -.8, -1], 1, 'dash'), s([1, 0, -.3]), s([-1, 0, -.3]), s([0, 1, .3]), s([0, -1, .3])]),
  fe('fe-tricapped-trigonal-prismatic', '9 配位 · 三帽三棱柱 D₃h', 'tricapped-trigonal-prismatic', [...ring(3, Math.sqrt(3) / 2), ...ring(3, -Math.sqrt(3) / 2), ...ring(3, 0, Math.PI / 3)]),
  fe('fe-capped-square-antiprismatic', '9 配位 · 帽反棱柱 C₄v', 'capped-square-antiprismatic', [...ring(4, Math.sqrt(Math.SQRT1_2)), ...ring(4, -Math.sqrt(Math.SQRT1_2), Math.PI / 4), s([0, 0, 1], 1, 'wedge')]),
  fe('fe-pentagonal-prismatic', '10 配位 · 五棱柱 D₅h', 'pentagonal-prismatic', [...ring(5, .65), ...ring(5, -.65)]),
];
export const ELEMENT_PRESET_GEOMETRY_REFERENCE = 'https://openstax.org/books/chemistry-2e/pages/7-6-molecular-structure-and-polarity';
export const ELEMENT_PRESET_COORDINATION_REFERENCE = 'https://openstax.org/books/chemistry-2e/pages/19-2-coordination-chemistry-of-transition-metals';
const openPreset=(id:string,element:string,label:string,geometry:string,slots:ElementPresetSlot[],category:NonNullable<ElementPreset['category']>='common',family:ElementPreset['family']='organic'):ElementPreset=>({
  ...preset(id,element,label+(family==='coordination'?' · H封端':' · 开端'),geometry,slots.map(slot=>({...slot,fill:family==='coordination'&&slot.order===1?'hydrogen':'open'})),family),category,
  hydrogenLength:elementPresetHydrogenLength(element),hydrogenLengthSource:ELEMENT_PRESET_LENGTH_REFERENCE+(family==='coordination'?'；0.90×(r_cov(M)+r_cov(H))，H=0.31Å。':'；既有builder/common构造值优先（B=.85，S-H=1.34Å）'),attachmentLengthPolicy:'covalent-radii',
  source:family==='coordination'?ELEMENT_PRESET_COORDINATION_REFERENCE:ELEMENT_PRESET_GEOMETRY_REFERENCE,
  description:family==='coordination'?'理想局部构建种子，单键槽用真实H封端；不是优化/实测平衡几何，不猜氧化态、电荷、自旋或力场适用性。':'理想局部构建种子，全部槽位是明确连接端，不自动补H；不是优化/实测平衡几何，不猜氧化态、电荷、自旋或力场适用性。显式手工加H仅用已核构造长度。',
});
const threeTetra=()=>tetra().slice(0,3);
const bipyramid=()=>[...ring(3),s([0,0,1],1,'wedge'),s([0,0,-1],1,'dash')];
const squarePyramid=()=>[...ring(4),s([0,0,1],1,'wedge')];
const seesaw=()=>[s([0,0,1],1,'wedge'),s([0,0,-1],1,'dash'),s(angle(0)),s(angle(120))];
/** Named common fragments are independent from the saved open-port presets.
 * Their H atoms and ideal construction geometry do not assign an electronic state. */
const hydridePreset=(id:string,element:string,label:string,geometry:string,slots:ElementPresetSlot[],category:NonNullable<ElementPreset['category']>='common'):ElementPreset=>({
  ...preset(id,element,label,geometry,slots),category,
  hydrogenLength:elementPresetHydrogenLength(element),
  hydrogenLengthSource:ELEMENT_PRESET_LENGTH_REFERENCE+(metalHydrogenConstructionLength(element)!==undefined?'；0.90×(r_cov(M)+r_cov(H))，H=0.31Å。':'；复用既有builder/common构造长度，缺项用已核共价半径之和。'),
  attachmentLengthPolicy:'covalent-radii',source:ELEMENT_PRESET_GEOMETRY_REFERENCE,
  description:'常用建模片段，单键槽用真实H封端，接入已有连接时占用对应H槽；采用理想构造几何，不代表最稳定物种或优化/实测平衡结构。电荷、自旋与力场适用性需另行确认。',
});
const hydrides=[
  hydridePreset('b-hydride-bh3','B','BH₃ · 理想平面三角','trigonal-planar',ring(3)),
  hydridePreset('si-hydride-sih4','Si','SiH₄ · 理想四面体','tetrahedral',tetra()),
  hydridePreset('p-hydride-ph3','P','PH₃ · 理想三角锥','trigonal-pyramidal',threeTetra()),
  hydridePreset('s-hydride-h2s','S','H₂S · 理想弯曲','bent',tetra().slice(0,2)),
  hydridePreset('se-hydride-h2se','Se','H₂Se · 理想弯曲','bent',tetra().slice(0,2)),
  ...(['F','Cl','Br','I'] as const).map(element=>hydridePreset(`${element.toLowerCase()}-hydride-h${element.toLowerCase()}`,element,`H${element} · 单键片段`,'single',[s([1,0,0])])),
  hydridePreset('mg-hydride-mgh2','Mg','MgH₂ · 理想线性','linear',[s([1,0,0]),s([-1,0,0])],'more'),
  hydridePreset('al-hydride-alh3','Al','AlH₃ · 理想平面三角','trigonal-planar',ring(3),'more'),
];
const commonHydrideDefaults:Readonly<Record<string,string>>={
  B:'b-hydride-bh3',Si:'si-hydride-sih4',P:'p-hydride-ph3',S:'s-hydride-h2s',Se:'se-hydride-h2se',
  F:'f-hydride-hf',Cl:'cl-hydride-hcl',Br:'br-hydride-hbr',I:'i-hydride-hi',
};
const mainGroup=[
  openPreset('b-open-trigonal-planar','B','平面三角 · 三单','trigonal-planar',ring(3)),
  openPreset('b-open-tetrahedral','B','四面体 · 四单（需核电子态）','tetrahedral',tetra(),'more'),
  openPreset('si-open-tetrahedral','Si','四面体 · 四单','tetrahedral',tetra()),
  openPreset('si-open-sp2','Si','平面 · 双＋两单','trigonal-planar',[s(angle(0),2),s(angle(120)),s(angle(240))],'more'),
  openPreset('p-open-trigonal-pyramidal','P','三角锥 · 理想三单','trigonal-pyramidal',threeTetra()),
  openPreset('p-open-trigonal-bipyramidal','P','三角双锥 · 五单','trigonal-bipyramidal',bipyramid()),
  openPreset('p-open-tetrahedral','P','四面体 · 四单（需核电子态）','tetrahedral',tetra(),'more'),
  openPreset('p-open-double','P','四面体 · 双＋三单','tetrahedral',tetra().map((slot,i)=>({...slot,order:i===0?2:1})),'more'),
  ...(['S','Se'] as const).flatMap(element=>[
    openPreset(`${element.toLowerCase()}-open-bent`,element,'弯曲 · 理想四面体两单','bent',tetra().slice(0,2)),
    openPreset(`${element.toLowerCase()}-open-seesaw`,element,'跷跷板 · 四单','seesaw',seesaw(),'more'),
    openPreset(`${element.toLowerCase()}-open-octahedral`,element,'八面体 · 六单','octahedral',axes(),element==='S'?'common':'more'),
    openPreset(`${element.toLowerCase()}-open-double`,element,'平面 · 双＋两单','trigonal-planar',[s(angle(0),2),s(angle(120)),s(angle(240))],'more'),
  ]),
  ...(['F','Cl','Br','I'] as const).flatMap(element=>[
    openPreset(`${element.toLowerCase()}-open-single`,element,'单连接端','single',[s([1,0,0])]),
    ...(element==='F'?[]:[
      openPreset(`${element.toLowerCase()}-open-t-shaped`,element,'T形 · 三单','t-shaped',[s([1,0,0]),s([-1,0,0]),s([0,1,0])],'more'),
      openPreset(`${element.toLowerCase()}-open-square-pyramidal`,element,'四方锥 · 五单','square-pyramidal',squarePyramid(),'more'),
    ]),
  ]),
];
const rareEarthCommon:Record<string,readonly string[]>=Object.fromEntries('Sc Y La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu'.split(' ').map(element=>[element,['octahedral']]));
const metalCommon:Record<string,readonly string[]>={
  ...rareEarthCommon,
  Mg:['tetrahedral','octahedral'],Ca:['octahedral'],Al:['trigonal-planar','tetrahedral','octahedral'],Ti:['tetrahedral','octahedral'],Cr:['octahedral'],Mn:['tetrahedral','octahedral'],Fe:['tetrahedral','octahedral'],Co:['tetrahedral','octahedral'],Ni:['tetrahedral','square-planar','octahedral'],Cu:['linear','square-planar','tetrahedral'],Zn:['tetrahedral','octahedral'],Ru:['octahedral'],Rh:['square-planar','octahedral'],Pd:['square-planar'],Ag:['linear','tetrahedral'],Pt:['square-planar','octahedral'],Au:['linear','square-planar'],
};
const metalShapes:[string,string,()=>ElementPresetSlot[]][]=[
  ['linear','2配位 · 线性',()=>[s([1,0,0]),s([-1,0,0])]],
  ['trigonal-planar','3配位 · 平面三角',()=>ring(3)],
  ['trigonal-pyramidal','3配位 · 理想三角锥',threeTetra],
  ['t-shaped','3配位 · T形',()=>[s([1,0,0]),s([-1,0,0]),s([0,1,0])]],
  ['tetrahedral','4配位 · 四面体',tetra],['square-planar','4配位 · 平方平面',()=>ring(4)],
  ['trigonal-bipyramidal','5配位 · 三角双锥',bipyramid],['square-pyramidal','5配位 · 四方锥',squarePyramid],
  ['octahedral','6配位 · 八面体',axes],['trigonal-prismatic','6配位 · 三角棱柱',()=>[...ring(3,Math.sqrt(3)/2),...ring(3,-Math.sqrt(3)/2)]],
];
const metalOpen=Object.entries(metalCommon).flatMap(([element,common])=>metalShapes.filter(([geometry])=>!rareEarthCommon[element]||common.includes(geometry)).map(([geometry,label,slots])=>openPreset(`${element.toLowerCase()}-open-${geometry}`,element,label,geometry,slots(),common.includes(geometry)?'common':'more','coordination')));
const specialized = [...carbon,
  preset('n-sp3', 'N', '三角锥 · NH₃', 'trigonal-pyramidal', pyramid),
  preset('n-planar', 'N', '平面三角 · 三单', 'trigonal-planar', ring(3)),
  preset('n-sp2', 'N', '平面 · 双＋单', 'bent-planar', [s(angle(0), 2), s(angle(120))]),
  preset('n-sp', 'N', '线性 · 三键开槽', 'linear', [s([1, 0, 0], 3)]),
  preset('o-bent', 'O', '弯曲 · H₂O', 'bent', [s(angle(0)), s(angle(104.5))]),
  preset('o-double', 'O', '双键开槽', 'linear', [s([1, 0, 0], 2)]),
  ...iron,
  ...hydrides,...mainGroup,...metalOpen,
];
const bare = (element: string) => preset(`${element.toLowerCase()}-atom`, element, 'Atom · 裸原子', 'atom', [], 'atom', '不自动加 H；保留显式开价位。');
/** Every chemical element is available as an explicitly bare atom. Only named
 * presets above add H; metals never pass through an organic valence guess. */
export function getElementPresets(element: string): readonly ElementPreset[] {
  const symbol = elementSymbol(element);
  return [bare(symbol), ...specialized.filter(entry => entry.element === symbol)];
}
export function getElementPreset(id: string): ElementPreset {
  const named = specialized.find(entry => entry.id === id);
  if (named) return named;
  const match = /^([a-z]{1,2})-atom$/.exec(id);
  if (match) return bare(elementSymbol(match[1]));
  throw new Error(`未知元素几何片段 ${id}。`);
}
export function defaultElementPresetId(element: string): string {
  const symbol = elementSymbol(element);
  return symbol === 'C' ? DEFAULT_ELEMENT_PRESET_ID : symbol === 'N' ? 'n-sp3' : symbol === 'O' ? 'o-bent' : commonHydrideDefaults[symbol] ?? `${symbol.toLowerCase()}-atom`;
}

export { prepareElementPreset } from './element-preset-placement';
