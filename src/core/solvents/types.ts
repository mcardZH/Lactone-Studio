/** Physical solvent descriptors, separate from any program's keyword spelling. */
export interface SolventParameters {
  dielectric: number;
  refractiveIndex?: number;
  hydrogenBondAcidity?: number;
  hydrogenBondBasicity?: number;
  surfaceTension?: number;
  aromaticity?: number;
  halogenicity?: number;
}
export interface SolventSelection {
  mode: 'builtin' | 'custom';
  id?: string;
  custom?: SolventParameters & {
    name: string;
    /** Explicit epsilon-only UI mode; never inferred from an existing descriptor set. */
    opticalApproximation?: 'epsinf-1.9';
  };
}
export interface SolventEntry {
  id: string;
  englishName: string;
  chineseName: string;
  aliases: string[];
  dielectric: number | null;
  /** Optional physical reference for browsing, never an inferred ORCA parameter. */
  dielectricReference?: { value: number; temperatureK: number; source: string };
  refractiveIndex?: number;
  gaussian?: { pcm?: string; smd?: string };
  orca?: { cpcm?: string; smd?: string; majorVersions: number[] };
  sources: string[];
}
export type SolventModel = 'iefpcm' | 'cpcm' | 'smd';
export interface SolventIssue { field: string; message: string }
