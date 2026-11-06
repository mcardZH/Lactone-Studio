import { Component, type ErrorInfo, type ReactNode } from 'react';
import {DismissibleNotice} from '../DismissibleNotice';

/** A malformed display must not unmount the workspace, tasks or saved drafts. */
export default class ViewportErrorBoundary extends Component<{
  resetKey: string; children: ReactNode; onError?(message: string): void;
}, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  componentDidCatch(error: Error, _info: ErrorInfo) { this.props.onError?.(`画布显示失败：${error.message}`); }
  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    return this.state.error ? <div className="model-error"><DismissibleNotice identity={this.props.resetKey}>画布显示失败：{this.state.error}</DismissibleNotice><button type="button" onClick={() => this.setState({ error: null })}>重试画布</button></div> : this.props.children;
  }
}
