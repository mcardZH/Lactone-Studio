import {xtbSolvents} from '../../core/xtb-capabilities';
/** Historical GBSA drafts remain identifiable; current task controls expose ALPB. */
export const ADVANCED_GFN2_SOLVENTS={alpb:xtbSolvents('gfn2','alpb'),gbsa:xtbSolvents('gfn2','gbsa')};
export function advancedMethodSolvents(method:string,model:'alpb'|'gbsa'):readonly string[]{
 return xtbSolvents(method,model);
}
