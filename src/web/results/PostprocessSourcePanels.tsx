import type {HTMLAttributes,ReactNode} from 'react';
import type {TrajectoryResult} from '../../results/contracts';
import {PostprocessBasicInfo,type PostprocessMetadata,type PostprocessNumericBookProps} from './PostprocessNumericBook';
import type {PostprocessScientificFileDocument} from '../../results/postprocess-document';
import PostprocessFileInformation,{PostprocessScientificStatus} from './PostprocessFileInformation';
import {PostprocessSourceFeedback} from './PostprocessSourceFeedback';

export {PostprocessSourceFeedback} from './PostprocessSourceFeedback';

type SourceStatus='ready'|'reading'|'error'|'unverified';
export interface PostprocessSourceCardProps extends HTMLAttributes<HTMLElement>{
 title:string;status?:SourceStatus;statusLabel?:string;availability?:'partial';children:ReactNode;dragover?:boolean;
}
/** Saved and generated wavefunctions share the same source-card presentation. */
export function PostprocessSourceCard({title,status,statusLabel,availability,children,dragover,className='',...attributes}:PostprocessSourceCardProps){
 return <section {...attributes} className={`postprocess-file-slot ${status?'has-source':''} ${status==='ready'?'is-ready':''} ${dragover?'is-dragover':''} ${className}`.trim()} aria-label={attributes['aria-label']??title}>
  <div className="postprocess-section-heading"><strong>{title}</strong><span className={`postprocess-file-status status-${status??'empty'}${status==='ready'&&availability==='partial'?' status-partial':''}`}>{statusLabel??(status==='ready'?availability==='partial'?'部分可用':'✓ 已核对':status==='reading'?'读取中':status==='error'?'未接入':status==='unverified'?'待核对':'待补入')}</span></div>
  {children}
 </section>;
}
export interface PostprocessSourceInformationProps{
 result:TrajectoryResult|null;currentIndex:number;metadata?:PostprocessMetadata;sourceDifferences?:PostprocessNumericBookProps['sourceDifferences'];
 fileDocument?:PostprocessScientificFileDocument|null;onFileJob?(id:string):void;pendingFileJobId?:string;
 busy?:boolean;onExtract?():void;onPrepareInput?():void;
}
/** One complete information/details/actions surface for every analysis source. */
export function PostprocessSourceInformation(p:PostprocessSourceInformationProps){
 return <>{p.fileDocument?<PostprocessFileInformation document={p.fileDocument} mode="summary" onJob={p.onFileJob} pendingJobId={p.pendingFileJobId}/>:<><PostprocessBasicInfo result={p.result} currentIndex={p.currentIndex} metadata={p.metadata}/>{p.result?.scientific&&<PostprocessScientificStatus data={p.result.scientific} currentIndex={p.currentIndex}/>}</>}
  {p.sourceDifferences?.map(difference=><PostprocessSourceFeedback key={`${difference.label}:${difference.message}`} label={difference.label} message={difference.message}/>)}
  <section className="postprocess-next" aria-label="后续操作"><h3>后续操作</h3><button type="button" disabled={!p.result||p.busy||!p.onExtract} onClick={p.onExtract}>提取当前结构为新模型</button><button type="button" disabled={!p.result||p.busy||!p.onPrepareInput} onClick={p.onPrepareInput}>准备后续输入</button></section>
 </>;
}
