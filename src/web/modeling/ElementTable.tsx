import { ELEMENTS } from '../../core/elements';
import { elementColor } from './render/element-colors';

const rows: (string | null)[][] = [
  ['H', ...Array(16).fill(null), 'He'],
  ['Li', 'Be', ...Array(10).fill(null), 'B', 'C', 'N', 'O', 'F', 'Ne'],
  ['Na', 'Mg', ...Array(10).fill(null), 'Al', 'Si', 'P', 'S', 'Cl', 'Ar'],
  'K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr'.split(' '),
  'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe'.split(' '),
  'Cs Ba La Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn'.split(' '),
  'Fr Ra Ac Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' '),
  [null, null, null, ...'Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu'.split(' ')],
  [null, null, null, ...'Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr'.split(' ')],
];
export default function ElementTable({ onSelect, selectedElement, colors, presentElements }: {
  onSelect(element: string): void; selectedElement?: string; colors?: Record<string, string>; presentElements?: ReadonlySet<string>;
}) {
  return <div className="model-periodic-table-scroll"><div className="model-periodic-table" aria-label="元素周期表">{rows.flatMap((row, r) => row.flatMap((element, c) => element ? <button type="button" key={element} title={String(ELEMENTS.indexOf(element) + 1)} aria-label={colors ? `${element}元素配色` : undefined} aria-pressed={selectedElement ? selectedElement===element : undefined} data-present={presentElements ? presentElements.has(element) : undefined} style={{ gridRow: r + 1, gridColumn: c + 1 }} onClick={() => onSelect(element)}><small>{ELEMENTS.indexOf(element) + 1}</small>{element}{colors && <i className="model-element-color-swatch" style={{ backgroundColor: elementColor(element, colors) }} />}</button> : []))}</div></div>;
}
