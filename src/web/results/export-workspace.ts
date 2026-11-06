import { createStoredZip, exportResultData, exportTrajectoryXYZ } from '../../results/export';
import { createOffscreenCapture, exportBlob, exportFrameImages, openBinaryExportSink } from './export-image';
import type { TrajectoryExportRequest } from './TrajectoryWorkspace';
import { assertResultNotAborted } from '../../results/contracts';
import { vibrationExportResult } from './vibration-export';
import { captureVibrationGif } from './vibration-gif-capture';

export async function exportWorkspaceResult(request: TrajectoryExportRequest): Promise<void> {
  const {signal,format}=request;
  const vibration = request.vibration;
  assertResultNotAborted(signal);
  const name=(request.result.label.replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9_.-]/g,'-').replace(/^-+|-+$/g,'')||'trajectory').slice(0,100);
  const extension=format==='png-sequence'||format==='txt-json'?'zip':format;
  const sink=await openBinaryExportSink(name,extension,signal);if(sink==='cancelled')return;
  let committed=false;
  const complete=async(blob:Blob,filename:string)=>{assertResultNotAborted(signal);if(sink){if(blob.size)await sink.write(blob);await sink.close();committed=true;}else exportBlob(blob,filename);};
  try {
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
  if (format==='xyz'||format==='extxyz') {
    const comment=vibration?`derived="vibration-display" parent_frame=${vibration.frameIndex + 1} mode=${vibration.mode.index} frequency=${vibration.mode.frequency} frequency_unit="cm^-1" mode_source_line=${vibration.mode.sourceLine} amplitude=${vibration.amplitude} amplitude_unit="angstrom" display_phase=${vibration.phase}`:undefined;
    const output=await exportTrajectoryXYZ(result,range,{format,signal,comment,sink:sink??undefined});
    await complete(output,`${name}.${format}`); return;
  }
  if (format==='txt') {
    const data=exportResultData(result,range,vibration ? undefined : request.energySeries);
    await complete(new Blob([data.txt],{type:'text/plain;charset=utf-8'}),`${name}.txt`);return;
  }
  if (format==='txt-json') {
    const data=exportResultData(result,range,vibration ? undefined : request.energySeries),encode=new TextEncoder();
    await complete(createStoredZip([{name:`${name}.txt`,bytes:encode.encode(data.txt)},{name:`${name}.json`,bytes:encode.encode(data.json)}]),`${name}-data.zip`); return;
  }
  const selected = format==='png'?{start:vibration ? 0 : request.currentIndex,end:vibration ? 0 : request.currentIndex,stride:1}:range;
  const imageFormat=format==='png-sequence'?'png-sequence':format;
  const output=await exportFrameImages(result,selected,{format:imageFormat,width:request.width,height:request.height,delayMs:vibration && animation ? 50 : 1000/request.fps,loop:vibration ? true : request.mode!=='once',pingPong:!vibration && request.mode==='bounce',signal,sink:sink??undefined},()=>createOffscreenCapture({ ...request, atomProperty: request.atomProperty, atomicProperties: request.result.scientific?.atomicProperties.filter(item => item.kind === request.atomProperty?.kind && item.scheme === request.atomProperty?.scheme), scalarSourceFrameIndex: vibration?.frameIndex, annotation: vibration ? `Mode ${vibration.mode.index} | ${vibration.mode.frequency} cm^-1 | display amplitude ${vibration.amplitude} A | ${animation ? 'display cycle (not physical time)' : `phase ${vibration.phase.toFixed(4)}`} | source line ${vibration.mode.sourceLine}${request.atomProperty ? ` | parent frame ${vibration.frameIndex + 1} ${request.atomProperty.scheme} ${request.atomProperty.kind}` : ''}` : undefined },signal));
  assertResultNotAborted(signal);
  await complete(output,`${name}.${format==='png-sequence'?'zip':format}`);
  } finally {if(sink&&!committed)await sink.abort();}
}
