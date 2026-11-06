import { constructionBondLength, METAL_COVALENT_RADII, metalHydrogenConstructionLength } from './connection-length';

/** Cordero et al., Dalton Trans. 2008, 2832–2838, DOI 10.1039/B801115J.
 * Numerals cross-checked against the official ASE source, pinned commit:
 * https://gitlab.com/ase/ase/-/blob/6cb8784ac1056b7b897822ff7b763a323d92a543/ase/data/__init__.py
 * These covalent-radius sums are construction distances, not ionic radii,
 * oxidation-state assignments, metal–ligand equilibria or FF parameters.
 * Existing builder's B=.85 and common-pair lengths stay authoritative. */
export const ELEMENT_PRESET_LENGTH_REFERENCE = 'https://doi.org/10.1039/B801115J';
export const ELEMENT_PRESET_COVALENT_RADII: Readonly<Record<string,number>> = Object.freeze({
  H:.31,B:.85,C:.76,N:.71,O:.66,F:.57,Si:1.11,P:1.07,S:1.05,Se:1.20,Cl:1.02,Br:1.20,I:1.39,
  Mg:1.41,Ca:1.76,Al:1.21,Ti:1.60,Cr:1.39,Mn:1.39,Fe:1.32,Co:1.26,Ni:1.24,Cu:1.32,Zn:1.22,
  Ru:1.46,Rh:1.42,Pd:1.39,Ag:1.45,Pt:1.36,Au:1.36,
  Sc:METAL_COVALENT_RADII.Sc,Y:METAL_COVALENT_RADII.Y,
  La:METAL_COVALENT_RADII.La,Ce:METAL_COVALENT_RADII.Ce,Pr:METAL_COVALENT_RADII.Pr,Nd:METAL_COVALENT_RADII.Nd,Pm:METAL_COVALENT_RADII.Pm,
  Sm:METAL_COVALENT_RADII.Sm,Eu:METAL_COVALENT_RADII.Eu,Gd:METAL_COVALENT_RADII.Gd,Tb:METAL_COVALENT_RADII.Tb,Dy:METAL_COVALENT_RADII.Dy,
  Ho:METAL_COVALENT_RADII.Ho,Er:METAL_COVALENT_RADII.Er,Tm:METAL_COVALENT_RADII.Tm,Yb:METAL_COVALENT_RADII.Yb,Lu:METAL_COVALENT_RADII.Lu,
});
export function elementPresetConstructionLength(a:string,b:string,order=1):number {
  const index=[1,1.5,2,3].indexOf(order);
  if(index<0)throw new Error('元素预设接入需要明确的单/芳香/双/三键级。');
  const metalHydrogen = order === 1 ? a === 'H' ? metalHydrogenConstructionLength(b) : b === 'H' ? metalHydrogenConstructionLength(a) : undefined : undefined;
  if(metalHydrogen!==undefined)return metalHydrogen;
  // Keep the exact existing constructor wherever that pair is already known.
  if(a!=='Se'&&b!=='Se'){
    try{return constructionBondLength(a,b,order);}catch{/* Only missing supported radii proceed below; order already checked. */}
  }
  const left=ELEMENT_PRESET_COVALENT_RADII[a],right=ELEMENT_PRESET_COVALENT_RADII[b];
  if(left===undefined||right===undefined)throw new Error('元素预设接入缺少已核构造半径，未猜测距离。');
  return(left+right)*[1,.92,.88,.79][index];
}
export function elementPresetHydrogenLength(element:string):number{return elementPresetConstructionLength(element,'H',1);}
