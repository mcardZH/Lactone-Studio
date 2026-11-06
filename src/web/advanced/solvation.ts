/** UI projection of the locked host's GFN2 capability table; host remains authoritative. */
export const ADVANCED_GFN2_SOLVENTS={
 alpb:['acetone','acetonitrile','aniline','benzaldehyde','benzene','ch2cl2','chcl3','cs2','dioxane','dmf','dmso','ethanol','ether','ethylacetate','furane','hexadecane','hexane','methanol','nitromethane','octanol','woctanol','phenol','toluene','thf','water'],
 gbsa:['acetone','acetonitrile','benzene','ch2cl2','chcl3','cs2','dmso','ether','water','methanol','thf','toluene','dmf','hexane'],
} as const;
export function advancedMethodSolvents(method:string,model:'alpb'|'gbsa'):readonly string[]{
 if(model==='alpb'&&['gfn1','gfn2','gfnff'].includes(method))return ADVANCED_GFN2_SOLVENTS.alpb;
 if(model==='gbsa'&&method==='gfn2')return ADVANCED_GFN2_SOLVENTS.gbsa;
 if(model==='gbsa'&&method==='gfn1')return ADVANCED_GFN2_SOLVENTS.gbsa.filter(name=>name!=='dmf'&&name!=='hexane');
 return [];
}
