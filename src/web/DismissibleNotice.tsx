import {Children, isValidElement, useState, type HTMLAttributes, type ReactNode} from 'react';
import './DismissibleNotice.css';

/** Display-only dismissal. Validation and task state remain owned by the caller. */
export type DismissibleNoticeProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  children?: ReactNode;
  /** Use a run/error instance identity to distinguish repeated identical errors. */
  identity?: unknown;
  /** Optional owner notification; dismissal still only changes presentation. */
  onDismiss?():void;
};

function noticeText(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{children?: ReactNode}>(child)
    ? noticeText(child.props.children) : String(child)).join('\n');
}

export function DismissibleNotice({children, identity, onDismiss, className = '', role = 'alert', ...props}: DismissibleNoticeProps) {
  const text = noticeText(children);
  const [visibility, setVisibility] = useState({identity, text, dismissed: false});
  const sameNotice = Object.is(visibility.identity, identity) && visibility.text === text;
  if (!sameNotice) setVisibility({identity, text, dismissed: false});
  // Empty notices stay mounted safely; the next message has a different content
  // identity. Callers with repeated identical events supply their event identity.
  if (!text || sameNotice && visibility.dismissed) return null;
  return <div {...props} role={role} className={`dismissible-notice ${className}`}>
    <div className="dismissible-notice-content">{children}</div>
    <button type="button" className="dismissible-notice-close" aria-label="关闭提示" title="关闭提示"
      onClick={event => {event.stopPropagation(); setVisibility({identity, text, dismissed: true}); onDismiss?.();}}>×</button>
  </div>;
}
