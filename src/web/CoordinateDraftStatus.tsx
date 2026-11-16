/** Presentation only. The field's existing capture flag controls the visible label. */
export function CoordinateDraftStatus() {
  return <span className="coordinate-editor-status" data-testid="coordinate-editor-status" role="status" aria-live="polite" aria-atomic="true">
    <span className="coordinate-editor-pending">待确认</span>
    <span className="coordinate-editor-picking">点选中</span>
  </span>;
}
