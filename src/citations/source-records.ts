import {normalizeDoi,stableToken} from './identity';
import {missingCitationFields} from './registry';
import type {CitationRegistry,CitationFact,CitationMapping,CitationRecord} from './types';
/** Adds only references proven by retained entry metadata. No catalogue scan can
 * claim usage, and an entry's original paper is scoped to its exact source ID. */
export function augmentSourceCitationRegistry(registry:CitationRegistry,facts:readonly CitationFact[]):CitationRegistry {
 const records=[...registry.records],mappings=[...registry.mappings];
 for(const fact of facts){
  if(fact.feature!=='data-source'||fact.kind!=='data-source'||!fact.sourceId||!fact.evidence.some(e=>e.locator.trim())||fact.retained===false||fact.method==='unknown-cif-database')continue;
  const params=fact.parameters||{},doi=normalizeDoi(typeof params.doi==='string'?params.doi:undefined),citation=typeof params.citation==='string'?params.citation:'',url=typeof params.url==='string'?params.url:undefined;
  if(!doi&&!citation&&!url&&!params.recordId)continue;
  const known=doi?registry.records.filter(r=>r.status==='verified'&&normalizeDoi(r.doi)===doi&&!missingCitationFields(r).length):[];
  const token=stableToken(JSON.stringify([fact.sourceId,doi,citation,url])),id=`source-reference:${token}`;
  let citationIds=known.map(r=>r.id);
  if(!citationIds.length){
   if(!records.some(r=>r.id===id)){
    const record:CitationRecord={id,kind:'dataset',identity:fact.sourceId,title:`数据来源记录：${fact.software||fact.method||'未知来源'} ${params.recordId||params.entryId||fact.sourceId}`,authors:[],doi,url,version:fact.version,status:'pending',evidence:fact.evidence.map(e=>({kind:'project',locator:e.locator,note:'保留来源元数据，尚未独立核实书目'})),note:`条目原引用：${citation||'未提供'}；原DOI：${doi||'未提供'}；原记录：${params.recordId||params.entryId||fact.sourceId}。论文题名、作者等未知，待用户补充。`};
    records.push(record);
   }
   citationIds=[id];
  }
  const mapping:CitationMapping={id:`source-mapping:${token}`,feature:fact.feature,method:fact.method,software:fact.software,sourceId:fact.sourceId,citationIds,role:'data',reasonZh:`保留数据条目${params.recordId||fact.sourceId}的原始引用`,methodSummaryZh:'具体结构数据条目与其原论文来源；数据库通用引用另列。'};
  if(!mappings.some(m=>m.id===mapping.id))mappings.push(mapping);
 }
 return {...registry,records,mappings};
}
