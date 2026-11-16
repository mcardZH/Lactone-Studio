import {useCallback,useState} from 'react';
import type {TwoDAssemblyState} from '../../modeling/application/two-d-assembly';
import Fragment3DPreview from './Fragment3DPreview';
import {DismissibleNotice} from '../DismissibleNotice';

export default function TwoDLivePreview(p:{state:TwoDAssemblyState;inputKey:string|null;active:boolean;sourceKey:string;onRetry():void}) {
  const [controls,setControls]=useState<{center():void;resetView():void}|null>(null);
  const acceptControls=useCallback((value:{center():void;resetView():void}|null)=>setControls(value),[]);
  const stale=Boolean(p.inputKey&&p.state.preview&&p.state.displayedInputKey!==p.inputKey);
  const updating=p.state.status==='updating'||Boolean(p.inputKey&&p.state.inputKey!==p.inputKey);
  const label=!p.inputKey?'尚无结构':!p.active?'已暂停':updating?'更新中':p.state.status==='partial'?'部分片段未完成':'已同步';
  return <section className="two-d-live-preview" data-two-d-readonly-preview data-testid="two-d-live-preview" data-input-key={p.inputKey??''} data-displayed-input-key={p.state.displayedInputKey??''} data-state={p.state.status} data-stale={stale} data-complete={Boolean(p.state.complete)} data-atom-count={p.state.preview?.structure.atoms.length??0} onKeyDown={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()}>
    <div className="two-d-live-preview-header"><strong>三维预览 · 只读</strong><span role="status" aria-live="polite">{label}</span></div>
    <div className="two-d-live-preview-controls"><button type="button" disabled={!controls} onClick={()=>controls?.center()}>居中</button><button type="button" disabled={!controls} onClick={()=>controls?.resetView()}>恢复视图</button></div>
    <div className="two-d-live-preview-body">{p.state.preview?<Fragment3DPreview snapshot={p.state.preview.structure} sourceKey={p.sourceKey} kind="drawing" preserveCamera active={p.active} onControlsReady={acceptControls}/>:<div className="two-d-live-preview-empty">{!p.inputKey?'绘制结构后显示三维预览':p.state.status==='partial'?'当前片段尚不能生成三维预览':'正在准备三维预览…'}</div>}</div>
    {!!p.state.failures.length&&<div className="two-d-live-preview-failures">{p.state.failures.map(failure=><DismissibleNotice key={`${p.inputKey}:${failure.id}:${failure.message}`} identity={`${p.inputKey}:${failure.id}:${failure.message}`}>{failure.label}：{failure.message}</DismissibleNotice>)}<button type="button" onClick={p.onRetry} disabled={!p.active||updating}>重试未完成片段</button></div>}
    {p.state.preview&&<div className="two-d-live-preview-footer">拖动旋转 · Shift＋拖动平移 · 滚轮缩放</div>}
  </section>;
}
