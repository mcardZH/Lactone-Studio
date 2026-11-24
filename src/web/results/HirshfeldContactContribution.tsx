import {DismissibleNotice} from '../DismissibleNotice';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { HirshfeldContactRow } from '../../results/hirshfeld-contracts';
import { hirshfeldContactKey, hirshfeldContactLabel, type HirshfeldContactFocus } from '../../results/hirshfeld-presentation';
import { formatResultValue, type ResultNumberFormat } from '../../results/numeric-format';
import { useScientificPlotSize } from './ScientificPlotSize';
import { ScientificPlotExportMenu } from './ScientificPlotExportMenu';
import { ScientificImageCopyButton } from '../ScientificImageCopyButton';
import { exportBlob } from './export-image';
import { captureScientificSvgPng, serializeOptimizationSvg } from './optimization-export';
import { plotFontFamily, plotPt, usePlotAppearance, usePlotFont } from './ScientificPlotSettings';
import type {PlotFigureEdits, PlotFontRole, PlotPosition} from '../../results/scientific-plot-editing';
import {PlotEditorToolbar, PlotInspector, PlotPresetControls, PlotQuickControls, PlotQuickPopover, canRemovePlotTarget, type PlotTarget} from './ScientificPlotEditor';
import {applyPlotPreset, fallbackPlotStyle, plotPresetSnapshot, plotTextInput, usePlotFigure, usePlotPresetLibrary} from './scientific-plot-figure';
import {plotEditorPane, plotMapping} from './plot-editor-pane';
import {plotGeometry} from './ScientificPlotDrawing';
import {targetFromPlotHit, usePlotGestures} from './use-plot-gestures';
import {PlotSettingsWindow} from './VisualizationPresetDialog';
import './OptimizationPlot.css';

// fig-272's Spectral sequence, including both endpoint colors.
const defaultColors = ['#9e0142', '#d53e4f', '#f46d43', '#fdae61', '#fee08b', '#e6f598', '#abdda4', '#66c2a5', '#3288bd', '#5e4fa2'];
function contactColor(index: number, count: number, colors: readonly string[]) {
  const position = count <= 1 ? 0 : index / (count - 1) * (colors.length - 1), left = Math.floor(position), right = Math.min(colors.length - 1, left + 1), fraction = position - left;
  const channels = [1, 3, 5].map(offset => Math.round(parseInt(colors[left].slice(offset, offset + 2), 16) * (1 - fraction) + parseInt(colors[right].slice(offset, offset + 2), 16) * fraction));
  return '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('');
}
const wrapLabel = (text: string, width: number, fontSize: number) => {
  const lines: string[] = []; let line = '', used = 0;
  for (const char of text) { const advance = /[^\u0000-\u00ff]/u.test(char) ? fontSize : fontSize * .6; if (line && used + advance > width) { lines.push(line); line = ''; used = 0; } line += char; used += advance; }
  if (line || !lines.length) lines.push(line); return lines;
};
/** Native whole-surface percentages, without rounding to 100 or regrouping tiny contacts. */
export default function HirshfeldContactContribution({ rows, merged, decimals, numberFormat, onContact, appearanceKey, embeddedPresetEditor = false }: {
  rows: readonly HirshfeldContactRow[]; merged: boolean; decimals: number; onContact?(value: HirshfeldContactFocus): void;
  numberFormat?: ResultNumberFormat;
  appearanceKey?: string; embeddedPresetEditor?: boolean;
}) {
  const key=appearanceKey??`hirshfeld-contact:${merged}`;
  const a = usePlotAppearance(key);
  const library = usePlotPresetLibrary('contact'), initialStyle = fallbackPlotStyle(library,a.stored);
  const record = usePlotFigure(key,{style:initialStyle,presetId:library.defaultId});
  const plot = useScientificPlotSize(key,record), stage=useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), [error, setError] = useState('');
  const assignStage = useRef((node:HTMLDivElement|null)=>{stage.current=node;plot.stageRef(node);});
  const [advanced,setAdvanced]=useState(false), [panel,setPanel]=useState<'text'|'canvas'|'series'>('series');
  const [draft,setDraft]=useState<PlotFigureEdits>();
  const [quick,setQuick]=useState<{target:PlotTarget; anchor:PlotPosition}>();
  const [hover,setHover]=useState<{id:string; anchor:PlotPosition}>();
  usePlotFont(svg.current?.ownerDocument);
  const figure = draft??record.figure, style=figure.style??initialStyle;
  const palette = style.contactColors?.length ? style.contactColors : defaultColors;
  const percentLabel = (value: number) => `${numberFormat ? formatResultValue(value, decimals, numberFormat) : value.toFixed(decimals)}%`;
  const edit = (change:Partial<PlotFigureEdits>,group?:string) => record.replace(previous=>({...previous,...change}),group);
  const positive = rows.filter(row => row.area > 0 && Number.isFinite(row.area) && Number.isFinite(row.nativePercent));
  const width = Math.max(220,style.canvas.width*96/25.4);
  const title = a.stored.title??'Hirshfeld Contact Contributions', legendSize=plotPt(figure.text?.legend?.font?.size??style.fonts.legend.size);
  const names = positive.map(row => ({ id: hirshfeldContactKey(row.insideElement, row.outsideElement, merged), label: hirshfeldContactLabel({ ...row, merged }) }));
  const showLegend=figure.showLegend??style.showLegend;
  const legendX = width * .64, labelWidth = Math.max(18, width - legendX - 36);
  const entries = positive.map((row, index) => {
    const {id}=names[index];
    const focus = { insideElement: row.insideElement, outsideElement: row.outsideElement, merged };
    const label = figure.text?.[`legend:${id}`]?.content??a.name(id,names[index].label);
    const percentage = percentLabel(row.nativePercent);
    // Narrow figures move numerical labels to the legend before they cross the hole.
    const small = row.nativePercent < 4 || percentage.length * legendSize * .6 > (width * .29 - 14) * .48;
    return { id, row, focus, label, percentage, small, color:figure.series?.[id]?.color??contactColor(index,positive.length,palette),
      lines:wrapLabel(small ? `${label}  ${percentage}` : label,labelWidth,legendSize)};
  });
  const lineHeight=legendSize*1.35, entryHeights=entries.map(entry=>entry.lines.length*lineHeight+5);
  const legendHeight=showLegend?entryHeights.reduce((sum,value)=>sum+value,0):0;
  const height=Math.max(width*style.canvas.height/style.canvas.width,legendHeight+60);
  const cx=width*(showLegend?.30:.50), cy=height/2+10;
  const radius=Math.max(15,Math.min(width*(showLegend?.29:.43)-14,(height-75)/2)), inner=radius*.5;
  const totalPercent = positive.reduce((sum, row) => sum + row.nativePercent, 0);
  let angle = -Math.PI / 2, legendY = Math.max(54, cy - legendHeight / 2);
  const slices = entries.map((entry, index) => { const start = angle; angle += entry.row.nativePercent / 100 * Math.PI * 2;
    const result = { ...entry, start, end: angle, mid: (start + angle) / 2, legendY }; legendY += entryHeights[index]; return result; });
  const range:{x:[number,number];y:[number,number]}={x:[0,1],y:[0,1]};
  const geometry=plotGeometry({width,height,range,title,yLabel:'',style,edits:figure,editable:true,reverseX:false,reverseY:false});
  const context=plotEditorPane({pane:figure,style,range,axisKey:'ring',mapping:plotMapping(),titles:{title,x:'',y:''},
    series:slices.map(slice=>({id:slice.id,label:slice.label,color:slice.color,points:[]})), edit,
    endEdit:record.endGroup,onTarget:target=>setQuick({target,anchor:{x:24,y:24}}),onDismiss:()=>setQuick(undefined),canAnnotate:false});
  const textDefaults=Object.fromEntries(Object.entries(context.textDefaults).filter(([id])=>!['x','y','ticks','annotation'].includes(id)));
  const textContext={...context,textDefaults};
  const snapshot=plotPresetSnapshot(entries.some(entry=>figure.series?.[entry.id]?.color)
    ? {...style, contactColors:entries.map(entry=>entry.color)}
    : style,figure);
  const choose=(id:string,saved?:typeof style)=>edit(saved ? {presetId:id} : applyPlotPreset(figure,id,library.style(id)));
  const keyboard=(event:KeyboardEvent)=>{
    if (plotTextInput(event.target)||!(event.ctrlKey||event.metaKey))return;
    const key=event.key.toLowerCase();
    if(key!=='z'&&key!=='y')return;
    event.preventDefault();event.stopPropagation();
    if(key==='y'||event.shiftKey)record.redo();else record.undo();
  };
  const location=({clientX,clientY}:{clientX:number;clientY:number})=>{
    const rect=stage.current?.getBoundingClientRect();
    return {x:clientX-(rect?.left??0),y:clientY-(rect?.top??0)};
  };
  const gesture=usePlotGestures({figure:record.figure,stage,main:{context:textContext,geometry,axisKey:'ring',offset:{x:0,y:0}},
    makeInset:false,location,preview:setDraft,commit:record.replace,zoom:()=>{},
    select(hit){const slice=hit.kind==='slice'?slices.find(item=>item.id===hit.key):undefined;if(slice)onContact?.(slice.focus);},
    hover(hit,anchor){if(hit.kind==='slice')setHover({id:hit.key,anchor});else setHover(undefined);},
    inspect(hit,anchor){
      setHover(undefined);
      const target=hit.kind==='slice'?{kind:'line' as const,id:hit.key}:targetFromPlotHit(hit);
      if(target)setQuick({target,anchor});
    },
  });
  const paperPosition={x:(figure.position?.x??0)*width,y:(figure.position?.y??0)*height};
  const text = (id:string,content:string,role:PlotFontRole,x:number,y:number) => {
    const note=figure.text?.[id];
    if(note?.hidden)return null;
    const font={...style.fonts[role],...note?.font};
    return <text key={id} x={x+(note?.position?.x??0)*width} y={y+(note?.position?.y??0)*height}
      textAnchor="middle" fill="#000" fontFamily={plotFontFamily(font.font)} fontSize={plotPt(font.size)}
      fontWeight={font.bold?'bold':'normal'} fontStyle={font.italic?'italic':'normal'} data-plot-hit="text" data-plot-key={id}>
      {note?.content??content}</text>;
  };
  const setColor=(id:string,color:string)=>edit({series:{...figure.series,[id]:{...(figure.series?.[id]??style.line),color}}},`slice-color:${id}`);
  const quickTarget=quick?.target;
  const selectedSlice=quickTarget?.kind==='line'?slices.find(slice=>slice.id===quickTarget.id):undefined;
  const hovered=hover&&slices.find(slice=>slice.id===hover.id);
  const capturePng = (owner: Document, signal?: AbortSignal) => captureScientificSvgPng(svg.current, owner, signal);
  const exportChart = async (kind: 'svg' | 'png' | 'txt') => { const node = svg.current; if (!node) return; try {
    const txt = () => [['inside','outside','area_A2','native_percent'],
      ...rows.map(row=>[row.insideElement,row.outsideElement,row.area,row.nativePercent])].map(row=>row.join('\t')).join('\n')+'\n';
    const blob = kind==='png' ? await capturePng(node.ownerDocument)
      : kind==='svg'?new Blob([serializeOptimizationSvg(node)],{type:'image/svg+xml;charset=utf-8'}):new Blob([txt()],{type:'text/plain;charset=utf-8'});
    exportBlob(blob, `Ester-Studio-hirshfeld-contributions.${kind}`, node.ownerDocument); setError('');
  } catch (value) { setError(String(value instanceof Error ? value.message : value)); } };
  const closeQuick=()=>setQuick(undefined);
  const legendPosition=figure.text?.legend?.position;
  const art = <div className="scientific-plot hirshfeld-contribution-plot" onKeyDown={keyboard}>
    {error && <DismissibleNotice>{error}</DismissibleNotice>}<div ref={assignStage.current} className="scientific-plot-stage" style={plot.style(Math.round(plot.width*height/width))}>
      <svg ref={svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="scientific-plot-svg is-editable"
        role="img" tabIndex={0} aria-label="原生接触面积贡献图" fontFamily={plotFontFamily(style.fonts.legend.font)}
        onContextMenu={gesture.contextMenu} onPointerDown={gesture.start} onPointerMove={gesture.move}
        onPointerUp={event=>gesture.finish(event)} onPointerCancel={event=>gesture.finish(event,true)}
        onLostPointerCapture={event=>gesture.finish(event,true)} onPointerLeave={()=>setHover(undefined)}>
        <rect width={width} height={height} fill="white"/>
        <metadata>{JSON.stringify({ method:'native-area', merged, rows, appearance:style })}</metadata>
        <g data-plot-part="main" transform={`translate(${paperPosition.x},${paperPosition.y})`}>
        {text('title',title,'title',width/2,30)}
        {slices.map(slice => { const { id,start,end,mid,color,focus,label,percentage,small } = slice;
          const point = (r: number, theta: number) => `${cx + r * Math.cos(theta)} ${cy + r * Math.sin(theta)}`;
          const full = end - start >= Math.PI * 2 - 1e-9;
          const d = full ? `M ${point(radius, start)} A ${radius} ${radius} 0 1 1 ${point(radius, start + Math.PI)} A ${radius} ${radius} 0 1 1 ${point(radius, end)} L ${point(inner, end)} A ${inner} ${inner} 0 1 0 ${point(inner, start + Math.PI)} A ${inner} ${inner} 0 1 0 ${point(inner, start)} Z`
            : `M ${point(radius, start)} A ${radius} ${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${point(radius, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${end - start > Math.PI ? 1 : 0} 0 ${point(inner, start)} Z`;
          return <g key={id} role="button" tabIndex={0} aria-label={`${label} ${percentage}`} data-plot-hit="slice" data-plot-key={id}
            onClick={event=>{if(!event.detail)onContact?.(focus);}}
            onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onContact?.(focus);}}} style={{cursor:'pointer'}}>
            <path data-contact-slice={id} d={d} fill={color} stroke={slice.row.nativePercent < 1 ? color : 'white'} strokeWidth={slice.row.nativePercent < 1 ? 0 : 1}/>
            {(!small||!showLegend) && <text x={cx + radius * .75 * Math.cos(mid)} y={cy + radius * .75 * Math.sin(mid)} dominantBaseline="middle" textAnchor="middle" fontSize={legendSize} fill={(() => {
              const [r,g,b]=[1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16));return r*.299+g*.587+b*.114>160?'#000':'#fff';
            })()}>{percentage}</text>}
          </g>;
        })}
        {showLegend&&<g data-plot-series-legend="true" data-plot-hit="legend" transform={`translate(${(legendPosition?.x??0)*width},${(legendPosition?.y??0)*height})`}>
          {slices.map(slice=><g key={slice.id} data-plot-hit="slice" data-plot-key={slice.id} style={{cursor:'pointer'}}>
            <rect x={legendX} y={slice.legendY-legendSize*.8} width={11} height={legendSize*.7} fill={slice.color}/>
            <text x={legendX+18} y={slice.legendY} fontSize={legendSize} fill="#000">{slice.lines.map((line,i)=>
              <tspan x={legendX+18} dy={i?lineHeight:0} key={i}>{line}</tspan>)}</text>
          </g>)}
        </g>}
        <text x={cx} y={cy-legendSize*.2} textAnchor="middle" fontSize={legendSize*1.15} fill="#000">
          <tspan x={cx}>Total</tspan><tspan x={cx} dy={legendSize*1.5}>{percentLabel(totalPercent)}</tspan>
        </text>
        {Object.keys(figure.text??{}).filter(id=>id.startsWith('note:')).map(id=>text(id,'Text','annotation',cx,cy))}
        </g>
      </svg>
      {hovered&&hover&&!quick&&<div className="plot-point-readout" style={{left:hover.anchor.x+8,top:hover.anchor.y+8}}>
        <span>{hovered.label}</span><span>{hovered.percentage}</span><span>{numberFormat ? formatResultValue(hovered.row.area, decimals, numberFormat) : hovered.row.area} Å²</span>
      </div>}
      {quick&&(selectedSlice?<PlotQuickPopover title={selectedSlice.label} anchor={quick.anchor} onClose={closeQuick} endEdit={record.endGroup}>
        <label>扇区颜色 <input aria-label="扇区颜色" type="color" value={selectedSlice.color} onChange={event=>setColor(selectedSlice.id,event.currentTarget.value)}/></label>
      </PlotQuickPopover>:<PlotQuickControls target={quick.target} context={textContext} anchor={quick.anchor}
        onClose={closeQuick} remove={quickTarget?.kind==='text'&&canRemovePlotTarget(quickTarget)?()=>textContext.removeText(quickTarget.id):undefined}/>)}
    </div>
    <div className="optimization-plot-options scientific-plot-tools scientific-plot-actions" aria-label="图像操作">
      <button type="button" onClick={()=>edit({position:undefined,frame:undefined,text:Object.fromEntries(Object.entries(figure.text??{}).map(([id,note])=>[id,{...note,position:undefined}]))})}>恢复布局</button>
      <button type="button" onClick={context.insertText}>插入文字</button>
      <label><input type="checkbox" checked={showLegend} onChange={event=>edit({showLegend:event.currentTarget.checked})}/>显示图例</label>
      <button type="button" disabled={!record.canUndo} onClick={record.undo}>撤销</button>
      <button type="button" disabled={!record.canRedo} onClick={record.redo}>重做</button>
      <ScientificImageCopyButton resetKey={appearanceKey} disabled={!positive.length} capture={capturePng}/>
      <ScientificPlotExportMenu options={(['svg','png','txt'] as const).map(kind=>({key:kind,label:kind.toUpperCase(),run:()=>{void exportChart(kind);}}))}/>
    </div>
  </div>;
  const sidebar=<>
    <PlotPresetControls library={library} active={figure.presetId} style={snapshot} onChoose={choose}/>
    <nav className="plot-edit-tabs" aria-label="图表设置">
      {([['series','扇区'],['text','文字'],['canvas','画布']] as const).map(([value,label])=>
        <button key={value} type="button" aria-selected={panel===value} onClick={()=>setPanel(value)}>{label}</button>)}
    </nav>
    {panel==='series'?<div className="plot-edit-inspector">{slices.map(slice=><label key={slice.id}>
      {slice.label} <input aria-label={`${slice.label} 颜色`} type="color" value={slice.color} onBlur={record.endGroup}
        onChange={event=>setColor(slice.id,event.currentTarget.value)}/></label>)}</div>:<PlotInspector context={textContext} panel={panel}/>}
  </>;
  if (embeddedPresetEditor) return <div className="plot-preset-dialog-body" onKeyDown={keyboard}>
    <div className="plot-preset-art">{art}</div><aside className="plot-preset-fields">{sidebar}</aside>
  </div>;
  return <>
    <PlotEditorToolbar library={library} active={figure.presetId} style={snapshot} onChoose={choose} onAdvanced={()=>{closeQuick();setAdvanced(true);}}/>
    {advanced?<PlotSettingsWindow category="contact" ownerDocument={svg.current?.ownerDocument} onClose={()=>{setAdvanced(false);closeQuick();}} onKeyDown={keyboard}
      figure={art} sidebar={sidebar}/>:art}
  </>;
}
