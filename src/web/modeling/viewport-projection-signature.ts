interface ProjectionInputs {
  captureAtomIds?: readonly string[];
  analysisAtomCapture?: { requestId: string; contextKey: string; atomIds: readonly string[] };
  showAxes?: boolean;
  resultBondValues?: unknown;
  resultBondLabels?: boolean;
  resultAtomLabels?: unknown;
  resultHighlights?: unknown;
  resultBondColor?: boolean;
}

/** Read the actual camera at each call: a draw may frame a newly activated document. */
export function viewportProjectionSignature(view: readonly number[] | undefined, inputs: ProjectionInputs): string {
  return JSON.stringify([view, inputs.captureAtomIds,
    inputs.analysisAtomCapture && [inputs.analysisAtomCapture.requestId, inputs.analysisAtomCapture.contextKey, inputs.analysisAtomCapture.atomIds],
    inputs.showAxes, inputs.resultBondValues, inputs.resultBondLabels, inputs.resultAtomLabels, inputs.resultHighlights, inputs.resultBondColor]);
}
