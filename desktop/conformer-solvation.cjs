'use strict';
const capability=require('../src/data/conformer-solvation.json');
const {assert,plain}=require('./security.cjs');
const {XTB_METHOD_LABELS,supportsXtbAlpb}=require('./xtb-capabilities.cjs');
const presets=new Map(capability.presets.map(row=>[row.id,row]));
function nativeAlpbSupported(method,operation,solvent){return ['md','metadynamics'].includes(operation)&&supportsXtbAlpb(method,solvent);}
function validateNativeSolvationEvidence(evidence,request){
 if(request.solvation===undefined){assert(evidence===undefined,'Gas native MD unexpectedly has solvation');return;}
 const wanted=request.solvation,target=(request.operation==='metadynamics'?request.metadynamics:request.molecularMD).temperatureK;
 assert(plain(evidence)&&evidence.model===wanted.model&&evidence.solvent===wanted.solvent&&evidence.kernel===(wanted.model==='alpb'?'p16':'still')
  &&evidence.referenceState==='gsolv'&&evidence.temperatureKelvin===Number(target.toExponential(4))&&evidence.sourceField==='stdout:solvation-model'
  &&evidence.parameterSet===`internal ${XTB_METHOD_LABELS[request.method]}/${wanted.model.toUpperCase()}`&&Number.isFinite(evidence.dielectricConstant)&&evidence.dielectricConstant>0,'Native MD solvation evidence differs from its request');
 if(wanted.model==='alpb'&&nativeAlpbSupported(request.method,request.operation,wanted.solvent)){
  assert(Math.abs(evidence.dielectricConstant-presets.get(wanted.solvent).nativeDielectric[request.method])<=.000051,'Native MD ALPB dielectric differs from its method parameters');
 }
}
module.exports={nativeAlpbSupported,validateNativeSolvationEvidence};
