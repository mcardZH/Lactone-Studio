import {useEffect,useId,useRef,useState} from 'react';
import type {ViewportImageExportOptions} from '../results/export-image';
import './viewport-image-export.css';

export interface ViewportImageExportMenuProps {
  disabled?:boolean; exporting?:boolean;
  openRequest?:number;
  getViewportSize?():{width:number;height:number}|undefined;
  onExport(options:ViewportImageExportOptions,ownerDocument:Document):void|Promise<void>;
}
/** One public presentation; all scientific scene and export work stays with the canvas owner. */
export default function ViewportImageExportMenu({disabled=false,exporting=false,onExport,getViewportSize,openRequest=0}:ViewportImageExportMenuProps){
  const id=`viewport-image-export-${useId().replace(/[^a-zA-Z0-9_-]/g,'')}`;
  const trigger=useRef<HTMLButtonElement>(null),popup=useRef<HTMLElement>(null);
  const [includeAnnotations,setIncludeAnnotations]=useState(true),[open,setOpen]=useState(false),[position,setPosition]=useState({left:8,top:40});
  const [width,setWidth]=useState(1600),[height,setHeight]=useState(1200),[lockRatio,setLockRatio]=useState(true),[transparent,setTransparent]=useState(false);
  const ratio=useRef(4/3),initialized=useRef(false);
  const locate=()=>{const node=trigger.current,box=node?.getBoundingClientRect(),win=node?.ownerDocument.defaultView;if(!box||!win)return;
    if(!initialized.current){const size=getViewportSize?.();if(size&&size.width>0&&size.height>0&&Number.isFinite(size.width/size.height)){ratio.current=size.width/size.height;setWidth(Math.max(1,Math.round(Math.min(1600,1600*ratio.current))));setHeight(Math.max(1,Math.round(Math.min(1600,1600/ratio.current))));}initialized.current=true;}
    setPosition({left:Math.max(8,Math.min(win.innerWidth-282,box.left)),top:Math.max(8,Math.min(win.innerHeight-290,box.bottom+5))});};
  const changeSize=(axis:'width'|'height',value:number)=>{if(!Number.isSafeInteger(value)||value<1)return;const bounded=value;
    if(lockRatio){const pair=axis==='width'?{width:bounded,height:Math.max(1,Math.round(bounded/ratio.current))}:{width:Math.max(1,Math.round(bounded*ratio.current)),height:bounded};if(!Number.isSafeInteger(pair.width)||!Number.isSafeInteger(pair.height))return;setWidth(pair.width);setHeight(pair.height);}
    else if(axis==='width')setWidth(bounded);else setHeight(bounded);};
  const run=(format:ViewportImageExportOptions['format'])=>{const owner=trigger.current?.ownerDocument;if(!owner||disabled||exporting)return;popup.current?.hidePopover();void onExport({format,includeAnnotations,width,height,transparent},owner);};
  useEffect(()=>{if(openRequest>0&&!disabled&&!exporting){locate();popup.current?.showPopover();}},[openRequest]);
  return <div className="viewport-image-export" data-no-reorder onPointerDown={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onKeyUp={event=>event.stopPropagation()}>
    <button ref={trigger} type="button" data-testid="viewport-image-export" popoverTarget={id} disabled={disabled||exporting} aria-expanded={open} onClick={locate}>{exporting?'正在导出图片…':'导出图片'}</button>
    <section ref={popup} id={id} popover="auto" className="viewport-image-export-menu" aria-label="三维图片导出" style={{left:position.left,top:position.top}} onToggle={event=>setOpen(event.newState==='open')}>
      <label><input type="checkbox" aria-label="导出包含标注" checked={includeAnnotations} onChange={event=>setIncludeAnnotations(event.target.checked)}/>包含标注</label>
      <div className="viewport-image-size"><label>宽<input type="number" aria-label="导出图片宽度" min="1" value={width} onChange={event=>changeSize('width',event.currentTarget.valueAsNumber)}/></label><span>×</span><label>高<input type="number" aria-label="导出图片高度" min="1" value={height} onChange={event=>changeSize('height',event.currentTarget.valueAsNumber)}/></label><span>px</span></div>
      <label><input type="checkbox" aria-label="锁定图片比例" checked={lockRatio} onChange={event=>{ratio.current=width/height;setLockRatio(event.target.checked);}}/>锁定比例</label>
      <label><input type="checkbox" aria-label="透明背景" checked={transparent} onChange={event=>setTransparent(event.target.checked)}/>透明背景</label>
      <button type="button" disabled={disabled||exporting} onClick={()=>run('png')}>PNG 图片</button>
      <button type="button" disabled={disabled||exporting} onClick={()=>run('svg')}>SVG 图片（嵌入 PNG）</button>
    </section>
  </div>;
}
