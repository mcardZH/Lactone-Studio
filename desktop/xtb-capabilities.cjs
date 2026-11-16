'use strict';
const data=require('../src/data/conformer-solvation.json');
const XTB_METHOD_IDS=Object.freeze(Object.keys(data.methodDefinitions));
const XTB_METHOD_LABELS=Object.freeze(Object.fromEntries(XTB_METHOD_IDS.map(id=>[id,data.methodDefinitions[id].label])));
const ALPB_SOLVENTS=Object.freeze(data.presets.map(row=>row.id));
const isXtbMethod=method=>Object.hasOwn(data.methodDefinitions,method);
const xtbMethodCapability=method=>isXtbMethod(method)?data.methodDefinitions[method]:undefined;
function supportsXtbOperation(method,operation,periodic=false){
 const row=xtbMethodCapability(method);if(!row||periodic&&!row.periodic)return false;
 if(operation==='wavefunction')return !periodic&&row.wavefunction;
 if(operation==='bond-perception')return method==='gfn2';
 if(operation==='singlepoint')return method==='gfn2'||method==='gxtb'&&!periodic;
 if(operation==='metadynamics')return !periodic;
 return ['optimize','md'].includes(operation);
}
function xtbSolvents(method,model,periodic=false){
 if(periodic)return [];
 if(model==='alpb')return data.nativeMethods.includes(method)?ALPB_SOLVENTS:[];
 return model==='gbsa'&&Object.hasOwn(data.legacyGbsaSolvents,method)?data.legacyGbsaSolvents[method]:[];
}
function supportsXtbAlpb(method,solvent,periodic=false){return xtbSolvents(method,'alpb',periodic).includes(solvent);}
module.exports={XTB_METHOD_IDS,XTB_METHOD_LABELS,ALPB_SOLVENTS,isXtbMethod,xtbMethodCapability,supportsXtbOperation,xtbSolvents,supportsXtbAlpb};
