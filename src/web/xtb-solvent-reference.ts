import library from '../data/solvents-library.json';
import type {XtbAlpbPreset} from '../core/xtb-capabilities';

export interface XtbSolventReference {
  value?:number;
  temperatureK?:number;
  source?:string;
  approximate?:boolean;
  referenceNote?:string;
  detail?:string;
}

// These are display aliases into the already reviewed physical-property table.
// They never select a computational solvent or override an xTB parameter.
const referenceAliases:Readonly<Record<string,string>>=Object.freeze({
  aniline:'gaussian:aniline',
  benzaldehyde:'gaussian:benzaldehyde',
  benzene:'gaussian:benzene',
  cs2:'gaussian:carbondisulfide',
  dioxane:'gaussian:1-4-dioxane',
  dmf:'gaussian:n-n-dimethylformamide',
  ether:'gaussian:diethylether',
  hexadecane:'gaussian:n-hexadecane',
  nitromethane:'gaussian:nitromethane',
  octanol:'gaussian:n-octanol',
});
const reviewedEntries=new Map(library.entries.map(row=>[row.id,row]));
const supplementaryReferences:Readonly<Record<string,Readonly<XtbSolventReference>>>=Object.freeze({
  furane:Object.freeze({value:2.95,temperatureK:298.15,
    source:'https://nvlpubs.nist.gov/nistpubs/Legacy/circ/nbscircular514.pdf#page=19',
    detail:'NBS Circular 514，印刷页12：纯液态呋喃，25 °C。'}),
  phenol:Object.freeze({value:9.78,temperatureK:333.15,
    source:'https://nvlpubs.nist.gov/nistpubs/Legacy/circ/nbscircular514.pdf#page=26',
    detail:'NBS Circular 514，印刷页19：液态苯酚，60 °C。'}),
  woctanol:Object.freeze({value:8.41,temperatureK:298.15,approximate:true,referenceNote:'文献外推',
    source:'https://doi.org/10.1007/s10822-020-00283-4',
    detail:'25 °C 条件的物性估计；由293.15/303.15 K实验曲线外推至水摩尔分数0.2705后取平均，不是直接实测值。'}),
});

/** Physical reference evidence only; nativeDielectric is deliberately not read. */
export function xtbSolventReference(preset:Pick<XtbAlpbPreset,'label'|'dielectric'>&Partial<Pick<XtbAlpbPreset,'id'>>):XtbSolventReference {
  if(Number.isFinite(preset.dielectric))return {value:preset.dielectric,source:'Minnesota Solvent Descriptor Database'};
  const supplementary=preset.id?supplementaryReferences[preset.id]:undefined;
  if(supplementary)return {...supplementary};
  const entry=preset.id?reviewedEntries.get(referenceAliases[preset.id]):undefined;
  return entry&&Number.isFinite(entry.dielectric)?{value:entry.dielectric!,source:'Gaussian 16 documented solvent reference table'}:{};
}
