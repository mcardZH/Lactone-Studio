import {DismissibleNotice} from '../DismissibleNotice';
import {DEFAULT_ANALYSIS_COLORBAR_LAYOUT,type AnalysisColorbarLayout} from './analysis-colorbar-layout';
import './analysis-colorbar.css';
import type {AnalysisColorbar} from './analysis-display';
import {exportAnalysisColorbar} from './analysis-colorbar-export';
import {useState} from 'react';

export interface AnalysisColorbarLayoutControlsProps {layout?:AnalysisColorbarLayout;onChange(layout:AnalysisColorbarLayout):void;disabled?:boolean;colorbar?:AnalysisColorbar|null}
/** Pure controls for the owning analysis' existing plot-settings surface. */
export default function AnalysisColorbarLayoutControls({onChange,disabled,colorbar}:AnalysisColorbarLayoutControlsProps){
  const [error,setError]=useState('');
  const save=(format:'svg'|'png',doc:Document)=>{if(colorbar)void exportAnalysisColorbar(colorbar,format,doc).catch(cause=>setError(cause instanceof Error?cause.message:String(cause)));};
  return <div className="analysis-colorbar-layout-controls">
    <button type="button" disabled={disabled} onClick={()=>onChange({...DEFAULT_ANALYSIS_COLORBAR_LAYOUT})}>重置色标</button>
    {colorbar&&<><button type="button" disabled={disabled} onClick={event=>save('svg',event.currentTarget.ownerDocument)}>导出色标 SVG</button><button type="button" disabled={disabled} onClick={event=>save('png',event.currentTarget.ownerDocument)}>导出透明色标 PNG</button></>}
    {error&&<DismissibleNotice role="alert">{error}</DismissibleNotice>}
  </div>;
}
