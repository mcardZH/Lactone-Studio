import { useEffect, useLayoutEffect, useMemo, useRef,useState } from 'react';
import {useProjectState,useProjectUiSnapshot} from '../../projects/ui-state';
import type * as React from 'react';
import type { WavefunctionMetadata } from '../../results/orbital-contracts';
import { convertEnergy } from '../../results/energy';
import { formatResultValue as formatAnalysisValue } from '../../results/numeric-format';
import { alignedOrbitalRows, orbitalElectronMark, orbitalFrontierScrollTop, orbitalListChannels } from './orbital-list-presentation';
import './orbital.css';
import {scientificTableText,type ScientificTableProjection} from './scientific-table';
import ScientificTableToolbar from './ScientificTableToolbar';
import './OrbitalList.css';
import { exportBlob } from './export-image';

export interface OrbitalListProps {
  metadata: Pick<WavefunctionMetadata,'sourceId'|'sourceRevision'|'orbitals'>; selectedKey: string | null; unit: 'eV' | 'hartree';
  active?: boolean;
  readOnly?:boolean;
  decimals?:number;
  onDecimalsChange?(value: number): void;
  onUnit(unit: 'eV' | 'hartree'): void; onChoose(key: string): void;
}
const DEGENERACY_HELP = '同一自旋通道中原始能量完全相同；不按显示舍入判定。';
export function orbitalListProjection(metadata:OrbitalListProps['metadata'],unit:'eV'|'hartree',decimals=2):ScientificTableProjection{
 return{columns:[{key:'spin',label:'自旋'},{key:'orbital',label:'轨道'},{key:'occupation',label:'占据数'},{key:'energy',label:`能量 / ${unit==='hartree'?'Eh':'eV'}`,heading:'能量',headerUnit:unit==='hartree'?'Eh':'eV'}],rows:orbitalListChannels(metadata).flatMap(channel=>channel.rows.map(row=>({key:row.key,cells:[channel.label||'受限',String(row.displayIndex),row.occupation!=null&&Number.isInteger(row.occupation)?String(row.occupation):formatAnalysisValue(row.occupation,decimals),formatAnalysisValue(row.energy==null?undefined:convertEnergy({value:row.energy,unit:row.energyUnit},unit),decimals)]})))};
}
/** Scroll/focus only: navigating the list never selects or calculates an orbital. */
export function positionOrbitalFrontier(host: HTMLDivElement, moveFocus = false,spin?:string): boolean {
  const prefix=spin?`[data-spin="${spin}"]`:'';
  const target = host.querySelector<HTMLElement>(`${prefix}[data-frontier="homo"]`) ?? host.querySelector<HTMLElement>(`${prefix}[data-frontier="lumo"]`);
  if (!target) return false;
  const hostBounds = host.getBoundingClientRect(), targetBounds = target.getBoundingClientRect();
  const top = orbitalFrontierScrollTop({ hostTop: hostBounds.top, clientTop: host.clientTop, clientHeight: host.clientHeight, scrollTop: host.scrollTop, scrollHeight: host.scrollHeight, targetTop: targetBounds.top, targetHeight: targetBounds.height });
  if (top === null) return false;
  host.scrollTop = top;
  if (moveFocus) target.focus({ preventScroll: true });
  return true;
}
export default function OrbitalList({ metadata, selectedKey, unit, onUnit, onChoose, active = true,readOnly=false,decimals:controlledDecimals,onDecimalsChange }: OrbitalListProps) {
  const [localDecimals,setLocalDecimals]=useProjectState('orbital-list.decimals',2),decimals=controlledDecimals??localDecimals;
  const gesture=useRef<{key:string;x:number;y:number;dragged:boolean}|null>(null);
  const choose=(key:string)=>{const dragged=gesture.current?.dragged;gesture.current=null;if(dragged)return;setCopyAll(false);onChoose(key);};
  const channels = useMemo(() => orbitalListChannels(metadata), [metadata]);
  const alignedRows=useMemo(()=>alignedOrbitalRows(channels),[channels]);
  const sharedScroll=useRef<HTMLDivElement|null>(null),lastSpin=useRef<string|null>(null);
  const scrollHosts = useRef(new Map<string, HTMLDivElement>());
  const positioned = useRef({ source: '', channels: new Set<string>() });
  const [copyAll,setCopyAll]=useState(false);
  const [listHeight,setListHeight]=useProjectState('orbital-list.height',310);
  const [listWidth,setListWidth]=useProjectState<number>('orbital-list.width');
  const frame=useRef<HTMLDivElement>(null),root=useRef<HTMLElement>(null),releaseResize=useRef<(()=>void)|null>(null);
  const [columnLayout,setColumnLayout]=useProjectState<'default'|'content'>('orbital-list.columnLayout','default');
  const savedScroll=useProjectUiSnapshot('orbital-list.scroll',()=>Object.fromEntries([...scrollHosts.current,...(sharedScroll.current?[['shared',sharedScroll.current] as const]:[])].map(([key,node])=>[key,{top:node.scrollTop,left:node.scrollLeft}])));
  const fittedColumns=useMemo(()=>{
    const rows=channels.flatMap(channel=>channel.rows);
    const indexWidth=Math.max(3,...rows.map(row=>String(row.displayIndex).length+1));
    const occupationWidth=Math.max(2,...rows.map(row=>formatAnalysisValue(row.occupation,decimals).length));
    const energyWidth=Math.max(7,...rows.map(row=>formatAnalysisValue(row.energy==null?undefined:convertEnergy({value:row.energy,unit:row.energyUnit},unit),decimals).length+1));
    return `${indexWidth}ch calc(35px + ${occupationWidth}ch) minmax(${energyWidth}ch, 1fr)`;
  },[channels,decimals,unit]);
  const source = JSON.stringify([metadata.sourceId, metadata.sourceRevision]);
  useEffect(()=>{setCopyAll(false);releaseResize.current?.();},[source]);
  useEffect(()=>()=>releaseResize.current?.(),[]);
  useEffect(()=>{
    const host=root.current,document=host?.ownerDocument;if(!host||!document)return;
    const outside=(event:globalThis.PointerEvent)=>{const target=event.target as Element|null;if(!target||host.contains(target)||target.closest?.('button,input,select,textarea,a,[contenteditable=true],[role=button]'))return;setCopyAll(false);};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[root.current?.ownerDocument]);
  function resize(event:React.PointerEvent<HTMLElement>,edge:'left'|'right'|'top'|'bottom'|'corner'){
    if(event.button!==0)return;event.preventDefault();event.stopPropagation();releaseResize.current?.();gesture.current=null;
    const host=frame.current;if(!host)return;const document=event.currentTarget.ownerDocument,box=host.getBoundingClientRect(),x=event.clientX,y=event.clientY;
    const initialHeight=listHeight,initialWidth=box.width;
    const move=(next:globalThis.PointerEvent)=>{
      if(host.ownerDocument!==document)return;
      if(edge==='left'||edge==='right'||edge==='corner'){
        const availableWidth=root.current?.getBoundingClientRect().width??initialWidth;
        const minimumWidth=Math.min(channels.length>1?330:200,availableWidth);
        setListWidth(Math.min(availableWidth,Math.max(minimumWidth,initialWidth+(edge==='left'?x-next.clientX:next.clientX-x))));
      }
      if(edge==='top'||edge==='bottom'||edge==='corner')setListHeight(Math.max(120,Math.min(1200,initialHeight+(edge==='top'?y-next.clientY:next.clientY-y))));
    };
    const release=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',release);document.removeEventListener('pointercancel',release);document.defaultView?.removeEventListener('blur',release);if(releaseResize.current===release)releaseResize.current=null;};
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',release);document.addEventListener('pointercancel',release);document.defaultView?.addEventListener('blur',release);releaseResize.current=release;
  }
  function place(force = false, moveFocus = false) {
    if (positioned.current.source !== source) {positioned.current = { source, channels: new Set() };setCopyAll(false);}
    if (!active) return;
    if(channels.length>1){
      const host=sharedScroll.current;
      if(!host||!force&&positioned.current.channels.has('shared'))return;
      const spin=channels.find(channel=>channel.rows.some(row=>row.key===selectedKey))?.spin??lastSpin.current??channels[0]?.spin;
      if(positionOrbitalFrontier(host,moveFocus,spin))positioned.current.channels.add('shared');
      return;
    }
    let focusPending = moveFocus;
    for (const channel of channels) {
      if (!force && positioned.current.channels.has(channel.spin)) continue;
      const host = scrollHosts.current.get(channel.spin);
      if (host && positionOrbitalFrontier(host, focusPending)) {
        positioned.current.channels.add(channel.spin);
        focusPending = false;
      }
    }
  }
  useLayoutEffect(() => {
    if(savedScroll){for(const [key,value] of Object.entries(savedScroll)){const host=key==='shared'?sharedScroll.current:scrollHosts.current.get(key);if(host){host.scrollTop=value.top;host.scrollLeft=value.left;positioned.current.source=source;positioned.current.channels.add(key);}}}
    // Pages remain mounted while hidden. Wait for a real layout, then place once
    // per source/channel; later page returns preserve the user's manual scroll.
    // Position before the first visible paint; retry if an ancestor is still hidden.
    place();
    const frame = requestAnimationFrame(() => place());
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    for (const host of scrollHosts.current.values()) observer?.observe(host);
    if(sharedScroll.current)observer?.observe(sharedScroll.current);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [active, source, channels]);
  const orbitalRow=(channel:typeof channels[number],row:typeof metadata.orbitals[number])=>{
    const frontier=row.key===channel.homoKey?'homo':row.key===channel.lumoKey?'lumo':undefined;
    const occupation=row.occupation!=null&&Number.isInteger(row.occupation)?String(row.occupation):formatAnalysisValue(row.occupation,decimals);
    const energy=formatAnalysisValue(row.energy==null?undefined:convertEnergy({value:row.energy,unit:row.energyUnit},unit),decimals);
    return <button className="shared-input-action orbital-select-row" type="button" key={row.key} aria-label={`${readOnly?'查看':'显示'}轨道 ${channel.label?`${channel.label} `:''}${row.displayIndex}`} aria-description={channel.degenerateKeys.has(row.key)?DEGENERACY_HELP:undefined} aria-pressed={row.key===selectedKey} data-orbital-key={row.key} data-orbital-index={row.displayIndex} data-spin={channel.spin} data-frontier={frontier} onPointerDown={event=>{if(event.button===0)gesture.current={key:row.key,x:event.clientX,y:event.clientY,dragged:false};}} onPointerMove={event=>{const own=gesture.current;if(own&&Math.hypot(event.clientX-own.x,event.clientY-own.y)>4)own.dragged=true;}} onPointerCancel={()=>{gesture.current=null;}} onClick={()=>{lastSpin.current=channel.spin;choose(row.key);}} title={`${row.displayIndex} · 占据 ${occupation} · ${energy} ${unit==='hartree'?'Eh':unit}${channel.degenerateKeys.has(row.key)?` · ${DEGENERACY_HELP}`:''}`}><span className="orbital-index">{row.displayIndex}{channel.degenerateKeys.has(row.key)&&<sup title={DEGENERACY_HELP} aria-label={DEGENERACY_HELP}>*</sup>}</span><span className="orbital-occupation" aria-label={`来源占据数 ${occupation}`}><span className="orbital-electron-box" aria-hidden="true">{orbitalElectronMark(row.occupation,row.spin,decimals)}</span><span className="orbital-occupation-value">{occupation}</span></span><span className="orbital-energy">{energy}{frontier&&<small>{frontier.toUpperCase()}</small>}</span></button>;
  };
  const heading=(channel:typeof channels[number])=><>{channel.label&&<h4>{channel.label}</h4>}<div className="orbital-column-heading"><span>编号</span><span>占据</span><span>能量 / {unit==='hartree'?'Eh':unit}</span></div></>;
  return <section ref={root} className="orbital-selector" aria-label="三维轨道选择" tabIndex={0} data-copy-all={copyAll||undefined} data-column-layout={columnLayout} style={{'--orbital-list-height':`${listHeight}px`} as React.CSSProperties} onClick={event=>{if(event.target===event.currentTarget)setCopyAll(false);}} onKeyDown={event=>{if((event.target as Element)?.closest?.('input,select,textarea'))return;if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();setCopyAll(true);}else if(event.key==='Escape')setCopyAll(false);}} onCopy={event=>{if(copyAll){event.clipboardData.setData('text/plain',scientificTableText(orbitalListProjection(metadata,unit,decimals)));event.preventDefault();}}}>
    <ScientificTableToolbar format={{decimals,onDecimalsChange:value=>{setLocalDecimals(value);onDecimalsChange?.(value);},unit,units:[{value:'eV',label:'eV'},{value:'hartree',label:'Eh'}],onUnitChange:value=>onUnit(value as typeof unit),ariaLabel:'轨道列表'}} onArrange={()=>setColumnLayout('content')} onRestore={()=>{releaseResize.current?.();setColumnLayout('default');setListHeight(310);setListWidth(undefined);}} onExport={()=>exportBlob(new Blob([scientificTableText(orbitalListProjection(metadata,unit,decimals))],{type:'text/plain;charset=utf-8'}),'Ester-Studio-orbitals.txt',root.current?.ownerDocument)} extraControls={<button type="button" className="orbital-frontier-jump" disabled={!channels.some(channel=>channel.homoKey||channel.lumoKey)} onClick={()=>place(true,true)}>定位 HOMO/LUMO</button>}/>
    <div ref={frame} className="orbital-list-frame" style={{width:listWidth}}>
      {channels.length>1?<div className="orbital-shared-frame" style={columnLayout==='content'?{'--orbital-columns':fittedColumns} as React.CSSProperties:undefined}>
        <div ref={sharedScroll} className="orbital-shared-scroll" tabIndex={0} aria-label="α/β轨道共同滚动列表"><div className="orbital-channels is-spin-split orbital-shared-heading">{channels.map(channel=><section className="orbital-channel" key={channel.spin} aria-label={`${channel.label} 轨道`}>{heading(channel)}</section>)}</div>{alignedRows.map(row=><div className="orbital-shared-row" key={row.displayIndex} data-shared-orbital-index={row.displayIndex}>{row.cells.map((cell,index)=>cell?orbitalRow(channels[index],cell):<div key={channels[index].spin} className="orbital-row-placeholder" aria-label={`${channels[index].label}未提供轨道${row.displayIndex}`}/>)}</div>)}</div>
      </div>:<div className="orbital-channels" style={columnLayout==='content'?{'--orbital-columns':fittedColumns} as React.CSSProperties:undefined}>{channels.map(channel=><section className="orbital-channel" key={channel.spin} aria-label="轨道列表">{heading(channel)}<div className="orbital-channel-scroll" ref={node=>{if(node)scrollHosts.current.set(channel.spin,node);else scrollHosts.current.delete(channel.spin);}}>{channel.rows.map(row=>orbitalRow(channel,row))}</div></section>)}</div>}
      {(['left','right','top','bottom','corner'] as const).map(edge=><span key={edge} className={`scientific-table-resizer scientific-table-resizer-${edge}`} role="separator" aria-label={`调整轨道列表${({left:'左',right:'右',top:'上',bottom:'下',corner:'右下角'} as const)[edge]}边界`} aria-orientation={edge==='left'||edge==='right'?'vertical':'horizontal'} onPointerDown={event=>resize(event,edge)}/>)}</div>
  </section>;
}
