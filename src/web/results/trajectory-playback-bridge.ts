import type {TrajectoryRange,TrajectoryResult} from '../../results/contracts';
import type {PlaybackDirection,PlaybackMode} from '../../results/playback';
import {getPreparedTrajectoryFrame,registerPreparedTrajectoryProjection,type PreparationSnapshot} from '../../results/prepared-trajectory';
import type {PlaybackCollection,PlaybackCollectionIdentity} from '../../results/playback-collection';
import type {PlaybackOverlayControlsProps} from '../MultiframeDisplayControls';
export type PlaybackOverlayPresentation=Omit<PlaybackOverlayControlsProps,'onToggle'|'onFitAtoms'|'onReference'|'onReferenceIndex'|'onCurrentReference'|'onCancelCenter'>;

/** Pure view state; the owning TrajectoryWorkspace keeps the only timer. */
export interface TrajectoryPlaybackState {
  resultId:string;count:number;index:number;playing:boolean;busy:boolean;disabled:boolean;
  fps:number;direction:PlaybackDirection;mode:PlaybackMode;range:TrajectoryRange;endpointPauseMs:number;
  projectionKey?:string;
  collectionIdentity?:PlaybackCollectionIdentity;frameId?:string;targets?:PlaybackCollection['targets'];overlay?:PlaybackOverlayPresentation;
  preparation?:PreparationSnapshot|null;loading?:boolean;loadCancelled?:boolean;silentLoading?:boolean;
}
type BaseTrajectoryPlaybackCommand =
  | {action:'play'|'pause'}
  | {action:'seek';index:number}
  | {action:'step'|'direction';direction:PlaybackDirection}
  | {action:'fps'|'endpoint-pause';value:number}
  | {action:'mode';mode:PlaybackMode}
  | {action:'range';range:TrajectoryRange}
  | {action:'prepare'|'cancel-preparation'} | {action:'silent-loading';value:boolean};
export type PlaybackDisplayCommand={action:'seek-target';kind:'ts'|'ci'}|{action:'overlay-toggle'|'overlay-current-reference'|'center-cancel'}|{action:'overlay-atoms';value:'heavy'|'all'}|{action:'overlay-reference';kind:string}|{action:'overlay-reference-index';index:number};
export type TrajectoryPlaybackCommand=BaseTrajectoryPlaybackCommand|PlaybackDisplayCommand;
export type PublicTrajectoryPlaybackCommand=TrajectoryPlaybackCommand;
export interface TrajectoryPlaybackBridge {state:TrajectoryPlaybackState;dispatch(command:PublicTrajectoryPlaybackCommand):void}
/** A playback projection maps visible positions to immutable source ordinals. */
export function trajectoryFrameOrder(count:number,order?:readonly number[]):readonly number[]{
  if(!order)return Array.from({length:count},(_,index)=>index);
  if(order.length!==count||new Set(order).size!==count||order.some(index=>!Number.isSafeInteger(index)||index<0||index>=count))throw new Error('轨迹播放顺序必须包含全部帧且不得重复。');
  return [...order];
}
/** An export-only view; the original source and its owner are never replaced. */
export async function trajectoryPlaybackExport(result:TrajectoryResult,order:readonly number[],signal?:AbortSignal):Promise<TrajectoryResult>{
  if(order.every((index,position)=>index===position))return result;
  const initialStructure=getPreparedTrajectoryFrame(result,order[0])?.raw??await result.getFrame(order[0],signal);
  const projection:TrajectoryResult={...result,frames:order.map((index,position)=>({...result.frames[index],index:position,sourceFrameIndex:result.frames[index].sourceFrameIndex??index})),initialStructure,
    getFrame:(index,signal)=>result.getFrame(order[index],signal),dispose(){}};
  registerPreparedTrajectoryProjection(result,projection,order);return projection;
}
export function trajectoryControlCallbacks(dispatch:(command:PublicTrajectoryPlaybackCommand)=>void){return{
  onPrepare:()=>dispatch({action:'prepare'}),onCancelPreparation:()=>dispatch({action:'cancel-preparation'}),onSilentLoading:(value:boolean)=>dispatch({action:'silent-loading',value}),
  onPlay:()=>dispatch({action:'play'}),onPause:()=>dispatch({action:'pause'}),
  onSeek:(index:number)=>dispatch({action:'seek',index}),onStep:(direction:PlaybackDirection)=>dispatch({action:'step',direction}),
  onFps:(value:number)=>dispatch({action:'fps',value}),onDirection:(direction:PlaybackDirection)=>dispatch({action:'direction',direction}),
  onMode:(mode:PlaybackMode)=>dispatch({action:'mode',mode}),onRange:(range:TrajectoryRange)=>dispatch({action:'range',range}),
  onEndpointPause:(value:number)=>dispatch({action:'endpoint-pause',value}),
  onSeekTarget:(kind:'ts'|'ci')=>dispatch({action:'seek-target',kind}),
};}
export function trajectoryOverlayControlCallbacks(dispatch:(command:PublicTrajectoryPlaybackCommand)=>void){return{
 onToggle:()=>dispatch({action:'overlay-toggle'}),onFitAtoms:(value:'heavy'|'all')=>dispatch({action:'overlay-atoms',value}),onReference:(kind:string)=>dispatch({action:'overlay-reference',kind}),
 onReferenceIndex:(index:number)=>dispatch({action:'overlay-reference-index',index}),onCurrentReference:()=>dispatch({action:'overlay-current-reference'}),onCancelCenter:()=>dispatch({action:'center-cancel'}),
};}
export function playbackOverlayPresentation(value:PlaybackOverlayControlsProps):PlaybackOverlayPresentation{
 const {enabled,busy,disabled,total,fitAtoms,referenceKind,referenceIndex,initialAvailable,centerAvailable,centerReason,centerBusy,centerProgress,centerError,meanRmsd,error}=value;
 return{enabled,busy,disabled,total,fitAtoms,referenceKind,referenceIndex,initialAvailable,centerAvailable,centerReason,centerBusy,centerProgress,centerError,meanRmsd,error};
}
/** IPC snapshots contain data only; callbacks belong to the owning view. */
export function trajectoryPlaybackState(value:import('./TrajectoryControls').TrajectoryControlsProps):Omit<TrajectoryPlaybackState,'resultId'>{
 const {count,index,playing,busy,disabled=false,fps,direction,mode,range,endpointPauseMs=0,preparation,loading,loadCancelled,silentLoading,targets}=value;
 return{count,index,playing,busy,disabled,fps,direction,mode,range,endpointPauseMs,preparation,loading,loadCancelled,silentLoading,targets};
}
