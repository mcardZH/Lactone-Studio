import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { Code2, ChevronDown } from 'lucide-react';
import { buildOrcaCommon, getOrcaCommonCompatibility, type OrcaJobRequest } from '../core/orca';
import { useWorkbenchLayout } from './modeling/WorkbenchLayout';
import { foldInputCoordinates } from './input-preview';
import { clampWorkbenchPaneSize, WORKBENCH_PANE_LIMITS } from '../modeling/workbench-layout';
import type { JobRequest } from '../core/types';
import { gaussianDraftInputPreview, orcaDraftInputPreview } from './draft-input-preview';
import { buildGaussian, validateJob } from '../core/gaussian';
import { InputSettingsCheckbox } from './InputSettingsLayout';
import './native-input-preview.css';

interface Props {
  engine: 'gaussian'|'orca';
  text?: string;
  atomCount?: number;
  issues?: string[];
  orcaRequest?: OrcaJobRequest;
  gaussianRequest?: JobRequest;
  foldCoordinates: boolean;
  onFoldCoordinates: (fold: boolean) => void;
  manualText?: boolean;
  snapshotFiles?:readonly {name:string;text:string}[];
  minimumVersionLabel?:string;
  capabilityError?: string | null;
}

export default function EngineInputPreview({engine,text='',atomCount=0,issues=[],orcaRequest,gaussianRequest,foldCoordinates,onFoldCoordinates,manualText=false,capabilityError,snapshotFiles,minimumVersionLabel}:Props) {
  const workbench=useWorkbenchLayout();
  const open=!workbench.layout.folds['input.preview'];
  const setOpen=(value:boolean)=>workbench.updateLayout(current=>({...current,folds:{...current.folds,'input.preview':!value}}));
  const [index,setIndex] = useState(0);
  const resizeStart=useRef<{y:number;height:number}|null>(null);
  const savedPreviewHeight=workbench.layout.paneSizes.previewHeight;
  const resize=(value:number)=>workbench.updateLayout(current=>({...current,folds:{...current.folds,'input.preview.height-custom':true},paneSizes:{...current.paneSizes,previewHeight:clampWorkbenchPaneSize('previewHeight',value)}}));
  const result = useMemo(()=>orcaRequest&&!capabilityError?buildOrcaCommon(orcaRequest):null,[orcaRequest,capabilityError]);
  const gaussian = useMemo(()=>{
    if (!gaussianRequest || capabilityError) return null;
    const errors=validateJob(gaussianRequest);
    return {errors,text:errors.length?'':buildGaussian(gaussianRequest)};
  },[gaussianRequest,capabilityError]);
  const compatibility=useMemo(()=>orcaRequest?getOrcaCommonCompatibility(orcaRequest):null,[orcaRequest]);
  const minimum=minimumVersionLabel??(compatibility?(compatibility.minimumVersion==='5'?'5.0.3+':'≥'+compatibility.minimumVersion):'');
  const files = snapshotFiles??result?.files ?? [], file = files[index<files.length?index:0];
  const messages = capabilityError ? [capabilityError] : engine==='orca' ? result?.issues.filter(issue=>issue.severity==='error').map(issue=>issue.message) ?? [] : issues.length?issues:gaussian?.errors??[];
  const finalText = engine==='orca' ? file?.text ?? '' : gaussian?.text ?? text;
  const draft = !capabilityError && (messages.length>0 || !finalText) && (engine==='orca' ? !!orcaRequest : !!gaussianRequest);
  const current = capabilityError ? '' : draft ? engine==='orca' ? orcaDraftInputPreview(orcaRequest!) : gaussianDraftInputPreview(gaussianRequest!) : finalText;
  // Show the entire native header through its electronic-state declaration on
  // first use. Once resized, the user's actual height remains authoritative.
  const headerLines=current.split('\n'),stateLine=headerLines.findIndex(line=>engine==='gaussian'?/^\s*-?\d+\s+\d+\s*$/.test(line):/^\s*\*\s*xyz(?:file)?\s+/i.test(line));
  const headerHeight=Math.min(560,Math.max(300,(stateLine>=0?stateLine+1:Math.min(headerLines.length,12))*21+104));
  const previewHeight=workbench.layout.folds['input.preview.height-custom']||savedPreviewHeight!==220?savedPreviewHeight:headerHeight;
  const preview = foldCoordinates ? foldInputCoordinates(current,atomCount) : current;
  return <section className="engine-input-preview native-input-preview input-settings-layout" style={{'--input-preview-height':`${previewHeight}px`} as CSSProperties} data-engine-summary={engine} data-testid="engine-input-preview" data-preview-state={capabilityError?'blocked':draft?'draft':finalText?'ready':'empty'} data-open={open} tabIndex={-1} aria-label={engine==='orca'?'ORCA动态输入预览':'Gaussian动态输入预览'}>
    {open&&<div className="input-preview-resize" role="separator" tabIndex={0} aria-label="调整输入预览高度" title="拖动调整输入预览高度" aria-orientation="horizontal" aria-valuemin={WORKBENCH_PANE_LIMITS.previewHeight.min} aria-valuemax={WORKBENCH_PANE_LIMITS.previewHeight.max} aria-valuenow={previewHeight}
      onPointerDown={event=>{event.preventDefault();resizeStart.current={y:event.clientY,height:previewHeight};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId)&&resizeStart.current)resize(resizeStart.current.height+resizeStart.current.y-event.clientY);}}
      onPointerUp={event=>{resizeStart.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onPointerCancel={event=>{resizeStart.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onKeyDown={event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();resize(previewHeight+(event.key==='ArrowUp'?20:-20));}}}/>}
    <header className="shared-input-card-header"><button type="button" className="text-button input-preview-toggle shared-input-action" aria-expanded={open} onClick={()=>setOpen(!open)}><Code2 size={14}/><span>输入预览</span><ChevronDown size={13}/></button>{minimum&&<span data-testid="orca-common-minimum" title={compatibility?.reasons.join(' ')}>{minimum}</span>}</header>
    {open&&<><div className="input-preview-controls"><InputSettingsCheckbox ariaLabel="折叠预览坐标" label="折叠坐标" checked={foldCoordinates} onChange={onFoldCoordinates}/>{engine==='orca'&&files.length>1&&<select aria-label="ORCA预览文件" value={index<files.length?index:0} onChange={event=>setIndex(Number(event.target.value))}>{files.map((entry,i)=><option key={entry.name} value={i}>{entry.name}</option>)}</select>}</div>
      <code className="route-preview full-input-preview" aria-label={engine==='orca'?'完整ORCA输入预览':'完整Gaussian输入预览'}>{preview||(capabilityError?'当前设置不可生成输入，请处理上述问题。':'补齐参数后显示完整输入')}</code>
    </>}
  </section>;
}
