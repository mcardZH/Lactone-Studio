export interface OniomElectronicState { charge:number; multiplicity:number }
export interface GaussianOniomBoundary {
  qmAtomId:string;
  lowAtomId:string;
  linkElement:string;
  linkAtomType?:string;
  linkPartialCharge?:number|null;
  /** null or zero delegates to Gaussian's native distance scaling. */
  scaleLow:number|null;
  scaleHigh:number|null;
  confirmed:boolean;
}
export interface GaussianOniomSettings {
  enabled:boolean;
  qmAtomIds:string[];
  freezeLowLayer:boolean;
  lowMethod:'UFF';
  embedding:'mechanical'|'electronic';
  chargeSource:'none'|'qeq'|'provided';
  atomTypes:Record<string,string>;
  partialCharges:Record<string,number|null>;
  boundaries:GaussianOniomBoundary[];
  modelHigh:OniomElectronicState;
  modelLow:OniomElectronicState;
  statesConfirmed:boolean;
  /** Explicit user review of an inferred graph; never inferred from coordinates here. */
  topologyConfirmed:boolean;
}
export const defaultOniomSettings=():GaussianOniomSettings=>({
  enabled:false,qmAtomIds:[],freezeLowLayer:false,lowMethod:'UFF',
  embedding:'mechanical',chargeSource:'none',atomTypes:{},partialCharges:{},boundaries:[],
  modelHigh:{charge:0,multiplicity:1},modelLow:{charge:0,multiplicity:1},
  statesConfirmed:false,topologyConfirmed:false,
});
