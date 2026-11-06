import type {Structure} from '../../core/types';
import type {TrajectoryResult} from '../../results/contracts';
import {analysisColor,analysisRange,type AnalysisColorbar} from './analysis-display';
import {professionalSourceIdentity,type ProfessionalChargeDisplay} from './analysis-comparison';
import type {PrintedChargeHighlightSnapshot} from './PrintedFrameProperties';

/** The list owns numerical provenance. Highlight publications carry targets only. */
export function sourceChargeViewport(snapshot:ProfessionalChargeDisplay|null|undefined,result:TrajectoryResult,structure:Structure,frameIndex:number,targets?:PrintedChargeHighlightSnapshot){
 if(!snapshot||!result.frames[frameIndex]||snapshot.sourceId!==result.source.id||snapshot.frameIndex!==frameIndex||snapshot.identity!==professionalSourceIdentity({result,structure,frameIndex,wavefunctionAvailable:false}))return null;
 const indices=new Map(structure.atoms.map((atom,index)=>[atom.id,index]));
 if(indices.has(undefined)||indices.size!==structure.atoms.length||new Set(snapshot.atoms.map(row=>row.atomId)).size!==snapshot.atoms.length||snapshot.atoms.some(row=>!indices.has(row.atomId)||!Number.isFinite(row.value)))return null;
 const display=snapshot.display,range=snapshot.atoms.length?analysisRange(snapshot.atoms.map(row=>row.value),display,true):null;
 const scalarValues=snapshot.atoms.map(row=>({atomIndex:indices.get(row.atomId)!,value:row.value,label:row.label,color:range?analysisColor(row.value,range,display.palette):undefined}));
 const ids=targets?.sourceId===result.source.id&&targets.frameIndex===frameIndex&&new Set(targets.ids).size===targets.ids.length&&targets.ids.every(id=>indices.has(id))?targets.ids:[];
 const labels=new Set(ids.length?ids:display.labels?snapshot.atoms.map(row=>row.atomId):[]);
 const atomLabels=snapshot.atoms.filter(row=>labels.has(row.atomId)).map(({atomId,label})=>({atomId,label}));
 const active=snapshot.columns.find(column=>column.key===snapshot.activeMethod),spin=display.spin||!!active&&!active.hasCharge&&active.hasSpin,unit=spin?active?.spinUnit:active?.chargeUnit;
 const colorbar:AnalysisColorbar|undefined=display.color&&range?{...range,palette:display.palette??'blue-red',decimals:display.decimals??2,label:`${spin?'Spin':'Q'} / ${unit||'单位未输出'}${active?` · ${active.label}`:''}`,layout:display.colorbarLayout} :undefined;
 return{scalarValues,atomLabels,ids,colorbar,color:display.color};
}
