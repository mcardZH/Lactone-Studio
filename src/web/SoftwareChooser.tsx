import type { ReactNode } from 'react';
import './software-chooser.css';

type SoftwareEngine = 'gaussian' | 'orca';
export interface SoftwareChoice<Id extends string = string> {
  id: Id; symbol: ReactNode; label: ReactNode; description?: ReactNode; action?: ReactNode;
  disabled?: boolean; pending?: boolean;
}
interface ChoicePresentationProps {
  disabled?: boolean; title?: ReactNode; description?: ReactNode;
  ariaLabel?: string; testId?: string;
}
export interface SoftwareChooserProps extends ChoicePresentationProps {
  onChoose(engine: SoftwareEngine): void;
  content?: Partial<Record<SoftwareEngine, { description?: ReactNode; action?: ReactNode }>>;
  /** Availability controls only existing G/O routes; pending engines remain placeholders. */
  capabilities?: Partial<Record<SoftwareEngine, boolean>>;
}
export interface WorkflowChooserProps<Id extends string> extends ChoicePresentationProps {
  choices: readonly SoftwareChoice<Id>[];
  onChoose(id: Id): void;
}

/** Product navigation, not a declaration of unimplemented engine capability. */
export default function SoftwareChooser<Id extends string>(props: WorkflowChooserProps<Id>): ReactNode;
export default function SoftwareChooser(props: SoftwareChooserProps): ReactNode;
export default function SoftwareChooser<Id extends string>(props: SoftwareChooserProps | WorkflowChooserProps<Id>) {
  const { disabled = false, title = '选择计算软件', description = '在右侧建模或直接拖入结构，再选择需要准备的计算任务。', ariaLabel = '选择计算软件', testId = 'software-chooser' } = props;
  const renderChoices = <Choice extends string,>(choices: readonly SoftwareChoice<Choice>[], onChoose: (id: Choice) => void) => choices.map(choice => {
    const body = <><span className="software-choice-symbol" aria-hidden="true">{choice.symbol}</span><strong>{choice.label}</strong>{choice.description != null && <p>{choice.description}</p>}<span className="software-choice-action">{choice.action ?? (choice.pending ? '待开发' : '选择任务 →')}</span></>;
    return choice.pending
      ? <div key={choice.id} className="software-choice-card software-choice-pending" aria-label={`${choice.label} 待开发`}>{body}</div>
      : <button type="button" key={choice.id} className="software-choice-card" disabled={disabled || choice.disabled} onClick={() => { if (!disabled && !choice.disabled) onChoose(choice.id); }}>{body}</button>;
  });
  const cards = 'choices' in props ? renderChoices(props.choices, props.onChoose) : renderChoices<SoftwareEngine>([
    { id: 'gaussian', symbol: 'G', label: 'Gaussian', description: props.content?.gaussian?.description ?? '分子量子化学输入准备：结构优化、频率、激发态、反应路径与分区设置。', action: props.content?.gaussian?.action, disabled: props.capabilities?.gaussian === false },
    { id: 'orca', symbol: 'O', label: 'ORCA', description: props.content?.orca?.description ?? '分子与反应路径输入准备：优化、光谱相关任务、CI-NEB 与已有多尺度方法。', action: props.content?.orca?.action, disabled: props.capabilities?.orca === false },
  ], props.onChoose);
  return <section className="software-chooser" aria-label={ariaLabel} data-testid={testId}>
    <div className="software-chooser-heading"><h2>{title}</h2><p>{description}</p></div>
    <div className="software-choice-grid">
      {cards}
      {!('choices' in props) && <><div className="software-choice-card software-choice-pending" aria-label="CP2K 待开发"><span className="software-choice-symbol" aria-hidden="true">C</span><strong>CP2K</strong><span className="software-choice-action">待开发</span></div>
      <div className="software-choice-card software-choice-pending" aria-label="Quantum ESPRESSO 待开发"><span className="software-choice-symbol" aria-hidden="true">Q</span><strong>Quantum ESPRESSO</strong><span className="software-choice-action">待开发</span></div></>}
    </div>
  </section>;
}
