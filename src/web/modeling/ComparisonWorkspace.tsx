import {DismissibleNotice} from '../DismissibleNotice';
import type { ModelDocument, DisplaySettings, InteractionState } from '../../modeling/contracts';
import type { ViewSuperpositionResult } from '../../modeling/view-superposition';
import { suggestSequentialAtomPairs } from '../../modeling/view-superposition';
import ModelViewport, { type ModelViewportProps } from './ModelViewport';
import './comparison-workspace.css';

export interface ComparisonPanel {
  document: ModelDocument;
  label?: string;
  display: DisplaySettings;
  cameraView?: number[];
  onCameraViewChange?(view: number[]): void;
  cameraRequest?: ModelViewportProps['cameraRequest'];
  resetViewRequest?: number;
  showAxes?: boolean;
}
export interface ComparisonSuperpositionRequest {
  movingDocumentId: string;
  referenceDocumentId: string;
  movingRevision: number;
  referenceRevision: number;
  mappingConfirmed: true;
}
export interface ComparisonSuperposition extends Omit<ComparisonSuperpositionRequest, 'mappingConfirmed'> { result: ViewSuperpositionResult }
export interface ComparisonWorkspaceProps {
  left: ComparisonPanel;
  right: ComparisonPanel;
  activeDocumentId: string | null;
  onActivate(documentId: string): void;
  superposition?: ComparisonSuperposition | null;
  onSuperpose(request: ComparisonSuperpositionRequest): void;
  onClearSuperposition(): void;
  onError?(documentId: string, message: string): void;
}
const observationInteraction: InteractionState = { element: null, box: false, alt: false, gesture: 'none' };
const noEdit = () => undefined;

/** A controlled comparison surface: receives snapshots, never owns a store,
 * input task, undo stack or DynamicsController. A second renderer is a mirror,
 * not a second editable/compute workspace. Raw structures go to the viewport;
 * only its viewTransform receives an identity/revision-bound display fit. */
export default function ComparisonWorkspace(props: ComparisonWorkspaceProps) {
  const { left, right, superposition, activeDocumentId } = props;
  const bound = Boolean(superposition
    && superposition.movingDocumentId === right.document.id && superposition.referenceDocumentId === left.document.id
    && superposition.movingRevision === right.document.revision && superposition.referenceRevision === left.document.revision);
  const accepted = bound && superposition?.result.ok ? superposition.result : null;
  const canSuggest = left.document.id !== right.document.id
    && suggestSequentialAtomPairs(right.document.draft.structure.atoms, left.document.draft.structure.atoms).length > 0;
  const unavailable = left.document.id === right.document.id ? '请选择两个不同的模型。'
    : !left.document.draft.structure.atoms.length || !right.document.draft.structure.atoms.length ? '两个模型都需要原子才能显示叠合。'
    : !canSuggest ? '两侧原子数、逐序元素或原子ID不符合按编号叠合条件。' : null;
  function requestSuperposition() {
    if (!canSuggest) return;
    // This explicit button confirms only the index+element correspondence for
    // this view request. It is never a QST/NEB task atom-mapping acknowledgement.
    props.onSuperpose({ movingDocumentId: right.document.id, referenceDocumentId: left.document.id,
      movingRevision: right.document.revision, referenceRevision: left.document.revision, mappingConfirmed: true });
  }
  function panel(side: 'left' | 'right', value: ComparisonPanel) {
    const id = value.document.id, active = activeDocumentId === id;
    // Document activation decorates the panel; both visible Viewports stay
    // enabled so their independent renderer and controlled camera can update.
    return <article key={`${side}-${id}`} className="comparison-panel" data-testid={`comparison-${side}`} data-document-id={id} data-active={active}>
      <header className="comparison-panel-heading">
        <span className="comparison-side">{side === 'left' ? '左侧 · 参考' : '右侧 · 对比'}</span>
        <strong>{value.label ?? value.document.draft.structure.name}</strong>
        <button type="button" aria-pressed={active} onClick={() => props.onActivate(id)}>{active ? '当前模型' : '激活此模型'}</button>
      </header>
      <div className="comparison-viewport" onPointerDownCapture={() => props.onActivate(id)} onFocusCapture={() => props.onActivate(id)}>
        <ModelViewport document={value.document} display={value.display} interaction={observationInteraction}
          readOnly active observationFixedFrame observationTool="rotate"
          viewTransform={side === 'right' ? accepted?.transform : undefined}
          cameraView={value.cameraView} onCameraViewChange={value.onCameraViewChange}
          cameraRequest={value.cameraRequest} resetViewRequest={value.resetViewRequest} showAxes={value.showAxes}
          onHover={noEdit} onGestureStart={noEdit} onGestureEnd={noEdit} onSelection={noEdit} onCommand={noEdit}
          onError={message => props.onError?.(id, message)}/>
      </div>
      <p className="comparison-panel-hint">点击画布激活此模型；拖动与滚轮只改变此侧观察。</p>
    </article>;
  }
  return <section className="comparison-workspace" data-testid="comparison-workspace" aria-label="双模型只读对比">
    <header className="comparison-controls">
      <strong>模型对比</strong>
      <button type="button" data-testid="comparison-superpose" disabled={!canSuggest} onClick={requestSuperposition}>右侧按编号与元素叠合到左侧</button>
      <button type="button" data-testid="comparison-clear-superposition" disabled={!superposition} onClick={props.onClearSuperposition}>清除显示叠合</button>
    </header>
    <p className="comparison-scope">此次对应仅用于显示叠合；输入生成使用源坐标，任务原子映射独立确认。</p>
    {unavailable && <p className="comparison-notice" role="status">{unavailable}</p>}
    {superposition && !bound && <p className="comparison-notice" role="status" data-testid="comparison-stale">模型或版本已变化，请重新确认显示叠合。</p>}
    {bound && superposition && !superposition.result.ok && <DismissibleNotice className="comparison-error" role="alert">{superposition.result.issues.map(issue => issue.message).join(' ')}</DismissibleNotice>}
    {accepted && <output className="comparison-fit" data-testid="comparison-superposition-result">
      RMSD {accepted.rmsd.toPrecision(6)} Å · {accepted.diagnostics.pairCount} 对原子
      {accepted.diagnostics.rotationAmbiguous && ' · 退化旋转已采用确定规则'}
    </output>}
    <div className="comparison-panels">{panel('left', left)}{panel('right', right)}</div>
  </section>;
}
