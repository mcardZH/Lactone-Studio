import { useEffect, useRef, useState, type HTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import {useProjectState,useProjectUiScope} from '../../projects/ui-state';
import { Pin } from 'lucide-react';
import { scientificTableCellEdges, scientificTableCellSelected, scientificTableColumnSelected, scientificTableText, scientificTableScaleSizes, type ScientificTableColumn, type ScientificTableProjection, type ScientificTableRow, type TableCellAddress, type TableSelection, type ScientificTableFormat, type ScientificTableLayoutState } from './scientific-table';
import ScientificTableToolbar from './ScientificTableToolbar';
import { scientificTableHeader, type ScientificTableSorting } from './scientific-table';
import { exportBlob } from './export-image';
import './LegacyScientificDataTable.css';

const PAGE_SIZE = 100;
export interface ScientificTableRowAction {
  label: string | ((row: ScientificTableRow) => string);
  text?: string | ((row: ScientificTableRow) => string);
  onActivate(row: ScientificTableRow): void;
  active?(row: ScientificTableRow): boolean;
  available?(row: ScientificTableRow): boolean;
  kind?: 'pin' | 'select' | 'checkbox' | 'visibility';
}
export interface ScientificDataTableProps {
  title?: string;
  hideTitle?: boolean;
  onExport?(): void;
  exportFileName?: string;
  expansion?: { expanded: boolean; onToggle(): void };
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
  onLayoutChange?(value: ScientificTableLayoutState): void;
}
/** A single release activates a row; drag/header gestures only select copied
 * values. Pagination limits rendering, never the scientific data projection. */
export function LegacyScientificDataTable({ title, hideTitle, onExport, exportFileName, expansion, projection, selectionScope, layout = 'comparison', rowBindings, rowAction, rowActions, renderHeader, onRowActivate, activeRowKey, revealRow, format, sorting, layoutState, onLayoutChange }: ScientificDataTableProps) {
  const suppliedActions = rowActions ?? (rowAction ? [rowAction] : []);
  const selectAction = suppliedActions.find(action=>action.kind==='select');
  const actions = suppliedActions.filter(action=>action.kind!=='select');
  const actionWidth=actions.length*32;
  const signature = JSON.stringify([projection.columns.map(column => column.key), projection.rows.map(row => row.key)]), owner = JSON.stringify([selectionScope ?? null, signature]);
  const layoutOwner=JSON.stringify([selectionScope??signature,projection.columns.map(column=>column.key)]);
  const [page, setPage] = useProjectState('page',0,layoutOwner), [selected, setSelected] = useState<{ owner: string; range: TableSelection } | null>(null);
  const [highlight,setHighlight]=useState<{owner:string;visible:boolean}|null>(null);
  const [projectDimensions,renderLayout]=useProjectState<ScientificTableLayoutState>('dimensions',{},layoutOwner);
  const [scroll,setScroll]=useProjectState('scroll',{left:0,top:0},layoutOwner),viewportRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{const node=viewportRef.current;if(node){node.scrollLeft=scroll.left;node.scrollTop=scroll.top;}},[layoutOwner]);
  const layouts=useRef(new Map<string,ScientificTableLayoutState>()),liveOwner=useRef(owner);liveOwner.current=owner;
  const project=useProjectUiScope(),dimensions=layoutState??(project?projectDimensions:layouts.current.get(layoutOwner)??{});
  const setDimensions=(value:ScientificTableLayoutState)=>{if(liveOwner.current!==owner)return;layouts.current.set(layoutOwner,value);renderLayout({...value});onLayoutChange?.(value);};
  const highlightVisible=highlight?.owner!==owner||highlight.visible;
  const selection = selected?.owner === owner ? selected.range : null;
  const setSelection = (range: TableSelection | null) => {setSelected(range ? { owner, range } : null);if(range)setHighlight({owner,visible:true});};
  type Gesture = { owner: string; document:Document; anchor: TableCellAddress; end: TableCellAddress; kind: 'cells' | 'columns'; dragged: boolean; toggle: boolean; x: number; y: number; activate?:()=>void };
  const drag = useRef<Gesture | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const releasePointerListeners = useRef<(() => void) | null>(null);
  const releaseResizeListeners = useRef<(() => void) | null>(null);
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
  const clear = () => { cancelDrag(); setSelection(null);setHighlight({owner,visible:false}); };
  const pages = Math.max(1, Math.ceil(projection.rows.length / PAGE_SIZE)), current = Math.min(page, pages - 1);
  const start = current * PAGE_SIZE, visibleRows = projection.rows.slice(start, start + PAGE_SIZE);
  const revealOwner=useRef<{owner:string;key:string;requestId:number}|null>(null);
  useEffect(()=>{
    if(!revealRow)return;
    const index=projection.rows.findIndex(row=>row.key===revealRow.key);
    if(index<0)return;
    // An explicit scientific navigation restores its current-row emphasis after
    // the originating pointerdown cleared table browsing state. It creates no
    // clipboard range and does not run for ordinary selection/format renders.
    revealOwner.current={owner,...revealRow};setHighlight({owner,visible:true});setPage(Math.floor(index/PAGE_SIZE));
  },[revealRow?.key,revealRow?.requestId]);
  useEffect(()=>{
    const request=revealOwner.current;
    if(!request||request.owner!==owner||!visibleRows.some(row=>row.key===request.key))return;
    const target=Array.from(root.current?.querySelectorAll<HTMLTableRowElement>('tbody tr[data-table-row-key]')??[]).find(row=>row.dataset.tableRowKey===request.key);
    if(target){target.scrollIntoView({block:'nearest',inline:'nearest'});revealOwner.current=null;}
  },[current,owner,revealRow?.key,revealRow?.requestId]);
  useEffect(() => { clear();releaseResizeListeners.current?.();releaseResizeListeners.current=null; }, [owner]);
  useEffect(() => { cancelDrag(); }, [current]);
  useEffect(()=>{cancelDrag();releaseResizeListeners.current?.();releaseResizeListeners.current=null;},[root.current?.ownerDocument]);
  useEffect(() => () => { releasePointerListeners.current?.();releaseResizeListeners.current?.(); drag.current = null; }, []);
  useEffect(()=>{
    const host=root.current,document=host?.ownerDocument;if(!host||!document)return;
    const outside=(event:globalThis.PointerEvent)=>{const target=event.target as Element|null;if(host.ownerDocument!==document||liveOwner.current!==owner||!target||host.contains(target)||target.closest?.('button,input,select,textarea,a,[contenteditable=true],[role=button],.scientific-data-table'))return;clear();};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[owner,root.current?.ownerDocument]);
  function activateRow(row:ScientificTableRow,event:MouseEvent<HTMLTableRowElement>){
    setHighlight({owner,visible:true});
    if(onRowActivate)onRowActivate(row);else if(selectAction?.available?.(row)!==false&&selectAction)selectAction.onActivate(row);else rowBindings?.(row).onClick?.(event);
  }
  function begin(event: PointerEvent<HTMLElement>, address: TableCellAddress, kind: 'cells' | 'columns',activate?:()=>void) {
    if (event.button !== 0 || !projection.rows.length || !projection.columns.length) return;
    event.preventDefault(); event.stopPropagation(); root.current?.focus({ preventScroll: true }); releasePointerListeners.current?.();
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
  function resize(event:PointerEvent<HTMLElement>,kind:'left'|'right'|'top'|'bottom'|'column'|'row',index=0,rowKey?:string){
    if(event.button!==0)return;event.preventDefault();event.stopPropagation();cancelDrag();releaseResizeListeners.current?.();
    const document=event.currentTarget.ownerDocument,host=root.current,frameBox=host?.querySelector?.('.scientific-table-frame')?.getBoundingClientRect(),box=frameBox?.width?frameBox:host?.getBoundingClientRect();
    const measured=Array.from(host?.querySelectorAll<HTMLTableCellElement>('thead th[data-column]')??[]).map(cell=>cell.getBoundingClientRect().width);
    const widths=projection.columns.map((_,column)=>dimensions.columnWidths?.[column]??measured[column]??80);
    const original={...dimensions},width=dimensions.width??box?.width??240,height=dimensions.height??box?.height??200;
    const measuredRows=Array.from(host?.querySelectorAll<HTMLTableRowElement>('tbody tr')??[]).map(row=>row.getBoundingClientRect().height);
    const rowSizes=visibleRows.map((row,index)=>dimensions.rowHeights?.[row.key]??dimensions.rowHeight??measuredRows[index]??30);
    const viewportHeight=host?.querySelector?.<HTMLElement>('.scientific-table-viewport')?.getBoundingClientRect().height??height;
    const chromeHeight=Math.max(0,height-viewportHeight);
    const fixedRowsHeight=(host?.querySelector?.<HTMLElement>('thead')?.getBoundingClientRect().height??0)+(host?.querySelector?.<HTMLElement>('tfoot')?.getBoundingClientRect().height??0);
    const bodyHeight=Math.max(1,Math.min(viewportHeight-fixedRowsHeight,rowSizes.reduce((sum,value)=>sum+value,0)));
    const initialColumn=widths[index],initialRow=(rowKey?dimensions.rowHeights?.[rowKey]:undefined)??dimensions.rowHeight??(event.currentTarget.closest?.('tr')?.getBoundingClientRect().height??30);
    const x=event.clientX,y=event.clientY;
    const move=(next:globalThis.PointerEvent)=>{if(liveOwner.current!==owner||root.current&&root.current.ownerDocument!==document)return;const dx=next.clientX-x,dy=next.clientY-y;if(!Number.isFinite(dx)||!Number.isFinite(dy))return;
      if(kind==='column'){const columns=[...(original.columnWidths??widths)];columns[index]=Math.max(48,initialColumn+dx);setDimensions({...original,columnWidths:columns});}
      else if(kind==='row'&&rowKey)setDimensions({...original,rowHeights:{...original.rowHeights,[rowKey]:Math.max(24,initialRow+dy)}});
      else if(kind==='left'||kind==='right'){
        const nextWidth=Math.max(140,width+(kind==='left'?-dx:dx));
        const contentWidth=Math.max(1,widths.reduce((sum,value)=>sum+value,0));
        setDimensions({...original,width:nextWidth,columnWidths:scientificTableScaleSizes(widths,(nextWidth-actionWidth-2)/contentWidth,48)});
      }else{
        const nextHeight=Math.max(100,height+(kind==='top'?-dy:dy));
        const scaled=scientificTableScaleSizes(rowSizes,Math.max(1,nextHeight-chromeHeight-fixedRowsHeight)/bodyHeight,24);
        setDimensions({...original,height:nextHeight,rowHeights:{...original.rowHeights,...Object.fromEntries(visibleRows.map((row,index)=>[row.key,scaled[index]]))}});
      }
    };
    const release=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',release);document.removeEventListener('pointercancel',release);document.defaultView?.removeEventListener('blur',release);if(releaseResizeListeners.current===release)releaseResizeListeners.current=null;};
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',release);document.addEventListener('pointercancel',release);document.defaultView?.addEventListener('blur',release);releaseResizeListeners.current=release;
  }
  const explicitSourceColumns=projection.columns.filter(column=>column.precision!==undefined);
  const formatLocked=format?.locked||!!explicitSourceColumns.length&&explicitSourceColumns.every(column=>column.precision==='source');
  return <div ref={root} className="scientific-data-table" data-variant="legacy" data-layout={layout === 'metrics' ? 'metrics' : undefined} data-highlight-active={highlightVisible||undefined} tabIndex={0} aria-label="可复制分析表格"
    onPointerDown={event=>{if(!(event.target as Element).closest('th,td,button,input,select,textarea,[role=separator]'))clear();}}
    onPointerUp={() => finishDrag()} onPointerCancel={() => cancelDrag()}
    onCopy={event => { if (!selection||(event.target as Element)?.closest?.('input,select,textarea,[contenteditable=true]')) return; event.clipboardData.setData('text/plain', scientificTableText(projection, selection)); event.preventDefault(); }}
    onKeyDown={event => {
      if((event.target as Element)?.closest?.('input,select,textarea,[contenteditable=true]'))return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && projection.rows.length && projection.columns.length) {
        event.preventDefault(); setSelection({ anchor: { row: 0, column: 0 }, end: { row: projection.rows.length - 1, column: projection.columns.length - 1 }, kind: 'cells' });
      } else if (event.key === 'Escape') { event.preventDefault(); clear(); }
    }}>
    {!hideTitle&&(title??format?.ariaLabel)&&<h4 className="scientific-table-title">{title??format?.ariaLabel}</h4>}
    <ScientificTableToolbar format={format?{...format,locked:!!formatLocked}:undefined} sorting={sorting} expansion={expansion} unitLabel={[...new Set(projection.columns.map(column=>column.headerUnit??column.unit).filter(value=>value&&value!=='dimensionless'))].join('、')}
      onArrange={()=>{const widths=projection.columns.map((_,index)=>Math.max(48,...[projection.columns[index].label,...projection.rows.map(row=>row.cells[index])].map(value=>Array.from(value).reduce((sum,char)=>sum+(/[^\u0000-\u00ff]/u.test(char)?14:8),16))));setDimensions({...dimensions,width:widths.reduce((sum,width)=>sum+width,actionWidth+2),columnWidths:widths});}}
      onRestore={()=>{releaseResizeListeners.current?.();setDimensions({});}} exportDisabled={!projection.rows.length}
      onExport={()=>onExport?onExport():exportBlob(new Blob([scientificTableText(projection)],{type:'text/plain;charset=utf-8'}),exportFileName??'Ester-Studio-table.txt',root.current?.ownerDocument)}/>
    <div className="scientific-table-frame" style={{width:dimensions.width,height:dimensions.height,maxHeight:dimensions.height?'none':undefined}}>
    <div className="scientific-table-viewport" ref={viewportRef} onScroll={event=>setScroll({left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop})}><table className="scientific-table analysis-selectable analysis-comparison-table" style={dimensions.columnWidths?.length?{width:dimensions.columnWidths.reduce((sum,width)=>sum+width,0)+actionWidth,tableLayout:'fixed'}:undefined}>
      <colgroup>{projection.columns.map((column, index) => <col key={column.key} style={dimensions.columnWidths?.[index]?{ width: dimensions.columnWidths[index] }:undefined}/>)}{!!actions.length && <col className="scientific-row-action" style={{ width: actionWidth }}/>}</colgroup>
      <thead><tr>{projection.columns.map((column, index) => <th key={column.key} scope="col" tabIndex={0} data-column={index}
        data-column-selected={scientificTableColumnSelected(selection, index) || undefined}
        onPointerDown={event => begin(event, { row: 0, column: index }, 'columns')} onPointerEnter={event => extend(event, 0, index)}
        onClickCapture={event => { event.preventDefault(); event.stopPropagation(); }}
        onKeyDown={event => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); const anchor = event.shiftKey && selection ? { row: 0, column: selection.anchor.column } : { row: 0, column: index }; setSelection({ anchor, end: { row: projection.rows.length - 1, column: index }, kind: 'columns' }); }}
      >{renderHeader?.(column) ?? scientificTableHeader(column)}<span className="scientific-column-resizer" role="separator" aria-label={`调整${column.label}列宽`} aria-orientation="vertical" onPointerDown={event=>resize(event,'column',index)}/></th>)}{!!actions.length && <th className="scientific-row-action" scope="col">固定</th>}</tr></thead>
      <tbody>{visibleRows.map((row, index) => { const { onClick: _click, onKeyDown: _key, tabIndex: _tab, ...bindings } = rowBindings?.(row) ?? {}; return <tr key={row.key} {...bindings} data-table-row-key={row.key} style={{...bindings.style,height:dimensions.rowHeights?.[row.key]??dimensions.rowHeight??bindings.style?.height}} tabIndex={onRowActivate||selectAction||_click?0:undefined} aria-selected={highlightVisible&&(activeRowKey!==undefined?activeRowKey===row.key:bindings['aria-selected'])||undefined}
        onKeyDown={event=>{if(event.target!==event.currentTarget)return;if(event.key==='Enter'||event.key===' '){event.preventDefault();activateRow(row,event as unknown as MouseEvent<HTMLTableRowElement>);}else _key?.(event);}}
        onClick={event=>{if(event.detail===0)activateRow(row,event);}}>
        {projection.columns.map((column, columnIndex) => <td key={column.key} data-row={start + index} data-column={columnIndex} title={row.cells[columnIndex]}
          data-missing={row.cells[columnIndex] === '未输出' || undefined}
          data-cell-selected={scientificTableCellSelected(selection, start + index, columnIndex) || undefined}
          data-selection-edge={scientificTableCellEdges(selection,start+index,columnIndex)}
          onPointerDown={event => begin(event, { row: start + index, column: columnIndex }, 'cells',()=>activateRow(row,event as unknown as MouseEvent<HTMLTableRowElement>))}
          onPointerEnter={event => extend(event, start + index, columnIndex)}
          onPointerMove={event => { if (drag.current && Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) > 4) drag.current.dragged = true; }}
          onClick={event => event.stopPropagation()}
        >{row.cells[columnIndex]}{columnIndex===0&&<span className="scientific-row-resizer" role="separator" aria-label="调整表格行高" data-row-key={row.key} aria-orientation="horizontal" onPointerDown={event=>resize(event,'row',0,row.key)}/>}</td>)}
        {!!actions.length && <td className="scientific-row-action"><span className="scientific-row-action-list">{actions.map((action, actionIndex) => action.available?.(row) !== false && <button key={actionIndex} type="button" className="scientific-row-action-button" aria-label={typeof action.label === 'function' ? action.label(row) : action.label} title={typeof action.label === 'function' ? action.label(row) : action.label} aria-pressed={action.active?.(row) ?? false}
          onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); action.onActivate(row); }}>{action.text !== undefined ? typeof action.text === 'function' ? action.text(row) : action.text : action.kind === 'pin' ? <Pin size={16} strokeWidth={1.75} aria-hidden="true"/> : '选择'}</button>)}</span></td>}
      </tr>; })}</tbody>
      {pages > 1 && <tfoot><tr><td colSpan={projection.columns.length + (actions.length ? 1 : 0)}>
        <button type="button" disabled={!current} onClick={() => setPage(current - 1)}>上一页</button>
        <span> {current + 1} / {pages} · 共 {projection.rows.length} 项 </span>
        <button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>下一页</button>
      </td></tr></tfoot>}
    </table></div>
    {(['left','right','top','bottom'] as const).map(edge=><span key={edge} className={`scientific-table-resizer scientific-table-resizer-${edge}`} role="separator" aria-label={`调整表格${({left:'左',right:'右',top:'上',bottom:'下'} as const)[edge]}边界`} aria-orientation={edge==='left'||edge==='right'?'vertical':'horizontal'} onPointerDown={event=>resize(event,edge)}/>)}
    </div>
  </div>;
}


