import { createStoredZip, exportResultData, exportTrajectoryXYZ, type ResultExportOptions } from '../../results/export';
import { automaticStem } from '../../core/naming';
import { captureTrajectoryViewportPng, createOffscreenCapture, exportBlob, exportFrameImages, openBinaryExportSink } from './export-image';
import type { TrajectoryExportRequest } from './TrajectoryWorkspace';
import { assertResultNotAborted, type TrajectoryRange, type TrajectoryResult } from '../../results/contracts';
import type { EnergySeries } from '../../results/energy';
import { vibrationExportResult } from './vibration-export';
import { captureVibrationGif } from './vibration-gif-capture';

export const scientificTrajectoryFormats = ['xyz', 'extxyz', 'txt', 'txt-json'] as const;
export type ScientificTrajectoryFormat = typeof scientificTrajectoryFormats[number];

/** Shared native writer used by the workspace file menu and the MCP export. */
export async function exportWorkspaceTrajectoryData(
  result: TrajectoryResult, range: TrajectoryRange, format: ScientificTrajectoryFormat,
  options: ResultExportOptions & { energySeries?: EnergySeries; filenameStem?: string } = {},
): Promise<{ blob: Blob; filename: string }> {
  const name = options.filenameStem ?? automaticStem(result.label, { fallback: 'trajectory' });
  if (format === 'xyz' || format === 'extxyz')
    return { blob: await exportTrajectoryXYZ(result, range, { ...options, format }), filename: `${name}.${format}` };
  assertResultNotAborted(options.signal);
  const data = exportResultData(result, range, options.energySeries, options.origins);
  if (format === 'txt') return { blob: new Blob([data.txt], { type:'text/plain;charset=utf-8' }), filename: `${name}.txt` };
  const encode = new TextEncoder();
  return {
    blob: createStoredZip([{ name:`${name}.txt`, bytes:encode.encode(data.txt) }, { name:`${name}.json`, bytes:encode.encode(data.json) }]),
    filename: `${name}-data.zip`,
  };
}

export async function exportWorkspaceResult(request: TrajectoryExportRequest): Promise<void> {
  const {signal,format}=request;
  const vibration = request.vibration;
  assertResultNotAborted(signal);
  const name=automaticStem(request.result.label, { fallback: 'trajectory' });
  const extension=format==='png-sequence'||format==='txt-json'?'zip':format;
  const sink=await openBinaryExportSink(name,extension,signal);if(sink==='cancelled')return;
  let committed=false;
  const complete=async(blob:Blob,filename:string,owner?:Document)=>{assertResultNotAborted(signal);if(sink){if(blob.size)await sink.write(blob);await sink.close();committed=true;}else exportBlob(blob,filename,owner);};
  try {
  if (format === 'png' && request.currentViewportImage) {
    const { snapshot, ownerDocument } = request.currentViewportImage;
    await complete(await captureTrajectoryViewportPng(snapshot, ownerDocument, signal), `${name}.png`, ownerDocument);
    return;
  }
  if (format === 'gif' && request.vibrationGif) {
    if (!vibration) throw new Error('振动GIF缺少已选模式与原结构。');
    const output = await captureVibrationGif({ snapshot: { ...request, displayGeometry: 'vibration', vibrationBaseStructure: vibration.baseStructure,
      scalarSourceFrameIndex: vibration.frameIndex, atomicProperties: request.result.scientific?.atomicProperties.filter(item => item.kind === request.atomProperty?.kind && item.scheme === request.atomProperty?.scheme) },
      mode: vibration.mode, baseStructure: vibration.baseStructure, amplitude: vibration.amplitude,
      periodMs: request.vibrationGif.periodMs, durationSeconds: request.vibrationGif.durationSeconds, signal, sink:sink??undefined });
    assertResultNotAborted(signal);
    await complete(output.blob, `Ester-Studio-vibration-mode-${vibration.displayIndex ?? vibration.mode.index}.gif`);
    return;
  }
  const animation = format === 'gif' || format === 'png-sequence';
  const result = vibration ? vibrationExportResult(request.result, vibration, animation) : request.result;
  const range = vibration ? { start: 0, end: result.frames.length - 1, stride: 1 } : request.range;
  assertResultNotAborted(signal);
  if (format==='xyz'||format==='extxyz'||format==='txt'||format==='txt-json') {
    const comment=vibration?`derived="vibration-display" parent_frame=${vibration.frameIndex + 1} mode=${vibration.mode.index} frequency=${vibration.mode.frequency} frequency_unit="cm^-1" mode_source_line=${vibration.mode.sourceLine} amplitude=${vibration.amplitude} amplitude_unit="angstrom" display_phase=${vibration.phase}`:undefined;
    const output=await exportWorkspaceTrajectoryData(result,range,format,{signal,comment,sink:sink??undefined,
      filenameStem:name,energySeries:vibration?undefined:request.energySeries});
    await complete(output.blob,output.filename); return;
  }
  const selected = format==='png'?{start:vibration ? 0 : request.currentIndex,end:vibration ? 0 : request.currentIndex,stride:1}:range;
  const imageFormat=format==='png-sequence'?'png-sequence':format;
  const output=await exportFrameImages(result,selected,{format:imageFormat,width:request.width,height:request.height,delayMs:vibration && animation ? 50 : 1000/request.fps,loop:vibration ? true : request.mode!=='once',pingPong:!vibration && request.mode==='bounce',signal,sink:sink??undefined},()=>createOffscreenCapture({ ...request, atomProperty: request.atomProperty, atomicProperties: request.result.scientific?.atomicProperties.filter(item => item.kind === request.atomProperty?.kind && item.scheme === request.atomProperty?.scheme), scalarSourceFrameIndex: vibration?.frameIndex, annotation: vibration ? `Mode ${vibration.mode.index} | ${vibration.mode.frequency} cm^-1 | display amplitude ${vibration.amplitude} A | ${animation ? 'display cycle (not physical time)' : `phase ${vibration.phase.toFixed(4)}`} | source line ${vibration.mode.sourceLine}${request.atomProperty ? ` | parent frame ${vibration.frameIndex + 1} ${request.atomProperty.scheme} ${request.atomProperty.kind}` : ''}` : undefined },signal));
  assertResultNotAborted(signal);
  await complete(output,`${name}.${format==='png-sequence'?'zip':format}`);
  } finally {if(sink&&!committed)await sink.abort();}
}
