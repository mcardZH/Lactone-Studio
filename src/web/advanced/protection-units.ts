/** The UI follows GROMACS kJ mol^-1 nm^-2; science requests retain eV Å^-2. */
export const PROTECTION_KJ_MOL_NM2_PER_EV_ANGSTROM2=9648.533212331;
export const protectionStrengthToNative=(value:number)=>value/PROTECTION_KJ_MOL_NM2_PER_EV_ANGSTROM2;
export const protectionStrengthToDisplay=(value:number)=>value*PROTECTION_KJ_MOL_NM2_PER_EV_ANGSTROM2;
