import {EV_NM} from '../../results/spectroscopy';
import {displayPlotValue, inheritedPlotFont, plotCoordinateRange, plotPointKey, sourcePlotValue, type PlotAxis,
  type PlotAxisEdits, type PlotAxisTransforms, type PlotGuide, type PlotNote, type PlotPaneEdits, type PlotPointStyle, type PlotPosition, type PlotSeriesStyle,type PlotStyle} from '../../results/scientific-plot-editing';
import type {ScientificPlotPoint, ScientificPlotSeries, ScientificPlotViewport} from '../../results/scientific-plot';
import {resolvePlotSeriesStyle} from './ScientificPlotDrawing';
import type {PlotEditorContext, PlotTarget} from './ScientificPlotEditor';
import type {PlotEdit,PlotPartCapabilities} from './results-mcp-context';
import {objectSchema} from '../mcp/types';

const origin: PlotGuide = {id: 'zero', axis: 'y', value: 0, followsZero: true};
export const insetCoordinateKey = 'inset';

export function plotMapping(transforms?: PlotAxisTransforms, spectralUnit?: string) {
  const convert = (axis: PlotAxis, value: number, inverse: boolean) => axis === 'x' && spectralUnit === 'nm'
    ? EV_NM / value : inverse ? sourcePlotValue(value, transforms?.[axis]) : displayPlotValue(value, transforms?.[axis]);
  const sourceValue = (axis: PlotAxis, v: number) => convert(axis, v, true);
  const displayValue = (axis: PlotAxis, v: number) => convert(axis, v, false);
  const viewport = (range: ScientificPlotViewport, inverse = false) => ({
    x: plotCoordinateRange(range.x, v => convert('x', v, inverse)),
    y: plotCoordinateRange(range.y, v => convert('y', v, inverse)),
  });
  return {sourceValue, displayValue, viewport,
    stepValue: (axis: PlotAxis, value: number) => value / Math.abs(transforms?.[axis]?.scale ?? 1),
    displayStep: (axis: PlotAxis, value: number) => value * Math.abs(transforms?.[axis]?.scale ?? 1)};
}

export function setPlotSeriesStyle(context:PlotEditorContext,id:string,patch:Partial<PlotSeriesStyle>,group?:string) {
  const primary=context.series[0],line=context.seriesStyle(id);
  context.edit(id===primary?.id&&!primary.pointLabels?{style:{...context.style,line:{...line,...patch}}}
    :{series:{...context.pane.series,[id]:{...line,...patch}}},group);
}

export function setPlotPointStyle(context:PlotEditorContext,id:string,patch:Partial<PlotPointStyle>,pointId?:string,group?:string) {
  const series=context.seriesStyle(id).point,point=pointId?context.pane.points?.[pointId]??series:series;
  const value={...point,...patch,...(context.scatterOpacity!==undefined&&patch.fillColor!==undefined?{fillOverride:true}:{}),
    ...(context.scatterOpacity!==undefined&&patch.edgeColor!==undefined?{edgeOverride:true}:{})};
  if(pointId)context.edit({points:{...context.pane.points,[pointId]:value}},group);
  else setPlotSeriesStyle(context,id,{point:value},group);
}

const pointStyleAvailable=(context:PlotEditorContext,series:ScientificPlotSeries)=>!series.pointLabels&&!context.spectrum&&series.kind!=='histogram';

function removablePlotTextIds(context:PlotEditorContext,textIds:readonly string[]) {
  return textIds.filter(id=>{
    if(id==='ticks'||id==='annotation'&&!context.canAnnotate||context.pane.text?.[id]?.hidden)return false;
    if(id.startsWith('guide:'))return context.guides.some(guide=>guide.id===id.slice(6)&&!!guide.label);
    return true;
  });
}

export function plotPartCapabilities(context:PlotEditorContext,scatterPointCount?:number):PlotPartCapabilities {
  const series=context.series.map(item=>({id:item.id,label:item.label,pointCount:scatterPointCount??item.points.length,
    lineStyle:context.scatterOpacity===undefined,pointStyle:pointStyleAvailable(context,item)}));
  const guideIds=context.guides.map(guide=>guide.id);
  const editOperations:PlotEdit['operation'][]=['text','font','insert-text','edit-text','move-figure','axis-range','axis-step','axes-style','legend','add-guide','undo','redo'];
  if(guideIds.length)editOperations.push('edit-guide','remove-guide');
  const textIds=[...new Set(['ticks',...Object.keys(context.textDefaults),...Object.keys(context.pane.text??{})])];
  const removableTextIds=removablePlotTextIds(context,textIds);
  if(removableTextIds.length)editOperations.push('remove-text');
  if(series.some(item=>item.lineStyle))editOperations.push('series-style');
  if(series.some(item=>item.pointStyle))editOperations.push('point-style');
  return {series,guideIds,editOperations,textIds,removableTextIds};
}

export function setPlotCanvas(context:PlotEditorContext,patch:Partial<PlotStyle['canvas']>,group?:string) {
  const before=context.style.canvas,canvas={...before,...patch};
  if(canvas.locked&&patch.width!==undefined&&patch.height===undefined)canvas.height=patch.width*(before.height/before.width);
  if(canvas.locked&&patch.height!==undefined&&patch.width===undefined)canvas.width=patch.height*(before.width/before.height);
  context.edit({style:{...context.style,canvas}},group);
}

export function plotCanvasConfiguration(context:PlotEditorContext,assertCurrent:()=>void) {
  return {schema:objectSchema({width:{type:'number',minimum:.1},height:{type:'number',minimum:.1},locked:{type:'boolean'},resetLayout:{type:'boolean'}}),
    read:()=>({...context.style.canvas,unit:'mm'}),apply(values:Record<string,unknown>){
      assertCurrent();
      const {resetLayout,...canvas}=values;
      if(resetLayout&&Object.keys(canvas).length)throw new Error('恢复布局请单独调用。');
      if(resetLayout)context.resetLayout();else if(Object.keys(canvas).length)setPlotCanvas(context,canvas);
    }};
}

function insertPlotText(context:Pick<PlotEditorContext,'editText'|'pane'|'style'|'guides'>,text:string,position?:PlotPosition) {
  const id=`note:${crypto.randomUUID()}`;
  context.editText(id,{content:text,font:inheritedPlotFont(context.pane,context.style,context.guides),...(position?{position}:{})});
  return id;
}

export function editCurrentPlot(change:PlotEdit,context:PlotEditorContext,history:{undo():void;redo():void},scatterPointCount?:number) {
  switch(change.operation){
    case 'undo':history.undo();break;
    case 'redo':history.redo();break;
    case 'text':context.editText(change.role,{content:change.text,hidden:false});break;
    case 'insert-text':insertPlotText(context,change.text,change.position);break;
    case 'edit-text':{
      const {textId,text,position}=change;
      if(textId==='ticks'||text!==undefined&&['legend','annotation'].includes(textId))
        throw new Error('当前文字对象不支持此内容或位置编辑。');
      context.editText(textId,{...(text!==undefined?{content:text}:{}),...(position!==undefined?{position:position??undefined}:{})});
      break;
    }
    case 'remove-text':{
      const known=Object.hasOwn(context.pane.text??{},change.textId)||Object.hasOwn(context.textDefaults,change.textId);
      if(!known||!removablePlotTextIds(context,[change.textId]).length)throw new Error('请选择当前图面可移除的文字。');
      context.removeText(change.textId);break;
    }
    case 'move-figure':context.edit({position:change.position??undefined});break;
    case 'legend':context.edit({showLegend:change.visible});break;
    case 'axis-range':{
      const {axis}=change;
      const bounds=change.bounds?plotCoordinateRange(change.bounds,value=>context.sourceValue(axis,value)):undefined;
      if(bounds&&(!bounds.every(Number.isFinite)||bounds[0]>=bounds[1]))throw new Error('所选坐标范围无法映射到当前数据单位。');
      context.setCoordinates({...context.coordinates,[axis]:{...context.coordinates[axis],bounds}});
      break;
    }
    case 'axis-step':{
      const {axis}=change,step=change.step===null?undefined:context.stepValue(axis,change.step);
      if(step!==undefined&&(!Number.isFinite(step)||step<=0))throw new Error('主刻度间隔无法映射到当前数据单位。');
      context.setCoordinates({...context.coordinates,[axis]:{...context.coordinates[axis],step}});
      break;
    }
    case 'axes-style':{
      const {tickNumbers,tickSides,...patch}=change.patch;
      context.edit({style:{...context.style,axis:{...context.style.axis,...patch,
        ...(tickNumbers?{tickNumbers:{...context.style.axis.tickNumbers,...tickNumbers}}:{}),
        ...(tickSides?{tickSides:{...context.style.axis.tickSides,...tickSides}}:{})}}});
      break;
    }
    case 'series-style':{
      const series=context.series.find(item=>item.id===change.seriesId);
      if(!series||context.scatterOpacity!==undefined)throw new Error('当前图面没有此可编辑曲线或柱形系列。');
      setPlotSeriesStyle(context,series.id,change.patch);
      break;
    }
    case 'point-style':{
      const series=context.series.find(item=>item.id===change.seriesId),index=change.pointIndex;
      if(!series||!pointStyleAvailable(context,series))throw new Error('当前系列没有可编辑点样式。');
      if(index!==undefined&&index>=(scatterPointCount??series.points.length))throw new Error('点序号超出当前系列。');
      setPlotPointStyle(context,series.id,change.patch,index===undefined?undefined:plotPointKey(series.id,index));
      break;
    }
    case 'font':{
      const {textId}=change;
      const guide=textId.startsWith('guide:')?context.guides.find(item=>item.id===textId.slice(6)):undefined;
      const note=guide?guide.label:context.pane.text?.[textId];
      if(!note&&!guide&&!Object.hasOwn(context.textDefaults,textId)&&textId!=='ticks')throw new Error('当前图面没有这个文字对象。');
      context.editText(textId,{font:{...note?.font,...change.patch}});
      break;
    }
    case 'add-guide':{
      const value=context.sourceValue(change.axis,change.value);
      if(!Number.isFinite(value))throw new Error('参考线坐标无法映射到当前数据单位。');
      context.writeGuide({id:crypto.randomUUID(),axis:change.axis,value,...(change.label===undefined?{}:{label:{content:change.label}}),
        ...(change.stroke?{stroke:change.stroke}:{})});
      break;
    }
    case 'remove-guide':{
      if(!context.guides.some(guide=>guide.id===change.guideId))throw new Error('当前绘图坐标下没有这条参考线。');
      context.removeGuide(change.guideId);
      break;
    }
    case 'edit-guide':{
      const guide=context.guides.find(item=>item.id===change.guideId);
      if(!guide)throw new Error('当前绘图坐标下没有这条参考线。');
      const {value,label,...stroke}=change.patch;
      const coordinate=value===undefined?guide.value:context.sourceValue(guide.axis,value);
      if(!Number.isFinite(coordinate))throw new Error('参考线坐标无法映射到当前数据单位。');
      context.writeGuide({...guide,value:coordinate,...(value!==undefined?{followsZero:false}:{}),
        ...(label!==undefined?{label:label===null?undefined:{...guide.label,content:label}}:{}),
        ...(Object.keys(stroke).length?{stroke:{...guide.stroke,...stroke}}:{})});
      break;
    }
  }
}

export function plotGuides(pane: PlotPaneEdits, style: PlotStyle, axis: PlotAxisEdits) {
  const showZero = pane.showZero ?? style.showZero;
  const items = (axis.guides ?? []).filter(item => item.id !== origin.id || showZero);
  return showZero && !items.some(item => item.id === origin.id) ? [origin, ...items] : items;
}

export function withPlotGuide(pane: PlotPaneEdits, axisKey: string, guide: PlotGuide): Partial<PlotPaneEdits> {
  const state = pane.coordinates?.[axisKey] ?? {}, guides = state.guides ?? [];
  const next = guides.some(item => item.id === guide.id) ? guides.map(item => item.id === guide.id ? guide : item) : [...guides, guide];
  return {coordinates: {...pane.coordinates, [axisKey]: {...state, guides: next}}};
}

export function plotEditorPane({pane, style, range, axisKey, mapping, titles, series, peaks, edit, endEdit, onAxisEdit, onTarget, onDismiss,
  canAnnotate, legacyNames}: {
  pane: PlotPaneEdits; style: PlotStyle; range: ScientificPlotViewport; axisKey: string; mapping: ReturnType<typeof plotMapping>;
  titles: {title: string; x: string; y: string; secondary?: string}; series: readonly ScientificPlotSeries[]; peaks?: readonly ScientificPlotPoint[];
  edit(change: Partial<PlotPaneEdits>, group?: string): void;
  endEdit(): void; onAxisEdit?(): void; onTarget(target: PlotTarget): void; onDismiss(target: PlotTarget): void; canAnnotate: boolean; legacyNames?: Record<string, string>;
}): PlotEditorContext {
  const coordinates = pane.coordinates?.[axisKey] ?? {}, guides = plotGuides(pane, style, coordinates);
  const textDefaults: PlotEditorContext['textDefaults'] = {
    title: {content: titles.title, role: 'title', label: '图标题'},
    x: {content: titles.x, role: 'x', label: 'X 轴名'}, y: {content: titles.y, role: 'y', label: 'Y 轴名'},
    legend: {content: '', role: 'legend', label: '图例'}, annotation: {content: '', role: 'annotation', label: '帧／峰标注'},
    ...(titles.secondary ? {'secondary-y': {content: titles.secondary, role: 'y', label: '右轴名称'}} : {}),
    ...Object.fromEntries(series.map(line => [`legend:${line.id}`, {content: legacyNames?.[line.id] ?? line.label ?? line.id, role: 'legend', label: line.label ?? line.id}])),
    ...Object.fromEntries(series.flatMap(line => line.points.flatMap((point, row) => {
      if (!point.markerLabel && line.kind !== 'stick') return [];
      const id = `peak:${plotPointKey(line.id, row)}`;
      const authored = !point.markerLabel && pane.text?.[id]?.content !== undefined;
      if (!point.markerLabel && !authored) return [];
      const content = point.markerLabel ?? point.label ?? String(point.x);
      return [[id, {content, label: point.markerLabel ?? point.label ?? '峰', role: 'annotation', authored}]];
    }))),
    ...Object.fromEntries((peaks ?? []).flatMap((point, row) => series[0] && pane.text?.[`peak:${plotPointKey(series[0].id, row)}`]
      ? [[`peak:${plotPointKey(series[0].id, row)}`, {content: point.label ?? String(point.x), label: point.label ?? '峰', role: 'annotation', authored: true}]] : [])),
    ...Object.fromEntries(guides.map(guide => {
      const value = guide.followsZero ? 0 : mapping.displayValue(guide.axis, guide.value);
      return [`guide:${guide.id}`, {content: `${guide.axis} = ${Number(value.toPrecision(8))}`, role: 'annotation', label: '参考线标签'}];
    })),
  };
  const inGuide = (id: string) => id.startsWith('guide:') ? guides.find(guide => guide.id === id.slice(6)) : undefined;
  function editText(id: string, patch: Partial<PlotNote>, group?: string) {
    const guide = inGuide(id);
    if (guide) edit(withPlotGuide(pane, axisKey, {...guide, label: {...guide.label, ...patch}}), group);
    else edit({text: {...pane.text, [id]: {...pane.text?.[id], ...patch}}}, group);
  }
  return {
    pane, style, coordinates, guides, range, series, ...mapping, edit, endEdit, textDefaults, canAnnotate,
    hasZero: pane.showZero ?? style.showZero, showLegend: pane.showLegend ?? style.showLegend,
    guideFont: () => inheritedPlotFont(pane, style, guides, true),
    setCoordinates(next, group) {
      edit({coordinates: {...pane.coordinates, [axisKey]: next}}, group);
      onAxisEdit?.();
    },
    writeGuide(guide, group) { edit(withPlotGuide(pane, axisKey, guide), group); },
    removeGuide(id) {
      edit({coordinates: {...pane.coordinates, [axisKey]: {...coordinates, guides: (coordinates.guides ?? []).filter(item => item.id !== id)}},
        ...(id === origin.id ? {showZero: false} : {})});
      onDismiss({kind:'guide', id});
    },
    insertGuide(axis) {
      const [start, end] = range[axis];
      edit(withPlotGuide(pane, axisKey, {id: crypto.randomUUID(), axis, value: mapping.sourceValue(axis, (start + end) / 2)}));
    },
    editText,
    insertText() {
      const id=insertPlotText({editText,pane,style,guides},'Text');
      onTarget({kind: 'text', id});
    },
    removeText(id) {
      const guide = inGuide(id);
      if (guide) edit(withPlotGuide(pane, axisKey, {...guide, label: undefined}));
      else if (id.startsWith('note:') || textDefaults[id]?.authored) {
        const text = {...pane.text}; delete text[id]; edit({text});
      } else if (id === 'legend') edit({showLegend: false});
      else if (id !== 'ticks') editText(id, {hidden: true});
      onDismiss({kind:'text', id});
    },
    seriesStyle(id) {
      const line = series.find(item => item.id === id);
      return line ? resolvePlotSeriesStyle(line, series, style, pane, true) : style.line;
    },
    resetLayout() {
      const text = Object.fromEntries(Object.entries(pane.text ?? {}).map(([id, note]) => [id, {...note, position: undefined}]));
      const clean = coordinates.guides?.map(item => item.label ? {...item, label: {...item.label, position: undefined}} : item);
      edit({frame: undefined, position: undefined, text, coordinates: {...pane.coordinates, [axisKey]: {...coordinates, guides: clean}}});
    },
  };
}
