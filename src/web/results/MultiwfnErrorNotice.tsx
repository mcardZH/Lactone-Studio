import { DismissibleNotice } from '../DismissibleNotice';
import { openGlobalSettings } from '../global-settings-events';
import './analysis-environment.css';

export { multiwfnBackendFailure } from './multiwfn-errors';

function category(detail: string) {
  if (/\b[A-Z]+_BACKEND_MISSING\b/.test(detail)) return '未找到可用的Multiwfn。';
  if (/\b[A-Z]+_BACKEND_CONFIGURATION_INVALID\b/.test(detail)) return 'Multiwfn配置无法读取。';
  if (/\b[A-Z]+_BACKEND_PROGRAM_UNAVAILABLE\b|\bbackend-missing:/i.test(detail)) return '已配置的Multiwfn路径不可用。';
  if (/\b(?:interaction|hirshfeld)-path:|\bMULTIWFN_WORK_PATH_LONG\b/i.test(detail)) return '本次工作路径过长，未启动计算。';
  if (/\b[A-Z]+_WORK_DIRECTORY_UNAVAILABLE\b/.test(detail)) return '临时运行目录不可用，未启动计算。';
  if (/\bmultiwfn-start:/i.test(detail)) return 'Multiwfn未能启动，请查看详情。';
  if (/\b[A-Z]+_BACKEND_CHANGED\b|\b(?:[a-z]+-)?resource-changed:/i.test(detail)) return 'Multiwfn配置已变化，请重新打开此分析来源。';
  return null;
}

export default function MultiwfnErrorNotice({ message, identity, label, onRetry }: { message: string; identity?: unknown; label?: string; onRetry?():void }) {
  const title = category(message);
  return <DismissibleNotice role="alert" identity={identity}>
    {label && <strong>{label} </strong>}
    {title ? <>
      <span>{title}</span>
      <div className="analysis-environment-row">
        <button type="button" className="analysis-environment-button" onClick={openGlobalSettings}>前往全局设置</button>
        <details className="analysis-environment-details">
          <summary>详情</summary>
          <textarea aria-label="错误详情" readOnly value={message} />
        </details>
      </div>
    </> : message}
    {onRetry && <button type="button" className="analysis-environment-button" onClick={onRetry}>重试</button>}
  </DismissibleNotice>;
}
