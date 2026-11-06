import type {Structure} from '../../core/types';
import type {WavefunctionMetadata} from '../../results/orbital-contracts';
import type {WavefunctionAnalysisResult} from '../../results/wavefunction-analysis';
import type {PostprocessDocument} from '../../results/postprocess-document';
import {analysisRange,analysisColor,formatAnalysisValue,type AnalysisDisplaySettings} from './analysis-display';
export type {AnalysisDisplaySettings} from './analysis-display';

export interface ResultBondScalar {atomIds:[string,string];value:number;label:string;color?:string;length?:number;comparisonVisible?:boolean;decimals?:number}
/** Filter the display only, then use exactly that population for colors/legend. */
export function visibleBondDisplayValues(rows:readonly ResultBondScalar[],settings:AnalysisDisplaySettings):ResultBondScalar[]{
 const visible=rows.filter(row=>row.comparisonVisible??(Number.isFinite(row.value)&&row.value>0.05));
 const range=analysisRange(visible.map(row=>row.value),settings,false);
 return visible.map(row=>({...row,color:range&&Number.isFinite(row.value)?analysisColor(row.value,range,settings.palette):undefined}));
}
export const ANALYSIS_METHOD_LABELS:Record<string,string>={mulliken:'Mulliken',lowdin:'Löwdin',cm5:'CM5','hirshfeld-i':'Hirshfeld-I',adch:'ADCH',hirshfeld:'Hirshfeld',resp:'RESP',scpa:'SCPA',bader:'Bader',mayer:'Mayer','wiberg-lowdin':'Wiberg (Löwdin)',laplacian:'Laplacian',fuzzy:'FBO'};

/** The accepted OUT/WF pair is explicitly order preserving. A rigid fit
 * changes positions, never atom correspondence. No nearest-atom remapping. */
export function analysisSourceMapping(metadata:WavefunctionMetadata,display:Structure):Map<string,number>{
 const source=metadata.structure.atoms;
 if(source.length!==display.atoms.length||new Set(source.map(a=>a.id)).size!==source.length||new Set(display.atoms.map(a=>a.id)).size!==display.atoms.length||source.some((atom,index)=>!atom.id||!display.atoms[index].id||atom.element!==display.atoms[index].element))throw Error('分析来源原子与当前显示结构的身份/顺序不一致。');
 return new Map(source.map((atom,index)=>[atom.id!,index]));
}
export function currentAnalysisResult<T extends WavefunctionAnalysisResult>(result:T|null,document:PostprocessDocument):T|null{
 const attachment=document.wavefunction,metadata=attachment?.source.metadata;
 return result&&metadata&&result.sessionId===attachment?.nativeSessionId&&result.sourceRevision===metadata.sourceRevision?result:null;
}
export function mapAnalysisResult(result:WavefunctionAnalysisResult,metadata:WavefunctionMetadata,display:Structure,settings:AnalysisDisplaySettings){
 const mapping=analysisSourceMapping(metadata,display),source=metadata.structure.atoms,label=ANALYSIS_METHOD_LABELS[result.method]??result.method;
 const atomIndex=(id:string,index:number)=>{const found=mapping.get(id);if(found===undefined||!Number.isSafeInteger(index)||index!==found+1)throw Error('分析原子编号与来源稳定身份不一致。');return found;};
 if(result.kind==='bond-orders'){
  const seen=new Set<string>();
  const bonds=result.bonds.map(row=>{const a=atomIndex(row.atomId1,row.sourceIndex1),b=atomIndex(row.atomId2,row.sourceIndex2),key=[a,b].sort((a,b)=>a-b).join(':');
   if(a===b||!Number.isFinite(row.value)||seen.has(key))throw Error('分析键级包含非有限值或重复原子对。');seen.add(key);
   const first=display.atoms[a],second=display.atoms[b],length=Math.hypot(first.x-second.x,first.y-second.y,first.z-second.z);
   return{atomIds:[first.id!,second.id!] as [string,string],value:row.value,length,decimals:settings.decimals??2,label:`BO=${formatAnalysisValue(row.value,settings.decimals)} · ${label}`};});
  const range=analysisRange(bonds.map(row=>row.value),settings,false);
  return{atoms:[],bonds:bonds.map(row=>({...row,color:range?analysisColor(row.value,range,settings.palette):undefined})),range};
 }
 if(result.kind==='charges'&&result.quantity==='electron-population')return{atoms:[],bonds:[],range:null};
 const isSpin=result.kind==='charges'&&Boolean(settings.spin&&result.spinAvailable);
 const seen=new Set<number>();
 const atoms=result.atoms.map(row=>{const index=atomIndex(row.atomId,row.sourceIndex);if(row.element!==source[index].element||seen.has(index))throw Error('分析原子元素或重复编号无效。');seen.add(index);
  const value=isSpin?row.spinPopulation:row.value;
  if(value===undefined)return null;if(!Number.isFinite(value))throw Error('分析原子性质必须是有限数值。');
  return{atomIndex:index,value,label:`${result.kind==='composition'?'贡献':isSpin?'Spin':'Q'}=${formatAnalysisValue(value,settings.decimals)}${result.kind==='composition'?' %':isSpin?'':' e'} · ${label}`};
 }).filter((row):row is NonNullable<typeof row>=>row!==null);
 const range=analysisRange(atoms.map(row=>row.value),settings,result.kind==='charges');
 return{atoms:atoms.map(row=>({...row,color:range?analysisColor(row.value,range,settings.palette):undefined})),bonds:[],range};
}
/** Selected methods share identity, not numerical meaning. The active method alone
 * controls color; labels preserve every selected method and its signed value. */
export function mapComparedAnalysisResult(active:WavefunctionAnalysisResult,comparisons:readonly WavefunctionAnalysisResult[]|undefined,metadata:WavefunctionMetadata,display:Structure,settings:AnalysisDisplaySettings){
 const selected=comparisons?.length?comparisons:[active];
 if(selected.some(row=>row.kind!==active.kind||row.sessionId!==active.sessionId||row.sourceRevision!==active.sourceRevision))throw Error('比较方法不属于同一分析来源。');
 const mapped=selected.map(result=>({result,data:mapAnalysisResult(result,metadata,display,settings)}));
 const primary=mapAnalysisResult(active,metadata,display,settings);
 const method=(result:WavefunctionAnalysisResult)=>ANALYSIS_METHOD_LABELS[result.method]??result.method;
 if(active.kind==='bond-orders'){
  const key=(ids:readonly string[])=>JSON.stringify([...ids].sort()),eligible=new Set<string>(),all=new Map<string,ResultBondScalar>();
  for(const {data} of mapped)for(const row of data.bonds){all.set(key(row.atomIds),row);if(row.value>0.05)eligible.add(key(row.atomIds));}
  const main=new Map(primary.bonds.map(row=>[key(row.atomIds),row]));
  const bonds=[...all].filter(([id])=>eligible.has(id)).map(([id,fallback])=>{
   const row=main.get(id),value=row?.value??Number.NaN;
   const label=mapped.map(({result,data})=>`${method(result)}: BO=${formatAnalysisValue(data.bonds.find(item=>key(item.atomIds)===id)?.value,settings.decimals)}`).join('\n');
   return{...fallback,value,label,comparisonVisible:true,color:undefined};
  });
  const colored=visibleBondDisplayValues(bonds,settings),range=analysisRange(colored.map(row=>row.value),settings,false);
  return{atoms:primary.atoms,bonds:colored,range};
 }
 const atoms=primary.atoms.map(row=>({...row,label:mapped.map(({result,data})=>{const spin=result.kind==='charges'&&settings.spin&&result.spinAvailable;return `${method(result)}: ${spin?'Spin':'Q'}=${formatAnalysisValue(data.atoms.find(item=>item.atomIndex===row.atomIndex)?.value,settings.decimals)}${spin?'':' e'}`;}).join('\n')}));
 return{...primary,atoms};
}
export function analysisBondLength(ids:[string,string],metadata:WavefunctionMetadata,display:Structure):number|undefined{
 const mapped=mapAnalysisHighlight(ids,metadata,display),[a,b]=mapped.map(id=>display.atoms.find(atom=>atom.id===id));
 if(!a||!b)return;return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
}
/** Highlight requests use source stable IDs, not renderer labels or aN guesses. */
export function mapAnalysisHighlight(ids:readonly string[],metadata:WavefunctionMetadata,display:Structure):string[]{
 const mapping=analysisSourceMapping(metadata,display);
 return[...new Set(ids)].map(id=>{const index=mapping.get(id);if(index===undefined)throw Error('高亮原子已不属于当前分析来源。');return display.atoms[index].id!;});
}
