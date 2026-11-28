import type {RamanStokesParameters} from '../../results/spectroscopy';

export interface RamanViewSnapshot {
  defaults?:Partial<RamanStokesParameters>;
  parameters:RamanStokesParameters|null;
  activityModeCount:number;
  usableStokesModeCount:number;
}

export interface RamanViewPort {
  read():RamanViewSnapshot;
  apply(parameters:RamanStokesParameters):void;
}

export interface VibrationViewPatch {
  setIndex?:number;
  mode?:number;
  amplitudeAngstrom?:number;
  periodMs?:number;
  playing?:boolean;
  phase?:number;
}

export interface VibrationViewSnapshot {
  viewRef:string;
  ownerId:string;
  resultId:string;
  sourceId:string;
  sourceSha256?:string;
  jobIndex:number;
  frameIndex:number;
  sourceFrameIndex?:number;
  active:boolean;
  revision:string;
  sets:{index:number;modeCount:number;selected:boolean}[];
  setIndex:number;
  modes:{mode:number;sourceMode:number;frequencyCmInverse:number;correctedFrequencyCmInverse:number;sourceLine:number}[];
  mode:number;
  hasDisplacements:boolean;
  amplitudeAngstrom:number;
  raman?:RamanViewSnapshot;
  periodMs:number;
  playing:boolean;
  manualDisplacementAngstrom:number;
  scene:{status:'presented'|'preparing'|'unavailable';phase?:number;angleRadians?:number};
}

export interface VibrationViewPort {
  read():VibrationViewSnapshot;
  configure(patch:VibrationViewPatch):void;
  applyRaman?(parameters:RamanStokesParameters):void;
}

const workspaces=new WeakMap<object,Map<string,VibrationViewPort>>();

/** The same provider as result and analysis tools owns each native panel. */
export function mountVibrationView(workspace:object,viewRef:string,port:VibrationViewPort):()=>void {
  let views=workspaces.get(workspace);
  if(!views){views=new Map();workspaces.set(workspace,views);}
  views.set(viewRef,port);
  const owner=views;
  return ()=>{if(owner.get(viewRef)===port)owner.delete(viewRef);};
}

export function vibrationViews(workspace:object|null|undefined):VibrationViewPort[] {
  return workspace?[...workspaces.get(workspace)?.values()??[]]:[];
}
