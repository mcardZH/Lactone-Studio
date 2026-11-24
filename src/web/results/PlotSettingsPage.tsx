import {useEffect,useState,type ReactNode} from 'react';
import {ProjectUiScope,ProjectUiStore} from '../../projects/ui-state';
import type {HirshfeldContactRow} from '../../results/hirshfeld-contracts';
import {plotEditedViewport,plotStyleForPreset,type PlotFamily,type PlotPaneEdits,type PlotStyle} from '../../results/scientific-plot-editing';
import type {ScientificPlotSeries} from '../../results/scientific-plot';
import {plotDataBounds} from '../../results/scientific-plot';
import {interpolateColor,zeroCenteredFraction} from '../../results/zero-centered-color';
import HirshfeldContactContribution from './HirshfeldContactContribution';
import type {PlotAppearance3DTarget} from './PlotAppearance3D';
import {PlotAppearance3D} from './PlotAppearance3D';
import {plotGeometry, ScientificPlotDrawing} from './ScientificPlotDrawing';
import {plotEditorPane, plotMapping} from './plot-editor-pane';
import {type PlotPanel, PlotInspector, PlotPresetControls, plotPanels} from './ScientificPlotEditor';
import {ScientificScatterPlot,type ScientificScatterPlotProps} from './ScientificScatterPlot';
import {applyPlotPreset,plotPresetSnapshot,usePlotPresetLibrary} from './scientific-plot-figure';

const categories = [
  ['line','点线图','line'], ['uv-vis','UV–Vis','spectrum'], ['ir','红外','spectrum'], ['raman','Raman','spectrum'],
  ['iri','IRI 类散点','scatter'], ['fingerprint','Hirshfeld 指纹','fingerprint'], ['histogram','面积分布与柱形','histogram'],
  ['orbital','轨道能级','orbital'], ['contact','接触面积贡献','contact'],
] as const satisfies readonly (readonly [string,string,PlotFamily])[];

export function plotCategoryLabel(id: string) {
  return categories.find(category => category[0]===id)?.[1] ?? '点线图';
}

const trace = [0,.14,.37,.56,.35,.02,-.21].map((y,index) => ({x:index,y}));
const contactRows: HirshfeldContactRow[] = ([['H','H',51],['H','O',29],['H','C',20]] as const).map(([insideElement,outsideElement,area])=>({
  insideElement,outsideElement,area,nativePercent:area,areaRaw:String(area),percentRaw:String(area),areaPrecision:0,percentPrecision:0,
}));
function scatterSample(fingerprint: boolean): ScientificScatterPlotProps {
  const points=Array.from({length:2100},(_,i)=>{
    const phase=i*2.399963229728653, radius=Math.sqrt((i+.5)/2100);
    const u=radius*Math.cos(phase), v=radius*Math.sin(phase);
    const lobe=i%3;
    return fingerprint
      ? {x:1.84+.62*u+.18*v,y:1.89+.5*u-.31*v,frequency:Math.round(1+749*(1-radius)**2)}
      : {x:[-.029,-.001,.022][lobe]+u*(.004+.011*Math.abs(v)),y:[.41,.18,.49][lobe]+1.42*Math.abs(v)+.1*u,frequency:0};
  });
  const colors=fingerprint?plotStyleForPreset('fingerprint').scatterColors!:['#0000ff','#00ff00','#ff0000'];
  const colorForX=(value:number)=>interpolateColor(fingerprint
    ? Math.max(0,Math.min(1,(value-1)/749)) : zeroCenteredFraction(value,-.04,.02),colors);
  return {
    title:fingerprint?'Hirshfeld Fingerprint':'Interaction Region Indicator',
    xLabel:fingerprint?'dᵢ / Å':'sign(λ₂)ρ / a.u.', yLabel:fingerprint?'dₑ / Å':'IRI',
    data:{x:Float64Array.from(points,point=>point.x),y:Float64Array.from(points,point=>point.y)},colorForX,
    colorLegend:fingerprint
      ? {min:1,max:750,colors,valueForPoint:index=>points[index].frequency}
      : {min:-.04,max:.02,colors,zeroCentered:true},
    colorForPoint:fingerprint?index=>colorForX(points[index].frequency):undefined,
    initialViewport:fingerprint ? {x:[1,2.7],y:[1,2.7]} : {x:[-.06,.04],y:[0,2]},
  };
}
const iriSample = scatterSample(false);
const fingerprintSample = scatterSample(true);

function sampleFor(id: string, family: PlotFamily): {
  title:string; x:string; y:string; series:ScientificPlotSeries[]; sticks?:ScientificPlotSeries; reverseX?:boolean; reverseY?:boolean;
} {
  if (family==='spectrum') {
    const uv=id==='uv-vis', ir=id==='ir', start=uv?220:400, step=uv?2:20;
    const peak=ir?1650:uv?329:1300, secondPeak=peak+(uv?67:840);
    const points=Array.from({length:140},(_,i)=>{
      const x=start+i*step;
      return {x,y:Math.exp(-(((x-peak)/(uv?26:110))**2))+.36*Math.exp(-(((x-secondPeak)/(uv?34:200))**2))};
    });
    return {title:uv?'UV–Vis Absorption Spectrum':ir?'Infrared Spectrum':'Raman Spectrum',
      x:uv?'Wavelength / nm':'Wavenumber / cm⁻¹',y:'Intensity / a.u.',series:[{id:'spectrum',label:'Envelope',points}],
      sticks:{id:'spectrum-sticks',kind:'stick',label:'Transitions',points:[{x:peak,y:1},{x:secondPeak,y:.36}]},
      reverseX:ir,reverseY:ir};
  }
  if (family==='histogram') {
    return {title:'Surface Electrostatic Potential Distribution',x:'Electrostatic Potential / kcal mol⁻¹',y:'Surface Area / Å²',
      series:[{id:'bins',kind:'histogram',points:[1.8,2.6,2.2,1.4,.9,.7,.85,1.3,1.8,1.2].map((y,i)=>({x:-30+i*7,xEnd:-23+i*7,y}))}]};
  }
  if (family==='orbital') {
    return {title:'Frontier Orbital Levels',x:'Orbital',y:'Energy / eV',
      series:[-7.2,-5.5,-4.3,-1.5,.4,1.3].map((y,index)=>({id:`level-${index}`,points:[{x:index<3?.1:.65,y},{x:index<3?.35:.9,y}]}))};
  }
  return {title:'Energy Profile',x:'Reaction Coordinate',y:'Relative Energy / kcal mol⁻¹',series:[{id:'line',points:trace}]};
}

export function PlotSettingsPage({ownerDocument,model,category,editing,slot,connectionKey}:{
  ownerDocument:Document; model?:PlotAppearance3DTarget; category?:string; editing?:boolean; slot?:ReactNode; connectionKey?:number;
}) {
  const [choice,setChoice]=useState('line');
  const [sample,setSample]=useState(false);
  useEffect(()=>setSample(false),[connectionKey]);
  const active=editing&&!sample ? category??'line' : choice;
  const spec=categories.find(item=>item[0]===active);
  const live=Boolean(editing&&!sample);
  return <section className="plot-settings-page" aria-label="绘图设置">
    <div className="plot-settings-navigation">
      {editing&&<button type="button" aria-pressed={live} onClick={()=>setSample(false)}>当前图 · {plotCategoryLabel(category??'line')}</button>}
      <label>图类<select aria-label="图型" value={active} onChange={event=>{setChoice(event.currentTarget.value);setSample(true);}}>
        <optgroup label="2D 数据图">{categories.map(([id,label])=><option key={id} value={id}>{label}</option>)}</optgroup>
        <optgroup label="3D 图"><option value="molecule">分子与晶胞</option><option value="surface">等值面</option></optgroup>
      </select></label>
      {editing&&live&&<button type="button" onClick={()=>{setChoice(active);setSample(true);}}>类别预设</button>}
    </div>
    <div hidden={!live}>{slot}</div>
    {!live&&(spec?<PresetSample key={active} id={active} family={spec[2]}/>
      :<PlotAppearance3D key={active} ownerDocument={ownerDocument} target={model} initialKind={active==='surface'?'surface':'molecule'}/>)}
  </section>;
}

function PresetSample({id,family}:{id:string;family:PlotFamily}) {
  const [store]=useState(()=>new ProjectUiStore());
  if (family==='scatter'||family==='fingerprint') return <ProjectUiScope store={store} scope={['plot-preset-sample',id]}>
    <ScientificScatterPlot {...(family==='scatter'?iriSample:fingerprintSample)} appearanceKey={id} embeddedPresetEditor/>
  </ProjectUiScope>;
  if (family==='contact') return <ProjectUiScope store={store} scope={['plot-preset-sample',id]}>
    <HirshfeldContactContribution rows={contactRows} merged decimals={1} appearanceKey={id} embeddedPresetEditor/>
  </ProjectUiScope>;
  return <CartesianPresetSample id={id} family={family}/>;
}

function CartesianPresetSample({id,family}:{id:string;family:PlotFamily}) {
  const [edits,setEdits]=useState<PlotPaneEdits>({});
  const [panel,setPanel]=useState<PlotPanel>('series');
  const [showSticks,setShowSticks]=useState(false);
  const library=usePlotPresetLibrary(family,family==='spectrum'?id:undefined);
  const style=edits.style??library.style(library.defaultId);
  const example=sampleFor(id,family), spectrum=family==='spectrum';
  const series=showSticks&&example.sticks?[...example.series,example.sticks]:example.series;
  const bounds=plotDataBounds(series)??{x:[0,1],y:[0,1]};
  const range=plotEditedViewport({x:bounds.x,y:family==='histogram'?[0,bounds.y[1]]:bounds.y},edits.coordinates?.sample);
  const width=style.canvas.width*96/25.4, height=style.canvas.height*96/25.4;
  const g=plotGeometry({width,height,range,title:example.title,yLabel:example.y,style,edits,editable:true,
    reverseX:!!example.reverseX,reverseY:!!example.reverseY,squareFrame:width===height,wideFrame:true,
    xStep:edits.coordinates?.sample?.x?.step,yStep:edits.coordinates?.sample?.y?.step});
  const context={...plotEditorPane({pane:edits,series,range,style,axisKey:'sample',mapping:plotMapping(),titles:example,
    edit:change=>setEdits(previous=>({...previous,...change})),endEdit(){},onTarget(){},onDismiss(){},canAnnotate:false}),
    spectrum:spectrum?{hasSticks:!!example.sticks}:undefined};
  function choose(presetId:string,saved?:PlotStyle) {
    setEdits(previous=>({...previous,...(saved ? {presetId} : applyPlotPreset(previous,presetId,library.style(presetId)))}));
  }
  return <div className="plot-preset-dialog-body">
    <div className="plot-preset-art">
      {example.sticks&&<label><input type="checkbox" checked={showSticks} onChange={event=>setShowSticks(event.currentTarget.checked)}/>预览谱棒</label>}
      <svg role="img" aria-label="样式预览" className="plot-preset-sample" viewBox={`0 0 ${g.width} ${g.height}`}>
      <ScientificPlotDrawing id="preset-sample" geometry={g} edits={edits} style={style} title={example.title} range={range}
        xLabel={example.x} yLabel={example.y} series={series} showLegend={context.showLegend} editable={false} part="main"
        spectrum={spectrum} selectionMode={family==='orbital'?'series':'x'} guides={[]}/>
    </svg></div>
    <aside className="plot-preset-fields">
      <PlotPresetControls library={library} active={edits.presetId} onChoose={choose} style={plotPresetSnapshot(style,edits)}/>
      <nav className="plot-edit-tabs" aria-label="预设样式参数">{plotPanels.filter(([key])=>key!=='guides').map(([key,label])=>
        <button key={key} type="button" aria-selected={panel===key} onClick={()=>setPanel(key)}>{label}</button>)}</nav>
      <PlotInspector panel={panel} context={context}/>
    </aside>
  </div>;
}
