import type { InteractionMethod } from './interaction-contracts';

// Primary method references checked against the current Multiwfn citation
// guide and publishers. Keep software and method credit visible together.
const software = [
  { label: 'Multiwfn: A multifunctional wavefunction analyzer (2012)', href: 'https://doi.org/10.1002/jcc.22885' },
  { label: 'A comprehensive electron wavefunction analysis toolbox for chemists, Multiwfn (2024)', href: 'https://doi.org/10.1063/5.0216272' },
] as const;

export const INTERACTION_METHOD_REFERENCES: Record<InteractionMethod, readonly { label: string; href: string }[]> = {
  iri: [
    { label: 'Interaction Region Indicator: A Simple Real Space Function Clearly Revealing Both Chemical Bonds and Weak Interactions (2021)', href: 'https://doi.org/10.1002/cmtd.202100007' },
    ...software,
  ],
  rdg: [
    { label: 'Revealing Noncovalent Interactions (2010)', href: 'https://doi.org/10.1021/ja100936w' },
    ...software,
  ],
  igmh: [
    { label: 'Independent gradient model based on Hirshfeld partition: A new method for visual study of interactions in chemical systems (2022)', href: 'https://doi.org/10.1002/jcc.26812' },
    { label: 'IGMH 原文勘误（ChemRxiv, 2022）', href: 'https://doi.org/10.26434/chemrxiv-2022-g1m34' },
    ...software,
  ],
  migm: [
    // This chapter introduces mIGM before amIGM; it is not a separate mIGM paper.
    { label: 'Graphically Revealing Weak Interactions in Dynamic Environments Using amIGM Method (2025)', href: 'https://doi.org/10.1007/430_2025_95' },
    ...software,
  ],
  igm: [
    { label: 'Accurately extracting the signature of intermolecular interactions present in the NCI plot of the reduced density gradient versus electron density (2017)', href: 'https://doi.org/10.1039/C7CP02110K' },
    ...software,
  ],
};
