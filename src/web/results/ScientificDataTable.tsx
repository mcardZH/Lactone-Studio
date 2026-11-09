import { useEffect, useRef, useState, type HTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Pin } from 'lucide-react';
import {ProjectUiScope,useProjectState,useProjectUiScope} from '../../projects/ui-state';
import { LegacyScientificDataTable } from './LegacyScientificDataTable';
import { exportBlob } from './export-image';
import { scientificTableCellEdges, scientificTableCellSelected, scientificTableColumnSelected, scientificTableText, scientificTableDefaultWidths, scientificTableRetainedWidths, type ScientificTableColumn, type ScientificTableProjection, type ScientificTableRow, type TableCellAddress, type TableSelection, type ScientificTableFormat, type ScientificTableLayoutState } from './scientific-table';
import ScientificTableToolbar from './ScientificTableToolbar';
import { scientificTableHeader, type ScientificTableSorting } from './scientific-table';
import './ScientificDataTable.css';

// Keep immutable table inputs/JSX stable across local layout and scroll writes.
// The cache is per mounted table; source/selection/owner changes are explicit
// dependencies, rather than comparing or serializing every cell on each move.
function useTableValue<T>(create:()=>T,dependencies:readonly unknown[]):T {
  const cache=useRef<{dependencies:readonly unknown[];value:T}|null>(null);
  if(!cache.current||dependencies.length!==cache.current.dependencies.length||dependencies.some((value,index)=>!Object.is(value,cache.current!.dependencies[index])))cache.current={dependencies,value:create()};
  return cache.current.value;
}

export interface ScientificTableRowAction {
  label: string | ((row: ScientificTableRow) => string);
  text?: string | ((row: ScientificTableRow) => string);
  onActivate(row: ScientificTableRow): void;
  active?(row: ScientificTableRow): boolean;
  available?(row: ScientificTableRow): boolean;
  kind?: 'pin' | 'select' | 'checkbox' | 'visibility';
}
export interface ScientificDataTableProps {
  variant?: 'numeric' | 'legacy';
  title?: string;
  /** The surrounding result card already supplies its title. */
  hideTitle?: boolean;
  onExport?(): void;
  exportFileName?: string;
  expansion?: { expanded: boolean; onToggle(): void };
  onRowPreview?(row: ScientificTableRow | null): void;
  /** Clears consumer-owned transient state on row leave, blank/outside clicks or Escape; callers preserve pins and persistent scientific selections. */
  onClearActive?(): void;
  projection: ScientificTableProjection;
  /** Scientific source/job/frame identity; display precision is not part of it. */
  selectionScope?: string;
  /** Long metric names wrap; the default comparison layout keeps compact identifiers. */
  layout?: 'comparison' | 'metrics';
  activeColumn?: string;
  rowBindings?(row: ScientificTableRow): HTMLAttributes<HTMLTableRowElement>;
  /** Scientific actions are separate from copying and excluded from the data projection. */
  rowAction?: ScientificTableRowAction;
  rowActions?: readonly ScientificTableRowAction[];
  renderHeader?(column: ScientificTableColumn): ReactNode;
  onRowActivate?(row: ScientificTableRow): void;
  activeRowKey?: string;
  /** Explicit external navigation (e.g. a spectrum click), independent of current/copy state. */
  revealRow?: { key: string; requestId: number };
  format?: ScientificTableFormat;
  sorting?: ScientificTableSorting;
  layoutState?: ScientificTableLayoutState;
  /** Display-only starting minima; saved/user-sized columns keep their widths. */
  initialColumnMinWidths?: readonly number[];
  /** Opt in to each column's natural content width. Retained manual widths win. */
  numericColumnWidths?: 'uniform' | 'content';
  onLayoutChange?(value: ScientificTableLayoutState): void;
}
/** Numeric tables render every expanded row; the explicit legacy variant keeps
 * the previous orbital/Hirshfeld presentation and interactions. */
export function ScientificDataTable(props: ScientificDataTableProps) {
  const project=useProjectUiScope();
  if(!project)return props.variant==='legacy'?<LegacyScientificDataTable {...props}/>:<NumericScientificDataTable {...props}/>;
  return <ProjectUiScope scope={['table',props.selectionScope??props.exportFileName??props.title??props.format?.ariaLabel??'table']}>
    {props.variant === 'legacy' ? <LegacyScientificDataTable {...props}/> : <NumericScientificDataTable {...props}/>}
  </ProjectUiScope>;
}
export function NumericScientificDataTable({ title, hideTitle, onExport, exportFileName, expansion, onRowPreview, onClearActive, projection, selectionScope, layout = 'comparison', rowBindings, rowAction, rowActions, renderHeader, onRowActivate, activeRowKey, revealRow, format, sorting, layoutState, initialColumnMinWidths, numericColumnWidths='uniform', onLayoutChange }: ScientificDataTableProps) {
  const suppliedActions = rowActions ?? (rowAction ? [rowAction] : []);
  const selectAction = suppliedActions.find(action=>action.kind==='select');
  const visibilityAction = suppliedActions.find(action=>action.kind==='visibility');
  const actions = suppliedActions.filter(action=>action.kind!=='select'&&action.kind!=='visibility');
  const actionWidth=(actions.length?actions.length*32:0)+(visibilityAction?48:0);
  const identities=useTableValue(()=>{
    const columnKeys=projection.columns.map(column=>column.key),rowKeys=projection.rows.map(row=>row.key);
    return {columnKeys,signature:JSON.stringify([columnKeys,rowKeys]),sortedRows:JSON.stringify(rowKeys.sort())};
  },[projection.columns,projection.rows]);
  const {owner,highlightOwner,layoutOwner}=useTableValue(()=>({
    owner:JSON.stringify([selectionScope??null,identities.signature]),
    highlightOwner:JSON.stringify([selectionScope??null,JSON.parse(identities.sortedRows)]),
    layoutOwner:selectionScope??identities.sortedRows,
  }),[selectionScope,identities]);
  const [selected, setSelected] = useState<{ owner: string; range: TableSelection } | null>(null);
  const [highlight,setHighlight]=useState<{owner:string;visible:boolean}|null>(null);
  const [projectDimensions,renderLayout]=useProjectState<ScientificTableLayoutState>('dimensions',{},layoutOwner);
  const [scroll,setScroll]=useProjectState('scroll',{left:0,top:0},layoutOwner),viewportRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{const node=viewportRef.current;if(node){node.scrollLeft=scroll.left;node.scrollTop=scroll.top;}},[layoutOwner]);
  const layouts=useRef(new Map<string,ScientificTableLayoutState>()),liveOwner=useRef(owner);liveOwner.current=owner;
  const project=useProjectUiScope(),savedDimensions=layoutState??(project?projectDimensions:layouts.current.get(layoutOwner)??{});
  const [defaultWidths,setDefaultWidths]=useState<readonly number[]>([]);
  const columnKeys=identities.columnKeys;
  const retainedWidths=scientificTableRetainedWidths(savedDimensions,columnKeys,defaultWidths);
  const dimensions={...savedDimensions,columnWidths:retainedWidths};
  const setDimensions=(value:ScientificTableLayoutState)=>{if(liveOwner.current!==owner)return;const keyed=value.columnWidths?{...value,columnKeys}:value;layouts.current.set(layoutOwner,keyed);renderLayout({...keyed});onLayoutChange?.(keyed);};
  const highlightVisible=highlight?.owner!==highlightOwner||highlight.visible;
  const selection = selected?.owner === owner ? selected.range : null;
  const setSelection = (range: TableSelection | null) => {setSelected(range ? { owner, range } : null);if(range)setHighlight({owner:highlightOwner,visible:true});};
  type Gesture = { owner: string; document:Document; anchor: TableCellAddress; end: TableCellAddress; kind: 'cells' | 'columns'; dragged: boolean; toggle: boolean; x: number; y: number; activate?:()=>void };
  const drag = useRef<Gesture | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const clearActive = useRef(onClearActive); clearActive.current = onClearActive;
  const releasePointerListeners = useRef<(() => void) | null>(null);
  const releaseResizeListeners = useRef<(() => void) | null>(null);
  const releasePreview = useRef<(() => void) | null>(null);
  const measurement = useRef<(() => void) | null>(null);
  const columnMeasurement = useRef<{ document: Document; signature: string; columns: number[] } | null>(null);
  const contentSignature=useTableValue(()=>JSON.stringify([projection.columns,projection.rows.map(row=>row.cells),layout,actionWidth,initialColumnMinWidths,numericColumnWidths]),[projection.columns,projection.rows,layout,actionWidth,initialColumnMinWidths,numericColumnWidths]);
  const cancelDrag = (gesture = drag.current) => {
    if (!gesture || drag.current !== gesture) return;
    drag.current = null; releasePointerListeners.current?.(); releasePointerListeners.current = null;
  };
  const finishDrag = (gesture = drag.current) => {
    if (!gesture || drag.current !== gesture) return;
    const current=gesture.owner===liveOwner.current&&(!root.current||root.current.ownerDocument===gesture.document);
    if (current && gesture.toggle && !gesture.dragged) setSelection(null);
    if(current&&!gesture.dragged)gesture.activate?.();
    cancelDrag(gesture);
  };
  const clear = () => { cancelDrag();releasePreview.current?.();releasePreview.current=null; setSelection(null);setHighlight({owner:highlightOwner,visible:false});onRowPreview?.(null);clearActive.current?.(); };
  const start = 0, visibleRows = projection.rows;
  const revealOwner=useRef<{owner:string;key:string;requestId:number}|null>(null);
  useEffect(()=>{
    if(!revealRow)return;
    const index=projection.rows.findIndex(row=>row.key===revealRow.key);
    if(index<0)return;
    // An explicit scientific navigation restores its current-row emphasis after
    // the originating pointerdown cleared table browsing state. It creates no
    // clipboard range and does not run for ordinary selection/format renders.
    revealOwner.current={owner,...revealRow};setHighlight({owner:highlightOwner,visible:true});
  },[revealRow?.key,revealRow?.requestId]);
  useEffect(()=>{
    const request=revealOwner.current;
    if(!request||request.owner!==owner||!visibleRows.some(row=>row.key===request.key))return;
    const target=Array.from(root.current?.querySelectorAll<HTMLTableRowElement>('tbody tr[data-table-row-key]')??[]).find(row=>row.dataset.tableRowKey===request.key);
    if(target){target.scrollIntoView({block:'nearest',inline:'nearest'});revealOwner.current=null;}
  },[owner,revealRow?.key,revealRow?.requestId]);
  useEffect(() => { cancelDrag();setSelection(null);releaseResizeListeners.current?.();releaseResizeListeners.current=null; }, [owner]);
  useEffect(()=>{setHighlight({owner:highlightOwner,visible:false});},[highlightOwner]);
  useEffect(()=>{cancelDrag();releaseResizeListeners.current?.();releaseResizeListeners.current=null;},[root.current?.ownerDocument]);
  useEffect(() => () => { releasePointerListeners.current?.();releaseResizeListeners.current?.(); drag.current = null; }, []);
  useEffect(()=>{
    const host=root.current,document=host?.ownerDocument;if(!host||!document)return;
    const outside=(event:globalThis.PointerEvent)=>{const target=event.target as Element|null;if(host.ownerDocument!==document||liveOwner.current!==owner||!target||host.contains(target))return;if(!clearActive.current&&target.closest?.('button,input,select,textarea,a,[contenteditable=true],[role=button],.scientific-data-table'))return;clear();};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[owner,root.current?.ownerDocument]);
  function activateRow(row:ScientificTableRow,event:MouseEvent<HTMLTableRowElement>){
    setHighlight({owner:highlightOwner,visible:true});
    if(onRowActivate)onRowActivate(row);else if(selectAction?.available?.(row)!==false&&selectAction)selectAction.onActivate(row);else rowBindings?.(row).onClick?.(event);
  }
  function begin(event: PointerEvent<HTMLElement>, address: TableCellAddress, kind: 'cells' | 'columns',activate?:()=>void) {
    if (event.button !== 0 || !projection.rows.length || !projection.columns.length) return;
    event.preventDefault(); event.stopPropagation(); root.current?.focus({ preventScroll: true }); releasePointerListeners.current?.();
    releasePreview.current?.();releasePreview.current=null;
    // Gesture ownership follows the actual adopted document, including popouts.
    const anchor = event.shiftKey && selection ? { row: kind === 'columns' ? 0 : selection.anchor.row, column: selection.anchor.column } : address;
    const end = kind === 'columns' ? { row: projection.rows.length - 1, column: address.column } : address;
    const toggle = kind === 'cells' && !event.shiftKey && !!selection && (selection.kind ?? 'cells') === 'cells'
      && selection.anchor.row === address.row && selection.end.row === address.row && selection.anchor.column === address.column && selection.end.column === address.column;
    const gesture: Gesture = { owner, document:event.currentTarget.ownerDocument, anchor, end, kind, dragged: false, toggle, x: event.clientX, y: event.clientY,activate:kind==='cells'&&!event.shiftKey?activate:undefined };
    drag.current = gesture;
    const document = event.currentTarget.ownerDocument, finish = () => finishDrag(gesture), cancel = () => cancelDrag(gesture);
    const move=(event:globalThis.PointerEvent)=>{if(Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>4)gesture.dragged=true;};
    document.addEventListener('pointerup', finish); document.addEventListener('pointercancel', cancel);document.addEventListener('pointermove',move); document.defaultView?.addEventListener('blur', cancel);
    releasePointerListeners.current = () => { document.removeEventListener('pointerup', finish); document.removeEventListener('pointercancel', cancel);document.removeEventListener('pointermove',move); document.defaultView?.removeEventListener('blur', cancel); };
    setSelection({ anchor, end, kind });
  }
  function extend(event: PointerEvent<HTMLElement>, row: number, column: number) {
    const gesture = drag.current; if (!gesture || gesture.owner !== owner || !(event.buttons & 1)) return;
    const end = { row: gesture.kind === 'columns' ? projection.rows.length - 1 : row, column };
    if (end.row !== gesture.end.row || end.column !== gesture.end.column) gesture.dragged = true;
    gesture.end = end; setSelection({ anchor: gesture.anchor, end, kind: gesture.kind });
  }
  function minimumRowHeight() {
    const host=root.current;
    const size=host?.ownerDocument.defaultView?.getComputedStyle?.(host).fontSize;
    return Math.max(32,(parseFloat(size??'')||14)*20/14+6);
  }
  // Only explicit vertical resizing needs wrapped text geometry. Auto widths
  // and horizontal resizing must never walk the table's text nodes / Ranges.
  function contentRowMinimum(row:HTMLTableRowElement|undefined,minimumRow:number) {
    const host=root.current, document=host?.ownerDocument;
    const textHeight=(cell:HTMLElement|undefined,fallback:number)=>{
      if(!cell||!document?.createTreeWalker||!document.createRange)return fallback;
      const walker=document.createTreeWalker(cell,4),rects:DOMRect[]=[];
      while(walker.nextNode()){const range=document.createRange();range.selectNodeContents(walker.currentNode);rects.push(...Array.from(range.getClientRects()));range.detach();}
      const measured=rects.length?Math.max(...rects.map(rect=>rect.bottom))-Math.min(...rects.map(rect=>rect.top)):0;
      return Number.isFinite(measured)&&measured>0?measured:fallback;
    };
    return Math.max(minimumRow,...Array.from(row?.cells??[]).map(cell=>textHeight(cell,minimumRow-6)+6));
  }
  // Measure source text independently of wrapping. Cache by content and the
  // actual header/body fonts, so observer/width changes reuse the same minima.
  function contentColumnMinima() {
    const host=root.current, document=host?.ownerDocument;
    const headers=Array.from(host?.querySelectorAll<HTMLTableCellElement>('thead th[data-column]')??[]);
    const firstRow=host?.querySelector?host.querySelector<HTMLTableRowElement>('tbody tr'):host?.querySelectorAll<HTMLTableRowElement>('tbody tr')[0];
    const fontSize=host&&document?.defaultView?.getComputedStyle?parseFloat(document.defaultView.getComputedStyle(host).fontSize)||14:14;
    const styles=new Map<HTMLElement,CSSStyleDeclaration|undefined>();
    const cellStyle=(cell:HTMLElement|undefined)=>{
      if(cell&&!styles.has(cell))styles.set(cell,document?.defaultView?.getComputedStyle?.(cell));
      return cell?styles.get(cell):undefined;
    };
    const fontKey=(style:CSSStyleDeclaration|undefined)=>[style?.font,style?.fontSize,style?.fontWeight,style?.fontFamily,style?.letterSpacing,style?.wordSpacing];
    const signature=JSON.stringify([contentSignature,fontSize,projection.columns.map((_,index)=>[fontKey(cellStyle(headers[index])),fontKey(cellStyle(firstRow?.cells[index]))])]);
    if(document&&columnMeasurement.current?.document===document&&columnMeasurement.current.signature===signature)return columnMeasurement.current.columns;
    const canvas=document?.createElement?.('canvas'),context=canvas?.getContext?.('2d');
    const textWidths=new Map<string,number>();
    // Range widths describe the current wrapped lines, so they cannot establish
    // a horizontal minimum. Measure original text independently of table layout.
    const textWidth=(text:string,cell?:HTMLElement)=>{
      const style=cellStyle(cell),key=JSON.stringify([fontKey(style),text]);
      const cached=textWidths.get(key);if(cached!==undefined)return cached;
      const size=parseFloat(style?.fontSize??'')||fontSize;
      if(context)context.font=style?.font||`${style?.fontWeight??400} ${size}px ${style?.fontFamily??'Segoe UI, Microsoft YaHei, sans-serif'}`;
      const width=Math.max(0,...text.split(/\r?\n/).map(line=>{
        const measured=context?.measureText(line).width??Array.from(line).reduce((sum,char)=>sum+size*(/[^\u0000-\u00ff]/u.test(char)?1:.56),0);
        return measured+Math.max(0,Array.from(line).length-1)*(parseFloat(style?.letterSpacing??'')||0)+(line.match(/ /g)?.length??0)*(parseFloat(style?.wordSpacing??'')||0);
      }));
      textWidths.set(key,width);return width;
    };
    const columns=projection.columns.map((column,index)=>{
      const header=textWidth(scientificTableHeader(column),headers[index]);
      const bodyCell=firstRow?.cells?.[index];
      let minimum=Math.max(48,header+16);
      for(const row of visibleRows){
        const text=row.cells[index],natural=textWidth(text,bodyCell);
        // Short property labels stay whole; long metrics may wrap at ordinary
        // words, while a source number or unit always keeps its full width.
        const metric=layout==='metrics'&&index===0;
        const longestWord=metric?Math.max(0,...(text.match(/[\u0000-\u00ff]+/g)??[]).flatMap(part=>part.split(/\s+/)).map(word=>textWidth(word,bodyCell))):0;
        const width=metric?Math.min(natural,Math.max(fontSize*14,longestWord)):natural;
        minimum=Math.max(minimum,width+16);
      }
      return minimum;
    });
    if(document)columnMeasurement.current={document,signature,columns};
    return columns;
  }
  measurement.current=()=>{
      const host=root.current;if(!host||!host.getBoundingClientRect||!host.querySelectorAll)return;
      const minima=contentColumnMinima();
      const numeric=projection.columns.map((column,index)=>column.precision||column.quantity||(!/atom|index|mode|原子|编号|模式/i.test(column.key+column.label)&&projection.rows.some(row=>/^[-+]?\d/.test(row.cells[index]))&&projection.rows.every(row=>/^[-+]?\d|未输出|不适用|—/.test(row.cells[index]))));
      // The card is independent of the user-sized table body. Reserve the
      // permanently visible viewport rail, rather than feeding its overflow
      // width back into the next default-width calculation.
      const available=Math.floor(host.clientWidth??host.getBoundingClientRect().width);
      const filled=scientificTableDefaultWidths(minima,numeric.map(Boolean),Math.max(0,available-12),actionWidth,initialColumnMinWidths,numericColumnWidths);
      setDefaultWidths(previous=>filled.length!==previous.length||filled.some((value,index)=>Math.abs(value-previous[index])>.5)?filled:previous);
  };
  useEffect(()=>{measurement.current?.();},[contentSignature]);
  useEffect(()=>{
    const host=root.current;if(!host||!host.getBoundingClientRect||!host.querySelectorAll)return;
    let previousWidth=-1,previousFont='';
    const measure=()=>{
      const width=Math.floor(host.clientWidth??host.getBoundingClientRect().width),style=host.ownerDocument.defaultView?.getComputedStyle?.(host);
      const font=style?`${style.font}|${style.fontSize}|${style.letterSpacing}|${style.wordSpacing}`:'';
      if(width===previousWidth&&font===previousFont)return;
      previousWidth=width;previousFont=font;measurement.current?.();
    };
    measure();const Observer=host.ownerDocument?.defaultView?.ResizeObserver;
    const observer=Observer?new Observer(measure):null;observer?.observe(host);
    const fonts=host.ownerDocument.fonts,fontsChanged=()=>{columnMeasurement.current=null;measurement.current?.();};fonts?.addEventListener?.('loadingdone',fontsChanged);
    return()=>{observer?.disconnect();fonts?.removeEventListener?.('loadingdone',fontsChanged);};
  },[root.current?.ownerDocument]);
  function resize(event:PointerEvent<HTMLElement>,kind:'left'|'right'|'top'|'bottom'|'corner'|'column'|'row',index=0,rowKey?:string){
    if(event.button!==0)return;event.preventDefault();event.stopPropagation();cancelDrag();releasePreview.current?.();releasePreview.current=null;releaseResizeListeners.current?.();
    const document=event.currentTarget.ownerDocument,host=root.current;
    const horizontal=kind==='column'||kind==='left'||kind==='right'||kind==='corner';
    const vertical=kind==='top'||kind==='bottom'||kind==='corner';
    const minimumRow=minimumRowHeight(),columns=horizontal?contentColumnMinima():[];
    const measured=horizontal?Array.from(host?.querySelectorAll<HTMLTableCellElement>('thead th[data-column]')??[]).map(cell=>cell.getBoundingClientRect().width):[];
    const widths=horizontal?projection.columns.map((_,column)=>Math.max(columns[column],dimensions.columnWidths?.[column]??measured[column]??columns[column])):[];
    const original={...dimensions},width=widths.reduce((sum,value)=>sum+value,actionWidth+2);
    const rowIndex=kind==='row'?visibleRows.findIndex(row=>row.key===rowKey):-1;
    const selectedRow=kind==='row'?(event.currentTarget.closest?.('tr') as HTMLTableRowElement|null)??host?.querySelectorAll<HTMLTableRowElement>('tbody tr')[rowIndex]:undefined;
    const rowElements=vertical?Array.from(host?.querySelectorAll<HTMLTableRowElement>('tbody tr')??[]):[];
    const heights=vertical?rowElements.map(row=>contentRowMinimum(row,minimumRow)):[];
    const rowSizes=vertical?visibleRows.map((row,index)=>Math.max(heights[index]??minimumRow,dimensions.rowHeights?.[row.key]??dimensions.rowHeight??rowElements[index]?.getBoundingClientRect().height??minimumRow)):[];
    const bodyHeight=Math.max(1,rowSizes.reduce((sum,value)=>sum+value,0));
    const rowMinimum=kind==='row'?contentRowMinimum(selectedRow??undefined,minimumRow):minimumRow;
    const initialColumn=widths[index],initialRow=kind==='row'?Math.max(rowMinimum,dimensions.rowHeights?.[rowKey!]??dimensions.rowHeight??selectedRow?.getBoundingClientRect().height??minimumRow):minimumRow;
    const x=event.clientX,y=event.clientY;
    const move=(next:globalThis.PointerEvent)=>{if(liveOwner.current!==owner||root.current&&root.current.ownerDocument!==document)return;const dx=next.clientX-x,dy=next.clientY-y;if(!Number.isFinite(dx)||!Number.isFinite(dy))return;
      if(kind==='column'){const updatedColumns=[...widths];updatedColumns[index]=Math.max(columns[index],initialColumn+dx);setDimensions({...original,width:updatedColumns.reduce((sum,value)=>sum+value,actionWidth+2),columnWidths:updatedColumns});}
      else if(kind==='row'&&rowKey)setDimensions({...original,rowHeights:{...original.rowHeights,[rowKey]:Math.max(rowMinimum,initialRow+dy)}});
      else{
        const updated:ScientificTableLayoutState={...original};
        if(kind==='left'||kind==='right'||kind==='corner'){
          const target=Math.max(columns.reduce((sum,value)=>sum+value,actionWidth+2),width+(kind==='left'?-dx:dx));
          const factor=(target-actionWidth-2)/Math.max(1,widths.reduce((sum,value)=>sum+value,0));
          updated.columnWidths=widths.map((value,index)=>Math.max(columns[index],value*factor));
          updated.width=updated.columnWidths.reduce((sum,value)=>sum+value,actionWidth+2);
        }
        if(kind==='top'||kind==='bottom'||kind==='corner'){
          const factor=Math.max(0,(bodyHeight+(kind==='top'?-dy:dy))/bodyHeight);
          updated.rowHeights={...original.rowHeights,...Object.fromEntries(visibleRows.map((row,index)=>[row.key,Math.max(heights[index]??minimumRow,rowSizes[index]*factor)]))};
          // Height belongs to actual rows; no fixed-height viewport or clipping.
          delete updated.height;
        }
        setDimensions(updated);
      }
    };
    const release=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',release);document.removeEventListener('pointercancel',release);document.defaultView?.removeEventListener('blur',release);if(releaseResizeListeners.current===release)releaseResizeListeners.current=null;};
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',release);document.addEventListener('pointercancel',release);document.defaultView?.addEventListener('blur',release);releaseResizeListeners.current=release;
  }
  const explicitSourceColumns=projection.columns.filter(column=>column.precision!==undefined);
  const formatLocked=format?.locked||!!explicitSourceColumns.length&&explicitSourceColumns.every(column=>column.precision==='source');
  const units=[...new Set(projection.columns.map(column=>column.headerUnit??column.unit).filter(value=>value&&value!=='dimensionless'))];
  const displayFormat=format?{...format,locked:!!formatLocked}:undefined;
  const unitLabel=units.length===1?String(units[0]):units.length>1?'按各列单位':projection.columns.some(column=>column.key==='unit')?'按各行单位':'';
  const displayedWidths=dimensions.columnWidths??defaultWidths;
  const tableWidth=displayedWidths.length===projection.columns.length?displayedWidths.reduce((sum,value)=>sum+value,actionWidth):undefined;
  // A retained body must dispatch through the current render: in particular a
  // row resize after a column resize must preserve the newest column widths.
  const rowEvents=useRef({begin,extend,activateRow,resize});
  rowEvents.current={begin,extend,activateRow,resize};
  // Project persistence may clone this map on a width-only write. Equal row
  // heights still describe the same body, regardless of the map's identity.
  const rowHeightSignature=useTableValue(()=>JSON.stringify(dimensions.rowHeights??null),[dimensions.rowHeights]);
  const tableBody=useTableValue(()=><tbody>{visibleRows.map((row, index) => { const { onClick: _click, onKeyDown: _key, tabIndex: _tab, onPointerEnter: _enter, onPointerLeave: _leave, ...bindings } = rowBindings?.(row) ?? {}; return <tr key={row.key} {...bindings} data-table-row-key={row.key} style={{...bindings.style,height:dimensions.rowHeights?.[row.key]??dimensions.rowHeight??bindings.style?.height}} tabIndex={onRowActivate||selectAction||_click?0:undefined} aria-selected={highlightVisible&&(activeRowKey!==undefined?activeRowKey===row.key:bindings['aria-selected'])||undefined}
    onPointerEnter={event=>{if(!drag.current&&!releaseResizeListeners.current){onRowPreview?.(row);_enter?.(event);releasePreview.current=()=>{onRowPreview?.(null);_leave?.(event);};}}} onPointerLeave={event=>{if(!drag.current&&!releaseResizeListeners.current){onRowPreview?.(null);_leave?.(event);clearActive.current?.();releasePreview.current=null;}}}
    onKeyDown={event=>{if(event.target!==event.currentTarget)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();rowEvents.current.activateRow(row,event as unknown as MouseEvent<HTMLTableRowElement>);}else _key?.(event);}}
    onClick={event=>{if(event.target===event.currentTarget||event.detail===0)rowEvents.current.activateRow(row,event);}}>
    {visibilityAction&&<td className="scientific-row-visibility"><input type="checkbox" aria-label={typeof visibilityAction.label==='function'?visibilityAction.label(row):visibilityAction.label} checked={visibilityAction.active?.(row)??false} onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onChange={()=>visibilityAction.onActivate(row)}/></td>}{projection.columns.map((column, columnIndex) => <td key={column.key} data-row={start + index} data-column={columnIndex} title={row.cells[columnIndex]}
      data-missing={row.cells[columnIndex] === '未输出' || undefined}
      data-cell-selected={scientificTableCellSelected(selection, start + index, columnIndex) || undefined}
      data-selection-edge={scientificTableCellEdges(selection,start+index,columnIndex)}
      onPointerDown={event => rowEvents.current.begin(event, { row: start + index, column: columnIndex }, 'cells',()=>rowEvents.current.activateRow(row,event as unknown as MouseEvent<HTMLTableRowElement>))}
      onPointerEnter={event => rowEvents.current.extend(event, start + index, columnIndex)}
      onPointerMove={event => { if (drag.current && Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) > 4) drag.current.dragged = true; }}
      onClick={event => event.stopPropagation()}
    >{row.cells[columnIndex]}{columnIndex===0&&<span className="scientific-row-resizer" role="separator" aria-label="调整表格行高" data-row-key={row.key} aria-orientation="horizontal" onPointerDown={event=>rowEvents.current.resize(event,'row',0,row.key)}/>}</td>)}
    {!!actions.length && <td className="scientific-row-action"><span className="scientific-row-action-list">{actions.map((action, actionIndex) => action.available?.(row) !== false && (action.kind==='checkbox'?<input key={actionIndex} type="checkbox" aria-label={typeof action.label==='function'?action.label(row):action.label} checked={action.active?.(row)??false} onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onChange={()=>action.onActivate(row)}/>:<button key={actionIndex} type="button" className="scientific-row-action-button" aria-label={typeof action.label === 'function' ? action.label(row) : action.label} title={typeof action.label === 'function' ? action.label(row) : action.label} aria-pressed={action.active?.(row) ?? false}
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); action.onActivate(row); }}>{action.text !== undefined ? typeof action.text === 'function' ? action.text(row) : action.text : action.kind === 'pin' ? <Pin size={16} strokeWidth={1.75} aria-hidden="true"/> : '选择'}</button>))}</span></td>}
  </tr>; })}</tbody>,[projection.columns,projection.rows,owner,selection,highlightVisible,activeRowKey,rowHeightSignature,dimensions.rowHeight,rowBindings,rowAction,rowActions,onRowPreview,onRowActivate]);
  return <div ref={root} className="scientific-data-table" data-variant="numeric" data-layout={layout === 'metrics' ? 'metrics' : undefined} data-highlight-active={highlightVisible||undefined} tabIndex={0} aria-label="可复制分析表格"
    onPointerDown={event=>{if(!(event.target as Element).closest('th,td,button,input,select,textarea,[role=separator]'))clear();}}
    onPointerUp={() => finishDrag()} onPointerCancel={() => cancelDrag()}
    onCopy={event => { if (!selection||(event.target as Element)?.closest?.('input,select,textarea,[contenteditable=true]')) return; event.clipboardData.setData('text/plain', scientificTableText(projection, selection)); event.preventDefault(); }}
    onKeyDown={event => {
      if((event.target as Element)?.closest?.('input,select,textarea,[contenteditable=true]'))return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && projection.rows.length && projection.columns.length) {
        event.preventDefault(); setSelection({ anchor: { row: 0, column: 0 }, end: { row: projection.rows.length - 1, column: projection.columns.length - 1 }, kind: 'cells' });
      } else if (event.key === 'Escape') { event.preventDefault(); clear(); }
    }}>
    {!hideTitle&&<h4 className="scientific-table-title">{title??format?.ariaLabel??'数值表'}</h4>}
    <ScientificTableToolbar format={displayFormat} unitLabel={unitLabel} sorting={sorting} expansion={expansion}
      onArrange={()=>{cancelDrag();releaseResizeListeners.current?.();releaseResizeListeners.current=null;measurement.current?.();setDimensions({...dimensions,width:undefined,columnWidths:defaultWidths});}}
      onRestore={()=>{cancelDrag();releaseResizeListeners.current?.();releaseResizeListeners.current=null;setDimensions({});}}
      exportDisabled={!projection.rows.length} onExport={()=>onExport?onExport():exportBlob(new Blob([scientificTableText(projection)],{type:'text/plain;charset=utf-8'}),exportFileName??'Ester-Studio-table.txt',root.current?.ownerDocument)}/>
    {/* The collapsed table border occupies one pixel beyond the col widths. */}
    <div className="scientific-table-frame" style={{width:tableWidth===undefined?dimensions.width:tableWidth+15}}>
    <div className="scientific-table-viewport" ref={viewportRef} onScroll={event=>setScroll({left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop})}><table className="scientific-table analysis-selectable analysis-comparison-table" style={tableWidth!==undefined?{width:tableWidth,tableLayout:'fixed'}:undefined}>
      <colgroup>{visibilityAction&&<col style={{width:48}}/>}{projection.columns.map((column, index) => <col key={column.key} style={displayedWidths[index]?{ width:displayedWidths[index] }:undefined}/>)}{!!actions.length && <col className="scientific-row-action" style={{ width: actions.length*32 }}/>}</colgroup>
      <thead><tr>{visibilityAction&&<th scope="col">显示</th>}{projection.columns.map((column, index) => <th key={column.key} scope="col" tabIndex={0} data-column={index}
        data-column-selected={scientificTableColumnSelected(selection, index) || undefined}
        onPointerDown={event => begin(event, { row: 0, column: index }, 'columns')} onPointerEnter={event => extend(event, 0, index)}
        onClickCapture={event => { event.preventDefault(); event.stopPropagation(); }}
        onKeyDown={event => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); const anchor = event.shiftKey && selection ? { row: 0, column: selection.anchor.column } : { row: 0, column: index }; setSelection({ anchor, end: { row: projection.rows.length - 1, column: index }, kind: 'columns' }); }}
      >{renderHeader?.(column) ?? scientificTableHeader(column)}<span className="scientific-column-resizer" role="separator" aria-label={`调整${column.label}列宽`} aria-orientation="vertical" onPointerDown={event=>resize(event,'column',index)}/></th>)}{!!actions.length && <th className="scientific-row-action" scope="col">{actions.every(action=>action.kind==='checkbox')?'选择':'固定'}</th>}</tr></thead>
      {tableBody}
    </table></div>
    {(['left','right','top','bottom','corner'] as const).map(edge=><span key={edge} className={`scientific-table-resizer scientific-table-resizer-${edge}`} role="separator" aria-label={`调整表格${({left:'左',right:'右',top:'上',bottom:'下',corner:'右下角'} as const)[edge]}边界`} aria-orientation={edge==='left'||edge==='right'?'vertical':'horizontal'} onPointerDown={event=>resize(event,edge)}/>)}
    </div>
  </div>;
}
