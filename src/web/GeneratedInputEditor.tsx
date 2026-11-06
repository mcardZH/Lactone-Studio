import type { ReactNode } from 'react';
import { ArrowDownToLine, Copy, FileCode2 } from 'lucide-react';

export interface GeneratedEditorFile {name:string;text:string;role?:string}
/** A complete shared output surface. Engine adapters own file roles and snapshots. */
export default function GeneratedInputEditor({engine,files,index=0,onSelect,onEdit,edited=false,stale=false,busy=false,readOnly=false,onCopy,onDownload,onDownloadAll,downloadCount=files.length,onSubmit,submitDisabled=false,submitTitle,submitting=false,children}: {
  engine:'gaussian'|'orca';files:readonly GeneratedEditorFile[];index?:number;onSelect?:(index:number)=>void;
  onEdit?:(text:string)=>void;edited?:boolean;stale?:boolean;busy?:boolean;readOnly?:boolean;
  onCopy:()=>void;onDownload:()=>void;onDownloadAll?:()=>void;downloadCount?:number;
  onSubmit?:()=>void;submitDisabled?:boolean;submitTitle?:string;submitting?:boolean;children?:ReactNode;
}) {
  const file=files[index]??files[0],text=file?.text??'';
  const state=busy?'生成中':!text&&!edited?'待生成':edited&&stale?'已手工编辑 · 设置已变更':stale?'设置已变更':edited?'已手工编辑':readOnly&&file?.role!=='input'?'配套文件 · 只读':'已生成';
  return <section className="generated-input-editor" data-testid="generated-input-editor" data-engine={engine} data-edited={edited} data-stale={stale}>
    <header className="generated-input-toolbar"><div className="generated-input-file"><FileCode2 size={15}/>{files.length>1?<select aria-label={engine==='orca'?'ORCA输出文件':'Gaussian输出文件'} value={index<files.length?index:0} onChange={event=>onSelect?.(Number(event.target.value))}>{files.map((entry,i)=><option key={`${entry.role}:${entry.name}`} value={i}>{entry.name}{entry.role&&entry.role!=='input'?` · ${entry.role==='structure'?'配套结构':'配套文件'}`:''}</option>)}</select>:<span>{file?.name??'尚无生成文件'}</span>}</div><span className="generated-input-status" role="status">{state}</span></header>
    <div className="generated-input-code"><div className="generated-input-lines" aria-hidden="true">{text.split('\n').map((_,i)=><span key={i}>{i+1}</span>)}</div><textarea aria-label="输入文本" data-testid="generated-input-text" readOnly={readOnly||!file} spellCheck={false} autoCorrect="off" autoCapitalize="off" wrap="off" value={text} onScroll={event=>{const gutter=event.currentTarget.previousElementSibling;if(gutter)gutter.scrollTop=event.currentTarget.scrollTop;}} onChange={event=>onEdit?.(event.target.value)}/></div>
    <div className="generated-input-actions"><button type="button" className="button button-white" disabled={!text.trim()||busy} onClick={onCopy}><Copy size={15}/>复制当前输入</button><button type="button" className="button button-white" disabled={!file||busy} onClick={onDownload}><ArrowDownToLine size={15}/>下载当前文件</button>{downloadCount>1&&onDownloadAll&&<button type="button" className="button button-white" disabled={!file||busy} onClick={onDownloadAll}>下载全部 {downloadCount} 个</button>}{onSubmit&&<button type="button" className="button button-white" disabled={submitDisabled||busy||submitting} title={submitTitle} onClick={onSubmit}>{submitting?'准备提交…':'提交任务'}</button>}</div>
    {children}
  </section>;
}
