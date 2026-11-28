import type { TrajectoryResult } from '../../results/contracts';
import type { ViewportRenderIdentity } from '../modeling/render/render-completion';
import type { CameraZoomReceipt } from '../modeling/render/adapter';
import type { ModelCameraCommand, ModelCameraGesture, ModelCameraGestureReceipt } from '../modeling/workspace-viewport';
import type { ResultViewPort } from '../results/results-mcp-context';
import { toolError } from './types';

export type ResultCameraCommand = ModelCameraCommand | ModelCameraGesture;
export interface NativeResultCameraPort {
  read(): { view: number[]; perceivedDistance: number; cell: boolean } | undefined;
  apply(command: ResultCameraCommand): ModelCameraGestureReceipt | CameraZoomReceipt;
}

export function resolveResultCamera(views: Iterable<ResultViewPort>, target: {ownerId:string;result:TrajectoryResult}, projectEpoch: number) {
  const view = [...views].find(row => row.ownerId === target.ownerId && row.active && row.available &&
    row.result.source.id === target.result.source.id && row.result.jobIndex === target.result.jobIndex &&
    [row.result.id, row.sourceResultId, row.rootResultId].includes(target.result.id));
  const submitted = view?.scene?.();
  const scene = view && submitted?.sourceId === view.result.source.id && submitted.jobIndex === view.result.jobIndex &&
    submitted.frameIndex === view.frameIndex ? submitted : undefined;
  const state = view?.frameReady && scene ? view.camera?.read() : undefined;
  const identity = { ownerId: target.ownerId, resultId: view?.result.id ?? target.result.id,
    jobIndex: view?.result.jobIndex ?? target.result.jobIndex, stage: view?.stage,
    frameIndex: view?.frameIndex, source: view?.result.source ?? target.result.source };
  return { ...identity, ...(state && scene && view?.camera ? { state, scene, port:view.camera,
    cameraKey: resultCameraKey(projectEpoch, identity, scene, view.analysisKey) } : {}) };
}

function resultCameraKey(projectEpoch:number, target:{ownerId:string;resultId:string}, scene:ViewportRenderIdentity, mount:string) {
  return JSON.stringify([projectEpoch,target.ownerId,target.resultId,scene.sourceId,scene.sourceRevision,scene.jobIndex,
    scene.frameIndex,scene.generation,scene.requestId,mount]);
}

export function applyResultCamera(target:ReturnType<typeof resolveResultCamera>, targetRef:string, cameraKey:unknown, command:ResultCameraCommand) {
  const recovery={tool:'view_camera',arguments:{action:'read',targetRef}};
  if(!target.port || !target.state)throw toolError('CAMERA_UNAVAILABLE','请先定位并等待该结果的原生视口就绪。',
    {targetRef,recovery:{tool:'es_show',arguments:{target:targetRef,waitFor:'scene'}}});
  if(typeof cameraKey!=='string' || cameraKey!==target.cameraKey)throw toolError('CAMERA_TARGET_CHANGED','结果或帧已变化，请从实际目标重新读取相机。',{targetRef,recovery});
  if(command.kind==='cell'&&!target.state.cell)throw toolError('CAMERA_UNAVAILABLE','当前结果帧没有晶胞方向。',{targetRef,recovery});
  return target.port.apply(command);
}
