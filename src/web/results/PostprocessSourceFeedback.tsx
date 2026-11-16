import {useState} from 'react';
import type {ScientificDiagnostics} from '../../results/scientific-contracts';
import './PostprocessSourceFeedback.css';

export interface SourceReadWarningField {
 field:'route'|'title';
 sourceLine?:number;
 message?:string;
}
const fieldLabels={route:'计算路线（Route）',title:'标题'};

/** Only fields with explicit partial-read evidence produce this warning. */
export function scientificReadWarningFields(fields:readonly ScientificDiagnostics['fields'][number][]|undefined):SourceReadWarningField[]{
 return fields?.flatMap(row=>row.status==='partial'&&(row.field==='route'||row.field==='title')
  ?[{field:row.field,sourceLine:row.sourceLine,message:row.message}]:[])??[];
}

/** Closing details changes their presentation and leaves source status intact. */
export function PostprocessSourceFeedback({message,label='来源提示',error=false,fields}: {message:string;label?:string;error?:boolean;fields?:readonly SourceReadWarningField[]}){
 const [expanded,setExpanded]=useState(false);
 return <div className={`postprocess-source-feedback ${error?'is-error':''}`}>
  <button type="button" className="postprocess-source-feedback-toggle" aria-label={`查看${label}`} aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)} title={label}>{fields?.length?'⚠':'!'}</button>
  {expanded&&<div className="postprocess-source-feedback-detail" role={error?'alert':'status'}>
   <div className="postprocess-source-feedback-body"><p>{message}</p>{!!fields?.length&&<ul aria-label="受影响的来源字段">{fields.map((row,index)=><li key={`${row.field}:${row.sourceLine??''}:${index}`}>
    <strong>{fieldLabels[row.field]}</strong>{row.sourceLine!==undefined&&<span> · 原文第 {row.sourceLine} 行</span>}{row.message&&<p>{row.message}</p>}
   </li>)}</ul>}</div>
   <button type="button" className="postprocess-source-feedback-close" aria-label={`关闭${label}`} onClick={()=>setExpanded(false)}>×</button>
  </div>}
 </div>;
}

export function PostprocessReadWarning({fields,hasStructure=false}:{fields:readonly SourceReadWarningField[];hasStructure?:boolean}){
 if(!fields.length)return null;
 const fieldGroup=fields.some(row=>row.field==='route')?'计算设置':'来源字段';
 return <PostprocessSourceFeedback label="来源字段警告" fields={fields}
  message={`本作业部分${fieldGroup}未能完整读取${hasStructure?'，已有结构保留':''}。`}/>;
}
