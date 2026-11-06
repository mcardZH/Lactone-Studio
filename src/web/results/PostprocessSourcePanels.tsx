import {useState,type HTMLAttributes,type ReactNode} from 'react';
import type {TrajectoryResult} from '../../results/contracts';
import {PostprocessBasicInfo,type PostprocessMetadata,type PostprocessNumericBookProps} from './PostprocessNumericBook';
import type {PostprocessScientificFileDocument} from '../../results/postprocess-document';
import PostprocessFileInformation,{PostprocessScientificStatus} from './PostprocessFileInformation';

type SourceStatus='ready'|'reading'|'error'|'unverified';
export interface PostprocessSourceCardProps extends HTMLAttributes<HTMLElement>{
 title:string;status?:SourceStatus;statusLabel?:string;children:ReactNode;dragover?:boolean;
}
/** Saved and generated wavefunctions share the same source-card presentation. */
export function PostprocessSourceCard({title,status,statusLabel,children,dragover,className='',...attributes}:PostprocessSourceCardProps){
 return <section {...attributes} className={`postprocess-file-slot ${status==='ready'?'is-ready':''} ${dragover?'is-dragover':''} ${className}`.trim()} aria-label={attributes['aria-label']??title}>
  <div className="postprocess-section-heading"><strong>{title}</strong><span className={`postprocess-file-status status-${status??'empty'}`}>{statusLabel??(status==='ready'?'✓ 已核对':status==='reading'?'读取中':status==='error'?'未接入':status==='unverified'?'待核对':'待补入')}</span></div>
  {children}
 </section>;
}
/** A nonfatal source notice is opt-in detail. Closing its text changes only
 * presentation, and a redraw/remount never reopens it without a user action. */
export function PostprocessSourceFeedback({message,label='来源提示',error=false}:{message:string;label?:string;error?:boolean}){
 const [expanded,setExpanded]=useState(false);
 return <div className={`postprocess-source-feedback ${error?'is-error':''}`}>
  <button type="button" className="postprocess-source-feedback-toggle" aria-label={`查看${label}`} aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)} title={label}>!</button>
  {expanded&&<div className="postprocess-source-feedback-detail" role="status"><p>{message}</p><button type="button" className="postprocess-source-feedback-close" aria-label={`关闭${label}`} onClick={()=>setExpanded(false)}>×</button></div>}
 </div>;
}
export interface PostprocessSourceInformationProps{
 result:TrajectoryResult|null;currentIndex:number;metadata?:PostprocessMetadata;sourceDifferences?:PostprocessNumericBookProps['sourceDifferences'];
 fileDocument?:PostprocessScientificFileDocument|null;onFileJob?(id:string):void;
 busy?:boolean;onExtract?():void;onPrepareInput?():void;
}
/** One complete information/details/actions surface for every analysis source. */
export function PostprocessSourceInformation(p:PostprocessSourceInformationProps){
 return <>{p.fileDocument?<PostprocessFileInformation document={p.fileDocument} mode="summary" onJob={p.onFileJob}/>:<><PostprocessBasicInfo result={p.result} currentIndex={p.currentIndex} metadata={p.metadata}/>{p.result?.scientific&&<PostprocessScientificStatus data={p.result.scientific} currentIndex={p.currentIndex}/>}</>}
  {p.sourceDifferences?.map(difference=><PostprocessSourceFeedback key={`${difference.label}:${difference.message}`} label={difference.label} message={difference.message}/>)}
  <section className="postprocess-next" aria-label="后续操作"><h3>后续操作</h3><button type="button" disabled={!p.result||p.busy||!p.onExtract} onClick={p.onExtract}>提取当前结构为新模型</button><button type="button" disabled={!p.result||p.busy||!p.onPrepareInput} onClick={p.onPrepareInput}>准备后续输入</button></section>
 </>;
}
