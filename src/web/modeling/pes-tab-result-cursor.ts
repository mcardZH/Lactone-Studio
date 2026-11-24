import type {TrajectoryResult} from '../../results/contracts';
import type {AnalysisCanvas} from '../results/analysis-canvas';

interface ResultCursor {
  result: TrajectoryResult;
  index: number | undefined;
}

export interface RetainedPesTabResultCursor extends ResultCursor {
  sourceEpoch: number;
}

/** Capture the submitted cursor before the source tab's renderer goes inactive. */
export function pesTabResultCursor(canvas: AnalysisCanvas | null | undefined,
  owns: (result: TrajectoryResult) => boolean): ResultCursor | undefined {
  const result = canvas?.result;
  if (!canvas || canvas.displayOnlySourcePreview || !result || !owns(result)) return;
  if (canvas.readSubmittedScientificFrame) {
    const frame = canvas.readSubmittedScientificFrame();
    if (frame && owns(frame.result)) return {result: frame.result, index: frame.index};
    return {result, index: undefined};
  }
  return {result, index: canvas.scientificFrameReady === false ? undefined : canvas.frameIndex};
}

export function selectedPesTabResultCursor(canvas: AnalysisCanvas | null | undefined,
  retained: RetainedPesTabResultCursor | undefined, sourceEpoch: number,
  owns: (result: TrajectoryResult) => boolean): ResultCursor | undefined {
  const submitted = pesTabResultCursor(canvas, owns);
  if (submitted) return submitted;
  if (retained?.sourceEpoch === sourceEpoch && owns(retained.result)) return retained;
}
