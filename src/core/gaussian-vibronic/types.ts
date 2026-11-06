import type { Atom } from '../types';

export type VibronicMode = 'spectrum' | 'huang-rhys';
export type VibronicTheory = 'FC' | 'HT' | 'FCHT';
export type VibronicDirection = 'absorption' | 'emission';
export interface VibronicFileIdentity { name: string; size: number; sha256: string }
export interface VibronicLogJob {
  index:number; startLine:number; endLine:number; route:string;
  hasFrequencyData:boolean; normalTermination:boolean;
  boundary:'first'|'internal-link'|'new-invocation';
}
export interface VibronicEvidence {
  identity: VibronicFileIdentity;
  format: 'log' | 'fchk';
  atoms: Atom[];
  charge: number;
  multiplicity: number;
  route: string;
  routeComplete?:boolean;
  masses: number[];
  frequencies: number[];
  modeCount: number;
  completeModes: boolean;
  completeHessian: boolean;
  normalTermination: boolean;
  root: number | null;
  transitionDipole: [number, number, number] | null;
  errors: string[];
  warnings: string[];
  selectedJob?: VibronicLogJob & {inheritedFrom?:VibronicLogJob};
}
export interface VibronicState {
  log?: VibronicEvidence;
  fchk?: VibronicEvidence;
  checkpoint?: VibronicFileIdentity;
  /** Binds the user's correspondence/root/minimum confirmation to exact selected bytes. */
  confirmedBinding?: string;
}
export interface VibronicRequest {
  mode: VibronicMode;
  theory: VibronicTheory;
  direction: VibronicDirection;
  calculation?: 'reuse-frequencies' | 'recompute-ground';
  initial: VibronicState;
  final: VibronicState;
  /** Explicit atom-by-atom correspondence confirmation; reset on either source change. */
  correspondenceBinding?: string;
  name: string;
  memoryGB: number;
  cores: number;
  temperatureK?: number;
  spectrum?: {lower?:number;upper?:number;grain?:number;broadening?:'Gaussian'|'Lorentzian'|'Stick';hwhm?:number};
}
export interface VibronicIssue { code: string; message: string; state?: 'initial' | 'final' }
export interface VibronicValidation { valid: boolean; errors: VibronicIssue[]; warnings: string[] }
export interface VibronicOutput {
  name: string;
  text: string;
  dependencies: { name: string; role: string; sha256: string }[];
  notes: string[];
}
