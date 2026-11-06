import { captureCipCitationFact, captureGeneratedInputFacts, stableToken, type CipCitationReceipt, type CitationDecisions, type CitationFact, type CitationRecord } from '../../citations';
export interface PreparedCitationInput {engine:'gaussian'|'orca';name:string;text:string;outcome:'copied'|'requested'|'saved'}
export interface WorkspaceCitationState {inputReceipts:CitationFact[];decisions:CitationDecisions}
export const emptyCitationState=():WorkspaceCitationState=>({inputReceipts:[],decisions:{}});
/** Usage history is one first successful receipt per owner/producer/operation,
 * not a per-frame result cache. Keep the accurate first source as evidence. */
export function appendCipUsage(state:WorkspaceCitationState,receipt:CipCitationReceipt):WorkspaceCitationState {
 if(state.inputReceipts.some(f=>f.documentId===receipt.documentId&&f.kind==='model-operation'&&f.feature==='stereochemistry-assignment'&&f.method==='CIP'&&f.software===receipt.software&&f.version===receipt.version&&f.retained!==false))return state;
 const fact=captureCipCitationFact(receipt);if(!fact)return state;
 return {...state,inputReceipts:[...state.inputReceipts,fact]};
}
export function appendPreparedInput(state:WorkspaceCitationState,documentId:string,input:PreparedCitationInput):WorkspaceCitationState {
 const receiptId=`input:${stableToken(JSON.stringify([documentId,input.engine,input.name,input.text]))}`;
 const detail='项目保留的输入准备记录；'+(input.outcome==='copied'?'实际输入文本已复制；输入准备，无运行证据':input.outcome==='saved'?'实际输入文本已写入；输入准备，无运行证据':'实际输入文本已准备并请求下载；不证明落盘或运行');
 const facts=captureGeneratedInputFacts({engine:input.engine,text:input.text,sourceName:input.name,documentId,receiptId}).map(f=>{
  const previous=state.inputReceipts.find(p=>p.id===f.id),evidence=[...(previous?.evidence||[]),...f.evidence.map(e=>({...e,detail}))];
  return {...f,parameters:{...f.parameters,citationInputEngine:input.engine,citationInputName:input.name},purpose:[...new Set([previous?.purpose,detail].filter(Boolean))].join('; '),evidence:[...new Map(evidence.map(e=>[JSON.stringify(e),e])).values()]};
 });
 return {...state,inputReceipts:[...state.inputReceipts.filter(f=>f.sourceId!==receiptId&&!(f.documentId===documentId&&f.parameters?.citationInputEngine===input.engine&&f.parameters?.citationInputName===input.name)),...facts]};
}
export function restoreCitationState(value:unknown):WorkspaceCitationState {
 if(!value||typeof value!=='object')return emptyCitationState();
 const v=value as Partial<WorkspaceCitationState>;
 const d=v.decisions&&typeof v.decisions==='object'?v.decisions:{};
 const records=Array.isArray(d.records)?d.records.filter(r=>r&&typeof r.id==='string'&&typeof r.title==='string'&&['article','chapter','preprint','software','dataset','web'].includes(r.kind)&&['verified','pending','unverified'].includes(r.status)&&Array.isArray(r.authors)&&r.authors.every((a:CitationRecord["authors"][number])=>a&&[a.literal,a.family,a.given].every(x=>x===undefined||typeof x==='string'))&&(r.editors===undefined||Array.isArray(r.editors)&&r.editors.every((a:CitationRecord["authors"][number])=>a&&[a.literal,a.family,a.given].every(x=>x===undefined||typeof x==="string")))&&Array.isArray(r.evidence)&&r.evidence.every((e:CitationRecord["evidence"][number])=>e&&typeof e.kind==='string'&&[e.url,e.locator,e.checkedAt,e.note].every(x=>x===undefined||typeof x==='string'))&&[r.bookTitle,r.series,r.doi,r.url,r.version,r.journal,r.journalAbbreviation,r.volume,r.issue,r.pages,r.articleNumber,r.publisher,r.identity,r.methodSummaryZh,r.note].every(x=>x===undefined||typeof x==='string')&&(r.year===undefined||typeof r.year==='number')):[];
 const annotations=Array.isArray(d.annotations)?d.annotations.filter(a=>a&&typeof a.citationKey==='string'&&(a.excluded===undefined||typeof a.excluded==='boolean')&&(a.note===undefined||typeof a.note==='string')):[];
 const additions=Array.isArray(d.additions)?d.additions.filter(a=>a&&typeof a.recordId==='string'&&typeof a.purpose==='string'&&(a.documentId===undefined||typeof a.documentId==='string')&&(a.note===undefined||typeof a.note==='string')):[];
 return {inputReceipts:Array.isArray(v.inputReceipts)?v.inputReceipts.filter(f=>f&&typeof f.id==='string'&&typeof f.documentId==='string'&&typeof f.feature==='string'&&[f.method,f.software,f.version].every(x=>x===undefined||typeof x==='string')&&Array.isArray(f.evidence)&&f.evidence.every(e=>e&&typeof e.locator==='string')):[],decisions:{...(records.length?{records}:{}),...(annotations.length?{annotations}:{}),...(additions.length?{additions}:{})}};
}
export function retainedCitationState(state:WorkspaceCitationState,ids:ReadonlySet<string>):WorkspaceCitationState {
 return {...state,inputReceipts:state.inputReceipts.filter(f=>ids.has(f.documentId)),decisions:{...state.decisions,additions:state.decisions.additions?.filter(a=>!a.documentId||ids.has(a.documentId))}};
}
